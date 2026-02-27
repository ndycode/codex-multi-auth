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
		expect(result.reasons.some((reason) => reason.includes("primary quota"))).toBe(true);
	});

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

		expect(result.reasons.some((reason) => reason.includes("refresh warning:"))).toBe(true);
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
		expect(result.reasons.some((reason) => reason.includes("cooldown remaining"))).toBe(true);
		expect(result.reasons.some((reason) => reason.includes("rate limit resets in"))).toBe(true);
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
		expect(result.reasons.some((reason) => reason.includes("live probe returned 429"))).toBe(true);
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
			account: { refreshToken: "r70", addedAt: now - 1_000, lastUsed: now - 1_000 },
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
			account: { refreshToken: "r80", addedAt: now - 1_000, lastUsed: now - 1_000 },
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
			account: { refreshToken: "r90", addedAt: now - 1_000, lastUsed: now - 1_000 },
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
			account: { refreshToken: "r98", addedAt: now - 1_000, lastUsed: now - 1_000 },
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
		expect(recommendation.reason).toContain("No healthy accounts are available");
	});
});
