//! Port of `lib/storage/restore-assessment.ts` + `restore-metadata.ts`
//! (spec 02 §13.2, R6).
//!
//! R6: `restoreEligible` / `restoreReason` are IN-MEMORY-ONLY fields. The TS
//! code spliced them onto returned storage objects; the Rust port keeps them
//! in the side-band [`RestoreMeta`] struct so they can NEVER be serialized
//! into `AccountStorageV3` (the spec's own recommended consciously-accepted
//! harmless byte difference — gotcha 20).

use serde::Serialize;

use cma_core::schemas::account_storage::{AccountStorageV3, ActiveIndexByFamily};

use crate::backup_metadata::{
    BackupMetadata, BackupSnapshotKind, BackupSnapshotMetadata, RestoreAssessment,
};

/// TS `RestoreReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum RestoreReason {
    #[serde(rename = "empty-storage")]
    EmptyStorage,
    #[serde(rename = "intentional-reset")]
    IntentionalReset,
    #[serde(rename = "missing-storage")]
    MissingStorage,
}

impl RestoreReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EmptyStorage => "empty-storage",
            Self::IntentionalReset => "intentional-reset",
            Self::MissingStorage => "missing-storage",
        }
    }
}

impl std::fmt::Display for RestoreReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Side-band restore metadata (R6) — never serialized into storage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RestoreMeta {
    pub restore_eligible: bool,
    pub restore_reason: RestoreReason,
}

/// Storage + side-band restore metadata — the Rust analogue of the TS
/// `AccountStorageV3 & { restoreEligible?, restoreReason? }` intersection.
#[derive(Clone, Debug, PartialEq)]
pub struct StorageWithRestoreMeta {
    pub storage: AccountStorageV3,
    pub restore_meta: Option<RestoreMeta>,
}

/// TS `createEmptyStorageWithRestoreMetadata` — empty v3 storage
/// (`activeIndexByFamily: {}` present!) plus restore metadata.
pub fn create_empty_storage_with_restore_metadata(
    restore_eligible: bool,
    restore_reason: RestoreReason,
) -> StorageWithRestoreMeta {
    let mut storage = AccountStorageV3::empty();
    storage.active_index_by_family = Some(ActiveIndexByFamily::default());
    StorageWithRestoreMeta {
        storage,
        restore_meta: Some(RestoreMeta {
            restore_eligible,
            restore_reason,
        }),
    }
}

/// TS `withRestoreMetadata` — attach restore metadata to existing storage.
pub fn with_restore_metadata(
    storage: AccountStorageV3,
    restore_eligible: bool,
    restore_reason: RestoreReason,
) -> StorageWithRestoreMeta {
    StorageWithRestoreMeta {
        storage,
        restore_meta: Some(RestoreMeta {
            restore_eligible,
            restore_reason,
        }),
    }
}

fn find_latest_snapshot(backup_metadata: &BackupMetadata) -> Option<BackupSnapshotMetadata> {
    let latest_valid_path = backup_metadata.accounts.latest_valid_path.as_deref()?;
    backup_metadata
        .accounts
        .snapshots
        .iter()
        .find(|snapshot| snapshot.path == latest_valid_path)
        .cloned()
}

/// TS `buildRestoreAssessment` (restore-assessment.ts) — pure.
pub fn build_restore_assessment(
    storage_path: &str,
    backup_metadata: BackupMetadata,
    has_reset_marker: bool,
) -> RestoreAssessment {
    if has_reset_marker {
        return RestoreAssessment {
            storage_path: storage_path.to_string(),
            restore_eligible: false,
            restore_reason: Some(RestoreReason::IntentionalReset),
            latest_snapshot: None,
            backup_metadata,
        };
    }

    let primary_snapshot = backup_metadata
        .accounts
        .snapshots
        .iter()
        .find(|snapshot| snapshot.kind == BackupSnapshotKind::AccountsPrimary)
        .cloned();
    let primary_exists = primary_snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.exists);
    if !primary_exists {
        let latest_snapshot = find_latest_snapshot(&backup_metadata);
        return RestoreAssessment {
            storage_path: storage_path.to_string(),
            restore_eligible: true,
            restore_reason: Some(RestoreReason::MissingStorage),
            latest_snapshot,
            backup_metadata,
        };
    }

    let primary_snapshot = primary_snapshot.expect("primary exists");
    if primary_snapshot.valid && primary_snapshot.account_count == Some(0) {
        return RestoreAssessment {
            storage_path: storage_path.to_string(),
            restore_eligible: true,
            restore_reason: Some(RestoreReason::EmptyStorage),
            latest_snapshot: Some(primary_snapshot),
            backup_metadata,
        };
    }

    let latest_snapshot = find_latest_snapshot(&backup_metadata);
    RestoreAssessment {
        storage_path: storage_path.to_string(),
        restore_eligible: false,
        restore_reason: None,
        latest_snapshot,
        backup_metadata,
    }
}

/// TS `getRestoreAssessment()` (storage.ts export).
pub async fn get_restore_assessment() -> RestoreAssessment {
    let storage_path = std::path::PathBuf::from(crate::facade::get_storage_path())
        .to_string_lossy()
        .into_owned();
    let reset_marker_path = crate::backup_paths::get_intentional_reset_marker_path(&storage_path);
    let backup_metadata = crate::backup_metadata::get_backup_metadata().await;
    build_restore_assessment(
        &storage_path,
        backup_metadata,
        std::path::Path::new(&reset_marker_path).exists(),
    )
}

// ============================================================================
// Tests (ported from the restore-assessment suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup_metadata::{BackupMetadataSection, build_metadata_section};

    fn snapshot(
        kind: BackupSnapshotKind,
        path: &str,
        exists: bool,
        valid: bool,
        account_count: Option<usize>,
        mtime_ms: Option<f64>,
    ) -> BackupSnapshotMetadata {
        BackupSnapshotMetadata {
            kind,
            path: path.to_string(),
            exists,
            valid,
            account_count,
            mtime_ms,
            ..Default::default()
        }
    }

    fn metadata_with(accounts: Vec<BackupSnapshotMetadata>) -> BackupMetadata {
        BackupMetadata {
            accounts: build_metadata_section("/x/accounts.json", accounts),
            flagged_accounts: BackupMetadataSection::default(),
        }
    }

    #[test]
    fn reset_marker_blocks_restore() {
        let assessment =
            build_restore_assessment("/x/accounts.json", metadata_with(Vec::new()), true);
        assert!(!assessment.restore_eligible);
        assert_eq!(
            assessment.restore_reason,
            Some(RestoreReason::IntentionalReset)
        );
        assert!(assessment.latest_snapshot.is_none());
    }

    #[test]
    fn missing_primary_is_eligible_with_latest_valid_snapshot() {
        let metadata = metadata_with(vec![
            snapshot(
                BackupSnapshotKind::AccountsPrimary,
                "/x/accounts.json",
                false,
                false,
                None,
                None,
            ),
            snapshot(
                BackupSnapshotKind::AccountsBackup,
                "/x/accounts.json.bak",
                true,
                true,
                Some(2),
                Some(10.0),
            ),
        ]);
        let assessment = build_restore_assessment("/x/accounts.json", metadata, false);
        assert!(assessment.restore_eligible);
        assert_eq!(assessment.restore_reason, Some(RestoreReason::MissingStorage));
        assert_eq!(
            assessment.latest_snapshot.as_ref().map(|s| s.path.as_str()),
            Some("/x/accounts.json.bak")
        );
    }

    #[test]
    fn empty_primary_is_eligible_with_primary_as_latest() {
        let metadata = metadata_with(vec![snapshot(
            BackupSnapshotKind::AccountsPrimary,
            "/x/accounts.json",
            true,
            true,
            Some(0),
            Some(10.0),
        )]);
        let assessment = build_restore_assessment("/x/accounts.json", metadata, false);
        assert!(assessment.restore_eligible);
        assert_eq!(assessment.restore_reason, Some(RestoreReason::EmptyStorage));
        assert_eq!(
            assessment
                .latest_snapshot
                .as_ref()
                .map(|s| s.kind),
            Some(BackupSnapshotKind::AccountsPrimary)
        );
    }

    #[test]
    fn healthy_primary_is_not_eligible() {
        let metadata = metadata_with(vec![snapshot(
            BackupSnapshotKind::AccountsPrimary,
            "/x/accounts.json",
            true,
            true,
            Some(3),
            Some(10.0),
        )]);
        let assessment = build_restore_assessment("/x/accounts.json", metadata, false);
        assert!(!assessment.restore_eligible);
        assert_eq!(assessment.restore_reason, None);
        // latestSnapshot still reported for the doctor view.
        assert!(assessment.latest_snapshot.is_some());
    }

    #[test]
    fn empty_storage_helper_populates_active_index_by_family_object() {
        let created = create_empty_storage_with_restore_metadata(
            false,
            RestoreReason::IntentionalReset,
        );
        // TS writes `activeIndexByFamily: {}` — present, empty.
        let value = serde_json::to_value(&created.storage).unwrap();
        assert_eq!(value["activeIndexByFamily"], serde_json::json!({}));
        let meta = created.restore_meta.unwrap();
        assert!(!meta.restore_eligible);
        assert_eq!(meta.restore_reason, RestoreReason::IntentionalReset);
        // R6: the serialized storage never carries restore fields.
        assert!(value.get("restoreEligible").is_none());
        assert!(value.get("restoreReason").is_none());
    }

    #[test]
    fn with_restore_metadata_wraps_existing_storage() {
        let storage = AccountStorageV3::empty();
        let wrapped = with_restore_metadata(storage, true, RestoreReason::EmptyStorage);
        assert_eq!(
            wrapped.restore_meta.unwrap().restore_reason,
            RestoreReason::EmptyStorage
        );
    }
}
