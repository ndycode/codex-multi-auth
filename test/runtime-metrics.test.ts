import { describe, expect, it } from "vitest";
import {
	MAX_RETRY_HINT_MS,
	clampRetryHintMs,
	createRuntimeMetrics,
	parseEnvInt,
	parseFailoverMode,
	parseRetryAfterHintMs,
	sanitizeResponseHeadersForLog,
} from "../lib/runtime/metrics.js";

describe("runtime metrics helpers", () => {
	it("creates zeroed runtime metrics from an injected timestamp", () => {
		expect(createRuntimeMetrics(1234)).toEqual({
			startedAt: 1234,
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			rateLimitedResponses: 0,
			serverErrors: 0,
			networkErrors: 0,
			userAborts: 0,
			authRefreshFailures: 0,
			emptyResponseRetries: 0,
			accountRotations: 0,
			sameAccountRetries: 0,
			streamFailoverAttempts: 0,
			streamFailoverRecoveries: 0,
			streamFailoverCrossAccountRecoveries: 0,
			cumulativeLatencyMs: 0,
			lastRequestAt: null,
			lastError: null,
		});
	});

	it("parses failover modes and integer env overrides conservatively", () => {
		expect(parseFailoverMode("aggressive")).toBe("aggressive");
		expect(parseFailoverMode(" conservative ")).toBe("conservative");
		expect(parseFailoverMode("other")).toBe("balanced");
		expect(parseEnvInt("42")).toBe(42);
		expect(parseEnvInt("abc")).toBeUndefined();
		expect(parseEnvInt(undefined)).toBeUndefined();
	});

	it("clamps retry hints and drops invalid values", () => {
		expect(clampRetryHintMs(-1)).toBeNull();
		expect(clampRetryHintMs(Number.NaN)).toBeNull();
		expect(clampRetryHintMs(MAX_RETRY_HINT_MS + 1000)).toBe(MAX_RETRY_HINT_MS);
		expect(clampRetryHintMs(2500.9)).toBe(2500);
	});

	it("parses retry-after headers across ms, seconds, date, and reset formats", () => {
		const now = Date.parse("2026-03-22T00:00:00.000Z");

		const retryAfterMsHeaders = new Headers({ "retry-after-ms": "1500" });
		expect(parseRetryAfterHintMs(retryAfterMsHeaders, now)).toBe(1500);

		const retryAfterSecondsHeaders = new Headers({ "retry-after": "3" });
		expect(parseRetryAfterHintMs(retryAfterSecondsHeaders, now)).toBe(3000);

		const retryAfterDateHeaders = new Headers({
			"retry-after": "Sun, 22 Mar 2026 00:00:04 GMT",
		});
		expect(parseRetryAfterHintMs(retryAfterDateHeaders, now)).toBe(4000);

		const resetSecondsHeaders = new Headers({ "x-ratelimit-reset": "1774137605" });
		expect(parseRetryAfterHintMs(resetSecondsHeaders, now)).toBe(5000);

		const resetMillisecondsHeaders = new Headers({
			"x-ratelimit-reset": String(now + 6000),
		});
		expect(parseRetryAfterHintMs(resetMillisecondsHeaders, now)).toBe(6000);
	});

	it("keeps only allowlisted response headers for logging", () => {
		const headers = new Headers({
			"content-type": "text/event-stream",
			"x-request-id": "req_123",
			authorization: "secret",
			cookie: "sensitive",
		});

		expect(sanitizeResponseHeadersForLog(headers)).toEqual({
			"content-type": "text/event-stream",
			"x-request-id": "req_123",
		});
	});
});
