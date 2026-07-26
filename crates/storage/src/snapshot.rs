//! Port of `lib/storage/account-snapshot.ts` (spec 02 §13.1).
//!
//! - [`stat_snapshot`]: EBUSY/EPERM ⇒ "exists but locked" (`exists: true`
//!   without bytes/mtime — gotcha 27); ENOENT silent; other errors warn.
//! - [`describe_account_snapshot`]: load + normalize with up to 2 stat
//!   refreshes while bytes/mtime are missing; ENOENT load races count as
//!   invalid-but-present snapshots.

use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde_json::json;

use cma_core::fs_retry::code_of;
use cma_core::logger::create_logger;

use crate::backup_metadata::{BackupSnapshotKind, BackupSnapshotMetadata};

/// TS `SnapshotStats`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SnapshotStats {
    pub exists: bool,
    pub bytes: Option<u64>,
    pub mtime_ms: Option<f64>,
}

fn mtime_ms_of(metadata: &std::fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn is_enoent(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || code_of(error) == Some("ENOENT")
}

/// TS `statSnapshot` — size/mtime metadata for a backup candidate.
pub async fn stat_snapshot(path: &str) -> SnapshotStats {
    let log = create_logger("storage");
    match tokio::fs::metadata(path).await {
        Ok(metadata) => SnapshotStats {
            exists: true,
            bytes: Some(metadata.len()),
            mtime_ms: Some(mtime_ms_of(&metadata)),
        },
        Err(error) => {
            let error_code = code_of(&error);
            if error_code == Some("EBUSY") || error_code == Some("EPERM") {
                log.warn(
                    "Backup candidate is locked",
                    Some(&json!({ "path": path, "error": error.to_string() })),
                );
                return SnapshotStats {
                    exists: true,
                    bytes: None,
                    mtime_ms: None,
                };
            }
            if !is_enoent(&error) {
                log.warn(
                    "Failed to stat backup candidate",
                    Some(&json!({ "path": path, "error": error.to_string() })),
                );
            }
            SnapshotStats::default()
        }
    }
}

/// TS `describeAccountSnapshot` — backup metadata for an account snapshot.
pub async fn describe_account_snapshot(
    path: &str,
    kind: BackupSnapshotKind,
    index: Option<usize>,
) -> BackupSnapshotMetadata {
    let log = create_logger("storage");
    let stats = stat_snapshot(path).await;
    if !stats.exists {
        return BackupSnapshotMetadata {
            kind,
            path: path.to_string(),
            index,
            exists: false,
            valid: false,
            ..Default::default()
        };
    }
    match crate::parser::load_accounts_from_path(Path::new(path)).await {
        Ok(parsed) => {
            let mut resolved_stats = stats;
            for _ in 0..2 {
                if resolved_stats.bytes.is_some() && resolved_stats.mtime_ms.is_some() {
                    break;
                }
                let refreshed_stats = stat_snapshot(path).await;
                if refreshed_stats.exists {
                    resolved_stats = refreshed_stats;
                }
            }
            BackupSnapshotMetadata {
                kind,
                path: path.to_string(),
                index,
                exists: true,
                valid: parsed.normalized.is_some(),
                bytes: Some(resolved_stats.bytes.unwrap_or(0)),
                mtime_ms: Some(resolved_stats.mtime_ms.unwrap_or(0.0)),
                version: parsed.stored_version,
                account_count: parsed
                    .normalized
                    .as_ref()
                    .map(|normalized| normalized.accounts.len()),
                flagged_count: None,
                schema_errors: if parsed.schema_errors.is_empty() {
                    None
                } else {
                    Some(parsed.schema_errors)
                },
            }
        }
        Err(error) => {
            if !is_enoent(&error) {
                log.warn(
                    "Failed to inspect account snapshot",
                    Some(&json!({ "path": path, "error": error.to_string() })),
                );
            }
            BackupSnapshotMetadata {
                kind,
                path: path.to_string(),
                index,
                exists: true,
                valid: false,
                bytes: stats.bytes,
                mtime_ms: stats.mtime_ms,
                ..Default::default()
            }
        }
    }
}

// ============================================================================
// Tests (ported from the account-snapshot suites; explicit-path filesystem
// tests via tempfile — no env mutation)
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
    async fn stat_snapshot_missing_file_is_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let stats = stat_snapshot(&path.to_string_lossy()).await;
        assert_eq!(stats, SnapshotStats::default());
        assert!(!stats.exists);
    }

    #[tokio::test]
    async fn stat_snapshot_reports_bytes_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, "hello").unwrap();
        let stats = stat_snapshot(&path.to_string_lossy()).await;
        assert!(stats.exists);
        assert_eq!(stats.bytes, Some(5));
        assert!(stats.mtime_ms.unwrap_or(0.0) > 0.0);
    }

    #[tokio::test]
    async fn describe_missing_snapshot_is_nonexistent_and_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let snapshot = describe_account_snapshot(
            &path.to_string_lossy(),
            BackupSnapshotKind::AccountsPrimary,
            None,
        )
        .await;
        assert!(!snapshot.exists);
        assert!(!snapshot.valid);
        assert_eq!(snapshot.bytes, None);
    }

    #[tokio::test]
    async fn describe_valid_snapshot_reports_counts_and_stats() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, valid_storage_json()).unwrap();
        let snapshot = describe_account_snapshot(
            &path.to_string_lossy(),
            BackupSnapshotKind::AccountsBackup,
            Some(1),
        )
        .await;
        assert!(snapshot.exists);
        assert!(snapshot.valid);
        assert_eq!(snapshot.kind, BackupSnapshotKind::AccountsBackup);
        assert_eq!(snapshot.index, Some(1));
        assert_eq!(snapshot.account_count, Some(1));
        assert_eq!(snapshot.version, Some(3));
        assert!(snapshot.bytes.unwrap_or(0) > 0);
        assert!(snapshot.mtime_ms.unwrap_or(0.0) > 0.0);
    }

    #[tokio::test]
    async fn describe_corrupt_snapshot_is_present_but_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(&path, "{ this is not json").unwrap();
        let snapshot = describe_account_snapshot(
            &path.to_string_lossy(),
            BackupSnapshotKind::AccountsPrimary,
            None,
        )
        .await;
        assert!(snapshot.exists);
        assert!(!snapshot.valid);
    }

    #[tokio::test]
    async fn describe_unnormalizable_snapshot_is_invalid_but_existing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        // Parses as JSON but fails normalization (unknown version).
        std::fs::write(&path, r#"{"version":42}"#).unwrap();
        let snapshot = describe_account_snapshot(
            &path.to_string_lossy(),
            BackupSnapshotKind::AccountsPrimary,
            None,
        )
        .await;
        assert!(snapshot.exists);
        assert!(!snapshot.valid);
        assert_eq!(snapshot.version, Some(42));
    }
}
