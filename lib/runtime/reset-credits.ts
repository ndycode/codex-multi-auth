import { withRetry } from "../fs-retry.js";
import { resolve } from "node:path";
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { withFileTransactionLock } from '../storage/file-lock.js';
import { mapWithConcurrency } from '../concurrency.js';
import type { QuotaCacheEntry } from '../quota-cache.js';

export interface ResetTarget { key: string; accountId: string }
const windowSchema=z.object({usedPercent:z.number().min(0).max(100).optional(),resetsAt:z.number().nonnegative().nullish(),windowDurationMins:z.number().nonnegative().nullish()});
const snapshotSchema=z.object({updatedAt:z.number(),availableCount:z.number().int().nonnegative().nullable(),ordinaryUsageAllowed:z.boolean().nullable(),planType:z.string().nullable(),primary:windowSchema,secondary:windowSchema});
export type ResetSnapshot=z.infer<typeof snapshotSchema>;
const stateSchema=z.object({version:z.literal(1),policy:z.enum(['manual','last-resort']).default('manual'),snapshots:z.record(z.string(),snapshotSchema).default({}),pending:z.object({key:z.string(),idempotencyKey:z.string().uuid()}).optional(),lastAutomaticCheckAt:z.number().optional(),lastRedemptionAt:z.number().optional(),lastRedemption:z.object({key:z.string(),at:z.number(),outcome:z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed']),automatic:z.boolean()}).optional()});
type State=z.infer<typeof stateSchema>;
const readSchema=z.object({accountId:z.string(),ordinaryUsageAllowed:z.boolean().nullish(),rateLimitResetCredits:z.object({availableCount:z.number().int().nonnegative()}).nullish(),rateLimits:z.object({planType:z.string().nullish(),primary:windowSchema.nullish(),secondary:windowSchema.nullish()})});
const outcomeSchema=z.object({outcome:z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed'])});
export type ResetOutcome=z.infer<typeof outcomeSchema>['outcome'];
export function parseResetSnapshot(value:unknown,accountId:string,now:number):ResetSnapshot {
 const parsed=readSchema.parse(value);
 if(parsed.accountId!==accountId)throw Error('Reset credit workspace identity mismatch');
 return {updatedAt:now,availableCount:parsed.rateLimitResetCredits?.availableCount??null,ordinaryUsageAllowed:parsed.ordinaryUsageAllowed??null,planType:parsed.rateLimits.planType??null,primary:parsed.rateLimits.primary??{},secondary:parsed.rateLimits.secondary??{}};
}
export function resetSnapshotQuota(snapshot:ResetSnapshot):QuotaCacheEntry {
 const window=(w:ResetSnapshot['primary'])=>({usedPercent:w.usedPercent,resetAtMs:typeof w.resetsAt==='number'?w.resetsAt*1000:undefined,windowMinutes:w.windowDurationMins??undefined});
 return {updatedAt:snapshot.updatedAt,status:200,model:'usage-read',planType:snapshot.planType??undefined,primary:window(snapshot.primary),secondary:window(snapshot.secondary)};
}
export function isResetSubscription(snapshot:ResetSnapshot):boolean {
 return ['plus','pro','prolite','team','business','self_serve_business_prolite','enterprise','edu','edu_plus','edu_pro'].includes(snapshot.planType??'');
}
export interface ResetCreditIO {
 read:(target:ResetTarget)=>Promise<unknown>;
 consume:(target:ResetTarget,idempotencyKey:string)=>Promise<unknown>;
 now?:()=>number;
}
/** No credentials or credit IDs are persisted. One global redemption lease covers
 * all accounts: concurrent exhausted requests cannot independently spend credits. */
const automaticChecks = new Map<string, {targets:string; promise:Promise<{key:string;outcome:ResetOutcome}|null>}>();
export class ResetCreditService {
 constructor(private readonly path:string,private readonly io:ResetCreditIO){}
 private now(){return this.io.now?.()??Date.now();}
 async status():Promise<State>{
  try { const stat=await fs.lstat(this.path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid reset-credit state file');return stateSchema.parse(JSON.parse(await fs.readFile(this.path,'utf8'))); }
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:1,policy:'manual',snapshots:{}};throw e;}
 }
 private async save(state:State){
  const path=this.path+'.'+randomUUID()+'.tmp';
  try {
   const file=await fs.open(path,'wx',0o600);
   try {await file.writeFile(JSON.stringify(stateSchema.parse(state))+'\n');await file.sync();} finally {await file.close();}
   await withRetry(()=>fs.rename(path,this.path),{maxAttempts:6,backoffMs:25});
  }
  finally {await fs.rm(path,{force:true});}
 }
 async setPolicy(policy:State['policy']){await withFileTransactionLock(this.path,async()=>{const s=await this.status();s.policy=policy;await this.save(s);});}
 private async read(target:ResetTarget){return parseResetSnapshot(await this.io.read(target),target.accountId,this.now());}
 async refresh(targets:ResetTarget[]):Promise<Record<string,ResetSnapshot>>{
  const results=await mapWithConcurrency(targets,3,async t=>{try{return {key:t.key,snapshot:await this.read(t)}}catch{return null}});
  return withFileTransactionLock(this.path,async()=>{const state=await this.status();const updated:Record<string,ResetSnapshot>={};for(const row of results)if(row){const old=state.snapshots[row.key];if(!old||old.updatedAt<=row.snapshot.updatedAt)state.snapshots[row.key]=row.snapshot;updated[row.key]=row.snapshot;}await this.save(state);return updated;});
 }
 private async consumeLocked(state:State,target:ResetTarget,automatic=false):Promise<ResetOutcome>{
  if(state.pending&&state.pending.key!==target.key)throw Error('A reset redemption is pending for another account; retry that account explicitly first.');
  state.pending??={key:target.key,idempotencyKey:randomUUID()};
  state.lastRedemptionAt=this.now();await this.save(state);
  const result=outcomeSchema.parse(await this.io.consume(target,state.pending.idempotencyKey));
  // Keep the same key on *any* ambiguous outcome, including a failed follow-up read.
  state.snapshots[target.key]=await this.read(target);
  state.lastRedemption={key:target.key,at:this.now(),outcome:result.outcome,automatic};
  delete state.pending;await this.save(state);return result.outcome;
 }
 async redeem(target:ResetTarget):Promise<ResetOutcome>{
  return withFileTransactionLock(this.path,async()=>{
   const state=await this.status();
   if(!state.pending&&state.lastRedemptionAt!==undefined&&this.now()-state.lastRedemptionAt<10000)throw Error('A reset was just redeemed; refresh usage before trying again.');
   if(!state.pending){const snapshot=await this.read(target);state.snapshots[target.key]=snapshot;await this.save(state);if(snapshot.availableCount===null)throw Error('Reset-credit availability is unknown');if(snapshot.availableCount===0)return 'noCredit';}
   return this.consumeLocked(state,target);
  });
 }
 automatic(targets:ResetTarget[]):Promise<{key:string;outcome:ResetOutcome}|null>{
  const key=resolve(this.path), signature=JSON.stringify(targets), pending=automaticChecks.get(key);
  if(pending)return pending.targets===signature?pending.promise:pending.promise.then(()=>null);
  if(automaticChecks.size>=1000)return Promise.resolve(null);
  const promise=this.automaticLocked(targets).finally(()=>{automaticChecks.delete(key);});
  automaticChecks.set(key,{targets:signature,promise});
  return promise;
 }
 private async automaticLocked(targets:ResetTarget[]):Promise<{key:string;outcome:ResetOutcome}|null>{
  if(!targets.length||(await this.status()).policy!=='last-resort')return null;
  return withFileTransactionLock(this.path,async()=>{
   const state=await this.status();
   if(state.policy!=='last-resort'||state.pending||(state.lastAutomaticCheckAt!==undefined&&this.now()-state.lastAutomaticCheckAt<60000)||(state.lastRedemptionAt!==undefined&&this.now()-state.lastRedemptionAt<300000))return null;
   state.lastAutomaticCheckAt=this.now();await this.save(state);
   // Missing/failed reads prevent spending. A scheduled reset that has arrived
   // is confirmed by ordinaryUsageAllowed, never inferred from a clock or %.
   const reads=await mapWithConcurrency(targets,3,async t=>{try{return await this.read(t)}catch{return null}});
   reads.forEach((s,i)=>{const t=targets[i];if(s&&t)state.snapshots[t.key]=s;});await this.save(state);
   if(reads.some(s=>!s||!isResetSubscription(s)||s.ordinaryUsageAllowed!==false))return null;
   if(reads.some(s=>s&&[s.primary,s.secondary].some(w=>w.usedPercent===100&&typeof w.resetsAt==='number'&&w.resetsAt*1000<=this.now()+60000)))return null;
   const index=reads.findIndex(s=>s!==null&&(s.availableCount??0)>0);const target=targets[index];
   if(!target)return null;
   return {key:target.key,outcome:await this.consumeLocked(state,target,true)};
  },{waitMs:1000});
 }
}
