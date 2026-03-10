import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAccountsMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const getRestoreAssessmentMock = vi.fn();
const saveAccountsMock = vi.fn();
const saveFlaggedAccountsMock = vi.fn();
const clearAccountsMock = vi.fn();
const createEmptyAccountStorageMock = vi.fn(() => ({
	version: 3,
	accounts: [],
	activeIndex: 0,
	activeIndexByFamily: { codex: 0 },
}));
const withAccountStorageTransactionMock = vi.fn();
const setStoragePathMock = vi.fn();
const getStoragePathMock = vi.fn(() => "/mock/openai-codex-accounts.json");
const queuedRefreshMock = vi.fn();
const setCodexCliActiveSelectionMock = vi.fn();
const promptAddAnotherAccountMock = vi.fn();
const promptLoginModeMock = vi.fn();
const promptOpenTuiAuthDashboardMock = vi.fn();
const promptInkAuthDashboardMock = vi.fn();
const configureInkUnifiedSettingsMock = vi.fn();
const promptInkRestoreForLoginMock = vi.fn();
const isNonInteractiveModeMock = vi.fn();
const fetchCodexQuotaSnapshotMock = vi.fn();
const loadDashboardDisplaySettingsMock = vi.fn();
const saveDashboardDisplaySettingsMock = vi.fn();
const loadQuotaCacheMock = vi.fn();
const saveQuotaCacheMock = vi.fn();
const loadPluginConfigMock = vi.fn();
const savePluginConfigMock = vi.fn();
const selectMock = vi.fn();

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
	isNonInteractiveMode: isNonInteractiveModeMock,
	promptAddAnotherAccount: promptAddAnotherAccountMock,
	promptLoginMode: promptLoginModeMock,
}));

vi.mock("../runtime/opentui/prompt.js", () => ({
	promptOpenTuiAuthDashboard: promptOpenTuiAuthDashboardMock,
}));

vi.mock("../lib/ui-ink/index.js", () => ({
	configureInkUnifiedSettings: configureInkUnifiedSettingsMock,
	promptInkAuthDashboard: promptInkAuthDashboardMock,
	promptInkRestoreForLogin: promptInkRestoreForLoginMock,
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
	cloneAccountStorage: vi.fn((storage: unknown) =>
		storage == null ? storage : structuredClone(storage),
	),
	createEmptyAccountStorage: createEmptyAccountStorageMock,
	getRestoreAssessment: getRestoreAssessmentMock,
	loadAccounts: loadAccountsMock,
	loadFlaggedAccounts: loadFlaggedAccountsMock,
	saveAccounts: saveAccountsMock,
	saveFlaggedAccounts: saveFlaggedAccountsMock,
	clearAccounts: clearAccountsMock,
	setStoragePath: setStoragePathMock,
	getStoragePath: getStoragePathMock,
	withAccountStorageTransaction: withAccountStorageTransactionMock,
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

vi.mock("../lib/config.js", () => ({
	DEFAULT_PLUGIN_CONFIG: {
		codexMode: true,
		codexTuiV2: true,
		codexTuiColorProfile: "truecolor",
		codexTuiGlyphMode: "ascii",
		fastSession: false,
		fastSessionStrategy: "hybrid",
		fastSessionMaxInputItems: 30,
		retryAllAccountsRateLimited: true,
		retryAllAccountsMaxWaitMs: 0,
		retryAllAccountsMaxRetries: Infinity,
		unsupportedCodexPolicy: "strict",
		fallbackOnUnsupportedCodexModel: false,
		fallbackToGpt52OnUnsupportedGpt53: true,
		unsupportedCodexFallbackChain: {},
		tokenRefreshSkewMs: 60_000,
		rateLimitToastDebounceMs: 60_000,
		toastDurationMs: 5_000,
		perProjectAccounts: true,
		sessionRecovery: true,
		autoResume: true,
		parallelProbing: false,
		parallelProbingMaxConcurrency: 2,
		emptyResponseMaxRetries: 2,
		emptyResponseRetryDelayMs: 1_000,
		pidOffsetEnabled: false,
		fetchTimeoutMs: 60_000,
		streamStallTimeoutMs: 45_000,
		liveAccountSync: true,
		liveAccountSyncDebounceMs: 250,
		liveAccountSyncPollMs: 2_000,
		sessionAffinity: true,
		sessionAffinityTtlMs: 1_200_000,
		sessionAffinityMaxEntries: 512,
		proactiveRefreshGuardian: true,
		proactiveRefreshIntervalMs: 60_000,
		proactiveRefreshBufferMs: 300_000,
		networkErrorCooldownMs: 6_000,
		serverErrorCooldownMs: 4_000,
		storageBackupEnabled: true,
		preemptiveQuotaEnabled: true,
		preemptiveQuotaRemainingPercent5h: 5,
		preemptiveQuotaRemainingPercent7d: 5,
		preemptiveQuotaMaxDeferralMs: 7_200_000,
	},
	getDefaultPluginConfig: vi.fn(() => ({
		codexMode: true,
		codexTuiV2: true,
		codexTuiColorProfile: "truecolor",
		codexTuiGlyphMode: "ascii",
		fastSession: false,
		fastSessionStrategy: "hybrid",
		fastSessionMaxInputItems: 30,
		retryAllAccountsRateLimited: true,
		retryAllAccountsMaxWaitMs: 0,
		retryAllAccountsMaxRetries: Infinity,
		unsupportedCodexPolicy: "strict",
		fallbackOnUnsupportedCodexModel: false,
		fallbackToGpt52OnUnsupportedGpt53: true,
		unsupportedCodexFallbackChain: {},
		tokenRefreshSkewMs: 60_000,
		rateLimitToastDebounceMs: 60_000,
		toastDurationMs: 5_000,
		perProjectAccounts: true,
		sessionRecovery: true,
		autoResume: true,
		parallelProbing: false,
		parallelProbingMaxConcurrency: 2,
		emptyResponseMaxRetries: 2,
		emptyResponseRetryDelayMs: 1_000,
		pidOffsetEnabled: false,
		fetchTimeoutMs: 60_000,
		streamStallTimeoutMs: 45_000,
		liveAccountSync: true,
		liveAccountSyncDebounceMs: 250,
		liveAccountSyncPollMs: 2_000,
		sessionAffinity: true,
		sessionAffinityTtlMs: 1_200_000,
		sessionAffinityMaxEntries: 512,
		proactiveRefreshGuardian: true,
		proactiveRefreshIntervalMs: 60_000,
		proactiveRefreshBufferMs: 300_000,
		networkErrorCooldownMs: 6_000,
		serverErrorCooldownMs: 4_000,
		storageBackupEnabled: true,
		preemptiveQuotaEnabled: true,
		preemptiveQuotaRemainingPercent5h: 5,
		preemptiveQuotaRemainingPercent7d: 5,
		preemptiveQuotaMaxDeferralMs: 7_200_000,
	})),
	loadPluginConfig: loadPluginConfigMock,
	savePluginConfig: savePluginConfigMock,
}));

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: loadQuotaCacheMock,
	saveQuotaCache: saveQuotaCacheMock,
}));

vi.mock("../lib/ui/select.js", () => ({
	select: selectMock,
}));

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let defaultConsoleLogSpy: ReturnType<typeof vi.spyOn> | null = null;

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

function createRestoreAssessment(overrides: Partial<{
	storagePath: string;
	restoreEligible: boolean;
	restoreReason: "empty-storage" | "intentional-reset" | "missing-storage";
	latestSnapshot: {
		kind: string;
		path: string;
		exists: boolean;
		valid: boolean;
		accountCount?: number;
		bytes?: number;
		mtimeMs?: number;
		version?: number;
	};
	backupMetadata: {
		accounts: {
			storagePath: string;
			latestValidPath?: string;
			snapshotCount: number;
			validSnapshotCount: number;
			snapshots: Array<Record<string, unknown>>;
		};
		flaggedAccounts: {
			storagePath: string;
			latestValidPath?: string;
			snapshotCount: number;
			validSnapshotCount: number;
			snapshots: Array<Record<string, unknown>>;
		};
	};
}> = {}) {
	const storagePath = overrides.storagePath ?? "/mock/openai-codex-accounts.json";
	const flaggedPath = "/mock/openai-codex-flagged-accounts.json";
	return {
		storagePath,
		restoreEligible: overrides.restoreEligible ?? false,
		restoreReason: overrides.restoreReason,
		latestSnapshot: overrides.latestSnapshot,
		backupMetadata: overrides.backupMetadata ?? {
			accounts: {
				storagePath,
				snapshotCount: 0,
				validSnapshotCount: 0,
				snapshots: [],
			},
			flaggedAccounts: {
				storagePath: flaggedPath,
				snapshotCount: 0,
				validSnapshotCount: 0,
				snapshots: [],
			},
		},
	};
}

describe("codex manager cli commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		defaultConsoleLogSpy?.mockRestore();
		defaultConsoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		loadAccountsMock.mockReset();
		loadFlaggedAccountsMock.mockReset();
		getRestoreAssessmentMock.mockReset();
		saveAccountsMock.mockReset();
		saveFlaggedAccountsMock.mockReset();
		clearAccountsMock.mockReset();
		createEmptyAccountStorageMock.mockReset();
		withAccountStorageTransactionMock.mockReset();
		queuedRefreshMock.mockReset();
		setCodexCliActiveSelectionMock.mockReset();
		promptAddAnotherAccountMock.mockReset();
		promptLoginModeMock.mockReset();
		promptOpenTuiAuthDashboardMock.mockReset();
		promptInkAuthDashboardMock.mockReset();
		configureInkUnifiedSettingsMock.mockReset();
		promptInkRestoreForLoginMock.mockReset();
		isNonInteractiveModeMock.mockReset();
		fetchCodexQuotaSnapshotMock.mockReset();
		loadDashboardDisplaySettingsMock.mockReset();
		saveDashboardDisplaySettingsMock.mockReset();
		loadQuotaCacheMock.mockReset();
		saveQuotaCacheMock.mockReset();
		loadPluginConfigMock.mockReset();
		savePluginConfigMock.mockReset();
		selectMock.mockReset();
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
		getRestoreAssessmentMock.mockResolvedValue(createRestoreAssessment());
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
		isNonInteractiveModeMock.mockImplementation(() => {
			if (process.env.FORCE_INTERACTIVE_MODE === "1") return false;
			return !process.stdin.isTTY || !process.stdout.isTTY;
		});
		selectMock.mockResolvedValue(undefined);
		promptOpenTuiAuthDashboardMock.mockResolvedValue(null);
		promptInkAuthDashboardMock.mockResolvedValue(null);
		configureInkUnifiedSettingsMock.mockResolvedValue(false);
		promptInkRestoreForLoginMock.mockResolvedValue(null);
		restoreTTYDescriptors();
		setInteractiveTTY(true);
		setStoragePathMock.mockReset();
		getStoragePathMock.mockReturnValue("/mock/openai-codex-accounts.json");
		withAccountStorageTransactionMock.mockImplementation(async (handler) => {
			const latestLoadResult = loadAccountsMock.mock.results[loadAccountsMock.mock.results.length - 1];
			const current = latestLoadResult ? await latestLoadResult.value : await loadAccountsMock();
			return handler(
				current == null ? current : structuredClone(current),
				async (storage) => saveAccountsMock(storage),
			);
		});
	});

	afterEach(() => {
		defaultConsoleLogSpy?.mockRestore();
		defaultConsoleLogSpy = null;
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

		const { autoSyncActiveAccountToCodex } = await import("../lib/codex-manager.js");
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

		const { autoSyncActiveAccountToCodex } = await import("../lib/codex-manager.js");
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
		promptOpenTuiAuthDashboardMock
			.mockResolvedValueOnce({ mode: "manage", switchAccountIndex: 1 })
			.mockResolvedValueOnce({ mode: "cancel" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(promptOpenTuiAuthDashboardMock).toHaveBeenCalledTimes(2);
		expect(promptInkAuthDashboardMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Switched to account 2"),
		);
		expect(logSpy).toHaveBeenCalledWith("Cancelled.");
	});

	it("prompts to restore the latest backup before opening the login dashboard", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		const restoredStorage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "restored@example.com",
					accountId: "acc_restored",
					refreshToken: "refresh-restored",
					accessToken: "access-restored",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		getRestoreAssessmentMock.mockResolvedValueOnce(createRestoreAssessment({
			restoreEligible: true,
			restoreReason: "missing-storage",
			latestSnapshot: {
				kind: "accounts-backup",
				path: "/mock/openai-codex-accounts.json.bak",
				exists: true,
				valid: true,
				accountCount: 1,
				bytes: 512,
				mtimeMs: now - 10_000,
				version: 3,
			},
			backupMetadata: {
				accounts: {
					storagePath: "/mock/openai-codex-accounts.json",
					latestValidPath: "/mock/openai-codex-accounts.json.bak",
					snapshotCount: 2,
					validSnapshotCount: 1,
					snapshots: [
						{
							kind: "accounts-primary",
							path: "/mock/openai-codex-accounts.json",
							exists: false,
							valid: false,
						},
						{
							kind: "accounts-backup",
							path: "/mock/openai-codex-accounts.json.bak",
							exists: true,
							valid: true,
							accountCount: 1,
							bytes: 512,
							mtimeMs: now - 10_000,
							version: 3,
						},
					],
				},
				flaggedAccounts: {
					storagePath: "/mock/openai-codex-flagged-accounts.json",
					snapshotCount: 0,
					validSnapshotCount: 0,
					snapshots: [],
				},
			},
		}));
		loadAccountsMock.mockResolvedValue(restoredStorage);
		selectMock.mockResolvedValueOnce(true);
		promptOpenTuiAuthDashboardMock.mockResolvedValueOnce({ mode: "cancel" });
		promptInkRestoreForLoginMock.mockResolvedValueOnce(true);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(promptInkRestoreForLoginMock).toHaveBeenCalledTimes(1);
		expect(promptInkRestoreForLoginMock).toHaveBeenCalledWith(
			expect.objectContaining({
				reasonText: expect.stringContaining("No saved account pool was found."),
				snapshotInfo: expect.stringContaining("/mock/openai-codex-accounts.json.bak"),
				snapshotCount: 1,
			}),
		);
		expect(selectMock).not.toHaveBeenCalled();
		expect(promptOpenTuiAuthDashboardMock).toHaveBeenCalledTimes(1);
		expect(promptOpenTuiAuthDashboardMock).toHaveBeenCalledWith(
			expect.objectContaining({
				dashboard: expect.objectContaining({
					menuOptions: expect.objectContaining({
						statusMessage: expect.stringContaining("Restored 1 account"),
					}),
				}),
			}),
		);
		expect(promptInkAuthDashboardMock).not.toHaveBeenCalled();
	});


	it("skips restore prompting deterministically in non-interactive mode", async () => {
		setInteractiveTTY(false);
		const now = Date.now();
		getRestoreAssessmentMock.mockResolvedValueOnce(createRestoreAssessment({
			restoreEligible: true,
			restoreReason: "missing-storage",
			latestSnapshot: {
				kind: "accounts-backup",
				path: "/mock/openai-codex-accounts.json.bak",
				exists: true,
				valid: true,
				accountCount: 2,
				bytes: 768,
				mtimeMs: now - 10_000,
				version: 3,
			},
			backupMetadata: {
				accounts: {
					storagePath: "/mock/openai-codex-accounts.json",
					latestValidPath: "/mock/openai-codex-accounts.json.bak",
					snapshotCount: 2,
					validSnapshotCount: 1,
					snapshots: [
						{
							kind: "accounts-primary",
							path: "/mock/openai-codex-accounts.json",
							exists: false,
							valid: false,
						},
						{
							kind: "accounts-backup",
							path: "/mock/openai-codex-accounts.json.bak",
							exists: true,
							valid: true,
							accountCount: 2,
							bytes: 768,
							mtimeMs: now - 10_000,
							version: 3,
						},
					],
				},
				flaggedAccounts: {
					storagePath: "/mock/openai-codex-flagged-accounts.json",
					snapshotCount: 0,
					validSnapshotCount: 0,
					snapshots: [],
				},
			},
		}));

		const authModule = await import("../lib/auth/auth.js");
		const createAuthorizationFlowMock = vi.mocked(authModule.createAuthorizationFlow);
		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");
		const startLocalOAuthServerMock = vi.mocked(serverModule.startLocalOAuthServer);

		createAuthorizationFlowMock.mockResolvedValue({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		openBrowserUrlMock.mockReturnValue(true);
		startLocalOAuthServerMock.mockResolvedValue({
			ready: false,
			waitForCode: vi.fn(async () => null),
			close: vi.fn(),
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).toHaveBeenCalledWith({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		});
		expect(
			logSpy.mock.calls.some((call) => String(call[0]).includes("non-interactive mode skips the prompt")),
		).toBe(true);
		expect(promptOpenTuiAuthDashboardMock).not.toHaveBeenCalled();
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
		promptOpenTuiAuthDashboardMock
			.mockResolvedValueOnce({ mode: "add" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce("browser");
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
		promptOpenTuiAuthDashboardMock
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
		promptOpenTuiAuthDashboardMock
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
		promptOpenTuiAuthDashboardMock.mockResolvedValueOnce({ mode: "cancel" });

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
		promptOpenTuiAuthDashboardMock
			.mockResolvedValueOnce({ mode: "settings" })
			.mockResolvedValueOnce({ mode: "cancel" });
		configureInkUnifiedSettingsMock.mockResolvedValueOnce(true);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(configureInkUnifiedSettingsMock).toHaveBeenCalledTimes(1);
		expect(selectMock).not.toHaveBeenCalled();
		expect(promptOpenTuiAuthDashboardMock).toHaveBeenCalledTimes(2);
		expect(promptInkAuthDashboardMock).not.toHaveBeenCalled();
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
		promptOpenTuiAuthDashboardMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		const firstCallAccounts = (promptOpenTuiAuthDashboardMock.mock.calls[0]?.[0] as {
			dashboard: { accounts: Array<{
				email?: string;
				index: number;
				sourceIndex?: number;
				quickSwitchNumber?: number;
				isCurrentAccount?: boolean;
			}> };
		})?.dashboard.accounts ?? [];
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
		promptOpenTuiAuthDashboardMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		const firstCallAccounts = (promptOpenTuiAuthDashboardMock.mock.calls[0]?.[0] as {
			dashboard: { accounts: Array<{ email?: string; quickSwitchNumber?: number }> };
		})?.dashboard.accounts ?? [];
		expect(firstCallAccounts.map((account) => account.email)).toEqual([
			"b@example.com",
			"a@example.com",
		]);
		expect(firstCallAccounts.map((account) => account.quickSwitchNumber)).toEqual([2, 1]);
	});

	it("falls back to Ink routing when OpenTUI reports unsupported", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "fallback@example.com",
					accountId: "acc_fallback",
					refreshToken: "refresh-fallback",
					accessToken: "access-fallback",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptOpenTuiAuthDashboardMock.mockResolvedValueOnce(null);
		promptInkAuthDashboardMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(promptOpenTuiAuthDashboardMock).toHaveBeenCalledTimes(1);
		expect(promptInkAuthDashboardMock).toHaveBeenCalledTimes(1);
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
		promptOpenTuiAuthDashboardMock
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
		selectMock.mockImplementation(async () => selectResults.shift() ?? { type: "back" });
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
	] as const)(
		"keeps no-save-on-cancel contract for panel=$panel mode=$mode",
		async ({ panel, mode }) => {
			setInteractiveTTY(true);
			const now = Date.now();
			let originalRuntimeTheme:
				| {
						v2Enabled: boolean;
						colorProfile: string;
						glyphMode: string;
						palette: string;
						accent: string;
				  }
				| null = null;
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
				saveDashboardDisplaySettingsMock.mockImplementation(async () => dashboardDeferred.promise);
				savePluginConfigMock.mockImplementation(async () => pluginDeferred.promise);
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
				const onInput = (options as { onInput?: (raw: string) => unknown } | undefined)?.onInput;
				if (selectCall === 1) return { type: panel };

				if (panel === "account-list") {
					if (selectCall === 2) return { type: "toggle", key: "menuShowStatusBadge" };
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

				if (selectCall === 2) return { type: "open-category", key: "rotation-quota" };
				if (selectCall === 3) return { type: "toggle", key: "preemptiveQuotaEnabled" };
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
		},
	);

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
		promptOpenTuiAuthDashboardMock
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
		promptOpenTuiAuthDashboardMock
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
		promptOpenTuiAuthDashboardMock
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
		promptOpenTuiAuthDashboardMock
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
		promptOpenTuiAuthDashboardMock
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
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.enabled).toBe(true);

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
				primary: { usedPercent: 20, windowMinutes: 300, resetAtMs: now + 1_000 },
				secondary: { usedPercent: 10, windowMinutes: 10080, resetAtMs: now + 2_000 },
			})
			.mockRejectedValueOnce(new Error("live probe temporary failure"));

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "fix", "--live", "--json"]);

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


});
