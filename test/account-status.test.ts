import { describe, expect, it } from "vitest";
import {
	formatRateLimitEntry,
	getAccountRecoveryTimeForFamily,
	getRateLimitResetTimeForFamily,
	resolveActiveIndex,
} from "../lib/runtime/account-status.js";
import {
	formatRateLimitEntry as formatRateLimitEntryFromBarrel,
	getRateLimitResetTimeForFamily as getRateLimitResetTimeForFamilyFromBarrel,
	resolveActiveIndex as resolveActiveIndexFromBarrel,
} from "../lib/runtime/account-state.js";

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

	it("re-exports account status helpers through the account-state barrel", () => {
		expect(resolveActiveIndexFromBarrel).toBe(resolveActiveIndex);
		expect(getRateLimitResetTimeForFamilyFromBarrel).toBe(
			getRateLimitResetTimeForFamily,
		);
		expect(formatRateLimitEntryFromBarrel).toBe(formatRateLimitEntry);

		expect(
			resolveActiveIndexFromBarrel(
				{
					activeIndex: 4,
					activeIndexByFamily: { codex: 1 },
					accounts: [1, 2, 3],
				},
				"codex",
			),
		).toBe(1);
		expect(
			getRateLimitResetTimeForFamilyFromBarrel(
				{ rateLimitResetTimes: { codex: 4_000 } },
				1_000,
				"codex",
			),
		).toBe(4_000);
		expect(
			formatRateLimitEntryFromBarrel(
				{ rateLimitResetTimes: { codex: 5_000 } },
				1_000,
				(ms) => `${ms}ms`,
				"codex",
			),
		).toBe("resets in 4000ms");
	});
});

describe("getAccountRecoveryTimeForFamily", () => {
	it("returns the LATEST gating reset so a retry lands after real recovery", () => {
		// Family-wide and requested-model records overlap: the account stays
		// skipped until the later one expires, so the earliest reset would
		// send a client straight back into a 503.
		expect(
			getAccountRecoveryTimeForFamily(
				{
					rateLimitResetTimes: {
						codex: 3_000,
						"codex:gpt-5-codex": 9_000,
					},
				},
				1_000,
				"codex",
				"gpt-5-codex",
			),
		).toBe(9_000);
	});

	it("ignores records that do not gate the request", () => {
		// Another model's record in the same family does not block this
		// request (selection checks only the family key and the requested
		// model's key), so it must not inflate the advertised recovery.
		expect(
			getAccountRecoveryTimeForFamily(
				{
					rateLimitResetTimes: {
						codex: 3_000,
						"codex:gpt-5.3-codex": 9_000,
					},
				},
				1_000,
				"codex",
				"gpt-5-codex",
			),
		).toBe(3_000);
		// Without a model only the family-wide key gates.
		expect(
			getAccountRecoveryTimeForFamily(
				{ rateLimitResetTimes: { "codex:gpt-5-codex": 9_000 } },
				1_000,
				"codex",
			),
		).toBeNull();
	});

	it("ignores other families and expired records", () => {
		expect(
			getAccountRecoveryTimeForFamily(
				{ rateLimitResetTimes: { "gpt-5.2": 9_000, codex: 500 } },
				1_000,
				"codex",
			),
		).toBeNull();
	});

	it("folds an active cooldown into the recovery moment", () => {
		expect(
			getAccountRecoveryTimeForFamily(
				{ rateLimitResetTimes: { codex: 3_000 }, coolingDownUntil: 7_000 },
				1_000,
				"codex",
			),
		).toBe(7_000);
		expect(
			getAccountRecoveryTimeForFamily(
				{ coolingDownUntil: 2_000 },
				1_000,
				"codex",
			),
		).toBe(2_000);
	});

	it("returns null when nothing bounds recovery", () => {
		expect(getAccountRecoveryTimeForFamily({}, 1_000, "codex")).toBeNull();
		expect(
			getAccountRecoveryTimeForFamily(
				{ coolingDownUntil: 900 },
				1_000,
				"codex",
			),
		).toBeNull();
	});
});
