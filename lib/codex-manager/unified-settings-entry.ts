import type { DashboardDisplaySettings } from "../dashboard-settings.js";
import type {
	UnifiedSettingsControllerDeps,
} from "./unified-settings-controller.js";

export async function configureUnifiedSettingsEntry(
	initialSettings: DashboardDisplaySettings | undefined,
	deps: {
		configureUnifiedSettingsController: (
			initialSettings: DashboardDisplaySettings | undefined,
			deps: UnifiedSettingsControllerDeps,
		) => Promise<DashboardDisplaySettings>;
	} & UnifiedSettingsControllerDeps,
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
