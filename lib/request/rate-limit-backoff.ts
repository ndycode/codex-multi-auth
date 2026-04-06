import type { RateLimitReason } from "../accounts.js";

export interface RateLimitBackoffResult {
	attempt: number;
	delayMs: number;
	isDuplicate: boolean;
	reason?: RateLimitReason;
}

/**
 * Rate limit state tracking with time-window deduplication.
 *
 * Matches the antigravity plugin behavior:
 * - Deduplicate concurrent 429s so parallel requests don't over-increment backoff.
 * - Reset backoff after a quiet period.
 */
const RATE_LIMIT_DEDUP_WINDOW_MS = 2000;
const RATE_LIMIT_STATE_RESET_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;
const RATE_LIMIT_BACKOFF_JITTER_FACTOR = 0.2;

export const RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS = 5000;

/**
 * Maximum number of consecutive short-cooldown 429 retries before
 * falling through to the long-cooldown rotation path.
 *
 * Without this bound, an upstream that perpetually returns short
 * Retry-After values (≤ RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS) would
 * keep the request loop spinning on the same account indefinitely.
 */
export const MAX_SHORT_RETRY_ATTEMPTS = 3;

interface RateLimitState {
	consecutive429: number;
	lastAt: number;
	quotaKey: string;
	lastDelayMs: number;
}

const rateLimitStateByAccountQuota = new Map<string, RateLimitState>();

function normalizeDelayMs(value: number | null | undefined, fallback: number): number {
	const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(0, Math.floor(candidate));
}

function addBackoffJitter(baseMs: number): number {
	const jitter = baseMs * RATE_LIMIT_BACKOFF_JITTER_FACTOR * (Math.random() * 2 - 1);
	return Math.max(0, Math.floor(baseMs + jitter));
}

function pruneStaleRateLimitState(): void {
	const now = Date.now();
	for (const [key, state] of rateLimitStateByAccountQuota) {
		if (now - state.lastAt > RATE_LIMIT_STATE_RESET_MS) {
			rateLimitStateByAccountQuota.delete(key);
		}
	}
}

/**
 * Compute rate-limit backoff for an account+quota key.
 */
export function getRateLimitBackoff(
	accountIndex: number,
	quotaKey: string,
	serverRetryAfterMs: number | null | undefined,
): RateLimitBackoffResult {
	pruneStaleRateLimitState();
	const now = Date.now();
	const stateKey = `${accountIndex}:${quotaKey}`;
	const previous = rateLimitStateByAccountQuota.get(stateKey);

	const baseDelay = normalizeDelayMs(serverRetryAfterMs, 1000);

	if (previous && now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS) {
		return {
			attempt: previous.consecutive429,
			delayMs: previous.lastDelayMs,
			isDuplicate: true,
		};
	}

	const attempt =
		previous && now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS
			? previous.consecutive429 + 1
			: 1;

	const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
	const jitteredDelay = Math.min(addBackoffJitter(backoffDelay), MAX_BACKOFF_MS);
	const delayMs = Math.max(baseDelay, jitteredDelay);
	rateLimitStateByAccountQuota.set(stateKey, {
		consecutive429: attempt,
		lastAt: now,
		quotaKey,
		lastDelayMs: delayMs,
	});
	return {
		attempt,
		delayMs,
		isDuplicate: false,
	};
}

export function resetRateLimitBackoff(accountIndex: number, quotaKey: string): void {
	rateLimitStateByAccountQuota.delete(`${accountIndex}:${quotaKey}`);
}

export function clearRateLimitBackoffState(): void {
	rateLimitStateByAccountQuota.clear();
}

const BACKOFF_MULTIPLIERS: Record<RateLimitReason, number> = {
	quota: 3.0,
	tokens: 1.5,
	concurrent: 0.5,
	unknown: 1.0,
};

export function calculateBackoffMs(
	baseDelayMs: number,
	attempt: number,
	reason: RateLimitReason = "unknown",
): number {
	const multiplier = BACKOFF_MULTIPLIERS[reason] ?? 1.0;
	const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
	return Math.min(Math.floor(exponentialDelay * multiplier), MAX_BACKOFF_MS);
}

export interface RateLimitBackoffWithReasonParams {
	accountIndex: number;
	quotaKey: string;
	serverRetryAfterMs: number | null | undefined;
	reason?: RateLimitReason;
}

export function getRateLimitBackoffWithReason(
	params: RateLimitBackoffWithReasonParams,
): RateLimitBackoffResult;
export function getRateLimitBackoffWithReason(
	accountIndex: number,
	quotaKey: string,
	serverRetryAfterMs: number | null | undefined,
	reason?: RateLimitReason,
): RateLimitBackoffResult;
export function getRateLimitBackoffWithReason(
	accountIndexOrParams: number | RateLimitBackoffWithReasonParams,
	quotaKey?: string,
	serverRetryAfterMs?: number | null | undefined,
	reason: RateLimitReason = "unknown",
): RateLimitBackoffResult {
	const useNamedParams = typeof accountIndexOrParams !== "number";
	const resolvedAccountIndex = useNamedParams
		? accountIndexOrParams.accountIndex
		: accountIndexOrParams;
	const resolvedQuotaKey = useNamedParams
		? accountIndexOrParams.quotaKey
		: quotaKey;
	const resolvedServerRetryAfterMs = useNamedParams
		? accountIndexOrParams.serverRetryAfterMs
		: serverRetryAfterMs;
	const resolvedReason = useNamedParams
		? (accountIndexOrParams.reason ?? "unknown")
		: reason;
	if (!Number.isInteger(resolvedAccountIndex) || resolvedAccountIndex < 0) {
		throw new TypeError(
			"getRateLimitBackoffWithReason requires a non-negative integer accountIndex",
		);
	}
	if (typeof resolvedQuotaKey !== "string" || resolvedQuotaKey.trim().length === 0) {
		throw new TypeError("getRateLimitBackoffWithReason requires a non-empty quotaKey");
	}
	const normalizedQuotaKey = resolvedQuotaKey.trim();
	const result = getRateLimitBackoff(
		resolvedAccountIndex,
		normalizedQuotaKey,
		resolvedServerRetryAfterMs,
	);
	const adjustedDelay = calculateBackoffMs(
		result.delayMs,
		result.attempt,
		resolvedReason,
	);
	return {
		...result,
		delayMs: adjustedDelay,
		reason: resolvedReason,
	};
}
