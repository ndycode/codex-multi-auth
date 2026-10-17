import { expect, it } from "vitest";
import { mergeAccountSnapshot } from "../lib/storage/snapshot-merge.js";
import type { AccountStorageV3 } from "../lib/storage/public-types.js";
const fixture = (): AccountStorageV3 => ({ version: 3, activeIndex: 0, accounts: [{ recordId: "a", accountId: "a", refreshToken: "fixture-a", addedAt: 1, lastUsed: 1, workspaces: [{ id: "personal", enabled: true }, { id: "business", enabled: true }], currentWorkspaceIndex: 0 }] });
it("preserves independently added accounts and workspace edits during an old runtime save", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts.push({ recordId: "b", accountId: "b", refreshToken: "fixture-b", addedAt: 2, lastUsed: 2 });
    disk.accounts[0]!.workspaces![1]!.enabled = false;
    local.accounts[0]!.lastUsed = 10;
    const merged = mergeAccountSnapshot(base, disk, local);
    expect(merged.accounts).toHaveLength(2);
    expect(merged.accounts[0]!.workspaces![1]!.enabled).toBe(false);
    expect(merged.accounts[0]!.lastUsed).toBe(10);
});
it("never resurrects a deleted record during a stale runtime save", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts = [];
    local.accounts[0]!.lastUsed = 10;
    expect(mergeAccountSnapshot(base, disk, local).accounts).toEqual([]);
});
it("rejects conflicting simultaneous edits instead of silently overwriting them", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts[0]!.accountLabel = "External";
    local.accounts[0]!.accountLabel = "Local";
    expect(() => mergeAccountSnapshot(base, disk, local)).toThrow(/changed/);
});
it("maps selection by identity when another process changes account ordering", () => {
    const base = fixture();
    base.accounts.push({ recordId: "b", accountId: "b", refreshToken: "fixture-b", addedAt: 2, lastUsed: 2 });
    const disk = structuredClone(base), local = structuredClone(base);
    disk.accounts.reverse();
    disk.activeIndex = 1;
    local.activeIndex = 1;
    const result = mergeAccountSnapshot(base, disk, local);
    expect(result.accounts[result.activeIndex]?.recordId).toBe("b");
});

it("merges disjoint reset windows when the baseline has no map", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts[0]!.rateLimitResetTimes = { codex: 100 };
    local.accounts[0]!.rateLimitResetTimes = { "codex:model": 200 };
    expect(mergeAccountSnapshot(base, disk, local).accounts[0]!.rateLimitResetTimes).toEqual({codex:100, "codex:model":200});
});
it("keeps the later concurrent reset and its cooldown reason", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    Object.assign(disk.accounts[0]!, {rateLimitResetTimes:{codex:300}, coolingDownUntil:300, cooldownReason:"rate-limit"});
    Object.assign(local.accounts[0]!, {rateLimitResetTimes:{codex:200}, coolingDownUntil:200, cooldownReason:"auth-failure"});
    const row = mergeAccountSnapshot(base, disk, local).accounts[0]!;
    expect(row.rateLimitResetTimes).toEqual({codex:300}); expect(row.coolingDownUntil).toBe(300); expect(row.cooldownReason).toBe("rate-limit");
});
it("preserves an explicit cooldown clear after a successful refresh", () => {
    const base = fixture(); Object.assign(base.accounts[0]!, {coolingDownUntil:100, cooldownReason:"auth-failure"});
    const disk = structuredClone(base), local = structuredClone(base);
    delete local.accounts[0]!.coolingDownUntil; delete local.accounts[0]!.cooldownReason;
    expect(mergeAccountSnapshot(base,disk,local).accounts[0]!.coolingDownUntil).toBeUndefined();
});
it("does not erase newer runtime observations when another writer prunes old state",()=>{
 const base=fixture();Object.assign(base.accounts[0]!,{rateLimitResetTimes:{codex:100},coolingDownUntil:100,cooldownReason:"rate-limit"});
 const disk=structuredClone(base),local=structuredClone(base);
 Object.assign(disk.accounts[0]!,{rateLimitResetTimes:{codex:300},coolingDownUntil:300,cooldownReason:"auth-failure"});
 delete local.accounts[0]!.rateLimitResetTimes;delete local.accounts[0]!.coolingDownUntil;delete local.accounts[0]!.cooldownReason;
 expect(mergeAccountSnapshot(base,disk,local).accounts[0]).toMatchObject({rateLimitResetTimes:{codex:300},coolingDownUntil:300,cooldownReason:"auth-failure"});
});
it("ignores ephemeral restore metadata when empty storage state changes",()=>{
 const base=Object.assign({version:3 as const,activeIndex:0,accounts:[]},{restoreEligible:true,restoreReason:'missing-storage'});
 const disk=Object.assign(structuredClone(base),{restoreEligible:false,restoreReason:'intentional-reset'});
 const local=fixture();const merged=mergeAccountSnapshot(base,disk,local);
 expect(merged.accounts).toHaveLength(1);expect(merged).not.toHaveProperty('restoreReason');
});


it("merges disjoint rate-limit keys written when the baseline had none", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts[0]!.rateLimitResetTimes = { codex: 100 };
    local.accounts[0]!.rateLimitResetTimes = { "codex:model": 200 };
    expect(mergeAccountSnapshot(base, disk, local).accounts[0]!.rateLimitResetTimes).toEqual({ codex: 100, "codex:model": 200 });
});
it("resolves concurrent runtime limits and cooldowns instead of failing the save", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts[0]!.rateLimitResetTimes = { codex: 300 };
    local.accounts[0]!.rateLimitResetTimes = { codex: 200 };
    disk.accounts[0]!.coolingDownUntil = 500;
    disk.accounts[0]!.cooldownReason = "network-error";
    local.accounts[0]!.coolingDownUntil = 900;
    local.accounts[0]!.cooldownReason = "auth-failure";
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row!.rateLimitResetTimes).toEqual({ codex: 300 });
    expect(row!.coolingDownUntil).toBe(900);
    expect(row!.cooldownReason).toBe("auth-failure");
});
it("keeps a local rate-limit clear when disk did not touch that key", () => {
    const base = fixture();
    base.accounts[0]!.rateLimitResetTimes = { codex: 100 };
    const disk = structuredClone(base), local = structuredClone(base);
    delete local.accounts[0]!.rateLimitResetTimes;
    disk.accounts[0]!.accountLabel = "External";
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row!.rateLimitResetTimes).toBeUndefined();
    expect(row!.accountLabel).toBe("External");
});

it("merges independent per-workspace disables by id", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    Object.assign(disk.accounts[0]!.workspaces![0]!, { enabled: false, disabledAt: 10 });
    Object.assign(local.accounts[0]!.workspaces![1]!, { enabled: false, disabledAt: 20 });
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row!.workspaces).toEqual([
        { id: "personal", enabled: false, disabledAt: 10 },
        { id: "business", enabled: false, disabledAt: 20 },
    ]);
});
it("keeps an intentional re-enable when the other side edits a different workspace", () => {
    const base = fixture();
    Object.assign(base.accounts[0]!.workspaces![0]!, { enabled: false, disabledAt: 5 });
    const disk = structuredClone(base), local = structuredClone(base);
    disk.accounts[0]!.workspaces![0] = { id: "personal", enabled: true };
    Object.assign(local.accounts[0]!.workspaces![1]!, { enabled: false, disabledAt: 20 });
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row!.workspaces![0]).toEqual({ id: "personal", enabled: true });
    expect(row!.workspaces![1]).toMatchObject({ id: "business", enabled: false, disabledAt: 20 });
});
it("resolves the current workspace by identity across a reorder", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts[0]!.workspaces!.reverse();
    disk.accounts[0]!.currentWorkspaceIndex = 1;
    local.accounts[0]!.currentWorkspaceIndex = 1;
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row!.workspaces!.map(w => w.id)).toEqual(["business", "personal"]);
    expect(row!.workspaces![row!.currentWorkspaceIndex!]!.id).toBe("business");
});
it("preserves a selected workspace even when the other side disabled it", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    Object.assign(disk.accounts[0]!.workspaces![1]!, { enabled: false, disabledAt: 10 });
    local.accounts[0]!.currentWorkspaceIndex = 1;
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row!.workspaces![row!.currentWorkspaceIndex!]!.id).toBe("business");
});

it("keeps an auth-failure cooldown recorded against the refresh token that is kept", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    local.accounts[0]!.refreshToken = "fixture-rotated";
    Object.assign(disk.accounts[0]!, { refreshToken: "fixture-rotated", coolingDownUntil: 900, cooldownReason: "auth-failure" });
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row).toMatchObject({ refreshToken: "fixture-rotated", coolingDownUntil: 900, cooldownReason: "auth-failure" });
});
it("drops a local auth-failure cooldown when disk already holds a newer refresh token", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    disk.accounts[0]!.refreshToken = "fixture-winner";
    Object.assign(local.accounts[0]!, { coolingDownUntil: 900, cooldownReason: "auth-failure" });
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect(row!.refreshToken).toBe("fixture-winner");
    expect(row!.coolingDownUntil).toBeUndefined();
});
it("does not drop unknown account fields another version wrote", () => {
    const base = fixture(), disk = structuredClone(base), local = structuredClone(base);
    (base.accounts[0] as Record<string, unknown>).codexCliMirror = { forAccountId: "a", accountId: "org-a" };
    (disk.accounts[0] as Record<string, unknown>).codexCliMirror = { forAccountId: "a", accountId: "org-b" };
    (local.accounts[0] as Record<string, unknown>).codexCliMirror = { forAccountId: "a", accountId: "org-a" };
    local.accounts[0]!.lastUsed = 10;
    const [row] = mergeAccountSnapshot(base, disk, local).accounts;
    expect((row as Record<string, unknown>).codexCliMirror).toEqual({ forAccountId: "a", accountId: "org-b" });
});
