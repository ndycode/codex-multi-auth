//! Port of `lib/storage/account-clear.ts` (`clearAccountStorageArtifacts`) +
//! `account-clear-entry.ts` + the `clearAccounts` wiring from
//! `lib/storage.ts`.
//!
//! Behavior source: spec 02 §10, gotcha 3 (AUDIT-M04/E-07):
//! - The intentional-reset marker (`{"version":1,"createdAt":<ms>}`, compact,
//!   0600) is written FIRST — a crash mid-clear must look intentional, not
//!   corrupt.
//! - Primary and WAL unlinks are REQUIRED (log + throw on failure); backup
//!   unlinks are best-effort (log only).
//! - Unlink retry: 5 attempts, `10·2^attempt` ms (0-based ⇒ 10/20/40/80),
//!   shared FILE_RETRY_CODES; ENOENT counts as success.
//! - The accounts clear NEVER removes its reset marker — the next successful
//!   save's marker unlink does.

use std::fs;
use std::io;
use std::path::Path;

use cma_core::fs_retry::{Backoff, RetryOptions, code_of, with_retry};
use cma_core::logger::create_logger;
use cma_core::utils::now_ms;
use serde_json::json;

use crate::backup_paths::{get_accounts_wal_path, get_intentional_reset_marker_path};
use crate::backups::get_accounts_backup_recovery_candidates_with_discovery;
use crate::facade;
use crate::save::write_file_with_mode;

/// Unlink with the clear-path retry schedule; ENOENT ⇒ Ok.
async fn unlink_with_retry(target_path: &Path) -> io::Result<()> {
    let result = with_retry(
        || {
            let target = target_path.to_path_buf();
            async move {
                match fs::remove_file(&target) {
                    Ok(()) => Ok(()),
                    Err(error) if code_of(&error) == Some("ENOENT") => Ok(()),
                    Err(error) => Err(error),
                }
            }
        },
        // TS loop: catch at attempt n (0-based) sleeps 10·2^n; with_retry's
        // backoff receives the 1-based failed attempt ⇒ 10·2^(n-1).
        RetryOptions::<io::Error>::new(
            5,
            Backoff::from_fn(|attempt| {
                10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
            }),
        ),
    )
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(error) if code_of(&error) == Some("ENOENT") => Ok(()),
        Err(error) => Err(error),
    }
}

/// `clearAccountStorageArtifacts(params)` — marker-first deletion of
/// primary/WAL/backups with retry.
pub async fn clear_account_storage_artifacts(
    path: impl AsRef<Path>,
    reset_marker_path: impl AsRef<Path>,
    wal_path: impl AsRef<Path>,
    backup_paths: &[String],
) -> io::Result<()> {
    let log = create_logger("storage");

    // Marker FIRST (spec 02 §10 step 1).
    let marker_content = cma_core::json_io::stringify_compact(&json!({
        "version": 1,
        "createdAt": now_ms(),
    }));
    write_file_with_mode(reset_marker_path.as_ref(), &marker_content, 0o600)?;

    let clear_required = |target: &Path| {
        let target = target.to_path_buf();
        let log = create_logger("storage");
        async move {
            match unlink_with_retry(&target).await {
                Ok(()) => Ok(()),
                Err(error) => {
                    log.error(
                        "Failed to clear account storage artifact",
                        Some(&json!({
                            "path": target.to_string_lossy(),
                            "error": error.to_string(),
                        })),
                    );
                    Err(error)
                }
            }
        }
    };

    clear_required(path.as_ref()).await?;
    clear_required(wal_path.as_ref()).await?;

    for backup_path in backup_paths {
        if let Err(error) = unlink_with_retry(Path::new(backup_path)).await {
            // Non-critical artifacts: log only, keep going.
            log.error(
                "Failed to clear account storage artifact",
                Some(&json!({
                    "path": backup_path,
                    "error": error.to_string(),
                })),
            );
        }
    }
    // NOTE: the accounts clear never removes its reset marker.
    Ok(())
}

/// `clearAccounts()` — lock + artifacts with discovered backup paths.
pub async fn clear_accounts() -> io::Result<()> {
    let path = facade::get_storage_path();
    crate::transactions::with_storage_lock(|| async {
        let backup_paths = get_accounts_backup_recovery_candidates_with_discovery(&path).await;
        clear_account_storage_artifacts(
            &path,
            &get_intentional_reset_marker_path(&path),
            &get_accounts_wal_path(&path),
            &backup_paths,
        )
        .await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clear_writes_marker_first_and_removes_artifacts_but_not_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let marker = dir.path().join("a.json.reset-intent");
        let wal = dir.path().join("a.json.wal");
        let bak = dir.path().join("a.json.bak");
        fs::write(&path, "{}").unwrap();
        fs::write(&wal, "{}").unwrap();
        fs::write(&bak, "{}").unwrap();

        clear_account_storage_artifacts(
            &path,
            &marker,
            &wal,
            &[bak.to_string_lossy().into_owned()],
        )
        .await
        .unwrap();

        assert!(!path.exists());
        assert!(!wal.exists());
        assert!(!bak.exists());
        // Marker persists until the next successful save.
        assert!(marker.exists());
        let content = fs::read_to_string(&marker).unwrap();
        // Compact JSON with the exact key order {"version":1,"createdAt":N}.
        assert!(content.starts_with(r#"{"version":1,"createdAt":"#), "{content}");
        assert!(content.ends_with('}'));
        assert!(!content.contains(' '));
    }

    #[tokio::test]
    async fn clearing_missing_artifacts_is_a_no_op_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let marker = dir.path().join("a.json.reset-intent");
        let wal = dir.path().join("a.json.wal");
        clear_account_storage_artifacts(
            &path,
            &marker,
            &wal,
            &[dir.path().join("a.json.bak").to_string_lossy().into_owned()],
        )
        .await
        .unwrap();
        assert!(marker.exists());
    }

    #[tokio::test]
    async fn unlink_with_retry_treats_enoent_as_success() {
        let dir = tempfile::tempdir().unwrap();
        assert!(unlink_with_retry(&dir.path().join("missing.json")).await.is_ok());
    }
}
