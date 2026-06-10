import { extractAccountId, sanitizeEmail } from "../accounts.js";
import type { ExistingAccountInfo } from "../cli.js";
import { loadCodexCliState } from "../codex-cli/state.js";
import { setCodexCliActiveSelection } from "../codex-cli/writer.js";
import {
	type DashboardAccountSortMode,
	type DashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
} from "../dashboard-settings.js";
import {
	loadQuotaCache,
	type QuotaCacheData,
	type QuotaCacheEntry,
	saveQuotaCache,
} from "../quota-cache.js";
import {
	type CodexQuotaSnapshot,
	fetchCodexQuotaSnapshot,
} from "../quota-probe.js";
import {
	buildQuotaEmailFallbackState,
	hasSafeQuotaEmailFallback,
	hasUniqueQuotaAccountId,
	isQuotaCacheEntryExhausted,
	normalizeQuotaAccountId,
	quotaLeftPercentFromUsed,
} from "../quota-readiness.js";
import { resolveActiveIndex } from "../runtime/account-status.js";
import { getAppBindStatus } from "../runtime/app-bind.js";
import {
	isDisplayCurrentAccount,
	readAppRuntimeHelperAccountSignal,
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
	type RuntimeCurrentAccountSelection,
} from "../runtime/runtime-current-account.js";
import { loadPersistedRuntimeObservabilitySnapshot } from "../runtime/runtime-observability.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../storage.js";
import { hasUsableAccessToken } from "./account-credentials.js";
import {
	formatAccountQuotaSummary,
	formatRateLimitEntry,
} from "./formatters/index.js";
import {
	cloneQuotaCacheData,
	DEFAULT_LIVE_PROBE_MODEL,
	getPersistedQuotaViewForAccount,
	updateQuotaCacheForAccount,
} from "./quota-cache-helpers.js";
import { resolveMenuLayoutMode } from "./settings-hub.js";

/**
 * Data layer for the login dashboard menu: quota auto-refresh targeting, the
 * account-row view model (`ExistingAccountInfo`), runtime current-account
 * resolution, and Codex CLI selection drift sync. Moved verbatim out of the
 * `login` handler body in lib/codex-manager.ts (audit roadmap §4.1.1 phase 3).
 * The interactive login control loop itself still lives in codex-manager.ts.
 */

export const DEFAULT_MENU_QUOTA_REFRESH_TTL_MS = 5 * 60_000;
const MENU_QUOTA_REFRESH_MODEL = DEFAULT_LIVE_PROBE_MODEL;

interface MenuQuotaProbeTarget {
	account: AccountMetadataV3;
	accountId: string;
	accessToken: string;
}

function resolveMenuQuotaProbeInput(
	account: AccountMetadataV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	now: number,
	accounts: readonly Pick<AccountMetadataV3, "accountId" | "email">[],
	emailFallbackState = buildQuotaEmailFallbackState(accounts),
): { accountId: string; accessToken: string } | null {
	if (account.enabled === false) return null;
	if (!hasUsableAccessToken(account, now)) return null;

	const existing = getPersistedQuotaViewForAccount(
		cache,
		account,
		accounts,
		now,
		emailFallbackState,
	);
	if (
		existing &&
		typeof existing.updatedAt === "number" &&
		Number.isFinite(existing.updatedAt) &&
		now - existing.updatedAt < maxAgeMs
	) {
		return null;
	}

	// Menu auto-refresh is cache-backed, so only probe when the result can be
	// written behind a safe lookup key for later reuse.
	const canStore =
		(normalizeQuotaAccountId(account.accountId) !== null &&
			hasUniqueQuotaAccountId(accounts, account)) ||
		hasSafeQuotaEmailFallback(emailFallbackState, account);
	if (!canStore) return null;

	const accessToken = account.accessToken;
	const accountId = accessToken
		? (account.accountId ?? extractAccountId(accessToken))
		: account.accountId;
	if (!accountId || !accessToken) return null;
	return { accountId, accessToken };
}

function collectMenuQuotaRefreshTargets(
	storage: AccountStorageV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	now = Date.now(),
	emailFallbackState = buildQuotaEmailFallbackState(storage.accounts),
): MenuQuotaProbeTarget[] {
	const targets: MenuQuotaProbeTarget[] = [];
	for (const account of storage.accounts) {
		const probeInput = resolveMenuQuotaProbeInput(
			account,
			cache,
			maxAgeMs,
			now,
			storage.accounts,
			emailFallbackState,
		);
		if (!probeInput) continue;
		targets.push({
			account,
			accountId: probeInput.accountId,
			accessToken: probeInput.accessToken,
		});
	}
	return targets;
}

export function countMenuQuotaRefreshTargets(
	storage: AccountStorageV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	now = Date.now(),
): number {
	const emailFallbackState = buildQuotaEmailFallbackState(storage.accounts);
	let count = 0;
	for (const account of storage.accounts) {
		if (
			resolveMenuQuotaProbeInput(
				account,
				cache,
				maxAgeMs,
				now,
				storage.accounts,
				emailFallbackState,
			)
		) {
			count += 1;
		}
	}
	return count;
}

export async function refreshQuotaCacheForMenu(
	storage: AccountStorageV3,
	cache: QuotaCacheData,
	maxAgeMs: number,
	onProgress?: (current: number, total: number) => void,
): Promise<QuotaCacheData> {
	if (storage.accounts.length === 0) {
		return cache;
	}

	const emailFallbackState = buildQuotaEmailFallbackState(storage.accounts);
	const nextCache = cloneQuotaCacheData(cache);
	const now = Date.now();
	const targets = collectMenuQuotaRefreshTargets(
		storage,
		nextCache,
		maxAgeMs,
		now,
		emailFallbackState,
	);
	const total = targets.length;
	let processed = 0;
	onProgress?.(processed, total);
	let changed = false;
	const appliedSnapshots: {
		account: AccountMetadataV3;
		snapshot: CodexQuotaSnapshot;
	}[] = [];
	for (const target of targets) {
		processed += 1;
		onProgress?.(processed, total);

		try {
			const snapshot = await fetchCodexQuotaSnapshot({
				accountId: target.accountId,
				accessToken: target.accessToken,
				model: MENU_QUOTA_REFRESH_MODEL,
			});
			const applied = updateQuotaCacheForAccount(
				nextCache,
				target.account,
				snapshot,
				storage.accounts,
				emailFallbackState,
			);
			if (applied) appliedSnapshots.push({ account: target.account, snapshot });
			changed = applied || changed;
		} catch {
			// Keep existing cached values if probing fails.
		}
	}

	if (changed) {
		// The probes above ran against a snapshot clone of the cache the menu
		// loaded; another writer (a deep check, a second session) may have saved
		// entries meanwhile, and writing the stale clone back whole-file would
		// silently discard them (last write wins). Re-apply this run's results
		// onto the freshest persisted cache instead.
		let cacheToSave = nextCache;
		try {
			const persisted = await loadQuotaCache();
			for (const { account, snapshot } of appliedSnapshots) {
				updateQuotaCacheForAccount(
					persisted,
					account,
					snapshot,
					storage.accounts,
					emailFallbackState,
				);
			}
			cacheToSave = persisted;
		} catch {
			// Fall back to the snapshot clone; saving slightly stale data beats
			// dropping this run's probe results.
		}
		try {
			await saveQuotaCache(cacheToSave);
		} catch (error) {
			// Quota cache is a derived artifact; a transient Windows EBUSY/EPERM
			// here must not fail the menu refresh, but it should not vanish into
			// the caller's background .catch either (same pattern as the health
			// check's save).
			console.warn(
				`Quota cache save failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return cacheToSave;
	}

	return nextCache;
}

function mapAccountStatus(
	account: AccountMetadataV3,
	isCurrentAccount: boolean,
	now: number,
	persistedQuotaEntry?: QuotaCacheEntry | null,
): ExistingAccountInfo["status"] {
	if (account.enabled === false) return "disabled";
	if (
		typeof account.coolingDownUntil === "number" &&
		account.coolingDownUntil > now
	) {
		return "cooldown";
	}
	if (persistedQuotaEntry && isQuotaCacheEntryExhausted(persistedQuotaEntry, now)) {
		return "quota-exhausted";
	}
	if (persistedQuotaEntry?.status === 429) return "rate-limited";
	const rateLimit = formatRateLimitEntry(account, now, "codex");
	if (rateLimit) return "rate-limited";
	if (isCurrentAccount) return "active";
	return "ok";
}

function parseLeftPercentFromQuotaSummary(
	summary: string | undefined,
	windowLabel: "5h" | "7d",
): number {
	if (!summary) return -1;
	const match = summary.match(
		new RegExp(`(?:^|\\|)\\s*${windowLabel}\\s+(\\d{1,3})%`, "i"),
	);
	const value = Number.parseInt(match?.[1] ?? "", 10);
	if (!Number.isFinite(value)) return -1;
	return Math.max(0, Math.min(100, value));
}

function readQuotaLeftPercent(
	account: ExistingAccountInfo,
	windowLabel: "5h" | "7d",
): number {
	const direct =
		windowLabel === "5h"
			? account.quota5hLeftPercent
			: account.quota7dLeftPercent;
	if (typeof direct === "number" && Number.isFinite(direct)) {
		return Math.max(0, Math.min(100, Math.round(direct)));
	}
	return parseLeftPercentFromQuotaSummary(account.quotaSummary, windowLabel);
}

function readQuotaFloorPercent(account: ExistingAccountInfo): number {
	return Math.min(
		readQuotaLeftPercent(account, "5h"),
		readQuotaLeftPercent(account, "7d"),
	);
}

function accountStatusSortBucket(
	status: ExistingAccountInfo["status"],
): number {
	switch (status) {
		case "active":
		case "ok":
			return 0;
		case "unknown":
			return 1;
		case "quota-exhausted":
		case "cooldown":
		case "rate-limited":
			return 2;
		case "disabled":
		case "error":
		case "flagged":
			return 3;
		default:
			return 1;
	}
}

function accountReadinessSortBucket(account: ExistingAccountInfo): number {
	const statusBucket = accountStatusSortBucket(account.status);
	if (statusBucket >= 2) return statusBucket;
	return account.quotaRateLimited || account.quotaExhausted ? 2 : statusBucket;
}

function compareReadyFirstAccounts(
	left: ExistingAccountInfo,
	right: ExistingAccountInfo,
): number {
	const bucketDelta =
		accountReadinessSortBucket(left) - accountReadinessSortBucket(right);
	if (bucketDelta !== 0) return bucketDelta;

	const leftFloor = readQuotaFloorPercent(left);
	const rightFloor = readQuotaFloorPercent(right);
	if (leftFloor !== rightFloor) return rightFloor - leftFloor;

	const left5h = readQuotaLeftPercent(left, "5h");
	const right5h = readQuotaLeftPercent(right, "5h");
	if (left5h !== right5h) return right5h - left5h;

	const left7d = readQuotaLeftPercent(left, "7d");
	const right7d = readQuotaLeftPercent(right, "7d");
	if (left7d !== right7d) return right7d - left7d;

	const leftLastUsed = left.lastUsed ?? 0;
	const rightLastUsed = right.lastUsed ?? 0;
	if (leftLastUsed !== rightLastUsed) return rightLastUsed - leftLastUsed;

	const leftSource = left.sourceIndex ?? left.index;
	const rightSource = right.sourceIndex ?? right.index;
	return leftSource - rightSource;
}

function applyAccountMenuOrdering(
	accounts: ExistingAccountInfo[],
	displaySettings: DashboardDisplaySettings,
): ExistingAccountInfo[] {
	const sortEnabled =
		displaySettings.menuSortEnabled ??
		DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
		true;
	const sortMode: DashboardAccountSortMode =
		displaySettings.menuSortMode ??
		DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
		"ready-first";
	if (!sortEnabled || sortMode !== "ready-first") {
		return [...accounts];
	}

	const sorted = [...accounts].sort(compareReadyFirstAccounts);
	const pinCurrent =
		displaySettings.menuSortPinCurrent ??
		DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
		false;
	if (pinCurrent) {
		const currentIndex = sorted.findIndex(
			(account) => account.isCurrentAccount,
		);
		if (currentIndex > 0) {
			const current = sorted.splice(currentIndex, 1)[0];
			const first = sorted[0];
			if (current && first && compareReadyFirstAccounts(current, first) <= 0) {
				sorted.unshift(current);
			} else if (current) {
				sorted.splice(currentIndex, 0, current);
			}
		}
	}
	return sorted;
}

export function toExistingAccountInfo(
	storage: AccountStorageV3,
	quotaCache: QuotaCacheData | null,
	displaySettings: DashboardDisplaySettings,
	runtimeCurrent: RuntimeCurrentAccountSelection | null = null,
): ExistingAccountInfo[] {
	const now = Date.now();
	const activeIndex = resolveActiveIndex(storage, "codex");
	const layoutMode = resolveMenuLayoutMode(displaySettings);
	const emailFallbackState = buildQuotaEmailFallbackState(storage.accounts);
	const baseAccounts = storage.accounts.map((account, index) => {
		const entry = getPersistedQuotaViewForAccount(
			quotaCache,
			account,
			storage.accounts,
			now,
			emailFallbackState,
		);
		const currentMarkers = resolveAccountCurrentMarkers(
			index,
			activeIndex,
			runtimeCurrent,
		);
		const isCurrentAccount = isDisplayCurrentAccount(
			index,
			activeIndex,
			runtimeCurrent,
		);
		const quotaExhausted = entry ? isQuotaCacheEntryExhausted(entry, now) : false;
		return {
			index,
			sourceIndex: index,
			accountId: account.accountId,
			accountLabel: account.accountLabel,
			email: account.email,
			addedAt: account.addedAt,
			lastUsed: account.lastUsed,
			status: mapAccountStatus(account, isCurrentAccount, now, entry),
			quotaSummary:
				(displaySettings.menuShowQuotaSummary ?? true) && entry
					? formatAccountQuotaSummary(entry, now)
					: undefined,
			quota5hLeftPercent: quotaLeftPercentFromUsed(entry?.primary.usedPercent),
			quota5hResetAtMs: entry?.primary.resetAtMs,
			quota7dLeftPercent: quotaLeftPercentFromUsed(
				entry?.secondary.usedPercent,
			),
			quota7dResetAtMs: entry?.secondary.resetAtMs,
			quotaRateLimited: entry?.status === 429,
			quotaExhausted,
			isCurrentAccount,
			isDefaultAccount: index === activeIndex,
			isRuntimeCurrentAccount: runtimeCurrent?.index === index,
			currentMarkers,
			enabled: account.enabled !== false,
			showStatusBadge: displaySettings.menuShowStatusBadge ?? true,
			showCurrentBadge: displaySettings.menuShowCurrentBadge ?? true,
			showLastUsed: displaySettings.menuShowLastUsed ?? true,
			showQuotaCooldown: displaySettings.menuShowQuotaCooldown ?? true,
			showHintsForUnselectedRows: layoutMode === "expanded-rows",
			highlightCurrentRow: displaySettings.menuHighlightCurrentRow ?? true,
			focusStyle: displaySettings.menuFocusStyle ?? "row-invert",
			statuslineFields: displaySettings.menuStatuslineFields ?? [
				"last-used",
				"limits",
				"status",
			],
		};
	});
	const orderedAccounts = applyAccountMenuOrdering(
		baseAccounts,
		displaySettings,
	);
	const quickSwitchUsesVisibleRows =
		displaySettings.menuSortQuickSwitchVisibleRow ?? true;
	return orderedAccounts.map((account, displayIndex) => ({
		...account,
		index: displayIndex,
		quickSwitchNumber: quickSwitchUsesVisibleRows
			? displayIndex + 1
			: (account.sourceIndex ?? displayIndex) + 1,
		}));
}

export async function loadRuntimeCurrentSelectionForStorage(
	storage: AccountStorageV3,
	now = Date.now(),
): Promise<RuntimeCurrentAccountSelection | null> {
	const [runtimeSnapshot, appBindStatus] = await Promise.all([
		loadPersistedRuntimeObservabilitySnapshot().catch(() => null),
		getAppBindStatus()
			.then((status) => (status.running ? status.router : null))
			.catch(() => null),
	]);
	return resolveRuntimeCurrentAccount(
		storage,
		{
			runtimeSnapshot,
			appBindStatus,
			appHelperStatus: readAppRuntimeHelperAccountSignal(),
		},
		{ now },
	);
}

function activeAccountMatchesCodexCliState(
	account: AccountMetadataV3,
	state: Awaited<ReturnType<typeof loadCodexCliState>>,
): boolean {
	if (!state) return true;
	const accountId = account.accountId?.trim();
	const activeAccountId = state.activeAccountId?.trim();
	if (accountId && activeAccountId) {
		return accountId === activeAccountId;
	}

	const email = sanitizeEmail(account.email);
	const activeEmail = sanitizeEmail(state.activeEmail);
	if (email && activeEmail) {
		return email === activeEmail;
	}

	return false;
}

export async function syncCodexCliActiveSelectionIfDrifted(
	storage: AccountStorageV3,
): Promise<boolean> {
	const activeIndex = resolveActiveIndex(storage, "codex");
	if (activeIndex < 0 || activeIndex >= storage.accounts.length) {
		return false;
	}
	const account = storage.accounts[activeIndex];
	if (!account) {
		return false;
	}

	try {
		const cliState = await loadCodexCliState({ forceRefresh: true });
		if (!cliState || activeAccountMatchesCodexCliState(account, cliState)) {
			return false;
		}
		return setCodexCliActiveSelection({
			accountId: account.accountId,
			email: account.email,
			accessToken: account.accessToken,
			refreshToken: account.refreshToken,
			expiresAt: account.expiresAt,
		});
	} catch {
		return false;
	}
}
