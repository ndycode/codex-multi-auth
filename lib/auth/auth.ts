import { generatePKCE } from "@openauthjs/openauth/pkce";
import { randomBytes } from "node:crypto";
import type { PKCEPair, AuthorizationFlow, TokenResult, ParsedAuthInput, JWTPayload } from "../types.js";
import { logError } from "../logger.js";
import { safeParseOAuthTokenResponse } from "../schemas.js";

// OAuth constants (from openai/codex)
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

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
		logError(`code->token failed: ${res.status} ${text}`);
		return { type: "failed", reason: "http_error", statusCode: res.status, message: text || undefined };
	}
	const rawJson = (await res.json()) as unknown;
	const json = safeParseOAuthTokenResponse(rawJson);
	if (!json) {
		logError("token response validation failed", rawJson);
		return { type: "failed", reason: "invalid_response", message: "Response failed schema validation" };
	}
	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token ?? "",
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
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			logError(`Token refresh failed: ${response.status} ${text}`);
			return { type: "failed", reason: "http_error", statusCode: response.status, message: text || undefined };
		}

		const rawJson = (await response.json()) as unknown;
		const json = safeParseOAuthTokenResponse(rawJson);
		if (!json) {
			logError("Token refresh response validation failed", rawJson);
			return { type: "failed", reason: "invalid_response", message: "Response failed schema validation" };
		}

		const nextRefresh = json.refresh_token ?? refreshToken;
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
