import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("dashboard settings", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-multi-auth-dashboard-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
		vi.resetModules();
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("loads defaults when settings file does not exist", async () => {
		const { loadDashboardDisplaySettings, DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import(
			"../lib/dashboard-settings.js"
		);

		const settings = await loadDashboardDisplaySettings();
		expect(settings).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
	});

	it("saves and reloads settings", async () => {
		const {
			saveDashboardDisplaySettings,
			loadDashboardDisplaySettings,
			getDashboardSettingsPath,
		} = await import("../lib/dashboard-settings.js");

		await saveDashboardDisplaySettings({
			showPerAccountRows: false,
			showQuotaDetails: true,
			showForecastReasons: false,
			showRecommendations: true,
			showLiveProbeNotes: false,
			actionAutoReturnMs: 1_000,
			actionPauseOnKey: false,
			uiThemePreset: "blue",
			uiAccentColor: "cyan",
		});

		const reloaded = await loadDashboardDisplaySettings();
		expect(reloaded).toEqual({
			showPerAccountRows: false,
			showQuotaDetails: true,
			showForecastReasons: false,
			showRecommendations: true,
			showLiveProbeNotes: false,
			actionAutoReturnMs: 1_000,
			actionPauseOnKey: false,
			menuAutoFetchLimits: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: false,
			menuSortQuickSwitchVisibleRow: true,
			uiThemePreset: "blue",
			uiAccentColor: "cyan",
			menuShowStatusBadge: true,
			menuShowCurrentBadge: true,
			menuShowLastUsed: true,
			menuShowQuotaSummary: true,
			menuShowQuotaCooldown: true,
			menuShowFetchStatus: true,
			menuShowDetailsForUnselectedRows: false,
			menuLayoutMode: "compact-details",
			menuQuotaTtlMs: 300_000,
			menuFocusStyle: "row-invert",
			menuHighlightCurrentRow: true,
			menuStatuslineFields: ["last-used", "limits", "status"],
		});

		const content = await fs.readFile(getDashboardSettingsPath(), "utf8");
		expect(content).toContain("\"version\": 1");
		expect(content).toContain("\"dashboardDisplaySettings\"");
		expect(content).not.toContain("\"settings\":");
	});

	it("preserves plugin config section when saving dashboard settings", async () => {
		const { saveUnifiedPluginConfig } = await import("../lib/unified-settings.js");
		const {
			saveDashboardDisplaySettings,
			getDashboardSettingsPath,
		} = await import("../lib/dashboard-settings.js");

		await saveUnifiedPluginConfig({ codexMode: false });
		await saveDashboardDisplaySettings({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
		});

		const content = await fs.readFile(getDashboardSettingsPath(), "utf8");
		expect(content).toContain("\"pluginConfig\"");
		expect(content).toContain("\"codexMode\": false");
		expect(content).toContain("\"dashboardDisplaySettings\"");
	});

	it("migrates legacy dashboard-settings.json into unified settings", async () => {
		const {
			loadDashboardDisplaySettings,
			getDashboardSettingsPath,
		} = await import("../lib/dashboard-settings.js");

		const legacyPath = join(tempDir, "dashboard-settings.json");
		await fs.writeFile(
			legacyPath,
			JSON.stringify({
				settings: {
					showPerAccountRows: false,
					showQuotaDetails: false,
					menuShowQuotaSummary: false,
					menuLayoutMode: "expanded-rows",
				},
			}),
			"utf-8",
		);

		const migrated = await loadDashboardDisplaySettings();
		expect(migrated.showPerAccountRows).toBe(false);
		expect(migrated.showQuotaDetails).toBe(false);
		expect(migrated.menuShowQuotaSummary).toBe(false);
		expect(migrated.menuLayoutMode).toBe("expanded-rows");

		const unifiedContent = await fs.readFile(getDashboardSettingsPath(), "utf8");
		expect(unifiedContent).toContain("\"dashboardDisplaySettings\"");
		expect(unifiedContent).toContain("\"showPerAccountRows\": false");
	});

	it("falls back to defaults when legacy file read fails", async () => {
		const { loadDashboardDisplaySettings, DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import(
			"../lib/dashboard-settings.js"
		);

		const legacyPath = join(tempDir, "dashboard-settings.json");
		await fs.writeFile(legacyPath, JSON.stringify({ settings: { showPerAccountRows: false } }), "utf8");

		const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(error);

		const loaded = await loadDashboardDisplaySettings();
		expect(loaded).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
		readSpy.mockRestore();
	});
});
