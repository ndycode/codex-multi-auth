import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import type { AccountMetadataV3 } from "./storage.js";
import { isRecord, sleep } from "./utils.js";
import {
	getJsonStoreFileMtimeMs,
	resetJsonStoreWriteQueuesForTests,
	stampUpdatedAt,
	withJsonStoreCasRetry,
	withJsonStoreFileLock,
	withJsonStoreWriteQueue,
	writeJsonStoreFileAtomicWithRetry,
} from "./storage/json-store-lock.js";

export interface AccountPolicy {
	accountKey: string;
	tags: string[];
	weight: number;
	/** Lower tiers are tried first; absent legacy values use tier 1. */
	priority?: number;
	/** Opt in to periodic first-use completion for unused personal subscriptions. */
	autoPrime?: boolean;
	/** Pool backup only, after primary subscriptions and reset credits are exhausted. */
	emergencyOnly?: boolean;
	paused: boolean;
	drained: boolean;
	note: string | null;
	updatedAt: number;
}

export interface AccountPolicyStore {
	version: 1;
	accounts: Record<string, AccountPolicy>;
}

const ACCOUNT_POLICY_FILE_NAME = "account-policies.json";
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function normalizeTag(value: string): string | null {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	return normalized.length > 0 ? normalized.slice(0, 64) : null;
}

function normalizeWeight(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(10, value))
		: 1;
}

function normalizePolicy(key: string, value: unknown): AccountPolicy {
	const record = isRecord(value) ? value : {};
	const tags = Array.isArray(record.tags)
		? [
				...new Set(
					record.tags
						.filter((tag): tag is string => typeof tag === "string")
						.map((tag) => normalizeTag(tag))
						.filter((tag): tag is string => tag !== null),
				),
			].sort()
		: [];
	const note = typeof record.note === "string" ? record.note.trim() : "";
	return {
		accountKey: key,
		tags,
		weight: normalizeWeight(record.weight),
		priority: normalizePriority(record.priority),
		autoPrime: record.autoPrime === true,
		emergencyOnly: record.emergencyOnly === true,
		paused: record.paused === true,
		drained: record.drained === true,
		note: note.length > 0 ? note.slice(0, 500) : null,
		updatedAt:
			typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
				? record.updatedAt
				: 0,
	};
}

function emptyStore(): AccountPolicyStore {
	return { version: 1, accounts: {} };
}

function normalizeStore(value: unknown): AccountPolicyStore {
	if (!isRecord(value) || value.version !== 1) return emptyStore();
	const accounts: Record<string, AccountPolicy> = {};
	if (isRecord(value.accounts)) {
		for (const [key, raw] of Object.entries(value.accounts)) {
			if (key.startsWith("sha256:")) {
				accounts[key] = normalizePolicy(key, raw);
			}
		}
	}
	return { version: 1, accounts };
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
		: new Error("account policy read retry exhausted");
}

export function getAccountPolicyPath(): string {
	return join(getCodexMultiAuthDir(), ACCOUNT_POLICY_FILE_NAME);
}

export function getAccountPolicyKey(
	account: Pick<AccountMetadataV3, "accountId" | "email"> & {
		refreshToken?: string | null;
	},
	_index?: number,
): string {
	// The key must be stable across processes and independent of the account's
	// slot (policy state is persisted and survives reordering), so it is derived
	// from identity, never from `_index`.
	//
	// An account whose accountId AND email are both missing — freshly imported,
	// or not yet hydrated from its token — used to hash the literal "unknown",
	// which gave EVERY such account the same key: pausing, draining or tagging
	// one silently applied to all of them. Fall back to the refresh token
	// instead, which every account has and no two accounts share. It is
	// namespaced before hashing so a token value can never collide with an
	// email or accountId of the same text, and only its digest is persisted.
	// Mirrors getAccountIdentityKey's `allowRefreshFallback`.
	const refreshFallback = account.refreshToken?.trim();
	const identity =
		account.accountId?.trim() ||
		account.email?.trim().toLowerCase() ||
		(refreshFallback ? `refresh:${refreshFallback}` : "unknown");
	return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export async function loadAccountPolicyStore(options: { strict?: boolean } = {}): Promise<AccountPolicyStore> {
	const path = getAccountPolicyPath();
	try {
		const parsed: unknown = JSON.parse(await readFileWithRetry(path));
		if (options.strict) {
			if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.accounts)) {
				throw new Error("Invalid account policy store");
			}
			for (const [key, row] of Object.entries(parsed.accounts)) {
				if (!key.startsWith("sha256:")) continue;
				// Legacy rows may omit flags; explicit malformed values are not OFF.
				if (!isRecord(row) || ["autoPrime", "emergencyOnly", "paused", "drained"].some(
					flag => flag in row && typeof row[flag] !== "boolean",
				)) {
					throw new Error("Invalid account policy row");
				}
			}
		}
		return normalizeStore(parsed);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
		if (options.strict) throw error;
		logWarn(
			`Failed to load account policies from ${basename(path)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return emptyStore();
	}
}

/**
 * Per-key merge of the caller's normalized store over the freshest on-disk
 * store. Policies are keyed by the account's hashed identity (`sha256:`) and
 * carry `updatedAt`; the newer entry wins per key so a save built on a stale
 * snapshot cannot resurrect an older policy over a concurrent process's
 * newer one. Keys the caller does not carry are preserved (upsert-only store
 * — nothing deletes entries), matching the config save's
 * patch-over-fresh-read semantics.
 *
 * When `baseline` (the caller's pre-edit snapshot) is supplied, entries
 * identical to it are untouched carried copies and skipped entirely, so a
 * stale snapshot row can never be re-stamped over a raced write. Entries
 * that differ are deliberate writes and must not lose purely on timestamp:
 * the upsert-time floor stamps against the caller's snapshot, but a
 * concurrent writer can land a still-newer entry before this merge runs, so
 * the merge re-stamps against the freshest on-disk entry instead of
 * silently dropping the edit. Without a baseline every supplied entry is a
 * plain `updatedAt >=` upsert.
 */
function mergeAccountPolicies(
	current: AccountPolicyStore,
	incoming: AccountPolicyStore,
	baseline: AccountPolicyStore | undefined,
): AccountPolicyStore {
	const merged: AccountPolicyStore = {
		version: 1,
		accounts: { ...current.accounts },
	};
	const same = (
		a: AccountPolicy | undefined,
		b: AccountPolicy | undefined,
	): boolean => JSON.stringify(a) === JSON.stringify(b);
	for (const [key, policy] of Object.entries(incoming.accounts)) {
		const existing = merged.accounts[key];
		if (!baseline) {
			if (!existing || policy.updatedAt >= existing.updatedAt) {
				merged.accounts[key] = policy;
			}
			continue;
		}
		if (same(policy, baseline.accounts[key])) continue;
		policy.updatedAt = stampUpdatedAt(policy.updatedAt, existing?.updatedAt);
		merged.accounts[key] = policy;
	}
	return merged;
}

export async function saveAccountPolicyStore(
	store: AccountPolicyStore,
	baseline?: AccountPolicyStore,
): Promise<void> {
	const path = getAccountPolicyPath();
	const incoming = normalizeStore(store);
	// Normalize at invocation like `incoming`: later caller-side mutation of
	// `baseline` must not shift which entries the merge counts as deliberate.
	const prior = baseline ? normalizeStore(baseline) : undefined;
	// Per-path promise queue serializes writers inside THIS process; the
	// lock directory closes the same window against OTHER processes. Inside the lock
	// every attempt re-stats (CAS), re-reads the freshest on-disk store, and
	// merges this call's entries over it — so a save that raced a concurrent
	// write reloads-and-retries rather than blindly overwriting it.
	await withJsonStoreWriteQueue(path, async () => {
		await withJsonStoreFileLock(path, async () => {
			await withJsonStoreCasRetry(async () => {
				const expectedMtimeMs = await getJsonStoreFileMtimeMs(path);
				const current = await loadAccountPolicyStore();
				const merged = mergeAccountPolicies(current, incoming, prior);
				await fs.mkdir(getCodexMultiAuthDir(), {
					recursive: true,
					mode: 0o700,
				});
				await writeJsonStoreFileAtomicWithRetry(path, merged, {
					expectedMtimeMs,
					mode: 0o600,
				});
			});
		});
	});
}

/**
 * Run a policy-store read→mutate→write inside the write queue (in-process
 * serialization) AND the cross-process lock directory, with mtime CAS retry:
 * every attempt re-reads the freshest on-disk store and re-applies `mutate`
 * before writing — so two commands editing DIFFERENT fields of the same
 * policy (e.g. `weight` vs `tags`) both land, which the whole-record
 * `updatedAt` merge in {@link saveAccountPolicyStore} cannot guarantee: a
 * stale snapshot's record would either clobber a newer record wholesale or be
 * discarded entirely. `mutate` must be re-appliable across retries (apply
 * precomputed work onto the store it is handed, don't capture mutated state).
 * Prefer this over load→upsert→save whenever the caller is mutating rather
 * than importing a foreign store.
 */
export async function updateAccountPolicyStore<T>(
	mutate: (store: AccountPolicyStore) => { result: T; dirty: boolean },
): Promise<T> {
	const path = getAccountPolicyPath();
	return withJsonStoreWriteQueue(path, () =>
		withJsonStoreFileLock(path, () =>
			withJsonStoreCasRetry(async () => {
				const expectedMtimeMs = await getJsonStoreFileMtimeMs(path);
				const store = await loadAccountPolicyStore();
				const { result, dirty } = mutate(store);
				if (dirty) {
					await fs.mkdir(getCodexMultiAuthDir(), {
						recursive: true,
						mode: 0o700,
					});
					await writeJsonStoreFileAtomicWithRetry(
						path,
						normalizeStore(store),
						{ expectedMtimeMs, mode: 0o600 },
					);
				}
				return result;
			}),
		),
	);
}

/** Tiers are integers 0-9; anything else (including legacy absence) is tier 1. */
function normalizePriority(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9 ? value : 1;
}

export function upsertAccountPolicy(
	store: AccountPolicyStore,
	accountKey: string,
	mutate: (policy: AccountPolicy) => void,
	now = Date.now(),
): AccountPolicy {
	const next = structuredClone(
		store.accounts[accountKey] ?? normalizePolicy(accountKey, null),
	);
	mutate(next);
	next.tags = [
		...new Set(
			next.tags
				.map((tag) => normalizeTag(tag))
				.filter((tag): tag is string => tag !== null),
		),
	].sort();
	next.weight = normalizeWeight(next.weight);
	next.priority = normalizePriority(next.priority);
	next.autoPrime = next.autoPrime === true;
	next.emergencyOnly = next.emergencyOnly === true;
	next.updatedAt = stampUpdatedAt(now, store.accounts[accountKey]?.updatedAt);
	store.accounts[accountKey] = next;
	return next;
}

export function normalizeAccountPolicyTag(value: string): string | null {
	return normalizeTag(value);
}

export function resetAccountPolicyWriteQueueForTests(): void {
	resetJsonStoreWriteQueuesForTests(getAccountPolicyPath());
}
