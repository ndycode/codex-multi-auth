import { describe, expect, it, vi } from "vitest";
import { saveAccountsEntry } from "../lib/storage/account-save-entry.js";

describe("account save entry", () => {
	it("delegates save through the storage lock", async () => {
		const saveUnlocked = vi.fn(async () => undefined);
		await saveAccountsEntry({
			storage: {
				version: 3,
				accounts: [],
				activeIndex: 0,
				activeIndexByFamily: {},
			},
			withStorageLock: async (fn) => fn(),
			saveUnlocked,
		});

		expect(saveUnlocked).toHaveBeenCalledWith({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
	});
});
