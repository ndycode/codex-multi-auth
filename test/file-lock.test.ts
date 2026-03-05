import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("serializes concurrent writes from multiple processes under contention", async () => {
		const lockPath = join(tempDir, "contention.lock");
		const sharedFilePath = join(tempDir, "shared.txt");
		const workerScriptPath = join(tempDir, "lock-writer-worker.mjs");
		const transpiledModulePath = join(tempDir, "file-lock-worker-module.mjs");
		const ts = await import("typescript");
		const sourcePath = join(process.cwd(), "lib", "file-lock.ts");
		const source = await fs.readFile(sourcePath, "utf8");
		const transpiled = ts.transpileModule(source, {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
			},
		}).outputText;
		await fs.writeFile(transpiledModulePath, transpiled, "utf8");
		const moduleUrl = pathToFileURL(transpiledModulePath).href;
		const workerCount = 6;
		const iterationsPerWorker = 10;
		await fs.writeFile(sharedFilePath, "", "utf8");
		await fs.writeFile(
			workerScriptPath,
			`import { promises as fs } from "node:fs";
const [moduleUrl, lockPath, sharedFilePath, workerId, iterationsRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);
const { acquireFileLock } = await import(moduleUrl);
for (let i = 0; i < iterations; i += 1) {
  const lock = await acquireFileLock(lockPath, {
    maxAttempts: 500,
    baseDelayMs: 1,
    maxDelayMs: 8,
    staleAfterMs: 10_000,
  });
  try {
    const existing = await fs.readFile(sharedFilePath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 2));
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
						moduleUrl,
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

	it("allows release retries after transient unlink failures", async () => {
		const lockPath = join(tempDir, "release-retry.lock");
		const lock = await acquireFileLock(lockPath, {
			maxAttempts: 3,
			baseDelayMs: 1,
			maxDelayMs: 2,
			staleAfterMs: 10_000,
		});

		const originalUnlink = fs.unlink.bind(fs);
		const unlinkSpy = vi.spyOn(fs, "unlink");
		let injectedBusy = false;
		unlinkSpy.mockImplementation(async (path) => {
			if (!injectedBusy && path === lockPath) {
				injectedBusy = true;
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = "EBUSY";
				throw error;
			}
			return originalUnlink(path);
		});

		try {
			await expect(lock.release()).rejects.toMatchObject({ code: "EBUSY" });
			await expect(lock.release()).resolves.toBeUndefined();
			expect(injectedBusy).toBe(true);
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			unlinkSpy.mockRestore();
		}
	});

	it("cleans up lock files when metadata write fails", async () => {
		const lockPath = join(tempDir, "incomplete.lock");
		const originalOpen = fs.open.bind(fs);
		type OpenFn = typeof fs.open;
		type OpenHandle = Awaited<ReturnType<OpenFn>>;
		const openSpy = vi.spyOn(fs, "open");
		const mockOpen: OpenFn = (async (...args: Parameters<OpenFn>) => {
			const [path] = args;
			if (String(path) === lockPath) {
				await fs.writeFile(lockPath, "partial", "utf8");
				return {
					writeFile: async () => {
						const error = new Error("metadata write failed") as NodeJS.ErrnoException;
						error.code = "EIO";
						throw error;
					},
					close: async () => {},
				} as unknown as OpenHandle;
			}
			return originalOpen(...args);
		}) as OpenFn;
		openSpy.mockImplementation(mockOpen);

		try {
			await expect(
				acquireFileLock(lockPath, {
					maxAttempts: 1,
					baseDelayMs: 1,
					maxDelayMs: 2,
					staleAfterMs: 10_000,
				}),
			).rejects.toThrow("metadata write failed");
			await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			openSpy.mockRestore();
		}
	});
});
