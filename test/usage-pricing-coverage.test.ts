import { describe, expect, it } from "vitest";
import { MODEL_PROFILES } from "../lib/request/helpers/model-map.js";
import {
	listUsageModelPricing,
	UNPRICED_ROUTABLE_MODELS,
} from "../lib/usage/pricing.js";

/**
 * Drift guard for the pricing table.
 *
 * A routable model with no rate is reported as unknown cost, which makes a
 * `maxCostUsd` budget unevaluable for it (see `evaluateBudgetGuard`). That is a
 * deliberate, fail-closed trade — but only for models we have consciously
 * listed. A NEW model must never slip in unpriced and unnoticed.
 */
describe("usage pricing coverage", () => {
	const priced = new Set(Object.keys(listUsageModelPricing()));
	const acknowledgedUnpriced = new Set<string>(UNPRICED_ROUTABLE_MODELS);
	const routable = [
		...new Set(
			Object.values(MODEL_PROFILES).map((profile) => profile.normalizedModel),
		),
	];

	it("accounts for every routable model as priced or knowingly unpriced", () => {
		const unaccounted = routable.filter(
			(model) => !priced.has(model) && !acknowledgedUnpriced.has(model),
		);
		expect(
			unaccounted,
			"new routable model(s) with no price: add a rate to MODEL_PRICING, or list them in UNPRICED_ROUTABLE_MODELS to accept that a maxCostUsd budget cannot be evaluated while they are in use",
		).toEqual([]);
	});

	it("keeps the unpriced list free of models that are now priced or gone", () => {
		const stale = [...acknowledgedUnpriced].filter(
			(model) => priced.has(model) || !routable.includes(model),
		);
		expect(
			stale,
			"UNPRICED_ROUTABLE_MODELS entries that are now priced or no longer routable; delete them",
		).toEqual([]);
	});

	it("never claims a price it does not have", () => {
		for (const model of acknowledgedUnpriced) {
			expect(priced.has(model), `${model} is in both lists`).toBe(false);
		}
	});
});
