import { describe, expect, it } from "vitest";
import {
	evaluateForecastAccount,
	evaluateForecastAccounts,
	isHardRefreshFailure,
	recommendForecastAccount,
	summarizeForecast,
} from "../lib/forecast.js";

describe("forecast helpers", () => {
	it("marks disabled account as unavailable high risk", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
				enabled: false,
			},
		});

		expect(result.availability).toBe("unavailable");
		expect(result.riskLevel).toBe("high");
		expect(result.disabled).toBe(true);
	});

	it("detects hard refresh failures", () => {
		expect(
			isHardRefreshFailure({
				type: "failed",
				reason: "missing_refresh",
			}),
		).toBe(true);

		expect(
			isHardRefreshFailure({
				type: "failed",
				reason: "http_error",
				statusCode: 400,
				message: "invalid_grant: token revoked",
			}),
		).toBe(true);

		expect(
			isHardRefreshFailure({
				type: "failed",
				reason: "network_error",
				message: "timeout",
			}),
		).toBe(false);
	});

	it("raises risk when live quota usage is very high", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: true,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
			},
			liveQuota: {
				status: 200,
				model: "gpt-5-codex",
				primary: { usedPercent: 95, windowMinutes: 180 },
				secondary: { usedPercent: 20, windowMinutes: 1440 },
			},
		});

		expect(result.riskScore).toBeGreaterThanOrEqual(30);
		expect(
			result.reasons.some((reason) => reason.includes("primary quota")),
		).toBe(true);
	});

	it("marks quota-cache exhausted accounts as delayed instead of ready", () => {
		const now = 1_700_000_000_000;
		const account = {
			email: "quota@example.com",
			accountId: "acc_quota",
			refreshToken: "refresh-1",
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
		};
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
			allAccounts: [account],
			quotaCache: {
				version: 1,
				updatedAt: now,
				byAccountId: {
					acc_quota: {
						accountId: "acc_quota",
						status: 200,
						model: "gpt-5.3-codex",
						updatedAt: now,
						primary: { usedPercent: 100, resetAtMs: now + 60_000 },
						secondary: { usedPercent: 25, resetAtMs: now + 300_000 },
					},
				},
				byEmail: {},
			},
		});

		expect(result.availability).toBe("delayed");
		expect(result.waitMs).toBe(60_000);
		expect(result.reasons).toContain("quota cache exhausted");
	});

	it("waits for the later quota reset when both cached windows are exhausted", () => {
		const now = 1_700_000_000_000;
		const account = {
			email: "quota@example.com",
			accountId: "acc_quota",
			refreshToken: "refresh-1",
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
		};
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
			allAccounts: [account],
			quotaCache: {
				version: 1,
				updatedAt: now,
				byAccountId: {
					acc_quota: {
						accountId: "acc_quota",
						status: 200,
						model: "gpt-5.3-codex",
						updatedAt: now,
						primary: { usedPercent: 100, resetAtMs: now + 60_000 },
						secondary: { usedPercent: 100, resetAtMs: now + 300_000 },
					},
				},
				byEmail: {},
			},
		});

		expect(result.availability).toBe("delayed");
		expect(result.waitMs).toBe(300_000);
		expect(result.reasons).toEqual(
			expect.arrayContaining(["quota cache exhausted", "quota resets in 5m 0s"]),
		);
	});

	it("applies runtime overlay skip reasons to forecast availability", () => {
		const now = 1_700_000_000_000;
		const account = {
			refreshToken: "refresh-1",
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
		};
		const raw = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
		});
		const overlaid = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "circuit-open" },
			},
		});

		expect(raw.availability).toBe("ready");
		expect(overlaid.availability).toBe("unavailable");
		expect(overlaid.reasons).toContain("runtime skip: circuit-open");
	});

	it.each(["rate-limited", "cooling-down:server-error", "workspace-disabled"])(
		"marks runtime skip reason %s as unavailable",
		(reason) => {
			const now = 1_700_000_000_000;
			const result = evaluateForecastAccount({
				index: 0,
				now,
				isCurrent: false,
				account: {
					refreshToken: "refresh-1",
					addedAt: now - 10_000,
					lastUsed: now - 10_000,
				},
				runtimeOverlay: {
					lastPoolExhaustionSkipReasons: { "0": reason },
				},
			});

			expect(result.availability).toBe("unavailable");
			expect(result.reasons).toContain(`runtime skip: ${reason}`);
		},
	);

	it("recommends the best ready account", () => {
		const now = 1_700_000_000_000;
		const results = evaluateForecastAccounts([
			{
				index: 0,
				now,
				isCurrent: true,
				account: {
					refreshToken: "refresh-1",
					addedAt: now - 100_000,
					lastUsed: now - 100_000,
					coolingDownUntil: now + 60_000,
				},
			},
			{
				index: 1,
				now,
				isCurrent: false,
				account: {
					refreshToken: "refresh-2",
					addedAt: now - 100_000,
					lastUsed: now - 10_000,
				},
			},
		]);

		const recommendation = recommendForecastAccount(results);
		expect(recommendation.recommendedIndex).toBe(1);
		expect(recommendation.reason).toContain("Lowest risk ready account");

		const summary = summarizeForecast(results);
		expect(summary.total).toBe(2);
		expect(summary.ready).toBe(1);
		expect(summary.delayed).toBe(1);
	});

	it("redacts sensitive refresh warning details", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			refreshFailure: {
				type: "failed",
				reason: "http_error",
				statusCode: 400,
				message:
					"Bearer verysecrettoken12345 for user@example.com with key sk-1234567890abcdef",
			},
		});

		expect(
			result.reasons.some((reason) => reason.includes("refresh warning:")),
		).toBe(true);
		expect(result.reasons.join(" ")).not.toContain("user@example.com");
		expect(result.reasons.join(" ")).not.toContain("verysecrettoken12345");
		expect(result.reasons.join(" ")).not.toContain("sk-1234567890abcdef");
		expect(result.riskLevel).toBe("low");
	});

	it("marks hard refresh failure as unavailable", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 1,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-2",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			refreshFailure: {
				type: "failed",
				reason: "http_error",
				statusCode: 401,
				message: "invalid_grant",
			},
		});

		expect(result.availability).toBe("unavailable");
		expect(result.hardFailure).toBe(true);
		expect(result.riskLevel).toBe("high");
	});

	it("uses max of cooldown and rate-limit wait for delayed availability", () => {
		const now = 1_700_000_000_000;
		const cooldownMs = 90_000;
		const rateLimitMs = 120_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: true,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				coolingDownUntil: now + cooldownMs,
				rateLimitResetTimes: {
					codex: now + rateLimitMs,
					"other-family": now + 999_999,
				},
			},
		});

		expect(result.availability).toBe("delayed");
		expect(result.waitMs).toBe(rateLimitMs);
		expect(
			result.reasons.some((reason) => reason.includes("cooldown remaining")),
		).toBe(true);
		expect(
			result.reasons.some((reason) => reason.includes("rate limit resets in")),
		).toBe(true);
	});

	it("marks delayed on live 429 and tracks quota reset wait", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 2,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-3",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
			},
			liveQuota: {
				status: 429,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 50,
					windowMinutes: 300,
					resetAtMs: now + 30_000,
				},
				secondary: {
					usedPercent: 30,
					windowMinutes: 10080,
					resetAtMs: now + 120_000,
				},
			},
		});

		expect(result.availability).toBe("delayed");
		expect(result.waitMs).toBe(120_000);
		expect(
			result.reasons.some((reason) =>
				reason.includes("live probe returned 429"),
			),
		).toBe(true);
	});

	it("does not delay healthy accounts only because quota reset headers exist", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 2,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-3",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
			},
			liveQuota: {
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 20,
					windowMinutes: 300,
					resetAtMs: now + 120_000,
				},
				secondary: {
					usedPercent: 10,
					windowMinutes: 10080,
					resetAtMs: now + 180_000,
				},
			},
		});

		expect(result.availability).toBe("ready");
		expect(result.waitMs).toBe(0);
	});

	it("prefers refresh failure reason code over raw message text", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			refreshFailure: {
				type: "failed",
				reason: "http_error",
				statusCode: 400,
				message: "invalid for user@example.com",
			},
		});

		expect(result.reasons.join(" ")).toContain("http_error (400)");
		expect(result.reasons.join(" ")).not.toContain("user@example.com");
	});

	it("applies higher risk at higher quota usage thresholds", () => {
		const now = 1_700_000_000_000;
		const scoreAt70 = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "r70",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			liveQuota: {
				status: 200,
				model: "gpt-5-codex",
				primary: { usedPercent: 70, windowMinutes: 300 },
				secondary: { usedPercent: 0, windowMinutes: 10080 },
			},
		}).riskScore;
		const scoreAt80 = evaluateForecastAccount({
			index: 1,
			now,
			isCurrent: false,
			account: {
				refreshToken: "r80",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			liveQuota: {
				status: 200,
				model: "gpt-5-codex",
				primary: { usedPercent: 80, windowMinutes: 300 },
				secondary: { usedPercent: 0, windowMinutes: 10080 },
			},
		}).riskScore;
		const scoreAt90 = evaluateForecastAccount({
			index: 2,
			now,
			isCurrent: false,
			account: {
				refreshToken: "r90",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			liveQuota: {
				status: 200,
				model: "gpt-5-codex",
				primary: { usedPercent: 90, windowMinutes: 300 },
				secondary: { usedPercent: 0, windowMinutes: 10080 },
			},
		}).riskScore;
		const scoreAt98 = evaluateForecastAccount({
			index: 3,
			now,
			isCurrent: false,
			account: {
				refreshToken: "r98",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			liveQuota: {
				status: 200,
				model: "gpt-5-codex",
				primary: { usedPercent: 98, windowMinutes: 300 },
				secondary: { usedPercent: 0, windowMinutes: 10080 },
			},
		}).riskScore;

		expect(scoreAt80).toBeGreaterThan(scoreAt70);
		expect(scoreAt90).toBeGreaterThan(scoreAt80);
		expect(scoreAt98).toBeGreaterThan(scoreAt90);
	});

	it("adds stale-age risk penalties for invalid and old usage timestamps", () => {
		const now = 1_700_000_000_000;
		const fresh = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "fresh",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
		});
		const old = evaluateForecastAccount({
			index: 1,
			now,
			isCurrent: false,
			account: {
				refreshToken: "old",
				addedAt: now - 1_000,
				lastUsed: now - 8 * 24 * 60 * 60 * 1000,
			},
		});
		const future = evaluateForecastAccount({
			index: 2,
			now,
			isCurrent: false,
			account: {
				refreshToken: "future",
				addedAt: now - 1_000,
				lastUsed: now + 60_000,
			},
		});

		expect(old.riskScore).toBeGreaterThan(fresh.riskScore);
		expect(future.riskScore).toBeGreaterThanOrEqual(fresh.riskScore + 5);
	});

	it("returns delayed recommendation when no account is immediately ready", () => {
		const now = 1_700_000_000_000;
		const results = evaluateForecastAccounts([
			{
				index: 0,
				now,
				isCurrent: false,
				account: {
					refreshToken: "a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					coolingDownUntil: now + 90_000,
				},
			},
			{
				index: 1,
				now,
				isCurrent: true,
				account: {
					refreshToken: "b",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					rateLimitResetTimes: { codex: now + 30_000 },
				},
			},
		]);

		const recommendation = recommendForecastAccount(results);
		expect(recommendation.recommendedIndex).not.toBeNull();
		expect(recommendation.reason).toContain("No account is immediately ready");
	});

	it("uses redacted fallback refresh messages when reason code is blank", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "r1",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
			},
			refreshFailure: {
				type: "failed",
				reason: "   ",
				message:
					"Bearer supersecrettoken123 for dev@example.com using key sk-1234567890abcdef",
			},
		});

		const joined = result.reasons.join(" ");
		expect(joined).toContain("refresh warning:");
		expect(joined).toContain("Bearer ***");
		expect(joined).not.toContain("dev@example.com");
		expect(joined).not.toContain("supersecrettoken123");
		expect(joined).not.toContain("sk-1234567890abcdef");
	});

	it("uses codex-family reset keys and ignores stale or invalid entries", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 1,
			now,
			isCurrent: false,
			account: {
				refreshToken: "r2",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
				rateLimitResetTimes: {
					codex: now - 10,
					"codex:5h": now + 60_000,
					"codex:7d": "bad" as unknown as number,
					"other-family": now + 5_000,
				},
			},
		});

		expect(result.availability).toBe("delayed");
		expect(result.waitMs).toBe(60_000);
	});

	it("keeps unavailable state when live quota returns 429 on an unavailable account", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 2,
			now,
			isCurrent: false,
			account: {
				refreshToken: "r3",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
				enabled: false,
			},
			liveQuota: {
				status: 429,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 95,
					windowMinutes: 300,
					resetAtMs: now + 30_000,
				},
				secondary: {
					usedPercent: 0,
					windowMinutes: 10080,
					resetAtMs: now + 5_000,
				},
			},
		});

		expect(result.availability).toBe("unavailable");
		expect(
			result.reasons.some((reason) =>
				reason.includes("live probe returned 429"),
			),
		).toBe(true);
	});

	it("breaks delayed recommendation ties in favor of the current account", () => {
		const now = 1_700_000_000_000;
		const results = evaluateForecastAccounts([
			{
				index: 5,
				now,
				isCurrent: false,
				account: {
					refreshToken: "x",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					coolingDownUntil: now + 45_000,
				},
			},
			{
				index: 3,
				now,
				isCurrent: true,
				account: {
					refreshToken: "y",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					coolingDownUntil: now + 45_000,
				},
			},
		]);

		const recommendation = recommendForecastAccount(results);
		expect(recommendation.recommendedIndex).toBe(3);
	});

	it("returns null recommendation when all candidates are disabled or hard-failed", () => {
		const now = 1_700_000_000_000;
		const results = evaluateForecastAccounts([
			{
				index: 0,
				now,
				isCurrent: true,
				account: {
					refreshToken: "a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: false,
				},
			},
			{
				index: 1,
				now,
				isCurrent: false,
				account: {
					refreshToken: "b",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
				refreshFailure: {
					type: "failed",
					reason: "http_error",
					statusCode: 401,
					message: "invalid refresh token",
				},
			},
		]);

		const recommendation = recommendForecastAccount(results);
		expect(recommendation.recommendedIndex).toBeNull();
		expect(recommendation.reason).toContain(
			"No healthy accounts are available",
		);
	});

	it("returns null recommendation when all accounts are policy-blocked/exhausted", () => {
		// Blocked/exhausted accounts report availability === "unavailable" with
		// hardFailure === false and disabled === false. They must not be
		// recommended with a misleading "pick shortest wait".
		const now = 1_700_000_000_000;
		const results = evaluateForecastAccounts([
			{
				index: 0,
				now,
				isCurrent: true,
				account: {
					refreshToken: "a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
				runtimeOverlay: { policyBlockedIndexes: [0] },
			},
			{
				index: 1,
				now,
				isCurrent: false,
				account: {
					refreshToken: "b",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
				runtimeOverlay: {
					lastPoolExhaustionSkipReasons: { "1": "token-exhausted" },
				},
			},
		]);

		// Sanity: both are unavailable but neither disabled nor hard-failed.
		expect(results.every((r) => r.availability === "unavailable")).toBe(true);
		expect(results.every((r) => !r.disabled && !r.hardFailure)).toBe(true);

		const recommendation = recommendForecastAccount(results);
		expect(recommendation.recommendedIndex).toBeNull();
		expect(recommendation.reason).toContain("blocked or exhausted");
	});

	it("returns null recommendation when all accounts are quota-exhausted", () => {
		// Quota-exhausted accounts are classified availability === "delayed" (not
		// "unavailable") so display/sorting still treat them as a timed wait. The
		// recommendation must still return null instead of a misleading "pick
		// shortest wait" when every account in the pool is exhausted.
		const now = 1_700_000_000_000;
		const accounts = [
			{
				email: "a@example.com",
				accountId: "acc_a",
				refreshToken: "refresh-a",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
			},
			{
				email: "b@example.com",
				accountId: "acc_b",
				refreshToken: "refresh-b",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
			},
		];
		const quotaCache = {
			version: 1 as const,
			updatedAt: now,
			byAccountId: {
				acc_a: {
					accountId: "acc_a",
					status: 200,
					model: "gpt-5.3-codex",
					updatedAt: now,
					primary: { usedPercent: 100, resetAtMs: now + 60_000 },
					secondary: { usedPercent: 100, resetAtMs: now + 120_000 },
				},
				acc_b: {
					accountId: "acc_b",
					status: 200,
					model: "gpt-5.3-codex",
					updatedAt: now,
					primary: { usedPercent: 100, resetAtMs: now + 90_000 },
					secondary: { usedPercent: 100, resetAtMs: now + 180_000 },
				},
			},
			byEmail: {},
		};
		const results = evaluateForecastAccounts([
			{ index: 0, now, isCurrent: true, account: accounts[0], allAccounts: accounts, quotaCache },
			{ index: 1, now, isCurrent: false, account: accounts[1], allAccounts: accounts, quotaCache },
		]);

		// Sanity: both are "delayed" + exhausted, neither disabled nor hard-failed.
		expect(results.every((r) => r.availability === "delayed")).toBe(true);
		expect(results.every((r) => r.exhausted)).toBe(true);
		expect(results.every((r) => !r.disabled && !r.hardFailure)).toBe(true);

		const recommendation = recommendForecastAccount(results);
		expect(recommendation.recommendedIndex).toBeNull();
		expect(recommendation.reason).toContain("blocked or exhausted");
	});
});
