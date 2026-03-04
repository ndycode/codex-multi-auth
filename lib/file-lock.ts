import {
	openSync,
	writeFileSync,
	closeSync,
	unlinkSync,
	statSync,
	readFileSync,
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

interface LockMetadata {
	pid: number;
	acquiredAt: number;
	ownerId: string;
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

function createLockMetadata(): LockMetadata {
	return {
		pid: process.pid,
		acquiredAt: Date.now(),
		ownerId: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
	};
}

function createLockPayload(metadata: LockMetadata): string {
	return `${JSON.stringify(metadata)}\n`;
}

function parseOwnerId(raw: string): string | null {
	try {
		const parsed = JSON.parse(raw) as { ownerId?: unknown };
		return typeof parsed.ownerId === "string" && parsed.ownerId.length > 0
			? parsed.ownerId
			: null;
	} catch {
		return null;
	}
}

async function releaseOwnedLock(path: string, ownerId: string): Promise<void> {
	let currentOwnerId: string | null = null;
	try {
		const raw = await fs.readFile(path, "utf8");
		currentOwnerId = parseOwnerId(raw);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (currentOwnerId !== ownerId) {
		return;
	}
	// Best effort race-hardening: re-check ownership immediately before delete.
	// Filesystems do not provide an atomic compare-and-delete primitive here, so
	// a narrow TOCTOU window still exists between this read and unlink.
	try {
		const raw = await fs.readFile(path, "utf8");
		currentOwnerId = parseOwnerId(raw);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (currentOwnerId !== ownerId) {
		return;
	}
	try {
		await fs.unlink(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			throw error;
		}
	}
}

function releaseOwnedLockSync(path: string, ownerId: string): void {
	let currentOwnerId: string | null = null;
	try {
		const raw = readFileSync(path, "utf8");
		currentOwnerId = parseOwnerId(raw);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (currentOwnerId !== ownerId) {
		return;
	}
	// Best effort race-hardening: re-check ownership immediately before delete.
	// Filesystems do not provide an atomic compare-and-delete primitive here, so
	// a narrow TOCTOU window still exists between this read and unlink.
	try {
		const raw = readFileSync(path, "utf8");
		currentOwnerId = parseOwnerId(raw);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (currentOwnerId !== ownerId) {
		return;
	}
	try {
		unlinkSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
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
			const metadata = createLockMetadata();
			const handle = await fs.open(path, "wx", 0o600);
			let closed = false;
			try {
				await handle.writeFile(createLockPayload(metadata), "utf8");
				await handle.close();
				closed = true;
			} catch (writeError) {
				if (!closed) {
					try {
						await handle.close();
					} catch {
						// Best-effort descriptor cleanup.
					}
				}
				try {
					await fs.unlink(path);
				} catch (cleanupError) {
					const code = (cleanupError as NodeJS.ErrnoException).code;
					if (code !== "ENOENT") {
						throw cleanupError;
					}
				}
				throw writeError;
			}
			let released = false;
			return {
				path,
				release: async () => {
					if (released) return;
					released = true;
					await releaseOwnedLock(path, metadata.ownerId);
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
			const metadata = createLockMetadata();
			const fd = openSync(path, "wx", 0o600);
			let closed = false;
			try {
				writeFileSync(fd, createLockPayload(metadata), "utf8");
				closeSync(fd);
				closed = true;
			} catch (writeError) {
				if (!closed) {
					try {
						closeSync(fd);
					} catch {
						// Best-effort descriptor cleanup.
					}
				}
				try {
					unlinkSync(path);
				} catch (cleanupError) {
					const code = (cleanupError as NodeJS.ErrnoException).code;
					if (code !== "ENOENT") {
						throw cleanupError;
					}
				}
				throw writeError;
			}
			let released = false;
			return {
				path,
				release: () => {
					if (released) return;
					released = true;
					releaseOwnedLockSync(path, metadata.ownerId);
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
