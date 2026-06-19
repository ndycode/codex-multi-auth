import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	resolveUnsupportedCodexFallbackModel,
} from "../../lib/request/fetch-helpers.js";

// The canonical model names the default fallback chain knows about, plus the
// reasoning-effort suffixes and provider prefixes the canonicalizer strips.
const CHAIN_MODELS = Object.keys(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN);
const EFFORT_SUFFIXES = ["", "-none", "-minimal", "-low", "-medium", "-high", "-xhigh"];
const PREFIXES = ["", "openai/", "models/"];

const arbChainModel = fc.constantFrom(...CHAIN_MODELS);

// A spelled variant of a chain model that must canonicalize back to it:
// optional provider prefix, optional effort suffix, arbitrary casing.
const arbSpelledModel = fc
	.tuple(
		arbChainModel,
		fc.constantFrom(...PREFIXES),
		fc.constantFrom(...EFFORT_SUFFIXES),
		fc.boolean(),
	)
	.map(([model, prefix, suffix, upper]) => ({
		canonical: model,
		spelled: upper
			? `${prefix}${model}${suffix}`.toUpperCase()
			: `${prefix}${model}${suffix}`,
	}));

const UNSUPPORTED_BODY = {
	error: {
		message:
			"The requested model is not supported when using Codex with a ChatGPT account.",
	},
};

// Mirror of the resolver's canonicalizeModelName transform (lowercase, strip
// provider prefix and reasoning-effort suffix) so the expected chain stays
// valid even if a future chain entry is added in a non-canonical spelling.
function canonicalize(model: string): string {
	const stripped = model.trim().toLowerCase();
	const tail = stripped.includes("/")
		? (stripped.split("/").pop() ?? stripped)
		: stripped;
	return tail.replace(/-(none|minimal|low|medium|high|xhigh)$/i, "");
}

function canonicalChainTargets(model: string): string[] {
	return (DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[model] ?? []).map(
		canonicalize,
	);
}

describe("resolveUnsupportedCodexFallbackModel properties", () => {
	it("never falls back when the feature toggle is off", () => {
		fc.assert(
			fc.property(arbSpelledModel, ({ spelled }) => {
				expect(
					resolveUnsupportedCodexFallbackModel({
						requestedModel: spelled,
						errorBody: UNSUPPORTED_BODY,
						fallbackOnUnsupportedCodexModel: false,
						fallbackToGpt52OnUnsupportedGpt53: true,
					}),
				).toBeUndefined();
			}),
		);
	});

	it("never falls back when the error body is not an unsupported-model error", () => {
		fc.assert(
			fc.property(
				arbSpelledModel,
				fc.oneof(
					fc.constant(null),
					fc.constant("plain text"),
					fc.record({ error: fc.record({ message: fc.constant("rate limited") }) }),
				),
				({ spelled }, errorBody) => {
					expect(
						resolveUnsupportedCodexFallbackModel({
							requestedModel: spelled,
							errorBody,
							fallbackOnUnsupportedCodexModel: true,
							fallbackToGpt52OnUnsupportedGpt53: true,
						}),
					).toBeUndefined();
				},
			),
		);
	});

	it("only ever returns a chain member that is neither current nor attempted", () => {
		fc.assert(
			fc.property(
				arbSpelledModel,
				fc.uniqueArray(arbChainModel, { maxLength: 6 }),
				fc.boolean(),
				({ canonical, spelled }, attemptedModels, legacyEdge) => {
					const result = resolveUnsupportedCodexFallbackModel({
						requestedModel: spelled,
						errorBody: UNSUPPORTED_BODY,
						attemptedModels,
						fallbackOnUnsupportedCodexModel: true,
						fallbackToGpt52OnUnsupportedGpt53: legacyEdge,
					});

					if (result === undefined) return;
					// Any spelling of the requested model resolves through the same
					// canonical chain entry.
					expect(canonicalChainTargets(canonical)).toContain(result);
					expect(result).not.toBe(canonical);
					expect(attemptedModels).not.toContain(result);
					if (!legacyEdge && canonical === "gpt-5.3-codex") {
						expect(result).not.toBe("gpt-5.2-codex");
					}
				},
			),
		);
	});

	it("returns the first chain target when nothing was attempted", () => {
		fc.assert(
			fc.property(arbSpelledModel, ({ canonical, spelled }) => {
				const result = resolveUnsupportedCodexFallbackModel({
					requestedModel: spelled,
					errorBody: UNSUPPORTED_BODY,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});

				const [firstTarget] = canonicalChainTargets(canonical);
				expect(result).toBe(firstTarget);
			}),
		);
	});

	it("returns undefined once every chain target has been attempted", () => {
		fc.assert(
			fc.property(arbSpelledModel, ({ canonical, spelled }) => {
				expect(
					resolveUnsupportedCodexFallbackModel({
						requestedModel: spelled,
						errorBody: UNSUPPORTED_BODY,
						attemptedModels: canonicalChainTargets(canonical),
						fallbackOnUnsupportedCodexModel: true,
						fallbackToGpt52OnUnsupportedGpt53: true,
					}),
				).toBeUndefined();
			}),
		);
	});

	it("treats attempted-model spellings the same as canonical names", () => {
		fc.assert(
			fc.property(
				arbSpelledModel,
				fc.constantFrom(...PREFIXES),
				fc.constantFrom(...EFFORT_SUFFIXES),
				({ canonical, spelled }, prefix, suffix) => {
					const targets = canonicalChainTargets(canonical);
					const [firstTarget] = targets;
					if (!firstTarget) return;
					// Attempting the first target under any spelling skips it.
					const result = resolveUnsupportedCodexFallbackModel({
						requestedModel: spelled,
						errorBody: UNSUPPORTED_BODY,
						attemptedModels: [`${prefix}${firstTarget}${suffix}`],
						fallbackOnUnsupportedCodexModel: true,
						fallbackToGpt52OnUnsupportedGpt53: true,
					});
					expect(result).not.toBe(firstTarget);
					if (result !== undefined) {
						expect(targets).toContain(result);
					}
				},
			),
		);
	});
});
