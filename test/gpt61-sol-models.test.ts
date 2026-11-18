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
 * GPT-6.1 Sol (upstream Codex catalog, openai/codex #49318, 2026-09-29): the
 * current default catalog model, and this package's `DEFAULT_MODEL`.
 *
 * The failure this suite pins: before dedicated handling, `gpt-6.1-sol` hit
 * the fuzzy GPT-6 resolver as tokens `[gpt, 6, 1, sol]`, the `sol` token won,
 * and asking for the new model silently ran `gpt-6-sol` — the previous
 * generation — with no error.
 */
describe("GPT-6.1 Sol", () => {
	describe("model resolution", () => {
		it("maps the canonical id and the bare minor alias to itself", () => {
			expect(getNormalizedModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
			expect(getNormalizedModel("gpt-6.1")).toBe("gpt-6.1-sol");
			expect(isKnownModel("gpt-6.1-sol")).toBe(true);
			expect(isKnownModel("gpt-6.1")).toBe(true);
		});

		it("never resolves 6.1 ids to the previous generation's Sol", () => {
			for (const id of [
				"gpt-6.1-sol",
				"gpt-6.1-sol-2026-09-29",
				"gpt-6.1-sol-fast",
				"gpt-6.1-luna",
				"gpt6.1-sol",
				"openai/gpt-6.1-sol",
				"GPT 6.1 Sol",
				"gpt-6.1",
			]) {
				expect(resolveNormalizedModel(id), id).toBe("gpt-6.1-sol");
			}
		});

		it("registers only the efforts it accepts", () => {
			for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
				expect(getNormalizedModel(`gpt-6.1-sol-${effort}`), effort).toBe(
					"gpt-6.1-sol",
				);
			}
			expect(getNormalizedModel("gpt-6.1-sol-none")).toBeUndefined();
			expect(getNormalizedModel("gpt-6.1-sol-minimal")).toBeUndefined();
		});

		it("lets an explicit `astra` claim keep the frontier model", () => {
			// `gpt-6.1-astra` names the frontier model it actually means, so the
			// `astra`/`aeon` claims run before the 6.1-minor branch.
			expect(resolveNormalizedModel("gpt-6.1-astra")).toBe("gpt-6-astra");
		});

		it("leaves the 6.0 tiers and their aliases where they were", () => {
			expect(resolveNormalizedModel("gpt-6-sol")).toBe("gpt-6-sol");
			expect(resolveNormalizedModel("gpt-6-luna")).toBe("gpt-6-luna");
			expect(resolveNormalizedModel("gpt-6")).toBe("gpt-6-astra");
			expect(resolveNormalizedModel("gpt-6-terra")).toBe("gpt-6-sol");
		});

		it("defers a `codex` token to the codex resolver", () => {
			expect(resolveNormalizedModel("gpt-6.1-codex")).toBe("gpt-5.6-sol");
		});
	});

	describe("default model", () => {
		it("is the package default", () => {
			expect(DEFAULT_MODEL).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel(undefined)).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel("")).toBe("gpt-6.1-sol");
			expect(resolveNormalizedModel("unknown-model")).toBe("gpt-6.1-sol");
		});
	});

	describe("reasoning effort", () => {
		it("uses the upstream catalog default of `low`", () => {
			expect(getReasoningConfig("gpt-6.1-sol", {}).effort).toBe("low");
		});

		it("passes `max` through untouched", () => {
			expect(
				getReasoningConfig("gpt-6.1-sol", { reasoningEffort: "max" }).effort,
			).toBe("max");
		});

		it("rewrites `ultra` to `max` on the wire", () => {
			// Upstream `reasoning_effort_for_request` rewrites Ultra -> Max before
			// the request is sent, so `ultra` must never reach the API.
			expect(
				getReasoningConfig("gpt-6.1-sol", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
		});

		it("coerces `none` up to `low`", () => {
			expect(
				getReasoningConfig("gpt-6.1-sol", { reasoningEffort: "none" }).effort,
			).toBe("low");
		});

		it("probes at the cheapest supported effort", () => {
			expect(resolveProbeReasoningEffort("gpt-6.1-sol")).toBe("low");
		});
	});

	describe("profiles", () => {
		it("exposes the full low-to-ultra ladder and no `none`", () => {
			expect(getModelProfile("gpt-6.1-sol").supportedReasoningEfforts).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
				"ultra",
			]);
		});

		it("stays in the gpt-5.2 prompt family like the rest of GPT-6", () => {
			expect(getModelProfile("gpt-6.1-sol").promptFamily).toBe("gpt-5.2");
		});

		it("advertises the full tool surface", () => {
			expect(getModelProfile("gpt-6.1-sol").capabilities).toEqual({
				toolSearch: true,
				computerUse: true,
				compaction: true,
			});
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

		it("prices the standard tier at the published rate", () => {
			// 0.1 x $2 input + 1 x $10 output.
			expect(estimateUsageCostUsd("gpt-6.1-sol", TOKENS)).toBeCloseTo(10.2, 10);
			expect(getUsageModelPricing("gpt-6.1-sol")).toEqual({
				inputUsdPerMillion: 2,
				outputUsdPerMillion: 10,
				cachedInputUsdPerMillion: 0.1,
				reasoningUsdPerMillion: 10,
				longContext: {
					inputUsdPerMillion: 4,
					outputUsdPerMillion: 15,
					cachedInputUsdPerMillion: 0.2,
					reasoningUsdPerMillion: 15,
				},
				serviceTiers: {
					priority: {
						inputUsdPerMillion: 4,
						outputUsdPerMillion: 20,
						cachedInputUsdPerMillion: 0.2,
						reasoningUsdPerMillion: 20,
						longContext: {
							inputUsdPerMillion: 8,
							outputUsdPerMillion: 30,
							cachedInputUsdPerMillion: 0.4,
							reasoningUsdPerMillion: 30,
						},
					},
					ultrafast: {
						inputUsdPerMillion: 12,
						outputUsdPerMillion: 60,
						cachedInputUsdPerMillion: 0.6,
						reasoningUsdPerMillion: 60,
					},
				},
			});
		});

		it("bills cached input at the published $0.10 rate, never free", () => {
			expect(
				estimateUsageCostUsd("gpt-6.1-sol", {
					inputTokens: 100_000,
					cachedInputTokens: 100_000,
					outputTokens: 0,
					reasoningTokens: 0,
				}),
			).toBeCloseTo(0.01, 10);
		});

		it("prices the published Ultrafast tier at 6x", () => {
			// 0.1 x $12 input + 1 x $60 output.
			expect(
				estimateUsageCostUsd("gpt-6.1-sol", { ...TOKENS, serviceTier: "ultrafast" }),
			).toBeCloseTo(61.2, 10);
			expect(
				estimateUsageCostUsd("gpt-6.1-sol", {
					inputTokens: 100_000,
					cachedInputTokens: 100_000,
					outputTokens: 0,
					reasoningTokens: 0,
					serviceTier: "ultrafast",
				}),
			).toBeCloseTo(0.06, 10);
		});

		it("leaves Ultrafast long context unpriced rather than guessing a stack", () => {
			expect(
				estimateUsageCostUsd("gpt-6.1-sol", {
					inputTokens: 272_001,
					cachedInputTokens: 0,
					outputTokens: 0,
					reasoningTokens: 0,
					serviceTier: "ultrafast",
				}),
			).toBeNull();
		});

		it("prices the published Fast tier at 2x", () => {
			expect(
				estimateUsageCostUsd("gpt-6.1-sol", {
					...TOKENS,
					serviceTier: "priority",
				}),
			).toBeCloseTo(20.4, 10);
		});

		describe("long context (more than 272K input)", () => {
			const at = (inputTokens: number) => ({
				inputTokens,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
			});

			it("keeps the short rate at exactly 272,000 input tokens", () => {
				expect(estimateUsageCostUsd("gpt-6.1-sol", at(272_000))).toBeCloseTo(
					0.272 * 2,
					10,
				);
			});

			it("switches to the long rate one token past 272,000", () => {
				expect(estimateUsageCostUsd("gpt-6.1-sol", at(272_001))).toBeCloseTo(
					(272_001 / 1_000_000) * 4,
					10,
				);
				// 1 x $4 long input + 1 x $15 long output.
				expect(
					estimateUsageCostUsd("gpt-6.1-sol", {
						inputTokens: 1_000_000,
						cachedInputTokens: 0,
						outputTokens: 1_000_000,
						reasoningTokens: 0,
					}),
				).toBe(19);
			});

			it("prices Fast long context at 2x", () => {
				// 1 x $8 long input + 1 x $30 long output.
				expect(
					estimateUsageCostUsd("gpt-6.1-sol", {
						inputTokens: 1_000_000,
						cachedInputTokens: 0,
						outputTokens: 1_000_000,
						reasoningTokens: 0,
						serviceTier: "priority",
					}),
				).toBe(38);
			});
		});
	});

	describe("context budget guard", () => {
		it("refuses to invent a window, and honours an override", () => {
			// Upstream lists 272K active / 872K max for the Codex catalog and a
			// different ceiling on the API surface; the file stays unestimated
			// rather than picking one.
			expect(getEffectiveContextWindow("gpt-6.1-sol", undefined)).toBeNull();
			expect(
				getEffectiveContextWindow("gpt-6.1-sol-ultra", { "gpt-6.1-sol": 272_000 }),
			).toEqual({ tokens: 272_000, source: "override" });
		});
	});

	describe("unsupported-model fallback chain", () => {
		const unsupportedBody = {
			error: {
				message:
					"'gpt-6.1-sol' model is not supported when using codex with a chatgpt account",
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

		it("steps to 6 Sol first, never sideways into Astra", () => {
			// 6.1 Sol is the new-model rollout the chain exists for: an account
			// without it retries the same-generation workhorse, not the priciest
			// and least-entitled model in the catalog.
			expect(walk("gpt-6.1-sol")).toEqual([
				"gpt-6-sol",
				"gpt-5.6-sol",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]);
			expect(walk("gpt-6.1-sol")).not.toContain("gpt-6-astra");
		});

		it("reaches its final hop inside the single-account attempt budget", () => {
			// Four hops + the initial attempt is exactly the budget of 5, so a
			// single-account walk reaches `gpt-5.6-luna` on its last attempt —
			// unlike the retired pro/aeon walks, which spend the same budget one
			// hop earlier (see test/gpt6-astra-models.test.ts).
			const budget = computeOutboundRequestAttemptBudget({
				accountCount: 1,
				maxSameAccountRetries: 1,
				emptyResponseMaxRetries: 2,
				streamFailoverMax: 2,
			});
			expect(budget).toBe(5);
			expect(walk("gpt-6.1-sol").length + 1).toBe(budget);
		});
	});
});
