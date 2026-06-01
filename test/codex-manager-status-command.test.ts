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
	it("prints empty storage state", async () => {
		const deps = createStatusDeps({ loadAccounts: vi.fn(async () => null) });

		const result = await runStatusCommand(deps);

		expect(result).toBe(0);
		expect(deps.getStoragePath).toHaveBeenCalledTimes(1);
		expect(deps.logInfo).toHaveBeenCalledWith("No accounts configured.");
		expect(deps.logInfo).toHaveBeenCalledWith("Storage: /tmp/codex.json");
		expect(deps.logInfo).toHaveBeenCalledWith("Storage health: healthy");
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
			expect.stringContaining("Selection reason: account 1"),
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
