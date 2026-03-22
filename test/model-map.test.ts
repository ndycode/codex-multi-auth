import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL,
	MODEL_MAP,
	getModelCapabilities,
	getModelProfile,
	getNormalizedModel,
	isKnownModel,
	resolveNormalizedModel,
} from "../lib/request/helpers/model-map.js";

describe("model map", () => {
	describe("MODEL_MAP", () => {
		it("keeps codex families canonical", () => {
			expect(MODEL_MAP["gpt-5-codex"]).toBe("gpt-5-codex");
			expect(MODEL_MAP["gpt-5.3-codex-spark-high"]).toBe("gpt-5-codex");
			expect(MODEL_MAP["gpt-5.1-codex-max-xhigh"]).toBe("gpt-5.1-codex-max");
			expect(MODEL_MAP["codex-mini-latest"]).toBe("gpt-5.1-codex-mini");
		});

		it("adds first-class GPT-5.4 era general models", () => {
			expect(MODEL_MAP["gpt-5.4"]).toBe("gpt-5.4");
			expect(MODEL_MAP["gpt-5.4-pro-high"]).toBe("gpt-5.4-pro");
			expect(MODEL_MAP["gpt-5"]).toBe("gpt-5");
			expect(MODEL_MAP["gpt-5-pro-high"]).toBe("gpt-5-pro");
		});

		it("keeps mini and nano on current non-5.1 model IDs", () => {
			expect(MODEL_MAP["gpt-5-mini"]).toBe("gpt-5-mini");
			expect(MODEL_MAP["gpt-5-nano"]).toBe("gpt-5-nano");
			expect(MODEL_MAP["gpt-5.4-mini"]).toBe("gpt-5-mini");
			expect(MODEL_MAP["gpt-5.4-nano"]).toBe("gpt-5-nano");
		});

		it("adds reasoning variants for legacy chat-latest aliases", () => {
			expect(MODEL_MAP["gpt-5-chat-latest-high"]).toBe("gpt-5");
			expect(MODEL_MAP["gpt-5.1-chat-latest-minimal"]).toBe("gpt-5.1");
		});
	});

	describe("getNormalizedModel", () => {
		it("returns exact aliases case-insensitively", () => {
			expect(getNormalizedModel("GPT-5.4")).toBe("gpt-5.4");
			expect(getNormalizedModel("GPT-5.4-PRO-HIGH")).toBe("gpt-5.4-pro");
			expect(getNormalizedModel("gpt-5.4-mini")).toBe("gpt-5-mini");
			expect(getNormalizedModel("gpt-5.3-codex-high")).toBe("gpt-5-codex");
			expect(getNormalizedModel("gpt-5-chat-latest-high")).toBe("gpt-5");
			expect(getNormalizedModel("codex-max")).toBe("gpt-5.1-codex-max");
		});

		it("returns undefined for unknown exact identifiers", () => {
			expect(getNormalizedModel("unknown-model")).toBeUndefined();
			expect(getNormalizedModel("gpt-6")).toBeUndefined();
			expect(getNormalizedModel("")).toBeUndefined();
		});
	});

	describe("resolveNormalizedModel", () => {
		it("resolves provider-prefixed and verbose GPT-5 variants", () => {
			expect(resolveNormalizedModel("openai/gpt-5.4")).toBe("gpt-5.4");
			expect(resolveNormalizedModel("openai/gpt-5.4-mini-high")).toBe("gpt-5-mini");
			expect(resolveNormalizedModel("GPT 5.4 Pro High")).toBe("gpt-5.4-pro");
			expect(resolveNormalizedModel("GPT 5 Codex Low (ChatGPT Subscription)")).toBe("gpt-5-codex");
		});

		it("defaults unknown GPT-5-ish requests to GPT-5.4 instead of GPT-5.1", () => {
			expect(resolveNormalizedModel("gpt-5-unknown-preview")).toBe("gpt-5.4");
			expect(resolveNormalizedModel("gpt 5 experimental build")).toBe("gpt-5.4");
		});

		it("uses the current default model when the request is missing or unrelated", () => {
			expect(resolveNormalizedModel(undefined)).toBe(DEFAULT_MODEL);
			expect(resolveNormalizedModel("")).toBe(DEFAULT_MODEL);
			expect(resolveNormalizedModel("gpt-4")).toBe(DEFAULT_MODEL);
			expect(resolveNormalizedModel("unknown-model")).toBe(DEFAULT_MODEL);
		});
	});

	describe("model profiles", () => {
		it("routes GPT-5.4-era general models through the latest available general prompt family", () => {
			expect(getModelProfile("gpt-5.4").promptFamily).toBe("gpt-5.2");
			expect(getModelProfile("gpt-5.4-pro").promptFamily).toBe("gpt-5.2");
			expect(getModelProfile("gpt-5-mini").promptFamily).toBe("gpt-5.2");
		});

		it("keeps GPT-5.1 on its own prompt family", () => {
			expect(getModelProfile("gpt-5.1").promptFamily).toBe("gpt-5.1");
		});

		it("exposes tool-search and computer-use capabilities", () => {
			expect(getModelCapabilities("gpt-5.4")).toEqual({
				toolSearch: true,
				computerUse: true,
			});
			expect(getModelCapabilities("gpt-5.4-pro")).toEqual({
				toolSearch: false,
				computerUse: true,
			});
			expect(getModelCapabilities("gpt-5-mini")).toEqual({
				toolSearch: false,
				computerUse: false,
			});
		});
	});

	describe("isKnownModel", () => {
		it("returns true for explicit aliases only", () => {
			expect(isKnownModel("gpt-5.4")).toBe(true);
			expect(isKnownModel("gpt-5.4-mini")).toBe(true);
			expect(isKnownModel("GPT-5.3-CODEX-HIGH")).toBe(true);
		});

		it("returns false for unknown names even though fallback routing exists", () => {
			expect(isKnownModel("gpt-5-unknown-preview")).toBe(false);
			expect(isKnownModel("claude-3")).toBe(false);
			expect(isKnownModel("")).toBe(false);
		});
	});
});
