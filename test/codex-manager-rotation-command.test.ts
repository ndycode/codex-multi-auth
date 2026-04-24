import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRotationCommand } from "../lib/codex-manager/commands/rotation.js";
import type { RotationCommandDeps } from "../lib/codex-manager/commands/rotation.js";
import type { AppBindResult, AppBindStatus } from "../lib/runtime/app-bind.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { PluginConfig } from "../lib/types.js";

const originalRuntimeRotationProxyEnv =
	process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY;

function createStorage(now: number): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 1,
		activeIndexByFamily: { codex: 1 },
		accounts: [
			{
				email: "first@example.com",
				accountId: "acc_first",
				refreshToken: "refresh-first",
				addedAt: now - 2_000,
				lastUsed: now - 2_000,
				enabled: false,
			},
			{
				email: "second@example.com",
				accountId: "acc_second",
				refreshToken: "refresh-second",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
				rateLimitResetTimes: { codex: now + 30_000 },
			},
		],
	};
}

function createAppBindStatus(params: Partial<AppBindStatus> = {}): AppBindStatus {
	const status: AppBindStatus = {
		bound: false,
		running: false,
		state: null,
		router: null,
		paths: {
			codexHome: "/mock/.codex",
			configPath: "/mock/.codex/config.toml",
			bindDir: "/mock/.codex/multi-auth/app-bind",
			statePath: "/mock/.codex/multi-auth/app-bind/runtime-rotation-app-bind.json",
			backupPath: "/mock/.codex/multi-auth/app-bind/codex-config-backup.json",
			statusPath: "/mock/.codex/multi-auth/app-bind/runtime-rotation-app-bind-status.json",
			logPath: "/mock/.codex/multi-auth/app-bind/runtime-rotation-app-router.log",
			routerScriptPath: "/mock/scripts/codex-app-router.js",
			startupPath: null,
			launchAgentPath: null,
		},
	};
	return { ...status, ...params };
}

function createAppBindResult(message: string, status = createAppBindStatus()): AppBindResult {
	return { message, status };
}

function createDeps(params: {
	config?: PluginConfig;
	storage?: AccountStorageV3 | null;
	now?: number;
	appBindStatus?: AppBindStatus;
} = {}): {
	deps: RotationCommandDeps;
	errors: string[];
	infos: string[];
	savePluginConfigMock: ReturnType<typeof vi.fn>;
	setStoragePathMock: ReturnType<typeof vi.fn>;
	bindCodexAppMock: ReturnType<typeof vi.fn>;
	unbindCodexAppMock: ReturnType<typeof vi.fn>;
} {
	const config = params.config ?? {};
	const storage = params.storage ?? null;
	const infos: string[] = [];
	const errors: string[] = [];
	const savePluginConfigMock = vi.fn(async () => undefined);
	const setStoragePathMock = vi.fn();
	const bindCodexAppMock = vi.fn(async () =>
		createAppBindResult(
			"Bound Codex app config /mock/.codex/config.toml to http://127.0.0.1:4567",
			createAppBindStatus({
				bound: true,
				running: true,
				state: {
					version: 1,
					platform: "linux",
					host: "127.0.0.1",
					port: 4567,
					baseUrl: "http://127.0.0.1:4567",
					configPath: "/mock/.codex/config.toml",
					statePath: "/mock/.codex/multi-auth/app-bind/runtime-rotation-app-bind.json",
					backupPath: "/mock/.codex/multi-auth/app-bind/codex-config-backup.json",
					statusPath:
						"/mock/.codex/multi-auth/app-bind/runtime-rotation-app-bind-status.json",
					logPath: "/mock/.codex/multi-auth/app-bind/runtime-rotation-app-router.log",
					nodePath: "node",
					routerScriptPath: "/mock/scripts/codex-app-router.js",
					clientApiKey: "app-secret",
					startupPath: null,
					launchAgentPath: null,
					boundConfigHash: "hash",
					updatedAt: 1,
				},
			}),
		),
	);
	const unbindCodexAppMock = vi.fn(async () =>
		createAppBindResult("Unbound Codex app config /mock/.codex/config.toml"),
	);
	return {
		infos,
		errors,
		savePluginConfigMock,
		setStoragePathMock,
		bindCodexAppMock,
		unbindCodexAppMock,
		deps: {
			loadPluginConfig: () => config,
			savePluginConfig: savePluginConfigMock,
			getCodexRuntimeRotationProxy: (pluginConfig) => {
				const override = process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY;
				if (override === "1") return true;
				if (override === "0") return false;
				return pluginConfig.codexRuntimeRotationProxy === true;
			},
			loadAccounts: async () => storage,
			resolveActiveIndex: (loadedStorage) => loadedStorage.activeIndex,
			getStoragePath: () => "/mock/openai-codex-accounts.json",
			setStoragePath: setStoragePathMock,
			bindCodexApp: bindCodexAppMock,
			unbindCodexApp: unbindCodexAppMock,
			getCodexAppBindStatus: async () =>
				params.appBindStatus ?? createAppBindStatus(),
			getNow: () => params.now ?? Date.now(),
			logInfo: (message) => infos.push(message),
			logError: (message) => errors.push(message),
		},
	};
}

beforeEach(() => {
	delete process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY;
});

afterEach(() => {
	if (originalRuntimeRotationProxyEnv === undefined) {
		delete process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY;
		return;
	}
	process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY =
		originalRuntimeRotationProxyEnv;
});

describe("codex auth rotation command", () => {
	it("enables and disables the runtime rotation proxy setting", async () => {
		const { deps, savePluginConfigMock, infos } = createDeps();

		await expect(runRotationCommand(["enable"], deps)).resolves.toBe(0);
		await expect(runRotationCommand(["disable"], deps)).resolves.toBe(0);

		expect(savePluginConfigMock).toHaveBeenNthCalledWith(1, {
			codexRuntimeRotationProxy: true,
		});
		expect(savePluginConfigMock).toHaveBeenNthCalledWith(2, {
			codexRuntimeRotationProxy: false,
		});
		expect(infos.join("\n")).toContain("Runtime rotation proxy enabled.");
		expect(infos.join("\n")).toContain("Runtime rotation proxy disabled.");
	});

	it("prints status with env override and account state", async () => {
		const now = Date.now();
		process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY = "1";
		const { deps, infos, setStoragePathMock } = createDeps({
			config: { codexRuntimeRotationProxy: false },
			storage: createStorage(now),
			now,
		});

		await expect(runRotationCommand(["status"], deps)).resolves.toBe(0);

		const output = infos.join("\n");
		expect(setStoragePathMock).toHaveBeenCalledWith(null);
		expect(output).toContain("Runtime rotation proxy: enabled");
		expect(output).toContain("Stored setting: disabled");
		expect(output).toContain("Env override: enabled");
		expect(output).toContain("Codex app bind: not configured");
		expect(output).toContain("Accounts: 2");
		expect(output).toContain("Account 1 (first@example.com, id:_first) [disabled]");
		expect(output).toContain("Account 2 (second@example.com, id:second)");
		expect(output).toContain("rate-limited:30s");
	});

	it("rejects unknown subcommands with usage", async () => {
		const { deps, errors, infos } = createDeps();

		await expect(runRotationCommand(["maybe"], deps)).resolves.toBe(1);

		expect(errors).toEqual(["Unknown rotation command: maybe"]);
		expect(infos.join("\n")).toContain("codex auth rotation enable");
	});

	it("binds and unbinds the Codex app with rotation enable and disable", async () => {
		const {
			deps,
			savePluginConfigMock,
			bindCodexAppMock,
			unbindCodexAppMock,
			infos,
		} = createDeps();

		await expect(runRotationCommand(["enable"], deps)).resolves.toBe(0);
		await expect(runRotationCommand(["disable"], deps)).resolves.toBe(0);

		expect(savePluginConfigMock).toHaveBeenNthCalledWith(1, {
			codexRuntimeRotationProxy: true,
		});
		expect(savePluginConfigMock).toHaveBeenNthCalledWith(2, {
			codexRuntimeRotationProxy: false,
		});
		expect(bindCodexAppMock).toHaveBeenCalledTimes(1);
		expect(unbindCodexAppMock).toHaveBeenCalledTimes(1);
		expect(infos.join("\n")).toContain("Codex app bind: running, port=4567");
		expect(infos.join("\n")).toContain("Unbound Codex app config");
	});

	it("supports explicit app bind repair commands", async () => {
		const { deps, bindCodexAppMock, unbindCodexAppMock, infos } = createDeps();

		await expect(runRotationCommand(["bind-app"], deps)).resolves.toBe(0);
		await expect(runRotationCommand(["unbind-app"], deps)).resolves.toBe(0);

		expect(bindCodexAppMock).toHaveBeenCalledTimes(1);
		expect(unbindCodexAppMock).toHaveBeenCalledTimes(1);
		expect(infos.join("\n")).toContain("Bound Codex app config");
		expect(infos.join("\n")).toContain("Unbound Codex app config");
	});
});
