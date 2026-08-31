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

	/**
	 * The checks above validate the CANONICAL key space
	 * (`profile.normalizedModel`). The guard is never handed one of those: the
	 * rotation proxy copies `body.model` verbatim, so the lookup has to work on
	 * the raw ids clients actually send. Looking those up straight against the
	 * table returned null for Codex CLI's own default model.
	 */
	it("resolves the raw client model strings the runtime actually passes", () => {
		for (const raw of [
			"gpt-5-codex",
			"gpt-5.1-codex",
			"gpt-5.2-codex",
			"gpt-5.3-codex",
			"gpt-5.3-codex-high",
			"gpt-5.1-codex-max",
			"GPT-5.5",
			"openai/gpt-5.5",
		]) {
			expect(
				getEffectiveContextWindow(raw, undefined),
				`${raw} resolved to no window; the guard silently no-ops for it`,
			).toEqual({ tokens: 260_000, source: "estimate" });
		}
	});

	it("still refuses to invent a window for a model it does not know", () => {
		// resolveNormalizedModel() would fall back to DEFAULT_MODEL here and
		// hand this a 260k window; the exact/alias-only resolver must not.
		expect(getEffectiveContextWindow("totally-made-up-model", undefined)).toBeNull();
	});

	it("prefers an override keyed by the raw string over the canonical estimate", () => {
		expect(getEffectiveContextWindow("gpt-5-codex", { "gpt-5-codex": 99_000 })).toEqual({
			tokens: 99_000,
			source: "override",
		});
	});

	it("applies an override keyed by the canonical id to an alias of it", () => {
		expect(
			getEffectiveContextWindow("gpt-5-codex", { "gpt-5.3-codex": 88_000 }),
		).toEqual({ tokens: 88_000, source: "override" });
	});
});
