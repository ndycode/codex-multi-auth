import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stripVTControlCharacters } from "node:util";

process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = "1";
let mockInitialNullCalls = 1;

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
	getUnsupportedCodexModelInfo: () => ({ isUnsupported: false }),
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
			if (this.calls <= mockInitialNullCalls) return null;
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
	withAccountStorageTransaction: async (
		handler: (
			storage: { version: 3; accounts: []; activeIndex: number; activeIndexByFamily: Record<string, number> },
			persist: (next: { version: 3; accounts: []; activeIndex: number; activeIndexByFamily: Record<string, number> }) => Promise<void>,
		) => Promise<unknown>,
	) =>
		handler(
			{
				version: 3,
				accounts: [],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			async () => {},
		),
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
		"CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS",
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
		process.env.CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS = "0";
		process.env.CODEX_AUTH_TOKEN_REFRESH_SKEW_MS = "0";
		process.env.CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS = "0";
		process.env.CODEX_AUTH_PREWARM = "0";
		mockInitialNullCalls = 1;

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

	it("strips query and fragment when audit URL parsing falls back", async () => {
		vi.resetModules();
		const auditLogMock = vi.fn();
		vi.doMock("../lib/audit.js", async () => {
			const actual = await vi.importActual("../lib/audit.js");
			return {
				...(actual as Record<string, unknown>),
				auditLog: auditLogMock,
			};
		});

		try {
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
			const responsePromise = sdk.fetch("relative/path?token=super-secret#frag", {});
			await vi.advanceTimersByTimeAsync(1500);
			const response = await responsePromise;
			expect(response.status).toBe(200);

			const resources = auditLogMock.mock.calls.map((args) => String(args[2] ?? ""));
			expect(resources.length).toBeGreaterThan(0);
			for (const resource of resources) {
				expect(resource).not.toContain("?");
				expect(resource).not.toContain("#");
				expect(resource).not.toContain("super-secret");
			}
		} finally {
			vi.doUnmock("../lib/audit.js");
			vi.resetModules();
		}
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

	it("stops immediately when absolute ceiling is below the raw retry wait", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS = "500";
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
		expect(response.status).toBe(429);
		expect(globalThis.fetch).not.toHaveBeenCalled();

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = stripVTControlCharacters(String(metrics));
		expect(plainMetrics).toContain("Retry governor stops (absolute ceiling): 1");
	});

	it("increments retry-limit stop metric when retries are disabled", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "0";
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
		expect(response.status).toBe(429);
		expect(globalThis.fetch).not.toHaveBeenCalled();

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = stripVTControlCharacters(String(metrics));
		expect(plainMetrics).toContain("Retry governor stops (retry limit): 1");
	});

	it("caps jittered retry waits at the configured absolute ceiling", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS = "1100";
		vi.spyOn(Math, "random").mockReturnValue(1);
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

		await vi.advanceTimersByTimeAsync(1150);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		const response = await fetchPromise;
		expect(response.status).toBe(200);
	});

	it("consumes remaining ceiling budget under -20% jitter without premature stop", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS = "1600";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "2";
		mockInitialNullCalls = 2;
		vi.spyOn(Math, "random").mockReturnValue(0);
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

		await vi.advanceTimersByTimeAsync(1599);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		const response = await fetchPromise;
		expect(response.status).toBe(200);

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = stripVTControlCharacters(String(metrics));
		expect(plainMetrics).toContain("Retry governor stops (absolute ceiling): 0");
	});

	it("stops once the absolute ceiling budget is exhausted instead of spinning zero-delay retries", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS = "1600";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "10";
		mockInitialNullCalls = 999;
		vi.spyOn(Math, "random").mockReturnValue(0);
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

		await vi.advanceTimersByTimeAsync(1600);
		await vi.advanceTimersByTimeAsync(0);

		const response = await fetchPromise;
		expect(response.status).toBe(429);
		expect(globalThis.fetch).not.toHaveBeenCalled();

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = stripVTControlCharacters(String(metrics));
		expect(plainMetrics).toContain("Retry governor stops (absolute ceiling): 1");
		expect(plainMetrics).toContain("Retry governor stops (retry limit): 0");
	});

	it("keeps retry budgets isolated across overlapping requests", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "1";
		mockInitialNullCalls = 2;
		vi.spyOn(Math, "random").mockReturnValue(0.5);
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
		const requestA = sdk.fetch("https://example.com/a", {});
		const requestB = sdk.fetch("https://example.com/b", {});

		await vi.advanceTimersByTimeAsync(1000);
		const [responseA, responseB] = await Promise.all([requestA, requestB]);

		expect(responseA.status).toBe(200);
		expect(responseB.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = stripVTControlCharacters(String(metrics));
		expect(plainMetrics).toContain("Retry governor stops (retry limit): 0");
	});

	it("keeps max wait checks deterministic at the raw wait threshold", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS = "1000";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "2";
		vi.spyOn(Math, "random").mockReturnValue(1);
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
		await vi.advanceTimersByTimeAsync(1199);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		const response = await fetchPromise;
		expect(response.status).toBe(200);

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = stripVTControlCharacters(String(metrics));
		expect(plainMetrics).toContain("Retry governor stops (wait>max): 0");
	});

	it("blocks retries when raw wait exceeds max wait even under negative jitter", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS = "999";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "2";
		vi.spyOn(Math, "random").mockReturnValue(0);
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
		expect(response.status).toBe(429);
		expect(globalThis.fetch).not.toHaveBeenCalled();

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = stripVTControlCharacters(String(metrics));
		expect(plainMetrics).toContain("Retry governor stops (wait>max): 1");
	});

	it("uses family-level scheduler keys when request model is omitted", async () => {
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
		).mockImplementation(() => {
			selectionCallCount += 1;
			return (selectionCallCount === 1 ? accountOne : accountTwo) as never;
		});
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
				body: {},
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
			body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
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

