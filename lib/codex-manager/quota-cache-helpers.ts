import {
	buildQuotaEmailFallbackState,
	findQuotaCacheEntryForAccount,
	quotaWorkspaceKey,
	type QuotaCacheAccountRef,
	hasSafeQuotaEmailFallback,
	hasUniqueQuotaAccountId,
	normalizeQuotaAccountId,
	normalizeQuotaEmail,
} from "../quota-readiness.js";
import {
	mergeQuotaCacheEntry,
	type QuotaCacheData,
	type QuotaCacheEntry,
} from "../quota-cache.js";
import type { CodexQuotaSnapshot } from "../quota-probe.js";
import {
	DEFAULT_MODEL,
	DEFAULT_PROBE_MODEL,
} from "../request/helpers/model-map.js";
import { getRateLimitResetTimeForFamily } from "../runtime/account-status.js";
import type { AccountMetadataV3 } from "../storage.js";

/**
 * Quota-cache lookup/update helpers shared by the manager CLI commands (audit
 * roadmap §4.1.1 phase 3). These previously lived as module-private helpers in
 * lib/codex-manager.ts and were closure-captured by the health check, the
 * forecast/repair dependency factories, and the login dashboard menu. Moved
 * verbatim so every consumer injects or imports the same single
 * implementation.
 */

/** Default model used for live quota probes across manager commands. */
export const DEFAULT_LIVE_PROBE_MODEL = DEFAULT_PROBE_MODEL;

/** Combine selected-workspace observations with persisted account-level rate-limit blockers. */
export function getPersistedQuotaViewForAccount(
	cache: QuotaCacheData | null,
	account: QuotaCacheAccountRef & Pick<AccountMetadataV3, "rateLimitResetTimes">,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	now: number,
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): QuotaCacheEntry | null {
	const cachedEntry = cache
		? findQuotaCacheEntryForAccount(cache, account, accounts, emailFallbackState)
		: null;
	const persistedResetAt = getRateLimitResetTimeForFamily(
		account,
		now,
		"codex",
	);
	if (typeof persistedResetAt !== "number") {
		return cachedEntry;
	}
	const cachedPrimaryResetAt = cachedEntry?.primary.resetAtMs ?? 0;
	const cachedSecondaryResetAt = cachedEntry?.secondary.resetAtMs ?? 0;
	if (
		cachedEntry?.status === 429 &&
		Math.max(cachedPrimaryResetAt, cachedSecondaryResetAt) >= persistedResetAt
	) {
		return cachedEntry;
	}
	return {
		updatedAt: cachedEntry?.updatedAt ?? now,
		status: 429,
		model: cachedEntry?.model ?? DEFAULT_MODEL,
		planType: cachedEntry?.planType,
		primary: {
			...cachedEntry?.primary,
			resetAtMs: Math.max(cachedPrimaryResetAt, persistedResetAt),
		},
		secondary: cachedEntry?.secondary ?? {},
	};
}

/** Retain only quota fields from a probe, never its credentials or response body. */
function quotaEntryFromSnapshot(snapshot: CodexQuotaSnapshot): QuotaCacheEntry {
	return {
		...(snapshot.primingCompleted ? {primingCompleted: true} : {}),
		...(snapshot.primingFailure ? {primingFailure: snapshot.primingFailure} : {}),
		...(snapshot.primingCompleted || snapshot.primingFailure ? { primingObservedAt: snapshot.primingObservedAt ?? Date.now() } : {}),
		updatedAt: snapshot.observedAt ?? Date.now(),
		status: snapshot.status,
		model: snapshot.model,
		planType: snapshot.planType,
		primary: {
			usedPercent: snapshot.primary.usedPercent,
			windowMinutes: snapshot.primary.windowMinutes,
			resetAtMs: snapshot.primary.resetAtMs,
		},
		secondary: {
			usedPercent: snapshot.secondary.usedPercent,
			windowMinutes: snapshot.secondary.windowMinutes,
			resetAtMs: snapshot.secondary.resetAtMs,
		},
	};
}

/** Update legacy stored-binding quota with a unique ID or safe email fallback. */
export function updateQuotaCacheForAccount(
	cache: QuotaCacheData,
	account: Pick<AccountMetadataV3, "accountId" | "email">,
	snapshot: CodexQuotaSnapshot,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): boolean {
	const nextEntry = quotaEntryFromSnapshot(snapshot);

	let changed = false;
	const accountId = normalizeQuotaAccountId(account.accountId);
	const hasUniqueAccountId =
		accountId !== null && hasUniqueQuotaAccountId(accounts, account);
	if (hasUniqueAccountId) {
		cache.byAccountId[accountId] = mergeQuotaCacheEntry(cache.byAccountId[accountId], nextEntry);
		changed = true;
	}
	const email = normalizeQuotaEmail(account.email);
	if (
		email &&
		hasSafeQuotaEmailFallback(emailFallbackState, account) &&
		!hasUniqueAccountId
	) {
		cache.byEmail[email] = mergeQuotaCacheEntry(cache.byEmail[email], nextEntry);
		changed = true;
	} else if (email && cache.byEmail[email]) {
		delete cache.byEmail[email];
		changed = true;
	}
	return changed;
}

/** Persist the observed workspace without attributing sibling quota to a stored binding. */
export function updateQuotaCacheForWorkspace(cache: QuotaCacheData, account: AccountMetadataV3, workspaceId: string, snapshot: CodexQuotaSnapshot, accounts: readonly AccountMetadataV3[]): void {
    const key = quotaWorkspaceKey(account, workspaceId);
    if (!key) return;
    cache.byWorkspace ??= {};
    cache.byWorkspace[key] = mergeQuotaCacheEntry(cache.byWorkspace[key], quotaEntryFromSnapshot(snapshot));
    if (workspaceId === normalizeQuotaAccountId(account.accountId)) {
        updateQuotaCacheForAccount(cache, account, snapshot, accounts);
    } else {
        // Retire the ambiguous fallback only after retaining its binding observation.
        const boundId = normalizeQuotaAccountId(account.accountId);
        const binding = boundId ? findQuotaCacheEntryForAccount(cache, account, accounts, undefined, boundId) : null;
        const boundKey = boundId && quotaWorkspaceKey(account, boundId);
        if (binding && boundKey) cache.byWorkspace[boundKey] = binding;
        const email = normalizeQuotaEmail(account.email);
        if (email) delete cache.byEmail[email];
    }
}

/** Clone every cache namespace; immutable entries may safely remain shared. */
export function cloneQuotaCacheData(cache: QuotaCacheData): QuotaCacheData {
	// Shallow spreading is safe because quota cache entries are always replaced,
	// never mutated in-place.
	return {
		byAccountId: { ...cache.byAccountId },
		byEmail: { ...cache.byEmail },
		...(cache.byWorkspace ? { byWorkspace: { ...cache.byWorkspace } } : {}),
	};
}

export function pruneUnsafeQuotaEmailCacheEntry(
	cache: QuotaCacheData,
	email: string | undefined,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): boolean {
	const normalizedEmail = normalizeQuotaEmail(email);
	if (!normalizedEmail || !cache.byEmail[normalizedEmail]) {
		return false;
	}
	const hasSafeFallbackAccount = accounts.some(
		(account) =>
			normalizeQuotaEmail(account.email) === normalizedEmail &&
			hasSafeQuotaEmailFallback(emailFallbackState, account),
	);
	if (hasSafeFallbackAccount) {
		return false;
	}
	delete cache.byEmail[normalizedEmail];
	return true;
}
