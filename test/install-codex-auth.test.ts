import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	FILE_RETRY_BASE_DELAY_MS,
	FILE_RETRY_MAX_ATTEMPTS,
	normalizePluginList,
	removePluginFromList,
	resolveInstallPaths,
	withFileOperationRetry,
} from "../scripts/install-codex-auth-utils.js";
import {
	createWindowsShortcutPowerShellScript,
	resolveAppLauncherPlan,
} from "../scripts/codex-app-launcher.js";
import {
	hasCodexDesktopApp,
	isCiEnvironment,
	resolveRotationEnabled,
	runPostinstallSelfHeal,
	shouldAutoBindCodexAppOnInstall,
	shouldAutoInstallCodexAppLauncherOnInstall,
} from "../scripts/postinstall.js";

const scriptPath = "scripts/install-codex-auth.js";
const appLauncherScriptPath = "scripts/codex-app-launcher.js";
const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

function retryableError(code: string): Error & { code: string } {
	const error = new Error(`transient ${code}`) as Error & { code: string };
	error.code = code;
	return error;
}

function decodeWindowsEncodedCommand(commandArgs: string): string {
	const marker = "-EncodedCommand ";
	const encoded = commandArgs.slice(commandArgs.indexOf(marker) + marker.length).trim();
	return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("install-codex-auth script", () => {
  it("uses lowercase config template filenames", () => {
    const content = readFileSync(scriptPath, "utf8");
    expect(content).toContain('"codex-legacy.json"');
    expect(content).toContain('"codex-modern.json"');
    expect(content).not.toContain('"Codex-legacy.json"');
    expect(content).not.toContain('"Codex-modern.json"');
  });

	it("normalizes plugin list with empty, duplicate, and non-string entries", () => {
		expect(normalizePluginList(undefined)).toEqual(["codex-multi-auth"]);
		expect(normalizePluginList(["codex-multi-auth", "a", "a", 123, null])).toEqual([
			"a",
			123,
			"codex-multi-auth",
		]);
		expect(normalizePluginList(["codex-multi-auth@1.0.0", "b"])).toEqual([
			"b",
			"codex-multi-auth",
		]);
	});

	it("removes the plugin and versioned variants without disturbing other entries", () => {
		expect(removePluginFromList(["codex-multi-auth", "other"])).toEqual(["other"]);
		expect(
			removePluginFromList(["codex-multi-auth@2.1.5", "keep", "codex-multi-auth@1.0.0"]),
		).toEqual(["keep"]);
		expect(removePluginFromList(undefined)).toEqual([]);
		expect(removePluginFromList(["codex-multi-auth"])).toEqual([]);
		// Non-string entries should be preserved.
		const obj = { name: "other-plugin" };
		expect(removePluginFromList([obj, "codex-multi-auth"])).toEqual([obj]);
	});

	it("uses APPDATA/LOCALAPPDATA on windows path resolution", () => {
		const paths = resolveInstallPaths(
			"win32",
			{
				APPDATA: "C:\\Users\\test\\AppData\\Roaming",
				LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
			},
			"C:\\Users\\test",
		);
		expect(paths.configPath).toBe(
			path.join("C:\\Users\\test\\AppData\\Roaming", "Codex", "Codex.json"),
		);
		expect(paths.cacheNodeModules).toBe(
			path.join(
				"C:\\Users\\test\\AppData\\Local",
				"Codex",
				"node_modules",
				"codex-multi-auth",
			),
		);
	});

	it("creates distinct backup files when installer runs concurrently", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-install-race-"));
		tempRoots.push(home);
		const appData = path.join(home, "AppData", "Roaming");
		const localAppData = path.join(home, "AppData", "Local");
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			APPDATA: appData,
			LOCALAPPDATA: localAppData,
		};
		const configDir = path.join(appData, "Codex");
		const configPath = path.join(configDir, "Codex.json");
		const initialConfig = JSON.stringify({ plugin: ["existing-plugin"] }, null, 2);

		mkdirSync(configDir, { recursive: true });
		writeFileSync(configPath, `${initialConfig}\n`, "utf8");

		const [first, second] = await Promise.all([
			execFileAsync(process.execPath, [scriptPath, "--modern", "--no-cache-clear"], {
				env,
				windowsHide: true,
			}),
			execFileAsync(process.execPath, [scriptPath, "--legacy", "--no-cache-clear"], {
				env,
				windowsHide: true,
			}),
		]);

		expect(first.stderr).toBe("");
		expect(second.stderr).toBe("");
		expect(first.stdout).toContain("Backup created");
		expect(second.stdout).toContain("Backup created");
		const backups = readdirSync(configDir).filter((entry) =>
			entry.startsWith("Codex.json.bak-"),
		);
		expect(new Set(backups).size).toBe(backups.length);
		expect(backups.length).toBeGreaterThanOrEqual(2);
	});

	it("dry-run does not create global config on disk", () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-install-dryrun-"));
		tempRoots.push(home);
		const appData = path.join(home, "AppData", "Roaming");
		const localAppData = path.join(home, "AppData", "Local");
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			APPDATA: appData,
			LOCALAPPDATA: localAppData,
		};

		const result = spawnSync(process.execPath, [scriptPath, "--dry-run", "--modern"], {
			env,
			encoding: "utf8",
			windowsHide: true,
		});

		expect(result.status).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("[dry-run]");
		const configPath = path.join(appData, "Codex", "Codex.json");
		expect(existsSync(configPath)).toBe(false);
	});

	it("retries transient file-operation errors and eventually succeeds", async () => {
		vi.useFakeTimers();
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
		const operation = vi.fn<() => Promise<string>>()
			.mockRejectedValueOnce(retryableError("EBUSY"))
			.mockRejectedValueOnce(retryableError("EPERM"))
			.mockResolvedValue("ok");

		const pending = withFileOperationRetry(operation);
		await Promise.resolve();
		expect(operation).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(FILE_RETRY_BASE_DELAY_MS);
		expect(operation).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(FILE_RETRY_BASE_DELAY_MS * 2);
		await expect(pending).resolves.toBe("ok");
		expect(operation).toHaveBeenCalledTimes(3);

		randomSpy.mockRestore();
	});

	it("throws after max retry attempts for persistent transient errors", async () => {
		vi.useFakeTimers();
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
		const operation = vi.fn<() => Promise<void>>().mockRejectedValue(retryableError("EAGAIN"));

		const pending = withFileOperationRetry(operation);
		pending.catch(() => undefined);
		for (let attempt = 1; attempt < FILE_RETRY_MAX_ATTEMPTS; attempt += 1) {
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(FILE_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
		}

		await expect(pending).rejects.toMatchObject({ code: "EAGAIN" });
		expect(operation).toHaveBeenCalledTimes(FILE_RETRY_MAX_ATTEMPTS);

		randomSpy.mockRestore();
	});

	it("throws immediately for non-retryable file-operation errors", async () => {
		const operation = vi.fn<() => Promise<void>>().mockRejectedValue(retryableError("ENOENT"));

		await expect(withFileOperationRetry(operation)).rejects.toMatchObject({ code: "ENOENT" });
		expect(operation).toHaveBeenCalledTimes(1);
	});
});

describe("codex app launcher installer", () => {
	it("resolves Windows shortcut routing that points existing Codex icons at the wrapper app command", () => {
		const home = "C:\\Users\\test";
		const appData = path.join(home, "AppData", "Roaming");
		const plan = resolveAppLauncherPlan({
			platform: "win32",
			home,
			env: { APPDATA: appData },
			moduleUrl: pathToFileURL(path.resolve(appLauncherScriptPath)).href,
		});

		expect(plan.launcherPath).toBe(
			path.join(
				appData,
				"Microsoft",
				"Windows",
				"Start Menu",
				"Programs",
				"Codex.lnk",
			),
		);
		expect(plan.mode).toBe("route-existing");
		expect(plan.backupPath).toBe(
			path.join(home, ".codex", "multi-auth", "app-shortcuts.json"),
		);
		expect(plan.shortcutRoots).toEqual(
			expect.arrayContaining([
				path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
				path.join(
					appData,
					"Microsoft",
					"Internet Explorer",
					"Quick Launch",
					"User Pinned",
					"TaskBar",
				),
				path.join(home, "Desktop"),
			]),
		);
		expect(plan.commandPath).toBe(
			path.join(
				"C:\\Windows",
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			),
		);
		expect(plan.commandArgs).toContain("-EncodedCommand ");
		const decodedCommand = decodeWindowsEncodedCommand(plan.commandArgs);
		expect(decodedCommand).toContain(process.execPath);
		expect(decodedCommand).toContain("scripts\\codex.js");
		expect(decodedCommand).toContain(" app");

		const psScript = createWindowsShortcutPowerShellScript(plan);
		expect(psScript).toContain("$Candidates");
		expect(psScript).toContain("$BackupPath");
		expect(psScript).toContain("[Environment]::GetFolderPath('Desktop')");
		expect(psScript).toContain("shell:AppsFolder");
		expect(psScript).toContain("$AlreadyManaged");
		expect(psScript).toContain("$Shortcut.TargetPath = $TargetPath");
		expect(psScript).toContain("Launch Codex through codex-multi-auth");
	});

	it("keeps Windows shortcut arguments free of raw percent paths", () => {
		const home = "C:\\Users\\percent%home";
		const appData = path.join(home, "App%Data", "Roaming");
		const moduleUrl = pathToFileURL(
			path.join(home, "pkg%root", "scripts", "codex-app-launcher.js"),
		).href;
		const plan = resolveAppLauncherPlan({
			platform: "win32",
			home,
			env: { APPDATA: appData },
			moduleUrl,
		});

		expect(plan.commandArgs).not.toContain(home);
		expect(plan.commandArgs).not.toContain("pkg%root");
		const decodedCommand = decodeWindowsEncodedCommand(plan.commandArgs);
		expect(decodedCommand).toContain(home);
		expect(decodedCommand).toContain("pkg%root");
		expect(decodedCommand).toContain("codex.js");
	});

	it("includes redirected Windows desktop roots when routing app shortcuts", () => {
		const home = "C:\\Users\\test";
		const appData = path.join(home, "AppData", "Roaming");
		const oneDrive = path.join(home, "OneDrive - Example");
		const plan = resolveAppLauncherPlan({
			platform: "win32",
			home,
			env: {
				APPDATA: appData,
				OneDrive: oneDrive,
			},
			moduleUrl: pathToFileURL(path.resolve(appLauncherScriptPath)).href,
		});

		expect(plan.shortcutRoots).toEqual(
			expect.arrayContaining([
				path.join(oneDrive, "Desktop"),
				path.join(home, "Desktop"),
			]),
		);
	});

	it("resolves a macOS managed app wrapper without patching the official app bundle", () => {
		const home = "/Users/test";
		const plan = resolveAppLauncherPlan({
			platform: "darwin",
			home,
			env: {},
			moduleUrl: pathToFileURL(path.resolve(appLauncherScriptPath)).href,
		});

		expect(plan.mode).toBe("create-managed");
		expect(plan.launcherPath).toBe(path.join(home, "Applications", "Codex Multi Auth.app"));
		expect(plan.commandPath).toBe(process.execPath);
		expect(plan.commandArgs).toContain("codex.js");
		expect(plan.commandArgs).toContain(" app");
	});

	it("resolves a Linux desktop launcher under XDG_DATA_HOME", () => {
		const home = "/home/test";
		const dataHome = "/tmp/test-data";
		const plan = resolveAppLauncherPlan({
			platform: "linux",
			home,
			env: { XDG_DATA_HOME: dataHome },
			moduleUrl: pathToFileURL(path.resolve(appLauncherScriptPath)).href,
		});

		expect(plan.launcherPath).toBe(
			path.join(dataHome, "applications", "codex-multi-auth.desktop"),
		);
		expect(plan.commandPath).toBe(process.execPath);
		expect(plan.commandArgs).toContain("codex.js");
		expect(plan.commandArgs).toContain(" app %F");
	});

	it("dry-run reports the launcher path without writing it", () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-app-launcher-dryrun-"));
		tempRoots.push(home);
		const dataHome = path.join(home, "data");
		const result = spawnSync(
			process.execPath,
			[appLauncherScriptPath, "--dry-run"],
			{
				env: {
					...process.env,
					XDG_DATA_HOME: dataHome,
				},
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("[dry-run]");
		if (process.platform !== "win32") {
			expect(result.stdout).toContain("Codex Multi Auth app launcher");
			expect(existsSync(path.join(dataHome, "applications", "codex-multi-auth.desktop"))).toBe(
				false,
			);
		}
	});
});

describe("codex app bind postinstall gate", () => {
	it("detects the packaged Windows Codex app from LOCALAPPDATA packages", () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-app-bind-detect-"));
		tempRoots.push(home);
		const localAppData = path.join(home, "AppData", "Local");
		mkdirSync(path.join(localAppData, "Packages", "OpenAI.Codex_test"), {
			recursive: true,
		});

		expect(
			hasCodexDesktopApp({
				platform: "win32",
				home,
				env: { LOCALAPPDATA: localAppData },
			}),
		).toBe(true);
	});

	it("only auto-binds on install when opted in or globally installed with rotation enabled", () => {
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: {},
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(false);
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: { npm_config_global: "true" },
				rotationEnabled: false,
				appDetected: true,
			}),
		).toBe(false);
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: { npm_config_global: "true" },
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(true);
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: { CODEX_MULTI_AUTH_APP_BIND_INSTALL: "1" },
				rotationEnabled: false,
				appDetected: false,
			}),
		).toBe(true);
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: {
					npm_config_global: "true",
					CODEX_MULTI_AUTH_APP_BIND: "0",
				},
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(false);
	});

	it("skips desktop app auto-bind in CI and when npm scripts are ignored", () => {
		expect(isCiEnvironment({ CI: "true" })).toBe(true);
		expect(isCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
		expect(isCiEnvironment({ npm_config_ignore_scripts: "true" })).toBe(true);
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: {
					CI: "true",
					CODEX_MULTI_AUTH_APP_BIND_INSTALL: "1",
					npm_config_global: "true",
				},
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(false);
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: {
					GITHUB_ACTIONS: "true",
					CODEX_MULTI_AUTH_APP_BIND: "1",
				},
				rotationEnabled: true,
				appDetected: true,
			}),
		).toBe(false);
		expect(
			shouldAutoBindCodexAppOnInstall({
				env: {
					npm_config_ignore_scripts: "true",
					CODEX_MULTI_AUTH_APP_BIND_INSTALL: "1",
				},
				rotationEnabled: true,
				appDetected: true,
			}),
			).toBe(false);
	});

	it("installs app launcher routing on global install when rotation is enabled", () => {
		expect(
			shouldAutoInstallCodexAppLauncherOnInstall({
				env: {},
				rotationEnabled: true,
			}),
		).toBe(false);
		expect(
			shouldAutoInstallCodexAppLauncherOnInstall({
				env: { npm_config_global: "true" },
				rotationEnabled: false,
			}),
		).toBe(false);
		expect(
			shouldAutoInstallCodexAppLauncherOnInstall({
				env: { npm_config_global: "true" },
				rotationEnabled: true,
			}),
		).toBe(true);
		expect(
			shouldAutoInstallCodexAppLauncherOnInstall({
				env: {
					npm_config_global: "true",
					CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: "0",
				},
				rotationEnabled: true,
			}),
		).toBe(false);
		expect(
			shouldAutoInstallCodexAppLauncherOnInstall({
				env: { CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: "1" },
				rotationEnabled: false,
			}),
		).toBe(true);
		expect(
			shouldAutoInstallCodexAppLauncherOnInstall({
				env: {
					CI: "true",
					CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL: "1",
				},
				rotationEnabled: true,
			}),
		).toBe(false);
		// CI and ignored-scripts guards win over explicit launcher opt-in so
		// package installs stay side-effect-free in automation.
	});

	it("resolves runtime rotation as default-on for install/update self-heal", () => {
		expect(resolveRotationEnabled(null, {})).toBe(true);
		expect(resolveRotationEnabled({}, {})).toBe(true);
		expect(
			resolveRotationEnabled(null, {
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
			}),
		).toBe(false);
		expect(
			resolveRotationEnabled(
				{
					loadPluginConfig: () => ({}),
					getCodexRuntimeRotationProxy: () => true,
				},
				{},
			),
		).toBe(true);
		expect(
			resolveRotationEnabled(
				{
					loadPluginConfig: () => ({ codexRuntimeRotationProxy: true }),
					getCodexRuntimeRotationProxy: () => true,
				},
				{
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
				},
			),
		).toBe(false);
		expect(
			resolveRotationEnabled(
				{
					loadPluginConfig: () => ({ codexRuntimeRotationProxy: false }),
					getCodexRuntimeRotationProxy: () => false,
				},
				{},
			),
		).toBe(false);
	});

	it("still runs launcher repair when app bind self-heal fails", async () => {
		const bindCodexApp = vi.fn(async () => {
			throw new Error("bind failed");
		});
		const installLauncher = vi.fn(async () => undefined);
		const log = vi.fn();

		await expect(
			runPostinstallSelfHeal({
				loadConfigModule: async () => ({
					loadPluginConfig: () => ({ codexRuntimeRotationProxy: true }),
					getCodexRuntimeRotationProxy: () => true,
				}),
				bindCodexApp,
				installLauncher,
				log,
				env: {},
			}),
		).resolves.toBe(0);

		expect(bindCodexApp).toHaveBeenCalledWith(true);
		expect(installLauncher).toHaveBeenCalledWith(true);
		expect(log).toHaveBeenCalledWith(
			"app bind postinstall skipped: bind failed",
		);
	});

	it("keeps postinstall self-heal successful when launcher repair fails", async () => {
		const bindCodexApp = vi.fn(async () => undefined);
		const installLauncher = vi.fn(async () => {
			throw new Error("launcher failed");
		});
		const log = vi.fn();

		await expect(
			runPostinstallSelfHeal({
				loadConfigModule: async () => null,
				bindCodexApp,
				installLauncher,
				log,
				env: {},
			}),
		).resolves.toBe(0);

		expect(bindCodexApp).toHaveBeenCalledWith(true);
		expect(installLauncher).toHaveBeenCalledWith(true);
		expect(log).toHaveBeenCalledWith(
			"app launcher postinstall skipped: launcher failed",
		);
	});

	it("preserves explicit postinstall return codes for direct runs", () => {
		const content = readFileSync("scripts/postinstall.js", "utf8");

		expect(content).toContain(".then((exitCode) => {");
		expect(content).toContain(
			"process.exitCode = normalizePostinstallExitCode(exitCode);",
		);
	});
});
