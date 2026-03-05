import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { acquireFileLock } from "./file-lock.js";

const IDEMPOTENCY_PATH = join(getCodexMultiAuthDir(), "idempotency-keys.json");
const IDEMPOTENCY_LOCK_PATH = `${IDEMPOTENCY_PATH}.lock`;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const IDEMPOTENCY_MIN_TTL_MS = 1_000;
const IDEMPOTENCY_RENAME_RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const IDEMPOTENCY_RENAME_MAX_ATTEMPTS = 5;

interface IdempotencyEntry {
	scope: string;
	key: string;
	createdAtMs: number;
}

interface IdempotencyFile {
	version: 1;
	entries: IdempotencyEntry[];
}

const EMPTY_FILE: IdempotencyFile = {
	version: 1,
	entries: [],
};

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
			return { scope, key, createdAtMs };
		})
		.filter((entry) => entry.scope.length > 0 && entry.key.length > 0 && entry.createdAtMs > 0);
	return {
		version: 1,
		entries,
	};
}

async function loadFile(): Promise<IdempotencyFile> {
	try {
		const raw = await fs.readFile(IDEMPOTENCY_PATH, "utf8");
		return normalizeFile(JSON.parse(raw) as unknown);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return { ...EMPTY_FILE };
		if (error instanceof SyntaxError) {
			return { ...EMPTY_FILE };
		}
		throw error;
	}
}

async function saveFile(file: IdempotencyFile): Promise<void> {
	await fs.mkdir(dirname(IDEMPOTENCY_PATH), { recursive: true });
	const tempPath = `${IDEMPOTENCY_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	await fs.writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		for (let attempt = 0; attempt < IDEMPOTENCY_RENAME_MAX_ATTEMPTS; attempt += 1) {
			try {
				await fs.rename(tempPath, IDEMPOTENCY_PATH);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
				if (!IDEMPOTENCY_RENAME_RETRYABLE_CODES.has(code) || attempt >= IDEMPOTENCY_RENAME_MAX_ATTEMPTS - 1) {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
			}
		}
	} finally {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Best-effort temp cleanup.
		}
	}
}

function pruneExpired(entries: IdempotencyEntry[], nowMs: number, ttlMs: number): IdempotencyEntry[] {
	const cutoff = nowMs - ttlMs;
	return entries.filter((entry) => entry.createdAtMs >= cutoff);
}

function normalizeTtlMs(ttlMs: number): number {
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
		return IDEMPOTENCY_MIN_TTL_MS;
	}
	return Math.floor(ttlMs);
}

export function getIdempotencyStorePath(): string {
	return IDEMPOTENCY_PATH;
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

	const nowMs = Date.now();
	const lock = await acquireFileLock(IDEMPOTENCY_LOCK_PATH, {
		maxAttempts: 80,
		baseDelayMs: 15,
		maxDelayMs: 800,
		staleAfterMs: 120_000,
	});
	try {
		const file = await loadFile();
		const entries = pruneExpired(file.entries, nowMs, normalizeTtlMs(ttlMs));
		const replayed = entries.some(
			(entry) => entry.scope === normalizedScope && entry.key === normalizedKey,
		);
		if (!replayed) {
			entries.push({
				scope: normalizedScope,
				key: normalizedKey,
				createdAtMs: nowMs,
			});
		}
		await saveFile({ version: 1, entries });
		return { replayed };
	} finally {
		await lock.release();
	}
}
