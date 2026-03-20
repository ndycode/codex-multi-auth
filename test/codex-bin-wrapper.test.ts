import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	copyFileSync(
		join(repoRootDir, "scripts", "codex.js"),
		join(scriptDir, "codex.js"),
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex-routing.js"),
		join(scriptDir, "codex-routing.js"),
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex-supervisor.js"),
		join(scriptDir, "codex-supervisor.js"),
	);
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

function createCustomFakeCodexBin(rootDir: string, lines: string[]): string {
	const fakeBin = join(rootDir, `fake-codex-${createdDirs.length}.js`);
	writeFileSync(fakeBin, lines.join("\n"), "utf8");
	return fakeBin;
}

function createSupervisorRuntimeFixture(
	rootDir: string,
	options: {
		configLines?: string[];
		accountManagerLines?: string[];
		quotaProbeLines?: string[];
		storageLines?: string[];
	},
): void {
	const distLibDir = join(rootDir, "dist", "lib");
	mkdirSync(distLibDir, { recursive: true });
	writeFileSync(
		join(distLibDir, "config.js"),
		(options.configLines ?? [
			"export function loadPluginConfig() {",
			"\treturn {",
			"\t\tcodexCliSessionSupervisor: true,",
			"\t\tretryAllAccountsRateLimited: true,",
			"\t\tpreemptiveQuotaEnabled: true,",
			"\t\tpreemptiveQuotaRemainingPercent5h: 10,",
			"\t\tpreemptiveQuotaRemainingPercent7d: 10,",
			"\t};",
			"}",
			"export function getCodexCliSessionSupervisor(pluginConfig) {",
			"\treturn pluginConfig.codexCliSessionSupervisor !== false;",
			"}",
			"export function getRetryAllAccountsRateLimited(pluginConfig) {",
			"\treturn pluginConfig.retryAllAccountsRateLimited !== false;",
			"}",
			"export function getPreemptiveQuotaEnabled(pluginConfig) {",
			"\treturn pluginConfig.preemptiveQuotaEnabled !== false;",
			"}",
			"export function getPreemptiveQuotaRemainingPercent5h(pluginConfig) {",
			"\treturn pluginConfig.preemptiveQuotaRemainingPercent5h ?? 10;",
			"}",
			"export function getPreemptiveQuotaRemainingPercent7d(pluginConfig) {",
			"\treturn pluginConfig.preemptiveQuotaRemainingPercent7d ?? 10;",
			"}",
		]).join("\n"),
		"utf8",
	);
	writeFileSync(
		join(distLibDir, "accounts.js"),
		(options.accountManagerLines ?? []).join("\n"),
		"utf8",
	);
	writeFileSync(
		join(distLibDir, "quota-probe.js"),
		(options.quotaProbeLines ?? []).join("\n"),
		"utf8",
	);
	writeFileSync(
		join(distLibDir, "storage.js"),
		(options.storageLines ?? [
			"export function getStoragePath() {",
			"\treturn process.env.TEST_STORAGE_PATH ?? '/test-fixture/openai-codex-accounts.json';",
			"}",
		]).join("\n"),
		"utf8",
	);
}

function createZeroAccountSupervisorRuntimeFixture(rootDir: string): void {
	createSupervisorRuntimeFixture(rootDir, {
		accountManagerLines: [
			"export class AccountManager {",
			"\tconstructor() {}",
			"\tstatic async loadFromDisk() {",
			"\t\treturn new AccountManager();",
			"\t}",
			"\tgetCurrentAccountForFamily() {",
			"\t\treturn null;",
			"\t}",
			"\tgetCurrentOrNextForFamilyHybrid() {",
			"\t\treturn null;",
			"\t}",
			"\tgetMinWaitTimeForFamily() {",
			"\t\treturn 0;",
			"\t}",
			"}",
		],
		quotaProbeLines: [
			"export async function fetchCodexQuotaSnapshot() {",
			"\tthrow new Error('quota probe should not run');",
			"}",
		],
	});
}

function runWrapper(
	fixtureRoot: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[join(fixtureRoot, "scripts", "codex.js"), ...args],
		{
			encoding: "utf8",
			env: {
				...process.env,
				...extraEnv,
			},
		},
	);
}

function runWrapperScript(
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

function combinedOutput(
	result: SpawnSyncReturns<string> | WrapperAsyncResult,
): string {
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

	it("forwards help flags without requiring accounts when supervisor is enabled", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		createZeroAccountSupervisorRuntimeFixture(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["--help"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:--help");
		expect(combinedOutput(result)).not.toContain(
			"no launchable account is currently available",
		);
	});

	it("forwards bypassed auth login commands without requiring accounts", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		createZeroAccountSupervisorRuntimeFixture(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["auth", "login"], {
			CODEX_MULTI_AUTH_BYPASS: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:auth login");
		expect(combinedOutput(result)).not.toContain(
			"no launchable account is currently available",
		);
	});

	it("still blocks quota-consuming commands when no launchable account exists", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		createZeroAccountSupervisorRuntimeFixture(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(1);
		expect(combinedOutput(result)).toContain(
			"no launchable account is currently available",
		);
	});

	it("injects file auth store forwarding for wrapped real cli invocations by default", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec status -c cli_auth_credentials_store="file"',
		);
	});

	it("skips file auth store forwarding when the opt-out env var is disabled", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE: "0",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(result.stdout).not.toContain('cli_auth_credentials_store="file"');
	});

	it("does not double-inject file auth store when caller already set it", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "-c", 'cli_auth_credentials_store="keychain"'],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec status -c cli_auth_credentials_store="keychain"',
		);
		expect(
			result.stdout.match(/cli_auth_credentials_store=/g) ?? [],
		).toHaveLength(1);
	});

	it("propagates downstream file-store write errors from forwarded wrapper execution", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"const forwarded = process.argv.slice(2);",
			"if (!forwarded.includes('cli_auth_credentials_store=\"file\"')) process.exit(99);",
			'process.stderr.write("EPERM: locked auth store\\n");',
			"process.exit(13);",
		]);
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(13);
		expect(combinedOutput(result)).toContain("EPERM: locked auth store");
	});

	it.skipIf(process.platform !== "win32")(
		"installs Windows codex shell guards to survive shim takeover",
		() => {
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
				'Write-Output "$basedir/node_modules/@openai/codex/bin/codex.js"' +
					"\r\n",
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
			expect(readFileSync(pwshProfilePath, "utf8")).toContain(
				"CodexMultiAuthShim",
			);
		},
	);

	it.skipIf(process.platform !== "win32")(
		"prefers invocation-derived shim directory over PATH-decoy shim entries",
		() => {
			const fixtureRoot = mkdtempSync(
				join(tmpdir(), "codex-wrapper-invoke-fixture-"),
			);
			createdDirs.push(fixtureRoot);
			const globalShimDir = join(fixtureRoot, "global-bin");
			const scriptDir = join(
				globalShimDir,
				"node_modules",
				"codex-multi-auth",
				"scripts",
			);
			mkdirSync(scriptDir, { recursive: true });
			copyFileSync(
				join(repoRootDir, "scripts", "codex.js"),
				join(scriptDir, "codex.js"),
			);
			copyFileSync(
				join(repoRootDir, "scripts", "codex-routing.js"),
				join(scriptDir, "codex-routing.js"),
			);
			copyFileSync(
				join(repoRootDir, "scripts", "codex-supervisor.js"),
				join(scriptDir, "codex-supervisor.js"),
			);
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
			expect(() =>
				readFileSync(join(decoyShimDir, "codex.bat"), "utf8"),
			).toThrow();
		},
	);

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
		const result = runWrapper(fixtureRoot, ["--version"], {
			CODEX_MULTI_AUTH_BYPASS: "",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: missingOverride,
		});
		const output = combinedOutput(result);

		expect(result.status).toBe(1);
		expect(output).toContain(
			`CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: ${missingOverride}`,
		);
		expect(output).toContain("Could not locate the official Codex CLI binary");
		expect(output).toContain(
			"Install it globally: npm install -g @openai/codex",
		);
	});

	it("fails over to the next healthy account before launching non-interactive commands", () => {
		const fixtureRoot = createWrapperFixture();
		const launchLogPath = join(fixtureRoot, "launch.log");
		const selectionLogPath = join(fixtureRoot, "selection.log");
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'import { appendFileSync } from "node:fs";',
			'appendFileSync(process.env.TEST_LAUNCH_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
			"process.exit(0);",
		]);
		createSupervisorRuntimeFixture(fixtureRoot, {
			accountManagerLines: [
				'import { appendFileSync } from "node:fs";',
				"const pool = [",
				"\t{ index: 0, accountId: 'acc-1', access: 'token-1', refreshToken: 'refresh-1', email: 'one@example.com' },",
				"\t{ index: 1, accountId: 'acc-2', access: 'token-2', refreshToken: 'refresh-2', email: 'two@example.com' },",
				"];",
				"const state = { currentIndex: 0, blockedUntil: new Map() };",
				"export class AccountManager {",
				"\tconstructor() {}",
				"\tstatic async loadFromDisk() {",
				"\t\treturn new AccountManager();",
				"\t}",
				"\tgetCurrentAccountForFamily() {",
				"\t\treturn pool[state.currentIndex] ?? null;",
				"\t}",
				"\tgetCurrentOrNextForFamilyHybrid() {",
				"\t\tfor (const account of pool) {",
				"\t\t\tconst blockedUntil = state.blockedUntil.get(account.index) ?? 0;",
				"\t\t\tif (blockedUntil <= Date.now()) return account;",
				"\t\t}",
				"\t\treturn null;",
				"\t}",
				"\tmarkRateLimitedWithReason(account, waitMs) {",
				"\t\tstate.blockedUntil.set(account.index, Date.now() + Math.max(1, waitMs));",
				"\t}",
				"\tsetActiveIndex(index) {",
				"\t\tstate.currentIndex = index;",
				"\t}",
				"\tasync syncCodexCliActiveSelectionForIndex(index) {",
				"\t\tstate.currentIndex = index;",
				"\t\tappendFileSync(process.env.TEST_SELECTION_LOG, `sync:${index}\\n`);",
				"\t}",
				"\tasync saveToDisk() {",
				"\t\tappendFileSync(process.env.TEST_SELECTION_LOG, `save:${state.currentIndex}\\n`);",
				"\t}",
				"\tgetMinWaitTimeForFamily() {",
				"\t\tconst waits = Array.from(state.blockedUntil.values()).map((value) => Math.max(0, value - Date.now())).filter((value) => value > 0);",
				"\t\treturn waits.length > 0 ? Math.min(...waits) : 0;",
				"\t}",
				"}",
			],
			quotaProbeLines: [
				"export async function fetchCodexQuotaSnapshot({ accountId }) {",
				"\tif (accountId === 'acc-1') {",
				"\t\treturn { status: 200, model: 'gpt-5-codex', primary: { usedPercent: 95, resetAtMs: Date.now() + 30_000 }, secondary: { usedPercent: 15, resetAtMs: Date.now() + 30_000 } };",
				"\t}",
				"\treturn { status: 200, model: 'gpt-5-codex', primary: { usedPercent: 20, resetAtMs: Date.now() + 30_000 }, secondary: { usedPercent: 10, resetAtMs: Date.now() + 30_000 } };",
				"}",
			],
		});

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			TEST_LAUNCH_LOG: launchLogPath,
			TEST_SELECTION_LOG: selectionLogPath,
		});

		if (result.status !== 0) {
			throw new Error(combinedOutput(result));
		}
		expect(result.status).toBe(0);
		expect(readFileSync(launchLogPath, "utf8")).toContain(
			'exec status -c cli_auth_credentials_store="file"',
		);
		expect(readFileSync(selectionLogPath, "utf8")).toContain("sync:1");
	});

	it("uses the 10 percent 5h fallback when legacy supervisor helpers are missing", () => {
		const fixtureRoot = createWrapperFixture();
		const launchLogPath = join(fixtureRoot, "launch.log");
		const selectionLogPath = join(fixtureRoot, "selection.log");
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'import { appendFileSync } from "node:fs";',
			'appendFileSync(process.env.TEST_LAUNCH_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
			"process.exit(0);",
		]);
		createSupervisorRuntimeFixture(fixtureRoot, {
			configLines: [
				"export function loadPluginConfig() {",
				"\treturn {",
				"\t\tcodexCliSessionSupervisor: true,",
				"\t\tretryAllAccountsRateLimited: true,",
				"\t\tpreemptiveQuotaEnabled: true,",
				"\t};",
				"}",
			],
			accountManagerLines: [
				'import { appendFileSync } from "node:fs";',
				"const pool = [",
				"\t{ index: 0, accountId: 'acc-1', access: 'token-1', refreshToken: 'refresh-1', email: 'one@example.com' },",
				"\t{ index: 1, accountId: 'acc-2', access: 'token-2', refreshToken: 'refresh-2', email: 'two@example.com' },",
				"];",
				"const state = { currentIndex: 0, blockedUntil: new Map() };",
				"export class AccountManager {",
				"\tconstructor() {}",
				"\tstatic async loadFromDisk() {",
				"\t\treturn new AccountManager();",
				"\t}",
				"\tgetCurrentAccountForFamily() {",
				"\t\treturn pool[state.currentIndex] ?? null;",
				"\t}",
				"\tgetCurrentOrNextForFamilyHybrid() {",
				"\t\tfor (const account of pool) {",
				"\t\t\tconst blockedUntil = state.blockedUntil.get(account.index) ?? 0;",
				"\t\t\tif (blockedUntil <= Date.now()) return account;",
				"\t\t}",
				"\t\treturn null;",
				"\t}",
				"\tmarkRateLimitedWithReason(account, waitMs) {",
				"\t\tstate.blockedUntil.set(account.index, Date.now() + Math.max(1, waitMs));",
				"\t}",
				"\tsetActiveIndex(index) {",
				"\t\tstate.currentIndex = index;",
				"\t}",
				"\tasync syncCodexCliActiveSelectionForIndex(index) {",
				"\t\tstate.currentIndex = index;",
				"\t\tappendFileSync(process.env.TEST_SELECTION_LOG, `sync:${index}\\n`);",
				"\t}",
				"\tasync saveToDisk() {",
				"\t\tappendFileSync(process.env.TEST_SELECTION_LOG, `save:${state.currentIndex}\\n`);",
				"\t}",
				"\tgetMinWaitTimeForFamily() {",
				"\t\tconst waits = Array.from(state.blockedUntil.values()).map((value) => Math.max(0, value - Date.now())).filter((value) => value > 0);",
				"\t\treturn waits.length > 0 ? Math.min(...waits) : 0;",
				"\t}",
				"}",
			],
			quotaProbeLines: [
				"export async function fetchCodexQuotaSnapshot({ accountId }) {",
				"\tif (accountId === 'acc-1') {",
				"\t\treturn { status: 200, model: 'gpt-5-codex', primary: { usedPercent: 92, resetAtMs: Date.now() + 30_000 }, secondary: { usedPercent: 15, resetAtMs: Date.now() + 30_000 } };",
				"\t}",
				"\treturn { status: 200, model: 'gpt-5-codex', primary: { usedPercent: 20, resetAtMs: Date.now() + 30_000 }, secondary: { usedPercent: 10, resetAtMs: Date.now() + 30_000 } };",
				"}",
			],
		});

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			TEST_LAUNCH_LOG: launchLogPath,
			TEST_SELECTION_LOG: selectionLogPath,
		});

		if (result.status !== 0) {
			throw new Error(combinedOutput(result));
		}
		expect(result.status).toBe(0);
		expect(readFileSync(launchLogPath, "utf8")).toContain(
			'exec status -c cli_auth_credentials_store="file"',
		);
		expect(readFileSync(selectionLogPath, "utf8")).toContain("sync:1");
	});

	it("relaunches interactive sessions with resume after supervisor rotation", async () => {
		const fixtureRoot = createWrapperFixture();
		const launchLogPath = join(fixtureRoot, "launch.log");
		const selectionLogPath = join(fixtureRoot, "selection.log");
		const sessionsDir = join(fixtureRoot, "sessions");
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"const args = process.argv.slice(2);",
			'appendFileSync(process.env.TEST_LAUNCH_LOG, `${args.join(" ")}\\n`);',
			"if (args[0] === 'resume') {",
			"\tprocess.exit(0);",
			"}",
			"const sessionDir = join(process.env.CODEX_MULTI_AUTH_CLI_SESSIONS_DIR, '2026', '03', '20');",
			"mkdirSync(sessionDir, { recursive: true });",
			"writeFileSync(",
			"\tjoin(sessionDir, 'rollout-session-1.jsonl'),",
			"\t`${JSON.stringify({ session_meta: { payload: { id: 'session-1', cwd: process.cwd() } } })}\\n`,",
			"\t'utf8',",
			");",
			"let finished = false;",
			"const finish = (code) => {",
			"\tif (finished) return;",
			"\tfinished = true;",
			"\tprocess.exit(code);",
			"};",
			"process.on('SIGINT', () => finish(130));",
			"setInterval(() => {}, 1000);",
			"setTimeout(() => finish(0), 20_000);",
		]);
		createSupervisorRuntimeFixture(fixtureRoot, {
			accountManagerLines: [
				'import { appendFileSync } from "node:fs";',
				"const pool = [",
				"\t{ index: 0, accountId: 'acc-1', access: 'token-1', refreshToken: 'refresh-1', email: 'one@example.com' },",
				"\t{ index: 1, accountId: 'acc-2', access: 'token-2', refreshToken: 'refresh-2', email: 'two@example.com' },",
				"];",
				"const state = { currentIndex: 0, blockedUntil: new Map() };",
				"export class AccountManager {",
				"\tconstructor() {}",
				"\tstatic async loadFromDisk() {",
				"\t\treturn new AccountManager();",
				"\t}",
				"\tgetCurrentAccountForFamily() {",
				"\t\treturn pool[state.currentIndex] ?? null;",
				"\t}",
				"\tgetCurrentOrNextForFamilyHybrid() {",
				"\t\tfor (const account of pool) {",
				"\t\t\tconst blockedUntil = state.blockedUntil.get(account.index) ?? 0;",
				"\t\t\tif (blockedUntil <= Date.now()) return account;",
				"\t\t}",
				"\t\treturn null;",
				"\t}",
				"\tmarkRateLimitedWithReason(account, waitMs) {",
				"\t\tstate.blockedUntil.set(account.index, Date.now() + Math.max(1, waitMs));",
				"\t}",
				"\tsetActiveIndex(index) {",
				"\t\tstate.currentIndex = index;",
				"\t}",
				"\tasync syncCodexCliActiveSelectionForIndex(index) {",
				"\t\tstate.currentIndex = index;",
				"\t\tappendFileSync(process.env.TEST_SELECTION_LOG, `sync:${index}\\n`);",
				"\t}",
				"\tasync saveToDisk() {",
				"\t\tappendFileSync(process.env.TEST_SELECTION_LOG, `save:${state.currentIndex}\\n`);",
				"\t}",
				"\tgetMinWaitTimeForFamily() {",
				"\t\tconst waits = Array.from(state.blockedUntil.values()).map((value) => Math.max(0, value - Date.now())).filter((value) => value > 0);",
				"\t\treturn waits.length > 0 ? Math.min(...waits) : 0;",
				"\t}",
				"}",
			],
			quotaProbeLines: [
				"const calls = new Map();",
				"export async function fetchCodexQuotaSnapshot({ accountId }) {",
				"\tconst count = (calls.get(accountId) ?? 0) + 1;",
				"\tcalls.set(accountId, count);",
				"\tif (accountId === 'acc-1') {",
				"\t\tconst usedPercent = count === 1 ? 40 : 95;",
				"\t\treturn { status: 200, model: 'gpt-5-codex', primary: { usedPercent, resetAtMs: Date.now() + 30_000 }, secondary: { usedPercent: 15, resetAtMs: Date.now() + 30_000 } };",
				"\t}",
				"\treturn { status: 200, model: 'gpt-5-codex', primary: { usedPercent: 20, resetAtMs: Date.now() + 30_000 }, secondary: { usedPercent: 10, resetAtMs: Date.now() + 30_000 } };",
				"}",
			],
		});

		const result = await runWrapperAsync(fixtureRoot, [], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_CLI_SESSIONS_DIR: sessionsDir,
			CODEX_AUTH_CLI_SESSION_SUPERVISOR_POLL_MS: "250",
			CODEX_AUTH_CLI_SESSION_SUPERVISOR_IDLE_MS: "500",
			CODEX_AUTH_CLI_SESSION_CAPTURE_TIMEOUT_MS: "2000",
			CODEX_AUTH_CLI_SESSION_SIGNAL_TIMEOUT_MS: "100",
			TEST_LAUNCH_LOG: launchLogPath,
			TEST_SELECTION_LOG: selectionLogPath,
		});

		if (result.status !== 0) {
			throw new Error(combinedOutput(result));
		}
		expect(result.status).toBe(0);
		expect(readFileSync(selectionLogPath, "utf8")).toContain("sync:1");
		expect(readFileSync(launchLogPath, "utf8")).toContain(
			'resume session-1 -c cli_auth_credentials_store="file"',
		);
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
				promise: runWrapperAsync(fixtureRoot, ["exec", "status"], {
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
			expect(output).toContain("FORWARDED:exec status");
			expect(output.match(/cli_auth_credentials_store=/g) ?? []).toHaveLength(
				1,
			);
		}
	});
});
