import { describe, expect, it } from "vitest";
import {
  EntitlementCache,
  resolveEntitlementAccountKey,
} from "../lib/entitlement-cache.js";

describe("entitlement cache", () => {
  it("resolves account key priority", () => {
    expect(
      resolveEntitlementAccountKey({
        accountId: "acc_123",
        email: "user@example.com",
        index: 2,
      }),
    ).toBe("account:acc_123::email:user@example.com");
    expect(
      resolveEntitlementAccountKey({ email: "User@Example.com", index: 5 }),
    ).toBe("email:user@example.com");
    expect(resolveEntitlementAccountKey({ index: 7 })).toBe("idx:7");
  });

  it("separates shared workspace ids by email or index", () => {
    expect(
      resolveEntitlementAccountKey({
        accountId: "shared-workspace",
        email: "alpha@example.com",
        index: 0,
      }),
    ).toBe("account:shared-workspace::email:alpha@example.com");
    expect(
      resolveEntitlementAccountKey({
        accountId: "shared-workspace",
        email: "beta@example.com",
        index: 1,
      }),
    ).toBe("account:shared-workspace::email:beta@example.com");
    expect(
      resolveEntitlementAccountKey({
        accountId: "shared-workspace",
        index: 0,
      }),
    ).toBe("account:shared-workspace::idx:0");
    expect(
      resolveEntitlementAccountKey({
        accountId: "shared-workspace",
        index: 1,
      }),
    ).toBe("account:shared-workspace::idx:1");
  });

  it("marks model block and expires after ttl", () => {
    const cache = new EntitlementCache();
    const accountKey = "id:acc_1";
    cache.markBlocked(
      accountKey,
      "gpt-5.3-codex",
      "unsupported-model",
      500,
      1_000,
    );

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
    cache.markBlocked(
      accountKey,
      "gpt-5-codex",
      "plan-entitlement",
      5_000,
      2_000,
    );
    cache.markBlocked(
      accountKey,
      "gpt-5.3-codex",
      "unsupported-model",
      5_000,
      2_000,
    );

    cache.clear(accountKey, "gpt-5-codex");
    expect(cache.isBlocked(accountKey, "gpt-5-codex", 2_500).blocked).toBe(
      false,
    );
    expect(cache.isBlocked(accountKey, "gpt-5.3-codex", 2_500).blocked).toBe(
      true,
    );

    cache.clear(accountKey);
    expect(cache.isBlocked(accountKey, "gpt-5.3-codex", 2_500).blocked).toBe(
      false,
    );
  });

  it("normalizes invalid ttl values to default minimum behavior", () => {
    const cache = new EntitlementCache();
    const accountKey = "id:ttl-invalid";
    cache.markBlocked(
      accountKey,
      "gpt-5-codex",
      "plan-entitlement",
      Number.NaN,
      1_000,
    );

    const blocked = cache.isBlocked(accountKey, "gpt-5-codex", 2_000);
    expect(blocked.blocked).toBe(true);
    expect(blocked.waitMs).toBeGreaterThan(0);
  });

  it("returns immutable snapshot entries", () => {
    const cache = new EntitlementCache();
    const accountKey = "id:snapshot";
    cache.markBlocked(
      accountKey,
      "gpt-5-codex",
      "plan-entitlement",
      5_000,
      1_000,
    );

    const snapshot = cache.snapshot(1_500);
    expect(snapshot.accounts[accountKey]).toHaveLength(1);
    if (!snapshot.accounts[accountKey]) {
      throw new Error("missing snapshot account entry");
    }

    snapshot.accounts[accountKey][0].model = "tampered-model";
    const fresh = cache.snapshot(1_500);
    expect(fresh.accounts[accountKey]?.[0]?.model).toBe("gpt-5-codex");
  });
  it("handles trimmed/empty account refs and non-finite indexes", () => {
    expect(resolveEntitlementAccountKey({ accountId: "  acc_trim  " })).toBe(
      "account:acc_trim",
    );
    expect(
      resolveEntitlementAccountKey({ accountId: "  acc_trim  ", index: 3 }),
    ).toBe("account:acc_trim::idx:3");
    expect(
      resolveEntitlementAccountKey({ email: "  Person@Example.com  " }),
    ).toBe("email:person@example.com");
    expect(
      resolveEntitlementAccountKey({ refreshToken: "  refresh-token  " }),
    ).toBe("refresh:refresh-token");
    expect(resolveEntitlementAccountKey({ index: Number.NaN })).toBe("idx:0");
  });

  it("ignores invalid mark/clear/isBlocked inputs", () => {
    const cache = new EntitlementCache();
    cache.markBlocked("", "gpt-5-codex", "plan-entitlement", 5_000, 1_000);
    cache.markBlocked("id:bad-model", "   ", "plan-entitlement", 5_000, 1_000);
    cache.clear("", "gpt-5-codex");
    cache.clear("id:bad-model", "   ");

    expect(cache.snapshot(1_500).accounts).toEqual({});
    expect(cache.isBlocked("", "gpt-5-codex", 1_500)).toEqual({
      blocked: false,
      waitMs: 0,
    });
    expect(cache.isBlocked("id:missing", "", 1_500)).toEqual({
      blocked: false,
      waitMs: 0,
    });
  });

  it("evicts the oldest account bucket when max buckets are exceeded", () => {
    const cache = new EntitlementCache();
    for (let index = 0; index < 513; index += 1) {
      cache.markBlocked(
        `id:acc_${index}`,
        "gpt-5-codex",
        "plan-entitlement",
        5_000,
        1_000,
      );
    }

    expect(cache.isBlocked("id:acc_0", "gpt-5-codex", 1_500).blocked).toBe(
      false,
    );
    expect(cache.isBlocked("id:acc_1", "gpt-5-codex", 1_500).blocked).toBe(
      true,
    );
    expect(cache.isBlocked("id:acc_512", "gpt-5-codex", 1_500).blocked).toBe(
      true,
    );
  });

  it("normalizes model names with provider prefix and effort suffix", () => {
    const cache = new EntitlementCache();
    const accountKey = "id:model-normalize";
    cache.markBlocked(
      accountKey,
      "OpenAI/GPT-5-CODEX-HIGH",
      "unsupported-model",
      5_000,
      1_000,
    );

    expect(cache.isBlocked(accountKey, "gpt-5-codex", 1_500).blocked).toBe(
      true,
    );
    expect(
      cache.isBlocked(accountKey, "openai/gpt-5-codex-low", 1_500).blocked,
    ).toBe(true);
  });

  it("prunes expired blocks and removes empty account buckets", () => {
    const cache = new EntitlementCache();
    cache.markBlocked(
      "id:prune_a",
      "gpt-5-codex",
      "plan-entitlement",
      500,
      1_000,
    );
    cache.markBlocked(
      "id:prune_b",
      "gpt-5.3-codex",
      "unsupported-model",
      500,
      1_000,
    );

    const removed = cache.prune(2_000);
    expect(removed).toBe(2);
    expect(cache.snapshot(2_000).accounts).toEqual({});
  });

  it("sorts snapshot blocks alphabetically by normalized model", () => {
    const cache = new EntitlementCache();
    const accountKey = "id:sort";
    cache.markBlocked(
      accountKey,
      "gpt-5.3-codex",
      "unsupported-model",
      5_000,
      1_000,
    );
    cache.markBlocked(
      accountKey,
      "gpt-5-codex",
      "plan-entitlement",
      5_000,
      1_000,
    );

    const models =
      cache.snapshot(1_100).accounts[accountKey]?.map((entry) => entry.model) ??
      [];
    expect(models).toEqual(["gpt-5-codex", "gpt-5.3-codex"]);
  });
});
