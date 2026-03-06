import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RetentionPolicy } from "../lib/data-retention.js";
import { removeWithRetry } from "./helpers/fs-retry.js";

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

	it("acquires quota cache lock before pruning stale quota cache file", async () => {
		const release = vi.fn(async () => {});
		const acquireFileLockMock = vi.fn(async () => ({
			path: join(tempDir, "quota-cache.json.lock"),
			release,
		}));
		vi.doMock("../lib/file-lock.js", async () => {
			const actual = await vi.importActual<typeof import("../lib/file-lock.js")>(
				"../lib/file-lock.js",
			);
			return {
				...actual,
				acquireFileLock: acquireFileLockMock,
			};
		});

		try {
			const { enforceDataRetention } = await import("../lib/data-retention.js");
			const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);
			const quota = join(tempDir, "quota-cache.json");
			await fs.writeFile(quota, "{}", "utf8");
			await fs.utimes(quota, oldDate, oldDate);

			const result = await enforceDataRetention({
				logDays: 1,
				cacheDays: 1,
				flaggedDays: 1,
				quotaCacheDays: 1,
				dlqDays: 1,
			});

			expect(acquireFileLockMock).toHaveBeenCalledTimes(1);
			expect(acquireFileLockMock).toHaveBeenCalledWith(join(tempDir, "quota-cache.json.lock"), {
				maxAttempts: 80,
				baseDelayMs: 15,
				maxDelayMs: 800,
				staleAfterMs: 120_000,
			});
			expect(release).toHaveBeenCalledTimes(1);
			expect(result.removedStateFiles).toBe(1);
			await expect(fs.stat(quota)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			vi.doUnmock("../lib/file-lock.js");
		}
	});

	it("tolerates transient EBUSY while pruning empty directories", async () => {
		const { enforceDataRetention } = await import("../lib/data-retention.js");
		const nestedLogDir = join(tempDir, "logs", "nested");
		await fs.mkdir(nestedLogDir, { recursive: true });
		const oldLog = join(nestedLogDir, "old.log");
		const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);
		await fs.writeFile(oldLog, "old", "utf8");
		await fs.utimes(oldLog, oldDate, oldDate);

		const originalRmdir = fs.rmdir.bind(fs);
		const rmdirSpy = vi.spyOn(fs, "rmdir");
		let busyCount = 0;
		rmdirSpy.mockImplementation(async (...args) => {
			const path = args[0];
			if (typeof path === "string" && path.endsWith("nested") && busyCount === 0) {
				busyCount += 1;
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			return originalRmdir(...(args as Parameters<typeof fs.rmdir>));
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
			).resolves.toEqual(
				expect.objectContaining({
					removedLogs: 1,
				}),
			);
			expect(busyCount).toBe(1);
		} finally {
			rmdirSpy.mockRestore();
		}
	});

	it.each(["EPERM", "EBUSY"] as const)(
		"retries transient %s errors while unlinking stale files",
		async (errorCode) => {
			const { enforceDataRetention } = await import("../lib/data-retention.js");
			const logsDir = join(tempDir, "logs");
			await fs.mkdir(logsDir, { recursive: true });
			const oldLog = join(logsDir, "old.log");
			const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);
			await fs.writeFile(oldLog, "old", "utf8");
			await fs.utimes(oldLog, oldDate, oldDate);

			const originalUnlink = fs.unlink.bind(fs);
			let oldLogAttempts = 0;
			const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
				const path = args[0];
				if (typeof path === "string" && path.endsWith("old.log")) {
					if (oldLogAttempts === 0) {
						oldLogAttempts += 1;
						const error = new Error("locked") as NodeJS.ErrnoException;
						error.code = errorCode;
						throw error;
					}
					oldLogAttempts += 1;
				}
				return originalUnlink(...(args as Parameters<typeof fs.unlink>));
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
				).resolves.toEqual(
					expect.objectContaining({
						removedLogs: 1,
					}),
				);
			} finally {
				unlinkSpy.mockRestore();
			}

			expect(oldLogAttempts).toBe(2);
			await expect(fs.stat(oldLog)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.each(["EPERM", "EBUSY"] as const)(
		"rethrows non-ENOENT errors during recursive prune (%s)",
		async (errorCode) => {
			const { enforceDataRetention } = await import("../lib/data-retention.js");
			const logsDir = join(tempDir, "logs");
			await fs.mkdir(logsDir, { recursive: true });
			const lockedLog = join(logsDir, "locked.log");
			const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60_000);
			await fs.writeFile(lockedLog, "locked", "utf8");
			await fs.utimes(lockedLog, oldDate, oldDate);

			const unlinkSpy = vi.spyOn(fs, "unlink");
			const originalUnlink = fs.unlink.bind(fs);
			unlinkSpy.mockImplementation(async (...args) => {
				const path = args[0];
				if (typeof path === "string" && path.endsWith("locked.log")) {
					const error = new Error("locked") as NodeJS.ErrnoException;
					error.code = errorCode;
					throw error;
				}
				return originalUnlink(...(args as Parameters<typeof fs.unlink>));
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
				).rejects.toMatchObject({ code: errorCode });
			} finally {
				unlinkSpy.mockRestore();
			}
		},
	);
});
