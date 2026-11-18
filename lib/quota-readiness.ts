import { RATE_LIMIT_CACHE_TTL_MS } from "./constants.js";
import { extractAccountId, nativeWorkspaceIdentity } from "./auth/token-utils.js";
import { createHash } from "node:crypto";
import { resolveAccountRecordId } from "./storage/record-identity.js";
import type { QuotaCacheData, QuotaCacheEntry, QuotaCacheWindow } from "./quota-cache.js";
import type { AccountMetadataV3 } from "./storage.js";

export type QuotaCacheAccountRef = Pick<AccountMetadataV3, "accountId" | "email" | "recordId" | "workspaces" | "currentWorkspaceIndex"> & Partial<Pick<AccountMetadataV3, "refreshToken" | "addedAt" | "accessToken" | "codexCliMirror">>;

type QuotaWindowLike = Pick<QuotaCacheWindow, "usedPercent" | "resetAtMs" | "windowMinutes">;

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

// A window is exhausted only when it is genuinely at/over 100% used. Base this on
// the RAW usedPercent, never the rounded quotaLeftPercentFromUsed: rounding
// 100 - 99.6 = 0.4 down to 0 left-percent would falsely bench a window that still
// has ~0.4% quota (any usedPercent in (99.5, 100) rounds to 0 left). The header
// parser preserves fractional used-percent, so this input is expected;
// quotaLeftPercentFromUsed stays for DISPLAY only.
export function quotaUsedPercentIsExhausted(
	usedPercent: number | undefined,
): boolean {
	return (
		typeof usedPercent === "number" &&
		Number.isFinite(usedPercent) &&
		usedPercent >= 100
	);
}

function quotaWindowIsExhausted(
	window: QuotaWindowLike | undefined,
	now = Date.now(),
	updatedAt?: number,
): boolean {
	if (typeof window?.resetAtMs === "number" && now >= window.resetAtMs) {
		return false;
	}
	// quota-forecast-02: a window can be 100% used with NO resetAtMs. Without a
	// staleness escape that reads as "exhausted forever". When we know when the
	// snapshot was taken (updatedAt) and the window length (windowMinutes),
	// synthesize a conservative expiry: once a full window has elapsed since the
	// snapshot, the window must have rolled over, so stop treating it as exhausted.
	if (
		typeof window?.resetAtMs !== "number" &&
		typeof updatedAt === "number" &&
		typeof window?.windowMinutes === "number" &&
		window.windowMinutes > 0 &&
		now >= updatedAt + window.windowMinutes * 60_000
	) {
		return false;
	}
	return quotaUsedPercentIsExhausted(window?.usedPercent);
}

export function isQuotaCacheEntryExhausted(
	entry: Pick<QuotaCacheEntry, "primary" | "secondary"> & { updatedAt?: number } | null | undefined,
	now = Date.now(),
): boolean {
	// Codex quota windows are cumulative gates: a 0% remaining active window blocks use
	// even if another window still has quota left.
	const updatedAt = entry?.updatedAt;
	// Stale usage is unknown, not proof that the server still rejects requests.
	if (
		typeof updatedAt === "number" &&
		Number.isFinite(updatedAt) &&
		now >= updatedAt + RATE_LIMIT_CACHE_TTL_MS
	) return false;
	return (
		quotaWindowIsExhausted(entry?.primary, now, updatedAt) ||
		quotaWindowIsExhausted(entry?.secondary, now, updatedAt)
	);
}

/** Cache identity includes the credential record, so shared organization IDs cannot collide. */
export function quotaWorkspaceKey(account: QuotaCacheAccountRef, workspaceId: string): string | undefined {
    const recordId = account.recordId?.trim() || (account.refreshToken !== undefined && account.addedAt !== undefined
        ? resolveAccountRecordId({ ...account, refreshToken: account.refreshToken, addedAt: account.addedAt }) : undefined);
    return recordId ? createHash("sha256").update(JSON.stringify(["oauth", recordId, workspaceId.trim()])).digest("hex") : undefined;
}

/** Display the selected workspace; callers routing another scope must pass that exact workspace. */
export function quotaWorkspaceId(account: QuotaCacheAccountRef): string | undefined {
    const selectedId = account.workspaces?.length
        ? account.workspaces[account.currentWorkspaceIndex ?? 0]?.id.trim()
        : account.accountId?.trim() || extractAccountId(account.accessToken);
    return nativeWorkspaceIdentity({ access: account.accessToken, codexCliMirror: account.codexCliMirror }, selectedId);
}

/** Read exact-workspace quota, using legacy binding entries only for that binding. */
export function findQuotaCacheEntryForAccount(
	cache: QuotaCacheData | null | undefined,
	account: QuotaCacheAccountRef,
	accounts: readonly QuotaCacheAccountRef[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
	workspaceId = quotaWorkspaceId(account),
): QuotaCacheEntry | null {
	if (!cache) return null;
	const key = workspaceId && quotaWorkspaceKey(account, workspaceId);
    const scoped = key ? cache.byWorkspace?.[key] : undefined;
    // Legacy entries describe only the stored binding, never a sibling workspace.
    // A workspaces-bearing account whose selection does not resolve (invalid index
    // or blank id) has no valid binding at all — never fall back to legacy keys.
    if (
        normalizeQuotaAccountId(workspaceId) !== normalizeQuotaAccountId(account.accountId) ||
        (account.workspaces?.length && !normalizeQuotaAccountId(workspaceId))
    ) return scoped ?? null;
    const accountId = normalizeQuotaAccountId(account.accountId);
    const newer = (legacy: QuotaCacheEntry | undefined) => scoped && (!legacy || scoped.updatedAt >= legacy.updatedAt) ? scoped : legacy ?? null;
	if (accountId && hasUniqueQuotaAccountId(accounts, account) && cache.byAccountId[accountId]) {
		return newer(cache.byAccountId[accountId]);
	}
	const email = normalizeQuotaEmail(account.email);
	if (email && hasSafeQuotaEmailFallback(emailFallbackState, account) && cache.byEmail[email]) {
		return newer(cache.byEmail[email]);
	}
	return scoped ?? null;
}
