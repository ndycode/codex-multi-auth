import { describe, expect, it, vi } from "vitest";
import {
	clearFlaggedAccountsEntry,
	saveFlaggedAccountsEntry,
} from "../lib/storage/flagged-entry.js";

describe("flagged entry helpers", () => {
	it("delegates save through the storage lock", async () => {
		const saveUnlocked = vi.fn(async () => undefined);
		await saveFlaggedAccountsEntry({
			storage: { version: 1, accounts: [] },
			withStorageLock: async (fn) => fn(),
			saveUnlocked,
		});

		expect(saveUnlocked).toHaveBeenCalledWith({ version: 1, accounts: [] });
	});

	it("delegates clear through the storage lock and backup resolver", async () => {
		const clearFlaggedAccountsOnDisk = vi.fn(async () => undefined);
		await clearFlaggedAccountsEntry({
			path: "/tmp/flagged.json",
			withStorageLock: async (fn) => fn(),
			markerPath: "/tmp/flagged.marker",
			getBackupPaths: async () => ["/tmp/flagged.json.bak"],
			clearFlaggedAccountsOnDisk,
			logError: vi.fn(),
		});

		expect(clearFlaggedAccountsOnDisk).toHaveBeenCalledWith({
			path: "/tmp/flagged.json",
			markerPath: "/tmp/flagged.marker",
			backupPaths: ["/tmp/flagged.json.bak"],
			logError: expect.any(Function),
		});
	});
});
