import { createHash } from "node:crypto";
import { getAccountIdentityKey } from "../storage/identity.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { tempPathFor } from "../temp-path.js";
import { withRetry } from "../fs-retry.js";
import { withFileTransactionLock } from "../storage/file-lock.js";
import { mapWithConcurrency } from "../concurrency.js";

export function inferenceAccountKey(account: Parameters<typeof getAccountIdentityKey>[0]): string {
 return `sha256:${createHash("sha256").update(getAccountIdentityKey(account) ?? "unknown").digest("hex")}`;
}

const validKey = (key: string) => /^sha256:[a-f0-9]{64}$/.test(key);
function activityPath(key: string): string {
 return join(getCodexMultiAuthDir(), "inference-activity", `${key.slice(7)}.json`);
}
async function readTimestamp(key: string): Promise<number | null> {
 try {
  const handle=await fs.open(activityPath(key),"r");
  try {
   const bytes=Buffer.alloc(64);
   const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
   if(bytesRead===bytes.length)return null;
   const value:unknown=JSON.parse(bytes.subarray(0,bytesRead).toString("utf8"));
   return typeof value==="number" && Number.isFinite(value) && value>0 ? value : null;
  } finally {await handle.close();}
 } catch {return null;}
}

/** Separate from shared diagnostic snapshots: only inference dispatches write these files. */
export async function saveInferenceRequestTime(key: string, at: number): Promise<void> {
 if(!validKey(key) || !Number.isFinite(at) || at<=0) return;
 const path=activityPath(key);
 await fs.mkdir(join(getCodexMultiAuthDir(),"inference-activity"),{recursive:true,mode:0o700});
 // Read-max-write under the cross-process lock, so a concurrent writer (app
 // router and a wrapper proxy) cannot replace a newer time with an older one.
 await withFileTransactionLock(path, async () => {
  const temp=tempPathFor(path);
  const timestamp=Math.max(at,await readTimestamp(key) ?? 0);
  try {
   await fs.writeFile(temp,JSON.stringify(timestamp)+"\n",{mode:0o600,flag:"wx"});
   await withRetry(()=>fs.rename(temp,path),{maxAttempts:6,backoffMs:25});
  } finally {
   await withRetry(()=>fs.unlink(temp),{maxAttempts:6,backoffMs:25}).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
  }
 });
}
/**
 * Per-request dispatches only need the latest time per key on disk. Keep the
 * newest pending time per key and write them together after a short debounce,
 * instead of chaining one mkdir/read/write/rename per request.
 */
export function createInferenceActivityWriter(
 save: (key: string, at: number) => Promise<void> = saveInferenceRequestTime,
 delayMs = 1000,
 onError: (error: unknown) => void = () => undefined,
): { record(key: string, at: number): void; flush(): Promise<void> } {
 const pending = new Map<string, number>();
 let timer: ReturnType<typeof setTimeout> | undefined;
 let flushing: Promise<void> = Promise.resolve();
 const flush = (): Promise<void> => {
  if (timer) { clearTimeout(timer); timer = undefined; }
  const batch = [...pending];
  pending.clear();
  flushing = flushing.then(async () => {
   for (const [key, at] of batch) await save(key, at).catch(onError);
  });
  return flushing;
 };
 return {
  record(key, at) {
   if (!validKey(key) || !Number.isFinite(at) || at <= 0) return;
   pending.set(key, Math.max(pending.get(key) ?? 0, at));
   if (!timer) {
    timer = setTimeout(() => void flush(), delayMs);
    timer.unref?.();
   }
  },
  flush,
 };
}
export async function loadInferenceRequestTimes(keys: string[]): Promise<Record<string, number>> {
 const entries=await mapWithConcurrency([...new Set(keys)].filter(validKey).slice(0,1000),4,async key=>({key,at:await readTimestamp(key)}));
 return Object.fromEntries(entries.flatMap(entry=>entry.at===null?[]:[[entry.key,entry.at]]));
}
