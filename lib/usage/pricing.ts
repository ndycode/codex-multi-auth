import type { UsageServiceTier, UsageTokenCounts } from "./types.js";

export interface UsageModelPricing {
	inputUsdPerMillion: number;
	outputUsdPerMillion: number;
	cachedInputUsdPerMillion?: number;
	reasoningUsdPerMillion?: number;
	/**
	 * Rates for non-standard service tiers, keyed by `UsageServiceTier`.
	 *
	 * Every entry in `MODEL_PRICING` is a STANDARD-tier rate. OpenAI's Fast tier
	 * costs more (2x for GPT-6 Astra), so pricing a Fast session off the standard
	 * row under-counts it by half and lets a `maxCostUsd` cap overrun.
	 *
	 * A tier absent from this map is deliberately NOT approximated from the
	 * standard rate. Only Astra's Fast multiplier is published; inventing one for
	 * the rest would move a budget's trip point on a guess, which is the failure
	 * this file exists to avoid. `estimateUsageCostUsd` reports an unlisted tier
	 * as unknown cost instead, so a budget fails closed the same way it does for
	 * an unpriced model.
	 */
	serviceTiers?: Partial<Record<UsageServiceTier, UsageModelPricing>>;
}

const MODEL_PRICING: Record<string, UsageModelPricing> = {
	// GPT-6 Astra, published at the 2026-09-03 launch: $10 / 1M input,
	// $50 / 1M output on the standard service tier, and $20 / $100 on Fast,
	// carried in `serviceTiers` below.
	//
	// The cached-input rate is the platform-wide 90% cached discount, which every
	// other row in this table already encodes at exactly input/10. It shipped
	// absent at first, on the reasoning that no Astra-specific cached figure was
	// published; that made Astra the only model billing cached tokens at the FULL
	// input rate, over-stating a cache-heavy session tenfold and tripping a
	// `maxCostUsd` cap far too early. Over-stating is the safer direction than
	// under-stating, but a 10x error blocks legitimate work, and the discount is
	// a uniform platform rate rather than a per-model guess.
	"gpt-6-astra": {
		inputUsdPerMillion: 10,
		outputUsdPerMillion: 50,
		cachedInputUsdPerMillion: 1,
		reasoningUsdPerMillion: 50,
		serviceTiers: {
			// Published at launch alongside the standard rate: Fast mode is up to
			// 2.5x the speed at 2x the price, $20 / $100 per 1M. This is the only
			// tier multiplier OpenAI has published for any model in this table,
			// which is why it is the only one listed anywhere in this file.
			priority: {
				inputUsdPerMillion: 20,
				outputUsdPerMillion: 100,
				cachedInputUsdPerMillion: 2,
				reasoningUsdPerMillion: 100,
			},
		},
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
	// `Object.hasOwn`, not a bare index. The model string arrives raw from the
	// client (`createUsageLedgerRow` only trims it), so `constructor`,
	// `toString` and friends reach this lookup and a bare index hands back the
	// matching `Object.prototype` member. That object is truthy, so it is
	// returned as a rate, and every field on it is undefined: the cost comes out
	// `NaN` instead of `null`. A NaN cost is worse than an unknown one, because
	// `NaN >= limit` is false, so it silently makes a `maxCostUsd` budget
	// unenforceable rather than failing closed the way an unpriced model does.
	if (!Object.hasOwn(MODEL_PRICING, normalized)) {
		return null;
	}
	return MODEL_PRICING[normalized] ?? null;
}

/**
 * Pick the rate that applies to a response's service tier.
 *
 * Returns `null` when the tier is real but this table has no rate for it, which
 * the caller turns into an unknown cost. `standard` and an absent tier both use
 * the base row, because every entry in `MODEL_PRICING` is a standard-tier rate.
 */
function resolveServiceTierPricing(
	pricing: UsageModelPricing,
	serviceTier: UsageServiceTier | undefined,
): UsageModelPricing | null {
	if (!serviceTier || serviceTier === "standard") {
		return pricing;
	}
	return pricing.serviceTiers?.[serviceTier] ?? null;
}

export function estimateUsageCostUsd(
	model: string | null | undefined,
	tokens: UsageTokenCounts,
): number | null {
	const basePricing = getUsageModelPricing(model);
	if (!basePricing) {
		return null;
	}

	// Resolve the tier BEFORE any arithmetic. A response billed at a tier this
	// table has no rate for must report unknown cost, not a standard-tier
	// figure: under-counting is what lets a `maxCostUsd` cap overrun, and
	// `evaluateBudgetGuard` already knows how to fail closed on `null`.
	const pricing = resolveServiceTierPricing(basePricing, tokens.serviceTier);
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

