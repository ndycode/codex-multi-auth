import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	promises as fs,
} from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "./runtime-paths.js";

type JsonRecord = Record<string, unknown>;

export const UNIFIED_SETTINGS_VERSION = 1 as const;

const UNIFIED_SETTINGS_PATH = join(getCodexMultiAuthDir(), "settings.json");

/**
 * Determines whether a value is a plain non-null object suitable as a JSON record.
 *
 * This is a simple type guard with no side effects, safe for concurrent use, and it does not access the filesystem or perform any token redaction or mutation of the input. It treats values created on Windows the same as on other platforms (no platform-specific behavior).
 *
 * @param value - The value to test
 * @returns `true` if `value` is a non-null object (a `JsonRecord`), `false` otherwise.
 */
function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object";
}

/**
 * Produce a shallow copy of an object record, or return `null` when the input is not a record.
 *
 * The clone copies top-level properties only and does not deep-clone nested objects. It is safe for concurrent reads but not for concurrent in-place mutations (race conditions may occur if callers mutate the same object concurrently). This function has no filesystem behavior differences on Windows versus other platforms. It does not redact sensitive values — callers must handle token redaction before persisting or logging.
 *
 * @param value - The value to clone
 * @returns The shallow-cloned record, or `null` if `value` is not a record
 */
function cloneRecord(value: unknown): JsonRecord | null {
	if (!isRecord(value)) return null;
	return { ...value };
}

/**
 * Read and parse the unified settings file synchronously and return its JSON record.
 *
 * If the settings file does not exist, cannot be read, or contains invalid JSON, this function returns `null`.
 * The returned value is a shallow clone of the stored object to avoid accidental mutations of internal state.
 *
 * Concurrency and platform notes:
 * - This function performs a plain synchronous read without file locking; concurrent writers or readers may cause races.
 * - On Windows, an open handle or antivirus may prevent reading the file; such failures result in `null`.
 *
 * Security note:
 * - This function does not redact or transform any sensitive fields (e.g., tokens); callers are responsible for redaction or safe handling of secrets.
 *
 * @returns The parsed settings record as a `JsonRecord`, or `null` if the file is absent or unreadable/invalid.
 */
function readSettingsRecordSync(): JsonRecord | null {
	if (!existsSync(UNIFIED_SETTINGS_PATH)) {
		return null;
	}

	try {
		const raw = readFileSync(UNIFIED_SETTINGS_PATH, "utf8");
		return cloneRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Reads and parses the unified settings file if it exists, returning a cloned record.
 *
 * If the settings file does not exist or cannot be read/parsed, returns `null`.
 *
 * Notes:
 * - Concurrent writers may modify the file between existence check and read; callers should handle potential races.
 * - On Windows, path- and permission-related failures will result in `null` rather than thrown errors.
 * - Sensitive values (e.g., tokens) contained in the file are returned as-is; callers should redact or avoid logging them.
 *
 * @returns A cloned settings record when parsing succeeds, or `null` otherwise.
 */
async function readSettingsRecordAsync(): Promise<JsonRecord | null> {
	if (!existsSync(UNIFIED_SETTINGS_PATH)) {
		return null;
	}

	try {
		const raw = await fs.readFile(UNIFIED_SETTINGS_PATH, "utf8");
		return cloneRecord(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Injects the unified settings version into a shallow-cloned settings record.
 *
 * This pure helper returns a new object merging `record` with a `version` field set to `UNIFIED_SETTINGS_VERSION`. It performs no I/O, does not redact tokens or mutate nested objects, and is safe to call concurrently. (No Windows filesystem behavior applies.)
 *
 * @param record - The settings record whose top-level properties will be copied into the normalized result
 * @returns The normalized settings record with `version` set to `UNIFIED_SETTINGS_VERSION`
 */
function normalizeForWrite(record: JsonRecord): JsonRecord {
	return {
		...record,
		version: UNIFIED_SETTINGS_VERSION,
	};
}

/**
 * Writes the provided settings record to the unified settings file on disk.
 *
 * Ensures the Codex multi-auth directory exists, injects the canonical version field, and writes the JSON as UTF-8 with a trailing newline. This function performs a direct, synchronous file write; concurrent writers may overwrite each other (last write wins). On Windows the file is written using LF line endings as produced here; callers should handle any platform-specific normalization if required. Sensitive tokens or secrets present in `record` will be persisted as-is — redact or omit sensitive values before calling.
 *
 * @param record - The settings record to persist; will be normalized with the module's version field before writing
 */
function writeSettingsRecordSync(record: JsonRecord): void {
	mkdirSync(getCodexMultiAuthDir(), { recursive: true });
	const payload = normalizeForWrite(record);
	writeFileSync(UNIFIED_SETTINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Write the given settings record to the unified settings file, creating the parent directory if it does not exist.
 *
 * The record is normalized (a version field is injected) before being serialized as pretty-printed JSON with a trailing newline and written using UTF-8.
 *
 * Concurrency: there is no file locking; concurrent writers may overwrite each other and can result in lost updates.
 *
 * Windows behavior: the file is written with UTF-8 encoding and a LF trailing newline; no CRLF translation or atomic-replace is guaranteed by this function.
 *
 * Security: this function does not redact or sanitize secrets—callers must remove or redact sensitive tokens before passing `record`.
 *
 * @param record - Settings object to persist; will be cloned/normalized prior to write
 */
async function writeSettingsRecordAsync(record: JsonRecord): Promise<void> {
	await fs.mkdir(getCodexMultiAuthDir(), { recursive: true });
	const payload = normalizeForWrite(record);
	await fs.writeFile(UNIFIED_SETTINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Path to the unified settings file used by Codex Multi-Auth.
 *
 * Points to the JSON file under the Codex Multi-Auth directory. Access may be racy when multiple processes read or write the file concurrently; callers are responsible for coordinating concurrent writes. On Windows the returned path uses platform-native separators. The settings file can contain sensitive tokens—do not log its contents and redact secrets before exposing them.
 *
 * @returns The absolute path to settings.json
 */
export function getUnifiedSettingsPath(): string {
	return UNIFIED_SETTINGS_PATH;
}

/**
 * Loads the saved plugin configuration from the unified settings file.
 *
 * Reads the on-disk unified settings synchronously and returns a shallow clone of the `pluginConfig` section to avoid accidental mutation by callers. Returns `null` when the settings file or the `pluginConfig` section is absent or cannot be read. Concurrent access is not synchronized — concurrent writers may race with this read; on Windows, file locks can cause reads to fail or return stale data. The returned record may contain sensitive tokens or secrets; callers should redact or treat it as confidential before logging or exposing externally.
 *
 * @returns A shallow-cloned `pluginConfig` record if present, or `null` otherwise.
 */
export function loadUnifiedPluginConfigSync(): JsonRecord | null {
	const record = readSettingsRecordSync();
	if (!record) return null;
	return cloneRecord(record.pluginConfig);
}

/**
 * Persists the provided plugin configuration into the unified settings file synchronously.
 *
 * This replaces the stored `pluginConfig` section with a shallow copy of `pluginConfig` and writes the updated settings file to disk. Callers must avoid concurrent invocations that mutate settings to prevent race conditions; concurrent writes may overwrite each other. On Windows, writes can fail if the file is locked by another process. The saved data is stored as provided — it may contain sensitive tokens or secrets, so avoid logging `pluginConfig` and redact secrets before external exposure.
 *
 * @param pluginConfig - The plugin configuration record to store; keys in this record will replace the existing `pluginConfig` section
 */
export function saveUnifiedPluginConfigSync(pluginConfig: JsonRecord): void {
	const record = readSettingsRecordSync() ?? {};
	record.pluginConfig = { ...pluginConfig };
	writeSettingsRecordSync(record);
}

/**
 * Persist the given plugin configuration into the unified settings file.
 *
 * @param pluginConfig - Plain JSON object to store under the `pluginConfig` key; a shallow clone of this object is written.
 *
 * @remarks
 * - Concurrency: writes are not locked or atomic across processes. Concurrent writers may overwrite each other; callers should serialize writes if concurrent access is possible.
 * - Windows/filesystem: behavior follows Node.js fs semantics on Windows; callers should not assume atomic replace semantics and should handle potential partial writes from concurrent processes.
 * - Sensitive data: values are written as provided. Any secrets or tokens should be redacted before calling this function.
 */
export async function saveUnifiedPluginConfig(pluginConfig: JsonRecord): Promise<void> {
	const record = await readSettingsRecordAsync() ?? {};
	record.pluginConfig = { ...pluginConfig };
	await writeSettingsRecordAsync(record);
}

/**
 * Loads dashboard display settings from the unified settings file.
 *
 * Reads the current on-disk settings and returns a shallow clone of the `dashboardDisplaySettings` section.
 * Note: concurrent writers may change the file between calls (no cross-process locking); Windows file-locking can cause read failures in rare cases. The returned object may contain sensitive values (tokens/keys) — callers are responsible for redaction before logging or exposing externally.
 *
 * @returns The dashboard display settings object if present, `null` if the settings file or section is absent or unreadable.
 */
export async function loadUnifiedDashboardSettings(): Promise<JsonRecord | null> {
	const record = await readSettingsRecordAsync();
	if (!record) return null;
	return cloneRecord(record.dashboardDisplaySettings);
}

/**
 * Persists dashboard display settings into the unified settings file on disk.
 *
 * This overwrites the `dashboardDisplaySettings` section of the stored settings with a shallow clone
 * of the provided record and ensures the settings file and parent directory exist before writing.
 * Concurrency: callers should serialize concurrent writers to avoid lost updates; the function does
 * not perform merge-conflict resolution. On Windows, filesystem path and newline semantics follow the
 * runtime environment; callers should ensure provided values are portable if needed. Do not pass
 * unredacted secrets or tokens — sensitive fields must be removed or redacted before calling.
 *
 * @param dashboardDisplaySettings - Settings to store under `dashboardDisplaySettings`; the value is shallow-cloned before write.
 */
export async function saveUnifiedDashboardSettings(
	dashboardDisplaySettings: JsonRecord,
): Promise<void> {
	const record = await readSettingsRecordAsync() ?? {};
	record.dashboardDisplaySettings = { ...dashboardDisplaySettings };
	await writeSettingsRecordAsync(record);
}
