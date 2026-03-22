import type { UiRuntimeOptions } from "../ui/runtime.js";

export function getRuntimeStatusMarker(
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
