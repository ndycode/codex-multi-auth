import { expect, it } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { carryRuntimeQuotaState } from "../lib/runtime/carry-runtime-quota-state.js";

it.each(["inventory", "reload"] as const)("preserves the %s cooldown predicate while retaining expired rejection history", mode => {
 for (const reason of ["auth-failure", "rate-limit"] as const) {
  const manager=new AccountManager(undefined,{version:3,activeIndex:0,accounts:[{recordId:"fixture",accountId:"workspace",refreshToken:"r",addedAt:1,lastUsed:1}]});
  const previous=manager.getAccountByIndex(0)!;
  previous.access="old";previous.coolingDownUntil=200;previous.cooldownReason=reason;previous.lastRateLimitReason="quota";
  previous.rateLimitResetTimes={codex:50};previous.resetReceiptGenerations={scope:4};
  previous.rateLimitObservations={codex:{revision:1,observedAt:1,reason:"quota",receiptGenerations:{scope:4}}};
  const live={...previous,access:"new",rateLimitResetTimes:{codex:300},rateLimitObservations:undefined,resetReceiptGenerations:undefined,coolingDownUntil:undefined,cooldownReason:undefined};
  carryRuntimeQuotaState(previous,live,100,mode==="inventory"
   ? (oldAccount,newAccount)=>oldAccount.access===newAccount.access
   : (oldAccount,newAccount)=>!(oldAccount.cooldownReason==="auth-failure"&&oldAccount.access!==newAccount.access));
  expect(live.rateLimitResetTimes.codex).toBe(300);
  expect(live.rateLimitObservations).toEqual(previous.rateLimitObservations);
  expect(live.resetReceiptGenerations).toEqual({scope:4});
  expect(live.coolingDownUntil).toBe(mode==="reload"&&reason==="rate-limit"?200:undefined);
 }
});
