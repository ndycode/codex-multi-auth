/**
 * Rotation Strategy Module
 *
 * Implements health-based account selection with token bucket rate limiting.
 * Ported from antigravity-auth rotation logic for optimal account rotation
 * when rate limits are encountered.
 */

import { createLogger } from "./logger.js";

const log = createLogger("rotation");

// ============================================================================
// Health Score Tracking
// ============================================================================

export interface HealthScoreConfig {
	/** Points added on successful request */
	successDelta: number;
	/** Points deducted on rate limit (negative) */
	rateLimitDelta: number;
	/** Points deducted on other failures (negative) */
	failureDelta: number;
	/** Maximum health score */
	maxScore: number;
	/** Minimum health score */
	minScore: number;
	/** Points recovered per hour of inactivity */
	passiveRecoveryPerHour: number;
}

export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
	successDelta: 1,
	rateLimitDelta: -10,
	failureDelta: -20,
	maxScore: 100,
	minScore: 0,
	passiveRecoveryPerHour: 2,
};

interface HealthEntry {
	score: number;
	lastUpdated: number;
	consecutiveFailures: number;
}

type TrackerKey = number | string;

function normalizeTrackerKey(
	accountKey: TrackerKey,
	quotaKey?: string,
): string {
	const normalizedKey =
		typeof accountKey === "number" ? `${accountKey}` : accountKey;
	return JSON.stringify([normalizedKey, quotaKey ?? null]);
}

/**
 * Tracks health scores for accounts to prioritize healthy accounts.
 * Accounts with higher health scores are preferred for selection.
 */
export class HealthScoreTracker {
	private entries: Map<string, HealthEntry> = new Map();
	private config: HealthScoreConfig;

	constructor(config: Partial<HealthScoreConfig> = {}) {
		this.config = { ...DEFAULT_HEALTH_SCORE_CONFIG, ...config };
	}

	private getKey(accountKey: TrackerKey, quotaKey?: string): string {
		return normalizeTrackerKey(accountKey, quotaKey);
	}

	private applyPassiveRecovery(entry: HealthEntry): number {
		const now = Date.now();
		const hoursSinceUpdate = (now - entry.lastUpdated) / (1000 * 60 * 60);
		const recovery = hoursSinceUpdate * this.config.passiveRecoveryPerHour;
		return Math.min(entry.score + recovery, this.config.maxScore);
	}

	getScore(accountKey: TrackerKey, quotaKey?: string): number {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.entries.get(key);
		if (!entry) return this.config.maxScore;
		return this.applyPassiveRecovery(entry);
	}

	getConsecutiveFailures(accountKey: TrackerKey, quotaKey?: string): number {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.entries.get(key);
		return entry?.consecutiveFailures ?? 0;
	}

	recordSuccess(accountKey: TrackerKey, quotaKey?: string): void {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.entries.get(key);
		const baseScore = entry
			? this.applyPassiveRecovery(entry)
			: this.config.maxScore;
		const newScore = Math.min(
			baseScore + this.config.successDelta,
			this.config.maxScore,
		);
		this.entries.set(key, {
			score: newScore,
			lastUpdated: Date.now(),
			consecutiveFailures: 0,
		});
	}

	recordRateLimit(accountKey: TrackerKey, quotaKey?: string): void {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.entries.get(key);
		const baseScore = entry
			? this.applyPassiveRecovery(entry)
			: this.config.maxScore;
		const newScore = Math.max(
			baseScore + this.config.rateLimitDelta,
			this.config.minScore,
		);
		this.entries.set(key, {
			score: newScore,
			lastUpdated: Date.now(),
			consecutiveFailures: (entry?.consecutiveFailures ?? 0) + 1,
		});
	}

	recordFailure(accountKey: TrackerKey, quotaKey?: string): void {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.entries.get(key);
		const baseScore = entry
			? this.applyPassiveRecovery(entry)
			: this.config.maxScore;
		const newScore = Math.max(
			baseScore + this.config.failureDelta,
			this.config.minScore,
		);
		this.entries.set(key, {
			score: newScore,
			lastUpdated: Date.now(),
			consecutiveFailures: (entry?.consecutiveFailures ?? 0) + 1,
		});
	}

	reset(accountKey: TrackerKey, quotaKey?: string): void {
		const key = this.getKey(accountKey, quotaKey);
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}

// ============================================================================
// Token Bucket Rate Limiting
// ============================================================================

export interface TokenBucketConfig {
	/** Maximum tokens in bucket */
	maxTokens: number;
	/** Tokens regenerated per minute */
	tokensPerMinute: number;
}

export const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = {
	maxTokens: 50,
	tokensPerMinute: 6,
};

const TOKEN_REFUND_WINDOW_MS = 30_000;

interface TokenBucketEntry {
	tokens: number;
	lastRefill: number;
	consumptions: number[];
}

/**
 * Client-side token bucket for rate limiting requests per account.
 * Prevents sending requests to accounts that are likely to be rate-limited.
 */
export class TokenBucketTracker {
	private buckets: Map<string, TokenBucketEntry> = new Map();
	private config: TokenBucketConfig;

	constructor(config: Partial<TokenBucketConfig> = {}) {
		this.config = { ...DEFAULT_TOKEN_BUCKET_CONFIG, ...config };
	}

	private getKey(accountKey: TrackerKey, quotaKey?: string): string {
		return normalizeTrackerKey(accountKey, quotaKey);
	}

	private refillTokens(entry: TokenBucketEntry): number {
		const now = Date.now();
		const minutesSinceRefill = (now - entry.lastRefill) / (1000 * 60);
		const tokensToAdd = minutesSinceRefill * this.config.tokensPerMinute;
		return Math.min(entry.tokens + tokensToAdd, this.config.maxTokens);
	}

	getTokens(accountKey: TrackerKey, quotaKey?: string): number {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.buckets.get(key);
		if (!entry) return this.config.maxTokens;
		return this.refillTokens(entry);
	}

	/**
	 * Attempt to consume a token. Returns true if successful, false if bucket is empty.
	 */
	tryConsume(accountKey: TrackerKey, quotaKey?: string): boolean {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.buckets.get(key);
		const currentTokens = entry
			? this.refillTokens(entry)
			: this.config.maxTokens;

		if (currentTokens < 1) {
			return false;
		}

		const now = Date.now();
		const cutoff = now - TOKEN_REFUND_WINDOW_MS;
		const consumptions = (entry?.consumptions ?? []).filter(
			(timestamp) => timestamp >= cutoff,
		);
		consumptions.push(now);

		this.buckets.set(key, {
			tokens: currentTokens - 1,
			lastRefill: now,
			consumptions,
		});
		return true;
	}

	/**
	 * Attempt to refund a token consumed within the refund window.
	 * Use this when a request fails due to network errors (not rate limits).
	 * @returns true if refund was successful, false if no valid consumption found
	 */
	refundToken(accountKey: TrackerKey, quotaKey?: string): boolean {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.buckets.get(key);
		if (!entry || entry.consumptions.length === 0) return false;

		const now = Date.now();
		const cutoff = now - TOKEN_REFUND_WINDOW_MS;

		const validIndex = entry.consumptions.findIndex(
			(timestamp) => timestamp >= cutoff,
		);
		if (validIndex === -1) return false;

		entry.consumptions.splice(validIndex, 1);
		const currentTokens = this.refillTokens(entry);
		this.buckets.set(key, {
			tokens: Math.min(currentTokens + 1, this.config.maxTokens),
			lastRefill: now,
			consumptions: entry.consumptions,
		});

		return true;
	}

	/**
	 * Drain tokens on rate limit to prevent immediate retries.
	 */
	drain(
		accountKey: TrackerKey,
		quotaKey?: string,
		drainAmount: number = 10,
	): void {
		const key = this.getKey(accountKey, quotaKey);
		const entry = this.buckets.get(key);
		const currentTokens = entry
			? this.refillTokens(entry)
			: this.config.maxTokens;
		this.buckets.set(key, {
			tokens: Math.max(0, currentTokens - drainAmount),
			lastRefill: Date.now(),
			consumptions: entry?.consumptions ?? [],
		});
	}

	reset(accountKey: TrackerKey, quotaKey?: string): void {
		const key = this.getKey(accountKey, quotaKey);
		this.buckets.delete(key);
	}

	clear(): void {
		this.buckets.clear();
	}
}

// ============================================================================
// Hybrid Account Selection
// ============================================================================

export interface AccountWithMetrics {
	index: number;
	trackerKey?: TrackerKey;
	isAvailable: boolean;
	lastUsed: number;
}

export interface HybridSelectionConfig {
	/** Weight for health score (default: 2) */
	healthWeight: number;
	/** Weight for token count (default: 5) */
	tokenWeight: number;
	/** Weight for freshness/last used (default: 0.1) */
	freshnessWeight: number;
}

export const DEFAULT_HYBRID_SELECTION_CONFIG: HybridSelectionConfig = {
	healthWeight: 2,
	tokenWeight: 5,
	freshnessWeight: 2.0,
};

/**
 * Selects the best account using a hybrid scoring strategy.
 *
 * Score = (health * healthWeight) + (tokens * tokenWeight) + (freshness * freshnessWeight)
 *
 * Where:
 * - health: Account health score (0-100)
 * - tokens: Available tokens in bucket (0-maxTokens)
 * - freshness: Hours since last used (higher = more fresh for rotation)
 */
export interface HybridSelectionOptions {
	pidOffsetEnabled?: boolean;
	scoreBoostByAccount?: Record<number, number>;
}

/**
 * Named-parameter alternative for selectHybridAccount to avoid brittle positional arguments.
 */
export interface SelectHybridAccountParams {
	accounts: AccountWithMetrics[];
	healthTracker: HealthScoreTracker;
	tokenTracker: TokenBucketTracker;
	quotaKey?: string;
	config?: Partial<HybridSelectionConfig>;
	options?: HybridSelectionOptions;
}

/**
 * Selects the best account from a set using a weighted hybrid score composed of health, token availability, and freshness.
 *
 * @param accounts - Candidate accounts with availability (`isAvailable`) and last-used timestamp (`lastUsed`); when none are available the least-recently-used account is returned.
 * @param healthTracker - Tracker used to obtain per-account health scores (scoped by `quotaKey` when provided).
 * @param tokenTracker - Tracker used to obtain per-account token counts (scoped by `quotaKey` when provided). Logged token values are rounded for telemetry and sensitive tokens are not emitted.
 * @param quotaKey - Optional quota key to scope health and token lookups.
 * @param config - Partial selection weights that override defaults (healthWeight, tokenWeight, freshnessWeight).
 * @param options - Selection options. `pidOffsetEnabled` adds a small PID-based deterministic offset to distribute selection across processes. `scoreBoostByAccount` is an optional per-account numeric boost keyed by account index.
 * @returns The chosen AccountWithMetrics for the next request, or `null` if no accounts exist.
 *
 * Concurrency & environment notes:
 * - Selection is deterministic given the same inputs except when `pidOffsetEnabled` is used to bias selection per-process.
 * - The function is purely in-memory and performs no filesystem operations (no Windows filesystem considerations).
 */
export function selectHybridAccount(
	params: SelectHybridAccountParams,
): AccountWithMetrics | null;
export function selectHybridAccount(
	accounts: AccountWithMetrics[],
	healthTracker: HealthScoreTracker,
	tokenTracker: TokenBucketTracker,
	quotaKey?: string,
	config?: Partial<HybridSelectionConfig>,
	options?: HybridSelectionOptions,
): AccountWithMetrics | null;
export function selectHybridAccount(
	accountsOrParams: AccountWithMetrics[] | SelectHybridAccountParams,
	healthTracker?: HealthScoreTracker,
	tokenTracker?: TokenBucketTracker,
	quotaKey?: string,
	config: Partial<HybridSelectionConfig> = {},
	options: HybridSelectionOptions = {},
): AccountWithMetrics | null {
	const namedParams =
		!Array.isArray(accountsOrParams) &&
		accountsOrParams !== null &&
		typeof accountsOrParams === "object"
			? accountsOrParams
			: null;
	const resolvedAccounts = namedParams
		? namedParams.accounts
		: accountsOrParams;
	const resolvedHealthTracker = namedParams
		? namedParams.healthTracker
		: healthTracker;
	const resolvedTokenTracker = namedParams
		? namedParams.tokenTracker
		: tokenTracker;
	const resolvedQuotaKey = namedParams ? namedParams.quotaKey : quotaKey;
	const resolvedConfig = namedParams ? (namedParams.config ?? {}) : config;
	const resolvedOptions = namedParams ? (namedParams.options ?? {}) : options;

	if (!Array.isArray(resolvedAccounts)) {
		throw new TypeError("selectHybridAccount requires accounts to be an array");
	}
	if (!resolvedHealthTracker || !resolvedTokenTracker) {
		throw new TypeError(
			"selectHybridAccount requires healthTracker and tokenTracker",
		);
	}

	const cfg = { ...DEFAULT_HYBRID_SELECTION_CONFIG, ...resolvedConfig };
	const available = resolvedAccounts.filter((a) => a.isAvailable);

	// Contract: if NO account is currently available (all cooling down, rate-limited,
	// circuit-open, or otherwise blocked) the selector returns null rather than
	// handing back a known-unavailable candidate via an LRU fallback. Returning an
	// unavailable account caused avoidable churn when the fetch loop trusted the
	// result without re-validating (AUDIT-H2 / D-01). The caller is now responsible
	// for surfacing the "no available accounts" condition (pool-wide cooldown,
	// fast-fail, etc.) instead of retrying through a blocked candidate.
	if (available.length === 0) {
		return null;
	}
	// istanbul ignore next -- defensive: available[0] always exists when length === 1
	if (available.length === 1) return available[0] ?? null;

	const now = Date.now();
	let bestAccount: AccountWithMetrics | null = null;
	let bestScore = -Infinity;

	// PID offset: distribute account selection across parallel processes
	// Each process gets a small deterministic bonus based on its PID
	const pidBonus = resolvedOptions.pidOffsetEnabled
		? (process.pid % 100) * 0.01
		: 0;

	for (const account of available) {
		const trackerKey = account.trackerKey ?? account.index;
		const health = resolvedHealthTracker.getScore(trackerKey, resolvedQuotaKey);
		const tokens = resolvedTokenTracker.getTokens(trackerKey, resolvedQuotaKey);
		const hoursSinceUsed = (now - account.lastUsed) / (1000 * 60 * 60);

		const capabilityBoost =
			typeof resolvedOptions.scoreBoostByAccount?.[account.index] === "number"
				? (resolvedOptions.scoreBoostByAccount[account.index] ?? 0)
				: 0;
		const safeCapabilityBoost = Number.isFinite(capabilityBoost)
			? capabilityBoost
			: 0;

		let score =
			health * cfg.healthWeight +
			tokens * cfg.tokenWeight +
			hoursSinceUsed * cfg.freshnessWeight +
			safeCapabilityBoost;

		// PID-based offset distributes selection across parallel agents
		if (resolvedOptions.pidOffsetEnabled) {
			score +=
				((account.index * 0.131 + pidBonus) % 1) * cfg.freshnessWeight * 0.1;
		}

		if (score > bestScore) {
			bestScore = score;
			bestAccount = account;
		}
	}

	if (bestAccount && available.length > 1) {
		const trackerKey = bestAccount.trackerKey ?? bestAccount.index;
		const health = resolvedHealthTracker.getScore(trackerKey, resolvedQuotaKey);
		const tokens = resolvedTokenTracker.getTokens(trackerKey, resolvedQuotaKey);
		log.debug("Selected account", {
			index: bestAccount.index,
			health: Math.round(health),
			tokens: Math.round(tokens),
			score: Math.round(bestScore),
			candidateCount: available.length,
		});
	}

	return bestAccount;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Adds random jitter to a delay value.
 * @param baseMs - Base delay in milliseconds
 * @param jitterFactor - Jitter factor (0-1), default 0.1 (10%)
 * @returns Delay with jitter applied
 */
export function addJitter(baseMs: number, jitterFactor: number = 0.1): number {
	const jitter = baseMs * jitterFactor * (Math.random() * 2 - 1);
	return Math.max(0, Math.floor(baseMs + jitter));
}

/**
 * Returns a random delay within a range.
 * @param minMs - Minimum delay in milliseconds
 * @param maxMs - Maximum delay in milliseconds
 * @returns Random delay within range
 */
export function randomDelay(minMs: number, maxMs: number): number {
	return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

export interface ExponentialBackoffOptions {
	attempt: number;
	baseMs?: number;
	maxMs?: number;
	jitterFactor?: number;
}

/**
 * Calculates exponential backoff with jitter.
 * @param attempt - Attempt number (1-based)
 * @param baseMs - Base delay in milliseconds
 * @param maxMs - Maximum delay in milliseconds
 * @param jitterFactor - Jitter factor (0-1)
 * @returns Backoff delay with jitter
 */
export function exponentialBackoff(options: ExponentialBackoffOptions): number;
export function exponentialBackoff(
	attempt: number,
	baseMs?: number,
	maxMs?: number,
	jitterFactor?: number,
): number;
export function exponentialBackoff(
	attemptOrOptions: number | ExponentialBackoffOptions,
	baseMs: number = 1000,
	maxMs: number = 60000,
	jitterFactor: number = 0.1,
): number {
	const useNamedParams =
		typeof attemptOrOptions === "object" && attemptOrOptions !== null;
	const normalizedAttempt = useNamedParams
		? (attemptOrOptions as ExponentialBackoffOptions).attempt
		: attemptOrOptions;
	const normalizedBaseMs = useNamedParams
		? ((attemptOrOptions as ExponentialBackoffOptions).baseMs ?? 1000)
		: baseMs;
	const normalizedMaxMs = useNamedParams
		? ((attemptOrOptions as ExponentialBackoffOptions).maxMs ?? 60000)
		: maxMs;
	const normalizedJitterFactor = useNamedParams
		? ((attemptOrOptions as ExponentialBackoffOptions).jitterFactor ?? 0.1)
		: jitterFactor;
	if (!Number.isInteger(normalizedAttempt) || normalizedAttempt < 1) {
		throw new TypeError(
			"exponentialBackoff requires attempt to be a positive integer",
		);
	}
	if (!Number.isFinite(normalizedBaseMs) || normalizedBaseMs < 0) {
		throw new TypeError(
			"exponentialBackoff requires baseMs to be a finite non-negative number",
		);
	}
	if (!Number.isFinite(normalizedMaxMs) || normalizedMaxMs < 0) {
		throw new TypeError(
			"exponentialBackoff requires maxMs to be a finite non-negative number",
		);
	}
	if (
		!Number.isFinite(normalizedJitterFactor) ||
		normalizedJitterFactor < 0 ||
		normalizedJitterFactor > 1
	) {
		throw new TypeError(
			"exponentialBackoff requires jitterFactor to be between 0 and 1",
		);
	}
	const delay = Math.min(
		normalizedBaseMs * Math.pow(2, normalizedAttempt - 1),
		normalizedMaxMs,
	);
	return addJitter(delay, normalizedJitterFactor);
}

// ============================================================================
// Singleton Instances
// ============================================================================

let healthTrackerInstance: HealthScoreTracker | null = null;
let tokenTrackerInstance: TokenBucketTracker | null = null;

export function getHealthTracker(
	config?: Partial<HealthScoreConfig>,
): HealthScoreTracker {
	if (!healthTrackerInstance) {
		healthTrackerInstance = new HealthScoreTracker(config);
	}
	return healthTrackerInstance;
}

export function getTokenTracker(
	config?: Partial<TokenBucketConfig>,
): TokenBucketTracker {
	if (!tokenTrackerInstance) {
		tokenTrackerInstance = new TokenBucketTracker(config);
	}
	return tokenTrackerInstance;
}

export function resetTrackers(): void {
	healthTrackerInstance?.clear();
	tokenTrackerInstance?.clear();
}
