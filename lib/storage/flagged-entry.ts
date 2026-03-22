export { saveFlaggedAccountsEntry } from "./flagged-save-entry.js";

export async function clearFlaggedAccountsEntry(params: {
	path: string;
	withStorageLock: <T>(fn: () => Promise<T>) => Promise<T>;
	markerPath: string;
	getBackupPaths: () => Promise<string[]>;
	clearFlaggedAccountsOnDisk: (args: {
		path: string;
		markerPath: string;
		backupPaths: string[];
		logError: (message: string, details: Record<string, unknown>) => void;
	}) => Promise<void>;
	logError: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	return params.withStorageLock(async () => {
		await params.clearFlaggedAccountsOnDisk({
			path: params.path,
			markerPath: params.markerPath,
			backupPaths: await params.getBackupPaths(),
			logError: params.logError,
		});
	});
}
