import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync,
}));

describe("test-model-matrix script helpers", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses CODEX_BIN override and detects .cmd shell mode", async () => {
		spawnSync.mockReturnValue({ stdout: "", stderr: "", status: 0 });
		vi.stubEnv("CODEX_BIN", "C:\\Tools\\Codex.cmd");

		const mod = await import("../scripts/test-model-matrix.js");
		expect(mod.resolveCodexExecutable()).toEqual({
			command: "C:\\Tools\\Codex.cmd",
			shell: true,
		});
	});

	it("resolves CODEX_BIN .cmd wrapper to node + script entry when available", async () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "matrix-cmd-wrapper-"));
		try {
			const scriptPath = join(
				fixtureRoot,
				"node_modules",
				"codex-multi-auth",
				"scripts",
				"codex.js",
			);
			mkdirSync(dirname(scriptPath), { recursive: true });
			writeFileSync(scriptPath, "#!/usr/bin/env node\n", "utf8");

			const cmdPath = join(fixtureRoot, "Codex.cmd");
			writeFileSync(
				cmdPath,
				[
					"@ECHO off",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\codex-multi-auth\\scripts\\codex.js" %*',
				].join("\r\n"),
				"utf8",
			);
			vi.stubEnv("CODEX_BIN", cmdPath);

			const mod = await import("../scripts/test-model-matrix.js");
			expect(mod.resolveCodexExecutable()).toEqual({
				command: process.execPath,
				shell: false,
				prefixArgs: [scriptPath],
				displayCommand: cmdPath,
			});
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("falls back to shell mode when .cmd wrapper cannot be parsed", async () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "matrix-cmd-fallback-"));
		try {
			const cmdPath = join(fixtureRoot, "Codex.cmd");
			writeFileSync(
				cmdPath,
				[
					"@ECHO off",
					"REM deliberately no %dp0% JS wrapper path for parser",
					"echo hello",
				].join("\r\n"),
				"utf8",
			);
			vi.stubEnv("CODEX_BIN", cmdPath);

			const mod = await import("../scripts/test-model-matrix.js");
			expect(mod.resolveCodexExecutable()).toEqual({
				command: cmdPath,
				shell: true,
			});
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("builds matrix exec args with JSON + git-check skip and optional variant config", async () => {
		const mod = await import("../scripts/test-model-matrix.js");

		expect(mod.__buildModelCaseArgsForTests({ model: "gpt-5.2" }, 3)).toEqual({
			token: "MODEL_MATRIX_OK_3",
			args: [
				"exec",
				"MODEL_MATRIX_OK_3",
				"--model",
				"gpt-5.2",
				"--json",
				"--skip-git-repo-check",
			],
		});

		expect(
			mod.__buildModelCaseArgsForTests(
				{ model: "gpt-5.2", variant: "high" },
				4,
			),
		).toEqual({
			token: "MODEL_MATRIX_OK_4",
			args: [
				"exec",
				"MODEL_MATRIX_OK_4",
				"--model",
				"gpt-5.2",
				"--json",
				"--skip-git-repo-check",
				"-c",
				'model_reasoning_effort="high"',
			],
		});
	});

	it("falls back to default timeout when CODEX_MATRIX_TIMEOUT_MS is invalid", async () => {
		vi.stubEnv("CODEX_MATRIX_TIMEOUT_MS", "abc");
		const mod = await import("../scripts/test-model-matrix.js");
		expect(mod.resolveMatrixTimeoutMs()).toBe(120000);
		expect(mod.resolveMatrixTimeoutMs(true)).toBe(15000);
	});

	it("treats completed JSON turns as success even when the prompt token is absent", async () => {
		const mod = await import("../scripts/test-model-matrix.js");
		expect(
			mod.__finalizeModelCaseResultForTests(
				{ model: "gpt-5.1-codex-max", variant: "high" },
				0,
				'{"type":"thread.started"}\n{"type":"turn.completed"}',
				"MODEL_MATRIX_OK_9",
				true,
			),
		).toEqual(
			expect.objectContaining({
				ok: true,
				hasToken: false,
				completed: true,
				skipped: false,
			}),
		);
	});

	it("downgrades unsupported smoke failures to skipped cases", async () => {
		const mod = await import("../scripts/test-model-matrix.js");
		expect(
			mod.__finalizeModelCaseResultForTests(
				{ model: "gpt-5-codex" },
				1,
				"{\"type\":\"turn.failed\",\"error\":{\"message\":\"Unsupported value: 'xhigh' is not supported with the 'gpt-5-codex' model. Supported values are: 'low', 'medium', and 'high'.\"}}",
				"MODEL_MATRIX_OK_10",
				true,
			),
		).toEqual(
			expect.objectContaining({
				ok: false,
				skipped: true,
				skipReason: "unsupported-reasoning",
			}),
		);

		expect(
			mod.__finalizeModelCaseResultForTests(
				{ model: "gpt-5.2" },
				124,
				"Timed out after 15000ms",
				"MODEL_MATRIX_OK_11",
				true,
			),
		).toEqual(
			expect.objectContaining({
				ok: false,
				skipped: true,
				skipReason: "timed-out",
			}),
		);
	});

	it("filters non-path where output on Windows", async () => {
		const platformSpy = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({
				stdout:
					"INFO: noise\r\nC:\\Users\\neil\\AppData\\Roaming\\npm\\Codex.exe\r\n",
				stderr: "INFO: Could not find files\r\n",
				status: 0,
			});

			const mod = await import("../scripts/test-model-matrix.js");
			expect(mod.resolveCodexExecutable()).toEqual({
				command: "C:\\Users\\neil\\AppData\\Roaming\\npm\\Codex.exe",
				shell: false,
			});
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("returns fallback command when where has no executable candidates", async () => {
		const platformSpy = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({
				stdout: "",
				stderr: "INFO: not found\n",
				status: 1,
			});

			const mod = await import("../scripts/test-model-matrix.js");
			expect(mod.resolveCodexExecutable()).toEqual({
				command: "codex",
				shell: false,
			});
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("serializes stopCodexServers calls and kills only tracked Windows PIDs", async () => {
		const platformSpy = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

			const mod = await import("../scripts/test-model-matrix.js");
			mod.__resetTrackedCodexPidsForTests();
			mod.registerSpawnedCodex(1001);
			mod.registerSpawnedCodex(2002);
			spawnSync.mockClear();

			await Promise.all([mod.stopCodexServers(), mod.stopCodexServers()]);

			expect(spawnSync).toHaveBeenCalledTimes(2);
			expect(spawnSync).toHaveBeenNthCalledWith(
				1,
				"taskkill",
				["/F", "/T", "/PID", "1001"],
				expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
			);
			expect(spawnSync).toHaveBeenNthCalledWith(
				2,
				"taskkill",
				["/F", "/T", "/PID", "2002"],
				expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
			);
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("serializes stopCodexServers calls and kills only tracked non-Windows PIDs", async () => {
		const platformSpy = vi
			.spyOn(process, "platform", "get")
			.mockReturnValue("linux");
		try {
			spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

			const mod = await import("../scripts/test-model-matrix.js");
			mod.__resetTrackedCodexPidsForTests();
			mod.registerSpawnedCodex(3003);
			mod.registerSpawnedCodex(4004);
			spawnSync.mockClear();

			await Promise.all([mod.stopCodexServers(), mod.stopCodexServers()]);

			expect(spawnSync).toHaveBeenCalledTimes(2);
			expect(spawnSync).toHaveBeenNthCalledWith(
				1,
				"kill",
				["-9", "3003"],
				expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
			);
			expect(spawnSync).toHaveBeenNthCalledWith(
				2,
				"kill",
				["-9", "4004"],
				expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
			);
		} finally {
			platformSpy.mockRestore();
		}
	});
});
