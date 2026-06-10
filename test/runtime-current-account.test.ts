import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appRuntimeHelperStatusToSignal,
	readAppRuntimeHelperStatus,
	resolveAccountCurrentMarkers,
	resolveRuntimeCurrentAccount,
} from "../lib/runtime/runtime-current-account.js";
import { APP_RUNTIME_HELPER_STATUS_FILE } from "../lib/runtime-constants.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

function createStorage(): AccountStorageV3 {
	return {
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
				email: "runtime@example.com",
				accountId: "acc_runtime",
				refreshToken: "refresh-runtime",
			},
		],
	};
}

function createRuntimeSnapshot(now: number, accountId: string, index: number) {
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

describe("resolveRuntimeCurrentAccount", () => {
	it("uses the freshest runtime source and matches by account id", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				runtimeSnapshot: {
					version: 1,
					updatedAt: now - 500,
					currentRequestId: null,
					responsesRequests: 1,
					authRefreshRequests: 0,
					diagnosticProbeRequests: 0,
					poolExhaustionCooldownUntil: null,
					serverBurstCooldownUntil: null,
					lastAccountIndex: 1,
					lastAccountId: "acc_runtime",
					lastAccountUpdatedAt: now - 500,
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
						lastRequestAt: now - 500,
						lastError: null,
					},
				},
				appBindStatus: {
					state: "running",
					pid: 123,
					baseUrl: "http://127.0.0.1:1234",
					totalRequests: 1,
					lastAccountIndex: 0,
					lastAccountLabel: "Account 1",
					lastAccountEmail: "selected@example.com",
					lastAccountId: "acc_selected",
					updatedAt: now - 1_000,
					lastError: null,
				},
			},
			{ now },
		);

		expect(result).toMatchObject({
			index: 1,
			source: "runtime-observability",
			matchedBy: "account-id",
		});
	});

	it("uses deterministic source precedence for equal timestamp signals", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				runtimeSnapshot: createRuntimeSnapshot(now, "acc_runtime", 1),
				appBindStatus: {
					state: "running",
					pid: 123,
					baseUrl: "http://127.0.0.1:1234",
					totalRequests: 1,
					lastAccountIndex: 0,
					lastAccountLabel: "Account 1",
					lastAccountEmail: "selected@example.com",
					lastAccountId: "acc_selected",
					updatedAt: now,
					lastError: null,
				},
			},
			{ now },
		);

		expect(result).toMatchObject({
			index: 1,
			source: "runtime-observability",
			matchedBy: "account-id",
		});
	});

	it("ignores stale runtime account signals", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				appBindStatus: {
					state: "running",
					pid: 123,
					baseUrl: "http://127.0.0.1:1234",
					totalRequests: 1,
					lastAccountIndex: 1,
					lastAccountLabel: "Account 2",
					lastAccountEmail: "runtime@example.com",
					lastAccountId: "acc_runtime",
					updatedAt: now - 5_000,
					lastError: null,
				},
			},
			{ now, maxAgeMs: 1_000 },
		);

		expect(result).toBeNull();
	});

	it("keeps live sessions current when heartbeat is newer than switch timestamp", () => {
		const now = 100_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				appHelperStatus: {
					source: "app-helper",
					lastAccountIndex: 1,
					lastAccountLabel: "Account 2",
					lastAccountEmail: "runtime@example.com",
					lastAccountId: "acc_runtime",
					lastAccountUpdatedAt: now - 25 * 60 * 60 * 1000,
					updatedAt: now,
				},
			},
			{ now },
		);

		expect(result).toMatchObject({
			index: 1,
			source: "app-helper",
			matchedBy: "account-id",
			updatedAt: now,
		});
	});

	it("does not accept ambiguous duplicate account-id matches", () => {
		const now = 10_000;
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "first@example.com",
					accountId: "acc_duplicate",
					refreshToken: "refresh-first",
				},
				{
					email: "second@example.com",
					accountId: "acc_duplicate",
					refreshToken: "refresh-second",
				},
			],
		};

		expect(
			resolveRuntimeCurrentAccount(
				storage,
				{
					appHelperStatus: {
						source: "app-helper",
						lastAccountId: "acc_duplicate",
						updatedAt: now,
					},
				},
				{ now },
			),
		).toBeNull();

		expect(
			resolveRuntimeCurrentAccount(
				storage,
				{
					appHelperStatus: {
						source: "app-helper",
						lastAccountId: "acc_duplicate",
						lastAccountEmail: "second@example.com",
						updatedAt: now,
					},
				},
				{ now },
			),
		).toMatchObject({
			index: 1,
			matchedBy: "email",
		});
	});

	it("ignores app-bind router status that is not running", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				appBindStatus: {
					state: "stopped",
					pid: 123,
					baseUrl: "http://127.0.0.1:1234",
					totalRequests: 1,
					lastAccountIndex: 1,
					lastAccountLabel: "Account 2",
					lastAccountEmail: "runtime@example.com",
					lastAccountId: "acc_runtime",
					updatedAt: now,
					lastError: null,
				},
			},
			{ now },
		);

		expect(result).toBeNull();
	});

	it("only turns a running live app helper status into a runtime signal", () => {
		const baseStatus = {
			kind: "codex-app-runtime-rotation-helper",
			state: "running",
			pid: process.pid,
			lastAccountIndex: 1,
			lastAccountLabel: "Account 2",
			lastAccountEmail: null,
			lastAccountId: "acc_runtime",
			lastAccountUpdatedAt: 10_000,
			updatedAt: 10_000,
		};

		expect(appRuntimeHelperStatusToSignal(baseStatus)).toMatchObject({
			source: "app-helper",
			lastAccountIndex: 1,
			lastAccountId: "acc_runtime",
		});
		expect(
			appRuntimeHelperStatusToSignal({
				...baseStatus,
				state: "idle-timeout",
			}),
		).toBeNull();
		expect(
			appRuntimeHelperStatusToSignal({
				...baseStatus,
				kind: "unrelated-process",
			}),
		).toBeNull();
	});

	it("labels stored selected and runtime in-use rows separately", () => {
		const runtimeCurrent = {
			index: 1,
			source: "runtime-observability" as const,
			matchedBy: "account-id" as const,
			updatedAt: 10_000,
		};

		expect(resolveAccountCurrentMarkers(0, 0, runtimeCurrent)).toEqual([
			"selected",
		]);
		expect(resolveAccountCurrentMarkers(1, 0, runtimeCurrent)).toEqual([
			"in-use",
		]);
		expect(resolveAccountCurrentMarkers(0, 0, null)).toEqual(["current"]);
	});

	it("falls back to the reported index when id and email are absent", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				appHelperStatus: {
					source: "app-helper",
					lastAccountIndex: 1,
					updatedAt: now,
				},
			},
			{ now },
		);

		expect(result).toEqual({
			index: 1,
			source: "app-helper",
			matchedBy: "index",
			updatedAt: now,
		});
	});

	it("truncates fractional indices and rejects negative or out-of-range ones", () => {
		const now = 10_000;
		const select = (lastAccountIndex: number) =>
			resolveRuntimeCurrentAccount(
				createStorage(),
				{
					appHelperStatus: {
						source: "app-helper",
						lastAccountIndex,
						updatedAt: now,
					},
				},
				{ now },
			);

		expect(select(1.9)).toMatchObject({ index: 1, matchedBy: "index" });
		expect(select(-1)).toBeNull();
		expect(select(2)).toBeNull();
		expect(select(Number.NaN)).toBeNull();
	});

	it("rejects an index fallback that contradicts the signal account id or email", () => {
		const now = 10_000;
		// Account 0 is acc_selected/selected@example.com; the signal claims an id
		// and email that exist nowhere in storage, so the index hint must not win.
		expect(
			resolveRuntimeCurrentAccount(
				createStorage(),
				{
					appHelperStatus: {
						source: "app-helper",
						lastAccountId: "acc_ghost",
						lastAccountIndex: 0,
						updatedAt: now,
					},
				},
				{ now },
			),
		).toBeNull();
		expect(
			resolveRuntimeCurrentAccount(
				createStorage(),
				{
					appHelperStatus: {
						source: "app-helper",
						lastAccountEmail: "ghost@example.com",
						lastAccountIndex: 0,
						updatedAt: now,
					},
				},
				{ now },
			),
		).toBeNull();
	});

	it("ignores whitespace-only ids and emails when matching by index", () => {
		const now = 10_000;
		const result = resolveRuntimeCurrentAccount(
			createStorage(),
			{
				appHelperStatus: {
					source: "app-helper",
					lastAccountId: "   ",
					lastAccountEmail: " ",
					lastAccountIndex: 0,
					updatedAt: now,
				},
			},
			{ now },
		);

		expect(result).toEqual({
			index: 0,
			source: "app-helper",
			matchedBy: "index",
			updatedAt: now,
		});
	});

});

describe("readAppRuntimeHelperStatus", () => {
	let tempDir: string;
	let originalDir: string | undefined;
	const statusFileName = APP_RUNTIME_HELPER_STATUS_FILE;

	beforeEach(async () => {
		originalDir = process.env.CODEX_MULTI_AUTH_DIR;
		tempDir = await fs.mkdtemp(join(tmpdir(), "codex-helper-status-"));
		process.env.CODEX_MULTI_AUTH_DIR = tempDir;
	});

	afterEach(async () => {
		if (originalDir === undefined) {
			delete process.env.CODEX_MULTI_AUTH_DIR;
		} else {
			process.env.CODEX_MULTI_AUTH_DIR = originalDir;
		}
		await removeWithRetry(tempDir, { recursive: true, force: true });
	});

	async function writeStatusFile(contents: string): Promise<void> {
		await fs.writeFile(join(tempDir, statusFileName), contents, "utf8");
	}

	it("returns null when the status file is missing", () => {
		expect(readAppRuntimeHelperStatus()).toBeNull();
	});

	it("returns null for malformed JSON and non-record payloads", async () => {
		await writeStatusFile("{nope");
		expect(readAppRuntimeHelperStatus()).toBeNull();

		await writeStatusFile('"running"');
		expect(readAppRuntimeHelperStatus()).toBeNull();

		await writeStatusFile("null");
		expect(readAppRuntimeHelperStatus()).toBeNull();
	});

	it("refuses status files larger than the 1 MB sanity cap", async () => {
		const status = {
			kind: "codex-app-runtime-rotation-helper",
			state: "running",
			pid: process.pid,
			padding: "x".repeat(1024 * 1024),
		};
		await writeStatusFile(JSON.stringify(status));
		expect(readAppRuntimeHelperStatus()).toBeNull();
	});

	it("normalizes field types, trimming strings and dropping wrong-typed values", async () => {
		await writeStatusFile(
			JSON.stringify({
				kind: "  codex-app-runtime-rotation-helper  ",
				state: "running",
				pid: 42,
				lastAccountIndex: 1,
				lastAccountLabel: "   ",
				lastAccountEmail: " user@example.com ",
				lastAccountId: 7,
				lastAccountUpdatedAt: "soon",
				updatedAt: 10_000,
			}),
		);
		expect(readAppRuntimeHelperStatus()).toEqual({
			kind: "codex-app-runtime-rotation-helper",
			state: "running",
			pid: 42,
			lastAccountIndex: 1,
			lastAccountLabel: null,
			lastAccountEmail: "user@example.com",
			lastAccountId: null,
			lastAccountUpdatedAt: null,
			updatedAt: 10_000,
		});
	});

	it("rejects a JSON array status file as not-a-record", async () => {
		// isRecord() excludes arrays: an `[]` helper-status file is malformed
		// content, not an all-null status object.
		await writeStatusFile("[]");
		expect(readAppRuntimeHelperStatus()).toBeNull();
	});
});
