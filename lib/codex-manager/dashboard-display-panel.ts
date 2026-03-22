import { stdin as input, stdout as output } from "node:process";
import {
	type DashboardAccountSortMode,
	type DashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
} from "../dashboard-settings.js";
import type { UI_COPY } from "../ui/copy.js";
import { getUiRuntimeOptions } from "../ui/runtime.js";
import { type MenuItem, select } from "../ui/select.js";

export type DashboardDisplaySettingKey =
	| "menuShowStatusBadge"
	| "menuShowCurrentBadge"
	| "menuShowLastUsed"
	| "menuShowQuotaSummary"
	| "menuShowQuotaCooldown"
	| "menuShowDetailsForUnselectedRows"
	| "menuShowFetchStatus"
	| "menuHighlightCurrentRow"
	| "menuSortEnabled"
	| "menuSortPinCurrent"
	| "menuSortQuickSwitchVisibleRow";

export interface DashboardDisplaySettingOption {
	key: DashboardDisplaySettingKey;
	label: string;
	description: string;
}

export type DashboardConfigAction =
	| { type: "toggle"; key: DashboardDisplaySettingKey }
	| { type: "cycle-sort-mode" }
	| { type: "cycle-layout-mode" }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

export interface DashboardDisplayPanelDeps {
	cloneDashboardSettings: (
		settings: DashboardDisplaySettings,
	) => DashboardDisplaySettings;
	buildAccountListPreview: (
		settings: DashboardDisplaySettings,
		ui: ReturnType<typeof getUiRuntimeOptions>,
		focusKey: DashboardDisplaySettingKey | "menuSortMode" | "menuLayoutMode",
	) => { label: string; hint?: string };
	formatDashboardSettingState: (enabled: boolean) => string;
	formatMenuSortMode: (mode: DashboardAccountSortMode) => string;
	resolveMenuLayoutMode: (
		settings: DashboardDisplaySettings,
	) => "compact-details" | "expanded-rows";
	formatMenuLayoutMode: (mode: "compact-details" | "expanded-rows") => string;
	applyDashboardDefaultsForKeys: (
		draft: DashboardDisplaySettings,
		keys: readonly (keyof DashboardDisplaySettings)[],
	) => DashboardDisplaySettings;
	DASHBOARD_DISPLAY_OPTIONS: readonly DashboardDisplaySettingOption[];
	ACCOUNT_LIST_PANEL_KEYS: readonly (keyof DashboardDisplaySettings)[];
	UI_COPY: typeof UI_COPY;
}

export async function promptDashboardDisplayPanel(
	initial: DashboardDisplaySettings,
	deps: DashboardDisplayPanelDeps,
): Promise<DashboardDisplaySettings | null> {
	if (!input.isTTY || !output.isTTY) return null;

	const ui = getUiRuntimeOptions();
	let draft = deps.cloneDashboardSettings(initial);
	let focusKey: DashboardDisplaySettingKey | "menuSortMode" | "menuLayoutMode" =
		deps.DASHBOARD_DISPLAY_OPTIONS[0]?.key ?? "menuShowStatusBadge";

	while (true) {
		const preview = deps.buildAccountListPreview(draft, ui, focusKey);
		const optionItems: MenuItem<DashboardConfigAction>[] =
			deps.DASHBOARD_DISPLAY_OPTIONS.map((option, index) => {
				const enabled = draft[option.key] ?? true;
				return {
					label: `${deps.formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}`,
					hint: option.description,
					value: { type: "toggle", key: option.key },
					color: enabled ? "green" : "yellow",
				};
			});
		const sortMode =
			draft.menuSortMode ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
			"ready-first";
		const sortModeItem: MenuItem<DashboardConfigAction> = {
			label: `Sort mode: ${deps.formatMenuSortMode(sortMode)}`,
			hint: "Applies when smart sort is enabled.",
			value: { type: "cycle-sort-mode" },
			color: sortMode === "ready-first" ? "green" : "yellow",
		};
		const layoutMode = deps.resolveMenuLayoutMode(draft);
		const layoutModeItem: MenuItem<DashboardConfigAction> = {
			label: `Layout: ${deps.formatMenuLayoutMode(layoutMode)}`,
			hint: "Compact shows one-line rows with a selected details pane.",
			value: { type: "cycle-layout-mode" },
			color: layoutMode === "compact-details" ? "green" : "yellow",
		};
		const items: MenuItem<DashboardConfigAction>[] = [
			{
				label: deps.UI_COPY.settings.previewHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "cancel" },
				color: "green",
				disabled: true,
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: deps.UI_COPY.settings.displayHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			...optionItems,
			sortModeItem,
			layoutModeItem,
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

		const initialCursor = items.findIndex(
			(item) =>
				(item.value.type === "toggle" && item.value.key === focusKey) ||
				(item.value.type === "cycle-sort-mode" &&
					focusKey === "menuSortMode") ||
				(item.value.type === "cycle-layout-mode" &&
					focusKey === "menuLayoutMode"),
		);

		const updateFocusedPreview = (cursor: number) => {
			const focusedItem = items[cursor];
			const focused =
				focusedItem?.value.type === "toggle"
					? focusedItem.value.key
					: focusedItem?.value.type === "cycle-sort-mode"
						? "menuSortMode"
						: focusedItem?.value.type === "cycle-layout-mode"
							? "menuLayoutMode"
							: focusKey;
			const nextPreview = deps.buildAccountListPreview(draft, ui, focused);
			const previewItem = items[1];
			if (!previewItem) return;
			previewItem.label = nextPreview.label;
			previewItem.hint = nextPreview.hint;
		};

		const result = await select<DashboardConfigAction>(items, {
			message: deps.UI_COPY.settings.accountListTitle,
			subtitle: deps.UI_COPY.settings.accountListSubtitle,
			help: deps.UI_COPY.settings.accountListHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (focusedItem?.value.type === "toggle")
					focusKey = focusedItem.value.key;
				else if (focusedItem?.value.type === "cycle-sort-mode")
					focusKey = "menuSortMode";
				else if (focusedItem?.value.type === "cycle-layout-mode")
					focusKey = "menuLayoutMode";
				updateFocusedPreview(cursor);
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				if (lower === "m") return { type: "cycle-sort-mode" };
				if (lower === "l") return { type: "cycle-layout-mode" };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= deps.DASHBOARD_DISPLAY_OPTIONS.length
				) {
					const target = deps.DASHBOARD_DISPLAY_OPTIONS[parsed - 1];
					if (target) return { type: "toggle", key: target.key };
				}
				if (parsed === deps.DASHBOARD_DISPLAY_OPTIONS.length + 1)
					return { type: "cycle-sort-mode" };
				if (parsed === deps.DASHBOARD_DISPLAY_OPTIONS.length + 2)
					return { type: "cycle-layout-mode" };
				return undefined;
			},
		});

		if (!result || result.type === "cancel") return null;
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = deps.applyDashboardDefaultsForKeys(
				draft,
				deps.ACCOUNT_LIST_PANEL_KEYS,
			);
			focusKey = deps.DASHBOARD_DISPLAY_OPTIONS[0]?.key ?? focusKey;
			continue;
		}
		if (result.type === "cycle-sort-mode") {
			const currentMode =
				draft.menuSortMode ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
				"ready-first";
			const nextMode: DashboardAccountSortMode =
				currentMode === "ready-first" ? "manual" : "ready-first";
			draft = {
				...draft,
				menuSortMode: nextMode,
				menuSortEnabled:
					nextMode === "ready-first"
						? true
						: (draft.menuSortEnabled ??
							DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
							true),
			};
			focusKey = "menuSortMode";
			continue;
		}
		if (result.type === "cycle-layout-mode") {
			const currentLayout = deps.resolveMenuLayoutMode(draft);
			const nextLayout =
				currentLayout === "compact-details"
					? "expanded-rows"
					: "compact-details";
			draft = {
				...draft,
				menuLayoutMode: nextLayout,
				menuShowDetailsForUnselectedRows: nextLayout === "expanded-rows",
			};
			focusKey = "menuLayoutMode";
			continue;
		}
		focusKey = result.key;
		draft = { ...draft, [result.key]: !draft[result.key] };
	}
}
