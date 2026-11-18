import { describe, expect, it, vi } from "vitest";
import { ApiModelRuntime } from "../lib/runtime/api-model-runtime.js";
import type { ApiRouteCredential } from "../lib/api-route-store.js";
import { ResponseOutcome } from "../lib/request/response-outcome.js";
import { ApiRateBackoff } from "../lib/runtime/api-rate-backoff.js";
import { apiRetryDelayMs } from "../lib/request/api-retry-delay.js";

const route = (id = "one"): ApiRouteCredential => ({ id, label: id, kind: "api", priority: 0, enabled: true, apiKey: `fixture-${id}`, visibleModels: ["exclusive", "other"] });
const catalog = () => Response.json({data: [{id: "exclusive"}, {id: "other"}]});
const limited = (after: string, code = "rate_limit_exceeded") => Response.json({error:{code}}, {status:429, headers:{"retry-after":after}});
const request = (runtime: ApiModelRuntime, routes = [route()], model = "exclusive") => runtime.request(`api/${model}`, {model:`api/${model}`}, routes);
class ImmediateRuntime extends ApiModelRuntime {
 constructor(fetcher: typeof fetch, now: () => number = Date.now) { super(fetcher,now,undefined,undefined,undefined,0); }
}

describe("coordinated API backoff", () => {
 it("retries a confirmed upstream 429 after Retry-After within the same request", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const jitter=vi.spyOn(Math,"random").mockReturnValue(0);
  let posts=0;
  const runtime=new ApiModelRuntime(async(_url,init)=>init?.method!=="POST"?catalog():++posts===1?limited("2"):new Response("ok"));
  try {
   const pending=request(runtime);
   await vi.advanceTimersByTimeAsync(1999); expect(posts).toBe(1);
   await vi.advanceTimersByTimeAsync(1);
   const result=await pending;
   expect(result.status).toBe(200); expect(posts).toBe(2);
   runtime.completeRequest(result,true);
  } finally {jitter.mockRestore();vi.useRealTimers();}
 });
 it("waits before an unsent create instead of spending the native retry budget", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const jitter=vi.spyOn(Math,"random").mockReturnValue(0);
  let posts=0;
  const runtime=new ApiModelRuntime(async(_url,init)=>init?.method!=="POST"?catalog():(posts++,new Response("ok")));
  try {
   runtime.recordStreamFailure(route(),"api/exclusive",{}, {error:{code:"rate_limit_exceeded",retry_after:2}});
   const pending=request(runtime);
   await vi.advanceTimersByTimeAsync(1999);
   expect(posts).toBe(0);
   await vi.advanceTimersByTimeAsync(1);
   const result=await pending;
   expect(result.status).toBe(200); expect(posts).toBe(1);
   runtime.completeRequest(result,true);
  } finally {jitter.mockRestore();vi.useRealTimers();}
 });
 it("bounds admission waiting and cancels without an upstream send", async () => {
  let posts=0;
  const runtime=new ApiModelRuntime(async(_url,init)=>init?.method!=="POST"?catalog():(posts++,limited("60")),Date.now,undefined,undefined,undefined,20);
  expect((await request(runtime)).status).toBe(429);
  const deferred=await request(runtime);
  expect(deferred.status).toBe(429);expect(posts).toBe(1);
  const controller=new AbortController();
  const waiting=runtime.request("api/exclusive",{},[route()],controller.signal);
  controller.abort();
  await expect(waiting).rejects.toMatchObject({name:"AbortError"});expect(posts).toBe(1);
 });
 it("bounds repeated confirmed throttles and never retries billing quota", async () => {
  vi.useFakeTimers();vi.setSystemTime(1_800_000_000_000);
  const jitter=vi.spyOn(Math,"random").mockReturnValue(0);
  const times:number[]=[];let quotaPosts=0;
  const runtime=new ApiModelRuntime(async(_url,init)=>init?.method!=="POST"?catalog():(times.push(Date.now()),limited("2")));
  try {
   const pending=request(runtime);await vi.advanceTimersByTimeAsync(30000);
   const result=await pending;expect(result.status).toBe(429);
   expect(times.map(time=>time-times[0]!)).toEqual([0,2000,4000,8000,16000]);
   expect(Number(result.headers.get("retry-after"))).toBeGreaterThanOrEqual(16);
   const quota=new ApiModelRuntime(async(_url,init)=>init?.method!=="POST"?catalog():(quotaPosts++,limited("2","insufficient_quota")));
   expect(await (await request(quota)).json()).toMatchObject({error:{code:"insufficient_quota"}});expect(quotaPosts).toBe(1);
  } finally {jitter.mockRestore();vi.useRealTimers();}
 });
 it("cancels a parked request and never resends an ambiguous earlier candidate", async () => {
  vi.useFakeTimers();vi.setSystemTime(1_800_000_000_000);
  const jitter=vi.spyOn(Math,"random").mockReturnValue(0);
  const posts:string[]=[];
  const runtime=new ApiModelRuntime(async(_url,init)=>{
   if(init?.method!=="POST")return catalog();
   const key=new Headers(init.headers).get("authorization")??"";posts.push(key);
   if (key.endsWith("one")) throw Error("ambiguous transport failure");
   return new Response("ok");
  });
  try {
   runtime.recordStreamFailure(route("backup"),"api/exclusive",{}, {error:{code:"rate_limit_exceeded",retry_after:2}});
   const abort=new AbortController();
   const parked=runtime.request("api/exclusive",{},[route("backup")],abort.signal);
   const cancelled=expect(parked).rejects.toMatchObject({name:"AbortError"});
   await vi.advanceTimersByTimeAsync(100);
   abort.abort();await cancelled;
   const pending=request(runtime,[route(),{...route("backup"),priority:2}]);
   await vi.advanceTimersByTimeAsync(2000);
   expect((await pending).status).toBe(200);
   expect(posts).toEqual(["Bearer fixture-one","Bearer fixture-backup"]);
  } finally {jitter.mockRestore();vi.useRealTimers();}
 });
 it("holds recovery admission through a pending HTTP 200 stream and preserves strikes on streamed failure", async () => {
  let now = 1_800_000_000_000, posts = 0;
  const runtime = new ImmediateRuntime(async (_url,init) => {
   if(init?.method !== "POST") return catalog();
   posts++;
   return posts === 1 ? limited("0") : new Response(new ReadableStream({start(){}}), {headers:{"content-type":"text/event-stream"}});
  },()=>now);
  expect((await request(runtime)).status).toBe(429);
  now += 1500;
  const recovery = await request(runtime);
  expect(recovery.status).toBe(200);
  expect((await request(runtime)).status).toBe(429);
  expect(posts).toBe(2);
  runtime.recordStreamFailure(route(),"api/exclusive",{}, {error:{code:"rate_limit_exceeded"}});
  runtime.completeRequest(recovery, false);
  now += 1500;
  expect((await request(runtime)).status).toBe(429);
  expect(posts).toBe(2);
  await recovery.body?.cancel();
 });
 it("never clears a newer penalty when an older recovery succeeds", () => {
  let now = 1000;
  const backoff = new ApiRateBackoff(()=>now);
  backoff.penalize("key", 2000);
  now += 3000;
  const admitted = backoff.acquire("key");
  expect(admitted.waitMs).toBe(0);
  backoff.penalize("key", 60_000);
  admitted.release(true);
  expect(backoff.acquire("key").waitMs).toBeGreaterThanOrEqual(60_000);
 });
 it("uses the longest valid wait hint and rejects malformed numeric headers", () => {
  expect(apiRetryDelayMs({error:{retry_after:3}},0,new Headers({"retry-after":"2.5", "retry-after-ms":"2800"}))).toBe(3000);
  expect(apiRetryDelayMs(null,0,new Headers({"retry-after":"1 trailing garbage"}))).toBe(0);
 });
 it("retains only a numeric wait from a streamed provider rate-limit message", () => {
  const outcome = new ResponseOutcome(true);
  outcome.observe({type:"response.failed",response:{error:{code:"rate_limit_exceeded",message:"Rate limit reached for private organization. Please try again in 24.848s."}}});
  expect(outcome.rejection).toEqual({error:{code:"rate_limit_exceeded",param:undefined,retry_after_ms:24848}});
 });
 it("honors fractional Retry-After, shares aliases of a credential, and admits one recovery request", async () => {
  let now = 1_800_000_000_000, posts = 0;
  let release!: (response: Response) => void;
  const runtime = new ImmediateRuntime(async (_url, init) => {
   if(init?.method !== "POST") return catalog();
   posts++;
   if(posts === 1) return limited("2.5");
   return new Promise<Response>(resolve => {release = resolve;});
  }, () => now);
  expect((await request(runtime)).status).toBe(429);
  const alias = {...route(), id:"same-key"};
  now += 2000;
  const blocked = await request(runtime, [alias]);
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  expect(posts).toBe(1);
  now += 2000;
  const recovering = request(runtime);
  while(posts < 2) await Promise.resolve();
  const follower = await request(runtime, [alias]);
  expect(follower.status).toBe(429);
  expect(posts).toBe(2);
  release(new Response("ok"));
  expect((await recovering).status).toBe(200);
 });
 it("uses another eligible credential immediately, but keeps regions and models isolated", async () => {
  let posts = 0;
  const runtime = new ImmediateRuntime(async (_url, init) => {
   if(init?.method !== "POST") return catalog();
   posts++;
   return new Headers(init.headers).get("authorization")?.endsWith("one") && JSON.parse(String(init.body)).model === "exclusive" ? limited("120") : new Response("ok");
  });
  expect((await request(runtime)).status).toBe(429);
  // A zero admission budget cannot wait for discovery; make the backup immediately usable.
  await runtime.catalogs([route(), {...route("backup"),priority:2}]);
  expect((await request(runtime,[route(), {...route("backup"),priority:2}])).status).toBe(200);
  expect((await request(runtime,[route()],"other")).status).toBe(200);
  expect((await request(runtime,[route(), {...route("us"),region:"us",priority:2}])).status).toBe(429);
  expect(posts).toBe(3);
 });
 it("learns streamed rate limits for later creates without replaying the accepted stream", async () => {
  let posts = 0;
  const runtime = new ImmediateRuntime(async (_url,init) => {
   if(init?.method !== "POST") return catalog();
   posts++;
   return new Response('data: {"type":"response.failed"}\n\n');
  });
  const accepted = await request(runtime);
  expect(await accepted.text()).toContain("response.failed");
  runtime.recordStreamFailure(route(),"api/exclusive",{}, {error:{code:"rate_limit_exceeded",retry_after:60}});
  expect((await request(runtime)).status).toBe(429);
  expect(posts).toBe(1);
 });
 it("does not shorten long HTTP-date deadlines or treat insufficient quota as transient", async () => {
  let now = 1_800_000_000_000, posts = 0;
  const deadline = now + 3_600_000;
  const runtime = new ImmediateRuntime(async (_url,init) => {
   if(init?.method !== "POST") return catalog();
   posts++;
   return limited(new Date(deadline).toUTCString());
  },()=>now);
  const first = await request(runtime);
  expect(Number(first.headers.get("retry-after"))).toBeGreaterThanOrEqual(3600);
  now += 60_000;
  expect((await request(runtime)).status).toBe(429);
  expect(posts).toBe(1);
  const quota = new ImmediateRuntime(async (_url,init)=>init?.method === "POST" ? limited("60","insufficient_quota") : catalog());
  expect(await (await request(quota)).json()).toMatchObject({error:{code:"insufficient_quota"}});
 });
});
