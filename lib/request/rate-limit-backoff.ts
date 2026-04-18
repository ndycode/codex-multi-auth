import type { RateLimitReason } from "../accounts.js";
import { DEFAULT_PLUGIN_CONFIG } from "../config.js";

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
const DEFAULT_RATE_LIMIT_DEDUP_WINDOW_MS =
	DEFAULT_PLUGIN_CONFIG.rateLimitDedupWindowMs ?? 2_000;
const DEFAULT_RATE_LIMIT_STATE_RESET_MS =
	DEFAULT_PLUGIN_CONFIG.rateLimitStateResetMs ?? 120_000;
const DEFAULT_MAX_BACKOFF_MS =
	DEFAULT_PLUGIN_CONFIG.rateLimitMaxBackoffMs ?? 60_000;
const DEFAULT_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS =
	DEFAULT_PLUGIN_CONFIG.rateLimitShortRetryThresholdMs ?? 5_000;
const RATE_LIMIT_BACKOFF_JITTER_FACTOR = 0.2;

interface RateLimitBackoffConfig {
	dedupWindowMs: number;
	stateResetMs: number;
	maxBackoffMs: number;
	shortRetryThresholdMs: number;
}

type StableAccountKey = string | null | undefined;

let rateLimitBackoffConfig: RateLimitBackoffConfig = {
	dedupWindowMs: DEFAULT_RATE_LIMIT_DEDUP_WINDOW_MS,
	stateResetMs: DEFAULT_RATE_LIMIT_STATE_RESET_MS,
	maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
	shortRetryThresholdMs: DEFAULT_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS,
};

export function configureRateLimitBackoff(
	overrides: Partial<RateLimitBackoffConfig> = {},
): void {
	if (
		typeof overrides.dedupWindowMs === "number" &&
		Number.isFinite(overrides.dedupWindowMs)
	) {
		rateLimitBackoffConfig.dedupWindowMs = Math.max(
			0,
			Math.floor(overrides.dedupWindowMs),
		);
	}
	if (
		typeof overrides.stateResetMs === "number" &&
		Number.isFinite(overrides.stateResetMs)
	) {
		rateLimitBackoffConfig.stateResetMs = Math.max(
			1_000,
			Math.floor(overrides.stateResetMs),
		);
	}
	if (
		typeof overrides.maxBackoffMs === "number" &&
		Number.isFinite(overrides.maxBackoffMs)
	) {
		rateLimitBackoffConfig.maxBackoffMs = Math.max(
			1_000,
			Math.floor(overrides.maxBackoffMs),
		);
	}
	if (
		typeof overrides.shortRetryThresholdMs === "number" &&
		Number.isFinite(overrides.shortRetryThresholdMs)
	) {
		rateLimitBackoffConfig.shortRetryThresholdMs = Math.max(
			0,
			Math.floor(overrides.shortRetryThresholdMs),
		);
	}
}

export function resetRateLimitBackoffConfig(): void {
	rateLimitBackoffConfig = {
		dedupWindowMs: DEFAULT_RATE_LIMIT_DEDUP_WINDOW_MS,
		stateResetMs: DEFAULT_RATE_LIMIT_STATE_RESET_MS,
		maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
		shortRetryThresholdMs: DEFAULT_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS,
	};
}

export function getRateLimitShortRetryThresholdMs(): number {
	return rateLimitBackoffConfig.shortRetryThresholdMs;
}

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

function resolveRateLimitStateKey(
	accountIndex: number,
	quotaKey: string,
	stableAccountKey?: StableAccountKey,
): string {
	const normalizedStableAccountKey = stableAccountKey?.trim();
	const accountStateKey =
		normalizedStableAccountKey && normalizedStableAccountKey.length > 0
			? normalizedStableAccountKey
			: `slot:${accountIndex}`;
	return `${accountStateKey}:${quotaKey}`;
}

function normalizeDelayMs(
	value: number | null | undefined,
	fallback: number,
): number {
	const candidate =
		typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.max(0, Math.floor(candidate));
}

function addBackoffJitter(baseMs: number): number {
	const jitter =
		baseMs * RATE_LIMIT_BACKOFF_JITTER_FACTOR * (Math.random() * 2 - 1);
	return Math.max(0, Math.floor(baseMs + jitter));
}

function pruneStaleRateLimitState(): void {
	const now = Date.now();
	for (const [key, state] of rateLimitStateByAccountQuota) {
		if (now - state.lastAt > rateLimitBackoffConfig.stateResetMs) {
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
	stableAccountKey?: StableAccountKey,
): RateLimitBackoffResult {
	pruneStaleRateLimitState();
	const now = Date.now();
	const stateKey = resolveRateLimitStateKey(
		accountIndex,
		quotaKey,
		stableAccountKey,
	);
	const previous = rateLimitStateByAccountQuota.get(stateKey);

	const baseDelay = normalizeDelayMs(serverRetryAfterMs, 1000);

	if (
		previous &&
		now - previous.lastAt < rateLimitBackoffConfig.dedupWindowMs
	) {
		return {
			attempt: previous.consecutive429,
			delayMs: previous.lastDelayMs,
			isDuplicate: true,
		};
	}

	const attempt =
		previous && now - previous.lastAt < rateLimitBackoffConfig.stateResetMs
			? previous.consecutive429 + 1
			: 1;

	const backoffDelay = Math.min(
		baseDelay * Math.pow(2, attempt - 1),
		rateLimitBackoffConfig.maxBackoffMs,
	);
	const jitteredDelay = Math.min(
		addBackoffJitter(backoffDelay),
		rateLimitBackoffConfig.maxBackoffMs,
	);
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

export function resetRateLimitBackoff(
	accountIndex: number,
	quotaKey: string,
	stableAccountKey?: StableAccountKey,
): void {
	rateLimitStateByAccountQuota.delete(
		resolveRateLimitStateKey(accountIndex, quotaKey, stableAccountKey),
	);
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

/**
 * Apply a reason-based multiplier to an already-exponential backoff delay.
 *
 * NOTE: `baseDelayMs` is expected to already incorporate any exponential
 * progression and jitter (as produced by `getRateLimitBackoff`). This
 * function intentionally does NOT re-apply `2^(attempt-1)`; doing so would
 * double-apply the exponential when chained with `getRateLimitBackoff`,
 * which previously caused delays to saturate at `maxBackoffMs` after just
 * two consecutive 429s (see audit finding REQ-HIGH-01).
 *
 * The `attempt` parameter is retained for API compatibility and potential
 * future use (e.g. reason-specific progression) but is not currently read.
 */
export function calculateBackoffMs(
	baseDelayMs: number,
	_attempt: number,
	reason: RateLimitReason = "unknown",
): number {
	const multiplier = BACKOFF_MULTIPLIERS[reason] ?? 1.0;
	return Math.min(
		Math.max(0, Math.floor(baseDelayMs * multiplier)),
		rateLimitBackoffConfig.maxBackoffMs,
	);
}

export interface RateLimitBackoffWithReasonParams {
	accountIndex: number;
	quotaKey: string;
	serverRetryAfterMs: number | null | undefined;
	reason?: RateLimitReason;
	stableAccountKey?: StableAccountKey;
}

export function getRateLimitBackoffWithReason(
	params: RateLimitBackoffWithReasonParams,
): RateLimitBackoffResult;
export function getRateLimitBackoffWithReason(
	accountIndex: number,
	quotaKey: string,
	serverRetryAfterMs: number | null | undefined,
	reason?: RateLimitReason,
	stableAccountKey?: StableAccountKey,
): RateLimitBackoffResult;
export function getRateLimitBackoffWithReason(
	accountIndexOrParams: number | RateLimitBackoffWithReasonParams,
	quotaKey?: string,
	serverRetryAfterMs?: number | null | undefined,
	reason: RateLimitReason = "unknown",
	stableAccountKey?: StableAccountKey,
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
	const resolvedStableAccountKey = useNamedParams
		? accountIndexOrParams.stableAccountKey
		: stableAccountKey;
	if (!Number.isInteger(resolvedAccountIndex) || resolvedAccountIndex < 0) {
		throw new TypeError(
			"getRateLimitBackoffWithReason requires a non-negative integer accountIndex",
		);
	}
	if (
		typeof resolvedQuotaKey !== "string" ||
		resolvedQuotaKey.trim().length === 0
	) {
		throw new TypeError(
			"getRateLimitBackoffWithReason requires a non-empty quotaKey",
		);
	}
	const normalizedQuotaKey = resolvedQuotaKey.trim();
	const result = getRateLimitBackoff(
		resolvedAccountIndex,
		normalizedQuotaKey,
		resolvedServerRetryAfterMs,
		resolvedStableAccountKey,
	);
	const normalizedBaseDelay = normalizeDelayMs(
		resolvedServerRetryAfterMs,
		1000,
	);
	// For the first fresh attempt, pass the un-jittered normalized base so the
	// deterministic portion of the reason multiplier is visible to callers.
	// For subsequent attempts (or duplicate-window hits), `result.delayMs`
	// already encodes the exponential progression + jitter from
	// `getRateLimitBackoff`, and `calculateBackoffMs` intentionally applies
	// only the reason multiplier so the exponential is NOT double-applied
	// (see audit finding REQ-HIGH-01).
	const adjustedDelay = calculateBackoffMs(
		result.attempt === 1 && !result.isDuplicate
			? normalizedBaseDelay
			: result.delayMs,
		result.attempt,
		resolvedReason,
	);
	return {
		...result,
		delayMs: adjustedDelay,
		reason: resolvedReason,
	};
}
