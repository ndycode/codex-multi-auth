import { describe, it, expect, beforeEach } from "vitest";
import * as fc from "fast-check";
import {
  HealthScoreTracker,
  TokenBucketTracker,
  selectHybridAccount,
  DEFAULT_HEALTH_SCORE_CONFIG,
  DEFAULT_TOKEN_BUCKET_CONFIG,
  type AccountWithMetrics,
} from "../../lib/rotation.js";
import { arbAccountIndex, arbQuotaKey } from "./helpers.js";

describe("HealthScoreTracker property tests", () => {
  let tracker: HealthScoreTracker;

  beforeEach(() => {
    tracker = new HealthScoreTracker();
  });

  it("score is always in [0, 100] range after any operation", () => {
    fc.assert(
      fc.property(
        arbAccountIndex,
        arbQuotaKey,
        fc.array(fc.constantFrom("success", "rateLimit", "failure"), { minLength: 1, maxLength: 50 }),
        (accountIndex, quotaKey, operations) => {
          const t = new HealthScoreTracker();
          for (const op of operations) {
            switch (op) {
              case "success":
                t.recordSuccess(accountIndex, quotaKey);
                break;
              case "rateLimit":
                t.recordRateLimit(accountIndex, quotaKey);
                break;
              case "failure":
                t.recordFailure(accountIndex, quotaKey);
                break;
            }
            const score = t.getScore(accountIndex, quotaKey);
            expect(score).toBeGreaterThanOrEqual(DEFAULT_HEALTH_SCORE_CONFIG.minScore);
            expect(score).toBeLessThanOrEqual(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
          }
          return true;
        }
      )
    );
  });

  it("recordSuccess never decreases score below current", () => {
    fc.assert(
      fc.property(arbAccountIndex, arbQuotaKey, (accountIndex, quotaKey) => {
        const t = new HealthScoreTracker();
        t.recordFailure(accountIndex, quotaKey);
        const scoreBefore = t.getScore(accountIndex, quotaKey);
        t.recordSuccess(accountIndex, quotaKey);
        const scoreAfter = t.getScore(accountIndex, quotaKey);
        expect(scoreAfter).toBeGreaterThanOrEqual(scoreBefore);
        return true;
      })
    );
  });

  it("recordFailure never increases score", () => {
    fc.assert(
      fc.property(arbAccountIndex, arbQuotaKey, (accountIndex, quotaKey) => {
        const t = new HealthScoreTracker();
        const scoreBefore = t.getScore(accountIndex, quotaKey);
        t.recordFailure(accountIndex, quotaKey);
        const scoreAfter = t.getScore(accountIndex, quotaKey);
        expect(scoreAfter).toBeLessThanOrEqual(scoreBefore);
        return true;
      })
    );
  });

  it("consecutiveFailures resets to 0 on success", () => {
    fc.assert(
      fc.property(
        arbAccountIndex,
        arbQuotaKey,
        fc.integer({ min: 1, max: 5 }),
        (accountIndex, quotaKey, failureCount) => {
          const t = new HealthScoreTracker();
          for (let i = 0; i < failureCount; i++) {
            t.recordFailure(accountIndex, quotaKey);
          }
          expect(t.getConsecutiveFailures(accountIndex, quotaKey)).toBe(failureCount);
          t.recordSuccess(accountIndex, quotaKey);
          expect(t.getConsecutiveFailures(accountIndex, quotaKey)).toBe(0);
          return true;
        }
      )
    );
  });

  it("fresh account has maximum health score", () => {
    fc.assert(
      fc.property(arbAccountIndex, arbQuotaKey, (accountIndex, quotaKey) => {
        const t = new HealthScoreTracker();
        const score = t.getScore(accountIndex, quotaKey);
        expect(score).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
        return true;
      })
    );
  });

  it("reset restores account to fresh state", () => {
    fc.assert(
      fc.property(arbAccountIndex, arbQuotaKey, (accountIndex, quotaKey) => {
        const t = new HealthScoreTracker();
        t.recordFailure(accountIndex, quotaKey);
        t.recordFailure(accountIndex, quotaKey);
        t.reset(accountIndex, quotaKey);
        expect(t.getScore(accountIndex, quotaKey)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
        expect(t.getConsecutiveFailures(accountIndex, quotaKey)).toBe(0);
        return true;
      })
    );
  });
});

describe("TokenBucketTracker property tests", () => {
  it("tokens never go negative", () => {
    fc.assert(
      fc.property(
        arbAccountIndex,
        arbQuotaKey,
        fc.integer({ min: 1, max: 100 }),
        (accountIndex, quotaKey, consumeAttempts) => {
          const t = new TokenBucketTracker();
          for (let i = 0; i < consumeAttempts; i++) {
            t.tryConsume(accountIndex, quotaKey);
            const tokens = t.getTokens(accountIndex, quotaKey);
            expect(tokens).toBeGreaterThanOrEqual(0);
          }
          return true;
        }
      )
    );
  });

  it("tryConsume returns false when bucket is empty", () => {
    fc.assert(
      fc.property(arbAccountIndex, arbQuotaKey, (accountIndex, quotaKey) => {
        const t = new TokenBucketTracker({ maxTokens: 5, tokensPerMinute: 0 });
        for (let i = 0; i < 5; i++) {
          expect(t.tryConsume(accountIndex, quotaKey)).toBe(true);
        }
        expect(t.tryConsume(accountIndex, quotaKey)).toBe(false);
        return true;
      })
    );
  });

  it("fresh bucket has maximum tokens", () => {
    fc.assert(
      fc.property(arbAccountIndex, arbQuotaKey, (accountIndex, quotaKey) => {
        const t = new TokenBucketTracker();
        const tokens = t.getTokens(accountIndex, quotaKey);
        expect(tokens).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
        return true;
      })
    );
  });

  it("drain reduces tokens but never below 0", () => {
    fc.assert(
      fc.property(
        arbAccountIndex,
        arbQuotaKey,
        fc.integer({ min: 1, max: 100 }),
        (accountIndex, quotaKey, drainAmount) => {
          const t = new TokenBucketTracker();
          t.drain(accountIndex, quotaKey, drainAmount);
          const tokens = t.getTokens(accountIndex, quotaKey);
          expect(tokens).toBeGreaterThanOrEqual(0);
          expect(tokens).toBeLessThanOrEqual(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
          return true;
        }
      )
    );
  });

  it("reset restores maximum tokens", () => {
    fc.assert(
      fc.property(arbAccountIndex, arbQuotaKey, (accountIndex, quotaKey) => {
        const t = new TokenBucketTracker();
        t.drain(accountIndex, quotaKey, 50);
        t.reset(accountIndex, quotaKey);
        expect(t.getTokens(accountIndex, quotaKey)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
        return true;
      })
    );
  });
});

describe("selectHybridAccount property tests", () => {
  const arbAccount = fc.record({
    index: arbAccountIndex,
    isAvailable: fc.boolean(),
    lastUsed: fc.integer({ min: 0, max: Date.now() }),
  });

  const arbAccounts = fc.array(arbAccount, { minLength: 1, maxLength: 10 });

  it("returns null only when accounts array is empty", () => {
    const healthTracker = new HealthScoreTracker();
    const tokenTracker = new TokenBucketTracker();
    const result = selectHybridAccount([], healthTracker, tokenTracker);
    expect(result).toBeNull();
  });

  it("returns a valid account from the input list", () => {
    fc.assert(
      fc.property(arbAccounts, arbQuotaKey, (accounts, quotaKey) => {
        const healthTracker = new HealthScoreTracker();
        const tokenTracker = new TokenBucketTracker();
        const result = selectHybridAccount(accounts, healthTracker, tokenTracker, quotaKey);
        if (result !== null) {
          const found = accounts.some((a) => a.index === result.index);
          expect(found).toBe(true);
        }
        return true;
      })
    );
  });

  it("prefers available accounts over unavailable ones", () => {
    fc.assert(
      fc.property(arbQuotaKey, (quotaKey) => {
        const accounts: AccountWithMetrics[] = [
          { index: 0, isAvailable: false, lastUsed: 0 },
          { index: 1, isAvailable: true, lastUsed: Date.now() },
        ];
        const healthTracker = new HealthScoreTracker();
        const tokenTracker = new TokenBucketTracker();
        const result = selectHybridAccount(accounts, healthTracker, tokenTracker, quotaKey);
        expect(result).not.toBeNull();
        expect(result!.index).toBe(1);
        return true;
      })
    );
  });

  it("returns least recently used when all unavailable", () => {
    const accounts: AccountWithMetrics[] = [
      { index: 0, isAvailable: false, lastUsed: 1000 },
      { index: 1, isAvailable: false, lastUsed: 500 },
      { index: 2, isAvailable: false, lastUsed: 2000 },
    ];
    const healthTracker = new HealthScoreTracker();
    const tokenTracker = new TokenBucketTracker();
    const result = selectHybridAccount(accounts, healthTracker, tokenTracker);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
  });

  it("selection is deterministic for same inputs", () => {
    fc.assert(
      fc.property(arbAccounts, arbQuotaKey, (accounts, quotaKey) => {
        const healthTracker1 = new HealthScoreTracker();
        const tokenTracker1 = new TokenBucketTracker();
        const healthTracker2 = new HealthScoreTracker();
        const tokenTracker2 = new TokenBucketTracker();

        const result1 = selectHybridAccount(accounts, healthTracker1, tokenTracker1, quotaKey);
        const result2 = selectHybridAccount(accounts, healthTracker2, tokenTracker2, quotaKey);

        if (result1 === null) {
          expect(result2).toBeNull();
        } else {
          expect(result2).not.toBeNull();
          expect(result1.index).toBe(result2!.index);
        }
        return true;
      })
    );
  });
});
