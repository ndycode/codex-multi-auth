import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	MODEL_PROFILES,
	QUOTA_PROBE_MODEL_CHAIN,
	RETIRED_MODEL_REPLACEMENTS,
	getModelProfile,
	resolveNormalizedModel,
} from "../lib/request/helpers/model-map.js";
import {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	resolveUnsupportedCodexFallbackModel,
} from "../lib/request/error-classification.js";
import { getUsageModelPricing } from "../lib/usage/pricing.js";
import { normalizeUsageLedgerRow } from "../lib/usage/redaction.js";

/**
 * Retired models: every id OpenAI's deprecations page lists as shut down, and
 * every slug the upstream Codex catalog removed (`gpt-5.4` carries
 * `retirement_at: 2026-08-31`). A retired id must never be sent under its own
 * name again, must still resolve (old configs keep working), and lib and the
 * wrapper (scripts/codex.js, which cannot import lib) must agree on where it
 * goes.
 */
process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY = "1";
const wrapper = (await import("../scripts/codex.js")) as {
	normalizeRequestedModel: (model: string) => string;
	resolveModelFamilyForStatus: (model: string) => string | null;
	WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN: Record<string, string[]>;
	RETIRED_MODEL_REPLACEMENTS: Record<string, string>;
};
delete process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY;

const RETIRED = Object.keys(RETIRED_MODEL_REPLACEMENTS);
const LIVE = new Set(Object.keys(MODEL_PROFILES));

describe("retired models", () => {
	it("covers every id OpenAI or upstream Codex retired", () => {
		// Pinned so a later edit cannot quietly drop one back into routing.
		expect(RETIRED.sort()).toEqual(
			[
				"codex-max",
				"codex-mini-latest",
				"gpt-5-chat-latest",
				"gpt-5-codex",
				"gpt-5-codex-mini",
				"gpt-5-mini",
				"gpt-5-nano",
				"gpt-5.1",
				"gpt-5.1-chat-latest",
				"gpt-5.1-codex",
				"gpt-5.1-codex-max",
				"gpt-5.1-codex-mini",
				"gpt-5.2",
				"gpt-5.2-chat-latest",
				"gpt-5.2-codex",
				"gpt-5.2-pro",
				"gpt-5.3-chat-latest",
				"gpt-5.3-codex",
				"gpt-5.3-codex-spark",
				"gpt-5.4",
				"gpt-5.4-mini",
				"gpt-5.4-nano",
				"gpt-5.4-pro",
				"gpt-5.5",
				"gpt-5.5-2026-04-23",
				"gpt-5.5-20260423",
				"gpt-5.5-pro",
				"gpt-5.5-pro-2026-04-23",
				"gpt-5.5-pro-20260423",
				"gpt-6-astra-aeon",
			].sort(),
		);
	});

	it("keeps no profile for a retired id, and only live replacements", () => {
		for (const [retired, replacement] of Object.entries(
			RETIRED_MODEL_REPLACEMENTS,
		)) {
			expect(LIVE.has(retired), `${retired} still has a profile`).toBe(false);
			expect(LIVE.has(replacement), `${retired} -> ${replacement}`).toBe(true);
		}
	});

	it.each(RETIRED)("resolves `%s` (and its effort variants) to its replacement", (id) => {
		const replacement = RETIRED_MODEL_REPLACEMENTS[id];
		for (const variant of [id, `${id}-high`, `openai/${id}`]) {
			expect(resolveNormalizedModel(variant), variant).toBe(replacement);
		}
		expect(getModelProfile(id).normalizedModel).toBe(replacement);
	});

	it("routes any unlisted codex id to Sol, and codex minis to Terra", () => {
		expect(resolveNormalizedModel("gpt-6-codex")).toBe("gpt-5.6-sol");
		expect(resolveNormalizedModel("gpt-5.7-codex-mini")).toBe("gpt-5.6-terra");
	});

	it("never probes a retired model", () => {
		for (const model of QUOTA_PROBE_MODEL_CHAIN) {
			expect(RETIRED, model).not.toContain(model);
			expect(LIVE.has(model), model).toBe(true);
		}
	});

	it("gives every retired id one fallback hop to its replacement", () => {
		const body = {
			error: {
				message:
					"'gpt-5.4' model is not supported when using codex with a chatgpt account",
			},
		};
		for (const [retired, replacement] of Object.entries(
			RETIRED_MODEL_REPLACEMENTS,
		)) {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[retired]).toEqual([
				replacement,
			]);
			expect(
				resolveUnsupportedCodexFallbackModel({
					requestedModel: retired,
					errorBody: body,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				}),
				retired,
			).toBe(replacement);
		}
	});

	it("walks every retired id down to a live floor model", () => {
		// With `gpt-5.5` retired the general staircase ends on the Luna tiers
		// (broadest plan coverage) or `gpt-5.6-sol`, the workhorse every codex
		// request shares. Whichever a given walk reaches last, it must be live.
		const body = {
			error: {
				message:
					"'x' model is not supported when using codex with a chatgpt account",
			},
		};
		for (const retired of RETIRED) {
			const attempted = new Set([retired]);
			let model: string | undefined = retired;
			let last = retired;
			for (let i = 0; i < 10 && model; i += 1) {
				model = resolveUnsupportedCodexFallbackModel({
					requestedModel: model,
					errorBody: body,
					attemptedModels: attempted,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});
				if (model) {
					attempted.add(model);
					last = model;
				}
			}
			expect(
				["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-luna"],
				`${retired} ends at ${last}`,
			).toContain(last);
		}
	});

	it("does not read a `codex-minimal` effort suffix as a codex mini", () => {
		expect(resolveNormalizedModel("gpt_5_codex-minimal")).toBe("gpt-5.6-sol");
		expect(wrapper.normalizeRequestedModel("gpt_5_codex-minimal")).toBe("gpt-5.6-sol");
		expect(resolveNormalizedModel("my-codex-mini-build")).toBe("gpt-5.6-terra");
	});

	it("resolves `-max`/`-ultra` forms of retired ids to the replacement", () => {
		// These efforts are not generated as aliases for pre-5.6 ids, so the
		// general GPT-5 resolver used to claim them and return gpt-5.5.
		for (const id of ["gpt-5-chat-latest-max", "gpt-5.3-chat-latest-ultra", "gpt-5.2-max", "gpt-5.4-ultra"]) {
			const expected = RETIRED_MODEL_REPLACEMENTS[id.replace(/-(max|ultra)$/, "")];
			expect(resolveNormalizedModel(id), id).toBe(expected);
			expect(wrapper.normalizeRequestedModel(id), id).toBe(expected);
		}
	});

	it("never falls back onto a retired model", () => {
		for (const [from, targets] of Object.entries(
			DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
		)) {
			for (const target of targets) {
				expect(RETIRED, `${from} -> ${target}`).not.toContain(target);
			}
		}
	});

	it("prices a retired id at its replacement's rate", () => {
		// The proxy records the raw client model, so a new `gpt-5-codex` row ran
		// on `gpt-5.6-sol`. It used to be priced at the retired $1.25/$10 rate,
		// under-counting a maxCostUsd budget 4x on input.
		for (const [retired, replacement] of Object.entries(
			RETIRED_MODEL_REPLACEMENTS,
		)) {
			expect(getUsageModelPricing(retired), retired).toEqual(
				getUsageModelPricing(replacement),
			);
		}
		expect(getUsageModelPricing("gpt-5-codex")?.inputUsdPerMillion).toBe(5);
	});

	it("leaves costs already written to the ledger alone", () => {
		// History is safe without the retired rows: a stored costUsd is read
		// back as-is, never re-priced.
		const row = normalizeUsageLedgerRow({
			outcome: "success",
			model: "gpt-5.3-codex",
			inputTokens: 1_000_000,
			outputTokens: 0,
			costUsd: 1.25,
		});
		expect(row.costUsd).toBe(1.25);
	});

	it("lists no retired model in either config template", () => {
		for (const file of ["config/codex-modern.json", "config/codex-legacy.json"]) {
			const models = Object.keys(
				(
					JSON.parse(readFileSync(file, "utf8")) as {
						provider: { openai: { models: Record<string, unknown> } };
					}
				).provider.openai.models,
			);
			for (const model of models) {
				// Legacy entries are `<model>-<effort>`; strip the effort to get the id.
				const id = model.replace(/-(none|minimal|low|medium|high|xhigh|max|ultra)$/, "");
				expect(LIVE.has(id), `${file}: ${model} is not a live model`).toBe(true);
			}
		}
	});
});

describe("retired models: wrapper parity", () => {
	it("carries the same replacement table as lib", () => {
		expect(wrapper.RETIRED_MODEL_REPLACEMENTS).toEqual(RETIRED_MODEL_REPLACEMENTS);
	});

	it.each(RETIRED)("normalizes `%s` the same as lib", (id) => {
		for (const variant of [id, `${id}-xhigh`, `openai/${id}`]) {
			expect(wrapper.normalizeRequestedModel(variant), variant).toBe(
				resolveNormalizedModel(variant),
			);
		}
	});

	it.each(RETIRED)("carries lib's fallback row for `%s`", (id) => {
		expect(wrapper.WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN[id]).toEqual(
			DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[id],
		);
	});

	it("reports the replacement's family for a retired general id", () => {
		// Codex ids stay in the `codex` status bucket (unchanged); every retired
		// general id now runs on a model in the gpt-5.2 prompt family.
		for (const id of ["gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5-mini"]) {
			expect(wrapper.resolveModelFamilyForStatus(id), id).toBe(
				getModelProfile(id).promptFamily,
			);
		}
	});
});
