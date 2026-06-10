import * as fc from "fast-check";

export const arbAccountIndex = fc.integer({ min: 0, max: 19 });

export const arbHealthScore = fc.integer({ min: 0, max: 100 });

const arbTimestamp = fc.integer({ min: 0, max: Date.now() + 86400000 });

export const arbQuotaKey = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(
    "default",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
  )
);

export const arbModel = fc.constantFrom(
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini"
);

export const arbMessageRole = fc.constantFrom("user", "assistant", "system");

const arbMessageContent = fc.oneof(
  fc.string({ minLength: 0, maxLength: 1000 }),
  fc.array(
    fc.record({
      type: fc.constant("text"),
      text: fc.string({ minLength: 1, maxLength: 500 }),
    }),
    { minLength: 1, maxLength: 5 }
  )
);

const arbInputItem = fc.record({
  id: fc.option(fc.uuid(), { nil: undefined }),
  type: fc.constant("message"),
  role: arbMessageRole,
  content: arbMessageContent,
});
