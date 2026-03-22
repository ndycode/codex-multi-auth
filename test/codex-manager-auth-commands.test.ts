import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExistingAccountInfo } from "../lib/cli.js";
import type {
	DashboardDisplaySettings,
} from "../lib/dashboard-settings.js";
import type { QuotaCacheData } from "../lib/quota-cache.js";
import type { AccountStorageV3, NamedBackupSummary } from "../lib/storage.js";
import type { TokenResult } from "../lib/types.js";

const {
	extractAccountEmailMock,
	extractAccountIdMock,
	formatAccountLabelMock,
	formatWaitTimeMock,
	sanitizeEmailMock,
	promptAddAnotherAccountMock,
	promptLoginModeMock,
	loadDashboardDisplaySettingsMock,
	loadQuotaCacheMock,
	fetchCodexQuotaSnapshotMock,
	queuedRefreshMock,
	loadAccountsMock,
	loadFlaggedAccountsMock,
	saveAccountsMock,
	setStoragePathMock,
	getNamedBackupsMock,
	restoreAccountsFromBackupMock,
	setCodexCliActiveSelectionMock,
	confirmMock,
	applyUiThemeFromDashboardSettingsMock,
	configureUnifiedSettingsMock,
} = vi.hoisted(() => ({
	extractAccountEmailMock: vi.fn(),
	extractAccountIdMock: vi.fn(),
	formatAccountLabelMock: vi.fn(),
	formatWaitTimeMock: vi.fn(),
	sanitizeEmailMock: vi.fn(),
	promptAddAnotherAccountMock: vi.fn(),
	promptLoginModeMock: vi.fn(),
	loadDashboardDisplaySettingsMock: vi.fn(),
	loadQuotaCacheMock: vi.fn(),
	fetchCodexQuotaSnapshotMock: vi.fn(),
	queuedRefreshMock: vi.fn(),
	loadAccountsMock: vi.fn(),
	loadFlaggedAccountsMock: vi.fn(),
	saveAccountsMock: vi.fn(),
	setStoragePathMock: vi.fn(),
	getNamedBackupsMock: vi.fn(),
	restoreAccountsFromBackupMock: vi.fn(),
	setCodexCliActiveSelectionMock: vi.fn(),
	confirmMock: vi.fn(),
	applyUiThemeFromDashboardSettingsMock: vi.fn(),
	configureUnifiedSettingsMock: vi.fn(),
}));

vi.mock("../lib/auth/browser.js", () => ({
	isBrowserLaunchSuppressed: vi.fn(() => false),
}));

vi.mock("../lib/accounts.js", () => ({
	extractAccountEmail: extractAccountEmailMock,
	extractAccountId: extractAccountIdMock,
	formatAccountLabel: formatAccountLabelMock,
	formatWaitTime: formatWaitTimeMock,
	sanitizeEmail: sanitizeEmailMock,
}));

vi.mock("../lib/cli.js", () => ({
	promptAddAnotherAccount: promptAddAnotherAccountMock,
	promptLoginMode: promptLoginModeMock,
}));

vi.mock("../lib/dashboard-settings.js", () => ({
	loadDashboardDisplaySettings: loadDashboardDisplaySettingsMock,
}));

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: loadQuotaCacheMock,
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
		...(actual as object),
		loadAccounts: loadAccountsMock,
		loadFlaggedAccounts: loadFlaggedAccountsMock,
		saveAccounts: saveAccountsMock,
		setStoragePath: setStoragePathMock,
		getNamedBackups: getNamedBackupsMock,
		restoreAccountsFromBackup: restoreAccountsFromBackupMock,
	};
});

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: setCodexCliActiveSelectionMock,
}));

vi.mock("../lib/ui/confirm.js", () => ({
	confirm: confirmMock,
}));

vi.mock("../lib/codex-manager/settings-hub.js", () => ({
	applyUiThemeFromDashboardSettings: applyUiThemeFromDashboardSettingsMock,
	configureUnifiedSettings: configureUnifiedSettingsMock,
}));

import {
	persistAndSyncSelectedAccount,
	runAuthLogin,
	runBest,
	runSwitch,
	type AuthCommandHelpers,
	type AuthLoginCommandDeps,
} from "../lib/codex-manager/auth-commands.js";

function createStorage(
	accounts: AccountStorageV3["accounts"] = [
		{
			email: "one@example.com",
			refreshToken: "refresh-token-1",
			accessToken: "access-token-1",
			accountId: "acct-1",
			expiresAt: Date.now() + 60_000,
			addedAt: 1,
			lastUsed: 1,
			enabled: true,
		},
	],
): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		activeIndexByFamily: { codex: 0 },
		accounts,
	};
}

function createHelpers(
	overrides: Partial<AuthCommandHelpers> = {},
): AuthCommandHelpers {
	return {
		resolveActiveIndex: vi.fn((storage: AccountStorageV3) => storage.activeIndex),
		hasUsableAccessToken: vi.fn(() => true),
		applyTokenAccountIdentity: vi.fn(
			(account, tokenAccountId) => {
				if (!tokenAccountId) return false;
				account.accountId = tokenAccountId;
				account.accountIdSource = "token";
				return true;
			},
		),
		normalizeFailureDetail: vi.fn(
			(message: string | undefined, reason: string | undefined) =>
				message ?? reason ?? "unknown",
		),
		...overrides,
	};
}

function createAuthLoginDeps(
	overrides: Partial<AuthLoginCommandDeps> = {},
): AuthLoginCommandDeps {
	return {
		...createHelpers(),
		stylePromptText: vi.fn((text: string) => text),
		runActionPanel: vi.fn(async (_title, _stage, action) => {
			await action();
		}),
		toExistingAccountInfo: vi.fn(
			(): ExistingAccountInfo[] => [],
		),
		countMenuQuotaRefreshTargets: vi.fn(() => 0),
		defaultMenuQuotaRefreshTtlMs: 60_000,
		refreshQuotaCacheForMenu: vi.fn(
			async (_storage, cache: QuotaCacheData): Promise<QuotaCacheData> => cache,
		),
		clearAccountsAndReset: vi.fn(async () => undefined),
		handleManageAction: vi.fn(async () => undefined),
		promptOAuthSignInMode: vi.fn(
			async (
				_backupOption: NamedBackupSummary | null,
				_backupDiscoveryWarning?: string | null,
			) => "cancel" as const,
		),
		promptBackupRestoreMode: vi.fn(
			async (_latestBackup: NamedBackupSummary) => "back" as const,
		),
		promptManualBackupSelection: vi.fn(
			async (_namedBackups: NamedBackupSummary[]) => null,
		),
		runOAuthFlow: vi.fn(
			async (): Promise<TokenResult> => ({
				type: "success",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				idToken: "id-token",
			}),
		),
		resolveAccountSelection: vi.fn((tokens) => tokens),
		persistAccountPool: vi.fn(async () => undefined),
		syncSelectionToCodex: vi.fn(async () => undefined),
		runHealthCheck: vi.fn(async () => undefined),
		runForecast: vi.fn(async () => 0),
		runFix: vi.fn(async () => 0),
		runVerifyFlagged: vi.fn(async () => 0),
		log: {
			debug: vi.fn(),
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-03-22T19:30:00.000Z"));
	vi.clearAllMocks();

	extractAccountEmailMock.mockReturnValue(undefined);
	extractAccountIdMock.mockReturnValue("acct-refreshed");
	formatAccountLabelMock.mockImplementation(
		(account: { email?: string }, index: number) =>
			account.email ? `${index + 1}. ${account.email}` : `Account ${index + 1}`,
	);
	formatWaitTimeMock.mockImplementation((waitMs: number) => `${waitMs}ms`);
	sanitizeEmailMock.mockImplementation(
		(email: string | undefined) =>
			typeof email === "string" ? email.toLowerCase() : undefined,
	);
	loadDashboardDisplaySettingsMock.mockResolvedValue(
		{} satisfies DashboardDisplaySettings,
	);
	loadQuotaCacheMock.mockResolvedValue({} satisfies QuotaCacheData);
	loadFlaggedAccountsMock.mockResolvedValue({
		version: 3,
		accounts: [],
	});
	getNamedBackupsMock.mockResolvedValue([]);
	restoreAccountsFromBackupMock.mockResolvedValue(createStorage());
	saveAccountsMock.mockResolvedValue(undefined);
	setCodexCliActiveSelectionMock.mockResolvedValue(true);
	queuedRefreshMock.mockResolvedValue({
		type: "success",
		access: "fresh-access-token",
		refresh: "fresh-refresh-token",
		expires: Date.now() + 60_000,
		idToken: "fresh-id-token",
	});
	fetchCodexQuotaSnapshotMock.mockResolvedValue({
		status: 200,
		model: "gpt-5-codex",
		primary: {},
		secondary: {},
	});
	confirmMock.mockResolvedValue(true);
	promptLoginModeMock.mockResolvedValue({ mode: "cancel" });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("codex-manager auth command helpers", () => {
	it("re-enables a selected account, refreshes missing tokens, and syncs it", async () => {
		extractAccountEmailMock.mockReturnValue("Refreshed@Example.com");
		const storage = createStorage([
			{
				email: "disabled@example.com",
				refreshToken: "stale-refresh-token",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
			},
		]);
		const helpers = createHelpers({
			hasUsableAccessToken: vi.fn(() => false),
		});

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "rotation",
			helpers,
		});

		expect(result).toEqual({ synced: true, wasDisabled: true });
		expect(storage.accounts[0]).toMatchObject({
			email: "refreshed@example.com",
			refreshToken: "fresh-refresh-token",
			accessToken: "fresh-access-token",
			accountId: "acct-refreshed",
			accountIdSource: "token",
			enabled: true,
			lastSwitchReason: "rotation",
		});
		expect(saveAccountsMock).toHaveBeenCalledWith(storage);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acct-refreshed",
				email: "refreshed@example.com",
				accessToken: "fresh-access-token",
				refreshToken: "fresh-refresh-token",
				idToken: "fresh-id-token",
			}),
		);
	});

	it("clamps preserved family indices when restoring smaller account pools", async () => {
		const storage = createStorage([
			{
				email: "first@example.com",
				refreshToken: "refresh-token-1",
				accessToken: "access-token-1",
				accountId: "acct-1",
				expiresAt: Date.now() + 60_000,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
			{
				email: "second@example.com",
				refreshToken: "refresh-token-2",
				accessToken: "access-token-2",
				accountId: "acct-2",
				expiresAt: Date.now() + 60_000,
				addedAt: 2,
				lastUsed: 2,
				enabled: true,
			},
			{
				email: "third@example.com",
				refreshToken: "refresh-token-3",
				accessToken: "access-token-3",
				accountId: "acct-3",
				expiresAt: Date.now() + 60_000,
				addedAt: 3,
				lastUsed: 3,
				enabled: true,
			},
		]);
		storage.activeIndexByFamily = {
			codex: 0,
			"gpt-5-codex": 1,
			"codex-max": 2,
			"gpt-5.2": 9,
			"gpt-5.1": -4,
		};

		await expect(
			persistAndSyncSelectedAccount({
				storage,
				targetIndex: 1,
				parsed: 2,
				switchReason: "restore",
				preserveActiveIndexByFamily: true,
				helpers: createHelpers(),
			}),
		).resolves.toEqual({ synced: true, wasDisabled: false });

		expect(storage.activeIndexByFamily).toEqual({
			codex: 1,
			"gpt-5-codex": 1,
			"codex-max": 2,
			"gpt-5.2": 2,
			"gpt-5.1": 0,
		});
	});

	it("keeps switching when refresh fails and surfaces the warning", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		queuedRefreshMock.mockResolvedValue({
			type: "error",
			reason: "auth-failure",
			message: "refresh expired",
		});
		setCodexCliActiveSelectionMock.mockResolvedValue(false);
		const storage = createStorage([
			{
				email: "warning@example.com",
				refreshToken: "warning-refresh-token",
				accessToken: "existing-access-token",
				accountId: "acct-warning",
				expiresAt: Date.now() - 1,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
		]);
		const helpers = createHelpers({
			hasUsableAccessToken: vi.fn(() => false),
		});

		const result = await persistAndSyncSelectedAccount({
			storage,
			targetIndex: 0,
			parsed: 1,
			switchReason: "best",
			helpers,
		});

		expect(result).toEqual({ synced: false, wasDisabled: false });
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("refresh expired"),
		);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acct-warning",
				accessToken: "existing-access-token",
			}),
		);
	});

	it("validates switch indices before mutating storage", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		loadAccountsMock.mockResolvedValue(createStorage());

		await expect(runSwitch([], createHelpers())).resolves.toBe(1);
		await expect(runSwitch(["bogus"], createHelpers())).resolves.toBe(1);
		await expect(runSwitch(["2"], createHelpers())).resolves.toBe(1);

		expect(errorSpy.mock.calls.map(([message]) => String(message))).toEqual(
			expect.arrayContaining([
				"Missing index. Usage: codex auth switch <index>",
				"Invalid index: bogus",
				"Index out of range. Valid range: 1-1",
			]),
		);
	});

	it("reports the current best account directly from the extracted command", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		loadAccountsMock.mockResolvedValue(createStorage());

		const result = await runBest(["--json"], createHelpers());

		expect(result).toBe(0);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			message: string;
			accountIndex: number;
		};
		expect(output.message).toContain("Already on best account");
		expect(output.accountIndex).toBe(1);
	});

	it("reports json output when runBest switches to a healthier account", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		setCodexCliActiveSelectionMock.mockResolvedValue(false);
		const storage = createStorage([
			{
				email: "current@example.com",
				refreshToken: "refresh-token-current",
				accessToken: "access-token-current",
				accountId: "acct-current",
				expiresAt: Date.now() + 60_000,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
				coolingDownUntil: Date.now() + 60_000,
			},
			{
				email: "best@example.com",
				refreshToken: "refresh-token-best",
				accessToken: "access-token-best",
				accountId: "acct-best",
				expiresAt: Date.now() + 60_000,
				addedAt: 2,
				lastUsed: 2,
				enabled: true,
			},
		]);
		loadAccountsMock.mockResolvedValue(storage);

		const result = await runBest(["--json"], createHelpers());

		expect(result).toBe(0);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? "{}")) as {
			message: string;
			accountIndex: number;
			synced: boolean;
			wasDisabled: boolean;
		};
		expect(output).toMatchObject({
			accountIndex: 2,
			synced: false,
			wasDisabled: false,
		});
		expect(output.message).toContain("Switched to best account");
		expect(storage.activeIndex).toBe(1);
	});

	it("warns when runBest switches locally but cannot sync Codex auth", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		setCodexCliActiveSelectionMock.mockResolvedValue(false);
		loadAccountsMock.mockResolvedValue(
			createStorage([
				{
					email: "current@example.com",
					refreshToken: "refresh-token-current",
					accessToken: "access-token-current",
					accountId: "acct-current",
					expiresAt: Date.now() + 60_000,
					addedAt: 1,
					lastUsed: 1,
					enabled: true,
					coolingDownUntil: Date.now() + 60_000,
				},
				{
					email: "best@example.com",
					refreshToken: "refresh-token-best",
					accessToken: "access-token-best",
					accountId: "acct-best",
					expiresAt: Date.now() + 60_000,
					addedAt: 2,
					lastUsed: 2,
					enabled: true,
				},
			]),
		);

		const result = await runBest([], createHelpers());

		expect(result).toBe(0);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Switched to best account 2"),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			"Codex auth sync did not complete. Multi-auth routing will still use this account.",
		);
	});

	it("serializes concurrent runBest live refresh writes per storage file", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const helpers = createHelpers({
			hasUsableAccessToken: vi.fn(() => false),
		});
		const makeExpiredStorage = (): AccountStorageV3 =>
			createStorage([
				{
					email: "live@example.com",
					refreshToken: "refresh-token-live",
					accessToken: "stale-access-token",
					accountId: "acct-live",
					expiresAt: Date.now() - 1,
					addedAt: 1,
					lastUsed: 1,
					enabled: true,
				},
			]);
		loadAccountsMock.mockImplementation(async () => makeExpiredStorage());

		let resolveFirstSaveStarted = (): void => undefined;
		const firstSaveStarted = new Promise<void>((resolve) => {
			resolveFirstSaveStarted = resolve;
		});
		let resolveFirstSave = (): void => undefined;
		const firstSaveBlocked = new Promise<void>((resolve) => {
			resolveFirstSave = resolve;
		});
		let activeSaves = 0;
		let maxActiveSaves = 0;
		let startedSaves = 0;
		saveAccountsMock.mockImplementation(async () => {
			startedSaves += 1;
			activeSaves += 1;
			maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
			if (startedSaves === 1) {
				resolveFirstSaveStarted();
				await firstSaveBlocked;
			}
			activeSaves -= 1;
		});

		const firstRun = runBest(["--live"], helpers);
		await firstSaveStarted;

		const secondRun = runBest(["--live"], helpers);
		await Promise.resolve();

		expect(loadAccountsMock).toHaveBeenCalledTimes(1);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);

		resolveFirstSave();

		await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([0, 0]);

		expect(loadAccountsMock).toHaveBeenCalledTimes(2);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(2);
		expect(saveAccountsMock).toHaveBeenCalledTimes(2);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(2);
		expect(maxActiveSaves).toBe(1);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Already on best account 1"),
		);
	});

	it("restores a backup through the extracted login flow and clamps family indices", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const restoredStorage = createStorage([
			{
				email: "first@example.com",
				refreshToken: "refresh-token-1",
				accessToken: "access-token-1",
				accountId: "acct-1",
				expiresAt: Date.now() + 60_000,
				addedAt: 1,
				lastUsed: 1,
				enabled: true,
			},
			{
				email: "second@example.com",
				refreshToken: "refresh-token-2",
				accessToken: "access-token-2",
				accountId: "acct-2",
				expiresAt: Date.now() + 60_000,
				addedAt: 2,
				lastUsed: 2,
				enabled: true,
			},
			{
				email: "third@example.com",
				refreshToken: "refresh-token-3",
				accessToken: "access-token-3",
				accountId: "acct-3",
				expiresAt: Date.now() + 60_000,
				addedAt: 3,
				lastUsed: 3,
				enabled: true,
			},
		]);
		restoredStorage.activeIndex = 1;
		restoredStorage.activeIndexByFamily = {
			codex: 0,
			"gpt-5-codex": 1,
			"codex-max": 7,
			"gpt-5.2": 9,
			"gpt-5.1": -3,
		};
		loadAccountsMock
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(restoredStorage)
			.mockResolvedValueOnce(restoredStorage);
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/latest.json",
				fileName: "latest.json",
				accountCount: 3,
				mtimeMs: Date.now(),
			},
		]);
		restoreAccountsFromBackupMock.mockResolvedValue(restoredStorage);
		const deps = createAuthLoginDeps({
			promptOAuthSignInMode: vi.fn(async () => "restore-backup" as const),
			promptBackupRestoreMode: vi.fn(async () => "latest" as const),
		});

		const result = await runAuthLogin([], deps);

		expect(result).toBe(0);
		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(restoreAccountsFromBackupMock).toHaveBeenCalledWith(
			"/mock/backups/latest.json",
			{ persist: false },
		);
		expect(saveAccountsMock).toHaveBeenCalledWith(restoredStorage);
		expect(restoredStorage.activeIndexByFamily).toEqual({
			codex: 1,
			"gpt-5-codex": 1,
			"codex-max": 2,
			"gpt-5.2": 2,
			"gpt-5.1": 0,
		});
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("latest.json"));
	});

	it("prints usage from runAuthLogin without entering the interactive flow", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const deps = createAuthLoginDeps();

		const result = await runAuthLogin(["--help"], deps);

		expect(result).toBe(0);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Codex Multi-Auth CLI"),
		);
		expect(loadAccountsMock).not.toHaveBeenCalled();
	});
});
