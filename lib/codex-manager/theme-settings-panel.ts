import { stdin as input, stdout as output } from "node:process";
import type {
	DashboardAccentColor,
	DashboardDisplaySettings,
	DashboardThemePreset,
} from "../dashboard-settings.js";
import type { UI_COPY } from "../ui/copy.js";
import { getUiRuntimeOptions } from "../ui/runtime.js";
import { type MenuItem, select } from "../ui/select.js";

export type ThemeConfigAction =
	| { type: "set-palette"; palette: DashboardThemePreset }
	| { type: "set-accent"; accent: DashboardAccentColor }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

export interface ThemeSettingsPanelDeps {
	cloneDashboardSettings: (
		settings: DashboardDisplaySettings,
	) => DashboardDisplaySettings;
	applyDashboardDefaultsForKeys: (
		draft: DashboardDisplaySettings,
		keys: readonly (keyof DashboardDisplaySettings)[],
	) => DashboardDisplaySettings;
	applyUiThemeFromDashboardSettings: (
		settings: DashboardDisplaySettings,
	) => void;
	THEME_PRESET_OPTIONS: readonly DashboardThemePreset[];
	ACCENT_COLOR_OPTIONS: readonly DashboardAccentColor[];
	THEME_PANEL_KEYS: readonly (keyof DashboardDisplaySettings)[];
	UI_COPY: typeof UI_COPY;
}

export async function promptThemeSettingsPanel(
	initial: DashboardDisplaySettings,
	deps: ThemeSettingsPanelDeps,
): Promise<DashboardDisplaySettings | null> {
	if (!input.isTTY || !output.isTTY) return null;
	const baseline = deps.cloneDashboardSettings(initial);
	let draft = deps.cloneDashboardSettings(initial);
	let focus: ThemeConfigAction = {
		type: "set-palette",
		palette: draft.uiThemePreset ?? "green",
	};

	while (true) {
		const ui = getUiRuntimeOptions();
		const palette = draft.uiThemePreset ?? "green";
		const accent = draft.uiAccentColor ?? "green";
		const paletteItems: MenuItem<ThemeConfigAction>[] =
			deps.THEME_PRESET_OPTIONS.map((candidate, index) => {
				const color: MenuItem<ThemeConfigAction>["color"] =
					palette === candidate ? "green" : "yellow";
				return {
					label: `${palette === candidate ? "[x]" : "[ ]"} ${index + 1}. ${candidate === "green" ? "Green base" : "Blue base"}`,
					hint:
						candidate === "green"
							? "High-contrast default."
							: "Codex-style blue look.",
					value: { type: "set-palette", palette: candidate },
					color,
				};
			});
		const accentItems: MenuItem<ThemeConfigAction>[] =
			deps.ACCENT_COLOR_OPTIONS.map((candidate) => {
				const color: MenuItem<ThemeConfigAction>["color"] =
					accent === candidate ? "green" : "yellow";
				return {
					label: `${accent === candidate ? "[x]" : "[ ]"} ${candidate}`,
					value: { type: "set-accent", accent: candidate },
					color,
				};
			});

		const items: MenuItem<ThemeConfigAction>[] = [
			{
				label: deps.UI_COPY.settings.baseTheme,
				value: { type: "cancel" },
				kind: "heading",
			},
			...paletteItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: deps.UI_COPY.settings.accentColor,
				value: { type: "cancel" },
				kind: "heading",
			},
			...accentItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: deps.UI_COPY.settings.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: deps.UI_COPY.settings.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: deps.UI_COPY.settings.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];

		const initialCursor = items.findIndex((item) => {
			const value = item.value;
			if (value.type !== focus.type) return false;
			if (value.type === "set-palette" && focus.type === "set-palette") {
				return value.palette === focus.palette;
			}
			if (value.type === "set-accent" && focus.type === "set-accent") {
				return value.accent === focus.accent;
			}
			return true;
		});

		const result = await select<ThemeConfigAction>(items, {
			message: deps.UI_COPY.settings.themeTitle,
			subtitle: deps.UI_COPY.settings.themeSubtitle,
			help: deps.UI_COPY.settings.themeHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const item = items[cursor];
				if (item && !item.separator && item.kind !== "heading") {
					focus = item.value;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				if (raw === "1") return { type: "set-palette", palette: "green" };
				if (raw === "2") return { type: "set-palette", palette: "blue" };
				return undefined;
			},
		});

		if (!result || result.type === "cancel") {
			deps.applyUiThemeFromDashboardSettings(baseline);
			return null;
		}
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = deps.applyDashboardDefaultsForKeys(draft, deps.THEME_PANEL_KEYS);
			focus = { type: "set-palette", palette: draft.uiThemePreset ?? "green" };
			deps.applyUiThemeFromDashboardSettings(draft);
			continue;
		}
		if (result.type === "set-palette") {
			draft = { ...draft, uiThemePreset: result.palette };
			focus = result;
			deps.applyUiThemeFromDashboardSettings(draft);
			continue;
		}
		draft = { ...draft, uiAccentColor: result.accent };
		focus = result;
		deps.applyUiThemeFromDashboardSettings(draft);
	}
}
