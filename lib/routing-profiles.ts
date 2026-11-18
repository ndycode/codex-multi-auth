import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import {
	findProjectRoot,
	getProjectStorageKey,
	resolveProjectStorageIdentityRoot,
} from "./storage/paths.js";
import { isRecord, sleep } from "./utils.js";
import {
	getJsonStoreFileMtimeMs,
	resetJsonStoreWriteQueuesForTests,
	stampUpdatedAt,
	withJsonStoreCasRetry,
	withJsonStoreFileLock,
	withJsonStoreWriteQueue,
	writeJsonStoreFileAtomicWithRetry,
} from "./storage/json-store-lock.js";

export interface RoutingProfile {
	projectKey: string;
	projectName: string;
	identityRoot: string;
	preferredTags: string[];
	avoidTags: string[];
	modelAllowlist: string[];
	modelDenylist: string[];
	accountWeightByKey: Record<string, number>;
	budgetKey: string | null;
	updatedAt: number;
}

export interface RoutingProfileStore {
	version: 1;
	profiles: Record<string, RoutingProfile>;
}

export interface ProjectRoutingProfileContext {
	startDir: string;
	projectRoot: string | null;
	identityRoot: string | null;
	projectKey: string | null;
	profile: RoutingProfile | null;
}

const ROUTING_PROFILES_FILE_NAME = "routing-profiles.json";
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function normalizeTokenList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean),
		),
	].sort();
}

function normalizeWeightMap(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const result: Record<string, number> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!key.startsWith("sha256:")) continue;
		if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
		result[key] = Math.max(0, Math.min(10, raw));
	}
	return result;
}

function normalizeProfile(key: string, value: unknown): RoutingProfile | null {
	if (!isRecord(value)) return null;
	const projectKey =
		typeof value.projectKey === "string" && value.projectKey === key
			? value.projectKey
			: key;
	const projectName =
		typeof value.projectName === "string" && value.projectName.trim()
			? value.projectName.trim().slice(0, 80)
			: "project";
	const identityRoot =
		typeof value.identityRoot === "string" && value.identityRoot.trim()
			? value.identityRoot.trim()
			: "";
	return {
		projectKey,
		projectName,
		identityRoot,
		preferredTags: normalizeTokenList(value.preferredTags),
		avoidTags: normalizeTokenList(value.avoidTags),
		modelAllowlist: normalizeTokenList(value.modelAllowlist),
		modelDenylist: normalizeTokenList(value.modelDenylist),
		accountWeightByKey: normalizeWeightMap(value.accountWeightByKey),
		budgetKey:
			typeof value.budgetKey === "string" && value.budgetKey.trim()
				? value.budgetKey.trim().slice(0, 80)
				: null,
		updatedAt:
			typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
				? value.updatedAt
				: 0,
	};
}

// Profile keys are caller/project-derived strings — including, via a crafted
// store file or a literal upsert, Object.prototype member names such as
// "constructor" or "__proto__". On a plain object, reading an absent key
// resolves an inherited member ({}.constructor === Object), which made a
// same-named profile look "already present" to the merge and silently dropped
// the incoming entry; writing "__proto__" invokes the setter and mutates the
// prototype instead of storing anything. Null-prototype maps make every key a
// plain data slot regardless of name.
function newProfilesMap(): Record<string, RoutingProfile> {
	return Object.create(null) as Record<string, RoutingProfile>;
}

function emptyStore(): RoutingProfileStore {
	return { version: 1, profiles: newProfilesMap() };
}

function normalizeStore(value: unknown): RoutingProfileStore {
	if (!isRecord(value) || value.version !== 1) return emptyStore();
	const profiles = newProfilesMap();
	if (isRecord(value.profiles)) {
		for (const [key, raw] of Object.entries(value.profiles)) {
			const profile = normalizeProfile(key, raw);
			if (profile) profiles[key] = profile;
		}
	}
	return { version: 1, profiles };
}

async function readFileWithRetry(path: string): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await fs.readFile(path, "utf8");
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= 4) throw error;
			await sleep(10 * 2 ** attempt);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("routing profile read retry exhausted");
}

export function getRoutingProfilesPath(): string {
	return join(getCodexMultiAuthDir(), ROUTING_PROFILES_FILE_NAME);
}

export async function loadRoutingProfileStore(): Promise<RoutingProfileStore> {
	const path = getRoutingProfilesPath();
	if (!existsSync(path)) return emptyStore();
	try {
		return normalizeStore(JSON.parse(await readFileWithRetry(path)) as unknown);
	} catch (error) {
		logWarn(
			`Failed to load routing profiles from ${basename(path)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return emptyStore();
	}
}

/**
 * Per-key merge of the caller's normalized store over the freshest on-disk
 * store. Profiles carry `updatedAt`; the newer entry wins per key so a save
 * built on a stale snapshot cannot resurrect an older profile over a
 * concurrent process's newer one. Keys the caller does not carry are
 * preserved (upsert-only store — nothing deletes entries), matching the
 * config save's patch-over-fresh-read semantics.
 *
 * When `baseline` (the caller's pre-edit snapshot) is supplied, entries
 * identical to it are untouched carried copies and skipped entirely, so a
 * stale snapshot row can never be re-stamped over a raced write. Entries
 * that differ are deliberate writes and must not lose purely on timestamp:
 * the upsert-time floor stamps against the caller's snapshot, but a
 * concurrent writer can land a still-newer entry before this merge runs, so
 * the merge re-stamps against the freshest on-disk entry instead of
 * silently dropping the edit. Without a baseline every supplied entry is a
 * plain `updatedAt >=` upsert.
 */
function mergeRoutingProfiles(
	current: RoutingProfileStore,
	incoming: RoutingProfileStore,
	baseline: RoutingProfileStore | undefined,
): RoutingProfileStore {
	const merged: RoutingProfileStore = {
		version: 1,
		profiles: Object.assign(newProfilesMap(), current.profiles),
	};
	const same = (
		a: RoutingProfile | undefined,
		b: RoutingProfile | undefined,
	): boolean => JSON.stringify(a) === JSON.stringify(b);
	for (const [key, profile] of Object.entries(incoming.profiles)) {
		const existing = merged.profiles[key];
		if (!baseline) {
			if (!existing || profile.updatedAt >= existing.updatedAt) {
				merged.profiles[key] = profile;
			}
			continue;
		}
		if (same(profile, baseline.profiles[key])) continue;
		profile.updatedAt = stampUpdatedAt(profile.updatedAt, existing?.updatedAt);
		merged.profiles[key] = profile;
	}
	return merged;
}

export async function saveRoutingProfileStore(
	store: RoutingProfileStore,
	baseline?: RoutingProfileStore,
): Promise<void> {
	const path = getRoutingProfilesPath();
	const incoming = normalizeStore(store);
	// Normalize at invocation like `incoming`: later caller-side mutation of
	// `baseline` must not shift which entries the merge counts as deliberate.
	const prior = baseline ? normalizeStore(baseline) : undefined;
	// Per-path promise queue serializes writers inside THIS process; the
	// lock directory closes the same window against OTHER processes. Inside the lock
	// every attempt re-stats (CAS), re-reads the freshest on-disk store, and
	// merges this call's entries over it — so a save that raced a concurrent
	// write reloads-and-retries rather than blindly overwriting it.
	await withJsonStoreWriteQueue(path, async () => {
		await withJsonStoreFileLock(path, async () => {
			await withJsonStoreCasRetry(async () => {
				const expectedMtimeMs = await getJsonStoreFileMtimeMs(path);
				const current = await loadRoutingProfileStore();
				const merged = mergeRoutingProfiles(current, incoming, prior);
				await fs.mkdir(getCodexMultiAuthDir(), {
					recursive: true,
					mode: 0o700,
				});
				await writeJsonStoreFileAtomicWithRetry(path, merged, {
					expectedMtimeMs,
					mode: 0o600,
				});
			});
		});
	});
}

/**
 * Run a routing-profile read→mutate→write inside the write queue (in-process
 * serialization) AND the cross-process lock directory, with mtime CAS retry:
 * every attempt re-reads the freshest on-disk store and re-applies `mutate`
 * before writing — so a mutation is applied to the latest committed state
 * rather than merged by whole-record `updatedAt`, which can drop or clobber
 * a concurrent process's change to the same profile. `mutate` must be
 * re-appliable across retries (apply precomputed work onto the store it is
 * handed, don't capture mutated state). Prefer this over load→upsert→save
 * whenever the caller is mutating rather than importing a foreign store.
 */
export async function updateRoutingProfileStore<T>(
	mutate: (store: RoutingProfileStore) => { result: T; dirty: boolean },
): Promise<T> {
	const path = getRoutingProfilesPath();
	return withJsonStoreWriteQueue(path, () =>
		withJsonStoreFileLock(path, () =>
			withJsonStoreCasRetry(async () => {
				const expectedMtimeMs = await getJsonStoreFileMtimeMs(path);
				const store = await loadRoutingProfileStore();
				const { result, dirty } = mutate(store);
				if (dirty) {
					await fs.mkdir(getCodexMultiAuthDir(), {
						recursive: true,
						mode: 0o700,
					});
					await writeJsonStoreFileAtomicWithRetry(
						path,
						normalizeStore(store),
						{ expectedMtimeMs, mode: 0o600 },
					);
				}
				return result;
			}),
		),
	);
}

export function createDefaultRoutingProfile(input: {
	projectKey: string;
	projectName: string;
	identityRoot: string;
	now?: number;
}): RoutingProfile {
	return {
		projectKey: input.projectKey,
		projectName: input.projectName,
		identityRoot: input.identityRoot,
		preferredTags: [],
		avoidTags: [],
		modelAllowlist: [],
		modelDenylist: [],
		accountWeightByKey: {},
		budgetKey: null,
		updatedAt: input.now ?? Date.now(),
	};
}

export function upsertRoutingProfile(
	store: RoutingProfileStore,
	profile: RoutingProfile,
	mutate?: (profile: RoutingProfile) => void,
	now = Date.now(),
): RoutingProfile {
	// store.profiles may be a caller-built plain object, so absent-key reads
	// need an own-property check and "__proto__" needs a setter-safe write.
	const existing = Object.hasOwn(store.profiles, profile.projectKey)
		? store.profiles[profile.projectKey]
		: undefined;
	const next = structuredClone(existing ?? profile);
	mutate?.(next);
	next.updatedAt = stampUpdatedAt(now, existing?.updatedAt);
	const normalized = normalizeProfile(profile.projectKey, next);
	if (!normalized) throw new Error("Invalid routing profile");
	Object.defineProperty(store.profiles, profile.projectKey, {
		value: normalized,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	return normalized;
}

export async function resolveProjectRoutingProfile(
	startDir = process.cwd(),
	storeLoader: () => Promise<RoutingProfileStore> = loadRoutingProfileStore,
): Promise<ProjectRoutingProfileContext> {
	const projectRoot = findProjectRoot(startDir);
	if (!projectRoot) {
		return {
			startDir,
			projectRoot: null,
			identityRoot: null,
			projectKey: null,
			profile: null,
		};
	}
	const identityRoot = resolveProjectStorageIdentityRoot(projectRoot);
	const projectKey = getProjectStorageKey(identityRoot);
	const store = await storeLoader();
	return {
		startDir,
		projectRoot,
		identityRoot,
		projectKey,
		profile: store.profiles[projectKey] ?? null,
	};
}

export function resetRoutingProfileWriteQueueForTests(): void {
	resetJsonStoreWriteQueuesForTests(getRoutingProfilesPath());
}

