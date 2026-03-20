import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = "1";

const accountManagerState = vi.hoisted(() => ({
	accounts: [] as Array<Record<string, unknown>>,
	accountSelections: [] as Array<Record<string, unknown> | null>,
	saveToDiskDebouncedCalls: 0,
	disableCurrentWorkspaceCalls: 0,
	rotateToNextWorkspaceCalls: 0,
	setAccountEnabledCalls: [] as Array<{ index: number; enabled: boolean }>,
}));

const recoveryState = vi.hoisted(() => ({
	forceRecoverable: false,
	isRecoverableErrorCalls: 0,
}));

function createMockAccount(
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		index: 0,
		accountId: "account-1",
		email: "user@example.com",
		refreshToken: "refresh-token",
		access: "access-token",
		expires: Date.now() + 60_000,
		addedAt: Date.now(),
		lastUsed: Date.now(),
		rateLimitResetTimes: {},
		...overrides,
	};
}

function resetAccountManagerState(): void {
	accountManagerState.accounts = [createMockAccount()];
	accountManagerState.accountSelections = [null, accountManagerState.accounts[0] ?? null];
	accountManagerState.saveToDiskDebouncedCalls = 0;
	accountManagerState.disableCurrentWorkspaceCalls = 0;
	accountManagerState.rotateToNextWorkspaceCalls = 0;
	accountManagerState.setAccountEnabledCalls = [];
}

vi.mock("@codex-ai/plugin/tool", () => {
	const makeSchema = () => ({
		optional: () => makeSchema(),
		describe: () => makeSchema(),
	});

	const tool = (definition: any) => definition;
	(tool as any).schema = {
		number: () => makeSchema(),
		boolean: () => makeSchema(),
		string: () => makeSchema(),
	};

	return { tool };
});

vi.mock("../lib/request/fetch-helpers.js", () => ({
	extractRequestUrl: (input: any) => (typeof input === "string" ? input : String(input)),
	rewriteUrlForCodex: (url: string) => url,
	transformRequestForCodex: async (init: any) => ({ updatedInit: init, body: { model: "gpt-5.1" } }),
	shouldRefreshToken: () => false,
	refreshAndUpdateToken: async (auth: any) => auth,
	createCodexHeaders: (_requestInit: any, accountId?: string) =>
		new Headers(accountId ? { "x-account-id": accountId } : {}),
	handleErrorResponse: async (response: Response) => {
		const rawBody = await response.text();
		let errorBody: unknown;
		try {
			errorBody = rawBody ? JSON.parse(rawBody) : undefined;
		} catch {
			errorBody = undefined;
		}
		return { response, rateLimit: false, errorBody };
	},
	getUnsupportedCodexModelInfo: () => ({
		isUnsupported: false,
		unsupportedModel: undefined,
	}),
	resolveUnsupportedCodexFallbackModel: () => undefined,
	shouldFallbackToGpt52OnUnsupportedGpt53: () => false,
	handleSuccessResponse: async (response: Response) => response,
	isWorkspaceDisabledError: (status: number, code: string, bodyText: string) =>
		status === 403 &&
		(code.toLowerCase().includes("workspace_disabled") ||
			code.toLowerCase().includes("workspace_expired") ||
			bodyText.toLowerCase().includes("workspace disabled") ||
			bodyText.toLowerCase().includes("workspace expired")),
}));

vi.mock("../lib/request/request-transformer.js", () => ({
	applyFastSessionDefaults: <T>(config: T) => config,
}));

vi.mock("../lib/accounts.js", () => {
	class AccountManager {
		static async loadFromDisk() {
			return new AccountManager();
		}

		getAccountCount() {
			return accountManagerState.accounts.length;
		}

		getCurrentOrNextForFamily() {
			if (accountManagerState.accountSelections.length > 0) {
				return accountManagerState.accountSelections.shift() ?? null;
			}
			return accountManagerState.accounts[0] ?? null;
		}

		getCurrentOrNextForFamilyHybrid() {
			return this.getCurrentOrNextForFamily();
		}

		getAccountByIndex(index: number) {
			return (
				accountManagerState.accounts.find(
					(account) => Number(account.index) === index,
				) ?? null
			);
		}

		recordSuccess() {}

		recordRateLimit() {}

		recordFailure() {}

	toAuthDetails() {
		return {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
	}

	hasRefreshToken(_token: string) {
		return true;
	}

		saveToDiskDebounced() {
			accountManagerState.saveToDiskDebouncedCalls += 1;
		}

		updateFromAuth() {}

		async saveToDisk() {}

		markAccountCoolingDown() {}

		markRateLimited() {}

		markRateLimitedWithReason() {}

		consumeToken() { return true; }

		refundToken() {}

		syncCodexCliActiveSelectionForIndex() {
			return Promise.resolve();
		}

		markSwitched() {}

		getMinWaitTimeForFamily() {
			return 1000;
		}

		shouldShowAccountToast() {
			return false;
		}

		markToastShown() {}

		clearAuthFailures() {}

		setAccountEnabled(index: number, enabled: boolean) {
			accountManagerState.setAccountEnabledCalls.push({ index, enabled });
			const account = this.getAccountByIndex(index);
			if (account) {
				account.enabled = enabled;
			}
			return account;
		}

		getCurrentWorkspace(account: Record<string, any>) {
			const workspaces = account.workspaces as Array<Record<string, any>> | undefined;
			if (!workspaces || workspaces.length === 0) {
				return null;
			}
			const currentWorkspaceIndex =
				typeof account.currentWorkspaceIndex === "number"
					? account.currentWorkspaceIndex
					: 0;
			return workspaces[currentWorkspaceIndex] ?? null;
		}

		disableCurrentWorkspace(account: Record<string, any>, expectedWorkspaceId?: string) {
			accountManagerState.disableCurrentWorkspaceCalls += 1;
			const workspace = this.getCurrentWorkspace(account);
			if (!workspace) {
				return false;
			}
			if (expectedWorkspaceId && workspace.id !== expectedWorkspaceId) {
				return false;
			}
			if (workspace.enabled === false) {
				return false;
			}
			workspace.enabled = false;
			workspace.disabledAt = 123;
			return true;
		}

		rotateToNextWorkspace(account: Record<string, any>) {
			accountManagerState.rotateToNextWorkspaceCalls += 1;
			const workspaces = account.workspaces as Array<Record<string, any>> | undefined;
			if (!workspaces || workspaces.length === 0) {
				return null;
			}
			const currentWorkspaceIndex =
				typeof account.currentWorkspaceIndex === "number"
					? account.currentWorkspaceIndex
					: 0;
			for (let offset = 1; offset <= workspaces.length; offset += 1) {
				const nextIndex = (currentWorkspaceIndex + offset) % workspaces.length;
				const workspace = workspaces[nextIndex];
				if (workspace && workspace.enabled !== false) {
					account.currentWorkspaceIndex = nextIndex;
					return workspace;
				}
			}
			return null;
		}

		hasEnabledWorkspaces(account: Record<string, any>) {
			const workspaces = account.workspaces as Array<Record<string, any>> | undefined;
			if (!workspaces || workspaces.length === 0) {
				return true;
			}
			return workspaces.some((workspace) => workspace.enabled !== false);
		}
	}

	return {
		AccountManager,
		extractAccountEmail: () => "user@example.com",
		extractAccountId: () => "account-1",
		selectBestAccountCandidate: (candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
		resolveRequestAccountId: (
			storedId: string | undefined,
			_source: string | undefined,
			tokenId: string | undefined,
		) => storedId ?? tokenId,
		formatAccountLabel: (_account: any, index: number) => `Account ${index + 1}`,
		formatCooldown: (ms: number) => `${ms}ms`,
		formatWaitTime: (ms: number) => `${ms}ms`,
		sanitizeEmail: (email: string) => email,
		parseRateLimitReason: () => "unknown",
		lookupCodexCliTokensByEmail: vi.fn(async () => null),
		isCodexCliSyncEnabled: () => true,
	};
});

vi.mock("../lib/storage.js", () => ({
	getStoragePath: () => "",
	loadAccounts: async () => null,
	saveAccounts: async () => {},
	setStoragePath: () => {},
	setStorageBackupEnabled: () => {},
	exportAccounts: async () => {},
	importAccounts: async () => ({ imported: 0, total: 0 }),
}));

vi.mock("../lib/recovery.js", () => ({
	createSessionRecoveryHook: () => null,
	isRecoverableError: () => {
		recoveryState.isRecoverableErrorCalls += 1;
		return recoveryState.forceRecoverable;
	},
	detectErrorType: () => "tool_use_failed",
	getRecoveryToastContent: () => ({
		title: "Recoverable error",
		message: "retry",
	}),
}));

vi.mock("../lib/auto-update-checker.js", () => ({
	checkAndNotify: async () => {},
	checkForUpdates: async () => ({ hasUpdate: false, currentVersion: "4.5.0", latestVersion: null, updateCommand: "" }),
	clearUpdateCache: () => {},
}));

describe("OpenAIAuthPlugin rate-limit retry", () => {
	const envKeys = [
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		"CODEX_AUTH_PREWARM",
	] as const;

	const originalEnv: Record<string, string | undefined> = {};
	let originalFetch: any;

	beforeEach(() => {
		resetAccountManagerState();
		recoveryState.forceRecoverable = false;
		recoveryState.isRecoverableErrorCalls = 0;
		vi.resetModules();

		for (const key of envKeys) originalEnv[key] = process.env[key];

		process.env.CODEX_AUTH_RETRY_ALL_RATE_LIMITED = "1";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS = "5000";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "1";
		process.env.CODEX_AUTH_TOKEN_REFRESH_SKEW_MS = "0";
		process.env.CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS = "0";
		process.env.CODEX_AUTH_PREWARM = "0";

		vi.useFakeTimers();
		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as any;
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.fetch = originalFetch;

		for (const key of envKeys) {
			const value = originalEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}

		vi.restoreAllMocks();
	});

	it("waits and retries when all accounts are rate-limited", async () => {
		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;

		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;

		const fetchPromise = sdk.fetch("https://example.com", {});
		expect(globalThis.fetch).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1500);

		const response = await fetchPromise;
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
	});

	it("rebuilds request headers after rotating to the next workspace", async () => {
		const account = createMockAccount({
			workspaces: [
				{ id: "workspace-1", name: "Workspace 1", enabled: true },
				{ id: "workspace-2", name: "Workspace 2", enabled: true },
			],
			currentWorkspaceIndex: 0,
		});
		accountManagerState.accounts = [account];
		accountManagerState.accountSelections = [account, account];

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "workspace_disabled",
							message: "Workspace expired",
						},
					}),
					{
						status: 403,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(1);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(1);
		expect(accountManagerState.saveToDiskDebouncedCalls).toBeGreaterThanOrEqual(1);
		expect((account.workspaces as Array<Record<string, unknown>>)[0]?.enabled).toBe(false);

		const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
		const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
		expect(firstHeaders.get("x-account-id")).toBe("workspace-1");
		expect(secondHeaders.get("x-account-id")).toBe("workspace-2");
	});

	it("disables an exhausted workspace account and retries with another enabled account", async () => {
		const exhaustedAccount = createMockAccount({
			index: 0,
			accountId: "account-1",
			workspaces: [
				{ id: "workspace-1", name: "Workspace 1", enabled: true },
			],
			currentWorkspaceIndex: 0,
		});
		const fallbackAccount = createMockAccount({
			index: 1,
			accountId: "account-2",
			email: "fallback@example.com",
			refreshToken: "refresh-token-2",
		});
		accountManagerState.accounts = [exhaustedAccount, fallbackAccount];
		accountManagerState.accountSelections = [exhaustedAccount, fallbackAccount];

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "workspace_disabled",
							message: "Workspace expired",
						},
					}),
					{
						status: 403,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(1);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(1);
		expect(accountManagerState.setAccountEnabledCalls).toContainEqual({
			index: 0,
			enabled: false,
		});
		expect(accountManagerState.saveToDiskDebouncedCalls).toBeGreaterThanOrEqual(1);
		expect(exhaustedAccount.enabled).toBe(false);

		const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
		const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
		expect(firstHeaders.get("x-account-id")).toBe("workspace-1");
		expect(secondHeaders.get("x-account-id")).toBe("account-2");
	});

	it("does not disable workspace-less accounts on workspace-disabled responses", async () => {
		const account = createMockAccount({
			workspaces: undefined,
			currentWorkspaceIndex: undefined,
		});
		accountManagerState.accounts = [account];
		accountManagerState.accountSelections = [account];

		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "workspace_disabled",
						message: "Workspace expired",
					},
				}),
				{
					status: 403,
					headers: { "content-type": "application/json" },
				},
			),
		) as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(403);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(0);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(0);
		expect(accountManagerState.setAccountEnabledCalls).toEqual([]);
		expect(recoveryState.isRecoverableErrorCalls).toBe(0);
	});

	it("retries with a fallback account after a workspace-less account gets a workspace-disabled response", async () => {
		const firstAccount = createMockAccount({
			index: 0,
			accountId: "account-1",
			workspaces: undefined,
			currentWorkspaceIndex: undefined,
		});
		const secondAccount = createMockAccount({
			index: 1,
			accountId: "account-2",
			email: "fallback@example.com",
			refreshToken: "refresh-token-2",
			workspaces: undefined,
			currentWorkspaceIndex: undefined,
		});
		accountManagerState.accounts = [firstAccount, secondAccount];
		accountManagerState.accountSelections = [firstAccount, secondAccount];

		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: {
							code: "workspace_disabled",
							message: "Workspace expired",
						},
					}),
					{
						status: 403,
						headers: { "content-type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock as any;

		const { OpenAIAuthPlugin } = await import("../index.js");
		const client = {
			tui: { showToast: vi.fn() },
			auth: { set: vi.fn() },
		} as any;
		const plugin = await OpenAIAuthPlugin({ client });

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = (await plugin.auth.loader(getAuth, { options: {}, models: {} })) as any;
		const response = await sdk.fetch("https://example.com", {});

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(accountManagerState.disableCurrentWorkspaceCalls).toBe(0);
		expect(accountManagerState.rotateToNextWorkspaceCalls).toBe(0);
		expect(accountManagerState.setAccountEnabledCalls).toEqual([]);
	});
});

