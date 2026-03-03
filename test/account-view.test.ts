import { describe, expect, it } from "vitest";
import {
	resolveActiveIndex,
	getRateLimitResetTimeForFamily,
	formatRateLimitEntry,
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
});
