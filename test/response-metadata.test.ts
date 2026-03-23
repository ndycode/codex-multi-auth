import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseRetryAfterHintMs,
	sanitizeResponseHeadersForLog,
} from "../lib/request/response-metadata.js";

describe("response metadata helpers", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-22T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("parses retry-after-ms before other retry headers", () => {
		const headers = new Headers({
			"retry-after-ms": "1200",
			"retry-after": "30",
		});

		expect(parseRetryAfterHintMs(headers)).toBe(1200);
	});

	it("parses retry-after seconds and caps large values", () => {
		const headers = new Headers({ "retry-after": "999999" });

		expect(parseRetryAfterHintMs(headers)).toBe(300000);
	});

	it("parses retry-after dates and x-ratelimit-reset timestamps", () => {
		const dateHeaders = new Headers({
			"retry-after": "Sun, 22 Mar 2026 00:02:00 GMT",
		});
		expect(parseRetryAfterHintMs(dateHeaders)).toBe(120000);

		const resetHeaders = new Headers({
			"x-ratelimit-reset": `${Math.floor(Date.now() / 1000) + 45}`,
		});
		expect(parseRetryAfterHintMs(resetHeaders)).toBe(45000);
	});

	it("returns null for invalid or non-positive retry hints", () => {
		expect(
			parseRetryAfterHintMs(new Headers({ "retry-after-ms": "abc" })),
		).toBe(null);
		expect(
			parseRetryAfterHintMs(
				new Headers({
					"x-ratelimit-reset": `${Math.floor(Date.now() / 1000) - 5}`,
				}),
			),
		).toBe(null);
	});

	it("sanitizes response headers down to the allowed logging set", () => {
		const headers = new Headers({
			"Content-Type": "application/json",
			"X-Request-Id": "req_123",
			Authorization: "Bearer secret",
			Cookie: "session=secret",
			"X-RateLimit-Reset": "12345",
		});

		expect(sanitizeResponseHeadersForLog(headers)).toEqual({
			"content-type": "application/json",
			"x-request-id": "req_123",
			"x-ratelimit-reset": "12345",
		});
	});
});
