import { describe, expect, it } from "vitest";
import { CapabilityPolicyStore } from "../lib/capability-policy.js";
import { buildModelCapabilityMatrix } from "../lib/model-capability-matrix.js";
import type { AccountStorageV3 } from "../lib/storage.js";

function storage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "owner@example.com",
				accountId: "acct_1",
				refreshToken: "refresh",
				addedAt: 1,
				lastUsed: 1,
			},
		],
	};
}

describe("model capability matrix", () => {
	it("builds model/account availability from existing model profiles", () => {
		const matrix = buildModelCapabilityMatrix({
			storage: storage(),
			models: ["gpt-5.3-codex"],
			now: 100,
		});
		expect(matrix.models).toEqual(["gpt-5.3-codex"]);
		expect(matrix.entries[0]).toMatchObject({
			accountIndex: 1,
			accountLabel: "Account 1",
			normalizedModel: "gpt-5.3-codex",
			promptFamily: "gpt-5-codex",
			available: true,
		});
		expect(matrix.entries[0]?.accountKey).toMatch(/^sha256:/);
	});

	it("marks capability policy and quota cache issues unavailable", () => {
		const capabilityPolicy = new CapabilityPolicyStore();
		const accountKey = buildModelCapabilityMatrix({
			storage: storage(),
			models: ["gpt-5.3-codex"],
		}).entries[0]!.accountKey;
		capabilityPolicy.recordUnsupported(accountKey, "gpt-5.3-codex", 100);
		const matrix = buildModelCapabilityMatrix({
			storage: storage(),
			models: ["gpt-5.3-codex"],
			capabilityPolicy,
			quotaCache: {
				byAccountId: {
					acct_1: {
						updatedAt: 100,
						status: 429,
						model: "gpt-5.3-codex",
						primary: {},
						secondary: {},
					},
				},
				byEmail: {},
			},
			now: 100,
		});
		expect(matrix.entries[0]?.available).toBe(false);
		expect(matrix.entries[0]?.reasons).toContain(
			"capability policy has unsupported failures",
		);
		expect(matrix.entries[0]?.reasons).toContain("quota cache is rate-limited");
	});
});

