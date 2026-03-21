import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadPluginConfig, savePluginConfig } from "../config.js";
import {
	type DashboardAccentColor,
	type DashboardAccountSortMode,
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
	type DashboardThemePreset,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	getDashboardSettingsPath,
	loadDashboardDisplaySettings,
	saveDashboardDisplaySettings,
} from "../dashboard-settings.js";
import {
	applyOcChatgptSync,
	planOcChatgptSync,
	runNamedBackupExport,
} from "../oc-chatgpt-orchestrator.js";
import { detectOcChatgptMultiAuthTarget } from "../oc-chatgpt-target-detection.js";
import { loadAccounts, normalizeAccountStorage } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { ANSI } from "../ui/ansi.js";
import { UI_COPY } from "../ui/copy.js";
import { getUiRuntimeOptions, setUiRuntimeOptions } from "../ui/runtime.js";
import { type MenuItem, select } from "../ui/select.js";
import { sleep } from "../utils.js";
import {
	backendSettingsEqual,
	buildBackendConfigPatch,
	buildBackendSettingsPreview,
	clampBackendNumberForTests,
	cloneBackendPluginConfig,
	formatBackendNumberValue,
} from "./backend-settings-helpers.js";
import {
	BACKEND_CATEGORY_OPTIONS,
	BACKEND_DEFAULTS,
	BACKEND_NUMBER_OPTION_BY_KEY,
	BACKEND_NUMBER_OPTIONS,
	BACKEND_TOGGLE_OPTION_BY_KEY,
	type BackendCategoryConfigAction,
	type BackendCategoryKey,
	type BackendCategoryOption,
	type BackendNumberSettingKey,
	type BackendNumberSettingOption,
	type BackendSettingFocusKey,
	type BackendSettingsHubAction,
	type BackendToggleSettingKey,
	type BackendToggleSettingOption,
} from "./backend-settings-schema.js";
import { promptBehaviorSettingsPanel } from "./behavior-settings-panel.js";
import { promptDashboardDisplayPanel } from "./dashboard-display-panel.js";
import {
	cloneDashboardSettingsData,
	dashboardSettingsDataEqual,
} from "./dashboard-settings-data.js";
import {
	type ExperimentalSettingsAction,
	getExperimentalSelectOptions,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
} from "./experimental-settings-schema.js";
import {
	readFileWithRetry,
	resolvePluginConfigSavePathKey,
	warnPersistFailure,
} from "./settings-persist-utils.js";
import { withQueuedRetry } from "./settings-write-queue.js";
import { promptStatuslineSettingsPanel } from "./statusline-settings-panel.js";
import { promptThemeSettingsPanel } from "./theme-settings-panel.js";

type DashboardDisplaySettingKey =
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

interface DashboardDisplaySettingOption {
	key: DashboardDisplaySettingKey;
	label: string;
	description: string;
}

const DASHBOARD_DISPLAY_OPTIONS: DashboardDisplaySettingOption[] = [
	{
		key: "menuShowStatusBadge",
		label: "Show Status Badges",
		description: "Show [ok], [active], and similar badges.",
	},
	{
		key: "menuShowCurrentBadge",
		label: "Show [current]",
		description: "Mark the account active in Codex.",
	},
	{
		key: "menuShowLastUsed",
		label: "Show Last Used",
		description: "Show relative usage like 'today'.",
	},
	{
		key: "menuShowQuotaSummary",
		label: "Show Limits (5h / 7d)",
		description: "Show limit bars in each row.",
	},
	{
		key: "menuShowQuotaCooldown",
		label: "Show Limit Cooldowns",
		description: "Show reset timers next to 5h/7d bars.",
	},
	{
		key: "menuShowFetchStatus",
		label: "Show Fetch Status",
		description: "Show background limit refresh status in the menu subtitle.",
	},
	{
		key: "menuHighlightCurrentRow",
		label: "Highlight Current Row",
		description: "Use stronger color on the current row.",
	},
	{
		key: "menuSortEnabled",
		label: "Enable Smart Sort",
		description: "Sort accounts by readiness (view only).",
	},
	{
		key: "menuSortPinCurrent",
		label: "Pin [current] when tied",
		description: "Keep current at top only when it is equally ready.",
	},
	{
		key: "menuSortQuickSwitchVisibleRow",
		label: "Quick Switch Uses Visible Rows",
		description: "Number keys (1-9) follow what you see in the list.",
	},
];

const DEFAULT_STATUSLINE_FIELDS: DashboardStatuslineField[] = [
	"last-used",
	"limits",
	"status",
];
const STATUSLINE_FIELD_OPTIONS: Array<{
	key: DashboardStatuslineField;
	label: string;
	description: string;
}> = [
	{
		key: "last-used",
		label: "Show Last Used",
		description: "Example: 'today' or '2d ago'.",
	},
	{
		key: "limits",
		label: "Show Limits (5h / 7d)",
		description: "Uses cached limit data from checks.",
	},
	{
		key: "status",
		label: "Show Status Text",
		description: "Visible when badges are hidden.",
	},
];
const AUTO_RETURN_OPTIONS_MS = [1_000, 2_000, 4_000] as const;
const MENU_QUOTA_TTL_OPTIONS_MS = [60_000, 5 * 60_000, 10 * 60_000] as const;
const THEME_PRESET_OPTIONS: DashboardThemePreset[] = ["green", "blue"];
const ACCENT_COLOR_OPTIONS: DashboardAccentColor[] = [
	"green",
	"cyan",
	"blue",
	"yellow",
];
const PREVIEW_ACCOUNT_EMAIL = "demo@example.com";
const PREVIEW_LAST_USED = "today";
const PREVIEW_STATUS = "active";
const PREVIEW_LIMITS = "5h ██████▒▒▒▒ 62% | 7d █████▒▒▒▒▒ 49%";
const PREVIEW_LIMIT_COOLDOWNS = "5h reset 1h 20m | 7d reset 2d 04h";
type PreviewFocusKey =
	| DashboardDisplaySettingKey
	| DashboardStatuslineField
	| "menuSortMode"
	| "menuLayoutMode"
	| null;

type SettingsHubAction =
	| { type: "account-list" }
	| { type: "summary-fields" }
	| { type: "behavior" }
	| { type: "theme" }
	| { type: "experimental" }
	| { type: "backend" }
	| { type: "back" };

type DashboardSettingKey = keyof DashboardDisplaySettings;

const ACCOUNT_LIST_PANEL_KEYS = [
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
] as const satisfies readonly DashboardSettingKey[];

const STATUSLINE_PANEL_KEYS = [
	"menuStatuslineFields",
] as const satisfies readonly DashboardSettingKey[];
const BEHAVIOR_PANEL_KEYS = [
	"actionAutoReturnMs",
	"actionPauseOnKey",
	"menuAutoFetchLimits",
	"menuShowFetchStatus",
	"menuQuotaTtlMs",
] as const satisfies readonly DashboardSettingKey[];
const THEME_PANEL_KEYS = [
	"uiThemePreset",
	"uiAccentColor",
] as const satisfies readonly DashboardSettingKey[];

function copyDashboardSettingValue(
	target: DashboardDisplaySettings,
	source: DashboardDisplaySettings,
	key: DashboardSettingKey,
): void {
	const value = source[key];
	(target as unknown as Record<string, unknown>)[key] = Array.isArray(value)
		? [...value]
		: value;
}

function applyDashboardDefaultsForKeys(
	draft: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
): DashboardDisplaySettings {
	const next = cloneDashboardSettings(draft);
	const defaults = cloneDashboardSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
	for (const key of keys) {
		copyDashboardSettingValue(next, defaults, key);
	}
	return next;
}

function mergeDashboardSettingsForKeys(
	base: DashboardDisplaySettings,
	selected: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
): DashboardDisplaySettings {
	const next = cloneDashboardSettings(base);
	for (const key of keys) {
		copyDashboardSettingValue(next, selected, key);
	}
	return cloneDashboardSettings(next);
}

async function persistDashboardSettingsSelection(
	selected: DashboardDisplaySettings,
	keys: readonly DashboardSettingKey[],
	scope: string,
): Promise<DashboardDisplaySettings> {
	const fallback = cloneDashboardSettings(selected);
	try {
		return await withQueuedRetry(
			getDashboardSettingsPath(),
			async () => {
				const latest = cloneDashboardSettings(
					await loadDashboardDisplaySettings(),
				);
				const merged = mergeDashboardSettingsForKeys(latest, selected, keys);
				await saveDashboardDisplaySettings(merged);
				return merged;
			},
			{ sleep },
		);
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}

async function persistBackendConfigSelection(
	selected: PluginConfig,
	scope: string,
): Promise<PluginConfig> {
	const fallback = cloneBackendPluginConfig(selected);
	try {
		await withQueuedRetry(
			resolvePluginConfigSavePathKey(),
			async () => {
				await savePluginConfig(buildBackendConfigPatch(selected));
			},
			{ sleep },
		);
		return fallback;
	} catch (error) {
		warnPersistFailure(scope, error);
		return fallback;
	}
}

function normalizeStatuslineFields(
	fields: DashboardStatuslineField[] | undefined,
): DashboardStatuslineField[] {
	const source = fields ?? DEFAULT_STATUSLINE_FIELDS;
	const seen = new Set<DashboardStatuslineField>();
	const normalized: DashboardStatuslineField[] = [];
	for (const field of source) {
		if (seen.has(field)) continue;
		seen.add(field);
		normalized.push(field);
	}
	if (normalized.length === 0) {
		return [...DEFAULT_STATUSLINE_FIELDS];
	}
	return normalized;
}

function highlightPreviewToken(
	text: string,
	ui: ReturnType<typeof getUiRuntimeOptions>,
): string {
	if (!output.isTTY) return text;
	if (ui.v2Enabled) {
		return `${ui.theme.colors.accent}${ANSI.bold}${text}${ui.theme.colors.reset}`;
	}
	return `${ANSI.cyan}${ANSI.bold}${text}${ANSI.reset}`;
}

function isLastUsedPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowLastUsed" || focus === "last-used";
}

function isLimitsPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowQuotaSummary" || focus === "limits";
}

function isLimitsCooldownPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowQuotaCooldown";
}

function isStatusPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowStatusBadge" || focus === "status";
}

function isCurrentBadgePreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuShowCurrentBadge";
}

function isCurrentRowPreviewFocus(focus: PreviewFocusKey): boolean {
	return focus === "menuHighlightCurrentRow";
}

function isExpandedRowsPreviewFocus(focus: PreviewFocusKey): boolean {
	return (
		focus === "menuShowDetailsForUnselectedRows" || focus === "menuLayoutMode"
	);
}

function buildSummaryPreviewText(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus: PreviewFocusKey = null,
): string {
	const partsByField = new Map<DashboardStatuslineField, string>();
	if (settings.menuShowLastUsed !== false) {
		const part = `last used: ${PREVIEW_LAST_USED}`;
		partsByField.set(
			"last-used",
			isLastUsedPreviewFocus(focus) ? highlightPreviewToken(part, ui) : part,
		);
	}
	if (settings.menuShowQuotaSummary !== false) {
		const limitsText =
			settings.menuShowQuotaCooldown === false
				? PREVIEW_LIMITS
				: `${PREVIEW_LIMITS} | ${PREVIEW_LIMIT_COOLDOWNS}`;
		const part = `limits: ${limitsText}`;
		partsByField.set(
			"limits",
			isLimitsPreviewFocus(focus) || isLimitsCooldownPreviewFocus(focus)
				? highlightPreviewToken(part, ui)
				: part,
		);
	}
	if (settings.menuShowStatusBadge === false) {
		const part = `status: ${PREVIEW_STATUS}`;
		partsByField.set(
			"status",
			isStatusPreviewFocus(focus) ? highlightPreviewToken(part, ui) : part,
		);
	}

	const orderedParts = normalizeStatuslineFields(settings.menuStatuslineFields)
		.map((field) => partsByField.get(field))
		.filter(
			(part): part is string => typeof part === "string" && part.length > 0,
		);
	if (orderedParts.length > 0) {
		return orderedParts.join(" | ");
	}

	const showsStatusField = normalizeStatuslineFields(
		settings.menuStatuslineFields,
	).includes("status");
	if (showsStatusField && settings.menuShowStatusBadge !== false) {
		const note = "status text appears only when status badges are hidden";
		return isStatusPreviewFocus(focus) ? highlightPreviewToken(note, ui) : note;
	}
	return "no summary text is visible with current account-list settings";
}

function buildAccountListPreview(
	settings: DashboardDisplaySettings,
	ui: ReturnType<typeof getUiRuntimeOptions>,
	focus: PreviewFocusKey = null,
): { label: string; hint: string } {
	const badges: string[] = [];
	if (settings.menuShowCurrentBadge !== false) {
		const currentBadge = "[current]";
		badges.push(
			isCurrentBadgePreviewFocus(focus)
				? highlightPreviewToken(currentBadge, ui)
				: currentBadge,
		);
	}
	if (settings.menuShowStatusBadge !== false) {
		const statusBadge = "[active]";
		badges.push(
			isStatusPreviewFocus(focus)
				? highlightPreviewToken(statusBadge, ui)
				: statusBadge,
		);
	}
	const badgeSuffix = badges.length > 0 ? ` ${badges.join(" ")}` : "";
	const accountEmail = isCurrentRowPreviewFocus(focus)
		? highlightPreviewToken(PREVIEW_ACCOUNT_EMAIL, ui)
		: PREVIEW_ACCOUNT_EMAIL;
	const rowDetailMode =
		resolveMenuLayoutMode(settings) === "expanded-rows"
			? "details shown on all rows"
			: "details shown on selected row only";
	const detailModeText = isExpandedRowsPreviewFocus(focus)
		? highlightPreviewToken(rowDetailMode, ui)
		: rowDetailMode;
	return {
		label: `1. ${accountEmail}${badgeSuffix}`,
		hint: `${buildSummaryPreviewText(settings, ui, focus)}\n${detailModeText}`,
	};
}

function cloneDashboardSettings(
	settings: DashboardDisplaySettings,
): DashboardDisplaySettings {
	return cloneDashboardSettingsData(settings, {
		resolveMenuLayoutMode,
		normalizeStatuslineFields,
	});
}

function dashboardSettingsEqual(
	left: DashboardDisplaySettings,
	right: DashboardDisplaySettings,
): boolean {
	return dashboardSettingsDataEqual(left, right, {
		resolveMenuLayoutMode,
		normalizeStatuslineFields,
	});
}

function clampBackendNumber(
	option: BackendNumberSettingOption,
	value: number,
): number {
	return Math.max(option.min, Math.min(option.max, Math.round(value)));
}

function applyUiThemeFromDashboardSettings(
	settings: DashboardDisplaySettings,
): void {
	const current = getUiRuntimeOptions();
	setUiRuntimeOptions({
		v2Enabled: current.v2Enabled,
		colorProfile: current.colorProfile,
		glyphMode: current.glyphMode,
		palette: settings.uiThemePreset ?? "green",
		accent: settings.uiAccentColor ?? "green",
	});
}

function formatDashboardSettingState(value: boolean): string {
	return value ? "[x]" : "[ ]";
}

function formatMenuSortMode(mode: DashboardAccountSortMode): string {
	return mode === "ready-first" ? "Ready-First" : "Manual";
}

function resolveMenuLayoutMode(
	settings: DashboardDisplaySettings,
): "compact-details" | "expanded-rows" {
	if (settings.menuLayoutMode === "expanded-rows") {
		return "expanded-rows";
	}
	if (settings.menuLayoutMode === "compact-details") {
		return "compact-details";
	}
	return settings.menuShowDetailsForUnselectedRows === true
		? "expanded-rows"
		: "compact-details";
}

function formatMenuLayoutMode(
	mode: "compact-details" | "expanded-rows",
): string {
	return mode === "expanded-rows" ? "Expanded Rows" : "Compact + Details Pane";
}

function formatMenuQuotaTtl(ttlMs: number): string {
	if (ttlMs >= 60_000 && ttlMs % 60_000 === 0) {
		return `${Math.round(ttlMs / 60_000)}m`;
	}
	if (ttlMs >= 1_000 && ttlMs % 1_000 === 0) {
		return `${Math.round(ttlMs / 1_000)}s`;
	}
	return `${ttlMs}ms`;
}

async function withQueuedRetryForTests<T>(
	pathKey: string,
	task: () => Promise<T>,
): Promise<T> {
	return withQueuedRetry(pathKey, task, { sleep });
}

async function persistDashboardSettingsSelectionForTests(
	selected: DashboardDisplaySettings,
	keys: ReadonlyArray<keyof DashboardDisplaySettings>,
	scope: string,
): Promise<DashboardDisplaySettings> {
	return persistDashboardSettingsSelection(
		selected,
		keys as readonly DashboardSettingKey[],
		scope,
	);
}

async function persistBackendConfigSelectionForTests(
	selected: PluginConfig,
	scope: string,
): Promise<PluginConfig> {
	return persistBackendConfigSelection(selected, scope);
}

const __testOnly = {
	clampBackendNumber: clampBackendNumberForTests,
	formatMenuLayoutMode,
	cloneDashboardSettings,
	withQueuedRetry: withQueuedRetryForTests,
	loadExperimentalSyncTarget,
	mapExperimentalMenuHotkey,
	mapExperimentalStatusHotkey,
	promptExperimentalSettings,
	persistDashboardSettingsSelection: persistDashboardSettingsSelectionForTests,
	persistBackendConfigSelection: persistBackendConfigSelectionForTests,
	buildAccountListPreview,
	buildSummaryPreviewText,
	normalizeStatuslineFields,
	reorderField,
	promptDashboardDisplaySettings,
	promptStatuslineSettings,
	promptBehaviorSettings,
	promptThemeSettings,
	promptBackendSettings,
};

/* c8 ignore start - interactive prompt flows are covered by integration tests */
async function promptDashboardDisplaySettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptDashboardDisplayPanel(initial, {
		cloneDashboardSettings,
		buildAccountListPreview,
		formatDashboardSettingState,
		formatMenuSortMode,
		resolveMenuLayoutMode: (settings) =>
			resolveMenuLayoutMode(settings ?? DEFAULT_DASHBOARD_DISPLAY_SETTINGS),
		formatMenuLayoutMode,
		applyDashboardDefaultsForKeys,
		DASHBOARD_DISPLAY_OPTIONS,
		ACCOUNT_LIST_PANEL_KEYS,
		UI_COPY,
	});
}

async function configureDashboardDisplaySettings(
	currentSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	const current = currentSettings ?? (await loadDashboardDisplaySettings());
	if (!input.isTTY || !output.isTTY) {
		console.log("Settings require interactive mode.");
		console.log(`Settings file: ${getDashboardSettingsPath()}`);
		return current;
	}

	const selected = await promptDashboardDisplaySettings(current);
	if (!selected) return current;
	if (dashboardSettingsEqual(current, selected)) return current;

	const merged = await persistDashboardSettingsSelection(
		selected,
		ACCOUNT_LIST_PANEL_KEYS,
		"account-list",
	);
	applyUiThemeFromDashboardSettings(merged);
	return merged;
}

function reorderField(
	fields: DashboardStatuslineField[],
	key: DashboardStatuslineField,
	direction: -1 | 1,
): DashboardStatuslineField[] {
	const index = fields.indexOf(key);
	if (index < 0) return fields;
	const target = index + direction;
	if (target < 0 || target >= fields.length) return fields;
	const next = [...fields];
	const current = next[index];
	const swap = next[target];
	if (!current || !swap) return fields;
	next[index] = swap;
	next[target] = current;
	return next;
}

async function promptStatuslineSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptStatuslineSettingsPanel(initial, {
		cloneDashboardSettings,
		buildAccountListPreview,
		normalizeStatuslineFields,
		formatDashboardSettingState,
		reorderField,
		applyDashboardDefaultsForKeys,
		STATUSLINE_FIELD_OPTIONS,
		STATUSLINE_PANEL_KEYS,
		UI_COPY,
	});
}

async function configureStatuslineSettings(
	currentSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	const current = currentSettings ?? (await loadDashboardDisplaySettings());
	if (!input.isTTY || !output.isTTY) {
		console.log("Settings require interactive mode.");
		console.log(`Settings file: ${getDashboardSettingsPath()}`);
		return current;
	}

	const selected = await promptStatuslineSettings(current);
	if (!selected) return current;
	if (dashboardSettingsEqual(current, selected)) return current;

	const merged = await persistDashboardSettingsSelection(
		selected,
		STATUSLINE_PANEL_KEYS,
		"summary-fields",
	);
	applyUiThemeFromDashboardSettings(merged);
	return merged;
}

function formatDelayLabel(delayMs: number): string {
	return delayMs <= 0
		? "Instant return"
		: `${Math.round(delayMs / 1000)}s auto-return`;
}

async function promptBehaviorSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptBehaviorSettingsPanel(initial, {
		cloneDashboardSettings,
		applyDashboardDefaultsForKeys,
		formatDelayLabel,
		formatMenuQuotaTtl,
		AUTO_RETURN_OPTIONS_MS,
		MENU_QUOTA_TTL_OPTIONS_MS,
		BEHAVIOR_PANEL_KEYS,
		UI_COPY,
	});
}

async function promptThemeSettings(
	initial: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings | null> {
	return promptThemeSettingsPanel(initial, {
		cloneDashboardSettings,
		applyDashboardDefaultsForKeys,
		applyUiThemeFromDashboardSettings,
		THEME_PRESET_OPTIONS,
		ACCENT_COLOR_OPTIONS,
		THEME_PANEL_KEYS,
		UI_COPY,
	});
}

function resolveFocusedBackendNumberKey(
	focus: BackendSettingFocusKey,
	numberOptions: BackendNumberSettingOption[] = BACKEND_NUMBER_OPTIONS,
): BackendNumberSettingKey {
	const numberKeys = new Set<BackendNumberSettingKey>(
		numberOptions.map((option) => option.key),
	);
	if (focus && numberKeys.has(focus as BackendNumberSettingKey)) {
		return focus as BackendNumberSettingKey;
	}
	return numberOptions[0]?.key ?? "fetchTimeoutMs";
}

function getBackendCategory(
	key: BackendCategoryKey,
): BackendCategoryOption | null {
	return (
		BACKEND_CATEGORY_OPTIONS.find((category) => category.key === key) ?? null
	);
}

function getBackendCategoryInitialFocus(
	category: BackendCategoryOption,
): BackendSettingFocusKey {
	const firstToggle = category.toggleKeys[0];
	if (firstToggle) return firstToggle;
	return category.numberKeys[0] ?? null;
}

function applyBackendCategoryDefaults(
	draft: PluginConfig,
	category: BackendCategoryOption,
): PluginConfig {
	const next = { ...draft };
	for (const key of category.toggleKeys) {
		next[key] = BACKEND_DEFAULTS[key] ?? false;
	}
	for (const key of category.numberKeys) {
		const option = BACKEND_NUMBER_OPTION_BY_KEY.get(key);
		const fallback = option?.min ?? 0;
		next[key] = BACKEND_DEFAULTS[key] ?? fallback;
	}
	return next;
}

async function promptBackendCategorySettings(
	initial: PluginConfig,
	category: BackendCategoryOption,
	initialFocus: BackendSettingFocusKey,
): Promise<{ draft: PluginConfig; focusKey: BackendSettingFocusKey }> {
	const ui = getUiRuntimeOptions();
	let draft = cloneBackendPluginConfig(initial);
	let focusKey: BackendSettingFocusKey = initialFocus;
	if (
		!focusKey ||
		(!category.toggleKeys.includes(focusKey as BackendToggleSettingKey) &&
			!category.numberKeys.includes(focusKey as BackendNumberSettingKey))
	) {
		focusKey = getBackendCategoryInitialFocus(category);
	}

	const toggleOptions = category.toggleKeys
		.map((key) => BACKEND_TOGGLE_OPTION_BY_KEY.get(key))
		.filter((option): option is BackendToggleSettingOption => !!option);
	const numberOptions = category.numberKeys
		.map((key) => BACKEND_NUMBER_OPTION_BY_KEY.get(key))
		.filter((option): option is BackendNumberSettingOption => !!option);

	while (true) {
		const preview = buildBackendSettingsPreview(draft, ui, focusKey, {
			highlightPreviewToken,
		});
		const toggleItems: MenuItem<BackendCategoryConfigAction>[] =
			toggleOptions.map((option, index) => {
				const enabled =
					draft[option.key] ?? BACKEND_DEFAULTS[option.key] ?? false;
				return {
					label: `${formatDashboardSettingState(enabled)} ${index + 1}. ${option.label}`,
					hint: option.description,
					value: { type: "toggle", key: option.key },
					color: enabled ? "green" : "yellow",
				};
			});
		const numberItems: MenuItem<BackendCategoryConfigAction>[] =
			numberOptions.map((option) => {
				const rawValue =
					draft[option.key] ?? BACKEND_DEFAULTS[option.key] ?? option.min;
				const numericValue =
					typeof rawValue === "number" && Number.isFinite(rawValue)
						? rawValue
						: option.min;
				const clampedValue = clampBackendNumber(option, numericValue);
				const valueLabel = formatBackendNumberValue(option, clampedValue);
				return {
					label: `${option.label}: ${valueLabel}`,
					hint: `${option.description} Step ${formatBackendNumberValue(option, option.step)}.`,
					value: { type: "bump", key: option.key, direction: 1 },
					color: "yellow",
				};
			});

		const focusedNumberKey = resolveFocusedBackendNumberKey(
			focusKey,
			numberOptions,
		);
		const items: MenuItem<BackendCategoryConfigAction>[] = [
			{
				label: UI_COPY.settings.previewHeading,
				value: { type: "back" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "back" },
				disabled: true,
				color: "green",
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "back" }, separator: true },
			{
				label: UI_COPY.settings.backendToggleHeading,
				value: { type: "back" },
				kind: "heading",
			},
			...toggleItems,
			{ label: "", value: { type: "back" }, separator: true },
			{
				label: UI_COPY.settings.backendNumberHeading,
				value: { type: "back" },
				kind: "heading",
			},
			...numberItems,
		];

		if (numberOptions.length > 0) {
			items.push({ label: "", value: { type: "back" }, separator: true });
			items.push({
				label: UI_COPY.settings.backendDecrease,
				value: { type: "bump", key: focusedNumberKey, direction: -1 },
				color: "yellow",
			});
			items.push({
				label: UI_COPY.settings.backendIncrease,
				value: { type: "bump", key: focusedNumberKey, direction: 1 },
				color: "green",
			});
		}

		items.push({ label: "", value: { type: "back" }, separator: true });
		items.push({
			label: UI_COPY.settings.backendResetCategory,
			value: { type: "reset-category" },
			color: "yellow",
		});
		items.push({
			label: UI_COPY.settings.backendBackToCategories,
			value: { type: "back" },
			color: "red",
		});

		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading")
				return false;
			if (item.value.type === "toggle" && focusKey === item.value.key)
				return true;
			if (item.value.type === "bump" && focusKey === item.value.key)
				return true;
			return false;
		});

		const result = await select<BackendCategoryConfigAction>(items, {
			message: `${UI_COPY.settings.backendCategoryTitle}: ${category.label}`,
			subtitle: category.description,
			help: UI_COPY.settings.backendCategoryHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (
					focusedItem?.value.type === "toggle" ||
					focusedItem?.value.type === "bump"
				) {
					focusKey = focusedItem.value.key;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "back" };
				if (lower === "r") return { type: "reset-category" };
				if (
					numberOptions.length > 0 &&
					(lower === "+" || lower === "=" || lower === "]" || lower === "d")
				) {
					return {
						type: "bump",
						key: resolveFocusedBackendNumberKey(focusKey, numberOptions),
						direction: 1,
					};
				}
				if (
					numberOptions.length > 0 &&
					(lower === "-" || lower === "[" || lower === "a")
				) {
					return {
						type: "bump",
						key: resolveFocusedBackendNumberKey(focusKey, numberOptions),
						direction: -1,
					};
				}
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= toggleOptions.length
				) {
					const target = toggleOptions[parsed - 1];
					if (target) return { type: "toggle", key: target.key };
				}
				return undefined;
			},
		});

		if (!result || result.type === "back") {
			return { draft, focusKey };
		}
		if (result.type === "reset-category") {
			draft = applyBackendCategoryDefaults(draft, category);
			focusKey = getBackendCategoryInitialFocus(category);
			continue;
		}
		if (result.type === "toggle") {
			const currentValue =
				draft[result.key] ?? BACKEND_DEFAULTS[result.key] ?? false;
			draft = { ...draft, [result.key]: !currentValue };
			focusKey = result.key;
			continue;
		}

		const option = BACKEND_NUMBER_OPTION_BY_KEY.get(result.key);
		if (!option) continue;
		const currentValue =
			draft[result.key] ?? BACKEND_DEFAULTS[result.key] ?? option.min;
		const numericCurrent =
			typeof currentValue === "number" && Number.isFinite(currentValue)
				? currentValue
				: option.min;
		draft = {
			...draft,
			[result.key]: clampBackendNumber(
				option,
				numericCurrent + option.step * result.direction,
			),
		};
		focusKey = result.key;
	}
}

async function promptBackendSettings(
	initial: PluginConfig,
): Promise<PluginConfig | null> {
	if (!input.isTTY || !output.isTTY) return null;

	const ui = getUiRuntimeOptions();
	let draft = cloneBackendPluginConfig(initial);
	let activeCategory = BACKEND_CATEGORY_OPTIONS[0]?.key ?? "session-sync";
	const focusByCategory: Partial<
		Record<BackendCategoryKey, BackendSettingFocusKey>
	> = {};
	for (const category of BACKEND_CATEGORY_OPTIONS) {
		focusByCategory[category.key] = getBackendCategoryInitialFocus(category);
	}

	while (true) {
		const previewFocus = focusByCategory[activeCategory] ?? null;
		const preview = buildBackendSettingsPreview(draft, ui, previewFocus, {
			highlightPreviewToken,
		});
		const categoryItems: MenuItem<BackendSettingsHubAction>[] =
			BACKEND_CATEGORY_OPTIONS.map((category, index) => {
				return {
					label: `${index + 1}. ${category.label}`,
					hint: category.description,
					value: { type: "open-category", key: category.key },
					color: "green",
				};
			});

		const items: MenuItem<BackendSettingsHubAction>[] = [
			{
				label: UI_COPY.settings.previewHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			{
				label: preview.label,
				hint: preview.hint,
				value: { type: "cancel" },
				disabled: true,
				color: "green",
				hideUnavailableSuffix: true,
			},
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.backendCategoriesHeading,
				value: { type: "cancel" },
				kind: "heading",
			},
			...categoryItems,
			{ label: "", value: { type: "cancel" }, separator: true },
			{
				label: UI_COPY.settings.resetDefault,
				value: { type: "reset" },
				color: "yellow",
			},
			{
				label: UI_COPY.settings.saveAndBack,
				value: { type: "save" },
				color: "green",
			},
			{
				label: UI_COPY.settings.backNoSave,
				value: { type: "cancel" },
				color: "red",
			},
		];

		const initialCursor = items.findIndex((item) => {
			if (item.separator || item.disabled || item.kind === "heading")
				return false;
			return (
				item.value.type === "open-category" && item.value.key === activeCategory
			);
		});

		const result = await select<BackendSettingsHubAction>(items, {
			message: UI_COPY.settings.backendTitle,
			subtitle: UI_COPY.settings.backendSubtitle,
			help: UI_COPY.settings.backendHelp,
			clearScreen: true,
			theme: ui.theme,
			selectedEmphasis: "minimal",
			initialCursor: initialCursor >= 0 ? initialCursor : undefined,
			onCursorChange: ({ cursor }) => {
				const focusedItem = items[cursor];
				if (focusedItem?.value.type === "open-category") {
					activeCategory = focusedItem.value.key;
				}
			},
			onInput: (raw) => {
				const lower = raw.toLowerCase();
				if (lower === "q") return { type: "cancel" };
				if (lower === "s") return { type: "save" };
				if (lower === "r") return { type: "reset" };
				const parsed = Number.parseInt(raw, 10);
				if (
					Number.isFinite(parsed) &&
					parsed >= 1 &&
					parsed <= BACKEND_CATEGORY_OPTIONS.length
				) {
					const target = BACKEND_CATEGORY_OPTIONS[parsed - 1];
					if (target) return { type: "open-category", key: target.key };
				}
				return undefined;
			},
		});

		if (!result || result.type === "cancel") return null;
		if (result.type === "save") return draft;
		if (result.type === "reset") {
			draft = cloneBackendPluginConfig(BACKEND_DEFAULTS);
			for (const category of BACKEND_CATEGORY_OPTIONS) {
				focusByCategory[category.key] =
					getBackendCategoryInitialFocus(category);
			}
			activeCategory = BACKEND_CATEGORY_OPTIONS[0]?.key ?? activeCategory;
			continue;
		}

		const category = getBackendCategory(result.key);
		if (!category) continue;
		activeCategory = category.key;
		const categoryResult = await promptBackendCategorySettings(
			draft,
			category,
			focusByCategory[category.key] ?? getBackendCategoryInitialFocus(category),
		);
		draft = categoryResult.draft;
		focusByCategory[category.key] = categoryResult.focusKey;
	}
}

async function loadExperimentalSyncTarget(): Promise<
	| {
			kind: "blocked-ambiguous";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
	  }
	| {
			kind: "blocked-none";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
	  }
	| { kind: "error"; message: string }
	| {
			kind: "target";
			detection: ReturnType<typeof detectOcChatgptMultiAuthTarget>;
			destination: import("../storage.js").AccountStorageV3 | null;
	  }
> {
	const detection = detectOcChatgptMultiAuthTarget();
	if (detection.kind === "ambiguous") {
		return { kind: "blocked-ambiguous", detection };
	}
	if (detection.kind === "none") {
		return { kind: "blocked-none", detection };
	}
	try {
		const raw = JSON.parse(
			await readFileWithRetry(detection.descriptor.accountPath, {
				retryableCodes: new Set([
					"EBUSY",
					"EPERM",
					"EAGAIN",
					"ENOTEMPTY",
					"EACCES",
				]),
				maxAttempts: 4,
				sleep,
			}),
		);
		const normalized = normalizeAccountStorage(raw);
		if (!normalized) {
			return {
				kind: "error",
				message: "Invalid target account storage format",
			};
		}
		return { kind: "target", detection, destination: normalized };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { kind: "target", detection, destination: null };
		}
		return {
			kind: "error",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

async function promptExperimentalSettings(
	initialConfig: PluginConfig,
): Promise<PluginConfig | null> {
	if (!input.isTTY || !output.isTTY) return null;
	const ui = getUiRuntimeOptions();
	let draft = cloneBackendPluginConfig(initialConfig);
	while (true) {
		const action = await select<ExperimentalSettingsAction>(
			[
				{
					label: UI_COPY.settings.experimentalSync,
					value: { type: "sync" },
					color: "yellow",
				},
				{
					label: UI_COPY.settings.experimentalBackup,
					value: { type: "backup" },
					color: "green",
				},
				{
					label: `${formatDashboardSettingState(draft.proactiveRefreshGuardian ?? false)} ${UI_COPY.settings.experimentalRefreshGuard}`,
					value: { type: "toggle-refresh-guardian" },
					color: "yellow",
				},
				{
					label: `${UI_COPY.settings.experimentalRefreshInterval}: ${Math.round((draft.proactiveRefreshIntervalMs ?? 60000) / 60000)} min`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: UI_COPY.settings.experimentalDecreaseInterval,
					value: { type: "decrease-refresh-interval" },
					color: "yellow",
				},
				{
					label: UI_COPY.settings.experimentalIncreaseInterval,
					value: { type: "increase-refresh-interval" },
					color: "green",
				},
				{
					label: UI_COPY.settings.saveAndBack,
					value: { type: "save" },
					color: "green",
				},
				{
					label: UI_COPY.settings.backNoSave,
					value: { type: "back" },
					color: "red",
				},
			],
			getExperimentalSelectOptions(
				ui,
				UI_COPY.settings.experimentalHelpMenu,
				mapExperimentalMenuHotkey,
			),
		);
		if (!action || action.type === "back") return null;
		if (action.type === "save") return draft;
		if (action.type === "toggle-refresh-guardian") {
			draft = {
				...draft,
				proactiveRefreshGuardian: !(draft.proactiveRefreshGuardian ?? false),
			};
			continue;
		}
		if (action.type === "decrease-refresh-interval") {
			draft = {
				...draft,
				proactiveRefreshIntervalMs: Math.max(
					60_000,
					(draft.proactiveRefreshIntervalMs ?? 60000) - 60000,
				),
			};
			continue;
		}
		if (action.type === "increase-refresh-interval") {
			draft = {
				...draft,
				proactiveRefreshIntervalMs: Math.min(
					600000,
					(draft.proactiveRefreshIntervalMs ?? 60000) + 60000,
				),
			};
			continue;
		}
		if (action.type === "backup") {
			const prompt = createInterface({ input, output });
			try {
				const backupName = (
					await prompt.question(UI_COPY.settings.experimentalBackupPrompt)
				).trim();
				if (!backupName || backupName.toLowerCase() === "q") {
					continue;
				}
				try {
					const backupResult = await runNamedBackupExport({ name: backupName });
					const backupLabel =
						backupResult.kind === "exported"
							? `Saved backup to ${backupResult.path}`
							: backupResult.kind === "collision"
								? `Backup already exists: ${backupResult.path}`
								: backupResult.error instanceof Error
									? backupResult.error.message
									: String(backupResult.error);
					await select<ExperimentalSettingsAction>(
						[
							{
								label: backupLabel,
								value: { type: "back" },
								disabled: true,
								hideUnavailableSuffix: true,
								color: backupResult.kind === "exported" ? "green" : "yellow",
							},
							{
								label: UI_COPY.settings.back,
								value: { type: "back" },
								color: "red",
							},
						],
						getExperimentalSelectOptions(
							ui,
							UI_COPY.settings.experimentalHelpStatus,
							mapExperimentalStatusHotkey,
						),
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					await select<ExperimentalSettingsAction>(
						[
							{
								label: message,
								value: { type: "back" },
								disabled: true,
								hideUnavailableSuffix: true,
								color: "yellow",
							},
							{
								label: UI_COPY.settings.back,
								value: { type: "back" },
								color: "red",
							},
						],
						getExperimentalSelectOptions(
							ui,
							UI_COPY.settings.experimentalHelpStatus,
							mapExperimentalStatusHotkey,
						),
					);
				}
			} finally {
				prompt.close();
			}
			continue;
		}

		const source = await loadAccounts();
		const targetState = await loadExperimentalSyncTarget();
		if (targetState.kind === "error") {
			await select<ExperimentalSettingsAction>(
				[
					{
						label: targetState.message,
						value: { type: "back" },
						disabled: true,
						hideUnavailableSuffix: true,
						color: "yellow",
					},
					{
						label: UI_COPY.settings.back,
						value: { type: "back" },
						color: "red",
					},
				],
				getExperimentalSelectOptions(
					ui,
					UI_COPY.settings.experimentalHelpStatus,
					mapExperimentalStatusHotkey,
				),
			);
			continue;
		}
		const plan = await planOcChatgptSync({
			source,
			destination:
				targetState.kind === "target" ? targetState.destination : null,
			dependencies:
				targetState.kind === "target"
					? { detectTarget: () => targetState.detection }
					: undefined,
		});
		if (plan.kind !== "ready") {
			await select<ExperimentalSettingsAction>(
				[
					{
						label:
							plan.kind === "blocked-ambiguous"
								? `Sync blocked: ${plan.detection.reason}`
								: `Sync unavailable: ${plan.detection.reason}`,
						value: { type: "back" },
						disabled: true,
						hideUnavailableSuffix: true,
						color: "yellow",
					},
					{
						label: UI_COPY.settings.back,
						value: { type: "back" },
						color: "red",
					},
				],
				getExperimentalSelectOptions(
					ui,
					UI_COPY.settings.experimentalHelpStatus,
					mapExperimentalStatusHotkey,
				),
			);
			continue;
		}

		const review = await select<ExperimentalSettingsAction>(
			[
				{
					label: `Preview: add ${plan.preview.toAdd.length} | update ${plan.preview.toUpdate.length} | skip ${plan.preview.toSkip.length}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: `Preserve destination-only: ${plan.preview.unchangedDestinationOnly.length}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: `Active selection: ${plan.preview.activeSelectionBehavior}`,
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: "green",
				},
				{
					label: UI_COPY.settings.experimentalApplySync,
					value: { type: "apply" },
					color: "green",
				},
				{
					label: UI_COPY.settings.backNoSave,
					value: { type: "back" },
					color: "red",
				},
			],
			getExperimentalSelectOptions(
				ui,
				UI_COPY.settings.experimentalHelpPreview,
				(raw) => {
					const lower = raw.toLowerCase();
					if (lower === "q") return { type: "back" };
					if (lower === "a") return { type: "apply" };
					return undefined;
				},
			),
		);
		if (!review || review.type === "back") continue;

		const applied = await applyOcChatgptSync({
			source,
			destination:
				targetState.kind === "target" ? targetState.destination : undefined,
			dependencies:
				targetState.kind === "target"
					? { detectTarget: () => targetState.detection }
					: undefined,
		});
		await select<ExperimentalSettingsAction>(
			[
				{
					label:
						applied.kind === "applied"
							? `Applied sync to ${applied.target.accountPath}`
							: applied.kind === "error"
								? applied.error instanceof Error
									? applied.error.message
									: String(applied.error)
								: "Sync did not apply",
					value: { type: "back" },
					disabled: true,
					hideUnavailableSuffix: true,
					color: applied.kind === "applied" ? "green" : "yellow",
				},
				{ label: UI_COPY.settings.back, value: { type: "back" }, color: "red" },
			],
			getExperimentalSelectOptions(
				ui,
				UI_COPY.settings.experimentalHelpStatus,
				mapExperimentalStatusHotkey,
			),
		);
	}
}

async function configureBackendSettings(
	currentConfig?: PluginConfig,
): Promise<PluginConfig> {
	const current = cloneBackendPluginConfig(currentConfig ?? loadPluginConfig());
	if (!input.isTTY || !output.isTTY) {
		console.log("Settings require interactive mode.");
		return current;
	}

	const selected = await promptBackendSettings(current);
	if (!selected) return current;
	if (backendSettingsEqual(current, selected)) return current;

	return persistBackendConfigSelection(selected, "backend");
}

async function promptSettingsHub(
	initialFocus: SettingsHubAction["type"] = "account-list",
): Promise<SettingsHubAction | null> {
	if (!input.isTTY || !output.isTTY) return null;
	const ui = getUiRuntimeOptions();
	const items: MenuItem<SettingsHubAction>[] = [
		{
			label: UI_COPY.settings.sectionTitle,
			value: { type: "back" },
			kind: "heading",
		},
		{
			label: UI_COPY.settings.accountList,
			value: { type: "account-list" },
			color: "green",
		},
		{
			label: UI_COPY.settings.summaryFields,
			value: { type: "summary-fields" },
			color: "green",
		},
		{
			label: UI_COPY.settings.behavior,
			value: { type: "behavior" },
			color: "green",
		},
		{ label: UI_COPY.settings.theme, value: { type: "theme" }, color: "green" },
		{ label: "", value: { type: "back" }, separator: true },
		{
			label: UI_COPY.settings.advancedTitle,
			value: { type: "back" },
			kind: "heading",
		},
		{
			label: UI_COPY.settings.experimental,
			value: { type: "experimental" },
			color: "yellow",
		},
		{
			label: UI_COPY.settings.backend,
			value: { type: "backend" },
			color: "green",
		},
		{ label: "", value: { type: "back" }, separator: true },
		{
			label: UI_COPY.settings.exitTitle,
			value: { type: "back" },
			kind: "heading",
		},
		{ label: UI_COPY.settings.back, value: { type: "back" }, color: "red" },
	];
	const initialCursor = items.findIndex((item) => {
		if (item.separator || item.disabled || item.kind === "heading")
			return false;
		return item.value.type === initialFocus;
	});
	return select<SettingsHubAction>(items, {
		message: UI_COPY.settings.title,
		subtitle: UI_COPY.settings.subtitle,
		help: UI_COPY.settings.help,
		clearScreen: true,
		theme: ui.theme,
		selectedEmphasis: "minimal",
		initialCursor: initialCursor >= 0 ? initialCursor : undefined,
		onInput: (raw) => {
			const lower = raw.toLowerCase();
			if (lower === "q") return { type: "back" };
			return undefined;
		},
	});
}

/* c8 ignore stop */

async function configureUnifiedSettings(
	initialSettings?: DashboardDisplaySettings,
): Promise<DashboardDisplaySettings> {
	let current = cloneDashboardSettings(
		initialSettings ?? (await loadDashboardDisplaySettings()),
	);
	let backendConfig = cloneBackendPluginConfig(loadPluginConfig());
	applyUiThemeFromDashboardSettings(current);
	let hubFocus: SettingsHubAction["type"] = "account-list";
	while (true) {
		const action = await promptSettingsHub(hubFocus);
		if (!action || action.type === "back") {
			return current;
		}
		hubFocus = action.type;
		if (action.type === "account-list") {
			current = await configureDashboardDisplaySettings(current);
			continue;
		}
		if (action.type === "summary-fields") {
			current = await configureStatuslineSettings(current);
			continue;
		}
		if (action.type === "behavior") {
			const selected = await promptBehaviorSettings(current);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(
					selected,
					BEHAVIOR_PANEL_KEYS,
					"behavior",
				);
			}
			continue;
		}
		if (action.type === "theme") {
			const selected = await promptThemeSettings(current);
			if (selected && !dashboardSettingsEqual(current, selected)) {
				current = await persistDashboardSettingsSelection(
					selected,
					THEME_PANEL_KEYS,
					"theme",
				);
				applyUiThemeFromDashboardSettings(current);
			}
			continue;
		}
		if (action.type === "experimental") {
			const selected = await promptExperimentalSettings(backendConfig);
			if (selected && !backendSettingsEqual(backendConfig, selected)) {
				backendConfig = await persistBackendConfigSelection(
					selected,
					"experimental",
				);
			} else if (selected) {
				backendConfig = selected;
			}
			continue;
		}
		if (action.type === "backend") {
			backendConfig = await configureBackendSettings(backendConfig);
		}
	}
}

export {
	configureUnifiedSettings,
	applyUiThemeFromDashboardSettings,
	resolveMenuLayoutMode,
	__testOnly,
};
