import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL,
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
import { computeOutboundRequestAttemptBudget } from "../lib/request/request-attempt-budget.js";

/**
 * GPT-6.1 Terra (released 2026-10-26; added to the upstream Codex catalog in
 * Codex CLI 0.165.0 at priority 7, between 6.1 Sol and 6 Sol).
 *
 * The failure this suite pins: the 6.1 branch of the GPT-6 resolver sent every
 * 6.1 id to Sol, so asking for `gpt-6.1-terra` silently ran `gpt-6.1-sol` — a
 * different model at twice Terra's price — with no error.
 */
describe("GPT-6.1 Terra", () => {
	describe("model resolution", () => {
		it("maps the canonical id to itself", () => {
			expect(getNormalizedModel("gpt-6.1-terra")).toBe("gpt-6.1-terra");
			expect(isKnownModel("gpt-6.1-terra")).toBe(true);
		});

		it("never resolves a Terra id to 6.1 Sol", () => {
			for (const id of [
				"gpt-6.1-terra",
				"gpt-6.1-terra-2026-10-26",
				"gpt-6.1-terra-fast",
				"gpt6.1-terra",
				"openai/gpt-6.1-terra",
				"GPT 6.1 Terra",
				"GPT-6.1-Terra",
			]) {
				expect(resolveNormalizedModel(id), id).toBe("gpt-6.1-terra");
			}
		});

		it("registers only the efforts the Codex catalog lists", () => {
			for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
				expect(getNormalizedModel(`gpt-6.1-terra-${effort}`), effort).toBe(
					"gpt-6.1-terra",
				);
			}
			// The API page lists `none`; the Codex catalog this wrapper mirrors does not.
			expect(getNormalizedModel("gpt-6.1-terra-none")).toBeUndefined();
			expect(getNormalizedModel("gpt-6.1-terra-minimal")).toBeUndefined();
		});

		it("leaves 6.1 Sol, the bare 6.1 alias, and the older Terras alone", () => {
			expect(resolveNormalizedModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel("gpt-6.1")).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel("gpt-6.1-unknown")).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
			// There is still no GPT-6.0 Terra; upstream migrates those users to Sol.
			expect(resolveNormalizedModel("gpt-6-terra")).toBe("gpt-6-sol");
			expect(resolveNormalizedModel("gpt-6.1-astra")).toBe("gpt-6-astra");
		});

		it("does not become the default", () => {
			expect(DEFAULT_MODEL).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel("terra")).toBe(DEFAULT_MODEL);
		});
	});

	describe("reasoning effort", () => {
		it("uses the upstream catalog default of `low`", () => {
			expect(getReasoningConfig("gpt-6.1-terra", {}).effort).toBe("low");
		});

		it("passes `max` through and rewrites `ultra` to `max` on the wire", () => {
			expect(getReasoningConfig("gpt-6.1-terra", { reasoningEffort: "max" }).effort).toBe("max");
			expect(getReasoningConfig("gpt-6.1-terra", { reasoningEffort: "ultra" }).effort).toBe("max");
		});

		it("coerces `none` up to `low`", () => {
			expect(getReasoningConfig("gpt-6.1-terra", { reasoningEffort: "none" }).effort).toBe("low");
		});

		it("probes at the cheapest supported effort", () => {
			expect(resolveProbeReasoningEffort("gpt-6.1-terra")).toBe("low");
		});
	});

	describe("profile", () => {
		it("exposes the low-to-ultra ladder, the gpt-5.2 prompt family, and full tools", () => {
			const profile = getModelProfile("gpt-6.1-terra");
			expect(profile.normalizedModel).toBe("gpt-6.1-terra");
			expect(profile.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
			expect(profile.promptFamily).toBe("gpt-5.2");
			expect(profile.capabilities).toEqual({ toolSearch: true, computerUse: true, compaction: true });
		});
	});

	describe("cost", () => {
		const TOKENS = {
			inputTokens: 100_000,
			cachedInputTokens: 0,
			outputTokens: 1_000_000,
			reasoningTokens: 0,
		};

		it("prices the standard tier at the published $1 / $5 rate", () => {
			// 0.1 x $1 input + 1 x $5 output.
			expect(estimateUsageCostUsd("gpt-6.1-terra", TOKENS)).toBeCloseTo(5.1, 10);
			expect(getUsageModelPricing("gpt-6.1-terra")).toMatchObject({
				inputUsdPerMillion: 1,
				outputUsdPerMillion: 5,
				cachedInputUsdPerMillion: 0.05,
				reasoningUsdPerMillion: 5,
			});
		});

		it("prices effort-suffixed ids through the canonical card", () => {
			expect(estimateUsageCostUsd("gpt-6.1-terra-high", TOKENS)).toBeCloseTo(5.1, 10);
		});

		it("bills cached input at 5% of input", () => {
			expect(
				estimateUsageCostUsd("gpt-6.1-terra", {
					inputTokens: 100_000,
					cachedInputTokens: 100_000,
					outputTokens: 0,
					reasoningTokens: 0,
				}),
			).toBeCloseTo(0.005, 10);
		});

		it("prices Fast at 2x", () => {
			expect(estimateUsageCostUsd("gpt-6.1-terra", { ...TOKENS, serviceTier: "priority" })).toBeCloseTo(10.2, 10);
		});

		it("switches to 2x input and 1.5x output past 272K input", () => {
			const big = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 0 };
			expect(estimateUsageCostUsd("gpt-6.1-terra", { ...big, inputTokens: 272_000, outputTokens: 0 })).toBeCloseTo(0.272, 10);
			// 1 x $2 long input + 1 x $7.50 long output.
			expect(estimateUsageCostUsd("gpt-6.1-terra", big)).toBeCloseTo(9.5, 10);
			// Fast long context: 1 x $4 + 1 x $15.
			expect(estimateUsageCostUsd("gpt-6.1-terra", { ...big, serviceTier: "priority" })).toBeCloseTo(19, 10);
		});
	});

	describe("context budget guard", () => {
		it("refuses to invent a window, and honours an override", () => {
			// 500K in the Codex catalog, 872K max, 1.05M on the API page.
			expect(getEffectiveContextWindow("gpt-6.1-terra", undefined)).toBeNull();
			expect(getEffectiveContextWindow("gpt-6.1-terra-xhigh", { "gpt-6.1-terra": 500_000 })).toEqual({
				tokens: 500_000,
				source: "override",
			});
		});
	});

	describe("unsupported-model fallback chain", () => {
		const unsupportedBody = {
			error: {
				message: "'gpt-6.1-terra' model is not supported when using codex with a chatgpt account",
			},
		};

		function walk(requestedModel: string): string[] {
			const attempted = new Set<string>([requestedModel]);
			const hops: string[] = [];
			let model: string | undefined = requestedModel;
			for (let step = 0; step < 10; step += 1) {
				const next: string | undefined = resolveUnsupportedCodexFallbackModel({
					requestedModel: model,
					errorBody: unsupportedBody,
					attemptedModels: attempted,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});
				if (!next) break;
				hops.push(next);
				attempted.add(model as string);
				attempted.add(next);
				model = next;
			}
			return hops;
		}

		it("steps to the Terra it replaces, then down the shared staircase", () => {
			expect(walk("gpt-6.1-terra")).toEqual(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-luna", "gpt-5.6-luna"]);
			expect(walk("gpt-6.1-terra")).not.toContain("gpt-6-astra");
		});

		it("fits inside the single-account attempt budget", () => {
			const budget = computeOutboundRequestAttemptBudget({
				accountCount: 1,
				maxSameAccountRetries: 1,
				emptyResponseMaxRetries: 2,
				streamFailoverMax: 2,
			});
			expect(walk("gpt-6.1-terra").length + 1).toBeLessThanOrEqual(budget);
		});
	});
});
