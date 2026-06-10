import type { Auth } from "@codex-ai/sdk";
import { saveAccountsWithRetry } from "./storage/save-retry.js";
import { createLogger } from "./logger.js";
import {
	getStoragePath,
	loadAccounts,
	readPinAndGenFromDisk,
	saveAccounts,
	type AccountStorageV3,
	type CooldownReason,
	type RateLimitStateV3,
	findMatchingAccountIndex,
	withAccountStorageTransaction,
} from "./storage.js";
import type { AccountIdSource, OAuthAuthDetails } from "./types.js";
import type { Workspace } from "./storage/public-types.js";
import { MODEL_FAMILIES, type ModelFamily } from "./request/helpers/model-map.js";
import {
	getHealthTracker,
	getTokenTracker,
	resetTrackers,
	selectHybridAccount,
	type AccountWithMetrics,
	type HybridSelectionOptions,
} from "./rotation.js";
import {
	withRoutingMutex,
	type RoutingMutexMode,
	type SelectionRecord,
} from "./routing-mutex.js";
import { nowMs } from "./utils.js";
import { ERROR_MESSAGES, HTTP_STATUS } from "./constants.js";
import { CodexAuthError } from "./errors.js";
import {
	loadCodexCliState,
	type CodexCliTokenCacheEntry,
} from "./codex-cli/state.js";
import { syncAccountStorageFromCodexCli } from "./codex-cli/sync.js";
import { setCodexCliActiveSelection } from "./codex-cli/writer.js";
import {
	getAccountIdentityKey,
	getRuntimeAccountIdentityKey,
} from "./storage/identity.js";
import { getCircuitBreaker, resetAllCircuitBreakers, removeCircuitBreaker } from "./circuit-breaker.js";
import {
	getStoragePathState,
	runWithStoragePathState,
	type StoragePathState,
} from "./storage/path-state.js";

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
let nextRuntimeCircuitKeyId = 0;

function getAccountCircuitKey(account: ManagedAccount): string {
	if (!account.circuitKeyId) {
		account.circuitKeyId =
			getAccountIdentityKey(account) ?? `circuit:${nextRuntimeCircuitKeyId++}`;
	}
	return account.circuitKeyId;
}

export function getRuntimeTrackerKey(account: ManagedAccount): string | number {
	if (account._runtimeTrackerKey !== undefined) {
		return account._runtimeTrackerKey;
	}

	const trackerKey = getRuntimeAccountIdentityKey(account) ?? account.index;
	account._runtimeTrackerKey = trackerKey;
	return trackerKey;
}

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
	T extends Pick<
		AccountIdentityCandidate,
		"accountId" | "email" | "refreshToken"
	>,
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

// Workspace is persisted inside the account storage shapes, so the interface
// lives in lib/storage/public-types.ts (the layer below this module). It is
// re-exported here to preserve the historical import surface.
export type { Workspace } from "./storage/public-types.js";

export interface ManagedAccount {
	index: number;
	_runtimeTrackerKey?: string | number;
	circuitKeyId?: string;
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
		| "restore"
		| "manual";
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
	private currentAccountIndexByFamily: Record<ModelFamily, number> =
		initFamilyState(-1);
	private lastToastAccountIndex = -1;
	private lastToastTime = 0;
	private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingSave: Promise<void> | null = null;
	private readonly storagePathState: StoragePathState;
	/**
	 * Manual pin set by the `switch` CLI command, hydrated from disk at
	 * construction time and refreshed from disk just before each
	 * `buildStorageSnapshot` so a CLI mutation that landed between proxy
	 * startup and a routine save is not clobbered. AccountManager exposes no
	 * mutators for this — pins flow only through the CLI commands. See #474.
	 */
	private pinnedAccountIndex: number | undefined;
	/**
	 * Counter the CLI bumps on `switch`/`unpin`/`best` so the proxy can
	 * invalidate session affinity. Hydrated and refreshed via the same path
	 * as `pinnedAccountIndex`. See #474.
	 */
	private affinityGeneration: number;
	/**
	 * PR-N / R4: feature-flagged routing mutex mode.
	 * Defaults to `"legacy"` to preserve pre-PR-N behaviour for one release
	 * cycle. When set to `"enabled"` the cursor-mutation helpers (markSwitched,
	 * markAccountCoolingDown, setActiveIndex) serialize through the shared
	 * async mutex in `lib/routing-mutex.ts`.
	 */
	private routingMutexMode: RoutingMutexMode = "legacy";

	static async loadFromDisk(
		authFallback?: OAuthAuthDetails,
	): Promise<AccountManager> {
		const stored = await loadAccounts();
		const synced = await syncAccountStorageFromCodexCli(stored);
		const sourceOfTruthStorage = synced.storage ?? stored;
		if (synced.changed && sourceOfTruthStorage) {
			try {
				await saveAccountsWithRetry(sourceOfTruthStorage, saveAccounts);
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
		return this.accounts.some(
			(account) => account.refreshToken === refreshToken,
		);
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
				!account.access ||
				account.expires === undefined ||
				account.expires <= now;
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
				shouldUpdateAccountIdFromToken(
					account.accountIdSource,
					account.accountId,
				)
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
			log.debug("Failed to persist Codex CLI cache hydration", {
				error: String(error),
			});
		}
	}

	constructor(
		authFallback?: OAuthAuthDetails,
		stored?: AccountStorageV3 | null,
	) {
		this.storagePathState = { ...getStoragePathState() };
		const fallbackAccountId =
			extractAccountId(authFallback?.access)?.trim() || undefined;
		const fallbackAccountEmail = sanitizeEmail(
			extractAccountEmail(authFallback?.access),
		);

		// Hydrate pin/gen from the stored snapshot. Validation (range, integer)
		// already happens in storage.loadAccountsInternal which strips invalid
		// values, so we trust the typed shape here. Defaults: no pin, gen=0.
		const rawStoredGen = stored?.affinityGeneration;
		this.affinityGeneration =
			typeof rawStoredGen === "number" &&
			Number.isFinite(rawStoredGen) &&
			Number.isInteger(rawStoredGen) &&
			rawStoredGen >= 0
				? rawStoredGen
				: 0;
		const rawStoredPin = stored?.pinnedAccountIndex;
		const accountCount = stored?.accounts?.length ?? 0;
		this.pinnedAccountIndex =
			typeof rawStoredPin === "number" &&
			Number.isFinite(rawStoredPin) &&
			Number.isInteger(rawStoredPin) &&
			rawStoredPin >= 0 &&
			rawStoredPin < accountCount
				? rawStoredPin
				: undefined;

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
						!!authFallback && fallbackMatchedRowIndex === index;

					const refreshToken =
						matchesFallback && authFallback
							? authFallback.refresh
							: account.refreshToken;

					return {
						index,
						accountId: matchesFallback
							? (fallbackAccountId ?? account.accountId)
							: account.accountId,
						accountIdSource: account.accountIdSource,
						accountLabel: account.accountLabel,
						email: matchesFallback
							? (fallbackAccountEmail ?? sanitizeEmail(account.email))
							: sanitizeEmail(account.email),
						refreshToken,
						enabled: account.enabled !== false,
						access:
							matchesFallback && authFallback
								? authFallback.access
								: account.accessToken,
						expires:
							matchesFallback && authFallback
								? authFallback.expires
								: account.expiresAt,
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
				!!authFallback && fallbackMatchedRowIndex !== undefined;

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
				const defaultIndex =
					clampNonNegativeInt(stored.activeIndex, 0) % this.accounts.length;

				for (const family of MODEL_FAMILIES) {
					const rawIndex = stored.activeIndexByFamily?.[family];
					const nextIndex =
						clampNonNegativeInt(rawIndex, defaultIndex) % this.accounts.length;
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
		// Bounds clamp — return -1 if no accounts exist at all.
		if (this.accounts.length === 0) return -1;
		const clamped = index < 0 || index >= this.accounts.length ? 0 : index;
		// "Active" must mean ROUTABLE, not merely in-range. If the stored pointer
		// (or the clamped fallback) lands on a disabled account, walk forward to
		// the next enabled slot. This prevents UI/automation from holding a stale
		// pointer that resolves to a disabled account after setAccountEnabled()
		// flipped it off (AUDIT-H10 / D-05).
		if (this.accounts[clamped]?.enabled !== false) return clamped;
		for (let step = 1; step < this.accounts.length; step += 1) {
			const candidate = (clamped + step) % this.accounts.length;
			if (this.accounts[candidate]?.enabled !== false) return candidate;
		}
		// All accounts disabled — return -1 to match the empty-pool sentinel so
		// callers do not receive a disabled index they might trust without an
		// enabled re-check (oracle audit F1).
		return -1;
	}

	getAccountsSnapshot(): ManagedAccount[] {
		return this.accounts.map((account) => {
			const trackerKey = getRuntimeTrackerKey(account);
			const circuitKeyId = getAccountCircuitKey(account);
			return {
				...account,
				_runtimeTrackerKey: trackerKey,
				circuitKeyId,
				rateLimitResetTimes: { ...account.rateLimitResetTimes },
			};
		});
	}

	getAccountByIndex(index: number): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		if (index < 0 || index >= this.accounts.length) return null;
		const account = this.accounts[index];
		return account ?? null;
	}

	isAccountAvailableForFamily(
		index: number,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		const account = this.getAccountByIndex(index);
		if (!account) return false;
		if (account.enabled === false) return false;
		if (!this.hasEnabledWorkspaces(account)) return false;
		clearExpiredRateLimits(account);
		return (
			!isRateLimitedForFamily(account, family, model) &&
			!this.isAccountCoolingDown(account) &&
			this.isCircuitAvailable(account)
		);
	}

	getAccountRuntimeSkipReason(
		index: number,
		family: ModelFamily,
		model?: string | null,
	): string | null {
		const account = this.getAccountByIndex(index);
		if (!account) return "missing";
		if (account.enabled === false) return "disabled";
		if (!this.hasEnabledWorkspaces(account)) return "workspace-disabled";
		clearExpiredRateLimits(account);
		if (isRateLimitedForFamily(account, family, model)) return "rate-limited";
		if (this.isAccountCoolingDown(account)) {
			return account.cooldownReason
				? `cooling-down:${account.cooldownReason}`
				: "cooling-down";
		}
		if (!this.isCircuitAvailable(account)) return "circuit-open";
		return null;
	}

	static resetVolatileRuntimeState(): void {
		resetTrackers();
		resetAllCircuitBreakers();
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

	getCurrentOrNextForFamily(
		family: ModelFamily,
		model?: string | null,
	): ManagedAccount | null {
		const count = this.accounts.length;
		if (count === 0) return null;

		const cursor = this.cursorByFamily[family];

		for (let i = 0; i < count; i++) {
			const idx = (cursor + i) % count;
			const account = this.accounts[idx];
			if (!account) continue;
			if (account.enabled === false) continue;
			if (!this.hasEnabledWorkspaces(account)) continue;

			clearExpiredRateLimits(account);
			if (
				isRateLimitedForFamily(account, family, model) ||
				this.isAccountCoolingDown(account) ||
				!this.isCircuitAvailable(account)
			) {
				continue;
			}

			this.cursorByFamily[family] = (idx + 1) % count;
			this.currentAccountIndexByFamily[family] = idx;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	getNextForFamily(
		family: ModelFamily,
		model?: string | null,
	): ManagedAccount | null {
		const count = this.accounts.length;
		if (count === 0) return null;

		const cursor = this.cursorByFamily[family];

		for (let i = 0; i < count; i++) {
			const idx = (cursor + i) % count;
			const account = this.accounts[idx];
			if (!account) continue;
			if (account.enabled === false) continue;
			if (!this.hasEnabledWorkspaces(account)) continue;

			clearExpiredRateLimits(account);
			if (
				isRateLimitedForFamily(account, family, model) ||
				this.isAccountCoolingDown(account) ||
				!this.isCircuitAvailable(account)
			) {
				continue;
			}

			this.cursorByFamily[family] = (idx + 1) % count;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	/**
	 * Sequential / drain-first selection (issue #509).
	 *
	 * Unlike the round-robin and hybrid selectors, this does NOT advance on
	 * every pick. It sticks to the current active account for the family and
	 * keeps returning it while it is available; only when the active account is
	 * fully exhausted (rate-limited / cooling down / circuit-open / disabled)
	 * does it scan forward — wrapping around the pool — for the next available
	 * account and make THAT the new active account. Because the scan starts from
	 * the active index and wraps, an earlier account that has recovered its
	 * quota window becomes eligible again as soon as the current account drains,
	 * producing the staggered-recovery pattern requested in #509.
	 *
	 * Concurrency: mutates `currentAccountIndexByFamily` / `cursorByFamily` like
	 * the sibling selectors; callers that need serialization wrap the call in the
	 * routing mutex (see the proxy hot path). No I/O.
	 *
	 * `blockedIndexes` (optional) is the request's policy block set
	 * (`RuntimePolicyDecision.blockedAccountIndexes`: paused / drained / lacking
	 * capability for the model). Blocked accounts are treated as NOT usable so the
	 * selector never commits the active pointer to an account that `chooseAccount`
	 * would immediately reject — otherwise the drain-first primary could anchor on
	 * a permanently-blocked account and degrade every future request to the linear
	 * scan fallback (#509 review P1).
	 */
	getCurrentOrNextForFamilySequential(
		family: ModelFamily,
		model?: string | null,
		blockedIndexes?: ReadonlySet<number>,
	): ManagedAccount | null {
		const count = this.accounts.length;
		if (count === 0) return null;

		const isUsable = (
			account: ManagedAccount | undefined,
		): account is ManagedAccount => {
			if (!account) return false;
			if (account.enabled === false) return false;
			if (blockedIndexes?.has(account.index)) return false;
			if (!this.hasEnabledWorkspaces(account)) return false;
			clearExpiredRateLimits(account);
			return (
				!isRateLimitedForFamily(account, family, model) &&
				!this.isAccountCoolingDown(account) &&
				this.isCircuitAvailable(account)
			);
		};

		// Sticky: stay on the current active account while it is still usable so
		// we drain it fully before moving on. A negative/unset active index falls
		// through to the forward scan below.
		const activeIndex = this.currentAccountIndexByFamily[family];
		if (activeIndex >= 0 && activeIndex < count) {
			const active = this.accounts[activeIndex];
			if (isUsable(active)) {
				active.lastUsed = nowMs();
				return active;
			}
		}

		// Active account is exhausted (or none set): scan forward from the active
		// index, wrapping, for the next usable account and pin it as the new
		// active account. Starting at the active index (not active+1) lets a
		// recovered earlier account reclaim the active slot on wrap-around.
		const start = activeIndex >= 0 && activeIndex < count ? activeIndex : 0;
		for (let i = 0; i < count; i++) {
			const idx = (start + i) % count;
			const account = this.accounts[idx];
			if (!isUsable(account)) continue;

			this.currentAccountIndexByFamily[family] = idx;
			this.cursorByFamily[family] = (idx + 1) % count;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	getCurrentOrNextForFamilyHybrid(
		family: ModelFamily,
		model?: string | null,
		options?: HybridSelectionOptions,
	): ManagedAccount | null {
		const count = this.accounts.length;
		if (count === 0) return null;

		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();

		const accountsWithMetrics: AccountWithMetrics[] = this.accounts
			.map((account): AccountWithMetrics | null => {
				if (!account) return null;
				if (account.enabled === false) return null;
				if (!this.hasEnabledWorkspaces(account)) return null;
				clearExpiredRateLimits(account);
				const isAvailable =
					!isRateLimitedForFamily(account, family, model) &&
					!this.isAccountCoolingDown(account) &&
					this.isCircuitAvailable(account);
				return {
					index: account.index,
					trackerKey: getRuntimeTrackerKey(account),
					isAvailable,
					lastUsed: account.lastUsed,
				};
			})
			.filter((a): a is AccountWithMetrics => a !== null);

		const selected = selectHybridAccount(
			accountsWithMetrics,
			healthTracker,
			tokenTracker,
			quotaKey,
			{},
			options,
		);
		if (!selected) return null;

		const account = this.accounts[selected.index];
		if (!account) return null;

		this.currentAccountIndexByFamily[family] = account.index;
		this.cursorByFamily[family] = (account.index + 1) % count;
		account.lastUsed = nowMs();
		return account;
	}

	recordSuccess(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		healthTracker.recordSuccess(getRuntimeTrackerKey(account), quotaKey);
		const hadCooldownMetadata =
			account.coolingDownUntil !== undefined ||
			account.cooldownReason !== undefined;
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
		getCircuitBreaker(getAccountCircuitKey(account)).recordSuccess();
	}

	recordRateLimit(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();
		const trackerKey = getRuntimeTrackerKey(account);
		healthTracker.recordRateLimit(trackerKey, quotaKey);
		tokenTracker.drain(trackerKey, quotaKey);
	}

	recordFailure(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		healthTracker.recordFailure(getRuntimeTrackerKey(account), quotaKey);
		getCircuitBreaker(getAccountCircuitKey(account)).recordFailure();
	}

	consumeToken(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		const quotaKey = model ? `${family}:${model}` : family;
		const tokenTracker = getTokenTracker();
		const trackerKey = getRuntimeTrackerKey(account);
		if (!tokenTracker.tryConsume(trackerKey, quotaKey)) {
			return false;
		}

		try {
			getCircuitBreaker(getAccountCircuitKey(account)).canExecute();
			return true;
		} catch {
			tokenTracker.refundToken(trackerKey, quotaKey);
			return false;
		}
	}

	/**
	 * Refund a token consumed within the refund window (30 seconds).
	 * Use this when a request fails due to network errors (not rate limits).
	 * @returns true if refund was successful, false if no valid consumption found
	 */
	refundToken(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		const quotaKey = model ? `${family}:${model}` : family;
		const tokenTracker = getTokenTracker();
		return tokenTracker.refundToken(getRuntimeTrackerKey(account), quotaKey);
	}

	markSwitched(
		account: ManagedAccount,
		reason: "rate-limit" | "initial" | "rotation" | "manual",
		family: ModelFamily,
	): void {
		account.lastSwitchReason = reason;
		this.currentAccountIndexByFamily[family] = account.index;
		// HI-02: keep cursorByFamily in lockstep so subsequent round-robin
		// passes resume AFTER the just-switched account, matching the
		// convention used in getCurrentOrNextForFamilyHybrid / the
		// getCurrentOrNextForFamily inner loop. Without this, the cursor
		// still points at the pre-switch position and the next selection
		// can re-pick or skip the freshly marked account.
		const count = this.accounts.length;
		if (count > 0) {
			this.cursorByFamily[family] = (account.index + 1) % count;
		}
	}

	/**
	 * PR-N / R4: configure routing-mutex mode for this pool.
	 * Callers typically derive the value from `getRoutingMutexMode(pluginConfig)`
	 * at plugin init / settings reload. Called frequently during tests too; no
	 * side effects beyond mutating the private field.
	 */
	setRoutingMutexMode(mode: RoutingMutexMode): void {
		this.routingMutexMode = mode;
	}

	/** PR-N / R4: expose current mutex mode (mostly for diagnostics/tests). */
	getRoutingMutexMode(): RoutingMutexMode {
		return this.routingMutexMode;
	}

	/**
	 * PR-N / R4: mutex-serialized variant of `markSwitched`.
	 *
	 * Wraps the cursor mutation in the shared async mutex when
	 * `routingMutexMode === "enabled"`. In legacy mode it runs inline so the
	 * flag check stays O(1) per call. Returns a `SelectionRecord` describing
	 * the decision so the fetch loop can thread it through to observability.
	 */
	async markSwitchedLocked(
		account: ManagedAccount,
		reason: "rate-limit" | "initial" | "rotation" | "manual",
		family: ModelFamily,
		context?: { trackerKeyQuota?: string; score?: number },
	): Promise<SelectionRecord> {
		return withRoutingMutex(this.routingMutexMode, () => {
			account.lastSwitchReason = reason;
			this.currentAccountIndexByFamily[family] = account.index;
			// HI-02: keep cursorByFamily in lockstep with the active-index
			// mutation so the mutex-serialized variant preserves the same
			// round-robin invariant as the legacy `markSwitched` path.
			const count = this.accounts.length;
			if (count > 0) {
				this.cursorByFamily[family] = (account.index + 1) % count;
			}
			const trackerKey = getRuntimeTrackerKey(account);
			const healthTracker = getHealthTracker();
			const tokenTracker = getTokenTracker();
			const trackerKeyQuota = context?.trackerKeyQuota;
			return {
				accountIndex: account.index,
				accountId: account.accountId ?? account.email ?? String(trackerKey),
				reason,
				timestamp: nowMs(),
				trackerKeyQuota,
				health: healthTracker.getScore(trackerKey, trackerKeyQuota),
				tokens: tokenTracker.getTokens(trackerKey, trackerKeyQuota),
				score: context?.score,
			};
		});
	}

	/**
	 * PR-N / R4: mutex-serialized variant of `markAccountCoolingDown`.
	 * Same flag-gated behaviour as `markSwitchedLocked`.
	 */
	async markAccountCoolingDownLocked(
		account: ManagedAccount,
		cooldownMs: number,
		reason: CooldownReason,
	): Promise<void> {
		await withRoutingMutex(this.routingMutexMode, () => {
			const ms = Math.max(0, Math.floor(cooldownMs));
			account.coolingDownUntil = nowMs() + ms;
			account.cooldownReason = reason;
		});
	}

	/**
	 * PR-N / R4: mutex-serialized variant of `setActiveIndex`.
	 * Returns the newly active account on success, or `null` when the index
	 * is out of range / disabled (matching sync semantics).
	 */
	async setActiveIndexLocked(index: number): Promise<ManagedAccount | null> {
		return withRoutingMutex(this.routingMutexMode, () => {
			return this.setActiveIndex(index);
		});
	}

	markRateLimited(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		model?: string | null,
	): void {
		this.markRateLimitedWithReason(
			account,
			retryAfterMs,
			family,
			"unknown",
			model,
		);
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
		if (!model || reason === "quota" || reason === "unknown") {
			const currentResetAt = account.rateLimitResetTimes[baseKey] ?? 0;
			account.rateLimitResetTimes[baseKey] = Math.max(currentResetAt, resetAt);
		}

		if (
			model &&
			(reason === "tokens" || reason === "concurrent" || reason === "unknown")
		) {
			const modelKey = getQuotaKey(family, model);
			const currentResetAt = account.rateLimitResetTimes[modelKey] ?? 0;
			account.rateLimitResetTimes[modelKey] = Math.max(currentResetAt, resetAt);
		}

		account.lastRateLimitReason = reason;
	}

	markAccountCoolingDown(
		account: ManagedAccount,
		cooldownMs: number,
		reason: CooldownReason,
	): void {
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

	private isCircuitAvailable(account: ManagedAccount): boolean {
		return getCircuitBreaker(getAccountCircuitKey(account)).isAvailable();
	}

	incrementAuthFailures(account: ManagedAccount): number {
		account.consecutiveAuthFailures =
			(account.consecutiveAuthFailures ?? 0) + 1;
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
		if (
			accountIndex === this.lastToastAccountIndex &&
			now - this.lastToastTime < debounceMs
		) {
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
			shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
		) {
			account.accountId = tokenAccountId;
			account.accountIdSource = "token";
		}
		account.email =
			sanitizeEmail(extractAccountEmail(auth.access)) ?? account.email;
	}

	private buildStorageSnapshot(): AccountStorageV3 {
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			const raw = this.currentAccountIndexByFamily[family];
			activeIndexByFamily[family] = clampNonNegativeInt(raw, 0);
		}

		const activeIndex = clampNonNegativeInt(activeIndexByFamily.codex, 0);

		// Race protection: a CLI `switch`/`unpin`/`best` may have written a NEW
		// pin/gen between proxy startup (or the last save) and now. If we
		// persisted our stale instance values, we'd silently clobber the CLI
		// update on every routine save (rate-limit, cooldown, near-quota refund,
		// etc.). Re-read just before snapshotting and prefer the fresher value.
		// See #474.
		let effectivePinnedAccountIndex = this.pinnedAccountIndex;
		let effectiveAffinityGeneration = this.affinityGeneration;
		try {
			const onDisk = readPinAndGenFromDisk(getStoragePath());
			if (onDisk.affinityGeneration > effectiveAffinityGeneration) {
				effectiveAffinityGeneration = onDisk.affinityGeneration;
				// The pin is part of the same atomic write the CLI performs when
				// it bumps the generation, so a strictly-greater on-disk gen is
				// the signal that the disk pin is the authoritative one.
				effectivePinnedAccountIndex = onDisk.pinnedAccountIndex;
			}
			// Validate the refreshed pin against the live account count.
			if (
				effectivePinnedAccountIndex !== undefined &&
				(effectivePinnedAccountIndex < 0 ||
					effectivePinnedAccountIndex >= this.accounts.length)
			) {
				effectivePinnedAccountIndex = undefined;
			}
			// Cache the refreshed values so subsequent saves start from the
			// freshest known state without re-reading every time.
			this.pinnedAccountIndex = effectivePinnedAccountIndex;
			this.affinityGeneration = effectiveAffinityGeneration;
		} catch {
			// Disk read failures fall back to in-memory values; better than
			// dropping the snapshot save entirely.
		}

		const snapshot: AccountStorageV3 = {
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
					Object.keys(account.rateLimitResetTimes).length > 0
						? account.rateLimitResetTimes
						: undefined,
				coolingDownUntil: account.coolingDownUntil,
				cooldownReason: account.cooldownReason,
				workspaces: account.workspaces,
				currentWorkspaceIndex: account.currentWorkspaceIndex,
			})),
			activeIndex,
			activeIndexByFamily,
		};
		if (effectivePinnedAccountIndex !== undefined) {
			snapshot.pinnedAccountIndex = effectivePinnedAccountIndex;
		}
		if (effectiveAffinityGeneration > 0) {
			snapshot.affinityGeneration = effectiveAffinityGeneration;
		}
		return snapshot;
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
						if (previousLiveAccountState.coolingDownUntil === undefined) {
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
		const enabledAccounts = this.accounts.filter(
			(account) => account.enabled !== false,
		);
		const available = enabledAccounts.filter((account) => {
			clearExpiredRateLimits(account);
			return (
				!isRateLimitedForFamily(account, family, model) &&
				!this.isAccountCoolingDown(account) &&
				this.isCircuitAvailable(account)
			);
		});
		if (available.length > 0) return 0;
		if (enabledAccounts.length === 0) return 0;

		const waitTimes: number[] = [];
		const baseKey = getQuotaKey(family);
		const modelKey = model ? getQuotaKey(family, model) : null;

		for (const account of enabledAccounts) {
			const perAccountWaitTimes: number[] = [];
			const baseResetAt = account.rateLimitResetTimes[baseKey];
			if (typeof baseResetAt === "number") {
				perAccountWaitTimes.push(Math.max(0, baseResetAt - now));
			}

			if (modelKey) {
				const modelResetAt = account.rateLimitResetTimes[modelKey];
				if (typeof modelResetAt === "number") {
					perAccountWaitTimes.push(Math.max(0, modelResetAt - now));
				}
			}

			if (typeof account.coolingDownUntil === "number") {
				perAccountWaitTimes.push(Math.max(0, account.coolingDownUntil - now));
			}

			const breakerWait = getCircuitBreaker(
				getAccountCircuitKey(account),
			).getTimeUntilAvailable();
			if (breakerWait > 0) {
				perAccountWaitTimes.push(breakerWait);
			}

			if (perAccountWaitTimes.length > 0) {
				waitTimes.push(Math.max(...perAccountWaitTimes));
			}
		}

		return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
	}

	/**
	 * Walks forward from `start` (inclusive) looking for the next enabled
	 * account, wrapping around at most once. Returns -1 when every account in
	 * the pool is disabled or the pool is empty.
	 */
	private findNextEnabled(start: number): number {
		const count = this.accounts.length;
		if (count === 0) return -1;
		const base = ((start % count) + count) % count;
		for (let step = 0; step < count; step++) {
			const candidate = (base + step) % count;
			const account = this.accounts[candidate];
			if (account && account.enabled !== false) {
				return candidate;
			}
		}
		return -1;
	}

	removeAccount(account: ManagedAccount): boolean {
		const idx = this.accounts.indexOf(account);
		if (idx < 0) {
			return false;
		}

		// Snapshot family pointers before splice so we can distinguish "was
		// pointing at the removed account" from "was pointing past it".
		const priorCursor: Record<ModelFamily, number> = {} as Record<
			ModelFamily,
			number
		>;
		const priorActive: Record<ModelFamily, number> = {} as Record<
			ModelFamily,
			number
		>;
		for (const family of MODEL_FAMILIES) {
			priorCursor[family] = this.cursorByFamily[family];
			priorActive[family] = this.currentAccountIndexByFamily[family];
		}

		this.accounts.splice(idx, 1);
		// Clear identity-keyed tracker + circuit state for the removed account so a
		// later re-add of the same identity does not inherit stale health/token
		// penalties or an open circuit (accounts-02). Done before the numeric-range
		// clear below, which handles the index-shift of the *remaining* accounts.
		//
		// Tracker state is WRITTEN under getRuntimeTrackerKey (the pinned
		// _runtimeTrackerKey), which is intentionally STABLE across later identity
		// enrichment (see getRuntimeTrackerKey / updateFromAuth). The recomputed
		// getRuntimeAccountIdentityKey can DIFFER from that stable key when an
		// account was first tracked under an older key shape (e.g. "email:foo" or a
		// numeric index) and then gained accountId/email fields. Clearing only the
		// recomputed key would leave the real (stable) entries behind, so a re-add
		// inherits stale penalties. Clear the stable tracker key first (required),
		// then also clear the recomputed identity key when it differs to defensively
		// cover any state written under the post-enrichment shape.
		const removedTrackerKey = getRuntimeTrackerKey(account);
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();
		healthTracker.clearAccountKey(removedTrackerKey);
		tokenTracker.clearAccountKey(removedTrackerKey);
		const removedIdentityKey = getRuntimeAccountIdentityKey(account);
		if (
			removedIdentityKey !== undefined &&
			removedIdentityKey !== removedTrackerKey
		) {
			healthTracker.clearAccountKey(removedIdentityKey);
			tokenTracker.clearAccountKey(removedIdentityKey);
		}
		if (typeof account.circuitKeyId === "string" && account.circuitKeyId) {
			removeCircuitBreaker(account.circuitKeyId);
		}
		// Clear numeric-keyed tracker state in the shifted range. After reindex,
		// any refresh-only account that moved from N to N-1 must not inherit the
		// stale health/token entries that used to belong to the old numeric slot.
		getHealthTracker().clearNumericKeysAtOrAbove(idx);
		getTokenTracker().clearNumericKeysAtOrAbove(idx);
		this.accounts.forEach((acc, index) => {
			acc.index = index;
			// Invalidate the cached runtime tracker key when it was keyed by
			// numeric index (fallback path in getRuntimeAccountIdentityKey).
			// After the splice+reindex above, a remaining account that was at
			// index N (e.g. 3) may now live at index N-1 (e.g. 2); if we keep
			// the previously cached numeric key, rotation/health/token state
			// queries would consult the stale position and mismatch the
			// current one. Identity-based string keys remain stable because
			// accountId/email are not affected by array position changes.
			if (typeof acc._runtimeTrackerKey === "number") {
				acc._runtimeTrackerKey = undefined;
			}
		});

		if (this.accounts.length === 0) {
			for (const family of MODEL_FAMILIES) {
				this.cursorByFamily[family] = 0;
				this.currentAccountIndexByFamily[family] = -1;
			}
			return true;
		}

		// Track successor accounts that we explicitly retarget onto because the
		// removed account was the caller's "current" for a given family. We
		// stamp each such successor with lastSwitchReason="rotation" so the
		// retarget is auditable instead of silently carrying whatever stale
		// reason the successor already had (HI-04). De-duplicated across
		// families because lastSwitchReason is per-account, not per-family.
		const retargetedSuccessors = new Set<number>();

		for (const family of MODEL_FAMILIES) {
			// Cursor: shift down if it was past the removed index, then normalize
			// into [0, length). If the cursor was pointing AT the removed slot
			// we keep the same numeric position which now references the
			// successor account (post-splice).
			let cursor = priorCursor[family];
			if (cursor > idx) {
				cursor = Math.max(0, cursor - 1);
			}
			if (cursor >= this.accounts.length) {
				cursor = 0;
			}
			if (cursor < 0) {
				cursor = 0;
			}
			this.cursorByFamily[family] = cursor;

			// Active pointer: preserve pre-PR behavior for pointers strictly
			// past the removed index (just shift down). When the pointer was
			// AT the removed slot (or is now dangling off the end after
			// splice), advance to the next enabled account instead of
			// defaulting to -1. Fall back to -1 only when every remaining
			// account is disabled or the pool is empty. When we retarget off
			// the removed slot onto a different account, record the successor
			// so we can explicitly signal the retarget via lastSwitchReason.
			let active = priorActive[family];
			const activeWasRemoved = active === idx;
			if (active > idx) {
				active -= 1;
			} else if (activeWasRemoved) {
				// Same numeric position now hosts the successor account.
				active = this.findNextEnabled(Math.min(idx, this.accounts.length - 1));
			}
			if (active >= this.accounts.length) {
				active = this.findNextEnabled(0);
			}
			this.currentAccountIndexByFamily[family] = active;
			if (activeWasRemoved && active >= 0 && active < this.accounts.length) {
				retargetedSuccessors.add(active);
			}
		}

		// Stamp retarget signal on each successor account that replaced a
		// removed "current" pointer. This mirrors the existing rotation
		// convention used by setActiveIndex / markSwitched, so downstream
		// callers observing lastSwitchReason see a clear audit trail that the
		// pool re-chose this account rather than the user selecting it
		// themselves.
		for (const successorIdx of retargetedSuccessors) {
			const successor = this.accounts[successorIdx];
			if (successor) {
				successor.lastSwitchReason = "rotation";
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
		// Repair any active-index pointer that now references a disabled account
		// so UI / automation / routing do not hold a stale pointer to a slot
		// that cannot route (AUDIT-H10 / D-05). Walks forward to the next enabled
		// account for each family whose pointer matches the just-disabled index.
		// Both currentAccountIndexByFamily and cursorByFamily must be normalized
		// in lockstep — leaving cursor stale is a latent inconsistency that the
		// rotation skip-disabled loop currently masks (oracle audit F2).
		if (!enabled) {
			const findNextEnabled = (start: number): number => {
				for (let step = 1; step < this.accounts.length; step += 1) {
					const candidate = (start + step) % this.accounts.length;
					if (this.accounts[candidate]?.enabled !== false) return candidate;
				}
				return -1;
			};
			for (const family of Object.keys(
				this.currentAccountIndexByFamily,
			) as ModelFamily[]) {
				if (this.currentAccountIndexByFamily[family] === index) {
					const next = findNextEnabled(index);
					if (next !== -1) {
						this.currentAccountIndexByFamily[family] = next;
					}
				}
				if (this.cursorByFamily[family] === index) {
					const next = findNextEnabled(index);
					if (next !== -1) {
						this.cursorByFamily[family] = next;
					}
				}
			}
		}
		return account;
	}

	async saveToDisk(): Promise<void> {
		await runWithStoragePathState(this.storagePathState, async () => {
			await withAccountStorageTransaction(async (_current, persist) => {
				await persist(this.buildStorageSnapshot());
			});
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
					log.warn("Debounced save failed", {
						error: error instanceof Error ? error.message : String(error),
					});
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

		const resetIndex = account.workspaces.findIndex(
			(workspace) => workspace.isDefault === true,
		);

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

/**
 * Name of the account's currently-selected workspace, if any. Lets same-email
 * accounts that live in different workspaces (personal Plus vs business/team)
 * stay distinguishable in `list`/`status` output. See issue #491.
 */
function activeWorkspaceName(
	account:
		| { workspaces?: Workspace[]; currentWorkspaceIndex?: number }
		| undefined,
): string | undefined {
	const workspaces = account?.workspaces;
	if (!workspaces || workspaces.length === 0) return undefined;
	const idx = account?.currentWorkspaceIndex ?? 0;
	const workspace = workspaces[idx] ?? workspaces[0];
	return workspace?.name?.trim() || undefined;
}

export function formatAccountLabel(
	account:
		| {
				email?: string;
				accountId?: string;
				accountLabel?: string;
				workspaces?: Workspace[];
				currentWorkspaceIndex?: number;
		  }
		| undefined,
	index: number,
): string {
	const accountLabel = account?.accountLabel?.trim();
	const workspaceName = activeWorkspaceName(account);
	const email = account?.email?.trim();
	const accountId = account?.accountId?.trim();
	const idSuffix = accountId
		? accountId.length > 6
			? accountId.slice(-6)
			: accountId
		: null;

	const segments: string[] = [];
	if (accountLabel) segments.push(accountLabel);
	// Surface the active workspace so two same-email accounts in different
	// workspaces remain distinguishable; skip it when it would just repeat the
	// manual account label.
	if (workspaceName && workspaceName !== accountLabel) {
		segments.push(`[${workspaceName}]`);
	}
	if (email) segments.push(email);
	// A bare id stands alone (e.g. "Account 1 (123456)"); once any other
	// segment precedes it, prefix with "id:" for clarity.
	if (idSuffix) {
		segments.push(segments.length > 0 ? `id:${idSuffix}` : idSuffix);
	}

	if (segments.length === 0) return `Account ${index + 1}`;
	return `Account ${index + 1} (${segments.join(", ")})`;
}

/**
 * One display line per workspace tracked on an account, with the active one
 * marked. Lets `status`/`list` and the `workspace` command show every workspace
 * a same-email account can rotate between (issue #491). Callers decide when to
 * render these (e.g. only when more than one workspace exists) and supply the
 * leading indent.
 */
export function formatWorkspaceLines(
	account:
		| { workspaces?: Workspace[]; currentWorkspaceIndex?: number }
		| undefined,
	indent = "   ",
): string[] {
	const workspaces = account?.workspaces;
	if (!workspaces || workspaces.length === 0) return [];
	const activeIndex = account?.currentWorkspaceIndex ?? 0;
	return workspaces.map((workspace, idx) => {
		const isActive = idx === activeIndex;
		const name = workspace.name?.trim() || "(unnamed)";
		const id = workspace.id?.trim() ?? "";
		const idSuffix = id.length > 6 ? id.slice(-6) : id;
		const tags: string[] = [];
		if (isActive) tags.push("active");
		if (workspace.enabled === false) tags.push("disabled");
		const tagLabel = tags.length > 0 ? ` (${tags.join(", ")})` : "";
		const idLabel = idSuffix ? ` id:${idSuffix}` : "";
		return `${indent}${isActive ? "*" : "-"} ${idx + 1}. [${name}]${idLabel}${tagLabel}`;
	});
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
