import {
	buildQuotaEmailFallbackState,
	hasSafeQuotaEmailFallback,
	hasUniqueQuotaAccountId,
	normalizeQuotaAccountId,
	normalizeQuotaEmail,
} from "../quota-readiness.js";
import {
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

function getQuotaCacheEntryForAccount(
	cache: QuotaCacheData,
	account: Pick<AccountMetadataV3, "accountId" | "email">,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): QuotaCacheEntry | null {
	const accountId = normalizeQuotaAccountId(account.accountId);
	if (
		accountId &&
		hasUniqueQuotaAccountId(accounts, account) &&
		cache.byAccountId[accountId]
	) {
		return cache.byAccountId[accountId] ?? null;
	}
	const email = normalizeQuotaEmail(account.email);
	if (
		email &&
		hasSafeQuotaEmailFallback(emailFallbackState, account) &&
		cache.byEmail[email]
	) {
		return cache.byEmail[email] ?? null;
	}
	return null;
}

export function getPersistedQuotaViewForAccount(
	cache: QuotaCacheData | null,
	account: Pick<
		AccountMetadataV3,
		"accountId" | "email" | "rateLimitResetTimes"
	>,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	now: number,
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): QuotaCacheEntry | null {
	const cachedEntry = cache
		? getQuotaCacheEntryForAccount(cache, account, accounts, emailFallbackState)
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

export function updateQuotaCacheForAccount(
	cache: QuotaCacheData,
	account: Pick<AccountMetadataV3, "accountId" | "email">,
	snapshot: CodexQuotaSnapshot,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): boolean {
	const nextEntry: QuotaCacheEntry = {
		updatedAt: Date.now(),
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

	let changed = false;
	const accountId = normalizeQuotaAccountId(account.accountId);
	const hasUniqueAccountId =
		accountId !== null && hasUniqueQuotaAccountId(accounts, account);
	if (hasUniqueAccountId) {
		cache.byAccountId[accountId] = nextEntry;
		changed = true;
	}
	const email = normalizeQuotaEmail(account.email);
	if (
		email &&
		hasSafeQuotaEmailFallback(emailFallbackState, account) &&
		!hasUniqueAccountId
	) {
		cache.byEmail[email] = nextEntry;
		changed = true;
	} else if (email && cache.byEmail[email]) {
		delete cache.byEmail[email];
		changed = true;
	}
	return changed;
}

export function cloneQuotaCacheData(cache: QuotaCacheData): QuotaCacheData {
	// Shallow spreading is safe because quota cache entries are always replaced,
	// never mutated in-place.
	return {
		byAccountId: { ...cache.byAccountId },
		byEmail: { ...cache.byEmail },
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
