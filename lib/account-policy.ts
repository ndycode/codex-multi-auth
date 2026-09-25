import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import type { AccountMetadataV3 } from "./storage.js";
import { isRecord, sleep } from "./utils.js";
import { tempPathFor } from "./temp-path.js";

export interface AccountPolicy {
	accountKey: string;
	tags: string[];
	weight: number;
	/** Lower tiers are tried first; absent legacy values use tier 1. */
	priority?: number;
	/** Opt in to periodic first-use completion for unused personal subscriptions. */
	autoPrime?: boolean;
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
let writeQueue: Promise<void> = Promise.resolve();

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

export async function loadAccountPolicyStore(): Promise<AccountPolicyStore> {
	const path = getAccountPolicyPath();
	if (!existsSync(path)) return emptyStore();
	try {
		return normalizeStore(JSON.parse(await readFileWithRetry(path)) as unknown);
	} catch (error) {
		logWarn(
			`Failed to load account policies from ${basename(path)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return emptyStore();
	}
}

export async function saveAccountPolicyStore(
	store: AccountPolicyStore,
): Promise<void> {
	const path = getAccountPolicyPath();
	const payload = normalizeStore(store);
	const task = async (): Promise<void> => {
		await fs.mkdir(getCodexMultiAuthDir(), { recursive: true, mode: 0o700 });
		const tempPath = tempPathFor(path);
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
	};
	const queued = writeQueue.catch(() => undefined).then(task);
	writeQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	await queued;
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
	next.updatedAt = now;
	store.accounts[accountKey] = next;
	return next;
}

export function normalizeAccountPolicyTag(value: string): string | null {
	return normalizeTag(value);
}

export function resetAccountPolicyWriteQueueForTests(): void {
	writeQueue = Promise.resolve();
}
