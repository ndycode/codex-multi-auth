import { UI_COPY } from "../ui/copy.js";
import type { getUiRuntimeOptions } from "../ui/runtime.js";
import type { SelectOptions } from "../ui/select.js";

export type ExperimentalSettingsAction =
	| { type: "sync" }
	| { type: "backup" }
	| { type: "toggle-refresh-guardian" }
	| { type: "decrease-refresh-interval" }
	| { type: "increase-refresh-interval" }
	| { type: "apply" }
	| { type: "save" }
	| { type: "back" };

export function getExperimentalSelectOptions(
	ui: ReturnType<typeof getUiRuntimeOptions>,
	help: string,
	onInput?: SelectOptions<ExperimentalSettingsAction>["onInput"],
): SelectOptions<ExperimentalSettingsAction> {
	return {
		message: UI_COPY.settings.experimentalTitle,
		subtitle: UI_COPY.settings.experimentalSubtitle,
		help,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		onInput,
	};
}

export function mapExperimentalMenuHotkey(
	raw: string,
): ExperimentalSettingsAction | undefined {
	if (raw === "1") return { type: "sync" };
	if (raw === "2") return { type: "backup" };
	if (raw === "3") return { type: "toggle-refresh-guardian" };
	if (raw === "[" || raw === "-" || raw.toLowerCase() === "a") return { type: "decrease-refresh-interval" };
	if (raw === "]" || raw === "+" || raw === "=" || raw.toLowerCase() === "d") return { type: "increase-refresh-interval" };
	const lower = raw.toLowerCase();
	if (lower === "q") return { type: "back" };
	if (lower === "s") return { type: "save" };
	return undefined;
}

export function mapExperimentalStatusHotkey(
	raw: string,
): ExperimentalSettingsAction | undefined {
	return raw.toLowerCase() === "q" ? { type: "back" } : undefined;
}
