import type { NamedBackupSummary } from "../storage.js";

export async function getNamedBackupsEntry(params: {
	getStoragePath: () => string;
	collectNamedBackups: (
		storagePath: string,
		deps: {
			loadAccountsFromPath: (
				path: string,
			) => Promise<{ normalized: { accounts: unknown[] } | null }>;
			logDebug: (message: string, details: Record<string, unknown>) => void;
		},
	) => Promise<NamedBackupSummary[]>;
	loadAccountsFromPath: (
		path: string,
	) => Promise<{ normalized: { accounts: unknown[] } | null }>;
	logDebug: (message: string, details: Record<string, unknown>) => void;
}): Promise<NamedBackupSummary[]> {
	return params.collectNamedBackups(params.getStoragePath(), {
		loadAccountsFromPath: params.loadAccountsFromPath,
		logDebug: params.logDebug,
	});
}
