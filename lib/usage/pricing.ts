import type { UsageTokenCounts } from "./types.js";

export interface UsageModelPricing {
	inputUsdPerMillion: number;
	outputUsdPerMillion: number;
	cachedInputUsdPerMillion?: number;
	reasoningUsdPerMillion?: number;
}

const MODEL_PRICING: Record<string, UsageModelPricing> = {
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
};

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

