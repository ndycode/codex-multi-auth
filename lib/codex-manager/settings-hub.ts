import { stdin as input, stdout as output } from "node:process";
import { loadPluginConfig, savePluginConfig } from "../config.js";
import {
	type DashboardAccentColor,
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
	type DashboardThemePreset,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	getDashboardSettingsPath,
	loadDashboardDisplaySettings,
	saveDashboardDisplaySettings,
} from "../dashboard-settings.js";
import {
	applyOcChatgptSync,
	planOcChatgptSync,
	runNamedBackupExport,
} from "../oc-chatgpt-orchestrator.js";
import { detectOcChatgptMultiAuthTarget } from "../oc-chatgpt-target-detection.js";
import { loadAccounts, normalizeAccountStorage } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { UI_COPY } from "../ui/copy.js";
import { getUiRuntimeOptions, setUiRuntimeOptions } from "../ui/runtime.js";
import { select } from "../ui/select.js";
import { sleep } from "../utils.js";
import {
	applyBackendCategoryDefaults,
	getBackendCategory,
	getBackendCategoryInitialFocus,
	resolveFocusedBackendNumberKey,
} from "./backend-category-helpers.js";
import { promptBackendCategorySettingsMenu } from "./backend-category-prompt.js";
import { configureBackendSettingsController } from "./backend-settings-controller.js";
import { configureBackendSettingsEntry } from "./backend-settings-entry.js";
import {
	backendSettingsEqual,
	buildBackendConfigPatch,
	buildBackendSettingsPreview,
	clampBackendNumberForTests,
	cloneBackendPluginConfig,
	formatBackendNumberValue,
} from "./backend-settings-helpers.js";
import { promptBackendSettingsMenu } from "./backend-settings-prompt.js";
import {
	BACKEND_CATEGORY_OPTIONS,
	BACKEND_DEFAULTS,
	BACKEND_NUMBER_OPTION_BY_KEY,
	BACKEND_TOGGLE_OPTION_BY_KEY,
	type BackendCategoryOption,
	type BackendNumberSettingOption,
	type BackendSettingFocusKey,
} from "./backend-settings-schema.js";
import { promptBehaviorSettingsPanel } from "./behavior-settings-panel.js";
import { promptDashboardDisplayPanel } from "./dashboard-display-panel.js";
import {
	formatDashboardSettingState,
	formatMenuLayoutMode,
	formatMenuQuotaTtl,
	formatMenuSortMode,
} from "./dashboard-formatters.js";
import { configureDashboardSettingsController } from "./dashboard-settings-controller.js";
import {
	cloneDashboardSettingsData,
	dashboardSettingsDataEqual,
} from "./dashboard-settings-data.js";
import { configureDashboardSettingsEntry } from "./dashboard-settings-entry.js";
import { promptExperimentalSettingsMenu } from "./experimental-settings-prompt.js";
import {
	getExperimentalSelectOptions,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
} from "./experimental-settings-schema.js";
import { loadExperimentalSyncTargetState } from "./experimental-sync-target.js";
import {
	buildSettingsHubItems,
	findSettingsHubInitialCursor,
} from "./settings-hub-menu.js";
import { promptSettingsHubMenu } from "./settings-hub-prompt.js";
import {
	readFileWithRetry,
	resolvePluginConfigSavePathKey,
	warnPersistFailure,
} from "./settings-persist-utils.js";
import {
	buildAccountListPreview as buildAccountListPreviewBase,
	buildSummaryPreviewText as buildSummaryPreviewTextBase,
	highlightPreviewToken,
	normalizeStatuslineFields,
} from "./settings-preview.js";
import { withQueuedRetry } from "./settings-write-queue.js";
import { promptStatuslineSettingsPanel } from "./statusline-settings-panel.js";
import { promptThemeSettingsPanel } from "./theme-settings-panel.js";
import {
	configureUnifiedSettingsController,
	type SettingsHubActionType,
} from "./unified-settings-controller.js";

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

type SettingsHubAction =
	| { type: "account-list" }
	| { type: "summary-fields" }
	| { type: "behavior" }
	| { type: "theme" }
	| { type: "experimental" }
	| { type: "backend" }
	| { type: "back" };

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

async function persistDashboardSettingsSelection(
	selected: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
	scope: string,
): Promise<DashboardDisplaySettings> {
	const fallback = cloneDashboardSettings(selected);
	try {
		return await withQueuedRetry(
			getDashboardSettingsPath(),
			async () => {
				const latest = cloneDashboardSettings(
					await loadDashboardDisplaySettings(),
				);
				const merged = mergeDashboardSettingsForKeys(latest, selected, keys);
				await saveDashboardDisplaySettings(merged);
				return merged;
			},
			{ sleep },
		);
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
		await withQueuedRetry(
			resolvePluginConfigSavePathKey(),
			async () => {
				await savePluginConfig(buildBackendConfigPatch(selected));
			},
			{ sleep },
		);
		return fallback;
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}

function cloneDashboardSettings(
	settings: DashboardDisplaySettings,
): DashboardDisplaySettings {
	return cloneDashboardSettingsData(settings, {
		resolveMenuLayoutMode,
		normalizeStatuslineFields,
	});
}

function dashboardSettingsEqual(
	left: DashboardDisplaySettings,
	right: DashboardDisplaySettings,
): boolean {
	return dashboardSettingsDataEqual(left, right, {
		resolveMenuLayoutMode,
		normalizeStatuslineFields,
	});
}

function buildSummaryPreviewText(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus:
		| DashboardDisplaySettingKey
		| DashboardStatuslineField
		| "menuSortMode"
		| "menuLayoutMode"
		| null = null,
): string {
	return buildSummaryPreviewTextBase(
		settings,
		ui,
		resolveMenuLayoutMode,
		focus,
	);
}

function buildAccountListPreview(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus:
		| DashboardDisplaySettingKey
		| DashboardStatuslineField
		| "menuSortMode"
		| "menuLayoutMode"
		| null = null,
): { label: string; hint: string } {
	return buildAccountListPreviewBase(
		settings,
		ui,
		resolveMenuLayoutMode,
		focus,
	);
}

function clampBackendNumber(
	option: BackendNumberSettingOption,
	value: number,
): number {
	return Math.max(option.min, Math.min(option.max, Math.round(value)));
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

async function withQueuedRetryForTests<T>(
	pathKey: string,
	task: () => Promise<T>,
): Promise<T> {
	return withQueuedRetry(pathKey, task, { sleep });
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
	withQueuedRetry: withQueuedRetryForTests,
	loadExperimentalSyncTarget,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
	promptExperimentalSettings,
	persistDashboardSettingsSelection: persistDashboardSettingsSelectionForTests,
	persistBackendConfigSelection: persistBackendConfigSelectionForTests,
	buildAccountListPreview,
	buildSummaryPreviewText,
	normalizeStatuslineFields,
	reorderField,
	promptDashboardDisplaySettings,
	promptStatuslineSettings,
	promptBehaviorSettings,
	promptThemeSettings,
	promptBackendSettings,
};

/* c8 ignore start - interactive prompt flows are covered by integration tests */
async function promptDashboardDisplaySettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptDashboardDisplayPanel(initial, {
		cloneDashboardSettings,
		buildAccountListPreview,
		formatDashboardSettingState,
		formatMenuSortMode,
		resolveMenuLayoutMode: (settings) =>
			resolveMenuLayoutMode(settings ?? DEFAULT_DASHBOARD_DISPLAY_SETTINGS),
		formatMenuLayoutMode,
		applyDashboardDefaultsForKeys,
		DASHBOARD_DISPLAY_OPTIONS,
		ACCOUNT_LIST_PANEL_KEYS,
		UI_COPY,
	});
}

async function configureDashboardDisplaySettings(
	currentSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	return configureDashboardSettingsEntry(currentSettings, {
		configureDashboardSettingsController,
		loadDashboardDisplaySettings,
		promptSettings: promptDashboardDisplaySettings,
		settingsEqual: dashboardSettingsEqual,
		persistSelection: (selected) =>
			persistDashboardSettingsSelection(
				selected,
				ACCOUNT_LIST_PANEL_KEYS,
				"account-list",
			),
		applyUiThemeFromDashboardSettings,
		isInteractive: () => input.isTTY && output.isTTY,
		getDashboardSettingsPath,
		writeLine: (message) => {
			console.log(message);
		},
	});
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
	return promptStatuslineSettingsPanel(initial, {
		cloneDashboardSettings,
		buildAccountListPreview,
		normalizeStatuslineFields,
		formatDashboardSettingState,
		reorderField,
		applyDashboardDefaultsForKeys,
		STATUSLINE_FIELD_OPTIONS,
		STATUSLINE_PANEL_KEYS,
		UI_COPY,
	});
}

async function configureStatuslineSettings(
	currentSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	return configureDashboardSettingsEntry(currentSettings, {
		configureDashboardSettingsController,
		loadDashboardDisplaySettings,
		promptSettings: promptStatuslineSettings,
		settingsEqual: dashboardSettingsEqual,
		persistSelection: (selected) =>
			persistDashboardSettingsSelection(
				selected,
				STATUSLINE_PANEL_KEYS,
				"summary-fields",
			),
		applyUiThemeFromDashboardSettings,
		isInteractive: () => input.isTTY && output.isTTY,
		getDashboardSettingsPath,
		writeLine: (message) => {
			console.log(message);
		},
	});
}

function formatDelayLabel(delayMs: number): string {
	return delayMs <= 0
		? "Instant return"
		: `${Math.round(delayMs / 1000)}s auto-return`;
}

async function promptBehaviorSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptBehaviorSettingsPanel(initial, {
		cloneDashboardSettings,
		applyDashboardDefaultsForKeys,
		formatDelayLabel,
		formatMenuQuotaTtl,
		AUTO_RETURN_OPTIONS_MS,
		MENU_QUOTA_TTL_OPTIONS_MS,
		BEHAVIOR_PANEL_KEYS,
		UI_COPY,
	});
}

async function promptThemeSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptThemeSettingsPanel(initial, {
		cloneDashboardSettings,
		applyDashboardDefaultsForKeys,
		applyUiThemeFromDashboardSettings,
		THEME_PRESET_OPTIONS,
		ACCENT_COLOR_OPTIONS,
		THEME_PANEL_KEYS,
		UI_COPY,
	});
}

async function promptBackendCategorySettings(
	initial: PluginConfig,
	category: BackendCategoryOption,
	initialFocus: BackendSettingFocusKey,
): Promise<{ draft: PluginConfig; focusKey: BackendSettingFocusKey }> {
	return promptBackendCategorySettingsMenu({
		initial,
		category,
		initialFocus,
		ui: getUiRuntimeOptions(),
		cloneBackendPluginConfig,
		buildBackendSettingsPreview,
		highlightPreviewToken,
		resolveFocusedBackendNumberKey,
		clampBackendNumber,
		formatBackendNumberValue,
		formatDashboardSettingState,
		applyBackendCategoryDefaults: (config, selectedCategory) =>
			applyBackendCategoryDefaults(config, selectedCategory, {
				backendDefaults: BACKEND_DEFAULTS,
				numberOptionByKey: BACKEND_NUMBER_OPTION_BY_KEY,
			}),
		getBackendCategoryInitialFocus,
		backendDefaults: BACKEND_DEFAULTS,
		toggleOptionByKey: BACKEND_TOGGLE_OPTION_BY_KEY,
		numberOptionByKey: BACKEND_NUMBER_OPTION_BY_KEY,
		select,
		copy: UI_COPY.settings,
	});
}

async function promptBackendSettings(
	initial: PluginConfig,
): Promise<PluginConfig | null> {
	return promptBackendSettingsMenu({
		initial,
		isInteractive: () => input.isTTY && output.isTTY,
		ui: getUiRuntimeOptions(),
		cloneBackendPluginConfig,
		backendCategoryOptions: BACKEND_CATEGORY_OPTIONS,
		getBackendCategoryInitialFocus,
		buildBackendSettingsPreview,
		highlightPreviewToken,
		select,
		getBackendCategory,
		promptBackendCategorySettings,
		backendDefaults: BACKEND_DEFAULTS,
		copy: UI_COPY.settings,
	});
}

async function loadExperimentalSyncTarget(): Promise<
	| {
			kind: "blocked-ambiguous";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
	  }
	| {
			kind: "blocked-none";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
	  }
	| { kind: "error"; message: string }
	| {
			kind: "target";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
			destination: import("../storage.js").AccountStorageV3 | null;
	  }
> {
	return loadExperimentalSyncTargetState({
		detectTarget: detectOcChatgptMultiAuthTarget,
		readJson: async (path) =>
			JSON.parse(
				await readFileWithRetry(path, {
					retryableCodes: new Set([
						"EBUSY",
						"EPERM",
						"EAGAIN",
						"ENOTEMPTY",
						"EACCES",
					]),
					maxAttempts: 4,
					sleep,
				}),
			),
		normalizeAccountStorage,
	});
}

async function promptExperimentalSettings(
	initialConfig: PluginConfig,
): Promise<PluginConfig | null> {
	return promptExperimentalSettingsMenu({
		initialConfig,
		isInteractive: () => input.isTTY && output.isTTY,
		ui: getUiRuntimeOptions(),
		cloneBackendPluginConfig,
		select: select as never,
		getExperimentalSelectOptions: getExperimentalSelectOptions as never,
		mapExperimentalMenuHotkey: mapExperimentalMenuHotkey as never,
		mapExperimentalStatusHotkey: mapExperimentalStatusHotkey as never,
		formatDashboardSettingState,
		copy: UI_COPY.settings,
		input,
		output,
		runNamedBackupExport,
		loadAccounts,
		loadExperimentalSyncTarget,
		planOcChatgptSync: planOcChatgptSync as never,
		applyOcChatgptSync: applyOcChatgptSync as never,
		getTargetKind: (targetState) => (targetState as { kind: string }).kind,
		getTargetDestination: (targetState) =>
			(targetState as { kind: string; destination?: unknown }).destination,
		getTargetDetection: (targetState) =>
			(targetState as { detection?: unknown }).detection,
		getTargetErrorMessage: (targetState) =>
			(targetState as { kind: string; message?: string }).kind === "error"
				? ((targetState as { message?: string }).message ?? "Unknown error")
				: null,
		getPlanKind: (plan) => (plan as { kind: string }).kind,
		getPlanBlockedReason: (plan) => {
			const candidate = plan as {
				kind: string;
				detection?: { reason?: string };
			};
			return candidate.kind === "blocked-ambiguous"
				? `Sync blocked: ${candidate.detection?.reason ?? "unknown"}`
				: `Sync unavailable: ${candidate.detection?.reason ?? "unknown"}`;
		},
		getPlanPreview: (plan) =>
			(
				plan as {
					preview: {
						toAdd: unknown[];
						toUpdate: unknown[];
						toSkip: unknown[];
						unchangedDestinationOnly: unknown[];
						activeSelectionBehavior: string;
					};
				}
			).preview,
		getAppliedLabel: (applied) => {
			const candidate = applied as {
				kind: string;
				target?: { accountPath?: string };
				error?: unknown;
			};
			return {
				label:
					candidate.kind === "applied"
						? `Applied sync to ${candidate.target?.accountPath ?? "target"}`
						: candidate.kind === "error"
							? candidate.error instanceof Error
								? candidate.error.message
								: String(candidate.error)
							: "Sync did not apply",
				color: candidate.kind === "applied" ? "green" : "yellow",
			};
		},
	});
}

async function configureBackendSettings(
	currentConfig?: PluginConfig,
): Promise<PluginConfig> {
	return configureBackendSettingsEntry(currentConfig, {
		configureBackendSettingsController,
		cloneBackendPluginConfig,
		loadPluginConfig,
		promptBackendSettings,
		backendSettingsEqual,
		persistBackendConfigSelection,
		isInteractive: () => input.isTTY && output.isTTY,
		writeLine: (message) => {
			console.log(message);
		},
	});
}

async function promptSettingsHub(
	initialFocus: SettingsHubAction["type"] = "account-list",
): Promise<SettingsHubAction | null> {
	return promptSettingsHubMenu(initialFocus, {
		isInteractive: () => input.isTTY && output.isTTY,
		getUiRuntimeOptions,
		buildItems: () => buildSettingsHubItems(UI_COPY.settings),
		findInitialCursor: findSettingsHubInitialCursor,
		select,
		copy: {
			title: UI_COPY.settings.title,
			subtitle: UI_COPY.settings.subtitle,
			help: UI_COPY.settings.help,
		},
	});
}

/* c8 ignore stop */

async function configureUnifiedSettings(
	initialSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	return configureUnifiedSettingsController(initialSettings, {
		cloneDashboardSettings,
		cloneBackendPluginConfig,
		loadDashboardDisplaySettings,
		loadPluginConfig,
		applyUiThemeFromDashboardSettings,
		promptSettingsHub: async (focus) =>
			promptSettingsHub(focus as SettingsHubActionType),
		configureDashboardDisplaySettings,
		configureStatuslineSettings,
		promptBehaviorSettings,
		promptThemeSettings,
		dashboardSettingsEqual,
		persistDashboardSettingsSelection,
		promptExperimentalSettings,
		backendSettingsEqual,
		persistBackendConfigSelection,
		configureBackendSettings,
		BEHAVIOR_PANEL_KEYS,
		THEME_PANEL_KEYS,
	});
}

export {
	configureUnifiedSettings,
	applyUiThemeFromDashboardSettings,
	resolveMenuLayoutMode,
	__testOnly,
};
