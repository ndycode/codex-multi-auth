import type { UiRuntimeOptions } from "../ui/runtime.js";

export function resolveUiRuntimeEntry(params: {
	loadPluginConfig: () => ReturnType<
		typeof import("../config.js").loadPluginConfig
	>;
	resolveUiRuntimeFromConfig: (
		loadPluginConfig: () => ReturnType<
			typeof import("../config.js").loadPluginConfig
		>,
		applyUiRuntimeFromConfig: (
			pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => UiRuntimeOptions,
	) => UiRuntimeOptions;
	applyUiRuntimeFromConfig: (
		pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	) => UiRuntimeOptions;
}): UiRuntimeOptions {
	return params.resolveUiRuntimeFromConfig(
		params.loadPluginConfig,
		params.applyUiRuntimeFromConfig,
	);
}
