import {
	getCodexTuiColorProfile,
	getCodexTuiGlyphMode,
	getCodexTuiV2,
} from "../config.js";
import type { UiRuntimeOptions } from "../ui/runtime.js";

export function applyUiRuntimeFromConfig(
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	setUiRuntimeOptions: (options: {
		v2Enabled: boolean;
		colorProfile: ReturnType<typeof getCodexTuiColorProfile>;
		glyphMode: ReturnType<typeof getCodexTuiGlyphMode>;
	}) => UiRuntimeOptions,
): UiRuntimeOptions {
	return setUiRuntimeOptions({
		v2Enabled: getCodexTuiV2(pluginConfig),
		colorProfile: getCodexTuiColorProfile(pluginConfig),
		glyphMode: getCodexTuiGlyphMode(pluginConfig),
	});
}

export function getStatusMarker(
	ui: UiRuntimeOptions,
	status: "ok" | "warning" | "error",
): string {
	if (!ui.v2Enabled) {
		if (status === "ok") return "✓";
		if (status === "warning") return "!";
		return "✗";
	}
	if (status === "ok") return ui.theme.glyphs.check;
	if (status === "warning") return "!";
	return ui.theme.glyphs.cross;
}
