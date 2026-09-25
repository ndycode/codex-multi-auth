import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { saveAccounts, setStoragePathDirect } from "../lib/storage.js";
import { getAccountPolicyKey, saveAccountPolicyStore, upsertAccountPolicy, type AccountPolicyStore } from "../lib/account-policy.js";
import { createAutomaticSubscriptionCheck } from "../lib/runtime/automatic-subscription-checks.js";
import * as tokenRefresh from "../lib/runtime/rotation-token-refresh.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../lib/quota-probe.js", () => ({ fetchCodexQuotaSnapshot: probe }));
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "subscription-checks-")); vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir); setStoragePathDirect(join(dir, "accounts.json")); probe.mockReset().mockResolvedValue({ status: 200, model: "fixture", primary: { usedPercent: 0 }, secondary: { usedPercent: 0 }, primingCompleted: true }); });
afterEach(async () => { vi.restoreAllMocks(); setStoragePathDirect(null); vi.unstubAllEnvs(); await removeWithRetry(dir, { recursive: true, force: true }); });
it("automatically enables first-use completion only for the opted-in saved subscription binding", async () => {
    const account = { recordId: "fixture", accountId: "personal", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, workspaces: [{ id: "personal", enabled: true }, { id: "other", enabled: true }] };
    await saveAccounts({ version: 3, activeIndex: 0, accounts: [account] });
    const policies: AccountPolicyStore = { version: 1, accounts: {} };
    upsertAccountPolicy(policies, getAccountPolicyKey(account), p => { p.autoPrime = true; });
    await saveAccountPolicyStore(policies);
    const observed = vi.fn();
    const run = createAutomaticSubscriptionCheck(observed);
    await run(new AbortController().signal);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toMatchObject({ accountId: "personal", accessToken: "fixture-access", primeUnusedSubscription: true });
    expect(observed).toHaveBeenCalledTimes(1);
});
it("does not prime a disabled saved workspace even when a sibling is enabled", async () => {
    const account = { recordId: "fixture", accountId: "personal", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1, workspaces: [{ id: "personal", enabled: false }, { id: "other", enabled: true }] };
    await saveAccounts({ version: 3, activeIndex: 0, accounts: [account] });
    const policies: AccountPolicyStore = { version: 1, accounts: {} };
    upsertAccountPolicy(policies, getAccountPolicyKey(account), p => { p.autoPrime = true; });
    await saveAccountPolicyStore(policies);
    await createAutomaticSubscriptionCheck(vi.fn())(new AbortController().signal);
    expect(probe).not.toHaveBeenCalled();
});

it("does not probe credentials replaced while refreshing the saved account", async () => {
    const account = { recordId: "fixture", accountId: "personal", refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now() + 3600000, addedAt: 1, lastUsed: 1 };
    await saveAccounts({ version: 3, activeIndex: 0, accounts: [account] });
    const policies: AccountPolicyStore = { version: 1, accounts: {} };
    upsertAccountPolicy(policies, getAccountPolicyKey(account), p => { p.autoPrime = true; });
    await saveAccountPolicyStore(policies);
    vi.spyOn(tokenRefresh, "ensureFreshAccessToken").mockImplementationOnce(async ({ account: live }) => {
        await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ ...account, refreshToken: "replacement-refresh", accessToken: "replacement-access" }] });
        return { ok: true, account: live, accessToken: "fixture-access" };
    });
    await createAutomaticSubscriptionCheck(vi.fn())(new AbortController().signal);
    expect(probe).not.toHaveBeenCalled();
});
