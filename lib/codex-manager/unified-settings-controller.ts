import type { DashboardDisplaySettings } from "../dashboard-settings.js";
import type { PluginConfig } from "../types.js";

export type SettingsHubActionType =
	| "account-list"
	| "summary-fields"
	| "behavior"
	| "theme"
	| "experimental"
	| "backend"
	| "back";

export type UnifiedSettingsControllerDeps = {
	cloneDashboardSettings: (
		settings: DashboardDisplaySettings,
	) => DashboardDisplaySettings;
	cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
	loadDashboardDisplaySettings: () => Promise<DashboardDisplaySettings>;
	loadPluginConfig: () => PluginConfig;
	applyUiThemeFromDashboardSettings: (
		settings: DashboardDisplaySettings,
	) => void;
	promptSettingsHub: (
		focus: SettingsHubActionType,
	) => Promise<{ type: SettingsHubActionType } | null>;
	configureDashboardDisplaySettings: (
		current: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings>;
	configureStatuslineSettings: (
		current: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings>;
	promptBehaviorSettings: (
		current: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings | null>;
	promptThemeSettings: (
		current: DashboardDisplaySettings,
	) => Promise<DashboardDisplaySettings | null>;
	dashboardSettingsEqual: (
		left: DashboardDisplaySettings,
		right: DashboardDisplaySettings,
	) => boolean;
	persistDashboardSettingsSelection: (
		selected: DashboardDisplaySettings,
		keys: readonly (keyof DashboardDisplaySettings)[],
		scope: string,
	) => Promise<DashboardDisplaySettings>;
	promptExperimentalSettings: (
		config: PluginConfig,
	) => Promise<PluginConfig | null>;
	backendSettingsEqual: (left: PluginConfig, right: PluginConfig) => boolean;
	persistBackendConfigSelection: (
		config: PluginConfig,
		scope: string,
	) => Promise<PluginConfig>;
	configureBackendSettings: (config: PluginConfig) => Promise<PluginConfig>;
	BEHAVIOR_PANEL_KEYS: readonly (keyof DashboardDisplaySettings)[];
	THEME_PANEL_KEYS: readonly (keyof DashboardDisplaySettings)[];
};

export async function configureUnifiedSettingsController(
	initialSettings: DashboardDisplaySettings | undefined,
	deps: UnifiedSettingsControllerDeps,
): Promise<DashboardDisplaySettings> {
	let current = deps.cloneDashboardSettings(
		initialSettings ?? (await deps.loadDashboardDisplaySettings()),
	);
	let backendConfig = deps.cloneBackendPluginConfig(deps.loadPluginConfig());
	deps.applyUiThemeFromDashboardSettings(current);
	let hubFocus: SettingsHubActionType = "account-list";

	while (true) {
		const action = await deps.promptSettingsHub(hubFocus);
		if (!action || action.type === "back") {
			return current;
		}
		hubFocus = action.type;

		if (action.type === "account-list") {
			current = await deps.configureDashboardDisplaySettings(current);
			continue;
		}
		if (action.type === "summary-fields") {
			current = await deps.configureStatuslineSettings(current);
			continue;
		}
		if (action.type === "behavior") {
			const selected = await deps.promptBehaviorSettings(current);
			if (selected && !deps.dashboardSettingsEqual(current, selected)) {
				current = await deps.persistDashboardSettingsSelection(
					selected,
					deps.BEHAVIOR_PANEL_KEYS,
					"behavior",
				);
			}
			continue;
		}
		if (action.type === "theme") {
			const selected = await deps.promptThemeSettings(current);
			if (selected && !deps.dashboardSettingsEqual(current, selected)) {
				current = await deps.persistDashboardSettingsSelection(
					selected,
					deps.THEME_PANEL_KEYS,
					"theme",
				);
				deps.applyUiThemeFromDashboardSettings(current);
			}
			continue;
		}
		if (action.type === "experimental") {
			const selected = await deps.promptExperimentalSettings(backendConfig);
			if (selected && !deps.backendSettingsEqual(backendConfig, selected)) {
				backendConfig = await deps.persistBackendConfigSelection(
					selected,
					"experimental",
				);
			} else if (selected) {
				backendConfig = selected;
			}
			continue;
		}
		if (action.type === "backend") {
			backendConfig = await deps.configureBackendSettings(backendConfig);
		}
	}
}
