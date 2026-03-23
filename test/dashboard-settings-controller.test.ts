import { describe, expect, it, vi } from "vitest";
import { configureDashboardSettingsController } from "../lib/codex-manager/dashboard-settings-controller.js";
import type { DashboardDisplaySettings } from "../lib/dashboard-settings.js";

function createSettings(): DashboardDisplaySettings {
	return {
		menuShowStatusBadge: true,
	};
}

describe("dashboard settings controller", () => {
	it("returns current settings in non-interactive mode", async () => {
		const writeLine = vi.fn();
		const result = await configureDashboardSettingsController(undefined, {
			loadDashboardDisplaySettings: async () => createSettings(),
			promptSettings: vi.fn(),
			settingsEqual: (left, right) =>
				left.menuShowStatusBadge === right.menuShowStatusBadge,
			persistSelection: vi.fn(),
			applyUiThemeFromDashboardSettings: vi.fn(),
			isInteractive: () => false,
			getDashboardSettingsPath: () => "/tmp/settings.json",
			writeLine,
		});

		expect(result.menuShowStatusBadge).toBe(true);
		expect(writeLine).toHaveBeenCalledWith(
			"Settings require interactive mode.",
		);
	});

	it("returns current settings when prompt is cancelled or unchanged", async () => {
		const baseDeps = {
			loadDashboardDisplaySettings: async () => createSettings(),
			settingsEqual: (
				left: DashboardDisplaySettings,
				right: DashboardDisplaySettings,
			) => left.menuShowStatusBadge === right.menuShowStatusBadge,
			persistSelection: vi.fn(
				async (selected: DashboardDisplaySettings) => selected,
			),
			applyUiThemeFromDashboardSettings: vi.fn(),
			isInteractive: () => true,
			getDashboardSettingsPath: () => "/tmp/settings.json",
			writeLine: vi.fn(),
		};

		const cancelled = await configureDashboardSettingsController(
			createSettings(),
			{
				...baseDeps,
				promptSettings: async () => null,
			},
		);
		expect(cancelled.menuShowStatusBadge).toBe(true);

		const unchanged = await configureDashboardSettingsController(
			createSettings(),
			{
				...baseDeps,
				promptSettings: async () => createSettings(),
			},
		);
		expect(unchanged.menuShowStatusBadge).toBe(true);
	});

	it("persists and reapplies theme for changed settings", async () => {
		const persistSelection = vi.fn(
			async (selected: DashboardDisplaySettings) => selected,
		);
		const applyUiThemeFromDashboardSettings = vi.fn();

		const result = await configureDashboardSettingsController(
			createSettings(),
			{
				loadDashboardDisplaySettings: async () => createSettings(),
				promptSettings: async () => ({ menuShowStatusBadge: false }),
				settingsEqual: (left, right) =>
					left.menuShowStatusBadge === right.menuShowStatusBadge,
				persistSelection,
				applyUiThemeFromDashboardSettings,
				isInteractive: () => true,
				getDashboardSettingsPath: () => "/tmp/settings.json",
				writeLine: vi.fn(),
			},
		);

		expect(persistSelection).toHaveBeenCalledWith({
			menuShowStatusBadge: false,
		});
		expect(applyUiThemeFromDashboardSettings).toHaveBeenCalledWith({
			menuShowStatusBadge: false,
		});
		expect(result.menuShowStatusBadge).toBe(false);
	});
});
