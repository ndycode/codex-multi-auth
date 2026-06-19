import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	buildForecastExplanation,
	recommendForecastAccount,
	summarizeForecast,
	type ForecastAccountResult,
} from "../../lib/forecast.js";

const arbResults: fc.Arbitrary<ForecastAccountResult[]> = fc
	.array(
		fc.record({
			availability: fc.constantFrom<"ready" | "delayed" | "unavailable">(
				"ready",
				"delayed",
				"unavailable",
			),
			riskScore: fc.integer({ min: 0, max: 100 }),
			riskLevel: fc.constantFrom<"low" | "medium" | "high">(
				"low",
				"medium",
				"high",
			),
			waitMs: fc.integer({ min: 0, max: 600_000 }),
			isCurrent: fc.boolean(),
			hardFailure: fc.boolean(),
			disabled: fc.boolean(),
			exhausted: fc.boolean(),
		}),
		{ minLength: 0, maxLength: 8 },
	)
	.map((rows) =>
		rows.map((row, index) => ({
			...row,
			// evaluateForecastAccount only ever emits exhausted accounts as
			// "delayed" (display/sorting keep them a timed wait); derive the
			// pairing so the generated space stays inside the reachable domain.
			availability: row.exhausted ? ("delayed" as const) : row.availability,
			index,
			label: `acct-${index}`,
			reasons: [],
		})),
	);

function recommendable(result: ForecastAccountResult): boolean {
	return (
		!result.disabled &&
		!result.hardFailure &&
		!result.exhausted &&
		result.availability !== "unavailable"
	);
}

describe("forecast recommendation property invariants", () => {
	it("a recommendation always points at a recommendable result", () => {
		fc.assert(
			fc.property(arbResults, (results) => {
				const recommendation = recommendForecastAccount(results);
				if (recommendation.recommendedIndex === null) {
					expect(results.some(recommendable)).toBe(false);
					return;
				}
				const picked = results.find(
					(result) => result.index === recommendation.recommendedIndex,
				);
				expect(picked).toBeDefined();
				expect(recommendable(picked as ForecastAccountResult)).toBe(true);
			}),
		);
	});

	it("a ready candidate always wins, with the minimal risk score among ready candidates", () => {
		fc.assert(
			fc.property(arbResults, (results) => {
				const readyCandidates = results.filter(
					(result) => recommendable(result) && result.availability === "ready",
				);
				fc.pre(readyCandidates.length > 0);
				const recommendation = recommendForecastAccount(results);
				const picked = results.find(
					(result) => result.index === recommendation.recommendedIndex,
				);
				expect(picked?.availability).toBe("ready");
				expect(picked?.riskScore).toBe(
					Math.min(...readyCandidates.map((result) => result.riskScore)),
				);
				expect(recommendation.reason).toContain("Lowest risk ready account");
			}),
		);
	});

	it("with no ready candidate, the shortest delayed wait wins", () => {
		fc.assert(
			fc.property(arbResults, (results) => {
				const candidates = results.filter(recommendable);
				fc.pre(candidates.length > 0);
				fc.pre(candidates.every((result) => result.availability === "delayed"));
				const recommendation = recommendForecastAccount(results);
				const picked = results.find(
					(result) => result.index === recommendation.recommendedIndex,
				);
				expect(picked?.waitMs).toBe(
					Math.min(...candidates.map((result) => result.waitMs)),
				);
				expect(recommendation.reason).toContain("shortest wait");
			}),
		);
	});

	it("an empty candidate pool names the actual blocker class in its guidance", () => {
		fc.assert(
			fc.property(arbResults, (results) => {
				fc.pre(!results.some(recommendable));
				const recommendation = recommendForecastAccount(results);
				expect(recommendation.recommendedIndex).toBeNull();
				const hasBlockedOrExhausted = results.some(
					(result) =>
						!result.disabled &&
						!result.hardFailure &&
						(result.exhausted || result.availability === "unavailable"),
				);
				expect(
					recommendation.reason.includes("blocked or exhausted"),
				).toBe(hasBlockedOrExhausted);
			}),
		);
	});

	it("the recommendation is invariant under input order", () => {
		fc.assert(
			fc.property(
				arbResults.chain((results) =>
					fc.record({
						results: fc.constant(results),
						shuffled: fc.shuffledSubarray(results, {
							minLength: results.length,
							maxLength: results.length,
						}),
					}),
				),
				({ results, shuffled }) => {
					// Unique indexes make the comparator's index tie-break total, so
					// ANY permutation must produce the same pick.
					const forward = recommendForecastAccount(results);
					expect(recommendForecastAccount(shuffled).recommendedIndex).toBe(
						forward.recommendedIndex,
					);
					expect(
						recommendForecastAccount([...results].reverse()).recommendedIndex,
					).toBe(forward.recommendedIndex);
				},
			),
		);
	});

	it("the summary partitions availability exactly and counts high risk", () => {
		fc.assert(
			fc.property(arbResults, (results) => {
				const summary = summarizeForecast(results);
				expect(summary.total).toBe(results.length);
				expect(summary.ready + summary.delayed + summary.unavailable).toBe(
					results.length,
				);
				expect(summary.ready).toBe(
					results.filter((result) => result.availability === "ready").length,
				);
				expect(summary.highRisk).toBe(
					results.filter((result) => result.riskLevel === "high").length,
				);
			}),
		);
	});

	it("the explanation mirrors the inputs in order and selects exactly the recommendation", () => {
		fc.assert(
			fc.property(arbResults, (results) => {
				const recommendation = recommendForecastAccount(results);
				const explanation = buildForecastExplanation(results, recommendation);
				expect(explanation.recommendedIndex).toBe(
					recommendation.recommendedIndex,
				);
				expect(explanation.considered.map((entry) => entry.index)).toEqual(
					results.map((result) => result.index),
				);
				for (const entry of explanation.considered) {
					expect(entry.selected).toBe(
						entry.index === recommendation.recommendedIndex,
					);
				}
			}),
		);
	});
});
