import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
	CURRENT_CODEX_MODEL,
	DEFAULT_MODEL,
	getModelProfile,
	getNormalizedModel,
	MODEL_MAP,
	MODEL_PROFILES,
	resolveNormalizedModel,
} from "../../lib/request/helpers/model-map.js";

const PROFILE_KEYS = new Set(Object.keys(MODEL_PROFILES));
const MAP_KEYS = Object.keys(MODEL_MAP);

// Plausible model spellings: known aliases, synthesized GPT-5 family ids with
// varied separators/variants, codex spellings, and outright garbage.
const arbSynthesizedGpt5 = fc
	.record({
		minor: fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined }),
		variant: fc.constantFrom("", "mini", "nano", "pro", "codex"),
		separator: fc.constantFrom("-", ".", " "),
		suffix: fc.constantFrom("", "-latest", "-2026"),
	})
	.map(({ minor, variant, separator, suffix }) => {
		const base = minor === undefined ? "gpt-5" : `gpt-5.${minor}`;
		const withVariant = variant ? `${base}${separator}${variant}` : base;
		return `${withVariant}${suffix}`;
	});

const arbModelId = fc.oneof(
	fc.constantFrom(...MAP_KEYS),
	arbSynthesizedGpt5,
	fc.string({ maxLength: 24 }),
);

const arbPrefix = fc.constantFrom("", "openai/", "models/", "providers/openai/");

function randomizeCase(value: string, flips: boolean[]): string {
	return [...value]
		.map((char, index) =>
			flips[index % Math.max(1, flips.length)]
				? char.toUpperCase()
				: char.toLowerCase(),
		)
		.join("");
}

describe("model-map resolution property invariants", () => {
	it("resolveNormalizedModel always lands on a model with a profile", () => {
		fc.assert(
			fc.property(arbPrefix, arbModelId, (prefix, modelId) => {
				const resolved = resolveNormalizedModel(`${prefix}${modelId}`);
				// Closed world: whatever the input, the effective model must have a
				// profile entry — getModelProfile's DEFAULT_MODEL fallback exists
				// for defence, but no reachable resolution should need it.
				expect(PROFILE_KEYS.has(resolved)).toBe(true);
				expect(getModelProfile(`${prefix}${modelId}`)).toBe(
					MODEL_PROFILES[resolved],
				);
			}),
		);
	});

	it("resolution is idempotent: normalized outputs are fixpoints", () => {
		fc.assert(
			fc.property(arbPrefix, arbModelId, (prefix, modelId) => {
				const once = resolveNormalizedModel(`${prefix}${modelId}`);
				expect(resolveNormalizedModel(once)).toBe(once);
			}),
		);
	});

	it("provider prefixes and casing never change the resolution", () => {
		fc.assert(
			fc.property(
				arbModelId,
				arbPrefix,
				fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
				(modelId, prefix, flips) => {
					const plain = resolveNormalizedModel(modelId);
					expect(resolveNormalizedModel(`${prefix}${modelId}`)).toBe(plain);
					expect(resolveNormalizedModel(randomizeCase(modelId, flips))).toBe(
						plain,
					);
					// Combined pressure: prefix AND casing mutated together, so the
					// strip-then-fold pipeline is exercised as one path.
					expect(
						resolveNormalizedModel(randomizeCase(`${prefix}${modelId}`, flips)),
					).toBe(plain);
				},
			),
		);
	});

	it("unmapped ids mentioning codex resolve to the current codex model, never a general one", () => {
		fc.assert(
			fc.property(arbSynthesizedGpt5, fc.constantFrom("-", " "), (modelId, sep) => {
				const codexId = modelId.includes("codex")
					? modelId
					: `${modelId}${sep}codex`;
				fc.pre(getNormalizedModel(codexId) === undefined);
				expect(resolveNormalizedModel(codexId)).toBe(CURRENT_CODEX_MODEL);
			}),
		);
	});

	it("unmapped general GPT-5 spellings stay in the general family, codex-free", () => {
		fc.assert(
			fc.property(arbSynthesizedGpt5, (modelId) => {
				fc.pre(!modelId.includes("codex"));
				fc.pre(getNormalizedModel(modelId) === undefined);
				const resolved = resolveNormalizedModel(modelId);
				// A general-purpose GPT-5 request must never silently route to a
				// codex-tuned model (the inverse of the codex-dominance rule).
				expect(resolved.includes("codex")).toBe(false);
				expect(resolved.startsWith("gpt-5")).toBe(true);
			}),
		);
	});

	it("every explicit alias resolves to its mapped target under any spelling", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...MAP_KEYS),
				arbPrefix,
				fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
				(alias, prefix, flips) => {
					const target = MODEL_MAP[alias];
					expect(resolveNormalizedModel(`${prefix}${alias}`)).toBe(target);
					expect(
						resolveNormalizedModel(randomizeCase(`${prefix}${alias}`, flips)),
					).toBe(target);
				},
			),
		);
	});
});
