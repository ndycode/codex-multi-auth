import type { QuotaSchedulerSnapshot, QuotaSchedulerWindow } from "../preemptive-quota-scheduler.js";
import { isRecord } from "../utils.js";

function windowFromEvent(value: unknown): QuotaSchedulerWindow {
	if (!isRecord(value)) return {};
	const used = value.used_percent;
	if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return {};
	const reset = value.reset_at;
	return {
		usedPercent: used,
		...(typeof reset === "number" && Number.isSafeInteger(reset) && reset > 0 && Number.isSafeInteger(reset * 1000)
			? { resetAtMs: reset * 1000 } : {}),
	};
}

/** Native codex.rate_limits frames carry quota on every reused WebSocket turn. */
export function readSubscriptionQuotaEvent(
	event: unknown,
	now: number,
): (QuotaSchedulerSnapshot & { planType?: string }) | null {
	if (!isRecord(event) || event.type !== "codex.rate_limits" || !isRecord(event.rate_limits)) return null;
	// Distinct metered pools must not overwrite the ordinary subscription balance.
	const limit = event.metered_limit_name ?? event.limit_name;
	if (limit !== undefined && limit !== null && (typeof limit !== "string" || limit.trim().toLowerCase() !== "codex")) return null;
	const primary = windowFromEvent(event.rate_limits.primary);
	const secondary = windowFromEvent(event.rate_limits.secondary);
	if (primary.usedPercent === undefined && secondary.usedPercent === undefined) return null;
	return {
		status: 200, updatedAt: now, primary, secondary,
		...(typeof event.plan_type === "string" ? { planType: event.plan_type } : {}),
	};
}
