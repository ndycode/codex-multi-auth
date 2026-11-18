import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInstallPaths } from "../scripts/install-codex-auth-utils.js";
import {
	parseUninstallArgs,
	removePluginFromList,
	resolveUninstallPaths,
	runUninstallCommand,
} from "../lib/codex-manager/commands/uninstall.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) await removeWithRetry(root, { recursive: true, force: true });
	}
});

function makeTempHome(): string {
	const root = mkdtempSync(path.join(tmpdir(), "uninstall-cmd-"));
	tempRoots.push(root);
	return root;
}

// Defer to the production path resolver so the tests cannot drift from
// real install/uninstall behavior. configDir/cacheDir are derived from
// the production-resolved file paths so we still have the directories
// the test fixtures need to mkdirSync into.
function pathsForTempHome(home: string) {
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		USERPROFILE: home,
		APPDATA:
			process.platform === "win32" ? path.join(home, "AppData", "Roaming") : "",
		LOCALAPPDATA:
			process.platform === "win32" ? path.join(home, "AppData", "Local") : "",
	};
	const resolved = resolveUninstallPaths(process.platform, env, home);
	return {
		...resolved,
		configDir: path.dirname(resolved.configPath),
		cacheDir: path.dirname(resolved.cacheBunLock),
	};
}

describe("removePluginFromList", () => {
	it("strips the bare plugin name", () => {
		expect(removePluginFromList(["other", "codex-multi-auth"])).toEqual(["other"]);
	});

	it("strips versioned variants", () => {
		expect(
			removePluginFromList(["codex-multi-auth@2.1.5", "keep-me", "codex-multi-auth@1.0.0"]),
		).toEqual(["keep-me"]);
	});

	it("strips the legacy scoped package name and its versioned variants", () => {
		expect(
			removePluginFromList([
				"@ndycode/codex-multi-auth",
				"@ndycode/codex-multi-auth@2.0.0",
				"keep-me",
			]),
		).toEqual(["keep-me"]);
	});

	it("preserves non-string entries", () => {
		const obj = { name: "other-plugin" };
		expect(removePluginFromList([obj, "codex-multi-auth"])).toEqual([obj]);
	});

	it("returns an empty list when only this plugin is present", () => {
		expect(removePluginFromList(["codex-multi-auth"])).toEqual([]);
	});
});

describe("parseUninstallArgs", () => {
	it("defaults all flags to false", () => {
		expect(parseUninstallArgs([])).toEqual({
			ok: true,
			options: { dryRun: false, json: false, clearAccounts: false },
		});
	});

	it("recognizes every documented flag", () => {
		expect(parseUninstallArgs(["--dry-run", "--json", "--clear-accounts"])).toEqual({
			ok: true,
			options: { dryRun: true, json: true, clearAccounts: true },
		});
	});

	it("returns help on --help and -h", () => {
		expect(parseUninstallArgs(["--help"])).toEqual({ ok: false, reason: "help" });
		expect(parseUninstallArgs(["-h"])).toEqual({ ok: false, reason: "help" });
	});

	it("rejects unknown options", () => {
		expect(parseUninstallArgs(["--bogus"])).toEqual({
			ok: false,
			reason: "error",
			message: "Unknown option: --bogus",
		});
	});
});

describe("resolveUninstallPaths", () => {
	it("matches installer cache paths on Windows", () => {
		const home = "C:\\Users\\user";
		const env = {
			APPDATA: path.join(home, "AppData", "Roaming"),
			LOCALAPPDATA: path.join(home, "AppData", "Local"),
		};
		const installed = resolveInstallPaths("win32", env, home);
		const uninstalled = resolveUninstallPaths("win32", env, home);

		expect(uninstalled.configPath).toBe(installed.configPath);
		expect(uninstalled.cacheNodeModules).toBe(installed.cacheNodeModules);
		expect(uninstalled.cacheLegacyNodeModules).toBe(
			installed.cacheLegacyNodeModules,
		);
		expect(uninstalled.cacheBunLock).toBe(installed.cacheBunLock);
	});

	it("uses XDG layout on linux", () => {
		const paths = resolveUninstallPaths(
			"linux",
			{ APPDATA: "", LOCALAPPDATA: "" },
			"/home/user",
		);
		expect(paths.configPath).toBe(path.join("/home/user", ".config", "Codex", "Codex.json"));
		expect(paths.cacheBunLock).toBe(path.join("/home/user", ".cache", "Codex", "bun.lock"));
	});

	it("falls back to AppData defaults on windows when env is empty", () => {
		const paths = resolveUninstallPaths(
			"win32",
			{ APPDATA: "", LOCALAPPDATA: "" },
			"C:/Users/user",
		);
		expect(paths.configPath.replace(/\\/g, "/")).toBe(
			"C:/Users/user/AppData/Roaming/Codex/Codex.json",
		);
	});
});

describe("runUninstallCommand", () => {
	it("prints help and returns 0 on --help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const code = await runUninstallCommand(["--help"]);
		expect(code).toBe(0);
		expect(logSpy.mock.calls.flat().join("\n")).toMatch(/codex-multi-auth uninstall/);
	});

	it("returns 1 on unknown option", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const code = await runUninstallCommand(["--bogus"]);
		expect(code).toBe(1);
		expect(errSpy.mock.calls.flat().join("\n")).toMatch(/Unknown option/);
	});

	it("dry-run reports what would be removed without touching the filesystem", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth", "other"] }, null, "\t") + "\n",
			"utf8",
		);

		const messages: string[] = [];
		const code = await runUninstallCommand(["--dry-run", "--json"], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheLegacyNodeModules: paths.cacheLegacyNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(existsSync(paths.configPath)).toBe(true);
		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(config.plugins).toContain("codex-multi-auth");
		expect(messages.some((m) => m.includes("[dry-run]"))).toBe(true);
	});

	it("dry-run does not load the launcher module when deps.removeLauncher is omitted", async () => {
		// Regression: previously loadDefaultLauncher() was awaited before the
		// dryRun branch, so a system without dist/scripts/codex-app-launcher.js
		// could not preview the uninstall.
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);

		const messages: string[] = [];
		const code = await runUninstallCommand(["--dry-run", "--json"], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			// removeLauncher intentionally omitted — dry-run must not invoke
			// the default loader path.
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(messages.some((m) => m.includes("[dry-run] Would remove OS launcher"))).toBe(true);
		// "launcher removal skipped" warning would mean the dry-run actually
		// tried to load the launcher module and failed — that's the regression.
		expect(messages.some((m) => m.includes("launcher removal skipped"))).toBe(false);
	});

	it("dry-run reports bun.lock as safe-to-remove when this is the only plugin", async () => {
		// Regression: previously dry-run skipped the Codex.json read, so
		// bunLockState stayed "uncertain" and the log always said "Would skip
		// bun.lock" even when this was the sole plugin.
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);

		const messages: string[] = [];
		const code = await runUninstallCommand(["--dry-run"], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(
			messages.some((m) => m.includes(`[dry-run] Would remove ${paths.cacheBunLock}`)),
		).toBe(true);
		expect(
			messages.some((m) => m.includes("Would skip") && m.includes("bun.lock")),
		).toBe(false);
	});

	it("dry-run reports the legacy cache path too", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		const messages: string[] = [];

		const code = await runUninstallCommand(["--dry-run"], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			removeLauncher: async () => {},
			paths,
		});

		expect(code).toBe(0);
		expect(
			messages.some((m) => m.includes(paths.cacheLegacyNodeModules)),
		).toBe(true);
	});

	it("removes plugin entry from Codex.json and clears node_modules cache", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		mkdirSync(paths.cacheNodeModules, { recursive: true });
		mkdirSync(paths.cacheLegacyNodeModules, { recursive: true });
		writeFileSync(
			path.join(paths.cacheNodeModules, "marker.txt"),
			"present",
			"utf8",
		);
		writeFileSync(
			path.join(paths.cacheLegacyNodeModules, "legacy-marker.txt"),
			"present",
			"utf8",
		);
		writeFileSync(
			paths.configPath,
			JSON.stringify(
				{ plugins: ["codex-multi-auth", "other-plugin"] },
				null,
				"\t",
			) + "\n",
			"utf8",
		);
		// Pre-create bun.lock to verify it is preserved when other plugins remain.
		mkdirSync(paths.cacheDir, { recursive: true });
		writeFileSync(paths.cacheBunLock, "lock", "utf8");

		const code = await runUninstallCommand([], {
			log: () => {},
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheLegacyNodeModules: paths.cacheLegacyNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(config.plugins).toEqual(["other-plugin"]);
		expect(existsSync(paths.cacheNodeModules)).toBe(false);
		expect(existsSync(paths.cacheLegacyNodeModules)).toBe(false);
		// Other plugins still installed → shared bun.lock must be preserved.
		expect(existsSync(paths.cacheBunLock)).toBe(true);
	});

	it("preserves the shared bun.lock when Codex.json is corrupt (parse error)", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		mkdirSync(paths.cacheDir, { recursive: true });
		// Intentionally invalid JSON to trigger parse failure.
		writeFileSync(paths.configPath, "{ broken json", "utf8");
		writeFileSync(paths.cacheBunLock, "lock", "utf8");

		const code = await runUninstallCommand([], {
			log: () => {},
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		// Parse error → partial failure (exit 1) AND bun.lock preserved.
		expect(code).toBe(1);
		expect(existsSync(paths.cacheBunLock)).toBe(true);
	});

	it("preserves the shared bun.lock when Codex.json has no plugins array", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		mkdirSync(paths.cacheDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ otherField: 1 }, null, "\t") + "\n",
			"utf8",
		);
		writeFileSync(paths.cacheBunLock, "lock", "utf8");

		const code = await runUninstallCommand([], {
			log: () => {},
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(existsSync(paths.cacheBunLock)).toBe(true);
	});

	it("treats the shared bun.lock as safe when Codex.json is missing (ENOENT)", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.cacheDir, { recursive: true });
		// Intentionally do not create Codex.json.
		writeFileSync(paths.cacheBunLock, "lock", "utf8");

		const code = await runUninstallCommand([], {
			log: () => {},
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(existsSync(paths.cacheBunLock)).toBe(false);
	});

	it("logs a warning and marks partial failure when launcher removal throws", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		const messages: string[] = [];

		const code = await runUninstallCommand(["--json"], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			removeLauncher: async () => {
				throw new Error("boom from launcher");
			},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		const warned = messages.some(
			(m) =>
				m.includes("launcher removal skipped") &&
				m.includes("boom from launcher"),
		);
		expect(warned).toBe(true);
		expect(code).toBe(1);
	});

	it("removes the shared bun.lock only when no other plugins remain", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		mkdirSync(paths.cacheDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);
		writeFileSync(paths.cacheBunLock, "lock", "utf8");

		const code = await runUninstallCommand([], {
			log: () => {},
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(existsSync(paths.cacheBunLock)).toBe(false);
	});

	it("warns and returns failure when --clear-accounts is set but no handler is wired", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);

		const messages: string[] = [];
		const code = await runUninstallCommand(["--clear-accounts", "--json"], {
			log: (m) => messages.push(m),
			unbind: async () => {},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
			// clearAccounts intentionally omitted
		});

		expect(code).toBe(1);
		expect(
			messages.some((m) => m.includes("--clear-accounts has no effect")),
		).toBe(true);
	});

	it("invokes clearAccounts when handler is provided", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		const clearAccounts = vi.fn().mockResolvedValue(undefined);

		const code = await runUninstallCommand(["--clear-accounts"], {
			log: () => {},
			unbind: async () => {},
			removeLauncher: async () => {},
			clearAccounts,
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(clearAccounts).toHaveBeenCalledTimes(1);
	});

	it("returns 1 with json=ok:false when a step fails", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const code = await runUninstallCommand(["--json"], {
			log: () => {},
			unbind: async () => {
				throw new Error("simulated unbind failure");
			},
			removeLauncher: async () => {},
			paths: {
				configPath: paths.configPath,
				cacheNodeModules: paths.cacheNodeModules,
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(1);
		const lastJson = logSpy.mock.calls.flat().pop() as string;
		const parsed = JSON.parse(lastJson);
		expect(parsed.ok).toBe(false);
		expect(parsed.warnings.some((w: string) => w.includes("simulated unbind failure"))).toBe(true);
	});
});
