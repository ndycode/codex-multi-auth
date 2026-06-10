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

	it("omits the parenthetical and reason on the null-index desync path", () => {
		const body = buildPinnedUnavailableErrorBody(null, new Map());
		expect(body.pinnedAccountIndex).toBeNull();
		expect(body.reason).toBeNull();
		expect(body.message).toContain("Pinned account 1 is currently unavailable;");
		expect(body.message).not.toContain("(");
		expect(body.account_skip_reasons).toEqual({});
	});
});
