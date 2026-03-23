import { describe, expect, it, vi } from "vitest";
import { verifyRuntimeFlaggedAccounts } from "../lib/runtime/verify-flagged.js";

describe("verifyRuntimeFlaggedAccounts", () => {
	it("reports when there are no flagged accounts to verify", async () => {
		const showLine = vi.fn();

		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [],
			}),
			lookupCodexCliTokensByEmail: vi.fn(),
			queuedRefresh: vi.fn(),
			resolveTokenSuccessAccount: vi.fn(),
			persistAccounts: vi.fn(),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(),
			showLine,
		});

		expect(showLine).toHaveBeenCalledWith("\nNo flagged accounts to verify.\n");
	});

	it("restores cached flagged accounts, preserves metadata, and keeps the remainder", async () => {
		const now = 10_000;
		const persistAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});
		const showLine = vi.fn();

		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{
						refreshToken: "cached-refresh",
						email: "cached@example.com",
						accountId: "acct-1",
						accountLabel: "Work",
						addedAt: 1,
						lastUsed: 1,
					},
					{
						refreshToken: "flagged-refresh",
						email: "flagged@example.com",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			lookupCodexCliTokensByEmail: async (email) =>
				email === "cached@example.com"
					? {
							accessToken: "access-1",
							refreshToken: "refresh-1b",
							expiresAt: now + 60_000,
						}
					: null,
			queuedRefresh: async () => ({
				type: "failed" as const,
				reason: "invalid_grant",
				message: "refresh failed",
			}),
			resolveTokenSuccessAccount: vi.fn((tokens) => ({
				...tokens,
				accountLabel: "Resolved",
			})),
			persistAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts,
			showLine,
			now: () => now,
		});

		expect(persistAccounts).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					access: "access-1",
					refresh: "refresh-1b",
					accountIdOverride: "acct-1",
					accountLabel: "Resolved",
				}),
			],
			false,
		);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [expect.objectContaining({ refreshToken: "flagged-refresh" })],
		});
		expect(showLine).toHaveBeenCalledWith(
			"[1/2] Work: RESTORED (Codex CLI cache)",
		);
	});

	it("restores accounts after a successful refresh when cache misses", async () => {
		const now = 10_000;
		const persistAccounts = vi.fn(async () => {});
		const saveFlaggedAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		const showLine = vi.fn();

		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{
						email: "refresh@example.com",
						refreshToken: "refresh-token",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			lookupCodexCliTokensByEmail: async () => null,
			queuedRefresh: async () => ({
				type: "success" as const,
				access: "new-access",
				refresh: "new-refresh",
				expires: now + 60_000,
			}),
			resolveTokenSuccessAccount: (tokens) =>
				({
					...tokens,
					accountLabel: "Recovered",
				}) as never,
			persistAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts,
			now: () => now,
			showLine,
		});

		expect(persistAccounts).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					access: "new-access",
					refresh: "new-refresh",
					accountLabel: "Recovered",
				}),
			],
			false,
		);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [],
		});
		expect(showLine).toHaveBeenCalledWith(
			expect.stringContaining("re***@***.com: RESTORED"),
		);
	});

	it("logs verification failures and keeps the account flagged", async () => {
		const now = 10_000;
		const logError = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});

		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{
						email: "broken@example.com",
						refreshToken: "broken-refresh",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			lookupCodexCliTokensByEmail: async () => ({
				accessToken: "cached-access",
				refreshToken: "cached-refresh",
				expiresAt: now + 60_000,
			}),
			queuedRefresh: async () => ({
				type: "failed" as const,
				reason: "invalid_grant",
			}),
			resolveTokenSuccessAccount: () => {
				throw new Error("selection failed");
			},
			persistAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			logError,
			now: () => now,
			showLine: vi.fn(),
		});

		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining(
				"Failed to verify flagged account br***@***.com: selection failed",
			),
		);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [
				expect.objectContaining({
					refreshToken: "broken-refresh",
					lastError: "selection failed",
				}),
			],
		});
	});

	it("writes restored accounts before flagged state cleanup", async () => {
		const now = 10_000;
		const calls: string[] = [];

		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{
						email: "refresh@example.com",
						refreshToken: "refresh-token",
						addedAt: 1,
						lastUsed: 1,
					},
				],
			}),
			lookupCodexCliTokensByEmail: async () => {
				throw new Error("busy");
			},
			queuedRefresh: async () => ({
				type: "success" as const,
				access: "new-access",
				refresh: "new-refresh",
				expires: now + 60_000,
			}),
			resolveTokenSuccessAccount: (tokens) => ({ ...tokens }) as never,
			persistAccounts: vi.fn(async () => {
				calls.push("persistAccounts");
			}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {
				calls.push("saveFlaggedAccounts");
			}),
			now: () => now,
			showLine: vi.fn(),
		});

		expect(calls).toEqual(["persistAccounts", "saveFlaggedAccounts"]);
	});

	it("leaves flagged state untouched when persistAccounts throws EBUSY", async () => {
		const now = 10_000;
		const saveFlaggedAccounts = vi.fn(async () => {});
		const persistAccounts = vi.fn(async () => {
			const error = new Error("busy") as Error & { code?: string };
			error.code = "EBUSY";
			throw error;
		});

		await expect(
			verifyRuntimeFlaggedAccounts({
				loadFlaggedAccounts: async () => ({
					version: 1,
					accounts: [
						{
							email: "refresh@example.com",
							refreshToken: "refresh-token",
							addedAt: 1,
							lastUsed: 1,
						},
					],
				}),
				lookupCodexCliTokensByEmail: async () => {
					throw new Error("busy");
				},
				queuedRefresh: async () => ({
					type: "success" as const,
					access: "new-access",
					refresh: "new-refresh",
					expires: now + 60_000,
				}),
				resolveTokenSuccessAccount: (tokens) => ({ ...tokens }) as never,
				persistAccounts,
				invalidateAccountManagerCache: vi.fn(),
				saveFlaggedAccounts,
				now: () => now,
				showLine: vi.fn(),
			}),
		).rejects.toThrow("busy");
		expect(saveFlaggedAccounts).not.toHaveBeenCalled();
	});
});
