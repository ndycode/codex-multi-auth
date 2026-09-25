import { expect,it } from 'vitest';
import { resetTargetForStoredAccount, resetAccountLabel } from '../lib/runtime/account-reset-credits.js';
it('uses the native credential binding, not an organization display alias',()=>{
 const account={recordId:'r',accountId:'native-workspace',refreshToken:'secret',addedAt:1,lastUsed:1,workspaces:[{id:'native-workspace',name:'Token account'},{id:'org-personal',name:'Personal'}],currentWorkspaceIndex:1};
 expect(resetTargetForStoredAccount(account)?.accountId).toBe('native-workspace');expect(account.currentWorkspaceIndex).toBe(1);
});
it('does not redeem a disabled native workspace or an organization ID',()=>{
 const account={accountId:'native-workspace',refreshToken:'secret',addedAt:1,lastUsed:1,workspaces:[{id:'native-workspace',enabled:false}]};expect(resetTargetForStoredAccount(account)).toBeNull();expect(resetTargetForStoredAccount({...account,accountId:'org-fixture'})).toBeNull();
});
it('resolves an organization-only binding from the native token claim without changing preferences',()=>{
 const token='header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'native-workspace'}})).toString('base64url')+'.signature';
 const account={recordId:'r',accountId:'org-personal',accessToken:token,refreshToken:'secret',addedAt:1,lastUsed:1,currentWorkspaceIndex:1,workspaces:[{id:'native-workspace'},{id:'org-personal',name:'Personal'}]};
 expect(resetTargetForStoredAccount(account)?.accountId).toBe('native-workspace');expect(account.accountId).toBe('org-personal');expect(account.currentWorkspaceIndex).toBe(1);
});
it('revalidates the current native target against persisted enablement',async()=>{
 const {isResetTargetEnabled}=await import('../lib/runtime/account-reset-credits.js');
 const account={recordId:'r',accountId:'native',refreshToken:'secret',addedAt:1,lastUsed:1};const target=resetTargetForStoredAccount(account)!;
 expect(isResetTargetEnabled(account,target)).toBe(true);expect(isResetTargetEnabled({...account,enabled:false},target)).toBe(false);expect(isResetTargetEnabled({...account,accountId:'other'},target)).toBe(false);
});

it('labels local reset output with email and safely handles absent or control-bearing values', () => {
 expect(resetAccountLabel({email:'Reader@example.test'},0)).toBe('Account 1 (reader@example.test)');
 expect(resetAccountLabel({},1)).toBe('Account 2');
 expect(resetAccountLabel({email:'reader@example.test\nforged line'},2)).toBe('Account 3');
});

it.each(['\u202E','\u200B','\u2028','\u2029'])('omits invisible and bidi email formatting %j', character => {
 expect(resetAccountLabel({email:`reader${character}@example.test`},0)).toBe('Account 1');
});

it.each([
 ['native-default',2],
 ['someone-else',undefined],
])('verifies a mirrored account read against the id actually sent (backend echoes %s)',async(echo,expected)=>{
 const {vi}=await import('vitest');
 const {mkdtemp,rm,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createResetCreditService}=await import('../lib/runtime/account-reset-credits.js');
 const {AccountManager}=await import('../lib/accounts.js');
 const native=await import('../lib/runtime/native-rate-limits.js');
 const dir=await mkdtemp(join(tmpdir(),'reset-mirror-'));const previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=dir;
 // A fake native backend that answers with the workspace id written into its auth.json.
 const script=join(dir,'server.mjs');
 await writeFile(script,`import {createInterface} from 'node:readline';import {readFileSync} from 'node:fs';const sent=JSON.parse(readFileSync(process.env.CODEX_HOME+'/auth.json')).tokens.account_id;const id=${JSON.stringify(echo)}==='native-default'?sent:${JSON.stringify(echo)};createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{}}));return;}console.log(JSON.stringify({id:m.id,result:{accountId:id,ordinaryUsageAllowed:false,rateLimitResetCredits:{availableCount:2},rateLimits:{planType:'pro',primary:{usedPercent:100},secondary:{usedPercent:0}}}}));});`);
 const real=native.nativeRateLimitsRpc;
 const rpc=vi.spyOn(native,'nativeRateLimitsRpc').mockImplementation((auth,method,params)=>real(auth,method,params,{command:[process.execPath,script],tempRoot:dir}));
 try{
  const row={recordId:'r',accountId:'refused-explicit',codexCliMirror:{forAccountId:'refused-explicit',accountId:'native-default'},refreshToken:'refresh-fixture',accessToken:'access-fixture',expiresAt:Date.now()+3600000,addedAt:1,lastUsed:1};
  const manager=new AccountManager(undefined,{version:3,activeIndex:0,accounts:[row]});
  const target=resetTargetForStoredAccount(row)!;
  expect(target.accountId).toBe('refused-explicit');
  const service=createResetCreditService(manager);
  const snapshots=await service.refresh([target]);
  expect(rpc).toHaveBeenCalled();
  expect(snapshots[target.key]?.availableCount).toBe(expected);
  // The reset state stays keyed on the stored target, not the mirror id.
  expect(Object.keys((await service.status()).snapshots)).toEqual(expected===undefined?[]:[target.key]);
 }finally{rpc.mockRestore();if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;await rm(dir,{recursive:true,force:true,maxRetries:5});}
});
