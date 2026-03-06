import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { acquireFileLock } from "./file-lock.js";

const IDEMPOTENCY_PATH = join(getCodexMultiAuthDir(), "idempotency-keys.json");
const IDEMPOTENCY_LOCK_PATH = `${IDEMPOTENCY_PATH}.lock`;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM", "EAGAIN", "ETIMEDOUT", "EACCES"]);
const MAX_FS_IO_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 10;

type IdempotencyStatus = "pending" | "succeeded";

interface IdempotencyEntry {
	scope: string;
	key: string;
	createdAtMs: number;
	status: IdempotencyStatus;
}

interface IdempotencyFile {
	version: 1;
	entries: IdempotencyEntry[];
}

const EMPTY_FILE: IdempotencyFile = {
	version: 1,
	entries: [],
};

function getRetryDelayMs(attempt: number): number {
	return BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
}

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetryableFsIo<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_FS_IO_ATTEMPTS; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= MAX_FS_IO_ATTEMPTS) {
				throw error;
			}
			await sleep(getRetryDelayMs(attempt));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Idempotency filesystem retry exhausted");
}

function normalizeFile(value: unknown): IdempotencyFile {
	if (!value || typeof value !== "object") return EMPTY_FILE;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !Array.isArray(record.entries)) return EMPTY_FILE;
	const entries = record.entries
		.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
		.map((entry) => {
			const scope = typeof entry.scope === "string" ? entry.scope.trim() : "";
			const key = typeof entry.key === "string" ? entry.key.trim() : "";
			const createdAtMs =
				typeof entry.createdAtMs === "number" && Number.isFinite(entry.createdAtMs)
					? entry.createdAtMs
					: 0;
			const status: IdempotencyStatus =
				entry.status === "pending" || entry.status === "succeeded"
					? entry.status
					: "succeeded";
			return { scope, key, createdAtMs, status };
		})
		.filter((entry) => entry.scope.length > 0 && entry.key.length > 0 && entry.createdAtMs > 0);
	return {
		version: 1,
		entries,
	};
}

async function loadFile(): Promise<IdempotencyFile> {
	try {
		const raw = await withRetryableFsIo(() => fs.readFile(IDEMPOTENCY_PATH, "utf8"));
		return normalizeFile(JSON.parse(raw) as unknown);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return { ...EMPTY_FILE };
		throw error;
	}
}

async function saveFile(file: IdempotencyFile): Promise<void> {
	await withRetryableFsIo(() => fs.mkdir(dirname(IDEMPOTENCY_PATH), { recursive: true }));
	const tempPath = `${IDEMPOTENCY_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await withRetryableFsIo(() =>
		fs.writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		}),
	);
	try {
		await withRetryableFsIo(() => fs.rename(tempPath, IDEMPOTENCY_PATH));
	} finally {
		try {
			await withRetryableFsIo(() => fs.unlink(tempPath));
		} catch {
			// Best-effort temp cleanup.
		}
	}
}

function pruneExpired(entries: IdempotencyEntry[], nowMs: number, ttlMs: number): IdempotencyEntry[] {
	const cutoff = nowMs - ttlMs;
	return entries.filter((entry) => entry.createdAtMs >= cutoff);
}

export function getIdempotencyStorePath(): string {
	return IDEMPOTENCY_PATH;
}

async function withIdempotencyFileLock<T>(handler: () => Promise<T>): Promise<T> {
	await withRetryableFsIo(() => fs.mkdir(dirname(IDEMPOTENCY_PATH), { recursive: true }));
	const lock = await acquireFileLock(IDEMPOTENCY_LOCK_PATH, {
		maxAttempts: 80,
		baseDelayMs: 15,
		maxDelayMs: 800,
		staleAfterMs: 120_000,
	});
	try {
		return await handler();
	} finally {
		await lock.release();
	}
}

function isMatchingEntry(entry: IdempotencyEntry, scope: string, key: string): boolean {
	return entry.scope === scope && entry.key === key;
}

async function mutateEntries(
	ttlMs: number,
	mutator: (entries: IdempotencyEntry[], nowMs: number) => IdempotencyEntry[],
): Promise<void> {
	await withIdempotencyFileLock(async () => {
		const nowMs = Date.now();
		const file = await loadFile();
		const entries = pruneExpired(file.entries, nowMs, Math.max(1, ttlMs));
		const nextEntries = mutator(entries, nowMs);
		await saveFile({ version: 1, entries: nextEntries });
	});
}

export async function checkAndRecordIdempotencyKey(
	scope: string,
	key: string,
	ttlMs = IDEMPOTENCY_TTL_MS,
): Promise<{ replayed: boolean }> {
	const normalizedScope = scope.trim();
	const normalizedKey = key.trim();
	if (normalizedScope.length === 0) {
		throw new Error("Idempotency scope is required");
	}
	if (normalizedKey.length === 0) {
		throw new Error("Idempotency key is required");
	}

	return withIdempotencyFileLock(async () => {
		const nowMs = Date.now();
		const file = await loadFile();
		const entries = pruneExpired(file.entries, nowMs, Math.max(1, ttlMs));
		const replayed = entries.some(
			(entry) =>
				isMatchingEntry(entry, normalizedScope, normalizedKey) &&
				(entry.status === "pending" || entry.status === "succeeded"),
		);
		if (!replayed) {
			entries.push({
				scope: normalizedScope,
				key: normalizedKey,
				createdAtMs: nowMs,
				status: "pending",
			});
		}
		await saveFile({ version: 1, entries });
		return { replayed };
	});
}

export async function markIdempotencySucceeded(
	scope: string,
	key: string,
	ttlMs = IDEMPOTENCY_TTL_MS,
): Promise<void> {
	const normalizedScope = scope.trim();
	const normalizedKey = key.trim();
	if (normalizedScope.length === 0 || normalizedKey.length === 0) {
		return;
	}
	await mutateEntries(ttlMs, (entries, nowMs) => {
		let updated = false;
		const next: IdempotencyEntry[] = entries.map((entry): IdempotencyEntry => {
			if (!isMatchingEntry(entry, normalizedScope, normalizedKey)) {
				return entry;
			}
			updated = true;
			return {
				...entry,
				status: "succeeded",
				createdAtMs: nowMs,
			};
		});
		if (!updated) {
			next.push({
				scope: normalizedScope,
				key: normalizedKey,
				createdAtMs: nowMs,
				status: "succeeded",
			});
		}
		return next;
	});
}

export async function clearIdempotencyOnFailure(
	scope: string,
	key: string,
	ttlMs = IDEMPOTENCY_TTL_MS,
): Promise<void> {
	const normalizedScope = scope.trim();
	const normalizedKey = key.trim();
	if (normalizedScope.length === 0 || normalizedKey.length === 0) {
		return;
	}
	await mutateEntries(ttlMs, (entries) =>
		entries.filter(
			(entry) =>
				!(
					isMatchingEntry(entry, normalizedScope, normalizedKey) &&
					entry.status === "pending"
				),
		),
	);
}
