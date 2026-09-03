import { describe, expect, it } from "vitest";
import {
	getModelProfile,
	getNormalizedModel,
	isKnownModel,
	resolveNormalizedModel,
	resolveProbeReasoningEffort,
} from "../lib/request/helpers/model-map.js";
import { getReasoningConfig } from "../lib/request/request-transformer.js";
import { estimateUsageCostUsd, getUsageModelPricing } from "../lib/usage/pricing.js";
import { getEffectiveContextWindow } from "../lib/context-budget/model-context-windows.js";
import { resolveUnsupportedCodexFallbackModel } from "../lib/request/error-classification.js";

/**
 * GPT-6 Astra (2026-09-03) and the Daybreak cyber models.
 *
 * The failure this suite exists to prevent is the one v2.5.0 already hit once
 * with GPT-5.6: an id the catalog does not recognise falls through to
 * `DEFAULT_MODEL` and silently runs GPT-5.5. For a frontier model that is not a
 * degraded response, it is a different model than the caller asked for, billed
 * and rate-limited under a different family.
 */
describe("GPT-6 Astra", () => {
	describe("model resolution", () => {
		it("maps the flagship and the long-horizon variant to their own ids", () => {
			expect(getNormalizedModel("gpt-6-astra")).toBe("gpt-6-astra");
			expect(getNormalizedModel("gpt-6-astra-aeon")).toBe("gpt-6-astra-aeon");
			expect(isKnownModel("gpt-6-astra")).toBe(true);
			expect(isKnownModel("gpt-6-astra-aeon")).toBe(true);
		});

		it("treats bare `gpt-6` and `astra` as the flagship", () => {
			expect(getNormalizedModel("gpt-6")).toBe("gpt-6-astra");
			expect(getNormalizedModel("gpt-6-high")).toBe("gpt-6-astra");
			expect(getNormalizedModel("astra")).toBe("gpt-6-astra");
			expect(getNormalizedModel("astra-aeon")).toBe("gpt-6-astra-aeon");
		});

		it("keeps effort aliases on their own model", () => {
			expect(getNormalizedModel("gpt-6-astra-xhigh")).toBe("gpt-6-astra");
			expect(getNormalizedModel("gpt-6-astra-max")).toBe("gpt-6-astra");
			expect(getNormalizedModel("gpt-6-astra-ultra")).toBe("gpt-6-astra");
			expect(getNormalizedModel("gpt-6-astra-aeon-ultra")).toBe(
				"gpt-6-astra-aeon",
			);
		});

		it("does not invent `none`/`minimal` aliases Astra does not accept", () => {
			expect(getNormalizedModel("gpt-6-astra-none")).toBeUndefined();
			expect(getNormalizedModel("gpt-6-astra-minimal")).toBeUndefined();
		});

		it("resolves unrecognised GPT-6 ids to Astra, never silently to 5.5", () => {
			// The whole point of the dedicated resolver: none of these are aliases.
			expect(resolveNormalizedModel("gpt-6-astra-pro")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("gpt-6-astra-2026-09-03")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("gpt-6-astra-fast")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("gpt-6-turbo")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("openai/gpt-6")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("GPT 6 Astra")).toBe("gpt-6-astra");
		});

		it("keeps an unrecognised aeon id on aeon rather than the flagship", () => {
			// aeon is a long-horizon model, not a rename of the flagship. Collapsing
			// it into `gpt-6-astra` would run a materially different model.
			expect(resolveNormalizedModel("gpt-6-astra-aeon-2026-09-03")).toBe(
				"gpt-6-astra-aeon",
			);
			expect(resolveNormalizedModel("GPT 6 Astra Aeon")).toBe("gpt-6-astra-aeon");
		});

		it("leaves the GPT-5 catalog untouched", () => {
			expect(getNormalizedModel("gpt-5")).toBe("gpt-5.5");
			expect(getNormalizedModel("gpt-5.6")).toBe("gpt-5.6-sol");
			expect(resolveNormalizedModel("gpt-5.6-terra-fast")).toBe("gpt-5.6-terra");
			expect(getNormalizedModel("codex-max")).toBe("gpt-5.3-codex");
		});

		it("defers ids carrying a `codex` token to the codex resolver", () => {
			// Same rule the 5.6 resolver follows. Astra has no codex variant, and
			// claiming one here would route a codex request onto a general model.
			expect(resolveNormalizedModel("gpt-6-codex")).toBe("gpt-5.3-codex");
		});
	});

	describe("reasoning effort", () => {
		it("uses the flagship/long-horizon defaults", () => {
			expect(getReasoningConfig("gpt-6-astra", {}).effort).toBe("low");
			expect(getReasoningConfig("gpt-6-astra-aeon", {}).effort).toBe("medium");
		});

		it("passes `max` through untouched", () => {
			expect(
				getReasoningConfig("gpt-6-astra", { reasoningEffort: "max" }).effort,
			).toBe("max");
		});

		it("rewrites `ultra` to `max` on the wire", () => {
			// Upstream `reasoning_effort_for_request` rewrites Ultra -> Max before
			// the request is sent, so `ultra` must never reach the API.
			expect(
				getReasoningConfig("gpt-6-astra", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
			expect(
				getReasoningConfig("gpt-6-astra-aeon", { reasoningEffort: "ultra" })
					.effort,
			).toBe("max");
		});

		it("upgrades `none`, which Astra does not accept, to `low`", () => {
			const effort = getReasoningConfig("gpt-6-astra", {
				reasoningEffort: "none",
			}).effort;
			expect(effort).not.toBe("none");
			expect(effort).toBe("low");
		});

		it("picks the cheapest supported effort for a quota probe", () => {
			expect(resolveProbeReasoningEffort("gpt-6-astra")).toBe("low");
			expect(resolveProbeReasoningEffort("gpt-6-astra-aeon")).toBe("low");
		});
	});

	describe("profiles", () => {
		it("exposes the full frontier effort ladder and no `none`", () => {
			for (const model of ["gpt-6-astra", "gpt-6-astra-aeon"]) {
				const efforts = getModelProfile(model).supportedReasoningEfforts;
				expect(efforts, model).toContain("ultra");
				expect(efforts, model).toContain("max");
				expect(efforts, model).not.toContain("none");
				expect(efforts, model).not.toContain("minimal");
			}
		});

		it("buckets Astra into the gpt-5.2 prompt family", () => {
			// No `gpt_6_prompt.md` exists upstream, and MODEL_FAMILIES is a
			// persisted key space that cannot grow without a storage migration.
			expect(getModelProfile("gpt-6-astra").promptFamily).toBe("gpt-5.2");
			expect(getModelProfile("gpt-6-astra-aeon").promptFamily).toBe("gpt-5.2");
		});

		it("advertises the full tool surface", () => {
			expect(getModelProfile("gpt-6-astra").capabilities).toEqual({
				toolSearch: true,
				computerUse: true,
				compaction: true,
			});
		});
	});

	describe("cost", () => {
		it("prices the flagship at the published launch rate", () => {
			expect(getUsageModelPricing("gpt-6-astra")).toEqual({
				inputUsdPerMillion: 10,
				outputUsdPerMillion: 50,
				reasoningUsdPerMillion: 50,
			});
			expect(
				estimateUsageCostUsd("gpt-6-astra", {
					inputTokens: 1_000_000,
					cachedInputTokens: 0,
					outputTokens: 1_000_000,
					reasoningTokens: 0,
				}),
			).toBe(60);
		});

		it("bills cached input at the full input rate, since none is published", () => {
			// Over-stating cost is the safe direction: a maxCostUsd budget trips
			// early rather than late. Never silently free.
			expect(
				estimateUsageCostUsd("gpt-6-astra", {
					inputTokens: 1_000_000,
					cachedInputTokens: 1_000_000,
					outputTokens: 0,
					reasoningTokens: 0,
				}),
			).toBe(10);
		});

		it("reports aeon's cost as unknown rather than guessing it", () => {
			expect(getUsageModelPricing("gpt-6-astra-aeon")).toBeNull();
			expect(
				estimateUsageCostUsd("gpt-6-astra-aeon", {
					inputTokens: 1_000_000,
					cachedInputTokens: 0,
					outputTokens: 1_000_000,
					reasoningTokens: 0,
				}),
			).toBeNull();
		});
	});

	describe("context budget guard", () => {
		it("refuses to invent a window, and honours an override", () => {
			// OpenAI published 1.05M for the API surface and 272K for Codex on the
			// same day. This wrapper talks to the Codex backend; guessing between
			// them would evaluate a real session against a fabricated number.
			expect(getEffectiveContextWindow("gpt-6-astra", undefined)).toBeNull();
			expect(
				getEffectiveContextWindow("gpt-6-astra-max", { "gpt-6-astra": 272_000 }),
			).toEqual({ tokens: 272_000, source: "override" });
		});
	});
});

describe("Daybreak cyber models", () => {
	it("maps each slug to its own canonical id", () => {
		expect(getNormalizedModel("gpt-daybreak-blue-latest")).toBe(
			"gpt-daybreak-blue-latest",
		);
		expect(getNormalizedModel("gpt-daybreak-red-latest")).toBe(
			"gpt-daybreak-red-latest",
		);
		expect(getNormalizedModel("daybreak-red")).toBe("gpt-daybreak-red-latest");
		expect(getNormalizedModel("daybreak-blue-high")).toBe(
			"gpt-daybreak-blue-latest",
		);
	});

	it("no longer falls through to GPT-5.5", () => {
		// Before the Daybreak entries these ids matched neither the codex resolver
		// (no `codex` token) nor the general GPT-5 resolver (no `gpt 5` token), so
		// asking for the cyber-permissive model quietly ran GPT-5.5.
		expect(resolveNormalizedModel("gpt-daybreak-red-latest")).not.toBe("gpt-5.5");
		expect(resolveNormalizedModel("gpt-daybreak-red-2026-08-14")).toBe(
			"gpt-daybreak-red-latest",
		);
	});

	it("resolves an unrecognised Daybreak id to the defensive variant", () => {
		// A typo must never silently upgrade a caller into the cyber-permissive
		// model, so `blue` is the fallback, not `red`.
		expect(resolveNormalizedModel("gpt-daybreak-teal")).toBe(
			"gpt-daybreak-blue-latest",
		);
		expect(resolveNormalizedModel("daybreak")).toBe("gpt-daybreak-blue-latest");
	});

	it("mirrors the upstream catalog's per-variant defaults", () => {
		expect(getReasoningConfig("gpt-daybreak-blue-latest", {}).effort).toBe("low");
		expect(getReasoningConfig("gpt-daybreak-red-latest", {}).effort).toBe(
			"medium",
		);
	});

	it("reports their cost as unknown rather than guessing", () => {
		// Controlled access is sold under a separate agreement with no public
		// per-token rate.
		expect(getUsageModelPricing("gpt-daybreak-blue-latest")).toBeNull();
		expect(getUsageModelPricing("gpt-daybreak-red-latest")).toBeNull();
	});
});

describe("bare `astra` ids with no version tokens", () => {
	it("resolves to Astra instead of falling back to GPT-5.5", () => {
		// Every picker label and OpenAI's own launch material say "Astra" without
		// the `gpt-6` prefix, so these arrive with no version tokens at all.
		expect(resolveNormalizedModel("Astra Pro")).toBe("gpt-6-astra");
		expect(resolveNormalizedModel("astra-fast")).toBe("gpt-6-astra");
		expect(resolveNormalizedModel("openai/astra")).toBe("gpt-6-astra");
		expect(resolveNormalizedModel("Astra Aeon")).toBe("gpt-6-astra-aeon");
	});
});

describe("unsupported-model fallback chain", () => {
	// Astra rolls out org by org, so an account without entitlement gets a real
	// unsupported-model response. The chain is opt-in
	// (`fallbackOnUnsupportedCodexModel` defaults to false) and fires only on
	// that response, so it never silently swaps a model the account could serve.
	const unsupportedBody = {
		error: {
			message:
				"'gpt-6-astra' model is not supported when using codex with a chatgpt account",
		},
	};

	function fallbackFor(requestedModel: string, attemptedModels: string[] = []) {
		return resolveUnsupportedCodexFallbackModel({
			requestedModel,
			errorBody: unsupportedBody,
			attemptedModels,
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: true,
		});
	}

	it("steps the flagship down to GPT-5.6 Sol", () => {
		expect(fallbackFor("gpt-6-astra")).toBe("gpt-5.6-sol");
	});

	it("steps aeon to the flagship first, then to Sol", () => {
		expect(fallbackFor("gpt-6-astra-aeon")).toBe("gpt-6-astra");
		expect(fallbackFor("gpt-6-astra-aeon", ["gpt-6-astra"])).toBe("gpt-5.6-sol");
	});

	it("has a floor below Sol", () => {
		expect(fallbackFor("gpt-6-astra", ["gpt-5.6-sol"])).toBe("gpt-5.5");
	});

	it("stays inert unless the user opted in", () => {
		expect(
			resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-6-astra",
				errorBody: unsupportedBody,
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			}),
		).toBeUndefined();
	});
});
