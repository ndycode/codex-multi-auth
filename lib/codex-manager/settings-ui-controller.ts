import type {
	DashboardAccentColor,
	DashboardDisplaySettings,
	DashboardStatuslineField,
	DashboardThemePreset,
} from "../dashboard-settings.js";
import { UI_COPY } from "../ui/copy.js";

type DashboardSettingKey = keyof DashboardDisplaySettings;

export type DashboardDisplaySettingKey =
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

export interface DashboardDisplaySettingOption {
	key: DashboardDisplaySettingKey;
	label: string;
	description: string;
}

export const DASHBOARD_DISPLAY_OPTIONS: DashboardDisplaySettingOption[] = [
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

export const DEFAULT_STATUSLINE_FIELDS: DashboardStatuslineField[] = ["last-used", "limits", "status"];
export const STATUSLINE_FIELD_OPTIONS: Array<{
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

export const AUTO_RETURN_OPTIONS_MS = [1_000, 2_000, 4_000] as const;
export const MENU_QUOTA_TTL_OPTIONS_MS = [60_000, 5 * 60_000, 10 * 60_000] as const;
export const THEME_PRESET_OPTIONS: DashboardThemePreset[] = ["green", "blue"];
export const ACCENT_COLOR_OPTIONS: DashboardAccentColor[] = ["green", "cyan", "blue", "yellow"];

export type BackendToggleSettingKey =
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

export type BackendNumberSettingKey =
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

export interface BackendToggleSettingOption {
	key: BackendToggleSettingKey;
	label: string;
	description: string;
}

export interface BackendNumberSettingOption {
	key: BackendNumberSettingKey;
	label: string;
	description: string;
	min: number;
	max: number;
	step: number;
	unit: "ms" | "percent" | "count";
}

export type BackendCategoryKey =
	| "session-sync"
	| "rotation-quota"
	| "refresh-recovery"
	| "performance-timeouts";

export interface BackendCategoryOption {
	key: BackendCategoryKey;
	label: string;
	description: string;
	toggleKeys: BackendToggleSettingKey[];
	numberKeys: BackendNumberSettingKey[];
}

export const BACKEND_TOGGLE_OPTIONS: BackendToggleSettingOption[] = [
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

export const BACKEND_NUMBER_OPTIONS: BackendNumberSettingOption[] = [
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

export const BACKEND_CATEGORY_OPTIONS: BackendCategoryOption[] = [
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

export const ACCOUNT_LIST_PANEL_KEYS = [
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

export const STATUSLINE_PANEL_KEYS = ["menuStatuslineFields"] as const satisfies readonly DashboardSettingKey[];

export const BEHAVIOR_PANEL_KEYS = [
	"actionAutoReturnMs",
	"actionPauseOnKey",
	"menuAutoFetchLimits",
	"menuShowFetchStatus",
	"menuQuotaTtlMs",
] as const satisfies readonly DashboardSettingKey[];

export const THEME_PANEL_KEYS = ["uiThemePreset", "uiAccentColor"] as const satisfies readonly DashboardSettingKey[];

export type SettingsHubSectionId = "display" | "advanced" | "exit";
export type SettingsHubAction =
	| { type: "account-list" }
	| { type: "summary-fields" }
	| { type: "behavior" }
	| { type: "theme" }
	| { type: "backend" }
	| { type: "back" };

export interface SettingsHubActionViewModel {
	id: SettingsHubAction["type"];
	label: string;
	tone: "green" | "red";
}

export interface SettingsHubSectionViewModel {
	id: SettingsHubSectionId;
	title: string;
	actions: SettingsHubActionViewModel[];
}

export interface SettingsHubViewModel {
	sections: SettingsHubSectionViewModel[];
}

export type SettingsHubCommand =
	| { type: "back" }
	| { type: "open-dashboard-panel"; panel: "account-list" | "summary-fields" | "behavior" | "theme" }
	| { type: "open-backend-settings" };

export function buildSettingsHubViewModel(): SettingsHubViewModel {
	return {
		sections: [
			{
				id: "display",
				title: UI_COPY.settings.sectionTitle,
				actions: [
					{ id: "account-list", label: UI_COPY.settings.accountList, tone: "green" },
					{ id: "summary-fields", label: UI_COPY.settings.summaryFields, tone: "green" },
					{ id: "behavior", label: UI_COPY.settings.behavior, tone: "green" },
					{ id: "theme", label: UI_COPY.settings.theme, tone: "green" },
				],
			},
			{
				id: "advanced",
				title: UI_COPY.settings.advancedTitle,
				actions: [{ id: "backend", label: UI_COPY.settings.backend, tone: "green" }],
			},
			{
				id: "exit",
				title: UI_COPY.settings.exitTitle,
				actions: [{ id: "back", label: UI_COPY.settings.back, tone: "red" }],
			},
		],
	};
}

export function resolveSettingsHubCommand(action: SettingsHubAction): SettingsHubCommand {
	switch (action.type) {
		case "account-list":
		case "summary-fields":
		case "behavior":
		case "theme":
			return { type: "open-dashboard-panel", panel: action.type };
		case "backend":
			return { type: "open-backend-settings" };
		case "back":
			return { type: "back" };
	}
}
