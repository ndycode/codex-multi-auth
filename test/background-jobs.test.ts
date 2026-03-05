import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("background jobs", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-bg-jobs-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("retries and succeeds before exhausting attempts", async () => {
		const { runBackgroundJobWithRetry, getBackgroundJobDlqPath } =
			await import("../lib/background-jobs.js");
		let attempts = 0;
		const result = await runBackgroundJobWithRetry({
			name: "test.retry-success",
			task: async () => {
				attempts += 1;
				if (attempts < 3) {
					const error = new Error("busy") as NodeJS.ErrnoException;
					error.code = "EBUSY";
					throw error;
				}
				return "ok";
			},
			maxAttempts: 4,
			baseDelayMs: 1,
			maxDelayMs: 2,
		});

		expect(result).toBe("ok");
		expect(attempts).toBe(3);
		await expect(fs.stat(getBackgroundJobDlqPath())).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("writes a redacted dead-letter entry after retry exhaustion", async () => {
		const { runBackgroundJobWithRetry, getBackgroundJobDlqPath } =
			await import("../lib/background-jobs.js");
		await expect(
			runBackgroundJobWithRetry({
				name: "test.retry-fail",
				task: async () => {
					const error = new Error("still locked") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				},
				context: {
					email: "person@example.com",
					accessToken: "sensitive-token",
					note: "keep-visible",
				},
				maxAttempts: 2,
				baseDelayMs: 1,
				maxDelayMs: 2,
			}),
		).rejects.toThrow("still locked");

		const dlqContent = await fs.readFile(getBackgroundJobDlqPath(), "utf8");
		const lines = dlqContent.trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0] ?? "{}") as {
			job: string;
			attempts: number;
			context?: Record<string, unknown>;
		};
		expect(entry.job).toBe("test.retry-fail");
		expect(entry.attempts).toBe(2);
		expect(entry.context).toEqual({
			email: "***REDACTED***",
			accessToken: "***REDACTED***",
			note: "keep-visible",
		});
	});

	it("records actual attempts when retry predicate stops early", async () => {
		const { runBackgroundJobWithRetry, getBackgroundJobDlqPath } =
			await import("../lib/background-jobs.js");
		let attempts = 0;
		await expect(
			runBackgroundJobWithRetry({
				name: "test.retry-stop-early",
				task: async () => {
					attempts += 1;
					throw new Error("fatal");
				},
				retryable: () => false,
				maxAttempts: 5,
				baseDelayMs: 1,
				maxDelayMs: 2,
			}),
		).rejects.toThrow("fatal");

		expect(attempts).toBe(1);
		const dlqContent = await fs.readFile(getBackgroundJobDlqPath(), "utf8");
		const entry = JSON.parse(dlqContent.trim()) as { attempts: number };
		expect(entry.attempts).toBe(1);
	});

	it("serializes concurrent DLQ writes via file lock", async () => {
		const { runBackgroundJobWithRetry, getBackgroundJobDlqPath } =
			await import("../lib/background-jobs.js");
		const jobCount = 5;
		const jobs = Array.from({ length: jobCount }, (_, index) =>
			runBackgroundJobWithRetry({
				name: `test.concurrent-${index}`,
				task: async () => {
					const error = new Error("locked") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				},
				maxAttempts: 1,
				baseDelayMs: 1,
				maxDelayMs: 1,
			}).catch(() => {}),
		);
		await Promise.all(jobs);

		const dlqContent = await fs.readFile(getBackgroundJobDlqPath(), "utf8");
		const lines = dlqContent.trim().split("\n");
		expect(lines).toHaveLength(jobCount);
	});
});
