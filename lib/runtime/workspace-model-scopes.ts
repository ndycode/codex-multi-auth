import { createHash } from "node:crypto";
import { resolveAccountRecordId, type ManagedAccount } from "../accounts.js";
import { extractAccountId, codexCliAccountIdFor, isOpenAiOrgId } from "../auth/token-utils.js";

export function modelScopeId(...parts: string[]): string {
 return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Preserve the native client's org-alias mapping; this is not workspace fallback. */
export function nativeWorkspaceIdentity(account: Pick<ManagedAccount,"access"|"codexCliMirror">, storedId: string | undefined): string | undefined {
 const id=storedId?.trim();
 if(!id)return undefined;
 if(!isOpenAiOrgId(id))return id;
 const native=codexCliAccountIdFor({accountId:id,codexCliMirror:account.codexCliMirror},account.access);
 return native && !isOpenAiOrgId(native) ? native : undefined;
}

/** Request scopes are immutable views. Discovery must never switch a saved account. */
export function workspaceModelScopes(account: ManagedAccount) {
 const boundId = nativeWorkspaceIdentity(account,account.accountId?.trim() || extractAccountId(account.access));
 const selectedIndex=account.currentWorkspaceIndex ?? 0;
 const candidates = (account.workspaces ?? []).map((workspace,index) => ({
  accountId:index===selectedIndex ? nativeWorkspaceIdentity(account,workspace.id) ?? "" : workspace.id.trim(), workspaceIndex:index,
  enabled:account.enabled !== false && workspace.enabled !== false,
 }));
 if (boundId && !candidates.some(scope=>scope.accountId===boundId))
  candidates.unshift({accountId:boundId,workspaceIndex:-1,enabled:account.enabled!==false});
 if (!candidates.length) candidates.push({accountId:"",workspaceIndex:-1,enabled:account.enabled!==false});
 // A selected alias may resolve to the same identity as an earlier token entry.
 // Keep the selected entry so its enablement and index remain authoritative.
 const seen = new Set<string>();
 return candidates.filter(scope=>{
  if(scope.workspaceIndex!==selectedIndex && candidates.some(other=>other.workspaceIndex===selectedIndex && other.accountId===scope.accountId))return false;
  if(seen.has(scope.accountId)) return false;
  seen.add(scope.accountId); return true;
 }).map(scope=>({
  ...scope,
  // Same record identity as reset-credit targets (resolveAccountRecordId), or their keys diverge.
  id:modelScopeId("oauth",resolveAccountRecordId(account),scope.accountId),
  accountIndex:account.index,
  routable:scope.enabled && Boolean(scope.accountId) && ((account.workspaces?.length ?? 0) > 0
   ? scope.workspaceIndex === (account.currentWorkspaceIndex ?? 0)
   : scope.accountId === boundId),
  bound:scope.accountId===boundId,
  selected:scope.workspaceIndex >= 0 && scope.workspaceIndex===(account.currentWorkspaceIndex??0),
  label:`Account ${account.index+1}${scope.workspaceIndex>=0?` / Workspace ${scope.workspaceIndex+1}`:candidates.length>1?" / Stored binding":""}`,
 }));
}
