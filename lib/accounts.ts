import type { Auth } from "@codex-ai/sdk";
import { createLogger } from "./logger.js";
import {
	loadAccounts,
	saveAccounts,
	type AccountStorageV3,
	type CooldownReason,
	type RateLimitStateV3,
	findMatchingAccountIndex,
	withAccountStorageTransaction,
} from "./storage.js";
import type { AccountIdSource, OAuthAuthDetails } from "./types.js";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";
import {
	getHealthTracker,
	getTokenTracker,
	selectHybridAccount,
	type AccountWithMetrics,
	type HybridSelectionOptions,
} from "./rotation.js";
import { nowMs } from "./utils.js";
import { ERROR_MESSAGES, HTTP_STATUS } from "./constants.js";
import { CodexAuthError } from "./errors.js";
import {
	loadCodexCliState,
	type CodexCliTokenCacheEntry,
} from "./codex-cli/state.js";
import { syncAccountStorageFromCodexCli } from "./codex-cli/sync.js";
import { setCodexCliActiveSelection } from "./codex-cli/writer.js";

export {
	extractAccountId,
	extractAccountEmail,
	getAccountIdCandidates,
	selectBestAccountCandidate,
	resolveRuntimeRequestIdentity,
	shouldUpdateAccountIdFromToken,
	resolveRequestAccountId,
	sanitizeEmail,
	type AccountIdCandidate,
} from "./auth/token-utils.js";

export {
	parseRateLimitReason,
	getQuotaKey,
	clampNonNegativeInt,
	clearExpiredRateLimits,
	isRateLimitedForQuotaKey,
	isRateLimitedForFamily,
	formatWaitTime,
	type QuotaKey,
	type BaseQuotaKey,
	type RateLimitReason,
	type RateLimitState,
	type RateLimitedEntity,
} from "./accounts/rate-limits.js";

export {
	lookupCodexCliTokensByEmail,
	isCodexCliSyncEnabled,
	type CodexCliTokenCacheEntry,
} from "./codex-cli/state.js";

import {
	extractAccountId,
	extractAccountEmail,
	shouldUpdateAccountIdFromToken,
	sanitizeEmail,
} from "./auth/token-utils.js";
import {
	clampNonNegativeInt,
	getQuotaKey,
	clearExpiredRateLimits,
	isRateLimitedForFamily,
	formatWaitTime,
	type RateLimitReason,
} from "./accounts/rate-limits.js";

const log = createLogger("accounts");

function initFamilyState(defaultValue: number): Record<ModelFamily, number> {
	return Object.fromEntries(
		MODEL_FAMILIES.map((family) => [family, defaultValue]),
	) as Record<ModelFamily, number>;
}

type AccountIdentityCandidate = Pick<
	ManagedAccount,
	"accountId" | "email" | "refreshToken"
> & {
	index?: number;
};

function getAuthIdentityCandidate(
	auth: OAuthAuthDetails | undefined,
): AccountIdentityCandidate {
	const accountId = extractAccountId(auth?.access)?.trim() || undefined;
	const email = sanitizeEmail(extractAccountEmail(auth?.access));
	return {
		accountId,
		email,
		refreshToken: auth?.refresh,
	};
}

function buildAccountIdentityCandidates(
	source: AccountIdentityCandidate,
	auth?: OAuthAuthDetails,
): AccountIdentityCandidate[] {
	const derived = getAuthIdentityCandidate(auth);
	const candidates: AccountIdentityCandidate[] = [];
	const seen = new Set<string>();

	const pushCandidate = (candidate: AccountIdentityCandidate): void => {
		const key = `${candidate.accountId ?? ""}|${candidate.email ?? ""}|${candidate.refreshToken ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(candidate);
	};

	pushCandidate(source);
	pushCandidate({
		accountId: source.accountId ?? derived.accountId,
		email: source.email ?? derived.email,
		refreshToken: source.refreshToken,
		index: source.index,
	});
	pushCandidate({
		accountId: derived.accountId ?? source.accountId,
		email: derived.email ?? source.email,
		refreshToken: source.refreshToken,
		index: source.index,
	});
	pushCandidate({
		accountId: derived.accountId ?? source.accountId,
		email: derived.email ?? source.email,
		refreshToken: derived.refreshToken ?? source.refreshToken,
		index: source.index,
	});

	return candidates;
}

function findAccountIndexByIdentity<
	T extends Pick<AccountIdentityCandidate, "accountId" | "email" | "refreshToken">,
>(
	accounts: readonly T[],
	source: AccountIdentityCandidate,
	auth?: OAuthAuthDetails,
): number | undefined {
	for (const candidate of buildAccountIdentityCandidates(source, auth)) {
		const matchIndex = findMatchingAccountIndex(accounts, candidate, {
			allowUniqueAccountIdFallbackWithoutEmail: true,
		});
		if (matchIndex !== undefined) {
			return matchIndex;
		}
	}
	return undefined;
}

const RETRYABLE_AUTH_PERSISTENCE_CODES = new Set(["EAGAIN", "EBUSY", "EPERM"]);

function isRetryableAuthPersistenceError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}

	const candidate = error as {
		code?: unknown;
		status?: unknown;
		cause?: unknown;
	};
	const code =
		typeof candidate.code === "string"
			? candidate.code.toUpperCase()
			: undefined;
	if (code && RETRYABLE_AUTH_PERSISTENCE_CODES.has(code)) {
		return true;
	}

	if (candidate.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
		return true;
	}

	if (candidate.cause && candidate.cause !== error) {
		return isRetryableAuthPersistenceError(candidate.cause);
	}

	return false;
}

export interface Workspace {
	id: string;
	name?: string;
	enabled: boolean;
	disabledAt?: number;
	isDefault?: boolean;
}

export interface ManagedAccount {
	index: number;
	accountId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	email?: string;
	refreshToken: string;
	enabled?: boolean;
	access?: string;
	expires?: number;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?:
		| "rate-limit"
		| "initial"
		| "rotation"
		| "best"
		| "restore";
	lastRateLimitReason?: RateLimitReason;
	rateLimitResetTimes: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	consecutiveAuthFailures?: number;
	workspaces?: Workspace[];
	currentWorkspaceIndex?: number;
}

export class AccountManager {
	private accounts: ManagedAccount[] = [];
	private cursorByFamily: Record<ModelFamily, number> = initFamilyState(0);
	private currentAccountIndexByFamily: Record<ModelFamily, number> = initFamilyState(-1);
	private lastToastAccountIndex = -1;
	private lastToastTime = 0;
	private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingSave: Promise<void> | null = null;

	static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
		const stored = await loadAccounts();
		const synced = await syncAccountStorageFromCodexCli(stored);
		const sourceOfTruthStorage = synced.storage ?? stored;
		if (synced.changed && sourceOfTruthStorage) {
			try {
				await saveAccounts(sourceOfTruthStorage);
			} catch (error) {
				log.debug("Failed to persist Codex CLI source-of-truth sync", {
					error: String(error),
				});
			}
		}

		const manager = new AccountManager(authFallback, sourceOfTruthStorage);
		await manager.hydrateFromCodexCli();
		return manager;
	}

	hasRefreshToken(refreshToken: string): boolean {
		return this.accounts.some((account) => account.refreshToken === refreshToken);
	}

	private async hydrateFromCodexCli(): Promise<void> {
		const state = await loadCodexCliState();
		if (!state || state.accounts.length === 0) return;

		const cache = new Map<string, CodexCliTokenCacheEntry>();
		for (const snapshot of state.accounts) {
			const email = sanitizeEmail(snapshot.email);
			if (!email || !snapshot.accessToken) continue;
			cache.set(email, {
				accessToken: snapshot.accessToken,
				expiresAt: snapshot.expiresAt,
				refreshToken: snapshot.refreshToken,
				accountId: snapshot.accountId,
			});
		}
		if (cache.size === 0) return;

		const now = nowMs();
		let changed = false;

		for (const account of this.accounts) {
			const email = sanitizeEmail(account.email);
			if (!email) continue;

			const cached = cache.get(email);
			if (!cached) continue;

			if (typeof cached.expiresAt === "number" && cached.expiresAt <= now) {
				continue;
			}

			const missingOrExpired =
				!account.access || account.expires === undefined || account.expires <= now;
			if (missingOrExpired) {
				account.access = cached.accessToken;
				if (typeof cached.expiresAt === "number") {
					account.expires = cached.expiresAt;
				}
				changed = true;
			}

			if (
				!account.accountId &&
				cached.accountId &&
				shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
			) {
				account.accountId = cached.accountId;
				account.accountIdSource = account.accountIdSource ?? "token";
				changed = true;
			}
		}

		if (!changed) return;

		try {
			await this.saveToDisk();
		} catch (error) {
			log.debug("Failed to persist Codex CLI cache hydration", { error: String(error) });
		}
	}

	constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null) {
		const fallbackAccountId = extractAccountId(authFallback?.access)?.trim() || undefined;
		const fallbackAccountEmail = sanitizeEmail(extractAccountEmail(authFallback?.access));

		if (stored && stored.accounts.length > 0) {
			const storedIdentityRows: Array<{
				index: number;
				accountId: string | undefined;
				email: string | undefined;
				refreshToken: string;
			}> = [];
			for (let index = 0; index < stored.accounts.length; index += 1) {
				const account = stored.accounts[index];
				if (
					typeof account?.refreshToken !== "string" ||
					!account.refreshToken.trim()
				) {
					continue;
				}
				storedIdentityRows.push({
					index,
					accountId: account.accountId,
					email: account.email,
					refreshToken: account.refreshToken,
				});
			}
			const fallbackMatchedRowIndex =
				authFallback && storedIdentityRows.length > 0
					? storedIdentityRows[
						findMatchingAccountIndex(
							storedIdentityRows,
							{
								accountId: fallbackAccountId,
								email: fallbackAccountEmail,
								refreshToken: authFallback.refresh,
							},
							{
								allowUniqueAccountIdFallbackWithoutEmail: true,
							},
						) ?? -1
					]?.index
					: undefined;
			const baseNow = nowMs();
			this.accounts = stored.accounts
				.map((account, index): ManagedAccount | null => {
					if (
						typeof account.refreshToken !== "string" ||
						!account.refreshToken.trim()
					) {
						return null;
					}

					const matchesFallback =
						!!authFallback &&
						fallbackMatchedRowIndex === index;

					const refreshToken = matchesFallback && authFallback ? authFallback.refresh : account.refreshToken;
 
					return {
						index,
						accountId: matchesFallback ? fallbackAccountId ?? account.accountId : account.accountId,
						accountIdSource: account.accountIdSource,
						accountLabel: account.accountLabel,
						email: matchesFallback
							? fallbackAccountEmail ?? sanitizeEmail(account.email)
							: sanitizeEmail(account.email),
						refreshToken,
						enabled: account.enabled !== false,
						access: matchesFallback && authFallback ? authFallback.access : account.accessToken,
						expires: matchesFallback && authFallback ? authFallback.expires : account.expiresAt,
						addedAt: clampNonNegativeInt(account.addedAt, baseNow),
						lastUsed: clampNonNegativeInt(account.lastUsed, 0),
						lastSwitchReason: account.lastSwitchReason,
						rateLimitResetTimes: account.rateLimitResetTimes ?? {},
						coolingDownUntil: account.coolingDownUntil,
						cooldownReason: account.cooldownReason,
						workspaces: account.workspaces,
						currentWorkspaceIndex: account.currentWorkspaceIndex,
					};
				})
				.filter((account): account is ManagedAccount => account !== null);

			const hasMatchingFallback =
				!!authFallback &&
				fallbackMatchedRowIndex !== undefined;

			if (authFallback && !hasMatchingFallback) {
				const now = nowMs();
				this.accounts.push({
					index: this.accounts.length,
					accountId: fallbackAccountId,
					accountIdSource: fallbackAccountId ? "token" : undefined,
					email: fallbackAccountEmail,
					refreshToken: authFallback.refresh,
					enabled: true,
					access: authFallback.access,
					expires: authFallback.expires,
					addedAt: now,
					lastUsed: now,
					lastSwitchReason: "initial",
					rateLimitResetTimes: {},
				});
			}

			if (this.accounts.length > 0) {
				const defaultIndex = clampNonNegativeInt(stored.activeIndex, 0) % this.accounts.length;

				for (const family of MODEL_FAMILIES) {
					const rawIndex = stored.activeIndexByFamily?.[family];
					const nextIndex = clampNonNegativeInt(rawIndex, defaultIndex) % this.accounts.length;
					this.currentAccountIndexByFamily[family] = nextIndex;
					this.cursorByFamily[family] = nextIndex;
				}
			}
			return;
		}

		if (authFallback) {
			const now = nowMs();
			this.accounts = [
				{
					index: 0,
					accountId: fallbackAccountId,
					accountIdSource: fallbackAccountId ? "token" : undefined,
					email: fallbackAccountEmail,
					refreshToken: authFallback.refresh,
					enabled: true,
					access: authFallback.access,
					expires: authFallback.expires,
					addedAt: now,
					lastUsed: 0,
					lastSwitchReason: "initial",
					rateLimitResetTimes: {},
				},
			];
			for (const family of MODEL_FAMILIES) {
				this.currentAccountIndexByFamily[family] = 0;
				this.cursorByFamily[family] = 0;
			}
		}
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	getActiveIndex(): number {
		return this.getActiveIndexForFamily("codex");
	}

	getActiveIndexForFamily(family: ModelFamily): number {
		const index = this.currentAccountIndexByFamily[family];
		if (index < 0 || index >= this.accounts.length) {
			return this.accounts.length > 0 ? 0 : -1;
		}
		return index;
	}

	getAccountsSnapshot(): ManagedAccount[] {
		return this.accounts.map((account) => ({
			...account,
			rateLimitResetTimes: { ...account.rateLimitResetTimes },
		}));
	}

	getAccountByIndex(index: number): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		if (index < 0 || index >= this.accounts.length) return null;
		const account = this.accounts[index];
		return account ?? null;
	}

	isAccountAvailableForFamily(index: number, family: ModelFamily, model?: string | null): boolean {
		const account = this.getAccountByIndex(index);
		if (!account) return false;
		if (account.enabled === false) return false;
		clearExpiredRateLimits(account);
		return !isRateLimitedForFamily(account, family, model) && !this.isAccountCoolingDown(account);
	}

	setActiveIndex(index: number): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		if (index < 0 || index >= this.accounts.length) return null;
		const account = this.accounts[index];
		if (!account) return null;
		if (account.enabled === false) return null;

		for (const family of MODEL_FAMILIES) {
			this.currentAccountIndexByFamily[family] = index;
			this.cursorByFamily[family] = index;
		}

		account.lastUsed = nowMs();
		account.lastSwitchReason = "rotation";
		void this.syncCodexCliActiveSelectionForIndex(account.index);
		return account;
	}

	async syncCodexCliActiveSelectionForIndex(index: number): Promise<void> {
		if (!Number.isFinite(index)) return;
		if (index < 0 || index >= this.accounts.length) return;
		const account = this.accounts[index];
		if (!account) return;
		await setCodexCliActiveSelection({
			accountId: account.accountId,
			email: account.email,
			accessToken: account.access,
			refreshToken: account.refreshToken,
			expiresAt: account.expires,
		});
	}

	getCurrentAccount(): ManagedAccount | null {
		return this.getCurrentAccountForFamily("codex");
	}

	getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
		const index = this.currentAccountIndexByFamily[family];
		if (index < 0 || index >= this.accounts.length) {
			return null;
		}
		const account = this.accounts[index];
		if (!account || account.enabled === false) {
			return null;
		}
		return account;
	}

	getCurrentOrNext(): ManagedAccount | null {
		return this.getCurrentOrNextForFamily("codex");
	}

	getCurrentOrNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null {
		const count = this.accounts.length;
		if (count === 0) return null;

		const cursor = this.cursorByFamily[family];
		
		for (let i = 0; i < count; i++) {
			const idx = (cursor + i) % count;
			const account = this.accounts[idx];
			if (!account) continue;
			if (account.enabled === false) continue;
			
			clearExpiredRateLimits(account);
			if (isRateLimitedForFamily(account, family, model) || this.isAccountCoolingDown(account)) {
				continue;
			}
			
			this.cursorByFamily[family] = (idx + 1) % count;
			this.currentAccountIndexByFamily[family] = idx;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	getNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null {
		const count = this.accounts.length;
		if (count === 0) return null;

		const cursor = this.cursorByFamily[family];
		
		for (let i = 0; i < count; i++) {
			const idx = (cursor + i) % count;
			const account = this.accounts[idx];
			if (!account) continue;
			if (account.enabled === false) continue;
			
			clearExpiredRateLimits(account);
			if (isRateLimitedForFamily(account, family, model) || this.isAccountCoolingDown(account)) {
				continue;
			}
			
			this.cursorByFamily[family] = (idx + 1) % count;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	getCurrentOrNextForFamilyHybrid(family: ModelFamily, model?: string | null, options?: HybridSelectionOptions): ManagedAccount | null {
		const count = this.accounts.length;
		if (count === 0) return null;

		const currentIndex = this.currentAccountIndexByFamily[family];
		if (currentIndex >= 0 && currentIndex < count) {
			const currentAccount = this.accounts[currentIndex];
			if (currentAccount) {
				if (currentAccount.enabled === false) {
					// Fall through to hybrid selection.
				} else {
				clearExpiredRateLimits(currentAccount);
				if (
					!isRateLimitedForFamily(currentAccount, family, model) &&
					!this.isAccountCoolingDown(currentAccount)
				) {
					currentAccount.lastUsed = nowMs();
					return currentAccount;
				}
				}
			}
		}

		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();

		const accountsWithMetrics: AccountWithMetrics[] = this.accounts
			.map((account): AccountWithMetrics | null => {
				if (!account) return null;
				if (account.enabled === false) return null;
				clearExpiredRateLimits(account);
				const isAvailable =
					!isRateLimitedForFamily(account, family, model) && !this.isAccountCoolingDown(account);
				return {
					index: account.index,
					isAvailable,
					lastUsed: account.lastUsed,
				};
			})
			.filter((a): a is AccountWithMetrics => a !== null);

		const selected = selectHybridAccount(accountsWithMetrics, healthTracker, tokenTracker, quotaKey, {}, options);
		if (!selected) return null;

		const account = this.accounts[selected.index];
		if (!account) return null;

		this.currentAccountIndexByFamily[family] = account.index;
		this.cursorByFamily[family] = (account.index + 1) % count;
		account.lastUsed = nowMs();
		return account;
	}

	recordSuccess(account: ManagedAccount, family: ModelFamily, model?: string | null): void {
		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		healthTracker.recordSuccess(account.index, quotaKey);
		const hadCooldownMetadata =
			account.coolingDownUntil !== undefined || account.cooldownReason !== undefined;
		const hadAuthFailures = (account.consecutiveAuthFailures ?? 0) > 0;
		const isCoolingDown = this.isAccountCoolingDown(account);
		let healed = false;

		if (!isCoolingDown && hadCooldownMetadata) {
			this.clearAccountCooldown(account);
			healed = true;
		}

		if (!isCoolingDown && hadAuthFailures) {
			this.clearAuthFailures(account);
			healed = true;
		}

		if (healed) {
			this.saveToDiskDebounced();
		}
	}

	recordRateLimit(account: ManagedAccount, family: ModelFamily, model?: string | null): void {
		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();
		healthTracker.recordRateLimit(account.index, quotaKey);
		tokenTracker.drain(account.index, quotaKey);
	}

	recordFailure(account: ManagedAccount, family: ModelFamily, model?: string | null): void {
		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		healthTracker.recordFailure(account.index, quotaKey);
	}

	consumeToken(account: ManagedAccount, family: ModelFamily, model?: string | null): boolean {
		const quotaKey = model ? `${family}:${model}` : family;
		const tokenTracker = getTokenTracker();
		return tokenTracker.tryConsume(account.index, quotaKey);
	}

	/**
	 * Refund a token consumed within the refund window (30 seconds).
	 * Use this when a request fails due to network errors (not rate limits).
	 * @returns true if refund was successful, false if no valid consumption found
	 */
	refundToken(account: ManagedAccount, family: ModelFamily, model?: string | null): boolean {
		const quotaKey = model ? `${family}:${model}` : family;
		const tokenTracker = getTokenTracker();
		return tokenTracker.refundToken(account.index, quotaKey);
	}

	markSwitched(account: ManagedAccount, reason: "rate-limit" | "initial" | "rotation", family: ModelFamily): void {
		account.lastSwitchReason = reason;
		this.currentAccountIndexByFamily[family] = account.index;
	}

	markRateLimited(account: ManagedAccount, retryAfterMs: number, family: ModelFamily, model?: string | null): void {
		this.markRateLimitedWithReason(account, retryAfterMs, family, "unknown", model);
	}

	markRateLimitedWithReason(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		reason: RateLimitReason,
		model?: string | null,
	): void {
		const retryMs = Math.max(0, Math.floor(retryAfterMs));
		const resetAt = nowMs() + retryMs;

		const baseKey = getQuotaKey(family);
		account.rateLimitResetTimes[baseKey] = resetAt;

		if (model) {
			const modelKey = getQuotaKey(family, model);
			account.rateLimitResetTimes[modelKey] = resetAt;
		}

		account.lastRateLimitReason = reason;
	}

	markAccountCoolingDown(account: ManagedAccount, cooldownMs: number, reason: CooldownReason): void {
		const ms = Math.max(0, Math.floor(cooldownMs));
		account.coolingDownUntil = nowMs() + ms;
		account.cooldownReason = reason;
	}

	isAccountCoolingDown(account: ManagedAccount): boolean {
		if (account.coolingDownUntil === undefined) return false;
		if (nowMs() >= account.coolingDownUntil) {
			this.clearAccountCooldown(account);
			return false;
		}
		return true;
	}

	clearAccountCooldown(account: ManagedAccount): void {
		delete account.coolingDownUntil;
		delete account.cooldownReason;
	}

	incrementAuthFailures(account: ManagedAccount): number {
		account.consecutiveAuthFailures = (account.consecutiveAuthFailures ?? 0) + 1;
		return account.consecutiveAuthFailures;
	}

	clearAuthFailures(account: ManagedAccount): void {
		account.consecutiveAuthFailures = 0;
	}

	getAccountByIdentity(
		candidate: AccountIdentityCandidate,
		auth?: OAuthAuthDetails,
	): ManagedAccount | null {
		const index = findAccountIndexByIdentity(this.accounts, candidate, auth);
		if (index === undefined) {
			return null;
		}
		return this.accounts[index] ?? null;
	}

	shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
		const now = nowMs();
		if (accountIndex === this.lastToastAccountIndex && now - this.lastToastTime < debounceMs) {
			return false;
		}
		return true;
	}

	markToastShown(accountIndex: number): void {
		this.lastToastAccountIndex = accountIndex;
		this.lastToastTime = nowMs();
	}

	updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
		account.refreshToken = auth.refresh;
		account.access = auth.access;
		account.expires = auth.expires;
		const tokenAccountId = extractAccountId(auth.access)?.trim() || undefined;
		if (
			tokenAccountId &&
			(shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId))
		) {
			account.accountId = tokenAccountId;
			account.accountIdSource = "token";
		}
		account.email = sanitizeEmail(extractAccountEmail(auth.access)) ?? account.email;
	}

	private buildStorageSnapshot(): AccountStorageV3 {
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			const raw = this.currentAccountIndexByFamily[family];
			activeIndexByFamily[family] = clampNonNegativeInt(raw, 0);
		}

		const activeIndex = clampNonNegativeInt(activeIndexByFamily.codex, 0);

		return {
			version: 3,
			accounts: this.accounts.map((account) => ({
				accountId: account.accountId,
				accountIdSource: account.accountIdSource,
				accountLabel: account.accountLabel,
				email: account.email,
				refreshToken: account.refreshToken,
				accessToken: account.access,
				expiresAt: account.expires,
				enabled: account.enabled === false ? false : undefined,
				addedAt: account.addedAt,
				lastUsed: account.lastUsed,
				lastSwitchReason: account.lastSwitchReason,
				rateLimitResetTimes:
					Object.keys(account.rateLimitResetTimes).length > 0 ? account.rateLimitResetTimes : undefined,
				coolingDownUntil: account.coolingDownUntil,
				cooldownReason: account.cooldownReason,
				workspaces: account.workspaces,
				currentWorkspaceIndex: account.currentWorkspaceIndex,
			})),
			activeIndex,
			activeIndexByFamily,
		};
	}

	async commitRefreshedAuth(
		source: Pick<
			ManagedAccount,
			"index" | "accountId" | "email" | "refreshToken"
		>,
		auth: OAuthAuthDetails,
	): Promise<ManagedAccount | null> {
		const nextAccountId = extractAccountId(auth.access)?.trim() || undefined;
		const nextEmail = sanitizeEmail(extractAccountEmail(auth.access));
		try {
			return await withAccountStorageTransaction(async (_current, persist) => {
				// Snapshot the live in-memory pool under the storage lock so refresh
				// persistence merges against the latest account state.
				const nextStorage = structuredClone(
					this.buildStorageSnapshot(),
				) as AccountStorageV3;
				const storageIndex = findAccountIndexByIdentity(
					nextStorage.accounts,
					source,
					auth,
				);
				if (storageIndex === undefined) {
					log.warn("Unable to resolve refreshed account for persistence", {
						sourceIndex: source.index,
					});
					return null;
				}

				const storedAccount = nextStorage.accounts[storageIndex];
				if (!storedAccount) {
					return null;
				}

				storedAccount.refreshToken = auth.refresh;
				storedAccount.accessToken = auth.access;
				storedAccount.expiresAt = auth.expires;
				if (
					nextAccountId &&
					shouldUpdateAccountIdFromToken(
						storedAccount.accountIdSource,
						storedAccount.accountId,
					)
				) {
					storedAccount.accountId = nextAccountId;
					storedAccount.accountIdSource = "token";
				}
				if (nextEmail) {
					storedAccount.email = nextEmail;
				}
				storedAccount.enabled = undefined;
				delete storedAccount.coolingDownUntil;
				delete storedAccount.cooldownReason;

				const liveAccount = this.getAccountByIdentity(source, auth);
				if (liveAccount) {
					const previousLiveAccountState = {
						access: liveAccount.access,
						refreshToken: liveAccount.refreshToken,
						expires: liveAccount.expires,
						accountId: liveAccount.accountId,
						accountIdSource: liveAccount.accountIdSource,
						email: liveAccount.email,
						enabled: liveAccount.enabled,
						coolingDownUntil: liveAccount.coolingDownUntil,
						cooldownReason: liveAccount.cooldownReason,
						consecutiveAuthFailures: liveAccount.consecutiveAuthFailures,
					};

					this.updateFromAuth(liveAccount, auth);
					liveAccount.enabled = true;
					this.clearAccountCooldown(liveAccount);
					this.clearAuthFailures(liveAccount);

					try {
						await persist(nextStorage);
					} catch (error) {
						liveAccount.access = previousLiveAccountState.access;
						liveAccount.refreshToken = previousLiveAccountState.refreshToken;
						liveAccount.expires = previousLiveAccountState.expires;
						liveAccount.accountId = previousLiveAccountState.accountId;
						liveAccount.accountIdSource =
							previousLiveAccountState.accountIdSource;
						liveAccount.email = previousLiveAccountState.email;
						liveAccount.enabled = previousLiveAccountState.enabled;
						liveAccount.consecutiveAuthFailures =
							previousLiveAccountState.consecutiveAuthFailures;
						if (
							previousLiveAccountState.coolingDownUntil === undefined
						) {
							delete liveAccount.coolingDownUntil;
						} else {
							liveAccount.coolingDownUntil =
								previousLiveAccountState.coolingDownUntil;
						}
						if (previousLiveAccountState.cooldownReason === undefined) {
							delete liveAccount.cooldownReason;
						} else {
							liveAccount.cooldownReason =
								previousLiveAccountState.cooldownReason;
						}
						throw error;
					}

					return liveAccount;
				}

				await persist(nextStorage);
				log.warn("Unable to resolve refreshed live account after persistence", {
					sourceIndex: source.index,
				});
				return null;
			});
		} catch (error) {
			throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, {
				retryable: isRetryableAuthPersistenceError(error),
				cause: error,
			});
		}
	}

	toAuthDetails(account: ManagedAccount): Auth {
		return {
			type: "oauth",
			access: account.access ?? "",
			refresh: account.refreshToken,
			expires: account.expires ?? 0,
		};
	}

	getMinWaitTime(): number {
		return this.getMinWaitTimeForFamily("codex");
	}

	getMinWaitTimeForFamily(family: ModelFamily, model?: string | null): number {
		const now = nowMs();
		const enabledAccounts = this.accounts.filter((account) => account.enabled !== false);
		const available = enabledAccounts.filter((account) => {
			clearExpiredRateLimits(account);
			return !isRateLimitedForFamily(account, family, model) && !this.isAccountCoolingDown(account);
		});
		if (available.length > 0) return 0;
		if (enabledAccounts.length === 0) return 0;

		const waitTimes: number[] = [];
		const baseKey = getQuotaKey(family);
		const modelKey = model ? getQuotaKey(family, model) : null;

		for (const account of enabledAccounts) {
			const baseResetAt = account.rateLimitResetTimes[baseKey];
			if (typeof baseResetAt === "number") {
				waitTimes.push(Math.max(0, baseResetAt - now));
			}

			if (modelKey) {
				const modelResetAt = account.rateLimitResetTimes[modelKey];
				if (typeof modelResetAt === "number") {
					waitTimes.push(Math.max(0, modelResetAt - now));
				}
			}

			if (typeof account.coolingDownUntil === "number") {
				waitTimes.push(Math.max(0, account.coolingDownUntil - now));
			}
		}

		return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
	}

	removeAccount(account: ManagedAccount): boolean {
		const idx = this.accounts.indexOf(account);
		if (idx < 0) {
			return false;
		}

		this.accounts.splice(idx, 1);
		this.accounts.forEach((acc, index) => {
			acc.index = index;
		});

		if (this.accounts.length === 0) {
			for (const family of MODEL_FAMILIES) {
				this.cursorByFamily[family] = 0;
				this.currentAccountIndexByFamily[family] = -1;
			}
			return true;
		}

		for (const family of MODEL_FAMILIES) {
			if (this.cursorByFamily[family] > idx) {
				this.cursorByFamily[family] = Math.max(0, this.cursorByFamily[family] - 1);
			}
		}
		for (const family of MODEL_FAMILIES) {
			this.cursorByFamily[family] = this.cursorByFamily[family] % this.accounts.length;
		}

		for (const family of MODEL_FAMILIES) {
			if (this.currentAccountIndexByFamily[family] > idx) {
				this.currentAccountIndexByFamily[family] -= 1;
			}
			if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
				this.currentAccountIndexByFamily[family] = -1;
			}
		}

		return true;
	}

	removeAccountByIndex(index: number): boolean {
		if (!Number.isFinite(index)) return false;
		if (index < 0 || index >= this.accounts.length) return false;
		const account = this.accounts[index];
		if (!account) return false;
		return this.removeAccount(account);
	}

	setAccountEnabled(index: number, enabled: boolean): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		if (index < 0 || index >= this.accounts.length) return null;
		const account = this.accounts[index];
		if (!account) return null;
		const wasEnabled = account.enabled !== false;
		account.enabled = enabled;
		if (enabled && !wasEnabled) {
			this.resetWorkspaces(account);
		}
		return account;
	}

	async saveToDisk(): Promise<void> {
		await withAccountStorageTransaction(async (_current, persist) => {
			await persist(this.buildStorageSnapshot());
		});
	}

	saveToDiskDebounced(delayMs = 500): void {
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
		}
		this.saveDebounceTimer = setTimeout(() => {
			this.saveDebounceTimer = null;
			const doSave = async () => {
				try {
					if (this.pendingSave) {
						await this.pendingSave;
					}
					this.pendingSave = this.saveToDisk().finally(() => {
						this.pendingSave = null;
					});
					await this.pendingSave;
				} catch (error) {
					log.warn("Debounced save failed", { error: error instanceof Error ? error.message : String(error) });
				}
			};
			void doSave();
		}, delayMs);
	}

	async flushPendingSave(): Promise<void> {
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
			this.saveDebounceTimer = null;
			await this.saveToDisk();
		}
		if (this.pendingSave) {
			await this.pendingSave;
		}
	}

	// Workspace management methods
	private resetWorkspaces(account: ManagedAccount): void {
		if (!account.workspaces || account.workspaces.length === 0) {
			return;
		}

		const resetIndex = account.workspaces.findIndex((workspace) => workspace.isDefault === true);

		for (const workspace of account.workspaces) {
			workspace.enabled = true;
			delete workspace.disabledAt;
		}

		account.currentWorkspaceIndex = resetIndex >= 0 ? resetIndex : 0;
	}

	getCurrentWorkspace(account: ManagedAccount): Workspace | null {
		if (!account.workspaces || account.workspaces.length === 0) {
			return null;
		}
		const idx = account.currentWorkspaceIndex ?? 0;
		return account.workspaces[idx] ?? null;
	}

	disableCurrentWorkspace(
		account: ManagedAccount,
		expectedWorkspaceId?: string,
	): boolean {
		if (!account.workspaces || account.workspaces.length === 0) {
			return false;
		}
		const idx = account.currentWorkspaceIndex ?? 0;
		if (idx < 0 || idx >= account.workspaces.length) {
			return false;
		}
		const workspace = account.workspaces[idx];
		if (!workspace) return false;
		if (expectedWorkspaceId && workspace.id !== expectedWorkspaceId) {
			return false;
		}
		if (workspace.enabled === false) {
			return false;
		}
		workspace.enabled = false;
		workspace.disabledAt = nowMs();
		return true;
	}

	rotateToNextWorkspace(account: ManagedAccount): Workspace | null {
		if (!account.workspaces || account.workspaces.length === 0) {
			return null;
		}
		const currentIdx = account.currentWorkspaceIndex ?? 0;
		const totalWorkspaces = account.workspaces.length;
		
		// Search successor workspaces only; the current slot was just evaluated.
		for (let i = 1; i < totalWorkspaces; i++) {
			const nextIdx = (currentIdx + i) % totalWorkspaces;
			const workspace = account.workspaces[nextIdx];
			if (workspace && workspace.enabled !== false) {
				account.currentWorkspaceIndex = nextIdx;
				return workspace;
			}
		}
		
		return null; // No enabled workspaces found
	}

	/**
	 * Legacy accounts without tracked workspaces are treated as having one
	 * implicit enabled workspace for backwards compatibility.
	 */
	hasEnabledWorkspaces(account: ManagedAccount): boolean {
		if (!account.workspaces || account.workspaces.length === 0) {
			return true; // No workspaces tracked yet, assume single workspace
		}
		return account.workspaces.some((w) => w.enabled !== false);
	}

	getWorkspaceCount(account: ManagedAccount): number {
		return account.workspaces?.length ?? 0;
	}

	getEnabledWorkspaceCount(account: ManagedAccount): number {
		if (!account.workspaces) return 0;
		return account.workspaces.filter((w) => w.enabled !== false).length;
	}
}

export function formatAccountLabel(
	account: { email?: string; accountId?: string; accountLabel?: string } | undefined,
	index: number,
): string {
	const accountLabel = account?.accountLabel?.trim();
	const email = account?.email?.trim();
	const accountId = account?.accountId?.trim();
	const idSuffix = accountId ? (accountId.length > 6 ? accountId.slice(-6) : accountId) : null;

	if (accountLabel && email && idSuffix) {
		return `Account ${index + 1} (${accountLabel}, ${email}, id:${idSuffix})`;
	}
	if (accountLabel && email) return `Account ${index + 1} (${accountLabel}, ${email})`;
	if (accountLabel && idSuffix) return `Account ${index + 1} (${accountLabel}, id:${idSuffix})`;
	if (accountLabel) return `Account ${index + 1} (${accountLabel})`;
	if (email && idSuffix) return `Account ${index + 1} (${email}, id:${idSuffix})`;
	if (email) return `Account ${index + 1} (${email})`;
	if (idSuffix) return `Account ${index + 1} (${idSuffix})`;
	return `Account ${index + 1}`;
}

export function formatCooldown(
	account: { coolingDownUntil?: number; cooldownReason?: string },
	now = nowMs(),
): string | null {
	if (typeof account.coolingDownUntil !== "number") return null;
	const remaining = account.coolingDownUntil - now;
	if (remaining <= 0) return null;
	const reason = account.cooldownReason ? ` (${account.cooldownReason})` : "";
	return `${formatWaitTime(remaining)}${reason}`;
}
