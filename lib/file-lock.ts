import {
	openSync,
	writeFileSync,
	closeSync,
	readFileSync,
	unlinkSync,
	statSync,
	promises as fs,
} from "node:fs";

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
const LOCK_FILE_ENCODING: BufferEncoding = "utf8";

interface LockFileMetadata {
	pid: number;
	acquiredAt: number;
	token: string;
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

function createLockToken(): string {
	return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function serializeLockMetadata(token: string): string {
	const metadata: LockFileMetadata = {
		pid: process.pid,
		acquiredAt: Date.now(),
		token,
	};
	return `${JSON.stringify(metadata)}\n`;
}

function parseLockToken(content: string): string | null {
	const trimmed = content.trim();
	if (!trimmed) {
		return null;
	}
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
	} catch {
		return null;
	}
}

async function isOwnedLockFile(path: string, expectedToken: string): Promise<boolean> {
	let content: string;
	try {
		content = await fs.readFile(path, LOCK_FILE_ENCODING);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return false;
		}
		throw error;
	}
	const token = parseLockToken(content);
	return token === expectedToken;
}

function isOwnedLockFileSync(path: string, expectedToken: string): boolean {
	let content: string;
	try {
		content = readFileSync(path, LOCK_FILE_ENCODING);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return false;
		}
		throw error;
	}
	const token = parseLockToken(content);
	return token === expectedToken;
}

async function removeIfStale(path: string, staleAfterMs: number): Promise<boolean> {
	try {
		const stats = await fs.stat(path);
		if (Date.now() - stats.mtimeMs <= staleAfterMs) {
			return false;
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
			const token = createLockToken();
			let writeError: unknown;
			let closeError: unknown;
			try {
				await handle.writeFile(serializeLockMetadata(token), LOCK_FILE_ENCODING);
			} catch (error) {
				writeError = error;
			}
			try {
				await handle.close();
			} catch (error) {
				closeError = error;
			}
			if (writeError !== undefined) {
				throw writeError;
			}
			if (closeError !== undefined) {
				throw closeError;
			}
			let released = false;
			return {
				path,
				release: async () => {
					if (released) return;
					released = true;
					try {
						const owned = await isOwnedLockFile(path, token);
						if (!owned) {
							return;
						}
						await fs.unlink(path);
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code !== "ENOENT") {
							throw error;
						}
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
			const token = createLockToken();
			let writeError: unknown;
			let closeError: unknown;
			try {
				writeFileSync(fd, serializeLockMetadata(token), LOCK_FILE_ENCODING);
			} catch (error) {
				writeError = error;
			}
			try {
				closeSync(fd);
			} catch (error) {
				closeError = error;
			}
			if (writeError !== undefined) {
				throw writeError;
			}
			if (closeError !== undefined) {
				throw closeError;
			}
			let released = false;
			return {
				path,
				release: () => {
					if (released) return;
					released = true;
					try {
						const owned = isOwnedLockFileSync(path, token);
						if (!owned) {
							return;
						}
						unlinkSync(path);
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code !== "ENOENT") {
							throw error;
						}
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
