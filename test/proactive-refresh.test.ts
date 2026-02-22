import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	shouldRefreshProactively,
	getTimeUntilExpiry,
	proactiveRefreshAccount,
	refreshExpiringAccounts,
	applyRefreshResult,
	DEFAULT_PROACTIVE_BUFFER_MS,
	MIN_PROACTIVE_BUFFER_MS,
} from "../lib/proactive-refresh.js";
import type { ManagedAccount } from "../lib/accounts.js";
import * as refreshQueue from "../lib/refresh-queue.js";

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(),
}));

function createMockAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
	return {
		index: 0,
		refreshToken: "test-refresh-token",
		addedAt: Date.now() - 3600000,
		lastUsed: Date.now() - 60000,
		rateLimitResetTimes: {},
		...overrides,
	};
}

describe("proactive-refresh", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.resetAllMocks();
	});

	describe("shouldRefreshProactively", () => {
		it("returns false when no expiry is set", () => {
			const account = createMockAccount({ expires: undefined });
			expect(shouldRefreshProactively(account)).toBe(false);
		});

		it("returns true when no access token exists", () => {
			const account = createMockAccount({
				access: undefined,
				expires: Date.now() + 600000,
			});
			expect(shouldRefreshProactively(account)).toBe(true);
		});

		it("returns true when token expires within buffer window", () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() + 4 * 60 * 1000,
			});
			expect(shouldRefreshProactively(account, DEFAULT_PROACTIVE_BUFFER_MS)).toBe(true);
		});

		it("returns false when token expires after buffer window", () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() + 10 * 60 * 1000,
			});
			expect(shouldRefreshProactively(account, DEFAULT_PROACTIVE_BUFFER_MS)).toBe(false);
		});

		it("returns true when token is already expired", () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() - 1000,
			});
			expect(shouldRefreshProactively(account)).toBe(true);
		});

		it("clamps buffer to minimum value", () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() + 20 * 1000,
			});
			expect(shouldRefreshProactively(account, 1000)).toBe(true);
			expect(shouldRefreshProactively(account, MIN_PROACTIVE_BUFFER_MS)).toBe(true);
		});

		it("uses default buffer when not specified", () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() + 4 * 60 * 1000,
			});
			expect(shouldRefreshProactively(account)).toBe(true);
		});

		it("returns false for token expiring just after buffer", () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() + DEFAULT_PROACTIVE_BUFFER_MS + 1000,
			});
			expect(shouldRefreshProactively(account)).toBe(false);
		});
	});

	describe("getTimeUntilExpiry", () => {
		it("returns Infinity when no expiry is set", () => {
			const account = createMockAccount({ expires: undefined });
			expect(getTimeUntilExpiry(account)).toBe(Infinity);
		});

		it("returns remaining time until expiry", () => {
			const expiresIn = 600000;
			const account = createMockAccount({ expires: Date.now() + expiresIn });
			expect(getTimeUntilExpiry(account)).toBe(expiresIn);
		});

		it("returns 0 when already expired", () => {
			const account = createMockAccount({ expires: Date.now() - 1000 });
			expect(getTimeUntilExpiry(account)).toBe(0);
		});

		it("returns exact time for boundary case", () => {
			const account = createMockAccount({ expires: Date.now() });
			expect(getTimeUntilExpiry(account)).toBe(0);
		});
	});

	describe("proactiveRefreshAccount", () => {
		it("returns not_needed when refresh not required", async () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() + 10 * 60 * 1000,
			});

			const result = await proactiveRefreshAccount(account);

			expect(result.refreshed).toBe(false);
			expect(result.reason).toBe("not_needed");
			expect(refreshQueue.queuedRefresh).not.toHaveBeenCalled();
		});

		it("returns no_refresh_token when token missing", async () => {
			const account = createMockAccount({
				refreshToken: "",
				access: undefined,
				expires: Date.now() + 60000,
			});

			const result = await proactiveRefreshAccount(account);

			expect(result.refreshed).toBe(false);
			expect(result.reason).toBe("no_refresh_token");
		});

		it("returns success on successful refresh", async () => {
			const account = createMockAccount({
				access: "old-access",
				expires: Date.now() + 60000,
			});

			const successResult = {
				type: "success" as const,
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 3600000,
			};
			vi.mocked(refreshQueue.queuedRefresh).mockResolvedValue(successResult);

			const result = await proactiveRefreshAccount(account);

			expect(result.refreshed).toBe(true);
			expect(result.reason).toBe("success");
			expect(result.tokenResult).toEqual(successResult);
		});

		it("returns failed on refresh failure", async () => {
			const account = createMockAccount({
				access: "old-access",
				expires: Date.now() + 60000,
			});

			const failResult = {
				type: "failed" as const,
				reason: "network_error" as const,
				message: "Network error",
			};
			vi.mocked(refreshQueue.queuedRefresh).mockResolvedValue(failResult);

			const result = await proactiveRefreshAccount(account);

			expect(result.refreshed).toBe(true);
			expect(result.reason).toBe("failed");
			expect(result.tokenResult).toEqual(failResult);
		});

		it("uses custom buffer when specified", async () => {
			const account = createMockAccount({
				access: "test-access",
				expires: Date.now() + 2 * 60 * 1000,
			});

			const result = await proactiveRefreshAccount(account, 60000);
			expect(result.reason).toBe("not_needed");

			vi.mocked(refreshQueue.queuedRefresh).mockResolvedValue({
				type: "success" as const,
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 3600000,
			});

			const result2 = await proactiveRefreshAccount(account, 3 * 60 * 1000);
			expect(result2.reason).toBe("success");
		});
	});

	describe("refreshExpiringAccounts", () => {
		it("returns empty map when no accounts need refresh", async () => {
			const accounts = [
				createMockAccount({
					index: 0,
					access: "access-0",
					expires: Date.now() + 10 * 60 * 1000,
				}),
				createMockAccount({
					index: 1,
					access: "access-1",
					expires: Date.now() + 15 * 60 * 1000,
				}),
			];

			const results = await refreshExpiringAccounts(accounts);

			expect(results.size).toBe(0);
			expect(refreshQueue.queuedRefresh).not.toHaveBeenCalled();
		});

		it("does not log when all accounts return no_refresh_token (line 171 coverage)", async () => {
			const accounts = [
				createMockAccount({
					index: 0,
					access: undefined,
					expires: Date.now() + 60000,
					refreshToken: "",
				}),
				createMockAccount({
					index: 1,
					access: undefined,
					expires: Date.now() + 60000,
					refreshToken: "",
				}),
			];

			const results = await refreshExpiringAccounts(accounts);

			expect(results.size).toBe(2);
			expect(results.get(0)?.reason).toBe("no_refresh_token");
			expect(results.get(1)?.reason).toBe("no_refresh_token");
			expect(refreshQueue.queuedRefresh).not.toHaveBeenCalled();
		});

		it("refreshes only accounts approaching expiry", async () => {
			const accounts = [
				createMockAccount({
					index: 0,
					access: "access-0",
					expires: Date.now() + 60000,
					refreshToken: "refresh-0",
				}),
				createMockAccount({
					index: 1,
					access: "access-1",
					expires: Date.now() + 10 * 60 * 1000,
					refreshToken: "refresh-1",
				}),
			];

			vi.mocked(refreshQueue.queuedRefresh).mockResolvedValue({
				type: "success" as const,
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 3600000,
			});

			const results = await refreshExpiringAccounts(accounts);

			expect(results.size).toBe(1);
			expect(results.has(0)).toBe(true);
			expect(results.has(1)).toBe(false);
			expect(refreshQueue.queuedRefresh).toHaveBeenCalledTimes(1);
			expect(refreshQueue.queuedRefresh).toHaveBeenCalledWith("refresh-0");
		});

		it("refreshes multiple accounts in parallel", async () => {
			const accounts = [
				createMockAccount({
					index: 0,
					access: "access-0",
					expires: Date.now() + 60000,
					refreshToken: "refresh-0",
				}),
				createMockAccount({
					index: 1,
					access: "access-1",
					expires: Date.now() + 120000,
					refreshToken: "refresh-1",
				}),
				createMockAccount({
					index: 2,
					access: "access-2",
					expires: Date.now() + 180000,
					refreshToken: "refresh-2",
				}),
			];

			vi.mocked(refreshQueue.queuedRefresh).mockResolvedValue({
				type: "success" as const,
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 3600000,
			});

			const results = await refreshExpiringAccounts(accounts);

			expect(results.size).toBe(3);
			expect(refreshQueue.queuedRefresh).toHaveBeenCalledTimes(3);
		});

		it("handles mixed success and failure results", async () => {
			const accounts = [
				createMockAccount({
					index: 0,
					access: "access-0",
					expires: Date.now() + 60000,
					refreshToken: "refresh-0",
				}),
				createMockAccount({
					index: 1,
					access: "access-1",
					expires: Date.now() + 120000,
					refreshToken: "refresh-1",
				}),
			];

			vi.mocked(refreshQueue.queuedRefresh)
				.mockResolvedValueOnce({
					type: "success" as const,
					access: "new-access",
					refresh: "new-refresh",
					expires: Date.now() + 3600000,
				})
				.mockResolvedValueOnce({
					type: "failed" as const,
					reason: "http_error" as const,
					message: "Invalid token",
				});

			const results = await refreshExpiringAccounts(accounts);

			expect(results.size).toBe(2);
			expect(results.get(0)?.reason).toBe("success");
			expect(results.get(1)?.reason).toBe("failed");
		});
	});

	describe("applyRefreshResult", () => {
		it("updates account with new tokens", () => {
			const account = createMockAccount({
				access: "old-access",
				expires: Date.now(),
				refreshToken: "old-refresh",
			});

			const newExpires = Date.now() + 3600000;
			applyRefreshResult(account, {
				type: "success",
				access: "new-access",
				refresh: "new-refresh",
				expires: newExpires,
			});

			expect(account.access).toBe("new-access");
			expect(account.refreshToken).toBe("new-refresh");
			expect(account.expires).toBe(newExpires);
		});

		it("preserves refresh token if unchanged", () => {
			const account = createMockAccount({
				access: "old-access",
				expires: Date.now(),
				refreshToken: "same-refresh",
			});

			applyRefreshResult(account, {
				type: "success",
				access: "new-access",
				refresh: "same-refresh",
				expires: Date.now() + 3600000,
			});

			expect(account.refreshToken).toBe("same-refresh");
		});
	});

	describe("constants", () => {
		it("DEFAULT_PROACTIVE_BUFFER_MS is 5 minutes", () => {
			expect(DEFAULT_PROACTIVE_BUFFER_MS).toBe(5 * 60 * 1000);
		});

		it("MIN_PROACTIVE_BUFFER_MS is 30 seconds", () => {
			expect(MIN_PROACTIVE_BUFFER_MS).toBe(30 * 1000);
		});
	});
});
