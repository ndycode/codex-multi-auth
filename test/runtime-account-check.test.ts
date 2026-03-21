import { describe, expect, it, vi } from "vitest";
import { runRuntimeAccountCheck } from "../lib/runtime/account-check.js";

describe("runRuntimeAccountCheck", () => {
	it("reports when there are no accounts to check", async () => {
		const showLine = vi.fn();
		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => null,
			createEmptyStorage: () => ({ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} }),
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: () => ({ flaggedStorage: { version: 1, accounts: [] }, removeFromActive: new Set(), storageChanged: false, flaggedChanged: false, ok: 0, errors: 0, disabled: 0 }),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => ({ quotaKey: "codex", limits: {} } as never),
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			showLine,
		});
		expect(showLine).toHaveBeenCalledWith("\nNo accounts to check.\n");
	});

	it("reuses the current time when flagging an invalid refresh token", async () => {
		const saveFlaggedAccounts = vi.fn(async () => {});
		const now = vi.fn(() => 1000 + now.mock.calls.length - 1);

		await runRuntimeAccountCheck(true, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{ email: "one@example.com", refreshToken: "refresh-1", accessToken: undefined, addedAt: 1, lastUsed: 1 },
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage: () => ({ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} }),
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) => ({ flaggedStorage, removeFromActive: new Set(), storageChanged: false, flaggedChanged: false, ok: 0, errors: 0, disabled: 0 }),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant", message: "refresh failed" }),
			isRuntimeFlaggableFailure: () => true,
			fetchCodexQuotaSnapshot: async () => { throw new Error("should not probe quota in deep mode"); },
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			now,
			showLine: vi.fn(),
		});

		const flaggedStorage = saveFlaggedAccounts.mock.calls[0]?.[0];
		expect(flaggedStorage.accounts).toHaveLength(1);
		expect(flaggedStorage.accounts[0]?.flaggedAt).toBe(1000);
		expect(now).toHaveBeenCalledTimes(1);
	});
	it("masks emails in output lines", async () => {
		const showLine = vi.fn();
		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [{ email: "visible@example.com", refreshToken: "r1", accessToken: "a1", addedAt: 1, lastUsed: 1, expiresAt: Date.now() + 60_000 }],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage: () => ({ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} }),
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) => ({ flaggedStorage, removeFromActive: new Set(), storageChanged: false, flaggedChanged: false, ok: 0, errors: 0, disabled: 0 }),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant" }),
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => ({ remaining5h: 1, remaining7d: 2 } as never),
			resolveRequestAccountId: () => "acct",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			showLine,
		});
		expect(showLine).toHaveBeenCalledWith(expect.stringContaining("vi***@***.com: quota ok"));
	});
	it("persists flagged storage before saving active accounts", async () => {
		const calls: string[] = [];
		await runRuntimeAccountCheck(true, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [{ email: "one@example.com", refreshToken: "refresh-1", accessToken: undefined, addedAt: 1, lastUsed: 1 }],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage: () => ({ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} }),
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) => ({ flaggedStorage, removeFromActive: new Set(), storageChanged: false, flaggedChanged: false, ok: 0, errors: 0, disabled: 0 }),
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({ type: "failed", reason: "invalid_grant", message: "refresh failed" }),
			isRuntimeFlaggableFailure: () => true,
			fetchCodexQuotaSnapshot: async () => { throw new Error("should not probe quota in deep mode"); },
			resolveRequestAccountId: () => undefined,
			formatCodexQuotaLine: () => "quota",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => { calls.push("saveAccounts"); }),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => { calls.push("saveFlaggedAccounts"); }),
			showLine: vi.fn(),
		});
		expect(calls).toEqual(["saveFlaggedAccounts", "saveAccounts"]);
	});
});
