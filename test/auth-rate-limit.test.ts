import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	canAttemptAuth,
	recordAuthAttempt,
	getAttemptsRemaining,
	getTimeUntilReset,
	resetAuthRateLimit,
	resetAllAuthRateLimits,
	checkAuthRateLimit,
	AuthRateLimitError,
	configureAuthRateLimit,
	getAuthRateLimitConfig,
} from "../lib/auth-rate-limit.js";

describe("Auth rate limiting", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
		resetAllAuthRateLimits();
		configureAuthRateLimit({ maxAttempts: 5, windowMs: 60_000 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("canAttemptAuth", () => {
		it("should allow first attempt", () => {
			expect(canAttemptAuth("user@example.com")).toBe(true);
		});

		it("should allow attempts up to limit", () => {
			for (let i = 0; i < 4; i++) {
				recordAuthAttempt("user@example.com");
			}
			expect(canAttemptAuth("user@example.com")).toBe(true);
		});

		it("should deny after limit reached", () => {
			for (let i = 0; i < 5; i++) {
				recordAuthAttempt("user@example.com");
			}
			expect(canAttemptAuth("user@example.com")).toBe(false);
		});

		it("should be case insensitive", () => {
			for (let i = 0; i < 5; i++) {
				recordAuthAttempt("User@Example.COM");
			}
			expect(canAttemptAuth("user@example.com")).toBe(false);
		});
	});

	describe("recordAuthAttempt", () => {
		it("should record attempts", () => {
			expect(getAttemptsRemaining("user@test.com")).toBe(5);
			recordAuthAttempt("user@test.com");
			expect(getAttemptsRemaining("user@test.com")).toBe(4);
		});

		it("should track different accounts separately", () => {
			recordAuthAttempt("user1@test.com");
			recordAuthAttempt("user1@test.com");
			recordAuthAttempt("user2@test.com");

			expect(getAttemptsRemaining("user1@test.com")).toBe(3);
			expect(getAttemptsRemaining("user2@test.com")).toBe(4);
		});
	});

	describe("sliding window", () => {
		it("should expire old attempts", () => {
			recordAuthAttempt("user@test.com");
			recordAuthAttempt("user@test.com");

			vi.setSystemTime(new Date(61_000));

			expect(getAttemptsRemaining("user@test.com")).toBe(5);
			expect(canAttemptAuth("user@test.com")).toBe(true);
		});

		it("should allow new attempts after window expires", () => {
			for (let i = 0; i < 5; i++) {
				recordAuthAttempt("user@test.com");
			}
			expect(canAttemptAuth("user@test.com")).toBe(false);

			vi.setSystemTime(new Date(61_000));

			expect(canAttemptAuth("user@test.com")).toBe(true);
		});
	});

	describe("getTimeUntilReset", () => {
		it("should return 0 for new accounts", () => {
			expect(getTimeUntilReset("new@test.com")).toBe(0);
		});

		it("should return remaining window time", () => {
			recordAuthAttempt("user@test.com");
			vi.setSystemTime(new Date(30_000));

			expect(getTimeUntilReset("user@test.com")).toBe(30_000);
		});

		it("should return 0 after window expires", () => {
			recordAuthAttempt("user@test.com");
			vi.setSystemTime(new Date(61_000));

			expect(getTimeUntilReset("user@test.com")).toBe(0);
		});
	});

	describe("resetAuthRateLimit", () => {
		it("should clear attempts for specific account", () => {
			for (let i = 0; i < 5; i++) {
				recordAuthAttempt("user@test.com");
			}
			expect(canAttemptAuth("user@test.com")).toBe(false);

			resetAuthRateLimit("user@test.com");

			expect(canAttemptAuth("user@test.com")).toBe(true);
			expect(getAttemptsRemaining("user@test.com")).toBe(5);
		});
	});

	describe("resetAllAuthRateLimits", () => {
		it("should clear all accounts", () => {
			for (let i = 0; i < 5; i++) {
				recordAuthAttempt("user1@test.com");
				recordAuthAttempt("user2@test.com");
			}

			resetAllAuthRateLimits();

			expect(canAttemptAuth("user1@test.com")).toBe(true);
			expect(canAttemptAuth("user2@test.com")).toBe(true);
		});
	});

	describe("checkAuthRateLimit", () => {
		it("should not throw when under limit", () => {
			expect(() => checkAuthRateLimit("user@test.com")).not.toThrow();
		});

		it("should throw AuthRateLimitError when over limit", () => {
			for (let i = 0; i < 5; i++) {
				recordAuthAttempt("user@test.com");
			}

			expect(() => checkAuthRateLimit("user@test.com")).toThrow(AuthRateLimitError);
		});

		it("should include reset time in error", () => {
			for (let i = 0; i < 5; i++) {
				recordAuthAttempt("user@test.com");
			}

			try {
				checkAuthRateLimit("user@test.com");
				expect.fail("Should have thrown");
			} catch (e) {
				const error = e as AuthRateLimitError;
				expect(error.resetAfterMs).toBe(60_000);
				expect(error.attemptsRemaining).toBe(0);
			}
		});
	});

	describe("configureAuthRateLimit", () => {
		it("should update max attempts", () => {
			configureAuthRateLimit({ maxAttempts: 3 });

			for (let i = 0; i < 3; i++) {
				recordAuthAttempt("user@test.com");
			}

			expect(canAttemptAuth("user@test.com")).toBe(false);
		});

		it("should update window duration", () => {
			configureAuthRateLimit({ windowMs: 30_000 });

			recordAuthAttempt("user@test.com");
			vi.setSystemTime(new Date(31_000));

			expect(getAttemptsRemaining("user@test.com")).toBe(5);
		});

		it("should preserve other config values", () => {
			configureAuthRateLimit({ maxAttempts: 10 });
			const config = getAuthRateLimitConfig();

			expect(config.maxAttempts).toBe(10);
			expect(config.windowMs).toBe(60_000);
		});
	});

	describe("AuthRateLimitError", () => {
		it("should have correct name", () => {
			const error = new AuthRateLimitError("test@test.com", 0, 30_000);
			expect(error.name).toBe("AuthRateLimitError");
		});

		it("should include account and timing info", () => {
			const error = new AuthRateLimitError("test@test.com", 0, 30_000);
			expect(error.accountId).toBe("test@test.com");
			expect(error.attemptsRemaining).toBe(0);
			expect(error.resetAfterMs).toBe(30_000);
		});

		it("should have human-readable message", () => {
			const error = new AuthRateLimitError("test@test.com", 0, 30_000);
			expect(error.message).toContain("30s");
		});
	});
});
