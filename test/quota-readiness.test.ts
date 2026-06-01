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

	// quota-forecast-02: an exhausted window with NO resetAtMs must not read as
	// exhausted forever — once a full window has elapsed since the snapshot it is
	// treated as rolled over.
	it("expires an exhausted window with no resetAtMs after windowMinutes elapse", () => {
		const updatedAt = 1_000_000;
		const windowMinutes = 300; // 5h
		const entry = {
			primary: { usedPercent: 100, windowMinutes },
			secondary: { usedPercent: 10, windowMinutes: 10080 },
			updatedAt,
		};
		// Right after the snapshot: still exhausted.
		expect(isQuotaCacheEntryExhausted(entry, updatedAt + 60_000)).toBe(true);
		// After a full window elapsed without a reset timestamp: no longer exhausted.
		expect(
			isQuotaCacheEntryExhausted(entry, updatedAt + windowMinutes * 60_000 + 1),
		).toBe(false);
	});

	it("still reports exhausted with no resetAtMs before the window elapses", () => {
		const updatedAt = 2_000_000;
		const entry = {
			primary: { usedPercent: 100, windowMinutes: 300 },
			updatedAt,
		};
		expect(isQuotaCacheEntryExhausted(entry, updatedAt + 1000)).toBe(true);
	});

	// quota-forecast-02 (symmetry): the secondary window must expire on the same
	// implicit-rollover rule as the primary — swap the exhausted side.
	it("expires an exhausted SECONDARY window with no resetAtMs after its window elapses", () => {
		const updatedAt = 3_000_000;
		const windowMinutes = 10080; // weekly
		const entry = {
			primary: { usedPercent: 10, windowMinutes: 300 },
			secondary: { usedPercent: 100, windowMinutes },
			updatedAt,
		};
		// Right after the snapshot: still exhausted via the secondary window.
		expect(isQuotaCacheEntryExhausted(entry, updatedAt + 60_000)).toBe(true);
		// After a full secondary window elapsed: no longer exhausted.
		expect(
			isQuotaCacheEntryExhausted(entry, updatedAt + windowMinutes * 60_000 + 1),
		).toBe(false);
	});

	// quota-forecast-02 (boundary): the implicit-rollover comparison is `now >=
	// updatedAt + windowMinutes*60_000`, so the EXACT boundary counts as expired.
	it("treats the exact window boundary as expired (inclusive)", () => {
		const updatedAt = 4_000_000;
		const windowMinutes = 300;
		const entry = {
			primary: { usedPercent: 100, windowMinutes },
			updatedAt,
		};
		const boundary = updatedAt + windowMinutes * 60_000;
		expect(isQuotaCacheEntryExhausted(entry, boundary - 1)).toBe(true);
		expect(isQuotaCacheEntryExhausted(entry, boundary)).toBe(false);
	});

	// quota-forecast-02 (partial/invalid cache shapes): without a usable updatedAt
	// + windowMinutes the staleness escape cannot fire, so a 100%-used window stays
	// exhausted. A future updatedAt (clock skew) must not prematurely "expire" it.
	describe("partial / invalid cache entries", () => {
		it("stays exhausted when updatedAt is missing", () => {
			expect(
				isQuotaCacheEntryExhausted(
					{ primary: { usedPercent: 100, windowMinutes: 300 } },
					Number.MAX_SAFE_INTEGER,
				),
			).toBe(true);
		});

		it("stays exhausted when windowMinutes is missing", () => {
			const updatedAt = 5_000_000;
			expect(
				isQuotaCacheEntryExhausted(
					{ primary: { usedPercent: 100 }, updatedAt },
					updatedAt + 10 * 24 * 60 * 60_000,
				),
			).toBe(true);
		});

		it("stays exhausted when windowMinutes is zero or negative", () => {
			const updatedAt = 6_000_000;
			for (const windowMinutes of [0, -300]) {
				expect(
					isQuotaCacheEntryExhausted(
						{ primary: { usedPercent: 100, windowMinutes }, updatedAt },
						updatedAt + 10 * 24 * 60 * 60_000,
					),
				).toBe(true);
			}
		});

		it("does not prematurely expire when updatedAt is in the future (clock skew)", () => {
			const now = 7_000_000;
			const futureUpdatedAt = now + 60 * 60_000; // snapshot timestamped an hour ahead
			expect(
				isQuotaCacheEntryExhausted(
					{
						primary: { usedPercent: 100, windowMinutes: 300 },
						updatedAt: futureUpdatedAt,
					},
					now,
				),
			).toBe(true);
		});
	});
});
