import { createHash } from "node:crypto";
import { resolveAccountRecordId, type ManagedAccount } from "../accounts.js";
import { extractAccountId } from "../auth/token-utils.js";

export function modelScopeId(...parts: string[]): string {
 return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Request scopes are immutable views. Discovery must never switch a saved account. */
export function workspaceModelScopes(account: ManagedAccount) {
 const boundId = account.accountId?.trim() || extractAccountId(account.access);
 const candidates = (account.workspaces ?? []).map((workspace,index) => ({
  accountId:workspace.id.trim(), workspaceIndex:index,
  enabled:account.enabled !== false && workspace.enabled !== false,
 }));
 if (boundId && !candidates.some(scope=>scope.accountId===boundId))
  candidates.unshift({accountId:boundId,workspaceIndex:-1,enabled:account.enabled!==false});
 if (!candidates.length) candidates.push({accountId:"",workspaceIndex:-1,enabled:account.enabled!==false});
 const seen = new Set<string>();
 return candidates.filter(scope=>{
  if(seen.has(scope.accountId)) return false;
  seen.add(scope.accountId); return true;
 }).map(scope=>({
  ...scope,
  // Same record identity as reset-credit targets (resolveAccountRecordId), or their keys diverge.
  id:modelScopeId("oauth",resolveAccountRecordId(account),scope.accountId),
  accountIndex:account.index,
  routable:scope.enabled && Boolean(scope.accountId),
  bound:scope.accountId===boundId,
  selected:scope.workspaceIndex >= 0 && scope.workspaceIndex===(account.currentWorkspaceIndex??0),
  label:`Account ${account.index+1}${scope.workspaceIndex>=0?` / Workspace ${scope.workspaceIndex+1}`:candidates.length>1?" / Stored binding":""}`,
 }));
}
