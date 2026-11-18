import { apiBaseUrl } from "../api-region.js";
import {createHash} from "node:crypto";
import {promises as fs} from "node:fs";
import {dirname,join} from "node:path";
import {z} from "zod";
import {loadApiRoutes,updateApiModelDiscovery,ensureApiRouteCapabilityEpoch,type ApiRouteCredential} from "../api-route-store.js";
import {getCodexMultiAuthDir} from "../runtime-paths.js";
import {withFileTransactionLock} from "../storage/file-lock.js";
import {tempPathFor} from "../temp-path.js";
import {withRetry} from "../fs-retry.js";
import {combineSignals} from "../utils.js";
import {logWarn} from "../logger.js";
import {discoverModelInventory,saveModelInventory} from "./model-discovery-status.js";
export const AUTOMATIC_API_CHECK_INTERVAL_MS=24*60*60_000;
const PREPARATION_RETRY_MS=60_000;
const schema=z.record(z.string().regex(/^[a-f0-9]{64}$/),z.number().finite().nonnegative());
const retry={maxAttempts:6,backoffMs:25};
function key(route:ApiRouteCredential){return createHash("sha256").update(JSON.stringify([route.id,route.kind,route.apiKey,...(route.region === "us" ? [apiBaseUrl(route)] : []),route.visibleModels])).digest("hex");}
const eligible=(route:ApiRouteCredential)=>route.enabled&&route.probeCapabilities===true;
// Visibility can expand during discovery; daily spending remains credential-scoped.
function claimKey(route:ApiRouteCredential){return createHash("sha256").update(JSON.stringify([route.id,route.kind,route.apiKey,...(route.region === "us" ? [apiBaseUrl(route)] : [])])).digest("hex");}
// Compare visibility as a set without changing stored order or legacy claim hashes.
function semanticRoute(route:ApiRouteCredential){return {...route,visibleModels:[...new Set(route.visibleModels)].sort()};}
function sameRoute(a:ApiRouteCredential,b:ApiRouteCredential){return JSON.stringify(Object.entries(semanticRoute(a)).sort(([x],[y])=>x.localeCompare(y)))===JSON.stringify(Object.entries(semanticRoute(b)).sort(([x],[y])=>x.localeCompare(y)));}

export async function runAutomaticApiChecks(options:{path:string;loadRoutes:()=>Promise<ApiRouteCredential[]>;prepareRoute?:(route:ApiRouteCredential,signal:AbortSignal)=>Promise<ApiRouteCredential|undefined>;check:(route:ApiRouteCredential,signal:AbortSignal,programRefreshBefore:number)=>Promise<void>;now?:()=>number;signal?:AbortSignal}){
 const signal=options.signal??new AbortController().signal;
 // Claims name the scheduled pass, so I/O and later routes cannot move its horizon.
 const startedAt=options.now?.()??Date.now();
 let nextRunAt:number|undefined;
 const includeDeadline=(at:number)=>{nextRunAt=Math.min(nextRunAt??Infinity,at+AUTOMATIC_API_CHECK_INTERVAL_MS);};
 if(signal.aborted)return;
 const routes=(await options.loadRoutes()).filter(eligible);
 if(!routes.length)return;
 for(const route of routes){
  if(signal.aborted)return;
  const observed=(await options.loadRoutes()).find(r=>eligible(r)&&key(semanticRoute(r))===key(semanticRoute(route)));
  if(!observed)continue;
  // Complete store-owned migrations before capturing the exact claim snapshot.
  let current:ApiRouteCredential|undefined;
  try{current=options.prepareRoute?await options.prepareRoute(observed,signal):observed;}
  catch{if(signal.aborted)return;nextRunAt=Math.min(nextRunAt??Infinity,(options.now?.()??Date.now())+PREPARATION_RETRY_MS);logWarn("Automatic API route preparation failed; retrying shortly.");continue;}
  if(!current||!eligible(current)||signal.aborted)continue;
  // Commit the claim before network I/O. Concurrent routers and restarts share it.
  let programRefreshBefore=startedAt+AUTOMATIC_API_CHECK_INTERVAL_MS;
  const claimed=await withFileTransactionLock(options.path,async()=>{
   // A credential wipe can finish while this checker is queued for the lock.
   if(signal.aborted||!(await options.loadRoutes()).some(r=>eligible(r)&&sameRoute(r,current)))return false;
   let attempts:Record<string,number>={};
   let raw:string|undefined,repairHistory=false;
   try{raw=await withRetry(()=>fs.readFile(options.path,"utf8"),retry);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   if(raw!==undefined)try{if(Buffer.byteLength(raw)>1024*1024)throw Error("API-check history too large");attempts=schema.parse(JSON.parse(raw));}catch{repairHistory=true;}
   const now=options.now?.()??Date.now(),id=claimKey(current);
   // Unknown prior attempts must not trigger another billable pass on repair.
   // Seed every eligible route so a restart can resume normally the next day.
   if(repairHistory)attempts=Object.fromEntries((await options.loadRoutes()).filter(eligible).map(route=>[claimKey(route),now]));
   const legacyClaims=[attempts[key(current)],attempts[key(observed)],attempts[key(route)]].filter((at):at is number=>at!==undefined&&Number.isFinite(at)&&at<=now+300_000);
   const last=attempts[id] ?? (legacyClaims.length?Math.max(...legacyClaims):undefined);
   if(signal.aborted)return false;
   if(!repairHistory&&last!==undefined&&last<=now+300_000&&now-last<AUTOMATIC_API_CHECK_INTERVAL_MS){includeDeadline(last);return false;}
   // Keep other processes' claims; prune only the oldest history at a fixed bound.
   for(const [old] of Object.entries(attempts).sort((a,b)=>b[1]-a[1]).slice(999))delete attempts[old];
   const claimedAt=repairHistory?now:Math.min(startedAt,now);
   attempts[id]=claimedAt;programRefreshBefore=claimedAt+AUTOMATIC_API_CHECK_INTERVAL_MS;
   includeDeadline(claimedAt);const temp=tempPathFor(options.path);
   await fs.mkdir(dirname(options.path),{recursive:true,mode:0o700});
   try{await fs.writeFile(temp,JSON.stringify(attempts)+"\n",{mode:0o600,flag:"wx"});await withRetry(()=>fs.rename(temp,options.path),retry);}finally{await withRetry(()=>fs.rm(temp,{force:true}),retry);}
   if(repairHistory)logWarn("Automatic API check history repaired; billable checks deferred for one daily interval.");
   return !repairHistory;
  },{signal});
  if(!claimed||signal.aborted)continue;
  try{await options.check(current,signal,programRefreshBefore);}catch{if(!signal.aborted)logWarn("Automatic API capability check failed; retry deferred until the next daily interval.");}
 }
 return nextRunAt;
}
export function createAutomaticApiCheck(upstreamFetch:typeof fetch=fetch){return async(signal:AbortSignal)=>{
 return runAutomaticApiChecks({
 path:join(getCodexMultiAuthDir(),"automatic-api-checks.json"),loadRoutes:loadApiRoutes,signal,prepareRoute:ensureApiRouteCapabilityEpoch,
 check:async(route,stop,programRefreshBefore)=>{
  let acceptedRoute=route, discoveryAccepted=true;
  const updateDiscovery:typeof updateApiModelDiscovery=async(original,models)=>{
   discoveryAccepted=false;
   const known=new Set(original.knownModels??models),visible=new Set(original.visibleModels);
   for(const model of models){if(!known.has(model)&&/^gpt-/i.test(model))visible.add(model);known.add(model);}
   const expected={...original,knownModels:[...known],visibleModels:[...visible]};
   const updated=await updateApiModelDiscovery(original,models);
   // Accept this discovery's expansion only, never a concurrent policy edit.
   if(!sameRoute(updated,expected))throw Error("API check route changed");
   acceptedRoute=updated;discoveryAccepted=true;return updated;
  };
  // Link shutdown to each existing bounded request without weakening its timeout.
  const fetcher:typeof fetch=async(input,init)=>{
   const signal=combineSignals(stop,init?.signal);
   signal.throwIfAborted();
   if(init?.method?.toUpperCase()==="POST" && (!discoveryAccepted || !(await loadApiRoutes()).some(r=>eligible(r)&&sameRoute(r,acceptedRoute))))throw Error("API check route changed");
   signal.throwIfAborted();
   return upstreamFetch(input,{...init,signal});
  };
  const inventory=await discoverModelInventory(null,[route],{fetchImpl:fetcher,signal:stop,persistProbes:true,programRefreshBefore,updateApiDiscovery:updateDiscovery});
  if(stop.aborted||!discoveryAccepted)return;
  const current=(await loadApiRoutes()).find(r=>eligible(r)&&sameRoute(r,acceptedRoute));
  if(current)await saveModelInventory(inventory,{mergeEntries:true,signal:stop});
 },
});};}
/** Daily checks follow persisted claim deadlines, never overlap, and drain on shutdown. */
export function startAutomaticApiChecks(run:(signal:AbortSignal)=>Promise<number|void>){
 const controller=new AbortController();let pending:Promise<void>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
 const schedule=(delay:number)=>{if(!controller.signal.aborted){timer=setTimeout(tick,delay);timer.unref();}};
 const tick=()=>{
  timer=undefined;if(controller.signal.aborted)return;
  let nextRunAt=Date.now()+AUTOMATIC_API_CHECK_INTERVAL_MS;
  pending=Promise.resolve().then(()=>run(controller.signal)).then(due=>{if(typeof due==="number"&&Number.isFinite(due))nextRunAt=due;})
   .catch(()=>{if(!controller.signal.aborted)logWarn("Automatic API capability checks unavailable; retry deferred.");})
   .finally(()=>{pending=undefined;schedule(Math.min(AUTOMATIC_API_CHECK_INTERVAL_MS,Math.max(0,nextRunAt-Date.now())));});
 };
 schedule(5000);return{async stop(){clearTimeout(timer);controller.abort();await pending;}};
}
