import { describe, expect, it, vi } from "vitest";
import { saveFlaggedAccountsEntry } from "../lib/storage/flagged-save-entry.js";

describe("flagged save entry", () => {
	it("delegates save through the storage lock", async () => {
		const saveUnlocked = vi.fn(async () => undefined);
		await saveFlaggedAccountsEntry({
			storage: { version: 1, accounts: [] },
			withStorageLock: async (fn) => fn(),
			saveUnlocked,
		});

		expect(saveUnlocked).toHaveBeenCalledWith({ version: 1, accounts: [] });
	});
});
