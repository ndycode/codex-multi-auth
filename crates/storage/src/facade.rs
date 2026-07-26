//! Port of the glue/state half of `lib/storage.ts` — the facade other crates
//! import.
//!
//! Owns the module state (`storageBackupEnabled` default true,
//! `lastAccountsSaveTimestamp` default 0), the file-name constants, and the
//! storage-path configuration (`setStoragePath` / `setStoragePathDirect` /
//! `getStoragePath` / flagged path getters). The load/save/clear/transaction
//! entry points live in their own modules and are re-exported here so
//! `cma_storage::facade` mirrors the TS `lib/storage.ts` export list
//! (spec 02 §14).

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use crate::path_state::StoragePathState;
use crate::paths::{
    find_project_root, get_config_dir, get_project_config_dir, get_project_global_config_dir,
    resolve_project_storage_identity_root,
};

/// `openai-codex-accounts.json`.
pub const ACCOUNTS_FILE_NAME: &str = "openai-codex-accounts.json";
/// `openai-codex-flagged-accounts.json`.
pub const FLAGGED_ACCOUNTS_FILE_NAME: &str = "openai-codex-flagged-accounts.json";
/// Legacy `openai-codex-blocked-accounts.json` (migrated on load).
pub const LEGACY_FLAGGED_ACCOUNTS_FILE_NAME: &str = "openai-codex-blocked-accounts.json";

static STORAGE_BACKUP_ENABLED: AtomicBool = AtomicBool::new(true);
static LAST_ACCOUNTS_SAVE_TIMESTAMP: AtomicI64 = AtomicI64::new(0);

/// `setStorageBackupEnabled(enabled)`.
pub fn set_storage_backup_enabled(enabled: bool) {
    STORAGE_BACKUP_ENABLED.store(enabled, Ordering::SeqCst);
}

/// Module flag read by the save/load pipelines.
pub(crate) fn storage_backup_enabled() -> bool {
    STORAGE_BACKUP_ENABLED.load(Ordering::SeqCst)
}

/// `getLastAccountsSaveTimestamp()`.
pub fn get_last_accounts_save_timestamp() -> i64 {
    LAST_ACCOUNTS_SAVE_TIMESTAMP.load(Ordering::SeqCst)
}

pub(crate) fn set_last_accounts_save_timestamp(timestamp_ms: i64) {
    LAST_ACCOUNTS_SAVE_TIMESTAMP.store(timestamp_ms, Ordering::SeqCst);
}

/// `setStoragePath(projectPath | null)` — spec 02 §2.8. `None` (or a path
/// with no detectable project root) resets to global storage mode; otherwise
/// the state points at the identity-root-scoped per-project file with both
/// legacy candidates recorded for migration.
pub fn set_storage_path(project_path: Option<&Path>) {
    let Some(project_path) = project_path else {
        set_storage_path_state(StoragePathState::empty());
        return;
    };

    let Some(project_root) = find_project_root(project_path) else {
        set_storage_path_state(StoragePathState::empty());
        return;
    };

    let identity_root = resolve_project_storage_identity_root(&project_root);
    let current_storage_path =
        get_project_global_config_dir(&identity_root).join(ACCOUNTS_FILE_NAME);
    let current_legacy_project_storage_path =
        get_project_config_dir(&project_root).join(ACCOUNTS_FILE_NAME);
    let previous_worktree_scoped_path =
        get_project_global_config_dir(&project_root).join(ACCOUNTS_FILE_NAME);
    let current_legacy_worktree_storage_path =
        if previous_worktree_scoped_path != current_storage_path {
            Some(previous_worktree_scoped_path)
        } else {
            None
        };

    set_storage_path_state(StoragePathState {
        current_storage_path: Some(current_storage_path.to_string_lossy().into_owned()),
        current_legacy_project_storage_path: Some(
            current_legacy_project_storage_path
                .to_string_lossy()
                .into_owned(),
        ),
        current_legacy_worktree_storage_path: current_legacy_worktree_storage_path
            .map(|p| p.to_string_lossy().into_owned()),
        current_project_root: Some(project_root.to_string_lossy().into_owned()),
    });
}

/// `setStoragePathDirect(path | null)` — sets `currentStoragePath` only, all
/// other fields null (tests/tools).
pub fn set_storage_path_direct(path: Option<&Path>) {
    set_storage_path_state(StoragePathState {
        current_storage_path: path.map(|p| p.to_string_lossy().into_owned()),
        ..StoragePathState::empty()
    });
}

/// `getStoragePath()` — the scoped path when set, else
/// `<configDir>/openai-codex-accounts.json`. (String path — the TS module
/// worked in path strings; sibling modules build suffix paths off it.)
pub fn get_storage_path() -> String {
    let state = crate::path_state::get_storage_path_state();
    if let Some(current) = state.current_storage_path {
        return current;
    }
    get_config_dir()
        .join(ACCOUNTS_FILE_NAME)
        .to_string_lossy()
        .into_owned()
}

/// `getFlaggedAccountsPath()` = sibling
/// `openai-codex-flagged-accounts.json` of the current storage path.
pub fn get_flagged_accounts_path() -> String {
    crate::backup_paths::get_flagged_accounts_path(get_storage_path(), FLAGGED_ACCOUNTS_FILE_NAME)
}

/// The legacy flagged path (`openai-codex-blocked-accounts.json`); private in
/// TS but needed by the flagged load ladder.
pub fn get_legacy_flagged_accounts_path() -> String {
    crate::backup_paths::get_legacy_flagged_accounts_path(
        get_storage_path(),
        LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
    )
}

// ---------------------------------------------------------------------------
// Facade re-exports (spec 02 §14 export inventory — items owned by this
// agent's modules; sibling-module items are re-exported from their own
// modules and finalized at crate integration)
// ---------------------------------------------------------------------------

pub use crate::backup_paths::{
    ACCOUNTS_BACKUP_SUFFIX, ACCOUNTS_WAL_SUFFIX, RESET_MARKER_SUFFIX, get_accounts_backup_path,
    get_accounts_backup_path_at_index, get_accounts_backup_recovery_candidates,
    get_accounts_backup_recovery_candidates_default, get_accounts_wal_path,
    get_intentional_reset_marker_path,
};
pub use crate::clear::clear_accounts;
pub use crate::load::{
    LoadedAccountStorage, PersistMigration, PinAndGen, RestoreMetadata, load_accounts,
    load_accounts_for_export, load_accounts_from_journal, load_accounts_internal,
    load_accounts_unlocked, read_affinity_generation_from_disk, read_pin_and_gen_from_disk,
};
pub use crate::misc::{
    clone_account_storage_for_persistence, compute_sha256, format_storage_error_hint,
    format_storage_error_hint_for_code, to_storage_error,
};
pub use crate::normalize::normalize_account_storage;
pub use crate::parser::{ParsedStorage, load_accounts_from_path, parse_and_normalize_storage};
pub use crate::path_state::{
    get_storage_path_state, run_with_storage_path_state, run_with_storage_path_state_sync,
    set_storage_path_state,
};
pub use crate::paths::{
    PathError, find_project_root as find_project_root_export, get_config_dir as config_dir,
    get_project_storage_key, is_project_directory, resolve_path,
};
pub use crate::save::{save_accounts, save_accounts_unlocked};
pub use crate::save_retry::{
    is_retryable_storage_write_code, is_retryable_storage_write_error, save_accounts_with_retry,
    save_accounts_with_retry_via,
};

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial(storage_path_state)]
    fn backup_flag_and_save_timestamp_round_trip() {
        assert!(storage_backup_enabled());
        set_storage_backup_enabled(false);
        assert!(!storage_backup_enabled());
        set_storage_backup_enabled(true);

        assert_eq!(get_last_accounts_save_timestamp(), 0);
        set_last_accounts_save_timestamp(42);
        assert_eq!(get_last_accounts_save_timestamp(), 42);
        set_last_accounts_save_timestamp(0);
    }

    #[test]
    #[serial(storage_path_state)]
    fn direct_path_overrides_and_null_resets() {
        let dir = tempfile::tempdir().unwrap();
        let direct = dir.path().join("custom-accounts.json");
        set_storage_path_direct(Some(&direct));
        assert_eq!(get_storage_path(), direct.to_string_lossy());
        assert_eq!(
            get_flagged_accounts_path(),
            dir.path()
                .join(FLAGGED_ACCOUNTS_FILE_NAME)
                .to_string_lossy()
        );
        assert_eq!(
            get_legacy_flagged_accounts_path(),
            dir.path()
                .join(LEGACY_FLAGGED_ACCOUNTS_FILE_NAME)
                .to_string_lossy()
        );
        set_storage_path_direct(None);
        assert!(
            get_storage_path().ends_with(ACCOUNTS_FILE_NAME),
            "global mode falls back to <configDir>/{ACCOUNTS_FILE_NAME}"
        );
    }

    #[test]
    #[serial(storage_path_state)]
    fn set_storage_path_without_project_root_resets_state() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        // NOTE (known clone-state trap): an ANCESTOR of the temp dir may
        // carry a project marker (e.g. `~/.codex` on a dev machine), in which
        // case findProjectRoot legitimately resolves — assert the branch that
        // actually applies on this machine rather than assuming a marker-free
        // ancestry.
        set_storage_path(Some(&plain));
        let state = get_storage_path_state();
        match find_project_root(&plain) {
            None => assert_eq!(state, crate::path_state::StoragePathState::empty()),
            Some(_) => assert!(state.current_storage_path.is_some()),
        }
        // `None` always resets to global storage mode.
        set_storage_path(None);
        assert_eq!(
            get_storage_path_state(),
            crate::path_state::StoragePathState::empty()
        );
    }

    #[test]
    #[serial(storage_path_state)]
    fn set_storage_path_scopes_to_the_project_key_and_records_legacy_paths() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("myproj");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        set_storage_path(Some(&project));
        let state = get_storage_path_state();
        let current = state.current_storage_path.expect("scoped path set");
        assert!(current.ends_with(ACCOUNTS_FILE_NAME));
        assert!(current.contains("projects"));
        let legacy = state
            .current_legacy_project_storage_path
            .expect("legacy project path set");
        assert!(legacy.contains(".codex"));
        // Same root as identity root ⇒ no separate worktree legacy path.
        assert_eq!(state.current_legacy_worktree_storage_path, None);
        assert!(state.current_project_root.is_some());
        set_storage_path(None);
    }
}
