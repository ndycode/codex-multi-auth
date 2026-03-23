import { describe, expect, it, vi } from "vitest";
import { exportNamedBackupEntry } from "../lib/storage/named-backup-entry.js";

describe("named backup entry", () => {
	it("passes name, deps, and options through to the named backup exporter", async () => {
		const exportNamedBackupFile = vi.fn(async () => "/tmp/backup.json");
		const exportAccounts = vi.fn(async () => undefined);

		const result = await exportNamedBackupEntry({
			name: "manual-backup",
			options: { force: true },
			exportNamedBackupFile,
			getStoragePath: () => "/tmp/accounts.json",
			exportAccounts,
		});

		expect(exportNamedBackupFile).toHaveBeenCalledWith(
			"manual-backup",
			{
				getStoragePath: expect.any(Function),
				exportAccounts,
			},
			{ force: true },
		);
		expect(result).toBe("/tmp/backup.json");
	});
});
