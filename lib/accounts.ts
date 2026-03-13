import type { Auth } from "@codex-ai/sdk";
import { createLogger } from "./logger.js";
import {
	loadAccounts,
	saveAccounts,
	type AccountStorageV3,
	type CooldownReason,
	type RateLimitStateV3,
	findMatchingAccountIndex,
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
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	lastRateLimitReason?: RateLimitReason;
	rateLimitResetTimes: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	consecutiveAuthFailures?: number;
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
		const fallbackAccountId = extractAccountId(authFallback?.access);
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
		const tokenAccountId = extractAccountId(auth.access);
		if (
			tokenAccountId &&
			(shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId))
		) {
			account.accountId = tokenAccountId;
			account.accountIdSource = "token";
		}
		account.email = sanitizeEmail(extractAccountEmail(auth.access)) ?? account.email;
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
		account.enabled = enabled;
		return account;
	}

	async saveToDisk(): Promise<void> {
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			const raw = this.currentAccountIndexByFamily[family];
			activeIndexByFamily[family] = clampNonNegativeInt(raw, 0);
		}

		const activeIndex = clampNonNegativeInt(activeIndexByFamily.codex, 0);

		const storage: AccountStorageV3 = {
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
			})),
			activeIndex,
			activeIndexByFamily,
		};

		await saveAccounts(storage);
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
