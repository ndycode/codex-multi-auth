import { stdin as input, stdout as output } from "node:process";
import {
	type CodexCliState,
	getCodexCliAccountsPath,
	getCodexCliAuthPath,
	getCodexCliConfigPath,
	isCodexCliSyncEnabled,
	loadCodexCliState,
} from "../codex-cli/state.js";
import {
	type CodexCliSyncPreview,
	type CodexCliSyncRun,
	type CodexCliSyncSummary,
	previewCodexCliSync,
	syncAccountStorageFromCodexCli,
} from "../codex-cli/sync.js";
import {
	getDefaultPluginConfig,
	getStorageBackupEnabled,
	loadPluginConfig,
	savePluginConfig,
} from "../config.js";
import {
	type DashboardAccentColor,
	type DashboardAccountSortMode,
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
	type DashboardThemePreset,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	getDashboardSettingsPath,
	loadDashboardDisplaySettings,
	saveDashboardDisplaySettings,
} from "../dashboard-settings.js";
import {
	getLastLiveAccountSyncSnapshot,
	type LiveAccountSyncSnapshot,
} from "../live-account-sync.js";
import { loadAccounts, saveAccounts } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { ANSI } from "../ui/ansi.js";
import { UI_COPY } from "../ui/copy.js";
import { getUiRuntimeOptions, setUiRuntimeOptions } from "../ui/runtime.js";
import { type MenuItem, select } from "../ui/select.js";
import { getUnifiedSettingsPath } from "../unified-settings.js";
import { sleep } from "../utils.js";

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

const DEFAULT_STATUSLINE_FIELDS: DashboardStatuslineField[] = [
	"last-used",
	"limits",
	"status",
];
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
const ACCENT_COLOR_OPTIONS: DashboardAccentColor[] = [
	"green",
	"cyan",
	"blue",
	"yellow",
];
const PREVIEW_ACCOUNT_EMAIL = "demo@example.com";
const PREVIEW_LAST_USED = "today";
const PREVIEW_STATUS = "active";
const PREVIEW_LIMITS = "5h ██████▒▒▒▒ 62% | 7d █████▒▒▒▒▒ 49%";
const PREVIEW_LIMIT_COOLDOWNS = "5h reset 1h 20m | 7d reset 2d 04h";
type PreviewFocusKey =
	| DashboardDisplaySettingKey
	| DashboardStatuslineField
	| "menuSortMode"
	| "menuLayoutMode"
	| null;

type DashboardConfigAction =
	| { type: "toggle"; key: DashboardDisplaySettingKey }
	| { type: "cycle-sort-mode" }
	| { type: "cycle-layout-mode" }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

type StatuslineConfigAction =
	| { type: "toggle"; key: DashboardStatuslineField }
	| { type: "move-up"; key: DashboardStatuslineField }
	| { type: "move-down"; key: DashboardStatuslineField }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

type BehaviorConfigAction =
	| { type: "set-delay"; delayMs: number }
	| { type: "toggle-pause" }
	| { type: "toggle-menu-limit-fetch" }
	| { type: "toggle-menu-fetch-status" }
	| { type: "set-menu-quota-ttl"; ttlMs: number }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

type ThemeConfigAction =
	| { type: "set-palette"; palette: DashboardThemePreset }
	| { type: "set-accent"; accent: DashboardAccentColor }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

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

type BackendSettingFocusKey =
	| BackendToggleSettingKey
	| BackendNumberSettingKey
	| null;

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

type BackendCategoryConfigAction =
	| { type: "toggle"; key: BackendToggleSettingKey }
	| { type: "bump"; key: BackendNumberSettingKey; direction: -1 | 1 }
	| { type: "reset-category" }
	| { type: "back" };

type BackendSettingsHubAction =
	| { type: "open-category"; key: BackendCategoryKey }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

type SettingsHubAction =
	| { type: "account-list" }
	| { type: "sync-center" }
	| { type: "summary-fields" }
	| { type: "behavior" }
	| { type: "theme" }
	| { type: "backend" }
	| { type: "back" };

type SyncCenterAction =
	| { type: "refresh" }
	| { type: "apply" }
	| { type: "back" };

interface SyncCenterOverviewContext {
	accountsPath: string;
	authPath: string;
	configPath: string;
	state: CodexCliState | null;
	liveSync: LiveAccountSyncSnapshot;
	syncEnabled: boolean;
}

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
const BACKEND_TOGGLE_OPTION_BY_KEY = new Map<
	BackendToggleSettingKey,
	BackendToggleSettingOption
>(BACKEND_TOGGLE_OPTIONS.map((option) => [option.key, option]));
const BACKEND_NUMBER_OPTION_BY_KEY = new Map<
	BackendNumberSettingKey,
	BackendNumberSettingOption
>(BACKEND_NUMBER_OPTIONS.map((option) => [option.key, option]));
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

const RETRYABLE_SETTINGS_WRITE_CODES = new Set([
	"EBUSY",
	"EPERM",
	"EAGAIN",
	"ENOTEMPTY",
	"EACCES",
]);
const SETTINGS_WRITE_MAX_ATTEMPTS = 4;
const SETTINGS_WRITE_BASE_DELAY_MS = 20;
const SETTINGS_WRITE_MAX_DELAY_MS = 30_000;
const settingsWriteQueues = new Map<string, Promise<void>>();

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

const STATUSLINE_PANEL_KEYS = [
	"menuStatuslineFields",
] as const satisfies readonly DashboardSettingKey[];
const BEHAVIOR_PANEL_KEYS = [
	"actionAutoReturnMs",
	"actionPauseOnKey",
	"menuAutoFetchLimits",
	"menuShowFetchStatus",
	"menuQuotaTtlMs",
] as const satisfies readonly DashboardSettingKey[];
const THEME_PANEL_KEYS = [
	"uiThemePreset",
	"uiAccentColor",
] as const satisfies readonly DashboardSettingKey[];

function readErrorNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function getErrorStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const record = error as Record<string, unknown>;
	return readErrorNumber(record.status) ?? readErrorNumber(record.statusCode);
}

function getRetryAfterMs(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const record = error as Record<string, unknown>;
	return (
		readErrorNumber(record.retryAfterMs) ??
		readErrorNumber(record.retry_after_ms) ??
		readErrorNumber(record.retryAfter) ??
		readErrorNumber(record.retry_after)
	);
}

function isRetryableSettingsWriteError(error: unknown): boolean {
	const statusCode = getErrorStatusCode(error);
	if (statusCode === 429) return true;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_SETTINGS_WRITE_CODES.has(code);
}

function resolveRetryDelayMs(error: unknown, attempt: number): number {
	const retryAfterMs = getRetryAfterMs(error);
	if (
		typeof retryAfterMs === "number" &&
		Number.isFinite(retryAfterMs) &&
		retryAfterMs > 0
	) {
		return Math.max(
			10,
			Math.min(SETTINGS_WRITE_MAX_DELAY_MS, Math.round(retryAfterMs)),
		);
	}
	return Math.min(
		SETTINGS_WRITE_MAX_DELAY_MS,
		SETTINGS_WRITE_BASE_DELAY_MS * 2 ** attempt,
	);
}

async function enqueueSettingsWrite<T>(
	pathKey: string,
	task: () => Promise<T>,
): Promise<T> {
	const previous = settingsWriteQueues.get(pathKey) ?? Promise.resolve();
	const queued = previous.catch(() => {}).then(task);
	const queueTail = queued.then(
		() => undefined,
		() => undefined,
	);
	settingsWriteQueues.set(pathKey, queueTail);
	try {
		return await queued;
	} finally {
		if (settingsWriteQueues.get(pathKey) === queueTail) {
			settingsWriteQueues.delete(pathKey);
		}
	}
}

async function withQueuedRetry<T>(
	pathKey: string,
	task: () => Promise<T>,
): Promise<T> {
	return enqueueSettingsWrite(pathKey, async () => {
		let lastError: unknown;
		for (let attempt = 0; attempt < SETTINGS_WRITE_MAX_ATTEMPTS; attempt += 1) {
			try {
				return await task();
			} catch (error) {
				lastError = error;
				if (
					!isRetryableSettingsWriteError(error) ||
					attempt + 1 >= SETTINGS_WRITE_MAX_ATTEMPTS
				) {
					throw error;
				}
				await sleep(resolveRetryDelayMs(error, attempt));
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("settings save retry exhausted");
	});
}

function copyDashboardSettingValue(
	target: DashboardDisplaySettings,
	source: DashboardDisplaySettings,
	key: DashboardSettingKey,
): void {
	const value = source[key];
	(target as unknown as Record<string, unknown>)[key] = Array.isArray(value)
		? [...value]
		: value;
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

function resolvePluginConfigSavePathKey(): string {
	const envPath = (process.env.CODEX_MULTI_AUTH_CONFIG_PATH ?? "").trim();
	return envPath.length > 0 ? envPath : getUnifiedSettingsPath();
}

function formatPersistError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function warnPersistFailure(scope: string, error: unknown): void {
	console.warn(
		`Settings save failed (${scope}) after retries: ${formatPersistError(error)}`,
	);
}

async function persistDashboardSettingsSelection(
	selected: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
	scope: string,
): Promise<DashboardDisplaySettings> {
	const fallback = cloneDashboardSettings(selected);
	try {
		return await withQueuedRetry(getDashboardSettingsPath(), async () => {
			const latest = cloneDashboardSettings(
				await loadDashboardDisplaySettings(),
			);
			const merged = mergeDashboardSettingsForKeys(latest, selected, keys);
			await saveDashboardDisplaySettings(merged);
			return merged;
		});
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}

async function persistBackendConfigSelection(
	selected: PluginConfig,
	scope: string,
): Promise<PluginConfig> {
	const fallback = cloneBackendPluginConfig(selected);
	try {
		await withQueuedRetry(resolvePluginConfigSavePathKey(), async () => {
			await savePluginConfig(buildBackendConfigPatch(selected));
		});
		return fallback;
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
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

function highlightPreviewToken(
	text: string,
	ui: ReturnType<typeof getUiRuntimeOptions>,
): string {
	if (!output.isTTY) return text;
	if (ui.v2Enabled) {
		return `${ui.theme.colors.accent}${ANSI.bold}${text}${ui.theme.colors.reset}`;
	}
	return `${ANSI.cyan}${ANSI.bold}${text}${ANSI.reset}`;
}

function isLastUsedPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowLastUsed" || focus === "last-used";
}

function isLimitsPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowQuotaSummary" || focus === "limits";
}

function isLimitsCooldownPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowQuotaCooldown";
}

function isStatusPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowStatusBadge" || focus === "status";
}

function isCurrentBadgePreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowCurrentBadge";
}

function isCurrentRowPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuHighlightCurrentRow";
}

function isExpandedRowsPreviewFocus(focus: PreviewFocusKey): boolean {
	return (
		focus === "menuShowDetailsForUnselectedRows" || focus === "menuLayoutMode"
	);
}

function buildSummaryPreviewText(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus: PreviewFocusKey = null,
): string {
	const partsByField = new Map<DashboardStatuslineField, string>();
	if (settings.menuShowLastUsed !== false) {
		const part = `last used: ${PREVIEW_LAST_USED}`;
		partsByField.set(
			"last-used",
			isLastUsedPreviewFocus(focus) ? highlightPreviewToken(part, ui) : part,
		);
	}
	if (settings.menuShowQuotaSummary !== false) {
		const limitsText =
			settings.menuShowQuotaCooldown === false
				? PREVIEW_LIMITS
				: `${PREVIEW_LIMITS} | ${PREVIEW_LIMIT_COOLDOWNS}`;
		const part = `limits: ${limitsText}`;
		partsByField.set(
			"limits",
			isLimitsPreviewFocus(focus) || isLimitsCooldownPreviewFocus(focus)
				? highlightPreviewToken(part, ui)
				: part,
		);
	}
	if (settings.menuShowStatusBadge === false) {
		const part = `status: ${PREVIEW_STATUS}`;
		partsByField.set(
			"status",
			isStatusPreviewFocus(focus) ? highlightPreviewToken(part, ui) : part,
		);
	}

	const orderedParts = normalizeStatuslineFields(settings.menuStatuslineFields)
		.map((field) => partsByField.get(field))
		.filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
	if (orderedParts.length > 0) {
		return orderedParts.join(" | ");
	}

	const showsStatusField = normalizeStatuslineFields(
		settings.menuStatuslineFields,
	).includes("status");
	if (showsStatusField && settings.menuShowStatusBadge !== false) {
		const note = "status text appears only when status badges are hidden";
		return isStatusPreviewFocus(focus) ? highlightPreviewToken(note, ui) : note;
	}
	return "no summary text is visible with current account-list settings";
}

function buildAccountListPreview(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus: PreviewFocusKey = null,
): { label: string; hint: string } {
	const badges: string[] = [];
	if (settings.menuShowCurrentBadge !== false) {
		const currentBadge = "[current]";
		badges.push(
			isCurrentBadgePreviewFocus(focus)
				? highlightPreviewToken(currentBadge, ui)
				: currentBadge,
		);
	}
	if (settings.menuShowStatusBadge !== false) {
		const statusBadge = "[active]";
		badges.push(
			isStatusPreviewFocus(focus)
				? highlightPreviewToken(statusBadge, ui)
				: statusBadge,
		);
	}
	const badgeSuffix = badges.length > 0 ? ` ${badges.join(" ")}` : "";
	const accountEmail = isCurrentRowPreviewFocus(focus)
		? highlightPreviewToken(PREVIEW_ACCOUNT_EMAIL, ui)
		: PREVIEW_ACCOUNT_EMAIL;
	const rowDetailMode =
		resolveMenuLayoutMode(settings) === "expanded-rows"
			? "details shown on all rows"
			: "details shown on selected row only";
	const detailModeText = isExpandedRowsPreviewFocus(focus)
		? highlightPreviewToken(rowDetailMode, ui)
		: rowDetailMode;
	return {
		label: `1. ${accountEmail}${badgeSuffix}`,
		hint: `${buildSummaryPreviewText(settings, ui, focus)}\n${detailModeText}`,
	};
}

function cloneDashboardSettings(
	settings: DashboardDisplaySettings,
): DashboardDisplaySettings {
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
			settings.menuSortEnabled ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
			true,
		menuSortMode:
			settings.menuSortMode ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
			"ready-first",
		menuSortPinCurrent:
			settings.menuSortPinCurrent ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
			false,
		menuSortQuickSwitchVisibleRow:
			settings.menuSortQuickSwitchVisibleRow ?? true,
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
		menuStatuslineFields: [
			...normalizeStatuslineFields(settings.menuStatuslineFields),
		],
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
		(left.actionAutoReturnMs ?? 2_000) ===
			(right.actionAutoReturnMs ?? 2_000) &&
		(left.actionPauseOnKey ?? true) === (right.actionPauseOnKey ?? true) &&
		(left.menuAutoFetchLimits ?? true) ===
			(right.menuAutoFetchLimits ?? true) &&
		(left.menuSortEnabled ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
			true) ===
			(right.menuSortEnabled ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
				true) &&
		(left.menuSortMode ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
			"ready-first") ===
			(right.menuSortMode ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
				"ready-first") &&
		(left.menuSortPinCurrent ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
			false) ===
			(right.menuSortPinCurrent ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
				false) &&
		(left.menuSortQuickSwitchVisibleRow ?? true) ===
			(right.menuSortQuickSwitchVisibleRow ?? true) &&
		(left.uiThemePreset ?? "green") === (right.uiThemePreset ?? "green") &&
		(left.uiAccentColor ?? "green") === (right.uiAccentColor ?? "green") &&
		(left.menuShowStatusBadge ?? true) ===
			(right.menuShowStatusBadge ?? true) &&
		(left.menuShowCurrentBadge ?? true) ===
			(right.menuShowCurrentBadge ?? true) &&
		(left.menuShowLastUsed ?? true) === (right.menuShowLastUsed ?? true) &&
		(left.menuShowQuotaSummary ?? true) ===
			(right.menuShowQuotaSummary ?? true) &&
		(left.menuShowQuotaCooldown ?? true) ===
			(right.menuShowQuotaCooldown ?? true) &&
		(left.menuShowFetchStatus ?? true) ===
			(right.menuShowFetchStatus ?? true) &&
		resolveMenuLayoutMode(left) === resolveMenuLayoutMode(right) &&
		(left.menuQuotaTtlMs ?? 5 * 60_000) ===
			(right.menuQuotaTtlMs ?? 5 * 60_000) &&
		(left.menuFocusStyle ?? "row-invert") ===
			(right.menuFocusStyle ?? "row-invert") &&
		(left.menuHighlightCurrentRow ?? true) ===
			(right.menuHighlightCurrentRow ?? true) &&
		JSON.stringify(normalizeStatuslineFields(left.menuStatuslineFields)) ===
			JSON.stringify(normalizeStatuslineFields(right.menuStatuslineFields))
	);
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

function backendSettingsSnapshot(
	config: PluginConfig,
): Record<string, unknown> {
	const snapshot: Record<string, unknown> = {};
	for (const option of BACKEND_TOGGLE_OPTIONS) {
		snapshot[option.key] =
			config[option.key] ?? BACKEND_DEFAULTS[option.key] ?? false;
	}
	for (const option of BACKEND_NUMBER_OPTIONS) {
		snapshot[option.key] =
			config[option.key] ?? BACKEND_DEFAULTS[option.key] ?? option.min;
	}
	return snapshot;
}

function backendSettingsEqual(
	left: PluginConfig,
	right: PluginConfig,
): boolean {
	return (
		JSON.stringify(backendSettingsSnapshot(left)) ===
		JSON.stringify(backendSettingsSnapshot(right))
	);
}

function formatBackendNumberValue(
	option: BackendNumberSettingOption,
	value: number,
): string {
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

function clampBackendNumber(
	option: BackendNumberSettingOption,
	value: number,
): number {
	return Math.max(option.min, Math.min(option.max, Math.round(value)));
}

function buildBackendSettingsPreview(
	config: PluginConfig,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus: BackendSettingFocusKey = null,
): { label: string; hint: string } {
	const liveSync =
		config.liveAccountSync ?? BACKEND_DEFAULTS.liveAccountSync ?? true;
	const affinity =
		config.sessionAffinity ?? BACKEND_DEFAULTS.sessionAffinity ?? true;
	const preemptive =
		config.preemptiveQuotaEnabled ??
		BACKEND_DEFAULTS.preemptiveQuotaEnabled ??
		true;
	const threshold5h =
		config.preemptiveQuotaRemainingPercent5h ??
		BACKEND_DEFAULTS.preemptiveQuotaRemainingPercent5h ??
		5;
	const threshold7d =
		config.preemptiveQuotaRemainingPercent7d ??
		BACKEND_DEFAULTS.preemptiveQuotaRemainingPercent7d ??
		5;
	const fetchTimeout =
		config.fetchTimeoutMs ?? BACKEND_DEFAULTS.fetchTimeoutMs ?? 60_000;
	const stallTimeout =
		config.streamStallTimeoutMs ??
		BACKEND_DEFAULTS.streamStallTimeoutMs ??
		45_000;
	const fetchTimeoutOption = BACKEND_NUMBER_OPTION_BY_KEY.get("fetchTimeoutMs");
	const stallTimeoutOption = BACKEND_NUMBER_OPTION_BY_KEY.get(
		"streamStallTimeoutMs",
	);

	const highlightIfFocused = (
		key: BackendSettingFocusKey,
		text: string,
	): string => {
		if (focus !== key) return text;
		return highlightPreviewToken(text, ui);
	};

	const label = [
		`live sync ${highlightIfFocused("liveAccountSync", liveSync ? "on" : "off")}`,
		`affinity ${highlightIfFocused("sessionAffinity", affinity ? "on" : "off")}`,
		`preemptive ${highlightIfFocused("preemptiveQuotaEnabled", preemptive ? "on" : "off")}`,
	].join(" | ");

	const hint = [
		`thresholds 5h<=${highlightIfFocused("preemptiveQuotaRemainingPercent5h", `${threshold5h}%`)}`,
		`7d<=${highlightIfFocused("preemptiveQuotaRemainingPercent7d", `${threshold7d}%`)}`,
		`timeouts ${highlightIfFocused("fetchTimeoutMs", fetchTimeoutOption ? formatBackendNumberValue(fetchTimeoutOption, fetchTimeout) : `${fetchTimeout}ms`)}/${highlightIfFocused("streamStallTimeoutMs", stallTimeoutOption ? formatBackendNumberValue(stallTimeoutOption, stallTimeout) : `${stallTimeout}ms`)}`,
	].join(" | ");

	return { label, hint };
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

function applyUiThemeFromDashboardSettings(
	settings: DashboardDisplaySettings,
): void {
	const current = getUiRuntimeOptions();
	setUiRuntimeOptions({
		v2Enabled: current.v2Enabled,
		colorProfile: current.colorProfile,
		glyphMode: current.glyphMode,
		palette: settings.uiThemePreset ?? "green",
		accent: settings.uiAccentColor ?? "green",
	});
}

function formatDashboardSettingState(value: boolean): string {
	return value ? "[x]" : "[ ]";
}

function formatMenuSortMode(mode: DashboardAccountSortMode): string {
	return mode === "ready-first" ? "Ready-First" : "Manual";
}

function resolveMenuLayoutMode(
	settings: DashboardDisplaySettings,
): "compact-details" | "expanded-rows" {
	if (settings.menuLayoutMode === "expanded-rows") {
		return "expanded-rows";
	}
	if (settings.menuLayoutMode === "compact-details") {
		return "compact-details";
	}
	return settings.menuShowDetailsForUnselectedRows === true
		? "expanded-rows"
		: "compact-details";
}

function formatMenuLayoutMode(
	mode: "compact-details" | "expanded-rows",
): string {
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

function formatSyncRunTime(run: CodexCliSyncRun | null): string {
	if (!run) return "No sync applied in this session.";
	return new Date(run.runAt).toISOString().replace("T", " ");
}

function formatSyncRunOutcome(run: CodexCliSyncRun | null): string {
	if (!run) return "none";
	if (run.outcome === "changed") return "applied changes";
	if (run.outcome === "noop") return "already aligned";
	if (run.outcome === "disabled") return "disabled";
	if (run.outcome === "unavailable") return "source missing";
	return run.message ? `error: ${run.message}` : "error";
}

function formatSyncSummary(summary: CodexCliSyncSummary): string {
	return [
		`add ${summary.addedAccountCount}`,
		`update ${summary.updatedAccountCount}`,
		`preserve ${summary.destinationOnlyPreservedCount}`,
		`after ${summary.targetAccountCountAfter}`,
	].join(" | ");
}

function formatSyncTimestamp(timestamp: number | null | undefined): string {
	if (
		typeof timestamp !== "number" ||
		!Number.isFinite(timestamp) ||
		timestamp <= 0
	) {
		return "none";
	}
	return new Date(timestamp).toISOString().replace("T", " ");
}

function formatSyncMtime(mtimeMs: number | null): string {
	if (
		typeof mtimeMs !== "number" ||
		!Number.isFinite(mtimeMs) ||
		mtimeMs <= 0
	) {
		return "unknown";
	}
	return new Date(Math.round(mtimeMs)).toISOString().replace("T", " ");
}

function resolveSyncCenterContext(
	state: CodexCliState | null,
): SyncCenterOverviewContext {
	return {
		accountsPath: getCodexCliAccountsPath(),
		authPath: getCodexCliAuthPath(),
		configPath: getCodexCliConfigPath(),
		state,
		liveSync: getLastLiveAccountSyncSnapshot(),
		syncEnabled: isCodexCliSyncEnabled(),
	};
}

function formatSyncSourceLabel(
	preview: CodexCliSyncPreview,
	context: SyncCenterOverviewContext,
): string {
	if (!context.syncEnabled) return "disabled by environment override";
	if (!preview.sourcePath) return "not available";
	if (preview.sourcePath === context.accountsPath)
		return "accounts.json active";
	if (preview.sourcePath === context.authPath)
		return "auth.json fallback active";
	return "custom source path active";
}

function buildSyncCenterOverview(
	preview: CodexCliSyncPreview,
	context: SyncCenterOverviewContext = resolveSyncCenterContext(null),
): Array<{ label: string; hint?: string }> {
	const lastSync = preview.lastSync;
	const activeSourceLabel = formatSyncSourceLabel(preview, context);
	const liveSync = context.liveSync;
	const liveSyncLabel = liveSync.running ? "running" : "idle";
	const liveSyncHint = liveSync.running
		? `Watching ${liveSync.path ?? preview.targetPath}. Reloads ${liveSync.reloadCount}, errors ${liveSync.errorCount}, last reload ${formatSyncTimestamp(liveSync.lastSyncAt)}, last seen mtime ${formatSyncMtime(liveSync.lastKnownMtimeMs)}.`
		: `No live watcher is active in this process. When plugin mode runs with live sync enabled, it watches ${preview.targetPath} and reloads accounts after file changes.`;
	const sourceStateHint = [
		`Active source: ${activeSourceLabel}.`,
		`Accounts path: ${context.accountsPath}`,
		`Auth path: ${context.authPath}`,
		`Config path: ${context.configPath}`,
		context.state
			? `Visible source accounts: ${context.state.accounts.length}.`
			: "No readable Codex CLI source is visible right now.",
	].join("\n");
	const selectionHint = preview.summary.selectionChanged
		? "When the Codex CLI source is newer, target selection follows activeAccountId first, then activeEmail or the active snapshot email. If local storage or a local Codex selection write is newer, the target keeps the local selection."
		: "Selection precedence stays accountId first, then email, with newer local target state preserving its own active selection instead of being overwritten.";
	return [
		{
			label: `Status: ${preview.status}`,
			hint: `${preview.statusDetail}\nLast sync: ${formatSyncRunOutcome(lastSync)} at ${formatSyncRunTime(lastSync)}`,
		},
		{
			label: `Target path: ${preview.targetPath}`,
			hint: preview.sourcePath
				? `Source path: ${preview.sourcePath}`
				: "Source path: not available",
		},
		{
			label: `Codex CLI source visibility: ${activeSourceLabel}`,
			hint: sourceStateHint,
		},
		{
			label: `Live watcher: ${liveSyncLabel}`,
			hint: liveSyncHint,
		},
		{
			label: "Preview mode: read-only until apply",
			hint: "Refresh only re-reads the Codex CLI source and recomputes the one-way result. Apply writes that preview into the target path; it does not create a bidirectional merge.",
		},
		{
			label: `Preview summary: ${formatSyncSummary(preview.summary)}`,
			hint: preview.summary.selectionChanged
				? "Active selection also updates to match the current Codex CLI source when that source is newer."
				: "Active selection already matches the one-way sync result.",
		},
		{
			label:
				"Selection precedence: accountId -> email -> preserve newer local choice",
			hint: selectionHint,
		},
		{
			label: `Destination-only preservation: keep ${preview.summary.destinationOnlyPreservedCount} target-only account(s)`,
			hint: "One-way sync never deletes accounts that exist only in the target storage.",
		},
		{
			label: `Pre-sync backup and rollback: ${preview.backup.enabled ? "enabled" : "disabled"}`,
			hint: preview.backup.enabled
				? `Before apply, target writes can create ${preview.backup.rollbackPaths.join(", ")} so rollback has explicit recovery context if the sync result is not what you expected.`
				: "Storage backups are currently disabled, so apply writes rely on the direct target write only.",
		},
	];
}

function clampBackendNumberForTests(settingKey: string, value: number): number {
	const option = BACKEND_NUMBER_OPTION_BY_KEY.get(
		settingKey as BackendNumberSettingKey,
	);
	if (!option) {
		throw new Error(`Unknown backend numeric setting key: ${settingKey}`);
	}
	return clampBackendNumber(option, value);
}

async function withQueuedRetryForTests<T>(
	pathKey: string,
	task: () => Promise<T>,
): Promise<T> {
	return withQueuedRetry(pathKey, task);
}

async function persistDashboardSettingsSelectionForTests(
	selected: DashboardDisplaySettings,
	keys: ReadonlyArray<keyof DashboardDisplaySettings>,
	scope: string,
): Promise<DashboardDisplaySettings> {
	return persistDashboardSettingsSelection(
		selected,
		keys as readonly DashboardSettingKey[],
		scope,
	);
}

async function persistBackendConfigSelectionForTests(
	selected: PluginConfig,
	scope: string,
): Promise<PluginConfig> {
	return persistBackendConfigSelection(selected, scope);
}

const __testOnly = {
	clampBackendNumber: clampBackendNumberForTests,
	formatMenuLayoutMode,
	cloneDashboardSettings,
	buildSyncCenterOverview,
	withQueuedRetry: withQueuedRetryForTests,
	persistDashboardSettingsSelection: persistDashboardSettingsSelectionForTests,
	persistBackendConfigSelection: persistBackendConfigSelectionForTests,
};

/* c8 ignore start - interactive prompt flows are covered by integration tests */
async function promptDashboardDisplaySettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	if (!input.isTTY || !output.isTTY) {
		return null;
	}

	const ui = getUiRuntimeOptions();
	let draft = cloneDashboardSettings(initial);
	let focusKey: DashboardDisplaySettingKey | "menuSortMode" | "menuLayoutMode" =
		DASHBOARD_DISPLAY_OPTIONS[0]?.key ?? "menuShowStatusBadge";
	while (true) {
		const preview = buildAccountListPreview(draft, ui, focusKey);
		const optionItems: MenuItem<DashboardConfigAction>[] =
			DASHBOARD_DISPLAY_OPTIONS.map((option, index) => {
				const enabled = draft[option.key] ?? true;
				const label = `${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}`;
				const color: MenuItem<DashboardConfigAction>["color"] = enabled
					? "green"
					: "yellow";
				return {
					label,
					hint: option.description,
					value: { type: "toggle", key: option.key } as DashboardConfigAction,
					color,
				};
			});
		const sortMode =
			draft.menuSortMode ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
			"ready-first";
		const sortModeItem: MenuItem<DashboardConfigAction> = {
			label: `Sort mode: ${formatMenuSortMode(sortMode)}`,
			hint: "Applies when smart sort is enabled.",
			value: { type: "cycle-sort-mode" },
			color: sortMode === "ready-first" ? "green" : "yellow",
		};
		const layoutMode = resolveMenuLayoutMode(draft);
		const layoutModeItem: MenuItem<DashboardConfigAction> = {
			label: `Layout: ${formatMenuLayoutMode(layoutMode)}`,
			hint: "Compact shows one-line rows with a selected details pane.",
			value: { type: "cycle-layout-mode" },
			color: layoutMode === "compact-details" ? "green" : "yellow",
		};
		const items: MenuItem<DashboardConfigAction>[] = [
			{
				label: UI_COPY.settings.previewHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "cancel" },
				color: "green",
				disabled: true,
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.displayHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			...optionItems,
			sortModeItem,
			layoutModeItem,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: UI_COPY.settings.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: UI_COPY.settings.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];
		const initialCursor = items.findIndex(
			(item) =>
				(item.value.type === "toggle" && item.value.key === focusKey) ||
				(item.value.type === "cycle-sort-mode" &&
					focusKey === "menuSortMode") ||
				(item.value.type === "cycle-layout-mode" &&
					focusKey === "menuLayoutMode"),
		);

		const updateFocusedPreview = (cursor: number) => {
			const focusedItem = items[cursor];
			const focusedKey =
				focusedItem?.value.type === "toggle"
					? focusedItem.value.key
					: focusedItem?.value.type === "cycle-sort-mode"
						? "menuSortMode"
						: focusedItem?.value.type === "cycle-layout-mode"
							? "menuLayoutMode"
							: focusKey;
			const nextPreview = buildAccountListPreview(draft, ui, focusedKey);
			const previewItem = items[1];
			if (!previewItem) return;
			previewItem.label = nextPreview.label;
			previewItem.hint = nextPreview.hint;
		};

		const result = await select<DashboardConfigAction>(items, {
			message: UI_COPY.settings.accountListTitle,
			subtitle: UI_COPY.settings.accountListSubtitle,
			help: UI_COPY.settings.accountListHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (focusedItem?.value.type === "toggle") {
					focusKey = focusedItem.value.key;
				} else if (focusedItem?.value.type === "cycle-sort-mode") {
					focusKey = "menuSortMode";
				} else if (focusedItem?.value.type === "cycle-layout-mode") {
					focusKey = "menuLayoutMode";
				}
				updateFocusedPreview(cursor);
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				if (lower === "m") return { type: "cycle-sort-mode" };
				if (lower === "l") return { type: "cycle-layout-mode" };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= DASHBOARD_DISPLAY_OPTIONS.length
				) {
					const target = DASHBOARD_DISPLAY_OPTIONS[parsed - 1];
					if (target) {
						return { type: "toggle", key: target.key };
					}
				}
				if (parsed === DASHBOARD_DISPLAY_OPTIONS.length + 1) {
					return { type: "cycle-sort-mode" };
				}
				if (parsed === DASHBOARD_DISPLAY_OPTIONS.length + 2) {
					return { type: "cycle-layout-mode" };
				}
				return undefined;
			},
		});

		if (!result || result.type === "cancel") {
			return null;
		}
		if (result.type === "save") {
			return draft;
		}
		if (result.type === "reset") {
			draft = applyDashboardDefaultsForKeys(draft, ACCOUNT_LIST_PANEL_KEYS);
			focusKey = DASHBOARD_DISPLAY_OPTIONS[0]?.key ?? focusKey;
			continue;
		}
		if (result.type === "cycle-sort-mode") {
			const currentMode =
				draft.menuSortMode ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
				"ready-first";
			const nextMode: DashboardAccountSortMode =
				currentMode === "ready-first" ? "manual" : "ready-first";
			draft = {
				...draft,
				menuSortMode: nextMode,
				menuSortEnabled:
					nextMode === "ready-first"
						? true
						: (draft.menuSortEnabled ??
							DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
							true),
			};
			focusKey = "menuSortMode";
			continue;
		}
		if (result.type === "cycle-layout-mode") {
			const currentLayout = resolveMenuLayoutMode(draft);
			const nextLayout =
				currentLayout === "compact-details"
					? "expanded-rows"
					: "compact-details";
			draft = {
				...draft,
				menuLayoutMode: nextLayout,
				menuShowDetailsForUnselectedRows: nextLayout === "expanded-rows",
			};
			focusKey = "menuLayoutMode";
			continue;
		}
		focusKey = result.key;
		draft = {
			...draft,
			[result.key]: !draft[result.key],
		};
	}
}

async function configureDashboardDisplaySettings(
	currentSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	const current = currentSettings ?? (await loadDashboardDisplaySettings());
	if (!input.isTTY || !output.isTTY) {
		console.log("Settings require interactive mode.");
		console.log(`Settings file: ${getDashboardSettingsPath()}`);
		return current;
	}

	const selected = await promptDashboardDisplaySettings(current);
	if (!selected) return current;
	if (dashboardSettingsEqual(current, selected)) return current;

	const merged = await persistDashboardSettingsSelection(
		selected,
		ACCOUNT_LIST_PANEL_KEYS,
		"account-list",
	);
	applyUiThemeFromDashboardSettings(merged);
	return merged;
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

async function promptStatuslineSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	if (!input.isTTY || !output.isTTY) {
		return null;
	}

	const ui = getUiRuntimeOptions();
	let draft = cloneDashboardSettings(initial);
	let focusKey: DashboardStatuslineField =
		draft.menuStatuslineFields?.[0] ?? "last-used";
	while (true) {
		const preview = buildAccountListPreview(draft, ui, focusKey);
		const selectedSet = new Set(
			normalizeStatuslineFields(draft.menuStatuslineFields),
		);
		const ordered = normalizeStatuslineFields(draft.menuStatuslineFields);
		const orderMap = new Map<DashboardStatuslineField, number>();
		for (let index = 0; index < ordered.length; index += 1) {
			const key = ordered[index];
			if (key) orderMap.set(key, index + 1);
		}

		const optionItems: MenuItem<StatuslineConfigAction>[] =
			STATUSLINE_FIELD_OPTIONS.map((option, index) => {
				const enabled = selectedSet.has(option.key);
				const rank = orderMap.get(option.key);
				const label = `${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}${rank ? ` (order ${rank})` : ""}`;
				return {
					label,
					hint: option.description,
					value: { type: "toggle", key: option.key },
					color: enabled ? "green" : "yellow",
				};
			});

		const items: MenuItem<StatuslineConfigAction>[] = [
			{
				label: UI_COPY.settings.previewHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "cancel" },
				color: "green",
				disabled: true,
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.displayHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			...optionItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.moveUp,
				value: { type: "move-up", key: focusKey },
				color: "green",
			},
			{
				label: UI_COPY.settings.moveDown,
				value: { type: "move-down", key: focusKey },
				color: "green",
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: UI_COPY.settings.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: UI_COPY.settings.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];

		const initialCursor = items.findIndex(
			(item) => item.value.type === "toggle" && item.value.key === focusKey,
		);

		const updateFocusedPreview = (cursor: number) => {
			const focusedItem = items[cursor];
			const focusedKey =
				focusedItem?.value.type === "toggle" ? focusedItem.value.key : focusKey;
			const nextPreview = buildAccountListPreview(draft, ui, focusedKey);
			const previewItem = items[1];
			if (!previewItem) return;
			previewItem.label = nextPreview.label;
			previewItem.hint = nextPreview.hint;
		};

		const result = await select<StatuslineConfigAction>(items, {
			message: UI_COPY.settings.summaryTitle,
			subtitle: UI_COPY.settings.summarySubtitle,
			help: UI_COPY.settings.summaryHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (focusedItem?.value.type === "toggle") {
					focusKey = focusedItem.value.key;
				}
				updateFocusedPreview(cursor);
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				if (lower === "[") return { type: "move-up", key: focusKey };
				if (lower === "]") return { type: "move-down", key: focusKey };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= STATUSLINE_FIELD_OPTIONS.length
				) {
					const target = STATUSLINE_FIELD_OPTIONS[parsed - 1];
					if (target) {
						return { type: "toggle", key: target.key };
					}
				}
				return undefined;
			},
		});

		if (!result || result.type === "cancel") {
			return null;
		}
		if (result.type === "save") {
			return draft;
		}
		if (result.type === "reset") {
			draft = applyDashboardDefaultsForKeys(draft, STATUSLINE_PANEL_KEYS);
			focusKey = draft.menuStatuslineFields?.[0] ?? "last-used";
			continue;
		}
		if (result.type === "move-up") {
			draft = {
				...draft,
				menuStatuslineFields: reorderField(
					normalizeStatuslineFields(draft.menuStatuslineFields),
					result.key,
					-1,
				),
			};
			focusKey = result.key;
			continue;
		}
		if (result.type === "move-down") {
			draft = {
				...draft,
				menuStatuslineFields: reorderField(
					normalizeStatuslineFields(draft.menuStatuslineFields),
					result.key,
					1,
				),
			};
			focusKey = result.key;
			continue;
		}

		focusKey = result.key;
		const fields = normalizeStatuslineFields(draft.menuStatuslineFields);
		const isEnabled = fields.includes(result.key);
		if (isEnabled) {
			const next = fields.filter((field) => field !== result.key);
			draft = {
				...draft,
				menuStatuslineFields: next.length > 0 ? next : [result.key],
			};
		} else {
			draft = {
				...draft,
				menuStatuslineFields: [...fields, result.key],
			};
		}
	}
}

async function configureStatuslineSettings(
	currentSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	const current = currentSettings ?? (await loadDashboardDisplaySettings());
	if (!input.isTTY || !output.isTTY) {
		console.log("Settings require interactive mode.");
		console.log(`Settings file: ${getDashboardSettingsPath()}`);
		return current;
	}

	const selected = await promptStatuslineSettings(current);
	if (!selected) return current;
	if (dashboardSettingsEqual(current, selected)) return current;

	const merged = await persistDashboardSettingsSelection(
		selected,
		STATUSLINE_PANEL_KEYS,
		"summary-fields",
	);
	applyUiThemeFromDashboardSettings(merged);
	return merged;
}

function formatDelayLabel(delayMs: number): string {
	return delayMs <= 0
		? "Instant return"
		: `${Math.round(delayMs / 1000)}s auto-return`;
}

async function promptBehaviorSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	if (!input.isTTY || !output.isTTY) return null;
	const ui = getUiRuntimeOptions();
	let draft = cloneDashboardSettings(initial);
	let focus: BehaviorConfigAction = {
		type: "set-delay",
		delayMs: draft.actionAutoReturnMs ?? 2_000,
	};

	while (true) {
		const currentDelay = draft.actionAutoReturnMs ?? 2_000;
		const pauseOnKey = draft.actionPauseOnKey ?? true;
		const autoFetchLimits = draft.menuAutoFetchLimits ?? true;
		const fetchStatusVisible = draft.menuShowFetchStatus ?? true;
		const menuQuotaTtlMs = draft.menuQuotaTtlMs ?? 5 * 60_000;
		const delayItems: MenuItem<BehaviorConfigAction>[] =
			AUTO_RETURN_OPTIONS_MS.map((delayMs) => {
				const color: MenuItem<BehaviorConfigAction>["color"] =
					currentDelay === delayMs ? "green" : "yellow";
				return {
					label: `${currentDelay === delayMs ? "[x]" : "[ ]"} ${formatDelayLabel(delayMs)}`,
					hint:
						delayMs === 1_000
							? "Fastest loop for frequent actions."
							: delayMs === 2_000
								? "Balanced default for most users."
								: "More time to read action output.",
					value: { type: "set-delay", delayMs },
					color,
				};
			});
		const pauseColor: MenuItem<BehaviorConfigAction>["color"] = pauseOnKey
			? "green"
			: "yellow";
		const items: MenuItem<BehaviorConfigAction>[] = [
			{
				label: UI_COPY.settings.actionTiming,
				value: { type: "cancel" },
				kind: "heading",
			},
			...delayItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: `${pauseOnKey ? "[x]" : "[ ]"} Pause on key press`,
				hint: "Press any key to stop auto-return.",
				value: { type: "toggle-pause" },
				color: pauseColor,
			},
			{
				label: `${autoFetchLimits ? "[x]" : "[ ]"} Auto-fetch limits on menu open (5m cache)`,
				hint: "Refreshes account limits automatically when opening the menu.",
				value: { type: "toggle-menu-limit-fetch" },
				color: autoFetchLimits ? "green" : "yellow",
			},
			{
				label: `${fetchStatusVisible ? "[x]" : "[ ]"} Show limit refresh status`,
				hint: "Shows background fetch progress like [2/7] in menu subtitle.",
				value: { type: "toggle-menu-fetch-status" },
				color: fetchStatusVisible ? "green" : "yellow",
			},
			{
				label: `Limit cache TTL: ${formatMenuQuotaTtl(menuQuotaTtlMs)}`,
				hint: "How fresh cached quota data must be before refresh runs.",
				value: { type: "set-menu-quota-ttl", ttlMs: menuQuotaTtlMs },
				color: "yellow",
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: UI_COPY.settings.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: UI_COPY.settings.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];
		const initialCursor = items.findIndex((item) => {
			const value = item.value;
			if (value.type !== focus.type) return false;
			if (value.type === "set-delay" && focus.type === "set-delay") {
				return value.delayMs === focus.delayMs;
			}
			return true;
		});

		const result = await select<BehaviorConfigAction>(items, {
			message: UI_COPY.settings.behaviorTitle,
			subtitle: UI_COPY.settings.behaviorSubtitle,
			help: UI_COPY.settings.behaviorHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const item = items[cursor];
				if (item && !item.separator && item.kind !== "heading") {
					focus = item.value;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				if (lower === "p") return { type: "toggle-pause" };
				if (lower === "l") return { type: "toggle-menu-limit-fetch" };
				if (lower === "f") return { type: "toggle-menu-fetch-status" };
				if (lower === "t")
					return { type: "set-menu-quota-ttl", ttlMs: menuQuotaTtlMs };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= AUTO_RETURN_OPTIONS_MS.length
				) {
					const delayMs = AUTO_RETURN_OPTIONS_MS[parsed - 1];
					if (typeof delayMs === "number")
						return { type: "set-delay", delayMs };
				}
				return undefined;
			},
		});

		if (!result || result.type === "cancel") return null;
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = applyDashboardDefaultsForKeys(draft, BEHAVIOR_PANEL_KEYS);
			focus = { type: "set-delay", delayMs: draft.actionAutoReturnMs ?? 2_000 };
			continue;
		}
		if (result.type === "toggle-pause") {
			draft = {
				...draft,
				actionPauseOnKey: !(draft.actionPauseOnKey ?? true),
			};
			focus = result;
			continue;
		}
		if (result.type === "toggle-menu-limit-fetch") {
			draft = {
				...draft,
				menuAutoFetchLimits: !(draft.menuAutoFetchLimits ?? true),
			};
			focus = result;
			continue;
		}
		if (result.type === "toggle-menu-fetch-status") {
			draft = {
				...draft,
				menuShowFetchStatus: !(draft.menuShowFetchStatus ?? true),
			};
			focus = result;
			continue;
		}
		if (result.type === "set-menu-quota-ttl") {
			const currentIndex = MENU_QUOTA_TTL_OPTIONS_MS.findIndex(
				(value) => value === menuQuotaTtlMs,
			);
			const nextIndex =
				currentIndex < 0
					? 0
					: (currentIndex + 1) % MENU_QUOTA_TTL_OPTIONS_MS.length;
			const nextTtl =
				MENU_QUOTA_TTL_OPTIONS_MS[nextIndex] ??
				MENU_QUOTA_TTL_OPTIONS_MS[0] ??
				menuQuotaTtlMs;
			draft = {
				...draft,
				menuQuotaTtlMs: nextTtl,
			};
			focus = { type: "set-menu-quota-ttl", ttlMs: nextTtl };
			continue;
		}
		draft = {
			...draft,
			actionAutoReturnMs: result.delayMs,
		};
		focus = result;
	}
}

async function promptThemeSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	if (!input.isTTY || !output.isTTY) return null;
	const baseline = cloneDashboardSettings(initial);
	let draft = cloneDashboardSettings(initial);
	let focus: ThemeConfigAction = {
		type: "set-palette",
		palette: draft.uiThemePreset ?? "green",
	};
	while (true) {
		const ui = getUiRuntimeOptions();
		const palette = draft.uiThemePreset ?? "green";
		const accent = draft.uiAccentColor ?? "green";
		const paletteItems: MenuItem<ThemeConfigAction>[] =
			THEME_PRESET_OPTIONS.map((candidate, index) => {
				const color: MenuItem<ThemeConfigAction>["color"] =
					palette === candidate ? "green" : "yellow";
				return {
					label: `${palette === candidate ? "[x]" : "[ ]"} ${index + 1}. ${candidate === "green" ? "Green base" : "Blue base"}`,
					hint:
						candidate === "green"
							? "High-contrast default."
							: "Codex-style blue look.",
					value: { type: "set-palette", palette: candidate },
					color,
				};
			});
		const accentItems: MenuItem<ThemeConfigAction>[] = ACCENT_COLOR_OPTIONS.map(
			(candidate) => {
				const color: MenuItem<ThemeConfigAction>["color"] =
					accent === candidate ? "green" : "yellow";
				return {
					label: `${accent === candidate ? "[x]" : "[ ]"} ${candidate}`,
					value: { type: "set-accent", accent: candidate },
					color,
				};
			},
		);
		const items: MenuItem<ThemeConfigAction>[] = [
			{
				label: UI_COPY.settings.baseTheme,
				value: { type: "cancel" },
				kind: "heading",
			},
			...paletteItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.accentColor,
				value: { type: "cancel" },
				kind: "heading",
			},
			...accentItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: UI_COPY.settings.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: UI_COPY.settings.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];
		const initialCursor = items.findIndex((item) => {
			const value = item.value;
			if (value.type !== focus.type) return false;
			if (value.type === "set-palette" && focus.type === "set-palette") {
				return value.palette === focus.palette;
			}
			if (value.type === "set-accent" && focus.type === "set-accent") {
				return value.accent === focus.accent;
			}
			return true;
		});
		const result = await select<ThemeConfigAction>(items, {
			message: UI_COPY.settings.themeTitle,
			subtitle: UI_COPY.settings.themeSubtitle,
			help: UI_COPY.settings.themeHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const item = items[cursor];
				if (item && !item.separator && item.kind !== "heading") {
					focus = item.value;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				if (raw === "1") return { type: "set-palette", palette: "green" };
				if (raw === "2") return { type: "set-palette", palette: "blue" };
				return undefined;
			},
		});
		if (!result || result.type === "cancel") {
			applyUiThemeFromDashboardSettings(baseline);
			return null;
		}
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = applyDashboardDefaultsForKeys(draft, THEME_PANEL_KEYS);
			focus = { type: "set-palette", palette: draft.uiThemePreset ?? "green" };
			applyUiThemeFromDashboardSettings(draft);
			continue;
		}
		if (result.type === "set-palette") {
			draft = { ...draft, uiThemePreset: result.palette };
			focus = result;
			applyUiThemeFromDashboardSettings(draft);
			continue;
		}
		draft = { ...draft, uiAccentColor: result.accent };
		focus = result;
		applyUiThemeFromDashboardSettings(draft);
	}
}

function resolveFocusedBackendNumberKey(
	focus: BackendSettingFocusKey,
	numberOptions: BackendNumberSettingOption[] = BACKEND_NUMBER_OPTIONS,
): BackendNumberSettingKey {
	const numberKeys = new Set<BackendNumberSettingKey>(
		numberOptions.map((option) => option.key),
	);
	if (focus && numberKeys.has(focus as BackendNumberSettingKey)) {
		return focus as BackendNumberSettingKey;
	}
	return numberOptions[0]?.key ?? "fetchTimeoutMs";
}

function getBackendCategory(
	key: BackendCategoryKey,
): BackendCategoryOption | null {
	return (
		BACKEND_CATEGORY_OPTIONS.find((category) => category.key === key) ?? null
	);
}

function getBackendCategoryInitialFocus(
	category: BackendCategoryOption,
): BackendSettingFocusKey {
	const firstToggle = category.toggleKeys[0];
	if (firstToggle) return firstToggle;
	return category.numberKeys[0] ?? null;
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

async function promptBackendCategorySettings(
	initial: PluginConfig,
	category: BackendCategoryOption,
	initialFocus: BackendSettingFocusKey,
): Promise<{ draft: PluginConfig; focusKey: BackendSettingFocusKey }> {
	const ui = getUiRuntimeOptions();
	let draft = cloneBackendPluginConfig(initial);
	let focusKey: BackendSettingFocusKey = initialFocus;
	if (
		!focusKey ||
		(!category.toggleKeys.includes(focusKey as BackendToggleSettingKey) &&
			!category.numberKeys.includes(focusKey as BackendNumberSettingKey))
	) {
		focusKey = getBackendCategoryInitialFocus(category);
	}

	const toggleOptions = category.toggleKeys
		.map((key) => BACKEND_TOGGLE_OPTION_BY_KEY.get(key))
		.filter((option): option is BackendToggleSettingOption => !!option);
	const numberOptions = category.numberKeys
		.map((key) => BACKEND_NUMBER_OPTION_BY_KEY.get(key))
		.filter((option): option is BackendNumberSettingOption => !!option);

	while (true) {
		const preview = buildBackendSettingsPreview(draft, ui, focusKey);
		const toggleItems: MenuItem<BackendCategoryConfigAction>[] =
			toggleOptions.map((option, index) => {
				const enabled =
					draft[option.key] ?? BACKEND_DEFAULTS[option.key] ?? false;
				return {
					label: `${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}`,
					hint: option.description,
					value: { type: "toggle", key: option.key },
					color: enabled ? "green" : "yellow",
				};
			});
		const numberItems: MenuItem<BackendCategoryConfigAction>[] =
			numberOptions.map((option) => {
				const rawValue =
					draft[option.key] ?? BACKEND_DEFAULTS[option.key] ?? option.min;
				const numericValue =
					typeof rawValue === "number" && Number.isFinite(rawValue)
						? rawValue
						: option.min;
				const clampedValue = clampBackendNumber(option, numericValue);
				const valueLabel = formatBackendNumberValue(option, clampedValue);
				return {
					label: `${option.label}: ${valueLabel}`,
					hint: `${option.description} Step ${formatBackendNumberValue(option, option.step)}.`,
					value: { type: "bump", key: option.key, direction: 1 },
					color: "yellow",
				};
			});

		const focusedNumberKey = resolveFocusedBackendNumberKey(
			focusKey,
			numberOptions,
		);
		const items: MenuItem<BackendCategoryConfigAction>[] = [
			{
				label: UI_COPY.settings.previewHeading,
				value: { type: "back" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "back" },
				disabled: true,
				color: "green",
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "back" }, separator: true },
			{
				label: UI_COPY.settings.backendToggleHeading,
				value: { type: "back" },
				kind: "heading",
			},
			...toggleItems,
			{ label: "", value: { type: "back" }, separator: true },
			{
				label: UI_COPY.settings.backendNumberHeading,
				value: { type: "back" },
				kind: "heading",
			},
			...numberItems,
		];

		if (numberOptions.length > 0) {
			items.push({ label: "", value: { type: "back" }, separator: true });
			items.push({
				label: UI_COPY.settings.backendDecrease,
				value: { type: "bump", key: focusedNumberKey, direction: -1 },
				color: "yellow",
			});
			items.push({
				label: UI_COPY.settings.backendIncrease,
				value: { type: "bump", key: focusedNumberKey, direction: 1 },
				color: "green",
			});
		}

		items.push({ label: "", value: { type: "back" }, separator: true });
		items.push({
			label: UI_COPY.settings.backendResetCategory,
			value: { type: "reset-category" },
			color: "yellow",
		});
		items.push({
			label: UI_COPY.settings.backendBackToCategories,
			value: { type: "back" },
			color: "red",
		});

		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading")
				return false;
			if (item.value.type === "toggle" && focusKey === item.value.key)
				return true;
			if (item.value.type === "bump" && focusKey === item.value.key)
				return true;
			return false;
		});

		const result = await select<BackendCategoryConfigAction>(items, {
			message: `${UI_COPY.settings.backendCategoryTitle}: ${category.label}`,
			subtitle: category.description,
			help: UI_COPY.settings.backendCategoryHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (
					focusedItem?.value.type === "toggle" ||
					focusedItem?.value.type === "bump"
				) {
					focusKey = focusedItem.value.key;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "back" };
				if (lower === "r") return { type: "reset-category" };
				if (
					numberOptions.length > 0 &&
					(lower === "+" || lower === "=" || lower === "]" || lower === "d")
				) {
					return {
						type: "bump",
						key: resolveFocusedBackendNumberKey(focusKey, numberOptions),
						direction: 1,
					};
				}
				if (
					numberOptions.length > 0 &&
					(lower === "-" || lower === "[" || lower === "a")
				) {
					return {
						type: "bump",
						key: resolveFocusedBackendNumberKey(focusKey, numberOptions),
						direction: -1,
					};
				}
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= toggleOptions.length
				) {
					const target = toggleOptions[parsed - 1];
					if (target) return { type: "toggle", key: target.key };
				}
				return undefined;
			},
		});

		if (!result || result.type === "back") {
			return { draft, focusKey };
		}
		if (result.type === "reset-category") {
			draft = applyBackendCategoryDefaults(draft, category);
			focusKey = getBackendCategoryInitialFocus(category);
			continue;
		}
		if (result.type === "toggle") {
			const currentValue =
				draft[result.key] ?? BACKEND_DEFAULTS[result.key] ?? false;
			draft = { ...draft, [result.key]: !currentValue };
			focusKey = result.key;
			continue;
		}

		const option = BACKEND_NUMBER_OPTION_BY_KEY.get(result.key);
		if (!option) continue;
		const currentValue =
			draft[result.key] ?? BACKEND_DEFAULTS[result.key] ?? option.min;
		const numericCurrent =
			typeof currentValue === "number" && Number.isFinite(currentValue)
				? currentValue
				: option.min;
		draft = {
			...draft,
			[result.key]: clampBackendNumber(
				option,
				numericCurrent + option.step * result.direction,
			),
		};
		focusKey = result.key;
	}
}

async function promptBackendSettings(
	initial: PluginConfig,
): Promise<PluginConfig | null> {
	if (!input.isTTY || !output.isTTY) return null;

	const ui = getUiRuntimeOptions();
	let draft = cloneBackendPluginConfig(initial);
	let activeCategory = BACKEND_CATEGORY_OPTIONS[0]?.key ?? "session-sync";
	const focusByCategory: Partial<
		Record<BackendCategoryKey, BackendSettingFocusKey>
	> = {};
	for (const category of BACKEND_CATEGORY_OPTIONS) {
		focusByCategory[category.key] = getBackendCategoryInitialFocus(category);
	}

	while (true) {
		const previewFocus = focusByCategory[activeCategory] ?? null;
		const preview = buildBackendSettingsPreview(draft, ui, previewFocus);
		const categoryItems: MenuItem<BackendSettingsHubAction>[] =
			BACKEND_CATEGORY_OPTIONS.map((category, index) => {
				return {
					label: `${index + 1}. ${category.label}`,
					hint: category.description,
					value: { type: "open-category", key: category.key },
					color: "green",
				};
			});

		const items: MenuItem<BackendSettingsHubAction>[] = [
			{
				label: UI_COPY.settings.previewHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "cancel" },
				disabled: true,
				color: "green",
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.backendCategoriesHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			...categoryItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: UI_COPY.settings.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: UI_COPY.settings.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];

		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading")
				return false;
			return (
				item.value.type === "open-category" && item.value.key === activeCategory
			);
		});

		const result = await select<BackendSettingsHubAction>(items, {
			message: UI_COPY.settings.backendTitle,
			subtitle: UI_COPY.settings.backendSubtitle,
			help: UI_COPY.settings.backendHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (focusedItem?.value.type === "open-category") {
					activeCategory = focusedItem.value.key;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= BACKEND_CATEGORY_OPTIONS.length
				) {
					const target = BACKEND_CATEGORY_OPTIONS[parsed - 1];
					if (target) return { type: "open-category", key: target.key };
				}
				return undefined;
			},
		});

		if (!result || result.type === "cancel") return null;
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = cloneBackendPluginConfig(BACKEND_DEFAULTS);
			for (const category of BACKEND_CATEGORY_OPTIONS) {
				focusByCategory[category.key] =
					getBackendCategoryInitialFocus(category);
			}
			activeCategory = BACKEND_CATEGORY_OPTIONS[0]?.key ?? activeCategory;
			continue;
		}

		const category = getBackendCategory(result.key);
		if (!category) continue;
		activeCategory = category.key;
		const categoryResult = await promptBackendCategorySettings(
			draft,
			category,
			focusByCategory[category.key] ?? getBackendCategoryInitialFocus(category),
		);
		draft = categoryResult.draft;
		focusByCategory[category.key] = categoryResult.focusKey;
	}
}

async function promptSyncCenter(config: PluginConfig): Promise<void> {
	if (!input.isTTY || !output.isTTY) return;
	const ui = getUiRuntimeOptions();
	const buildPreview = async (
		forceRefresh = false,
	): Promise<{
		preview: CodexCliSyncPreview;
		context: SyncCenterOverviewContext;
	}> => {
		const current = await loadAccounts();
		const state = await loadCodexCliState({ forceRefresh });
		const preview = await previewCodexCliSync(current, {
			forceRefresh,
			storageBackupEnabled: getStorageBackupEnabled(config),
		});
		return {
			preview,
			context: resolveSyncCenterContext(state),
		};
	};

	let { preview, context } = await buildPreview(true);
	while (true) {
		const overview = buildSyncCenterOverview(preview, context);
		const items: MenuItem<SyncCenterAction>[] = [
			{
				label: UI_COPY.settings.syncCenterOverviewHeading,
				value: { type: "back" },
				kind: "heading",
			},
			...overview.map((item) => ({
				label: item.label,
				hint: item.hint,
				value: { type: "back" } as SyncCenterAction,
				disabled: true,
				color: "green" as const,
				hideUnavailableSuffix: true,
			})),
			{ label: "", value: { type: "back" }, separator: true },
			{
				label: UI_COPY.settings.syncCenterActionsHeading,
				value: { type: "back" },
				kind: "heading",
			},
			{
				label: UI_COPY.settings.syncCenterApply,
				hint: "Applies the current preview to the target storage path.",
				value: { type: "apply" },
				color: preview.status === "ready" ? "green" : "yellow",
				disabled: preview.status !== "ready",
			},
			{
				label: UI_COPY.settings.syncCenterRefresh,
				hint: "Re-read the source files and rebuild the sync preview.",
				value: { type: "refresh" },
				color: "yellow",
			},
			{
				label: UI_COPY.settings.syncCenterBack,
				value: { type: "back" },
				color: "red",
			},
		];

		const result = await select<SyncCenterAction>(items, {
			message: UI_COPY.settings.syncCenterTitle,
			subtitle: UI_COPY.settings.syncCenterSubtitle,
			help: UI_COPY.settings.syncCenterHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "back" };
				if (lower === "r") return { type: "refresh" };
				if (lower === "a") return { type: "apply" };
				return undefined;
			},
		});

		if (!result || result.type === "back") return;
		if (result.type === "refresh") {
			({ preview, context } = await buildPreview(true));
			continue;
		}

		try {
			const current = await loadAccounts();
			const synced = await syncAccountStorageFromCodexCli(current);
			if (synced.changed && synced.storage) {
				await saveAccounts(synced.storage);
			}
			const state = await loadCodexCliState({ forceRefresh: true });
			preview = await previewCodexCliSync(synced.storage ?? current, {
				forceRefresh: true,
				storageBackupEnabled: getStorageBackupEnabled(config),
			});
			context = resolveSyncCenterContext(state);
		} catch (error) {
			preview = {
				...preview,
				status: "error",
				statusDetail: error instanceof Error ? error.message : String(error),
			};
			context = resolveSyncCenterContext(null);
		}
	}
}

async function configureBackendSettings(
	currentConfig?: PluginConfig,
): Promise<PluginConfig> {
	const current = cloneBackendPluginConfig(currentConfig ?? loadPluginConfig());
	if (!input.isTTY || !output.isTTY) {
		console.log("Settings require interactive mode.");
		return current;
	}

	const selected = await promptBackendSettings(current);
	if (!selected) return current;
	if (backendSettingsEqual(current, selected)) return current;

	return persistBackendConfigSelection(selected, "backend");
}

async function promptSettingsHub(
	initialFocus: SettingsHubAction["type"] = "account-list",
): Promise<SettingsHubAction | null> {
	if (!input.isTTY || !output.isTTY) return null;
	const ui = getUiRuntimeOptions();
	const items: MenuItem<SettingsHubAction>[] = [
		{
			label: UI_COPY.settings.sectionTitle,
			value: { type: "back" },
			kind: "heading",
		},
		{
			label: UI_COPY.settings.accountList,
			hint: UI_COPY.settings.accountListHint,
			value: { type: "account-list" },
			color: "green",
		},
		{
			label: UI_COPY.settings.summaryFields,
			hint: UI_COPY.settings.summaryFieldsHint,
			value: { type: "summary-fields" },
			color: "green",
		},
		{
			label: UI_COPY.settings.behavior,
			hint: UI_COPY.settings.behaviorHint,
			value: { type: "behavior" },
			color: "green",
		},
		{
			label: UI_COPY.settings.theme,
			hint: UI_COPY.settings.themeHint,
			value: { type: "theme" },
			color: "green",
		},
		{ label: "", value: { type: "back" }, separator: true },
		{
			label: UI_COPY.settings.advancedTitle,
			value: { type: "back" },
			kind: "heading",
		},
		{
			label: UI_COPY.settings.syncCenter,
			hint: UI_COPY.settings.syncCenterHint,
			value: { type: "sync-center" },
			color: "yellow",
		},
		{
			label: UI_COPY.settings.backend,
			hint: UI_COPY.settings.backendHint,
			value: { type: "backend" },
			color: "yellow",
		},
		{ label: "", value: { type: "back" }, separator: true },
		{
			label: UI_COPY.settings.exitTitle,
			value: { type: "back" },
			kind: "heading",
		},
		{ label: UI_COPY.settings.back, value: { type: "back" }, color: "red" },
	];
	const initialCursor = items.findIndex((item) => {
		if (item.separator || item.disabled || item.kind === "heading")
			return false;
		return item.value.type === initialFocus;
	});
	return select<SettingsHubAction>(items, {
		message: UI_COPY.settings.title,
		subtitle: UI_COPY.settings.subtitle,
		help: UI_COPY.settings.help,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		initialCursor: initialCursor >= 0 ? initialCursor : undefined,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return { type: "back" };
			return undefined;
		},
	});
}

/* c8 ignore stop */

async function configureUnifiedSettings(
	initialSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	let current = cloneDashboardSettings(
		initialSettings ?? (await loadDashboardDisplaySettings()),
	);
	let backendConfig = cloneBackendPluginConfig(loadPluginConfig());
	applyUiThemeFromDashboardSettings(current);
	let hubFocus: SettingsHubAction["type"] = "account-list";
	while (true) {
		const action = await promptSettingsHub(hubFocus);
		if (!action || action.type === "back") {
			return current;
		}
		hubFocus = action.type;
		if (action.type === "account-list") {
			current = await configureDashboardDisplaySettings(current);
			continue;
		}
		if (action.type === "sync-center") {
			await promptSyncCenter(backendConfig);
			continue;
		}
		if (action.type === "summary-fields") {
			current = await configureStatuslineSettings(current);
			continue;
		}
		if (action.type === "behavior") {
			const selected = await promptBehaviorSettings(current);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(
					selected,
					BEHAVIOR_PANEL_KEYS,
					"behavior",
				);
			}
			continue;
		}
		if (action.type === "theme") {
			const selected = await promptThemeSettings(current);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(
					selected,
					THEME_PANEL_KEYS,
					"theme",
				);
				applyUiThemeFromDashboardSettings(current);
			}
			continue;
		}
		if (action.type === "backend") {
			backendConfig = await configureBackendSettings(backendConfig);
		}
	}
}

export {
	configureUnifiedSettings,
	applyUiThemeFromDashboardSettings,
	resolveMenuLayoutMode,
	__testOnly,
};
