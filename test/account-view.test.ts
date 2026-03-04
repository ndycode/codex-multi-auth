import { describe, expect, it } from "vitest";
import {
	resolveActiveIndex,
	getRateLimitResetTimeForFamily,
	formatRateLimitEntry,
	formatActiveIndexByFamilyLabels,
	formatRateLimitStatusByFamily,
} from "../lib/accounts/account-view.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";

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
		const labels = formatActiveIndexByFamilyLabels({
			codex: 0,
			"gpt-5.1": 2,
		});
		const expected = MODEL_FAMILIES.map((family) => {
			if (family === "codex") return "codex: 1";
			if (family === "gpt-5.1") return "gpt-5.1: 3";
			return `${family}: -`;
		});
		expect(labels).toEqual(expected);
	});
});
