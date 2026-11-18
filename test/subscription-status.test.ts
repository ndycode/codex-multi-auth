import { updateQuotaCacheForWorkspace } from "../lib/codex-manager/quota-cache-helpers.js";
import { quotaWorkspaceKey } from "../lib/quota-readiness.js";
import type { QuotaCacheData } from "../lib/quota-cache.js";
import { expect, it } from "vitest";
import { subscriptionStatus, formatSubscriptionStatus } from "../lib/codex-manager/formatters/subscription-status.js";
import type { QuotaCacheEntry } from "../lib/quota-cache.js";
const now = 2_000_000;
const account = {refreshToken: "fixture", addedAt: 1, lastUsed: 1, workspaces: [{id: "personal", name: "Personal (role:owner) [id:secret]"}], currentWorkspaceIndex: 0};
const entry = (patch: Partial<QuotaCacheEntry> = {}): QuotaCacheEntry => ({updatedAt: now, status: 200, model: "fixture", planType: "promax", primary: {usedPercent: 0, windowMinutes: 10080, resetAtMs: now + 604800000}, secondary: {windowMinutes: 0, usedPercent: 0}, ...patch});
it("shows a readable plan, selected workspace and awaiting-first-use state", () => {
 const result = subscriptionStatus(account, entry(), {autoPrime: true}, now);
 expect(result).toMatchObject({planLabel: "Pro 500", selectedWorkspace: "Personal", primingState: "awaiting-first-use", autoPrime: true});
 expect(formatSubscriptionStatus(result)).toContain("Personal · Pro 500 · Auto-prime ON · Awaiting first use");
});
it("does not age a cached placeholder into a running countdown", () => {
 expect(subscriptionStatus(account, entry(), {autoPrime: true}, now + 60000).primingState).toBe("awaiting-first-use");
});
it("recognizes a running timer at zero percent and marks expired observations unknown", () => {
 const e = entry({primary: {usedPercent: 0, windowMinutes: 10080, resetAtMs: now + 600000000}});
 expect(subscriptionStatus(account, e, {autoPrime: false}, now).primingState).toBe("timer-running");
 expect(subscriptionStatus(account, e, {}, now + 31*60000)).toMatchObject({freshness: "stale", primingState: "unknown"});
});
it("preserves failure and completion evidence without claiming the timer was verified", () => {
 expect(subscriptionStatus(account, entry({primingFailure: "timed out"}), {}, now).primingState).toBe("failed");
 expect(subscriptionStatus(account, entry({primingCompleted: true, primary:{usedPercent:0,windowMinutes:10080,resetAtMs:now+604790000}}), {}, now).primingState).toBe("completed");
});
it("does not guess unknown tiers, missing observations, or blocked eligibility", () => {
 expect(subscriptionStatus(account, entry({planType: "future-pro"}), {}, now)).toMatchObject({planLabel: "Unknown plan", primingState: "unknown"});
 expect(subscriptionStatus(account, null, {}, now)).toMatchObject({freshness: "missing", primingState: "unknown"});
 expect(subscriptionStatus({...account, enabled: false}, entry(), {autoPrime: true}, now).automaticBlock).toBe("account disabled");
 expect(subscriptionStatus(account, entry({status: 429}), {}, now).primingState).toBe("unknown");
});

it("keeps policy availability separate from quota state", () => {
 expect(subscriptionStatus(account, entry(), undefined, now).autoPrime).toBeNull();
 expect(subscriptionStatus(account, entry({planType:"free"}), {}, now).primingState).toBe("not-applicable");
 expect(subscriptionStatus(account, entry({primary:{usedPercent:0.01,windowMinutes:300}}), {}, now).primingState).toBe("used");
});

it("keeps the header observation time when delayed checks save a placeholder", () => {
 const cache: QuotaCacheData = {byAccountId:{},byEmail:{}};
 updateQuotaCacheForWorkspace(cache, account, "personal", {...entry(), observedAt:now}, [account]);
 const saved = cache.byWorkspace![quotaWorkspaceKey(account,"personal")!]!;
 expect(saved.updatedAt).toBe(now);
 expect(subscriptionStatus(account, saved, {}, now+60000).primingState).toBe("awaiting-first-use");
});

it.each(["business", "enterprise", "future-pro"])("does not infer first-use state from %s quota activity", planType => {
 for (const primary of [{usedPercent: 10, windowMinutes: 300}, {usedPercent: 0, windowMinutes: 300, resetAtMs: now + 60000}]) {
  expect(subscriptionStatus(account, entry({planType, primary}), {}, now).primingState).toBe(planType === "future-pro" ? "unknown" : "not-applicable");
 }
});

it("finds a successful check observation for a token-only binding", async () => {
 const {findQuotaCacheEntryForAccount} = await import("../lib/quota-readiness.js");
 const {automaticCheckWorkspaceId} = await import("../lib/runtime/automatic-account-checks.js");
 const tokenOnly = {refreshToken:"fixture", addedAt:1, lastUsed:1, accessToken:`e30.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"token-workspace"}})).toString("base64url")}.fixture`};
 const cache: QuotaCacheData = {byAccountId:{},byEmail:{}};
 const workspace = automaticCheckWorkspaceId(tokenOnly)!;
 expect(workspace).toBe("token-workspace");
 updateQuotaCacheForWorkspace(cache, tokenOnly, workspace, {...entry(), observedAt:now}, [tokenOnly]);
 expect(subscriptionStatus(tokenOnly, findQuotaCacheEntryForAccount(cache, tokenOnly, [tokenOnly]), {}, now)).toMatchObject({planLabel:"Pro 500", freshness:"fresh", primingState:"awaiting-first-use"});
});
