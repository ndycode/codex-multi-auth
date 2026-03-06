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
		const userConfig = {
			global: {
				reasoningEffort: "medium",
				reasoningSummary: "auto",
				textVerbosity: "medium",
			},
			models: {
				"gpt-5.2": {
					variants: {
						high: {
							reasoningEffort: "high",
							reasoningSummary: "detailed",
							textVerbosity: "medium",
						},
					},
				},
			},
		};

		expect(mod.__buildModelCaseArgsForTests({ model: "gpt-5.2" }, 3, userConfig)).toEqual({
			token: "MODEL_MATRIX_OK_3",
			args: [
				"exec",
				"Reply with exactly MODEL_MATRIX_OK_3 and nothing else.",
				"--model",
				"gpt-5.2",
				"--json",
				"--skip-git-repo-check",
				"-c",
				'model_reasoning_effort="medium"',
				"-c",
				'model_reasoning_summary="auto"',
				"-c",
				'model_text_verbosity="medium"',
			],
		});

		expect(mod.__buildModelCaseArgsForTests({ model: "gpt-5.2-high", variant: "high" }, 4, userConfig)).toEqual({
			token: "MODEL_MATRIX_OK_4",
			args: [
				"exec",
				"Reply with exactly MODEL_MATRIX_OK_4 and nothing else.",
				"--model",
				"gpt-5.2",
				"--json",
				"--skip-git-repo-check",
				"-c",
				'model_reasoning_effort="high"',
				"-c",
				'model_reasoning_summary="detailed"',
				"-c",
				'model_text_verbosity="medium"',
			],
		});
	});

	it("derives scenario user config from codex config shape", async () => {
		const mod = await import("../scripts/codex-model-config.js");

		expect(
			mod.deriveUserConfigFromCodexConfig({
				provider: {
					openai: {
						options: { reasoningEffort: "medium" },
						models: {
							"gpt-5-codex": {
								options: { reasoningEffort: "high" },
							},
						},
					},
				},
			}),
		).toEqual({
			global: { reasoningEffort: "medium" },
			models: {
				"gpt-5-codex": {
					options: { reasoningEffort: "high" },
				},
			},
		});
	});

	it("normalizes alias models using nearest config when building CLI selections", async () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "matrix-model-config-"));
		try {
			writeFileSync(
				join(fixtureRoot, "Codex.json"),
				JSON.stringify(
					{
						provider: {
							openai: {
								models: {
									"gpt-5.2-high": {
										options: {
											reasoningEffort: "high",
											reasoningSummary: "detailed",
											textVerbosity: "medium",
										},
									},
								},
							},
						},
					},
					null,
					2,
				),
				"utf8",
			);
			const mod = await import("../scripts/codex-model-config.js");

			expect(mod.resolveCliModelSelection("gpt-5.2-high", { cwd: fixtureRoot })).toEqual({
				model: "gpt-5.2",
				configEntries: [
					{ key: "model_reasoning_effort", value: "high" },
					{ key: "model_reasoning_summary", value: "detailed" },
					{ key: "model_text_verbosity", value: "medium" },
				],
			});
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("preserves explicit CLI config when wrapper helper injects derived model options", async () => {
		const mod = await import("../scripts/codex-model-config.js");

		expect(mod.resolveCliModelSelection("gpt-5.1-high", {
			userConfig: {
				global: {},
				models: {
					"gpt-5.1": {
						variants: {
							high: {
								reasoningEffort: "high",
								reasoningSummary: "detailed",
								textVerbosity: "high",
							},
						},
					},
				},
			},
		})).toEqual({
			model: "gpt-5.1",
			configEntries: [
				{ key: "model_reasoning_effort", value: "high" },
				{ key: "model_reasoning_summary", value: "detailed" },
				{ key: "model_text_verbosity", value: "high" },
			],
		});
	});

	it("falls back to default timeout when CODEX_MATRIX_TIMEOUT_MS is invalid", async () => {
		vi.stubEnv("CODEX_MATRIX_TIMEOUT_MS", "abc");
		const mod = await import("../scripts/test-model-matrix.js");
		expect(mod.resolveMatrixTimeoutMs()).toBe(120000);
	});

	it("filters non-path where output on Windows", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({
				stdout: "INFO: noise\r\nC:\\Users\\neil\\AppData\\Roaming\\npm\\Codex.exe\r\n",
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
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		try {
			spawnSync.mockReturnValue({ stdout: "", stderr: "INFO: not found\n", status: 1 });

			const mod = await import("../scripts/test-model-matrix.js");
			expect(mod.resolveCodexExecutable()).toEqual({ command: "codex", shell: false });
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("serializes stopCodexServers calls and kills only tracked Windows PIDs", async () => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
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
