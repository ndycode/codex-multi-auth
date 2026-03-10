import { createElement, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, type Key, type RenderOptions } from "ink";
import {
	loadDashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	type DashboardAccentColor,
	type DashboardAccountSortMode,
	type DashboardDisplaySettings,
	type DashboardLayoutMode,
	type DashboardStatuslineField,
	type DashboardThemePreset,
} from "../dashboard-settings.js";
import { getDefaultPluginConfig, loadPluginConfig } from "../config.js";
import type { PluginConfig } from "../types.js";
import { UI_COPY } from "../ui/copy.js";
import {
	applyUiThemeFromDashboardSettings,
	resolveMenuLayoutMode,
} from "../codex-manager/settings-hub.js";
import {
	persistBackendConfigSelection,
	persistDashboardSettingsSelection,
} from "../codex-manager/settings-persistence.js";
import {
	InkShellFrame,
	InkShellPanel,
	InkShellRow,
	createInkShellTheme,
	type InkShellTone,
} from "./layout.js";
import {
	resolveInkAuthShellBootstrap,
	type InkAuthShellEnvironment,
} from "./bootstrap.js";

type DashboardDisplaySettingKey =
	| "menuShowStatusBadge"
	| "menuShowCurrentBadge"
	| "menuShowLastUsed"
	| "menuShowQuotaSummary"
	| "menuShowQuotaCooldown"
	| "menuShowDetailsForUnselectedRows"
	| "menuShowFetchStatus"
	| "menuHighlightCurrentRow"
	| "menuSortEnabled"
	| "menuSortPinCurrent"
	| "menuSortQuickSwitchVisibleRow";

interface DashboardDisplaySettingOption {
	key: DashboardDisplaySettingKey;
	label: string;
	description: string;
}

const DASHBOARD_DISPLAY_OPTIONS: DashboardDisplaySettingOption[] = [
	{
		key: "menuShowStatusBadge",
		label: "Show Status Badges",
		description: "Show [ok], [active], and similar badges.",
	},
	{
		key: "menuShowCurrentBadge",
		label: "Show [current]",
		description: "Mark the account active in Codex.",
	},
	{
		key: "menuShowLastUsed",
		label: "Show Last Used",
		description: "Show relative usage like 'today'.",
	},
	{
		key: "menuShowQuotaSummary",
		label: "Show Limits (5h / 7d)",
		description: "Show limit bars in each row.",
	},
	{
		key: "menuShowQuotaCooldown",
		label: "Show Limit Cooldowns",
		description: "Show reset timers next to 5h/7d bars.",
	},
	{
		key: "menuShowFetchStatus",
		label: "Show Fetch Status",
		description: "Show background limit refresh status in the menu subtitle.",
	},
	{
		key: "menuHighlightCurrentRow",
		label: "Highlight Current Row",
		description: "Use stronger color on the current row.",
	},
	{
		key: "menuSortEnabled",
		label: "Enable Smart Sort",
		description: "Sort accounts by readiness (view only).",
	},
	{
		key: "menuSortPinCurrent",
		label: "Pin [current] when tied",
		description: "Keep current at top only when it is equally ready.",
	},
	{
		key: "menuSortQuickSwitchVisibleRow",
		label: "Quick Switch Uses Visible Rows",
		description: "Number keys (1-9) follow what you see in the list.",
	},
];

const DEFAULT_STATUSLINE_FIELDS: DashboardStatuslineField[] = ["last-used", "limits", "status"];
const STATUSLINE_FIELD_OPTIONS: Array<{
	key: DashboardStatuslineField;
	label: string;
	description: string;
}> = [
	{
		key: "last-used",
		label: "Show Last Used",
		description: "Example: 'today' or '2d ago'.",
	},
	{
		key: "limits",
		label: "Show Limits (5h / 7d)",
		description: "Uses cached limit data from checks.",
	},
	{
		key: "status",
		label: "Show Status Text",
		description: "Visible when badges are hidden.",
	},
];

const AUTO_RETURN_OPTIONS_MS = [1_000, 2_000, 4_000] as const;
const MENU_QUOTA_TTL_OPTIONS_MS = [60_000, 5 * 60_000, 10 * 60_000] as const;
const THEME_PRESET_OPTIONS: DashboardThemePreset[] = ["green", "blue"];
const ACCENT_COLOR_OPTIONS: DashboardAccentColor[] = ["green", "cyan", "blue", "yellow"];

type BackendToggleSettingKey =
	| "liveAccountSync"
	| "sessionAffinity"
	| "proactiveRefreshGuardian"
	| "retryAllAccountsRateLimited"
	| "parallelProbing"
	| "storageBackupEnabled"
	| "preemptiveQuotaEnabled"
	| "fastSession"
	| "sessionRecovery"
	| "autoResume"
	| "perProjectAccounts";

type BackendNumberSettingKey =
	| "liveAccountSyncDebounceMs"
	| "liveAccountSyncPollMs"
	| "sessionAffinityTtlMs"
	| "sessionAffinityMaxEntries"
	| "proactiveRefreshIntervalMs"
	| "proactiveRefreshBufferMs"
	| "parallelProbingMaxConcurrency"
	| "fastSessionMaxInputItems"
	| "networkErrorCooldownMs"
	| "serverErrorCooldownMs"
	| "fetchTimeoutMs"
	| "streamStallTimeoutMs"
	| "tokenRefreshSkewMs"
	| "preemptiveQuotaRemainingPercent5h"
	| "preemptiveQuotaRemainingPercent7d"
	| "preemptiveQuotaMaxDeferralMs";

interface BackendToggleSettingOption {
	key: BackendToggleSettingKey;
	label: string;
	description: string;
}

interface BackendNumberSettingOption {
	key: BackendNumberSettingKey;
	label: string;
	description: string;
	min: number;
	max: number;
	step: number;
	unit: "ms" | "percent" | "count";
}

type BackendCategoryKey =
	| "session-sync"
	| "rotation-quota"
	| "refresh-recovery"
	| "performance-timeouts";

interface BackendCategoryOption {
	key: BackendCategoryKey;
	label: string;
	description: string;
	toggleKeys: BackendToggleSettingKey[];
	numberKeys: BackendNumberSettingKey[];
}

type SettingsHubActionType = "account-list" | "summary-fields" | "behavior" | "theme" | "backend" | "back";

const BACKEND_TOGGLE_OPTIONS: BackendToggleSettingOption[] = [
	{
		key: "liveAccountSync",
		label: "Enable Live Sync",
		description: "Keep accounts synced when files change in another window.",
	},
	{
		key: "sessionAffinity",
		label: "Enable Session Affinity",
		description: "Try to keep each conversation on the same account.",
	},
	{
		key: "proactiveRefreshGuardian",
		label: "Enable Token Refresh Guard",
		description: "Refresh tokens early in the background.",
	},
	{
		key: "retryAllAccountsRateLimited",
		label: "Retry When All Rate-Limited",
		description: "If all accounts are limited, wait and try again.",
	},
	{
		key: "parallelProbing",
		label: "Enable Parallel Probing",
		description: "Check multiple accounts at the same time.",
	},
	{
		key: "storageBackupEnabled",
		label: "Enable Storage Backups",
		description: "Create a backup before account data changes.",
	},
	{
		key: "preemptiveQuotaEnabled",
		label: "Enable Quota Deferral",
		description: "Delay requests before limits are fully exhausted.",
	},
	{
		key: "fastSession",
		label: "Enable Fast Session Mode",
		description: "Use lighter request handling for faster responses.",
	},
	{
		key: "sessionRecovery",
		label: "Enable Session Recovery",
		description: "Restore recoverable sessions after restart.",
	},
	{
		key: "autoResume",
		label: "Enable Auto Resume",
		description: "Automatically continue sessions when possible.",
	},
	{
		key: "perProjectAccounts",
		label: "Enable Per-Project Accounts",
		description: "Keep separate account lists for each project.",
	},
];

const BACKEND_NUMBER_OPTIONS: BackendNumberSettingOption[] = [
	{
		key: "liveAccountSyncDebounceMs",
		label: "Live Sync Debounce",
		description: "Wait this long before applying sync file changes.",
		min: 50,
		max: 10_000,
		step: 50,
		unit: "ms",
	},
	{
		key: "liveAccountSyncPollMs",
		label: "Live Sync Poll",
		description: "How often to check files for account updates.",
		min: 500,
		max: 60_000,
		step: 500,
		unit: "ms",
	},
	{
		key: "sessionAffinityTtlMs",
		label: "Session Affinity TTL",
		description: "How long conversation-to-account mapping is kept.",
		min: 1_000,
		max: 24 * 60 * 60_000,
		step: 60_000,
		unit: "ms",
	},
	{
		key: "sessionAffinityMaxEntries",
		label: "Session Affinity Max Entries",
		description: "Maximum stored conversation mappings.",
		min: 8,
		max: 4_096,
		step: 32,
		unit: "count",
	},
	{
		key: "proactiveRefreshIntervalMs",
		label: "Refresh Guard Interval",
		description: "How often to scan for tokens near expiry.",
		min: 5_000,
		max: 10 * 60_000,
		step: 5_000,
		unit: "ms",
	},
	{
		key: "proactiveRefreshBufferMs",
		label: "Refresh Guard Buffer",
		description: "How early to refresh before expiry.",
		min: 30_000,
		max: 10 * 60_000,
		step: 30_000,
		unit: "ms",
	},
	{
		key: "parallelProbingMaxConcurrency",
		label: "Parallel Probe Concurrency",
		description: "Maximum checks running at once.",
		min: 1,
		max: 5,
		step: 1,
		unit: "count",
	},
	{
		key: "fastSessionMaxInputItems",
		label: "Fast Session Max Inputs",
		description: "Max number of input items kept in fast mode.",
		min: 8,
		max: 200,
		step: 2,
		unit: "count",
	},
	{
		key: "networkErrorCooldownMs",
		label: "Network Error Cooldown",
		description: "Wait time after network errors before retry.",
		min: 0,
		max: 120_000,
		step: 500,
		unit: "ms",
	},
	{
		key: "serverErrorCooldownMs",
		label: "Server Error Cooldown",
		description: "Wait time after server errors before retry.",
		min: 0,
		max: 120_000,
		step: 500,
		unit: "ms",
	},
	{
		key: "fetchTimeoutMs",
		label: "Request Timeout",
		description: "Max time to wait for a request.",
		min: 1_000,
		max: 10 * 60_000,
		step: 5_000,
		unit: "ms",
	},
	{
		key: "streamStallTimeoutMs",
		label: "Stream Stall Timeout",
		description: "Max wait before a stuck stream is retried.",
		min: 1_000,
		max: 10 * 60_000,
		step: 5_000,
		unit: "ms",
	},
	{
		key: "tokenRefreshSkewMs",
		label: "Token Refresh Buffer",
		description: "Refresh this long before token expiry.",
		min: 0,
		max: 10 * 60_000,
		step: 10_000,
		unit: "ms",
	},
	{
		key: "preemptiveQuotaRemainingPercent5h",
		label: "5h Remaining Threshold",
		description: "Start delaying when 5h remaining reaches this percent.",
		min: 0,
		max: 100,
		step: 1,
		unit: "percent",
	},
	{
		key: "preemptiveQuotaRemainingPercent7d",
		label: "7d Remaining Threshold",
		description: "Start delaying when weekly remaining reaches this percent.",
		min: 0,
		max: 100,
		step: 1,
		unit: "percent",
	},
	{
		key: "preemptiveQuotaMaxDeferralMs",
		label: "Max Preemptive Deferral",
		description: "Maximum time allowed for quota-based delay.",
		min: 1_000,
		max: 24 * 60 * 60_000,
		step: 60_000,
		unit: "ms",
	},
];

const BACKEND_DEFAULTS = getDefaultPluginConfig();

const BACKEND_TOGGLE_OPTION_BY_KEY = new Map<BackendToggleSettingKey, BackendToggleSettingOption>(
	BACKEND_TOGGLE_OPTIONS.map((option) => [option.key, option]),
);

const BACKEND_NUMBER_OPTION_BY_KEY = new Map<BackendNumberSettingKey, BackendNumberSettingOption>(
	BACKEND_NUMBER_OPTIONS.map((option) => [option.key, option]),
);

const BACKEND_CATEGORY_OPTIONS: BackendCategoryOption[] = [
	{
		key: "session-sync",
		label: "Session & Sync",
		description: "Sync and session behavior.",
		toggleKeys: [
			"liveAccountSync",
			"sessionAffinity",
			"perProjectAccounts",
			"sessionRecovery",
			"autoResume",
		],
		numberKeys: [
			"liveAccountSyncDebounceMs",
			"liveAccountSyncPollMs",
			"sessionAffinityTtlMs",
			"sessionAffinityMaxEntries",
		],
	},
	{
		key: "rotation-quota",
		label: "Rotation & Quota",
		description: "Quota and retry behavior.",
		toggleKeys: ["preemptiveQuotaEnabled", "retryAllAccountsRateLimited"],
		numberKeys: [
			"preemptiveQuotaRemainingPercent5h",
			"preemptiveQuotaRemainingPercent7d",
			"preemptiveQuotaMaxDeferralMs",
		],
	},
	{
		key: "refresh-recovery",
		label: "Refresh & Recovery",
		description: "Token refresh and recovery safety.",
		toggleKeys: ["proactiveRefreshGuardian", "storageBackupEnabled"],
		numberKeys: [
			"proactiveRefreshIntervalMs",
			"proactiveRefreshBufferMs",
			"tokenRefreshSkewMs",
		],
	},
	{
		key: "performance-timeouts",
		label: "Performance & Timeouts",
		description: "Speed, probing, and timeout controls.",
		toggleKeys: ["fastSession", "parallelProbing"],
		numberKeys: [
			"fastSessionMaxInputItems",
			"parallelProbingMaxConcurrency",
			"fetchTimeoutMs",
			"streamStallTimeoutMs",
			"networkErrorCooldownMs",
			"serverErrorCooldownMs",
		],
	},
];

type DashboardSettingKey = keyof DashboardDisplaySettings;

const ACCOUNT_LIST_PANEL_KEYS = [
	"menuShowStatusBadge",
	"menuShowCurrentBadge",
	"menuShowLastUsed",
	"menuShowQuotaSummary",
	"menuShowQuotaCooldown",
	"menuShowFetchStatus",
	"menuShowDetailsForUnselectedRows",
	"menuHighlightCurrentRow",
	"menuSortEnabled",
	"menuSortMode",
	"menuSortPinCurrent",
	"menuSortQuickSwitchVisibleRow",
	"menuLayoutMode",
] as const satisfies readonly DashboardSettingKey[];

const STATUSLINE_PANEL_KEYS = ["menuStatuslineFields"] as const satisfies readonly DashboardSettingKey[];
const BEHAVIOR_PANEL_KEYS = [
	"actionAutoReturnMs",
	"actionPauseOnKey",
	"menuAutoFetchLimits",
	"menuShowFetchStatus",
	"menuQuotaTtlMs",
] as const satisfies readonly DashboardSettingKey[];
const THEME_PANEL_KEYS = ["uiThemePreset", "uiAccentColor"] as const satisfies readonly DashboardSettingKey[];

const PREVIEW_ACCOUNT_EMAIL = "demo@example.com";
const PREVIEW_LAST_USED = "today";
const PREVIEW_STATUS = "active";
const PREVIEW_LIMITS = "5h ██████▒▒▒▒ 62% | 7d █████▒▒▒▒▒ 49%";
const PREVIEW_LIMIT_COOLDOWNS = "5h reset 1h 20m | 7d reset 2d 04h";

export interface InkSettingsEnvironment extends InkAuthShellEnvironment {
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	stderr?: NodeJS.WriteStream;
	debug?: boolean;
	patchConsole?: boolean;
	exitOnCtrlC?: boolean;
}

interface InkSettingsEntry {
	id: string;
	label: string;
	detail?: string;
	tone: InkShellTone;
}

function makeEntry(id: string, label: string, tone: InkShellTone, detail?: string): InkSettingsEntry {
	return detail ? { id, label, detail, tone } : { id, label, tone };
}

interface InkSettingsView {
	panelTitle: string;
	entries: InkSettingsEntry[];
	footer: string;
	previewTitle?: string;
	previewLines?: string[];
	status?: string;
	statusTone?: InkShellTone;
}

type InkSettingsTransition<TState, TResult> =
	| { type: "update"; state: TState; cursor?: number }
	| { type: "resolve"; value: TResult };

interface InkSettingsAppProps<TState, TResult> extends InkSettingsEnvironment {
	title: string;
	subtitle?: string;
	initialState: TState;
	initialCursor?: number;
	renderView: (state: TState, cursor: number) => InkSettingsView;
	onInput: (params: {
		state: TState;
		cursor: number;
		entry: InkSettingsEntry | undefined;
		input: string;
		key: Key;
	}) => InkSettingsTransition<TState, TResult> | null | undefined;
	onResolve: (value: TResult) => void;
}

function clampCursor(cursor: number, count: number): number {
	if (count <= 0) return 0;
	return Math.max(0, Math.min(cursor, count - 1));
}

function normalizeStatuslineFields(
	fields: DashboardStatuslineField[] | undefined,
): DashboardStatuslineField[] {
	const source = fields ?? DEFAULT_STATUSLINE_FIELDS;
	const seen = new Set<DashboardStatuslineField>();
	const normalized: DashboardStatuslineField[] = [];
	for (const field of source) {
		if (seen.has(field)) continue;
		seen.add(field);
		normalized.push(field);
	}
	if (normalized.length === 0) {
		return [...DEFAULT_STATUSLINE_FIELDS];
	}
	return normalized;
}

function copyDashboardSettingValue(
	target: DashboardDisplaySettings,
	source: DashboardDisplaySettings,
	key: DashboardSettingKey,
): void {
	const value = source[key];
	(target as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
}

function cloneDashboardSettings(settings: DashboardDisplaySettings): DashboardDisplaySettings {
	const layoutMode = resolveMenuLayoutMode(settings);
	return {
		showPerAccountRows: settings.showPerAccountRows,
		showQuotaDetails: settings.showQuotaDetails,
		showForecastReasons: settings.showForecastReasons,
		showRecommendations: settings.showRecommendations,
		showLiveProbeNotes: settings.showLiveProbeNotes,
		actionAutoReturnMs: settings.actionAutoReturnMs ?? 2_000,
		actionPauseOnKey: settings.actionPauseOnKey ?? true,
		menuAutoFetchLimits: settings.menuAutoFetchLimits ?? true,
		menuSortEnabled:
			settings.menuSortEnabled ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? true),
		menuSortMode:
			settings.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first"),
		menuSortPinCurrent:
			settings.menuSortPinCurrent ??
			(DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ?? false),
		menuSortQuickSwitchVisibleRow: settings.menuSortQuickSwitchVisibleRow ?? true,
		uiThemePreset: settings.uiThemePreset ?? "green",
		uiAccentColor: settings.uiAccentColor ?? "green",
		menuShowStatusBadge: settings.menuShowStatusBadge ?? true,
		menuShowCurrentBadge: settings.menuShowCurrentBadge ?? true,
		menuShowLastUsed: settings.menuShowLastUsed ?? true,
		menuShowQuotaSummary: settings.menuShowQuotaSummary ?? true,
		menuShowQuotaCooldown: settings.menuShowQuotaCooldown ?? true,
		menuShowFetchStatus: settings.menuShowFetchStatus ?? true,
		menuShowDetailsForUnselectedRows: layoutMode === "expanded-rows",
		menuLayoutMode: layoutMode,
		menuQuotaTtlMs: settings.menuQuotaTtlMs ?? 5 * 60_000,
		menuFocusStyle: settings.menuFocusStyle ?? "row-invert",
		menuHighlightCurrentRow: settings.menuHighlightCurrentRow ?? true,
		menuStatuslineFields: [...normalizeStatuslineFields(settings.menuStatuslineFields)],
	};
}

function dashboardSettingsEqual(
	left: DashboardDisplaySettings,
	right: DashboardDisplaySettings,
): boolean {
	return (
		left.showPerAccountRows === right.showPerAccountRows &&
		left.showQuotaDetails === right.showQuotaDetails &&
		left.showForecastReasons === right.showForecastReasons &&
		left.showRecommendations === right.showRecommendations &&
		left.showLiveProbeNotes === right.showLiveProbeNotes &&
		(left.actionAutoReturnMs ?? 2_000) === (right.actionAutoReturnMs ?? 2_000) &&
		(left.actionPauseOnKey ?? true) === (right.actionPauseOnKey ?? true) &&
		(left.menuAutoFetchLimits ?? true) === (right.menuAutoFetchLimits ?? true) &&
		(left.menuSortEnabled ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? true)) ===
			(right.menuSortEnabled ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? true)) &&
		(left.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first")) ===
			(right.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first")) &&
		(left.menuSortPinCurrent ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ?? false)) ===
			(right.menuSortPinCurrent ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ?? false)) &&
		(left.menuSortQuickSwitchVisibleRow ?? true) ===
			(right.menuSortQuickSwitchVisibleRow ?? true) &&
		(left.uiThemePreset ?? "green") === (right.uiThemePreset ?? "green") &&
		(left.uiAccentColor ?? "green") === (right.uiAccentColor ?? "green") &&
		(left.menuShowStatusBadge ?? true) === (right.menuShowStatusBadge ?? true) &&
		(left.menuShowCurrentBadge ?? true) === (right.menuShowCurrentBadge ?? true) &&
		(left.menuShowLastUsed ?? true) === (right.menuShowLastUsed ?? true) &&
		(left.menuShowQuotaSummary ?? true) === (right.menuShowQuotaSummary ?? true) &&
		(left.menuShowQuotaCooldown ?? true) === (right.menuShowQuotaCooldown ?? true) &&
		(left.menuShowFetchStatus ?? true) === (right.menuShowFetchStatus ?? true) &&
		resolveMenuLayoutMode(left) === resolveMenuLayoutMode(right) &&
		(left.menuQuotaTtlMs ?? 5 * 60_000) === (right.menuQuotaTtlMs ?? 5 * 60_000) &&
		(left.menuFocusStyle ?? "row-invert") === (right.menuFocusStyle ?? "row-invert") &&
		(left.menuHighlightCurrentRow ?? true) === (right.menuHighlightCurrentRow ?? true) &&
		JSON.stringify(normalizeStatuslineFields(left.menuStatuslineFields)) ===
			JSON.stringify(normalizeStatuslineFields(right.menuStatuslineFields))
	);
}

function applyDashboardDefaultsForKeys(
	draft: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
): DashboardDisplaySettings {
	const next = cloneDashboardSettings(draft);
	const defaults = cloneDashboardSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
	for (const key of keys) {
		copyDashboardSettingValue(next, defaults, key);
	}
	return next;
}

function mergeDashboardSettingsForKeys(
	base: DashboardDisplaySettings,
	selected: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
): DashboardDisplaySettings {
	const next = cloneDashboardSettings(base);
	for (const key of keys) {
		copyDashboardSettingValue(next, selected, key);
	}
	return cloneDashboardSettings(next);
}

function cloneBackendPluginConfig(config: PluginConfig): PluginConfig {
	const fallbackChain = config.unsupportedCodexFallbackChain;
	return {
		...BACKEND_DEFAULTS,
		...config,
		unsupportedCodexFallbackChain:
			fallbackChain && typeof fallbackChain === "object"
				? { ...fallbackChain }
				: {},
	};
}

function backendSettingsSnapshot(config: PluginConfig): Record<string, unknown> {
	const snapshot: Record<string, unknown> = {};
	for (const option of BACKEND_TOGGLE_OPTIONS) {
		snapshot[option.key] = config[option.key] ?? BACKEND_DEFAULTS[option.key] ?? false;
	}
	for (const option of BACKEND_NUMBER_OPTIONS) {
		snapshot[option.key] = config[option.key] ?? BACKEND_DEFAULTS[option.key] ?? option.min;
	}
	return snapshot;
}

function backendSettingsEqual(left: PluginConfig, right: PluginConfig): boolean {
	return JSON.stringify(backendSettingsSnapshot(left)) === JSON.stringify(backendSettingsSnapshot(right));
}

function formatBackendNumberValue(option: BackendNumberSettingOption, value: number): string {
	if (option.unit === "percent") return `${Math.round(value)}%`;
	if (option.unit === "count") return `${Math.round(value)}`;
	if (value >= 60_000 && value % 60_000 === 0) {
		return `${Math.round(value / 60_000)}m`;
	}
	if (value >= 1_000 && value % 1_000 === 0) {
		return `${Math.round(value / 1_000)}s`;
	}
	return `${Math.round(value)}ms`;
}

function clampBackendNumber(option: BackendNumberSettingOption, value: number): number {
	return Math.max(option.min, Math.min(option.max, Math.round(value)));
}

function buildBackendConfigPatch(config: PluginConfig): Partial<PluginConfig> {
	const patch: Partial<PluginConfig> = {};
	for (const option of BACKEND_TOGGLE_OPTIONS) {
		const value = config[option.key];
		if (typeof value === "boolean") {
			patch[option.key] = value;
		}
	}
	for (const option of BACKEND_NUMBER_OPTIONS) {
		const value = config[option.key];
		if (typeof value === "number" && Number.isFinite(value)) {
			patch[option.key] = clampBackendNumber(option, value);
		}
	}
	return patch;
}

function reorderField(
	fields: DashboardStatuslineField[],
	key: DashboardStatuslineField,
	direction: -1 | 1,
): DashboardStatuslineField[] {
	const index = fields.indexOf(key);
	if (index < 0) return fields;
	const target = index + direction;
	if (target < 0 || target >= fields.length) return fields;
	const next = [...fields];
	const current = next[index];
	const swap = next[target];
	if (!current || !swap) return fields;
	next[index] = swap;
	next[target] = current;
	return next;
}

function formatDashboardSettingState(value: boolean): string {
	return value ? "[x]" : "[ ]";
}

function formatMenuSortMode(mode: DashboardAccountSortMode): string {
	return mode === "ready-first" ? "Ready-First" : "Manual";
}

function formatMenuLayoutMode(mode: "compact-details" | "expanded-rows"): string {
	return mode === "expanded-rows" ? "Expanded Rows" : "Compact + Details Pane";
}

function formatMenuQuotaTtl(ttlMs: number): string {
	if (ttlMs >= 60_000 && ttlMs % 60_000 === 0) {
		return `${Math.round(ttlMs / 60_000)}m`;
	}
	if (ttlMs >= 1_000 && ttlMs % 1_000 === 0) {
		return `${Math.round(ttlMs / 1_000)}s`;
	}
	return `${ttlMs}ms`;
}

function buildSummaryPreviewText(settings: DashboardDisplaySettings): string {
	const partsByField = new Map<DashboardStatuslineField, string>();
	if (settings.menuShowLastUsed !== false) {
		partsByField.set("last-used", `last used: ${PREVIEW_LAST_USED}`);
	}
	if (settings.menuShowQuotaSummary !== false) {
		const limitsText =
			settings.menuShowQuotaCooldown === false
				? PREVIEW_LIMITS
				: `${PREVIEW_LIMITS} | ${PREVIEW_LIMIT_COOLDOWNS}`;
		partsByField.set("limits", `limits: ${limitsText}`);
	}
	if (settings.menuShowStatusBadge === false) {
		partsByField.set("status", `status: ${PREVIEW_STATUS}`);
	}
	const orderedParts = normalizeStatuslineFields(settings.menuStatuslineFields)
		.map((field) => partsByField.get(field))
		.filter((part): part is string => typeof part === "string" && part.length > 0);
	if (orderedParts.length > 0) {
		return orderedParts.join(" | ");
	}
	const showsStatusField = normalizeStatuslineFields(settings.menuStatuslineFields).includes("status");
	if (showsStatusField && settings.menuShowStatusBadge !== false) {
		return "status text appears only when status badges are hidden";
	}
	return "no summary text is visible with current account-list settings";
}

function buildAccountListPreview(settings: DashboardDisplaySettings): { label: string; hint: string } {
	const badges: string[] = [];
	if (settings.menuShowCurrentBadge !== false) {
		badges.push("[current]");
	}
	if (settings.menuShowStatusBadge !== false) {
		badges.push("[active]");
	}
	const badgeSuffix = badges.length > 0 ? ` ${badges.join(" ")}` : "";
	const rowDetailMode =
		resolveMenuLayoutMode(settings) === "expanded-rows"
			? "details shown on all rows"
			: "details shown on selected row only";
	return {
		label: `1. ${PREVIEW_ACCOUNT_EMAIL}${badgeSuffix}`,
		hint: `${buildSummaryPreviewText(settings)}\n${rowDetailMode}`,
	};
}

function buildBackendSettingsPreview(config: PluginConfig): { label: string; hint: string } {
	const liveSync = config.liveAccountSync ?? BACKEND_DEFAULTS.liveAccountSync ?? true;
	const affinity = config.sessionAffinity ?? BACKEND_DEFAULTS.sessionAffinity ?? true;
	const preemptive = config.preemptiveQuotaEnabled ?? BACKEND_DEFAULTS.preemptiveQuotaEnabled ?? true;
	const threshold5h =
		config.preemptiveQuotaRemainingPercent5h ??
		BACKEND_DEFAULTS.preemptiveQuotaRemainingPercent5h ??
		5;
	const threshold7d =
		config.preemptiveQuotaRemainingPercent7d ??
		BACKEND_DEFAULTS.preemptiveQuotaRemainingPercent7d ??
		5;
	const fetchTimeout = config.fetchTimeoutMs ?? BACKEND_DEFAULTS.fetchTimeoutMs ?? 60_000;
	const stallTimeout = config.streamStallTimeoutMs ?? BACKEND_DEFAULTS.streamStallTimeoutMs ?? 45_000;
	const fetchTimeoutOption = BACKEND_NUMBER_OPTION_BY_KEY.get("fetchTimeoutMs");
	const stallTimeoutOption = BACKEND_NUMBER_OPTION_BY_KEY.get("streamStallTimeoutMs");
	const fetchTimeoutLabel = fetchTimeoutOption
		? formatBackendNumberValue(fetchTimeoutOption, fetchTimeout)
		: `${fetchTimeout}ms`;
	const stallTimeoutLabel = stallTimeoutOption
		? formatBackendNumberValue(stallTimeoutOption, stallTimeout)
		: `${stallTimeout}ms`;
	return {
		label: [
			`live sync ${liveSync ? "on" : "off"}`,
			`affinity ${affinity ? "on" : "off"}`,
			`preemptive ${preemptive ? "on" : "off"}`,
		].join(" | "),
		hint: [
			`thresholds 5h<=${threshold5h}%`,
			`7d<=${threshold7d}%`,
			`timeouts ${fetchTimeoutLabel}/${stallTimeoutLabel}`,
		].join(" | "),
	};
}

function entryTone(enabled: boolean): InkShellTone {
	return enabled ? "success" : "warning";
}

function InkSettingsApp<TState, TResult>(props: InkSettingsAppProps<TState, TResult>) {
	const { exit } = useApp();
	const theme = createInkShellTheme();
	const [state, setState] = useState<TState>(props.initialState);
	const [cursor, setCursor] = useState(props.initialCursor ?? 0);
	const view = useMemo(() => props.renderView(state, cursor), [props, state, cursor]);
	const normalizedCursor = clampCursor(cursor, view.entries.length);

	useInput((input, key) => {
		if (view.entries.length > 0 && key.upArrow) {
			setCursor((current) => clampCursor(current - 1, view.entries.length));
			return;
		}
		if (view.entries.length > 0 && key.downArrow) {
			setCursor((current) => clampCursor(current + 1, view.entries.length));
			return;
		}

		const transition = props.onInput({
			state,
			cursor: normalizedCursor,
			entry: view.entries[normalizedCursor],
			input,
			key,
		});
		if (!transition) return;
		if (transition.type === "resolve") {
			props.onResolve(transition.value);
			exit();
			return;
		}
		setState(transition.state);
		if (typeof transition.cursor === "number") {
			const nextView = props.renderView(transition.state, transition.cursor);
			setCursor(clampCursor(transition.cursor, nextView.entries.length));
		}
	});

	return createElement(
		InkShellFrame,
		{
			title: props.title,
			subtitle: props.subtitle,
			status: view.status,
			statusTone: view.statusTone,
			footer: view.footer,
			theme,
		},
		createElement(
			Box,
			{ flexDirection: "column", rowGap: 1 },
			view.previewLines && view.previewLines.length > 0
				? createElement(
					InkShellPanel,
					{ title: view.previewTitle ?? UI_COPY.settings.previewHeading, theme },
					createElement(
						Box,
						{ flexDirection: "column" },
						...view.previewLines.map((line, index) =>
							createElement(Text, { key: `${index}:${line}`, color: theme.textColor }, line),
						),
					),
				)
				: null,
			createElement(
				InkShellPanel,
				{ title: view.panelTitle, theme },
				view.entries.length > 0
					? createElement(
						Box,
						{ flexDirection: "column" },
						...view.entries.map((entry, index) =>
							createElement(InkShellRow, {
								key: entry.id,
								label: entry.label,
								detail: entry.detail,
								active: index === normalizedCursor,
								tone: entry.tone,
								theme,
							}),
						),
					)
					: createElement(Text, { color: theme.mutedColor }, "No items"),
			),
		),
	);
}

async function promptInkSettingsScreen<TState, TResult>(
	options: Omit<InkSettingsAppProps<TState, TResult>, "onResolve">,
): Promise<TResult | null> {
	const support = resolveInkAuthShellBootstrap(options);
	if (!support.supported) return null;

	return await new Promise<TResult | null>((resolve) => {
		const App = (props: InkSettingsAppProps<TState, TResult>) => InkSettingsApp(props);
		const renderOptions: RenderOptions = {
			stdin: options.stdin ?? process.stdin,
			stdout: options.stdout ?? process.stdout,
			stderr: options.stderr ?? process.stderr,
			debug: options.debug ?? false,
			patchConsole: options.patchConsole ?? false,
			exitOnCtrlC: options.exitOnCtrlC ?? false,
		};
		render(createElement(App, { ...options, onResolve: (value: TResult) => resolve(value) }), renderOptions);
	});
}

export async function promptInkSettingsHub(
	options: InkSettingsEnvironment & { initialFocus?: SettingsHubActionType } = {},
): Promise<{ type: SettingsHubActionType } | null> {
	const focusOrder: SettingsHubActionType[] = [
		"account-list",
		"summary-fields",
		"behavior",
		"theme",
		"backend",
		"back",
	];
	const initialCursor = Math.max(0, focusOrder.indexOf(options.initialFocus ?? "account-list"));
	return await promptInkSettingsScreen<number, { type: SettingsHubActionType }>({
		...options,
		title: UI_COPY.settings.title,
		subtitle: UI_COPY.settings.subtitle,
		initialState: 0,
		initialCursor,
		renderView: (): InkSettingsView => ({
			panelTitle: UI_COPY.settings.sectionTitle,
			footer: UI_COPY.settings.help,
			entries: [
				makeEntry("account-list", UI_COPY.settings.accountList, "success"),
				makeEntry("summary-fields", UI_COPY.settings.summaryFields, "success"),
				makeEntry("behavior", UI_COPY.settings.behavior, "success"),
				makeEntry("theme", UI_COPY.settings.theme, "success"),
				makeEntry("backend", UI_COPY.settings.backend, "warning"),
				makeEntry("back", UI_COPY.settings.back, "danger"),
			],
		}),
		onInput: ({ cursor, entry, input, key }) => {
			const lower = input.toLowerCase();
			if (lower === "q") return { type: "resolve", value: { type: "back" } };
			if (lower >= "1" && lower <= "5") {
				const index = Number.parseInt(lower, 10) - 1;
				const target = focusOrder[index];
				if (target) return { type: "resolve", value: { type: target } };
			}
			if (!key.return) return undefined;
			const target = focusOrder[cursor] ?? (entry?.id as SettingsHubActionType | undefined);
			return { type: "resolve", value: { type: target ?? "back" } };
		},
	});
}

export async function promptInkAccountListSettings(
	initial: DashboardDisplaySettings,
	options: InkSettingsEnvironment = {},
): Promise<DashboardDisplaySettings | null> {
	return await promptInkSettingsScreen<DashboardDisplaySettings, DashboardDisplaySettings | null>({
		...options,
		title: UI_COPY.settings.accountListTitle,
		subtitle: UI_COPY.settings.accountListSubtitle,
		initialState: cloneDashboardSettings(initial),
		renderView: (draft): InkSettingsView => {
			const preview = buildAccountListPreview(draft);
			const optionEntries: InkSettingsEntry[] = DASHBOARD_DISPLAY_OPTIONS.map((option, index) => {
				const enabled = draft[option.key] ?? true;
				return makeEntry(
					option.key,
					`${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}`,
					entryTone(enabled),
					option.description,
				);
			});
			const sortMode = draft.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first");
			const layoutMode = resolveMenuLayoutMode(draft);
			return {
				panelTitle: UI_COPY.settings.displayHeading,
				footer: UI_COPY.settings.accountListHelp,
				previewTitle: UI_COPY.settings.previewHeading,
				previewLines: [preview.label, preview.hint],
				entries: [
					...optionEntries,
					makeEntry(
						"sort-mode",
						`Sort mode: ${formatMenuSortMode(sortMode)}`,
						sortMode === "ready-first" ? "success" : "warning",
						"Applies when smart sort is enabled.",
					),
					makeEntry(
						"layout-mode",
						`Layout: ${formatMenuLayoutMode(layoutMode)}`,
						layoutMode === "compact-details" ? "success" : "warning",
						"Compact shows one-line rows with a selected details pane.",
					),
					makeEntry("reset", UI_COPY.settings.resetDefault, "warning"),
					makeEntry("save", UI_COPY.settings.saveAndBack, "success"),
					makeEntry("cancel", UI_COPY.settings.backNoSave, "danger"),
				],
			};
		},
		onInput: ({ state: draft, cursor, entry, input, key }) => {
			const lower = input.toLowerCase();
			const toggleOption = (option: DashboardDisplaySettingOption) => ({
				type: "update" as const,
				state: {
					...draft,
					[option.key]: !(draft[option.key] ?? true),
				},
				cursor,
			});
			const cycleSortMode = () => {
				const currentMode = draft.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first");
				const nextMode: DashboardAccountSortMode = currentMode === "ready-first" ? "manual" : "ready-first";
				return {
					type: "update" as const,
					state: {
						...draft,
						menuSortMode: nextMode,
						menuSortEnabled:
							nextMode === "ready-first"
								? true
								: (draft.menuSortEnabled ??
									(DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? true)),
					},
					cursor: DASHBOARD_DISPLAY_OPTIONS.length,
				};
			};
			const cycleLayout = () => {
				const currentLayout = resolveMenuLayoutMode(draft);
				const nextLayout: DashboardLayoutMode = currentLayout === "compact-details"
					? "expanded-rows"
					: "compact-details";
				return {
					type: "update" as const,
					state: {
						...draft,
						menuLayoutMode: nextLayout,
						menuShowDetailsForUnselectedRows: nextLayout === "expanded-rows",
					},
					cursor: DASHBOARD_DISPLAY_OPTIONS.length + 1,
				};
			};

			if (lower === "q") return { type: "resolve", value: null };
			if (lower === "s") return { type: "resolve", value: draft };
			if (lower === "r") {
				return {
					type: "update",
					state: applyDashboardDefaultsForKeys(draft, ACCOUNT_LIST_PANEL_KEYS),
					cursor: 0,
				};
			}
			if (lower === "m") return cycleSortMode();
			if (lower === "l") return cycleLayout();
			const parsed = Number.parseInt(lower, 10);
			if (Number.isFinite(parsed) && parsed >= 1 && parsed <= DASHBOARD_DISPLAY_OPTIONS.length) {
				const option = DASHBOARD_DISPLAY_OPTIONS[parsed - 1];
				if (option) return toggleOption(option);
			}
			if (!key.return || !entry) return undefined;
			if (entry.id === "save") return { type: "resolve", value: draft };
			if (entry.id === "cancel") return { type: "resolve", value: null };
			if (entry.id === "reset") {
				return {
					type: "update",
					state: applyDashboardDefaultsForKeys(draft, ACCOUNT_LIST_PANEL_KEYS),
					cursor: 0,
				};
			}
			if (entry.id === "sort-mode") return cycleSortMode();
			if (entry.id === "layout-mode") return cycleLayout();
			const option = DASHBOARD_DISPLAY_OPTIONS.find((candidate) => candidate.key === entry.id);
			if (option) return toggleOption(option);
			return undefined;
		},
	});
}

export async function promptInkStatuslineSettings(
	initial: DashboardDisplaySettings,
	options: InkSettingsEnvironment = {},
): Promise<DashboardDisplaySettings | null> {
	return await promptInkSettingsScreen<DashboardDisplaySettings, DashboardDisplaySettings | null>({
		...options,
		title: UI_COPY.settings.summaryTitle,
		subtitle: UI_COPY.settings.summarySubtitle,
		initialState: cloneDashboardSettings(initial),
		renderView: (draft): InkSettingsView => {
			const preview = buildAccountListPreview(draft);
			const selectedSet = new Set(normalizeStatuslineFields(draft.menuStatuslineFields));
			const ordered = normalizeStatuslineFields(draft.menuStatuslineFields);
			const orderMap = new Map<DashboardStatuslineField, number>();
			for (let index = 0; index < ordered.length; index += 1) {
				const key = ordered[index];
				if (key) orderMap.set(key, index + 1);
			}
			return {
				panelTitle: UI_COPY.settings.displayHeading,
				footer: UI_COPY.settings.summaryHelp,
				previewTitle: UI_COPY.settings.previewHeading,
				previewLines: [preview.label, preview.hint],
				entries: [
					...STATUSLINE_FIELD_OPTIONS.map((option, index) => {
						const enabled = selectedSet.has(option.key);
						const rank = orderMap.get(option.key);
						return makeEntry(
							option.key,
							`${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}${rank ? ` (order ${rank})` : ""}`,
							entryTone(enabled),
							option.description,
						);
					}),
					makeEntry("reset", UI_COPY.settings.resetDefault, "warning"),
					makeEntry("save", UI_COPY.settings.saveAndBack, "success"),
					makeEntry("cancel", UI_COPY.settings.backNoSave, "danger"),
				],
			};
		},
		onInput: ({ state: draft, cursor, entry, input, key }) => {
			const lower = input.toLowerCase();
			const selectedEntry = entry?.id as DashboardStatuslineField | undefined;
			const toggleField = (field: DashboardStatuslineField) => {
				const fields = normalizeStatuslineFields(draft.menuStatuslineFields);
				const isEnabled = fields.includes(field);
				const nextFields = isEnabled
					? fields.filter((candidate) => candidate !== field)
					: [...fields, field];
				return {
					type: "update" as const,
					state: {
						...draft,
						menuStatuslineFields: nextFields.length > 0 ? nextFields : [field],
					},
					cursor,
				};
			};
			const moveField = (direction: -1 | 1) => {
				if (!selectedEntry || !STATUSLINE_FIELD_OPTIONS.some((option) => option.key === selectedEntry)) {
					return undefined;
				}
				return {
					type: "update" as const,
					state: {
						...draft,
						menuStatuslineFields: reorderField(
							normalizeStatuslineFields(draft.menuStatuslineFields),
							selectedEntry,
							direction,
						),
					},
					cursor,
				};
			};

			if (lower === "q") return { type: "resolve", value: null };
			if (lower === "s") return { type: "resolve", value: draft };
			if (lower === "r") {
				return {
					type: "update",
					state: applyDashboardDefaultsForKeys(draft, STATUSLINE_PANEL_KEYS),
					cursor: 0,
				};
			}
			if (lower === "[") return moveField(-1);
			if (lower === "]") return moveField(1);
			const parsed = Number.parseInt(lower, 10);
			if (Number.isFinite(parsed) && parsed >= 1 && parsed <= STATUSLINE_FIELD_OPTIONS.length) {
				const target = STATUSLINE_FIELD_OPTIONS[parsed - 1];
				if (target) return toggleField(target.key);
			}
			if (!key.return || !entry) return undefined;
			if (entry.id === "save") return { type: "resolve", value: draft };
			if (entry.id === "cancel") return { type: "resolve", value: null };
			if (entry.id === "reset") {
				return {
					type: "update",
					state: applyDashboardDefaultsForKeys(draft, STATUSLINE_PANEL_KEYS),
					cursor: 0,
				};
			}
			const target = STATUSLINE_FIELD_OPTIONS.find((option) => option.key === entry.id);
			if (target) return toggleField(target.key);
			return undefined;
		},
	});
}

export async function promptInkBehaviorSettings(
	initial: DashboardDisplaySettings,
	options: InkSettingsEnvironment = {},
): Promise<DashboardDisplaySettings | null> {
	return await promptInkSettingsScreen<DashboardDisplaySettings, DashboardDisplaySettings | null>({
		...options,
		title: UI_COPY.settings.behaviorTitle,
		subtitle: UI_COPY.settings.behaviorSubtitle,
		initialState: cloneDashboardSettings(initial),
		renderView: (draft): InkSettingsView => {
			const currentDelay = draft.actionAutoReturnMs ?? 2_000;
			const pauseOnKey = draft.actionPauseOnKey ?? true;
			const autoFetchLimits = draft.menuAutoFetchLimits ?? true;
			const fetchStatusVisible = draft.menuShowFetchStatus ?? true;
			const menuQuotaTtlMs = draft.menuQuotaTtlMs ?? 5 * 60_000;
			return {
				panelTitle: UI_COPY.settings.actionTiming,
				footer: UI_COPY.settings.behaviorHelp,
				status: `Current delay ${formatMenuQuotaTtl(currentDelay)} | TTL ${formatMenuQuotaTtl(menuQuotaTtlMs)}`,
				statusTone: "accent",
				entries: [
					...AUTO_RETURN_OPTIONS_MS.map((delayMs, index) =>
						makeEntry(
							`delay:${delayMs}`,
							`${currentDelay === delayMs ? "[x]" : "[ ]"} ${index + 1}. ${delayMs <= 0 ? "Instant return" : `${Math.round(delayMs / 1_000)}s auto-return`}`,
							currentDelay === delayMs ? "success" : "warning",
							delayMs === 1_000
								? "Fastest loop for frequent actions."
								: delayMs === 2_000
									? "Balanced default for most users."
									: "More time to read action output.",
						),
					),
					makeEntry(
						"pause",
						`${pauseOnKey ? "[x]" : "[ ]"} Pause on key press`,
						entryTone(pauseOnKey),
						"Press any key to stop auto-return.",
					),
					makeEntry(
						"auto-fetch",
						`${autoFetchLimits ? "[x]" : "[ ]"} Auto-fetch limits on menu open (${formatMenuQuotaTtl(menuQuotaTtlMs)} cache)`,
						entryTone(autoFetchLimits),
						"Refreshes account limits automatically when opening the menu.",
					),
					makeEntry(
						"fetch-status",
						`${fetchStatusVisible ? "[x]" : "[ ]"} Show limit refresh status`,
						entryTone(fetchStatusVisible),
						"Shows background fetch progress like [2/7] in menu subtitle.",
					),
					makeEntry(
						"ttl",
						`Limit cache TTL: ${formatMenuQuotaTtl(menuQuotaTtlMs)}`,
						"warning",
						"How fresh cached quota data must be before refresh runs.",
					),
					makeEntry("reset", UI_COPY.settings.resetDefault, "warning"),
					makeEntry("save", UI_COPY.settings.saveAndBack, "success"),
					makeEntry("cancel", UI_COPY.settings.backNoSave, "danger"),
				],
			};
		},
		onInput: ({ state: draft, cursor, entry, input, key }) => {
			const lower = input.toLowerCase();
			const setDelay = (delayMs: number) => ({
				type: "update" as const,
				state: { ...draft, actionAutoReturnMs: delayMs },
				cursor,
			});
			const togglePause = () => ({
				type: "update" as const,
				state: { ...draft, actionPauseOnKey: !(draft.actionPauseOnKey ?? true) },
				cursor,
			});
			const toggleAutoFetch = () => ({
				type: "update" as const,
				state: { ...draft, menuAutoFetchLimits: !(draft.menuAutoFetchLimits ?? true) },
				cursor,
			});
			const toggleFetchStatus = () => ({
				type: "update" as const,
				state: { ...draft, menuShowFetchStatus: !(draft.menuShowFetchStatus ?? true) },
				cursor,
			});
			const cycleTtl = () => {
				const currentTtl = draft.menuQuotaTtlMs ?? 5 * 60_000;
				const currentIndex = MENU_QUOTA_TTL_OPTIONS_MS.findIndex((value) => value === currentTtl);
				const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % MENU_QUOTA_TTL_OPTIONS_MS.length;
				const nextTtl = MENU_QUOTA_TTL_OPTIONS_MS[nextIndex] ?? MENU_QUOTA_TTL_OPTIONS_MS[0] ?? currentTtl;
				return {
					type: "update" as const,
					state: { ...draft, menuQuotaTtlMs: nextTtl },
					cursor,
				};
			};

			if (lower === "q") return { type: "resolve", value: null };
			if (lower === "s") return { type: "resolve", value: draft };
			if (lower === "r") {
				return {
					type: "update",
					state: applyDashboardDefaultsForKeys(draft, BEHAVIOR_PANEL_KEYS),
					cursor: 0,
				};
			}
			if (lower === "p") return togglePause();
			if (lower === "l") return toggleAutoFetch();
			if (lower === "f") return toggleFetchStatus();
			if (lower === "t") return cycleTtl();
			const parsed = Number.parseInt(lower, 10);
			if (Number.isFinite(parsed) && parsed >= 1 && parsed <= AUTO_RETURN_OPTIONS_MS.length) {
				const delayMs = AUTO_RETURN_OPTIONS_MS[parsed - 1];
				if (typeof delayMs === "number") return setDelay(delayMs);
			}
			if (!key.return || !entry) return undefined;
			if (entry.id === "save") return { type: "resolve", value: draft };
			if (entry.id === "cancel") return { type: "resolve", value: null };
			if (entry.id === "reset") {
				return {
					type: "update",
					state: applyDashboardDefaultsForKeys(draft, BEHAVIOR_PANEL_KEYS),
					cursor: 0,
				};
			}
			if (entry.id === "pause") return togglePause();
			if (entry.id === "auto-fetch") return toggleAutoFetch();
			if (entry.id === "fetch-status") return toggleFetchStatus();
			if (entry.id === "ttl") return cycleTtl();
			if (entry.id.startsWith("delay:")) {
				const delayMs = Number.parseInt(entry.id.slice("delay:".length), 10);
				if (Number.isFinite(delayMs)) return setDelay(delayMs);
			}
			return undefined;
		},
	});
}

export async function promptInkThemeSettings(
	initial: DashboardDisplaySettings,
	options: InkSettingsEnvironment = {},
): Promise<DashboardDisplaySettings | null> {
	const baseline = cloneDashboardSettings(initial);
	return await promptInkSettingsScreen<DashboardDisplaySettings, DashboardDisplaySettings | null>({
		...options,
		title: UI_COPY.settings.themeTitle,
		subtitle: UI_COPY.settings.themeSubtitle,
		initialState: cloneDashboardSettings(initial),
		renderView: (draft): InkSettingsView => ({
			panelTitle: UI_COPY.settings.baseTheme,
			footer: UI_COPY.settings.themeHelp,
			status: `Base ${draft.uiThemePreset ?? "green"} | Accent ${draft.uiAccentColor ?? "green"}`,
			statusTone: "accent",
			entries: [
				...THEME_PRESET_OPTIONS.map((candidate, index) =>
					makeEntry(
						`palette:${candidate}`,
						`${draft.uiThemePreset === candidate ? "[x]" : "[ ]"} ${index + 1}. ${candidate === "green" ? "Green base" : "Blue base"}`,
						draft.uiThemePreset === candidate ? "success" : "warning",
						candidate === "green" ? "High-contrast default." : "Codex-style blue look.",
					),
				),
				...ACCENT_COLOR_OPTIONS.map((candidate) =>
					makeEntry(
						`accent:${candidate}`,
						`${draft.uiAccentColor === candidate ? "[x]" : "[ ]"} ${candidate}`,
						draft.uiAccentColor === candidate ? "success" : "warning",
					),
				),
				makeEntry("reset", UI_COPY.settings.resetDefault, "warning"),
				makeEntry("save", UI_COPY.settings.saveAndBack, "success"),
				makeEntry("cancel", UI_COPY.settings.backNoSave, "danger"),
			],
			previewTitle: UI_COPY.settings.previewHeading,
			previewLines: (() => {
				const preview = buildAccountListPreview(draft);
				return [preview.label, preview.hint];
			})(),
		}),
		onInput: ({ state: draft, cursor, entry, input, key }) => {
			const lower = input.toLowerCase();
			const setPalette = (palette: DashboardThemePreset) => {
				const next = { ...draft, uiThemePreset: palette };
				applyUiThemeFromDashboardSettings(next);
				return { type: "update" as const, state: next, cursor };
			};
			const setAccent = (accent: DashboardAccentColor) => {
				const next = { ...draft, uiAccentColor: accent };
				applyUiThemeFromDashboardSettings(next);
				return { type: "update" as const, state: next, cursor };
			};
			if (lower === "q") {
				applyUiThemeFromDashboardSettings(baseline);
				return { type: "resolve", value: null };
			}
			if (lower === "s") return { type: "resolve", value: draft };
			if (lower === "r") {
				const next = applyDashboardDefaultsForKeys(draft, THEME_PANEL_KEYS);
				applyUiThemeFromDashboardSettings(next);
				return { type: "update", state: next, cursor: 0 };
			}
			if (lower === "1") return setPalette("green");
			if (lower === "2") return setPalette("blue");
			if (!key.return || !entry) return undefined;
			if (entry.id === "save") return { type: "resolve", value: draft };
			if (entry.id === "cancel") {
				applyUiThemeFromDashboardSettings(baseline);
				return { type: "resolve", value: null };
			}
			if (entry.id === "reset") {
				const next = applyDashboardDefaultsForKeys(draft, THEME_PANEL_KEYS);
				applyUiThemeFromDashboardSettings(next);
				return { type: "update", state: next, cursor: 0 };
			}
			if (entry.id.startsWith("palette:")) {
				const palette = entry.id.slice("palette:".length) as DashboardThemePreset;
				return setPalette(palette);
			}
			if (entry.id.startsWith("accent:")) {
				const accent = entry.id.slice("accent:".length) as DashboardAccentColor;
				return setAccent(accent);
			}
			return undefined;
		},
	});
}

function getBackendCategory(key: BackendCategoryKey): BackendCategoryOption | null {
	return BACKEND_CATEGORY_OPTIONS.find((category) => category.key === key) ?? null;
}

function applyBackendCategoryDefaults(
	draft: PluginConfig,
	category: BackendCategoryOption,
): PluginConfig {
	const next = { ...draft };
	for (const key of category.toggleKeys) {
		next[key] = BACKEND_DEFAULTS[key] ?? false;
	}
	for (const key of category.numberKeys) {
		const option = BACKEND_NUMBER_OPTION_BY_KEY.get(key);
		const fallback = option?.min ?? 0;
		next[key] = BACKEND_DEFAULTS[key] ?? fallback;
	}
	return next;
}

async function promptInkBackendCategorySettings(
	initial: PluginConfig,
	category: BackendCategoryOption,
	options: InkSettingsEnvironment = {},
): Promise<PluginConfig | null> {
	return await promptInkSettingsScreen<PluginConfig, PluginConfig | null>({
		...options,
		title: `${UI_COPY.settings.backendCategoryTitle}: ${category.label}`,
		subtitle: category.description,
		initialState: cloneBackendPluginConfig(initial),
		renderView: (draft): InkSettingsView => {
			const preview = buildBackendSettingsPreview(draft);
			const toggleEntries: InkSettingsEntry[] = category.toggleKeys.flatMap((key, index) => {
					const option = BACKEND_TOGGLE_OPTION_BY_KEY.get(key);
					if (!option) return [];
					const enabled = draft[key] ?? BACKEND_DEFAULTS[key] ?? false;
					return [
						makeEntry(
							`toggle:${key}`,
							`${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}`,
							entryTone(enabled),
							option.description,
						),
					];
				});
			const numberEntries: InkSettingsEntry[] = category.numberKeys.flatMap((key) => {
					const option = BACKEND_NUMBER_OPTION_BY_KEY.get(key);
					if (!option) return [];
					const rawValue = draft[key] ?? BACKEND_DEFAULTS[key] ?? option.min;
					const numericValue = typeof rawValue === "number" && Number.isFinite(rawValue)
						? rawValue
						: option.min;
					const clampedValue = clampBackendNumber(option, numericValue);
					return [
						makeEntry(
							`number:${key}`,
							`${option.label}: ${formatBackendNumberValue(option, clampedValue)}`,
							"warning",
							`${option.description} Step ${formatBackendNumberValue(option, option.step)}.`,
						),
					];
				});
			return {
				panelTitle: category.label,
				footer: UI_COPY.settings.backendCategoryHelp,
				previewTitle: UI_COPY.settings.previewHeading,
				previewLines: [preview.label, preview.hint],
				entries: [
					...toggleEntries,
					...numberEntries,
					makeEntry("reset", UI_COPY.settings.backendResetCategory, "warning"),
					makeEntry("back", UI_COPY.settings.backendBackToCategories, "danger"),
				],
			};
		},
		onInput: ({ state: draft, cursor, entry, input, key }) => {
			const lower = input.toLowerCase();
			const adjustCurrentNumber = (direction: -1 | 1) => {
				if (!entry || !entry.id.startsWith("number:")) return undefined;
				const numberKey = entry.id.slice("number:".length) as BackendNumberSettingKey;
				const option = BACKEND_NUMBER_OPTION_BY_KEY.get(numberKey);
				if (!option) return undefined;
				const currentValue = draft[numberKey] ?? BACKEND_DEFAULTS[numberKey] ?? option.min;
				const numericCurrent = typeof currentValue === "number" && Number.isFinite(currentValue)
					? currentValue
					: option.min;
				return {
					type: "update" as const,
					state: {
						...draft,
						[numberKey]: clampBackendNumber(option, numericCurrent + option.step * direction),
					},
					cursor,
				};
			};

			if (lower === "q") return { type: "resolve", value: draft };
			if (lower === "r") {
				return {
					type: "update",
					state: applyBackendCategoryDefaults(draft, category),
					cursor: 0,
				};
			}
			if (lower === "+" || lower === "=" || lower === "]" || lower === "d") {
				return adjustCurrentNumber(1);
			}
			if (lower === "-" || lower === "[" || lower === "a") {
				return adjustCurrentNumber(-1);
			}
			const parsed = Number.parseInt(lower, 10);
			if (Number.isFinite(parsed) && parsed >= 1 && parsed <= category.toggleKeys.length) {
				const toggleKey = category.toggleKeys[parsed - 1];
				if (toggleKey) {
					const currentValue = draft[toggleKey] ?? BACKEND_DEFAULTS[toggleKey] ?? false;
					return {
						type: "update",
						state: { ...draft, [toggleKey]: !currentValue },
						cursor: parsed - 1,
					};
				}
			}
			if (!key.return || !entry) return undefined;
			if (entry.id === "back") return { type: "resolve", value: draft };
			if (entry.id === "reset") {
				return {
					type: "update",
					state: applyBackendCategoryDefaults(draft, category),
					cursor: 0,
				};
			}
			if (entry.id.startsWith("toggle:")) {
				const toggleKey = entry.id.slice("toggle:".length) as BackendToggleSettingKey;
				const currentValue = draft[toggleKey] ?? BACKEND_DEFAULTS[toggleKey] ?? false;
				return {
					type: "update",
					state: { ...draft, [toggleKey]: !currentValue },
					cursor,
				};
			}
			if (entry.id.startsWith("number:")) {
				return adjustCurrentNumber(1);
			}
			return undefined;
		},
	});
}

export async function promptInkBackendSettings(
	initial: PluginConfig,
	options: InkSettingsEnvironment = {},
): Promise<PluginConfig | null> {
	let draft = cloneBackendPluginConfig(initial);
	let activeCategory = BACKEND_CATEGORY_OPTIONS[0]?.key ?? "session-sync";
	while (true) {
		const action = await promptInkSettingsScreen<PluginConfig, { type: "open"; key: BackendCategoryKey } | { type: "save" } | { type: "reset" } | { type: "cancel" }>({
			...options,
			title: UI_COPY.settings.backendTitle,
			subtitle: UI_COPY.settings.backendSubtitle,
			initialState: draft,
			initialCursor: Math.max(0, BACKEND_CATEGORY_OPTIONS.findIndex((category) => category.key === activeCategory)),
				renderView: (currentDraft): InkSettingsView => {
					const preview = buildBackendSettingsPreview(currentDraft);
					return {
					panelTitle: UI_COPY.settings.backendCategoriesHeading,
					footer: UI_COPY.settings.backendHelp,
					previewTitle: UI_COPY.settings.previewHeading,
					previewLines: [preview.label, preview.hint],
					entries: [
						...BACKEND_CATEGORY_OPTIONS.map((category, index) =>
							makeEntry(
								`category:${category.key}`,
								`${index + 1}. ${category.label}`,
								"success",
								category.description,
							),
						),
						makeEntry("reset", UI_COPY.settings.resetDefault, "warning"),
						makeEntry("save", UI_COPY.settings.saveAndBack, "success"),
						makeEntry("cancel", UI_COPY.settings.backNoSave, "danger"),
					],
				};
			},
			onInput: ({ cursor, entry, input, key }) => {
				const lower = input.toLowerCase();
				if (lower === "q") return { type: "resolve", value: { type: "cancel" } };
				if (lower === "s") return { type: "resolve", value: { type: "save" } };
				if (lower === "r") return { type: "resolve", value: { type: "reset" } };
				const parsed = Number.parseInt(lower, 10);
				if (Number.isFinite(parsed) && parsed >= 1 && parsed <= BACKEND_CATEGORY_OPTIONS.length) {
					const category = BACKEND_CATEGORY_OPTIONS[parsed - 1];
					if (category) return { type: "resolve", value: { type: "open", key: category.key } };
				}
				if (!key.return || !entry) return undefined;
				if (entry.id === "save") return { type: "resolve", value: { type: "save" } };
				if (entry.id === "reset") return { type: "resolve", value: { type: "reset" } };
				if (entry.id === "cancel") return { type: "resolve", value: { type: "cancel" } };
				if (entry.id.startsWith("category:")) {
					const keyValue = entry.id.slice("category:".length) as BackendCategoryKey;
					return { type: "resolve", value: { type: "open", key: keyValue } };
				}
				const category = BACKEND_CATEGORY_OPTIONS[cursor];
				if (category) return { type: "resolve", value: { type: "open", key: category.key } };
				return undefined;
			},
		});

		if (!action) return null;
		if (action.type === "cancel") return null;
		if (action.type === "save") return draft;
		if (action.type === "reset") {
			draft = cloneBackendPluginConfig(BACKEND_DEFAULTS);
			activeCategory = BACKEND_CATEGORY_OPTIONS[0]?.key ?? activeCategory;
			continue;
		}
		const category = getBackendCategory(action.key);
		if (!category) continue;
		activeCategory = category.key;
		const nextDraft = await promptInkBackendCategorySettings(draft, category, options);
		if (nextDraft) {
			draft = cloneBackendPluginConfig(nextDraft);
		}
	}
}

export async function configureInkUnifiedSettings(
	initialSettings?: DashboardDisplaySettings,
	options: InkSettingsEnvironment = {},
): Promise<boolean> {
	let current = cloneDashboardSettings(initialSettings ?? await loadDashboardDisplaySettings());
	let backendConfig = cloneBackendPluginConfig(loadPluginConfig());
	applyUiThemeFromDashboardSettings(current);
	let hubFocus: SettingsHubActionType = "account-list";
	const firstAction = await promptInkSettingsHub({ ...options, initialFocus: hubFocus });
	if (!firstAction) return false;
	let action: { type: SettingsHubActionType } | null = firstAction;
	while (action) {
		if (action.type === "back") return true;
		hubFocus = action.type;
		if (action.type === "account-list") {
			const selected = await promptInkAccountListSettings(current, options);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(selected, ACCOUNT_LIST_PANEL_KEYS, "account-list", {
					cloneSettings: cloneDashboardSettings,
					mergeSettingsForKeys: mergeDashboardSettingsForKeys,
				});
				applyUiThemeFromDashboardSettings(current);
			}
		} else if (action.type === "summary-fields") {
			const selected = await promptInkStatuslineSettings(current, options);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(selected, STATUSLINE_PANEL_KEYS, "summary-fields", {
					cloneSettings: cloneDashboardSettings,
					mergeSettingsForKeys: mergeDashboardSettingsForKeys,
				});
				applyUiThemeFromDashboardSettings(current);
			}
		} else if (action.type === "behavior") {
			const selected = await promptInkBehaviorSettings(current, options);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(selected, BEHAVIOR_PANEL_KEYS, "behavior", {
					cloneSettings: cloneDashboardSettings,
					mergeSettingsForKeys: mergeDashboardSettingsForKeys,
				});
				applyUiThemeFromDashboardSettings(current);
			}
		} else if (action.type === "theme") {
			const selected = await promptInkThemeSettings(current, options);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(selected, THEME_PANEL_KEYS, "theme", {
					cloneSettings: cloneDashboardSettings,
					mergeSettingsForKeys: mergeDashboardSettingsForKeys,
				});
				applyUiThemeFromDashboardSettings(current);
			}
		} else if (action.type === "backend") {
			const selected = await promptInkBackendSettings(backendConfig, options);
			if (selected && !backendSettingsEqual(backendConfig, selected)) {
				backendConfig = await persistBackendConfigSelection(selected, "backend", {
					cloneConfig: cloneBackendPluginConfig,
					buildPatch: buildBackendConfigPatch,
				});
			}
		}
		action = await promptInkSettingsHub({ ...options, initialFocus: hubFocus });
		if (!action) return true;
	}
	return true;
}
