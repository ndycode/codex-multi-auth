import { describe, it, expect } from "vitest";
import { MODEL_MAP, getNormalizedModel, isKnownModel } from "../lib/request/helpers/model-map.js";

describe("Model Map Module", () => {
  describe("MODEL_MAP", () => {
    it("contains canonical GPT-5 codex mappings", () => {
      expect(MODEL_MAP["gpt-5-codex"]).toBe("gpt-5-codex");
      expect(MODEL_MAP["gpt-5-codex-low"]).toBe("gpt-5-codex");
      expect(MODEL_MAP["gpt-5-codex-medium"]).toBe("gpt-5-codex");
      expect(MODEL_MAP["gpt-5-codex-high"]).toBe("gpt-5-codex");
    });

    it("contains GPT-5.1 codex-max models", () => {
      expect(MODEL_MAP["gpt-5.1-codex-max"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-low"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-medium"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-high"]).toBe("gpt-5.1-codex-max");
      expect(MODEL_MAP["gpt-5.1-codex-max-xhigh"]).toBe("gpt-5.1-codex-max");
    });

    it("contains GPT-5.2 models", () => {
      expect(MODEL_MAP["gpt-5.2"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-none"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-low"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-medium"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-high"]).toBe("gpt-5.2");
      expect(MODEL_MAP["gpt-5.2-xhigh"]).toBe("gpt-5.2");
    });

	    it("contains GPT-5.2 codex models", () => {
	      expect(MODEL_MAP["gpt-5.2-codex"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-low"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-medium"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-high"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.2-codex-xhigh"]).toBe("gpt-5-codex");
	    });

	    it("contains GPT-5.3 codex models", () => {
	      expect(MODEL_MAP["gpt-5.3-codex"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-low"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-medium"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-high"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-xhigh"]).toBe("gpt-5-codex");
	    });

	    it("contains GPT-5.3 codex spark models", () => {
	      expect(MODEL_MAP["gpt-5.3-codex-spark"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-spark-low"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-spark-medium"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-spark-high"]).toBe("gpt-5-codex");
	      expect(MODEL_MAP["gpt-5.3-codex-spark-xhigh"]).toBe("gpt-5-codex");
	    });

    it("contains GPT-5.1 codex-mini models", () => {
      expect(MODEL_MAP["gpt-5.1-codex-mini"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5.1-codex-mini-medium"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5.1-codex-mini-high"]).toBe("gpt-5.1-codex-mini");
    });

    it("contains GPT-5.1 general purpose models", () => {
      expect(MODEL_MAP["gpt-5.1"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-none"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-low"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-medium"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-high"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5.1-chat-latest"]).toBe("gpt-5.1");
    });

    it("keeps canonical GPT-5 codex mapping stable", () => {
      expect(MODEL_MAP["gpt-5-codex"]).toBe("gpt-5-codex");
    });

    it("maps legacy codex-mini models to GPT-5.1 codex-mini", () => {
      expect(MODEL_MAP["codex-mini-latest"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5-codex-mini"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5-codex-mini-medium"]).toBe("gpt-5.1-codex-mini");
      expect(MODEL_MAP["gpt-5-codex-mini-high"]).toBe("gpt-5.1-codex-mini");
    });

    it("maps legacy GPT-5 general purpose models to GPT-5.1", () => {
      expect(MODEL_MAP["gpt-5"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5-mini"]).toBe("gpt-5.1");
      expect(MODEL_MAP["gpt-5-nano"]).toBe("gpt-5.1");
    });
  });

  describe("getNormalizedModel", () => {
	    it("returns normalized model for exact match", () => {
	      expect(getNormalizedModel("gpt-5.1-codex")).toBe("gpt-5-codex");
	      expect(getNormalizedModel("gpt-5.1-codex-low")).toBe("gpt-5-codex");
	      expect(getNormalizedModel("gpt-5.2-codex-high")).toBe("gpt-5-codex");
	      expect(getNormalizedModel("gpt-5.3-codex-high")).toBe("gpt-5-codex");
	      expect(getNormalizedModel("gpt-5.3-codex-spark-high")).toBe("gpt-5-codex");
	    });

	    it("handles case-insensitive lookup", () => {
	      expect(getNormalizedModel("GPT-5.1-CODEX")).toBe("gpt-5-codex");
	      expect(getNormalizedModel("Gpt-5.2-Codex-High")).toBe("gpt-5-codex");
	      expect(getNormalizedModel("Gpt-5.3-Codex-High")).toBe("gpt-5-codex");
	      expect(getNormalizedModel("Gpt-5.3-Codex-Spark-High")).toBe("gpt-5-codex");
	    });

    it("returns undefined for unknown models", () => {
      expect(getNormalizedModel("unknown-model")).toBeUndefined();
      expect(getNormalizedModel("gpt-6")).toBeUndefined();
      expect(getNormalizedModel("")).toBeUndefined();
    });

    it("handles legacy model mapping", () => {
      expect(getNormalizedModel("gpt-5-codex")).toBe("gpt-5-codex");
      expect(getNormalizedModel("gpt-5")).toBe("gpt-5.1");
      expect(getNormalizedModel("codex-mini-latest")).toBe("gpt-5.1-codex-mini");
    });

    it("strips reasoning effort suffix and normalizes", () => {
      expect(getNormalizedModel("gpt-5.1-codex-max-xhigh")).toBe("gpt-5.1-codex-max");
      expect(getNormalizedModel("gpt-5.2-medium")).toBe("gpt-5.2");
    });
  });

  describe("isKnownModel", () => {
	    it("returns true for known models", () => {
	      expect(isKnownModel("gpt-5.1-codex")).toBe(true);
	      expect(isKnownModel("gpt-5.2")).toBe(true);
	      expect(isKnownModel("gpt-5.3-codex")).toBe(true);
	      expect(isKnownModel("gpt-5.3-codex-spark")).toBe(true);
	      expect(isKnownModel("gpt-5.1-codex-max")).toBe(true);
	      expect(isKnownModel("gpt-5-codex")).toBe(true);
	    });

	    it("returns true for case-insensitive matches", () => {
	      expect(isKnownModel("GPT-5.1-CODEX")).toBe(true);
	      expect(isKnownModel("GPT-5.2-CODEX-HIGH")).toBe(true);
	      expect(isKnownModel("GPT-5.3-CODEX-HIGH")).toBe(true);
	      expect(isKnownModel("GPT-5.3-CODEX-SPARK-HIGH")).toBe(true);
	    });

    it("returns false for unknown models", () => {
      expect(isKnownModel("gpt-6")).toBe(false);
      expect(isKnownModel("claude-3")).toBe(false);
      expect(isKnownModel("unknown")).toBe(false);
      expect(isKnownModel("")).toBe(false);
    });
  });

  describe("Model count and completeness", () => {
    it("has expected number of model mappings", () => {
      const modelCount = Object.keys(MODEL_MAP).length;
      expect(modelCount).toBeGreaterThanOrEqual(30);
    });

    it("all values are valid normalized model names", () => {
      const validNormalizedModels = new Set([
        "gpt-5-codex",
        "gpt-5.1-codex-max",
	        "gpt-5.1-codex-mini",
	        "gpt-5.1",
	        "gpt-5.2",
	      ]);

      for (const [key, value] of Object.entries(MODEL_MAP)) {
        expect(validNormalizedModels.has(value)).toBe(true);
      }
    });

    it("no duplicate keys exist", () => {
      const keys = Object.keys(MODEL_MAP);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });
  });
});
