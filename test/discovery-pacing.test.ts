import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
import { formatModelInventory, saveModelInventory, loadModelInventory } from "../lib/runtime/model-discovery-status.js";
import type { ApiRouteCredential } from "../lib/api-route-store.js";
const route = (id = "one"): ApiRouteCredential => ({ id, label: id, kind: "api", apiKey: `fixture-${id}`, enabled: true, priority: 0, visibleModels: ["example"] });
const catalog = () => Response.json({ data: [{ id: "example" }] });
afterEach(() => vi.useRealTimers());
describe("discovery recovery", () => {
 it("coalesces overlapping refreshes and spaces catalog fetches", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  const fetcher = vi.fn(async () => { starts.push(Date.now()); return catalog(); });
  const runtime = new ApiModelRuntime(fetcher as typeof fetch);
  const routes = [route(), route("two")];
  const jobs = [runtime.catalogs(routes, true), runtime.catalogs(routes, true)];
  await vi.runAllTimersAsync(); await Promise.all(jobs);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(250);
 });
 it.each(["60", "date"])("honors Retry-After %s even on forced refresh and retains stale models", async hint => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const fetcher = vi.fn().mockResolvedValueOnce(catalog()).mockImplementationOnce(async () => new Response(null, {status:429,headers:{"retry-after":hint === "date" ? new Date(Date.now()+60000).toUTCString() : hint}})).mockImplementation(async () => catalog());
  const runtime = new ApiModelRuntime(fetcher as typeof fetch);
  await runtime.catalogs([route()]);
  const failure = runtime.catalogs([route()], true); await vi.runAllTimersAsync(); await failure;
  expect(runtime.statuses([route()])[0]).toMatchObject({error:true, availableModels:["example"], failure:{kind:"http",status:429}});
  await runtime.catalogs([route()], true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  await runtime.catalogs([route()], true);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(runtime.statuses([route()])[0]?.error).toBe(false);
 });
 it("serves a warm catalog while another credential's discovery is blocked",async()=>{
  vi.useFakeTimers();
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=vi.fn().mockResolvedValueOnce(catalog()).mockImplementationOnce(async()=>{await gate;return catalog();});
  const runtime=new ApiModelRuntime(fetcher as typeof fetch);
  await runtime.catalogs([route()]);
  const blocked=runtime.catalogs([route("two")],true);
  await vi.advanceTimersByTimeAsync(250);
  let completed=false;
  const warm=runtime.catalogs([route()]).then(()=>{completed=true;});
  await vi.advanceTimersByTimeAsync(0);
  try {expect(completed).toBe(true);} finally {release();await vi.runAllTimersAsync();await Promise.all([blocked,warm]);}
 });
 it("sends a request through a warm route without waiting for another route's discovery", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
   if (init?.method === "POST") return Response.json({ id: "fixture-response" });
   if (new Headers(init?.headers).get("authorization") === "Bearer fixture-cold") await gate;
   return catalog();
  });
  const runtime = new ApiModelRuntime(fetcher as typeof fetch);
  await runtime.catalogs([route()]);
  let completed = false;
  const request = runtime.request("api/example", {}, [route("cold"), route()]).then(response => { completed = response.ok; });
  await vi.advanceTimersByTimeAsync(500);
  try { expect(completed).toBe(true); }
  finally { release(); await vi.runAllTimersAsync(); await request; }
 });
 it("paces a healthy region's discovery start without awaiting a stalled region", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const starts: number[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
   starts.push(Date.now());
   if (new Headers(init?.headers).get("authorization") === "Bearer fixture-cold") await gate;
   return catalog();
  });
  const runtime = new ApiModelRuntime(fetcher as typeof fetch);
  const cold = runtime.catalogs([route("cold")]);
  let completed = false;
  const healthy = runtime.catalogs([{...route(), region:"us"}]).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(250);
  try { expect(completed).toBe(true); expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(250); }
  finally { release(); await vi.runAllTimersAsync(); await Promise.all([cold,healthy]); }
 });
 it.each(["disabled", "hidden", "pool"])("does not let a warm catalog bypass current %s policy", async change => {
  const fetcher = vi.fn(async () => catalog());
  const runtime = new ApiModelRuntime(fetcher as typeof fetch);
  await runtime.catalogs([route()]);
  const changed = {...route(), ...(change === "disabled" ? {enabled:false} : change === "hidden" ? {visibleModels:[]} : {kind:"psp" as const})};
  const response = await runtime.request("api/example", {}, [changed]);
  expect(response.ok).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it.each([503,429])("discovers a cold same-region backup after warm primary HTTP %s", async status => {
  vi.useFakeTimers();
  const sent: string[] = [];
  const discovered: string[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
   const key = new Headers(init?.headers).get("authorization")!;
   if (init?.method !== "POST") { discovered.push(key); return catalog(); }
   sent.push(key);
   return key === "Bearer fixture-one" ? Response.json({error:{code:"rate_limit_exceeded"}},{status,headers:{"retry-after":"60"}}) : Response.json({id:"fixture-success"});
  });
  const runtime = new ApiModelRuntime(fetcher as typeof fetch);
  await runtime.catalogs([route()]);
  const pending = runtime.request("api/example", {}, [route(), route("backup"), {...route("foreign"),region:"us"}, {...route("private"),kind:"psp"}]);
  await vi.runAllTimersAsync();
  const response = await pending;
  expect(response.status).toBe(200);
  expect(sent).toEqual(["Bearer fixture-one","Bearer fixture-backup"]);
  expect(discovered).toEqual(["Bearer fixture-one","Bearer fixture-backup"]);
 });
 it.each(["recovery", "deadline", "cancel"])("does not let stalled backups block %s", async mode => {
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date","performance"]});
  let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
  let attempts=0;
  const fetcher=vi.fn(async (_url:string|URL|Request,init?:RequestInit)=>{
   const key=new Headers(init?.headers).get("authorization");
   if(init?.method!=="POST"){if(key==="Bearer fixture-backup")await gate;return catalog();}
   attempts++;return attempts===1?Response.json({error:{code:"rate_limit_exceeded"}},{status:429,headers:{"retry-after":mode==="recovery"?"1":"60"}}):Response.json({id:"ok"});
  });
  const runtime=new ApiModelRuntime(fetcher as typeof fetch,Date.now,undefined,undefined,undefined,2000);
  await runtime.catalogs([route()]);
  const controller=new AbortController();let status:number|string|undefined;
  const pending=runtime.request("api/example",{},[route(),route("backup")],controller.signal).then(r=>{status=r.status;},()=>{status="cancelled";});
  await vi.advanceTimersByTimeAsync(500);
  if(mode==="cancel")controller.abort();
  await vi.advanceTimersByTimeAsync(mode==="recovery"?800:1600);
  try {expect(status).toBe(mode==="recovery"?200:mode==="cancel"?"cancelled":429);expect(attempts).toBe(mode==="recovery"?2:1);}
  finally {release();await vi.runAllTimersAsync();await pending;}
 });
 it("keeps the full catalog visible during backup enrichment callbacks", async()=>{
  vi.useFakeTimers();const views:string[][]=[];
  const fetcher=vi.fn(async (_url:string|URL|Request,init?:RequestInit)=>init?.method==="POST"?new Response(null,{status:new Headers(init.headers).get("authorization")==="Bearer fixture-one"?503:200}):catalog());
  const runtime=new ApiModelRuntime(fetcher as typeof fetch,Date.now,undefined,async models=>models,()=>{views.push(runtime.cachedCatalogs().map(c=>c.id).sort());});
  const warm=runtime.catalogs([route(),{...route("other"),kind:"zdr"}]);await vi.runAllTimersAsync();await warm;views.length=0;
  const pending=runtime.request("api/example",{},[route(),route("backup"),{...route("other"),kind:"zdr"}]);await vi.runAllTimersAsync();expect((await pending).status).toBe(200);
  expect(views.length).toBeGreaterThan(0);expect(views.every(ids=>ids.includes("one")&&ids.includes("other"))).toBe(true);
 });
 it("uses a ready backup without waiting for a stalled sibling or reviving removed routes",async()=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date","performance"]});
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const views:string[][]=[];
  const fetcher=vi.fn(async (_url:string|URL|Request,init?:RequestInit)=>{
   const key=new Headers(init?.headers).get("authorization");
   if(init?.method!=="POST"){if(key==="Bearer fixture-stalled")await gate;return catalog();}
   return new Response(null,{status:key==="Bearer fixture-one"?503:200});
  });
  const runtime=new ApiModelRuntime(fetcher as typeof fetch,Date.now,undefined,async models=>models,()=>{views.push(runtime.cachedCatalogs().map(c=>c.id));});
  await runtime.catalogs([route()]);let status:number|undefined;
  const pending=runtime.request("api/example",{},[route(),route("stalled"),route("ready")]).then(r=>{status=r.status;});
  await vi.advanceTimersByTimeAsync(500);
  try {expect(status).toBe(200);await runtime.catalogs([route()]);views.length=0;}
  finally {release();await vi.runAllTimersAsync();await pending;}
  expect(runtime.cachedCatalogs().map(c=>c.id)).toEqual(["one"]);
  expect(views.every(ids=>!ids.includes("stalled"))).toBe(true);
 });
 it.each([401,403])("removes routing evidence on HTTP %s and never exposes the response body", async status => {
  vi.useFakeTimers();
  const fetcher=vi.fn().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(new Response("secret fixture",{status}));
  const runtime=new ApiModelRuntime(fetcher as typeof fetch);
  await runtime.catalogs([route()]);
  const next=runtime.catalogs([route()],true); await vi.runAllTimersAsync(); await next;
  expect(runtime.statuses([route()])[0]?.availableModels).toEqual([]);
  expect(runtime.cachedCatalogs()[0]?.models).toEqual([]);
  expect(JSON.stringify(runtime.statuses([route()]))).not.toContain("secret fixture");
 });
 it.each(["TimeoutError","TypeError"])("reports %s and retains the last successful timestamp",async name=>{
  vi.useFakeTimers();vi.setSystemTime(1000);
  const error=new Error("sensitive upstream detail");error.name=name;
  const fetcher=vi.fn().mockResolvedValueOnce(catalog()).mockRejectedValueOnce(error);
  const runtime=new ApiModelRuntime(fetcher as typeof fetch);
  await runtime.catalogs([route()]);
  const next=runtime.catalogs([route()],true);await vi.runAllTimersAsync();await next;
  expect(runtime.statuses([route()])[0]).toMatchObject({lastSuccessfulAt:1000,availableModels:["example"],failure:{kind:name==="TimeoutError"?"timeout":"network"}});
  await runtime.catalogs([route()],true);expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it("persists failure classification and last good discovery time",async()=>{
  const value={version:1 as const,checkedAt:1000,entries:[{id:"api:fixture-discovery",label:"one",kind:"api" as const,enabled:true,checkedAt:1000,error:true,models:["example"],visibleModels:["example"],failure:{kind:"http" as const,status:429,retryAt:61000},lastSuccessfulAt:500}]};
  await saveModelInventory(value);
  expect((await loadModelInventory())?.entries[0]).toMatchObject(value.entries[0]!);
 });
 it("labels stale catalog data and prints a safe failure reason", () => {
  const text = formatModelInventory({version:1,checkedAt:1000,entries:[{id:"api:fixture-discovery",label:"one",kind:"api",enabled:true,checkedAt:1000,error:true,models:["example"],visibleModels:["example"],failure:{kind:"http",status:429},lastSuccessfulAt:500} ]},1000).join("\n");
  expect(text).toContain("HTTP 429"); expect(text).toContain("stale"); expect(text).toContain("example");
 });
});
