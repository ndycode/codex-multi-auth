import { describe, expect, it, vi } from "vitest";
import {
	formatAutoReturnDelayLabel,
	promptBehaviorSettingsPanelEntry,
	promptDashboardDisplaySettingsPanelEntry,
	promptStatuslineSettingsPanelEntry,
	promptThemeSettingsPanelEntry,
	reorderStatuslineField,
} from "../lib/codex-manager/settings-panels.js";
import { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } from "../lib/dashboard-settings.js";

describe("settings panel helpers", () => {
	it("reorders statusline fields safely", () => {
		expect(
			reorderStatuslineField(["last-used", "limits", "status"], "limits", -1),
		).toEqual(["limits", "last-used", "status"]);
		expect(reorderStatuslineField(["last-used"], "last-used", -1)).toEqual([
			"last-used",
		]);
	});

	it("formats auto return delay labels", () => {
		expect(formatAutoReturnDelayLabel(0)).toBe("Instant return");
		expect(formatAutoReturnDelayLabel(4000)).toBe("4s auto-return");
	});

	it("passes dashboard display panel dependencies through and falls back to defaults", async () => {
		const initial = { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
		const cloneDashboardSettings = vi.fn((value) => ({ ...value }));
		const buildAccountListPreview = vi.fn(() => "preview");
		const formatDashboardSettingState = vi.fn(() => "state");
		const formatMenuSortMode = vi.fn(() => "sort");
		const resolveMenuLayoutMode = vi.fn((settings?: { menuLayoutMode?: string }) =>
			settings?.menuLayoutMode === "expanded-rows"
				? "expanded-rows"
				: "compact-details",
		);
		const formatMenuLayoutMode = vi.fn(() => "layout");
		const applyDashboardDefaultsForKeys = vi.fn(() => initial);
		const promptDashboardDisplayPanel = vi.fn(async (_value, deps) => {
			expect(_value).toEqual(initial);
			expect(deps.cloneDashboardSettings).toBe(cloneDashboardSettings);
			expect(deps.buildAccountListPreview).toBe(buildAccountListPreview);
			expect(deps.formatDashboardSettingState).toBe(formatDashboardSettingState);
			expect(deps.formatMenuSortMode).toBe(formatMenuSortMode);
			expect(deps.formatMenuLayoutMode).toBe(formatMenuLayoutMode);
			expect(deps.applyDashboardDefaultsForKeys).toBe(applyDashboardDefaultsForKeys);
			expect(deps.resolveMenuLayoutMode(undefined)).toBe("compact-details");
			expect(
				deps.resolveMenuLayoutMode({ menuLayoutMode: "expanded-rows" } as never),
			).toBe("expanded-rows");
			return initial;
		});

		const result = await promptDashboardDisplaySettingsPanelEntry({
			initial,
			promptDashboardDisplayPanel,
			cloneDashboardSettings,
			buildAccountListPreview,
			formatDashboardSettingState,
			formatMenuSortMode,
			resolveMenuLayoutMode,
			formatMenuLayoutMode,
			applyDashboardDefaultsForKeys,
			DASHBOARD_DISPLAY_OPTIONS: [] as never,
			ACCOUNT_LIST_PANEL_KEYS: [] as never,
			UI_COPY: {} as never,
		});

		expect(promptDashboardDisplayPanel).toHaveBeenCalledOnce();
		expect(resolveMenuLayoutMode).toHaveBeenCalledWith(
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		);
		expect(result).toEqual(initial);
	});

	it("passes statusline panel dependencies through", async () => {
		const initial = { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
		const cloneDashboardSettings = vi.fn((value) => ({ ...value }));
		const buildAccountListPreview = vi.fn(() => "preview");
		const normalizeStatuslineFields = vi.fn((fields) => fields);
		const formatDashboardSettingState = vi.fn(() => "state");
		const applyDashboardDefaultsForKeys = vi.fn(() => initial);
		const promptStatuslineSettingsPanel = vi.fn(async (_value, deps) => {
			expect(_value).toEqual(initial);
			expect(deps.cloneDashboardSettings).toBe(cloneDashboardSettings);
			expect(deps.buildAccountListPreview).toBe(buildAccountListPreview);
			expect(deps.normalizeStatuslineFields).toBe(normalizeStatuslineFields);
			expect(deps.formatDashboardSettingState).toBe(formatDashboardSettingState);
			expect(deps.applyDashboardDefaultsForKeys).toBe(applyDashboardDefaultsForKeys);
			expect(deps.reorderField(["last-used", "limits"], "limits", -1)).toEqual([
				"limits",
				"last-used",
			]);
			return null;
		});

		const result = await promptStatuslineSettingsPanelEntry({
			initial,
			promptStatuslineSettingsPanel,
			cloneDashboardSettings,
			buildAccountListPreview,
			normalizeStatuslineFields,
			formatDashboardSettingState,
			applyDashboardDefaultsForKeys,
			STATUSLINE_FIELD_OPTIONS: [] as never,
			STATUSLINE_PANEL_KEYS: [] as never,
			UI_COPY: {} as never,
		});

		expect(promptStatuslineSettingsPanel).toHaveBeenCalledOnce();
		expect(result).toBeNull();
	});

	it("passes behavior panel dependencies through", async () => {
		const initial = { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
		const cloneDashboardSettings = vi.fn((value) => ({ ...value }));
		const applyDashboardDefaultsForKeys = vi.fn(() => initial);
		const formatMenuQuotaTtl = vi.fn(() => "ttl");
		const promptBehaviorSettingsPanel = vi.fn(async (_value, deps) => {
			expect(_value).toEqual(initial);
			expect(deps.cloneDashboardSettings).toBe(cloneDashboardSettings);
			expect(deps.applyDashboardDefaultsForKeys).toBe(applyDashboardDefaultsForKeys);
			expect(deps.formatMenuQuotaTtl).toBe(formatMenuQuotaTtl);
			expect(deps.formatDelayLabel(4000)).toBe("4s auto-return");
			return initial;
		});

		const result = await promptBehaviorSettingsPanelEntry({
			initial,
			promptBehaviorSettingsPanel,
			cloneDashboardSettings,
			applyDashboardDefaultsForKeys,
			formatMenuQuotaTtl,
			AUTO_RETURN_OPTIONS_MS: [] as never,
			MENU_QUOTA_TTL_OPTIONS_MS: [] as never,
			BEHAVIOR_PANEL_KEYS: [] as never,
			UI_COPY: {} as never,
		});

		expect(promptBehaviorSettingsPanel).toHaveBeenCalledOnce();
		expect(result).toEqual(initial);
	});

	it("passes theme panel dependencies through", async () => {
		const initial = { ...DEFAULT_DASHBOARD_DISPLAY_SETTINGS };
		const cloneDashboardSettings = vi.fn((value) => ({ ...value }));
		const applyDashboardDefaultsForKeys = vi.fn(() => initial);
		const applyUiThemeFromDashboardSettings = vi.fn();
		const promptThemeSettingsPanel = vi.fn(async (_value, deps) => {
			expect(_value).toEqual(initial);
			expect(deps.cloneDashboardSettings).toBe(cloneDashboardSettings);
			expect(deps.applyDashboardDefaultsForKeys).toBe(applyDashboardDefaultsForKeys);
			expect(deps.applyUiThemeFromDashboardSettings).toBe(
				applyUiThemeFromDashboardSettings,
			);
			return null;
		});

		const result = await promptThemeSettingsPanelEntry({
			initial,
			promptThemeSettingsPanel,
			cloneDashboardSettings,
			applyDashboardDefaultsForKeys,
			applyUiThemeFromDashboardSettings,
			THEME_PRESET_OPTIONS: [] as never,
			ACCENT_COLOR_OPTIONS: [] as never,
			THEME_PANEL_KEYS: [] as never,
			UI_COPY: {} as never,
		});

		expect(promptThemeSettingsPanel).toHaveBeenCalledOnce();
		expect(result).toBeNull();
	});
});
