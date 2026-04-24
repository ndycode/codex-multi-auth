import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	bindCodexAppRuntimeRotation,
	resolveAppBindPaths,
	restoreConfigTomlFromAppBind,
	rewriteConfigTomlForAppBind,
	unbindCodexAppRuntimeRotation,
} from "../lib/runtime/app-bind.js";
import { withFileOperationRetry } from "../scripts/install-codex-auth-utils.js";

const tempRoots: string[] = [];

async function createTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0).map((root) =>
			withFileOperationRetry(() => rm(root, { recursive: true, force: true })),
		),
	);
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
		expect(bound).toContain('model_provider = "codex-multi-auth-runtime-proxy"');
		expect(bound).toContain("[model_providers.codex-multi-auth-runtime-proxy]");
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
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, "codex-home");
		const appData = join(root, "AppData", "Roaming");
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

		const result = await bindCodexAppRuntimeRotation({
			platform: "win32",
			home: root,
			env,
			nodePath: "node",
			routerScriptPath: join(root, "codex-app-router.js"),
			spawnDetached: false,
			now: () => 123,
		});

		expect(result.status.bound).toBe(true);
		expect(result.status.running).toBe(false);
		expect(result.status.state?.statePath).toBe(
			join(multiAuthDir, "app-bind", "runtime-rotation-app-bind.json"),
		);
		const config = await readFile(join(codexHome, "config.toml"), "utf8");
		expect(config).toContain("[model_providers.codex-multi-auth-runtime-proxy]");
		expect(config).toContain(result.status.state?.baseUrl);
		expect(config).toContain("requires_openai_auth = false");
		expect(config).toContain(
			`experimental_bearer_token = "${result.status.state?.clientApiKey}"`,
		);
		expect(config).not.toContain("env_key");
		const startup = await readFile(result.status.paths.startupPath ?? "", "utf8");
		expect(startup).toContain("--state");
		expect(startup).toContain("runtime-rotation-app-bind.json");
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

	it("writes a macOS LaunchAgent for login-time router startup", async () => {
		const root = await createTempRoot("codex-app-bind-mac-");
		const multiAuthDir = join(root, "multi-auth");
		const codexHome = join(root, ".codex");
		const env = {
			CODEX_MULTI_AUTH_DIR: multiAuthDir,
			CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME: codexHome,
		};

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
		expect(plist).toContain("runtime-rotation-app-bind.json");
		expect(plist).not.toContain(result.status.state?.clientApiKey ?? "");
	});

	it("rejects non-loopback router hosts before binding", async () => {
		const root = await createTempRoot("codex-app-router-host-");
		const statusPath = join(root, "router-status.json");
		const result = spawnSync(
			process.execPath,
			[
				"scripts/codex-app-router.js",
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

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("loopback-only");
		expect(existsSync(statusPath)).toBe(false);
	});
});
