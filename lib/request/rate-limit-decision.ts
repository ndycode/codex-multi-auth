import { HTTP_STATUS, MAX_RATE_LIMIT_DELAY_MS } from "../constants.js";
import type { ExhaustionReason } from "../runtime/rotation-server-types.js";
import type { CooldownReason } from "../storage/public-types.js";
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
	// Clamp at source: a bogus upstream reset header must never yield an
	// unbounded near-exhaustion wait, even for a future caller that forgets to
	// clamp downstream (defense in depth for stress audit H1).
	if (candidates.length === 0) return 0;
	return Math.min(Math.max(...candidates), MAX_RATE_LIMIT_DELAY_MS);
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
	/** How the pin was set; forced pins are not cleared by `unpin`. */
	pin_source: "forced" | "manual" | null;
	/** When the blocking record ends, when the skip reason is time-bounded. */
	reset_at: string | null;
	retry_after_ms: number | null;
	account_skip_reasons: Record<string, string>;
}

/**
 * Largest epoch-ms value `new Date(...).toISOString()` accepts; anything beyond
 * throws RangeError (ECMAScript time-value limit, ±100,000,000 days).
 */
const MAX_ECMASCRIPT_TIME_VALUE = 8_640_000_000_000_000;

export interface PinnedUnavailableContext {
	/**
	 * "forced" when the pin came from the wrapper's forced-account mode
	 * (`--account` / CODEX_MULTI_AUTH_FORCE_ACCOUNT, which the wrapper resolves
	 * into the internal CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX), "manual" when it
	 * came from `switch`. `unpin` clears only the manual kind, so the remedy
	 * line must not suggest it for a forced pin.
	 */
	pinSource?: "forced" | "manual" | null;
	/** Epoch ms when the blocking record ends (rate limit or cooldown). */
	resetAtMs?: number | null;
	/**
	 * Which class of record supplies `resetAtMs`. That deadline is the max
	 * across every gating record, so a `rate-limited` skip reason can carry a
	 * deadline supplied by a breaker or cooldown that ends later, and the
	 * quota phrasing is only true when the rate limit itself is that bound.
	 *
	 * - `"rate-limit"` — the rate-limit records bound it; word it as a reset.
	 * - `"other"` — a cooldown or breaker ends later and bounds it instead.
	 * - `"unknown"` (the default) — the caller did not measure; trust the
	 *   skip reason.
	 *
	 * Deliberately a value rather than the presence of a second deadline
	 * field. The previous shape branched on `"rateLimitResetAtMs" in context`,
	 * so a caller that spread the key with an `undefined` value got the
	 * opposite wording from one that omitted it — a contract no type could
	 * express and no compiler could check.
	 */
	recoveryBound?: "rate-limit" | "other" | "unknown";
	/**
	 * The pin's CURRENT runtime skip reason, re-read from account state at the
	 * moment the 503 is built. `accountSkipReasons` holds the most recent
	 * selection or attempt verdict, which can be less specific than a cooldown
	 * or breaker created later in the same pass. Omitted when the caller did not
	 * re-read runtime state.
	 */
	currentSkipReason?: string | null;
	now?: number;
}

/**
 * The human sentence derives its parenthetical and its deadline noun from the
 * blocker class. The deadline is max(rate-limit reset, cooldown end, breaker
 * next-attempt), so calling it a "limit" is only true for the rate-limit
 * class: during a provider outage a tripped breaker or a server-error
 * cooldown printed "the recorded limit resets at …", and operators read a
 * backend incident as a blown subscription quota. Only the message changes —
 * the machine-readable `reason` keeps the raw skip token.
 */
type DeadlineNoun =
	| "available-again"
	| "next-attempt"
	| "cooldown-ends"
	| "rate-limit-reset";

const DEADLINE_SENTENCES: Record<DeadlineNoun, (resetAt: string) => string> = {
	"available-again": (resetAt) =>
		`the account is expected to be available again at ${resetAt}`,
	"next-attempt": (resetAt) => `the next attempt is allowed at ${resetAt}`,
	"cooldown-ends": (resetAt) => `the cooldown ends at ${resetAt}`,
	"rate-limit-reset": (resetAt) => `the rate limit resets at ${resetAt}`,
};

interface BlockerDescription {
	parenthetical: string;
	deadlineNoun: DeadlineNoun;
}

/**
 * Every cooldown variant is bounded by the same `coolingDownUntil` field, so
 * they all word their deadline the same way. Two of them used to say "the next
 * attempt is allowed at" while the rest said "the cooldown ends at", which
 * reads as two different mechanisms to an operator comparing two 503s.
 *
 * `satisfies` is what keeps this honest: a new CooldownReason becomes a
 * compile error here rather than falling through to the verbatim arm below,
 * which would print the raw `cooling-down:<reason>` token in the sentence —
 * the internal-token leak issue #675 was filed about.
 */
const COOLDOWN_DESCRIPTIONS = {
	"auth-failure": {
		parenthetical: "cooling down after authentication failures",
		deadlineNoun: "cooldown-ends",
	},
	"network-error": {
		parenthetical: "cooling down after network errors",
		deadlineNoun: "cooldown-ends",
	},
	"server-error": {
		parenthetical: "cooling down after upstream server errors",
		deadlineNoun: "cooldown-ends",
	},
	"rate-limit": {
		parenthetical: "cooling down after a rate limit",
		deadlineNoun: "cooldown-ends",
	},
} satisfies Record<CooldownReason, BlockerDescription>;

const BLOCKER_DESCRIPTIONS: ReadonlyMap<string, BlockerDescription> = new Map<
	string,
	BlockerDescription
>([
	[
		"rate-limited",
		// Upgraded to "rate-limit-reset" below when the caller confirms the
		// rate limit is what bounds the advertised deadline.
		{ parenthetical: "rate-limited", deadlineNoun: "available-again" },
	],
	[
		"circuit-open",
		{
			parenthetical: "paused after repeated upstream errors",
			deadlineNoun: "next-attempt",
		},
	],
	["cooling-down", { parenthetical: "cooling down", deadlineNoun: "cooldown-ends" }],
	...Object.entries(COOLDOWN_DESCRIPTIONS).map(
		([reason, description]): [string, BlockerDescription] => [
			`cooling-down:${reason}`,
			description,
		],
	),
]);

// Retry-budget exhaustion can end immediately after an upstream attempt,
// before selection gets another pass to translate that attempt into a live
// cooldown or breaker. Keep these final verdicts operator-facing without
// treating them as live blockers: a concurrently opened circuit or cooldown
// must still take precedence in buildPinnedUnavailableErrorBody below.
const ATTEMPT_VERDICT_DESCRIPTIONS: ReadonlyMap<string, BlockerDescription> =
	new Map([
		[
			"auth-failure",
			{
				parenthetical: "authentication failure",
				deadlineNoun: "available-again",
			},
		],
		[
			"network-error",
			{
				parenthetical: "upstream network error",
				deadlineNoun: "available-again",
			},
		],
		[
			"server-error",
			{
				parenthetical: "upstream server error",
				deadlineNoun: "available-again",
			},
		],
	]);

/** Whether the sentence has real wording for this token, or must echo it raw. */
function isDescribedBlocker(skipReason: string): boolean {
	return BLOCKER_DESCRIPTIONS.has(skipReason);
}

/**
 * The human sentence derives its parenthetical and its deadline noun from the
 * blocker class. The deadline is max(rate-limit reset, cooldown end, breaker
 * next-attempt), so calling it a "limit" is only true for the rate-limit
 * class: during a provider outage a tripped breaker or a server-error
 * cooldown printed "the recorded limit resets at …", and operators read a
 * backend incident as a blown subscription quota. Only the message changes —
 * the machine-readable `reason` keeps the raw skip token.
 */
function describePinnedBlocker(
	skipReason: string | null,
	rateLimitBoundsRecovery: boolean,
): {
	parenthetical: string | null;
	deadline: (resetAt: string) => string;
} {
	if (skipReason === null) {
		return {
			parenthetical: null,
			deadline: DEADLINE_SENTENCES["available-again"],
		};
	}
	const described =
		BLOCKER_DESCRIPTIONS.get(skipReason) ??
		ATTEMPT_VERDICT_DESCRIPTIONS.get(skipReason);
	if (described === undefined) {
		// Permanent blockers never reach the deadline clause (the call site
		// suppresses their reset time), and future or internal tokens stay
		// legible verbatim.
		return {
			parenthetical: skipReason,
			deadline: DEADLINE_SENTENCES["available-again"],
		};
	}
	// A breaker or cooldown can outlive the rate limit; the deadline is the max
	// of every gating record, so it is only worded as the limit's own reset
	// when the rate limit actually supplies it.
	const deadlineNoun: DeadlineNoun =
		skipReason === "rate-limited" && rateLimitBoundsRecovery
			? "rate-limit-reset"
			: described.deadlineNoun;
	return {
		parenthetical: described.parenthetical,
		deadline: DEADLINE_SENTENCES[deadlineNoun],
	};
}

export function buildPinnedUnavailableErrorBody(
	pinnedIndex: number | null | undefined,
	accountSkipReasons: ReadonlyMap<number, string>,
	context?: PinnedUnavailableContext,
): PinnedUnavailableErrorBody {
	const normalizedPinnedIndex =
		typeof pinnedIndex === "number" ? pinnedIndex : null;
	const skipReason =
		normalizedPinnedIndex !== null
			? accountSkipReasons.get(normalizedPinnedIndex) ?? null
			: null;
	// On the desync path the pin index is unknown (null); claiming "account 1"
	// there would contradict the machine-readable pinnedAccountIndex: null.
	const accountPhrase =
		normalizedPinnedIndex === null
			? "The pinned account"
			: `Pinned account ${normalizedPinnedIndex + 1}`;
	const pinSource = context?.pinSource ?? null;
	// Upper bound as well as lower: resetAtMs comes from persisted account state
	// (rateLimitResetTimes, coolingDownUntil), and markAccountCoolingDown clamps
	// only the low side while nothing re-validates either on load. A finite but
	// absurd deadline past the ECMAScript time limit would make toISOString below
	// throw a RangeError inside handleRequestInner, collapsing this diagnostic 503
	// into a generic 500 that carries no pinnedAccountIndex, reason, or skip map —
	// the exact payload this branch exists to deliver. Such a value bounds nothing
	// usable anyway, so treat it as "no known recovery" instead.
	const resetAtMs =
		typeof context?.resetAtMs === "number" &&
		Number.isFinite(context.resetAtMs) &&
		context.resetAtMs > 0 &&
		context.resetAtMs <= MAX_ECMASCRIPT_TIME_VALUE
			? context.resetAtMs
			: null;
	const now = context?.now ?? Date.now();
	const retryAfterMs = resetAtMs !== null ? Math.max(0, resetAtMs - now) : null;
	const resetAt = resetAtMs !== null ? new Date(resetAtMs).toISOString() : null;
	// "unknown" (the default) means the caller did not measure which record
	// bounds the deadline — older callers and unit seams — so trust the skip
	// reason. Only a measured "other" demotes to the neutral phrasing, which
	// stays true for a live rate limit either way.
	const rateLimitBoundsRecovery = (context?.recoveryBound ?? "unknown") !== "other";
	// The machine-readable `reason` below stays the recorded SELECTION verdict;
	// only the human sentence follows the blocker actually gating the pin. A
	// recorded verdict that names a real blocker class wins, because the
	// selection-only classes ("missing", "policy-blocked") have no
	// runtime-state equivalent and would be lost. Otherwise the re-read runtime
	// state is the truth and the recorded token is only the earlier attempt
	// verdict. This also preserves compatibility with legacy callers that may
	// still supply an internal bookkeeping token.
	const describedSkipReason =
		skipReason !== null && isDescribedBlocker(skipReason)
			? skipReason
			: context?.currentSkipReason ?? skipReason;
	const blocker = describePinnedBlocker(
		describedSkipReason,
		rateLimitBoundsRecovery,
	);
	const reasonSuffix = blocker.parenthetical
		? ` (${blocker.parenthetical})`
		: "";
	const waitSuffix = resetAt !== null ? `; ${blocker.deadline(resetAt)}` : "";
	// A forced pin belongs to the launching process, not to the persisted pin
	// state, so `unpin` would clear nothing — say what actually helps.
	const remedy =
		pinSource === "forced"
			? "the pin was set by this session's launcher, so relaunch to select a different account"
			: "run `codex-multi-auth status` for details, or `codex-multi-auth unpin` to allow rotation";
	return {
		message: `${accountPhrase} is currently unavailable${reasonSuffix}${waitSuffix}; ${remedy}.`,
		code: "codex_pinned_account_unavailable",
		pinnedAccountIndex: normalizedPinnedIndex,
		reason: skipReason,
		pin_source: pinSource,
		reset_at: resetAt,
		retry_after_ms: retryAfterMs,
		account_skip_reasons: Object.fromEntries(
			[...accountSkipReasons.entries()].map(([index, reason]) => [
				String(index),
				reason,
			]),
		),
	};
}
