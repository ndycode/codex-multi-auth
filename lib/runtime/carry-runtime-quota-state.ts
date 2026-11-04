import { cloneRateLimitObservation, type ManagedAccount } from "../accounts.js";

/** Identity matching belongs to the caller; preserve chronology even after timers expire. */
export function carryRuntimeQuotaState(
 previous: ManagedAccount, live: ManagedAccount, now: number,
 shouldCarryCooldown: (previous: ManagedAccount, live: ManagedAccount) => boolean,
): void {
 live.resetReceiptIdentities = previous.resetReceiptIdentities && { ...previous.resetReceiptIdentities };
 live.resetReceiptGenerations = previous.resetReceiptGenerations && { ...previous.resetReceiptGenerations };
 for (const [key, until] of Object.entries(previous.rateLimitResetTimes)) {
  if (typeof until === "number" && until > now) live.rateLimitResetTimes[key] = Math.max(live.rateLimitResetTimes[key] ?? 0, until);
 }
 for (const [key, observation] of Object.entries(previous.rateLimitObservations ?? {})) {
  (live.rateLimitObservations ??= {})[key] = cloneRateLimitObservation(observation);
 }
 if ((previous.coolingDownUntil ?? 0) > (live.coolingDownUntil ?? 0) && shouldCarryCooldown(previous, live)) {
  live.coolingDownUntil = previous.coolingDownUntil;
  live.cooldownReason = previous.cooldownReason;
  live.lastRateLimitReason = previous.lastRateLimitReason;
 }
}
