import { describe, expect, it } from "vitest";
import { resolveNormalizedModel } from "../lib/request/helpers/model-map.js";
import { getReasoningConfig } from "../lib/request/request-transformer.js";

// The `codex-multi-auth-codex` wrapper (scripts/codex.js) runs before the
// TypeScript build, so it re-implements the model map instead of importing it.
// That duplication drifted once already (GPT-5.6 landed in lib but not the
// wrapper — issue #626), so this suite pins the wrapper's behaviour AND asserts
// it stays in parity with lib/request/helpers/model-map.ts.
//
// The wrapper normally forwards to the real Codex CLI on import; the import-only
// flag lets us load it for its exported helpers without launching anything.
process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY = "1";
const wrapper = (await import("../scripts/codex.js")) as {
	normalizeRequestedModel: (model: string) => string;
	coerceReasoningEffortForModel: (model: string, effort: string) => string;
	resolveModelFamilyForStatus: (model: string) => string | null;
	canonicalizeRequestedModelName: (model: string) => string;
};
// The wrapper reads the flag once, at import. Clear it immediately so it cannot
// leak into subprocesses that other wrapper tests spawn (which need real main()).
delete process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY;

describe("codex.js wrapper — GPT-5.6 model resolution", () => {
	it("maps each tier to its own canonical id", () => {
		expect(wrapper.normalizeRequestedModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
		expect(wrapper.normalizeRequestedModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
		expect(wrapper.normalizeRequestedModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
	});

	it("treats bare `gpt-5.6` and provider-prefixed ids as flagship Sol", () => {
		expect(wrapper.normalizeRequestedModel("gpt-5.6")).toBe("gpt-5.6-sol");
		expect(wrapper.normalizeRequestedModel("gpt-5.6-high")).toBe("gpt-5.6-sol");
		expect(wrapper.normalizeRequestedModel("openai/gpt-5.6")).toBe("gpt-5.6-sol");
	});

	it("keeps effort aliases on their own tier", () => {
		expect(wrapper.normalizeRequestedModel("gpt-5.6-terra-xhigh")).toBe("gpt-5.6-terra");
		expect(wrapper.normalizeRequestedModel("gpt-5.6-luna-max")).toBe("gpt-5.6-luna");
		expect(wrapper.normalizeRequestedModel("gpt-5.6-sol-ultra")).toBe("gpt-5.6-sol");
	});

	it("resolves unrecognised 5.6 ids to a 5.6 tier, never silently to 5.5", () => {
		expect(wrapper.normalizeRequestedModel("gpt-5.6-terra-fast")).toBe("gpt-5.6-terra");
		expect(wrapper.normalizeRequestedModel("gpt-5.6-sol-2026-06-26")).toBe("gpt-5.6-sol");
	});

	it("leaves the legacy `gpt-5` alias and Codex Max untouched", () => {
		expect(wrapper.normalizeRequestedModel("gpt-5")).toBe("gpt-5.5");
		expect(wrapper.normalizeRequestedModel("gpt-5.1-codex-max")).toBe("gpt-5.3-codex");
	});

	it("buckets 5.6 into the gpt-5.2 prompt family for status", () => {
		expect(wrapper.resolveModelFamilyForStatus("gpt-5.6-sol")).toBe("gpt-5.2");
		expect(wrapper.resolveModelFamilyForStatus("gpt-5.6-luna")).toBe("gpt-5.2");
	});

	it("strips 5.6 effort suffixes when canonicalizing", () => {
		expect(wrapper.canonicalizeRequestedModelName("gpt-5.6-sol-max")).toBe("gpt-5.6-sol");
		expect(wrapper.canonicalizeRequestedModelName("gpt-5.6-terra-ultra")).toBe(
			"gpt-5.6-terra",
		);
	});
});

describe("codex.js wrapper — reasoning-effort coercion", () => {
	it("upgrades `none`/`minimal` (rejected by 5.6) to a supported effort", () => {
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.6-sol", "none")).toBe("low");
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.6-terra", "minimal")).toBe("low");
	});

	it("never emits `ultra` on the wire — it rewrites to `max`", () => {
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.6-sol", "ultra")).toBe("max");
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.6-terra", "ultra")).toBe("max");
		// Luna has no `ultra`; it steps down to `max` too.
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.6-luna", "ultra")).toBe("max");
	});

	it("passes `max` through where supported", () => {
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.6-sol", "max")).toBe("max");
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.6-luna", "max")).toBe("max");
	});

	it("steps `max`/`ultra` down to the strongest tier a pre-5.6 model supports", () => {
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.5", "max")).toBe("xhigh");
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.5", "ultra")).toBe("xhigh");
		expect(wrapper.coerceReasoningEffortForModel("gpt-5.1", "ultra")).toBe("high");
	});
});

// The strongest guard: for a matrix of model ids the wrapper must resolve
// exactly what lib does. A future model-map edit that forgets the wrapper fails
// here instead of silently shipping a divergent CLI path.
describe("codex.js wrapper — parity with lib/request/helpers/model-map", () => {
	const MODEL_IDS = [
		"gpt-5.6",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.6-sol-max",
		"gpt-5.6-luna-max",
		"gpt-5.6-terra-fast",
		"openai/gpt-5.6",
		"gpt-5",
		"gpt-5.5",
		"gpt-5.5-pro",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.2",
		"gpt-5.1",
		"gpt-5.3-codex",
		"gpt-5.1-codex-max",
		"codex-max",
	];

	it.each(MODEL_IDS)("normalizes `%s` the same as lib", (id) => {
		expect(wrapper.normalizeRequestedModel(id)).toBe(resolveNormalizedModel(id));
	});

	// Effort coercion parity across the tiers whose supported-effort sets the
	// wrapper mirrors. lib's getReasoningConfig applies the same fallback + the
	// ultra->max wire rewrite, so the two must agree for every known effort.
	const COERCION_MODELS = [
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.5",
		"gpt-5.4",
		"gpt-5.1",
		"gpt-5.3-codex",
	];
	const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

	for (const model of COERCION_MODELS) {
		it.each(EFFORTS)(`coerces ${model} + %s the same as lib`, (effort) => {
			expect(wrapper.coerceReasoningEffortForModel(model, effort)).toBe(
				getReasoningConfig(model, { reasoningEffort: effort }).effort,
			);
		});
	}
});
