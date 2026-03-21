import { describe, expect, it, vi } from "vitest";
import { verifyRuntimeFlaggedAccounts } from "../lib/runtime/verify-flagged.js";

describe("verifyRuntimeFlaggedAccounts", () => {
	it("restores accounts from Codex CLI cache and preserves the remainder", async () => {
		const persistAccounts = vi.fn(async () => {});
		const saveFlaggedAccounts = vi.fn(async () => {});
		const showLine = vi.fn();
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [
					{ email: "cached@example.com", refreshToken: "cached-refresh", addedAt: 1, lastUsed: 1 },
					{ email: "flagged@example.com", refreshToken: "flagged-refresh", addedAt: 1, lastUsed: 1 },
				],
			}),
			lookupCodexCliTokensByEmail: async (email) =>
				email === "cached@example.com"
					? { accessToken: "access", refreshToken: "new-refresh", expiresAt: Date.now() + 60_000 }
					: null,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant", message: "refresh failed" }),
			resolveAccountSelection: (tokens) => ({ refreshToken: tokens.refresh, accessToken: tokens.access }) as never,
			persistAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			showLine,
		});
		expect(persistAccounts).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [expect.objectContaining({ refreshToken: "flagged-refresh" })],
		});
		expect(showLine).toHaveBeenCalledWith(expect.stringContaining("ca***@***.com: RESTORED (Codex CLI cache)"));
	});

	it("logs verification failures through logError and keeps the account flagged", async () => {
		const logError = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});
		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: async () => ({
				version: 1,
				accounts: [{ email: "broken@example.com", refreshToken: "broken-refresh", addedAt: 1, lastUsed: 1 }],
			}),
			lookupCodexCliTokensByEmail: async () => {
				throw new Error("cache unavailable");
			},
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			resolveAccountSelection: () => ({}) as never,
			persistAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			logInfo: vi.fn(),
			logError,
			showLine: vi.fn(),
		});
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining("Failed to verify flagged account br***@***.com: cache unavailable"),
		);
		expect(saveFlaggedAccounts).toHaveBeenCalledWith({
			version: 1,
			accounts: [expect.objectContaining({ refreshToken: "broken-refresh", lastError: "cache unavailable" })],
		});
	});
});
