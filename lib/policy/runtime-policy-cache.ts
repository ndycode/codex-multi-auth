/**
 * Hot-path caches for the runtime policy stores.
 *
 * `loadRuntimePolicyState` runs once per proxied request, and the proxy is a
 * long-running process while the stores are mutated by separate CLI processes
 * (`account pause`, `budget`, `routing profile`). The naive path re-read +
 * re-parsed three JSON files and re-walked the project-root ancestor chain on
 * every request. These caches keep semantics identical while reducing the
 * steady-state cost to a handful of `statSync` calls:
 *
 * - Store entries are keyed by absolute file path and guarded by an
 *   `mtimeMs:ctimeMs:size` fingerprint (same approach as
 *   `lib/runtime/rotation-storage-meta.ts`): the store is only re-read when
 *   the fingerprint changes. `ctimeMs` is part of the fingerprint because it
 *   cannot be pinned back the way `mtimeMs` can — on POSIX every write bumps
 *   it, and on Windows every rename-replacement produces a new file creation
 *   time — so a rewrite that preserves mtime+size is still caught instead of
 *   being served stale for the TTL. A fingerprint match is additionally only
 *   trusted once the file's own mtime has settled past `MTIME_SETTLE_MS` —
 *   two rapid writes can share a coarse mtime tick on some filesystems (FAT
 *   2s, ~1s Windows/network volumes), so inside the settle window we always
 *   re-read. `STORE_CACHE_TTL_MS` bounds staleness for the pathological case
 *   where a rewrite leaves mtime, ctime and size unchanged, and
 *   `STORE_CACHE_MAX_ENTRIES` bounds the map (tests rotate through many
 *   per-test `CODEX_MULTI_AUTH_DIR` temp dirs).
 *
 *   Two failure modes get dedicated handling so they cannot poison the cache:
 *   a file rewritten *while* the loader is reading it is detected by
 *   re-statting after the load and only caching when the fingerprint is
 *   stable across the read (an old parse is never stored under the new
 *   file's fingerprint); and a read that resolves to the empty store while
 *   bytes still exist on disk — exhausted EBUSY/EPERM retries or corrupt
 *   JSON both surface as `emptyStore()` from the loaders — is served but
 *   never cached, so a transient failure cannot hide a real policy for the
 *   full TTL.
 *
 * - Project resolution (`findProjectRoot` + `resolveProjectStorageIdentityRoot`
 *   + `getProjectStorageKey`) is cached per resolved startDir for
 *   `PROJECT_RESOLUTION_TTL_MS` and guarded by two fingerprints: an
 *   mtime/ctime/size fingerprint of the resolved root's `.git` entry — the file
 *   whose contents drive worktree identity resolution — and the joined
 *   fingerprints of every ancestor directory that could host a marker, whose
 *   mtimes change when a marker file is created or deleted. Entries
 *   therefore invalidate when the project context differs (different
 *   startDir key, different resolved root), when the `.git` entry changes,
 *   or when a marker appears/disappears in a watched ancestor — the TTL is
 *   only the residual bound for coarse-mtime filesystems that report no
 *   change at all.
 *
 * Values held in the caches are shared, mutable objects. Callers must treat
 * returned values as read-only; `loadRuntimePolicyState` clones what it hands
 * out.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	getAccountPolicyPath,
	loadAccountPolicyStore,
	type AccountPolicyStore,
} from "../account-policy.js";
import {
	getBudgetGuardPath,
	loadBudgetGuardStore,
	type BudgetGuardStore,
} from "../budget-guard.js";
import {
	getRoutingProfilesPath,
	loadRoutingProfileStore,
	type ProjectRoutingProfileContext,
	type RoutingProfileStore,
} from "../routing-profiles.js";
import {
	findProjectRoot,
	getProjectStorageKey,
	resolveProjectStorageIdentityRoot,
} from "../storage/paths.js";

interface FileFingerprint {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
}

interface StatSample {
	/** The raw fingerprint fields, present only when statSync succeeded. */
	stat: FileFingerprint | null;
	/**
	 * `${mtimeMs}:${ctimeMs}:${size}` on success; null when the entry is
	 * absent (ENOENT/ENOTDIR); a fresh unique token when stat fails for any
	 * other reason — a transient EPERM/EBUSY under a Windows lock must never
	 * compare equal to a cached fingerprint and silently extend a stale
	 * "absent"/"empty" answer.
	 */
	fingerprint: string | null;
}

interface StoreCacheEntry<T> {
	/** Fingerprint of the file after the load, null when stat fails. */
	fingerprint: string | null;
	loadedAt: number;
	value: T;
}

interface ProjectResolution {
	projectRoot: string | null;
	identityRoot: string | null;
	projectKey: string | null;
	/** Fingerprint of `<projectRoot>/.git`, or null when absent/rootless. */
	gitFingerprint: string | null;
	/** Ancestor dirs whose member changes can alter the resolution. */
	watchDirs: string[];
	/** Joined per-dir fingerprints of `watchDirs`, sampled at resolve time. */
	watchFingerprint: string;
	resolvedAt: number;
}

// Mirrors MTIME_SHORTCIRCUIT_SETTLE_MS in rotation-storage-meta.ts: 2s
// comfortably exceeds the coarsest mtime granularity we expect in practice.
const MTIME_SETTLE_MS = 2_000;
const STORE_CACHE_TTL_MS = 30_000;
const STORE_CACHE_MAX_ENTRIES = 32;
// Retries while the file's fingerprint keeps moving across a load (a writer
// racing us). Beyond this bound the freshest value is returned uncached.
const STORE_LOAD_MAX_ATTEMPTS = 3;
const PROJECT_RESOLUTION_TTL_MS = 5_000;
const PROJECT_RESOLUTION_MAX_ENTRIES = 64;
const PROJECT_WATCH_MAX_ANCESTORS = 48;

const ACCOUNT_POLICY_CACHE = new Map<string, StoreCacheEntry<AccountPolicyStore>>();
const BUDGET_GUARD_CACHE = new Map<string, StoreCacheEntry<BudgetGuardStore>>();
const ROUTING_PROFILES_CACHE = new Map<string, StoreCacheEntry<RoutingProfileStore>>();
const PROJECT_RESOLUTION_CACHE = new Map<string, ProjectResolution>();

let statErrorSeq = 0;

function statFile(path: string): StatSample {
	try {
		const stats = statSync(path);
		return {
			stat: {
				mtimeMs: stats.mtimeMs,
				ctimeMs: stats.ctimeMs,
				size: stats.size,
			},
			fingerprint: `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { stat: null, fingerprint: null };
		}
		statErrorSeq += 1;
		return { stat: null, fingerprint: `stat-error:${statErrorSeq}` };
	}
}

function evictOldest<K, V>(map: Map<K, V>, maxEntries: number): void {
	let excess = map.size - maxEntries;
	for (const key of map.keys()) {
		if (excess <= 0) return;
		map.delete(key);
		excess -= 1;
	}
}

/**
 * mtime+ctime+size-fingerprinted wrapper around an existing store loader. On
 * a fingerprint hit the cached store is returned WITHOUT re-reading or
 * re-parsing the file; on a miss the real loader runs (preserving its retry,
 * normalization, and warn-on-corrupt semantics) and the entry is keyed on a
 * fingerprint that must be stable ACROSS the load — re-statting after the
 * read catches a concurrent rewrite that would otherwise pin the old parse
 * under the new file's fingerprint once the new mtime settles. A load that
 * returns the empty store while the file still exists is a failed or
 * undecodable read, never a cacheable "empty file" answer. The returned
 * object is the cached instance — callers must not mutate it.
 */
async function loadStoreCached<T>(input: {
	path: string;
	cache: Map<string, StoreCacheEntry<T>>;
	load: () => Promise<T>;
	isEmptyStore: (value: T) => boolean;
}): Promise<T> {
	const now = Date.now();
	const sample = statFile(input.path);
	const cached = input.cache.get(input.path);
	if (
		cached &&
		cached.fingerprint === sample.fingerprint &&
		now - cached.loadedAt < STORE_CACHE_TTL_MS &&
		(sample.stat === null || now - sample.stat.mtimeMs > MTIME_SETTLE_MS)
	) {
		// Refresh recency for LRU eviction.
		input.cache.delete(input.path);
		input.cache.set(input.path, cached);
		return cached.value;
	}
	for (let attempt = 0; attempt < STORE_LOAD_MAX_ATTEMPTS; attempt += 1) {
		const before = statFile(input.path).fingerprint;
		const value = await input.load();
		const after = statFile(input.path);
		if (before !== after.fingerprint) {
			// The file moved under the read: `value` may predate the bytes the
			// new fingerprint describes. Retry while the writer is still
			// racing; on the last attempt the value is still a real read, it
			// is simply not safe to cache.
			if (attempt + 1 === STORE_LOAD_MAX_ATTEMPTS) return value;
			continue;
		}
		if (after.stat !== null && input.isEmptyStore(value)) {
			// The loaders resolve exhausted EBUSY/EPERM reads and corrupt JSON
			// to the empty store — indistinguishable from a legitimately empty
			// file except that bytes still exist on disk. Serve it, but do
			// not cache: the next request retries the read instead of hiding
			// an existing policy for the full TTL.
			return value;
		}
		input.cache.set(input.path, {
			fingerprint: after.fingerprint,
			loadedAt: Date.now(),
			value,
		});
		evictOldest(input.cache, STORE_CACHE_MAX_ENTRIES);
		return value;
	}
	// Unreachable: every iteration returns or continues past the bound.
	throw new Error("runtime policy cache load attempts exhausted");
}

/**
 * Cached variant of `loadAccountPolicyStore`. The returned store is shared
 * cache state — treat as read-only.
 */
export function loadAccountPolicyStoreCached(): Promise<AccountPolicyStore> {
	return loadStoreCached({
		path: getAccountPolicyPath(),
		cache: ACCOUNT_POLICY_CACHE,
		load: () => loadAccountPolicyStore({strict:true}),
		isEmptyStore: (store) => Object.keys(store.accounts).length === 0,
	});
}

/**
 * Cached variant of `loadBudgetGuardStore`. The returned store is shared
 * cache state — treat as read-only.
 */
export function loadBudgetGuardStoreCached(): Promise<BudgetGuardStore> {
	return loadStoreCached({
		path: getBudgetGuardPath(),
		cache: BUDGET_GUARD_CACHE,
		load: loadBudgetGuardStore,
		isEmptyStore: (store) => Object.keys(store.limits).length === 0,
	});
}

function loadRoutingProfileStoreCached(): Promise<RoutingProfileStore> {
	return loadStoreCached({
		path: getRoutingProfilesPath(),
		cache: ROUTING_PROFILES_CACHE,
		load: loadRoutingProfileStore,
		isEmptyStore: (store) => Object.keys(store.profiles).length === 0,
	});
}

function gitEntryFingerprint(projectRoot: string): string | null {
	return statFile(join(projectRoot, ".git")).fingerprint;
}

function watchDirsFingerprint(dirs: string[]): string {
	return dirs.map((dir) => statFile(dir).fingerprint).join("|");
}

/**
 * Ancestor directories whose member changes can alter `findProjectRoot`'s
 * answer for `startDir`: every level between startDir and the resolved root
 * (inclusive) — a marker created below the current root outranks it — and,
 * when the root was not found via `.git` (or no root exists at all), every
 * level up to the filesystem root, because a `.git` appearing at any higher
 * ancestor would take precedence over the current marker/rootless result.
 * Directory mtimes change when entries are created or deleted, so new or
 * removed markers invalidate the cached resolution on the next request.
 */
function ancestorWatchDirs(
	startDir: string,
	projectRoot: string | null,
): string[] {
	const stopAt =
		projectRoot !== null && existsSync(join(projectRoot, ".git"))
			? projectRoot
			: null;
	const dirs: string[] = [];
	let current = resolve(startDir);
	for (let depth = 0; depth < PROJECT_WATCH_MAX_ANCESTORS; depth += 1) {
		dirs.push(current);
		if (current === stopAt) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function resolveProject(startDir: string): ProjectResolution {
	const projectRoot = findProjectRoot(startDir);
	const identityRoot = projectRoot
		? resolveProjectStorageIdentityRoot(projectRoot)
		: null;
	const watchDirs = ancestorWatchDirs(startDir, projectRoot);
	return {
		projectRoot,
		identityRoot,
		projectKey: identityRoot ? getProjectStorageKey(identityRoot) : null,
		gitFingerprint: projectRoot ? gitEntryFingerprint(projectRoot) : null,
		watchDirs,
		watchFingerprint: watchDirsFingerprint(watchDirs),
		resolvedAt: Date.now(),
	};
}

/**
 * `findProjectRoot` + `resolveProjectStorageIdentityRoot` cached per resolved
 * startDir. Hits require a fresh TTL, an unchanged `.git` fingerprint on the
 * resolved root (editing the worktree pointer or re-creating `.git`
 * re-resolves immediately), and unchanged ancestor-directory fingerprints
 * (marker files created or deleted anywhere along the watched chain bump the
 * parent dir's mtime and re-resolve immediately). The TTL remains the bound
 * for filesystems too coarse to report any of those changes.
 */
function resolveProjectCached(startDir: string): ProjectResolution {
	const now = Date.now();
	const cacheKey = resolve(startDir);
	const cached = PROJECT_RESOLUTION_CACHE.get(cacheKey);
	if (
		cached &&
		now - cached.resolvedAt < PROJECT_RESOLUTION_TTL_MS &&
		(!cached.projectRoot ||
			gitEntryFingerprint(cached.projectRoot) === cached.gitFingerprint) &&
		watchDirsFingerprint(cached.watchDirs) === cached.watchFingerprint
	) {
		PROJECT_RESOLUTION_CACHE.delete(cacheKey);
		PROJECT_RESOLUTION_CACHE.set(cacheKey, cached);
		return cached;
	}
	const resolution = resolveProject(cacheKey);
	PROJECT_RESOLUTION_CACHE.set(cacheKey, resolution);
	evictOldest(PROJECT_RESOLUTION_CACHE, PROJECT_RESOLUTION_MAX_ENTRIES);
	return resolution;
}

/**
 * Cached variant of `resolveProjectRoutingProfile` for the per-request path.
 * The project context (root/identity/key) comes from the bounded resolution
 * cache; the profile itself is re-derived on every call from the
 * fingerprint-guarded routing-profiles store, so profile edits are picked up
 * as soon as the file's mtime/size changes and distinct project contexts can
 * never observe each other's entries.
 */
export async function resolveProjectRoutingProfileCached(
	startDir = process.cwd(),
): Promise<ProjectRoutingProfileContext> {
	const resolution = resolveProjectCached(startDir);
	if (
		!resolution.projectRoot ||
		!resolution.identityRoot ||
		!resolution.projectKey
	) {
		return {
			startDir,
			projectRoot: null,
			identityRoot: null,
			projectKey: null,
			profile: null,
		};
	}
	const store = await loadRoutingProfileStoreCached();
	return {
		startDir,
		projectRoot: resolution.projectRoot,
		identityRoot: resolution.identityRoot,
		projectKey: resolution.projectKey,
		profile: store.profiles[resolution.projectKey] ?? null,
	};
}

/**
 * Test-only: drop every cached store value and project resolution so each
 * test starts from a clean read-from-disk state.
 */
export function resetRuntimePolicyCacheForTests(): void {
	ACCOUNT_POLICY_CACHE.clear();
	BUDGET_GUARD_CACHE.clear();
	ROUTING_PROFILES_CACHE.clear();
	PROJECT_RESOLUTION_CACHE.clear();
}
