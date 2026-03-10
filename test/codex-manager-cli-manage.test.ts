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
		promptOpenTuiAuthDashboardMock
			.mockResolvedValueOnce({ mode: "manage", deleteAccountIndex: 1 })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts).toHaveLength(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.email).toBe("first@example.com");
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
		promptOpenTuiAuthDashboardMock
			.mockResolvedValueOnce({ mode: "manage", toggleAccountIndex: 0 })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.enabled).toBe(false);
	});

	it("refreshes a specific account from manage mode and persists new tokens", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "first@example.com",
					refreshToken: "refresh-first",
					accessToken: "access-first",
					expiresAt: now - 1_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "second@example.com",
					refreshToken: "refresh-second",
					accessToken: "access-second",
					expiresAt: now - 1_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
			],
		});
		promptOpenTuiAuthDashboardMock
			.mockResolvedValueOnce({ mode: "manage", refreshAccountIndex: 1 })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce("browser");
		const authModule = await import("../lib/auth/auth.js");
		const createAuthorizationFlowMock = vi.mocked(authModule.createAuthorizationFlow);
		const exchangeAuthorizationCodeMock = vi.mocked(authModule.exchangeAuthorizationCode);
		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");
		const startLocalOAuthServerMock = vi.mocked(serverModule.startLocalOAuthServer);

		createAuthorizationFlowMock.mockResolvedValue({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		exchangeAuthorizationCodeMock.mockResolvedValue({
			type: "success",
			access: "access-second-next",
			refresh: "refresh-second-next",
			expires: now + 3_600_000,
		});
		openBrowserUrlMock.mockReturnValue(true);
		startLocalOAuthServerMock.mockResolvedValue({
			ready: true,
			waitForCode: vi.fn(async () => ({ code: "oauth-code" })),
			close: vi.fn(),
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		const saved = saveAccountsMock.mock.calls[0]?.[0];
		expect(saved?.accounts?.length).toBeGreaterThanOrEqual(2);
		expect(saved?.accounts?.some((account) => account?.email === "second@example.com")).toBe(true);
	});

	it("resets all accounts through transactional persistence", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "reset@example.com",
					refreshToken: "refresh-reset",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		promptOpenTuiAuthDashboardMock
			.mockResolvedValueOnce({ mode: "fresh", deleteAll: true })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(clearAccountsMock).toHaveBeenCalledTimes(1);
		expect(withAccountStorageTransactionMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
	});


});
