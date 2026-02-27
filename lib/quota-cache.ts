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

/**
 * Determines whether a value is an object and not `null`.
 *
 * @param value - The value to test
 * @returns `true` if `value` is an object and not `null`, `false` otherwise
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Normalize an unknown input into a finite number.
 *
 * @param value - The value to validate as a finite number
 * @returns The input as a number if it is finite, `undefined` otherwise
 */
function normalizeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize an unknown value into a QuotaCacheWindow.
 *
 * Converts a raw value that may come from parsed JSON or external input into a
 * QuotaCacheWindow where numeric fields are either a finite number or `undefined`.
 *
 * Note: callers that persist the resulting object should handle concurrent file
 * access at a higher level; this function performs pure value normalization and
 * has no filesystem side effects. Normalization is platform‑agnostic (including
 * Windows) and does not perform or expose any token redaction.
 *
 * @param value - The raw value to normalize (typically a parsed JSON object)
 * @returns A QuotaCacheWindow with `usedPercent`, `windowMinutes`, and `resetAtMs`
 *          set to a finite number or `undefined` when absent/invalid
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
 * Normalize an unknown value into a QuotaCacheEntry or return null for invalid input.
 *
 * This is a pure, synchronous normalizer intended for sanitizing parsed JSON; it does not perform I/O.
 * Callers are responsible for concurrency control when using the result with filesystem operations.
 * String fields are trimmed but not redacted — any sensitive tokens must be redacted by the caller before persisting or logging.
 *
 * @param value - Raw value (e.g., parsed JSON) to validate and normalize into a QuotaCacheEntry
 * @returns `QuotaCacheEntry` when `value` contains required, valid fields (`updatedAt`, `status`, non-empty `model`); `null` otherwise.
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
 * Converts an unknown value into a map of validated quota cache entries keyed by string IDs.
 *
 * @param value - Raw parsed value (expected to be an object) containing candidate entries; non-object inputs produce an empty map.
 * @returns A record mapping each valid, non-empty string key to a normalized `QuotaCacheEntry`; invalid keys or entries are omitted.
 *
 * Notes:
 * - Concurrency: callers should treat the returned map as a snapshot; concurrent mutation of the source does not affect the result.
 * - Filesystem: no IO occurs here; this function is safe to call on Windows and POSIX environments.
 * - Token redaction: keys and entry contents are validated but not redacted by this function — any secret/token redaction should occur before calling or after consuming the returned map.
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
 * Get the absolute filesystem path to the quota-cache JSON file used by the multi-auth subsystem.
 *
 * The path is intended for filesystem access by callers; callers should coordinate concurrent reads/writes (for example via file locking) to avoid races. On Windows the path may include backslashes and platform-specific path semantics. The returned path does not contain any sensitive tokens or credentials.
 *
 * @returns The absolute path to quota-cache.json
 */
export function getQuotaCachePath(): string {
	return QUOTA_CACHE_PATH;
}

/**
 * Load and normalize the quota cache from the configured cache file.
 *
 * Reads the JSON cache at the configured path, validates and normalizes its
 * entries, and returns maps keyed by account ID and by email. If the file
 * does not exist or cannot be parsed/read, this returns empty maps.
 *
 * Notes:
 * - Concurrency: callers should serialize writes/reads if they require
 *   coordination; this function does not perform file locking.
 * - Filesystem behavior: the function expects a UTF-8 JSON file at the
 *   configured path and will fall back to empty data on missing or invalid
 *   files.
 * - Token/sensitive-data handling: this loader does not redact or mask any
 *   fields; callers must ensure no sensitive tokens are written to the cache.
 *
 * @returns The normalized QuotaCacheData containing `byAccountId` and
 *          `byEmail` maps; both maps are empty if the cache is missing or an
 *          error occurs during load/parse.
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
 * Persist the quota cache to the configured quota-cache.json file.
 *
 * @param data - Quota cache data containing `byAccountId` and `byEmail` maps to write
 *
 * @remarks
 * - Writes a versioned payload (version = 1) to the path returned by getQuotaCachePath().
 * - Callers should serialize concurrent calls; file writes are not atomic and concurrent saves may race or interleave.
 * - On Windows, behavior follows Node.js fs: directory creation uses recursive mkdir and write semantics follow the platform's file semantics.
 * - This function does not perform redaction; callers must ensure any sensitive tokens or PII are removed or redacted before calling.
 */
export async function saveQuotaCache(data: QuotaCacheData): Promise<void> {
	const payload: QuotaCacheFile = {
		version: 1,
		byAccountId: data.byAccountId,
		byEmail: data.byEmail,
	};

	try {
		await fs.mkdir(getCodexMultiAuthDir(), { recursive: true });
		await fs.writeFile(QUOTA_CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} catch (error) {
		logWarn(
			`Failed to save quota cache to ${QUOTA_CACHE_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
