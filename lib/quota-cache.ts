import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { withRetry } from "./fs-retry.js";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { tempPathFor } from "./temp-path.js";
import { withFileTransactionLock } from "./storage/file-lock.js";
import {
	assertJsonStoreFileMtimeUnchanged,
	getJsonStoreFileMtimeMs,
	withJsonStoreCasRetry,
} from "./storage/json-store-lock.js";
import { isRecord } from "./utils.js";

export interface QuotaCacheWindow {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
}

export interface QuotaCacheEntry {
	/** Account-validated native usage permission; never inferred from percentages. */
	ordinaryUsageAllowed?: boolean | null;
	/** Native permission timestamp; header refreshes must not extend its lifetime. */
	ordinaryUsageCheckedAt?: number;
	primingCompleted?: boolean;
	/** Completion/failure time, independent of the quota header observation. */
	primingObservedAt?: number;
	primingFailure?: "timed out" | "stream ended early" | "upstream failed" | "response too large" | "network error";
	updatedAt: number;
	status: number;
	model: string;
	planType?: string;
	primary: QuotaCacheWindow;
	secondary: QuotaCacheWindow;
}

export interface QuotaCacheData {
	byAccountId: Record<string, QuotaCacheEntry>;
	byEmail: Record<string, QuotaCacheEntry>;
	/** Quota scoped to a saved credential record and exact workspace. */
	byWorkspace?: Record<string, QuotaCacheEntry>;
}

interface QuotaCacheFile {
	version: 1;
	byAccountId: Record<string, QuotaCacheEntry>;
	byEmail: Record<string, QuotaCacheEntry>;
	/** Quota scoped to a saved credential record and exact workspace. */
	byWorkspace?: Record<string, QuotaCacheEntry>;
}

const QUOTA_CACHE_PATH = join(getCodexMultiAuthDir(), "quota-cache.json");
const QUOTA_CACHE_LABEL = basename(QUOTA_CACHE_PATH);
let quotaCacheWriteQueue: Promise<void> = Promise.resolve();

/**
 * Normalizes an unknown value to a finite number.
 *
 * @param value - The value to normalize
 * @returns The input as a finite number, or `undefined` if the value is not a finite number
 */
function normalizeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Produce a normalized QuotaCacheWindow from an arbitrary value.
 *
 * @param value - The raw input to normalize; if not an object, an empty window is returned.
 * @returns A QuotaCacheWindow whose `usedPercent`, `windowMinutes`, and `resetAtMs` are finite numbers or `undefined` when missing/invalid.
 */
function normalizeWindow(value: unknown): QuotaCacheWindow {
	if (!isRecord(value)) return {};
	return {
		usedPercent: normalizeNumber(value.usedPercent),
		windowMinutes: normalizeNumber(value.windowMinutes),
		resetAtMs: normalizeNumber(value.resetAtMs),
	};
}

/**
 * Normalize and validate a raw parsed value into a quota cache entry.
 *
 * Produces a QuotaCacheEntry with a trimmed `model`, optional `planType`, and normalized
 * `primary`/`secondary` windows when `updatedAt`, `status`, and `model` are present and valid;
 * returns `null` for any invalid input. This helper is pure (no I/O), safe to call concurrently,
 * and platform-agnostic (works with data read from files on Windows or POSIX). It does not perform
 * token redaction — callers must redact sensitive fields before persisting or logging.
 *
 * @param value - The arbitrary input (typically parsed JSON) to validate and normalize
 * @returns A normalized `QuotaCacheEntry` if validation succeeds, `null` otherwise
 */
function normalizeEntry(value: unknown): QuotaCacheEntry | null {
	if (!isRecord(value)) return null;
	const updatedAt = normalizeNumber(value.updatedAt);
	const status = normalizeNumber(value.status);
	const model = typeof value.model === "string" ? value.model : "";
	if (
		typeof updatedAt !== "number" ||
		typeof status !== "number" ||
		model.trim().length === 0
	) {
		return null;
	}

	return {
		...(value.primingCompleted === true ? {primingCompleted: true} : {}),
		...(typeof value.primingFailure === "string" && ["timed out", "stream ended early", "upstream failed", "response too large", "network error"].includes(value.primingFailure) ? {primingFailure: value.primingFailure as QuotaCacheEntry["primingFailure"]} : {}),
		...(normalizeNumber(value.primingObservedAt) !== undefined ? { primingObservedAt: normalizeNumber(value.primingObservedAt) } : {}),
		updatedAt,
		status,
		model: model.trim(),
		planType: typeof value.planType === "string" ? value.planType : undefined,
		primary: normalizeWindow(value.primary),
		secondary: normalizeWindow(value.secondary),
	};
}

/**
 * Convert a raw parsed value into a map of validated quota cache entries.
 *
 * @param value - Parsed JSON value (typically an object) containing raw entries keyed by identifier; non-objects, empty keys, or invalid entries are ignored.
 * @returns A record mapping valid string keys to normalized `QuotaCacheEntry` objects; malformed entries are omitted.
 * 
 * Note: This function is pure and performs no filesystem I/O. Callers are responsible for any filesystem concurrency or Windows-specific behavior when loading/saving the on-disk cache, and for redacting any sensitive tokens before logging or persisting.
 */
function normalizeEntryMap(value: unknown): Record<string, QuotaCacheEntry> {
	if (!isRecord(value)) return {};
	const entries: Record<string, QuotaCacheEntry> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof key !== "string" || key.trim().length === 0) continue;
		const normalized = normalizeEntry(raw);
		if (!normalized) continue;
		entries[key] = normalized;
	}
	return entries;
}

function readCacheFileWithRetry(path: string): Promise<string> {
	// Retries the shared FILE_RETRY_CODES taxonomy (lib/fs-retry.ts) so a
	// transient Windows lock (AV/indexer/concurrent reader) on the quota cache
	// is retried consistently with every other fs path, not just EBUSY/EPERM.
	return withRetry(() => fs.readFile(path, "utf8"), {
		maxAttempts: 5,
		backoffMs: (attempt) => 10 * 2 ** (attempt - 1),
	});
}

/**
 * Get the absolute filesystem path to the quota-cache.json file.
 *
 * The resolved path points to quota-cache.json inside the Codex multi-auth directory.
 * Callers must observe normal filesystem concurrency semantics (no internal locking is provided),
 * and handle platform-specific path behavior (for example, on Windows the file may reside under %APPDATA%).
 * The file can contain sensitive values; redact tokens or secrets before logging or exposing its contents.
 *
 * @returns The absolute path to the quota-cache.json file
 */
export function getQuotaCachePath(): string {
	return QUOTA_CACHE_PATH;
}

/**
 * Loads and returns the normalized quota cache from disk.
 *
 * Reads the JSON cache at the configured quota-cache path, validates and normalizes entries,
 * and returns maps keyed by account ID and email. If the file is missing, invalid, or an I/O
 * error occurs, returns empty maps and logs a warning.
 *
 * Notes:
 * - Concurrency: callers should expect concurrent readers and writers; the function performs
 *   a best-effort read and does not perform file locking.
 * - Windows: uses standard UTF-8 file reads; caller should ensure the quota-cache path is
 *   compatible with Windows path semantics when used on that platform.
 * - Redaction: callers should avoid logging or exposing the file contents; any tokens or
 *   sensitive identifiers contained in the cache should be redacted before external reporting.
 *
 * @returns The quota cache as `{ byAccountId, byEmail }` with normalized entries; each map
 *          will be empty if the on-disk file is absent, malformed, or could not be read.
 */
export async function loadQuotaCache(): Promise<QuotaCacheData> {
	try {
		return await readQuotaCache();
	} catch (error) {
		logWarn(`Failed to load quota cache from ${QUOTA_CACHE_LABEL}: ${error instanceof Error ? error.message : String(error)}`);
		return { byAccountId: {}, byEmail: {} };
	}
}

/** Only a missing file is empty for writers; read failures must never erase concurrent data. */
async function readQuotaCache(): Promise<QuotaCacheData> {
	let content: string;
	try {
		content = await readCacheFileWithRetry(QUOTA_CACHE_PATH);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { byAccountId: {}, byEmail: {} };
		throw error;
	}
	const parsed: unknown = JSON.parse(content);
	if (!isRecord(parsed) || parsed.version !== 1) {
		throw Error("Quota cache rejected due to version mismatch or invalid payload");
	}
	return {
		byAccountId: normalizeEntryMap(parsed.byAccountId),
		byEmail: normalizeEntryMap(parsed.byEmail),
		...(parsed.byWorkspace ? { byWorkspace: normalizeEntryMap(parsed.byWorkspace) } : {}),
	};
}

/** Merge quota and priming evidence independently; subsequent quota retires old outcomes. */
export function mergeQuotaCacheEntry(latest: QuotaCacheEntry | undefined, update: QuotaCacheEntry): QuotaCacheEntry {
	if (!latest) return update;
	const quota = update.updatedAt >= latest.updatedAt ? update : latest;
	const outcomeTime = (entry: QuotaCacheEntry) => entry.primingCompleted || entry.primingFailure
		? entry.primingObservedAt ?? entry.updatedAt : -Infinity;
	// A timeout does not undo a completion from an overlapping attempt.
	// Only completions at/after the newest quota observation remain relevant.
	const completion = [update, latest].filter(entry => entry.primingCompleted && outcomeTime(entry) >= quota.updatedAt)
		.sort((a, b) => outcomeTime(b) - outcomeTime(a))[0];
	const evidence = completion ?? (outcomeTime(update) >= outcomeTime(latest) ? update : latest);
	const result = { ...quota };
	delete result.primingCompleted;
	delete result.primingFailure;
	delete result.primingObservedAt;
	if (outcomeTime(evidence) >= quota.updatedAt) {
		if (evidence.primingCompleted) result.primingCompleted = true;
		else if (evidence.primingFailure) result.primingFailure = evidence.primingFailure;
		if (evidence.primingObservedAt !== undefined) result.primingObservedAt = evidence.primingObservedAt;
	}
	return result;
}

/** Reapply this run's changed entries, preserving unrelated or newer concurrent observations. */
function mergeQuotaChanges(current: QuotaCacheData, proposed: QuotaCacheData, baseline: QuotaCacheData): QuotaCacheData {
	const same = (a: QuotaCacheEntry | undefined, b: QuotaCacheEntry | undefined) => JSON.stringify(a) === JSON.stringify(b);
	for (const namespace of ["byAccountId", "byEmail", "byWorkspace"] as const) {
		const before = baseline[namespace] ?? {}, next = proposed[namespace] ?? {};
		for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
			if (same(before[key], next[key])) continue;
			const latest = current[namespace]?.[key], update = next[key];
			if (update) {
				if (latest && update.updatedAt < latest.updatedAt && same(latest, before[key])) {
					// Preserve the existing backward-clock handling for an unraced write.
					update.updatedAt = latest.updatedAt + 1;
				}
				current[namespace] ??= {};
				current[namespace][key] = mergeQuotaCacheEntry(latest, update);
			} else if (same(latest, before[key])) {
				delete current[namespace]?.[key];
			}
		}
	}
	return current;
}

/**
 * Persist the quota cache to the on-disk JSON file used by the multi-auth runtime.
 *
 * Writes a versioned, pretty-printed JSON representation of `data` to the configured
 * quota cache path. Failures are logged and do not throw, so callers should handle
 * eventual consistency or retry as needed.
 *
 * Concurrency: reload, apply changes since `baseline`, and atomically write under
 * a cross-process lock. Pass the pre-edit snapshot for read–modify–write callers.
 * Without a baseline, supplied entries are upserts; omitted entries are retained.
 *
 * Filesystem notes: Windows path length, permissions, or antivirus locks may cause
 * write failures; such errors are logged rather than thrown.
 *
 * Security: this function does not redact secrets or tokens — callers must ensure
 * `data` contains no sensitive plaintext tokens before calling.
 *
 * @param data - The quota cache data (byAccountId and byEmail maps) to persist; callers
 *               should pass normalized QuotaCacheData.
 * @param baseline - The unmodified pre-edit snapshot; only changes since it are applied.
 */
export async function saveQuotaCache(data: QuotaCacheData, baseline: QuotaCacheData = { byAccountId: {}, byEmail: {} }): Promise<void> {
	// Snapshot at invocation, not after waiting behind other writers.
	const proposed = structuredClone(data), before = structuredClone(baseline);

	const writeTask = async (): Promise<void> => {
		try {
			// The transaction lock gives the read-merge-write cross-process mutual
			// exclusion; the mtime CAS retry inside it is the second-line guard for
			// writers that do not take the lock: every attempt re-stats, re-reads
			// the freshest on-disk cache, and re-merges this call's diff onto it
			// (matching the config save's reload-and-retry ESTALE semantics).
			await withFileTransactionLock(QUOTA_CACHE_PATH, async () => {
				await withJsonStoreCasRetry(async () => {
					const expectedMtimeMs = await getJsonStoreFileMtimeMs(
						QUOTA_CACHE_PATH,
					);
					const merged = mergeQuotaChanges(
						await readQuotaCache(),
						proposed,
						before,
					);
					const payload: QuotaCacheFile = { version: 1, ...merged };
					const cacheDir = getCodexMultiAuthDir();
					// The quota cache lives alongside other at-rest secrets, so keep the
					// directory owner-only on POSIX (mode is a no-op on win32 / ACL-based).
					await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
					// mkdir's mode only applies to a freshly-created dir; an upgrade with a
					// pre-existing multi-auth dir keeps its old (possibly world-listable)
					// perms, so re-assert 0o700 on POSIX. Best-effort: a chmod failure must
					// not break the cache write (the 0o600 file below still protects data).
					if (process.platform !== "win32") {
						try {
							await fs.chmod(cacheDir, 0o700);
						} catch {
							// Best-effort hardening only.
						}
					}
					const tempPath = tempPathFor(QUOTA_CACHE_PATH);
					await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
						encoding: "utf8",
						mode: 0o600,
					});
					let renamed = false;
					try {
						await assertJsonStoreFileMtimeUnchanged(
							QUOTA_CACHE_PATH,
							expectedMtimeMs,
						);
						await withRetry(() => fs.rename(tempPath, QUOTA_CACHE_PATH), {
							maxAttempts: 5,
							backoffMs: (attempt) => 10 * 2 ** (attempt - 1),
						});
						renamed = true;
					} finally {
						if (!renamed) {
							try {
								await fs.unlink(tempPath);
							} catch {
								// Best effort temp cleanup.
							}
						}
					}
				});
			});
		} catch (error) {
			logWarn(
				`Failed to save quota cache to ${QUOTA_CACHE_LABEL}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	};

	const queued = quotaCacheWriteQueue.catch(() => undefined).then(writeTask);
	quotaCacheWriteQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	await queued;
}
