import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPreuninstallCleanup } from "../scripts/preuninstall.js";
import { resolveInstallPaths } from "../scripts/install-codex-auth-utils.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let injectPreuninstallEbusyOnNextRm = false;

vi.mock("node:fs/promises", async () => {
	const actual: typeof import("node:fs/promises") = await vi.importActual(
		"node:fs/promises",
	);
	return {
		...actual,
		rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
			if (injectPreuninstallEbusyOnNextRm) {
				injectPreuninstallEbusyOnNextRm = false;
				const error = Object.assign(new Error("EBUSY: cache is busy"), {
					code: "EBUSY",
				});
				throw error;
			}
			return actual.rm(...args);
		}),
	};
});

const tempRoots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	injectPreuninstallEbusyOnNextRm = false;
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) await removeWithRetry(root, { recursive: true, force: true });
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

// Use the production path resolver so the tests cannot drift from real
// install/uninstall behavior.
function resolveTempPaths(home: string) {
	return resolveInstallPaths(process.platform, envFor(home), home);
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
				return { bunLockState: "uncertain" as const };
			},
			clearCache: async () => {
				calls.push("CACHE_CALLED");
			},
		});

		expect(code).toBe(0);
		expect(calls).toEqual([]);
	});

	it("removes current and legacy caches with transient retryable failures", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		mkdirSync(paths.cacheNodeModules, { recursive: true });
		mkdirSync(paths.cacheLegacyNodeModules, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);
		writeFileSync(path.join(paths.cacheNodeModules, "current.txt"), "current", "utf8");
		writeFileSync(
			path.join(paths.cacheLegacyNodeModules, "legacy.txt"),
			"legacy",
			"utf8",
		);

		injectPreuninstallEbusyOnNextRm = true;
		const code = await runPreuninstallCleanup({
			env,
			home,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
		});

		expect(code).toBe(0);
		expect(injectPreuninstallEbusyOnNextRm).toBe(false);
		expect(existsSync(paths.cacheNodeModules)).toBe(false);
		expect(existsSync(paths.cacheLegacyNodeModules)).toBe(false);
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

	it("treats bun.lock as uncertain when Codex.json is corrupt (parse error)", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		// Intentionally invalid JSON.
		writeFileSync(paths.configPath, "{ this is not valid json", "utf8");

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
		expect(observed.bunLockSafe).toBe(false);
	});

	it("treats bun.lock as uncertain when Codex.json has no plugins array", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ otherField: 123 }, null, "\t") + "\n",
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
		expect(observed.bunLockSafe).toBe(false);
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

	it("dry-run computes bunLockSafe from real Codex.json (sole plugin → safe)", async () => {
		// Regression: previously dry-run skipped the Codex.json read so
		// bunLockState stayed "uncertain" and clearCache was always called
		// with bunLockSafe=false during preview.
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth"] }, null, "\t") + "\n",
			"utf8",
		);

		const observed = { bunLockSafe: false as boolean };
		const code = await runPreuninstallCleanup({
			env,
			dryRun: true,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
			clearCache: async (_dryRun, _log, bunLockSafe) => {
				observed.bunLockSafe = bunLockSafe;
			},
		});

		expect(code).toBe(0);
		expect(observed.bunLockSafe).toBe(true);
		// Codex.json itself remains untouched.
		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(config.plugins).toEqual(["codex-multi-auth"]);
	});

	it("concurrent invocations leave Codex.json valid and free of codex-multi-auth", async () => {
		// Two npm processes upgrading/uninstalling in parallel can race on the
		// Codex.json read-modify-write. Both invocations must end with a valid
		// JSON file that does not contain codex-multi-auth.
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth", "other"] }, null, "\t") +
				"\n",
			"utf8",
		);

		const opts = {
			env,
			home,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
			clearCache: async () => {},
		};
		const [a, b] = await Promise.all([
			runPreuninstallCleanup(opts),
			runPreuninstallCleanup(opts),
		]);
		expect(a).toBe(0);
		expect(b).toBe(0);

		const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
		expect(Array.isArray(config.plugins)).toBe(true);
		expect(config.plugins).not.toContain("codex-multi-auth");
		expect(config.plugins).toContain("other");
	});

	it("dry-run reports bunLockSafe=false when other plugins remain", async () => {
		const home = makeTempHome();
		const env = envFor(home);
		const paths = resolveTempPaths(home);
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			paths.configPath,
			JSON.stringify({ plugins: ["codex-multi-auth", "other"] }, null, "\t") +
				"\n",
			"utf8",
		);

		const observed = { bunLockSafe: true as boolean };
		const code = await runPreuninstallCleanup({
			env,
			dryRun: true,
			log: () => {},
			unbindCodexApp: async () => {},
			removeLauncher: async () => {},
			clearCache: async (_dryRun, _log, bunLockSafe) => {
				observed.bunLockSafe = bunLockSafe;
			},
		});

		expect(code).toBe(0);
		expect(observed.bunLockSafe).toBe(false);
	});
});
