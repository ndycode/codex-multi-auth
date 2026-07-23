import { describe, expect, it, vi } from "vitest";
import { runRuntimeAccountCheck } from "../lib/runtime/account-check.js";
import { CodexUnavailableError } from "../lib/errors.js";
import { CODEX_UNAVAILABLE_PROBE_NOTE } from "../lib/quota-probe.js";

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
			refreshToken: "stale-refresh",
			accessToken: "cached-access",
			expiresAt: 70_000,
			accountId: "new-account",
			accountIdSource: "token",
		});
	});

	it("uses combined persistence when flagging an invalid account removes it from active storage", async () => {
		const persistAccountAndFlaggedStorage = vi.fn(async () => {});
		const saveAccounts = vi.fn(async () => {});
		const saveFlaggedAccounts = vi.fn(async () => {});

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
			saveAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts,
			persistAccountAndFlaggedStorage,
			showLine: vi.fn(),
		});

		expect(persistAccountAndFlaggedStorage).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [],
			}),
			expect.objectContaining({
				version: 1,
				accounts: [expect.objectContaining({ refreshToken: "refresh-1" })],
			}),
		);
		expect(saveAccounts).not.toHaveBeenCalled();
		expect(saveFlaggedAccounts).not.toHaveBeenCalled();
	});

	it("propagates EBUSY from combined persistence without partial writes", async () => {
		const persistAccountAndFlaggedStorage = vi.fn(async () => {
			const error = new Error("busy") as Error & { code?: string };
			error.code = "EBUSY";
			throw error;
		});
		const saveAccounts = vi.fn(async () => {});
		const saveFlaggedAccounts = vi.fn(async () => {});

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
				persistAccountAndFlaggedStorage,
				showLine: vi.fn(),
			}),
		).rejects.toThrow("busy");

		expect(saveAccounts).not.toHaveBeenCalled();
		expect(saveFlaggedAccounts).not.toHaveBeenCalled();
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

	it("treats a codex-unavailable quota probe as a warning, not a hard error", async () => {
		const showLine = vi.fn();
		const state = {
			flaggedStorage: { version: 1 as const, accounts: [] },
			removeFromActive: new Set<string>(),
			storageChanged: false,
			flaggedChanged: false,
			ok: 0,
			errors: 0,
			warnings: 0,
			disabled: 0,
		};
		await runRuntimeAccountCheck(false, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				accounts: [
					{
						email: "nocodex@example.com",
						refreshToken: "fresh-refresh-nocodex",
						accessToken: "usable-access",
						accountId: "nocodex-account",
						accountIdSource: "manual",
						expiresAt: 9_999_999,
						addedAt: 1,
						lastUsed: 1,
						enabled: true,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: { codex: 0 },
			}),
			createEmptyStorage: () => ({ version: 3, accounts: [], activeIndex: 0, activeIndexByFamily: {} }),
			loadFlaggedAccounts: async () => ({ version: 1, accounts: [] }),
			createAccountCheckWorkingState: () => state,
			lookupCodexCliTokensByEmail: async () => null,
			extractAccountId: () => "nocodex-account",
			shouldUpdateAccountIdFromToken: () => false,
			sanitizeEmail: (email) => email,
			extractAccountEmail: () => undefined,
			queuedRefresh: vi.fn(async () => ({ type: "failed" as const, reason: "invalid_grant" })),
			isRuntimeFlaggableFailure: () => false,
			fetchCodexQuotaSnapshot: async () => {
				throw new CodexUnavailableError(
					"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
				);
			},
			resolveRequestAccountId: () => "nocodex-account",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts: vi.fn(async () => {}),
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => 10_000,
			showLine,
		});

		// counted as a warning + ok, not an error
		expect(state.warnings).toBe(1);
		expect(state.errors).toBe(0);
		expect(state.ok).toBe(1);

		const lines = showLine.mock.calls.map((call) => String(call[0]));
		// friendly note is shown without an ERROR prefix or raw JSON
		const noteLine = lines.find((l) => l.includes(CODEX_UNAVAILABLE_PROBE_NOTE));
		expect(noteLine).toBeDefined();
		expect(noteLine).not.toContain("ERROR");
		expect(lines.join("\n")).not.toContain("is not supported when using Codex");
		// summary reflects the warning bucket
		expect(lines.some((l) => /Results:.*1 warning/.test(l))).toBe(true);
	});

	it("re-resolves a manual pin when a lower account is auto-removed on deep probe", async () => {
		const now = 10_000;
		const saveAccounts = vi.fn(async () => {});
		// Account 0 has no cached access and its refresh fails flaggably, so the
		// deep-probe auto-removal drops it. The pin points at account 2 and must
		// follow that account by identity (now index 1) rather than keep its stale
		// slot — otherwise the pin silently routes to the wrong account (#474).
		await runRuntimeAccountCheck(true, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				pinnedAccountIndex: 2,
				accounts: [
					{ email: "a@example.com", accountId: "acc_a", refreshToken: "r0", accessToken: undefined, addedAt: 1, lastUsed: 1 },
					{ email: "b@example.com", accountId: "acc_b", refreshToken: "r1", accessToken: "a1", expiresAt: now + 3_600_000, addedAt: 1, lastUsed: 1 },
					{ email: "c@example.com", accountId: "acc_c", refreshToken: "r2", accessToken: "a2", expiresAt: now + 3_600_000, addedAt: 1, lastUsed: 1 },
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
			queuedRefresh: async () => ({ type: "failed" as const, reason: "invalid_grant", message: "token has been revoked" }),
			isRuntimeFlaggableFailure: () => true,
			fetchCodexQuotaSnapshot: async () => ({ remaining5h: 1, remaining7d: 2 } as never),
			resolveRequestAccountId: () => "acct",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => now,
			showLine: vi.fn(),
		});

		const saved = saveAccounts.mock.calls[0]?.[0];
		expect(saved.accounts.map((entry) => entry.refreshToken)).toEqual([
			"r1",
			"r2",
		]);
		expect(saved.pinnedAccountIndex).toBe(1);
	});

	it("clears a manual pin when the pinned account itself is auto-removed on deep probe", async () => {
		const now = 10_000;
		const saveAccounts = vi.fn(async () => {});
		// The pinned account (index 2) is the one with no cached access whose
		// refresh fails flaggably, so the deep-probe auto-removal drops it. The pin
		// has nothing left to follow and must be cleared instead of dangling at a
		// stale slot that now belongs to a different account (#474). This also pins
		// the ordering in account-check.ts: the pinned account has to be captured
		// BEFORE the filter runs, or it could never be resolved at all.
		await runRuntimeAccountCheck(true, {
			hydrateEmails: async (storage) => storage,
			loadAccounts: async () => ({
				version: 3,
				pinnedAccountIndex: 2,
				accounts: [
					{ email: "a@example.com", accountId: "acc_a", refreshToken: "r0", accessToken: "a0", expiresAt: now + 3_600_000, addedAt: 1, lastUsed: 1 },
					{ email: "b@example.com", accountId: "acc_b", refreshToken: "r1", accessToken: "a1", expiresAt: now + 3_600_000, addedAt: 1, lastUsed: 1 },
					{ email: "c@example.com", accountId: "acc_c", refreshToken: "r2", accessToken: undefined, addedAt: 1, lastUsed: 1 },
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
			queuedRefresh: async () => ({ type: "failed" as const, reason: "invalid_grant", message: "token has been revoked" }),
			isRuntimeFlaggableFailure: () => true,
			fetchCodexQuotaSnapshot: async () => ({ remaining5h: 1, remaining7d: 2 } as never),
			resolveRequestAccountId: () => "acct",
			formatCodexQuotaLine: () => "quota ok",
			clampRuntimeActiveIndices: vi.fn(),
			MODEL_FAMILIES: ["codex"],
			saveAccounts,
			invalidateAccountManagerCache: vi.fn(),
			saveFlaggedAccounts: vi.fn(async () => {}),
			now: () => now,
			showLine: vi.fn(),
		});

		const saved = saveAccounts.mock.calls[0]?.[0];
		expect(saved.accounts.map((entry) => entry.refreshToken)).toEqual([
			"r0",
			"r1",
		]);
		expect(saved.pinnedAccountIndex).toBeUndefined();
	});
});
