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
import {
	delimiter,
	posix,
	win32,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import process from "node:process";
import { withDeadPid, withDeadPids } from "./helpers/owned-pids.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	APP_RUNTIME_HELPER_OWNER_FILE,
	RUNTIME_ROTATION_PROXY_PROVIDER_ID,
} from "../lib/runtime-constants.js";
import { sleep } from "../lib/utils.js";
import { resolveRealCodexBin } from "../scripts/codex-bin-resolver.js";

const createdDirs: string[] = [];
const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRootDir = join(testFileDir, "..");
const EXIT_SUCCESS_LINE = "exit 0";
const SHADOW_HOME_ORPHAN_LOCK_TEST_AGE_MS = 2_200;
const HOOKS_JSON_TEXT = '{"hooks":{}}\n';

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

/**
 * Stubs `dist/lib/codex-cli/writer.js` so the wrapper's startup auth-store
 * guard has something to import. Each call drops a marker file named after the
 * calling pid — one file per process rather than shared appends, so concurrent
 * launches cannot race on the record itself. Throws when
 * `CODEX_MULTI_AUTH_TEST_AUTH_STORE_FAIL` is set so the non-fatal path can be
 * exercised. The real TOML rewrite is covered by test/codex-cli-writer.test.ts.
 */
function createAuthStoreWriterFixtureModule(fixtureRoot: string): string {
	const writerDir = join(fixtureRoot, "dist", "lib", "codex-cli");
	mkdirSync(writerDir, { recursive: true });
	const callDir = join(fixtureRoot, "auth-store-calls");
	mkdirSync(callDir, { recursive: true });
	writeFileSync(
		join(writerDir, "writer.js"),
		[
			'import { writeFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"",
			"export async function ensureCodexCliFileAuthStore(configPath) {",
			`  writeFileSync(join(${JSON.stringify(callDir)}, String(process.pid)), String(configPath ?? "default"), "utf8");`,
			"  if ((process.env.CODEX_MULTI_AUTH_TEST_AUTH_STORE_FAIL ?? '') === '1') {",
			"    const error = new Error('EBUSY: resource busy or locked');",
			"    error.code = 'EBUSY';",
			"    throw error;",
			"  }",
			"  return true;",
			"}",
			"",
		].join("\n"),
		"utf8",
	);
	return callDir;
}

function readAuthStoreCallCount(callDir: string): number {
	if (!existsSync(callDir)) return 0;
	return readdirSync(callDir).length;
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
			'import { spawn } from "node:child_process";',
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
			// Opt-in: a request counter that climbs on its own for the first N ms
			// and then stops, standing in for a detached consumer that keeps using
			// its proxy and later goes away. Static counters cannot express
			// "traffic is still arriving", which is exactly what the detached
			// reaper reads.
			// Garbage readings have to be expressible: a proxy that answers `-1`,
			// `NaN`, or `Infinity` must degrade to "nothing attached", never to
			// "someone is attached forever".
			"function readProxyOpenConnections() {",
			"  const raw = (process.env.CODEX_MULTI_AUTH_TEST_PROXY_OPEN_CONNECTIONS ?? '').trim().toLowerCase();",
			"  if (raw === '') return 0;",
			"  if (raw === 'nan') return Number.NaN;",
			"  if (raw === 'infinity') return Number.POSITIVE_INFINITY;",
			"  const parsed = Number.parseInt(raw, 10);",
			"  return Number.isNaN(parsed) ? 0 : parsed;",
			"}",
			"",
			"const proxyStartedAt = Date.now();",
			"function rampedRequestCount() {",
			"  const rampMs = readOptionalNumberEnv('CODEX_MULTI_AUTH_TEST_PROXY_REQUEST_RAMP_MS');",
			"  if (rampMs === null) return null;",
			"  return Math.floor(Math.min(Date.now() - proxyStartedAt, rampMs) / 100);",
			"}",
			"",
			"function buildStatus() {",
			"  return {",
			"    totalRequests: rampedRequestCount() ?? readOptionalNumberEnv('CODEX_MULTI_AUTH_TEST_PROXY_REQUESTS') ?? 0,",
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
			"export async function startRuntimeRotationProxy(options = {}) {",
			"  const baseUrl = process.env.CODEX_MULTI_AUTH_TEST_PROXY_BASE_URL ?? 'http://127.0.0.1:4567';",
			"  if ((process.env.CODEX_MULTI_AUTH_TEST_PROXY_MARKER_UPSTREAM ?? '').trim() === '1') {",
			"    appendMarker(`upstream:${options.upstreamBaseUrl ?? ''}`);",
			"  }",
			// Opt-in (#623): record the forced-account pin env the proxy process actually
			// observed, so a test can prove the value crossed the launcher -> detached
			// app-helper boundary. Gated so it never perturbs the exact-marker assertions
			// in other tests.
			"  if ((process.env.CODEX_MULTI_AUTH_TEST_PROXY_MARKER_FORCED ?? '').trim() === '1') {",
			"    appendMarker(`forced-index-env:${process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX ?? ''}`);",
			"  }",
			"  if ((process.env.CODEX_MULTI_AUTH_TEST_PROXY_MARKER_ENV ?? '').trim() === '1') {",
			"    appendMarker(`codex-home-env:${process.env.CODEX_HOME ?? ''}`);",
			"    appendMarker(`real-home-env:${process.env.CODEX_MULTI_AUTH_REAL_CODEX_HOME ?? ''}`);",
			"  }",
			// Opt-in (#647): the real proxy owns a listening socket, so the helper stays
			// alive until it is closed. This fake has no such handle and would otherwise
			// let the helper exit on its own the moment its status timer is cleared —
			// which would silently defeat a test about helpers that refuse to stop. Hold
			// a ref'd handle so the helper's lifetime is governed by the signal path.
			"  const closeHangs = (process.env.CODEX_MULTI_AUTH_TEST_PROXY_CLOSE_HANG ?? '').trim() === '1';",
			"  if (closeHangs) {",
			"    setInterval(() => {}, 1000);",
			"  }",
			// Opt-in (#647): leak a detached grandchild that inherits this helper's stdio.
			// It keeps the write end of the launcher's pipes open after the helper is
			// gone, so the launcher never sees `close` and must release the handles
			// itself. This reproduces the stranded-wrapper failure on every platform,
			// including Windows, where `kill()` is always a hard terminate.
			"  const pipeHolderMs = readOptionalNumberEnv('CODEX_MULTI_AUTH_TEST_PROXY_PIPE_HOLDER_MS');",
			"  if (pipeHolderMs !== null) {",
			"    const holder = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${pipeHolderMs})`], {",
			"      stdio: ['ignore', 'inherit', 'inherit'],",
			"      detached: true,",
			"    });",
			"    holder.unref();",
			"  }",
			"  appendMarker((process.env.CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID ?? '').trim() === '1' ? `start:${baseUrl}:pid=${process.pid}` : `start:${baseUrl}`);",
			"  return {",
			"    host: '127.0.0.1',",
			"    port: 4567,",
			"    baseUrl,",
			// Opt-in (#647): stall `close()` forever so the helper's SIGTERM handler
			// never reaches `process.exit`. Paired with the ref'd handle installed
			// above, this reproduces a helper that survives the graceful window and can
			// only be stopped by force.
			"    close: async () => {",
			"      appendMarker('close');",
			"      if (closeHangs) {",
			"        await new Promise(() => {});",
			"      }",
			"    },",
			// Opt-in: report open client connections, which the real proxy reads off
			// its live socket set. The detached reap treats a connected consumer as
			// proof the handoff was real, so a test needs to be able to say "someone
			// is attached" without standing up a real client.
			"    getOpenConnectionCount: () => readProxyOpenConnections(),",
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

// Write a minimal accounts pool at <codexHome>/multi-auth/openai-codex-accounts.json
// (the global dir the launcher resolves when the dist scoping helpers are absent),
// so --account (#623) selector resolution has a pool to match against.
function writeAccountsFixture(codexHome: string, count: number): void {
	const dir = join(codexHome, "multi-auth");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "openai-codex-accounts.json"),
		JSON.stringify({
			version: 3,
			accounts: Array.from({ length: count }, (_unused, index) => ({
				email: `account-${index + 1}@example.com`,
				accountId: `acc_${index + 1}`,
			})),
		}),
		"utf8",
	);
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
		// A hard link to the test runner's node.exe cannot be removed on Windows
		// while this process is still running. Use an independent image so the
		// fixture teardown exercises the resolver without leaking a locked file.
		copyFileSync(process.execPath, nativeExePath);
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

// The wrapper is published, so its fault injectors stay inert unless this
// switch is set alongside the counter (#668). Every injection helper below
// carries it, and `runWrapper` never sets it on its own — which is what lets
// the "production ignores the counter" test simply omit it.
const FAULT_INJECTION_ON = {
	CODEX_MULTI_AUTH_TEST_FAULT_INJECTION: "1",
} as const;

function injectShadowCleanupBusyFailures(
	failuresBeforeSuccess = 2,
): NodeJS.ProcessEnv {
	return {
		...FAULT_INJECTION_ON,
		CODEX_MULTI_AUTH_TEST_SHADOW_CLEANUP_BUSY_FAILURES: String(failuresBeforeSuccess),
	};
}

function injectShadowPreflightReadBusyFailures(
	failuresBeforeSuccess = 2,
): NodeJS.ProcessEnv {
	return {
		...FAULT_INJECTION_ON,
		CODEX_MULTI_AUTH_TEST_SHADOW_PREFLIGHT_READ_BUSY_FAILURES: String(
			failuresBeforeSuccess,
		),
	};
}

function injectShadowSyncMetadataBusyFailures(
	failuresBeforeSuccess = 10,
): NodeJS.ProcessEnv {
	return {
		...FAULT_INJECTION_ON,
		CODEX_MULTI_AUTH_TEST_SHADOW_SYNC_METADATA_BUSY_FAILURES: String(
			failuresBeforeSuccess,
		),
	};
}

function injectShadowLockRecreatedStaleCount(count = 2): NodeJS.ProcessEnv {
	return {
		...FAULT_INJECTION_ON,
		CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_RECREATE_STALE_COUNT: String(count),
	};
}

function injectShadowLockOwnerWriteFailures(
	failuresBeforeSuccess = 1,
): NodeJS.ProcessEnv {
	return {
		...FAULT_INJECTION_ON,
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
	options: { timeoutMs?: number } = {},
): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[join(fixtureRoot, "scripts", "codex.js"), ...args],
		{
			encoding: "utf8",
			env: buildWrapperEnv(extraEnv),
			// Opt-in hard bound for the tests that deliberately stress the wrapper's
			// shutdown path. `spawnSync` blocks the worker thread, so Vitest's
			// `testTimeout` cannot interrupt it: without this, a shutdown regression
			// hangs the whole run instead of failing an assertion. On timeout
			// `result.error` is set, which those tests assert on.
			...(options.timeoutMs === undefined
				? {}
				: { timeout: options.timeoutMs, killSignal: "SIGKILL" as const }),
		},
	);
}

// Generous next to the wrapper's 2s graceful-shutdown window, but far below the
// time a stuck wrapper would otherwise block for.
const WRAPPER_SHUTDOWN_TIMEOUT_MS = 12_000;

// Vitest's default per-test timeout is 5s, which is *shorter* than the bound
// above. Without an explicit per-test timeout, a stuck wrapper would be killed
// by Vitest at 5s and reported as a bare "Test timed out" — the diagnostic the
// spawn bound exists to produce would never be printed. The shutdown tests must
// therefore outlast their own internal bounds: `spawnSync` (12s) plus the
// process-exit polling below.
const SHUTDOWN_TEST_TIMEOUT_MS = 30_000;

function expectWrapperReturned(
	result: SpawnSyncReturns<string>,
	what: string,
): void {
	expect(
		result.error,
		`wrapper never returned within ${WRAPPER_SHUTDOWN_TIMEOUT_MS}ms: ${what}`,
	).toBeUndefined();
}

// Mirrors the wrapper's own owner-identity capture: kernel start time via
// `ps -o lstart=` under the C locale, parsed to epoch ms.
function readOwnProcessStartTimeMs(): number | null {
	const result = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
	const out = (result.stdout ?? "").trim();
	if (!out) return null;
	const parsed = Date.parse(out);
	return Number.isFinite(parsed) ? parsed : null;
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

// Windows has no SIGTERM, so a helper the wrapper stops is hard-terminated and
// never reaches the handler that appends its own `close` marker. Asserting the
// process is gone pins "the wrapper reaped its helper" on every platform — and
// it fails for a *stranded* helper too, which keeps the default 12h idle window
// and stays alive long past any timeout here.
async function expectAppHelperReaped(markerPath: string): Promise<void> {
	const pidMatch = readFileSync(markerPath, "utf8").match(
		/^start:[^\n]*:pid=(\d+)$/m,
	);
	expect(pidMatch?.[1]).toBeTruthy();
	const helperPid = Number(pidMatch?.[1]);
	// Termination is asynchronous; give the OS a moment to reap the helper.
	for (let attempt = 0; attempt < 40 && isProcessAlive(helperPid); attempt += 1) {
		await sleep(100);
	}
	expect(isProcessAlive(helperPid)).toBe(false);
}

function combinedOutput(
	result: SpawnSyncReturns<string> | WrapperAsyncResult,
): string {
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function hookStateHeader(key: string): string {
	return `[hooks.state.${JSON.stringify(key)}]`;
}

function literalHookStateHeader(key: string): string {
	return `[hooks.state.'${key}']`;
}

function extractLineValue(output: string, prefix: string): string {
	const line = output.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
	expect(line).toBeTruthy();
	return line?.slice(prefix.length) ?? "";
}

function isTomlHeaderLine(line: string): boolean {
	return /^\s*\[\[?\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.|\s*\]\]?\s*(?:#.*)?$)/.test(
		line,
	);
}

type TomlBlockScanState = {
	arrayDepth: number;
	multilineStringDelimiter: string | null;
};

// Keep these TOML block scan helpers aligned with scripts/codex.js.
function createTomlBlockScanState(): TomlBlockScanState {
	return {
		arrayDepth: 0,
		multilineStringDelimiter: null,
	};
}

function isTopLevelTomlBlockScanState(state: TomlBlockScanState): boolean {
	return state.arrayDepth === 0 && state.multilineStringDelimiter === null;
}

function updateTomlBlockScanState(
	line: string,
	state: TomlBlockScanState,
): void {
	for (let index = 0; index < line.length; index += 1) {
		if (state.multilineStringDelimiter) {
			const closeIndex = line.indexOf(state.multilineStringDelimiter, index);
			if (closeIndex < 0) return;
			index = closeIndex + state.multilineStringDelimiter.length - 1;
			state.multilineStringDelimiter = null;
			continue;
		}

		if (line[index] === "#") return;
		if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
			state.multilineStringDelimiter = line.slice(index, index + 3);
			index += 2;
			continue;
		}
		if (line[index] === '"') {
			index += 1;
			for (; index < line.length; index += 1) {
				if (line[index] === "\\") {
					index += 1;
				} else if (line[index] === '"') {
					break;
				}
			}
			continue;
		}
		if (line[index] === "'") {
			const closeIndex = line.indexOf("'", index + 1);
			if (closeIndex < 0) return;
			index = closeIndex;
			continue;
		}
		if (line[index] === "[") {
			state.arrayDepth += 1;
		} else if (line[index] === "]" && state.arrayDepth > 0) {
			state.arrayDepth -= 1;
		}
	}
}

function extractTomlTableBody(output: string, header: string): string {
	const lines = output.split(/\r?\n/);
	const start = lines.indexOf(header);
	expect(start).toBeGreaterThanOrEqual(0);
	const body: string[] = [];
	const blockState = createTomlBlockScanState();
	for (let index = start + 1; index < lines.length; index += 1) {
		if (
			isTopLevelTomlBlockScanState(blockState) &&
			isTomlHeaderLine(lines[index])
		) {
			break;
		}
		body.push(lines[index]);
		updateTomlBlockScanState(lines[index], blockState);
	}
	while (body.length > 0 && body[body.length - 1] === "") {
		body.pop();
	}
	return body.join("\n");
}

function expectMirroredHookStateBlock(
	output: string,
	sourceText: string,
	sourceHeader: string,
	shadowHeader: string,
	expectedBodyLines: string[],
): void {
	const sourceBody = extractTomlTableBody(sourceText, sourceHeader);
	const shadowBody = extractTomlTableBody(output, shadowHeader);
	expect(shadowBody).toBe(sourceBody);
	for (const line of expectedBodyLines) {
		expect(shadowBody).toContain(line);
	}
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

	it("copies generated runtime directories only when explicitly requested", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(`CODEX_MULTI_AUTH_DIR:${process.env.CODEX_MULTI_AUTH_DIR ?? ""}`);',
			'console.log(`CODEX_CLI_PATH:${process.env.CODEX_CLI_PATH ?? ""}`);',
			'console.log(`SHADOW_MULTI_AUTH_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "multi-auth"))}`);',
			'console.log(`SANDBOX_BIN_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", ".sandbox-bin", "codex.exe"))}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(join(originalHome, ".sandbox-bin"), { recursive: true });
		writeFileSync(join(originalHome, ".sandbox-bin", "codex.exe"), "sandbox\n", "utf8");
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_RUNTIME_SHADOW_COPY_GENERATED_DIRS: "1",
			CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_DIR_COPY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain("SANDBOX_BIN_EXISTS:true");
		expect(output).not.toContain("skipped optional shadow-home directory .sandbox-bin");
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

	it("errors when --account has no value (#623)", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["exec", "--account"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(1);
		expect(combinedOutput(result)).toContain("--account requires a value");
	});

	it("errors when --account is used but runtime rotation is disabled (#623)", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["exec", "--account", "1", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
		});

		expect(result.status).toBe(1);
		expect(combinedOutput(result)).toContain(
			"requires the runtime rotation proxy",
		);
	});

	it("errors when the --account index is out of range (#623)", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const codexHome = join(fixtureRoot, "codex-home");
		writeAccountsFixture(codexHome, 2);

		const result = runWrapper(
			fixtureRoot,
			["exec", "--account", "99", "status"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: codexHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(1);
		expect(output).toContain("out of range");
		expect(output).toContain("Available accounts");
	});

	it("strips --account and publishes the resolved 0-based index for the proxy (#623)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		writeAccountsFixture(originalHome, 3);
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`FORCED_INDEX:${process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX ?? ""}`);',
			"process.exit(0);",
		]);

		const result = runWrapper(
			fixtureRoot,
			["exec", "--account", "2", "status"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		// account 2 -> 0-based index 1, published for the proxy to consume.
		expect(output).toContain("FORCED_INDEX:1");
		// The launcher-only flag must never reach real Codex.
		expect(output).not.toContain("--account");
	});

	// Cross-provider session discovery is optional: a Codex build without
	// `thread/list` (or one that rejects, exits or times out) must still reach
	// native `codex resume` instead of failing the whole launch.
	it("falls back to native resume when the session picker fails", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const runtimeDir = join(fixtureRoot, "dist", "lib", "runtime");
		mkdirSync(runtimeDir, { recursive: true });
		writeFileSync(
			join(runtimeDir, "resume-picker.js"),
			'export async function pickResumeThread() { throw new Error("thread/list is unsupported"); }\n',
			"utf8",
		);
		// The picker only runs on an interactive terminal; spawnSync pipes stdio.
		const ttyPreload = join(fixtureRoot, "force-tty.mjs");
		writeFileSync(
			ttyPreload,
			"process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n",
			"utf8",
		);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["resume", "--all"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			NODE_OPTIONS: `--import=${pathToFileURL(ttyPreload).href}`,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(output).toContain(
			"Could not list saved Codex sessions: thread/list is unsupported",
		);
		expect(result.status).toBe(0);
		expect(output).toContain("FORWARDED:resume --all");
	});

	it.each([
		["email", ["exec", "--account", "account-2@example.com", "status"], {}, "1"],
		["account id", ["exec", "--account", "acc_2", "status"], {}, "1"],
		["--account= form", ["exec", "--account=3", "status"], {}, "2"],
		[
			"CODEX_MULTI_AUTH_FORCE_ACCOUNT env var",
			["exec", "status"],
			{ CODEX_MULTI_AUTH_FORCE_ACCOUNT: "2" },
			"1",
		],
	])(
		"resolves the forced account by %s and publishes its 0-based index (#623)",
		(_label, args, extraEnv, expectedIndex) => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			writeAccountsFixture(originalHome, 3);
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
				'console.log(`FORCED_INDEX:${process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX ?? ""}`);',
				"process.exit(0);",
			]);

			const result = runWrapper(fixtureRoot, args, {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				OPENAI_API_KEY: undefined,
				...extraEnv,
			});

			const output = combinedOutput(result);
			expect(result.status).toBe(0);
			expect(output).toContain(`FORCED_INDEX:${expectedIndex}`);
			expect(output).not.toContain("--account");
		},
	);

	it("the flag wins over CODEX_MULTI_AUTH_FORCE_ACCOUNT when both are set (#623)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		writeAccountsFixture(originalHome, 3);
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORCED_INDEX:${process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX ?? ""}`);',
			"process.exit(0);",
		]);

		const result = runWrapper(
			fixtureRoot,
			["exec", "--account", "1", "status"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_FORCE_ACCOUNT: "3",
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		// Flag `--account 1` (index 0) wins over env `...FORCE_ACCOUNT=3` (index 2).
		expect(output).toContain("FORCED_INDEX:0");
	});

	it("propagates the resolved --account index into the detached app-helper proxy (#623)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "forced-helper-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeAccountsFixture(originalHome, 3);
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(0);",
		]);

		// Bare args (no forwarded subcommand) classify as the interactive TUI, which
		// routes through a freshly spawned detached app-helper process — the one path
		// where the pin can only travel by environment.
		const result = runWrapper(fixtureRoot, ["--account", "2"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "1000",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER_FORCED: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		// The helper process saw the resolved index (account 2 -> 0-based 1).
		expect(readFileSync(markerPath, "utf8")).toContain("forced-index-env:1");
		expect(output).not.toContain("--account");
	});

	// `--` makes everything after it the root `[PROMPT]` positional, so a
	// launcher-only flag spelled inside that prompt is the user's text. The
	// stripper walked the whole argv, so it both mangled the prompt and pinned
	// the run to an account nobody selected — or hard-failed on a range check
	// for a launch that contained no flag at all.
	it("leaves a `--account` inside a `--`-forced prompt as prompt text", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeAccountsFixture(originalHome, 3);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`FORCED_INDEX:${process.env.CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX ?? ""}`);',
			"process.exit(0);",
		]);

		const result = runWrapper(
			fixtureRoot,
			["exec", "--", "--account", "3", "is", "wrong"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		// The prompt reaches Codex intact, flag tokens and all.
		expect(output).toContain("-- --account 3 is wrong");
		// And no pin was inferred from the user's prose.
		expect(output).toContain("FORCED_INDEX:");
		expect(output).not.toContain("FORCED_INDEX:2");
	});

	// Same boundary, different scanner: a `-m` inside the prompt named no
	// model, but the wrapper read one and then rewrote it in place on the
	// unsupported-model retry — editing the user's prompt text before
	// re-forwarding it.
	it("does not read or rewrite a `-m` inside a `--`-forced prompt", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeAccountsFixture(originalHome, 1);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(0);",
		]);

		const result = runWrapper(
			fixtureRoot,
			["exec", "--", "-m", "gpt-4", "please", "fix"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain("-- -m gpt-4 please fix");
	});

	it("repairs local session index and suppresses known Codex rollout-store noise", () => {
		const fixtureRoot = createWrapperFixture();
		const codexHome = join(fixtureRoot, "codex-home");
		const sessionId = "019ddf47-2c01-7c73-9f81-ab0cd9c1d5b7";
		const marker = "Reply exactly: INDEX_REPAIR_SMOKE";
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const { mkdirSync, writeFileSync } = require('node:fs');",
			"const { join } = require('node:path');",
			`const sessionId = ${JSON.stringify(sessionId)};`,
			`const marker = ${JSON.stringify(marker)};`,
			"const codexHome = process.env.CODEX_HOME;",
			"const sessionDir = join(codexHome, 'sessions', '2026', '05', '01');",
			"mkdirSync(sessionDir, { recursive: true });",
			"writeFileSync(",
			"  join(sessionDir, `rollout-2026-05-01T00-44-32-${sessionId}.jsonl`),",
			"  [",
			"    JSON.stringify({ timestamp: '2026-04-30T16:44:34.000Z', type: 'session_meta', payload: { id: sessionId } }),",
			"    JSON.stringify({ timestamp: '2026-04-30T16:44:35.000Z', type: 'event_msg', payload: { type: 'user_message', message: marker } }),",
			"    JSON.stringify({ timestamp: '2026-04-30T16:44:36.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'INDEX_REPAIR_SMOKE' } }),",
			"    '',",
			"  ].join('\\n'),",
			"  'utf8',",
			");",
			"process.stderr.write(`2026-04-30T16:44:37.000000Z ERROR codex_core::session: failed to record rollout items: thread \\n${sessionId} not found\\n`);",
			"process.stderr.write('2026-04-30T16:44:38.000000Z ERROR rmcp::transport::streamable_http_client: fail to delete session: \\n');",
			"process.stderr.write('unexpected server response: DELETE returned HTTP 404 session_id=\"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZC\\n');",
			"process.stderr.write('I6IjQ5MjBhNmQwLWY1OWQtNDBmNC04ZTU1LWNmNmU2ZDBjODQxNiJ9.fake\"\\n');",
			"process.stderr.write('VISIBLE_STDERR\\n');",
			"process.stdout.write(`2026-04-30T16:44:39.000000Z ERROR codex_core::session: failed to record rollout items: thread \\n${sessionId} not found\\n`);",
			"console.log(`RUST_LOG=${process.env.RUST_LOG ?? ''}`);",
			"console.log('FORWARDED_INDEX_REPAIR');",
			"process.exit(0);",
		]);
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_HOME: codexHome,
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
			RUST_LOG: "info",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED_INDEX_REPAIR");
		expect(result.stdout).toContain("RUST_LOG=info");
		expect(result.stdout).not.toContain("failed to record rollout items");
		expect(result.stderr).toContain("VISIBLE_STDERR");
		expect(result.stderr).not.toContain("failed to record rollout items");
		expect(result.stderr).not.toContain(`${sessionId} not found`);
		expect(result.stderr).not.toContain("fail to delete session");
		expect(result.stderr).not.toContain("DELETE returned HTTP 404");
		expect(readFileSync(join(codexHome, "session_index.jsonl"), "utf8")).toContain(
			JSON.stringify({
				id: sessionId,
				thread_name: marker,
				updated_at: "2026-04-30T16:44:36.000Z",
			}),
		);
	});

	it("does not repair local session index for failed forwarded runs", () => {
		const fixtureRoot = createWrapperFixture();
		const codexHome = join(fixtureRoot, "codex-home");
		const sessionId = "019ddf58-f831-7e12-bf4a-fae1ed000001";
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const { mkdirSync, writeFileSync } = require('node:fs');",
			"const { join } = require('node:path');",
			`const sessionId = ${JSON.stringify(sessionId)};`,
			"const codexHome = process.env.CODEX_HOME;",
			"const sessionDir = join(codexHome, 'sessions', '2026', '05', '01');",
			"mkdirSync(sessionDir, { recursive: true });",
			"writeFileSync(",
			"  join(sessionDir, `rollout-2026-05-01T01-05-00-${sessionId}.jsonl`),",
			"  [",
			"    JSON.stringify({ timestamp: '2026-04-30T17:05:00.000Z', type: 'session_meta', payload: { id: sessionId } }),",
			"    JSON.stringify({ timestamp: '2026-04-30T17:05:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'PARTIAL_FAILED_SESSION' } }),",
			"    '',",
			"  ].join('\\n'),",
			"  'utf8',",
			");",
			"console.error('FAILED_FORWARD');",
			"process.exit(1);",
		]);
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_HOME: codexHome,
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("FAILED_FORWARD");
		expect(existsSync(join(codexHome, "session_index.jsonl"))).toBe(false);
	});

	it("skips already indexed rollout files during local session index repair", () => {
		const fixtureRoot = createWrapperFixture();
		const codexHome = join(fixtureRoot, "codex-home");
		const indexedSessionId = "019ddf58-f831-7e12-bf4a-fae1ed000011";
		const mismatchedPayloadId = "019ddf58-f831-7e12-bf4a-fae1ed000012";
		const missingSessionId = "019ddf58-f831-7e12-bf4a-fae1ed000013";
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(
			join(codexHome, "session_index.jsonl"),
			`${JSON.stringify({
				id: indexedSessionId,
				thread_name: "Already indexed",
				updated_at: "2026-04-30T17:10:00.000Z",
			})}\n`,
			"utf8",
		);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const { mkdirSync, writeFileSync } = require('node:fs');",
			"const { join } = require('node:path');",
			`const indexedSessionId = ${JSON.stringify(indexedSessionId)};`,
			`const mismatchedPayloadId = ${JSON.stringify(mismatchedPayloadId)};`,
			`const missingSessionId = ${JSON.stringify(missingSessionId)};`,
			"const codexHome = process.env.CODEX_HOME;",
			"const sessionDir = join(codexHome, 'sessions', '2026', '05', '01');",
			"mkdirSync(sessionDir, { recursive: true });",
			"writeFileSync(",
			"  join(sessionDir, `rollout-2026-05-01T01-09-00-${indexedSessionId}.jsonl`),",
			"  [",
			"    JSON.stringify({ timestamp: '2026-04-30T17:09:00.000Z', type: 'session_meta', payload: { id: indexedSessionId } }),",
			"    JSON.stringify({ timestamp: '2026-04-30T17:09:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'ALREADY_INDEXED_SHOULD_SKIP' } }),",
			"    '',",
			"  ].join('\\n'),",
			"  'utf8',",
			");",
			"writeFileSync(",
			"  join(sessionDir, `rollout-2026-05-01T01-10-00-${indexedSessionId}.jsonl`),",
			"  [",
			"    JSON.stringify({ timestamp: '2026-04-30T17:10:00.000Z', type: 'session_meta', payload: { id: mismatchedPayloadId } }),",
			"    JSON.stringify({ timestamp: '2026-04-30T17:10:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'SHOULD_NOT_BE_REPAIRED' } }),",
			"    '',",
			"  ].join('\\n'),",
			"  'utf8',",
			");",
			"writeFileSync(",
			"  join(sessionDir, `rollout-2026-05-01T01-11-00-${missingSessionId}.jsonl`),",
			"  [",
			"    JSON.stringify({ timestamp: '2026-04-30T17:11:00.000Z', type: 'session_meta', payload: { id: missingSessionId } }),",
			"    JSON.stringify({ timestamp: '2026-04-30T17:11:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'MISSING_SESSION' } }),",
			"    '',",
			"  ].join('\\n'),",
			"  'utf8',",
			");",
			"console.log('FORWARDED_INDEX_FAST_PATH');",
			"process.exit(0);",
		]);
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_HOME: codexHome,
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED_INDEX_FAST_PATH");
		const index = readFileSync(join(codexHome, "session_index.jsonl"), "utf8");
		expect(index).toContain(indexedSessionId);
		expect(index).toContain(missingSessionId);
		expect(index).toContain("MISSING_SESSION");
		expect(index).not.toContain(mismatchedPayloadId);
		expect(index).not.toContain("ALREADY_INDEXED_SHOULD_SKIP");
		expect(index).not.toContain("SHOULD_NOT_BE_REPAIRED");
	});

	it("serializes concurrent local session index repairs", async () => {
		const fixtureRoot = createWrapperFixture();
		const codexHome = join(fixtureRoot, "codex-home");
		const readyDir = join(fixtureRoot, "ready");
		const firstSessionId = "019ddf58-f831-7e12-bf4a-fae1ed000101";
		const secondSessionId = "019ddf58-f831-7e12-bf4a-fae1ed000102";
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const { mkdirSync, readdirSync, writeFileSync } = require('node:fs');",
			"const { join } = require('node:path');",
			"const sessionId = process.env.CODEX_MULTI_AUTH_TEST_SESSION_ID;",
			"const marker = process.env.CODEX_MULTI_AUTH_TEST_MARKER;",
			"const codexHome = process.env.CODEX_HOME;",
			"const readyDir = process.env.CODEX_MULTI_AUTH_TEST_READY_DIR;",
			"const sessionDir = join(codexHome, 'sessions', '2026', '05', '01');",
			"mkdirSync(sessionDir, { recursive: true });",
			"mkdirSync(readyDir, { recursive: true });",
			"writeFileSync(",
			"  join(sessionDir, `rollout-2026-05-01T01-06-00-${sessionId}.jsonl`),",
			"  [",
			"    JSON.stringify({ timestamp: '2026-04-30T17:06:00.000Z', type: 'session_meta', payload: { id: sessionId } }),",
			"    JSON.stringify({ timestamp: '2026-04-30T17:06:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: marker } }),",
			"    '',",
			"  ].join('\\n'),",
			"  'utf8',",
			");",
			"writeFileSync(join(readyDir, `${sessionId}.ready`), '1', 'utf8');",
			"const deadline = Date.now() + 3000;",
			"while (Date.now() < deadline && readdirSync(readyDir).filter((entry) => entry.endsWith('.ready')).length < 2) {",
			"  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
			"}",
			"console.log(`FORWARDED_CONCURRENT:${sessionId}`);",
			"process.exit(0);",
		]);

		const [first, second] = await Promise.all([
			runWrapperAsync(fixtureRoot, ["exec", "status"], {
				CODEX_HOME: codexHome,
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
				CODEX_MULTI_AUTH_TEST_READY_DIR: readyDir,
				CODEX_MULTI_AUTH_TEST_SESSION_ID: firstSessionId,
				CODEX_MULTI_AUTH_TEST_MARKER: "FIRST_CONCURRENT_SESSION",
			}),
			runWrapperAsync(fixtureRoot, ["exec", "status"], {
				CODEX_HOME: codexHome,
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
				CODEX_MULTI_AUTH_TEST_READY_DIR: readyDir,
				CODEX_MULTI_AUTH_TEST_SESSION_ID: secondSessionId,
				CODEX_MULTI_AUTH_TEST_MARKER: "SECOND_CONCURRENT_SESSION",
			}),
		]);

		expect(first.status).toBe(0);
		expect(second.status).toBe(0);
		const index = readFileSync(join(codexHome, "session_index.jsonl"), "utf8");
		expect(index).toContain(firstSessionId);
		expect(index).toContain("FIRST_CONCURRENT_SESSION");
		expect(index).toContain(secondSessionId);
		expect(index).toContain("SECOND_CONCURRENT_SESSION");
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

	it.each([
		["shadow runtime", ["exec", "status"]],
		["interactive helper", ["resume", "session-fixture"]],
	])(
		"forwards an explicit loopback upstream through the %s proxy",
		async (_label, args) => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createFakeCodexBin(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const markerPath = join(fixtureRoot, "proxy-marker.txt");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);

			const result = runWrapper(fixtureRoot, args, {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL:
					"http://127.0.0.1:8787/backend-api",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "1000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "150",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER_UPSTREAM: "1",
			});

			expect(result.status).toBe(0);
			await waitForFileText(
				markerPath,
				[
					"upstream:http://127.0.0.1:8787/backend-api",
					"start:http://127.0.0.1:4567",
					"close",
					"",
				].join("\n"),
			);
		},
	);

	it.each([
		// An explicit default port is still an explicit port: `new URL()` erases
		// it, so the resolved value drops back to the canonical form.
		[
			"http://127.0.0.1:80/backend-api",
			"http://127.0.0.1/backend-api",
		],
		// The whole 127.0.0.0/8 block is loopback, not only 127.0.0.1.
		[
			"http://127.9.9.9:8787/backend-api",
			"http://127.9.9.9:8787/backend-api",
		],
		["http://[::1]:8787/backend-api", "http://[::1]:8787/backend-api"],
	])(
		"accepts the loopback runtime-proxy upstream %s",
		async (upstream, expectedForwarded) => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createFakeCodexBin(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const markerPath = join(fixtureRoot, "proxy-marker.txt");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);

			const result = runWrapper(fixtureRoot, ["exec", "status"], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL: upstream,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER_UPSTREAM: "1",
			});

			expect(result.status).toBe(0);
			await waitForFileText(
				markerPath,
				[
					`upstream:${expectedForwarded}`,
					"start:http://127.0.0.1:4567",
					"close",
					"",
				].join("\n"),
			);
		},
	);

	it("fails closed when runtime rotation is off but an upstream is configured", () => {
		// Regression: the upstream used to be resolved only AFTER the enabled
		// gate, so with rotation disabled the wrapper silently talked to the real
		// backend while the operator believed traffic was pinned to their local
		// listener.
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
			CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL:
				"http://127.0.0.1:8787/backend-api",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
		});

		expect(result.status).toBe(1);
		expect(combinedOutput(result)).toContain(
			"codex-multi-auth runtime rotation is disabled",
		);
		expect(result.stdout).not.toContain("FORWARDED:");
	});

	it("still runs a non-request subcommand when an upstream is configured", () => {
		// `--version` never reaches the backend, so there is no traffic to
		// misroute and the configured upstream is simply unused.
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["--version"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "0",
			CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL:
				"http://127.0.0.1:8787/backend-api",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:");
	});

	it.each([
		"https://127.0.0.1:8787/backend-api",
		"http://example.com:8787/backend-api",
		"http://127.0.0.1/backend-api",
		"http://user:pass@127.0.0.1:8787/backend-api",
		"http://127.0.0.1:8787/backend-api?route=unsafe",
		"http://127.0.0.1:8787/backend-api#unsafe",
		// A name is not a loopback guarantee: a hosts-file entry can point
		// `localhost` at a routable address and the upstream request carries the
		// managed OAuth bearer token.
		"http://localhost:8787/backend-api",
		"http://127.0.0.1.example.com:8787/backend-api",
		"http://[::2]:8787/backend-api",
		"not-a-url",
	])("fails closed for an unsafe runtime-proxy upstream: %s", (upstream) => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL: upstream,
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
		});

		expect(result.status).toBe(1);
		expect(combinedOutput(result)).toContain(
			"codex-multi-auth runtime rotation upstream is invalid",
		);
		expect(existsSync(markerPath)).toBe(false);
		expect(result.stdout).not.toContain("FORWARDED:");
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
			'console.log(`CODEX_MULTI_AUTH_DIR:${process.env.CODEX_MULTI_AUTH_DIR ?? ""}`);',
			'console.log(`OPENAI_API_KEY:${process.env.OPENAI_API_KEY ?? ""}`);',
			'console.log(`SESSION_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "sessions", "resume.jsonl"))}`);',
			'console.log(`PLUGIN_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "plugins", "plugin.txt"))}`);',
			'console.log(`SKILL_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "skills", "skill.txt"))}`);',
			'console.log(`MEMORY_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "memories", "user.md"))}`);',
			'console.log(`INSTRUCTION_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "instructions", "profile.md"))}`);',
			'console.log(`SANDBOX_BIN_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", ".sandbox-bin", "codex.exe"))}`);',
			'console.log(`MULTI_AUTH_MIRRORED:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "multi-auth"))}`);',
			'const authTmpPath = path.join(process.env.CODEX_HOME ?? "", "auth.json.1772056142508.3nwgwa.tmp");',
			'const accountsTmpPath = path.join(process.env.CODEX_HOME ?? "", "accounts.json.1772056142508.3nwgwa.tmp");',
			'const globalStateTmpPath = path.join(process.env.CODEX_HOME ?? "", ".codex-global-state.json.tmp-1777087904981-b612ed77-42c6-452a-a3ee-181a3806b475");',
			'const originalAuthTmpPath = path.join(process.env.ORIGINAL_CODEX_HOME ?? "", "auth.json.1772056142508.3nwgwa.tmp");',
			'const originalAccountsTmpPath = path.join(process.env.ORIGINAL_CODEX_HOME ?? "", "accounts.json.1772056142508.3nwgwa.tmp");',
			'const originalGlobalStateTmpPath = path.join(process.env.ORIGINAL_CODEX_HOME ?? "", ".codex-global-state.json.tmp-1777087904981-b612ed77-42c6-452a-a3ee-181a3806b475");',
			'console.log(`AUTH_TMP_MIRRORED:${fs.existsSync(authTmpPath)}`);',
			'console.log(`ACCOUNTS_TMP_MIRRORED:${fs.existsSync(accountsTmpPath)}`);',
			'console.log(`GLOBAL_STATE_TMP_MIRRORED:${fs.existsSync(globalStateTmpPath)}`);',
			'fs.writeFileSync(authTmpPath, "shadow-auth-tmp\\n", "utf8");',
			'fs.writeFileSync(accountsTmpPath, "shadow-accounts-tmp\\n", "utf8");',
			'fs.writeFileSync(globalStateTmpPath, "shadow-global-state-tmp\\n", "utf8");',
			'console.log(`AUTH_TMP_ISOLATED:${!fs.readFileSync(originalAuthTmpPath, "utf8").includes("shadow-auth-tmp")}`);',
			'console.log(`ACCOUNTS_TMP_ISOLATED:${!fs.readFileSync(originalAccountsTmpPath, "utf8").includes("shadow-accounts-tmp")}`);',
			'console.log(`GLOBAL_STATE_TMP_ISOLATED:${!fs.readFileSync(originalGlobalStateTmpPath, "utf8").includes("shadow-global-state-tmp")}`);',
			'const cachePath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite");',
			'const cacheWalPath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite-wal");',
			'const cacheShmPath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite-shm");',
			'console.log(`CACHE_SQLITE_MIRRORED:${fs.existsSync(cachePath)}`);',
			'console.log(`CACHE_WAL_MIRRORED:${fs.existsSync(cacheWalPath)}`);',
			'console.log(`CACHE_SHM_MIRRORED:${fs.existsSync(cacheShmPath)}`);',
			'const logPath = path.join(process.env.CODEX_HOME ?? "", "logs_2.sqlite");',
			'const logWalPath = path.join(process.env.CODEX_HOME ?? "", "logs_2.sqlite-wal");',
			'const logShmPath = path.join(process.env.CODEX_HOME ?? "", "logs_2.sqlite-shm");',
			'const originalLogPath = path.join(process.env.ORIGINAL_CODEX_HOME ?? "", "logs_2.sqlite");',
			'console.log(`LOG_SQLITE_MIRRORED:${fs.existsSync(logPath)}`);',
			'console.log(`LOG_WAL_MIRRORED:${fs.existsSync(logWalPath)}`);',
			'console.log(`LOG_SHM_MIRRORED:${fs.existsSync(logShmPath)}`);',
			'fs.writeFileSync(logPath, "shadow-log\\n", "utf8");',
			'fs.writeFileSync(logWalPath, "shadow-log-wal\\n", "utf8");',
			'fs.writeFileSync(logShmPath, "shadow-log-shm\\n", "utf8");',
			'console.log(`LOG_SQLITE_ISOLATED:${!fs.readFileSync(originalLogPath, "utf8").includes("shadow-log")}`);',
			'const upperLogPath = path.join(process.env.CODEX_HOME ?? "", "LOGS_3.sqlite");',
			'console.log(`UPPER_LOG_MIRRORED:${fs.existsSync(upperLogPath)}`);',
			'fs.appendFileSync(upperLogPath, "shadow-upper-log\\n", "utf8");',
			'fs.appendFileSync(cachePath, "shadow-cache\\n", "utf8");',
			'fs.appendFileSync(cacheWalPath, "shadow-wal\\n", "utf8");',
			'const upperStatePath = path.join(process.env.CODEX_HOME ?? "", "STATE_6.sqlite");',
			'console.log(`UPPER_STATE_MIRRORED:${fs.existsSync(upperStatePath)}`);',
			'fs.appendFileSync(upperStatePath, "shadow-upper\\n", "utf8");',
			'const statePath = path.join(process.env.CODEX_HOME ?? "", "state_5.sqlite");',
			'const stateWalPath = path.join(process.env.CODEX_HOME ?? "", "state_5.sqlite-wal");',
			'const stateShmPath = path.join(process.env.CODEX_HOME ?? "", "state_5.sqlite-shm");',
			'const originalStatePath = path.join(process.env.ORIGINAL_CODEX_HOME ?? "", "state_5.sqlite");',
			'console.log(`ROOT_STATE_MIRRORED:${fs.existsSync(statePath)}`);',
			'console.log(`ROOT_STATE_WAL_MIRRORED:${fs.existsSync(stateWalPath)}`);',
			'console.log(`ROOT_STATE_SHM_MIRRORED:${fs.existsSync(stateShmPath)}`);',
			'fs.writeFileSync(statePath, "shadow-only\\n", "utf8");',
			'console.log(`ROOT_STATE_ISOLATED:${!fs.readFileSync(originalStatePath, "utf8").includes("shadow-only")}`);',
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
		mkdirSync(join(originalHome, ".sandbox-bin"), { recursive: true });
		mkdirSync(join(originalHome, "multi-auth", "runtime-shadow-homes", "stale"), {
			recursive: true,
		});
		writeFileSync(join(originalHome, "sessions", "resume.jsonl"), "resume\n", "utf8");
		writeFileSync(join(originalHome, "plugins", "plugin.txt"), "plugin\n", "utf8");
		writeFileSync(join(originalHome, "skills", "skill.txt"), "skill\n", "utf8");
		writeFileSync(join(originalHome, "memories", "user.md"), "memory\n", "utf8");
		writeFileSync(join(originalHome, ".sandbox-bin", "codex.exe"), "sandbox\n", "utf8");
		writeFileSync(
			join(originalHome, "multi-auth", "runtime-shadow-homes", "stale", "payload.txt"),
			"stale shadow\n",
			"utf8",
		);
		writeFileSync(join(originalHome, "auth.json"), '{"token":"original"}\n', "utf8");
		writeFileSync(
			join(originalHome, "auth.json.1772056142508.3nwgwa.tmp"),
			"original auth tmp\n",
			"utf8",
		);
		writeFileSync(
			join(originalHome, "accounts.json.1772056142508.3nwgwa.tmp"),
			"original accounts tmp\n",
			"utf8",
		);
		writeFileSync(
			join(
				originalHome,
				".codex-global-state.json.tmp-1777087904981-b612ed77-42c6-452a-a3ee-181a3806b475",
			),
			"original global state tmp\n",
			"utf8",
		);
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
		writeFileSync(join(originalHome, "state_5.sqlite"), "not a sqlite database\n", "utf8");
		writeFileSync(join(originalHome, "state_5.sqlite-wal"), "original wal\n", "utf8");
		writeFileSync(join(originalHome, "state_5.sqlite-shm"), "original shm\n", "utf8");
		writeFileSync(join(originalHome, "STATE_6.sqlite"), "upper state\n", "utf8");
		writeFileSync(join(originalHome, "logs_2.sqlite"), "original log\n", "utf8");
		writeFileSync(join(originalHome, "logs_2.sqlite-wal"), "original log wal\n", "utf8");
		writeFileSync(join(originalHome, "logs_2.sqlite-shm"), "original log shm\n", "utf8");
		writeFileSync(join(originalHome, "LOGS_3.sqlite"), "upper log\n", "utf8");
		writeFileSync(join(originalHome, "plugin_cache.sqlite"), "cache\n", "utf8");
		writeFileSync(join(originalHome, "plugin_cache.sqlite-wal"), "cache wal\n", "utf8");
		writeFileSync(join(originalHome, "plugin_cache.sqlite-shm"), "cache shm\n", "utf8");
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
			CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_DIR_COPY: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain(
			`FORWARDED:exec status -c cli_auth_credentials_store="file" -c model_provider="${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		expect(output).toContain("CODEX_HOME_IS_ORIGINAL:false");
		expect(output).toContain(
			`CODEX_MULTI_AUTH_DIR:${join(originalHome, "multi-auth")}`,
		);
		expect(output).toContain("SESSION_EXISTS:true");
		expect(output).toContain("PLUGIN_EXISTS:true");
		expect(output).toContain("SKILL_EXISTS:true");
		expect(output).toContain("MEMORY_EXISTS:true");
		expect(output).toContain("INSTRUCTION_EXISTS:true");
		expect(output).toContain("SANDBOX_BIN_EXISTS:false");
		expect(output).toContain("MULTI_AUTH_MIRRORED:false");
		expect(output).toContain("AUTH_TMP_MIRRORED:false");
		expect(output).toContain("ACCOUNTS_TMP_MIRRORED:false");
		expect(output).toContain("GLOBAL_STATE_TMP_MIRRORED:false");
		expect(output).toContain("AUTH_TMP_ISOLATED:true");
		expect(output).toContain("ACCOUNTS_TMP_ISOLATED:true");
		expect(output).toContain("GLOBAL_STATE_TMP_ISOLATED:true");
		expect(output).toContain("CACHE_SQLITE_MIRRORED:true");
		expect(output).toContain("CACHE_WAL_MIRRORED:true");
		expect(output).toContain("CACHE_SHM_MIRRORED:true");
		expect(output).toContain("LOG_SQLITE_MIRRORED:false");
		expect(output).toContain("LOG_WAL_MIRRORED:false");
		expect(output).toContain("LOG_SHM_MIRRORED:false");
		expect(output).toContain("LOG_SQLITE_ISOLATED:true");
		expect(output).toContain(
			`UPPER_LOG_MIRRORED:${process.platform === "win32" || process.platform === "darwin" ? "false" : "true"}`,
		);
		expect(output).toContain(
			`UPPER_STATE_MIRRORED:${process.platform === "win32" || process.platform === "darwin" ? "false" : "true"}`,
		);
		expect(output).toContain("ROOT_STATE_MIRRORED:false");
		expect(output).toContain("ROOT_STATE_WAL_MIRRORED:false");
		expect(output).toContain("ROOT_STATE_SHM_MIRRORED:false");
		expect(output).toContain("ROOT_STATE_ISOLATED:true");
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
			const expectedRoot = resolve(originalHome, "multi-auth", "runtime-shadow-homes");
			const actual = resolve(shadowHomeMatch[1]);
			const shadowRelativePath = relative(expectedRoot, actual);
			expect(shadowRelativePath).not.toMatch(/^\.\.(?:[\\/]|$)/);
			expect(isAbsolute(shadowRelativePath)).toBe(false);
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
		expect(readFileSync(join(originalHome, "state_5.sqlite"), "utf8")).toBe(
			"not a sqlite database\n",
		);
		expect(readFileSync(join(originalHome, "state_5.sqlite-wal"), "utf8")).toBe(
			"original wal\n",
		);
		expect(readFileSync(join(originalHome, "state_5.sqlite-shm"), "utf8")).toBe(
			"original shm\n",
		);
		expect(
			readFileSync(
				join(originalHome, "auth.json.1772056142508.3nwgwa.tmp"),
				"utf8",
			),
		).toBe("original auth tmp\n");
		expect(
			readFileSync(
				join(originalHome, "accounts.json.1772056142508.3nwgwa.tmp"),
				"utf8",
			),
		).toBe("original accounts tmp\n");
		expect(
			readFileSync(
				join(
					originalHome,
					".codex-global-state.json.tmp-1777087904981-b612ed77-42c6-452a-a3ee-181a3806b475",
				),
				"utf8",
			),
		).toBe("original global state tmp\n");
		expect(readFileSync(join(originalHome, "logs_2.sqlite"), "utf8")).toBe(
			"original log\n",
		);
		expect(readFileSync(join(originalHome, "logs_2.sqlite-wal"), "utf8")).toBe(
			"original log wal\n",
		);
		expect(readFileSync(join(originalHome, "logs_2.sqlite-shm"), "utf8")).toBe(
			"original log shm\n",
		);
		if (process.platform === "win32" || process.platform === "darwin") {
			expect(readFileSync(join(originalHome, "LOGS_3.sqlite"), "utf8")).toBe(
				"upper log\n",
			);
		} else {
			expect(readFileSync(join(originalHome, "LOGS_3.sqlite"), "utf8")).toContain(
				"shadow-upper-log",
			);
		}
		if (process.platform === "win32" || process.platform === "darwin") {
			expect(readFileSync(join(originalHome, "STATE_6.sqlite"), "utf8")).toBe(
				"upper state\n",
			);
		} else {
			expect(readFileSync(join(originalHome, "STATE_6.sqlite"), "utf8")).toContain(
				"shadow-upper",
			);
		}
		expect(readFileSync(join(originalHome, "plugin_cache.sqlite"), "utf8")).toContain(
			"shadow-cache",
		);
		expect(readFileSync(join(originalHome, "plugin_cache.sqlite-wal"), "utf8")).toContain(
			"shadow-wal",
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
		expect(output).toContain(
			"codex-multi-auth: skipped optional shadow-home directory .sandbox-bin because linking failed",
		);
	});

	it("warns when sqlite sidecar placeholder materialization fails", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const cachePath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite");',
			'const cacheWalPath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite-wal");',
			'const cacheShmPath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite-shm");',
			'console.log(`CACHE_SQLITE_MIRRORED:${fs.existsSync(cachePath)}`);',
			'console.log(`CACHE_WAL_MIRRORED:${fs.existsSync(cacheWalPath)}`);',
			'console.log(`CACHE_SHM_MIRRORED:${fs.existsSync(cacheShmPath)}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "plugin_cache.sqlite"), "cache\n", "utf8");
		writeFileSync(join(originalHome, "plugin_cache.sqlite-wal"), "cache wal\n", "utf8");
		writeFileSync(join(originalHome, "plugin_cache.sqlite-shm"), "cache shm\n", "utf8");

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_BASE_URL: "http://127.0.0.1:4567",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SQLITE_SIDECAR_LINK_FAILURE: "1",
			CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SIDECAR_PLACEHOLDER_FAILURE: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain("CACHE_SQLITE_MIRRORED:false");
		expect(output).toContain("CACHE_WAL_MIRRORED:false");
		expect(output).toContain("CACHE_SHM_MIRRORED:false");
		expect(output).toContain(
			"codex-multi-auth: skipped SQLite shadow-home sidecar placeholder for",
		);
		expect(output).toContain("plugin_cache.sqlite-wal");
		expect(output).toContain("simulated SQLite sidecar placeholder failure");
	});

	it("removes sqlite materialization when a missing sidecar placeholder fails", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const cachePath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite");',
			'const cacheWalPath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite-wal");',
			'const cacheShmPath = path.join(process.env.CODEX_HOME ?? "", "plugin_cache.sqlite-shm");',
			'console.log(`CACHE_SQLITE_MIRRORED:${fs.existsSync(cachePath)}`);',
			'console.log(`CACHE_WAL_MIRRORED:${fs.existsSync(cacheWalPath)}`);',
			'console.log(`CACHE_SHM_MIRRORED:${fs.existsSync(cacheShmPath)}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "plugin_cache.sqlite"), "cache\n", "utf8");
		writeFileSync(join(originalHome, "plugin_cache.sqlite-wal"), "cache wal\n", "utf8");

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_BASE_URL: "http://127.0.0.1:4567",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SIDECAR_PLACEHOLDER_FAILURE: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain("CACHE_SQLITE_MIRRORED:false");
		expect(output).toContain("CACHE_WAL_MIRRORED:false");
		expect(output).toContain("CACHE_SHM_MIRRORED:false");
		expect(output).toContain(
			"codex-multi-auth: skipped SQLite shadow-home sidecar placeholder for",
		);
		expect(output).toContain("plugin_cache.sqlite-shm");
		expect(output).toContain("simulated SQLite sidecar placeholder failure");
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

	it("mirrors trusted user hook state into the runtime shadow config", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const config = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");',
			'const hooks = fs.readFileSync(path.join(process.env.CODEX_HOME, "hooks.json"), "utf8");',
			'console.log(`SHADOW_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'console.log(`HOOKS_JSON:${JSON.stringify(hooks)}`);',
			'console.log(`CONFIG_HAS_CRLF:${config.includes("\\r\\n")}`);',
			'console.log(config);',
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const alternateHome = join(fixtureRoot, "other-codex-home");
		const sourceHooksPath = join(originalHome, "hooks.json");
		const alternateHooksPath = join(alternateHome, "hooks.json");
		const sessionStartKey = `${sourceHooksPath}:session_start:0:0`;
		const stopKey = `${sourceHooksPath}:stop:0:0`;
		const userPromptSubmitKey = `${sourceHooksPath}:user_prompt_submit:0:0`;
		const preCompactKey = `${sourceHooksPath}:pre_compact:0:0`;
		const longPathKey = `${sourceHooksPath}:${"long-event-".repeat(24)}:0:0`;
		const alternateKey = `${alternateHooksPath}:alternate_event:0:0`;
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(alternateHome, { recursive: true });
		expect(longPathKey.length).toBeGreaterThan(256);
		writeFileSync(sourceHooksPath, HOOKS_JSON_TEXT, "utf8");
		writeFileSync(alternateHooksPath, '{"alternate":true}\n', "utf8");
		const originalConfig = [
			'model_provider = "openai"',
			"",
			hookStateHeader(sessionStartKey),
			"enabled = true",
			'trusted_hash = "sha256:session-start"',
			"",
			hookStateHeader(stopKey),
			"enabled = true",
			'trusted_hash = "sha256:stop"',
			"",
			literalHookStateHeader(userPromptSubmitKey),
			"enabled = true",
			"",
			hookStateHeader(preCompactKey),
			"enabled = true",
			'trusted_hash = "sha256:pre-compact"',
			'approval_reason = "reviewed manually"',
			'review_notes = """',
			"[not-a-table]",
			'"""',
			"review_batches = [",
			'  ["alpha"],',
			'  ["omega"]',
			"]",
			"",
			hookStateHeader(longPathKey),
			"enabled = true",
			'trusted_hash = "sha256:long-path"',
			"",
			hookStateHeader(alternateKey),
			"enabled = true",
			'trusted_hash = "sha256:alternate"',
		].join("\r\n");
		writeFileSync(join(originalHome, "config.toml"), originalConfig, "utf8");

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(JSON.parse(extractLineValue(output, "HOOKS_JSON:"))).toBe(
			HOOKS_JSON_TEXT,
		);
		expect(extractLineValue(output, "CONFIG_HAS_CRLF:")).toBe("true");

		const shadowHome = extractLineValue(output, "SHADOW_HOME:");
		const shadowHooksPath = join(shadowHome, "hooks.json");
		expectMirroredHookStateBlock(
			output,
			originalConfig,
			hookStateHeader(sessionStartKey),
			hookStateHeader(`${shadowHooksPath}:session_start:0:0`),
			["enabled = true", 'trusted_hash = "sha256:session-start"'],
		);
		expectMirroredHookStateBlock(
			output,
			originalConfig,
			hookStateHeader(stopKey),
			hookStateHeader(`${shadowHooksPath}:stop:0:0`),
			["enabled = true", 'trusted_hash = "sha256:stop"'],
		);
		expect(extractTomlTableBody(
			output,
			hookStateHeader(`${shadowHooksPath}:user_prompt_submit:0:0`),
		)).toBe("enabled = true");
		expectMirroredHookStateBlock(
			output,
			originalConfig,
			hookStateHeader(preCompactKey),
			hookStateHeader(`${shadowHooksPath}:pre_compact:0:0`),
			[
				"enabled = true",
				'trusted_hash = "sha256:pre-compact"',
				'approval_reason = "reviewed manually"',
				'review_notes = """',
				"[not-a-table]",
				'"""',
				"review_batches = [",
				'  ["alpha"],',
				'  ["omega"]',
				"]",
			],
		);
		expectMirroredHookStateBlock(
			output,
			originalConfig,
			hookStateHeader(longPathKey),
			hookStateHeader(`${shadowHooksPath}:${"long-event-".repeat(24)}:0:0`),
			["enabled = true", 'trusted_hash = "sha256:long-path"'],
		);
		expect(output).toContain(hookStateHeader(alternateKey));
		expect(output).not.toContain(
			hookStateHeader(`${shadowHooksPath}:alternate_event:0:0`),
		);
	});

	it("mirrors trusted hook state consistently for concurrent shadow launches", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const readyDir = join(fixtureRoot, "ready");
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const readyDir = process.env.CODEX_MULTI_AUTH_TEST_READY_DIR;',
			'const marker = process.env.CODEX_MULTI_AUTH_TEST_MARKER;',
			'fs.mkdirSync(readyDir, { recursive: true });',
			'fs.writeFileSync(path.join(readyDir, `${marker}.ready`), "1", "utf8");',
			"const deadline = Date.now() + 3000;",
			"while (Date.now() < deadline && fs.readdirSync(readyDir).filter((entry) => entry.endsWith('.ready')).length < 3) {",
			"  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
			"}",
			'console.log(`SHADOW_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'console.log(fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"));',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const sourceHooksPath = join(originalHome, "hooks.json");
		const sessionStartKey = `${sourceHooksPath}:session_start:0:0`;
		const stopKey = `${sourceHooksPath}:stop:0:0`;
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(sourceHooksPath, HOOKS_JSON_TEXT, "utf8");
		const originalConfig = [
			'model_provider = "openai"',
			"",
			hookStateHeader(sessionStartKey),
			"enabled = true",
			'trusted_hash = "sha256:session-start"',
			"",
			hookStateHeader(stopKey),
			"enabled = true",
			'trusted_hash = "sha256:stop"',
		].join("\n");
		writeFileSync(join(originalHome, "config.toml"), originalConfig, "utf8");

		const launches = ["first", "second", "third"].map((marker) =>
			runWrapperAsync(fixtureRoot, ["exec", "status"], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_TEST_READY_DIR: readyDir,
				CODEX_MULTI_AUTH_TEST_MARKER: marker,
				OPENAI_API_KEY: undefined,
			}),
		);
		const results = await Promise.all(launches);

		for (const result of results) {
			const output = combinedOutput(result);
			expect(result.status).toBe(0);
			const shadowHome = extractLineValue(output, "SHADOW_HOME:");
			const shadowHooksPath = join(shadowHome, "hooks.json");
			expectMirroredHookStateBlock(
				output,
				originalConfig,
				hookStateHeader(sessionStartKey),
				hookStateHeader(`${shadowHooksPath}:session_start:0:0`),
				["enabled = true", 'trusted_hash = "sha256:session-start"'],
			);
			expectMirroredHookStateBlock(
				output,
				originalConfig,
				hookStateHeader(stopKey),
				hookStateHeader(`${shadowHooksPath}:stop:0:0`),
				["enabled = true", 'trusted_hash = "sha256:stop"'],
			);
		}
	});

	// `app-server` used to take the shadow-home transport, which a resident server
	// cannot live on: the mirror links directories, so Codex's lstat-strict check
	// on `<CODEX_HOME>/app-server-control` refuses to start, and a server that does
	// start serves every attached client a frozen snapshot of the thread index for
	// its whole life. It now takes the canonical-home app helper, like the bare TUI
	// and `resume`/`fork` (#659).
	it("runs app-server on the canonical Codex home without capturing protocol stdio (#659)", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			"const args = process.argv.slice(2);",
			'console.log(`FORWARDED:${args.join(" ")}`);',
			'console.log(`HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);',
			'console.log(`OPENAI_API_KEY:${process.env.OPENAI_API_KEY ?? ""}`);',
			'console.log(`KEY_IN_ARGS:${args.includes(process.env.OPENAI_API_KEY ?? "__missing__")}`);',
			'console.log(`CODEX_CLI_PATH:${process.env.CODEX_CLI_PATH ?? ""}`);',
			'console.log(`APP_SERVER_LABEL:${process.env.CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL ?? ""}`);',
			'console.log(`RUNTIME_PROXY_ENV:${process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY ?? ""}`);',
			'console.log(`NODE_OPTIONS_HAS_APP_SERVER_PRELOAD:${(process.env.NODE_OPTIONS ?? "").includes("codex-multi-auth-app-server-preload.mjs")}`);',
			'const configPath = path.join(process.env.CODEX_HOME ?? "", "config.toml");',
			'console.log(`CONFIG:${fs.readFileSync(configPath, "utf8")}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const result = runWrapper(fixtureRoot, ["app-server", "--listen", "stdio://"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			ORIGINAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain("HOME_IS_ORIGINAL:true");
		expect(output).toContain(
			'FORWARDED:app-server --listen stdio:// -c cli_auth_credentials_store="file"',
		);
		// Rotation rides along as `-c` overrides on the command line rather than as a
		// rewritten shadow `config.toml`, so the canonical config is never touched.
		expect(output).toContain(
			`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.name="codex-multi-auth"`,
		);
		expect(output).toContain(
			`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.base_url=`,
		);
		expect(output).toContain(
			`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.env_key="OPENAI_API_KEY"`,
		);
		expect(output).toContain(
			`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.requires_openai_auth=false`,
		);
		expect(output).toContain(
			`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.http_headers.x-openai-actor-authorization="codex-multi-auth-local"`,
		);
		expect(output).toContain(
			`model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.wire_api="responses"`,
		);
		expect(output).toContain("disable_response_storage=false");
		expect(output).toContain(
			`model_provider="${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		// The bearer token reaches the server through the environment, never through
		// an argv the OS exposes to every other process on the machine.
		expect(output).toMatch(/^OPENAI_API_KEY:[0-9a-f]{64}$/m);
		expect(output).toContain("KEY_IN_ARGS:false");
		expect(output).toContain('CONFIG:model_provider = "openai"');
		expect(readFileSync(join(originalHome, "config.toml"), "utf8")).toBe(
			'model_provider = "openai"\n',
		);
		// The shadow transport is gone, not merely bypassed.
		expect(
			existsSync(join(originalHome, "multi-auth", "runtime-shadow-homes")),
		).toBe(false);
		// The app-server CLI shim exists so the Codex *desktop app* can have its own
		// `app-server` spawn intercepted through `CODEX_CLI_PATH`. A wrapper-invoked
		// app-server already carries the overrides on its command line, so it must
		// neither pay for the shim nor inherit the environment it stamps — most of
		// all `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0`, which every process the
		// server spawns would otherwise inherit and use to bypass the pool.
		expect(output).toMatch(/^CODEX_CLI_PATH:$/m);
		expect(output).toMatch(/^APP_SERVER_LABEL:$/m);
		expect(output).toContain("RUNTIME_PROXY_ENV:1");
		expect(output).toContain("NODE_OPTIONS_HAS_APP_SERVER_PRELOAD:false");
		// A resident server owns its proxy for its whole lifetime, so the helper is
		// stopped rather than left to idle out. No shortened idle timeout here on
		// purpose: this is a regression test for the detach clause, and a stranded
		// helper would keep the default 12h window and stay alive.
		await expectAppHelperReaped(markerPath);
	}, 20_000);

	// Reproduction 1 and 2 from #659, from the server's own point of view: the two
	// canonical-home entries that the shadow mirror destroyed.
	it("gives app-server a real app-server-control directory and the live thread index (#659)", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			"const args = process.argv.slice(2);",
			'const home = process.env.CODEX_HOME ?? "";',
			'console.log(`LISTEN:${args[args.indexOf("--listen") + 1] ?? ""}`);',
			// Codex applies an lstat-strict check here and refuses to start when the
			// path is a symlink, which is exactly what the shadow mirror made of it.
			'const controlPath = path.join(home, "app-server-control");',
			'const controlStat = fs.lstatSync(controlPath);',
			"console.log(`CONTROL_IS_DIR:${controlStat.isDirectory()}`);",
			"console.log(`CONTROL_IS_SYMLINK:${controlStat.isSymbolicLink()}`);",
			// The shadow mirror snapshots the runtime SQLite state rather than linking
			// it, so a resident server held a frozen copy of the thread index and threw
			// away every thread it created (#647 is the same defect for `resume`).
			'const statePath = path.join(home, "state_5.sqlite");',
			'console.log(`THREAD_INDEX:${fs.readFileSync(statePath, "utf8").trim()}`);',
			'fs.appendFileSync(statePath, "server-created-thread\\n", "utf8");',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		// Fixture-local, so concurrent workers and repeat runs cannot collide on a
		// process-global path.
		const socketPath = join(fixtureRoot, "app-server.sock");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(join(originalHome, "app-server-control"), { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		writeFileSync(
			join(originalHome, "state_5.sqlite"),
			"canonical-thread-index\n",
			"utf8",
		);

		const listenUrl = `unix://${socketPath.replace(/\\/g, "/")}`;
		const result = runWrapper(
			fixtureRoot,
			["app-server", "--listen", listenUrl],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID: "1",
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain(`LISTEN:${listenUrl}`);
		expect(output).toContain("CONTROL_IS_DIR:true");
		expect(output).toContain("CONTROL_IS_SYMLINK:false");
		expect(output).toContain("THREAD_INDEX:canonical-thread-index");
		// What the server writes lands in the canonical home rather than in a copy
		// that is discarded at exit.
		expect(readFileSync(join(originalHome, "state_5.sqlite"), "utf8")).toBe(
			"canonical-thread-index\nserver-created-thread\n",
		);
		await expectAppHelperReaped(markerPath);
	}, 20_000);

	// A supervised app-server that dies is the common production case, and it is
	// the branch that actually differs from the pre-#659 detach condition. Nothing
	// covered it before.
	it("stops the rotation helper when app-server exits nonzero (#659)", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(3);",
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
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID: "1",
			OPENAI_API_KEY: undefined,
		});

		expect(result.status).toBe(3);
		await expectAppHelperReaped(markerPath);
	}, 20_000);

	// The motivating use case for #659 is one account-pinned app-server per
	// account. The pin can only reach the proxy by environment across the detached
	// helper boundary, so pin the crossing for this branch too (#623).
	it("propagates the resolved --account pin into the app-server rotation helper (#659)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "forced-app-server-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeAccountsFixture(originalHome, 3);
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(0);",
		]);

		const result = runWrapper(
			fixtureRoot,
			["--account", "2", "app-server", "--listen", "stdio://"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER_FORCED: "1",
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		// The helper process saw the resolved index (account 2 -> 0-based 1).
		expect(readFileSync(markerPath, "utf8")).toContain("forced-index-env:1");
		// The launcher-only flag never reaches the official CLI.
		expect(output).not.toContain("--account");
	});

	// The shadow branch degrades to rotation-off when its proxy cannot start. The
	// helper branches have no such shape to fall back to, so they fail hard — but
	// hard has to mean a diagnostic and an exit code, not ERR_UNHANDLED_REJECTION
	// with a raw stack trace and a leaked compatibility home (#659).
	it("reports a clean error when the app-server rotation helper cannot start (#659)", () => {
		const fixtureRoot = createWrapperFixture();
		// Config helpers present, proxy module absent: the parent reaches the helper
		// branch, and the helper dies during startup.
		createRuntimeConfigTomlFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const result = runWrapper(fixtureRoot, ["app-server", "--listen", "stdio://"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(1);
		expect(output).toContain(
			"codex-multi-auth runtime rotation helper failed to start",
		);
		expect(output).not.toContain("ERR_UNHANDLED_REJECTION");
		// Failing hard means the server never ran unrotated.
		expect(output).not.toContain("FORWARDED:");
	});

	// `createCompatibilityCodexHome` runs *before* the transport is chosen, so a
	// helper that cannot start has to release a shadow home it never used. That
	// home is an `mkdtemp` under the OS temp dir — not the rotation shadow root
	// under `<CODEX_HOME>/multi-auth/runtime-shadow-homes` — so pointing TMPDIR at
	// the fixture is what makes the assertion deterministic and non-vacuous. Drop
	// the `baseContext.cleanup?.()` call on the failure path and this fails; on
	// Windows the stranded home is a locked directory the next run has to sweep.
	it("releases the compatibility home when the app-server rotation helper cannot start (#659)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeConfigTomlFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const controlledTmp = join(fixtureRoot, "tmp");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(controlledTmp, { recursive: true });
		// `--model gpt-5.5` coerces `max` down to `xhigh`, which is the only thing
		// that makes `createCompatibilityCodexHome` build a shadow mirror at all.
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\nmodel_reasoning_effort = "max"\n',
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["app-server", "--listen", "stdio://", "--model", "gpt-5.5"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				TMP: controlledTmp,
				TEMP: controlledTmp,
				TMPDIR: controlledTmp,
				OPENAI_API_KEY: undefined,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(1);
		expect(output).toContain(
			"codex-multi-auth runtime rotation helper failed to start",
		);
		expect(
			readdirSync(controlledTmp).filter((entry) =>
				entry.startsWith("codex-multi-auth-home-"),
			),
		).toEqual([]);
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

	it("starts an automatic helper and retries transient app-server shim file operations", async () => {
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
			CODEX_MULTI_AUTH_TEST_FORCE_APP_SERVER_SHIM_COPY: "1",
			...FAULT_INJECTION_ON,
			CODEX_MULTI_AUTH_TEST_APP_SERVER_SHIM_FILE_CLEANUP_BUSY_FAILURES: "2",
			CODEX_MULTI_AUTH_TEST_APP_SERVER_SHIM_COPY_BUSY_FAILURES: "2",
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
		expect(output, output).toContain("APP_SERVER_SHIM_STATUS:0");
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
		// Status is published per helper PID; exactly one helper ran here.
		const helperStatusFiles = readdirSync(multiAuthDir).filter((name) =>
			/^runtime-rotation-app-helper\.\d+\.json$/.test(name),
		);
		expect(helperStatusFiles).toHaveLength(1);
		const helperStatusPath = join(multiAuthDir, helperStatusFiles[0] ?? "");
		const helperStatus = JSON.parse(readFileSync(helperStatusPath, "utf8")) as {
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
			expect(statSync(helperStatusPath).mode & 0o777).toBe(0o600);
		}
		if (shadowHomeMatch?.[1]) {
			expect(existsSync(shadowHomeMatch[1])).toBe(false);
		}
		if (cliPathMatch?.[1]) {
			expect(existsSync(cliPathMatch[1])).toBe(false);
		}
	});

	it("keeps concurrent app-helper owner metadata isolated by helper PID", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"setTimeout(() => process.exit(0), 2000);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const children = [1, 2].map(() =>
			spawn(
				process.execPath,
				[join(fixtureRoot, "scripts", "codex.js"), "app", "."],
				{
					env: buildWrapperEnv({
						CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
						CODEX_HOME: originalHome,
						CODEX_MULTI_AUTH_DIR: multiAuthDir,
						CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
						CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
					}),
					stdio: ["ignore", "pipe", "pipe"],
				},
			),
		);
		for (const child of children) {
			child.stdout?.resume();
			child.stderr?.resume();
		}

		const waitForClose = (child: (typeof children)[number]) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 2_000);
				child.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		};

		let ownerFiles: string[] = [];
		try {
			const ownerFilePrefix = APP_RUNTIME_HELPER_OWNER_FILE.replace(
				/\.json$/i,
				"",
			);
			const ownerFilePattern = new RegExp(
				`^${ownerFilePrefix}\\.(\\d+)\\.json$`,
			);
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				ownerFiles = existsSync(multiAuthDir)
					? readdirSync(multiAuthDir).filter((name) =>
							ownerFilePattern.test(name),
						)
					: [];
				if (ownerFiles.length >= 2) break;
				await sleep(25);
			}

			expect(ownerFiles).toHaveLength(2);
			const ownerRecords = ownerFiles.map((name) =>
				JSON.parse(readFileSync(join(multiAuthDir, name), "utf8")),
			) as Array<{
				identityToken: string;
				launcherPid: number;
			}>;
			expect(new Set(ownerRecords.map((owner) => owner.identityToken)).size).toBe(
				2,
			);
			expect(new Set(ownerRecords.map((owner) => owner.launcherPid)).size).toBe(2);
			expect(
				existsSync(join(multiAuthDir, APP_RUNTIME_HELPER_OWNER_FILE)),
			).toBe(false);
		} finally {
			for (const child of children) {
				try {
					child.kill("SIGTERM");
				} catch {
					// The wrapper may already have exited after a failed launch.
				}
			}
			await Promise.all(children.map(waitForClose));

			const helperPids = new Set<number>();
			for (const name of ownerFiles) {
				const match = /\.(\d+)\.json$/i.exec(name);
				if (match?.[1]) helperPids.add(Number(match[1]));
			}
			for (const pid of helperPids) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// The helper may have stopped with its launcher.
				}
			}
			await sleep(500);
			for (const pid of helperPids) {
				if (!isProcessAlive(pid)) continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Best-effort cleanup for the detached fixture.
				}
			}
		}
	}, 15_000);

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

	// Skipped on Windows because the fixture cannot construct the state it is
	// about: the owner start time comes from `ps`, which does not exist there,
	// so the env var is empty, the identity branch never engages, and the test
	// would silently exercise bare liveness under a name claiming otherwise.
	// The Windows bare-liveness path has its own coverage below.
	it.skipIf(process.platform === "win32")(
		"keeps app helpers alive when owner liveness probes return EPERM",
		async () => {
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
						// Production launchers always pass the owner's start time, so
						// EPERM tolerance must hold on the identity branch, not just the
						// bare-liveness fallback — and a *matching* identity is what keeps
						// a live owner's helper alive (the false-positive direction).
						CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: String(
							readOwnProcessStartTimeMs() ?? "",
						),
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
		},
	);

	// Spawns a helper directly (the EPERM harness above) with the given env and
	// waits for its ready line; the caller owns assertions and shutdown.
	async function spawnDirectAppHelper(
		fixtureRoot: string,
		env: Record<string, string | undefined>,
	): Promise<{
		helper: ReturnType<typeof spawn>;
		ready: { statusPath: string; pid: number };
		closed: Promise<void>;
		output: () => string;
	}> {
		const helper = spawn(
			process.execPath,
			[join(fixtureRoot, "scripts", "codex.js"), "--codex-multi-auth-runtime-app-helper"],
			{
				env: buildWrapperEnv(env),
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
		// A rejection here throws before the caller reaches its try/finally, so
		// nothing would ever call `stopDirectAppHelper` — the harness for a leak
		// fix would leak a helper per failure, each holding a 1s status tick and,
		// on the long-idle fixtures, a ref'd handle for a minute. Kill on the way
		// out instead. (`close`-before-ready is already terminal.)
		const rejectAndReap = (
			reject: (error: Error) => void,
			error: Error,
		): void => {
			if (helper.pid && isProcessAlive(helper.pid)) {
				try {
					helper.kill("SIGKILL");
				} catch {
					// Best-effort: the helper may have exited between the check and here.
				}
			}
			reject(error);
		};
		const ready = await new Promise<{ statusPath: string; pid: number }>(
			(resolve, reject) => {
				const timeout = setTimeout(() => {
					rejectAndReap(
						reject,
						new Error(`helper did not become ready\n${stdout}\n${stderr}`),
					);
				}, 5_000);
				helper.stdout?.on("data", () => {
					const newlineIndex = stdout.indexOf("\n");
					if (newlineIndex < 0) return;
					try {
						const message = JSON.parse(stdout.slice(0, newlineIndex)) as {
							type?: string;
							statusPath?: string;
							pid?: number;
						};
						if (message.type === "ready" && message.statusPath && message.pid) {
							clearTimeout(timeout);
							resolve({ statusPath: message.statusPath, pid: message.pid });
						}
					} catch (error) {
						clearTimeout(timeout);
						rejectAndReap(
							reject,
							error instanceof Error ? error : new Error(String(error)),
						);
					}
				});
				helper.once("close", () => {
					clearTimeout(timeout);
					reject(new Error(`helper exited before ready\n${stdout}\n${stderr}`));
				});
			},
		);
		return { helper, ready, closed, output: () => `${stdout}\n${stderr}` };
	}

	async function stopDirectAppHelper(
		helper: ReturnType<typeof spawn>,
		closed: Promise<void>,
	): Promise<void> {
		if (helper.pid && isProcessAlive(helper.pid)) {
			helper.kill("SIGTERM");
		}
		await Promise.race([closed, sleep(2_000)]);
		if (helper.pid && isProcessAlive(helper.pid)) {
			helper.kill("SIGKILL");
			await Promise.race([closed, sleep(2_000)]);
		}
	}

	// The idle reaper's owner check is PID *plus* the owner's process start
	// time. A recycled PID — a live process holding the dead launcher's integer
	// — must not push the idle deadline forward: one false "alive" per window
	// is a ratchet the helper never recovers from, which is how helpers were
	// observed running 33 hours past a 12-hour timeout. Simulated here by
	// pointing the helper at a genuinely live process (this test) with a start
	// time that cannot match. Fails against the bare kill(pid, 0) check.
	// POSIX-only: on Windows there is no `ps`, identity is unknowable, and the
	// designed degradation is bare liveness — the companion test below.
	it.skipIf(process.platform === "win32")("idles out when the owner PID is alive but its identity does not match", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
			CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
			CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
		});
		try {
			await Promise.race([closed, sleep(5_000)]);
			expect(isProcessAlive(ready.pid)).toBe(false);
			const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
				state: string;
			};
			expect(status.state).toBe("idle-timeout");
		} finally {
			await stopDirectAppHelper(helper, closed);
		}
	});

	// The designed Windows degradation: with no `ps`, owner identity is
	// unknowable, and an unknowable identity must never kill a helper whose
	// owner PID is genuinely alive — bare liveness keeps it running.
	it.runIf(process.platform === "win32")(
		"keeps the helper alive when owner identity is unavailable",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
				// A start time that cannot match: with no way to read the real one,
				// the check must degrade to bare liveness, not declare death.
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
			});
			try {
				await sleep(1_000);
				expect(isProcessAlive(ready.pid)).toBe(true);
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		},
	);

	// The detach grace hands a helper off to nobody whenever a launcher merely
	// exits quickly — every short forwarded command strands one — and before
	// this window those helpers held the full idle timeout (12h by default)
	// with a dead owner, no traffic, and nothing connected. A stranded helper
	// is garbage the moment the detached window elapses. Owner death is
	// simulated the same way as the ratchet test: a live PID whose identity
	// cannot match, which the liveness check correctly reads as dead.
	it.skipIf(process.platform === "win32")(
		"reaps a stranded helper on the detached window instead of the full idle timeout",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			const markerPath = join(fixtureRoot, "proxy-marker.txt");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				// Idle can never fire inside this test; only the detached window can,
				// which is the whole point — before it existed, this helper lived on.
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "400",
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			});
			try {
				await Promise.race([closed, sleep(5_000)]);
				expect(isProcessAlive(ready.pid)).toBe(false);
				const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
					state: string;
					idleExpiresAt: number;
					updatedAt: number;
				};
				expect(status.state).toBe("owner-gone");
				// The reported deadline is the one actually enforced: `rotation
				// status` must not advertise the 60s idle window to a helper the
				// detached window is about to reap.
				expect(status.idleExpiresAt - status.updatedAt).toBeLessThan(60_000);
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		},
	);

	// The companion that runs everywhere, Windows included. The tests above
	// simulate owner death with an unmatchable start time, which only POSIX can
	// evaluate — with no `ps`, identity is unknowable and the check degrades to
	// bare liveness. A *genuinely* dead owner PID is readable on every
	// platform through that same bare check, so the reap itself is covered on
	// win32 even though the identity flavor of it cannot be.
	it("reaps a stranded helper whose owner PID is genuinely dead", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		// A PID this test owned and then killed, so "dead" is a fact rather than a
		// sentinel integer that different platforms classify differently.
		// `withDeadPid` is the shared version of exactly this — it waits on the
		// child's `exit` event instead of polling liveness, and re-checks the PID
		// was not recycled before handing it over — so the hand-rolled copy that
		// used to live here is gone.
		await withDeadPid(async (deadOwnerPid) => {
			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "400",
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(deadOwnerPid),
				// Left unset on purpose: this is the degraded bare-liveness path.
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: undefined,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
			});
			try {
				await Promise.race([closed, sleep(5_000)]);
				expect(isProcessAlive(ready.pid)).toBe(false);
				const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
					state: string;
				};
				expect(status.state).toBe("owner-gone");
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		});
	});

	// The detached window reaps strays, not handoffs. A consumer holding a
	// connection is the evidence that the detach was real — `codex app` hands
	// the desktop app a proxy and exits — so an attached helper keeps the full
	// idle timeout no matter how long its launcher has been gone.
	it.skipIf(process.platform === "win32")(
		"keeps a stranded helper alive while a client connection is open",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "200",
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
				CODEX_MULTI_AUTH_TEST_PROXY_OPEN_CONNECTIONS: "1",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
			});
			try {
				// Many detached windows' worth of ticks with a socket held open.
				await sleep(1_500);
				expect(isProcessAlive(ready.pid)).toBe(true);
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		},
	);

	// The detached window reaps helpers that were *stranded*, never helpers that
	// were handed off, and having served a request is the durable proof of a
	// handoff. An open socket is not: the proxy leaves `keepAliveTimeout` at
	// Node's 5s default, so a `codex app` session that is merely idle between
	// turns holds no socket within seconds of its last turn. Reaping on the
	// socket check alone would therefore kill the live proxy under a desktop app
	// whose user simply stopped typing for the length of the detached window,
	// and the next message would get ECONNREFUSED against a dead localhost port
	// with nothing left to restart it.
	//
	// Every helper in the #663 report had `totalRequests: 0` — the leak is
	// entirely a never-served phenomenon — so the narrower gate closes the leak
	// without putting live sessions at risk. A served-then-abandoned helper falls
	// back to the idle timeout and the lifetime ceiling, exactly as it did before
	// the detached window existed.
	it.skipIf(process.platform === "win32")(
		"keeps a helper that has served traffic alive after its traffic stops",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "400",
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
				// Traffic climbs for 300ms and then freezes: one served request is
				// all it takes, and the counter is frozen for many detached windows
				// afterwards with no socket held.
				CODEX_MULTI_AUTH_TEST_PROXY_REQUEST_RAMP_MS: "300",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
			});
			try {
				// Several detached windows past the end of the ramp.
				await sleep(2_500);
				expect(isProcessAlive(ready.pid)).toBe(true);
				const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
					state: string;
				};
				expect(status.state).toBe("running");
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		},
	);

	// The other half of the same rule: a helper whose owner is gone and which
	// never served anything is a stray, and the detached window still takes it.
	it.skipIf(process.platform === "win32")(
		"still reaps a stranded helper that never served a request",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "400",
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
			});
			try {
				await Promise.race([closed, sleep(5_000)]);
				expect(isProcessAlive(ready.pid)).toBe(false);
				const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
					state: string;
				};
				expect(status.state).toBe("owner-gone");
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		},
	);

	// "No owner PID was recorded" and "the owner is confirmed dead" are different
	// facts. Collapsing them into one falsy verdict started the detached clock on
	// the first tick for anyone invoking the helper directly — the documented
	// reproduction in #663 — or running one spawned by a pre-upgrade launcher
	// that sets no owner PID, and reaped it silently.
	it.skipIf(process.platform === "win32")(
		"does not start the detached clock for a helper launched without an owner PID",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "400",
				// Deliberately no CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID.
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
			});
			try {
				// Many detached windows with no owner and no traffic: the idle
				// timeout is the only clock that may apply, and it is 60s away.
				await sleep(2_500);
				expect(isProcessAlive(ready.pid)).toBe(true);
				const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
					state: string;
				};
				expect(status.state).toBe("running");
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		},
	);

	// Only a positive socket count is evidence of a consumer. A proxy that
	// answers with garbage must not be able to pin a stranded helper alive
	// forever — that is the leak wearing a different hat.
	for (const [label, reading] of [
		["a negative count", "-1"],
		["NaN", "nan"],
		["Infinity", "infinity"],
	] as const) {
		it.skipIf(process.platform === "win32")(
			`treats ${label} from the proxy as nothing attached and still reaps`,
			async () => {
				const fixtureRoot = createWrapperFixture();
				createRuntimeRotationProxyFixtureModule(fixtureRoot);
				const originalHome = join(fixtureRoot, "codex-home");
				const multiAuthDir = join(fixtureRoot, "multi-auth");
				mkdirSync(originalHome, { recursive: true });
				writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

				const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
					CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_DIR: multiAuthDir,
					CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
					CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
					CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "400",
					CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
					CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
					CODEX_MULTI_AUTH_TEST_PROXY_OPEN_CONNECTIONS: reading,
					CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
				});
				try {
					await Promise.race([closed, sleep(5_000)]);
					expect(isProcessAlive(ready.pid)).toBe(false);
					const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
						state: string;
					};
					expect(status.state).toBe("owner-gone");
				} finally {
					await stopDirectAppHelper(helper, closed);
				}
			},
		);
	}

	// The escape hatch is a real escape hatch: 0 restores the pre-fix behavior
	// for anyone who was depending on a stranded helper outliving its launcher
	// without holding a connection.
	it.skipIf(process.platform === "win32")(
		"keeps a stranded helper on the full idle timeout when the detached window is disabled",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

			const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "0",
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
				CODEX_MULTI_AUTH_APP_ROTATION_OWNER_START_TIME_MS: "12345",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
			});
			try {
				await sleep(1_500);
				expect(isProcessAlive(ready.pid)).toBe(true);
			} finally {
				await stopDirectAppHelper(helper, closed);
			}
		},
	);

	// The absolute lifetime ceiling is unconditional on activity: it exists for
	// exactly the case where activity accounting is wrong, so a genuinely live
	// owner must not extend a helper past it.
	it("stops at the max-lifetime ceiling even while its owner is alive", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			// Idle can never fire inside this test; only the ceiling can.
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
			CODEX_MULTI_AUTH_APP_ROTATION_MAX_LIFETIME_MS: "400",
			CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
		});
		try {
			await Promise.race([closed, sleep(5_000)]);
			expect(isProcessAlive(ready.pid)).toBe(false);
			const status = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
				state: string;
			};
			expect(status.state).toBe("max-lifetime");
		} finally {
			await stopDirectAppHelper(helper, closed);
		}
	});

	// N helpers, N status files: each helper publishes
	// `runtime-rotation-app-helper.<pid>.json` and never the shared legacy
	// path, so concurrent helpers stop last-writer-winning one file and every
	// reader can see every helper.
	it("publishes one status file per helper PID instead of one shared file", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const commonEnv = {
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
			CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
		};
		const first = await spawnDirectAppHelper(fixtureRoot, {
			...commonEnv,
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker-1.txt"),
		});
		try {
			const second = await spawnDirectAppHelper(fixtureRoot, {
				...commonEnv,
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker-2.txt"),
			});
			try {
				expect(first.ready.statusPath).not.toBe(second.ready.statusPath);
				expect(first.ready.statusPath).toContain(`.${first.ready.pid}.`);
				expect(second.ready.statusPath).toContain(`.${second.ready.pid}.`);
				const firstStatus = JSON.parse(
					readFileSync(first.ready.statusPath, "utf8"),
				) as { pid: number; state: string };
				const secondStatus = JSON.parse(
					readFileSync(second.ready.statusPath, "utf8"),
				) as { pid: number; state: string };
				expect(firstStatus.pid).toBe(first.ready.pid);
				expect(secondStatus.pid).toBe(second.ready.pid);
				expect(firstStatus.state).toBe("running");
				expect(secondStatus.state).toBe("running");
				expect(
					existsSync(join(multiAuthDir, "runtime-rotation-app-helper.json")),
				).toBe(false);
			} finally {
				await stopDirectAppHelper(second.helper, second.closed);
			}
		} finally {
			await stopDirectAppHelper(first.helper, first.closed);
		}
	});

	// One of the four defects was helpers rewriting status at 1 Hz; publishing
	// is now change-token + heartbeat. A quiet helper's status file must not
	// churn between ticks, or N helpers reintroduce the write storm silently.
	it("does not rewrite an unchanged status file on every tick", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");

		const { helper, ready, closed } = await spawnDirectAppHelper(fixtureRoot, {
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			// Long idle: the 1s tick keeps running, but with no traffic and a
			// 60s heartbeat nothing about the payload changes between ticks.
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
			CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(fixtureRoot, "marker.txt"),
		});
		try {
			const firstMtime = statSync(ready.statusPath).mtimeMs;
			// Several ticks pass (tick interval is 1s at this idle timeout).
			await sleep(2_600);
			expect(statSync(ready.statusPath).mtimeMs).toBe(firstMtime);
		} finally {
			await stopDirectAppHelper(helper, closed);
		}
	});

	// Windows can hold transient locks on files another process just closed;
	// metadata deletions retry instead of silently leaving the stale file the
	// sweep exists to remove.
	it("retries transient lock failures while sweeping helper metadata", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(multiAuthDir, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		const staleStatusPaths = [
			join(multiAuthDir, "runtime-rotation-app-helper.99999996.json"),
			join(multiAuthDir, "runtime-rotation-app-helper.99999997.json"),
		];
		for (const [index, path] of staleStatusPaths.entries()) {
			writeFileSync(
				path,
				`{"pid":9999999${6 + index},"state":"running"}\n`,
				"utf8",
			);
		}

		const result = runWrapper(fixtureRoot, ["app", "."], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
			// The failure counter is process-wide: two simulated EBUSY throws land
			// on the deletions in whatever order the sweep visits the two files.
			// `withSynchronousFileOperationRetry` allows four attempts per call, so
			// even the worst split (one file eating both failures) succeeds on that
			// file's third attempt — the outcome is order-independent as long as
			// the retry budget stays at three attempts or more. If that budget ever
			// shrinks below three, this test fails and the sweep would silently
			// leave stale metadata behind on transient Windows locks.
			...FAULT_INJECTION_ON,
			CODEX_MULTI_AUTH_TEST_HELPER_METADATA_CLEANUP_BUSY_FAILURES: "2",
			OPENAI_API_KEY: undefined,
		});
		expect(result.status).toBe(0);
		for (const path of staleStatusPaths) {
			expect(existsSync(path)).toBe(false);
		}
	});

	// `package.json` publishes `scripts/codex.js`, so this injector runs in every
	// user's install. Two things keep it inert there: the counter does nothing
	// without an explicit opt-in switch, and the value is parsed strictly —
	// `Number.parseInt` reads "2abc" as 2 and "1e3" as 1, which is how a value
	// that was never meant to be a count arms a fault injector (#668). Either
	// leak would silently defeat the first N metadata deletions of every sweep,
	// which is the exact accumulation the sweep exists to prevent.
	it.each([
		["without the opt-in switch", { CODEX_MULTI_AUTH_TEST_FAULT_INJECTION: undefined }],
		["with a non-numeric counter", { ...FAULT_INJECTION_ON }],
	] as const)(
		"ignores the metadata-cleanup fault injector %s",
		async (label, gateEnv) => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				"process.exit(0);",
			]);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			mkdirSync(multiAuthDir, { recursive: true });
			writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
			const staleStatusPath = join(
				multiAuthDir,
				"runtime-rotation-app-helper.99999996.json",
			);
			writeFileSync(staleStatusPath, '{"pid":99999996,"state":"running"}\n', "utf8");

			// A counter big enough to exhaust the retry budget several times over,
			// so if it were ever honoured the sweep could not recover.
			const result = runWrapper(fixtureRoot, ["app", "."], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
				...gateEnv,
				CODEX_MULTI_AUTH_TEST_HELPER_METADATA_CLEANUP_BUSY_FAILURES:
					label === "with a non-numeric counter" ? "99abc" : "99",
				OPENAI_API_KEY: undefined,
			});

			expect(result.status).toBe(0);
			expect(existsSync(staleStatusPath)).toBe(false);
		},
	);

	// The retry budget is finite, so a file that stays locked has to be survivable
	// rather than fatal: the sweep runs on the launcher's critical path, and a
	// helper launch must not fail because a stale file from some other helper
	// could not be deleted. The file simply waits for the next sweep.
	it("leaves a permanently locked metadata file behind without failing the launch", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(multiAuthDir, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		const staleStatusPath = join(
			multiAuthDir,
			"runtime-rotation-app-helper.99999995.json",
		);
		writeFileSync(staleStatusPath, '{"pid":99999995,"state":"running"}\n', "utf8");

		// Far more failures than `withSynchronousFileOperationRetry`'s budget, so
		// every attempt on this file throws EBUSY and the retry never succeeds.
		const result = runWrapper(fixtureRoot, ["app", "."], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
			...FAULT_INJECTION_ON,
			CODEX_MULTI_AUTH_TEST_HELPER_METADATA_CLEANUP_BUSY_FAILURES: "999",
			OPENAI_API_KEY: undefined,
		});

		// The launch succeeded...
		expect(result.status).toBe(0);
		// ...and the file it could not delete is still there for the next sweep,
		// rather than the error having escaped into the launcher.
		expect(existsSync(staleStatusPath)).toBe(true);
	});

	// Owner files have no post-mortem value and go with the helper; stale
	// per-PID metadata from killed helpers — and a legacy shared status file
	// whose recorded PID is dead — is swept when the next launcher starts a
	// helper, which is what keeps 579-files-vs-183-helpers from recurring.
	it("removes its owner file on exit and sweeps dead helpers' metadata on the next launch", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const multiAuthDir = join(fixtureRoot, "multi-auth");
		mkdirSync(originalHome, { recursive: true });
		mkdirSync(multiAuthDir, { recursive: true });
		writeFileSync(join(originalHome, "config.toml"), 'model_provider = "openai"\n', "utf8");
		// Metadata for a helper PID that cannot be alive, plus a legacy shared
		// status file recording the same dead PID: all three must be swept.
		const staleStatusPath = join(
			multiAuthDir,
			"runtime-rotation-app-helper.99999999.json",
		);
		const staleOwnerPath = join(
			multiAuthDir,
			"runtime-rotation-app-helper-owner.99999999.json",
		);
		const legacyStatusPath = join(multiAuthDir, "runtime-rotation-app-helper.json");
		writeFileSync(staleStatusPath, '{"pid":99999999,"state":"running"}\n', "utf8");
		writeFileSync(staleOwnerPath, '{"launcherPid":1,"identityToken":"x"}\n', "utf8");
		writeFileSync(legacyStatusPath, '{"pid":99999999,"state":"running"}\n', "utf8");

		const result = runWrapper(fixtureRoot, ["app", "."], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "250",
			OPENAI_API_KEY: undefined,
		});
		expect(result.status).toBe(0);

		// The launcher swept — after spawning its own helper, so the sweep never
		// sits in front of `codex app` startup, and before the launch handshake,
		// so it is complete by the time the wrapper exits.
		expect(existsSync(staleStatusPath)).toBe(false);
		expect(existsSync(staleOwnerPath)).toBe(false);
		expect(existsSync(legacyStatusPath)).toBe(false);

		// The launcher's own helper detached (grace window), then idles out with
		// its owner gone; on exit it removes its owner file and leaves only its
		// terminal status stamp.
		const ownerPattern = /^runtime-rotation-app-helper-owner\.(\d+)\.json$/;
		const statusPattern = /^runtime-rotation-app-helper\.(\d+)\.json$/;
		const deadline = Date.now() + 5_000;
		let ownerFiles: string[] = [];
		let statusFiles: string[] = [];
		let sawHelperMetadata = false;
		for (;;) {
			ownerFiles = readdirSync(multiAuthDir).filter((name) =>
				ownerPattern.test(name),
			);
			statusFiles = readdirSync(multiAuthDir).filter((name) =>
				statusPattern.test(name),
			);
			if (ownerFiles.length > 0 || statusFiles.length > 0) {
				sawHelperMetadata = true;
			}
			const statuses = statusFiles.map(
				(name) =>
					JSON.parse(readFileSync(join(multiAuthDir, name), "utf8")) as {
						state: string;
					},
			);
			if (
				sawHelperMetadata &&
				ownerFiles.length === 0 &&
				statuses.length > 0 &&
				statuses.every((status) => status.state !== "running")
			) {
				break;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`helper metadata did not settle: owners=${JSON.stringify(ownerFiles)} statuses=${JSON.stringify(statusFiles)}`,
				);
			}
			await sleep(50);
		}
		expect(ownerFiles).toHaveLength(0);
		expect(statusFiles).toHaveLength(1);
		const finalStatus = JSON.parse(
			readFileSync(join(multiAuthDir, statusFiles[0] ?? ""), "utf8"),
		) as { state: string };
		expect(finalStatus.state).toBe("idle-timeout");
	}, 15_000);

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
			["app", ".", "--model", "gpt-5.6-sol"],
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
		expect(output).toContain("Retrying with gpt-5.5");
		expect(output).toContain("FORWARDED:app . --model gpt-5.5");
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
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			'console.log(`CODEX_HOME:${process.env.CODEX_HOME ?? ""}`);',
			'console.log(`CODEX_MULTI_AUTH_DIR:${process.env.CODEX_MULTI_AUTH_DIR ?? ""}`);',
			'console.log(`CODEX_CLI_PATH:${process.env.CODEX_CLI_PATH ?? ""}`);',
			'console.log(`SHADOW_MULTI_AUTH_EXISTS:${fs.existsSync(path.join(process.env.CODEX_HOME ?? "", "multi-auth"))}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_reasoning_effort = "max"\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["app", ".", "--model", "gpt-5.5"], {
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
		expect(output).toContain("FORWARDED:app . --model gpt-5.5");
		expect(output).toContain(
			`CODEX_MULTI_AUTH_DIR:${join(originalHome, "multi-auth")}`,
		);
		expect(output).toContain("SHADOW_MULTI_AUTH_EXISTS:false");
		const cliPathMatch = output.match(/^CODEX_CLI_PATH:(.+)$/m);
		expect(cliPathMatch?.[1]).toBeTruthy();
		if (cliPathMatch?.[1]) {
			const shimRelativePath = relative(
				join(originalHome, "multi-auth", "app-server-shims"),
				resolve(cliPathMatch[1]),
			);
			expect(shimRelativePath).not.toMatch(/^\.\.(?:[\\/]|$)/);
			expect(isAbsolute(shimRelativePath)).toBe(false);
		}

		await sleep(2200);

		const marker = readFileSync(markerPath, "utf8");
		expect(marker).toContain(`real-home-env:${originalHome}\n`);
		// Status is per helper PID; the shared legacy path is no longer written.
		expect(
			readdirSync(join(originalHome, "multi-auth")).some((name) =>
				/^runtime-rotation-app-helper\.\d+\.json$/.test(name),
			),
		).toBe(true);
		const compatibilityHomeMatch = marker.match(/^codex-home-env:(.+)$/m);
		expect(compatibilityHomeMatch?.[1]).toBeTruthy();
		expect(compatibilityHomeMatch?.[1]).not.toBe(originalHome);
		expect(marker).toContain("close\n");
	});

	it("uses the canonical Codex home for interactive TUI runtime routing", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const { spawnSync } = require("node:child_process");',
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const args = process.argv.slice(2);',
			'if (args[0] === "app-server") {',
			'  console.log(`APP_SERVER_FORWARDED:${args.join(" ")}`);',
			"  process.exit(0);",
			"}",
			'const statePath = path.join(process.env.CODEX_HOME ?? "", "state_5.sqlite");',
			'const originalState = path.join(process.env.ORIGINAL_CODEX_HOME ?? "", "state_5.sqlite");',
			'console.log(`TUI_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);',
			'console.log(`TUI_STATE_EXISTED:${fs.existsSync(statePath)}`);',
			'fs.writeFileSync(statePath, "first-run-state\\n", "utf8");',
			'console.log(`TUI_STATE_PERSISTED:${fs.readFileSync(originalState, "utf8").includes("first-run-state")}`);',
			'console.log(`TUI_HAS_BASE_URL_OVERRIDE:${args.some((arg) => arg.includes("model_providers.codex-multi-auth-runtime-proxy.base_url="))}`);',
			'console.log(`TUI_HAS_ENV_KEY_OVERRIDE:${args.includes(\'model_providers.codex-multi-auth-runtime-proxy.env_key="OPENAI_API_KEY"\')}`);',
			'console.log(`TUI_HAS_AUTH_OVERRIDE:${args.includes("model_providers.codex-multi-auth-runtime-proxy.requires_openai_auth=false")}`);',
			'console.log(`TUI_HAS_WIRE_OVERRIDE:${args.includes(\'model_providers.codex-multi-auth-runtime-proxy.wire_api="responses"\')}`);',
			'console.log(`TUI_HAS_STORAGE_OVERRIDE:${args.includes("disable_response_storage=false")}`);',
			'console.log(`TUI_KEY_IN_ARGS:${args.includes(process.env.OPENAI_API_KEY ?? "__missing__")}`);',
			'const shimExe = path.join(process.env.CODEX_CLI_PATH ?? "", process.platform === "win32" ? "codex.exe" : "codex");',
			'const shimResult = spawnSync(shimExe, ["app-server", "--canonical-shim"], { encoding: "utf8", env: process.env });',
			'console.log(`TUI_SHIM_STATUS:${shimResult.status}`);',
			'console.log(`TUI_SHIM_STDOUT:${(shimResult.stdout ?? "").trim()}`);',
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

		const result = runWrapper(fixtureRoot, [], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			ORIGINAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain("TUI_HOME_IS_ORIGINAL:true");
		expect(output).toContain("TUI_STATE_EXISTED:false");
		expect(output).toContain("TUI_STATE_PERSISTED:true");
		expect(output).toContain("TUI_HAS_BASE_URL_OVERRIDE:true");
		expect(output).toContain("TUI_HAS_ENV_KEY_OVERRIDE:true");
		expect(output).toContain("TUI_HAS_AUTH_OVERRIDE:true");
		expect(output).toContain("TUI_HAS_WIRE_OVERRIDE:true");
		expect(output).toContain("TUI_HAS_STORAGE_OVERRIDE:true");
		expect(output).toContain("TUI_KEY_IN_ARGS:false");
		expect(output, output).toContain("TUI_SHIM_STATUS:0");
		expect(output).toContain(
			"APP_SERVER_FORWARDED:app-server --canonical-shim",
		);
		expect(output).toContain(
			"model_providers.codex-multi-auth-runtime-proxy.base_url=",
		);
		expect(output).toContain(
			'model_providers.codex-multi-auth-runtime-proxy.env_key="OPENAI_API_KEY"',
		);
		expect(output).toContain(
			"model_providers.codex-multi-auth-runtime-proxy.requires_openai_auth=false",
		);
		expect(output).toContain(
			'model_providers.codex-multi-auth-runtime-proxy.wire_api="responses"',
		);
		expect(output).toContain("disable_response_storage=false");
		expect(output).toContain(
			'model_provider="codex-multi-auth-runtime-proxy"',
		);
		expect(readFileSync(join(originalHome, "state_5.sqlite"), "utf8")).toBe(
			"first-run-state\n",
		);
		expect(readFileSync(join(originalHome, "config.toml"), "utf8")).toBe(
			'model_provider = "openai"\n',
		);
		await waitForFileText(
			markerPath,
			"start:http://127.0.0.1:4567\nclose\n",
		);
	});

	// The root grammar is `codex [OPTIONS] [PROMPT]`: an initial prompt makes the
	// launch no less interactive, but the classifier used to read the first
	// positional as a subcommand, so prompt-bearing launches fell through to the
	// shadow-home transport. The shadow mirror deliberately omits the runtime
	// SQLite state, so native Codex rebuilt the entire thread index from
	// rollouts — a startup stall that scales with session history — before it
	// submitted the already-delivered prompt (#673).
	for (const promptForm of [
		{
			label: "a prompt after value-consuming options",
			args: [
				"-c",
				'model_reasoning_effort="high"',
				"-i",
				"notes.png",
				// `--cd` ends the greedy image span; without an option (or `--`)
				// between them, native Codex reads the prompt as a second image.
				"--cd",
				".",
				"Reply with exactly READY, then stop.",
			],
			prompt: "Reply with exactly READY, then stop.",
			// The provider overrides are injected before the prompt, so the
			// prompt stays the final argument with the last override beside it.
			penultimateArg: 'model_provider="codex-multi-auth-runtime-proxy"',
		},
		{
			// `--` forces the positional, so prompt text that spells a real
			// command name must still launch the TUI: native Codex parses
			// `codex -- exec` as the prompt "exec", not as the exec subcommand.
			label: "a `--`-forced prompt that spells a command name",
			args: ["--", "exec"],
			prompt: "exec",
			// The overrides must land on the option side of the `--`, or Codex
			// would read them as prompt text.
			penultimateArg: "--",
		},
		{
			// `-i/--image` is greedy: native Codex consumes every free token up
			// to the next option, so the image list must stay contiguous and the
			// injected overrides must land after it — an override pair splitting
			// the list would demote the second image to the prompt and make the
			// real prompt an "unexpected argument" hard error.
			label: "a prompt after a greedy multi-image option",
			args: ["-i", "a.png", "b.png", "--cd", ".", "look at these"],
			prompt: "look at these",
			penultimateArg: 'model_provider="codex-multi-auth-runtime-proxy"',
		},
	] as const) {
		it(`uses the canonical Codex home for a TUI launch with ${promptForm.label} (#673)`, async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				'const fs = require("node:fs");',
				'const path = require("node:path");',
				"const args = process.argv.slice(2);",
				'if (args[0] === "app-server") {',
				'  console.log(`APP_SERVER_FORWARDED:${args.join(" ")}`);',
				"  process.exit(0);",
				"}",
				"console.log(`PROMPT_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
				// The thread index only exists in the canonical home; the shadow
				// mirror omits it, which is what forced the startup rebuild.
				'const statePath = path.join(process.env.CODEX_HOME ?? "", "state_5.sqlite");',
				"console.log(`PROMPT_SEES_THREAD_INDEX:${fs.existsSync(statePath)}`);",
				`console.log(\`PROMPT_ARG_VERBATIM:\${args.includes(${JSON.stringify(
					promptForm.prompt,
				)})}\`);`,
				"console.log(`PROMPT_LAST_ARG:${args[args.length - 1]}`);",
				"console.log(`PROMPT_PENULTIMATE_ARG:${args[args.length - 2]}`);",
				'console.log(`PROMPT_HAS_BASE_URL_OVERRIDE:${args.some((arg) => arg.includes("model_providers.codex-multi-auth-runtime-proxy.base_url="))}`);',
				"console.log(`PROMPT_CLI_PATH_IS_SHIM:${(process.env.CODEX_CLI_PATH ?? \"\").includes(\"app-server-shims\")}`);",
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
			writeFileSync(
				join(originalHome, "state_5.sqlite"),
				"canonical-thread-index\n",
				"utf8",
			);

			const result = runWrapper(fixtureRoot, [...promptForm.args], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				ORIGINAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				OPENAI_API_KEY: undefined,
			});

			const output = combinedOutput(result);
			if (result.status !== 0) {
				throw new Error(output);
			}
			expect(output).toContain("PROMPT_HOME_IS_ORIGINAL:true");
			expect(output).toContain("PROMPT_SEES_THREAD_INDEX:true");
			expect(output).toContain("PROMPT_ARG_VERBATIM:true");
			expect(output).toContain(`PROMPT_LAST_ARG:${promptForm.prompt}`);
			expect(output).toContain(
				`PROMPT_PENULTIMATE_ARG:${promptForm.penultimateArg}`,
			);
			// Rotation is still active: the proxy overrides ride along as `-c` args.
			expect(output).toContain("PROMPT_HAS_BASE_URL_OVERRIDE:true");
			expect(output).toContain("PROMPT_CLI_PATH_IS_SHIM:true");
			// The canonical home is never rewritten on disk.
			expect(readFileSync(join(originalHome, "config.toml"), "utf8")).toBe(
				'model_provider = "openai"\n',
			);
			await waitForFileText(markerPath, "start:http://127.0.0.1:4567\nclose\n");
		});
	}

	// Native Codex fills the root `[PROMPT]` slot with the first free token and
	// still tries a later one as a subcommand: `codex hello exec …` runs exec.
	// The classifier scans past unknown positionals the same way, so this stays
	// a noninteractive exec on the isolated shadow home (#673).
	it("classifies a command after a filled prompt slot like native Codex (#673)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"console.log(`SHADOW_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
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

		const result = runWrapper(fixtureRoot, ["hello", "exec", "echo hi"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			ORIGINAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain("SHADOW_HOME_IS_ORIGINAL:false");
	});

	// The alias resolves through the same allowlist as its canonical command, so
	// `codex e ...` must classify exactly like `codex exec ...` — a real
	// noninteractive request on the isolated shadow home, not a prompt (#673).
	it("keeps the `e` exec alias on the shadow Codex home (#673)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"console.log(`SHADOW_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
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

		const result = runWrapper(fixtureRoot, ["e", "do something"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			ORIGINAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(output).toContain("SHADOW_HOME_IS_ORIGINAL:false");
	});

	// The other alias: `a` resolves to `apply`, which makes no model requests,
	// so it must skip the rotation transport entirely — exactly like a spelled-
	// out `codex apply` always did, instead of routing as an unknown token (#673).
	it("forwards the `a` apply alias without starting the rotation transport (#673)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
			"console.log(`ALIAS_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
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

		const result = runWrapper(fixtureRoot, ["a"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			ORIGINAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		expect(existsSync(markerPath)).toBe(false);
		expect(output).toContain("ALIAS_HOME_IS_ORIGINAL:true");
		expect(output).toContain("FORWARDED:a");
		expect(output).not.toContain("model_provider=");
	});

	// A hidden root subcommand (absent from `codex --help`, real per
	// `codex help <name>`) is still a command, not a prompt: it keeps the
	// routing fall-through it always had instead of spinning up an interactive
	// canonical-home helper that would outlive its short clean exit (#673).
	//
	// The allowlist is what decides this, so a real root command missing from
	// it is misrouted rather than merely misnamed. `stdio-to-uds` is that case:
	// it is a genuine hidden root subcommand of codex-cli, and every invocation
	// classified as a prompt left a detached helper idling behind it.
	for (const args of [
		["execpolicy", "check"],
		["stdio-to-uds", "/tmp/codex.sock"],
	] as const) {
		it(`classifies the hidden \`${args[0]}\` subcommand as a command, not a prompt (#673)`, () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				"console.log(`SHADOW_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
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

			const result = runWrapper(fixtureRoot, [...args], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				ORIGINAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				OPENAI_API_KEY: undefined,
			});

			const output = combinedOutput(result);
			if (result.status !== 0) {
				throw new Error(output);
			}
			expect(output).toContain("SHADOW_HOME_IS_ORIGINAL:false");
		});
	}

	// `resume`/`fork` are interactive TUI entry points, but they carry a forwarded
	// subcommand, so they used to fall through to the shadow-home transport. The
	// shadow mirror omits the runtime SQLite state, so the requested thread was
	// missing from the shadow session index and the resumed TUI hung on a blank
	// screen (#647). Both must now reach the canonical home like the bare TUI.
	for (const command of ["resume", "fork"] as const) {
		it(`uses the canonical Codex home for \`${command}\` runtime routing (#647)`, async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				'const fs = require("node:fs");',
				'const path = require("node:path");',
				"const args = process.argv.slice(2);",
				'if (args[0] === "app-server") {',
				'  console.log(`APP_SERVER_FORWARDED:${args.join(" ")}`);',
				"  process.exit(0);",
				"}",
				"console.log(`RESUME_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
				// The thread index only exists in the canonical home; the shadow mirror
				// omits it, which is precisely what made resume hang.
				'const statePath = path.join(process.env.CODEX_HOME ?? "", "state_5.sqlite");',
				"console.log(`RESUME_SEES_THREAD_INDEX:${fs.existsSync(statePath)}`);",
				'console.log(`RESUME_COMMAND:${args[0]}`);',
				'console.log(`RESUME_SESSION_ID:${args[1]}`);',
				'console.log(`RESUME_HAS_BASE_URL_OVERRIDE:${args.some((arg) => arg.includes("model_providers.codex-multi-auth-runtime-proxy.base_url="))}`);',
				"console.log(`RESUME_CLI_PATH_IS_SHIM:${(process.env.CODEX_CLI_PATH ?? \"\").includes(\"app-server-shims\")}`);",
				"process.exit(0);",
			]);
			const originalHome = join(fixtureRoot, "codex-home");
			const markerPath = join(fixtureRoot, "proxy-marker.txt");
			const sessionId = "019ddf47-2c01-7c73-9f81-ab0cd9c1d5b7";
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);
			writeFileSync(
				join(originalHome, "state_5.sqlite"),
				"canonical-thread-index\n",
				"utf8",
			);

			const result = runWrapper(fixtureRoot, [command, sessionId], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				ORIGINAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				OPENAI_API_KEY: undefined,
			});

			const output = combinedOutput(result);
			if (result.status !== 0) {
				throw new Error(output);
			}
			expect(output).toContain("RESUME_HOME_IS_ORIGINAL:true");
			expect(output).toContain("RESUME_SEES_THREAD_INDEX:true");
			expect(output).toContain(`RESUME_COMMAND:${command}`);
			expect(output).toContain(`RESUME_SESSION_ID:${sessionId}`);
			// Rotation is still active: the proxy overrides ride along as `-c` args.
			expect(output).toContain("RESUME_HAS_BASE_URL_OVERRIDE:true");
			expect(output).toContain("RESUME_CLI_PATH_IS_SHIM:true");
			// The canonical home is never rewritten on disk.
			expect(readFileSync(join(originalHome, "config.toml"), "utf8")).toBe(
				'model_provider = "openai"\n',
			);
			await waitForFileText(markerPath, "start:http://127.0.0.1:4567\nclose\n");
		});
	}

	// The rotation helper injects its own options (shim args plus
	// `-c model_provider=...`) into subcommand argv, and appending those past a
	// `--` hands them to the subcommand as positionals instead. The separator
	// bounds that injection too (#673).
	it("injects rotation helper args before a `--` on the resume path (#673)", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			'if (args[0] === "app-server") process.exit(0);',
			"const sep = args.indexOf(\"--\");",
			"console.log(`SEP_INDEX:${sep}`);",
			"console.log(`AFTER_SEP:${args.slice(sep + 1).join(\" \")}`);",
			'console.log(`OVERRIDE_BEFORE_SEP:${args.slice(0, sep).some((a) => a.startsWith("model_provider="))}`);',
			"console.log(`FIRST_ARG:${args[0]}`);",
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

		const result = runWrapper(fixtureRoot, ["resume", "--last", "--", "do it"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			ORIGINAL_CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			OPENAI_API_KEY: undefined,
		});

		const output = combinedOutput(result);
		if (result.status !== 0) {
			throw new Error(output);
		}
		// The subcommand still leads, the injected overrides sit on the option
		// side, and only the user's own text survives past the separator.
		expect(output).toContain("FIRST_ARG:resume");
		expect(output).toContain("AFTER_SEP:do it");
		expect(output).toContain("OVERRIDE_BEFORE_SEP:true");
		await waitForFileText(markerPath, "start:http://127.0.0.1:4567\nclose\n");
	});

	// Printing help makes no model requests, so it must not pay for the rotation
	// transport at all. This matters most for resume/fork now that they are
	// interactive: that branch detaches its helper on a clean exit, so a helper
	// started for `--help` would outlive the wrapper and idle for its full timeout.
	// `exec`/`review` never stranded anything, but they did build a whole shadow
	// home just to print help, so every request command is covered (#647).
	for (const command of ["resume", "fork", "exec", "review"] as const) {
		for (const helpFlag of ["--help", "-h"] as const) {
			it(`forwards \`${command} ${helpFlag}\` without starting the rotation transport (#647)`, () => {
				const fixtureRoot = createWrapperFixture();
				createRuntimeRotationProxyFixtureModule(fixtureRoot);
				const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
					"#!/usr/bin/env node",
					'console.log(`FORWARDED:${process.argv.slice(2).join(" ")}`);',
					"console.log(`HELP_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
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

				const result = runWrapper(fixtureRoot, [command, helpFlag], {
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
					CODEX_HOME: originalHome,
					ORIGINAL_CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
					CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
					OPENAI_API_KEY: undefined,
				});

				const output = combinedOutput(result);
				if (result.status !== 0) {
					throw new Error(output);
				}
				// No proxy was ever started, on either transport: the marker is the
				// fixture proxy's only side effect and it is written at startup.
				expect(existsSync(markerPath)).toBe(false);
				expect(output).toContain("HELP_HOME_IS_ORIGINAL:true");
				// Help reaches Codex verbatim, with no injected provider overrides.
				expect(output).toContain(`FORWARDED:${command} ${helpFlag}`);
				expect(output).not.toContain("model_provider=");
			});
		}
	}

	// The help short-circuit keys off a help flag, not the command, so a real
	// resume must still take the rotation transport.
	it("still routes `resume` with a session id through rotation (#647)", () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			'if (args[0] === "app-server") process.exit(0);',
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
			["resume", "019ddf47-2c01-7c73-9f81-ab0cd9c1d5b7"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				OPENAI_API_KEY: undefined,
			},
		);

		if (result.status !== 0) {
			throw new Error(combinedOutput(result));
		}
		expect(existsSync(markerPath)).toBe(true);
	});

	// Guards the other half of the split: non-interactive request commands must keep
	// using the isolated shadow home, so widening the interactive classification
	// cannot silently move `exec`/`review` onto the canonical home.
	for (const command of ["exec", "review"] as const) {
		it(`keeps \`${command}\` on the shadow Codex home (#647)`, () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				"console.log(`SHADOW_HOME_IS_ORIGINAL:${process.env.CODEX_HOME === process.env.ORIGINAL_CODEX_HOME}`);",
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

			const result = runWrapper(fixtureRoot, [command, "do something"], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				ORIGINAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				OPENAI_API_KEY: undefined,
			});

			const output = combinedOutput(result);
			if (result.status !== 0) {
				throw new Error(output);
			}
			expect(output).toContain("SHADOW_HOME_IS_ORIGINAL:false");
		});
	}

	// The launcher only waits two seconds for the detached helper to stop, and it
	// reads the helper over piped stdio. When those pipes stay open past the window
	// the wrapper's event loop never drains and the shell prompt never comes back.
	// Here a leaked grandchild holds the write end, so `close` never fires and the
	// launcher must destroy and unref the handles itself (#647).
	it("returns to the shell when the app helper's stdio outlives its shutdown window (#647)", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			"const args = process.argv.slice(2);",
			'if (args[0] === "app-server") {',
			"  process.exit(0);",
			"}",
			// A nonzero Codex exit forces the launcher down the stop-the-helper path
			// rather than the detach-on-clean-exit path.
			"process.exit(3);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		// Comfortably longer than the bounded shutdown, and longer than the spawn
		// timeout, so a regression trips the timeout rather than racing it.
		const pipeHolderMs = 25_000;
		const startedAt = Date.now();
		const result = runWrapper(
			fixtureRoot,
			[],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
				CODEX_MULTI_AUTH_TEST_PROXY_PIPE_HOLDER_MS: String(pipeHolderMs),
				OPENAI_API_KEY: undefined,
			},
			{ timeoutMs: WRAPPER_SHUTDOWN_TIMEOUT_MS },
		);
		const elapsedMs = Date.now() - startedAt;

		// The wrapper came back at all, and it did so on the 2s graceful window rather
		// than waiting out the process still holding its pipes.
		expectWrapperReturned(result, "a leaked grandchild still holds its stdio");
		expect(result.status).toBe(3);
		expect(elapsedMs).toBeLessThan(WRAPPER_SHUTDOWN_TIMEOUT_MS);
	}, SHUTDOWN_TEST_TIMEOUT_MS);

	// POSIX only: the launcher must escalate to SIGKILL when the helper ignores the
	// graceful SIGTERM. On Windows `kill()` is always an unconditional terminate, so
	// a helper cannot ignore it and this escalation cannot be exercised there.
	it.skipIf(process.platform === "win32")(
		"force-stops an app helper that ignores SIGTERM (#647)",
		async () => {
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				"const args = process.argv.slice(2);",
				'if (args[0] === "app-server") {',
				"  process.exit(0);",
				"}",
				// A nonzero Codex exit forces the launcher down the stop-the-helper path
				// rather than the detach-on-clean-exit path.
				"process.exit(3);",
			]);
			const originalHome = join(fixtureRoot, "codex-home");
			const markerPath = join(fixtureRoot, "proxy-marker.txt");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);

			const startedAt = Date.now();
			const result = runWrapper(
				fixtureRoot,
				[],
				{
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
					CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
					CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
					CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
					CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID: "1",
					// The helper's SIGTERM handler awaits `close()`, which never resolves
					// here, so only the force-kill fallback can stop it.
					CODEX_MULTI_AUTH_TEST_PROXY_CLOSE_HANG: "1",
					OPENAI_API_KEY: undefined,
				},
				{ timeoutMs: WRAPPER_SHUTDOWN_TIMEOUT_MS },
			);
			const elapsedMs = Date.now() - startedAt;

			// The wrapper returned at all: before the fix this call never came back.
			expectWrapperReturned(result, "the helper ignored SIGTERM");
			expect(result.status).toBe(3);
			expect(elapsedMs).toBeLessThan(WRAPPER_SHUTDOWN_TIMEOUT_MS);

			const pidMatch = readFileSync(markerPath, "utf8").match(
				/^start:[^\n]*:pid=(\d+)$/m,
			);
			expect(pidMatch?.[1]).toBeTruthy();
			const helperPid = Number(pidMatch?.[1]);

			// SIGKILL is asynchronous; give the OS a moment to reap the helper.
			for (let attempt = 0; attempt < 40 && isProcessAlive(helperPid); attempt += 1) {
				await sleep(100);
			}
			expect(isProcessAlive(helperPid)).toBe(false);
		},
		SHUTDOWN_TEST_TIMEOUT_MS,
	);

	// Canonical-home routing drops the per-session shadow copy, so two concurrent
	// interactive sessions now share the real Codex home. That is how the stock
	// CLI already behaves, but it has to be proven rather than assumed: neither
	// session may lose state written by the other, and neither may fail to launch.
	it("keeps both sessions' state when two canonical TUI sessions overlap", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			"const args = process.argv.slice(2);",
			'if (args[0] === "app-server") {',
			"  process.exit(0);",
			"}",
			'const id = process.env.CODEX_MULTI_AUTH_TEST_SESSION_ID ?? "unknown";',
			'const home = process.env.CODEX_HOME ?? "";',
			'console.log(`TUI_HOME_IS_ORIGINAL:${home === process.env.ORIGINAL_CODEX_HOME}`);',
			'const sessionsDir = path.join(home, "sessions");',
			"fs.mkdirSync(sessionsDir, { recursive: true });",
			"const startedAt = Date.now();",
			'fs.writeFileSync(path.join(sessionsDir, id + ".jsonl"), "session-" + id + "\\n", "utf8");',
			"// Linger so both sessions are genuinely in-flight at the same time,",
			"// rather than serialising by accident and proving nothing.",
			"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);",
			'console.log(`TUI_SESSION_WINDOW:${id}:${startedAt}:${Date.now()}`);',
			'console.log(`TUI_SESSION_DONE:${id}`);',
			"process.exit(0);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const launch = (id: string) =>
			runWrapperAsync(fixtureRoot, [], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				ORIGINAL_CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
				CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(
					fixtureRoot,
					`proxy-marker-${id}.txt`,
				),
				CODEX_MULTI_AUTH_TEST_SESSION_ID: id,
				OPENAI_API_KEY: undefined,
			});

		const results = await Promise.all([launch("alpha"), launch("beta")]);

		for (const result of results) {
			const output = combinedOutput(result);
			if (result.status !== 0) {
				throw new Error(output);
			}
			expect(output).toContain("TUI_HOME_IS_ORIGINAL:true");
		}
		expect(combinedOutput(results[0])).toContain("TUI_SESSION_DONE:alpha");
		expect(combinedOutput(results[1])).toContain("TUI_SESSION_DONE:beta");

		// Prove the sessions actually overlapped. If they serialised, the test
		// would pass without ever exercising concurrency.
		const windows = results.map((result) => {
			const match = combinedOutput(result).match(
				/TUI_SESSION_WINDOW:\w+:(\d+):(\d+)/,
			);
			if (!match) throw new Error("missing session window marker");
			return { start: Number(match[1]), end: Number(match[2]) };
		});
		const [first, second] = windows as [
			{ start: number; end: number },
			{ start: number; end: number },
		];
		expect(first.start).toBeLessThan(second.end);
		expect(second.start).toBeLessThan(first.end);

		// Neither session's state may be lost to the other.
		expect(
			readFileSync(join(originalHome, "sessions", "alpha.jsonl"), "utf8"),
		).toBe("session-alpha\n");
		expect(
			readFileSync(join(originalHome, "sessions", "beta.jsonl"), "utf8"),
		).toBe("session-beta\n");
		// The real config is still only touched via -c overrides.
		expect(readFileSync(join(originalHome, "config.toml"), "utf8")).toBe(
			'model_provider = "openai"\n',
		);
	});

	it("stops detached TUI app helpers after failed launches", async () => {
		const fixtureRoot = createWrapperFixture();
		createRuntimeRotationProxyFixtureModule(fixtureRoot);
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"#!/usr/bin/env node",
			'console.error("tui failed");',
			"process.exit(1);",
		]);
		const originalHome = join(fixtureRoot, "codex-home");
		const markerPath = join(fixtureRoot, "proxy-marker.txt");
		mkdirSync(originalHome, { recursive: true });
		writeFileSync(
			join(originalHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const result = runWrapper(fixtureRoot, [], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "10000",
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER: markerPath,
			CODEX_MULTI_AUTH_TEST_PROXY_MARKER_PID: "1",
			OPENAI_API_KEY: undefined,
		});

		expect(result.status).toBe(1);
		const marker = readFileSync(markerPath, "utf8");
		const helperPid = Number(
			marker.match(/^start:http:\/\/127\.0\.0\.1:4567:pid=(\d+)$/m)?.[1] ?? NaN,
		);
		expect(Number.isFinite(helperPid)).toBe(true);
		expect(isProcessAlive(helperPid)).toBe(false);
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

	// Issue #641: the per-invocation `-c` override only covers the process this
	// wrapper spawns. Third-party front-ends exec the official binary directly
	// and read config.toml, so the persisted value has to be reconciled too or
	// they keep raising macOS login-keychain prompts.
	it("reconciles the persisted auth store before forwarding", () => {
		const fixtureRoot = createWrapperFixture();
		const callDir = createAuthStoreWriterFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec status -c cli_auth_credentials_store="file"',
		);
		expect(readAuthStoreCallCount(callDir)).toBe(1);
	});

	it("skips the persisted auth-store reconcile when the opt-out env var is disabled", () => {
		const fixtureRoot = createWrapperFixture();
		const callDir = createAuthStoreWriterFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE: "0",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).not.toContain('cli_auth_credentials_store="file"');
		expect(readAuthStoreCallCount(callDir)).toBe(0);
	});

	// Windows locks config.toml aggressively (EPERM/EBUSY). A failed reconcile
	// must never block the wrapped command — the per-invocation `-c` override
	// still protects this run.
	it("keeps forwarding when the persisted auth-store reconcile fails", () => {
		const fixtureRoot = createWrapperFixture();
		const callDir = createAuthStoreWriterFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_TEST_AUTH_STORE_FAIL: "1",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec status -c cli_auth_credentials_store="file"',
		);
		expect(readAuthStoreCallCount(callDir)).toBe(1);
	});

	it("forwards normally when the compiled auth-store module is absent", () => {
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

	// test/AGENTS.md requires the bin wrapper's lazy-load / missing-dist paths to
	// be covered under concurrent invocations: the auth-store guard imports
	// dist/ on every startup, so a missing module must degrade per-process
	// rather than letting one launch's failed import affect another.
	it("forwards every concurrent launch when the compiled auth-store module is absent", async () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				runWrapperAsync(fixtureRoot, ["exec", "status"], {
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				}),
			),
		);

		for (const result of results) {
			expect(combinedOutput(result)).toContain(
				'FORWARDED:exec status -c cli_auth_credentials_store="file"',
			);
			expect(result.status).toBe(0);
		}
	});

	// Same shape, but with the module present: concurrent reconciles race on the
	// same config.toml, and none of them may fail the wrapped command.
	it("forwards every concurrent launch while reconciling the same config", async () => {
		const fixtureRoot = createWrapperFixture();
		const callDir = createAuthStoreWriterFixtureModule(fixtureRoot);
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				runWrapperAsync(fixtureRoot, ["exec", "status"], {
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				}),
			),
		);

		for (const result of results) {
			expect(combinedOutput(result)).toContain(
				'FORWARDED:exec status -c cli_auth_credentials_store="file"',
			);
			expect(result.status).toBe(0);
		}
		expect(readAuthStoreCallCount(callDir)).toBe(4);
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

	// Everything after `--` is the root prompt, so prompt text that happens to
	// spell the override is not a caller override. Scanning past `--` would let
	// it suppress the injection and silently drop the file auth store (#673).
	it("still injects the file auth store when the prompt text spells the override (#673)", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		// A single token, which is the only runnable shape that tripped the old
		// scan: a two-token `-c <assignment>` prompt is surplus positionals that
		// Codex rejects before any of this matters.
		const result = runWrapper(
			fixtureRoot,
			["--", '--config=cli_auth_credentials_store="keyring"'],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			},
		);

		expect(result.status).toBe(0);
		// The wrapper's own override is injected ahead of the `--`, and the
		// prompt text reaches Codex untouched behind it.
		expect(result.stdout).toContain(
			'FORWARDED:-c cli_auth_credentials_store="file" -- --config=cli_auth_credentials_store="keyring"',
		);
	});

	// Appending past a `--` puts the injected pair in the subcommand's own
	// positional list, which Codex rejects with "unexpected argument '-c'".
	// The separator bounds the append for subcommand argv too (#673).
	it("injects the file auth store before a subcommand's `--` separator (#673)", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const result = runWrapper(fixtureRoot, ["exec", "--", "do the thing"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec -c cli_auth_credentials_store="file" -- do the thing',
		);
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

	it("creates a compatibility CODEX_HOME shadow when the requested model cannot accept the configured effort", () => {
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
				'model_reasoning_effort = "max"',
				'profile = "legacy-full-access"',
				"",
				'[profiles."legacy-full-access"]',
				'model_reasoning_effort = "max"',
				"",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.5"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_HOME: originalHome,
			CODEX_MULTI_AUTH_DIR: undefined,
		});

		expect(result.status).toBe(0);
		const output = combinedOutput(result);
		expect(output).toContain('FORWARDED:exec status --model gpt-5.5 -c cli_auth_credentials_store="file"');
		expect(output).not.toContain(`CODEX_HOME:${originalHome}`);
		expect(output).toContain("CODEX_MULTI_AUTH_DIR_JSON:null");
		expect(output).toContain("AUTH_EXISTS:true");
		expect(output).toContain("AUTH_JSON:{}");
		expect(output).toContain("AUTH_MODE:");
		expect(output).toContain('model_reasoning_effort = "xhigh"');
		expect(output).toContain("CONFIG_MODE:");
		expect(output).not.toContain('model_reasoning_effort = "max"');
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
			'model_reasoning_effort = "max"\n',
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.5"], {
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");

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
			["exec", "status", "--model", "gpt-5.5"],
			{
				...commonEnv,
				CODEX_MULTI_AUTH_TEST_SESSION_ID: "first",
				...injectShadowSyncMetadataBusyFailures(),
			},
		);
		const second = runWrapperAsync(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
			'model_reasoning_effort = "max"\n',
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");
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
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });
		if (ownerContent !== undefined) {
			writeFileSync(join(lockDir, "owner.json"), ownerContent, "utf8");
		}
		await ageShadowSyncLockForSteal(lockDir);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "owner.json"),
			`${JSON.stringify({ pid: 2_147_483_647, createdAt: 1 })}\n`,
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "owner.json"),
			`${JSON.stringify({ pid: 2_147_483_647, createdAt: 1 })}\n`,
			"utf8",
		);

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");
		const lockDir = join(originalHome, ".codex-multi-auth-shadow-sync.lock");
		mkdirSync(lockDir, { recursive: true });

		const startedAt = Date.now();
		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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
		writeFileSync(join(originalHome, "config.toml"), 'model_reasoning_effort = "max"\n', "utf8");

		const result = runWrapper(
			fixtureRoot,
			["exec", "status", "--model", "gpt-5.5"],
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

	it("keeps xhigh config reasoning when retired mini aliases route to gpt-5.6-terra", () => {
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
		expect(output).toContain("model_reasoning_effort = xhigh");
		expect(output).toContain("model_reasoning_effort = xhigh # keep comment");
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
				"gpt-5.5",
				"-c",
				'model_reasoning_effort="max"',
			],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
			},
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'FORWARDED:exec status --model gpt-5.5 -c model_reasoning_effort="xhigh" -c cli_auth_credentials_store="file"',
		);
		expect(result.stdout).not.toContain('model_reasoning_effort="max"');
	});

	it("keeps explicit xhigh reasoning for retired mini aliases routed to gpt-5.6-terra", () => {
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
		'FORWARDED:exec status --model gpt-5.1-codex-mini -c model_reasoning_effort="xhigh" -c cli_auth_credentials_store="file"',
	);
	});

	it("keeps xhigh overrides for stale bare GPT-5 aliases routed to their replacements", () => {
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
				`FORWARDED:exec status --model ${model} -c model_reasoning_effort="xhigh" -c cli_auth_credentials_store="file"`,
			);
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

	it("retries GPT-5.6 Sol with gpt-5.5 after unsupported-model failures", () => {
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
				"gpt-5.6-sol",
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
			"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
		);
		expect(output).toContain("Retrying with gpt-5.5");
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.5 -c model_reasoning_effort="low" -c cli_auth_credentials_store="file"',
		);
	});

	it("retries stale bare GPT-5 aliases with GPT-5.5 after unsupported-model failures", () => {
		const fixtureRoot = createWrapperFixture();
		const stateDir = join(fixtureRoot, "retry-state-bare-gpt5");
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
			["exec", "status", "--model", "gpt-5"],
			{
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
				CODEX_HOME: originalHome,
			},
		);

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(output).toContain(
			"The 'gpt-5' model is not supported when using Codex with a ChatGPT account.",
		);
		expect(output).toContain("Retrying with gpt-5.5");
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.5 -c cli_auth_credentials_store="file"',
		);
	});

	it("retries retired Codex aliases with their replacement after unsupported-model failures", () => {
		const fixtureRoot = createWrapperFixture();
		const stateDir = join(fixtureRoot, "retry-state-legacy-codex");
		mkdirSync(stateDir, { recursive: true });
		const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			"const counterPath = path.join(process.env.CODEX_MULTI_AUTH_TEST_STATE_DIR, 'attempt.txt');",
			"const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
			"fs.writeFileSync(counterPath, String(attempt + 1), 'utf8');",
			"const args = process.argv.slice(2);",
			"let modelIndex = args.indexOf('--model');",
			"if (modelIndex < 0) modelIndex = args.indexOf('-m');",
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
				"-m",
				"gpt-5-codex",
				"-c",
				'model_reasoning_effort="xhigh"',
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
			"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
		);
		expect(output).toContain("Retrying with gpt-5.6-sol");
		expect(output).toContain(
			'FORWARDED:exec status -m gpt-5.6-sol -c model_reasoning_effort="xhigh" -c cli_auth_credentials_store="file"',
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

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.6-sol"], {
			CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
			CODEX_HOME: originalHome,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(0);
		expect(readFileSync(join(stateDir, "attempt.txt"), "utf8")).toBe("2");
		expect(output).toContain("Retrying with gpt-5.5");
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.5 -c cli_auth_credentials_store="file"',
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
			"console.error(\"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.\");",
			"process.exit(1);",
		]);

		const result = runWrapper(fixtureRoot, ["exec", "status", "--model", "gpt-5.6-sol"], {
			CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT: "0",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_TEST_STATE_DIR: stateDir,
			CODEX_HOME: originalHome,
		});

		const output = combinedOutput(result);
		expect(result.status).toBe(1);
		expect(readFileSync(join(stateDir, "attempt.txt"), "utf8")).toBe("1");
		expect(output).toContain(
			"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
		);
		expect(output).not.toContain("Retrying with gpt-5.5");
	});

	it("retries GPT-5.6 Sol after access-denied style model errors", () => {
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
				"gpt-5.6-sol",
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
			"The model `gpt-5.6-sol` does not exist or you do not have access to it.",
		);
		expect(output).toContain("Retrying with gpt-5.5");
		expect(output).toContain(
			'FORWARDED:exec status --model gpt-5.5 -c model_reasoning_effort="low" -c cli_auth_credentials_store="file"',
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
				"gpt-5.5",
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
			'FORWARDED:exec status --model gpt-5.5 -c model_reasoning_effort="xhigh" -c cli_auth_credentials_store="file"',
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
			["exec", "status", "--model", "gpt-5.5-pro"],
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
		const pathEntry = win32.join("C:\\", "custom", "bin");
		const nativeCodexPath = win32.join(pathEntry, "codex");
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
		const pathEntry = win32.join("C:\\", "custom", "bin");
		const nativeCodexExePath = win32.join(pathEntry, "codex.exe");
		const nativeCodexPath = win32.join(pathEntry, "codex");
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
		const wrapperScriptPath = posix.join(
			"/test-root",
			"npm",
			"lib",
			"node_modules",
			"codex-multi-auth",
			"scripts",
			"codex.js",
		);
		const wrapperBinPath = posix.join("/test-root", "npm", "bin", "codex");
		const nativeCodexPath = posix.join("/test-root", "native", "bin", "codex");
		const resolved = resolveRealCodexBin({
			env: {
				PATH: [posix.join("/test-root", "npm", "bin"), posix.join("/test-root", "native", "bin")].join(":"),
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

	it("skips native codex candidates inside the wrapper's own directory (defense-in-depth self-loop guard)", () => {
		// Latent self-recursion: if the wrapper were exposed as a native
		// codex/codex.exe alongside codex.js, its realpath would NOT equal the
		// codex.js realpath, so the exact-path guard misses it. The directory guard
		// must still skip any candidate resolving inside the wrapper's own dir and
		// fall through to the genuine native binary elsewhere on PATH.
		const wrapperScriptPath = join(
			"/test-root",
			"npm",
			"lib",
			"node_modules",
			"codex-multi-auth",
			"scripts",
			"codex.js",
		);
		const wrapperDir = dirname(wrapperScriptPath);
		const wrapperSiblingCodexPath = join(wrapperDir, "codex");
		const nativeCodexPath = join("/test-root", "native", "bin", "codex");
		const resolved = resolveRealCodexBin({
			env: {
				PATH: [wrapperDir, join("/test-root", "native", "bin")].join(delimiter),
			},
			argv: [process.execPath, wrapperScriptPath],
			platform: "linux",
			moduleUrl: pathToFileURL(join(repoRootDir, "scripts", "codex.js")).href,
			resolvePackageBin: () => null,
			spawnSyncImpl: () => createSpawnSyncSuccess(""),
			existsSyncImpl: (candidate) =>
				candidate === wrapperSiblingCodexPath || candidate === nativeCodexPath,
			realpathSyncImpl: (candidate) => {
				if (candidate === join(repoRootDir, "scripts", "codex.js")) {
					return wrapperScriptPath;
				}
				// The sibling native binary has its OWN realpath (not codex.js), so the
				// exact-path guard would not catch it — only the directory guard does.
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

	it("skips startup update-notice loading when bypass is set", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const markerPath = join(fixtureRoot, "update-notice-loaded.txt");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "update-notice.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.env.CODEX_MULTI_AUTH_UPDATE_NOTICE_MARKER, 'loaded', 'utf8');",
				"export async function checkForUpdates() {",
				"\treturn { hasUpdate: false };",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["--version"], {
			CODEX_MULTI_AUTH_UPDATE_NOTICE_MARKER: markerPath,
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
	] as const)("skips startup update-notice loading for pure %s commands", (_label, args) => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const markerPath = join(fixtureRoot, "update-notice-loaded.txt");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "update-notice.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.env.CODEX_MULTI_AUTH_UPDATE_NOTICE_MARKER, 'loaded', 'utf8');",
				"export async function checkForUpdates() {",
				"\treturn { hasUpdate: false };",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, [...args], {
			CODEX_MULTI_AUTH_UPDATE_NOTICE_MARKER: markerPath,
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`FORWARDED:${args.join(" ")}`);
		expect(existsSync(markerPath)).toBe(false);
	});

	it("skips startup update-notice loading for local auth commands", () => {
		const fixtureRoot = createWrapperFixture();
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const markerPath = join(fixtureRoot, "update-notice-loaded.txt");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "update-notice.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.env.CODEX_MULTI_AUTH_UPDATE_NOTICE_MARKER, 'loaded', 'utf8');",
				"export async function checkForUpdates() {",
				"\treturn { hasUpdate: false };",
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
			CODEX_MULTI_AUTH_UPDATE_NOTICE_MARKER: markerPath,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("LOCAL:auth status");
		expect(existsSync(markerPath)).toBe(false);
	});

	it("ignores missing startup update-notice builds", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(result.stderr).not.toContain("update notice skipped");
		expect(result.stderr).not.toContain(
			"codex-multi-auth update available: v9.9.9",
		);
		expect(result.stderr).not.toContain(
			"npm install -g codex-multi-auth@latest",
		);
	});

	it("logs startup update notices with the manual install command in debug mode", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		const optionsPath = join(fixtureRoot, "update-notice-options.json");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "update-notice.js"),
			[
				'import { writeFileSync } from "node:fs";',
				"export async function checkForUpdates(force, fetchTimeoutMs) {",
				"\twriteFileSync(process.env.CODEX_MULTI_AUTH_UPDATE_NOTICE_OPTIONS, JSON.stringify({ force, fetchTimeoutMs }), 'utf8');",
				"\treturn { hasUpdate: true, currentVersion: '1.0.0', latestVersion: '9.9.9', updateCommand: 'npm install -g codex-multi-auth@latest' };",
				"}",
				"export function formatManualUpdateNotice(result) {",
				"\treturn `codex-multi-auth update available: v${result.latestVersion}; current: v${result.currentVersion}; run: ${result.updateCommand}`;",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_UPDATE_NOTICE_OPTIONS: optionsPath,
			CODEX_MULTI_AUTH_DEBUG: "1",
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(JSON.parse(readFileSync(optionsPath, "utf8"))).toEqual({
			force: false,
			fetchTimeoutMs: 2400,
		});
		expect(result.stderr).toContain(
			"codex-multi-auth update available: v9.9.9; current: v1.0.0; run: npm install -g codex-multi-auth@latest",
		);
		expect(result.stderr).not.toContain("npm update -g");
	});

	it("suppresses startup update notices in captured non-TTY output", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "update-notice.js"),
			[
				"export async function checkForUpdates() {",
				"\treturn { hasUpdate: true, currentVersion: '1.0.0', latestVersion: '9.9.9', updateCommand: 'npm install -g codex-multi-auth@latest' };",
				"}",
			].join("\n"),
			"utf8",
		);

		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(result.stderr).not.toContain("update available");
		expect(result.stderr).not.toContain("npm install -g codex-multi-auth@latest");
	});

	it("suppresses startup update-notice failures unless debug logging is enabled", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "update-notice.js"),
			[
				"export async function checkForUpdates() {",
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
			"codex-multi-auth: update notice skipped: registry unavailable",
		);
	});

	it("continues forwarded startup within the stable update-notice startup budget", () => {
		const fixtureRoot = createWrapperFixture();
		const fakeBin = createFakeCodexBin(fixtureRoot);
		const distLibDir = join(fixtureRoot, "dist", "lib");
		mkdirSync(distLibDir, { recursive: true });
		writeFileSync(
			join(distLibDir, "update-notice.js"),
			[
				"export async function checkForUpdates() {",
				"\treturn new Promise(() => undefined);",
				"}",
			].join("\n"),
			"utf8",
		);

		const startedAt = Date.now();
		const result = runWrapper(fixtureRoot, ["exec", "status"], {
			CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
			CODEX_MULTI_AUTH_TEST_STARTUP_UPDATE_NOTICE_BUDGET_MS: "25",
		});
		const elapsedMs = Date.now() - startedAt;

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("FORWARDED:exec status");
		expect(result.stderr).not.toContain("update notice skipped");
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

	// ------------------------------------------------------------------
	// Stress: the runtime behaviour, at the scale and duration #663 described.
	// The tests above pin one helper at a time over a few hundred milliseconds.
	// These drive many helpers, many launch cycles, and a directory already full
	// of stale metadata — the state the reporting machine was actually in.
	// POSIX-only for the same reason as the rest of the lifecycle suite.
	// ------------------------------------------------------------------

	function countHelperMetadata(multiAuthDir: string): {
		status: number;
		owner: number;
	} {
		let entries: string[] = [];
		try {
			entries = readdirSync(multiAuthDir);
		} catch (error) {
			// Only "the directory does not exist yet" is a legitimate zero. Any
			// other readdir failure — a permissions change, a path that is not a
			// directory — would otherwise be reported as a clean sweep, and the
			// bounded-metadata test below asserts upper bounds that a false zero
			// satisfies perfectly.
			const code =
				error && typeof error === "object" && "code" in error
					? String((error as { code?: unknown }).code)
					: "unknown";
			if (code !== "ENOENT") throw error;
			return { status: 0, owner: 0 };
		}
		return {
			status: entries.filter((n) =>
				/^runtime-rotation-app-helper\.\d+\.json$/.test(n),
			).length,
			owner: entries.filter((n) =>
				/^runtime-rotation-app-helper-owner\.\d+\.json$/.test(n),
			).length,
		};
	}

	it.skipIf(process.platform === "win32")(
		"stress: metadata stays bounded across many launch/exit cycles",
		async () => {
			// The reported accumulation was 10-28 helpers/hour under ordinary use,
			// ending at 183 live helpers and 701 owner files. One launch proves
			// nothing about that; the property is that repeating the cycle does not
			// grow the directory without bound. Each launch sweeps what the previous
			// one left, so the count must plateau rather than climb with the cycle
			// count.
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				"process.exit(0);",
			]);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			mkdirSync(multiAuthDir, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);

			// Before measuring accumulation, prove the fixture actually produces
			// helpers. Every assertion below is an upper bound, so a launch path
			// that silently never publishes metadata — a wrong env gate, a proxy
			// fixture that never engages, `app .` short-circuiting on the fake bin
			// — would leave every count at zero and pass the whole test while
			// demonstrating nothing about the leak it exists to guard.
			const probe = runWrapper(fixtureRoot, ["app", "."], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				// Long enough that the helper is unambiguously still alive when the
				// probe looks for it.
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "30000",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "0",
				OPENAI_API_KEY: undefined,
			});
			expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
			const probeCounts = countHelperMetadata(multiAuthDir);
			expect(probeCounts.status).toBeGreaterThan(0);
			expect(probeCounts.owner).toBeGreaterThan(0);
			// Tear that one down before the accumulation loop starts, so it cannot
			// be mistaken for a leaked helper later.
			const probeEntries = readdirSync(multiAuthDir).filter((name) =>
				name.startsWith("runtime-rotation-app-helper"),
			);
			for (const name of probeEntries) {
				const match = /\.(\d+)\.json$/.exec(name);
				const pid = match?.[1] ? Number.parseInt(match[1], 10) : null;
				if (pid !== null && isProcessAlive(pid)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already gone.
					}
				}
				rmSync(join(multiAuthDir, name), { force: true });
			}
			await sleep(200);

			const cycles = 30;
			const counts: number[] = [];
			let sawHelperDuringLoop = false;
			for (let cycle = 0; cycle < cycles; cycle += 1) {
				const result = runWrapper(fixtureRoot, ["app", "."], {
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
					CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_DIR: multiAuthDir,
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
					// Short enough that each helper is gone well before the next
					// launch sweeps for it.
					CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
					CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "150",
					OPENAI_API_KEY: undefined,
				});
				expect(result.status).toBe(0);
				await sleep(120);
				const sample = countHelperMetadata(multiAuthDir);
				if (sample.owner > 0 || sample.status > 0) sawHelperDuringLoop = true;
				counts.push(sample.owner);
			}

			// Give the last cycle's helper time to exit and one more launch to sweep
			// after it.
			await sleep(1_000);
			runWrapper(fixtureRoot, ["app", "."], {
				CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
				CODEX_HOME: originalHome,
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
				CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
				CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "150",
				OPENAI_API_KEY: undefined,
			});
			await sleep(1_000);

			const final = countHelperMetadata(multiAuthDir);
			const peak = Math.max(...counts);
			// The loop has to have observed at least one helper at some point,
			// otherwise the upper bounds below are vacuous.
			expect(sawHelperDuringLoop).toBe(true);
			// The pre-fix behaviour was one owner file per launch, kept forever, so
			// the count climbed with the cycle count. A few concurrent files are
			// expected — each helper outlives the launch that spawned it by its
			// idle window, so a sample can catch the previous cycle's helper still
			// running — but the number must be a function of that overlap, not of
			// how many times the loop ran. A ceiling well under `cycles` is what
			// separates the two; `< cycles` alone would only fail at the exact
			// worst case.
			expect(peak).toBeLessThan(10);
			expect(final.owner).toBeLessThan(5);
			expect(final.status).toBeLessThan(5);
		},
		240_000,
	);

	it.skipIf(process.platform === "win32")(
		"stress: concurrent helpers keep separate status files and are all discoverable",
		async () => {
			// Defect 3 in #663: one shared status path, N writers at 1 Hz, last
			// writer wins. Per-PID files are the fix; this asserts N concurrent
			// helpers really do produce N distinct records, each naming its own PID,
			// with none overwriting another.
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);

			const helperCount = 10;
			const spawned = await Promise.all(
				Array.from({ length: helperCount }, (_unused, index) =>
					spawnDirectAppHelper(fixtureRoot, {
						CODEX_HOME: originalHome,
						CODEX_MULTI_AUTH_DIR: multiAuthDir,
						CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
						CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
						CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
						CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "0",
						CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
						CODEX_MULTI_AUTH_TEST_PROXY_LAST_ACCOUNT_ID: `acc_${index}`,
						CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(
							fixtureRoot,
							`marker-${index}.txt`,
						),
					}),
				),
			);
			try {
				// Several publish ticks, so any trampling has had time to happen.
				await sleep(1_500);

				const pids = spawned.map((s) => s.ready.pid);
				expect(new Set(pids).size).toBe(helperCount);

				for (const { ready } of spawned) {
					expect(existsSync(ready.statusPath)).toBe(true);
					const record = JSON.parse(readFileSync(ready.statusPath, "utf8")) as {
						pid: number;
						state: string;
					};
					// Each file describes its own helper, not whichever wrote last.
					expect(record.pid).toBe(ready.pid);
					expect(record.state).toBe("running");
				}
				// And every one of them is still alive: nothing reaped a sibling.
				for (const pid of pids) {
					expect(isProcessAlive(pid)).toBe(true);
				}

				const counts = countHelperMetadata(multiAuthDir);
				expect(counts.status).toBe(helperCount);
			} finally {
				await Promise.all(
					spawned.map(({ helper, closed }) =>
						stopDirectAppHelper(helper, closed),
					),
				);
			}
		},
		180_000,
	);

	it.skipIf(process.platform === "win32")(
		"stress: the reap matrix reaps exactly the stranded helpers and no others",
		async () => {
			// The whole lifecycle contract in one run, with every configuration live
			// at the same time so a rule that fires on the wrong one is visible as a
			// divergence rather than as a single red test.
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);

			await withDeadPid(async (deadOwnerPid) => {
				const base = {
					CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_DIR: multiAuthDir,
					CODEX_MULTI_AUTH_REAL_CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
					CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "60000",
					CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "400",
				};
				const cases: Array<{
					label: string;
					survives: boolean;
					env: Record<string, string | undefined>;
				}> = [
					{
						label: "owner alive, never served",
						survives: true,
						env: {
							...base,
							CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(process.pid),
						},
					},
					{
						label: "owner dead, never served",
						survives: false,
						env: {
							...base,
							CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(deadOwnerPid),
						},
					},
					{
						label: "owner dead, served traffic",
						survives: true,
						env: {
							...base,
							CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(deadOwnerPid),
							CODEX_MULTI_AUTH_TEST_PROXY_REQUEST_RAMP_MS: "200",
						},
					},
					{
						label: "no owner recorded, never served",
						survives: true,
						env: { ...base },
					},
					{
						label: "owner dead, socket held",
						survives: true,
						env: {
							...base,
							CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID: String(deadOwnerPid),
							CODEX_MULTI_AUTH_TEST_PROXY_OPEN_CONNECTIONS: "1",
						},
					},
				];

				const running = await Promise.all(
					cases.map((testCase, index) =>
						spawnDirectAppHelper(fixtureRoot, {
							...testCase.env,
							CODEX_MULTI_AUTH_TEST_PROXY_MARKER: join(
								fixtureRoot,
								`matrix-${index}.txt`,
							),
						}),
					),
				);
				try {
					// Many detached windows: anything that is going to be reaped has
					// been, and anything that survives this has survived on a rule.
					await sleep(4_000);

					// Zipped off `running`, not indexed with a fallback: passing `0` to
					// `isProcessAlive` would probe the caller's own process group on
					// POSIX and answer true, so a missing helper would read as alive —
					// and four of these five cases expect exactly that.
					expect(running).toHaveLength(cases.length);
					const actual = running.map(({ ready }, index) => {
						const testCase = cases[index];
						expect(testCase).toBeDefined();
						return {
							label: testCase?.label ?? `case-${index}`,
							expected: testCase?.survives ?? false,
							alive: isProcessAlive(ready.pid),
							statusPath: ready.statusPath,
						};
					});
					// Compared as a whole so a failure names every divergence at once.
					expect(actual.map((a) => `${a.label}=${a.alive}`)).toEqual(
						actual.map((a) => `${a.label}=${a.expected}`),
					);

					// The one that died did so for the stated reason. Looked up by
					// label and asserted unconditionally: hardcoding an index meant
					// reordering `cases` would silently assert `owner-gone` against a
					// helper that was supposed to survive, and a guard around it would
					// let the only assertion that proves *why* it died skip itself.
					const reaped = actual.find(
						(a) => a.label === "owner dead, never served",
					);
					expect(reaped).toBeDefined();
					expect(reaped?.alive).toBe(false);
					const status = JSON.parse(
						readFileSync(reaped?.statusPath ?? "", "utf8"),
					) as { state: string };
					expect(status.state).toBe("owner-gone");
				} finally {
					await Promise.all(
						running.map(({ helper, closed }) =>
							stopDirectAppHelper(helper, closed),
						),
					);
				}
			});
		},
		180_000,
	);

	it.skipIf(process.platform === "win32")(
		"stress: a launcher sweeps a directory already holding hundreds of stale files",
		async () => {
			// 701 orphaned owner files was the reported end state. The sweep has a
			// probe budget and a retry ladder, both of which could in principle turn
			// a big directory into a slow or incomplete launch. Assert it reclaims
			// the lot and the launch still succeeds.
			const fixtureRoot = createWrapperFixture();
			createRuntimeRotationProxyFixtureModule(fixtureRoot);
			const fakeBin = createCustomFakeCodexBin(fixtureRoot, [
				"#!/usr/bin/env node",
				"process.exit(0);",
			]);
			const originalHome = join(fixtureRoot, "codex-home");
			const multiAuthDir = join(fixtureRoot, "multi-auth");
			mkdirSync(originalHome, { recursive: true });
			mkdirSync(multiAuthDir, { recursive: true });
			writeFileSync(
				join(originalHome, "config.toml"),
				'model_provider = "openai"\n',
				"utf8",
			);

			const staleCount = 350;
			await withDeadPids(staleCount, async (deadPids) => {
				for (const pid of deadPids) {
					writeFileSync(
						join(multiAuthDir, `runtime-rotation-app-helper.${pid}.json`),
						`${JSON.stringify({ pid, state: "running", startedAt: Date.now() })}\n`,
						"utf8",
					);
					writeFileSync(
						join(multiAuthDir, `runtime-rotation-app-helper-owner.${pid}.json`),
						`${JSON.stringify({ identityToken: "x", createdAt: Date.now() })}\n`,
						"utf8",
					);
				}
				const before = countHelperMetadata(multiAuthDir);
				expect(before.status).toBe(staleCount);
				expect(before.owner).toBe(staleCount);

				const startedAt = Date.now();
				const result = runWrapper(fixtureRoot, ["app", "."], {
					CODEX_MULTI_AUTH_REAL_CODEX_BIN: fakeBin,
					CODEX_HOME: originalHome,
					CODEX_MULTI_AUTH_DIR: multiAuthDir,
					CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
					CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS: "200",
					CODEX_MULTI_AUTH_APP_ROTATION_DETACHED_IDLE_MS: "150",
					OPENAI_API_KEY: undefined,
				});
				const elapsedMs = Date.now() - startedAt;

				expect(result.status).toBe(0);
				await sleep(600);
				const after = countHelperMetadata(multiAuthDir);
				// Everything stale is gone; only this launch's own helper may remain.
				expect(after.status).toBeLessThan(3);
				expect(after.owner).toBeLessThan(3);
				// The launch handshake has a 15s bound; a sweep that pushed past it
				// would fail the launch, not just be slow.
				expect(elapsedMs).toBeLessThan(60_000);
			});
		},
		240_000,
	);
});
