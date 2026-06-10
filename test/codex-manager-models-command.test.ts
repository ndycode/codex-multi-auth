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

	it("prints usage for --help without loading accounts", async () => {
		const logInfo = vi.fn();
		const loadAccounts = vi.fn(async () => storage);
		const exitCode = await runModelsCommand(["--help"], {
			setStoragePath: vi.fn(),
			loadAccounts,
			logInfo,
			logError: vi.fn(),
		});
		expect(exitCode).toBe(0);
		expect(loadAccounts).not.toHaveBeenCalled();
		expect(String(logInfo.mock.calls[0]?.[0])).toContain(
			"codex-multi-auth models [--json] [--model <model>]",
		);
	});

	it("rejects --model with a missing, empty, or flag-like value", async () => {
		const run = async (args: string[]) => {
			const logError = vi.fn();
			const exitCode = await runModelsCommand(args, {
				setStoragePath: vi.fn(),
				loadAccounts: async () => storage,
				logInfo: vi.fn(),
				logError,
			});
			return { exitCode, message: String(logError.mock.calls[0]?.[0]) };
		};

		for (const args of [["--model"], ["--model", "--json"], ["--model="]]) {
			const { exitCode, message } = await run(args);
			expect(exitCode).toBe(1);
			expect(message).toContain("Missing value for --model");
		}
	});

	it("prints per-account availability lines in text mode", async () => {
		const logInfo = vi.fn();
		const exitCode = await runModelsCommand(["--model", "gpt-5.3-codex"], {
			setStoragePath: vi.fn(),
			loadAccounts: async () => storage,
			loadQuotaCache: async () => ({ byAccountId: {}, byEmail: {} }),
			logInfo,
			logError: vi.fn(),
			getNow: () => 123,
		});
		expect(exitCode).toBe(0);
		expect(String(logInfo.mock.calls[0]?.[0])).toBe(
			"Account 1 gpt-5.3-codex: available",
		);
	});

	it("marks disabled accounts unavailable with the reason list", async () => {
		const disabledStorage: AccountStorageV3 = {
			...storage,
			accounts: [{ ...storage.accounts[0]!, enabled: false }],
		};
		const logInfo = vi.fn();
		const exitCode = await runModelsCommand(["--model", "gpt-5.3-codex"], {
			setStoragePath: vi.fn(),
			loadAccounts: async () => disabledStorage,
			loadQuotaCache: async () => ({ byAccountId: {}, byEmail: {} }),
			logInfo,
			logError: vi.fn(),
			getNow: () => 123,
		});
		expect(exitCode).toBe(0);
		expect(String(logInfo.mock.calls[0]?.[0])).toBe(
			"Account 1 gpt-5.3-codex: unavailable (account disabled)",
		);
	});

	it("reports empty matrices and survives quota cache load failures", async () => {
		const logInfo = vi.fn();
		const exitCode = await runModelsCommand([], {
			setStoragePath: vi.fn(),
			loadAccounts: async () => null,
			loadQuotaCache: async () => {
				throw new Error("quota cache unreadable");
			},
			logInfo,
			logError: vi.fn(),
			getNow: () => 123,
		});
		expect(exitCode).toBe(0);
		expect(String(logInfo.mock.calls[0]?.[0])).toBe("No accounts configured.");
	});
});

