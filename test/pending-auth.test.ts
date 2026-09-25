import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPendingAuth, getPendingAuthPath, prunePendingAuth, recordPendingAuth } from "../lib/storage/pending-auth.js";

const logs = vi.hoisted(() => ({error:vi.fn(),warn:vi.fn()}));
vi.mock("../lib/logger.js", async importOriginal => {
 const actual=await importOriginal<typeof import("../lib/logger.js")>();
 return {...actual,createLogger:(name:string)=>({...actual.createLogger(name),error:logs.error,warn:logs.warn})};
});
let dir: string;
let storagePath: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "pending-auth-"));
	storagePath = join(dir, "accounts.json");
});
afterEach(async () => {
	vi.restoreAllMocks();
 vi.clearAllMocks();
 const {setStoragePathDirect}=await import("../lib/storage.js");setStoragePathDirect(null);
	await fs.rm(dir, { recursive: true, force: true });
});
const rotation = (prior: string, next: string) => ({ priorRefreshToken: prior, refreshToken: next, accessToken: `access-${next}`, expiresAt: 1, at: 1 });
const storage = () => ({ version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "spent-a", addedAt: 1, lastUsed: 1 }, { refreshToken: "spent-b", addedAt: 1, lastUsed: 1 }] });
function failReads(code: string, times: number) {
	const path = getPendingAuthPath(storagePath);
	const original = fs.readFile.bind(fs);
	let left = times;
	return vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...rest: unknown[]) => {
		if (String(file) === path && left-- > 0) throw Object.assign(new Error("busy"), { code });
		return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
	}) as typeof fs.readFile);
}

it("retries a transient lock and keeps other accounts' pending tokens", async () => {
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	failReads("EBUSY", 2);
	await recordPendingAuth(storagePath, rotation("spent-b", "new-b"));
	vi.restoreAllMocks();
	const applied = await applyPendingAuth(storagePath, storage());
	expect(applied?.accounts.map((a) => a.refreshToken)).toEqual(["new-a", "new-b"]);
});

it("refuses to overwrite when the pending file stays unreadable", async () => {
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	failReads("EBUSY", 1000);
	await expect(recordPendingAuth(storagePath, rotation("spent-b", "new-b"))).rejects.toThrow();
	vi.restoreAllMocks();
	const applied = await applyPendingAuth(storagePath, storage());
	expect(applied?.accounts[0]?.refreshToken).toBe("new-a");
});

it("never overwrites a corrupt pending file", async () => {
	const path = getPendingAuthPath(storagePath);
	await fs.writeFile(path, "{torn");
	await expect(recordPendingAuth(storagePath, rotation("spent-b", "new-b"))).rejects.toThrow();
	await expect(prunePendingAuth(storagePath, storage())).rejects.toThrow();
	expect(await fs.readFile(path, "utf8")).toBe("{torn");
});

it("never logs journal contents on read or post-save prune failures",async()=>{
 const {saveAccounts,setStoragePathDirect}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);
 await fs.writeFile(getPendingAuthPath(storagePath),'fixture-secret');
 await applyPendingAuth(storagePath,storage());
 await saveAccounts(storage());
 expect(logs.error).toHaveBeenCalled();expect(logs.warn).toHaveBeenCalled();
 expect(JSON.stringify([logs.error.mock.calls,logs.warn.mock.calls])).not.toContain("fixture-secret");
});
it("clears the pending journal only after its writer releases the lock",async()=>{
 const {withFileTransactionLock}=await import("../lib/storage/file-lock.js");
 const {clearAccounts,setStoragePathDirect,saveAccounts}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);await saveAccounts(storage());
 const path=getPendingAuthPath(storagePath);
 let release!:()=>void, entered!:()=>void,attempted!:()=>void;
 const gate=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r),attempt=new Promise<void>(r=>attempted=r);
 const writer=withFileTransactionLock(path,async()=>{entered();await gate;await fs.writeFile(path,"private fixture");});
 await inside;
 const lockPath=join(await fs.realpath(dir), "accounts.json.pending-auth.json.write-lock");
 const original=fs.rename.bind(fs);
 vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{if(String(to)===lockPath)attempted();return original(from,to);});
 const remove=vi.spyOn(fs,"rm");
 const clear=clearAccounts();
 try {
  await Promise.race([attempt,clear]);
  expect(remove.mock.calls.some(([file])=>String(file)===path)).toBe(false);
 } finally {release();await writer;await clear;}
 await expect(fs.stat(path)).rejects.toMatchObject({code:"ENOENT"});
});
it("retries a transient Windows lock when clearing pending credentials",async()=>{
 const {clearAccounts,setStoragePathDirect,saveAccounts}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);await saveAccounts(storage());
 await recordPendingAuth(storagePath,rotation("spent-a","fresh"));
 const path=getPendingAuthPath(storagePath),original=fs.rm.bind(fs);let attempts=0;
 vi.spyOn(fs,"rm").mockImplementation(async(file,options)=>{
  if(String(file)===path && ++attempts===1)throw Object.assign(new Error("busy"),{code:"EBUSY"});
  return original(file,options);
 });
 await clearAccounts();expect(attempts).toBe(2);
 await expect(fs.stat(path)).rejects.toMatchObject({code:"ENOENT"});
});
it("refuses a late rotated credential after the pool was reset",async()=>{
 const {clearAccounts,setStoragePathDirect,saveAccounts}=await import("../lib/storage.js");
 setStoragePathDirect(storagePath);await saveAccounts(storage());await clearAccounts();
 await expect(recordPendingAuth(storagePath,rotation("spent-a","late"))).rejects.toMatchObject({code:"ESTALE"});
 await expect(fs.stat(getPendingAuthPath(storagePath))).rejects.toMatchObject({code:"ENOENT"});
});
it.each(["auth-failure","network-error","rate-limit"] as const)("only clears obsolete authentication blockers when replaying journaled auth (%s)",async reason=>{
 await recordPendingAuth(storagePath,rotation("spent-a","fresh"));
 const pool=storage();Object.assign(pool.accounts[0]!,{coolingDownUntil:Date.now()+60000,cooldownReason:reason,authInvalidatedAt:1});
 const result=await applyPendingAuth(storagePath,pool);
 expect(result?.accounts[0]?.authInvalidatedAt).toBeUndefined();
 if(reason==="auth-failure")expect(result?.accounts[0]?.coolingDownUntil).toBeUndefined();
 else expect(result?.accounts[0]?.cooldownReason).toBe(reason);
});
