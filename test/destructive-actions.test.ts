import { beforeEach, describe, expect, it, vi } from "vitest";

const clearFlaggedAccountsMock = vi.fn();
const clearQuotaCacheMock = vi.fn();
const clearCodexCliStateCacheMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const saveAccountsMock = vi.fn();
const saveFlaggedAccountsMock = vi.fn();
const snapshotAccountStorageMock = vi.fn();
const snapshotAndClearAccountsMock = vi.fn();
const withAccountAndFlaggedStorageTransactionMock = vi.fn();
const getStoragePathMock = vi.fn(() => "/mock/openai-codex-accounts.json");
let transactionCurrentStorage: unknown = null;

vi.mock("../lib/codex-cli/state.js", () => ({
	clearCodexCliStateCache: clearCodexCliStateCacheMock,
}));

vi.mock("../lib/prompts/codex.js", () => ({
	MODEL_FAMILIES: ["codex", "gpt-5.x"] as const,
}));

vi.mock("../lib/quota-cache.js", () => ({
	clearQuotaCache: clearQuotaCacheMock,
}));

vi.mock("../lib/storage.js", () => ({
	clearFlaggedAccounts: clearFlaggedAccountsMock,
	getStoragePath: getStoragePathMock,
	loadFlaggedAccounts: loadFlaggedAccountsMock,
	saveAccounts: saveAccountsMock,
	saveFlaggedAccounts: saveFlaggedAccountsMock,
	snapshotAccountStorage: snapshotAccountStorageMock,
	snapshotAndClearAccounts: snapshotAndClearAccountsMock,
	withAccountAndFlaggedStorageTransaction:
		withAccountAndFlaggedStorageTransactionMock,
}));

describe("destructive actions", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		clearFlaggedAccountsMock.mockResolvedValue(true);
		clearQuotaCacheMock.mockResolvedValue(true);
		loadFlaggedAccountsMock.mockResolvedValue({ version: 1, accounts: [] });
		saveAccountsMock.mockResolvedValue(undefined);
		saveFlaggedAccountsMock.mockResolvedValue(undefined);
		snapshotAccountStorageMock.mockResolvedValue(null);
		snapshotAndClearAccountsMock.mockResolvedValue(true);
		transactionCurrentStorage = null;
		withAccountAndFlaggedStorageTransactionMock.mockImplementation(
			async (handler) => {
				const previousSnapshot = structuredClone(transactionCurrentStorage);
				return handler(
					transactionCurrentStorage,
					async (accountStorage: unknown, flaggedStorage: unknown) => {
						await saveAccountsMock(accountStorage);
						try {
							await saveFlaggedAccountsMock(flaggedStorage);
							transactionCurrentStorage = structuredClone(accountStorage);
						} catch (error) {
							try {
								await saveAccountsMock(previousSnapshot);
								transactionCurrentStorage =
									structuredClone(previousSnapshot);
							} catch (rollbackError) {
								throw new AggregateError(
									[error, rollbackError],
									"Deleting the account partially failed and rollback also failed.",
								);
							}
							throw error;
						}
					},
				);
			},
		);
	});

	it("returns delete-only results without pretending kept data was cleared", async () => {
		const { deleteSavedAccounts } = await import(
			"../lib/destructive-actions.js"
		);

		await expect(deleteSavedAccounts()).resolves.toEqual({
			accountsCleared: true,
			flaggedCleared: false,
			quotaCacheCleared: false,
		});
		expect(snapshotAndClearAccountsMock).toHaveBeenCalledWith(
			"delete-saved-accounts",
		);
		expect(clearFlaggedAccountsMock).not.toHaveBeenCalled();
		expect(clearQuotaCacheMock).not.toHaveBeenCalled();
		expect(clearCodexCliStateCacheMock).not.toHaveBeenCalled();
	});

	it("returns reset results and clears Codex CLI state", async () => {
		snapshotAndClearAccountsMock.mockResolvedValueOnce(true);
		clearFlaggedAccountsMock.mockResolvedValueOnce(false);
		clearQuotaCacheMock.mockResolvedValueOnce(true);

		const { resetLocalState } = await import("../lib/destructive-actions.js");

		await expect(resetLocalState()).resolves.toEqual({
			accountsCleared: true,
			flaggedCleared: false,
			quotaCacheCleared: true,
		});
		expect(snapshotAndClearAccountsMock).toHaveBeenCalledWith(
			"reset-local-state",
		);
		expect(clearFlaggedAccountsMock).toHaveBeenCalledTimes(1);
		expect(clearQuotaCacheMock).toHaveBeenCalledTimes(1);
		expect(clearCodexCliStateCacheMock).toHaveBeenCalledTimes(1);
	});

	it("does not clear Codex CLI state when resetLocalState aborts on an exception", async () => {
		const resetError = Object.assign(new Error("flagged clear failed"), {
			code: "EPERM",
		});
		clearFlaggedAccountsMock.mockRejectedValueOnce(resetError);

		const { resetLocalState } = await import("../lib/destructive-actions.js");

		await expect(resetLocalState()).rejects.toBe(resetError);
		expect(snapshotAndClearAccountsMock).toHaveBeenCalledWith(
			"reset-local-state",
		);
		expect(clearFlaggedAccountsMock).toHaveBeenCalledTimes(1);
		expect(clearQuotaCacheMock).not.toHaveBeenCalled();
		expect(clearCodexCliStateCacheMock).not.toHaveBeenCalled();
	});

	it("re-bases active indices before clamping when deleting an earlier account", async () => {
		const { deleteAccountAtIndex } = await import(
			"../lib/destructive-actions.js"
		);

		const storage = {
			version: 3,
			activeIndex: 1,
			activeIndexByFamily: { codex: 2, "gpt-5.x": 1 },
			accounts: [
				{
					refreshToken: "refresh-remove",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "refresh-active",
					addedAt: 2,
					lastUsed: 2,
				},
				{
					refreshToken: "refresh-other",
					addedAt: 3,
					lastUsed: 3,
				},
			],
		};
		transactionCurrentStorage = structuredClone(storage);

		const deleted = await deleteAccountAtIndex({ storage, index: 0 });

		expect(deleted).not.toBeNull();
		expect(withAccountAndFlaggedStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(snapshotAccountStorageMock).toHaveBeenCalledWith({
			reason: "delete-account",
			storage,
			storagePath: "/mock/openai-codex-accounts.json",
		});
		expect(
			snapshotAccountStorageMock.mock.invocationCallOrder[0],
		).toBeLessThan(
			saveAccountsMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(deleted?.storage.accounts.map((account) => account.refreshToken)).toEqual([
			"refresh-active",
			"refresh-other",
		]);
		expect(deleted?.storage.activeIndex).toBe(0);
		expect(deleted?.storage.activeIndexByFamily).toEqual({
			codex: 1,
			"gpt-5.x": 0,
		});
		expect(saveAccountsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				activeIndex: 0,
				activeIndexByFamily: { codex: 1, "gpt-5.x": 0 },
			}),
		);
	});

	it("reloads flagged storage at delete time so newer flagged entries are preserved", async () => {
		loadFlaggedAccountsMock.mockResolvedValue({
			version: 1,
			accounts: [
				{
					refreshToken: "refresh-remove",
					addedAt: 2,
					lastUsed: 2,
					flaggedAt: 2,
				},
				{
					refreshToken: "refresh-newer",
					addedAt: 3,
					lastUsed: 3,
					flaggedAt: 3,
				},
			],
		});

		const { deleteAccountAtIndex } = await import(
			"../lib/destructive-actions.js"
		);

		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					refreshToken: "refresh-keep",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "refresh-remove",
					addedAt: 2,
					lastUsed: 2,
				},
			],
		};
		transactionCurrentStorage = structuredClone(storage);

		const deleted = await deleteAccountAtIndex({ storage, index: 1 });

		expect(deleted).not.toBeNull();
		expect(withAccountAndFlaggedStorageTransactionMock).toHaveBeenCalledTimes(1);
		expect(deleted?.flagged.accounts).toEqual([
			expect.objectContaining({ refreshToken: "refresh-newer" }),
		]);
		expect(saveFlaggedAccountsMock).toHaveBeenCalledWith({
			version: 1,
			accounts: [expect.objectContaining({ refreshToken: "refresh-newer" })],
		});
	});

	it("rethrows the original flagged-save failure after a successful rollback", async () => {
		const flaggedSaveError = Object.assign(new Error("flagged save failed"), {
			code: "EPERM",
		});
		saveFlaggedAccountsMock.mockRejectedValueOnce(flaggedSaveError);
		loadFlaggedAccountsMock.mockResolvedValue({
			version: 1,
			accounts: [
				{
					refreshToken: "refresh-remove",
					addedAt: 1,
					lastUsed: 1,
					flaggedAt: 1,
				},
			],
		});

		const { deleteAccountAtIndex } = await import(
			"../lib/destructive-actions.js"
		);

		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					refreshToken: "refresh-keep",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "refresh-remove",
					addedAt: 2,
					lastUsed: 2,
				},
			],
		};
		transactionCurrentStorage = structuredClone(storage);

		await expect(deleteAccountAtIndex({ storage, index: 1 })).rejects.toBe(
			flaggedSaveError,
		);
		expect(saveAccountsMock).toHaveBeenCalledTimes(2);
		expect(storage.accounts).toHaveLength(2);
	});

	it("preserves both the flagged-save failure and rollback failure", async () => {
		const flaggedSaveError = Object.assign(new Error("flagged save failed"), {
			code: "EPERM",
		});
		const rollbackError = Object.assign(new Error("rollback failed"), {
			code: "EPERM",
		});
		saveAccountsMock
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(rollbackError);
		saveFlaggedAccountsMock.mockRejectedValueOnce(flaggedSaveError);
		loadFlaggedAccountsMock.mockResolvedValue({
			version: 1,
			accounts: [
				{
					refreshToken: "refresh-remove",
					addedAt: 1,
					lastUsed: 1,
					flaggedAt: 1,
				},
			],
		});

		const { deleteAccountAtIndex } = await import(
			"../lib/destructive-actions.js"
		);

		const storage = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{
					refreshToken: "refresh-keep",
					addedAt: 1,
					lastUsed: 1,
				},
				{
					refreshToken: "refresh-remove",
					addedAt: 2,
					lastUsed: 2,
				},
			],
		};
		transactionCurrentStorage = structuredClone(storage);

		try {
			await deleteAccountAtIndex({ storage, index: 1 });
			throw new Error("expected deleteAccountAtIndex to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			const aggregateError = error as AggregateError;
			expect(aggregateError.message).toBe(
				"Deleting the account partially failed and rollback also failed.",
			);
			expect(aggregateError.errors).toEqual([
				flaggedSaveError,
				rollbackError,
			]);
		}
		expect(saveAccountsMock).toHaveBeenCalledTimes(2);
		expect(storage.accounts).toHaveLength(2);
	});
});
