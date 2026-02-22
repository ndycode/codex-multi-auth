import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  normalizeModel,
  filterInput,
  getReasoningConfig,
} from "../../lib/request/request-transformer.js";
import type { InputItem } from "../../lib/types.js";
import { arbModel, arbMessageRole } from "./helpers.js";

describe("normalizeModel property tests", () => {
  it("always returns a non-empty string", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(undefined)),
        (model) => {
          const result = normalizeModel(model);
          expect(typeof result).toBe("string");
          expect(result.length).toBeGreaterThan(0);
          return true;
        }
      )
    );
  });

  it("strips provider prefix correctly", () => {
    fc.assert(
      fc.property(arbModel, (model) => {
        const withPrefix = `openai/${model}`;
        const result = normalizeModel(withPrefix);
        expect(result).not.toContain("/");
        return true;
      })
    );
  });

  it("normalization is idempotent", () => {
    fc.assert(
      fc.property(arbModel, (model) => {
        const first = normalizeModel(model);
        const second = normalizeModel(first);
        expect(first).toBe(second);
        return true;
      })
    );
  });

  it("handles undefined gracefully", () => {
    const result = normalizeModel(undefined);
    expect(result).toBe("gpt-5.1");
  });

  it("handles empty string gracefully", () => {
    const result = normalizeModel("");
    expect(result).toBe("gpt-5.1");
  });
});

describe("filterInput property tests", () => {
  const arbInputItem = fc.record({
    id: fc.option(fc.uuid(), { nil: undefined }),
    type: fc.constantFrom("message", "function_call", "function_call_output", "item_reference"),
    role: arbMessageRole,
    content: fc.string({ minLength: 0, maxLength: 100 }),
  });

  const arbInputArray = fc.array(arbInputItem, { minLength: 0, maxLength: 20 });

  it("returns undefined for non-array input", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant(null)),
        (input) => {
          const result = filterInput(input as InputItem[] | undefined);
          expect(result).toBe(input);
          return true;
        }
      )
    );
  });

  it("removes all item_reference types", () => {
    fc.assert(
      fc.property(arbInputArray, (input) => {
        const result = filterInput(input as InputItem[]);
        if (result) {
          const hasItemReference = result.some((item) => item.type === "item_reference");
          expect(hasItemReference).toBe(false);
        }
        return true;
      })
    );
  });

  it("strips all id properties from output", () => {
    fc.assert(
      fc.property(arbInputArray, (input) => {
        const result = filterInput(input as InputItem[]);
        if (result) {
          for (const item of result) {
            expect(item.id).toBeUndefined();
          }
        }
        return true;
      })
    );
  });

  it("preserves message content", () => {
    fc.assert(
      fc.property(arbInputArray, (input) => {
        const messages = input.filter((item) => item.type === "message");
        const result = filterInput(input as InputItem[]);
        if (result) {
          const resultMessages = result.filter((item) => item.type === "message");
          expect(resultMessages.length).toBe(messages.length);
          for (let i = 0; i < messages.length; i++) {
            expect(resultMessages[i]?.content).toBe(messages[i]?.content);
          }
        }
        return true;
      })
    );
  });

  it("output length is less than or equal to input length", () => {
    fc.assert(
      fc.property(arbInputArray, (input) => {
        const result = filterInput(input as InputItem[]);
        if (result) {
          expect(result.length).toBeLessThanOrEqual(input.length);
        }
        return true;
      })
    );
  });
});

describe("getReasoningConfig property tests", () => {
  const arbReasoningEffort = fc.constantFrom(
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  );

  const arbReasoningSummary = fc.constantFrom(
    "auto",
    "concise",
    "detailed",
    "off",
    "on"
  );

  it("always returns valid effort level", () => {
    fc.assert(
      fc.property(
        fc.option(arbModel, { nil: undefined }),
        fc.record({
          reasoningEffort: fc.option(arbReasoningEffort, { nil: undefined }),
          reasoningSummary: fc.option(arbReasoningSummary, { nil: undefined }),
        }),
        (model, config) => {
          const result = getReasoningConfig(model, config);
          expect(["none", "minimal", "low", "medium", "high", "xhigh"]).toContain(result.effort);
          return true;
        }
      )
    );
  });

  it("always returns valid summary level", () => {
    fc.assert(
      fc.property(
        fc.option(arbModel, { nil: undefined }),
        fc.record({
          reasoningEffort: fc.option(arbReasoningEffort, { nil: undefined }),
          reasoningSummary: fc.option(arbReasoningSummary, { nil: undefined }),
        }),
        (model, config) => {
          const result = getReasoningConfig(model, config);
          expect(["auto", "concise", "detailed", "off", "on"]).toContain(result.summary);
          return true;
        }
      )
    );
  });

  it("codex-mini never returns none or minimal effort", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("gpt-5.1-codex-mini", "codex-mini-latest"),
        arbReasoningEffort,
        (model, effort) => {
          const result = getReasoningConfig(model, { reasoningEffort: effort });
          expect(["none", "minimal", "low"]).not.toContain(result.effort);
          expect(["medium", "high"]).toContain(result.effort);
          return true;
        }
      )
    );
  });

  it("non-xhigh models downgrade xhigh to high", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("gpt-5.1", "gpt-5.1-codex"),
        (model) => {
          const result = getReasoningConfig(model, { reasoningEffort: "xhigh" });
          expect(result.effort).toBe("high");
          return true;
        }
      )
    );
  });

	  it("codex models upgrade none to low", () => {
	    fc.assert(
	      fc.property(
	        fc.constantFrom(
	          "gpt-5.1-codex",
	          "gpt-5.2-codex",
	          "gpt-5.3-codex",
	          "gpt-5.1-codex-max",
	        ),
	        (model) => {
	          const result = getReasoningConfig(model, { reasoningEffort: "none" });
	          expect(result.effort).not.toBe("none");
          return true;
        }
      )
    );
  });

  it("gpt-5.1 and gpt-5.2 general support none effort", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("gpt-5.1", "gpt-5.2"),
        (model) => {
          const result = getReasoningConfig(model, { reasoningEffort: "none" });
          expect(result.effort).toBe("none");
          return true;
        }
      )
    );
  });

  it("undefined model returns valid config", () => {
    const result = getReasoningConfig(undefined);
    expect(result.effort).toBeDefined();
    expect(result.summary).toBeDefined();
  });
});
