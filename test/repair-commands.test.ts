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

vi.mock("../lib/accounts.js", async () => {
	// The real identity helpers, so account-credentials.ts can be exercised
	// unmocked where a test asks for it.
	const tokenUtils = await vi.importActual<
		typeof import("../lib/auth/token-utils.js")
	>("../lib/auth/token-utils.js");
	return {
		extractAccountEmail: extractAccountEmailMock,
		extractAccountId: extractAccountIdMock,
		formatAccountLabel: formatAccountLabelMock,
		sanitizeEmail: sanitizeEmailMock,
		resolveRequestAccountId: tokenUtils.resolveRequestAccountId,
		shouldUpdateAccountIdFromToken: tokenUtils.shouldUpdateAccountIdFromToken,
	};
});

vi.mock("../lib/quota-cache.js", async (importOriginal) =>
	(await import("./helpers/cli-test-fixtures.js")).quotaCacheModuleMock(
		quotaCacheMocks,
		await importOriginal<typeof import("../lib/quota-cache.js")>(),
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
		reboundUnauthorizedAccountIdentity: async () => null,
		refreshCodexCliMirror: async () => null,
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

	it("runDoctor treats an org id as aligned with the token workspace id in auth.json (#700)", async () => {
		const accessToken = `h.${Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
			}),
		).toString("base64url")}.s`;
		storageMocks.loadAccounts.mockResolvedValue({
			version: 3,
			accounts: [
				{
					email: "org@example.com",
					refreshToken: "refresh-token",
					accessToken,
					expiresAt: 100,
					accountId: "org-AbC123",
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		codexCliStateMocks.loadCodexCliState.mockResolvedValue({
			path: "/mock/auth.json",
			activeAccountId: "ws-uuid-1",
			activeEmail: "org@example.com",
		});
		const consoleSpy = silenceConsole("log");

		await runDoctor(["--json"], createDeps());

		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			checks: Array<{ key: string; severity: string; message: string }>;
		};
		expect(payload.checks).toContainEqual(
			expect.objectContaining({
				key: "active-selection-sync",
				severity: "ok",
				message: "Manager active account and Codex active account are aligned",
			}),
		);
	});

	it("runDoctor flags an org account_id left in auth.json until it is rewritten (#700)", async () => {
		const accessToken = `h.${Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
			}),
		).toString("base64url")}.s`;
		storageMocks.loadAccounts.mockResolvedValue({
			version: 3,
			accounts: [
				{
					email: "org@example.com",
					refreshToken: "refresh-token",
					accessToken,
					expiresAt: 100,
					accountId: "org-AbC123",
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		existsSyncMock.mockImplementation((path) => path === "/mock/auth.json");
		const arrangeAuthFile = (accountId: string) => {
			readFileMock.mockResolvedValue(
				JSON.stringify({
					email: "org@example.com",
					tokens: { access_token: accessToken, account_id: accountId },
				}),
			);
			codexCliStateMocks.loadCodexCliState.mockResolvedValue({
				path: "/mock/auth.json",
				activeAccountId: accountId,
				activeEmail: "org@example.com",
				authFileAccountId: accountId,
				accounts: [{ accountId, accessToken, isActive: true }],
			});
		};
		const syncCheck = async () => {
			const consoleSpy = silenceConsole("log");
			await runDoctor(["--json"], createDeps());
			const payload = JSON.parse(
				String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}"),
			) as { checks: Array<{ key: string; severity: string }> };
			return payload.checks.find((check) => check.key === "active-selection-sync");
		};

		arrangeAuthFile("org-AbC123");
		expect(await syncCheck()).toMatchObject({ severity: "warn" });

		// what the writer leaves behind after `doctor --fix`
		arrangeAuthFile("ws-uuid-1");
		expect(await syncCheck()).toMatchObject({ severity: "ok" });
	});

	it("runDoctor treats the legacy accounts.json raw org id as aligned (#700)", async () => {
		const accessToken = `h.${Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
			}),
		).toString("base64url")}.s`;
		storageMocks.loadAccounts.mockResolvedValue({
			version: 3,
			accounts: [
				{
					email: "org@example.com",
					refreshToken: "refresh-token",
					accessToken,
					expiresAt: 100,
					accountId: "org-AbC123",
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		codexCliStateMocks.loadCodexCliState.mockResolvedValue({
			path: "/mock/accounts.json",
			activeAccountId: "org-AbC123",
			activeEmail: "org@example.com",
			accounts: [{ accountId: "org-AbC123", accessToken, isActive: true }],
		});
		const consoleSpy = silenceConsole("log");

		await runDoctor(["--json"], createDeps());

		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			checks: Array<{ key: string; severity: string; message: string }>;
		};
		expect(payload.checks).toContainEqual(
			expect.objectContaining({
				key: "active-selection-sync",
				severity: "ok",
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

	// Issue #641: a config.toml still pointing at the keychain is what makes the
	// official CLI raise repeated macOS login-keychain prompts, so `--fix` has to
	// repair it directly rather than leaving a bare warning behind.
	describe("runDoctor codex-auth-store remediation", () => {
		// vi.clearAllMocks() keeps implementations, so a mockReturnValue/
		// mockResolvedValue set by one case bleeds into the next unless reset here.
		beforeEach(() => {
			codexCliWriterMocks.shouldEnforceCodexCliFileAuthStore.mockReset();
			codexCliWriterMocks.shouldEnforceCodexCliFileAuthStore.mockReturnValue(
				true,
			);
			codexCliWriterMocks.ensureCodexCliFileAuthStore.mockReset();
			codexCliWriterMocks.readTopLevelCodexCliAuthStoreMode.mockReset();
		});

		function arrangeAuthStore(mode: string | null): void {
			existsSyncMock.mockImplementation(
				(path) => path === "/mock/config.toml",
			);
			readFileMock.mockResolvedValue(
				mode ? `cli_auth_credentials_store = "${mode}"\n` : "",
			);
			codexCliWriterMocks.readTopLevelCodexCliAuthStoreMode.mockReturnValue(mode);
		}

		function readPayload(consoleSpy: {
			mock: { calls: unknown[][] };
		}): Record<string, unknown> {
			return JSON.parse(
				String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}"),
			) as Record<string, unknown>;
		}

		function readChecks(consoleSpy: {
			mock: { calls: unknown[][] };
		}): Array<Record<string, unknown>> {
			return readPayload(consoleSpy).checks as Array<Record<string, unknown>>;
		}

		function readFix(consoleSpy: {
			mock: { calls: unknown[][] };
		}): { changed: boolean; actions: Array<Record<string, unknown>> } {
			return readPayload(consoleSpy).fix as {
				changed: boolean;
				actions: Array<Record<string, unknown>>;
			};
		}

		it("warns and points at --fix when the store is not pinned to file", async () => {
			arrangeAuthStore("keychain");
			const consoleSpy = silenceConsole("log");

			await runDoctor(["--json"], createDeps());

			expect(readChecks(consoleSpy)).toContainEqual(
				expect.objectContaining({
					key: "codex-auth-store",
					severity: "warn",
					details: expect.stringContaining("doctor --fix") as unknown as string,
				}),
			);
			expect(
				codexCliWriterMocks.ensureCodexCliFileAuthStore,
			).not.toHaveBeenCalled();
		});

		it("pins the store to file under --fix and reports the check as ok", async () => {
			arrangeAuthStore("keychain");
			codexCliWriterMocks.ensureCodexCliFileAuthStore.mockResolvedValue(true);
			const consoleSpy = silenceConsole("log");

			await runDoctor(["--json", "--fix"], createDeps());

			expect(codexCliWriterMocks.ensureCodexCliFileAuthStore).toHaveBeenCalledWith(
				"/mock/config.toml",
			);
			expect(readChecks(consoleSpy)).toContainEqual(
				expect.objectContaining({
					key: "codex-auth-store",
					severity: "ok",
					message: "Codex auth storage is set to file",
				}),
			);
		});

		// The #641 persona often has no accounts registered yet, so the fix
		// summary must not report "nothing changed" after rewriting config.toml.
		it("reports the remediation in fix metadata even with no accounts", async () => {
			arrangeAuthStore("keychain");
			codexCliWriterMocks.ensureCodexCliFileAuthStore.mockResolvedValue(true);
			const consoleSpy = silenceConsole("log");

			await runDoctor(["--json", "--fix"], createDeps());

			const fix = readFix(consoleSpy);
			expect(fix.changed).toBe(true);
			expect(fix.actions).toContainEqual(
				expect.objectContaining({
					key: "codex-auth-store",
					message: "Pinned Codex CLI credential store to file in config.toml",
				}),
			);
			expect(readChecks(consoleSpy)).toContainEqual(
				expect.objectContaining({ key: "auto-fix" }),
			);
		});

		it("leaves an already-pinned store untouched", async () => {
			arrangeAuthStore("file");
			const consoleSpy = silenceConsole("log");

			await runDoctor(["--json", "--fix"], createDeps());

			expect(
				codexCliWriterMocks.ensureCodexCliFileAuthStore,
			).not.toHaveBeenCalled();
			expect(readChecks(consoleSpy)).toContainEqual(
				expect.objectContaining({ key: "codex-auth-store", severity: "ok" }),
			);
		});

		it("keeps doctor running when the config rewrite fails", async () => {
			arrangeAuthStore("keychain");
			codexCliWriterMocks.ensureCodexCliFileAuthStore.mockRejectedValue(
				Object.assign(new Error("EBUSY: resource busy or locked"), {
					code: "EBUSY",
				}),
			);
			const consoleSpy = silenceConsole("log");

			const exitCode = await runDoctor(["--json", "--fix"], createDeps());

			expect(exitCode).toBe(0);
			const checks = readChecks(consoleSpy);
			expect(checks).toContainEqual(
				expect.objectContaining({
					key: "codex-auth-store-fix",
					severity: "warn",
					message: "Failed to pin Codex CLI credential store to file",
				}),
			);
			expect(checks).toContainEqual(
				expect.objectContaining({ key: "codex-auth-store", severity: "warn" }),
			);
		});

		// A dry run must not promise a rewrite the opt-out would suppress.
		it("plans nothing when enforcement is opted out", async () => {
			arrangeAuthStore("keychain");
			codexCliWriterMocks.shouldEnforceCodexCliFileAuthStore.mockReturnValue(
				false,
			);
			const consoleSpy = silenceConsole("log");

			await runDoctor(["--json", "--fix", "--dry-run"], createDeps());

			expect(readFix(consoleSpy).actions).not.toContainEqual(
				expect.objectContaining({ key: "codex-auth-store" }),
			);
			expect(readChecks(consoleSpy)).toContainEqual(
				expect.objectContaining({ key: "codex-auth-store", severity: "warn" }),
			);
		});

		it("skips the rewrite entirely when enforcement is opted out", async () => {
			arrangeAuthStore("keychain");
			codexCliWriterMocks.shouldEnforceCodexCliFileAuthStore.mockReturnValue(
				false,
			);
			const consoleSpy = silenceConsole("log");

			await runDoctor(["--json", "--fix"], createDeps());

			expect(
				codexCliWriterMocks.ensureCodexCliFileAuthStore,
			).not.toHaveBeenCalled();
			expect(readChecks(consoleSpy)).toContainEqual(
				expect.objectContaining({ key: "codex-auth-store", severity: "warn" }),
			);
		});

		it("does not rewrite config.toml on a dry run", async () => {
			arrangeAuthStore("keychain");
			const consoleSpy = silenceConsole("log");

			await runDoctor(["--json", "--fix", "--dry-run"], createDeps());

			expect(
				codexCliWriterMocks.ensureCodexCliFileAuthStore,
			).not.toHaveBeenCalled();
			expect(readChecks(consoleSpy)).toContainEqual(
				expect.objectContaining({ key: "codex-auth-store", severity: "warn" }),
			);
			// A dry run still has to say what it would do, like every other fix.
			const fix = readFix(consoleSpy);
			expect(fix.changed).toBe(true);
			expect(fix.actions).toContainEqual(
				expect.objectContaining({
					key: "codex-auth-store",
					message:
						"Prepared Codex CLI credential store pin to file in config.toml (dry-run)",
				}),
			);
		});
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

	// specs/codex-multi-auth-account-access — migrates an org-sourced id
	// wham/accounts/check no longer authorizes (Codex CLI >= 0.156.0), for an
	// account whose access token is still fresh.
	it("runFix rebinds an unauthorized org workspace on an already-valid token and still probes it live", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({
			byAccountId: {},
			byEmail: {},
		});
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "org@example.com",
					refreshToken: "org-refresh",
					accessToken: "org-access",
					expiresAt: Date.now() + 60_000,
					accountId: "org-team",
					accountIdSource: "org" as const,
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
		let capturedAccountId: string | undefined;
		let capturedToken: string | undefined;
		const reboundUnauthorizedAccountIdentity = vi.fn(
			async (
				account: { accountId?: string; accountIdSource?: string },
				accessToken: string,
			) => {
				// vi.fn() call records keep a reference, not a snapshot, so the
				// pre-mutation accountId must be captured here rather than asserted
				// on the recorded call args after this mock has already rewritten it.
				capturedAccountId = account.accountId;
				capturedToken = accessToken;
				account.accountId = "personal-id";
				account.accountIdSource = "token";
				return { accountId: "personal-id", changed: true, rejected: "org-team" };
			},
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runFix(
			["--json", "--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				reboundUnauthorizedAccountIdentity,
			}),
		);

		expect(exitCode).toBe(0);
		expect(reboundUnauthorizedAccountIdentity).toHaveBeenCalledTimes(1);
		expect(capturedAccountId).toBe("org-team");
		expect(capturedToken).toBe("org-access");
		// The corrected id, not the rejected org id, is what got probed.
		expect(quotaProbeMocks.fetchCodexQuotaSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "personal-id" }),
		);
		expect(storageMocks.withAccountStorageTransaction).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			changed: boolean;
			summary: { warnings: number };
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(payload.changed).toBe(true);
		expect(payload.summary).toMatchObject({ warnings: 1, healthy: 0 });
		expect(payload.reports).toHaveLength(1);
		expect(payload.reports[0]).toMatchObject({
			outcome: "rebound-unauthorized-workspace",
		});
		expect(payload.reports[0]?.message).toContain("not authorized");
	});

	// Same migration, taken on the refresh path (account.accountId was stale
	// enough to need a refresh first) — the corrected id must still be the one
	// probed and persisted, not the pre-refresh org id.
	it("runFix rebinds an unauthorized org workspace after a refresh and probes the corrected id", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({
			byAccountId: {},
			byEmail: {},
		});
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "org@example.com",
					refreshToken: "org-refresh",
					accessToken: "org-access-stale",
					expiresAt: 0,
					accountId: "org-team",
					accountIdSource: "org" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		// A leftover mockResolvedValueOnce from an earlier test can outlive
		// clearAllMocks() (it clears call history, not the queued-once values), so
		// reset before arming this test's own response.
		refreshQueueMocks.queuedRefresh.mockReset();
		refreshQueueMocks.queuedRefresh.mockResolvedValue({
			type: "success",
			access: "org-access-fresh",
			refresh: "org-refresh-next",
			expires: Date.now() + 120_000,
			idToken: "org-id-token",
		});
		extractAccountEmailMock.mockReturnValue("org@example.com");
		extractAccountIdMock.mockReturnValue("org-team");
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		let capturedAccountId: string | undefined;
		let capturedToken: string | undefined;
		const reboundUnauthorizedAccountIdentity = vi.fn(
			async (
				account: { accountId?: string; accountIdSource?: string },
				accessToken: string,
			) => {
				capturedAccountId = account.accountId;
				capturedToken = accessToken;
				account.accountId = "personal-id";
				account.accountIdSource = "token";
				return { accountId: "personal-id", changed: true, rejected: "org-team" };
			},
		);
		const consoleSpy = silenceConsole("log");

		const exitCode = await runFix(
			["--json", "--live"],
			createDeps({ hasUsableAccessToken: () => false, reboundUnauthorizedAccountIdentity }),
		);

		expect(exitCode).toBe(0);
		expect(reboundUnauthorizedAccountIdentity).toHaveBeenCalledTimes(1);
		expect(capturedAccountId).toBe("org-team");
		expect(capturedToken).toBe("org-access-fresh");
		expect(quotaProbeMocks.fetchCodexQuotaSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "personal-id" }),
		);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(payload.reports[0]).toMatchObject({
			outcome: "rebound-unauthorized-workspace",
		});
	});

	// Live-only contract: this migration makes a network call, so it must not
	// run on a plain `fix` without `--live`.
	it("runFix does not check workspace authorization without --live", async () => {
		storageMocks.loadAccounts.mockResolvedValueOnce({
			version: 3,
			accounts: [
				{
					email: "org@example.com",
					refreshToken: "org-refresh",
					accessToken: "org-access",
					expiresAt: Date.now() + 60_000,
					accountId: "org-team",
					accountIdSource: "org" as const,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
		const reboundUnauthorizedAccountIdentity = vi.fn();
		silenceConsole("log");

		await runFix(
			["--json"],
			createDeps({ hasUsableAccessToken: () => true, reboundUnauthorizedAccountIdentity }),
		);

		expect(reboundUnauthorizedAccountIdentity).not.toHaveBeenCalled();
	});

	// Mirrors the real reboundUnauthorizedAccountIdentity contract: only an
	// org-sourced id is ever rebound, so a second call after the first rebind
	// (source now "token") returns null.
	function orgRebinder(workspaces = false) {
		return vi.fn(
			async (account: {
				accountId?: string;
				accountIdSource?: string;
				accountLabel?: string;
				currentWorkspaceIndex?: number;
				workspaces?: Array<{ id: string; name?: string; enabled: boolean }>;
			}) => {
				if (account.accountIdSource !== "org") return null;
				account.accountId = "personal-id";
				account.accountIdSource = "token";
				if (workspaces) {
					account.accountLabel = "Personal";
					account.currentWorkspaceIndex = 0;
					account.workspaces = [{ id: "personal-id", name: "Personal", enabled: true }];
				}
				return { accountId: "personal-id", changed: true, rejected: "org-team" };
			},
		);
	}

	function orgAccountStorage(expiresAt: number) {
		return {
			version: 3 as const,
			accounts: [
				{
					email: "org@example.com",
					refreshToken: "org-refresh",
					accessToken: "org-access",
					expiresAt,
					accountId: "org-team",
					accountIdSource: "org" as const,
					accountLabel: "Team",
					workspaces: [
						{ id: "personal-id", name: "Personal", enabled: true },
						{ id: "org-team", name: "Team", enabled: true },
					],
					currentWorkspaceIndex: 1,
					enabled: true,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
	}

	// Greptile P2: the valid-token rebind happens before the live probe. When
	// that probe fails the refresh path's rebind sees a "token" source and
	// returns null, which used to drop the note from the final report while
	// the rebind itself was still saved.
	it("runFix keeps the rebind note exactly once when the first live probe fails", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		storageMocks.loadAccounts.mockResolvedValueOnce(orgAccountStorage(Date.now() + 60_000));
		refreshQueueMocks.queuedRefresh.mockReset();
		refreshQueueMocks.queuedRefresh.mockResolvedValue({
			type: "success",
			access: "org-access-fresh",
			refresh: "org-refresh-next",
			expires: Date.now() + 120_000,
		});
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot
			.mockRejectedValueOnce(new Error("probe exploded"))
			.mockResolvedValueOnce({ status: 200, model: "gpt-5-codex", primary: {}, secondary: {} });
		const reboundUnauthorizedAccountIdentity = orgRebinder();
		const consoleSpy = silenceConsole("log");

		await runFix(
			["--json", "--live"],
			createDeps({ hasUsableAccessToken: () => true, reboundUnauthorizedAccountIdentity }),
		);

		expect(reboundUnauthorizedAccountIdentity).toHaveBeenCalledTimes(2);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			summary: { warnings: number; healthy: number };
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(payload.reports).toHaveLength(1);
		expect(payload.reports[0]?.outcome).toBe("rebound-unauthorized-workspace");
		expect(payload.reports[0]?.message.match(/not authorized/g)).toHaveLength(1);
		expect(payload.summary).toMatchObject({ warnings: 1, healthy: 0 });
	});

	it("runFix keeps the rebind note on a soft-failure report after the refresh-path probe fails", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		storageMocks.loadAccounts.mockResolvedValueOnce(orgAccountStorage(Date.now() + 60_000));
		refreshQueueMocks.queuedRefresh.mockReset();
		refreshQueueMocks.queuedRefresh.mockResolvedValue({
			type: "success",
			access: "org-access-fresh",
			refresh: "org-refresh-next",
			expires: Date.now() + 120_000,
		});
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockRejectedValue(new Error("probe exploded"));
		const consoleSpy = silenceConsole("log");

		await runFix(
			["--json", "--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				reboundUnauthorizedAccountIdentity: orgRebinder(),
			}),
		);

		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(payload.reports[0]?.outcome).toBe("warning-soft-failure");
		expect(payload.reports[0]?.message).toContain("not authorized");
		expect(payload.reports[0]?.message).toContain("live probe failed");
	});

	// Codex CLI reads ~/.codex/auth.json, not the pool: without a sync it keeps
	// sending the rejected id after `fix --live` reported the account healthy.
	it("runFix syncs a rebound active account into Codex auth state and persists its workspace pointer", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		const onDisk = orgAccountStorage(Date.now() + 60_000);
		storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(onDisk));
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		const persist = vi.fn(async () => {});
		storageMocks.withAccountStorageTransaction.mockImplementation(
			async (fn: (storage: unknown, persist: unknown) => Promise<void>) =>
				fn(structuredClone(onDisk), persist),
		);
		codexCliWriterMocks.setCodexCliActiveSelection.mockResolvedValueOnce(true);
		const consoleSpy = silenceConsole("log");

		await runFix(
			["--json", "--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				reboundUnauthorizedAccountIdentity: orgRebinder(true),
			}),
		);

		expect(codexCliWriterMocks.setCodexCliActiveSelection).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				accountId: "personal-id",
				accessToken: "org-access",
				refreshToken: "org-refresh",
			}),
		);
		const persisted = persist.mock.calls[0]?.[0] as {
			accounts: Array<{
				accountId?: string;
				accountLabel?: string;
				currentWorkspaceIndex?: number;
				workspaces?: Array<{ id: string }>;
			}>;
		};
		expect(persisted.accounts[0]).toMatchObject({
			accountId: "personal-id",
			accountLabel: "Personal",
			currentWorkspaceIndex: 0,
		});
		expect(persisted.accounts[0]?.workspaces?.map((workspace) => workspace.id)).toEqual([
			"personal-id",
		]);
		const payload = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			codexActiveSynced: boolean | null;
		};
		expect(payload.codexActiveSynced).toBe(true);
	});

	it("runFix does not sync Codex auth state for a rebind in dry-run or on a non-active account", async () => {
		for (const [args, activeIndex] of [
			[["--json", "--live", "--dry-run"], 0],
			[["--json", "--live"], 1],
		] as const) {
			quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
			storageMocks.loadAccounts.mockResolvedValueOnce(orgAccountStorage(Date.now() + 60_000));
			quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
			quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
				status: 200,
				model: "gpt-5-codex",
				primary: {},
				secondary: {},
			});
			silenceConsole("log");

			await runFix(
				[...args],
				createDeps({
					hasUsableAccessToken: () => true,
					resolveActiveIndex: () => activeIndex,
					reboundUnauthorizedAccountIdentity: orgRebinder(),
				}),
			);
		}

		expect(codexCliWriterMocks.setCodexCliActiveSelection).not.toHaveBeenCalled();
	});

	// Greptile P1: the auth.json mirror must come from the committed snapshot.
	// Here another process switched the active account to row 2 after this run
	// loaded storage, so syncing the rebound row 1 would undo that switch.
	it("runFix does not sync Codex auth state when the committed active account is no longer the rebound one", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		const loaded = orgAccountStorage(Date.now() + 60_000);
		storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(loaded));
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		const committed = {
			...structuredClone(loaded),
			accounts: [
				...structuredClone(loaded.accounts),
				{
					email: "other@example.com",
					refreshToken: "other-refresh",
					accessToken: "other-access",
					expiresAt: Date.now() + 60_000,
					accountId: "other-id",
					accountIdSource: "token" as const,
					enabled: true,
				},
			],
			activeIndex: 1,
		};
		storageMocks.withAccountStorageTransaction.mockImplementation(
			async (fn: (storage: unknown, persist: unknown) => Promise<void>) =>
				fn(committed, vi.fn(async () => {})),
		);
		silenceConsole("log");

		await runFix(
			["--json", "--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				resolveActiveIndex: (storage) => storage.activeIndex,
				reboundUnauthorizedAccountIdentity: orgRebinder(),
			}),
		);

		expect(storageMocks.withAccountStorageTransaction).toHaveBeenCalledTimes(1);
		expect(codexCliWriterMocks.setCodexCliActiveSelection).not.toHaveBeenCalled();
	});

	// A rebound row is "token"-sourced, so the next refresh lets the real
	// applyTokenAccountIdentity follow the token's account claim. That claim is
	// the account the token was minted for, which is the authorized default, so
	// a second `fix --live` must leave the rebound id where it is.
	it("runFix keeps a rebound id across a second --live run that refreshes the token", async () => {
		const { applyTokenAccountIdentity, resolveStoredAccountIdentity } =
			await import("../lib/codex-manager/account-credentials.js");
		const { reboundUnauthorizedAccountIdentity } = await import(
			"../lib/auth/account-access.js"
		);
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({ accounts: [{ id: "personal-id" }], default_account_id: "personal-id" }),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			let onDisk = orgAccountStorage(Date.now() + 60_000);
			storageMocks.withAccountStorageTransaction.mockImplementation(
				async (fn: (storage: unknown, persist: unknown) => Promise<void>) =>
					fn(structuredClone(onDisk), async (next: typeof onDisk) => {
						onDisk = structuredClone(next);
					}),
			);
			quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
			quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
				status: 200,
				model: "gpt-5-codex",
				primary: {},
				secondary: {},
			});
			const deps = createDeps({
				applyTokenAccountIdentity,
				resolveStoredAccountIdentity,
				reboundUnauthorizedAccountIdentity: (account, token) =>
					reboundUnauthorizedAccountIdentity(account, token),
			});
			silenceConsole("log");

			storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(onDisk));
			await runFix(["--json", "--live"], { ...deps, hasUsableAccessToken: () => true });
			expect(onDisk.accounts[0]).toMatchObject({
				accountId: "personal-id",
				accountIdSource: "token",
			});

			refreshQueueMocks.queuedRefresh.mockReset();
			refreshQueueMocks.queuedRefresh.mockResolvedValue({
				type: "success",
				access: "personal-access-fresh",
				refresh: "personal-refresh-next",
				expires: Date.now() + 120_000,
			});
			extractAccountIdMock.mockReturnValue("personal-id");
			storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(onDisk));
			await runFix(["--json", "--live"], { ...deps, hasUsableAccessToken: () => false });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(onDisk.accounts[0]).toMatchObject({
				accountId: "personal-id",
				accountIdSource: "token",
				accessToken: "personal-access-fresh",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	// CodeRabbit (round 3): the mirror write has to happen while the storage
	// transaction still holds the lock, so a switch that commits right after
	// this repair also writes auth.json after it.
	it("runFix writes the Codex auth mirror inside the storage transaction", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		const onDisk = orgAccountStorage(Date.now() + 60_000);
		storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(onDisk));
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		const events: string[] = [];
		storageMocks.withAccountStorageTransaction.mockImplementation(
			async (fn: (storage: unknown, persist: unknown) => Promise<void>) => {
				await fn(structuredClone(onDisk), async () => {
					events.push("persist");
				});
				events.push("transaction-end");
			},
		);
		codexCliWriterMocks.setCodexCliActiveSelection.mockImplementationOnce(async () => {
			events.push("sync");
			return true;
		});
		silenceConsole("log");

		await runFix(
			["--json", "--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				reboundUnauthorizedAccountIdentity: orgRebinder(),
			}),
		);

		expect(events).toEqual(["persist", "sync", "transaction-end"]);
	});

	// CodeRabbit (round 3): another process added a row ahead of the rebound
	// one, so the committed active index is 2 while this run loaded it as 1.
	it("runFix names the committed active index in the sync retry hint", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		const loaded = orgAccountStorage(Date.now() + 60_000);
		storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(loaded));
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		const committed = {
			...structuredClone(loaded),
			accounts: [
				{
					email: "other@example.com",
					refreshToken: "other-refresh",
					accessToken: "other-access",
					expiresAt: Date.now() + 60_000,
					accountId: "other-id",
					accountIdSource: "token" as const,
					enabled: true,
				},
				...structuredClone(loaded.accounts),
			],
			activeIndex: 1,
		};
		storageMocks.withAccountStorageTransaction.mockImplementation(
			async (fn: (storage: unknown, persist: unknown) => Promise<void>) =>
				fn(committed, vi.fn(async () => {})),
		);
		codexCliWriterMocks.setCodexCliActiveSelection.mockResolvedValueOnce(false);
		const consoleSpy = silenceConsole("log");

		await runFix(
			["--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				resolveActiveIndex: (storage) => storage.activeIndex,
				reboundUnauthorizedAccountIdentity: orgRebinder(),
			}),
		);

		const output = consoleSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
		expect(codexCliWriterMocks.setCodexCliActiveSelection).toHaveBeenCalledTimes(1);
		expect(output).toContain("codex-multi-auth switch 2");
	});

	// Guard with a populated active slot: row 1 is rebound, row 2 is active
	// and untouched, so auth.json must not be rewritten.
	it("runFix does not sync Codex auth state when the active account was not rebound", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		const onDisk = orgAccountStorage(Date.now() + 60_000);
		const withOther = {
			...onDisk,
			accounts: [
				...onDisk.accounts,
				{
					email: "other@example.com",
					refreshToken: "other-refresh",
					accessToken: "other-access",
					expiresAt: Date.now() + 60_000,
					accountId: "other-id",
					accountIdSource: "token" as const,
					enabled: true,
				},
			],
			activeIndex: 1,
		};
		storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(withOther));
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		const persist = vi.fn(async () => {});
		storageMocks.withAccountStorageTransaction.mockImplementation(
			async (fn: (storage: unknown, persist: unknown) => Promise<void>) =>
				fn(structuredClone(withOther), persist),
		);
		silenceConsole("log");

		await runFix(
			["--json", "--live"],
			createDeps({
				hasUsableAccessToken: () => true,
				resolveActiveIndex: (storage) => storage.activeIndex,
				reboundUnauthorizedAccountIdentity: orgRebinder(),
			}),
		);

		expect(persist).toHaveBeenCalledTimes(1);
		expect(codexCliWriterMocks.setCodexCliActiveSelection).not.toHaveBeenCalled();
	});

	// CodeRabbit (round 4): the rebind trims the list but leaves the pointer
	// at 0, while another process moved the on-disk pointer to 1. Copying the
	// list alone saved `workspaces: [personal-id]` with `currentWorkspaceIndex: 1`.
	it("runFix saves the workspace list and pointer together after a concurrent pointer move", async () => {
		quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
		const loaded = orgAccountStorage(Date.now() + 60_000);
		const loadedAccount = loaded.accounts[0];
		if (!loadedAccount) throw new Error("fixture has no account");
		loadedAccount.currentWorkspaceIndex = 0;
		storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(loaded));
		const onDisk = structuredClone(loaded);
		const onDiskAccount = onDisk.accounts[0];
		if (!onDiskAccount) throw new Error("fixture has no account");
		onDiskAccount.currentWorkspaceIndex = 1;
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
		quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		const persist = vi.fn(async () => {});
		storageMocks.withAccountStorageTransaction.mockImplementation(
			async (fn: (storage: unknown, persist: unknown) => Promise<void>) =>
				fn(onDisk, persist),
		);
		const reboundUnauthorizedAccountIdentity = vi.fn(
			async (account: {
				accountId?: string;
				accountIdSource?: string;
				workspaces?: Array<{ id: string; name?: string; enabled: boolean }>;
			}) => {
				account.accountId = "personal-id";
				account.accountIdSource = "token";
				account.workspaces = [{ id: "personal-id", name: "Personal", enabled: true }];
				return { accountId: "personal-id", changed: true, rejected: "org-team" };
			},
		);
		silenceConsole("log");

		await runFix(
			["--json", "--live"],
			createDeps({ hasUsableAccessToken: () => true, reboundUnauthorizedAccountIdentity }),
		);

		const persisted = persist.mock.calls[0]?.[0] as {
			accounts: Array<{ currentWorkspaceIndex?: number; workspaces?: Array<{ id: string }> }>;
		};
		const saved = persisted.accounts[0];
		expect(saved?.workspaces?.map((workspace) => workspace.id)).toEqual(["personal-id"]);
		expect(saved?.currentWorkspaceIndex).toBe(0);
	});

	// fix --live keeps an explicit account's CodexCliMirror in step with the
	// backend: set while the explicit id is refused, cleared once it is not.
	it.each([
		{
			name: "clears the mirror once the explicit id is authorized",
			authorizedIds: ["ws-team", "personal-id"],
			mirror: { forAccountId: "ws-team", accountId: "personal-id" },
			expectedMirror: undefined,
			expectedSyncId: "ws-team",
		},
		{
			name: "sets the mirror while the explicit id is refused",
			authorizedIds: ["personal-id"],
			mirror: undefined,
			expectedMirror: { forAccountId: "ws-team", accountId: "personal-id" },
			expectedSyncId: "personal-id",
		},
	])("runFix --live $name", async ({ authorizedIds, mirror, expectedMirror, expectedSyncId }) => {
		const { refreshCodexCliMirror } = await import("../lib/auth/account-access.js");
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					accounts: authorizedIds.map((id) => ({ id })),
					default_account_id: "personal-id",
				}),
				{ status: 200 },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			quotaCacheMocks.loadQuotaCache.mockResolvedValueOnce({ byAccountId: {}, byEmail: {} });
			const onDisk = {
				version: 3 as const,
				accounts: [
					{
						email: "team@example.com",
						refreshToken: "team-refresh",
						accessToken: "team-access",
						expiresAt: Date.now() + 60_000,
						accountId: "ws-team",
						accountIdSource: "manual" as const,
						...(mirror ? { codexCliMirror: mirror } : {}),
						enabled: true,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: {},
			};
			storageMocks.loadAccounts.mockResolvedValueOnce(structuredClone(onDisk));
			quotaProbeMocks.fetchCodexQuotaSnapshot.mockReset();
			quotaProbeMocks.fetchCodexQuotaSnapshot.mockResolvedValue({
				status: 200,
				model: "gpt-5-codex",
				primary: {},
				secondary: {},
			});
			const persist = vi.fn(async () => {});
			storageMocks.withAccountStorageTransaction.mockImplementation(
				async (fn: (storage: unknown, persist: unknown) => Promise<void>) =>
					fn(structuredClone(onDisk), persist),
			);
			codexCliWriterMocks.setCodexCliActiveSelection.mockResolvedValueOnce(true);
			silenceConsole("log");

			await runFix(
				["--json", "--live"],
				createDeps({
					hasUsableAccessToken: () => true,
					refreshCodexCliMirror: (account, token) => refreshCodexCliMirror(account, token),
				}),
			);

			const persisted = persist.mock.calls[0]?.[0] as {
				accounts: Array<{ accountId?: string; codexCliMirror?: unknown }>;
			};
			expect(persisted.accounts[0]?.accountId).toBe("ws-team");
			expect(persisted.accounts[0]?.codexCliMirror).toEqual(expectedMirror);
			expect(codexCliWriterMocks.setCodexCliActiveSelection).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ accountId: expectedSyncId }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
