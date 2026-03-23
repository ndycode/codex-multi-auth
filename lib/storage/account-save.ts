import type { AccountStorageV3 } from "../storage.js";

export async function saveAccountsToDisk(
	storage: AccountStorageV3,
	params: {
		path: string;
		resetMarkerPath: string;
		walPath: string;
		storageBackupEnabled: boolean;
		ensureDirectory: () => Promise<void>;
		ensureGitignore: () => Promise<void>;
		looksLikeSyntheticFixtureStorage: (
			storage: AccountStorageV3 | null,
		) => boolean;
		loadExistingStorage: () => Promise<AccountStorageV3 | null>;
		createSyntheticFixtureError: () => Error;
		createRotatingAccountsBackup: (path: string) => Promise<void>;
		computeSha256: (value: string) => string;
		writeJournal: (content: string, path: string) => Promise<void>;
		writeTemp: (tempPath: string, content: string) => Promise<void>;
		statTemp: (tempPath: string) => Promise<{ size: number }>;
		renameTempToPath: (tempPath: string) => Promise<void>;
		cleanupResetMarker: () => Promise<void>;
		cleanupWal: () => Promise<void>;
		cleanupTemp: (tempPath: string) => Promise<void>;
		onSaved: () => void;
		logWarn: (message: string, details: Record<string, unknown>) => void;
		logError: (message: string, details: Record<string, unknown>) => void;
		createStorageError: (error: unknown) => Error;
		backupPath: string;
		createTempPath: () => string;
	},
): Promise<void> {
	const tempPath = params.createTempPath();
	try {
		await params.ensureDirectory();
		await params.ensureGitignore();

		if (params.looksLikeSyntheticFixtureStorage(storage)) {
			try {
				const existing = await params.loadExistingStorage();
				if (
					existing &&
					existing.accounts.length > 0 &&
					!params.looksLikeSyntheticFixtureStorage(existing)
				) {
					throw params.createSyntheticFixtureError();
				}
			} catch (error) {
				if (error instanceof Error && error.message.includes("synthetic")) {
					throw error;
				}
			}
		}

		if (params.storageBackupEnabled) {
			try {
				await params.createRotatingAccountsBackup(params.path);
			} catch (backupError) {
				params.logWarn("Failed to create account storage backup", {
					path: params.path,
					backupPath: params.backupPath,
					error: String(backupError),
				});
			}
		}

		const content = JSON.stringify(storage, null, 2);
		await params.writeJournal(content, params.path);
		await params.writeTemp(tempPath, content);

		const stats = await params.statTemp(tempPath);
		if (stats.size === 0) {
			throw Object.assign(new Error("File written but size is 0"), {
				code: "EEMPTY",
			});
		}

		await params.renameTempToPath(tempPath);
		await params.cleanupResetMarker();
		params.onSaved();
		await params.cleanupWal();
	} catch (error) {
		await params.cleanupTemp(tempPath);
		params.logError("Failed to save accounts", {
			path: params.path,
			error: String(error),
		});
		throw params.createStorageError(error);
	}
}
