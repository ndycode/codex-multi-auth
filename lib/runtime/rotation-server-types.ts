import type { QuotaCacheData } from "../quota-cache.js";
import type { ApiRouteCredential } from "../api-route-store.js";
import type { AccountStorageV3 } from "../storage.js";
import type { AccountManager } from "../accounts.js";
import type { ModelFamily } from "../prompts/codex.js";

export interface RuntimeRotationProxyServer {
	host: string;
	port: number;
	baseUrl: string;
	close: () => Promise<void>;
	getStatus: () => RuntimeRotationProxyStatus;
	/**
	 * Number of client sockets currently open against the proxy. The detached
	 * app helper uses it to tell a handed-off consumer from a stranded process;
	 * optional so a proxy shape without it degrades to activity-only accounting
	 * rather than failing to start.
	 */
	getOpenConnectionCount?: () => number;
}

export interface RuntimeRotationProxyStatus {
	streamQuotaUpdates?: number;
	lastStreamQuotaUpdateAt?: number;
 websocketConnections?: number;
 websocketUpstreamRequests?: number;
	startedAt: number;
	totalRequests: number;
	upstreamRequests: number;
	retries: number;
	rotations: number;
	streamsStarted: number;
	lastError: string | null;
	lastAccountIndex: number | null;
	lastAccountLabel: string | null;
	lastAccountId: string | null;
	/** Outgoing ChatGPT-Account-ID; distinct from the saved account binding. */
	lastRequestedWorkspaceId?: string | null;
	lastAccountUpdatedAt: number | null;
}

export interface RuntimeRotationProxyOptions {
	nativeOpenai?: boolean;
	/** Override the native credential reader for embedded hosts and tests. */
	readNativeAccountStorage?: () => Promise<AccountStorageV3 | null>;
	readApiRoutes?: () => Promise<ApiRouteCredential[]>;
	readSubscriptionQuota?: () => Promise<QuotaCacheData | null>;
	catalogAccount?: { email: string; accountId: string; };
	host?: string;
	port?: number;
	upstreamBaseUrl?: string;
	clientApiKey: string;
	accountManager?: AccountManager;
	fetchImpl?: typeof fetch;
	now?: () => number;
	quotaRemainingPercentThreshold?: number;
	maxRequestBodyBytes?: number;
	fetchTimeoutMs?: number;
	streamStallTimeoutMs?: number;
	/**
	 * Ephemeral, per-instance account pin (0-based) for a single invocation
	 * (issue #623: `codex-multi-auth-codex --account`). When set, this proxy
	 * routes every request to exactly this account and never rotates, without
	 * touching the persisted `switch` pin on disk. Falls back to
	 * `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` in the environment when omitted so
	 * the value survives the launcher -> detached app-helper process boundary.
	 */
	forcedAccountIndex?: number | null;
	/**
	 * Wall-clock ceiling on how long ONE request may wait out a
	 * "selected model is at capacity" response before giving up (issue #689).
	 * `0` disables the wait entirely. Falls back to
	 * `CODEX_MULTI_AUTH_MODEL_CAPACITY_RETRY_MS`, then to a 10 minute default.
	 */
	modelCapacityRetryMs?: number;
}

export interface RequestContext {
	body: Buffer;
	headers: Headers;
	method: "GET" | "POST";
	upstreamPath: string;
	model: string | null;
	family: ModelFamily;
	stream: boolean;
	sessionKey: string | null;
	/**
	 * `sessionKey` minus the `previous_response_id` fallback.
	 *
	 * `previous_response_id` changes on every turn, which is fine for session
	 * affinity (a fresh key just means "no pin yet") but wrong for anything
	 * that has to ACCUMULATE across turns: a per-turn key never finds what the
	 * previous turn stored, and leaves one dead map entry behind per request.
	 * Consumers that track state over a conversation use this instead, and
	 * no-op when it is null.
	 */
	stableSessionKey: string | null;
}

export type ExhaustionReason =
	| "rate-limit"
	| "server-error"
	| "network-error"
	| "auth-failure"
	| "budget"
	| "deactivated"
	| "no-account";
export type RuntimeProxyHttpError = Error & {
	statusCode: number;
	code: string;
};

export interface RuntimeRotationAccountIdentity {
	index: number;
	label: string;
	accountId: string | null;
	updatedAt: number;
}
