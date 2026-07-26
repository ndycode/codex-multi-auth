//! Port of the accounts save pipeline: `lib/storage/account-save.ts`
//! (`saveAccountsToDisk`) + `account-save-entry.ts` + the
//! `saveAccountsUnlocked` wiring from `lib/storage.ts`.
//!
//! ORDERED pipeline (spec 02 §7.2 — order is load-bearing):
//! lock → dir 0700 (+POSIX chmod re-assert) → gitignore → synthetic-fixture
//! guard → rotating backup (warn-only) → WAL-first sha256-checksummed compact
//! entry → temp write → zero-byte EEMPTY check → rename (EPERM/EBUSY ×5,
//! `10·2^(n-1)` ms, no jitter) → reset-marker unlink → save-timestamp →
//! WAL unlink.
//!
//! Error path: best-effort temp cleanup (retried, swallowed), error log
//! `"Failed to save accounts"`, then EVERYTHING (including the synthetic
//! guard's own StorageError and the EEMPTY check) is wrapped as
//! `StorageError("Failed to save accounts: <msg>", <code|"UNKNOWN">, path,
//! hint, cause)` — matching the TS catch-all `createStorageError`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use cma_core::errors::CodexError;
use cma_core::fs_retry::{
    Backoff, RetryOptions, code_of, io_error_with_code, with_file_operation_retry, with_retry,
};
use cma_core::json_io::stringify_pretty2;
use cma_core::logger::create_logger;
use cma_core::schemas::journal::AccountsJournalEntry;
use cma_core::temp_path::temp_path_for_str;
use cma_core::utils::now_ms;
use serde_json::json;

use crate::backup_paths::{
    get_accounts_backup_path, get_accounts_wal_path, get_intentional_reset_marker_path,
};
use crate::facade;
use crate::fixture_guards::looks_like_synthetic_fixture_storage;
use crate::misc::{compute_sha256, ensure_codex_gitignore_entry, format_storage_error_hint};
use crate::path_state::get_storage_path_state;
use crate::public_types::AccountStorageV3;

/// Write a file with mode 0600 (unix; no-op mode on Windows — Node parity).
pub(crate) fn write_file_with_mode(path: &Path, content: &str, mode: u32) -> io::Result<()> {
    fs::write(path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
    }
    Ok(())
}

/// `ensureDirectory` — `mkdir -p` with mode 0700 plus a best-effort POSIX
/// `chmod 0o700` re-assert for pre-existing dirs (account storage holds
/// OAuth token material).
async fn ensure_directory(path: &str) -> io::Result<()> {
    let path = Path::new(path);
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    if dir.as_os_str().is_empty() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        use std::os::unix::fs::PermissionsExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(dir)?;
        // mkdir's mode only applies to freshly-created dirs; re-assert.
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)?;
    }
    Ok(())
}

/// `ensureGitignore` — project-scoped saves only (storage-path state set).
async fn ensure_gitignore(storage_path: &str) {
    let state = get_storage_path_state();
    if state.current_storage_path.is_none() {
        return;
    }
    let project_root = state.current_project_root.map(PathBuf::from);
    ensure_codex_gitignore_entry(Path::new(storage_path), project_root.as_deref()).await;
}

/// The wrapped save failure (`createStorageError`).
fn create_storage_error(error: &io::Error, path: &str) -> CodexError {
    let code = code_of(error).unwrap_or("UNKNOWN").to_string();
    let hint = format_storage_error_hint(error, path);
    let message = format!("Failed to save accounts: {error}");
    CodexError::storage(
        message,
        code,
        path,
        hint,
        Some(Box::new(io_error_with_code_dup(error))),
    )
}

/// Duplicate an io::Error for the cause chain (io::Error is not Clone).
fn io_error_with_code_dup(error: &io::Error) -> io::Error {
    match code_of(error) {
        Some(code) => {
            // Re-mint with the same code string so downstream code-matching
            // on the cause keeps working. The static-code table covers every
            // code the pipeline can produce; unknown codes fall through.
            for known in [
                "EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES", "ENOENT", "ENOSPC", "EEMPTY",
                "EINVALID", "EEXIST", "EROFS", "EINVAL",
            ] {
                if code == known {
                    return io_error_with_code(known, error.to_string());
                }
            }
            io::Error::other(error.to_string())
        }
        None => io::Error::other(error.to_string()),
    }
}

/// `saveAccounts(storage)` = `withStorageLock(saveAccountsUnlocked(storage))`.
pub async fn save_accounts(storage: &AccountStorageV3) -> Result<(), CodexError> {
    crate::transactions::with_storage_lock(|| async { save_accounts_unlocked(storage).await })
        .await
}

/// `saveAccountsUnlocked(storage)` — the full ordered pipeline. Callers MUST
/// already hold the storage lock (used directly by transactions and
/// load-side migration persists where the lock is already held).
pub async fn save_accounts_unlocked(storage: &AccountStorageV3) -> Result<(), CodexError> {
    let log = create_logger("storage");
    let path = facade::get_storage_path();
    let reset_marker_path = get_intentional_reset_marker_path(&path);
    let wal_path = get_accounts_wal_path(&path);
    let backup_path = get_accounts_backup_path(&path);
    let storage_backup_enabled = facade::storage_backup_enabled() && Path::new(&path).exists();
    let temp_path = temp_path_for_str(&path);

    let result: io::Result<()> = async {
        ensure_directory(&path).await?;
        ensure_gitignore(&path).await;

        // Synthetic fixture guard (spec 02 §7.2 step 3 / gotcha 13).
        if looks_like_synthetic_fixture_storage(Some(storage)) {
            let existing =
                crate::project_migration::load_normalized_storage_from_path(
                    &path,
                    "existing account storage",
                )
                .await;
            if let Some(existing) = existing
                && !existing.accounts.is_empty()
                && !looks_like_synthetic_fixture_storage(Some(&existing))
            {
                // Wrapped by the catch-all below exactly like the TS
                // StorageError flowing into createStorageError.
                return Err(io_error_with_code(
                    "EINVALID",
                    "Refusing to overwrite non-synthetic account storage with synthetic fixture payload",
                ));
            }
        }

        if storage_backup_enabled
            && let Err(backup_error) =
                crate::backups::create_rotating_accounts_backup(&path).await
        {
            log.warn(
                "Failed to create account storage backup",
                Some(&json!({
                    "path": path,
                    "backupPath": backup_path,
                    "error": backup_error.to_string(),
                })),
            );
        }

        let content = stringify_pretty2(storage);

        // WAL first (gotcha 2): compact sha256-checksummed entry, retried on
        // the shared transient-code taxonomy, mode 0600.
        let journal_entry = AccountsJournalEntry::new(
            now_ms(),
            path.clone(),
            compute_sha256(&content),
            content.clone(),
        );
        let journal_json = cma_core::json_io::stringify_compact(&journal_entry);
        with_file_operation_retry(|| {
            let wal_path = wal_path.clone();
            let journal_json = journal_json.clone();
            async move { write_file_with_mode(Path::new(&wal_path), &journal_json, 0o600) }
        })
        .await?;

        // Temp write (same retry wrapper, mode 0600).
        with_file_operation_retry(|| {
            let temp_path = temp_path.clone();
            let content = content.clone();
            async move { write_file_with_mode(Path::new(&temp_path), &content, 0o600) }
        })
        .await?;

        // Zero-byte EEMPTY check (gotcha 15: catches full-disk/AV truncation).
        let stats = fs::metadata(&temp_path)?;
        if stats.len() == 0 {
            return Err(io_error_with_code("EEMPTY", "File written but size is 0"));
        }

        // Rename retries ONLY EPERM/EBUSY (gotcha 16), 5 × 10·2^(n-1) ms.
        with_retry(
            || {
                let temp_path = temp_path.clone();
                let path = path.clone();
                async move { fs::rename(&temp_path, &path) }
            },
            RetryOptions::<io::Error>::new(
                5,
                Backoff::from_fn(|attempt| 10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))),
            )
            .with_codes(&["EPERM", "EBUSY"]),
        )
        .await?;

        // Best-effort reset-marker unlink (the marker persists across clears
        // until this very unlink — spec 02 §3.4).
        let _ = fs::remove_file(&reset_marker_path);

        facade::set_last_accounts_save_timestamp(now_ms());

        // Best-effort WAL unlink AFTER the successful rename (gotcha 2).
        let _ = fs::remove_file(&wal_path);
        Ok(())
    }
    .await;

    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            // Best-effort temp cleanup — retried so a transient lock cannot
            // strand a secret-bearing *.tmp, then swallowed.
            let _ = with_file_operation_retry(|| {
                let temp_path = temp_path.clone();
                async move { fs::remove_file(&temp_path) }
            })
            .await;
            log.error(
                "Failed to save accounts",
                Some(&json!({
                    "path": path,
                    "error": error.to_string(),
                })),
            );
            Err(create_storage_error(&error, &path))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_error_wraps_message_code_path_and_hint() {
        let error = io_error_with_code("EEMPTY", "File written but size is 0");
        let wrapped = create_storage_error(&error, "/x/a.json");
        assert_eq!(
            wrapped.message(),
            "Failed to save accounts: File written but size is 0"
        );
        assert_eq!(wrapped.code(), "EEMPTY");
        assert_eq!(wrapped.path(), Some("/x/a.json"));
        assert!(wrapped.hint().is_some());
    }

    #[test]
    fn storage_error_defaults_unknown_code() {
        let error = io::Error::other("mystery failure");
        let wrapped = create_storage_error(&error, "/x/a.json");
        assert_eq!(wrapped.code(), "UNKNOWN");
        assert_eq!(wrapped.message(), "Failed to save accounts: mystery failure");
    }

    #[test]
    fn synthetic_guard_error_carries_the_frozen_inner_message() {
        let inner = io_error_with_code(
            "EINVALID",
            "Refusing to overwrite non-synthetic account storage with synthetic fixture payload",
        );
        let wrapped = create_storage_error(&inner, "/x/a.json");
        assert_eq!(wrapped.code(), "EINVALID");
        assert_eq!(
            wrapped.message(),
            "Failed to save accounts: Refusing to overwrite non-synthetic account storage with synthetic fixture payload"
        );
    }

    #[tokio::test]
    async fn write_file_with_mode_creates_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.json");
        write_file_with_mode(&path, "{}", 0o600).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }
}
