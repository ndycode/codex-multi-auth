import { afterEach, describe, expect, it, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
	FILE_RETRY_BASE_DELAY_MS,
	FILE_RETRY_MAX_ATTEMPTS,
	withInstallerLock,
	installPluginIntoCache,
	PLUGIN_MARKETPLACE,
	PLUGIN_NAME,
	PLUGIN_VERSION,
	makePluginKey,
	mergePluginConfigToml,
	resolveInstallPaths,
	withFileOperationRetry,
} from "../scripts/install-codex-auth-utils.js";

const scriptPath = "scripts/install-codex-auth.js";
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

describe("install-codex-auth script", () => {
	it("resolves official Codex paths from CODEX_HOME", () => {
		const paths = resolveInstallPaths(
			"linux",
			{
				CODEX_HOME: "/tmp/codex-home",
			},
			"/home/test",
		);
		expect(paths.codexHomeDir).toBe("/tmp/codex-home");
		expect(paths.configPath).toBe(path.join("/tmp/codex-home", "config.toml"));
		expect(paths.pluginInstallDir).toBe(
			path.join(
				"/tmp/codex-home",
				"plugins",
				"cache",
				PLUGIN_MARKETPLACE,
				PLUGIN_NAME,
				PLUGIN_VERSION,
			),
		);
	});

	it("uses the package version for installer cache paths", () => {
		const packageVersion = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
		expect(PLUGIN_VERSION).toBe(packageVersion.version);
	});

	it("respects CODEX_CLI_CONFIG_PATH override", () => {
		const paths = resolveInstallPaths(
			"linux",
			{
				CODEX_HOME: "/tmp/codex-home",
				CODEX_CLI_CONFIG_PATH: "/tmp/custom/config.toml",
			},
			"/home/test",
		);
		expect(paths.configPath).toBe("/tmp/custom/config.toml");
		expect(paths.configDir).toBe(path.dirname("/tmp/custom/config.toml"));
	});

	it("resolves codex home dir on windows using USERPROFILE", () => {
		const paths = resolveInstallPaths(
			"win32",
			{ USERPROFILE: "C:\\Users\\alice" },
			"C:\\Users\\fallback",
		);
		expect(paths.codexHomeDir).toBe(path.win32.join("C:\\Users\\alice", ".codex"));
		expect(paths.configPath).toBe(path.win32.join("C:\\Users\\alice", ".codex", "config.toml"));
	});

	it("resolves codex home dir on windows using HOMEDRIVE and HOMEPATH fallback", () => {
		const paths = resolveInstallPaths(
			"win32",
			{ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\bob" },
			"C:\\Users\\fallback",
		);
		expect(paths.codexHomeDir).toBe(path.win32.join("C:\\Users\\bob", ".codex"));
		expect(paths.configPath).toBe(path.win32.join("C:\\Users\\bob", ".codex", "config.toml"));
	});

	it("merges plugin settings into config.toml", () => {
		const merged = mergePluginConfigToml(
			["[features]", "plugins = false", "", "[plugins.\"codex-multi-auth@ndycode\"]", "enabled = false", ""].join("\n"),
			makePluginKey(),
		);
		expect(merged).toContain("[features]");
		expect(merged).toContain("plugins = true");
		expect(merged).toContain('[plugins."codex-multi-auth@ndycode"]');
		expect(merged).toContain("enabled = true");
	});

	it("preserves unrelated plugin entries while enabling codex-multi-auth", () => {
		const merged = mergePluginConfigToml(
			[
				"model = \"gpt-5-codex\"",
				"",
				"[features]",
				"mcp = true",
				"",
				"[plugins.\"other-plugin@openai-curated\"]",
				"enabled = false",
				"",
			].join("\n"),
			makePluginKey(),
		);
		expect(merged).toContain('model = "gpt-5-codex"');
		expect(merged).toContain("mcp = true");
		expect(merged).toContain('[plugins."other-plugin@openai-curated"]\nenabled = false');
		expect(merged).toContain('[plugins."codex-multi-auth@ndycode"]');
	});

	it("treats TOML array-of-table headers as section boundaries", () => {
		const merged = mergePluginConfigToml(
			[
				"[features]",
				"mcp = true",
				"",
				"[[model]]",
				'name = "gpt-5-codex"',
				"",
			].join("\n"),
			makePluginKey(),
		);
		expect(merged).toContain("[features]\nmcp = true\n\nplugins = true\n[[model]]");
		expect(merged).toContain('[plugins."codex-multi-auth@ndycode"]');
		expect(merged).not.toContain("[[model]]\nplugins = true");
	});

	it("matches section headers with inline comments", () => {
		const merged = mergePluginConfigToml(
			[
				"[features] # existing feature flags",
				"plugins = false",
				"",
				'[plugins."codex-multi-auth@ndycode"] # plugin toggle',
				"enabled = false",
				"",
			].join("\n"),
			makePluginKey(),
		);
		expect(merged.match(/\[features\]/g)?.length ?? 0).toBe(1);
		expect(merged.match(/\[plugins\."codex-multi-auth@ndycode"\]/g)?.length ?? 0).toBe(1);
		expect(merged).toContain("plugins = true");
		expect(merged).toContain("enabled = true");
	});

	it("escapes regex metacharacters in TOML keys", () => {
		const merged = mergePluginConfigToml(
			["[features]", "plugins = false", "shell_tool = false", "shell.tool = false", ""].join("\n"),
			makePluginKey(),
		);
		expect(merged).toContain("shell_tool = false");
		expect(merged).toContain("shell.tool = false");
	});

	it("preserves CRLF line endings when updating config.toml", () => {
		const merged = mergePluginConfigToml(
			"[features]\r\nplugins = false\r\n",
			makePluginKey(),
		);
		expect(merged).toContain("[features]\r\nplugins = true\r\n");
		expect(merged).toContain('[plugins."codex-multi-auth@ndycode"]\r\nenabled = true\r\n');
		expect(merged).not.toContain("\nplugins = true\n[plugins.");
	});

	it("uses LF output for empty config content", () => {
		const merged = mergePluginConfigToml("", makePluginKey());
		expect(merged).toContain("[features]\nplugins = true\n");
		expect(merged).not.toContain("\r\n");
	});

	it("dry-run does not create config or plugin cache", () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-dryrun-"));
		tempRoots.push(home);
		const codexHome = path.join(home, ".codex");
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: codexHome,
		};

		const result = spawnSync(process.execPath, [scriptPath, "--dry-run", "--modern"], {
			env,
			encoding: "utf8",
			windowsHide: true,
		});

		expect(result.status).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("[dry-run]");
		expect(existsSync(path.join(codexHome, "config.toml"))).toBe(false);
		expect(existsSync(path.join(codexHome, "plugins", "cache"))).toBe(false);
	});

	it("installs plugin cache and updates config.toml", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-install-"));
		tempRoots.push(home);
		const codexHome = path.join(home, ".codex");
		const configPath = path.join(codexHome, "config.toml");
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: codexHome,
		};

		mkdirSync(path.dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			["model = \"gpt-5-codex\"", "", "[features]", "shell_tool = true", ""].join("\n"),
			"utf8",
		);

		const result = await execFileAsync(process.execPath, [scriptPath, "--no-cache-clear"], {
			env,
			windowsHide: true,
		});

		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Installed plugin cache");
		expect(result.stdout).toContain("Backup created");

		const config = readFileSync(configPath, "utf8");
		expect(config).toContain("model = \"gpt-5-codex\"");
		expect(config).toContain("[features]");
		expect(config).toContain("plugins = true");
		expect(config).toContain('[plugins."codex-multi-auth@ndycode"]');
		expect(config).toContain("enabled = true");

		const pluginManifestPath = path.join(
			codexHome,
			"plugins",
			"cache",
			PLUGIN_MARKETPLACE,
			PLUGIN_NAME,
			PLUGIN_VERSION,
			".codex-plugin",
			"plugin.json",
		);
		expect(existsSync(pluginManifestPath)).toBe(true);

		const backups = readdirSync(codexHome).filter((entry) =>
			entry.startsWith("config.toml.bak-")
		);
		expect(backups.length).toBe(1);
	});

	it("does not create extra backups when config.toml is already up to date", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-idempotent-"));
		tempRoots.push(home);
		const codexHome = path.join(home, ".codex");
		const configPath = path.join(codexHome, "config.toml");
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: codexHome,
		};

		mkdirSync(path.dirname(configPath), { recursive: true });
		writeFileSync(configPath, mergePluginConfigToml("[features]\nplugins = true\n", makePluginKey()), "utf8");

		const result = await execFileAsync(process.execPath, [scriptPath], {
			env,
			windowsHide: true,
		});

		expect(result.stdout).toContain(`${configPath} is already up to date.`);
		const backups = readdirSync(codexHome).filter((entry) =>
			entry.startsWith("config.toml.bak-")
		);
		expect(backups.length).toBe(0);
	});

	it("replaces an existing plugin cache entry with the current plugin shell", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-reinstall-"));
		tempRoots.push(home);
		const codexHome = path.join(home, ".codex");
		const configPath = path.join(codexHome, "config.toml");
		const pluginRoot = path.join(
			codexHome,
			"plugins",
			"cache",
			PLUGIN_MARKETPLACE,
			PLUGIN_NAME,
			PLUGIN_VERSION,
		);
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: codexHome,
		};

		mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
		writeFileSync(
			path.join(pluginRoot, ".codex-plugin", "plugin.json"),
			'{"name":"stale-plugin"}\n',
			"utf8",
		);
		mkdirSync(path.dirname(configPath), { recursive: true });
		writeFileSync(configPath, "", "utf8");

		await execFileAsync(process.execPath, [scriptPath], {
			env,
			windowsHide: true,
		});

		const manifest = readFileSync(
			path.join(pluginRoot, ".codex-plugin", "plugin.json"),
			"utf8",
		);
		expect(manifest).toContain('"name": "codex-multi-auth"');
		expect(manifest).not.toContain("stale-plugin");
	});

	it("backs up and updates an overridden CODEX_CLI_CONFIG_PATH", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-config-override-"));
		tempRoots.push(home);
		const codexHome = path.join(home, ".codex");
		const customConfigPath = path.join(home, "configs", "custom-config.toml");
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: codexHome,
			CODEX_CLI_CONFIG_PATH: customConfigPath,
		};

		mkdirSync(path.dirname(customConfigPath), { recursive: true });
		writeFileSync(customConfigPath, '[plugins."other-plugin@debug"]\nenabled = true\n', "utf8");

		const result = await execFileAsync(process.execPath, [scriptPath], {
			env,
			windowsHide: true,
		});

		expect(result.stdout).toContain(`Wrote ${customConfigPath}`);
		const config = readFileSync(customConfigPath, "utf8");
		expect(config).toContain('[plugins."other-plugin@debug"]');
		expect(config).toContain('[plugins."codex-multi-auth@ndycode"]');

		const backups = readdirSync(path.dirname(customConfigPath)).filter((entry) =>
			entry.startsWith("custom-config.toml.bak-")
		);
		expect(backups.length).toBe(1);
	});

	it("concurrent installs produce distinct backups and a valid final config.toml", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-concurrent-"));
		tempRoots.push(home);
		const codexHome = path.join(home, ".codex");
		const configPath = path.join(codexHome, "config.toml");
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: codexHome,
		};

		mkdirSync(path.dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			["model = \"gpt-5-codex\"", "", "[features]", "shell_tool = true", ""].join("\n"),
			"utf8",
		);

		const [first, second] = await Promise.all([
			execFileAsync(process.execPath, [scriptPath], {
				env,
				windowsHide: true,
			}),
			execFileAsync(process.execPath, [scriptPath], {
				env,
				windowsHide: true,
			}),
		]);

		expect(first.stderr).toBe("");
		expect(second.stderr).toBe("");

		const config = readFileSync(configPath, "utf8");
		expect(config).toContain('model = "gpt-5-codex"');
		expect(config).toContain("[features]");
		expect(config).toContain("plugins = true");
		expect(config).toContain('[plugins."codex-multi-auth@ndycode"]');
		expect(config).toContain("enabled = true");
		const pluginManifestPath = path.join(
			codexHome,
			"plugins",
			"cache",
			PLUGIN_MARKETPLACE,
			PLUGIN_NAME,
			PLUGIN_VERSION,
			".codex-plugin",
			"plugin.json",
		);
		expect(existsSync(pluginManifestPath)).toBe(true);
		expect(readFileSync(pluginManifestPath, "utf8")).toContain('"name": "codex-multi-auth"');

		const backups = readdirSync(codexHome).filter((entry) =>
			entry.startsWith("config.toml.bak-")
		);
		expect(backups.length).toBe(1);
		expect(new Set(backups).size).toBe(backups.length);
		expect(existsSync(
			path.join(codexHome, "plugins", "cache", PLUGIN_MARKETPLACE, `${PLUGIN_NAME}.install.lock`),
		)).toBe(false);
	});

	it("reclaims a stale installer lock before installing", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-stale-lock-"));
		tempRoots.push(home);
		const codexHome = path.join(home, ".codex");
		const configPath = path.join(codexHome, "config.toml");
		const lockDir = path.join(codexHome, "plugins", "cache", PLUGIN_MARKETPLACE, `${PLUGIN_NAME}.install.lock`);
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: codexHome,
		};

		mkdirSync(path.dirname(configPath), { recursive: true });
		writeFileSync(configPath, '[features]\nplugins = false\n', "utf8");
		mkdirSync(lockDir, { recursive: true });
		const staleTime = (Date.now() - 120_000) / 1000;
		utimesSync(lockDir, staleTime, staleTime);

		const result = await execFileAsync(process.execPath, [scriptPath], {
			env,
			windowsHide: true,
		});

		expect(result.stdout).toContain("Warning: removing stale installer lock");
		expect(result.stdout).toContain("Installed plugin cache");
		expect(existsSync(lockDir)).toBe(false);
	});

	it("retries transient errors while creating the installer lock parent dir", async () => {
		vi.useFakeTimers();
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
		const lockDir = path.join(tmpdir(), "codex-plugin-lock-parent", `${PLUGIN_NAME}.install.lock`);
		let parentAttempts = 0;
		const mkdirImpl = vi.fn(async (target: string) => {
			if (target === path.dirname(lockDir)) {
				parentAttempts += 1;
				if (parentAttempts === 1) {
					throw retryableError("EACCES");
				}
			}
		});
		const rmImpl = vi.fn(async () => undefined);
		const operation = vi.fn(async () => "ok");

		const pending = withInstallerLock(lockDir, operation, { mkdirImpl, rmImpl });
		await Promise.resolve();
		expect(mkdirImpl).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(FILE_RETRY_BASE_DELAY_MS);
		await expect(pending).resolves.toBe("ok");

		expect(parentAttempts).toBe(2);
		expect(operation).toHaveBeenCalledTimes(1);
		expect(rmImpl).toHaveBeenCalledWith(lockDir, { recursive: true, force: true });
		randomSpy.mockRestore();
	});

	it("restores the existing plugin cache when final rename fails", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-rollback-"));
		tempRoots.push(home);
		const sourcePath = path.join(process.cwd(), "codex-plugin");
		const targetBaseDir = path.join(home, "plugins", "cache", "ndycode", "codex-multi-auth");
		const targetInstallDir = path.join(targetBaseDir, "local");
		const existingManifestPath = path.join(targetInstallDir, ".codex-plugin", "plugin.json");

		mkdirSync(path.dirname(existingManifestPath), { recursive: true });
		writeFileSync(existingManifestPath, '{"name":"existing-plugin"}\n', "utf8");

		let renameCount = 0;
		const renameImpl = vi.fn(async (source: string, target: string) => {
			renameCount += 1;
			if (renameCount === 2) {
				throw retryableError("EPERM");
			}
			await import("node:fs/promises").then(({ rename }) => rename(source, target));
		});

		await expect(
			installPluginIntoCache(sourcePath, targetBaseDir, targetInstallDir, { renameImpl }),
		).rejects.toMatchObject({ code: "EPERM" });

		const restoredManifest = readFileSync(existingManifestPath, "utf8");
		expect(restoredManifest).toContain("existing-plugin");
	});

	it("preserves rollback contents when restore rename also fails", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-rollback-preserve-"));
		tempRoots.push(home);
		const sourcePath = path.join(process.cwd(), "codex-plugin");
		const targetBaseDir = path.join(home, "plugins", "cache", "ndycode", "codex-multi-auth");
		const targetInstallDir = path.join(targetBaseDir, "local");
		const existingManifestPath = path.join(targetInstallDir, ".codex-plugin", "plugin.json");

		mkdirSync(path.dirname(existingManifestPath), { recursive: true });
		writeFileSync(existingManifestPath, '{"name":"existing-plugin"}\n', "utf8");

		let renameCount = 0;
		let rollbackDir = "";
		const renameImpl = vi.fn(async (source: string, target: string) => {
			renameCount += 1;
			if (renameCount === 1) {
				rollbackDir = target;
				await import("node:fs/promises").then(({ rename }) => rename(source, target));
				return;
			}
			throw retryableError(renameCount === 2 ? "EPERM" : "EBUSY");
		});

		await expect(
			installPluginIntoCache(sourcePath, targetBaseDir, targetInstallDir, { renameImpl }),
		).rejects.toMatchObject({ code: "EBUSY" });

		expect(existsSync(targetBaseDir)).toBe(false);
		expect(rollbackDir).not.toBe("");
		expect(existsSync(rollbackDir)).toBe(true);
		const preservedManifestPath = path.join(rollbackDir, "local", ".codex-plugin", "plugin.json");
		expect(readFileSync(preservedManifestPath, "utf8")).toContain("existing-plugin");
	});

	it("preserves rollback contents when restore is skipped after staged rename failure", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "codex-plugin-rollback-skipped-"));
		tempRoots.push(home);
		const sourcePath = path.join(process.cwd(), "codex-plugin");
		const targetBaseDir = path.join(home, "plugins", "cache", "ndycode", "codex-multi-auth");
		const targetInstallDir = path.join(targetBaseDir, "local");
		const existingManifestPath = path.join(targetInstallDir, ".codex-plugin", "plugin.json");
		const unexpectedManifestPath = path.join(targetBaseDir, "unexpected", ".codex-plugin", "plugin.json");

		mkdirSync(path.dirname(existingManifestPath), { recursive: true });
		writeFileSync(existingManifestPath, '{"name":"existing-plugin"}\n', "utf8");

		let rollbackDir = "";
		let renameCount = 0;
		const renameImpl = vi.fn(async (source: string, target: string) => {
			renameCount += 1;
			if (renameCount === 1) {
				rollbackDir = target;
				await import("node:fs/promises").then(({ rename }) => rename(source, target));
				mkdirSync(path.dirname(unexpectedManifestPath), { recursive: true });
				writeFileSync(unexpectedManifestPath, '{"name":"unexpected-plugin"}\n', "utf8");
				return;
			}
			throw retryableError("EPERM");
		});

		await expect(
			installPluginIntoCache(sourcePath, targetBaseDir, targetInstallDir, { renameImpl }),
		).rejects.toMatchObject({ code: "EPERM" });

		expect(rollbackDir).not.toBe("");
		expect(existsSync(rollbackDir)).toBe(true);
		const preservedManifestPath = path.join(rollbackDir, "local", ".codex-plugin", "plugin.json");
		expect(readFileSync(preservedManifestPath, "utf8")).toContain("existing-plugin");
		expect(readFileSync(unexpectedManifestPath, "utf8")).toContain("unexpected-plugin");
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
