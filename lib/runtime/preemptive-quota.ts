export function applyRuntimePreemptiveQuotaSettings<TConfig>(
	pluginConfig: TConfig,
	deps: {
		configure: (options: {
			enabled: boolean;
			remainingPercentThresholdPrimary: number;
			remainingPercentThresholdSecondary: number;
			maxDeferralMs: number;
		}) => void;
		getPreemptiveQuotaEnabled: (config: TConfig) => boolean;
		getPreemptiveQuotaRemainingPercent5h: (config: TConfig) => number;
		getPreemptiveQuotaRemainingPercent7d: (config: TConfig) => number;
		getPreemptiveQuotaMaxDeferralMs: (config: TConfig) => number;
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
