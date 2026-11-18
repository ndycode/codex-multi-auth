import { randomBytes, webcrypto } from "node:crypto";
import type {
	PKCEPair,
	AuthorizationFlow,
	TokenResult,
	ParsedAuthInput,
	JWTPayload,
} from "../types.js";
import { logError } from "../logger.js";
import { safeParseOAuthTokenResponse } from "../schemas.js";
import { isAbortError } from "../utils.js";
import { fetchAuth } from "./http.js";

// OAuth constants (from openai/codex)
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

/**
 * Parsed representation of {@link REDIRECT_URI}. Single source of truth for the
 * OAuth callback origin so that the local server bind, user-facing copy, and
 * any future success-page template never drift from each other.
 *
 * The provider registers the exact string in {@link REDIRECT_URI}; this helper
 * derives host/port/path at module-load time and is frozen so consumers cannot
 * mutate the shared record by accident.
 */
export const AUTH_REDIRECT = Object.freeze(
	(() => {
		const parsed = new URL(REDIRECT_URI);
		const port = parsed.port.length > 0 ? Number(parsed.port) : 1455;
		return {
			host: parsed.hostname,
			port,
			path: parsed.pathname,
			origin: `${parsed.protocol}//${parsed.host}`,
			url: REDIRECT_URI,
		} as const;
	})(),
);

const OAUTH_SENSITIVE_QUERY_PARAMS = [
	"state",
	"code",
	"code_challenge",
	"code_verifier",
	"access_token",
	"id_token",
	"refresh_token",
	"token",
	"device_auth_id",
	"user_code",
	"authorization_code",
	"client_secret",
	"password",
	// Credential-carrying names the logger's SENSITIVE_KEYS already masks:
	// keep the query-key set aligned so they cannot reach a log either.
	"api_key",
	"apikey",
	"authorization",
	"credential",
	"credentials",
	"secret",
	"assertion",
	"client_assertion",
	"id_token_hint",
] as const;

function getOAuthResponseLogMetadata(
	rawResponse: unknown,
): Record<string, unknown> {
	if (Array.isArray(rawResponse)) {
		return { responseType: "array", itemCount: rawResponse.length };
	}

	if (rawResponse !== null && typeof rawResponse === "object") {
		const allKeys = Object.keys(rawResponse as Record<string, unknown>);
		return {
			responseType: "object",
			keyCount: allKeys.length,
		};
	}

	return { responseType: typeof rawResponse };
}

const OAUTH_SENSITIVE_BODY_KEYS = [
	"refresh_token",
	"refreshToken",
	"access_token",
	"accessToken",
	"id_token",
	"idToken",
	"codeVerifier",
	"code_verifier",
	"code_challenge",
	"codeChallenge",
	"token",
	"code",
	"state",
	"device_auth_id",
	"deviceAuthId",
	"user_code",
	"userCode",
	"authorization_code",
	"authorizationCode",
	"client_secret",
	"clientSecret",
	"password",
	// Credential-carrying names the logger's SENSITIVE_KEYS already masks:
	// keep the body-key set aligned so they cannot reach a log either.
	"api_key",
	"apiKey",
	"apikey",
	"authorization",
	"credential",
	"credentials",
	"secret",
	"assertion",
	"client_assertion",
	"clientAssertion",
	"id_token_hint",
	"idTokenHint",
] as const;

function normalizeOAuthSensitiveKey(key: string): string {
	return key.toLowerCase().replace(/[\s_-]/g, "");
}

const OAUTH_SENSITIVE_KEY_SET = new Set<string>(
	[...OAUTH_SENSITIVE_BODY_KEYS, ...OAUTH_SENSITIVE_QUERY_PARAMS].map(
		normalizeOAuthSensitiveKey,
	),
);

// A normalized key is also sensitive when it *ends* with a compound secret
// name — `x-api-key`, `x-client-secret`, `my-refresh-token`,
// `x-ms-token-aad-id-token` are still credentials. Bare `code`/`state`/`token`
// are excluded so `error_code`, `csrf_token`, `session_state`, `valid_token`
// and `api_keys` keep their documented over-redaction protection.
const OAUTH_SENSITIVE_KEY_SUFFIXES = [
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"clientsecret",
	"clientassertion",
	"apikey",
	"authorizationcode",
	"codechallenge",
	"codeverifier",
	"deviceauthid",
	"usercode",
	"idtokenhint",
	"authorization",
	"credential",
	"credentials",
	"assertion",
	"password",
	"passwords",
	"secret",
] as const;

function isOAuthSensitiveKey(key: string): boolean {
	const normalized = normalizeOAuthSensitiveKey(key);
	return (
		OAUTH_SENSITIVE_KEY_SET.has(normalized) ||
		OAUTH_SENSITIVE_KEY_SUFFIXES.some((suffix) =>
			normalized.endsWith(suffix),
		)
	);
}

// Separator inside a compound key spelling: whitespace, `_`, `-`, `+`, and the
// percent-encoded space all collapse under normalizeOAuthSensitiveKey, so
// "client-secret", "ACCESS TOKEN" and "access%20token" must match too.
const OAUTH_KEY_SEPARATOR = "(?:[\\s_+-]|%20)*";

// Free-text key shapes. `code`/`state`/`token` need a non-word boundary so
// longer names like `error_code`/`device_code`/`csrf_token` are untouched.
const OAUTH_TEXT_SECRET_KEY_PATTERN = [
	`(?:refresh|access|id)${OAUTH_KEY_SEPARATOR}token`,
	`code${OAUTH_KEY_SEPARATOR}(?:challenge|verifier)`,
	`device${OAUTH_KEY_SEPARATOR}auth${OAUTH_KEY_SEPARATOR}id`,
	`user${OAUTH_KEY_SEPARATOR}code`,
	`authorization${OAUTH_KEY_SEPARATOR}code`,
	`client${OAUTH_KEY_SEPARATOR}secret`,
	`api${OAUTH_KEY_SEPARATOR}key`,
	`client${OAUTH_KEY_SEPARATOR}assertion`,
	`id${OAUTH_KEY_SEPARATOR}token${OAUTH_KEY_SEPARATOR}hint`,
	"authorization",
	"credentials?",
	"assertion",
	"password",
	"secret",
	"state",
	"token",
	"code",
].join("|");

function scrubTokenLikeSubstrings(value: string): string {
	// Bearer runs first: in a "key: Bearer <jwt>" shape the key pass below
	// would otherwise consume the literal word "Bearer" as its value and
	// strand the token behind it.
	let scrubbed = value.replace(
		/\bBearer(?:[\s+]|%20)+[A-Za-z0-9._~+/=-]{8,4096}/gi,
		"Bearer ***REDACTED***",
	);
	// `key <sep> value` in free text. Quoted keys and encoded separator gaps
	// (%20/%22/%27) are tolerated; percent-encoded `:`/`=` (%3A/%3D, plus the
	// double-encoded %253A/%253D) count as separators, and a key directly
	// behind a %XX escape still counts as boundary (the escape itself is the
	// delimiter). `_`/`-` are deliberately absent from the gap classes so
	// `error_code`/`csrf-token` style names still survive. Value length is
	// capped so a megabyte-scale run cannot exhaust the regex backtrack
	// stack; the entropy pass below absorbs any leftover tail.
	scrubbed = scrubbed.replace(
		new RegExp(
			`((?:(?<![A-Za-z0-9_])|(?<=%[0-9a-zA-Z]{2}))(?:${OAUTH_TEXT_SECRET_KEY_PATTERN})(?:[\\s'"+]|%2[027])*(?:[:=]|%3[ad]|%253[ad])(?:[\\s'"+]|%2[027])*)([^\\s,;"'{}&=*()<>?]{4,4096})`,
			"gi",
		),
		(_match, prefix) => `${prefix}***REDACTED***`,
	);
	// Bare high-entropy slugs (32-512 chars of token charset) with no key
	// context. No word boundaries: consecutive chunks of a giant run each
	// match, so a huge homogeneous value is consumed piecewise instead of
	// overflowing the backtrack stack on one giant quantified match.
	scrubbed = scrubbed.replace(/[A-Za-z0-9_-]{32,512}/g, "***REDACTED***");
	// ChatGPT opaque token shapes — catches shorter RT_/AT_ values the entropy
	// rule misses. No leading boundary: they may be glued inside identifiers.
	scrubbed = scrubbed.replace(
		/(?:RT|AT)_ch_[A-Za-z0-9_-]{20,512}/g,
		"***REDACTED***",
	);
	return scrubbed;
}

function redactSensitiveFields(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveFields(item));
	}
	if (value !== null && typeof value === "object") {
		// Null-prototype map so a `__proto__` key stays ordinary data instead of
		// munging the output object's prototype.
		const out: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (isOAuthSensitiveKey(k)) {
				out[k] = "***REDACTED***";
			} else {
				// The key name itself can smuggle a token (an error response that
				// echoes request fields verbatim) — scrub token shapes from it.
				out[scrubTokenLikeSubstrings(k)] = redactSensitiveFields(v);
			}
		}
		return out;
	}
	if (typeof value === "string") {
		return scrubTokenLikeSubstrings(value);
	}
	return value;
}

/**
 * Scrub opaque tokens from a raw OAuth token-endpoint response body before
 * interpolating it into a log message.
 *
 * Error and success responses from `/oauth/token` may contain `refresh_token`,
 * `access_token`, or `id_token` values. ChatGPT refresh tokens are opaque
 * high-entropy strings that do NOT match the logger's `TOKEN_PATTERNS`
 * (JWT, long hex, `sk-*`, `Bearer <x>`), so they would be written verbatim
 * to disk log files when a status-body string is concatenated into a
 * `logError` message.
 *
 * Strategy:
 *   1. If the body parses as JSON, walk it and mask sensitive keys.
 *   2. Otherwise fall back to a targeted regex scrub of `"key":"value"` and
 *      `key=value` patterns for the known sensitive keys.
 *
 * The returned string is safe to interpolate into log messages.
 */
export function sanitizeOAuthResponseBodyForLog(rawBody: string): string {
	if (!rawBody) return rawBody;
	const trimmed = rawBody.trim();
	if (trimmed.length === 0) return rawBody;

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			const redacted = redactSensitiveFields(parsed);
			return JSON.stringify(redacted);
		} catch {
			// Fall through to regex scrub for malformed JSON.
		}
	}

	// Single-pass alternation over the normalized key shapes so case- and
	// separator-varied spellings ("client-secret", "ACCESS TOKEN",
	// "access%20token") still match when the body is not parseable JSON.
	let scrubbed = rawBody;
	// "key":"value" / 'key':'value' style (JSON-like text); a stray separator
	// may sit before the closing quote ("access_token ":).
	scrubbed = scrubbed.replace(
		new RegExp(
			`(["'](?:${OAUTH_TEXT_SECRET_KEY_PATTERN})${OAUTH_KEY_SEPARATOR}["']\\s*:\\s*)["'][^"']*["']`,
			"gi",
		),
		`$1"***REDACTED***"`,
	);
	// key<sep>value style (urlencoded / query-string). The boundary class
	// excludes `_` and alphanumerics so `device_code`/`error_code`/
	// `csrf_token`/`opcode` are not redacted; a leading %XX escape does count
	// as a boundary since it decodes to a delimiter.
	scrubbed = scrubbed.replace(
		new RegExp(
			`(^|[^A-Za-z0-9_]|%[0-9a-zA-Z]{2})((?:${OAUTH_TEXT_SECRET_KEY_PATTERN})${OAUTH_KEY_SEPARATOR}(?:[:=]|%3[ad]|%253[ad]))[^&\\s]+`,
			"gi",
		),
		"$1$2***REDACTED***",
	);
	return scrubTokenLikeSubstrings(scrubbed);
}

function redactUrlSearchParamsForLog(
	params: URLSearchParams,
	depth: number,
): void {
	for (const key of new Set(params.keys())) {
		if (isOAuthSensitiveKey(key)) {
			params.set(key, "<redacted>");
			continue;
		}
		// Non-sensitive keys still get a free-text scrub at every depth:
		// `msg=refresh_token%3D...` or `error_description=Bearer ...` would
		// otherwise carry embedded secrets straight into the log. URL values
		// recurse structurally while depth remains, then fall back to the
		// flat scrub so deeper nesting still loses its secrets.
		const values = params.getAll(key);
		const redactedValues = values.map((value) =>
			/^https?:\/\//i.test(value) && depth > 0
				? redactOAuthUrlForLogDepth(value, depth - 1)
				: scrubTokenLikeSubstrings(value),
		);
		if (redactedValues.some((v, i) => v !== values[i])) {
			params.delete(key);
			for (const v of redactedValues) params.append(key, v);
		}
	}
}

function redactOAuthUrlForLogDepth(rawUrl: string, depth: number): string {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return "<unparseable-url>";
	}

	redactUrlSearchParamsForLog(parsed.searchParams, depth);

	// Fragment params (#access_token=...) live in `hash`, not `searchParams`.
	// A route-style fragment (#/path?code=...) keeps its prefix, which is
	// itself free text that can carry secrets like `#code=...?` — scrub it
	// rather than copying it back verbatim. The body is decoded first so a
	// fully percent-encoded fragment cannot hide `?`/`=` from the splitter.
	let hashBody = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : "";
	if (hashBody.includes("%")) {
		try {
			hashBody = decodeURIComponent(hashBody);
		} catch {
			// Malformed escape — keep the raw fragment body.
		}
	}
	if (hashBody.includes("=")) {
		const qIndex = hashBody.indexOf("?");
		const fragPath = qIndex >= 0 ? hashBody.slice(0, qIndex + 1) : "";
		const fragParams = qIndex >= 0 ? hashBody.slice(qIndex + 1) : hashBody;
		const scrubbedPath = scrubTokenLikeSubstrings(fragPath);
		const params = new URLSearchParams(fragParams);
		redactUrlSearchParamsForLog(params, depth);
		const rebuilt = params.toString();
		if (rebuilt !== fragParams || scrubbedPath !== fragPath) {
			parsed.hash = `${scrubbedPath}${rebuilt}`;
		}
	} else if (hashBody.length > 0) {
		parsed.hash = scrubTokenLikeSubstrings(hashBody);
	}

	if (parsed.username) parsed.username = "***";
	if (parsed.password) parsed.password = "***";
	const scrubbedHost = scrubTokenLikeSubstrings(parsed.hostname);
	if (scrubbedHost !== parsed.hostname) parsed.hostname = scrubbedHost;
	parsed.pathname = scrubTokenLikeSubstrings(parsed.pathname);

	return parsed.toString();
}

/**
 * Redacts sensitive OAuth parameters for safe logging: query keys match
 * case-insensitively, fragment and nested-URL params are covered, userinfo is
 * masked, and unparseable input collapses to `<unparseable-url>` so the raw
 * string can never reach a log verbatim.
 */
export function redactOAuthUrlForLog(rawUrl: string): string {
	return redactOAuthUrlForLogDepth(rawUrl, 1);
}

/**
 * Generate a random state value for OAuth flow
 * @returns Random hex string
 */
export function createState(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Parse authorization code and state from user input
 * @param input - User input (URL, code#state, or just code)
 * @returns Parsed authorization data
 */
export function parseAuthorizationInput(input: string): ParsedAuthInput {
	const value = (input || "").trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		let code = url.searchParams.get("code") ?? undefined;
		let state = url.searchParams.get("state") ?? undefined;

		// Fallback: check hash if not found in searchParams (for #code=... format)
		if (url.hash && (!code || !state)) {
			const hashValue = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
			const hashParams = new URLSearchParams(hashValue);
			code = code ?? hashParams.get("code") ?? undefined;
			state = state ?? hashParams.get("state") ?? undefined;
		}

		if (code || state) {
			return { code, state };
		}
	} catch {
		// Invalid URL, try other parsing methods
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

/**
 * Exchange authorization code for access and refresh tokens
 * @param code - Authorization code from OAuth flow
 * @param verifier - PKCE verifier
 * @param redirectUri - OAuth redirect URI
 * @returns Token result
 */
export async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
	const res = await fetchAuth(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		const safeText = sanitizeOAuthResponseBodyForLog(text);
		logError(`code->token failed: ${res.status} ${safeText}`);
		return {
			type: "failed",
			reason: "http_error",
			statusCode: res.status,
			message: safeText || undefined,
		};
	}
	const rawJson = (await res.json()) as unknown;
	const json = safeParseOAuthTokenResponse(rawJson);
	if (!json) {
		logError(
			"token response validation failed",
			getOAuthResponseLogMetadata(rawJson),
		);
		return {
			type: "failed",
			reason: "invalid_response",
			message: "Response failed schema validation",
		};
	}
	if (!json.refresh_token || json.refresh_token.trim().length === 0) {
		logError(
			"token response missing refresh token",
			getOAuthResponseLogMetadata(rawJson),
		);
		return {
			type: "failed",
			reason: "invalid_response",
			message: "Missing refresh token in authorization code exchange response",
		};
	}
	const normalizedRefreshToken = json.refresh_token.trim();
	return {
		type: "success",
		access: json.access_token,
		refresh: normalizedRefreshToken,
		expires: Date.now() + json.expires_in * 1000,
		idToken: json.id_token,
		multiAccount: true,
	};
}

/**
 * Decode a JWT token to extract payload
 * @param token - JWT token to decode
 * @returns Decoded payload or null if invalid
 */
export function decodeJWT(token: string): JWTPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			"=",
		);
		const decoded = Buffer.from(padded, "base64").toString("utf-8");
		return JSON.parse(decoded) as JWTPayload;
	} catch {
		return null;
	}
}

/**
 * Refresh access token using refresh token
 * @param refreshToken - Refresh token
 * @returns Token result
 */
type RefreshAccessTokenOptions = {
	signal?: AbortSignal;
};

export async function refreshAccessToken(
	refreshToken: string,
	options: RefreshAccessTokenOptions = {},
): Promise<TokenResult> {
	try {
		const response = await fetchAuth(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal: options?.signal,
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			const safeText = sanitizeOAuthResponseBodyForLog(text);
			logError(`Token refresh failed: ${response.status} ${safeText}`);
			return {
				type: "failed",
				reason: "http_error",
				statusCode: response.status,
				message: safeText || undefined,
			};
		}

		const rawJson = (await response.json()) as unknown;
		const json = safeParseOAuthTokenResponse(rawJson);
		if (!json) {
			logError(
				"Token refresh response validation failed",
				getOAuthResponseLogMetadata(rawJson),
			);
			return {
				type: "failed",
				reason: "invalid_response",
				message: "Response failed schema validation",
			};
		}

		const nextRefreshRaw = json.refresh_token ?? refreshToken;
		const nextRefresh = nextRefreshRaw.trim();
		if (!nextRefresh) {
			logError("Token refresh missing refresh token");
			return {
				type: "failed",
				reason: "missing_refresh",
				message: "No refresh token in response or input",
			};
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: nextRefresh,
			expires: Date.now() + json.expires_in * 1000,
			idToken: json.id_token,
			multiAccount: true,
		};
	} catch (error) {
		const err = error as Error;
		if (isAbortError(err)) {
			return {
				type: "failed",
				reason: "unknown",
				message: err?.message ?? "Request aborted",
			};
		}
		logError("Token refresh error", err);
		return { type: "failed", reason: "network_error", message: err?.message };
	}
}

export interface AuthorizationFlowOptions {
	/**
	 * Force a fresh login screen instead of using cached browser session.
	 * Use when adding multiple accounts to ensure different credentials.
	 */
	forceNewLogin?: boolean;
}

async function generatePKCE(): Promise<PKCEPair> {
	const verifier = randomBytes(64).toString("base64url");
	const digest = await webcrypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = Buffer.from(digest).toString("base64url");
	return { verifier, challenge };
}

/**
 * Create OAuth authorization flow
 * @param options - Optional configuration for the flow
 * @returns Authorization flow details
 */
export async function createAuthorizationFlow(
	options?: AuthorizationFlowOptions,
): Promise<AuthorizationFlow> {
	const pkce = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", "codex_cli_rs");

	// Force a fresh login screen when adding multiple accounts
	// This helps prevent the browser from auto-using an existing session
	if (options?.forceNewLogin) {
		url.searchParams.set("prompt", "login");
	}

	return { pkce, state, url: url.toString() };
}
