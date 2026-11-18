import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAppBindStatus, resolveAppBindPaths } from "../lib/runtime/app-bind.js";
import { getStoragePath, setStoragePath } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";
import { withDeadPid } from "./helpers/owned-pids.js";
import { quotaWorkspaceKey } from "../lib/quota-readiness.js";
import { resetTargetForStoredAccount } from "../lib/runtime/account-reset-credits.js";
import { describe, expect, it, vi } from "vitest";
import {
	type FeaturesCommandDeps,
	runFeaturesCommand,
	runStatusCommand,
	type StatusCommandDeps,
} from "../lib/codex-manager/commands/status.js";
import { runCodexMultiAuthCli } from "../lib/codex-manager.js";
import type { AccountStorageV3, StorageHealthSummary } from "../lib/storage.js";
import type { RuntimeObservabilitySnapshot } from "../lib/runtime/runtime-observability.js";
import { AUTH_INVALIDATION_MARKER } from "../lib/accounts.js";
import { getAccountPolicyKey } from "../lib/account-policy.js";

function createStorage(): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts: [
			{
				email: "one@example.com",
				refreshToken: "refresh-token-1",
				addedAt: 1,
				lastUsed: 1,
			},
			{
				email: "two@example.com",
				refreshToken: "refresh-token-2",
				addedAt: 2,
				lastUsed: 2,
				enabled: false,
			},
		],
	};
}

function createStatusDeps(
	overrides: Partial<StatusCommandDeps> = {},
): StatusCommandDeps {
	return {
		setStoragePath: vi.fn(),
		getStoragePath: vi.fn(() => "/tmp/codex.json"),
		loadAccounts: vi.fn(async () => createStorage()),
		resolveActiveIndex: vi.fn(() => 0),
		formatRateLimitEntry: vi.fn(() => null),
		inspectStorageHealth: vi.fn(async (): Promise<StorageHealthSummary> => ({
			state: "healthy",
			path: "/tmp/codex.json",
			resetMarkerPath: "/tmp/codex.json.intentional-reset",
			walPath: "/tmp/codex.json.wal",
			hasResetMarker: false,
			hasWal: false,
		})),
		getNow: vi.fn(() => 2_000),
		logInfo: vi.fn(),
		...overrides,
	};
}

function createRuntimeSnapshot(
	overrides: Partial<RuntimeObservabilitySnapshot> = {},
): RuntimeObservabilitySnapshot {
	return {
		version: 1,
		updatedAt: 2_000,
		currentRequestId: null,
		responsesRequests: 3,
		authRefreshRequests: 1,
		diagnosticProbeRequests: 0,
		poolExhaustionCooldownUntil: null,
		serverBurstCooldownUntil: null,
		runtimeMetrics: {
			startedAt: 1_000,
			totalRequests: 3,
			successfulRequests: 3,
			failedRequests: 0,
			responsesRequests: 3,
			authRefreshRequests: 1,
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
			cumulativeLatencyMs: 30,
			lastRequestAt: 1_999,
			lastError: null,
		},
		...overrides,
	};
}

describe("runStatusCommand", () => {
	it("prints a compact actionable summary without account emails", async () => {
		const logInfo = vi.fn();
		const deps = createStatusDeps({ compact: true, locale: "zh", logInfo });
		await runStatusCommand(deps);
		const output = logInfo.mock.calls.flat().join("\n");
		expect(output).toContain("Codex Multi-Auth 状态");
		expect(output).toContain("账号");
		expect(output).toContain("可用");
		expect(output).not.toContain("one@example.com");
		expect(output).toContain("--details");
	});

	it("lists API/ZDR accounts in compact view instead of hiding them", async () => {
		const logInfo = vi.fn();
		const deps = createStatusDeps({
			compact: true,
			locale: "en",
			logInfo,
			loadApiRoutes: async () => [
				{ id: "route-1", kind: "api" as const, label: "Team API", enabled: true, priority: 1, visibleModels: ["gpt-5"], apiKey: "sk-hidden" },
				{ id: "route-2", kind: "zdr" as const, label: "ZDR pool", enabled: false, priority: 2, visibleModels: [], apiKey: "sk-hidden-2" },
			],
		});
		await runStatusCommand(deps);
		const output = logInfo.mock.calls.flat().join("\n");
		expect(output).toContain("API/ZDR/PSP accounts");
		expect(output).toContain("Team API");
		expect(output).toContain("ZDR pool");
		expect(output).toContain("1 enabled / 1 disabled");
		expect(output).not.toContain("sk-hidden");
	});

	it("counts blocked accounts separately from ready in compact view", async () => {
		const logInfo = vi.fn();
		const deps = createStatusDeps({
			compact: true,
			locale: "en",
			logInfo,
			loadQuotaCache: async () => ({
				byEmail: {
					"one@example.com": {
						updatedAt: 2_000,
						status: 200,
						model: "fixture",
						planType: "plus",
						primary: { usedPercent: 100, resetAtMs: 500_000, windowMinutes: 300 },
						secondary: { usedPercent: 20, resetAtMs: 500_000, windowMinutes: 10_080 },
					},
				},
				byAccountId: {},
			}),
		});
		await runStatusCommand(deps);
		const output = logInfo.mock.calls.flat().join("\n");
		expect(output).toContain("blocked");
		expect(output).not.toContain("2 ready");
	});

	it("derives compact quota labels from windowMinutes instead of fixed 5h/7d", async () => {
		const logInfo = vi.fn();
		const deps = createStatusDeps({
			compact: true,
			locale: "en",
			logInfo,
			loadQuotaCache: async () => ({
				byEmail: {
					"one@example.com": {
						updatedAt: 2_000,
						status: 200,
						model: "fixture",
						planType: "plus",
						primary: { usedPercent: 40, resetAtMs: 500_000, windowMinutes: 60 },
						secondary: { usedPercent: 10, resetAtMs: 500_000, windowMinutes: 2_880 },
					},
				},
				byAccountId: {},
			}),
		});
		await runStatusCommand(deps);
		const output = logInfo.mock.calls.flat().join("\n");
		expect(output).toContain("1h");
		expect(output).toContain("2d");
		expect(output).not.toContain("5h");
		expect(output).not.toContain("7d");
	});

	it("includes runtime:null in the zero-account JSON shape", async () => {
		const logInfo = vi.fn();
		await runStatusCommand(createStatusDeps({
			json: true,
			logInfo,
			loadAccounts: vi.fn(async () => null),
		}));
		const parsed = JSON.parse(logInfo.mock.calls.flat().join(""));
		expect(parsed.runtime).toBeNull();
		expect(parsed.accounts).toEqual([]);
		expect(parsed.lastWebsocketDisconnect).toBeNull();
	});

	it("renders the Chinese detailed disconnect line localized", async () => {
		const logInfo = vi.fn();
		await runStatusCommand(createStatusDeps({
			locale: "zh",
			logInfo,
			loadAppBindStatus: async () => ({
				state: null,
				pid: null,
				baseUrl: null,
				totalRequests: null,
				lastAccountIndex: null,
				lastAccountLabel: null,
				lastAccountEmail: null,
				lastAccountId: null,
				updatedAt: null,
				lastError: null,
				nativeOpenai: false,
				lastWebsocketDisconnect: {
					at: 1_900,
					cause: "transport_error",
					stage: "awaiting_first_event",
					closeCode: 1006,
					routeKind: "oauth",
					connectionAgeMs: 5_000,
					eventCount: 2,
				},
			}),
		}));
		const output = logInfo.mock.calls.flat().join("\n");
		expect(output).toContain("上次 WebSocket 断开");
		expect(output).toContain("；原因=transport_error");
		expect(output).not.toContain("Last WebSocket disconnect");
	});

	it("renders the detailed Chinese view with localized labels and quota bars", async () => {
		const logInfo = vi.fn();
		const deps = createStatusDeps({
			locale: "zh",
			logInfo,
			loadAccountPolicies: async () => ({ version: 1, accounts: {} }),
			loadQuotaCache: async () => ({
				byEmail: {
					"one@example.com": {
						updatedAt: 2_000,
						status: 200,
						model: "fixture",
						planType: "plus",
						primary: { usedPercent: 97, resetAtMs: 100_000, windowMinutes: 300 },
						secondary: { usedPercent: 15, resetAtMs: 100_000, windowMinutes: 10_080 },
					},
				},
				byAccountId: {},
			}),
			loadRuntimeObservabilitySnapshot: async () => createRuntimeSnapshot(),
		});

		await runStatusCommand(deps);
		const output = logInfo.mock.calls.flat().join("\n");
		expect(output).toContain("账号");
		expect(output).toContain("配额：");
		expect(output).toContain("5小时 [");
		expect(output).toContain("已用 97% · 剩余 3%");
		expect(output).toContain("████");
		expect(output).toContain("预测风险");
		expect(output).not.toContain("Runtime:");
		expect(output).not.toContain("quota:");
		expect(output).not.toContain("forecast risk:");
		expect(output).not.toContain("Auto-prime");
	});

	it("separates saved workspace selection from the last outgoing request scope", async () => {
		const storage = createStorage();
		storage.accounts[0]!.accountId = "stored-org";
		storage.accounts[0]!.workspaces = [
			{id:"subscription-id", name:"Subscription", enabled:true},
			{id:"stored-org", name:"Business", enabled:true},
		];
		storage.accounts[0]!.currentWorkspaceIndex = 1;
		const deps = createStatusDeps({
			loadAccounts: async () => storage,
			loadAppHelperStatus: () => ({source:"app-helper",lastAccountIndex:1,lastAccountUpdatedAt:2_000}),
			loadRuntimeObservabilitySnapshot: async () => createRuntimeSnapshot({
				lastAccountIndex:0, lastAccountId:"stored-org", lastAccountUpdatedAt:1_999,
				lastRequestedWorkspaceId:"subscription-id",
			}),
		});
		await runStatusCommand(deps);
		const output = vi.mocked(deps.logInfo!).mock.calls.flat().join("\n");
		expect(output).toContain("Business] id:ed-org (saved selection)");
		expect(output).not.toContain("(active)");
		expect(output).toContain("Last requested workspace: account 1 / Subscription");
	});

	it("does not infer an outgoing workspace from a saved selection", async () => {
		const deps=createStatusDeps({loadRuntimeObservabilitySnapshot: async()=>createRuntimeSnapshot({lastAccountIndex:0,lastAccountUpdatedAt:1_999})});
		await runStatusCommand(deps);
		expect(vi.mocked(deps.logInfo!).mock.calls.flat().join("\n")).toContain("Last requested workspace: not recorded");
	});
	it("prints empty storage state", async () => {
		const deps = createStatusDeps({ loadAccounts: vi.fn(async () => null) });

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(deps.getStoragePath).toHaveBeenCalledTimes(1);
		expect(deps.logInfo).toHaveBeenCalledWith("No accounts configured.");
		expect(deps.logInfo).toHaveBeenCalledWith("Storage: /tmp/codex.json");
		expect(deps.logInfo).toHaveBeenCalledWith("Storage health: healthy");
	});

	it("localizes empty detailed status output", async () => {
		const logInfo = vi.fn();
		await runStatusCommand(createStatusDeps({
			locale: "zh",
			logInfo,
			loadAccounts: vi.fn(async () => null),
		}));
		const output = logInfo.mock.calls.flat().join("\n");
		expect(output).toContain("未配置账号");
		expect(output).toContain("存储健康：正常");
		expect(output).not.toContain("No accounts configured");
		expect(output).not.toContain("Storage health:");
	});

	it("prints intentional reset state from empty storage metadata", async () => {
		const deps = createStatusDeps({
			loadAccounts: vi.fn(async () => ({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: {},
				accounts: [],
				restoreReason: "intentional-reset",
			})),
		});

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"No accounts configured. Storage was intentionally reset.",
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			"Storage health: intentional-reset",
		);
	});

	it.each([
		["empty-storage" as const, "empty"],
		["missing-storage" as const, "empty"],
	])("maps restore reason %s to empty storage health", async (restoreReason, health) => {
		const deps = createStatusDeps({
			inspectStorageHealth: undefined,
			loadAccounts: vi.fn(async () => ({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: {},
				accounts: [],
				restoreReason,
			})),
		});

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith("No accounts configured.");
		expect(deps.logInfo).toHaveBeenCalledWith(`Storage health: ${health}`);
	});

	it("prints explicit corrupt storage state for empty result cases", async () => {
		const deps = createStatusDeps({
			loadAccounts: vi.fn(async () => null),
			inspectStorageHealth: vi.fn(async () => ({
				state: "corrupt",
				path: "/tmp/codex.json",
				resetMarkerPath: "/tmp/codex.json.intentional-reset",
				walPath: "/tmp/codex.json.wal",
				hasResetMarker: false,
				hasWal: false,
				details: "Unexpected token",
			})),
		});

		await runStatusCommand(deps);

		expect(deps.logInfo).toHaveBeenCalledWith(
			"No accounts configured. Storage appears corrupted.",
		);
		expect(deps.logInfo).toHaveBeenCalledWith("Storage health: corrupt");
	});

	it("prints account rows with current and disabled markers", async () => {
		const deps = createStatusDeps({
			formatRateLimitEntry: vi.fn((_account, _now, _family) => "limited"),
		});

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(deps.getStoragePath).toHaveBeenCalledTimes(1);
		expect(deps.logInfo).toHaveBeenCalledWith("Accounts (2)");
		expect(deps.logInfo).toHaveBeenCalledWith("Storage: /tmp/codex.json");
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("Forecast suggestion: account 1"),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				"1. Account 1 (one@example.com) [current, rate-limited]",
			),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("reason:"),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				"2. Account 2 (two@example.com) [disabled, rate-limited]",
			),
		);
	});

	it("surfaces the persisted token invalidation marker", async () => {
		const deps = createStatusDeps({
			loadAccounts: vi.fn(async () => ({
				...createStorage(),
				accounts: [
					{
						...createStorage().accounts[0],
						authInvalidatedAt: 1_000,
						authInvalidationErrorCode: "token_invalidated",
					},
				],
			})),
		});

		await runStatusCommand(deps);

		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(AUTH_INVALIDATION_MARKER),
		);
	});

	it("prints the last rotated runtime account when observability has it", async () => {
		const deps = createStatusDeps({
			loadRuntimeObservabilitySnapshot: vi.fn(async () =>
				createRuntimeSnapshot({
					lastAccountIndex: 1,
					lastAccountLabel: "Account 2 (two@example.com, id:acct_2)",
					lastAccountEmail: "two@example.com",
					lastAccountId: "acct_2",
					lastAccountUpdatedAt: 1_999,
				}),
			),
		});

		await runStatusCommand(deps);

		expect(deps.logInfo).toHaveBeenCalledWith(
			"Last runtime account: Account 2 (acct_2)",
		);
	});

	it("marks runtime in-use separately from stored selected in account rows", async () => {
		const deps = createStatusDeps({
			loadAccounts: vi.fn(async () => ({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "selected@example.com",
						accountId: "acc_selected",
						refreshToken: "refresh-selected",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						email: "runtime@example.com",
						accountId: "acc_runtime",
						refreshToken: "refresh-runtime",
						addedAt: 2,
						lastUsed: 2,
					},
				],
			})),
			loadRuntimeObservabilitySnapshot: vi.fn(async () =>
				createRuntimeSnapshot({
					lastAccountIndex: 1,
					lastAccountId: "acc_runtime",
					lastAccountLabel: "Account 2",
					lastAccountUpdatedAt: 1_999,
				}),
			),
		});

		await runStatusCommand(deps);

		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				"1. Account 1 (selected@example.com, id:lected) [selected]",
			),
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				"2. Account 2 (runtime@example.com, id:untime) [in-use]",
			),
		);
	});

	it("uses live app-helper account signal when persisted runtime snapshot is absent", async () => {
		const deps = createStatusDeps({
			loadAccounts: vi.fn(async () => ({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "selected@example.com",
						accountId: "acc_selected",
						refreshToken: "refresh-selected",
					},
					{
						email: "helper@example.com",
						accountId: "acc_helper",
						refreshToken: "refresh-helper",
					},
				],
			})),
			loadRuntimeObservabilitySnapshot: vi.fn(async () => null),
			loadAppHelperStatus: vi.fn(() => ({
				source: "app-helper",
				lastAccountIndex: 1,
				lastAccountId: "acc_helper",
				lastAccountLabel: "Account 2",
				lastAccountUpdatedAt: 1_999,
				updatedAt: 1_999,
			})),
		});

		await runStatusCommand(deps);

		expect(deps.logInfo).toHaveBeenCalledWith(
			"Runtime in use: account 2 (app-helper)",
		);
		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				"2. Account 2 (helper@example.com, id:helper) [in-use]",
			),
		);
	});

	it("marks cached zero quota as exhausted instead of ok", async () => {
		const deps = createStatusDeps({
			loadQuotaCache: vi.fn(async () => ({
				byAccountId: {},
				byEmail: {
					"one@example.com": {
						updatedAt: 2_000,
						status: 200,
						model: "gpt-5-codex",
						primary: {
							usedPercent: 100,
							windowMinutes: 300,
							resetAtMs: 3_000,
						},
						secondary: {
							usedPercent: 100,
							windowMinutes: 10080,
							resetAtMs: 4_000,
						},
					},
				},
			})),
		});

		await runStatusCommand(deps);

		expect(deps.logInfo).toHaveBeenCalledWith(
			expect.stringContaining("1. Account 1 (one@example.com) [current, quota-exhausted]"),
		);
	});

	// cli-manager-03: status/list support --json (single machine-readable object).
	it("emits a single JSON object when json is set", async () => {
		const logInfo = vi.fn();
		const deps = createStatusDeps({ json: true, logInfo });

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(logInfo).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(String(logInfo.mock.calls[0]?.[0]));
		expect(payload.accountCount).toBe(2);
		expect(payload.storagePath).toBe("/tmp/codex.json");
		expect(Array.isArray(payload.accounts)).toBe(true);
		expect(payload.accounts[0]).toMatchObject({ index: 0, current: true });
	});

	it("emits JSON for empty storage when json is set", async () => {
		const logInfo = vi.fn();
		const deps = createStatusDeps({
			json: true,
			logInfo,
			loadAccounts: vi.fn(async () => null),
		});

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(logInfo).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(String(logInfo.mock.calls[0]?.[0]));
		expect(payload.accountCount).toBe(0);
		expect(payload.accounts).toEqual([]);
		// cli-manager-03: the empty-storage shape emits the same keys as the
		// populated one (null) so a --json consumer sees one stable shape.
		expect(payload).toMatchObject({
			activeIndex: null,
			pinnedAccountIndex: null,
			recommendedIndex: null,
			recommendationReason: null,
			runtimeInUseIndex: null,
		});
	});
});

// cli-manager-03 (plumbing): the runStatusCommand tests above prove behavior once
// `json` is already true. This block exercises the CLI arg → json-flag mapping in
// runCodexMultiAuthCli ("status"/"list" with -j/--json), which a wrapper-routing
// regression would otherwise leave uncovered. Runs against the global test
// sandbox (no real ~/.codex), so storage is empty and the JSON object is the
// empty-storage shape.
describe("runCodexMultiAuthCli status/list --json plumbing", () => {
	for (const args of [["status", "-j"], ["status", "--json"], ["list", "-j"], ["list", "--json"]]) {
		it(`maps ${args.join(" ")} to a single JSON object`, async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
			try {
				const code = await runCodexMultiAuthCli(args);
				expect(code).toBe(0);
				// Exactly one machine-readable line emitted.
				expect(logSpy).toHaveBeenCalledTimes(1);
				const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
				expect(typeof payload.accountCount).toBe("number");
				expect(Array.isArray(payload.accounts)).toBe(true);
			} finally {
				logSpy.mockRestore();
			}
		});
	}
});

// cli-manager-03: the `auth list` / `auth status` wrapper form must map -j/--json
// the same way the bare `status`/`list` form does (codex-manager.ts:3547). A
// wrapper-routing regression would otherwise leave the auth-prefixed path
// emitting text instead of the machine-readable object.
describe("runCodexMultiAuthCli auth list/status --json plumbing", () => {
	for (const args of [
		["auth", "list", "-j"],
		["auth", "list", "--json"],
		["auth", "status", "-j"],
		["auth", "status", "--json"],
	]) {
		it(`maps ${args.join(" ")} to a single JSON object`, async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
			try {
				const code = await runCodexMultiAuthCli(args);
				expect(code).toBe(0);
				expect(logSpy).toHaveBeenCalledTimes(1);
				const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
				expect(typeof payload.accountCount).toBe("number");
				expect(Array.isArray(payload.accounts)).toBe(true);
			} finally {
				logSpy.mockRestore();
			}
		});
	}
});

describe("runFeaturesCommand", () => {
	it("prints the implemented feature list", () => {
		const deps: FeaturesCommandDeps = {
			implementedFeatures: [
				{ id: 1, name: "Alpha" },
				{ id: 2, name: "Beta" },
			],
			logInfo: vi.fn(),
		};

		const result = runFeaturesCommand(deps);

		expect(result).toBe(0);
		expect(deps.logInfo).toHaveBeenCalledWith("Implemented features (2)");
		expect(deps.logInfo).toHaveBeenCalledWith("1. Alpha");
		expect(deps.logInfo).toHaveBeenCalledWith("2. Beta");
	});
});

it("reports inference timestamps independently from old account activity",async()=>{
 const {inferenceAccountKey}=await import("../lib/runtime/inference-activity.js");
 const storage=createStorage();
 const deps=createStatusDeps({loadRuntimeObservabilitySnapshot:async()=>createRuntimeSnapshot({lastInferenceRequestAtByAccount:{[inferenceAccountKey(storage.accounts[0]!)]:1500}})});
 await runStatusCommand(deps);
 expect(deps.logInfo).toHaveBeenCalledWith(expect.stringContaining("last inference request 0s ago"));
 expect(deps.logInfo).toHaveBeenCalledWith(expect.stringContaining("inference not yet recorded; account activity"));
 const jsonDeps=createStatusDeps({...deps,json:true,logInfo:vi.fn()});await runStatusCommand(jsonDeps);
 const body=JSON.parse(vi.mocked(jsonDeps.logInfo!).mock.calls[0]![0]);
 expect(body.accounts[0].lastInferenceRequestAt).toBe(1500);
 expect(body.accounts[0].lastUsed).toBe(1);
});

it.each([true,false])("lists API/ZDR credentials with priority without exposing keys (subscription present: %s)",async subscriptions=>{
 const routes=[{id:"fixture-api",label:"API fixture",kind:"api" as const,apiKey:"never-show-this-secret",enabled:true,priority:2,visibleModels:["fixture-model"]},{id:"fixture-zdr",label:"ZDR fixture",kind:"zdr" as const,apiKey:"other-private-secret",enabled:false,priority:0,visibleModels:[]}];
 const deps=createStatusDeps({loadAccounts:async()=>subscriptions?createStorage():null,loadApiRoutes:async()=>routes});
 await runStatusCommand(deps);
 const output=vi.mocked(deps.logInfo!).mock.calls.flat().join("\n");
 expect(output).toContain("API account 1: API fixture");expect(output).toContain("priority tier: 2");expect(output).toContain("ZDR account 2: ZDR fixture [disabled]");
 expect(output).not.toContain("secret");
 const jsonDeps={...deps,json:true,logInfo:vi.fn()};await runStatusCommand(jsonDeps);
 const value=JSON.parse(jsonDeps.logInfo.mock.calls[0]![0]);
 expect(value.apiAccounts).toHaveLength(2);expect(value.apiAccounts[0].priority).toBe(2);expect(value.apiAccounts[1].kind).toBe("zdr");
 expect(JSON.stringify(value)).not.toContain("secret");
});

it("distinguishes configured priority tiers from forecast scores", async () => {
 const logInfo=vi.fn();
 await runStatusCommand(createStatusDeps({logInfo,loadAccountPolicies:async()=>({version:1,accounts:{}})}));
 const output=logInfo.mock.calls.flat().join("\n");
 expect(output).toContain("priority tier: 1");
 expect(output).toContain("forecast risk:");
 expect(output).toContain("lower is better");
});

it("colors status headings but keeps forced-color JSON clean", async () => {
 const {setUiRuntimeOptions,resetUiRuntimeOptions}=await import("../lib/ui/runtime.js");
 const {stripVTControlCharacters}=await import("node:util");
 vi.stubEnv("FORCE_COLOR","1");setUiRuntimeOptions({});
 try {
  const logInfo=vi.fn();
  const deps=createStatusDeps({logInfo,loadAccountPolicies:async()=>({version:1,accounts:{}})});
  await runStatusCommand(deps);
  const colored=logInfo.mock.calls.flat().join("\n");
  expect(colored).toContain("\x1b[");
  logInfo.mockClear();vi.stubEnv("FORCE_COLOR","0");
  await runStatusCommand(deps);
  expect(stripVTControlCharacters(colored)).toBe(logInfo.mock.calls.flat().join("\n"));
  logInfo.mockClear();vi.stubEnv("FORCE_COLOR","1");
  await runStatusCommand({...deps,json:true});
  const json=logInfo.mock.calls.flat().join("\n");
  expect(json).not.toContain("\x1b");
  expect(JSON.parse(json).accounts[0]).toHaveProperty("forecastRiskScore");
 } finally {vi.unstubAllEnvs();resetUiRuntimeOptions();}
});

it("reports a native pin as strict, with no fallback order, separately from the configured tier", async () => {
 const logInfo=vi.fn();
 const storage={...createStorage(),pinnedAccountIndex:0};
 storage.accounts=[storage.accounts[0]!,{...storage.accounts[0]!,accountId:"fixture-other",email:"other@example.com",refreshToken:"fixture-other-refresh"}];
 const deps=createStatusDeps({logInfo,loadAccounts:async()=>storage,loadAppBindStatus:async()=>({nativeOpenai:true,state:"running",pid:123,baseUrl:null,totalRequests:0,lastAccountIndex:null,lastAccountLabel:null,lastAccountEmail:null,lastAccountId:null,updatedAt:2000,lastError:null})});
 await runStatusCommand(deps);
 const text=logInfo.mock.calls.flat().join("\n");
 expect(text).toContain("Pinned: account 1 (strict; set by switch)");
 expect(text).not.toMatch(/fallback/);
 expect(text).toContain("priority tier: 1");
 expect(text).not.toMatch(/automatic order: #2/);
 logInfo.mockClear();await runStatusCommand({...deps,json:true});
 const accounts=JSON.parse(logInfo.mock.calls[0]![0]).accounts;
 expect(accounts[0].selectionPreference).toBe("strict-pin");
 expect(accounts[1].automaticOrder).toBeNull();
});

it("includes cached quota pressure in status risk without changing configured tiers", async () => {
 const accounts=Array.from({length:3},(_,index)=>({accountId:`fixture-${index}`,refreshToken:`fixture-refresh-${index}`,addedAt:1,lastUsed:1}));
 const entries=Object.fromEntries([65,95,95].map((used,index)=>[`fixture-${index}`,{updatedAt:1000,status:200,model:"fixture-model",primary:{},secondary:{usedPercent:used,resetAtMs:100000,windowMinutes:10080}}]));
 const logInfo=vi.fn();
 const deps=createStatusDeps({logInfo,json:true,loadAccounts:async()=>({version:3,activeIndex:2,accounts}),resolveActiveIndex:()=>2,loadAccountPolicies:async()=>({version:1,accounts:{}}),loadQuotaCache:async()=>({byAccountId:entries,byEmail:{}})});
 await runStatusCommand(deps);
 const result=JSON.parse(logInfo.mock.calls[0]![0]);
 expect(result.accounts.map((a:{forecastRiskScore:number})=>a.forecastRiskScore)).toEqual([0,35,30]);
 expect(result.accounts.map((a:{priority:number})=>a.priority)).toEqual([1,1,1]);
 expect(result.accounts[1].forecastQuotaUpdatedAt).toBe(1000);
 logInfo.mockClear();await runStatusCommand({...deps,json:false});
 expect(logInfo.mock.calls.flat().join("\n")).toContain("cached quota 1s ago");
});

it("does not score expired quota windows and identifies missing quota inputs", async () => {
 const logInfo=vi.fn();
 await runStatusCommand(createStatusDeps({logInfo,loadQuotaCache:async()=>({byAccountId:{},byEmail:{"one@example.com":{updatedAt:1000,status:200,model:"fixture-model",primary:{usedPercent:99,resetAtMs:1500},secondary:{}}}})}));
 const output=logInfo.mock.calls.flat().join("\n");
 expect(output).toContain("quota unknown; run check");
 expect(output).not.toContain("primary quota 99% used");
});

it("shows reset-aware subscription order separately from configured tiers and marks the five percent reserve",async()=>{
 const now=2000;
 const accounts=Array.from({length:3},(_,i)=>({accountId:`rank-${i}`,refreshToken:`fixture-${i}`,addedAt:1,lastUsed:1}));
 const cache={byEmail:{},byAccountId:Object.fromEntries([[20,24],[40,2],[5,1]].map(([left,hours],i)=>[`rank-${i}`,{updatedAt:now,status:200,model:"fixture",planType:"pro",primary:{},secondary:{usedPercent:100-left!,resetAtMs:now+hours!*3600000}}]))};
 const logInfo=vi.fn();
 const deps=createStatusDeps({logInfo,json:true,loadAccounts:async()=>({version:3,activeIndex:0,accounts}),loadQuotaCache:async()=>cache,loadAccountPolicies:async()=>({version:1,accounts:{}}),loadAppBindStatus:async()=>({nativeOpenai:true,state:"running",pid:123,baseUrl:null,totalRequests:0,lastAccountIndex:null,lastAccountLabel:null,lastAccountEmail:null,lastAccountId:null,updatedAt:now,lastError:null})});
 await runStatusCommand(deps);
 const result=JSON.parse(logInfo.mock.calls[0]![0]);
 expect(result.accounts.map((a:{automaticOrder:number})=>a.automaticOrder)).toEqual([2,1,3]);
 expect(result.accounts[2].subscriptionReserve).toBe(true);
 logInfo.mockClear();await runStatusCommand({...deps,json:false});
 expect(logInfo.mock.calls.flat().join("\n")).toContain("automatic order: #1");
 expect(logInfo.mock.calls.flat().join("\n")).toContain("5% reserve");
});

it.each([
 ["saved order", "sequential", [0, 0, 1], [1, 2, 3], 90, undefined],
 ["active cursor", "sequential", [1, 1, 1], [2, 3, 1], 90, undefined],
 ["quota order", "hybrid", [0, 0, 1], [2, 1, 3], 90, undefined],
 ["reserve fallback", "sequential", [0, 0, 1], [3, 1, 2], 5, undefined],
 ["running sequential order", "hybrid", [0, 0, 1], [1, 2, 3], 90, "sequential"],
 ["running hybrid order", "sequential", [0, 0, 1], [2, 1, 3], 90, "hybrid"],
] as const)("reports %s consistently in native status JSON and text", async (_name, strategy, priorities, expected, firstRemaining, reportedStrategy) => {
 vi.stubEnv("CODEX_AUTH_SCHEDULING_STRATEGY", strategy);
 try {
  const now = 2000;
  const accounts = Array.from({length:3}, (_,index) => ({accountId:`order-${index}`,refreshToken:`fixture-${index}`,addedAt:1,lastUsed:1}));
  const policies = Object.fromEntries(accounts.map((account,index) => {
   const key = getAccountPolicyKey(account,index);
   return [key,{accountKey:key,tags:[],weight:1,priority:priorities[index] ?? 1,autoPrime:false,paused:false,drained:false,note:null,updatedAt:now}];
  }));
  const quota = Object.fromEntries([[firstRemaining,5],[50,1],[90,10]].map(([remaining,hours],index) => [`order-${index}`,{updatedAt:now,status:200,model:"fixture",planType:"pro",primary:{usedPercent:100-remaining!,resetAtMs:now+hours!*3600000},secondary:{}}]));
  const logInfo = vi.fn();
  const deps = createStatusDeps({
   logInfo,json:true,resolveActiveIndex:()=>2,
   loadAccounts:async()=>({version:3,activeIndex:2,activeIndexByFamily:{codex:2},accounts}),
   loadAccountPolicies:async()=>({version:1,accounts:policies}),
   loadQuotaCache:async()=>({byEmail:{},byAccountId:quota}),
   loadAppBindStatus:async()=>({nativeOpenai:true,schedulingStrategy:reportedStrategy,state:"running",pid:123,baseUrl:null,totalRequests:0,lastAccountIndex:null,lastAccountLabel:null,lastAccountEmail:null,lastAccountId:null,updatedAt:now,lastError:null}),
  });
  await runStatusCommand(deps);
  const result = JSON.parse(logInfo.mock.calls[0]![0]);
  expect(result.accounts.map((account:{automaticOrder:number})=>account.automaticOrder)).toEqual(expected);
  logInfo.mockClear();
  await runStatusCommand({...deps,json:false});
  const lines = logInfo.mock.calls.map(call=>String(call[0]));
  for (let index=0;index<accounts.length;index++) {
   const row = lines.findIndex(line=>line.includes(`${index+1}. Account ${index+1}`));
   expect(row).toBeGreaterThanOrEqual(0);
   expect(lines.slice(row+1).find(line=>line.includes("automatic order:"))).toContain(`#${expected[index]}`);
  }
 } finally {vi.unstubAllEnvs();}
});

it("shows cached reset counts for the saved workspace and distinguishes unknown",async()=>{
 const storage=createStorage();storage.accounts[0]!.accountId="workspace";
 const target=resetTargetForStoredAccount(storage.accounts[0]!)!;
 const deps=createStatusDeps({loadAccounts:async()=>storage,json:true,loadResetCreditState:async()=>({version:1,policy:"manual",snapshots:{[target.key]:{updatedAt:1000,availableCount:3,ordinaryUsageAllowed:false,planType:"pro",primary:{},secondary:{}}}})});
 await runStatusCommand(deps);const output=JSON.parse(vi.mocked(deps.logInfo!).mock.calls[0]![0]);expect(output.accounts[0].resetCreditsAvailable).toBe(3);expect(output.accounts[0].resetCreditsCheckedAt).toBe(1000);expect(output.accounts[1].resetCreditsAvailable).toBeNull();
});

it("continues subscription status with a visible warning if API configuration cannot be read",async()=>{
 const deps=createStatusDeps({loadApiRoutes:async()=>{throw Error('fixture invalid config');}});
 expect(await runStatusCommand(deps)).toBe(0);
 expect(JSON.stringify(vi.mocked(deps.logInfo).mock.calls)).toMatch(/API.*unavailable/);
});
it("keeps status readable when an injected policy loader fails",async()=>{
 const deps=createStatusDeps({json:true,loadAccountPolicies:vi.fn().mockRejectedValue(Error("fixture permission"))});
 await expect(runStatusCommand(deps)).resolves.toBe(0);
 expect(JSON.parse(vi.mocked(deps.logInfo!).mock.calls.at(-1)![0]).accounts[0].priority).toBe(1);
});

it("uses scoped Personal quota in status JSON and text instead of stale organization quota", async () => {
 const { updateQuotaCacheForWorkspace } = await import("../lib/codex-manager/quota-cache-helpers.js");
 const accounts = [{ recordId: "fixture-record", accountId: "org", email: "fixture@example.test", refreshToken: "fixture", addedAt: 1, lastUsed: 1, workspaces: [{ id: "personal", enabled: true }] }];
 const old = { updatedAt: 1000, status: 429, model: "fixture", primary: { usedPercent: 100, resetAtMs: 100000 }, secondary: {} };
 const cache = { byAccountId: { org: old }, byEmail: { "fixture@example.test": old } };
 updateQuotaCacheForWorkspace(cache, accounts[0]!, "personal", { status: 200, model: "fixture", primary: { usedPercent: 10, resetAtMs: 100000 }, secondary: {} }, accounts);
 const logInfo=vi.fn();
 const deps=createStatusDeps({logInfo,json:true,loadAccounts:async()=>({version:3,activeIndex:0,accounts}),loadQuotaCache:async()=>cache});
 await runStatusCommand(deps);
 const result=JSON.parse(logInfo.mock.calls[0]![0]);
 expect(result.accounts[0].forecastRiskScore).toBe(0);
 logInfo.mockClear();await runStatusCommand({...deps,json:false});
 expect(logInfo.mock.calls.flat().join("\n")).not.toContain("quota-exhausted");
});

it.each([false,true])("shows selected-workspace plan and cached priming in status (json=%s)", async json => {
 const storage=createStorage(); const a=storage.accounts[0]!;
 a.accountId="org";a.workspaces=[{id:"personal",name:"Personal (role:owner)"}];
 const key=quotaWorkspaceKey(a,"personal")!;
 const deps=createStatusDeps({json,loadAccounts:async()=>storage,loadAccountPolicies:async()=>({version:1,accounts:{}}),loadQuotaCache:async()=>({byEmail:{},byAccountId:{org:{updatedAt:2000,status:200,model:"fixture",planType:"business",primary:{},secondary:{}}},byWorkspace:{[key]:{updatedAt:2000,status:200,model:"fixture",planType:"promax",primary:{usedPercent:0,windowMinutes:300,resetAtMs:602000},secondary:{windowMinutes:0}}}})});
 await runStatusCommand(deps);
 const out=vi.mocked(deps.logInfo!).mock.calls.map(c=>c[0]).join("\n");
 if(json) expect(JSON.parse(out).accounts[0].subscription).toMatchObject({planLabel:"Pro 500",selectedWorkspace:"Personal",primingState:"timer-running"});
 else expect(out).toContain("Personal · Pro 500 · Auto-prime OFF · Reset timer running");
});


it.each(["{broken", JSON.stringify({version:1,accounts:{"sha256:fixture":{autoPrime:"true"}}}), JSON.stringify({version:1,accounts:{"sha256:fixture":null}})])("reports auto-prime unknown when the real policy loader reads invalid policies: %s", async content => {
 const {promises:fs} = await import("node:fs");
 const {getAccountPolicyPath} = await import("../lib/account-policy.js");
 const read = fs.readFile.bind(fs);
 const spy = vi.spyOn(fs,"readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => String(args[0]) === getAccountPolicyPath() ? Promise.resolve(content) : read(...args));
 try {
  const deps = createStatusDeps({json:true});
  await expect(runStatusCommand(deps)).resolves.toBe(0);
  expect(JSON.parse(vi.mocked(deps.logInfo!).mock.calls.at(-1)![0]).accounts[0].subscription.autoPrime).toBeNull();
 } finally {spy.mockRestore();}
});

it.each(["subscriptions","api-only","empty"] as const)("shows historical WebSocket diagnostics in text and JSON for %s status",async(kind)=>{
 const diagnostic={at:1000,cause:"close" as const,stage:"streaming" as const,closeCode:1011};
 const bind={state:"running",pid:123,baseUrl:null,totalRequests:0,lastAccountIndex:null,lastAccountLabel:null,lastAccountEmail:null,lastAccountId:null,updatedAt:2000,lastError:null,lastWebsocketDisconnect:diagnostic};
 const overrides:Partial<StatusCommandDeps>={loadAccounts:async()=>kind==="subscriptions"?createStorage():null,loadAppBindStatus:async()=>bind,
 loadApiRoutes:async()=>kind==="api-only"?[{id:"fixture",label:"fixture",kind:"api",apiKey:"fixture-secret",enabled:true,priority:0,visibleModels:[]}]:[]};
 const text=vi.fn();await runStatusCommand(createStatusDeps({...overrides,logInfo:text}));
 const output=text.mock.calls.map(call=>call[0]).join("\n");
 expect(output).toContain("1970-01-01T00:00:01.000Z");expect(output).toContain("streaming");expect(output).toContain("1011");expect(output).toContain("close");
 const json=vi.fn();await runStatusCommand(createStatusDeps({...overrides,json:true,logInfo:json}));
 expect(JSON.parse(json.mock.calls[0]![0]).lastWebsocketDisconnect).toEqual(diagnostic);
});


it.each([
 { persistedState: "running", live: false },
 { persistedState: "stopped", live: false },
 { persistedState: "running", live: true },
])("CLI reads persisted disconnects without treating a dead router as active: $persistedState / live=$live", async ({persistedState, live}) => {
 const root = await mkdtemp(join(tmpdir(), "cma-status-disconnect-"));
 vi.stubEnv("CODEX_MULTI_AUTH_DIR", join(root, "multi-auth"));
 vi.stubEnv("CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME", join(root, "codex"));
 vi.spyOn(Date, "now").mockReturnValue(2_000);
 const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
 try {
  const paths = resolveAppBindPaths();
  expect(paths.bindDir.startsWith(root)).toBe(true);
  await mkdir(paths.bindDir, {recursive:true});
  await writeFile(paths.statePath, JSON.stringify({
   ...paths, version:1, platform:process.platform, host:"127.0.0.1", port:1234,
   baseUrl:"http://127.0.0.1:1234", nodePath:process.execPath,
   clientApiKey:"fixture-key", boundConfigHash:"fixture-hash", updatedAt:2_000, nativeOpenai:true,
  }));
  setStoragePath(null);
  const storagePath = getStoragePath();
  expect(storagePath.startsWith(root)).toBe(true);
  await mkdir(dirname(storagePath), {recursive:true});
  await writeFile(storagePath, JSON.stringify(createStorage()));
  const diagnostic = {at:1_000,cause:"close",stage:"streaming",closeCode:1011};
  const check = async (pid:number) => {
   await writeFile(paths.statusPath, JSON.stringify({
    state:persistedState, pid, updatedAt:2_000, lastAccountIndex:0,
    lastAccountEmail:"one@example.com", lastWebsocketDisconnect:diagnostic,
   }));
   expect((await getAppBindStatus()).running).toBe(live);
   expect(await runCodexMultiAuthCli(["status", "--json"])).toBe(0);
   const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
   expect(payload.accountCount).toBe(2);
   expect(payload.lastWebsocketDisconnect).toEqual(diagnostic);
   expect(payload.runtimeInUseIndex).toBe(live ? 0 : null);
   expect(payload.selectionMode).toBe(live ? "model-priority" : "legacy-pin");
   expect(payload.accounts[0].automaticOrder).toBe(live ? 1 : null);
   log.mockClear();
   expect(await runCodexMultiAuthCli(["status", "--details"])).toBe(0);
   const output = log.mock.calls.flat().join("\n");
   expect(output).toContain("1970-01-01T00:00:01.000Z");
   expect(output).toContain("streaming");
   expect(output).toContain("1011");
  };
  if (live) await check(process.pid);
  else await withDeadPid(check);
 } finally {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setStoragePath(null);
  await removeWithRetry(root, {recursive:true, force:true});
 }
});
