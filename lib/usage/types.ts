export type UsageLedgerSource =
	| "runtime-proxy"
	| "plugin-host"
	| "local-bridge"
	| "cli"
	| "unknown";

export type UsageLedgerOperation =
	| "responses"
	| "models"
	| "auth-refresh"
	| "diagnostic"
	| "unknown";

export type UsageLedgerOutcome =
	| "success"
	| "failure"
	| "blocked"
	| "cancelled";

export interface UsageTokenCounts {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
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

