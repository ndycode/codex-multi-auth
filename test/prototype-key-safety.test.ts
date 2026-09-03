import { describe, expect, it } from "vitest";
import { estimateUsageCostUsd, getUsageModelPricing } from "../lib/usage/pricing.js";
import { resolveUnsupportedCodexFallbackModel } from "../lib/request/error-classification.js";
import { getUnsupportedCodexFallbackChain } from "../lib/config.js";
import { buildModelCapabilityMatrix } from "../lib/model-capability-matrix.js";
import type { AccountStorageV3 } from "../lib/storage.js";

/**
 * Model ids reach these tables straight from the caller.
 *
 * `createUsageLedgerRow` only trims `input.model`, the proxy copies `body.model`
 * verbatim, and `models --model <x>` passes the flag through. So the string
 * indexing these plain objects can be any `Object.prototype` member name, and a
 * bare index then returns that member rather than `undefined`. It is truthy, so
 * every "did we find one?" guard passes it along, and the caller gets a value
 * whose fields are all undefined.
 *
 * Found by a release-gate stress probe on the 2.11.0 cycle. Each case below
 * failed before the fix.
 */
const PROTOTYPE_KEYS = [
	"constructor",
	"__proto__",
	"toString",
	"valueOf",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
];

describe("prototype keys cannot masquerade as model ids", () => {
	describe("usage pricing", () => {
		it("reports no rate rather than a prototype member", () => {
			for (const key of PROTOTYPE_KEYS) {
				expect(getUsageModelPricing(key), key).toBeNull();
			}
		});

		it("returns null cost, never NaN", () => {
			// NaN is worse than unknown here. `evaluateBudgetGuard` fails closed on
			// a null cost, but `NaN >= limit` is false, so a NaN silently makes a
			// `maxCostUsd` budget unenforceable instead.
			for (const key of PROTOTYPE_KEYS) {
				const cost = estimateUsageCostUsd(key, {
					inputTokens: 1_000_000,
					cachedInputTokens: 0,
					outputTokens: 1_000_000,
					reasoningTokens: 0,
				});
				expect(cost, `${key} priced at ${cost}`).toBeNull();
			}
		});
	});

	describe("unsupported-model fallback chain", () => {
		const unsupportedBody = {
			error: {
				message: "model is not supported when using codex with a chatgpt account",
			},
		};

		it("resolves no fallback instead of throwing `targets is not iterable`", () => {
			// `chain["constructor"]` returned the Object constructor: truthy, and
			// its `.length` is 1, so the emptiness check passed and the `for...of`
			// threw inside the request path.
			for (const key of PROTOTYPE_KEYS) {
				const resolve = () =>
					resolveUnsupportedCodexFallbackModel({
						requestedModel: key,
						errorBody: unsupportedBody,
						fallbackOnUnsupportedCodexModel: true,
						fallbackToGpt52OnUnsupportedGpt53: true,
					});

				expect(resolve, key).not.toThrow();
				expect(resolve(), key).toBeUndefined();
			}
		});

		it("survives a custom chain carrying a non-array value", () => {
			expect(() =>
				resolveUnsupportedCodexFallbackModel({
					requestedModel: "gpt-6-astra",
					errorBody: unsupportedBody,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
					customChain: { "gpt-6-astra": "gpt-5.5" } as unknown as Record<
						string,
						string[]
					>,
				}),
			).not.toThrow();
		});
	});

	describe("config-supplied fallback chain", () => {
		it("does not let a `__proto__` key reassign the returned object's prototype", () => {
			const chain = getUnsupportedCodexFallbackChain({
				unsupportedCodexFallbackChain: {
					__proto__: ["gpt-5.4"],
					"gpt-6-astra": ["gpt-5.6-sol"],
				},
			} as never);

			expect(Array.isArray(Object.getPrototypeOf(chain))).toBe(false);
			expect(chain["gpt-6-astra"]).toEqual(["gpt-5.6-sol"]);
			// Nothing inherited leaks through as a row.
			expect(chain["toString"]).toBeUndefined();
		});
	});

	describe("model capability matrix", () => {
		it("emits no row for a prototype key instead of one with undefined fields", () => {
			const storage = {
				version: 3,
				accounts: [
					{
						index: 0,
						email: "a@example.com",
						accountId: "acc_1",
						accessToken: "t",
						refreshToken: "r",
						lastUsed: 0,
					},
				],
			} as unknown as AccountStorageV3;

			for (const key of PROTOTYPE_KEYS) {
				const matrix = buildModelCapabilityMatrix({
					storage,
					models: [key],
					now: 1_000,
				} as never);
				// Non-vacuous by construction: the key resolves to DEFAULT_MODEL, so
				// a row IS emitted and the assertions below actually run. Without
				// this, a future change that dropped the row entirely would leave
				// this test green while proving nothing.
				expect(matrix.entries.length, `${key} produced no rows at all`).toBeGreaterThan(0);
				for (const entry of matrix.entries) {
					expect(
						entry.normalizedModel,
						`${key} produced a row with normalizedModel ${entry.normalizedModel}`,
					).toBeTypeOf("string");
					expect(entry.promptFamily, key).toBeTypeOf("string");
					expect(Array.isArray(entry.supportedReasoningEfforts), key).toBe(true);
				}
			}
		});
	});
});
