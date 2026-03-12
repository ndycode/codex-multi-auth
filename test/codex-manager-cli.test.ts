import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAccountsMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const saveAccountsMock = vi.fn();
const saveFlaggedAccountsMock = vi.fn();
const setStoragePathMock = vi.fn();
const getStoragePathMock = vi.fn(() => "/mock/openai-codex-accounts.json");
const queuedRefreshMock = vi.fn();
const setCodexCliActiveSelectionMock = vi.fn();
const promptAddAnotherAccountMock = vi.fn();
const promptLoginModeMock = vi.fn();
const fetchCodexQuotaSnapshotMock = vi.fn();
const loadDashboardDisplaySettingsMock = vi.fn();
const saveDashboardDisplaySettingsMock = vi.fn();
const loadQuotaCacheMock = vi.fn();
const saveQuotaCacheMock = vi.fn();
const loadPluginConfigMock = vi.fn();
const savePluginConfigMock = vi.fn();
const previewCodexCliSyncMock = vi.fn();
const syncAccountStorageFromCodexCliMock = vi.fn();
const getCodexCliAccountsPathMock = vi.fn(() => "/mock/codex/accounts.json");
const getCodexCliAuthPathMock = vi.fn(() => "/mock/codex/auth.json");
const getCodexCliConfigPathMock = vi.fn(() => "/mock/codex/config.toml");
const isCodexCliSyncEnabledMock = vi.fn(() => true);
const loadCodexCliStateMock = vi.fn();
const getLastLiveAccountSyncSnapshotMock = vi.fn();
const selectMock = vi.fn();
const deleteSavedAccountsMock = vi.fn();
const resetLocalStateMock = vi.fn();
const deleteAccountAtIndexMock = vi.fn();

vi.mock("../lib/logger.js", () => ({
	createLogger: vi.fn(() => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	})),
	logWarn: vi.fn(),
}));

vi.mock("../lib/auth/auth.js", () => ({
	createAuthorizationFlow: vi.fn(),
	exchangeAuthorizationCode: vi.fn(),
	parseAuthorizationInput: vi.fn(),
	REDIRECT_URI: "http://localhost:1455/auth/callback",
}));

vi.mock("../lib/auth/browser.js", () => ({
	openBrowserUrl: vi.fn(),
	copyTextToClipboard: vi.fn(() => true),
}));

vi.mock("../lib/auth/server.js", () => ({
	startLocalOAuthServer: vi.fn(),
}));

vi.mock("../lib/cli.js", () => ({
	promptAddAnotherAccount: promptAddAnotherAccountMock,
	promptLoginMode: promptLoginModeMock,
}));

vi.mock("../lib/prompts/codex.js", () => ({
	MODEL_FAMILIES: ["codex"] as const,
}));

vi.mock("../lib/accounts.js", () => ({
	extractAccountEmail: vi.fn(() => undefined),
	extractAccountId: vi.fn(() => "acc_test"),
	formatAccountLabel: vi.fn((account: { email?: string }, index: number) =>
		account.email ? `${index + 1}. ${account.email}` : `Account ${index + 1}`,
	),
	formatCooldown: vi.fn(() => null),
	formatWaitTime: vi.fn(
		(ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`,
	),
	getAccountIdCandidates: vi.fn(() => []),
	resolveRequestAccountId: vi.fn(
		(
			_override: string | undefined,
			_source: string | undefined,
			tokenId: string | undefined,
		) => tokenId,
	),
	sanitizeEmail: vi.fn((email: string | undefined) =>
		typeof email === "string" ? email.toLowerCase() : undefined,
	),
	selectBestAccountCandidate: vi.fn(() => null),
}));

vi.mock("../lib/storage.js", () => ({
	loadAccounts: loadAccountsMock,
	loadFlaggedAccounts: loadFlaggedAccountsMock,
	saveAccounts: saveAccountsMock,
	saveFlaggedAccounts: saveFlaggedAccountsMock,
	setStoragePath: setStoragePathMock,
	getStoragePath: getStoragePathMock,
}));

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: queuedRefreshMock,
}));

vi.mock("../lib/codex-cli/writer.js", () => ({
	setCodexCliActiveSelection: setCodexCliActiveSelectionMock,
}));

vi.mock("../lib/codex-cli/sync.js", () => ({
	previewCodexCliSync: previewCodexCliSyncMock,
	syncAccountStorageFromCodexCli: syncAccountStorageFromCodexCliMock,
}));

vi.mock("../lib/codex-cli/state.js", () => ({
	getCodexCliAccountsPath: getCodexCliAccountsPathMock,
	getCodexCliAuthPath: getCodexCliAuthPathMock,
	getCodexCliConfigPath: getCodexCliConfigPathMock,
	isCodexCliSyncEnabled: isCodexCliSyncEnabledMock,
	loadCodexCliState: loadCodexCliStateMock,
}));

vi.mock("../lib/live-account-sync.js", () => ({
	getLastLiveAccountSyncSnapshot: getLastLiveAccountSyncSnapshotMock,
}));

vi.mock("../lib/quota-probe.js", () => ({
	fetchCodexQuotaSnapshot: fetchCodexQuotaSnapshotMock,
	formatQuotaSnapshotLine: vi.fn(() => "probe-ok"),
}));

vi.mock("../lib/dashboard-settings.js", () => ({
	DEFAULT_DASHBOARD_DISPLAY_SETTINGS: {
		showPerAccountRows: true,
		showQuotaDetails: true,
		showForecastReasons: true,
		showRecommendations: true,
		showLiveProbeNotes: true,
		menuAutoFetchLimits: true,
		menuSortEnabled: true,
		menuSortMode: "ready-first",
		menuSortPinCurrent: true,
		menuSortQuickSwitchVisibleRow: true,
	},
	getDashboardSettingsPath: vi.fn(() => "/mock/dashboard-settings.json"),
	loadDashboardDisplaySettings: loadDashboardDisplaySettingsMock,
	saveDashboardDisplaySettings: saveDashboardDisplaySettingsMock,
}));

vi.mock("../lib/config.js", async () => {
	const actual = await vi.importActual("../lib/config.js");
	return {
		...(actual as Record<string, unknown>),
		loadPluginConfig: loadPluginConfigMock,
		savePluginConfig: savePluginConfigMock,
	};
});

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: loadQuotaCacheMock,
	saveQuotaCache: saveQuotaCacheMock,
}));

vi.mock("../lib/destructive-actions.js", () => ({
	DESTRUCTIVE_ACTION_COPY: {
		deleteSavedAccounts: {
			label: "Delete Saved Accounts",
			stage: "Deleting saved accounts only",
			completed:
				"Deleted saved accounts. Saved accounts deleted; flagged/problem accounts, settings, and Codex CLI sync state kept.",
		},
		resetLocalState: {
			label: "Reset Local State",
			stage:
				"Clearing saved accounts, flagged/problem accounts, and quota cache",
			completed:
				"Reset local state. Saved accounts, flagged/problem accounts, and quota cache cleared; settings and Codex CLI sync state kept.",
		},
	},
	deleteSavedAccounts: deleteSavedAccountsMock,
	resetLocalState: resetLocalStateMock,
	deleteAccountAtIndex: deleteAccountAtIndexMock,
}));

vi.mock("../lib/ui/select.js", () => ({
	select: selectMock,
}));

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(
	process.stdin,
	"isTTY",
);
const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(
	process.stdout,
	"isTTY",
);

function setInteractiveTTY(enabled: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", {
		value: enabled,
		configurable: true,
	});
	Object.defineProperty(process.stdout, "isTTY", {
		value: enabled,
		configurable: true,
	});
}

function restoreTTYDescriptors(): void {
	if (stdinIsTTYDescriptor) {
		Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
	} else {
		delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
	}
	if (stdoutIsTTYDescriptor) {
		Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
	} else {
		delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
	}
}

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeErrnoError(message: string, code: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("codex manager cli commands", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		loadAccountsMock.mockReset();
		loadFlaggedAccountsMock.mockReset();
		saveAccountsMock.mockReset();
		saveFlaggedAccountsMock.mockReset();
		queuedRefreshMock.mockReset();
		setCodexCliActiveSelectionMock.mockReset();
		promptAddAnotherAccountMock.mockReset();
		promptLoginModeMock.mockReset();
		fetchCodexQuotaSnapshotMock.mockReset();
		loadDashboardDisplaySettingsMock.mockReset();
		saveDashboardDisplaySettingsMock.mockReset();
		loadQuotaCacheMock.mockReset();
		saveQuotaCacheMock.mockReset();
		loadPluginConfigMock.mockReset();
		savePluginConfigMock.mockReset();
		previewCodexCliSyncMock.mockReset();
		syncAccountStorageFromCodexCliMock.mockReset();
		getCodexCliAccountsPathMock.mockReset();
		getCodexCliAuthPathMock.mockReset();
		getCodexCliConfigPathMock.mockReset();
		isCodexCliSyncEnabledMock.mockReset();
		loadCodexCliStateMock.mockReset();
		getLastLiveAccountSyncSnapshotMock.mockReset();
		selectMock.mockReset();
		deleteAccountAtIndexMock.mockReset();
		deleteAccountAtIndexMock.mockResolvedValue(null);
		fetchCodexQuotaSnapshotMock.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {},
		});
		loadFlaggedAccountsMock.mockResolvedValue({
			version: 1,
			accounts: [],
		});
		loadDashboardDisplaySettingsMock.mockResolvedValue({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		});
		loadPluginConfigMock.mockReturnValue({});
		savePluginConfigMock.mockResolvedValue(undefined);
		previewCodexCliSyncMock.mockResolvedValue({
			status: "unavailable",
			statusDetail: "No Codex CLI sync source was found.",
			sourcePath: null,
			targetPath: "/mock/openai-codex-accounts.json",
			summary: {
				sourceAccountCount: 0,
				targetAccountCountBefore: 0,
				targetAccountCountAfter: 0,
				addedAccountCount: 0,
				updatedAccountCount: 0,
				unchangedAccountCount: 0,
				destinationOnlyPreservedCount: 0,
				selectionChanged: false,
			},
			backup: {
				enabled: true,
				targetPath: "/mock/openai-codex-accounts.json",
				rollbackPaths: [
					"/mock/openai-codex-accounts.json.bak",
					"/mock/openai-codex-accounts.json.wal",
				],
			},
			lastSync: null,
		});
		syncAccountStorageFromCodexCliMock.mockResolvedValue({
			changed: false,
			storage: null,
		});
		getCodexCliAccountsPathMock.mockReturnValue("/mock/codex/accounts.json");
		getCodexCliAuthPathMock.mockReturnValue("/mock/codex/auth.json");
		getCodexCliConfigPathMock.mockReturnValue("/mock/codex/config.toml");
		isCodexCliSyncEnabledMock.mockReturnValue(true);
		loadCodexCliStateMock.mockResolvedValue(null);
		getLastLiveAccountSyncSnapshotMock.mockReturnValue({
			path: null,
			running: false,
			lastKnownMtimeMs: null,
			lastSyncAt: null,
			reloadCount: 0,
			errorCount: 0,
		});
		selectMock.mockResolvedValue(undefined);
		restoreTTYDescriptors();
		setStoragePathMock.mockReset();
		getStoragePathMock.mockReturnValue("/mock/openai-codex-accounts.json");
	});

	afterEach(() => {
		restoreTTYDescriptors();
		vi.restoreAllMocks();
	});

	it("runs forecast in json mode", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
				{
					email: "b@example.com",
					refreshToken: "refresh-b",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: false,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "forecast", "--json"]);
		expect(exitCode).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			command: string;
			summary: { total: number };
			recommendation: { recommendedIndex: number | null };
		};
		expect(payload.command).toBe("forecast");
		expect(payload.summary.total).toBe(2);
		expect(payload.recommendation.recommendedIndex).toBe(0);
	});

	it("prints implemented 40-feature matrix", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "features"]);
		expect(exitCode).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toBe("Implemented features (40)");
		expect(
			logSpy.mock.calls.some((call) =>
				String(call[0]).includes(
					"40. OAuth browser-first flow with manual callback fallback",
				),
			),
		).toBe(true);
	});

	it("prints auth help when subcommand is --help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "--help"]);
		expect(exitCode).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toContain("Codex Multi-Auth CLI");
	});

	it("restores healthy flagged accounts into active storage", async () => {
		const now = Date.now();
		loadFlaggedAccountsMock.mockResolvedValueOnce({
			version: 1,
			accounts: [
				{
					refreshToken: "flagged-refresh",
					accountId: "acc_flagged",
					email: "flagged@example.com",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					flaggedAt: now - 5_000,
				},
			],
		});
		loadAccountsMock.mockResolvedValueOnce(null);
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-restored",
			refresh: "refresh-restored",
			expires: now + 3_600_000,
		});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"verify-flagged",
			"--json",
		]);
		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccountsMock).toHaveBeenCalledWith({
			version: 1,
			accounts: [],
		});
	});

	it("keeps flagged account when verification still fails", async () => {
		const now = Date.now();
		loadFlaggedAccountsMock.mockResolvedValueOnce({
			version: 1,
			accounts: [
				{
					refreshToken: "flagged-refresh",
					accountId: "acc_flagged",
					email: "flagged@example.com",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					flaggedAt: now - 5_000,
				},
			],
		});
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "token expired",
		});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"verify-flagged",
			"--json",
		]);
		expect(exitCode).toBe(0);
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(saveFlaggedAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccountsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						refreshToken: "flagged-refresh",
						lastError: "token expired",
					}),
				],
			}),
		);
	});

	it("runs fix dry-run without persisting changes", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "failed",
			reason: "missing_refresh",
			message: "No refresh token in response or input",
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"fix",
			"--dry-run",
			"--json",
		]);
		expect(exitCode).toBe(0);
		expect(saveAccountsMock).not.toHaveBeenCalled();

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			command: string;
			dryRun: boolean;
			changed: boolean;
			reports: Array<{ outcome: string }>;
		};
		expect(payload.command).toBe("fix");
		expect(payload.dryRun).toBe(true);
		expect(payload.changed).toBe(true);
		expect(payload.reports[0]?.outcome).toBe("warning-soft-failure");
	});

	it("persists rotated tokens during auth check and syncs active codex selection", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					accountId: "acc_old",
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now - 60_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-a-next",
			refresh: "refresh-a-next",
			expires: now + 3_600_000,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "check"]);
		expect(exitCode).toBe(0);
		expect(logSpy).toHaveBeenCalled();
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accessToken: "access-a-next",
				refreshToken: "refresh-a-next",
				expiresAt: now + 3_600_000,
			}),
		);
	});

	it("treats fresh access tokens as healthy without forcing refresh", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					accountId: "acc_live",
					email: "live@example.com",
					refreshToken: "refresh-live",
					accessToken: "access-live",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "check"]);
		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
		expect(
			logSpy.mock.calls.some((call) =>
				String(call[0]).includes("live session OK"),
			),
		).toBe(true);
	});

	it("runs fix apply mode and returns a switch recommendation", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
				{
					email: "b@example.com",
					refreshToken: "refresh-b",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
			],
		});

		queuedRefreshMock
			.mockResolvedValueOnce({
				type: "failed",
				reason: "http_error",
				statusCode: 401,
				message: "unauthorized",
			})
			.mockResolvedValueOnce({
				type: "success",
				access: "access-b",
				refresh: "refresh-b-next",
				expires: now + 3_600_000,
			});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "fix", "--json"]);
		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			changed: boolean;
			recommendedSwitchCommand: string | null;
		};
		expect(payload.changed).toBe(true);
		expect(payload.recommendedSwitchCommand).toBe("codex auth switch 2");
	});

	it("keeps local switch active when Codex auth sync fails", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(false);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "switch", "1"]);
		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Codex auth sync did not complete"),
		);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Switched to account 1"),
		);
	});

	it("refreshes token pair during switch when cached access token is missing", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-a-next",
			refresh: "refresh-a-next",
			expires: now + 3_600_000,
			idToken: "id-a-next",
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "switch", "1"]);

		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accessToken: "access-a-next",
				refreshToken: "refresh-a-next",
				expiresAt: now + 3_600_000,
				idToken: "id-a-next",
			}),
		);
	});

	it("warns on switch validation refresh failure and keeps local active index", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "refresh revoked",
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(false);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "switch", "1"]);

		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Switch validation refresh failed"),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Codex auth sync did not complete"),
		);
	});

	it("autoSyncActiveAccountToCodex syncs active account without refresh when access is valid", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);

		const { autoSyncActiveAccountToCodex } = await import(
			"../lib/codex-manager.js"
		);
		const synced = await autoSyncActiveAccountToCodex();

		expect(synced).toBe(true);
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acc_a",
				email: "a@example.com",
				accessToken: "access-a",
				refreshToken: "refresh-a",
			}),
		);
	});

	it("autoSyncActiveAccountToCodex refreshes missing access token then syncs", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-a-next",
			refresh: "refresh-a-next",
			expires: now + 3_600_000,
			idToken: "id-a-next",
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);

		const { autoSyncActiveAccountToCodex } = await import(
			"../lib/codex-manager.js"
		);
		const synced = await autoSyncActiveAccountToCodex();

		expect(synced).toBe(true);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accessToken: "access-a-next",
				refreshToken: "refresh-a-next",
				expiresAt: now + 3_600_000,
				idToken: "id-a-next",
			}),
		);
	});

	it("keeps auth login menu open after switch until user cancels", async () => {
		const now = Date.now();
		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
				{
					email: "b@example.com",
					accountId: "acc_b",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(storage);
		setCodexCliActiveSelectionMock.mockResolvedValue(true);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "manage", switchAccountIndex: 1 })
			.mockResolvedValueOnce({ mode: "cancel" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Switched to account 2"),
		);
		expect(logSpy).toHaveBeenCalledWith("Cancelled.");
	});

	it("marks newly added login account active so smart sort reflects it immediately", async () => {
		const now = Date.now();
		let storageState: {
			version: number;
			activeIndex: number;
			activeIndexByFamily: { codex: number };
			accounts: Array<{
				email: string;
				accountId: string;
				refreshToken: string;
				accessToken: string;
				expiresAt: number;
				addedAt: number;
				lastUsed: number;
				enabled: boolean;
			}>;
		} = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "old@example.com",
					accountId: "acc_old",
					refreshToken: "refresh-old",
					accessToken: "access-old",
					expiresAt: now + 3_600_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () =>
			structuredClone(storageState),
		);
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "add" })
			.mockResolvedValueOnce({ mode: "cancel" });
		promptAddAnotherAccountMock.mockResolvedValue(false);

		const authModule = await import("../lib/auth/auth.js");
		const createAuthorizationFlowMock = vi.mocked(
			authModule.createAuthorizationFlow,
		);
		const exchangeAuthorizationCodeMock = vi.mocked(
			authModule.exchangeAuthorizationCode,
		);
		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");
		const startLocalOAuthServerMock = vi.mocked(
			serverModule.startLocalOAuthServer,
		);

		const flow: Awaited<ReturnType<typeof authModule.createAuthorizationFlow>> =
			{
				pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
				state: "oauth-state",
				url: "https://auth.openai.com/mock",
			};
		createAuthorizationFlowMock.mockResolvedValue(flow);
		const oauthResult: Awaited<
			ReturnType<typeof authModule.exchangeAuthorizationCode>
		> = {
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: now + 7_200_000,
			idToken: "id-token-new",
			multiAccount: true,
		};
		exchangeAuthorizationCodeMock.mockResolvedValue(oauthResult);
		openBrowserUrlMock.mockReturnValue(true);
		const oauthServer: Awaited<
			ReturnType<typeof serverModule.startLocalOAuthServer>
		> = {
			ready: true,
			waitForCode: vi.fn(async () => ({ code: "oauth-code" })),
			close: vi.fn(),
		};
		startLocalOAuthServerMock.mockResolvedValue(oauthServer);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(storageState.accounts).toHaveLength(2);
		expect(storageState.activeIndex).toBe(1);
		expect(storageState.activeIndexByFamily.codex).toBe(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
	});

	it("runs full refresh test from login menu deep-check mode", async () => {
		const now = Date.now();
		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(storage);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "deep-check" })
			.mockResolvedValueOnce({ mode: "cancel" });
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-a-next",
			refresh: "refresh-a-next",
			expires: now + 7_200_000,
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(
			logSpy.mock.calls.some((call) =>
				String(call[0]).includes("full refresh test"),
			),
		).toBe(true);
	});

	it("runs quick check from login menu with live probe", async () => {
		const now = Date.now();
		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(storage);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "check" })
			.mockResolvedValueOnce({ mode: "cancel" });
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(queuedRefreshMock).not.toHaveBeenCalled();
	});

	it("auto-refreshes cached limits on menu open", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		loadDashboardDisplaySettingsMock.mockResolvedValue({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: true,
			menuSortEnabled: false,
			menuSortMode: "manual",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
	});

	it("keeps login loop running when settings action is selected", async () => {
		const now = Date.now();
		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(storage);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
	});

	it("passes smart-sorted accounts to auth menu while preserving source index mapping", async () => {
		const now = Date.now();
		const storage = {
			version: 3,
			activeIndex: 2,
			activeIndexByFamily: { codex: 2 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 3_000,
					lastUsed: now - 3_000,
					enabled: true,
				},
				{
					email: "b@example.com",
					accountId: "acc_b",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "c@example.com",
					accountId: "acc_c",
					refreshToken: "refresh-c",
					accessToken: "access-c",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(storage);
		loadDashboardDisplaySettingsMock.mockResolvedValue({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: false,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"a@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 80,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 80,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
				"b@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 0,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 0,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
				"c@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 60,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 60,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		const firstCallAccounts = promptLoginModeMock.mock.calls[0]?.[0] as Array<{
			email?: string;
			index: number;
			sourceIndex?: number;
			quickSwitchNumber?: number;
			isCurrentAccount?: boolean;
		}>;
		expect(firstCallAccounts.map((account) => account.email)).toEqual([
			"b@example.com",
			"c@example.com",
			"a@example.com",
		]);
		expect(firstCallAccounts.map((account) => account.index)).toEqual([
			0, 1, 2,
		]);
		expect(firstCallAccounts.map((account) => account.sourceIndex)).toEqual([
			1, 2, 0,
		]);
		expect(
			firstCallAccounts.map((account) => account.quickSwitchNumber),
		).toEqual([1, 2, 3]);
		expect(firstCallAccounts[0]?.isCurrentAccount).toBe(false);
		expect(firstCallAccounts[1]?.isCurrentAccount).toBe(true);
	});

	it("uses source-number quick switch mapping when visible-row quick switch is disabled", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "acc_a",
					refreshToken: "refresh-a",
					accessToken: "access-a",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
				{
					email: "b@example.com",
					accountId: "acc_b",
					refreshToken: "refresh-b",
					accessToken: "access-b",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
			],
		});
		loadDashboardDisplaySettingsMock.mockResolvedValue({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: false,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: false,
			menuSortQuickSwitchVisibleRow: false,
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"a@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 80,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 80,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
				"b@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 0,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 0,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		const firstCallAccounts = promptLoginModeMock.mock.calls[0]?.[0] as Array<{
			email?: string;
			quickSwitchNumber?: number;
		}>;
		expect(firstCallAccounts.map((account) => account.email)).toEqual([
			"b@example.com",
			"a@example.com",
		]);
		expect(
			firstCallAccounts.map((account) => account.quickSwitchNumber),
		).toEqual([2, 1]);
	});

	it("runs doctor command in json mode", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "real@example.net",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "doctor", "--json"]);
		expect(exitCode).toBe(0);

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			command: string;
			summary: { ok: number; warn: number; error: number };
			checks: Array<{ key: string }>;
		};
		expect(payload.command).toBe("doctor");
		expect(payload.summary.error).toBe(0);
		expect(payload.checks.some((check) => check.key === "active-index")).toBe(
			true,
		);
	});

	it("runs doctor --fix in dry-run mode", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 4,
			activeIndexByFamily: { codex: 4 },
			accounts: [
				{
					email: "account1@example.com",
					accessToken: "access-a",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: false,
				},
				{
					email: "account2@example.com",
					accessToken: "access-b",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: false,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"doctor",
			"--fix",
			"--dry-run",
			"--json",
		]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).not.toHaveBeenCalled();
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			fix: {
				enabled: boolean;
				dryRun: boolean;
				changed: boolean;
				actions: Array<{ key: string }>;
			};
		};
		expect(payload.fix.enabled).toBe(true);
		expect(payload.fix.dryRun).toBe(true);
		expect(payload.fix.changed).toBe(true);
		expect(payload.fix.actions.length).toBeGreaterThan(0);
	});

	it("runs report command in json mode", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "real@example.net",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
				{
					email: "other@example.net",
					refreshToken: "refresh-b",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: false,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "report", "--json"]);

		expect(exitCode).toBe(0);
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			command: string;
			accounts: { total: number; enabled: number; disabled: number };
		};
		expect(payload.command).toBe("report");
		expect(payload.accounts.total).toBe(2);
		expect(payload.accounts.enabled).toBe(1);
		expect(payload.accounts.disabled).toBe(1);
	});

	it("drives interactive settings hub across sections and persists dashboard/backend changes", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "settings@example.com",
					accountId: "acc_settings",
					refreshToken: "refresh-settings",
					accessToken: "access-settings",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storage));
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		const selectResults: Array<Record<string, unknown>> = [
			{ type: "account-list" },
			{ type: "toggle", key: "menuShowStatusBadge" },
			{ type: "cycle-sort-mode" },
			{ type: "cycle-layout-mode" },
			{ type: "save" },
			{ type: "summary-fields" },
			{ type: "move-down", key: "last-used" },
			{ type: "toggle", key: "status" },
			{ type: "save" },
			{ type: "behavior" },
			{ type: "toggle-pause" },
			{ type: "toggle-menu-limit-fetch" },
			{ type: "set-menu-quota-ttl", ttlMs: 300_000 },
			{ type: "set-delay", delayMs: 1_000 },
			{ type: "save" },
			{ type: "theme" },
			{ type: "set-palette", palette: "blue" },
			{ type: "set-accent", accent: "cyan" },
			{ type: "save" },
			{ type: "backend" },
			{ type: "open-category", key: "rotation-quota" },
			{ type: "toggle", key: "preemptiveQuotaEnabled" },
			{ type: "bump", key: "preemptiveQuotaRemainingPercent5h", direction: 1 },
			{ type: "back" },
			{ type: "save" },
			{ type: "back" },
		];
		selectMock.mockImplementation(
			async () => selectResults.shift() ?? { type: "back" },
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(selectResults).toHaveLength(0);
		expect(saveDashboardDisplaySettingsMock).toHaveBeenCalled();
		expect(savePluginConfigMock).toHaveBeenCalledTimes(1);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				preemptiveQuotaEnabled: expect.any(Boolean),
				preemptiveQuotaRemainingPercent5h: expect.any(Number),
			}),
		);
	});

	it("separates everyday settings from advanced operator controls in the hub", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "settings-groups@example.com",
					accountId: "acc_settings_groups",
					refreshToken: "refresh-settings-groups",
					accessToken: "access-settings-groups",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		let firstMenuItems: Array<{
			label?: string;
			hint?: string;
			color?: string;
		}> = [];
		let firstMenuOptions:
			| {
					message?: string;
					subtitle?: string;
			  }
			| undefined;
		selectMock.mockImplementation(async (items, options) => {
			if (firstMenuItems.length === 0) {
				firstMenuItems = items as Array<{
					label?: string;
					hint?: string;
					color?: string;
				}>;
				firstMenuOptions = options as {
					message?: string;
					subtitle?: string;
				};
				return { type: "back" };
			}
			return { type: "back" };
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(firstMenuOptions?.message).toBe("Settings");
		expect(firstMenuOptions?.subtitle).toContain("everyday dashboard settings");
		const menuText = firstMenuItems
			.map(
				(item) =>
					`${item.label ?? ""}\n${item.hint ?? ""}\n${item.color ?? ""}`,
			)
			.join("\n");
		expect(menuText).toContain("Everyday Settings");
		expect(menuText).toContain("List Appearance");
		expect(menuText).toContain("Details Line");
		expect(menuText).toContain("Results & Refresh");
		expect(menuText).toContain("Colors");
		expect(menuText).toContain("Advanced & Operator");
		expect(menuText).toContain("Codex CLI Sync");
		expect(menuText).toContain("Advanced Backend Controls");
		expect(menuText).toContain("Show badges, sorting, and how much detail");
		expect(menuText).toContain("Preview and apply one-way sync");
		expect(menuText).toContain(
			"Tune retry, quota, sync, recovery, and timeout internals.",
		);
	});

	it("shows sync-center source/runtime context and keeps apply one-way", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "sync@example.com",
					accountId: "acc_sync",
					refreshToken: "refresh-sync",
					accessToken: "access-sync",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(storage);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });
		loadCodexCliStateMock
			.mockResolvedValueOnce({
				path: "/mock/codex/accounts.json",
				accounts: [
					{
						accountId: "acc_sync",
						email: "sync@example.com",
						accessToken: "access-sync",
						refreshToken: "refresh-sync",
					},
				],
				activeAccountId: "acc_sync",
			})
			.mockResolvedValueOnce({
				path: "/mock/codex/accounts.json",
				accounts: [
					{
						accountId: "acc_sync",
						email: "sync@example.com",
						accessToken: "access-sync",
						refreshToken: "refresh-sync",
					},
				],
				activeAccountId: "acc_sync",
			});
		getLastLiveAccountSyncSnapshotMock.mockReturnValue({
			path: "/mock/openai-codex-accounts.json",
			running: true,
			lastKnownMtimeMs: now,
			lastSyncAt: now,
			reloadCount: 2,
			errorCount: 0,
		});
		previewCodexCliSyncMock
			.mockResolvedValueOnce({
				status: "ready",
				statusDetail:
					"Preview ready: 1 add, 0 update, 1 destination-only preserved.",
				sourcePath: "/mock/codex/accounts.json",
				targetPath: "/mock/openai-codex-accounts.json",
				summary: {
					sourceAccountCount: 1,
					targetAccountCountBefore: 1,
					targetAccountCountAfter: 2,
					addedAccountCount: 1,
					updatedAccountCount: 0,
					unchangedAccountCount: 0,
					destinationOnlyPreservedCount: 1,
					selectionChanged: true,
				},
				backup: {
					enabled: true,
					targetPath: "/mock/openai-codex-accounts.json",
					rollbackPaths: [
						"/mock/openai-codex-accounts.json.bak",
						"/mock/openai-codex-accounts.json.wal",
					],
				},
				lastSync: {
					outcome: "changed",
					runAt: now - 60_000,
				},
			})
			.mockResolvedValueOnce({
				status: "noop",
				statusDetail: "Target already matches the current one-way sync result.",
				sourcePath: "/mock/codex/accounts.json",
				targetPath: "/mock/openai-codex-accounts.json",
				summary: {
					sourceAccountCount: 1,
					targetAccountCountBefore: 2,
					targetAccountCountAfter: 2,
					addedAccountCount: 0,
					updatedAccountCount: 0,
					unchangedAccountCount: 1,
					destinationOnlyPreservedCount: 1,
					selectionChanged: false,
				},
				backup: {
					enabled: true,
					targetPath: "/mock/openai-codex-accounts.json",
					rollbackPaths: [
						"/mock/openai-codex-accounts.json.bak",
						"/mock/openai-codex-accounts.json.wal",
					],
				},
				lastSync: {
					outcome: "noop",
					runAt: now,
				},
			});
		syncAccountStorageFromCodexCliMock.mockResolvedValueOnce({
			changed: true,
			storage: {
				...storage,
				accounts: [
					...storage.accounts,
					{
						email: "codex@example.com",
						accountId: "acc_codex",
						refreshToken: "refresh-codex",
						addedAt: now,
						lastUsed: now,
					},
				],
			},
		});

		let selectCall = 0;
		selectMock.mockImplementation(async (items) => {
			selectCall += 1;
			if (selectCall === 1) return { type: "sync-center" };
			if (selectCall === 2) {
				const text = items
					.map(
						(item: { label?: string; hint?: string }) =>
							`${item.label ?? ""}\n${item.hint ?? ""}`,
					)
					.join("\n");
				expect(text).toContain("Target path: /mock/openai-codex-accounts.json");
				expect(text).toContain("/mock/codex/accounts.json");
				expect(text).toContain("/mock/codex/auth.json");
				expect(text).toContain("/mock/codex/config.toml");
				expect(text).toContain("Preview mode: read-only until apply");
				expect(text).toContain(
					"Selection precedence: accountId -> email -> preserve newer local choice",
				);
				expect(text).toContain("One-way sync never deletes accounts");
				expect(text).toContain("Live watcher: running");
				return { type: "apply" };
			}
			if (selectCall === 3) return { type: "back" };
			return { type: "back" };
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(syncAccountStorageFromCodexCliMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(previewCodexCliSyncMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ panel: "account-list", mode: "windows-ebusy" },
		{ panel: "summary-fields", mode: "windows-ebusy" },
		{ panel: "behavior", mode: "windows-ebusy" },
		{ panel: "theme", mode: "windows-ebusy" },
		{ panel: "backend", mode: "windows-ebusy" },
		{ panel: "account-list", mode: "concurrent-save-ordering" },
		{ panel: "summary-fields", mode: "concurrent-save-ordering" },
		{ panel: "behavior", mode: "concurrent-save-ordering" },
		{ panel: "theme", mode: "concurrent-save-ordering" },
		{ panel: "backend", mode: "concurrent-save-ordering" },
		{ panel: "account-list", mode: "token-refresh-race" },
		{ panel: "summary-fields", mode: "token-refresh-race" },
		{ panel: "behavior", mode: "token-refresh-race" },
		{ panel: "theme", mode: "token-refresh-race" },
		{ panel: "backend", mode: "token-refresh-race" },
	] as const)("keeps no-save-on-cancel contract for panel=$panel mode=$mode", async ({
		panel,
		mode,
	}) => {
		setInteractiveTTY(true);
		const now = Date.now();
		let originalRuntimeTheme: {
			v2Enabled: boolean;
			colorProfile: string;
			glyphMode: string;
			palette: string;
			accent: string;
		} | null = null;
		if (panel === "theme") {
			const runtime = await import("../lib/ui/runtime.js");
			runtime.resetUiRuntimeOptions();
			const snapshot = runtime.getUiRuntimeOptions();
			originalRuntimeTheme = {
				v2Enabled: snapshot.v2Enabled,
				colorProfile: snapshot.colorProfile,
				glyphMode: snapshot.glyphMode,
				palette: snapshot.palette,
				accent: snapshot.accent,
			};
		}
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "cancel-settings@example.com",
					accountId: "acc_cancel_settings",
					refreshToken: "refresh-cancel-settings",
					accessToken: "access-cancel-settings",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		if (mode === "windows-ebusy") {
			const busy = makeErrnoError("busy", "EBUSY");
			saveDashboardDisplaySettingsMock.mockRejectedValue(busy);
			savePluginConfigMock.mockRejectedValue(busy);
		}
		if (mode === "concurrent-save-ordering") {
			const dashboardDeferred = createDeferred<void>();
			const pluginDeferred = createDeferred<void>();
			saveDashboardDisplaySettingsMock.mockImplementation(
				async () => dashboardDeferred.promise,
			);
			savePluginConfigMock.mockImplementation(
				async () => pluginDeferred.promise,
			);
			queueMicrotask(() => {
				dashboardDeferred.resolve(undefined);
				pluginDeferred.resolve(undefined);
			});
		}
		if (mode === "token-refresh-race") {
			const refreshDeferred = createDeferred<{
				type: "success";
				access: string;
				refresh: string;
				expires: number;
			}>();
			queuedRefreshMock.mockImplementation(async () => refreshDeferred.promise);
			queueMicrotask(() => {
				refreshDeferred.resolve({
					type: "success",
					access: "race-access",
					refresh: "race-refresh",
					expires: now + 3_600_000,
				});
			});
		}

		let selectCall = 0;
		selectMock.mockImplementation(async (_items, options) => {
			selectCall += 1;
			const onInput = (
				options as { onInput?: (raw: string) => unknown } | undefined
			)?.onInput;
			if (selectCall === 1) return { type: panel };

			if (panel === "account-list") {
				if (selectCall === 2)
					return { type: "toggle", key: "menuShowStatusBadge" };
				if (selectCall === 3) return onInput?.("q") ?? { type: "cancel" };
				return { type: "back" };
			}
			if (panel === "summary-fields") {
				if (selectCall === 2) return { type: "toggle", key: "status" };
				if (selectCall === 3) return onInput?.("q") ?? { type: "cancel" };
				return { type: "back" };
			}
			if (panel === "behavior") {
				if (selectCall === 2) return { type: "toggle-pause" };
				if (selectCall === 3) return onInput?.("q") ?? { type: "cancel" };
				return { type: "back" };
			}
			if (panel === "theme") {
				if (selectCall === 2) return { type: "set-palette", palette: "blue" };
				if (selectCall === 3) return onInput?.("q") ?? { type: "cancel" };
				return { type: "back" };
			}

			if (selectCall === 2)
				return { type: "open-category", key: "rotation-quota" };
			if (selectCall === 3)
				return { type: "toggle", key: "preemptiveQuotaEnabled" };
			if (selectCall === 4) return { type: "back" };
			if (selectCall === 5) return onInput?.("q") ?? { type: "cancel" };
			return { type: "back" };
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveDashboardDisplaySettingsMock).not.toHaveBeenCalled();
		expect(savePluginConfigMock).not.toHaveBeenCalled();
		if (panel === "theme") {
			const runtime = await import("../lib/ui/runtime.js");
			const restored = runtime.getUiRuntimeOptions();
			expect({
				v2Enabled: restored.v2Enabled,
				colorProfile: restored.colorProfile,
				glyphMode: restored.glyphMode,
				palette: restored.palette,
				accent: restored.accent,
			}).toEqual(originalRuntimeTheme);
		}
	});

	it("retries transient EBUSY dashboard save and keeps settings flow alive", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "retry-dashboard@example.com",
					accountId: "acc_retry_dashboard",
					refreshToken: "refresh-retry-dashboard",
					accessToken: "access-retry-dashboard",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		selectMock
			.mockResolvedValueOnce({ type: "behavior" })
			.mockResolvedValueOnce({ type: "toggle-pause" })
			.mockResolvedValueOnce({ type: "save" })
			.mockResolvedValueOnce({ type: "back" });

		saveDashboardDisplaySettingsMock
			.mockRejectedValueOnce(makeErrnoError("dashboard busy", "EBUSY"))
			.mockResolvedValueOnce(undefined);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledTimes(2);
		expect(savePluginConfigMock).not.toHaveBeenCalled();
	});

	it("retries transient 429-like backend save and keeps settings flow alive", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "retry-backend@example.com",
					accountId: "acc_retry_backend",
					refreshToken: "refresh-retry-backend",
					accessToken: "access-retry-backend",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		selectMock
			.mockResolvedValueOnce({ type: "backend" })
			.mockResolvedValueOnce({ type: "open-category", key: "rotation-quota" })
			.mockResolvedValueOnce({ type: "toggle", key: "preemptiveQuotaEnabled" })
			.mockResolvedValueOnce({ type: "back" })
			.mockResolvedValueOnce({ type: "save" })
			.mockResolvedValueOnce({ type: "back" });

		const rateLimitError = Object.assign(new Error("rate limited"), {
			status: 429,
			retryAfterMs: 1,
		});
		savePluginConfigMock
			.mockRejectedValueOnce(rateLimitError)
			.mockResolvedValueOnce(undefined);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(savePluginConfigMock).toHaveBeenCalledTimes(2);
	});

	it("does not abort settings flow when dashboard saves keep failing after retries", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "retry-exhausted@example.com",
					accountId: "acc_retry_exhausted",
					refreshToken: "refresh-retry-exhausted",
					accessToken: "access-retry-exhausted",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		selectMock
			.mockResolvedValueOnce({ type: "theme" })
			.mockResolvedValueOnce({ type: "set-palette", palette: "blue" })
			.mockResolvedValueOnce({ type: "save" })
			.mockResolvedValueOnce({ type: "back" });

		const rateLimitError = Object.assign(new Error("slow down"), {
			statusCode: 429,
			retryAfterMs: 1,
		});
		saveDashboardDisplaySettingsMock.mockRejectedValue(rateLimitError);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledTimes(4);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("merges behavior edits with latest disk settings to avoid stale overwrite", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "merge-settings@example.com",
					accountId: "acc_merge_settings",
					refreshToken: "refresh-merge-settings",
					accessToken: "access-merge-settings",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });
		const initialSettings = {
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			actionAutoReturnMs: 2_000,
			actionPauseOnKey: true,
			menuAutoFetchLimits: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
			uiThemePreset: "green",
			uiAccentColor: "green",
		} as const;
		let settingsReadCount = 0;
		loadDashboardDisplaySettingsMock.mockImplementation(async () => {
			settingsReadCount += 1;
			if (settingsReadCount >= 3) {
				return {
					...initialSettings,
					uiThemePreset: "blue",
					uiAccentColor: "cyan",
				};
			}
			return initialSettings;
		});

		selectMock
			.mockResolvedValueOnce({ type: "behavior" })
			.mockResolvedValueOnce({ type: "toggle-pause" })
			.mockResolvedValueOnce({ type: "save" })
			.mockResolvedValueOnce({ type: "back" });

		saveDashboardDisplaySettingsMock.mockResolvedValue(undefined);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				uiThemePreset: "blue",
				uiAccentColor: "cyan",
				actionPauseOnKey: false,
			}),
		);
	});

	it("resets only focused panel fields and preserves unrelated draft settings", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "panel-reset@example.com",
					accountId: "acc_panel_reset",
					refreshToken: "refresh-panel-reset",
					accessToken: "access-panel-reset",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		loadDashboardDisplaySettingsMock.mockResolvedValue({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			actionAutoReturnMs: 2_000,
			actionPauseOnKey: true,
			menuAutoFetchLimits: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
			menuShowStatusBadge: false,
			uiThemePreset: "blue",
			uiAccentColor: "cyan",
		});

		selectMock
			.mockResolvedValueOnce({ type: "account-list" })
			.mockResolvedValueOnce({ type: "reset" })
			.mockResolvedValueOnce({ type: "save" })
			.mockResolvedValueOnce({ type: "back" });

		saveDashboardDisplaySettingsMock.mockResolvedValue(undefined);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				uiThemePreset: "blue",
				uiAccentColor: "cyan",
			}),
		);
	});

	it("keeps last account enabled during fix to avoid lockout", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "solo@example.com",
					refreshToken: "refresh-solo",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "failed",
			reason: "http_error",
			statusCode: 401,
			message: "unauthorized",
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "fix", "--json"]);
		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.enabled).toBe(
			true,
		);

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(payload.reports[0]?.outcome).toBe("warning-soft-failure");
		expect(payload.reports[0]?.message).toContain("avoid lockout");
	});

	it("runs live fix path with probe success and probe fallback warning", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "live-ok@example.com",
					accountId: "acc_live_ok",
					refreshToken: "refresh-live-ok",
					accessToken: "access-live-ok",
					expiresAt: now + 3_600_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
				{
					email: "live-warn@example.com",
					accountId: "acc_live_warn",
					refreshToken: "refresh-live-warn",
					accessToken: "access-live-warn",
					expiresAt: now - 5_000,
					addedAt: now - 4_000,
					lastUsed: now - 4_000,
					enabled: true,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-live-warn-next",
			refresh: "refresh-live-warn-next",
			expires: now + 7_200_000,
		});
		fetchCodexQuotaSnapshotMock
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 20,
					windowMinutes: 300,
					resetAtMs: now + 1_000,
				},
				secondary: {
					usedPercent: 10,
					windowMinutes: 10080,
					resetAtMs: now + 2_000,
				},
			})
			.mockRejectedValueOnce(new Error("live probe temporary failure"));

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"fix",
			"--live",
			"--json",
		]);

		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(
			payload.reports.some(
				(report) =>
					report.outcome === "healthy" &&
					report.message.includes("live session OK"),
			),
		).toBe(true);
		expect(
			payload.reports.some(
				(report) =>
					report.outcome === "warning-soft-failure" &&
					report.message.includes("refresh succeeded but live probe failed"),
			),
		).toBe(true);
	});

	it("deletes an account from manage mode and persists storage", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "first@example.com",
					refreshToken: "refresh-first",
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "second@example.com",
					refreshToken: "refresh-second",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "manage", deleteAccountIndex: 1 })
			.mockResolvedValueOnce({ mode: "cancel" });
		deleteAccountAtIndexMock.mockResolvedValueOnce({
			storage: {
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "first@example.com",
						refreshToken: "refresh-first",
						addedAt: now - 2_000,
						lastUsed: now - 2_000,
						enabled: true,
					},
				],
			},
			flagged: { version: 1, accounts: [] },
			removedAccount: {
				refreshToken: "refresh-second",
				addedAt: now - 1_000,
				lastUsed: now - 1_000,
				accountIdSource: undefined,
				enabled: true,
			},
			removedFlaggedCount: 0,
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(deleteAccountAtIndexMock).toHaveBeenCalledTimes(1);
		expect(deleteAccountAtIndexMock.mock.calls[0]?.[0]?.index).toBe(1);
	});

	it("toggles account enabled state from manage mode", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "toggle@example.com",
					refreshToken: "refresh-toggle",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "manage", toggleAccountIndex: 0 })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.enabled).toBe(
			false,
		);
	});

	it("skips destructive work when user cancels from menu", async () => {
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "keep@example.com",
					refreshToken: "keep-refresh",
					addedAt: Date.now(),
					lastUsed: Date.now(),
				},
			],
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(deleteSavedAccountsMock).not.toHaveBeenCalled();
		expect(resetLocalStateMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
	});

	it("deletes saved accounts only when requested", async () => {
		const now = Date.now();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "first@example.com",
					refreshToken: "refresh-first",
					addedAt: now,
					lastUsed: now,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "fresh", deleteAll: true })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(deleteSavedAccountsMock).toHaveBeenCalledTimes(1);
		expect(resetLocalStateMock).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			"Deleted saved accounts. Saved accounts deleted; flagged/problem accounts, settings, and Codex CLI sync state kept.",
		);
		logSpy.mockRestore();
	});

	it("resets local state when reset mode is chosen", async () => {
		const now = Date.now();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "first@example.com",
					refreshToken: "refresh-first",
					addedAt: now,
					lastUsed: now,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "reset" })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(resetLocalStateMock).toHaveBeenCalledTimes(1);
		expect(deleteSavedAccountsMock).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			"Reset local state. Saved accounts, flagged/problem accounts, and quota cache cleared; settings and Codex CLI sync state kept.",
		);
		logSpy.mockRestore();
	});

	it("keeps settings unchanged in non-interactive mode and returns to menu", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "non-tty@example.com",
					accountId: "acc_non_tty",
					refreshToken: "refresh-non-tty",
					accessToken: "access-non-tty",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectMock).not.toHaveBeenCalled();
		expect(saveDashboardDisplaySettingsMock).not.toHaveBeenCalled();
		expect(savePluginConfigMock).not.toHaveBeenCalled();
	});
});
