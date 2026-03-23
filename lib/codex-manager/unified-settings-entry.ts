import type { DashboardDisplaySettings } from "../dashboard-settings.js";
import type { PluginConfig } from "../types.js";
import type { SettingsHubActionType } from "./unified-settings-controller.js";

export async function configureUnifiedSettingsEntry(
	initialSettings: DashboardDisplaySettings | undefined,
	deps: {
		configureUnifiedSettingsController: (
			initialSettings: DashboardDisplaySettings | undefined,
			deps: {
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
				backendSettingsEqual: (
					left: PluginConfig,
					right: PluginConfig,
				) => boolean;
				persistBackendConfigSelection: (
					config: PluginConfig,
					scope: string,
				) => Promise<PluginConfig>;
				configureBackendSettings: (
					config: PluginConfig,
				) => Promise<PluginConfig>;
				BEHAVIOR_PANEL_KEYS: readonly (keyof DashboardDisplaySettings)[];
				THEME_PANEL_KEYS: readonly (keyof DashboardDisplaySettings)[];
			},
		) => Promise<DashboardDisplaySettings>;
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
	},
): Promise<DashboardDisplaySettings> {
	return deps.configureUnifiedSettingsController(initialSettings, {
		cloneDashboardSettings: deps.cloneDashboardSettings,
		cloneBackendPluginConfig: deps.cloneBackendPluginConfig,
		loadDashboardDisplaySettings: deps.loadDashboardDisplaySettings,
		loadPluginConfig: deps.loadPluginConfig,
		applyUiThemeFromDashboardSettings: deps.applyUiThemeFromDashboardSettings,
		promptSettingsHub: deps.promptSettingsHub,
		configureDashboardDisplaySettings: deps.configureDashboardDisplaySettings,
		configureStatuslineSettings: deps.configureStatuslineSettings,
		promptBehaviorSettings: deps.promptBehaviorSettings,
		promptThemeSettings: deps.promptThemeSettings,
		dashboardSettingsEqual: deps.dashboardSettingsEqual,
		persistDashboardSettingsSelection: deps.persistDashboardSettingsSelection,
		promptExperimentalSettings: deps.promptExperimentalSettings,
		backendSettingsEqual: deps.backendSettingsEqual,
		persistBackendConfigSelection: deps.persistBackendConfigSelection,
		configureBackendSettings: deps.configureBackendSettings,
		BEHAVIOR_PANEL_KEYS: deps.BEHAVIOR_PANEL_KEYS,
		THEME_PANEL_KEYS: deps.THEME_PANEL_KEYS,
	});
}
