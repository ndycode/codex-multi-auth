import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	configureRateLimitBackoff,
	clearRateLimitBackoffState,
	getRateLimitBackoff,
	getRateLimitShortRetryThresholdMs,
	resetRateLimitBackoff,
	resetRateLimitBackoffConfig,
	calculateBackoffMs,
	getRateLimitBackoffWithReason,
} from "../lib/request/rate-limit-backoff.js";

describe("Rate limit backoff", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
		clearRateLimitBackoffState();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		resetRateLimitBackoffConfig();
	});

	afterEach(() => {
		clearRateLimitBackoffState();
		vi.restoreAllMocks();
		resetRateLimitBackoffConfig();
		vi.useRealTimers();
	});

	it("deduplicates concurrent 429s within the window", () => {
		const first = getRateLimitBackoff(0, "codex", 1000);
		expect(first).toEqual({ attempt: 1, delayMs: 1000, isDuplicate: false });

		vi.setSystemTime(new Date(1000));
		const second = getRateLimitBackoff(0, "codex", 1000);
		expect(second.attempt).toBe(1);
		expect(second.delayMs).toBe(1000);
		expect(second.isDuplicate).toBe(true);
	});

	it("increments after dedup window", () => {
		getRateLimitBackoff(0, "codex", 1000);
		vi.setSystemTime(new Date(2500));
		const second = getRateLimitBackoff(0, "codex", 1000);
		expect(second.attempt).toBe(2);
		expect(second.delayMs).toBe(2000);
		expect(second.isDuplicate).toBe(false);
	});

	it("applies jitter to new backoff windows but keeps duplicate retries stable", () => {
		vi.mocked(Math.random).mockReturnValueOnce(1);
		const first = getRateLimitBackoff(4, "jitter-test", 1000);
		expect(first.delayMs).toBe(1200);

		vi.setSystemTime(new Date(1000));
		vi.mocked(Math.random).mockReturnValueOnce(0);
		const duplicate = getRateLimitBackoff(4, "jitter-test", 1000);
		expect(duplicate.delayMs).toBe(1200);
		expect(duplicate.isDuplicate).toBe(true);

		vi.setSystemTime(new Date(2500));
		vi.mocked(Math.random).mockReturnValueOnce(0);
		const second = getRateLimitBackoff(4, "jitter-test", 1000);
		expect(second.delayMs).toBe(1600);
		expect(second.isDuplicate).toBe(false);
	});

	it("resets after quiet period", () => {
		getRateLimitBackoff(0, "codex", 1000);
		vi.setSystemTime(new Date(121_000));
		const next = getRateLimitBackoff(0, "codex", 1000);
		expect(next.attempt).toBe(1);
	});

	it("resetRateLimitBackoff clears state", () => {
		getRateLimitBackoff(0, "codex", 1000);
		resetRateLimitBackoff(0, "codex");
		const next = getRateLimitBackoff(0, "codex", 1000);
		expect(next.attempt).toBe(1);
		expect(next.isDuplicate).toBe(false);
	});

	it("uses configurable dedup and state reset windows", () => {
		configureRateLimitBackoff({
			dedupWindowMs: 5_000,
			stateResetMs: 10_000,
		});
		getRateLimitBackoff(0, "codex", 1000);

		vi.setSystemTime(new Date(3_000));
		expect(getRateLimitBackoff(0, "codex", 1000).isDuplicate).toBe(true);

		vi.setSystemTime(new Date(11_000));
		expect(getRateLimitBackoff(0, "codex", 1000).attempt).toBe(1);
	});

	it("does not carry rate-limit state across slot reuse when the stable account key changes", () => {
		getRateLimitBackoff(0, "codex", 1000, "acc-1");

		vi.setSystemTime(new Date(2_500));
		const nextAccount = getRateLimitBackoff(0, "codex", 1000, "acc-2");

		expect(nextAccount.attempt).toBe(1);
		expect(nextAccount.isDuplicate).toBe(false);
	});

	it("keeps concurrent config updates on one complete config profile", async () => {
		const profiles = [
			{
				dedupWindowMs: 500,
				stateResetMs: 3_000,
				maxBackoffMs: 7_000,
				shortRetryThresholdMs: 1_100,
			},
			{
				dedupWindowMs: 9_000,
				stateResetMs: 20_000,
				maxBackoffMs: 17_000,
				shortRetryThresholdMs: 9_100,
			},
		] as const;

		await Promise.all(
			profiles.map(async (profile) => {
				await Promise.resolve();
				configureRateLimitBackoff(profile);
			}),
		);

		const activeProfile = profiles.find(
			(profile) =>
				profile.shortRetryThresholdMs === getRateLimitShortRetryThresholdMs(),
		);

		expect(activeProfile).toBeDefined();
		// calculateBackoffMs now applies only the reason multiplier (not an
		// additional 2^(attempt-1)) so saturating maxBackoffMs requires a
		// baseDelayMs well above the cap. See REQ-HIGH-01.
		expect(
			calculateBackoffMs(activeProfile!.maxBackoffMs * 10, 20, "quota"),
		).toBe(activeProfile!.maxBackoffMs);

		const first = getRateLimitBackoff(20, "concurrent", 1000);
		expect(first.isDuplicate).toBe(false);

		vi.setSystemTime(new Date(activeProfile!.dedupWindowMs - 1));
		expect(getRateLimitBackoff(20, "concurrent", 1000).isDuplicate).toBe(true);

		vi.setSystemTime(new Date(activeProfile!.stateResetMs + 1));
		expect(getRateLimitBackoff(20, "concurrent", 1000).attempt).toBe(1);
	});

	describe("calculateBackoffMs", () => {
		it("applies quota multiplier (3.0)", () => {
			const result = calculateBackoffMs(1000, 1, "quota");
			expect(result).toBe(3000);
		});

		it("applies tokens multiplier (1.5)", () => {
			const result = calculateBackoffMs(1000, 1, "tokens");
			expect(result).toBe(1500);
		});

		it("applies concurrent multiplier (0.5)", () => {
			const result = calculateBackoffMs(1000, 1, "concurrent");
			expect(result).toBe(500);
		});

		it("applies unknown multiplier (1.0)", () => {
			const result = calculateBackoffMs(1000, 1, "unknown");
			expect(result).toBe(1000);
		});

		it("does not re-apply exponential on higher attempts (REQ-HIGH-01)", () => {
			// calculateBackoffMs must not multiply by 2^(attempt-1) because its
			// baseDelayMs argument is already exponential+jittered when chained
			// with getRateLimitBackoff. Before the fix, this path caused a
			// double-exponential that saturated maxBackoffMs after ~2 retries.
			const attempt1 = calculateBackoffMs(1000, 1, "unknown");
			const attempt2 = calculateBackoffMs(1000, 2, "unknown");
			const attempt3 = calculateBackoffMs(1000, 3, "unknown");
			expect(attempt1).toBe(1000);
			expect(attempt2).toBe(1000);
			expect(attempt3).toBe(1000);
		});

		it("caps at MAX_BACKOFF_MS", () => {
			// Use a baseDelayMs large enough that the multiplier would exceed
			// the default cap (5 min in this test's config context).
			const huge = 10 * 60 * 1000;
			const result = calculateBackoffMs(huge, 20, "quota");
			expect(result).toBeLessThanOrEqual(5 * 60 * 1000);
		});

		it("uses default multiplier when reason is undefined", () => {
			const result = calculateBackoffMs(1000, 1);
			expect(result).toBe(1000);
		});

		it("uses fallback multiplier 1.0 when reason is not in map (line 111 coverage)", () => {
			const result = calculateBackoffMs(1000, 1, "unknown-reason" as never);
			expect(result).toBe(1000);
		});

		it("uses configurable max backoff cap", () => {
			configureRateLimitBackoff({ maxBackoffMs: 12_000 });
			// baseDelayMs * quota multiplier (3.0) = 30_000, which clamps to 12_000.
			const result = calculateBackoffMs(10_000, 20, "quota");
			expect(result).toBe(12_000);
		});
	});

	it("exposes configurable short retry threshold", () => {
		expect(getRateLimitShortRetryThresholdMs()).toBe(5_000);
		configureRateLimitBackoff({ shortRetryThresholdMs: 9_000 });
		expect(getRateLimitShortRetryThresholdMs()).toBe(9_000);
	});

	describe("normalizeDelayMs edge cases (line 32 coverage)", () => {
		it("uses fallback when serverRetryAfterMs is null", () => {
			const result = getRateLimitBackoff(10, "null-test", null);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is undefined", () => {
			const result = getRateLimitBackoff(11, "undefined-test", undefined);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is NaN", () => {
			const result = getRateLimitBackoff(12, "nan-test", NaN);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is Infinity", () => {
			const result = getRateLimitBackoff(13, "infinity-test", Infinity);
			expect(result.delayMs).toBe(1000);
		});

		it("uses fallback when serverRetryAfterMs is negative Infinity", () => {
			const result = getRateLimitBackoff(14, "neg-infinity-test", -Infinity);
			expect(result.delayMs).toBe(1000);
		});
	});

	describe("getRateLimitBackoffWithReason", () => {
		it("returns adjusted delay with quota reason", () => {
			const result = getRateLimitBackoffWithReason(
				0,
				"test-quota",
				1000,
				"quota",
			);
			expect(result.reason).toBe("quota");
			expect(result.delayMs).toBe(3000);
			expect(result.attempt).toBe(1);
		});

		it("returns adjusted delay with tokens reason", () => {
			const result = getRateLimitBackoffWithReason(
				1,
				"test-tokens",
				2000,
				"tokens",
			);
			expect(result.reason).toBe("tokens");
			expect(result.delayMs).toBe(3000);
		});

		it("uses unknown reason by default", () => {
			const result = getRateLimitBackoffWithReason(2, "test-default", 1000);
			expect(result.reason).toBe("unknown");
			expect(result.delayMs).toBe(1000);
		});

		it("increments attempt on subsequent calls", () => {
			getRateLimitBackoffWithReason(3, "test-increment", 1000, "quota");
			vi.setSystemTime(new Date(2500));
			const second = getRateLimitBackoffWithReason(
				3,
				"test-increment",
				1000,
				"quota",
			);
			expect(second.attempt).toBe(2);
			// getRateLimitBackoff gives 1000 * 2^1 = 2000 (attempt=2, zero jitter
			// via Math.random mock). calculateBackoffMs applies only the quota
			// multiplier (3.0): 2000 * 3.0 = 6000. Before REQ-HIGH-01 fix this
			// double-applied the exponential and produced 12000.
			expect(second.delayMs).toBe(6000);
		});

		it("supports named-parameter options form", () => {
			const positional = getRateLimitBackoffWithReason(
				20,
				"named-quota",
				1000,
				"tokens",
			);
			clearRateLimitBackoffState();
			const named = getRateLimitBackoffWithReason({
				accountIndex: 20,
				quotaKey: "named-quota",
				serverRetryAfterMs: 1000,
				reason: "tokens",
			});
			expect(named).toEqual(positional);
		});

		it("throws for invalid named accountIndex values", () => {
			expect(() =>
				getRateLimitBackoffWithReason({
					accountIndex: -1,
					quotaKey: "invalid-index",
					serverRetryAfterMs: 1000,
				}),
			).toThrowError(
				"getRateLimitBackoffWithReason requires a non-negative integer accountIndex",
			);
			expect(() =>
				getRateLimitBackoffWithReason({
					accountIndex: Number.NaN,
					quotaKey: "invalid-index",
					serverRetryAfterMs: 1000,
				}),
			).toThrowError(
				"getRateLimitBackoffWithReason requires a non-negative integer accountIndex",
			);
		});

		it("does not mutate shared state when named accountIndex is invalid", () => {
			expect(() =>
				getRateLimitBackoffWithReason({
					accountIndex: -5,
					quotaKey: "state-safe",
					serverRetryAfterMs: 1000,
				}),
			).toThrow();

			const firstValid = getRateLimitBackoffWithReason(
				7,
				"state-safe",
				1000,
				"unknown",
			);
			expect(firstValid.attempt).toBe(1);
			expect(firstValid.isDuplicate).toBe(false);
		});

		// REQ-HIGH-01 regression: previously `getRateLimitBackoffWithReason`
		// chained `getRateLimitBackoff` (which applies baseDelay * 2^(attempt-1)
		// + jitter) and `calculateBackoffMs` (which ALSO applied 2^(attempt-1)).
		// The double-exponential caused delays to saturate at `maxBackoffMs`
		// after just ~2 consecutive 429s. See
		// `.sisyphus/notepads/deep-audit/reports/request.json` for the audit.
		it("does not double-apply exponential across chained attempts (REQ-HIGH-01)", () => {
			const accountIndex = 42;
			const quotaKey = "req-high-01-regression";
			const baseDelayMs = 1000;

			// attempt 1
			const first = getRateLimitBackoffWithReason(
				accountIndex,
				quotaKey,
				baseDelayMs,
				"tokens",
			);
			expect(first.attempt).toBe(1);
			// 1000 * 2^0 = 1000, jitter mocked to 0, then * tokens(1.5) = 1500.
			expect(first.delayMs).toBe(1500);

			// attempt 2 (step past default dedup window of 2000ms)
			vi.setSystemTime(new Date(2_500));
			const second = getRateLimitBackoffWithReason(
				accountIndex,
				quotaKey,
				baseDelayMs,
				"tokens",
			);
			expect(second.attempt).toBe(2);
			// 1000 * 2^1 = 2000, then * tokens(1.5) = 3000.
			expect(second.delayMs).toBe(3000);

			// attempt 3
			vi.setSystemTime(new Date(5_000));
			const third = getRateLimitBackoffWithReason(
				accountIndex,
				quotaKey,
				baseDelayMs,
				"tokens",
			);
			expect(third.attempt).toBe(3);
			// 1000 * 2^2 = 4000, then * tokens(1.5) = 6000.
			// Before the fix this path evaluated to 4000 * 2^2 * 1.5 = 24000
			// (still under the 60s cap for attempt=3 but rapidly saturating).
			expect(third.delayMs).toBe(6000);

			// Stays well under the default 60s cap.
			expect(third.delayMs).toBeLessThan(60_000);

			// Ratio attempt=1 -> attempt=3 must reflect a single exponential
			// (2^2 = 4x), NOT a double exponential (2^4 = 16x or hitting cap).
			const ratio = third.delayMs / first.delayMs;
			expect(ratio).toBeCloseTo(4, 1);
			expect(ratio).toBeLessThan(8);
		});
	});
});
