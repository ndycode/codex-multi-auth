export type MiniMaxRegion = "global" | "cn";

export interface MiniMaxModelDefinition {
	id: "MiniMax-M3" | "MiniMax-M2.7";
	contextWindow: number;
	inputModalities: readonly ("text" | "image" | "video")[];
	thinking: readonly ("adaptive" | "disabled" | "always_on")[];
	pricingUsdPerMillionTokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number | null;
	};
}

export interface MiniMaxRegionalEndpoints {
	responsesBaseUrl: string;
	messagesBaseUrl: string;
}

export const MINIMAX_MODELS: readonly MiniMaxModelDefinition[] = [
	{
		id: "MiniMax-M3",
		contextWindow: 1_000_000,
		inputModalities: ["text", "image", "video"],
		thinking: ["adaptive", "disabled"],
		pricingUsdPerMillionTokens: {
			input: 0.6,
			output: 2.4,
			cacheRead: 0.12,
			cacheWrite: null,
		},
	},
	{
		id: "MiniMax-M2.7",
		contextWindow: 204_800,
		inputModalities: ["text"],
		thinking: ["always_on"],
		pricingUsdPerMillionTokens: {
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
		},
	},
] as const;

export const MINIMAX_ENDPOINTS: Readonly<
	Record<MiniMaxRegion, MiniMaxRegionalEndpoints>
> = {
	global: {
		responsesBaseUrl: "https://api.minimax.io/v1",
		messagesBaseUrl: "https://api.minimax.io/anthropic",
	},
	cn: {
		responsesBaseUrl: "https://api.minimaxi.com/v1",
		messagesBaseUrl: "https://api.minimaxi.com/anthropic",
	},
} as const;

export function getMiniMaxEndpoints(
	region: MiniMaxRegion = "global",
): MiniMaxRegionalEndpoints {
	return MINIMAX_ENDPOINTS[region];
}

export function createMiniMaxModelsResponse(): {
	object: "list";
	data: Array<{
		id: MiniMaxModelDefinition["id"];
		object: "model";
		created: 0;
		owned_by: "MiniMax";
		context_window: number;
		input_modalities: readonly ("text" | "image" | "video")[];
		thinking: readonly ("adaptive" | "disabled" | "always_on")[];
		pricing_usd_per_million_tokens: {
			input: number;
			output: number;
			cache_read: number;
			cache_write: number | null;
		};
	}>;
} {
	return {
		object: "list",
		data: MINIMAX_MODELS.map((model) => ({
			id: model.id,
			object: "model",
			created: 0,
			owned_by: "MiniMax",
			context_window: model.contextWindow,
			input_modalities: model.inputModalities,
			thinking: model.thinking,
			pricing_usd_per_million_tokens: {
				input: model.pricingUsdPerMillionTokens.input,
				output: model.pricingUsdPerMillionTokens.output,
				cache_read: model.pricingUsdPerMillionTokens.cacheRead,
				cache_write: model.pricingUsdPerMillionTokens.cacheWrite,
			},
		})),
	};
}
