import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../lib/accounts.js";
import { saveAccounts, loadAccounts, getStoragePath, clearAccounts, setStoragePathDirect, cloneTrackedAccountStorage, withAccountAndFlaggedStorageTransaction } from "../lib/storage.js";
import { withRetry } from "../lib/fs-retry.js";
const dirs: string[] = [];
afterEach(async () => { setStoragePathDirect(null); for (const dir of dirs.splice(0))
    await withRetry(() => rm(dir, { recursive: true, force: true }), { maxAttempts: 6, backoffMs: 25 }); });
async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "resilience-storage-"));
    dirs.push(dir);
    setStoragePathDirect(join(dir, "accounts.json"));
    await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ recordId: "first", accountId: "first", refreshToken: "fixture-first", addedAt: 1, lastUsed: 1, workspaces: [{ id: "personal", enabled: true }, { id: "business", enabled: true }], currentWorkspaceIndex: 0 }] });
    return new AccountManager(undefined, await loadAccounts());
}
it("does not overwrite a CLI workspace exclusion or account addition across repeated daemon saves", async () => {
    const manager = await setup(), cli = (await loadAccounts())!;
    cli.accounts[0]!.workspaces![1]!.enabled = false;
    cli.accounts.push({ recordId: "new", accountId: "new", refreshToken: "fixture-new", addedAt: 2, lastUsed: 2 });
    await saveAccounts(cli);
    manager.getAccountByIndex(0)!.lastUsed = 20;
    await manager.saveToDisk();
    await manager.saveToDisk();
    const result = await loadAccounts();
    expect(result?.accounts).toHaveLength(2);
    expect(result?.accounts[0]?.workspaces?.[1]?.enabled).toBe(false);
    expect(result?.accounts[0]?.lastUsed).toBe(20);
});
it("does not restore accounts after the store was intentionally cleared", async () => {
    const manager = await setup();
    await clearAccounts();
    await manager.saveToDisk();
    expect((await loadAccounts())?.accounts ?? []).toEqual([]);
});
it("merges two loaded CLI snapshots without losing independent edits", async () => {
    await setup();
    const a = (await loadAccounts())!, b = (await loadAccounts())!;
    a.accounts[0]!.accountLabel = "Renamed";
    b.accounts[0]!.workspaces![1]!.enabled = false;
    await saveAccounts(a);
    await saveAccounts(b);
    const result = (await loadAccounts())!;
    expect(result.accounts[0]!.accountLabel).toBe("Renamed");
    expect(result.accounts[0]!.workspaces![1]!.enabled).toBe(false);
});
it("preserves independent edits when a health-check clone moves an account to flagged storage", async () => {
    await setup();
    const check = cloneTrackedAccountStorage((await loadAccounts())!), cli = (await loadAccounts())!;
    cli.accounts.push({ recordId: "new", accountId: "new", refreshToken: "fixture-new", addedAt: 2, lastUsed: 2 });
    await saveAccounts(cli);
    check.accounts = [];
    await withAccountAndFlaggedStorageTransaction(async (_current, persist) => persist(check, { version: 1, accounts: [] }));
    expect((await loadAccounts())?.accounts.map(row => row.recordId)).toEqual(["new"]);
});

it.each([false, true])("retains a newly signed-in fallback when the stored inventory is empty=%s", async empty => {
    await setup();
    if (empty) await saveAccounts({ version: 3, activeIndex: 0, accounts: [] });
    const manager = new AccountManager({ type: "oauth", access: "fixture-new-access", refresh: "fixture-new-refresh", expires: Date.now() + 3600000 }, await loadAccounts());
    await manager.saveToDisk();
    await manager.saveToDisk();
    expect((await loadAccounts())?.accounts.map(a => a.refreshToken)).toContain("fixture-new-refresh");
});
it("persists newer fallback tokens for an existing account", async () => {
    await setup();
    const access = `fixture.${Buffer.from(JSON.stringify({"https://api.openai.com/auth": {chatgpt_account_id: "first"}})).toString("base64url")}.signature`;
    const manager = new AccountManager({ type: "oauth", access, refresh: "fixture-rotated", expires: Date.now() + 3600000 }, await loadAccounts());
    expect(manager.getAccountCount()).toBe(1);
    await manager.saveToDisk();
    expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("fixture-rotated");
});
it("persists rotated credentials despite concurrent runtime limits on another account", async () => {
    await setup();
    const stored = (await loadAccounts())!;
    stored.accounts.push({ recordId: "second", accountId: "second", refreshToken: "fixture-second", addedAt: 2, lastUsed: 2 });
    await saveAccounts(stored);
    const manager = new AccountManager(undefined, await loadAccounts());
    const disk = (await loadAccounts())!;
    disk.accounts[0]!.rateLimitResetTimes = { codex: Date.now() + 100000 };
    await saveAccounts(disk);
    manager.getAccountByIndex(0)!.rateLimitResetTimes = { codex: Date.now() + 200000 };
    await manager.commitRefreshedAuth(manager.getAccountByIndex(1)!, {type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated-second", expires: Date.now() + 3600000});
    await manager.saveToDisk(); await manager.saveToDisk();
    expect((await loadAccounts())?.accounts[1]?.refreshToken).toBe("fixture-rotated-second");
});
it("does not lose a rotated credential to an unrelated concurrent label edit", async () => {
 const manager=await setup();
 const disk=(await loadAccounts())!;disk.accounts[0]!.accountLabel="External";await saveAccounts(disk);
 manager.getAccountByIndex(0)!.accountLabel="Local";
 await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!,{type:"oauth",access:"fixture-fresh",refresh:"fixture-rotated",expires:Date.now()+3600000});
 // The conflicting user edit remains visible rather than being marked saved.
 await expect(manager.saveToDisk()).rejects.toMatchObject({code:"ESTALE"});
 manager.getAccountByIndex(0)!.accountLabel="External";
 await manager.saveToDisk();await manager.saveToDisk();
 const result=(await loadAccounts())!.accounts[0]!;
 expect(result.refreshToken).toBe("fixture-rotated");expect(result.accountLabel).toBe("External");
});
it("does not replace a readable inventory after initially loading no snapshot",async()=>{
 await setup();const manager=new AccountManager(undefined,null);await manager.saveToDisk();
 expect((await loadAccounts())?.accounts.map(a=>a.accountId)).toEqual(["first"]);
});
it("treats explicit enabled defaults as unchanged during an external disable",async()=>{
 await setup();const initial=(await loadAccounts())!;initial.accounts[0]!.enabled=true;await saveAccounts(initial);
 const manager=new AccountManager(undefined,await loadAccounts());const disk=(await loadAccounts())!;disk.accounts[0]!.enabled=false;await saveAccounts(disk);
 await manager.saveToDisk();expect((await loadAccounts())?.accounts[0]?.enabled).toBe(false);
});
it("retains pending removals and new fallback accounts after rescuing a refresh",async()=>{
 await setup();const initial=(await loadAccounts())!;initial.accounts.push({recordId:"remove",accountId:"remove",refreshToken:"fixture-remove",addedAt:2,lastUsed:2});await saveAccounts(initial);
 const manager=new AccountManager({type:"oauth",access:"fixture-new",refresh:"fixture-new",expires:Date.now()+3600000},await loadAccounts());
 manager.removeAccountByIndex(1);manager.getAccountByIndex(0)!.accountLabel="Local";
 const disk=(await loadAccounts())!;disk.accounts[0]!.accountLabel="External";await saveAccounts(disk);
 await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!,{type:"oauth",access:"fixture-fresh",refresh:"fixture-rotated",expires:Date.now()+3600000});
 manager.getAccountByIndex(0)!.accountLabel="External";
 await manager.saveToDisk();
 const result=(await loadAccounts())!;
 expect(result.accounts.map(a=>a.refreshToken)).toEqual(["fixture-rotated","fixture-new"]);
});
it("rescues a refreshed legacy record after matched fallback token replacement",async()=>{
 await setup();const initial=(await loadAccounts())!;delete initial.accounts[0]!.recordId;await saveAccounts(initial);
 const access=`fixture.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"first"}})).toString("base64url")}.signature`;
 const manager=new AccountManager({type:"oauth",access,refresh:"fixture-fallback",expires:Date.now()+3600000},await loadAccounts());
 manager.getAccountByIndex(0)!.accountLabel="Local";
 const disk=(await loadAccounts())!;disk.accounts[0]!.accountLabel="External";await saveAccounts(disk);
 await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!,{type:"oauth",access,refresh:"fixture-rotated",expires:Date.now()+3600000});
 expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("fixture-rotated");
 await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!,{type:"oauth",access,refresh:"fixture-rotated-again",expires:Date.now()+7200000});
 expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("fixture-rotated-again");
 await expect(manager.saveToDisk()).rejects.toMatchObject({code:"ESTALE"});
});
it.each(['removed','disabled','invalidated','replaced'])("never rescues credentials over a %s disk record",async kind=>{
 await setup();const initial=(await loadAccounts())!;initial.accounts.push({recordId:'other',accountId:'other',refreshToken:'fixture-other',addedAt:2,lastUsed:2,accountLabel:'Before'});await saveAccounts(initial);
 const manager=new AccountManager(undefined,await loadAccounts());manager.getAccountByIndex(1)!.accountLabel='Local';
 const disk=(await loadAccounts())!;disk.accounts[1]!.accountLabel='External';
 if(kind==='removed')disk.accounts.splice(0,1);
 if(kind==='disabled')disk.accounts[0]!.enabled=false;
 if(kind==='invalidated')disk.accounts[0]!.authInvalidatedAt=Date.now();
 if(kind==='replaced')disk.accounts[0]!.refreshToken='fixture-external';
 await saveAccounts(disk);
 await expect(manager.commitRefreshedAuth(manager.getAccountByIndex(0)!,{type:'oauth',access:'fixture-new',refresh:'fixture-new',expires:Date.now()+3600000})).rejects.toThrow();
 expect((await loadAccounts())?.accounts.some(a=>a.refreshToken==='fixture-new')).toBe(false);
});


const reviewFallbackJwt = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.sig`;
it("persists an unmatched auth fallback account on the first save", async () => {
    await setup();
    const manager = new AccountManager({ type: "oauth", access: reviewFallbackJwt("fallback"), refresh: "fixture-fallback", expires: Date.now() + 3_600_000 }, await loadAccounts());
    expect(manager.getAccountCount()).toBe(2);
    await manager.saveToDisk();
    expect((await loadAccounts())?.accounts.map(row => row.refreshToken).sort()).toEqual(["fixture-fallback", "fixture-first"]);
});
it("persists a matched auth fallback's newer refresh token on the first save", async () => {
    await setup();
    const manager = new AccountManager({ type: "oauth", access: reviewFallbackJwt("first"), refresh: "fixture-rotated", expires: Date.now() + 3_600_000 }, await loadAccounts());
    expect(manager.getAccountCount()).toBe(1);
    await manager.saveToDisk();
    expect((await loadAccounts())?.accounts.map(row => row.refreshToken)).toEqual(["fixture-rotated"]);
});

it("lets two managers disable different workspaces across repeated saves", async () => {
    const first = await setup();
    const second = new AccountManager(undefined, await loadAccounts());
    first.disableCurrentWorkspace(first.getAccountByIndex(0)!, "personal");
    const other = second.getAccountByIndex(0)!;
    other.currentWorkspaceIndex = 1;
    second.disableCurrentWorkspace(other, "business");
    await first.saveToDisk();
    await second.saveToDisk();
    await first.saveToDisk();
    await second.saveToDisk();
    const workspaces = (await loadAccounts())!.accounts[0]!.workspaces!;
    expect(workspaces.map(w => [w.id, w.enabled])).toEqual([["personal", false], ["business", false]]);
});
it("persists an identity-changing refresh and its cleared auth cooldown despite a concurrent label edit", async () => {
    await setup();
    const initial = (await loadAccounts())!;
    Object.assign(initial.accounts[0]!, { email: "old@example.test", coolingDownUntil: Date.now() + 600000, cooldownReason: "auth-failure" });
    await saveAccounts(initial);
    const manager = new AccountManager(undefined, await loadAccounts());
    manager.getAccountByIndex(0)!.accountLabel = "Local";
    const disk = (await loadAccounts())!;
    disk.accounts[0]!.accountLabel = "External";
    await saveAccounts(disk);
    const access = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "first", email: "new@example.test" } })).toString("base64url")}.signature`;
    await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access, refresh: "fixture-rotated", expires: Date.now() + 3600000 });
    const row = (await loadAccounts())!.accounts[0]!;
    expect(row.refreshToken).toBe("fixture-rotated");
    expect(row.email).toBe("new@example.test");
    expect(row.coolingDownUntil).toBeUndefined();
    expect(row.cooldownReason).toBeUndefined();
    expect(row.accountLabel).toBe("External");
});

for (const conflict of [false, true]) {
 it.each(["network-error", "rate-limit"])(`preserves a concurrent %s cooldown during refresh (label conflict=${conflict})`, async reason => {
    await setup();
    const initial = (await loadAccounts())!;
    Object.assign(initial.accounts[0]!, { coolingDownUntil: Date.now() + 60000, cooldownReason: "auth-failure" });
    await saveAccounts(initial);
    const manager = new AccountManager(undefined, await loadAccounts());
    if (conflict) manager.getAccountByIndex(0)!.accountLabel = "Local";
    const disk = (await loadAccounts())!;
    const until = Date.now() + 600000;
    Object.assign(disk.accounts[0]!, { accountLabel: "External", coolingDownUntil: until, cooldownReason: reason });
    await saveAccounts(disk);
    await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 });
    expect((await loadAccounts())!.accounts[0]).toMatchObject({ refreshToken: "fixture-rotated", accountLabel: "External", coolingDownUntil: until, cooldownReason: reason });
    expect(manager.getAccountByIndex(0)).toMatchObject({ coolingDownUntil: until, cooldownReason: reason });
    expect(manager.isAccountCoolingDown(manager.getAccountByIndex(0)!)).toBe(true);
    if (conflict) await expect(manager.saveToDisk()).rejects.toMatchObject({ code: "ESTALE" });
    manager.getAccountByIndex(0)!.accountLabel = "External";
    await manager.saveToDisk();
    await manager.saveToDisk();
    expect((await loadAccounts())!.accounts[0]).toMatchObject({ coolingDownUntil: until, cooldownReason: reason });
 });
}

it.each([false, true])("allows an explicit cooldown clear after a refreshed blocker was adopted (conflict=%s)", async conflict => {
 const manager = await setup();
 if (conflict) manager.getAccountByIndex(0)!.accountLabel = "Local";
 const disk = (await loadAccounts())!;
 Object.assign(disk.accounts[0]!, { accountLabel: "External", coolingDownUntil: Date.now() + 600000, cooldownReason: "network-error" });
 await saveAccounts(disk);
 await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 });
 manager.getAccountByIndex(0)!.accountLabel = "External";
 manager.clearAccountCooldown(manager.getAccountByIndex(0)!);
 await manager.saveToDisk();
 expect((await loadAccounts())!.accounts[0]!.coolingDownUntil).toBeUndefined();
 expect((await loadAccounts())!.accounts[0]!.cooldownReason).toBeUndefined();
});

it.each([false, true])("clears the loser's auth-failure cooldown when this process wins a single-use refresh (label conflict=%s)", async conflict => {
    // Process A (this manager) and process B both hold refresh token fixture-first.
    const manager = await setup();
    if (conflict) manager.getAccountByIndex(0)!.accountLabel = "Local";
    // B redeems the token first in the upstream race's losing order: its refresh
    // fails with invalid_grant, so it records an auth-failure cooldown against
    // fixture-first and saves. A's baseline never held that cooldown.
    const loser = (await loadAccounts())!;
    Object.assign(loser.accounts[0]!, { coolingDownUntil: Date.now() + 600000, cooldownReason: "auth-failure", ...(conflict ? { accountLabel: "External" } : {}) });
    await saveAccounts(loser);
    // A's refresh succeeded upstream with the same single-use token.
    await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 });
    const row = (await loadAccounts())!.accounts[0]!;
    expect(row.refreshToken).toBe("fixture-rotated");
    expect(row.coolingDownUntil).toBeUndefined();
    expect(row.cooldownReason).toBeUndefined();
    expect(manager.isAccountCoolingDown(manager.getAccountByIndex(0)!)).toBe(false);
});

it("refuses backup recovery as the merge base after primary corruption", async () => {
 await setup();
 const proposed = (await loadAccounts())!;
 const path = getStoragePath();
 const backup = structuredClone(proposed);
 backup.accounts.push({recordId:"backup-only",accountId:"backup-only",refreshToken:"fixture-old",addedAt:1,lastUsed:1});
 await writeFile(path + ".bak", JSON.stringify(backup));
 await writeFile(path, "{corrupt");
 proposed.accounts[0]!.accountLabel = "Local edit";
 // Unreadable storage is reported as such, not as a concurrent edit.
 const failure = saveAccounts(proposed);
 await expect(failure).rejects.toMatchObject({code:"EACCOUNTSUNREADABLE"});
 await expect(failure).rejects.not.toThrow(/concurrently/);
 expect(await readFile(path,"utf8")).toBe("{corrupt");
});

async function writeJournal(path: string, storage: unknown) {
 const { createHash } = await import("node:crypto");
 const content = JSON.stringify(storage);
 await writeFile(path + ".wal", JSON.stringify({ version: 1, content, checksum: createHash("sha256").update(content).digest("hex") }));
}

it("merges a transaction against a recoverable journal when the primary is missing", async () => {
 const manager = await setup();
 const path = getStoragePath();
 const journal = (await loadAccounts())!;
 journal.accounts.push({ recordId: "journal-only", accountId: "journal-only", refreshToken: "fixture-journal", addedAt: 2, lastUsed: 2 });
 await writeJournal(path, journal);
 await rm(path);
 const { withAccountStorageTransaction } = await import("../lib/storage.js");
 await withAccountStorageTransaction(async (current, persist) => persist({ ...(current ?? { version: 3 as const, activeIndex: 0, accounts: [] }), accounts: [...(current?.accounts ?? []), { recordId: "new", accountId: "new", refreshToken: "fixture-new", addedAt: 3, lastUsed: 3 }] }));
 expect((await loadAccounts())?.accounts.map(a => a.recordId)).toEqual(["first", "journal-only", "new"]);
 manager.getAccountByIndex(0)!.lastUsed = 30;
 await manager.saveToDisk();
 expect((await loadAccounts())?.accounts.map(a => a.recordId)).toEqual(["first", "journal-only", "new"]);
});

it("keeps a rotated refresh token live instead of dropping it when the primary is corrupt", async () => {
 const manager = await setup();
 const path = getStoragePath();
 await writeFile(path + ".bak", await readFile(path, "utf8"));
 await writeFile(path, "{corrupt");
 const committed = await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 });
 expect(committed?.refreshToken).toBe("fixture-rotated");
 // A torn/corrupt primary is never replaced from an older backup behind the user's back.
 expect(await readFile(path, "utf8")).toBe("{corrupt");
 await writeFile(path, await readFile(path + ".bak", "utf8"));
 await manager.flushPendingSave();
 expect((await loadAccounts())?.accounts.map(a => a.refreshToken)).toEqual(["fixture-rotated"]);
});

it("keeps a rotated refresh token while the primary stays locked and saves it once readable", async () => {
 const { vi } = await import("vitest");
 const { promises: fs } = await import("node:fs");
 const manager = await setup();
 const path = getStoragePath();
 const original = fs.readFile.bind(fs);
 const locked = vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...rest: unknown[]) => {
  if (String(file) === path) throw Object.assign(new Error("locked"), { code: "EBUSY" });
  return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
 }) as typeof fs.readFile);
 try {
  const committed = await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 });
  expect(committed?.refreshToken).toBe("fixture-rotated");
  expect(manager.getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated");
 } finally { locked.mockRestore(); }
 await manager.flushPendingSave();
 expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("fixture-rotated");
});

it("recovers a rotated refresh token in a new process when the old one exits before saving", async () => {
 const { vi } = await import("vitest");
 const { promises: fs, existsSync } = await import("node:fs");
 const manager = await setup();
 const path = getStoragePath();
 const original = fs.readFile.bind(fs);
 const locked = vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...rest: unknown[]) => {
  if (String(file) === path) throw Object.assign(new Error("locked"), { code: "EBUSY" });
  return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
 }) as typeof fs.readFile);
 try {
  await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 });
 } finally { locked.mockRestore(); }
 // The first process dies here: its debounced save never runs.
 expect(JSON.parse(await readFile(path, "utf8")).accounts[0].refreshToken).toBe("fixture-first");
 const next = new AccountManager(undefined, await loadAccounts());
 expect(next.getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated");
 await next.saveToDisk();
 expect(JSON.parse(await readFile(path, "utf8")).accounts[0].refreshToken).toBe("fixture-rotated");
 expect(existsSync(path + ".pending-auth.json")).toBe(false);
 await manager.flushPendingSave();
 expect((await loadAccounts())?.accounts[0]?.refreshToken).toBe("fixture-rotated");
});

async function withAccountsWriteLocked<T>(path: string, run: () => Promise<T>): Promise<T> {
 const { vi } = await import("vitest");
 const { promises: fs } = await import("node:fs");
 const original = fs.rename.bind(fs);
 // The read succeeds but the atomic replace keeps failing, like a scanner holding accounts.json.
 const spy = vi.spyOn(fs, "rename").mockImplementation((async (from: unknown, to: unknown) => {
  if (String(to) === path) throw Object.assign(new Error("busy"), { code: "EBUSY" });
  return original(from as string, to as string);
 }) as typeof fs.rename);
 try { return await run(); } finally { spy.mockRestore(); }
}

it("journals a rotated token when the accounts write keeps failing with EBUSY", async () => {
 const manager = await setup();
 const path = getStoragePath();
 const committed = await withAccountsWriteLocked(path, () => manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 }));
 expect(committed?.refreshToken).toBe("fixture-rotated");
 expect(manager.getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated");
 // A new process recovers it even though this one never saved.
 const next = new AccountManager(undefined, await loadAccounts());
 expect(next.getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated");
 await manager.flushPendingSave();
});

it("chains a second rotation of the same account while the first is only journaled", async () => {
 const manager = await setup();
 const path = getStoragePath();
 await withAccountsWriteLocked(path, async () => {
  await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh-1", refresh: "fixture-rotated-1", expires: Date.now() + 3600000 });
  await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh-2", refresh: "fixture-rotated-2", expires: Date.now() + 7200000 });
 });
 expect(JSON.parse(await readFile(path, "utf8")).accounts[0].refreshToken).toBe("fixture-first");
 const next = new AccountManager(undefined, await loadAccounts());
 expect(next.getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated-2");
 await manager.flushPendingSave();
});

it("keeps a journaled rotated token live when a native request re-reads the unchanged primary", async () => {
 const { createNativeAccountStorageReader } = await import("../lib/runtime/native-account-storage.js");
 const { syncNativeAccountCredentials } = await import("../lib/runtime/native-account-sync.js");
 const manager = await setup();
 const path = getStoragePath();
 const readNative = createNativeAccountStorageReader(undefined, path);
 await readNative();
 await withAccountsWriteLocked(path, () => manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, { type: "oauth", access: "fixture-fresh", refresh: "fixture-rotated", expires: Date.now() + 3600000 }));
 // The deferred save has not run; the primary still holds the spent token.
 expect(JSON.parse(await readFile(path, "utf8")).accounts[0].refreshToken).toBe("fixture-first");
 const snapshot = await readNative();
 expect(snapshot.verified).toBe(true);
 syncNativeAccountCredentials(manager, snapshot.storage!);
 expect(manager.getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated");
 expect(manager.getAccountByIndex(0)?.access).toBe("fixture-fresh");
 await manager.flushPendingSave();
});

 it("journals a spent rotation when the primary write fails with EACCES", async () => {
 const {vi}=await import("vitest"); const {promises:fs}=await import("node:fs");
 const manager = await setup();
 const path = getStoragePath();
 const original = fs.rename.bind(fs);
 const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
  if (String(to) === path) throw Object.assign(new Error("denied"), {code:"EACCES"});
  return original(from, to);
 });
 try {
  const result = await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!, {type:"oauth",access:"fixture-fresh",refresh:"fixture-rotated",expires:Date.now()+3600000});
  expect(result?.refreshToken).toBe("fixture-rotated");
  expect(new AccountManager(undefined,await loadAccounts()).getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated");
 } finally {rename.mockRestore();await manager.flushPendingSave();}
});

it("saves the first account from a synthetic missing-store load",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"fresh-pool-"));dirs.push(dir);setStoragePathDirect(join(dir,"accounts.json"));
 const storage=(await loadAccounts())!;
 expect(storage.accounts).toEqual([]);
 storage.accounts.push({accountId:"first",refreshToken:"fixture-first",addedAt:1,lastUsed:1});
 await saveAccounts(storage);
 expect((await loadAccounts())?.accounts).toHaveLength(1);
});
it("persists runtime blockers during debounced saves while conflicting user edits remain pending",async()=>{
 const manager=await setup();const live=manager.getAccountByIndex(0)!;
 live.accountLabel="Local";
 const external=(await loadAccounts())!;external.accounts[0]!.accountLabel="External";await saveAccounts(external);
 const until=Date.now()+60000;
 live.rateLimitResetTimes={codex:until};live.coolingDownUntil=until;live.cooldownReason="rate-limit";
 manager.saveToDiskDebounced();await manager.flushPendingSave();
 expect((await loadAccounts())?.accounts[0]).toMatchObject({accountLabel:"External",rateLimitResetTimes:{codex:until},coolingDownUntil:until,cooldownReason:"rate-limit"});
 expect(live.accountLabel).toBe("Local");
 live.rateLimitResetTimes.codex=until+1000;manager.saveToDiskDebounced();await manager.flushPendingSave();
 expect((await loadAccounts())?.accounts[0]?.rateLimitResetTimes?.codex).toBe(until+1000);
 await expect(manager.saveToDisk()).rejects.toMatchObject({code:"ESTALE"});
});
it("journals a spent rotation after account lock acquisition times out",async()=>{
 const {vi}=await import("vitest");const locks=await import("../lib/storage/file-lock.js");
 const manager=await setup(),path=getStoragePath(),original=locks.withFileTransactionLock;
 const lock=vi.spyOn(locks,"withFileTransactionLock").mockImplementation((target,action,options)=>{
  if(target===path)throw Object.assign(Error("busy"),{code:"ELOCKED"});
  return original(target,action,options);
 });
 try {expect(await manager.commitRefreshedAuth(manager.getAccountByIndex(0)!,{type:"oauth",access:"fixture-new",refresh:"fixture-rotated",expires:Date.now()+3600000})).toMatchObject({refreshToken:"fixture-rotated"});}
 finally {lock.mockRestore();}
 expect(new AccountManager(undefined,await loadAccounts()).getAccountByIndex(0)?.refreshToken).toBe("fixture-rotated");
 await manager.flushPendingSave();
});
it("preserves a live network cooldown while rescuing a journaled rotation",async()=>{
 const {vi}=await import("vitest");const locks=await import("../lib/storage/file-lock.js");
 const manager=await setup(),path=getStoragePath(),original=locks.withFileTransactionLock;
 const live=manager.getAccountByIndex(0)!,until=Date.now()+60000;
 live.coolingDownUntil=until;live.cooldownReason="network-error";
 const lock=vi.spyOn(locks,"withFileTransactionLock").mockImplementation((target,action,options)=>{
  if(target===path)throw Object.assign(Error("busy"),{code:"ELOCKED"});
  return original(target,action,options);
 });
 try {
  await manager.commitRefreshedAuth(live,{type:"oauth",access:"fixture-new",refresh:"fixture-rotated",expires:Date.now()+3600000});
  expect(live).toMatchObject({coolingDownUntil:until,cooldownReason:"network-error"});
 } finally {lock.mockRestore();await manager.flushPendingSave();}
});
