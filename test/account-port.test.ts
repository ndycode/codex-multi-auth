import { describe, expect, it, vi } from "vitest";
import {
	clearFlaggedAccountsEntry,
	exportAccountsSnapshot,
	importAccountsSnapshot,
	saveFlaggedAccountsEntry,
} from "../lib/storage/account-port.js";

describe("account port helpers", () => {
	it("delegates flagged save through storage lock", async () => {
		const saveUnlocked = vi.fn(async () => undefined);
		await saveFlaggedAccountsEntry({
			storage: { version: 1, accounts: [] },
			withStorageLock: async (fn) => fn(),
			saveUnlocked,
		});
		expect(saveUnlocked).toHaveBeenCalled();
	});

	it("delegates flagged clear through storage lock", async () => {
		const clearFlaggedAccountsOnDisk = vi.fn(async () => undefined);
		await clearFlaggedAccountsEntry({
			path: "/tmp/flagged.json",
			withStorageLock: async (fn) => fn(),
			markerPath: "/tmp/flagged.reset",
			getBackupPaths: async () => ["/tmp/flagged.json.bak"],
			clearFlaggedAccountsOnDisk,
			logError: vi.fn(),
		});
		expect(clearFlaggedAccountsOnDisk).toHaveBeenCalled();
	});

	it("exports transaction snapshot when active", async () => {
		const exportAccountsToFile = vi.fn(async () => undefined);
		await exportAccountsSnapshot({
			resolvedPath: "/tmp/out.json",
			force: true,
			currentStoragePath: "/tmp/accounts.json",
			transactionState: {
				active: true,
				storagePath: "/tmp/accounts.json",
				snapshot: {
					version: 3,
					accounts: [],
					activeIndex: 0,
					activeIndexByFamily: {},
				},
			},
			loadAccountsInternal: vi.fn(),
			readCurrentStorage: vi.fn(),
			exportAccountsToFile,
			logInfo: vi.fn(),
		});
		expect(exportAccountsToFile).toHaveBeenCalled();
	});

	it("imports through transaction helper and logs result", async () => {
		const result = await importAccountsSnapshot({
			resolvedPath: "/tmp/in.json",
			readImportFile: async () => ({
				version: 3,
				accounts: [{ refreshToken: "a" }],
				activeIndex: 0,
				activeIndexByFamily: {},
			}),
			normalizeAccountStorage: vi.fn(),
			withAccountStorageTransaction: async (handler) =>
				handler(null, async () => undefined),
			mergeImportedAccounts: () => ({
				newStorage: {
					version: 3,
					accounts: [{ refreshToken: "a" }],
					activeIndex: 0,
					activeIndexByFamily: {},
				},
				imported: 1,
				total: 1,
				skipped: 0,
			}),
			maxAccounts: 10,
			deduplicateAccounts: (accounts) => accounts,
			logInfo: vi.fn(),
		});
		expect(result).toEqual({ imported: 1, total: 1, skipped: 0 });
	});
});
