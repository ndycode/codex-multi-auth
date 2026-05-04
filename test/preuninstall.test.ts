import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPreuninstallCleanup } from "../scripts/preuninstall.js";

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

function makeTempHome(): string {
	const root = mkdtempSync(path.join(tmpdir(), "preuninstall-"));
	tempRoots.push(root);
	return root;
}

function envFor(home: string): NodeJS.ProcessEnv {
	const isWindows = process.platform === "win32";
	const appData = path.join(home, "AppData", "Roaming");
	const localAppData = path.join(home, "AppData", "Local");
	return {
		HOME: home,
		USERPROFILE: home,
		APPDATA: isWindows ? appData : "",
		LOCALAPPDATA: isWindows ? localAppData : "",
		// Defeat CI detection so the cleanup actually runs.
		CI: "",
		GITHUB_ACTIONS: "",
	};
}

function resolveTempPaths(home: string) {
	const isWindows = process.platform === "win32";
	const configBase = isWindows ? path.join(home, "AppData", "Roaming") : path.join(home, ".config");
	const cacheBase = isWindows ? path.join(home, "AppData", "Local") : path.join(home, ".cache");
	const configDir = path.join(configBase, "Codex");
	const cacheDir = path.join(cacheBase, "Codex");
	return {
		configDir,
		configPath: path.join(configDir, "Codex.json"),
		cacheDir,
		cacheBunLock: path.join(cacheDir, "bun.lock"),
	};
}

describe("runPreuninstallCleanup", () => {
	it("returns 0 immediately when CI is detected", async () => {
		const calls: string[] = [];
		const code = await runPreuninstallCleanup({
			env: { CI: "true" },
			log: (m) => calls.push(m),
			unbindCodexApp: async () => {
				calls.push("UNBIND_CALLED");
			},
			removeLauncher: async () => {
				calls.push("LAUNCHER_CALLED");
			},
			removePluginFromConfig: async () => {
				calls.push("CONFIG_CALLED");
				return { pluginsRemaining: null };
			},
			clearCache: async () => {
				calls.push("CACHE_CALLED");
			},
		});

		expect(code).toBe(0);
		expect(calls).toEqual([]);
	});

	it("preserves bun.lock when other plugins remain after removal", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		mkdirSync(paths.cacheDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify(
				{ plugins: ["codex-multi-auth", "other"] },
				null,
				"\t",
			) + "\n",
			"utf8",
		);
		writeFileSync(paths.cacheBunLock, "lock", "utf8");

		const removedBunLock = vi.fn();
		const code = await runPreuninstallCleanup({
			env,
			home,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
			// Use real removePluginFromConfig (default) by leaving it undefined.
			clearCache: async (_dryRun, _log, bunLockSafe) => {
				if (bunLockSafe) removedBunLock();
			},
		});

		expect(code).toBe(0);
		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(config.plugins).toEqual(["other"]);
		expect(removedBunLock).not.toHaveBeenCalled();
		expect(existsSync(paths.cacheBunLock)).toBe(true);
	});

	it("treats bun.lock as safe to remove when only this plugin was installed", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);

		const observed: { bunLockSafe: boolean | null } = { bunLockSafe: null };
		const code = await runPreuninstallCleanup({
			env,
			home,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
			clearCache: async (_dryRun, _log, bunLockSafe) => {
				observed.bunLockSafe = bunLockSafe;
			},
		});

		expect(code).toBe(0);
		expect(observed.bunLockSafe).toBe(true);
	});

	it("treats bun.lock as safe when Codex.json is missing (nothing to protect)", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		// Intentionally do not create configDir.

		const observed: { bunLockSafe: boolean | null } = { bunLockSafe: null };
		const code = await runPreuninstallCleanup({
			env,
			home,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
			clearCache: async (_dryRun, _log, bunLockSafe) => {
				observed.bunLockSafe = bunLockSafe;
			},
		});

		expect(code).toBe(0);
		expect(observed.bunLockSafe).toBe(true);
	});

	it("dry-run does not modify Codex.json", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify(
				{ plugins: ["codex-multi-auth", "other"] },
				null,
				"\t",
			) + "\n",
			"utf8",
		);

		const code = await runPreuninstallCleanup({
			env,
			dryRun: true,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
			clearCache: async () => {},
		});

		expect(code).toBe(0);
		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(config.plugins).toEqual(["codex-multi-auth", "other"]);
	});
});
