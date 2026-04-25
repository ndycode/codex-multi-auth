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
});
