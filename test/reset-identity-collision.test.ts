import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '../lib/storage.js';
import * as native from '../lib/runtime/native-rate-limits.js';
import { AccountManager } from '../lib/accounts.js';
import { createResetCreditService, resetTargetForStoredAccount } from '../lib/runtime/account-reset-credits.js';
import { runResetsCommand } from '../lib/codex-manager/commands/resets.js';
let dir: string;
beforeEach(async () => {
 dir=await mkdtemp(join(tmpdir(),'reset-identity-'));
 vi.stubEnv('CODEX_MULTI_AUTH_DIR',dir);
 vi.spyOn(console,'log').mockImplementation(()=>{});
 vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.spyOn(native,'nativeRateLimitsRpc').mockImplementation(async auth=>({accountId:auth.accountId,rateLimitResetCredits:{availableCount:auth.accessToken==='access-one'?3:7},rateLimits:{planType:'pro'}}));
});
afterEach(async () => {vi.restoreAllMocks();vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true,maxRetries:5});});
function imported(duplicate=true) {
 const accounts=['one','two'].map((id,index)=>({recordId:duplicate?'shared':id,accountId:'workspace',email:`${id}@example.test`,refreshToken:`refresh-${id}`,accessToken:`access-${id}`,expiresAt:Date.now()+3600000,addedAt:index+1,lastUsed:1}));
 const normalized=storage.normalizeAccountStorage({version:3,activeIndex:0,accounts});
 expect(normalized?.accounts).toHaveLength(2);
 vi.spyOn(storage,'loadAccounts').mockResolvedValue(normalized);
 return normalized!;
}
it('reports duplicate imported reset identities as unverified instead of borrowing the first credential',async()=>{
 imported();
 expect(await runResetsCommand(['list','--refresh'])).toBe(1);
 expect(native.nativeRateLimitsRpc).not.toHaveBeenCalled();
 expect(console.error).toHaveBeenCalledWith(expect.stringContaining('2 of 2 reset-credit reads failed'));
 expect(vi.mocked(console.log).mock.calls.filter(([line])=>String(line).includes('unknown reset credits'))).toHaveLength(2);
});
it('refuses an ambiguous redemption before invoking the backend',async()=>{
 const data=imported();
 const service=createResetCreditService(new AccountManager(undefined,data));
 await expect(service.redeem(resetTargetForStoredAccount(data.accounts[0]!)!)).rejects.toThrow(/ambiguous/);
 expect(native.nativeRateLimitsRpc).not.toHaveBeenCalled();
 expect((await service.status()).pending).toBeUndefined();
});
it('keeps different records in the same workspace independently readable',async()=>{
 imported(false);
 expect(await runResetsCommand(['list','--refresh'])).toBe(0);
 expect(native.nativeRateLimitsRpc).toHaveBeenCalledTimes(2);
 expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Account 1 (one@example.test): 3 reset credits'));
 expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Account 2 (two@example.test): 7 reset credits'));
});
it('does not attribute a cached snapshot to duplicate identities',async()=>{
 const data=imported();
 const target=resetTargetForStoredAccount(data.accounts[0]!)!;
 const {writeFile}=await import('node:fs/promises');
 await writeFile(join(dir,'reset-credits.json'),JSON.stringify({version:1,policy:'manual',snapshots:{[target.key]:{updatedAt:Date.now(),availableCount:9,ordinaryUsageAllowed:true,planType:'pro',primary:{},secondary:{}}}}));
 expect(await runResetsCommand(['list'])).toBe(0);
 expect(native.nativeRateLimitsRpc).not.toHaveBeenCalled();
 const output=JSON.stringify(vi.mocked(console.log).mock.calls);
 expect(output).not.toContain('9 reset credits');
 expect(output).toContain('ambiguous account identity');
});
it('revalidates identity uniqueness on disk before consuming',async()=>{
 const data=imported();
 const service=createResetCreditService(new AccountManager(undefined,{...data,accounts:[data.accounts[0]!]}));
 await expect(service.redeem(resetTargetForStoredAccount(data.accounts[0]!)!)).rejects.toThrow(/ambiguous/);
 expect(native.nativeRateLimitsRpc).toHaveBeenCalledTimes(1);
 expect(native.nativeRateLimitsRpc).toHaveBeenCalledWith(expect.anything(),'account/rateLimits/read',expect.anything());
});

it('requests reset-credit details needed to compare expiration across accounts',async()=>{
 const data=imported(false);
 const service=createResetCreditService(new AccountManager(undefined,data));
 await service.refresh([resetTargetForStoredAccount(data.accounts[0]!)!]);
 expect(native.nativeRateLimitsRpc).toHaveBeenCalledExactlyOnceWith(expect.anything(),'account/rateLimits/read',{excludeResetCreditDetails:false});
});

it('forwards the earliest-expiring explicit credit ID through the production native adapter',async()=>{
 const data=imported(false);
 const now=Math.floor(Date.now()/1000);
 vi.mocked(native.nativeRateLimitsRpc).mockImplementation(async(auth,method)=>{
  if(method==='account/rateLimitResetCredit/consume')return {outcome:'reset'};
  return {accountId:auth.accountId,ordinaryUsageAllowed:false,rateLimits:{planType:'pro',primary:{usedPercent:100,resetsAt:now+7200}},rateLimitResetCredits:{availableCount:1,credits:[{id:auth.accessToken==='access-one'?'later':'soonest',resetType:'codexRateLimits',status:'available',grantedAt:now-3600,expiresAt:now+(auth.accessToken==='access-one'?3600:300)}]}};
 });
 const service=createResetCreditService(new AccountManager(undefined,data));
 await service.setPolicy('last-resort');
 const targets=data.accounts.map(a=>resetTargetForStoredAccount(a)!);
 expect(await service.automatic(targets)).toEqual({key:targets[1]!.key,outcome:'reset'});
 const calls=vi.mocked(native.nativeRateLimitsRpc).mock.calls.filter(([,method])=>method==='account/rateLimitResetCredit/consume');
 expect(calls).toHaveLength(1);
 expect(calls[0]?.[0].accessToken).toBe('access-two');
 expect(calls[0]?.[2]).toEqual({idempotencyKey:expect.any(String),creditId:'soonest'});
});
