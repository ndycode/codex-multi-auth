import { join } from 'node:path';
import { AccountManager, resolveAccountRecordId, sanitizeEmail } from '../accounts.js';
import { loadAccounts, type AccountMetadataV3 } from '../storage.js';
import { getCodexMultiAuthDir } from '../runtime-paths.js';
import { ensureFreshAccessToken } from './rotation-token-refresh.js';
import { modelScopeId, workspaceModelScopes, nativeWorkspaceIdentity } from './workspace-model-scopes.js';
import { nativeRateLimitsRpc } from './native-rate-limits.js';
import { codexCliAccountIdFor } from '../auth/token-utils.js';
import { isRecord } from '../utils.js';
import { ResetCreditService, type ResetCreditDetail, type ResetTarget } from './reset-credits.js';
import { withCheckProgress } from '../ui/check-progress.js';

export function resetTargetForStoredAccount(account:AccountMetadataV3):ResetTarget|null{
 // Organization display aliases are not native ChatGPT workspace identities.
 const selected=account.workspaces?.length ? account.workspaces[account.currentWorkspaceIndex ?? 0] : undefined;
 if(account.workspaces?.length && (!selected || selected.enabled===false))return null;
 const stored=(selected?.id ?? account.accountId)?.trim();
 const id=nativeWorkspaceIdentity({access:account.accessToken,codexCliMirror:account.codexCliMirror},stored);
 const workspace=account.workspaces?.find(w=>w.id===id);
 if(!id||id.startsWith("org-")||account.enabled===false||(!selected && workspace?.enabled===false))return null;
 return {key:modelScopeId('oauth',resolveAccountRecordId(account),id),accountId:id};
}
export function isResetTargetEnabled(account:AccountMetadataV3,target:ResetTarget):boolean {
 if(account.enabled===false)return false;
 const canonical=resetTargetForStoredAccount(account);
 if(canonical?.key===target.key&&canonical.accountId===target.accountId)return true;
 return false;
}

export function createResetCreditService(manager?:AccountManager):ResetCreditService {
 const auth=async(target:ResetTarget)=>{
  const matches=manager?.getAccountsSnapshot().filter(a=>workspaceModelScopes(a).some(s=>s.id===target.key&&s.accountId===target.accountId&&s.routable) || (resetTargetForStoredAccount({...a,accessToken:a.access})?.key===target.key && resetTargetForStoredAccount({...a,accessToken:a.access})?.accountId===target.accountId));
  if(matches&&matches.length>1)throw Error('Reset account identity is ambiguous; repair duplicate records before checking or redeeming');
  const account=matches?.[0];
  const current=account&&manager?.getAccountByIndex(account.index);
  if(!manager||!current||current.enabled===false)throw Error('Reset workspace is not enabled');
  const fresh=await ensureFreshAccessToken({accountManager:manager,account:current,family:'codex',model:null,now:Date.now(),tokenRefreshSkewMs:60000,tokenInvalidationCooldownMs:300000});
  if(!fresh.ok)throw Error('Reset account authentication unavailable');
  // The mirror carries the id Codex CLI accepts when the backend refused an explicit binding.
 return {accessToken:fresh.accessToken,accountId:target.accountId,expiresAt:fresh.account.expires??0,codexCliMirror:current.codexCliMirror};
 };
 return new ResetCreditService(join(getCodexMultiAuthDir(),'reset-credits.json'),{
  read:async(target,{creditDetails})=>{
   // The backend answers for the id written into its auth.json (the mirror id when one
   // applies). Verify the reply against that id; the snapshot stays keyed on the target.
   const freshAuth=await auth(target);
   const sent=codexCliAccountIdFor(freshAuth,freshAuth.accessToken)??freshAuth.accountId;
   const reply=await nativeRateLimitsRpc(freshAuth,'account/rateLimits/read',{excludeResetCreditDetails:!creditDetails});
   if(!isRecord(reply)||reply.accountId!==sent)throw Error('Reset credit workspace identity mismatch');
   return {...reply,accountId:target.accountId};
  },
  consume:async(target,idempotencyKey,creditId)=>{
   const freshAuth=await auth(target);
   const disk=await loadAccounts();
   const matches=disk?.accounts.filter(a=>isResetTargetEnabled(a,target))??[];
   if(matches.length>1)throw Error('Reset account identity is ambiguous; no credit consumed');
   if(matches.length!==1)throw Error('Reset target was removed, disabled, or changed; no credit consumed');
   return nativeRateLimitsRpc(freshAuth,'account/rateLimitResetCredit/consume',{idempotencyKey,...(creditId===undefined?{}:{creditId})});
  },
 });
}
export async function loadResetCreditState(){return createResetCreditService().status();}
/** Local terminal labels only; never used in provider requests or public artifacts. */
export function resetAccountLabel(account: Pick<AccountMetadataV3, "email">, index: number): string {
 const email = sanitizeEmail(account.email);
 const printable = email && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(email);
 return `Account ${index + 1}${printable ? ` (${email})` : ""}`;
}
/** Strips terminal control codes, invisible formatters, and whitespace before printing credit titles. */
export function sanitizeCreditTitle(title: string | null | undefined): string | null {
 if (typeof title !== "string") return null;
 const trimmed = title.trim();
 if (!trimmed || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(trimmed)) return null;
 return trimmed;
}
/** One local terminal line per credit row; expiresAt is Unix seconds and null means it never expires. */
export function formatResetCreditLine(credit:ResetCreditDetail,index:number):string{
 const date=new Date(typeof credit.expiresAt==='number'&&credit.expiresAt>0?credit.expiresAt*1000:Number.NaN);
 const expiry=credit.expiresAt===null?'no expiry':Number.isNaN(date.getTime())?'expires unknown':`expires ${date.toLocaleString()}`;
 const title=sanitizeCreditTitle(credit.title);
 return `   - credit #${index+1}: ${expiry}${title?` (${title})`:''}`;
}
export async function refreshAndPrintResetCredits(log:(message:string)=>void){
 const storage=await loadAccounts();if(!storage?.accounts.length)return;
 const manager=new AccountManager(undefined,storage);
 const targets=storage.accounts.map(resetTargetForStoredAccount).filter((t):t is ResetTarget=>Boolean(t));
 try{
  const snapshots=await withCheckProgress(`Checking reset credits for ${targets.length} accounts`,()=>createResetCreditService(manager).refresh(targets),log);
  storage.accounts.forEach((a,i)=>{
   const target=resetTargetForStoredAccount(a);
   const snap=target?snapshots[target.key]:undefined;
   log(`${resetAccountLabel(a,i)}: available subscription resets: ${snap?.availableCount??'unknown (not verified)'}`);
   snap?.credits?.forEach((c,idx)=>log(formatResetCreditLine(c,idx)));
  });
 }finally{await manager.flushPendingSave();}
}
