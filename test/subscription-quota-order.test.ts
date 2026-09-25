import {describe,it,expect} from "vitest";
import {subscriptionQuotaPreference,compareSubscriptionQuota} from "../lib/runtime/subscription-quota-order.js";
const now=1000000;
const quota=(left:number,hours:number,planType="pro")=>({status:200,updatedAt:now,model:"fixture",planType,primary:{},secondary:{usedPercent:100-left,resetAtMs:now+hours*3600000}});
describe("subscription quota order",()=>{
 it("prefers more available quota with less time before reset",()=>{
  expect(compareSubscriptionQuota(subscriptionQuotaPreference(quota(40,2),now),subscriptionQuotaPreference(quota(10,24),now))).toBeLessThan(0);
 });
 it("uses reset time before remaining quota",()=>{
  expect(compareSubscriptionQuota(subscriptionQuotaPreference(quota(20,2),now),subscriptionQuotaPreference(quota(60,12),now))).toBeLessThan(0);
 });
 it("uses the most depleted active window and does not rank expired, missing or stale observations as fresh",()=>{
  const entry={...quota(40,24),primary:{usedPercent:95,resetAtMs:now+3600000}};
  expect(subscriptionQuotaPreference(entry,now)).toMatchObject({remainingPercent:5,resetAtMs:now+3600000,urgency:5});
  expect(subscriptionQuotaPreference(quota(100,-1),now).urgency).toBeNull();
  expect(subscriptionQuotaPreference({...quota(50,24),updatedAt:now-3600000},now).urgency).toBeNull();
  expect(subscriptionQuotaPreference(null,now).plan).toBe("unknown");
 });
 it("does not treat a paid login as a billing-policy override and preserves the reserve",()=>{
  const reserve=subscriptionQuotaPreference(quota(5,1),now);
  const ordinary=subscriptionQuotaPreference(quota(20,168,"free"),now);
  expect(compareSubscriptionQuota(ordinary,reserve)).toBeLessThan(0);
 });
 it("does not mistake fractional remaining quota for exhaustion",()=>{
  expect(subscriptionQuotaPreference(quota(0.4,1),now).exhausted).toBe(false);
  expect(subscriptionQuotaPreference(quota(0,1),now).exhausted).toBe(true);
 });
});

it("reserves exactly five percent and keeps exhaustion until reset even if the observation ages",async()=>{
 const {usesSubscriptionReserve}=await import("../lib/runtime/subscription-quota-order.js");
 expect(usesSubscriptionReserve(subscriptionQuotaPreference(quota(5.1,1),now))).toBe(false);
 expect(usesSubscriptionReserve(subscriptionQuotaPreference(quota(5,1),now))).toBe(true);
 expect(subscriptionQuotaPreference({...quota(0,24),updatedAt:now-3600000},now).exhausted).toBe(true);
 expect(subscriptionQuotaPreference({...quota(0,-1),updatedAt:now-3600000},now).exhausted).toBe(false);
});

it("prioritizes an earlier reset even when a later reset has far more remaining quota",()=>{
 expect(compareSubscriptionQuota(subscriptionQuotaPreference(quota(7,2),now),subscriptionQuotaPreference(quota(90,3),now))).toBeLessThan(0);
 expect(compareSubscriptionQuota(subscriptionQuotaPreference(quota(40,2),now),subscriptionQuotaPreference(quota(10,2),now))).toBeLessThan(0);
});

const unusedQuota = () => ({...quota(100,24), secondary:{usedPercent:0}});

it("does not prioritize an unused subscription over an established earlier reset",()=>{
 expect(compareSubscriptionQuota(subscriptionQuotaPreference(unusedQuota(),now),subscriptionQuotaPreference(quota(30,1),now))).toBeGreaterThan(0);
});
