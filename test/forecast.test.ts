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

	it("ignores a 99.6%-used sibling window when computing the exhausted wait", () => {
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
						// Genuinely exhausted, and it recovers in a minute.
						primary: { usedPercent: 100, resetAtMs: now + 60_000 },
						// 100 - 99.6 ROUNDS to 0 left, but this window still has quota
						// and its monthly reset is 28 days out. Selecting contributing
						// windows by the rounded left-percent would fold that in and
						// report a 28-day wait for an account that recovers in 60s.
						secondary: {
							usedPercent: 99.6,
							resetAtMs: now + 28 * 86_400_000,
						},
					},
				},
				byEmail: {},
			},
		});

		expect(result.availability).toBe("delayed");
		expect(result.waitMs).toBe(60_000);
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

	it.each(["circuit-open", "token-exhausted", "workspace-disabled"])(
		"marks non-time-bounded runtime skip reason %s as unavailable",
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

	it("ignores a stale rate-limited overlay when no rate limit is active on disk", () => {
		const now = 1_700_000_000_000;
		const account = {
			refreshToken: "refresh-1",
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
			// Expired entry: clearExpiredRateLimits-equivalent semantics mean this
			// is no longer an active rate limit.
			rateLimitResetTimes: { codex: now - 30_000 },
		};
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "rate-limited" },
			},
		});

		expect(result.availability).toBe("ready");
		expect(result.reasons).not.toContain("runtime skip: rate-limited");
	});

	it("ignores a stale rate-limited overlay when rateLimitResetTimes is absent", () => {
		const now = 1_700_000_000_000;
		const account = {
			refreshToken: "refresh-1",
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
			// No rateLimitResetTimes field at all: the limit was cleared (runtime
			// reset or a successful request) after the overlay was written.
		};
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "rate-limited" },
			},
		});

		expect(result.availability).toBe("ready");
		expect(result.reasons).not.toContain("runtime skip: rate-limited");
	});

	it("ignores a stale overlay reason resolved from accountSkipReasons (precedence path)", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				// No active rate limit or cooldown on disk.
			},
			runtimeOverlay: {
				// accountSkipReasons takes precedence over
				// lastPoolExhaustionSkipReasons in the resolver; the staleness guard
				// must apply to whichever key wins.
				accountSkipReasons: { "0": "rate-limited" },
				lastPoolExhaustionSkipReasons: { "0": "cooling-down:server-error" },
			},
		});

		expect(result.availability).toBe("ready");
		expect(result.reasons).not.toContain("runtime skip: rate-limited");
		expect(result.reasons).not.toContain(
			"runtime skip: cooling-down:server-error",
		);
	});

	it("applies an active overlay reason resolved from accountSkipReasons (precedence path)", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				rateLimitResetTimes: { codex: now + 30_000 },
			},
			runtimeOverlay: {
				accountSkipReasons: { "0": "rate-limited" },
			},
		});

		expect(result.availability).toBe("unavailable");
		expect(result.reasons).toContain("runtime skip: rate-limited");
	});

	it("applies a rate-limited overlay when the rate limit is still active on disk", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				rateLimitResetTimes: { codex: now + 30_000 },
			},
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "rate-limited" },
			},
		});

		expect(result.availability).toBe("unavailable");
		expect(result.reasons).toContain("runtime skip: rate-limited");
	});

	it("applies a rate-limited overlay when a model-scoped limit is active on disk", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				rateLimitResetTimes: { "codex:5h": now + 30_000 },
			},
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "rate-limited" },
			},
		});

		expect(result.availability).toBe("unavailable");
		expect(result.reasons).toContain("runtime skip: rate-limited");
	});

	it("ignores a stale cooling-down overlay when cooldown has elapsed on disk", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				coolingDownUntil: now - 1,
			},
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "cooling-down:server-error" },
			},
		});

		expect(result.availability).toBe("ready");
		expect(result.reasons).not.toContain(
			"runtime skip: cooling-down:server-error",
		);
	});

	it("ignores a stale cooling-down overlay when coolingDownUntil is absent", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				// No coolingDownUntil field at all: cooldown cleared after the
				// overlay was written.
			},
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "cooling-down:server-error" },
			},
		});

		expect(result.availability).toBe("ready");
		expect(result.reasons).not.toContain(
			"runtime skip: cooling-down:server-error",
		);
	});

	it("applies a cooling-down overlay when cooldown is still active on disk", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-1",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
				coolingDownUntil: now + 60_000,
			},
			runtimeOverlay: {
				lastPoolExhaustionSkipReasons: { "0": "cooling-down:server-error" },
			},
		});

		expect(result.availability).toBe("unavailable");
		expect(result.reasons).toContain("runtime skip: cooling-down:server-error");
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

	it("does not delay a 99.6%-used live window whose reset is still in the future", () => {
		const now = 1_700_000_000_000;
		const result = evaluateForecastAccount({
			index: 2,
			now,
			isCurrent: false,
			account: {
				refreshToken: "refresh-99",
				addedAt: now - 10_000,
				lastUsed: now - 10_000,
			},
			liveQuota: {
				status: 200,
				model: "gpt-5-codex",
				// 100 - 99.6 ROUNDS to 0% left, but the window is not exhausted: it
				// still has quota. The live-wait filter must test the raw usedPercent,
				// otherwise this future reset is folded in as a wait and a usable
				// account is pushed to "delayed".
				primary: {
					usedPercent: 99.6,
					windowMinutes: 300,
					resetAtMs: now + 600_000,
				},
				secondary: {
					usedPercent: 10,
					windowMinutes: 10080,
					resetAtMs: now + 1_800_000,
				},
			},
		});

		expect(result.availability).toBe("ready");
		expect(result.waitMs).toBe(0);
		expect(result.exhausted).toBe(false);
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
	it("H5: live-quota wait reflects only the exhausted window, not a healthy 7d secondary", () => {
		const now = 1_700_000_000_000;
		const account = {
			refreshToken: "refresh-1",
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
		};
		// Binding 5h primary is fully exhausted but frees in 90s; the weekly
		// secondary is healthy (55% used) with its normal ~7d reset. The reported
		// wait must track the 90s window, not the 7d one.
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
			allAccounts: [account],
			liveQuota: {
				status: 200,
				model: "gpt-5.3-codex",
				primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: now + 90_000 },
				secondary: {
					usedPercent: 55,
					windowMinutes: 10_080,
					resetAtMs: now + 7 * 24 * 60 * 60 * 1000,
				},
			},
		});
		// Before the fix this returned the 7d secondary reset (~604_800_000ms).
		expect(result.waitMs).toBe(90_000);
	});

	it("H5: recommends the account that actually frees first under live-quota pressure", () => {
		const now = 1_700_000_000_000;
		const mk = (id: string) => ({
			accountId: id,
			email: id + "@example.com",
			refreshToken: "rt-" + id,
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
		});
		const a = mk("a");
		const b = mk("b");
		const all = [a, b];
		// a: binding window frees in 90s, healthy secondary 7d out.
		// b: binding window frees in 10min, healthy secondary 7d out.
		// a should be recommended (frees first); the 7d secondary must not invert it.
		const results = evaluateForecastAccounts([
			{
				index: 0, now, isCurrent: false, account: a, allAccounts: all,
				liveQuota: {
					status: 200, model: "gpt-5.3-codex",
					primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: now + 90_000 },
					secondary: { usedPercent: 50, windowMinutes: 10_080, resetAtMs: now + 7 * 24 * 60 * 60 * 1000 },
				},
			},
			{
				index: 1, now, isCurrent: false, account: b, allAccounts: all,
				liveQuota: {
					status: 200, model: "gpt-5.3-codex",
					primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: now + 600_000 },
					secondary: { usedPercent: 50, windowMinutes: 10_080, resetAtMs: now + 7 * 24 * 60 * 60 * 1000 },
				},
			},
		]);
		expect(results[0].waitMs).toBe(90_000);
		expect(results[1].waitMs).toBe(600_000);
	});

	it("flags a live 200 probe at 100% used with no resetAtMs as exhausted, not ready", () => {
		const now = 1_700_000_000_000;
		const account = {
			refreshToken: "refresh-1",
			addedAt: now - 10_000,
			lastUsed: now - 10_000,
		};
		// The upstream reported the primary window 100% used but omitted resetAtMs.
		// getLiveQuotaWaitMs yields 0 (nothing to wait on) and the 429 branch never
		// fires on a 200, so before the fix this stayed "ready" and could be
		// recommended as the best account despite being fully exhausted.
		const result = evaluateForecastAccount({
			index: 0,
			now,
			isCurrent: false,
			account,
			allAccounts: [account],
			liveQuota: {
				status: 200,
				model: "gpt-5.3-codex",
				primary: { usedPercent: 100, windowMinutes: 300 },
				secondary: {
					usedPercent: 20,
					windowMinutes: 10080,
					resetAtMs: now + 300_000,
				},
			},
		});

		expect(result.availability).not.toBe("ready");
		expect(result.exhausted).toBe(true);

		// The HIGH-severity concern: such an account must not be recommended as a
		// healthy pick. As the only account it yields a null recommendation.
		const recommendation = recommendForecastAccount([result]);
		expect(recommendation.recommendedIndex).toBeNull();
		expect(recommendation.reason).toContain("blocked or exhausted");
	});

});
