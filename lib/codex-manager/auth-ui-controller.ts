import { formatWaitTime, sanitizeEmail } from "../accounts.js";
import type { LoginMenuResult } from "../cli.js";
import {
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	type DashboardDisplaySettings,
	type DashboardAccountSortMode,
} from "../dashboard-settings.js";
import { formatQuotaSnapshotLine, type CodexQuotaSnapshot } from "../quota-probe.js";
import type { QuotaCacheData, QuotaCacheEntry } from "../quota-cache.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../storage.js";
import { UI_COPY, formatCheckFlaggedLabel } from "../ui/copy.js";
import { resolveMenuLayoutMode } from "./settings-hub.js";
import type { ModelFamily } from "../prompts/codex.js";

export type AuthAccountStatus =
	| "active"
	| "ok"
	| "rate-limited"
	| "cooldown"
	| "disabled"
	| "error"
	| "flagged"
	| "unknown";

export interface AuthAccountViewModel {
	index: number;
	sourceIndex?: number;
	quickSwitchNumber?: number;
	accountId?: string;
	accountLabel?: string;
	email?: string;
	addedAt?: number;
	lastUsed?: number;
	status?: AuthAccountStatus;
	quotaSummary?: string;
	quota5hLeftPercent?: number;
	quota5hResetAtMs?: number;
	quota7dLeftPercent?: number;
	quota7dResetAtMs?: number;
	quotaRateLimited?: boolean;
	isCurrentAccount?: boolean;
	enabled?: boolean;
	showStatusBadge?: boolean;
	showCurrentBadge?: boolean;
	showLastUsed?: boolean;
	showQuotaCooldown?: boolean;
	showHintsForUnselectedRows?: boolean;
	highlightCurrentRow?: boolean;
	focusStyle?: "row-invert" | "chip";
	statuslineFields?: string[];
}

export interface AuthDashboardMenuOptionsViewModel {
	flaggedCount?: number;
	statusMessage?: string | (() => string | undefined);
}

export type AuthDashboardSectionId = "quick-actions" | "advanced-checks" | "saved-accounts" | "danger-zone";
export type AuthDashboardActionId =
	| "add"
	| "check"
	| "forecast"
	| "fix"
	| "settings"
	| "deep-check"
	| "verify-flagged"
	| "delete-all";

export interface AuthDashboardActionViewModel {
	id: AuthDashboardActionId;
	label: string;
	tone: "green" | "yellow" | "red";
}

export interface AuthDashboardSectionViewModel {
	id: AuthDashboardSectionId;
	title: string;
	actions: AuthDashboardActionViewModel[];
}

export interface AuthDashboardViewModel {
	accounts: AuthAccountViewModel[];
	menuOptions: AuthDashboardMenuOptionsViewModel;
	sections: AuthDashboardSectionViewModel[];
}

export interface BuildAuthDashboardViewModelOptions {
	storage: AccountStorageV3;
	quotaCache: QuotaCacheData | null;
	displaySettings: DashboardDisplaySettings;
	flaggedCount?: number;
	statusMessage?: string | (() => string | undefined);
}

export interface AuthDashboardActionPanelViewModel {
	title: string;
	stage: string;
}

export type AuthDashboardCommand =
	| { type: "cancel" }
	| { type: "add-account" }
	| { type: "open-settings" }
	| {
		type: "run-health-check";
		panel: AuthDashboardActionPanelViewModel;
		forceRefresh: boolean;
		liveProbe: boolean;
	}
	| { type: "run-forecast"; panel: AuthDashboardActionPanelViewModel; args: string[] }
	| { type: "run-fix"; panel: AuthDashboardActionPanelViewModel; args: string[] }
	| { type: "run-verify-flagged"; panel: AuthDashboardActionPanelViewModel; args: string[] }
	| { type: "reset-accounts"; panel: AuthDashboardActionPanelViewModel }
	| {
		type: "manage-account";
		menuResult: LoginMenuResult;
		requiresInlineFlow: boolean;
		panel?: AuthDashboardActionPanelViewModel;
	};

export function resolveActiveIndex(
	storage: AccountStorageV3,
	family: ModelFamily = "codex",
): number {
	const total = storage.accounts.length;
	if (total === 0) return 0;
	const rawCandidate = storage.activeIndexByFamily?.[family] ?? storage.activeIndex;
	const raw = Number.isFinite(rawCandidate) ? rawCandidate : 0;
	return Math.max(0, Math.min(raw, total - 1));
}

function getRateLimitResetTimeForFamily(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily,
): number | null {
	const times = account.rateLimitResetTimes;
	if (!times) return null;

	let minReset: number | null = null;
	const prefix = `${family}:`;
	for (const [key, value] of Object.entries(times)) {
		if (typeof value !== "number") continue;
		if (value <= now) continue;
		if (key !== family && !key.startsWith(prefix)) continue;
		if (minReset === null || value < minReset) {
			minReset = value;
		}
	}

	return minReset;
}

export function formatRateLimitEntry(
	account: { rateLimitResetTimes?: Record<string, number | undefined> },
	now: number,
	family: ModelFamily = "codex",
): string | null {
	const resetAt = getRateLimitResetTimeForFamily(account, now, family);
	if (typeof resetAt !== "number") return null;
	const remaining = resetAt - now;
	if (remaining <= 0) return null;
	return `resets in ${formatWaitTime(remaining)}`;
}

function normalizeQuotaEmail(email: string | undefined): string | null {
	const normalized = sanitizeEmail(email);
	return normalized && normalized.length > 0 ? normalized : null;
}

function quotaCacheEntryToSnapshot(entry: QuotaCacheEntry): CodexQuotaSnapshot {
	return {
		status: entry.status,
		planType: entry.planType,
		model: entry.model,
		primary: {
			usedPercent: entry.primary.usedPercent,
			windowMinutes: entry.primary.windowMinutes,
			resetAtMs: entry.primary.resetAtMs,
		},
		secondary: {
			usedPercent: entry.secondary.usedPercent,
			windowMinutes: entry.secondary.windowMinutes,
			resetAtMs: entry.secondary.resetAtMs,
		},
	};
}

function formatCompactQuotaWindowLabel(windowMinutes: number | undefined): string {
	if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

function formatCompactQuotaPart(windowMinutes: number | undefined, usedPercent: number | undefined): string | null {
	const label = formatCompactQuotaWindowLabel(windowMinutes);
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return null;
	}
	const left = quotaLeftPercentFromUsed(usedPercent);
	return `${label} ${left}%`;
}

function quotaLeftPercentFromUsed(usedPercent: number | undefined): number | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
		return undefined;
	}
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

export function formatCompactQuotaSnapshot(snapshot: CodexQuotaSnapshot): string {
	const parts = [
		formatCompactQuotaPart(snapshot.primary.windowMinutes, snapshot.primary.usedPercent),
		formatCompactQuotaPart(snapshot.secondary.windowMinutes, snapshot.secondary.usedPercent),
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	if (snapshot.status === 429) {
		parts.push("rate-limited");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(snapshot);
}

function formatAccountQuotaSummary(entry: QuotaCacheEntry): string {
	const parts = [
		formatCompactQuotaPart(entry.primary.windowMinutes, entry.primary.usedPercent),
		formatCompactQuotaPart(entry.secondary.windowMinutes, entry.secondary.usedPercent),
	].filter((value): value is string => typeof value === "string" && value.length > 0);
	if (entry.status === 429) {
		parts.push("rate-limited");
	}
	if (parts.length > 0) {
		return parts.join(" | ");
	}
	return formatQuotaSnapshotLine(quotaCacheEntryToSnapshot(entry));
}

export function getQuotaCacheEntryForAccount(
	cache: QuotaCacheData,
	account: Pick<AccountMetadataV3, "accountId" | "email">,
): QuotaCacheEntry | null {
	if (account.accountId && cache.byAccountId[account.accountId]) {
		return cache.byAccountId[account.accountId] ?? null;
	}
	const email = normalizeQuotaEmail(account.email);
	if (email && cache.byEmail[email]) {
		return cache.byEmail[email] ?? null;
	}
	return null;
}

function mapAccountStatus(
	account: AccountMetadataV3,
	index: number,
	activeIndex: number,
	now: number,
): AuthAccountViewModel["status"] {
	if (account.enabled === false) return "disabled";
	if (typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now) {
		return "cooldown";
	}
	const rateLimit = formatRateLimitEntry(account, now, "codex");
	if (rateLimit) return "rate-limited";
	if (index === activeIndex) return "active";
	return "ok";
}

function parseLeftPercentFromQuotaSummary(
	summary: string | undefined,
	windowLabel: "5h" | "7d",
): number {
	if (!summary) return -1;
	const match = summary.match(new RegExp(`(?:^|\\|)\\s*${windowLabel}\\s+(\\d{1,3})%`, "i"));
	const value = Number.parseInt(match?.[1] ?? "", 10);
	if (!Number.isFinite(value)) return -1;
	return Math.max(0, Math.min(100, value));
}

function readQuotaLeftPercent(
	account: AuthAccountViewModel,
	windowLabel: "5h" | "7d",
): number {
	const direct = windowLabel === "5h" ? account.quota5hLeftPercent : account.quota7dLeftPercent;
	if (typeof direct === "number" && Number.isFinite(direct)) {
		return Math.max(0, Math.min(100, Math.round(direct)));
	}
	return parseLeftPercentFromQuotaSummary(account.quotaSummary, windowLabel);
}

function accountStatusSortBucket(status: AuthAccountViewModel["status"]): number {
	switch (status) {
		case "active":
		case "ok":
			return 0;
		case "unknown":
			return 1;
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

function compareReadyFirstAccounts(
	left: AuthAccountViewModel,
	right: AuthAccountViewModel,
): number {
	const left5h = readQuotaLeftPercent(left, "5h");
	const right5h = readQuotaLeftPercent(right, "5h");
	if (left5h !== right5h) return right5h - left5h;

	const left7d = readQuotaLeftPercent(left, "7d");
	const right7d = readQuotaLeftPercent(right, "7d");
	if (left7d !== right7d) return right7d - left7d;

	const bucketDelta = accountStatusSortBucket(left.status) - accountStatusSortBucket(right.status);
	if (bucketDelta !== 0) return bucketDelta;

	const leftLastUsed = left.lastUsed ?? 0;
	const rightLastUsed = right.lastUsed ?? 0;
	if (leftLastUsed !== rightLastUsed) return rightLastUsed - leftLastUsed;

	const leftSource = left.sourceIndex ?? left.index;
	const rightSource = right.sourceIndex ?? right.index;
	return leftSource - rightSource;
}

function applyAccountMenuOrdering(
	accounts: AuthAccountViewModel[],
	displaySettings: DashboardDisplaySettings,
): AuthAccountViewModel[] {
	const sortEnabled =
		displaySettings.menuSortEnabled ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? true);
	const sortMode: DashboardAccountSortMode =
		displaySettings.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first");
	if (!sortEnabled || sortMode !== "ready-first") {
		return [...accounts];
	}

	const sorted = [...accounts].sort(compareReadyFirstAccounts);
	const pinCurrent = displaySettings.menuSortPinCurrent ??
		(DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ?? false);
	if (pinCurrent) {
		const currentIndex = sorted.findIndex((account) => account.isCurrentAccount);
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

function toAuthAccountViewModels(
	storage: AccountStorageV3,
	quotaCache: QuotaCacheData | null,
	displaySettings: DashboardDisplaySettings,
): AuthAccountViewModel[] {
	const now = Date.now();
	const activeIndex = resolveActiveIndex(storage, "codex");
	const layoutMode = resolveMenuLayoutMode(displaySettings);
	const baseAccounts = storage.accounts.map((account, index) => {
		const entry = quotaCache ? getQuotaCacheEntryForAccount(quotaCache, account) : null;
		return {
			index,
			sourceIndex: index,
			accountId: account.accountId,
			accountLabel: account.accountLabel,
			email: account.email,
			addedAt: account.addedAt,
			lastUsed: account.lastUsed,
			status: mapAccountStatus(account, index, activeIndex, now),
			quotaSummary: (displaySettings.menuShowQuotaSummary ?? true) && entry
				? formatAccountQuotaSummary(entry)
				: undefined,
			quota5hLeftPercent: quotaLeftPercentFromUsed(entry?.primary.usedPercent),
			quota5hResetAtMs: entry?.primary.resetAtMs,
			quota7dLeftPercent: quotaLeftPercentFromUsed(entry?.secondary.usedPercent),
			quota7dResetAtMs: entry?.secondary.resetAtMs,
			quotaRateLimited: entry?.status === 429,
			isCurrentAccount: index === activeIndex,
			enabled: account.enabled !== false,
			showStatusBadge: displaySettings.menuShowStatusBadge ?? true,
			showCurrentBadge: displaySettings.menuShowCurrentBadge ?? true,
			showLastUsed: displaySettings.menuShowLastUsed ?? true,
			showQuotaCooldown: displaySettings.menuShowQuotaCooldown ?? true,
			showHintsForUnselectedRows: layoutMode === "expanded-rows",
			highlightCurrentRow: displaySettings.menuHighlightCurrentRow ?? true,
			focusStyle: displaySettings.menuFocusStyle ?? "row-invert",
			statuslineFields: displaySettings.menuStatuslineFields ?? ["last-used", "limits", "status"],
		};
	});
	const orderedAccounts = applyAccountMenuOrdering(baseAccounts, displaySettings);
	const quickSwitchUsesVisibleRows = displaySettings.menuSortQuickSwitchVisibleRow ?? true;
	return orderedAccounts.map((account, displayIndex) => ({
		...account,
		index: displayIndex,
		quickSwitchNumber: quickSwitchUsesVisibleRows
			? displayIndex + 1
			: (account.sourceIndex ?? displayIndex) + 1,
	}));
}

function buildAuthDashboardSections(flaggedCount: number): AuthDashboardSectionViewModel[] {
	return [
		{
			id: "quick-actions",
			title: UI_COPY.mainMenu.quickStart,
			actions: [
				{ id: "add", label: UI_COPY.mainMenu.addAccount, tone: "green" },
				{ id: "check", label: UI_COPY.mainMenu.checkAccounts, tone: "green" },
				{ id: "forecast", label: UI_COPY.mainMenu.bestAccount, tone: "green" },
				{ id: "fix", label: UI_COPY.mainMenu.fixIssues, tone: "green" },
				{ id: "settings", label: UI_COPY.mainMenu.settings, tone: "green" },
			],
		},
		{
			id: "advanced-checks",
			title: UI_COPY.mainMenu.moreChecks,
			actions: [
				{ id: "deep-check", label: UI_COPY.mainMenu.refreshChecks, tone: "green" },
				{ id: "verify-flagged", label: formatCheckFlaggedLabel(flaggedCount), tone: flaggedCount > 0 ? "red" : "yellow" },
			],
		},
		{
			id: "saved-accounts",
			title: UI_COPY.mainMenu.accounts,
			actions: [],
		},
		{
			id: "danger-zone",
			title: UI_COPY.mainMenu.dangerZone,
			actions: [
				{ id: "delete-all", label: UI_COPY.mainMenu.removeAllAccounts, tone: "red" },
			],
		},
	];
}

export function buildAuthDashboardViewModel(
	options: BuildAuthDashboardViewModelOptions,
): AuthDashboardViewModel {
	const flaggedCount = options.flaggedCount ?? 0;
	return {
		accounts: toAuthAccountViewModels(options.storage, options.quotaCache, options.displaySettings),
		menuOptions: {
			flaggedCount,
			statusMessage: options.statusMessage,
		},
		sections: buildAuthDashboardSections(flaggedCount),
	};
}

export function resolveAuthDashboardCommand(menuResult: LoginMenuResult): AuthDashboardCommand {
	switch (menuResult.mode) {
		case "cancel":
			return { type: "cancel" };
		case "add":
			return { type: "add-account" };
		case "check":
			return {
				type: "run-health-check",
				panel: { title: "Quick Check", stage: "Checking local session + live status" },
				forceRefresh: false,
				liveProbe: true,
			};
		case "deep-check":
			return {
				type: "run-health-check",
				panel: { title: "Deep Check", stage: "Refreshing and testing all accounts" },
				forceRefresh: true,
				liveProbe: true,
			};
		case "forecast":
			return {
				type: "run-forecast",
				panel: { title: "Best Account", stage: "Comparing accounts" },
				args: ["--live"],
			};
		case "fix":
			return {
				type: "run-fix",
				panel: { title: "Auto-Fix", stage: "Checking and fixing common issues" },
				args: ["--live"],
			};
		case "settings":
			return { type: "open-settings" };
		case "verify-flagged":
			return {
				type: "run-verify-flagged",
				panel: { title: "Problem Account Check", stage: "Checking problem accounts" },
				args: [],
			};
		case "fresh":
			return {
				type: "reset-accounts",
				panel: { title: "Reset Accounts", stage: "Deleting all saved accounts" },
			};
		case "manage": {
			const requiresInlineFlow = typeof menuResult.refreshAccountIndex === "number";
			return {
				type: "manage-account",
				menuResult,
				requiresInlineFlow,
				panel: requiresInlineFlow
					? undefined
					: { title: "Applying Change", stage: "Updating selected account" },
			};
		}
	}

	return { type: "cancel" };
}
