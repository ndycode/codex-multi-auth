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
	it("keeps the stored refresh token when the CLI cache is expired", async () => {
		const saveAccounts = vi.fn(async () => {});
		const queuedRefresh = vi.fn(
			async (refreshToken: string) => ({
				type: "success" as const,
				access: "new-access",
				refresh: "rotated-refresh",
				expires: 70_000,
			}),
		);
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
			lookupCodexCliTokensByEmail: async () => ({ accessToken: "expired-access", refreshToken: "fresh-refresh", expiresAt: 9_999 }),
			extractAccountId: () => undefined,
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh,
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => ({ remaining5h: 1, remaining7d: 2 } as never),
			resolveRequestAccountId: () => "acct",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => 10_000,
			showLine: vi.fn(),
		});
		expect(queuedRefresh).toHaveBeenCalledWith("stale-refresh");
		const saved = saveAccounts.mock.calls[0]?.[0];
		expect(saved.accounts[0]?.refreshToken).toBe("rotated-refresh");
	});

	it("hydrates account state from a valid CLI cache entry without refreshing", async () => {
		const queuedRefresh = vi.fn(async () => ({ type: "failed" as const, reason: "invalid_grant" }));
		const fetchCodexQuotaSnapshot = vi.fn(
			async () => ({ remaining5h: 1, remaining7d: 2 } as never),
		);
		const saveAccounts = vi.fn(async () => {});
		const invalidateAccountManagerCache = vi.fn();
		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "old@example.com",
						refreshToken: "stale-refresh",
						accessToken: undefined,
						accountId: "old-account",
						accountIdSource: "manual",
						addedAt: 1,
						lastUsed: 1,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage: () => ({ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} }),
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: (flaggedStorage) => ({ flaggedStorage, removeFromActive: new Set(), storageChanged: false, flaggedChanged: false, ok: 0, errors: 0, disabled: 0 }),
			lookupCodexCliTokensByEmail: async () => ({
				accessToken: "cached-access",
				refreshToken: "fresh-refresh",
				expiresAt: 70_000,
			}),
			extractAccountId: () => "new-account",
			shouldUpdateAccountIdFromToken: () => true,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => "fresh@example.com",
			queuedRefresh,
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot,
			resolveRequestAccountId: () => "resolved-account",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache,
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => 10_000,
			showLine: vi.fn(),
		});
		expect(queuedRefresh).not.toHaveBeenCalled();
		expect(fetchCodexQuotaSnapshot).toHaveBeenCalledWith({
			accountId: "resolved-account",
			accessToken: "cached-access",
		});
		expect(saveAccounts).toHaveBeenCalledTimes(1);
		expect(invalidateAccountManagerCache).toHaveBeenCalledTimes(1);
		const saved = saveAccounts.mock.calls[0]?.[0];
		expect(saved.accounts[0]).toMatchObject({
			email: "fresh@example.com",
			refreshToken: "fresh-refresh",
			accessToken: "cached-access",
			expiresAt: 70_000,
			accountId: "new-account",
			accountIdSource: "token",
		});
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
	it("keeps flagged accounts durable when saving active accounts fails", async () => {
		const saveFlaggedAccounts = vi.fn(async () => {});
		const saveAccounts = vi.fn(async () => {
			const error = new Error("busy") as Error & { code?: string };
			error.code = "EBUSY";
			throw error;
		});
		await expect(
			runRuntimeAccountCheck(true, {
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
				saveAccounts,
				invalidateAccountManagerCache: vi.fn(),
				saveFlaggedAccounts,
				showLine: vi.fn(),
			}),
		).rejects.toThrow("busy");
		expect(saveFlaggedAccounts).toHaveBeenCalledTimes(1);
		expect(saveAccounts).toHaveBeenCalledTimes(1);
		expect(saveFlaggedAccounts.mock.invocationCallOrder[0]).toBeLessThan(saveAccounts.mock.invocationCallOrder[0]);
	});
});
