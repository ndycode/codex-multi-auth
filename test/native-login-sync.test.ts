import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";
import { syncNativeLogin } from "../lib/runtime/native-login-sync.js";
import { createNativeAccountStorageReader } from "../lib/runtime/native-account-storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { startRuntimeRotationProxy } from "../lib/runtime-rotation-proxy.js";
let dir: string, path: string;
const now = 1800000000000;
const jwt = (iat: number, id = "workspace", email = "fixture@example.test") => `e30.${Buffer.from(JSON.stringify({iat,email,exp:iat+3600,"https://api.openai.com/auth":{chatgpt_account_id:id},"https://api.openai.com/profile":{email}})).toString("base64url")}.fixture`;
const pool = (): AccountStorageV3 => ({version:3,activeIndex:0,pinnedAccountIndex:0,accounts:[{recordId:"fixture",accountId:"workspace",email:"fixture@example.test",accessToken:jwt(now/1000-7200),refreshToken:"old",expiresAt:now-3600000,addedAt:1,lastUsed:1,cooldownReason:"auth-failure",coolingDownUntil:now+60000,authInvalidatedAt:now-1000,rateLimitResetTimes:{codex:now+120000}}]});
const auth = (access = jwt(now/1000)) => JSON.stringify({tokens:{access_token:access,refresh_token:"fresh"}});
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"native-login-"));path=join(dir,"pool.json");setStoragePathDirect(path);vi.stubEnv("CODEX_HOME",dir);vi.spyOn(Date,"now").mockReturnValue(now);});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();setStoragePathDirect(null);await removeWithRetry(dir,{recursive:true,force:true});});
it.each([false,true])("adopts login when only auth.json changes (warm cache: %s)",async warm=>{
 const disk=pool();await writeFile(path,JSON.stringify(disk));await utimes(path,new Date(0),new Date(0));
 const reader=createNativeAccountStorageReader();if(warm)expect((await reader()).storage!.accounts[0]!.refreshToken).toBe("old");
 await writeFile(join(dir,"auth.json"),auth());
 const snapshot=await reader();expect(snapshot.verified).toBe(true);
 const a=snapshot.storage!.accounts[0]!;expect(a.refreshToken).toBe("fresh");expect(a.cooldownReason).toBeUndefined();expect(a.authInvalidatedAt).toBeUndefined();
 expect(snapshot.storage!.pinnedAccountIndex).toBe(0);expect(a.rateLimitResetTimes).toEqual(disk.accounts[0]!.rateLimitResetTimes);
 expect(JSON.parse(await readFile(path,"utf8")).accounts[0].refreshToken).toBe("fresh");
 expect((await reader()).storage!.accounts[0]!.refreshToken).toBe("fresh");
});
it.each(["older","expired","different-account","different-email","disabled","ambiguous"])("rejects %s native credentials",async mode=>{
 const disk=pool();let access=jwt(now/1000);
 if(mode==="older")disk.accounts[0]!.accessToken=jwt(now/1000+1);
 if(mode==="expired")access=jwt(now/1000-4000);
 if(mode==="different-account")access=jwt(now/1000,"other");
 if(mode==="different-email")access=jwt(now/1000,"workspace","other@example.test");
 if(mode==="disabled")disk.accounts[0]!.enabled=false;
 if(mode==="ambiguous")disk.accounts.push({...disk.accounts[0]!,recordId:"duplicate"});
 await writeFile(path,JSON.stringify(disk));expect(await syncNativeLogin(disk,async()=>auth(access))).toBe(false);
 expect(JSON.parse(await readFile(path,"utf8"))).toEqual(disk);
});
it("adopts a newer access token when native login keeps the refresh token",async()=>{
 const disk=pool();disk.accounts[0]!.refreshToken="fresh";await writeFile(path,JSON.stringify(disk));
 expect(await syncNativeLogin(disk,async()=>auth())).toBe(true);
});
it("rejects a conflicting id token email",async()=>{
 const disk=pool();await writeFile(path,JSON.stringify(disk));
 const conflicting=JSON.stringify({tokens:{access_token:jwt(now/1000),refresh_token:"fresh",id_token:jwt(now/1000,"workspace","other@example.test")} });
 expect(await syncNativeLogin(disk,async()=>conflicting)).toBe(false);
});
it("does not overwrite a concurrent newer credential or a removed account",async()=>{
 const stale=pool(),current=pool();current.accounts[0]!.accessToken=jwt(now/1000+1);current.accounts[0]!.refreshToken="newer";
 await writeFile(path,JSON.stringify(current));expect(await syncNativeLogin(stale,async()=>auth())).toBe(false);
 current.accounts=[];await writeFile(path,JSON.stringify(current));expect(await syncNativeLogin(stale,async()=>auth())).toBe(false);
});
it("rejects a native credential changed during acquisition",async()=>{
 const disk=pool();await writeFile(path,JSON.stringify(disk));let reads=0;
 expect(await syncNativeLogin(disk,async()=>++reads===1?auth():auth(jwt(now/1000+1)))).toBe(false);
});
it("imports the complete pair before router startup hydration",async()=>{
 const disk=pool();await writeFile(path,JSON.stringify(disk));await writeFile(join(dir,"auth.json"),auth());
 const proxy=await startRuntimeRotationProxy({port:0,clientApiKey:"fixture-key"});
 try {
  const saved=JSON.parse(await readFile(path,"utf8"));
  expect(saved.accounts[0].accessToken).toBe(jwt(now/1000));expect(saved.accounts[0].refreshToken).toBe("fresh");
  expect(saved.accounts[0].cooldownReason).toBeUndefined();expect(saved.pinnedAccountIndex).toBe(0);
 } finally {await proxy.close();}
});
