import { existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { logWarn } from "./logger.js";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import type { UsageSummary } from "./usage/index.js";
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

export type BudgetWindow = "hour" | "day" | "week" | "month";

export interface BudgetLimit {
	key: string;
	window: BudgetWindow;
	maxRequests?: number;
	maxTokens?: number;
	maxCostUsd?: number;
	updatedAt: number;
}

export interface BudgetGuardStore {
	version: 1;
	limits: Record<string, BudgetLimit>;
}

export interface BudgetGuardEvaluation {
	key: string;
	window: BudgetWindow;
	allowed: boolean;
	reasons: string[];
	usage: {
		requests: number;
		totalTokens: number;
		costUsd: number;
		unpricedRequests: number;
	};
	limits: {
		maxRequests: number | null;
		maxTokens: number | null;
		maxCostUsd: number | null;
	};
}

const BUDGET_GUARD_FILE_NAME = "budget-guards.json";
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM"]);
const VALID_WINDOWS = new Set<BudgetWindow>(["hour", "day", "week", "month"]);

function isRetryableFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FS_CODES.has(code);
}

function normalizeKey(value: string): string | null {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
	return normalized.length > 0 ? normalized.slice(0, 100) : null;
}

function normalizePositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function normalizeLimit(key: string, value: unknown): BudgetLimit | null {
	if (!isRecord(value)) return null;
	const window =
		typeof value.window === "string" && VALID_WINDOWS.has(value.window as BudgetWindow)
			? (value.window as BudgetWindow)
			: null;
	if (!window) return null;
	return {
		key,
		window,
		maxRequests: normalizePositiveNumber(value.maxRequests),
		maxTokens: normalizePositiveNumber(value.maxTokens),
		maxCostUsd: normalizePositiveNumber(value.maxCostUsd),
		updatedAt:
			typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
				? value.updatedAt
				: 0,
	};
}

// Normalized keys can literally be Object.prototype member names —
// "constructor" and "__proto__" both survive normalizeKey untouched. On a
// plain object, reading an absent key resolves an inherited member
// ({}.constructor === Object), which made a same-named limit look "already
// present" to the merge and silently dropped the incoming entry; writing
// "__proto__" invokes the setter and mutates the prototype instead of storing
// anything. Null-prototype maps make every key a plain data slot regardless of
// name (same convention as lib/storage/snapshot-merge.ts).
function newLimitsMap(): Record<string, BudgetLimit> {
	return Object.create(null) as Record<string, BudgetLimit>;
}

// Writes into maps that callers may have built as plain object literals cannot
// rely on the map being null-prototype, so "__proto__" needs an own-property
// write that bypasses the inherited setter.
function writeLimitEntry(
	map: Record<string, BudgetLimit>,
	key: string,
	limit: BudgetLimit,
): void {
	Object.defineProperty(map, key, {
		value: limit,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

function emptyStore(): BudgetGuardStore {
	return { version: 1, limits: newLimitsMap() };
}

function normalizeStore(value: unknown): BudgetGuardStore {
	if (!isRecord(value) || value.version !== 1) return emptyStore();
	const limits = newLimitsMap();
	if (isRecord(value.limits)) {
		for (const [rawKey, raw] of Object.entries(value.limits)) {
			const key = normalizeKey(rawKey);
			if (!key) continue;
			const limit = normalizeLimit(key, raw);
			if (limit) limits[key] = limit;
		}
	}
	return { version: 1, limits };
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
		: new Error("budget guard read retry exhausted");
}

export function getBudgetGuardPath(): string {
	return join(getCodexMultiAuthDir(), BUDGET_GUARD_FILE_NAME);
}

export function normalizeBudgetKey(value: string): string | null {
	return normalizeKey(value);
}

export async function loadBudgetGuardStore(): Promise<BudgetGuardStore> {
	const path = getBudgetGuardPath();
	if (!existsSync(path)) return emptyStore();
	try {
		return normalizeStore(JSON.parse(await readFileWithRetry(path)) as unknown);
	} catch (error) {
		logWarn(
			`Failed to load budget guards from ${basename(path)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return emptyStore();
	}
}

/**
 * Per-key merge of the caller's normalized store over the freshest on-disk
 * store. Budget entries carry `updatedAt`; the newer entry wins per key so a
 * save built on a stale snapshot cannot resurrect an older limit over a
 * concurrent process's newer one. Keys the caller does not carry are
 * preserved (upsert-only store — nothing deletes entries), matching the
 * config save's patch-over-fresh-read semantics.
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
function mergeBudgetGuardLimits(
	current: BudgetGuardStore,
	incoming: BudgetGuardStore,
	baseline: BudgetGuardStore | undefined,
): BudgetGuardStore {
	const merged: BudgetGuardStore = {
		version: 1,
		limits: Object.assign(newLimitsMap(), current.limits),
	};
	const same = (
		a: BudgetLimit | undefined,
		b: BudgetLimit | undefined,
	): boolean => JSON.stringify(a) === JSON.stringify(b);
	for (const [key, limit] of Object.entries(incoming.limits)) {
		const existing = merged.limits[key];
		if (!baseline) {
			if (!existing || limit.updatedAt >= existing.updatedAt) {
				merged.limits[key] = limit;
			}
			continue;
		}
		if (same(limit, baseline.limits[key])) continue;
		limit.updatedAt = stampUpdatedAt(limit.updatedAt, existing?.updatedAt);
		merged.limits[key] = limit;
	}
	return merged;
}

export async function saveBudgetGuardStore(
	store: BudgetGuardStore,
	baseline?: BudgetGuardStore,
): Promise<void> {
	const path = getBudgetGuardPath();
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
				const current = await loadBudgetGuardStore();
				const merged = mergeBudgetGuardLimits(current, incoming, prior);
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
 * Run a budget-guard read→mutate→write inside the write queue (in-process
 * serialization) AND the cross-process lock directory, with mtime CAS retry:
 * every attempt re-reads the freshest on-disk store and re-applies `mutate`
 * before writing — so a mutation is applied to the latest committed state
 * rather than merged by whole-record `updatedAt`, which can drop or clobber
 * a concurrent process's change to the same key. `mutate` must be
 * re-appliable across retries (apply precomputed work onto the store it is
 * handed, don't capture mutated state). Prefer this over load→upsert→save
 * whenever the caller is mutating rather than importing a foreign store.
 */
export async function updateBudgetGuardStore<T>(
	mutate: (store: BudgetGuardStore) => { result: T; dirty: boolean },
): Promise<T> {
	const path = getBudgetGuardPath();
	return withJsonStoreWriteQueue(path, () =>
		withJsonStoreFileLock(path, () =>
			withJsonStoreCasRetry(async () => {
				const expectedMtimeMs = await getJsonStoreFileMtimeMs(path);
				const store = await loadBudgetGuardStore();
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

export function upsertBudgetLimit(
	store: BudgetGuardStore,
	limit: Omit<BudgetLimit, "updatedAt">,
	now = Date.now(),
): BudgetLimit {
	const key = normalizeKey(limit.key);
	if (!key) throw new Error("Budget key is required");
	const next = normalizeLimit(key, {
		...limit,
		key,
		updatedAt: stampUpdatedAt(now, store.limits[key]?.updatedAt),
	});
	if (!next) throw new Error("Invalid budget limit");
	writeLimitEntry(store.limits, key, next);
	return next;
}

export function getBudgetWindowStart(window: BudgetWindow, now = Date.now()): number {
	const date = new Date(now);
	if (window === "hour") {
		date.setUTCMinutes(0, 0, 0);
		return date.getTime();
	}
	if (window === "day") {
		date.setUTCHours(0, 0, 0, 0);
		return date.getTime();
	}
	if (window === "week") {
		date.setUTCHours(0, 0, 0, 0);
		const day = date.getUTCDay();
		const mondayOffset = day === 0 ? 6 : day - 1;
		date.setUTCDate(date.getUTCDate() - mondayOffset);
		return date.getTime();
	}
	date.setUTCDate(1);
	date.setUTCHours(0, 0, 0, 0);
	return date.getTime();
}

export function evaluateBudgetGuard(
	limit: BudgetLimit,
	summary: UsageSummary,
): BudgetGuardEvaluation {
	const reasons: string[] = [];
	if (
		typeof limit.maxRequests === "number" &&
		summary.totals.requests >= limit.maxRequests
	) {
		reasons.push(`request limit reached (${summary.totals.requests}/${limit.maxRequests})`);
	}
	if (
		typeof limit.maxTokens === "number" &&
		summary.totals.totalTokens >= limit.maxTokens
	) {
		reasons.push(`token limit reached (${summary.totals.totalTokens}/${limit.maxTokens})`);
	}
	if (typeof limit.maxCostUsd === "number") {
		if (summary.totals.costUsd >= limit.maxCostUsd) {
			reasons.push(
				`cost limit reached (${summary.totals.costUsd.toFixed(6)}/${limit.maxCostUsd.toFixed(6)})`,
			);
		} else if ((summary.totals.unpricedRequests ?? 0) > 0) {
			// The window contains token usage we have no rate for, so `costUsd` is
			// an under-count by an unknown amount and this limit cannot be
			// evaluated. Counting unknown cost as zero is what made a cost budget
			// silently unenforceable for every unpriced model; an unevaluable spend
			// limit fails closed instead. Priced models are unaffected.
			reasons.push(
				`cost limit cannot be evaluated: ${summary.totals.unpricedRequests} request(s) in this window have no known price (a model without a rate, or a Decisions call), so recorded cost (${summary.totals.costUsd.toFixed(6)}) is incomplete. Budget on --requests/--tokens instead of --cost.`,
			);
		}
	}
	return {
		key: limit.key,
		window: limit.window,
		allowed: reasons.length === 0,
		reasons,
		usage: {
			requests: summary.totals.requests,
			totalTokens: summary.totals.totalTokens,
			costUsd: summary.totals.costUsd,
			unpricedRequests: summary.totals.unpricedRequests,
		},
		limits: {
			maxRequests: limit.maxRequests ?? null,
			maxTokens: limit.maxTokens ?? null,
			maxCostUsd: limit.maxCostUsd ?? null,
		},
	};
}

export function resetBudgetGuardWriteQueueForTests(): void {
	resetJsonStoreWriteQueuesForTests(getBudgetGuardPath());
}

