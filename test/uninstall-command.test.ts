import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	parseUninstallArgs,
	removePluginFromList,
	resolveUninstallPaths,
	runUninstallCommand,
} from "../lib/codex-manager/commands/uninstall.js";

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

function makeTempHome(): string {
	const root = mkdtempSync(path.join(tmpdir(), "uninstall-cmd-"));
	tempRoots.push(root);
	return root;
}

function pathsForTempHome(home: string) {
	const isWindows = process.platform === "win32";
	const configBase = isWindows ? path.join(home, "AppData", "Roaming") : path.join(home, ".config");
	const cacheBase = isWindows ? path.join(home, "AppData", "Local") : path.join(home, ".cache");
	const configDir = path.join(configBase, "Codex");
	const cacheDir = path.join(cacheBase, "Codex");
	return {
		configPath: path.join(configDir, "Codex.json"),
		cacheNodeModules: path.join(cacheDir, "node_modules", "codex-multi-auth"),
		cacheBunLock: path.join(cacheDir, "bun.lock"),
		configDir,
		cacheDir,
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
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		expect(existsSync(paths.configPath)).toBe(true);
		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(config.plugins).toContain("codex-multi-auth");
		expect(messages.some((m) => m.includes("[dry-run]"))).toBe(true);
	});

	it("removes plugin entry from Codex.json and clears node_modules cache", async () => {
		const home = makeTempHome();
		const paths = pathsForTempHome(home);
		mkdirSync(paths.configDir, { recursive: true });
		mkdirSync(paths.cacheNodeModules, { recursive: true });
		writeFileSync(
			path.join(paths.cacheNodeModules, "marker.txt"),
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
				cacheBunLock: paths.cacheBunLock,
			},
		});

		expect(code).toBe(0);
		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(config.plugins).toEqual(["other-plugin"]);
		expect(existsSync(paths.cacheNodeModules)).toBe(false);
		// Other plugins still installed → shared bun.lock must be preserved.
		expect(existsSync(paths.cacheBunLock)).toBe(true);
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
