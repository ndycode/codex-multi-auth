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
	REDIRECT_URI: "http://127.0.0.1:1455/auth/callback",
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
	formatWaitTime: vi.fn((ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`),
	getAccountIdCandidates: vi.fn(() => []),
	resolveRequestAccountId: vi.fn(
		(_override: string | undefined, _source: string | undefined, tokenId: string | undefined) =>
			tokenId,
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

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: loadQuotaCacheMock,
	saveQuotaCache: saveQuotaCacheMock,
}));

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
		setStoragePathMock.mockReset();
		getStoragePathMock.mockReturnValue("/mock/openai-codex-accounts.json");
	});

	afterEach(() => {
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
				String(call[0]).includes("40. OAuth browser-first flow with manual callback fallback"),
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

		const exitCode = await runCodexMultiAuthCli(["auth", "verify-flagged", "--json"]);
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

		const exitCode = await runCodexMultiAuthCli(["auth", "verify-flagged", "--json"]);
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

		const exitCode = await runCodexMultiAuthCli(["auth", "fix", "--dry-run", "--json"]);
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
		expect(logSpy.mock.calls.some((call) => String(call[0]).includes("live session OK"))).toBe(true);
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

	it("fails switch when Codex auth sync fails", async () => {
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
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "switch", "1"]);
		expect(exitCode).toBe(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Codex auth sync failed"),
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
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "add" })
			.mockResolvedValueOnce({ mode: "cancel" });
		promptAddAnotherAccountMock.mockResolvedValue(false);

		const authModule = await import("../lib/auth/auth.js");
		const createAuthorizationFlowMock = vi.mocked(authModule.createAuthorizationFlow);
		const exchangeAuthorizationCodeMock = vi.mocked(authModule.exchangeAuthorizationCode);
		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");
		const startLocalOAuthServerMock = vi.mocked(serverModule.startLocalOAuthServer);

		const flow: Awaited<ReturnType<typeof authModule.createAuthorizationFlow>> = {
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		};
		createAuthorizationFlowMock.mockResolvedValue(flow);
		const oauthResult: Awaited<ReturnType<typeof authModule.exchangeAuthorizationCode>> = {
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: now + 7_200_000,
			idToken: "id-token-new",
			multiAccount: true,
		};
		exchangeAuthorizationCodeMock.mockResolvedValue(oauthResult);
		openBrowserUrlMock.mockReturnValue(true);
		const oauthServer: Awaited<ReturnType<typeof serverModule.startLocalOAuthServer>> = {
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
		expect(logSpy.mock.calls.some((call) => String(call[0]).includes("full refresh test"))).toBe(true);
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
					primary: { usedPercent: 80, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 80, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
				"b@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 0, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 0, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
				"c@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 60, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 60, windowMinutes: 10080, resetAtMs: now + 2_000 },
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
		expect(firstCallAccounts.map((account) => account.index)).toEqual([0, 1, 2]);
		expect(firstCallAccounts.map((account) => account.sourceIndex)).toEqual([1, 2, 0]);
		expect(firstCallAccounts.map((account) => account.quickSwitchNumber)).toEqual([1, 2, 3]);
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
					primary: { usedPercent: 80, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 80, windowMinutes: 10080, resetAtMs: now + 2_000 },
				},
				"b@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: { usedPercent: 0, windowMinutes: 300, resetAtMs: now + 1_000 },
					secondary: { usedPercent: 0, windowMinutes: 10080, resetAtMs: now + 2_000 },
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
		expect(firstCallAccounts.map((account) => account.quickSwitchNumber)).toEqual([2, 1]);
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
		expect(payload.checks.some((check) => check.key === "active-index")).toBe(true);
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
		const exitCode = await runCodexMultiAuthCli(["auth", "doctor", "--fix", "--dry-run", "--json"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).not.toHaveBeenCalled();
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			fix: { enabled: boolean; dryRun: boolean; changed: boolean; actions: Array<{ key: string }> };
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
});
