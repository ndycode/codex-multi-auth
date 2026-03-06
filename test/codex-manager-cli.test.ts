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
const selectMock = vi.fn();
const rotateStoredSecretEncryptionMock = vi.fn();
const checkAndRecordIdempotencyKeyMock = vi.fn();
const auditLogMock = vi.fn();

vi.mock("../lib/logger.js", () => ({
	createLogger: vi.fn(() => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	})),
	logWarn: vi.fn(),
	maskEmail: vi.fn((email: string) => email.replace(/^(.).+(@.*)$/, "$1***$2")),
}));

vi.mock("../lib/audit.js", async () => {
	const actual = await vi.importActual("../lib/audit.js");
	return {
		...(actual as Record<string, unknown>),
		auditLog: auditLogMock,
	};
});

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
	rotateStoredSecretEncryption: rotateStoredSecretEncryptionMock,
}));

vi.mock("../lib/idempotency.js", () => ({
	checkAndRecordIdempotencyKey: checkAndRecordIdempotencyKeyMock,
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

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

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
		selectMock.mockReset();
		rotateStoredSecretEncryptionMock.mockReset();
		checkAndRecordIdempotencyKeyMock.mockReset();
		auditLogMock.mockReset();
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
		saveQuotaCacheMock.mockResolvedValue(true);
		selectMock.mockResolvedValue(undefined);
		checkAndRecordIdempotencyKeyMock.mockResolvedValue({ replayed: false });
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

	it("returns non-zero in forecast json mode when quota cache persistence fails", async () => {
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
		saveQuotaCacheMock.mockResolvedValueOnce(false);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "forecast", "--live", "--json"]);
		expect(exitCode).toBe(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			command: string;
			quotaCachePersisted: boolean;
			probeErrors: string[];
		};
		expect(payload.command).toBe("forecast");
		expect(payload.quotaCachePersisted).toBe(false);
		expect(payload.probeErrors.some((entry) => entry.includes("Failed to persist quota cache changes"))).toBe(true);
	});

	it("returns non-zero in forecast text mode when quota cache persistence fails", async () => {
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
		saveQuotaCacheMock.mockResolvedValueOnce(false);

		vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "forecast", "--live"]);
		expect(exitCode).toBe(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
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

	it("returns non-zero in fix json mode when quota cache persistence fails", async () => {
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
		saveQuotaCacheMock.mockResolvedValueOnce(false);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "fix", "--live", "--json"]);
		expect(exitCode).toBe(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);

		const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
			command: string;
			quotaCachePersisted: boolean;
		};
		expect(payload.command).toBe("fix");
		expect(payload.quotaCachePersisted).toBe(false);
	});

	it("returns non-zero in fix text mode when quota cache persistence fails", async () => {
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
		saveQuotaCacheMock.mockResolvedValueOnce(false);

		vi.spyOn(console, "log").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");

		const exitCode = await runCodexMultiAuthCli(["auth", "fix", "--live", "--dry-run"]);
		expect(exitCode).toBe(1);
		expect(saveQuotaCacheMock).toHaveBeenCalledTimes(1);
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
		const expectedTimeoutMs = 4321;
		loadPluginConfigMock.mockReturnValue({ fetchTimeoutMs: expectedTimeoutMs });

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
		expect(exchangeAuthorizationCodeMock).toHaveBeenCalledWith(
			"oauth-code",
			"pkce-verifier",
			authModule.REDIRECT_URI,
			{ timeoutMs: expectedTimeoutMs },
		);
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
			{ type: "bump", key: "retryAllAccountsAbsoluteCeilingMs", direction: 1 },
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
				retryAllAccountsAbsoluteCeilingMs: 30_000,
			}),
		);
		const savedPluginConfig = savePluginConfigMock.mock.calls[0]?.[0] as
			| { retryAllAccountsAbsoluteCeilingMs?: number }
			| undefined;
		expect(savedPluginConfig?.retryAllAccountsAbsoluteCeilingMs).toBe(30_000);
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
		promptLoginModeMock
			.mockResolvedValueOnce({ mode: "manage", toggleAccountIndex: 0 })
			.mockResolvedValueOnce({ mode: "cancel" });

		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const exitCode = await runCodexMultiAuthCli(["auth", "login"]);

		expect(exitCode).toBe(0);
		expect(saveAccountsMock).toHaveBeenCalledTimes(1);
		expect(saveAccountsMock.mock.calls[0]?.[0]?.accounts?.[0]?.enabled).toBe(false);
	});

	it("maps audited commands to expected actions and outcomes", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const { AuditAction, AuditOutcome } = await import("../lib/audit.js");
		const { createAuthorizationFlow } = await import("../lib/auth/auth.js");

		vi.mocked(createAuthorizationFlow).mockRejectedValueOnce(new Error("mock login failure"));
		await expect(runCodexMultiAuthCli(["auth", "login"])).rejects.toThrow("mock login failure");
		expect(auditLogMock).toHaveBeenCalledWith(
			AuditAction.AUTH_LOGIN,
			"cli-user",
			"codex auth login",
			AuditOutcome.FAILURE,
			expect.objectContaining({ command: "login", error: expect.any(String) }),
		);

		auditLogMock.mockClear();
		const switchCode = await runCodexMultiAuthCli(["auth", "switch"]);
		expect(switchCode).toBe(1);
		expect(auditLogMock).toHaveBeenCalledWith(
			AuditAction.ACCOUNT_SWITCH,
			"cli-user",
			"codex auth switch",
			AuditOutcome.FAILURE,
			expect.objectContaining({ command: "switch", exitCode: 1 }),
		);

		auditLogMock.mockClear();
		loadAccountsMock.mockResolvedValueOnce(null);
		const checkCode = await runCodexMultiAuthCli(["auth", "check"]);
		expect(checkCode).toBe(0);
		expect(auditLogMock).toHaveBeenCalledWith(
			AuditAction.REQUEST_START,
			"cli-user",
			"codex auth check",
			AuditOutcome.SUCCESS,
			expect.objectContaining({ command: "check", exitCode: 0 }),
		);

		auditLogMock.mockClear();
		loadFlaggedAccountsMock.mockResolvedValueOnce({ version: 1, accounts: [] });
		const verifyCode = await runCodexMultiAuthCli(["auth", "verify-flagged", "--json"]);
		expect(verifyCode).toBe(0);
		expect(auditLogMock).toHaveBeenCalledWith(
			AuditAction.ACCOUNT_REFRESH,
			"cli-user",
			"codex auth verify-flagged",
			AuditOutcome.SUCCESS,
			expect.objectContaining({ command: "verify-flagged", exitCode: 0 }),
		);

		auditLogMock.mockClear();
		loadAccountsMock.mockResolvedValueOnce(null);
		const forecastCode = await runCodexMultiAuthCli(["auth", "forecast", "--json"]);
		expect(forecastCode).toBe(0);
		expect(auditLogMock).toHaveBeenCalledWith(
			AuditAction.COMMAND_RUN,
			"cli-user",
			"codex auth forecast",
			AuditOutcome.SUCCESS,
			expect.objectContaining({ command: "forecast", exitCode: 0 }),
		);

		auditLogMock.mockClear();
		loadAccountsMock.mockResolvedValueOnce(null);
		const statusCode = await runCodexMultiAuthCli(["auth", "status"]);
		expect(statusCode).toBe(0);
		expect(auditLogMock).toHaveBeenCalledWith(
			AuditAction.COMMAND_RUN,
			"cli-user",
			"codex auth status",
			AuditOutcome.SUCCESS,
			expect.objectContaining({ command: "status", exitCode: 0 }),
		);
	});

	it("sanitizes audited thrown errors with token and email redaction", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
		const { AuditAction, AuditOutcome } = await import("../lib/audit.js");
		const secretError = new Error(
			[
				"EBUSY while refreshing account",
				"HTTP 429 from upstream",
				"user@example.com",
				"sk-test-secret-abcdefghijklmnopqrstuvwxyz",
				"refresh_token_sensitive-abcdef12",
				"access_token_sensitive-qwerty12",
				"secret-access-token",
				"x".repeat(260),
			].join(" | "),
		);
		loadAccountsMock.mockRejectedValueOnce(secretError);

		await expect(runCodexMultiAuthCli(["auth", "status"])).rejects.toThrow(secretError);
		expect(auditLogMock).toHaveBeenCalledTimes(1);

		const call = auditLogMock.mock.calls[0];
		expect(call?.[0]).toBe(AuditAction.COMMAND_RUN);
		expect(call?.[3]).toBe(AuditOutcome.FAILURE);
		const metadata = call?.[4] as Record<string, unknown> | undefined;
		const sanitizedError = typeof metadata?.error === "string" ? metadata.error : "";
		expect(sanitizedError.length).toBeLessThanOrEqual(200);
		expect(sanitizedError).toContain("EBUSY");
		expect(sanitizedError).toContain("429");
		expect(sanitizedError).not.toContain("sk-test-secret-abcdefghijklmnopqrstuvwxyz");
		expect(sanitizedError).not.toContain("refresh_token_sensitive-abcdef12");
		expect(sanitizedError).not.toContain("access_token_sensitive-qwerty12");
		expect(sanitizedError).not.toContain("secret-access-token");
		expect(sanitizedError).not.toContain("user@example.com");
		expect(sanitizedError).toContain("***REDACTED***");
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

	it("supports paginated json output for list command", async () => {
		const now = Date.now();
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					email: "one@example.com",
					accountId: "acc_one",
					refreshToken: "refresh-one",
					addedAt: now - 2_000,
					lastUsed: now - 2_000,
					enabled: true,
				},
				{
					email: "two@example.com",
					accountId: "acc_two",
					refreshToken: "refresh-two",
					addedAt: now - 1_000,
					lastUsed: now - 1_000,
					enabled: true,
				},
			],
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const firstExitCode = await runCodexMultiAuthCli([
				"auth",
				"list",
				"--json",
				"--page-size",
				"1",
			]);
			expect(firstExitCode).toBe(0);
			const firstPayload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
				schemaVersion: number;
				accounts: Array<{ email: string }>;
				pagination: {
					cursor: string | null;
					nextCursor: string | null;
					hasMore: boolean;
					pageSize: number;
				};
			};
			expect(typeof firstPayload.schemaVersion).toBe("number");
			expect(firstPayload.pagination.cursor).toBeNull();
			expect(firstPayload.pagination.pageSize).toBe(1);
			expect(firstPayload.accounts).toHaveLength(1);
			expect(firstPayload.accounts[0]?.email).toBe("one@example.com");
			expect(firstPayload.pagination.hasMore).toBe(true);
			expect(firstPayload.pagination.nextCursor).toBeTruthy();

			logSpy.mockClear();
			const secondExitCode = await runCodexMultiAuthCli([
				"auth",
				"list",
				"--json",
				"--page-size",
				"1",
				"--cursor",
				String(firstPayload.pagination.nextCursor),
			]);
			expect(secondExitCode).toBe(0);
			const secondPayload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
				schemaVersion: number;
				accounts: Array<{ email: string }>;
				pagination: {
					cursor: string | null;
					nextCursor: string | null;
					hasMore: boolean;
					pageSize: number;
				};
			};
			expect(typeof secondPayload.schemaVersion).toBe("number");
			expect(secondPayload.pagination.cursor).toBe(String(firstPayload.pagination.nextCursor));
			expect(secondPayload.pagination.pageSize).toBe(1);
			expect(secondPayload.accounts).toHaveLength(1);
			expect(secondPayload.accounts[0]?.email).toBe("two@example.com");
			expect(secondPayload.pagination.hasMore).toBe(false);
			expect(secondPayload.pagination.nextCursor).toBeNull();
		} finally {
			logSpy.mockRestore();
		}
	});

	it("rejects malformed pagination cursors in JSON list mode", async () => {
		loadAccountsMock.mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [
				{
					email: "one@example.com",
					accountId: "acc_one",
					refreshToken: "refresh-one",
					addedAt: Date.now() - 2_000,
					lastUsed: Date.now() - 2_000,
					enabled: true,
				},
			],
		});

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const malformedPayloadCursor = Buffer.from("12junk", "utf8").toString("base64");
			const invalidPayloadExitCode = await runCodexMultiAuthCli([
				"auth",
				"list",
				"--json",
				"--cursor",
				malformedPayloadCursor,
			]);
			expect(invalidPayloadExitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("Invalid --cursor value");

			errorSpy.mockClear();
			const invalidBase64ExitCode = await runCodexMultiAuthCli([
				"auth",
				"list",
				"--json",
				"--cursor",
				"%%%invalid-base64%%%",
			]);
			expect(invalidBase64ExitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("Invalid --cursor value");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rejects partially numeric --page-size values", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli([
				"auth",
				"list",
				"--json",
				"--page-size",
				"10junk",
			]);
			expect(exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("--page-size must be between 1 and 200");
			expect(loadAccountsMock).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("applies idempotency key for rotate-secrets automation retries", async () => {
		checkAndRecordIdempotencyKeyMock
			.mockResolvedValueOnce({ replayed: false })
			.mockResolvedValueOnce({ replayed: true });
		rotateStoredSecretEncryptionMock.mockResolvedValue({
			accounts: 2,
			flaggedAccounts: 1,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const firstExitCode = await runCodexMultiAuthCli([
				"auth",
				"rotate-secrets",
				"--json",
				"--idempotency-key",
				"rotation-001",
			]);
			expect(firstExitCode).toBe(0);
			const firstPayload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
				rotated: boolean;
				replayed: boolean;
			};
			expect(firstPayload.rotated).toBe(true);
			expect(firstPayload.replayed).toBe(false);

			logSpy.mockClear();
			const secondExitCode = await runCodexMultiAuthCli([
				"auth",
				"rotate-secrets",
				"--json",
				"--idempotency-key=rotation-001",
			]);
			expect(secondExitCode).toBe(0);
			const secondPayload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
				rotated: boolean;
				replayed: boolean;
			};
			expect(secondPayload.rotated).toBe(true);
			expect(secondPayload.replayed).toBe(true);
			expect(rotateStoredSecretEncryptionMock).toHaveBeenCalledTimes(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("rejects option-smuggling for --idempotency-key", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli([
				"auth",
				"rotate-secrets",
				"--idempotency-key",
				"--json",
			]);
			expect(exitCode).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith("Missing value for --idempotency-key");
			expect(rotateStoredSecretEncryptionMock).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("redacts rotate-secrets failure details in non-json output", async () => {
		rotateStoredSecretEncryptionMock.mockRejectedValue(
			new Error(
				"failed for person@example.com Bearer sk_test+/123== refresh_token=rt+/456==",
			),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const exitCode = await runCodexMultiAuthCli(["auth", "rotate-secrets"]);
			expect(exitCode).toBe(1);
			const rendered = String(errorSpy.mock.calls[0]?.[0] ?? "");
			expect(rendered).toContain("Failed to rotate stored secrets:");
			expect(rendered).toContain("***REDACTED***");
			expect(rendered).not.toContain("person@example.com");
			expect(rendered).not.toContain("sk_test+/123==");
			expect(rendered).not.toContain("rt+/456==");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("enforces ABAC idempotency-key requirement for rotate-secrets", async () => {
		const previousRole = process.env.CODEX_AUTH_ROLE;
		const previousAbacRequirement = process.env.CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY;
		process.env.CODEX_AUTH_ROLE = "admin";
		process.env.CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY = "secrets:rotate";
		rotateStoredSecretEncryptionMock.mockResolvedValue({
			accounts: 1,
			flaggedAccounts: 0,
		});

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { runCodexMultiAuthCli } = await import("../lib/codex-manager.js");
			const deniedExitCode = await runCodexMultiAuthCli([
				"auth",
				"rotate-secrets",
				"--json",
			]);
			expect(deniedExitCode).toBe(1);
			expect(rotateStoredSecretEncryptionMock).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("idempotency key"),
			);

			errorSpy.mockClear();
			const allowedExitCode = await runCodexMultiAuthCli([
				"auth",
				"rotate-secrets",
				"--json",
				"--idempotency-key",
				"rotation-allowed",
			]);
			expect(allowedExitCode).toBe(0);
			expect(rotateStoredSecretEncryptionMock).toHaveBeenCalledTimes(1);
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
			if (previousRole === undefined) {
				delete process.env.CODEX_AUTH_ROLE;
			} else {
				process.env.CODEX_AUTH_ROLE = previousRole;
			}
			if (previousAbacRequirement === undefined) {
				delete process.env.CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY;
			} else {
				process.env.CODEX_AUTH_ABAC_REQUIRE_IDEMPOTENCY_KEY = previousAbacRequirement;
			}
		}
	});
});
