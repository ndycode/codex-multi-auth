import { describe, expect, it } from "vitest";
import {
	formatRateLimitEntry,
	getRateLimitResetTimeForFamily,
	resolveActiveIndex,
} from "../lib/runtime/account-status.js";

describe("account status helpers", () => {
	it("resolves active index using family overrides and clamps bounds", () => {
		expect(
			resolveActiveIndex(
				{
					activeIndex: 9,
					activeIndexByFamily: { codex: 1 },
					accounts: [1, 2, 3],
				},
				"codex",
			),
		).toBe(1);
		expect(
			resolveActiveIndex(
				{
					activeIndex: 9,
					activeIndexByFamily: { codex: 7 },
					accounts: [1, 2, 3],
				},
				"codex",
			),
		).toBe(2);
	});

	it("finds the soonest future reset for a family", () => {
		const now = 1_000;
		const account = {
			rateLimitResetTimes: {
				codex: 500,
				"codex:gpt-5-codex": 5_000,
				"codex:gpt-5.1": 2_000,
				"gpt-5.1": 9_000,
			},
		};

		expect(getRateLimitResetTimeForFamily(account, now, "codex")).toBe(2_000);
		expect(getRateLimitResetTimeForFamily(account, now, "gpt-5.1")).toBe(9_000);
	});

	it("formats rate limit entries with remaining wait time", () => {
		const entry = formatRateLimitEntry(
			{ rateLimitResetTimes: { codex: 5_000 } },
			1_000,
			(ms) => `${ms}ms`,
			"codex",
		);

		expect(entry).toBe("resets in 4000ms");
		expect(
			formatRateLimitEntry(
				{ rateLimitResetTimes: { codex: 500 } },
				1_000,
				() => "x",
			),
		).toBeNull();
	});
});
