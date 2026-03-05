import { describe, expect, it } from "vitest";
import { decideRetryAllAccountsRateLimited } from "../lib/request/retry-governor.js";

describe("decideRetryAllAccountsRateLimited", () => {
	it("allows retry when all limits permit it", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 1_000,
			maxWaitMs: 2_000,
			currentRetryCount: 1,
			maxRetries: 3,
			accumulatedWaitMs: 2_000,
			absoluteCeilingMs: 10_000,
		});

		expect(result).toEqual({ shouldRetry: true, reason: "allowed" });
	});

	it("rejects retry when disabled", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: false,
			accountCount: 2,
			waitMs: 1_000,
			maxWaitMs: 0,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 0,
			absoluteCeilingMs: 0,
		});

		expect(result).toEqual({ shouldRetry: false, reason: "disabled" });
	});

	it("rejects retry when there are no accounts", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 0,
			waitMs: 1_000,
			maxWaitMs: 0,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 0,
			absoluteCeilingMs: 0,
		});

		expect(result).toEqual({ shouldRetry: false, reason: "no-accounts" });
	});

	it("rejects retry when wait time is non-positive", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 0,
			maxWaitMs: 0,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 0,
			absoluteCeilingMs: 0,
		});

		expect(result).toEqual({ shouldRetry: false, reason: "no-wait" });
	});

	it("rejects retry when wait exceeds max wait", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 1_500,
			maxWaitMs: 1_000,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 0,
			absoluteCeilingMs: 0,
		});

		expect(result).toEqual({ shouldRetry: false, reason: "wait-exceeds-max" });
	});

	it("rejects retry when max retries reached", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 1_000,
			maxWaitMs: 0,
			currentRetryCount: 2,
			maxRetries: 2,
			accumulatedWaitMs: 0,
			absoluteCeilingMs: 0,
		});

		expect(result).toEqual({ shouldRetry: false, reason: "retry-limit-reached" });
	});

	it("rejects retry when absolute ceiling would be exceeded", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 1_001,
			maxWaitMs: 0,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 1_000,
			absoluteCeilingMs: 2_000,
		});

		expect(result).toEqual({
			shouldRetry: false,
			reason: "absolute-ceiling-exceeded",
		});
	});

	it("allows retry when accumulated wait exactly matches the absolute ceiling", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 1_000,
			maxWaitMs: 0,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 1_000,
			absoluteCeilingMs: 2_000,
		});

		expect(result).toEqual({ shouldRetry: true, reason: "allowed" });
	});

	it("uses planned wait for absolute ceiling checks when provided", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 1_000,
			plannedWaitMs: 800,
			maxWaitMs: 0,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 800,
			absoluteCeilingMs: 1_600,
		});

		expect(result).toEqual({ shouldRetry: true, reason: "allowed" });
	});

	it("treats zero absolute ceiling as unlimited", () => {
		const result = decideRetryAllAccountsRateLimited({
			enabled: true,
			accountCount: 2,
			waitMs: 2_000,
			maxWaitMs: 0,
			currentRetryCount: 0,
			maxRetries: Infinity,
			accumulatedWaitMs: 100_000,
			absoluteCeilingMs: 0,
		});

		expect(result).toEqual({ shouldRetry: true, reason: "allowed" });
	});
});
