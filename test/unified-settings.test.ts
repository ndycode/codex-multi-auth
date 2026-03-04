import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function expectSecureFileMode(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const stats = await fs.stat(path);
	expect(stats.mode & 0o777).toBe(0o600);
}

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
		await expectSecureFileMode(getUnifiedSettingsPath());
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

	it("returns null when dashboard settings file is missing", async () => {
		const { loadUnifiedDashboardSettings } = await import("../lib/unified-settings.js");
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("supports sync plugin-config save and load", async () => {
		const {
			saveUnifiedPluginConfigSync,
			loadUnifiedPluginConfigSync,
			getUnifiedSettingsPath,
		} = await import("../lib/unified-settings.js");

		saveUnifiedPluginConfigSync({ codexMode: true, retries: 4 });

		expect(loadUnifiedPluginConfigSync()).toEqual({ codexMode: true, retries: 4 });
		const fileContent = await fs.readFile(getUnifiedSettingsPath(), "utf8");
		expect(fileContent).toContain("\"version\": 1");
		await expectSecureFileMode(getUnifiedSettingsPath());
	});

	it("returns null for missing pluginConfig section", async () => {
		const { getUnifiedSettingsPath, loadUnifiedPluginConfigSync } = await import(
			"../lib/unified-settings.js"
		);
		await fs.writeFile(getUnifiedSettingsPath(), JSON.stringify({ version: 1 }), "utf8");
		expect(loadUnifiedPluginConfigSync()).toBeNull();
	});

	it("returns null sections when settings root is not an object", async () => {
		const { getUnifiedSettingsPath, loadUnifiedPluginConfigSync, loadUnifiedDashboardSettings } = await import(
			"../lib/unified-settings.js"
		);
		await fs.writeFile(getUnifiedSettingsPath(), JSON.stringify([]), "utf8");
		expect(loadUnifiedPluginConfigSync()).toBeNull();
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("retries async rename on retryable fs errors", async () => {
		const { saveUnifiedPluginConfig, loadUnifiedPluginConfigSync } = await import(
			"../lib/unified-settings.js"
		);
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(async () => {
			const error = new Error("busy") as NodeJS.ErrnoException;
			error.code = "EBUSY";
			throw error;
		});
		try {
			await saveUnifiedPluginConfig({ codexMode: true, retries: 1 });
			expect(loadUnifiedPluginConfigSync()).toEqual({ codexMode: true, retries: 1 });
		} finally {
			renameSpy.mockRestore();
		}
	});

	it("cleans async temp file when rename fails with non-retryable code", async () => {
		const { saveUnifiedPluginConfig, getUnifiedSettingsPath } = await import(
			"../lib/unified-settings.js"
		);
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(async () => {
			const error = new Error("denied") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});
		try {
			await expect(saveUnifiedPluginConfig({ codexMode: true })).rejects.toThrow();
		} finally {
			renameSpy.mockRestore();
		}

		const dir = tempDir;
		const entries = await fs.readdir(dir);
		const leakedTemps = entries.filter((entry) => entry.includes("settings.json.") && entry.endsWith(".tmp"));
		expect(leakedTemps).toEqual([]);
		expect(await fs.readFile(getUnifiedSettingsPath(), "utf8").catch(() => "")).toBe("");
	});

	it("retries async rename on windows-style EPERM lock", async () => {
		const { saveUnifiedPluginConfig, loadUnifiedPluginConfigSync } = await import(
			"../lib/unified-settings.js"
		);
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(async () => {
			const error = new Error("perm") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		try {
			await saveUnifiedPluginConfig({ codexMode: true, retries: 2 });
			expect(loadUnifiedPluginConfigSync()).toEqual({ codexMode: true, retries: 2 });
		} finally {
			renameSpy.mockRestore();
		}
	});

	it("cleans async temp file when rename repeatedly fails with EPERM", async () => {
		const { saveUnifiedPluginConfig, getUnifiedSettingsPath } = await import(
			"../lib/unified-settings.js"
		);
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementation(async () => {
			const error = new Error("perm locked") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		try {
			await expect(saveUnifiedPluginConfig({ codexMode: true })).rejects.toThrow();
		} finally {
			renameSpy.mockRestore();
		}

		const entries = await fs.readdir(tempDir);
		const leakedTemps = entries.filter((entry) => entry.includes("settings.json.") && entry.endsWith(".tmp"));
		expect(leakedTemps).toEqual([]);
		expect(await fs.readFile(getUnifiedSettingsPath(), "utf8").catch(() => "")).toBe("");
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

	it("keeps both sections after concurrent plugin/dashboard writes", async () => {
		const {
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
			loadUnifiedPluginConfigSync,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await Promise.all([
			saveUnifiedPluginConfig({ codexMode: true, retries: 3 }),
			saveUnifiedDashboardSettings({ menuShowLastUsed: false, uiThemePreset: "green" }),
		]);

		expect(loadUnifiedPluginConfigSync()).toEqual({ codexMode: true, retries: 3 });
		expect(await loadUnifiedDashboardSettings()).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "green",
		});
	});

	it("refuses overwriting settings sections when a read fails", async () => {
		const {
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
			getUnifiedSettingsPath,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 70_000 });
		await saveUnifiedDashboardSettings({ menuShowLastUsed: false, uiThemePreset: "blue" });

		const readSpy = vi.spyOn(fs, "readFile");
		readSpy.mockImplementationOnce(async () => {
			const error = new Error("file locked") as NodeJS.ErrnoException;
			error.code = "EBUSY";
			throw error;
		});

		await expect(
			saveUnifiedDashboardSettings({ menuShowLastUsed: true, uiThemePreset: "yellow" }),
		).rejects.toThrow();
		readSpy.mockRestore();

		const raw = await fs.readFile(getUnifiedSettingsPath(), "utf8");
		const parsed = JSON.parse(raw) as {
			pluginConfig?: Record<string, unknown>;
			dashboardDisplaySettings?: Record<string, unknown>;
		};
		expect(parsed.pluginConfig).toEqual({ codexMode: true, fetchTimeoutMs: 70_000 });
		expect(parsed.dashboardDisplaySettings).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});
	});
});
