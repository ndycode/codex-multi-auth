import * as fc from "fast-check";

export const arbAccountIndex = fc.integer({ min: 0, max: 19 });

export const arbHealthScore = fc.integer({ min: 0, max: 100 });

export const arbTimestamp = fc.integer({ min: 0, max: Date.now() + 86400000 });

export const arbQuotaKey = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(
    "default",
    "gpt-5.2",
    "gpt-5.3-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
  )
);

export const arbTokenBucketState = fc.record({
  tokens: fc.integer({ min: 0, max: 50 }),
  lastRefill: arbTimestamp,
  maxTokens: fc.integer({ min: 10, max: 100 }),
  refillRate: fc.integer({ min: 1, max: 10 }),
});

export const arbHealthEntry = fc.record({
  score: arbHealthScore,
  lastUpdated: arbTimestamp,
  consecutiveFailures: fc.integer({ min: 0, max: 10 }),
});

export const arbAccountId = fc.uuid();

export const arbEmail = fc.emailAddress();

export const arbReasoningEffort = fc.constantFrom(
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
);

export const arbModel = fc.constantFrom(
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini"
);

export const arbMessageRole = fc.constantFrom("user", "assistant", "system");

export const arbMessageContent = fc.oneof(
  fc.string({ minLength: 0, maxLength: 1000 }),
  fc.array(
    fc.record({
      type: fc.constant("text"),
      text: fc.string({ minLength: 1, maxLength: 500 }),
    }),
    { minLength: 1, maxLength: 5 }
  )
);

export const arbInputItem = fc.record({
  id: fc.option(fc.uuid(), { nil: undefined }),
  type: fc.constant("message"),
  role: arbMessageRole,
  content: arbMessageContent,
});

export const arbRequestBody = fc.record({
  model: arbModel,
  store: fc.option(fc.boolean(), { nil: undefined }),
  stream: fc.option(fc.boolean(), { nil: undefined }),
  instructions: fc.option(fc.string({ minLength: 0, maxLength: 500 }), {
    nil: undefined,
  }),
  input: fc.array(arbInputItem, { minLength: 0, maxLength: 10 }),
});

export const arbPositiveInteger = fc.integer({ min: 1, max: 1000000 });

export const arbNonNegativeInteger = fc.integer({ min: 0, max: 1000000 });

export function arbArrayOfN<T>(arb: fc.Arbitrary<T>, n: number): fc.Arbitrary<T[]> {
  return fc.array(arb, { minLength: n, maxLength: n });
}

export const arbHttpStatusCode = fc.oneof(
  fc.constantFrom(200, 201, 204),
  fc.constantFrom(400, 401, 403, 404, 422, 429),
  fc.constantFrom(500, 502, 503, 504)
);

export const arbRateLimitHeaders = fc.record({
  "x-ratelimit-limit-requests": fc.option(fc.nat({ max: 1000 }).map(String), {
    nil: undefined,
  }),
  "x-ratelimit-remaining-requests": fc.option(fc.nat({ max: 1000 }).map(String), {
    nil: undefined,
  }),
  "x-ratelimit-reset-requests": fc.option(
    fc.integer({ min: 1, max: 3600 }).map((s) => `${s}s`),
    { nil: undefined }
  ),
});
