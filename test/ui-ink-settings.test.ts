import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadDashboardDisplaySettingsMock = vi.fn();
const saveDashboardDisplaySettingsMock = vi.fn();
const getDashboardSettingsPathMock = vi.fn(() => "/mock/dashboard-settings.json");
const loadPluginConfigMock = vi.fn();
const savePluginConfigMock = vi.fn();
const getUnifiedSettingsPathMock = vi.fn(() => "/mock/unified-settings.json");

vi.mock("../lib/dashboard-settings.js", async () => {
	const actual = await vi.importActual("../lib/dashboard-settings.js");
	return {
		...(actual as Record<string, unknown>),
		loadDashboardDisplaySettings: loadDashboardDisplaySettingsMock,
		saveDashboardDisplaySettings: saveDashboardDisplaySettingsMock,
		getDashboardSettingsPath: getDashboardSettingsPathMock,
	};
});

vi.mock("../lib/config.js", async () => {
	const actual = await vi.importActual("../lib/config.js");
	return {
		...(actual as Record<string, unknown>),
		loadPluginConfig: loadPluginConfigMock,
		savePluginConfig: savePluginConfigMock,
	};
});

vi.mock("../lib/unified-settings.js", () => ({
	getUnifiedSettingsPath: getUnifiedSettingsPathMock,
}));

function createMockInput(): NodeJS.ReadStream {
	const stream = new PassThrough() as PassThrough & NodeJS.ReadStream & {
		setRawMode: (value: boolean) => void;
		ref: () => void;
		unref: () => void;
	};
	Object.defineProperty(stream, "isTTY", {
		value: true,
		configurable: true,
	});
	stream.setRawMode = () => undefined;
	stream.ref = () => undefined;
	stream.unref = () => undefined;
	return stream;
}

function createMockOutput(): NodeJS.WriteStream {
	const stream = new PassThrough() as PassThrough & NodeJS.WriteStream;
	Object.defineProperty(stream, "isTTY", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(stream, "columns", {
		value: 120,
		configurable: true,
	});
	Object.defineProperty(stream, "rows", {
		value: 40,
		configurable: true,
	});
	return stream;
}

async function sendKeys(stream: PassThrough, keys: string[], delayMs = 35): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
	for (const key of keys) {
		stream.push(key);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
}

describe("ink settings flows", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.NODE_ENV = "test";
		const dashboardSettingsModule = await import("../lib/dashboard-settings.js");
		const configModule = await import("../lib/config.js");
		const settingsPersistenceModule = await import("../lib/codex-manager/settings-persistence.js");
		settingsPersistenceModule.resetSettingsWriteQueuesForTesting();
		loadDashboardDisplaySettingsMock.mockResolvedValue(dashboardSettingsModule.DEFAULT_DASHBOARD_DISPLAY_SETTINGS);
		saveDashboardDisplaySettingsMock.mockResolvedValue(undefined);
		loadPluginConfigMock.mockReturnValue(configModule.getDefaultPluginConfig());
		savePluginConfigMock.mockResolvedValue(undefined);
		getDashboardSettingsPathMock.mockReturnValue("/mock/dashboard-settings.json");
		getUnifiedSettingsPathMock.mockReturnValue("/mock/unified-settings.json");
	});

	afterEach(async () => {
		const runtime = await import("../lib/ui/runtime.js");
		runtime.resetUiRuntimeOptions();
	});

	it("saves account-list changes through Ink hotkeys", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import("../lib/dashboard-settings.js");
		const { promptInkAccountListSettings } = await import("../lib/ui-ink/index.js");

		const resultPromise = promptInkAccountListSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS, {
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		const typing = sendKeys(input as PassThrough, ["1", "m", "l", "s"]);
		await expect(resultPromise).resolves.toEqual(
			expect.objectContaining({
				menuShowStatusBadge: false,
				menuSortMode: "manual",
				menuLayoutMode: "expanded-rows",
				menuShowDetailsForUnselectedRows: true,
			}),
		);
		await typing;
	});

	it("reorders summary fields with bracket hotkeys", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import("../lib/dashboard-settings.js");
		const { promptInkStatuslineSettings } = await import("../lib/ui-ink/index.js");

		const resultPromise = promptInkStatuslineSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS, {
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		const typing = sendKeys(input as PassThrough, ["]", "s"]);
		await expect(resultPromise).resolves.toEqual(
			expect.objectContaining({
				menuStatuslineFields: ["limits", "last-used", "status"],
			}),
		);
		await typing;
	});

	it("updates behavior settings with Ink hotkeys", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import("../lib/dashboard-settings.js");
		const { promptInkBehaviorSettings } = await import("../lib/ui-ink/index.js");

		const resultPromise = promptInkBehaviorSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS, {
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		const typing = sendKeys(input as PassThrough, ["p", "l", "f", "t", "1", "s"]);
		await expect(resultPromise).resolves.toEqual(
			expect.objectContaining({
				actionAutoReturnMs: 1_000,
				actionPauseOnKey: false,
				menuAutoFetchLimits: false,
				menuShowFetchStatus: false,
				menuQuotaTtlMs: 600_000,
			}),
		);
		await typing;
	});

	it("restores the baseline theme when Q cancels Ink theme edits", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const runtime = await import("../lib/ui/runtime.js");
		const { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import("../lib/dashboard-settings.js");
		const { promptInkThemeSettings } = await import("../lib/ui-ink/index.js");

		runtime.resetUiRuntimeOptions();
		const baseline = runtime.getUiRuntimeOptions();
		const baselineSnapshot = {
			v2Enabled: baseline.v2Enabled,
			colorProfile: baseline.colorProfile,
			glyphMode: baseline.glyphMode,
			palette: baseline.palette,
			accent: baseline.accent,
		};

		const resultPromise = promptInkThemeSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS, {
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		const typing = sendKeys(input as PassThrough, ["2", "q"]);
		await expect(resultPromise).resolves.toBeNull();
		await typing;

		const restored = runtime.getUiRuntimeOptions();
		expect({
			v2Enabled: restored.v2Enabled,
			colorProfile: restored.colorProfile,
			glyphMode: restored.glyphMode,
			palette: restored.palette,
			accent: restored.accent,
		}).toEqual(baselineSnapshot);
	});

	it("routes the full settings hub through Ink and does not save on cancel", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import("../lib/dashboard-settings.js");
		const { configureInkUnifiedSettings } = await import("../lib/ui-ink/index.js");

		const resultPromise = configureInkUnifiedSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS, {
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		const typing = sendKeys(input as PassThrough, ["4", "2", "q", "q"]);
		await expect(resultPromise).resolves.toBe(true);
		await typing;

		expect(saveDashboardDisplaySettingsMock).not.toHaveBeenCalled();
		expect(savePluginConfigMock).not.toHaveBeenCalled();
	});

	it("saves backend category toggle and numeric edits with + - and ] hotkeys", async () => {
		const input = createMockInput();
		const output = createMockOutput();
		const stderr = createMockOutput();
		const { DEFAULT_DASHBOARD_DISPLAY_SETTINGS } = await import("../lib/dashboard-settings.js");
		const configModule = await import("../lib/config.js");
		const baseline = configModule.getDefaultPluginConfig();
		loadPluginConfigMock.mockReturnValue(baseline);
		const { configureInkUnifiedSettings } = await import("../lib/ui-ink/index.js");

		const resultPromise = configureInkUnifiedSettings(DEFAULT_DASHBOARD_DISPLAY_SETTINGS, {
			stdin: input,
			stdout: output,
			stderr,
			patchConsole: false,
			exitOnCtrlC: false,
		});

		const typing = sendKeys(input as PassThrough, [
			"5",
			"1",
			"1",
			"\u001b[B",
			"\u001b[B",
			"\u001b[B",
			"\u001b[B",
			"\u001b[B",
			"+",
			"-",
			"]",
			"q",
			"s",
			"q",
		]);
		await expect(resultPromise).resolves.toBe(true);
		await typing;

		expect(savePluginConfigMock).toHaveBeenCalledTimes(1);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				liveAccountSync: !(baseline.liveAccountSync ?? true),
				liveAccountSyncDebounceMs: (baseline.liveAccountSyncDebounceMs ?? 250) + 50,
			}),
		);
	});
});
