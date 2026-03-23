import { describe, expect, it } from "vitest";
import { __clearCacheForTesting, getModelFamily } from "../lib/prompts/codex.js";

describe("Codex Module", () => {
	describe("getModelFamily", () => {
		it("keeps codex variants on codex prompt families", () => {
			expect(getModelFamily("gpt-5.3-codex-spark")).toBe("gpt-5-codex");
			expect(getModelFamily("gpt-5.2-codex-high")).toBe("gpt-5-codex");
			expect(getModelFamily("gpt-5.1-codex-max-high")).toBe("codex-max");
			expect(getModelFamily("gpt-5.1-codex-mini-high")).toBe("gpt-5-codex");
			expect(getModelFamily("codex-mini-latest")).toBe("gpt-5-codex");
		});

		it("routes GPT-5.4-era general models through the latest upstream general prompt family", () => {
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5-mini")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5-nano")).toBe("gpt-5.2");
		});

		it("keeps GPT-5.1 on its own prompt family", () => {
			expect(getModelFamily("gpt-5.1")).toBe("gpt-5.1");
			expect(getModelFamily("gpt-5.1-high")).toBe("gpt-5.1");
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
