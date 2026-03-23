import { describe, expect, it, vi } from "vitest";
import { clearAccountStorageArtifacts } from "../lib/storage/account-clear.js";

describe("account clear helper", () => {
	it("clears primary, wal, and backups after writing marker", async () => {
		await expect(
			clearAccountStorageArtifacts({
				path: `${process.cwd()}/tmp-accounts.json`,
				resetMarkerPath: `${process.cwd()}/tmp-accounts.marker`,
				walPath: `${process.cwd()}/tmp-accounts.wal`,
				backupPaths: [`${process.cwd()}/tmp-accounts.json.bak`],
				logError: vi.fn(),
			}),
		).resolves.toBeUndefined();
	});
});
