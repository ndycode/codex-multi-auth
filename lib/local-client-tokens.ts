import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { isRecord, sleep } from "./utils.js";

export interface LocalClientTokenRecord {
	id: string;
	label: string;
	prefix: string;
	tokenHash: string;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export interface LocalClientTokenStore {
	version: 1;
	tokens: LocalClientTokenRecord[];
}

export interface CreatedLocalClientToken {
	plainToken: string;
	record: LocalClientTokenRecord;
}

const TOKEN_FILE_NAME = "local-client-tokens.json";
const TOKEN_PREFIX = "cma_local";
// Debounce window for persisting a record's lastUsedAt. Bearer verification is
// on the auth hot path (every authenticated bridge request), so writing the
// store to disk on each verify serializes behind the shared write queue and
// triggers a temp-write+rename per request (with Windows rename-lock retries).
// lastUsedAt is informational only (surfaced by `bridge token list`), so we
// coalesce updates: advance it in-memory every verify but only flush to disk
// once it has moved at least this far past the persisted value.
const LAST_USED_PERSIST_THRESHOLD_MS = 60_000;
const RETRYABLE_FS_CODES = new Set([
	"EBUSY",
	"EPERM",
	"EAGAIN",
	"ENOTEMPTY",
	"EACCES",
]);
let writeQueue: Promise<unknown> = Promise.resolve();

// Serialize a task on the shared write queue so each task runs only after the
// previous one has fully settled. Routing the entire read-modify-write through
// here (not just the final write) ensures every mutation observes the prior
// committed state, preventing lost updates between concurrent public ops.
function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const queued = writeQueue.catch(() => undefined).then(task);
	writeQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function normalizeLabel(value: string | undefined): string {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed.slice(0, 80) : "local-client";
}

function hashToken(token: string): string {
	return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function createPlainToken(): string {
	return `${TOKEN_PREFIX}_${randomBytes(32).toString("base64url")}`;
}

function tokenPrefix(token: string): string {
	return token.slice(0, 18);
}

function emptyStore(): LocalClientTokenStore {
	return { version: 1, tokens: [] };
}

function normalizeRecord(value: unknown): LocalClientTokenRecord | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || value.id.trim().length === 0) return null;
	if (
		typeof value.tokenHash !== "string" ||
		!value.tokenHash.startsWith("sha256:")
	) {
		return null;
	}
	return {
		id: value.id.trim(),
		label: normalizeLabel(typeof value.label === "string" ? value.label : undefined),
		prefix: typeof value.prefix === "string" ? value.prefix.slice(0, 32) : "",
		tokenHash: value.tokenHash,
		createdAt:
			typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
				? value.createdAt
				: 0,
		lastUsedAt:
			typeof value.lastUsedAt === "number" && Number.isFinite(value.lastUsedAt)
				? value.lastUsedAt
				: null,
		revokedAt:
			typeof value.revokedAt === "number" && Number.isFinite(value.revokedAt)
				? value.revokedAt
				: null,
	};
}

function normalizeStore(value: unknown): LocalClientTokenStore {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tokens)) {
		return emptyStore();
	}
	return {
		version: 1,
		tokens: value.tokens
			.map((entry) => normalizeRecord(entry))
			.filter((entry): entry is LocalClientTokenRecord => entry !== null),
	};
}

async function readFileWithRetry(path: string): Promise<string> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await fs.readFile(path, "utf8");
		} catch (error) {
			lastError = error;
			if (!isRetryableFsError(error) || attempt >= 4) throw error;
			await sleep(10 * 2 ** attempt);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("local client token read retry exhausted");
}

export function getLocalClientTokenPath(): string {
	return join(getCodexMultiAuthDir(), TOKEN_FILE_NAME);
}

export async function loadLocalClientTokenStore(): Promise<LocalClientTokenStore> {
	const path = getLocalClientTokenPath();
	if (!existsSync(path)) return emptyStore();
	try {
		return normalizeStore(JSON.parse(await readFileWithRetry(path)) as unknown);
	} catch (error) {
		logWarn(
			`Failed to load local client tokens from ${basename(path)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return emptyStore();
	}
}

async function writeStoreToDisk(store: LocalClientTokenStore): Promise<void> {
	const path = getLocalClientTokenPath();
	const payload = normalizeStore(store);
	const dir = getCodexMultiAuthDir();
	// This store holds token hashes, so keep the directory owner-only on POSIX
	// (mode is a no-op on win32 / ACL-based).
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	// mkdir's mode only applies to a freshly-created dir; an upgrade with a
	// pre-existing multi-auth dir keeps its old (possibly world-listable) perms,
	// so re-assert 0o700 on POSIX. Best-effort: a chmod failure must not break
	// the write (the 0o600 file below still protects the hashes).
	if (process.platform !== "win32") {
		try {
			await fs.chmod(dir, 0o700);
		} catch {
			// Best-effort hardening only.
		}
	}
	const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	let moved = false;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await fs.rename(tempPath, path);
				moved = true;
				return;
			} catch (error) {
				if (!isRetryableFsError(error) || attempt >= 4) throw error;
				await sleep(10 * 2 ** attempt);
			}
		}
	} finally {
		if (!moved) {
			try {
				await fs.unlink(tempPath);
			} catch {
				// Best-effort temp cleanup.
			}
		}
	}
}

export async function saveLocalClientTokenStore(
	store: LocalClientTokenStore,
): Promise<void> {
	await enqueue(() => writeStoreToDisk(store));
}

export function createLocalClientTokenRecord(input: {
	label?: string;
	now?: number;
} = {}): CreatedLocalClientToken {
	const plainToken = createPlainToken();
	const record: LocalClientTokenRecord = {
		id: randomUUID(),
		label: normalizeLabel(input.label),
		prefix: tokenPrefix(plainToken),
		tokenHash: hashToken(plainToken),
		createdAt: input.now ?? Date.now(),
		lastUsedAt: null,
		revokedAt: null,
	};
	return { plainToken, record };
}

export async function addLocalClientToken(input: {
	label?: string;
	now?: number;
} = {}): Promise<CreatedLocalClientToken> {
	return enqueue(async () => {
		const store = await loadLocalClientTokenStore();
		const created = createLocalClientTokenRecord(input);
		store.tokens.push(created.record);
		await writeStoreToDisk(store);
		return created;
	});
}

export async function rotateLocalClientToken(input: {
	id: string;
	label?: string;
	now?: number;
}): Promise<CreatedLocalClientToken | null> {
	return enqueue(async () => {
		const store = await loadLocalClientTokenStore();
		const existing = store.tokens.find((record) => record.id === input.id);
		if (!existing || existing.revokedAt !== null) return null;
		const now = input.now ?? Date.now();
		existing.revokedAt = now;
		const created = createLocalClientTokenRecord({
			label: input.label ?? existing.label,
			now,
		});
		store.tokens.push(created.record);
		await writeStoreToDisk(store);
		return created;
	});
}

export async function revokeLocalClientToken(
	id: string,
	now = Date.now(),
): Promise<boolean> {
	return enqueue(async () => {
		const store = await loadLocalClientTokenStore();
		const existing = store.tokens.find((record) => record.id === id);
		if (!existing || existing.revokedAt !== null) return false;
		existing.revokedAt = now;
		await writeStoreToDisk(store);
		return true;
	});
}

export async function verifyLocalClientBearerToken(
	authorizationHeader: string | null,
	now = Date.now(),
): Promise<LocalClientTokenRecord | null> {
	const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
	const token = match?.[1]?.trim();
	if (!token) return null;
	const tokenHash = hashToken(token);
	return enqueue(async () => {
		const store = await loadLocalClientTokenStore();
		const record = store.tokens.find(
			(entry) => entry.revokedAt === null && entry.tokenHash === tokenHash,
		);
		if (!record) return null;
		// Token match (verification correctness) is decided above and never
		// depends on lastUsedAt. Always advance lastUsedAt in-memory so callers
		// see a fresh value, but only flush to disk when it has not been
		// persisted yet, or has advanced past the debounce threshold. This keeps
		// steady-state verifies off the disk-write path while still recording
		// recent usage on a coarse (>=60s) cadence.
		const persisted = record.lastUsedAt;
		record.lastUsedAt = now;
		if (persisted === null || now - persisted >= LAST_USED_PERSIST_THRESHOLD_MS) {
			await writeStoreToDisk(store);
		}
		return record;
	});
}

export function resetLocalClientTokenWriteQueueForTests(): void {
	writeQueue = Promise.resolve();
}
