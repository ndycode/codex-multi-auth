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

	it("returns reset results and clears Codex CLI state", async () => {
		clearAccountsMock.mockResolvedValueOnce(true);
		clearFlaggedAccountsMock.mockResolvedValueOnce(false);
		clearQuotaCacheMock.mockResolvedValueOnce(true);

		const { resetLocalState } = await import("../lib/destructive-actions.js");

		await expect(resetLocalState()).resolves.toEqual({
			accountsCleared: true,
			flaggedCleared: false,
			quotaCacheCleared: true,
		});
		expect(clearAccountsMock).toHaveBeenCalledTimes(1);
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
		expect(clearAccountsMock).toHaveBeenCalledTimes(1);
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

		const deleted = await deleteAccountAtIndex({ storage, index: 0 });

		expect(deleted).not.toBeNull();
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

		const deleted = await deleteAccountAtIndex({ storage, index: 1 });

		expect(deleted).not.toBeNull();
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
