import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("unified settings", () => {
	let tempDir: string;
	let originalDir: string | undefined;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-multi-auth-unified-"));
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

	it("merges plugin and dashboard sections into one file", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
			loadUnifiedPluginConfigSync,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 90000 });
		await saveUnifiedDashboardSettings({ menuShowLastUsed: false, uiThemePreset: "blue" });

		const pluginConfig = loadUnifiedPluginConfigSync();
		expect(pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 90000,
		});

		const dashboardSettings = await loadUnifiedDashboardSettings();
		expect(dashboardSettings).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});

		const fileContent = await fs.readFile(getUnifiedSettingsPath(), "utf8");
		expect(fileContent).toContain("\"version\": 1");
		expect(fileContent).toContain("\"pluginConfig\"");
		expect(fileContent).toContain("\"dashboardDisplaySettings\"");
	});

	it("returns null sections for invalid JSON", async () => {
		const { getUnifiedSettingsPath, loadUnifiedPluginConfigSync, loadUnifiedDashboardSettings } = await import(
			"../lib/unified-settings.js"
		);

		await fs.mkdir(tempDir, { recursive: true });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		expect(loadUnifiedPluginConfigSync()).toBeNull();
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("serializes concurrent plugin config writes to avoid race corruption", async () => {
		const {
			saveUnifiedPluginConfig,
			loadUnifiedPluginConfigSync,
			getUnifiedSettingsPath,
		} = await import("../lib/unified-settings.js");

		await Promise.all([
			saveUnifiedPluginConfig({ codexMode: false, requestTimeoutMs: 30_000 }),
			saveUnifiedPluginConfig({ codexMode: true, requestTimeoutMs: 90_000, retries: 2 }),
		]);

		const pluginConfig = loadUnifiedPluginConfigSync();
		expect(pluginConfig).toEqual({
			codexMode: true,
			requestTimeoutMs: 90_000,
			retries: 2,
		});

		const raw = await fs.readFile(getUnifiedSettingsPath(), "utf8");
		expect(() => JSON.parse(raw)).not.toThrow();
	});
});
