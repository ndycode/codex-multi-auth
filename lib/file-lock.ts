import { openSync, writeFileSync, closeSync, unlinkSync, statSync, readFileSync, promises as fs } from "node:fs";

export interface FileLockOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	staleAfterMs?: number;
}

export interface FileLockHandle {
	path: string;
	release: () => Promise<void>;
}

export interface FileLockSyncHandle {
	path: string;
	release: () => void;
}

const DEFAULT_MAX_ATTEMPTS = 60;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const RETRYABLE_CODES = new Set(["EEXIST", "EBUSY", "EPERM"]);

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		return code === "EPERM";
	}
}

function parseLockPid(rawLock: string): number | undefined {
	const firstLine = rawLock.split(/\r?\n/, 1)[0] ?? "";
	if (!firstLine) return undefined;
	try {
		const parsed = JSON.parse(firstLine) as { pid?: unknown };
		return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
): number {
	const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 8));
	const jitter = Math.floor(backoff * 0.15 * Math.random());
	return Math.max(baseDelayMs, backoff - jitter);
}

async function removeIfStale(path: string, staleAfterMs: number): Promise<boolean> {
	try {
		const stats = await fs.stat(path);
		if (Date.now() - stats.mtimeMs <= staleAfterMs) {
			return false;
		}
		try {
			const pid = parseLockPid(await fs.readFile(path, "utf8"));
			if (pid !== undefined && isPidAlive(pid)) {
				return false;
			}
		} catch {
			// If metadata can't be read, fall back to age-only cleanup.
		}
		await fs.unlink(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return true;
		}
		return false;
	}
}

function throwOriginalOrCleanupError(
	originalError: unknown,
	cleanupError: unknown,
): never {
	if (originalError instanceof Error) {
		throw originalError;
	}
	if (cleanupError instanceof Error) {
		throw cleanupError;
	}
	throw new Error(String(originalError ?? cleanupError));
}

async function cleanupIncompleteLockFile(path: string, originalError?: unknown): Promise<void> {
	try {
		await fs.unlink(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			if (originalError !== undefined) {
				throwOriginalOrCleanupError(originalError, error);
			}
			throw error;
		}
	}
}

export async function acquireFileLock(
	path: string,
	options: FileLockOptions = {},
): Promise<FileLockHandle> {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
	const baseDelayMs = Math.max(5, Math.floor(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS));
	const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
	const staleAfterMs = Math.max(1_000, Math.floor(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			const handle = await fs.open(path, "wx", 0o600);
			let writeError: unknown;
			let closeError: unknown;
			try {
				await handle.writeFile(
					`${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`,
					"utf8",
				);
			} catch (error) {
				writeError = error;
			}
			try {
				await handle.close();
			} catch (error) {
				closeError = error;
			}
			if (writeError !== undefined || closeError !== undefined) {
				const originalFailure = writeError ?? closeError;
				await cleanupIncompleteLockFile(path, originalFailure);
				throwOriginalOrCleanupError(originalFailure, originalFailure);
			}
			let released = false;
			return {
				path,
				release: async () => {
					if (released) return;
					try {
						await fs.unlink(path);
						released = true;
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "ENOENT") {
							released = true;
							return;
						}
						throw error;
					}
				},
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
			if (!RETRYABLE_CODES.has(code)) {
				throw error;
			}
			const removed = await removeIfStale(path, staleAfterMs);
			if (removed) {
				continue;
			}
			if (attempt >= maxAttempts - 1) {
				throw error;
			}
			await sleep(getRetryDelayMs(attempt, baseDelayMs, maxDelayMs));
		}
	}

	throw new Error(`Failed to acquire lock: ${path}`);
}

function removeIfStaleSync(path: string, staleAfterMs: number): boolean {
	try {
		const stats = statSync(path);
		if (Date.now() - stats.mtimeMs <= staleAfterMs) {
			return false;
		}
		try {
			const pid = parseLockPid(readFileSync(path, "utf8"));
			if (pid !== undefined && isPidAlive(pid)) {
				return false;
			}
		} catch {
			// If metadata can't be read, fall back to age-only cleanup.
		}
		unlinkSync(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return true;
		}
		return false;
	}
}

function cleanupIncompleteLockFileSync(path: string, originalError?: unknown): void {
	try {
		unlinkSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			if (originalError !== undefined) {
				throwOriginalOrCleanupError(originalError, error);
			}
			throw error;
		}
	}
}

export function acquireFileLockSync(
	path: string,
	options: FileLockOptions = {},
): FileLockSyncHandle {
	const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
	const baseDelayMs = Math.max(5, Math.floor(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS));
	const maxDelayMs = Math.max(baseDelayMs, Math.floor(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS));
	const staleAfterMs = Math.max(1_000, Math.floor(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			const fd = openSync(path, "wx", 0o600);
			let writeError: unknown;
			let closeError: unknown;
			try {
				writeFileSync(
					fd,
					`${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`,
					"utf8",
				);
			} catch (error) {
				writeError = error;
			}
			try {
				closeSync(fd);
			} catch (error) {
				closeError = error;
			}
			if (writeError !== undefined || closeError !== undefined) {
				const originalFailure = writeError ?? closeError;
				cleanupIncompleteLockFileSync(path, originalFailure);
				throwOriginalOrCleanupError(originalFailure, originalFailure);
			}
			let released = false;
			return {
				path,
				release: () => {
					if (released) return;
					try {
						unlinkSync(path);
						released = true;
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "ENOENT") {
							released = true;
							return;
						}
						throw error;
					}
				},
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
			if (!RETRYABLE_CODES.has(code)) {
				throw error;
			}
			const removed = removeIfStaleSync(path, staleAfterMs);
			if (removed) {
				continue;
			}
			if (attempt >= maxAttempts - 1) {
				throw error;
			}
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				getRetryDelayMs(attempt, baseDelayMs, maxDelayMs),
			);
		}
	}
	throw new Error(`Failed to acquire lock: ${path}`);
}
