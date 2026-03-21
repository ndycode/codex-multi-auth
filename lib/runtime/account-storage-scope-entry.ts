export function applyAccountStorageScopeEntry(params: {
	pluginConfig: ReturnType<typeof import("../config.js").loadPluginConfig>;
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
	applyAccountStorageScopeFromConfig: (
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
	) => void;
}): void {
	params.applyAccountStorageScopeFromConfig(params.pluginConfig, {
		getPerProjectAccounts: params.getPerProjectAccounts,
		getStorageBackupEnabled: params.getStorageBackupEnabled,
		setStorageBackupEnabled: params.setStorageBackupEnabled,
		isCodexCliSyncEnabled: params.isCodexCliSyncEnabled,
		getWarningShown: params.getWarningShown,
		setWarningShown: params.setWarningShown,
		logWarn: params.logWarn,
		pluginName: params.pluginName,
		setStoragePath: params.setStoragePath,
		cwd: params.cwd,
	});
}
