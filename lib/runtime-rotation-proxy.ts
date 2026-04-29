import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
	AccountManager,
	extractAccountId,
	type ManagedAccount,
} from "./accounts.js";
import {
	getFetchTimeoutMs,
	getNetworkErrorCooldownMs,
	getRetryAllAccountsMaxRetries,
	getServerErrorCooldownMs,
	getSessionAffinity,
	getSessionAffinityMaxEntries,
	getSessionAffinityTtlMs,
	getStreamStallTimeoutMs,
	getTokenRefreshSkewMs,
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
import { queuedRefresh } from "./refresh-queue.js";
import { mutateRuntimeObservabilitySnapshot } from "./runtime/runtime-observability.js";
import {
	createRuntimeUsageRecorder,
	evaluateRuntimePolicy,
	loadRuntimePolicyState,
	type RuntimePolicyDecision,
} from "./policy/runtime-policy.js";
import { SessionAffinityStore } from "./session-affinity.js";
import type { OAuthAuthDetails, RequestBody, TokenResult } from "./types.js";
import { isRecord } from "./utils.js";

export interface RuntimeRotationProxyServer {
	host: string;
	port: number;
	baseUrl: string;
	close: () => Promise<void>;
	getStatus: () => RuntimeRotationProxyStatus;
}

export interface RuntimeRotationProxyStatus {
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
	lastAccountUpdatedAt: number | null;
}

export interface RuntimeRotationProxyOptions {
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
}

interface RequestContext {
	body: Buffer;
	headers: Headers;
	method: "GET" | "POST";
	upstreamPath: string;
	model: string | null;
	family: ModelFamily;
	stream: boolean;
	sessionKey: string | null;
}

type ExhaustionReason =
	| "rate-limit"
	| "server-error"
	| "network-error"
	| "auth-failure"
	| "budget"
	| "no-account";
type RuntimeProxyHttpError = Error & {
	statusCode: number;
	code: string;
};

interface RuntimeRotationAccountIdentity {
	index: number;
	label: string;
	accountId: string | null;
	updatedAt: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_QUOTA_REMAINING_THRESHOLD = 10;
const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS = 4;
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"content-length",
	"expect",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const PRIVATE_CLIENT_RESPONSE_HEADERS = new Set([
	"x-codex-multi-auth-account-index",
	"x-codex-multi-auth-account-label",
	"x-codex-multi-auth-account-email",
	"x-codex-multi-auth-account-id",
]);
const DECODED_UPSTREAM_RESPONSE_HEADERS = new Set([
	// Node fetch returns decoded bytes while preserving the upstream encoding header.
	"content-encoding",
]);
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

function isResponsesPath(pathname: string): boolean {
	return ALLOWED_RESPONSES_PATHS.has(pathname);
}

function isModelsPath(pathname: string): boolean {
	return ALLOWED_MODELS_PATHS.has(pathname);
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
): Promise<void> {
	try {
		accountManager.markSwitched(account, "rotation", family);
		accountManager.saveToDiskDebounced();
		await accountManager.syncCodexCliActiveSelectionForIndex(account.index);
	} catch {
		// Runtime forwarding must not fail after a valid upstream response just
		// because the local status mirrors are temporarily locked.
	}
}

function responseHeadersForClient(upstreamHeaders: Headers): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of upstreamHeaders.entries()) {
		const normalizedKey = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(normalizedKey)) continue;
		if (PRIVATE_CLIENT_RESPONSE_HEADERS.has(normalizedKey)) continue;
		if (DECODED_UPSTREAM_RESPONSE_HEADERS.has(normalizedKey)) continue;
		headers[key] = value;
	}
	return headers;
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
		family: getModelFamily(model ?? "gpt-5.3-codex"),
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

function hasUsableAccessToken(
	account: ManagedAccount,
	now: number,
	skewMs: number,
): boolean {
	return (
		typeof account.access === "string" &&
		account.access.trim().length > 0 &&
		typeof account.expires === "number" &&
		account.expires > now + Math.max(0, skewMs)
	);
}

function isTokenRefreshRetryable(result: Extract<TokenResult, { type: "failed" }>): boolean {
	if (result.reason === "network_error" || result.reason === "unknown") return true;
	if (result.reason === "invalid_response") return true;
	if (result.reason === "http_error") {
		return !(
			result.statusCode === HTTP_STATUS.BAD_REQUEST ||
			result.statusCode === HTTP_STATUS.UNAUTHORIZED ||
			result.statusCode === HTTP_STATUS.FORBIDDEN
		);
	}
	return false;
}

const runtimeRefreshCommitQueues = new WeakMap<
	AccountManager,
	Map<string, Promise<ManagedAccount | null>>
>();

async function commitRefreshedAuthOnce(
	accountManager: AccountManager,
	account: ManagedAccount,
	auth: OAuthAuthDetails,
): Promise<ManagedAccount | null> {
	const key = [
		account.index,
		account.accountId ?? "",
		account.email ?? "",
		account.refreshToken,
	].join("\0");
	let queue = runtimeRefreshCommitQueues.get(accountManager);
	if (!queue) {
		queue = new Map();
		runtimeRefreshCommitQueues.set(accountManager, queue);
	}
	const existing = queue.get(key);
	if (existing) return existing;
	const pending = accountManager
		.commitRefreshedAuth(account, auth)
		.finally(() => queue?.delete(key));
	queue.set(key, pending);
	return pending;
}

async function ensureFreshAccessToken(params: {
	accountManager: AccountManager;
	account: ManagedAccount;
	family: ModelFamily;
	model: string | null;
	now: number;
	tokenRefreshSkewMs: number;
}): Promise<{ ok: true; accessToken: string; account: ManagedAccount } | { ok: false; retryable: boolean }> {
	const { accountManager, account, family, model, now, tokenRefreshSkewMs } = params;
	if (hasUsableAccessToken(account, now, tokenRefreshSkewMs)) {
		return { ok: true, accessToken: account.access ?? "", account };
	}

	const refreshResult = await queuedRefresh(account.refreshToken);
	if (refreshResult.type === "failed") {
		accountManager.recordFailure(account, family, model);
		accountManager.incrementAuthFailures(account);
		accountManager.markAccountCoolingDown(
			account,
			DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
			"auth-failure",
		);
		accountManager.saveToDiskDebounced();
		return { ok: false, retryable: isTokenRefreshRetryable(refreshResult) };
	}

	const auth: OAuthAuthDetails = {
		type: "oauth",
		access: refreshResult.access,
		refresh: refreshResult.refresh,
		expires: refreshResult.expires,
	};
	try {
		const updatedAccount = (await commitRefreshedAuthOnce(
			accountManager,
			account,
			auth,
		)) ?? account;
		return {
			ok: true,
			accessToken: updatedAccount.access ?? refreshResult.access,
			account: updatedAccount,
		};
	} catch {
		accountManager.recordFailure(account, family, model);
		accountManager.markAccountCoolingDown(
			account,
			DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
			"auth-failure",
		);
		accountManager.saveToDiskDebounced();
		return { ok: false, retryable: true };
	}
}

function resolveAccountId(account: ManagedAccount, accessToken: string): string | null {
	const stored = account.accountId?.trim();
	if (stored) return stored;
	return extractAccountId(accessToken)?.trim() || null;
}

function parseRetryAfterHeaderMs(headers: Headers, now: number): number | null {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs) {
		const parsed = Number.parseInt(retryAfterMs, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return null;
	const asSeconds = Number.parseInt(retryAfter, 10);
	if (Number.isFinite(asSeconds) && asSeconds > 0) return asSeconds * 1000;
	const asDate = Date.parse(retryAfter);
	if (Number.isFinite(asDate) && asDate > now) return asDate - now;
	return null;
}

function parseRetryAfterBodyMs(bodyText: string, now: number): number | null {
	if (!bodyText.trim()) return null;
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
		const retryAfterMs = Number(parsed.error.retry_after_ms);
		if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
		const retryAfterSeconds = Number(parsed.error.retry_after);
		if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
			return retryAfterSeconds * 1000;
		}
		const resetAtRaw = Number(parsed.error.resets_at ?? parsed.error.reset_at);
		if (Number.isFinite(resetAtRaw) && resetAtRaw > 0) {
			const resetAtMs = resetAtRaw < 10_000_000_000 ? resetAtRaw * 1000 : resetAtRaw;
			if (resetAtMs > now) return resetAtMs - now;
		}
	} catch {
		return null;
	}
	return null;
}

async function readErrorBody(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}

function getQuotaWindowWaitMs(headers: Headers, prefix: string, now: number): number {
	const resetAfterSeconds = Number.parseInt(
		headers.get(`${prefix}-reset-after-seconds`) ?? "",
		10,
	);
	if (Number.isFinite(resetAfterSeconds) && resetAfterSeconds > 0) {
		return resetAfterSeconds * 1000;
	}
	const resetAtRaw = headers.get(`${prefix}-reset-at`);
	if (!resetAtRaw) return 0;
	const trimmed = resetAtRaw.trim();
	let resetAtMs = 0;
	if (/^\d+$/.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			resetAtMs = parsed < 10_000_000_000 ? parsed * 1000 : parsed;
		}
	} else {
		const parsedDate = Date.parse(trimmed);
		if (Number.isFinite(parsedDate)) resetAtMs = parsedDate;
	}
	return resetAtMs > now ? resetAtMs - now : 0;
}

function getQuotaNearExhaustionWaitMs(
	headers: Headers,
	remainingThreshold: number,
	now: number,
): number {
	const usedThreshold = 100 - Math.max(0, Math.min(100, remainingThreshold));
	const candidates: number[] = [];
	for (const prefix of ["x-codex-primary", "x-codex-secondary"]) {
		const used = Number(headers.get(`${prefix}-used-percent`) ?? "");
		if (!Number.isFinite(used) || used < usedThreshold) continue;
		const waitMs = getQuotaWindowWaitMs(headers, prefix, now);
		if (waitMs > 0) candidates.push(waitMs);
	}
	return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function chooseAccount(params: {
	accountManager: AccountManager;
	sessionAffinityStore: SessionAffinityStore | null;
	sessionKey: string | null;
	family: ModelFamily;
	model: string | null;
	attemptedIndexes: ReadonlySet<number>;
	now: number;
	policy: RuntimePolicyDecision | null;
}): ManagedAccount | null {
	const {
		accountManager,
		sessionAffinityStore,
		sessionKey,
		family,
		model,
		attemptedIndexes,
		now,
		policy,
	} = params;
	const preferredIndex = sessionAffinityStore?.getPreferredAccountIndex(sessionKey, now);
	if (
		typeof preferredIndex === "number" &&
		!attemptedIndexes.has(preferredIndex) &&
		!policy?.blockedAccountIndexes.has(preferredIndex)
	) {
		const preferred = accountManager.getAccountByIndex(preferredIndex);
		if (
			preferred &&
			accountManager.isAccountAvailableForFamily(preferred.index, family, model)
		) {
			accountManager.markSwitched(preferred, "rotation", family);
			return preferred;
		}
	}

	const selected = accountManager.getCurrentOrNextForFamilyHybrid(family, model, {
		scoreBoostByAccount: policy?.scoreBoostByAccount,
	});
	if (
		selected &&
		!attemptedIndexes.has(selected.index) &&
		!policy?.blockedAccountIndexes.has(selected.index)
	) {
		return selected;
	}

	for (const account of accountManager.getAccountsSnapshot()) {
		if (attemptedIndexes.has(account.index)) continue;
		if (policy?.blockedAccountIndexes.has(account.index)) continue;
		if (accountManager.isAccountAvailableForFamily(account.index, family, model)) {
			const live = accountManager.getAccountByIndex(account.index);
			if (!live) continue;
			accountManager.markSwitched(live, "rotation", family);
			return live;
		}
	}

	return null;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(`${JSON.stringify(payload)}\n`);
}

function writeMethodOrPathError(res: ServerResponse): void {
	writeJson(res, 404, {
		error: {
			message:
				"Runtime rotation proxy only accepts Responses API and model discovery requests.",
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

function normalizeExhaustionStatus(reason: ExhaustionReason): number {
	return reason === "rate-limit" ? HTTP_STATUS.TOO_MANY_REQUESTS : 503;
}

function writePoolExhausted(params: {
	res: ServerResponse;
	accountManager: AccountManager;
	family: ModelFamily;
	model: string | null;
	reason: ExhaustionReason;
}): void {
	const { res, accountManager, family, model, reason } = params;
	const waitMs = accountManager.getMinWaitTimeForFamily(family, model);
	writeJson(res, normalizeExhaustionStatus(reason), {
		error: {
			message:
				"All managed Codex accounts are temporarily unavailable for this runtime request.",
			code: "codex_runtime_rotation_pool_exhausted",
			reason,
			retry_after_ms: waitMs,
			hint: "Run `codex auth rotation status` to inspect account state.",
		},
	});
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void,
	message: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => {
					onTimeout();
					reject(new Error(message));
				}, Math.max(1, timeoutMs));
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function forwardStreamingResponse(
	upstream: Response,
	res: ServerResponse,
	status: RuntimeRotationProxyStatus,
	onStreamError: () => void,
	streamStallTimeoutMs: number,
): Promise<boolean> {
	status.streamsStarted += 1;
	res.writeHead(
		upstream.status,
		responseHeadersForClient(upstream.headers),
	);
	if (!upstream.body) {
		res.end();
		return true;
	}

	const reader = upstream.body.getReader();
	res.on("close", () => {
		if (!res.writableEnded) {
			void reader.cancel().catch(() => undefined);
		}
	});
	try {
		while (true) {
			const { done, value } = await withTimeout(
				reader.read(),
				streamStallTimeoutMs,
				() => {
					void reader.cancel().catch(() => undefined);
				},
				`upstream stream stalled after ${streamStallTimeoutMs}ms`,
			);
			if (done) break;
			if (value && value.byteLength > 0) {
				res.write(Buffer.from(value));
			}
		}
		res.end();
		return true;
	} catch (error) {
		status.lastError = error instanceof Error ? error.message : String(error);
		onStreamError();
		if (!res.destroyed) {
			res.destroy(error instanceof Error ? error : undefined);
		}
		return false;
	}
}

export async function startRuntimeRotationProxy(
	options: RuntimeRotationProxyOptions,
): Promise<RuntimeRotationProxyServer> {
	const pluginConfig = loadPluginConfig();
	const accountManager = options.accountManager ?? (await AccountManager.loadFromDisk());
	const fetchImpl = options.fetchImpl ?? fetch;
	const host = options.host ?? DEFAULT_HOST;
	const port = options.port ?? 0;
	const upstreamBaseUrl = options.upstreamBaseUrl ?? CODEX_BASE_URL;
	const clientApiKey =
		typeof options.clientApiKey === "string" &&
		options.clientApiKey.trim().length > 0
			? options.clientApiKey.trim()
			: null;
	if (!clientApiKey) {
		throw new Error("Runtime rotation proxy requires a clientApiKey.");
	}
	const now = options.now ?? Date.now;
	const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
	const networkErrorCooldownMs = getNetworkErrorCooldownMs(pluginConfig);
	const serverErrorCooldownMs = getServerErrorCooldownMs(pluginConfig);
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
	const status: RuntimeRotationProxyStatus = {
		startedAt: now(),
		totalRequests: 0,
		upstreamRequests: 0,
		retries: 0,
		rotations: 0,
		streamsStarted: 0,
		lastError: null,
		lastAccountIndex: null,
		lastAccountLabel: null,
		lastAccountId: null,
		lastAccountUpdatedAt: null,
	};

	const handleRequest = async (
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> => {
		let usageRecorder: ReturnType<typeof createRuntimeUsageRecorder> | null = null;
		try {
			const incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
			const isResponsesRequest =
				req.method === "POST" && isResponsesPath(incomingUrl.pathname);
			const isModelsRequest =
				req.method === "GET" && isModelsPath(incomingUrl.pathname);
			if (!isResponsesRequest && !isModelsRequest) {
				writeMethodOrPathError(res);
				return;
			}

			const incomingHeaders = headersFromIncoming(req);
			if (!isAuthorizedClient(incomingHeaders, clientApiKey)) {
				writeUnauthorized(res);
				return;
			}

			status.totalRequests += 1;
			const context = isModelsRequest
				? buildModelsRequestContext(req)
				: buildResponsesRequestContext(
						req,
						await readRequestBody(req, maxRequestBodyBytes),
					);
			const requestStartedAt = now();
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
			} catch (error) {
				policyError = error instanceof Error ? error.message : String(error);
				status.lastError = policyError;
			}
			usageRecorder = createRuntimeUsageRecorder({
				source: "runtime-proxy",
				operation: isModelsRequest ? "models" : "responses",
				model: context.model,
				projectKey,
				requestId: context.sessionKey,
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
				upstreamBaseUrl,
				context.upstreamPath,
			);
			const attemptedIndexes = new Set<number>();
			let exhaustionReason: ExhaustionReason = "no-account";
			const accountAttemptLimit = Math.max(
				1,
				Math.min(accountManager.getAccountCount(), maxRuntimeAccountAttempts),
			);

			while (attemptedIndexes.size < accountAttemptLimit) {
				const selected = chooseAccount({
					accountManager,
					sessionAffinityStore,
					sessionKey: context.sessionKey,
					family: context.family,
					model: context.model,
					attemptedIndexes,
					now: now(),
					policy: policyDecision,
				});
				if (!selected) break;
				attemptedIndexes.add(selected.index);

				if (!accountManager.consumeToken(selected, context.family, context.model)) {
					exhaustionReason = "rate-limit";
					continue;
				}

				const refreshed = await ensureFreshAccessToken({
					accountManager,
					account: selected,
					family: context.family,
					model: context.model,
					now: now(),
					tokenRefreshSkewMs,
				});
				if (!refreshed.ok) {
					accountManager.refundToken(selected, context.family, context.model);
					exhaustionReason = "auth-failure";
					if (!refreshed.retryable) continue;
					status.retries += 1;
					status.rotations += 1;
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
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				const accountIdentity = accountIdentityFromAccount(refreshed.account, now());
				recordLastRuntimeAccount(status, accountIdentity);

				const outboundHeaders = createOutboundHeaders(
					context.headers,
					refreshed.account,
					refreshed.accessToken,
					accountId,
				);

				let upstream: Response;
				try {
					status.upstreamRequests += 1;
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
						fetchImpl(upstreamUrl, upstreamRequestInit),
						fetchTimeoutMs,
						() => fetchAbortController.abort(),
						`upstream fetch timed out after ${fetchTimeoutMs}ms`,
					);
				} catch (error) {
					status.lastError = error instanceof Error ? error.message : String(error);
					accountManager.refundToken(refreshed.account, context.family, context.model);
					accountManager.recordFailure(refreshed.account, context.family, context.model);
					accountManager.markAccountCoolingDown(
						refreshed.account,
						networkErrorCooldownMs,
						"network-error",
					);
					accountManager.saveToDiskDebounced();
					exhaustionReason = "network-error";
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				if (upstream.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
					const bodyText = await readErrorBody(upstream);
					const retryAfterMs =
						parseRetryAfterHeaderMs(upstream.headers, now()) ??
						parseRetryAfterBodyMs(bodyText, now()) ??
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
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				if (upstream.status === HTTP_STATUS.UNAUTHORIZED) {
					await readErrorBody(upstream);
					accountManager.refundToken(refreshed.account, context.family, context.model);
					accountManager.recordFailure(refreshed.account, context.family, context.model);
					accountManager.markAccountCoolingDown(
						refreshed.account,
						DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
						"auth-failure",
					);
					accountManager.saveToDiskDebounced();
					exhaustionReason = "auth-failure";
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				if (upstream.status >= 500) {
					await readErrorBody(upstream);
					accountManager.refundToken(refreshed.account, context.family, context.model);
					accountManager.recordFailure(refreshed.account, context.family, context.model);
					accountManager.markAccountCoolingDown(
						refreshed.account,
						serverErrorCooldownMs,
						"server-error",
					);
					accountManager.saveToDiskDebounced();
					exhaustionReason = "server-error";
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				accountManager.recordSuccess(refreshed.account, context.family, context.model);
				const nearExhaustionWaitMs = getQuotaNearExhaustionWaitMs(
					upstream.headers,
					quotaRemainingPercentThreshold,
					now(),
				);
				if (nearExhaustionWaitMs > 0) {
					accountManager.markRateLimitedWithReason(
						refreshed.account,
						nearExhaustionWaitMs,
						context.family,
						"quota",
						context.model,
					);
					sessionAffinityStore?.forgetSession(context.sessionKey);
					accountManager.saveToDiskDebounced();
				} else {
					sessionAffinityStore?.remember(
						context.sessionKey,
						refreshed.account.index,
						now(),
					);
				}
				await persistRuntimeActiveAccount(
					accountManager,
					refreshed.account,
					context.family,
				);

				const forwarded = await forwardStreamingResponse(
					upstream,
					res,
					status,
					() => {
						accountManager.recordFailure(
							refreshed.account,
							context.family,
							context.model,
						);
						accountManager.markAccountCoolingDown(
							refreshed.account,
							networkErrorCooldownMs,
							"network-error",
						);
						sessionAffinityStore?.forgetSession(context.sessionKey);
						accountManager.saveToDiskDebounced();
					},
					streamStallTimeoutMs,
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
				attemptedIndexes.size >= accountAttemptLimit &&
				accountAttemptLimit < accountManager.getAccountCount()
			) {
				exhaustionReason = "budget";
			}

			await usageRecorder?.record({
				outcome: "failure",
				statusCode: normalizeExhaustionStatus(exhaustionReason),
				errorCode: exhaustionReason,
			});
			writePoolExhausted({
				res,
				accountManager,
				family: context.family,
				model: context.model,
				reason: exhaustionReason,
			});
		} catch (error) {
			status.lastError = error instanceof Error ? error.message : String(error);
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
	};

	const server = createServer((req, res) => {
		void handleRequest(req, res);
	});
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
		});
	});
	const onPostStartupServerError = (error: Error): void => {
		status.lastError = error.message;
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
		server.listen(port, host);
	});
	server.on("error", onPostStartupServerError);

	const address = server.address();
	const resolvedPort =
		typeof address === "object" && address ? address.port : port;

	return {
		host,
		port: resolvedPort,
		baseUrl: `http://${host}:${resolvedPort}`,
		close: async () => {
			await closeServer(server, sockets);
			await accountManager.flushPendingSave();
		},
		getStatus: () => ({ ...status }),
	};
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
