import { describe, expect, it } from "vitest";
import {
	getModelProfile,
	getNormalizedModel,
	isKnownModel,
	resolveNormalizedModel,
} from "../lib/request/helpers/model-map.js";
import {
	getModelConfig,
	getReasoningConfig,
} from "../lib/request/request-transformer.js";
import { estimateUsageCostUsd } from "../lib/usage/pricing.js";
import { REASONING_EFFORTS } from "../lib/constants.js";

describe("reasoning-effort suffix pattern", () => {
	// The suffix pattern is derived from REASONING_EFFORTS. Driving this test
	// from the same list means a new tier added to the union but missed by the
	// pattern fails here, rather than silently breaking suffix parsing. A
	// snapshot of the regex source would not catch that: a re-hardcoded list
	// matching today's tiers would still pass.
	const config = {
		global: {},
		models: {
			"gpt-5.6-sol": {
				variants: Object.fromEntries(
					REASONING_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]),
				),
			},
			// Keyed on the base id: selecting `-max` here would prove the suffix
			// was stripped off a model whose name merely ends in `-max`.
			"gpt-5.1-codex": {
				variants: { max: { reasoningEffort: "max" } },
			},
		},
	} as unknown as Parameters<typeof getModelConfig>[1];

	it.each(REASONING_EFFORTS)("parses the `%s` suffix off a model id", (effort) => {
		expect(getModelConfig(`gpt-5.6-sol-${effort}`, config).reasoningEffort).toBe(
			effort,
		);
	});

	it("never treats Codex Max's trailing `-max` as an effort suffix", () => {
		expect(getModelConfig("gpt-5.1-codex-max", config).reasoningEffort).not.toBe(
			"max",
		);
		expect(
			getModelConfig("gpt-5.1-codex-max", config).reasoningEffort,
		).toBeUndefined();
	});
});

describe("GPT-5.6 (Sol / Terra / Luna)", () => {
	describe("model resolution", () => {
		it("maps each tier to its own canonical id", () => {
			expect(getNormalizedModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
			expect(getNormalizedModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
			expect(getNormalizedModel("gpt-5.6-luna")).toBe("gpt-5.6-luna");
			expect(isKnownModel("gpt-5.6-terra")).toBe(true);
		});

		it("treats bare `gpt-5.6` as the flagship Sol tier", () => {
			expect(getNormalizedModel("gpt-5.6")).toBe("gpt-5.6-sol");
			expect(getNormalizedModel("gpt-5.6-high")).toBe("gpt-5.6-sol");
		});

		it("keeps effort aliases on their own tier", () => {
			expect(getNormalizedModel("gpt-5.6-terra-xhigh")).toBe("gpt-5.6-terra");
			expect(getNormalizedModel("gpt-5.6-luna-max")).toBe("gpt-5.6-luna");
			expect(getNormalizedModel("gpt-5.6-sol-ultra")).toBe("gpt-5.6-sol");
		});

		it("does not invent `none`/`minimal` aliases that GPT-5.6 rejects", () => {
			expect(getNormalizedModel("gpt-5.6-sol-none")).toBeUndefined();
			expect(getNormalizedModel("gpt-5.6-terra-minimal")).toBeUndefined();
		});

		it("does not invent an `ultra` alias for Luna", () => {
			expect(getNormalizedModel("gpt-5.6-luna-ultra")).toBeUndefined();
		});

		it("resolves unrecognised 5.6 ids to a 5.6 tier, never silently to 5.5", () => {
			expect(resolveNormalizedModel("gpt-5.6-terra-fast")).toBe("gpt-5.6-terra");
			expect(resolveNormalizedModel("gpt-5.6-luna-fast")).toBe("gpt-5.6-luna");
			expect(resolveNormalizedModel("gpt-5.6-sol-2026-06-26")).toBe("gpt-5.6-sol");
		});

		it("leaves the legacy `gpt-5` alias pointing at 5.5", () => {
			expect(getNormalizedModel("gpt-5")).toBe("gpt-5.5");
			expect(getNormalizedModel("gpt-5-high")).toBe("gpt-5.5");
		});

		it("does not disturb the Codex Max alias, which also ends in `-max`", () => {
			expect(getNormalizedModel("gpt-5.1-codex-max")).toBe("gpt-5.3-codex");
			expect(getNormalizedModel("codex-max")).toBe("gpt-5.3-codex");
		});
	});

	describe("reasoning effort", () => {
		it("mirrors the upstream per-tier defaults", () => {
			expect(getReasoningConfig("gpt-5.6-sol", {}).effort).toBe("low");
			expect(getReasoningConfig("gpt-5.6-terra", {}).effort).toBe("medium");
			expect(getReasoningConfig("gpt-5.6-luna", {}).effort).toBe("medium");
		});

		it("passes `max` through untouched", () => {
			expect(
				getReasoningConfig("gpt-5.6-sol", { reasoningEffort: "max" }).effort,
			).toBe("max");
			expect(
				getReasoningConfig("gpt-5.6-luna", { reasoningEffort: "max" }).effort,
			).toBe("max");
		});

		// Upstream `reasoning_effort_for_request` rewrites Ultra -> Max before the
		// request is sent, so `ultra` must never reach the API.
		it("rewrites `ultra` to `max` on the wire for Sol and Terra", () => {
			expect(
				getReasoningConfig("gpt-5.6-sol", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
			expect(
				getReasoningConfig("gpt-5.6-terra", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
		});

		it("still lands Luna on `max` when `ultra` is requested", () => {
			expect(
				getReasoningConfig("gpt-5.6-luna", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
		});

		it("steps `max`/`ultra` down to the strongest tier a pre-5.6 model supports", () => {
			expect(
				getReasoningConfig("gpt-5.5", { reasoningEffort: "max" }).effort,
			).toBe("xhigh");
			expect(
				getReasoningConfig("gpt-5.5", { reasoningEffort: "ultra" }).effort,
			).toBe("xhigh");
			expect(
				getReasoningConfig("gpt-5.1", { reasoningEffort: "ultra" }).effort,
			).toBe("high");
		});

		it("upgrades `none` to a supported effort, since no 5.6 tier accepts it", () => {
			const effort = getReasoningConfig("gpt-5.6-sol", {
				reasoningEffort: "none",
			}).effort;
			expect(effort).not.toBe("none");
			expect(effort).toBe("low");
		});
	});

	describe("effort suffix parsed from the model name", () => {
		// getModelConfig only surfaces an effort when the user's config declares a
		// matching `variants` entry, so the suffix parser is exercised through one.
		const config = {
			global: {},
			models: {
				"gpt-5.6-sol": {
					variants: {
						xhigh: { reasoningEffort: "xhigh" },
						max: { reasoningEffort: "max" },
						ultra: { reasoningEffort: "ultra" },
					},
				},
				"gpt-5-codex": {
					variants: { low: { reasoningEffort: "low" } },
				},
				// Deliberately keyed on the base id. A `-max` strip would wrongly
				// resolve `gpt-5.1-codex-max` onto this entry.
				"gpt-5.1-codex": {
					options: { textVerbosity: "high" },
				},
			},
		} as unknown as Parameters<typeof getModelConfig>[1];

		it("reads `max` and `ultra` off the model id", () => {
			expect(getModelConfig("gpt-5.6-sol-max", config).reasoningEffort).toBe(
				"max",
			);
			expect(getModelConfig("gpt-5.6-sol-ultra", config).reasoningEffort).toBe(
				"ultra",
			);
			expect(
				getModelConfig("openai/gpt-5.6-sol-ultra", config).reasoningEffort,
			).toBe("ultra");
		});

		it("still parses ordinary efforts, including on codex ids", () => {
			expect(getModelConfig("gpt-5.6-sol-xhigh", config).reasoningEffort).toBe(
				"xhigh",
			);
			expect(getModelConfig("gpt-5-codex-low", config).reasoningEffort).toBe(
				"low",
			);
		});

		it("does not strip `-max` off Codex Max, whose id merely ends that way", () => {
			// If `-max` were stripped, this would resolve onto the `gpt-5.1-codex`
			// entry above and pick up its textVerbosity.
			expect(getModelConfig("gpt-5.1-codex-max", config).textVerbosity).toBeUndefined();
			expect(getModelConfig("gpt-5.1-codex", config).textVerbosity).toBe("high");
		});
	});

	describe("profiles", () => {
		it("exposes ultra only where upstream does", () => {
			expect(getModelProfile("gpt-5.6-sol").supportedReasoningEfforts).toContain(
				"ultra",
			);
			expect(
				getModelProfile("gpt-5.6-terra").supportedReasoningEfforts,
			).toContain("ultra");
			expect(
				getModelProfile("gpt-5.6-luna").supportedReasoningEfforts,
			).not.toContain("ultra");
		});

		it("never advertises `none` for a 5.6 tier", () => {
			for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
				expect(
					getModelProfile(model).supportedReasoningEfforts,
				).not.toContain("none");
			}
		});
	});

	describe("pricing", () => {
		it("prices each tier per the published rates", () => {
			const tokens = {
				inputTokens: 1_000_000,
				outputTokens: 0,
				cachedInputTokens: 0,
				reasoningTokens: 0,
				totalTokens: 1_000_000,
			};
			expect(estimateUsageCostUsd("gpt-5.6-sol", tokens)).toBeCloseTo(5, 5);
			expect(estimateUsageCostUsd("gpt-5.6-terra", tokens)).toBeCloseTo(2.5, 5);
			expect(estimateUsageCostUsd("gpt-5.6-luna", tokens)).toBeCloseTo(1, 5);
		});
	});
});
