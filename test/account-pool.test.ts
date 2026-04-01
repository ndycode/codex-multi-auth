import { describe, expect, it, vi } from "vitest";
import { persistAccountPoolResults } from "../lib/runtime/account-pool.js";

describe("account pool helper", () => {
	it("persists new account results into storage transaction", async () => {
		const persist = vi.fn(async () => undefined);

		await persistAccountPoolResults({
			results: [
				{
					type: "success",
					access: "access-token",
					refresh: "refresh-token",
					expires: 123,
					accountIdOverride: "acct_1",
					accountIdSource: "manual",
					accountLabel: "Primary",
					workspaces: [
						{ id: "acct_1", name: "Primary", enabled: true, isDefault: true },
					],
				},
			],
			replaceAll: false,
			modelFamilies: ["codex"],
			withAccountStorageTransaction: async (handler) => handler(null, persist),
			findMatchingAccountIndex: () => undefined,
			extractAccountId: () => undefined,
			extractAccountEmail: () => "user@example.com",
			sanitizeEmail: (email) => email,
		});

		expect(persist).toHaveBeenCalledWith({
			version: 3,
			accounts: [
				{
					accountId: "acct_1",
					accountIdSource: "manual",
					accountLabel: "Primary",
					email: "user@example.com",
					refreshToken: "refresh-token",
					accessToken: "access-token",
					expiresAt: 123,
					addedAt: expect.any(Number),
					lastUsed: expect.any(Number),
					workspaces: [
						{ id: "acct_1", name: "Primary", enabled: true, isDefault: true },
					],
					currentWorkspaceIndex: 0,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
		});
	});

	it("preserves lastUsed when updating an existing account", async () => {
		const persist = vi.fn(async () => undefined);
		const originalLastUsed = 456;

		await persistAccountPoolResults({
			results: [
				{
					type: "success",
					access: "access-token-next",
					refresh: "refresh-token",
					expires: 999,
				},
			],
			replaceAll: false,
			modelFamilies: ["codex"],
			withAccountStorageTransaction: async (handler) =>
				handler(
					{
						version: 3,
						activeIndex: 0,
						activeIndexByFamily: { codex: 0 },
						accounts: [
							{
								accountId: "acct_1",
								email: "user@example.com",
								refreshToken: "refresh-token",
								accessToken: "access-token-old",
								expiresAt: 123,
								addedAt: 111,
								lastUsed: originalLastUsed,
								enabled: true,
							},
						],
					},
					persist,
				),
			findMatchingAccountIndex: () => 0,
			extractAccountId: () => "acct_1",
			extractAccountEmail: () => "user@example.com",
			sanitizeEmail: (email) => email,
		});

		expect(persist).toHaveBeenCalledWith(
			expect.objectContaining({
				accounts: [
					expect.objectContaining({
						refreshToken: "refresh-token",
						accessToken: "access-token-next",
						expiresAt: 999,
						lastUsed: originalLastUsed,
					}),
				],
			}),
		);
	});
});
