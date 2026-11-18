import type { AccountPolicy } from "../../account-policy.js";
import type { QuotaCacheEntry } from "../../quota-cache.js";
import type { AccountMetadataV3 } from "../../storage.js";
import { needsSubscriptionFirstUse } from "../../runtime/subscription-first-use.js";

const PLAN_LABELS = new Map([
	["free", "Free"], ["plus", "Plus"], ["pro", "Pro 200"],
	["prolite", "Pro 100"], ["promax", "Pro 500"], ["team", "Business"],
	["business", "Business"], ["enterprise", "Enterprise"], ["edu", "Edu"],
]);
const STATE_LABELS = {
	unknown: "Priming status unknown",
	"awaiting-first-use": "Awaiting first use",
	"timer-running": "Reset timer running",
	used: "Usage recorded",
	completed: "First-use completed; timer not yet verified",
	failed: "Priming failed",
	"not-applicable": "Priming not applicable",
};
type PrimingState = keyof typeof STATE_LABELS;

/** Display only observed evidence; never age a placeholder into a running timer. */
export function subscriptionStatus(
	account: AccountMetadataV3,
	entry: QuotaCacheEntry | null,
	policy: Partial<AccountPolicy> | undefined,
	now: number,
) {
	const workspace = account.workspaces?.[account.currentWorkspaceIndex ?? 0];
	const selectedWorkspace = workspace
		? workspace.name?.replace(/\s*\(role:.*$|\s*\[id:.*$/g, "").trim() || "Unnamed workspace"
		: account.workspaces?.length ? "Invalid workspace selection" : "Stored binding (workspace unknown)";
	const freshness = !entry ? "missing"
		: entry.updatedAt > now || now - entry.updatedAt > 30 * 60000 ? "stale" : "fresh";
	const planType = entry?.planType?.trim().toLowerCase() ?? null;
	const planLabel = PLAN_LABELS.get(planType ?? "") ?? "Unknown plan";
	let primingState: PrimingState = "unknown";
	if (entry && freshness === "fresh" && entry.status === 200) {
		const windows = [entry.primary, entry.secondary].filter(w => w.windowMinutes !== 0);
		if (!planType || !PLAN_LABELS.has(planType)) primingState = "unknown";
		else if (!["plus", "pro", "prolite", "promax"].includes(planType)) primingState = "not-applicable";
		else if (entry.primingFailure) primingState = "failed";
		else if (entry.primingCompleted) primingState = "completed";
		else if (windows.some(w => typeof w.usedPercent === "number" && w.usedPercent > 0)) {
			primingState = "used";
		} else if (windows.some(w =>
			typeof w.windowMinutes === "number" && w.windowMinutes > 0 &&
			typeof w.resetAtMs === "number" && w.resetAtMs > now &&
			w.resetAtMs - entry.updatedAt < w.windowMinutes * 60000 - 2000
		)) {
			primingState = "timer-running";
		} else if (needsSubscriptionFirstUse(entry, entry.updatedAt)) {
			primingState = "awaiting-first-use";
		}
	}
	const automaticBlock = account.enabled === false ? "account disabled"
		: account.authInvalidatedAt ? "sign-in required"
		: policy?.paused ? "paused"
		: policy?.drained ? "drained"
		: (account.coolingDownUntil ?? 0) > now ? "cooling down"
		: account.workspaces?.length && (!workspace || workspace.enabled === false) ? "workspace unavailable"
		: null;
	return {
		planType, planLabel, selectedWorkspace,
		autoPrime: policy ? policy.autoPrime === true : null,
		primingState, primingFailure: entry?.primingFailure ?? null,
		automaticBlock, freshness, observedAt: entry?.updatedAt ?? null,
	};
}

export function formatSubscriptionStatus(value: ReturnType<typeof subscriptionStatus>): string {
	const freshness = value.freshness === "stale" ? " (stale; run check accounts)"
		: value.freshness === "missing" ? " (not observed)" : "";
	const autoPrime = value.autoPrime === null ? "unknown" : value.autoPrime ? "ON" : "OFF";
	const block = value.automaticBlock ? `; blocked: ${value.automaticBlock}` : "";
	return `${value.selectedWorkspace} · ${value.planLabel}${freshness} · Auto-prime ${autoPrime} · ${STATE_LABELS[value.primingState]}${block}`;
}
