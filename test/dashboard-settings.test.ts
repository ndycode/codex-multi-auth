import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

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
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	it("loads defaults when settings file does not exist", async () => {
		const { loadDashboardDisplaySettings, DEFAULT_DASHBOARD_DISPLAY_SETTINGS } =
			await import("../lib/dashboard-settings.js");

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
		expect(content).toContain('"version": 1');
		expect(content).toContain('"dashboardDisplaySettings"');
		expect(content).not.toContain('"settings":');
	});

	it("preserves plugin config section when saving dashboard settings", async () => {
		const { saveUnifiedPluginConfig } = await import(
			"../lib/unified-settings.js"
		);
		const { saveDashboardDisplaySettings, getDashboardSettingsPath } =
			await import("../lib/dashboard-settings.js");

		await saveUnifiedPluginConfig({ codexMode: false });
		await saveDashboardDisplaySettings({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
		});

		const content = await fs.readFile(getDashboardSettingsPath(), "utf8");
		expect(content).toContain('"pluginConfig"');
		expect(content).toContain('"codexMode": false');
		expect(content).toContain('"dashboardDisplaySettings"');
	});

	it("preserves unrelated unified settings sections when saving normalized dashboard settings", async () => {
		const { getDashboardSettingsPath, saveDashboardDisplaySettings } =
			await import("../lib/dashboard-settings.js");

		await fs.writeFile(
			getDashboardSettingsPath(),
			JSON.stringify(
				{
					version: 1,
					pluginConfig: {
						codexMode: false,
						liveAccountSync: true,
					},
					dashboardDisplaySettings: {
						menuShowLastUsed: true,
						uiThemePreset: "green",
					},
					docsParityAnchor: {
						sections: ["Account List View", "Summary Line"],
					},
				},
				null,
				2,
			),
			"utf8",
		);

		await saveDashboardDisplaySettings({
			showPerAccountRows: false,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});

		const saved = JSON.parse(
			await fs.readFile(getDashboardSettingsPath(), "utf8"),
		) as {
			pluginConfig?: Record<string, unknown>;
			dashboardDisplaySettings?: Record<string, unknown>;
			docsParityAnchor?: Record<string, unknown>;
		};

		expect(saved.pluginConfig).toEqual({
			codexMode: false,
			liveAccountSync: true,
		});
		expect(saved.docsParityAnchor).toEqual({
			sections: ["Account List View", "Summary Line"],
		});
		expect(saved.dashboardDisplaySettings).toEqual(
			expect.objectContaining({
				showPerAccountRows: false,
				menuShowLastUsed: false,
				uiThemePreset: "blue",
				menuShowQuotaSummary: true,
			}),
		);
	});

	it("migrates legacy dashboard-settings.json into unified settings", async () => {
		const { loadDashboardDisplaySettings, getDashboardSettingsPath } =
			await import("../lib/dashboard-settings.js");

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

		const unifiedContent = await fs.readFile(
			getDashboardSettingsPath(),
			"utf8",
		);
		expect(unifiedContent).toContain('"dashboardDisplaySettings"');
		expect(unifiedContent).toContain('"showPerAccountRows": false');
	});

	it("falls back to defaults when legacy file read fails", async () => {
		const { loadDashboardDisplaySettings, DEFAULT_DASHBOARD_DISPLAY_SETTINGS } =
			await import("../lib/dashboard-settings.js");

		const legacyPath = join(tempDir, "dashboard-settings.json");
		await fs.writeFile(
			legacyPath,
			JSON.stringify({ settings: { showPerAccountRows: false } }),
			"utf8",
		);

		const error = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});
		const readSpy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(error);

		const loaded = await loadDashboardDisplaySettings();
		expect(loaded).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
		readSpy.mockRestore();
	});

	it("falls back to defaults when legacy file contains malformed JSON", async () => {
		const { loadDashboardDisplaySettings, DEFAULT_DASHBOARD_DISPLAY_SETTINGS } =
			await import("../lib/dashboard-settings.js");
		const legacyPath = join(tempDir, "dashboard-settings.json");
		await fs.writeFile(legacyPath, "{ malformed", "utf8");

		const loaded = await loadDashboardDisplaySettings();
		expect(loaded).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
	});

	it("retries transient EBUSY reads for legacy settings and succeeds", async () => {
		const { loadDashboardDisplaySettings } = await import(
			"../lib/dashboard-settings.js"
		);
		const legacyPath = join(tempDir, "dashboard-settings.json");
		const payload = JSON.stringify({
			settings: {
				showPerAccountRows: false,
				menuShowQuotaSummary: false,
			},
		});
		await fs.writeFile(legacyPath, payload, "utf8");

		const originalReadFile = fs.readFile.bind(fs);
		const readSpy = vi.spyOn(fs, "readFile");
		const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
		readSpy
			.mockRejectedValueOnce(busy)
			.mockImplementation(async (...args) => originalReadFile(...args));

		const loaded = await loadDashboardDisplaySettings();
		expect(loaded.showPerAccountRows).toBe(false);
		expect(loaded.menuShowQuotaSummary).toBe(false);
		expect(readSpy).toHaveBeenCalledTimes(2);
		readSpy.mockRestore();
	});

	it("falls back to defaults when retryable legacy reads keep failing", async () => {
		const { loadDashboardDisplaySettings, DEFAULT_DASHBOARD_DISPLAY_SETTINGS } =
			await import("../lib/dashboard-settings.js");
		const legacyPath = join(tempDir, "dashboard-settings.json");
		await fs.writeFile(
			legacyPath,
			JSON.stringify({ settings: { showPerAccountRows: false } }),
			"utf8",
		);

		const readSpy = vi.spyOn(fs, "readFile");
		const locked = Object.assign(new Error("locked"), { code: "EPERM" });
		readSpy.mockRejectedValue(locked);

		try {
			const loaded = await loadDashboardDisplaySettings();
			expect(loaded).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
			expect(readSpy).toHaveBeenCalledTimes(4);
		} finally {
			readSpy.mockRestore();
		}
	});
	it("normalizes invalid primitive values to defaults", async () => {
		const {
			normalizeDashboardDisplaySettings,
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		} = await import("../lib/dashboard-settings.js");

		const normalized = normalizeDashboardDisplaySettings({
			showPerAccountRows: "nope",
			showQuotaDetails: "nope",
			showForecastReasons: "nope",
			showRecommendations: "nope",
			showLiveProbeNotes: "nope",
			actionAutoReturnMs: Number.NaN,
			actionPauseOnKey: "nope",
			menuAutoFetchLimits: "nope",
			menuSortEnabled: "nope",
			menuSortMode: "invalid",
			menuSortPinCurrent: "nope",
			menuSortQuickSwitchVisibleRow: "nope",
			uiThemePreset: "invalid",
			uiAccentColor: "invalid",
			menuShowStatusBadge: "nope",
			menuShowCurrentBadge: "nope",
			menuShowLastUsed: "nope",
			menuShowQuotaSummary: "nope",
			menuShowQuotaCooldown: "nope",
			menuShowFetchStatus: "nope",
			menuLayoutMode: "invalid",
			menuQuotaTtlMs: Number.POSITIVE_INFINITY,
			menuFocusStyle: "invalid",
			menuHighlightCurrentRow: "nope",
			menuStatuslineFields: "invalid",
		});

		expect(normalized).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
		expect(normalizeDashboardDisplaySettings(null)).toEqual(
			DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
		);
	});

	it("normalizes enum values, clamped numbers, and deduplicated statusline fields", async () => {
		const { normalizeDashboardDisplaySettings } = await import(
			"../lib/dashboard-settings.js"
		);

		const normalized = normalizeDashboardDisplaySettings({
			showPerAccountRows: false,
			showQuotaDetails: true,
			showForecastReasons: false,
			showRecommendations: true,
			showLiveProbeNotes: false,
			actionAutoReturnMs: 12_345,
			actionPauseOnKey: false,
			menuAutoFetchLimits: false,
			menuSortEnabled: true,
			menuSortMode: "manual",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: false,
			uiThemePreset: "blue",
			uiAccentColor: "yellow",
			menuShowStatusBadge: false,
			menuShowCurrentBadge: false,
			menuShowLastUsed: false,
			menuShowQuotaSummary: false,
			menuShowQuotaCooldown: false,
			menuShowFetchStatus: false,
			menuShowDetailsForUnselectedRows: true,
			menuLayoutMode: "expanded-rows",
			menuQuotaTtlMs: 42_000,
			menuFocusStyle: "row-invert",
			menuHighlightCurrentRow: false,
			menuStatuslineFields: [
				"status",
				"status",
				"limits",
				"unknown",
				100,
				"last-used",
			],
		});

		expect(normalized.actionAutoReturnMs).toBe(10_000);
		expect(normalized.menuQuotaTtlMs).toBe(60_000);
		expect(normalized.menuSortMode).toBe("manual");
		expect(normalized.uiThemePreset).toBe("blue");
		expect(normalized.uiAccentColor).toBe("yellow");
		expect(normalized.menuLayoutMode).toBe("expanded-rows");
		expect(normalized.menuShowDetailsForUnselectedRows).toBe(true);
		expect(normalized.menuStatuslineFields).toEqual([
			"status",
			"limits",
			"last-used",
		]);
	});

	it("falls back to defaults when legacy file parses to non-record JSON", async () => {
		const { loadDashboardDisplaySettings, DEFAULT_DASHBOARD_DISPLAY_SETTINGS } =
			await import("../lib/dashboard-settings.js");
		const legacyPath = join(tempDir, "dashboard-settings.json");
		await fs.writeFile(
			legacyPath,
			JSON.stringify(["not", "an", "object"]),
			"utf8",
		);

		const loaded = await loadDashboardDisplaySettings();
		expect(loaded).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
	});
	it("logs stringified legacy read failures thrown as non-Error values", async () => {
		vi.resetModules();
		vi.doUnmock("../lib/dashboard-settings.js");
		const warnMock = vi.fn();
		vi.doMock("../lib/logger.js", () => ({
			logWarn: warnMock,
		}));

		try {
			const {
				loadDashboardDisplaySettings,
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS,
			} = await import("../lib/dashboard-settings.js");

			const legacyPath = join(tempDir, "dashboard-settings.json");
			await fs.writeFile(
				legacyPath,
				JSON.stringify({ settings: { showPerAccountRows: false } }),
				"utf8",
			);

			const readSpy = vi.spyOn(fs, "readFile");
			readSpy.mockRejectedValueOnce("legacy-read-string-failure");

			const loaded = await loadDashboardDisplaySettings();
			expect(loaded).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
			expect(
				warnMock.mock.calls.some((args) =>
					String(args[0]).includes("legacy-read-string-failure"),
				),
			).toBe(true);

			readSpy.mockRestore();
		} finally {
			vi.doUnmock("../lib/logger.js");
		}
	});
});
