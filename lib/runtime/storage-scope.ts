export function applyAccountStorageScopeFromConfig(
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>,
	deps: {
		getPerProjectAccounts: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => boolean;
		getStorageBackupEnabled: (
			config: ReturnType<typeof import("../config.js").loadPluginConfig>,
		) => boolean;
		setStorageBackupEnabled: (enabled: boolean) => void;
		isCodexCliSyncEnabled: () => boolean;
		getWarningShown: () => boolean;
		setWarningShown: (shown: boolean) => void;
		logWarn: (message: string) => void;
		pluginName: string;
		setStoragePath: (path: string | null) => void;
		cwd: () => string;
	},
): void {
	const perProjectAccounts = deps.getPerProjectAccounts(pluginConfig);
	deps.setStorageBackupEnabled(deps.getStorageBackupEnabled(pluginConfig));
	if (deps.isCodexCliSyncEnabled()) {
		if (perProjectAccounts && !deps.getWarningShown()) {
			deps.setWarningShown(true);
			deps.logWarn(
				`[${deps.pluginName}] CODEX_AUTH_PER_PROJECT_ACCOUNTS is ignored while Codex CLI sync is enabled. Using global account storage.`,
			);
		}
		deps.setStoragePath(null);
		return;
	}

	deps.setStoragePath(perProjectAccounts ? deps.cwd() : null);
}
