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
});
