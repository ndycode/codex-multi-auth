import { HTTP_STATUS } from "../constants.js";
import type { ExhaustionReason } from "../runtime/rotation-server-types.js";
import type { TokenResult } from "../types.js";
import { isRecord } from "../utils.js";

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

export function isTokenInvalidationError(bodyText: string): boolean {
	const lower = bodyText.toLowerCase();
	return TOKEN_INVALIDATION_PHRASES.some((phrase) => lower.includes(phrase));
}

export function isTokenRefreshRetryable(result: Extract<TokenResult, { type: "failed" }>): boolean {
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

export function parseRetryAfterHeaderMs(headers: Headers, now: number): number | null {
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

export function parseRetryAfterBodyMs(bodyText: string, now: number): number | null {
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

export function extractErrorCodeFromBody(bodyText: string): string | null {
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

export function getQuotaNearExhaustionWaitMs(
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

export function normalizeExhaustionStatus(reason: ExhaustionReason): number {
	return reason === "rate-limit" ? HTTP_STATUS.TOO_MANY_REQUESTS : 503;
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
	// On the desync path the pin index is unknown (null); claiming "account 1"
	// there would contradict the machine-readable pinnedAccountIndex: null.
	const accountPhrase =
		normalizedPinnedIndex === null
			? "The pinned account"
			: `Pinned account ${normalizedPinnedIndex + 1}`;
	return {
		message: `${accountPhrase} is currently unavailable${reasonSuffix}; run \`codex-multi-auth status\` for details, or \`codex-multi-auth unpin\` to allow rotation.`,
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
