import { describe, expect, it, vi } from "vitest";
import { getNamedBackupsEntry } from "../lib/storage/named-backups-entry.js";

describe("named backups entry", () => {
	it("delegates to collectNamedBackups with resolved storage path and deps", async () => {
		const collectNamedBackups = vi.fn(async () => [
			{
				path: "/tmp/backup.json",
				fileName: "backup.json",
				accountCount: 1,
				mtimeMs: 1,
			},
		]);
		const loadAccountsFromPath = vi.fn(async () => ({
			normalized: { accounts: [] },
		}));
		const logDebug = vi.fn();

		const result = await getNamedBackupsEntry({
			getStoragePath: () => "/tmp/accounts.json",
			collectNamedBackups,
			loadAccountsFromPath,
			logDebug,
		});

		expect(collectNamedBackups).toHaveBeenCalledWith("/tmp/accounts.json", {
			loadAccountsFromPath,
			logDebug,
		});
		expect(result).toEqual([
			{
				path: "/tmp/backup.json",
				fileName: "backup.json",
				accountCount: 1,
				mtimeMs: 1,
			},
		]);
	});
});
