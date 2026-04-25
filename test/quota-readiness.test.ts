import { describe, expect, it } from "vitest";
import { isQuotaCacheEntryExhausted } from "../lib/quota-readiness.js";

describe("quota readiness", () => {
	it("treats either exhausted quota window as unavailable", () => {
		expect(
			isQuotaCacheEntryExhausted({
				primary: { usedPercent: 100, windowMinutes: 300 },
				secondary: { usedPercent: 20, windowMinutes: 10080 },
			}),
		).toBe(true);
		expect(
			isQuotaCacheEntryExhausted({
				primary: { usedPercent: 20, windowMinutes: 300 },
				secondary: { usedPercent: 100, windowMinutes: 10080 },
			}),
		).toBe(true);
	});

	it("keeps accounts available when both known windows have quota left", () => {
		expect(
			isQuotaCacheEntryExhausted({
				primary: { usedPercent: 99, windowMinutes: 300 },
				secondary: { usedPercent: 99, windowMinutes: 10080 },
			}),
		).toBe(false);
	});

	it("does not treat expired quota windows as exhausted", () => {
		const now = 10_000;
		expect(
			isQuotaCacheEntryExhausted(
				{
					primary: {
						usedPercent: 100,
						windowMinutes: 300,
						resetAtMs: now - 1,
					},
					secondary: { usedPercent: 20, windowMinutes: 10080 },
				},
				now,
			),
		).toBe(false);
		expect(
			isQuotaCacheEntryExhausted(
				{
					primary: { usedPercent: 20, windowMinutes: 300 },
					secondary: {
						usedPercent: 100,
						windowMinutes: 10080,
						resetAtMs: now,
					},
				},
				now,
			),
		).toBe(false);
	});
});
