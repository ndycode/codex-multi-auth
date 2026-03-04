import { describe, expect, it } from "vitest";
import { evaluateRuntimeBudgetGate } from "../scripts/check-runtime-budgets-helpers.mjs";

describe("check-runtime-budgets script", () => {
	it("rejects non-positive maxAvgMs budget values", () => {
		const { failures } = evaluateRuntimeBudgetGate(
			{
				results: [
					{ name: "case-zero", avgMs: 1 },
					{ name: "case-negative", avgMs: 1 },
				],
			},
			{
				cases: {
					"case-zero": { maxAvgMs: 0 },
					"case-negative": { maxAvgMs: -10 },
				},
			},
		);

		expect(failures).toContain("invalid budget maxAvgMs for case: case-zero");
		expect(failures).toContain("invalid budget maxAvgMs for case: case-negative");
	});

	it("throws when no budget cases are defined", () => {
		expect(() =>
			evaluateRuntimeBudgetGate(
				{
					results: [{ name: "case-a", avgMs: 1 }],
				},
				{ cases: {} },
			),
		).toThrow("No budget cases defined");
	});
});
