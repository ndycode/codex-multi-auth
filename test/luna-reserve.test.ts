import { describe, expect, it } from "vitest";
import { parseLunaReserveRateLimits } from "../lib/luna-reserve.js";

const NOW = 1_790_000_000_000;

describe("Luna Reserve rate-limit parsing", () => {
	it("extracts the separately metered Reserve bucket and remaining percentage", () => {
		const snapshot = parseLunaReserveRateLimits({
			rateLimitsByLimitId: {
				codex: { limitName: "codex", primary: { usedPercent: 100 } },
				base_model_inference: {
					limitId: "base_model_inference",
					limitName: "gpt-reserve",
					normalModelSlug: "gpt-6-luna",
					primary: { usedPercent: 6, windowDurationMins: 10_080, resetsAt: 1_790_604_800 },
				},
			},
		}, NOW);
		expect(snapshot).toEqual({
			observedAt: NOW,
			offered: true,
			available: true,
			limitId: "base_model_inference",
			limitName: "gpt-reserve",
			normalModelSlug: "gpt-6-luna",
			primary: {
				usedPercent: 6,
				remainingPercent: 94,
				windowMinutes: 10_080,
				resetAtMs: 1_790_604_800_000,
			},
			secondary: null,
		});
	});

	it("reports an exhausted offered bucket separately from absence", () => {
		const exhausted = parseLunaReserveRateLimits({
			rateLimitsByLimitId: {
				reserve: { limitName: "gpt-reserve", primary: { usedPercent: 100 } },
			},
		}, NOW);
		expect(exhausted.offered).toBe(true);
		expect(exhausted.available).toBe(false);
		expect(exhausted.primary?.remainingPercent).toBe(0);

		const absent = parseLunaReserveRateLimits({ rateLimitsByLimitId: {} }, NOW);
		expect(absent.offered).toBe(false);
		expect(absent.available).toBeNull();
		expect(absent.primary).toBeNull();
	});
});
