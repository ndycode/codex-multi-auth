import type { QuotaCacheData, QuotaCacheEntry, QuotaCacheWindow } from "./quota-cache.js";
import type { AccountMetadataV3 } from "./storage.js";

export type QuotaCacheAccountRef = Pick<AccountMetadataV3, "accountId" | "email">;

type QuotaWindowLike = Pick<QuotaCacheWindow, "usedPercent">;

function normalizeAccountId(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: string | undefined): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : null;
}

function accountIdIsUnique(
	accounts: readonly QuotaCacheAccountRef[],
	account: QuotaCacheAccountRef,
): boolean {
	const accountId = normalizeAccountId(account.accountId);
	if (!accountId) return false;
	let count = 0;
	for (const candidate of accounts) {
		if (normalizeAccountId(candidate.accountId) === accountId) count += 1;
	}
	return count === 1;
}

function emailIsSafeFallback(
	accounts: readonly QuotaCacheAccountRef[],
	account: QuotaCacheAccountRef,
): boolean {
	const email = normalizeEmail(account.email);
	if (!email) return false;
	const distinctIds = new Set<string>();
	let matches = 0;
	for (const candidate of accounts) {
		if (normalizeEmail(candidate.email) !== email) continue;
		matches += 1;
		const candidateId = normalizeAccountId(candidate.accountId);
		if (candidateId) distinctIds.add(candidateId);
	}
	return matches === 1 && distinctIds.size <= 1;
}

export function quotaLeftPercentFromUsed(
	usedPercent: number | undefined,
): number | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return undefined;
	}
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function quotaWindowIsExhausted(window: QuotaWindowLike | undefined): boolean {
	const leftPercent = quotaLeftPercentFromUsed(window?.usedPercent);
	return typeof leftPercent === "number" && leftPercent <= 0;
}

export function isQuotaCacheEntryExhausted(
	entry: Pick<QuotaCacheEntry, "primary" | "secondary"> | null | undefined,
): boolean {
	// Codex quota windows are cumulative gates: a 0% remaining active window blocks use
	// even if another window still has quota left.
	return (
		quotaWindowIsExhausted(entry?.primary) ||
		quotaWindowIsExhausted(entry?.secondary)
	);
}

export function findQuotaCacheEntryForAccount(
	cache: QuotaCacheData | null | undefined,
	account: QuotaCacheAccountRef,
	accounts: readonly QuotaCacheAccountRef[],
): QuotaCacheEntry | null {
	if (!cache) return null;
	const accountId = normalizeAccountId(account.accountId);
	if (accountId && accountIdIsUnique(accounts, account) && cache.byAccountId[accountId]) {
		return cache.byAccountId[accountId] ?? null;
	}
	const email = normalizeEmail(account.email);
	if (email && emailIsSafeFallback(accounts, account) && cache.byEmail[email]) {
		return cache.byEmail[email] ?? null;
	}
	return null;
}
