import { createLogger } from "./logger.js";

const log = createLogger("entitlement-cache");

export interface EntitlementBlock {
	model: string;
	blockedUntil: number;
	reason: "unsupported-model" | "plan-entitlement";
	updatedAt: number;
}

export interface EntitlementCacheSnapshot {
	accounts: Record<string, EntitlementBlock[]>;
}

const DEFAULT_BLOCK_TTL_MS = 30 * 60_000;
const MAX_ACCOUNT_BUCKETS = 512;

export interface EntitlementAccountRef {
	accountId?: string;
	email?: string;
	refreshToken?: string;
	index?: number;
}

/**
 * Produce a normalized model identifier suitable for cache keys and comparisons.
 *
 * Trims and lowercases the input, uses the final path segment if a slash is present,
 * and removes common variant suffixes such as `-none`, `-minimal`, `-low`, `-medium`, `-high`, and `-xhigh`.
 *
 * @param model - The raw model string to normalize; may be undefined or empty.
 * @returns The simplified model identifier, or `null` if `model` is missing or empty after trimming.
 */
function normalizeModel(model: string | undefined): string | null {
	if (!model) return null;
	const trimmed = model.trim().toLowerCase();
	if (!trimmed) return null;
	const stripped = trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
	return stripped.replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");
}

function normalizeEntitlementEmail(email: string | undefined): string | undefined {
	if (!email) return undefined;
	const trimmed = email.trim();
	if (!trimmed) return undefined;
	return trimmed.toLowerCase();
}

/**
 * Derives a stable cache key for an entitlement account reference.
 *
 * Produces one of five deterministic keys:
 * - `account:<trimmed accountId>::email:<lowercased trimmed email>` when both are present,
 * - `email:<lowercased trimmed email>` when only `email` is present,
 * - `account:<trimmed accountId>::idx:<non-negative integer>` when `accountId` is present without email,
 * - `account:<trimmed accountId>` when only `accountId` is present and no index is available,
 * - `idx:<non-negative integer>` otherwise (index defaults to 0).
 *
 * This function is pure and concurrency-safe; it performs no I/O and is not affected by Windows filesystem semantics. It never serializes refresh tokens or other secrets into the returned key.
 *
 * @param ref - Reference identifying an account (may include `accountId`, `email`, or `index`)
 * @returns A deterministic string key prefixed with `account:`, `email:`, or `idx:` as described above
 */
export function resolveEntitlementAccountKey(ref: EntitlementAccountRef): string {
	const accountId = typeof ref.accountId === "string" ? ref.accountId.trim() : "";
	const hasIndex = Number.isFinite(ref.index);
	const index = hasIndex ? Math.max(0, Math.floor(ref.index ?? 0)) : 0;
	const email = normalizeEntitlementEmail(ref.email);
	if (accountId && email) return `account:${accountId}::email:${email}`;
	if (email) return `email:${email}`;
	if (accountId && hasIndex) return `account:${accountId}::idx:${index}`;
	if (accountId) return `account:${accountId}`;
	return `idx:${index}`;
}

export class EntitlementCache {
	private readonly blocksByAccount = new Map<string, Map<string, EntitlementBlock>>();

	markBlocked(
		accountKey: string,
		model: string,
		reason: EntitlementBlock["reason"],
		ttlMs = DEFAULT_BLOCK_TTL_MS,
		now = Date.now(),
	): void {
		const normalizedModel = normalizeModel(model);
		if (!accountKey || !normalizedModel) return;
		const normalizedTtlMs =
			typeof ttlMs === "number" && Number.isFinite(ttlMs)
				? Math.max(1_000, Math.floor(ttlMs))
				: DEFAULT_BLOCK_TTL_MS;
		if (this.blocksByAccount.size >= MAX_ACCOUNT_BUCKETS && !this.blocksByAccount.has(accountKey)) {
			const first = this.blocksByAccount.keys().next().value;
			if (typeof first === "string") this.blocksByAccount.delete(first);
		}
		const existing = this.blocksByAccount.get(accountKey) ?? new Map<string, EntitlementBlock>();
		existing.set(normalizedModel, {
			model: normalizedModel,
			blockedUntil: now + normalizedTtlMs,
			reason,
			updatedAt: now,
		});
		this.blocksByAccount.set(accountKey, existing);
	}

	clear(accountKey: string, model?: string): void {
		if (!accountKey) return;
		if (!model) {
			this.blocksByAccount.delete(accountKey);
			return;
		}
		const normalizedModel = normalizeModel(model);
		if (!normalizedModel) return;
		const accountBlocks = this.blocksByAccount.get(accountKey);
		if (!accountBlocks) return;
		accountBlocks.delete(normalizedModel);
		if (accountBlocks.size === 0) this.blocksByAccount.delete(accountKey);
	}

	isBlocked(accountKey: string, model: string, now = Date.now()): { blocked: boolean; waitMs: number; reason?: EntitlementBlock["reason"] } {
		const normalizedModel = normalizeModel(model);
		if (!accountKey || !normalizedModel) return { blocked: false, waitMs: 0 };
		const accountBlocks = this.blocksByAccount.get(accountKey);
		if (!accountBlocks) return { blocked: false, waitMs: 0 };
		const block = accountBlocks.get(normalizedModel);
		if (!block) return { blocked: false, waitMs: 0 };
		if (block.blockedUntil <= now) {
			accountBlocks.delete(normalizedModel);
			if (accountBlocks.size === 0) this.blocksByAccount.delete(accountKey);
			return { blocked: false, waitMs: 0 };
		}
		return {
			blocked: true,
			waitMs: Math.max(0, block.blockedUntil - now),
			reason: block.reason,
		};
	}

	prune(now = Date.now()): number {
		let removed = 0;
		for (const [accountKey, blocks] of this.blocksByAccount.entries()) {
			for (const [model, block] of blocks.entries()) {
				if (block.blockedUntil <= now) {
					blocks.delete(model);
					removed += 1;
				}
			}
			if (blocks.size === 0) {
				this.blocksByAccount.delete(accountKey);
			}
		}
		if (removed > 0) {
			log.debug("Pruned entitlement cache", { removed });
		}
		return removed;
	}

	snapshot(now = Date.now()): EntitlementCacheSnapshot {
		this.prune(now);
		const accounts: Record<string, EntitlementBlock[]> = {};
		for (const [accountKey, blocks] of this.blocksByAccount.entries()) {
			accounts[accountKey] = Array.from(blocks.values())
				.map((block) => ({ ...block }))
				.sort((a, b) => a.model.localeCompare(b.model));
		}
		return { accounts };
	}
}
