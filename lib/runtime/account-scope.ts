export function applyAccountStorageScope<TConfig>(
	pluginConfig: TConfig,
	deps: {
		getPerProjectAccounts: (config: TConfig) => boolean;
		getStorageBackupEnabled: (config: TConfig) => boolean;
		isCodexCliSyncEnabled: () => boolean;
		setStorageBackupEnabled: (enabled: boolean) => void;
		setStoragePath: (path: string | null) => void;
		getCwd: () => string;
		warnPerProjectSyncConflict: () => void;
	},
): void {
	const perProjectAccounts = deps.getPerProjectAccounts(pluginConfig);
	deps.setStorageBackupEnabled(deps.getStorageBackupEnabled(pluginConfig));
	if (deps.isCodexCliSyncEnabled()) {
		if (perProjectAccounts) {
			deps.warnPerProjectSyncConflict();
		}
		deps.setStoragePath(null);
		return;
	}

	deps.setStoragePath(perProjectAccounts ? deps.getCwd() : null);
}
