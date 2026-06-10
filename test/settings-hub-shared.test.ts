import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	loadDashboardDisplaySettingsMock,
	saveDashboardDisplaySettingsMock,
	savePluginConfigMock,
} = vi.hoisted(() => ({
	loadDashboardDisplaySettingsMock: vi.fn(),
	saveDashboardDisplaySettingsMock: vi.fn(),
	savePluginConfigMock: vi.fn(),
}));

vi.mock("../lib/dashboard-settings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/dashboard-settings.js")>()),
	loadDashboardDisplaySettings: loadDashboardDisplaySettingsMock,
	saveDashboardDisplaySettings: saveDashboardDisplaySettingsMock,
	getDashboardSettingsPath: () => "/tmp/settings-hub-shared-test/settings.json",
}));

vi.mock("../lib/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/config.js")>()),
	savePluginConfig: savePluginConfigMock,
}));

import {
	applyDashboardDefaultsForKeys,
	clampBackendNumber,
	cloneDashboardSettings,
	copyDashboardSettingValue,
	mergeDashboardSettingsForKeys,
	persistBackendConfigSelectionForTests,
	persistDashboardSettingsSelectionForTests,
} from "../lib/codex-manager/settings-hub/shared.js";
import { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } from "../lib/dashboard-settings.js";
import { backendSettingsEqual } from "../lib/codex-manager/backend-settings-helpers.js";
import type { DashboardDisplaySettings } from "../lib/dashboard-settings.js";
import type { PluginConfig } from "../lib/types.js";
import type { BackendNumberSettingOption } from "../lib/codex-manager/backend-settings-schema.js";

function busyError(): NodeJS.ErrnoException {
	const error = new Error("locked") as NodeJS.ErrnoException;
	error.code = "EBUSY";
	return error;
}

describe("settings hub shared helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		loadDashboardDisplaySettingsMock.mockResolvedValue({});
		saveDashboardDisplaySettingsMock.mockResolvedValue(undefined);
		savePluginConfigMock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("copyDashboardSettingValue", () => {
		it("copies scalars and clones array values", () => {
			const source: DashboardDisplaySettings = {
				menuShowLastUsed: false,
				menuStatuslineFields: ["status", "limits"],
			};
			const target: DashboardDisplaySettings = {};
			copyDashboardSettingValue(target, source, "menuShowLastUsed");
			copyDashboardSettingValue(target, source, "menuStatuslineFields");
			expect(target.menuShowLastUsed).toBe(false);
			expect(target.menuStatuslineFields).toStrictEqual(["status", "limits"]);
			// Arrays must be copied, not shared: mutating the target later must
			// never write through to the source settings object.
			expect(target.menuStatuslineFields).not.toBe(source.menuStatuslineFields);
		});
	});

	describe("applyDashboardDefaultsForKeys", () => {
		it("resets only the listed keys and leaves the draft untouched", () => {
			const draft: DashboardDisplaySettings = {
				menuShowLastUsed: false,
				menuShowQuotaSummary: false,
			};
			const next = applyDashboardDefaultsForKeys(draft, ["menuShowLastUsed"]);
			expect(next.menuShowLastUsed).toBe(
				DEFAULT_DASHBOARD_DISPLAY_SETTINGS.menuShowLastUsed,
			);
			expect(next.menuShowQuotaSummary).toBe(false);
			expect(draft.menuShowLastUsed).toBe(false);
		});
	});

	describe("mergeDashboardSettingsForKeys", () => {
		it("takes only the listed keys from the selection", () => {
			const base: DashboardDisplaySettings = {
				menuShowLastUsed: false,
				menuShowQuotaSummary: false,
			};
			const selected: DashboardDisplaySettings = {
				menuShowLastUsed: true,
				menuShowQuotaSummary: true,
			};
			const merged = mergeDashboardSettingsForKeys(base, selected, [
				"menuShowLastUsed",
			]);
			expect(merged.menuShowLastUsed).toBe(true);
			expect(merged.menuShowQuotaSummary).toBe(false);
			expect(base.menuShowLastUsed).toBe(false);
		});
	});

	describe("persistDashboardSettingsSelection", () => {
		it("re-reads the latest settings and merges only the panel's keys onto them", async () => {
			// A concurrent edit to an unrelated key landed on disk after the panel
			// loaded: the write must preserve it instead of clobbering with the
			// panel's stale view.
			loadDashboardDisplaySettingsMock.mockResolvedValue({
				menuHighlightCurrentRow: false,
			});
			const result = await persistDashboardSettingsSelectionForTests(
				{ menuShowLastUsed: false, menuHighlightCurrentRow: true },
				["menuShowLastUsed"],
				"dashboard",
			);
			expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledTimes(1);
			const saved = saveDashboardDisplaySettingsMock.mock
				.calls[0]?.[0] as DashboardDisplaySettings;
			expect(saved.menuShowLastUsed).toBe(false);
			expect(saved.menuHighlightCurrentRow).toBe(false);
			expect(result.menuHighlightCurrentRow).toBe(false);
		});

		it("retries transient write failures through the queued-retry policy", async () => {
			saveDashboardDisplaySettingsMock
				.mockRejectedValueOnce(busyError())
				.mockResolvedValueOnce(undefined);
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await persistDashboardSettingsSelectionForTests(
				{ menuShowLastUsed: false },
				["menuShowLastUsed"],
				"dashboard",
			);
			expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledTimes(2);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(result.menuShowLastUsed).toBe(false);
		});

		it("gives up immediately on a non-retryable error, warning with the fallback", async () => {
			saveDashboardDisplaySettingsMock.mockRejectedValue(
				new Error("disk gone"),
			);
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const selected: DashboardDisplaySettings = { menuShowLastUsed: false };
			const result = await persistDashboardSettingsSelectionForTests(
				selected,
				["menuShowLastUsed"],
				"dashboard",
			);
			expect(warnSpy).toHaveBeenCalledWith(
				"Settings save failed (dashboard) after retries: disk gone",
			);
			// The fallback is the clone-normalized selection (the clone fills
			// documented defaults), never the caller's object itself.
			expect(result).toStrictEqual(cloneDashboardSettings(selected));
			expect(result.menuShowLastUsed).toBe(false);
			expect(result).not.toBe(selected);
			// Non-retryable: the write must fail on the first attempt, no retries.
			expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledTimes(1);
		});

		it("exhausts all four attempts on persistent EBUSY before falling back", async () => {
			saveDashboardDisplaySettingsMock.mockRejectedValue(busyError());
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const result = await persistDashboardSettingsSelectionForTests(
				{ menuShowLastUsed: false },
				["menuShowLastUsed"],
				"dashboard",
			);
			expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledTimes(4);
			expect(warnSpy).toHaveBeenCalledWith(
				"Settings save failed (dashboard) after retries: locked",
			);
			expect(result.menuShowLastUsed).toBe(false);
		});
	});

	describe("persistBackendConfigSelection", () => {
		it("saves the backend patch and returns a defensive clone of the selection", async () => {
			const selected = {
				unsupportedCodexFallbackChain: { "gpt-5.3-codex": ["gpt-5.2"] },
			} as PluginConfig;
			const result = await persistBackendConfigSelectionForTests(
				selected,
				"backend",
			);
			expect(savePluginConfigMock).toHaveBeenCalledTimes(1);
			expect(backendSettingsEqual(result, selected)).toBe(true);
			expect(result).not.toBe(selected);
			expect(result.unsupportedCodexFallbackChain).not.toBe(
				selected.unsupportedCodexFallbackChain,
			);
		});

		it("warns and falls back to the selection clone when the save fails", async () => {
			savePluginConfigMock.mockRejectedValue(new Error("config locked"));
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const selected = {} as PluginConfig;
			const result = await persistBackendConfigSelectionForTests(
				selected,
				"backend",
			);
			expect(warnSpy).toHaveBeenCalledWith(
				"Settings save failed (backend) after retries: config locked",
			);
			expect(backendSettingsEqual(result, selected)).toBe(true);
		});

		it("exhausts all four attempts on persistent EBUSY for the backend path too", async () => {
			savePluginConfigMock.mockRejectedValue(busyError());
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const selected = {} as PluginConfig;
			const result = await persistBackendConfigSelectionForTests(
				selected,
				"backend",
			);
			expect(savePluginConfigMock).toHaveBeenCalledTimes(4);
			expect(warnSpy).toHaveBeenCalledWith(
				"Settings save failed (backend) after retries: locked",
			);
			expect(backendSettingsEqual(result, selected)).toBe(true);
		});
	});

	describe("clampBackendNumber", () => {
		const option = {
			key: "fetchTimeoutMs",
			label: "fetch timeout",
			min: 10,
			max: 100,
			step: 5,
			unit: "duration",
		} as unknown as BackendNumberSettingOption;

		it.each([
			[5, 10],
			[10, 10],
			[55.4, 55],
			[55.5, 56],
			[100, 100],
			[250, 100],
		])("clamps and rounds %d to %d", (value, expected) => {
			expect(clampBackendNumber(option, value)).toBe(expected);
		});
	});
});
