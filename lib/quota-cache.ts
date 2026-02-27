import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";

export interface QuotaCacheWindow {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
}

export interface QuotaCacheEntry {
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
}

interface QuotaCacheFile {
	version: 1;
	byAccountId: Record<string, QuotaCacheEntry>;
	byEmail: Record<string, QuotaCacheEntry>;
}

const QUOTA_CACHE_PATH = join(getCodexMultiAuthDir(), "quota-cache.json");
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Type guard that narrows a value to a non-null object with string keys.
 *
 * This predicate treats arrays and other non-primitive objects as objects (they will pass).
 * Concurrent-safe; performs no filesystem I/O; does not perform any token redaction.
 *
 * @param value - The value to test
 * @returns `true` if `value` is a non-null object (narrowed to `Record<string, unknown>`), `false` otherwise.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
	if (!existsSync(QUOTA_CACHE_PATH)) {
		return { byAccountId: {}, byEmail: {} };
	}

	try {
		const content = await fs.readFile(QUOTA_CACHE_PATH, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (!isRecord(parsed)) {
			return { byAccountId: {}, byEmail: {} };
		}
		if (parsed.version !== 1) {
			return { byAccountId: {}, byEmail: {} };
		}

		return {
			byAccountId: normalizeEntryMap(parsed.byAccountId),
			byEmail: normalizeEntryMap(parsed.byEmail),
		};
	} catch (error) {
		logWarn(
			`Failed to load quota cache from ${QUOTA_CACHE_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { byAccountId: {}, byEmail: {} };
	}
}

/**
 * Persist the quota cache to the on-disk JSON file used by the multi-auth runtime.
 *
 * Writes a versioned, pretty-printed JSON representation of `data` to the configured
 * quota cache path. Failures are logged and do not throw, so callers should handle
 * eventual consistency or retry as needed.
 *
 * Concurrency: concurrent writers may race and overwrite each other; callers should
 * serialize writes if strong consistency is required.
 *
 * Filesystem notes: Windows path length, permissions, or antivirus locks may cause
 * write failures; such errors are logged rather than thrown.
 *
 * Security: this function does not redact secrets or tokens — callers must ensure
 * `data` contains no sensitive plaintext tokens before calling.
 *
 * @param data - The quota cache data (byAccountId and byEmail maps) to persist; callers
 *               should pass normalized QuotaCacheData.
 */
export async function saveQuotaCache(data: QuotaCacheData): Promise<void> {
	const payload: QuotaCacheFile = {
		version: 1,
		byAccountId: data.byAccountId,
		byEmail: data.byEmail,
	};

	try {
		await fs.mkdir(getCodexMultiAuthDir(), { recursive: true });
		const tempPath = `${QUOTA_CACHE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
		await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		let renamed = false;
		try {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					await fs.rename(tempPath, QUOTA_CACHE_PATH);
					renamed = true;
					break;
				} catch (error) {
					if (!isRetryableFsError(error) || attempt >= 4) throw error;
					await sleep(10 * 2 ** attempt);
				}
			}
		} finally {
			if (!renamed) {
				try {
					await fs.unlink(tempPath);
				} catch {
					// Best effort temp cleanup.
				}
			}
		}
	} catch (error) {
		logWarn(
			`Failed to save quota cache to ${QUOTA_CACHE_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
