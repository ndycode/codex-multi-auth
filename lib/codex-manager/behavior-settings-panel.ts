import { stdin as input, stdout as output } from "node:process";
import type { DashboardDisplaySettings } from "../dashboard-settings.js";
import type { UI_COPY } from "../ui/copy.js";
import { getUiRuntimeOptions } from "../ui/runtime.js";
import { type MenuItem, select } from "../ui/select.js";

export type BehaviorConfigAction =
	| { type: "set-delay"; delayMs: number }
	| { type: "toggle-pause" }
	| { type: "toggle-menu-limit-fetch" }
	| { type: "toggle-menu-fetch-status" }
	| { type: "set-menu-quota-ttl"; ttlMs: number }
	| { type: "reset" }
	| { type: "save" }
	| { type: "cancel" };

export interface BehaviorSettingsPanelDeps {
	cloneDashboardSettings: (
		settings: DashboardDisplaySettings,
	) => DashboardDisplaySettings;
	applyDashboardDefaultsForKeys: (
		draft: DashboardDisplaySettings,
		keys: readonly (keyof DashboardDisplaySettings)[],
	) => DashboardDisplaySettings;
	formatDelayLabel: (delayMs: number) => string;
	formatMenuQuotaTtl: (ttlMs: number) => string;
	AUTO_RETURN_OPTIONS_MS: readonly number[];
	MENU_QUOTA_TTL_OPTIONS_MS: readonly number[];
	BEHAVIOR_PANEL_KEYS: readonly (keyof DashboardDisplaySettings)[];
	UI_COPY: typeof UI_COPY;
}

export async function promptBehaviorSettingsPanel(
	initial: DashboardDisplaySettings,
	deps: BehaviorSettingsPanelDeps,
): Promise<DashboardDisplaySettings | null> {
	if (!input.isTTY || !output.isTTY) return null;
	const ui = getUiRuntimeOptions();
	let draft = deps.cloneDashboardSettings(initial);
	let focus: BehaviorConfigAction = {
		type: "set-delay",
		delayMs: draft.actionAutoReturnMs ?? 2_000,
	};

	while (true) {
		const currentDelay = draft.actionAutoReturnMs ?? 2_000;
		const pauseOnKey = draft.actionPauseOnKey ?? true;
		const autoFetchLimits = draft.menuAutoFetchLimits ?? true;
		const fetchStatusVisible = draft.menuShowFetchStatus ?? true;
		const menuQuotaTtlMs = draft.menuQuotaTtlMs ?? 5 * 60_000;
		const delayItems: MenuItem<BehaviorConfigAction>[] =
			deps.AUTO_RETURN_OPTIONS_MS.map((delayMs) => {
				const color: MenuItem<BehaviorConfigAction>["color"] =
					currentDelay === delayMs ? "green" : "yellow";
				return {
					label: `${currentDelay === delayMs ? "[x]" : "[ ]"} ${deps.formatDelayLabel(delayMs)}`,
					hint:
						delayMs === 1_000
							? "Fastest loop for frequent actions."
							: delayMs === 2_000
								? "Balanced default for most users."
								: "More time to read action output.",
					value: { type: "set-delay", delayMs },
					color,
				};
			});
		const pauseColor: MenuItem<BehaviorConfigAction>["color"] = pauseOnKey
			? "green"
			: "yellow";
		const items: MenuItem<BehaviorConfigAction>[] = [
			{
				label: deps.UI_COPY.settings.actionTiming,
				value: { type: "cancel" },
				kind: "heading",
			},
			...delayItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: `${pauseOnKey ? "[x]" : "[ ]"} Pause on key press`,
				hint: "Press any key to stop auto-return.",
				value: { type: "toggle-pause" },
				color: pauseColor,
			},
			{
				label: `${autoFetchLimits ? "[x]" : "[ ]"} Auto-fetch limits on menu open (5m cache)`,
				hint: "Refreshes account limits automatically when opening the menu.",
				value: { type: "toggle-menu-limit-fetch" },
				color: autoFetchLimits ? "green" : "yellow",
			},
			{
				label: `${fetchStatusVisible ? "[x]" : "[ ]"} Show limit refresh status`,
				hint: "Shows background fetch progress like [2/7] in menu subtitle.",
				value: { type: "toggle-menu-fetch-status" },
				color: fetchStatusVisible ? "green" : "yellow",
			},
			{
				label: `Limit cache TTL: ${deps.formatMenuQuotaTtl(menuQuotaTtlMs)}`,
				hint: "How fresh cached quota data must be before refresh runs.",
				value: { type: "set-menu-quota-ttl", ttlMs: menuQuotaTtlMs },
				color: "yellow",
			},
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
			if (value.type === "set-delay" && focus.type === "set-delay") {
				return value.delayMs === focus.delayMs;
			}
			return true;
		});

		const result = await select<BehaviorConfigAction>(items, {
			message: deps.UI_COPY.settings.behaviorTitle,
			subtitle: deps.UI_COPY.settings.behaviorSubtitle,
			help: deps.UI_COPY.settings.behaviorHelp,
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
				if (lower === "p") return { type: "toggle-pause" };
				if (lower === "l") return { type: "toggle-menu-limit-fetch" };
				if (lower === "f") return { type: "toggle-menu-fetch-status" };
				if (lower === "t")
					return { type: "set-menu-quota-ttl", ttlMs: menuQuotaTtlMs };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= deps.AUTO_RETURN_OPTIONS_MS.length
				) {
					const delayMs = deps.AUTO_RETURN_OPTIONS_MS[parsed - 1];
					if (typeof delayMs === "number")
						return { type: "set-delay", delayMs };
				}
				return undefined;
			},
		});

		if (!result || result.type === "cancel") return null;
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = deps.applyDashboardDefaultsForKeys(
				draft,
				deps.BEHAVIOR_PANEL_KEYS,
			);
			focus = { type: "set-delay", delayMs: draft.actionAutoReturnMs ?? 2_000 };
			continue;
		}
		if (result.type === "toggle-pause") {
			draft = { ...draft, actionPauseOnKey: !(draft.actionPauseOnKey ?? true) };
			focus = result;
			continue;
		}
		if (result.type === "toggle-menu-limit-fetch") {
			draft = {
				...draft,
				menuAutoFetchLimits: !(draft.menuAutoFetchLimits ?? true),
			};
			focus = result;
			continue;
		}
		if (result.type === "toggle-menu-fetch-status") {
			draft = {
				...draft,
				menuShowFetchStatus: !(draft.menuShowFetchStatus ?? true),
			};
			focus = result;
			continue;
		}
		if (result.type === "set-menu-quota-ttl") {
			const currentIndex = deps.MENU_QUOTA_TTL_OPTIONS_MS.findIndex(
				(value) => value === menuQuotaTtlMs,
			);
			const nextIndex =
				currentIndex < 0
					? 0
					: (currentIndex + 1) % deps.MENU_QUOTA_TTL_OPTIONS_MS.length;
			const nextTtl =
				deps.MENU_QUOTA_TTL_OPTIONS_MS[nextIndex] ??
				deps.MENU_QUOTA_TTL_OPTIONS_MS[0] ??
				menuQuotaTtlMs;
			draft = { ...draft, menuQuotaTtlMs: nextTtl };
			focus = { type: "set-menu-quota-ttl", ttlMs: nextTtl };
			continue;
		}
		draft = { ...draft, actionAutoReturnMs: result.delayMs };
		focus = result;
	}
}
