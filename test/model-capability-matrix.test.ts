import { describe, expect, it } from "vitest";
import { CapabilityPolicyStore } from "../lib/capability-policy.js";
import { resolveEntitlementAccountKey } from "../lib/entitlement-cache.js";
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
	it("returns default normalized models without entries when storage is missing", () => {
		const matrix = buildModelCapabilityMatrix({
			storage: null,
			models: [],
			now: 100,
		});

		expect(matrix.generatedAt).toBe(100);
		expect(matrix.models.length).toBeGreaterThan(0);
		expect(matrix.entries).toEqual([]);
	});

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
		// The capability store is keyed by the entitlement account key, which is
		// the same key the matrix now reads with (regression for quota-forecast-01).
		const entitlementKey = resolveEntitlementAccountKey({
			accountId: "acct_1",
			email: "owner@example.com",
			index: 0,
		});
		capabilityPolicy.recordUnsupported(entitlementKey, "gpt-5.3-codex", 100);
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

	it("surfaces capability snapshots recorded under the entitlement key", () => {
		// quota-forecast-01 regression: recordUnsupported writes under the
		// entitlement key, so the matrix must read capabilityPolicy with that same
		// key (not the sha256 getAccountPolicyKey) for the snapshot to surface.
		const capabilityPolicy = new CapabilityPolicyStore();
		const entitlementKey = resolveEntitlementAccountKey({
			accountId: "acct_1",
			email: "owner@example.com",
			index: 0,
		});
		capabilityPolicy.recordUnsupported(entitlementKey, "gpt-5.3-codex", 100);

		const matrix = buildModelCapabilityMatrix({
			storage: storage(),
			models: ["gpt-5.3-codex"],
			capabilityPolicy,
			now: 100,
		});

		expect(matrix.entries[0]?.capabilityPolicy).not.toBeNull();
		expect(matrix.entries[0]?.capabilityPolicy?.unsupported).toBeGreaterThan(0);
		expect(matrix.entries[0]?.available).toBe(false);
		expect(matrix.entries[0]?.reasons).toContain(
			"capability policy has unsupported failures",
		);
	});

	it("surfaces a negative capabilityBoost from recordFailure under the entitlement key", () => {
		// getBoost depends on failures/successes (not just unsupported), and is also
		// read with the entitlement key. A failure applies a penalty, so the boost is
		// negative — pinning that recordFailure writes under the key the matrix reads.
		const capabilityPolicy = new CapabilityPolicyStore();
		const entitlementKey = resolveEntitlementAccountKey({
			accountId: "acct_1",
			email: "owner@example.com",
			index: 0,
		});
		capabilityPolicy.recordFailure(entitlementKey, "gpt-5.3-codex", 100);

		const matrix = buildModelCapabilityMatrix({
			storage: storage(),
			models: ["gpt-5.3-codex"],
			capabilityPolicy,
			now: 100,
		});

		// failurePenalty = 3 (1 failure * 3), no successes → net boost -3.
		expect(matrix.entries[0]?.capabilityBoost).toBeLessThan(0);
	});

	it("recordSuccess under the entitlement key lifts the capabilityBoost back positive", () => {
		const capabilityPolicy = new CapabilityPolicyStore();
		const entitlementKey = resolveEntitlementAccountKey({
			accountId: "acct_1",
			email: "owner@example.com",
			index: 0,
		});
		capabilityPolicy.recordFailure(entitlementKey, "gpt-5.3-codex", 100);
		// recordSuccess decrements failures (→0) and adds a success → net positive.
		capabilityPolicy.recordSuccess(entitlementKey, "gpt-5.3-codex", 100);

		const matrix = buildModelCapabilityMatrix({
			storage: storage(),
			models: ["gpt-5.3-codex"],
			capabilityPolicy,
			now: 100,
		});

		expect(matrix.entries[0]?.capabilityBoost).toBeGreaterThan(0);
	});

	it("marks disabled and entitlement-blocked accounts unavailable", () => {
		const baseStorage = storage();
		baseStorage.accounts[0] = {
			...baseStorage.accounts[0]!,
			enabled: false,
		};
		const entitlementKey = resolveEntitlementAccountKey({
			accountId: "acct_1",
			email: "owner@example.com",
			index: 0,
		});
		const matrix = buildModelCapabilityMatrix({
			storage: baseStorage,
			models: ["gpt-5.3-codex"],
			entitlements: {
				accounts: {
					[entitlementKey]: [
						{
							model: "gpt-5.3-codex",
							blockedUntil: 200,
							reason: "plan-entitlement",
							updatedAt: 100,
						},
					],
				},
			},
			now: 100,
		});

		expect(matrix.entries[0]).toMatchObject({
			available: false,
			entitlementBlocked: true,
			entitlementReason: "plan-entitlement",
			entitlementWaitMs: 100,
		});
		expect(matrix.entries[0]?.reasons).toContain("account disabled");
		expect(matrix.entries[0]?.reasons).toContain(
			"entitlement blocked: plan-entitlement",
		);
	});
});

