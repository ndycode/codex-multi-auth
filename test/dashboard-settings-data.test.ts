import { describe, expect, it } from "vitest";
import {
	cloneDashboardSettingsData,
	dashboardSettingsDataEqual,
} from "../lib/codex-manager/dashboard-settings-data.js";
import {
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
	type DashboardDisplaySettings,
	type DashboardStatuslineField,
} from "../lib/dashboard-settings.js";
import { resolveMenuLayoutMode } from "../lib/codex-manager/settings-hub.js";

const DEFAULT_FIELDS: DashboardStatuslineField[] = [
	"last-used",
	"limits",
	"status",
];

// The real production deps: the actual layout-mode resolver, and a
// normalizer matching dashboard-settings semantics (default on absence).
const deps = {
	resolveMenuLayoutMode,
	normalizeStatuslineFields: (
		fields: DashboardDisplaySettings["menuStatuslineFields"],
	) => fields ?? DEFAULT_FIELDS,
};

function settings(
	overrides: Partial<DashboardDisplaySettings> = {},
): DashboardDisplaySettings {
	return { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS, ...overrides };
}

// A sparse settings object as it comes from an older settings.json that
// predates most optional fields.
const SPARSE: DashboardDisplaySettings = {
	showPerAccountRows: true,
	showQuotaDetails: false,
	showForecastReasons: true,
	showRecommendations: false,
	showLiveProbeNotes: true,
};

describe("cloneDashboardSettingsData", () => {
	it("fills every optional field with its documented default", () => {
		const clone = cloneDashboardSettingsData(SPARSE, deps);

		expect(clone).toMatchObject({
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
			menuQuotaTtlMs: 5 * 60_000,
			menuFocusStyle: "row-invert",
			menuHighlightCurrentRow: true,
			menuLayoutMode: "compact-details",
			menuShowDetailsForUnselectedRows: false,
			menuStatuslineFields: DEFAULT_FIELDS,
		});
		// The required flags pass through unchanged.
		expect(clone.showQuotaDetails).toBe(false);
		expect(clone.showRecommendations).toBe(false);
	});

	it("derives layout mode and the unselected-rows flag together", () => {
		const expanded = cloneDashboardSettingsData(
			{ ...SPARSE, menuShowDetailsForUnselectedRows: true },
			deps,
		);
		expect(expanded.menuLayoutMode).toBe("expanded-rows");
		expect(expanded.menuShowDetailsForUnselectedRows).toBe(true);

		// An explicit layout mode wins over the legacy boolean.
		const compact = cloneDashboardSettingsData(
			{
				...SPARSE,
				menuLayoutMode: "compact-details",
				menuShowDetailsForUnselectedRows: true,
			},
			deps,
		);
		expect(compact.menuLayoutMode).toBe("compact-details");
		expect(compact.menuShowDetailsForUnselectedRows).toBe(false);
	});

	it("copies the statusline fields instead of aliasing the input array", () => {
		const fields: DashboardStatuslineField[] = ["limits"];
		const clone = cloneDashboardSettingsData(
			{ ...SPARSE, menuStatuslineFields: fields },
			deps,
		);

		expect(clone.menuStatuslineFields).toEqual(["limits"]);
		expect(clone.menuStatuslineFields).not.toBe(fields);
	});
});

describe("dashboardSettingsDataEqual", () => {
	it("treats absent optional fields as equal to their defaults", () => {
		expect(
			dashboardSettingsDataEqual(
				SPARSE,
				cloneDashboardSettingsData(SPARSE, deps),
				deps,
			),
		).toBe(true);
		// A fully-defaulted object equals the sparse one when the required
		// flags agree.
		expect(
			dashboardSettingsDataEqual(
				settings({ showQuotaDetails: false, showRecommendations: false }),
				SPARSE,
				deps,
			),
		).toBe(true);
	});

	it.each([
		["menuQuotaTtlMs", { menuQuotaTtlMs: 60_000 }],
		["uiThemePreset", { uiThemePreset: "mono" }],
		["uiAccentColor", { uiAccentColor: "cyan" }],
		["showQuotaDetails", { showQuotaDetails: false }],
		["showPerAccountRows", { showPerAccountRows: false }],
		["actionAutoReturnMs", { actionAutoReturnMs: 500 }],
		["actionPauseOnKey", { actionPauseOnKey: false }],
		["menuAutoFetchLimits", { menuAutoFetchLimits: false }],
		["menuSortEnabled", { menuSortEnabled: false }],
		["menuSortPinCurrent", { menuSortPinCurrent: true }],
		[
			"menuSortQuickSwitchVisibleRow",
			{ menuSortQuickSwitchVisibleRow: false },
		],
		["menuShowStatusBadge", { menuShowStatusBadge: false }],
		["menuShowCurrentBadge", { menuShowCurrentBadge: false }],
		["menuShowLastUsed", { menuShowLastUsed: false }],
		["menuShowQuotaSummary", { menuShowQuotaSummary: false }],
		["menuShowQuotaCooldown", { menuShowQuotaCooldown: false }],
		["menuShowFetchStatus", { menuShowFetchStatus: false }],
		["menuHighlightCurrentRow", { menuHighlightCurrentRow: false }],
	] as const satisfies ReadonlyArray<
		readonly [string, Partial<DashboardDisplaySettings>]
	>)("detects a difference in %s alone", (_field, override) => {
		expect(
			dashboardSettingsDataEqual(settings(), settings(override), deps),
		).toBe(false);
	});

	it("compares layout through the resolver, not the raw fields", () => {
		// expanded-rows expressed via the legacy boolean equals the explicit
		// layout-mode spelling (no explicit menuLayoutMode on the left, since
		// an explicit mode would win over the boolean).
		expect(
			dashboardSettingsDataEqual(
				{ ...SPARSE, menuShowDetailsForUnselectedRows: true },
				{ ...SPARSE, menuLayoutMode: "expanded-rows" },
				deps,
			),
		).toBe(true);
		expect(
			dashboardSettingsDataEqual(
				settings({ menuLayoutMode: "expanded-rows" }),
				settings({ menuLayoutMode: "compact-details" }),
				deps,
			),
		).toBe(false);
	});

	it("compares statusline fields through the normalizer", () => {
		// Absent fields equal the normalized default list...
		expect(
			dashboardSettingsDataEqual(
				settings({ menuStatuslineFields: undefined }),
				settings({ menuStatuslineFields: DEFAULT_FIELDS }),
				deps,
			),
		).toBe(true);
		// ...but a different order is a real difference.
		expect(
			dashboardSettingsDataEqual(
				settings({ menuStatuslineFields: ["limits", "status", "last-used"] }),
				settings({ menuStatuslineFields: DEFAULT_FIELDS }),
				deps,
			),
		).toBe(false);
	});
});
