import { beforeEach, expect, it, vi } from 'vitest';
import { recoverResetQuota } from '../lib/runtime/reset-credit-routing.js';
import { AccountManager } from '../lib/accounts.js';
import { workspaceModelScopes } from '../lib/runtime/workspace-model-scopes.js';
import { chooseAccount } from '../lib/runtime/rotation-account-selection.js';
import type { QuotaCacheEntry } from '../lib/quota-cache.js';
beforeEach(()=>AccountManager.resetVolatileRuntimeState());
function fixture(selectedWorkspace=false){
 const manager=new AccountManager(undefined,{version:3,activeIndex:0,accounts:[{recordId:'first',accountId:'workspace',refreshToken:'r',addedAt:1,lastUsed:1,...(selectedWorkspace?{workspaces:[{id:'workspace',enabled:true},{id:'selected-workspace',enabled:true}],currentWorkspaceIndex:1}:{})}]});
 // Recovery schedules a debounced save; never let it write the shared test store after the test.
 const save=vi.spyOn(manager,'saveToDiskDebounced').mockImplementation(()=>{});
 const account=manager.getAccountByIndex(0)!;const scope=workspaceModelScopes(account).find(candidate=>candidate.routable)!;
 const automatic=vi.fn(async()=>null);const status=vi.fn(async()=>({snapshots:{[scope.id]:{updatedAt:1000,ordinaryUsageAllowed:true,availableCount:1,planType:'pro',primary:{usedPercent:0},secondary:{usedPercent:0}}}}));
 const service={automatic,status};const observations=new Map();const clear=vi.fn();
 return {manager,account,scope,service,observations,clear,save,args:{model:'chat-test',native:true,pinned:false,manager,scopes:new Map([[0,[scope]]]),quotaForScope:()=>({updatedAt:900,status:200,model:'chat-test',planType:'pro',primary:{usedPercent:100},secondary:{}}),service,observations,clearQuotaScheduler:clear,now:()=>1000}};
}

it('automatic recovery makes the selected workspace eligible when it differs from the stored binding',async()=>{
 const f=fixture(true);const until=Date.now()+90000;
 f.account.lastRateLimitReason='quota';
 f.account.rateLimitResetTimes={codex:until,'codex:chat-test':until,'codex:other-model':until};
 f.account.cooldownReason='rate-limit';f.account.coolingDownUntil=until;
 const choose=()=>chooseAccount({accountManager:f.manager,sessionAffinityStore:null,sessionKey:null,family:'codex',model:'chat-test',attemptedIndexes:new Set(),now:Date.now(),policy:null,pinnedIndex:null});
 expect(f.scope.bound).toBe(false);expect(f.scope.selected).toBe(true);
 expect(choose()).toBeNull();
 expect(await recoverResetQuota(f.args)).toBe(true);
 expect(choose()?.index).toBe(f.account.index);
 expect(f.account.rateLimitResetTimes).toEqual({'codex:other-model':until});
 expect(f.account.coolingDownUntil).toBeUndefined();
 expect(f.clear).toHaveBeenCalledWith(f.account);expect(f.save).toHaveBeenCalled();
});

it('automatic recovery cannot clear a stale bound workspace after selection changes',async()=>{
 const f=fixture();const until=Date.now()+90000;
 f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:until};
 f.account.workspaces=[{id:'workspace',enabled:true},{id:'selected-workspace',enabled:true}];
 f.account.currentWorkspaceIndex=1;
 await recoverResetQuota(f.args);
 expect(f.account.rateLimitResetTimes).toEqual({codex:until});expect(f.clear).not.toHaveBeenCalled();
});

it('automatic recovery cannot clear blockers for a disabled selected workspace',async()=>{
 const f=fixture();const until=Date.now()+90000;
 f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:until};
 f.account.workspaces=[{id:'workspace',enabled:false}];f.account.currentWorkspaceIndex=0;
 await recoverResetQuota(f.args);
 expect(f.account.rateLimitResetTimes).toEqual({codex:until});expect(f.clear).not.toHaveBeenCalled();
});
it.each(['api/chat-test','zdr/chat-test'])('never redeems across the %s privacy pool',async model=>{const f=fixture();await recoverResetQuota({...f.args,model});expect(f.service.automatic).not.toHaveBeenCalled();});
it.each([5,50,94,99])('uses remaining subscription quota at %s%% used without spending a reset',async used=>{const f=fixture();await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),primary:{usedPercent:used}})});expect(f.service.automatic).not.toHaveBeenCalled();});
it('does not redeem for an explicit pin or non-native route',async()=>{const f=fixture();await recoverResetQuota({...f.args,pinned:true});await recoverResetQuota({...f.args,native:false});expect(f.service.automatic).not.toHaveBeenCalled();});
it('never spends or applies ordinary reset credits to Luna Reserve',async()=>{
 const f=fixture();const now=Date.now();
 f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:now+120000,'codex:gpt-reserve':now+30000};
 expect(await recoverResetQuota({...f.args,model:'gpt-reserve'})).toBe(false);
 expect(f.service.automatic).not.toHaveBeenCalled();expect(f.service.status).not.toHaveBeenCalled();
 expect(f.account.rateLimitResetTimes).toEqual({codex:now+120000,'codex:gpt-reserve':now+30000});expect(f.clear).not.toHaveBeenCalled();
});
it('applies confirmed scheduled recovery even when no credit was consumed',async()=>{const f=fixture();f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:Date.now()+90000};expect(await recoverResetQuota(f.args)).toBe(true);expect(f.save).toHaveBeenCalled();expect(f.clear).toHaveBeenCalledWith(f.account);expect(f.account.rateLimitResetTimes).toEqual({});expect(f.observations.size).toBe(1);});
it('does not erase authentication cooldowns or policy-blocked candidates',async()=>{const f=fixture();f.account.cooldownReason='auth-failure';f.account.coolingDownUntil=Date.now()+100000;await recoverResetQuota(f.args);expect(f.service.automatic).not.toHaveBeenCalled();expect(f.account.cooldownReason).toBe('auth-failure');});
it('requires positive native permission before clearing blockers',async()=>{const f=fixture();const until=Date.now()+90000;f.service.status.mockResolvedValue({snapshots:{}});f.account.rateLimitResetTimes={codex:until};expect(await recoverResetQuota(f.args)).toBe(false);expect(f.account.rateLimitResetTimes).toEqual({codex:until});});

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
 expect(f.service.automatic).toHaveBeenCalledExactlyOnceWith([{key:f.scope.id,accountId:f.scope.accountId}],[{key:f.scope.id,accountId:f.scope.accountId,observedAt:900}]);
});

it("keys a workspace scope and its reset target the same way when no recordId is stored",async()=>{
 const {resetTargetForStoredAccount,isResetTargetEnabled}=await import('../lib/runtime/account-reset-credits.js');
 const row={accountId:' workspace ',email:'user@example.com',refreshToken:'refresh-fixture',addedAt:5,lastUsed:5};
 const scope=workspaceModelScopes({...row,index:0,access:undefined} as unknown as Parameters<typeof workspaceModelScopes>[0])[0]!;
 const target=resetTargetForStoredAccount(row);
 expect(target).toEqual({key:scope.id,accountId:'workspace'});
 expect(isResetTargetEnabled(row,{key:scope.id,accountId:scope.accountId})).toBe(true);
});


it('opens emergency accounts only after every primary workspace has no ordinary usage or reset credits',async()=>{
 const {primaryPoolFullyExhausted}=await import('../lib/runtime/reset-credit-routing.js');
 const f=fixture();const snapshot={updatedAt:1000,ordinaryUsageAllowed:false,availableCount:0,planType:'promax',primary:{usedPercent:100},secondary:{}};
 const scopes=new Map([[0,[f.scope]]]);
 expect(primaryPoolFullyExhausted(scopes,{snapshots:{[f.scope.id]:snapshot}},1000)).toBe(true);
 for(const patch of [{ordinaryUsageAllowed:true},{ordinaryUsageAllowed:null},{availableCount:1},{availableCount:null},{updatedAt:1001},{updatedAt:-60000},{planType:'unknown'}]){
  expect(primaryPoolFullyExhausted(scopes,{snapshots:{[f.scope.id]:{...snapshot,...patch}}},1000)).toBe(false);
 }
 expect(primaryPoolFullyExhausted(scopes,{snapshots:{}},1000)).toBe(false);
 expect(primaryPoolFullyExhausted(scopes,{snapshots:{[f.scope.id]:snapshot},pending:{key:'pending'}},1000)).toBe(false);
 expect(primaryPoolFullyExhausted(new Map(),{snapshots:{}},1000)).toBe(false);
 expect(primaryPoolFullyExhausted(new Map([[0,[f.scope,{...f.scope,id:'sibling'}]]]),{snapshots:{[f.scope.id]:snapshot}},1000)).toBe(false);
});

it('keeps backups reserved when a newer quota observation restores primary capacity',async()=>{
 const {primaryPoolFullyExhausted}=await import('../lib/runtime/reset-credit-routing.js');
 const f=fixture();const snapshot={updatedAt:1000,ordinaryUsageAllowed:false,availableCount:0,planType:'promax',primary:{usedPercent:100},secondary:{}};
 const state={snapshots:{[f.scope.id]:snapshot}};
 const scopes=new Map([[0,[f.scope]]]);
 expect(primaryPoolFullyExhausted(scopes,state,1100,()=>({updatedAt:1050,status:200,model:"fixture",primary:{usedPercent:10},secondary:{}}))).toBe(false);
 expect(primaryPoolFullyExhausted(scopes,state,1100,()=>({updatedAt:1050,status:429,model:"fixture",primary:{usedPercent:100},secondary:{}}))).toBe(true);
});


it('passes newer exhausted quota evidence for the selected reset target',async()=>{
 const f=fixture(true);
 await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),status:400,updatedAt:999})});
 expect(f.service.automatic).toHaveBeenCalledExactlyOnceWith(
  [{key:f.scope.id,accountId:f.scope.accountId}],
  [{key:f.scope.id,accountId:f.scope.accountId,observedAt:999}],
 );
});


it('uses body-only rejection evidence to reread a previously healthy selected scope',async()=>{
 const f=fixture(true);
 const proof={key:f.scope.id,accountId:f.scope.accountId,observedAt:999};
 const quotaRejections=new Map([[JSON.stringify([f.scope.id,f.args.model]),proof]]);
 await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),primary:{usedPercent:20},ordinaryUsageAllowed:true}),quotaRejections});
 expect(f.service.automatic).toHaveBeenCalledExactlyOnceWith([{key:f.scope.id,accountId:f.scope.accountId}],[proof]);
});

it.each(['wrong-model','wrong-account','wrong-scope','future','stale','same-time','newer-healthy','disabled','changed'] as const)('does not turn %s rejection evidence into reset admission',async reason=>{
 const f=fixture();
 const proof={key:f.scope.id,accountId:f.scope.accountId,observedAt:999};
 let model=f.args.model,scopeId=f.scope.id,quotaAt=900;
 if(reason==='wrong-model')model='other-model';
 if(reason==='wrong-account')proof.accountId='other-account';
 if(reason==='wrong-scope')scopeId='other-scope';
 if(reason==='future')proof.observedAt=1001;
 if(reason==='stale')proof.observedAt=-60000;
 if(reason==='same-time')proof.observedAt=900;
 if(reason==='newer-healthy')quotaAt=1000;
 if(reason==='disabled')f.account.enabled=false;
 if(reason==='changed'){f.account.workspaces=[{id:'workspace',enabled:true},{id:'other',enabled:true}];f.account.currentWorkspaceIndex=1;}
 const quotaRejections=new Map([[JSON.stringify([scopeId,model]),proof]]);
 await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),updatedAt:quotaAt,primary:{usedPercent:20},ordinaryUsageAllowed:true}),quotaRejections});
 expect(f.service.automatic).not.toHaveBeenCalled();
});

it('does not apply a native permission snapshot older than body-only quota rejection',async()=>{
 const f=fixture();
 f.account.lastRateLimitReason='quota';f.account.rateLimitResetTimes={codex:Date.now()+60000};
 const quotaRejections=new Map([[JSON.stringify([f.scope.id,f.args.model]),{key:f.scope.id,accountId:f.scope.accountId,observedAt:1000}]]);
 f.service.status.mockResolvedValue({snapshots:{[f.scope.id]:{updatedAt:999,ordinaryUsageAllowed:true,availableCount:1,planType:'pro',primary:{usedPercent:0},secondary:{usedPercent:0}}}});
 expect(await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),primary:{usedPercent:20},ordinaryUsageAllowed:true}),quotaRejections})).toBe(false);
 expect(f.clear).not.toHaveBeenCalled();
});

it.each([true,false])('does not let later headers hide a quota rejection (carried native permission: %s)',async carried=>{
 const f=fixture();
 const proof={key:f.scope.id,accountId:f.scope.accountId,observedAt:999};
 const quotaRejections=new Map([[JSON.stringify([f.scope.id,f.args.model]),proof]]);
 await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),updatedAt:1000,...(carried?{ordinaryUsageAllowed:true,ordinaryUsageCheckedAt:900}:{}),primary:{usedPercent:20}}),quotaRejections});
 expect(f.service.automatic).toHaveBeenCalledExactlyOnceWith([{key:f.scope.id,accountId:f.scope.accountId}],[proof]);
});

it('uses newer authoritative exhaustion instead of an older body rejection',async()=>{
 const f=fixture();
 const proof={key:f.scope.id,accountId:f.scope.accountId,observedAt:999};
 const quotaRejections=new Map([[JSON.stringify([f.scope.id,f.args.model]),proof]]);
 await recoverResetQuota({...f.args,quotaForScope:()=>({...f.args.quotaForScope(),updatedAt:1000,ordinaryUsageAllowed:false}),quotaRejections});
 expect(f.service.automatic).toHaveBeenCalledExactlyOnceWith([{key:f.scope.id,accountId:f.scope.accountId}],[{...proof,observedAt:1000}]);
});

it.each([true,false])('applies a fresh native permission when older healthy headers arrive after its check (carried native permission: %s)',async carried=>{
 const f=fixture();
 let latest:QuotaCacheEntry={...f.args.quotaForScope(),primary:{usedPercent:20},ordinaryUsageAllowed:true};
 const quotaRejections=new Map([[JSON.stringify([f.scope.id,f.args.model]),{key:f.scope.id,accountId:f.scope.accountId,observedAt:950}]]);
 f.service.status.mockImplementation(async()=>{
  // Native permission was checked at 975, then an earlier request's headers arrived.
  latest={...f.args.quotaForScope(),updatedAt:1000,primary:{usedPercent:20},...(carried?{ordinaryUsageAllowed:true,ordinaryUsageCheckedAt:900}:{})};
  return {snapshots:{[f.scope.id]:{updatedAt:975,ordinaryUsageAllowed:true,availableCount:1,planType:'pro',primary:{usedPercent:0},secondary:{usedPercent:0}}}};
 });
 expect(await recoverResetQuota({...f.args,quotaForScope:()=>latest,quotaRejections})).toBe(true);
 expect(f.observations.get(JSON.stringify([f.scope.id,f.args.model]))).toMatchObject({updatedAt:975,ordinaryUsageAllowed:true});
});

it.each(['exhaustion','failure','unknown','native-denial','native-permission','body-rejection'] as const)('does not apply an older native permission over newer %s evidence',async reason=>{
 const f=fixture();
 let latest:QuotaCacheEntry={...f.args.quotaForScope(),primary:{usedPercent:20},ordinaryUsageAllowed:true};
 const proof={key:f.scope.id,accountId:f.scope.accountId,observedAt:950};
 const quotaRejections=new Map([[JSON.stringify([f.scope.id,f.args.model]),proof]]);
 f.service.status.mockImplementation(async()=>{
  latest={...f.args.quotaForScope(),updatedAt:1000,primary:{usedPercent:reason==='exhaustion'?100:20}};
  if(reason==='failure')latest.status=429;
  if(reason==='unknown')latest.primary={};
  if(reason==='native-denial')latest.ordinaryUsageAllowed=false;
  if(reason==='native-permission')latest.ordinaryUsageAllowed=true;
  if(reason==='body-rejection')proof.observedAt=1000;
  return {snapshots:{[f.scope.id]:{updatedAt:975,ordinaryUsageAllowed:true,availableCount:1,planType:'pro',primary:{usedPercent:0},secondary:{usedPercent:0}}}};
 });
 expect(await recoverResetQuota({...f.args,quotaForScope:()=>latest,quotaRejections})).toBe(false);
 expect(f.observations.size).toBe(0);
});
