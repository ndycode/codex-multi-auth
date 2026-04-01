import {
	getPerProjectAccounts,
	getStorageBackupEnabled,
	loadPluginConfig,
} from "../config.js";
import { isCodexCliSyncEnabled } from "../codex-cli/state.js";
import { applyAccountStorageScopeFromConfig } from "../runtime/storage-scope.js";
import {
	setStorageBackupEnabled,
	setStoragePath,
} from "../storage.js";

const MANAGER_PLUGIN_NAME = "codex-multi-auth";

let managerScopeWarningShown = false;

export function applyManagerAccountStorageScope(params?: {
	cwd?: () => string;
	logWarn?: (message: string) => void;
}): void {
	const pluginConfig = loadPluginConfig();

	applyAccountStorageScopeFromConfig(pluginConfig, {
		getPerProjectAccounts,
		getStorageBackupEnabled,
		setStorageBackupEnabled,
		isCodexCliSyncEnabled,
		getWarningShown: () => managerScopeWarningShown,
		setWarningShown: (shown) => {
			managerScopeWarningShown = shown;
		},
		logWarn: params?.logWarn ?? console.warn,
		pluginName: MANAGER_PLUGIN_NAME,
		setStoragePath,
		cwd: params?.cwd ?? (() => process.cwd()),
	});
}
