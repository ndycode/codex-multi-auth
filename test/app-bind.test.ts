import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	bindCodexAppRuntimeRotation,
	formatAppBindStatus,
	resolveAppBindPaths,
	restoreConfigTomlFromAppBind,
	rewriteConfigTomlForAppBind,
	unbindCodexAppRuntimeRotation,
} from "../lib/runtime/app-bind.js";
import { tomlStringLiteral } from "../lib/runtime/config-toml.js";
import { withFileOperationRetry } from "../lib/fs-retry.js";
import { RUNTIME_ROTATION_PROXY_PROVIDER_ID } from "../lib/runtime-constants.js";

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
	it("rewrites and restores Codex config TOML without disturbing other sections", () => {
		const original = [
			'model_provider = "openai"',
			'model = "gpt-5.4"',
			"",
			"[profiles.default]",
			'model = "gpt-5.4"',
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
				"writeFileSync(statusPath, JSON.stringify({ version: 1, state: 'running', pid: process.pid, baseUrl: 'http://127.0.0.1:54321', updatedAt: Date.now() }) + '\\n', 'utf8');",
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
			platform: "linux",
			home: root,
			env,
		});
	});

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
				"  writeFileSync(statusPath, JSON.stringify({ version: 1, state: 'running', pid: process.pid, baseUrl: 'http://127.0.0.1:54322', updatedAt: Date.now() }) + '\\n', 'utf8');",
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
	});

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
