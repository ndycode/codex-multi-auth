import { join } from 'node:path';
import { AccountManager, extractAccountId, resolveAccountRecordId, sanitizeEmail } from '../accounts.js';
import { loadAccounts, type AccountMetadataV3 } from '../storage.js';
import { getCodexMultiAuthDir } from '../runtime-paths.js';
import { ensureFreshAccessToken } from './rotation-token-refresh.js';
import { modelScopeId, workspaceModelScopes } from './workspace-model-scopes.js';
import { nativeRateLimitsRpc } from './native-rate-limits.js';
import { ResetCreditService, type ResetTarget } from './reset-credits.js';
import { withCheckProgress } from '../ui/check-progress.js';

export function resetTargetForStoredAccount(account:AccountMetadataV3):ResetTarget|null{
 // Organization display aliases are not native ChatGPT workspace identities.
 const stored=account.accountId?.trim();
 const id=stored?.startsWith("org-") ? extractAccountId(account.accessToken)?.trim() : stored;
 const workspace=account.workspaces?.find(w=>w.id===id);
 if(!id||id.startsWith("org-")||account.enabled===false||workspace?.enabled===false)return null;
 return {key:modelScopeId('oauth',resolveAccountRecordId(account),id),accountId:id};
}
export function isResetTargetEnabled(account:AccountMetadataV3,target:ResetTarget):boolean {
 if(account.enabled===false)return false;
 const canonical=resetTargetForStoredAccount(account);
 if(canonical?.key===target.key&&canonical.accountId===target.accountId)return true;
 const scopeKey=modelScopeId('oauth',resolveAccountRecordId(account),target.accountId);
 return !target.accountId.startsWith('org-')&&scopeKey===target.key&&Boolean(account.workspaces?.some(w=>w.id===target.accountId&&w.enabled!==false));
}

export function createResetCreditService(manager?:AccountManager):ResetCreditService {
 const auth=async(target:ResetTarget)=>{
  const account=manager?.getAccountsSnapshot().find(a=>workspaceModelScopes(a).some(s=>s.id===target.key&&s.accountId===target.accountId&&s.routable) || (resetTargetForStoredAccount({...a,accessToken:a.access})?.key===target.key && resetTargetForStoredAccount({...a,accessToken:a.access})?.accountId===target.accountId));
  const current=account&&manager?.getAccountByIndex(account.index);
  if(!manager||!current||current.enabled===false)throw Error('Reset workspace is not enabled');
  const fresh=await ensureFreshAccessToken({accountManager:manager,account:current,family:'codex',model:null,now:Date.now(),tokenRefreshSkewMs:60000,tokenInvalidationCooldownMs:300000});
  if(!fresh.ok)throw Error('Reset account authentication unavailable');
  // The mirror carries the id Codex CLI accepts when the backend refused an explicit binding.
 return {accessToken:fresh.accessToken,accountId:target.accountId,expiresAt:fresh.account.expires??0,codexCliMirror:current.codexCliMirror};
 };
 return new ResetCreditService(join(getCodexMultiAuthDir(),'reset-credits.json'),{
  read:async target=>nativeRateLimitsRpc(await auth(target),'account/rateLimits/read',{excludeResetCreditDetails:true}),
  consume:async(target,idempotencyKey)=>{
   const freshAuth=await auth(target);
   const disk=await loadAccounts();
   if(!disk?.accounts.some(a=>isResetTargetEnabled(a,target)))throw Error('Reset target was removed, disabled, or changed; no credit consumed');
   return nativeRateLimitsRpc(freshAuth,'account/rateLimitResetCredit/consume',{idempotencyKey});
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
export async function refreshAndPrintResetCredits(log:(message:string)=>void){
 const storage=await loadAccounts();if(!storage?.accounts.length)return;
 const manager=new AccountManager(undefined,storage);
 const targets=storage.accounts.map(resetTargetForStoredAccount).filter((t):t is ResetTarget=>Boolean(t));
 try{
  const snapshots=await withCheckProgress(`Checking reset credits for ${targets.length} accounts`,()=>createResetCreditService(manager).refresh(targets),log);
  storage.accounts.forEach((a,i)=>{const target=resetTargetForStoredAccount(a);const count=target?snapshots[target.key]?.availableCount:undefined;log(`${resetAccountLabel(a,i)}: available subscription resets: ${count??'unknown (not verified)'}`);});
 }finally{await manager.flushPendingSave();}
}
