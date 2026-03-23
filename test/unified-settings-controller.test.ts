import { describe, expect, it, vi } from "vitest";
import { configureUnifiedSettingsController } from "../lib/codex-manager/unified-settings-controller.js";
import type { DashboardDisplaySettings } from "../lib/dashboard-settings.js";
import type { PluginConfig } from "../lib/types.js";

function createSettings(): DashboardDisplaySettings {
	return { menuShowStatusBadge: true };
}

function createConfig(): PluginConfig {
	return { fetchTimeoutMs: 1000 };
}

describe("unified settings controller", () => {
	it("returns current settings when hub exits immediately", async () => {
		const result = await configureUnifiedSettingsController(undefined, {
			cloneDashboardSettings: (settings) => ({ ...settings }),
			cloneBackendPluginConfig: (config) => ({ ...config }),
			loadDashboardDisplaySettings: async () => createSettings(),
			loadPluginConfig: () => createConfig(),
			applyUiThemeFromDashboardSettings: vi.fn(),
			promptSettingsHub: async () => null,
			configureDashboardDisplaySettings: async (current) => current,
			configureStatuslineSettings: async (current) => current,
			promptBehaviorSettings: async () => null,
			promptThemeSettings: async () => null,
			dashboardSettingsEqual: () => true,
			persistDashboardSettingsSelection: vi.fn(),
			promptExperimentalSettings: async () => null,
			backendSettingsEqual: () => true,
			persistBackendConfigSelection: vi.fn(),
			configureBackendSettings: async (config) => config,
			BEHAVIOR_PANEL_KEYS: [],
			THEME_PANEL_KEYS: [],
		});

		expect(result.menuShowStatusBadge).toBe(true);
	});

	it("routes account-list and backend actions through delegates", async () => {
		const configureDashboardDisplaySettings = vi.fn(async () => ({
			menuShowStatusBadge: false,
		}));
		const configureBackendSettings = vi.fn(async (config: PluginConfig) => ({
			...config,
			fetchTimeoutMs: 2000,
		}));
		const promptSettingsHub = vi
			.fn()
			.mockResolvedValueOnce({ type: "account-list" })
			.mockResolvedValueOnce({ type: "backend" })
			.mockResolvedValueOnce({ type: "back" });

		const result = await configureUnifiedSettingsController(createSettings(), {
			cloneDashboardSettings: (settings) => ({ ...settings }),
			cloneBackendPluginConfig: (config) => ({ ...config }),
			loadDashboardDisplaySettings: async () => createSettings(),
			loadPluginConfig: () => createConfig(),
			applyUiThemeFromDashboardSettings: vi.fn(),
			promptSettingsHub,
			configureDashboardDisplaySettings,
			configureStatuslineSettings: async (current) => current,
			promptBehaviorSettings: async () => null,
			promptThemeSettings: async () => null,
			dashboardSettingsEqual: () => true,
			persistDashboardSettingsSelection: vi.fn(),
			promptExperimentalSettings: async () => null,
			backendSettingsEqual: () => true,
			persistBackendConfigSelection: vi.fn(),
			configureBackendSettings,
			BEHAVIOR_PANEL_KEYS: [],
			THEME_PANEL_KEYS: [],
		});

		expect(configureDashboardDisplaySettings).toHaveBeenCalled();
		expect(configureBackendSettings).toHaveBeenCalledWith({
			fetchTimeoutMs: 1000,
		});
		expect(result.menuShowStatusBadge).toBe(false);
	});

	it("persists behavior, theme, and experimental changes when selections differ", async () => {
		const persistDashboardSettingsSelection = vi.fn(
			async (selected: DashboardDisplaySettings) => selected,
		);
		const persistBackendConfigSelection = vi.fn(
			async (config: PluginConfig) => config,
		);
		const applyUiThemeFromDashboardSettings = vi.fn();
		const promptSettingsHub = vi
			.fn()
			.mockResolvedValueOnce({ type: "behavior" })
			.mockResolvedValueOnce({ type: "theme" })
			.mockResolvedValueOnce({ type: "experimental" })
			.mockResolvedValueOnce({ type: "back" });

		const result = await configureUnifiedSettingsController(createSettings(), {
			cloneDashboardSettings: (settings) => ({ ...settings }),
			cloneBackendPluginConfig: (config) => ({ ...config }),
			loadDashboardDisplaySettings: async () => createSettings(),
			loadPluginConfig: () => createConfig(),
			applyUiThemeFromDashboardSettings,
			promptSettingsHub,
			configureDashboardDisplaySettings: async (current) => current,
			configureStatuslineSettings: async (current) => current,
			promptBehaviorSettings: async () => ({ menuShowStatusBadge: false }),
			promptThemeSettings: async () => ({ menuShowStatusBadge: true }),
			dashboardSettingsEqual: (left, right) =>
				left.menuShowStatusBadge === right.menuShowStatusBadge,
			persistDashboardSettingsSelection,
			promptExperimentalSettings: async () => ({ fetchTimeoutMs: 2000 }),
			backendSettingsEqual: (left, right) =>
				left.fetchTimeoutMs === right.fetchTimeoutMs,
			persistBackendConfigSelection,
			configureBackendSettings: async (config) => config,
			BEHAVIOR_PANEL_KEYS: ["menuShowStatusBadge"],
			THEME_PANEL_KEYS: ["menuShowStatusBadge"],
		});

		expect(persistDashboardSettingsSelection).toHaveBeenCalledTimes(2);
		expect(persistBackendConfigSelection).toHaveBeenCalledWith(
			{ fetchTimeoutMs: 2000 },
			"experimental",
		);
		expect(applyUiThemeFromDashboardSettings).toHaveBeenCalled();
		expect(result.menuShowStatusBadge).toBe(true);
	});
});
