import { describe, expect, it, vi } from "vitest";
import { saveAccountsToDisk } from "../lib/storage/account-save.js";

function createStorage(): {
	version: 3;
	accounts: Array<{ refreshToken: string }>;
	activeIndex: number;
	activeIndexByFamily: Record<string, number>;
} {
	return {
		version: 3,
		accounts: [{ refreshToken: "rt-1" }],
		activeIndex: 0,
		activeIndexByFamily: {},
	};
}

function createParams(overrides?: Partial<Parameters<typeof saveAccountsToDisk>[1]>) {
	return {
		path: "/tmp/accounts.json",
		resetMarkerPath: "/tmp/accounts.reset",
		walPath: "/tmp/accounts.wal",
		storageBackupEnabled: false,
		ensureDirectory: vi.fn(async () => undefined),
		ensureGitignore: vi.fn(async () => undefined),
		looksLikeSyntheticFixtureStorage: vi.fn(() => true),
		loadExistingStorage: vi.fn(async () => null),
		createSyntheticFixtureError: vi.fn(() => new Error("synthetic fixture refusal")),
		createRotatingAccountsBackup: vi.fn(async () => undefined),
		computeSha256: vi.fn(() => "hash"),
		writeJournal: vi.fn(async () => undefined),
		writeTemp: vi.fn(async () => undefined),
		statTemp: vi.fn(async () => ({ size: 10 })),
		renameTempToPath: vi.fn(async () => undefined),
		cleanupResetMarker: vi.fn(async () => undefined),
		cleanupWal: vi.fn(async () => undefined),
		cleanupTemp: vi.fn(async () => undefined),
		onSaved: vi.fn(() => undefined),
		logWarn: vi.fn(() => undefined),
		logError: vi.fn(() => undefined),
		createStorageError: vi.fn((error) => error as Error),
		backupPath: "/tmp/accounts.backup",
		createTempPath: vi.fn(() => "/tmp/accounts.tmp"),
		...overrides,
	};
}

describe("account save helper", () => {
	it("rethrows probe failures through createStorageError", async () => {
		const probeError = new Error("Failed to read storage file");
		const params = createParams({
			loadExistingStorage: vi.fn(async () => {
				throw probeError;
			}),
		});

		await expect(saveAccountsToDisk(createStorage() as never, params)).rejects.toBe(
			probeError,
		);
		expect(params.createSyntheticFixtureError).not.toHaveBeenCalled();
		expect(params.createStorageError).toHaveBeenCalledWith(probeError);
		expect(params.writeJournal).not.toHaveBeenCalled();
	});

	it("refuses to overwrite live storage with a synthetic fixture payload", async () => {
		const refusalError = new Error("synthetic fixture refusal");
		const params = createParams({
			loadExistingStorage: vi.fn(async () => createStorage() as never),
			looksLikeSyntheticFixtureStorage: vi
				.fn()
				.mockReturnValueOnce(true)
				.mockReturnValueOnce(false),
			createSyntheticFixtureError: vi.fn(() => refusalError),
		});

		await expect(saveAccountsToDisk(createStorage() as never, params)).rejects.toBe(
			refusalError,
		);
		expect(params.createSyntheticFixtureError).toHaveBeenCalledOnce();
		expect(params.createStorageError).toHaveBeenCalledWith(refusalError);
		expect(params.writeJournal).not.toHaveBeenCalled();
	});
});
