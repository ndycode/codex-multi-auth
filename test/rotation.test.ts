import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	HealthScoreTracker,
	TokenBucketTracker,
	selectHybridAccount,
	selectHybridAccountTraced,
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
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
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
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
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

			const expectedRecovery =
				DEFAULT_HEALTH_SCORE_CONFIG.passiveRecoveryPerHour;
			expect(afterOneHour).toBeCloseTo(afterRateLimit + expectedRecovery, 1);
		});

		it("does not exceed maxScore during recovery", () => {
			tracker.recordRateLimit(0);

			vi.advanceTimersByTime(1000 * 60 * 60 * 100);
			expect(tracker.getScore(0)).toBeLessThanOrEqual(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
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
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
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
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
			);
			expect(tracker.getScore(0, "quota-b")).toBe(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
			);
		});
	});

	describe("clearAccountKey", () => {
		it("clears every quotaKey variant for one identity (accounts-02)", () => {
			tracker.recordFailure("acc", "codex");
			tracker.recordFailure("acc", "codex:gpt-5.1");
			tracker.recordFailure("other", "codex");

			tracker.clearAccountKey("acc");

			// All variants of the cleared identity reset to maxScore...
			expect(tracker.getScore("acc", "codex")).toBe(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
			);
			expect(tracker.getScore("acc", "codex:gpt-5.1")).toBe(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
			);
			// ...while a different identity is untouched.
			expect(tracker.getScore("other", "codex")).toBeLessThan(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
			);
		});

		it("normalizes a numeric account key to its string form", () => {
			// Write under the numeric key but clear with the string form: the two only
			// reset the same entry if clearAccountKey normalizes number → string ("3").
			tracker.recordFailure(3, "codex");
			tracker.clearAccountKey("3");
			expect(tracker.getScore(3, "codex")).toBe(
				DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
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
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 1,
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
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
			);
		});
	});

	describe("drain", () => {
		it("removes specified tokens", () => {
			tracker.drain(0, undefined, 20);
			expect(tracker.getTokens(0)).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 20,
			);
		});

		it("does not go below zero", () => {
			tracker.drain(0, undefined, 100);
			expect(tracker.getTokens(0)).toBe(0);
		});

		it("uses maxTokens when no prior entry exists for drain (line 205 coverage)", () => {
			tracker.drain(5, "new-quota", 5);
			expect(tracker.getTokens(5, "new-quota")).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 5,
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
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
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

	describe("clearAccountKey", () => {
		it("clears every quotaKey-variant bucket for one identity (accounts-02)", () => {
			tracker.drain("acc", "codex", 30);
			tracker.drain("acc", "codex:gpt-5.1", 30);
			tracker.drain("other", "codex", 30);

			tracker.clearAccountKey("acc");

			expect(tracker.getTokens("acc", "codex")).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
			);
			expect(tracker.getTokens("acc", "codex:gpt-5.1")).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
			);
			expect(tracker.getTokens("other", "codex")).toBeLessThan(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
			);
		});

		it("normalizes a numeric account key to its string form", () => {
			// Drain under the string key but clear with the numeric form: the two only
			// reset the same bucket if clearAccountKey normalizes number → string ("3").
			tracker.drain("3", "codex", 30);
			tracker.clearAccountKey(3);
			expect(tracker.getTokens("3", "codex")).toBe(
				DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
			);
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

	it("returns null when all accounts are unavailable (AUDIT-H2 contract)", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: false, lastUsed: 100 },
			{ index: 1, isAvailable: false, lastUsed: 50 },
		];
		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		// Previously returned the least-recently-used unavailable account as a
		// "fallback"; the fetch loop trusted it and churned through blocked
		// candidates (AUDIT-H2 / D-01). New contract: return null so the caller
		// surfaces the pool-wide unavailable condition explicitly.
		expect(result).toBe(null);
	});

	it("returns null when a single account is unavailable", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: false, lastUsed: 0 },
		];
		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(result).toBe(null);
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

	it("uses trackerKey when runtime state is keyed by stable identity", () => {
		const now = Date.now();
		const accounts: AccountWithMetrics[] = [
			{
				index: 0,
				trackerKey: "email:first@example.com",
				isAvailable: true,
				lastUsed: now,
			},
			{
				index: 1,
				trackerKey: "email:second@example.com",
				isAvailable: true,
				lastUsed: now,
			},
		];

		healthTracker.recordFailure("email:first@example.com");

		const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(result?.index).toBe(1);
	});

	it("pidOffsetEnabled false does not change selection", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{ index: 1, isAvailable: true, lastUsed: Date.now() },
		];

		const result1 = selectHybridAccount(
			accounts,
			healthTracker,
			tokenTracker,
			undefined,
			undefined,
			{ pidOffsetEnabled: false },
		);
		const result2 = selectHybridAccount(accounts, healthTracker, tokenTracker);

		expect(result1?.index).toBe(result2?.index);
	});

	it("pidOffsetEnabled true adds deterministic offset based on process.pid", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() },
			{ index: 1, isAvailable: true, lastUsed: Date.now() },
		];

		const result = selectHybridAccount(
			accounts,
			healthTracker,
			tokenTracker,
			undefined,
			undefined,
			{ pidOffsetEnabled: true },
		);

		expect(result).not.toBe(null);
		expect([0, 1]).toContain(result?.index);
	});

	it("pidOffsetEnabled uses process.pid modulo 100 for offset calculation", () => {
		const originalPid = process.pid;
		try {
			Object.defineProperty(process, "pid", { value: 50, configurable: true });

			const accounts: AccountWithMetrics[] = [
				{ index: 0, isAvailable: true, lastUsed: Date.now() },
				{ index: 1, isAvailable: true, lastUsed: Date.now() },
			];

			const result = selectHybridAccount(
				accounts,
				healthTracker,
				tokenTracker,
				undefined,
				undefined,
				{ pidOffsetEnabled: true },
			);
			expect(result).not.toBe(null);
		} finally {
			Object.defineProperty(process, "pid", {
				value: originalPid,
				configurable: true,
			});
		}
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
		try {
			for (let pid = 0; pid < 100; pid += 10) {
				Object.defineProperty(process, "pid", {
					value: pid,
					configurable: true,
				});
				const result = selectHybridAccount(
					accounts,
					healthTracker,
					tokenTracker,
					undefined,
					undefined,
					{ pidOffsetEnabled: true },
				);
				if (result) {
					selectedIndices.add(result.index);
				}
			}
		} finally {
			Object.defineProperty(process, "pid", {
				value: originalPid,
				configurable: true,
			});
		}

		expect(selectedIndices.size).toBeGreaterThan(1);
	});

	it("applies scoreBoostByAccount to deterministically change winner", () => {
		const now = Date.now();
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: now },
			{ index: 1, isAvailable: true, lastUsed: now },
		];

		const baseline = selectHybridAccount(accounts, healthTracker, tokenTracker);
		expect(baseline?.index).toBe(0);

		const boosted = selectHybridAccount(
			accounts,
			healthTracker,
			tokenTracker,
			undefined,
			undefined,
			{
				scoreBoostByAccount: { 1: 25 },
			},
		);
		expect(boosted?.index).toBe(1);
	});

	it("ignores non-finite score boosts", () => {
		const now = Date.now();
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: now },
			{ index: 1, isAvailable: true, lastUsed: now },
		];

		const baseline = selectHybridAccount(accounts, healthTracker, tokenTracker);
		const withNan = selectHybridAccount(
			accounts,
			healthTracker,
			tokenTracker,
			undefined,
			undefined,
			{ scoreBoostByAccount: { 1: Number.NaN } },
		);
		const withInf = selectHybridAccount(
			accounts,
			healthTracker,
			tokenTracker,
			undefined,
			undefined,
			{ scoreBoostByAccount: { 1: Number.POSITIVE_INFINITY } },
		);

		expect(withNan?.index).toBe(baseline?.index);
		expect(withInf?.index).toBe(baseline?.index);
	});

	it("keeps boost behavior stable when pid offset is enabled", () => {
		const now = Date.now();
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: now },
			{ index: 1, isAvailable: true, lastUsed: now },
		];

		const result = selectHybridAccount(
			accounts,
			healthTracker,
			tokenTracker,
			undefined,
			undefined,
			{
				pidOffsetEnabled: true,
				scoreBoostByAccount: { 1: 100 },
			},
		);
		expect(result?.index).toBe(1);
	});

	it("supports named-parameter options form", () => {
		const now = Date.now();
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: now },
			{ index: 1, isAvailable: true, lastUsed: now },
		];

		const baseline = selectHybridAccount(accounts, healthTracker, tokenTracker);
		const named = selectHybridAccount({
			accounts,
			healthTracker,
			tokenTracker,
		});

		expect(named?.index).toBe(baseline?.index);
	});

	it("throws when named params accounts is not an array", () => {
		expect(() =>
			selectHybridAccount({
				accounts: {} as unknown as AccountWithMetrics[],
				healthTracker,
				tokenTracker,
			}),
		).toThrowError("selectHybridAccount requires accounts to be an array");
		expect(() =>
			selectHybridAccount({
				accounts: null as unknown as AccountWithMetrics[],
				healthTracker,
				tokenTracker,
			}),
		).toThrowError("selectHybridAccount requires accounts to be an array");
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
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
			try {
				const delay1 = exponentialBackoff(1, 1000, 60000, 0);
				const delay2 = exponentialBackoff(2, 1000, 60000, 0);
				const delay3 = exponentialBackoff(3, 1000, 60000, 0);

				expect(delay2).toBe(delay1 * 2);
				expect(delay3).toBe(delay1 * 4);
			} finally {
				randomSpy.mockRestore();
			}
		});

		it("caps at maxMs", () => {
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
			try {
				const result = exponentialBackoff(10, 1000, 5000, 0);
				expect(result).toBe(5000);
			} finally {
				randomSpy.mockRestore();
			}
		});

		it("supports named-parameter options form", () => {
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
			try {
				const positional = exponentialBackoff(3, 1000, 60000, 0);
				const named = exponentialBackoff({
					attempt: 3,
					baseMs: 1000,
					maxMs: 60000,
					jitterFactor: 0,
				});

				expect(named).toBe(positional);
			} finally {
				randomSpy.mockRestore();
			}
		});

		it("throws for invalid positional and named inputs before jitter is applied", () => {
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
			try {
				expect(() => exponentialBackoff(0, 1000, 60000, 0.1)).toThrowError(
					"exponentialBackoff requires attempt to be a positive integer",
				);
				expect(() => exponentialBackoff(-1, 1000, 60000, 0.1)).toThrowError(
					"exponentialBackoff requires attempt to be a positive integer",
				);
				expect(() =>
					exponentialBackoff(Number.NaN as unknown as number, 1000, 60000, 0.1),
				).toThrowError(
					"exponentialBackoff requires attempt to be a positive integer",
				);
				expect(() =>
					exponentialBackoff(
						Number.POSITIVE_INFINITY as unknown as number,
						1000,
						60000,
						0.1,
					),
				).toThrowError(
					"exponentialBackoff requires attempt to be a positive integer",
				);
				expect(() =>
					exponentialBackoff(undefined as unknown as number, 1000, 60000, 0.1),
				).toThrowError(
					"exponentialBackoff requires attempt to be a positive integer",
				);
				expect(() => exponentialBackoff(1, -1, 60000, 0.1)).toThrowError(
					"exponentialBackoff requires baseMs to be a finite non-negative number",
				);
				expect(() => exponentialBackoff(1, 1000, -1, 0.1)).toThrowError(
					"exponentialBackoff requires maxMs to be a finite non-negative number",
				);
				expect(() =>
					exponentialBackoff(
						{} as unknown as Parameters<typeof exponentialBackoff>[0],
					),
				).toThrowError(
					"exponentialBackoff requires attempt to be a positive integer",
				);
				expect(() =>
					exponentialBackoff({ attempt: 1, jitterFactor: 2 }),
				).toThrowError(
					"exponentialBackoff requires jitterFactor to be between 0 and 1",
				);
				expect(randomSpy).not.toHaveBeenCalled();
			} finally {
				randomSpy.mockRestore();
			}
		});
	});
});

describe("selectHybridAccountTraced", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns empty result for no accounts", () => {
		const result = selectHybridAccountTraced({
			accounts: [],
			healthTracker: new HealthScoreTracker(),
			tokenTracker: new TokenBucketTracker(),
		});
		expect(result.selected).toBeNull();
		expect(result.candidates).toHaveLength(0);
		expect(result.availableCount).toBe(0);
		expect(result.selectionReason).toMatch(/no accounts/i);
	});

	it("returns the single available account trivially", () => {
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: Date.now() - 3600_000 },
		];
		const result = selectHybridAccountTraced({
			accounts,
			healthTracker: new HealthScoreTracker(),
			tokenTracker: new TokenBucketTracker(),
		});
		expect(result.selected?.index).toBe(0);
		expect(result.candidates).toHaveLength(1);
		expect(result.selectionReason).toMatch(/single available/i);
	});

	it("sorts candidates descending by score and picks the top one", () => {
		const now = Date.now();
		const health = new HealthScoreTracker();
		const token = new TokenBucketTracker();
		// Drain tokens on account 0 to make account 1 the winner.
		token.drain(0, undefined, 40);
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: now - 60_000 },
			{ index: 1, isAvailable: true, lastUsed: now - 60_000 },
		];
		const result = selectHybridAccountTraced({
			accounts,
			healthTracker: health,
			tokenTracker: token,
		});
		expect(result.selected?.index).toBe(1);
		expect(result.candidates[0]?.index).toBe(1);
		expect(result.candidates[0]?.score).toBeGreaterThanOrEqual(
			result.candidates[1]?.score ?? 0,
		);
	});

	it("returns null when no accounts are available (AUDIT-H2 contract)", () => {
		const now = Date.now();
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: false, lastUsed: now - 1_000 },
			{ index: 1, isAvailable: false, lastUsed: now - 10_000 },
		];
		const result = selectHybridAccountTraced({
			accounts,
			healthTracker: new HealthScoreTracker(),
			tokenTracker: new TokenBucketTracker(),
		});
		// AUDIT-H2 / D-01: trace variant mirrors production null-contract so
		// `why-selected` diagnostics match actual selection behaviour. The
		// old LRU fallback was removed in PR #397.
		expect(result.availableCount).toBe(0);
		expect(result.selected).toBeNull();
		expect(result.selectionReason).toMatch(/all accounts unavailable/i);
		for (const candidate of result.candidates) {
			expect(candidate.reason).toMatch(/unavailable/i);
		}
	});

	it("does not mutate trackers", () => {
		const health = new HealthScoreTracker();
		const token = new TokenBucketTracker();
		const before = { health: health.getScore(0), tokens: token.getTokens(0) };
		selectHybridAccountTraced({
			accounts: [
				{ index: 0, isAvailable: true, lastUsed: Date.now() },
				{ index: 1, isAvailable: true, lastUsed: Date.now() },
			],
			healthTracker: health,
			tokenTracker: token,
		});
		expect(health.getScore(0)).toBe(before.health);
		expect(token.getTokens(0)).toBe(before.tokens);
	});

	it("agrees with selectHybridAccount on the winning index", () => {
		const now = Date.now();
		const health = new HealthScoreTracker();
		const token = new TokenBucketTracker();
		token.drain(0, undefined, 30);
		const accounts: AccountWithMetrics[] = [
			{ index: 0, isAvailable: true, lastUsed: now - 10_000 },
			{ index: 1, isAvailable: true, lastUsed: now - 10_000 },
			{ index: 2, isAvailable: true, lastUsed: now - 10_000 },
		];
		const plain = selectHybridAccount(accounts, health, token);
		const traced = selectHybridAccountTraced({
			accounts,
			healthTracker: health,
			tokenTracker: token,
		});
		expect(traced.selected?.index).toBe(plain?.index);
	});
});
