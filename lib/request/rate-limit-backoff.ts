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

export const RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS = 5000;

interface RateLimitState {
	consecutive429: number;
	lastAt: number;
	quotaKey: string;
}

const rateLimitStateByAccountQuota = new Map<string, RateLimitState>();

function normalizeDelayMs(value: number | null | undefined, fallback: number): number {
	const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(0, Math.floor(candidate));
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
		const backoffDelay = Math.min(
			baseDelay * Math.pow(2, previous.consecutive429 - 1),
			MAX_BACKOFF_MS,
		);
		return {
			attempt: previous.consecutive429,
			delayMs: Math.max(baseDelay, backoffDelay),
			isDuplicate: true,
		};
	}

	const attempt =
		previous && now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS
			? previous.consecutive429 + 1
			: 1;

	rateLimitStateByAccountQuota.set(stateKey, {
		consecutive429: attempt,
		lastAt: now,
		quotaKey,
	});

	const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
	return {
		attempt,
		delayMs: Math.max(baseDelay, backoffDelay),
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

export function getRateLimitBackoffWithReason(
	accountIndex: number,
	quotaKey: string,
	serverRetryAfterMs: number | null | undefined,
	reason: RateLimitReason = "unknown",
): RateLimitBackoffResult {
	const result = getRateLimitBackoff(accountIndex, quotaKey, serverRetryAfterMs);
	const adjustedDelay = calculateBackoffMs(result.delayMs, result.attempt, reason);
	return {
		...result,
		delayMs: adjustedDelay,
		reason,
	};
}
