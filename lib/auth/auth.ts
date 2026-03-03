import { generatePKCE } from "@openauthjs/openauth/pkce";
import { randomBytes } from "node:crypto";
import type { PKCEPair, AuthorizationFlow, TokenResult, ParsedAuthInput, JWTPayload } from "../types.js";
import { logError } from "../logger.js";
import { safeParseOAuthTokenResponse } from "../schemas.js";
import { isAbortError } from "../utils.js";

// OAuth constants (from openai/codex)
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";
const DEFAULT_OAUTH_EXCHANGE_TIMEOUT_MS = 60_000;

const OAUTH_SENSITIVE_QUERY_PARAMS = [
	"state",
	"code",
	"code_challenge",
	"code_verifier",
] as const;

function getOAuthResponseLogMetadata(rawResponse: unknown): Record<string, unknown> {
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
export type ExchangeAuthorizationCodeOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

function resolveExchangeTimeoutMs(timeoutMs: number | undefined): number {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
		return DEFAULT_OAUTH_EXCHANGE_TIMEOUT_MS;
	}
	return Math.max(1_000, Math.floor(timeoutMs));
}

function createAbortError(message: string): Error & { code?: string } {
	const error = new Error(message) as Error & { code?: string };
	error.name = "AbortError";
	error.code = "ABORT_ERR";
	return error;
}

function buildExchangeAbortContext(
	options: ExchangeAuthorizationCodeOptions,
): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeoutMs = resolveExchangeTimeoutMs(options.timeoutMs);
	const upstreamSignal = options.signal;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const onUpstreamAbort = () => {
		const reason = upstreamSignal?.reason;
		controller.abort(
			reason instanceof Error ? reason : createAbortError("Request aborted"),
		);
	};

	if (upstreamSignal) {
		upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
		if (upstreamSignal.aborted) {
			onUpstreamAbort();
		}
	}

	if (!controller.signal.aborted) {
		timeoutId = setTimeout(() => {
			controller.abort(
				createAbortError(
					`OAuth token exchange timed out after ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
			}
			if (upstreamSignal) {
				upstreamSignal.removeEventListener("abort", onUpstreamAbort);
			}
		},
	};
}

export async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
	options: ExchangeAuthorizationCodeOptions = {},
): Promise<TokenResult> {
	const abortContext = buildExchangeAbortContext(options);
	try {
		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal: abortContext.signal,
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
			logError("code->token failed", { status: res.status, bodyLength: text.length });
			return {
				type: "failed",
				reason: "http_error",
				statusCode: res.status,
				message: text ? "OAuth token exchange failed" : undefined,
			};
		}
		const rawJson = (await res.json()) as unknown;
		const json = safeParseOAuthTokenResponse(rawJson);
		if (!json) {
			logError("token response validation failed", getOAuthResponseLogMetadata(rawJson));
			return { type: "failed", reason: "invalid_response", message: "Response failed schema validation" };
		}
		if (!json.refresh_token || json.refresh_token.trim().length === 0) {
			logError("token response missing refresh token", getOAuthResponseLogMetadata(rawJson));
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
	} catch (error) {
		const err = error as Error;
		if (isAbortError(err)) {
			logError("code->token aborted", { message: err?.message ?? "Request aborted" });
			return { type: "failed", reason: "unknown", message: err?.message ?? "Request aborted" };
		}
		logError("code->token error", { message: err?.message ?? String(err) });
		return { type: "failed", reason: "network_error", message: err?.message ?? "Network request failed" };
	} finally {
		abortContext.cleanup();
	}
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
			logError("Token refresh failed", { status: response.status, bodyLength: text.length });
			return {
				type: "failed",
				reason: "http_error",
				statusCode: response.status,
				message: text ? "Token refresh failed" : undefined,
			};
		}

		const rawJson = (await response.json()) as unknown;
		const json = safeParseOAuthTokenResponse(rawJson);
		if (!json) {
			logError("Token refresh response validation failed", getOAuthResponseLogMetadata(rawJson));
			return { type: "failed", reason: "invalid_response", message: "Response failed schema validation" };
		}

		const nextRefreshRaw = json.refresh_token ?? refreshToken;
		const nextRefresh = nextRefreshRaw.trim();
		if (!nextRefresh) {
			logError("Token refresh missing refresh token");
			return { type: "failed", reason: "missing_refresh", message: "No refresh token in response or input" };
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
			return { type: "failed", reason: "unknown", message: err?.message ?? "Request aborted" };
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
export async function createAuthorizationFlow(options?: AuthorizationFlowOptions): Promise<AuthorizationFlow> {
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
