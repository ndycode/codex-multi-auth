import { promises as fs } from "node:fs";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetCreditService, parseResetSnapshot, type ResetTarget } from '../lib/runtime/reset-credits.js';
let dir: string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'reset-credits-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true,maxRetries:5});});
const target=(id:string):ResetTarget=>({key:id,accountId:id});
const payload=(id:string,allowed:boolean|null=false,count:number|null=2)=>({accountId:id,ordinaryUsageAllowed:allowed,rateLimitResetCredits:count===null?null:{availableCount:count,credits:[]},rateLimits:{planType:'pro',primary:{usedPercent:allowed?0:100,resetsAt:2000000000,windowDurationMins:300},secondary:{usedPercent:10}}});
function fixture(){
 const read=vi.fn(async(t:ResetTarget)=>payload(t.accountId));
 const consume=vi.fn(async(_t:ResetTarget,_key:string)=>({outcome:'reset'}));
 const service=new ResetCreditService(join(dir,'state.json'),{read,consume});
 return {service,read,consume};
}
describe('reset credits',()=>{
 it('trusts the count, not a capped detail list; preserves unknown',()=>{
  expect(parseResetSnapshot(payload('a'), 'a',1).availableCount).toBe(2);
  expect(parseResetSnapshot(payload('a',null,null),'a',1).availableCount).toBeNull();
  expect(()=>parseResetSnapshot(payload('b'),'a',1)).toThrow(/identity/);
  expect(()=>parseResetSnapshot({...payload('a'),rateLimitResetCredits:{availableCount:-1}},'a',1)).toThrow();
 });
 it('defaults to manual and does not redeem in automatic mode',async()=>{
  const f=fixture();expect(await f.service.automatic([target('a')])).toBeNull();expect(f.consume).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
 });
 it('caches each workspace independently without credentials',async()=>{
  const f=fixture();await f.service.refresh([target('a'),target('b')]);const state=await f.service.status();expect(state.snapshots.a?.availableCount).toBe(2);expect(Object.keys(state.snapshots)).toEqual(['a','b']);
 });
 it('reuses a persisted idempotency key after an ambiguous failure across restarts',async()=>{
  const f=fixture();f.consume.mockRejectedValueOnce(Error('lost reply'));await expect(f.service.redeem(target('a'))).rejects.toThrow('lost reply');
  const second=new ResetCreditService(join(dir,'state.json'),{read:f.read,consume:f.consume});await second.redeem(target('a'));expect(f.consume.mock.calls[0]?.[1]).toBe(f.consume.mock.calls[1]?.[1]);expect(f.read).toHaveBeenCalledTimes(2);
 });
 it.each([true,null])('does not auto redeem when another subscription reports %s',async(allowed)=>{
  const f=fixture();await f.service.setPolicy('last-resort');f.read.mockImplementation(async t=>payload(t.accountId,t.key==='b'?allowed:false));expect(await f.service.automatic([target('a'),target('b')])).toBeNull();expect(f.consume).not.toHaveBeenCalled();
 });
 it('does not auto redeem on an unknown or failed account read',async()=>{
  const f=fixture();await f.service.setPolicy('last-resort');f.read.mockImplementation(async t=>{if(t.key==='b')throw Error('offline');return payload(t.accountId)});expect(await f.service.automatic([target('a'),target('b')])).toBeNull();expect(f.consume).not.toHaveBeenCalled();
 });
 it('redeems only one credit after every eligible subscription is freshly blocked',async()=>{
  const f=fixture();await f.service.setPolicy('last-resort');await f.service.automatic([target('a'),target('b')]);expect(f.consume).toHaveBeenCalledTimes(1);expect(f.consume.mock.calls[0]?.[0].key).toBe('a');expect(f.read.mock.calls.length).toBeGreaterThanOrEqual(3);
 });
 it('never automatically retries an ambiguous redemption',async()=>{
  const f=fixture();await f.service.setPolicy('last-resort');f.consume.mockRejectedValueOnce(Error('lost reply'));await expect(f.service.automatic([target('a')])).rejects.toThrow();await f.service.automatic([target('a')]);expect(f.consume).toHaveBeenCalledTimes(1);
 });
 it('serializes two services so concurrent exhaustion does not spend twice',async()=>{
  const f=fixture();await f.service.setPolicy('last-resort');const second=new ResetCreditService(join(dir,'state.json'),{read:f.read,consume:f.consume});await Promise.all([f.service.automatic([target('a')]),second.automatic([target('a')])]);expect(f.consume).toHaveBeenCalledTimes(1);
 });
 it('serializes redemptions across separate module instances (cross-process)',async()=>{
  // A fresh module instance has its own in-process promise map, so only the
  // file lock can stop a second spend. Park the first instance's first state
  // write (its check marker) so the second instance reads state in that window.
  const f=fixture();await f.service.setPolicy('last-resort');
  vi.resetModules();const {ResetCreditService:Other}=await import('../lib/runtime/reset-credits.js');
  const realRename=fs.rename.bind(fs);let parked=false;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered!:()=>void;const inside=new Promise<void>(r=>{entered=r;});
  const rename=vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{
   if(!parked&&String(to).endsWith('state.json')){parked=true;entered();await Promise.race([gate,new Promise(r=>setTimeout(r,300))]);}
   return realRename(from,to);
  });
  try {
   const first=f.service.automatic([target('a')]);await inside;
   const second=new Other(join(dir,'state.json'),{read:f.read,consume:f.consume}).automatic([target('a')]);
   await new Promise(r=>setTimeout(r,50));
   release();
   const results=await Promise.all([first,second]);
   expect(results.filter(result=>result!==null)).toHaveLength(1);
   expect(f.consume).toHaveBeenCalledTimes(1);
  } finally {rename.mockRestore();}
 });
 it('keeps an uncertain completion pending if its follow-up read fails',async()=>{
  const f=fixture();f.read.mockResolvedValueOnce(payload('a')).mockRejectedValueOnce(Error('offline'));await expect(f.service.redeem(target('a'))).rejects.toThrow();expect((await f.service.status()).pending?.key).toBe('a');
 });
 it('refuses automatic redemption for non-subscription or mismatched identities',async()=>{
  const f=fixture();await f.service.setPolicy('last-resort');f.read.mockResolvedValue({...payload('a'),rateLimits:{planType:'free',primary:{usedPercent:100}}} as ReturnType<typeof payload>);await f.service.automatic([target('a')]);expect(f.consume).not.toHaveBeenCalled();
 });
});
it('records which workspace and outcome an automatic redemption confirmed',async()=>{
 const f=fixture();await f.service.setPolicy('last-resort');await f.service.automatic([target('a')]);expect((await f.service.status()).lastRedemption).toMatchObject({key:'a',outcome:'reset',automatic:true});
});
it('waits for an imminent scheduled reset instead of spending a credit',async()=>{
 const f=fixture();await f.service.setPolicy('last-resort');f.read.mockResolvedValue({...payload('a'),rateLimits:{planType:'pro',primary:{usedPercent:100,resetsAt:Math.floor(Date.now()/1000)+30,windowDurationMins:300},secondary:{usedPercent:0}}});await f.service.automatic([target('a')]);expect(f.consume).not.toHaveBeenCalled();
});

it('backs off negative automatic checks across service instances',async()=>{
 const f=fixture();await f.service.setPolicy('last-resort');f.read.mockImplementation(async t=>payload(t.accountId,false,0));
 await f.service.automatic([target('a')]);
 const second=new ResetCreditService(join(dir,'state.json'),{read:f.read,consume:f.consume});
 await second.automatic([target('a')]);expect(f.read).toHaveBeenCalledTimes(1);expect(f.consume).not.toHaveBeenCalled();
});

it('shares a concurrent automatic check across service instances instead of repeating native reads',async()=>{
 const f=fixture();await f.service.setPolicy('last-resort');let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 f.read.mockImplementation(async t=>{entered();await gate;return payload(t.accountId,false,0);});
 const first=f.service.automatic([target('a')]);await started;const other=new ResetCreditService(join(dir,'state.json'),{read:f.read,consume:f.consume});const second=other.automatic([target('a')]);
 const results=Promise.allSettled([first,second]);await new Promise(r=>setTimeout(r,1300));release();expect((await results).map(r=>r.status)).toEqual(['fulfilled','fulfilled']);expect(f.read).toHaveBeenCalledTimes(1);
});

it("retries a transient EPERM publishing reset state",async()=>{
 const f=fixture(); const rename=fs.rename.bind(fs);
 const spy=vi.spyOn(fs,"rename");
 let failed=false;
 spy.mockImplementation(async(from,to)=>{if(!failed&&String(to)===join(dir,"state.json")){failed=true;throw Object.assign(Error("locked"),{code:"EPERM"});}return rename(from,to);});
 try {await expect(f.service.refresh([target("a")])).resolves.toBeDefined();expect(failed).toBe(true);expect((await f.service.status()).snapshots.a?.availableCount).toBe(2);}
 finally {spy.mockRestore();}
});
