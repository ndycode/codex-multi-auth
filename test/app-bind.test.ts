import { createServer } from "node:http";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bindCodexAppRuntimeRotation,
	formatAppBindStatus,
	getAppBindStatus,
	parsePosixProcessStartTime,
	resolveAppBindPaths,
	restoreConfigTomlFromAppBind,
	rewriteConfigTomlForAppBind,
	stopDetachedProcess,
	stopRuntimeRotationAppHelperProcess,
	stopRuntimeRotationRouterProcess,
	UNBIND_HELPER_CONCURRENCY,
	unbindCodexAppRuntimeRotation,
} from "../lib/runtime/app-bind.js";
import { tomlStringLiteral } from "../lib/runtime/config-toml.js";
import { withFileOperationRetry } from "../lib/fs-retry.js";
import {
	withDeadPid,
	withDeadPids,
	withLivePid,
	withLivePids,
} from "./helpers/owned-pids.js";
import {
	APP_RUNTIME_HELPER_OWNER_FILE,
	APP_RUNTIME_HELPER_STATUS_FILE,
	RUNTIME_ROTATION_PROXY_PROVIDER_ID,
} from "../lib/runtime-constants.js";

const tempRoots: string[] = [];
const thisDir = dirname(fileURLToPath(import.meta.url));

async function createTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** A loopback port that nothing listens on (bound, then released). */
async function unusedPort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
	const port = (probe.address() as import("node:net").AddressInfo).port;
	await new Promise<void>((r) => probe.close(() => r()));
	return port;
}

async function seedExistingAppBindState(params: {
	platform: NodeJS.Platform;
	home: string;
	env: NodeJS.ProcessEnv;
	port: number;
	baseUrl: string;
	nodePath: string;
	routerScriptPath: string;
}): Promise<void> {
	const paths = resolveAppBindPaths(params);
	await mkdir(paths.bindDir, { recursive: true });
	await writeFile(
		paths.statePath,
		`${JSON.stringify(
			{
				version: 1,
				platform: params.platform,
				host: "127.0.0.1",
				port: params.port,
				baseUrl: params.baseUrl,
				configPath: paths.configPath,
				statePath: paths.statePath,
				backupPath: paths.backupPath,
				statusPath: paths.statusPath,
				logPath: paths.logPath,
				nodePath: params.nodePath,
				routerScriptPath: params.routerScriptPath,
				clientApiKey: "existing-secret",
				startupPath: paths.startupPath,
				launchAgentPath: paths.launchAgentPath,
				boundConfigHash: "existing-hash",
				updatedAt: 1,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

function resolveRuntimeHelperStatusPath(options: {
	home: string;
	env: NodeJS.ProcessEnv;
}): string {
	const paths = resolveAppBindPaths({
		platform: process.platform,
		home: options.home,
		env: options.env,
	});
	return join(dirname(paths.bindDir), APP_RUNTIME_HELPER_STATUS_FILE);
}

function resolveRuntimeHelperOwnerPath(options: {
	home: string;
	env: NodeJS.ProcessEnv;
}, pid: number): string {
	const paths = resolveAppBindPaths({
		platform: process.platform,
		home: options.home,
		env: options.env,
	});
	return join(
		dirname(paths.bindDir),
		APP_RUNTIME_HELPER_OWNER_FILE.replace(/\.json$/i, `.${pid}.json`),
	);
}

async function writeRuntimeHelperStatus(
	options: { home: string; env: NodeJS.ProcessEnv },
	status: Record<string, unknown> | string,
): Promise<string> {
	const statusPath = resolveRuntimeHelperStatusPath(options);
	await mkdir(dirname(statusPath), { recursive: true });
	await writeFile(
		statusPath,
		typeof status === "string" ? status : `${JSON.stringify(status)}\n`,
		"utf8",
	);
	return statusPath;
}

async function writeRuntimeHelperOwner(
	options: { home: string; env: NodeJS.ProcessEnv },
	pid: number,
	identityToken: string,
): Promise<string> {
	const ownerPath = resolveRuntimeHelperOwnerPath(options, pid);
	await mkdir(dirname(ownerPath), { recursive: true });
	await writeFile(
		ownerPath,
		`${JSON.stringify({
			version: 1,
			kind: "codex-app-runtime-rotation-helper-owner",
			identityToken,
		})}\n`,
		"utf8",
	);
	return ownerPath;
}

async function spawnHelperFixture(
	root: string,
	name: string,
): Promise<{
	child: ReturnType<typeof spawn>;
	pid: number;
	scriptPath: string;
}> {
	const scriptPath = join(root, `${name}.mjs`);
	await writeFile(
		scriptPath,
		[
			"process.on('SIGTERM', () => process.exit(0));",
			"setInterval(() => undefined, 1000);",
			"",
		].join("\n"),
		"utf8",
	);
	const child = spawn(process.execPath, [scriptPath, "--codex-multi-auth-runtime-app-helper"], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	const pid = child.pid;
	if (!pid) throw new Error(`${name} fixture did not spawn`);
	await new Promise((resolve) => setTimeout(resolve, 50));
	return { child, pid, scriptPath };
}

async function stopHelperFixture(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) =>
		child.once("exit", () => resolve()),
	);
	try {
		child.kill("SIGTERM");
	} catch {
		// The fixture may have exited between the state check and the signal.
	}
	await exited;
}

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0).map((root) =>
			withFileOperationRetry(() => rm(root, { recursive: true, force: true })),
		),
	);
});

it("prints the resolved app-bind config path in reasoning guidance", () => {
	const configPath = "C:\\Users\\neil\\DevTools\\config\\codex\\config.toml";
	const message = formatAppBindStatus({
		bound: true,
		running: true,
		state: {
			version: 1,
			platform: "win32",
			host: "127.0.0.1",
			port: 4567,
			baseUrl: "http://127.0.0.1:4567",
			configPath,
			statePath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\state.json",
			backupPath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\backup.json",
			statusPath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\status.json",
			logPath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\router.log",
			nodePath: process.execPath,
			routerScriptPath: "C:\\repo\\scripts\\codex-app-router.js",
			clientApiKey: "redacted",
			startupPath: null,
			launchAgentPath: null,
			boundConfigHash: "hash",
			updatedAt: 1,
		},
		router: null,
		paths: {
			codexHome: "C:\\Users\\neil\\DevTools\\config\\codex",
			configPath,
			bindDir: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind",
			statePath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\state.json",
			backupPath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\backup.json",
			statusPath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\status.json",
			logPath: "C:\\Users\\neil\\DevTools\\config\\codex\\multi-auth\\app-bind\\router.log",
			routerScriptPath: "C:\\repo\\scripts\\codex-app-router.js",
			startupPath: null,
			launchAgentPath: null,
		},
	});

	expect(message).toContain(configPath);
	expect(message).not.toContain("~/.codex/config.toml");
});

describe("Codex app runtime rotation bind", () => {
	it("parses representative POSIX ps lstart output deterministically", () => {
		const expected = new Date(2026, 7, 8, 14, 32, 10).getTime();

		expect(
			parsePosixProcessStartTime("Sat Aug  8 14:32:10 2026"),
		).toBe(expected);
		expect(parsePosixProcessStartTime("Sun Jan 1 00:00:00 2023")).toBe(
			new Date(2023, 0, 1).getTime(),
		);
		expect(parsePosixProcessStartTime("not a process start time")).toBeNull();
		expect(parsePosixProcessStartTime("Sat Foo 8 14:32:10 2026")).toBeNull();
		expect(parsePosixProcessStartTime("Sat Feb 29 14:32:10 2025")).toBeNull();
		expect(parsePosixProcessStartTime("Sat Aug 8 24:00:00 2026")).toBeNull();
	});

	it("rewrites and restores Codex config TOML without disturbing other sections", () => {
		const original = [
			'model_provider = "openai"',
			'model = "gpt-5.4"',
			"disable_response_storage = true",
			"",
			"[profiles.default]",
			'model = "gpt-5.4"',
			"disable_response_storage = true",
			"",
		].join("\n");

		const bound = rewriteConfigTomlForAppBind(
			original,
			"http://127.0.0.1:32123",
			"app-secret",
		);
		expect(bound).toContain(
			`model_provider = "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		expect(bound).toContain(
			`[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}]`,
		);
		expect(bound).toContain('name = "codex-multi-auth"');
		expect(bound).toContain('base_url = "http://127.0.0.1:32123"');
		expect(bound).toContain("requires_openai_auth = false");
		expect(bound).toContain('experimental_bearer_token = "app-secret"');
		expect(bound).toContain('wire_api = "responses"');
		expect(bound).toContain("disable_response_storage = false");
		expect(bound).toContain("[profiles.default]\nmodel = \"gpt-5.4\"\ndisable_response_storage = true");
		expect(bound).not.toContain("env_key");
		expect(bound).toContain("[profiles.default]");

		const restored = restoreConfigTomlFromAppBind(bound, original);
		expect(restored).toBe(original);
	});

	it("keeps model_provider top-level before TOML array tables", () => {
		const original = [
			"[[profiles.experimental]]",
			'model = "gpt-5.4"',
			"",
		].join("\n");

		const bound = rewriteConfigTomlForAppBind(
			original,
			"http://127.0.0.1:32123",
			"app-secret",
		);

		expect(
			bound.startsWith(
				`model_provider = "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
			),
		).toBe(true);
		expect(
			bound.indexOf(`model_provider = "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`),
		).toBeLessThan(bound.indexOf("[[profiles.experimental]]"));
	});

	it("removes runtime provider subtables when restoring Codex config TOML", () => {
		const bound = [
			`model_provider = "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
			"",
			`[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}]`,
			'name = "codex-multi-auth"',
			'base_url = "http://127.0.0.1:32123"',
			`[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}.http_headers]`,
			'authorization = "Bearer secret"',
			"[profiles.default]",
			'model = "gpt-5.4"',
			"",
		].join("\n");

		const restored = restoreConfigTomlFromAppBind(bound, 'model_provider = "openai"\n');

		expect(restored).not.toContain(RUNTIME_ROTATION_PROXY_PROVIDER_ID);
		expect(restored).not.toContain("Bearer secret");
		expect(restored).toContain("[profiles.default]");
	});

	it("escapes TOML basic-string control characters", () => {
		expect(
			tomlStringLiteral(
				"line\ncarriage\rtab\tbackspace\bform\fquote\"slash\\nul\u0000unit\u001fdel\u007f",
			),
		).toBe(
			'"line\\ncarriage\\rtab\\tbackspace\\bform\\fquote\\"slash\\\\nul\\u0000unit\\u001Fdel\\u007F"',
		);
	});

	it("resolves app bind paths from the provided environment", async () => {
		const root = await createTempRoot("codex-app-bind-paths-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "official-codex-home");
		const appData = join(root, "AppData", "Roaming");

		const paths = resolveAppBindPaths({
			platform: "win32",
			home: root,
			env: {
				CODEX_MULTI_AUTH_DIR: multiAuthDir,
				CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
				APPDATA: appData,
			},
		});

		expect(paths.configPath).toBe(join(codexHome, "config.toml"));
		expect(paths.bindDir).toBe(join(multiAuthDir, "app-bind"));
		expect(paths.startupPath).toBe(
			join(
				appData,
				"Microsoft",
				"Windows",
				"Start Menu",
				"Programs",
				"Startup",
				"Codex Multi Auth Runtime Router.cmd",
			),
		);
		expect(paths.launchAgentPath).toBeNull();
	});

	it("binds and unbinds the Windows app config without spawning during tests", async () => {
		const root = await createTempRoot("codex-app-bind-win-");
		const multiAuthDir = join(root, "multi%auth");
		const codexHome = join(root, "codex%home");
		const appData = join(root, "App%20Data", "Roaming");
		const nodePath = join(root, "Node%20", "node.exe");
		const routerScriptPath = join(root, "router%dir", "codex-app-router.js");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
			APPDATA: appData,
		};
		await mkdir(codexHome, { recursive: true });
		await writeFile(
			join(codexHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		await seedExistingAppBindState({
			platform: "win32",
			home: root,
			env,
			port: 4567,
			baseUrl: "http://127.0.0.1:4567",
			nodePath,
			routerScriptPath,
		});

		const result = await bindCodexAppRuntimeRotation({
			platform: "win32",
			home: root,
			env,
			nodePath,
			routerScriptPath,
			spawnDetached: false,
			now: () => 123,
		});

		expect(result.status.bound).toBe(true);
		expect(result.status.running).toBe(false);
		expect(result.status.state?.statePath).toBe(
			join(multiAuthDir, "app-bind", "runtime-rotation-app-bind.json"),
		);
		expect(result.status.state?.identityToken).toMatch(/^[0-9a-f]{48}$/);
		const config = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(config).toContain(
			`[model_providers.${RUNTIME_ROTATION_PROXY_PROVIDER_ID}]`,
		);
		expect(config).toContain(result.status.state?.baseUrl);
		expect(config).toContain("requires_openai_auth = false");
		expect(config).toContain(
			`experimental_bearer_token = "${result.status.state?.clientApiKey}"`,
		);
		expect(config).not.toContain("env_key");
		if (process.platform !== "win32") {
			expect(statSync(join(codexHome, "config.toml")).mode & 0o777).toBe(0o600);
			expect(statSync(result.status.paths.statePath).mode & 0o777).toBe(0o600);
		}
		const startup = await readFile(result.status.paths.startupPath ?? "", "utf8");
		expect(startup).toContain("--state");
		expect(startup).toContain("--identity-token");
		expect(startup).toContain(result.status.state?.identityToken ?? "");
		expect(startup).toContain("--log");
		expect(startup).toContain("--max-log-bytes 1048576");
		expect(startup).toContain("runtime-rotation-app-bind.json");
		expect(startup).toContain("Node%%20");
		expect(startup).toContain("router%%dir");
		expect(startup).toContain("multi%%auth");
		expect(startup).not.toContain("Node%20");
		expect(startup).not.toContain("router%dir");
		expect(startup).not.toContain("multi%auth");
		expect(startup).not.toContain(result.status.state?.clientApiKey ?? "");

		const unbound = await unbindCodexAppRuntimeRotation({
			platform: "win32",
			home: root,
			env,
			spawnDetached: false,
		});

		expect(unbound.status.bound).toBe(false);
		expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
			'model_provider = "openai"\n',
		);
		expect(existsSync(result.status.paths.startupPath ?? "")).toBe(false);
		expect(existsSync(result.status.paths.bindDir)).toBe(false);
	});

	it("stops a detached POSIX helper with SIGKILL escalation", async () => {
		let alive = true;
		const signals: NodeJS.Signals[] = [];
		const result = await stopRuntimeRotationAppHelperProcess(
			{
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid: 4242,
				startedAt: Date.now(),
			},
			{
				platform: "linux",
				gracefulTimeoutMs: 0,
				isAlive: () => alive,
				verifyProcessIdentity: async () => true,
				kill: (_pid, signal) => {
					signals.push(signal);
					if (signal === "SIGKILL") alive = false;
				},
			},
		);

		expect(result).toBe(true);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("uses Windows tree termination directly without sending SIGTERM", async () => {
		let alive = true;
		const kill = vi.fn();
		const taskkill = vi.fn(async () => {
			alive = false;
		});

		await expect(
			stopRuntimeRotationAppHelperProcess(
				{
					kind: "codex-app-runtime-rotation-helper",
					state: "running",
					pid: 4343,
					startedAt: Date.now(),
				},
				{
					platform: "win32",
					gracefulTimeoutMs: 0,
					isAlive: () => alive,
					verifyProcessIdentity: async () => true,
					kill,
					runWindowsTaskkill: taskkill,
				},
			),
		).resolves.toBe(true);

		expect(kill).not.toHaveBeenCalled();
		expect(taskkill).toHaveBeenCalledWith(4343);
	});

	it("uses Windows tree termination even when the target would exit immediately", async () => {
		let alive = true;
		const kill = vi.fn(() => {
			alive = false;
		});
		const taskkill = vi.fn(async () => {
			alive = false;
		});

		await expect(
			stopRuntimeRotationAppHelperProcess(
				{
					kind: "codex-app-runtime-rotation-helper",
					state: "running",
					pid: 4646,
					startedAt: Date.now(),
				},
				{
					platform: "win32",
					gracefulTimeoutMs: 0,
					isAlive: () => alive,
					verifyProcessIdentity: async () => true,
					kill,
					runWindowsTaskkill: taskkill,
				},
			),
		).resolves.toBe(true);

		expect(kill).not.toHaveBeenCalled();
		expect(taskkill).toHaveBeenCalledWith(4646);
	});

	it("does not signal malformed or stale helper status", async () => {
		const kill = vi.fn();
		const options = {
			platform: "linux" as const,
			isAlive: () => true,
			kill,
			gracefulTimeoutMs: 0,
		};

		expect(
			await stopRuntimeRotationAppHelperProcess(
				{
					kind: "other-process",
					state: "running",
					pid: 4444,
					startedAt: Date.now(),
				},
				options,
			),
		).toBe(false);
		expect(
			await stopRuntimeRotationAppHelperProcess(
				{
					kind: "codex-app-runtime-rotation-helper",
					state: "stopped",
					pid: 4444,
					startedAt: Date.now(),
				},
				options,
			),
		).toBe(false);
		expect(
			await stopRuntimeRotationAppHelperProcess(
				{
					kind: "codex-app-runtime-rotation-helper",
					state: "running",
					pid: null,
					startedAt: Date.now(),
				},
				options,
			),
		).toBe(false);
		expect(kill).not.toHaveBeenCalled();
	});

	it("does not signal a live PID when process identity does not match", async () => {
		const kill = vi.fn();
		const verifyProcessIdentity = vi.fn(async () => false);

		const result = await stopRuntimeRotationAppHelperProcess(
			{
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid: 4545,
				startedAt: Date.now() - 1_000,
			},
			{
				platform: "linux",
				isAlive: () => true,
				kill,
				verifyProcessIdentity,
			},
		);

		expect(result).toBe(false);
		expect(verifyProcessIdentity).toHaveBeenCalledWith(
			4545,
			expect.any(Number),
			"linux",
		);
		expect(kill).not.toHaveBeenCalled();
	});

	it("treats ESRCH after a signal race as an already-stopped helper", async () => {
		let alive = true;
		const error = Object.assign(new Error("process exited"), { code: "ESRCH" });
		const kill = vi.fn(() => {
			alive = false;
			throw error;
		});

		await expect(
			stopDetachedProcess(4748, "linux", {
				isAlive: () => alive,
				kill,
				verifyProcessIdentity: undefined,
			}),
		).resolves.toBe(true);
		expect(kill).toHaveBeenCalledWith(4748, "SIGTERM");
	});

	it("does not signal a stale router PID when process identity does not match", async () => {
		const kill = vi.fn();
		const verifyProcessIdentity = vi.fn(async () => false);
		const startedAt = Date.now() - 1_000;

		const result = await stopRuntimeRotationRouterProcess(
			{
				state: "running",
				pid: 4646,
				startedAt,
				updatedAt: startedAt,
			},
			"linux",
			"/tmp/codex-app-router.js",
			{
				isAlive: () => true,
				kill,
				verifyProcessIdentity,
			},
		);

		expect(result).toBe(false);
		expect(verifyProcessIdentity).toHaveBeenCalledWith(
			4646,
			expect.any(Number),
			"linux",
		);
		expect(kill).not.toHaveBeenCalled();
	});

	it("passes the bind ownership token to the router identity verifier", async () => {
		let alive = true;
		const kill = vi.fn(() => {
			alive = false;
		});
		const verifyProcessIdentity = vi.fn(async () => true);

		await expect(
			stopRuntimeRotationRouterProcess(
				{
					state: "running",
					pid: 4749,
					startedAt: Date.now(),
					updatedAt: Date.now(),
					identityToken: "status-token",
				},
				"linux",
				"/tmp/codex-app-router.js",
				{
					identityToken: "bind-token",
					isAlive: () => alive,
					kill,
					verifyProcessIdentity,
				},
			),
		).resolves.toBe(true);

		expect(verifyProcessIdentity).toHaveBeenCalledWith(
			4749,
			expect.any(Number),
			"linux",
			"bind-token",
		);
		expect(kill).toHaveBeenCalledWith(4749, "SIGTERM");
	});

	it("does not stop a replacement router with a different bind token", async () => {
		const kill = vi.fn();
		const verifyProcessIdentity = vi.fn(
			async (
				_pid: number,
				_startedAt: number,
				_platform: NodeJS.Platform,
				identityToken?: string,
			) => identityToken === "replacement-token",
		);

		const result = await stopRuntimeRotationRouterProcess(
			{
				state: "running",
				pid: 4750,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				identityToken: "replacement-token",
			},
			"linux",
			"/tmp/codex-app-router.js",
			{
				identityToken: "original-token",
				isAlive: () => true,
				kill,
				verifyProcessIdentity,
			},
		);

		expect(result).toBe(false);
		expect(verifyProcessIdentity).toHaveBeenCalledWith(
			4750,
			expect.any(Number),
			"linux",
			"original-token",
		);
		expect(kill).not.toHaveBeenCalled();
	});

	it("stops a legacy router status after verifying its last observed time", async () => {
		let alive = true;
		const kill = vi.fn((_pid: number, signal: NodeJS.Signals) => {
			if (signal === "SIGTERM") alive = false;
		});
		const updatedAt = Date.now() - 1_000;
		const verifyProcessIdentity = vi.fn(async () => true);

		const result = await stopRuntimeRotationRouterProcess(
			{
				state: "running",
				pid: 4747,
				startedAt: null,
				updatedAt,
			},
			"linux",
			"/tmp/codex-app-router.js",
			{
				isAlive: () => alive,
				kill,
				verifyProcessIdentity,
			},
		);

		expect(result).toBe(true);
		expect(verifyProcessIdentity).toHaveBeenCalledWith(4747, updatedAt, "linux");
		expect(kill).toHaveBeenCalledWith(4747, "SIGTERM");
	});

	it("validates legacy router timestamps and command identity before stopping", async () => {
		const root = await createTempRoot("codex-app-bind-legacy-router-");
		const routerScriptPath = join(root, "legacy-router.mjs");
		await writeFile(
			routerScriptPath,
			[
				"process.on('SIGTERM', () => process.exit(0));",
				"setInterval(() => undefined, 1000);",
				"",
			].join("\n"),
			"utf8",
		);
		const child = spawn(process.execPath, [routerScriptPath], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
		const pid = child.pid;
		if (!pid) throw new Error("legacy router fixture did not spawn");
		await new Promise((resolve) => setTimeout(resolve, 250));
		const verifyProcessIdentity = vi.fn(
			async (_pid: number, observedAt: number, platform: NodeJS.Platform) =>
				platform === process.platform &&
				observedAt >= Date.now() - 5_000 &&
				observedAt <= Date.now() + 5_000,
		);

		try {
			await expect(
				stopRuntimeRotationRouterProcess(
					{
						state: "running",
						pid,
						startedAt: null,
						updatedAt: Date.now() + 60_000,
						routerScriptPath,
					},
					process.platform,
					routerScriptPath,
					{ verifyProcessIdentity },
				),
			).resolves.toBe(false);
			await expect(
				stopRuntimeRotationRouterProcess(
					{
						state: "running",
						pid,
						startedAt: null,
						updatedAt: Date.now(),
						routerScriptPath,
					},
					process.platform,
					join(root, "different-router.mjs"),
					{ verifyProcessIdentity },
				),
			).resolves.toBe(false);
			await expect(
				stopRuntimeRotationRouterProcess(
					{
						state: "running",
						pid,
						startedAt: null,
						updatedAt: Date.now() - 60_000,
						routerScriptPath,
					},
					process.platform,
					routerScriptPath,
					{ verifyProcessIdentity },
				),
			).resolves.toBe(false);
			await expect(
				stopRuntimeRotationRouterProcess(
					{
						state: "running",
						pid,
						startedAt: null,
						updatedAt: Date.now(),
						routerScriptPath,
					},
					process.platform,
					routerScriptPath,
					{ pollIntervalMs: 50, verifyProcessIdentity },
				),
			).resolves.toBe(true);
		} finally {
			try {
				child.kill("SIGKILL");
			} catch {
				// The final valid stop may have already exited the fixture.
			}
		}
	});

	it("unbinds an owned running helper and removes its status after stopping", async () => {
		const root = await createTempRoot("codex-app-bind-owned-helper-");
		const multiAuthDir = join(root, "multi-auth");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const helperScriptPath = join(root, "runtime-helper.mjs");
		await writeFile(
			helperScriptPath,
			[
				"process.on('SIGTERM', () => process.exit(0));",
				"setInterval(() => undefined, 1000);",
				"",
			].join("\n"),
			"utf8",
		);
		const child = spawn(
			process.execPath,
			[helperScriptPath, "--codex-multi-auth-runtime-app-helper"],
			{ detached: true, stdio: "ignore", windowsHide: true },
		);
		child.unref();
		const pid = child.pid;
		if (!pid) throw new Error("owned helper fixture did not spawn");
		await new Promise((resolve) => setTimeout(resolve, 250));
		const helperStartedAt = Date.now();
		const helperIdentityToken = "owned-helper-token";
		const statusPath = await writeRuntimeHelperStatus(
			{ home: root, env },
			{
				version: 1,
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid,
				startedAt: helperStartedAt,
				scriptPath: helperScriptPath,
				identityToken: helperIdentityToken,
			},
		);
		await writeRuntimeHelperOwner(
			{ home: root, env },
			pid,
			helperIdentityToken,
		);

		try {
			const exited = new Promise<void>((resolve) =>
				child.once("exit", () => resolve()),
			);
			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
				verifyProcessIdentity: async (candidatePid, startedAt, platform) =>
					candidatePid === pid &&
					platform === process.platform &&
					Math.abs(startedAt - helperStartedAt) <= 5_000,
			});
			await exited;
			expect(existsSync(statusPath)).toBe(false);
		} finally {
			try {
				process.kill(pid, 0);
				if (process.platform === "win32") {
					spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
						stdio: "ignore",
						windowsHide: true,
					});
				} else {
					child.kill("SIGKILL");
				}
			} catch {
				// The unbind path already stopped the fixture.
			}
		}
	});

	it("stops a legacy token-less helper after identity verification", async () => {
		const root = await createTempRoot("codex-app-bind-legacy-helper-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const fixture = await spawnHelperFixture(root, "legacy-helper");
		const startedAt = Date.now();
		const statusPath = await writeRuntimeHelperStatus(
			{ home: root, env },
			{
				version: 1,
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid: fixture.pid,
				startedAt,
				scriptPath: fixture.scriptPath,
			},
		);
		const verifyProcessIdentity = vi.fn(async () => true);

		try {
			const exited = new Promise<void>((resolve) =>
				fixture.child.once("exit", () => resolve()),
			);
			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
				verifyProcessIdentity,
			});
			await exited;

			expect(verifyProcessIdentity).toHaveBeenCalledWith(
				fixture.pid,
				expect.any(Number),
				process.platform,
			);
			expect(existsSync(statusPath)).toBe(false);
		} finally {
			await stopHelperFixture(fixture.child);
		}
	});

	it("does not stop a replacement helper with a different owner token", async () => {
		const root = await createTempRoot("codex-app-bind-helper-replacement-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const fixture = await spawnHelperFixture(root, "replacement-helper");
		const statusPath = await writeRuntimeHelperStatus(
			{ home: root, env },
			{
				version: 1,
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid: fixture.pid,
				startedAt: Date.now(),
				scriptPath: fixture.scriptPath,
				identityToken: "replacement-token",
			},
		);
		await writeRuntimeHelperOwner(
			{ home: root, env },
			fixture.pid,
			"original-token",
		);
		const verifyProcessIdentity = vi.fn(async () => true);

		try {
			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
				verifyProcessIdentity,
			});

			expect(verifyProcessIdentity).not.toHaveBeenCalled();
			expect(existsSync(statusPath)).toBe(true);
		} finally {
			await stopHelperFixture(fixture.child);
		}
	});

	it.each([
		[
			"foreign status",
			{
				version: 1,
				kind: "different-runtime-helper",
				state: "running",
				pid: 2_147_483_647,
				startedAt: Date.now(),
			},
		],
		["malformed status", "{not valid json"],
	] as const)("preserves %s during unbind", async (_label, status) => {
		const root = await createTempRoot("codex-app-bind-helper-status-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const statusPath = await writeRuntimeHelperStatus({ home: root, env }, status);
		const before = await readFile(statusPath, "utf8");

		await unbindCodexAppRuntimeRotation({
			platform: process.platform,
			home: root,
			env,
		});

		expect(existsSync(statusPath)).toBe(true);
		expect(await readFile(statusPath, "utf8")).toBe(before);
	});

	it("preserves an owned helper status when identity verification or stopping fails", async () => {
		const root = await createTempRoot("codex-app-bind-helper-stop-failure-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const fixture = await spawnHelperFixture(root, "stop-failure-helper");
		const statusPath = await writeRuntimeHelperStatus(
			{ home: root, env },
			{
				version: 1,
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid: fixture.pid,
				startedAt: Date.now(),
				scriptPath: join(root, "not-the-test-runner.mjs"),
			},
		);
		const before = await readFile(statusPath, "utf8");

		try {
			const verifyProcessIdentity = vi.fn(async () => false);
			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
				verifyProcessIdentity,
			});

			expect(verifyProcessIdentity).toHaveBeenCalledWith(
				fixture.pid,
				expect.any(Number),
				process.platform,
			);
			expect(existsSync(statusPath)).toBe(true);
			expect(await readFile(statusPath, "utf8")).toBe(before);
		} finally {
			await stopHelperFixture(fixture.child);
		}
	});

	it("removes an owned helper status whose persisted PID has already exited", async () => {
		const root = await createTempRoot("codex-app-bind-helper-esrch-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		// A PID this test started and killed, rather than an integer above the
		// platform's PID ceiling. Out-of-range PIDs classify as dead only because
		// every liveness check here treats every errno but EPERM as dead — true
		// today, but a property the fixture never stated and does not control
		// (#668). "Has already exited" should be a fact.
		await withDeadPid(async (deadPid) => {
			const statusPath = await writeRuntimeHelperStatus(
				{ home: root, env },
				{
					version: 1,
					kind: "codex-app-runtime-rotation-helper",
					state: "running",
					pid: deadPid,
					startedAt: Date.now(),
					scriptPath: join(root, "runtime-helper.mjs"),
				},
			);

			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
			});

			expect(existsSync(statusPath)).toBe(false);
		});
	});

	it("removes dead helpers recorded in per-PID status files on unbind", async () => {
		// Helpers publish `runtime-rotation-app-helper.<pid>.json`; unbind must
		// walk those, not just the legacy shared path — a regression here means
		// `uninstall` silently stops nothing while reporting success.
		const root = await createTempRoot("codex-app-bind-helper-per-pid-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const legacyPath = resolveRuntimeHelperStatusPath({ home: root, env });
		await withDeadPid(async (deadPid) => {
			const perPidPath = legacyPath.replace(/\.json$/i, `.${deadPid}.json`);
			await mkdir(dirname(perPidPath), { recursive: true });
			await writeFile(
				perPidPath,
				`${JSON.stringify({
					version: 1,
					kind: "codex-app-runtime-rotation-helper",
					state: "running",
					pid: deadPid,
					startedAt: Date.now(),
					scriptPath: join(root, "runtime-helper.mjs"),
				})}\n`,
				"utf8",
			);

			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
			});

			expect(existsSync(perPidPath)).toBe(false);
		});
	});

	it("removes every dead helper record — per-PID and legacy — in one unbind", async () => {
		// A loop bug that processes only the first candidate would still pass the
		// single-file test above; this is the actual multi-helper regression.
		const root = await createTempRoot("codex-app-bind-helper-multi-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const legacyPath = resolveRuntimeHelperStatusPath({ home: root, env });
		await mkdir(dirname(legacyPath), { recursive: true });
		const record = (pid: number) =>
			`${JSON.stringify({
				version: 1,
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid,
				startedAt: Date.now(),
				scriptPath: join(root, "runtime-helper.mjs"),
			})}\n`;
		await withDeadPids(
			3,
			async ([firstDeadPid, secondDeadPid, legacyDeadPid]) => {
				const deadPids = [firstDeadPid ?? 0, secondDeadPid ?? 0];
				const perPidPaths = deadPids.map((pid) =>
					legacyPath.replace(/\.json$/i, `.${pid}.json`),
				);
				for (const [index, path] of perPidPaths.entries()) {
					await writeFile(path, record(deadPids[index] ?? 0), "utf8");
				}
				await writeFile(legacyPath, record(legacyDeadPid ?? 0), "utf8");
				// An owner file beside a dead per-PID record goes with it — and its
				// identity token deliberately disagrees with the status record's,
				// because a dead PID means neither file describes anything that can
				// still be running (#666). Gating this removal on token agreement is
				// what stranded owner files forever.
				const ownerPath = resolveRuntimeHelperOwnerPath(
					{ home: root, env },
					deadPids[0] ?? 0,
				);
				await writeFile(
					ownerPath,
					`${JSON.stringify({
						version: 1,
						kind: "codex-app-runtime-rotation-helper-owner",
						identityToken: "does-not-matter-for-dead-pid",
						launcherPid: 1,
						createdAt: Date.now(),
					})}\n`,
					"utf8",
				);

				await unbindCodexAppRuntimeRotation({
					platform: process.platform,
					home: root,
					env,
				});

				for (const path of [...perPidPaths, legacyPath]) {
					expect(existsSync(path)).toBe(false);
				}
				expect(existsSync(ownerPath)).toBe(false);
			},
		);
	});

	it("processes every helper record without exceeding the unbind concurrency bound", async () => {
		// The pool exists so unbind costs roughly one stop window instead of N of
		// them — on the machine from #663 there were 183 records — while not
		// signalling every stale helper at once. Every other fixture here has a
		// handful of records, so any width (1, 8, Infinity) behaves identically
		// and the bound ships unobserved.
		//
		// Live PIDs with agreeing owner tokens, because only that combination
		// reaches the stop path — and `verifyProcessIdentity` is the one seam on
		// it, so it is where the pool's real width is visible. Returning false
		// means nothing is ever signalled: these are the test's own children.
		const root = await createTempRoot("codex-app-bind-helper-pool-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const legacyPath = resolveRuntimeHelperStatusPath({ home: root, env });
		await mkdir(dirname(legacyPath), { recursive: true });
		const recordCount = UNBIND_HELPER_CONCURRENCY * 2;
		await withLivePids(recordCount, async (livePids) => {
			for (const pid of livePids) {
				await writeFile(
					legacyPath.replace(/\.json$/i, `.${pid}.json`),
					`${JSON.stringify({
						version: 1,
						kind: "codex-app-runtime-rotation-helper",
						state: "running",
						pid,
						startedAt: Date.now(),
						scriptPath: join(root, "runtime-helper.mjs"),
						identityToken: `token-${pid}`,
					})}\n`,
					"utf8",
				);
				await writeFile(
					resolveRuntimeHelperOwnerPath({ home: root, env }, pid),
					`${JSON.stringify({
						version: 1,
						kind: "codex-app-runtime-rotation-helper-owner",
						identityToken: `token-${pid}`,
						launcherPid: 1,
						createdAt: Date.now(),
					})}\n`,
					"utf8",
				);
			}

			let inFlight = 0;
			let peakInFlight = 0;
			let verified = 0;
			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
				verifyProcessIdentity: async () => {
					inFlight += 1;
					verified += 1;
					peakInFlight = Math.max(peakInFlight, inFlight);
					await new Promise((resolve) => setTimeout(resolve, 10));
					inFlight -= 1;
					return false;
				},
			});

			// Every record reached the stop path — a pool that dropped items after
			// the first batch would fail here, not on the bound.
			expect(verified).toBe(recordCount);
			// More than one at a time, so the work really is parallel...
			expect(peakInFlight).toBeGreaterThan(1);
			// ...and never more than the bound, so it is really bounded.
			expect(peakInFlight).toBeLessThanOrEqual(UNBIND_HELPER_CONCURRENCY);
		});
	});

	it("removes both files when a dead helper's status and owner tokens disagree", async () => {
		// #666: the dead-PID branch removed the status file but gated the owner
		// file on `helperOwnershipMatches`. A token mismatch therefore deleted the
		// status record and kept `runtime-rotation-app-helper-owner.<pid>.json` —
		// and because unbind then enumerated status paths only, nothing ever
		// rediscovered that owner file again.
		const root = await createTempRoot("codex-app-bind-helper-mismatch-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const legacyPath = resolveRuntimeHelperStatusPath({ home: root, env });
		await mkdir(dirname(legacyPath), { recursive: true });
		await withDeadPid(async (deadPid) => {
			const perPidPath = legacyPath.replace(/\.json$/i, `.${deadPid}.json`);
			await writeFile(
				perPidPath,
				`${JSON.stringify({
					version: 1,
					kind: "codex-app-runtime-rotation-helper",
					state: "running",
					pid: deadPid,
					startedAt: Date.now(),
					scriptPath: join(root, "runtime-helper.mjs"),
					identityToken: "token-from-the-status-file",
				})}\n`,
				"utf8",
			);
			const ownerPath = resolveRuntimeHelperOwnerPath(
				{ home: root, env },
				deadPid,
			);
			await writeFile(
				ownerPath,
				`${JSON.stringify({
					version: 1,
					kind: "codex-app-runtime-rotation-helper-owner",
					identityToken: "a-different-token-entirely",
					launcherPid: 1,
					createdAt: Date.now(),
				})}\n`,
				"utf8",
			);

			await unbindCodexAppRuntimeRotation({
				platform: process.platform,
				home: root,
				env,
			});

			expect(existsSync(perPidPath)).toBe(false);
			expect(existsSync(ownerPath)).toBe(false);
		});
	});

	it("reclaims an orphaned owner file that has no status record left", async () => {
		// #666: the accumulation this fixes. An owner file whose status file is
		// already gone was unreachable — every pass walked status paths only — so
		// on a machine that stopped launching helpers it stayed under the
		// multi-auth root forever. Enumerating owner files is what reclaims it.
		const root = await createTempRoot("codex-app-bind-helper-orphan-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const legacyPath = resolveRuntimeHelperStatusPath({ home: root, env });
		await mkdir(dirname(legacyPath), { recursive: true });
		await withDeadPid(async (deadPid) => {
			await withLivePid(async (livePid) => {
				const orphanOwnerPath = resolveRuntimeHelperOwnerPath(
					{ home: root, env },
					deadPid,
				);
				const ownerContent = (pid: number) =>
					`${JSON.stringify({
						version: 1,
						kind: "codex-app-runtime-rotation-helper-owner",
						identityToken: `token-${pid}`,
						launcherPid: 1,
						createdAt: Date.now(),
					})}\n`;
				await writeFile(orphanOwnerPath, ownerContent(deadPid), "utf8");
				// A live helper's owner file is not an orphan and must survive, even
				// though it too has no status record in this fixture.
				const liveOwnerPath = resolveRuntimeHelperOwnerPath(
					{ home: root, env },
					livePid,
				);
				await writeFile(liveOwnerPath, ownerContent(livePid), "utf8");

				await unbindCodexAppRuntimeRotation({
					platform: process.platform,
					home: root,
					env,
				});

				expect(existsSync(orphanOwnerPath)).toBe(false);
				expect(existsSync(liveOwnerPath)).toBe(true);
			});
		});
	});

	it("preserves a running per-PID helper whose ownership cannot be verified", async () => {
		// The ownership gate is what keeps unbind from signalling foreign PIDs; a
		// future change that drops it must fail here, not in production.
		const root = await createTempRoot("codex-app-bind-helper-foreign-");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: join(root, "codex-home"),
		};
		const legacyPath = resolveRuntimeHelperStatusPath({ home: root, env });
		await mkdir(dirname(legacyPath), { recursive: true });
		// A live PID (this test process) with an identityToken and no owner file:
		// ownership cannot be verified, so the record must survive with a warning.
		const perPidPath = legacyPath.replace(/\.json$/i, `.${process.pid}.json`);
		await writeFile(
			perPidPath,
			`${JSON.stringify({
				version: 1,
				kind: "codex-app-runtime-rotation-helper",
				state: "running",
				pid: process.pid,
				startedAt: Date.now(),
				scriptPath: join(root, "runtime-helper.mjs"),
				identityToken: "token-without-owner-file",
			})}\n`,
			"utf8",
		);
		const logs: string[] = [];

		await unbindCodexAppRuntimeRotation({
			platform: process.platform,
			home: root,
			env,
			log: (message) => {
				logs.push(message);
			},
		});

		expect(existsSync(perPidPath)).toBe(true);
		expect(
			logs.some((message) =>
				message.includes("ownership metadata does not match"),
			),
		).toBe(true);
	});

	it("fails fast when the router script cannot be resolved", async () => {
		const root = await createTempRoot("codex-app-bind-missing-router-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};

		await expect(
			bindCodexAppRuntimeRotation({
				platform: "linux",
				home: root,
				env,
				nodePath: "node",
				routerScriptCandidates: [
					join(root, "missing-router-a.js"),
					join(root, "missing-router-b.js"),
				],
				spawnDetached: false,
			}),
		).rejects.toThrow(/codex-app-router\.js not found/);
	});

	it("serializes concurrent binds so state and config stay coherent", async () => {
		const root = await createTempRoot("codex-app-bind-concurrent-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await mkdir(codexHome, { recursive: true });
		await writeFile(
			join(codexHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		await seedExistingAppBindState({
			platform: "linux",
			home: root,
			env,
			port: 4567,
			baseUrl: "http://127.0.0.1:4567",
			nodePath: "node",
			routerScriptPath: join(root, "codex-app-router.js"),
		});
		const options = {
			platform: "linux" as const,
			home: root,
			env,
			nodePath: "node",
			routerScriptPath: join(root, "codex-app-router.js"),
			spawnDetached: false,
		};

		const [first, second] = await Promise.all([
			bindCodexAppRuntimeRotation(options),
			bindCodexAppRuntimeRotation(options),
		]);

		expect(first.status.bound).toBe(true);
		expect(second.status.bound).toBe(true);
		const paths = resolveAppBindPaths(options);
		const config = await readFile(paths.configPath, "utf8");
		const state = JSON.parse(await readFile(paths.statePath, "utf8")) as {
			clientApiKey: string;
			boundConfigHash: string;
		};
		const backup = JSON.parse(await readFile(paths.backupPath, "utf8")) as {
			content: string;
		};
		expect(config).toContain(
			`model_provider = "${RUNTIME_ROTATION_PROXY_PROVIDER_ID}"`,
		);
		expect(config).toContain(
			`experimental_bearer_token = "${state.clientApiKey}"`,
		);
		expect(state.boundConfigHash).toBe(sha256(config));
		expect(backup.content).toBe('model_provider = "openai"\n');
	});

	it("refuses to bind without spawning when no router port is known", async () => {
		const root = await createTempRoot("codex-app-bind-no-port-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await mkdir(codexHome, { recursive: true });

		await expect(
			bindCodexAppRuntimeRotation({
				platform: "linux",
				home: root,
				env,
				nodePath: "node",
				routerScriptPath: join(root, "codex-app-router.js"),
				spawnDetached: false,
			}),
		).rejects.toThrow("port=0");
	});

	it("rejects corrupt app bind state without a client token", async () => {
		const root = await createTempRoot("codex-app-bind-missing-token-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		const paths = resolveAppBindPaths({ platform: "linux", home: root, env });
		await mkdir(paths.bindDir, { recursive: true });
		await writeFile(
			paths.statePath,
			`${JSON.stringify(
				{
					version: 1,
					platform: "linux",
					host: "127.0.0.1",
					port: 4567,
					baseUrl: "http://127.0.0.1:4567",
					configPath: paths.configPath,
					statePath: paths.statePath,
					backupPath: paths.backupPath,
					statusPath: paths.statusPath,
					logPath: paths.logPath,
					nodePath: "node",
					routerScriptPath: join(root, "codex-app-router.js"),
					boundConfigHash: "hash",
					updatedAt: 1,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		await expect(
			bindCodexAppRuntimeRotation({
				platform: "linux",
				home: root,
				env,
				nodePath: "node",
				routerScriptPath: join(root, "codex-app-router.js"),
				spawnDetached: false,
			}),
		).rejects.toThrow("port=0");
	});

	it("resolves the router assigned port before writing app config", async () => {
		const root = await createTempRoot("codex-app-bind-router-port-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const routerScriptPath = join(root, "fake-router.mjs");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await writeFile(
			routerScriptPath,
			[
				"#!/usr/bin/env node",
				"import { mkdirSync, writeFileSync } from 'node:fs';",
				"import { dirname } from 'node:path';",
				"const args = process.argv.slice(2);",
				"const statusPath = args[args.indexOf('--status') + 1];",
				"mkdirSync(dirname(statusPath), { recursive: true });",
				"writeFileSync(statusPath, JSON.stringify({ version: 1, state: 'running', pid: process.pid, startedAt: Date.now(), baseUrl: 'http://127.0.0.1:54321', updatedAt: Date.now() }) + '\\n', 'utf8');",
				"process.on('SIGTERM', () => process.exit(0));",
				"setInterval(() => undefined, 1000);",
				"",
			].join("\n"),
			"utf8",
		);

		const result = await bindCodexAppRuntimeRotation({
			platform: "linux",
			home: root,
			env,
			nodePath: process.execPath,
			routerScriptPath,
			now: () => 789,
		});

		expect(result.status.state?.port).toBe(54321);
		expect(result.status.state?.baseUrl).toBe("http://127.0.0.1:54321");
		if (process.platform !== "win32") {
			expect(statSync(result.status.paths.logPath).mode & 0o777).toBe(0o600);
		}
		const config = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(config).toContain('base_url = "http://127.0.0.1:54321"');
		expect(config).toContain(
			`experimental_bearer_token = "${result.status.state?.clientApiKey}"`,
		);

		await unbindCodexAppRuntimeRotation({
			// The fixture intentionally exercises the POSIX bind path, but process
			// identity probing must use the host platform when stopping its real
			// detached child.
			platform: process.platform,
			home: root,
			env,
		});
	}, 20_000);

	it("waits past cold Windows Node startup before declaring router startup failed", async () => {
		const root = await createTempRoot("codex-app-bind-router-slow-port-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const routerScriptPath = join(root, "slow-router.mjs");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await writeFile(
			routerScriptPath,
			[
				"#!/usr/bin/env node",
				"import { mkdirSync, writeFileSync } from 'node:fs';",
				"import { dirname } from 'node:path';",
				"const args = process.argv.slice(2);",
				"const statusPath = args[args.indexOf('--status') + 1];",
				"setTimeout(() => {",
				"  mkdirSync(dirname(statusPath), { recursive: true });",
				"  writeFileSync(statusPath, JSON.stringify({ version: 1, state: 'running', pid: process.pid, startedAt: Date.now(), baseUrl: 'http://127.0.0.1:54322', updatedAt: Date.now() }) + '\\n', 'utf8');",
				"}, 2300);",
				"process.on('SIGTERM', () => process.exit(0));",
				"setInterval(() => undefined, 1000);",
				"",
			].join("\n"),
			"utf8",
		);

		const result = await bindCodexAppRuntimeRotation({
			platform: "win32",
			home: root,
			env,
			nodePath: process.execPath,
			routerScriptPath,
			now: () => 789,
		});

		expect(result.status.state?.port).toBe(54322);
		expect(result.status.running).toBe(true);

		await unbindCodexAppRuntimeRotation({
			platform: "win32",
			home: root,
			env,
		});
	}, 20_000);

	it("fails bind when a spawned router never reports ready for an existing port", async () => {
		const root = await createTempRoot("codex-app-bind-router-stale-port-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const routerScriptPath = join(root, "silent-router.mjs");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await mkdir(codexHome, { recursive: true });
		await writeFile(
			join(codexHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);
		await writeFile(routerScriptPath, "process.exit(0);\n", "utf8");
		await seedExistingAppBindState({
			platform: "linux",
			home: root,
			env,
			port: 4567,
			baseUrl: "http://127.0.0.1:4567",
			nodePath: process.execPath,
			routerScriptPath,
		});

		await expect(
			bindCodexAppRuntimeRotation({
				platform: "linux",
				home: root,
				env,
				nodePath: process.execPath,
				routerScriptPath,
				routerReadyTimeoutMs: 500,
			}),
		).rejects.toThrow("did not report ready");
		await expect(readFile(join(codexHome, "config.toml"), "utf8")).resolves.toBe(
			'model_provider = "openai"\n',
		);
	});

	it("writes a macOS LaunchAgent for login-time router startup", async () => {
		const root = await createTempRoot("codex-app-bind-mac-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, ".codex");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await seedExistingAppBindState({
			platform: "darwin",
			home: root,
			env,
			port: 4568,
			baseUrl: "http://127.0.0.1:4568",
			nodePath: "/usr/local/bin/node",
			routerScriptPath: join(root, "codex-app-router.js"),
		});

		const result = await bindCodexAppRuntimeRotation({
			platform: "darwin",
			home: root,
			env,
			nodePath: "/usr/local/bin/node",
			routerScriptPath: join(root, "codex-app-router.js"),
			spawnDetached: false,
			now: () => 456,
		});

		const plistPath = result.status.paths.launchAgentPath ?? "";
		const plist = await readFile(plistPath, "utf8");
		expect(plist).toContain("com.ndycode.codex-multi-auth.runtime-router");
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toContain("--state");
		expect(plist).toContain("--log");
		expect(plist).toContain("--max-log-bytes");
		expect(plist).toContain("1048576");
		expect(plist).toContain("runtime-rotation-app-bind.json");
		expect(plist).not.toContain(result.status.state?.clientApiKey ?? "");
	});

	it("rejects non-loopback router hosts before binding", async () => {
		const root = await createTempRoot("codex-app-router-host-");
		const statusPath = join(root, "router-status.json");
		const result = spawnSync(
			process.execPath,
			[
				join(thisDir, "..", "scripts", "codex-app-router.js"),
				"--host",
				"0.0.0.0",
				"--port",
				"4567",
				"--status",
				statusPath,
			],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("loopback-only");
		expect(existsSync(statusPath)).toBe(false);
	});

	it.each([
		["fractional", "12.5"],
		["suffix", "123abc"],
		["out of range", "70000"],
	])("rejects %s router port values", async (_label, port) => {
		const root = await createTempRoot("codex-app-router-port-");
		const statusPath = join(root, "router-status.json");
		const result = spawnSync(
			process.execPath,
			[
				join(thisDir, "..", "scripts", "codex-app-router.js"),
				"--port",
				port,
				"--status",
				statusPath,
			],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("valid --port");
		expect(existsSync(statusPath)).toBe(false);
	});

	it("rejects router startup when state is missing its client token", async () => {
		const root = await createTempRoot("codex-app-router-token-");
		const statusPath = join(root, "router-status.json");
		const statePath = join(root, "router-state.json");
		await writeFile(
			statePath,
			`${JSON.stringify({ host: "127.0.0.1", port: 0 })}\n`,
			"utf8",
		);
		const result = spawnSync(
			process.execPath,
			[
				join(thisDir, "..", "scripts", "codex-app-router.js"),
				"--status",
				statusPath,
				"--state",
				statePath,
			],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("missing its client token");
		expect(existsSync(statusPath)).toBe(false);
	});

	it("rejects router startup when state is transiently unreadable instead of binding port 0", async () => {
		const root = await createTempRoot("codex-app-router-missing-state-");
		const statusPath = join(root, "router-status.json");
		const statePath = join(root, "missing-state.json");
		const result = spawnSync(
			process.execPath,
			[
				join(thisDir, "..", "scripts", "codex-app-router.js"),
				"--port",
				"0",
				"--status",
				statusPath,
				"--state",
				statePath,
			],
			{
				encoding: "utf8",
				windowsHide: true,
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("state is unreadable");
		const status = JSON.parse(await readFile(statusPath, "utf8")) as {
			state: string;
			baseUrl: string | null;
		};
		expect(status.state).toBe("error");
		expect(status.baseUrl).toBeNull();
	});

	it("bounds router stdout and stderr log growth", async () => {
		const root = await createTempRoot("codex-app-router-log-bound-");
		const statusPath = join(root, "router-status.json");
		const logPath = join(root, "router.log");
		await writeFile(logPath, "x".repeat(2048), "utf8");
		const logFd = openSync(logPath, "a");
		try {
			const result = spawnSync(
				process.execPath,
				[
					join(thisDir, "..", "scripts", "codex-app-router.js"),
					"--port",
					"4567",
					"--status",
					statusPath,
					"--log",
					logPath,
					"--max-log-bytes",
					"1024",
				],
				{
					stdio: ["ignore", logFd, logFd],
					windowsHide: true,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.status).not.toBe(0);
		} finally {
			closeSync(logFd);
		}

		expect(statSync(logPath).size).toBeLessThan(2048);
		expect(await readFile(logPath, "utf8")).toContain("log truncated");
	});
});

describe("orphaned app-bind recovery (#614)", () => {
	const boundConfig = [
		'model_provider = "codex-multi-auth-runtime-proxy"',
		"disable_response_storage = false",
		"[profiles.default]",
		'model = "gpt-5"',
		"",
		"[model_providers.codex-multi-auth-runtime-proxy]",
		'name = "codex-multi-auth"',
		'base_url = "http://127.0.0.1:51758"',
		"requires_openai_auth = false",
		'wire_api = "responses"',
		"",
	].join("\n");

	async function seedOrphanedBind(): Promise<{
		root: string;
		codexHome: string;
		env: NodeJS.ProcessEnv;
	}> {
		const root = await createTempRoot("codex-app-bind-orphan-");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await mkdir(codexHome, { recursive: true });
		// Bound config on disk, but NO state file and NO backup (the orphan case).
		await writeFile(join(codexHome, "config.toml"), boundConfig, "utf8");
		return { root, codexHome, env };
	}

	it("reports unmanagedBind when config is bound but no state file exists", async () => {
		const { root, env } = await seedOrphanedBind();
		const status = await getAppBindStatus({ platform: "linux", home: root, env });
		expect(status.bound).toBe(true);
		expect(status.unmanagedBind).toBe(true);
		expect(status.state).toBeNull();
		expect(formatAppBindStatus(status)).toContain("bound but unmanaged");
	});

	it("self-heals a bound config with no backup/state on unbind", async () => {
		const { root, codexHome, env } = await seedOrphanedBind();

		const unbound = await unbindCodexAppRuntimeRotation({
			platform: "linux",
			home: root,
			env,
			spawnDetached: false,
		});

		const restored = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(restored).toContain('model_provider = "openai"');
		expect(restored).not.toContain("codex-multi-auth-runtime-proxy");
		expect(restored).not.toContain("disable_response_storage");
		expect(restored).toContain("[profiles.default]");
		expect(unbound.message).toContain("orphaned runtime-proxy bind");
		expect(unbound.status.bound).toBe(false);
		expect(unbound.status.unmanagedBind).toBe(false);
	});

	it("self-heals a half-orphan (proxy block present, model_provider already native) without duplicating keys", async () => {
		const root = await createTempRoot("codex-app-bind-half-orphan-");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await mkdir(codexHome, { recursive: true });
		// Top-level provider is already native, but the proxy block lingers — the
		// partial-orphan case that previously produced a duplicate model_provider.
		await writeFile(
			join(codexHome, "config.toml"),
			[
				'model_provider = "openai"',
				"[profiles.default]",
				'model = "gpt-5"',
				"",
				"[model_providers.codex-multi-auth-runtime-proxy]",
				'name = "codex-multi-auth"',
				'wire_api = "responses"',
				"",
			].join("\n"),
			"utf8",
		);

		const unbound = await unbindCodexAppRuntimeRotation({
			platform: "linux",
			home: root,
			env,
			spawnDetached: false,
		});

		const restored = await readFile(join(codexHome, "config.toml"), "utf8");
		const providerLines = (
			restored.match(/^\s*model_provider\s*=/gm) ?? []
		).length;
		expect(providerLines).toBe(1);
		expect(restored).toContain('model_provider = "openai"');
		expect(restored).not.toContain("codex-multi-auth-runtime-proxy");
		expect(restored).toContain("[profiles.default]");
		expect(unbound.status.bound).toBe(false);
	});

	it("is a no-op for an already-clean config", async () => {
		const root = await createTempRoot("codex-app-bind-clean-");
		const codexHome = join(root, "codex-home");
		const env = {
			CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"),
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};
		await mkdir(codexHome, { recursive: true });
		await writeFile(
			join(codexHome, "config.toml"),
			'model_provider = "openai"\n',
			"utf8",
		);

		const unbound = await unbindCodexAppRuntimeRotation({
			platform: "linux",
			home: root,
			env,
			spawnDetached: false,
		});

		expect(unbound.message).toBe("Codex app bind was not configured");
		expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe(
			'model_provider = "openai"\n',
		);
	});
});

describe("native app binding", () => {
	it("persists reference identity and restores unrelated config edits on unbind", async () => {
		const root = await createTempRoot("native-app-bind-");
		const codexHome = join(root, "codex-home");
		const env = { CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"), CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome };
		await mkdir(codexHome, { recursive: true });
		await writeFile(join(codexHome, "config.toml"), 'model = "original-model"\nmodel_reasoning_effort = "medium"\n');
		const options = { platform: "linux" as const, home: root, env, spawnDetached: false };
		await seedExistingAppBindState({ ...options, port: 43210, baseUrl: "http://127.0.0.1:43210", nodePath: process.execPath, routerScriptPath: join(thisDir, "../scripts/codex-app-router.js") });
		await bindCodexAppRuntimeRotation({ ...options, nativeOpenai: true, catalogAccount: { email: "reference@example.test", accountId: "ref-account" } });
		const status = await getAppBindStatus(options);
		expect(status.state?.nativeOpenai).toBe(true);
		expect(status.state?.catalogAccount).toEqual({ email: "reference@example.test", accountId: "ref-account" });
		const bound = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(bound).toContain('model_provider = "openai"'); expect(bound).not.toContain('requires_openai_auth = false');
		await writeFile(join(codexHome, "config.toml"), bound.replace('"medium"', '"high"'));
		await unbindCodexAppRuntimeRotation(options);
		const restored = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(restored).not.toContain('openai_base_url'); expect(restored).toContain('model_reasoning_effort = "high"');
	});
	it("removes an orphaned native override when unbinding", async () => {
		const root = await createTempRoot("native-orphan-"); const codexHome = join(root, "codex-home");
		const env = { CODEX_MULTI_AUTH_DIR: join(root, "multi-auth"), CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome };
		await mkdir(codexHome, { recursive: true });
		await writeFile(join(codexHome, "config.toml"), rewriteConfigTomlForAppBind('model = "kept"\n', 'http://127.0.0.1:43210', 'secret', true));
		await unbindCodexAppRuntimeRotation({ platform: "linux", home: root, env, spawnDetached: false });
		const restored = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(restored).not.toContain('43210'); expect(restored).not.toContain('native provider'); expect(restored).toContain('model = "kept"');
	});
});

describe("reviewed provider transitions",()=>{
 async function fixture(){
  const root=await createTempRoot("bind-transition-");const codexHome=join(root,"codex-home");
  const env={CODEX_MULTI_AUTH_DIR:join(root,"multi-auth"),CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME:codexHome};
  await mkdir(codexHome,{recursive:true});await writeFile(join(codexHome,"config.toml"),'model="example"\n');
  const options={platform:"linux" as const,home:root,env,spawnDetached:false};
  await seedExistingAppBindState({...options,port:43210,baseUrl:"http://127.0.0.1:43210",nodePath:process.execPath,routerScriptPath:join(thisDir,"../scripts/codex-app-router.js")});
  return options;
 }
 it("clears the reference through native/custom/native",async()=>{
  const options=await fixture();
  await bindCodexAppRuntimeRotation({...options,nativeOpenai:true,catalogAccount:{email:"reference@example.test",accountId:"ref"}});
  await bindCodexAppRuntimeRotation({...options,nativeOpenai:false});
  expect((await getAppBindStatus(options)).state?.catalogAccount).toBeUndefined();
  await bindCodexAppRuntimeRotation({...options,nativeOpenai:true});
  expect((await getAppBindStatus(options)).state?.catalogAccount).toBeUndefined();
 });
 it("allows a mode change when the recorded router pid now belongs to another process",async()=>{
  const options=await fixture();
  const freePort=await unusedPort();
  await writeFile(resolveAppBindPaths(options).statusPath,JSON.stringify({pid:process.pid,baseUrl:`http://127.0.0.1:${freePort}`,port:freePort,startedAt:1,updatedAt:1}));
  const verifyProcessIdentity=vi.fn(async()=>false);
  await bindCodexAppRuntimeRotation({...options,nativeOpenai:true,verifyProcessIdentity});
  expect((await getAppBindStatus(options)).state?.nativeOpenai).toBe(true);
 });
 it("starts a replacement router when the recorded router pid was recycled",async()=>{
  const root=await createTempRoot("bind-recycled-router-");const codexHome=join(root,"codex-home");
  const env={CODEX_MULTI_AUTH_DIR:join(root,"multi-auth"),CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME:codexHome};
  await mkdir(codexHome,{recursive:true});await writeFile(join(codexHome,"config.toml"),'model="example"\n');
  const routerScriptPath=join(root,"fake-router.mjs");
  await writeFile(routerScriptPath,[
   "import { mkdirSync, writeFileSync } from 'node:fs';",
   "import { dirname } from 'node:path';",
   "const args = process.argv.slice(2);",
   "const statusPath = args[args.indexOf('--status') + 1];",
   "mkdirSync(dirname(statusPath), { recursive: true });",
   "writeFileSync(statusPath, JSON.stringify({ version: 1, state: 'running', pid: process.pid, startedAt: Date.now(), baseUrl: 'http://127.0.0.1:54323', updatedAt: Date.now() }) + '\\n', 'utf8');",
   "process.on('SIGTERM', () => process.exit(0));",
   "setInterval(() => undefined, 1000);",
   "",
  ].join("\n"),"utf8");
  const options={platform:process.platform,home:root,env,nodePath:process.execPath,routerScriptPath};
  // A port nothing listens on: the old router is gone.
  const freePort=await unusedPort();
  const oldUrl=`http://127.0.0.1:${freePort}`;
  await seedExistingAppBindState({...options,port:freePort,baseUrl:oldUrl});
  // The recorded router is gone and its pid now belongs to an unrelated live process.
  await writeFile(resolveAppBindPaths(options).statusPath,JSON.stringify({version:1,state:"running",pid:process.pid,baseUrl:oldUrl,port:freePort,startedAt:1,updatedAt:1}));
  let routerPid: number | null | undefined;
  try {
   const result=await bindCodexAppRuntimeRotation({...options,nativeOpenai:true,verifyProcessIdentity:async()=>false});
   routerPid=result.status.router?.pid;
   expect(result.status.state?.nativeOpenai).toBe(true);
   expect(result.status.state?.baseUrl).toBe("http://127.0.0.1:54323");
   expect(routerPid).not.toBe(process.pid);
  } finally {
   // Binding and cleanup use the same host platform and process-identity probe.
   await unbindCodexAppRuntimeRotation(options);
   const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
   if(routerPid&&routerPid!==process.pid){
    const stopped=await vi.waitFor(()=>{if(alive(routerPid!))throw Error("router still running");return true;},{timeout:5000}).catch(()=>false);
    if(!stopped)process.kill(routerPid,"SIGKILL");
    expect(stopped).toBe(true);
   }
  }
 },20_000);
 it("refuses a mode change when a live router only fails its identity probe",async()=>{
  const options=await fixture();
  // Still serving at its recorded address: a false-negative identity probe (e.g. a Windows timeout).
  const live=createServer((_req,res)=>{res.writeHead(401);res.end();});
  await new Promise<void>(r=>live.listen(0,"127.0.0.1",()=>r()));
  const liveUrl=`http://127.0.0.1:${(live.address() as import("node:net").AddressInfo).port}`;
  const statusPath=resolveAppBindPaths(options).statusPath;
  const status=JSON.stringify({version:1,state:"running",pid:process.pid,baseUrl:liveUrl,startedAt:1,updatedAt:1});
  await writeFile(statusPath,status);
  try {
   await expect(bindCodexAppRuntimeRotation({...options,nativeOpenai:true,verifyProcessIdentity:async()=>false})).rejects.toThrow(/Could not confirm that the app router/);
   expect(await readFile(statusPath,"utf8")).toBe(status);
   expect((await getAppBindStatus(options)).state?.nativeOpenai).not.toBe(true);
  } finally {live.closeAllConnections();await new Promise<void>(r=>live.close(()=>r()));}
 });
 it("allows a mode change with a dead recorded router",async()=>{
  const options=await fixture();
  await withDeadPid(async pid=>{
   await writeFile(resolveAppBindPaths(options).statusPath,JSON.stringify({pid,baseUrl:"http://127.0.0.1:43210",port:43210,startedAt:1,updatedAt:1}));
   await bindCodexAppRuntimeRotation({...options,nativeOpenai:true});
   expect((await getAppBindStatus(options)).state?.nativeOpenai).toBe(true);
  });
 });
});
