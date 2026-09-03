import type { UsageTokenCounts } from "./types.js";

export interface UsageModelPricing {
	inputUsdPerMillion: number;
	outputUsdPerMillion: number;
	cachedInputUsdPerMillion?: number;
	reasoningUsdPerMillion?: number;
}

const MODEL_PRICING: Record<string, UsageModelPricing> = {
	// GPT-6 Astra, published at the 2026-09-03 launch: $10 / 1M input,
	// $50 / 1M output on the standard service tier. Fast mode is 2x standard
	// ($20 / $100); this table has no service-tier dimension, so it prices the
	// standard tier and a Fast-mode session is under-counted by half. No cached
	// input rate was published, so `cachedInputUsdPerMillion` is deliberately
	// absent: `estimateUsageCostUsd` then bills cached tokens at the full input
	// rate, which over-states cost. That is the safe direction for a
	// `maxCostUsd` budget — it trips early, never late.
	"gpt-6-astra": {
		inputUsdPerMillion: 10,
		outputUsdPerMillion: 50,
		reasoningUsdPerMillion: 50,
	},
	"gpt-5-codex": {
		inputUsdPerMillion: 1.25,
		outputUsdPerMillion: 10,
		cachedInputUsdPerMillion: 0.125,
		reasoningUsdPerMillion: 10,
	},
	"gpt-5.1-codex": {
		inputUsdPerMillion: 1.25,
		outputUsdPerMillion: 10,
		cachedInputUsdPerMillion: 0.125,
		reasoningUsdPerMillion: 10,
	},
	"gpt-5.2": {
		inputUsdPerMillion: 1.25,
		outputUsdPerMillion: 10,
		cachedInputUsdPerMillion: 0.125,
		reasoningUsdPerMillion: 10,
	},
	"gpt-5.3-codex": {
		inputUsdPerMillion: 1.25,
		outputUsdPerMillion: 10,
		cachedInputUsdPerMillion: 0.125,
		reasoningUsdPerMillion: 10,
	},
	"gpt-5.4": {
		inputUsdPerMillion: 2,
		outputUsdPerMillion: 12,
		cachedInputUsdPerMillion: 0.2,
		reasoningUsdPerMillion: 12,
	},
	"gpt-5.5": {
		inputUsdPerMillion: 2,
		outputUsdPerMillion: 12,
		cachedInputUsdPerMillion: 0.2,
		reasoningUsdPerMillion: 12,
	},
	"gpt-5.6-sol": {
		inputUsdPerMillion: 5,
		outputUsdPerMillion: 30,
		cachedInputUsdPerMillion: 0.5,
		reasoningUsdPerMillion: 30,
	},
	"gpt-5.6-terra": {
		inputUsdPerMillion: 2.5,
		outputUsdPerMillion: 15,
		cachedInputUsdPerMillion: 0.25,
		reasoningUsdPerMillion: 15,
	},
	"gpt-5.6-luna": {
		inputUsdPerMillion: 1,
		outputUsdPerMillion: 6,
		cachedInputUsdPerMillion: 0.1,
		reasoningUsdPerMillion: 6,
	},
};

/**
 * Models the router can normalize to that have no published rate here yet.
 *
 * Their cost is deliberately reported as unknown (`null`) rather than guessed:
 * a wrong dollar figure is worse than no figure, and it would silently move a
 * `maxCostUsd` budget's trip point. Nothing may treat an unknown cost as zero —
 * `evaluateBudgetGuard` refuses a cost budget while unknown-cost usage is in
 * the window instead of counting it as free (that under-count made cost caps
 * unenforceable for exactly these models, every `pro` tier among them).
 *
 * Add a real rate to MODEL_PRICING and delete the entry here once published;
 * `test/usage-pricing-coverage.test.ts` fails if a NEW routable model appears
 * in neither list.
 */
export const UNPRICED_ROUTABLE_MODELS = [
	// OpenAI published a rate for the Astra flagship at launch but not for the
	// long-horizon `aeon` variant, and the Daybreak cyber models are sold under
	// a separate controlled-access agreement with no public per-token rate.
	// Pricing `aeon` off the flagship would be a guess on the model whose whole
	// purpose is running for days, which is exactly where a wrong rate does the
	// most damage.
	"gpt-6-astra-aeon",
	"gpt-daybreak-blue-latest",
	"gpt-daybreak-red-latest",
	"gpt-5.1",
	"gpt-5.2-pro",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
	"gpt-5.5-pro",
	"gpt-5-mini",
	"gpt-5-nano",
] as const;

function normalizeModelName(model: string | null | undefined): string | null {
	const trimmed = model?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function getUsageModelPricing(
	model: string | null | undefined,
): UsageModelPricing | null {
	const normalized = normalizeModelName(model);
	if (!normalized) {
		return null;
	}
	return MODEL_PRICING[normalized] ?? null;
}

export function estimateUsageCostUsd(
	model: string | null | undefined,
	tokens: UsageTokenCounts,
): number | null {
	const pricing = getUsageModelPricing(model);
	if (!pricing) {
		return null;
	}

	const billableInputTokens = Math.max(
		0,
		tokens.inputTokens - tokens.cachedInputTokens,
	);
	const input =
		(billableInputTokens / 1_000_000) * pricing.inputUsdPerMillion;
	const output =
		(tokens.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
	const cached =
		(tokens.cachedInputTokens / 1_000_000) *
		(pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion);
	const reasoning =
		(tokens.reasoningTokens / 1_000_000) *
		(pricing.reasoningUsdPerMillion ?? pricing.outputUsdPerMillion);
	return Number((input + output + cached + reasoning).toFixed(8));
}

export function listUsageModelPricing(): Record<string, UsageModelPricing> {
	return structuredClone(MODEL_PRICING);
}

