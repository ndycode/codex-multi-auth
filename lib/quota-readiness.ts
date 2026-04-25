import type { QuotaCacheData, QuotaCacheEntry, QuotaCacheWindow } from "./quota-cache.js";
import type { AccountMetadataV3 } from "./storage.js";

export type QuotaCacheAccountRef = Pick<AccountMetadataV3, "accountId" | "email">;

type QuotaWindowLike = Pick<QuotaCacheWindow, "usedPercent" | "resetAtMs">;

export function normalizeQuotaAccountId(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function normalizeQuotaEmail(value: string | undefined): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function hasUniqueQuotaAccountId(
	accounts: readonly QuotaCacheAccountRef[],
	account: QuotaCacheAccountRef,
): boolean {
	const accountId = normalizeQuotaAccountId(account.accountId);
	if (!accountId) return false;
	let count = 0;
	for (const candidate of accounts) {
		if (normalizeQuotaAccountId(candidate.accountId) === accountId) count += 1;
	}
	return count === 1;
}

export type QuotaEmailFallbackState = {
	matchingCount: number;
	distinctAccountIds: Set<string>;
};

export function buildQuotaEmailFallbackState(
	accounts: readonly QuotaCacheAccountRef[],
): ReadonlyMap<string, QuotaEmailFallbackState> {
	const stateByEmail = new Map<string, QuotaEmailFallbackState>();
	for (const account of accounts) {
		const email = normalizeQuotaEmail(account.email);
		if (!email) continue;
		const existing = stateByEmail.get(email);
		const accountId = normalizeQuotaAccountId(account.accountId);
		if (existing) {
			existing.matchingCount += 1;
			if (accountId) existing.distinctAccountIds.add(accountId);
			continue;
		}
		const distinctAccountIds = new Set<string>();
		if (accountId) distinctAccountIds.add(accountId);
		stateByEmail.set(email, { matchingCount: 1, distinctAccountIds });
	}
	return stateByEmail;
}

export function hasSafeQuotaEmailFallback(
	emailFallbackState: ReadonlyMap<string, QuotaEmailFallbackState>,
	account: QuotaCacheAccountRef,
): boolean {
	const email = normalizeQuotaEmail(account.email);
	if (!email) return false;
	const state = emailFallbackState.get(email);
	if (!state) return false;
	return state.matchingCount === 1 && state.distinctAccountIds.size <= 1;
}

export function quotaLeftPercentFromUsed(
	usedPercent: number | undefined,
): number | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return undefined;
	}
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function quotaWindowIsExhausted(
	window: QuotaWindowLike | undefined,
	now = Date.now(),
): boolean {
	if (typeof window?.resetAtMs === "number" && now >= window.resetAtMs) {
		return false;
	}
	const leftPercent = quotaLeftPercentFromUsed(window?.usedPercent);
	return typeof leftPercent === "number" && leftPercent <= 0;
}

export function isQuotaCacheEntryExhausted(
	entry: Pick<QuotaCacheEntry, "primary" | "secondary"> | null | undefined,
	now = Date.now(),
): boolean {
	// Codex quota windows are cumulative gates: a 0% remaining active window blocks use
	// even if another window still has quota left.
	return (
		quotaWindowIsExhausted(entry?.primary, now) ||
		quotaWindowIsExhausted(entry?.secondary, now)
	);
}

export function findQuotaCacheEntryForAccount(
	cache: QuotaCacheData | null | undefined,
	account: QuotaCacheAccountRef,
	accounts: readonly QuotaCacheAccountRef[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): QuotaCacheEntry | null {
	if (!cache) return null;
	const accountId = normalizeQuotaAccountId(account.accountId);
	if (accountId && hasUniqueQuotaAccountId(accounts, account) && cache.byAccountId[accountId]) {
		return cache.byAccountId[accountId] ?? null;
	}
	const email = normalizeQuotaEmail(account.email);
	if (email && hasSafeQuotaEmailFallback(emailFallbackState, account) && cache.byEmail[email]) {
		return cache.byEmail[email] ?? null;
	}
	return null;
}
