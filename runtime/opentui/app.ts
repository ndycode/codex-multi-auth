import {
	BoxRenderable,
	SelectRenderable,
	SelectRenderableEvents,
	TextRenderable,
	type CliRenderer,
	type KeyEvent,
	type SelectOption,
	type Selection,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { AuthDashboardViewModel } from "../../lib/codex-manager/auth-ui-controller.js";
import {
	ACCENT_COLOR_OPTIONS,
	AUTO_RETURN_OPTIONS_MS,
	BACKEND_CATEGORY_OPTIONS,
	BACKEND_NUMBER_OPTIONS,
	BACKEND_TOGGLE_OPTIONS,
	DASHBOARD_DISPLAY_OPTIONS,
	MENU_QUOTA_TTL_OPTIONS_MS,
	STATUSLINE_FIELD_OPTIONS,
	THEME_PRESET_OPTIONS,
	buildSettingsHubViewModel,
	resolveSettingsHubCommand,
	type BackendCategoryKey,
	type BackendNumberSettingKey,
	type BackendToggleSettingKey,
	type SettingsHubAction,
} from "../../lib/codex-manager/settings-ui-controller.js";
import {
	applyDashboardDefaultsForKeys,
	applyUiThemeFromDashboardSettings,
	clampBackendNumber,
	cloneBackendPluginConfig,
	cloneDashboardSettings,
	formatBackendNumberValue,
	formatDashboardSettingState,
	formatMenuLayoutMode,
	formatMenuQuotaTtl,
	formatMenuSortMode,
	normalizeStatuslineFields,
	resolveMenuLayoutMode,
} from "../../lib/codex-manager/settings-hub.js";
import {
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	type DashboardAccentColor,
	type DashboardAccountSortMode,
	type DashboardDisplaySettings,
	type DashboardLayoutMode,
	type DashboardStatuslineField,
	type DashboardThemePreset,
} from "../../lib/dashboard-settings.js";
import { getDefaultPluginConfig } from "../../lib/config.js";
import type { PluginConfig } from "../../lib/types.js";
import { UI_COPY } from "../../lib/ui/copy.js";
import {
	buildOpenTuiAccountDetailPanel,
	buildOpenTuiAccountOptions,
	createDefaultOpenTuiDashboard,
	filterOpenTuiDashboardAccounts,
	resolveOpenTuiAccountSourceIndex,
	resolveOpenTuiDashboardStatus,
	resolveOpenTuiQuickSwitchAccount,
} from "./account-workspace.js";

const SHELL_TOKENS = {
	background: "#08111b",
	panelBackground: "#0d1824",
	border: "#223244",
	text: "#d8e4f0",
	muted: "#75859a",
	accent: "#7dd3fc",
	focusBackground: "#14314a",
	focusText: "#f8fbff",
	selectedBackground: "#102537",
	selectedText: "#a8dafb",
	statusBackground: "#09131e",
	statusText: "#9db2c7",
	success: "#8ee59b",
	warning: "#f5cb5c",
	danger: "#f38ba8",
} as const;

const DEFAULT_NAV_OPTIONS: SelectOption[] = [
	{ name: "Accounts", description: "Saved accounts workspace" },
	{ name: "Add", description: "Launch OAuth sign-in" },
	{ name: "Check", description: "Run live account check" },
	{ name: "Settings", description: "Open settings flow" },
	{ name: "Forecast", description: "Preview best next account" },
	{ name: "Fix", description: "Run safe repair flow" },
	{ name: "Verify", description: "Review flagged accounts" },
	{ name: "Deep Check", description: "Force refresh validation" },
	{ name: "Help", description: "Keyboard reference" },
];

type OpenTuiWorkspacePanel = {
	eyebrow: string;
	title: string;
	subtitle: string;
	hint: string;
	statusLabel: string;
	options: SelectOption[];
};

type OpenTuiDetailContent = {
	eyebrow: string;
	title: string;
	subtitle: string;
	metaLines: string[];
	actionLines: string[];
	tone: "text" | "success" | "warning" | "danger";
};

type OpenTuiShellLayoutDensity = "default" | "compact";

type OpenTuiShellLayout = {
	density: OpenTuiShellLayoutDensity;
	navWidth: number;
	workspacePaddingLeft: number;
	workspaceGapWidth: number;
	detailWidth: number;
	detailPaddingLeft: number;
	hideEyebrows: boolean;
	detailMetaLimit: number;
	detailActionLimit: number;
};

const COMPACT_SHELL_MAX_WIDTH = 72;

function resolveShellLayout(width: number): OpenTuiShellLayout {
	if (width <= COMPACT_SHELL_MAX_WIDTH) {
		return {
			density: "compact",
			navWidth: 16,
			workspacePaddingLeft: 1,
			workspaceGapWidth: 1,
			detailWidth: 24,
			detailPaddingLeft: 1,
			hideEyebrows: true,
			detailMetaLimit: 3,
			detailActionLimit: 4,
		};
	}

	return {
		density: "default",
		navWidth: 18,
		workspacePaddingLeft: 2,
		workspaceGapWidth: 2,
		detailWidth: 27,
		detailPaddingLeft: 2,
		hideEyebrows: false,
		detailMetaLimit: 7,
		detailActionLimit: 5,
	};
}

const OVERLAY_HOST_OPTIONS: Record<string, OpenTuiWorkspacePanel> = {
	Add: {
		eyebrow: "workflow / add",
		title: "Add account",
		subtitle: "Launch a new OAuth sign-in without leaving the auth shell.",
		hint: "Press Enter to continue or Left to choose a different route.",
		statusLabel: "action-ready",
		options: [
			{ name: "Open the browser-first login flow", description: "Adds another saved account" },
		],
	},
	Check: {
		eyebrow: "workflow / check",
		title: "Quick health check",
		subtitle: "Run the live session check for the current saved pool.",
		hint: "Press Enter to run the check command.",
		statusLabel: "action-ready",
		options: [
			{ name: "Live probe + refresh fallback", description: "Same result contract as the CLI command" },
		],
	},
	Forecast: {
		eyebrow: "workflow / forecast",
		title: "Forecast next account",
		subtitle: "Preview readiness and recommendation signals before switching.",
		hint: "Press Enter to run the forecast panel.",
		statusLabel: "action-ready",
		options: [
			{ name: "Best-account preview", description: "Uses the shared forecast controller" },
		],
	},
	Fix: {
		eyebrow: "workflow / fix",
		title: "Repair account pool",
		subtitle: "Run the safe fix flow without leaving the shell entrypoint.",
		hint: "Press Enter to apply the existing fix command path.",
		statusLabel: "action-ready",
		options: [
			{ name: "Safe repair flow", description: "Disables hard failures and keeps deterministic output" },
		],
	},
	Verify: {
		eyebrow: "workflow / verify",
		title: "Verify flagged accounts",
		subtitle: "Review recoverable flagged accounts before restoring them.",
		hint: "Press Enter to run the flagged-account verification flow.",
		statusLabel: "action-ready",
		options: [
			{ name: "Flagged account verification", description: "Shared restore-safe flow" },
		],
	},
	"Deep Check": {
		eyebrow: "workflow / deep-check",
		title: "Deep refresh validation",
		subtitle: "Force refresh testing for every account in the current pool.",
		hint: "Press Enter to run the deep-check command path.",
		statusLabel: "action-ready",
		options: [
			{ name: "Full refresh test", description: "Confirms refresh-token health across the pool" },
		],
	},
	Help: {
		eyebrow: "overlay / help",
		title: "Keyboard reference",
		subtitle: "The auth shell routes commands and account actions without leaving the workspace.",
		hint: "Use the rail for add/check/forecast/fix/settings and the account pane for quick actions.",
		statusLabel: "overlay-ready",
		options: [
			{ name: "Tab or Left/Right switches panes", description: "Focus remains deterministic" },
			{ name: "/ searches visible rows and 1-9 quick switches", description: "Filtered rows keep source-index mapping" },
			{ name: "S/R/E/D act on the selected account", description: "Current, re-login, toggle, delete" },
			{ name: "Q or Esc exits cleanly", description: "Renderer teardown stays owned by the shell" },
		],
	},
	Settings: {
		eyebrow: "workflow / settings",
		title: "Settings entry",
		subtitle: "Route into the shared interactive settings flow from the OpenTUI shell.",
		hint: "Press Enter to continue or Right if you want to inspect the drawer host.",
		statusLabel: "action-ready",
		options: [
			{ name: "Open shared settings flow", description: "Preserves save, reset, and cancel contracts" },
			{ name: "Drawer host stays mounted", description: "The shell still owns settings layout state" },
		],
	},
};

export type OpenTuiShellTimer = unknown;

export type OpenTuiShellClock = {
	setInterval: (callback: () => void, intervalMs: number) => OpenTuiShellTimer;
	clearInterval: (timer: OpenTuiShellTimer) => void;
};

export type OpenTuiShellExitReason = "escape" | "quit";

export type OpenTuiShellFocusTarget = "nav" | "workspace";

export type OpenTuiShellSelection = {
	navIndex: number;
	navLabel: string;
	accountIndex: number;
	accountLabel: string;
	focusTarget: OpenTuiShellFocusTarget;
};

export type OpenTuiShellReadyContext = {
	renderer: CliRenderer;
	rootRef: BoxRenderable;
	navRef: SelectRenderable;
	accountListRef: SelectRenderable;
	statusLineRef: TextRenderable;
	modalHostRef: BoxRenderable;
	focusedRenderable: SelectRenderable | null;
	focusTarget: OpenTuiShellFocusTarget;
};

export type OpenTuiWorkspaceAction =
	| { type: "quick-switch"; sourceIndex: number }
	| { type: "search"; active: boolean; query: string };

export type OpenTuiBootstrapAppProps = {
	clock?: OpenTuiShellClock;
	dashboard?: AuthDashboardViewModel;
	navOptions?: SelectOption[];
	onExit?: (reason: OpenTuiShellExitReason, renderer: CliRenderer) => void;
	onKeyPress?: (keyEvent: KeyEvent) => void;
	onReady?: (context: OpenTuiShellReadyContext) => void;
	onRendererSelection?: (selection: Selection) => void;
	onSelectionChange?: (selection: OpenTuiShellSelection) => void;
	onSettingsSave?: (event: OpenTuiSettingsSaveEvent) => void;
	onWorkspaceAction?: (action: OpenTuiWorkspaceAction) => void;
};

const defaultClock: OpenTuiShellClock = {
	setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
	clearInterval: (timer) => {
		globalThis.clearInterval(timer as ReturnType<typeof globalThis.setInterval>);
	},
};

function createWorkspacePanel(navLabel: string): OpenTuiWorkspacePanel {
	if (navLabel === "Accounts") {
		return {
			eyebrow: "workspace / accounts",
			title: "Account workspace",
			subtitle: "Compact one-line rows with search and visible-row quick switch.",
			hint: "/ search | 1-9 quick switch | Enter reserves the detail seam",
			statusLabel: "live",
			options: [],
		};
	}

	return OVERLAY_HOST_OPTIONS[navLabel] ?? {
		eyebrow: "workspace",
		title: navLabel,
		subtitle: "Placeholder workspace",
		hint: "Reserved shell route.",
		statusLabel: "idle",
		options: [],
	};
}

function createSelectionSnapshot(
	navOptions: SelectOption[],
	workspaceOptions: SelectOption[],
	navIndex: number,
	accountIndex: number,
	focusTarget: OpenTuiShellFocusTarget,
): OpenTuiShellSelection {
	return {
		navIndex,
		navLabel: navOptions[navIndex]?.name ?? "",
		accountIndex,
		accountLabel: workspaceOptions[accountIndex]?.name ?? "",
		focusTarget,
	};
}

function clampSelection(index: number, optionCount: number): number {
	if (optionCount <= 0) {
		return 0;
	}

	return Math.max(0, Math.min(index, optionCount - 1));
}

function createStatusLine(selection: {
	navLabel: string;
	focusTarget: OpenTuiShellFocusTarget;
	uptimeSeconds: number;
	statusLabel: string;
	accountLabel?: string;
	searchMode?: boolean;
	searchQuery?: string;
	visibleAccountCount?: number;
	totalAccountCount?: number;
}): string {
	const focusedPaneLabel = selection.focusTarget === "workspace" ? "workspace" : "rail";
	if (selection.navLabel === "Accounts") {
		const searchState = selection.searchMode
			? `search ${selection.searchQuery && selection.searchQuery.length > 0 ? selection.searchQuery : "_"}`
			: selection.searchQuery && selection.searchQuery.length > 0
				? `filter ${selection.searchQuery}`
				: "/ search";
		return `accounts | focus ${focusedPaneLabel} | rows ${selection.visibleAccountCount ?? 0}/${selection.totalAccountCount ?? 0} | ${searchState} | 1-9 switch | s/r/e/d selected | tab routes | q quit`;
	}
	const activeRow = selection.accountLabel && selection.accountLabel.length > 0 ? selection.accountLabel : "no row";
	return `${selection.navLabel.toLowerCase()} | focus ${focusedPaneLabel} | ${selection.statusLabel} ${selection.uptimeSeconds}s | ${activeRow} | tab switch pane | q quit`;
}

function resolveDetailTone(statusLabel: string): OpenTuiDetailContent["tone"] {
	if (statusLabel.includes("danger") || statusLabel.includes("flag") || statusLabel.includes("error")) {
		return "danger";
	}
	if (statusLabel.includes("warning") || statusLabel.includes("limit") || statusLabel.includes("cool")) {
		return "warning";
	}
	if (statusLabel.includes("active") || statusLabel.includes("ready") || statusLabel.includes("live")) {
		return "success";
	}
	return "text";
}

function resolveDetailToneColor(tone: OpenTuiDetailContent["tone"]): string {
	switch (tone) {
		case "success":
			return SHELL_TOKENS.success;
		case "warning":
			return SHELL_TOKENS.warning;
		case "danger":
			return SHELL_TOKENS.danger;
		default:
			return SHELL_TOKENS.text;
	}
}

function createPanelDetailContent(panel: OpenTuiWorkspacePanel): OpenTuiDetailContent {
	return {
		eyebrow: panel.eyebrow,
		title: panel.title,
		subtitle: panel.statusLabel,
		metaLines: [panel.subtitle, panel.hint],
		actionLines: panel.options.map((option) => option.name),
		tone: panel.statusLabel.includes("ready") ? "warning" : "text",
	};
}

type OpenTuiDashboardPanelId = "account-list" | "summary-fields" | "behavior" | "theme";

export type OpenTuiSettingsSaveEvent =
	| {
		kind: "dashboard";
		panel: OpenTuiDashboardPanelId;
		selected: DashboardDisplaySettings;
	}
	| {
		kind: "backend";
		selected: PluginConfig;
	};

type OpenTuiDrawerEntry = {
	id: string;
	label: string;
};

type OpenTuiDrawerState =
	| { type: "closed" }
	| { type: "hub"; cursor: number }
	| {
		type: "dashboard-panel";
		panel: OpenTuiDashboardPanelId;
		cursor: number;
		draft: DashboardDisplaySettings;
		hubCursor: number;
		themeBaseline: DashboardDisplaySettings;
	}
	| {
		type: "backend-hub";
		cursor: number;
		draft: PluginConfig;
		baseline: PluginConfig;
		hubCursor: number;
	}
	| {
		type: "backend-category";
		categoryKey: BackendCategoryKey;
		cursor: number;
		draft: PluginConfig;
		baseline: PluginConfig;
		hubCursor: number;
		backendCursor: number;
	};

type OpenTuiDrawerView = {
	title: string;
	subtitle: string;
	lines: string[];
	footer: string;
};

const BACKEND_DEFAULTS = getDefaultPluginConfig();
const BACKEND_CATEGORY_OPTION_BY_KEY = new Map(
	BACKEND_CATEGORY_OPTIONS.map((category) => [category.key, category]),
);
const BACKEND_NUMBER_OPTION_BY_KEY = new Map(
	BACKEND_NUMBER_OPTIONS.map((option) => [option.key, option]),
);
const SETTINGS_HUB_VIEW_MODEL = buildSettingsHubViewModel();
const SETTINGS_HUB_ACTIONS = SETTINGS_HUB_VIEW_MODEL.sections.flatMap((section) => section.actions);

function wrapCursor(current: number, direction: -1 | 1, count: number): number {
	if (count <= 0) return 0;
	return (current + direction + count) % count;
}

function isEnterKey(name: string | undefined): boolean {
	return name === "enter" || name === "return";
}

function formatDrawerEntry(entry: OpenTuiDrawerEntry, index: number, cursor: number): string {
	const prefix = index === cursor ? ">" : " ";
	return `${prefix} ${entry.label}`;
}

function buildSettingsHubLines(cursor: number): string[] {
	return [
		"Customize menu, behavior, and",
		"backend",
		...SETTINGS_HUB_ACTIONS.map((action, entryIndex) => {
			const labelIndex = entryIndex < 5 ? `${entryIndex + 1}. ` : "";
			return `${entryIndex === cursor ? ">" : " "} ${labelIndex}${action.label}`;
		}),
	];
}

function buildAccountListDrawerEntries(draft: DashboardDisplaySettings): OpenTuiDrawerEntry[] {
	const sortMode = draft.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first");
	const layoutMode = resolveMenuLayoutMode(draft);
	return [
		...DASHBOARD_DISPLAY_OPTIONS.map((option, index) => ({
			id: option.key,
			label: `${formatDashboardSettingState(draft[option.key] ?? true)} ${index + 1}. ${option.label}`,
		})),
		{ id: "sort-mode", label: `Sort mode: ${formatMenuSortMode(sortMode)}` },
		{ id: "layout-mode", label: `Layout: ${formatMenuLayoutMode(layoutMode)}` },
		{ id: "reset", label: UI_COPY.settings.resetDefault },
		{ id: "save", label: UI_COPY.settings.saveAndBack },
		{ id: "cancel", label: UI_COPY.settings.backNoSave },
	];
}

function buildSummaryDrawerEntries(draft: DashboardDisplaySettings): OpenTuiDrawerEntry[] {
	const selectedSet = new Set(normalizeStatuslineFields(draft.menuStatuslineFields));
	const ordered = normalizeStatuslineFields(draft.menuStatuslineFields);
	const orderMap = new Map<DashboardStatuslineField, number>();
	for (let index = 0; index < ordered.length; index += 1) {
		const key = ordered[index];
		if (key) orderMap.set(key, index + 1);
	}
	return [
		...STATUSLINE_FIELD_OPTIONS.map((option, index) => ({
			id: option.key,
			label: `${formatDashboardSettingState(selectedSet.has(option.key))} ${index + 1}. ${option.label}${orderMap.get(option.key) ? ` (order ${orderMap.get(option.key)})` : ""}`,
		})),
		{ id: "reset", label: UI_COPY.settings.resetDefault },
		{ id: "save", label: UI_COPY.settings.saveAndBack },
		{ id: "cancel", label: UI_COPY.settings.backNoSave },
	];
}

function buildBehaviorDrawerEntries(draft: DashboardDisplaySettings): OpenTuiDrawerEntry[] {
	const currentDelay = draft.actionAutoReturnMs ?? 2_000;
	const pauseOnKey = draft.actionPauseOnKey ?? true;
	const autoFetchLimits = draft.menuAutoFetchLimits ?? true;
	const fetchStatusVisible = draft.menuShowFetchStatus ?? true;
	const menuQuotaTtlMs = draft.menuQuotaTtlMs ?? 5 * 60_000;
	return [
		...AUTO_RETURN_OPTIONS_MS.map((delayMs, index) => ({
			id: `delay:${delayMs}`,
			label: `${currentDelay === delayMs ? "[x]" : "[ ]"} ${index + 1}. ${delayMs <= 0 ? "Instant return" : `${Math.round(delayMs / 1_000)}s auto-return`}`,
		})),
		{ id: "pause", label: `${pauseOnKey ? "[x]" : "[ ]"} Pause on key press` },
		{
			id: "auto-fetch",
			label: `${autoFetchLimits ? "[x]" : "[ ]"} Auto-fetch limits on menu open (${formatMenuQuotaTtl(menuQuotaTtlMs)} cache)`,
		},
		{ id: "fetch-status", label: `${fetchStatusVisible ? "[x]" : "[ ]"} Show limit refresh status` },
		{ id: "ttl", label: `Limit cache TTL: ${formatMenuQuotaTtl(menuQuotaTtlMs)}` },
		{ id: "reset", label: UI_COPY.settings.resetDefault },
		{ id: "save", label: UI_COPY.settings.saveAndBack },
		{ id: "cancel", label: UI_COPY.settings.backNoSave },
	];
}

function buildThemeDrawerEntries(draft: DashboardDisplaySettings): OpenTuiDrawerEntry[] {
	return [
		...THEME_PRESET_OPTIONS.map((candidate, index) => ({
			id: `palette:${candidate}`,
			label: `${draft.uiThemePreset === candidate ? "[x]" : "[ ]"} ${index + 1}. ${candidate === "green" ? "Green base" : "Blue base"}`,
		})),
		...ACCENT_COLOR_OPTIONS.map((candidate) => ({
			id: `accent:${candidate}`,
			label: `${draft.uiAccentColor === candidate ? "[x]" : "[ ]"} ${candidate}`,
		})),
		{ id: "reset", label: UI_COPY.settings.resetDefault },
		{ id: "save", label: UI_COPY.settings.saveAndBack },
		{ id: "cancel", label: UI_COPY.settings.backNoSave },
	];
}

function buildBackendHubEntries(): OpenTuiDrawerEntry[] {
	return [
		...BACKEND_CATEGORY_OPTIONS.map((category, index) => ({
			id: `category:${category.key}`,
			label: `${index + 1}. ${category.label}`,
		})),
		{ id: "reset", label: UI_COPY.settings.resetDefault },
		{ id: "save", label: UI_COPY.settings.saveAndBack },
		{ id: "cancel", label: UI_COPY.settings.backNoSave },
	];
}

function buildBackendCategoryEntries(categoryKey: BackendCategoryKey, draft: PluginConfig): OpenTuiDrawerEntry[] {
	const category = BACKEND_CATEGORY_OPTION_BY_KEY.get(categoryKey);
	if (!category) return [];
	const toggleEntries = category.toggleKeys.map((key, index) => {
		const option = BACKEND_TOGGLE_OPTIONS.find((candidate) => candidate.key === key);
		const enabled = draft[key] ?? BACKEND_DEFAULTS[key] ?? false;
		return {
			id: `toggle:${key}`,
			label: `${formatDashboardSettingState(enabled)} ${index + 1}. ${option?.label ?? key}`,
		};
	});
	const numberEntries = category.numberKeys.flatMap((key) => {
		const option = BACKEND_NUMBER_OPTION_BY_KEY.get(key);
		if (!option) return [];
		const rawValue = draft[key] ?? BACKEND_DEFAULTS[key] ?? option.min;
		const numericValue = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : option.min;
		return [{
			id: `number:${key}`,
			label: `${option.label}: ${formatBackendNumberValue(option, clampBackendNumber(option, numericValue))}`,
		}];
	});
	return [
		...toggleEntries,
		...numberEntries,
		{ id: "reset", label: UI_COPY.settings.backendResetCategory },
		{ id: "back", label: UI_COPY.settings.backendBackToCategories },
	];
}

function cycleSortMode(draft: DashboardDisplaySettings): DashboardDisplaySettings {
	const currentMode = draft.menuSortMode ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first");
	const nextMode: DashboardAccountSortMode = currentMode === "ready-first" ? "manual" : "ready-first";
	return {
		...draft,
		menuSortMode: nextMode,
		menuSortEnabled: nextMode === "ready-first"
			? true
			: (draft.menuSortEnabled ?? (DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? true)),
	};
}

function cycleLayoutMode(draft: DashboardDisplaySettings): DashboardDisplaySettings {
	const currentLayout = resolveMenuLayoutMode(draft);
	const nextLayout: DashboardLayoutMode = currentLayout === "compact-details"
		? "expanded-rows"
		: "compact-details";
	return {
		...draft,
		menuLayoutMode: nextLayout,
		menuShowDetailsForUnselectedRows: nextLayout === "expanded-rows",
	};
}

function reorderStatuslineField(
	draft: DashboardDisplaySettings,
	field: DashboardStatuslineField,
	direction: -1 | 1,
): DashboardDisplaySettings {
	const fields = [...normalizeStatuslineFields(draft.menuStatuslineFields)];
	const index = fields.indexOf(field);
	const target = index + direction;
	if (index < 0 || target < 0 || target >= fields.length) return draft;
	const current = fields[index];
	const swap = fields[target];
	if (!current || !swap) return draft;
	fields[index] = swap;
	fields[target] = current;
	return {
		...draft,
		menuStatuslineFields: fields,
	};
}

function applyBackendCategoryDefaults(draft: PluginConfig, categoryKey: BackendCategoryKey): PluginConfig {
	const category = BACKEND_CATEGORY_OPTION_BY_KEY.get(categoryKey);
	if (!category) return cloneBackendPluginConfig(draft);
	const next = cloneBackendPluginConfig(draft);
	for (const key of category.toggleKeys) {
		next[key] = BACKEND_DEFAULTS[key] ?? false;
	}
	for (const key of category.numberKeys) {
		const option = BACKEND_NUMBER_OPTION_BY_KEY.get(key);
		next[key] = BACKEND_DEFAULTS[key] ?? option?.min ?? 0;
	}
	return next;
}

function buildDrawerView(state: OpenTuiDrawerState): OpenTuiDrawerView {
	if (state.type === "closed") {
		return {
			title: "Overlay host",
			subtitle: "Hidden until search/help/settings attach.",
			lines: [],
			footer: "",
		};
	}
	if (state.type === "hub") {
		return {
			title: "Settings host",
			subtitle: "",
			lines: buildSettingsHubLines(state.cursor),
			footer: UI_COPY.settings.help,
		};
	}
	if (state.type === "dashboard-panel") {
		const entries = state.panel === "account-list"
			? buildAccountListDrawerEntries(state.draft)
			: state.panel === "summary-fields"
				? buildSummaryDrawerEntries(state.draft)
				: state.panel === "behavior"
					? buildBehaviorDrawerEntries(state.draft)
					: buildThemeDrawerEntries(state.draft);
		return {
			title: state.panel === "account-list"
				? UI_COPY.settings.accountListTitle
				: state.panel === "summary-fields"
					? UI_COPY.settings.summaryTitle
					: state.panel === "behavior"
						? UI_COPY.settings.behaviorTitle
						: UI_COPY.settings.themeTitle,
			subtitle: state.panel === "account-list"
				? UI_COPY.settings.accountListSubtitle
				: state.panel === "summary-fields"
					? UI_COPY.settings.summarySubtitle
					: state.panel === "behavior"
						? UI_COPY.settings.behaviorSubtitle
						: UI_COPY.settings.themeSubtitle,
			lines: entries.map((entry, index) => formatDrawerEntry(entry, index, state.cursor)),
			footer: state.panel === "account-list"
				? UI_COPY.settings.accountListHelp
				: state.panel === "summary-fields"
					? UI_COPY.settings.summaryHelp
					: state.panel === "behavior"
						? UI_COPY.settings.behaviorHelp
						: UI_COPY.settings.themeHelp,
		};
	}
	if (state.type === "backend-hub") {
		const entries = buildBackendHubEntries();
		return {
			title: UI_COPY.settings.backendTitle,
			subtitle: UI_COPY.settings.backendSubtitle,
			lines: entries.map((entry, index) => formatDrawerEntry(entry, index, state.cursor)),
			footer: UI_COPY.settings.backendHelp,
		};
	}
	const category = BACKEND_CATEGORY_OPTION_BY_KEY.get(state.categoryKey);
	const entries = buildBackendCategoryEntries(state.categoryKey, state.draft);
	return {
		title: `${UI_COPY.settings.backendCategoryTitle}: ${category?.label ?? state.categoryKey}`,
		subtitle: category?.description ?? UI_COPY.settings.backendSubtitle,
		lines: entries.map((entry, index) => formatDrawerEntry(entry, index, state.cursor)),
		footer: UI_COPY.settings.backendCategoryHelp,
	};
}

export const OpenTuiBootstrapApp = (props: OpenTuiBootstrapAppProps = {}) => {
	const renderer = useRenderer();
	const clock = props.clock ?? defaultClock;
	const dashboard = props.dashboard ?? createDefaultOpenTuiDashboard();
	const navOptions = props.navOptions ?? DEFAULT_NAV_OPTIONS;
	const initialPanel = createWorkspacePanel(navOptions[0]?.name ?? "Accounts");
	let activeLayout = resolveShellLayout(renderer.width);

	const [uptimeSeconds, setUptimeSeconds] = createSignal(0);
	const [navIndex, setNavIndex] = createSignal(0);
	const [accountIndex, setAccountIndex] = createSignal(0);
	const [focusTarget, setFocusTarget] = createSignal<OpenTuiShellFocusTarget>("workspace");
	const [searchQuery, setSearchQuery] = createSignal("");
	const [searchMode, setSearchMode] = createSignal(false);
	const [visibleAccountCount, setVisibleAccountCount] = createSignal(dashboard.accounts.length);
	const [savedDashboardSettings, setSavedDashboardSettings] = createSignal(
		cloneDashboardSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS),
	);
	const [savedBackendConfig, setSavedBackendConfig] = createSignal(
		cloneBackendPluginConfig(getDefaultPluginConfig()),
	);
	const [drawerState, setDrawerState] = createSignal<OpenTuiDrawerState>({ type: "closed" });
	applyUiThemeFromDashboardSettings(savedDashboardSettings());

	let activeWorkspaceOptions = initialPanel.options;
	let activeVisibleAccounts = filterOpenTuiDashboardAccounts(dashboard, searchQuery());
	let activeStatusLabel = initialPanel.statusLabel;

	const totalAccountCount = dashboard.accounts.length;

	const root = new BoxRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.background,
		flexDirection: "column",
		height: "100%",
		width: "100%",
	});

	const shellBody = new BoxRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.background,
		flexDirection: "row",
		flexGrow: 1,
		width: "100%",
	});

	const navRail = new BoxRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.background,
		border: ["right"],
		borderColor: SHELL_TOKENS.border,
		flexDirection: "column",
		paddingBottom: 1,
		paddingLeft: 1,
		paddingRight: 1,
		paddingTop: 1,
		width: 18,
	});

	const navBrand = new TextRenderable(renderer, {
		content: "codex auth",
		fg: SHELL_TOKENS.text,
		truncate: true,
	});
	const navMeta = new TextRenderable(renderer, {
		content: "fast shell",
		fg: SHELL_TOKENS.muted,
		truncate: true,
	});
	const navRef = new SelectRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.background,
		descriptionColor: SHELL_TOKENS.muted,
		focusedBackgroundColor: SHELL_TOKENS.background,
		focusedTextColor: SHELL_TOKENS.focusText,
		itemSpacing: 0,
		options: navOptions,
		selectedBackgroundColor: SHELL_TOKENS.selectedBackground,
		selectedDescriptionColor: SHELL_TOKENS.muted,
		selectedIndex: navIndex(),
		selectedTextColor: SHELL_TOKENS.selectedText,
		showDescription: false,
		textColor: SHELL_TOKENS.muted,
		width: "100%",
		wrapSelection: true,
	});

	const workspace = new BoxRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.panelBackground,
		flexDirection: "column",
		flexGrow: 1,
		paddingBottom: 1,
		paddingLeft: 2,
		paddingRight: 1,
		paddingTop: 1,
	});

	const workspaceEyebrow = new TextRenderable(renderer, {
		content: initialPanel.eyebrow,
		fg: SHELL_TOKENS.accent,
		truncate: true,
	});
	const workspaceTitle = new TextRenderable(renderer, {
		content: initialPanel.title,
		fg: SHELL_TOKENS.text,
		truncate: true,
	});
	const workspaceSubtitle = new TextRenderable(renderer, {
		content: initialPanel.subtitle,
		fg: SHELL_TOKENS.muted,
		truncate: true,
	});
	const workspaceHint = new TextRenderable(renderer, {
		content: initialPanel.hint,
		fg: SHELL_TOKENS.muted,
		truncate: true,
	});
	const workspaceBody = new BoxRenderable(renderer, {
		flexDirection: "row",
		flexGrow: 1,
		width: "100%",
	});
	const workspaceListPane = new BoxRenderable(renderer, {
		flexDirection: "column",
		flexGrow: 1,
		paddingRight: 1,
	});
	const workspacePaneGap = new BoxRenderable(renderer, {
		width: 2,
	});
	const accountListRef = new SelectRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.panelBackground,
		descriptionColor: SHELL_TOKENS.muted,
		flexGrow: 1,
		focusedBackgroundColor: SHELL_TOKENS.panelBackground,
		focusedTextColor: SHELL_TOKENS.focusText,
		itemSpacing: 0,
		options: activeWorkspaceOptions,
		selectedBackgroundColor: SHELL_TOKENS.focusBackground,
		selectedDescriptionColor: SHELL_TOKENS.muted,
		selectedIndex: accountIndex(),
		selectedTextColor: SHELL_TOKENS.selectedText,
		showDescription: false,
		textColor: SHELL_TOKENS.text,
		width: "100%",
		wrapSelection: true,
	});
	const detailPaneRef = new BoxRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.panelBackground,
		border: ["left"],
		borderColor: SHELL_TOKENS.border,
		flexDirection: "column",
		paddingLeft: 2,
		width: 27,
	});
	const detailEyebrow = new TextRenderable(renderer, {
		content: "focus / account",
		fg: SHELL_TOKENS.accent,
		truncate: true,
	});
	const detailTitle = new TextRenderable(renderer, {
		content: "Focused account",
		fg: SHELL_TOKENS.text,
		truncate: true,
	});
	const detailSubtitle = new TextRenderable(renderer, {
		content: "context",
		fg: SHELL_TOKENS.muted,
		truncate: true,
	});
	const detailMetaRefs = Array.from({ length: 7 }, () =>
		new TextRenderable(renderer, {
			content: "",
			fg: SHELL_TOKENS.muted,
			truncate: true,
		})
	);
	const detailActionsTitle = new TextRenderable(renderer, {
		content: "Actions",
		fg: SHELL_TOKENS.accent,
		truncate: true,
	});
	const detailActionRefs = Array.from({ length: 5 }, () =>
		new TextRenderable(renderer, {
			content: "",
			fg: SHELL_TOKENS.text,
			truncate: true,
		})
	);

	const statusLineBox = new BoxRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.statusBackground,
		border: ["top"],
		borderColor: SHELL_TOKENS.border,
		paddingLeft: 1,
		paddingRight: 1,
		width: "100%",
	});
	const statusLineRef = new TextRenderable(renderer, {
		content: createStatusLine({
			focusTarget: focusTarget(),
			navLabel: navOptions[navIndex()]?.name ?? "",
			searchMode: searchMode(),
			searchQuery: searchQuery(),
			statusLabel: activeStatusLabel,
			uptimeSeconds: uptimeSeconds(),
			visibleAccountCount: visibleAccountCount(),
			totalAccountCount,
		}),
		fg: SHELL_TOKENS.statusText,
		truncate: true,
	});

	const modalHostRef = new BoxRenderable(renderer, {
		backgroundColor: SHELL_TOKENS.panelBackground,
		border: true,
		borderColor: SHELL_TOKENS.border,
		height: 16,
		padding: 1,
		position: "absolute",
		right: 2,
		top: 1,
		visible: false,
		width: 38,
		zIndex: 10,
	});
	const modalTitle = new TextRenderable(renderer, {
		content: "Overlay host",
		fg: SHELL_TOKENS.text,
	});
	const modalSubtitle = new TextRenderable(renderer, {
		content: "Hidden until search/help/settings attach.",
		fg: SHELL_TOKENS.muted,
		truncate: true,
	});
	const modalLineRefs = Array.from({ length: 12 }, () =>
		new TextRenderable(renderer, {
			content: "",
			fg: SHELL_TOKENS.text,
			truncate: true,
		}),
	);
	const modalFooter = new TextRenderable(renderer, {
		content: "",
		fg: SHELL_TOKENS.muted,
		truncate: true,
	});

	navRail.add(navBrand);
	navRail.add(navMeta);
	navRail.add(navRef);

	workspace.add(workspaceEyebrow);
	workspace.add(workspaceTitle);
	workspace.add(workspaceSubtitle);
	workspaceListPane.add(accountListRef);
	workspaceBody.add(workspaceListPane);
	workspaceBody.add(workspacePaneGap);
	workspaceBody.add(detailPaneRef);
	workspace.add(workspaceBody);
	workspace.add(workspaceHint);
	detailPaneRef.add(detailEyebrow);
	detailPaneRef.add(detailTitle);
	detailPaneRef.add(detailSubtitle);
	for (const ref of detailMetaRefs) {
		detailPaneRef.add(ref);
	}
	detailPaneRef.add(detailActionsTitle);
	for (const ref of detailActionRefs) {
		detailPaneRef.add(ref);
	}

	statusLineBox.add(statusLineRef);
	modalHostRef.add(modalTitle);
	modalHostRef.add(modalSubtitle);
	for (const ref of modalLineRefs) {
		modalHostRef.add(ref);
	}
	modalHostRef.add(modalFooter);

	shellBody.add(navRail);
	shellBody.add(workspace);
	root.add(shellBody);
	root.add(statusLineBox);
	root.add(modalHostRef);

	const emitSelectionChange = (
		nextNavIndex = navIndex(),
		nextAccountIndex = accountIndex(),
		nextFocusTarget = focusTarget(),
	) => {
		props.onSelectionChange?.(
			createSelectionSnapshot(navOptions, activeWorkspaceOptions, nextNavIndex, nextAccountIndex, nextFocusTarget),
		);
	};

	const syncStatusLineContent = (
		nextNavIndex = navIndex(),
		nextFocusTarget = focusTarget(),
	) => {
		statusLineRef.content = createStatusLine({
			focusTarget: nextFocusTarget,
			navLabel: navOptions[nextNavIndex]?.name ?? "",
			searchMode: searchMode(),
			searchQuery: searchQuery(),
			statusLabel: activeStatusLabel,
			uptimeSeconds: uptimeSeconds(),
			visibleAccountCount: visibleAccountCount(),
			totalAccountCount,
		});
	};

	const focusPane = (nextTarget: OpenTuiShellFocusTarget) => {
		setFocusTarget(nextTarget);
		renderer.focusRenderable(nextTarget === "nav" ? navRef : accountListRef);
		syncStatusLineContent(navIndex(), nextTarget);
		emitSelectionChange(navIndex(), accountIndex(), nextTarget);
		renderer.requestRender();
	};

	const isAccountsRoute = (nextNavIndex = navIndex()) => navOptions[nextNavIndex]?.name === "Accounts";

	const applyShellLayout = () => {
		navRail.width = activeLayout.navWidth;
		workspace.paddingLeft = activeLayout.workspacePaddingLeft;
		workspacePaneGap.width = activeLayout.workspaceGapWidth;
		detailPaneRef.width = activeLayout.detailWidth;
		detailPaneRef.paddingLeft = activeLayout.detailPaddingLeft;
	};

	const applyDetailContent = (detail: OpenTuiDetailContent) => {
		const metaLines = detail.metaLines.slice(0, activeLayout.detailMetaLimit);
		const actionLines = detail.actionLines.slice(0, activeLayout.detailActionLimit);
		const toneColor = resolveDetailToneColor(detail.tone);
		detailEyebrow.content = activeLayout.hideEyebrows ? "" : detail.eyebrow;
		detailTitle.content = detail.title;
		detailTitle.fg = toneColor;
		detailSubtitle.content = detail.subtitle;
		detailMetaRefs.forEach((ref, index) => {
			ref.content = metaLines[index] ?? "";
		});
		detailActionsTitle.content = actionLines.length > 0 ? "Actions" : "";
		detailActionRefs.forEach((ref, index) => {
			ref.content = actionLines[index] ?? "";
		});
	};

	const syncAccountDetailPane = (selectedAccountIndex = accountIndex()) => {
		const account = activeVisibleAccounts[selectedAccountIndex];
		if (!account) {
			applyDetailContent({
				eyebrow: "focus / account",
				title: "Focused account",
				subtitle: searchQuery().trim().length > 0 ? "No matching account" : "No saved account",
				metaLines: searchQuery().trim().length > 0
					? [`Filter: ${searchQuery()}`, "Clear search to review full account details."]
					: ["Add or restore an account to populate the detail pane."],
				actionLines: [],
				tone: "warning",
			});
			return;
		}
		const detail = buildOpenTuiAccountDetailPanel(account);
		applyDetailContent({
			eyebrow: detail.eyebrow,
			title: "Focused account",
			subtitle: detail.title,
			metaLines: [detail.subtitle, ...detail.metaLines],
			actionLines: detail.actionLines,
			tone: resolveDetailTone(detail.title.toLowerCase()),
		});
	};

	const resolveCurrentSelectedSourceIndex = (): number | undefined => {
		const currentAccount = activeVisibleAccounts[accountIndex()];
		const sourceIndex = currentAccount ? resolveOpenTuiAccountSourceIndex(currentAccount) : -1;
		return sourceIndex >= 0 ? sourceIndex : undefined;
	};

	const syncAccountsWorkspace = (preferredSourceIndex?: number) => {
		const sourceIndexToPreserve = typeof preferredSourceIndex === "number"
			? preferredSourceIndex
			: resolveCurrentSelectedSourceIndex();
		const visibleAccounts = filterOpenTuiDashboardAccounts(dashboard, searchQuery());
		activeVisibleAccounts = visibleAccounts;
		setVisibleAccountCount(visibleAccounts.length);

		workspaceEyebrow.content = activeLayout.hideEyebrows
			? ""
			: searchMode() || searchQuery().trim().length > 0
				? "workspace / accounts / search"
				: "workspace / accounts";
		workspaceTitle.content = "Account workspace";
		workspaceSubtitle.content = `${visibleAccounts.length} visible | ${totalAccountCount} total`;
		const statusMessage = resolveOpenTuiDashboardStatus(dashboard);
		workspaceHint.content = searchMode()
			? `Search: ${searchQuery().length > 0 ? searchQuery() : "_"} | Enter | Esc`
			: statusMessage ?? "/ search | 1-9 switch | S/R/E/D";
		activeStatusLabel = visibleAccounts.length === totalAccountCount ? "live" : "filtered";

		activeWorkspaceOptions = visibleAccounts.length > 0
			? buildOpenTuiAccountOptions(visibleAccounts)
			: [{
				name: searchQuery().trim().length > 0 ? `No accounts match \"${searchQuery()}\"` : "No saved accounts yet",
				description: "",
			}];
		accountListRef.options = activeWorkspaceOptions;

		let nextIndex = 0;
		if (visibleAccounts.length > 0) {
			if (typeof sourceIndexToPreserve === "number") {
				const matchedIndex = visibleAccounts.findIndex((account) =>
					resolveOpenTuiAccountSourceIndex(account) === sourceIndexToPreserve
				);
				nextIndex = matchedIndex >= 0 ? matchedIndex : clampSelection(accountIndex(), visibleAccounts.length);
			} else {
				nextIndex = clampSelection(accountIndex(), visibleAccounts.length);
			}
		}

		accountListRef.setSelectedIndex(nextIndex);
		setAccountIndex(nextIndex);
		syncAccountDetailPane(nextIndex);
	};

	const updateSearch = (nextQuery: string, nextSearchMode: boolean, preferredSourceIndex?: number) => {
		setSearchQuery(nextQuery);
		setSearchMode(nextSearchMode);
		syncAccountsWorkspace(preferredSourceIndex);
		props.onWorkspaceAction?.({ type: "search", active: nextSearchMode, query: nextQuery });
		emitSelectionChange(navIndex(), accountIndex(), focusTarget());
		renderer.requestRender();
	};

	const applyWorkspacePanel = (nextNavIndex: number, nextAccountIndex = 0) => {
		const panel = createWorkspacePanel(navOptions[nextNavIndex]?.name ?? "Accounts");
		if (isAccountsRoute(nextNavIndex)) {
			if (drawerState().type !== "closed") {
				setDrawerState({ type: "closed" });
				modalHostRef.visible = false;
			}
			syncAccountsWorkspace(resolveCurrentSelectedSourceIndex());
			return;
		}

		activeWorkspaceOptions = panel.options;
		activeVisibleAccounts = [];
		setVisibleAccountCount(0);
		activeStatusLabel = panel.statusLabel;
		const boundedIndex = clampSelection(nextAccountIndex, activeWorkspaceOptions.length);

		workspaceEyebrow.content = panel.eyebrow;
		if (activeLayout.hideEyebrows) {
			workspaceEyebrow.content = "";
		}
		workspaceTitle.content = panel.title;
		workspaceSubtitle.content = panel.subtitle;
		workspaceHint.content = activeLayout.density === "compact"
			? panel.hint
				.replace("Press Enter to continue or ", "Enter continue | ")
				.replace("Press Enter to run the ", "Enter run ")
				.replace("Press Enter to apply the existing ", "Enter run ")
				.replace("Press Enter to run the shared ", "Enter run ")
				.replace("Press Enter to run the flagged-account verification flow.", "Enter run verify flow.")
				.replace("Press Enter to run the deep-check command path.", "Enter run deep check.")
				.replace("Press Enter to run the forecast panel.", "Enter run forecast.")
				.replace("Press Enter to run the check command.", "Enter run check.")
				.replace("Press Enter to continue or Left to choose a different route.", "Enter continue | Left route")
				.replace("Press Enter to continue or Right if you want to inspect the drawer host.", "Enter continue | Right drawer")
			: panel.hint;
		accountListRef.options = activeWorkspaceOptions;
		accountListRef.setSelectedIndex(boundedIndex);
		setAccountIndex(boundedIndex);
		applyDetailContent(createPanelDetailContent(panel));
	};

	const openSettingsDrawer = () => {
		const nextState: OpenTuiDrawerState = { type: "hub", cursor: 0 };
		const view = buildDrawerView(nextState);
		modalHostRef.visible = true;
		modalTitle.content = view.title;
		modalSubtitle.content = view.subtitle;
		modalLineRefs.forEach((ref, index) => {
			ref.content = view.lines[index] ?? "";
		});
		modalFooter.content = view.footer;
		setDrawerState(nextState);
		renderer.requestRender();
	};

	const closeSettingsDrawer = () => {
		const currentDrawerState = drawerState();
		if (currentDrawerState.type === "dashboard-panel" && currentDrawerState.panel === "theme") {
			applyUiThemeFromDashboardSettings(savedDashboardSettings());
		}
		modalHostRef.visible = false;
		setDrawerState({ type: "closed" });
		renderer.requestRender();
	};

	const updateDrawerCursor = (direction: -1 | 1) => {
		const currentDrawerState = drawerState();
		if (currentDrawerState.type === "closed") return;
		if (currentDrawerState.type === "hub") {
			setDrawerState({
				...currentDrawerState,
				cursor: wrapCursor(currentDrawerState.cursor, direction, SETTINGS_HUB_ACTIONS.length),
			});
			return;
		}
		if (currentDrawerState.type === "dashboard-panel") {
			const entries = currentDrawerState.panel === "account-list"
				? buildAccountListDrawerEntries(currentDrawerState.draft)
				: currentDrawerState.panel === "summary-fields"
					? buildSummaryDrawerEntries(currentDrawerState.draft)
					: currentDrawerState.panel === "behavior"
						? buildBehaviorDrawerEntries(currentDrawerState.draft)
						: buildThemeDrawerEntries(currentDrawerState.draft);
			setDrawerState({
				...currentDrawerState,
				cursor: wrapCursor(currentDrawerState.cursor, direction, entries.length),
			});
			return;
		}
		if (currentDrawerState.type === "backend-hub") {
			const entries = buildBackendHubEntries();
			setDrawerState({
				...currentDrawerState,
				cursor: wrapCursor(currentDrawerState.cursor, direction, entries.length),
			});
			return;
		}
		const entries = buildBackendCategoryEntries(currentDrawerState.categoryKey, currentDrawerState.draft);
		setDrawerState({
			...currentDrawerState,
			cursor: wrapCursor(currentDrawerState.cursor, direction, entries.length),
		});
	};

	const emitDashboardSettingsSave = (panel: OpenTuiDashboardPanelId, selected: DashboardDisplaySettings) => {
		const snapshot = cloneDashboardSettings(selected);
		setSavedDashboardSettings(snapshot);
		props.onSettingsSave?.({ kind: "dashboard", panel, selected: snapshot });
	};

	const emitBackendSettingsSave = (selected: PluginConfig) => {
		const snapshot = cloneBackendPluginConfig(selected);
		setSavedBackendConfig(snapshot);
		props.onSettingsSave?.({ kind: "backend", selected: snapshot });
	};

	const handleDrawerHubEnter = (cursor: number) => {
		const actionId = SETTINGS_HUB_ACTIONS[cursor]?.id ?? "back";
		const command = resolveSettingsHubCommand({ type: actionId as SettingsHubAction["type"] });
		if (command.type === "back") {
			closeSettingsDrawer();
			return;
		}
		if (command.type === "open-dashboard-panel") {
			setDrawerState({
				type: "dashboard-panel",
				panel: command.panel,
				cursor: 0,
				draft: cloneDashboardSettings(savedDashboardSettings()),
				hubCursor: cursor,
				themeBaseline: cloneDashboardSettings(savedDashboardSettings()),
			});
			return;
		}
		setDrawerState({
			type: "backend-hub",
			cursor: 0,
			draft: cloneBackendPluginConfig(savedBackendConfig()),
			baseline: cloneBackendPluginConfig(savedBackendConfig()),
			hubCursor: cursor,
		});
	};

	const handleDrawerKeyPress = (keyEvent: KeyEvent, raw: string): boolean => {
		const currentDrawerState = drawerState();
		if (currentDrawerState.type === "closed") {
			return false;
		}
		const lower = raw.toLowerCase();
		if (keyEvent.name === "up") {
			updateDrawerCursor(-1);
			renderer.requestRender();
			return true;
		}
		if (keyEvent.name === "down") {
			updateDrawerCursor(1);
			renderer.requestRender();
			return true;
		}

		if (currentDrawerState.type === "hub") {
			if (lower === "q") {
				closeSettingsDrawer();
				return true;
			}
			const parsed = Number.parseInt(lower, 10);
			if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) {
				handleDrawerHubEnter(parsed - 1);
				renderer.requestRender();
				return true;
			}
			if (isEnterKey(keyEvent.name)) {
				handleDrawerHubEnter(currentDrawerState.cursor);
				renderer.requestRender();
				return true;
			}
			return true;
		}

		if (currentDrawerState.type === "dashboard-panel") {
			const entries = currentDrawerState.panel === "account-list"
				? buildAccountListDrawerEntries(currentDrawerState.draft)
				: currentDrawerState.panel === "summary-fields"
					? buildSummaryDrawerEntries(currentDrawerState.draft)
					: currentDrawerState.panel === "behavior"
						? buildBehaviorDrawerEntries(currentDrawerState.draft)
						: buildThemeDrawerEntries(currentDrawerState.draft);
			const entry = entries[currentDrawerState.cursor];
			const commitAndReturn = (nextDraft: DashboardDisplaySettings) => {
				emitDashboardSettingsSave(currentDrawerState.panel, nextDraft);
				setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
			};
			if (lower === "q") {
				if (currentDrawerState.panel === "theme") {
					applyUiThemeFromDashboardSettings(currentDrawerState.themeBaseline);
				}
				setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
				renderer.requestRender();
				return true;
			}
			if (lower === "s") {
				commitAndReturn(currentDrawerState.draft);
				renderer.requestRender();
				return true;
			}
			if (lower === "r") {
				const keys = currentDrawerState.panel === "account-list"
					? [
						"menuShowStatusBadge",
						"menuShowCurrentBadge",
						"menuShowLastUsed",
						"menuShowQuotaSummary",
						"menuShowQuotaCooldown",
						"menuShowFetchStatus",
						"menuShowDetailsForUnselectedRows",
						"menuHighlightCurrentRow",
						"menuSortEnabled",
						"menuSortMode",
						"menuSortPinCurrent",
						"menuSortQuickSwitchVisibleRow",
						"menuLayoutMode",
					] as const
					: currentDrawerState.panel === "summary-fields"
						? ["menuStatuslineFields"] as const
						: currentDrawerState.panel === "behavior"
							? [
								"actionAutoReturnMs",
								"actionPauseOnKey",
								"menuAutoFetchLimits",
								"menuShowFetchStatus",
								"menuQuotaTtlMs",
							] as const
							: ["uiThemePreset", "uiAccentColor"] as const;
				const nextDraft = applyDashboardDefaultsForKeys(currentDrawerState.draft, keys);
				if (currentDrawerState.panel === "theme") {
					applyUiThemeFromDashboardSettings(nextDraft);
				}
				setDrawerState({ ...currentDrawerState, draft: nextDraft, cursor: 0 });
				renderer.requestRender();
				return true;
			}

			if (currentDrawerState.panel === "account-list") {
				const parsed = Number.parseInt(lower, 10);
				if (Number.isFinite(parsed) && parsed >= 1 && parsed <= DASHBOARD_DISPLAY_OPTIONS.length) {
					const option = DASHBOARD_DISPLAY_OPTIONS[parsed - 1];
					if (option) {
						setDrawerState({
							...currentDrawerState,
							draft: {
								...currentDrawerState.draft,
								[option.key]: !(currentDrawerState.draft[option.key] ?? true),
							},
							cursor: parsed - 1,
						});
						renderer.requestRender();
						return true;
					}
				}
				if (lower === "m") {
					setDrawerState({ ...currentDrawerState, draft: cycleSortMode(currentDrawerState.draft), cursor: DASHBOARD_DISPLAY_OPTIONS.length });
					renderer.requestRender();
					return true;
				}
				if (lower === "l") {
					setDrawerState({
						...currentDrawerState,
						draft: cycleLayoutMode(currentDrawerState.draft),
						cursor: DASHBOARD_DISPLAY_OPTIONS.length + 1,
					});
					renderer.requestRender();
					return true;
				}
				if (isEnterKey(keyEvent.name) && entry) {
					if (entry.id === "save") {
						commitAndReturn(currentDrawerState.draft);
					} else if (entry.id === "cancel") {
						setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
					} else if (entry.id === "reset") {
						setDrawerState({
							...currentDrawerState,
							draft: applyDashboardDefaultsForKeys(currentDrawerState.draft, [
								"menuShowStatusBadge",
								"menuShowCurrentBadge",
								"menuShowLastUsed",
								"menuShowQuotaSummary",
								"menuShowQuotaCooldown",
								"menuShowFetchStatus",
								"menuShowDetailsForUnselectedRows",
								"menuHighlightCurrentRow",
								"menuSortEnabled",
								"menuSortMode",
								"menuSortPinCurrent",
								"menuSortQuickSwitchVisibleRow",
								"menuLayoutMode",
							]),
							cursor: 0,
						});
					} else if (entry.id === "sort-mode") {
						setDrawerState({ ...currentDrawerState, draft: cycleSortMode(currentDrawerState.draft) });
					} else if (entry.id === "layout-mode") {
						setDrawerState({ ...currentDrawerState, draft: cycleLayoutMode(currentDrawerState.draft) });
					} else {
						const option = DASHBOARD_DISPLAY_OPTIONS.find((candidate) => candidate.key === entry.id);
						if (option) {
							setDrawerState({
								...currentDrawerState,
								draft: {
									...currentDrawerState.draft,
									[option.key]: !(currentDrawerState.draft[option.key] ?? true),
								},
							});
						}
					}
					renderer.requestRender();
					return true;
				}
				return true;
			}

			if (currentDrawerState.panel === "summary-fields") {
				if (lower === "[") {
					const currentField = STATUSLINE_FIELD_OPTIONS[currentDrawerState.cursor]?.key;
					if (currentField) {
						setDrawerState({
							...currentDrawerState,
							draft: reorderStatuslineField(currentDrawerState.draft, currentField, -1),
						});
						renderer.requestRender();
					}
					return true;
				}
				if (lower === "]") {
					const currentField = STATUSLINE_FIELD_OPTIONS[currentDrawerState.cursor]?.key;
					if (currentField) {
						setDrawerState({
							...currentDrawerState,
							draft: reorderStatuslineField(currentDrawerState.draft, currentField, 1),
						});
						renderer.requestRender();
					}
					return true;
				}
				const parsed = Number.parseInt(lower, 10);
				if (Number.isFinite(parsed) && parsed >= 1 && parsed <= STATUSLINE_FIELD_OPTIONS.length) {
					const target = STATUSLINE_FIELD_OPTIONS[parsed - 1];
					if (target) {
						const fields = normalizeStatuslineFields(currentDrawerState.draft.menuStatuslineFields);
						const isEnabled = fields.includes(target.key);
						setDrawerState({
							...currentDrawerState,
							draft: {
								...currentDrawerState.draft,
								menuStatuslineFields: isEnabled
									? (fields.filter((field) => field !== target.key).length > 0
										? fields.filter((field) => field !== target.key)
										: [target.key])
									: [...fields, target.key],
							},
							cursor: parsed - 1,
						});
						renderer.requestRender();
					}
					return true;
				}
				if (isEnterKey(keyEvent.name) && entry) {
					if (entry.id === "save") {
						commitAndReturn(currentDrawerState.draft);
					} else if (entry.id === "cancel") {
						setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
					} else if (entry.id === "reset") {
						setDrawerState({
							...currentDrawerState,
							draft: applyDashboardDefaultsForKeys(currentDrawerState.draft, ["menuStatuslineFields"]),
							cursor: 0,
						});
					} else {
						const target = STATUSLINE_FIELD_OPTIONS.find((option) => option.key === entry.id);
						if (target) {
							const fields = normalizeStatuslineFields(currentDrawerState.draft.menuStatuslineFields);
							const isEnabled = fields.includes(target.key);
							setDrawerState({
								...currentDrawerState,
								draft: {
									...currentDrawerState.draft,
									menuStatuslineFields: isEnabled
										? (fields.filter((field) => field !== target.key).length > 0
											? fields.filter((field) => field !== target.key)
											: [target.key])
										: [...fields, target.key],
								},
							});
						}
					}
					renderer.requestRender();
					return true;
				}
				return true;
			}

			if (currentDrawerState.panel === "behavior") {
				const setDelay = (delayMs: number) => {
					setDrawerState({
						...currentDrawerState,
						draft: { ...currentDrawerState.draft, actionAutoReturnMs: delayMs },
					});
				};
				if (lower === "p") {
					setDrawerState({
						...currentDrawerState,
						draft: {
							...currentDrawerState.draft,
							actionPauseOnKey: !(currentDrawerState.draft.actionPauseOnKey ?? true),
						},
					});
					renderer.requestRender();
					return true;
				}
				if (lower === "l") {
					setDrawerState({
						...currentDrawerState,
						draft: {
							...currentDrawerState.draft,
							menuAutoFetchLimits: !(currentDrawerState.draft.menuAutoFetchLimits ?? true),
						},
					});
					renderer.requestRender();
					return true;
				}
				if (lower === "f") {
					setDrawerState({
						...currentDrawerState,
						draft: {
							...currentDrawerState.draft,
							menuShowFetchStatus: !(currentDrawerState.draft.menuShowFetchStatus ?? true),
						},
					});
					renderer.requestRender();
					return true;
				}
				if (lower === "t") {
					const currentTtl = currentDrawerState.draft.menuQuotaTtlMs ?? 5 * 60_000;
					const currentIndex = MENU_QUOTA_TTL_OPTIONS_MS.findIndex((value) => value === currentTtl);
					const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % MENU_QUOTA_TTL_OPTIONS_MS.length;
					setDrawerState({
						...currentDrawerState,
						draft: {
							...currentDrawerState.draft,
							menuQuotaTtlMs: MENU_QUOTA_TTL_OPTIONS_MS[nextIndex] ?? MENU_QUOTA_TTL_OPTIONS_MS[0] ?? currentTtl,
						},
					});
					renderer.requestRender();
					return true;
				}
				const parsed = Number.parseInt(lower, 10);
				if (Number.isFinite(parsed) && parsed >= 1 && parsed <= AUTO_RETURN_OPTIONS_MS.length) {
					const delayMs = AUTO_RETURN_OPTIONS_MS[parsed - 1];
					if (typeof delayMs === "number") {
						setDelay(delayMs);
						renderer.requestRender();
					}
					return true;
				}
				if (isEnterKey(keyEvent.name) && entry) {
					if (entry.id === "save") {
						commitAndReturn(currentDrawerState.draft);
					} else if (entry.id === "cancel") {
						setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
					} else if (entry.id === "reset") {
						setDrawerState({
							...currentDrawerState,
							draft: applyDashboardDefaultsForKeys(currentDrawerState.draft, [
								"actionAutoReturnMs",
								"actionPauseOnKey",
								"menuAutoFetchLimits",
								"menuShowFetchStatus",
								"menuQuotaTtlMs",
							]),
							cursor: 0,
						});
					} else if (entry.id === "pause") {
						setDrawerState({
							...currentDrawerState,
							draft: {
								...currentDrawerState.draft,
								actionPauseOnKey: !(currentDrawerState.draft.actionPauseOnKey ?? true),
							},
						});
					} else if (entry.id === "auto-fetch") {
						setDrawerState({
							...currentDrawerState,
							draft: {
								...currentDrawerState.draft,
								menuAutoFetchLimits: !(currentDrawerState.draft.menuAutoFetchLimits ?? true),
							},
						});
					} else if (entry.id === "fetch-status") {
						setDrawerState({
							...currentDrawerState,
							draft: {
								...currentDrawerState.draft,
								menuShowFetchStatus: !(currentDrawerState.draft.menuShowFetchStatus ?? true),
							},
						});
					} else if (entry.id === "ttl") {
						const currentTtl = currentDrawerState.draft.menuQuotaTtlMs ?? 5 * 60_000;
						const currentIndex = MENU_QUOTA_TTL_OPTIONS_MS.findIndex((value) => value === currentTtl);
						const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % MENU_QUOTA_TTL_OPTIONS_MS.length;
						setDrawerState({
							...currentDrawerState,
							draft: {
								...currentDrawerState.draft,
								menuQuotaTtlMs: MENU_QUOTA_TTL_OPTIONS_MS[nextIndex] ?? MENU_QUOTA_TTL_OPTIONS_MS[0] ?? currentTtl,
							},
						});
					} else if (entry.id.startsWith("delay:")) {
						const delayMs = Number.parseInt(entry.id.slice("delay:".length), 10);
						if (Number.isFinite(delayMs)) {
							setDelay(delayMs);
						}
					}
					renderer.requestRender();
					return true;
				}
				return true;
			}

			const setPalette = (palette: DashboardThemePreset) => {
				const nextDraft = { ...currentDrawerState.draft, uiThemePreset: palette };
				applyUiThemeFromDashboardSettings(nextDraft);
				setDrawerState({ ...currentDrawerState, draft: nextDraft });
			};
			const setAccent = (accent: DashboardAccentColor) => {
				const nextDraft = { ...currentDrawerState.draft, uiAccentColor: accent };
				applyUiThemeFromDashboardSettings(nextDraft);
				setDrawerState({ ...currentDrawerState, draft: nextDraft });
			};
			if (lower === "1") {
				setPalette("green");
				renderer.requestRender();
				return true;
			}
			if (lower === "2") {
				setPalette("blue");
				renderer.requestRender();
				return true;
			}
			if (isEnterKey(keyEvent.name) && entry) {
				if (entry.id === "save") {
					commitAndReturn(currentDrawerState.draft);
				} else if (entry.id === "cancel") {
					applyUiThemeFromDashboardSettings(currentDrawerState.themeBaseline);
					setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
				} else if (entry.id === "reset") {
					const nextDraft = applyDashboardDefaultsForKeys(currentDrawerState.draft, ["uiThemePreset", "uiAccentColor"]);
					applyUiThemeFromDashboardSettings(nextDraft);
					setDrawerState({ ...currentDrawerState, draft: nextDraft, cursor: 0 });
				} else if (entry.id.startsWith("palette:")) {
					setPalette(entry.id.slice("palette:".length) as DashboardThemePreset);
				} else if (entry.id.startsWith("accent:")) {
					setAccent(entry.id.slice("accent:".length) as DashboardAccentColor);
				}
				renderer.requestRender();
				return true;
			}
			return true;
		}

		if (currentDrawerState.type === "backend-hub") {
			const entries = buildBackendHubEntries();
			const entry = entries[currentDrawerState.cursor];
			if (lower === "q") {
				setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
				renderer.requestRender();
				return true;
			}
			if (lower === "s") {
				emitBackendSettingsSave(currentDrawerState.draft);
				setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
				renderer.requestRender();
				return true;
			}
			if (lower === "r") {
				setDrawerState({
					...currentDrawerState,
					draft: cloneBackendPluginConfig(BACKEND_DEFAULTS),
					cursor: 0,
				});
				renderer.requestRender();
				return true;
			}
			const parsed = Number.parseInt(lower, 10);
			if (Number.isFinite(parsed) && parsed >= 1 && parsed <= BACKEND_CATEGORY_OPTIONS.length) {
				const category = BACKEND_CATEGORY_OPTIONS[parsed - 1];
				if (category) {
					setDrawerState({
						type: "backend-category",
						categoryKey: category.key,
						cursor: 0,
						draft: cloneBackendPluginConfig(currentDrawerState.draft),
						baseline: cloneBackendPluginConfig(currentDrawerState.baseline),
						hubCursor: currentDrawerState.hubCursor,
						backendCursor: parsed - 1,
					});
					renderer.requestRender();
				}
				return true;
			}
			if (isEnterKey(keyEvent.name) && entry) {
				if (entry.id === "save") {
					emitBackendSettingsSave(currentDrawerState.draft);
					setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
				} else if (entry.id === "cancel") {
					setDrawerState({ type: "hub", cursor: currentDrawerState.hubCursor });
				} else if (entry.id === "reset") {
					setDrawerState({
						...currentDrawerState,
						draft: cloneBackendPluginConfig(BACKEND_DEFAULTS),
						cursor: 0,
					});
				} else if (entry.id.startsWith("category:")) {
					const categoryKey = entry.id.slice("category:".length) as BackendCategoryKey;
					setDrawerState({
						type: "backend-category",
						categoryKey,
						cursor: 0,
						draft: cloneBackendPluginConfig(currentDrawerState.draft),
						baseline: cloneBackendPluginConfig(currentDrawerState.baseline),
						hubCursor: currentDrawerState.hubCursor,
						backendCursor: currentDrawerState.cursor,
					});
				}
				renderer.requestRender();
				return true;
			}
			return true;
		}

		const entries = buildBackendCategoryEntries(currentDrawerState.categoryKey, currentDrawerState.draft);
		const entry = entries[currentDrawerState.cursor];
		const adjustCurrentNumber = (direction: -1 | 1) => {
			if (!entry || !entry.id.startsWith("number:")) return;
			const numberKey = entry.id.slice("number:".length) as BackendNumberSettingKey;
			const option = BACKEND_NUMBER_OPTION_BY_KEY.get(numberKey);
			if (!option) return;
			const currentValue = currentDrawerState.draft[numberKey] ?? BACKEND_DEFAULTS[numberKey] ?? option.min;
			const numericCurrent = typeof currentValue === "number" && Number.isFinite(currentValue)
				? currentValue
				: option.min;
			setDrawerState({
				...currentDrawerState,
				draft: {
					...currentDrawerState.draft,
					[numberKey]: clampBackendNumber(option, numericCurrent + option.step * direction),
				},
			});
		};
		if (lower === "q") {
			setDrawerState({
				type: "backend-hub",
				cursor: currentDrawerState.backendCursor,
				draft: cloneBackendPluginConfig(currentDrawerState.draft),
				baseline: cloneBackendPluginConfig(currentDrawerState.baseline),
				hubCursor: currentDrawerState.hubCursor,
			});
			renderer.requestRender();
			return true;
		}
		if (lower === "r") {
			setDrawerState({
				...currentDrawerState,
				draft: applyBackendCategoryDefaults(currentDrawerState.draft, currentDrawerState.categoryKey),
				cursor: 0,
			});
			renderer.requestRender();
			return true;
		}
		if (lower === "+" || lower === "=" || lower === "]" || lower === "d") {
			adjustCurrentNumber(1);
			renderer.requestRender();
			return true;
		}
		if (lower === "-" || lower === "[" || lower === "a") {
			adjustCurrentNumber(-1);
			renderer.requestRender();
			return true;
		}
		const parsed = Number.parseInt(lower, 10);
		const category = BACKEND_CATEGORY_OPTION_BY_KEY.get(currentDrawerState.categoryKey);
		if (Number.isFinite(parsed) && parsed >= 1 && parsed <= (category?.toggleKeys.length ?? 0)) {
			const toggleKey = category?.toggleKeys[parsed - 1];
			if (toggleKey) {
				const currentValue = currentDrawerState.draft[toggleKey] ?? BACKEND_DEFAULTS[toggleKey] ?? false;
				setDrawerState({
					...currentDrawerState,
					draft: { ...currentDrawerState.draft, [toggleKey]: !currentValue },
					cursor: parsed - 1,
				});
				renderer.requestRender();
			}
			return true;
		}
		if (isEnterKey(keyEvent.name) && entry) {
			if (entry.id === "back") {
				setDrawerState({
					type: "backend-hub",
					cursor: currentDrawerState.backendCursor,
					draft: cloneBackendPluginConfig(currentDrawerState.draft),
					baseline: cloneBackendPluginConfig(currentDrawerState.baseline),
					hubCursor: currentDrawerState.hubCursor,
				});
			} else if (entry.id === "reset") {
				setDrawerState({
					...currentDrawerState,
					draft: applyBackendCategoryDefaults(currentDrawerState.draft, currentDrawerState.categoryKey),
					cursor: 0,
				});
			} else if (entry.id.startsWith("toggle:")) {
				const toggleKey = entry.id.slice("toggle:".length) as BackendToggleSettingKey;
				const currentValue = currentDrawerState.draft[toggleKey] ?? BACKEND_DEFAULTS[toggleKey] ?? false;
				setDrawerState({
					...currentDrawerState,
					draft: { ...currentDrawerState.draft, [toggleKey]: !currentValue },
				});
			} else if (entry.id.startsWith("number:")) {
				adjustCurrentNumber(1);
			}
			renderer.requestRender();
			return true;
		}
		return true;
	};

	const handleNavSelectionChange = (nextIndex: number) => {
		setNavIndex(nextIndex);
		applyWorkspacePanel(nextIndex, 0);
		syncStatusLineContent(nextIndex, focusTarget());
		emitSelectionChange(nextIndex, 0, focusTarget());
	};

	const handleAccountSelectionChange = (nextIndex: number) => {
		setAccountIndex(nextIndex);
		syncAccountDetailPane(nextIndex);
		emitSelectionChange(navIndex(), nextIndex, focusTarget());
	};

	navRef.on(SelectRenderableEvents.SELECTION_CHANGED, handleNavSelectionChange);
	accountListRef.on(SelectRenderableEvents.SELECTION_CHANGED, handleAccountSelectionChange);
	applyShellLayout();
	applyWorkspacePanel(0, 0);

	const timer = clock.setInterval(() => {
		setUptimeSeconds((value) => value + 1);
	}, 1000);

	createEffect(() => {
		statusLineRef.content = createStatusLine({
			focusTarget: focusTarget(),
			navLabel: navOptions[navIndex()]?.name ?? "",
			searchMode: searchMode(),
			searchQuery: searchQuery(),
			statusLabel: activeStatusLabel,
			uptimeSeconds: uptimeSeconds(),
			visibleAccountCount: visibleAccountCount(),
			totalAccountCount,
		});
	});

	createEffect(() => {
		const view = buildDrawerView(drawerState());
		modalHostRef.visible = drawerState().type !== "closed";
		modalTitle.content = view.title;
		modalSubtitle.content = view.subtitle;
		modalLineRefs.forEach((ref, index) => {
			ref.content = view.lines[index] ?? "";
		});
		modalFooter.content = view.footer;
		renderer.requestRender();
	});

	const handleRendererSelection = (selection: Selection) => {
		props.onRendererSelection?.(selection);
	};

	root.onSizeChange = () => {
		const nextLayout = resolveShellLayout(renderer.width);
		if (nextLayout.density === activeLayout.density) {
			return;
		}
		activeLayout = nextLayout;
		applyShellLayout();
		applyWorkspacePanel(navIndex(), accountIndex());
		syncStatusLineContent(navIndex(), focusTarget());
		renderer.requestRender();
	};

	const handleKeyPress = (keyEvent: KeyEvent) => {
		props.onKeyPress?.(keyEvent);

		if (renderer.isDestroyed) {
			return;
		}

		const raw = keyEvent.sequence ?? keyEvent.name ?? "";
		const accountsRoute = isAccountsRoute();
		if (handleDrawerKeyPress(keyEvent, raw)) {
			return;
		}
		if (accountsRoute && focusTarget() === "workspace" && searchMode()) {
			const preferredSourceIndex = resolveCurrentSelectedSourceIndex();
			if (keyEvent.name === "escape" || raw === "\u001b") {
				updateSearch("", false, preferredSourceIndex);
				return;
			}
			if (keyEvent.name === "return" || keyEvent.name === "enter") {
				updateSearch(searchQuery(), false, preferredSourceIndex);
				return;
			}
			if (keyEvent.name === "backspace") {
				updateSearch(searchQuery().slice(0, -1), true, preferredSourceIndex);
				return;
			}
			if (!keyEvent.ctrl && !keyEvent.meta && typeof raw === "string" && raw.length === 1 && raw >= " ") {
				updateSearch(`${searchQuery()}${raw}`, true, preferredSourceIndex);
				return;
			}
		}

		const isEscape = keyEvent.name === "escape" || raw === "\u001b";
		if (isEscape || keyEvent.name === "q") {
			const reason: OpenTuiShellExitReason = isEscape ? "escape" : "quit";

			try {
				props.onExit?.(reason, renderer);
			} finally {
				renderer.destroy();
			}
			return;
		}

		if (keyEvent.name === "tab") {
			const nextTarget = keyEvent.shift ? "nav" : focusTarget() === "nav" ? "workspace" : "nav";
			focusPane(nextTarget);
			if (nextTarget === "workspace" && navOptions[navIndex()]?.name === "Settings") {
				openSettingsDrawer();
			}
			return;
		}

		if (keyEvent.name === "left" && focusTarget() === "workspace") {
			focusPane("nav");
			return;
		}

		if (keyEvent.name === "right" && focusTarget() === "nav") {
			focusPane("workspace");
			if (navOptions[navIndex()]?.name === "Settings") {
				openSettingsDrawer();
			}
			return;
		}

		if (focusTarget() === "nav" && isEnterKey(keyEvent.name) && navOptions[navIndex()]?.name === "Settings") {
			focusPane("workspace");
			openSettingsDrawer();
			return;
		}

		if (accountsRoute && focusTarget() === "workspace") {
			if (raw === "/") {
				updateSearch(searchQuery(), true, resolveCurrentSelectedSourceIndex());
				return;
			}

			const quickSwitchAccount = resolveOpenTuiQuickSwitchAccount(dashboard, searchQuery(), raw);
			if (quickSwitchAccount) {
				const sourceIndex = resolveOpenTuiAccountSourceIndex(quickSwitchAccount);
				if (sourceIndex >= 0) {
					const visibleIndex = activeVisibleAccounts.findIndex((account) =>
						resolveOpenTuiAccountSourceIndex(account) === sourceIndex
					);
					if (visibleIndex >= 0) {
						accountListRef.setSelectedIndex(visibleIndex);
						setAccountIndex(visibleIndex);
						emitSelectionChange(navIndex(), visibleIndex, focusTarget());
						props.onWorkspaceAction?.({ type: "quick-switch", sourceIndex });
						renderer.requestRender();
						return;
					}
				}
			}
		}

		const activeRenderable = focusTarget() === "nav" ? navRef : accountListRef;
		if (activeRenderable.handleKeyPress) {
			const handled = activeRenderable.handleKeyPress(keyEvent);
			if (handled) {
				renderer.requestRender();
			}
		}
	};

	renderer.on("selection", handleRendererSelection);
	renderer.keyInput.on("keypress", handleKeyPress);

	onCleanup(() => {
		clock.clearInterval(timer);
		navRef.off(SelectRenderableEvents.SELECTION_CHANGED, handleNavSelectionChange);
		accountListRef.off(SelectRenderableEvents.SELECTION_CHANGED, handleAccountSelectionChange);
		renderer.off("selection", handleRendererSelection);
		renderer.keyInput.off("keypress", handleKeyPress);
	});

	queueMicrotask(() => {
		if (renderer.isDestroyed) {
			return;
		}

		focusPane("workspace");
		props.onReady?.({
			accountListRef,
			focusTarget: focusTarget(),
			focusedRenderable: renderer.currentFocusedRenderable as SelectRenderable | null,
			modalHostRef,
			navRef,
			renderer,
			rootRef: root,
			statusLineRef,
		});
	});

	return root;
};
