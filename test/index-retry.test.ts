import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.CODEX_MULTI_AUTH_EXPOSE_ADMIN_TOOLS = "1";

const shouldRefreshTokenMock = vi.fn(() => false);
const refreshAndUpdateTokenMock = vi.fn(async (auth: unknown) => auth);
const handleSuccessResponseDetailedMock = vi.fn(async (response: Response) => ({
	response,
	parsedBody: undefined,
}));
const addJitterMock = vi.fn((delayMs: number) => delayMs);
let unavailableSelectionCount = 1;

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
	shouldRefreshToken: shouldRefreshTokenMock,
	refreshAndUpdateToken: refreshAndUpdateTokenMock,
	createCodexHeaders: () => new Headers(),
	handleErrorResponse: async (response: Response) => ({ response }),
	resolveUnsupportedCodexFallbackModel: () => undefined,
	shouldFallbackToGpt52OnUnsupportedGpt53: () => false,
	handleSuccessResponse: async (response: Response) => response,
	handleSuccessResponseDetailed: handleSuccessResponseDetailedMock,
}));

vi.mock("../lib/request/request-transformer.js", () => ({
	applyFastSessionDefaults: <T>(config: T) => config,
}));

vi.mock("../lib/rotation.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/rotation.js")>();
	return {
		...actual,
		addJitter: (delayMs: number, jitterRatio: number) => addJitterMock(delayMs, jitterRatio),
	};
});

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
			if (this.calls <= unavailableSelectionCount) return null;
			return { index: 0, accountId: "account-1", email: "user@example.com" };
		}

		getCurrentOrNextForFamilyHybrid() {
			return this.getCurrentOrNextForFamily();
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

	clearAuthFailures() {}

	incrementAuthFailures() {
		return 1;
	}

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

		removeAccount() {}

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

		vi.useFakeTimers();
		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as any;
		shouldRefreshTokenMock.mockReset();
		shouldRefreshTokenMock.mockReturnValue(false);
		refreshAndUpdateTokenMock.mockReset();
		refreshAndUpdateTokenMock.mockImplementation(async (auth: unknown) => auth);
		handleSuccessResponseDetailedMock.mockReset();
		handleSuccessResponseDetailedMock.mockImplementation(async (response: Response) => ({
			response,
			parsedBody: undefined,
		}));
		unavailableSelectionCount = 1;
		addJitterMock.mockReset();
		addJitterMock.mockImplementation((delayMs: number) => delayMs);
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

	it("stops retrying when absolute retry wait ceiling would be exceeded", async () => {
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

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(response.status).toBe(429);

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = String(metrics).replace(/\u001b\[[0-9;]*m/g, "");
		expect(plainMetrics).toContain("Retry governor stops (absolute ceiling): 1");
	});

	it("counts jittered wait toward absolute ceiling across retries", async () => {
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = "4";
		process.env.CODEX_AUTH_RETRY_ALL_ABSOLUTE_CEILING_MS = "2100";
		unavailableSelectionCount = 2;
		addJitterMock.mockImplementation((delayMs: number) => delayMs + 200);

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
		await vi.advanceTimersByTimeAsync(1_300);
		const response = await fetchPromise;

		expect(addJitterMock).toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(response.status).toBe(429);

		const metrics = await plugin.tool["codex-metrics"].execute();
		const plainMetrics = String(metrics).replace(/\u001b\[[0-9;]*m/g, "");
		expect(plainMetrics).toContain("Retry governor stops (absolute ceiling): 1");
	});

	it("deduplicates refresh endpoint work for concurrent sdk.fetch retries", async () => {
		shouldRefreshTokenMock.mockReturnValue(true);
		let releaseRefresh: (() => void) | undefined;
		const refreshEndpoint = vi.fn(async () => {
			await new Promise<void>((resolve) => {
				releaseRefresh = resolve;
			});
			return {
				type: "oauth",
				access: "refreshed-access",
				refresh: "refreshed-refresh",
				expires: Date.now() + 60_000,
				multiAccount: true,
			};
		});
		let refreshInFlight: Promise<unknown> | null = null;
		refreshAndUpdateTokenMock.mockImplementation(async (auth: unknown) => {
			if (!refreshInFlight) {
				refreshInFlight = (async () => {
					const refreshed = await refreshEndpoint();
					if (auth && typeof auth === "object") {
						Object.assign(auth as Record<string, unknown>, refreshed);
					}
					return auth;
				})().finally(() => {
					refreshInFlight = null;
				});
			}
			return refreshInFlight;
		});

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

		const pending = Promise.all(
			Array.from({ length: 10 }, () => sdk.fetch("https://example.com", {})),
		);
		await vi.advanceTimersByTimeAsync(1500);
		await Promise.resolve();

		expect(refreshEndpoint).toHaveBeenCalledTimes(1);
		expect(releaseRefresh).toBeTypeOf("function");
		releaseRefresh?.();

		const responses = await pending;
		expect(responses).toHaveLength(10);
		for (const response of responses) {
			expect(response.status).toBe(200);
		}
		expect(refreshEndpoint).toHaveBeenCalledTimes(1);
	});
});

