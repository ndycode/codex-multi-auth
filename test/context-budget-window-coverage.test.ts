import { describe, expect, it } from "vitest";
import { MODEL_PROFILES } from "../lib/request/helpers/model-map.js";
import {
	getEffectiveContextWindow,
	listEstimatedModelContextWindows,
	UNESTIMATED_ROUTABLE_MODELS,
} from "../lib/context-budget/model-context-windows.js";

/**
 * Drift guard for the context-window estimate table, mirroring
 * `test/usage-pricing-coverage.test.ts`. A routable model that is neither
 * estimated nor consciously unestimated would silently return `null` from
 * `getEffectiveContextWindow` — which is safe (the guard no-ops) but hides a
 * gap a reviewer should see and decide on explicitly.
 */
describe("context budget window coverage", () => {
	const estimated = new Set(Object.keys(listEstimatedModelContextWindows()));
	const acknowledgedUnestimated = new Set<string>(UNESTIMATED_ROUTABLE_MODELS);
	const routable = [
		...new Set(
			Object.values(MODEL_PROFILES).map((profile) => profile.normalizedModel),
		),
	];

	it("accounts for every routable model as estimated or knowingly unestimated", () => {
		const unaccounted = routable.filter(
			(model) => !estimated.has(model) && !acknowledgedUnestimated.has(model),
		);
		expect(
			unaccounted,
			"new routable model(s) with no context-window estimate: add a best-effort entry to ESTIMATED_MODEL_CONTEXT_WINDOWS, or list them in UNESTIMATED_ROUTABLE_MODELS to accept that the context budget guard cannot evaluate them without a user-supplied override",
		).toEqual([]);
	});

	it("keeps the unestimated list free of models that are now estimated or gone", () => {
		const stale = [...acknowledgedUnestimated].filter(
			(model) => estimated.has(model) || !routable.includes(model),
		);
		expect(
			stale,
			"UNESTIMATED_ROUTABLE_MODELS entries that are now estimated or no longer routable; delete them",
		).toEqual([]);
	});

	it("never claims an estimate it does not have", () => {
		for (const model of acknowledgedUnestimated) {
			expect(estimated.has(model), `${model} is in both lists`).toBe(false);
		}
	});

	it("lets an explicit override win even for an unestimated model", () => {
		const [unestimatedModel] = UNESTIMATED_ROUTABLE_MODELS;
		const window = getEffectiveContextWindow(unestimatedModel, {
			[unestimatedModel]: 123_456,
		});
		expect(window).toEqual({ tokens: 123_456, source: "override" });
	});

	it("returns null for an unestimated model with no override", () => {
		const [unestimatedModel] = UNESTIMATED_ROUTABLE_MODELS;
		expect(getEffectiveContextWindow(unestimatedModel, undefined)).toBeNull();
	});
});
