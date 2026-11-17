import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL,
	getModelCapabilities,
	getModelProfile,
	getNormalizedModel,
	isKnownModel,
	resolveNormalizedModel,
	resolveProbeReasoningEffort,
} from "../lib/request/helpers/model-map.js";
import { getReasoningConfig } from "../lib/request/request-transformer.js";
import { getEffectiveContextWindow } from "../lib/context-budget/model-context-windows.js";
import { resolveUnsupportedCodexFallbackModel } from "../lib/request/error-classification.js";
import { computeOutboundRequestAttemptBudget } from "../lib/request/request-attempt-budget.js";
import { normalizeUsageLedgerRow } from "../lib/usage/redaction.js";
import {
	GPT_62_ULTRAFAST_PROMOTION_END_MS,
	estimateUsageCostUsd,
	getUsageModelPricing,
} from "../lib/usage/pricing.js";

const GPT_62_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

describe("GPT-6.2 Astra and Sol", () => {
	describe("model resolution", () => {
		it("keeps the canonical Astra and Sol ids distinct", () => {
			expect(getNormalizedModel("gpt-6.2-astra")).toBe("gpt-6.2-astra");
			expect(getNormalizedModel("gpt-6.2-sol")).toBe("gpt-6.2-sol");
			expect(isKnownModel("gpt-6.2-astra")).toBe(true);
			expect(isKnownModel("gpt-6.2-sol")).toBe(true);
		});

		it("maps the bare 6.2 alias to Sol and preserves provider prefixes", () => {
			const cases = [
				["gpt-6.2", "gpt-6.2-sol"],
				["gpt-6.2-high", "gpt-6.2-sol"],
				["openai/gpt-6.2", "gpt-6.2-sol"],
				["gpt6.2-sol", "gpt-6.2-sol"],
				["GPT 6.2 Astra", "gpt-6.2-astra"],
				["gpt-6.2-astra-2026-11-17", "gpt-6.2-astra"],
			] as const;
			for (const [id, expected] of cases) {
				expect(resolveNormalizedModel(id), id).toBe(expected);
			}
		});

		it("does not confuse 6.2 tiers with the previous GPT-6 generations", () => {
			expect(resolveNormalizedModel("gpt-6.2-sol-fast")).toBe("gpt-6.2-sol");
			expect(resolveNormalizedModel("gpt-6.2-terra")).toBe("gpt-6.2-sol");
			expect(resolveNormalizedModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel("gpt-6-sol")).toBe("gpt-6-sol");
		});

		it("keeps the package default unchanged", () => {
			expect(DEFAULT_MODEL).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel(undefined)).toBe(DEFAULT_MODEL);
		});
	});

	describe("reasoning and profile metadata", () => {
		it("advertises the API ladder plus Codex's client-side Ultra tier", () => {
			for (const model of ["gpt-6.2-astra", "gpt-6.2-sol"]) {
				const profile = getModelProfile(model);
				expect(profile.supportedReasoningEfforts).toEqual(GPT_62_EFFORTS);
				expect(profile.defaultReasoningEffort).toBe("medium");
				expect(profile.promptFamily).toBe("gpt-5.2");
				expect(getModelCapabilities(model)).toEqual({
					toolSearch: true,
					computerUse: true,
					compaction: true,
				});
			}
		});

		it("coerces unsupported none and ultra requests to the nearest valid wire effort", () => {
			expect(getReasoningConfig("gpt-6.2-sol", {}).effort).toBe("medium");
			expect(
			getReasoningConfig("gpt-6.2-sol", { reasoningEffort: "none" }).effort,
		).toBe("low");
		// `ultra` remains a compatibility input, but is not advertised for 6.2
		// and must be sent as the supported `max` wire value.
			expect(
			getReasoningConfig("gpt-6.2-astra", { reasoningEffort: "ultra" }).effort,
		).toBe("max");
			expect(resolveProbeReasoningEffort("gpt-6.2-astra")).toBe("low");
		});

		it("registers Ultra as a client-side compatibility alias", () => {
			expect(getNormalizedModel("gpt-6.2-astra-ultra")).toBe("gpt-6.2-astra");
			expect(getNormalizedModel("gpt-6.2-sol-ultra")).toBe("gpt-6.2-sol");
		});
	});

	describe("pricing and context budget", () => {
		const tokens = {
			inputTokens: 100_000,
			cachedInputTokens: 0,
			outputTokens: 1_000_000,
			reasoningTokens: 0,
		};

		it("prices Astra at the published standard and long-context rates", () => {
			expect(estimateUsageCostUsd("gpt-6.2-astra", tokens)).toBeCloseTo(40.8, 10);
			expect(getUsageModelPricing("gpt-6.2-astra")).toMatchObject({
				inputUsdPerMillion: 8,
				outputUsdPerMillion: 40,
				cachedInputUsdPerMillion: 0.4,
				longContext: {
					inputUsdPerMillion: 16,
					outputUsdPerMillion: 60,
				},
			});
			expect(
				estimateUsageCostUsd("gpt-6.2-astra", {
					inputTokens: 1_000_000,
					cachedInputTokens: 0,
					outputTokens: 1_000_000,
					reasoningTokens: 0,
				}),
			).toBe(76);
		});

		it("prices Sol at the published standard and Ultrafast rates", () => {
			expect(estimateUsageCostUsd("gpt-6.2-sol", tokens)).toBeCloseTo(10.2, 10);
			expect(
				estimateUsageCostUsd("gpt-6.2-sol", {
					...tokens,
					serviceTier: "ultrafast",
				}, GPT_62_ULTRAFAST_PROMOTION_END_MS - 1),
			).toBeCloseTo(30.6, 10);
			expect(getUsageModelPricing("gpt-6.2-sol")?.serviceTiers?.ultrafast).toMatchObject({
				inputUsdPerMillion: 6,
				outputUsdPerMillion: 30,
			});
		});

		it("covers cached, priority, and both sides of the Ultrafast promotion", () => {
			const beforePromotion = GPT_62_ULTRAFAST_PROMOTION_END_MS - 1;
			const afterPromotion = GPT_62_ULTRAFAST_PROMOTION_END_MS;
			const cachedOnly = {
				inputTokens: 100_000,
				cachedInputTokens: 100_000,
				outputTokens: 0,
				reasoningTokens: 0,
			};
			const cases = [
				{ model: "gpt-6.2-astra", tokens, expected: 40.8 },
				{ model: "gpt-6.2-astra", tokens: cachedOnly, expected: 0.04 },
				{ model: "gpt-6.2-astra", tokens: { ...tokens, serviceTier: "priority" as const }, expected: 81.6 },
				{
					model: "gpt-6.2-astra",
					tokens: { ...tokens, serviceTier: "ultrafast" as const },
					at: beforePromotion,
					expected: 122.4,
				},
				{
					model: "gpt-6.2-astra",
					tokens: { ...tokens, serviceTier: "ultrafast" as const },
					at: afterPromotion,
					expected: 244.8,
				},
				{ model: "gpt-6.2-sol", tokens, expected: 10.2 },
				{ model: "gpt-6.2-sol", tokens: cachedOnly, expected: 0.01 },
				{ model: "gpt-6.2-sol", tokens: { ...tokens, serviceTier: "priority" as const }, expected: 20.4 },
				{
					model: "gpt-6.2-sol",
					tokens: { ...tokens, serviceTier: "ultrafast" as const },
					at: beforePromotion,
					expected: 30.6,
				},
				{
					model: "gpt-6.2-sol",
					tokens: { ...tokens, serviceTier: "ultrafast" as const },
					at: afterPromotion,
					expected: 61.2,
				},
			] as const;

			for (const testCase of cases) {
				expect(
					estimateUsageCostUsd(
						testCase.model,
						testCase.tokens,
						testCase.at,
					),
				).toBeCloseTo(testCase.expected, 10);
			}
		});

		it("keeps the 272,000-token boundary exact for both models and tiers", () => {
			for (const [model, shortRate, longRate, priorityLongRate] of [
				["gpt-6.2-astra", 8, 16, 32],
				["gpt-6.2-sol", 2, 4, 8],
			] as const) {
				const atBoundary = {
					inputTokens: 272_000,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningTokens: 0,
				};
				const pastBoundary = { ...atBoundary, inputTokens: 272_001 };
				expect(estimateUsageCostUsd(model, atBoundary)).toBeCloseTo(
					(272_000 / 1_000_000) * shortRate,
					10,
				);
				expect(estimateUsageCostUsd(model, pastBoundary)).toBeCloseTo(
					(272_001 / 1_000_000) * longRate,
					10,
				);
				expect(
					estimateUsageCostUsd(model, { ...pastBoundary, serviceTier: "priority" }),
				).toBeCloseTo((272_001 / 1_000_000) * priorityLongRate, 10);
			}
		});

		it("fails closed for long-context Ultrafast where stacking is unpublished", () => {
			for (const model of ["gpt-6.2-astra", "gpt-6.2-sol"] as const) {
				expect(
					estimateUsageCostUsd(model, {
						inputTokens: 272_001,
						cachedInputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						serviceTier: "ultrafast",
					}),
				).toBeNull();
			}
		});

		it("prices ledger rows using their recorded timestamp", () => {
			const row = (createdAt: number) =>
				normalizeUsageLedgerRow({
					createdAt,
					outcome: "success",
					model: "gpt-6.2-sol",
					inputTokens: 100_000,
					outputTokens: 1_000_000,
					serviceTier: "ultrafast",
				});
			expect(row(GPT_62_ULTRAFAST_PROMOTION_END_MS - 1).costUsd).toBeCloseTo(30.6, 10);
			expect(row(GPT_62_ULTRAFAST_PROMOTION_END_MS).costUsd).toBeCloseTo(61.2, 10);
		});

		it("keeps the API 1.05M context claim unestimated until the Codex ceiling is verified", () => {
			expect(getEffectiveContextWindow("gpt-6.2-astra", undefined)).toBeNull();
			expect(
			getEffectiveContextWindow("gpt-6.2-sol-max", {
				"gpt-6.2-sol": 1_050_000,
			}),
		).toEqual({ tokens: 1_050_000, source: "override" });
		});
	});

	describe("unsupported-model fallback", () => {
		const errorBody = {
			error: {
				message:
					"'gpt-6.2-astra' model is not supported when using codex with a chatgpt account",
			},
		};

		it("steps Astra through same-generation Sol and then the prior Sol", () => {
			const attempted = new Set(["gpt-6.2-astra"]);
			expect(
			resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-6.2-astra",
				errorBody,
				attemptedModels: attempted,
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			}),
		).toBe("gpt-6.2-sol");
		attempted.add("gpt-6.2-sol");
		expect(
			resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-6.2-sol",
				errorBody,
				attemptedModels: attempted,
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			}),
		).toBe("gpt-6.1-sol");
		});

		it("documents the launch-chain depth against the shared attempt budget", () => {
			const budget = computeOutboundRequestAttemptBudget({
				accountCount: 1,
				maxSameAccountRetries: 1,
				emptyResponseMaxRetries: 2,
				streamFailoverMax: 2,
			});
			// The initial Astra request plus the first four fallback hops fit the
			// default single-account budget. The final Luna hops remain bounded but
			// are intentionally unreachable in that configuration.
			expect(budget).toBe(5);
			const attempted = new Set<string>(["gpt-6.2-astra"]);
			const hops: string[] = [];
			let model = "gpt-6.2-astra";
			for (let step = 0; step < 10; step += 1) {
				const next = resolveUnsupportedCodexFallbackModel({
					requestedModel: model,
					errorBody,
					attemptedModels: attempted,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});
				if (!next) break;
				hops.push(next);
				attempted.add(model);
				attempted.add(next);
				model = next;
			}
			expect(hops.slice(0, budget - 1)).toEqual([
				"gpt-6.2-sol",
				"gpt-6.1-sol",
				"gpt-6-sol",
				"gpt-5.6-sol",
			]);
			expect(hops).toEqual([
				"gpt-6.2-sol",
				"gpt-6.1-sol",
				"gpt-6-sol",
				"gpt-5.6-sol",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]);
		});
	});
});
