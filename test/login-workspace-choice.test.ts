import {describe,it,expect,vi} from 'vitest';
import {chooseLoginWorkspace} from '../lib/codex-manager/login-workspace-choice.js';
const team={accountId:'team',label:'Business',source:'org' as const,isDefault:true};
const personal={accountId:'personal',label:'Personal (role:owner) [id:fixture]',source:'org' as const};
describe('new login workspace choice',()=>{
 it('defaults to the unique Personal workspace without prompting',async()=>{
  const select=vi.fn();
  expect(await chooseLoginWorkspace([team,personal],{interactive:true,select})).toBeUndefined();
  expect(select).not.toHaveBeenCalled();
 });
 it('requires a choice when multiple workspaces have no identifiable Personal',async()=>{
  const select=vi.fn().mockResolvedValue('second');
  expect(await chooseLoginWorkspace([team,{...team,accountId:'second'}],{interactive:true,select})).toBe('second');
  expect(select).toHaveBeenCalledOnce();
 });
 it('falls back to the automatic choice with an --org warning in a noninteractive login',async()=>{
  const select=vi.fn(),warn=vi.fn();
  expect(await chooseLoginWorkspace([team,{...team,accountId:'second'}],{interactive:false,select,warn})).toBeUndefined();
  expect(select).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain('--org');
 });
 it('does not count organization aliases of the token workspace as a second workspace',async()=>{
  const token={accountId:'workspace-uuid',label:'Token account [id:fixture]',source:'token' as const,isDefault:true};
  const org={accountId:'org-business',label:'Business [id:fixture]',source:'org' as const,isDefault:true};
  const select=vi.fn(),warn=vi.fn();
  expect(await chooseLoginWorkspace([token,org],{interactive:true,select,warn})).toBeUndefined();
  expect(await chooseLoginWorkspace([token,org,{...org,accountId:'org-other'}],{interactive:false,select,warn})).toBeUndefined();
  expect(select).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
 });
 it('offers only real workspaces in the interactive picker, never organization aliases',async()=>{
  const select=vi.fn().mockResolvedValue('second');
  const org={accountId:'org-business',label:'Business [id:fixture]',source:'org' as const};
  expect(await chooseLoginWorkspace([team,{...team,accountId:'second'},org],{interactive:true,select})).toBe('second');
  expect(select.mock.calls[0]?.[0].map((item:{value:string})=>item.value)).toEqual(['team','second']);
 });
 it('returns cancellation without a workspace choice',async()=>{
  expect(await chooseLoginWorkspace([team,{...personal,isPersonal:false}],{interactive:true,select:vi.fn().mockResolvedValue(null)})).toBeNull();
 });
 it('asks when multiple candidates are marked Personal',async()=>{
  const select=vi.fn().mockResolvedValue('other');
  expect(await chooseLoginWorkspace([personal,{...personal,accountId:'other'}],{interactive:true,select})).toBe('other');
  expect(select).toHaveBeenCalledOnce();
 });
 it('rejects a selection not offered by the account',async()=>{
  await expect(chooseLoginWorkspace([team,{...team,accountId:'second'}],{interactive:true,select:vi.fn().mockResolvedValue('unrelated')})).rejects.toThrow('Invalid workspace');
 });
 it('does not prompt for a token-only account',async()=>{
  expect(await chooseLoginWorkspace([{...team,source:'token'}],{interactive:false,select:vi.fn()})).toBeUndefined();
 });
});
