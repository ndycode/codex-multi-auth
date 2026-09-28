//! Port of `lib/runtime/storage-scope.ts` + `lib/runtime/account-scope.ts`
//! (+ `account-storage-scope-entry.ts`) — account-storage scope resolution
//! from config (spec 10 §22, ARCHITECTURE §6.12).
//!
//! When Codex CLI sync is enabled, per-project accounts are IGNORED
//! (collapsed to the global pool); the conflict is surfaced ONCE per
//! process as a loud, actionable warning (AUDIT-M09 / D-06).

use cma_core::constants::PLUGIN_NAME;
use cma_core::schemas::plugin_config::PluginConfig;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// TS `account-scope.ts` `applyAccountStorageScope` deps — the generic,
/// fully injected variant (used by tests and alternate wirings).
pub struct AccountStorageScopeDeps<'a, TConfig> {
    pub get_per_project_accounts: &'a dyn Fn(&TConfig) -> bool,
    pub get_storage_backup_enabled: &'a dyn Fn(&TConfig) -> bool,
    pub is_codex_cli_sync_enabled: &'a dyn Fn() -> bool,
    pub set_storage_backup_enabled: &'a mut dyn FnMut(bool),
    /// `None` = global default path; `Some(cwd)` = per-project scope.
    pub set_storage_path: &'a mut dyn FnMut(Option<&str>),
    pub get_cwd: &'a dyn Fn() -> String,
    pub warn_per_project_sync_conflict: &'a mut dyn FnMut(),
}

/// TS `applyAccountStorageScope(pluginConfig, deps)` (generic variant).
pub fn apply_account_storage_scope<TConfig>(
    plugin_config: &TConfig,
    deps: &mut AccountStorageScopeDeps<'_, TConfig>,
) {
    let per_project_accounts = (deps.get_per_project_accounts)(plugin_config);
    (deps.set_storage_backup_enabled)((deps.get_storage_backup_enabled)(plugin_config));
    if (deps.is_codex_cli_sync_enabled)() {
        if per_project_accounts {
            (deps.warn_per_project_sync_conflict)();
        }
        (deps.set_storage_path)(None);
        return;
    }

    if per_project_accounts {
        let cwd = (deps.get_cwd)();
        (deps.set_storage_path)(Some(&cwd));
    } else {
        (deps.set_storage_path)(None);
    }
}

// TS `index.ts` module state `perProjectSyncWarningShown` — once per
// process.
static PER_PROJECT_SYNC_WARNING_SHOWN: AtomicBool = AtomicBool::new(false);

/// Test-only: reset the once-per-process warning gate.
pub fn reset_per_project_sync_warning_for_testing() {
    PER_PROJECT_SYNC_WARNING_SHOWN.store(false, Ordering::SeqCst);
}

/// The exact conflict warning text (storage-scope.ts, AUDIT-M09 / D-06).
fn per_project_sync_conflict_warning() -> String {
    format!(
        "[{PLUGIN_NAME}] Config conflict: perProjectAccounts = true \
is ignored while Codex CLI sync is enabled, because Codex CLI \
maintains a single shared account set. All multi-auth accounts \
are collapsed to the GLOBAL pool (credentials are NOT isolated \
per project/worktree). \
To restore per-project isolation, either (a) disable Codex CLI \
sync via 'codex-multi-auth config set codexCliSync false', or \
(b) disable perProjectAccounts via \
'codex-multi-auth config set perProjectAccounts false' (acknowledges \
the global scope). This warning is emitted once per process."
    )
}

/// TS `applyAccountStorageScopeFromConfig(pluginConfig, deps)` with the
/// production wiring (the `account-storage-scope-entry.ts` composition):
/// config getters from `cma-config`, storage setters from `cma-storage`,
/// CLI-sync probe from `cma-cli-mirror`, warn-once via the process-global
/// gate, warning through the logger.
pub fn apply_account_storage_scope_from_config(plugin_config: &PluginConfig) {
    let per_project_accounts = cma_config::getters::get_per_project_accounts(plugin_config);
    cma_storage::facade::set_storage_backup_enabled(
        cma_config::getters::get_storage_backup_enabled(plugin_config),
    );
    if cma_cli_mirror::state::is_codex_cli_sync_enabled() {
        if per_project_accounts && !PER_PROJECT_SYNC_WARNING_SHOWN.swap(true, Ordering::SeqCst) {
            // AUDIT-M09 / D-06: a hard config conflict that silently
            // collapses per-project isolation to global storage. Loud,
            // actionable, once per process — the signal is that the user
            // sees it, not its repetition.
            cma_core::logger::log_warn(&per_project_sync_conflict_warning(), None);
        }
        cma_storage::facade::set_storage_path(None);
        return;
    }

    if per_project_accounts {
        let cwd = std::env::current_dir().unwrap_or_default();
        cma_storage::facade::set_storage_path(Some(Path::new(&cwd)));
    } else {
        cma_storage::facade::set_storage_path(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestConfig {
        per_project: bool,
        backups: bool,
    }

    struct Recorded {
        backup_calls: Vec<bool>,
        path_calls: Vec<Option<String>>,
        warnings: usize,
    }

    fn run_scope(config: &TestConfig, cli_sync: bool) -> Recorded {
        let mut backup_calls: Vec<bool> = Vec::new();
        let mut path_calls: Vec<Option<String>> = Vec::new();
        let mut warnings = 0usize;
        {
            let mut set_backup = |enabled: bool| backup_calls.push(enabled);
            let mut set_path =
                |path: Option<&str>| path_calls.push(path.map(|p| p.to_string()));
            let mut warn = || warnings += 1;
            let mut deps = AccountStorageScopeDeps {
                get_per_project_accounts: &|c: &TestConfig| c.per_project,
                get_storage_backup_enabled: &|c: &TestConfig| c.backups,
                is_codex_cli_sync_enabled: &move || cli_sync,
                set_storage_backup_enabled: &mut set_backup,
                set_storage_path: &mut set_path,
                get_cwd: &|| "/work/project".to_string(),
                warn_per_project_sync_conflict: &mut warn,
            };
            apply_account_storage_scope(config, &mut deps);
        }
        Recorded {
            backup_calls,
            path_calls,
            warnings,
        }
    }

    #[test]
    fn cli_sync_collapses_per_project_to_global_and_warns() {
        let recorded = run_scope(
            &TestConfig {
                per_project: true,
                backups: true,
            },
            true,
        );
        assert_eq!(recorded.backup_calls, vec![true]);
        assert_eq!(recorded.path_calls, vec![None]);
        assert_eq!(recorded.warnings, 1);
    }

    #[test]
    fn cli_sync_without_per_project_does_not_warn() {
        let recorded = run_scope(
            &TestConfig {
                per_project: false,
                backups: false,
            },
            true,
        );
        assert_eq!(recorded.backup_calls, vec![false]);
        assert_eq!(recorded.path_calls, vec![None]);
        assert_eq!(recorded.warnings, 0);
    }

    #[test]
    fn per_project_without_cli_sync_scopes_to_cwd() {
        let recorded = run_scope(
            &TestConfig {
                per_project: true,
                backups: true,
            },
            false,
        );
        assert_eq!(
            recorded.path_calls,
            vec![Some("/work/project".to_string())]
        );
        assert_eq!(recorded.warnings, 0);
    }

    #[test]
    fn global_scope_without_cli_sync_sets_null_path() {
        let recorded = run_scope(
            &TestConfig {
                per_project: false,
                backups: true,
            },
            false,
        );
        assert_eq!(recorded.path_calls, vec![None]);
        assert_eq!(recorded.warnings, 0);
    }

    #[test]
    fn warning_text_is_frozen() {
        let text = per_project_sync_conflict_warning();
        assert!(text.starts_with("[codex-multi-auth] Config conflict: perProjectAccounts = true"));
        assert!(text.contains("'codex-multi-auth config set codexCliSync false'"));
        assert!(text.contains("'codex-multi-auth config set perProjectAccounts false'"));
        assert!(text.ends_with("This warning is emitted once per process."));
    }
}
