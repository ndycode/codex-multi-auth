import { describe, expect, it, vi } from "vitest";
import { buildLoginMenuAccounts } from "../lib/runtime/login-menu-accounts.js";

describe("buildLoginMenuAccounts", () => {
	it("derives disabled, cooldown, rate-limited, and active statuses", () => {
		const now = 1_000;
		const formatRateLimitEntry = vi.fn((account) =>
			account.rateLimitResetTimes ? "resets in 1m" : null,
		);

		const result = buildLoginMenuAccounts(
			[
				{ email: "disabled@example.com", enabled: false },
				{ email: "cooldown@example.com", coolingDownUntil: now + 500 },
				{
					email: "limited@example.com",
					rateLimitResetTimes: { codex: now + 1_000 },
				},
				{ email: "active@example.com", enabled: true },
			],
			{
				now,
				activeIndex: 3,
				formatRateLimitEntry,
			},
		);

		expect(result.map((account) => account.status)).toEqual([
			"disabled",
			"cooldown",
			"rate-limited",
			"active",
		]);
		expect(result[3]).toMatchObject({
			email: "active@example.com",
			isCurrentAccount: true,
			enabled: true,
		});
		expect(result[0]).toMatchObject({
			email: "disabled@example.com",
			enabled: false,
		});
		expect(formatRateLimitEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "limited@example.com",
			}),
			now,
		);
	});

	it("marks healthy non-active accounts as ok", () => {
		const result = buildLoginMenuAccounts(
			[{ email: "ok@example.com", enabled: true }],
			{
				now: 1_000,
				activeIndex: 1,
				formatRateLimitEntry: () => null,
			},
		);

		expect(result).toEqual([
			expect.objectContaining({
				email: "ok@example.com",
				status: "ok",
				isCurrentAccount: false,
				enabled: true,
			}),
		]);
	});
});
