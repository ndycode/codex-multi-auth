export async function clearAccountsEntry(params: {
	path: string;
	withStorageLock: <T>(fn: () => Promise<T>) => Promise<T>;
	resetMarkerPath: string;
	walPath: string;
	getBackupPaths: () => Promise<string[]>;
	clearAccountStorageArtifacts: (args: {
		path: string;
		resetMarkerPath: string;
		walPath: string;
		backupPaths: string[];
		logError: (message: string, details: Record<string, unknown>) => void;
	}) => Promise<void>;
	logError: (message: string, details: Record<string, unknown>) => void;
}): Promise<void> {
	return params.withStorageLock(async () => {
		await params.clearAccountStorageArtifacts({
			path: params.path,
			resetMarkerPath: params.resetMarkerPath,
			walPath: params.walPath,
			backupPaths: await params.getBackupPaths(),
			logError: params.logError,
		});
	});
}
