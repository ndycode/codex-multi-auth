import { describe, expect, it, vi } from "vitest";
import {
	clearFlaggedAccountsOnDisk,
	loadFlaggedAccountsState,
	saveFlaggedAccountsUnlockedToDisk,
} from "../lib/storage/flagged-storage-io.js";

describe("flagged storage io helpers", () => {
	it("returns empty storage when files are missing", async () => {
		const result = await loadFlaggedAccountsState({
			path: "/tmp/flagged.json",
			legacyPath: "/tmp/legacy.json",
			resetMarkerPath: "/tmp/reset",
			normalizeFlaggedStorage: () => ({
				version: 1,
				accounts: [{ refreshToken: "x" }],
			}),
			saveFlaggedAccounts: vi.fn(),
			logError: vi.fn(),
			logInfo: vi.fn(),
		});

		expect(result).toEqual({ version: 1, accounts: [] });
	});

	it("writes flagged storage using injected helpers", async () => {
		const copyFileWithRetry = vi.fn(async () => undefined);
		const renameFileWithRetry = vi.fn(async () => undefined);
		await saveFlaggedAccountsUnlockedToDisk(
			{ version: 1, accounts: [] },
			{
				path: `${process.cwd()}/tmp-flagged.json`,
				markerPath: `${process.cwd()}/tmp-flagged.marker`,
				normalizeFlaggedStorage: (data) => data as never,
				copyFileWithRetry,
				renameFileWithRetry,
				logWarn: vi.fn(),
				logError: vi.fn(),
			},
		);

		expect(renameFileWithRetry).toHaveBeenCalled();
		expect(copyFileWithRetry).not.toThrow;
	});

	it("clears flagged account files with best-effort backup cleanup", async () => {
		await expect(
			clearFlaggedAccountsOnDisk({
				path: `${process.cwd()}/tmp-flagged.json`,
				markerPath: `${process.cwd()}/tmp-flagged.marker`,
				backupPaths: [`${process.cwd()}/tmp-flagged.json.bak`],
				logError: vi.fn(),
			}),
		).resolves.toBeUndefined();
	});
});
