export interface RetryAllAccountsRateLimitDecisionInput {
	enabled: boolean;
	accountCount: number;
	waitMs: number;
	maxWaitMs: number;
	currentRetryCount: number;
	maxRetries: number;
	accumulatedWaitMs: number;
	absoluteCeilingMs: number;
}

export type RetryAllAccountsRateLimitDecisionReason =
	| "allowed"
	| "disabled"
	| "no-accounts"
	| "no-wait"
	| "wait-exceeds-max"
	| "retry-limit-reached"
	| "absolute-ceiling-exceeded";

export interface RetryAllAccountsRateLimitDecision {
	shouldRetry: boolean;
	reason: RetryAllAccountsRateLimitDecisionReason;
}

function clampNonNegative(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function normalizeRetryLimit(value: number): number {
	if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
	// Negative finite values are treated as "no retries allowed".
	return clampNonNegative(value);
}

/**
 * Decide whether "retry all accounts when rate-limited" should run for the current loop.
 *
 * This helper is pure and deterministic so retry behavior can be tested without
 * exercising the full request pipeline.
 */
export function decideRetryAllAccountsRateLimited(
	input: RetryAllAccountsRateLimitDecisionInput,
): RetryAllAccountsRateLimitDecision {
	const accountCount = clampNonNegative(input.accountCount);
	const waitMs = clampNonNegative(input.waitMs);
	const maxWaitMs = clampNonNegative(input.maxWaitMs);
	const currentRetryCount = clampNonNegative(input.currentRetryCount);
	const maxRetries = normalizeRetryLimit(input.maxRetries);
	const accumulatedWaitMs = clampNonNegative(input.accumulatedWaitMs);
	const absoluteCeilingMs = clampNonNegative(input.absoluteCeilingMs);

	if (!input.enabled) {
		return { shouldRetry: false, reason: "disabled" };
	}
	if (accountCount === 0) {
		return { shouldRetry: false, reason: "no-accounts" };
	}
	if (waitMs === 0) {
		return { shouldRetry: false, reason: "no-wait" };
	}
	if (maxWaitMs > 0 && waitMs > maxWaitMs) {
		return { shouldRetry: false, reason: "wait-exceeds-max" };
	}
	if (currentRetryCount >= maxRetries) {
		return { shouldRetry: false, reason: "retry-limit-reached" };
	}
	if (absoluteCeilingMs > 0 && accumulatedWaitMs + waitMs > absoluteCeilingMs) {
		return { shouldRetry: false, reason: "absolute-ceiling-exceeded" };
	}
	return { shouldRetry: true, reason: "allowed" };
}
