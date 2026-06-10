import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepairCommandDeps } from "../lib/codex-manager/repair-commands.js";
import { CodexUnavailableError } from "../lib/errors.js";
import {
	createCodexCliStateMocks,
	createCodexCliWriterMocks,
	createQuotaCacheMocks,
	createQuotaProbeMocks,
	createRefreshQueueMocks,
	createRuntimeObservabilityMocks,
	createStorageMocks,
	pickMocks,
	silenceConsole,
} from "./helpers/cli-test-fixtures.js";
// Note: do not statically import from ../lib/quota-probe.js here — it is mocked
// below via vi.mock and a top-level import would race the hoisted factory.
const CODEX_UNAVAILABLE_PROBE_NOTE = "Codex not available for this account";

const existsSyncMock = vi.fn();
const statMock = vi.fn();
const readFileMock = vi.fn();

const evaluateForecastAccountsMock = vi.fn(() => []);
const recommendForecastAccountMock = vi.fn(() => ({
	recommendedIndex: null,
	reason: "stay",
}));

const extractAccountEmailMock = vi.fn();
const extractAccountIdMock = vi.fn();
const formatAccountLabelMock = vi.fn(
	(account: { email?: string }, index: number) =>
		account.email ? `${index + 1}. ${account.email}` : `Account ${index + 1}`,
);
const sanitizeEmailMock = vi.fn((email: string | undefined) =>
	typeof email === "string" ? email.toLowerCase() : undefined,
);

// Shared mock groups (test/helpers/cli-test-fixtures.ts); the vi.mock
// factories below resolve the helper lazily so hoisting stays safe. Storage is
// narrowed to the exact set this suite used to override so every other
// storage export stays the actual implementation.
const quotaCacheMocks = createQuotaCacheMocks();
const quotaProbeMocks = createQuotaProbeMocks();
const refreshQueueMocks = createRefreshQueueMocks();
const storageMocks = pickMocks(createStorageMocks(), [
	"loadAccounts",
	"loadFlaggedAccounts",
	"setStoragePath",
	"getStoragePath",
	"withAccountStorageTransaction",
	"withAccountAndFlaggedStorageTransaction",
	"withFlaggedStorageTransaction",
]);
const codexCliStateMocks = createCodexCliStateMocks({
	authPath: "/mock/auth.json",
	configPath: "/mock/config.toml",
});
const codexCliWriterMocks = createCodexCliWriterMocks();
const runtimeObservabilityMocks = createRuntimeObservabilityMocks();

vi.mock("node:fs", () => ({
	existsSync: existsSyncMock,
	promises: {
		stat: statMock,
		readFile: readFileMock,
	},
}));

vi.mock("../lib/forecast.js", () => ({
	evaluateForecastAccounts: evaluateForecastAccountsMock,
	isHardRefreshFailure: vi.fn((result: { reason?: string }) => result.reason === "revoked"),
	recommendForecastAccount: recommendForecastAccountMock,
}));

vi.mock("../lib/accounts.js", () => ({
	extractAccountEmail: extractAccountEmailMock,
	extractAccountId: extractAccountIdMock,
	formatAccountLabel: formatAccountLabelMock,
	sanitizeEmail: sanitizeEmailMock,
}));

vi.mock("../lib/quota-cache.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).quotaCacheModuleMock(
		quotaCacheMocks,
	),
);

vi.mock("../lib/quota-probe.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).quotaProbeModuleMock({
		fetchCodexQuotaSnapshot: quotaProbeMocks.fetchCodexQuotaSnapshot,
	}),
);

vi.mock("../lib/refresh-queue.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).refreshQueueModuleMock(
		refreshQueueMocks,
	),
);

vi.mock("../lib/storage.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).storageModuleMock(
		storageMocks,
	),
);

vi.mock("../lib/codex-cli/state.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).codexCliStateModuleMock(
		codexCliStateMocks,
	),
);

vi.mock("../lib/codex-cli/writer.js", async () =>
	(await import("./helpers/cli-test-fixtures.js")).codexCliWriterModuleMock(
		codexCliWriterMocks,
	),
);

vi.mock("../lib/runtime/runtime-observability.js", async () =>
	(
		await import("./helpers/cli-test-fixtures.js")
	).runtimeObservabilityModuleMock(runtimeObservabilityMocks),
);

const {
	runDoctor,
	runFix,
	runVerifyFlagged,
	parseFixArgs,
} = await import("../lib/codex-manager/repair-commands.js");

function createDeps(
	overrides: Partial<RepairCommandDeps> = {},
): RepairCommandDeps {
	return {
		stylePromptText: (text) => text,
		styleAccountDetailText: (text) => text,
		formatResultSummary: (segments) => segments.map((segment) => segment.text).join(" | "),
		resolveActiveIndex: () => 0,
		hasUsableAccessToken: () => false,
		hasLikelyInvalidRefreshToken: () => false,
		normalizeFailureDetail: (message, reason) => message ?? reason ?? "unknown",
		buildQuotaEmailFallbackState: () => new Map(),
		updateQuotaCacheForAccount: () => false,
		cloneQuotaCacheData: (cache) => structuredClone(cache),
		pruneUnsafeQuotaEmailCacheEntry: () => false,
		formatCompactQuotaSnapshot: () => "snapshot-ok",
		resolveStoredAccountIdentity: (storedAccountId, storedAccountIdSource, refreshedAccountId) => ({
			accountId: refreshedAccountId ?? storedAccountId,
			accountIdSource: refreshedAccountId ? "token" : storedAccountIdSource,
		}),
		applyTokenAccountIdentity: () => false,
		...overrides,
	};
}

describe("repair-commands direct deps coverage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// clearAllMocks wipes call history but keeps mockImplementation, so the
		// transaction mocks set inline by individual tests must be reset here or
		// they bleed into later tests that rely on the default behavior.
		storageMocks.withAccountStorageTransaction.mockReset();
		storageMocks.withFlaggedStorageTransaction.mockReset();
		storageMocks.withAccountAndFlaggedStorageTransaction.mockReset();
		existsSyncMock.mockReturnValue(false);
		quotaCacheMocks.loadQuotaCache.mockResolvedValue(null);
		codexCliStateMocks.loadCodexCliState.mockResolvedValue(null);
		extractAccountEmailMock.mockReturnValue(undefined);
		extractAccountIdMock.mockReturnValue(undefined);
		runtimeObservabilityMocks.loadPersistedRuntimeObservabilitySnapshot.mockResolvedValue(null);
		evaluateForecastAccountsMock.mockImplementation(() => []);
		recommendForecastAccountMock.mockReturnValue({
			recommendedIndex: null,
			reason: "stay",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parseFixArgs rejects a flag-like value after --model instead of consuming it", () => {
		// "fix --model --json" / "--model --live" must not swallow the next flag.
		expect(parseFixArgs(["--model", "--json"])).toEqual({
			ok: false,
			message: "Missing value for --model",
		});
		expect(parseFixArgs(["--model", "--live"])).toEqual({
			ok: false,
			message: "Missing value for --model",
		});
		expect(parseFixArgs(["--model=--json"])).toEqual({
			ok: false,
			message: "Missing value for --model",
		});
		// A whitespace-only value trims to empty and must be rejected too.
		expect(parseFixArgs(["--model", "   "])).toEqual({
			ok: false,
			message: "Missing value for --model",
		});
		// The short -m form is first-class too and must reject flag-like values.
		expect(parseFixArgs(["-m", "--json"])).toEqual({
			ok: false,
			message: "Missing value for --model",
		});
		// A real model value is still accepted (both long and short forms).
		expect(parseFixArgs(["--model", "gpt-5.5"]).ok).toBe(true);
		expect(parseFixArgs(["-m", "gpt-5.5"]).ok).toBe(true);
	});

	it("runVerifyFlagged uses the injected identity resolver in the direct no-restore flow", async () => {
		const flaggedAccount = {
			email: "old@example.com",
			refreshToken: "flagged-refresh",
			accessToken: "old-access",
			expiresAt: 10,
			accountId: "stored-account",
			accountIdSource: "manual" as const,
			lastError: "old-error",
			lastUsed: 1,
		};
		let persistedFlaggedStorage: unknown;

		storageMocks.loadFlaggedAccounts.mockResolvedValue({
			version: 1,
			accounts: [structuredClone(flaggedAccount)],
		});
		refreshQueueMocks.queuedRefresh.mockResolvedValue({
			type: "success",
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: 999,
			idToken: "fresh-id-token",
		});
		extractAccountEmailMock.mockReturnValue("Recovered@example.com");
		extractAccountIdMock.mockReturnValue("token-account");
		storageMocks.withFlaggedStorageTransaction.mockImplementation(async (handler) =>
			handler(
				{ version: 1, accounts: [structuredClone(flaggedAccount)] },
				async (nextStorage: unknown) => {
					persistedFlaggedStorage = nextStorage;
				},
			),
		);
		const resolveStoredAccountIdentity = vi.fn(() => ({
			accountId: "resolved-account",
			accountIdSource: "token" as const,
		}));
		const consoleSpy = silenceConsole("log");

		const exitCode = await runVerifyFlagged(
			["--json", "--no-restore"],
			createDeps({ resolveStoredAccountIdentity }),
		);

		expect(exitCode).toBe(0);
		expect(resolveStoredAccountIdentity).toHaveBeenCalledWith(
			"stored-account",
			"manual",
			"token-account",
		);
		expect(storageMocks.withFlaggedStorageTransaction).toHaveBeenCalledTimes(1);
		expect(persistedFlaggedStorage).toMatchObject({
			version: 1,
			accounts: [
				expect.objectContaining({
					accountId: "resolved-account",
					accountIdSource: "token",
					accessToken: "fresh-access",
					refreshToken: "fresh-refresh",
					email: "recovered@example.com",
				}),
			],
		});
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")).reports[0],
		).toMatchObject({
			outcome: "healthy-flagged",
		});
	});

	it("runVerifyFlagged keeps remainingFlagged in the JSON schema for empty and no-op paths", async () => {
		const consoleSpy = silenceConsole("log");

		storageMocks.loadFlaggedAccounts.mockResolvedValueOnce({
			version: 1,
			accounts: [],
		});

		let exitCode = await runVerifyFlagged(
			["--json", "--no-restore"],
			createDeps(),
		);
		expect(exitCode).toBe(0);
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")),
		).toMatchObject({
			total: 0,
			remainingFlagged: 0,
			changed: false,
		});

		const flaggedAccount = {
			email: "flagged@example.com",
			refreshToken: "flagged-refresh",
			accessToken: "old-access",
			expiresAt: 10,
			accountId: "stored-account",
			accountIdSource: "manual" as const,
			lastError: "still broken",
			lastUsed: 1,
		};
		storageMocks.loadFlaggedAccounts.mockResolvedValueOnce({
			version: 1,
			accounts: [structuredClone(flaggedAccount)],
		});
		refreshQueueMocks.queuedRefresh.mockResolvedValueOnce({
			type: "failed",
			reason: "revoked",
			message: "still broken",
		});

		exitCode = await runVerifyFlagged(
			["--json", "--no-restore"],
			createDeps(),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withFlaggedStorageTransaction).not.toHaveBeenCalled();
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")),
		).toMatchObject({
			total: 1,
			remainingFlagged: 1,
			stillFlagged: 1,
			changed: false,
		});
	});

	it("runVerifyFlagged skips stale restore results when flagged refresh tokens changed before persistence", async () => {
		const flaggedAccount = {
			email: "flagged@example.com",
			refreshToken: "flagged-refresh",
			accessToken: "old-access",
			expiresAt: 10,
			accountId: "stored-account",
			accountIdSource: "manual" as const,
			lastError: "old-error",
			lastUsed: 1,
		};
		const persistSpy = vi.fn();

		storageMocks.loadFlaggedAccounts.mockResolvedValue({
			version: 1,
			accounts: [structuredClone(flaggedAccount)],
		});
		refreshQueueMocks.queuedRefresh.mockResolvedValue({
			type: "success",
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: 999,
			idToken: "fresh-id-token",
		});
		extractAccountEmailMock.mockReturnValue("flagged@example.com");
		extractAccountIdMock.mockReturnValue("token-account");
		storageMocks.withAccountAndFlaggedStorageTransaction.mockImplementation(async (handler) =>
			handler(
				null,
				persistSpy,
				{
					version: 1,
					accounts: [
						{
							...structuredClone(flaggedAccount),
							refreshToken: "rotated-refresh",
						},
					],
				},
			),
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runVerifyFlagged(
			["--json"],
			createDeps(),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withAccountAndFlaggedStorageTransaction).toHaveBeenCalledTimes(1);
		expect(persistSpy).not.toHaveBeenCalled();
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")),
		).toMatchObject({
			total: 1,
			restored: 0,
			remainingFlagged: 1,
			changed: false,
			reports: [
				expect.objectContaining({
					outcome: "restore-skipped",
					message: expect.stringContaining("changed before persistence"),
				}),
			],
		});
	});

	it("runVerifyFlagged skips stale no-restore updates when flagged refresh tokens changed before persistence", async () => {
		const flaggedAccount = {
			email: "flagged@example.com",
			refreshToken: "flagged-refresh",
			accessToken: "old-access",
			expiresAt: 10,
			accountId: "stored-account",
			accountIdSource: "manual" as const,
			lastError: "old-error",
			lastUsed: 1,
		};
		const persistSpy = vi.fn();

		storageMocks.loadFlaggedAccounts.mockResolvedValue({
			version: 1,
			accounts: [structuredClone(flaggedAccount)],
		});
		refreshQueueMocks.queuedRefresh.mockResolvedValue({
			type: "success",
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: 999,
			idToken: "fresh-id-token",
		});
		extractAccountEmailMock.mockReturnValue("flagged@example.com");
		extractAccountIdMock.mockReturnValue("token-account");
		storageMocks.withFlaggedStorageTransaction.mockImplementation(async (handler) =>
			handler(
				{
					version: 1,
					accounts: [
						{
							...structuredClone(flaggedAccount),
							refreshToken: "rotated-refresh",
						},
					],
				},
				persistSpy,
			),
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runVerifyFlagged(
			["--json", "--no-restore"],
			createDeps(),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withFlaggedStorageTransaction).toHaveBeenCalledTimes(1);
		expect(persistSpy).not.toHaveBeenCalled();
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")),
		).toMatchObject({
			total: 1,
			remainingFlagged: 1,
			changed: false,
			reports: [
				expect.objectContaining({
					outcome: "restore-skipped",
					message: expect.stringContaining("changed before persistence"),
				}),
			],
		});
	});

	it("runFix uses the injected token-identity applier in the direct concurrent-write path", async () => {
		const prescanStorage = {
			version: 3,
			accounts: [
				{
					email: "old@example.com",
					refreshToken: "old-refresh",
					accessToken: "old-access",
					expiresAt: 0,
					accountId: "old-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		const inTransactionStorage = {
			version: 3,
			accounts: [
				{
					email: "old@example.com",
					refreshToken: "old-refresh",
					accessToken: "concurrent-access",
					expiresAt: 25,
					accountId: "old-account",
					accountIdSource: "manual" as const,
					accountLabel: "Concurrent Label",
					enabled: true,
				},
				{
					email: "beta@example.com",
					refreshToken: "beta-refresh",
					accessToken: "beta-access",
					expiresAt: 30,
					accountId: "beta-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		let persistedAccountStorage: unknown;

		storageMocks.loadAccounts.mockResolvedValue(structuredClone(prescanStorage));
		refreshQueueMocks.queuedRefresh.mockResolvedValue({
			type: "success",
			access: "new-access",
			refresh: "new-refresh",
			expires: 5000,
			idToken: "new-id-token",
		});
		extractAccountEmailMock.mockReturnValue("fresh@example.com");
		extractAccountIdMock.mockReturnValue("token-account");
		storageMocks.withAccountStorageTransaction.mockImplementation(async (handler) =>
			handler(structuredClone(inTransactionStorage), async (nextStorage: unknown) => {
				persistedAccountStorage = nextStorage;
			}),
		);
		const applyTokenAccountIdentity = vi.fn((account: { accountId?: string; accountIdSource?: string }, refreshedAccountId: string | undefined) => {
			account.accountId = `dep-${refreshedAccountId}`;
			account.accountIdSource = "token";
			return true;
		});
		const consoleSpy = silenceConsole("log");

		const exitCode = await runFix(
			["--json"],
			createDeps({ applyTokenAccountIdentity }),
		);

		expect(exitCode).toBe(0);
		expect(applyTokenAccountIdentity).toHaveBeenCalled();
		expect(storageMocks.withAccountStorageTransaction).toHaveBeenCalledTimes(1);
		expect(persistedAccountStorage).toMatchObject({
			accounts: [
				expect.objectContaining({
					accountLabel: "Concurrent Label",
					accountId: "dep-token-account",
					accountIdSource: "token",
					accessToken: "new-access",
					refreshToken: "new-refresh",
					email: "fresh@example.com",
				}),
				expect.objectContaining({
					accountId: "beta-account",
					refreshToken: "beta-refresh",
				}),
			],
		});
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")).summary,
		).toMatchObject({
			healthy: 1,
		});
	});

	it("runFix keeps JSON output consistent for no-account and quota-cache-only changes", async () => {
		const consoleSpy = silenceConsole("log");

		storageMocks.loadAccounts.mockResolvedValueOnce(null);
		let exitCode = await runFix(["--json"], createDeps());

		expect(exitCode).toBe(0);
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")),
		).toMatchObject({
			command: "fix",
			changed: false,
			summary: {
				healthy: 0,
				disabled: 0,
				warnings: 0,
				skipped: 0,
			},
			reports: [],
		});

		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({
			byAccountId: {},
			byEmail: {},
		});
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "quota@example.com",
					refreshToken: "quota-refresh",
					accessToken: "quota-access",
					expiresAt: Date.now() + 60_000,
					accountId: "quota-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});

		exitCode = await runFix(
			["--json", "--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				updateQuotaCacheForAccount: () => true,
			}),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withAccountStorageTransaction).not.toHaveBeenCalled();
		expect(quotaCacheMocks.saveQuotaCache).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")),
		).toMatchObject({
			command: "fix",
			changed: false,
			quotaCacheChanged: true,
			summary: {
				healthy: 1,
			},
		});
	});

	it("runFix reports quota-cache-only live changes distinctly in display mode", async () => {
		const consoleSpy = silenceConsole("log");

		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({
			byAccountId: {},
			byEmail: {},
		});
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "quota@example.com",
					refreshToken: "quota-refresh",
					accessToken: "quota-access",
					expiresAt: Date.now() + 60_000,
					accountId: "quota-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});

		const exitCode = await runFix(
			["--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				updateQuotaCacheForAccount: () => true,
			}),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withAccountStorageTransaction).not.toHaveBeenCalled();
		expect(quotaCacheMocks.saveQuotaCache).toHaveBeenCalledTimes(1);
		const output = consoleSpy.mock.calls
			.map((call) => call.map((value) => String(value)).join(" "))
			.join("\n");
		expect(output).toContain("Quota cache refreshed (no account storage changes).");
		expect(output).not.toContain("Saved updates.");
		expect(output).not.toContain("No changes were needed.");
	});

	it("runFix does not double-count a live probe failure followed by refresh fallback", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({
			byAccountId: {},
			byEmail: {},
		});
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "fallback@example.com",
					refreshToken: "refresh-fallback",
					accessToken: "access-fallback",
					expiresAt: Date.now() + 60_000,
					accountId: "fallback-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		quotaProbeMocks.fetchCodexQuotaSnapshot
			.mockRejectedValueOnce(new Error("probe unavailable"))
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {},
				secondary: {},
			});
		refreshQueueMocks.queuedRefresh.mockResolvedValueOnce({
			type: "success",
			access: "access-fallback-next",
			refresh: "refresh-fallback-next",
			expires: Date.now() + 120_000,
			idToken: "id-token-fallback",
		});
		extractAccountEmailMock.mockReturnValue("fallback@example.com");
		extractAccountIdMock.mockReturnValue("fallback-account");
		const consoleSpy = silenceConsole("log");

		const exitCode = await runFix(
			["--json", "--live"],
			createDeps({ hasUsableAccessToken: () => true }),
		);

		expect(exitCode).toBe(0);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			summary: { healthy: number; warnings: number };
			reports: Array<{ outcome: string }>;
		};
		expect(payload.summary).toMatchObject({ healthy: 1, warnings: 0 });
		expect(payload.reports).toHaveLength(1);
		expect(payload.reports[0]).toMatchObject({ outcome: "healthy" });
	});

	it("runFix marks codex-unavailable live probe as a soft warning and keeps the account enabled", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		const storage = {
			version: 3 as const,
			accounts: [
				{
					email: "unavailable@example.com",
					refreshToken: "refresh-unavailable",
					accessToken: "access-expired",
					expiresAt: 0,
					accountId: "unavailable-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		storageMocks.loadAccounts.mockResolvedValue(storage);
		refreshQueueMocks.queuedRefresh.mockResolvedValueOnce({
			type: "success",
			access: "access-unavailable-next",
			refresh: "refresh-unavailable-next",
			expires: Date.now() + 120_000,
			idToken: "id-token-unavailable",
		});
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockRejectedValue(
			new CodexUnavailableError(
				"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
			),
		);
		extractAccountEmailMock.mockReturnValue("unavailable@example.com");
		extractAccountIdMock.mockReturnValue("unavailable-account");
		const consoleSpy = silenceConsole("log");

		const exitCode = await runFix(
			["--json", "--live"],
			createDeps({ hasUsableAccessToken: () => false }),
		);

		expect(exitCode).toBe(0);
		const payload = JSON.parse(
			String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}"),
		) as {
			summary: { warnings: number };
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(payload.reports).toHaveLength(1);
		expect(payload.reports[0]?.outcome).toBe("warning-soft-failure");
		expect(payload.reports[0]?.message).toContain(CODEX_UNAVAILABLE_PROBE_NOTE);
		// raw upstream error must not leak
		expect(payload.reports[0]?.message).not.toContain(
			"is not supported when using Codex",
		);
	});

	it("runDoctor uses the injected refresh-token validator in JSON diagnostics", async () => {
		storageMocks.loadAccounts.mockResolvedValue({
			version: 3,
			accounts: [
				{
					email: "doctor@example.com",
					refreshToken: "bad-refresh-token",
					accessToken: "access",
					expiresAt: 100,
					accountId: "doctor-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		const hasLikelyInvalidRefreshToken = vi.fn(() => true);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(
			["--json"],
			createDeps({ hasLikelyInvalidRefreshToken }),
		);

		expect(exitCode).toBe(0);
		expect(hasLikelyInvalidRefreshToken).toHaveBeenCalledWith("bad-refresh-token");
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")).checks,
		).toContainEqual(
			expect.objectContaining({
				key: "refresh-token-shape",
				severity: "warn",
			}),
		);
	});

	it("runDoctor warns when disk forecast and runtime overlay diverge", async () => {
		const quotaCache = {
			byAccountId: {
				"doctor-account": {
					updatedAt: 1,
					status: 200,
					model: "gpt-5.3-codex",
					primary: { usedPercent: 100, resetAtMs: 10_000 },
					secondary: {},
				},
			},
			byEmail: {},
		};
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce(quotaCache);
		storageMocks.loadAccounts.mockResolvedValue({
			version: 3,
			accounts: [
				{
					email: "doctor@example.com",
					refreshToken: "refresh-token",
					accessToken: "access",
					expiresAt: 100,
					accountId: "doctor-account",
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		runtimeObservabilityMocks.loadPersistedRuntimeObservabilitySnapshot.mockResolvedValue({
			lastPoolExhaustionSkipReasons: { "0": "circuit-open" },
		});
		evaluateForecastAccountsMock.mockImplementation((inputs) =>
			inputs.map((input: { index: number; runtimeOverlay?: unknown }) => ({
				index: input.index,
				label: `account ${input.index + 1}`,
				isCurrent: true,
				availability: input.runtimeOverlay ? "unavailable" : "ready",
				riskScore: input.runtimeOverlay ? 90 : 0,
				riskLevel: input.runtimeOverlay ? "high" : "low",
				waitMs: 0,
				reasons: input.runtimeOverlay
					? ["runtime skip: circuit-open"]
					: [],
				hardFailure: false,
				disabled: false,
			})),
		);
		recommendForecastAccountMock.mockReturnValue({
			recommendedIndex: 0,
			reason: "stay",
		});
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(["--json"], createDeps());

		expect(exitCode).toBe(0);
		expect(quotaCacheMocks.loadQuotaCache).toHaveBeenCalledTimes(1);
		expect(evaluateForecastAccountsMock).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					quotaCache,
					allAccounts: expect.any(Array),
				}),
			]),
		);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			checks: Array<{ key: string; severity: string; message: string; details?: string }>;
		};
		expect(payload.checks).toContainEqual(
			expect.objectContaining({
				key: "forecast-runtime-alignment",
				severity: "warn",
				message: "1 account(s) look ready on disk but unavailable in runtime state",
				details: expect.stringContaining("runtime skip: circuit-open"),
			}),
		);
	});

	it("runDoctor treats failed runtime snapshot loads as aligned diagnostics", async () => {
		storageMocks.loadAccounts.mockResolvedValue({
			version: 3,
			accounts: [
				{
					email: "doctor@example.com",
					refreshToken: "refresh-token",
					accessToken: "access",
					expiresAt: 100,
					accountId: "doctor-account",
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		runtimeObservabilityMocks.loadPersistedRuntimeObservabilitySnapshot.mockRejectedValue(
			new Error("snapshot busy"),
		);
		evaluateForecastAccountsMock.mockImplementation((inputs) =>
			inputs.map((input: { index: number }) => ({
				index: input.index,
				label: `account ${input.index + 1}`,
				isCurrent: true,
				availability: "ready",
				riskScore: 0,
				riskLevel: "low",
				waitMs: 0,
				reasons: [],
				hardFailure: false,
				disabled: false,
			})),
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(["--json"], createDeps());

		expect(exitCode).toBe(0);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			checks: Array<{ key: string; severity: string; message: string }>;
		};
		expect(payload.checks).toContainEqual(
			expect.objectContaining({
				key: "forecast-runtime-alignment",
				severity: "ok",
				message: "Forecast and runtime availability are aligned",
			}),
		);
	});

	it("runDoctor checks refresh token shape even when email is missing", async () => {
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					refreshToken: "bad-refresh-token",
					accessToken: "access",
					expiresAt: 100,
					accountId: "doctor-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		const hasLikelyInvalidRefreshToken = vi.fn(() => true);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(
			["--json"],
			createDeps({ hasLikelyInvalidRefreshToken }),
		);

		expect(exitCode).toBe(0);
		expect(hasLikelyInvalidRefreshToken).toHaveBeenCalledWith("bad-refresh-token");
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")).checks,
		).toContainEqual(
			expect.objectContaining({
				key: "refresh-token-shape",
				severity: "warn",
			}),
		);
	});

	it("runDoctor marks malformed codex auth payloads as invalid instead of healthy", async () => {
		existsSyncMock.mockImplementation((path) => path === "/mock/auth.json");
		readFileMock.mockResolvedValueOnce("[]");
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(["--json"], createDeps());

		expect(exitCode).toBe(1);
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")).checks,
		).toContainEqual(
			expect.objectContaining({
				key: "codex-auth-readable",
				severity: "error",
				message: "Codex auth file has invalid structure",
			}),
		);
	});

	it("runDoctor derives auto-fix state from the final action set", async () => {
		const now = Date.now();
		let persistedAccountStorage: unknown;
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "doctor@example.com",
					refreshToken: "doctor-refresh",
					accessToken: "doctor-access",
					expiresAt: now - 60_000,
					accountId: "doctor-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		});
		storageMocks.withAccountStorageTransaction.mockImplementation(async (handler) =>
			handler(
				{
					version: 3,
					accounts: [
						{
							email: "doctor@example.com",
							refreshToken: "doctor-refresh",
							accessToken: "concurrent-access",
							expiresAt: now - 30_000,
							accountId: "doctor-account",
							accountIdSource: "manual" as const,
							accountLabel: "Concurrent Label",
							enabled: true,
						},
					],
					activeIndex: 0,
					activeIndexByFamily: {
						codex: 0,
						"codex-max": 0,
						"gpt-5-codex": 0,
						"gpt-5.1": 0,
						"gpt-5.2": 0,
					},
				},
				async (nextStorage: unknown) => {
					persistedAccountStorage = nextStorage;
				},
			),
		);
		refreshQueueMocks.queuedRefresh.mockResolvedValueOnce({
			type: "success",
			access: "doctor-access-next",
			refresh: "doctor-refresh-next",
			expires: now + 3_600_000,
			idToken: "doctor-id-next",
		});
		extractAccountEmailMock.mockImplementation((accessToken: string | undefined) =>
			accessToken === "doctor-access-next" ? "doctor-fresh@example.com" : "doctor@example.com"
		);
		extractAccountIdMock.mockImplementation((accessToken: string | undefined) =>
			accessToken === "doctor-access-next" ? "doctor-token-account" : "doctor-account"
		);
		codexCliWriterMocks.setCodexCliActiveSelection.mockResolvedValueOnce(true);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(
			["--json", "--fix"],
			createDeps({
				hasUsableAccessToken: () => false,
			}),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withAccountStorageTransaction).toHaveBeenCalledTimes(1);
		expect(persistedAccountStorage).toMatchObject({
			accounts: [
				expect.objectContaining({
					accountLabel: "Concurrent Label",
					accessToken: "doctor-access-next",
					refreshToken: "doctor-refresh-next",
				}),
			],
		});
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			checks: Array<{ key: string; severity: string; message: string }>;
			fix: {
				changed: boolean;
				actions: Array<{ key: string }>;
			};
		};
		expect(payload.fix.changed).toBe(true);
		expect(payload.fix.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "doctor-refresh" }),
				expect.objectContaining({ key: "codex-active-sync" }),
			]),
		);
		expect(payload.checks).toContainEqual(
			expect.objectContaining({
				key: "auto-fix",
				severity: "warn",
				message: expect.stringMatching(/Applied \d+ fix\(es\)/),
			}),
		);
	});

	it("runDoctor records active-index fixes when normalization changes the snapshot", async () => {
		const now = Date.now();
		let persistedAccountStorage: unknown;
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "doctor@example.com",
					refreshToken: "doctor-refresh",
					accessToken: "doctor-access",
					expiresAt: now + 60_000,
					accountId: "doctor-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 7,
			activeIndexByFamily: {
				codex: 7,
				"codex-max": 7,
				"gpt-5-codex": 7,
			},
		});
		storageMocks.withAccountStorageTransaction.mockImplementation(async (handler) =>
			handler(
				{
					version: 3,
					accounts: [
						{
							email: "doctor@example.com",
							refreshToken: "doctor-refresh",
							accessToken: "doctor-access",
							expiresAt: now + 60_000,
							accountId: "doctor-account",
							accountIdSource: "manual" as const,
							enabled: true,
						},
					],
					activeIndex: 7,
					activeIndexByFamily: {
						codex: 7,
						"codex-max": 7,
						"gpt-5-codex": 7,
					},
				},
				async (nextStorage: unknown) => {
					persistedAccountStorage = nextStorage;
				},
			),
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(
			["--json", "--fix"],
			createDeps({
				hasUsableAccessToken: () => true,
			}),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withAccountStorageTransaction).toHaveBeenCalledTimes(1);
		expect(persistedAccountStorage).toMatchObject({
			activeIndex: 0,
			activeIndexByFamily: {
				codex: 0,
				"codex-max": 0,
				"gpt-5-codex": 0,
			},
		});
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			fix: {
				changed: boolean;
				actions: Array<{ key: string }>;
			};
		};
		expect(payload.fix.changed).toBe(true);
		expect(payload.fix.actions).toContainEqual(
			expect.objectContaining({ key: "active-index" }),
		);
	});

	it("runDoctor keeps the prescan snapshot unchanged when the transaction is already fixed", async () => {
		const now = Date.now();
		let persistedAccountStorage: unknown;
		const prescanStorage = {
			version: 3,
			accounts: [
				{
					email: "doctor@example.com",
					refreshToken: "doctor-refresh",
					accessToken: "doctor-access",
					expiresAt: now + 60_000,
					accountId: "doctor-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
				{
					email: "doctor+duplicate@example.com",
					refreshToken: "doctor-refresh",
					accessToken: "doctor-access-duplicate",
					expiresAt: now + 60_000,
					accountId: "doctor-duplicate",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		};
		storageMocks.loadAccounts.mockResolvedValueOnce(prescanStorage);
		storageMocks.withAccountStorageTransaction.mockImplementation(async (handler) =>
			handler(
				{
					version: 3,
					accounts: [
						{
							email: "doctor@example.com",
							refreshToken: "doctor-refresh",
							accessToken: "doctor-access",
							expiresAt: now + 60_000,
							accountId: "doctor-account",
							accountIdSource: "manual" as const,
							enabled: true,
						},
						{
							email: "doctor+duplicate@example.com",
							refreshToken: "doctor-refresh-2",
							accessToken: "doctor-access-duplicate",
							expiresAt: now + 60_000,
							accountId: "doctor-duplicate",
							accountIdSource: "manual" as const,
							enabled: true,
						},
					],
					activeIndex: 0,
					activeIndexByFamily: {
						codex: 0,
						"codex-max": 0,
						"gpt-5-codex": 0,
						"gpt-5.1": 0,
						"gpt-5.2": 0,
					},
				},
				async (nextStorage: unknown) => {
					persistedAccountStorage = nextStorage;
				},
			),
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(
			["--json", "--fix"],
			createDeps({
				hasUsableAccessToken: () => true,
			}),
		);

		expect(exitCode).toBe(0);
		expect(storageMocks.withAccountStorageTransaction).toHaveBeenCalledTimes(1);
		expect(persistedAccountStorage).toBeUndefined();
		expect(prescanStorage.accounts[1]?.enabled).toBe(true);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			fix: {
				changed: boolean;
				actions: Array<{ key: string }>;
			};
		};
		expect(payload.fix.changed).toBe(false);
		expect(payload.fix.actions).toEqual([]);
	});

	it("runDoctor skips Codex sync when the refreshed account disappears before persistence", async () => {
		const now = Date.now();
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "doctor@example.com",
					refreshToken: "doctor-refresh",
					accessToken: "doctor-access",
					expiresAt: now - 60_000,
					accountId: "doctor-account",
					accountIdSource: "manual" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		});
		storageMocks.withAccountStorageTransaction.mockImplementation(async (handler) =>
			handler(
				{
					version: 3,
					accounts: [
						{
							email: "remaining@example.com",
							refreshToken: "remaining-refresh",
							accessToken: "remaining-access",
							expiresAt: now + 60_000,
							accountId: "remaining-account",
							accountIdSource: "manual" as const,
							enabled: true,
						},
					],
					activeIndex: 0,
					activeIndexByFamily: {
						codex: 0,
						"codex-max": 0,
						"gpt-5-codex": 0,
						"gpt-5.1": 0,
						"gpt-5.2": 0,
					},
				},
				async () => undefined,
			),
		);
		refreshQueueMocks.queuedRefresh.mockResolvedValueOnce({
			type: "success",
			access: "doctor-access-next",
			refresh: "doctor-refresh-next",
			expires: now + 3_600_000,
			idToken: "doctor-id-next",
		});
		extractAccountEmailMock.mockImplementation((accessToken: string | undefined) =>
			accessToken === "doctor-access-next" ? "doctor-fresh@example.com" : "doctor@example.com"
		);
		extractAccountIdMock.mockImplementation((accessToken: string | undefined) =>
			accessToken === "doctor-access-next" ? "doctor-token-account" : "doctor-account"
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runDoctor(
			["--json", "--fix"],
			createDeps({
				hasUsableAccessToken: () => false,
				resolveActiveIndex: () => -1,
			}),
		);

		expect(exitCode).toBe(1);
		expect(storageMocks.withAccountStorageTransaction).toHaveBeenCalledTimes(1);
		expect(codexCliWriterMocks.setCodexCliActiveSelection).not.toHaveBeenCalled();
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			fix: {
				changed: boolean;
				actions: Array<{ key: string }>;
			};
		};
		expect(payload.fix.changed).toBe(true);
		expect(payload.fix.actions).not.toContainEqual(
			expect.objectContaining({ key: "codex-active-sync" }),
		);
	});
});
