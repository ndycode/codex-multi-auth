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
    const { saveUnifiedPluginConfig } =
      await import("../lib/unified-settings.js");
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
    const { loadDashboardDisplaySettings } =
      await import("../lib/dashboard-settings.js");
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
    expect(readSpy).toHaveBeenCalled();
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

    const loaded = await loadDashboardDisplaySettings();
    expect(loaded).toEqual(DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
    expect(readSpy).toHaveBeenCalledTimes(4);
    readSpy.mockRestore();
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
    const { normalizeDashboardDisplaySettings } =
      await import("../lib/dashboard-settings.js");

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
  it("uses hard fallback literals when optional defaults are undefined", async () => {
    const dashboardModule = await import("../lib/dashboard-settings.js");
    const defaults = dashboardModule.DEFAULT_DASHBOARD_DISPLAY_SETTINGS;
    const original = {
      actionAutoReturnMs: defaults.actionAutoReturnMs,
      actionPauseOnKey: defaults.actionPauseOnKey,
      menuAutoFetchLimits: defaults.menuAutoFetchLimits,
      menuSortEnabled: defaults.menuSortEnabled,
      menuSortMode: defaults.menuSortMode,
      menuSortPinCurrent: defaults.menuSortPinCurrent,
      menuSortQuickSwitchVisibleRow: defaults.menuSortQuickSwitchVisibleRow,
      menuShowStatusBadge: defaults.menuShowStatusBadge,
      menuShowCurrentBadge: defaults.menuShowCurrentBadge,
      menuShowLastUsed: defaults.menuShowLastUsed,
      menuShowQuotaSummary: defaults.menuShowQuotaSummary,
      menuShowQuotaCooldown: defaults.menuShowQuotaCooldown,
      menuShowFetchStatus: defaults.menuShowFetchStatus,
      menuQuotaTtlMs: defaults.menuQuotaTtlMs,
      menuHighlightCurrentRow: defaults.menuHighlightCurrentRow,
      menuStatuslineFields: defaults.menuStatuslineFields,
    };

    defaults.actionAutoReturnMs = undefined;
    defaults.actionPauseOnKey = undefined;
    defaults.menuAutoFetchLimits = undefined;
    defaults.menuSortEnabled = undefined;
    defaults.menuSortMode = undefined;
    defaults.menuSortPinCurrent = undefined;
    defaults.menuSortQuickSwitchVisibleRow = undefined;
    defaults.menuShowStatusBadge = undefined;
    defaults.menuShowCurrentBadge = undefined;
    defaults.menuShowLastUsed = undefined;
    defaults.menuShowQuotaSummary = undefined;
    defaults.menuShowQuotaCooldown = undefined;
    defaults.menuShowFetchStatus = undefined;
    defaults.menuQuotaTtlMs = undefined;
    defaults.menuHighlightCurrentRow = undefined;
    defaults.menuStatuslineFields = undefined;

    try {
      const normalized = dashboardModule.normalizeDashboardDisplaySettings({
        actionAutoReturnMs: "bad",
        actionPauseOnKey: "bad",
        menuAutoFetchLimits: "bad",
        menuSortEnabled: "bad",
        menuSortMode: "bad",
        menuSortPinCurrent: "bad",
        menuSortQuickSwitchVisibleRow: "bad",
        menuShowStatusBadge: "bad",
        menuShowCurrentBadge: "bad",
        menuShowLastUsed: "bad",
        menuShowQuotaSummary: "bad",
        menuShowQuotaCooldown: "bad",
        menuShowFetchStatus: "bad",
        menuQuotaTtlMs: "bad",
        menuHighlightCurrentRow: "bad",
        uiAccentColor: "blue",
        menuStatuslineFields: "not-array",
      });

      expect(normalized.actionAutoReturnMs).toBe(2_000);
      expect(normalized.actionPauseOnKey).toBe(true);
      expect(normalized.menuAutoFetchLimits).toBe(true);
      expect(normalized.menuSortEnabled).toBe(false);
      expect(normalized.menuSortMode).toBe("ready-first");
      expect(normalized.menuSortPinCurrent).toBe(true);
      expect(normalized.menuSortQuickSwitchVisibleRow).toBe(true);
      expect(normalized.menuShowStatusBadge).toBe(true);
      expect(normalized.menuShowCurrentBadge).toBe(true);
      expect(normalized.menuShowLastUsed).toBe(true);
      expect(normalized.menuShowQuotaSummary).toBe(true);
      expect(normalized.menuShowQuotaCooldown).toBe(true);
      expect(normalized.menuShowFetchStatus).toBe(true);
      expect(normalized.menuQuotaTtlMs).toBe(300_000);
      expect(normalized.menuHighlightCurrentRow).toBe(true);
      expect(normalized.menuStatuslineFields).toEqual([]);
      expect(normalized.uiAccentColor).toBe("blue");
    } finally {
      defaults.actionAutoReturnMs = original.actionAutoReturnMs;
      defaults.actionPauseOnKey = original.actionPauseOnKey;
      defaults.menuAutoFetchLimits = original.menuAutoFetchLimits;
      defaults.menuSortEnabled = original.menuSortEnabled;
      defaults.menuSortMode = original.menuSortMode;
      defaults.menuSortPinCurrent = original.menuSortPinCurrent;
      defaults.menuSortQuickSwitchVisibleRow =
        original.menuSortQuickSwitchVisibleRow;
      defaults.menuShowStatusBadge = original.menuShowStatusBadge;
      defaults.menuShowCurrentBadge = original.menuShowCurrentBadge;
      defaults.menuShowLastUsed = original.menuShowLastUsed;
      defaults.menuShowQuotaSummary = original.menuShowQuotaSummary;
      defaults.menuShowQuotaCooldown = original.menuShowQuotaCooldown;
      defaults.menuShowFetchStatus = original.menuShowFetchStatus;
      defaults.menuQuotaTtlMs = original.menuQuotaTtlMs;
      defaults.menuHighlightCurrentRow = original.menuHighlightCurrentRow;
      defaults.menuStatuslineFields = original.menuStatuslineFields;
    }
  });

  it("logs stringified legacy read failures thrown as non-Error values", async () => {
    vi.resetModules();
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
