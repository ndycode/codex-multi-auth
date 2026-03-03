import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFileLock } from "../lib/file-lock.js";

describe("file lock", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-file-lock-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("blocks concurrent lock acquisition until released", async () => {
		const lockPath = join(tempDir, "settings.lock");
		const first = await acquireFileLock(lockPath, {
			maxAttempts: 5,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 10_000,
		});

		await expect(
			acquireFileLock(lockPath, {
				maxAttempts: 2,
				baseDelayMs: 1,
				maxDelayMs: 2,
				staleAfterMs: 10_000,
			}),
		).rejects.toBeTruthy();

		await first.release();
		const second = await acquireFileLock(lockPath, {
			maxAttempts: 2,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 10_000,
		});
		await second.release();
	});

	it("evicts stale lock files", async () => {
		const lockPath = join(tempDir, "quota.lock");
		await fs.writeFile(lockPath, "stale", "utf8");
		const staleDate = new Date(Date.now() - 60_000);
		await fs.utimes(lockPath, staleDate, staleDate);

		const lock = await acquireFileLock(lockPath, {
			maxAttempts: 3,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 1_000,
		});
		await lock.release();
	});
});