import {expect,it} from "vitest";
import {readSubscriptionQuotaEvent} from "../lib/runtime/subscription-quota-event.js";
const now=1700000000000;
it("reads fractional quota, reset timestamps and plan from native WebSocket events",()=>{
 expect(readSubscriptionQuotaEvent({type:"codex.rate_limits",plan_type:"pro",rate_limits:{secondary:{used_percent:94,reset_at:1700010000},primary:{used_percent:7.5}}},now)).toEqual({status:200,updatedAt:now,planType:"pro",primary:{usedPercent:7.5},secondary:{usedPercent:94,resetAtMs:1700010000000}});
});
it("ignores unrelated limit pools, malformed values, and model output",()=>{
 for(const payload of [null,{type:"response.output_text.delta",delta:'{"type":"codex.rate_limits"}'},{type:"codex.rate_limits",metered_limit_name:"other",rate_limits:{secondary:{used_percent:100}}},{type:"codex.rate_limits",rate_limits:{secondary:{used_percent:"94"}}},{type:"codex.rate_limits",rate_limits:{primary:{used_percent:-1},secondary:{used_percent:101}}}])expect(readSubscriptionQuotaEvent(payload,now)).toBeNull();
});
it("retains a real zero without inventing a reset date",()=>{
 expect(readSubscriptionQuotaEvent({type:"codex.rate_limits",metered_limit_name:"codex",rate_limits:{secondary:{used_percent:0,reset_at:null}}},now)).toMatchObject({secondary:{usedPercent:0}});
 expect(readSubscriptionQuotaEvent({type:"codex.rate_limits",rate_limits:{secondary:{used_percent:0,reset_at:-1}}},now)?.secondary.resetAtMs).toBeUndefined();
});
