import { withRetry } from "../fs-retry.js";
import { resolve } from "node:path";
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { withFileTransactionLock } from '../storage/file-lock.js';
import { mapWithConcurrency } from '../concurrency.js';
import type { QuotaCacheEntry } from '../quota-cache.js';
import { MAX_RATE_LIMIT_DELAY_MS } from '../constants.js';

/** Stable equality for generation-less receipts; never infer order from this value. */
export function resetReceiptIdentity(receipt: {key:string;at:number;outcome:string;automatic:boolean}): string {
 return JSON.stringify([receipt.key,receipt.at,receipt.outcome,receipt.automatic]);
}

export interface ResetTarget { key: string; accountId: string }
/** A routing observation may invalidate a healthy check, never authorize spending. */
export interface ResetExhaustionEvidence extends ResetTarget { observedAt: number }
// Display-only projection: unknown keys (credit ids, backend extras) are stripped before
// persistence, and a malformed field degrades to unknown instead of failing the count read.
// expiresAt is Unix seconds; null means the credit does not expire.
const creditDetailSchema=z.object({expiresAt:z.number().nullish().catch(undefined),title:z.string().nullish().catch(undefined)});
export type ResetCreditDetail=z.infer<typeof creditDetailSchema>;
const creditDetailsSchema=z.array(creditDetailSchema).nullish().catch(null);
const windowSchema=z.object({usedPercent:z.number().min(0).max(100).optional(),resetsAt:z.number().nonnegative().nullish(),windowDurationMins:z.number().nonnegative().nullish()});
const snapshotSchema=z.object({updatedAt:z.number(),availableCount:z.number().int().nonnegative().nullable(),credits:creditDetailsSchema,ordinaryUsageAllowed:z.boolean().nullable(),planType:z.string().nullable(),primary:windowSchema,secondary:windowSchema});
export type ResetSnapshot=z.infer<typeof snapshotSchema>;
const creditIdSchema=z.string().min(1).refine(id=>id.trim().length>0);
const receiptSchema=z.object({key:z.string(),at:z.number(),outcome:z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed']),automatic:z.boolean(),generation:z.number().int().positive().safe().optional()});
const stateSchema=z.object({version:z.union([z.literal(1),z.literal(2),z.literal(3)]),policy:z.enum(['manual','last-resort']).default('manual'),snapshots:z.record(z.string(),snapshotSchema).default({}),pending:z.object({key:z.string(),idempotencyKey:z.string().uuid(),creditId:creditIdSchema.optional()}).optional(),lastAutomaticCheckAt:z.number().optional(),lastRedemptionAt:z.number().optional(),lastRedemption:receiptSchema.optional(),redemptionGeneration:z.number().int().nonnegative().safe().optional(),redemptions:z.record(z.string(),receiptSchema).optional()});
type State=z.infer<typeof stateSchema>;
// Raw credit rows stay in memory for credit selection; only the display projection is persisted.
const readSchema=z.object({accountId:z.string(),ordinaryUsageAllowed:z.boolean().nullish(),rateLimitResetCredits:z.object({availableCount:z.number().int().nonnegative(),credits:z.unknown().optional()}).nullish(),rateLimits:z.object({planType:z.string().nullish(),primary:windowSchema.nullish(),secondary:windowSchema.nullish()})});
const creditSchema=z.object({id:creditIdSchema,status:z.literal('available'),resetType:z.literal('codexRateLimits'),expiresAt:z.number().int().safe().nonnegative().nullish()});
const outcomeSchema=z.object({outcome:z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed'])});
export type ResetOutcome=z.infer<typeof outcomeSchema>['outcome'];
export function parseResetSnapshot(value:unknown,accountId:string,now:number):ResetSnapshot {
 return parseResetReading(value,accountId,now).snapshot;
}
function parseResetReading(value:unknown,accountId:string,now:number) {
 const parsed=readSchema.parse(value);
 if(parsed.accountId!==accountId)throw Error('Reset credit workspace identity mismatch');
 const snapshot:ResetSnapshot={updatedAt:now,availableCount:parsed.rateLimitResetCredits?.availableCount??null,credits:creditDetailsSchema.parse(parsed.rateLimitResetCredits?.credits)??null,ordinaryUsageAllowed:parsed.ordinaryUsageAllowed??null,planType:parsed.rateLimits.planType??null,primary:parsed.rateLimits.primary??{},secondary:parsed.rateLimits.secondary??{}};
 const rows=parsed.rateLimitResetCredits?.credits;
 return {snapshot,credits:Array.isArray(rows)?rows as unknown[]:[]};
}
/** Counts authorize availability; potentially capped detail rows only rank it.
 * Never confuse credit expiry (seconds) with a quota window's scheduled reset. */
function firstExpiringCredit(rows:unknown[],now:number):{creditId?:string;expiresAt:number} {
 const ids=rows.map(row=>z.object({id:creditIdSchema}).safeParse(row));
 const counts=new Map<string,number>();
 for(const id of ids)if(id.success)counts.set(id.data.id,(counts.get(id.data.id)??0)+1);
 let best:{creditId?:string;expiresAt:number}={expiresAt:Infinity};
 for(const row of rows){
  const parsed=creditSchema.safeParse(row);
  if(!parsed.success||counts.get(parsed.data.id)!==1)continue;
  const credit=parsed.data;
  if(typeof credit.expiresAt==='number'&&credit.expiresAt<=now/1000)continue;
  const expiresAt=credit.expiresAt??Infinity;
  if(best.creditId===undefined||expiresAt<best.expiresAt)best={creditId:credit.id,expiresAt};
 }
 return best;
}
export function resetSnapshotQuota(snapshot:ResetSnapshot):QuotaCacheEntry {
 // A bogus resetsAt must not read as a window that never resets.
 const resetAtMs=(s:number|null|undefined)=>typeof s==='number'&&Number.isFinite(s)?Math.min(s*1000,snapshot.updatedAt+MAX_RATE_LIMIT_DELAY_MS):undefined;
 const window=(w:ResetSnapshot['primary'])=>({usedPercent:w.usedPercent,resetAtMs:resetAtMs(w.resetsAt),windowMinutes:w.windowDurationMins??undefined});
 return {updatedAt:snapshot.updatedAt,status:200,model:'usage-read',ordinaryUsageAllowed:snapshot.ordinaryUsageAllowed,planType:snapshot.planType??undefined,primary:window(snapshot.primary),secondary:window(snapshot.secondary)};
}
export function isResetSubscription(snapshot:ResetSnapshot):boolean {
 return ['plus','pro','promax','prolite','team','business','self_serve_business_prolite','enterprise','edu','edu_plus','edu_pro'].includes(snapshot.planType??'');
}
export interface ResetCreditIO {
 /** creditDetails asks the backend for per-credit rows; display refreshes and credit selection need them. */
 read:(target:ResetTarget,options:{creditDetails:boolean})=>Promise<unknown>;
 consume:(target:ResetTarget,idempotencyKey:string,creditId?:string)=>Promise<unknown>;
 now?:()=>number;
}
/** No credentials or credit lists are persisted (snapshot credit rows keep only expiry
 * and title). Only an explicitly selected credit ID accompanies its pending idempotency
 * key until completion. One global lease prevents concurrent exhausted requests from
 * independently spending. */
/** A stored time further ahead than this came from a clock that has since stepped back: treat it as expired. */
const FUTURE_SKEW_MS=5*60000;
const within=(at:number|undefined,now:number,windowMs:number)=>at!==undefined&&at<=now+FUTURE_SKEW_MS&&now-at<windowMs;
function validExhaustionEvidence(targets:ResetTarget[],proof:ResetExhaustionEvidence,now:number):boolean {
 return targets.some(target=>target.key===proof.key&&target.accountId===proof.accountId)&&
  Number.isFinite(proof.observedAt)&&proof.observedAt<=now&&now-proof.observedAt<=60000;
}
function hasNewExhaustion(state:State,targets:ResetTarget[],evidence:ResetExhaustionEvidence[],now:number):boolean {
 return evidence.some(proof=>{
  const snapshot=state.snapshots[proof.key];
  return validExhaustionEvidence(targets,proof,now)&&
   state.lastAutomaticCheckAt!==undefined&&proof.observedAt>state.lastAutomaticCheckAt&&
   snapshot?.ordinaryUsageAllowed===true&&Number.isFinite(snapshot.updatedAt)&&
   snapshot.updatedAt<=now&&proof.observedAt>snapshot.updatedAt;
 });
}
type AutomaticResult={key:string;outcome:ResetOutcome}|null;
interface AutomaticCheck {
 targets:string;
 accepting:boolean;
 evidence:Map<string,ResetExhaustionEvidence>;
 version:number;
 promise:Promise<AutomaticResult>;
}
const automaticChecks = new Map<string,AutomaticCheck>();
// Stop even if failures keep advancing. New evidence after the final pass can
// be retried by a later request; no batch can hold callers indefinitely.
const MAX_AUTOMATIC_CHECK_PASSES=3;
function mergeExhaustionEvidence(check:AutomaticCheck,targets:ResetTarget[],evidence:ResetExhaustionEvidence[],now:number):void {
 for(const proof of evidence){
  if(!validExhaustionEvidence(targets,proof,now))continue;
  const key=JSON.stringify([proof.key,proof.accountId]), previous=check.evidence.get(key);
  if(previous&&previous.observedAt>=proof.observedAt)continue;
  check.evidence.set(key,{key:proof.key,accountId:proof.accountId,observedAt:proof.observedAt});
  check.version++;
 }
}
export class ResetCreditService {
 constructor(private readonly path:string,private readonly io:ResetCreditIO){}
 private now(){return this.io.now?.()??Date.now();}
 async status():Promise<State>{
  try { const stat=await fs.lstat(this.path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid reset-credit state file');return stateSchema.parse(JSON.parse(await fs.readFile(this.path,'utf8'))); }
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {version:1,policy:'manual',snapshots:{}};throw e;}
 }
 private async save(state:State){
  // Older readers strip unknown pending fields. Make them reject an explicit
  // credit attempt instead of retrying its UUID with different parameters.
  // Once durable per-scope receipts exist, old writers must not strip them.
  state.version=state.redemptions ? 3 : state.pending?.creditId===undefined?1:2;
  const path=this.path+'.'+randomUUID()+'.tmp';
  try {
   const file=await fs.open(path,'wx',0o600);
   try {await file.writeFile(JSON.stringify(stateSchema.parse(state))+'\n');await file.sync();} finally {await file.close();}
   await withRetry(()=>fs.rename(path,this.path),{maxAttempts:6,backoffMs:25});
  }
  finally {await fs.rm(path,{force:true});}
 }
 async setPolicy(policy:State['policy']){await withFileTransactionLock(this.path,async()=>{const s=await this.status();s.policy=policy;await this.save(s);});}
 private async readDetails(target:ResetTarget,creditDetails:boolean){return parseResetReading(await this.io.read(target,{creditDetails}),target.accountId,this.now());}
 private async read(target:ResetTarget,creditDetails=false){return (await this.readDetails(target,creditDetails)).snapshot;}
 async refresh(targets:ResetTarget[]):Promise<Record<string,ResetSnapshot>>{
  const results=await mapWithConcurrency(targets,3,async t=>{try{return {key:t.key,snapshot:await this.read(t,true)}}catch{return null}});
  return withFileTransactionLock(this.path,async()=>{const state=await this.status();const updated:Record<string,ResetSnapshot>={};const now=this.now();for(const row of results)if(row){const old=state.snapshots[row.key];if(!old||old.updatedAt<=row.snapshot.updatedAt||old.updatedAt>now+FUTURE_SKEW_MS)state.snapshots[row.key]=row.snapshot;updated[row.key]=row.snapshot;}await this.save(state);return updated;});
 }
 private async consumeLocked(state:State,target:ResetTarget,automatic=false,creditId?:string):Promise<ResetOutcome>{
  if(state.pending&&state.pending.key!==target.key)throw Error('A reset redemption is pending for another account; retry that account explicitly first.');
  state.pending??={key:target.key,idempotencyKey:randomUUID(),...(creditId===undefined?{}:{creditId})};
  state.lastRedemptionAt=this.now();await this.save(state);
  const result=outcomeSchema.parse(await this.io.consume(target,state.pending.idempotencyKey,state.pending.creditId));
  // Keep the same key on *any* ambiguous outcome, including a failed follow-up read.
  state.snapshots[target.key]=await this.read(target);
  const receipts=state.redemptions??={};
  const legacy=state.lastRedemption;
  if(legacy && !receipts[legacy.key] && (legacy.outcome==='reset'||legacy.outcome==='alreadyRedeemed'))receipts[legacy.key]=legacy;
  const generation=1+Object.values(receipts).reduce((maximum,receipt)=>Math.max(maximum,receipt.generation??0),state.redemptionGeneration??0);
  state.redemptionGeneration=generation;
  state.lastRedemption={key:target.key,at:this.now(),outcome:result.outcome,automatic,generation};
  if(result.outcome==='reset'||result.outcome==='alreadyRedeemed')receipts[target.key]=state.lastRedemption;
  delete state.pending;await this.save(state);return result.outcome;
 }
 async redeem(target:ResetTarget):Promise<ResetOutcome>{
  return withFileTransactionLock(this.path,async()=>{
   const state=await this.status();
   if(!state.pending&&within(state.lastRedemptionAt,this.now(),10000))throw Error('A reset was just redeemed; refresh usage before trying again.');
   if(!state.pending){const snapshot=await this.read(target);state.snapshots[target.key]=snapshot;await this.save(state);if(snapshot.availableCount===null)throw Error('Reset-credit availability is unknown');if(snapshot.availableCount===0)return 'noCredit';}
   return this.consumeLocked(state,target);
  });
 }
 automatic(targets:ResetTarget[],evidence:ResetExhaustionEvidence[]=[]):Promise<AutomaticResult>{
  const key=resolve(this.path), signature=JSON.stringify(targets), pending=automaticChecks.get(key);
  if(pending?.accepting){
   if(pending.targets!==signature)return pending.promise.then(()=>null);
   mergeExhaustionEvidence(pending,targets,evidence,this.now());
   return pending.promise;
  }
  if(automaticChecks.size>=1000)return Promise.resolve(null);
  const currentTargets=targets.map(target=>({key:target.key,accountId:target.accountId}));
  const check:AutomaticCheck={targets:signature,accepting:true,evidence:new Map(),version:0,promise:Promise.resolve(null)};
  mergeExhaustionEvidence(check,currentTargets,evidence,this.now());
  check.promise=this.automaticBatch(currentTargets,check).finally(()=>{
   if(automaticChecks.get(key)===check)automaticChecks.delete(key);
  });
  automaticChecks.set(key,check);
  return check.promise;
 }
 private async automaticBatch(targets:ResetTarget[],check:AutomaticCheck):Promise<AutomaticResult>{
  try {
   for(let pass=0;pass<MAX_AUTOMATIC_CHECK_PASSES;pass++){
    const version=check.version;
    const result=await this.automaticLocked(targets,[...check.evidence.values()]);
    if(result!==null||check.version===version)return result;
   }
   return null;
  } finally {
   // Close admission before resolving: a late caller must not append evidence
   // between batch completion and the outer promise's map cleanup.
   check.accepting=false;
  }
 }
 private async automaticLocked(targets:ResetTarget[],evidence:ResetExhaustionEvidence[]):Promise<{key:string;outcome:ResetOutcome}|null>{
  if(!targets.length||(await this.status()).policy!=='last-resort')return null;
  return withFileTransactionLock(this.path,async()=>{
   const state=await this.status();
   const now=this.now();
   if(state.policy!=='last-resort'||state.pending||within(state.lastRedemptionAt,now,300000))return null;
   if(within(state.lastAutomaticCheckAt,now,60000)&&!hasNewExhaustion(state,targets,evidence,now))return null;
   state.lastAutomaticCheckAt=now;await this.save(state);
   // Missing/failed reads prevent spending. A scheduled reset that has arrived
   // is confirmed by ordinaryUsageAllowed, never inferred from a clock or %.
   const details=await mapWithConcurrency(targets,3,async t=>{try{return await this.readDetails(t,true)}catch{return null}});
   const reads=details.map(row=>row?.snapshot??null);
   reads.forEach((s,i)=>{const t=targets[i];if(s&&t)state.snapshots[t.key]=s;});await this.save(state);
   if(reads.some(s=>!s||!isResetSubscription(s)||s.ordinaryUsageAllowed!==false))return null;
   if(reads.some(s=>s&&[s.primary,s.secondary].some(w=>w.usedPercent===100&&typeof w.resetsAt==='number'&&w.resetsAt*1000<=this.now()+60000)))return null;
   let best:{target:ResetTarget;creditId?:string;expiresAt:number}|undefined;
   for(const [index,row] of details.entries()){
    const target=targets[index];
    if(!row||!target||(row.snapshot.availableCount??0)<=0)continue;
    const credit=firstExpiringCredit(row.credits,this.now());
    // Stable ties retain the caller's preferred-account/priority ordering.
    // Unknown, omitted and nonexpiring details follow all known deadlines.
    if(!best||credit.expiresAt<best.expiresAt)best={target,...credit};
   }
   if(!best)return null;
   return {key:best.target.key,outcome:await this.consumeLocked(state,best.target,true,best.creditId)};
  },{waitMs:1000});
 }
}
