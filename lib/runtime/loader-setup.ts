export function applyLoaderRuntimeSetup(params: {
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>;
	applyUiRuntimeFromConfig: (
		pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => void;
	applyAccountStorageScope: (
		pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => void;
	ensureSessionAffinity: (
		pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => void;
	ensureRefreshGuardian: (
		pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => void;
	applyPreemptiveQuotaSettings: (
		pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => void;
}): void {
	params.applyUiRuntimeFromConfig(params.pluginConfig);
	params.applyAccountStorageScope(params.pluginConfig);
	params.ensureSessionAffinity(params.pluginConfig);
	params.ensureRefreshGuardian(params.pluginConfig);
	params.applyPreemptiveQuotaSettings(params.pluginConfig);
}
