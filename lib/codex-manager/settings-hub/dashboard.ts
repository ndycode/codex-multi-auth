import {
	type DashboardAccentColor,
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
	type DashboardThemePreset,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	getDashboardSettingsPath,
	loadDashboardDisplaySettings,
} from "../../dashboard-settings.js";
import { UI_COPY } from "../../ui/ui-copy.js";
import { getUiRuntimeOptions, setUiRuntimeOptions } from "../../ui/runtime.js";
import { promptBehaviorSettingsPanel } from "../behavior-settings-panel.js";
import {
	promptDashboardDisplayPanel,
	type DashboardDisplaySettingOption,
} from "../dashboard-display-panel.js";
import {
	formatDashboardSettingState,
	formatMenuLayoutMode,
	formatMenuQuotaTtl,
	formatMenuSortMode,
} from "../dashboard-formatters.js";
import { configureDashboardSettingsController } from "../dashboard-settings-controller.js";
import { configureDashboardSettingsEntry } from "../dashboard-settings-entry.js";
import {
	promptBehaviorSettingsPanelEntry,
	promptDashboardDisplaySettingsPanelEntry,
	promptStatuslineSettingsPanelEntry,
	promptThemeSettingsPanelEntry,
} from "../settings-panels.js";
import { normalizeStatuslineFields } from "../settings-preview.js";
import { promptStatuslineSettingsPanel } from "../statusline-settings-panel.js";
import { promptThemeSettingsPanel } from "../theme-settings-panel.js";
import {
	applyDashboardDefaultsForKeys,
	buildAccountListPreview,
	cloneDashboardSettings,
	type DashboardSettingKey,
	dashboardSettingsEqual,
	isTtyInteractive,
	persistDashboardSettingsSelection,
	resolveMenuLayoutMode,
} from "./shared.js";

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
export const MENU_QUOTA_TTL_OPTIONS_MS = [
	60_000,
	5 * 60_000,
	10 * 60_000,
] as const;
export const THEME_PRESET_OPTIONS: DashboardThemePreset[] = ["green", "blue"];
export const ACCENT_COLOR_OPTIONS: DashboardAccentColor[] = [
	"green",
	"cyan",
	"blue",
	"yellow",
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

export const STATUSLINE_PANEL_KEYS = [
	"menuStatuslineFields",
] as const satisfies readonly DashboardSettingKey[];
export const BEHAVIOR_PANEL_KEYS = [
	"actionAutoReturnMs",
	"actionPauseOnKey",
	"menuAutoFetchLimits",
	"menuShowFetchStatus",
	"menuQuotaTtlMs",
] as const satisfies readonly DashboardSettingKey[];
export const THEME_PANEL_KEYS = [
	"uiThemePreset",
	"uiAccentColor",
] as const satisfies readonly DashboardSettingKey[];

export function applyUiThemeFromDashboardSettings(
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

/* c8 ignore start - interactive prompt flows are covered by integration tests */
export async function promptDashboardDisplaySettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptDashboardDisplaySettingsPanelEntry({
		initial,
		promptDashboardDisplayPanel,
		cloneDashboardSettings,
		buildAccountListPreview,
		formatDashboardSettingState,
		formatMenuSortMode,
		resolveMenuLayoutMode: (settings = DEFAULT_DASHBOARD_DISPLAY_SETTINGS) =>
			resolveMenuLayoutMode(settings),
		formatMenuLayoutMode,
		applyDashboardDefaultsForKeys,
		DASHBOARD_DISPLAY_OPTIONS,
		ACCOUNT_LIST_PANEL_KEYS,
		UI_COPY,
	});
}

export async function configureDashboardDisplaySettings(
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
		isInteractive: isTtyInteractive,
		getDashboardSettingsPath,
		writeLine: (message) => {
			console.log(message);
		},
	});
}

export async function promptStatuslineSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptStatuslineSettingsPanelEntry({
		initial,
		promptStatuslineSettingsPanel,
		cloneDashboardSettings,
		buildAccountListPreview,
		normalizeStatuslineFields,
		formatDashboardSettingState,
		applyDashboardDefaultsForKeys,
		STATUSLINE_FIELD_OPTIONS,
		STATUSLINE_PANEL_KEYS,
		UI_COPY,
	});
}

export async function configureStatuslineSettings(
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
		isInteractive: isTtyInteractive,
		getDashboardSettingsPath,
		writeLine: (message) => {
			console.log(message);
		},
	});
}

export async function promptBehaviorSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptBehaviorSettingsPanelEntry({
		initial,
		promptBehaviorSettingsPanel,
		cloneDashboardSettings,
		applyDashboardDefaultsForKeys,
		formatMenuQuotaTtl,
		AUTO_RETURN_OPTIONS_MS,
		MENU_QUOTA_TTL_OPTIONS_MS,
		BEHAVIOR_PANEL_KEYS,
		UI_COPY,
	});
}

export async function promptThemeSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptThemeSettingsPanelEntry({
		initial,
		promptThemeSettingsPanel,
		cloneDashboardSettings,
		applyDashboardDefaultsForKeys,
		applyUiThemeFromDashboardSettings,
		THEME_PRESET_OPTIONS,
		ACCENT_COLOR_OPTIONS,
		THEME_PANEL_KEYS,
		UI_COPY,
	});
}
/* c8 ignore stop */
