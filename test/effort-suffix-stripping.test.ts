import { describe, expect, it } from "vitest";
import { REASONING_EFFORTS, stripModelEffortSuffix } from "../lib/constants.js";
import { CapabilityPolicyStore } from "../lib/capability-policy.js";
import { EntitlementCache } from "../lib/entitlement-cache.js";
import { resolveUnsupportedCodexFallbackModel } from "../lib/request/error-classification.js";
import { getUnsupportedCodexFallbackChain } from "../lib/config.js";

/**
 * Four call sites used to strip only `none|minimal|low|medium|high|xhigh`,
 * omitting `max` and `ultra`. That predates GPT-5.6, which introduced both, so
 * `gpt-5.6-sol-max` and `gpt-6-astra-ultra` kept their suffix and keyed
 * separately from the model they route to: a split entitlement cache, a policy
 * key no request reads, and a fallback chain lookup that finds no row.
 *
 * The reason the suffix set was never widened is that `codex-max` and
 * `gpt-5.1-codex-max` are model NAMES whose last segment is `max`. Stripping
 * theirs renames them. The shared helper names that exception, which is what
 * makes adding `max` and `ultra` safe.
 */
describe("stripModelEffortSuffix", () => {
	it("strips every effort in the union, including max and ultra", () => {
		for (const effort of REASONING_EFFORTS) {
			expect(
				stripModelEffortSuffix(`gpt-6-astra-${effort}`),
				effort,
			).toBe("gpt-6-astra");
		}
		// Non-vacuous: the union has to actually contain the two that were missing.
		expect(REASONING_EFFORTS).toContain("max");
		expect(REASONING_EFFORTS).toContain("ultra");
	});

	it("leaves a model whose name ends in `-max` alone", () => {
		expect(stripModelEffortSuffix("codex-max")).toBe("codex-max");
		expect(stripModelEffortSuffix("gpt-5.1-codex-max")).toBe("gpt-5.1-codex-max");
	});

	it("leaves ids with no effort suffix untouched", () => {
		for (const id of [
			"gpt-6-astra",
			"gpt-6-astra-aeon",
			"gpt-5.3-codex",
			"gpt-daybreak-red-latest",
			"codex-mini-latest",
			"gpt-5.3-codex-spark",
			"",
		]) {
			expect(stripModelEffortSuffix(id), id).toBe(id);
		}
	});
});

describe("the four call sites agree on one key per model", () => {
	it("the entitlement cache shares one block across effort suffixes", () => {
		// This is the fourth call site the suite name claims and did not cover.
		// Before the fix a block written for `gpt-6-astra-max` was invisible to a
		// lookup for `gpt-6-astra`, so the same account/model pair was probed and
		// blocked twice under two keys.
		const cache = new EntitlementCache();
		cache.markBlocked("acc:1", "gpt-6-astra-max", "unsupported-model", 60_000, 1_000);

		expect(cache.isBlocked("acc:1", "gpt-6-astra", 1_500).blocked).toBe(true);
		expect(cache.isBlocked("acc:1", "gpt-6-astra-ultra", 1_500).blocked).toBe(true);
		expect(cache.isBlocked("acc:1", "gpt-6-astra-max", 1_500).blocked).toBe(true);
	});

	it("the entitlement cache still keeps Codex Max separate from Codex", () => {
		// If `-max` were stripped here, blocking Codex Max would also block the
		// plain codex model, taking a working model out of rotation.
		const cache = new EntitlementCache();
		cache.markBlocked("acc:2", "codex-max", "unsupported-model", 60_000, 1_000);
		expect(cache.isBlocked("acc:2", "codex-max", 1_500).blocked).toBe(true);
		expect(cache.isBlocked("acc:2", "codex", 1_500).blocked).toBe(false);
	});

	it("capability policy shares a key across effort suffixes", () => {
		const store = new CapabilityPolicyStore();
		store.recordSuccess("id:acc", "gpt-6-astra-max", 1_000);
		expect(store.getBoost("id:acc", "gpt-6-astra", 1_500)).toBeGreaterThan(0);
		expect(store.getBoost("id:acc", "gpt-6-astra-ultra", 1_500)).toBeGreaterThan(0);
	});

	it("capability policy still separates Codex Max from Codex", () => {
		// If `-max` were stripped here, these two would collapse onto one key.
		const store = new CapabilityPolicyStore();
		store.recordSuccess("id:acc2", "codex-max", 1_000);
		const codexMax = store.getBoost("id:acc2", "codex-max", 1_500);
		expect(codexMax).toBeGreaterThan(0);
	});

	it("the fallback chain resolves from an effort-suffixed model", () => {
		const body = {
			error: {
				message:
					"model is not supported when using codex with a chatgpt account",
			},
		};
		// Before the fix `gpt-6-astra-max` found no row and returned undefined.
		expect(
			resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-6-astra-max",
				errorBody: body,
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			}),
		).toBe("gpt-5.6-sol");
		expect(
			resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.6-sol-ultra",
				errorBody: body,
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			}),
		).toBe("gpt-5.5");
	});

	it("the fallback chain keeps Codex Max on its own row", () => {
		const body = {
			error: {
				message:
					"model is not supported when using codex with a chatgpt account",
			},
		};
		// `codex-max` has its own chain row. Stripping its `-max` would look up
		// `codex`, which has no row, and the fallback would vanish.
		expect(
			resolveUnsupportedCodexFallbackModel({
				requestedModel: "codex-max",
				errorBody: body,
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			}),
		).toBe("gpt-5.3-codex");
	});

	it("a config chain override keyed with an effort suffix still applies", () => {
		const chain = getUnsupportedCodexFallbackChain({
			unsupportedCodexFallbackChain: {
				"gpt-6-astra-max": ["gpt-5.4"],
			},
		} as never);
		expect(chain["gpt-6-astra"]).toEqual(["gpt-5.4"]);
	});
});
