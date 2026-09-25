import { withFileTransactionLock } from "../storage/file-lock.js";
import { styleReportText as paint } from "../ui/format.js";
import { withCheckProgress } from "../ui/check-progress.js";
import { mapWithConcurrency } from "../concurrency.js";
import { ApiModelCapabilities, type ProbeResult } from "./api-model-capabilities.js";
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
 model: printable, checkedAt: z.number().optional(),
 probes: z.record(printable,z.enum(["verified","unsupported","unverified","downgraded"])).optional(),
 serviceTiers: z.array(z.object({id:printable,name:printable})).max(100),
 reasoningLevels:z.array(printable).max(100),accessPrograms:z.array(printable).max(100),
});
const entrySchema = z.object({
 id: printable.optional(), routable:z.boolean().optional(), bound:z.boolean().optional(), selected:z.boolean().optional(),
 changes:z.object({observedAt:z.number(),added:z.array(printable).max(10000),removed:z.array(printable).max(10000),capabilities:z.array(printable).max(10000)}).optional(),
 lastSuccessful:z.object({models:z.array(printable).max(10000),entitlements:z.array(entitlementSchema).max(1000).optional()}).optional(),
	label: printable,
	kind: z.enum(["oauth", "api", "zdr"]),
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
const probeCacheSchema = z.object({
	version: z.literal(1),
	entries: z.array(z.tuple([
		z.string().regex(/^[0-9a-f]{64}$/),
		z.object({ at: z.number(), levels: z.array(printable).max(100), tiers: z.array(printable).max(100), status: z.record(printable, printable) }),
	])).max(1000),
});
function probeCachePath(): string {
	return join(getCodexMultiAuthDir(), "api-capability-probes.json");
}
async function loadProbeCache(): Promise<Array<[string, ProbeResult]>> {
	try {
		return probeCacheSchema.parse(JSON.parse(await fs.readFile(probeCachePath(), "utf8"))).entries;
	} catch {
		return [];
	}
}
export async function discoverModelInventory(
	storage: AccountStorageV3 | null,
	routes: ApiRouteCredential[],
	options: {
		fetchImpl?: typeof fetch;
		now?: () => number;
		clientVersion?: string;
		updateApiDiscovery?: typeof updateApiModelDiscovery;
		/** Send billable API probes even when a result is inside the 15-minute cache. */
		forceProbes?: boolean;
		/** Share probe results with later CLI processes through the multi-auth directory. */
		persistProbes?: boolean;
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
		const account = scope?.enabled ? manager.getAccountByIndex(scope.accountIndex) : null;
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
		if (version && /^[0-9A-Za-z.+_-]{1,80}$/.test(version))
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
    if(scope.enabled) await catalog.list([scope.id]);
    const snapshot = catalog.snapshot(scope.id);
    return {id:scope.id,label:scope.label,kind:"oauth" as const,enabled:scope.enabled,routable:scope.routable,bound:scope.bound,selected:scope.selected,
     ...snapshot,error:scope.enabled && snapshot.error,checkedAt:now(),visibleModels:scope.routable?snapshot.models:[]};
   }));
	} finally {
		await manager.flushPendingSave();
	}
	const capabilities = new ApiModelCapabilities(fetcher, now);
	if (options.persistProbes) capabilities.importProbes(await loadProbeCache());
	const api = new ApiModelRuntime(
		fetcher,
		now,
		options.updateApiDiscovery,
		options.updateApiDiscovery
			? (models, refresh, route, forceProbes) =>
					capabilities.enrich(models, refresh, route, forceProbes)
			: undefined,
	);
	await api.catalogs(routes, true, options.forceProbes === true);
	if (options.persistProbes) {
		const path = probeCachePath();
		await withFileTransactionLock(path, async () => {
			// Merge with the latest file: a concurrent check may have probed other
			// credentials since this one loaded. The newer result wins per key.
			const merged = new Map(await loadProbeCache());
			for (const [key, value] of capabilities.exportProbes()) {
				const disk = merged.get(key);
				if (!disk || disk.at <= value.at) merged.set(key, value);
			}
			const entries = [...merged].sort((x, y) => x[1].at - y[1].at).slice(-1000);
			await writeFileAtomic(path, JSON.stringify(probeCacheSchema.parse({ version: 1, entries })) + "\n");
		}).catch(() => undefined);
	}
	entries.push(
		...api.statuses(routes).map((s, i) => ({
			id: modelScopeId(s.kind,s.id),
   label: s.label,
			kind: s.kind,
			enabled: routes[i]?.enabled ?? false,
			checkedAt: s.checkedAt,
			error: s.error,
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
export function saveModelInventory(value: ModelInventory): Promise<void> {
	const path = inventoryPath();
	const pending = inventoryWrites.then(() =>
		withFileTransactionLock(path, () => saveModelInventorySerial(value, path)),
	);
	inventoryWrites = pending.catch(() => undefined);
	return pending;
}
async function saveModelInventorySerial(
	value: ModelInventory,
	path: string,
): Promise<void> {
	const data = schema.parse(withInventoryChanges(value, await loadModelInventory()));
	const serialized = JSON.stringify(data) + "\n";
	if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
		throw Error("Model discovery status exceeds size limit");
	await writeFileAtomic(path, serialized);
}
async function writeFileAtomic(path: string, serialized: string): Promise<void> {
	const temp = tempPathFor(path);
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const retry = { maxAttempts: 6, backoffMs: 25 };
	try {
		await fs.writeFile(temp, serialized, {
			mode: 0o600,
			flag: "wx",
		});
		await withRetry(() => fs.rename(temp, path), retry);
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
			`    ${paint("Available:", "muted")} ${e.models.join(", ") || "none"}`,
			...(e.entitlements ?? []).map(
				(m) =>
					`    ${paint(m.model, "accent")}: speeds=${m.serviceTiers.map((t) => `${t.name} (${t.id})`).join(", ") || "not advertised"}; reasoning=${m.reasoningLevels.join(", ") || "not advertised"}; programs=${m.accessPrograms.join(", ") || "not advertised"}${
						m.probes
							? `; probes: ${Object.entries(m.probes)
									.map(([k, v]) => `${k}=${paint(v, v === "verified" ? "success" : v === "unsupported" || v === "downgraded" ? "warning" : "muted")}`)
									.join(", ")} (${new Date(m.checkedAt ?? 0).toISOString()})`
							: ""
					}`,
			),
			...(e.kind !== "oauth"
				? [
						`    ${paint("Visible:", "accent")} ${e.visibleModels.map((m) => `${e.kind}/${m}`).join(", ") || "none"}`,
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
		now?: () => number;
		/** Only an explicit `check capabilities` bypasses the 15-minute probe cache. */
		forceProbes?: boolean;
	} = {},
): Promise<boolean> {
	try {
		const load = deps.loadInventory ?? loadModelInventory;
		const previous = await load();
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
			if (previous?.clientVersion)
				url.searchParams.set("client_version", previous.clientVersion);
   const clientApiKey = binding.state.clientApiKey;
   const current = await withCheckProgress("Refreshing workspace catalogs and API/ZDR probes", async () => {
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
  const value = await withCheckProgress("Discovering workspace models and API/ZDR capabilities", async () => {
        let apiConfigurationUnavailable = false;
		const value = await discoverModelInventory(
			await loadAccounts(),
			await loadApiRoutes().catch(() => {apiConfigurationUnavailable=true;log("API configuration unavailable; checking subscription models only.");return [];}),
			{
				clientVersion: previous?.clientVersion,
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
 for(const kind of ["oauth","api","zdr"] as const) {
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
