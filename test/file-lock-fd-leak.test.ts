import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("file-lock descriptor safety", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("node:fs");
		vi.restoreAllMocks();
	});

	it("closes async file handles when metadata write fails", async () => {
		const close = vi.fn(async () => {});
		const writeFile = vi.fn(async () => {
			throw new Error("disk full");
		});
		vi.doMock("node:fs", () => ({
			promises: {
				open: vi.fn(async () => ({ writeFile, close })),
				stat: vi.fn(),
				unlink: vi.fn(),
				readFile: vi.fn(),
			},
			openSync: vi.fn(),
			writeFileSync: vi.fn(),
			closeSync: vi.fn(),
			readFileSync: vi.fn(),
			unlinkSync: vi.fn(),
			statSync: vi.fn(),
		}));

		const { acquireFileLock } = await import("../lib/file-lock.js");
		await expect(
			acquireFileLock("/tmp/mock.lock", {
				maxAttempts: 1,
				baseDelayMs: 1,
				maxDelayMs: 2,
				staleAfterMs: 1_000,
			}),
		).rejects.toThrow("disk full");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes sync file descriptors when metadata write fails", async () => {
		const closeSync = vi.fn();
		vi.doMock("node:fs", () => ({
			promises: {
				open: vi.fn(),
				stat: vi.fn(),
				unlink: vi.fn(),
				readFile: vi.fn(),
			},
			openSync: vi.fn(() => 42),
			writeFileSync: vi.fn(() => {
				throw new Error("write failed");
			}),
			closeSync,
			readFileSync: vi.fn(),
			unlinkSync: vi.fn(),
			statSync: vi.fn(),
		}));

		const { acquireFileLockSync } = await import("../lib/file-lock.js");
		expect(() =>
			acquireFileLockSync("/tmp/mock.lock", {
				maxAttempts: 1,
				baseDelayMs: 1,
				maxDelayMs: 2,
				staleAfterMs: 1_000,
			}),
		).toThrow("write failed");
		expect(closeSync).toHaveBeenCalledTimes(1);
	});
});
