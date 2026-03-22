import { describe, expect, it } from "vitest";
import { CapabilityPolicyStore } from "../lib/capability-policy.js";

describe("capability policy store", () => {
	it("rewards repeated successes", () => {
		const store = new CapabilityPolicyStore();
		store.recordSuccess("id:acc_1", "gpt-5-codex", 1_000);
		store.recordSuccess("id:acc_1", "gpt-5-codex", 2_000);

		expect(store.getBoost("id:acc_1", "gpt-5-codex", 2_500)).toBeGreaterThan(0);
	});

	it("penalizes failures and unsupported errors", () => {
		const store = new CapabilityPolicyStore();
		store.recordFailure("id:acc_1", "gpt-5.3-codex", 1_000);
		store.recordUnsupported("id:acc_1", "gpt-5.3-codex", 1_500);

		const boost = store.getBoost("id:acc_1", "gpt-5.3-codex", 1_600);
		expect(boost).toBeLessThan(0);
	});

	it("recovers passively over time", () => {
		const store = new CapabilityPolicyStore();
		store.recordFailure("id:acc_2", "gpt-5-codex", 1_000);
		const early = store.getBoost("id:acc_2", "gpt-5-codex", 2_000);
		const later = store.getBoost("id:acc_2", "gpt-5-codex", 122_000);

		expect(later).toBeGreaterThanOrEqual(early);
	});

	it("clears account-specific entries", () => {
		const store = new CapabilityPolicyStore();
		store.recordSuccess("id:acc_a", "gpt-5-codex", 1_000);
		store.recordFailure("id:acc_b", "gpt-5-codex", 1_000);

		expect(store.clearAccount("id:acc_a")).toBeGreaterThan(0);
		expect(store.getSnapshot("id:acc_a", "gpt-5-codex")).toBeNull();
		expect(store.getSnapshot("id:acc_b", "gpt-5-codex")).not.toBeNull();
	});

	it("uses canonical model normalization across aliases", () => {
		const store = new CapabilityPolicyStore();
		store.recordSuccess("id:acc_alias", "gpt-5.3-codex", 1_000);
		const boostFromCanonical = store.getBoost("id:acc_alias", "gpt-5-codex", 1_500);
		expect(boostFromCanonical).toBeGreaterThan(0);
	});
	it("returns zero boost/null snapshot for missing or invalid keys", () => {
		const store = new CapabilityPolicyStore();
		expect(store.getBoost("", "gpt-5-codex")).toBe(0);
		expect(store.getBoost("id:missing", "gpt-5-codex")).toBe(0);
		expect(store.getSnapshot("", "gpt-5-codex")).toBeNull();
		expect(store.getSnapshot("id:missing", "gpt-5-codex")).toBeNull();
	});

	it("normalizes provider-prefixed models and strips quality suffixes", () => {
		const store = new CapabilityPolicyStore();
		store.recordSuccess("id:acc_norm", "openai/gpt-5-codex-high", 1_000);

		const snapshot = store.getSnapshot("id:acc_norm", "gpt-5-codex");
		expect(snapshot).not.toBeNull();
		expect(snapshot?.successes).toBe(1);
	});

	it("keeps unknown model identifiers in separate capability buckets", () => {
		const store = new CapabilityPolicyStore();
		store.recordSuccess("id:acc_unknown", "claude-3-sonnet-high", 1_000);

		expect(store.getSnapshot("id:acc_unknown", "claude-3-sonnet")).toMatchObject({
			successes: 1,
		});
		expect(store.getSnapshot("id:acc_unknown", "gpt-5.4")).toBeNull();
	});

	it("ignores blank model and blank account writes", () => {
		const store = new CapabilityPolicyStore();
		store.recordSuccess("", "gpt-5-codex", 1_000);
		store.recordFailure("id:acc_blank", "   ", 1_000);
		store.recordUnsupported("", "   ", 1_000);

		expect(store.getSnapshot("id:acc_blank", "gpt-5-codex")).toBeNull();
		expect(store.clearAccount("")).toBe(0);
	});

	it("evicts oldest entries when capacity is exceeded", () => {
		const store = new CapabilityPolicyStore();
		for (let i = 0; i < 2055; i += 1) {
			store.recordSuccess(`id:acc_${i}`, "gpt-5-codex", 1_000 + i);
		}

		expect(store.getSnapshot("id:acc_0", "gpt-5-codex")).toBeNull();
		expect(store.getSnapshot("id:acc_2054", "gpt-5-codex")).not.toBeNull();
	});

	it("clamps boost to score boundaries", () => {
		const store = new CapabilityPolicyStore();
		for (let i = 0; i < 20; i += 1) {
			store.recordSuccess("id:acc_hi", "gpt-5-codex", 1_000 + i);
		}
		for (let i = 0; i < 20; i += 1) {
			store.recordUnsupported("id:acc_lo", "gpt-5-codex", 1_000 + i);
		}

		expect(store.getBoost("id:acc_hi", "gpt-5-codex", 2_000)).toBeLessThanOrEqual(20);
		expect(store.getBoost("id:acc_lo", "gpt-5-codex", 2_000)).toBeGreaterThanOrEqual(-30);
	});
});
