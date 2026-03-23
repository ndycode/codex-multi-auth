import {
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
} from "../dashboard-settings.js";
import type { BehaviorSettingsPanelDeps } from "./behavior-settings-panel.js";
import type { DashboardDisplayPanelDeps } from "./dashboard-display-panel.js";
import type { StatuslineSettingsPanelDeps } from "./statusline-settings-panel.js";
import type { ThemeSettingsPanelDeps } from "./theme-settings-panel.js";

export async function promptDashboardDisplaySettingsPanelEntry(params: {
	initial: DashboardDisplaySettings;
	promptDashboardDisplayPanel: (
		initial: DashboardDisplaySettings,
		deps: DashboardDisplayPanelDeps,
	) => Promise<DashboardDisplaySettings | null>;
	cloneDashboardSettings: DashboardDisplayPanelDeps["cloneDashboardSettings"];
	buildAccountListPreview: DashboardDisplayPanelDeps["buildAccountListPreview"];
	formatDashboardSettingState: DashboardDisplayPanelDeps["formatDashboardSettingState"];
	formatMenuSortMode: DashboardDisplayPanelDeps["formatMenuSortMode"];
	resolveMenuLayoutMode: (
		settings?: DashboardDisplaySettings,
	) => NonNullable<DashboardDisplaySettings["menuLayoutMode"]>;
	formatMenuLayoutMode: DashboardDisplayPanelDeps["formatMenuLayoutMode"];
	applyDashboardDefaultsForKeys: DashboardDisplayPanelDeps["applyDashboardDefaultsForKeys"];
	DASHBOARD_DISPLAY_OPTIONS: DashboardDisplayPanelDeps["DASHBOARD_DISPLAY_OPTIONS"];
	ACCOUNT_LIST_PANEL_KEYS: DashboardDisplayPanelDeps["ACCOUNT_LIST_PANEL_KEYS"];
	UI_COPY: DashboardDisplayPanelDeps["UI_COPY"];
}): Promise<DashboardDisplaySettings | null> {
	return params.promptDashboardDisplayPanel(params.initial, {
		cloneDashboardSettings: params.cloneDashboardSettings,
		buildAccountListPreview: params.buildAccountListPreview,
		formatDashboardSettingState: params.formatDashboardSettingState,
		formatMenuSortMode: params.formatMenuSortMode,
		resolveMenuLayoutMode: (settings) =>
			params.resolveMenuLayoutMode(
				settings ?? DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
			) ?? "compact-details",
		formatMenuLayoutMode: params.formatMenuLayoutMode,
		applyDashboardDefaultsForKeys: params.applyDashboardDefaultsForKeys,
		DASHBOARD_DISPLAY_OPTIONS: params.DASHBOARD_DISPLAY_OPTIONS,
		ACCOUNT_LIST_PANEL_KEYS: params.ACCOUNT_LIST_PANEL_KEYS,
		UI_COPY: params.UI_COPY,
	});
}

export function reorderStatuslineField(
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

export async function promptStatuslineSettingsPanelEntry(params: {
	initial: DashboardDisplaySettings;
	promptStatuslineSettingsPanel: (
		initial: DashboardDisplaySettings,
		deps: StatuslineSettingsPanelDeps,
	) => Promise<DashboardDisplaySettings | null>;
	cloneDashboardSettings: StatuslineSettingsPanelDeps["cloneDashboardSettings"];
	buildAccountListPreview: StatuslineSettingsPanelDeps["buildAccountListPreview"];
	normalizeStatuslineFields: StatuslineSettingsPanelDeps["normalizeStatuslineFields"];
	formatDashboardSettingState: StatuslineSettingsPanelDeps["formatDashboardSettingState"];
	applyDashboardDefaultsForKeys: StatuslineSettingsPanelDeps["applyDashboardDefaultsForKeys"];
	STATUSLINE_FIELD_OPTIONS: StatuslineSettingsPanelDeps["STATUSLINE_FIELD_OPTIONS"];
	STATUSLINE_PANEL_KEYS: StatuslineSettingsPanelDeps["STATUSLINE_PANEL_KEYS"];
	UI_COPY: StatuslineSettingsPanelDeps["UI_COPY"];
}): Promise<DashboardDisplaySettings | null> {
	return params.promptStatuslineSettingsPanel(params.initial, {
		cloneDashboardSettings: params.cloneDashboardSettings,
		buildAccountListPreview: params.buildAccountListPreview,
		normalizeStatuslineFields: params.normalizeStatuslineFields,
		formatDashboardSettingState: params.formatDashboardSettingState,
		reorderField: reorderStatuslineField,
		applyDashboardDefaultsForKeys: params.applyDashboardDefaultsForKeys,
		STATUSLINE_FIELD_OPTIONS: params.STATUSLINE_FIELD_OPTIONS,
		STATUSLINE_PANEL_KEYS: params.STATUSLINE_PANEL_KEYS,
		UI_COPY: params.UI_COPY,
	});
}

export function formatAutoReturnDelayLabel(delayMs: number): string {
	return delayMs <= 0
		? "Instant return"
		: `${Math.round(delayMs / 1000)}s auto-return`;
}

export async function promptBehaviorSettingsPanelEntry(params: {
	initial: DashboardDisplaySettings;
	promptBehaviorSettingsPanel: (
		initial: DashboardDisplaySettings,
		deps: BehaviorSettingsPanelDeps,
	) => Promise<DashboardDisplaySettings | null>;
	cloneDashboardSettings: BehaviorSettingsPanelDeps["cloneDashboardSettings"];
	applyDashboardDefaultsForKeys: BehaviorSettingsPanelDeps["applyDashboardDefaultsForKeys"];
	formatMenuQuotaTtl: BehaviorSettingsPanelDeps["formatMenuQuotaTtl"];
	AUTO_RETURN_OPTIONS_MS: BehaviorSettingsPanelDeps["AUTO_RETURN_OPTIONS_MS"];
	MENU_QUOTA_TTL_OPTIONS_MS: BehaviorSettingsPanelDeps["MENU_QUOTA_TTL_OPTIONS_MS"];
	BEHAVIOR_PANEL_KEYS: BehaviorSettingsPanelDeps["BEHAVIOR_PANEL_KEYS"];
	UI_COPY: BehaviorSettingsPanelDeps["UI_COPY"];
}): Promise<DashboardDisplaySettings | null> {
	return params.promptBehaviorSettingsPanel(params.initial, {
		cloneDashboardSettings: params.cloneDashboardSettings,
		applyDashboardDefaultsForKeys: params.applyDashboardDefaultsForKeys,
		formatDelayLabel: formatAutoReturnDelayLabel,
		formatMenuQuotaTtl: params.formatMenuQuotaTtl,
		AUTO_RETURN_OPTIONS_MS: params.AUTO_RETURN_OPTIONS_MS,
		MENU_QUOTA_TTL_OPTIONS_MS: params.MENU_QUOTA_TTL_OPTIONS_MS,
		BEHAVIOR_PANEL_KEYS: params.BEHAVIOR_PANEL_KEYS,
		UI_COPY: params.UI_COPY,
	});
}

export async function promptThemeSettingsPanelEntry(params: {
	initial: DashboardDisplaySettings;
	promptThemeSettingsPanel: (
		initial: DashboardDisplaySettings,
		deps: ThemeSettingsPanelDeps,
	) => Promise<DashboardDisplaySettings | null>;
	cloneDashboardSettings: ThemeSettingsPanelDeps["cloneDashboardSettings"];
	applyDashboardDefaultsForKeys: ThemeSettingsPanelDeps["applyDashboardDefaultsForKeys"];
	applyUiThemeFromDashboardSettings: ThemeSettingsPanelDeps["applyUiThemeFromDashboardSettings"];
	THEME_PRESET_OPTIONS: ThemeSettingsPanelDeps["THEME_PRESET_OPTIONS"];
	ACCENT_COLOR_OPTIONS: ThemeSettingsPanelDeps["ACCENT_COLOR_OPTIONS"];
	THEME_PANEL_KEYS: ThemeSettingsPanelDeps["THEME_PANEL_KEYS"];
	UI_COPY: ThemeSettingsPanelDeps["UI_COPY"];
}): Promise<DashboardDisplaySettings | null> {
	return params.promptThemeSettingsPanel(params.initial, {
		cloneDashboardSettings: params.cloneDashboardSettings,
		applyDashboardDefaultsForKeys: params.applyDashboardDefaultsForKeys,
		applyUiThemeFromDashboardSettings: params.applyUiThemeFromDashboardSettings,
		THEME_PRESET_OPTIONS: params.THEME_PRESET_OPTIONS,
		ACCENT_COLOR_OPTIONS: params.ACCENT_COLOR_OPTIONS,
		THEME_PANEL_KEYS: params.THEME_PANEL_KEYS,
		UI_COPY: params.UI_COPY,
	});
}
