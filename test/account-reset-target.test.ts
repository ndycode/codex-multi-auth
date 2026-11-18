import { expect,it } from 'vitest';
import { resetTargetForStoredAccount, resetAccountLabel, sanitizeCreditTitle, formatResetCreditLine } from '../lib/runtime/account-reset-credits.js';

it('sanitizes credit titles and rejects control or newline characters', () => {
 expect(sanitizeCreditTitle('Full reset')).toBe('Full reset');
 expect(sanitizeCreditTitle('  Full reset  ')).toBe('Full reset');
 expect(sanitizeCreditTitle('Full reset\nline 2')).toBeNull();
 expect(sanitizeCreditTitle('Full reset\r\nline 2')).toBeNull();
 expect(sanitizeCreditTitle('Full reset\u202E')).toBeNull();
 expect(sanitizeCreditTitle('')).toBeNull();
 expect(sanitizeCreditTitle('   ')).toBeNull();
 expect(sanitizeCreditTitle(null)).toBeNull();
 expect(sanitizeCreditTitle(undefined)).toBeNull();
});
it('labels non-expiring credits separately from unknown or out-of-range expiry',()=>{
 expect(formatResetCreditLine({expiresAt:null,title:'Bonus'},0)).toBe('   - credit #1: no expiry (Bonus)');
 for(const expiresAt of [undefined,0,-5,1e300])expect(formatResetCreditLine({expiresAt},1)).toBe('   - credit #2: expires unknown');
});
it('check resets requests credit details and prints each expiry and title without persisting credit ids',async()=>{
 const {vi}=await import('vitest');
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {refreshAndPrintResetCredits}=await import('../lib/runtime/account-reset-credits.js');
 const native=await import('../lib/runtime/native-rate-limits.js');const stored=await import('../lib/storage.js');
 const dir=await mkdtemp(join(tmpdir(),'reset-print-'));const previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=dir;
 const row={recordId:'r',accountId:'workspace',email:'reader@example.test',refreshToken:'refresh-fixture',accessToken:'access-fixture',expiresAt:Date.now()+3600000,addedAt:1,lastUsed:1};
 const load=vi.spyOn(stored,'loadAccounts').mockResolvedValue({version:3,activeIndex:0,accounts:[row]});
 const rpc=vi.spyOn(native,'nativeRateLimitsRpc').mockImplementation(async auth=>({accountId:auth.accountId,rateLimitResetCredits:{availableCount:2,credits:[{id:'credit-id-fixture',grantedAt:1,expiresAt:1793300484,title:'Weekly reset',backendExtra:'x'},{id:'credit-id-2',expiresAt:null}]},rateLimits:{planType:'pro'}}));
 const toLocale=vi.spyOn(Date.prototype,'toLocaleString').mockImplementation(function(this:Date){return `local:${this.getTime()}`;});
 try{
  const lines:string[]=[];
  await refreshAndPrintResetCredits(message=>lines.push(message));
  expect(rpc).toHaveBeenCalledWith(expect.anything(),'account/rateLimits/read',{excludeResetCreditDetails:false});
  expect(lines).toEqual(expect.arrayContaining(['Account 1 (reader@example.test): available subscription resets: 2','   - credit #1: expires local:1793300484000 (Weekly reset)','   - credit #2: no expiry']));
  const persisted=await readFile(join(dir,'reset-credits.json'),'utf8');
  expect(persisted).not.toMatch(/credit-id|backendExtra|grantedAt/);
  expect(Object.values(JSON.parse(persisted).snapshots)).toEqual([expect.objectContaining({credits:[{expiresAt:1793300484,title:'Weekly reset'},{expiresAt:null}]})]);
 }finally{toLocale.mockRestore();rpc.mockRestore();load.mockRestore();if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;await rm(dir,{recursive:true,force:true,maxRetries:5});}
});
it('does not reset a sibling when the selected organization alias is not a native reset target',()=>{
 const account={recordId:'r',accountId:'native-workspace',refreshToken:'secret',addedAt:1,lastUsed:1,workspaces:[{id:'native-workspace',name:'Token account'},{id:'org-personal',name:'Personal'}],currentWorkspaceIndex:1};
 expect(resetTargetForStoredAccount(account)).toBeNull();expect(account.currentWorkspaceIndex).toBe(1);
});
it('does not redeem a disabled native workspace or an organization ID',()=>{
 const account={accountId:'native-workspace',refreshToken:'secret',addedAt:1,lastUsed:1,workspaces:[{id:'native-workspace',enabled:false}]};expect(resetTargetForStoredAccount(account)).toBeNull();expect(resetTargetForStoredAccount({...account,accountId:'org-fixture'})).toBeNull();
});
it('resolves selected Personal to its native identity without changing preferences',()=>{
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
  expect(rpc).toHaveBeenCalledWith(expect.anything(),'account/rateLimits/read',{excludeResetCreditDetails:false});
  expect(snapshots[target.key]?.availableCount).toBe(expected);
  // The reset state stays keyed on the stored target, not the mirror id.
  expect(Object.keys((await service.status()).snapshots)).toEqual(expected===undefined?[]:[target.key]);
 }finally{rpc.mockRestore();if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;await rm(dir,{recursive:true,force:true,maxRetries:5});}
});

it('targets only the selected enabled native workspace for resets',async()=>{
 const {isResetTargetEnabled}=await import('../lib/runtime/account-reset-credits.js');
 const row={recordId:'selected',accountId:'bound',refreshToken:'fixture',addedAt:1,lastUsed:1,currentWorkspaceIndex:1,workspaces:[{id:'bound',enabled:true},{id:'chosen',enabled:true}]};
 const target=resetTargetForStoredAccount(row)!;
 expect(target.accountId).toBe('chosen');
 expect(isResetTargetEnabled({...row,currentWorkspaceIndex:0},target)).toBe(false);
 expect(resetTargetForStoredAccount({...row,workspaces:[{id:'bound',enabled:true},{id:'chosen',enabled:false}]})).toBeNull();
});
