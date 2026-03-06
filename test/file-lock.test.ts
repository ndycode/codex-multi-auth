import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { acquireFileLock } from "../lib/file-lock.js";

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

describe("file lock", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-file-lock-"));
	});

	afterEach(async () => {
		await removeWithRetry(tempDir, { recursive: true, force: true });
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

	it("does not let stale owner release remove a newer lock owner", async () => {
		const lockPath = join(tempDir, "stale-release.lock");
		const first = await acquireFileLock(lockPath, {
			maxAttempts: 3,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 120_000,
		});

		const staleDate = new Date(Date.now() - 10 * 60_000);
		await fs.utimes(lockPath, staleDate, staleDate);

		const second = await acquireFileLock(lockPath, {
			maxAttempts: 5,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 1_000,
		});

		await first.release();
		await expect(fs.readFile(lockPath, "utf8")).resolves.toContain("ownerId");

		await second.release();
		await expect(fs.access(lockPath)).rejects.toBeTruthy();
	});

	it("does not remove a replacement lock when ownership changes during release checks", async () => {
		const lockPath = join(tempDir, "release-race.lock");
		const first = await acquireFileLock(lockPath, {
			maxAttempts: 3,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 120_000,
		});

		const originalRaw = await fs.readFile(lockPath, "utf8");
		const replacementPayload = {
			pid: process.pid + 1,
			acquiredAt: Date.now() + 1,
			ownerId: "replacement-owner-id",
		};
		const replacementRaw = `${JSON.stringify(replacementPayload)}\n`;
		const realRead = fs.readFile.bind(fs);
		let lockReadCount = 0;
		const readSpy = vi.spyOn(fs, "readFile");
		readSpy.mockImplementation(async (...args) => {
			if (String(args[0]) === lockPath) {
				lockReadCount += 1;
				if (lockReadCount === 1) {
					return originalRaw;
				}
				if (lockReadCount === 2) {
					await fs.writeFile(lockPath, replacementRaw, "utf8");
					return replacementRaw;
				}
			}
			return realRead(...args);
		});

		try {
			await first.release();
			const persistedRaw = await fs.readFile(lockPath, "utf8");
			expect(persistedRaw).toBe(replacementRaw);
			expect(lockReadCount).toBeGreaterThanOrEqual(2);
		} finally {
			readSpy.mockRestore();
			await fs.unlink(lockPath).catch(() => {});
		}
	});

	it("closes descriptors and removes partial locks when initialization write fails", async () => {
		const lockPath = join(tempDir, "init-failure.lock");
		const closeMock = vi.fn(async () => {});
		const writeError = Object.assign(new Error("simulated write failure"), { code: "EIO" });
		const openSpy = vi.spyOn(fs, "open").mockResolvedValueOnce({
			writeFile: vi.fn(async () => {
				throw writeError;
			}),
			close: closeMock,
		} as unknown as Awaited<ReturnType<typeof fs.open>>);

		try {
			await expect(
				acquireFileLock(lockPath, {
					maxAttempts: 1,
					baseDelayMs: 1,
					maxDelayMs: 2,
					staleAfterMs: 10_000,
				}),
			).rejects.toThrow("simulated write failure");
			expect(closeMock).toHaveBeenCalledTimes(1);
			await expect(fs.access(lockPath)).rejects.toBeTruthy();
		} finally {
			openSpy.mockRestore();
		}
	});

	it("serializes concurrent writes from multiple processes under contention", async () => {
		const lockPath = join(tempDir, "contention.lock");
		const sharedFilePath = join(tempDir, "shared.txt");
		const workerScriptPath = join(tempDir, "lock-writer-worker.mjs");
		const sourceModulePath = join(process.cwd(), "lib", "file-lock.js");
		const distModulePath = join(process.cwd(), "dist", "lib", "file-lock.js");
		const fileLockModuleUrl = pathToFileURL(
			existsSync(sourceModulePath) ? sourceModulePath : distModulePath,
		).href;
		const workerCount = 6;
		const iterationsPerWorker = 10;
		await fs.writeFile(sharedFilePath, "", "utf8");
		await fs.writeFile(
			workerScriptPath,
			`import { promises as fs } from "node:fs";
const [moduleUrl, lockPath, sharedFilePath, workerId, iterationsRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);
const { acquireFileLock } = await import(moduleUrl);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
for (let i = 0; i < iterations; i += 1) {
  const lock = await acquireFileLock(lockPath, {
    maxAttempts: 1000,
    baseDelayMs: 1,
    maxDelayMs: 10,
    staleAfterMs: 60_000,
  });
  try {
    const existing = await fs.readFile(sharedFilePath, "utf8");
    await sleep(2);
    await fs.writeFile(sharedFilePath, existing + workerId + ":" + i + "\\n", "utf8");
  } finally {
    await lock.release();
  }
}
`,
			"utf8",
		);

		const runWorker = (workerId: number): Promise<void> =>
			new Promise((resolve, reject) => {
				const child = spawn(
					process.execPath,
					[
						workerScriptPath,
						fileLockModuleUrl,
						lockPath,
						sharedFilePath,
						String(workerId),
						String(iterationsPerWorker),
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let stderr = "";
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				child.on("error", reject);
				child.on("exit", (code) => {
					if (code === 0) {
						resolve();
						return;
					}
					reject(new Error(`worker ${workerId} exited with code ${code}: ${stderr}`));
				});
			});

		await Promise.all(
			Array.from({ length: workerCount }, (_, workerId) => runWorker(workerId)),
		);

		const lines = (await fs.readFile(sharedFilePath, "utf8"))
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(workerCount * iterationsPerWorker);
		expect(new Set(lines).size).toBe(lines.length);
	});
});
