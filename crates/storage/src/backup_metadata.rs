//! Port of `lib/storage/backup-metadata.ts` + `backup-metadata-builder.ts`
//! (+ the storage.ts WAL/flagged snapshot describers; the dead
//! `metadata-section.ts` / `snapshot-inspectors.ts` duplicates are
//! consolidated here ONCE — spec gotcha 35) — spec 02 §13.1.
//!
//! For the ACCOUNTS section, `latestValidPath` is overridden by a
//! kind-priority pick: valid snapshots among {discovered-backup(4) >
//! backup-history(3) > backup(2)}, then WAL(1), then anything (primary=0);
//! ties broken by mtime DESC.

use serde::{Serialize, Serializer};
use serde_json::{Value, json};

use cma_core::logger::create_logger;
use cma_core::schemas::journal::AccountsJournalEntry;
use cma_core::schemas::parse::safe_parse_json_with_context;

use crate::snapshot::{describe_account_snapshot, stat_snapshot};

/// TS `BackupSnapshotKind`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub enum BackupSnapshotKind {
    #[default]
    #[serde(rename = "accounts-primary")]
    AccountsPrimary,
    #[serde(rename = "accounts-wal")]
    AccountsWal,
    #[serde(rename = "accounts-backup")]
    AccountsBackup,
    #[serde(rename = "accounts-backup-history")]
    AccountsBackupHistory,
    #[serde(rename = "accounts-discovered-backup")]
    AccountsDiscoveredBackup,
    #[serde(rename = "flagged-primary")]
    FlaggedPrimary,
    #[serde(rename = "flagged-backup")]
    FlaggedBackup,
    #[serde(rename = "flagged-backup-history")]
    FlaggedBackupHistory,
    #[serde(rename = "flagged-discovered-backup")]
    FlaggedDiscoveredBackup,
}

impl BackupSnapshotKind {
    /// Kind priority for the accounts `latestValidPath` selection (TS
    /// `ACCOUNT_SNAPSHOT_PRIORITY`; unlisted kinds default to 0).
    fn account_priority(self) -> i32 {
        match self {
            Self::AccountsDiscoveredBackup => 4,
            Self::AccountsBackupHistory => 3,
            Self::AccountsBackup => 2,
            Self::AccountsWal => 1,
            _ => 0,
        }
    }
}

/// Serialize an epoch-ms float the way V8 prints it: integral values without
/// the trailing `.0` (`1753500000000`, not `1753500000000.0`).
fn serialize_opt_js_number<S: Serializer>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) if v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 => {
            serializer.serialize_i64(*v as i64)
        }
        Some(v) => serializer.serialize_f64(*v),
        None => serializer.serialize_none(),
    }
}

/// TS `BackupSnapshotMetadata`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct BackupSnapshotMetadata {
    pub kind: BackupSnapshotKind,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    pub exists: bool,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(
        rename = "mtimeMs",
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_opt_js_number"
    )]
    pub mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(rename = "accountCount", skip_serializing_if = "Option::is_none")]
    pub account_count: Option<usize>,
    #[serde(rename = "flaggedCount", skip_serializing_if = "Option::is_none")]
    pub flagged_count: Option<usize>,
    #[serde(rename = "schemaErrors", skip_serializing_if = "Option::is_none")]
    pub schema_errors: Option<Vec<String>>,
}

/// TS `BackupMetadataSection`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct BackupMetadataSection {
    #[serde(rename = "storagePath")]
    pub storage_path: String,
    #[serde(rename = "latestValidPath", skip_serializing_if = "Option::is_none")]
    pub latest_valid_path: Option<String>,
    #[serde(rename = "snapshotCount")]
    pub snapshot_count: usize,
    #[serde(rename = "validSnapshotCount")]
    pub valid_snapshot_count: usize,
    pub snapshots: Vec<BackupSnapshotMetadata>,
}

/// TS `BackupMetadata`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct BackupMetadata {
    pub accounts: BackupMetadataSection,
    #[serde(rename = "flaggedAccounts")]
    pub flagged_accounts: BackupMetadataSection,
}

/// TS `RestoreAssessment` (declared in backup-metadata.ts; built by
/// `crate::restore`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RestoreAssessment {
    #[serde(rename = "storagePath")]
    pub storage_path: String,
    #[serde(rename = "restoreEligible")]
    pub restore_eligible: bool,
    #[serde(rename = "restoreReason", skip_serializing_if = "Option::is_none")]
    pub restore_reason: Option<crate::restore::RestoreReason>,
    #[serde(rename = "latestSnapshot", skip_serializing_if = "Option::is_none")]
    pub latest_snapshot: Option<BackupSnapshotMetadata>,
    #[serde(rename = "backupMetadata")]
    pub backup_metadata: BackupMetadata,
}

/// TS `latestValidSnapshot` — newest valid snapshot by `mtimeMs ?? 0`
/// (stable: first of a tie group wins).
pub fn latest_valid_snapshot(
    snapshots: &[BackupSnapshotMetadata],
) -> Option<&BackupSnapshotMetadata> {
    let mut best: Option<&BackupSnapshotMetadata> = None;
    for snapshot in snapshots {
        if !snapshot.valid {
            continue;
        }
        match best {
            None => best = Some(snapshot),
            Some(current) => {
                if snapshot.mtime_ms.unwrap_or(0.0) > current.mtime_ms.unwrap_or(0.0) {
                    best = Some(snapshot);
                }
            }
        }
    }
    best
}

/// TS `buildMetadataSection`.
pub fn build_metadata_section(
    storage_path: &str,
    snapshots: Vec<BackupSnapshotMetadata>,
) -> BackupMetadataSection {
    let latest_valid_path = latest_valid_snapshot(&snapshots).map(|s| s.path.clone());
    BackupMetadataSection {
        storage_path: storage_path.to_string(),
        latest_valid_path,
        snapshot_count: snapshots.len(),
        valid_snapshot_count: snapshots.iter().filter(|s| s.valid).count(),
        snapshots,
    }
}

fn newest_valid_snapshot<'a>(
    snapshots: &'a [BackupSnapshotMetadata],
    kinds: Option<&[BackupSnapshotKind]>,
) -> Option<&'a BackupSnapshotMetadata> {
    let mut best: Option<&BackupSnapshotMetadata> = None;
    for snapshot in snapshots {
        if !snapshot.valid {
            continue;
        }
        if let Some(kinds) = kinds
            && !kinds.contains(&snapshot.kind)
        {
            continue;
        }
        match best {
            None => best = Some(snapshot),
            Some(current) => {
                let candidate_priority = snapshot.kind.account_priority();
                let current_priority = current.kind.account_priority();
                if candidate_priority > current_priority
                    || (candidate_priority == current_priority
                        && snapshot.mtime_ms.unwrap_or(0.0) > current.mtime_ms.unwrap_or(0.0))
                {
                    best = Some(snapshot);
                }
            }
        }
    }
    best
}

/// TS `selectLatestValidAccountPath` — kind-priority pick with WAL and
/// anything-valid fallbacks.
fn select_latest_valid_account_path(snapshots: &[BackupSnapshotMetadata]) -> Option<String> {
    const PREFERRED: [BackupSnapshotKind; 3] = [
        BackupSnapshotKind::AccountsDiscoveredBackup,
        BackupSnapshotKind::AccountsBackupHistory,
        BackupSnapshotKind::AccountsBackup,
    ];
    const WAL_ONLY: [BackupSnapshotKind; 1] = [BackupSnapshotKind::AccountsWal];
    newest_valid_snapshot(snapshots, Some(&PREFERRED))
        .or_else(|| newest_valid_snapshot(snapshots, Some(&WAL_ONLY)))
        .or_else(|| newest_valid_snapshot(snapshots, None))
        .map(|snapshot| snapshot.path.clone())
}

// ============================================================================
// WAL / flagged describers (storage.ts privates, canonical here)
// ============================================================================

fn invalid_wal_snapshot(
    path: &str,
    stats: crate::snapshot::SnapshotStats,
) -> BackupSnapshotMetadata {
    BackupSnapshotMetadata {
        kind: BackupSnapshotKind::AccountsWal,
        path: path.to_string(),
        exists: true,
        valid: false,
        bytes: stats.bytes,
        mtime_ms: stats.mtime_ms,
        ..Default::default()
    }
}

/// TS `describeAccountsWalSnapshot` — WAL parse + checksum + inner
/// normalization (non-throwing).
pub async fn describe_accounts_wal_snapshot(path: &str) -> BackupSnapshotMetadata {
    let stats = stat_snapshot(path).await;
    if !stats.exists {
        return BackupSnapshotMetadata {
            kind: BackupSnapshotKind::AccountsWal,
            path: path.to_string(),
            exists: false,
            valid: false,
            ..Default::default()
        };
    }
    let raw = match tokio::fs::read_to_string(path).await {
        Ok(raw) => raw,
        Err(_) => return invalid_wal_snapshot(path, stats),
    };
    let Some(entry) = safe_parse_json_with_context::<AccountsJournalEntry>(
        &raw,
        "storage.describeAccountsWalSnapshot",
    ) else {
        return invalid_wal_snapshot(path, stats);
    };
    if crate::misc::compute_sha256(&entry.content) != entry.checksum {
        return invalid_wal_snapshot(path, stats);
    }
    // Schema-invalid inner payloads still flow through the normalizer so
    // schemaErrors stay populated for observability; fail-closed on JSON
    // syntax errors only.
    let inner_data: Value = match serde_json::from_str(&entry.content) {
        Ok(inner_data) => inner_data,
        Err(_) => return invalid_wal_snapshot(path, stats),
    };
    let parsed = crate::parser::parse_and_normalize_storage(&inner_data);
    BackupSnapshotMetadata {
        kind: BackupSnapshotKind::AccountsWal,
        path: path.to_string(),
        index: None,
        exists: true,
        valid: parsed.normalized.is_some(),
        bytes: stats.bytes,
        mtime_ms: stats.mtime_ms,
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

/// TS `describeFlaggedSnapshot`.
pub async fn describe_flagged_snapshot(
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
    match crate::flagged::load_flagged_accounts_from_file(path).await {
        Ok(storage) => BackupSnapshotMetadata {
            kind,
            path: path.to_string(),
            index,
            exists: true,
            valid: true,
            bytes: stats.bytes,
            mtime_ms: stats.mtime_ms,
            version: Some(1),
            account_count: None,
            flagged_count: Some(storage.accounts.len()),
            schema_errors: None,
        },
        Err(error) => {
            let is_enoent = error.kind() == std::io::ErrorKind::NotFound
                || cma_core::fs_retry::code_of(&error) == Some("ENOENT");
            if !is_enoent {
                log.warn(
                    "Failed to inspect flagged snapshot",
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
// Builder (backup-metadata-builder.ts + storage.ts getBackupMetadata)
// ============================================================================

fn account_candidate_kind(candidate: &str, storage_path: &str) -> BackupSnapshotKind {
    if candidate == format!("{storage_path}.bak") {
        BackupSnapshotKind::AccountsBackup
    } else if candidate.starts_with(&format!("{storage_path}.bak.")) {
        BackupSnapshotKind::AccountsBackupHistory
    } else {
        BackupSnapshotKind::AccountsDiscoveredBackup
    }
}

fn flagged_candidate_kind(candidate: &str, flagged_path: &str) -> BackupSnapshotKind {
    if candidate == format!("{flagged_path}.bak") {
        BackupSnapshotKind::FlaggedBackup
    } else if candidate.starts_with(&format!("{flagged_path}.bak.")) {
        BackupSnapshotKind::FlaggedBackupHistory
    } else {
        BackupSnapshotKind::FlaggedDiscoveredBackup
    }
}

/// TS `getBackupMetadata()` — enumerate primary/WAL/backup/discovered
/// snapshots for accounts + flagged storage.
pub async fn get_backup_metadata() -> BackupMetadata {
    let storage_path = std::path::PathBuf::from(crate::facade::get_storage_path())
        .to_string_lossy()
        .into_owned();
    let flagged_path = crate::flagged::get_flagged_accounts_path();
    let wal_path = crate::backup_paths::get_accounts_wal_path(&storage_path);

    let account_candidates =
        crate::backups::get_accounts_backup_recovery_candidates_with_discovery(&storage_path)
            .await;
    let mut account_snapshots: Vec<BackupSnapshotMetadata> = vec![
        describe_account_snapshot(&storage_path, BackupSnapshotKind::AccountsPrimary, None).await,
        describe_accounts_wal_snapshot(&wal_path).await,
    ];
    for (index, candidate) in account_candidates.iter().enumerate() {
        let kind = account_candidate_kind(candidate, &storage_path);
        account_snapshots.push(describe_account_snapshot(candidate, kind, Some(index)).await);
    }

    let flagged_candidates =
        crate::backups::get_accounts_backup_recovery_candidates_with_discovery(&flagged_path)
            .await;
    let mut flagged_snapshots: Vec<BackupSnapshotMetadata> =
        vec![describe_flagged_snapshot(&flagged_path, BackupSnapshotKind::FlaggedPrimary, None).await];
    for (index, candidate) in flagged_candidates.iter().enumerate() {
        let kind = flagged_candidate_kind(candidate, &flagged_path);
        flagged_snapshots.push(describe_flagged_snapshot(candidate, kind, Some(index)).await);
    }

    let mut accounts_metadata = build_metadata_section(&storage_path, account_snapshots);
    let flagged_metadata = build_metadata_section(&flagged_path, flagged_snapshots);

    accounts_metadata.latest_valid_path =
        select_latest_valid_account_path(&accounts_metadata.snapshots)
            .or(accounts_metadata.latest_valid_path);

    BackupMetadata {
        accounts: accounts_metadata,
        flagged_accounts: flagged_metadata,
    }
}

// ============================================================================
// Tests (ported from test/backup-metadata.test.ts / -builder.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(
        kind: BackupSnapshotKind,
        path: &str,
        valid: bool,
        mtime_ms: Option<f64>,
    ) -> BackupSnapshotMetadata {
        BackupSnapshotMetadata {
            kind,
            path: path.to_string(),
            valid,
            exists: true,
            mtime_ms,
            ..Default::default()
        }
    }

    #[test]
    fn latest_valid_snapshot_prefers_newest_mtime() {
        let snapshots = vec![
            snap(BackupSnapshotKind::AccountsPrimary, "p", true, Some(10.0)),
            snap(BackupSnapshotKind::AccountsBackup, "b", true, Some(30.0)),
            snap(BackupSnapshotKind::AccountsWal, "w", false, Some(99.0)),
        ];
        assert_eq!(latest_valid_snapshot(&snapshots).unwrap().path, "b");
    }

    #[test]
    fn latest_valid_snapshot_missing_mtime_counts_as_zero() {
        let snapshots = vec![
            snap(BackupSnapshotKind::AccountsPrimary, "p", true, None),
            snap(BackupSnapshotKind::AccountsBackup, "b", true, Some(1.0)),
        ];
        assert_eq!(latest_valid_snapshot(&snapshots).unwrap().path, "b");
    }

    #[test]
    fn build_metadata_section_counts() {
        let snapshots = vec![
            snap(BackupSnapshotKind::AccountsPrimary, "p", true, Some(5.0)),
            snap(BackupSnapshotKind::AccountsBackup, "b", false, Some(9.0)),
        ];
        let section = build_metadata_section("p", snapshots);
        assert_eq!(section.snapshot_count, 2);
        assert_eq!(section.valid_snapshot_count, 1);
        assert_eq!(section.latest_valid_path.as_deref(), Some("p"));
    }

    #[test]
    fn account_selection_prefers_kind_priority_over_mtime() {
        // A valid discovered backup beats a NEWER plain backup (priority 4 >
        // 2), which beats WAL, which beats primary.
        let snapshots = vec![
            snap(BackupSnapshotKind::AccountsPrimary, "primary", true, Some(100.0)),
            snap(BackupSnapshotKind::AccountsWal, "wal", true, Some(90.0)),
            snap(BackupSnapshotKind::AccountsBackup, "bak", true, Some(80.0)),
            snap(
                BackupSnapshotKind::AccountsDiscoveredBackup,
                "disc",
                true,
                Some(1.0),
            ),
        ];
        assert_eq!(
            select_latest_valid_account_path(&snapshots).as_deref(),
            Some("disc")
        );
    }

    #[test]
    fn account_selection_falls_back_to_wal_then_primary() {
        let wal_only = vec![
            snap(BackupSnapshotKind::AccountsPrimary, "primary", true, Some(5.0)),
            snap(BackupSnapshotKind::AccountsWal, "wal", true, Some(1.0)),
        ];
        assert_eq!(
            select_latest_valid_account_path(&wal_only).as_deref(),
            Some("wal")
        );
        let primary_only = vec![snap(
            BackupSnapshotKind::AccountsPrimary,
            "primary",
            true,
            Some(5.0),
        )];
        assert_eq!(
            select_latest_valid_account_path(&primary_only).as_deref(),
            Some("primary")
        );
        let none_valid = vec![snap(
            BackupSnapshotKind::AccountsBackup,
            "bak",
            false,
            Some(5.0),
        )];
        assert_eq!(select_latest_valid_account_path(&none_valid), None);
    }

    #[test]
    fn account_selection_ties_break_by_mtime_within_priority() {
        let snapshots = vec![
            snap(
                BackupSnapshotKind::AccountsBackupHistory,
                "old-history",
                true,
                Some(10.0),
            ),
            snap(
                BackupSnapshotKind::AccountsBackupHistory,
                "new-history",
                true,
                Some(20.0),
            ),
        ];
        assert_eq!(
            select_latest_valid_account_path(&snapshots).as_deref(),
            Some("new-history")
        );
    }

    #[test]
    fn candidate_kind_classification() {
        let p = "/x/openai-codex-accounts.json";
        assert_eq!(
            account_candidate_kind(&format!("{p}.bak"), p),
            BackupSnapshotKind::AccountsBackup
        );
        assert_eq!(
            account_candidate_kind(&format!("{p}.bak.2"), p),
            BackupSnapshotKind::AccountsBackupHistory
        );
        assert_eq!(
            account_candidate_kind(&format!("{p}.2024"), p),
            BackupSnapshotKind::AccountsDiscoveredBackup
        );
        assert_eq!(
            flagged_candidate_kind(&format!("{p}.bak"), p),
            BackupSnapshotKind::FlaggedBackup
        );
    }

    #[test]
    fn mtime_serializes_without_trailing_zero_for_integral_values() {
        let snapshot = snap(
            BackupSnapshotKind::AccountsPrimary,
            "p",
            true,
            Some(1_753_500_000_000.0),
        );
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(serialized.contains("\"mtimeMs\":1753500000000"));
        assert!(!serialized.contains("1753500000000.0"));
        let fractional = snap(BackupSnapshotKind::AccountsPrimary, "p", true, Some(1.5));
        assert!(serde_json::to_string(&fractional).unwrap().contains("\"mtimeMs\":1.5"));
    }
}
