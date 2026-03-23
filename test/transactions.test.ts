import { describe, expect, it, vi } from "vitest";
import {
	getTransactionSnapshotState,
	withAccountAndFlaggedStorageTransaction,
	withAccountStorageTransaction,
} from "../lib/storage/transactions.js";

describe("storage transaction helpers", () => {
	it("runs account transaction with current snapshot and persist callback", async () => {
		const saved: unknown[] = [];
		const result = await withAccountStorageTransaction(
			async (current, persist) => {
				expect(current?.accounts).toHaveLength(1);
				expect(getTransactionSnapshotState()?.active).toBe(true);
				await persist({
					version: 3,
					accounts: [],
					activeIndex: 0,
					activeIndexByFamily: {},
				});
				return "ok";
			},
			{
				getStoragePath: () => "/tmp/accounts.json",
				loadCurrent: async () => ({
					version: 3,
					accounts: [{ refreshToken: "a" }],
					activeIndex: 0,
					activeIndexByFamily: {},
				}),
				saveAccounts: async (storage) => {
					saved.push(storage);
				},
			},
		);

		expect(result).toBe("ok");
		expect(saved).toHaveLength(1);
	});

	it("rolls back account storage when flagged save fails", async () => {
		const saveAccounts = vi.fn(async () => undefined);
		await expect(
			withAccountAndFlaggedStorageTransaction(
				async (_current, persist) => {
					await persist(
						{
							version: 3,
							accounts: [{ refreshToken: "new" }],
							activeIndex: 0,
							activeIndexByFamily: {},
						},
						{ version: 1, accounts: [] },
					);
					return "ok";
				},
				{
					getStoragePath: () => "/tmp/accounts.json",
					loadCurrent: async () => ({
						version: 3,
						accounts: [{ refreshToken: "old" }],
						activeIndex: 0,
						activeIndexByFamily: {},
					}),
					saveAccounts,
					saveFlaggedAccounts: async () => {
						throw new Error("flagged failed");
					},
					cloneAccountStorageForPersistence: (storage) =>
						storage ?? {
							version: 3,
							accounts: [],
							activeIndex: 0,
							activeIndexByFamily: {},
						},
					logRollbackError: vi.fn(),
				},
			),
		).rejects.toThrow("flagged failed");

		expect(saveAccounts).toHaveBeenCalledTimes(2);
	});
});
