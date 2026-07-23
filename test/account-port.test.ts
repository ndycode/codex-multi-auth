import { describe, expect, it, vi } from "vitest";
import {
	exportAccountsSnapshot,
	importAccountsSnapshot,
} from "../lib/storage/account-port.js";

describe("account port helpers", () => {
	it("exports transaction snapshot when active for the current storage path", async () => {
		const exportAccountsToFile = vi.fn(async () => undefined);
		const snapshot = {
			version: 3 as const,
			accounts: [{ refreshToken: "snapshot-token" }],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		const readCurrentStorageUnlocked = vi.fn();
		const readCurrentStorage = vi.fn();

		await exportAccountsSnapshot({
			resolvedPath: "/tmp/out.json",
			force: true,
			currentStoragePath: "/tmp/accounts.json",
			transactionState: {
				active: true,
				storagePath: "/tmp/accounts.json",
				snapshot,
			},
			readCurrentStorageUnlocked,
			readCurrentStorage,
			exportAccountsToFile,
			logInfo: vi.fn(),
		});
		expect(readCurrentStorageUnlocked).not.toHaveBeenCalled();
		expect(readCurrentStorage).not.toHaveBeenCalled();
		expect(exportAccountsToFile).toHaveBeenCalledWith(
			expect.objectContaining({
				storage: snapshot,
			}),
		);
	});

	it("reads current storage without reusing a stale transaction snapshot from another path", async () => {
		const exportAccountsToFile = vi.fn(async () => undefined);
		const readCurrentStorageUnlocked = vi.fn(async () => ({
			version: 3 as const,
			accounts: [{ refreshToken: "live-token" }],
			activeIndex: 0,
			activeIndexByFamily: {},
		}));
		const readCurrentStorage = vi.fn();

		await exportAccountsSnapshot({
			resolvedPath: "/tmp/out.json",
			force: true,
			currentStoragePath: "/tmp/accounts.json",
			transactionState: {
				active: true,
				storagePath: "/tmp/other.json",
				snapshot: {
					version: 3,
					accounts: [{ refreshToken: "stale-token" }],
					activeIndex: 0,
					activeIndexByFamily: {},
				},
			},
			readCurrentStorageUnlocked,
			readCurrentStorage,
			exportAccountsToFile,
			logInfo: vi.fn(),
		});

		expect(readCurrentStorageUnlocked).toHaveBeenCalledTimes(1);
		expect(readCurrentStorage).not.toHaveBeenCalled();
		expect(exportAccountsToFile).toHaveBeenCalledWith(
			expect.objectContaining({
				storage: expect.objectContaining({
					accounts: [{ refreshToken: "live-token" }],
				}),
			}),
		);
	});

	it("reads current storage via the locked reader when no transaction is active", async () => {
		const exportAccountsToFile = vi.fn(async () => undefined);
		const readCurrentStorageUnlocked = vi.fn();
		const readCurrentStorage = vi.fn(async () => ({
			version: 3 as const,
			accounts: [{ refreshToken: "locked-read-token" }],
			activeIndex: 0,
			activeIndexByFamily: {},
		}));

		await exportAccountsSnapshot({
			resolvedPath: "/tmp/out.json",
			force: true,
			currentStoragePath: "/tmp/accounts.json",
			transactionState: undefined,
			readCurrentStorageUnlocked,
			readCurrentStorage,
			exportAccountsToFile,
			logInfo: vi.fn(),
		});

		expect(readCurrentStorageUnlocked).not.toHaveBeenCalled();
		expect(readCurrentStorage).toHaveBeenCalledTimes(1);
		expect(exportAccountsToFile).toHaveBeenCalledWith(
			expect.objectContaining({
				storage: expect.objectContaining({
					accounts: [{ refreshToken: "locked-read-token" }],
				}),
			}),
		);
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
			findMatchingAccountIndex: () => undefined,
			logInfo: vi.fn(),
		});
		expect(result).toEqual({ imported: 1, total: 1, skipped: 0 });
	});
});
