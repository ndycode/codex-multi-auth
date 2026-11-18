export function applyContextBudgetGuardSettingsFromConfig(
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	deps: {
		configure: (options: {
			enabled: boolean;
			softPercent: number;
			hardPercent: number;
			modelWindowOverrides: Record<string, number>;
		}) => void;
		getContextBudgetGuardEnabled: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => boolean;
		getContextBudgetGuardSoftPercent: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => number;
		getContextBudgetGuardHardPercent: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => number;
		getContextBudgetGuardModelWindowOverrides: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => Record<string, number>;
	},
): void {
	deps.configure({
		enabled: deps.getContextBudgetGuardEnabled(pluginConfig),
		softPercent: deps.getContextBudgetGuardSoftPercent(pluginConfig),
		hardPercent: deps.getContextBudgetGuardHardPercent(pluginConfig),
		modelWindowOverrides:
			deps.getContextBudgetGuardModelWindowOverrides(pluginConfig),
	});
}
