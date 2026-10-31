import { enrichPersistedApiCapabilities } from "./persisted-api-capabilities.js";
import { withFileTransactionLock } from "../storage/file-lock.js";
import { styleReportText as paint } from "../ui/format.js";
import { withCheckProgress } from "../ui/check-progress.js";
import { mapWithConcurrency } from "../concurrency.js";
import { ApiModelCapabilities } from "./api-model-capabilities.js";
import { getAppBindStatus } from "./app-bind.js";
import { isRecord } from "../utils.js";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { modelScopeId, workspaceModelScopes } from "./workspace-model-scopes.js";
import { AccountManager } from "../accounts.js";
import { type AccountStorageV3, loadAccounts } from "../storage.js";
import {
	type ApiRouteCredential,
	loadApiRoutes,
	updateApiModelDiscovery,
} from "../api-route-store.js";
import { ApiModelRuntime, boundedJson } from "./api-model-runtime.js";
import { AccountModelCatalog } from "./account-model-catalog.js";
import { ensureFreshAccessToken } from "./rotation-token-refresh.js";
import {
	CLIENT_VERSION_PATTERN,
	detectInstalledCodexCliVersion,
} from "../codex-cli/version.js";
import { createCodexHeaders } from "../request/headers.js";
import { CODEX_BASE_URL } from "../constants.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { tempPathFor } from "../temp-path.js";
import { withRetry } from "../fs-retry.js";
const printable = z
	.string()
	.max(256)
	.regex(/^[^\x00-\x1f\x7f]*$/);
const entitlementSchema = z.object({
 model: printable, checkedAt: z.number().optional(), programCheckedAt: z.number().finite().nonnegative().max(8.64e15).optional(),
 probes: z.record(printable,z.enum(["verified","unsupported","unverified","downgraded"])).optional(),
 serviceTiers: z.array(z.object({id:printable,name:printable})).max(100),
 reasoningLevels:z.array(printable).max(100),accessPrograms:z.array(printable).max(100),
});
const entrySchema = z.object({
 failure: z.object({kind:z.enum(["http","timeout","network","invalid_catalog"]),status:z.number().int().min(100).max(599).optional(),retryAt:z.number().finite().min(0).max(8.64e15).optional()}).optional(),
 lastSuccessfulAt:z.number().finite().min(0).max(8.64e15).optional(),
 id: printable.optional(), routable:z.boolean().optional(), bound:z.boolean().optional(), selected:z.boolean().optional(),
 changes:z.object({observedAt:z.number(),added:z.array(printable).max(10000),removed:z.array(printable).max(10000),capabilities:z.array(printable).max(10000)}).optional(),
 lastSuccessful:z.object({models:z.array(printable).max(10000),entitlements:z.array(entitlementSchema).max(1000).optional()}).optional(),
	label: printable,
	kind: z.enum(["oauth", "api", "zdr", "psp"]),
	enabled: z.boolean(),
	checkedAt: z.number(),
	error: z.boolean(),
	models: z.array(printable).max(10000),
	visibleModels: z.array(printable).max(10000),
	entitlements: z.array(entitlementSchema).max(1000).optional(),
});
const schema = z.object({
    apiConfigurationUnavailable: z.boolean().optional(),
	version: z.literal(1),
	checkedAt: z.number(),
	clientVersion: z
		.string()
		.max(80)
		.regex(/^[0-9A-Za-z.+_-]+$/)
		.optional(),
	entries: z.array(entrySchema).max(3000),
});
export type ModelInventory = z.infer<typeof schema>;
export async function discoverModelInventory(
	storage: AccountStorageV3 | null,
	routes: ApiRouteCredential[],
	options: {
		fetchImpl?: typeof fetch;
		signal?: AbortSignal;
		now?: () => number;
		clientVersion?: string;
		updateApiDiscovery?: typeof updateApiModelDiscovery;
		/** Send billable API probes even when a result is inside the 15-minute cache. */
		forceProbes?: boolean;
		/** Share probe results with later CLI processes through the multi-auth directory. */
		persistProbes?: boolean;
		/** Refresh program evidence that expires before the next scheduled check. */
		programRefreshBefore?: number;
	} = {},
): Promise<ModelInventory> {
	const fetcher = options.fetchImpl ?? fetch,
		now = options.now ?? Date.now;
	const manager = new AccountManager(
		undefined,
		storage ?? {
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		},
	);
	const entries: ModelInventory["entries"] = [];
	const scopes = manager.getAccountsSnapshot().flatMap(workspaceModelScopes);
 const catalog = new AccountModelCatalog(async (key) => {
  const scope = scopes.find(item=>item.id===key);
		const account = scope?.routable ? manager.getAccountByIndex(scope.accountIndex) : null;
		if (!account || account.enabled === false) throw Error("Disabled");
		const fresh = await ensureFreshAccessToken({
			accountManager: manager,
			account,
			family: "codex",
			model: null,
			now: now(),
			tokenRefreshSkewMs: 60000,
			tokenInvalidationCooldownMs: 30000,
		});
		if (!fresh.ok) throw Error("Authentication unavailable");
		const id = scope?.accountId;
		if (!id) throw Error("Identity unavailable");
		const url = new URL(`${CODEX_BASE_URL}/codex/models`);
		const version = options.clientVersion;
		if (version && CLIENT_VERSION_PATTERN.test(version))
			url.searchParams.set("client_version", version);
		const response = await fetcher(url, {
			headers: createCodexHeaders({
				accountId: id,
				accessToken: fresh.accessToken,
			}),
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw Error("Catalog unavailable");
		}
		return boundedJson(response);
	}, now);
	try {
  entries.push(...await mapWithConcurrency(scopes, 3, async scope=>{
    if(scope.routable) await catalog.list([scope.id]);
    const snapshot = catalog.snapshot(scope.id);
    return {id:scope.id,label:scope.label,kind:"oauth" as const,enabled:scope.enabled,routable:scope.routable,bound:scope.bound,selected:scope.selected,
     ...snapshot,error:scope.enabled && snapshot.error,checkedAt:now(),visibleModels:scope.routable?snapshot.models:[]};
   }));
	} finally {
		await manager.flushPendingSave();
	}
	const capabilities = new ApiModelCapabilities(fetcher, now, undefined, undefined, options.programRefreshBefore);
	const api = new ApiModelRuntime(
		fetcher,
		now,
		options.updateApiDiscovery,
		options.updateApiDiscovery
			? (models, refresh, route, forceProbes) =>
					options.persistProbes
                        ? enrichPersistedApiCapabilities(models,refresh,route,forceProbes,{fetchImpl:fetcher,now,requireStoredRoute:true,signal:options.signal,programRefreshBefore:options.programRefreshBefore})
                        : capabilities.enrich(models, refresh, route, forceProbes)
			: undefined,
	);
	await api.catalogs(routes, true, options.forceProbes === true);

	entries.push(
		...api.statuses(routes).map((s, i) => ({
			id: modelScopeId(s.kind,s.id),
   label: s.label,
			kind: s.kind,
			enabled: routes[i]?.enabled ?? false,
			checkedAt: s.checkedAt,
			error: s.error,
 failure:s.failure,lastSuccessfulAt:s.lastSuccessfulAt,
			models: s.availableModels,
			visibleModels: s.visibleModels,
			entitlements: s.entitlements,
		})),
	);
	return {
		version: 1,
		checkedAt: now(),
		clientVersion: options.clientVersion,
		entries,
	};
}
function inventoryPath(): string {
	return join(getCodexMultiAuthDir(), "model-discovery.json");
}
export async function loadModelInventory(): Promise<ModelInventory | null> {
	try {
		const file = await fs.open(inventoryPath(), "r");
		try {
			const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 4 * 1024 * 1024) return null;
			return schema.parse(
				JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
			);
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}
let inventoryWrites: Promise<void> = Promise.resolve();
/** Drain queued writes before resetting process-local test state. */
export async function resetModelInventoryWritesForTests(): Promise<void> {
	for (;;) {
		const pending = inventoryWrites;
		await pending;
		if (inventoryWrites === pending) {
			inventoryWrites = Promise.resolve();
			return;
		}
	}
}
export function saveModelInventory(value: ModelInventory, options: { mergeEntries?: boolean; signal?: AbortSignal } = {}): Promise<void> {
	const path = inventoryPath(), signal = options.signal;
	if (signal?.aborted) return Promise.reject(signal.reason);
	let stopWaiting: (() => void) | undefined;
	const pending = inventoryWrites.then(() => {
		// Once started, drain our own cancellable lock/write and cleanup.
		stopWaiting?.();
		signal?.throwIfAborted();
		return withFileTransactionLock(path, () => saveModelInventorySerial(value, path, options.mergeEntries === true, signal), { signal });
	});
	// Keep the underlying queue intact even if a waiting caller cancels.
	inventoryWrites = pending.catch(() => undefined);
	if (!signal) return pending;
	return new Promise<void>((resolve, reject) => {
		const abort = () => { stopWaiting?.(); reject(signal.reason); };
		stopWaiting = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		void pending.then(resolve, reject).finally(() => stopWaiting?.());
	});
}
async function saveModelInventorySerial(
	value: ModelInventory,
	path: string,
	mergeEntries = false,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const previous = await loadModelInventory();
	if (mergeEntries && previous) {
		// Clock rollback must not make old observations permanently newer.
		const now = Date.now();
		const entries = [...previous.entries];
		for (const entry of value.entries) {
			const index = entries.findIndex(old => old.id === entry.id && old.kind === entry.kind);
			if (index < 0) entries.push(entry);
			else if ((entries[index]?.checkedAt ?? -Infinity) > now || (entries[index]?.checkedAt ?? -Infinity) <= entry.checkedAt) entries[index] = entry;
		}
		value = { ...previous, ...value, clientVersion: value.clientVersion ?? previous.clientVersion,
			checkedAt: previous.checkedAt > now ? value.checkedAt : Math.max(previous.checkedAt, value.checkedAt), entries };
	}
	const data = schema.parse(withInventoryChanges(value, previous));
	const serialized = JSON.stringify(data) + "\n";
	if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
		throw Error("Model discovery status exceeds size limit");
	await writeFileAtomic(path, serialized, signal);
}
async function writeFileAtomic(path: string, serialized: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const temp = tempPathFor(path);
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const retry = { maxAttempts: 6, backoffMs: 25 };
	try {
		signal?.throwIfAborted();
		await fs.writeFile(temp, serialized, {
			mode: 0o600,
			flag: "wx",
		});
		await withRetry(() => { signal?.throwIfAborted(); return fs.rename(temp, path); }, retry);
	} finally {
		await withRetry(() => fs.unlink(temp), retry).catch((e) => {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		});
	}
}
export function formatModelInventory(
	inventory: ModelInventory | null,
	now = Date.now(),
): string[] {
	if (!inventory) return [paint("Models: not checked; run codex-multi-auth check.", "warning")];
	return [
		paint("Model discovery (catalog access, not an inference probe):", "heading"),
  ...inventoryHighlights(inventory),
		...inventory.entries.flatMap((e) => [
			`  ${paint(e.label, "heading")}${e.routable===true?" [routing eligible]":e.routable===false?" [discovery only]":""}${e.bound?" [stored binding]":""}${e.selected?" [preferred workspace]":""} [${e.kind.toUpperCase()}]: ${!e.enabled ? paint("disabled", "muted") : e.error ? paint("discovery failed", "danger") : paint(`${e.models.length} available`, "success")}; ${e.checkedAt ? new Date(e.checkedAt).toISOString() : "never checked"}${now - e.checkedAt > 60000 ? paint(" (stale; run check)", "warning") : ""}`,
			...(e.error ? [`    Failure: ${e.failure?.kind === "http" ? `HTTP ${e.failure.status}` : e.failure?.kind === "timeout" ? "catalog request timed out (15 seconds)" : e.failure?.kind === "network" ? "network connection failed" : e.failure?.kind === "invalid_catalog" ? "invalid catalog response" : "reason unavailable"}${e.failure?.retryAt ? `; next attempt no earlier than ${new Date(e.failure.retryAt).toISOString()}` : ""}`] : []),
            `    ${paint(e.error ? "Last known catalog (stale):" : "Available:", "muted")} ${(e.error ? (e.lastSuccessful?.models ?? e.models) : e.models).join(", ") || (e.error ? "unavailable" : "none")}`,
            ...(e.error && e.lastSuccessfulAt !== undefined ? [`    Last successful discovery: ${new Date(e.lastSuccessfulAt).toISOString()}`] : []),
			...(e.entitlements ?? []).map(
				(m) =>
					`    ${paint(m.model, "accent")}: speeds=${m.serviceTiers.map((t) => `${t.name} (${t.id})`).join(", ") || "not advertised"}; reasoning=${m.reasoningLevels.join(", ") || "not advertised"}; ${e.kind === "oauth" ? "programs" : "configured programs"}=${m.accessPrograms.join(", ") || (e.kind === "oauth" ? "not advertised" : "none")}${
						m.probes
							? `; probes: ${Object.entries(m.probes)
									.map(([k, v]) => `${k}=${paint(v, v === "verified" ? "success" : v === "unsupported" || v === "downgraded" ? "warning" : "muted")}`)
									.join(", ")} (${new Date(m.checkedAt ?? 0).toISOString()})${m.programCheckedAt !== undefined ? `; programs checked ${new Date(m.programCheckedAt).toISOString()}` : ""}`
							: ""
					}`,
			),
			...(e.kind !== "oauth"
				? [
						`    ${paint(e.error ? "Visible (stale):" : "Visible:", "accent")} ${e.visibleModels.map((m) => `${e.kind}/${m}`).join(", ") || "none"}`,
					]
				: []),
		]),
	];
}
export async function refreshAndPrintModelInventory(
	log: (message: string) => void,
	deps: {
		getBinding?: () => Promise<{
			running: boolean;
			state: {
				nativeOpenai?: boolean;
				baseUrl: string;
				clientApiKey: string;
			} | null;
		}>;
		fetchImpl?: typeof fetch;
		loadInventory?: typeof loadModelInventory;
		loadAccounts?: typeof loadAccounts;
		loadApiRoutes?: typeof loadApiRoutes;
		now?: () => number;
		/** Only an explicit `check capabilities` bypasses the 15-minute probe cache. */
		forceProbes?: boolean;
		/** Installed `codex --version` probe, used when the inventory stores no clientVersion. */
		detectClientVersion?: () => Promise<string | null>;
	} = {},
): Promise<boolean> {
	try {
		const load = deps.loadInventory ?? loadModelInventory;
		const previous = await load();
		// The catalog requires client_version (issue #733): the stored inventory
		// version wins, otherwise probe the installed `codex --version` so a fresh
		// inventory seeds one and saves it for the next check.
		const detectClientVersion = async () =>
			(await (deps.detectClientVersion ?? detectInstalledCodexCliVersion)().catch(
				() => null,
			)) ?? undefined;
		const clientVersion = previous?.clientVersion;
		const binding = await (deps.getBinding ?? getAppBindStatus)();
		if (binding.running && binding.state?.nativeOpenai) {
			const started = (deps.now ?? Date.now)();
			const url = new URL(binding.state.baseUrl);
			if (
				url.protocol !== "http:" ||
				!["127.0.0.1", "[::1]"].includes(url.hostname) ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			)
				throw Error("Invalid local refresh address");
			url.pathname = "/models";
			url.searchParams.set("refresh_capabilities", "1");
			if (deps.forceProbes) url.searchParams.set("force_probes", "1");
			const proxyClientVersion = clientVersion ?? (await detectClientVersion());
			if (proxyClientVersion)
				url.searchParams.set("client_version", proxyClientVersion);
   const clientApiKey = binding.state.clientApiKey;
   const current = await withCheckProgress("Refreshing workspace catalogs and API/ZDR/PSP probes", async () => {
			const response = await (deps.fetchImpl ?? fetch)(url, {
				headers: { authorization: `Bearer ${clientApiKey}` },
				redirect: "error",
				signal: AbortSignal.timeout(60000),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw Error("Proxy refresh failed");
			}
			const body = await boundedJson(response);
			if (!isRecord(body) || !Array.isArray(body.models))
				throw Error("Invalid refreshed catalog");
			const current = await load();
			if (!current || current.checkedAt < started)
				throw Error("Refreshed status unavailable");
    return current;
   }, log);
			log(
				"Running proxy model catalog refreshed. Desktop picks it up on its next response or scheduled catalog refresh.",
			);
			for (const line of formatModelInventory(withInventoryChanges(current,previous))) log(line);
			return true;
		}
  const value = await withCheckProgress("Discovering workspace models and API/ZDR/PSP capabilities", async () => {
        let apiConfigurationUnavailable = false;
		const value = await discoverModelInventory(
			await (deps.loadAccounts ?? loadAccounts)(),
			await (deps.loadApiRoutes ?? loadApiRoutes)().catch(() => {apiConfigurationUnavailable=true;log("API configuration unavailable; checking subscription models only.");return [];}),
			{
				clientVersion: clientVersion ?? (await detectClientVersion()),
				fetchImpl: deps.fetchImpl,
				updateApiDiscovery: updateApiModelDiscovery,
				forceProbes: deps.forceProbes === true,
				persistProbes: true,
			},
		);
        if(apiConfigurationUnavailable)value.apiConfigurationUnavailable=true;
		await saveModelInventory(value);
   return value;
  }, log);
		for (const line of formatModelInventory(withInventoryChanges(value,previous))) log(line);
  return true;
	} catch {
		log(
			"Model discovery failed; previous status may be stale. Check credentials and configuration.",
		);
  return false;
	}
}

function entitlementFeatures(entry: NonNullable<ModelInventory["entries"][number]["entitlements"]>[number]): string[] {
 return [...new Set([
  ...entry.serviceTiers.map(t=>`speed ${t.id === "fast"?"priority":t.id}`),
  ...entry.reasoningLevels.map(level=>`effort ${level}`),
  ...entry.accessPrograms.map(program=>`program ${program}`),
 ])].sort();
}

/** Compare stable credential/workspace scopes, keeping the last successful baseline through outages. */
export function withInventoryChanges(current: ModelInventory, previous: ModelInventory | null): ModelInventory {
 const prior = new Map(previous?.entries.filter(e=>e.id).map(e=>[e.id,e]));
 const entries = current.apiConfigurationUnavailable
  ? [...current.entries, ...(previous?.entries ?? []).filter(entry => entry.kind !== "oauth" && !current.entries.some(row => row.id === entry.id)).map(entry => ({...entry,error:true,routable:false,models:[],visibleModels:[]}))]
  : current.entries;
 return {...current, entries:entries.map(entry=>{
  const old = entry.id ? prior.get(entry.id) : undefined;
  const baseline = old?.lastSuccessful ?? (old?.enabled && !old.error ? {models:old.models,entitlements:old.entitlements} : undefined);
  const recent = old?.changes && current.checkedAt-old.changes.observedAt < 24*60*60*1000 ? old.changes : undefined;
  if(!entry.enabled || entry.error) return {...entry,lastSuccessful:baseline,changes:recent};
  const lastSuccessful = {models:entry.models,entitlements:entry.entitlements};
  if(!baseline) return {...entry,lastSuccessful,changes:undefined};
  const added = entry.models.filter(m=>!baseline.models.includes(m)).sort();
  const removed = baseline.models.filter(m=>!entry.models.includes(m)).sort();
  const before = new Map(baseline.entitlements?.map(e=>[e.model,entitlementFeatures(e)]));
  const capabilities = (entry.entitlements??[]).filter(e=>before.has(e.model) && JSON.stringify(before.get(e.model))!==JSON.stringify(entitlementFeatures(e))).map(e=>e.model).sort();
  const changes = added.length || removed.length || capabilities.length ? {observedAt:current.checkedAt,added,removed,capabilities} : recent;
  return {...entry,lastSuccessful,changes};
 })};
}

function inventoryHighlights(inventory: ModelInventory): string[] {
 const lines:string[] = [];
 for(const entry of inventory.entries) {
  const change=entry.changes;
  if(!change) continue;
  const stamp=new Date(change.observedAt).toISOString();
  if(change.added.length) lines.push(paint(`  NEW on ${entry.label} (${stamp}): ${change.added.join(", ")}`, "success"));
  if(change.removed.length) lines.push(paint(`  No longer advertised on ${entry.label} (${stamp}): ${change.removed.join(", ")}`, "warning"));
  if(change.capabilities.length) lines.push(paint(`  CHANGED capabilities on ${entry.label} (${stamp}): ${change.capabilities.join(", ")}`, "accent"));
 }
 for(const kind of ["oauth","api","zdr","psp"] as const) {
  const enabled=inventory.entries.filter(e=>e.kind===kind && e.enabled);
  const successful=enabled.filter(e=>!e.error);
  if(enabled.length<2) continue;
  const incomplete=enabled.length!==successful.length;
  if(incomplete) lines.push(paint(`  ${kind.toUpperCase()} coverage incomplete; failed scopes have unknown access.`, "warning"));
  const models=[...new Set(successful.flatMap(e=>e.models))].sort();
  for(const model of models) {
   const providers=successful.filter(e=>e.models.includes(model));
   if(providers.length<enabled.length) lines.push(`  ${!incomplete && providers.length===1?"Only on":"Observed on"} ${providers.map(e=>e.label).join(", ")}: ${model}`);
   const entitlements=providers.map(e=>({label:e.label,features:e.entitlements?.find(m=>m.model===model)}));
   const features=[...new Set(entitlements.flatMap(e=>e.features?entitlementFeatures(e.features):[]))].sort();
   for(const feature of features) {
    const advertising=entitlements.filter(e=>e.features && entitlementFeatures(e.features).includes(feature));
    if(advertising.length<providers.length) lines.push(`  ${model} ${feature}: ${advertising.map(e=>e.label).join(", ")} (not advertised by other scopes)`);
   }
  }
 }
 if(!lines.length) return [];
 const maximum=40;
 return [paint("Highlights (catalog observations; recent changes retained for 24h):", "heading"),...lines.slice(0,maximum),...(lines.length>maximum?[`  ${lines.length-maximum} more differences; see per-scope details below.`]:[])];
}
