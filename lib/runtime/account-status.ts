import { getQuotaKey } from "../accounts/rate-limits.js";
import { LUNA_RESERVE_MODEL } from "../constants.js";
import type { ModelFamily } from "../prompts/codex.js";

export function resolveActiveIndex(
	storage: {
		activeIndex: number;
		activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
		accounts: unknown[];
	},
	family: ModelFamily = "codex",
): number {
	const total = storage.accounts.length;
	if (total === 0) return 0;
	const rawCandidate =
		storage.activeIndexByFamily?.[family] ?? storage.activeIndex;
	const raw = Number.isFinite(rawCandidate) ? rawCandidate : 0;
	return Math.max(0, Math.min(raw, total - 1));
}

export function getRateLimitResetTimeForFamily(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily,
): number | null {
	const times = account.rateLimitResetTimes;
	if (!times) return null;

	let minReset: number | null = null;
	const prefix = `${family}:`;
	for (const [key, value] of Object.entries(times)) {
		if (typeof value !== "number") continue;
		if (value <= now) continue;
		if (key !== family && !key.startsWith(prefix)) continue;
		if (minReset === null || value < minReset) {
			minReset = value;
		}
	}

	return minReset;
}

/** The value when it is still a live bound at `now`, otherwise null. */
function activeBound(value: number | undefined, now: number): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return value > now ? value : null;
}

/** The later of two bounds, treating null as "does not bound". */
function laterBound(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return a > b ? a : b;
}

export interface AccountRecoveryBounds {
	/**
	 * The moment the account becomes usable again: `rateLimitAtMs` widened by
	 * any active cooldown, because the account stays skipped while ANY gating
	 * record is active. Null when nothing bounds recovery.
	 */
	recoveryAtMs: number | null;
	/**
	 * The rate-limit records' own contribution to `recoveryAtMs`, cooldowns
	 * excluded. The pinned-503 uses it to decide whether the deadline it
	 * advertises is in fact the rate limit's own reset — with a breaker or
	 * cooldown ending later, the full recovery bound outlives the rate limit
	 * and must not be worded as its reset. Null when no rate-limit record
	 * gates the request.
	 */
	rateLimitAtMs: number | null;
}

/**
 * Both recovery bounds for a `family`/`model` request, from ONE pass over
 * `rateLimitResetTimes` against a single `now`.
 *
 * Two deliberate differences from getRateLimitResetTimeForFamily, whose
 * earliest-reset answer feeds wait displays: the latest bound wins, because
 * the earliest reset would send clients back into a 503 — and only the keys
 * selection consults (`family`, plus `family:<model>` when a model is known;
 * see isRateLimitedForFamily) may contribute, because another model's record
 * does not block this request and would overstate its recovery.
 *
 * A caller that needs both bounds must take them from one call. Measuring
 * them separately lets a record expire between the two walks, which reports
 * a rate-limited account as if a cooldown bounded its recovery.
 */
export function getAccountRecoveryBoundsForFamily(
	account: {
		rateLimitResetTimes?: Record<string, number | undefined>;
		coolingDownUntil?: number;
	},
	now: number,
	family: ModelFamily,
	model?: string | null,
): AccountRecoveryBounds {
	const times = account.rateLimitResetTimes;
	const rateLimitAtMs = times
		? laterBound(
				model === LUNA_RESERVE_MODEL ? null : activeBound(times[getQuotaKey(family)], now),
				model ? activeBound(times[getQuotaKey(family, model)], now) : null,
			)
		: null;
	return {
		rateLimitAtMs,
		recoveryAtMs: laterBound(
			rateLimitAtMs,
			activeBound(account.coolingDownUntil, now),
		),
	};
}

/** The `recoveryAtMs` bound alone; see getAccountRecoveryBoundsForFamily. */
export function getAccountRecoveryTimeForFamily(
	account: {
		rateLimitResetTimes?: Record<string, number | undefined>;
		coolingDownUntil?: number;
	},
	now: number,
	family: ModelFamily,
	model?: string | null,
): number | null {
	return getAccountRecoveryBoundsForFamily(account, now, family, model)
		.recoveryAtMs;
}

/** The `rateLimitAtMs` bound alone; see getAccountRecoveryBoundsForFamily. */
export function getRateLimitRecoveryTimeForFamily(
	account: {
		rateLimitResetTimes?: Record<string, number | undefined>;
	},
	now: number,
	family: ModelFamily,
	model?: string | null,
): number | null {
	return getAccountRecoveryBoundsForFamily(account, now, family, model)
		.rateLimitAtMs;
}

export function formatRateLimitEntry(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	formatWaitTime: (ms: number) => string,
	family: ModelFamily = "codex",
): string | null {
	const resetAt = getRateLimitResetTimeForFamily(account, now, family);
	if (typeof resetAt !== "number") return null;
	const remaining = resetAt - now;
	if (remaining <= 0) return null;
	return `resets in ${formatWaitTime(remaining)}`;
}

/**
 * When a request for `family`/`model` stops being rate limited: the LATEST
 * active bound among exactly the two keys selection consults — the family-wide
 * key and `family:<model>` (see `isRateLimitedForFamily`). Null when neither is
 * active.
 *
 * Deliberately narrower and later than `getRateLimitResetTimeForFamily`, whose
 * earliest-reset-across-every-`family:*`-key answer feeds wait displays and
 * model-less callers:
 *
 * - narrower, because `markRateLimitedWithReason` keys token/concurrency limits
 *   under `family:<model>`, and a sibling model's record does not gate this
 *   request — folding it in reports a delay the runtime proxy would not impose;
 * - later, because the account stays skipped while EITHER key is active, so the
 *   earliest reset understates the wait when both are set.
 *
 * Requires a model by construction: a caller without one cannot know which
 * model key applies and should keep the family-wide union above.
 */
export function getRateLimitResetTimeForModel(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily,
	model: string,
): number | null {
	return getAccountRecoveryBoundsForFamily(account, now, family, model)
		.rateLimitAtMs;
}
