import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../lib/utils.js";
import { resolveRealCodexBin } from "../scripts/codex-bin-resolver.js";

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
		join(repoRootDir, "scripts", "codex-bin-resolver.js"),
		join(scriptDir, "codex-bin-resolver.js"),
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

	it("does not clobber original auth state that changed while the compatibility shadow was active", () => {
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
			'    \'    return;\',',
			'    \'  }\',',
			'    \'  if (Date.now() - startedAt > 5000) {\',',
			'    \'    process.exit(2);\',',
			'    \'    return;\',',
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

		expect(resolvedBin).toBe(fakeGlobalBin);
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

		expect(resolvedBin).toBe(fakeGlobalBin);
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

		expect(resolvedBin).toBe(fakeGlobalBin);
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

		expect(resolvedBin).toBe(fakeGlobalBin);
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

		expect(spawnCalls).toHaveLength(1);
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

		expect(resolvedBin).toBe(fakeGlobalBin);
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
