import { isQuotaCacheEntryExhausted } from "../quota-readiness.js";
import type { QuotaCacheEntry } from "../quota-cache.js";

export interface SubscriptionQuotaPreference {
 plan: "subscription" | "free" | "unknown";
 remainingPercent: number | null;
 resetAtMs: number | null;
 urgency: number | null;
 exhausted: boolean;
 observedAt: number | null;
}
export const SUBSCRIPTION_RESERVE_PERCENT = 5;
export const SUBSCRIPTION_QUOTA_MAX_AGE_MS = 15 * 60_000;

/** Scheduling hint only; percentages are not comparable dollar/token balances. */
export function subscriptionQuotaPreference(entry: QuotaCacheEntry | null | undefined, now: number): SubscriptionQuotaPreference {
 const planType = entry?.planType?.trim().toLowerCase();
 const plan = planType === "free" ? "free" : ["plus", "pro", "team", "business", "enterprise", "edu"].includes(planType ?? "") ? "subscription" : "unknown";
 const result: SubscriptionQuotaPreference = {plan, remainingPercent:null, resetAtMs:null, urgency:null, exhausted:isQuotaCacheEntryExhausted(entry,now), observedAt:entry?.updatedAt ?? null};
 if (!entry || !Number.isFinite(entry.updatedAt) || entry.updatedAt > now || now-entry.updatedAt > SUBSCRIPTION_QUOTA_MAX_AGE_MS || entry.status !== 200) return result;
 const windows = [entry.primary,entry.secondary].filter(w => typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 && !(typeof w.resetAtMs === "number" && w.resetAtMs <= now) && !(w.resetAtMs === undefined && typeof w.windowMinutes === "number" && w.windowMinutes > 0 && now >= entry.updatedAt + w.windowMinutes * 60_000));
 // Unknown reset of a tighter window must not be replaced with an easier window.
 windows.sort((a,b)=>(b.usedPercent ?? 0)-(a.usedPercent ?? 0) || (a.resetAtMs ?? Infinity)-(b.resetAtMs ?? Infinity));
 const window = windows[0];
 if (!window) return result;
 result.remainingPercent = 100-(window.usedPercent ?? 0);
 result.exhausted = result.remainingPercent === 0;
 if (typeof window.resetAtMs === "number" && Number.isFinite(window.resetAtMs) && window.resetAtMs > now) {
  result.resetAtMs=window.resetAtMs;
  result.urgency=result.remainingPercent/(Math.max(60_000,window.resetAtMs-now)/3_600_000);
 }
 return result;
}
export function usesSubscriptionReserve(preference: SubscriptionQuotaPreference | undefined): boolean {
 return preference?.remainingPercent !== null && preference?.remainingPercent !== undefined && preference.remainingPercent <= SUBSCRIPTION_RESERVE_PERCENT;
}
/** Negative means a should be used first. Equal hints leave existing health/affinity scoring intact. */
export function compareSubscriptionQuota(a: SubscriptionQuotaPreference, b: SubscriptionQuotaPreference): number {
 return Number(a.exhausted)-Number(b.exhausted) || Number(usesSubscriptionReserve(a))-Number(usesSubscriptionReserve(b)) || (a.resetAtMs ?? Infinity)-(b.resetAtMs ?? Infinity) || (b.remainingPercent ?? -1)-(a.remainingPercent ?? -1);
}
