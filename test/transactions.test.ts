import { describe, expect, it, vi } from "vitest";
import {
	getTransactionSnapshotState,
	withAccountAndFlaggedStorageTransaction,
	withAccountStorageTransaction,
} from "../lib/storage/transactions.js";
import { cloneAccountStorageForPersistence } from "../lib/storage/account-persistence.js";
import type { AccountStorageV3 } from "../lib/storage.js";

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

	it("forwards loaded flagged storage to handler as third argument", async () => {
		const flagged = {
			version: 1 as const,
			accounts: [{ refreshToken: "flagged-acct" }],
		};
		const loadCurrentFlagged = vi.fn(async () => flagged);

		await withAccountAndFlaggedStorageTransaction(
			async (_current, _persist, currentFlagged) => {
				expect(currentFlagged).toEqual(flagged);
				expect(currentFlagged.accounts).toHaveLength(1);
			},
			{
				getStoragePath: () => "/tmp/accounts.json",
				loadCurrent: async () => null,
				loadCurrentFlagged,
				saveAccounts: async () => undefined,
				saveFlaggedAccounts: async () => undefined,
				cloneAccountStorageForPersistence: (storage) =>
					storage ?? {
						version: 3,
						accounts: [],
						activeIndex: 0,
						activeIndexByFamily: {},
					},
				logRollbackError: vi.fn(),
			},
		);

		expect(loadCurrentFlagged).toHaveBeenCalledTimes(1);
	});

	it("falls back to empty flagged storage when loadCurrentFlagged is omitted", async () => {
		const seen: unknown[] = [];

		await withAccountAndFlaggedStorageTransaction(
			async (_current, _persist, currentFlagged) => {
				seen.push(currentFlagged);
			},
			{
				getStoragePath: () => "/tmp/accounts.json",
				loadCurrent: async () => null,
				saveAccounts: async () => undefined,
				saveFlaggedAccounts: async () => undefined,
				cloneAccountStorageForPersistence: (storage) =>
					storage ?? {
						version: 3,
						accounts: [],
						activeIndex: 0,
						activeIndexByFamily: {},
					},
				logRollbackError: vi.fn(),
			},
		);

		expect(seen).toEqual([{ version: 1, accounts: [] }]);
	});

	it("releases the storage lock when a queued transaction rejects", async () => {
		const order: string[] = [];
		const deps = {
			getStoragePath: () => "/tmp/accounts.json",
			loadCurrent: async () => null,
			saveAccounts: async () => undefined,
		};

		const failing = withAccountStorageTransaction(async () => {
			order.push("failing-start");
			throw new Error("boom");
		}, deps);

		const succeeding = withAccountStorageTransaction(async () => {
			order.push("succeeding-start");
			return "ok";
		}, deps);

		await expect(failing).rejects.toThrow("boom");
		await expect(succeeding).resolves.toBe("ok");
		expect(order).toEqual(["failing-start", "succeeding-start"]);
	});

	it("releases the storage lock when a queued account+flagged transaction rejects", async () => {
		// Mirror of the prior test but for the
		// withAccountAndFlaggedStorageTransaction code path so a future
		// refactor that splits the lock chain between the two helpers can't
		// silently regress only one of them.
		const order: string[] = [];
		const deps = {
			getStoragePath: () => "/tmp/accounts.json",
			loadCurrent: async () => null,
			loadCurrentFlagged: async () => ({ version: 1 as const, accounts: [] }),
			saveAccounts: async () => undefined,
			saveFlaggedAccounts: async () => undefined,
			cloneAccountStorageForPersistence: (
				storage: AccountStorageV3 | null | undefined,
			): AccountStorageV3 =>
				storage ?? {
					version: 3,
					accounts: [],
					activeIndex: 0,
					activeIndexByFamily: {},
				},
			logRollbackError: vi.fn(),
		};

		const failing = withAccountAndFlaggedStorageTransaction(async () => {
			order.push("failing-start");
			throw new Error("boom");
		}, deps);

		const succeeding = withAccountAndFlaggedStorageTransaction(async () => {
			order.push("succeeding-start");
			return "ok" as const;
		}, deps);

		await expect(failing).rejects.toThrow("boom");
		await expect(succeeding).resolves.toBe("ok");
		expect(order).toEqual(["failing-start", "succeeding-start"]);
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

	it("preserves pinnedAccountIndex and affinityGeneration through the combined transaction", async () => {
		// Regression for the clone dropping the manual pin: persisting through the
		// real cloneAccountStorageForPersistence must carry both fields to disk.
		const saved: AccountStorageV3[] = [];
		await withAccountAndFlaggedStorageTransaction(
			async (_current, persist) => {
				await persist(
					{
						version: 3,
						accounts: [{ refreshToken: "new" }],
						activeIndex: 1,
						activeIndexByFamily: { codex: 1 },
						pinnedAccountIndex: 1,
						affinityGeneration: 9,
					},
					{ version: 1, accounts: [] },
				);
			},
			{
				getStoragePath: () => "/tmp/accounts.json",
				loadCurrent: async () => null,
				loadCurrentFlagged: async () => ({ version: 1 as const, accounts: [] }),
				saveAccounts: async (storage) => {
					saved.push(storage);
				},
				saveFlaggedAccounts: async () => undefined,
				cloneAccountStorageForPersistence,
				logRollbackError: vi.fn(),
			},
		);

		expect(saved).toHaveLength(1);
		expect(saved[0]?.pinnedAccountIndex).toBe(1);
		expect(saved[0]?.affinityGeneration).toBe(9);
	});
});
