import { describe, expect, it, vi } from "vitest";
import { clearAccountsEntry } from "../lib/storage/account-clear-entry.js";

describe("account clear entry", () => {
	it("delegates clear through the storage lock and backup resolver", async () => {
		const clearAccountStorageArtifacts = vi.fn(async () => undefined);
		await clearAccountsEntry({
			path: "/tmp/accounts.json",
			withStorageLock: async (fn) => fn(),
			resetMarkerPath: "/tmp/accounts.reset-intent",
			walPath: "/tmp/accounts.wal",
			getBackupPaths: async () => ["/tmp/accounts.json.bak"],
			clearAccountStorageArtifacts,
			logError: vi.fn(),
		});

		expect(clearAccountStorageArtifacts).toHaveBeenCalledWith({
			path: "/tmp/accounts.json",
			resetMarkerPath: "/tmp/accounts.reset-intent",
			walPath: "/tmp/accounts.wal",
			backupPaths: ["/tmp/accounts.json.bak"],
			logError: expect.any(Function),
		});
	});
});
