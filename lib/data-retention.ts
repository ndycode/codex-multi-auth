import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexCacheDir, getCodexLogDir, getCodexMultiAuthDir } from "./runtime-paths.js";

export interface RetentionPolicy {
	logDays: number;
	cacheDays: number;
	flaggedDays: number;
	quotaCacheDays: number;
	dlqDays: number;
}

const DEFAULT_POLICY: RetentionPolicy = {
	logDays: 14,
	cacheDays: 30,
	flaggedDays: 30,
	quotaCacheDays: 14,
	dlqDays: 30,
};
const RETRYABLE_DIRECTORY_CLEANUP_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
const DIRECTORY_CLEANUP_MAX_ATTEMPTS = 4;
const DIRECTORY_CLEANUP_BASE_DELAY_MS = 10;
const RETRYABLE_FILE_UNLINK_CODES = new Set(["EBUSY", "EPERM"]);
const FILE_UNLINK_MAX_ATTEMPTS = 4;
const FILE_UNLINK_BASE_DELAY_MS = 25;

function parseEnvDays(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(1, parsed);
}

export function getRetentionPolicyFromEnv(): RetentionPolicy {
	return {
		logDays: parseEnvDays("CODEX_AUTH_RETENTION_LOG_DAYS", DEFAULT_POLICY.logDays),
		cacheDays: parseEnvDays("CODEX_AUTH_RETENTION_CACHE_DAYS", DEFAULT_POLICY.cacheDays),
		flaggedDays: parseEnvDays("CODEX_AUTH_RETENTION_FLAGGED_DAYS", DEFAULT_POLICY.flaggedDays),
		quotaCacheDays: parseEnvDays(
			"CODEX_AUTH_RETENTION_QUOTA_CACHE_DAYS",
			DEFAULT_POLICY.quotaCacheDays,
		),
		dlqDays: parseEnvDays("CODEX_AUTH_RETENTION_DLQ_DAYS", DEFAULT_POLICY.dlqDays),
	};
}

async function removeEmptyDirectoryWithRetry(path: string): Promise<void> {
	for (let attempt = 0; attempt < DIRECTORY_CLEANUP_MAX_ATTEMPTS; attempt += 1) {
		try {
			const childEntries = await fs.readdir(path);
			if (childEntries.length !== 0) return;
			await fs.rmdir(path);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_DIRECTORY_CLEANUP_CODES.has(code)) {
				throw error;
			}
			if (attempt >= DIRECTORY_CLEANUP_MAX_ATTEMPTS - 1) {
				logWarn("Data retention directory cleanup retries exhausted", {
					path,
					code,
				});
				return;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, DIRECTORY_CLEANUP_BASE_DELAY_MS * 2 ** attempt),
			);
		}
	}
}

async function unlinkFileWithRetry(path: string): Promise<boolean> {
	for (let attempt = 0; attempt < FILE_UNLINK_MAX_ATTEMPTS; attempt += 1) {
		try {
			await fs.unlink(path);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return false;
			if (!code || !RETRYABLE_FILE_UNLINK_CODES.has(code) || attempt === FILE_UNLINK_MAX_ATTEMPTS - 1) {
				throw error;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, FILE_UNLINK_BASE_DELAY_MS * 2 ** attempt),
			);
		}
	}
	return false;
}

async function pruneDirectoryByAge(path: string, maxAgeMs: number): Promise<number> {
	let removed = 0;
	let entries: Dirent<string>[] = [];
	try {
		entries = await fs.readdir(path, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return 0;
		throw error;
	}

	const now = Date.now();
	for (const entry of entries) {
		const fullPath = join(path, entry.name);
		try {
			if (entry.isDirectory()) {
				removed += await pruneDirectoryByAge(fullPath, maxAgeMs);
				await removeEmptyDirectoryWithRetry(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			const stats = await fs.stat(fullPath);
			if (now - stats.mtimeMs <= maxAgeMs) continue;
			if (await unlinkFileWithRetry(fullPath)) {
				removed += 1;
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				continue;
			}
			throw error;
		}
	}
	return removed;
}

async function pruneSingleFile(path: string, maxAgeMs: number): Promise<boolean> {
	try {
		const stats = await fs.stat(path);
		if (Date.now() - stats.mtimeMs <= maxAgeMs) {
			return false;
		}
		return await unlinkFileWithRetry(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		throw error;
	}
}

export async function enforceDataRetention(
	policy: RetentionPolicy = getRetentionPolicyFromEnv(),
): Promise<{ removedLogs: number; removedCacheFiles: number; removedStateFiles: number }> {
	const removedLogs = await pruneDirectoryByAge(getCodexLogDir(), policy.logDays * 24 * 60 * 60_000);
	const removedCacheFiles = await pruneDirectoryByAge(
		getCodexCacheDir(),
		policy.cacheDays * 24 * 60 * 60_000,
	);
	const root = getCodexMultiAuthDir();
	const removedFlagged = await pruneSingleFile(
		join(root, "openai-codex-flagged-accounts.json"),
		policy.flaggedDays * 24 * 60 * 60_000,
	);
	const removedQuota = await pruneSingleFile(
		join(root, "quota-cache.json"),
		policy.quotaCacheDays * 24 * 60 * 60_000,
	);
	const removedDlq = await pruneSingleFile(
		join(root, "background-job-dlq.jsonl"),
		policy.dlqDays * 24 * 60 * 60_000,
	);

	return {
		removedLogs,
		removedCacheFiles,
		removedStateFiles: (removedFlagged ? 1 : 0) + (removedQuota ? 1 : 0) + (removedDlq ? 1 : 0),
	};
}
