import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import { formatWaitTime } from "./rate-limits.js";

export interface ActiveAccountStorageView {
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
	accounts: unknown[];
}

export interface AccountRateLimitView {
	rateLimitResetTimes?: Record<string, number | undefined>;
}

export type ActiveIndexByFamilyView = Partial<Record<ModelFamily, number>> | undefined;

export function resolveActiveIndex(
	storage: ActiveAccountStorageView,
	family: ModelFamily = "codex",
): number {
	const total = storage.accounts.length;
	if (total === 0) return 0;
	const rawCandidate = storage.activeIndexByFamily?.[family] ?? storage.activeIndex;
	const raw = Number.isFinite(rawCandidate) ? Math.floor(rawCandidate) : 0;
	return Math.max(0, Math.min(raw, total - 1));
}

export function getRateLimitResetTimeForFamily(
	account: AccountRateLimitView,
	now: number,
	family: ModelFamily,
): number | null {
	const times = account.rateLimitResetTimes;
	if (!times) return null;

	let minReset: number | null = null;
	const prefix = `${family}:`;
	for (const [key, value] of Object.entries(times)) {
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		if (value <= now) continue;
		if (key !== family && !key.startsWith(prefix)) continue;
		if (minReset === null || value < minReset) {
			minReset = value;
		}
	}

	return minReset;
}

export function formatRateLimitEntry(
	account: AccountRateLimitView,
	now: number,
	family: ModelFamily = "codex",
): string | null {
	const resetAt = getRateLimitResetTimeForFamily(account, now, family);
	if (typeof resetAt !== "number") return null;
	const remaining = resetAt - now;
	if (remaining <= 0) return null;
	return `resets in ${formatWaitTime(remaining)}`;
}

export function formatRateLimitStatusByFamily(
	account: AccountRateLimitView,
	now: number,
	families: readonly ModelFamily[] = MODEL_FAMILIES,
): string[] {
	return families.map((family) => {
		const resetAt = getRateLimitResetTimeForFamily(account, now, family);
		if (typeof resetAt !== "number") return `${family}=ok`;
		return `${family}=${formatWaitTime(resetAt - now)}`;
	});
}

export function formatActiveIndexByFamilyLabels(
	activeIndexByFamily: ActiveIndexByFamilyView,
	families: readonly ModelFamily[] = MODEL_FAMILIES,
): string[] {
	return families.map((family) => {
		const idx = activeIndexByFamily?.[family];
		const label = typeof idx === "number" && Number.isFinite(idx) ? String(idx + 1) : "-";
		return `${family}: ${label}`;
	});
}
