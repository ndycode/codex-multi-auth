import { describe, expect, it, vi } from "vitest";
import { runModelsCommand } from "../lib/codex-manager/commands/models.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const storage: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	activeIndexByFamily: { codex: 0 },
	accounts: [
		{
			email: "owner@example.com",
			accountId: "acct_1",
			refreshToken: "refresh",
			addedAt: 1,
			lastUsed: 1,
		},
	],
};

describe("models command", () => {
	it("prints json matrix output", async () => {
		const logInfo = vi.fn();
		const exitCode = await runModelsCommand(
			["--json", "--model", "gpt-5.3-codex"],
			{
				setStoragePath: vi.fn(),
				loadAccounts: async () => storage,
				loadQuotaCache: async () => ({ byAccountId: {}, byEmail: {} }),
				logInfo,
				logError: vi.fn(),
				getNow: () => 123,
			},
		);
		expect(exitCode).toBe(0);
		const payload = JSON.parse(String(logInfo.mock.calls[0]?.[0])) as {
			matrix: { entries: Array<{ accountLabel: string; normalizedModel: string }> };
		};
		expect(payload.matrix.entries[0]).toMatchObject({
			accountLabel: "Account 1",
			normalizedModel: "gpt-5.3-codex",
		});
	});

	it("rejects unknown options", async () => {
		const logError = vi.fn();
		const exitCode = await runModelsCommand(["--bad"], {
			setStoragePath: vi.fn(),
			loadAccounts: async () => storage,
			logInfo: vi.fn(),
			logError,
		});
		expect(exitCode).toBe(1);
		expect(String(logError.mock.calls[0]?.[0])).toContain("Unknown models option");
	});
});

