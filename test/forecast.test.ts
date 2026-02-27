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
});
