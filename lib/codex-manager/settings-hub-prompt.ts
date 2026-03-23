import type { UiRuntimeOptions } from "../ui/runtime.js";
import type { MenuItem } from "../ui/select.js";
import type { SettingsHubMenuAction } from "./settings-hub-menu.js";

export async function promptSettingsHubMenu(
	initialFocus: SettingsHubMenuAction["type"],
	deps: {
		isInteractive: () => boolean;
		getUiRuntimeOptions: () => UiRuntimeOptions;
		buildItems: () => MenuItem<SettingsHubMenuAction>[];
		findInitialCursor: (
			items: MenuItem<SettingsHubMenuAction>[],
			initialFocus: SettingsHubMenuAction["type"],
		) => number | undefined;
		select: <T>(
			items: MenuItem<T>[],
			options: {
				message: string;
				subtitle: string;
				help: string;
				clearScreen: boolean;
				theme: UiRuntimeOptions["theme"];
				selectedEmphasis: "minimal";
				initialCursor?: number;
				onInput: (raw: string) => T | undefined;
			},
		) => Promise<T | null>;
		copy: {
			title: string;
			subtitle: string;
			help: string;
		};
	},
): Promise<SettingsHubMenuAction | null> {
	if (!deps.isInteractive()) return null;
	const ui = deps.getUiRuntimeOptions();
	const items = deps.buildItems();
	const initialCursor = deps.findInitialCursor(items, initialFocus);
	return deps.select(items, {
		message: deps.copy.title,
		subtitle: deps.copy.subtitle,
		help: deps.copy.help,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		initialCursor,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return { type: "back" };
			return undefined;
		},
	});
}
