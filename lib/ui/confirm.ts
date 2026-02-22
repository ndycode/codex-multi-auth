import { select } from "./select.js";
import { getUiRuntimeOptions } from "./runtime.js";

export async function confirm(message: string, defaultYes = false): Promise<boolean> {
	const ui = getUiRuntimeOptions();
	const items = defaultYes
		? [
				{ label: "Yes", value: true },
				{ label: "No", value: false },
			]
		: [
				{ label: "No", value: false },
				{ label: "Yes", value: true },
			];

	const result = await select(items, {
		message,
		variant: ui.v2Enabled ? "codex" : "legacy",
		theme: ui.theme,
	});
	return result ?? false;
}
