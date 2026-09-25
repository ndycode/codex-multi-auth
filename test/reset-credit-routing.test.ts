import { expect, it, vi } from 'vitest';
import { recoverResetQuota } from '../lib/runtime/reset-credit-routing.js';
import { AccountManager } from '../lib/accounts.js';
import { workspaceModelScopes } from '../lib/runtime/workspace-model-scopes.js';
function fixture(){
 const manager=new AccountManager(undefined,{version:3,activeIndex:0,accounts:[{recordId:'first',accountId:'workspace',refreshToken:'r',addedAt:1,lastUsed:1}]});
 // Recovery schedules a debounced save; never let it write the shared test store after the test.
 const save=vi.spyOn(manager,'saveToDiskDebounced').mockImplementation(()=>{});
 const account=manager.getAccountByIndex(0)!;const scope=workspaceModelScopes(account)[0]!;
 const automatic=vi.fn(async()=>null);const status=vi.fn(async()=>({snapshots:{[scope.id]:{updatedAt:1000,ordinaryUsageAllowed:true,availableCount:1,planType:'pro',primary:{usedPercent:0},secondary:{usedPercent:0}}}}));
 const service={automatic,status};const observations=new Map();const clear=vi.fn();
 return {manager,account,scope,service,observations,clear,save,args:{model:'chat-test',native:true,pinned:false,manager,scopes:new Map([[0,[scope]]]),quotaForScope:()=>({updatedAt:900,status:200,model:'chat-test',planType:'pro',primary:{usedPercent:100},secondary:{}}),service,observations,clearQuotaScheduler:clear,now:()=>1000}};
}
it.each(['api/chat-test','zdr/chat-test'])('never redeems across the %s privacy pool',async model=>{const f=fixture();await recoverResetQuota({...f.args,model});expect(f.service.automatic).not.toHaveBeenCalled();});
it.each([5,50,94,99])('uses remaining subscription quota at %s%% used without spending a reset',async used=>{const f=fixture();await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),primary:{usedPercent:used}})});expect(f.service.automatic).not.toHaveBeenCalled();});
it('does not redeem for an explicit pin or non-native route',async()=>{const f=fixture();await recoverResetQuota({...f.args,pinned:true});await recoverResetQuota({...f.args,native:false});expect(f.service.automatic).not.toHaveBeenCalled();});
it('applies confirmed scheduled recovery even when no credit was consumed',async()=>{const f=fixture();f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:Date.now()+90000};expect(await recoverResetQuota(f.args)).toBe(true);expect(f.save).toHaveBeenCalled();expect(f.clear).toHaveBeenCalledWith(f.account);expect(f.account.rateLimitResetTimes).toEqual({});expect(f.observations.size).toBe(1);});
it('does not erase authentication cooldowns or policy-blocked candidates',async()=>{const f=fixture();f.account.cooldownReason='auth-failure';f.account.coolingDownUntil=Date.now()+100000;await recoverResetQuota(f.args);expect(f.service.automatic).not.toHaveBeenCalled();expect(f.account.cooldownReason).toBe('auth-failure');});
it('requires positive native permission before clearing blockers',async()=>{const f=fixture();const until=Date.now()+90000;f.service.status.mockResolvedValue({snapshots:{}});f.account.rateLimitResetTimes={codex:until};expect(await recoverResetQuota(f.args)).toBe(false);expect(f.account.rateLimitResetTimes).toEqual({codex:until});});

it('applies a manual redemption once, without erasing a later failure',async()=>{
 const {applyConfirmedReset}=await import('../lib/runtime/reset-credit-routing.js');const f=fixture();const now=Date.now();
 f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:now+90000};
 const snapshot={updatedAt:now,ordinaryUsageAllowed:true,availableCount:1,planType:'pro',primary:{usedPercent:0},secondary:{usedPercent:0}};
 const apply=()=>applyConfirmedReset({account:f.account,scope:f.scope,model:'chat-test',family:'codex',manager:f.manager,snapshot,lastRedemptionAt:now-1000,previous:f.observations.get(JSON.stringify([f.scope.id,'chat-test'])),observations:f.observations,clearQuotaScheduler:f.clear,now});
 expect(apply()).toBe(true);expect(f.account.rateLimitResetTimes).toEqual({});
 f.account.rateLimitResetTimes={codex:now+90000};expect(apply()).toBe(false);expect(f.account.rateLimitResetTimes.codex).toBe(now+90000);
});

it('checks capacity in every eligible scope before excluding unsupported redemption targets',async()=>{
 const f=fixture();const second={...f.scope,id:'other-scope',accountId:'org-fixture',bound:false};
 await recoverResetQuota({...f.args,scopes:new Map([[0,[f.scope,second]]]),quotaForScope:(_account,scope)=>({...f.args.quotaForScope(),primary:{usedPercent:scope.id===second.id?50:100}})});
 expect(f.service.automatic).not.toHaveBeenCalled();
});

it("excludes invalidated credentials from last-resort capacity gating",async()=>{
 const f=fixture();
 const manager=new AccountManager(undefined,{version:3,activeIndex:0,accounts:[
  {recordId:"first",accountId:"workspace",refreshToken:"r",addedAt:1,lastUsed:1},
  {recordId:"invalid",accountId:"invalid",refreshToken:"bad",addedAt:1,lastUsed:1,authInvalidatedAt:1},
 ]});
 vi.spyOn(manager,"saveToDiskDebounced").mockImplementation(()=>{});
 const invalidScope=workspaceModelScopes(manager.getAccountByIndex(1)!)[0]!;
 expect(await recoverResetQuota({...f.args,manager,scopes:new Map([[0,[f.scope]],[1,[invalidScope]]])})).toBe(true);
 expect(f.service.automatic).toHaveBeenCalledExactlyOnceWith([{key:f.scope.id,accountId:f.scope.accountId}]);
});

it("keys a workspace scope and its reset target the same way when no recordId is stored",async()=>{
 const {resetTargetForStoredAccount,isResetTargetEnabled}=await import('../lib/runtime/account-reset-credits.js');
 const row={accountId:' workspace ',email:'user@example.com',refreshToken:'refresh-fixture',addedAt:5,lastUsed:5};
 const scope=workspaceModelScopes({...row,index:0,access:undefined} as unknown as Parameters<typeof workspaceModelScopes>[0])[0]!;
 const target=resetTargetForStoredAccount(row);
 expect(target).toEqual({key:scope.id,accountId:'workspace'});
 expect(isResetTargetEnabled(row,{key:scope.id,accountId:scope.accountId})).toBe(true);
});
