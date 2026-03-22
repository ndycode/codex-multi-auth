import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAccountsMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const saveAccountsMock = vi.fn();
const saveFlaggedAccountsMock = vi.fn();
const setStoragePathMock = vi.fn();
const getStoragePathMock = vi.fn(() => "/mock/openai-codex-accounts.json");
const getNamedBackupsMock = vi.fn();
const restoreAccountsFromBackupMock = vi.fn();
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
const selectMock = vi.fn();
const confirmMock = vi.fn(async () => true);
const planOcChatgptSyncMock = vi.fn();
const applyOcChatgptSyncMock = vi.fn();
const runNamedBackupExportMock = vi.fn();
const exportNamedBackupMock = vi.fn();
const promptQuestionMock = vi.fn();
const detectOcChatgptMultiAuthTargetMock = vi.fn();
const normalizeAccountStorageMock = vi.fn((value) => value);
const withAccountStorageTransactionMock = vi.fn();
const withAccountAndFlaggedStorageTransactionMock = vi.fn();
const loggerDebugMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();
const loggerErrorMock = vi.fn();

vi.mock("../lib/logger.js", () => ({
	createLogger: vi.fn(() => ({
		debug: loggerDebugMock,
		info: loggerInfoMock,
		warn: loggerWarnMock,
		error: loggerErrorMock,
	})),
	logWarn: vi.fn(),
}));

vi.mock("../lib/auth/auth.js", () => ({
	createAuthorizationFlow: vi.fn(),
	exchangeAuthorizationCode: vi.fn(),
	parseAuthorizationInput: vi.fn((input: string) => {
		const codeMatch = input.match(/code=([^&]+)/);
		const stateMatch = input.match(/state=([^&#]+)/);
		return {
			code: codeMatch?.[1],
			state: stateMatch?.[1],
		};
	}),
	REDIRECT_URI: "http://localhost:1455/auth/callback",
}));

vi.mock("../lib/auth/browser.js", () => ({
	isBrowserLaunchSuppressed: vi.fn(() => false),
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
			storedAccountId: string | undefined,
			currentAccountIdSource: string | undefined,
			tokenId: string | undefined,
		) => {
			if (!storedAccountId) return tokenId;
			if (currentAccountIdSource === "org" || currentAccountIdSource === "manual") {
				return storedAccountId;
			}
			return tokenId ?? storedAccountId;
		},
	),
	sanitizeEmail: vi.fn((email: string | undefined) =>
		typeof email === "string" ? email.toLowerCase() : undefined,
	),
	selectBestAccountCandidate: vi.fn(() => null),
	shouldUpdateAccountIdFromToken: vi.fn(
		(currentAccountIdSource: string | undefined, currentAccountId: string | undefined) => {
			if (!currentAccountId) return true;
			if (!currentAccountIdSource) return true;
			return currentAccountIdSource === "token" || currentAccountIdSource === "id_token";
		},
	),
}));

vi.mock("../lib/storage.js", async () => {
	const actual = await vi.importActual("../lib/storage.js");
	return {
		...(actual as Record<string, unknown>),
		loadAccounts: loadAccountsMock,
		loadFlaggedAccounts: loadFlaggedAccountsMock,
		saveAccounts: saveAccountsMock,
		saveFlaggedAccounts: saveFlaggedAccountsMock,
		withAccountAndFlaggedStorageTransaction:
			withAccountAndFlaggedStorageTransactionMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
		setStoragePath: setStoragePathMock,
		getStoragePath: getStoragePathMock,
		getNamedBackups: getNamedBackupsMock,
		restoreAccountsFromBackup: restoreAccountsFromBackupMock,
		exportNamedBackup: exportNamedBackupMock,
		normalizeAccountStorage: normalizeAccountStorageMock,
	};
});

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

vi.mock("../lib/ui/select.js", () => ({
	select: selectMock,
}));

vi.mock("../lib/ui/confirm.js", () => ({
	confirm: confirmMock,
}));

vi.mock("../lib/oc-chatgpt-orchestrator.js", () => ({
	planOcChatgptSync: planOcChatgptSyncMock,
	applyOcChatgptSync: applyOcChatgptSyncMock,
	runNamedBackupExport: runNamedBackupExportMock,
}));

vi.mock("../lib/oc-chatgpt-target-detection.js", () => ({
	detectOcChatgptMultiAuthTarget: detectOcChatgptMultiAuthTargetMock,
}));

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: promptQuestionMock,
		close: vi.fn(),
	})),
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

type SettingsTestAccount = {
	email: string;
	accountId: string;
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
	addedAt: number;
	lastUsed: number;
	enabled: boolean;
};

type SettingsTestStorage = {
	version: 3;
	activeIndex: number;
	activeIndexByFamily: { codex: number };
	accounts: SettingsTestAccount[];
};

type SettingsSelectOptions = {
	onInput?: (raw: string, state?: SettingsSelectInputState) => unknown;
};

type SettingsSelectInputState = {
	cursor: number;
	items: unknown[];
	requestRerender: () => void;
};

type SettingsSelectSequenceStep =
	| Record<string, unknown>
	| ((options?: SettingsSelectOptions) => unknown);

type SettingsHubMenuItem = {
	value: { type: string };
	separator?: boolean;
	disabled?: boolean;
	kind?: string;
};

const SETTINGS_HUB_MENU_ORDER = [
	"account-list",
	"summary-fields",
	"behavior",
	"theme",
	"experimental",
	"backend",
] as const;

const BASELINE_SETTINGS_HUB_PANELS = [
	"account-list",
	"summary-fields",
	"behavior",
	"theme",
	"backend",
] as const;

const SETTINGS_CANCEL_MODES = [
	"windows-ebusy",
	"concurrent-save-ordering",
	"token-refresh-race",
] as const;

const SETTINGS_CANCEL_MATRIX = SETTINGS_CANCEL_MODES.flatMap((mode) =>
	BASELINE_SETTINGS_HUB_PANELS.map((panel) => ({ panel, mode }) as const),
);

type SettingsPanel = (typeof BASELINE_SETTINGS_HUB_PANELS)[number];

function createSettingsStorage(
	now: number,
	overrides: Partial<SettingsTestAccount> = {},
): SettingsTestStorage {
	return {
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
				...overrides,
			},
		],
	};
}

function setupInteractiveSettingsLogin(storage: SettingsTestStorage): void {
	setInteractiveTTY(true);
	loadAccountsMock.mockImplementation(async () => structuredClone(storage));
	promptLoginModeMock
		.mockResolvedValueOnce({ mode: "settings" })
		.mockResolvedValueOnce({ mode: "cancel" });
}

function queueSettingsSelectSequence(
	steps: readonly SettingsSelectSequenceStep[],
): { remaining: () => number } {
	const queue = [...steps];
	selectMock.mockImplementation(async (_items, options) => {
		const next = queue.shift();
		if (!next) return { type: "back" };
		if (typeof next === "function") {
			return next(options as SettingsSelectOptions | undefined);
		}
		return structuredClone(next);
	});
	return { remaining: () => queue.length };
}

function triggerSettingsHotkey(
	raw: string,
	fallback: Record<string, unknown> = { type: "cancel" },
	inputState: Partial<SettingsSelectInputState> = {},
): SettingsSelectSequenceStep {
	return (options) =>
		options?.onInput?.(raw, {
			cursor: inputState.cursor ?? 0,
			items: inputState.items ?? [],
			requestRerender: inputState.requestRerender ?? (() => undefined),
		}) ?? fallback;
}

function requireSettingsHotkey(
	raw: string,
	expected: Record<string, unknown>,
	inputState: Partial<SettingsSelectInputState> = {},
): SettingsSelectSequenceStep {
	return (options) => {
		expect(options?.onInput).toBeTypeOf("function");
		const result =
			options?.onInput?.(raw, {
				cursor: inputState.cursor ?? 0,
				items: inputState.items ?? [],
				requestRerender: inputState.requestRerender ?? (() => undefined),
			}) ?? null;
		expect(result).toEqual(expected);
		return result;
	};
}

function createSettingsCancelSequence(
	panel: SettingsPanel,
): readonly SettingsSelectSequenceStep[] {
	if (panel === "account-list") {
		return [
			{ type: panel },
			{ type: "toggle", key: "menuShowStatusBadge" },
			triggerSettingsHotkey("q"),
			{ type: "back" },
		];
	}
	if (panel === "summary-fields") {
		return [
			{ type: panel },
			{ type: "toggle", key: "status" },
			triggerSettingsHotkey("q"),
			{ type: "back" },
		];
	}
	if (panel === "behavior") {
		return [
			{ type: panel },
			{ type: "toggle-pause" },
			triggerSettingsHotkey("q"),
			{ type: "back" },
		];
	}
	if (panel === "theme") {
		return [
			{ type: panel },
			{ type: "set-palette", palette: "blue" },
			triggerSettingsHotkey("q"),
			{ type: "back" },
		];
	}
	return [
		{ type: panel },
		{ type: "open-category", key: "rotation-quota" },
		{ type: "toggle", key: "preemptiveQuotaEnabled" },
		{ type: "back" },
		triggerSettingsHotkey("q"),
		{ type: "back" },
	];
}

function readSettingsHubPanelContract(): string[] {
	const items = (selectMock.mock.calls[0]?.[0] ?? []) as SettingsHubMenuItem[];
	return items
		.filter(
			(item) => !item.separator && !item.disabled && item.kind !== "heading",
		)
		.map((item) => item.value.type)
		.filter((type) => type !== "back");
}

describe("codex manager cli commands", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		loadAccountsMock.mockReset();
		loadFlaggedAccountsMock.mockReset();
		saveAccountsMock.mockReset();
		saveFlaggedAccountsMock.mockReset();
		getNamedBackupsMock.mockReset();
		restoreAccountsFromBackupMock.mockReset();
		withAccountAndFlaggedStorageTransactionMock.mockReset();
		withAccountStorageTransactionMock.mockReset();
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
		selectMock.mockReset();
		confirmMock.mockReset();
		confirmMock.mockResolvedValue(true);
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
		withAccountStorageTransactionMock.mockImplementation(
			async (handler) => {
				const current = await loadAccountsMock();
				return handler(
					current == null
						? {
							version: 3,
							accounts: [],
							activeIndex: 0,
							activeIndexByFamily: {},
						}
						: structuredClone(current),
					async (storage: unknown) => saveAccountsMock(storage),
				);
			},
		);
		withAccountAndFlaggedStorageTransactionMock.mockImplementation(
			async (handler) => {
				const current = await loadAccountsMock();
				let snapshot =
					current == null
						? {
							version: 3,
							accounts: [],
							activeIndex: 0,
							activeIndexByFamily: {},
						}
						: structuredClone(current);
				return handler(
					structuredClone(snapshot),
					async (storage: unknown, flaggedStorage: unknown) => {
						const previousSnapshot = structuredClone(snapshot);
						await saveAccountsMock(storage);
						try {
							await saveFlaggedAccountsMock(flaggedStorage);
							snapshot = structuredClone(storage);
						} catch (error) {
							await saveAccountsMock(previousSnapshot);
							throw error;
						}
					},
				);
			},
		);
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
		selectMock.mockResolvedValue(undefined);
		getNamedBackupsMock.mockResolvedValue([]);
		restoreTTYDescriptors();
		setStoragePathMock.mockReset();
		getStoragePathMock.mockReturnValue("/mock/openai-codex-accounts.json");
	});

	afterEach(() => {
		restoreTTYDescriptors();
		vi.restoreAllMocks();
	});

	it("formats backup saved-at timestamps with the runtime locale options", async () => {
		const localeSpy = vi
			.spyOn(Date.prototype, "toLocaleString")
			.mockReturnValue("Localized Saved Time");
		const { formatBackupSavedAt } = await import("../lib/codex-manager.js");

		try {
			expect(formatBackupSavedAt(1_710_000_000_000)).toBe("Localized Saved Time");
			expect(localeSpy).toHaveBeenCalledWith(undefined, {
				month: "short",
				day: "numeric",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
		} finally {
			localeSpy.mockRestore();
		}
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

	it("does not mutate loaded quota cache when live forecast save fails", async () => {
		const now = Date.now();
		const originalQuotaCache = {
			byAccountId: {},
			byEmail: {},
		};
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "forecast@example.com",
					accountId: "acc_forecast",
					refreshToken: "refresh-forecast",
					accessToken: "access-forecast",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValueOnce(originalQuotaCache);
		saveQuotaCacheMock.mockRejectedValueOnce(
			makeErrnoError("save failed", "EBUSY"),
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		await expect(
			runCodexMultiAuthCli(["auth", "forecast", "--live", "--json"]),
		).rejects.toMatchObject({
			code: "EBUSY",
			message: "save failed",
		});
		expect(originalQuotaCache).toEqual({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				acc_forecast: {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
					primary: {
						usedPercent: undefined,
						windowMinutes: undefined,
						resetAtMs: undefined,
					},
					secondary: {
						usedPercent: undefined,
						windowMinutes: undefined,
						resetAtMs: undefined,
					},
				},
			},
			byEmail: {},
		});
	});

	it("does not mutate loaded quota cache when live forecast display save fails", async () => {
		const now = Date.now();
		const originalQuotaCache = {
			byAccountId: {},
			byEmail: {},
		};
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "forecast@example.com",
					accountId: "acc_forecast",
					refreshToken: "refresh-forecast",
					accessToken: "access-forecast",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValueOnce(originalQuotaCache);
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 25,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 15,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		saveQuotaCacheMock.mockRejectedValueOnce(
			makeErrnoError("save failed", "EBUSY"),
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		await expect(
			runCodexMultiAuthCli(["auth", "forecast", "--live"]),
		).rejects.toMatchObject({
			code: "EBUSY",
			message: "save failed",
		});
		expect(originalQuotaCache).toEqual({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				acc_forecast: {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
					primary: {
						usedPercent: 25,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 15,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
			byEmail: {},
		});
	});

	it("persists the working quota cache for live forecast display mode", async () => {
		const now = Date.now();
		const originalQuotaCache = {
			byAccountId: {},
			byEmail: {},
		};
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "forecast@example.com",
					accountId: "acc_forecast",
					refreshToken: "refresh-forecast",
					accessToken: "access-forecast",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValueOnce(originalQuotaCache);
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 25,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 15,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "forecast", "--live"]);

		expect(exitCode).toBe(0);
		expect(originalQuotaCache).toEqual({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				acc_forecast: {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
					primary: {
						usedPercent: 25,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 15,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
			byEmail: {},
		});
		expect(
			logSpy.mock.calls.some((call) =>
				String(call[0]).includes("Best-account preview"),
			),
		).toBe(true);
	});

	it("prints implemented 41-feature matrix", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "features"]);
		expect(exitCode).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toBe("Implemented features (41)");
		expect(
			logSpy.mock.calls.some((call) =>
				String(call[0]).includes(
					"41. Auto-switch to best account command",
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

	it("prints best help without mutating storage", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--help"]);

		expect(exitCode).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(loadAccountsMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toContain("codex auth best");
	});

	it("rejects malformed best args before switching accounts", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--model"]);

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Missing value for --model");
		expect(loadAccountsMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toContain("codex auth best");
	});

	it("rejects unknown best args before switching accounts", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--bogus"]);

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Unknown option: --bogus");
		expect(loadAccountsMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toContain("codex auth best");
	});

	it("rejects --model without --live before loading accounts", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--model", "gpt-5.1"]);

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("--model requires --live for codex auth best");
		expect(loadAccountsMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toContain("codex auth best");
	});

	it("prints json error when no accounts are configured for best", async () => {
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [],
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--json"]);

		expect(exitCode).toBe(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
			error: "No accounts configured.",
		});
	});

	it("prints json error when storage is null for best", async () => {
		loadAccountsMock.mockResolvedValueOnce(null);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--json"]);

		expect(exitCode).toBe(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
			error: "No accounts configured.",
		});
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

	it("preserves distinct shared-accountId accounts when flagged recovery has no email", async () => {
		const now = Date.now();
		loadFlaggedAccountsMock.mockResolvedValueOnce({
			version: 1,
			accounts: [
				{
					refreshToken: "flagged-refresh",
					accountId: "shared-account",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					flaggedAt: now - 5_000,
				},
			],
		});
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
			accounts: [
				{
					refreshToken: "refresh-alpha",
					accountId: "shared-account",
					email: "alpha@example.com",
					addedAt: now - 3_000,
					lastUsed: now - 3_000,
				},
				{
					refreshToken: "refresh-beta",
					accountId: "shared-account",
					email: "beta@example.com",
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-restored",
			refresh: "refresh-restored",
			expires: now + 3_600_000,
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation(() => "shared-account");
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"verify-flagged",
			"--json",
		]);

		expect(exitCode).toBe(0);
		expect(withAccountAndFlaggedStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: expect.arrayContaining([
					expect.objectContaining({ refreshToken: "refresh-alpha" }),
					expect.objectContaining({ refreshToken: "refresh-beta" }),
					expect.objectContaining({ refreshToken: "refresh-restored" }),
				]),
			}),
		);
	});

	it("updates a unique shared-accountId account during flagged recovery when email is missing", async () => {
		const now = Date.now();
		loadFlaggedAccountsMock.mockResolvedValueOnce({
			version: 1,
			accounts: [
				{
					refreshToken: "flagged-refresh",
					accountId: "shared-account",
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
			accounts: [
				{
					refreshToken: "refresh-existing",
					accountId: "shared-account",
					addedAt: now - 3_000,
					lastUsed: now - 3_000,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-restored",
			refresh: "refresh-restored",
			expires: now + 3_600_000,
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation(() => "shared-account");
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"verify-flagged",
			"--json",
		]);

		expect(exitCode).toBe(0);
		expect(withAccountAndFlaggedStorageTransactionMock).toHaveBeenCalledTimes(1);
		const savedStorage = saveAccountsMock.mock.calls.at(-1)?.[0];
		expect(savedStorage).toEqual(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						accountId: "shared-account",
						refreshToken: "refresh-restored",
					}),
				],
			}),
		);
		expect(savedStorage?.accounts).toHaveLength(1);
		extractAccountIdMock.mockImplementation(() => "acc_test");
	});

	it("preserves org-selected workspace binding during flagged recovery refresh", async () => {
		const now = Date.now();
		loadFlaggedAccountsMock.mockResolvedValueOnce({
			version: 1,
			accounts: [
				{
					refreshToken: "flagged-refresh",
					accountId: "workspace-alpha",
					accountIdSource: "org",
					accountLabel: "Workspace Alpha [id:alpha]",
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
			accounts: [
				{
					refreshToken: "refresh-existing",
					accountId: "workspace-alpha",
					accountIdSource: "org",
					accountLabel: "Workspace Alpha [id:alpha]",
					addedAt: now - 3_000,
					lastUsed: now - 3_000,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-restored",
			refresh: "refresh-restored",
			expires: now + 3_600_000,
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation((accessToken?: string) =>
			accessToken === "access-restored" ? "token-personal" : "workspace-alpha",
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"verify-flagged",
			"--json",
		]);

		expect(exitCode).toBe(0);
		const savedStorage = saveAccountsMock.mock.calls.at(-1)?.[0] as {
			accounts: Array<{ accountId?: string; accountIdSource?: string; refreshToken?: string }>;
		};
		expect(savedStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accountIdSource: "org",
				refreshToken: "refresh-restored",
			}),
		);
		extractAccountIdMock.mockImplementation(() => "acc_test");
	});

	it("does not clear an existing workspace binding when flagged recovery refresh has no account id", async () => {
		const now = Date.now();
		loadFlaggedAccountsMock.mockResolvedValueOnce({
			version: 1,
			accounts: [
				{
					refreshToken: "flagged-refresh",
					email: "a@example.com",
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
			accounts: [
				{
					refreshToken: "refresh-existing",
					accountId: "workspace-alpha",
					accountIdSource: "org",
					accountLabel: "Workspace Alpha [id:alpha]",
					email: "a@example.com",
					addedAt: now - 3_000,
					lastUsed: now - 3_000,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-restored",
			refresh: "refresh-restored",
			expires: now + 3_600_000,
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation((accessToken?: string) =>
			accessToken === "access-restored" ? undefined : "workspace-alpha",
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"verify-flagged",
			"--json",
		]);

		expect(exitCode).toBe(0);
		const savedStorage = saveAccountsMock.mock.calls.at(-1)?.[0] as {
			accounts: Array<{
				accountId?: string;
				accountIdSource?: string;
				refreshToken?: string;
				email?: string;
			}>;
		};
		expect(savedStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accountIdSource: "org",
				refreshToken: "refresh-restored",
				email: "a@example.com",
			}),
		);
		extractAccountIdMock.mockImplementation(() => "acc_test");
	});

	it("rolls back active storage when flagged persistence fails during recovery", async () => {
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
			accounts: [
				{
					refreshToken: "refresh-existing",
					accountId: "acc_existing",
					email: "existing@example.com",
					addedAt: now - 10_000,
					lastUsed: now - 10_000,
				},
			],
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-restored",
			refresh: "refresh-restored",
			expires: now + 3_600_000,
		});
		saveFlaggedAccountsMock.mockRejectedValueOnce(
			new Error("flagged write failed"),
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		await expect(
			runCodexMultiAuthCli(["auth", "verify-flagged", "--json"]),
		).rejects.toThrow("flagged write failed");
		expect(withAccountAndFlaggedStorageTransactionMock).toHaveBeenCalledTimes(
			1,
		);
		expect(saveAccountsMock).toHaveBeenCalledTimes(2);
		expect(saveAccountsMock.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				accounts: expect.arrayContaining([
					expect.objectContaining({ refreshToken: "refresh-existing" }),
					expect.objectContaining({ refreshToken: "refresh-restored" }),
				]),
			}),
		);
		expect(saveAccountsMock.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({ refreshToken: "refresh-existing" }),
				],
			}),
		);
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

	it("persists rotated tokens during auth check and preserves org-selected workspace binding", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					accountId: "workspace-alpha",
					accountIdSource: "org",
					accountLabel: "Workspace Alpha [id:alpha]",
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
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation((accessToken?: string) =>
			accessToken === "access-a-next" ? "token-personal" : "workspace-alpha",
		);
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
		const savedStorage = saveAccountsMock.mock.calls.at(-1)?.[0] as {
			accounts: Array<{ accountId?: string; accountIdSource?: string }>;
		};
		expect(savedStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accountIdSource: "org",
			}),
		);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accessToken: "access-a-next",
				refreshToken: "refresh-a-next",
				expiresAt: now + 3_600_000,
			}),
		);
	});

	it("recomputes live quota fallback state during auth check after refresh changes a shared-workspace email", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha-stale",
					expiresAt: now - 5_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
				{
					email: "owner@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 4_000,
					lastUsed: now - 4_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"owner@example.com": {
					updatedAt: now - 5_000,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 95,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 95,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-alpha-refreshed",
			refresh: "refresh-alpha-next",
			expires: now + 7_200_000,
			idToken: "id-token-alpha",
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		const extractAccountEmailMock = vi.mocked(accountsModule.extractAccountEmail);
		extractAccountIdMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-stale") return "shared-workspace";
				if (accessToken === "access-alpha-refreshed") return "shared-workspace";
				if (accessToken === "access-beta") return "shared-workspace";
				return "acc_test";
			},
		);
		extractAccountEmailMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-refreshed") return "owner@example.com";
				return undefined;
			},
		);
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
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		try {
			const exitCode = await runCodexMultiAuthCli(["auth", "check"]);

			expect(exitCode).toBe(0);
			expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
			expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
			expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
			expect(saveQuotaCacheMock).toHaveBeenCalledWith({
				byAccountId: {},
				byEmail: {},
			});
			expect(saveAccountsMock).toHaveBeenCalledTimes(1);
			expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.email).toBe(
				"owner@example.com",
			);
			expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
			expect(
				logSpy.mock.calls.some((call) =>
					String(call[0]).includes("Result: 2 working"),
				),
			).toBe(true);
		} finally {
			extractAccountIdMock.mockReset();
			extractAccountIdMock.mockImplementation(() => "acc_test");
			extractAccountEmailMock.mockReset();
			extractAccountEmailMock.mockImplementation(() => undefined);
		}
	});

	it("prunes stale quota email cache entries during auth check after refresh changes a shared-workspace email", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha-stale",
					expiresAt: now - 5_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
				{
					email: "beta@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 4_000,
					lastUsed: now - 4_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"alpha@example.com": {
					updatedAt: now - 10_000,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 15,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 5,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-alpha-refreshed",
			refresh: "refresh-alpha-next",
			expires: now + 7_200_000,
			idToken: "id-token-alpha",
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		const extractAccountEmailMock = vi.mocked(accountsModule.extractAccountEmail);
		extractAccountIdMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-stale") return "shared-workspace";
				if (accessToken === "access-alpha-refreshed") return "shared-workspace";
				if (accessToken === "access-beta") return "shared-workspace";
				return "acc_test";
			},
		);
		extractAccountEmailMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-refreshed") return "owner@example.com";
				return undefined;
			},
		);
		fetchCodexQuotaSnapshotMock
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 25,
					windowMinutes: 300,
					resetAtMs: now + 1_000,
				},
				secondary: {
					usedPercent: 10,
					windowMinutes: 10080,
					resetAtMs: now + 2_000,
				},
			})
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		try {
			const exitCode = await runCodexMultiAuthCli(["auth", "check"]);

			expect(exitCode).toBe(0);
			expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
			expect(saveQuotaCacheMock).toHaveBeenCalledWith({
				byAccountId: {},
				byEmail: {
					"beta@example.com": {
						updatedAt: expect.any(Number),
						status: 200,
						model: "gpt-5-codex",
						planType: undefined,
						primary: {
							usedPercent: 70,
							windowMinutes: 300,
							resetAtMs: now + 3_000,
						},
						secondary: {
							usedPercent: 40,
							windowMinutes: 10080,
							resetAtMs: now + 4_000,
						},
					},
					"owner@example.com": {
						updatedAt: expect.any(Number),
						status: 200,
						model: "gpt-5-codex",
						planType: undefined,
						primary: {
							usedPercent: 25,
							windowMinutes: 300,
							resetAtMs: now + 1_000,
						},
						secondary: {
							usedPercent: 10,
							windowMinutes: 10080,
							resetAtMs: now + 2_000,
						},
					},
				},
			});
		} finally {
			extractAccountIdMock.mockReset();
			extractAccountIdMock.mockImplementation(() => "acc_test");
			extractAccountEmailMock.mockReset();
			extractAccountEmailMock.mockImplementation(() => undefined);
		}
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

	it("does not mutate loaded quota cache when live check account save fails", async () => {
		const now = Date.now();
		const originalQuotaCache = {
			byAccountId: {},
			byEmail: {},
		};
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
					enabled: false,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValueOnce(originalQuotaCache);
		saveAccountsMock.mockRejectedValueOnce(
			makeErrnoError("save failed", "EBUSY"),
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		await expect(runCodexMultiAuthCli(["auth", "check"])).rejects.toMatchObject({
			code: "EBUSY",
			message: "save failed",
		});
		expect(originalQuotaCache).toEqual({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				acc_live: {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
					primary: {
						usedPercent: undefined,
						windowMinutes: undefined,
						resetAtMs: undefined,
					},
					secondary: {
						usedPercent: undefined,
						windowMinutes: undefined,
						resetAtMs: undefined,
					},
				},
			},
			byEmail: {},
		});
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

	it("persists refreshed probe tokens before best-account switch", async () => {
		const now = Date.now();
		let storageState = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "disabled@example.com",
					accountId: "acc_disabled",
					refreshToken: "refresh-disabled",
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: false,
				},
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-best-next",
			refresh: "refresh-best-next",
			expires: now + 3_600_000,
			idToken: "id-best-next",
		});
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 10,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 5,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--live"]);

		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(queuedRefreshMock).toHaveBeenCalledWith("refresh-best");
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(storageState.activeIndex).toBe(1);
		expect(storageState.activeIndexByFamily.codex).toBe(1);
		expect(storageState.accounts[1]?.accessToken).toBe("access-best-next");
		expect(storageState.accounts[1]?.refreshToken).toBe("refresh-best-next");
		// extractAccountId is globally mocked to return "acc_test" in this suite.
		expect(storageState.accounts[1]?.accountId).toBe("acc_test");
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: storageState.accounts[1]?.accountId,
				email: "best@example.com",
				accessToken: "access-best-next",
				refreshToken: "refresh-best-next",
				expiresAt: now + 3_600_000,
				idToken: "id-best-next",
			}),
		);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Switched to best account 2"),
		);
	});

	it("emits json payload when best live run switches accounts", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "current@example.com",
					accountId: "acc_current",
					refreshToken: "refresh-current",
					accessToken: "access-current",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					coolingDownUntil: now + 60_000,
					enabled: true,
				},
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					accessToken: "access-best",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		fetchCodexQuotaSnapshotMock
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 10,
					windowMinutes: 300,
					resetAtMs: now + 1_000,
				},
				secondary: {
					usedPercent: 5,
					windowMinutes: 10080,
					resetAtMs: now + 2_000,
				},
			})
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 10,
					windowMinutes: 300,
					resetAtMs: now + 1_000,
				},
				secondary: {
					usedPercent: 5,
					windowMinutes: 10080,
					resetAtMs: now + 2_000,
				},
			});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--live", "--json"]);

		expect(exitCode).toBe(0);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			message: string;
			accountIndex: number;
			reason: string;
			synced: boolean;
			wasDisabled: boolean;
		};
		expect(payload.message).toContain("Switched to best account");
		expect(payload.accountIndex).toBe(2);
		expect(payload.reason).toContain("Lowest risk ready account");
		expect(payload.synced).toBe(true);
		expect(payload.wasDisabled).toBe(false);
	});

	it("switches accounts on offline best selection without probing live quota", async () => {
		const now = Date.now();
		let storageState = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "current@example.com",
					accountId: "acc_current",
					refreshToken: "refresh-current",
					accessToken: "access-current",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					coolingDownUntil: now + 60_000,
					enabled: true,
				},
				{
					email: "next@example.com",
					accountId: "acc_next",
					refreshToken: "refresh-next",
					accessToken: "access-next",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best"]);

		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();
		expect(queuedRefreshMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(storageState.activeIndex).toBe(1);
		expect(storageState.activeIndexByFamily.codex).toBe(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acc_next",
				email: "next@example.com",
				accessToken: "access-next",
				refreshToken: "refresh-next",
				expiresAt: now + 3_600_000,
			}),
		);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Switched to best account 2"),
		);
	});

	it("parses --model=value for live best selection", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "current@example.com",
					accountId: "acc_current",
					refreshToken: "refresh-current",
					accessToken: "access-current",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "next@example.com",
					accountId: "acc_next",
					refreshToken: "refresh-next",
					accessToken: "access-next",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		fetchCodexQuotaSnapshotMock
			.mockResolvedValueOnce({
				status: 429,
				model: "gpt-5-mini",
				primary: {},
				secondary: {},
			})
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-mini",
				primary: {
					usedPercent: 10,
					windowMinutes: 300,
					resetAtMs: now + 1_000,
				},
				secondary: {
					usedPercent: 5,
					windowMinutes: 10080,
					resetAtMs: now + 2_000,
				},
			});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"best",
			"--live",
			"--model=gpt-5-mini",
		]);

		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ model: "gpt-5-mini" }),
		);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ model: "gpt-5-mini" }),
		);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the current account when it is already best and parses --model value", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					accessToken: "access-best",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5.1",
			primary: {
				usedPercent: 10,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 5,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"best",
			"--live",
			"--model",
			"gpt-5.1",
		]);

		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledWith(
			expect.objectContaining({ model: "gpt-5.1" }),
		);
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls.some((call) =>
			String(call[0]).includes("Already on best account 1"),
		)).toBe(true);
	});

	it("syncs refreshed current best account during live best check", async () => {
		const now = Date.now();
		let storageState = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-best-next",
			refresh: "refresh-best-next",
			expires: now + 3_600_000,
			idToken: "id-best-next",
		});
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 10,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 5,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--live"]);

		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(storageState.accounts[0]?.accessToken).toBe("access-best-next");
		expect(storageState.accounts[0]?.refreshToken).toBe("refresh-best-next");
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: storageState.accounts[0]?.accountId,
				email: "best@example.com",
				accessToken: "access-best-next",
				refreshToken: "refresh-best-next",
				expiresAt: now + 3_600_000,
				idToken: "id-best-next",
			}),
		);
		expect(logSpy.mock.calls.some((call) =>
			String(call[0]).includes("Already on best account 1"),
		)).toBe(true);
	});

	it("reports synced=false in already-best json output when live sync fails", async () => {
		const now = Date.now();
		let storageState = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-best-next",
			refresh: "refresh-best-next",
			expires: now + 3_600_000,
			idToken: "id-best-next",
		});
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 10,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 5,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(false);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--live", "--json"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: storageState.accounts[0]?.accountId,
				email: "best@example.com",
				accessToken: "access-best-next",
				refreshToken: "refresh-best-next",
				expiresAt: now + 3_600_000,
				idToken: "id-best-next",
			}),
		);
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			message: string;
			accountIndex: number;
			reason: string;
			synced?: boolean;
		};
		expect(payload.message).toContain("Already on best account");
		expect(payload.accountIndex).toBe(1);
		expect(typeof payload.reason).toBe("string");
		expect(payload.synced).toBe(false);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("reports 429 pressure when the current best account is delayed by live quota", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					accessToken: "access-best",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 429,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 100,
				windowMinutes: 300,
				resetAtMs: now + 60_000,
			},
			secondary: {
				usedPercent: 100,
				windowMinutes: 10080,
				resetAtMs: now + 120_000,
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"best",
			"--live",
			"--json",
		]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			message: string;
			accountIndex: number;
			reason: string;
			probeErrors?: string[];
		};
		expect(payload.message).toContain("Already on best account");
		expect(payload.accountIndex).toBe(1);
		expect(payload.reason.toLowerCase()).toContain("shortest wait");
		expect(payload.probeErrors).toBeUndefined();
	});

	it("prints live probe notes when best live probes fail", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					accessToken: "access-best",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		fetchCodexQuotaSnapshotMock.mockRejectedValueOnce(new Error("network timeout"));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "best", "--live"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(logSpy.mock.calls.some((call) =>
			String(call[0]).includes("Already on best account 1"),
		)).toBe(true);
		expect(logSpy.mock.calls.some((call) =>
			String(call[0]).includes("Live check notes (1)"),
		)).toBe(true);
		expect(logSpy.mock.calls.some((call) =>
			String(call[0]).includes("network timeout"),
		)).toBe(true);
	});

	it("reuses the queued refresh result across concurrent live best runs", async () => {
		const now = Date.now();
		let storageState = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "best@example.com",
					accountId: "acc_best",
					refreshToken: "refresh-best",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		fetchCodexQuotaSnapshotMock.mockResolvedValue({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 10,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 5,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		setCodexCliActiveSelectionMock.mockResolvedValue(true);

		const refreshDeferred = createDeferred<{
			type: "success";
			access: string;
			refresh: string;
			expires: number;
			idToken: string;
		}>();
		const refreshNetworkMock = vi.fn(async () => refreshDeferred.promise);
		let inFlight:
			| Promise<{
					type: "success";
					access: string;
					refresh: string;
					expires: number;
					idToken: string;
			  }>
			| undefined;
		queuedRefreshMock.mockImplementation(async () => {
			if (!inFlight) {
				inFlight = refreshNetworkMock();
			}
			return inFlight;
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const firstRun = runCodexMultiAuthCli(["auth", "best", "--live", "--json"]);
		const secondRun = runCodexMultiAuthCli(["auth", "best", "--live", "--json"]);

		refreshDeferred.resolve({
			type: "success",
			access: "access-best-next",
			refresh: "refresh-best-next",
			expires: now + 3_600_000,
			idToken: "id-best-next",
		});

		const [firstExitCode, secondExitCode] = await Promise.all([firstRun, secondRun]);

		expect(firstExitCode).toBe(0);
		expect(secondExitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(2);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(2);
		expect(refreshNetworkMock).toHaveBeenCalledTimes(1);
		expect(storageState.accounts[0]?.accessToken).toBe("access-best-next");
		expect(storageState.accounts[0]?.refreshToken).toBe("refresh-best-next");
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(2);
		for (const call of setCodexCliActiveSelectionMock.mock.calls) {
			expect(call[0]).toEqual(expect.objectContaining({
				accountId: "acc_test",
				email: "best@example.com",
				accessToken: "access-best-next",
				refreshToken: "refresh-best-next",
				expiresAt: now + 3_600_000,
				idToken: "id-best-next",
			}));
		}
		expect(logSpy.mock.calls).toHaveLength(2);
		for (const call of logSpy.mock.calls) {
			const payload = JSON.parse(String(call[0])) as {
				message: string;
				accountIndex: number;
				reason: string;
			};
			expect(payload.message).toContain("Already on best account");
			expect(payload.accountIndex).toBe(1);
			expect(typeof payload.reason).toBe("string");
		}
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

	it("refreshes token pair during switch without downgrading an org-selected workspace binding", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "workspace-alpha",
					accountIdSource: "org",
					accountLabel: "Workspace Alpha [id:alpha]",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation((accessToken?: string) =>
			accessToken === "access-a-next" ? "token-personal" : "workspace-alpha",
		);
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
		const savedStorage = saveAccountsMock.mock.calls.at(-1)?.[0] as {
			accounts: Array<{ accountId?: string; accountIdSource?: string }>;
		};
		expect(savedStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accountIdSource: "org",
			}),
		);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accessToken: "access-a-next",
				refreshToken: "refresh-a-next",
				expiresAt: now + 3_600_000,
				idToken: "id-a-next",
			}),
		);
		extractAccountIdMock.mockImplementation(() => "acc_test");
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

	it("autoSyncActiveAccountToCodex refreshes missing access token while preserving org-selected workspace binding", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "a@example.com",
					accountId: "workspace-alpha",
					accountIdSource: "org",
					accountLabel: "Workspace Alpha [id:alpha]",
					refreshToken: "refresh-a",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation((accessToken?: string) =>
			accessToken === "access-a-next" ? "token-personal" : "workspace-alpha",
		);
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
		const savedStorage = saveAccountsMock.mock.calls.at(-1)?.[0] as {
			accounts: Array<{ accountId?: string; accountIdSource?: string }>;
		};
		expect(savedStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accountIdSource: "org",
			}),
		);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "workspace-alpha",
				accessToken: "access-a-next",
				refreshToken: "refresh-a-next",
				expiresAt: now + 3_600_000,
				idToken: "id-a-next",
			}),
		);
		extractAccountIdMock.mockImplementation(() => "acc_test");
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
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(storageState.accounts).toHaveLength(2);
		expect(storageState.activeIndex).toBe(1);
		expect(storageState.activeIndexByFamily.codex).toBe(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
	});

	it("supports --manual login without launching a browser", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		let storageState = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [] as Array<Record<string, unknown>>,
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		promptAddAnotherAccountMock.mockResolvedValue(false);

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-manual",
			refresh: "refresh-manual",
			expires: now + 7_200_000,
			idToken: "id-token-manual",
			multiAccount: true,
		});

		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");
		const waitForCodeMock = vi.fn(async () => ({ code: "oauth-code" }));
		vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValueOnce({
			ready: true,
			waitForCode: waitForCodeMock,
			close: vi.fn(),
		});
		promptQuestionMock.mockResolvedValueOnce(
			"http://127.0.0.1:1455/auth/callback?code=oauth-code&state=oauth-state",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login", "--manual"]);
		const renderedLogs = logSpy.mock.calls.flat().map((entry) => String(entry));

		expect(exitCode).toBe(0);
		expect(openBrowserUrlMock).not.toHaveBeenCalled();
		expect(vi.mocked(serverModule.startLocalOAuthServer)).not.toHaveBeenCalled();
		expect(waitForCodeMock).not.toHaveBeenCalled();
		expect(renderedLogs.some((entry) => entry.includes("Manual mode active"))).toBe(
			true,
		);
		expect(renderedLogs.some((entry) => entry.includes("No callback received"))).toBe(false);
		expect(storageState.accounts).toHaveLength(1);
	});

	it("restores the latest named backup from onboarding when no accounts exist", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		let storageState: {
			version: 3;
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
		} | null = null;
		const restoredStorage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 1 },
			accounts: [
				{
					email: "first@example.com",
					accountId: "acc_first",
					refreshToken: "refresh-first",
					accessToken: "access-first",
					expiresAt: now + 3_600_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
				{
					email: "restored@example.com",
					accountId: "acc_restored",
					refreshToken: "refresh-restored",
					accessToken: "access-restored",
					expiresAt: now + 7_200_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () =>
			storageState == null ? null : structuredClone(storageState),
		);
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/last-good.json",
				fileName: "last-good.json",
				accountCount: 2,
				mtimeMs: now,
			},
			{
				path: "/mock/backups/older.json",
				fileName: "older.json",
				accountCount: 1,
				mtimeMs: now - 60_000,
			},
		]);
		restoreAccountsFromBackupMock.mockResolvedValue(structuredClone(restoredStorage));
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest");
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const localeSpy = vi
			.spyOn(Date.prototype, "toLocaleString")
			.mockReturnValue("Localized Saved Time");
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		try {
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(getNamedBackupsMock).toHaveBeenCalled();
			const signInItems = selectMock.mock.calls[0]?.[0] as Array<{
				label: string;
				kind?: string;
				hint?: string;
			}>;
			expect(signInItems.map((item) => item.label)).toContain(
				"Recover saved accounts",
			);
			expect(signInItems.find((item) => item.label === "Recover saved accounts")?.kind).toBe(
				"heading",
			);
			expect(
				signInItems.find((item) => item.label === "Restore Saved Backup")?.hint,
			).toBe("last-good.json | 2 accounts | saved Localized Saved Time");
			expect(localeSpy).toHaveBeenCalledWith(undefined, {
				month: "short",
				day: "numeric",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
			expect(restoreAccountsFromBackupMock).toHaveBeenCalledWith(
				"/mock/backups/last-good.json",
				{ persist: false },
			);
			expect(confirmMock).toHaveBeenCalledWith("Load last-good.json (2 accounts)?");
			expect(saveAccountsMock).toHaveBeenCalledTimes(1);
			expect(saveAccountsMock.mock.calls[0]?.[0]).toEqual(
				expect.objectContaining({
					activeIndex: 1,
					activeIndexByFamily: { codex: 1 },
					accounts: expect.arrayContaining([
						expect.objectContaining({
							accountId: "acc_restored",
							lastSwitchReason: "restore",
						}),
					]),
				}),
			);
			expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
				expect.objectContaining({
					accountId: "acc_restored",
					email: "restored@example.com",
				}),
			);
			expect(logSpy).toHaveBeenCalledWith(
				"Loaded last-good.json (2 accounts).",
			);
			expect(promptLoginModeMock).toHaveBeenCalledTimes(1);
		} finally {
			localeSpy.mockRestore();
		}
	});

	it("returns to onboarding when restore mode is back", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/latest.json",
				fileName: "latest.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("back")
			.mockResolvedValueOnce("cancel");
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(restoreAccountsFromBackupMock).not.toHaveBeenCalled();
		expect(confirmMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(promptLoginModeMock).not.toHaveBeenCalled();
	});

	it("returns to the onboarding menu when the manual backup picker is backed out", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		getNamedBackupsMock
			.mockResolvedValueOnce([
				{
					path: "/mock/backups/latest.json",
					fileName: "latest.json",
					accountCount: 4,
					mtimeMs: now,
				},
				{
					path: "/mock/backups/manual-choice.json",
					fileName: "manual-choice.json",
					accountCount: 1,
					mtimeMs: now - 60_000,
				},
			])
			.mockResolvedValueOnce([
				{
					path: "/mock/backups/latest.json",
					fileName: "latest.json",
					accountCount: 4,
					mtimeMs: now,
				},
				{
					path: "/mock/backups/manual-choice.json",
					fileName: "manual-choice.json",
					accountCount: 1,
					mtimeMs: now - 60_000,
				},
			]);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("manual")
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("cancel");
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(restoreAccountsFromBackupMock).not.toHaveBeenCalled();
		expect(confirmMock).not.toHaveBeenCalledWith("Load manual-choice.json (1 account)?");
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(promptLoginModeMock).not.toHaveBeenCalled();
	});

	it("refreshes the manual backup picker list when onboarding restore is reopened", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		getNamedBackupsMock
			.mockResolvedValueOnce([
				{
					path: "/mock/backups/latest.json",
					fileName: "latest.json",
					accountCount: 4,
					mtimeMs: now,
				},
				{
					path: "/mock/backups/old-manual.json",
					fileName: "old-manual.json",
					accountCount: 1,
					mtimeMs: now - 60_000,
				},
			])
			.mockResolvedValueOnce([
				{
					path: "/mock/backups/replacement.json",
					fileName: "replacement.json",
					accountCount: 2,
					mtimeMs: now + 60_000,
				},
			])
			.mockResolvedValueOnce([
				{
					path: "/mock/backups/replacement.json",
					fileName: "replacement.json",
					accountCount: 2,
					mtimeMs: now + 60_000,
				},
			]);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("manual")
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("manual")
			.mockResolvedValueOnce({
				path: "/mock/backups/replacement.json",
				fileName: "replacement.json",
				accountCount: 2,
				mtimeMs: now + 60_000,
			})
			.mockResolvedValueOnce("cancel");
		confirmMock.mockResolvedValueOnce(false);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(getNamedBackupsMock).toHaveBeenCalledTimes(3);
		const firstManualPickerItems = selectMock.mock.calls[2]?.[0] as Array<{
			label: string;
		}>;
		const secondManualPickerItems = selectMock.mock.calls[5]?.[0] as Array<{
			label: string;
		}>;
		expect(firstManualPickerItems.map((item) => item.label)).toEqual([
			"latest.json",
			"old-manual.json",
			expect.any(String),
		]);
		expect(secondManualPickerItems.map((item) => item.label)).toEqual([
			"replacement.json",
			expect.any(String),
		]);
		expect(restoreAccountsFromBackupMock).not.toHaveBeenCalled();
		expect(confirmMock).toHaveBeenCalledWith("Load replacement.json (2 accounts)?");
	});

	it("does not offer backup restore on onboarding when accounts already exist", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock
			.mockResolvedValueOnce({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "existing@example.com",
						accountId: "acc_existing",
						refreshToken: "refresh-existing",
						accessToken: "access-existing",
						expiresAt: now + 3_600_000,
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						enabled: true,
					},
				],
			})
			.mockResolvedValue({
				version: 3,
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
				accounts: [
					{
						email: "existing@example.com",
						accountId: "acc_existing",
						refreshToken: "refresh-existing",
						accessToken: "access-existing",
						expiresAt: now + 3_600_000,
						addedAt: now - 5_000,
						lastUsed: now - 5_000,
						enabled: true,
					},
				],
			});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(promptLoginModeMock).toHaveBeenCalledTimes(1);
		expect(getNamedBackupsMock).not.toHaveBeenCalled();
	});

	it("warns and falls back to normal sign-in when backup discovery fails in an empty pool", async () => {
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		getNamedBackupsMock.mockRejectedValueOnce(
			makeErrnoError("backups directory is locked", "EPERM"),
		);
		selectMock.mockResolvedValueOnce("cancel");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(getNamedBackupsMock).toHaveBeenCalledTimes(1);
		const signInItems = selectMock.mock.calls[0]?.[0] as Array<{
			label: string;
			value?: string;
		}>;
		expect(signInItems.some((item) => item.value === "browser")).toBe(true);
		expect(signInItems.some((item) => item.value === "manual")).toBe(true);
		expect(signInItems.some((item) => item.value === "restore-backup")).toBe(
			false,
		);
		const signInOptions = selectMock.mock.calls[0]?.[1] as {
			subtitle?: string;
		};
		expect(signInOptions.subtitle).toContain(
			"Named backup discovery failed. Continuing with browser or manual sign-in only.",
		);
		expect(loggerDebugMock).toHaveBeenCalledWith(
			"getNamedBackups failed, skipping restore option",
			{ code: "EPERM", error: "backups directory is locked" },
		);
		expect(warnSpy).toHaveBeenCalledWith(
			"Named backup discovery failed. Continuing with browser or manual sign-in only.",
		);
	});

	it("keeps the restored pool when Codex sync returns false", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		let storageState: {
			version: 3;
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
		} | null = null;
		const restoredStorage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "warn@example.com",
					accountId: "acc_warn",
					refreshToken: "refresh-warn",
					accessToken: "access-warn",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockImplementation(async () =>
			storageState == null ? null : structuredClone(storageState),
		);
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/warn.json",
				fileName: "warn.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		restoreAccountsFromBackupMock.mockResolvedValue(structuredClone(restoredStorage));
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(false);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest");
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(restoreAccountsFromBackupMock).toHaveBeenCalledWith(
			"/mock/backups/warn.json",
			{ persist: false },
		);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acc_warn",
				email: "warn@example.com",
			}),
		);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Codex auth sync did not complete"),
		);
		expect(promptLoginModeMock).toHaveBeenCalledTimes(1);
		expect(selectMock).toHaveBeenCalledTimes(2);
	});

	it("keeps the session alive when interactive backup restore fails with EBUSY", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "C:/mock/backups/locked.json",
				fileName: "locked.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		const busyError = new Error("File is busy") as NodeJS.ErrnoException;
		busyError.code = "EBUSY";
		restoreAccountsFromBackupMock.mockRejectedValueOnce(busyError);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest")
			.mockResolvedValueOnce("cancel");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(restoreAccountsFromBackupMock).toHaveBeenCalledWith(
			"C:/mock/backups/locked.json",
			{ persist: false },
		);
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(promptLoginModeMock).not.toHaveBeenCalled();
		expect(selectMock).toHaveBeenCalledTimes(3);
		expect(errorSpy).toHaveBeenCalledWith("Backup restore failed: File is busy");
	});

	it("prints the storage hint only once when restore fails with StorageError", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/locked.json",
				fileName: "locked.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		const storageModule = await import("../lib/storage.js");
		const busyError = new storageModule.StorageError(
			"File is busy",
			"EBUSY",
			"/mock/backups/locked.json",
			"File is locked",
		);
		restoreAccountsFromBackupMock.mockRejectedValueOnce(busyError);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest")
			.mockResolvedValueOnce("cancel");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith(
			storageModule.formatStorageErrorHint(
				busyError,
				"/mock/backups/locked.json",
			),
		);
	});

	it("keeps onboarding in the empty-pool flow when restore persistence fails before any storage is written", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		const restoredStorage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "restored-after-error@example.com",
					accountId: "acc_restored_after_error",
					refreshToken: "refresh-restored-after-error",
					accessToken: "access-restored-after-error",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(null);
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/persisted.json",
				fileName: "persisted.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		restoreAccountsFromBackupMock.mockResolvedValue(structuredClone(restoredStorage));
		saveAccountsMock.mockRejectedValueOnce(new Error("save selected account failed"));
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest")
			.mockResolvedValueOnce("cancel");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(restoreAccountsFromBackupMock).toHaveBeenCalledWith(
			"/mock/backups/persisted.json",
			{ persist: false },
		);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
		expect(promptLoginModeMock).not.toHaveBeenCalled();
		expect(selectMock).toHaveBeenCalledTimes(3);
		expect(errorSpy).toHaveBeenCalledWith(
			"Backup restore failed: save selected account failed",
		);
	});

	it("returns to the existing-account menu when restore fails after storage is already written", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		const restoredStorage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "persisted-after-error@example.com",
					accountId: "acc_persisted_after_error",
					refreshToken: "refresh-persisted-after-error",
					accessToken: "access-persisted-after-error",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		let storageState: typeof restoredStorage | null = null;
		loadAccountsMock.mockImplementation(async () =>
			storageState == null ? null : structuredClone(storageState),
		);
		saveAccountsMock.mockImplementationOnce(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
			throw new Error("save selected account failed");
		});
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/persisted-after-error.json",
				fileName: "persisted-after-error.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		restoreAccountsFromBackupMock.mockResolvedValue(structuredClone(restoredStorage));
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest");
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(promptLoginModeMock).toHaveBeenCalledTimes(1);
		expect(selectMock).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledWith(
			"Backup restore failed: save selected account failed",
		);
	});

	it("does not restore the latest backup when confirmation is declined", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValueOnce(null).mockResolvedValue(null);
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/latest.json",
				fileName: "latest.json",
				accountCount: 2,
				mtimeMs: now,
			},
		]);
		confirmMock.mockResolvedValueOnce(false);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest")
			.mockResolvedValueOnce("cancel");
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(confirmMock).toHaveBeenCalledWith("Load latest.json (2 accounts)?");
		expect(restoreAccountsFromBackupMock).not.toHaveBeenCalled();
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
	});

	it("does not restore a manually chosen backup when confirmation is declined", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValueOnce(null).mockResolvedValue(null);
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/manual-choice.json",
				fileName: "manual-choice.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		confirmMock.mockResolvedValueOnce(false);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("manual")
			.mockResolvedValueOnce({
				path: "/mock/backups/manual-choice.json",
				fileName: "manual-choice.json",
				accountCount: 1,
				mtimeMs: now,
			})
			.mockResolvedValueOnce("cancel");
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(confirmMock).toHaveBeenCalledWith("Load manual-choice.json (1 account)?");
		expect(restoreAccountsFromBackupMock).not.toHaveBeenCalled();
		expect(setCodexCliActiveSelectionMock).not.toHaveBeenCalled();
	});

	it("keeps manual refresh available from the existing-account menu", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "refresh@example.com",
					accountId: "acc_refresh",
					refreshToken: "refresh-old",
					accessToken: "access-old",
					expiresAt: now + 3_600_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
			],
		};
		loadAccountsMock.mockResolvedValue(storage);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "manage", refreshAccountIndex: 0 })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce("manual");

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-manual-choice",
			refresh: "refresh-manual-choice",
			expires: now + 7_200_000,
			idToken: "id-token-manual-choice",
			multiAccount: true,
		});

		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");
		const waitForCodeMock = vi.fn(async () => ({ code: "oauth-code" }));
		vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValueOnce({
			ready: true,
			waitForCode: waitForCodeMock,
			close: vi.fn(),
		});
		promptQuestionMock.mockResolvedValueOnce(
			"http://127.0.0.1:1455/auth/callback?code=oauth-code&state=oauth-state",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		const renderedLogs = logSpy.mock.calls.flat().map((entry) => String(entry));

		expect(exitCode).toBe(0);
		expect(selectMock).toHaveBeenCalled();
		expect(openBrowserUrlMock).not.toHaveBeenCalled();
		expect(vi.mocked(serverModule.startLocalOAuthServer)).not.toHaveBeenCalled();
		expect(waitForCodeMock).not.toHaveBeenCalled();
		const signInItems = selectMock.mock.calls[0]?.[0] as Array<{
			label: string;
			value?: string;
		}>;
		expect(signInItems.some((item) => item.value === "manual")).toBe(true);
		expect(renderedLogs.some((entry) => entry.includes("Manual mode active"))).toBe(
			true,
		);
		expect(renderedLogs.some((entry) => entry.includes("No callback received"))).toBe(false);
		expect(logSpy).toHaveBeenCalledWith("Refreshed account 1.");
	});

	it("falls back to pasted callback input when browser launch is suppressed", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		let storageState = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [] as Array<Record<string, unknown>>,
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		promptAddAnotherAccountMock.mockResolvedValue(false);
		selectMock.mockResolvedValueOnce("browser");
		promptQuestionMock.mockResolvedValueOnce(
			"http://127.0.0.1:1455/auth/callback?code=oauth-code&state=oauth-state",
		);

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-suppressed",
			refresh: "refresh-suppressed",
			expires: now + 7_200_000,
			idToken: "id-token-suppressed",
			multiAccount: true,
		});

		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		vi.mocked(browserModule.isBrowserLaunchSuppressed).mockReturnValueOnce(true);
		const serverModule = await import("../lib/auth/server.js");
		const startLocalOAuthServerMock = vi.mocked(serverModule.startLocalOAuthServer);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalled();
		expect(openBrowserUrlMock).not.toHaveBeenCalled();
		expect(startLocalOAuthServerMock).not.toHaveBeenCalled();
		expect(storageState.accounts).toHaveLength(1);
	});

	it("accepts manual callback input in non-tty mode when --manual is set", async () => {
		setInteractiveTTY(false);
		const now = Date.now();
		let storageState = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [] as Array<Record<string, unknown>>,
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		promptQuestionMock.mockResolvedValueOnce(
			"http://127.0.0.1:1455/auth/callback?code=oauth-code&state=oauth-state",
		);

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-stdin",
			refresh: "refresh-stdin",
			expires: now + 7_200_000,
			idToken: "id-token-stdin",
			multiAccount: true,
		});

		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login", "--manual"]);

		expect(exitCode).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalledWith("");
		expect(openBrowserUrlMock).not.toHaveBeenCalled();
		expect(vi.mocked(serverModule.startLocalOAuthServer)).not.toHaveBeenCalled();
		expect(storageState.accounts).toHaveLength(1);
	});

	it("rejects mismatched manual callback state in non-tty mode without persisting login", async () => {
		setInteractiveTTY(false);
		let storageState = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [] as Array<Record<string, unknown>>,
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		promptQuestionMock.mockResolvedValueOnce(
			"http://127.0.0.1:1455/auth/callback?code=oauth-code&state=wrong-state",
		);

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		const exchangeAuthorizationCodeMock = vi.mocked(authModule.exchangeAuthorizationCode);

		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login", "--manual"]);

		expect(exitCode).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalledWith("");
		expect(openBrowserUrlMock).not.toHaveBeenCalled();
		expect(vi.mocked(serverModule.startLocalOAuthServer)).not.toHaveBeenCalled();
		expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
		expect(storageState.accounts).toHaveLength(0);
	});

	it("falls back to pasted manual input when Windows-style callback bind fails", async () => {
		setInteractiveTTY(false);
		const now = Date.now();
		let storageState = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [] as Array<Record<string, unknown>>,
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		promptQuestionMock.mockResolvedValueOnce(
			"http://127.0.0.1:1455/auth/callback?code=oauth-code&state=oauth-state",
		);

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-eacces",
			refresh: "refresh-eacces",
			expires: now + 7_200_000,
			idToken: "id-token-eacces",
			multiAccount: true,
		});

		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login", "--manual"]);

		expect(exitCode).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalledWith("");
		expect(openBrowserUrlMock).not.toHaveBeenCalled();
		expect(vi.mocked(serverModule.startLocalOAuthServer)).not.toHaveBeenCalled();
		expect(storageState.accounts).toHaveLength(1);
	});

	it("returns to the menu when stdin closes without input in non-tty manual mode", async () => {
		setInteractiveTTY(false);
		let storageState = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [] as Array<Record<string, unknown>>,
		};
		loadAccountsMock.mockImplementation(async () => structuredClone(storageState));
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		promptQuestionMock.mockRejectedValueOnce(new Error("readline was closed"));

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		const exchangeAuthorizationCodeMock = vi.mocked(authModule.exchangeAuthorizationCode);

		const browserModule = await import("../lib/auth/browser.js");
		const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
		const serverModule = await import("../lib/auth/server.js");

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login", "--manual"]);

		expect(exitCode).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalledWith("");
		expect(openBrowserUrlMock).not.toHaveBeenCalled();
		expect(vi.mocked(serverModule.startLocalOAuthServer)).not.toHaveBeenCalled();
		expect(exchangeAuthorizationCodeMock).not.toHaveBeenCalled();
		expect(storageState.accounts).toHaveLength(0);
	});

	it("lets onboarding open a manual backup picker before restore", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		const restoredStorage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "manual@example.com",
					accountId: "acc_manual",
					refreshToken: "refresh-manual",
					accessToken: "access-manual",
					expiresAt: now + 3_600_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		let storageState: typeof restoredStorage | null = null;
		loadAccountsMock.mockImplementation(async () =>
			storageState == null ? null : structuredClone(storageState),
		);
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/latest.json",
				fileName: "latest.json",
				accountCount: 4,
				mtimeMs: now,
			},
			{
				path: "/mock/backups/manual-choice.json",
				fileName: "manual-choice.json",
				accountCount: 1,
				mtimeMs: now - 60_000,
			},
		]);
		restoreAccountsFromBackupMock.mockResolvedValue(structuredClone(restoredStorage));
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("manual")
			.mockResolvedValueOnce({
				path: "/mock/backups/manual-choice.json",
				fileName: "manual-choice.json",
				accountCount: 1,
				mtimeMs: now - 60_000,
			});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(getNamedBackupsMock).toHaveBeenCalledTimes(1);
		expect(restoreAccountsFromBackupMock).toHaveBeenCalledWith(
			"/mock/backups/manual-choice.json",
			{ persist: false },
		);
		expect(confirmMock).toHaveBeenCalledWith("Load manual-choice.json (1 account)?");
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acc_manual",
				email: "manual@example.com",
			}),
		);
		expect(promptLoginModeMock).toHaveBeenCalledTimes(1);
	});

	it("realigns restored family routing when a backup carries a stale active index", async () => {
		const now = Date.now();
		setInteractiveTTY(true);
		const restoredStorage = {
			version: 3 as const,
			activeIndex: 99,
			activeIndexByFamily: { codex: 99 },
			accounts: [
				{
					email: "stale@example.com",
					accountId: "acc_stale",
					refreshToken: "refresh-stale",
					accessToken: "access-stale",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "selected@example.com",
					accountId: "acc_selected",
					refreshToken: "refresh-selected",
					accessToken: "access-selected",
					expiresAt: now + 7_200_000,
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		};
		let storageState: typeof restoredStorage | null = null;
		loadAccountsMock.mockImplementation(async () =>
			storageState == null ? null : structuredClone(storageState),
		);
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/stale-index.json",
				fileName: "stale-index.json",
				accountCount: 2,
				mtimeMs: now,
			},
		]);
		restoreAccountsFromBackupMock.mockResolvedValue(structuredClone(restoredStorage));
		setCodexCliActiveSelectionMock.mockResolvedValueOnce(true);
		selectMock
			.mockResolvedValueOnce("restore-backup")
			.mockResolvedValueOnce("latest");
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(storageState).toMatchObject({
			activeIndex: 1,
			activeIndexByFamily: { codex: 1 },
		});
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acc_selected",
				email: "selected@example.com",
			}),
		);
	});

	it("clears the empty onboarding snapshot after adding the first account", async () => {
		const now = Date.now();
		let storageState: {
			version: 3;
			activeIndex: number;
			activeIndexByFamily: { codex: number };
			accounts: Array<{
				email?: string;
				accountId?: string;
				refreshToken: string;
				accessToken?: string;
				expiresAt?: number;
				addedAt: number;
				lastUsed: number;
				enabled?: boolean;
			}>;
		} | null = null;
		setInteractiveTTY(true);
		loadAccountsMock.mockImplementation(async () =>
			storageState == null ? null : structuredClone(storageState),
		);
		saveAccountsMock.mockImplementation(async (nextStorage) => {
			storageState = structuredClone(nextStorage);
		});
		getNamedBackupsMock.mockResolvedValue([
			{
				path: "/mock/backups/latest.json",
				fileName: "latest.json",
				accountCount: 1,
				mtimeMs: now,
			},
		]);
		selectMock
			.mockResolvedValueOnce("browser")
			.mockResolvedValueOnce("cancel");
		promptAddAnotherAccountMock.mockResolvedValueOnce(true);
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-added",
			refresh: "refresh-added",
			expires: now + 7_200_000,
			idToken: "id-token-added",
			multiAccount: true,
		});
		const browserModule = await import("../lib/auth/browser.js");
		vi.mocked(browserModule.openBrowserUrl).mockReturnValue(true);
		const serverModule = await import("../lib/auth/server.js");
		vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValueOnce({
			ready: true,
			waitForCode: vi.fn(async () => ({ code: "oauth-code" })),
			close: vi.fn(),
		});
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(accountsModule.extractAccountEmail).mockImplementationOnce(
			() => "added@example.com",
		);
		vi.mocked(accountsModule.extractAccountId).mockImplementationOnce(
			() => "acc_added",
		);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(getNamedBackupsMock).toHaveBeenCalledTimes(1);
		const firstSignInItems = selectMock.mock.calls[0]?.[0] as Array<{
			label: string;
			value?: string;
		}>;
		const secondSignInItems = selectMock.mock.calls[1]?.[0] as Array<{
			label: string;
			value?: string;
		}>;
		expect(firstSignInItems.some((item) => item.value === "restore-backup")).toBe(
			true,
		);
		expect(secondSignInItems.some((item) => item.value === "restore-backup")).toBe(
			false,
		);
		expect(promptLoginModeMock).toHaveBeenCalledTimes(1);
	});
	it("preserves distinct same-email workspaces when oauth login reuses a refresh token", async () => {
		const now = Date.now();
		let storageState = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "user@example.com",
					accountId: "workspace-alpha",
					accountIdSource: "org",
					accountLabel: "Workspace Alpha [id:alpha]",
					refreshToken: "shared-refresh",
					accessToken: "access-alpha",
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
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-beta",
			refresh: "shared-refresh",
			expires: now + 7_200_000,
			idToken: "id-token-beta",
			multiAccount: true,
		});
		const browserModule = await import("../lib/auth/browser.js");
		vi.mocked(browserModule.openBrowserUrl).mockReturnValue(true);
		const serverModule = await import("../lib/auth/server.js");
		vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValueOnce({
			ready: true,
			waitForCode: vi.fn(async () => ({ code: "oauth-code" })),
			close: vi.fn(),
		});
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(accountsModule.extractAccountEmail).mockImplementationOnce(
			() => "user@example.com",
		);
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([
			{
				accountId: "workspace-beta",
				source: "org",
				label: "Workspace Beta [id:beta]",
			},
		]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementationOnce(
			(candidates) => candidates[0] ?? null,
		);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(storageState.accounts).toHaveLength(2);
		expect(
			storageState.accounts.map((account) => ({
				accountId: account.accountId,
				accountIdSource: account.accountIdSource,
				accountLabel: account.accountLabel,
				email: account.email,
				refreshToken: account.refreshToken,
			})),
		).toEqual([
			{
				accountId: "workspace-alpha",
				accountIdSource: "org",
				accountLabel: "Workspace Alpha [id:alpha]",
				email: "user@example.com",
				refreshToken: "shared-refresh",
			},
			{
				accountId: "workspace-beta",
				accountIdSource: "org",
				accountLabel: "Workspace Beta [id:beta]",
				email: "user@example.com",
				refreshToken: "shared-refresh",
			},
		]);
		expect(storageState.activeIndex).toBe(1);
		expect(storageState.activeIndexByFamily.codex).toBe(1);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledTimes(1);
	});

	it("updates a unique shared-accountId login when the email claim is missing", async () => {
		const now = Date.now();
		let storageState: {
			version: 3;
			activeIndex: number;
			activeIndexByFamily: Record<string, number>;
			accounts: Array<Record<string, unknown>>;
		} = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					accountId: "acc_test",
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
		const accountsModule = await import("../lib/accounts.js");
		const browserModule = await import("../lib/auth/browser.js");
		const serverModule = await import("../lib/auth/server.js");
		vi.mocked(accountsModule.extractAccountId).mockImplementation(
			() => "acc_test",
		);
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: now + 7_200_000,
			idToken: undefined,
			multiAccount: true,
		});
		vi.mocked(browserModule.openBrowserUrl).mockReturnValue(true);
		vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValueOnce({
			ready: true,
			waitForCode: vi.fn(async () => ({ code: "oauth-code" })),
			close: vi.fn(),
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(storageState.accounts).toHaveLength(1);
		expect(storageState.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "acc_test",
				refreshToken: "refresh-new",
			}),
		);
		expect(storageState.activeIndex).toBe(0);
		expect(storageState.activeIndexByFamily.codex).toBe(0);
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
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(3);
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
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(3);
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
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				acc_a: {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					primary: {},
					secondary: {},
				},
			},
			byEmail: {},
		});
	});

	it("writes shared workspace quota cache entries by email without reusing bare accountId keys", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "beta@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
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
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {},
			byEmail: {
				"alpha@example.com": {
					updatedAt: expect.any(Number),
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
				},
				"beta@example.com": {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 70,
						windowMinutes: 300,
						resetAtMs: now + 3_000,
					},
					secondary: {
						usedPercent: 40,
						windowMinutes: 10080,
						resetAtMs: now + 4_000,
					},
				},
			},
		});
	});

	it("writes multi-workspace quota cache entries by accountId when one email spans multiple workspaces", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "owner@example.com",
					accountId: "workspace-alpha",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "owner@example.com",
					accountId: "workspace-beta",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
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
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenNthCalledWith(1, {
			accountId: "workspace-alpha",
			accessToken: "access-alpha",
			model: "gpt-5-codex",
		});
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenNthCalledWith(2, {
			accountId: "workspace-beta",
			accessToken: "access-beta",
			model: "gpt-5-codex",
		});
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				"workspace-alpha": {
					updatedAt: expect.any(Number),
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
				},
				"workspace-beta": {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 70,
						windowMinutes: 300,
						resetAtMs: now + 3_000,
					},
					secondary: {
						usedPercent: 40,
						windowMinutes: 10080,
						resetAtMs: now + 4_000,
					},
				},
			},
			byEmail: {},
		});
	});

	it("skips live probe when same-email workspaces still lack stored accountIds", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "owner@example.com",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "owner@example.com",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
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
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"owner@example.com": {
					updatedAt: now - 5_000,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 99,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 99,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha") return "workspace-alpha";
				if (accessToken === "access-beta") return "workspace-beta";
				return "acc_test";
			},
		);
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		try {
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(fetchCodexQuotaSnapshotMock).not.toHaveBeenCalled();
			expect(saveQuotaCacheMock).not.toHaveBeenCalled();
		} finally {
			extractAccountIdMock.mockReset();
			extractAccountIdMock.mockImplementation(() => "acc_test");
		}
	});

	it("does not reuse email-scoped quota cache entries for mixed same-email accountId rows", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "owner@example.com",
					accountId: "workspace-alpha",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "owner@example.com",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
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
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"owner@example.com": {
					updatedAt: now - 5_000,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 99,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 99,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		extractAccountIdMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha") return "workspace-alpha";
				if (accessToken === "access-beta") return "workspace-beta";
				return "acc_test";
			},
		);
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
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		promptLoginModeMock.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		try {
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(1);
			expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
			expect(saveQuotaCacheMock).toHaveBeenCalledWith({
				byAccountId: {
					"workspace-alpha": {
						updatedAt: expect.any(Number),
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
					},
				},
				byEmail: {},
			});
		} finally {
			extractAccountIdMock.mockReset();
			extractAccountIdMock.mockImplementation(() => "acc_test");
		}
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

	it("prefers email-scoped quota cache entries for shared workspace accounts", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "beta@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
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
			menuAutoFetchLimits: false,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: false,
			menuSortQuickSwitchVisibleRow: true,
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {
				"shared-workspace": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 99,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 99,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
			byEmail: {
				"alpha@example.com": {
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
				"beta@example.com": {
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
		}>;
		expect(firstCallAccounts.map((account) => account.email)).toEqual([
			"beta@example.com",
			"alpha@example.com",
		]);
	});

	it("prefers accountId-scoped quota cache entries when one email spans multiple workspaces", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "owner@example.com",
					accountId: "workspace-alpha",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "owner@example.com",
					accountId: "workspace-beta",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
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
			menuAutoFetchLimits: false,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: false,
			menuSortQuickSwitchVisibleRow: true,
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {
				"workspace-alpha": {
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
				"workspace-beta": {
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
			byEmail: {
				"owner@example.com": {
					updatedAt: now,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 99,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 99,
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
			accountId?: string;
			quota5hLeftPercent?: number;
		}>;
		expect(firstCallAccounts.map((account) => account.accountId)).toEqual([
			"workspace-beta",
			"workspace-alpha",
		]);
		expect(
			firstCallAccounts.map((account) => account.quota5hLeftPercent),
		).toEqual([100, 20]);
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

	it("runs doctor command in json mode with malformed token rows", async () => {
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
				{
					email: "broken@example.net",
					refreshToken: null as unknown as string,
					addedAt: now - 500,
					lastUsed: now - 500,
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
			checks: Array<{ key: string; severity: string }>;
		};
		expect(payload.command).toBe("doctor");
		expect(payload.summary.error).toBe(0);
		expect(payload.checks).toContainEqual(
			expect.objectContaining({
				key: "duplicate-refresh-token",
				severity: "ok",
			}),
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
			modelSelection: {
				requested: string;
				normalized: string;
				remapped: boolean;
				promptFamily: string;
				capabilities: { toolSearch: boolean; computerUse: boolean; compaction: boolean };
			};
		};
		expect(payload.command).toBe("report");
		expect(payload.accounts.total).toBe(2);
		expect(payload.accounts.enabled).toBe(1);
		expect(payload.accounts.disabled).toBe(1);
		expect(payload.modelSelection).toEqual({
			requested: "gpt-5-codex",
			normalized: "gpt-5-codex",
			remapped: false,
			promptFamily: "gpt-5-codex",
			capabilities: {
				toolSearch: false,
				computerUse: false,
				compaction: false,
			},
		});
	});

	it("reports normalized model routing and capabilities for remapped report probes", async () => {
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
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"report",
			"--json",
			"--model",
			"gpt-5.4-mini",
		]);

		expect(exitCode).toBe(0);
		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			modelSelection: {
				requested: string;
				normalized: string;
				remapped: boolean;
				promptFamily: string;
				capabilities: { toolSearch: boolean; computerUse: boolean; compaction: boolean };
			};
		};
		expect(payload.modelSelection).toEqual({
			requested: "gpt-5.4-mini",
			normalized: "gpt-5-mini",
			remapped: true,
			promptFamily: "gpt-5.2",
			capabilities: {
				toolSearch: true,
				computerUse: true,
				compaction: true,
			},
		});
	});

	it("drives interactive settings hub across sections and persists dashboard/backend changes", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));

		const selectSequence = queueSettingsSelectSequence([
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
		]);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(readSettingsHubPanelContract()).toEqual(
			SETTINGS_HUB_MENU_ORDER,
		);
		expect(selectSequence.remaining()).toBe(0);
		expect(saveDashboardDisplaySettingsMock).toHaveBeenCalled();
		expect(savePluginConfigMock).toHaveBeenCalledTimes(1);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				preemptiveQuotaEnabled: expect.any(Boolean),
				preemptiveQuotaRemainingPercent5h: expect.any(Number),
			}),
		);
	});

	it("shows experimental settings in the settings hub", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		queueSettingsSelectSequence([{ type: "back" }]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(readSettingsHubPanelContract()).toEqual(SETTINGS_HUB_MENU_ORDER);
	});

	it("runs experimental oc sync with mandatory preview before apply", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		detectOcChatgptMultiAuthTargetMock.mockReturnValue({ kind: "target", descriptor: { scope: "global", root: "C:/target", accountPath: "C:/target/openai-codex-accounts.json", backupRoot: "C:/target/backups", source: "default-global", resolution: "accounts" } });
		planOcChatgptSyncMock.mockResolvedValue({
			kind: "ready",
			target: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
			preview: {
				payload: { version: 3, accounts: [], activeIndex: 0 },
				merged: { version: 3, accounts: [], activeIndex: 0 },
				toAdd: [{ refreshTokenLast4: "1234" }],
				toUpdate: [],
				toSkip: [],
				unchangedDestinationOnly: [],
				activeSelectionBehavior: "preserve-destination",
			},
			payload: { version: 3, accounts: [], activeIndex: 0 },
			destination: null,
		});
		applyOcChatgptSyncMock.mockResolvedValue({
			kind: "applied",
			target: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
			preview: { merged: { version: 3, accounts: [], activeIndex: 0 } },
			merged: { version: 3, accounts: [], activeIndex: 0 },
			destination: null,
			persistedPath: "C:/target/openai-codex-accounts.json",
		});
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "sync" },
			{ type: "apply" },
			{ type: "back" },
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(planOcChatgptSyncMock).toHaveBeenCalledOnce();
		expect(applyOcChatgptSyncMock).toHaveBeenCalledOnce();
		expect(selectMock).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ label: expect.stringContaining("Active selection: preserve-destination") }),
			]),
			expect.any(Object),
		);
	});

	it("supports sync hotkeys from experimental menu through preview and applied status", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		detectOcChatgptMultiAuthTargetMock.mockReturnValue({
			kind: "target",
			descriptor: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
		});
		planOcChatgptSyncMock.mockResolvedValue({
			kind: "ready",
			target: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
			preview: {
				payload: { version: 3, accounts: [], activeIndex: 0 },
				merged: { version: 3, accounts: [], activeIndex: 0 },
				toAdd: [{ refreshTokenLast4: "1234" }],
				toUpdate: [],
				toSkip: [],
				unchangedDestinationOnly: [],
				activeSelectionBehavior: "preserve-destination",
			},
			payload: { version: 3, accounts: [], activeIndex: 0 },
			destination: null,
		});
		applyOcChatgptSyncMock.mockResolvedValue({
			kind: "applied",
			target: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
			preview: { merged: { version: 3, accounts: [], activeIndex: 0 } },
			merged: { version: 3, accounts: [], activeIndex: 0 },
			destination: null,
			persistedPath: "C:/target/openai-codex-accounts.json",
		});
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			requireSettingsHotkey("1", { type: "sync" }),
			requireSettingsHotkey("A", { type: "apply" }),
			requireSettingsHotkey("Q", { type: "back" }),
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(planOcChatgptSyncMock).toHaveBeenCalledOnce();
		expect(applyOcChatgptSyncMock).toHaveBeenCalledOnce();
	});

	it("shows guidance when experimental oc sync target is ambiguous or unreadable", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		detectOcChatgptMultiAuthTargetMock.mockReturnValue({ kind: "target", descriptor: { scope: "global", root: "C:/target", accountPath: "C:/target/openai-codex-accounts.json", backupRoot: "C:/target/backups", source: "default-global", resolution: "accounts" } });
		planOcChatgptSyncMock.mockResolvedValue({
			kind: "blocked-ambiguous",
			detection: { kind: "ambiguous", reason: "multiple targets", candidates: [] },
		});
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "sync" },
			{ type: "back" },
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(planOcChatgptSyncMock).toHaveBeenCalledOnce();
		expect(applyOcChatgptSyncMock).not.toHaveBeenCalled();
	});


	it("exports named pool backup from experimental settings", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		promptQuestionMock.mockResolvedValueOnce("backup-2026-03-10");
		runNamedBackupExportMock.mockResolvedValueOnce({ kind: "exported", path: "/mock/backups/backup-2026-03-10.json" });
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "backup" },
			{ type: "back" },
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalledOnce();
		expect(runNamedBackupExportMock).toHaveBeenCalledWith({ name: "backup-2026-03-10" });
	});

	it("supports backup hotkeys from experimental menu through result status", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		promptQuestionMock.mockResolvedValueOnce("backup-2026-03-11");
		runNamedBackupExportMock.mockResolvedValueOnce({
			kind: "exported",
			path: "/mock/backups/backup-2026-03-11.json",
		});
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			requireSettingsHotkey("2", { type: "backup" }),
			requireSettingsHotkey("Q", { type: "back" }),
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalledOnce();
		expect(runNamedBackupExportMock).toHaveBeenCalledWith({
			name: "backup-2026-03-11",
		});
	});

	it("rejects invalid or colliding experimental backup filenames", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		promptQuestionMock.mockResolvedValueOnce("../bad-name");
		runNamedBackupExportMock.mockResolvedValueOnce({ kind: "collision", path: "/mock/backups/bad-name.json" });
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "backup" },
			{ type: "back" },
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(promptQuestionMock).toHaveBeenCalledOnce();
		expect(runNamedBackupExportMock).toHaveBeenCalledWith({ name: "../bad-name" });
	});

	it("backs out of experimental sync preview without applying", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		detectOcChatgptMultiAuthTargetMock.mockReturnValue({ kind: "target", descriptor: { scope: "global", root: "C:/target", accountPath: "C:/target/openai-codex-accounts.json", backupRoot: "C:/target/backups", source: "default-global", resolution: "accounts" } });
		normalizeAccountStorageMock.mockReturnValue({ version: 3, accounts: [], activeIndex: 0 });
		planOcChatgptSyncMock.mockResolvedValue({
			kind: "ready",
			target: { scope: "global", root: "C:/target", accountPath: "C:/target/openai-codex-accounts.json", backupRoot: "C:/target/backups", source: "default-global", resolution: "accounts" },
			preview: { payload: { version: 3, accounts: [], activeIndex: 0 }, merged: { version: 3, accounts: [], activeIndex: 0 }, toAdd: [], toUpdate: [], toSkip: [], unchangedDestinationOnly: [], activeSelectionBehavior: "preserve-destination" },
			payload: { version: 3, accounts: [], activeIndex: 0 },
			destination: { version: 3, accounts: [], activeIndex: 0 },
		});
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "sync" },
			{ type: "back" },
			{ type: "back" },
			{ type: "back" },
		]);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(planOcChatgptSyncMock).toHaveBeenCalledOnce();
		expect(applyOcChatgptSyncMock).not.toHaveBeenCalled();
	});

	it("supports experimental submenu hotkeys for guardian controls", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		const configModule = await import("../lib/config.js");
		const defaults = {
			...configModule.getDefaultPluginConfig(),
			proactiveRefreshGuardian: false,
			proactiveRefreshIntervalMs: 180_000,
		};
		loadPluginConfigMock.mockReturnValue(structuredClone(defaults));
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			requireSettingsHotkey("3", { type: "toggle-refresh-guardian" }),
			requireSettingsHotkey("[", { type: "decrease-refresh-interval" }),
			requireSettingsHotkey("-", { type: "decrease-refresh-interval" }),
			requireSettingsHotkey("+", { type: "increase-refresh-interval" }),
			requireSettingsHotkey("S", { type: "save" }),
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				proactiveRefreshGuardian: !(defaults.proactiveRefreshGuardian ?? false),
				proactiveRefreshIntervalMs: 120_000,
			}),
		);
	});

	it("supports q hotkey on experimental sync status screens", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		detectOcChatgptMultiAuthTargetMock.mockReturnValue({
			kind: "target",
			descriptor: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
		});
		planOcChatgptSyncMock.mockResolvedValue({
			kind: "blocked-ambiguous",
			detection: { kind: "ambiguous", reason: "multiple targets", candidates: [] },
		});
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "sync" },
			requireSettingsHotkey("Q", { type: "back" }),
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(planOcChatgptSyncMock).toHaveBeenCalledOnce();
		expect(applyOcChatgptSyncMock).not.toHaveBeenCalled();
	});

	it("supports q hotkey to back out of experimental sync preview", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		detectOcChatgptMultiAuthTargetMock.mockReturnValue({
			kind: "target",
			descriptor: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
		});
		planOcChatgptSyncMock.mockResolvedValue({
			kind: "ready",
			target: {
				scope: "global",
				root: "C:/target",
				accountPath: "C:/target/openai-codex-accounts.json",
				backupRoot: "C:/target/backups",
				source: "default-global",
				resolution: "accounts",
			},
			preview: {
				payload: { version: 3, accounts: [], activeIndex: 0 },
				merged: { version: 3, accounts: [], activeIndex: 0 },
				toAdd: [],
				toUpdate: [],
				toSkip: [],
				unchangedDestinationOnly: [],
				activeSelectionBehavior: "preserve-destination",
			},
			payload: { version: 3, accounts: [], activeIndex: 0 },
			destination: { version: 3, accounts: [], activeIndex: 0 },
		});
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			requireSettingsHotkey("1", { type: "sync" }),
			requireSettingsHotkey("Q", { type: "back" }),
			{ type: "back" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(planOcChatgptSyncMock).toHaveBeenCalledOnce();
		expect(applyOcChatgptSyncMock).not.toHaveBeenCalled();
	});

	it("cancels experimental backup prompt on blank or q input", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		promptQuestionMock.mockResolvedValueOnce("q");
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "backup" },
			{ type: "back" },
			{ type: "back" },
		]);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);
		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(runNamedBackupExportMock).not.toHaveBeenCalled();
	});
	it("drives current settings panels through representative hotkeys and persists each section", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "hotkey-settings@example.com",
				accountId: "acc_hotkey_settings",
				refreshToken: "refresh-hotkey-settings",
				accessToken: "access-hotkey-settings",
			}),
		);
		loadDashboardDisplaySettingsMock.mockResolvedValue({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			actionAutoReturnMs: 2_000,
			actionPauseOnKey: true,
			menuAutoFetchLimits: true,
			menuQuotaTtlMs: 300_000,
			menuShowStatusBadge: true,
			menuShowCurrentBadge: true,
			menuShowLastUsed: true,
			menuShowQuotaSummary: true,
			menuShowQuotaCooldown: true,
			menuShowFetchStatus: true,
			menuHighlightCurrentRow: true,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
			menuStatuslineFields: ["last-used", "limits", "status"],
			uiThemePreset: "green",
			uiAccentColor: "green",
		});
		loadPluginConfigMock.mockReturnValue({
			preemptiveQuotaEnabled: false,
			preemptiveQuotaRemainingPercent5h: 40,
		});

		const selectSequence = queueSettingsSelectSequence([
			{ type: "account-list" },
			triggerSettingsHotkey("1"),
			triggerSettingsHotkey("m"),
			triggerSettingsHotkey("s"),
			{ type: "summary-fields" },
			triggerSettingsHotkey("]"),
			triggerSettingsHotkey("s"),
			{ type: "behavior" },
			triggerSettingsHotkey("p"),
			triggerSettingsHotkey("l"),
			triggerSettingsHotkey("1"),
			triggerSettingsHotkey("t"),
			triggerSettingsHotkey("s"),
			{ type: "theme" },
			triggerSettingsHotkey("2"),
			{ type: "set-accent", accent: "cyan" },
			triggerSettingsHotkey("s"),
			{ type: "backend" },
			triggerSettingsHotkey("2"),
			triggerSettingsHotkey("1"),
			triggerSettingsHotkey("]"),
			triggerSettingsHotkey("q", { type: "back" }),
			triggerSettingsHotkey("s"),
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(readSettingsHubPanelContract()).toEqual(
			SETTINGS_HUB_MENU_ORDER,
		);
		expect(selectSequence.remaining()).toBe(0);
		expect(saveDashboardDisplaySettingsMock).toHaveBeenCalledTimes(4);
		expect(saveDashboardDisplaySettingsMock.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				menuShowStatusBadge: false,
				menuSortMode: "manual",
			}),
		);
		expect(saveDashboardDisplaySettingsMock.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				menuStatuslineFields: ["limits", "last-used", "status"],
			}),
		);
		expect(saveDashboardDisplaySettingsMock.mock.calls[2]?.[0]).toEqual(
			expect.objectContaining({
				actionPauseOnKey: false,
				menuAutoFetchLimits: false,
				actionAutoReturnMs: 1_000,
				menuQuotaTtlMs: 600_000,
			}),
		);
		expect(saveDashboardDisplaySettingsMock.mock.calls[3]?.[0]).toEqual(
			expect.objectContaining({
				uiThemePreset: "blue",
				uiAccentColor: "cyan",
			}),
		);
		expect(savePluginConfigMock).toHaveBeenCalledTimes(1);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				preemptiveQuotaEnabled: true,
				preemptiveQuotaRemainingPercent5h: 41,
			}),
		);
	});


	it("moves guardian controls into experimental settings", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(createSettingsStorage(now));
		const configModule = await import("../lib/config.js");
		const defaults = configModule.getDefaultPluginConfig();
		loadPluginConfigMock.mockReturnValue(structuredClone(defaults));
		const selectSequence = queueSettingsSelectSequence([
			{ type: "experimental" },
			{ type: "toggle-refresh-guardian" },
			{ type: "increase-refresh-interval" },
			{ type: "save" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				proactiveRefreshGuardian: !(defaults.proactiveRefreshGuardian ?? false),
				proactiveRefreshIntervalMs: (defaults.proactiveRefreshIntervalMs ?? 60000) + 60000,
			}),
		);
	});

	it("persists representative backend edits across all current backend categories", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "backend-groups@example.com",
				accountId: "acc_backend_groups",
				refreshToken: "refresh-backend-groups",
				accessToken: "access-backend-groups",
			}),
		);
		const configModule = await import("../lib/config.js");
		const defaults = configModule.getDefaultPluginConfig();
		loadPluginConfigMock.mockReturnValue(structuredClone(defaults));

		const selectSequence = queueSettingsSelectSequence([
			{ type: "backend" },
			{ type: "open-category", key: "session-sync" },
			{ type: "toggle", key: "liveAccountSync" },
			{ type: "bump", key: "liveAccountSyncDebounceMs", direction: 1 },
			{ type: "back" },
			{ type: "open-category", key: "rotation-quota" },
			{ type: "toggle", key: "preemptiveQuotaEnabled" },
			{
				type: "bump",
				key: "preemptiveQuotaRemainingPercent5h",
				direction: 1,
			},
			{ type: "back" },
			{ type: "open-category", key: "refresh-recovery" },
			{ type: "toggle", key: "storageBackupEnabled" },
			{ type: "bump", key: "tokenRefreshSkewMs", direction: 1 },
			{ type: "back" },
			{ type: "open-category", key: "performance-timeouts" },
			{ type: "toggle", key: "parallelProbing" },
			{ type: "bump", key: "fetchTimeoutMs", direction: 1 },
			{ type: "back" },
			{ type: "save" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(savePluginConfigMock).toHaveBeenCalledTimes(1);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				liveAccountSync: !(defaults.liveAccountSync ?? false),
				liveAccountSyncDebounceMs:
					(defaults.liveAccountSyncDebounceMs ?? 50) + 50,
				preemptiveQuotaEnabled: !(defaults.preemptiveQuotaEnabled ?? false),
				preemptiveQuotaRemainingPercent5h:
					(defaults.preemptiveQuotaRemainingPercent5h ?? 0) + 1,
				storageBackupEnabled: !(defaults.storageBackupEnabled ?? false),
				tokenRefreshSkewMs:
					(defaults.tokenRefreshSkewMs ?? 60_000) + 10_000,
				parallelProbing: !(defaults.parallelProbing ?? false),
				fetchTimeoutMs: (defaults.fetchTimeoutMs ?? 60_000) + 5_000,
			}),
		);
	});

	it("clamps out-of-range backend numbers across all current categories before save", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "backend-clamp@example.com",
				accountId: "acc_backend_clamp",
				refreshToken: "refresh-backend-clamp",
				accessToken: "access-backend-clamp",
			}),
		);
		const configModule = await import("../lib/config.js");
		const defaults = configModule.getDefaultPluginConfig();
		loadPluginConfigMock.mockReturnValue({
			...structuredClone(defaults),
			liveAccountSyncDebounceMs: 0,
			preemptiveQuotaRemainingPercent5h: 999,
			proactiveRefreshBufferMs: 0,
			fetchTimeoutMs: 999_999,
		});

		const selectSequence = queueSettingsSelectSequence([
			{ type: "backend" },
			{ type: "open-category", key: "session-sync" },
			{ type: "bump", key: "liveAccountSyncDebounceMs", direction: -1 },
			{ type: "back" },
			{ type: "open-category", key: "rotation-quota" },
			{
				type: "bump",
				key: "preemptiveQuotaRemainingPercent5h",
				direction: 1,
			},
			{ type: "back" },
			{ type: "open-category", key: "refresh-recovery" },
			{ type: "bump", key: "proactiveRefreshBufferMs", direction: -1 },
			{ type: "back" },
			{ type: "open-category", key: "performance-timeouts" },
			{ type: "bump", key: "fetchTimeoutMs", direction: 1 },
			{ type: "back" },
			{ type: "save" },
			{ type: "back" },
		]);

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(selectSequence.remaining()).toBe(0);
		expect(savePluginConfigMock).toHaveBeenCalledTimes(1);
		expect(savePluginConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				liveAccountSyncDebounceMs: 50,
				preemptiveQuotaRemainingPercent5h: 100,
				proactiveRefreshBufferMs: 30_000,
				fetchTimeoutMs: 600_000,
			}),
		);
	});

	for (const { panel, mode } of SETTINGS_CANCEL_MATRIX) {
		it(`keeps no-save-on-cancel contract for panel=${panel} mode=${mode}`, async () => {
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
			setupInteractiveSettingsLogin(
				createSettingsStorage(now, {
					email: "cancel-settings@example.com",
					accountId: "acc_cancel_settings",
					refreshToken: "refresh-cancel-settings",
					accessToken: "access-cancel-settings",
				}),
			);

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
				queuedRefreshMock.mockImplementation(
					async () => refreshDeferred.promise,
				);
				queueMicrotask(() => {
					refreshDeferred.resolve({
						type: "success",
						access: "race-access",
						refresh: "race-refresh",
						expires: now + 3_600_000,
					});
				});
			}

			queueSettingsSelectSequence(createSettingsCancelSequence(panel));

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
	}

	it("retries transient EBUSY dashboard save and keeps settings flow alive", async () => {
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "retry-dashboard@example.com",
				accountId: "acc_retry_dashboard",
				refreshToken: "refresh-retry-dashboard",
				accessToken: "access-retry-dashboard",
			}),
		);

		queueSettingsSelectSequence([
			{ type: "behavior" },
			{ type: "toggle-pause" },
			{ type: "save" },
			{ type: "back" },
		]);

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
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "retry-backend@example.com",
				accountId: "acc_retry_backend",
				refreshToken: "refresh-retry-backend",
				accessToken: "access-retry-backend",
			}),
		);

		queueSettingsSelectSequence([
			{ type: "backend" },
			{ type: "open-category", key: "rotation-quota" },
			{ type: "toggle", key: "preemptiveQuotaEnabled" },
			{ type: "back" },
			{ type: "save" },
			{ type: "back" },
		]);

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
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "retry-exhausted@example.com",
				accountId: "acc_retry_exhausted",
				refreshToken: "refresh-retry-exhausted",
				accessToken: "access-retry-exhausted",
			}),
		);

		queueSettingsSelectSequence([
			{ type: "theme" },
			{ type: "set-palette", palette: "blue" },
			{ type: "save" },
			{ type: "back" },
		]);

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
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "merge-settings@example.com",
				accountId: "acc_merge_settings",
				refreshToken: "refresh-merge-settings",
				accessToken: "access-merge-settings",
			}),
		);
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

		queueSettingsSelectSequence([
			{ type: "behavior" },
			{ type: "toggle-pause" },
			{ type: "save" },
			{ type: "back" },
		]);

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
		const now = Date.now();
		setupInteractiveSettingsLogin(
			createSettingsStorage(now, {
				email: "panel-reset@example.com",
				accountId: "acc_panel_reset",
				refreshToken: "refresh-panel-reset",
				accessToken: "access-panel-reset",
			}),
		);

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

		queueSettingsSelectSequence([
			{ type: "account-list" },
			{ type: "reset" },
			{ type: "save" },
			{ type: "back" },
		]);

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

	it("does not mutate loaded quota cache when live fix account save fails", async () => {
		const now = Date.now();
		const originalQuotaCache = {
			byAccountId: {},
			byEmail: {},
		};
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "live-fix@example.com",
					accountId: "acc_live_fix",
					refreshToken: "refresh-live-fix",
					accessToken: "access-live-fix",
					expiresAt: now - 5_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValueOnce(originalQuotaCache);
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-live-fix-next",
			refresh: "refresh-live-fix-next",
			expires: now + 7_200_000,
		});
		saveAccountsMock.mockRejectedValueOnce(
			makeErrnoError("save failed", "EBUSY"),
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		await expect(
			runCodexMultiAuthCli(["auth", "fix", "--live", "--json"]),
		).rejects.toMatchObject({
			code: "EBUSY",
			message: "save failed",
		});
		expect(originalQuotaCache).toEqual({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveQuotaCacheMock).not.toHaveBeenCalled();
	});

	it("does not mutate loaded quota cache when live fix display save fails", async () => {
		const now = Date.now();
		const originalQuotaCache = {
			byAccountId: {},
			byEmail: {},
		};
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "live-fix@example.com",
					accountId: "acc_live_fix",
					refreshToken: "refresh-live-fix",
					accessToken: "access-live-fix",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValueOnce(originalQuotaCache);
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 35,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 22,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		saveQuotaCacheMock.mockRejectedValueOnce(
			makeErrnoError("save failed", "EBUSY"),
		);
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		await expect(
			runCodexMultiAuthCli(["auth", "fix", "--live"]),
		).rejects.toMatchObject({
			code: "EBUSY",
			message: "save failed",
		});
		expect(originalQuotaCache).toEqual({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				acc_live_fix: {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
					primary: {
						usedPercent: 35,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 22,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
			byEmail: {},
		});
	});

	it("persists the working quota cache for live fix display mode", async () => {
		const now = Date.now();
		const originalQuotaCache = {
			byAccountId: {},
			byEmail: {},
		};
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "live-fix@example.com",
					accountId: "acc_live_fix",
					refreshToken: "refresh-live-fix",
					accessToken: "access-live-fix",
					expiresAt: now + 60 * 60 * 1000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValueOnce(originalQuotaCache);
		fetchCodexQuotaSnapshotMock.mockResolvedValueOnce({
			status: 200,
			model: "gpt-5-codex",
			primary: {
				usedPercent: 35,
				windowMinutes: 300,
				resetAtMs: now + 1_000,
			},
			secondary: {
				usedPercent: 22,
				windowMinutes: 10080,
				resetAtMs: now + 2_000,
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "fix", "--live"]);

		expect(exitCode).toBe(0);
		expect(originalQuotaCache).toEqual({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveAccountsMock).not.toHaveBeenCalled();
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				acc_live_fix: {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
					primary: {
						usedPercent: 35,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 22,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
			byEmail: {},
		});
		expect(
			logSpy.mock.calls.some((call) =>
				String(call[0]).includes("Auto-fix scan"),
			),
		).toBe(true);
	});

	it("recomputes live quota fallback state after refresh changes a shared-workspace email", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha-stale",
					expiresAt: now - 5_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
				{
					email: "owner@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 4_000,
					lastUsed: now - 4_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"owner@example.com": {
					updatedAt: now - 5_000,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 95,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 95,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-alpha-refreshed",
			refresh: "refresh-alpha-next",
			expires: now + 7_200_000,
			idToken: "id-token-alpha",
		});
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(accountsModule.extractAccountId).mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-stale") return "shared-workspace";
				if (accessToken === "access-alpha-refreshed") return "shared-workspace";
				if (accessToken === "access-beta") return "shared-workspace";
				return "acc_test";
			},
		);
		vi.mocked(accountsModule.extractAccountEmail).mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-refreshed") return "owner@example.com";
				return undefined;
			},
		);
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
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"fix",
			"--live",
			"--json",
		]);

		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {},
			byEmail: {},
		});
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.email).toBe(
			"owner@example.com",
		);

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(
			payload.reports.filter((report) => report.outcome === "healthy"),
		).toHaveLength(2);
	});

	it("prunes stale quota email cache entries during auth fix after refresh changes a shared-workspace email", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha-stale",
					expiresAt: now - 5_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
				{
					email: "beta@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 4_000,
					lastUsed: now - 4_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"alpha@example.com": {
					updatedAt: now - 10_000,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 15,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 5,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-alpha-refreshed",
			refresh: "refresh-alpha-next",
			expires: now + 7_200_000,
			idToken: "id-token-alpha",
		});
		const accountsModule = await import("../lib/accounts.js");
		const extractAccountIdMock = vi.mocked(accountsModule.extractAccountId);
		const extractAccountEmailMock = vi.mocked(accountsModule.extractAccountEmail);
		extractAccountIdMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-stale") return "shared-workspace";
				if (accessToken === "access-alpha-refreshed") return "shared-workspace";
				if (accessToken === "access-beta") return "shared-workspace";
				return "acc_test";
			},
		);
		extractAccountEmailMock.mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-refreshed") return "owner@example.com";
				return undefined;
			},
		);
		fetchCodexQuotaSnapshotMock
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 25,
					windowMinutes: 300,
					resetAtMs: now + 1_000,
				},
				secondary: {
					usedPercent: 10,
					windowMinutes: 10080,
					resetAtMs: now + 2_000,
				},
			})
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		try {
			const exitCode = await runCodexMultiAuthCli([
				"auth",
				"fix",
				"--live",
				"--json",
			]);

			expect(exitCode).toBe(0);
			expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
			expect(saveQuotaCacheMock).toHaveBeenCalledWith({
				byAccountId: {},
				byEmail: {
					"beta@example.com": {
						updatedAt: expect.any(Number),
						status: 200,
						model: "gpt-5-codex",
						planType: undefined,
						primary: {
							usedPercent: 70,
							windowMinutes: 300,
							resetAtMs: now + 3_000,
						},
						secondary: {
							usedPercent: 40,
							windowMinutes: 10080,
							resetAtMs: now + 4_000,
						},
					},
					"owner@example.com": {
						updatedAt: expect.any(Number),
						status: 200,
						model: "gpt-5-codex",
						planType: undefined,
						primary: {
							usedPercent: 25,
							windowMinutes: 300,
							resetAtMs: now + 1_000,
						},
						secondary: {
							usedPercent: 10,
							windowMinutes: 10080,
							resetAtMs: now + 2_000,
						},
					},
				},
			});

			const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
				reports: Array<{ outcome: string }>;
			};
			expect(
				payload.reports.filter((report) => report.outcome === "healthy"),
			).toHaveLength(2);
		} finally {
			extractAccountIdMock.mockReset();
			extractAccountIdMock.mockImplementation(() => "acc_test");
			extractAccountEmailMock.mockReset();
			extractAccountEmailMock.mockImplementation(() => undefined);
		}
	});

	it("recomputes live quota fallback state after refresh changes accountId for the same email", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValueOnce({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "owner@example.com",
					accountId: "shared-workspace",
					refreshToken: "refresh-alpha",
					accessToken: "access-alpha-stale",
					expiresAt: now - 5_000,
					addedAt: now - 5_000,
					lastUsed: now - 5_000,
					enabled: true,
				},
				{
					email: "owner@example.com",
					accountId: "workspace-beta",
					refreshToken: "refresh-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					addedAt: now - 4_000,
					lastUsed: now - 4_000,
					enabled: true,
				},
			],
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {
				"owner@example.com": {
					updatedAt: now - 5_000,
					status: 200,
					model: "gpt-5-codex",
					primary: {
						usedPercent: 95,
						windowMinutes: 300,
						resetAtMs: now + 1_000,
					},
					secondary: {
						usedPercent: 95,
						windowMinutes: 10080,
						resetAtMs: now + 2_000,
					},
				},
			},
		});
		queuedRefreshMock.mockResolvedValueOnce({
			type: "success",
			access: "access-alpha-refreshed",
			refresh: "refresh-alpha-next",
			expires: now + 7_200_000,
			idToken: "id-token-alpha",
		});
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(accountsModule.extractAccountId).mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-stale") return "shared-workspace";
				if (accessToken === "access-alpha-refreshed") return "workspace-alpha";
				if (accessToken === "access-beta") return "workspace-beta";
				return "acc_test";
			},
		);
		vi.mocked(accountsModule.extractAccountEmail).mockImplementation(
			(accessToken?: string) => {
				if (accessToken === "access-alpha-refreshed") return "owner@example.com";
				return undefined;
			},
		);
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
			.mockResolvedValueOnce({
				status: 200,
				model: "gpt-5-codex",
				primary: {
					usedPercent: 70,
					windowMinutes: 300,
					resetAtMs: now + 3_000,
				},
				secondary: {
					usedPercent: 40,
					windowMinutes: 10080,
					resetAtMs: now + 4_000,
				},
			});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli([
			"auth",
			"fix",
			"--live",
			"--json",
		]);

		expect(exitCode).toBe(0);
		expect(queuedRefreshMock).toHaveBeenCalledTimes(1);
		expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(2);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledWith({
			byAccountId: {
				"workspace-alpha": {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
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
				},
				"workspace-beta": {
					updatedAt: expect.any(Number),
					status: 200,
					model: "gpt-5-codex",
					planType: undefined,
					primary: {
						usedPercent: 70,
						windowMinutes: 300,
						resetAtMs: now + 3_000,
					},
					secondary: {
						usedPercent: 40,
						windowMinutes: 10080,
						resetAtMs: now + 4_000,
					},
				},
			},
			byEmail: {},
		});
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.accountId).toBe(
			"workspace-alpha",
		);

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			reports: Array<{ outcome: string; message: string }>;
		};
		expect(
			payload.reports.filter((report) => report.outcome === "healthy"),
		).toHaveLength(2);
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

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts).toHaveLength(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.email).toBe(
			"first@example.com",
		);
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

	it("keeps settings unchanged in non-interactive mode and returns to menu", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue(
			createSettingsStorage(now, {
				email: "non-tty@example.com",
				accountId: "acc_non_tty",
				refreshToken: "refresh-non-tty",
				accessToken: "access-non-tty",
			}),
		);
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
