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
 * GPT-6 Sol and Luna (upstream Codex catalog, openai/codex #47332, 2026-09-22).
 *
 * The failure this suite pins is the one that existed before these entries:
 * the GPT-6 resolver sent every GPT-6 id it did not know to Astra, so asking for
 * `gpt-6-luna` ran the frontier model at 100x Luna's price, against Astra's
 * entitlement and rate limits.
 */
describe("GPT-6 Sol and Luna", () => {
	describe("model resolution", () => {
		it("maps each tier to its own canonical id", () => {
			expect(getNormalizedModel("gpt-6-sol")).toBe("gpt-6-sol");
			expect(getNormalizedModel("gpt-6-luna")).toBe("gpt-6-luna");
			expect(isKnownModel("gpt-6-sol")).toBe(true);
			expect(isKnownModel("gpt-6-luna")).toBe(true);
		});

		it("never resolves Sol or Luna to Astra", () => {
			for (const id of [
				"gpt-6-sol",
				"gpt-6-sol-2026-09-22",
				"openai/gpt-6-sol",
				"GPT 6 Sol",
				"gpt-6-sol-fast",
			]) {
				expect(resolveNormalizedModel(id), id).toBe("gpt-6-sol");
			}
			for (const id of [
				"gpt-6-luna",
				"gpt-6-luna-2026-09-22",
				"openai/gpt-6-luna",
				"GPT-6-Luna",
				"gpt6-luna",
			]) {
				expect(resolveNormalizedModel(id), id).toBe("gpt-6-luna");
			}
		});

		it("registers only the efforts each tier accepts", () => {
			expect(getNormalizedModel("gpt-6-sol-ultra")).toBe("gpt-6-sol");
			expect(getNormalizedModel("gpt-6-sol-max")).toBe("gpt-6-sol");
			expect(getNormalizedModel("gpt-6-luna-max")).toBe("gpt-6-luna");
			// Luna has no `ultra` upstream, and no tier accepts `none`/`minimal`.
			expect(getNormalizedModel("gpt-6-luna-ultra")).toBeUndefined();
			expect(getNormalizedModel("gpt-6-sol-none")).toBeUndefined();
			expect(getNormalizedModel("gpt-6-luna-minimal")).toBeUndefined();
		});

		it("sends a GPT-6 Terra id to Sol, where upstream migrates Terra users", () => {
			// There is no GPT-6 Terra. Astra would be the wrong fallback: it is the
			// most expensive model and the one most likely to be unentitled.
			expect(resolveNormalizedModel("gpt-6-terra")).toBe("gpt-6-sol");
		});

		it("leaves Astra, the retired aeon slug and the bare flagship alias where they were", () => {
			expect(resolveNormalizedModel("gpt-6")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("gpt-6-turbo")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("gpt-6-astra-pro")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("Astra Pro")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("gpt-6-astra-aeon-2026-09-03")).toBe(
				"gpt-6-astra",
			);
		});

		it("does not re-point bare `sol`/`luna` or the 5.6 tiers", () => {
			// Those names meant the 5.6 tiers before 2026-09-22; changing them would
			// swap a user's model generation without asking.
			expect(getNormalizedModel("sol")).toBeUndefined();
			expect(getNormalizedModel("luna")).toBeUndefined();
			expect(resolveNormalizedModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
			expect(resolveNormalizedModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
			expect(resolveNormalizedModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
		});

		it("defers a `codex` token to the codex resolver", () => {
			// A codex id runs on the retired-codex replacement (5.6 Sol), not on
			// the GPT-6 model its other tokens name.
			expect(resolveNormalizedModel("gpt-6-sol-codex")).toBe("gpt-5.6-sol");
			expect(resolveNormalizedModel("gpt-6-luna-codex")).toBe("gpt-5.6-sol");
		});
	});

		it("recognizes Luna Reserve as a first-class Luna-compatible model", () => {
			expect(getNormalizedModel("gpt-reserve")).toBe("gpt-reserve");
			expect(getNormalizedModel("gpt-reserve-xhigh")).toBe("gpt-reserve");
			expect(isKnownModel("gpt-reserve")).toBe(true);
			expect(getModelProfile("gpt-reserve").supportedReasoningEfforts).toEqual([
				"low", "medium", "high", "xhigh", "max",
			]);
			expect(getModelProfile("gpt-reserve").promptFamily).toBe("gpt-5.2");
		});

	describe("reasoning effort", () => {
		it("uses the catalog default of `medium` for both tiers", () => {
			expect(getReasoningConfig("gpt-6-sol", {}).effort).toBe("medium");
			expect(getReasoningConfig("gpt-6-luna", {}).effort).toBe("medium");
		});

		it("rewrites `ultra` to `max` on the wire, including on Luna", () => {
			expect(
				getReasoningConfig("gpt-6-sol", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
			expect(
				getReasoningConfig("gpt-6-luna", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
		});

		it("coerces `none` up to `low`", () => {
			expect(
				getReasoningConfig("gpt-6-luna", { reasoningEffort: "none" }).effort,
			).toBe("low");
		});

		it("probes at the cheapest supported effort", () => {
			expect(resolveProbeReasoningEffort("gpt-6-sol")).toBe("low");
			expect(resolveProbeReasoningEffort("gpt-6-luna")).toBe("low");
		});
	});

	describe("profiles", () => {
		it("matches the upstream effort ladders", () => {
			expect(getModelProfile("gpt-6-sol").supportedReasoningEfforts).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
				"ultra",
			]);
			expect(getModelProfile("gpt-6-luna").supportedReasoningEfforts).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		});

		it("stays in the gpt-5.2 prompt family like the rest of GPT-6", () => {
			expect(getModelProfile("gpt-6-sol").promptFamily).toBe("gpt-5.2");
			expect(getModelProfile("gpt-6-luna").promptFamily).toBe("gpt-5.2");
		});
	});

	describe("cost", () => {
		// Input under 272K so these assert the short-context rate.
		const TOKENS = {
			inputTokens: 100_000,
			cachedInputTokens: 0,
			outputTokens: 1_000_000,
			reasoningTokens: 0,
		};

		it("prices both tiers at the published standard rate", () => {
			expect(estimateUsageCostUsd("gpt-6-sol", TOKENS)).toBeCloseTo(10.2, 10);
			expect(estimateUsageCostUsd("gpt-6-luna", TOKENS)).toBeCloseTo(0.51, 10);
		});

		it("prices the published Fast tier at 2x", () => {
			expect(
				estimateUsageCostUsd("gpt-6-sol", { ...TOKENS, serviceTier: "priority" }),
			).toBeCloseTo(20.4, 10);
			expect(
				estimateUsageCostUsd("gpt-6-luna", { ...TOKENS, serviceTier: "priority" }),
			).toBeCloseTo(1.02, 10);
		});

		it("bills cached input at the 90% discount, never free", () => {
			const cachedOnly = { ...TOKENS, cachedInputTokens: 100_000, outputTokens: 0 };
			expect(estimateUsageCostUsd("gpt-6-sol", cachedOnly)).toBeCloseTo(0.02, 10);
			expect(estimateUsageCostUsd("gpt-6-luna", cachedOnly)).toBeCloseTo(0.001, 10);
		});

		it("reports an unpublished tier as unknown rather than guessing", () => {
			expect(
				estimateUsageCostUsd("gpt-6-sol", { ...TOKENS, serviceTier: "scale" }),
			).toBeNull();
			const luna = getUsageModelPricing("gpt-6-luna");
			expect(luna?.serviceTiers?.priority).toBeDefined();
			expect(luna?.serviceTiers?.flex).toBeUndefined();
		});

		describe("long context (more than 272K input)", () => {
			// The GPT-6 model pages price "prompts with more than 272K input
			// tokens" at the long-context rate, so 272,000 itself is short. Before
			// this, a 500K-token Sol request was billed at the short rate and a
			// maxCostUsd cap could overrun.
			const at = (inputTokens: number) => ({
				inputTokens,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
			});

			it("keeps the short rate at exactly 272,000 input tokens", () => {
				expect(estimateUsageCostUsd("gpt-6-sol", at(272_000))).toBeCloseTo(
					0.272 * 2,
					10,
				);
			});

			it("switches to the long rate one token past 272,000", () => {
				expect(estimateUsageCostUsd("gpt-6-sol", at(272_001))).toBeCloseTo(
					(272_001 / 1_000_000) * 4,
					10,
				);
				expect(estimateUsageCostUsd("gpt-6-luna", at(1_000_000))).toBeCloseTo(
					0.2,
					10,
				);
				expect(estimateUsageCostUsd("gpt-6-astra", at(1_000_000))).toBe(20);
			});

			it("prices long-context output, cached input and Fast mode too", () => {
				const tokens = {
					inputTokens: 1_000_000,
					cachedInputTokens: 500_000,
					outputTokens: 1_000_000,
					reasoningTokens: 0,
				};
				// 0.5M billable x 4 + 0.5M cached x 0.4 + 1M out x 15
				expect(estimateUsageCostUsd("gpt-6-sol", tokens)).toBeCloseTo(17.2, 10);
				// Fast long context: 0.5 x 8 + 0.5 x 0.8 + 1 x 30
				expect(
					estimateUsageCostUsd("gpt-6-sol", { ...tokens, serviceTier: "priority" }),
				).toBeCloseTo(34.4, 10);
			});

			it("bills a retired id at its replacement's long-context rate", () => {
				// `gpt-5.5` runs on GPT-6 Sol now, and Sol's $4 long-context rate
				// applies past 272K — the retired id does not keep its old flat $2.
				expect(estimateUsageCostUsd("gpt-5.5", at(1_000_000))).toBe(4);
			});
		});
	});

	describe("context budget guard", () => {
		it("refuses to invent a window, and honours an override", () => {
			expect(getEffectiveContextWindow("gpt-6-sol", undefined)).toBeNull();
			expect(getEffectiveContextWindow("gpt-6-luna", undefined)).toBeNull();
			expect(
				getEffectiveContextWindow("gpt-6-luna-max", { "gpt-6-luna": 272_000 }),
			).toEqual({ tokens: 272_000, source: "override" });
		});
	});

	describe("unsupported-model fallback chain", () => {
		const unsupportedBody = {
			error: {
				message:
					"'gpt-6-sol' model is not supported when using codex with a chatgpt account",
			},
		};

		// Same stepwise walk as test/gpt6-astra-models.test.ts: each hop resolves
		// from the model that just failed, the way index.ts's retry loop does.
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

		it("walks Sol down through the 5.6 tier it replaces", () => {
			// 5.6 Sol hands off to GPT-6 Luna — the broadest-entitlement model —
			// and Luna's row lands on the light 5.6 tier last.
			expect(walk("gpt-6-sol")).toEqual([
				"gpt-5.6-sol",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]);
		});

		it("walks Luna down through 5.6 Luna instead of stranding there", () => {
			expect(walk("gpt-6-luna")).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
		});

		it("never steps sideways into Astra", () => {
			expect(walk("gpt-6-sol")).not.toContain("gpt-6-astra");
			expect(walk("gpt-6-luna")).not.toContain("gpt-6-astra");
		});
	});
});
