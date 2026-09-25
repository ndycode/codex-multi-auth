import { extractAccountId, type AccountManager, type ManagedAccount } from '../accounts.js';
import type { ModelFamily } from '../prompts/codex.js';
import type { QuotaCacheEntry } from '../quota-cache.js';
import { parseModelRoute } from '../model-route-policy.js';
import { subscriptionQuotaPreference } from './subscription-quota-order.js';
import { resetSnapshotQuota, type ResetCreditService } from './reset-credits.js';
import type { workspaceModelScopes } from './workspace-model-scopes.js';
type Scope=ReturnType<typeof workspaceModelScopes>[number];
export async function recoverResetQuota(options:{
 model:string;family?:ModelFamily;native:boolean;pinned:boolean;manager:AccountManager;
 scopes:Map<number,Scope[]>;priorityByAccount?:Record<number,number>;preferredIndex?:number|null;quotaForScope:(account:ManagedAccount,scope:Scope)=>QuotaCacheEntry|null|undefined;
 service:Pick<ResetCreditService,'automatic'> & {status:()=>Promise<{snapshots:Awaited<ReturnType<ResetCreditService['status']>>['snapshots']}>};
 observations:Map<string,QuotaCacheEntry>;clearQuotaScheduler:(account:ManagedAccount)=>void;now:()=>number;
}):Promise<boolean>{
 if(!options.native||options.pinned||parseModelRoute(options.model).kind!=='oauth')return false;
 const family=options.family??'codex';
 const candidates=[...options.scopes].flatMap(([index,scopes])=>{const account=options.manager.getAccountByIndex(index);return account&&!account.authInvalidatedAt?scopes.map(scope=>({account,scope})):[];});
 if(!candidates.length)return false;
 // Any usable capacity (including the reserve), unknown quota, or non-quota
 // failure prevents an automatic credit from being spent.
 if(candidates.some(({account,scope})=>{
  if(account.enabled===false||account.authInvalidatedAt||!scope.routable)return true;
  const skip=options.manager.getAccountRuntimeSkipReason(account.index,family,options.model);
  if(skip&&!['rate-limited','cooling-down:rate-limit'].includes(skip))return true;
  const quota=subscriptionQuotaPreference(options.quotaForScope(account,scope),options.now());
  return !quota.exhausted&&!['rate-limited','cooling-down:rate-limit'].includes(skip??'');
 }))return false;
 candidates.sort((a,b)=>Number(b.account.index===options.preferredIndex)-Number(a.account.index===options.preferredIndex)||(options.priorityByAccount?.[a.account.index]??1)-(options.priorityByAccount?.[b.account.index]??1));
 const targets=candidates.filter(({scope})=>!scope.accountId.startsWith("org-")).map(({scope})=>({key:scope.id,accountId:scope.accountId}));
 await options.service.automatic(targets);
 const state=await options.service.status();let recovered=false;
 for(const {account,scope} of candidates){
  const snapshot=state.snapshots[scope.id];const previous=options.quotaForScope(account,scope);
  if(!snapshot||snapshot.updatedAt<(previous?.updatedAt??0)||options.now()-snapshot.updatedAt>60000||snapshot.updatedAt>options.now())continue;
  options.observations.set(JSON.stringify([scope.id,options.model]),resetSnapshotQuota(snapshot));
  if(snapshot.ordinaryUsageAllowed!==true)continue;
  // Do not clear sibling workspace/model throttles or authentication failures.
  if((scope.bound || (account.accountId?.startsWith('org-')&&scope.accountId===extractAccountId(account.access)))&&account.lastRateLimitReason==='quota'){
   delete account.rateLimitResetTimes[family];delete account.rateLimitResetTimes[`${family}:${options.model}`];
   if(account.cooldownReason==='rate-limit')options.manager.clearAccountCooldown(account);
   options.clearQuotaScheduler(account);
  }
  recovered=true;
 }
 if(recovered)options.manager.saveToDiskDebounced();
 return recovered;
}

/** Apply a confirmed earned reset once per workspace/model observation. */
export function applyConfirmedReset(options:{account:ManagedAccount;scope:Scope;model:string;family:ModelFamily;manager:AccountManager;snapshot:Awaited<ReturnType<ResetCreditService['status']>>['snapshots'][string]|undefined;lastRedemptionAt:number|undefined;previous:QuotaCacheEntry|null|undefined;observations:Map<string,QuotaCacheEntry>;clearQuotaScheduler:(account:ManagedAccount)=>void;now:number}):boolean{
 const s=options.snapshot;
 if(!s||options.lastRedemptionAt===undefined||s.updatedAt<options.lastRedemptionAt||s.ordinaryUsageAllowed!==true||s.updatedAt<=(options.previous?.updatedAt??0)||options.now-s.updatedAt>60000||s.updatedAt>options.now)return false;
 options.observations.set(JSON.stringify([options.scope.id,options.model]),resetSnapshotQuota(s));
 if((options.scope.bound || (options.account.accountId?.startsWith('org-')&&options.scope.accountId===extractAccountId(options.account.access)))&&options.account.lastRateLimitReason==='quota'){
  delete options.account.rateLimitResetTimes[options.family];delete options.account.rateLimitResetTimes[`${options.family}:${options.model}`];
  if(options.account.cooldownReason==='rate-limit')options.manager.clearAccountCooldown(options.account);
  options.clearQuotaScheduler(options.account);
  options.manager.saveToDiskDebounced();
 }
 return true;
}
