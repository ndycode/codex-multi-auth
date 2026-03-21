import type { UiRuntimeOptions } from "../ui/runtime.js";

export function applyRuntimeUiOptions<TConfig>(
	pluginConfig: TConfig,
	deps: {
		setUiRuntimeOptions: (
			options: Partial<Omit<UiRuntimeOptions, "theme">>,
		) => UiRuntimeOptions;
		getCodexTuiV2: (config: TConfig) => boolean;
		getCodexTuiColorProfile: (
			config: TConfig,
		) => UiRuntimeOptions["colorProfile"];
		getCodexTuiGlyphMode: (config: TConfig) => UiRuntimeOptions["glyphMode"];
	},
): UiRuntimeOptions {
	return deps.setUiRuntimeOptions({
		v2Enabled: deps.getCodexTuiV2(pluginConfig),
		colorProfile: deps.getCodexTuiColorProfile(pluginConfig),
		glyphMode: deps.getCodexTuiGlyphMode(pluginConfig),
	});
}
