import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
	AccountManager,
	extractAccountId,
	type ManagedAccount,
} from "./accounts.js";
import { withRoutingMutex } from "./routing-mutex.js";
import {
	getFetchTimeoutMs,
	getNetworkErrorCooldownMs,
	getRetryAllAccountsMaxRetries,
	getServerErrorCooldownMs,
	getSessionAffinity,
	getSessionAffinityMaxEntries,
	getSessionAffinityTtlMs,
	getStreamStallTimeoutMs,
	getMinRotationIntervalMs,
	getTokenInvalidationCooldownMs,
	getTokenRefreshSkewMs,
	getPidOffsetEnabled,
	getRoutingMutexMode,
	getSchedulingStrategy,
	loadPluginConfig,
} from "./config.js";
import {
	CODEX_BASE_URL,
	HTTP_STATUS,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
	URL_PATHS,
} from "./constants.js";
import { getModelFamily, type ModelFamily } from "./prompts/codex.js";
import { CURRENT_CODEX_MODEL } from "./request/helpers/model-map.js";
import {
	mutateRuntimeObservabilitySnapshot,
	recordRuntimeAccountRecovery,
	recordRuntimePoolExhaustion,
} from "./runtime/runtime-observability.js";
import {
	createRuntimeUsageRecorder,
	evaluateRuntimePolicy,
	loadRuntimePolicyState,
	type RuntimePolicyDecision,
} from "./policy/runtime-policy.js";
import { isWorkspaceDisabledError } from "./request/fetch-helpers.js";
import { createLogger, maskString, runWithCorrelationId } from "./logger.js";
import { CodexValidationError } from "./errors.js";
import {
	buildPinnedUnavailableErrorBody,
	buildTokenInvalidationBody,
	extractErrorCodeFromBody,
	getQuotaNearExhaustionWaitMs,
	isTokenInvalidationError,
	normalizeExhaustionStatus,
	parseRetryAfterBodyMs,
	parseRetryAfterHeaderMs,
} from "./request/rate-limit-decision.js";
import {
	forwardStreamingResponse,
	HOP_BY_HOP_HEADERS,
	readErrorBody,
	responseHeadersForClient,
	withTimeout,
} from "./request/stream-failover-runtime.js";
import { chooseAccount } from "./runtime/rotation-account-selection.js";
import {
	createRotationProxyState,
	recoverStaleRuntimeState,
	type RotationProxyState,
} from "./runtime/rotation-proxy-state.js";
import type {
	ExhaustionReason,
	RequestContext,
	RuntimeProxyHttpError,
	RuntimeRotationAccountIdentity,
	RuntimeRotationProxyOptions,
	RuntimeRotationProxyServer,
	RuntimeRotationProxyStatus,
} from "./runtime/rotation-server-types.js";
import { readStorageMetaFromDisk } from "./runtime/rotation-storage-meta.js";
import {
	applyMonotonicAuthCooldown,
	DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
	ensureFreshAccessToken,
} from "./runtime/rotation-token-refresh.js";
import { SessionAffinityStore } from "./session-affinity.js";
import type { RequestBody } from "./types.js";
import { isRecord } from "./utils.js";

// Re-exports: these symbols were defined in this module before the §4.1.3
// phase-1 and phase-2 carves and are part of its public surface (lib/index.ts
// star-exports this file; tests and scripts import them from here). Keep every
// existing import path working.
export type {
	RuntimeRotationProxyOptions,
	RuntimeRotationProxyServer,
	RuntimeRotationProxyStatus,
} from "./runtime/rotation-server-types.js";
export {
	buildPinnedUnavailableErrorBody,
	buildTokenInvalidationBody,
} from "./request/rate-limit-decision.js";
export type { PinnedUnavailableErrorBody } from "./request/rate-limit-decision.js";
export { chooseAccount } from "./runtime/rotation-account-selection.js";
export {
	maybeInvalidateAffinityFromDisk,
	readPinnedAccountIndexFromDisk,
	readStorageMetaFromDisk,
	resetPinCacheForTesting,
} from "./runtime/rotation-storage-meta.js";
export type { StorageMeta } from "./runtime/rotation-storage-meta.js";

const DEFAULT_HOST = "127.0.0.1";

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "127.0.0.1" ||
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "[::1]"
	);
}

// IPv6 literals must be presented in two distinct forms and the proxy
// previously conflated them (runtime-proxy IPv6 bug). Node's
// net.Server.listen(port, host) requires the RAW literal ("::1"); a bracketed
// literal ("[::1]") makes the bind fail or behave wrong. Conversely a URL
// authority requires the BRACKETED literal ("[::1]") so "http://[::1]:port"
// parses unambiguously — the raw form yields the unparseable "http://::1:port".
// Normalize each form ONCE at startup so concurrent rotation paths never race
// on inconsistent host string representations.
function stripIpv6Brackets(host: string): string {
	const trimmed = host.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

// Raw literal suitable for server.listen: "[::1]" -> "::1", others unchanged.
function toBindHost(host: string): string {
	return stripIpv6Brackets(host);
}

// URL authority host: IPv6 literals are bracketed ("::1" -> "[::1]") while
// IPv4 addresses and hostnames (no embedded colon) pass through unchanged.
function toUrlHost(host: string): string {
	const bare = stripIpv6Brackets(host);
	return bare.includes(":") ? `[${bare}]` : bare;
}

// Structured logger for the default-on runtime proxy (errors-logging-01,
// runtime-proxy-04). Previously the 1900-LOC proxy had zero logger integration;
// failures surfaced only as a last-write-wins status.lastError string. Logs are
// level-gated and carry the per-request correlation id set in handleRequest.
const proxyLog = createLogger("runtime-proxy");
const DEFAULT_QUOTA_REMAINING_THRESHOLD = 10;

const DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS = 4;

const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_THREAD_GOAL_FALLBACKS = 512;
const ALLOWED_RESPONSES_PATHS = new Set([
	URL_PATHS.RESPONSES,
	URL_PATHS.CODEX_RESPONSES,
	`/v1${URL_PATHS.RESPONSES}`,
	`/v1${URL_PATHS.CODEX_RESPONSES}`,
]);
const ALLOWED_MODELS_PATHS = new Set([
	URL_PATHS.MODELS,
	`/v1${URL_PATHS.MODELS}`,
]);
const ALLOWED_THREAD_GOAL_PATHS = new Set([
	"/thread/goal/get",
	"/thread/goal/set",
	"/codex/thread/goal/get",
	"/codex/thread/goal/set",
]);

function isResponsesPath(pathname: string): boolean {
	return ALLOWED_RESPONSES_PATHS.has(pathname);
}

function isModelsPath(pathname: string): boolean {
	return ALLOWED_MODELS_PATHS.has(pathname);
}

function isThreadGoalPath(pathname: string): boolean {
	return ALLOWED_THREAD_GOAL_PATHS.has(pathname);
}

function normalizeThreadGoalUpstreamPath(pathname: string): string {
	return pathname.startsWith("/codex/") ? pathname : `/codex${pathname}`;
}

function headersFromIncoming(req: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				headers.append(key, item);
			}
			continue;
		}
		headers.set(key, value);
	}
	return headers;
}

function createOutboundHeaders(
	incoming: Headers,
	account: ManagedAccount,
	accessToken: string,
	accountId: string,
): Headers {
	const headers = new Headers(incoming);
	for (const name of HOP_BY_HOP_HEADERS) {
		headers.delete(name);
	}
	headers.delete("host");
	headers.delete("x-api-key");
	// Never forward inbound client credentials upstream: a Cookie / proxy-auth
	// header would ride along with the managed OAuth Bearer to OpenAI.
	headers.delete("cookie");
	headers.delete("proxy-authorization");
	headers.set("authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	return headers;
}

function isAuthorizedClient(headers: Headers, clientApiKey: string): boolean {
	const authorization = headers.get("authorization") ?? "";
	const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
	const bearer = bearerMatch?.[1]?.trim();
	if (bearer && safeEqual(bearer, clientApiKey)) return true;
	const apiKey = headers.get("x-api-key");
	return typeof apiKey === "string" && safeEqual(apiKey, clientApiKey);
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left, "utf8");
	const rightBuffer = Buffer.from(right, "utf8");
	const compareLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
	const paddedLeft = Buffer.alloc(compareLength);
	const paddedRight = Buffer.alloc(compareLength);
	leftBuffer.copy(paddedLeft);
	rightBuffer.copy(paddedRight);
	return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

function readTrimmedString(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function accountIdentityFromAccount(
	account: ManagedAccount,
	updatedAt: number,
): RuntimeRotationAccountIdentity {
	return {
		index: account.index,
		label: `Account ${account.index + 1}`,
		accountId: readTrimmedString(account.accountId),
		updatedAt,
	};
}

function recordLastRuntimeAccount(
	status: RuntimeRotationProxyStatus,
	identity: RuntimeRotationAccountIdentity,
): void {
	status.lastAccountIndex = identity.index;
	status.lastAccountLabel = identity.label;
	status.lastAccountId = identity.accountId;
	status.lastAccountUpdatedAt = identity.updatedAt;
	mutateRuntimeObservabilitySnapshot((snapshot) => {
		snapshot.lastAccountIndex = identity.index;
		snapshot.lastAccountLabel = identity.label;
		snapshot.lastAccountEmail = null;
		snapshot.lastAccountId = identity.accountId;
		snapshot.lastAccountUpdatedAt = identity.updatedAt;
	});
}

async function persistRuntimeActiveAccount(
	accountManager: AccountManager,
	account: ManagedAccount,
	family: ModelFamily,
	isPinned: boolean,
	schedulingStrategy: string,
): Promise<void> {
	if (isPinned) {
		// When the user has manually pinned an account, the proxy MUST NOT
		// clobber that pin via markSwitched("rotation"), saveToDiskDebounced(),
		// or syncCodexCliActiveSelectionForIndex(). Pin mutations only flow
		// from the `switch`/`unpin`/`best` CLI commands. See #474.
		return;
	}
	try {
		// accounts-01/08: serialize the cursor mutation through the routing mutex
		// (when routingMutex="enabled") because this commit spans an await
		// (syncCodexCliActiveSelectionForIndex), which is the lost-update window the
		// mutex exists to close. In legacy mode markSwitchedLocked runs inline, so
		// behavior is unchanged by default.
		//
		// L4 fix: in "enabled" mode the SELECTION path already committed the cursor
		// for this account inside the routing mutex (atomic select+commit, see the
		// hot-path caller). Re-running markSwitchedLocked here — after the upstream
		// fetch, in a *separate* critical section — would redundantly re-advance the
		// cursor and could clobber a concurrent request's atomic advance that landed
		// while this request was awaiting upstream. So only do the locked cursor
		// commit in legacy mode, where selection does NOT commit under a lock and
		// this remains the sole commit site (preserving legacy behavior exactly).
		// `saveToDiskDebounced` + CLI sync still run in both modes: they snapshot the
		// current in-memory state / mirror the CLI selection and do not advance the
		// in-memory rotation cursor.
		//
		// Sequential scheduling fix (#509): in "sequential" mode a within-request
		// fallback to a different account must NOT advance the drain-first primary
		// pointer — only a true primary-exhaustion in chooseAccount may do that.
		// Apply the same guard here as the in-loop re-commit (lines 939-958) so
		// the legacy branch cannot silently clobber the sequential drain order.
		if (
			accountManager.getRoutingMutexMode() !== "enabled" &&
			schedulingStrategy !== "sequential"
		) {
			await accountManager.markSwitchedLocked(account, "rotation", family);
		}
		accountManager.saveToDiskDebounced();
		await accountManager.syncCodexCliActiveSelectionForIndex(account.index);
	} catch {
		// Runtime forwarding must not fail after a valid upstream response just
		// because the local status mirrors are temporarily locked.
	}
}

function createRuntimeProxyHttpError(
	message: string,
	statusCode: number,
	code: string,
): RuntimeProxyHttpError {
	return Object.assign(new Error(message), { statusCode, code });
}

function isRuntimeProxyHttpError(error: unknown): error is RuntimeProxyHttpError {
	return (
		error instanceof Error &&
		"statusCode" in error &&
		typeof error.statusCode === "number" &&
		"code" in error &&
		typeof error.code === "string"
	);
}

async function readRequestBody(
	req: IncomingMessage,
	maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > maxBytes) {
			throw createRuntimeProxyHttpError(
				"Runtime rotation proxy request body is too large.",
				HTTP_STATUS.PAYLOAD_TOO_LARGE,
				"runtime_rotation_proxy_payload_too_large",
			);
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function parseRequestBody(body: Buffer): RequestBody | null {
	if (body.length === 0) return null;
	try {
		const parsed = JSON.parse(body.toString("utf8")) as unknown;
		return isRecord(parsed) ? (parsed as RequestBody) : null;
	} catch {
		return null;
	}
}

function readStringRecordValue(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function readStringSearchParam(searchParams: URLSearchParams, key: string): string | null {
	const value = searchParams.get(key);
	return value && value.trim().length > 0 ? value.trim() : null;
}

function isThreadGoalFallbackStatus(status: number): boolean {
	return status === HTTP_STATUS.FORBIDDEN;
}

function setThreadGoalFallback(
	fallbacks: Map<string, string | null>,
	key: string,
	goal: string | null,
): void {
	if (fallbacks.has(key)) {
		fallbacks.delete(key);
	}
	fallbacks.set(key, goal);
	while (fallbacks.size > MAX_THREAD_GOAL_FALLBACKS) {
		const oldestKey = fallbacks.keys().next().value;
		if (typeof oldestKey !== "string") break;
		fallbacks.delete(oldestKey);
	}
}

function getThreadGoalFallback(
	fallbacks: Map<string, string | null>,
	key: string,
): string | null {
	if (!fallbacks.has(key)) return null;
	const goal = fallbacks.get(key) ?? null;
	fallbacks.delete(key);
	fallbacks.set(key, goal);
	return goal;
}

function resolveSessionKey(headers: Headers, parsedBody: RequestBody | null): string | null {
	const headerKey =
		headers.get(OPENAI_HEADERS.SESSION_ID) ??
		headers.get(OPENAI_HEADERS.CONVERSATION_ID) ??
		null;
	if (headerKey && headerKey.trim().length > 0) return headerKey.trim();
	if (!parsedBody) return null;
	if (typeof parsedBody.prompt_cache_key === "string") {
		const key = parsedBody.prompt_cache_key.trim();
		if (key.length > 0) return key;
	}
	if (typeof parsedBody.previous_response_id === "string") {
		const key = parsedBody.previous_response_id.trim();
		if (key.length > 0) return key;
	}
	const metadata = parsedBody.metadata;
	if (isRecord(metadata)) {
		return (
			readStringRecordValue(metadata, "session_id") ??
			readStringRecordValue(metadata, "conversation_id") ??
			readStringRecordValue(metadata, "thread_id")
		);
	}
	return null;
}

function buildResponsesRequestContext(
	req: IncomingMessage,
	body: Buffer,
): RequestContext {
	const headers = headersFromIncoming(req);
	const parsedBody = parseRequestBody(body);
	const model =
		typeof parsedBody?.model === "string" && parsedBody.model.trim().length > 0
			? parsedBody.model.trim()
			: null;
	return {
		body,
		headers,
		method: "POST",
		upstreamPath: URL_PATHS.CODEX_RESPONSES,
		model,
		// The /codex/responses path is codex-family. A model-less request must
		// bucket into the codex family (rotation/cooldown/budget), so fall back to
		// the current codex model — NOT the general DEFAULT_MODEL (gpt-5.5), whose
		// family is gpt-5.2 and would mis-account a pass-through codex request.
		family: getModelFamily(model ?? CURRENT_CODEX_MODEL),
		stream: parsedBody?.stream === true,
		sessionKey: resolveSessionKey(headers, parsedBody),
	};
}

function buildModelsRequestContext(req: IncomingMessage): RequestContext {
	return {
		body: Buffer.alloc(0),
		headers: headersFromIncoming(req),
		method: "GET",
		upstreamPath: URL_PATHS.MODELS,
		model: null,
		family: "codex",
		stream: false,
		sessionKey: null,
	};
}

function buildThreadGoalRequestContext(
	req: IncomingMessage,
	body: Buffer,
	pathname: string,
): RequestContext {
	const headers = headersFromIncoming(req);
	const parsedBody = parseRequestBody(body);
	const searchParams = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
	const queryThreadKey =
		readStringSearchParam(searchParams, "thread_id") ??
		readStringSearchParam(searchParams, "threadId");
	const bodyThreadKey = parsedBody
		? (readStringRecordValue(parsedBody, "thread_id") ??
			readStringRecordValue(parsedBody, "threadId"))
		: null;
	const sessionKey = bodyThreadKey ?? queryThreadKey ?? resolveSessionKey(headers, parsedBody);
	return {
		body,
		headers,
		method: req.method === "GET" ? "GET" : "POST",
		upstreamPath: normalizeThreadGoalUpstreamPath(pathname),
		model: null,
		family: "codex",
		stream: false,
		sessionKey,
	};
}

function buildUpstreamUrl(
	req: IncomingMessage,
	upstreamBaseUrl: string,
	upstreamPath: string,
): string {
	const incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
	const upstream = new URL(upstreamBaseUrl);
	const basePath = upstream.pathname.replace(/\/+$/, "");
	upstream.pathname = `${basePath}${upstreamPath}`;
	upstream.search = incomingUrl.search;
	return upstream.toString();
}

function resolveAccountId(account: ManagedAccount, accessToken: string): string | null {
	const stored = account.accountId?.trim();
	if (stored) return stored;
	return extractAccountId(accessToken)?.trim() || null;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(`${JSON.stringify(payload)}\n`);
}

function writeMethodOrPathError(res: ServerResponse): void {
	writeJson(res, 404, {
		error: {
			message:
				"Runtime rotation proxy only accepts Responses API, model discovery, and Codex thread goal requests.",
			code: "runtime_rotation_proxy_not_found",
		},
	});
}

function writeUnauthorized(res: ServerResponse): void {
	writeJson(res, HTTP_STATUS.UNAUTHORIZED, {
		error: {
			message: "Runtime rotation proxy rejected an unauthenticated local request.",
			code: "runtime_rotation_proxy_unauthorized",
		},
	});
}

function writePoolExhausted(params: {
	res: ServerResponse;
	accountManager: AccountManager;
	family: ModelFamily;
	model: string | null;
	reason: ExhaustionReason;
	accountSkipReasons?: Record<string, string>;
}): void {
	const { res, accountManager, family, model, reason } = params;
	const waitMs = accountManager.getMinWaitTimeForFamily(family, model);
	const accountCount = accountManager.getAccountCount();
	const accountSkipReasons = params.accountSkipReasons ?? {};
	recordRuntimePoolExhaustion({
		reason,
		retryAfterMs: waitMs,
		accountSkipReasons,
	});
	const hint =
		reason === "no-account" && accountCount > 0
			? "Accounts exist but all failed runtime availability checks. Run `codex-multi-auth report --json` to inspect runtime skip reasons, or `codex-multi-auth rotation reset-runtime` to reload the runtime proxy."
			: "Run `codex-multi-auth rotation status` to inspect account state.";
	writeJson(res, normalizeExhaustionStatus(reason), {
		error: {
			message:
				"All managed Codex accounts are temporarily unavailable for this runtime request.",
			code: "codex_runtime_rotation_pool_exhausted",
			reason,
			retry_after_ms: waitMs,
			account_skip_reasons: accountSkipReasons,
			hint,
		},
	});
}

export async function startRuntimeRotationProxy(
	options: RuntimeRotationProxyOptions,
): Promise<RuntimeRotationProxyServer> {
	const pluginConfig = loadPluginConfig();
	const activeAccountManager = options.accountManager ?? (await AccountManager.loadFromDisk());
	// accounts-01/08: apply the configured routing-mutex mode so the proxy's
	// async select->commit path (persistRuntimeActiveAccount) can serialize cursor
	// mutations when routingMutex="enabled". Legacy mode keeps the inline fast path.
	const routingMutexMode = getRoutingMutexMode(pluginConfig);
	activeAccountManager.setRoutingMutexMode(routingMutexMode);
	const schedulingStrategy = getSchedulingStrategy(pluginConfig);
	const fetchImpl = options.fetchImpl ?? fetch;
	const host = options.host ?? DEFAULT_HOST;
	// Defense in depth (runtime-proxy-01): the proxy presents managed OAuth tokens
	// and must never be reachable off-box. It is loopback-only with NO opt-out —
	// binding a non-loopback host would expose every managed account to the
	// network, so it is refused unconditionally.
	if (!isLoopbackHost(host)) {
		throw new CodexValidationError(
			`Runtime rotation proxy refuses to bind non-loopback host "${host}". ` +
				"It forwards managed OAuth tokens and is loopback-only.",
			{ field: "host", expected: "a loopback host", context: { host } },
		);
	}
	// Normalize the validated host into its two representations exactly once so the
	// listen() bind and the emitted baseUrl can never disagree under concurrent
	// rotation: bindHost is the raw literal Node's listen() expects ("[::1]"->"::1"),
	// urlHost is the bracketed form a URL authority requires ("::1"->"[::1]").
	const bindHost = toBindHost(host);
	const urlHost = toUrlHost(host);
	const port = options.port ?? 0;
	const upstreamBaseUrl = options.upstreamBaseUrl ?? CODEX_BASE_URL;
	const clientApiKey =
		typeof options.clientApiKey === "string" &&
		options.clientApiKey.trim().length > 0
			? options.clientApiKey.trim()
			: null;
	if (!clientApiKey) {
		throw new CodexValidationError(
			"Runtime rotation proxy requires a clientApiKey.",
			{ field: "clientApiKey", expected: "a non-empty string" },
		);
	}
	const now = options.now ?? Date.now;
	const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
	const networkErrorCooldownMs = getNetworkErrorCooldownMs(pluginConfig);
	const serverErrorCooldownMs = getServerErrorCooldownMs(pluginConfig);
	const tokenInvalidationCooldownMs = getTokenInvalidationCooldownMs(pluginConfig);
	const minRotationIntervalMs = getMinRotationIntervalMs(pluginConfig);
	const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
	const fetchTimeoutMs = options.fetchTimeoutMs ?? getFetchTimeoutMs(pluginConfig);
	const streamStallTimeoutMs =
		options.streamStallTimeoutMs ?? getStreamStallTimeoutMs(pluginConfig);
	const configuredMaxRetries = getRetryAllAccountsMaxRetries(pluginConfig);
	const maxRuntimeAccountAttempts =
		configuredMaxRetries > 0
			? configuredMaxRetries + 1
			: DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS;
	const maxRequestBodyBytes =
		options.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;
	const quotaRemainingPercentThreshold =
		options.quotaRemainingPercentThreshold ?? DEFAULT_QUOTA_REMAINING_THRESHOLD;
	const sessionAffinityStore = getSessionAffinity(pluginConfig)
		? new SessionAffinityStore({
				ttlMs: getSessionAffinityTtlMs(pluginConfig),
				maxEntries: getSessionAffinityMaxEntries(pluginConfig),
			})
		: null;
	// Initialize from disk so the proxy starts in sync with whatever generation
	// the storage file already shows. Subsequent disk bumps (from CLI commands)
	// are detected per-request via `maybeInvalidateAffinityFromDisk`.
	const lastObservedAffinityGeneration =
		readStorageMetaFromDisk().affinityGeneration;
	const state = createRotationProxyState({
		activeAccountManager,
		routingMutexMode,
		schedulingStrategy,
		fetchImpl,
		upstreamBaseUrl,
		clientApiKey,
		now,
		tokenRefreshSkewMs,
		networkErrorCooldownMs,
		serverErrorCooldownMs,
		tokenInvalidationCooldownMs,
		minRotationIntervalMs,
		pidOffsetEnabled,
		fetchTimeoutMs,
		streamStallTimeoutMs,
		maxRuntimeAccountAttempts,
		maxRequestBodyBytes,
		quotaRemainingPercentThreshold,
		sessionAffinityStore,
		lastObservedAffinityGeneration,
	});

	const server = createServer((req, res) => {
		void handleRequest(state, req, res);
	});
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
		});
	});
	const onPostStartupServerError = (error: Error): void => {
		state.status.lastError = error.message;
	};

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, bindHost);
	});
	server.on("error", onPostStartupServerError);

	const address = server.address();
	const resolvedPort =
		typeof address === "object" && address ? address.port : port;

	return {
		host: bindHost,
		port: resolvedPort,
		baseUrl: `http://${urlHost}:${resolvedPort}`,
		close: async () => {
			await closeServer(server, sockets);
			await state.activeAccountManager.flushPendingSave();
		},
		getStatus: () => ({
			...state.status,
			// Redact any email/token material that leaked into a raw upstream or
			// refresh error string before exposing it to status/report consumers
			// (errors-logging-08). maskString is a no-op for clean diagnostic text.
			lastError: state.status.lastError === null ? null : maskString(state.status.lastError),
		}),
	};
}

async function handleRequest(
	state: RotationProxyState,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	// Per-request trace id (errors-logging-03): distinct from sessionKey, which
	// is shared across a thread's requests. Bound to this request's async context
	// so every proxyLog line and usage row can be correlated to one request.
	const traceId = randomUUID();
	return runWithCorrelationId(traceId, () => handleRequestInner(state, req, res, traceId));
}

async function handleRequestInner(
	state: RotationProxyState,
	req: IncomingMessage,
	res: ServerResponse,
	traceId: string,
): Promise<void> {
	let usageRecorder: ReturnType<typeof createRuntimeUsageRecorder> | null = null;
	let accountManager = state.activeAccountManager;
	try {
		const incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		// Authenticate before discriminating path/method so an unauthenticated
		// caller cannot enumerate which endpoints exist: an unknown caller always
		// gets 401, never a 404 that would confirm a path is invalid (vs. just
		// unauthorized). Authorized callers still fall through to the 404 below
		// when they hit an unsupported path/method.
		const incomingHeaders = headersFromIncoming(req);
		if (!isAuthorizedClient(incomingHeaders, state.clientApiKey)) {
			writeUnauthorized(res);
			return;
		}

		const isResponsesRequest =
			req.method === "POST" && isResponsesPath(incomingUrl.pathname);
		const isModelsRequest =
			req.method === "GET" && isModelsPath(incomingUrl.pathname);
		const isThreadGoalRequest =
			(req.method === "GET" || req.method === "POST") &&
			isThreadGoalPath(incomingUrl.pathname);
		if (!isResponsesRequest && !isModelsRequest && !isThreadGoalRequest) {
			writeMethodOrPathError(res);
			return;
		}

		state.status.totalRequests += 1;
		const requestBody =
			isResponsesRequest || (isThreadGoalRequest && req.method === "POST")
				? await readRequestBody(req, state.maxRequestBodyBytes)
				: Buffer.alloc(0);
		const context = isModelsRequest
			? buildModelsRequestContext(req)
			: isThreadGoalRequest
				? buildThreadGoalRequestContext(req, requestBody, incomingUrl.pathname)
				: buildResponsesRequestContext(req, requestBody);
		const requestStartedAt = state.now();
		let policyDecision: RuntimePolicyDecision | null = null;
		let projectKey: string | null = null;
		let policyError: string | null = null;
		try {
			const policyState = await loadRuntimePolicyState();
			projectKey = policyState.project.projectKey;
			policyDecision = await evaluateRuntimePolicy({
				state: policyState,
				accounts: accountManager.getAccountsSnapshot(),
				model: context.model,
				now: requestStartedAt,
			});
			mutateRuntimeObservabilitySnapshot((snapshot) => {
				snapshot.policyBlockedIndexes = [
					...(policyDecision?.blockedAccountIndexes ?? new Set<number>()),
				];
				snapshot.policyBlockedReasons = Object.fromEntries(
					[...(policyDecision?.blockedAccountIndexes ?? new Set<number>())].map(
						(index) => [String(index), "policy-blocked"],
					),
				);
			});
		} catch (error) {
			policyError = error instanceof Error ? error.message : String(error);
			state.status.lastError = policyError;
		}
		usageRecorder = createRuntimeUsageRecorder({
			source: "runtime-proxy",
			operation: isModelsRequest
				? "models"
				: isThreadGoalRequest
					? "thread-goal"
					: "responses",
			model: context.model,
			projectKey,
			requestId: traceId,
			startedAt: requestStartedAt,
		});
		if (policyError) {
			await usageRecorder.record({
				outcome: "failure",
				statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
				errorCode: "runtime_policy_unavailable",
			});
			writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, {
				error: {
					message: "Runtime policy could not be loaded for this local request.",
					code: "runtime_policy_unavailable",
				},
			});
			return;
		}
		if (policyDecision && !policyDecision.allowed) {
			await usageRecorder.record({
				outcome: "blocked",
				statusCode: policyDecision.statusCode,
				errorCode: policyDecision.errorCode,
			});
			writeJson(res, policyDecision.statusCode, {
				error: {
					message: "Runtime policy blocked this local request.",
					code: policyDecision.errorCode ?? "policy_blocked",
					reasons: policyDecision.reasons,
				},
			});
			return;
		}
		const upstreamUrl = buildUpstreamUrl(
			req,
			state.upstreamBaseUrl,
			context.upstreamPath,
		);
		const attemptedIndexes = new Set<number>();
		let exhaustionReason: ExhaustionReason = "no-account";
		let accountCount = accountManager.getAccountCount();
		let transientAttemptLimit = Math.max(
			1,
			Math.min(accountCount, state.maxRuntimeAccountAttempts),
		);
		let transientAttempts = 0;
		let transientExhaustionReason: ExhaustionReason | null = null;
		const accountSkipReasons = new Map<number, string>();
		let reloadedAfterNoAccount = false;

		// Read the manual pin and affinity generation from disk (mtime-cached)
		// on each request so a `codex-multi-auth switch|unpin|best` invocation
		// in another process is honored without forcing a full AccountManager
		// reload. The CLI bumps `affinityGeneration` on user-initiated changes
		// so the proxy can invalidate sticky session affinity that would
		// otherwise glue an in-flight chat thread to the previously selected
		// account. The proxy itself never bumps the generation, so its own
		// debounced disk writes do not clear affinity. See issue #474.
		const storageMeta = readStorageMetaFromDisk();
		const pinnedIndex = storageMeta.pinnedAccountIndex;
		const isPinned = typeof pinnedIndex === "number";
		if (storageMeta.affinityGeneration > state.lastObservedAffinityGeneration) {
			state.sessionAffinityStore?.clearAll();
			state.lastObservedAffinityGeneration = storageMeta.affinityGeneration;
		}

		while (
			attemptedIndexes.size < accountCount &&
			transientAttempts < transientAttemptLimit
		) {
			const rotationStickyBoost: Record<number, number> =
				state.minRotationIntervalMs > 0 &&
				state.lastGlobalAccountIndex !== null &&
				state.now() - state.lastGlobalSwitchAt < state.minRotationIntervalMs
					? { [state.lastGlobalAccountIndex]: 1000 }
					: {};
			// L4 fix (routing mutex): when `routingMutex === "enabled"`, run the
			// selection AND the cursor commit inside ONE mutex acquisition so two
			// concurrent requests cannot read the same cursor and stampede before
			// the locked commit lands. `chooseAccount` is sync and mutates the
			// cursor internally (session-affinity `markSwitched`, the hybrid
			// selector's own advance, and the round-robin fallback `markSwitched`);
			// holding the mutex across the whole call serializes all of those.
			// We then `markSwitchedLocked` the winner to (a) re-commit the cursor
			// under the lock across the await boundary and (b) hand
			// `persistRuntimeActiveAccount` a cursor that is already correct. That
			// later `markSwitchedLocked` runs INLINE (reentrant) within this held
			// section, so there is no double-acquire and no deadlock on the
			// non-reentrant FIFO queue. In legacy mode the inline `markSwitched`
			// calls inside `chooseAccount` are used unchanged and no lock is taken,
			// so default behavior and perf are identical to before.
			const selectAccount = (): ManagedAccount | null =>
				chooseAccount({
					accountManager,
					sessionAffinityStore: state.sessionAffinityStore,
					sessionKey: context.sessionKey,
					family: context.family,
					model: context.model,
					attemptedIndexes,
					now: state.now(),
					policy: policyDecision,
					pinnedIndex,
					skipReasons: accountSkipReasons,
					stickyBoostByAccount: rotationStickyBoost,
					pidOffsetEnabled: state.pidOffsetEnabled,
					schedulingStrategy: state.schedulingStrategy,
				});
			const selected =
				state.routingMutexMode === "enabled"
					? await withRoutingMutex(state.routingMutexMode, async () => {
							const candidate = selectAccount();
							if (
								candidate &&
								pinnedIndex === null &&
								state.schedulingStrategy !== "sequential"
							) {
								// Re-commit the cursor under the held mutex. Skipped when a
								// manual pin is active so the proxy never clobbers the pin
								// (see #474); pinned selections are deterministic and need no
								// cursor advance. Also skipped in sequential mode: the
								// sequential selector already committed the correct active
								// index inside this held mutex, and re-committing `candidate`
								// would wrongly advance the drain-first primary when the pick
								// came from the non-advancing linear-scan fallback (#509).
								// Runs inline via reentrancy — see comment above.
								await accountManager.markSwitchedLocked(
									candidate,
									"rotation",
									context.family,
								);
							}
							return candidate;
						})
					: selectAccount();
			if (!selected) {
				if (
					!reloadedAfterNoAccount &&
					!isPinned &&
					accountCount > 0 &&
					exhaustionReason === "no-account" &&
					(policyDecision?.blockedAccountIndexes.size ?? 0) === 0 &&
					![...accountSkipReasons.values()].some(
						(reason) =>
							reason === "rate-limited" ||
							reason.startsWith("cooling-down") ||
							reason === "policy-blocked",
					)
				) {
					reloadedAfterNoAccount = true;
					const reloadedManager = await recoverStaleRuntimeState(state);
					if (reloadedManager) {
						accountManager = reloadedManager;
						accountCount = accountManager.getAccountCount();
						transientAttemptLimit = Math.max(
							1,
							Math.min(accountCount, state.maxRuntimeAccountAttempts),
						);
						accountSkipReasons.clear();
						attemptedIndexes.clear();
						continue;
					}
				}
				break;
			}
			attemptedIndexes.add(selected.index);

			if (!accountManager.consumeToken(selected, context.family, context.model)) {
				accountSkipReasons.set(selected.index, "token-exhausted");
				exhaustionReason = "rate-limit";
				continue;
			}

			const refreshed = await ensureFreshAccessToken({
				accountManager,
				account: selected,
				family: context.family,
				model: context.model,
				now: state.now(),
				tokenRefreshSkewMs: state.tokenRefreshSkewMs,
				tokenInvalidationCooldownMs: state.tokenInvalidationCooldownMs,
			});
			if (!refreshed.ok) {
				accountManager.refundToken(selected, context.family, context.model);
				exhaustionReason = "auth-failure";
				if (refreshed.invalidated) {
					// Refresh endpoint explicitly revoked the token. Stop cascade:
					// return auth error to client instead of rotating to the next account.
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					res.writeHead(HTTP_STATUS.UNAUTHORIZED, { "content-type": "application/json" });
					// Route through the shared builder so both invalidation exit paths stay
					// in lockstep — empty input yields { error: { message: <fallback>,
					// code: "token_invalidated" } }.
					res.end(buildTokenInvalidationBody(""));
					await usageRecorder.record({
						outcome: "failure",
						statusCode: HTTP_STATUS.UNAUTHORIZED,
						errorCode: "token_invalidated",
						account: selected,
					});
					return;
				}
				if (!refreshed.retryable) continue;
				transientAttempts += 1;
				transientExhaustionReason = "auth-failure";
				state.status.retries += 1;
				state.status.rotations += 1;
				continue;
			}

			const accountId = resolveAccountId(refreshed.account, refreshed.accessToken);
			if (!accountId) {
				accountManager.refundToken(refreshed.account, context.family, context.model);
				accountManager.recordFailure(refreshed.account, context.family, context.model);
				accountManager.markAccountCoolingDown(
					refreshed.account,
					DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
					"auth-failure",
				);
				exhaustionReason = "auth-failure";
				transientAttempts += 1;
				transientExhaustionReason = "auth-failure";
				state.status.retries += 1;
				state.status.rotations += 1;
				continue;
			}

			const accountIdentity = accountIdentityFromAccount(refreshed.account, state.now());
			recordLastRuntimeAccount(state.status, accountIdentity);

			const outboundHeaders = createOutboundHeaders(
				context.headers,
				refreshed.account,
				refreshed.accessToken,
				accountId,
			);

			let upstream: Response;
			try {
				state.status.upstreamRequests += 1;
				const fetchAbortController = new AbortController();
				const upstreamRequestInit: RequestInit = {
					method: context.method,
					headers: outboundHeaders,
					signal: fetchAbortController.signal,
				};
				if (context.method === "POST") {
					upstreamRequestInit.body = context.body;
				}
				upstream = await withTimeout(
					state.fetchImpl(upstreamUrl, upstreamRequestInit),
					state.fetchTimeoutMs,
					() => fetchAbortController.abort(),
					`upstream fetch timed out after ${state.fetchTimeoutMs}ms`,
				);
			} catch (error) {
				state.status.lastError = error instanceof Error ? error.message : String(error);
				accountManager.refundToken(refreshed.account, context.family, context.model);
				accountManager.recordFailure(refreshed.account, context.family, context.model);
				accountManager.markAccountCoolingDown(
					refreshed.account,
					state.networkErrorCooldownMs,
					"network-error",
				);
				accountManager.saveToDiskDebounced();
				exhaustionReason = "network-error";
				transientAttempts += 1;
				transientExhaustionReason = "network-error";
				state.status.retries += 1;
				state.status.rotations += 1;
				continue;
			}

			if (upstream.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
				const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);
				const retryAfterMs =
					parseRetryAfterHeaderMs(upstream.headers, state.now()) ??
					parseRetryAfterBodyMs(bodyText, state.now()) ??
					60_000;
				// A 429 is the upstream quota signal for the attempted account, so
				// keep the consumed runtime token drained.
				accountManager.recordRateLimit(refreshed.account, context.family, context.model);
				accountManager.markRateLimitedWithReason(
					refreshed.account,
					retryAfterMs,
					context.family,
					"quota",
					context.model,
				);
				accountManager.saveToDiskDebounced();
				exhaustionReason = "rate-limit";
				transientAttempts += 1;
				transientExhaustionReason = "rate-limit";
				state.status.retries += 1;
				state.status.rotations += 1;
				continue;
			}

			if (upstream.status === 402 || upstream.status === HTTP_STATUS.FORBIDDEN) {
				const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);
				const errorCode = extractErrorCodeFromBody(bodyText);
				if (isWorkspaceDisabledError(upstream.status, errorCode, bodyText)) {
					const accountWasEnabled =
						accountManager.getAccountByIndex(refreshed.account.index)?.enabled !==
						false;
					accountManager.refundToken(
						refreshed.account,
						context.family,
						context.model,
					);
					if (accountWasEnabled) {
						accountManager.recordFailure(
							refreshed.account,
							context.family,
							context.model,
						);
						accountManager.setAccountEnabled(refreshed.account.index, false);
						accountManager.saveToDiskDebounced();
					}
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					exhaustionReason = "deactivated";
					state.status.retries += 1;
					state.status.rotations += 1;
					continue;
				}

				if (isThreadGoalRequest && isThreadGoalFallbackStatus(upstream.status)) {
					const parsedGoalBody = parseRequestBody(context.body);
					const fallbackKey = context.sessionKey;
					const goal =
						typeof parsedGoalBody?.goal === "string" ? parsedGoalBody.goal : null;
					if (!fallbackKey) {
						if (context.upstreamPath.endsWith("/get")) {
							writeJson(res, HTTP_STATUS.OK, { goal: null });
							await usageRecorder.record({
								outcome: "failure",
								statusCode: upstream.status,
								errorCode: "thread_goal_session_key_required",
								account: refreshed.account,
							});
							return;
						}
						await usageRecorder.record({
							outcome: "failure",
							statusCode: HTTP_STATUS.BAD_REQUEST,
							errorCode: "thread_goal_session_key_required",
							account: refreshed.account,
						});
						writeJson(res, HTTP_STATUS.BAD_REQUEST, {
							error: {
								message:
									"Thread goal fallback requires a thread_id, threadId, or session header.",
								code: "thread_goal_session_key_required",
							},
						});
						return;
					}
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode: "thread_goal_upstream_blocked",
						account: refreshed.account,
					});
					if (context.upstreamPath.endsWith("/set")) {
						setThreadGoalFallback(state.threadGoalFallbacks, fallbackKey, goal);
						writeJson(res, HTTP_STATUS.OK, { ok: true, goal });
						return;
					}
					writeJson(res, HTTP_STATUS.OK, {
						goal: getThreadGoalFallback(state.threadGoalFallbacks, fallbackKey),
					});
					return;
				}

				if (isThreadGoalRequest && context.upstreamPath.endsWith("/get")) {
					writeJson(res, HTTP_STATUS.OK, { goal: null });
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode,
						account: refreshed.account,
					});
					return;
				}
				res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));
				res.end(bodyText);
				await usageRecorder.record({
					outcome: "failure",
					statusCode: upstream.status,
					errorCode,
					account: refreshed.account,
				});
				return;
			}

			if (upstream.status === HTTP_STATUS.UNAUTHORIZED) {
				const bodyText = await readErrorBody(upstream, state.streamStallTimeoutMs);
				accountManager.refundToken(refreshed.account, context.family, context.model);
				accountManager.recordFailure(refreshed.account, context.family, context.model);
				if (isTokenInvalidationError(bodyText)) {
					// The upstream explicitly revoked this OAuth token. Applying a long
					// cooldown prevents cascade invalidation: rapidly presenting each
					// account's token from the same IP triggers OpenAI's anti-abuse
					// detection and invalidates them in sequence. Return the 401 directly
					// rather than rotating so the client can prompt for re-login.
					applyMonotonicAuthCooldown(
						accountManager,
						refreshed.account,
						state.tokenInvalidationCooldownMs,
					);
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					accountManager.saveToDiskDebounced();
					// Emit the same machine-readable shape as the refresh-failure path
					// (code: "token_invalidated") instead of forwarding the raw upstream
					// body, so the client contract is consistent across both vectors.
					const clientHeaders = responseHeadersForClient(upstream.headers);
					clientHeaders["content-type"] = "application/json";
					res.writeHead(upstream.status, clientHeaders);
					res.end(buildTokenInvalidationBody(bodyText));
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode: "token_invalidated",
						account: refreshed.account,
					});
					return;
				}
				applyMonotonicAuthCooldown(
					accountManager,
					refreshed.account,
					DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
				);
				accountManager.saveToDiskDebounced();
				exhaustionReason = "auth-failure";
				transientAttempts += 1;
				transientExhaustionReason = "auth-failure";
				state.status.retries += 1;
				state.status.rotations += 1;
				continue;
			}

			if (upstream.status >= 500) {
				await readErrorBody(upstream, state.streamStallTimeoutMs);
				accountManager.refundToken(refreshed.account, context.family, context.model);
				accountManager.recordFailure(refreshed.account, context.family, context.model);
				accountManager.markAccountCoolingDown(
					refreshed.account,
					state.serverErrorCooldownMs,
					"server-error",
				);
				accountManager.saveToDiskDebounced();
				exhaustionReason = "server-error";
				transientAttempts += 1;
				transientExhaustionReason = "server-error";
				state.status.retries += 1;
				state.status.rotations += 1;
				continue;
			}

			if (isThreadGoalRequest && upstream.status >= 400) {
				if (context.upstreamPath.endsWith("/get")) {
					writeJson(res, HTTP_STATUS.OK, { goal: null });
					await usageRecorder.record({
						outcome: "failure",
						statusCode: upstream.status,
						errorCode: "thread_goal_upstream_error",
						account: refreshed.account,
					});
					return;
				}
				const forwarded = await forwardStreamingResponse(
					upstream,
					res,
					state.status,
					() => undefined,
					state.streamStallTimeoutMs,
				);
				await usageRecorder.record({
					outcome: "failure",
					statusCode: upstream.status,
					errorCode: forwarded ? "thread_goal_upstream_error" : "stream_forward_failed",
					account: refreshed.account,
				});
				return;
			}

			accountManager.recordSuccess(refreshed.account, context.family, context.model);
			// A successful request proves the account is usable, so clear any
			// stale runtime skip reason persisted for it on a prior pool
			// exhaustion. Without this the overlay reason (e.g. "token-exhausted",
			// "rate-limited") lingers on disk until an explicit runtime reset and
			// the forecast keeps reporting this working account as unavailable.
			// No-op when no reason is recorded, so the hot path stays write-free.
			recordRuntimeAccountRecovery(refreshed.account.index);
			const nearExhaustionWaitMs = getQuotaNearExhaustionWaitMs(
				upstream.headers,
				state.quotaRemainingPercentThreshold,
				state.now(),
			);
			if (nearExhaustionWaitMs > 0) {
				accountManager.markRateLimitedWithReason(
					refreshed.account,
					nearExhaustionWaitMs,
					context.family,
					"quota",
					context.model,
				);
				state.sessionAffinityStore?.forgetSession(context.sessionKey);
				accountManager.saveToDiskDebounced();
			} else {
				state.sessionAffinityStore?.remember(
					context.sessionKey,
					refreshed.account.index,
					state.now(),
				);
				if (refreshed.account.index !== state.lastGlobalAccountIndex) {
					state.lastGlobalAccountIndex = refreshed.account.index;
				}
				state.lastGlobalSwitchAt = state.now();
			}
			await persistRuntimeActiveAccount(
				accountManager,
				refreshed.account,
				context.family,
				isPinned && refreshed.account.index === pinnedIndex,
				state.schedulingStrategy,
			);

			const forwarded = await forwardStreamingResponse(
				upstream,
				res,
				state.status,
				() => {
					accountManager.recordFailure(
						refreshed.account,
						context.family,
						context.model,
					);
					accountManager.markAccountCoolingDown(
						refreshed.account,
						state.networkErrorCooldownMs,
						"network-error",
					);
					state.sessionAffinityStore?.forgetSession(context.sessionKey);
					accountManager.saveToDiskDebounced();
				},
				state.streamStallTimeoutMs,
			);
			await usageRecorder.record({
				outcome: forwarded ? "success" : "failure",
				statusCode: upstream.status,
				errorCode: forwarded ? null : "stream_forward_failed",
				account: refreshed.account,
			});
			return;
		}

		if (
			transientAttempts >= transientAttemptLimit &&
			attemptedIndexes.size < accountCount
		) {
			exhaustionReason = "budget";
		} else if (
			exhaustionReason === "deactivated" &&
			transientExhaustionReason
		) {
			exhaustionReason = transientExhaustionReason;
		}

		// When a manual pin is set and the pinned account is unavailable, do
		// NOT silently fall through to rotation. Hard-fail with a 503 so the
		// user is informed the pin cannot be honored. See issue #474.
		//
		// Surface the runtime skip reason in both the human-readable message
		// and a structured `reason` field, mirroring `writePoolExhausted`. A
		// null reason indicates a forecast/runtime state desync (the pinned
		// account was selected but no skip reason was recorded) — see #486.
		if (isPinned) {
			const errorBody = buildPinnedUnavailableErrorBody(
				pinnedIndex,
				accountSkipReasons,
			);
			if (errorBody.reason === null) {
				state.status.lastError = `pinned-503 missing skip reason (pinnedIndex=${pinnedIndex})`;
			}
			await usageRecorder?.record({
				outcome: "failure",
				statusCode: HTTP_STATUS.SERVICE_UNAVAILABLE,
				errorCode: "codex_pinned_account_unavailable",
			});
			writeJson(res, HTTP_STATUS.SERVICE_UNAVAILABLE, { error: errorBody });
			return;
		}

		await usageRecorder?.record({
			outcome: "failure",
			statusCode: normalizeExhaustionStatus(exhaustionReason),
			errorCode: isThreadGoalRequest && context.upstreamPath.endsWith("/get") ? "thread_goal_pool_exhausted" : exhaustionReason,
		});
		if (isThreadGoalRequest && context.upstreamPath.endsWith("/get")) {
			writeJson(res, HTTP_STATUS.OK, { goal: null });
		} else {
			writePoolExhausted({
				res,
				accountManager,
				family: context.family,
				model: context.model,
				reason: exhaustionReason,
				accountSkipReasons: Object.fromEntries(
					[...accountSkipReasons.entries()].map(([index, reason]) => [
						String(index),
						reason,
					]),
				),
			});
		}
	} catch (error) {
		const rawErrorMessage = error instanceof Error ? error.message : String(error);
		// errors-logging-08: redact any email/token material that leaked into a
		// raw upstream or refresh error string before it reaches state.status consumers
		// or the structured log. maskString is a no-op for clean diagnostic text.
		const maskedErrorMessage = maskString(rawErrorMessage);
		state.status.lastError = maskedErrorMessage;
		// errors-logging-01: surface the failure through the structured logger
		// (redaction-safe) with the request trace id, instead of only stashing a
		// last-write-wins status string.
		proxyLog.error("runtime proxy request failed", {
			traceId,
			code: isRuntimeProxyHttpError(error) ? error.code : "codex_runtime_rotation_proxy_error",
			error: maskedErrorMessage,
		});
		if (!res.headersSent) {
			if (isRuntimeProxyHttpError(error)) {
				await usageRecorder?.record({
					outcome: "failure",
					statusCode: error.statusCode,
					errorCode: error.code,
				});
				writeJson(res, error.statusCode, {
					error: {
						message: error.message,
						code: error.code,
					},
				});
				return;
			}
			await usageRecorder?.record({
				outcome: "failure",
				statusCode: 500,
				errorCode: "codex_runtime_rotation_proxy_error",
			});
			writeJson(res, 500, {
				error: {
					message: "Runtime rotation proxy failed before forwarding the request.",
					code: "codex_runtime_rotation_proxy_error",
				},
			});
		} else if (!res.destroyed) {
			res.destroy(error instanceof Error ? error : undefined);
		}
	}
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
	if (!server.listening) return;
	const closed = new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
	server.closeIdleConnections?.();
	for (const socket of sockets) {
		socket.destroy();
	}
	await closed;
}
