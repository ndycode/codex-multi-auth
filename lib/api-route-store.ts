import { apiBaseUrl } from "./api-region.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { tempPathFor } from "./temp-path.js";
import { withRetry } from "./fs-retry.js";
import { withStorageLock } from "./storage/transactions.js";
import { withFileTransactionLock } from "./storage/file-lock.js";
const modelId = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const programId = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const accessPrograms = z.record(programId, z.array(programId).max(32))
	.refine(value => Object.keys(value).length <= 16);
const reasoningLevel = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const inputModalities = z.array(z.enum(["text", "image"]))
	.min(1)
	.max(2)
	.refine((values) => values.includes("text"));
const modelProfile = z.record(z.string().min(1).max(80), z.unknown())
	.refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 256_000);
const routeSchema = z.object({
	/** Internal lifetime token. Store-owned; never trust an incoming token. */
	capabilityEpoch: z.string().uuid().optional(),
	legacyCapabilityCache: z.boolean().optional(),
	id: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[A-Za-z0-9_-]+$/),
	label: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[^\x00-\x1f\x7f]+$/),
	kind: z.enum(["api", "zdr"]),
 region: z.enum(["global", "us"]).optional(),
	apiKey: z.string().min(1).max(1024).regex(/^\S+$/),
	enabled: z.boolean(),
	priority: z.number().int().min(0).max(9),
	visibleModels: z.array(modelId).max(1000),
	knownModels: z.array(modelId).max(10000).optional(),
	probeCapabilities: z.boolean().optional(),
	/** Administrator-confirmed credential entitlements absent from API model discovery. */
	accessPrograms: accessPrograms.optional(),
	modelAccessPrograms: z.record(modelId, accessPrograms)
		.refine(value => Object.keys(value).length <= 1000).optional(),
	/** Operator-declared model capability metadata when API discovery omits it. */
	modelReasoningLevels: z.record(modelId, z.array(reasoningLevel).max(8))
		.refine(value => Object.keys(value).length <= 1000).optional(),
	modelInputModalities: z.record(modelId, inputModalities)
		.refine(value => Object.keys(value).length <= 1000).optional(),
	/** Operator-supplied full picker profiles when ID-only discovery cannot describe a model. */
	modelProfiles: z.record(modelId, modelProfile)
		.refine(value => Object.keys(value).length <= 100).optional(),
});
export const MAX_API_ROUTES = 100;
function storeVersion(routes: ApiRouteCredential[]): 1 | 2 | 3 {
	if (routes.some((route) => route.modelReasoningLevels || route.modelInputModalities || route.modelProfiles)) return 3;
	return routes.some((route) => route.region === "us") ? 2 : 1;
}
const schema = z.object({
	version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
	routes: z.array(routeSchema).max(MAX_API_ROUTES),
});
export type ApiRouteCredential = z.infer<typeof routeSchema>;
export function getApiRoutesPath(): string {
	return join(getCodexMultiAuthDir(), "api-routes.json");
}
function validate(value: unknown): ApiRouteCredential[] {
	const parsed = schema.safeParse(value);
	if (
		!parsed.success ||
		new Set(parsed.data.routes.map((r) => r.id)).size !==
			parsed.data.routes.length
	)
		throw new Error("Invalid API route configuration");
	return parsed.data.routes;
}
class InvalidApiRouteContentsError extends Error {
	constructor() { super("Invalid API route configuration"); }
}
export async function loadApiRoutes(
	path = getApiRoutesPath(),
): Promise<ApiRouteCredential[]> {
	let raw: string;
	try {
        raw = await withRetry(async () => {
		const handle = await fs.open(path, "r");
		try {
			const buffer = Buffer.alloc(1024 * 1024 + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 1024 * 1024)
				throw new Error("Invalid API route configuration");
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
        }, {maxAttempts:6,backoffMs:25});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error("Unable to read API route configuration");
	}
	try {
		return validate(JSON.parse(raw));
	} catch {
		throw new InvalidApiRouteContentsError();
	}
}
export function saveApiRoutes(routes: ApiRouteCredential[], path = getApiRoutesPath(), expected?: ApiRouteCredential[]): Promise<void> {
	return saveApiRoutesInternal(routes, path, expected);
}
/** Return our committed snapshot, never a later writer's configuration. */
export async function saveApiRoutesSnapshot(routes: ApiRouteCredential[], path = getApiRoutesPath(), expected?: ApiRouteCredential[]): Promise<ApiRouteCredential[]> {
	let saved: ApiRouteCredential[] = [];
	await saveApiRoutesInternal(routes, path, expected, false, undefined, value => { saved = value; });
	return saved;
}
async function saveApiRoutesInternal(
	routes: ApiRouteCredential[],
	path = getApiRoutesPath(),
	expected?: ApiRouteCredential[],
	discoveryExpansion = false,
	signal?: AbortSignal,
	onSaved?: (routes: ApiRouteCredential[]) => void,
): Promise<void> {
	await withStorageLock(() => withFileTransactionLock(path, () =>
		saveApiRoutesLocked(routes,path,expected,discoveryExpansion,signal,onSaved), {signal}));
}
async function saveApiRoutesLocked(
	routes: ApiRouteCredential[],
	path = getApiRoutesPath(),
	expected?: ApiRouteCredential[],
	discoveryExpansion = false,
	signal?: AbortSignal,
	onSaved?: (routes: ApiRouteCredential[]) => void,
): Promise<void> {
	const validated = validate({ version: 1, routes });
	let serialized = JSON.stringify({ version: storeVersion(validated), routes: validated }) + "\n";
	if (Buffer.byteLength(serialized) > 1024 * 1024)
		throw new Error("API route configuration is too large");

	signal?.throwIfAborted();
	let current: ApiRouteCredential[];
	try {
		current = await loadApiRoutes(path);
	} catch (error) {
		// Only explicit replacement may repair parsed-content corruption. CAS,
		// oversized reads and I/O failures must not be treated as an empty store.
		if (expected !== undefined || !(error instanceof InvalidApiRouteContentsError)) throw error;
		current = [];
	}
	await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = tempPathFor(path);
	try {
		if (
			expected &&
			JSON.stringify(current) !==
				JSON.stringify(validate({ version: 1, routes: expected }))
		) {
			throw new Error(
				"API route configuration changed; reopen the menu before saving.",
			);
		}
		const owned = validated.map(route => {
			const old = current.find(value => value.id === route.id);
			const policy = (value: ApiRouteCredential) => JSON.stringify([
				value.kind, value.apiKey, apiBaseUrl(value), value.enabled, value.probeCapabilities,
				value.accessPrograms, value.modelAccessPrograms, value.modelReasoningLevels,
				value.modelInputModalities, value.modelProfiles,
				// Visibility is a selection set; menu ordering is not a policy edit.
				...(discoveryExpansion ? [] : [[...new Set(value.visibleModels)].sort()]),
			]);
			const sameLifetime = old && policy(old) === policy(route);
			const withoutLegacy = { ...route };
			delete withoutLegacy.legacyCapabilityCache;
			return { ...withoutLegacy, capabilityEpoch: sameLifetime ? old.capabilityEpoch ?? randomUUID() : randomUUID(),
				...(sameLifetime && (!old.capabilityEpoch || old.legacyCapabilityCache === true) ? { legacyCapabilityCache: true } : {}) };
		});
		serialized = JSON.stringify({ version: storeVersion(owned), routes: owned }) + "\n";
		if (Buffer.byteLength(serialized) > 1024 * 1024) throw Error("API route configuration is too large");
		await fs.writeFile(temp, serialized, { mode: 0o600, flag: "wx" });
		signal?.throwIfAborted();
		await withRetry(() => fs.rename(temp, path), {
			maxAttempts: 6,
			backoffMs: 25,
		});
		onSaved?.(owned);
	} finally {
		await withRetry(() => fs.unlink(temp), {
				maxAttempts: 6,
				backoffMs: 25,
			}).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
	}
}

/** Persist a discovery baseline and new GPT text IDs without undoing menu edits.
 * Callers supply IDs already filtered for the Responses endpoint family. */
let discoveryUpdates: Promise<void> = Promise.resolve();
export function updateApiModelDiscovery(
	route: ApiRouteCredential,
	models: string[],
	path = getApiRoutesPath(),
): Promise<ApiRouteCredential> {
	const result = discoveryUpdates.then(() =>
		updateApiModelDiscoverySerial(route, models, path),
	);
	discoveryUpdates = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
async function updateApiModelDiscoverySerial(
	route: ApiRouteCredential,
	models: string[],
	path = getApiRoutesPath(),
): Promise<ApiRouteCredential> {
	const routes = await loadApiRoutes(path);
	const current = routes.find(
		(r) =>
			r.id === route.id && r.apiKey === route.apiKey && r.kind === route.kind && apiBaseUrl(r) === apiBaseUrl(route) &&
			(!route.capabilityEpoch || route.capabilityEpoch === r.capabilityEpoch),
	);
	if (!current) return { ...route, enabled: false, visibleModels: [] };
	if (!current.enabled) return current;
	const known = new Set(current.knownModels ?? models);
	const visible = new Set(current.visibleModels);
	for (const id of models) {
		if (!known.has(id) && /^gpt-/i.test(id)) visible.add(id);
		known.add(id);
	}
	const updated = {
		...current,
		knownModels: [...known],
		visibleModels: [...visible],
	};
	let persisted = updated;
	if (JSON.stringify(updated) !== JSON.stringify(current))
		await saveApiRoutesInternal(
			routes.map((r) => (r.id === current.id ? updated : r)),
			path,
			routes,
			true,
			undefined,
			values => { const saved = values.find(value => value.id === updated.id); if (saved) persisted = saved as typeof updated; },
		);
	return persisted;
}

/** Migrate legacy ownership before taking any capability lease or cache lock. */
export async function ensureApiRouteCapabilityEpoch(route: ApiRouteCredential, signal?: AbortSignal): Promise<ApiRouteCredential | undefined> {
	return withStorageLock(() => withFileTransactionLock(getApiRoutesPath(), async () => {
		signal?.throwIfAborted();
		const current = await loadApiRoutes();
		const match = current.find(value => value.id === route.id && value.kind === route.kind && value.apiKey === route.apiKey && apiBaseUrl(value) === apiBaseUrl(route));
		if (!match || (route.capabilityEpoch && route.capabilityEpoch !== match.capabilityEpoch)) return undefined;
		if (match.capabilityEpoch) return match;
		let migrated: ApiRouteCredential | undefined;
		await saveApiRoutesLocked(current, getApiRoutesPath(), current, false, signal, values => {
			migrated = values.find(value => value.id === route.id);
		});
		return migrated;
	}, {signal}));
}
