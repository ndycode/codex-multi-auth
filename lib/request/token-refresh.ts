/**
 * Token refresh helpers for the custom fetch implementation
 * Extracted from fetch-helpers.ts (audit roadmap §4.1.2); fetch-helpers.ts
 * re-exports the public symbols so existing importers are unchanged.
 */

import type { Auth, CodexClient } from "@codex-ai/sdk";
import { queuedRefresh } from "../refresh-queue.js";
import type { TokenResult } from "../types.js";
import { CodexAuthError } from "../errors.js";
import { HTTP_STATUS, ERROR_MESSAGES } from "../constants.js";

interface CodexAuthSetter {
	auth: {
		set(args: {
			path: { id: string };
			body: {
				type: "oauth";
				access: string;
				refresh: string;
				expires: number;
				multiAccount: boolean;
			};
		}): Promise<unknown>;
	};
}

/**
 * Determines if the current auth token needs to be refreshed
 * @param auth - Current authentication state
 * @returns True if token is expired or invalid
 */
export function shouldRefreshToken(auth: Auth, skewMs = 0): boolean {
	if (auth.type !== "oauth") return true;
	if (!auth.access) return true;

	const safeSkewMs = Math.max(0, Math.floor(skewMs));
	return auth.expires <= Date.now() + safeSkewMs;
}

function isRetryableRefreshFailure(
	result: Extract<TokenResult, { type: "failed" }>,
): boolean {
	switch (result.reason) {
		case "network_error":
		case "unknown":
		case "invalid_response":
			return true;
		case "missing_refresh":
			return false;
		case "http_error":
			return !(
				result.statusCode === HTTP_STATUS.BAD_REQUEST ||
				result.statusCode === HTTP_STATUS.UNAUTHORIZED ||
				result.statusCode === HTTP_STATUS.FORBIDDEN
			);
		default:
			return false;
	}
}

function isRetryableAuthSetterError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}

	const candidate = error as {
		code?: unknown;
		status?: unknown;
		cause?: unknown;
	};
	const code =
		typeof candidate.code === "string"
			? candidate.code.toUpperCase()
			: undefined;
	if (code === "EAGAIN" || code === "EBUSY" || code === "EPERM") {
		return true;
	}

	if (candidate.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
		return true;
	}

	if (candidate.cause && candidate.cause !== error) {
		return isRetryableAuthSetterError(candidate.cause);
	}

	return false;
}

/**
 * Refreshes the OAuth token and updates stored credentials
 *
 * Mutation contract: on success the passed `currentAuth` object is updated
 * IN PLACE (access/refresh/expires) after the persistence await, and the same
 * reference is returned. Same-account refreshes are serialized by
 * `queuedRefresh`, so two concurrent calls for one account coalesce rather
 * than race; callers must still not share one Auth object across calls for
 * DIFFERENT accounts, and must not read token fields from a shared reference
 * while a refresh for it is in flight (the window between the persistence
 * await and the mutation block exposes the pre-refresh values).
 *
 * @param currentAuth - Current auth state
 * @param client - Codex client for updating stored credentials
 * @returns Updated auth (throws on failure)
 */
export async function refreshAndUpdateToken(
	currentAuth: Auth,
	client: CodexClient,
): Promise<Auth> {
	const authSetter = (client as Partial<CodexAuthSetter>).auth;
	if (!authSetter || typeof authSetter.set !== "function") {
		throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, {
			retryable: false,
		});
	}

	const refreshToken = currentAuth.type === "oauth" ? currentAuth.refresh : "";
	const refreshResult = await queuedRefresh(refreshToken);

	if (refreshResult.type === "failed") {
		throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, {
			retryable: isRetryableRefreshFailure(refreshResult),
			context: {
				refreshFailureReason: refreshResult.reason,
				statusCode: refreshResult.statusCode,
			},
		});
	}

	try {
		await authSetter.set({
			path: { id: "openai" },
			body: {
				type: "oauth",
				access: refreshResult.access,
				refresh: refreshResult.refresh,
				expires: refreshResult.expires,
				multiAccount: true,
			},
		});
	} catch (error) {
		throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, {
			retryable: isRetryableAuthSetterError(error),
			cause: error,
		});
	}

	// Update current auth reference if it's OAuth type
	if (currentAuth.type === "oauth") {
		currentAuth.access = refreshResult.access;
		currentAuth.refresh = refreshResult.refresh;
		currentAuth.expires = refreshResult.expires;
	}

	return currentAuth;
}
