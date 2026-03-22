import { describe, expect, it, vi } from "vitest";
import { restoreAccountsFromBackupEntry } from "../lib/storage/restore-backup-entry.js";

describe("restore backup entry", () => {
	it("passes path, options, and injected deps through to the restore helper", async () => {
		const restoredStorage = {
			version: 3,
			accounts: [],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
		const realpath = vi.fn(async (path: string) => path);
		const restoreAccountsFromBackupPath = vi.fn(async (path: string, options) => {
			await options.realpath(path);
			return restoredStorage;
		});
		const loadAccountsFromPath = vi.fn(async () => ({ normalized: null }));
		const saveAccounts = vi.fn(async () => undefined);

		const result = await restoreAccountsFromBackupEntry({
			path: "/tmp/backup.json",
			options: { persist: false },
			restoreAccountsFromBackupPath,
			getNamedBackupRoot: () => "/tmp/backups",
			getStoragePath: () => "/tmp/accounts.json",
			realpath,
			loadAccountsFromPath,
			saveAccounts,
		});

		expect(restoreAccountsFromBackupPath).toHaveBeenCalledWith(
			"/tmp/backup.json",
			expect.objectContaining({
				persist: false,
				backupRoot: "/tmp/backups",
				realpath,
				loadAccountsFromPath,
				saveAccounts,
			}),
		);
		expect(realpath).toHaveBeenCalledWith("/tmp/backup.json");
		expect(result).toEqual(restoredStorage);
	});

	it("keeps windows-style backup paths and realpath wiring intact", async () => {
		const windowsBackupPath = "C:\\codex\\backups\\snapshot.json";
		const windowsBackupRoot = "C:\\codex\\backups";
		const realpath = vi.fn(async (path: string) => path);
		const restoreAccountsFromBackupPath = vi.fn(async (path: string, options) => {
			const resolvedPath = await options.realpath(path);
			return {
				version: 3,
				accounts: [{ email: resolvedPath }],
				activeIndex: 0,
				activeIndexByFamily: {},
			};
		});

		const result = await restoreAccountsFromBackupEntry({
			path: windowsBackupPath,
			options: { persist: true },
			restoreAccountsFromBackupPath,
			getNamedBackupRoot: () => windowsBackupRoot,
			getStoragePath: () => "C:\\codex\\accounts.json",
			realpath,
			loadAccountsFromPath: vi.fn(async () => ({ normalized: null })),
			saveAccounts: vi.fn(async () => undefined),
		});

		expect(restoreAccountsFromBackupPath).toHaveBeenCalledWith(
			windowsBackupPath,
			expect.objectContaining({
				persist: true,
				backupRoot: windowsBackupRoot,
				realpath,
			}),
		);
		expect(realpath).toHaveBeenCalledWith(windowsBackupPath);
		expect(result.accounts).toEqual([{ email: windowsBackupPath }]);
	});
});
