import { describe, expect, it, vi } from "vitest";
import { verifyRuntimeFlaggedAccounts } from "../lib/runtime/verify-flagged.js";

describe("verifyRuntimeFlaggedAccounts", () => {
	it("reports when there are no flagged accounts to verify", async () => {
		const showLine = vi.fn();

		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: vi.fn().mockResolvedValue({
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

	it("restores cached flagged accounts and clears them from flagged storage", async () => {
		const persistAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		const saveFlaggedAccounts = vi.fn(async () => {});
		const showLine = vi.fn();

		await verifyRuntimeFlaggedAccounts({
			loadFlaggedAccounts: vi.fn().mockResolvedValue({
				version: 1,
				accounts: [
					{
						refreshToken: "refresh-1",
						email: "user@example.com",
						accountId: "acct-1",
						accountLabel: "Work",
					},
				],
			}),
			lookupCodexCliTokensByEmail: vi.fn().mockResolvedValue({
				accessToken: "access-1",
				refreshToken: "refresh-1b",
				expiresAt: 5_000,
			}),
			queuedRefresh: vi.fn(),
			resolveTokenSuccessAccount: vi.fn((tokens) => ({
				...tokens,
				accountLabel: "Resolved",
			})),
			persistAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts,
			showLine,
			now: () => 1_000,
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
			accounts: [],
		});
		expect(showLine).toHaveBeenCalledWith(
			"[1/1] user@example.com: RESTORED (Codex CLI cache)",
		);
	});
});
