import { describe, expect, it } from "vitest";
import { EntitlementCache, resolveEntitlementAccountKey } from "../lib/entitlement-cache.js";

describe("entitlement cache", () => {
	it("resolves account key priority", () => {
		expect(
			resolveEntitlementAccountKey({
				accountId: "acc_123",
				email: "user@example.com",
				index: 2,
			}),
		).toBe("id:acc_123");
		expect(resolveEntitlementAccountKey({ email: "User@Example.com", index: 5 })).toBe(
			"email:user@example.com",
		);
		expect(resolveEntitlementAccountKey({ index: 7 })).toBe("idx:7");
	});

	it("marks model block and expires after ttl", () => {
		const cache = new EntitlementCache();
		const accountKey = "id:acc_1";
		cache.markBlocked(accountKey, "gpt-5.3-codex", "unsupported-model", 500, 1_000);

		const blockedNow = cache.isBlocked(accountKey, "gpt-5.3-codex", 1_100);
		expect(blockedNow.blocked).toBe(true);
		expect(blockedNow.reason).toBe("unsupported-model");
		expect(blockedNow.waitMs).toBeGreaterThan(0);

		const blockedLater = cache.isBlocked(accountKey, "gpt-5.3-codex", 2_200);
		expect(blockedLater.blocked).toBe(false);
		expect(blockedLater.waitMs).toBe(0);
	});

	it("clears model or full account block", () => {
		const cache = new EntitlementCache();
		const accountKey = "email:person@example.com";
		cache.markBlocked(accountKey, "gpt-5-codex", "plan-entitlement", 5_000, 2_000);
		cache.markBlocked(accountKey, "gpt-5.3-codex", "unsupported-model", 5_000, 2_000);

		cache.clear(accountKey, "gpt-5-codex");
		expect(cache.isBlocked(accountKey, "gpt-5-codex", 2_500).blocked).toBe(false);
		expect(cache.isBlocked(accountKey, "gpt-5.3-codex", 2_500).blocked).toBe(true);

		cache.clear(accountKey);
		expect(cache.isBlocked(accountKey, "gpt-5.3-codex", 2_500).blocked).toBe(false);
	});

	it("normalizes invalid ttl values to default minimum behavior", () => {
		const cache = new EntitlementCache();
		const accountKey = "id:ttl-invalid";
		cache.markBlocked(accountKey, "gpt-5-codex", "plan-entitlement", Number.NaN, 1_000);

		const blocked = cache.isBlocked(accountKey, "gpt-5-codex", 2_000);
		expect(blocked.blocked).toBe(true);
		expect(blocked.waitMs).toBeGreaterThan(0);
	});

	it("returns immutable snapshot entries", () => {
		const cache = new EntitlementCache();
		const accountKey = "id:snapshot";
		cache.markBlocked(accountKey, "gpt-5-codex", "plan-entitlement", 5_000, 1_000);

		const snapshot = cache.snapshot(1_500);
		expect(snapshot.accounts[accountKey]).toHaveLength(1);
		if (!snapshot.accounts[accountKey]) {
			throw new Error("missing snapshot account entry");
		}

		snapshot.accounts[accountKey][0].model = "tampered-model";
		const fresh = cache.snapshot(1_500);
		expect(fresh.accounts[accountKey]?.[0]?.model).toBe("gpt-5-codex");
	});
});
