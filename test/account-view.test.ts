import { describe, expect, it } from "vitest";
import {
	resolveActiveIndex,
	getRateLimitResetTimeForFamily,
	formatRateLimitEntry,
	formatActiveIndexByFamilyLabels,
	formatRateLimitStatusByFamily,
} from "../lib/accounts/account-view.js";

describe("account-view helpers", () => {
	it("resolves active index from family mapping and clamps to bounds", () => {
		expect(
			resolveActiveIndex({
				activeIndex: 9,
				activeIndexByFamily: { codex: 4 },
				accounts: [{}, {}],
			}),
		).toBe(1);
	});

	it("falls back to storage active index and normalizes non-finite candidates", () => {
		expect(
			resolveActiveIndex({
				activeIndex: 5,
				activeIndexByFamily: { codex: 3 },
				accounts: [],
			}),
		).toBe(0);
		expect(
			resolveActiveIndex({
				activeIndex: Number.NaN,
				activeIndexByFamily: { codex: Number.NaN },
				accounts: [{}, {}, {}],
			}),
		).toBe(0);
		expect(
			resolveActiveIndex({
				activeIndex: 2,
				accounts: [{}, {}, {}],
			}),
		).toBe(2);
	});

	it("coerces fractional active indexes to bounded integers", () => {
		const resolved = resolveActiveIndex({
			activeIndex: 1.8,
			activeIndexByFamily: { codex: 1.2 },
			accounts: [{}, {}],
		});
		expect(resolved).toBe(1);
		expect(Number.isInteger(resolved)).toBe(true);
	});

	it("returns earliest future reset for matching family keys", () => {
		const now = 1_000_000;
		expect(
			getRateLimitResetTimeForFamily(
				{
					rateLimitResetTimes: {
						codex: now + 90_000,
						"codex:gpt-5.2": now + 30_000,
						"gpt-5.1": now + 10_000,
						"codex:bad": undefined,
					},
				},
				now,
				"codex",
			),
		).toBe(now + 30_000);
	});

	it("ignores non-finite reset timestamps when selecting family reset times", () => {
		const now = 20_000;
		expect(
			getRateLimitResetTimeForFamily(
				{
					rateLimitResetTimes: {
						codex: Number.NaN,
						"codex:gpt-5.2": Number.POSITIVE_INFINITY,
						"codex:gpt-5.1": Number.NEGATIVE_INFINITY,
						"codex:gpt-5.3": now + 4_000,
					},
				},
				now,
				"codex",
			),
		).toBe(now + 4_000);
		expect(
			formatRateLimitEntry(
				{
					rateLimitResetTimes: {
						codex: Number.NaN,
						"codex:gpt-5.2": Number.POSITIVE_INFINITY,
						"codex:gpt-5.1": Number.NEGATIVE_INFINITY,
						"codex:gpt-5.3": now + 4_000,
					},
				},
				now,
				"codex",
			),
		).toBe("resets in 4s");
	});

	it("returns null for missing or expired family reset state", () => {
		const now = 5_000;
		expect(getRateLimitResetTimeForFamily({}, now, "codex")).toBeNull();
		expect(
			getRateLimitResetTimeForFamily(
				{
					rateLimitResetTimes: {
						codex: now,
						"codex:gpt-5.2": now - 1,
					},
				},
				now,
				"codex",
			),
		).toBeNull();
	});

	it("formats wait labels only when a positive reset window exists", () => {
		const now = 42_000;
		expect(
			formatRateLimitEntry(
				{
					rateLimitResetTimes: {
						codex: now + 90_000,
					},
				},
				now,
			),
		).toBe("resets in 1m 30s");
		expect(
			formatRateLimitEntry(
				{
					rateLimitResetTimes: {
						codex: now,
					},
				},
				now,
			),
		).toBeNull();
	});

	it("formats model-family status labels with ok and remaining times", () => {
		const now = 1_000_000;
		expect(
			formatRateLimitStatusByFamily(
				{
					rateLimitResetTimes: {
						codex: now + 30_000,
						"gpt-5.1": now + 70_000,
					},
				},
				now,
				["codex", "gpt-5.1", "codex-max"],
			),
		).toEqual(["codex=30s", "gpt-5.1=1m 10s", "codex-max=ok"]);
	});

	it("formats active-index labels with 1-based values and fallback placeholders", () => {
		expect(
			formatActiveIndexByFamilyLabels({
				codex: 0,
				"gpt-5.1": 2,
			}),
		).toEqual([
			"gpt-5-codex: -",
			"codex-max: -",
			"codex: 1",
			"gpt-5.2: -",
			"gpt-5.1: 3",
		]);
	});
});
