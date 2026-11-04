import { selectedQuotaWorkspace, workspaceQuotaKey } from "../accounts/rate-limits.js";
import type { AccountManager, ManagedAccount } from '../accounts.js';
import { LUNA_RESERVE_MODEL } from '../constants.js';
import type { ModelFamily } from '../prompts/codex.js';
import type { QuotaCacheEntry } from '../quota-cache.js';
import { parseModelRoute } from '../model-route-policy.js';
import { subscriptionQuotaPreference } from './subscription-quota-order.js';
import { resetSnapshotQuota, isResetSubscription, type ResetSnapshot, type ResetCreditService, type ResetExhaustionEvidence } from './reset-credits.js';
import { workspaceModelScopes } from './workspace-model-scopes.js';
type Scope=ReturnType<typeof workspaceModelScopes>[number];

/** Account-level quota blockers belong to the currently routed workspace. */
function clearRecoveredScopeQuota(options:{account:ManagedAccount;scope:Scope;family:ModelFamily;model:string;manager:AccountManager;clearQuotaScheduler:(account:ManagedAccount)=>void}):boolean {
 const {account,scope,family,model,manager,clearQuotaScheduler}=options;
 // Recheck selection and enablement: a reset read may outlive a workspace change.
 if(account.lastRateLimitReason!=='quota'||!workspaceModelScopes(account).some(current=>
  current.routable&&current.id===scope.id&&current.accountId===scope.accountId))return false;
 delete account.rateLimitResetTimes[family];delete account.rateLimitResetTimes[`${family}:${model}`];
 const workspace=selectedQuotaWorkspace(account);
 if(workspace){delete account.rateLimitResetTimes[workspaceQuotaKey(family,workspace)];delete account.rateLimitResetTimes[workspaceQuotaKey(`${family}:${model}`,workspace)];}
 if(account.cooldownReason==='rate-limit')manager.clearAccountCooldown(account);
 clearQuotaScheduler(account);
 return true;
}

export async function recoverResetQuota(options:{
 model:string;family?:ModelFamily;native:boolean;pinned:boolean;manager:AccountManager;
 scopes:Map<number,Scope[]>;priorityByAccount?:Record<number,number>;preferredIndex?:number|null;quotaForScope:(account:ManagedAccount,scope:Scope)=>QuotaCacheEntry|null|undefined;
 service:Pick<ResetCreditService,'automatic'> & {status:()=>Promise<{snapshots:Awaited<ReturnType<ResetCreditService['status']>>['snapshots']}>};
 quotaRejections?:ReadonlyMap<string,ResetExhaustionEvidence>;
 observations:Map<string,QuotaCacheEntry>;clearQuotaScheduler:(account:ManagedAccount)=>void;now:()=>number;
}):Promise<boolean>{
 if(options.model===LUNA_RESERVE_MODEL||!options.native||options.pinned||parseModelRoute(options.model).kind!=='oauth')return false;
 const family=options.family??'codex';
 const candidates=[...options.scopes].flatMap(([index,scopes])=>{const account=options.manager.getAccountByIndex(index);return account&&!account.authInvalidatedAt?scopes.map(scope=>({account,scope})):[];});
 if(!candidates.length)return false;
 const currentScope=(account:ManagedAccount,scope:Scope)=>workspaceModelScopes(account).some(current=>
  current.routable&&current.id===scope.id&&current.accountId===scope.accountId);
 const rejectionForScope=(account:ManagedAccount,scope:Scope)=>{
  const proof=options.quotaRejections?.get(JSON.stringify([scope.id,options.model]));
  const latest=options.quotaForScope(account,scope),now=options.now();
  // An older in-flight response can deliver newer percentage headers. Only a
  // later authoritative native permission check supersedes a body rejection.
  const checkedAt=typeof latest?.ordinaryUsageAllowed==='boolean'
   ?latest.ordinaryUsageCheckedAt??latest.updatedAt:0;
  return proof&&proof.key===scope.id&&proof.accountId===scope.accountId&&
   Number.isFinite(proof.observedAt)&&proof.observedAt<=now&&now-proof.observedAt<=60000&&
   proof.observedAt>checkedAt?proof:undefined;
 };
 // Any usable capacity (including the reserve), unknown quota, or non-quota
 // failure prevents an automatic credit from being spent.
 if(candidates.some(({account,scope})=>{
  if(account.enabled===false||account.authInvalidatedAt||!scope.routable||!currentScope(account,scope))return true;
  const skip=options.manager.getAccountRuntimeSkipReason(account.index,family,options.model);
  if(skip&&!['rate-limited','cooling-down:rate-limit'].includes(skip))return true;
  const quota=subscriptionQuotaPreference(options.quotaForScope(account,scope),options.now());
  return !quota.exhausted&&!rejectionForScope(account,scope)&&!['rate-limited','cooling-down:rate-limit'].includes(skip??'');
 }))return false;
 candidates.sort((a,b)=>Number(b.account.index===options.preferredIndex)-Number(a.account.index===options.preferredIndex)||(options.priorityByAccount?.[a.account.index]??1)-(options.priorityByAccount?.[b.account.index]??1));
 const targets=candidates.filter(({scope})=>!scope.accountId.startsWith("org-")).map(({scope})=>({key:scope.id,accountId:scope.accountId}));
 const evidence:ResetExhaustionEvidence[]=candidates.flatMap(({account,scope})=>{
  if(scope.accountId.startsWith("org-"))return [];
  const rejection=rejectionForScope(account,scope);
  if(rejection)return [rejection];
  const quota=subscriptionQuotaPreference(options.quotaForScope(account,scope),options.now());
  return quota.exhausted&&quota.observedAt!==null
   ?[{key:scope.id,accountId:scope.accountId,observedAt:quota.observedAt}]:[];
 });
 await options.service.automatic(targets,evidence);
 const state=await options.service.status();let recovered=false;
 for(const {account,scope} of candidates){
  const snapshot=state.snapshots[scope.id];const previous=options.quotaForScope(account,scope);
  const rejectedAt=rejectionForScope(account,scope)?.observedAt??0;
  // Healthy headers may arrive late from an older in-flight request. Native
  // permission chronology wins there; unknown, exhausted, and failed reads do not.
  const healthyHeaders=snapshot?.ordinaryUsageAllowed===true&&previous?.status===200&&
   (subscriptionQuotaPreference(previous,options.now()).remainingPercent??0)>0;
  const previousAt=healthyHeaders
   ?typeof previous?.ordinaryUsageAllowed==='boolean'?previous.ordinaryUsageCheckedAt??previous.updatedAt:0
   :previous?.updatedAt??0;
  if(!snapshot||snapshot.updatedAt<Math.max(previousAt,rejectedAt)||options.now()-snapshot.updatedAt>60000||snapshot.updatedAt>options.now())continue;
  options.observations.set(JSON.stringify([scope.id,options.model]),resetSnapshotQuota(snapshot));
  if(snapshot.ordinaryUsageAllowed!==true)continue;
  clearRecoveredScopeQuota({...options,account,scope,family});
  recovered=true;
 }
 if(recovered)options.manager.saveToDiskDebounced();
 return recovered;
}

/** Unknown, stale, or pending reset state must never authorize backup traffic. */
export function primaryPoolFullyExhausted(
 scopes: Map<number, Scope[]>,
 state: { snapshots: Record<string, ResetSnapshot>; pending?: { key: string } } | null,
 now: number,
 latestQuota?: (index: number, scope: Scope) => QuotaCacheEntry | null | undefined,
): boolean {
 const primary = [...scopes].flatMap(([index, rows]) => rows.map(scope => ({ index, scope })));
 return primary.length > 0 && !!state && !state.pending && primary.every(({ index, scope }) => {
  const snapshot = state.snapshots[scope.id];
  const latest = latestQuota?.(index, scope);
  if (snapshot && latest && latest.updatedAt >= snapshot.updatedAt &&
      !subscriptionQuotaPreference(latest, now).exhausted) return false;
  return scope.routable && !!snapshot && Number.isFinite(snapshot.updatedAt) &&
   snapshot.updatedAt <= now && now - snapshot.updatedAt <= 60_000 &&
   isResetSubscription(snapshot) && snapshot.ordinaryUsageAllowed === false &&
   snapshot.availableCount === 0;
 });
}
