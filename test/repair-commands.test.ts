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

	it("runVerifyFlagged keeps remainingFlagged in the JSON schema for empty and no-op paths", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		loadFlaggedAccountsMock.mockResolvedValueOnce({
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
		loadFlaggedAccountsMock.mockResolvedValueOnce({
			version: 1,
			accounts: [structuredClone(flaggedAccount)],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "failed",
			reason: "revoked",
			message: "still broken",
		});

		exitCode = await runVerifyFlagged(
			["--json", "--no-restore"],
			createDeps(),
		);

		expect(exitCode).toBe(0);
		expect(withFlaggedStorageTransactionMock).not.toHaveBeenCalled();
		expect(
			JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "{}")),
		).toMatchObject({
			total: 1,
			remainingFlagged: 1,
			stillFlagged: 1,
			changed: false,
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

		loadAccountsMock.mockResolvedValue(structuredClone(prescanStorage));
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
			handler(structuredClone(inTransactionStorage), async (nextStorage: unknown) => {
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
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		loadAccountsMock.mockResolvedValueOnce(null);
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

		loadQuotaCacheMock.mockResolvedValueOnce({
			byAccountId: {},
			byEmail: {},
		});
		loadAccountsMock.mockResolvedValueOnce({
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
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
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
		expect(withAccountStorageTransactionMock).not.toHaveBeenCalled();
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
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

	it("runFix does not double-count a live probe failure followed by refresh fallback", async () => {
		loadQuotaCacheMock.mockResolvedValueOnce({
			byAccountId: {},
			byEmail: {},
		});
		loadAccountsMock.mockResolvedValueOnce({
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
		fetchCodexQuotaSnapshotMock
			.mockRejectedValueOnce(new Error("probe unavailable"))
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {},
				secondary: {},
			});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-fallback-next",
			refresh: "refresh-fallback-next",
			expires: Date.now() + 120_000,
			idToken: "id-token-fallback",
		});
		extractAccountEmailMock.mockReturnValue("fallback@example.com");
		extractAccountIdMock.mockReturnValue("fallback-account");
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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

	it("runDoctor checks refresh token shape even when email is missing", async () => {
		loadAccountsMock.mockResolvedValueOnce({
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

	it("runDoctor derives auto-fix state from the final action set", async () => {
		const now = Date.now();
		let persistedAccountStorage: unknown;
		loadAccountsMock.mockResolvedValueOnce({
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
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
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
		queuedRefreshMock.mockResolvedValueOnce({
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
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const exitCode = await runDoctor(
			["--json", "--fix"],
			createDeps({
				hasUsableAccessToken: () => false,
			}),
		);

		expect(exitCode).toBe(0);
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
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
		loadAccountsMock.mockResolvedValueOnce(prescanStorage);
		withAccountStorageTransactionMock.mockImplementation(async (handler) =>
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
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const exitCode = await runDoctor(
			["--json", "--fix"],
			createDeps({
				hasUsableAccessToken: () => true,
			}),
		);

		expect(exitCode).toBe(0);
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
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
});
