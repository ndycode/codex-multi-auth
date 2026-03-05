import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../lib/utils.js";

const createdDirs: string[] = [];
const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRootDir = join(testFileDir, "..");

function isRetriableFsError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const { code } = error as { code?: unknown };
	return code === "EBUSY" || code === "EPERM";
}

async function removeDirectoryWithRetry(dir: string): Promise<void> {
	const backoffMs = [20, 60, 120];
	let lastError: unknown;
	for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			if (!isRetriableFsError(error) || attempt === backoffMs.length) {
				break;
			}
			await sleep(backoffMs[attempt]);
		}
	}
	throw lastError;
}

function createWrapperFixture(): string {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-wrapper-fixture-"));
	createdDirs.push(fixtureRoot);
	const scriptDir = join(fixtureRoot, "scripts");
	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(join(repoRootDir, "scripts", "codex.js"), join(scriptDir, "codex.js"));
	copyFileSync(join(repoRootDir, "scripts", "codex-routing.js"), join(scriptDir, "codex-routing.js"));
	return fixtureRoot;
}

function createFakeCodexBin(rootDir: string): string {
	const fakeBin = join(rootDir, "fake-codex.js");
	writeFileSync(
		fakeBin,
		[
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(0);",
		].join("\n"),
		"utf8",
	);
	return fakeBin;
}

function runWrapper(
	fixtureRoot: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return runNodeScript(join(fixtureRoot, "scripts", "codex.js"), args, extraEnv);
}

function runWrapperScript(
	scriptPath: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return runNodeScript(scriptPath, args, extraEnv);
}

function runNodeScript(
	scriptPath: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			...extraEnv,
		},
	});
}

type WrapperAsyncResult = {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

function runWrapperAsync(
	fixtureRoot: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): Promise<WrapperAsyncResult> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[join(fixtureRoot, "scripts", "codex.js"), ...args],
			{
				env: {
					...process.env,
					...extraEnv,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.once("error", (error) => {
			resolve({
				status: 1,
				signal: null,
				stdout,
				stderr: `${stderr}\n${String(error)}`.trim(),
			});
		});

		child.once("close", (status, signal) => {
			resolve({
				status,
				signal,
				stdout,
				stderr,
			});
		});
	});
}

function combinedOutput(result: SpawnSyncReturns<string> | WrapperAsyncResult): string {
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

afterEach(async () => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		await removeDirectoryWithRetry(dir);
	}
});

describe("codex bin wrapper", () => {
	it("prints actionable message for auth commands when dist output is missing", () => {
		const fixtureRoot = createWrapperFixture();
		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(1);
		expect(output).toContain("auth commands require built runtime files");
		expect(output).toContain("Run: npm run build");
		expect(output).not.toContain("Cannot find module");
	});

	it("forwards non-auth commands when dist output is missing", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["--version"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:--version");
	});

	it.skipIf(process.platform !== "win32")("installs Windows codex shell guards to survive shim takeover", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const shimDir = join(fixtureRoot, "shim-bin");
		mkdirSync(shimDir, { recursive: true });
		writeFileSync(
			join(shimDir, "codex-multi-auth.cmd"),
			"@ECHO OFF\r\nREM fixture codex-multi-auth shim\r\n",
			"utf8",
		);
		writeFileSync(
			join(shimDir, "codex.cmd"),
			'@ECHO OFF\r\necho "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js"\r\n',
			"utf8",
		);
		writeFileSync(
			join(shimDir, "codex.ps1"),
			'Write-Output "$basedir/node_modules/@openai/codex/bin/codex.js"' + "\r\n",
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["--version"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD: "1",
			PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
			USERPROFILE: fixtureRoot,
			HOME: fixtureRoot,
		});
		expect(result.status).toBe(0);

		const codexBatchPath = join(shimDir, "codex.bat");
		expect(readFileSync(codexBatchPath, "utf8")).toContain(
			"codex-multi-auth windows shim guardian v1",
		);
		const codexCmdPath = join(shimDir, "codex.cmd");
		expect(readFileSync(codexCmdPath, "utf8")).toContain(
			"codex-multi-auth windows shim guardian v1",
		);
		expect(readFileSync(codexCmdPath, "utf8")).toContain(
			"node_modules\\codex-multi-auth\\scripts\\codex.js",
		);
		const codexPs1Path = join(shimDir, "codex.ps1");
		expect(readFileSync(codexPs1Path, "utf8")).toContain(
			"codex-multi-auth windows shim guardian v1",
		);
		expect(readFileSync(codexPs1Path, "utf8")).toContain(
			"node_modules/codex-multi-auth/scripts/codex.js",
		);
		const pwshProfilePath = join(
			fixtureRoot,
			"Documents",
			"PowerShell",
			"Microsoft.PowerShell_profile.ps1",
		);
		expect(readFileSync(pwshProfilePath, "utf8")).toContain(
			"# >>> codex-multi-auth shell guard >>>",
		);
		expect(readFileSync(pwshProfilePath, "utf8")).toContain("CodexMultiAuthShim");
	});

	it.skipIf(process.platform !== "win32")("prefers invocation-derived shim directory over PATH-decoy shim entries", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "codex-wrapper-invoke-fixture-"));
		createdDirs.push(fixtureRoot);
		const globalShimDir = join(fixtureRoot, "global-bin");
		const scriptDir = join(globalShimDir, "node_modules", "codex-multi-auth", "scripts");
		mkdirSync(scriptDir, { recursive: true });
		copyFileSync(join(repoRootDir, "scripts", "codex.js"), join(scriptDir, "codex.js"));
		copyFileSync(join(repoRootDir, "scripts", "codex-routing.js"), join(scriptDir, "codex-routing.js"));
		writeFileSync(
			join(globalShimDir, "codex-multi-auth.cmd"),
			"@ECHO OFF\r\nREM real shim\r\n",
			"utf8",
		);
		const decoyShimDir = join(fixtureRoot, "decoy-bin");
		mkdirSync(decoyShimDir, { recursive: true });
		writeFileSync(
			join(decoyShimDir, "codex-multi-auth.cmd"),
			"@ECHO OFF\r\nREM decoy shim\r\n",
			"utf8",
		);
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const scriptPath = join(scriptDir, "codex.js");
		const result = runWrapperScript(scriptPath, ["--version"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			PATH: `${decoyShimDir}${delimiter}${globalShimDir}${delimiter}${process.env.PATH ?? ""}`,
			USERPROFILE: fixtureRoot,
			HOME: fixtureRoot,
		});
		expect(result.status).toBe(0);
		expect(readFileSync(join(globalShimDir, "codex.bat"), "utf8")).toContain(
			"codex-multi-auth windows shim guardian v1",
		);
		expect(() => readFileSync(join(decoyShimDir, "codex.bat"), "utf8")).toThrow();
	});

	it("honors bypass for auth commands and forwards to the real CLI", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:auth status");
	});

	it("surfaces non-module-not-found loader failures", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			'throw new Error("dist-load-marker-001");\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
		});
		const output = combinedOutput(result);

		expect(result.status).toBe(1);
		expect(output).toContain("codex-multi-auth runner failed:");
		expect(output).toContain("dist-load-marker-001");
	});

	it("treats invalid multi-auth exit codes as failure", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli() {",
				"\treturn undefined;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
		});
		const output = combinedOutput(result);

		expect(result.status).toBe(1);
		expect(output).not.toContain("codex-multi-auth runner failed:");
	});

	it("propagates numeric-string multi-auth exit codes", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli() {",
				'\treturn "7";',
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_BYPASS: "",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
		});
		expect(result.status).toBe(7);
	});

	it("prints actionable guidance when real codex bin cannot be found", () => {
		const fixtureRoot = createWrapperFixture();
		const missingOverride = join(fixtureRoot, "missing", "codex.js");
		const result = runWrapper(
			fixtureRoot,
			["--version"],
			{
				CODEX_MULTI_AUTH_BYPASS: "",
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: missingOverride,
			},
		);
		const output = combinedOutput(result);

		expect(result.status).toBe(1);
		expect(output).toContain(`CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: ${missingOverride}`);
		expect(output).toContain("Could not locate the official Codex CLI binary");
		expect(output).toContain("Install it globally: npm install -g @openai/codex");
	});

	it("handles concurrent wrapper invocations without module-load regressions", async () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const runs = Array.from({ length: 10 }, (_unused, index) => {
			if (index % 3 === 0) {
				return {
					kind: "auth-bypass" as const,
					promise: runWrapperAsync(fixtureRoot, ["auth", "status"], {
						CODEX_MULTI_AUTH_BYPASS: "1",
						CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
					}),
				};
			}
			if (index % 2 === 0) {
				return {
					kind: "auth-missing-dist" as const,
					promise: runWrapperAsync(fixtureRoot, ["auth", "status"], {
						CODEX_MULTI_AUTH_BYPASS: "",
						CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
					}),
				};
			}
			return {
				kind: "non-auth-forward" as const,
				promise: runWrapperAsync(fixtureRoot, ["--version"], {
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				}),
			};
		});
		const results = await Promise.all(runs.map((run) => run.promise));

		for (let i = 0; i < runs.length; i += 1) {
			const output = combinedOutput(results[i]);
			expect(output).not.toContain("Cannot find module");
			expect(output).not.toContain("runCodexMultiAuthCli is not a function");
			expect(output).not.toContain("SyntaxError");
			if (runs[i].kind === "auth-bypass") {
				expect(results[i].status).toBe(0);
				expect(output).toContain("FORWARDED:auth status");
				continue;
			}
			if (runs[i].kind === "auth-missing-dist") {
				expect(results[i].status).toBe(1);
				expect(output).toContain("auth commands require built runtime files");
				expect(output).toContain("Run: npm run build");
				continue;
			}
			expect(results[i].status).toBe(0);
			expect(output).toContain("FORWARDED:--version");
		}
	});
});
