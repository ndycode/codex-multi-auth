import { describe, expect, it, vi } from "vitest";
import { configureUnifiedSettingsEntry } from "../lib/codex-manager/unified-settings-entry.js";

describe("unified settings entry", () => {
	it("delegates to the unified settings controller with provided deps", async () => {
		const configureUnifiedSettingsController = vi.fn(async () => ({
			menuShowStatusBadge: true,
		}));

		const result = await configureUnifiedSettingsEntry(undefined, {
			configureUnifiedSettingsController,
			cloneDashboardSettings: vi.fn((settings) => settings),
			cloneBackendPluginConfig: vi.fn((config) => config),
			loadDashboardDisplaySettings: vi.fn(async () => ({
				menuShowStatusBadge: false,
			})),
			loadPluginConfig: vi.fn(() => ({ fetchTimeoutMs: 1000 })),
			applyUiThemeFromDashboardSettings: vi.fn(),
			promptSettingsHub: vi.fn(),
			configureDashboardDisplaySettings: vi.fn(),
			configureStatuslineSettings: vi.fn(),
			promptBehaviorSettings: vi.fn(),
			promptThemeSettings: vi.fn(),
			dashboardSettingsEqual: vi.fn(),
			persistDashboardSettingsSelection: vi.fn(),
			promptExperimentalSettings: vi.fn(),
			backendSettingsEqual: vi.fn(),
			persistBackendConfigSelection: vi.fn(),
			configureBackendSettings: vi.fn(),
			BEHAVIOR_PANEL_KEYS: [],
			THEME_PANEL_KEYS: [],
		});

		expect(configureUnifiedSettingsController).toHaveBeenCalled();
		expect(result).toEqual({ menuShowStatusBadge: true });
	});
});
