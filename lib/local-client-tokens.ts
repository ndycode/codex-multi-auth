import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { isRecord, sleep } from "./utils.js";
import { tempPathFor } from "./temp-path.js";
import {
	assertJsonStoreFileMtimeUnchanged,
	getJsonStoreFileMtimeMs,
	withJsonStoreCasRetry,
	withJsonStoreFileLock,
} from "./storage/json-store-lock.js";

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

/**
 * Constant-time equality for two `sha256:<hex>` token hashes.
 *
 * A `===` on the hex strings returns early at the first differing byte, so a
 * local process that can spam verify calls could measure the comparison cost
 * and recover a stored hash prefix byte-by-byte. Comparing the decoded digest
 * bytes with timingSafeEqual removes the oracle; both inputs are validated to
 * the fixed 32-byte shape first, so timingSafeEqual never throws.
 */
function sha256DigestBytes(hash: string): Buffer | null {
	if (!/^sha256:[0-9a-f]{64}$/i.test(hash)) return null;
	return Buffer.from(hash.slice("sha256:".length), "hex");
}

function tokenHashEqual(left: string, right: string): boolean {
	const leftDigest = sha256DigestBytes(left);
	const rightDigest = sha256DigestBytes(right);
	return (
		leftDigest !== null &&
		rightDigest !== null &&
		timingSafeEqual(leftDigest, rightDigest)
	);
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

/**
 * Merge a caller-supplied store over the freshest on-disk store by token id.
 * Records the caller does not carry are preserved (this store is append-only:
 * rotation and revocation mark records in place, nothing deletes them), and
 * the monotone fields a concurrent process may have advanced — `lastUsedAt`
 * from verifies, `revokedAt` from revocations/rotations — are kept at their
 * furthest value so a stale snapshot cannot un-revoke or rewind usage.
 */
function mergeTokenStoreRecords(
	current: LocalClientTokenStore,
	incoming: LocalClientTokenStore,
): LocalClientTokenStore {
	const indexById = new Map<string, number>();
	const tokens = current.tokens.map((record, index) => {
		indexById.set(record.id, index);
		return record;
	});
	for (const record of incoming.tokens) {
		const index = indexById.get(record.id);
		if (index === undefined) {
			indexById.set(record.id, tokens.length);
			tokens.push(record);
			continue;
		}
		const existing = tokens[index];
		if (existing === undefined) {
			// Unreachable: indexes recorded in indexById always point at a
			// slot that exists in `tokens`.
			continue;
		}
		tokens[index] = {
			...record,
			lastUsedAt:
				record.lastUsedAt === null
					? existing.lastUsedAt
					: existing.lastUsedAt === null
						? record.lastUsedAt
						: Math.max(record.lastUsedAt, existing.lastUsedAt),
			revokedAt: record.revokedAt ?? existing.revokedAt,
		};
	}
	return { version: 1, tokens };
}

async function writeStoreToDisk(
	store: LocalClientTokenStore,
	expectedMtimeMs?: number | null,
): Promise<void> {
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
	const tempPath = tempPathFor(path);
	let moved = false;
	try {
		// fsync the temp file before rename so a crash/power-loss after the rename
		// cannot leave a truncated token store (stress audit L3). Mirrors the
		// durable-write pattern already used in runtime/app-bind.ts.
		const handle = await fs.open(tempPath, "w", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		// Compare-and-swap guard: a writer that did not take the lockfile (or an
		// expired-lock takeover racing this write) moved the target's mtime; abort
		// with ESTALE so the caller reloads and re-merges instead of clobbering.
		if (expectedMtimeMs !== undefined) {
			await assertJsonStoreFileMtimeUnchanged(path, expectedMtimeMs);
		}
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

/**
 * Run a token-store read→mutate→write inside the write queue (in-process
 * serialization) AND the cross-process lock directory, with mtime CAS retry:
 * every attempt re-stats the file, re-reads the freshest on-disk store, and
 * re-applies `mutate` before writing — so an op whose snapshot raced a
 * concurrent process's write reloads-and-retries rather than clobbering it.
 * `mutate` must be re-appliable across retries (apply precomputed work onto
 * the store it is handed, don't capture mutated state).
 */
async function updateLocalClientTokenStore<T>(
	mutate: (store: LocalClientTokenStore) => { result: T; dirty: boolean },
): Promise<T> {
	const path = getLocalClientTokenPath();
	return enqueue(() =>
		withJsonStoreFileLock(path, () =>
			withJsonStoreCasRetry(async () => {
				const expectedMtimeMs = await getJsonStoreFileMtimeMs(path);
				const store = await loadLocalClientTokenStore();
				const { result, dirty } = mutate(store);
				if (dirty) {
					await writeStoreToDisk(store, expectedMtimeMs);
				}
				return result;
			}),
		),
	);
}

export async function saveLocalClientTokenStore(
	store: LocalClientTokenStore,
): Promise<void> {
	const path = getLocalClientTokenPath();
	const incoming = normalizeStore(store);
	await enqueue(() =>
		withJsonStoreFileLock(path, () =>
			withJsonStoreCasRetry(async () => {
				const expectedMtimeMs = await getJsonStoreFileMtimeMs(path);
				const current = await loadLocalClientTokenStore();
				const merged = mergeTokenStoreRecords(current, incoming);
				await writeStoreToDisk(merged, expectedMtimeMs);
			}),
		),
	);
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
	// The token record is created once, outside the CAS retry: re-applying the
	// same record onto a freshly-reloaded store is what makes each retry safe.
	const created = createLocalClientTokenRecord(input);
	return updateLocalClientTokenStore((store) => {
		store.tokens.push(created.record);
		return { result: created, dirty: true };
	});
}

export async function rotateLocalClientToken(input: {
	id: string;
	label?: string;
	now?: number;
}): Promise<CreatedLocalClientToken | null> {
	const now = input.now ?? Date.now();
	let created: CreatedLocalClientToken | null = null;
	return updateLocalClientTokenStore((store) => {
		const existing = store.tokens.find((record) => record.id === input.id);
		if (!existing || existing.revokedAt !== null) {
			return { result: null, dirty: false };
		}
		existing.revokedAt = now;
		// Same record across CAS retries so a retry cannot mint a second token.
		created ??= createLocalClientTokenRecord({
			label: input.label ?? existing.label,
			now,
		});
		store.tokens.push(created.record);
		return { result: created, dirty: true };
	});
}

export async function revokeLocalClientToken(
	id: string,
	now = Date.now(),
): Promise<boolean> {
	return updateLocalClientTokenStore((store) => {
		const existing = store.tokens.find((record) => record.id === id);
		if (!existing || existing.revokedAt !== null) {
			return { result: false, dirty: false };
		}
		existing.revokedAt = now;
		return { result: true, dirty: true };
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
	return updateLocalClientTokenStore((store) => {
		const record = store.tokens.find(
			(entry) => entry.revokedAt === null && tokenHashEqual(entry.tokenHash, tokenHash),
		);
		if (!record) return { result: null, dirty: false };
		// Token match (verification correctness) is decided above and never
		// depends on lastUsedAt. Always advance lastUsedAt in-memory so callers
		// see a fresh value, but only flush to disk when it has not been
		// persisted yet, or has advanced past the debounce threshold. This keeps
		// steady-state verifies off the disk-write path while still recording
		// recent usage on a coarse (>=60s) cadence.
		const persisted = record.lastUsedAt;
		record.lastUsedAt = now;
		return {
			result: record,
			dirty:
				persisted === null ||
				now - persisted >= LAST_USED_PERSIST_THRESHOLD_MS,
		};
	});
}

export function resetLocalClientTokenWriteQueueForTests(): void {
	writeQueue = Promise.resolve();
}
