import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	normalizePluginList,
	resolveInstallPaths,
} from "../scripts/install-codex-auth-utils.js";

const scriptPath = "scripts/install-codex-auth.js";
const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

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
});
