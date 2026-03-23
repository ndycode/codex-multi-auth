import {
	type DashboardDisplaySettings,
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
} from "../dashboard-settings.js";

export function cloneDashboardSettingsData(
	settings: DashboardDisplaySettings,
	deps: {
		resolveMenuLayoutMode: (
			settings: DashboardDisplaySettings,
		) => "compact-details" | "expanded-rows";
		normalizeStatuslineFields: (
			fields: DashboardDisplaySettings["menuStatuslineFields"],
		) => DashboardDisplaySettings["menuStatuslineFields"];
	},
): DashboardDisplaySettings {
	const layoutMode = deps.resolveMenuLayoutMode(settings);
	return {
		showPerAccountRows: settings.showPerAccountRows,
		showQuotaDetails: settings.showQuotaDetails,
		showForecastReasons: settings.showForecastReasons,
		showRecommendations: settings.showRecommendations,
		showLiveProbeNotes: settings.showLiveProbeNotes,
		actionAutoReturnMs: settings.actionAutoReturnMs ?? 2_000,
		actionPauseOnKey: settings.actionPauseOnKey ?? true,
		menuAutoFetchLimits: settings.menuAutoFetchLimits ?? true,
		menuSortEnabled:
			settings.menuSortEnabled ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
			true,
		menuSortMode:
			settings.menuSortMode ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
			"ready-first",
		menuSortPinCurrent:
			settings.menuSortPinCurrent ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
			false,
		menuSortQuickSwitchVisibleRow:
			settings.menuSortQuickSwitchVisibleRow ?? true,
		uiThemePreset: settings.uiThemePreset ?? "green",
		uiAccentColor: settings.uiAccentColor ?? "green",
		menuShowStatusBadge: settings.menuShowStatusBadge ?? true,
		menuShowCurrentBadge: settings.menuShowCurrentBadge ?? true,
		menuShowLastUsed: settings.menuShowLastUsed ?? true,
		menuShowQuotaSummary: settings.menuShowQuotaSummary ?? true,
		menuShowQuotaCooldown: settings.menuShowQuotaCooldown ?? true,
		menuShowFetchStatus: settings.menuShowFetchStatus ?? true,
		menuShowDetailsForUnselectedRows: layoutMode === "expanded-rows",
		menuLayoutMode: layoutMode,
		menuQuotaTtlMs: settings.menuQuotaTtlMs ?? 5 * 60_000,
		menuFocusStyle: settings.menuFocusStyle ?? "row-invert",
		menuHighlightCurrentRow: settings.menuHighlightCurrentRow ?? true,
		menuStatuslineFields: [
			...(deps.normalizeStatuslineFields(settings.menuStatuslineFields) ?? []),
		],
	};
}

export function dashboardSettingsDataEqual(
	left: DashboardDisplaySettings,
	right: DashboardDisplaySettings,
	deps: {
		resolveMenuLayoutMode: (
			settings: DashboardDisplaySettings,
		) => "compact-details" | "expanded-rows";
		normalizeStatuslineFields: (
			fields: DashboardDisplaySettings["menuStatuslineFields"],
		) => DashboardDisplaySettings["menuStatuslineFields"];
	},
): boolean {
	return (
		left.showPerAccountRows === right.showPerAccountRows &&
		left.showQuotaDetails === right.showQuotaDetails &&
		left.showForecastReasons === right.showForecastReasons &&
		left.showRecommendations === right.showRecommendations &&
		left.showLiveProbeNotes === right.showLiveProbeNotes &&
		(left.actionAutoReturnMs ?? 2_000) ===
			(right.actionAutoReturnMs ?? 2_000) &&
		(left.actionPauseOnKey ?? true) === (right.actionPauseOnKey ?? true) &&
		(left.menuAutoFetchLimits ?? true) ===
			(right.menuAutoFetchLimits ?? true) &&
		(left.menuSortEnabled ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
			true) ===
			(right.menuSortEnabled ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortEnabled ??
				true) &&
		(left.menuSortMode ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
			"ready-first") ===
			(right.menuSortMode ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortMode ??
				"ready-first") &&
		(left.menuSortPinCurrent ??
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
			false) ===
			(right.menuSortPinCurrent ??
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuSortPinCurrent ??
				false) &&
		(left.menuSortQuickSwitchVisibleRow ?? true) ===
			(right.menuSortQuickSwitchVisibleRow ?? true) &&
		(left.uiThemePreset ?? "green") === (right.uiThemePreset ?? "green") &&
		(left.uiAccentColor ?? "green") === (right.uiAccentColor ?? "green") &&
		(left.menuShowStatusBadge ?? true) ===
			(right.menuShowStatusBadge ?? true) &&
		(left.menuShowCurrentBadge ?? true) ===
			(right.menuShowCurrentBadge ?? true) &&
		(left.menuShowLastUsed ?? true) === (right.menuShowLastUsed ?? true) &&
		(left.menuShowQuotaSummary ?? true) ===
			(right.menuShowQuotaSummary ?? true) &&
		(left.menuShowQuotaCooldown ?? true) ===
			(right.menuShowQuotaCooldown ?? true) &&
		(left.menuShowFetchStatus ?? true) ===
			(right.menuShowFetchStatus ?? true) &&
		deps.resolveMenuLayoutMode(left) === deps.resolveMenuLayoutMode(right) &&
		(left.menuQuotaTtlMs ?? 5 * 60_000) ===
			(right.menuQuotaTtlMs ?? 5 * 60_000) &&
		(left.menuFocusStyle ?? "row-invert") ===
			(right.menuFocusStyle ?? "row-invert") &&
		(left.menuHighlightCurrentRow ?? true) ===
			(right.menuHighlightCurrentRow ?? true) &&
		JSON.stringify(
			deps.normalizeStatuslineFields(left.menuStatuslineFields),
		) ===
			JSON.stringify(deps.normalizeStatuslineFields(right.menuStatuslineFields))
	);
}
