import type { DashboardDisplaySettings } from "../dashboard-settings.js";

export async function configureDashboardSettingsController(
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
): Promise<DashboardDisplaySettings> {
	const current =
		currentSettings ?? (await deps.loadDashboardDisplaySettings());
	if (!deps.isInteractive()) {
		deps.writeLine("Settings require interactive mode.");
		deps.writeLine(`Settings file: ${deps.getDashboardSettingsPath()}`);
		return current;
	}

	const selected = await deps.promptSettings(current);
	if (!selected) return current;
	if (deps.settingsEqual(current, selected)) return current;

	const merged = await deps.persistSelection(selected);
	deps.applyUiThemeFromDashboardSettings(merged);
	return merged;
}
