import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fc from "fast-check";
import {
	CircuitBreaker,
	CircuitOpenError,
} from "../../lib/circuit-breaker.js";
import { convertSseToJson, ensureContentType } from "../../lib/request/response-handler.js";
import {
	isEntitlementError,
	shouldRefreshToken,
	extractRequestUrl,
	rewriteUrlForCodex,
} from "../../lib/request/fetch-helpers.js";
import type { Auth } from "@opencode-ai/sdk";

describe("CircuitBreaker - State Machine Properties", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("state transitions", () => {
		it("closed -> open requires exactly threshold failures", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1, max: 10 }),
					(threshold) => {
						const breaker = new CircuitBreaker({ failureThreshold: threshold });
						
						for (let i = 0; i < threshold - 1; i++) {
							breaker.recordFailure();
						}
						expect(breaker.getState()).toBe("closed");
						
						breaker.recordFailure();
						expect(breaker.getState()).toBe("open");
					},
				),
			);
		});

		it("open -> half-open requires waiting resetTimeoutMs", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1000, max: 60000 }),
					(resetTimeoutMs) => {
						vi.setSystemTime(new Date(0)); // Reset timer for each iteration
						const breaker = new CircuitBreaker({
							failureThreshold: 1,
							resetTimeoutMs,
						});
						
						breaker.recordFailure();
						expect(breaker.getState()).toBe("open");
						
						vi.setSystemTime(new Date(resetTimeoutMs - 1));
						expect(() => breaker.canExecute()).toThrow(CircuitOpenError);
						
						vi.setSystemTime(new Date(resetTimeoutMs));
						expect(breaker.canExecute()).toBe(true);
						expect(breaker.getState()).toBe("half-open");
					},
				),
			);
		});

		it("half-open -> closed on success", () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
			});
			
			breaker.recordFailure();
			vi.setSystemTime(new Date(1001));
			breaker.canExecute();
			
			breaker.recordSuccess();
			expect(breaker.getState()).toBe("closed");
		});

		it("half-open -> open on failure", () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
			});
			
			breaker.recordFailure();
			vi.setSystemTime(new Date(1001));
			breaker.canExecute();
			
			breaker.recordFailure();
			expect(breaker.getState()).toBe("open");
		});

		it("state machine is deterministic", () => {
			fc.assert(
				fc.property(
					fc.array(fc.oneof(fc.constant("success"), fc.constant("failure")), {
						minLength: 1,
						maxLength: 20,
					}),
					fc.integer({ min: 1, max: 5 }),
					(events, threshold) => {
						const breaker1 = new CircuitBreaker({ failureThreshold: threshold });
						const breaker2 = new CircuitBreaker({ failureThreshold: threshold });
						
						for (const event of events) {
							if (event === "success") {
								breaker1.recordSuccess();
								breaker2.recordSuccess();
							} else {
								breaker1.recordFailure();
								breaker2.recordFailure();
							}
						}
						
						expect(breaker1.getState()).toBe(breaker2.getState());
						expect(breaker1.getFailureCount()).toBe(breaker2.getFailureCount());
					},
				),
			);
		});
	});

	describe("failure window pruning", () => {
		it("failures outside window are not counted", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 10000, max: 120000 }),
					(failureWindowMs) => {
						vi.setSystemTime(new Date(0)); // Reset timer for each iteration
						const breaker = new CircuitBreaker({
							failureThreshold: 3,
							failureWindowMs,
						});
						
						breaker.recordFailure();
						vi.setSystemTime(new Date(failureWindowMs + 1));
						breaker.recordFailure();
						breaker.recordFailure();
						
						expect(breaker.getState()).toBe("closed");
						expect(breaker.getFailureCount()).toBe(2);
					},
				),
			);
		});

		it("failures at window boundary are counted", () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 3,
				failureWindowMs: 60000,
			});
			
			breaker.recordFailure();
			vi.setSystemTime(new Date(59999));
			breaker.recordFailure();
			breaker.recordFailure();
			
			expect(breaker.getState()).toBe("open");
		});
	});

	describe("getTimeUntilReset", () => {
		it("returns 0 when not open", () => {
			fc.assert(
				fc.property(
					fc.oneof(fc.constant("closed" as const), fc.constant("half-open" as const)),
					(state) => {
						vi.setSystemTime(new Date(0)); // Reset timer for each iteration
						const breaker = new CircuitBreaker();
						
						if (state === "half-open") {
							breaker.recordFailure();
							breaker.recordFailure();
							breaker.recordFailure();
							vi.setSystemTime(new Date(30001));
							breaker.canExecute();
						}
						
						if (breaker.getState() === state) {
							expect(breaker.getTimeUntilReset()).toBe(0);
						}
					},
				),
			);
		});

		it("decreases monotonically while open", () => {
			const breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10000,
			});
			
			breaker.recordFailure();
			
			let lastTime = breaker.getTimeUntilReset();
			for (let t = 1000; t < 10000; t += 1000) {
				vi.setSystemTime(new Date(t));
				const currentTime = breaker.getTimeUntilReset();
				expect(currentTime).toBeLessThanOrEqual(lastTime);
				lastTime = currentTime;
			}
		});
	});
});

describe("Malformed Rate Limit Headers", () => {
	describe("isEntitlementError", () => {
		it("detects usage_not_included pattern", () => {
			expect(isEntitlementError("usage_not_included", "")).toBe(true);
			expect(isEntitlementError("USAGE_NOT_INCLUDED", "")).toBe(true);
			expect(isEntitlementError("", "usage_not_included in response")).toBe(true);
		});

		it("detects subscription plan patterns", () => {
			expect(isEntitlementError("", "not included in your plan")).toBe(true);
			expect(isEntitlementError("", "subscription does not include")).toBe(true);
		});

		it("does not match rate limit errors", () => {
			expect(isEntitlementError("usage_limit_reached", "")).toBe(false);
			expect(isEntitlementError("rate_limit_exceeded", "")).toBe(false);
			expect(isEntitlementError("", "rate limit exceeded")).toBe(false);
		});

		it("handles empty inputs gracefully", () => {
			expect(isEntitlementError("", "")).toBe(false);
		});
	});

	describe("shouldRefreshToken", () => {
		it("returns true for non-oauth auth", () => {
			const auth = { type: "api-key", key: "sk-test" } as unknown as Auth;
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("returns true for oauth without access token", () => {
			const auth = { type: "oauth", access: "", expires: Date.now() + 10000 } as Auth;
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("returns true for expired token", () => {
			const auth = { type: "oauth", access: "token", expires: Date.now() - 1 } as Auth;
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("returns false for valid token", () => {
			const auth = { type: "oauth", access: "token", expires: Date.now() + 60000 } as Auth;
			expect(shouldRefreshToken(auth)).toBe(false);
		});

		it("respects skew parameter", () => {
			const auth = { type: "oauth", access: "token", expires: Date.now() + 5000 } as Auth;
			expect(shouldRefreshToken(auth, 0)).toBe(false);
			expect(shouldRefreshToken(auth, 10000)).toBe(true);
		});

		it("handles negative skew by clamping to 0", () => {
			const auth = { type: "oauth", access: "token", expires: Date.now() + 5000 } as Auth;
			expect(shouldRefreshToken(auth, -1000)).toBe(false);
		});
	});
});

describe("URL Handling Edge Cases", () => {
	describe("extractRequestUrl", () => {
		it("handles string URLs", () => {
			expect(extractRequestUrl("https://api.openai.com/v1/responses")).toBe(
				"https://api.openai.com/v1/responses",
			);
		});

		it("handles URL objects", () => {
			const url = new URL("https://api.openai.com/v1/responses");
			expect(extractRequestUrl(url)).toBe("https://api.openai.com/v1/responses");
		});

		it("handles Request objects", () => {
			const request = new Request("https://api.openai.com/v1/responses");
			expect(extractRequestUrl(request)).toBe("https://api.openai.com/v1/responses");
		});
	});

	describe("rewriteUrlForCodex", () => {
		it("rewrites /responses to /codex/responses", () => {
			expect(rewriteUrlForCodex("https://api.openai.com/v1/responses")).toBe(
				"https://chatgpt.com/backend-api/v1/codex/responses",
			);
		});

		it("forces codex origin for other URLs", () => {
			expect(rewriteUrlForCodex("https://api.openai.com/v1/chat/completions")).toBe(
				"https://chatgpt.com/backend-api/v1/chat/completions",
			);
		});
	});
});

describe("SSE Parsing Edge Cases", () => {
	describe("convertSseToJson", () => {
		it("handles empty body", async () => {
			const response = new Response(null, { status: 200 });
			await expect(convertSseToJson(response, new Headers())).rejects.toThrow(
				"Response has no body",
			);
		});

		it("handles empty stream", async () => {
			const response = new Response("", { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			expect(result.status).toBe(200);
		});

		it("handles [DONE] marker only", async () => {
			const sseText = "data: [DONE]\n\n";
			const response = new Response(sseText, { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			expect(result.status).toBe(200);
		});

		it("handles malformed JSON in SSE event", async () => {
			const sseText = 'data: {"invalid json\n\ndata: [DONE]\n\n';
			const response = new Response(sseText, { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			expect(result.status).toBe(200);
		});

		it("handles response.done event", async () => {
			const sseText =
				'data: {"type":"response.done","response":{"id":"resp_123","object":"response"}}\n\n';
			const response = new Response(sseText, { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			
			expect(result.status).toBe(200);
			expect(result.headers.get("content-type")).toContain("application/json");
			
			const body = await result.json();
			expect(body.id).toBe("resp_123");
		});

		it("handles response.completed event", async () => {
			const sseText =
				'data: {"type":"response.completed","response":{"id":"resp_456"}}\n\n';
			const response = new Response(sseText, { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			
			expect(result.status).toBe(200);
			const body = await result.json();
			expect(body.id).toBe("resp_456");
		});

		it("handles error event type", async () => {
			const sseText =
				'data: {"type":"error","error":{"message":"Something went wrong"}}\n\n';
			const response = new Response(sseText, { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			expect(result.status).toBe(200);
		});

		it("handles multiple events, extracts last response.done", async () => {
			const sseText = [
				'data: {"type":"response.created","response":{"id":"resp_1"}}',
				'data: {"type":"response.in_progress","response":{"id":"resp_1"}}',
				'data: {"type":"response.done","response":{"id":"resp_1","status":"completed"}}',
				"data: [DONE]",
			].join("\n\n");
			
			const response = new Response(sseText, { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			
			const body = await result.json();
			expect(body.status).toBe("completed");
		});

		it("handles CRLF line endings", async () => {
			const sseText =
				'data: {"type":"response.done","response":{"id":"resp_crlf"}}\r\n\r\n';
			const response = new Response(sseText, { status: 200 });
			const result = await convertSseToJson(response, new Headers());
			
			const body = await result.json();
			expect(body.id).toBe("resp_crlf");
		});
	});

	describe("ensureContentType", () => {
		it("adds content-type if missing", () => {
			const headers = new Headers();
			const result = ensureContentType(headers);
			expect(result.get("content-type")).toBe("text/event-stream; charset=utf-8");
		});

		it("preserves existing content-type", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const result = ensureContentType(headers);
			expect(result.get("content-type")).toBe("application/json");
		});

		it("does not mutate original headers", () => {
			const headers = new Headers();
			ensureContentType(headers);
			expect(headers.has("content-type")).toBe(false);
		});
	});
});

describe("CircuitBreaker - Stress Tests", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("handles rapid success/failure alternation", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 10, max: 100 }),
				(iterations) => {
					const breaker = new CircuitBreaker({ failureThreshold: 3 });
					
					for (let i = 0; i < iterations; i++) {
						if (i % 2 === 0) {
							breaker.recordFailure();
						} else {
							breaker.recordSuccess();
						}
					}
					
					const state = breaker.getState();
					expect(["closed", "open", "half-open"]).toContain(state);
				},
			),
		);
	});

	it("recovers after many failures followed by success", () => {
		const breaker = new CircuitBreaker({
			failureThreshold: 3,
			resetTimeoutMs: 1000,
		});
		
		for (let i = 0; i < 50; i++) {
			breaker.recordFailure();
		}
		
		expect(breaker.getState()).toBe("open");
		
		vi.setSystemTime(new Date(1001));
		breaker.canExecute();
		breaker.recordSuccess();
		
		expect(breaker.getState()).toBe("closed");
		expect(breaker.getFailureCount()).toBe(0);
	});

	it("handles concurrent-like reset calls", () => {
		const breaker = new CircuitBreaker();
		
		for (let i = 0; i < 100; i++) {
			breaker.recordFailure();
			breaker.reset();
		}
		
		expect(breaker.getState()).toBe("closed");
		expect(breaker.getFailureCount()).toBe(0);
	});
});

describe("CircuitBreaker - Invariants", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("failure count is never negative", () => {
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.constant("f"), fc.constant("s"), fc.constant("r")), {
					minLength: 0,
					maxLength: 50,
				}),
				(ops) => {
					const breaker = new CircuitBreaker({ failureThreshold: 5 });
					
					for (const op of ops) {
						if (op === "f") breaker.recordFailure();
						else if (op === "s") breaker.recordSuccess();
						else breaker.reset();
					}
					
					expect(breaker.getFailureCount()).toBeGreaterThanOrEqual(0);
				},
			),
		);
	});

	it("state is always valid", () => {
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.constant("f"), fc.constant("s"), fc.constant("t")), {
					minLength: 0,
					maxLength: 30,
				}),
				(ops) => {
					const breaker = new CircuitBreaker({
						failureThreshold: 2,
						resetTimeoutMs: 1000,
					});
					let time = 0;
					
					for (const op of ops) {
						if (op === "f") {
							breaker.recordFailure();
						} else if (op === "s") {
							breaker.recordSuccess();
						} else {
							time += 500;
							vi.setSystemTime(new Date(time));
							try {
								breaker.canExecute();
							} catch { /* empty */ }
						}
					}
					
					const state = breaker.getState();
					expect(["closed", "open", "half-open"]).toContain(state);
				},
			),
		);
	});

	it("reset always returns to closed state", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constant("f"), { minLength: 0, maxLength: 20 }),
				(_failures) => {
					const breaker = new CircuitBreaker({ failureThreshold: 1 });
					
					for (const _f of _failures) {
						breaker.recordFailure();
					}
					
					breaker.reset();
					expect(breaker.getState()).toBe("closed");
					expect(breaker.getFailureCount()).toBe(0);
				},
			),
		);
	});
});
