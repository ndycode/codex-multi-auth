import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = "1";

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
	createCodexHeaders: () => new Headers(),
	handleErrorResponse: async (response: Response) => ({ response }),
	resolveUnsupportedCodexFallbackModel: () => undefined,
	shouldFallbackToGpt52OnUnsupportedGpt53: () => false,
	handleSuccessResponse: async (response: Response) => response,
}));

vi.mock("../lib/request/request-transformer.js", () => ({
	applyFastSessionDefaults: <T>(config: T) => config,
}));

vi.mock("../lib/quota-cache.js", () => ({
	loadQuotaCache: vi.fn(async () => ({ byAccountId: {}, byEmail: {} })),
}));

vi.mock("../lib/accounts.js", () => {
	class AccountManager {
		private calls = 0;

		static async loadFromDisk() {
			return new AccountManager();
		}

		getAccountCount() {
			return 1;
		}

		getCurrentOrNextForFamily() {
			this.calls += 1;
			if (this.calls === 1) return null;
			return { index: 0, accountId: "account-1", email: "user@example.com" };
		}

		getCurrentOrNextForFamilyHybrid() {
			return this.getCurrentOrNextForFamily();
		}

		getAccountByIndex(index: number) {
			if (index !== 0) return null;
			return { index: 0, accountId: "account-1", email: "user@example.com" };
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

	saveToDiskDebounced() {}

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
	}

	return {
		AccountManager,
		extractAccountEmail: () => "user@example.com",
		extractAccountId: () => "account-1",
		selectBestAccountCandidate: (candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
		resolveRequestAccountId: (_storedId: string | undefined, _source: string | undefined, tokenId: string | undefined) => tokenId,
		formatAccountLabel: (_account: any, index: number) => `Account ${index + 1}`,
		formatCooldown: (ms: number) => `${ms}ms`,
		formatWaitTime: (ms: number) => `${ms}ms`,
		sanitizeEmail: (email: string) => email,
		parseRateLimitReason: () => "unknown",
		getQuotaKey: (family: string, model?: string | null) => (model ? `${family}:${model}` : family),
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

	it("uses normalized quota scheduler keys for provider-prefixed model ids", async () => {
		const { OpenAIAuthPlugin } = await import("../index.js");
		const accountsModule = await import("../lib/accounts.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const quotaCacheModule = await import("../lib/quota-cache.js");

		const loadQuotaCacheMock = vi.mocked(quotaCacheModule.loadQuotaCache);
		const now = Date.now();
		const accountOne = {
			index: 0,
			accountId: "account-1",
			email: "user1@example.com",
			refreshToken: "refresh-1",
			rateLimitResetTimes: {},
		};
		const accountTwo = {
			index: 1,
			accountId: "account-2",
			email: "user2@example.com",
			refreshToken: "refresh-2",
			rateLimitResetTimes: {},
		};

		loadQuotaCacheMock.mockResolvedValueOnce({
			byAccountId: {
				"account-1": {
					updatedAt: now,
					status: 429,
					model: "gpt-5.1",
					primary: {
						usedPercent: 100,
						resetAtMs: now + 5 * 60_000,
					},
					secondary: {},
				},
			},
			byEmail: {},
		});

		vi.spyOn(accountsModule.AccountManager.prototype, "getAccountCount").mockReturnValue(2);
		vi.spyOn(accountsModule.AccountManager.prototype, "getAccountByIndex").mockImplementation(
			(index: number) =>
				(index === 0 ? accountOne : index === 1 ? accountTwo : null) as never,
		);
		let selectionCallCount = 0;
		vi.spyOn(
			accountsModule.AccountManager.prototype,
			"getCurrentOrNextForFamilyHybrid",
		).mockImplementation(
			() => {
				selectionCallCount += 1;
				return (selectionCallCount === 1 ? accountOne : accountTwo) as never;
			},
		);
		vi.spyOn(accountsModule.AccountManager.prototype, "toAuthDetails").mockImplementation(
			(account: { index?: number; accountId?: string }) => ({
				type: "oauth",
				access: account.index === 0 ? "access-acc-1" : "access-acc-2",
				refresh: `refresh-${account.accountId ?? "unknown"}`,
				expires: Date.now() + 60_000,
			}),
		);
		const markRateLimitSpy = vi.spyOn(
			accountsModule.AccountManager.prototype,
			"markRateLimitedWithReason",
		);
		vi.spyOn(fetchHelpers, "transformRequestForCodex").mockImplementationOnce(
			async (init: unknown) => ({
				updatedInit: init,
				body: { model: "OPENAI/GPT-5.1" },
			}),
		);
		vi.spyOn(fetchHelpers, "createCodexHeaders").mockImplementation(
			(_init: unknown, _accountId: unknown, accessToken: unknown) =>
				new Headers({ "x-test-access-token": String(accessToken ?? "") }),
		);

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
		const response = await sdk.fetch("https://example.com", {
			method: "POST",
			body: JSON.stringify({ model: "OPENAI/GPT-5.1" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const headers = new Headers(
			(vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
		);
		expect(headers.get("x-test-access-token")).toBe("access-acc-2");
		expect(markRateLimitSpy).toHaveBeenCalled();
	});
});

