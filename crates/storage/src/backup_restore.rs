//! Port of `lib/storage/backup-restore.ts` + `restore-backup-entry.ts`
//! wiring from `lib/storage.ts` (spec 02 §12.3 `restoreAccountsFromBackup`).
//!
//! Realpath-based containment inside the named-backup root, frozen error
//! strings, empty-backup rejection, optional persist via the locked
//! `save_accounts`.

use std::io;
use std::path::Path;

use cma_core::errors::CodexError;
use cma_core::fs_retry::code_of;
use cma_core::schemas::account_storage::AccountStorageV3;

use crate::named_backups::{is_absolute_path, path_relative, realpath_compat};

fn io_to_codex(error: io::Error) -> CodexError {
    let mapped = CodexError::new(error.to_string());
    match code_of(&error) {
        Some(code) => mapped.with_code(code).with_cause(error),
        None => mapped.with_cause(error),
    }
}

fn is_enoent(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || code_of(error) == Some("ENOENT")
}

/// TS `restoreAccountsFromBackupPath` with an explicit backup root and
/// persist toggle.
pub async fn restore_accounts_from_backup_path(
    path: &str,
    backup_root: &str,
    persist: bool,
) -> Result<AccountStorageV3, CodexError> {
    let resolved_backup_root = match realpath_compat(backup_root) {
        Ok(resolved) => resolved,
        Err(error) if is_enoent(&error) => {
            return Err(CodexError::new(format!(
                "Backup root does not exist: {backup_root}"
            )));
        }
        Err(error) => return Err(io_to_codex(error)),
    };

    let resolved_backup_path = match realpath_compat(path) {
        Ok(resolved) => resolved,
        Err(error) if is_enoent(&error) => {
            return Err(CodexError::new(format!(
                "Backup file no longer exists: {path}"
            )));
        }
        Err(error) => return Err(io_to_codex(error)),
    };

    let relative_path = path_relative(&resolved_backup_root, &resolved_backup_path);
    let is_inside_backup_root = !relative_path.is_empty()
        && !relative_path.starts_with("..")
        && !is_absolute_path(&relative_path);
    if !is_inside_backup_root {
        return Err(CodexError::new(format!(
            "Backup path must stay inside {resolved_backup_root}: {path}"
        )));
    }

    let parsed =
        match crate::parser::load_accounts_from_path(Path::new(&resolved_backup_path)).await {
            Ok(parsed) => parsed,
            // ENOENT during the load ⇒ the "no longer exists" error (TOCTOU).
            Err(error) if is_enoent(&error) => {
                return Err(CodexError::new(format!(
                    "Backup file no longer exists: {path}"
                )));
            }
            // Other read failures (including the propagating JSON
            // SyntaxError, ErrorKind::InvalidData) surface unchanged.
            Err(error) => return Err(io_to_codex(error)),
        };

    let normalized = match parsed.normalized {
        Some(normalized) if !normalized.accounts.is_empty() => normalized,
        _ => {
            return Err(CodexError::new(format!(
                "Backup does not contain any accounts: {resolved_backup_path}"
            )));
        }
    };

    if persist {
        crate::save::save_accounts(&normalized).await?;
    }
    Ok(normalized)
}

/// TS `restoreAccountsFromBackup(path, {persist})` (storage.ts export) —
/// backup root derived from the CURRENT storage path's named-backup root.
/// `persist` defaults to true (`persist !== false`).
pub async fn restore_accounts_from_backup(
    path: &str,
    persist: Option<bool>,
) -> Result<AccountStorageV3, CodexError> {
    let storage_path = std::path::PathBuf::from(crate::facade::get_storage_path())
        .to_string_lossy()
        .into_owned();
    let backup_root = crate::named_backups::get_named_backup_root(&storage_path)?;
    restore_accounts_from_backup_path(path, &backup_root, persist != Some(false)).await
}

// ============================================================================
// Tests (ported from the restore-backup suites; persist:false paths only so
// no global storage state is touched)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_storage_json() -> String {
        serde_json::to_string(&json!({
            "version": 3,
            "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 2 }],
            "activeIndex": 0,
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn missing_backup_root_uses_frozen_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backups");
        let root_str = root.to_string_lossy().into_owned();
        let error = restore_accounts_from_backup_path("whatever.json", &root_str, false)
            .await
            .expect_err("missing root");
        assert_eq!(
            error.message(),
            format!("Backup root does not exist: {root_str}")
        );
    }

    #[tokio::test]
    async fn missing_backup_file_uses_frozen_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backups");
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("gone.json");
        let missing_str = missing.to_string_lossy().into_owned();
        let error =
            restore_accounts_from_backup_path(&missing_str, &root.to_string_lossy(), false)
                .await
                .expect_err("missing file");
        assert_eq!(
            error.message(),
            format!("Backup file no longer exists: {missing_str}")
        );
    }

    #[tokio::test]
    async fn backup_outside_root_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backups");
        std::fs::create_dir_all(&root).unwrap();
        let outside = dir.path().join("outside.json");
        std::fs::write(&outside, valid_storage_json()).unwrap();
        let error = restore_accounts_from_backup_path(
            &outside.to_string_lossy(),
            &root.to_string_lossy(),
            false,
        )
        .await
        .expect_err("outside root");
        assert!(
            error.message().starts_with("Backup path must stay inside "),
            "unexpected message: {}",
            error.message()
        );
    }

    #[tokio::test]
    async fn empty_backup_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backups");
        std::fs::create_dir_all(&root).unwrap();
        let backup = root.join("empty.json");
        std::fs::write(
            &backup,
            serde_json::to_string(&json!({ "version": 3, "accounts": [], "activeIndex": 0 }))
                .unwrap(),
        )
        .unwrap();
        let error = restore_accounts_from_backup_path(
            &backup.to_string_lossy(),
            &root.to_string_lossy(),
            false,
        )
        .await
        .expect_err("empty backup");
        assert!(
            error
                .message()
                .starts_with("Backup does not contain any accounts: "),
            "unexpected message: {}",
            error.message()
        );
    }

    #[tokio::test]
    async fn valid_backup_restores_without_persist() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("backups");
        std::fs::create_dir_all(&root).unwrap();
        let backup = root.join("daily.json");
        std::fs::write(&backup, valid_storage_json()).unwrap();
        let restored = restore_accounts_from_backup_path(
            &backup.to_string_lossy(),
            &root.to_string_lossy(),
            false,
        )
        .await
        .expect("restores");
        assert_eq!(restored.accounts.len(), 1);
        assert_eq!(restored.accounts[0].refresh_token, "rt");
    }
}
