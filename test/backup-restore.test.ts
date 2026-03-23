import { describe, expect, it, vi } from "vitest";
import { restoreAccountsFromBackupPath } from "../lib/storage/backup-restore.js";
import type { AccountStorageV3 } from "../lib/storage.js";

describe("backup restore helper", () => {
	it("rejects backup paths outside the backup root", async () => {
		await expect(
			restoreAccountsFromBackupPath("/outside/backup.json", {
				backupRoot: "/backups",
				realpath: async (path) => path,
				loadAccountsFromPath: async () => ({ normalized: null }),
				saveAccounts: vi.fn(async () => undefined),
			}),
		).rejects.toThrow("Backup path must stay inside /backups");
	});

	it("returns normalized storage and persists by default", async () => {
		const normalized: AccountStorageV3 = {
			version: 3,
			accounts: [{ refreshToken: "a" }] as AccountStorageV3["accounts"],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		const saveAccounts = vi.fn(async () => undefined);

		const result = await restoreAccountsFromBackupPath("/backups/good.json", {
			backupRoot: "/backups",
			realpath: async (path) => path,
			loadAccountsFromPath: async () => ({ normalized }),
			saveAccounts,
		});

		expect(result).toBe(normalized);
		expect(saveAccounts).toHaveBeenCalledWith(normalized);
	});

	it("skips persistence when persist is false and rejects empty backups", async () => {
		const saveAccounts = vi.fn(async () => undefined);

		await expect(
			restoreAccountsFromBackupPath("/backups/empty.json", {
				persist: false,
				backupRoot: "/backups",
				realpath: async (path) => path,
				loadAccountsFromPath: async () => ({
					normalized: {
						version: 3,
						accounts: [],
						activeIndex: 0,
						activeIndexByFamily: {},
					},
				}),
				saveAccounts,
			}),
		).rejects.toThrow("Backup does not contain any accounts");

		expect(saveAccounts).not.toHaveBeenCalled();
	});
});
