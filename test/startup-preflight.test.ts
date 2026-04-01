import { describe, expect, it, vi } from "vitest";
import { runStartupAccountPreflight } from "../lib/codex-manager/startup-preflight.js";
import type { CodexQuotaSnapshot } from "../lib/quota-probe.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";
import type { TokenResult } from "../lib/types.js";

function createAccount(
	overrides: Partial<AccountMetadataV3> = {},
): AccountMetadataV3 {
	return {
		refreshToken: "refresh-token-1",
		accessToken: "access-token-1",
		expiresAt: 1_700_000_060_000,
		accountId: "acct_1",
		accountIdSource: "token",
		email: "user@example.com",
		enabled: true,
		addedAt: 1_700_000_000_000,
		lastUsed: 1_699_999_990_000,
		...overrides,
	};
}

function createStorage(
	account: AccountMetadataV3,
	activeIndex = 0,
): AccountStorageV3 {
	return {
		version: 3,
		accounts: [account],
		activeIndex,
		activeIndexByFamily: { codex: activeIndex },
	};
}

function createQuotaSnapshot(
	overrides: Partial<CodexQuotaSnapshot> = {},
): CodexQuotaSnapshot {
	return {
		status: 200,
		model: "gpt-5-codex",
		primary: {
			usedPercent: 35,
			windowMinutes: 300,
			resetAtMs: 1_700_000_300_000,
		},
		secondary: {
			usedPercent: 10,
			windowMinutes: 10_080,
			resetAtMs: 1_700_086_400_000,
		},
		...overrides,
	};
}

describe("startup account preflight", () => {
	it("keeps the current account when live quota is ready and low risk", async () => {
		const account = createAccount();
		const storage = createStorage(account);
		const selectBestAccount = vi.fn<
			({ model, currentIndex }: { model: string; currentIndex: number }) => Promise<{
				ok: boolean;
				switched: boolean;
			}>
		>();

		const result = await runStartupAccountPreflight("gpt-5-codex", {
			loadAccounts: vi.fn().mockResolvedValue(storage),
			saveAccounts: vi.fn().mockResolvedValue(undefined),
			resolveActiveIndex: vi.fn().mockReturnValue(0),
			hasUsableAccessToken: vi.fn().mockReturnValue(true),
			queuedRefresh: vi.fn<
				(refreshToken: string) => Promise<TokenResult>
			>().mockResolvedValue({
				type: "failed",
				reason: "missing_refresh",
				message: "not used",
			}),
			normalizeFailureDetail: vi.fn((message: string | undefined) => message ?? "failure"),
			extractAccountId: vi.fn().mockReturnValue(account.accountId),
			extractAccountEmail: vi.fn().mockReturnValue(account.email),
			sanitizeEmail: vi.fn((email: string | undefined) => email),
			applyTokenAccountIdentity: vi.fn().mockReturnValue(false),
			fetchCodexQuotaSnapshot: vi.fn().mockResolvedValue(createQuotaSnapshot()),
			selectBestAccount,
			getNow: () => 1_700_000_000_000,
		});

		expect(result.currentHealthy).toBe(true);
		expect(result.attemptedBestSelection).toBe(false);
		expect(result.switched).toBe(false);
		expect(result.reason).toBe("current-ready");
		expect(selectBestAccount).not.toHaveBeenCalled();
	});

	it("falls back to best-account selection when the current account is rate-limited", async () => {
		const account = createAccount();
		const storage = createStorage(account);
		const selectBestAccount = vi.fn<
			({ model, currentIndex }: { model: string; currentIndex: number }) => Promise<{
				ok: boolean;
				switched: boolean;
			}>
		>().mockResolvedValue({
			ok: true,
			switched: true,
		});

		const result = await runStartupAccountPreflight("gpt-5-codex", {
			loadAccounts: vi.fn().mockResolvedValue(storage),
			saveAccounts: vi.fn().mockResolvedValue(undefined),
			resolveActiveIndex: vi.fn().mockReturnValue(0),
			hasUsableAccessToken: vi.fn().mockReturnValue(true),
			queuedRefresh: vi.fn<
				(refreshToken: string) => Promise<TokenResult>
			>().mockResolvedValue({
				type: "failed",
				reason: "missing_refresh",
				message: "not used",
			}),
			normalizeFailureDetail: vi.fn((message: string | undefined) => message ?? "failure"),
			extractAccountId: vi.fn().mockReturnValue(account.accountId),
			extractAccountEmail: vi.fn().mockReturnValue(account.email),
			sanitizeEmail: vi.fn((email: string | undefined) => email),
			applyTokenAccountIdentity: vi.fn().mockReturnValue(false),
			fetchCodexQuotaSnapshot: vi.fn().mockResolvedValue(
				createQuotaSnapshot({
					status: 429,
					primary: {
						usedPercent: 100,
						windowMinutes: 300,
						resetAtMs: 1_700_018_000_000,
					},
				}),
			),
			selectBestAccount,
			getNow: () => 1_700_000_000_000,
		});

		expect(result.currentHealthy).toBe(false);
		expect(result.attemptedBestSelection).toBe(true);
		expect(result.switched).toBe(true);
		expect(result.reason).toBe("current-delayed-high");
		expect(selectBestAccount).toHaveBeenCalledWith({
			model: "gpt-5-codex",
			currentIndex: 0,
		});
	});
});
