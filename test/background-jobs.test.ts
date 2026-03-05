import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
		await removeWithRetry(tempDir, { recursive: true, force: true });
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

	it("writes dead-letter after exhausting retries on 429 errors", async () => {
		const { runBackgroundJobWithRetry, getBackgroundJobDlqPath } =
			await import("../lib/background-jobs.js");
		let attempts = 0;
		await expect(
			runBackgroundJobWithRetry({
				name: "test.retry-429-fail",
				task: async () => {
					attempts += 1;
					const error = Object.assign(new Error("rate limited"), { statusCode: 429 });
					throw error;
				},
				maxAttempts: 3,
				baseDelayMs: 1,
				maxDelayMs: 2,
			}),
		).rejects.toThrow("rate limited");
		expect(attempts).toBe(3);

		const content = await fs.readFile(getBackgroundJobDlqPath(), "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0] ?? "{}") as { job?: string; attempts?: number };
		expect(entry.job).toBe("test.retry-429-fail");
		expect(entry.attempts).toBe(3);
	});

	it("adds jitter to retry delays to avoid synchronized retries", async () => {
		vi.resetModules();
		const sleepMock = vi.fn(async () => {});
		vi.doMock("../lib/utils.js", () => ({
			sleep: sleepMock,
		}));
		const randomSpy = vi.spyOn(Math, "random");
		randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(1);

		try {
			const { runBackgroundJobWithRetry } = await import("../lib/background-jobs.js");
			let attempts = 0;
			await expect(
				runBackgroundJobWithRetry({
					name: "test.retry-jitter",
					task: async () => {
						attempts += 1;
						const error = new Error("busy") as NodeJS.ErrnoException;
						error.code = "EBUSY";
						throw error;
					},
					maxAttempts: 3,
					baseDelayMs: 100,
					maxDelayMs: 100,
				}),
			).rejects.toThrow("busy");
			expect(attempts).toBe(3);
			expect(sleepMock.mock.calls.map(([ms]) => ms)).toEqual([80, 120]);
		} finally {
			randomSpy.mockRestore();
			vi.doUnmock("../lib/utils.js");
		}
	});

	it("records actual attempts for non-retryable failures", async () => {
		const { runBackgroundJobWithRetry, getBackgroundJobDlqPath } =
			await import("../lib/background-jobs.js");
		let attempts = 0;
		await expect(
			runBackgroundJobWithRetry({
				name: "test.non-retryable",
				task: async () => {
					attempts += 1;
					const error = Object.assign(new Error("bad request"), { statusCode: 400 });
					throw error;
				},
				maxAttempts: 5,
				retryable: () => false,
			}),
		).rejects.toThrow("bad request");
		expect(attempts).toBe(1);

		const content = await fs.readFile(getBackgroundJobDlqPath(), "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0] ?? "{}") as { job?: string; attempts?: number };
		expect(entry.job).toBe("test.non-retryable");
		expect(entry.attempts).toBe(1);
	});

	it("redacts sensitive error text in dead-letter entries and warning logs", async () => {
		vi.resetModules();
		const warnMock = vi.fn();
		vi.doMock("../lib/logger.js", () => ({
			logWarn: warnMock,
		}));
		try {
			const { runBackgroundJobWithRetry, getBackgroundJobDlqPath } =
				await import("../lib/background-jobs.js");
			await expect(
				runBackgroundJobWithRetry({
					name: "test.retry-sensitive-error",
					task: async () => {
						throw new Error(
							"network failed for person@example.com Bearer sk_test+/123== refresh_token=rt+/456==",
						);
					},
					maxAttempts: 1,
				}),
			).rejects.toThrow("person@example.com");

			const content = await fs.readFile(getBackgroundJobDlqPath(), "utf8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0] ?? "{}") as { error?: string };
			expect(entry.error).toContain("***REDACTED***");
			expect(entry.error).not.toContain("person@example.com");
			expect(entry.error).not.toContain("sk_test+/123==");
			expect(entry.error).not.toContain("rt+/456==");

			const warningPayloads = warnMock.mock.calls.map((args) => args[1]);
			const serializedWarnings = JSON.stringify(warningPayloads);
			expect(serializedWarnings).not.toContain("person@example.com");
			expect(serializedWarnings).not.toContain("sk_test+/123==");
			expect(serializedWarnings).not.toContain("rt+/456==");
		} finally {
			vi.doUnmock("../lib/logger.js");
		}
	});
});
