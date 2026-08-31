import { describe, expect, it } from "vitest";
import {
	buildPinnedUnavailableErrorBody,
	buildTokenInvalidationBody,
	extractErrorCodeFromBody,
	getQuotaNearExhaustionWaitMs,
	isTokenInvalidationError,
	isTokenRefreshRetryable,
	normalizeExhaustionStatus,
	parseRetryAfterBodyMs,
	parseRetryAfterHeaderMs,
} from "../lib/request/rate-limit-decision.js";

describe("isTokenInvalidationError", () => {
	it("matches known invalidation phrases case-insensitively", () => {
		expect(
			isTokenInvalidationError('{"message":"Invalidated OAuth Token"}'),
		).toBe(true);
		expect(
			isTokenInvalidationError("the authentication TOKEN has been INVALIDATED"),
		).toBe(true);
	});

	it("does not match generic 401 bodies", () => {
		expect(isTokenInvalidationError('{"message":"token expired"}')).toBe(false);
		expect(isTokenInvalidationError("")).toBe(false);
	});
});

describe("isTokenRefreshRetryable", () => {
	it("treats transient reasons as retryable", () => {
		expect(isTokenRefreshRetryable({ type: "failed", reason: "network_error" })).toBe(true);
		expect(isTokenRefreshRetryable({ type: "failed", reason: "unknown" })).toBe(true);
		expect(isTokenRefreshRetryable({ type: "failed", reason: "invalid_response" })).toBe(true);
	});

	it("treats credential-level http errors as terminal and server errors as retryable", () => {
		for (const statusCode of [400, 401, 403]) {
			expect(
				isTokenRefreshRetryable({ type: "failed", reason: "http_error", statusCode }),
			).toBe(false);
		}
		expect(
			isTokenRefreshRetryable({ type: "failed", reason: "http_error", statusCode: 500 }),
		).toBe(true);
		expect(
			isTokenRefreshRetryable({ type: "failed", reason: "http_error", statusCode: 429 }),
		).toBe(true);
	});

	it("treats missing_refresh, timeout, and absent reasons as non-retryable", () => {
		expect(isTokenRefreshRetryable({ type: "failed", reason: "missing_refresh" })).toBe(false);
		expect(isTokenRefreshRetryable({ type: "failed", reason: "timeout" })).toBe(false);
		expect(isTokenRefreshRetryable({ type: "failed" })).toBe(false);
	});
});

describe("parseRetryAfterHeaderMs", () => {
	// Realistic epoch: Date.parse falls back on bare digit strings (e.g. "0"
	// parses as the year 2000), which must land in the past to read as invalid.
	const now = 1_700_000_000_000;

	it("prefers retry-after-ms over retry-after", () => {
		const headers = new Headers({ "retry-after-ms": "1500", "retry-after": "60" });
		expect(parseRetryAfterHeaderMs(headers, now)).toBe(1500);
	});

	it("converts retry-after seconds to milliseconds", () => {
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": "30" }), now)).toBe(30_000);
	});

	it("supports HTTP-date retry-after values in the future", () => {
		const future = new Date(now + 90_000).toUTCString();
		const waitMs = parseRetryAfterHeaderMs(new Headers({ "retry-after": future }), now);
		// toUTCString drops sub-second precision, so allow up to 1s of rounding.
		expect(waitMs).toBeGreaterThan(88_000);
		expect(waitMs).toBeLessThanOrEqual(90_000);
	});

	it("returns null for absent, non-positive, or unparseable values", () => {
		expect(parseRetryAfterHeaderMs(new Headers(), now)).toBeNull();
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": "0" }), now)).toBeNull();
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": "-5" }), now)).toBeNull();
		expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": "soon" }), now)).toBeNull();
		expect(
			parseRetryAfterHeaderMs(
				new Headers({ "retry-after": new Date(now - 1_000).toUTCString() }),
				now,
			),
		).toBeNull();
	});
});

describe("parseRetryAfterBodyMs", () => {
	const now = 5_000_000_000_000; // epoch ms scale so resets_at heuristics are exercised

	it("reads error.retry_after_ms first, then error.retry_after seconds", () => {
		expect(
			parseRetryAfterBodyMs(JSON.stringify({ error: { retry_after_ms: 2500 } }), now),
		).toBe(2500);
		expect(
			parseRetryAfterBodyMs(JSON.stringify({ error: { retry_after: 12 } }), now),
		).toBe(12_000);
	});

	it("derives waits from resets_at in epoch seconds or milliseconds", () => {
		const resetsAtSeconds = Math.floor(now / 1000) + 60;
		expect(
			parseRetryAfterBodyMs(JSON.stringify({ error: { resets_at: resetsAtSeconds } }), now),
		).toBe(resetsAtSeconds * 1000 - now);
		expect(
			parseRetryAfterBodyMs(JSON.stringify({ error: { reset_at: now + 45_000 } }), now),
		).toBe(45_000);
	});

	it("returns null for empty, non-JSON, non-record, and array payloads", () => {
		expect(parseRetryAfterBodyMs("", now)).toBeNull();
		expect(parseRetryAfterBodyMs("   ", now)).toBeNull();
		expect(parseRetryAfterBodyMs("{not json", now)).toBeNull();
		expect(parseRetryAfterBodyMs("[1,2]", now)).toBeNull();
		expect(parseRetryAfterBodyMs(JSON.stringify({ error: [] }), now)).toBeNull();
		expect(parseRetryAfterBodyMs(JSON.stringify({ error: { resets_at: now - 1 } }), now)).toBeNull();
	});
});

describe("buildTokenInvalidationBody", () => {
	const parse = (body: string) =>
		JSON.parse(body) as { error: { message: string; code: string } };

	it("preserves a top-level upstream message inside the stable envelope", () => {
		const body = parse(
			buildTokenInvalidationBody(JSON.stringify({ message: " token revoked " })),
		);
		expect(body.error).toEqual({ message: "token revoked", code: "token_invalidated" });
	});

	it("falls back to the nested error.message", () => {
		const body = parse(
			buildTokenInvalidationBody(
				JSON.stringify({ error: { message: "oauth token has been invalidated" } }),
			),
		);
		expect(body.error.message).toBe("oauth token has been invalidated");
	});

	it("uses the stable fallback for non-JSON, empty, and message-less bodies", () => {
		for (const upstream of ["", "<html>nope</html>", JSON.stringify({ message: "  " })]) {
			const body = parse(buildTokenInvalidationBody(upstream));
			expect(body.error).toEqual({
				message: "OAuth token has been invalidated. Please re-login.",
				code: "token_invalidated",
			});
		}
	});
});

describe("extractErrorCodeFromBody", () => {
	it("reads a top-level code before the nested error.code", () => {
		expect(
			extractErrorCodeFromBody(
				JSON.stringify({ code: " direct ", error: { code: "nested" } }),
			),
		).toBe("direct");
		expect(
			extractErrorCodeFromBody(JSON.stringify({ error: { code: "nested" } })),
		).toBe("nested");
	});

	it("returns null for empty, malformed, non-record, and whitespace codes", () => {
		expect(extractErrorCodeFromBody("")).toBeNull();
		expect(extractErrorCodeFromBody("{oops")).toBeNull();
		expect(extractErrorCodeFromBody("[]")).toBeNull();
		expect(extractErrorCodeFromBody(JSON.stringify({ code: "  " }))).toBeNull();
		expect(extractErrorCodeFromBody(JSON.stringify({ error: { code: 42 } }))).toBeNull();
	});
});

describe("getQuotaNearExhaustionWaitMs", () => {
	const now = 1_700_000_000_000;

	it("waits on a window at or above the used threshold via reset-after-seconds", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "97",
			"x-codex-primary-reset-after-seconds": "120",
		});
		expect(getQuotaNearExhaustionWaitMs(headers, 5, now)).toBe(120_000);
	});

	it("ignores windows below the threshold", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "80",
			"x-codex-primary-reset-after-seconds": "120",
		});
		expect(getQuotaNearExhaustionWaitMs(headers, 5, now)).toBe(0);
	});

	it("takes the max wait across primary and secondary windows", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-reset-after-seconds": "60",
			"x-codex-secondary-used-percent": "100",
			"x-codex-secondary-reset-after-seconds": "300",
		});
		expect(getQuotaNearExhaustionWaitMs(headers, 5, now)).toBe(300_000);
	});

	it("H1: clamps an absurd reset-after to MAX_RATE_LIMIT_DELAY_MS (7d)", () => {
		const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
		const headers = new Headers({
			"x-codex-primary-used-percent": "100",
			// ~31 years in seconds — a bogus/buggy upstream value.
			"x-codex-primary-reset-after-seconds": "999999999",
		});
		expect(getQuotaNearExhaustionWaitMs(headers, 5, now)).toBe(sevenDaysMs);
	});

	it("supports reset-at in epoch seconds, epoch milliseconds, and date strings", () => {
		const epochSeconds = Math.floor(now / 1000) + 60;
		expect(
			getQuotaNearExhaustionWaitMs(
				new Headers({
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-reset-at": String(epochSeconds),
				}),
				5,
				now,
			),
		).toBe(epochSeconds * 1000 - now);
		expect(
			getQuotaNearExhaustionWaitMs(
				new Headers({
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-reset-at": String(now + 30_000),
				}),
				5,
				now,
			),
		).toBe(30_000);
		const dateWait = getQuotaNearExhaustionWaitMs(
			new Headers({
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-reset-at": new Date(now + 90_000).toUTCString(),
			}),
			5,
			now,
		);
		expect(dateWait).toBeGreaterThan(88_000);
		expect(dateWait).toBeLessThanOrEqual(90_000);
	});

	it("returns 0 when no usable reset signal exists", () => {
		expect(getQuotaNearExhaustionWaitMs(new Headers(), 5, now)).toBe(0);
		expect(
			getQuotaNearExhaustionWaitMs(
				new Headers({ "x-codex-primary-used-percent": "100" }),
				5,
				now,
			),
		).toBe(0);
	});
});

describe("normalizeExhaustionStatus", () => {
	it("maps rate-limit to 429 and everything else to 503", () => {
		expect(normalizeExhaustionStatus("rate-limit")).toBe(429);
		expect(normalizeExhaustionStatus("server-error")).toBe(503);
		expect(normalizeExhaustionStatus("auth-failure")).toBe(503);
	});
});

describe("buildPinnedUnavailableErrorBody", () => {
	it("includes the 1-based pinned index and its skip reason", () => {
		const body = buildPinnedUnavailableErrorBody(
			1,
			new Map([
				[0, "rate-limited"],
				[1, "disabled"],
			]),
		);
		expect(body.code).toBe("codex_pinned_account_unavailable");
		expect(body.pinnedAccountIndex).toBe(1);
		expect(body.reason).toBe("disabled");
		expect(body.message).toContain("Pinned account 2");
		expect(body.message).toContain("(disabled)");
		expect(body.account_skip_reasons).toEqual({ "0": "rate-limited", "1": "disabled" });
	});

	it("omits the index, parenthetical, and reason on the null-index desync path", () => {
		// Regression: the message used to render the null index as "Pinned
		// account 1", contradicting the machine-readable pinnedAccountIndex.
		const body = buildPinnedUnavailableErrorBody(null, new Map());
		expect(body.pinnedAccountIndex).toBeNull();
		expect(body.reason).toBeNull();
		expect(body.message).toContain("The pinned account is currently unavailable;");
		expect(body.message).not.toContain("Pinned account 1");
		expect(body.message).not.toContain("(");
		expect(body.account_skip_reasons).toEqual({});
		expect(body.pin_source).toBeNull();
		expect(body.reset_at).toBeNull();
		expect(body.retry_after_ms).toBeNull();
	});

	it("tailors the remedy to a forced pin and threads the recorded reset", () => {
		const resetAtMs = 1_700_000_030_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{ pinSource: "forced", resetAtMs, now: 1_700_000_000_000 },
		);
		expect(body.pin_source).toBe("forced");
		expect(body.reset_at).toBe(new Date(resetAtMs).toISOString());
		expect(body.retry_after_ms).toBe(30_000);
		expect(body.message).toContain(
			`the rate limit resets at ${new Date(resetAtMs).toISOString()}`,
		);
		// A forced pin is not cleared by `unpin`; the remedy must not suggest it.
		expect(body.message).toContain("set by this session's launcher");
		expect(body.message).not.toContain("unpin");
	});

	// The deadline is max(rate-limit reset, cooldown end, breaker next-attempt),
	// so "limit" is only true for the rate-limit class. During the 2026-08-20
	// provider outage, a breaker deadline printed as "the recorded limit resets
	// at …" read as a blown subscription quota; the noun now follows the
	// blocker, while the machine-readable `reason` keeps the raw token.
	for (const { reason, parenthetical, deadlineNoun } of [
		{
			reason: "circuit-open",
			parenthetical: "(paused after repeated upstream errors)",
			deadlineNoun: "the next attempt is allowed at",
		},
		// Every `cooling-down:*` variant is bounded by the same
		// `coolingDownUntil` field, so they share one deadline noun: two of
		// them used to say "the next attempt is allowed at" while the rest
		// said "the cooldown ends at", which reads as two different mechanisms
		// to an operator comparing two 503s from the same cause.
		{
			reason: "cooling-down:server-error",
			parenthetical: "(cooling down after upstream server errors)",
			deadlineNoun: "the cooldown ends at",
		},
		{
			reason: "cooling-down:network-error",
			parenthetical: "(cooling down after network errors)",
			deadlineNoun: "the cooldown ends at",
		},
		{
			reason: "cooling-down:auth-failure",
			parenthetical: "(cooling down after authentication failures)",
			deadlineNoun: "the cooldown ends at",
		},
		{
			reason: "cooling-down:rate-limit",
			parenthetical: "(cooling down after a rate limit)",
			deadlineNoun: "the cooldown ends at",
		},
		{
			reason: "cooling-down",
			parenthetical: "(cooling down)",
			deadlineNoun: "the cooldown ends at",
		},
	] as const) {
		it(`words a \`${reason}\` deadline as transient recovery, not a limit`, () => {
			const resetAtMs = 1_700_000_030_000;
			const body = buildPinnedUnavailableErrorBody(
				1,
				new Map([[1, reason]]),
				{ pinSource: "forced", resetAtMs, now: 1_700_000_000_000 },
			);
			// The JSON contract is untouched: raw token, same deadline fields.
			expect(body.reason).toBe(reason);
			expect(body.reset_at).toBe(new Date(resetAtMs).toISOString());
			expect(body.retry_after_ms).toBe(30_000);
			expect(body.message).toContain(parenthetical);
			expect(body.message).toContain(
				`${deadlineNoun} ${new Date(resetAtMs).toISOString()}`,
			);
			expect(body.message).not.toContain("limit resets");
			expect(body.message).not.toContain("circuit-open");
		});
	}

	it("keeps quota phrasing for a genuine rate limit", () => {
		const resetAtMs = 1_700_000_030_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{ pinSource: "manual", resetAtMs, now: 1_700_000_000_000 },
		);
		expect(body.reason).toBe("rate-limited");
		expect(body.message).toContain("(rate-limited)");
		expect(body.message).toContain(
			`the rate limit resets at ${new Date(resetAtMs).toISOString()}`,
		);
	});

	it("keeps quota phrasing when the rate limit supplies the recovery bound", () => {
		const resetAtMs = 1_700_000_030_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{
				pinSource: "manual",
				resetAtMs,
				recoveryBound: "rate-limit",
				now: 1_700_000_000_000,
			},
		);
		expect(body.message).toContain(
			`the rate limit resets at ${new Date(resetAtMs).toISOString()}`,
		);
	});

	it("does not call a later breaker or cooldown deadline a rate-limit reset", () => {
		// Skip-reason precedence reports "rate-limited" whenever a live limit
		// exists, but the recovery bound is the max of every gating record — a
		// breaker tripped seconds ago can end after a limit about to expire.
		// Wording that later timestamp as the limit's reset would be the same
		// misattribution this change removes from the transient classes.
		const resetAtMs = 1_700_000_030_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{
				pinSource: "forced",
				resetAtMs,
				recoveryBound: "other",
				now: 1_700_000_000_000,
			},
		);
		// Contract untouched: reset_at still advertises the full recovery bound.
		expect(body.reason).toBe("rate-limited");
		expect(body.reset_at).toBe(new Date(resetAtMs).toISOString());
		expect(body.message).toContain("(rate-limited)");
		expect(body.message).toContain(
			`the account is expected to be available again at ${new Date(resetAtMs).toISOString()}`,
		);
		expect(body.message).not.toContain("limit resets");
	});

	it("passes an unknown skip token through verbatim with neutral recovery wording", () => {
		// Unknown or legacy selection tokens pass through the same seam; those
		// must stay legible without claiming a limit or inventing a translation.
		const resetAtMs = 1_700_000_030_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "already-attempted"]]),
			{ pinSource: "forced", resetAtMs, now: 1_700_000_000_000 },
		);
		expect(body.reason).toBe("already-attempted");
		expect(body.message).toContain("(already-attempted)");
		expect(body.message).toContain(
			`the account is expected to be available again at ${new Date(resetAtMs).toISOString()}`,
		);
		expect(body.message).not.toContain("limit resets");
	});

	it.each([
		["auth-failure", "authentication failure"],
		["network-error", "upstream network error"],
		["server-error", "upstream server error"],
	])("words the direct %s attempt verdict for operators", (reason, wording) => {
		const body = buildPinnedUnavailableErrorBody(0, new Map([[0, reason]]), {
			pinSource: "forced",
		});

		expect(body.reason).toBe(reason);
		expect(body.message).toContain(`(${wording})`);
		expect(body.message).not.toContain(`(${reason})`);
	});

	// A loop can stop with an attempt verdict while the failure it just handled
	// created a more specific live cooldown or breaker. The sentence follows
	// that re-read blocker rather than shipping a class-less deadline.
	it("words the sentence from the re-read runtime blocker, not the loop's verdict", () => {
		const resetAtMs = 1_700_000_030_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "network-error"]]),
			{
				pinSource: "forced",
				resetAtMs,
				recoveryBound: "other",
				currentSkipReason: "circuit-open",
				now: 1_700_000_000_000,
			},
		);
		// The machine-readable contract still reports the recorded attempt verdict.
		expect(body.reason).toBe("network-error");
		// The human sentence describes what is actually gating the pin.
		expect(body.message).toContain("(paused after repeated upstream errors)");
		expect(body.message).toContain(
			`the next attempt is allowed at ${new Date(resetAtMs).toISOString()}`,
		);
		expect(body.message).not.toContain("network-error");
		expect(body.message).not.toContain("circuit-open");
	});

	it("keeps a recorded selection-only verdict that runtime state cannot express", () => {
		// "policy-blocked" has no runtime-state equivalent, so a null re-read
		// must not erase it from the sentence.
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "policy-blocked"]]),
			{ pinSource: "manual", currentSkipReason: null },
		);
		expect(body.reason).toBe("policy-blocked");
		expect(body.message).toContain("(policy-blocked)");
	});

	it("prefers the recorded verdict when it already names a blocker class", () => {
		// A recorded "rate-limited" is a real class; a later re-read that has
		// moved on to the cooldown it caused must not relabel the 503.
		const resetAtMs = 1_700_000_030_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{
				resetAtMs,
				recoveryBound: "rate-limit",
				currentSkipReason: "cooling-down:rate-limit",
				now: 1_700_000_000_000,
			},
		);
		expect(body.message).toContain("(rate-limited)");
		expect(body.message).toContain(
			`the rate limit resets at ${new Date(resetAtMs).toISOString()}`,
		);
	});

	// The bound used to be inferred from whether a second deadline key was
	// present on the context object, so a caller that spread the key with an
	// `undefined` value got the opposite wording from one that omitted it —
	// with nothing in the type to say so. Both shapes must now agree.
	it("treats an explicit undefined recovery bound as unmeasured, not as `other`", () => {
		const resetAtMs = 1_700_000_030_000;
		const omitted = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{ resetAtMs, now: 1_700_000_000_000 },
		);
		const explicitUndefined = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{ resetAtMs, recoveryBound: undefined, now: 1_700_000_000_000 },
		);
		expect(explicitUndefined.message).toBe(omitted.message);
		expect(explicitUndefined.message).toContain(
			`the rate limit resets at ${new Date(resetAtMs).toISOString()}`,
		);
	});

	it("keeps the unpin advice for manual pins and nulls an unknown reset", () => {
		const body = buildPinnedUnavailableErrorBody(
			1,
			new Map([[1, "disabled"]]),
			{ pinSource: "manual" },
		);
		expect(body.pin_source).toBe("manual");
		expect(body.reset_at).toBeNull();
		expect(body.retry_after_ms).toBeNull();
		expect(body.message).toContain("codex-multi-auth unpin");
		expect(body.message).not.toContain("resets at");
	});
});

describe("buildPinnedUnavailableErrorBody recovery bounds", () => {
	it("drops an out-of-range deadline instead of throwing RangeError", () => {
		// resetAtMs comes from persisted account state and nothing re-validates
		// it on load, so a corrupted coolingDownUntil can be finite, positive,
		// and still past the ECMAScript time limit. toISOString would throw and
		// collapse this 503 into a generic 500 that carries none of the
		// diagnostics below.
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{ pinSource: "forced", resetAtMs: 1e18, now: 1_700_000_000_000 },
		);

		expect(body.reset_at).toBeNull();
		expect(body.retry_after_ms).toBeNull();
		expect(body.code).toBe("codex_pinned_account_unavailable");
		expect(body.pinnedAccountIndex).toBe(0);
		expect(body.reason).toBe("rate-limited");
		expect(body.pin_source).toBe("forced");
		expect(body.message).not.toContain("resets at");
	});

	it("still reports a deadline at the edge of the valid range", () => {
		const maxTimeValue = 8_640_000_000_000_000;
		const body = buildPinnedUnavailableErrorBody(
			0,
			new Map([[0, "rate-limited"]]),
			{ resetAtMs: maxTimeValue, now: 1_700_000_000_000 },
		);

		expect(body.reset_at).toBe(new Date(maxTimeValue).toISOString());
		expect(body.retry_after_ms).toBe(maxTimeValue - 1_700_000_000_000);
	});
});
