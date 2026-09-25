import { RETIRED_MODEL_REPLACEMENTS } from "../request/helpers/model-map.js";
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
	 * standard rate. Only the GPT-6 Fast rates are published; inventing one for
	 * the rest would move a budget's trip point on a guess, which is the failure
	 * this file exists to avoid. `estimateUsageCostUsd` reports an unlisted tier
	 * as unknown cost instead, so a budget fails closed the same way it does for
	 * an unpriced model.
	 */
	serviceTiers?: Partial<Record<UsageServiceTier, UsageModelPricing>>;
	/**
	 * Rates once a response's input exceeds `SHORT_CONTEXT_MAX_INPUT_TOKENS`.
	 *
	 * OpenAI bills a GPT-6 request whose context crosses 272K at a separate,
	 * higher rate. A row that declares this block (every tier inside it too) is
	 * priced from it past the threshold. A row that declares it but whose
	 * resolved service tier does not reports unknown cost there instead of the
	 * cheaper short-context figure, for the same fail-closed reason as an
	 * unlisted tier. Rows with no long-context data at all are unchanged.
	 */
	longContext?: UsageModelPricing;
}

/**
 * Largest input still billed at the short-context rate. OpenAI's GPT-6 model
 * pages say "Prompts with more than 272K input tokens are priced at 2x input
 * and cache rates", so exactly 272,000 is short and 272,001 is long.
 */
export const SHORT_CONTEXT_MAX_INPUT_TOKENS = 272_000;

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
		// Long-context rows from the same page (read 2026-09-23).
		longContext: {
			inputUsdPerMillion: 20,
			outputUsdPerMillion: 75,
			cachedInputUsdPerMillion: 2,
			reasoningUsdPerMillion: 75,
		},
		serviceTiers: {
			// Published at launch alongside the standard rate: Fast mode is up to
			// 2.5x the speed at 2x the price, $20 / $100 per 1M. Only the GPT-6
			// rows list a Fast tier, because only GPT-6 has a published Fast rate.
			priority: {
				inputUsdPerMillion: 20,
				outputUsdPerMillion: 100,
				cachedInputUsdPerMillion: 2,
				reasoningUsdPerMillion: 100,
				longContext: {
					inputUsdPerMillion: 40,
					outputUsdPerMillion: 150,
					cachedInputUsdPerMillion: 4,
					reasoningUsdPerMillion: 150,
				},
			},
		},
	},
	// GPT-6 Sol and Luna, from the OpenAI API pricing page (read 2026-09-23;
	// short- and long-context rows). Both publish a Fast tier at exactly 2x,
	// like Astra.
	"gpt-6-sol": {
		inputUsdPerMillion: 2,
		outputUsdPerMillion: 10,
		cachedInputUsdPerMillion: 0.2,
		reasoningUsdPerMillion: 10,
		longContext: {
			inputUsdPerMillion: 4,
			outputUsdPerMillion: 15,
			cachedInputUsdPerMillion: 0.4,
			reasoningUsdPerMillion: 15,
		},
		serviceTiers: {
			priority: {
				inputUsdPerMillion: 4,
				outputUsdPerMillion: 20,
				cachedInputUsdPerMillion: 0.4,
				reasoningUsdPerMillion: 20,
				longContext: {
					inputUsdPerMillion: 8,
					outputUsdPerMillion: 30,
					cachedInputUsdPerMillion: 0.8,
					reasoningUsdPerMillion: 30,
				},
			},
		},
	},
	"gpt-6-luna": {
		inputUsdPerMillion: 0.1,
		outputUsdPerMillion: 0.5,
		cachedInputUsdPerMillion: 0.01,
		reasoningUsdPerMillion: 0.5,
		longContext: {
			inputUsdPerMillion: 0.2,
			outputUsdPerMillion: 0.75,
			cachedInputUsdPerMillion: 0.02,
			reasoningUsdPerMillion: 0.75,
		},
		serviceTiers: {
			priority: {
				inputUsdPerMillion: 0.2,
				outputUsdPerMillion: 1,
				cachedInputUsdPerMillion: 0.02,
				reasoningUsdPerMillion: 1,
				longContext: {
					inputUsdPerMillion: 0.4,
					outputUsdPerMillion: 1.5,
					cachedInputUsdPerMillion: 0.04,
					reasoningUsdPerMillion: 1.5,
				},
			},
		},
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
	"gpt-5.5-pro",
] as const;

function normalizeModelName(model: string | null | undefined): string | null {
	const trimmed = model?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function getUsageModelPricing(
	model: string | null | undefined,
): UsageModelPricing | null {
	const normalized = normalizeModelName(model?.replace(/^(api|zdr)\//, ""));
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
	//
	// A retired id is priced as the model it now runs on. The proxy records the
	// raw client model string, so a new `gpt-5-codex` row is really a
	// `gpt-5.6-sol` request; pricing it at the retired model's old rate would
	// under-count a `maxCostUsd` budget. Rows already on disk are unaffected:
	// the ledger stores `costUsd` when a row is written and never re-prices it.
	const effective = !/^(api|zdr)\//.test(model ?? "") && Object.hasOwn(RETIRED_MODEL_REPLACEMENTS, normalized)
		? RETIRED_MODEL_REPLACEMENTS[normalized]
		: normalized;
	if (!effective || !Object.hasOwn(MODEL_PRICING, effective)) {
		return null;
	}
	return MODEL_PRICING[effective] ?? null;
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

function resolveContextLengthPricing(
	basePricing: UsageModelPricing,
	tierPricing: UsageModelPricing,
	inputTokens: number,
): UsageModelPricing | null {
	if (inputTokens <= SHORT_CONTEXT_MAX_INPUT_TOKENS) {
		return tierPricing;
	}
	if (tierPricing.longContext) {
		return tierPricing.longContext;
	}
	// The model has long-context rates but not for this tier: unknown, never
	// the cheaper short-context rate.
	return basePricing.longContext ? null : tierPricing;
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
	const tierPricing = resolveServiceTierPricing(basePricing, tokens.serviceTier);
	if (!tierPricing) {
		return null;
	}
	const pricing = resolveContextLengthPricing(
		basePricing,
		tierPricing,
		tokens.inputTokens,
	);
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

