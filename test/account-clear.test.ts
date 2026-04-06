import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAccountStorageArtifacts } from "../lib/storage/account-clear.js";

describe("account clear helper", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

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

	it.each(["EBUSY", "EPERM"] as const)(
		"retries transient %s errors when clearing required artifacts",
		async (code) => {
			vi.useFakeTimers();
			const unlinkSpy = vi.spyOn(fs, "unlink");
			let attempts = 0;
			unlinkSpy.mockImplementation(async (targetPath) => {
				if (String(targetPath).endsWith("tmp-accounts.json") && attempts < 2) {
					attempts += 1;
					const error = new Error(code) as NodeJS.ErrnoException;
					error.code = code;
					throw error;
				}
				return undefined as never;
			});

			const clearPromise = clearAccountStorageArtifacts({
				path: `${process.cwd()}/tmp-accounts.json`,
				resetMarkerPath: `${process.cwd()}/tmp-accounts.marker`,
				walPath: `${process.cwd()}/tmp-accounts.wal`,
				backupPaths: [],
				logError: vi.fn(),
			});

			await vi.runAllTimersAsync();
			await expect(clearPromise).resolves.toBeUndefined();
			expect(unlinkSpy).toHaveBeenCalled();
		},
	);
});
