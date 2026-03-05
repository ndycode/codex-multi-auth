import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
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
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 50;

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

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
				const childEntries = await fs.readdir(fullPath);
				if (childEntries.length === 0) {
					await fs.rmdir(fullPath);
				}
				continue;
			}
			if (!entry.isFile()) continue;
			const stats = await fs.stat(fullPath);
			if (now - stats.mtimeMs <= maxAgeMs) continue;
			await fs.unlink(fullPath);
			removed += 1;
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
	let lastError: unknown;
	for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
		try {
			const stats = await fs.stat(path);
			if (Date.now() - stats.mtimeMs <= maxAgeMs) {
				return false;
			}
			await fs.unlink(path);
			return true;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return false;
			if (!isRetryableFsError(error) || attempt >= RETRY_MAX_ATTEMPTS) {
				throw error;
			}
			await sleep(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Retention prune retry exhausted");
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
