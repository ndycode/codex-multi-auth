import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {promises as fs} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {getCodexMultiAuthDir} from "../lib/runtime-paths.js";
import {saveInferenceRequestTime,loadInferenceRequestTimes} from "../lib/runtime/inference-activity.js";
// Each test owns its multi-auth directory: never the shared runtime-observability.json.
let previousDir: string | undefined;
let testDir: string;
beforeEach(async()=>{
 previousDir=process.env.CODEX_MULTI_AUTH_DIR;
 testDir=await fs.mkdtemp(join(tmpdir(),"inference-activity-"));
 process.env.CODEX_MULTI_AUTH_DIR=testDir;
});
afterEach(async()=>{
 if(previousDir===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previousDir;
 await fs.rm(testDir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
});
it("retains inference times when another process overwrites diagnostic telemetry",async()=>{
 const key=`sha256:${"a".repeat(64)}`;
 await saveInferenceRequestTime(key,2000);
 await fs.writeFile(join(getCodexMultiAuthDir(),"runtime-observability.json"),JSON.stringify({lastInferenceRequestAtByAccount:{[key]:100}}));
 expect((await loadInferenceRequestTimes([key]))[key]).toBe(2000);
 await saveInferenceRequestTime(key,1000);
 expect((await loadInferenceRequestTimes([key]))[key]).toBe(2000);
 const path=join(getCodexMultiAuthDir(),"inference-activity",`${"a".repeat(64)}.json`);
 if(process.platform!=="win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
});
it("rejects unsafe keys and malformed timestamp files",async()=>{
 await saveInferenceRequestTime("../../outside",100);
 expect(await loadInferenceRequestTimes(["../../outside"])).toEqual({});
 const key=`sha256:${"b".repeat(64)}`;
 await saveInferenceRequestTime(key,3000);
 await fs.writeFile(join(getCodexMultiAuthDir(),"inference-activity",`${"b".repeat(64)}.json`),"x".repeat(1000));
 expect(await loadInferenceRequestTimes([key])).toEqual({});
});

it("keeps distinct logins separate even when they share a workspace account ID",async()=>{
 const {inferenceAccountKey}=await import("../lib/runtime/inference-activity.js");
 expect(inferenceAccountKey({accountId:"shared",email:"one@example.com"})).not.toBe(inferenceAccountKey({accountId:"shared",email:"two@example.com"}));
 expect(inferenceAccountKey({accountId:"shared",email:"ONE@example.com"})).toBe(inferenceAccountKey({accountId:"shared",email:"one@example.com"}));
});

it("coalesces per-request inference times into one debounced write per key",async()=>{
 vi.useFakeTimers();
 try {
  const {createInferenceActivityWriter}=await import("../lib/runtime/inference-activity.js");
  const save=vi.fn(async()=>undefined);
  const writer=createInferenceActivityWriter(save,1000);
  const a=`sha256:${"c".repeat(64)}`,b=`sha256:${"d".repeat(64)}`;
  for(let i=1;i<=100;i++)writer.record(a,i);
  for(let i=1;i<=50;i++)writer.record(b,1000-i);
  writer.record("../../outside",5);
  expect(save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(save.mock.calls).toEqual([[a,100],[b,999]]);
  writer.record(a,200);
  await writer.flush();
  expect(save).toHaveBeenLastCalledWith(a,200);
  expect(save).toHaveBeenCalledTimes(3);
 } finally {vi.useRealTimers();}
});

it("keeps the newest time when two writers of the same key interleave",async()=>{
 const {readFileSync}=await import("node:fs");
 const key=`sha256:${"e".repeat(64)}`;
 const gate=()=>{let open!:()=>void;const promise=new Promise<void>(r=>{open=r;});return {open,wait:(ms:number)=>Promise.race([promise,new Promise<void>(r=>setTimeout(r,ms))])};};
 const olderWritten=gate(),newerRenamed=gate();
 const realRename=fs.rename.bind(fs),realWrite=fs.writeFile.bind(fs);
 const write=vi.spyOn(fs,"writeFile").mockImplementation(async(...args:Parameters<typeof fs.writeFile>)=>{
  await realWrite(...args);
  if(String(args[1]).trim()==="1500")olderWritten.open();
 });
 const rename=vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{
  let value="";try{value=readFileSync(from,"utf8").trim();}catch{/* lock directories */}
  // Without a lock both writers read before either renames; force the newer rename first.
  if(value==="2000")await olderWritten.wait(300);
  if(value==="1500")await newerRenamed.wait(300);
  await realRename(from,to);
  if(value==="2000")newerRenamed.open();
 });
 try {
  await Promise.all([saveInferenceRequestTime(key,2000),saveInferenceRequestTime(key,1500)]);
 } finally {write.mockRestore();rename.mockRestore();}
 expect((await loadInferenceRequestTimes([key]))[key]).toBe(2000);
});
