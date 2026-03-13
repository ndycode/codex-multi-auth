import { beforeEach, describe, expect, it, vi } from "vitest";

const clearAccountsMock = vi.fn();
const clearFlaggedAccountsMock = vi.fn();
const clearQuotaCacheMock = vi.fn();
const clearCodexCliStateCacheMock = vi.fn();
const loadFlaggedAccountsMock = vi.fn();
const saveAccountsMock = vi.fn();
const saveFlaggedAccountsMock = vi.fn();

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
	clearAccounts: clearAccountsMock,
	clearFlaggedAccounts: clearFlaggedAccountsMock,
	loadFlaggedAccounts: loadFlaggedAccountsMock,
	saveAccounts: saveAccountsMock,
	saveFlaggedAccounts: saveFlaggedAccountsMock,
}));

describe("destructive actions", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		clearAccountsMock.mockResolvedValue(true);
		clearFlaggedAccountsMock.mockResolvedValue(true);
		clearQuotaCacheMock.mockResolvedValue(true);
		loadFlaggedAccountsMock.mockResolvedValue({ version: 1, accounts: [] });
		saveAccountsMock.mockResolvedValue(undefined);
		saveFlaggedAccountsMock.mockResolvedValue(undefined);
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
		expect(clearAccountsMock).toHaveBeenCalledTimes(1);
		expect(clearFlaggedAccountsMock).not.toHaveBeenCalled();
		expect(clearQuotaCacheMock).not.toHaveBeenCalled();
		expect(clearCodexCliStateCacheMock).not.toHaveBeenCalled();
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
