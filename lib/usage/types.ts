export type UsageLedgerSource =
	| "runtime-proxy"
	| "plugin-host"
	| "local-bridge"
	| "cli"
	| "unknown";

export type UsageLedgerOperation =
	| "responses"
	| "models"
	| "thread-goal"
	| "auth-refresh"
	| "diagnostic"
	| "unknown";

export type UsageLedgerOutcome =
	| "success"
	| "failure"
	| "blocked"
	| "cancelled";

/**
 * The service tier a response was actually billed at.
 *
 * OpenAI's Fast/priority tier costs more than standard (2x for GPT-6 Astra), so
 * a rate table with no tier dimension under-counts such a session. `standard`
 * and `default` are the same thing on the wire; anything this union does not
 * name is normalised to `unknown`, which is treated as unpriced rather than
 * assumed cheap.
 */
export const USAGE_SERVICE_TIERS = [
	"standard",
	"priority",
	"flex",
	"batch",
	"scale",
	"unknown",
] as const;

export type UsageServiceTier = (typeof USAGE_SERVICE_TIERS)[number];

/**
 * Narrow an unvalidated value to a known tier.
 *
 * The ledger is JSONL on disk and can be hand-edited, so a value read back from
 * it is untrusted. An unrecognised string reaching the pricer would be treated
 * as a tier with no rate and silently make every affected row unpriced.
 */
export function isKnownServiceTier(value: unknown): value is UsageServiceTier {
	return (
		typeof value === "string" &&
		(USAGE_SERVICE_TIERS as readonly string[]).includes(value)
	);
}

export interface UsageTokenCounts {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	/**
	 * Rides on the token counts rather than a separate parameter so it reaches
	 * the ledger through every existing path: the `onUsage` callback in
	 * `response-handler.ts` carries this shape, and both the streaming scanner
	 * and the non-streaming branch already funnel through
	 * `extractResponsesUsage`. Absent when the response did not report one,
	 * which is the common case and is priced as `standard`.
	 */
	serviceTier?: UsageServiceTier;
}

export interface UsageLedgerAccountRef {
	accountHash?: string;
	emailHash?: string;
	index?: number;
}

export interface UsageLedgerRow {
	version: 1;
	id: string;
	createdAt: number;
	source: UsageLedgerSource;
	operation: UsageLedgerOperation;
	outcome: UsageLedgerOutcome;
	model: string | null;
	projectKey: string | null;
	account: UsageLedgerAccountRef | null;
	requestId: string | null;
	statusCode: number | null;
	errorCode: string | null;
	durationMs: number | null;
	tokens: UsageTokenCounts;
	costUsd: number | null;
}

export interface UsageLedgerAppendInput {
	id?: string;
	createdAt?: number;
	source?: UsageLedgerSource;
	operation?: UsageLedgerOperation;
	outcome: UsageLedgerOutcome;
	model?: string | null;
	projectKey?: string | null;
	accountId?: string | null;
	email?: string | null;
	accountIndex?: number | null;
	requestId?: string | null;
	statusCode?: number | null;
	errorCode?: string | null;
	durationMs?: number | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	cachedInputTokens?: number | null;
	reasoningTokens?: number | null;
	totalTokens?: number | null;
	/**
	 * The tier the response reported. Absent means standard, which is what every
	 * rate in `MODEL_PRICING` is quoted at.
	 */
	serviceTier?: UsageServiceTier;
	costUsd?: number | null;
}

export type UsageSummaryGroupBy =
	| "model"
	| "account"
	| "project"
	| "outcome"
	| "day";

export interface UsageLedgerQuery {
	since?: number | Date | string;
	until?: number | Date | string;
	includeArchives?: boolean;
}

export interface UsageSummaryQuery extends UsageLedgerQuery {
	by?: UsageSummaryGroupBy;
}

export interface UsageSummaryBucket {
	key: string;
	requests: number;
	successes: number;
	failures: number;
	blocked: number;
	cancelled: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	/**
	 * Requests that consumed tokens but could not be priced, so `costUsd` is an
	 * UNDER-count by an unknown amount. A cost budget cannot be evaluated while
	 * this is above zero; see `evaluateBudgetGuard`.
	 */
	unpricedRequests: number;
}

export interface UsageSummary {
	since: number | null;
	until: number | null;
	by: UsageSummaryGroupBy;
	totals: UsageSummaryBucket;
	buckets: UsageSummaryBucket[];
}

export interface UsageLedgerPaths {
	dir: string;
	current: string;
}

