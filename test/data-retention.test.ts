import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RetentionPolicy } from "../lib/data-retention.js";

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

async function removeWithRetry(
	targetPath: string,
	options: { recursive?: boolean; force?: boolean },
): Promise<void> {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			await fs.rm(targetPath, options);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (!code || !RETRYABLE_REMOVE_CODES.has(code) || attempt === 5) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
		}
	}
}

describe("data retention", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-retention-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("prunes stale log/cache/state files", async () => {
		const { enforceDataRetention } = await import("../lib/data-retention.js");
		const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);

		const logsDir = join(tempDir, "logs");
		const cacheDir = join(tempDir, "cache");
		const nestedLogDir = join(logsDir, "nested");
		await fs.mkdir(nestedLogDir, { recursive: true });
		await fs.mkdir(cacheDir, { recursive: true });

		const oldLog = join(nestedLogDir, "old.log");
		const freshLog = join(logsDir, "fresh.log");
		const oldCache = join(cacheDir, "old.cache");
		const freshCache = join(cacheDir, "fresh.cache");
		const flagged = join(tempDir, "openai-codex-flagged-accounts.json");
		const quota = join(tempDir, "quota-cache.json");
		const dlq = join(tempDir, "background-job-dlq.jsonl");

		await fs.writeFile(oldLog, "old", "utf8");
		await fs.writeFile(freshLog, "fresh", "utf8");
		await fs.writeFile(oldCache, "old", "utf8");
		await fs.writeFile(freshCache, "fresh", "utf8");
		await fs.writeFile(flagged, "{}", "utf8");
		await fs.writeFile(quota, "{}", "utf8");
		await fs.writeFile(dlq, "{}", "utf8");

		await fs.utimes(oldLog, oldDate, oldDate);
		await fs.utimes(oldCache, oldDate, oldDate);
		await fs.utimes(flagged, oldDate, oldDate);
		await fs.utimes(quota, oldDate, oldDate);
		await fs.utimes(dlq, oldDate, oldDate);

		const policy: RetentionPolicy = {
			logDays: 1,
			cacheDays: 1,
			flaggedDays: 1,
			quotaCacheDays: 1,
			dlqDays: 1,
		};
		const result = await enforceDataRetention(policy);

		expect(result.removedLogs).toBeGreaterThanOrEqual(1);
		expect(result.removedCacheFiles).toBeGreaterThanOrEqual(1);
		expect(result.removedStateFiles).toBe(3);
		await expect(fs.stat(oldLog)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(oldCache)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(flagged)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(quota)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(dlq)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(freshLog, "utf8")).toBe("fresh");
		expect(await fs.readFile(freshCache, "utf8")).toBe("fresh");
	});

	it("retries transient EBUSY when pruning single state files", async () => {
		const { enforceDataRetention } = await import("../lib/data-retention.js");
		const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);
		const flagged = join(tempDir, "openai-codex-flagged-accounts.json");
		await fs.writeFile(flagged, "{}", "utf8");
		await fs.utimes(flagged, oldDate, oldDate);

		const realUnlink = fs.unlink.bind(fs);
		const unlinkSpy = vi.spyOn(fs, "unlink");
		let attempts = 0;
		unlinkSpy.mockImplementation(async (path) => {
			if (String(path) === flagged) {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EBUSY";
					throw error;
				}
			}
			return realUnlink(path);
		});

		try {
			const result = await enforceDataRetention({
				logDays: 1,
				cacheDays: 1,
				flaggedDays: 1,
				quotaCacheDays: 1,
				dlqDays: 1,
			});
			expect(result.removedStateFiles).toBe(1);
			expect(attempts).toBe(3);
			await expect(fs.stat(flagged)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			unlinkSpy.mockRestore();
		}
	});

	it("surfaces non-ENOENT prune errors", async () => {
		const { enforceDataRetention } = await import("../lib/data-retention.js");
		const logsDir = join(tempDir, "logs");
		await fs.mkdir(logsDir, { recursive: true });
		const staleLog = join(logsDir, "stale.log");
		const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);
		await fs.writeFile(staleLog, "old", "utf8");
		await fs.utimes(staleLog, oldDate, oldDate);

		const statSpy = vi.spyOn(fs, "stat");
		const realStat = fs.stat.bind(fs);
		statSpy.mockImplementation(async (path) => {
			if (String(path) === staleLog) {
				const error = new Error("denied") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			}
			return realStat(path);
		});

		try {
			await expect(
				enforceDataRetention({
					logDays: 1,
					cacheDays: 1,
					flaggedDays: 1,
					quotaCacheDays: 1,
					dlqDays: 1,
				}),
			).rejects.toMatchObject({ code: "EACCES" });
		} finally {
			statSpy.mockRestore();
		}
	});

	it("retries transient EBUSY during directory entry retention pruning", async () => {
		const { enforceDataRetention } = await import("../lib/data-retention.js");
		const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);
		const logsDir = join(tempDir, "logs");
		const nestedDir = join(logsDir, "nested");
		const staleLog = join(nestedDir, "stale.log");

		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(staleLog, "old", "utf8");
		await fs.utimes(staleLog, oldDate, oldDate);

		const originalStat = fs.stat.bind(fs);
		const statSpy = vi.spyOn(fs, "stat");
		let statBusyInjected = false;
		statSpy.mockImplementation(async (path, options) => {
			if (!statBusyInjected && path === staleLog) {
				statBusyInjected = true;
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			return originalStat(path, options as { bigint?: boolean });
		});

		const originalRmdir = fs.rmdir.bind(fs);
		const rmdirSpy = vi.spyOn(fs, "rmdir");
		let rmdirBusyInjected = false;
		rmdirSpy.mockImplementation(async (path) => {
			if (!rmdirBusyInjected && path === nestedDir) {
				rmdirBusyInjected = true;
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			return originalRmdir(path);
		});

		try {
			const policy: RetentionPolicy = {
				logDays: 1,
				cacheDays: 90,
				flaggedDays: 90,
				quotaCacheDays: 90,
				dlqDays: 90,
			};
			const result = await enforceDataRetention(policy);
			expect(result.removedLogs).toBe(1);
			expect(statBusyInjected).toBe(true);
			expect(rmdirBusyInjected).toBe(true);
			await expect(fs.stat(staleLog)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(nestedDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			statSpy.mockRestore();
			rmdirSpy.mockRestore();
		}
	});
});
