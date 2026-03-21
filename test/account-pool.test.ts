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
});
