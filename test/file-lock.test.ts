import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
		).rejects.toMatchObject({ code: "EEXIST" });

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

	it("does not unlink a newer lock when a stale owner releases late", async () => {
		const lockPath = join(tempDir, "late-release.lock");
		const first = await acquireFileLock(lockPath, {
			maxAttempts: 3,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 1_000,
		});
		const staleDate = new Date(Date.now() - 120_000);
		await fs.utimes(lockPath, staleDate, staleDate);

		const second = await acquireFileLock(lockPath, {
			maxAttempts: 10,
			baseDelayMs: 1,
			maxDelayMs: 4,
			staleAfterMs: 1_000,
		});

		await first.release();

		await expect(
			acquireFileLock(lockPath, {
				maxAttempts: 2,
				baseDelayMs: 1,
				maxDelayMs: 2,
				staleAfterMs: 10_000,
			}),
		).rejects.toMatchObject({ code: "EEXIST" });

		await second.release();
		const third = await acquireFileLock(lockPath, {
			maxAttempts: 3,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 10_000,
		});
		await third.release();
	});

	it("serializes concurrent writes from multiple processes under contention", async () => {
		const lockPath = join(tempDir, "contention.lock");
		const sharedFilePath = join(tempDir, "shared.txt");
		const workerScriptPath = join(tempDir, "lock-writer-worker.mjs");
		const workerCount = 6;
		const iterationsPerWorker = 10;
		await fs.writeFile(sharedFilePath, "", "utf8");
		await fs.writeFile(
			workerScriptPath,
			`import { promises as fs } from "node:fs";
const [lockPath, sharedFilePath, workerId, iterationsRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);
const RETRYABLE = new Set(["EEXIST", "EBUSY", "EPERM"]);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function acquireLock(path) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      const handle = await fs.open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid), "utf8");
      await handle.close();
      return async () => {
        try {
          await fs.unlink(path);
        } catch (error) {
          if (error && error.code !== "ENOENT") {
            throw error;
          }
        }
      };
    } catch (error) {
      if (!error || !RETRYABLE.has(error.code)) {
        throw error;
      }
      await sleep(2);
    }
  }
  throw new Error("Failed to acquire lock under contention");
}
for (let i = 0; i < iterations; i += 1) {
  const release = await acquireLock(lockPath);
  try {
    const existing = await fs.readFile(sharedFilePath, "utf8");
    await sleep(2);
    await fs.writeFile(sharedFilePath, existing + workerId + ":" + i + "\\n", "utf8");
  } finally {
    await release();
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
