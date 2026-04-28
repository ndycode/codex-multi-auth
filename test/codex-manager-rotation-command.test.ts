import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRotationCommand } from "../lib/codex-manager/commands/rotation.js";
import type { RotationCommandDeps } from "../lib/codex-manager/commands/rotation.js";
import type { AppBindResult, AppBindStatus } from "../lib/runtime/app-bind.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { PluginConfig } from "../lib/types.js";
import { withFileOperationRetry } from "../scripts/install-codex-auth-utils.js";

const originalRuntimeRotationProxyEnv =
	process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY;
const originalMultiAuthDir = process.env.CODEX_MULTI_AUTH_DIR;
const tempRoots: string[] = [];

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

function createRuntimeSnapshot(now: number, index: number, accountId: string) {
	return {
		version: 1,
		updatedAt: now,
		currentRequestId: null,
		responsesRequests: 1,
		authRefreshRequests: 0,
		diagnosticProbeRequests: 0,
		poolExhaustionCooldownUntil: null,
		serverBurstCooldownUntil: null,
		lastAccountIndex: index,
		lastAccountId: accountId,
		lastAccountLabel: `Account ${index + 1}`,
		lastAccountUpdatedAt: now,
		runtimeMetrics: {
			startedAt: now - 1_000,
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			responsesRequests: 1,
			authRefreshRequests: 0,
			diagnosticProbeRequests: 0,
			outboundRequestAttemptBudget: null,
			outboundRequestAttemptsConsumed: 0,
			requestAttemptBudgetExhaustions: 0,
			poolExhaustionFastFails: 0,
			serverBurstFastFails: 0,
			rateLimitedResponses: 0,
			serverErrors: 0,
			networkErrors: 0,
			userAborts: 0,
			authRefreshFailures: 0,
			emptyResponseRetries: 0,
			accountRotations: 1,
			sameAccountRetries: 0,
			streamFailoverAttempts: 0,
			streamFailoverCandidatesConsidered: 0,
			lastStreamFailoverCandidateCount: 0,
			streamFailoverRecoveries: 0,
			streamFailoverCrossAccountRecoveries: 0,
			cumulativeLatencyMs: 10,
			lastRequestAt: now,
			lastError: null,
		},
	};
}

async function createTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function createDeps(params: {
	config?: PluginConfig;
	storage?: AccountStorageV3 | null;
	now?: number;
	appBindStatus?: AppBindStatus;
	withSaveAccounts?: boolean;
} = {}): {
	deps: RotationCommandDeps;
	errors: string[];
	infos: string[];
	savePluginConfigMock: ReturnType<typeof vi.fn>;
	setStoragePathMock: ReturnType<typeof vi.fn>;
	bindCodexAppMock: ReturnType<typeof vi.fn>;
	unbindCodexAppMock: ReturnType<typeof vi.fn>;
	saveAccountsMock: ReturnType<typeof vi.fn>;
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
	const saveAccountsMock = vi.fn(async (_storage: AccountStorageV3) => undefined);
	return {
		infos,
		errors,
		savePluginConfigMock,
		setStoragePathMock,
		bindCodexAppMock,
		unbindCodexAppMock,
		saveAccountsMock,
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
			...(params.withSaveAccounts === false ? {} : { saveAccounts: saveAccountsMock }),
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
	} else {
		process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY =
			originalRuntimeRotationProxyEnv;
	}
	if (originalMultiAuthDir === undefined) {
		delete process.env.CODEX_MULTI_AUTH_DIR;
	} else {
		process.env.CODEX_MULTI_AUTH_DIR = originalMultiAuthDir;
	}
});

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0).map((root) =>
			withFileOperationRetry(() => rm(root, { recursive: true, force: true })),
		),
	);
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
		expect(setStoragePathMock).toHaveBeenNthCalledWith(1, null);
		expect(setStoragePathMock).toHaveBeenNthCalledWith(
			2,
			"/mock/openai-codex-accounts.json",
		);
	});

	it("prints runtime in-use and quota-exhausted markers in status rows", async () => {
		const now = Date.now();
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "selected@example.com",
					accountId: "acc_selected",
					refreshToken: "refresh-selected",
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
				},
				{
					email: "runtime@example.com",
					accountId: "acc_runtime",
					refreshToken: "refresh-runtime",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
			],
		};
		const { deps, infos } = createDeps({ storage, now });
		deps.loadRuntimeObservabilitySnapshot = vi.fn(async () =>
			createRuntimeSnapshot(now, 1, "acc_runtime"),
		);
		deps.loadQuotaCache = vi.fn(async () => ({
			byAccountId: {
				acc_runtime: {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 100,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 100,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
			byEmail: {},
		}));

		await expect(runRotationCommand(["status"], deps)).resolves.toBe(0);

		const output = infos.join("\n");
		expect(output).toContain(
			"Account 1 (selected@example.com, id:lected) [selected]",
		);
		expect(output).toContain(
			"Account 2 (runtime@example.com, id:untime) [in-use, quota-exhausted]",
		);
	});

	it("prints invalid env override values without coercing them", async () => {
		process.env.CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY = "whatever";
		const { deps, infos } = createDeps({
			config: { codexRuntimeRotationProxy: true },
			storage: null,
		});

		await expect(runRotationCommand(["status"], deps)).resolves.toBe(0);

		const output = infos.join("\n");
		expect(output).toContain("Runtime rotation proxy: enabled");
		expect(output).toContain("Env override: invalid (whatever)");
	});

	it("ignores stale helper status files with reused process ids", async () => {
		const root = await createTempRoot("codex-rotation-helper-status-");
		process.env.CODEX_MULTI_AUTH_DIR = root;
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "runtime-rotation-app-helper.json"),
			`${JSON.stringify({
				version: 1,
				kind: "unrelated-process",
				state: "running",
				pid: process.pid,
				totalRequests: 12,
				rotations: 3,
				updatedAt: Date.now(),
			})}\n`,
			"utf8",
		);
		const { deps, infos } = createDeps({ storage: null });

		await expect(runRotationCommand(["status"], deps)).resolves.toBe(0);

		expect(infos.join("\n")).toContain("Codex app helper: not running");
	});

	it("handles overlapping enable commands without dropping saves or app binds", async () => {
		const {
			deps,
			savePluginConfigMock,
			bindCodexAppMock,
			infos,
		} = createDeps();
		let releaseFirstSave: (() => void) | undefined;
		const firstSave = new Promise<void>((resolve) => {
			releaseFirstSave = resolve;
		});
		savePluginConfigMock
			.mockImplementationOnce(async () => {
				await firstSave;
			})
			.mockResolvedValue(undefined);

		const first = runRotationCommand(["enable"], deps);
		const second = runRotationCommand(["enable"], deps);
		await vi.waitFor(() => expect(savePluginConfigMock).toHaveBeenCalledTimes(2));
		releaseFirstSave?.();

		await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
		expect(savePluginConfigMock).toHaveBeenNthCalledWith(1, {
			codexRuntimeRotationProxy: true,
		});
		expect(savePluginConfigMock).toHaveBeenNthCalledWith(2, {
			codexRuntimeRotationProxy: true,
		});
		expect(bindCodexAppMock).toHaveBeenCalledTimes(2);
		expect(infos.filter((line) => line === "Runtime rotation proxy enabled.")).toHaveLength(
			2,
		);
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

	describe("reset-rate-limits", () => {
		function buildStorageWithLimits(now: number): AccountStorageV3 {
			return {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "a@example.com",
						accountId: "acc_a",
						refreshToken: "refresh-a",
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						rateLimitResetTimes: { codex: now + 60_000 },
						coolingDownUntil: now + 30_000,
					},
					{
						email: "b@example.com",
						accountId: "acc_b",
						refreshToken: "refresh-b",
						addedAt: now - 4_000,
						lastUsed: now - 4_000,
						rateLimitResetTimes: { codex: now + 120_000, "codex:gpt-5": now + 90_000 },
					},
					{
						email: "c@example.com",
						accountId: "acc_c",
						refreshToken: "refresh-c",
						addedAt: now - 3_000,
						lastUsed: now - 3_000,
						rateLimitResetTimes: {},
					},
				],
			};
		}

		it("clears rate-limit and cooldown timers across all accounts and persists changes", async () => {
			const now = Date.now();
			const storage = buildStorageWithLimits(now);
			const { deps, saveAccountsMock, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(["reset-rate-limits"], deps),
			).resolves.toBe(0);

			expect(saveAccountsMock).toHaveBeenCalledTimes(1);
			expect(storage.accounts[0].rateLimitResetTimes).toEqual({});
			expect(storage.accounts[0].coolingDownUntil).toBeUndefined();
			expect(storage.accounts[1].rateLimitResetTimes).toEqual({});
			expect(storage.accounts[2].rateLimitResetTimes).toEqual({});
			expect(infos.join("\n")).toContain("Cleared 2/3 account(s)");
		});

		it("dry-run reports changes without saving", async () => {
			const now = Date.now();
			const storage = buildStorageWithLimits(now);
			const before = JSON.parse(JSON.stringify(storage));
			const { deps, saveAccountsMock, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(["reset-rate-limits", "--dry-run"], deps),
			).resolves.toBe(0);

			expect(saveAccountsMock).not.toHaveBeenCalled();
			expect(storage).toEqual(before);
			const out = infos.join("\n");
			expect(out).toContain("Would clear 2/3 account(s)");
			expect(out).toContain("(dry-run; no changes written)");
		});

		it("scopes to a single account with --account", async () => {
			const now = Date.now();
			const storage = buildStorageWithLimits(now);
			const { deps, saveAccountsMock, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(["reset-rate-limits", "--account", "2"], deps),
			).resolves.toBe(0);

			expect(saveAccountsMock).toHaveBeenCalledTimes(1);
			expect(storage.accounts[0].rateLimitResetTimes).toEqual({ codex: now + 60_000 });
			expect(storage.accounts[0].coolingDownUntil).toBe(now + 30_000);
			expect(storage.accounts[1].rateLimitResetTimes).toEqual({});
			expect(infos.join("\n")).toContain("Cleared 1/1 account(s)");
		});

		it("rejects an out-of-range --account index", async () => {
			const now = Date.now();
			const { deps, errors, saveAccountsMock } = createDeps({
				storage: buildStorageWithLimits(now),
				now,
			});

			await expect(
				runRotationCommand(["reset-rate-limits", "--account", "99"], deps),
			).resolves.toBe(1);

			expect(saveAccountsMock).not.toHaveBeenCalled();
			expect(errors.join("\n")).toContain("Account index out of range");
		});

		it("rejects --all combined with --account", async () => {
			const now = Date.now();
			const { deps, errors, saveAccountsMock } = createDeps({
				storage: buildStorageWithLimits(now),
				now,
			});

			await expect(
				runRotationCommand(
					["reset-rate-limits", "--all", "--account", "1"],
					deps,
				),
			).resolves.toBe(1);

			expect(saveAccountsMock).not.toHaveBeenCalled();
			expect(errors.join("\n")).toContain("--all and --account are mutually exclusive");
		});

		it("emits JSON when --json is set, including a restart hint after writes", async () => {
			const now = Date.now();
			const storage = buildStorageWithLimits(now);
			const { deps, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(["reset-rate-limits", "--json"], deps),
			).resolves.toBe(0);

			expect(infos).toHaveLength(1);
			const payload = JSON.parse(infos[0]);
			expect(payload).toMatchObject({
				ok: true,
				dryRun: false,
				scope: "all",
				accountsScanned: 3,
				accountsChanged: 2,
			});
			expect(payload.changes).toHaveLength(2);
			expect(payload.changes[0]).toMatchObject({
				index: 0,
				clearedCoolingDown: true,
			});
			expect(payload.restartHint).toMatch(/codex auth rotation disable/);
		});

		it("omits the restart hint from JSON output for dry-run and no-op runs", async () => {
			const now = Date.now();
			const storage = buildStorageWithLimits(now);
			const { deps, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(
					["reset-rate-limits", "--dry-run", "--json"],
					deps,
				),
			).resolves.toBe(0);

			expect(infos).toHaveLength(1);
			const payload = JSON.parse(infos[0]);
			expect(payload.dryRun).toBe(true);
			expect(payload.restartHint).toBeUndefined();
		});

		it("prints a restart hint after successful clears in human-readable mode", async () => {
			const now = Date.now();
			const storage = buildStorageWithLimits(now);
			const { deps, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(["reset-rate-limits"], deps),
			).resolves.toBe(0);

			expect(infos.join("\n")).toContain(
				"Note: Run `codex auth rotation disable` then `codex auth rotation enable`",
			);
		});

		it("only deletes future-active rate-limit keys and preserves expired ones", async () => {
			const now = Date.now();
			const storage: AccountStorageV3 = {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "mixed@example.com",
						accountId: "acc_mixed",
						refreshToken: "refresh-mixed",
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						rateLimitResetTimes: {
							codex: now + 60_000,
							"codex:legacy": now - 30_000,
						},
					},
				],
			};
			const { deps, saveAccountsMock, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(["reset-rate-limits", "--json"], deps),
			).resolves.toBe(0);

			expect(saveAccountsMock).toHaveBeenCalledTimes(1);
			expect(storage.accounts[0].rateLimitResetTimes).toEqual({
				"codex:legacy": now - 30_000,
			});
			const payload = JSON.parse(infos[0]);
			expect(payload.changes[0].clearedRateLimitKeys).toEqual(["codex"]);
		});

		it("prints subcommand help and exits 0 on --help", async () => {
			const { deps, infos } = createDeps();

			await expect(
				runRotationCommand(["reset-rate-limits", "--help"], deps),
			).resolves.toBe(0);

			const out = infos.join("\n");
			expect(out).toContain("Usage:");
			expect(out).toContain("--account <idx>");
			expect(out).toContain("rotation disable");
		});

		it("rejects --account with non-integer or fractional values", async () => {
			const now = Date.now();
			const { deps: depsAlpha, errors: errorsAlpha } = createDeps({
				storage: buildStorageWithLimits(now),
				now,
			});
			await expect(
				runRotationCommand(
					["reset-rate-limits", "--account", "1abc"],
					depsAlpha,
				),
			).resolves.toBe(1);
			expect(errorsAlpha.join("\n")).toContain(
				"--account expects a positive 1-based integer",
			);

			const { deps: depsFraction, errors: errorsFraction } = createDeps({
				storage: buildStorageWithLimits(now),
				now,
			});
			await expect(
				runRotationCommand(
					["reset-rate-limits", "--account", "1.5"],
					depsFraction,
				),
			).resolves.toBe(1);
			expect(errorsFraction.join("\n")).toContain(
				"--account expects a positive 1-based integer",
			);
		});

		it("returns 0 with a friendly message when nothing is rate-limited", async () => {
			const now = Date.now();
			const storage: AccountStorageV3 = {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "clean@example.com",
						accountId: "acc_clean",
						refreshToken: "refresh-clean",
						addedAt: now - 1_000,
						lastUsed: now - 1_000,
						rateLimitResetTimes: {},
					},
				],
			};
			const { deps, saveAccountsMock, infos } = createDeps({ storage, now });

			await expect(
				runRotationCommand(["reset-rate-limits"], deps),
			).resolves.toBe(0);

			expect(saveAccountsMock).not.toHaveBeenCalled();
			expect(infos.join("\n")).toContain(
				"No accounts had active rate-limit or cooldown timers to clear.",
			);
		});

		it("fails fast when saveAccounts dep is missing and not dry-run", async () => {
			const now = Date.now();
			const { deps, errors } = createDeps({
				storage: buildStorageWithLimits(now),
				now,
				withSaveAccounts: false,
			});

			await expect(
				runRotationCommand(["reset-rate-limits"], deps),
			).resolves.toBe(1);

			expect(errors.join("\n")).toContain(
				"reset-rate-limits requires writable account storage",
			);
		});
	});
});
