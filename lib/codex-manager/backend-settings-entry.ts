import type { PluginConfig } from "../types.js";

export async function configureBackendSettingsEntry(
	currentConfig: PluginConfig | undefined,
	deps: {
		configureBackendSettingsController: (
			currentConfig: PluginConfig | undefined,
			deps: {
				cloneBackendPluginConfig: (config: PluginConfig) => PluginConfig;
				loadPluginConfig: () => PluginConfig;
				promptBackendSettings: (
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
				isInteractive: () => boolean;
				writeLine: (message: string) => void;
			},
		) => Promise<PluginConfig>;
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
	return deps.configureBackendSettingsController(currentConfig, {
		cloneBackendPluginConfig: deps.cloneBackendPluginConfig,
		loadPluginConfig: deps.loadPluginConfig,
		promptBackendSettings: deps.promptBackendSettings,
		backendSettingsEqual: deps.backendSettingsEqual,
		persistBackendConfigSelection: deps.persistBackendConfigSelection,
		isInteractive: deps.isInteractive,
		writeLine: deps.writeLine,
	});
}
