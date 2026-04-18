import { generatePKCE } from "@openauthjs/openauth/pkce";
import { randomBytes } from "node:crypto";
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
	"token",
	"code",
	"code_verifier",
] as const;

function scrubTokenLikeSubstrings(value: string): string {
	let scrubbed = value.replace(
		/(\b(?:refresh|access|id)[_-]?token\s*[:=]\s*)([^\s,;"'}]{8,})/gi,
		(_match, prefix) => `${prefix}***REDACTED***`,
	);
	scrubbed = scrubbed.replace(
		/\b(?:RT|AT)_ch_[A-Za-z0-9_-]{20,}\b/g,
		"***REDACTED***",
	);
	return scrubbed;
}

function redactSensitiveFields(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => redactSensitiveFields(item));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		const sensitiveSet = new Set<string>(OAUTH_SENSITIVE_BODY_KEYS);
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (sensitiveSet.has(k)) {
				out[k] = "***REDACTED***";
			} else {
				out[k] = redactSensitiveFields(v);
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

	let scrubbed = rawBody;
	for (const key of OAUTH_SENSITIVE_BODY_KEYS) {
		// "key":"value" style (JSON-like text)
		const jsonPattern = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, "g");
		scrubbed = scrubbed.replace(jsonPattern, `$1"***REDACTED***"`);
		// key=value style (urlencoded / query-string)
		const urlPattern = new RegExp(`(^|[?&\\s])(${key}=)[^&\\s]+`, "g");
		scrubbed = scrubbed.replace(urlPattern, `$1$2***REDACTED***`);
	}
	return scrubbed;
}

/**
 * Redacts sensitive OAuth query parameters for safe logging.
 * Returns the original string when parsing fails.
 */
export function redactOAuthUrlForLog(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		for (const key of OAUTH_SENSITIVE_QUERY_PARAMS) {
			if (parsed.searchParams.has(key)) {
				parsed.searchParams.set(key, "<redacted>");
			}
		}
		return parsed.toString();
	} catch {
		return rawUrl;
	}
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
	const res = await fetch(TOKEN_URL, {
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
		const response = await fetch(TOKEN_URL, {
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

/**
 * Create OAuth authorization flow
 * @param options - Optional configuration for the flow
 * @returns Authorization flow details
 */
export async function createAuthorizationFlow(
	options?: AuthorizationFlowOptions,
): Promise<AuthorizationFlow> {
	const pkce = (await generatePKCE()) as PKCEPair;
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
