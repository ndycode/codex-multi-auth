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
			// AUDIT-M09 / D-06: this is a hard config conflict that silently
			// collapses per-project isolation to global storage. Surface it as
			// a loud, actionable warning with explicit remediation so users
			// who picked per-project accounts on purpose do NOT learn about
			// the collapse via a post-hoc audit. We keep the warn-once gate
			// so the log is not repeated every request — the signal is the
			// fact that the user sees it, not its repetition.
			deps.logWarn(
				`[${deps.pluginName}] Config conflict: perProjectAccounts = true ` +
					`is ignored while Codex CLI sync is enabled, because Codex CLI ` +
					`maintains a single shared account set. All multi-auth accounts ` +
					`are collapsed to the GLOBAL pool (credentials are NOT isolated ` +
					`per project/worktree). ` +
					`To restore per-project isolation, either (a) disable Codex CLI ` +
					`sync via 'codex auth config set codexCliSync false', or ` +
					`(b) disable perProjectAccounts via ` +
					`'codex auth config set perProjectAccounts false' (acknowledges ` +
					`the global scope). This warning is emitted once per process.`,
			);
		}
		deps.setStoragePath(null);
		return;
	}

	deps.setStoragePath(perProjectAccounts ? deps.cwd() : null);
}
