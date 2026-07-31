import { describe, expect, it } from "vitest";
import {
	createMiniMaxModelsResponse,
	getMiniMaxEndpoints,
	MINIMAX_MODELS,
} from "../lib/providers/minimax.js";

describe("MiniMax provider catalog", () => {
	it("defines the global and China regional endpoints", () => {
		expect(getMiniMaxEndpoints("global")).toEqual({
			responsesBaseUrl: "https://api.minimax.io/v1",
			messagesBaseUrl: "https://api.minimax.io/anthropic",
		});
		expect(getMiniMaxEndpoints("cn")).toEqual({
			responsesBaseUrl: "https://api.minimaxi.com/v1",
			messagesBaseUrl: "https://api.minimaxi.com/anthropic",
		});
	});

	it("publishes the current model capabilities and pricing", () => {
		expect(MINIMAX_MODELS).toEqual([
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
		]);
	});

	it("renders an executable model-list response", () => {
		expect(createMiniMaxModelsResponse()).toEqual({
			object: "list",
			data: [
				expect.objectContaining({
					id: "MiniMax-M3",
					owned_by: "MiniMax",
					context_window: 1_000_000,
					input_modalities: ["text", "image", "video"],
					thinking: ["adaptive", "disabled"],
				}),
				expect.objectContaining({
					id: "MiniMax-M2.7",
					context_window: 204_800,
					input_modalities: ["text"],
					thinking: ["always_on"],
				}),
			],
		});
	});
});
