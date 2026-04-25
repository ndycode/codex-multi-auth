import { describe, expect, it, vi } from "vitest";
import {
	type FeaturesCommandDeps,
	runFeaturesCommand,
	runStatusCommand,
	type StatusCommandDeps,
} from "../lib/codex-manager/commands/status.js";
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
