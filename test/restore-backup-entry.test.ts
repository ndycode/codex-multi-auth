import { describe, expect, it, vi } from "vitest";
import { restoreAccountsFromBackupEntry } from "../lib/storage/restore-backup-entry.js";

describe("restore backup entry", () => {
	it("passes path, options, and injected deps through to the restore helper", async () => {
		const restoreAccountsFromBackupPath = vi.fn(async () => ({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		}));
		const loadAccountsFromPath = vi.fn(async () => ({ normalized: null }));
		const saveAccounts = vi.fn(async () => undefined);

		const result = await restoreAccountsFromBackupEntry({
			path: "/tmp/backup.json",
			options: { persist: false },
			restoreAccountsFromBackupPath,
			getNamedBackupRoot: () => "/tmp/backups",
			getStoragePath: () => "/tmp/accounts.json",
			realpath: vi.fn(async (path) => path),
			loadAccountsFromPath,
			saveAccounts,
		});

		expect(restoreAccountsFromBackupPath).toHaveBeenCalledWith(
			"/tmp/backup.json",
			expect.objectContaining({
				persist: false,
				backupRoot: "/tmp/backups",
				loadAccountsFromPath,
				saveAccounts,
			}),
		);
		expect(result).toEqual({
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		});
	});
});
