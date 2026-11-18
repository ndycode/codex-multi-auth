import { describe, expect, it, vi } from "vitest";
import {
	type CodexCliVersionDeps,
	detectInstalledCodexCliVersion,
	parseCodexCliVersion,
} from "../lib/codex-cli/version.js";

const asExecFile = (fn: unknown) => fn as CodexCliVersionDeps["execFile"];

describe("parseCodexCliVersion", () => {
	it.each([
		["codex-cli 0.160.1\n", "0.160.1"],
		["codex-cli 0.160.1 (build 7)\n", "0.160.1"],
		["  codex-cli 0.162.1\r\n", "0.162.1"],
		["codex-cli v0.160.1\n", "0.160.1"],
		["0.160.1\n", "0.160.1"],
	])("extracts the client version from %j", (output, expected) => {
		expect(parseCodexCliVersion(output)).toBe(expected);
	});

	it.each([
		"",
		"codex-cli\n",
		"no version here\n",
		"codex-cli not-a-version\n",
	])("returns null for unversioned output %j", (output) => {
		expect(parseCodexCliVersion(output)).toBeNull();
	});
});

describe("detectInstalledCodexCliVersion", () => {
	it("runs --version on the resolved binary and parses stdout", async () => {
		const execFile = vi.fn(async () => ({ stdout: "codex-cli 0.160.1\n" }));
		const version = await detectInstalledCodexCliVersion({
			resolveBin: async () => ({ path: "/opt/codex/codex.exe", launchWithNode: false }),
			execFile: asExecFile(execFile),
		});
		expect(version).toBe("0.160.1");
		expect(execFile).toHaveBeenCalledWith(
			"/opt/codex/codex.exe",
			["--version"],
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
	});

	it("launches script shims through the running node binary", async () => {
		const execFile = vi.fn(async () => ({ stdout: "codex-cli 0.160.1\n" }));
		await detectInstalledCodexCliVersion({
			resolveBin: async () => ({
				path: "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
				launchWithNode: true,
			}),
			execFile: asExecFile(execFile),
		});
		expect(execFile).toHaveBeenCalledWith(
			process.execPath,
			["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "--version"],
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
	});

	it("returns null when no codex binary resolves", async () => {
		const execFile = vi.fn();
		expect(
			await detectInstalledCodexCliVersion({
				resolveBin: async () => null,
				execFile: asExecFile(execFile),
			}),
		).toBeNull();
		expect(execFile).not.toHaveBeenCalled();
	});

	it("returns null when --version fails or prints nothing usable", async () => {
		expect(
			await detectInstalledCodexCliVersion({
				resolveBin: async () => ({ path: "/bin/codex", launchWithNode: false }),
				execFile: asExecFile(async () => {
					throw new Error("spawn failed");
				}),
			}),
		).toBeNull();
		expect(
			await detectInstalledCodexCliVersion({
				resolveBin: async () => ({ path: "/bin/codex", launchWithNode: false }),
				execFile: asExecFile(async () => ({ stdout: "codex-cli\n" })),
			}),
		).toBeNull();
	});
});
