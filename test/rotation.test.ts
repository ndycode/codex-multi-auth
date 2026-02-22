import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	HealthScoreTracker,
	TokenBucketTracker,
	selectHybridAccount,
	addJitter,
	randomDelay,
	exponentialBackoff,
	DEFAULT_HEALTH_SCORE_CONFIG,
	DEFAULT_TOKEN_BUCKET_CONFIG,
	type AccountWithMetrics,
} from "../lib/rotation.js";

describe("HealthScoreTracker", () => {
	let tracker: HealthScoreTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
		tracker = new HealthScoreTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("getScore", () => {
		it("returns maxScore for unknown accounts", () => {
			expect(tracker.getScore(0)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
		});

		it("returns maxScore for accounts with quotaKey", () => {
			expect(tracker.getScore(0, "quota-a")).toBe(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore
			);
		});
	});

	describe("recordSuccess", () => {
		it("increases score up to maxScore", () => {
			tracker.recordRateLimit(0);
			const afterRateLimit = tracker.getScore(0);

			tracker.recordSuccess(0);
			const afterSuccess = tracker.getScore(0);

			expect(afterSuccess).toBeGreaterThan(afterRateLimit);
		});

		it("resets consecutive failures on success", () => {
			tracker.recordFailure(0);
			tracker.recordFailure(0);
			expect(tracker.getConsecutiveFailures(0)).toBe(2);

			tracker.recordSuccess(0);
			expect(tracker.getConsecutiveFailures(0)).toBe(0);
		});

		it("does not exceed maxScore", () => {
			for (let i = 0; i < 200; i++) {
				tracker.recordSuccess(0);
			}
			expect(tracker.getScore(0)).toBeLessThanOrEqual(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore
			);
		});
	});

	describe("recordRateLimit", () => {
		it("decreases score by rateLimitDelta", () => {
			tracker.recordRateLimit(0);
			const expected =
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore +
				DEFAULT_HEALTH_SCORE_CONFIG.rateLimitDelta;
			expect(tracker.getScore(0)).toBe(expected);
		});

		it("increments consecutive failures", () => {
			tracker.recordRateLimit(0);
			expect(tracker.getConsecutiveFailures(0)).toBe(1);

			tracker.recordRateLimit(0);
			expect(tracker.getConsecutiveFailures(0)).toBe(2);
		});
	});

	describe("recordFailure", () => {
		it("decreases score by failureDelta", () => {
			tracker.recordFailure(0);
			const expected =
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore +
				DEFAULT_HEALTH_SCORE_CONFIG.failureDelta;
			expect(tracker.getScore(0)).toBe(expected);
		});

		it("does not go below minScore", () => {
			for (let i = 0; i < 10; i++) {
				tracker.recordFailure(0);
			}
			expect(tracker.getScore(0)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.minScore);
		});
	});

	describe("passive recovery", () => {
		it("recovers points over time", () => {
			tracker.recordRateLimit(0);
			const afterRateLimit = tracker.getScore(0);

			vi.advanceTimersByTime(1000 * 60 * 60);
			const afterOneHour = tracker.getScore(0);

			const expectedRecovery = DEFAULT_HEALTH_SCORE_CONFIG.passiveRecoveryPerHour;
			expect(afterOneHour).toBeCloseTo(afterRateLimit + expectedRecovery, 1);
		});

		it("does not exceed maxScore during recovery", () => {
			tracker.recordRateLimit(0);

			vi.advanceTimersByTime(1000 * 60 * 60 * 100);
			expect(tracker.getScore(0)).toBeLessThanOrEqual(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore
			);
		});
	});

	describe("reset and clear", () => {
		it("reset removes single account entry", () => {
			tracker.recordFailure(0);
			tracker.recordFailure(1);

			tracker.reset(0);

			expect(tracker.getScore(0)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
			expect(tracker.getScore(1)).toBeLessThan(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore
			);
		});

		it("clear removes all entries", () => {
			tracker.recordFailure(0);
			tracker.recordFailure(1);
			tracker.recordFailure(2);

			tracker.clear();

			expect(tracker.getScore(0)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
			expect(tracker.getScore(1)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
			expect(tracker.getScore(2)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
		});
	});

	describe("quotaKey isolation", () => {
		it("isolates scores by quotaKey", () => {
			tracker.recordFailure(0, "quota-a");
			tracker.recordSuccess(0, "quota-b");

			expect(tracker.getScore(0, "quota-a")).toBeLessThan(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore
			);
			expect(tracker.getScore(0, "quota-b")).toBe(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore
			);
		});
	});
});

describe("TokenBucketTracker", () => {
	let tracker: TokenBucketTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
		tracker = new TokenBucketTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("getTokens", () => {
		it("returns maxTokens for unknown accounts", () => {
			expect(tracker.getTokens(0)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		});
	});

	describe("tryConsume", () => {
		it("consumes one token and returns true", () => {
			const result = tracker.tryConsume(0);
			expect(result).toBe(true);
			expect(tracker.getTokens(0)).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 1
			);
		});

		it("returns false when no tokens available", () => {
			for (let i = 0; i < DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens; i++) {
				tracker.tryConsume(0);
			}
			const result = tracker.tryConsume(0);
			expect(result).toBe(false);
		});
	});

	describe("refundToken", () => {
		it("refunds token consumed within 30s window", () => {
			tracker.tryConsume(0);
			const result = tracker.refundToken(0);
			expect(result).toBe(true);
			expect(tracker.getTokens(0)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		});

		it("rejects refund for token consumed over 30s ago", () => {
			tracker.tryConsume(0);

			vi.advanceTimersByTime(30_001);

			const result = tracker.refundToken(0);
			expect(result).toBe(false);
		});

		it("returns false when no tokens consumed", () => {
			expect(tracker.refundToken(0)).toBe(false);
		});

		it("does not exceed maxTokens on refund", () => {
			tracker.tryConsume(0);

			vi.advanceTimersByTime(10_000);

			const result = tracker.refundToken(0);
			expect(result).toBe(true);
			expect(tracker.getTokens(0)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		});
	});

	describe("token refill", () => {
		it("refills tokens over time", () => {
			for (let i = 0; i < 10; i++) {
				tracker.tryConsume(0);
			}
			const afterDrain = tracker.getTokens(0);

			vi.advanceTimersByTime(1000 * 60);
			const afterOneMinute = tracker.getTokens(0);

			expect(afterOneMinute).toBeGreaterThan(afterDrain);
		});

		it("does not exceed maxTokens during refill", () => {
			tracker.tryConsume(0);

			vi.advanceTimersByTime(1000 * 60 * 60);
			expect(tracker.getTokens(0)).toBeLessThanOrEqual(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens
			);
		});
	});

	describe("drain", () => {
		it("removes specified tokens", () => {
			tracker.drain(0, undefined, 20);
			expect(tracker.getTokens(0)).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 20
			);
		});

		it("does not go below zero", () => {
			tracker.drain(0, undefined, 100);
			expect(tracker.getTokens(0)).toBe(0);
		});

		it("uses maxTokens when no prior entry exists for drain (line 205 coverage)", () => {
			tracker.drain(5, "new-quota", 5);
			expect(tracker.getTokens(5, "new-quota")).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 5
			);
		});
	});

	describe("reset and clear", () => {
		it("reset removes single account entry", () => {
			tracker.drain(0, undefined, 30);
			tracker.drain(1, undefined, 30);

			tracker.reset(0);

			expect(tracker.getTokens(0)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
			expect(tracker.getTokens(1)).toBeLessThan(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens
			);
		});

		it("clear removes all entries", () => {
			tracker.drain(0, undefined, 30);
			tracker.drain(1, undefined, 30);

			tracker.clear();

			expect(tracker.getTokens(0)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
			expect(tracker.getTokens(1)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
		});
	});
});

describe("selectHybridAccount", () => {
	let healthTracker: HealthScoreTracker;
	let tokenTracker: TokenBucketTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
		healthTracker = new HealthScoreTracker();
		tokenTracker = new TokenBucketTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns null when no accounts available", () => {
		const result = selectHybridAccount([], healthTracker, tokenTracker);
		expect(result).toBe(null);
	});

	it("returns least-recently-used account when all accounts unavailable (fallback)", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: false, lastUsed: 100 },
			{ index: 1, isAvailable: false, lastUsed: 50 },
		];
		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		// When all accounts unavailable, returns the least-recently-used one as fallback
		expect(result?.index).toBe(1); // index 1 has lastUsed: 50 (older)
	});

	it("returns the only available account", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: 0 },
		];
		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(result?.index).toBe(0);
	});

	it("prefers healthier accounts", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{ index: 1, isAvailable: true, lastUsed: Date.now() },
		];
		healthTracker.recordFailure(0);

		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(result?.index).toBe(1);
	});

	it("prefers accounts with more tokens", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{ index: 1, isAvailable: true, lastUsed: Date.now() },
		];
		tokenTracker.drain(0, undefined, 40);

		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(result?.index).toBe(1);
	});

	it("considers freshness in selection", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{
				index: 1,
				isAvailable: true,
				lastUsed: Date.now() - 1000 * 60 * 60 * 24,
			},
		];

		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(result?.index).toBe(1);
	});

	it("pidOffsetEnabled false does not change selection", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{ index: 1, isAvailable: true, lastUsed: Date.now() },
		];

		const result1 = selectHybridAccount(accounts, healthTracker, tokenTracker, undefined, undefined, { pidOffsetEnabled: false });
		const result2 = selectHybridAccount(accounts, healthTracker, tokenTracker);

		expect(result1?.index).toBe(result2?.index);
	});

	it("pidOffsetEnabled true adds deterministic offset based on process.pid", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{ index: 1, isAvailable: true, lastUsed: Date.now() },
		];

		const result = selectHybridAccount(accounts, healthTracker, tokenTracker, undefined, undefined, { pidOffsetEnabled: true });

		expect(result).not.toBe(null);
		expect([0, 1]).toContain(result?.index);
	});

	it("pidOffsetEnabled uses process.pid modulo 100 for offset calculation", () => {
		const originalPid = process.pid;
		Object.defineProperty(process, 'pid', { value: 50, configurable: true });

		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{ index: 1, isAvailable: true, lastUsed: Date.now() },
		];

		const result = selectHybridAccount(accounts, healthTracker, tokenTracker, undefined, undefined, { pidOffsetEnabled: true });
		expect(result).not.toBe(null);

		Object.defineProperty(process, 'pid', { value: originalPid, configurable: true });
	});

	it("pidOffsetEnabled differentiates selection across different PIDs", () => {
		const originalPid = process.pid;
		const now = Date.now();
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: now },
			{ index: 1, isAvailable: true, lastUsed: now },
			{ index: 2, isAvailable: true, lastUsed: now },
			{ index: 3, isAvailable: true, lastUsed: now },
		];

		const selectedIndices = new Set<number>();
		for (let pid = 0; pid < 100; pid += 10) {
			Object.defineProperty(process, 'pid', { value: pid, configurable: true });
			const result = selectHybridAccount(accounts, healthTracker, tokenTracker, undefined, undefined, { pidOffsetEnabled: true });
			if (result) {
				selectedIndices.add(result.index);
			}
		}

		Object.defineProperty(process, 'pid', { value: originalPid, configurable: true });

		expect(selectedIndices.size).toBeGreaterThan(1);
	});
});

describe("utility functions", () => {
	describe("addJitter", () => {
		it("returns value within jitter range", () => {
			const base = 1000;
			const factor = 0.2;

			for (let i = 0; i < 100; i++) {
				const result = addJitter(base, factor);
				expect(result).toBeGreaterThanOrEqual(base * (1 - factor));
				expect(result).toBeLessThanOrEqual(base * (1 + factor));
			}
		});

		it("returns non-negative values", () => {
			const result = addJitter(10, 2.0);
			expect(result).toBeGreaterThanOrEqual(0);
		});
	});

	describe("randomDelay", () => {
		it("returns value within range", () => {
			const min = 100;
			const max = 500;

			for (let i = 0; i < 100; i++) {
				const result = randomDelay(min, max);
				expect(result).toBeGreaterThanOrEqual(min);
				expect(result).toBeLessThanOrEqual(max);
			}
		});
	});

	describe("exponentialBackoff", () => {
		it("increases delay exponentially", () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5);

			const delay1 = exponentialBackoff(1, 1000, 60000, 0);
			const delay2 = exponentialBackoff(2, 1000, 60000, 0);
			const delay3 = exponentialBackoff(3, 1000, 60000, 0);

			expect(delay2).toBe(delay1 * 2);
			expect(delay3).toBe(delay1 * 4);

			vi.spyOn(Math, "random").mockRestore();
		});

		it("caps at maxMs", () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5);

			const result = exponentialBackoff(10, 1000, 5000, 0);
			expect(result).toBe(5000);

			vi.spyOn(Math, "random").mockRestore();
		});
	});
});
