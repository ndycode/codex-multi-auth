import type { DashboardDisplaySettings } from "../dashboard-settings.js";

export async function configureDashboardSettingsEntry(
	currentSettings: DashboardDisplaySettings | undefined,
	deps: {
		configureDashboardSettingsController: (
			currentSettings: DashboardDisplaySettings | undefined,
			deps: {
				loadDashboardDisplaySettings: () => Promise<DashboardDisplaySettings>;
				promptSettings: (
					settings: DashboardDisplaySettings,
				) => Promise<DashboardDisplaySettings | null>;
				settingsEqual: (
					left: DashboardDisplaySettings,
					right: DashboardDisplaySettings,
				) => boolean;
				persistSelection: (
					selected: DashboardDisplaySettings,
				) => Promise<DashboardDisplaySettings>;
				applyUiThemeFromDashboardSettings: (
					settings: DashboardDisplaySettings,
				) => void;
				isInteractive: () => boolean;
				getDashboardSettingsPath: () => string;
				writeLine: (message: string) => void;
			},
		) => Promise<DashboardDisplaySettings>;
		loadDashboardDisplaySettings: () => Promise<DashboardDisplaySettings>;
		promptSettings: (
			settings: DashboardDisplaySettings,
		) => Promise<DashboardDisplaySettings | null>;
		settingsEqual: (
			left: DashboardDisplaySettings,
			right: DashboardDisplaySettings,
		) => boolean;
		persistSelection: (
			selected: DashboardDisplaySettings,
		) => Promise<DashboardDisplaySettings>;
		applyUiThemeFromDashboardSettings: (
			settings: DashboardDisplaySettings,
		) => void;
		isInteractive: () => boolean;
		getDashboardSettingsPath: () => string;
		writeLine: (message: string) => void;
	},
): Promise<DashboardDisplaySettings> {
	return deps.configureDashboardSettingsController(currentSettings, {
		loadDashboardDisplaySettings: deps.loadDashboardDisplaySettings,
		promptSettings: deps.promptSettings,
		settingsEqual: deps.settingsEqual,
		persistSelection: deps.persistSelection,
		applyUiThemeFromDashboardSettings: deps.applyUiThemeFromDashboardSettings,
		isInteractive: deps.isInteractive,
		getDashboardSettingsPath: deps.getDashboardSettingsPath,
		writeLine: deps.writeLine,
	});
}
