import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardDisplaySettings } from "../lib/dashboard-settings.js";
import type { PluginConfig } from "../lib/types.js";

type SettingsHubTestApi = {
	clampBackendNumber: (settingKey: string, value: number) => number;
	formatMenuLayoutMode: (mode: "compact-details" | "expanded-rows") => string;
	cloneDashboardSettings: (settings: DashboardDisplaySettings) => DashboardDisplaySettings;
	withQueuedRetry: <T>(pathKey: string, task: () => Promise<T>) => Promise<T>;
	persistDashboardSettingsSelection: (
		selected: DashboardDisplaySettings,
		keys: ReadonlyArray<string>,
		scope: string,
	) => Promise<DashboardDisplaySettings>;
	persistBackendConfigSelection: (selected: PluginConfig, scope: string) => Promise<PluginConfig>;
};

let tempRoot = "";
const originalCodeHome = process.env.CODEX_HOME;
const originalCodeMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;
const originalConfigPath = process.env.CODEX_MULTI_AUTH_CONFIG_PATH;

async function loadSettingsHubTestApi(): Promise<SettingsHubTestApi> {
	const module = await import("../lib/codex-manager/settings-hub.js");
	return module.__testOnly as SettingsHubTestApi;
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "codex-settings-hub-test-"));
	process.env.CODEX_HOME = tempRoot;
	process.env.CODEX_MULTI_AUTH_DIR = tempRoot;
	process.env.CODEX_MULTI_AUTH_CONFIG_PATH = join(tempRoot, "plugin-config.json");
	vi.resetModules();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
	if (tempRoot.length > 0) {
		rmSync(tempRoot, { recursive: true, force: true });
	}
	if (originalCodeHome === undefined) {
		delete process.env.CODEX_HOME;
	} else {
		process.env.CODEX_HOME = originalCodeHome;
	}
	if (originalCodeMultiAuthDir === undefined) {
		delete process.env.CODEX_MULTI_AUTH_DIR;
	} else {
		process.env.CODEX_MULTI_AUTH_DIR = originalCodeMultiAuthDir;
	}
	if (originalConfigPath === undefined) {
		delete process.env.CODEX_MULTI_AUTH_CONFIG_PATH;
	} else {
		process.env.CODEX_MULTI_AUTH_CONFIG_PATH = originalConfigPath;
	}
});

describe("settings-hub utility coverage", () => {
	it("clamps backend numeric settings by option bounds", async () => {
		const api = await loadSettingsHubTestApi();
		expect(api.clampBackendNumber("fetchTimeoutMs", 250)).toBe(1_000);
		expect(api.clampBackendNumber("fetchTimeoutMs", 999_999)).toBe(600_000);
		expect(() => api.clampBackendNumber("unknown-setting", 5)).toThrow(
			"Unknown backend numeric setting key",
		);
	});

	it("formats layout mode labels", async () => {
		const api = await loadSettingsHubTestApi();
		expect(api.formatMenuLayoutMode("expanded-rows")).toBe("Expanded Rows");
		expect(api.formatMenuLayoutMode("compact-details")).toBe("Compact + Details Pane");
	});

	it("clones dashboard settings and protects array references", async () => {
		const api = await loadSettingsHubTestApi();
		const dashboard = await import("../lib/dashboard-settings.js");
		const original = await dashboard.loadDashboardDisplaySettings();
		const clone = api.cloneDashboardSettings(original);
		clone.menuStatuslineFields?.push("status");
		expect(original.menuStatuslineFields?.length).toBeGreaterThan(0);
		expect(clone.menuStatuslineFields).not.toBe(original.menuStatuslineFields);
	});

	it("retries queued writes for retryable filesystem errors", async () => {
		const api = await loadSettingsHubTestApi();
		let attempts = 0;
		const result = await api.withQueuedRetry("settings-path", async () => {
			attempts += 1;
			if (attempts < 3) {
				const error = new Error("busy") as NodeJS.ErrnoException;
				error.code = attempts === 1 ? "EBUSY" : "EPERM";
				throw error;
			}
			return "ok";
		});
		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("persists selected dashboard keys through retry-aware save", async () => {
		const api = await loadSettingsHubTestApi();
		const dashboard = await import("../lib/dashboard-settings.js");
		const base = await dashboard.loadDashboardDisplaySettings();
		const selected = api.cloneDashboardSettings(base);
		selected.menuShowStatusBadge = false;

		const saved = await api.persistDashboardSettingsSelection(
			selected,
			["menuShowStatusBadge"],
			"account-list",
		);
		expect(saved.menuShowStatusBadge).toBe(false);

		const reloaded = await dashboard.loadDashboardDisplaySettings();
		expect(reloaded.menuShowStatusBadge).toBe(false);
	});

	it("persists backend config selection", async () => {
		const api = await loadSettingsHubTestApi();
		const configModule = await import("../lib/config.js");
		const selected = configModule.getDefaultPluginConfig();
		selected.fetchTimeoutMs = 12_345;
		selected.streamStallTimeoutMs = 23_456;

		const saved = await api.persistBackendConfigSelection(selected, "backend");
		expect(saved.fetchTimeoutMs).toBe(12_345);
		expect(saved.streamStallTimeoutMs).toBe(23_456);

		const reloaded = configModule.loadPluginConfig();
		expect(reloaded.fetchTimeoutMs).toBe(12_345);
		expect(reloaded.streamStallTimeoutMs).toBe(23_456);
	});
});
