import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = "1";

vi.mock("@codex-ai/plugin/tool", () => {
	const makeSchema = () => ({
		optional: () => makeSchema(),
		describe: () => makeSchema(),
	});

	const tool = (definition: unknown) => definition;
	(tool as unknown as { schema: unknown }).schema = {
		number: () => makeSchema(),
		boolean: () => makeSchema(),
		string: () => makeSchema(),
	};

	return { tool };
});

vi.mock("../lib/auth/auth.js", () => ({
	createAuthorizationFlow: vi.fn(async () => ({
		pkce: { verifier: "test-verifier", challenge: "test-challenge" },
		state: "test-state",
		url: "https://auth.openai.com/test",
	})),
	exchangeAuthorizationCode: vi.fn(async () => ({
		type: "success" as const,
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 3600_000,
		idToken: "id-token",
	})),
	parseAuthorizationInput: vi.fn((input: string) => {
		const codeMatch = input.match(/code=([^&]+)/);
		const stateMatch = input.match(/state=([^&#]+)/);
		return {
			code: codeMatch?.[1],
			state: stateMatch?.[1],
		};
	}),
	redactOAuthUrlForLog: vi.fn((url: string) => url.replace(/state=[^&]+/, "state=%3Credacted%3E")),
	REDIRECT_URI: "http://localhost:1455/auth/callback",
}));

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(async () => ({
		type: "success" as const,
		access: "refreshed-access",
		refresh: "refreshed-refresh",
		expires: Date.now() + 3600_000,
	})),
}));

vi.mock("../lib/auth/browser.js", () => ({
	isBrowserLaunchSuppressed: vi.fn(() => false),
	openBrowserUrl: vi.fn(),
}));

vi.mock("../lib/auth/server.js", () => ({
	startLocalOAuthServer: vi.fn(async () => ({
		ready: true,
		close: vi.fn(),
		waitForCode: vi.fn(async () => ({ code: "auth-code" })),
	})),
}));

vi.mock("../lib/cli.js", () => ({
	promptLoginMode: vi.fn(async () => ({ mode: "add" })),
	promptAddAnotherAccount: vi.fn(async () => false),
}));

vi.mock("../lib/config.js", () => ({
	getCodexMode: () => true,
	getFastSession: () => false,
	getFastSessionStrategy: () => "hybrid",
	getFastSessionMaxInputItems: () => 30,
	getRateLimitToastDebounceMs: () => 5000,
	getRetryAllAccountsMaxRetries: () => 3,
	getRetryAllAccountsMaxWaitMs: () => 30000,
	getRetryAllAccountsRateLimited: () => true,
	getUnsupportedCodexPolicy: vi.fn(() => "fallback"),
	getFallbackOnUnsupportedCodexModel: vi.fn(() => true),
	getFallbackToGpt52OnUnsupportedGpt53: vi.fn(() => false),
	getUnsupportedCodexFallbackChain: () => ({}),
	getTokenRefreshSkewMs: () => 60000,
	getSessionRecovery: () => false,
	getAutoResume: () => false,
	getToastDurationMs: () => 5000,
	getPerProjectAccounts: () => false,
	getEmptyResponseMaxRetries: () => 2,
	getEmptyResponseRetryDelayMs: () => 1000,
	getPidOffsetEnabled: () => false,
	getFetchTimeoutMs: () => 60000,
	getStreamStallTimeoutMs: () => 45000,
	getLiveAccountSync: vi.fn(() => false),
	getLiveAccountSyncDebounceMs: () => 250,
	getLiveAccountSyncPollMs: () => 2000,
	getSessionAffinity: () => false,
	getSessionAffinityTtlMs: () => 1_200_000,
	getSessionAffinityMaxEntries: () => 512,
	getProactiveRefreshGuardian: () => false,
	getProactiveRefreshIntervalMs: () => 60000,
	getProactiveRefreshBufferMs: () => 300000,
	getNetworkErrorCooldownMs: () => 0,
	getServerErrorCooldownMs: () => 0,
	getStorageBackupEnabled: () => true,
	getPreemptiveQuotaEnabled: () => true,
	getPreemptiveQuotaRemainingPercent5h: () => 5,
	getPreemptiveQuotaRemainingPercent7d: () => 5,
	getPreemptiveQuotaMaxDeferralMs: () => 2 * 60 * 60_000,
	getCodexTuiV2: () => false,
	getCodexTuiColorProfile: () => "ansi16",
	getCodexTuiGlyphMode: () => "ascii",
	loadPluginConfig: () => ({}),
}));

const liveAccountSyncSyncToPathMock = vi.fn(async () => {});
const liveAccountSyncStopMock = vi.fn();
const liveAccountSyncCtorMock = vi.fn(
	class MockLiveAccountSync {
		syncToPath = liveAccountSyncSyncToPathMock;
		stop = liveAccountSyncStopMock;

		getSnapshot() {
			return {
				running: true,
				reloadCount: 0,
			};
		}
	},
);

vi.mock("../lib/live-account-sync.js", () => ({
	LiveAccountSync: liveAccountSyncCtorMock,
}));

vi.mock("../lib/request/request-transformer.js", () => ({
	applyFastSessionDefaults: <T>(config: T) => config,
}));

vi.mock("../lib/logger.js", () => ({
	initLogger: vi.fn(),
	logRequest: vi.fn(),
	logDebug: vi.fn(),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn(),
	setCorrelationId: vi.fn(() => "test-correlation-id"),
	clearCorrelationId: vi.fn(),
	createLogger: vi.fn(() => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		time: vi.fn(() => vi.fn(() => 0)),
		timeEnd: vi.fn(),
	})),
}));

vi.mock("../lib/auto-update-checker.js", () => ({
	checkAndNotify: vi.fn(async () => {}),
}));

vi.mock("../lib/context-overflow.js", () => ({
	handleContextOverflow: vi.fn(async () => ({ handled: false })),
}));

vi.mock("../lib/rotation.js", () => ({
	addJitter: (ms: number) => ms,
}));

vi.mock("../lib/prompts/codex.js", () => ({
	getModelFamily: (model: string) => {
		if (model.includes("codex-max")) return "codex-max";
		if (model.includes("codex")) return "codex";
		return "gpt-5.1";
	},
	getCodexInstructions: vi.fn(async () => "test instructions"),
	MODEL_FAMILIES: ["codex-max", "codex", "gpt-5.1"] as const,
	prewarmCodexInstructions: vi.fn(),
}));

vi.mock("../lib/prompts/host-codex-prompt.js", () => ({
	prewarmHostCodexPrompt: vi.fn(),
}));

vi.mock("../lib/recovery.js", () => ({
	createSessionRecoveryHook: vi.fn(),
	isRecoverableError: () => false,
	detectErrorType: () => "unknown",
	getRecoveryToastContent: () => ({ title: "Error", message: "Test" }),
}));

vi.mock("../lib/request/rate-limit-backoff.js", () => ({
	getRateLimitBackoff: () => ({ attempt: 1, delayMs: 1000 }),
	RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS: 5000,
	resetRateLimitBackoff: vi.fn(),
}));

	vi.mock("../lib/request/fetch-helpers.js", () => ({
		extractRequestUrl: (input: unknown) => (typeof input === "string" ? input : String(input)),
		rewriteUrlForCodex: (url: string) => url,
		applyProxyCompatibleInit: vi.fn((_url: string, init: RequestInit) => init),
		transformRequestForCodex: vi.fn(async (init: unknown) => ({
		updatedInit: init,
		body: { model: "gpt-5.1" },
	})),
		shouldRefreshToken: () => false,
		refreshAndUpdateToken: vi.fn(async (auth: unknown) => auth),
		createCodexHeaders: vi.fn(() => new Headers()),
		handleErrorResponse: vi.fn(async (response: Response) => ({ response })),
		isWorkspaceDisabledError: (status: number, code: string, bodyText: string) =>
			status === 403 &&
			(code.toLowerCase().includes("workspace_disabled") ||
				code.toLowerCase().includes("workspace_expired") ||
				bodyText.toLowerCase().includes("workspace disabled") ||
				bodyText.toLowerCase().includes("workspace expired")),
	getUnsupportedCodexModelInfo: vi.fn(() => ({ isUnsupported: false })),
	resolveUnsupportedCodexFallbackModel: vi.fn(() => undefined),
	shouldFallbackToGpt52OnUnsupportedGpt53: vi.fn(() => false),
	handleSuccessResponse: vi.fn(async (response: Response) => response),
}));

const mockStorage = {
	version: 3 as const,
	accounts: [] as Array<{
		accountId?: string;
		accountIdSource?: string;
		accountLabel?: string;
		email?: string;
		refreshToken: string;
		addedAt?: number;
		lastUsed?: number;
		coolingDownUntil?: number;
		rateLimitResetTimes?: Record<string, number>;
		lastSwitchReason?: string;
		workspaces?: Array<{
			id: string;
			name?: string;
			enabled: boolean;
			disabledAt?: number;
			isDefault?: boolean;
		}>;
		currentWorkspaceIndex?: number;
	}>,
	activeIndex: 0,
	activeIndexByFamily: {} as Record<string, number>,
};

const cloneMockAccount = (account: (typeof mockStorage.accounts)[number]) => ({
	...account,
	workspaces: account.workspaces?.map((workspace) => ({ ...workspace })),
});

const loadAccountsMock = vi.fn(async () => mockStorage);
const saveAccountsMock = vi.fn(
	async (storage: {
		version: 3;
		accounts: typeof mockStorage.accounts;
		activeIndex: number;
		activeIndexByFamily?: Record<string, number>;
	}) => {
		mockStorage.version = storage.version;
		mockStorage.accounts = storage.accounts.map((account) => cloneMockAccount(account));
		mockStorage.activeIndex = storage.activeIndex;
		mockStorage.activeIndexByFamily = {
			...(storage.activeIndexByFamily ?? {}),
		};
	},
);
const clearAccountsMock = vi.fn(async () => {
	mockStorage.accounts = [];
	mockStorage.activeIndex = 0;
	mockStorage.activeIndexByFamily = {};
});
let storageTransactionQueue: Promise<unknown> = Promise.resolve();
const withAccountStorageTransactionMock = vi.fn(
	async (
		handler: (
			current: {
				version: 3;
				accounts: typeof mockStorage.accounts;
				activeIndex: number;
				activeIndexByFamily: Record<string, number>;
			},
			persist: (storage: {
				version: 3;
				accounts: typeof mockStorage.accounts;
				activeIndex: number;
				activeIndexByFamily?: Record<string, number>;
			}) => Promise<void>,
		) => Promise<unknown>,
	) => {
		const run = async () =>
			handler(
				{
					version: 3,
					accounts: mockStorage.accounts.map((account) => cloneMockAccount(account)),
					activeIndex: mockStorage.activeIndex,
					activeIndexByFamily: { ...mockStorage.activeIndexByFamily },
				},
				async (storage) => {
					await saveAccountsMock(storage);
				},
			);
		const nextRun = storageTransactionQueue.then(run, run);
		storageTransactionQueue = nextRun.then(
			() => undefined,
			() => undefined,
		);
		return nextRun;
	},
);

const syncCodexCliSelectionMock = vi.fn(async (_index: number) => {});

vi.mock("../lib/storage.js", async () => {
	const actual = await vi.importActual("../lib/storage.js");
	return {
		...(actual as Record<string, unknown>),
		getStoragePath: () => "/mock/path/accounts.json",
		loadAccounts: loadAccountsMock,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: withAccountStorageTransactionMock,
		clearAccounts: clearAccountsMock,
		setStoragePath: vi.fn(),
		setStorageBackupEnabled: vi.fn(),
		exportAccounts: vi.fn(async () => {}),
		importAccounts: vi.fn(async () => ({ imported: 2, skipped: 1, total: 5 })),
		loadFlaggedAccounts: vi.fn(async () => ({ version: 1, accounts: [] })),
		saveFlaggedAccounts: vi.fn(async () => {}),
		clearFlaggedAccounts: vi.fn(async () => {}),
		StorageError: class StorageError extends Error {
			hint: string;
			constructor(message: string, hint: string) {
				super(message);
				this.hint = hint;
			}
		},
		formatStorageErrorHint: () => "Check file permissions",
	};
});

const extractAccountEmailMock = vi.fn(() => "user@example.com");
const extractAccountIdMock = vi.fn(() => "account-1");
const getAccountIdCandidatesMock = vi.fn(() => [{ accountId: "acc-1", source: "token", label: "Test" }]);
const selectBestAccountCandidateMock = vi.fn(
	(candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
);

vi.mock("../lib/accounts.js", async () => {
	const tokenUtils = await vi.importActual("../lib/auth/token-utils.js");
	class MockAccountManager {
		private accounts = [
			{
				index: 0,
				accountId: "acc-1",
				email: "user1@example.com",
				refreshToken: "refresh-1",
			},
		];

		static async loadFromDisk() {
			return new MockAccountManager();
		}

		getAccountCount() {
			return this.accounts.length;
		}

		getCurrentOrNextForFamily() {
			return this.accounts[0] ?? null;
		}

		getCurrentOrNextForFamilyHybrid() {
			return this.accounts[0] ?? null;
		}

		getCurrentWorkspace(account: Record<string, unknown>) {
			const workspaces = Array.isArray(account.workspaces) ? account.workspaces : [];
			const currentWorkspaceIndex =
				typeof account.currentWorkspaceIndex === "number"
					? account.currentWorkspaceIndex
					: 0;
			return workspaces[currentWorkspaceIndex] ?? null;
		}

		recordSuccess() {}
		recordRateLimit() {}
		recordFailure() {}

		toAuthDetails() {
			return {
				type: "oauth" as const,
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			};
		}

		hasRefreshToken() {
			return true;
		}

		saveToDiskDebounced() {}
		updateFromAuth() {}
		clearAuthFailures() {}
		incrementAuthFailures() { return 1; }
		async saveToDisk() {}
		markAccountCoolingDown() {}
		markRateLimited() {}
		markRateLimitedWithReason() {}
		consumeToken() { return true; }
		refundToken() {}
		syncCodexCliActiveSelectionForIndex(index: number) {
			return syncCodexCliSelectionMock(index);
		}
		markSwitched() {}
		removeAccount() {}

		getMinWaitTimeForFamily() {
			return 0;
		}

		shouldShowAccountToast() {
			return false;
		}

		markToastShown() {}

		getCurrentWorkspace() {
			return null;
		}

		disableCurrentWorkspace() {
			return false;
		}

		rotateToNextWorkspace() {
			return null;
		}

		hasEnabledWorkspaces() {
			return true;
		}

		setActiveIndex(index: number) {
			return this.accounts[index] ?? null;
		}

		getAccountsSnapshot() {
			return this.accounts;
		}
	}

	return {
		AccountManager: MockAccountManager,
		getAccountIdCandidates: getAccountIdCandidatesMock,
		selectBestAccountCandidate: selectBestAccountCandidateMock,
		extractAccountEmail: extractAccountEmailMock,
		extractAccountId: extractAccountIdMock,
		resolveRuntimeRequestIdentity: ({
			storedAccountId,
			source,
			storedEmail,
			accessToken,
			idToken,
		}: {
			storedAccountId?: string;
			source?: string;
			storedEmail?: string;
			accessToken?: string;
			idToken?: string;
		}) => {
			const tokenUtilsModule =
				tokenUtils as typeof import("../lib/auth/token-utils.js");
			const tokenAccountId = extractAccountIdMock(accessToken);
			const tokenEmail = tokenUtilsModule.sanitizeEmail(
				extractAccountEmailMock(accessToken, idToken),
			);
			const sanitizedStoredEmail = tokenUtilsModule.sanitizeEmail(storedEmail);
			return {
				accountId: tokenUtilsModule.resolveRequestAccountId(
					storedAccountId,
					source as never,
					tokenAccountId,
				),
				email: tokenEmail ?? sanitizedStoredEmail,
				tokenAccountId,
			};
		},
		resolveRequestAccountId: (
			tokenUtils as typeof import("../lib/auth/token-utils.js")
		).resolveRequestAccountId,
		formatAccountLabel: (_account: unknown, index: number) => `Account ${index + 1}`,
		formatCooldown: () => null,
		formatWaitTime: (ms: number) => `${Math.round(ms / 1000)}s`,
		sanitizeEmail: (email: string | undefined) =>
			typeof email === "string" ? email.trim().toLowerCase() : undefined,
		shouldUpdateAccountIdFromToken: () => true,
		parseRateLimitReason: () => "unknown",
		lookupCodexCliTokensByEmail: vi.fn(async () => null),
		isCodexCliSyncEnabled: () => true,
	};
});

type ToolExecute<T = void> = { execute: (args: T) => Promise<string> };
type PluginType = {
	event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
	auth: {
		provider: string;
		methods: Array<{ label: string; type: string }>;
		loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{
			apiKey?: string;
			baseURL?: string;
			fetch?: (input: unknown, init?: unknown) => Promise<Response>;
		}>;
	};
	tool: {
		"edit": ToolExecute<{
			path: string;
			oldString?: string;
			newString?: string;
			replaceAll?: boolean;
			lineRef?: string;
			endLineRef?: string;
			operation?: string;
			content?: string;
		}>;
		"apply_patch": ToolExecute<{
			path: string;
			oldString?: string;
			newString?: string;
			replaceAll?: boolean;
			lineRef?: string;
			endLineRef?: string;
			operation?: string;
			content?: string;
		}>;
		"hashline_read": ToolExecute<{
			path: string;
			startLine?: number;
			maxLines?: number;
		}>;
		"codex-list": ToolExecute;
		"codex-switch": ToolExecute<{ index: number }>;
		"codex-status": ToolExecute;
		"codex-metrics": ToolExecute;
		"codex-health": ToolExecute;
		"codex-remove": ToolExecute<{ index: number }>;
		"codex-refresh": ToolExecute;
		"codex-export": ToolExecute<{ path: string; force?: boolean }>;
		"codex-import": ToolExecute<{ path: string }>;
	};
};

const createMockClient = () => ({
	tui: { showToast: vi.fn() },
	auth: { set: vi.fn() },
	session: { prompt: vi.fn() },
});

describe("OpenAIOAuthPlugin", () => {
	let plugin: PluginType;
	let mockClient: ReturnType<typeof createMockClient>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockClient = createMockClient();
		storageTransactionQueue = Promise.resolve();
		extractAccountEmailMock.mockReset();
		extractAccountEmailMock.mockImplementation(() => "user@example.com");
		extractAccountIdMock.mockReset();
		extractAccountIdMock.mockImplementation(() => "account-1");
		getAccountIdCandidatesMock.mockReset();
		getAccountIdCandidatesMock.mockImplementation(() => [
			{ accountId: "acc-1", source: "token", label: "Test" },
		]);
		selectBestAccountCandidateMock.mockReset();
		selectBestAccountCandidateMock.mockImplementation(
			(candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
		);

		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};

		const { OpenAIOAuthPlugin } = await import("../index.js");
		plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	describe("plugin structure", () => {
		it("exports event handler", () => {
			expect(plugin.event).toBeDefined();
			expect(typeof plugin.event).toBe("function");
		});

		it("exports auth configuration", () => {
			expect(plugin.auth).toBeDefined();
			expect(plugin.auth.provider).toBe("openai");
		});

		it("exports tool definitions", () => {
			expect(plugin.tool).toBeDefined();
			expect(plugin.tool["edit"]).toBeDefined();
			expect(plugin.tool["apply_patch"]).toBeDefined();
			expect(plugin.tool["hashline_read"]).toBeDefined();
			expect(plugin.tool["codex-list"]).toBeDefined();
			expect(plugin.tool["codex-switch"]).toBeDefined();
			expect(plugin.tool["codex-status"]).toBeDefined();
			expect(plugin.tool["codex-metrics"]).toBeDefined();
			expect(plugin.tool["codex-health"]).toBeDefined();
			expect(plugin.tool["codex-remove"]).toBeDefined();
			expect(plugin.tool["codex-refresh"]).toBeDefined();
			expect(plugin.tool["codex-export"]).toBeDefined();
			expect(plugin.tool["codex-import"]).toBeDefined();
		});

		it("hides advanced admin tools when explicit flag is not enabled", async () => {
			const previous = process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS;
			delete process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS;
			try {
				const mockClient = createMockClient();
				const { OpenAIOAuthPlugin } = await import("../index.js");
				const defaultPlugin = await OpenAIOAuthPlugin({
					client: mockClient,
				} as never) as unknown as PluginType;

				expect(defaultPlugin.tool["codex-metrics"]).toBeUndefined();
				expect(defaultPlugin.tool["codex-remove"]).toBeUndefined();
				expect(defaultPlugin.tool["codex-refresh"]).toBeUndefined();
				expect(defaultPlugin.tool["codex-export"]).toBeUndefined();
				expect(defaultPlugin.tool["codex-import"]).toBeUndefined();
			} finally {
				if (previous === undefined) {
					delete process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS;
				} else {
					process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = previous;
				}
			}
		});

		it("has two auth methods", () => {
			expect(plugin.auth.methods).toHaveLength(2);
			expect(plugin.auth.methods[0].label).toBe("ChatGPT Plus/Pro MULTI (Codex Subscription)");
			expect(plugin.auth.methods[1].label).toBe("ChatGPT Plus/Pro MULTI (Manual URL Paste)");
		});

		it("uses manual auth flow when browser launch is globally suppressed", async () => {
			const browserModule = await import("../lib/auth/browser.js");
			vi.mocked(browserModule.isBrowserLaunchSuppressed).mockReturnValueOnce(true);
			const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
			const autoMethod = plugin.auth.methods[0] as unknown as {
				authorize: (inputs?: Record<string, string>) => Promise<{
					method: string;
					instructions: string;
					validate: (input: string) => string | undefined;
				}>;
			};

			const flow = await autoMethod.authorize();

			expect(flow.method).toBe("code");
			expect(flow.instructions).toContain("copy the full redirect URL");
			expect(flow.validate("invalid-callback-value")).toContain("No authorization code found");
			expect(openBrowserUrlMock).not.toHaveBeenCalled();
		});

		it("does not open the browser when the oauth callback server fails to start", async () => {
			const browserModule = await import("../lib/auth/browser.js");
			const loggerModule = await import("../lib/logger.js");
			const serverModule = await import("../lib/auth/server.js");
			const openBrowserUrlMock = vi.mocked(browserModule.openBrowserUrl);
			vi.mocked(serverModule.startLocalOAuthServer).mockRejectedValueOnce(
				new Error("EADDRINUSE"),
			);

			const autoMethod = plugin.auth.methods[0] as unknown as {
				authorize: () => Promise<unknown>;
			};
			await autoMethod.authorize();
			const warnCall = vi.mocked(loggerModule.logWarn).mock.calls.at(-1)?.[0];

			expect(openBrowserUrlMock).not.toHaveBeenCalled();
			expect(warnCall).toBe(
				'\n[codex-multi-auth] OAuth callback server failed to start. Please retry with "ChatGPT Plus/Pro MULTI (Manual URL Paste)".\n',
			);
		});

		it("rejects manual OAuth callbacks with mismatched state", async () => {
			const authModule = await import("../lib/auth/auth.js");
			const manualMethod = plugin.auth.methods[1] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string; reason?: string; message?: string }>;
				}>;
			};

			const flow = await manualMethod.authorize();
			const invalidInput = "http://127.0.0.1:1455/auth/callback?code=abc123&state=wrong-state";

			expect(flow.validate(invalidInput)).toContain("state mismatch");
			const result = await flow.callback(invalidInput);
			expect(result.type).toBe("failed");
			expect(result.reason).toBe("invalid_response");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).not.toHaveBeenCalled();
		});

		it("uses REDIRECT_URI in manual callback validation copy", async () => {
			const authModule = await import("../lib/auth/auth.js");
			const manualMethod = plugin.auth.methods[1] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
				}>;
			};
			const flow = await manualMethod.authorize();

			const message = flow.validate("invalid-callback-value");
			expect(message).toContain(authModule.REDIRECT_URI);
		});

		it("redacts oauth state from logged oauth URL", async () => {
			const authModule = await import("../lib/auth/auth.js");
			const loggerModule = await import("../lib/logger.js");
			const browserModule = await import("../lib/auth/browser.js");
			const serverModule = await import("../lib/auth/server.js");
			const flow: Awaited<ReturnType<typeof authModule.createAuthorizationFlow>> = {
				pkce: { verifier: "v", challenge: "c" },
				state: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				url: "https://auth.openai.com/oauth/authorize?state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&response_type=code&client_id=test",
			};
			vi.mocked(authModule.createAuthorizationFlow).mockResolvedValue(flow);
			vi.mocked(browserModule.openBrowserUrl).mockReturnValue(true);
			vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValue({
				ready: true,
				close: vi.fn(),
				waitForCode: vi.fn(async () => ({ code: "auth-code" })),
			});

			const autoMethod = plugin.auth.methods[0] as unknown as {
				authorize: () => Promise<unknown>;
			};
			await autoMethod.authorize();

			expect(vi.mocked(loggerModule.logInfo)).toHaveBeenCalledWith(
				expect.stringContaining("state=%3Credacted%3E"),
			);
			expect(vi.mocked(loggerModule.logInfo)).not.toHaveBeenCalledWith(
				expect.stringContaining("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
			);
		});
	});

	describe("event handler", () => {
		it("handles account.select event", async () => {
			await plugin.event({ event: { type: "account.select", properties: { index: 0 } } });
		});

		it("handles openai.account.select event", async () => {
			await plugin.event({ event: { type: "openai.account.select", properties: { index: 0 } } });
		});

		it("ignores events with different provider", async () => {
			await plugin.event({
				event: { type: "account.select", properties: { provider: "other", index: 0 } },
			});
		});

		it("handles events without properties", async () => {
			await plugin.event({ event: { type: "unknown.event" } });
		});
	});

	describe("auth loader", () => {
		it("returns empty for non-oauth auth", async () => {
			const getAuth = async () => ({ type: "apikey" as const, key: "test" });
			const result = await plugin.auth.loader(getAuth, {});
			expect(result).toEqual({});
		});

		it("returns SDK config for oauth without multiAccount marker", async () => {
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
			});
			const result = await plugin.auth.loader(getAuth, {});
			expect(result.apiKey).toBeDefined();
			expect(result.baseURL).toBeDefined();
			expect(result.fetch).toBeDefined();
		});

		it("returns SDK config for multiAccount oauth", async () => {
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});
			const result = await plugin.auth.loader(getAuth, { options: {}, models: {} });
			expect(result.apiKey).toBeDefined();
			expect(result.baseURL).toBeDefined();
			expect(result.fetch).toBeDefined();
		});

		it("serializes live sync setup when loader is called concurrently", async () => {
			const configModule = await import("../lib/config.js");
			vi.mocked(configModule.getLiveAccountSync).mockReturnValue(true);
			liveAccountSyncCtorMock.mockClear();
			liveAccountSyncSyncToPathMock.mockClear();

			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			try {
				await Promise.all([
					plugin.auth.loader(getAuth, { options: {}, models: {} }),
					plugin.auth.loader(getAuth, { options: {}, models: {} }),
					plugin.auth.loader(getAuth, { options: {}, models: {} }),
				]);

				expect(liveAccountSyncCtorMock).toHaveBeenCalledTimes(1);
				expect(liveAccountSyncSyncToPathMock).toHaveBeenCalledTimes(1);
			} finally {
				vi.mocked(configModule.getLiveAccountSync).mockReturnValue(false);
			}
		});
	});

	describe("codex-list tool", () => {
		it("returns message when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("No Codex accounts configured");
			expect(result).toContain("codex login");
		});

		it("lists accounts with status", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com", accountId: "acc-1" },
				{ refreshToken: "r2", email: "user2@example.com", accountId: "acc-2" },
			];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("Codex Accounts (2)");
			expect(result).toContain("Account 1");
			expect(result).toContain("Account 2");
		});

		it("shows rate-limited status", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user@example.com",
					rateLimitResetTimes: { "codex": Date.now() + 60000 },
				},
			];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("rate-limited");
		});

		it("shows cooldown status", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user@example.com",
					coolingDownUntil: Date.now() + 60000,
				},
			];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("cooldown");
		});
	});

	describe("codex-switch tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-switch"].execute({ index: 1 });
			expect(result).toContain("No Codex accounts configured");
		});

		it("returns error for invalid index", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const result = await plugin.tool["codex-switch"].execute({ index: 5 });
			expect(result).toContain("Invalid account number");
		});

		it("switches to valid account", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com" },
				{ refreshToken: "r2", email: "user2@example.com" },
			];
			const result = await plugin.tool["codex-switch"].execute({ index: 2 });
			expect(result).toContain("Switched to account");
		});

		it("reloads account manager from disk when cached manager exists", async () => {
			const { AccountManager } = await import("../lib/accounts.js");
			const loadFromDiskSpy = vi.spyOn(AccountManager, "loadFromDisk");
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com" },
				{ refreshToken: "r2", email: "user2@example.com" },
			];

			await plugin.auth.loader(getAuth, { options: {}, models: {} });
			loadFromDiskSpy.mockClear();

			await plugin.tool["codex-switch"].execute({ index: 2 });
			expect(loadFromDiskSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("codex-status tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-status"].execute();
			expect(result).toContain("No Codex accounts configured");
		});

		it("shows detailed status for accounts", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com", lastUsed: Date.now() - 60000 },
			];
			mockStorage.activeIndexByFamily = { codex: 0 };
			const result = await plugin.tool["codex-status"].execute();
			expect(result).toContain("Account Status");
			expect(result).toContain("Active index by model family");
		});
	});

	describe("codex-metrics tool", () => {
		it("shows runtime metrics", async () => {
			const result = await plugin.tool["codex-metrics"].execute();
			expect(result).toContain("Codex Plugin Metrics");
			expect(result).toContain("Total upstream requests");
		});
	});

	describe("codex-health tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-health"].execute();
			expect(result).toContain("No Codex accounts configured");
		});

		it("checks health of accounts", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com" },
			];
			const result = await plugin.tool["codex-health"].execute();
			expect(result).toContain("Health Check");
			expect(result).toContain("Healthy");
		});
	});

	describe("codex-remove tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-remove"].execute({ index: 1 });
			expect(result).toContain("No Codex accounts configured");
		});

		it("returns error for invalid index", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const result = await plugin.tool["codex-remove"].execute({ index: 5 });
			expect(result).toContain("Invalid account number");
		});

		it("removes valid account", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com" },
				{ refreshToken: "r2", email: "user2@example.com" },
			];
			const result = await plugin.tool["codex-remove"].execute({ index: 1 });
			expect(result).toContain("Removed");
			expect(mockStorage.accounts).toHaveLength(1);
		});

		it("handles removal of last account", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-remove"].execute({ index: 1 });
			expect(result).toContain("Removed");
			expect(result).toContain("No accounts remaining");
		});
	});

	describe("codex-refresh tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-refresh"].execute();
			expect(result).toContain("No Codex accounts configured");
		});

		it("refreshes accounts", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com" },
			];
			const result = await plugin.tool["codex-refresh"].execute();
			expect(result).toContain("Refreshing");
			expect(result).toContain("Refreshed");
		});
	});

	describe("codex-export tool", () => {
		it("exports accounts to file", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const result = await plugin.tool["codex-export"].execute({
				path: "/tmp/backup.json",
			});
			expect(result).toContain("Exported");
		});
	});

	describe("codex-import tool", () => {
		it("imports accounts from file", async () => {
			const result = await plugin.tool["codex-import"].execute({
				path: "/tmp/backup.json",
			});
			expect(result).toContain("Import complete");
			expect(result).toContain("New accounts: 2");
		});
	});
});

describe("OpenAIOAuthPlugin edge cases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	it("handles event handler errors gracefully", async () => {
		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.event({ event: { type: "account.select", properties: { index: "not-a-number" } } });
	});

	it("handles storage errors in codex-switch", async () => {
		const { saveAccounts } = await import("../lib/storage.js");
		vi.mocked(saveAccounts).mockRejectedValueOnce(new Error("Write failed"));

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-switch"].execute({ index: 1 });
		expect(result).toContain("failed to persist");
	});

	it("handles export errors", async () => {
		const { exportAccounts } = await import("../lib/storage.js");
		vi.mocked(exportAccounts).mockRejectedValueOnce(new Error("Export failed"));

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-export"].execute({
			path: "/tmp/backup.json",
		});
		expect(result).toContain("Export failed");
	});

	it("handles import errors", async () => {
		const { importAccounts } = await import("../lib/storage.js");
		vi.mocked(importAccounts).mockRejectedValueOnce(new Error("Import failed"));

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-import"].execute({
			path: "/tmp/backup.json",
		});
		expect(result).toContain("Import failed");
	});

	it("handles health check failures", async () => {
		const { queuedRefresh } = await import("../lib/refresh-queue.js");
		vi.mocked(queuedRefresh).mockRejectedValueOnce(new Error("Network error"));

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-health"].execute();
		expect(result).toContain("Error");
		expect(result).toContain("0 healthy, 1 unhealthy");
	});

	it("handles refresh failures", async () => {
		const { queuedRefresh } = await import("../lib/refresh-queue.js");
		vi.mocked(queuedRefresh).mockResolvedValueOnce({
			type: "failed" as const,
			reason: "http_error",
			message: "Token expired",
		});

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-refresh"].execute();
		expect(result).toContain("Failed");
	});

	it("handles refresh throwing errors", async () => {
		const { queuedRefresh } = await import("../lib/refresh-queue.js");
		vi.mocked(queuedRefresh).mockRejectedValueOnce(new Error("Network timeout"));

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-refresh"].execute();
		expect(result).toContain("Error");
		expect(result).toContain("Network timeout");
	});

	it("handles storage errors in codex-remove", async () => {
		const { saveAccounts } = await import("../lib/storage.js");
		vi.mocked(saveAccounts).mockRejectedValueOnce(new Error("Write failed"));

		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user1@example.com" },
			{ refreshToken: "r2", email: "user2@example.com" },
		];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-remove"].execute({ index: 1 });
		expect(result).toContain("failed to persist");
	});

	it("adjusts activeIndex when removing account before it", async () => {
		// When activeIndex=2 and we remove index 0 (1-based: 1), the remaining accounts
		// have length 2. Since activeIndex (2) >= length (2), it resets to 0.
		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user1@example.com" },
			{ refreshToken: "r2", email: "user2@example.com" },
			{ refreshToken: "r3", email: "user3@example.com" },
		];
		mockStorage.activeIndex = 2;
		mockStorage.activeIndexByFamily = { codex: 2 };

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.tool["codex-remove"].execute({ index: 1 });
		// After removing account at 0-based index 0, length is 2.
		// activeIndex (2) >= length (2), so it resets to 0
		expect(mockStorage.activeIndex).toBe(0);
		expect(mockStorage.activeIndexByFamily.codex).toBe(0);
	});

	it("resets activeIndex when removing active account at end", async () => {
		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user1@example.com" },
			{ refreshToken: "r2", email: "user2@example.com" },
		];
		mockStorage.activeIndex = 1;
		mockStorage.activeIndexByFamily = { codex: 1 };

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.tool["codex-remove"].execute({ index: 2 });
		expect(mockStorage.activeIndex).toBe(0);
	});
});

describe("OpenAIOAuthPlugin fetch handler", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		syncCodexCliSelectionMock.mockClear();
		mockStorage.accounts = [
			{
				accountId: "acc-1",
				email: "user@example.com",
				refreshToken: "refresh-1",
			},
		];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	const setupPlugin = async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = await plugin.auth.loader(getAuth, { options: {}, models: {} });
		return { plugin, sdk, mockClient };
	};

	const buildRoutingManager = (
		accounts: Array<{
			index: number;
			accountId?: string;
			accountIdSource?: string;
			email?: string;
			refreshToken: string;
			accessToken?: string;
			idToken?: string;
		}>,
	) => {
		let selection = 0;
		return {
			getAccountCount: () => accounts.length,
			getCurrentOrNextForFamilyHybrid: () => accounts[selection++] ?? null,
			getCurrentOrNextForFamily: () => accounts[selection++] ?? null,
			getCurrentWorkspace: (account: {
				workspaces?: Array<{ id: string; name?: string; enabled?: boolean }>;
				currentWorkspaceIndex?: number;
			}) => {
				const workspaces = Array.isArray(account.workspaces) ? account.workspaces : [];
				const currentWorkspaceIndex =
					typeof account.currentWorkspaceIndex === "number"
						? account.currentWorkspaceIndex
						: 0;
				return workspaces[currentWorkspaceIndex] ?? null;
			},
			getAccountByIndex: (index: number) => accounts[index] ?? null,
			getAccountsSnapshot: () => accounts,
			isAccountAvailableForFamily: (index: number) => Boolean(accounts[index]),
			toAuthDetails: (account: (typeof accounts)[number]) => ({
				type: "oauth" as const,
				access: account.accessToken ?? `access-${account.accountId ?? account.index}`,
				refresh: account.refreshToken,
				expires: Date.now() + 60_000,
				...(account.idToken ? { idToken: account.idToken } : {}),
			}),
			hasRefreshToken: () => true,
			saveToDiskDebounced: () => {},
			updateFromAuth: () => {},
			clearAuthFailures: () => {},
			incrementAuthFailures: () => 1,
			saveToDisk: async () => {},
			markAccountCoolingDown: () => {},
			markRateLimited: () => {},
			markRateLimitedWithReason: () => {},
			consumeToken: () => true,
			refundToken: () => {},
			syncCodexCliActiveSelectionForIndex: async (index: number) =>
				syncCodexCliSelectionMock(index),
			markSwitched: () => {},
			removeAccount: () => {},
			recordFailure: () => {},
			recordSuccess: () => {},
			recordRateLimit: () => {},
			getMinWaitTimeForFamily: () => 0,
			shouldShowAccountToast: () => false,
			markToastShown: () => {},
			setActiveIndex: (index: number) => accounts[index] ?? null,
		};
	};

	it("returns success response for successful fetch", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		expect(syncCodexCliSelectionMock).toHaveBeenCalledWith(0);
	});

	it("uses the refreshed token email when checking entitlement blocks", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const manager = buildRoutingManager([
			{
				index: 0,
				accountId: "acc-1",
				email: "stale@example.com",
				refreshToken: "refresh-1",
			},
		]);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
		extractAccountEmailMock.mockReturnValueOnce("fresh@example.com");
		const entitlementModule = await import("../lib/entitlement-cache.js");
		const isBlockedSpy = vi
			.spyOn(entitlementModule.EntitlementCache.prototype, "isBlocked")
			.mockImplementation(() => {
				expect(manager.getAccountsSnapshot()[0]?.email).toBe("stale@example.com");
				return { blocked: false, waitMs: 0 };
			});
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		expect(isBlockedSpy).toHaveBeenCalledWith(
			"account:acc-1::email:fresh@example.com",
			"gpt-5.1",
		);
		expect(manager.getAccountsSnapshot()[0]?.email).toBe("fresh@example.com");
	});

	it.each([
		["org", "workspace-alpha"],
		["manual", "workspace-beta"],
	] as const)(
		"preserves %s-selected workspace in primary request routing",
		async (accountIdSource, expectedAccountId) => {
			const { AccountManager } = await import("../lib/accounts.js");
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			const manager = buildRoutingManager([
				{
					index: 0,
					accountId: expectedAccountId,
					accountIdSource,
					email: "owner@example.com",
					refreshToken: "refresh-1",
					accessToken: "access-primary",
				},
			]);
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
			extractAccountIdMock.mockReturnValueOnce("token-personal");
			vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
				(_init, accountId, accessToken) =>
					new Headers({
						"x-test-account-id": String(accountId),
						"x-test-access-token": String(accessToken),
					}),
			);
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "ok" }), { status: 200 }),
			);

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});

			expect(response.status).toBe(200);
			const headers = new Headers(
				vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers,
			);
			expect(headers.get("x-test-account-id")).toBe(expectedAccountId);
			expect(headers.get("x-test-access-token")).toBe("access-primary");
		},
	);

	it("keeps token-derived routing on the refreshed token accountId", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const manager = buildRoutingManager([
			{
				index: 0,
				accountId: "workspace-alpha",
				accountIdSource: "token",
				email: "owner@example.com",
				refreshToken: "refresh-1",
				accessToken: "access-primary",
			},
		]);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
		extractAccountIdMock.mockReturnValueOnce("token-personal");
		vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
			(_init, accountId, accessToken) =>
				new Headers({
					"x-test-account-id": String(accountId),
					"x-test-access-token": String(accessToken),
				}),
		);
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "ok" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		const headers = new Headers(
			vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers,
		);
		expect(headers.get("x-test-account-id")).toBe("token-personal");
	});

	it("preserves stored workspace routing after a first-account network failure", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const manager = buildRoutingManager([
			{
				index: 0,
				accountId: "token-primary",
				accountIdSource: "token",
				email: "alpha@example.com",
				refreshToken: "refresh-1",
				accessToken: "access-alpha",
			},
			{
				index: 1,
				accountId: "workspace-fallback",
				accountIdSource: "org",
				email: "beta@example.com",
				refreshToken: "refresh-2",
				accessToken: "access-beta",
			},
		]);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
		extractAccountIdMock
			.mockReturnValueOnce("token-primary")
			.mockReturnValueOnce("token-personal-fallback");
		vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
			(_init, accountId, accessToken) =>
				new Headers({
					"x-test-account-id": String(accountId),
					"x-test-access-token": String(accessToken),
				}),
		);
		globalThis.fetch = vi
			.fn()
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
		const thirdHeaders = new Headers(
			vi.mocked(globalThis.fetch).mock.calls[2]?.[1]?.headers,
		);
		expect(thirdHeaders.get("x-test-account-id")).toBe("workspace-fallback");
		expect(thirdHeaders.get("x-test-access-token")).toBe("access-beta");
		expect(syncCodexCliSelectionMock).toHaveBeenCalledWith(1);
	});

	it("attaches proxy dispatcher returned by the helper to the primary upstream request", async () => {
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const proxyDispatcher = { kind: "proxy-dispatcher" };
		vi.mocked(fetchHelpers.applyProxyCompatibleInit).mockImplementation((_url, init) => ({
			...(init ?? {}),
			dispatcher: proxyDispatcher,
		}));
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "ok" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		expect(vi.mocked(fetchHelpers.applyProxyCompatibleInit)).toHaveBeenCalled();
		const firstInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
		expect(firstInit.dispatcher).toBe(proxyDispatcher);
	});

	it("preserves proxy dispatcher on fallback retry requests", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const proxyDispatcher = { kind: "proxy-dispatcher" };
		const manager = buildRoutingManager([
			{
				index: 0,
				accountId: "token-primary",
				accountIdSource: "token",
				email: "alpha@example.com",
				refreshToken: "refresh-1",
				accessToken: "access-alpha",
			},
			{
				index: 1,
				accountId: "workspace-fallback",
				accountIdSource: "org",
				email: "beta@example.com",
				refreshToken: "refresh-2",
				accessToken: "access-beta",
			},
		]);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
		vi.mocked(fetchHelpers.applyProxyCompatibleInit).mockImplementation((_url, init) => ({
			...(init ?? {}),
			dispatcher: proxyDispatcher,
		}));
		globalThis.fetch = vi
			.fn()
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		expect(vi.mocked(fetchHelpers.applyProxyCompatibleInit)).toHaveBeenCalledTimes(3);
		const thirdInit = vi.mocked(globalThis.fetch).mock.calls[2]?.[1] as RequestInit;
		expect(thirdInit.dispatcher).toBe(proxyDispatcher);
	});
	it("locks fallback entitlement checks to a stable account snapshot before mutating the shared account", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const entitlementModule = await import("../lib/entitlement-cache.js");
		const manager = buildRoutingManager([
			{
				index: 0,
				accountId: "token-primary",
				accountIdSource: "token",
				email: "alpha@example.com",
				refreshToken: "refresh-1",
				accessToken: "access-alpha",
			},
			{
				index: 1,
				accountId: "workspace-fallback",
				accountIdSource: "org",
				email: "beta-stale@example.com",
				refreshToken: "refresh-2",
				accessToken: "access-beta",
				idToken: "id-token-beta",
			},
		]);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
		extractAccountIdMock
			.mockReturnValueOnce("token-primary")
			.mockReturnValueOnce("token-personal-fallback");
		extractAccountEmailMock
			.mockReturnValueOnce("alpha@example.com")
			.mockReturnValueOnce("beta-fresh@example.com");
		vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
			(_init, accountId, accessToken) =>
				new Headers({
					"x-test-account-id": String(accountId),
					"x-test-access-token": String(accessToken),
				}),
		);
		const isBlockedSpy = vi
			.spyOn(entitlementModule.EntitlementCache.prototype, "isBlocked")
			.mockImplementation((key) => {
				if (key === "account:workspace-fallback::email:beta-fresh@example.com") {
					const fallbackSnapshot = manager.getAccountsSnapshot()[1];
					expect(fallbackSnapshot?.accountId).toBe("workspace-fallback");
					expect(fallbackSnapshot?.email).toBe("beta-stale@example.com");
				}
				return { blocked: false, waitMs: 0 };
			});
		globalThis.fetch = vi
			.fn()
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		expect(isBlockedSpy).toHaveBeenCalledWith(
			"account:workspace-fallback::email:beta-fresh@example.com",
			"gpt-5.1",
		);
		const fallbackAfterRequest = manager.getAccountsSnapshot()[1];
		expect(fallbackAfterRequest?.accountId).toBe("workspace-fallback");
		expect(fallbackAfterRequest?.email).toBe("beta-fresh@example.com");
	});

	it("preserves a non-token fallback accountIdSource when the stored accountId was originally missing", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const manager = buildRoutingManager([
			{
				index: 0,
				accountId: "token-primary",
				accountIdSource: "token",
				email: "alpha@example.com",
				refreshToken: "refresh-1",
				accessToken: "access-alpha",
			},
			{
				index: 1,
				accountIdSource: "org",
				email: "beta-stale@example.com",
				refreshToken: "refresh-2",
				accessToken: "access-beta",
				idToken: "id-token-beta",
			},
		]);
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
		extractAccountIdMock
			.mockReturnValueOnce("token-primary")
			.mockReturnValueOnce("workspace-fallback");
		extractAccountEmailMock
			.mockReturnValueOnce("alpha@example.com")
			.mockReturnValueOnce("beta-fresh@example.com");
		vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
			(_init, accountId, accessToken) =>
				new Headers({
					"x-test-account-id": String(accountId),
					"x-test-access-token": String(accessToken),
				}),
		);
		globalThis.fetch = vi
			.fn()
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockRejectedValueOnce(new Error("Network timeout"))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
		const fallbackAfterRequest = manager.getAccountsSnapshot()[1];
		expect(fallbackAfterRequest?.accountId).toBe("workspace-fallback");
		expect(fallbackAfterRequest?.accountIdSource).toBe("org");
		expect(fallbackAfterRequest?.email).toBe("beta-fresh@example.com");
	});

	it("preserves per-request fallback entitlement keys during concurrent fetch failover", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const entitlementModule = await import("../lib/entitlement-cache.js");
		const accounts = [
			{
				index: 0,
				accountId: "token-primary",
				accountIdSource: "token",
				email: "alpha@example.com",
				refreshToken: "refresh-1",
				accessToken: "access-alpha",
			},
			{
				index: 1,
				accountId: "workspace-fallback",
				accountIdSource: "org",
				email: "beta-stale@example.com",
				refreshToken: "refresh-2",
				accessToken: "access-beta",
				idToken: "id-token-beta",
			},
		];
		let selectionCount = 0;
		const manager = {
			...buildRoutingManager(accounts),
			getCurrentOrNextForFamilyHybrid: () =>
				selectionCount++ < 2 ? accounts[0] : accounts[1],
			getCurrentOrNextForFamily: () =>
				selectionCount++ < 2 ? accounts[0] : accounts[1],
		};
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
		extractAccountIdMock
			.mockReturnValueOnce("token-primary")
			.mockReturnValueOnce("token-primary")
			.mockReturnValueOnce("token-personal-a")
			.mockReturnValueOnce("token-personal-b");
		extractAccountEmailMock
			.mockReturnValueOnce("alpha@example.com")
			.mockReturnValueOnce("alpha@example.com")
			.mockReturnValueOnce("beta-fresh-a@example.com")
			.mockReturnValueOnce("beta-fresh-b@example.com");
		vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
			(_init, accountId, accessToken) =>
				new Headers({
					"x-test-account-id": String(accountId),
					"x-test-access-token": String(accessToken),
				}),
		);
		const blockedKeys: Array<[string, string | undefined]> = [];
		const clearedKeys: Array<[string, string | undefined]> = [];
		vi.spyOn(entitlementModule.EntitlementCache.prototype, "isBlocked").mockImplementation(
			(accountKey, modelKey) => {
				blockedKeys.push([accountKey, modelKey]);
				return { blocked: false, waitMs: 0 };
			},
		);
		vi.spyOn(entitlementModule.EntitlementCache.prototype, "clear").mockImplementation(
			(accountKey, modelKey) => {
				clearedKeys.push([accountKey, modelKey]);
			},
		);

		let releasePrimaryFailures: (() => void) | undefined;
		const primaryBarrier = new Promise<void>((resolve) => {
			releasePrimaryFailures = resolve;
		});
		let primaryAttempts = 0;
		const fallbackResponses: Array<{ accountId: string | null; accessToken: string | null }> =
			[];
		globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
			const headers = new Headers(init?.headers);
			const accountId = headers.get("x-test-account-id");
			const accessToken = headers.get("x-test-access-token");
			if (accountId === "token-primary") {
				primaryAttempts += 1;
				if (primaryAttempts === 2) {
					releasePrimaryFailures?.();
				}
				await primaryBarrier;
				throw new Error("Network timeout");
			}

			fallbackResponses.push({ accountId, accessToken });
			return new Response(JSON.stringify({ accountId, accessToken }), { status: 200 });
		});

		const { sdk } = await setupPlugin();
		const [firstResponse, secondResponse] = await Promise.all([
			sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			}),
			sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			}),
		]);

		expect(firstResponse.status).toBe(200);
		expect(secondResponse.status).toBe(200);
		const routedFetchCalls = vi
			.mocked(globalThis.fetch)
			.mock.calls.map(([, init]) => {
				const headers = new Headers(init?.headers);
				return headers.get("x-test-account-id");
			})
			.filter((accountId): accountId is string => accountId !== null);
		expect(primaryAttempts).toBeGreaterThanOrEqual(2);
		expect(
			routedFetchCalls.filter((accountId) => accountId === "workspace-fallback"),
		).toHaveLength(2);
		expect(fallbackResponses).toEqual([
			{ accountId: "workspace-fallback", accessToken: "access-beta" },
			{ accountId: "workspace-fallback", accessToken: "access-beta" },
		]);
		expect(blockedKeys).toEqual(
			expect.arrayContaining([
				["account:workspace-fallback::email:beta-fresh-a@example.com", "gpt-5.1"],
				["account:workspace-fallback::email:beta-fresh-b@example.com", "gpt-5.1"],
			]),
		);
		expect(clearedKeys).toEqual(
			expect.arrayContaining([
				["account:workspace-fallback::email:beta-fresh-a@example.com", "gpt-5.1"],
				["account:workspace-fallback::email:beta-fresh-b@example.com", "gpt-5.1"],
			]),
		);
		const fallbackAfterRequests = manager.getAccountsSnapshot()[1];
		expect(fallbackAfterRequests?.accountId).toBe("workspace-fallback");
		expect(fallbackAfterRequests?.accountIdSource).toBe("org");
		expect(syncCodexCliSelectionMock).toHaveBeenCalledWith(1);
	});

	it("handles network errors and rotates to next account", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(await response.text()).toContain("server errors or auth issues");
		expect(syncCodexCliSelectionMock).not.toHaveBeenCalled();
	});

	it("does not penalize account health when fetch is aborted by user", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const { CapabilityPolicyStore } = await import("../lib/capability-policy.js");
		const recordFailureSpy = vi.spyOn(AccountManager.prototype, "recordFailure");
		const markCooldownSpy = vi.spyOn(AccountManager.prototype, "markAccountCoolingDown");
		const refundSpy = vi.spyOn(AccountManager.prototype, "refundToken");
		const capabilityFailureSpy = vi.spyOn(CapabilityPolicyStore.prototype, "recordFailure");
		const abortError = Object.assign(new Error("aborted by user"), { name: "AbortError" });
		globalThis.fetch = vi.fn().mockRejectedValue(abortError);

		const { sdk } = await setupPlugin();
		const controller = new AbortController();
		controller.abort(abortError);
		await expect(
			sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ message: "aborted by user" });
		expect(recordFailureSpy).not.toHaveBeenCalled();
		expect(markCooldownSpy).not.toHaveBeenCalled();
		expect(refundSpy).toHaveBeenCalled();
		expect(capabilityFailureSpy).not.toHaveBeenCalled();
	});

		it("skips fetch when local token bucket is depleted", async () => {
			const { AccountManager } = await import("../lib/accounts.js");
			const consumeSpy = vi.spyOn(AccountManager.prototype, "consumeToken").mockReturnValue(false);
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "should-not-be-returned" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(response.status).toBe(503);
			expect(await response.text()).toContain("server errors or auth issues");
			consumeSpy.mockRestore();
		});

		it("continues to next account when local token bucket is depleted", async () => {
			const { AccountManager } = await import("../lib/accounts.js");
			const accountOne = {
				index: 0,
				accountId: "acc-1",
				email: "user1@example.com",
				refreshToken: "refresh-1",
			};
			const accountTwo = {
				index: 1,
				accountId: "acc-2",
				email: "user2@example.com",
				refreshToken: "refresh-2",
			};
			const countSpy = vi
				.spyOn(AccountManager.prototype, "getAccountCount")
				.mockReturnValue(2);
			const selectionSpy = vi
				.spyOn(AccountManager.prototype, "getCurrentOrNextForFamilyHybrid")
				.mockImplementationOnce(() => accountOne)
				.mockImplementationOnce(() => accountTwo)
				.mockImplementation(() => null);
			const consumeSpy = vi
				.spyOn(AccountManager.prototype, "consumeToken")
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "from-second-account" }), { status: 200 }),
			);

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});

			expect(response.status).toBe(200);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(consumeSpy).toHaveBeenCalledTimes(2);
			countSpy.mockRestore();
			selectionSpy.mockRestore();
			consumeSpy.mockRestore();
		});

	it("treats timeout-triggered abort as network failure", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const configModule = await import("../lib/config.js");
		const recordFailureSpy = vi.spyOn(AccountManager.prototype, "recordFailure");
		const timeoutSpy = vi.spyOn(configModule, "getFetchTimeoutMs").mockReturnValueOnce(5);
			globalThis.fetch = vi.fn((_: unknown, init?: { signal?: AbortSignal }) => {
				return new Promise((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new Error("missing signal"));
						return;
					}
					if (signal.aborted) {
						reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
						return;
					}
					signal.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("timeout"), { name: "AbortError" })),
						{ once: true },
					);
				});
			});

			const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(recordFailureSpy).toHaveBeenCalled();
		recordFailureSpy.mockRestore();
		timeoutSpy.mockRestore();
	});

	it("uses numeric retry-after hints for server cooldown decisions", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const cooldownSpy = vi.spyOn(AccountManager.prototype, "markAccountCoolingDown");
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("server error", {
				status: 500,
				headers: new Headers({ "retry-after": "5" }),
			}),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(cooldownSpy).toHaveBeenCalled();
		expect(cooldownSpy.mock.calls[0]?.[1]).toBe(5000);
		cooldownSpy.mockRestore();
	});

	it("uses retry-after-ms hints for server cooldown decisions", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const cooldownSpy = vi.spyOn(AccountManager.prototype, "markAccountCoolingDown");
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("server error", {
				status: 500,
				headers: new Headers({ "retry-after-ms": "4500" }),
			}),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(cooldownSpy).toHaveBeenCalled();
		expect(cooldownSpy.mock.calls[0]?.[1]).toBe(4500);
		cooldownSpy.mockRestore();
	});

	it("parses x-ratelimit-reset seconds hints for server cooldown decisions", async () => {
		const baseNow = 1_700_000_000_000;
		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);
		const resetAtSeconds = Math.floor((baseNow + 7_000) / 1000);
		const { AccountManager } = await import("../lib/accounts.js");
		const cooldownSpy = vi.spyOn(AccountManager.prototype, "markAccountCoolingDown");
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("server error", {
				status: 500,
				headers: new Headers({ "x-ratelimit-reset": String(resetAtSeconds) }),
			}),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(cooldownSpy).toHaveBeenCalled();
		expect(cooldownSpy.mock.calls[0]?.[1]).toBe(7000);
		cooldownSpy.mockRestore();
		dateNowSpy.mockRestore();
	});

	it("parses x-ratelimit-reset millisecond hints for server cooldown decisions", async () => {
		const baseNow = 1_700_000_000_000;
		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);
		const resetAtMs = baseNow + 12_000;
		const { AccountManager } = await import("../lib/accounts.js");
		const cooldownSpy = vi.spyOn(AccountManager.prototype, "markAccountCoolingDown");
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("server error", {
				status: 500,
				headers: new Headers({ "x-ratelimit-reset": String(resetAtMs) }),
			}),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(cooldownSpy).toHaveBeenCalled();
		expect(cooldownSpy.mock.calls[0]?.[1]).toBe(12000);
		cooldownSpy.mockRestore();
		dateNowSpy.mockRestore();
	});

	it("parses HTTP-date retry-after hints for server cooldown decisions", async () => {
		const baseNow = 1_700_000_000_000;
		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);
		const retryAt = new Date(baseNow + 9_000).toUTCString();
		const { AccountManager } = await import("../lib/accounts.js");
		const cooldownSpy = vi.spyOn(AccountManager.prototype, "markAccountCoolingDown");
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response("server error", {
				status: 500,
				headers: new Headers({ "retry-after": retryAt }),
			}),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(cooldownSpy).toHaveBeenCalled();
		expect(cooldownSpy.mock.calls[0]?.[1]).toBe(9000);
		cooldownSpy.mockRestore();
		dateNowSpy.mockRestore();
	});

	it("falls back from gpt-5.3-codex to gpt-5.2-codex when unsupported fallback is enabled", async () => {
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
		vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(true);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.3-codex" }),
			},
			body: { model: "gpt-5.3-codex" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValueOnce({
			response: new Response(
				JSON.stringify({
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				}),
				{ status: 400 },
			),
			rateLimit: undefined,
			errorBody: {
				error: {
					code: "model_not_supported_with_chatgpt_account",
					message:
						"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
				},
			},
		});
		vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mockReturnValueOnce("gpt-5.2-codex");

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.3-codex" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		const firstInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
		const secondInit = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
		expect(JSON.parse(firstInit.body as string).model).toBe("gpt-5.3-codex");
		expect(JSON.parse(secondInit.body as string).model).toBe("gpt-5.2-codex");
	});

		it("cascades Spark fallback from gpt-5.3-codex-spark -> gpt-5.3-codex -> gpt-5.2-codex", async () => {
			const configModule = await import("../lib/config.js");
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
		vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(true);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.3-codex-spark" }),
			},
			body: { model: "gpt-5.3-codex-spark" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse)
			.mockResolvedValueOnce({
				response: new Response(JSON.stringify({ error: { code: "model_not_supported_with_chatgpt_account" } }), { status: 400 }),
				rateLimit: undefined,
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
					},
				},
			})
			.mockResolvedValueOnce({
				response: new Response(JSON.stringify({ error: { code: "model_not_supported_with_chatgpt_account" } }), { status: 400 }),
				rateLimit: undefined,
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
			});
		vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel)
			.mockReturnValueOnce("gpt-5.3-codex")
			.mockReturnValueOnce("gpt-5.2-codex");

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockResolvedValueOnce(new Response("still bad", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.3-codex-spark" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
		const firstInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
		const secondInit = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
		const thirdInit = vi.mocked(globalThis.fetch).mock.calls[2]?.[1] as RequestInit;
		expect(JSON.parse(firstInit.body as string).model).toBe("gpt-5.3-codex-spark");
			expect(JSON.parse(secondInit.body as string).model).toBe("gpt-5.3-codex");
			expect(JSON.parse(thirdInit.body as string).model).toBe("gpt-5.2-codex");
		});

	it("forces Spark fallback even when strict policy disables generic unsupported fallback", async () => {
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		vi.mocked(configModule.getUnsupportedCodexPolicy).mockReturnValueOnce("strict");
		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(false);
		vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(true);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.3-codex-spark" }),
			},
			body: { model: "gpt-5.3-codex-spark" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValueOnce({
			response: new Response(JSON.stringify({ error: { code: "model_not_supported_with_chatgpt_account" } }), {
				status: 400,
			}),
			rateLimit: undefined,
			errorBody: {
				error: {
					code: "model_not_supported_with_chatgpt_account",
					message:
						"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
				},
			},
		});
		vi.mocked(fetchHelpers.getUnsupportedCodexModelInfo).mockReturnValueOnce({
			isUnsupported: true,
			code: "model_not_supported_with_chatgpt_account",
			unsupportedModel: "gpt-5.3-codex-spark",
		});
		vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mockImplementationOnce((options) =>
			options.fallbackOnUnsupportedCodexModel ? "gpt-5-codex" : undefined,
		);

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.3-codex-spark" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		const resolveOptions = vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mock
			.calls[0]?.[0];
		expect(resolveOptions?.fallbackOnUnsupportedCodexModel).toBe(true);
		const firstInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
		const secondInit = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
		expect(JSON.parse(firstInit.body as string).model).toBe("gpt-5.3-codex-spark");
		expect(JSON.parse(secondInit.body as string).model).toBe("gpt-5-codex");
	});

		it("restarts account traversal after fallback model switch", async () => {
			const configModule = await import("../lib/config.js");
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			const { AccountManager } = await import("../lib/accounts.js");

			const accountOne = {
				index: 0,
				accountId: "acc-1",
				email: "user1@example.com",
				refreshToken: "refresh-1",
			};
			const accountTwo = {
				index: 1,
				accountId: "acc-2",
				email: "user2@example.com",
				refreshToken: "refresh-2",
			};

			let legacySelection = 0;
			let fallbackSelection = 0;
			const customManager = {
				getAccountCount: () => 2,
				getCurrentOrNextForFamilyHybrid: (_family: string, currentModel?: string) => {
					if (currentModel === "gpt-5-codex") {
						if (fallbackSelection === 0) {
							fallbackSelection++;
							return accountOne;
						}
						if (fallbackSelection === 1) {
							fallbackSelection++;
							return accountTwo;
						}
						return null;
					}
					if (legacySelection === 0) {
						legacySelection++;
						return accountOne;
					}
					if (legacySelection === 1) {
						legacySelection++;
						return accountTwo;
					}
					return null;
				},
				toAuthDetails: (account: { accountId?: string }) => ({
					type: "oauth" as const,
					access: `access-${account.accountId ?? "unknown"}`,
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
				}),
				hasRefreshToken: () => true,
				saveToDiskDebounced: () => {},
				updateFromAuth: () => {},
				clearAuthFailures: () => {},
				incrementAuthFailures: () => 1,
				markAccountCoolingDown: () => {},
				markRateLimitedWithReason: () => {},
				recordRateLimit: () => {},
				consumeToken: () => true,
				refundToken: () => {},
				getCurrentWorkspace: () => null,
				syncCodexCliActiveSelectionForIndex: async () => {},
				markSwitched: () => {},
				removeAccount: () => {},
				recordFailure: () => {},
				recordSuccess: () => {},
				getMinWaitTimeForFamily: () => 0,
				shouldShowAccountToast: () => false,
				markToastShown: () => {},
				getCurrentWorkspace: () => null,
				disableCurrentWorkspace: () => false,
				rotateToNextWorkspace: () => null,
				hasEnabledWorkspaces: () => true,
				setActiveIndex: () => accountOne,
				getAccountsSnapshot: () => [accountOne, accountTwo],
			};
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(customManager as never);

			vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
			vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(true);
			vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
				updatedInit: {
					method: "POST",
					body: JSON.stringify({ model: "gpt-5.3-codex" }),
				},
				body: { model: "gpt-5.3-codex" },
			});
			vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
				(_init, _accountId, accessToken) =>
					new Headers({ "x-test-access-token": String(accessToken) }),
			);
			vi.mocked(fetchHelpers.handleErrorResponse).mockImplementation(async (response) => {
				const errorBody = await response.clone().json().catch(() => ({}));
				return { response, rateLimit: undefined, errorBody };
			});
			vi.mocked(fetchHelpers.getUnsupportedCodexModelInfo).mockImplementation((errorBody: unknown) => {
				const message = (errorBody as { error?: { message?: string } })?.error?.message ?? "";
				if (!/not supported when using codex with a chatgpt account/i.test(message)) {
					return { isUnsupported: false };
				}
				const match = message.match(/'([^']+)'/);
				return {
					isUnsupported: true,
					unsupportedModel: match?.[1],
					message,
					code: "model_not_supported_with_chatgpt_account",
				};
			});
			vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mockImplementation(({ requestedModel }) => {
				return requestedModel === "gpt-5.3-codex" ? "gpt-5-codex" : undefined;
			});

			globalThis.fetch = vi.fn(async (_url, init) => {
				const body =
					init && typeof init.body === "string"
						? (JSON.parse(init.body) as { model?: string })
						: {};
				const headers = new Headers(init?.headers);
				const accessToken = headers.get("x-test-access-token");

				if (body.model === "gpt-5.3-codex") {
					return new Response(
						JSON.stringify({
							error: {
								code: "model_not_supported_with_chatgpt_account",
								message:
									"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
							},
						}),
						{ status: 400 },
					);
				}

				if (body.model === "gpt-5-codex" && accessToken === "access-account-1") {
					return new Response(JSON.stringify({ content: "ok" }), { status: 200 });
				}

				return new Response(
					JSON.stringify({
						error: {
							code: "model_not_supported_with_chatgpt_account",
							message:
								"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
						},
					}),
					{ status: 400 },
				);
			});

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.3-codex" }),
			});

			const fetchCalls = vi.mocked(globalThis.fetch).mock.calls.map((call) => {
				const init = call[1] as RequestInit;
				const body =
					typeof init.body === "string"
						? (JSON.parse(init.body) as { model?: string })
						: {};
				const headers = new Headers(init.headers);
				return {
					model: body.model,
					accessToken: headers.get("x-test-access-token"),
				};
			});
			expect(fetchCalls).toEqual([
				{ model: "gpt-5.3-codex", accessToken: "access-acc-1" },
				{ model: "gpt-5.3-codex", accessToken: "access-acc-2" },
				{ model: "gpt-5-codex", accessToken: "access-account-1" },
			]);
			expect(response.status).toBe(200);
		});

		it("handles empty body in request", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {});

		expect(response.status).toBe(200);
	});

	it("handles malformed JSON body gracefully", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: "not-valid-json{",
		});

		expect(response.status).toBe(200);
	});

	it("handles abort signal during fetch", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const controller = new AbortController();

		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
			signal: controller.signal,
		});

		expect(response.status).toBe(200);
	});

	it("handles streaming request (stream=true in body)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1", stream: true }),
		});

		expect(response.status).toBe(200);
	});
});

describe("OpenAIOAuthPlugin resolveAccountSelection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	it("uses CODEX_AUTH_ACCOUNT_ID environment override", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "override-account-12345";

		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user@example.com", refreshToken: "refresh-1" },
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = await plugin.auth.loader(getAuth, { options: {}, models: {} });
		expect(sdk.fetch).toBeDefined();
	});

	it("uses short CODEX_AUTH_ACCOUNT_ID override", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "short";

		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user@example.com", refreshToken: "refresh-1" },
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = await plugin.auth.loader(getAuth, { options: {}, models: {} });
		expect(sdk.fetch).toBeDefined();
	});
});

describe("OpenAIOAuthPlugin persistAccountPool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getAccountIdCandidatesMock.mockReset();
		getAccountIdCandidatesMock.mockImplementation(() => [
			{ accountId: "acc-1", source: "token", label: "Test" },
		]);
		selectBestAccountCandidateMock.mockReset();
		selectBestAccountCandidateMock.mockImplementation(
			(candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
		);
		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	it("handles existing account update by refreshToken", async () => {
		mockStorage.accounts = [
			{
				accountId: "acc-1",
				email: "old@example.com",
				refreshToken: "refresh-1",
				addedAt: Date.now() - 100000,
			},
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		await OpenAIOAuthPlugin({ client: mockClient } as never);

		expect(mockStorage.accounts).toHaveLength(1);
	});

	it("handles existing account update by accountId", async () => {
		mockStorage.accounts = [
			{
				accountId: "acc-existing",
				email: "old@example.com",
				refreshToken: "old-refresh",
				addedAt: Date.now() - 100000,
			},
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		await OpenAIOAuthPlugin({ client: mockClient } as never);

		expect(mockStorage.accounts).toHaveLength(1);
	});

	it("initializes currentWorkspaceIndex for a newly persisted selected workspace", async () => {
		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { verifier: "persist-new-workspace-index", challenge: "persist-new-workspace-index" },
			state: "persist-new-workspace-index",
			url: "https://auth.openai.com/test?state=persist-new-workspace-index",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600_000,
			idToken: "id-token",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([
			{ accountId: "workspace-a", source: "org", label: "Workspace A" },
			{ accountId: "workspace-b", source: "org", label: "Workspace B", isDefault: true },
			{ accountId: "workspace-c", source: "org", label: "Workspace C" },
		]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementationOnce(
			(candidates) => candidates[1] ?? null,
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-new-workspace-index",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "workspace-b",
				currentWorkspaceIndex: 1,
				workspaces: [
					{ id: "workspace-a", name: "Workspace A", enabled: true, isDefault: undefined },
					{ id: "workspace-b", name: "Workspace B", enabled: true, isDefault: true },
					{ id: "workspace-c", name: "Workspace C", enabled: true, isDefault: undefined },
				],
			}),
		);
	});

	it("preserves distinct accountId plus email pairs during manual login", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "shared-workspace";
		mockStorage.accounts = [
			{
				accountId: "shared-workspace",
				email: "alpha@example.com",
				refreshToken: "refresh-a",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: {
				verifier: "persist-verifier-email",
				challenge: "persist-challenge-email",
			},
			state: "persist-state-email",
			url: "https://auth.openai.com/test?state=persist-state-email",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-b",
			expires: Date.now() + 3600_000,
			idToken: "id-token",
		});

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-state-email",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(2);
		expect(mockStorage.accounts.map((account) => account.accountId)).toEqual([
			"shared-workspace",
			"shared-workspace",
		]);
		expect(
			mockStorage.accounts.map((account) => ({
				email: account.email,
				refreshToken: account.refreshToken,
			})),
		).toEqual([
			{
				email: "alpha@example.com",
				refreshToken: "refresh-a",
			},
			{
				email: "user@example.com",
				refreshToken: "refresh-b",
			},
		]);
	});

	it("preserves same-email workspaces when manual login reuses a refresh token", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "workspace-beta";
		mockStorage.accounts = [
			{
				accountId: "workspace-alpha",
				accountIdSource: "org",
				accountLabel: "Workspace Alpha [id:alpha]",
				email: "user@example.com",
				refreshToken: "shared-refresh",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { verifier: "persist-verifier-same-refresh", challenge: "persist-challenge-same-refresh" },
			state: "persist-state-same-refresh",
			url: "https://auth.openai.com/test?state=persist-state-same-refresh",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-same-refresh",
			refresh: "shared-refresh",
			expires: Date.now() + 3600_000,
			idToken: "id-token-same-refresh",
		});

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-state-same-refresh",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(2);
		expect(
			mockStorage.accounts.map((account) => ({
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
				accountIdSource: "manual",
				accountLabel: expect.stringContaining("Override [id:"),
				email: "user@example.com",
				refreshToken: "shared-refresh",
			},
		]);
	});

	it("preserves tracked workspaces when manual login updates an account without workspace metadata", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "shared-workspace";
		mockStorage.accounts = [
			{
				accountId: "shared-workspace",
				accountIdSource: "manual",
				accountLabel: "Override [id:space]",
				email: "user@example.com",
				refreshToken: "refresh-a",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
				workspaces: [
					{ id: "workspace-a", name: "Workspace A", enabled: false, disabledAt: 111 },
					{ id: "workspace-b", name: "Workspace B", enabled: true, isDefault: true },
				],
				currentWorkspaceIndex: 1,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { verifier: "persist-preserve-workspaces", challenge: "persist-preserve-workspaces" },
			state: "persist-preserve-workspaces",
			url: "https://auth.openai.com/test?state=persist-preserve-workspaces",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-updated",
			expires: Date.now() + 3600_000,
			idToken: undefined,
		});
		vi.mocked(accountsModule.extractAccountEmail).mockReturnValueOnce("user@example.com");
		vi.mocked(accountsModule.extractAccountId).mockReturnValueOnce("shared-workspace");

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-preserve-workspaces",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "shared-workspace",
				refreshToken: "refresh-updated",
				currentWorkspaceIndex: 1,
				workspaces: [
					{ id: "workspace-a", name: "Workspace A", enabled: false, disabledAt: 111 },
					{ id: "workspace-b", name: "Workspace B", enabled: true, isDefault: true },
				],
			}),
		);
	});

	it("preserves disabledAt when refreshed workspace metadata is merged into an existing account", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "shared-workspace";
		mockStorage.accounts = [
			{
				accountId: "shared-workspace",
				accountIdSource: "manual",
				accountLabel: "Override [id:space]",
				email: "user@example.com",
				refreshToken: "refresh-a",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
				workspaces: [
					{ id: "workspace-a", name: "Workspace A", enabled: false, disabledAt: 222, isDefault: true },
				],
				currentWorkspaceIndex: 0,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { verifier: "persist-merge-workspaces", challenge: "persist-merge-workspaces" },
			state: "persist-merge-workspaces",
			url: "https://auth.openai.com/test?state=persist-merge-workspaces",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-updated",
			expires: Date.now() + 3600_000,
			idToken: undefined,
			workspaces: [
				{ id: "workspace-a", name: "Workspace A Renamed", enabled: true, isDefault: true },
			],
		});
		vi.mocked(accountsModule.extractAccountEmail).mockReturnValueOnce("user@example.com");
		vi.mocked(accountsModule.extractAccountId).mockReturnValueOnce("shared-workspace");

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-merge-workspaces",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.workspaces).toEqual([
			{
				id: "workspace-a",
				name: "Workspace A Renamed",
				enabled: false,
				disabledAt: 222,
				isDefault: true,
			},
		]);
	});

	it("clamps currentWorkspaceIndex when refreshed workspace metadata removes the active workspace", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "shared-workspace";
		mockStorage.accounts = [
			{
				accountId: "shared-workspace",
				accountIdSource: "manual",
				accountLabel: "Override [id:space]",
				email: "user@example.com",
				refreshToken: "refresh-a",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
				workspaces: [
					{ id: "workspace-a", name: "Workspace A", enabled: true, isDefault: true },
					{ id: "workspace-b", name: "Workspace B", enabled: true },
				],
				currentWorkspaceIndex: 1,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { verifier: "persist-clamp-workspace-index", challenge: "persist-clamp-workspace-index" },
			state: "persist-clamp-workspace-index",
			url: "https://auth.openai.com/test?state=persist-clamp-workspace-index",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-updated",
			expires: Date.now() + 3600_000,
			idToken: undefined,
			workspaces: [
				{ id: "workspace-a", name: "Workspace A", enabled: true, isDefault: true },
			],
		});
		vi.mocked(accountsModule.extractAccountEmail).mockReturnValueOnce("user@example.com");
		vi.mocked(accountsModule.extractAccountId).mockReturnValueOnce("shared-workspace");

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-clamp-workspace-index",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.currentWorkspaceIndex).toBe(0);
		expect(mockStorage.accounts[0]?.workspaces).toEqual([
			{ id: "workspace-a", name: "Workspace A", enabled: true, isDefault: true },
		]);
	});

	it("preserves the active workspace by id when refreshed workspace metadata is reordered", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "shared-workspace";
		mockStorage.accounts = [
			{
				accountId: "shared-workspace",
				accountIdSource: "manual",
				accountLabel: "Override [id:space]",
				email: "user@example.com",
				refreshToken: "refresh-a",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
				workspaces: [
					{ id: "workspace-a", name: "Workspace A", enabled: true },
					{ id: "workspace-b", name: "Workspace B", enabled: false, disabledAt: 222, isDefault: true },
					{ id: "workspace-c", name: "Workspace C", enabled: true },
				],
				currentWorkspaceIndex: 1,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { verifier: "persist-reorder-workspaces", challenge: "persist-reorder-workspaces" },
			state: "persist-reorder-workspaces",
			url: "https://auth.openai.com/test?state=persist-reorder-workspaces",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-updated",
			expires: Date.now() + 3600_000,
			idToken: undefined,
			workspaces: [
				{ id: "workspace-b", name: "Workspace B Renamed", enabled: true, isDefault: true },
				{ id: "workspace-a", name: "Workspace A", enabled: true },
				{ id: "workspace-c", name: "Workspace C", enabled: true },
			],
		});
		vi.mocked(accountsModule.extractAccountEmail).mockReturnValueOnce("user@example.com");
		vi.mocked(accountsModule.extractAccountId).mockReturnValueOnce("shared-workspace");

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-reorder-workspaces",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.currentWorkspaceIndex).toBe(0);
		expect(mockStorage.accounts[0]?.workspaces).toEqual([
			{ id: "workspace-b", name: "Workspace B Renamed", enabled: false, disabledAt: 222, isDefault: true },
			{ id: "workspace-a", name: "Workspace A", enabled: true },
			{ id: "workspace-c", name: "Workspace C", enabled: true },
		]);
	});

	it("preserves duplicate shared accountId entries when a login has no email claim", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "shared-workspace";
		mockStorage.accounts = [
			{
				accountId: "shared-workspace",
				refreshToken: "refresh-a",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
			},
			{
				accountId: "shared-workspace",
				refreshToken: "refresh-b",
				addedAt: Date.now() - 100000,
				lastUsed: Date.now() - 100000,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: { verifier: "persist-verifier", challenge: "persist-challenge" },
			state: "persist-state",
			url: "https://auth.openai.com/test?state=persist-state",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-c",
			expires: Date.now() + 3600_000,
			idToken: undefined,
		});
		vi.mocked(accountsModule.extractAccountEmail).mockReturnValueOnce(undefined);
		vi.mocked(accountsModule.extractAccountId).mockReturnValueOnce(
			"shared-workspace",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-state",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(3);
		expect(
			mockStorage.accounts.map((account) => account.refreshToken),
		).toEqual(["refresh-a", "refresh-b", "refresh-c"]);
		expect(mockStorage.accounts.map((account) => account.accountId)).toEqual([
			"shared-workspace",
			"shared-workspace",
			"shared-workspace",
		]);
	});

	it("serializes concurrent manual logins through the storage transaction queue", async () => {
		const createDeferred = () => {
			let resolve!: () => void;
			const promise = new Promise<void>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		};

		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};

		const firstPersist = createDeferred();
		saveAccountsMock
			.mockImplementationOnce(async (storage) => {
				await firstPersist.promise;
				mockStorage.version = storage.version;
				mockStorage.accounts = storage.accounts.map((account) => cloneMockAccount(account));
				mockStorage.activeIndex = storage.activeIndex;
				mockStorage.activeIndexByFamily = {
					...(storage.activeIndexByFamily ?? {}),
				};
			})
			.mockImplementation(async (storage) => {
				mockStorage.version = storage.version;
				mockStorage.accounts = storage.accounts.map((account) => cloneMockAccount(account));
				mockStorage.activeIndex = storage.activeIndex;
				mockStorage.activeIndexByFamily = {
					...(storage.activeIndexByFamily ?? {}),
				};
			});

		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow)
			.mockResolvedValueOnce({
				pkce: { verifier: "persist-concurrent-verifier-1", challenge: "persist-concurrent-challenge-1" },
				state: "persist-concurrent-state-1",
				url: "https://auth.openai.com/test?state=persist-concurrent-state-1",
			})
			.mockResolvedValueOnce({
				pkce: { verifier: "persist-concurrent-verifier-2", challenge: "persist-concurrent-challenge-2" },
				state: "persist-concurrent-state-2",
				url: "https://auth.openai.com/test?state=persist-concurrent-state-2",
			});
		vi.mocked(authModule.exchangeAuthorizationCode)
			.mockResolvedValueOnce({
				type: "success",
				access: "access-token-1",
				refresh: "refresh-1",
				expires: Date.now() + 3600_000,
				idToken: undefined,
			})
			.mockResolvedValueOnce({
				type: "success",
				access: "access-token-2",
				refresh: "refresh-2",
				expires: Date.now() + 3600_000,
				idToken: undefined,
			});
		vi.mocked(accountsModule.extractAccountEmail)
			.mockReturnValueOnce("alpha@example.com")
			.mockReturnValueOnce("beta@example.com");
		vi.mocked(accountsModule.extractAccountId)
			.mockReturnValueOnce("workspace-alpha")
			.mockReturnValueOnce("workspace-beta");

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flowOne = await manualMethod.authorize();
		const flowTwo = await manualMethod.authorize();
		const firstCallback = flowOne.callback(
			"http://127.0.0.1:1455/auth/callback?code=alpha&state=persist-concurrent-state-1",
		);
		await new Promise((resolve) => setImmediate(resolve));
		const secondCallback = flowTwo.callback(
			"http://127.0.0.1:1455/auth/callback?code=beta&state=persist-concurrent-state-2",
		);
		await new Promise((resolve) => setImmediate(resolve));

		expect(saveAccountsMock).toHaveBeenCalledTimes(1);

		firstPersist.resolve();

		const [firstResult, secondResult] = await Promise.all([
			firstCallback,
			secondCallback,
		]);

		expect(firstResult.type).toBe("success");
		expect(secondResult.type).toBe("success");
		expect(saveAccountsMock).toHaveBeenCalledTimes(2);
		expect(mockStorage.accounts).toHaveLength(2);
		expect(
			mockStorage.accounts.map((account) => ({
				email: account.email,
				refreshToken: account.refreshToken,
			})),
		).toEqual([
			{ email: "alpha@example.com", refreshToken: "refresh-1" },
			{ email: "beta@example.com", refreshToken: "refresh-2" },
		]);
	});

	it("updates a unique shared accountId entry when a login has no email claim", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "shared-workspace";
		mockStorage.accounts = [
			{
				accountId: "shared-workspace",
				refreshToken: "refresh-a",
				addedAt: Date.now() - 200000,
				lastUsed: Date.now() - 200000,
			},
		];

		const authModule = await import("../lib/auth/auth.js");
		const accountsModule = await import("../lib/accounts.js");
		vi.mocked(authModule.createAuthorizationFlow).mockResolvedValueOnce({
			pkce: {
				verifier: "persist-unique-verifier",
				challenge: "persist-unique-challenge",
			},
			state: "persist-unique-state",
			url: "https://auth.openai.com/test?state=persist-unique-state",
		});
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-token",
			refresh: "refresh-updated",
			expires: Date.now() + 3600_000,
			idToken: undefined,
		});
		vi.mocked(accountsModule.extractAccountEmail).mockReturnValueOnce(undefined);
		vi.mocked(accountsModule.extractAccountId).mockReturnValueOnce(
			"shared-workspace",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin =
			(await OpenAIOAuthPlugin({
				client: mockClient,
			} as never)) as unknown as PluginType;
		const manualMethod = plugin.auth.methods[1] as unknown as {
			authorize: () => Promise<{
				callback: (input: string) => Promise<{ type: string }>;
			}>;
		};

		const flow = await manualMethod.authorize();
		const result = await flow.callback(
			"http://127.0.0.1:1455/auth/callback?code=abc123&state=persist-unique-state",
		);

		expect(result.type).toBe("success");
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]).toEqual(
			expect.objectContaining({
				accountId: "shared-workspace",
				refreshToken: "refresh-updated",
			}),
		);
	});
});

describe("OpenAIOAuthPlugin showToast error handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user@example.com", refreshToken: "refresh-1" },
		];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles TUI unavailable gracefully", async () => {
		const mockClient = {
			tui: {
				showToast: vi.fn().mockRejectedValue(new Error("TUI unavailable")),
			},
			auth: { set: vi.fn() },
			session: { prompt: vi.fn() },
		};

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-switch"].execute({ index: 1 });
		expect(result).toContain("Switched to account");
	});
});

describe("OpenAIOAuthPlugin event handler edge cases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user1@example.com", refreshToken: "refresh-1" },
			{ accountId: "acc-2", email: "user2@example.com", refreshToken: "refresh-2" },
		];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles account.select with accountIndex property", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		await plugin.auth.loader(getAuth, { options: {}, models: {} });

		await plugin.event({
			event: { type: "account.select", properties: { accountIndex: 1 } },
		});
	});

	it("reloads account manager from disk when handling account.select", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const { AccountManager } = await import("../lib/accounts.js");
		const loadFromDiskSpy = vi.spyOn(AccountManager, "loadFromDisk");

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		await plugin.auth.loader(getAuth, { options: {}, models: {} });
		loadFromDiskSpy.mockClear();

		await plugin.event({
			event: { type: "account.select", properties: { index: 1 } },
		});

		expect(loadFromDiskSpy).toHaveBeenCalledTimes(1);
	});

	it("handles openai.account.select with openai provider", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		await plugin.auth.loader(getAuth, { options: {}, models: {} });

		await plugin.event({
			event: {
				type: "openai.account.select",
				properties: { provider: "openai", index: 0 },
			},
		});
	});

	it("ignores account.select when cachedAccountManager is null", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.event({
			event: { type: "account.select", properties: { index: 0 } },
		});
	});

	it("handles non-numeric index gracefully", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.event({
			event: { type: "account.select", properties: { index: "invalid" } },
		});
	});
});


