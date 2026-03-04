import {
	mkdirSync,
	renameSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	promises as fs,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { sleep } from "./utils.js";
import { acquireFileLock, acquireFileLockSync } from "./file-lock.js";

type JsonRecord = Record<string, unknown>;

export const UNIFIED_SETTINGS_VERSION = 1 as const;

const UNIFIED_SETTINGS_PATH = join(getCodexMultiAuthDir(), "settings.json");
const UNIFIED_SETTINGS_LOCK_PATH = `${UNIFIED_SETTINGS_PATH}.lock`;
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);
let settingsWriteQueue: Promise<void> = Promise.resolve();
const SETTINGS_CONFLICT_RETRY_LIMIT = 3;

type SettingsSnapshot = {
	record: JsonRecord | null;
	revision: string | null;
};

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

/**
 * Determines whether a value is a non-null object suitable for use as a JsonRecord.
 *
 * @param value - The value to test
 * @returns `true` if `value` is an object and not `null`, `false` otherwise
 */
function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Return a shallow clone of an object-style record, or `null` if the input is not a record.
 *
 * @param value - Value to clone; must be a non-null plain object (record)
 * @returns A new object containing the same own enumerable properties as `value`, or `null` if `value` is not a record
 */
function cloneRecord(value: unknown): JsonRecord | null {
	if (!isRecord(value)) return null;
	return { ...value };
}

function computeSha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function createSettingsConflictError(): Error & { code: string } {
	return Object.assign(
		new Error(
			"Detected concurrent unified settings modification; reload and retry",
		),
		{ code: "ECONFLICT" as const },
	);
}

function isConflictError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ECONFLICT";
}

function readFileUtf8IfExistsSync(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function readFileUtf8IfExistsAsync(path: string): Promise<string | null> {
	try {
		return await fs.readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function readCurrentSettingsRevisionSync(): string | null {
	const raw = readFileUtf8IfExistsSync(UNIFIED_SETTINGS_PATH);
	if (raw === null) return null;
	return computeSha256(raw);
}

async function readCurrentSettingsRevisionAsync(): Promise<string | null> {
	const raw = await readFileUtf8IfExistsAsync(UNIFIED_SETTINGS_PATH);
	if (raw === null) return null;
	return computeSha256(raw);
}

function readSettingsSnapshotSync(): SettingsSnapshot {
	const raw = readFileUtf8IfExistsSync(UNIFIED_SETTINGS_PATH);
	if (raw === null) {
		return { record: null, revision: null };
	}
	const parsed = cloneRecord(JSON.parse(raw));
	if (!parsed) {
		throw new Error("Unified settings must contain a JSON object at the root.");
	}
	return { record: parsed, revision: computeSha256(raw) };
}

async function readSettingsSnapshotAsync(): Promise<SettingsSnapshot> {
	const raw = await readFileUtf8IfExistsAsync(UNIFIED_SETTINGS_PATH);
	if (raw === null) {
		return { record: null, revision: null };
	}
	const parsed = cloneRecord(JSON.parse(raw));
	if (!parsed) {
		throw new Error("Unified settings must contain a JSON object at the root.");
	}
	return { record: parsed, revision: computeSha256(raw) };
}

/**
 * Reads and parses the unified settings JSON file from disk.
 *
 * @returns The parsed settings object as a `JsonRecord`, or `null` if the settings file does not exist or cannot be read/parsed.
 *
 * @remarks
 * - Concurrency: concurrent writers may produce transient read failures or partial files; atomicity is not guaranteed and callers should tolerate `null` and retry if needed.
 * - Windows: file locking on Windows may cause reads to fail; in those cases this function returns `null`.
 * - Sensitive data: this function performs no token or secret redaction; any sensitive values present in the file are returned as-is and callers are responsible for redaction before logging or external exposure.
 */
function readSettingsRecordSync(): JsonRecord | null {
	return readSettingsSnapshotSync().record;
}

/**
 * Reads and parses the unified settings JSON file if present.
 *
 * This attempts to read and parse the file at the unified settings path and returns a shallow-cloned object on success. Returns `null` if the file does not exist, cannot be read, or contains invalid JSON. Concurrent writers may cause this call to return `null` or stale/partial data; callers should tolerate missing or malformed results. On Windows, path and permission semantics follow the Node runtime and may affect visibility. Consumers must redact any sensitive tokens before logging or returning the record.
 *
 * @returns The parsed settings record as an object clone, or `null` if unavailable or invalid.
 */
async function readSettingsRecordAsync(): Promise<JsonRecord | null> {
	const snapshot = await readSettingsSnapshotAsync();
	return snapshot.record;
}

/**
 * Return a shallow-cloned settings record with the canonical unified settings `version` applied.
 *
 * This function is pure and only normalizes the payload for disk writes; it does not coordinate or serialize
 * concurrent writers (callers must handle concurrency). No platform-specific behavior is applied for Windows —
 * the `version` field is always set. Sensitive values (tokens, secrets) are not redacted or transformed;
 * callers must remove or redact them before writing if required.
 *
 * @param record - The input settings object to normalize; keys are preserved.
 * @returns The shallow clone of `record` with `version` set to `UNIFIED_SETTINGS_VERSION`.
 */
function normalizeForWrite(record: JsonRecord): JsonRecord {
	return {
		...record,
		version: UNIFIED_SETTINGS_VERSION,
	};
}

/**
 * Persist a unified settings record to the unified settings file on disk.
 *
 * Ensures the target directory exists, writes a pretty-printed, version-normalized JSON payload
 * with a trailing newline to the configured unified settings path. This function does not
 * redact, encrypt, or otherwise transform sensitive values — callers must remove or redact
 * secrets (tokens, credentials) before calling.
 *
 * Concurrency: concurrent invocations may race and overwrite each other; callers should
 * serialize writes if atomicity is required. Filesystem behavior (including atomicity and
 * file-lock semantics) is platform-dependent and may differ on Windows.
 *
 * @param record - The settings object to persist; it will be normalized to include the unified settings version.
 */
function writeSettingsRecordSync(
	record: JsonRecord,
	options?: { expectedRevision?: string | null },
): void {
	mkdirSync(getCodexMultiAuthDir(), { recursive: true });
	const payload = normalizeForWrite(record);
	const data = `${JSON.stringify(payload, null, 2)}\n`;
	const tempPath = `${UNIFIED_SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
	const lock = acquireFileLockSync(UNIFIED_SETTINGS_LOCK_PATH, {
		maxAttempts: 80,
		baseDelayMs: 15,
		maxDelayMs: 800,
		staleAfterMs: 120_000,
	});
	try {
		const expectedRevision = options?.expectedRevision;
		if (expectedRevision !== undefined) {
			const currentRevision = readCurrentSettingsRevisionSync();
			if (currentRevision !== expectedRevision) {
				throw createSettingsConflictError();
			}
		}
		writeFileSync(tempPath, data, "utf8");
		let moved = false;
		try {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					renameSync(tempPath, UNIFIED_SETTINGS_PATH);
					moved = true;
					return;
				} catch (error) {
					if (!isRetryableFsError(error) || attempt >= 4) {
						throw error;
					}
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
				}
			}
		} finally {
			if (!moved) {
				try {
					unlinkSync(tempPath);
				} catch {
					// Best-effort temp cleanup.
				}
			}
		}
	} finally {
		lock.release();
	}
}

/**
 * Write a normalized unified settings record to the shared settings.json file.
 *
 * The function ensures the multi-auth settings directory exists, normalizes the
 * provided record by embedding the canonical settings version, and writes a
 * pretty-printed JSON file with a trailing newline to the resolved settings path.
 *
 * Concurrency: concurrent writers may race; the last successful write wins. Callers
 * should coordinate writes if atomic read-modify-write semantics are required.
 *
 * Windows filesystem note: file locking and rename atomicity differ on Windows;
 * callers should handle possible sharing or locking errors when multiple processes
 * interact with the file.
 *
 * Security note: this function does not redact or sanitize sensitive values (e.g.,
 * tokens or secrets). Ensure any secrets are removed or redacted from `record`
 * before calling.
 *
 * @param record - The settings object to persist; it will be normalized (version set)
 */
async function writeSettingsRecordAsync(
	record: JsonRecord,
	options?: { expectedRevision?: string | null },
): Promise<void> {
	await fs.mkdir(getCodexMultiAuthDir(), { recursive: true });
	const payload = normalizeForWrite(record);
	const data = `${JSON.stringify(payload, null, 2)}\n`;
	const tempPath = `${UNIFIED_SETTINGS_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	const lock = await acquireFileLock(UNIFIED_SETTINGS_LOCK_PATH, {
		maxAttempts: 80,
		baseDelayMs: 15,
		maxDelayMs: 800,
		staleAfterMs: 120_000,
	});
	try {
		const expectedRevision = options?.expectedRevision;
		if (expectedRevision !== undefined) {
			const currentRevision = await readCurrentSettingsRevisionAsync();
			if (currentRevision !== expectedRevision) {
				throw createSettingsConflictError();
			}
		}
		await fs.writeFile(tempPath, data, "utf8");
		let moved = false;
		try {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					await fs.rename(tempPath, UNIFIED_SETTINGS_PATH);
					moved = true;
					return;
				} catch (error) {
					if (!isRetryableFsError(error) || attempt >= 4) {
						throw error;
					}
					await sleep(10 * 2 ** attempt);
				}
			}
		} finally {
			if (!moved) {
				try {
					await fs.unlink(tempPath);
				} catch {
					// Best-effort temp cleanup.
				}
			}
		}
	} finally {
		await lock.release();
	}
}

async function enqueueSettingsWrite<T>(task: () => Promise<T>): Promise<T> {
	const run = settingsWriteQueue.catch(() => {}).then(task);
	settingsWriteQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * Get the absolute filesystem path to the unified settings JSON file used for multi-auth plugins.
 *
 * The path points to the settings.json inside the Codex multi-auth directory. Callers should treat access as subject to typical filesystem race conditions (concurrent readers/writers may conflict), and be aware that on Windows the path uses platform separators returned by Node's path utilities. The file may contain sensitive tokens; redact or avoid logging file contents.
 *
 * @returns The absolute path to the unified settings JSON file
 */
export function getUnifiedSettingsPath(): string {
	return UNIFIED_SETTINGS_PATH;
}

/**
 * Loads the unified plugin configuration from the versioned settings file.
 *
 * Returns a shallow clone of the `pluginConfig` section if present; returns `null` when the settings file or the section is absent or unreadable.
 *
 * Note: callers should expect possible race conditions if other processes write the settings file concurrently; atomicity is not guaranteed across filesystems (including some Windows setups). This function does not redact or modify sensitive tokens—do not log or expose values returned here without first applying appropriate redaction.
 *
 * @returns A shallow clone of the `pluginConfig` object from the settings file, or `null` if unavailable.
 */
export function loadUnifiedPluginConfigSync(): JsonRecord | null {
	try {
		const record = readSettingsRecordSync();
		if (!record) return null;
		return cloneRecord(record.pluginConfig);
	} catch {
		return null;
	}
}

/**
 * Persist the given plugin configuration into the unified settings file synchronously.
 *
 * The provided `pluginConfig` is stored as the `pluginConfig` section of the on-disk
 * settings payload (shallow-cloned before write). Callers are responsible for redacting
 * any sensitive tokens or secrets prior to calling; values are written verbatim.
 *
 * Concurrency: no cross-process locking is performed — concurrent writers may overwrite
 * each other. On Windows, write semantics and atomicity may differ from POSIX filesystems.
 *
 * @param pluginConfig - Key/value map representing plugin configuration to persist
 */
export function saveUnifiedPluginConfigSync(pluginConfig: JsonRecord): void {
	let lastError: unknown;
	for (let attempt = 0; attempt < SETTINGS_CONFLICT_RETRY_LIMIT; attempt += 1) {
		const snapshot = readSettingsSnapshotSync();
		const record = snapshot.record ?? {};
		record.pluginConfig = { ...pluginConfig };
		try {
			writeSettingsRecordSync(record, { expectedRevision: snapshot.revision });
			return;
		} catch (error) {
			lastError = error;
			if (!isConflictError(error) || attempt >= SETTINGS_CONFLICT_RETRY_LIMIT - 1) {
				throw error;
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Failed to save unified plugin config");
}

/**
 * Persist the provided plugin configuration to the unified settings file, replacing the `pluginConfig` section.
 *
 * Writes a shallow clone of `pluginConfig` into the on-disk settings payload. In-process calls are serialized
 * through an async queue to reduce lost-update races, but there is still no cross-process locking. On Windows,
 * filesystem atomicity and visibility semantics are platform-dependent; do not assume atomic merges across processes.
 * The settings file is written as plain JSON; redact or remove any sensitive tokens or secrets before calling.
 *
 * @param pluginConfig - The plugin configuration object to store (will be shallow-cloned)
 */
export async function saveUnifiedPluginConfig(pluginConfig: JsonRecord): Promise<void> {
	await enqueueSettingsWrite(async () => {
		let lastError: unknown;
		for (let attempt = 0; attempt < SETTINGS_CONFLICT_RETRY_LIMIT; attempt += 1) {
			const snapshot = await readSettingsSnapshotAsync();
			const record = snapshot.record ?? {};
			record.pluginConfig = { ...pluginConfig };
			try {
				await writeSettingsRecordAsync(record, { expectedRevision: snapshot.revision });
				return;
			} catch (error) {
				lastError = error;
				if (!isConflictError(error) || attempt >= SETTINGS_CONFLICT_RETRY_LIMIT - 1) {
					throw error;
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error("Failed to save unified plugin config");
	});
}

/**
 * Load the dashboard display settings section from the unified settings file.
 *
 * Concurrency: callers should avoid concurrent conflicting writes to the settings file; concurrent readers are allowed but may observe intermediate state if a writer is in progress.
 * Windows: note that filesystem semantics on Windows may cause exclusive locks or delayed visibility during writes.
 * Secrets: this API does not perform token or secret redaction; callers must remove or mask sensitive values before saving.
 *
 * @returns A cloned `JsonRecord` with the `dashboardDisplaySettings` section, or `null` if the settings file is missing or cannot be parsed.
 */
export async function loadUnifiedDashboardSettings(): Promise<JsonRecord | null> {
	try {
		const record = await readSettingsRecordAsync();
		if (!record) return null;
		return cloneRecord(record.dashboardDisplaySettings);
	} catch {
		return null;
	}
}

/**
 * Persist dashboard display settings into the unified settings file.
 *
 * Writes `dashboardDisplaySettings` into the shared settings.json (overwriting
 * any existing dashboardDisplaySettings section) and ensures the payload is
 * normalized with the file version. In-process async callers are serialized
 * through an internal queue (last writer still wins), but no cross-process lock
 * is provided. On Windows, path and directory creation follow Node's filesystem
 * semantics (case-insensitive paths, ACLs apply). Sensitive tokens or secrets
 * included in `dashboardDisplaySettings` are written verbatim — callers must
 * redact or omit secrets before calling.
 *
 * @param dashboardDisplaySettings - A plain JSON record describing dashboard display preferences; the object is shallow-copied before persisting.
 */
export async function saveUnifiedDashboardSettings(
	dashboardDisplaySettings: JsonRecord,
): Promise<void> {
	await enqueueSettingsWrite(async () => {
		let lastError: unknown;
		for (let attempt = 0; attempt < SETTINGS_CONFLICT_RETRY_LIMIT; attempt += 1) {
			const snapshot = await readSettingsSnapshotAsync();
			const record = snapshot.record ?? {};
			record.dashboardDisplaySettings = { ...dashboardDisplaySettings };
			try {
				await writeSettingsRecordAsync(record, { expectedRevision: snapshot.revision });
				return;
			} catch (error) {
				lastError = error;
				if (!isConflictError(error) || attempt >= SETTINGS_CONFLICT_RETRY_LIMIT - 1) {
					throw error;
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error("Failed to save unified dashboard settings");
	});
}
