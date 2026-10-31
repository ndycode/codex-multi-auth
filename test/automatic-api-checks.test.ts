import {createHash} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {promises as fs} from "node:fs";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {removeWithRetry} from "./helpers/remove-with-retry.js";
import {runAutomaticApiChecks,startAutomaticApiChecks,AUTOMATIC_API_CHECK_INTERVAL_MS} from "../lib/runtime/automatic-api-checks.js";
import type {ApiRouteCredential} from "../lib/api-route-store.js";
const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();for(const root of roots.splice(0))await removeWithRetry(root,{recursive:true,force:true});});
const route=(id:string, enabled=true,probeCapabilities=true):ApiRouteCredential=>({id,label:id,kind:"api",apiKey:`secret-${id}`,enabled,probeCapabilities,priority:0,visibleModels:["chat-test"]});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"api-checks-"));roots.push(root);return join(root,"attempts.json");}
it("checks only opted-in enabled routes once per day, including competing runners",async()=>{
 const path=await fixture(),routes=[route("on"),route("off",false),route("no",true,false)],check=vi.fn(async()=>{});
 const options={path,loadRoutes:async()=>routes,check,now:()=>1000};
 await Promise.all([runAutomaticApiChecks(options),runAutomaticApiChecks(options)]);
 expect(check).toHaveBeenCalledTimes(1);expect(check.mock.calls[0]?.[0]).toEqual(routes[0]);
 expect(await readFile(path,"utf8")).not.toContain("secret");
 await runAutomaticApiChecks({...options,now:()=>1000+AUTOMATIC_API_CHECK_INTERVAL_MS});expect(check).toHaveBeenCalledTimes(2);
});
it("records failed attempts before requests",async()=>{
 const path=await fixture(),check=vi.fn(async()=>{throw Error("fixture");}),options={path,loadRoutes:async()=>[route("on")],check,now:()=>1000};
 await runAutomaticApiChecks(options);await runAutomaticApiChecks(options);expect(check).toHaveBeenCalledTimes(1);
});
it("defers startup, prevents overlap, and aborts/drains on stop",async()=>{
 vi.useFakeTimers();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let signal:AbortSignal|undefined;
 const run=vi.fn(async(s:AbortSignal)=>{signal=s;await gate;});const scheduler=startAutomaticApiChecks(run);
 expect(run).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(5000);expect(run).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(AUTOMATIC_API_CHECK_INTERVAL_MS*2);expect(run).toHaveBeenCalledTimes(1);
 const stop=scheduler.stop();expect(signal?.aborted).toBe(true);release();await stop;
 await vi.advanceTimersByTimeAsync(AUTOMATIC_API_CHECK_INTERVAL_MS*2);expect(run).toHaveBeenCalledTimes(1);
});

it("checks changed credentials and skips routes disabled before their turn",async()=>{
 const path=await fixture();let routes=[route("first"),route("second")];
 const check=vi.fn(async(r:ApiRouteCredential)=>{if(r.id==="first")routes=routes.map(x=>x.id==="second"?{...x,enabled:false}:x);});
 const options={path,loadRoutes:async()=>routes,check,now:()=>1000};
 await runAutomaticApiChecks(options);expect(check).toHaveBeenCalledTimes(1);
 routes=routes.map(x=>({...x,apiKey:x.apiKey+"-rotated"}));
 await runAutomaticApiChecks(options);expect(check).toHaveBeenCalledTimes(2);
});
it("schedules the next daily check after a failure finishes",async()=>{
 vi.useFakeTimers();const run=vi.fn(async()=>{throw Error("fixture");});const scheduler=startAutomaticApiChecks(run);
 try{await vi.advanceTimersByTimeAsync(5000);expect(run).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(AUTOMATIC_API_CHECK_INTERVAL_MS-1);expect(run).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(run).toHaveBeenCalledTimes(2);}finally{await scheduler.stop();}
});

it("revalidates opt-in immediately before each POST and keeps shutdown linked to response bodies",async()=>{
 const api=await import("../lib/api-route-store.js"),discovery=await import("../lib/runtime/model-discovery-status.js");
 const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 let enabled=true;const credential=route("before-post");const controller=new AbortController();let observed:AbortSignal|null|undefined;
 const load=vi.spyOn(api,"loadApiRoutes").mockImplementation(async()=>[{...credential,enabled}]);
 const prepare=vi.spyOn(api,"ensureApiRouteCapabilityEpoch").mockResolvedValue(credential);
 const network=vi.spyOn(globalThis,"fetch").mockImplementation(async(_input,init)=>{observed=init?.signal;return new Response("ok");});
 const save=vi.spyOn(discovery,"saveModelInventory").mockResolvedValue();
 const discover=vi.spyOn(discovery,"discoverModelInventory").mockImplementation(async(storage,routes,options)=>{
  expect(storage).toBeNull();expect(routes).toEqual([credential]);expect(options?.forceProbes).toBeUndefined();
  await options!.fetchImpl!("https://api.example/responses",{method:"POST"});
  enabled=false;
  await expect(options!.fetchImpl!("https://api.example/responses",{method:"POST"})).rejects.toThrow("route changed");
  controller.abort();expect(observed?.aborted).toBe(true);
  return {version:1,checkedAt:1000,entries:[]};
 });
 try{await createAutomaticApiCheck()(controller.signal);expect(network).toHaveBeenCalledTimes(1);expect(save).not.toHaveBeenCalled();}finally{prepare.mockRestore();load.mockRestore();network.mockRestore();save.mockRestore();discover.mockRestore();}
});


it.each(["not-json", JSON.stringify({oldFormat:true})])("repairs corrupt history without an immediate duplicate billable pass: %s",async(raw)=>{
 const path=await fixture(),routes=[route("one"),route("two")],check=vi.fn(async()=>{});
 await writeFile(path,raw);
 const options={path,loadRoutes:async()=>routes,check,now:()=>1000};
 await Promise.all([runAutomaticApiChecks(options),runAutomaticApiChecks(options)]);
 expect(check).not.toHaveBeenCalled();
 const repaired=JSON.parse(await readFile(path,"utf8"));expect(Object.keys(repaired)).toHaveLength(2);expect(Object.values(repaired)).toEqual([1000,1000]);
 expect(JSON.stringify(repaired)).not.toContain("secret");
 await Promise.all([runAutomaticApiChecks({...options,now:()=>1000+AUTOMATIC_API_CHECK_INTERVAL_MS}),runAutomaticApiChecks({...options,now:()=>1000+AUTOMATIC_API_CHECK_INTERVAL_MS})]);
 expect(check).toHaveBeenCalledTimes(2);
});
it("does not replace an unreadable history or send probes",async()=>{
 const path=await fixture(),original=fs.readFile,check=vi.fn(async()=>{});
 await writeFile(path,"preserve unreadable history");
 const read=vi.spyOn(fs,"readFile").mockImplementation(((file,...args)=>String(file)===path?Promise.reject(Object.assign(Error("denied"),{code:"EACCES"})):original(file,...args)) as typeof fs.readFile);
 try{await expect(runAutomaticApiChecks({path,loadRoutes:async()=>[route("one")],check})).rejects.toMatchObject({code:"EACCES"});expect(check).not.toHaveBeenCalled();}finally{read.mockRestore();}
 expect(await readFile(path,"utf8")).toBe("preserve unreadable history");
});

it("includes newly enabled routes when repairing history under the lock",async()=>{
 const path=await fixture(),one=route("one"),two=route("two"),check=vi.fn(async()=>{});
 await writeFile(path,"corrupt");let loads=0;
 const options={path,loadRoutes:async()=>++loads===1?[one]:[one,two],check,now:()=>1000};
 await runAutomaticApiChecks(options);await runAutomaticApiChecks(options);
 expect(check).not.toHaveBeenCalled();
 expect(Object.keys(JSON.parse(await readFile(path,"utf8")))).toHaveLength(2);
});

it("probes newly discovered visible models and saves their inventory without repeating after restart",async()=>{
 const api=await import("../lib/api-route-store.js"),discovery=await import("../lib/runtime/model-discovery-status.js");
 const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 const root=await fixture();const previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=join(root,"..");
 let posts=0;const models:string[]=[];
 const network=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  if(init?.method==="POST"){posts++;models.push(JSON.parse(String(init.body)).model);return Response.json({output:[],service_tier:"default"});}
  if(String(input).endsWith("/models"))return Response.json({data:[{id:"gpt-test-old"},{id:"gpt-test-new"}]});
  return new Response("",{status:404});
 });
 try{
  await api.saveApiRoutes([{...route("discover"),visibleModels:["gpt-test-old"],knownModels:["gpt-test-old"]}]);
  await createAutomaticApiCheck()(new AbortController().signal);
  expect(posts).toBeGreaterThan(0);expect(models).toContain("gpt-test-new");
  expect((await api.loadApiRoutes())[0]?.visibleModels).toContain("gpt-test-new");
  expect((await discovery.loadModelInventory())?.entries[0]?.visibleModels).toContain("gpt-test-new");
  const before=posts;await createAutomaticApiCheck()(new AbortController().signal);expect(posts).toBe(before);
 }finally{network.mockRestore();if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;}
});

it("honors the legacy visibility-scoped daily claim",async()=>{
 const path=await fixture(),credential=route("legacy"),check=vi.fn(async()=>{});
 const oldKey=createHash("sha256").update(JSON.stringify([credential.id,credential.kind,credential.apiKey,credential.visibleModels])).digest("hex");
 await writeFile(path,JSON.stringify({[oldKey]:1000}));
 await runAutomaticApiChecks({path,loadRoutes:async()=>[credential],check,now:()=>2000});expect(check).not.toHaveBeenCalled();
});
it("does not adopt concurrent policy changes returned by discovery",async()=>{
 const api=await import("../lib/api-route-store.js"),discovery=await import("../lib/runtime/model-discovery-status.js");
 const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 const root=await fixture(),previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=join(root,"..");
 const original=api.updateApiModelDiscovery;let posts=0;
 const network=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{if(init?.method==="POST"){posts++;return Response.json({output:[]});}if(String(input).endsWith("/models"))return Response.json({data:[{id:"gpt-test-new"}]});return new Response("",{status:404});});
 const update=vi.spyOn(api,"updateApiModelDiscovery").mockImplementation(async(route,models)=>{await api.saveApiRoutes([{...route,priority:9}]);return original(route,models);});
 try{await api.saveApiRoutes([{...route("policy-race"),visibleModels:[],knownModels:[]}]);await createAutomaticApiCheck()(new AbortController().signal);expect(posts).toBe(0);expect(await discovery.loadModelInventory()).toBeNull();expect((await api.loadApiRoutes())[0]?.priority).toBe(9);}
 finally{update.mockRestore();network.mockRestore();if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;}
});


it("refreshes expired program evidence before consuming the daily pass despite fresh general probes",async()=>{
 const api=await import("../lib/api-route-store.js"),discovery=await import("../lib/runtime/model-discovery-status.js");
 const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 const path=await fixture(),previous=process.env.CODEX_MULTI_AUTH_DIR;
 process.env.CODEX_MULTI_AUTH_DIR=join(path,"..");
 let now=1000,programPosts=0;
 const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
 const network=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  if(String(input).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(init?.method!=="POST")return new Response("missing",{status:404});
  const body=JSON.parse(String(init.body));
  if(body.access_programs)programPosts++;
  return Response.json({status:"completed",reasoning:body.reasoning,access_programs:body.access_programs});
 });
 try{
  const credential={...route("expiry"),visibleModels:["fixture"],accessPrograms:{cyber:["daybreak_blue"]}};
  await api.saveApiRoutes([credential]);
  const discover=()=>discovery.discoverModelInventory(null,[credential],{persistProbes:true,updateApiDiscovery:api.updateApiModelDiscovery});
  await discover();
  now=AUTOMATIC_API_CHECK_INTERVAL_MS;await discover();
  expect(programPosts).toBe(1);
  now=1001+AUTOMATIC_API_CHECK_INTERVAL_MS;
  await createAutomaticApiCheck()(new AbortController().signal);
  expect(programPosts).toBe(2);
  expect((await discovery.loadModelInventory())?.entries[0]?.entitlements?.[0]?.programCheckedAt).toBe(now);
  await createAutomaticApiCheck()(new AbortController().signal);
  expect(programPosts).toBe(2);
 }finally{clock.mockRestore();network.mockRestore();if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;}
});

it.each([undefined, "EBUSY", "EPERM"])("stops daily discovery and drains owner cleanup with %s", async (cleanupCode) => {
 const {withFileTransactionLock}=await import("../lib/storage/file-lock.js");
 const {saveApiRoutes}=await import("../lib/api-route-store.js");
 const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 const root=await mkdtemp(join(tmpdir(),"daily-lease-stop-"));roots.push(root);
 const previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=root;
 const credential={...route("fixture"),visibleModels:["fixture"],knownModels:["fixture"]};
 const key=createHash("sha256").update(credential.id).update("\0").update(credential.apiKey).update("\0fixture").digest("hex");
 const lease=join(root,"api-probe-locks",key);
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 let posts=0;
 const mock=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  if(init?.method==="POST"){posts++;return Response.json({output:[]});}
  if(String(input).includes("/models"))return Response.json({data:[{id:"fixture"}]});
  return new Response("missing",{status:404});
 });
 const owner=withFileTransactionLock(lease,async()=>{entered();await gate;});await started;
 let cleanupFailures=0;
 const unlink=fs.unlink.bind(fs);
 const unlinkSpy=vi.spyOn(fs,"unlink").mockImplementation(async target=>{
  if(cleanupCode&&!cleanupFailures&&String(target).replace(/\\/g,"/").includes(`${key}.write-lock/`)){
   cleanupFailures++;throw Object.assign(Error("busy cleanup"),{code:cleanupCode});
  }
  return unlink(target);
 });
 let contended=false;
 const rename=fs.rename.bind(fs);
 const renameSpy=vi.spyOn(fs,"rename").mockImplementation(async(from,to)=>{
  try{return await rename(from,to);}catch(error){if(String(to).endsWith(`${key}.write-lock`))contended=true;throw error;}
 });
 let scheduler:ReturnType<typeof startAutomaticApiChecks>|undefined;
 let stopped=false;
 let stop:Promise<void>|undefined;
 try{
  await saveApiRoutes([credential]);
  vi.useFakeTimers();scheduler=startAutomaticApiChecks(createAutomaticApiCheck());await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(()=>expect(contended).toBe(true),{timeout:1000,interval:50});
  stop=scheduler.stop().then(()=>{stopped=true;});
  await vi.waitFor(()=>expect(stopped).toBe(true),{timeout:1000,interval:50});
  expect(posts).toBe(0);
 }finally{
  release();let ownerDrained=false;
  const drainOwner=owner.finally(()=>{ownerDrained=true;});
  try{
   await vi.waitFor(()=>expect(ownerDrained).toBe(true),{timeout:1000,interval:50});await drainOwner;
   stop??=scheduler?.stop().then(()=>{stopped=true;});
   if(stop){await vi.waitFor(()=>expect(stopped).toBe(true),{timeout:1000,interval:50});await stop;}
  }finally{
   vi.useRealTimers();unlinkSpy.mockRestore();renameSpy.mockRestore();mock.mockRestore();
   if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;
  }
 }
 expect(posts).toBe(0);
 expect(cleanupFailures).toBe(cleanupCode?1:0);
 expect((await fs.readdir(join(root,"api-probe-locks"))).filter(name=>name.includes("candidate")||name.endsWith("write-lock"))).toEqual([]);
});

it.each([false, true])("keeps the next tick anchored when a slow run rejects: %s", async (reject) => {
 vi.useFakeTimers();
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const run = vi.fn(async () => { await gate; if (reject) throw Error("fixture"); });
 const scheduler = startAutomaticApiChecks(run);
 try {
  await vi.advanceTimersByTimeAsync(5000);
  await vi.advanceTimersByTimeAsync(60_000);
  release(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(AUTOMATIC_API_CHECK_INTERVAL_MS - 60_000 - 1);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
 } finally { release(); await scheduler.stop(); }
});

it("uses persisted claim deadlines despite slow claim I/O and later routes", async () => {
 const path = await fixture();
 vi.useFakeTimers(); vi.setSystemTime(1000);
 let releaseLoad!: () => void, releaseLater!: () => void;
 const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
 const laterGate = new Promise<void>(resolve => { releaseLater = resolve; });
 let loads = 0, completions = 0;
 const routes = [route("early"), route("later")];
 const check = vi.fn(async (current: ApiRouteCredential, _signal: AbortSignal, _horizon: number) => { if (current.id === "later") await laterGate; });
 const run = vi.fn(async (signal: AbortSignal) => {
  const next = await runAutomaticApiChecks({path, signal, check, loadRoutes: async () => {
   if (++loads === 1) await loadGate;
   return routes;
  }});
  completions++;
  return next;
 });
 const scheduler = startAutomaticApiChecks(run);
 try {
  await vi.advanceTimersByTimeAsync(5000);
  const start = Date.now();
  await vi.advanceTimersByTimeAsync(10_000);
  releaseLoad();
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  const claims = JSON.parse(await readFile(path, "utf8"));
  expect(Object.values(claims)).toEqual([start, start]);
  expect(check.mock.calls[0]?.[2]).toBe(start + AUTOMATIC_API_CHECK_INTERVAL_MS);
  await vi.advanceTimersByTimeAsync(60_000);
  releaseLater();
  await vi.waitFor(() => expect(completions).toBe(1));
  expect(await run.mock.results[0]!.value).toBe(start + AUTOMATIC_API_CHECK_INTERVAL_MS);
  await vi.advanceTimersByTimeAsync(start + AUTOMATIC_API_CHECK_INTERVAL_MS - Date.now() - 1);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(completions).toBe(2));
  expect(check).toHaveBeenCalledTimes(4);
 } finally {
  releaseLoad(); releaseLater();
  let drained = false;
  const stop = scheduler.stop().finally(() => { drained = true; });
  try { await vi.waitFor(() => expect(drained).toBe(true)); await stop; }
  finally { vi.useRealTimers(); }
 }
});

it("returns an existing claim deadline when a restart runs before it is due", async () => {
 const path = await fixture(), check = vi.fn(async () => {});
 const options = {path, check, loadRoutes: async () => [route("existing")]};
 await runAutomaticApiChecks({...options, now: () => 1000});
 expect(await runAutomaticApiChecks({...options, now: () => 2000})).toBe(1000 + AUTOMATIC_API_CHECK_INTERVAL_MS);
 expect(check).toHaveBeenCalledTimes(1);
});

it("does not recreate cleared history from a route snapshot queued behind the wipe lock", async () => {
 const {withFileTransactionLock} = await import("../lib/storage/file-lock.js");
 const path = await fixture();
 let routes = [route("removed")], release!: () => void, entered!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const enteredGate = new Promise<void>(resolve => { entered = resolve; });
 const owner = withFileTransactionLock(path, async () => { entered(); await gate; routes = []; await fs.rm(path, {force: true}); });
 await enteredGate;
 let contended = false;
 const rename = fs.rename.bind(fs);
 const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
  try { return await rename(from, to); }
  catch (error) { if (String(to).endsWith(".write-lock")) contended = true; throw error; }
 });
 const check = vi.fn(async () => {});
 vi.useFakeTimers();
 const waiting = runAutomaticApiChecks({path, check, loadRoutes: async () => routes});
 try {
  await vi.waitFor(() => expect(contended).toBe(true));
  release();
  let drained = false;
  const done = Promise.all([owner, waiting]).finally(() => { drained = true; });
  await vi.waitFor(() => expect(drained).toBe(true)); await done;
  expect(check).not.toHaveBeenCalled();
  await expect(readFile(path, "utf8")).rejects.toMatchObject({code: "ENOENT"});
 } finally {
  release();
  let drained = false;
  const done = Promise.allSettled([owner, waiting]).finally(() => { drained = true; });
  try { await vi.waitFor(() => expect(drained).toBe(true)); await done; }
  finally { vi.useRealTimers(); renameSpy.mockRestore(); }
 }
});

it("bounds a pending run's next timer after a large clock rollback", async () => {
 vi.useFakeTimers(); vi.setSystemTime(40 * AUTOMATIC_API_CHECK_INTERVAL_MS);
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const run = vi.fn(async () => { await gate; });
 const scheduler = startAutomaticApiChecks(run);
 try {
  await vi.advanceTimersByTimeAsync(5000);
  vi.setSystemTime(1000);
  release(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(AUTOMATIC_API_CHECK_INTERVAL_MS - 1);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
 } finally { release(); await scheduler.stop(); }
});

it("drains an overdue run before one immediate catch-up without overlap", async () => {
 vi.useFakeTimers();
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const starts: number[] = [];
 const run = vi.fn(async () => { starts.push(Date.now()); if (run.mock.calls.length === 1) await gate; });
 const scheduler = startAutomaticApiChecks(run);
 try {
  await vi.advanceTimersByTimeAsync(5000);
  await vi.advanceTimersByTimeAsync(2 * AUTOMATIC_API_CHECK_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(starts[1]! + AUTOMATIC_API_CHECK_INTERVAL_MS - Date.now() - 1);
  expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(3);
 } finally { release(); await scheduler.stop(); }
});

it.each([false,true])("migrates legacy ownership before claiming the daily check (discovery writes=%s)",async(discoveryWrites)=>{
 const api=await import("../lib/api-route-store.js"),discovery=await import("../lib/runtime/model-discovery-status.js");
 const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 const root=await fixture();const previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=join(root,"..");
 let posts=0;const models:string[]=[];
 const network=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  if(init?.method==="POST"){posts++;models.push(JSON.parse(String(init.body)).model);return Response.json({output:[],service_tier:"default"});}
  if(String(input).endsWith("/models"))return Response.json({data:[{id:"gpt-test-old"},...(discoveryWrites?[{id:"gpt-test-new"}]:[])]});
  return new Response("",{status:404});
 });
 try{
  await writeFile(api.getApiRoutesPath(),JSON.stringify({version:1,routes:[{...route("discover"),visibleModels:["gpt-test-old"],knownModels:["gpt-test-old"]}]}));
  await createAutomaticApiCheck()(new AbortController().signal);
  expect(posts).toBeGreaterThan(0);expect(models).toContain(discoveryWrites?"gpt-test-new":"gpt-test-old");
  expect((await api.loadApiRoutes())[0]?.visibleModels).toContain(discoveryWrites?"gpt-test-new":"gpt-test-old");
  expect((await discovery.loadModelInventory())?.entries[0]?.visibleModels).toContain(discoveryWrites?"gpt-test-new":"gpt-test-old");
  expect((await api.loadApiRoutes())[0]?.capabilityEpoch).toEqual(expect.any(String));
  const before=posts;await createAutomaticApiCheck()(new AbortController().signal);expect(posts).toBe(before);
 }finally{network.mockRestore();if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;}
});
it.each(["readonly","abort"])("does not claim or probe a legacy route when migration %s prevents completion",async failure=>{
 const api=await import("../lib/api-route-store.js"),locks=await import("../lib/storage/file-lock.js");
 const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 const history=await fixture(),previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=join(history,"..");
 const controller=new AbortController(),original=locks.withFileTransactionLock;
 const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("No network expected"));
 try{
  await writeFile(api.getApiRoutesPath(),JSON.stringify({version:1,routes:[route("legacy")]}));
  vi.spyOn(locks,"withFileTransactionLock").mockImplementation(async(...args)=>{
   if(args[0]===api.getApiRoutesPath()){if(failure==="abort"){controller.abort();controller.signal.throwIfAborted();}throw Object.assign(Error("readonly"),{code:"EROFS"});}
   return original(...args);
  });
  await createAutomaticApiCheck()(controller.signal);
  expect(network).not.toHaveBeenCalled();
  for(const name of ["automatic-api-checks.json","api-capability-probes.json","model-discovery.json"])await expect(fs.stat(join(history,"..",name))).rejects.toMatchObject({code:"ENOENT"});
 }finally{if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;}
});
it("prepares a newly observed legacy snapshot before writing its daily claim",async()=>{
 const path=await fixture(),legacy=route("late"),prepared={...legacy,capabilityEpoch:"00000000-0000-4000-8000-000000000001"};
 let canonical=false;
 const prepareRoute=vi.fn(async()=>{await expect(fs.stat(path)).rejects.toMatchObject({code:"ENOENT"});canonical=true;return prepared;});
 const check=vi.fn(async()=>{});
 await runAutomaticApiChecks({path,loadRoutes:async()=>[canonical?prepared:legacy],prepareRoute,check});
 expect(prepareRoute).toHaveBeenCalledOnce();expect(check).toHaveBeenCalledWith(prepared,expect.any(AbortSignal),expect.any(Number));
});
it.each([2,3])("accepts visibility reordering at route read %s without losing the daily deadline",async reorderAt=>{
 const path=await fixture(),original={...route("ordered"),visibleModels:["z","a"]},reordered={...original,visibleModels:["a","z"]};let reads=0;
 const check=vi.fn(async()=>{});const before=JSON.stringify(original);
 const options={path,loadRoutes:async()=>[++reads>=reorderAt?reordered:original],now:()=>1000,check};
 expect(await runAutomaticApiChecks(options)).toBe(1000+AUTOMATIC_API_CHECK_INTERVAL_MS);expect(check).toHaveBeenCalledOnce();
 await runAutomaticApiChecks(options);expect(check).toHaveBeenCalledOnce();expect(JSON.stringify(original)).toBe(before);
});
it("preserves the original raw-order legacy claim when observation reorders visibility",async()=>{
 const path=await fixture(),original={...route("legacy-order"),visibleModels:["z","a"]};let reads=0;const check=vi.fn(async()=>{});
 const oldKey=createHash("sha256").update(JSON.stringify([original.id,original.kind,original.apiKey,original.visibleModels])).digest("hex");await writeFile(path,JSON.stringify({[oldKey]:1000}));
 expect(await runAutomaticApiChecks({path,loadRoutes:async()=>[{...original,visibleModels:++reads===1?["z","a"]:["a","z"]}],now:()=>2000,check})).toBe(1000+AUTOMATIC_API_CHECK_INTERVAL_MS);expect(check).not.toHaveBeenCalled();
});
it.each([2,3])("still rejects a true visibility change at route read %s",async changedAt=>{
 const path=await fixture(),original={...route("membership"),visibleModels:["z","a"]};let reads=0;const check=vi.fn(async()=>{});
 await runAutomaticApiChecks({path,loadRoutes:async()=>[{...original,visibleModels:++reads>=changedAt?["a"]:original.visibleModels}],now:()=>1000,check});expect(check).not.toHaveBeenCalled();await expect(fs.stat(path)).rejects.toMatchObject({code:"ENOENT"});
});
it.each([false,true])("revalidates production POST and inventory by visibility membership (remove=%s)",async remove=>{
 const api=await import("../lib/api-route-store.js"),discovery=await import("../lib/runtime/model-discovery-status.js");const {createAutomaticApiCheck}=await import("../lib/runtime/automatic-api-checks.js");
 const history=await fixture(),previous=process.env.CODEX_MULTI_AUTH_DIR;process.env.CODEX_MULTI_AUTH_DIR=join(history,"..");
 let change:Promise<void>|undefined,posts=0;
 const transport:typeof fetch=async(input,init)=>{
  // Every model's documentation fetch waits for the same saved edit. Docs for
  // both models load concurrently; without this, the second could return while
  // the first is still saving, and its probe would POST against the old routes.
  if(String(input).startsWith("https://developers.openai.com/")){
   change??=(async()=>{const current=await api.loadApiRoutes();await api.saveApiRoutes(current.map(r=>({...r,visibleModels:remove?["gpt-a"]:[...r.visibleModels].sort()})),undefined,current);})();
   await change;
  }
  if(init?.method==="POST"){posts++;const body=JSON.parse(String(init.body));return Response.json({reasoning:body.reasoning,service_tier:body.service_tier});}
  if(String(input).endsWith("/models"))return Response.json({data:[{id:"gpt-z"},{id:"gpt-a"}]});return new Response("missing",{status:404});
 };
 try{
  await api.saveApiRoutes([{...route("post-order"),visibleModels:["gpt-z","gpt-a"],knownModels:["gpt-z","gpt-a"]}]);
  await createAutomaticApiCheck(transport)(new AbortController().signal);
  if(remove){expect(posts).toBe(0);expect(await discovery.loadModelInventory()).toBeNull();}
  else{expect(posts).toBeGreaterThan(0);expect((await discovery.loadModelInventory())?.entries).toHaveLength(1);const before=posts;await createAutomaticApiCheck(transport)(new AbortController().signal);expect(posts).toBe(before);}
 }finally{if(previous===undefined)delete process.env.CODEX_MULTI_AUTH_DIR;else process.env.CODEX_MULTI_AUTH_DIR=previous;}
});
it.each(["expired","future"])("honors the newest plausible observed legacy visibility-order claim (%s)",async stale=>{
 const path=await fixture(),original={...route("legacy-latest"),visibleModels:["z","a"]},sorted={...original,visibleModels:["a","z"]};let reads=0;const check=vi.fn(async()=>{});
 const hash=(r:ApiRouteCredential)=>createHash("sha256").update(JSON.stringify([r.id,r.kind,r.apiKey,r.visibleModels])).digest("hex");
 const now=2*AUTOMATIC_API_CHECK_INTERVAL_MS;
 await writeFile(path,JSON.stringify({[hash(sorted)]:stale==="future"?now+AUTOMATIC_API_CHECK_INTERVAL_MS:1,[hash(original)]:now-1000}));
 expect(await runAutomaticApiChecks({path,loadRoutes:async()=>[++reads===1?original:sorted],now:()=>now,check})).toBe(now-1000+AUTOMATIC_API_CHECK_INTERVAL_MS);expect(check).not.toHaveBeenCalled();
});
