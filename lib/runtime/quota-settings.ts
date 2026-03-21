export function applyPreemptiveQuotaSettingsFromConfig(
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	deps: {
		configure: (options: {
			enabled: boolean;
			remainingPercentThresholdPrimary: number;
			remainingPercentThresholdSecondary: number;
			maxDeferralMs: number;
		}) => void;
		getPreemptiveQuotaEnabled: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => boolean;
		getPreemptiveQuotaRemainingPercent5h: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => number;
		getPreemptiveQuotaRemainingPercent7d: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => number;
		getPreemptiveQuotaMaxDeferralMs: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => number;
	},
): void {
	deps.configure({
		enabled: deps.getPreemptiveQuotaEnabled(pluginConfig),
		remainingPercentThresholdPrimary:
			deps.getPreemptiveQuotaRemainingPercent5h(pluginConfig),
		remainingPercentThresholdSecondary:
			deps.getPreemptiveQuotaRemainingPercent7d(pluginConfig),
		maxDeferralMs: deps.getPreemptiveQuotaMaxDeferralMs(pluginConfig),
	});
}

export function resolveUiRuntimeFromConfig(
	loadPluginConfig: () => ReturnType<
		typeof import("../config.js").loadPluginConfig
	>,
	applyUiRuntimeFromConfig: (
		pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions>,
): ReturnType<typeof import("../ui/runtime.js").getUiRuntimeOptions> {
	return applyUiRuntimeFromConfig(loadPluginConfig());
}
