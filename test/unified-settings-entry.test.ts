import { describe, expect, it, vi } from "vitest";
import { configureUnifiedSettingsEntry } from "../lib/codex-manager/unified-settings-entry.js";

function createControllerDeps() {
	return {
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
	};
}

describe("unified settings entry", () => {
	it("delegates to the unified settings controller with provided deps", async () => {
		const configureUnifiedSettingsController = vi.fn(async () => ({
			menuShowStatusBadge: true,
		}));
		const controllerDeps = createControllerDeps();

		const result = await configureUnifiedSettingsEntry(undefined, {
			configureUnifiedSettingsController,
			...controllerDeps,
		});

		expect(configureUnifiedSettingsController).toHaveBeenCalledWith(
			undefined,
			controllerDeps,
		);
		expect(result).toEqual({ menuShowStatusBadge: true });
	});

	it("propagates rejection from the controller", async () => {
		const expectedError = new Error("controller failure");
		const configureUnifiedSettingsController = vi.fn(async () => {
			throw expectedError;
		});

		await expect(
			configureUnifiedSettingsEntry(undefined, {
				configureUnifiedSettingsController,
				...createControllerDeps(),
			}),
		).rejects.toThrow(expectedError);
	});
});
