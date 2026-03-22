import { describe, expect, it, vi } from "vitest";
import { configureDashboardSettingsEntry } from "../lib/codex-manager/dashboard-settings-entry.js";

describe("dashboard settings entry", () => {
	it("delegates to dashboard settings controller with provided deps", async () => {
		const configureDashboardSettingsController = vi.fn(async () => ({
			menuShowStatusBadge: false,
		}));
		const result = await configureDashboardSettingsEntry(undefined, {
			configureDashboardSettingsController,
			loadDashboardDisplaySettings: vi.fn(async () => ({
				menuShowStatusBadge: true,
			})),
			promptSettings: vi.fn(),
			settingsEqual: vi.fn(() => false),
			persistSelection: vi.fn(),
			applyUiThemeFromDashboardSettings: vi.fn(),
			isInteractive: vi.fn(() => true),
			getDashboardSettingsPath: vi.fn(() => "/tmp/settings.json"),
			writeLine: vi.fn(),
		});

		expect(configureDashboardSettingsController).toHaveBeenCalled();
		expect(result).toEqual({ menuShowStatusBadge: false });
	});
});
