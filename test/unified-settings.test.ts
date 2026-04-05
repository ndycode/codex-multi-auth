import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

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
		await removeWithRetry(tempDir, { recursive: true, force: true });
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
		await saveUnifiedDashboardSettings({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});

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
		expect(fileContent).toContain('"version": 1');
		expect(fileContent).toContain('"pluginConfig"');
		expect(fileContent).toContain('"dashboardDisplaySettings"');
	});

	it("returns null sections for invalid JSON", async () => {
		const {
			getUnifiedSettingsPath,
			loadUnifiedPluginConfigSync,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await fs.mkdir(tempDir, { recursive: true });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		expect(loadUnifiedPluginConfigSync()).toBeNull();
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("returns null sections when both primary and backup settings files are invalid", async () => {
		const {
			getUnifiedSettingsPath,
			loadUnifiedPluginConfigSync,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");
		await fs.writeFile(`${getUnifiedSettingsPath()}.bak`, "{ invalid backup", "utf8");

		expect(loadUnifiedPluginConfigSync()).toBeNull();
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("does not load backup settings when the primary file is missing", async () => {
		const {
			getUnifiedSettingsPath,
			loadUnifiedPluginConfigSync,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await fs.writeFile(
			`${getUnifiedSettingsPath()}.bak`,
			JSON.stringify({
				version: 1,
				pluginConfig: { codexMode: true },
				dashboardDisplaySettings: { uiThemePreset: "green" },
			}),
			"utf8",
		);

		expect(loadUnifiedPluginConfigSync()).toBeNull();
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("recovers plugin config from backup when primary settings file is invalid", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfig,
			loadUnifiedPluginConfigSync,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedPluginConfig({ codexMode: false, fetchTimeoutMs: 90_000 });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
	});

	it("recovers dashboard settings from backup when primary settings file is invalid", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedDashboardSettings,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedDashboardSettings({
			menuShowLastUsed: true,
			uiThemePreset: "green",
		});
		await saveUnifiedDashboardSettings({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		expect(await loadUnifiedDashboardSettings()).toEqual({
			menuShowLastUsed: true,
			uiThemePreset: "green",
		});
	});

	it("rethrows sync backup read errors when the primary settings file is invalid", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfig,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedPluginConfig({ codexMode: false, fetchTimeoutMs: 90_000 });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		const backupPath = `${getUnifiedSettingsPath()}.bak`;
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
					const [filePath] = args;
					if (String(filePath) === backupPath) {
						const error = new Error("busy") as NodeJS.ErrnoException;
						error.code = "EBUSY";
						throw error;
					}
					return actual.readFileSync(...args);
				},
			};
		});

		try {
			const { saveUnifiedPluginConfigSync } = await import("../lib/unified-settings.js");
			expect(() =>
				saveUnifiedPluginConfigSync({
					codexMode: true,
					fetchTimeoutMs: 120_000,
				}),
			).toThrow(/busy/);
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
		}
	});

	it("rethrows async backup read errors when the primary settings file is invalid", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfig,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedPluginConfig({ codexMode: false, fetchTimeoutMs: 90_000 });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		const backupPath = `${getUnifiedSettingsPath()}.bak`;
		const originalReadFile = fs.readFile;
		const readSpy = vi.spyOn(fs, "readFile");
		readSpy.mockImplementation((...args: Parameters<typeof fs.readFile>) => {
			const [filePath] = args;
			if (String(filePath) === backupPath) {
				const error = new Error("denied") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return originalReadFile(...args);
		});

		try {
			await expect(
				saveUnifiedPluginConfig({
					codexMode: true,
					fetchTimeoutMs: 120_000,
				}),
			).rejects.toMatchObject({ code: "EPERM" });
		} finally {
			readSpy.mockRestore();
		}
	});

	it("preserves the last good backup when a write fails after a backup-derived read", async () => {
		const {
			getUnifiedSettingsPath,
			loadUnifiedPluginConfigSync,
			saveUnifiedPluginConfig,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedPluginConfig({ codexMode: false, fetchTimeoutMs: 90_000 });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});

		const backupPath = `${getUnifiedSettingsPath()}.bak`;
		const copySpy = vi.spyOn(fs, "copyFile");
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementation(async () => {
			const error = new Error("busy") as NodeJS.ErrnoException;
			error.code = "EBUSY";
			throw error;
		});

		try {
			await expect(
				saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 120_000 }),
			).rejects.toThrow();
		} finally {
			copySpy.mockRestore();
			renameSpy.mockRestore();
		}

		expect(copySpy).not.toHaveBeenCalledWith(
			getUnifiedSettingsPath(),
			backupPath,
		);
		const backupRecord = JSON.parse(
			await fs.readFile(backupPath, "utf8"),
		) as { pluginConfig?: Record<string, unknown> };
		expect(backupRecord.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
	});

	it("keeps the last good backup when a concurrent writer updates the primary after a backup-derived read", async () => {
		const {
			getUnifiedSettingsPath,
			loadUnifiedPluginConfigSync,
			saveUnifiedPluginConfig,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedPluginConfig({ codexMode: false, fetchTimeoutMs: 90_000 });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});

		const concurrentPrimary = {
			version: 1,
			pluginConfig: {
				codexMode: false,
				fetchTimeoutMs: 150_000,
				retries: 4,
			},
		};
		const copySpy = vi.spyOn(fs, "copyFile");
		const renameSpy = vi.spyOn(fs, "rename");
		let injectedConcurrentWrite = false;
		renameSpy.mockImplementationOnce(async () => {
			injectedConcurrentWrite = true;
			await fs.writeFile(
				getUnifiedSettingsPath(),
				`${JSON.stringify(concurrentPrimary, null, 2)}\n`,
				"utf8",
			);
			const error = new Error("denied") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});

		try {
			await expect(
				saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 120_000 }),
			).rejects.toThrow();
		} finally {
			copySpy.mockRestore();
			renameSpy.mockRestore();
		}

		expect(injectedConcurrentWrite).toBe(true);
		expect(copySpy).not.toHaveBeenCalledWith(
			getUnifiedSettingsPath(),
			`${getUnifiedSettingsPath()}.bak`,
		);
		const backupRecord = JSON.parse(
			await fs.readFile(`${getUnifiedSettingsPath()}.bak`, "utf8"),
		) as { pluginConfig?: Record<string, unknown> };
		expect(backupRecord.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
		const primaryRecord = JSON.parse(
			await fs.readFile(getUnifiedSettingsPath(), "utf8"),
		) as { pluginConfig?: Record<string, unknown> };
		expect(primaryRecord.pluginConfig).toEqual(concurrentPrimary.pluginConfig);
	});

	it("resumes snapshotting after a backup-derived write succeeds", async () => {
		const {
			getUnifiedSettingsPath,
			loadUnifiedPluginConfigSync,
			saveUnifiedPluginConfig,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedPluginConfig({ codexMode: false, fetchTimeoutMs: 90_000 });
		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 120_000 });
		let backupRecord = JSON.parse(
			await fs.readFile(`${getUnifiedSettingsPath()}.bak`, "utf8"),
		) as { pluginConfig?: Record<string, unknown> };
		expect(backupRecord.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});

		await saveUnifiedPluginConfig({ codexMode: false, fetchTimeoutMs: 150_000 });
		backupRecord = JSON.parse(
			await fs.readFile(`${getUnifiedSettingsPath()}.bak`, "utf8"),
		) as { pluginConfig?: Record<string, unknown> };
		expect(backupRecord.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 120_000,
		});
	});

	it("returns null when dashboard settings file is missing", async () => {
		const { loadUnifiedDashboardSettings } = await import(
			"../lib/unified-settings.js"
		);
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("supports sync plugin-config save and load", async () => {
		const {
			saveUnifiedPluginConfigSync,
			loadUnifiedPluginConfigSync,
			getUnifiedSettingsPath,
		} = await import("../lib/unified-settings.js");

		saveUnifiedPluginConfigSync({ codexMode: true, retries: 4 });

		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			retries: 4,
		});
		const fileContent = await fs.readFile(getUnifiedSettingsPath(), "utf8");
		expect(fileContent).toContain('"version": 1');
	});

	it("overwrites invalid primary settings when saving without a usable backup", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedDashboardSettings({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});

		const parsed = JSON.parse(
			await fs.readFile(getUnifiedSettingsPath(), "utf8"),
		) as {
			pluginConfig?: Record<string, unknown>;
			dashboardDisplaySettings?: Record<string, unknown>;
		};
		expect(parsed.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
		expect(parsed.dashboardDisplaySettings).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});
	});

	it("overwrites invalid primary settings with sync plugin saves when no usable backup exists", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfigSync,
			loadUnifiedPluginConfigSync,
		} = await import("../lib/unified-settings.js");

		await fs.writeFile(getUnifiedSettingsPath(), "{ invalid json", "utf8");

		saveUnifiedPluginConfigSync({ codexMode: true, fetchTimeoutMs: 45_000 });

		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
		const parsed = JSON.parse(
			await fs.readFile(getUnifiedSettingsPath(), "utf8"),
		) as {
			pluginConfig?: Record<string, unknown>;
		};
		expect(parsed.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
	});

	it("returns null for missing pluginConfig section", async () => {
		const { getUnifiedSettingsPath, loadUnifiedPluginConfigSync } =
			await import("../lib/unified-settings.js");
		await fs.writeFile(
			getUnifiedSettingsPath(),
			JSON.stringify({ version: 1 }),
			"utf8",
		);
		expect(loadUnifiedPluginConfigSync()).toBeNull();
	});

	it("returns null sections when settings root is not an object", async () => {
		const {
			getUnifiedSettingsPath,
			loadUnifiedPluginConfigSync,
			loadUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");
		await fs.writeFile(getUnifiedSettingsPath(), JSON.stringify([]), "utf8");
		expect(loadUnifiedPluginConfigSync()).toBeNull();
		expect(await loadUnifiedDashboardSettings()).toBeNull();
	});

	it("retries async rename on retryable fs errors", async () => {
		const { saveUnifiedPluginConfig, loadUnifiedPluginConfigSync } =
			await import("../lib/unified-settings.js");
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(async () => {
			const error = new Error("busy") as NodeJS.ErrnoException;
			error.code = "EBUSY";
			throw error;
		});
		try {
			await saveUnifiedPluginConfig({ codexMode: true, retries: 1 });
			expect(renameSpy).toHaveBeenCalledTimes(2);
			expect(loadUnifiedPluginConfigSync()).toEqual({
				codexMode: true,
				retries: 1,
			});
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
			await expect(
				saveUnifiedPluginConfig({ codexMode: true }),
			).rejects.toThrow();
		} finally {
			renameSpy.mockRestore();
		}

		const dir = tempDir;
		const entries = await fs.readdir(dir);
		const leakedTemps = entries.filter(
			(entry) => entry.includes("settings.json.") && entry.endsWith(".tmp"),
		);
		expect(leakedTemps).toEqual([]);
		expect(
			await fs.readFile(getUnifiedSettingsPath(), "utf8").catch(() => ""),
		).toBe("");
	});

	it("retries async rename on windows-style EPERM lock", async () => {
		const { saveUnifiedPluginConfig, loadUnifiedPluginConfigSync } =
			await import("../lib/unified-settings.js");
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementationOnce(async () => {
			const error = new Error("perm") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		try {
			await saveUnifiedPluginConfig({ codexMode: true, retries: 2 });
			expect(renameSpy).toHaveBeenCalledTimes(2);
			expect(loadUnifiedPluginConfigSync()).toEqual({
				codexMode: true,
				retries: 2,
			});
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
			await expect(
				saveUnifiedPluginConfig({ codexMode: true }),
			).rejects.toThrow();
		} finally {
			renameSpy.mockRestore();
		}

		const entries = await fs.readdir(tempDir);
		const leakedTemps = entries.filter(
			(entry) => entry.includes("settings.json.") && entry.endsWith(".tmp"),
		);
		expect(leakedTemps).toEqual([]);
		expect(
			await fs.readFile(getUnifiedSettingsPath(), "utf8").catch(() => ""),
		).toBe("");
	});

	it("serializes concurrent plugin config writes to avoid race corruption", async () => {
		const {
			saveUnifiedPluginConfig,
			loadUnifiedPluginConfigSync,
			getUnifiedSettingsPath,
		} = await import("../lib/unified-settings.js");

		// Requires FIFO write queue semantics: the second enqueued write must commit last.
		await Promise.all([
			saveUnifiedPluginConfig({ codexMode: false, requestTimeoutMs: 30_000 }),
			saveUnifiedPluginConfig({
				codexMode: true,
				requestTimeoutMs: 90_000,
				retries: 2,
			}),
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
			saveUnifiedDashboardSettings({
				menuShowLastUsed: false,
				uiThemePreset: "green",
			}),
		]);

		expect(loadUnifiedPluginConfigSync()).toEqual({
			codexMode: true,
			retries: 3,
		});
		expect(await loadUnifiedDashboardSettings()).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "green",
		});
	});

	it("preserves unrelated top-level sections during partial section writes", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await fs.writeFile(
			getUnifiedSettingsPath(),
			JSON.stringify(
				{
					version: 1,
					pluginConfig: { codexMode: false, retries: 9 },
					dashboardDisplaySettings: {
						menuShowLastUsed: true,
						uiThemePreset: "green",
					},
					experimentalDraft: {
						enabled: false,
						panels: ["future"],
					},
				},
				null,
				2,
			),
			"utf8",
		);

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 });
		await saveUnifiedDashboardSettings({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});

		const parsed = JSON.parse(
			await fs.readFile(getUnifiedSettingsPath(), "utf8"),
		) as {
			pluginConfig?: Record<string, unknown>;
			dashboardDisplaySettings?: Record<string, unknown>;
			experimentalDraft?: Record<string, unknown>;
		};

		expect(parsed.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
		expect(parsed.dashboardDisplaySettings).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});
		expect(parsed.experimentalDraft).toEqual({
			enabled: false,
			panels: ["future"],
		});
	});

	it("preserves unrelated top-level sections during concurrent partial section writes", async () => {
		const {
			getUnifiedSettingsPath,
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
		} = await import("../lib/unified-settings.js");

		await fs.writeFile(
			getUnifiedSettingsPath(),
			JSON.stringify(
				{
					version: 1,
					experimentalDraft: {
						enabled: false,
						panels: ["future"],
					},
				},
				null,
				2,
			),
			"utf8",
		);

		await Promise.all([
			saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 45_000 }),
			saveUnifiedDashboardSettings({
				menuShowLastUsed: false,
				uiThemePreset: "blue",
			}),
		]);

		const parsed = JSON.parse(
			await fs.readFile(getUnifiedSettingsPath(), "utf8"),
		) as {
			pluginConfig?: Record<string, unknown>;
			dashboardDisplaySettings?: Record<string, unknown>;
			experimentalDraft?: Record<string, unknown>;
		};

		expect(parsed.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 45_000,
		});
		expect(parsed.dashboardDisplaySettings).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});
		expect(parsed.experimentalDraft).toEqual({
			enabled: false,
			panels: ["future"],
		});
	});

	it("falls back to backup when the primary settings file is unreadable", async () => {
		const {
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
			getUnifiedSettingsPath,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 70_000 });
		await saveUnifiedDashboardSettings({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});

		const readSpy = vi.spyOn(fs, "readFile");
		readSpy.mockImplementationOnce(async () => {
			const error = new Error("permission denied") as NodeJS.ErrnoException;
			error.code = "EACCES";
			throw error;
		});

		try {
			await saveUnifiedDashboardSettings({
				menuShowLastUsed: true,
				uiThemePreset: "yellow",
			});
		} finally {
			readSpy.mockRestore();
		}

		const raw = await fs.readFile(getUnifiedSettingsPath(), "utf8");
		const parsed = JSON.parse(raw) as {
			pluginConfig?: Record<string, unknown>;
			dashboardDisplaySettings?: Record<string, unknown>;
		};
		expect(parsed.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 70_000,
		});
		expect(parsed.dashboardDisplaySettings).toEqual({
			menuShowLastUsed: true,
			uiThemePreset: "yellow",
		});
	});

	it("rethrows transient primary read errors instead of falling back to backup", async () => {
		const {
			saveUnifiedPluginConfig,
			saveUnifiedDashboardSettings,
			getUnifiedSettingsPath,
		} = await import("../lib/unified-settings.js");

		await saveUnifiedPluginConfig({ codexMode: true, fetchTimeoutMs: 70_000 });
		await saveUnifiedDashboardSettings({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});

		const readSpy = vi.spyOn(fs, "readFile");
		readSpy.mockImplementationOnce(async () => {
			const error = new Error("file locked") as NodeJS.ErrnoException;
			error.code = "EBUSY";
			throw error;
		});

		try {
			await expect(
				saveUnifiedDashboardSettings({
					menuShowLastUsed: true,
					uiThemePreset: "yellow",
				}),
			).rejects.toThrow("file locked");
		} finally {
			readSpy.mockRestore();
		}

		const raw = await fs.readFile(getUnifiedSettingsPath(), "utf8");
		const parsed = JSON.parse(raw) as {
			pluginConfig?: Record<string, unknown>;
			dashboardDisplaySettings?: Record<string, unknown>;
		};
		expect(parsed.pluginConfig).toEqual({
			codexMode: true,
			fetchTimeoutMs: 70_000,
		});
		expect(parsed.dashboardDisplaySettings).toEqual({
			menuShowLastUsed: false,
			uiThemePreset: "blue",
		});
	});
});
