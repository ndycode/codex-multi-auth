import { describe, expect, it } from "vitest";
import { __clearCacheForTesting, getModelFamily } from "../lib/prompts/codex.js";

describe("Codex Module", () => {
	describe("getModelFamily", () => {
		it("puts retired codex variants on their replacement's general prompt family", () => {
			// Every codex model is retired; codex ids run on 5.6 Sol/Terra, which
			// use the gpt-5.2 prompt family.
			expect(getModelFamily("gpt-5.3-codex-spark")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.2-codex-high")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.1-codex-max-high")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.1-codex-mini-high")).toBe("gpt-5.2");
			expect(getModelFamily("codex-mini-latest")).toBe("gpt-5.2");
		});

		it("routes GPT-5.4/5.5-era general models through the latest upstream general prompt family", () => {
			expect(getModelFamily("gpt-5.5")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.5-pro-2026-04-23")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.5-pro-20260423")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.4-mini")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5-mini")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5-nano")).toBe("gpt-5.2");
		});

		it("puts retired GPT-5.1 on its replacement's prompt family", () => {
			expect(getModelFamily("gpt-5.1")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.1-high")).toBe("gpt-5.2");
		});

		it("falls back to the default model profile for unknown models", () => {
			expect(getModelFamily("unknown-model")).toBe("gpt-5.2");
			expect(getModelFamily("")).toBe("gpt-5.2");
		});
	});
});

describe("Codex Cache", () => {
	it("should clear prompt cache without error", () => {
		expect(() => __clearCacheForTesting()).not.toThrow();
	});
});
