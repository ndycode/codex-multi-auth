import { getDefaultPluginConfig } from "../config.js";
import type { PluginConfig } from "../types.js";

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

export type BackendSettingFocusKey =
	| BackendToggleSettingKey
	| BackendNumberSettingKey
	| null;

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

export type BackendCategoryConfigAction =
	| { type: "toggle"; key: BackendToggleSettingKey }
	| { type: "bump"; key: BackendNumberSettingKey; direction: -1 | 1 }
	| { type: "reset-category" }
	| { type: "back" };

export type BackendSettingsHubAction =
	| { type: "open-category"; key: BackendCategoryKey }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

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
		description: "Resume the most recent recoverable session automatically.",
	},
	{
		key: "perProjectAccounts",
		label: "Enable Per-Project Accounts",
		description: "Use repo-specific account storage instead of a global pool.",
	},
];

export const BACKEND_NUMBER_OPTIONS: BackendNumberSettingOption[] = [
	{
		key: "liveAccountSyncDebounceMs",
		label: "Live Sync Debounce",
		description: "Delay before reacting to file changes.",
		min: 50,
		max: 60_000,
		step: 50,
		unit: "ms",
	},
	{
		key: "liveAccountSyncPollMs",
		label: "Live Sync Poll Interval",
		description: "Polling fallback interval for external file changes.",
		min: 500,
		max: 120_000,
		step: 500,
		unit: "ms",
	},
	{
		key: "sessionAffinityTtlMs",
		label: "Session Affinity TTL",
		description: "How long affinity survives without activity.",
		min: 1_000,
		max: 86_400_000,
		step: 60_000,
		unit: "ms",
	},
	{
		key: "sessionAffinityMaxEntries",
		label: "Session Affinity Max Entries",
		description: "Upper bound for tracked affinity sessions.",
		min: 8,
		max: 4_096,
		step: 8,
		unit: "count",
	},
	{
		key: "proactiveRefreshIntervalMs",
		label: "Refresh Guard Interval",
		description: "How often the guard scans for refresh work.",
		min: 5_000,
		max: 3_600_000,
		step: 5_000,
		unit: "ms",
	},
	{
		key: "proactiveRefreshBufferMs",
		label: "Refresh Guard Buffer",
		description: "How early tokens should refresh before expiry.",
		min: 30_000,
		max: 7_200_000,
		step: 30_000,
		unit: "ms",
	},
	{
		key: "parallelProbingMaxConcurrency",
		label: "Parallel Probe Concurrency",
		description: "Maximum simultaneous account probes.",
		min: 1,
		max: 32,
		step: 1,
		unit: "count",
	},
	{
		key: "fastSessionMaxInputItems",
		label: "Fast Session Max Inputs",
		description: "Maximum prompt items kept in fast-session mode.",
		min: 8,
		max: 200,
		step: 2,
		unit: "count",
	},
	{
		key: "networkErrorCooldownMs",
		label: "Network Error Cooldown",
		description: "Cooldown applied after network failures.",
		min: 0,
		max: 300_000,
		step: 1_000,
		unit: "ms",
	},
	{
		key: "serverErrorCooldownMs",
		label: "Server Error Cooldown",
		description: "Cooldown applied after upstream server failures.",
		min: 0,
		max: 300_000,
		step: 1_000,
		unit: "ms",
	},
	{
		key: "fetchTimeoutMs",
		label: "Request Timeout",
		description: "Max time to wait for a request.",
		min: 1_000,
		max: (10 * 60 * 60_000) / 60,
		step: 5_000,
		unit: "ms",
	},
	{
		key: "streamStallTimeoutMs",
		label: "Stream Stall Timeout",
		description: "Max wait before a stuck stream is retried.",
		min: 1_000,
		max: (10 * 60 * 60_000) / 60,
		step: 5_000,
		unit: "ms",
	},
	{
		key: "tokenRefreshSkewMs",
		label: "Token Refresh Buffer",
		description: "Refresh this long before token expiry.",
		min: 0,
		max: (10 * 60 * 60_000) / 60,
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
		toggleKeys: ["storageBackupEnabled"],
		numberKeys: ["proactiveRefreshBufferMs", "tokenRefreshSkewMs"],
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

export const BACKEND_DEFAULTS: PluginConfig = getDefaultPluginConfig();

export const BACKEND_TOGGLE_OPTION_BY_KEY = new Map<
	BackendToggleSettingKey,
	BackendToggleSettingOption
>(BACKEND_TOGGLE_OPTIONS.map((option) => [option.key, option]));

export const BACKEND_NUMBER_OPTION_BY_KEY = new Map<
	BackendNumberSettingKey,
	BackendNumberSettingOption
>(BACKEND_NUMBER_OPTIONS.map((option) => [option.key, option]));
