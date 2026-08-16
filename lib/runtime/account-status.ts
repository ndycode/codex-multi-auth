import { getQuotaKey } from "../accounts/rate-limits.js";
import type { ModelFamily } from "../prompts/codex.js";

export function resolveActiveIndex(
	storage: {
		activeIndex: number;
		activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
		accounts: unknown[];
	},
	family: ModelFamily = "codex",
): number {
	const total = storage.accounts.length;
	if (total === 0) return 0;
	const rawCandidate =
		storage.activeIndexByFamily?.[family] ?? storage.activeIndex;
	const raw = Number.isFinite(rawCandidate) ? rawCandidate : 0;
	return Math.max(0, Math.min(raw, total - 1));
}

export function getRateLimitResetTimeForFamily(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily,
): number | null {
	const times = account.rateLimitResetTimes;
	if (!times) return null;

	let minReset: number | null = null;
	const prefix = `${family}:`;
	for (const [key, value] of Object.entries(times)) {
		if (typeof value !== "number") continue;
		if (value <= now) continue;
		if (key !== family && !key.startsWith(prefix)) continue;
		if (minReset === null || value < minReset) {
			minReset = value;
		}
	}

	return minReset;
}

/**
 * The moment the account becomes usable again for a `family`/`model`
 * request: the LATEST bound among the records that actually gate that
 * request plus any active cooldown. Two deliberate differences from
 * getRateLimitResetTimeForFamily, whose earliest-reset answer feeds wait
 * displays: the account stays skipped while ANY gating record is active,
 * so the earliest reset would send clients back into a 503 — and only the
 * keys selection consults (`family`, plus `family:<model>` when a model is
 * known; see isRateLimitedForFamily) may contribute, because another
 * model's record does not block this request and would overstate its
 * recovery. Null when nothing bounds recovery.
 */
export function getAccountRecoveryTimeForFamily(
	account: {
		rateLimitResetTimes?: Record<string, number | undefined>;
		coolingDownUntil?: number;
	},
	now: number,
	family: ModelFamily,
	model?: string | null,
): number | null {
	let latest: number | null = null;
	const consider = (value: number | undefined): void => {
		if (typeof value !== "number" || !Number.isFinite(value)) return;
		if (value <= now) return;
		if (latest === null || value > latest) latest = value;
	};
	const times = account.rateLimitResetTimes;
	if (times) {
		consider(times[getQuotaKey(family)]);
		if (model) consider(times[getQuotaKey(family, model)]);
	}
	consider(account.coolingDownUntil);
	return latest;
}

export function formatRateLimitEntry(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	formatWaitTime: (ms: number) => string,
	family: ModelFamily = "codex",
): string | null {
	const resetAt = getRateLimitResetTimeForFamily(account, now, family);
	if (typeof resetAt !== "number") return null;
	const remaining = resetAt - now;
	if (remaining <= 0) return null;
	return `resets in ${formatWaitTime(remaining)}`;
}
