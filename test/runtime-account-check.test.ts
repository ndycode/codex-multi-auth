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
	it("promotes a newer cached refresh token even when cached access is expired", async () => {
		const saveAccounts = vi.fn(async () => {});
		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [{ email: "one@example.com", refreshToken: "stale-refresh", accessToken: undefined, addedAt: 1, lastUsed: 1 }],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage: () => ({ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} }),
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) => ({ flaggedStorage, removeFromActive: new Set(), storageChanged: false, flaggedChanged: false, ok: 0, errors: 0, disabled: 0 }),
			lookupCodexCliTokensByEmail: async () => ({ accessToken: "expired-access", refreshToken: "fresh-refresh", expiresAt: Date.now() - 1 }),
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async (refreshToken) => ({ type: "success", access: "new-access", refresh: refreshToken, expires: Date.now() + 60_000 }),
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => ({ remaining5h: 1, remaining7d: 2 } as never),
			resolveRequestAccountId: () => "acct",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			showLine: vi.fn(),
		});
		const saved = saveAccounts.mock.calls[0]?.[0];
		expect(saved.accounts[0]?.refreshToken).toBe("fresh-refresh");
	});

	it("treats cache lookup failures as a cache miss and still refreshes", async () => {
		const saveAccounts = vi.fn(async () => {});
		await runRuntimeAccountCheck(false, {
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
			lookupCodexCliTokensByEmail: async () => { throw new Error("busy"); },
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: async () => ({ type: "success", access: "new-access", refresh: "refresh-1", expires: Date.now() + 60_000 }),
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => ({ remaining5h: 1, remaining7d: 2 } as never),
			resolveRequestAccountId: () => "acct",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			showLine: vi.fn(),
		});
		expect(saveAccounts).toHaveBeenCalledTimes(1);
	});
});
