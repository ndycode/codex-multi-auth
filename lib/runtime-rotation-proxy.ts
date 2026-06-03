import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
	AccountManager,
	extractAccountId,
	type ManagedAccount,
} from "./accounts.js";
import { withRoutingMutex } from "./routing-mutex.js";
import { getStoragePath } from "./storage.js";
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
import { queuedRefresh } from "./refresh-queue.js";
import {
	mutateRuntimeObservabilitySnapshot,
	recordRuntimePoolExhaustion,
	recordRuntimeReload,
	recordRuntimeReset,
} from "./runtime/runtime-observability.js";
import {
	createRuntimeUsageRecorder,
	evaluateRuntimePolicy,
	loadRuntimePolicyState,
	type RuntimePolicyDecision,
} from "./policy/runtime-policy.js";
import { isWorkspaceDisabledError } from "./request/fetch-helpers.js";
import { createLogger, maskString, runWithCorrelationId } from "./logger.js";
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
	| "deactivated"
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
const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 30_000;

const DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS = 4;

// Phrases observed in upstream 401 response bodies when OpenAI/Microsoft has
// explicitly revoked an OAuth token (as opposed to a generic expired-token 401
// that can be retried after a refresh). Matching is case-insensitive substring.
// If anti-abuse detection triggers different wording in production, add the new
// phrase here and record the source provider and date. See issue #495.
const TOKEN_INVALIDATION_PHRASES = [
	"invalidated oauth token",
	"authentication token has been invalidated",
	"oauth token has been invalidated",
	"token has been invalidated",
] as const;

function isTokenInvalidationError(bodyText: string): boolean {
	const lower = bodyText.toLowerCase();
	return TOKEN_INVALIDATION_PHRASES.some((phrase) => lower.includes(phrase));
}
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_THREAD_GOAL_FALLBACKS = 512;
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

/**
 * Content-hash-keyed snapshot of on-disk storage metadata. The proxy is a
 * long-running process; the `switch`/`unpin`/`best` CLI runs in a different
 * process and mutates the storage file. We re-read only the top-level
 * `pinnedAccountIndex` and `affinityGeneration` fields on each request so
 * manual changes are honored without doing a full AccountManager reload
 * (which would lose in-memory cooldown state).
 *
 * We key the cache on a sha1 of the file bytes rather than `mtimeMs` because
 * Windows file systems can report sub-millisecond mtime granularity that is
 * coarser than our atomic-rename writes — two CLI bumps that happen close
 * together can land on the same `mtimeMs` and silently bypass an mtime-based
 * cache. The hashing cost is negligible for the small accounts.json file
 * (typically < 50KB) and keeps cache correctness independent of FS mtime
 * resolution. See #474.
 *
 * We additionally retain the last-seen `mtimeMs`/`size` so the hot path can
 * skip the `readFileSync` + sha1 entirely when neither has changed since the
 * previous read AND the cached mtime has settled past
 * `MTIME_SHORTCIRCUIT_SETTLE_MS` (the common case — the proxy reads on every
 * request but the file only mutates on a `switch`/`unpin`/`best` CLI
 * invocation, then sits quiescent). The sha1 remains the source of truth:
 * when `mtimeMs`/`size` differ, were never cached, or the mtime is too recent
 * to trust against same-tick writes, we re-read and hash, so the content-hash
 * path still protects against the coarse-mtime collision described above
 * whenever the file is re-read.
 */
interface StorageMetaSnapshot {
	mtimeMs: number;
	size: number;
	contentHash: string;
	pinnedAccountIndex: number | null;
	affinityGeneration: number;
}

export interface StorageMeta {
	pinnedAccountIndex: number | null;
	affinityGeneration: number;
}

// Keyed by absolute storage path so multiple proxy instances and concurrent
// vitest workers (each pointing at their own temp storage file) cannot
// corrupt each other's snapshots. See issue #474.
const STORAGE_META_CACHE: Map<string, StorageMetaSnapshot> = new Map();

// The mtime+size short-circuit (L3) may only be trusted once the cached
// mtime is far enough in the past that no *subsequent* write could share the
// same coarse mtime tick. Filesystems report mtime at wildly different
// granularities (ext4 ns, FAT 2s, some network/Windows volumes ~1s, and CI
// containers occasionally coarser), and our writers use atomic rename, so two
// rapid CLI bumps can land on an identical mtimeMs. Within this settle window
// we therefore ignore mtime equality and fall back to the read + sha1 path
// (the real source of truth). Outside it, the file has been quiescent long
// enough that mtime equality provably means "unchanged", so we skip the read.
// 2s comfortably exceeds the coarsest mtime granularity we expect in practice.
const MTIME_SHORTCIRCUIT_SETTLE_MS = 2_000;

function hashStorageBytes(bytes: Buffer): string {
	return createHash("sha1").update(bytes).digest("hex");
}

function metaFromSnapshot(snapshot: StorageMetaSnapshot): StorageMeta {
	return {
		pinnedAccountIndex: snapshot.pinnedAccountIndex,
		affinityGeneration: snapshot.affinityGeneration,
	};
}

/**
 * Cheap, hot-path-safe single read with mtime-cache short-circuit. When the
 * file's `mtimeMs` and `size` match the cached snapshot for this path we
 * return the cached value WITHOUT reading or hashing the file. Only when
 * mtime/size differ (or were never cached) do we `readFileSync` + sha1 and,
 * if the content hash still matches, skip the `JSON.parse`. Transient
 * failures (EBUSY/EPERM/EACCES/EAGAIN, partial-write SyntaxError) fall through
 * to the last cached value for this path; defaults are only returned when the
 * file has never been successfully read.
 *
 * Replaces an earlier retry loop with a sub-15ms busy-wait that blocked the
 * event loop on every transient failure. The proxy is on the request hot
 * path; serving a slightly stale (but consistent) value is strictly better
 * than blocking. See #474.
 */
export function readStorageMetaFromDisk(
	storagePath: string = getStoragePath(),
): StorageMeta {
	if (!existsSync(storagePath)) {
		STORAGE_META_CACHE.delete(storagePath);
		return { pinnedAccountIndex: null, affinityGeneration: 0 };
	}
	try {
		// mtime+size short-circuit (L3): when neither has changed since the last
		// successful read AND the cached mtime has settled (see
		// MTIME_SHORTCIRCUIT_SETTLE_MS) we return the cached snapshot without
		// reading or hashing the file. During the settle window we deliberately
		// fall through to the read + sha1 path below, which stays the source of
		// truth and protects against the coarse-mtime collision described on
		// StorageMetaSnapshot. So this is a pure fast path for the common
		// "file quiescent, proxy polling every request" case.
		const stats = statSync(storagePath);
		const cachedByStat = STORAGE_META_CACHE.get(storagePath);
		if (
			cachedByStat &&
			cachedByStat.mtimeMs === stats.mtimeMs &&
			cachedByStat.size === stats.size &&
			Date.now() - stats.mtimeMs > MTIME_SHORTCIRCUIT_SETTLE_MS
		) {
			return metaFromSnapshot(cachedByStat);
		}
		const bytes = readFileSync(storagePath);
		const contentHash = hashStorageBytes(bytes);
		const cached = STORAGE_META_CACHE.get(storagePath);
		if (cached && cached.contentHash === contentHash) {
			// Content is byte-identical despite the mtime/size change (e.g. an
			// atomic-rename rewrite of the same bytes). Refresh the stat fields so
			// the next request takes the fast path, but skip the JSON.parse.
			const refreshed: StorageMetaSnapshot = {
				...cached,
				mtimeMs: stats.mtimeMs,
				size: stats.size,
			};
			STORAGE_META_CACHE.set(storagePath, refreshed);
			return metaFromSnapshot(refreshed);
		}
		const parsed = JSON.parse(bytes.toString("utf8")) as {
			pinnedAccountIndex?: unknown;
			affinityGeneration?: unknown;
		};
		const pinnedAccountIndex =
			typeof parsed.pinnedAccountIndex === "number" &&
			Number.isFinite(parsed.pinnedAccountIndex)
				? Math.trunc(parsed.pinnedAccountIndex)
				: null;
		const affinityGeneration =
			typeof parsed.affinityGeneration === "number" &&
			Number.isFinite(parsed.affinityGeneration) &&
			Number.isInteger(parsed.affinityGeneration) &&
			parsed.affinityGeneration >= 0
				? parsed.affinityGeneration
				: 0;
		const snapshot: StorageMetaSnapshot = {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			contentHash,
			pinnedAccountIndex,
			affinityGeneration,
		};
		STORAGE_META_CACHE.set(storagePath, snapshot);
		return { pinnedAccountIndex, affinityGeneration };
	} catch (error) {
		// On any failure, prefer the last good snapshot for this path so we
		// don't blow away affinity unnecessarily. Defensive: even non-transient
		// errors fall back to the cache when one exists — better stale than
		// wrong. Defaults are only returned when this file has never been read
		// successfully (cache miss).
		void error;
		const cached = STORAGE_META_CACHE.get(storagePath);
		if (cached) {
			return metaFromSnapshot(cached);
		}
		return { pinnedAccountIndex: null, affinityGeneration: 0 };
	}
}

/**
 * Backwards-compatible helper retained for tests. Prefer `readStorageMetaFromDisk`
 * for new callers that also need `affinityGeneration`.
 */
export function readPinnedAccountIndexFromDisk(
	storagePath: string = getStoragePath(),
): number | null {
	return readStorageMetaFromDisk(storagePath).pinnedAccountIndex;
}

/**
 * Test-only: reset the storage-meta content-hash cache between scenarios so
 * each test starts from a clean read-from-disk state.
 */
export function resetPinCacheForTesting(): void {
	STORAGE_META_CACHE.clear();
}

/**
 * If the on-disk `affinityGeneration` is greater than `lastObservedGeneration`,
 * drop every entry in `sessionAffinityStore` and return the new generation so
 * the caller can update its tracker. Otherwise returns `lastObservedGeneration`
 * unchanged. Extracted so the request-flow logic can be unit-tested without
 * spinning up the full proxy. See issue #474.
 */
export function maybeInvalidateAffinityFromDisk(
	sessionAffinityStore: SessionAffinityStore | null,
	lastObservedGeneration: number,
	storagePath: string = getStoragePath(),
): number {
	const meta = readStorageMetaFromDisk(storagePath);
	if (meta.affinityGeneration > lastObservedGeneration) {
		sessionAffinityStore?.clearAll();
		return meta.affinityGeneration;
	}
	return lastObservedGeneration;
}

async function persistRuntimeActiveAccount(
	accountManager: AccountManager,
	account: ManagedAccount,
	family: ModelFamily,
	isPinned: boolean,
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
		if (accountManager.getRoutingMutexMode() !== "enabled") {
			await accountManager.markSwitchedLocked(account, "rotation", family);
		}
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

// Monotonic auth-failure cooldown: only extend, never shorten. Two concurrent
// requests on the same account can race so that an invalidation path sets a
// long cooldown (5 min) and a subsequent generic 401 truncates it (30 s).
// Reading the live coolingDownUntil before writing prevents that race.
function applyMonotonicAuthCooldown(
	accountManager: AccountManager,
	account: ManagedAccount,
	cooldownMs: number,
): void {
	const existing = accountManager.getAccountByIndex(account.index)?.coolingDownUntil ?? 0;
	// Intentionally Date.now(), not the proxy's injected now(): coolingDownUntil is
	// written by markAccountCoolingDown via nowMs() (== Date.now()), so both sides of
	// this comparison must live in the same real-wall-clock domain. Switching to the
	// injected now() would mis-compare an injected-clock value against a real-clock
	// deadline and silently defeat the monotonic guard.
	if (Date.now() + cooldownMs > existing) {
		accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
	}
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
	tokenInvalidationCooldownMs: number;
}): Promise<
	| { ok: true; accessToken: string; account: ManagedAccount }
	| { ok: false; retryable: boolean; invalidated?: boolean }
> {
	const { accountManager, account, family, model, now, tokenRefreshSkewMs, tokenInvalidationCooldownMs } =
		params;
	if (hasUsableAccessToken(account, now, tokenRefreshSkewMs)) {
		return { ok: true, accessToken: account.access ?? "", account };
	}

	const refreshResult = await queuedRefresh(account.refreshToken);
	if (refreshResult.type === "failed") {
		accountManager.recordFailure(account, family, model);
		accountManager.incrementAuthFailures(account);
		// If the refresh endpoint itself returns an explicit invalidation message
		// (e.g. Microsoft/Outlook SSO revokes the refresh token server-side), apply
		// the long cooldown and signal to the caller to stop rotating rather than
		// presenting other accounts' tokens from the same IP.
		const invalidated = isTokenInvalidationError(refreshResult.message ?? "");
		applyMonotonicAuthCooldown(
			accountManager,
			account,
			invalidated ? tokenInvalidationCooldownMs : DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
		);
		accountManager.saveToDiskDebounced();
		return { ok: false, retryable: isTokenRefreshRetryable(refreshResult), invalidated };
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

async function readErrorBody(
	response: Response,
	timeoutMs: number,
	maxBytes = 1024 * 1024,
): Promise<string> {
	// The outbound fetch's abort timer is cleared once headers arrive, so a
	// stalled error body would otherwise hang this handler forever (the success
	// path is per-chunk stall-bounded; the error path was not). Read the body via
	// a reader, bound it by an idle timeout AND a size cap, and cancel the stream
	// on timeout/overflow so the socket is released.
	const body = response.body;
	if (!body || typeof body.getReader !== "function") {
		// Fallback for impls without a streamable body: race text() against a timer.
		try {
			return await withTimeout(
				response.text(),
				timeoutMs,
				() => undefined,
				"error body stalled",
			);
		} catch {
			return "";
		}
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<never>((_resolve, reject) => {
				idleTimer = setTimeout(
					() => reject(new Error("error body stalled")),
					Math.max(1, timeoutMs),
				);
			});
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await Promise.race([reader.read(), idle]);
			} finally {
				if (idleTimer) clearTimeout(idleTimer);
			}
			if (result.done) break;
			if (result.value) {
				total += result.value.byteLength;
				if (total > maxBytes) break; // cap: enough for diagnostics, no OOM
				chunks.push(result.value);
			}
		}
	} catch {
		// stalled or errored — fall through with whatever we have
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	try {
		return Buffer.concat(chunks).toString("utf8");
	} catch {
		return "";
	}
}

const TOKEN_INVALIDATED_CODE = "token_invalidated";
const TOKEN_INVALIDATED_FALLBACK_MESSAGE =
	"OAuth token has been invalidated. Please re-login.";

// Both invalidation exit paths (refresh-failure and upstream-401) must hand the
// client the same machine-readable shape — { error: { message, code:
// "token_invalidated" } } — so a consumer keying off error.code behaves
// identically regardless of which vector fired. The upstream forwards a raw body
// with no guaranteed code, so we wrap it here while preserving its human-readable
// message when one is present.
export function buildTokenInvalidationBody(upstreamBodyText: string): string {
	let message = TOKEN_INVALIDATED_FALLBACK_MESSAGE;
	const trimmed = upstreamBodyText.trim();
	if (trimmed) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isRecord(parsed)) {
				const direct = parsed.message;
				if (typeof direct === "string" && direct.trim()) {
					message = direct.trim();
				} else if (isRecord(parsed.error)) {
					const nested = parsed.error.message;
					if (typeof nested === "string" && nested.trim()) {
						message = nested.trim();
					}
				}
			}
		} catch {
			// Non-JSON upstream body (e.g. HTML error page): keep the stable fallback
			// message rather than echoing markup back to the client.
		}
	}
	return JSON.stringify({ error: { message, code: TOKEN_INVALIDATED_CODE } });
}

function extractErrorCodeFromBody(bodyText: string): string | null {
	if (!bodyText.trim()) return null;
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (!isRecord(parsed)) return null;
		const directCode = parsed.code;
		if (typeof directCode === "string" && directCode.trim()) {
			return directCode.trim();
		}
		const maybeError = parsed.error;
		if (!isRecord(maybeError)) return null;
		const nestedCode = maybeError.code;
		return typeof nestedCode === "string" && nestedCode.trim()
			? nestedCode.trim()
			: null;
	} catch {
		return null;
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

/**
 * `chooseAccount` is a SYNC selector that internally advances the rotation
 * cursor (the session-affinity-preferred branch and the round-robin fallback
 * both call `accountManager.markSwitched(...)`, and the hybrid selector advances
 * its own cursor). It does NOT acquire the routing mutex itself.
 *
 * Concurrency (L4): when `routingMutex === "enabled"`, the proxy hot path runs
 * this whole call AND the subsequent `markSwitchedLocked` commit inside a single
 * `withRoutingMutex` acquisition, so concurrent requests serialize selection +
 * cursor advance and cannot stampede the same account. `withRoutingMutex` is
 * reentrant (AsyncLocalStorage), so the nested `markSwitchedLocked` — and the
 * later one in `persistRuntimeActiveAccount` — run inline without re-acquiring
 * the non-reentrant FIFO queue (no deadlock). In legacy mode the inline
 * `markSwitched` calls below are used unchanged and no lock is taken, so default
 * behavior and perf are identical. See the hot-path caller in
 * `startRuntimeRotationProxy` and the regression in
 * `test/runtime-rotation-proxy.test.ts`.
 */
export function chooseAccount(params: {
	accountManager: AccountManager;
	sessionAffinityStore: SessionAffinityStore | null;
	sessionKey: string | null;
	family: ModelFamily;
	model: string | null;
	attemptedIndexes: ReadonlySet<number>;
	now: number;
	policy: RuntimePolicyDecision | null;
	pinnedIndex: number | null;
	skipReasons?: Map<number, string>;
	stickyBoostByAccount?: Record<number, number>;
	pidOffsetEnabled?: boolean;
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
		pinnedIndex,
		skipReasons,
		stickyBoostByAccount,
		pidOffsetEnabled,
	} = params;

	// Manual pin (from `codex-multi-auth switch <n>`) overrides every other
	// selection signal. We do NOT call markSwitched here — the proxy must not
	// clobber the pin set by the CLI. See issue #474.
	if (typeof pinnedIndex === "number") {
		if (attemptedIndexes.has(pinnedIndex)) {
			skipReasons?.set(pinnedIndex, "already-attempted");
			return null;
		}
		if (pinnedIndex < 0 || pinnedIndex >= accountManager.getAccountCount()) {
			skipReasons?.set(pinnedIndex, "missing");
			return null;
		}
		if (policy?.blockedAccountIndexes.has(pinnedIndex)) {
			skipReasons?.set(pinnedIndex, "policy-blocked");
			return null;
		}
		const pinned = accountManager.getAccountByIndex(pinnedIndex);
		if (!pinned || pinned.enabled === false) {
			skipReasons?.set(pinnedIndex, "disabled");
			return null;
		}
		const reason = accountManager.getAccountRuntimeSkipReason(
			pinnedIndex,
			family,
			model,
		);
		if (reason) {
			skipReasons?.set(pinnedIndex, reason);
			return null;
		}
		return pinned;
	}

	const preferredIndex = sessionAffinityStore?.getPreferredAccountIndex(sessionKey, now);
	if (
		typeof preferredIndex === "number" &&
		!attemptedIndexes.has(preferredIndex) &&
		!policy?.blockedAccountIndexes.has(preferredIndex)
	) {
		const preferred = accountManager.getAccountByIndex(preferredIndex);
		if (
			preferred) {
			const reason = accountManager.getAccountRuntimeSkipReason(
				preferred.index,
				family,
				model,
			);
			if (reason) {
				skipReasons?.set(preferred.index, reason);
			} else {
			// L4 (deferred): unlocked cursor mutation — see chooseAccount header.
			accountManager.markSwitched(preferred, "rotation", family);
			return preferred;
			}
		}
	}

	const selected = accountManager.getCurrentOrNextForFamilyHybrid(family, model, {
		scoreBoostByAccount: {
			...(policy?.scoreBoostByAccount ?? {}),
			...(stickyBoostByAccount ?? {}),
		},
		// accounts-05: carry the PID-offset distribution into the default-on proxy
		// path too (index.ts already does). Without it, parallel proxy processes can
		// stampede the same account instead of spreading across the pool.
		pidOffsetEnabled,
	});
	if (
		selected &&
		!attemptedIndexes.has(selected.index) &&
		!policy?.blockedAccountIndexes.has(selected.index)
	) {
		const reason = accountManager.getAccountRuntimeSkipReason(
			selected.index,
			family,
			model,
		);
		if (!reason) return selected;
		skipReasons?.set(selected.index, reason);
	}

	for (const account of accountManager.getAccountsSnapshot()) {
		if (attemptedIndexes.has(account.index)) {
			skipReasons?.set(account.index, "already-attempted");
			continue;
		}
		if (policy?.blockedAccountIndexes.has(account.index)) {
			skipReasons?.set(account.index, "policy-blocked");
			continue;
		}
		const reason = accountManager.getAccountRuntimeSkipReason(
			account.index,
			family,
			model,
		);
		if (!reason) {
			const live = accountManager.getAccountByIndex(account.index);
			if (!live) continue;
			// L4 (deferred): unlocked cursor mutation — see chooseAccount header.
			accountManager.markSwitched(live, "rotation", family);
			return live;
		}
		skipReasons?.set(account.index, reason);
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

function normalizeExhaustionStatus(reason: ExhaustionReason): number {
	return reason === "rate-limit" ? HTTP_STATUS.TOO_MANY_REQUESTS : 503;
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

/**
 * Build the JSON `error` body for a pinned-account 503 response. Extracted so
 * the null-reason desync path (`reason: null`, no parenthetical in `message`)
 * can be unit-tested without standing up a full proxy. The shape mirrors
 * `writePoolExhausted` so consumers can handle both 503 codes uniformly. See
 * issue #486.
 */
export interface PinnedUnavailableErrorBody {
	message: string;
	code: "codex_pinned_account_unavailable";
	pinnedAccountIndex: number | null;
	reason: string | null;
	account_skip_reasons: Record<string, string>;
}

export function buildPinnedUnavailableErrorBody(
	pinnedIndex: number | null | undefined,
	accountSkipReasons: ReadonlyMap<number, string>,
): PinnedUnavailableErrorBody {
	const normalizedPinnedIndex =
		typeof pinnedIndex === "number" ? pinnedIndex : null;
	const skipReason =
		normalizedPinnedIndex !== null
			? accountSkipReasons.get(normalizedPinnedIndex) ?? null
			: null;
	const reasonSuffix = skipReason ? ` (${skipReason})` : "";
	const displayIndex = (normalizedPinnedIndex ?? 0) + 1;
	return {
		message: `Pinned account ${displayIndex} is currently unavailable${reasonSuffix}; run \`codex-multi-auth status\` for details, or \`codex-multi-auth unpin\` to allow rotation.`,
		code: "codex_pinned_account_unavailable",
		pinnedAccountIndex: normalizedPinnedIndex,
		reason: skipReason,
		account_skip_reasons: Object.fromEntries(
			[...accountSkipReasons.entries()].map(([index, reason]) => [
				String(index),
				reason,
			]),
		),
	};
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
	let activeAccountManager = options.accountManager ?? (await AccountManager.loadFromDisk());
	const knownAccountManagers = new Set<AccountManager>([activeAccountManager]);
	// accounts-01/08: apply the configured routing-mutex mode so the proxy's
	// async select->commit path (persistRuntimeActiveAccount) can serialize cursor
	// mutations when routingMutex="enabled". Legacy mode keeps the inline fast path.
	const routingMutexMode = getRoutingMutexMode(pluginConfig);
	activeAccountManager.setRoutingMutexMode(routingMutexMode);
	const fetchImpl = options.fetchImpl ?? fetch;
	const host = options.host ?? DEFAULT_HOST;
	// Defense in depth (runtime-proxy-01): the proxy presents managed OAuth tokens
	// and must never be reachable off-box. It is loopback-only with NO opt-out —
	// binding a non-loopback host would expose every managed account to the
	// network, so it is refused unconditionally.
	if (!isLoopbackHost(host)) {
		throw new Error(
			`Runtime rotation proxy refuses to bind non-loopback host "${host}". ` +
				"It forwards managed OAuth tokens and is loopback-only.",
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
		throw new Error("Runtime rotation proxy requires a clientApiKey.");
	}
	const now = options.now ?? Date.now;
	const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
	const networkErrorCooldownMs = getNetworkErrorCooldownMs(pluginConfig);
	const serverErrorCooldownMs = getServerErrorCooldownMs(pluginConfig);
	const tokenInvalidationCooldownMs = getTokenInvalidationCooldownMs(pluginConfig);
	const minRotationIntervalMs = getMinRotationIntervalMs(pluginConfig);
	const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
	let lastGlobalAccountIndex: number | null = null;
	let lastGlobalSwitchAt = 0;
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
	let lastObservedAffinityGeneration =
		readStorageMetaFromDisk().affinityGeneration;
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
	const threadGoalFallbacks = new Map<string, string | null>();
	let staleRuntimeReloadPromise: Promise<AccountManager | null> | null = null;
	let lastStaleRuntimeReloadAt = 0;
	const staleRuntimeReloadDedupeMs = 1_000;

	const recoverStaleRuntimeState = async (): Promise<AccountManager | null> => {
		if (Date.now() - lastStaleRuntimeReloadAt <= staleRuntimeReloadDedupeMs) {
			return activeAccountManager;
		}
		if (staleRuntimeReloadPromise) {
			return staleRuntimeReloadPromise;
		}
		staleRuntimeReloadPromise = (async () => {
			AccountManager.resetVolatileRuntimeState();
			recordRuntimeReset("pool-exhausted-no-account");
			const reloaded = await AccountManager.loadFromDisk();
			reloaded.setRoutingMutexMode(routingMutexMode);
			activeAccountManager = reloaded;
			knownAccountManagers.add(reloaded);
			lastStaleRuntimeReloadAt = Date.now();
			recordRuntimeReload("pool-exhausted-no-account");
			return reloaded;
		})()
			.catch((error) => {
				status.lastError = error instanceof Error ? error.message : String(error);
				return null;
			})
			.finally(() => {
				staleRuntimeReloadPromise = null;
			});
		return staleRuntimeReloadPromise;
	};

	const handleRequest = async (
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> => {
		// Per-request trace id (errors-logging-03): distinct from sessionKey, which
		// is shared across a thread's requests. Bound to this request's async context
		// so every proxyLog line and usage row can be correlated to one request.
		const traceId = randomUUID();
		return runWithCorrelationId(traceId, () => handleRequestInner(req, res, traceId));
	};

	const handleRequestInner = async (
		req: IncomingMessage,
		res: ServerResponse,
		traceId: string,
	): Promise<void> => {
		let usageRecorder: ReturnType<typeof createRuntimeUsageRecorder> | null = null;
		let accountManager = activeAccountManager;
		try {
			const incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
			// Authenticate before discriminating path/method so an unauthenticated
			// caller cannot enumerate which endpoints exist: an unknown caller always
			// gets 401, never a 404 that would confirm a path is invalid (vs. just
			// unauthorized). Authorized callers still fall through to the 404 below
			// when they hit an unsupported path/method.
			const incomingHeaders = headersFromIncoming(req);
			if (!isAuthorizedClient(incomingHeaders, clientApiKey)) {
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

			status.totalRequests += 1;
			const requestBody =
				isResponsesRequest || (isThreadGoalRequest && req.method === "POST")
					? await readRequestBody(req, maxRequestBodyBytes)
					: Buffer.alloc(0);
			const context = isModelsRequest
				? buildModelsRequestContext(req)
				: isThreadGoalRequest
					? buildThreadGoalRequestContext(req, requestBody, incomingUrl.pathname)
					: buildResponsesRequestContext(req, requestBody);
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
				status.lastError = policyError;
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
				upstreamBaseUrl,
				context.upstreamPath,
			);
			const attemptedIndexes = new Set<number>();
			let exhaustionReason: ExhaustionReason = "no-account";
			let accountCount = accountManager.getAccountCount();
			let transientAttemptLimit = Math.max(
				1,
				Math.min(accountCount, maxRuntimeAccountAttempts),
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
			if (storageMeta.affinityGeneration > lastObservedAffinityGeneration) {
				sessionAffinityStore?.clearAll();
				lastObservedAffinityGeneration = storageMeta.affinityGeneration;
			}

			while (
				attemptedIndexes.size < accountCount &&
				transientAttempts < transientAttemptLimit
			) {
				const rotationStickyBoost: Record<number, number> =
					minRotationIntervalMs > 0 &&
					lastGlobalAccountIndex !== null &&
					now() - lastGlobalSwitchAt < minRotationIntervalMs
						? { [lastGlobalAccountIndex]: 1000 }
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
						sessionAffinityStore,
						sessionKey: context.sessionKey,
						family: context.family,
						model: context.model,
						attemptedIndexes,
						now: now(),
						policy: policyDecision,
						pinnedIndex,
						skipReasons: accountSkipReasons,
						stickyBoostByAccount: rotationStickyBoost,
						pidOffsetEnabled,
					});
				const selected =
					routingMutexMode === "enabled"
						? await withRoutingMutex(routingMutexMode, async () => {
								const candidate = selectAccount();
								if (candidate && pinnedIndex === null) {
									// Re-commit the cursor under the held mutex. Skipped when a
									// manual pin is active so the proxy never clobbers the pin
									// (see #474); pinned selections are deterministic and need no
									// cursor advance. Runs inline via reentrancy — see comment
									// above.
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
						const reloadedManager = await recoverStaleRuntimeState();
						if (reloadedManager) {
							accountManager = reloadedManager;
							accountCount = accountManager.getAccountCount();
							transientAttemptLimit = Math.max(
								1,
								Math.min(accountCount, maxRuntimeAccountAttempts),
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
					now: now(),
					tokenRefreshSkewMs,
					tokenInvalidationCooldownMs,
				});
				if (!refreshed.ok) {
					accountManager.refundToken(selected, context.family, context.model);
					exhaustionReason = "auth-failure";
					if (refreshed.invalidated) {
						// Refresh endpoint explicitly revoked the token. Stop cascade:
						// return auth error to client instead of rotating to the next account.
						sessionAffinityStore?.forgetSession(context.sessionKey);
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
					transientAttempts += 1;
					transientExhaustionReason = "auth-failure";
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
					transientAttempts += 1;
					transientExhaustionReason = "network-error";
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				if (upstream.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
					const bodyText = await readErrorBody(upstream, streamStallTimeoutMs);
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
					transientAttempts += 1;
					transientExhaustionReason = "rate-limit";
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				if (upstream.status === 402 || upstream.status === HTTP_STATUS.FORBIDDEN) {
					const bodyText = await readErrorBody(upstream, streamStallTimeoutMs);
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
						sessionAffinityStore?.forgetSession(context.sessionKey);
						exhaustionReason = "deactivated";
						status.retries += 1;
						status.rotations += 1;
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
							setThreadGoalFallback(threadGoalFallbacks, fallbackKey, goal);
							writeJson(res, HTTP_STATUS.OK, { ok: true, goal });
							return;
						}
						writeJson(res, HTTP_STATUS.OK, {
							goal: getThreadGoalFallback(threadGoalFallbacks, fallbackKey),
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
					const bodyText = await readErrorBody(upstream, streamStallTimeoutMs);
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
							tokenInvalidationCooldownMs,
						);
						sessionAffinityStore?.forgetSession(context.sessionKey);
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
					status.retries += 1;
					status.rotations += 1;
					continue;
				}

				if (upstream.status >= 500) {
					await readErrorBody(upstream, streamStallTimeoutMs);
					accountManager.refundToken(refreshed.account, context.family, context.model);
					accountManager.recordFailure(refreshed.account, context.family, context.model);
					accountManager.markAccountCoolingDown(
						refreshed.account,
						serverErrorCooldownMs,
						"server-error",
					);
					accountManager.saveToDiskDebounced();
					exhaustionReason = "server-error";
					transientAttempts += 1;
					transientExhaustionReason = "server-error";
					status.retries += 1;
					status.rotations += 1;
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
						status,
						() => undefined,
						streamStallTimeoutMs,
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
					if (refreshed.account.index !== lastGlobalAccountIndex) {
						lastGlobalAccountIndex = refreshed.account.index;
					}
					lastGlobalSwitchAt = now();
				}
				await persistRuntimeActiveAccount(
					accountManager,
					refreshed.account,
					context.family,
					isPinned && refreshed.account.index === pinnedIndex,
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
					status.lastError = `pinned-503 missing skip reason (pinnedIndex=${pinnedIndex})`;
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
			// raw upstream or refresh error string before it reaches status consumers
			// or the structured log. maskString is a no-op for clean diagnostic text.
			const maskedErrorMessage = maskString(rawErrorMessage);
			status.lastError = maskedErrorMessage;
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
			await activeAccountManager.flushPendingSave();
		},
		getStatus: () => ({
			...status,
			// Redact any email/token material that leaked into a raw upstream or
			// refresh error string before exposing it to status/report consumers
			// (errors-logging-08). maskString is a no-op for clean diagnostic text.
			lastError: status.lastError === null ? null : maskString(status.lastError),
		}),
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
