import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearAccountsAndCredentialSidecars, clearCredentialSidecars } from "../lib/storage/credential-sidecars.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
let root:string;
beforeEach(async()=>{root=await fs.mkdtemp(join(tmpdir(),"probe-lease-wipe-"));vi.stubEnv("CODEX_MULTI_AUTH_DIR",root);});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await removeWithRetry(root,{recursive:true,force:true});});
it("finishes account reset when a concurrent uninstall removes the root before the lease sweep",async()=>{
 const read=fs.readdir.bind(fs),remove=vi.spyOn(fs,"rm");let removed=false;
 vi.spyOn(fs,"readdir").mockImplementation(async(...args)=>{
  if(String(args[0])===root&&args[1]===undefined&&!removed){removed=true;await removeWithRetry(root,{recursive:true,force:true});}
  return read(...args);
 });
 const clearPool=vi.fn(async()=>{});
 await expect(clearAccountsAndCredentialSidecars(clearPool)).resolves.toBeUndefined();
 expect(clearPool).toHaveBeenCalledOnce();expect(removed).toBe(true);
 expect(remove).toHaveBeenCalledWith(join(root,"inference-activity"),{recursive:true,force:true});
 await expect(fs.stat(root)).rejects.toMatchObject({code:"ENOENT"});
});
it.each(["EACCES","EIO"])("reports %s while enumerating old leases",async code=>{
 const read=fs.readdir.bind(fs),error=Object.assign(Error("unreadable"),{code});
 vi.spyOn(fs,"readdir").mockImplementation(async(...args)=>{
  if(String(args[0])===root&&args[1]===undefined)throw error;
  return read(...args);
 });
 await expect(clearCredentialSidecars()).rejects.toBe(error);
});
it("wipes crashed published and candidate probe locks, including a prior interrupted wipe",async()=>{
 const trees=["api-probe-locks","api-probe-locks.wiped-00000000-0000-4000-8000-000000000001"];
 for(const tree of trees)for(const suffix of [".write-lock",".write-lock.candidate-fixture"]){
  const path=join(root,tree,"a".repeat(64)+suffix);await fs.mkdir(path,{recursive:true});await fs.writeFile(join(path,"dead-owner"),"");
 }
 await fs.writeFile(join(root,"unrelated"),"preserve");
 await clearCredentialSidecars();
 expect(await fs.readdir(root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^api-probe-locks/)]));
 expect(await fs.readFile(join(root,"unrelated"),"utf8")).toBe("preserve");
});
it.each(["POSIX","Windows"])("old holder and candidate cleanup preserve a replacement lease with %s path spelling",async style=>{
 const path=join(root,"api-probe-locks","b".repeat(64));
 let enterOld!:()=>void,releaseOld!:()=>void,enterCandidate!:(matched:boolean)=>void,releaseCandidate!:()=>void,enterNew!:()=>void,releaseNew!:()=>void;
 const oldEntered=new Promise<void>(r=>enterOld=r),oldGate=new Promise<void>(r=>releaseOld=r);
 const candidateEntered=new Promise<boolean>(r=>enterCandidate=r),candidateGate=new Promise<void>(r=>releaseCandidate=r);
 const newEntered=new Promise<void>(r=>enterNew=r),newGate=new Promise<void>(r=>releaseNew=r);
 const old=withFileTransactionLock(path,async()=>{enterOld();await oldGate;});
 await oldEntered;
 const rename=fs.rename.bind(fs);let block=true;
 vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{
  if(block){
   // Exercise both platform spellings while renaming the native filesystem path.
   const destination=String(to).replaceAll("\\","/").replaceAll("/",style==="Windows"?"\\":"/");
   const matched=win32.basename(destination)===`${"b".repeat(64)}.write-lock`;
   block=false;enterCandidate(matched);if(matched)await candidateGate;
  }
  return rename(from,to);
 });
 let waiter:Promise<unknown>|undefined,replacement:Promise<unknown>|undefined;
 try{
  waiter=withFileTransactionLock(path,async()=>{throw Error("Old candidate must not acquire");}).catch(error=>error);
  expect(await candidateEntered).toBe(true);
  await clearCredentialSidecars();
  await expect(fs.stat(join(root,"api-probe-locks"))).rejects.toMatchObject({code:"ENOENT"});
  replacement=withFileTransactionLock(path,async()=>{enterNew();await newGate;});await newEntered;
  const owners=await fs.readdir(`${path}.write-lock`);
  releaseOld();releaseCandidate();await old;
  expect(await waiter).toMatchObject({code:"ENOENT"});
  expect(await fs.readdir(`${path}.write-lock`)).toEqual(owners);
 }finally{releaseOld();releaseCandidate();releaseNew();await Promise.allSettled([old,waiter,replacement]);}
});
it("does not recreate lease fingerprints when a prevalidated probe resumes after wipe",async()=>{
 const api=await import("../lib/api-route-store.js"),locks=await import("../lib/storage/file-lock.js");
 const {enrichPersistedApiCapabilities,resetPersistedApiCapabilitiesForTests}=await import("../lib/runtime/persisted-api-capabilities.js");
 const route={id:"fixture",label:"fixture",kind:"api" as const,apiKey:"fixture",priority:9,enabled:true,probeCapabilities:true,visibleModels:["fixture"]};
 await api.saveApiRoutes([route]);
 let entered!:()=>void,release!:()=>void,blocked=false;
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),lock=locks.withFileTransactionLock;
 vi.spyOn(locks,"withFileTransactionLock").mockImplementation(async(...args)=>{
  if(!blocked&&String(args[0]).includes("api-probe-locks")){blocked=true;entered();await gate;}
  return lock(...args);
 });
 let posts=0;
 const pending=enrichPersistedApiCapabilities([{slug:"fixture"}],false,route,true,{requireStoredRoute:true,fetchImpl:async(_url,init)=>{if(init?.method==="POST")posts++;return new Response("missing",{status:404});}});
 try{
  await started;await clearCredentialSidecars();release();await pending;
  expect(posts).toBe(0);
  await expect(fs.stat(join(root,"api-probe-locks"))).rejects.toMatchObject({code:"ENOENT"});
 }finally{release();await pending;resetPersistedApiCapabilitiesForTests();}
});
it.each(["EBUSY","EPERM"])("retries detached probe lease cleanup after %s",async code=>{
 const path=join(root,"api-probe-locks","c".repeat(64)+".write-lock");await fs.mkdir(path,{recursive:true});
 const remove=fs.rm.bind(fs);let failed=false;
 vi.spyOn(fs,"rm").mockImplementation(async(...args)=>{
  if(!failed&&String(args[0]).includes("api-probe-locks.wiped-")){failed=true;throw Object.assign(Error("locked"),{code});}
  return remove(...args);
 });
 await clearCredentialSidecars();expect(failed).toBe(true);
 expect((await fs.readdir(root)).filter(name=>name.startsWith("api-probe-locks"))).toEqual([]);
});
it("reports failed lease cleanup and recovers it on the next wipe without touching unrelated files",async()=>{
 const path=join(root,"api-probe-locks","d".repeat(64)+".write-lock");await fs.mkdir(path,{recursive:true});
 await fs.writeFile(join(root,"unrelated"),"keep");
 const remove=fs.rm.bind(fs);const spy=vi.spyOn(fs,"rm").mockImplementation(async(...args)=>{
  if(String(args[0]).includes("api-probe-locks.wiped-"))throw Object.assign(Error("unavailable"),{code:"EIO"});
  return remove(...args);
 });
 await expect(clearCredentialSidecars()).rejects.toMatchObject({code:"EIO"});spy.mockRestore();
 expect((await fs.readdir(root)).some(name=>name.startsWith("api-probe-locks.wiped-"))).toBe(true);
 await clearCredentialSidecars();
 expect((await fs.readdir(root)).filter(name=>name.startsWith("api-probe-locks"))).toEqual([]);
 expect(await fs.readFile(join(root,"unrelated"),"utf8")).toBe("keep");
});
