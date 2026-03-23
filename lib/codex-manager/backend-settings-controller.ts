import type { PluginConfig } from "../types.js";

export async function configureBackendSettingsController(
	currentConfig: PluginConfig | undefined,
	deps: {
		cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
		loadPluginConfig: () => PluginConfig;
		promptBackendSettings: (
			config: PluginConfig,
		) => Promise<PluginConfig | null>;
		backendSettingsEqual: (left: PluginConfig, right: PluginConfig) => boolean;
		persistBackendConfigSelection: (
			config: PluginConfig,
			scope: string,
		) => Promise<PluginConfig>;
		isInteractive: () => boolean;
		writeLine: (message: string) => void;
	},
): Promise<PluginConfig> {
	const current = deps.cloneBackendPluginConfig(
		currentConfig ?? deps.loadPluginConfig(),
	);
	if (!deps.isInteractive()) {
		deps.writeLine("Settings require interactive mode.");
		return current;
	}

	const selected = await deps.promptBackendSettings(current);
	if (!selected) return current;
	if (deps.backendSettingsEqual(current, selected)) return current;

	return deps.persistBackendConfigSelection(selected, "backend");
}
