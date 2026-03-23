export async function exportNamedBackupEntry(params: {
	name: string;
	options?: { force?: boolean };
	exportNamedBackupFile: (
		name: string,
		deps: {
			getStoragePath: () => string;
			exportAccounts: (
				filePath: string,
				force?: boolean,
				beforeCommit?: (resolvedPath: string) => Promise<void> | void,
			) => Promise<void>;
		},
		options?: { force?: boolean },
	) => Promise<string>;
	getStoragePath: () => string;
	exportAccounts: (
		filePath: string,
		force?: boolean,
		beforeCommit?: (resolvedPath: string) => Promise<void> | void,
	) => Promise<void>;
}): Promise<string> {
	return params.exportNamedBackupFile(
		params.name,
		{
			getStoragePath: params.getStoragePath,
			exportAccounts: params.exportAccounts,
		},
		params.options,
	);
}
