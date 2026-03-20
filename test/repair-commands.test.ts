import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepairCommandDeps } from "../lib/codex-manager/repair-commands.js";

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

const loadQuotaCacheMock = vi.fn();
const saveQuotaCacheMock = vi.fn();
const fetchCodexQuotaSnapshotMock = vi.fn();
const queuedRefreshMock = vi.fn();

const loadAccountsMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const setStoragePathMock = vi.fn();
const getStoragePathMock = vi.fn(() => "/mock/openai-codex-accounts.json");
const withAccountStorageTransactionMock = vi.fn();
const withAccountAndFlaggedStorageTransactionMock = vi.fn();
const withFlaggedStorageTransactionMock = vi.fn();

const getCodexCliAuthPathMock = vi.fn(() => "/mock/auth.json");
const getCodexCliConfigPathMock = vi.fn(() => "/mock/config.toml");
const loadCodexCliStateMock = vi.fn();
const setCodexCliActiveSelectionMock = vi.fn();

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

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: loadQuotaCacheMock,
	saveQuotaCache: saveQuotaCacheMock,
}));

vi.mock("../lib/quota-probe.js", () => ({
	fetchCodexQuotaSnapshot: fetchCodexQuotaSnapshotMock,
}));

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: queuedRefreshMock,
}));

vi.mock("../lib/storage.js", async () => {
	const actual = await vi.importActual("../lib/storage.js");
	return {
		...(actual as Record<string, unknown>),
		loadAccounts: loadAccountsMock,
		loadFlaggedAccounts: loadFlaggedAccountsMock,
		setStoragePath: setStoragePathMock,
		getStoragePath: getStoragePathMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
		withAccountAndFlaggedStorageTransaction:
			withAccountAndFlaggedStorageTransactionMock,
		withFlaggedStorageTransaction: withFlaggedStorageTransactionMock,
	};
});

vi.mock("../lib/codex-cli/state.js", () => ({
	getCodexCliAuthPath: getCodexCliAuthPathMock,
	getCodexCliConfigPath: getCodexCliConfigPathMock,
	loadCodexCliState: loadCodexCliStateMock,
}));

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: setCodexCliActiveSelectionMock,
}));

const {
	runDoctor,
	runFix,
	runVerifyFlagged,
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
		existsSyncMock.mockReturnValue(false);
		loadQuotaCacheMock.mockResolvedValue(null);
		loadCodexCliStateMock.mockResolvedValue(null);
		extractAccountEmailMock.mockReturnValue(undefined);
		extractAccountIdMock.mockReturnValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
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

		loadFlaggedAccountsMock.mockResolvedValue({
			version: 1,
			accounts: [structuredClone(flaggedAccount)],
		});
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: 999,
			idToken: "fresh-id-token",
		});
		extractAccountEmailMock.mockReturnValue("Recovered@example.com");
		extractAccountIdMock.mockReturnValue("token-account");
		withFlaggedStorageTransactionMock.mockImplementation(async (handler) =>
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
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
		expect(withFlaggedStorageTransactionMock).toHaveBeenCalledTimes(1);
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

	it("runFix uses the injected token-identity applier in the direct command path", async () => {
		const accountStorage = {
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
		let persistedAccountStorage: unknown;

		loadAccountsMock.mockResolvedValue(structuredClone(accountStorage));
		queuedRefreshMock.mockResolvedValue({
			type: "success",
			access: "new-access",
			refresh: "new-refresh",
			expires: 5000,
			idToken: "new-id-token",
		});
		extractAccountEmailMock.mockReturnValue("fresh@example.com");
		extractAccountIdMock.mockReturnValue("token-account");
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
			handler(structuredClone(accountStorage), async (nextStorage: unknown) => {
				persistedAccountStorage = nextStorage;
			}),
		);
		const applyTokenAccountIdentity = vi.fn((account: { accountId?: string; accountIdSource?: string }, refreshedAccountId: string | undefined) => {
			account.accountId = `dep-${refreshedAccountId}`;
			account.accountIdSource = "token";
			return true;
		});
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const exitCode = await runFix(
			["--json"],
			createDeps({ applyTokenAccountIdentity }),
		);

		expect(exitCode).toBe(0);
		expect(applyTokenAccountIdentity).toHaveBeenCalled();
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(persistedAccountStorage).toMatchObject({
			accounts: [
				expect.objectContaining({
					accountId: "dep-token-account",
					accountIdSource: "token",
					accessToken: "new-access",
					refreshToken: "new-refresh",
					email: "fresh@example.com",
				}),
			],
		});
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")).summary,
		).toMatchObject({
			healthy: 1,
		});
	});

	it("runDoctor uses the injected refresh-token validator in JSON diagnostics", async () => {
		loadAccountsMock.mockResolvedValue({
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
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
});
