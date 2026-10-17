import {describe,it,expect} from "vitest";
import type {ManagedAccount} from "../lib/accounts.js";
import {workspaceModelScopes} from "../lib/runtime/workspace-model-scopes.js";
const account = (changes:Partial<ManagedAccount>={}) => ({index:0,accountId:"bound",access:"",refreshToken:"test",workspaces:[{id:"first",enabled:true},{id:"chosen",enabled:true}],currentWorkspaceIndex:1,...changes} as ManagedAccount);
describe("workspace routing boundaries",()=>{
 it("routes only the chosen workspace, excluding siblings and stored binding",()=>{
  expect(workspaceModelScopes(account()).filter(s=>s.routable).map(s=>s.accountId)).toEqual(["chosen"]);
 });
 it("does not replace a disabled selected workspace",()=>{
  expect(workspaceModelScopes(account({workspaces:[{id:"first",enabled:true},{id:"chosen",enabled:false}]})).filter(s=>s.routable)).toEqual([]);
 });
 it("fails closed for an invalid selection",()=>{
  expect(workspaceModelScopes(account({currentWorkspaceIndex:9})).filter(s=>s.routable)).toEqual([]);
 });
 it("preserves bound routing for accounts without tracked workspaces",()=>{
  expect(workspaceModelScopes(account({workspaces:[]})).filter(s=>s.routable).map(s=>s.accountId)).toEqual(["bound"]);
 });
});

const nativeToken='header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'native'}})).toString('base64url')+'.sig';
it('maps selected Personal to its native identity without losing selection to a duplicate binding',()=>{
 const a=account({accountId:'native',access:nativeToken,workspaces:[{id:'native',enabled:true},{id:'org-personal',name:'Personal',enabled:true}]});
 const scopes=workspaceModelScopes(a).filter(s=>s.routable);
 expect(scopes).toHaveLength(1);expect(scopes[0]).toMatchObject({accountId:'native',workspaceIndex:1,selected:true});
 expect(a.currentWorkspaceIndex).toBe(1);
});
it('does not map a disabled Personal selection or an unresolved org alias',()=>{
 expect(workspaceModelScopes(account({access:nativeToken,workspaces:[{id:'native',enabled:true},{id:'org-personal',enabled:false}]})).filter(s=>s.routable)).toEqual([]);
 expect(workspaceModelScopes(account({access:'',workspaces:[{id:'native',enabled:true},{id:'org-personal',enabled:true}]})).filter(s=>s.routable)).toEqual([]);
});

it('preserves an explicit native mirror when resolving the selected org alias',()=>{
 const a=account({access:nativeToken,accountId:'org-personal',codexCliMirror:{forAccountId:'org-personal',accountId:'native-mirror'},workspaces:[{id:'sibling',enabled:true},{id:'org-personal',enabled:true}]});
 expect(workspaceModelScopes(a).filter(s=>s.routable).map(s=>s.accountId)).toEqual(['native-mirror']);
});
