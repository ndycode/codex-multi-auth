import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_ROTATION_PROXY_PROVIDER_ID } from "../lib/runtime-constants.js";
import { sleep } from "../lib/utils.js";
import { resolveRealCodexBin } from "../scripts/codex-bin-resolver.js";

const createdDirs: string[] = [];
const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRootDir = join(testFileDir, "..");
const EXIT_SUCCESS_LINE = "exit 0";
const SHADOW_HOME_ORPHAN_LOCK_TEST_AGE_MS = 2_200;

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
	writeFileSync(
		join(fixtureRoot, "package.json"),
		`${JSON.stringify({ type: "module" }, null, 2)}\n`,
		"utf8",
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex.js"),
		join(scriptDir, "codex.js"),
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex-routing.js"),
		join(scriptDir, "codex-routing.js"),
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex-bin-resolver.js"),
		join(scriptDir, "codex-bin-resolver.js"),
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex-app-launcher.js"),
		join(scriptDir, "codex-app-launcher.js"),
	);
	copyFileSync(
		join(repoRootDir, "scripts", "codex-app-router.js"),
		join(scriptDir, "codex-app-router.js"),
	);
	copyFileSync(
		join(repoRootDir, "scripts", "install-codex-auth-utils.js"),
		join(scriptDir, "install-codex-auth-utils.js"),
	);
	return fixtureRoot;
}

function createRuntimeObservabilityFixtureModule(fixtureRoot: string): string {
	const runtimeDir = join(fixtureRoot, "dist", "lib", "runtime");
	mkdirSync(runtimeDir, { recursive: true });
	const modulePath = join(runtimeDir, "runtime-observability.js");
	writeFileSync(
		modulePath,
		[
			"import { existsSync, mkdirSync, readFileSync, writeFileSync } from \"node:fs\";",
			"import { dirname, join } from \"node:path\";",
			"",
			"function getSnapshotPath() {",
			"  const root = (process.env.CODEX_MULTI_AUTH_DIR ?? '').trim();",
			"  if (root.length === 0) throw new Error('CODEX_MULTI_AUTH_DIR is required in wrapper tests');",
			"  return join(root, 'runtime-observability.json');",
			"}",
			"",
			"function createDefaultSnapshot() {",
			"  return {",
			"    version: 1,",
			"    updatedAt: 0,",
			"    currentRequestId: null,",
			"    responsesRequests: 0,",
			"    authRefreshRequests: 0,",
			"    diagnosticProbeRequests: 0,",
			"    poolExhaustionCooldownUntil: null,",
			"    serverBurstCooldownUntil: null,",
			"    runtimeMetrics: {",
			"      startedAt: 0,",
			"      totalRequests: 0,",
			"      successfulRequests: 0,",
			"      failedRequests: 0,",
			"      responsesRequests: 0,",
			"      authRefreshRequests: 0,",
			"      diagnosticProbeRequests: 0,",
			"      outboundRequestAttemptBudget: null,",
			"      outboundRequestAttemptsConsumed: 0,",
			"      requestAttemptBudgetExhaustions: 0,",
			"      poolExhaustionFastFails: 0,",
			"      serverBurstFastFails: 0,",
			"      rateLimitedResponses: 0,",
			"      serverErrors: 0,",
			"      networkErrors: 0,",
			"      userAborts: 0,",
			"      authRefreshFailures: 0,",
			"      emptyResponseRetries: 0,",
			"      accountRotations: 0,",
			"      sameAccountRetries: 0,",
			"      streamFailoverAttempts: 0,",
			"      streamFailoverCandidatesConsidered: 0,",
			"      lastStreamFailoverCandidateCount: 0,",
			"      streamFailoverRecoveries: 0,",
			"      streamFailoverCrossAccountRecoveries: 0,",
			"      cumulativeLatencyMs: 0,",
			"      lastRequestAt: null,",
			"      lastError: null,",
			"    },",
			"  };",
			"}",
			"",
			"function readSnapshot() {",
			"  const snapshotPath = getSnapshotPath();",
			"  if (!existsSync(snapshotPath)) return null;",
			"  return JSON.parse(readFileSync(snapshotPath, 'utf8'));",
			"}",
			"",
			"export async function loadPersistedRuntimeObservabilitySnapshot() {",
			"  return readSnapshot();",
			"}",
			"",
			"export function mutateRuntimeObservabilitySnapshot(mutator) {",
			"  const snapshot = readSnapshot() ?? createDefaultSnapshot();",
			"  mutator(snapshot);",
			"  snapshot.updatedAt = Date.now();",
			"  const snapshotPath = getSnapshotPath();",
			"  mkdirSync(dirname(snapshotPath), { recursive: true });",
			"  writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');",
			"}",
		].join("\n"),
		"utf8",
	);
	return modulePath;
}

function createRuntimeConfigTomlFixtureModule(fixtureRoot: string): string {
	const runtimeDir = join(fixtureRoot, "dist", "lib", "runtime");
	mkdirSync(runtimeDir, { recursive: true });
	const modulePath = join(runtimeDir, "config-toml.js");
	writeFileSync(
		modulePath,
		[
			`const providerId = ${JSON.stringify(RUNTIME_ROTATION_PROXY_PROVIDER_ID)};`,
			"export function tomlStringLiteral(value) {",
			"  const escaped = String(value).replace(/[\\u0000-\\u001f\\u007f\\\\\"]/g, (character) => {",
			"    switch (character) {",
			'      case "\\b": return "\\\\b";',
			'      case "\\t": return "\\\\t";',
			'      case "\\n": return "\\\\n";',
			'      case "\\f": return "\\\\f";',
			'      case "\\r": return "\\\\r";',
			'      case "\\"": return "\\\\\\"";',
			'      case "\\\\": return "\\\\\\\\";',
			"      default: return `\\\\u${character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`;",
			"    }",
			"  });",
			"  return `\"${escaped}\"`;",
			"}",
			"function readTomlTableName(line) {",
			"  const match = /^\\s*\\[{1,2}\\s*([^\\]]+?)\\s*\\]{1,2}\\s*$/.exec(line);",
			"  return match?.[1]?.trim() ?? null;",
			"}",
			"function removeProviderBlock(rawConfig) {",
			"  const lines = rawConfig.split(/\\r?\\n/);",
			"  const output = [];",
			"  let skipping = false;",
			"  const providerTable = `model_providers.${providerId}`;",
			"  for (const line of lines) {",
			"    const tableName = readTomlTableName(line);",
			"    if (tableName === providerTable) { skipping = true; continue; }",
			"    if (skipping && tableName) {",
			"      if (tableName === providerTable || tableName.startsWith(`${providerTable}.`)) continue;",
			"      skipping = false;",
			"    }",
			"    if (!skipping) output.push(line);",
			"  }",
			"  return output.join(rawConfig.includes('\\r\\n') ? '\\r\\n' : '\\n');",
			"}",
			"function rewriteModelProvider(rawConfig) {",
			"  const lineEnding = rawConfig.includes('\\r\\n') ? '\\r\\n' : '\\n';",
			"  const lines = rawConfig.length > 0 ? rawConfig.split(/\\r?\\n/) : [];",
			"  const rewrittenLine = `model_provider = ${tomlStringLiteral(providerId)}`;",
			"  let replaced = false;",
			"  const output = [];",
			"  for (const line of lines) {",
			"    const isTable = readTomlTableName(line) !== null;",
			"    if (!replaced && isTable) { output.push(rewrittenLine); replaced = true; }",
			"    if (!replaced && /^\\s*model_provider\\s*=/.test(line)) { output.push(rewrittenLine); replaced = true; continue; }",
			"    output.push(line);",
			"  }",
			"  if (!replaced) output.push(rewrittenLine);",
			"  return output.join(lineEnding);",
			"}",
			"export function rewriteConfigTomlForRuntimeRotationProvider(rawConfig, baseUrl, clientApiKey = '') {",
			"  const lineEnding = rawConfig.includes('\\r\\n') ? '\\r\\n' : '\\n';",
			"  const withoutOldProvider = removeProviderBlock(rawConfig).replace(/[\\r\\n]*$/, '');",
			"  const withModelProvider = rewriteModelProvider(withoutOldProvider).replace(/[\\r\\n]*$/, '');",
			"  const providerBlock = [",
			"    `[model_providers.${providerId}]`,",
			"    'name = \"codex-multi-auth\"',",
			"    `base_url = ${tomlStringLiteral(baseUrl)}`,",
			"    'requires_openai_auth = false',",
			"    `experimental_bearer_token = ${tomlStringLiteral(clientApiKey)}`,",
			"    'wire_api = \"responses\"',",
			"  ];",
			"  return `${withModelProvider}${lineEnding}${lineEnding}${providerBlock.join(lineEnding)}${lineEnding}`;",
			"}",
		].join("\n"),
		"utf8",
	);
	return modulePath;
}

function createRuntimeRotationProxyFixtureModule(fixtureRoot: string): string {
	createRuntimeConfigTomlFixtureModule(fixtureRoot);
	const distLibDir = join(fixtureRoot, "dist", "lib");
	mkdirSync(distLibDir, { recursive: true });
	const modulePath = join(distLibDir, "runtime-rotation-proxy.js");
	writeFileSync(
		modulePath,
		[
			'import { appendFileSync, mkdirSync } from "node:fs";',
			'import { dirname } from "node:path";',
			"",
			"function appendMarker(line) {",
			"  const marker = (process.env.CODEX_MULTI_AUTH_TEST_PROXY_MARKER ?? '').trim();",
			"  if (marker.length === 0) return;",
			"  mkdirSync(dirname(marker), { recursive: true });",
			"  appendFileSync(marker, `${line}\\n`, 'utf8');",
			"}",
			"",
			"function readOptionalNumberEnv(name) {",
			"  const parsed = Number.parseInt(process.env[name] ?? '', 10);",
			"  return Number.isFinite(parsed) ? parsed : null;",
			"}",
			"",
			"function readOptionalStringEnv(name) {",
			"  const value = (process.env[name] ?? '').trim();",
			"  return value.length > 0 ? value : null;",
			"}",
			"",
			"function buildStatus() {",
			"  return {",
			"    totalRequests: readOptionalNumberEnv('CODEX_MULTI_AUTH_TEST_PROXY_REQUESTS') ?? 0,",
			"    upstreamRequests: 0,",
			"    retries: 0,",
			"    rotations: readOptionalNumberEnv('CODEX_MULTI_AUTH_TEST_PROXY_ROTATIONS') ?? 0,",
			"    lastAccountIndex: readOptionalNumberEnv('CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_INDEX'),",
			"    lastAccountLabel: readOptionalStringEnv('CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_LABEL'),",
			"    lastAccountEmail: readOptionalStringEnv('CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_EMAIL'),",
			"    lastAccountId: readOptionalStringEnv('CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_ID'),",
			"    lastAccountUpdatedAt: readOptionalNumberEnv('CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_UPDATED_AT'),",
			"    lastError: null,",
			"  };",
			"}",
			"",
			"export async function startRuntimeRotationProxy() {",
			"  const baseUrl = process.env.CODEX_MULTI_AUTH_TEST_PROXY_BASE_URL ?? 'http://127.0.0.1:4567';",
			"  if ((process.env.CODEX_MULTI_AUTH_TEST_PROXY_MARKER_ENV ?? '').trim() === '1') {",
			"    appendMarker(`codex-home-env:${process.env.CODEX_HOME ?? ''}`);",
			"    appendMarker(`real-home-env:${process.env.CODEX_MULTI_AUTH_REAL_CODEX_HOME ?? ''}`);",
			"  }",
			"  appendMarker((process.env.CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID ?? '').trim() === '1' ? `start:${baseUrl}:pid=${process.pid}` : `start:${baseUrl}`);",
			"  return {",
			"    host: '127.0.0.1',",
			"    port: 4567,",
			"    baseUrl,",
			"    close: async () => appendMarker('close'),",
			"    getStatus: () => buildStatus(),",
			"  };",
			"}",
		].join("\n"),
		"utf8",
	);
	return modulePath;
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
	const fakeBin = join(rootDir, `fake-codex-${createdDirs.length}.cjs`);
	writeFileSync(fakeBin, lines.join("\n"), "utf8");
	return fakeBin;
}

function createFakeNativeCodexBin(rootDir: string): string {
	if (process.platform === "win32") {
		const fakeBin = join(rootDir, `fake-native-codex-${createdDirs.length}.ps1`);
		writeFileSync(
			fakeBin,
			[
				'Write-Output ("FORWARDED_NATIVE:" + ($args -join " "))',
				"exit 0",
			].join("\r\n"),
			"utf8",
		);
		return fakeBin;
	}

	const fakeBin = join(rootDir, `fake-native-codex-${createdDirs.length}`);
	writeFileSync(
		fakeBin,
		[
			"#!/bin/sh",
			'printf "FORWARDED_NATIVE:%s\\n" "$*"',
			EXIT_SUCCESS_LINE,
		].join("\n"),
		"utf8",
	);
	chmodSync(fakeBin, 0o755);
	return fakeBin;
}

function resolveWindowsPowerShellPath(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function createPathDiscoveredNativeCodexFixture(rootDir: string): {
	args: string[];
	binDir: string;
	expectedOutput: string;
} {
	const binDir = join(rootDir, `native-codex-bin-${createdDirs.length}`);
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, "native-codex-marker.js");
		writeFileSync(
			scriptPath,
			[
				'console.log(`FORWARDED_NATIVE_PATH:${process.argv.slice(2).join(" ")}`);',
				"process.exit(0);",
			].join("\n"),
			"utf8",
		);
		const nativeExePath = join(binDir, "codex.exe");
		try {
			linkSync(process.execPath, nativeExePath);
		} catch {
			copyFileSync(process.execPath, nativeExePath);
		}
		return {
			binDir,
			args: [scriptPath, "--version"],
			expectedOutput: "FORWARDED_NATIVE_PATH:--version",
		};
	}

	const nativeCodexPath = join(binDir, "codex");
	writeFileSync(
		nativeCodexPath,
		[
			"#!/bin/sh",
			'printf "FORWARDED_NATIVE_PATH:%s\\n" "$*"',
			"exit 0",
		].join("\n"),
		"utf8",
	);
	chmodSync(nativeCodexPath, 0o755);
	return {
		binDir,
		args: ["--version"],
		expectedOutput: "FORWARDED_NATIVE_PATH:--version",
	};
}

function injectShadowCleanupBusyFailures(
	failuresBeforeSuccess = 2,
): NodeJS.ProcessEnv {
	return {
		CODEX_MULTI_AUTH_TEST_SHADOW_CLEANUP_BUSY_FAILURES: String(failuresBeforeSuccess),
	};
}

function injectShadowPreflightReadBusyFailures(
	failuresBeforeSuccess = 2,
): NodeJS.ProcessEnv {
	return {
		CODEX_MULTI_AUTH_TEST_SHADOW_PREFLIGHT_READ_BUSY_FAILURES: String(
			failuresBeforeSuccess,
		),
	};
}

function injectShadowSyncMetadataBusyFailures(
	failuresBeforeSuccess = 10,
): NodeJS.ProcessEnv {
	return {
		CODEX_MULTI_AUTH_TEST_SHADOW_SYNC_METADATA_BUSY_FAILURES: String(
			failuresBeforeSuccess,
		),
	};
}

function injectShadowLockRecreatedStaleCount(count = 2): NodeJS.ProcessEnv {
	return {
		CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_RECREATE_STALE_COUNT: String(count),
	};
}

function injectShadowLockOwnerWriteFailures(
	failuresBeforeSuccess = 1,
): NodeJS.ProcessEnv {
	return {
		CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_OWNER_WRITE_FAILURES: String(
			failuresBeforeSuccess,
		),
	};
}

function createFakeGlobalCodexInstall(rootDir: string): string {
	const fakeBin = join(rootDir, "@openai", "codex", "bin", "codex.js");
	mkdirSync(dirname(fakeBin), { recursive: true });
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

function createSpawnSyncSuccess(stdout: string): SpawnSyncReturns<string> {
	return {
		output: ["", stdout, ""],
		pid: 1,
		signal: null,
		status: 0,
		stderr: "",
		stdout,
	};
}

const WRAPPER_ENV_ALLOWLIST = [
	"APPDATA",
	"CI",
	"COLORTERM",
	"COMSPEC",
	"ComSpec",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LOCALAPPDATA",
	"NODE_OPTIONS",
	"OS",
	"PATH",
	"Path",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROGRAMDATA",
	"ProgramData",
	"SYSTEMROOT",
	"SystemRoot",
	"TEMP",
	"TERM",
	"TERM_PROGRAM",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
] as const;

function buildWrapperEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of WRAPPER_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	env.CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE = "1";
	Object.assign(env, extraEnv);
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete env[key];
		}
	}
	return env;
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
			env: buildWrapperEnv(extraEnv),
		},
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && typeof error === "object" && "code" in error
			? error.code === "EPERM"
			: false;
	}
}

async function ageShadowSyncLockForSteal(lockDir: string): Promise<void> {
	const staleTimestamp = new Date(Date.now() - SHADOW_HOME_ORPHAN_LOCK_TEST_AGE_MS);
	utimesSync(lockDir, staleTimestamp, staleTimestamp);
	await sleep(SHADOW_HOME_ORPHAN_LOCK_TEST_AGE_MS);
}

function runWrapperWithInput(
	fixtureRoot: string,
	args: string[],
	input: string,
	extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[join(fixtureRoot, "scripts", "codex.js"), ...args],
		{
			encoding: "utf8",
			env: buildWrapperEnv(extraEnv),
			input,
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
		env: buildWrapperEnv(extraEnv),
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
				env: buildWrapperEnv(extraEnv),
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

async function waitForPath(path: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await sleep(20);
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForFileText(
	path: string,
	expected: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastContent = "";
	while (Date.now() < deadline) {
		try {
			lastContent = readFileSync(path, "utf8");
			if (lastContent === expected) return;
		} catch {
			// Keep polling until the file appears or the timeout expires.
		}
		await sleep(20);
	}
	throw new Error(
		`timed out waiting for ${path} to equal ${JSON.stringify(expected)}; last content: ${JSON.stringify(lastContent)}`,
	);
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

	it("forwards non-auth commands to native codex executables", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeNativeCodexBin(fixtureRoot);
		const nativeBin = process.platform === "win32" ? resolveWindowsPowerShellPath() : fakeBin;
		const args =
			process.platform === "win32"
				? ["-NoProfile", "-File", fakeBin, "--version"]
				: ["--version"];
		const result = runWrapper(fixtureRoot, args, {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: nativeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED_NATIVE:--version");
	});

	it("auto-discovers native codex executables on PATH and forwards end-to-end", () => {
		const fixtureRoot = createWrapperFixture();
		const resolverPath = join(fixtureRoot, "scripts", "codex-bin-resolver.js");
		const originalSource = readFileSync(resolverPath, "utf8");
		const patchTarget = 'return require.resolve("@openai/codex/bin/codex.js");';
		expect(originalSource).toContain(patchTarget);
		writeFileSync(
			resolverPath,
			originalSource.replace(patchTarget, "return null;"),
			"utf8",
		);
		const nativeFixture = createPathDiscoveredNativeCodexFixture(fixtureRoot);
		const result = runWrapper(fixtureRoot, nativeFixture.args, {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: undefined,
			PATH: nativeFixture.binDir,
			Path: nativeFixture.binDir,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(nativeFixture.expectedOutput);
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

	it("starts the opt-in runtime rotation proxy with a shadow CODEX_HOME provider", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`CODEX_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'console.log(`CODEX_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);',
			'console.log(`OPENAI_API_KEY:${process.env.OPENAI_API_KEY ?? ""}`);',
			'console.log(`SESSION_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "sessions", "resume.jsonl"))}`);',
			'console.log(`PLUGIN_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "plugins", "plugin.txt"))}`);',
			'console.log(`SKILL_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "skills", "skill.txt"))}`);',
			'console.log(`MEMORY_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "memories", "user.md"))}`);',
			'console.log(`INSTRUCTION_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "instructions", "profile.md"))}`);',
			'const statePath = path.join(process.env.CODEX_HOME ?? "", "state_5.sqlite");',
			'fs.appendFileSync(statePath, "shadow\\n", "utf8");',
			'console.log(`ROOT_STATE_REALTIME:${fs.readFileSync(path.join(process.env.ORIGINAL_CODEX_HOME ?? "", "state_5.sqlite"), "utf8").includes("shadow")}`);',
			'fs.writeFileSync(path.join(process.env.CODEX_HOME ?? "", "new-root-state.json"), "new\\n", "utf8");',
			'fs.writeFileSync(path.join(process.env.CODEX_HOME ?? "", "sessions", "runtime-session.jsonl"), "runtime\\n", "utf8");',
			'fs.writeFileSync(path.join(process.env.CODEX_HOME ?? "", "auth.json"), \'{"token":"proxy-scoped"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(process.env.CODEX_HOME ?? "", "accounts.json"), \'{"accounts":["proxy-scoped"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(process.env.CODEX_HOME ?? "", ".codex-global-state.json"), \'{"last":"runtime"}\\n\', "utf8");',
			'const configPath = path.join(process.env.CODEX_HOME ?? "", "config.toml");',
			'console.log("CONFIG_START");',
			'console.log(fs.readFileSync(configPath, "utf8").trim());',
			'console.log("CONFIG_END");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(join(originalHome, "sessions"), { recursive: true });
		mkdirSync(join(originalHome, "plugins"), { recursive: true });
		mkdirSync(join(originalHome, "skills"), { recursive: true });
		mkdirSync(join(originalHome, "memories"), { recursive: true });
		mkdirSync(join(originalHome, "instructions"), { recursive: true });
		writeFileSync(join(originalHome, "sessions", "resume.jsonl"), "resume\n", "utf8");
		writeFileSync(join(originalHome, "plugins", "plugin.txt"), "plugin\n", "utf8");
		writeFileSync(join(originalHome, "skills", "skill.txt"), "skill\n", "utf8");
		writeFileSync(join(originalHome, "memories", "user.md"), "memory\n", "utf8");
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(
			join(originalHome, "accounts.json"),
			'{"accounts":["original"]}\n',
			"utf8",
		);
		writeFileSync(
			join(originalHome, ".codex-global-state.json"),
			'{"last":"original"}\n',
			"utf8",
		);
		writeFileSync(
			join(originalHome, "instructions", "profile.md"),
			"instruction\n",
			"utf8",
		);
		writeFileSync(join(originalHome, "state_5.sqlite"), "state\n", "utf8");
		writeFileSync(
			join(originalHome, "config.toml"),
			[
				'model = "gpt-5-codex"',
				'model_provider = "openai"',
				"",
				"[model_providers.existing]",
				'name = "Existing"',
				'base_url = "https://example.invalid"',
				"",
				`[ model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID} ]`,
				'name = "Stale Runtime Proxy"',
				'base_url = "http://127.0.0.1:1"',
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			ORIGINAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_BASE_URL: "http://127.0.0.1:4567",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain(
			`FORWARDED:exec status -c cli_auth_credentials_store="file" -c model_provider="${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		expect(output).toContain("CODEX_HOME_IS_ORIGINAL:false");
		expect(output).toContain("SESSION_EXISTS:true");
		expect(output).toContain("PLUGIN_EXISTS:true");
		expect(output).toContain("SKILL_EXISTS:true");
		expect(output).toContain("MEMORY_EXISTS:true");
		expect(output).toContain("INSTRUCTION_EXISTS:true");
		expect(output).toContain("ROOT_STATE_REALTIME:true");
		const apiKeyMatch = output.match(/^OPENAI_API_KEY:([0-9a-f]{64})$/m);
		expect(apiKeyMatch?.[1]).toBeTruthy();
		expect(output).toContain(
			`model_provider = "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		expect(output).toContain(
			`[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}]`,
		);
		expect(output).toContain('name = "codex-multi-auth"');
		expect(output).toContain('base_url = "http://127.0.0.1:4567"');
		expect(output).toContain("requires_openai_auth = false");
		expect(output).toContain('name = "codex-multi-auth"');
		expect(output).toContain(
			`experimental_bearer_token = "${apiKeyMatch?.[1]}"`,
		);
		expect(output).toContain('wire_api = "responses"');
		expect(output).not.toContain("env_key");
		expect(output).not.toContain('base_url = "http://127.0.0.1:1"');
		expect((output.match(/\[model_providers\.codex-multi-auth-runtime-proxy\]/g) ?? []).length).toBe(1);
		const shadowHomeMatch = output.match(/^CODEX_HOME:(.+)$/m);
		expect(shadowHomeMatch?.[1]).toBeTruthy();
		if (shadowHomeMatch?.[1]) {
			expect(existsSync(shadowHomeMatch[1])).toBe(false);
		}
		expect(readFileSync(markerPath, "utf8")).toBe(
			"start:http://127.0.0.1:4567\nclose\n",
		);
		expect(readFileSync(join(originalHome, "config.toml"), "utf8")).toContain(
			'model_provider = "openai"',
		);
		expect(
			readFileSync(join(originalHome, "sessions", "runtime-session.jsonl"), "utf8"),
		).toBe("runtime\n");
		expect(readFileSync(join(originalHome, "state_5.sqlite"), "utf8")).toContain(
			"shadow",
		);
		expect(readFileSync(join(originalHome, "new-root-state.json"), "utf8")).toBe(
			"new\n",
		);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe(
			'{"token":"original"}',
		);
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe(
			'{"accounts":["original"]}',
		);
		expect(
			readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim(),
		).toBe('{"last":"runtime"}');
	});

	it("inserts the runtime model provider before TOML array tables", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"));',
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			['[[profiles.experimental]]', 'model = "gpt-5-codex"', ""].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			OPENAI_API_KEY: undefined,
		});

		expect(result.status).toBe(0);
		expect(
			result.stdout.indexOf(
				`model_provider = "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
			),
		).toBeLessThan(
			result.stdout.indexOf("[[profiles.experimental]]"),
		);
	});

	it("starts the opt-in runtime rotation proxy for app-server without capturing protocol stdio", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`CODEX_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'console.log(`OPENAI_API_KEY:${process.env.OPENAI_API_KEY ?? ""}`);',
			'console.log(`CODEX_CLI_PATH:${process.env.CODEX_CLI_PATH ?? ""}`);',
			'console.log(`APP_SERVER_LABEL:${process.env.CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL ?? ""}`);',
			'console.log(`RUNTIME_PROXY_ENV:${process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY ?? ""}`);',
			'console.log(`NODE_OPTIONS_HAS_APP_SERVER_PRELOAD:${(process.env.NODE_OPTIONS ?? "").includes("codex-multi-auth-app-server-preload.mjs")}`);',
			'const configPath = path.join(process.env.CODEX_HOME ?? "", "config.toml");',
			'console.log(fs.readFileSync(configPath, "utf8"));',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const result = runWrapper(fixtureRoot, ["app-server", "--listen", "stdio://"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain(
			`FORWARDED:app-server --listen stdio:// -c cli_auth_credentials_store="file" -c model_provider="${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		const apiKeyMatch = output.match(/^OPENAI_API_KEY:([0-9a-f]{64})$/m);
		expect(apiKeyMatch?.[1]).toBeTruthy();
		expect(output).toContain("requires_openai_auth = false");
		expect(output).toContain('name = "codex-multi-auth"');
		expect(output).toContain(
			`experimental_bearer_token = "${apiKeyMatch?.[1]}"`,
		);
		expect(output).toContain('wire_api = "responses"');
		expect(output).not.toContain("env_key");
		expect(readFileSync(markerPath, "utf8")).toBe(
			"start:http://127.0.0.1:4567\nclose\n",
		);
	});

	it("rewrites app-server account/read responses to the codex-multi-auth display name", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const readline = require("node:readline");',
			'const rl = readline.createInterface({ input: process.stdin });',
			'rl.on("line", (line) => {',
			"  const message = JSON.parse(line);",
			'  if (message.method === "account/read") {',
			"    console.log(JSON.stringify({",
			'      jsonrpc: "2.0",',
			"      id: message.id,",
			"      result: {",
			'        account: { type: "chatgpt", email: "real-user@example.com", planType: "plus" },',
			"        requiresOpenaiAuth: true,",
			"      },",
			"    }));",
			"    return;",
			"  }",
			'  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));',
			"});",
			'rl.on("close", () => process.exit(0));',
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		const input = [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 7,
				method: "account/read",
				params: { refreshToken: false },
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 8,
				method: "thread/list",
				params: {},
			}),
			"",
		].join("\n");

		const result = runWrapperWithInput(
			fixtureRoot,
			["app-server", "--listen", "stdio://"],
			input,
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				OPENAI_API_KEY: undefined,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("codex-multi-auth");
		expect(result.stdout).not.toContain("real-user@example.com");
		expect(result.stdout).toContain('"requiresOpenaiAuth":false');
		expect(result.stdout).toContain('"id":8');
		expect(result.stdout).toContain('"ok":true');
	});

	it("resumes process stdin when cleaning up app-server protocol proxy listeners", () => {
		const source = readFileSync(
			join(repoRootDir, "scripts", "codex.js"),
			"utf8",
		);
		const cleanupMatch = source.match(
			/cleanupProtocolProxy = \(\) => \{[\s\S]*?child\.stderr\?\.removeListener\("data", onChildStderrData\);[\s\S]*?\};/,
		);

		expect(cleanupMatch?.[0]).toContain("process.stdin.resume();");
	});

	it("suppresses app-server account/read errors with a synthetic multi-auth account", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const readline = require("node:readline");',
			'const rl = readline.createInterface({ input: process.stdin });',
			'rl.on("line", (line) => {',
			"  const message = JSON.parse(line);",
			'  if (message.method === "account/read") {',
			'    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Your access token could not be refreshed because your refresh token was already used" } }));',
			"  }",
			"});",
			'rl.on("close", () => process.exit(0));',
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		const input = `${JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "account/read",
			params: { refreshToken: false },
		})}\n`;

		const result = runWrapperWithInput(
			fixtureRoot,
			["app-server", "--listen", "stdio://"],
			input,
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				OPENAI_API_KEY: undefined,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("codex-multi-auth");
		expect(result.stdout).toContain('"requiresOpenaiAuth":false');
		expect(result.stdout).not.toContain('"error"');
		expect(result.stdout).not.toContain("refresh token was already used");
	});

	it("rewrites app-server auth status and rate-limit responses to avoid ChatGPT auth prompts", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const readline = require("node:readline");',
			'const rl = readline.createInterface({ input: process.stdin });',
			'rl.on("line", (line) => {',
			"  const message = JSON.parse(line);",
			'  if (message.method === "getAuthStatus") {',
			'    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "chatgpt refresh failed" } }));',
			"    return;",
			"  }",
			'  if (message.method === "account/rateLimits/read") {',
			'    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "rate limits need chatgpt auth" } }));',
			"    return;",
			"  }",
			'  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }));',
			"});",
			'rl.on("close", () => process.exit(0));',
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		const input = [
			JSON.stringify({
				jsonrpc: "2.0",
				id: "auth-status",
				method: "getAuthStatus",
				params: { includeToken: true, refreshToken: true },
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: "rate-limits",
				method: "account/rateLimits/read",
			}),
			JSON.stringify({
				jsonrpc: "2.0",
				id: "other",
				method: "thread/list",
				params: {},
			}),
			"",
		].join("\n");

		const result = runWrapperWithInput(
			fixtureRoot,
			["app-server", "--listen", "stdio://"],
			input,
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				OPENAI_API_KEY: undefined,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('"authMethod":"apikey"');
		expect(result.stdout).toContain('"authToken":null');
		expect(result.stdout).toContain('"requiresOpenaiAuth":false');
		expect(result.stdout).toContain('"id":"rate-limits"');
		expect(result.stdout).toContain('"rateLimitsByLimitId":null');
		expect(result.stdout).not.toContain("chatgpt refresh failed");
		expect(result.stdout).not.toContain("rate limits need chatgpt auth");
		expect(result.stdout).toContain('"id":"other"');
	});

	it.each([
		["app help", ["app", "--help"]],
		["app-server help", ["app-server", "--help"]],
		["app-server TypeScript generation", ["app-server", "generate-ts"]],
		["app-server JSON schema generation", ["app-server", "generate-json-schema"]],
	])("does not start runtime rotation proxy for %s", (_label, args) => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const markerPath = join(fixtureRoot, "proxy-marker.txt");

		const result = runWrapper(fixtureRoot, args, {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`FORWARDED:${args.join(" ")}`);
		expect(existsSync(markerPath)).toBe(false);
	});

	it("starts an automatic runtime rotation helper for codex app launches", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const { spawnSync } = require("node:child_process");',
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const { fileURLToPath } = require("node:url");',
			'if (process.argv.slice(2)[0] === "app-server") {',
			'  console.log(`APP_SERVER_FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'  console.log(`APP_SERVER_LABEL_ENV:${process.env.CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL ?? ""}`);',
			"  process.exit(0);",
			"}",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`CODEX_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'console.log(`OPENAI_API_KEY:${process.env.OPENAI_API_KEY ?? ""}`);',
			'console.log(`CODEX_CLI_PATH:${process.env.CODEX_CLI_PATH ?? ""}`);',
			'console.log(`APP_SERVER_LABEL:${process.env.CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL ?? ""}`);',
			'console.log(`RUNTIME_PROXY_ENV:${process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY ?? ""}`);',
			'console.log(`NODE_OPTIONS_HAS_APP_SERVER_PRELOAD:${(process.env.NODE_OPTIONS ?? "").includes("codex-multi-auth-app-server-preload.mjs")}`);',
			'const preloadMatch = (process.env.NODE_OPTIONS ?? "").match(/--import=(\\S*codex-multi-auth-app-server-preload\\.mjs)/);',
			"const preloadCheck = preloadMatch ? spawnSync(process.execPath, ['--check', fileURLToPath(preloadMatch[1])], { encoding: 'utf8' }) : null;",
			'console.log(`APP_SERVER_PRELOAD_CHECK_STATUS:${preloadCheck?.status ?? "missing"}`);',
			'console.log(`APP_SERVER_PRELOAD_CHECK_STDERR:${(preloadCheck?.stderr ?? "").trim()}`);',
			'console.log(`SHADOW_AUTH_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "auth.json"))}`);',
			'console.log(`SHADOW_ACCOUNTS_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "accounts.json"))}`);',
			'console.log(`SHADOW_SESSIONS_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "sessions"))}`);',
			'console.log(`SHADOW_PLUGINS_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "plugins"))}`);',
			'console.log(`SHADOW_SKILLS_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "skills"))}`);',
			'console.log(`SHADOW_MEMORY_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "memory"))}`);',
			"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);",
			'const shimExe = path.join(process.env.CODEX_CLI_PATH ?? "", process.platform === "win32" ? "codex.exe" : "codex");',
			'const shimResult = spawnSync(shimExe, ["app-server", "--shim-probe"], { encoding: "utf8", env: process.env });',
			'console.log(`APP_SERVER_SHIM_STATUS:${shimResult.status}`);',
			'console.log(`APP_SERVER_SHIM_STDOUT:${(shimResult.stdout ?? "").trim()}`);',
			'console.log(`APP_SERVER_SHIM_STDERR:${(shimResult.stderr ?? "").trim()}`);',
			'const configPath = path.join(process.env.CODEX_HOME ?? "", "config.toml");',
			'console.log(fs.readFileSync(configPath, "utf8"));',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		writeFileSync(
			join(originalHome, "auth.json"),
			'{"tokens":{"refresh_token":"stale-refresh-token"}}\n',
			"utf8",
		);
		writeFileSync(
			join(originalHome, "accounts.json"),
			'{"accounts":[{"email":"real-user@example.com"}]}\n',
			"utf8",
		);
		mkdirSync(join(originalHome, "sessions"), { recursive: true });
		mkdirSync(join(originalHome, "plugins"), { recursive: true });
		mkdirSync(join(originalHome, "skills"), { recursive: true });
		mkdirSync(join(originalHome, "memory"), { recursive: true });
		writeFileSync(join(originalHome, "sessions", "session.jsonl"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "plugins", "plugin.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "skills", "skill.md"), "# Skill\n", "utf8");
		writeFileSync(join(originalHome, "memory", "memory.md"), "# Memory\n", "utf8");

		const result = runWrapper(fixtureRoot, ["app", "."], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "1000",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_INDEX: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_LABEL:
				"Account 2 (second@example.com, id:second)",
			CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_EMAIL: "second@example.com",
			CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_ID: "acc_second",
			CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_UPDATED_AT: "12345",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain(
			`FORWARDED:app . -c cli_auth_credentials_store="file" -c model_provider="${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		const apiKeyMatch = output.match(/^OPENAI_API_KEY:([0-9a-f]{64})$/m);
		expect(apiKeyMatch?.[1]).toBeTruthy();
		expect(output).toMatch(/^CODEX_CLI_PATH:.+app-server-shims.+helper-\d+$/m);
		expect(output).toContain("APP_SERVER_LABEL:1");
		expect(output).toContain("RUNTIME_PROXY_ENV:0");
		expect(output).toContain("NODE_OPTIONS_HAS_APP_SERVER_PRELOAD:true");
		expect(output).toContain("APP_SERVER_PRELOAD_CHECK_STATUS:0");
		expect(output).toContain("APP_SERVER_PRELOAD_CHECK_STDERR:");
		expect(output).toContain("SHADOW_AUTH_EXISTS:false");
		expect(output).toContain("SHADOW_ACCOUNTS_EXISTS:false");
		expect(output).toContain("SHADOW_SESSIONS_EXISTS:true");
		expect(output).toContain("SHADOW_PLUGINS_EXISTS:true");
		expect(output).toContain("SHADOW_SKILLS_EXISTS:true");
		expect(output).toContain("SHADOW_MEMORY_EXISTS:true");
		expect(output).toContain("APP_SERVER_SHIM_STATUS:0");
		expect(output).toContain(
			"APP_SERVER_SHIM_STDOUT:APP_SERVER_FORWARDED:app-server --shim-probe",
		);
		expect(output).toContain("APP_SERVER_LABEL_ENV:1");
		expect(output).toContain("requires_openai_auth = false");
		expect(output).toContain(
			`experimental_bearer_token = "${apiKeyMatch?.[1]}"`,
		);
		expect(output).toContain('wire_api = "responses"');
		expect(output).not.toContain("env_key");
		const shadowHomeMatch = output.match(/^CODEX_HOME:(.+)$/m);
		expect(shadowHomeMatch?.[1]).toBeTruthy();
		const cliPathMatch = output.match(/^CODEX_CLI_PATH:(.+)$/m);
		expect(cliPathMatch?.[1]).toBeTruthy();
		if (cliPathMatch?.[1] && shadowHomeMatch?.[1]) {
			expect(cliPathMatch[1].startsWith(shadowHomeMatch[1])).toBe(false);
		}

		await sleep(2200);

		expect(readFileSync(markerPath, "utf8")).toBe(
			"start:http://127.0.0.1:4567\nclose\n",
		);
		const helperStatus = JSON.parse(
			readFileSync(join(multiAuthDir, "runtime-rotation-app-helper.json"), "utf8"),
		) as {
			state: string;
			totalRequests: number;
			lastAccountIndex: number | null;
			lastAccountLabel: string | null;
			lastAccountId: string | null;
			lastAccountUpdatedAt: number | null;
		};
		expect(helperStatus.state).toBe("idle-timeout");
		expect(helperStatus.totalRequests).toBe(0);
		expect(helperStatus.lastAccountIndex).toBe(1);
		expect(helperStatus.lastAccountLabel).toBe("Account 2");
		expect(helperStatus).not.toHaveProperty("lastAccountEmail");
		expect(helperStatus.lastAccountId).toBe("acc_second");
		expect(helperStatus.lastAccountUpdatedAt).toBe(12345);
		if (process.platform !== "win32") {
			expect(
				statSync(join(multiAuthDir, "runtime-rotation-app-helper.json")).mode &
					0o777,
			).toBe(0o600);
		}
		if (shadowHomeMatch?.[1]) {
			expect(existsSync(shadowHomeMatch[1])).toBe(false);
		}
		if (cliPathMatch?.[1]) {
			expect(existsSync(cliPathMatch[1])).toBe(false);
		}
	});

	it("sweeps stale app-server shim directories when a helper starts", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'console.log(`STALE_SHIM_EXISTS:${fs.existsSync(process.env.CODEX_MULTI_AUTH_TEST_STALE_SHIM_DIR ?? "")}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		const staleShimDir = join(
			multiAuthDir,
			"app-server-shims",
			"helper-2147483647",
		);
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(staleShimDir, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		writeFileSync(
			join(staleShimDir, process.platform === "win32" ? "codex.exe" : "codex"),
			"stale\n",
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["app", "."], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_STALE_SHIM_DIR: staleShimDir,
			OPENAI_API_KEY: undefined,
		});

		expect(result.status).toBe(0);
		expect(combinedOutput(result)).toContain("STALE_SHIM_EXISTS:false");
		expect(existsSync(staleShimDir)).toBe(false);
		await waitForFileText(
			markerPath,
			"start:http://127.0.0.1:4567\nclose\n",
		);
	});

	it("keeps app helpers alive when owner liveness probes return EPERM", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		const preloadPath = join(fixtureRoot, "owner-eperm-preload.mjs");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		writeFileSync(
			preloadPath,
			[
				"const originalKill = process.kill.bind(process);",
				"process.kill = (pid, signal) => {",
				"  if (signal === 0 && String(pid) === process.env.CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID) {",
				'    const error = new Error("operation not permitted");',
				'    error.code = "EPERM";',
				"    throw error;",
				"  }",
				"  return originalKill(pid, signal);",
				"};",
			].join("\n"),
			"utf8",
		);

		const helper = spawn(
			process.execPath,
			[join(fixtureRoot, "scripts", "codex.js"), "--codex-multi-auth-runtime-app-helper"],
			{
				env: buildWrapperEnv({
					CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_DIR: multiAuthDir,
					CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
					CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
					CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
					CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
					NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
				}),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		const closed = new Promise<void>((resolve) => {
			helper.once("close", () => resolve());
		});
		helper.stdout?.setEncoding("utf8");
		helper.stderr?.setEncoding("utf8");
		helper.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		helper.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		try {
			const ready = await new Promise<{ statusPath: string }>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error(`helper did not become ready\n${stdout}\n${stderr}`));
				}, 5_000);
				helper.stdout?.on("data", () => {
					const newlineIndex = stdout.indexOf("\n");
					if (newlineIndex < 0) return;
					try {
						const message = JSON.parse(stdout.slice(0, newlineIndex)) as {
							type?: string;
							statusPath?: string;
						};
						if (message.type === "ready" && message.statusPath) {
							clearTimeout(timeout);
							resolve({ statusPath: message.statusPath });
						}
					} catch (error) {
						clearTimeout(timeout);
						reject(error);
					}
				});
				helper.once("close", () => {
					clearTimeout(timeout);
					reject(new Error(`helper exited before ready\n${stdout}\n${stderr}`));
				});
			});

			await sleep(750);

			expect(helper.pid).toBeTruthy();
			expect(isProcessAlive(helper.pid ?? -1)).toBe(true);
			const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
				state: string;
			};
			expect(status.state).toBe("running");
			expect(readFileSync(markerPath, "utf8")).toBe("start:http://127.0.0.1:4567\n");
		} finally {
			if (helper.pid && isProcessAlive(helper.pid)) {
				helper.kill("SIGTERM");
			}
			await Promise.race([closed, sleep(2_000)]);
			if (helper.pid && isProcessAlive(helper.pid)) {
				helper.kill("SIGKILL");
				await Promise.race([closed, sleep(2_000)]);
			}
		}
	});

	it("stops failed app helpers before unsupported-model retries", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const stateDir = join(fixtureRoot, "retry-state-app-helper");
		mkdirSync(stateDir, { recursive: true });
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const counterPath = path.join(process.env.CODEX_MULTI_AUTH_TEST_STATE_DIR, 'attempt.txt');",
			"const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
			"fs.writeFileSync(counterPath, String(attempt + 1), 'utf8');",
			"const args = process.argv.slice(2);",
			"const modelIndex = args.indexOf('--model');",
			"const requestedModel = modelIndex >= 0 ? args[modelIndex + 1] : 'unknown-model';",
			"if (attempt === 0) {",
			`  console.error("ERROR: {\\\"type\\\":\\\"error\\\",\\\"status\\\":400,\\\"error\\\":{\\\"type\\\":\\\"invalid_request_error\\\",\\\"message\\\":\\\"The '" + requestedModel + "' model is not supported when using Codex with a ChatGPT account.\\\"}}");`,
			"  process.exit(1);",
			"}",
			"console.log(`FORWARDED:${args.join(' ')}`);",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["app", ".", "--model", "gpt-5.5"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACH_GRACE_MS: "10000",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "600",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID: "1",
				CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
				CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "1",
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain("Retrying with gpt-5.4");
		expect(output).toContain("FORWARDED:app . --model gpt-5.4");
		const markerAfterRetry = readFileSync(markerPath, "utf8")
			.trim()
			.split(/\r?\n/);
		const firstStart = markerAfterRetry[0] ?? "";
		const secondStart = markerAfterRetry.find(
			(line, index) =>
				index > 0 && line.startsWith("start:http://127.0.0.1:4567:pid="),
		);
		const firstPid = Number(firstStart.match(/:pid=(\d+)$/)?.[1] ?? NaN);
		expect(firstStart).toMatch(/^start:http:\/\/127\.0\.0\.1:4567:pid=\d+$/);
		expect(secondStart).toMatch(
			/^start:http:\/\/127\.0\.0\.1:4567:pid=\d+$/,
		);
		expect(Number.isFinite(firstPid)).toBe(true);
		expect(isProcessAlive(firstPid)).toBe(false);
		if (process.platform !== "win32") {
			expect(markerAfterRetry.slice(0, 3)).toEqual([
				firstStart,
				"close",
				secondStart,
			]);
		}

		await sleep(2200);

		expect(readFileSync(markerPath, "utf8")).toContain("close\n");
	});

	it("starts detached app helpers against the real Codex home instead of a compatibility shadow", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`CODEX_HOME:${process.env.CODEX_HOME ?? ""}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_reasoning_effort = "xhigh"\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["app", ".", "--model", "gpt-5.1"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "1000",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER_ENV: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain("FORWARDED:app . --model gpt-5.1");

		await sleep(2200);

		const marker = readFileSync(markerPath, "utf8");
		expect(marker).toContain(`real-home-env:${originalHome}\n`);
		const compatibilityHomeMatch = marker.match(/^codex-home-env:(.+)$/m);
		expect(compatibilityHomeMatch?.[1]).toBeTruthy();
		expect(compatibilityHomeMatch?.[1]).not.toBe(originalHome);
		expect(marker).toContain("close\n");
	});

	it("writes app router status files with owner-only permissions", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const bindDir = join(fixtureRoot, "app-bind");
		const statePath = join(bindDir, "state.json");
		const statusPath = join(bindDir, "status.json");
		mkdirSync(bindDir, { recursive: true });
		writeFileSync(
			statePath,
			`${JSON.stringify({
				clientApiKey: "router-secret",
				host: "127.0.0.1",
				port: 0,
				baseUrl: "http://127.0.0.1:0",
				statusPath,
			})}\n`,
			"utf8",
		);
		let stderr = "";
		const child = spawn(
			process.execPath,
			[
				join(fixtureRoot, "scripts", "codex-app-router.js"),
				"--port",
				"0",
				"--status",
				statusPath,
				"--state",
				statePath,
			],
			{
				cwd: fixtureRoot,
				env: { ...process.env },
				stdio: ["ignore", "ignore", "pipe"],
				windowsHide: true,
			},
		);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		try {
			for (let attempt = 0; attempt < 40 && !existsSync(statusPath); attempt += 1) {
				await sleep(50);
			}
			if (!existsSync(statusPath)) {
				throw new Error(stderr || "router status file was not written");
			}
			expect(existsSync(statusPath)).toBe(true);
			if (process.platform !== "win32") {
				expect(statSync(statusPath).mode & 0o777).toBe(0o600);
			}
		} finally {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				child.once("close", () => resolve());
				setTimeout(resolve, 1000);
			});
		}
		expect(
			readdirSync(bindDir).filter((entry) =>
				entry.startsWith(".status.json.") && entry.endsWith(".tmp"),
			),
		).toEqual([]);
	});

	it("records forwarded exec traffic in runtime observability when the child process does not update it", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeObservabilityFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
		});

		expect(result.status).toBe(0);
		const snapshot = JSON.parse(
			readFileSync(join(multiAuthDir, "runtime-observability.json"), "utf8"),
		) as {
			responsesRequests: number;
			runtimeMetrics: {
				totalRequests: number;
				responsesRequests: number;
				successfulRequests: number;
				failedRequests: number;
				lastRequestAt: number | null;
				lastError: string | null;
			};
		};
		expect(snapshot.responsesRequests).toBe(1);
		expect(snapshot.runtimeMetrics.totalRequests).toBe(1);
		expect(snapshot.runtimeMetrics.responsesRequests).toBe(1);
		expect(snapshot.runtimeMetrics.successfulRequests).toBe(1);
		expect(snapshot.runtimeMetrics.failedRequests).toBe(0);
		expect(snapshot.runtimeMetrics.lastRequestAt).not.toBeNull();
		expect(snapshot.runtimeMetrics.lastError).toBeNull();
	});

	it("does not double-count forwarded exec traffic when the child process already updates runtime observability", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeObservabilityFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const root = process.env.CODEX_MULTI_AUTH_DIR ?? "";',
			'const snapshotPath = path.join(root, "runtime-observability.json");',
			"const snapshot = {",
			"  version: 1,",
			"  updatedAt: Date.now(),",
			"  currentRequestId: null,",
			"  responsesRequests: 1,",
			"  authRefreshRequests: 0,",
			"  diagnosticProbeRequests: 0,",
			"  poolExhaustionCooldownUntil: null,",
			"  serverBurstCooldownUntil: null,",
			"  runtimeMetrics: {",
			"    startedAt: Date.now(),",
			"    totalRequests: 1,",
			"    successfulRequests: 1,",
			"    failedRequests: 0,",
			"    responsesRequests: 1,",
			"    authRefreshRequests: 0,",
			"    diagnosticProbeRequests: 0,",
			"    outboundRequestAttemptBudget: null,",
			"    outboundRequestAttemptsConsumed: 0,",
			"    requestAttemptBudgetExhaustions: 0,",
			"    poolExhaustionFastFails: 0,",
			"    serverBurstFastFails: 0,",
			"    rateLimitedResponses: 0,",
			"    serverErrors: 0,",
			"    networkErrors: 0,",
			"    userAborts: 0,",
			"    authRefreshFailures: 0,",
			"    emptyResponseRetries: 0,",
			"    accountRotations: 0,",
			"    sameAccountRetries: 0,",
			"    streamFailoverAttempts: 0,",
			"    streamFailoverCandidatesConsidered: 0,",
			"    lastStreamFailoverCandidateCount: 0,",
			"    streamFailoverRecoveries: 0,",
			"    streamFailoverCrossAccountRecoveries: 0,",
			"    cumulativeLatencyMs: 10,",
			"    lastRequestAt: Date.now(),",
			"    lastError: null,",
			"  },",
			"};",
			"fs.mkdirSync(root, { recursive: true });",
			"fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');",
			"process.exit(0);",
		]);
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
		});

		expect(result.status).toBe(0);
		const snapshot = JSON.parse(
			readFileSync(join(multiAuthDir, "runtime-observability.json"), "utf8"),
		) as {
			responsesRequests: number;
			runtimeMetrics: {
				totalRequests: number;
				responsesRequests: number;
				successfulRequests: number;
			};
		};
		expect(snapshot.responsesRequests).toBe(1);
		expect(snapshot.runtimeMetrics.totalRequests).toBe(1);
		expect(snapshot.runtimeMetrics.responsesRequests).toBe(1);
		expect(snapshot.runtimeMetrics.successfulRequests).toBe(1);
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

	it("creates a compatibility CODEX_HOME shadow when the requested model cannot accept xhigh defaults", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`CODEX_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'console.log(`CODEX_MULTI_AUTH_DIR_JSON:${JSON.stringify(process.env.CODEX_MULTI_AUTH_DIR ?? null)}`);',
			'const configPath = path.join(process.env.CODEX_HOME ?? "", "config.toml");',
			'const authPath = path.join(process.env.CODEX_HOME ?? "", "auth.json");',
			'console.log(`AUTH_EXISTS:${fs.existsSync(authPath)}`);',
			'if (fs.existsSync(authPath)) {',
			'  console.log(`AUTH_JSON:${fs.readFileSync(authPath, "utf8").trim()}`);',
			'  console.log(`AUTH_MODE:${(fs.statSync(authPath).mode & 0o777).toString(8)}`);',
			'}',
			'console.log("CONFIG_START");',
			'console.log(fs.readFileSync(configPath, "utf8").trim());',
			'console.log(`CONFIG_MODE:${(fs.statSync(configPath).mode & 0o777).toString(8)}`);',
			'console.log("CONFIG_END");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(
			join(originalHome, "config.toml"),
			[
				'model_reasoning_effort = "xhigh"',
				'profile = "legacy-full-access"',
				"",
				'[profiles."legacy-full-access"]',
				'model_reasoning_effort = "xhigh"',
				"",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.1"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: undefined,
		});

		expect(result.status).toBe(0);
		const output = combinedOutput(result);
		expect(output).toContain('FORWARDED:exec status --model gpt-5.1 -c cli_auth_credentials_store="file"');
		expect(output).not.toContain(`CODEX_HOME:${originalHome}`);
		expect(output).toContain("CODEX_MULTI_AUTH_DIR_JSON:null");
		expect(output).toContain("AUTH_EXISTS:true");
		expect(output).toContain("AUTH_JSON:{}");
		expect(output).toContain("AUTH_MODE:");
		expect(output).toContain('model_reasoning_effort = "high"');
		expect(output).toContain("CONFIG_MODE:");
		expect(output).not.toContain('model_reasoning_effort = "xhigh"');
		if (process.platform !== "win32") {
			expect(output).toContain("AUTH_MODE:600");
			expect(output).toContain("CONFIG_MODE:600");
		}
	});

	it("cleans up compatibility shadow homes when staging fails", () => {
		const fixtureRoot = createWrapperFixture();
		const cleanupFailureEnv = injectShadowCleanupBusyFailures();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		mkdirSync(join(originalHome, "accounts.json"), { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_reasoning_effort = "xhigh"\n',
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...cleanupFailureEnv,
			},
		);

		expect(result.status).toBe(1);
	expect(
		readdirSync(controlledTmp).filter((entry) =>
			entry.startsWith("codex-multi-auth-home-"),
			),
		).toEqual([]);
	});

	it("syncs copied shadow directories back before cleanup", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.mkdirSync(path.join(home, "sessions"), { recursive: true });',
			'fs.writeFileSync(path.join(home, "sessions", "new.jsonl"), "new-session\\n", "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		const fakeLinkPath = join(fixtureRoot, "fake-link");
		mkdirSync(join(originalHome, "sessions"), { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "sessions", "existing.jsonl"), "existing\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.1"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			TMP: controlledTmp,
			TEMP: controlledTmp,
			TMPDIR: controlledTmp,
			PATH: `${fakeLinkPath}${delimiter}${process.env.PATH ?? ""}`,
			npm_config_prefix: fixtureRoot,
			CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_DIR_COPY: "1",
		});

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "sessions", "existing.jsonl"), "utf8")).toBe("existing\n");
		expect(readFileSync(join(originalHome, "sessions", "new.jsonl"), "utf8")).toBe("new-session\n");
	});

	it("syncs refreshed auth state back from compatibility shadow homes before cleanup", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			'console.log(`CODEX_HOME:${home}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"shadow"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
	expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
	expect(
		readdirSync(controlledTmp).filter((entry) =>
			entry.startsWith("codex-multi-auth-home-"),
		),
		).toEqual([]);
	});

	it("preserves the later auth sync-back from concurrent compatibility shadow homes", async () => {
		const fixtureRoot = createWrapperFixture();
		const markerDir = join(fixtureRoot, "markers");
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const id = process.env.CODEX_MULTI_AUTH_TEST_SESSION_ID ?? "missing";',
			'const home = process.env.CODEX_HOME ?? "";',
			'const markerDir = process.env.CODEX_MULTI_AUTH_TEST_MARKER_DIR ?? "";',
			'fs.mkdirSync(markerDir, { recursive: true });',
			'fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ token: id }) + "\\n", "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), JSON.stringify({ accounts: [id] }) + "\\n", "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({ last: id }) + "\\n", "utf8");',
			'fs.writeFileSync(path.join(markerDir, `${id}.ready`), "ready\\n", "utf8");',
			'const releasePath = path.join(markerDir, `${id}.release`);',
			"const waitForRelease = () => {",
			"  if (fs.existsSync(releasePath)) process.exit(0);",
			"  setTimeout(waitForRelease, 10);",
			"};",
			"waitForRelease();",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");

		const commonEnv = {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_TEST_MARKER_DIR: markerDir,
			TMP: controlledTmp,
			TEMP: controlledTmp,
			TMPDIR: controlledTmp,
		};
		const first = runWrapperAsync(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				...commonEnv,
				CODEX_MULTI_AUTH_TEST_SESSION_ID: "first",
				...injectShadowSyncMetadataBusyFailures(),
			},
		);
		const second = runWrapperAsync(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				...commonEnv,
				CODEX_MULTI_AUTH_TEST_SESSION_ID: "second",
			},
		);

		await waitForPath(join(markerDir, "first.ready"));
		await waitForPath(join(markerDir, "second.ready"));

		writeFileSync(join(markerDir, "first.release"), "release\n", "utf8");
		expect((await first).status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe(
			'{"token":"first"}',
		);

		writeFileSync(join(markerDir, "second.release"), "release\n", "utf8");
		expect((await second).status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe(
			'{"token":"second"}',
		);
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe(
			'{"accounts":["second"]}',
		);
		expect(
			readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim(),
		).toBe('{"last":"second"}');
	});

	it("continues shadow-home state sync after one state file remains locked", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(
			join(originalHome, "accounts.json"),
			'{"accounts":["original"]}\n',
			"utf8",
		);
		writeFileSync(
			join(originalHome, ".codex-global-state.json"),
			'{"last":"original"}\n',
			"utf8",
		);
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_reasoning_effort = "xhigh"\n',
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowCleanupBusyFailures(4),
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"original"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
	});

	it("retries transient shadow sync lock owner write failures before sync-back", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowLockOwnerWriteFailures(1),
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"shadow"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
		expect(existsSync(lockDir)).toBe(false);
	});

	it("removes orphaned shadow sync locks when owner metadata cannot be written", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowLockOwnerWriteFailures(99),
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"original"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["original"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"original"}');
		expect(existsSync(lockDir)).toBe(false);
	});

	it("removes stale shadow sync locks before publishing refreshed auth state", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");
		const staleOwner = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
			encoding: "utf8",
			windowsHide: true,
		});
		expect(staleOwner.status).toBe(0);
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "owner.json"),
			`${JSON.stringify({ pid: staleOwner.pid, createdAt: 1 })}\n`,
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"shadow"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
		expect(existsSync(lockDir)).toBe(false);
	});

	it.each([
		["missing owner metadata", undefined],
		["corrupt owner metadata", "{not-json"],
	])("removes orphaned shadow sync locks with %s", async (_caseName, ownerContent) => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });
		if (ownerContent !== undefined) {
			writeFileSync(join(lockDir, "owner.json"), ownerContent, "utf8");
		}
		await ageShadowSyncLockForSteal(lockDir);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"shadow"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
		expect(existsSync(lockDir)).toBe(false);
	});

	it("keeps retrying after consecutive stale shadow sync locks", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "owner.json"),
			`${JSON.stringify({ pid: 2_147_483_647, createdAt: 1 })}\n`,
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowLockRecreatedStaleCount(2),
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"shadow"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
		expect(existsSync(lockDir)).toBe(false);
	});

	it("writes shadow sync lock owner metadata with owner-only permissions", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "owner.json"),
			`${JSON.stringify({ pid: 2_147_483_647, createdAt: 1 })}\n`,
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowLockRecreatedStaleCount(99),
			},
		);

		expect(result.status).toBe(0);
		expect(existsSync(lockDir)).toBe(true);
		const ownerPath = join(lockDir, "owner.json");
		expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({
			pid: 2_147_483_647,
			createdAt: 1,
		});
		if (process.platform !== "win32") {
			expect(statSync(ownerPath).mode & 0o777).toBe(0o600);
		}
	});

	it("waits for fresh orphaned shadow sync locks to become stale before stealing", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });

		const startedAt = Date.now();
		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
			},
		);

		expect(result.status).toBe(0);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"shadow"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
		expect(existsSync(lockDir)).toBe(false);
	});

	it("syncs unchanged auth bundle files when a sibling changes during shadow use", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'const originalHome = process.env.CODEX_MULTI_AUTH_TEST_EXTERNAL_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			'if (originalHome) {',
			'  fs.writeFileSync(path.join(originalHome, "auth.json"), \'{"token":"external"}\\n\', "utf8");',
			'}',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_TEST_EXTERNAL_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowCleanupBusyFailures(),
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"external"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
	});

	it("does not clobber sync-back files that change during rename retry backoff", () => {
		const fixtureRoot = createWrapperFixture();
		const retryMarkerDir = join(fixtureRoot, "retry-markers");
		const accountsRetryMarker = join(retryMarkerDir, "accounts.json.retry-1");
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const { spawn } = require("node:child_process");',
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'const retryMarker = process.env.CODEX_MULTI_AUTH_TEST_RETRY_MARKER ?? "";',
			'const originalHome = process.env.CODEX_MULTI_AUTH_TEST_EXTERNAL_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"if (originalHome && retryMarker) {",
			"  const mutateScript = [",
			'    \'const fs = require("node:fs");\',',
			'    \'const path = require("node:path");\',',
			'    \'const markerPath = process.argv[1];\',',
			'    \'const target = process.argv[2];\',',
			'    \'const startedAt = Date.now();\',',
			'    \'const waitForMarker = () => {\',',
			'    \'  if (fs.existsSync(markerPath)) {\',',
			'    \'  fs.writeFileSync(path.join(target, \"accounts.json\"), \"{\\\\\"accounts\\\\\":[\\\\\"external-during-retry\\\\\"]}\\\\n\", \"utf8\");\',',
			'    \'  fs.writeFileSync(path.join(target, \".codex-global-state.json\"), \"{\\\\\"last\\\\\":\\\\\"external-during-retry\\\\\"}\\\\n\", \"utf8\");\',',
			'    \'  process.exit(0);\',',
			'    \'  }\',',
			'    \'  if (Date.now() - startedAt > 5000) {\',',
			'    \'    process.exit(2);\',',
			'    \'  }\',',
			'    \'  setTimeout(waitForMarker, 5);\',',
			'    \'};\',',
			'    \'waitForMarker();\',',
			"  ].join(\"\\n\");",
			"  const mutator = spawn(process.execPath, [\"-e\", mutateScript, retryMarker, originalHome], {",
			"    detached: true,",
			'    stdio: "ignore",',
			"  });",
			"  mutator.unref();",
			"}",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		mkdirSync(retryMarkerDir, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_TEST_EXTERNAL_HOME: originalHome,
				CODEX_MULTI_AUTH_TEST_RETRY_MARKER: accountsRetryMarker,
				CODEX_MULTI_AUTH_TEST_SHADOW_RETRY_MARKER_DIR: retryMarkerDir,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowCleanupBusyFailures(3),
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"original"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe(
			'{"accounts":["external-during-retry"]}',
		);
		expect(
			readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim(),
		).toBe('{"last":"external-during-retry"}');
	});

	it("retries preflight destination reads when the sync-back target is transiently locked", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const home = process.env.CODEX_HOME ?? "";',
			'fs.writeFileSync(path.join(home, "auth.json"), \'{"token":"shadow"}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, "accounts.json"), \'{"accounts":["shadow"]}\\n\', "utf8");',
			'fs.writeFileSync(path.join(home, ".codex-global-state.json"), \'{"last":"shadow"}\\n\', "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "accounts.json"), '{"accounts":["original"]}\n', "utf8");
		writeFileSync(join(originalHome, ".codex-global-state.json"), '{"last":"original"}\n', "utf8");
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "xhigh"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				...injectShadowCleanupBusyFailures(1),
				...injectShadowPreflightReadBusyFailures(2),
			},
		);

		expect(result.status).toBe(0);
		expect(readFileSync(join(originalHome, "auth.json"), "utf8").trim()).toBe('{"token":"shadow"}');
		expect(readFileSync(join(originalHome, "accounts.json"), "utf8").trim()).toBe('{"accounts":["shadow"]}');
		expect(readFileSync(join(originalHome, ".codex-global-state.json"), "utf8").trim()).toBe('{"last":"shadow"}');
	});

	it("rewrites unquoted config reasoning effort values for mini compatibility models", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'const configPath = path.join(process.env.CODEX_HOME ?? "", "config.toml");',
			'console.log("CONFIG_START");',
			'console.log(fs.readFileSync(configPath, "utf8").trim());',
			'console.log("CONFIG_END");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(
			join(originalHome, "config.toml"),
			[
				"model_reasoning_effort = xhigh",
				'profile = "legacy-full-access"',
				"",
				'[profiles."legacy-full-access"]',
				"model_reasoning_effort = xhigh # keep comment",
				"",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.1-codex-mini"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(result.status).toBe(0);
		const output = combinedOutput(result);
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.1-codex-mini -c cli_auth_credentials_store="file"',
		);
		expect(output).toContain("model_reasoning_effort = high");
		expect(output).toContain("model_reasoning_effort = high # keep comment");
		expect(output).not.toContain("model_reasoning_effort = xhigh");
	});

	it("downgrades explicit unsupported reasoning overrides before forwarding", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		const result = runWrapper(
			fixtureRoot,
			[
				"exec",
				"status",
				"--model",
				"gpt-5.1",
				"-c",
				'model_reasoning_effort="xhigh"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec status --model gpt-5.1 -c model_reasoning_effort="high" -c cli_auth_credentials_store="file"',
		);
		expect(result.stdout).not.toContain('model_reasoning_effort="xhigh"');
	});

	it("downgrades explicit unsupported reasoning overrides for codex mini variants", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		const result = runWrapper(
			fixtureRoot,
			[
				"exec",
				"status",
				"--model",
				"gpt-5.1-codex-mini",
				"-c",
				'model_reasoning_effort="xhigh"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(result.status).toBe(0);
	expect(result.stdout).toContain(
		'FORWARDED:exec status --model gpt-5.1-codex-mini -c model_reasoning_effort="high" -c cli_auth_credentials_store="file"',
	);
	expect(result.stdout).not.toContain('model_reasoning_effort="xhigh"');
	});

	it("coerces reasoning overrides for reasoning-suffixed general-model aliases", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		for (const model of ["gpt-5-low", "gpt-5-chat-latest-low"]) {
			const result = runWrapper(
				fixtureRoot,
				[
					"exec",
					"status",
					"--model",
					model,
					"-c",
					'model_reasoning_effort="xhigh"',
				],
				{
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
					CODEX_HOME: originalHome,
				},
			);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				`FORWARDED:exec status --model ${model} -c model_reasoning_effort="high" -c cli_auth_credentials_store="file"`,
			);
			expect(result.stdout).not.toContain('model_reasoning_effort="xhigh"');
		}
	});

	it("forwards GPT-5.5 aliases unchanged when the downstream CLI accepts them", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		const baseResult = runWrapper(
			fixtureRoot,
			[
				"exec",
				"status",
				"--model",
				"gpt-5.5-high",
				"-c",
				'model_reasoning_effort="minimal"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(baseResult.status).toBe(0);
		expect(baseResult.stdout).toContain(
			'FORWARDED:exec status --model gpt-5.5-high -c model_reasoning_effort="low" -c cli_auth_credentials_store="file"',
		);

		const proResult = runWrapper(
			fixtureRoot,
			[
				"exec",
				"status",
				"--model",
				"gpt-5.5-pro",
				"-c",
				'model_reasoning_effort="low"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(proResult.status).toBe(0);
		expect(proResult.stdout).toContain(
			'FORWARDED:exec status --model gpt-5.5-pro -c model_reasoning_effort="medium" -c cli_auth_credentials_store="file"',
		);
	});

	it("retries GPT-5.5 aliases with gpt-5.4 after unsupported-model failures", () => {
		const fixtureRoot = createWrapperFixture();
		const stateDir = join(fixtureRoot, "retry-state");
		mkdirSync(stateDir, { recursive: true });
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const counterPath = path.join(process.env.CODEX_MULTI_AUTH_TEST_STATE_DIR, 'attempt.txt');",
			"const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
			"fs.writeFileSync(counterPath, String(attempt + 1), 'utf8');",
			"const args = process.argv.slice(2);",
			"const modelIndex = args.indexOf('--model');",
			"const requestedModel = modelIndex >= 0 ? args[modelIndex + 1] : 'unknown-model';",
			"if (attempt === 0) {",
			`  console.error("ERROR: {\\\"type\\\":\\\"error\\\",\\\"status\\\":400,\\\"error\\\":{\\\"type\\\":\\\"invalid_request_error\\\",\\\"message\\\":\\\"The '" + requestedModel + "' model is not supported when using Codex with a ChatGPT account.\\\"}}");`,
			"  process.exit(1);",
			"}",
			"console.log(`FORWARDED:${args.join(' ')}`);",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		const result = runWrapper(
			fixtureRoot,
			[
				"exec",
				"status",
				"--model",
				"gpt-5.5-pro",
				"-c",
				'model_reasoning_effort="low"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
				CODEX_HOME: originalHome,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain(
			"The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account.",
		);
		expect(output).toContain("Retrying with gpt-5.4");
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.4 -c model_reasoning_effort="low" -c cli_auth_credentials_store="file"',
		);
	});

	it("honors explicit capture output override for unsupported-model retries", () => {
		const fixtureRoot = createWrapperFixture();
		const stateDir = join(fixtureRoot, "retry-state-capture-override");
		mkdirSync(stateDir, { recursive: true });
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const counterPath = path.join(process.env.CODEX_MULTI_AUTH_TEST_STATE_DIR, 'attempt.txt');",
			"const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
			"fs.writeFileSync(counterPath, String(attempt + 1), 'utf8');",
			"const args = process.argv.slice(2);",
			"const modelIndex = args.indexOf('--model');",
			"const requestedModel = modelIndex >= 0 ? args[modelIndex + 1] : 'unknown-model';",
			"if (attempt === 0) {",
			`  console.error("ERROR: {\\\"type\\\":\\\"error\\\",\\\"status\\\":400,\\\"error\\\":{\\\"type\\\":\\\"invalid_request_error\\\",\\\"message\\\":\\\"The '" + requestedModel + "' model is not supported when using Codex with a ChatGPT account.\\\"}}");`,
			"  process.exit(1);",
			"}",
			"console.log(`FORWARDED:${args.join(' ')}`);",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.5"], {
			CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
			CODEX_HOME: originalHome,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(readFileSync(join(stateDir, "attempt.txt"), "utf8")).toBe("2");
		expect(output).toContain("Retrying with gpt-5.4");
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.4 -c cli_auth_credentials_store="file"',
		);
	});

	it("can forward without capturing child stdio for terminal-sensitive Codex runs", () => {
		const fixtureRoot = createWrapperFixture();
		const stateDir = join(fixtureRoot, "no-capture-state");
		mkdirSync(stateDir, { recursive: true });
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const counterPath = path.join(process.env.CODEX_MULTI_AUTH_TEST_STATE_DIR, 'attempt.txt');",
			"const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
			"fs.writeFileSync(counterPath, String(attempt + 1), 'utf8');",
			"console.error(\"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.\");",
			"process.exit(1);",
		]);

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.5"], {
			CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "0",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
			CODEX_HOME: originalHome,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(1);
		expect(readFileSync(join(stateDir, "attempt.txt"), "utf8")).toBe("1");
		expect(output).toContain(
			"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
		);
		expect(output).not.toContain("Retrying with gpt-5.4");
	});

	it("retries GPT-5.5 after access-denied style model errors", () => {
		const fixtureRoot = createWrapperFixture();
		const stateDir = join(fixtureRoot, "retry-state-access");
		mkdirSync(stateDir, { recursive: true });
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const counterPath = path.join(process.env.CODEX_MULTI_AUTH_TEST_STATE_DIR, 'attempt.txt');",
			"const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
			"fs.writeFileSync(counterPath, String(attempt + 1), 'utf8');",
			"const args = process.argv.slice(2);",
			"const modelIndex = args.indexOf('--model');",
			"const requestedModel = modelIndex >= 0 ? args[modelIndex + 1] : 'unknown-model';",
			"if (attempt === 0) {",
			'  console.error("ERROR: stream disconnected before completion: The model `" + requestedModel + "` does not exist or you do not have access to it.");',
			"  process.exit(1);",
			"}",
			"console.log(`FORWARDED:${args.join(' ')}`);",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		const result = runWrapper(
			fixtureRoot,
			[
				"exec",
				"status",
				"--model",
				"gpt-5.5",
				"-c",
				'model_reasoning_effort="minimal"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
				CODEX_HOME: originalHome,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain(
			"The model `gpt-5.5` does not exist or you do not have access to it.",
		);
		expect(output).toContain("Retrying with gpt-5.4");
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.4 -c model_reasoning_effort="low" -c cli_auth_credentials_store="file"',
		);
	});

	it("preserves explicit xhigh overrides for models that support them", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(join(originalHome, "config.toml"), "", "utf8");

		const result = runWrapper(
			fixtureRoot,
			[
				"exec",
				"status",
				"--model",
				"gpt-5.4",
				"-c",
				'model_reasoning_effort="xhigh"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec status --model gpt-5.4 -c model_reasoning_effort="xhigh" -c cli_auth_credentials_store="file"',
		);
	});

	it("rewrites config reasoning effort when the model supports xhigh but rejects none", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(`CODEX_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'const configPath = path.join(process.env.CODEX_HOME ?? "", "config.toml");',
			'console.log(fs.readFileSync(configPath, "utf8").trim());',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "auth.json"), "{}\n", "utf8");
		writeFileSync(
			join(originalHome, "config.toml"),
			[
				'model_reasoning_effort = "none"',
				'profile = "legacy-pro"',
				"",
				'[profiles."legacy-pro"]',
				'model_reasoning_effort = "none"',
				"",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.4-pro"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain(`CODEX_HOME:${originalHome}`);
		expect(result.stdout).toContain('model_reasoning_effort = "medium"');
		expect(result.stdout).not.toContain('model_reasoning_effort = "none"');
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
				CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD: "1",
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

	it("prefers native codex executables on PATH when npm launcher is unavailable", () => {
		const pathEntries = [join("C:", "custom", "bin")];
		const nativeCodexPath =
			process.platform === "win32"
				? join(pathEntries[0], "codex.exe")
				: join("/opt", "homebrew", "bin", "codex");
		const resolved = resolveRealCodexBin({
			env: {
				PATH: process.platform === "win32" ? pathEntries.join(";") : "/opt/homebrew/bin:/usr/bin",
			},
			argv: [process.execPath, join(repoRootDir, "scripts", "codex.js")],
			platform: process.platform,
			moduleUrl: pathToFileURL(join(repoRootDir, "scripts", "codex.js")).href,
			resolvePackageBin: () => null,
			spawnSyncImpl: () => createSpawnSyncSuccess(`${nativeCodexPath}\n`),
			existsSyncImpl: (candidate) => candidate === nativeCodexPath,
		});

		expect(resolved).toEqual({
			path: nativeCodexPath,
			launchWithNode: false,
		});
	});

	it("accepts Windows native codex paths without an .exe suffix", () => {
		const pathEntry = join("C:", "custom", "bin");
		const nativeCodexPath = join(pathEntry, "codex");
		const resolved = resolveRealCodexBin({
			env: {
				PATH: pathEntry,
			},
			argv: [process.execPath, join(repoRootDir, "scripts", "codex.js")],
			platform: "win32",
			moduleUrl: pathToFileURL(join(repoRootDir, "scripts", "codex.js")).href,
			resolvePackageBin: () => null,
			spawnSyncImpl: () => createSpawnSyncSuccess("") as SpawnSyncReturns<string>,
			existsSyncImpl: (candidate) => candidate === nativeCodexPath,
		});

		expect(resolved).toEqual({
			path: nativeCodexPath,
			launchWithNode: false,
		});
	});

	it("prefers Windows codex.exe over extensionless codex when both exist", () => {
		const pathEntry = join("C:", "custom", "bin");
		const nativeCodexExePath = join(pathEntry, "codex.exe");
		const nativeCodexPath = join(pathEntry, "codex");
		const resolved = resolveRealCodexBin({
			env: {
				PATH: pathEntry,
			},
			argv: [process.execPath, join(repoRootDir, "scripts", "codex.js")],
			platform: "win32",
			moduleUrl: pathToFileURL(join(repoRootDir, "scripts", "codex.js")).href,
			resolvePackageBin: () => null,
			spawnSyncImpl: () => createSpawnSyncSuccess("") as SpawnSyncReturns<string>,
			existsSyncImpl: (candidate) =>
				candidate === nativeCodexExePath || candidate === nativeCodexPath,
		});

		expect(resolved).toEqual({
			path: nativeCodexExePath,
			launchWithNode: false,
		});
	});

	it("skips self-referential codex wrapper entries on PATH before native binaries", () => {
		const wrapperScriptPath = join(
			"C:\\test-root",
			"npm",
			"lib",
			"node_modules",
			"codex-multi-auth",
			"scripts",
			"codex.js",
		);
		const wrapperBinPath = join("C:\\test-root", "npm", "bin", "codex");
		const nativeCodexPath = join("C:\\test-root", "native", "bin", "codex");
		const resolved = resolveRealCodexBin({
			env: {
				PATH: [join("C:\\test-root", "npm", "bin"), join("C:\\test-root", "native", "bin")].join(delimiter),
			},
			argv: [process.execPath, wrapperScriptPath],
			platform: "linux",
			moduleUrl: pathToFileURL(join(repoRootDir, "scripts", "codex.js")).href,
			resolvePackageBin: () => null,
			spawnSyncImpl: () => createSpawnSyncSuccess(""),
			existsSyncImpl: (candidate) =>
				candidate === wrapperBinPath || candidate === nativeCodexPath,
			realpathSyncImpl: (candidate) => {
				if (candidate === join(repoRootDir, "scripts", "codex.js")) {
					return wrapperScriptPath;
				}
				if (candidate === wrapperBinPath) {
					return wrapperScriptPath;
				}
				return candidate;
			},
		});

		expect(resolved).toEqual({
			path: nativeCodexPath,
			launchWithNode: false,
		});
	});

	it("discovers native codex executables via which fallback when PATH scan misses", () => {
		const nativeCodexPath = "/opt/homebrew/bin/codex";
		const spawnCalls = [];
		const resolved = resolveRealCodexBin({
			env: {
				PATH: "/usr/local/bin",
			},
			argv: [process.execPath, join(repoRootDir, "scripts", "codex.js")],
			platform: "linux",
			moduleUrl: pathToFileURL(join(repoRootDir, "scripts", "codex.js")).href,
			resolvePackageBin: () => null,
			spawnSyncImpl: (command, args, options) => {
				spawnCalls.push({ command, args, options: options ?? {} });
				if (command === "npm") {
					return createSpawnSyncSuccess("");
				}
				return createSpawnSyncSuccess(`${nativeCodexPath}\n`);
			},
			existsSyncImpl: (candidate) => candidate === nativeCodexPath,
		});

		expect(resolved).toEqual({
			path: nativeCodexPath,
			launchWithNode: false,
		});
		expect(spawnCalls).toHaveLength(2);
		expect(spawnCalls[0]).toMatchObject({
			command: "npm",
			args: ["root", "-g"],
		});
		expect(spawnCalls[1]).toMatchObject({
			command: "which",
			args: ["codex"],
		});
	});

	it.skipIf(process.platform !== "win32")(
		"does not install Windows shell guards unless explicitly enabled",
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
				PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
				USERPROFILE: fixtureRoot,
				HOME: fixtureRoot,
			});
			expect(result.status).toBe(0);

			expect(() => readFileSync(join(shimDir, "codex.bat"), "utf8")).toThrow();
			expect(readFileSync(join(shimDir, "codex.cmd"), "utf8")).toContain(
				"node_modules\\@openai\\codex\\bin\\codex.js",
			);
			expect(readFileSync(join(shimDir, "codex.ps1"), "utf8")).toContain(
				"node_modules/@openai/codex/bin/codex.js",
			);
			expect(() =>
				readFileSync(
					join(
						fixtureRoot,
						"Documents",
						"PowerShell",
						"Microsoft.PowerShell_profile.ps1",
					),
					"utf8",
				),
			).toThrow();
		},
	);

	it.skipIf(process.platform !== "win32")(
		"installs the PowerShell profile guard without requiring batch shim guards",
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
				CODEX_MULTI_AUTH_PWSH_PROFILE_GUARD: "1",
				PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
				USERPROFILE: fixtureRoot,
				HOME: fixtureRoot,
			});
			expect(result.status).toBe(0);

			expect(() => readFileSync(join(shimDir, "codex.bat"), "utf8")).toThrow();
			expect(readFileSync(join(shimDir, "codex.cmd"), "utf8")).toContain(
				"node_modules\\@openai\\codex\\bin\\codex.js",
			);
			expect(readFileSync(join(shimDir, "codex.ps1"), "utf8")).toContain(
				"node_modules/@openai/codex/bin/codex.js",
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
		"installs Windows shell guards over native Codex launcher shims",
		() => {
			const fixtureRoot = createWrapperFixture();
			const fakeBin = createFakeCodexBin(fixtureRoot);
			const shimDir = join(fixtureRoot, "native-shim-bin");
			mkdirSync(shimDir, { recursive: true });
			writeFileSync(
				join(shimDir, "codex-multi-auth.cmd"),
				"@ECHO OFF\r\nREM fixture codex-multi-auth shim\r\n",
				"utf8",
			);
			writeFileSync(
				join(shimDir, "codex.cmd"),
				'@ECHO OFF\r\necho "%dp0%\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe"\r\n',
				"utf8",
			);
			writeFileSync(
				join(shimDir, "codex.ps1"),
				'Write-Output "$basedir/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe"' +
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

			expect(readFileSync(join(shimDir, "codex.bat"), "utf8")).toContain(
				"codex-multi-auth windows shim guardian v1",
			);
			expect(readFileSync(join(shimDir, "codex.cmd"), "utf8")).toContain(
				"node_modules\\codex-multi-auth\\scripts\\codex.js",
			);
			expect(readFileSync(join(shimDir, "codex.ps1"), "utf8")).toContain(
				"node_modules/codex-multi-auth/scripts/codex.js",
			);
		},
	);

	it.skipIf(process.platform !== "win32")(
		"installs Windows shell guards over each native Codex shim pattern",
		() => {
			const patterns = [
				{
					cmd: '@ECHO OFF\r\necho "%dp0%\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe"\r\n',
					ps1: 'Write-Output "$basedir/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe"',
				},
				{
					cmd: '@ECHO OFF\r\necho "%dp0%\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\codex\\codex.exe"\r\n',
					ps1: 'Write-Output "$basedir/node_modules/@openai/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/codex/codex.exe"',
				},
			];

			for (const [index, pattern] of patterns.entries()) {
				const fixtureRoot = createWrapperFixture();
				const fakeBin = createFakeCodexBin(fixtureRoot);
				const shimDir = join(fixtureRoot, `native-shim-bin-${index}`);
				mkdirSync(shimDir, { recursive: true });
				writeFileSync(
					join(shimDir, "codex-multi-auth.cmd"),
					"@ECHO OFF\r\nREM fixture codex-multi-auth shim\r\n",
					"utf8",
				);
				writeFileSync(join(shimDir, "codex.cmd"), pattern.cmd, "utf8");
				writeFileSync(join(shimDir, "codex.ps1"), `${pattern.ps1}\r\n`, "utf8");

				const result = runWrapper(fixtureRoot, ["--version"], {
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
					CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD: "1",
					PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
					USERPROFILE: fixtureRoot,
					HOME: fixtureRoot,
				});
				expect(result.status).toBe(0);
				expect(readFileSync(join(shimDir, "codex.cmd"), "utf8")).toContain(
					"node_modules\\codex-multi-auth\\scripts\\codex.js",
				);
				expect(readFileSync(join(shimDir, "codex.ps1"), "utf8")).toContain(
					"node_modules/codex-multi-auth/scripts/codex.js",
				);
			}
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
				join(repoRootDir, "scripts", "codex-bin-resolver.js"),
				join(scriptDir, "codex-bin-resolver.js"),
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
				CODEX_MULTI_AUTH_WINDOWS_BATCH_SHIM_GUARD: "1",
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

	it("skips startup auto-update loading when bypass is set", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const markerPath = join(fixtureRoot, "auto-update-loaded.txt");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "auto-update-checker.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.env.CODEX_MULTI_AUTH_AUTO_UPDATE_MARKER, 'loaded', 'utf8');",
				"export async function autoUpdateIfAvailable() {",
				"\treturn { updated: false };",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["--version"], {
			CODEX_MULTI_AUTH_AUTO_UPDATE_MARKER: markerPath,
			CODEX_MULTI_AUTH_BYPASS: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:--version");
		expect(existsSync(markerPath)).toBe(false);
	});

	it.each([
		["long version", ["--version"]],
		["short version", ["-V"]],
		["long help", ["--help"]],
		["short help", ["-h"]],
		["combined help/version", ["--help", "--version"]],
	] as const)("skips startup auto-update loading for pure %s commands", (_label, args) => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const markerPath = join(fixtureRoot, "auto-update-loaded.txt");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "auto-update-checker.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.env.CODEX_MULTI_AUTH_AUTO_UPDATE_MARKER, 'loaded', 'utf8');",
				"export async function autoUpdateIfAvailable() {",
				"\treturn { updated: false };",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, [...args], {
			CODEX_MULTI_AUTH_AUTO_UPDATE_MARKER: markerPath,
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`FORWARDED:${args.join(" ")}`);
		expect(existsSync(markerPath)).toBe(false);
	});

	it("skips startup auto-update loading for local auth commands", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const markerPath = join(fixtureRoot, "auto-update-loaded.txt");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "auto-update-checker.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.env.CODEX_MULTI_AUTH_AUTO_UPDATE_MARKER, 'loaded', 'utf8');",
				"export async function autoUpdateIfAvailable() {",
				"\treturn { updated: false };",
				"}",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				"export async function runCodexMultiAuthCli(args) {",
				"\tconsole.log(`LOCAL:${args.join(' ')}`);",
				"\treturn 0;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["auth", "status"], {
			CODEX_MULTI_AUTH_AUTO_UPDATE_MARKER: markerPath,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("LOCAL:auth status");
		expect(existsSync(markerPath)).toBe(false);
	});

	it("ignores missing startup auto-update checker builds", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(result.stderr).not.toContain("auto-update skipped");
		expect(result.stderr).not.toContain(
			"codex-multi-auth: auto-update found 9.9.9; starting npm update -g codex-multi-auth.",
		);
		expect(result.stderr).not.toContain(
			"codex-multi-auth: auto-updated to 9.9.9. New sessions will use the latest package.",
		);
	});

	it("logs startup auto-update progress and successful updates in debug mode", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const optionsPath = join(fixtureRoot, "auto-update-options.json");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "auto-update-checker.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"export async function autoUpdateIfAvailable(options) {",
				"\twriteFileSync(process.env.CODEX_MULTI_AUTH_AUTO_UPDATE_OPTIONS, JSON.stringify({ fetchTimeoutMs: options.fetchTimeoutMs, timeoutMs: options.timeoutMs }), 'utf8');",
				"\toptions?.onUpdateStart?.({ latestVersion: '9.9.9' });",
				"\treturn { updated: true, latestVersion: '9.9.9' };",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_AUTO_UPDATE_OPTIONS: optionsPath,
			CODEX_MULTI_AUTH_DEBUG: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(JSON.parse(readFileSync(optionsPath, "utf8"))).toEqual({
			fetchTimeoutMs: 1200,
			timeoutMs: 1800,
		});
		expect(result.stderr).toContain(
			"codex-multi-auth: auto-update found 9.9.9; starting npm update -g codex-multi-auth. Startup will continue if it exceeds 3000ms.",
		);
		expect(result.stderr).toContain(
			"codex-multi-auth: auto-updated to 9.9.9. New sessions will use the latest package.",
		);
	});

	it("suppresses startup auto-update progress in captured non-TTY output", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "auto-update-checker.js"),
			[
				"export async function autoUpdateIfAvailable(options) {",
				"\toptions?.onUpdateStart?.({ latestVersion: '9.9.9' });",
				"\treturn { updated: true, latestVersion: '9.9.9' };",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(result.stderr).not.toContain("auto-update found 9.9.9");
		expect(result.stderr).not.toContain("auto-updated to 9.9.9");
	});

	it("suppresses startup auto-update failures unless debug logging is enabled", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "auto-update-checker.js"),
			[
				"export async function autoUpdateIfAvailable() {",
				"\tthrow new Error('registry unavailable');",
				"}",
			].join("\n"),
			"utf8",
		);

		const quietResult = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});
		const debugResult = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_DEBUG: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(quietResult.status).toBe(0);
		expect(quietResult.stdout).toContain("FORWARDED:exec status");
		expect(quietResult.stderr).not.toContain("registry unavailable");
		expect(debugResult.status).toBe(0);
		expect(debugResult.stdout).toContain("FORWARDED:exec status");
		expect(debugResult.stderr).toContain(
			"codex-multi-auth: auto-update skipped: registry unavailable",
		);
	});

	it("continues forwarded startup within the stable auto-update startup budget", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "auto-update-checker.js"),
			[
				"export async function autoUpdateIfAvailable() {",
				"\treturn new Promise(() => undefined);",
				"}",
			].join("\n"),
			"utf8",
		);

		const startedAt = Date.now();
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_AUTO_UPDATE_STARTUP_BUDGET_MS: "25",
		});
		const elapsedMs = Date.now() - startedAt;

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(result.stderr).not.toContain("auto-update skipped");
		expect(elapsedMs).toBeLessThan(2_000);
	});

	it("syncs manager active selection before and after forwarded commands", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const markerPath = join(fixtureRoot, "sync-marker.txt");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "codex-manager.js"),
			[
				'import { appendFileSync } from "node:fs";',
				"export async function autoSyncActiveAccountToCodex() {",
				'  appendFileSync(process.env.CODEX_MULTI_AUTH_TEST_SYNC_MARKER, "sync\\n", "utf8");',
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_TEST_SYNC_MARKER: markerPath,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(readFileSync(markerPath, "utf8").trim().split(/\r?\n/)).toEqual([
			"sync",
			"sync",
		]);
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
		expect(output).toContain("Could not locate the official Codex CLI.");
		expect(output).toContain(
			"Install it with npm, Homebrew, or an official native release so `codex` is on PATH.",
		);
	});

	it("discovers the real codex bin via npm root fallback for direct script runs on Windows", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeGlobalRoot = join(fixtureRoot, "fake-global-node_modules");
		const fakeGlobalBin = createFakeGlobalCodexInstall(fakeGlobalRoot);
		const spawnCalls: Array<{
			args: string[];
			command: string;
			options: Record<string, unknown>;
		}> = [];
		const resolvedBin = resolveRealCodexBin({
			argv: ["node", join(fixtureRoot, "scripts", "codex.js")],
			env: {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			existsSyncImpl: (candidatePath) => candidatePath === fakeGlobalBin,
			moduleUrl: pathToFileURL(join(fixtureRoot, "scripts", "codex.js")).href,
			platform: "win32",
			resolvePackageBin: () => null,
			spawnSyncImpl: (command, args, options) => {
				spawnCalls.push({
					args,
					command,
					options: options as Record<string, unknown>,
				});
				return createSpawnSyncSuccess(`${fakeGlobalRoot}\r\n`);
			},
		});

		expect(resolvedBin).toEqual({ path: fakeGlobalBin, launchWithNode: true });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(spawnCalls[0]?.args).toEqual(["/d", "/s", "/c", "npm root -g"]);
		expect(spawnCalls[0]?.options).toMatchObject({
			encoding: "utf8",
			env: {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
			windowsHide: true,
		});
	});

	it("honors uppercase COMSPEC when resolving the Windows npm root fallback", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeGlobalRoot = join(fixtureRoot, "fake-global-node_modules-uppercase");
		const fakeGlobalBin = createFakeGlobalCodexInstall(fakeGlobalRoot);
		const spawnCalls: Array<{
			args: string[];
			command: string;
			options: Record<string, unknown>;
		}> = [];
		const resolvedBin = resolveRealCodexBin({
			argv: ["node", join(fixtureRoot, "scripts", "codex.js")],
			env: {
				COMSPEC: "C:\\Windows\\System32\\cmd.exe",
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			existsSyncImpl: (candidatePath) => candidatePath === fakeGlobalBin,
			moduleUrl: pathToFileURL(join(fixtureRoot, "scripts", "codex.js")).href,
			platform: "win32",
			resolvePackageBin: () => null,
			spawnSyncImpl: (command, args, options) => {
				spawnCalls.push({
					args,
					command,
					options: options as Record<string, unknown>,
				});
				return createSpawnSyncSuccess(`${fakeGlobalRoot}\r\n`);
			},
		});

		expect(resolvedBin).toEqual({ path: fakeGlobalBin, launchWithNode: true });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(spawnCalls[0]?.args).toEqual(["/d", "/s", "/c", "npm root -g"]);
		expect(spawnCalls[0]?.options).toMatchObject({
			encoding: "utf8",
			env: {
				COMSPEC: "C:\\Windows\\System32\\cmd.exe",
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
			windowsHide: true,
		});
	});

	it("derives cmd.exe from SystemRoot when ComSpec is unavailable", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeGlobalRoot = join(fixtureRoot, "fake-global-node_modules-systemroot");
		const fakeGlobalBin = createFakeGlobalCodexInstall(fakeGlobalRoot);
		const spawnCalls: Array<{
			args: string[];
			command: string;
			options: Record<string, unknown>;
		}> = [];
		const resolvedBin = resolveRealCodexBin({
			argv: ["node", join(fixtureRoot, "scripts", "codex.js")],
			env: {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				SystemRoot: "C:\\Windows\\",
				npm_config_prefix: "",
			},
			existsSyncImpl: (candidatePath) => candidatePath === fakeGlobalBin,
			moduleUrl: pathToFileURL(join(fixtureRoot, "scripts", "codex.js")).href,
			platform: "win32",
			resolvePackageBin: () => null,
			spawnSyncImpl: (command, args, options) => {
				spawnCalls.push({
					args,
					command,
					options: options as Record<string, unknown>,
				});
				return createSpawnSyncSuccess(`${fakeGlobalRoot}\r\n`);
			},
		});

		expect(resolvedBin).toEqual({ path: fakeGlobalBin, launchWithNode: true });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(spawnCalls[0]?.args).toEqual(["/d", "/s", "/c", "npm root -g"]);
		expect(spawnCalls[0]?.options).toMatchObject({
			timeout: 5000,
		});
	});

	it("derives cmd.exe from uppercase SYSTEMROOT when ComSpec is unavailable", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeGlobalRoot = join(
			fixtureRoot,
			"fake-global-node_modules-systemroot-uppercase",
		);
		const fakeGlobalBin = createFakeGlobalCodexInstall(fakeGlobalRoot);
		const spawnCalls: Array<{
			args: string[];
			command: string;
			options: Record<string, unknown>;
		}> = [];
		const resolvedBin = resolveRealCodexBin({
			argv: ["node", join(fixtureRoot, "scripts", "codex.js")],
			env: {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				SYSTEMROOT: "C:\\Windows\\",
				npm_config_prefix: "",
			},
			existsSyncImpl: (candidatePath) => candidatePath === fakeGlobalBin,
			moduleUrl: pathToFileURL(join(fixtureRoot, "scripts", "codex.js")).href,
			platform: "win32",
			resolvePackageBin: () => null,
			spawnSyncImpl: (command, args, options) => {
				spawnCalls.push({
					args,
					command,
					options: options as Record<string, unknown>,
				});
				return createSpawnSyncSuccess(`${fakeGlobalRoot}\r\n`);
			},
		});

		expect(resolvedBin).toEqual({ path: fakeGlobalBin, launchWithNode: true });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(spawnCalls[0]?.args).toEqual(["/d", "/s", "/c", "npm root -g"]);
		expect(spawnCalls[0]?.options).toMatchObject({
			timeout: 5000,
		});
	});

	it("falls back to bare cmd.exe when no Windows shell env vars are set", () => {
		const fixtureRoot = createWrapperFixture();
		const spawnCalls: Array<{
			args: string[];
			command: string;
			options: Record<string, unknown>;
		}> = [];

		resolveRealCodexBin({
			argv: ["node", join(fixtureRoot, "scripts", "codex.js")],
			env: {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			existsSyncImpl: () => false,
			moduleUrl: pathToFileURL(join(fixtureRoot, "scripts", "codex.js")).href,
			platform: "win32",
			resolvePackageBin: () => null,
			spawnSyncImpl: (command, args, options) => {
				spawnCalls.push({
					args,
					command,
					options: options as Record<string, unknown>,
				});
				return createSpawnSyncSuccess("");
			},
		});

		expect(spawnCalls).toHaveLength(2);
		expect(spawnCalls[0]?.command).toBe("cmd.exe");
		expect(spawnCalls[0]?.args).toEqual(["/d", "/s", "/c", "npm root -g"]);
		expect(spawnCalls[0]?.options).toMatchObject({
			encoding: "utf8",
			env: {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
			windowsHide: true,
		});
		expect(spawnCalls[1]?.command).toBe("cmd.exe");
		expect(spawnCalls[1]?.args).toEqual(["/d", "/s", "/c", "where codex"]);
	});

	it("discovers the real codex bin via npm root fallback on POSIX", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeGlobalRoot = join(fixtureRoot, "fake-global-node_modules-posix");
		const fakeGlobalBin = createFakeGlobalCodexInstall(fakeGlobalRoot);
		const spawnCalls: Array<{
			args: string[];
			command: string;
			options: Record<string, unknown>;
		}> = [];
		const resolvedBin = resolveRealCodexBin({
			argv: ["node", join(fixtureRoot, "scripts", "codex.js")],
			env: {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			existsSyncImpl: (candidatePath) => candidatePath === fakeGlobalBin,
			moduleUrl: pathToFileURL(join(fixtureRoot, "scripts", "codex.js")).href,
			platform: "linux",
			resolvePackageBin: () => null,
			spawnSyncImpl: (command, args, options) => {
				spawnCalls.push({
					args,
					command,
					options: options as Record<string, unknown>,
				});
				return createSpawnSyncSuccess(`${fakeGlobalRoot}\n`);
			},
		});

		expect(resolvedBin).toEqual({ path: fakeGlobalBin, launchWithNode: true });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command).toBe("npm");
		expect(spawnCalls[0]?.args).toEqual(["root", "-g"]);
		expect(spawnCalls[0]?.options).toMatchObject({
			encoding: "utf8",
			env: {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		expect(spawnCalls[0]?.options).not.toHaveProperty("windowsHide");
	});

	it("returns null when npm root lookup throws", () => {
		const fixtureRoot = createWrapperFixture();
		const resolvedBin = resolveRealCodexBin({
			argv: ["node", join(fixtureRoot, "scripts", "codex.js")],
			env: {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: "",
				PREFIX: "",
				npm_config_prefix: "",
			},
			existsSyncImpl: () => false,
			moduleUrl: pathToFileURL(join(fixtureRoot, "scripts", "codex.js")).href,
			platform: "linux",
			resolvePackageBin: () => null,
			spawnSyncImpl: () => {
				throw new Error("ENOENT: npm not found");
			},
		});

		expect(resolvedBin).toBeNull();
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
