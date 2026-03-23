import { existsSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { FlaggedAccountStorageV1 } from "../storage.js";

export async function loadFlaggedAccountsState(params: {
	path: string;
	legacyPath: string;
	resetMarkerPath: string;
	normalizeFlaggedStorage: (data: unknown) => FlaggedAccountStorageV1;
	saveFlaggedAccounts: (storage: FlaggedAccountStorageV1) => Promise<void>;
	logError: (message: string, details: Record<string, unknown>) => void;
	logInfo: (message: string, details: Record<string, unknown>) => void;
}): Promise<FlaggedAccountStorageV1> {
	const empty: FlaggedAccountStorageV1 = { version: 1, accounts: [] };

	try {
		const content = await fs.readFile(params.path, "utf-8");
		const data = JSON.parse(content) as unknown;
		const loaded = params.normalizeFlaggedStorage(data);
		if (existsSync(params.resetMarkerPath)) {
			return empty;
		}
		return loaded;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			params.logError("Failed to load flagged account storage", {
				path: params.path,
				error: String(error),
			});
			return empty;
		}
	}

	if (!existsSync(params.legacyPath)) {
		return empty;
	}

	try {
		const legacyContent = await fs.readFile(params.legacyPath, "utf-8");
		const legacyData = JSON.parse(legacyContent) as unknown;
		const migrated = params.normalizeFlaggedStorage(legacyData);
		if (migrated.accounts.length > 0) {
			await params.saveFlaggedAccounts(migrated);
		}
		try {
			await fs.unlink(params.legacyPath);
		} catch {
			// Best effort cleanup.
		}
		params.logInfo("Migrated legacy flagged account storage", {
			from: params.legacyPath,
			to: params.path,
			accounts: migrated.accounts.length,
		});
		return migrated;
	} catch (error) {
		params.logError("Failed to migrate legacy flagged account storage", {
			from: params.legacyPath,
			to: params.path,
			error: String(error),
		});
		return empty;
	}
}

export async function saveFlaggedAccountsUnlockedToDisk(
	storage: FlaggedAccountStorageV1,
	params: {
		path: string;
		markerPath: string;
		normalizeFlaggedStorage: (data: unknown) => FlaggedAccountStorageV1;
		copyFileWithRetry: (
			source: string,
			destination: string,
			options?: { allowMissingSource?: boolean },
		) => Promise<void>;
		renameFileWithRetry: (source: string, destination: string) => Promise<void>;
		logWarn: (message: string, details: Record<string, unknown>) => void;
		logError: (message: string, details: Record<string, unknown>) => void;
	},
): Promise<void> {
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${params.path}.${uniqueSuffix}.tmp`;

	try {
		await fs.mkdir(dirname(params.path), { recursive: true });
		if (existsSync(params.path)) {
			try {
				await params.copyFileWithRetry(params.path, `${params.path}.bak`, {
					allowMissingSource: true,
				});
			} catch (backupError) {
				params.logWarn("Failed to create flagged backup snapshot", {
					path: params.path,
					error: String(backupError),
				});
			}
		}
		const content = JSON.stringify(
			params.normalizeFlaggedStorage(storage),
			null,
			2,
		);
		await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await params.renameFileWithRetry(tempPath, params.path);
		try {
			await fs.unlink(params.markerPath);
		} catch {
			// Best effort cleanup.
		}
	} catch (error) {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Ignore cleanup failures.
		}
		params.logError("Failed to save flagged account storage", {
			path: params.path,
			error: String(error),
		});
		throw error;
	}
}

export async function clearFlaggedAccountsOnDisk(params: {
	path: string;
	markerPath: string;
	backupPaths: string[];
	logError: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	try {
		await fs.writeFile(params.markerPath, "reset", {
			encoding: "utf-8",
			mode: 0o600,
		});
	} catch (error) {
		params.logError("Failed to write flagged reset marker", {
			path: params.path,
			markerPath: params.markerPath,
			error: String(error),
		});
		throw error;
	}
	for (const candidate of [
		params.path,
		...params.backupPaths,
		params.markerPath,
	]) {
		try {
			await fs.unlink(candidate);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				params.logError("Failed to clear flagged account storage", {
					path: candidate,
					error: String(error),
				});
				if (candidate === params.path) {
					throw error;
				}
			}
		}
	}
}
