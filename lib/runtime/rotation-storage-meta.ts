import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getStoragePath } from "../storage.js";
import type { SessionAffinityStore } from "../session-affinity.js";

/**
 * Content-hash-keyed snapshot of on-disk storage metadata. The proxy is a
 * long-running process; the `switch`/`unpin`/`best` CLI runs in a different
 * process and mutates the storage file. We re-read only the top-level
 * `pinnedAccountIndex` and `affinityGeneration` fields on each request so
 * manual changes are honored without doing a full AccountManager reload
 * (which would lose in-memory cooldown state).
 *
 * We key the cache on a sha1 of the file bytes rather than `mtimeMs` because
 * Windows file systems can report sub-millisecond mtime granularity that is
 * coarser than our atomic-rename writes — two CLI bumps that happen close
 * together can land on the same `mtimeMs` and silently bypass an mtime-based
 * cache. The hashing cost is negligible for the small accounts.json file
 * (typically < 50KB) and keeps cache correctness independent of FS mtime
 * resolution. See #474.
 *
 * We additionally retain the last-seen `mtimeMs`/`size` so the hot path can
 * skip the `readFileSync` + sha1 entirely when neither has changed since the
 * previous read AND the cached mtime has settled past
 * `MTIME_SHORTCIRCUIT_SETTLE_MS` (the common case — the proxy reads on every
 * request but the file only mutates on a `switch`/`unpin`/`best` CLI
 * invocation, then sits quiescent). The sha1 remains the source of truth:
 * when `mtimeMs`/`size` differ, were never cached, or the mtime is too recent
 * to trust against same-tick writes, we re-read and hash, so the content-hash
 * path still protects against the coarse-mtime collision described above
 * whenever the file is re-read.
 */
interface StorageMetaSnapshot {
	mtimeMs: number;
	size: number;
	contentHash: string;
	pinnedAccountIndex: number | null;
	affinityGeneration: number;
}

export interface StorageMeta {
	pinnedAccountIndex: number | null;
	affinityGeneration: number;
}

// Keyed by absolute storage path so multiple proxy instances and concurrent
// vitest workers (each pointing at their own temp storage file) cannot
// corrupt each other's snapshots. See issue #474.
const STORAGE_META_CACHE: Map<string, StorageMetaSnapshot> = new Map();

// The mtime+size short-circuit (L3) may only be trusted once the cached
// mtime is far enough in the past that no *subsequent* write could share the
// same coarse mtime tick. Filesystems report mtime at wildly different
// granularities (ext4 ns, FAT 2s, some network/Windows volumes ~1s, and CI
// containers occasionally coarser), and our writers use atomic rename, so two
// rapid CLI bumps can land on an identical mtimeMs. Within this settle window
// we therefore ignore mtime equality and fall back to the read + sha1 path
// (the real source of truth). Outside it, the file has been quiescent long
// enough that mtime equality provably means "unchanged", so we skip the read.
// 2s comfortably exceeds the coarsest mtime granularity we expect in practice.
const MTIME_SHORTCIRCUIT_SETTLE_MS = 2_000;

function hashStorageBytes(bytes: Buffer): string {
	return createHash("sha1").update(bytes).digest("hex");
}

function metaFromSnapshot(snapshot: StorageMetaSnapshot): StorageMeta {
	return {
		pinnedAccountIndex: snapshot.pinnedAccountIndex,
		affinityGeneration: snapshot.affinityGeneration,
	};
}

/**
 * Cheap, hot-path-safe single read with mtime-cache short-circuit. When the
 * file's `mtimeMs` and `size` match the cached snapshot for this path we
 * return the cached value WITHOUT reading or hashing the file. Only when
 * mtime/size differ (or were never cached) do we `readFileSync` + sha1 and,
 * if the content hash still matches, skip the `JSON.parse`. Transient
 * failures (EBUSY/EPERM/EACCES/EAGAIN, partial-write SyntaxError) fall through
 * to the last cached value for this path; defaults are only returned when the
 * file has never been successfully read.
 *
 * Replaces an earlier retry loop with a sub-15ms busy-wait that blocked the
 * event loop on every transient failure. The proxy is on the request hot
 * path; serving a slightly stale (but consistent) value is strictly better
 * than blocking. See #474.
 */
export function readStorageMetaFromDisk(
	storagePath: string = getStoragePath(),
): StorageMeta {
	if (!existsSync(storagePath)) {
		STORAGE_META_CACHE.delete(storagePath);
		return { pinnedAccountIndex: null, affinityGeneration: 0 };
	}
	try {
		// mtime+size short-circuit (L3): when neither has changed since the last
		// successful read AND the cached mtime has settled (see
		// MTIME_SHORTCIRCUIT_SETTLE_MS) we return the cached snapshot without
		// reading or hashing the file. During the settle window we deliberately
		// fall through to the read + sha1 path below, which stays the source of
		// truth and protects against the coarse-mtime collision described on
		// StorageMetaSnapshot. So this is a pure fast path for the common
		// "file quiescent, proxy polling every request" case.
		const stats = statSync(storagePath);
		const cachedByStat = STORAGE_META_CACHE.get(storagePath);
		if (
			cachedByStat &&
			cachedByStat.mtimeMs === stats.mtimeMs &&
			cachedByStat.size === stats.size &&
			Date.now() - stats.mtimeMs > MTIME_SHORTCIRCUIT_SETTLE_MS
		) {
			return metaFromSnapshot(cachedByStat);
		}
		const bytes = readFileSync(storagePath);
		const contentHash = hashStorageBytes(bytes);
		const cached = STORAGE_META_CACHE.get(storagePath);
		if (cached && cached.contentHash === contentHash) {
			// Content is byte-identical despite the mtime/size change (e.g. an
			// atomic-rename rewrite of the same bytes). Refresh the stat fields so
			// the next request takes the fast path, but skip the JSON.parse.
			const refreshed: StorageMetaSnapshot = {
				...cached,
				mtimeMs: stats.mtimeMs,
				size: stats.size,
			};
			STORAGE_META_CACHE.set(storagePath, refreshed);
			return metaFromSnapshot(refreshed);
		}
		const parsed = JSON.parse(bytes.toString("utf8")) as {
			pinnedAccountIndex?: unknown;
			affinityGeneration?: unknown;
		};
		const pinnedAccountIndex =
			typeof parsed.pinnedAccountIndex === "number" &&
			Number.isFinite(parsed.pinnedAccountIndex)
				? Math.trunc(parsed.pinnedAccountIndex)
				: null;
		const affinityGeneration =
			typeof parsed.affinityGeneration === "number" &&
			Number.isFinite(parsed.affinityGeneration) &&
			Number.isInteger(parsed.affinityGeneration) &&
			parsed.affinityGeneration >= 0
				? parsed.affinityGeneration
				: 0;
		const snapshot: StorageMetaSnapshot = {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			contentHash,
			pinnedAccountIndex,
			affinityGeneration,
		};
		STORAGE_META_CACHE.set(storagePath, snapshot);
		return { pinnedAccountIndex, affinityGeneration };
	} catch (error) {
		// On any failure, prefer the last good snapshot for this path so we
		// don't blow away affinity unnecessarily. Defensive: even non-transient
		// errors fall back to the cache when one exists — better stale than
		// wrong. Defaults are only returned when this file has never been read
		// successfully (cache miss).
		void error;
		const cached = STORAGE_META_CACHE.get(storagePath);
		if (cached) {
			return metaFromSnapshot(cached);
		}
		return { pinnedAccountIndex: null, affinityGeneration: 0 };
	}
}

/**
 * Backwards-compatible helper retained for tests. Prefer `readStorageMetaFromDisk`
 * for new callers that also need `affinityGeneration`.
 */
export function readPinnedAccountIndexFromDisk(
	storagePath: string = getStoragePath(),
): number | null {
	return readStorageMetaFromDisk(storagePath).pinnedAccountIndex;
}

/**
 * Test-only: reset the storage-meta content-hash cache between scenarios so
 * each test starts from a clean read-from-disk state.
 */
export function resetPinCacheForTesting(): void {
	STORAGE_META_CACHE.clear();
}

/**
 * If the on-disk `affinityGeneration` is greater than `lastObservedGeneration`,
 * drop every entry in `sessionAffinityStore` and return the new generation so
 * the caller can update its tracker. Otherwise returns `lastObservedGeneration`
 * unchanged. Extracted so the request-flow logic can be unit-tested without
 * spinning up the full proxy. See issue #474.
 */
export function maybeInvalidateAffinityFromDisk(
	sessionAffinityStore: SessionAffinityStore | null,
	lastObservedGeneration: number,
	storagePath: string = getStoragePath(),
): number {
	const meta = readStorageMetaFromDisk(storagePath);
	if (meta.affinityGeneration > lastObservedGeneration) {
		sessionAffinityStore?.clearAll();
		return meta.affinityGeneration;
	}
	return lastObservedGeneration;
}
