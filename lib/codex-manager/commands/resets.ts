import { AccountManager } from '../../accounts.js';
import { loadAccounts, type AccountMetadataV3 } from '../../storage.js';
import { runWithGlobalStoragePath } from '../../storage/path-state.js';
import { createResetCreditService, resetTargetForStoredAccount, resetAccountLabel, formatResetCreditLine } from '../../runtime/account-reset-credits.js';
import { withCheckProgress } from '../../ui/check-progress.js';
// A pending result may belong to a workspace that was since disabled or deselected.
function ownsPendingKey(account:AccountMetadataV3,key:string):boolean{
 const workspaces=account.workspaces?.map(workspace=>({...workspace,enabled:true}));
 const selections=[undefined,...(workspaces??[]).map((_,index)=>index)];
 return selections.some(index=>resetTargetForStoredAccount({...account,enabled:true,workspaces:index===undefined?undefined:workspaces,currentWorkspaceIndex:index??account.currentWorkspaceIndex})?.key===key);
}
const usage='Usage: codex-multi-auth resets list [--refresh] | redeem <account-number> | auto manual|last-resort';
export async function runResetsCommand(args:string[]):Promise<number>{
 const [command='list',value,...extra]=args;
 if(command==='--help'||command==='-h'){console.log(usage);return 0;}
 if(extra.length||!['list','redeem','auto'].includes(command)||(command==='list'&&value!==undefined&&value!=='--refresh')||(command==='redeem'&&!/^[1-9][0-9]*$/.test(value??''))||(command==='auto'&&value!=='manual'&&value!=='last-resort')){console.error(usage);return 1;}
 return runWithGlobalStoragePath(async () => {
 const storage=await loadAccounts();const manager=new AccountManager(undefined,storage);const service=createResetCreditService(manager);
 try{
  if(command==='auto'){await service.setPolicy(value as 'manual'|'last-resort');console.log(`Automatic reset redemption: ${value}`);return 0;}
  if(command==='redeem'){
   const index=Number(value)-1;const account=storage?.accounts[index];const target=account&&resetTargetForStoredAccount(account);if(!target){console.error('Choose a configured, enabled subscription account/workspace.');return 1;}
   const outcome=await withCheckProgress(`Redeeming a reset for account ${index+1}`,()=>service.redeem(target));console.log(`Account ${index+1}: ${outcome}. Usage was re-read.`);return 0;
  }
  const targets=(storage?.accounts??[]).map(resetTargetForStoredAccount).filter(t=>t!==null);
  const keyCounts=new Map<string,number>();
  for(const target of targets)keyCounts.set(target.key,(keyCounts.get(target.key)??0)+1);
  const refreshed=value==='--refresh'?await withCheckProgress('Refreshing reset-credit availability',()=>service.refresh(targets)):null;
  const state=await service.status();console.log(`Automatic redemption: ${state.policy}`);
  if(state.lastRedemption){const index=(storage?.accounts??[]).findIndex(a=>resetTargetForStoredAccount(a)?.key===state.lastRedemption?.key);console.log(`Last confirmed reset: ${index>=0?`account ${index+1}`:"removed account"}; ${state.lastRedemption.outcome}; ${state.lastRedemption.automatic?"automatic":"explicit"}`);}
  (storage?.accounts??[]).forEach((a,i)=>{
   const target=resetTargetForStoredAccount(a);
   const ambiguous=target&&(keyCounts.get(target.key)??0)>1;
   const snapshot=target&&!ambiguous?(refreshed??state.snapshots)[target.key]:undefined;
   console.log(`${resetAccountLabel(a,i)}: ${snapshot?.availableCount??'unknown'} reset credits${snapshot?` (checked ${Math.max(0,Math.floor((Date.now()-snapshot.updatedAt)/1000))}s ago)`:''}${ambiguous?' [ambiguous account identity; repair duplicate records]':''}${target?.key===state.pending?.key?' [redemption pending; retry this account]':''}`);
   snapshot?.credits?.forEach((c,idx)=>console.log(formatResetCreditLine(c,idx)));
  });
  const failed=refreshed?targets.filter(target=>(keyCounts.get(target.key)??0)>1||!refreshed[target.key]).length:0;
  if(failed){console.error(`${failed} of ${targets.length} reset-credit reads failed. Check account authentication and the native Codex backend (CODEX_MULTI_AUTH_USAGE_CODEX_BIN selects an executable). No credits were redeemed.`);return 1;}
  return 0;
 }catch{
  // Only a consume whose result is unknown leaves a pending record; guard,
  // pre-read and unknown-availability failures stop before spending anything.
  const pending=command==='redeem'?await service.status().then(s=>s.pending??null,()=>({key:undefined})):null;
  // The pending record can belong to another account (a redeem is refused while
  // any result is pending); point at the account that actually needs the retry.
  const pendingKey=pending?.key;
  const owner=pendingKey?(storage?.accounts??[]).findIndex(a=>ownsPendingKey(a,pendingKey)):-1;
  const pendingAccount=owner>=0?storage?.accounts[owner]:undefined;
  const disabled=pendingAccount?resetTargetForStoredAccount(pendingAccount)?.key!==pendingKey:false;
  const retry=disabled?`account ${owner+1} or its pending workspace is disabled or no longer selected; re-enable and select it before retrying the pending result`:pending?.key&&owner<0?'check it there (the pending account was removed)':owner>=0&&owner!==Number(value)-1?`retry account ${owner+1}, which holds the pending result`:'retry the same account';
  console.error(command==='list'?'Reset-credit availability could not be refreshed. No credits were redeemed.':command==='auto'?'Reset-credit settings could not be updated.':pending?`Reset operation could not be confirmed. No new automatic redemption will be attempted while a result is pending; use resets list and ${retry}.`:'No reset credit was redeemed. Availability could not be confirmed or a reset was just redeemed; run resets list --refresh and try again.');return 1;}
 finally{await manager.flushPendingSave();}
 });
}
