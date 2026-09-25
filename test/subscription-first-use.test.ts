import { afterEach, expect, it, vi } from "vitest";
import { finishSubscriptionFirstUse, needsSubscriptionFirstUse } from "../lib/runtime/subscription-first-use.js";
const now = 1_000_000;
const unused = () => ({status:200,planType:"prolite",primary:{usedPercent:0,windowMinutes:10080,resetAtMs:now+604800000},secondary:{usedPercent:0,windowMinutes:0}});
afterEach(()=>vi.useRealTimers());
it("recognizes a full relative reset placeholder without treating it as a running countdown",()=>{
 expect(needsSubscriptionFirstUse(unused(),now)).toBe(true);
 expect(needsSubscriptionFirstUse({...unused(),primary:{...unused().primary,resetAtMs:now+600000000}},now)).toBe(false);
 expect(needsSubscriptionFirstUse({...unused(),primary:{usedPercent:0,windowMinutes:10080}},now)).toBe(true);
 expect(needsSubscriptionFirstUse({...unused(),primary:{...unused().primary,usedPercent:0.01}},now)).toBe(false);
 expect(needsSubscriptionFirstUse({...unused(),status:429},now)).toBe(false);
 expect(needsSubscriptionFirstUse({...unused(),primary:{}},now)).toBe(false);
});
it("bounds a stalled first-use response and cancels it",async()=>{
 vi.useFakeTimers();const cancel=vi.fn();
 const response=new Response(new ReadableStream({cancel}));
 const result=finishSubscriptionFirstUse(response,1000);
 const assertion=expect(result).rejects.toThrow("First-use probe did not complete");
 await vi.advanceTimersByTimeAsync(1000);await assertion;expect(cancel).toHaveBeenCalledOnce();
});
it("rejects failure events even after a creation event",async()=>{
 const response=new Response('data: {"type":"response.created"}\n\ndata: {"type":"response.failed"}\n\n');
 await expect(finishSubscriptionFirstUse(response,1000)).rejects.toThrow("unconfirmed");
});
it("bounds first-use response bytes",async()=>{
 await expect(finishSubscriptionFirstUse(new Response('x'.repeat(1024*1024+1)),1000)).rejects.toThrow("unconfirmed");
});

it("does not prime when any active window has an established countdown",()=>{
 expect(needsSubscriptionFirstUse({...unused(),secondary:{usedPercent:0,windowMinutes:300,resetAtMs:now+600000}},now)).toBe(false);
 expect(needsSubscriptionFirstUse({...unused(),secondary:{usedPercent:0.01,windowMinutes:0}},now)).toBe(false);
});
it("accepts a successful response.done terminal event",async()=>{
 await expect(finishSubscriptionFirstUse(new Response('data: {"type":"response.done","response":{"status":"completed"}}\n\n'),1000)).resolves.toBeUndefined();
});
