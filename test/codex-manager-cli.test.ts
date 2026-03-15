import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_BACKUP_DIR = fileURLToPath(
	new URL("./.vitest-mock-backups", import.meta.url),
);
const mockBackupPath = (name: string): string =>
	resolve(MOCK_BACKUP_DIR, `${name}.json`);

const loadAccountsMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const saveAccountsMock = vi.fn();
const saveFlaggedAccountsMock = vi.fn();
const setStoragePathMock = vi.fn();
const getStoragePathMock = vi.fn(() => "/mock/openai-codex-accounts.json");
const listNamedBackupsMock = vi.fn();
const assessNamedBackupRestoreMock = vi.fn();
const getNamedBackupsDirectoryPathMock = vi.fn();
const importAccountsMock = vi.fn();
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
const deleteSavedAccountsMock = vi.fn();
const resetLocalStateMock = vi.fn();
const deleteAccountAtIndexMock = vi.fn();
const planOcChatgptSyncMock = vi.fn();
const applyOcChatgptSyncMock = vi.fn();
const runNamedBackupExportMock = vi.fn();
const exportNamedBackupMock = vi.fn();
const promptQuestionMock = vi.fn();
const detectOcChatgptMultiAuthTargetMock = vi.fn();
const normalizeAccountStorageMock = vi.fn((value) => value);
const withAccountStorageTransactionMock = vi.fn();
const withAccountAndFlaggedStorageTransactionMock = vi.fn();

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
		listNamedBackups: listNamedBackupsMock,
		assessNamedBackupRestore: assessNamedBackupRestoreMock,
		getNamedBackupsDirectoryPath: getNamedBackupsDirectoryPathMock,
		importAccounts: importAccountsMock,
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

vi.mock("../lib/destructive-actions.js", () => ({
	DESTRUCTIVE_ACTION_COPY: {
		deleteSavedAccounts: {
			label: "Delete Saved Accounts",
			typedConfirm:
				"Type DELETE to delete saved accounts only (saved accounts: delete; flagged/problem accounts, settings, and Codex CLI sync state: keep): ",
			confirm:
				"Delete saved accounts? (Saved accounts: delete. Flagged/problem accounts: keep. Settings: keep. Codex CLI sync state: keep.)",
			stage: "Deleting saved accounts only",
			completed:
				"Deleted saved accounts. Saved accounts deleted; flagged/problem accounts, settings, and Codex CLI sync state kept.",
		},
		resetLocalState: {
			label: "Reset Local State",
			typedConfirm:
				"Type RESET to reset local state (saved accounts + flagged/problem accounts: delete; settings + Codex CLI sync state: keep; quota cache: clear): ",
			confirm:
				"Reset local state? (Saved accounts: delete. Flagged/problem accounts: delete. Settings: keep. Codex CLI sync state: keep. Quota cache: clear.)",
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

const confirmMock = vi.fn();

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
		withAccountAndFlaggedStorageTransactionMock.mockReset();
		withAccountStorageTransactionMock.mockReset();
		queuedRefreshMock.mockReset();
		setCodexCliActiveSelectionMock.mockReset();
		setCodexCliActiveSelectionMock.mockResolvedValue(true);
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
		deleteSavedAccountsMock.mockReset();
		resetLocalStateMock.mockReset();
		deleteAccountAtIndexMock.mockReset();
		deleteAccountAtIndexMock.mockResolvedValue(null);
		deleteSavedAccountsMock.mockResolvedValue({
			accountsCleared: true,
			flaggedCleared: false,
			quotaCacheCleared: false,
		});
		resetLocalStateMock.mockResolvedValue({
			accountsCleared: true,
			flaggedCleared: true,
			quotaCacheCleared: true,
		});
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
		listNamedBackupsMock.mockReset();
		assessNamedBackupRestoreMock.mockReset();
		getNamedBackupsDirectoryPathMock.mockReset();
		importAccountsMock.mockReset();
		confirmMock.mockReset();
		listNamedBackupsMock.mockResolvedValue([]);
		assessNamedBackupRestoreMock.mockResolvedValue({
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: null,
				sizeBytes: null,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 0,
			mergedAccountCount: 1,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		});
		getNamedBackupsDirectoryPathMock.mockReturnValue(MOCK_BACKUP_DIR);
		importAccountsMock.mockResolvedValue({
			imported: 1,
			skipped: 0,
			total: 1,
			changed: true,
		});
		confirmMock.mockResolvedValue(true);
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
		expect(withAccountStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(storageState.accounts).toHaveLength(2);
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
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValue({
			pkce: { challenge: "pkce-challenge", verifier: "pkce-verifier" },
			state: "oauth-state",
			url: "https://auth.openai.com/mock",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValue({
			type: "success",
			access: "access-new",
			refresh: "refresh-new",
			expires: now + 7_200_000,
			idToken: undefined,
			multiAccount: true,
		});
		vi.mocked(browserModule.openBrowserUrl).mockReturnValue(true);
		vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValue({
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
		};
		expect(payload.command).toBe("report");
		expect(payload.accounts.total).toBe(2);
		expect(payload.accounts.enabled).toBe(1);
		expect(payload.accounts.disabled).toBe(1);
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

	it("restores a named backup from the login recovery menu", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "restore", assessment });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(listNamedBackupsMock).toHaveBeenCalledTimes(1);
		expect(assessNamedBackupRestoreMock).toHaveBeenCalledWith(
			"named-backup",
			expect.objectContaining({
				currentStorage: expect.objectContaining({
					accounts: expect.any(Array),
				}),
			}),
		);
		expect(confirmMock).toHaveBeenCalledOnce();
		expect(importAccountsMock).toHaveBeenCalledWith(
			mockBackupPath("named-backup"),
		);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledOnce();
	});

	it("rejects a restore when the reassessed backup path escapes the backup directory", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		const escapedAssessment = {
			...assessment,
			backup: {
				...assessment.backup,
				path: resolve(MOCK_BACKUP_DIR, "../outside.json"),
			},
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock
			.mockResolvedValueOnce(assessment)
			.mockResolvedValueOnce(escapedAssessment);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "restore", assessment });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(confirmMock).toHaveBeenCalledOnce();
			expect(importAccountsMock).not.toHaveBeenCalled();
			expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
			expect(errorSpy).toHaveBeenCalledWith(
				"Restore failed: Backup path escapes backup directory",
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("offers backup restore from the login menu when no accounts are saved", async () => {
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
					addedAt: now - 500,
					lastUsed: now - 500,
					enabled: true,
				},
			],
		};
		loadAccountsMock
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockResolvedValue(restoredStorage);
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 0,
			mergedAccountCount: 1,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "restore", assessment });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(promptLoginModeMock.mock.calls[0]?.[0]).toEqual([]);
		expect(listNamedBackupsMock).toHaveBeenCalledTimes(1);
		expect(assessNamedBackupRestoreMock).toHaveBeenCalledWith(
			"named-backup",
			expect.objectContaining({ currentStorage: null }),
		);
		expect(importAccountsMock).toHaveBeenCalledWith(
			mockBackupPath("named-backup"),
		);
		expect(setCodexCliActiveSelectionMock).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "acc_restored",
				email: "restored@example.com",
				refreshToken: "refresh-restored",
				accessToken: "access-restored",
			}),
		);
	});

	it("does not restore a named backup when confirmation is declined", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		confirmMock.mockResolvedValueOnce(false);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "restore", assessment });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(listNamedBackupsMock).toHaveBeenCalledTimes(1);
		expect(assessNamedBackupRestoreMock).toHaveBeenCalledWith(
			"named-backup",
			expect.objectContaining({
				currentStorage: expect.objectContaining({
					accounts: expect.any(Array),
				}),
			}),
		);
		expect(confirmMock).toHaveBeenCalledOnce();
		expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
		expect(importAccountsMock).not.toHaveBeenCalled();
	});

	it("catches restore failures and returns to the login menu", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		importAccountsMock.mockRejectedValueOnce(
			new Error(`Import file not found: ${mockBackupPath("named-backup")}`),
		);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "restore", assessment });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
			expect(importAccountsMock).toHaveBeenCalledWith(
				mockBackupPath("named-backup"),
			);
			const restoreFailureCalls = [
				...errorSpy.mock.calls,
				...logSpy.mock.calls,
			].flat();
			expect(restoreFailureCalls).toContainEqual(
				expect.stringContaining("Restore failed: Import file not found"),
			);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("adds actionable guidance when a confirmed restore exceeds the account limit", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		importAccountsMock.mockRejectedValueOnce(
			new Error("Import would exceed maximum of 10 accounts (would have 11)"),
		);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "restore", assessment });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(errorSpy).toHaveBeenCalledWith(
				"Restore failed: Import would exceed maximum of 10 accounts (would have 11). Close other Codex instances and try again.",
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("treats post-confirm duplicate-only restores as a no-op", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		importAccountsMock.mockResolvedValueOnce({
			imported: 0,
			skipped: 1,
			total: 1,
			changed: false,
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "restore", assessment });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(importAccountsMock).toHaveBeenCalledWith(
				mockBackupPath("named-backup"),
			);
			expect(logSpy).toHaveBeenCalledWith(
				"All accounts in this backup already exist",
			);
			expect(logSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Restored backup "named-backup"'),
			);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("catches backup listing failures and returns to the login menu", async () => {
		setInteractiveTTY(true);
		listNamedBackupsMock.mockRejectedValueOnce(
			makeErrnoError(
				"EPERM: operation not permitted, scandir '/mock/backups'",
				"EPERM",
			),
		);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
			expect(assessNamedBackupRestoreMock).not.toHaveBeenCalled();
			expect(selectMock).not.toHaveBeenCalled();
			expect(importAccountsMock).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"Could not read backup directory: EPERM: operation not permitted",
				),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("propagates containment errors from batch backup assessment and returns to the login menu", async () => {
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		const now = Date.now();
		listNamedBackupsMock.mockResolvedValue([
			{
				name: "escaped-backup",
				path: mockBackupPath("escaped-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
		]);
		assessNamedBackupRestoreMock.mockRejectedValueOnce(
			new Error("Backup path escapes backup directory"),
		);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
			expect(selectMock).not.toHaveBeenCalled();
			expect(importAccountsMock).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"Restore failed: Backup path escapes backup directory",
				),
			);
			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.stringContaining('Skipped backup assessment for "escaped-backup"'),
			);
		} finally {
			errorSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("keeps healthy backups selectable when one assessment fails", async () => {
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		const now = Date.now();
		const healthyAssessment = {
			backup: {
				name: "healthy-backup",
				path: mockBackupPath("healthy-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 0,
			mergedAccountCount: 1,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([
			{
				...healthyAssessment.backup,
				name: "broken-backup",
				path: mockBackupPath("broken-backup"),
			},
			healthyAssessment.backup,
		]);
		assessNamedBackupRestoreMock.mockImplementation(async (name: string) => {
			if (name === "broken-backup") {
				throw new Error("backup directory busy");
			}
			return healthyAssessment;
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockImplementationOnce(async (items) => {
			const labels = items.map((item) => item.label);
			expect(labels).toContain("healthy-backup");
			expect(labels).not.toContain("broken-backup");
			return { type: "restore", assessment: healthyAssessment };
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(importAccountsMock).toHaveBeenCalledWith(
				mockBackupPath("healthy-backup"),
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					'Skipped backup assessment for "broken-backup": backup directory busy',
				),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("limits concurrent backup assessments in the restore menu", async () => {
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		const { NAMED_BACKUP_ASSESS_CONCURRENCY } =
			await vi.importActual<typeof import("../lib/storage.js")>(
				"../lib/storage.js",
			);
		const totalBackups = NAMED_BACKUP_ASSESS_CONCURRENCY + 3;
		const backups = Array.from({ length: totalBackups }, (_value, index) => ({
			name: `named-backup-${index + 1}`,
			path: mockBackupPath(`named-backup-${index + 1}`),
			createdAt: null,
			updatedAt: Date.now() + index,
			sizeBytes: 128,
			version: 3,
			accountCount: 1,
			schemaErrors: [],
			valid: true,
			loadError: undefined,
		}));
		const backupsByName = new Map(backups.map((backup) => [backup.name, backup]));
		let inFlight = 0;
		let maxInFlight = 0;
		let pending: Array<ReturnType<typeof createDeferred<void>>> = [];
		let releaseScheduled = false;
		const releasePending = () => {
			if (releaseScheduled) {
				return;
			}
			releaseScheduled = true;
			queueMicrotask(() => {
				releaseScheduled = false;
				if (pending.length === 0) {
					return;
				}
				const release = pending;
				pending = [];
				for (const deferred of release) {
					deferred.resolve();
				}
			});
		};
		listNamedBackupsMock.mockResolvedValue(backups);
		assessNamedBackupRestoreMock.mockImplementation(async (name: string) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const gate = createDeferred<void>();
			pending.push(gate);
			releasePending();
			await gate.promise;
			inFlight -= 1;
			return {
				backup: backupsByName.get(name) ?? backups[0],
				currentAccountCount: 0,
				mergedAccountCount: 1,
				imported: 1,
				skipped: 0,
				wouldExceedLimit: false,
				eligibleForRestore: true,
				error: undefined,
			};
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "back" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(assessNamedBackupRestoreMock).toHaveBeenCalledTimes(backups.length);
		expect(maxInFlight).toBeLessThanOrEqual(
			NAMED_BACKUP_ASSESS_CONCURRENCY,
		);
	});

	it("reassesses a backup before confirmation so the merge summary stays current", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const initialAssessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		const refreshedAssessment = {
			...initialAssessment,
			currentAccountCount: 3,
			mergedAccountCount: 4,
		};
		listNamedBackupsMock.mockResolvedValue([initialAssessment.backup]);
		assessNamedBackupRestoreMock
			.mockResolvedValueOnce(initialAssessment)
			.mockResolvedValueOnce(refreshedAssessment);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({
			type: "restore",
			assessment: initialAssessment,
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(assessNamedBackupRestoreMock).toHaveBeenNthCalledWith(
			1,
			"named-backup",
			expect.objectContaining({
				currentStorage: expect.objectContaining({
					accounts: expect.any(Array),
				}),
			}),
		);
		expect(assessNamedBackupRestoreMock).toHaveBeenNthCalledWith(
			2,
			"named-backup",
			expect.objectContaining({
				currentStorage: expect.objectContaining({
					accounts: expect.any(Array),
				}),
			}),
		);
		expect(confirmMock).toHaveBeenCalledWith(
			expect.stringContaining("add 1 new account(s)"),
		);
		expect(importAccountsMock).toHaveBeenCalledWith(
			mockBackupPath("named-backup"),
		);
	});

	it("uses metadata refresh wording when a restore only updates existing accounts", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
				{
					email: "same@example.com",
					accountId: "acc_same",
					refreshToken: "refresh-same",
					accessToken: "access-same",
					expiresAt: now + 3_600_000,
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
			],
		});
		const assessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 2,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 2,
			mergedAccountCount: 2,
			imported: 0,
			skipped: 2,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		importAccountsMock.mockResolvedValueOnce({
			imported: 0,
			skipped: 2,
			total: 2,
			changed: true,
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({
			type: "restore",
			assessment,
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(confirmMock).toHaveBeenCalledWith(
				expect.stringContaining(
					"refresh stored metadata for matching existing account(s)",
				),
			);
			expect(confirmMock).not.toHaveBeenCalledWith(
				expect.stringContaining("for 2 existing account(s)"),
			);
			expect(importAccountsMock).toHaveBeenCalledWith(
				mockBackupPath("named-backup"),
			);
			expect(logSpy).toHaveBeenCalledWith(
				'Restored backup "named-backup". Refreshed stored metadata for matching existing account(s).',
			);
			expect(logSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("Imported 0, skipped 2"),
			);
			expect(setCodexCliActiveSelectionMock).toHaveBeenCalledOnce();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("returns to the login menu when backup reassessment becomes ineligible", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const initialAssessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 0,
			mergedAccountCount: 1,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		const refreshedAssessment = {
			...initialAssessment,
			currentAccountCount: 1,
			mergedAccountCount: 1,
			imported: 0,
			skipped: 1,
			eligibleForRestore: false,
			error: "All accounts in this backup already exist",
		};
		listNamedBackupsMock.mockResolvedValue([initialAssessment.backup]);
		assessNamedBackupRestoreMock
			.mockResolvedValueOnce(initialAssessment)
			.mockResolvedValueOnce(refreshedAssessment);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({
			type: "restore",
			assessment: initialAssessment,
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
			expect(assessNamedBackupRestoreMock).toHaveBeenNthCalledWith(
				1,
				"named-backup",
				expect.objectContaining({
					currentStorage: expect.objectContaining({
						accounts: expect.any(Array),
					}),
				}),
			);
			expect(assessNamedBackupRestoreMock).toHaveBeenNthCalledWith(
				2,
				"named-backup",
				expect.objectContaining({
					currentStorage: expect.objectContaining({
						accounts: expect.any(Array),
					}),
				}),
			);
			expect(confirmMock).not.toHaveBeenCalled();
			expect(importAccountsMock).not.toHaveBeenCalled();
			expect(logSpy).toHaveBeenCalledWith(
				"All accounts in this backup already exist",
			);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("returns to the login menu when backup reassessment fails before confirmation", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
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
		});
		const initialAssessment = {
			backup: {
				name: "named-backup",
				path: mockBackupPath("named-backup"),
				createdAt: null,
				updatedAt: now,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 1,
			mergedAccountCount: 2,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([initialAssessment.backup]);
		assessNamedBackupRestoreMock
			.mockResolvedValueOnce(initialAssessment)
			.mockRejectedValueOnce(makeErrnoError("backup busy", "EBUSY"));
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({
			type: "restore",
			assessment: initialAssessment,
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			expect(promptLoginModeMock).toHaveBeenCalledTimes(2);
			expect(assessNamedBackupRestoreMock).toHaveBeenNthCalledWith(
				1,
				"named-backup",
				expect.objectContaining({
					currentStorage: expect.objectContaining({
						accounts: expect.any(Array),
					}),
				}),
			);
			expect(assessNamedBackupRestoreMock).toHaveBeenNthCalledWith(
				2,
				"named-backup",
				expect.objectContaining({
					currentStorage: expect.objectContaining({
						accounts: expect.any(Array),
					}),
				}),
			);
			expect(confirmMock).not.toHaveBeenCalled();
			expect(importAccountsMock).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("Restore failed: backup busy"),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows epoch backup timestamps in restore hints", async () => {
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		const assessment = {
			backup: {
				name: "epoch-backup",
				path: mockBackupPath("epoch-backup"),
				createdAt: null,
				updatedAt: 0,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 0,
			mergedAccountCount: 1,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "back" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		const backupItems = selectMock.mock.calls[0]?.[0];
		expect(backupItems?.[0]?.hint).toContain("1 account");
		expect(backupItems?.[0]?.hint).not.toContain("updated ");
	});

	it("formats recent backup timestamps in restore hints", async () => {
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		const now = Date.UTC(2026, 0, 10, 12, 0, 0);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
		const backups = [
			{
				name: "today-backup",
				path: mockBackupPath("today-backup"),
				createdAt: null,
				updatedAt: now - 1_000,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			{
				name: "yesterday-backup",
				path: mockBackupPath("yesterday-backup"),
				createdAt: null,
				updatedAt: now - 1.5 * 86_400_000,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			{
				name: "three-days-backup",
				path: mockBackupPath("three-days-backup"),
				createdAt: null,
				updatedAt: now - 3 * 86_400_000,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			{
				name: "older-backup",
				path: mockBackupPath("older-backup"),
				createdAt: null,
				updatedAt: now - 8 * 86_400_000,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
		];
		const assessmentsByName = new Map(
			backups.map((backup) => [
				backup.name,
				{
					backup,
					currentAccountCount: 0,
					mergedAccountCount: 1,
					imported: 1,
					skipped: 0,
					wouldExceedLimit: false,
					eligibleForRestore: true,
					error: undefined,
				},
			]),
		);
		listNamedBackupsMock.mockResolvedValue(backups);
		assessNamedBackupRestoreMock.mockImplementation(async (name: string) => {
			return assessmentsByName.get(name) ?? assessmentsByName.get(backups[0].name)!;
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "back" });

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

			expect(exitCode).toBe(0);
			const backupItems = selectMock.mock.calls[0]?.[0];
			expect(backupItems?.[0]?.hint).toContain("updated today");
			expect(backupItems?.[1]?.hint).toContain("updated yesterday");
			expect(backupItems?.[2]?.hint).toContain("updated 3d ago");
			expect(backupItems?.[3]?.hint).toContain("updated ");
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("suppresses invalid backup timestamps in restore hints", async () => {
		setInteractiveTTY(true);
		loadAccountsMock.mockResolvedValue(null);
		const assessment = {
			backup: {
				name: "nan-backup",
				path: mockBackupPath("nan-backup"),
				createdAt: null,
				updatedAt: Number.NaN,
				sizeBytes: 128,
				version: 3,
				accountCount: 1,
				schemaErrors: [],
				valid: true,
				loadError: undefined,
			},
			currentAccountCount: 0,
			mergedAccountCount: 1,
			imported: 1,
			skipped: 0,
			wouldExceedLimit: false,
			eligibleForRestore: true,
			error: undefined,
		};
		listNamedBackupsMock.mockResolvedValue([assessment.backup]);
		assessNamedBackupRestoreMock.mockResolvedValue(assessment);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		selectMock.mockResolvedValueOnce({ type: "back" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		const backupItems = selectMock.mock.calls[0]?.[0];
		expect(backupItems?.[0]?.hint).toContain("1 account");
		expect(backupItems?.[0]?.hint).not.toContain("updated ");
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

	it("waits for an in-flight menu quota refresh before resetting local state", async () => {
		const now = Date.now();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStarted = createDeferred<void>();
		const fetchDeferred = createDeferred<{
			status: number;
			model: string;
			primary: Record<string, never>;
			secondary: Record<string, never>;
		}>();

		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "first@example.com",
					accountId: "acc-first",
					accessToken: "access-first",
					expiresAt: now + 3_600_000,
					refreshToken: "refresh-first",
					addedAt: now,
					lastUsed: now,
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
			menuShowFetchStatus: true,
			menuQuotaTtlMs: 60_000,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		});
		loadQuotaCacheMock.mockResolvedValue({
			byAccountId: {},
			byEmail: {},
		});
		fetchCodexQuotaSnapshotMock.mockImplementation(async () => {
			fetchStarted.resolve();
			return fetchDeferred.promise;
		});
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "reset" })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const runPromise = runCodexMultiAuthCli(["auth", "login"]);

		await fetchStarted.promise;
		await Promise.resolve();

		expect(resetLocalStateMock).not.toHaveBeenCalled();

		fetchDeferred.resolve({
			status: 200,
			model: "gpt-5-codex",
			primary: {},
			secondary: {},
		});

		const exitCode = await runPromise;

		expect(exitCode).toBe(0);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(resetLocalStateMock).toHaveBeenCalledTimes(1);
		expect(saveQuotaCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
			resetLocalStateMock.mock.invocationCallOrder[0] ??
				Number.POSITIVE_INFINITY,
		);
		expect(logSpy).toHaveBeenCalledWith(
			"Reset local state. Saved accounts, flagged/problem accounts, and quota cache cleared; settings and Codex CLI sync state kept.",
		);
		logSpy.mockRestore();
	});

	it("waits for an in-flight menu quota refresh before starting quick check", async () => {
		const now = Date.now();
		const menuStorage = {
			version: 3 as const,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "alpha@example.com",
					accountId: "acc-alpha",
					accessToken: "access-alpha",
					expiresAt: now + 3_600_000,
					refreshToken: "refresh-alpha",
					addedAt: now,
					lastUsed: now,
					enabled: true,
				},
				{
					email: "beta@example.com",
					accountId: "acc-beta",
					accessToken: "access-beta",
					expiresAt: now + 3_600_000,
					refreshToken: "refresh-beta",
					addedAt: now,
					lastUsed: now,
					enabled: true,
				},
			],
		};
		const quickCheckStorage = {
			...menuStorage,
			accounts: [menuStorage.accounts[0]!],
		};
		let loadAccountsCalls = 0;
		loadAccountsMock.mockImplementation(async () => {
			loadAccountsCalls += 1;
			return structuredClone(
				loadAccountsCalls === 1 ? menuStorage : quickCheckStorage,
			);
		});
		loadDashboardDisplaySettingsMock.mockResolvedValue({
			showPerAccountRows: true,
			showQuotaDetails: true,
			showForecastReasons: true,
			showRecommendations: true,
			showLiveProbeNotes: true,
			menuAutoFetchLimits: true,
			menuShowFetchStatus: true,
			menuQuotaTtlMs: 60_000,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		});
		let currentQuotaCache: {
			byAccountId: Record<string, unknown>;
			byEmail: Record<string, unknown>;
		} = {
			byAccountId: {},
			byEmail: {},
		};
		loadQuotaCacheMock.mockImplementation(async () =>
			structuredClone(currentQuotaCache),
		);
		saveQuotaCacheMock.mockImplementation(async (value: typeof currentQuotaCache) => {
			currentQuotaCache = structuredClone(value);
		});
		const firstFetchStarted = createDeferred<void>();
		const secondFetchStarted = createDeferred<string>();
		const releaseFirstFetch = createDeferred<void>();
		const releaseSecondFetch = createDeferred<void>();
		let fetchCallCount = 0;
		fetchCodexQuotaSnapshotMock.mockImplementation(
			async (input: { accountId: string }) => {
				fetchCallCount += 1;
				if (fetchCallCount === 1) {
					firstFetchStarted.resolve();
					await releaseFirstFetch.promise;
				} else if (fetchCallCount === 2) {
					secondFetchStarted.resolve(input.accountId);
					await releaseSecondFetch.promise;
				}
				return {
					status: 200,
					model: "gpt-5-codex",
					primary: {},
					secondary: {},
				};
			},
		);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "check" })
			.mockResolvedValueOnce({ mode: "cancel" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const runPromise = runCodexMultiAuthCli(["auth", "login"]);

			await firstFetchStarted.promise;
			await Promise.resolve();

			expect(fetchCodexQuotaSnapshotMock).toHaveBeenCalledTimes(1);

			releaseFirstFetch.resolve();

			const secondAccountId = await secondFetchStarted.promise;
			expect(secondAccountId).toBe("acc-beta");

			releaseSecondFetch.resolve();

			const exitCode = await runPromise;

			expect(exitCode).toBe(0);
			expect(Object.keys(currentQuotaCache.byEmail)).toEqual(
				expect.arrayContaining(["alpha@example.com", "beta@example.com"]),
			);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("waits for an in-flight menu quota refresh before starting backup restore", async () => {
		setInteractiveTTY(true);
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "restore@example.com",
					accountId: "acc-restore",
					accessToken: "access-restore",
					expiresAt: now + 3_600_000,
					refreshToken: "refresh-restore",
					addedAt: now,
					lastUsed: now,
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
			menuShowFetchStatus: true,
			menuQuotaTtlMs: 60_000,
			menuSortEnabled: true,
			menuSortMode: "ready-first",
			menuSortPinCurrent: true,
			menuSortQuickSwitchVisibleRow: true,
		});
		let currentQuotaCache: {
			byAccountId: Record<string, unknown>;
			byEmail: Record<string, unknown>;
		} = {
			byAccountId: {},
			byEmail: {},
		};
		loadQuotaCacheMock.mockImplementation(async () =>
			structuredClone(currentQuotaCache),
		);
		saveQuotaCacheMock.mockImplementation(async (value: typeof currentQuotaCache) => {
			currentQuotaCache = structuredClone(value);
		});
		const fetchStarted = createDeferred<void>();
		const releaseFetch = createDeferred<void>();
		fetchCodexQuotaSnapshotMock.mockImplementation(async () => {
			fetchStarted.resolve();
			await releaseFetch.promise;
			return {
				status: 200,
				model: "gpt-5-codex",
				primary: {},
				secondary: {},
			};
		});
		listNamedBackupsMock.mockResolvedValue([]);
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "restore-backup" })
			.mockResolvedValueOnce({ mode: "cancel" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const runPromise = runCodexMultiAuthCli(["auth", "login"]);

			await fetchStarted.promise;
			await Promise.resolve();

			expect(listNamedBackupsMock).not.toHaveBeenCalled();

			releaseFetch.resolve();

			const exitCode = await runPromise;

			expect(exitCode).toBe(0);
			expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
			expect(listNamedBackupsMock).toHaveBeenCalledTimes(1);
			expect(saveQuotaCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
				listNamedBackupsMock.mock.invocationCallOrder[0] ??
					Number.POSITIVE_INFINITY,
			);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("skips a second destructive action while reset is already running", async () => {
		const now = Date.now();
		const skipMessage =
			"Another destructive action is already running. Wait for it to finish.";
		const secondMenuAttempted = createDeferred<void>();
		const skipLogged = createDeferred<void>();
		const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
			if (message === skipMessage) {
				skipLogged.resolve();
			}
		});
		const firstResetStarted = createDeferred<void>();
		const allowFirstResetToFinish = createDeferred<void>();
		let menuPromptCall = 0;

		loadAccountsMock.mockImplementation(async () => ({
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
		}));
		promptLoginModeMock.mockImplementation(async () => {
			menuPromptCall += 1;
			if (menuPromptCall === 2) {
				secondMenuAttempted.resolve();
			}
			if (menuPromptCall <= 2) {
				return { mode: "reset" };
			}
			return { mode: "cancel" };
		});
		resetLocalStateMock.mockImplementationOnce(async () => {
			firstResetStarted.resolve();
			await allowFirstResetToFinish.promise;
			return {
				accountsCleared: true,
				flaggedCleared: true,
				quotaCacheCleared: true,
			};
		});

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const firstRunPromise = runCodexMultiAuthCli(["auth", "login"]);

		await firstResetStarted.promise;

		const secondRunPromise = runCodexMultiAuthCli(["auth", "login"]);
		await secondMenuAttempted.promise;
		await skipLogged.promise;

		expect(resetLocalStateMock).toHaveBeenCalledTimes(1);

		allowFirstResetToFinish.resolve();

		const [firstExitCode, secondExitCode] = await Promise.all([
			firstRunPromise,
			secondRunPromise,
		]);

		expect(firstExitCode).toBe(0);
		expect(secondExitCode).toBe(0);
		expect(resetLocalStateMock).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalledWith(skipMessage);
		logSpy.mockRestore();
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
