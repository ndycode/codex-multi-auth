import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "./runtime-paths.js";
import { logWarn } from "./logger.js";
import {
	getUnifiedSettingsPath,
	loadUnifiedDashboardSettings,
	saveUnifiedDashboardSettings,
} from "./unified-settings.js";

export type DashboardThemePreset = "green" | "blue";
export type DashboardAccentColor = "green" | "cyan" | "blue" | "yellow";
export type DashboardAccountSortMode = "manual" | "ready-first";
export type DashboardLayoutMode = "compact-details" | "expanded-rows";
export type DashboardFocusStyle = "row-invert";

export interface DashboardDisplaySettings {
	showPerAccountRows: boolean;
	showQuotaDetails: boolean;
	showForecastReasons: boolean;
	showRecommendations: boolean;
	showLiveProbeNotes: boolean;
	actionAutoReturnMs?: number;
	actionPauseOnKey?: boolean;
	menuAutoFetchLimits?: boolean;
	menuSortEnabled?: boolean;
	menuSortMode?: DashboardAccountSortMode;
	menuSortPinCurrent?: boolean;
	menuSortQuickSwitchVisibleRow?: boolean;
	uiThemePreset?: DashboardThemePreset;
	uiAccentColor?: DashboardAccentColor;
	menuShowStatusBadge?: boolean;
	menuShowCurrentBadge?: boolean;
	menuShowLastUsed?: boolean;
	menuShowQuotaSummary?: boolean;
	menuShowQuotaCooldown?: boolean;
	menuShowFetchStatus?: boolean;
	menuShowDetailsForUnselectedRows?: boolean;
	menuLayoutMode?: DashboardLayoutMode;
	menuQuotaTtlMs?: number;
	menuFocusStyle?: DashboardFocusStyle;
	menuHighlightCurrentRow?: boolean;
	menuStatuslineFields?: DashboardStatuslineField[];
}

export type DashboardStatuslineField = "last-used" | "limits" | "status";

export const DASHBOARD_DISPLAY_SETTINGS_VERSION = 1 as const;

export const DEFAULT_DASHBOARD_DISPLAY_SETTINGS: DashboardDisplaySettings = {
	showPerAccountRows: true,
	showQuotaDetails: true,
	showForecastReasons: true,
	showRecommendations: true,
	showLiveProbeNotes: true,
	actionAutoReturnMs: 2_000,
	actionPauseOnKey: true,
	menuAutoFetchLimits: true,
	menuSortEnabled: true,
	menuSortMode: "ready-first",
	menuSortPinCurrent: false,
	menuSortQuickSwitchVisibleRow: true,
	uiThemePreset: "green",
	uiAccentColor: "green",
	menuShowStatusBadge: true,
	menuShowCurrentBadge: true,
	menuShowLastUsed: true,
	menuShowQuotaSummary: true,
	menuShowQuotaCooldown: true,
	menuShowFetchStatus: true,
	menuShowDetailsForUnselectedRows: false,
	menuLayoutMode: "compact-details",
	menuQuotaTtlMs: 5 * 60_000,
	menuFocusStyle: "row-invert",
	menuHighlightCurrentRow: true,
	menuStatuslineFields: ["last-used", "limits", "status"],
};

const DASHBOARD_SETTINGS_PATH = join(getCodexMultiAuthDir(), "dashboard-settings.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeThemePreset(value: unknown): DashboardThemePreset {
	return value === "blue" ? "blue" : "green";
}

function normalizeAccentColor(value: unknown): DashboardAccentColor {
	switch (value) {
		case "cyan":
			return "cyan";
		case "blue":
			return "blue";
		case "yellow":
			return "yellow";
		default:
			return "green";
	}
}

function normalizeLayoutMode(
	value: unknown,
	fallback: DashboardLayoutMode,
): DashboardLayoutMode {
	return value === "expanded-rows" ? "expanded-rows" : fallback;
}

function normalizeFocusStyle(value: unknown): DashboardFocusStyle {
	return value === "row-invert" ? "row-invert" : "row-invert";
}

function normalizeQuotaTtlMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.max(60_000, Math.min(30 * 60_000, rounded));
}

function normalizeAccountSortMode(value: unknown, fallback: DashboardAccountSortMode): DashboardAccountSortMode {
	if (value === "ready-first" || value === "manual") {
		return value;
	}
	return fallback;
}

function normalizeAutoReturnMs(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const rounded = Math.round(value);
	return Math.max(0, Math.min(10_000, rounded));
}

function normalizeStatuslineFields(value: unknown): DashboardStatuslineField[] {
	const defaultFields = [...(DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuStatuslineFields ?? [])];
	if (!Array.isArray(value)) return defaultFields;

	const allowed = new Set<DashboardStatuslineField>(["last-used", "limits", "status"]);
	const fields: DashboardStatuslineField[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		if (!allowed.has(entry as DashboardStatuslineField)) continue;
		const typed = entry as DashboardStatuslineField;
		if (!fields.includes(typed)) {
			fields.push(typed);
		}
	}

	return fields.length > 0 ? fields : defaultFields;
}

function toJsonRecord(value: DashboardDisplaySettings): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value)) {
		record[key] = fieldValue;
	}
	return record;
}

export function getDashboardSettingsPath(): string {
	return getUnifiedSettingsPath();
}

export function normalizeDashboardDisplaySettings(
	value: unknown,
): DashboardDisplaySettings {
	if (!isRecord(value)) {
		return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
	}
	const derivedLayoutMode = normalizeLayoutMode(
		value.menuLayoutMode,
		value.menuShowDetailsForUnselectedRows === true ? "expanded-rows" : "compact-details",
	);
	return {
		showPerAccountRows: normalizeBoolean(
			value.showPerAccountRows,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showPerAccountRows,
		),
		showQuotaDetails: normalizeBoolean(
			value.showQuotaDetails,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showQuotaDetails,
		),
		showForecastReasons: normalizeBoolean(
			value.showForecastReasons,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showForecastReasons,
		),
		showRecommendations: normalizeBoolean(
			value.showRecommendations,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showRecommendations,
		),
		showLiveProbeNotes: normalizeBoolean(
			value.showLiveProbeNotes,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.showLiveProbeNotes,
		),
		actionAutoReturnMs: normalizeAutoReturnMs(
			value.actionAutoReturnMs,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.actionAutoReturnMs ?? 2_000,
		),
		actionPauseOnKey: normalizeBoolean(
			value.actionPauseOnKey,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.actionPauseOnKey ?? true,
		),
		menuAutoFetchLimits: normalizeBoolean(
			value.menuAutoFetchLimits,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuAutoFetchLimits ?? true,
		),
		menuSortEnabled: normalizeBoolean(
			value.menuSortEnabled,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ?? false,
		),
		menuSortMode: normalizeAccountSortMode(
			value.menuSortMode,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ?? "ready-first",
		),
		menuSortPinCurrent: normalizeBoolean(
			value.menuSortPinCurrent,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ?? true,
		),
		menuSortQuickSwitchVisibleRow: normalizeBoolean(
			value.menuSortQuickSwitchVisibleRow,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortQuickSwitchVisibleRow ?? true,
		),
		uiThemePreset: normalizeThemePreset(
			value.uiThemePreset,
		),
		uiAccentColor: normalizeAccentColor(
			value.uiAccentColor,
		),
		menuShowStatusBadge: normalizeBoolean(
			value.menuShowStatusBadge,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowStatusBadge ?? true,
		),
		menuShowCurrentBadge: normalizeBoolean(
			value.menuShowCurrentBadge,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowCurrentBadge ?? true,
		),
		menuShowLastUsed: normalizeBoolean(
			value.menuShowLastUsed,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowLastUsed ?? true,
		),
		menuShowQuotaSummary: normalizeBoolean(
			value.menuShowQuotaSummary,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowQuotaSummary ?? true,
		),
		menuShowQuotaCooldown: normalizeBoolean(
			value.menuShowQuotaCooldown,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowQuotaCooldown ?? true,
		),
		menuShowFetchStatus: normalizeBoolean(
			value.menuShowFetchStatus,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowFetchStatus ?? true,
		),
		menuShowDetailsForUnselectedRows: derivedLayoutMode === "expanded-rows",
		menuLayoutMode: derivedLayoutMode,
		menuQuotaTtlMs: normalizeQuotaTtlMs(
			value.menuQuotaTtlMs,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuQuotaTtlMs ?? 5 * 60_000,
		),
		menuFocusStyle: normalizeFocusStyle(value.menuFocusStyle),
		menuHighlightCurrentRow: normalizeBoolean(
			value.menuHighlightCurrentRow,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuHighlightCurrentRow ?? true,
		),
		menuStatuslineFields: normalizeStatuslineFields(value.menuStatuslineFields),
	};
}

export async function loadDashboardDisplaySettings(): Promise<DashboardDisplaySettings> {
	const unifiedSettings = await loadUnifiedDashboardSettings();
	if (unifiedSettings) {
		return normalizeDashboardDisplaySettings(unifiedSettings);
	}

	if (!existsSync(DASHBOARD_SETTINGS_PATH)) {
		return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
	}

	try {
		const raw = await fs.readFile(DASHBOARD_SETTINGS_PATH, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) {
			return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
		}
		const normalized = normalizeDashboardDisplaySettings(parsed.settings);
		try {
			await saveUnifiedDashboardSettings(toJsonRecord(normalized));
		} catch {
			// Keep legacy fallback behavior even if migration write fails.
		}
		return normalized;
	} catch (error) {
		logWarn(
			`Failed to load dashboard settings from ${DASHBOARD_SETTINGS_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
	}
}

export async function saveDashboardDisplaySettings(
	settings: DashboardDisplaySettings,
): Promise<void> {
	const normalized = normalizeDashboardDisplaySettings(settings);
	await saveUnifiedDashboardSettings(toJsonRecord(normalized));
}
