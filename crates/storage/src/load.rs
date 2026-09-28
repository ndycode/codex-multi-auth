//! Port of the accounts load pipeline from `lib/storage.ts`:
//! `loadAccounts`, `loadAccountsInternal` (the recovery ladder),
//! `loadAccountsFromJournal` (WAL replay), `loadAccountsForExport`
//! (side-effect-free), and the sync single-field readers
//! `readAffinityGenerationFromDisk` / `readPinAndGenFromDisk` (#474).
//!
//! Behavior source: spec 02 §5.4, §8, gotchas 2, 9, 12, 20, 26.
//!
//! Recovery ladder on a failed primary read: reset-marker → (ENOENT) legacy
//! project migration result → WAL (sha256 checksum) → discovered backups →
//! ENOENT ⇒ empty/missing-storage, else `None`. The happy path additionally
//! runs v1→v3 migration persists and synthetic-primary backup promotion.
//! All load-side persists are warn-only on failure.
//!
//! The legacy project-storage migration itself lives in
//! `crate::project_migration` (spec 02 §5.4–§5.5); this module wires it into
//! the load ladder with the right persist mode.
//!
//! R6 (ratified): `restoreEligible`/`restoreReason` stay OUT of the
//! serializable `AccountStorageV3` — they ride side-band on
//! [`LoadedAccountStorage`].

use std::fs;
use std::io;
use std::path::Path;

use cma_core::fs_retry::code_of;
use cma_core::json_io::ReadJsonError;
use cma_core::logger::create_logger;
use cma_core::schemas::journal::AccountsJournalEntry;
use cma_core::schemas::parse::safe_parse_json_with_context;
use serde_json::{Value, json};

use crate::backup_paths::{get_accounts_wal_path, get_intentional_reset_marker_path};
use crate::backups::{
    cleanup_stale_rotating_backup_artifacts,
    get_accounts_backup_recovery_candidates_with_discovery,
};
use crate::facade;
use crate::fixture_guards::looks_like_synthetic_fixture_storage;
use crate::misc::compute_sha256;
use crate::parser::{load_accounts_from_path, parse_storage_content};
use crate::project_migration::{MigrationPersist, migrate_legacy_project_storage_if_needed};
use crate::public_types::AccountStorageV3;

/// Restore-reason strings (in-memory only — never persisted).
pub const RESTORE_REASON_INTENTIONAL_RESET: &str = "intentional-reset";
pub const RESTORE_REASON_EMPTY_STORAGE: &str = "empty-storage";
pub const RESTORE_REASON_MISSING_STORAGE: &str = "missing-storage";

/// Side-band restore metadata (TS spliced `restoreEligible`/`restoreReason`
/// onto returned storage objects; R6 keeps them out of the serde struct).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestoreMetadata {
    pub restore_eligible: bool,
    pub restore_reason: &'static str,
}

/// A loaded storage plus optional restore metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedAccountStorage {
    pub storage: AccountStorageV3,
    pub restore: Option<RestoreMetadata>,
}

impl LoadedAccountStorage {
    fn plain(storage: AccountStorageV3) -> Self {
        Self {
            storage,
            restore: None,
        }
    }

    fn empty_with_metadata(restore_eligible: bool, restore_reason: &'static str) -> Self {
        Self {
            storage: AccountStorageV3::empty(),
            restore: Some(RestoreMetadata {
                restore_eligible,
                restore_reason,
            }),
        }
    }

    fn with_metadata(
        storage: AccountStorageV3,
        restore_eligible: bool,
        restore_reason: &'static str,
    ) -> Self {
        Self {
            storage,
            restore: Some(RestoreMetadata {
                restore_eligible,
                restore_reason,
            }),
        }
    }
}

/// Which persist function migrations/recovery use — `loadAccounts` persists
/// through the locked `saveAccounts`; transactions (which already hold the
/// storage lock) use the unlocked variant; `None` disables persists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistMigration {
    None,
    Locked,
    Unlocked,
}

impl PersistMigration {
    fn is_enabled(self) -> bool {
        self != PersistMigration::None
    }

    fn as_migration_persist(self) -> MigrationPersist {
        match self {
            PersistMigration::None => MigrationPersist::None,
            PersistMigration::Locked => MigrationPersist::Locked,
            PersistMigration::Unlocked => MigrationPersist::Unlocked,
        }
    }

    async fn persist(self, storage: &AccountStorageV3) -> Result<(), cma_core::errors::CodexError> {
        match self {
            PersistMigration::None => Ok(()),
            PersistMigration::Locked => crate::save::save_accounts(storage).await,
            PersistMigration::Unlocked => crate::save::save_accounts_unlocked(storage).await,
        }
    }
}

/// `loadAccounts()` = `loadAccountsInternal(saveAccounts)`.
pub async fn load_accounts() -> Option<LoadedAccountStorage> {
    load_accounts_internal(PersistMigration::Locked).await
}

/// `loadAccountsInternal(saveAccountsUnlocked)` — the transaction-side load:
/// the storage lock is already held, so migration/recovery persists go through
/// the UNLOCKED save. Returns the plain storage (restore metadata is
/// in-memory-only and not part of the transaction snapshot).
pub async fn load_accounts_unlocked() -> Option<AccountStorageV3> {
    load_accounts_internal(PersistMigration::Unlocked)
        .await
        .map(|loaded| loaded.storage)
}

fn is_enoent(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || code_of(error) == Some("ENOENT")
}

fn marker_exists(reset_marker_path: &str) -> bool {
    Path::new(reset_marker_path).exists()
}

/// `loadAccountsInternal(persistMigration)` — the full ladder (spec 02 §8.1).
pub async fn load_accounts_internal(persist: PersistMigration) -> Option<LoadedAccountStorage> {
    let log = create_logger("storage");
    let path = facade::get_storage_path();
    let reset_marker_path = get_intentional_reset_marker_path(&path);
    cleanup_stale_rotating_backup_artifacts(&path).await;
    let migrated_legacy_storage: Option<AccountStorageV3> = if persist.is_enabled() {
        // Commit mode never errors (persist failures are warn-only inside).
        migrate_legacy_project_storage_if_needed(persist.as_migration_persist())
            .await
            .unwrap_or(None)
    } else {
        None
    };

    match load_accounts_from_path(&path).await {
        Ok(parsed) => {
            if !parsed.schema_errors.is_empty() {
                log.warn(
                    "Account storage schema validation warnings",
                    Some(&json!({
                        "errors": parsed.schema_errors.iter().take(5).collect::<Vec<_>>(),
                    })),
                );
            }
            let normalized = parsed.normalized.clone();
            if let Some(normalized_storage) = &normalized
                && parsed.needs_version_migration()
            {
                log.info(
                    "Migrating account storage to v3",
                    Some(&json!({
                        "from": parsed.stored_version,
                        "to": 3,
                    })),
                );
                if persist.is_enabled()
                    && let Err(save_error) = persist.persist(normalized_storage).await
                {
                    log.warn(
                        "Failed to persist migrated storage",
                        Some(&json!({ "error": save_error.to_string() })),
                    );
                }
            }

            if marker_exists(&reset_marker_path) {
                return Some(LoadedAccountStorage::empty_with_metadata(
                    false,
                    RESTORE_REASON_INTENTIONAL_RESET,
                ));
            }

            if let Some(normalized_storage) = &normalized
                && normalized_storage.accounts.is_empty()
            {
                return Some(LoadedAccountStorage::with_metadata(
                    normalized_storage.clone(),
                    true,
                    RESTORE_REASON_EMPTY_STORAGE,
                ));
            }

            // Synthetic-primary promotion (gotcha 13, load side).
            let primary_looks_synthetic =
                looks_like_synthetic_fixture_storage(normalized.as_ref());
            if facade::storage_backup_enabled()
                && let Some(normalized_storage) = &normalized
                && primary_looks_synthetic
            {
                let backup_candidates =
                    get_accounts_backup_recovery_candidates_with_discovery(&path).await;
                for backup_path in backup_candidates {
                    if backup_path == path {
                        continue;
                    }
                    match load_accounts_from_path(&backup_path).await {
                        Ok(backup) => {
                            let Some(backup_normalized) = backup.normalized else {
                                continue;
                            };
                            if looks_like_synthetic_fixture_storage(Some(&backup_normalized)) {
                                continue;
                            }
                            if backup_normalized.accounts.is_empty() {
                                continue;
                            }
                            log.warn(
                                "Detected synthetic primary account storage; promoting backup",
                                Some(&json!({
                                    "path": path,
                                    "backupPath": backup_path,
                                    "primaryAccounts": normalized_storage.accounts.len(),
                                    "backupAccounts": backup_normalized.accounts.len(),
                                })),
                            );
                            if persist.is_enabled()
                                && let Err(persist_error) =
                                    persist.persist(&backup_normalized).await
                            {
                                log.warn(
                                    "Failed to persist promoted backup storage",
                                    Some(&json!({
                                        "path": path,
                                        "error": persist_error.to_string(),
                                    })),
                                );
                            }
                            return Some(LoadedAccountStorage::plain(backup_normalized));
                        }
                        Err(backup_error) => {
                            if !is_enoent(&backup_error) {
                                log.warn(
                                    "Failed to load candidate backup for synthetic-primary promotion",
                                    Some(&json!({
                                        "path": backup_path,
                                        "error": backup_error.to_string(),
                                    })),
                                );
                            }
                        }
                    }
                }
            }

            normalized.map(LoadedAccountStorage::plain)
        }
        Err(error) => {
            let enoent = is_enoent(&error);
            if marker_exists(&reset_marker_path) {
                return Some(LoadedAccountStorage::empty_with_metadata(
                    false,
                    RESTORE_REASON_INTENTIONAL_RESET,
                ));
            }
            if enoent && let Some(migrated) = migrated_legacy_storage {
                return Some(LoadedAccountStorage::plain(migrated));
            }

            if let Some(recovered) = load_accounts_from_journal(&path, false).await {
                if persist.is_enabled()
                    && let Err(persist_error) = persist.persist(&recovered).await
                {
                    log.warn(
                        "Failed to persist WAL-recovered storage",
                        Some(&json!({
                            "path": path,
                            "error": persist_error.to_string(),
                        })),
                    );
                }
                return Some(LoadedAccountStorage::plain(recovered));
            }
            if marker_exists(&reset_marker_path) {
                return Some(LoadedAccountStorage::empty_with_metadata(
                    false,
                    RESTORE_REASON_INTENTIONAL_RESET,
                ));
            }

            if facade::storage_backup_enabled() {
                let backup_candidates =
                    get_accounts_backup_recovery_candidates_with_discovery(&path).await;
                for backup_path in backup_candidates {
                    match load_accounts_from_path(&backup_path).await {
                        Ok(backup) => {
                            if !backup.schema_errors.is_empty() {
                                log.warn(
                                    "Backup account storage schema validation warnings",
                                    Some(&json!({
                                        "path": backup_path,
                                        "errors":
                                            backup.schema_errors.iter().take(5).collect::<Vec<_>>(),
                                    })),
                                );
                            }
                            if let Some(backup_normalized) = backup.normalized {
                                log.warn(
                                    "Recovered account storage from backup file",
                                    Some(&json!({
                                        "path": path,
                                        "backupPath": backup_path,
                                    })),
                                );
                                if persist.is_enabled()
                                    && let Err(persist_error) =
                                        persist.persist(&backup_normalized).await
                                {
                                    log.warn(
                                        "Failed to persist recovered backup storage",
                                        Some(&json!({
                                            "path": path,
                                            "error": persist_error.to_string(),
                                        })),
                                    );
                                }
                                return Some(LoadedAccountStorage::plain(backup_normalized));
                            }
                        }
                        Err(backup_error) => {
                            if !is_enoent(&backup_error) {
                                log.warn(
                                    "Failed to load backup account storage",
                                    Some(&json!({
                                        "path": backup_path,
                                        "error": backup_error.to_string(),
                                    })),
                                );
                            }
                        }
                    }
                }
            }

            if !enoent {
                log.error(
                    "Failed to load account storage",
                    Some(&json!({ "error": error.to_string() })),
                );
            }
            if enoent {
                return Some(LoadedAccountStorage::empty_with_metadata(
                    true,
                    RESTORE_REASON_MISSING_STORAGE,
                ));
            }
            None
        }
    }
}

/// `loadAccountsFromJournal(path, {silent})` — WAL replay (spec 02 §8.3):
/// reset-marker check before AND after the read; schema-guarded entry parse;
/// sha256 checksum; schema-invalid inner payloads still flow to the
/// normalizer (fail-closed on JSON syntax only).
pub async fn load_accounts_from_journal(
    path: impl AsRef<Path>,
    silent: bool,
) -> Option<AccountStorageV3> {
    let log = create_logger("storage");
    let path = path.as_ref();
    let wal_path = get_accounts_wal_path(path);
    let reset_marker_path = get_intentional_reset_marker_path(path);
    if marker_exists(&reset_marker_path) {
        return None;
    }

    let raw = match fs::read(&wal_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) => {
            if !is_enoent(&error) && !silent {
                log.warn(
                    "Failed to load account WAL journal",
                    Some(&json!({
                        "path": wal_path,
                        "error": error.to_string(),
                    })),
                );
            }
            return None;
        }
    };
    if marker_exists(&reset_marker_path) {
        return None;
    }

    let entry: AccountsJournalEntry =
        safe_parse_json_with_context(&raw, "storage.loadAccountsFromJournal")?;
    let computed = compute_sha256(&entry.content);
    if computed != entry.checksum {
        if !silent {
            log.warn(
                "Account journal checksum mismatch",
                Some(&json!({ "path": wal_path })),
            );
        }
        return None;
    }

    // Inner content: schema-guarded first; schema-invalid payloads fall to
    // the raw parse so schemaErrors semantics stay observable; a syntax
    // error here is fail-closed (None), unlike the primary read.
    let parsed = match parse_storage_content(&entry.content) {
        Ok(parsed) => parsed,
        Err(_) => return None,
    };
    let normalized = parsed.normalized?;
    if !silent {
        log.warn(
            "Recovered account storage from WAL journal",
            Some(&json!({
                "path": path.to_string_lossy(),
                "walPath": wal_path,
            })),
        );
    }
    Some(normalized)
}

/// `loadAccountsForExport()` — side-effect-free read for exports (spec 02
/// §8.6): marker check before AND after; ENOENT runs the legacy migration
/// with `commit:false` (no writes/unlinks); non-ENOENT errors PROPAGATE.
pub async fn load_accounts_for_export()
-> Result<Option<LoadedAccountStorage>, ReadJsonError> {
    let log = create_logger("storage");
    let path = facade::get_storage_path();
    let reset_marker_path = get_intentional_reset_marker_path(&path);

    if marker_exists(&reset_marker_path) {
        return Ok(Some(LoadedAccountStorage::empty_with_metadata(
            false,
            RESTORE_REASON_INTENTIONAL_RESET,
        )));
    }

    match load_accounts_from_path(&path).await {
        Ok(parsed) => {
            if !parsed.schema_errors.is_empty() {
                log.warn(
                    "Account storage schema validation warnings",
                    Some(&json!({
                        "errors": parsed.schema_errors.iter().take(5).collect::<Vec<_>>(),
                    })),
                );
            }
            if marker_exists(&reset_marker_path) {
                return Ok(Some(LoadedAccountStorage::empty_with_metadata(
                    false,
                    RESTORE_REASON_INTENTIONAL_RESET,
                )));
            }
            Ok(parsed.normalized.map(LoadedAccountStorage::plain))
        }
        Err(error) => {
            if marker_exists(&reset_marker_path) {
                return Ok(Some(LoadedAccountStorage::empty_with_metadata(
                    false,
                    RESTORE_REASON_INTENTIONAL_RESET,
                )));
            }
            if is_enoent(&error) {
                // Export-mode migration (`commit:false`) is side-effect-free;
                // its propagating (non-ENOENT) live re-read failures surface
                // through the same error channel as the primary read.
                let migrated = migrate_legacy_project_storage_if_needed(MigrationPersist::None)
                    .await
                    .map_err(|migration_error| {
                        ReadJsonError::Io(io::Error::other(migration_error))
                    })?;
                if marker_exists(&reset_marker_path) {
                    return Ok(Some(LoadedAccountStorage::empty_with_metadata(
                        false,
                        RESTORE_REASON_INTENTIONAL_RESET,
                    )));
                }
                return Ok(migrated.map(LoadedAccountStorage::plain));
            }
            Err(ReadJsonError::Io(error))
        }
    }
}

// ---------------------------------------------------------------------------
// Sync single-field readers (#474 — spec 02 §8.5)
// ---------------------------------------------------------------------------

fn read_non_negative_int_field(parsed: &Value, key: &str) -> Option<i64> {
    let raw = parsed.get(key)?.as_f64()?;
    if raw.is_finite() && raw.fract() == 0.0 && raw >= 0.0 {
        Some(raw as i64)
    } else {
        None
    }
}

/// `readAffinityGenerationFromDisk(path)` — 0 on ANY failure (missing file,
/// malformed JSON, transient I/O error). Callers apply
/// `max(inMemory, disk) + 1` before saving.
pub fn read_affinity_generation_from_disk(path: impl AsRef<Path>) -> i64 {
    let path = path.as_ref();
    if !path.exists() {
        return 0;
    }
    let Ok(bytes) = fs::read(path) else {
        return 0;
    };
    let Ok(parsed) =
        serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
        return 0;
    };
    read_non_negative_int_field(&parsed, "affinityGeneration").unwrap_or(0)
}

/// Result of [`read_pin_and_gen_from_disk`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinAndGen {
    pub pinned_account_index: Option<i64>,
    pub affinity_generation: i64,
}

/// `readPinAndGenFromDisk(path)` — `{pinnedAccountIndex: undefined,
/// affinityGeneration: 0}` on any failure.
pub fn read_pin_and_gen_from_disk(path: impl AsRef<Path>) -> PinAndGen {
    let path = path.as_ref();
    let failure = PinAndGen {
        pinned_account_index: None,
        affinity_generation: 0,
    };
    if !path.exists() {
        return failure;
    }
    let Ok(bytes) = fs::read(path) else {
        return failure;
    };
    let Ok(parsed) =
        serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
        return failure;
    };
    PinAndGen {
        pinned_account_index: read_non_negative_int_field(&parsed, "pinnedAccountIndex"),
        affinity_generation: read_non_negative_int_field(&parsed, "affinityGeneration")
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affinity_generation_reader_validates_and_defaults_to_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        // Missing file.
        assert_eq!(read_affinity_generation_from_disk(&path), 0);
        // Valid value.
        fs::write(&path, r#"{"version":3,"accounts":[],"activeIndex":0,"affinityGeneration":7}"#)
            .unwrap();
        assert_eq!(read_affinity_generation_from_disk(&path), 7);
        // Invalid values.
        fs::write(&path, r#"{"affinityGeneration":-1}"#).unwrap();
        assert_eq!(read_affinity_generation_from_disk(&path), 0);
        fs::write(&path, r#"{"affinityGeneration":1.5}"#).unwrap();
        assert_eq!(read_affinity_generation_from_disk(&path), 0);
        fs::write(&path, r#"{"affinityGeneration":"9"}"#).unwrap();
        assert_eq!(read_affinity_generation_from_disk(&path), 0);
        // Malformed JSON.
        fs::write(&path, "{oops").unwrap();
        assert_eq!(read_affinity_generation_from_disk(&path), 0);
    }

    #[test]
    fn pin_and_gen_reader_validates_both_fields_independently() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        assert_eq!(
            read_pin_and_gen_from_disk(&path),
            PinAndGen {
                pinned_account_index: None,
                affinity_generation: 0
            }
        );
        fs::write(
            &path,
            r#"{"pinnedAccountIndex":2,"affinityGeneration":5}"#,
        )
        .unwrap();
        assert_eq!(
            read_pin_and_gen_from_disk(&path),
            PinAndGen {
                pinned_account_index: Some(2),
                affinity_generation: 5
            }
        );
        // Invalid pin, valid gen.
        fs::write(
            &path,
            r#"{"pinnedAccountIndex":-3,"affinityGeneration":5}"#,
        )
        .unwrap();
        assert_eq!(
            read_pin_and_gen_from_disk(&path),
            PinAndGen {
                pinned_account_index: None,
                affinity_generation: 5
            }
        );
        // Malformed JSON drops both.
        fs::write(&path, "not-json").unwrap();
        assert_eq!(
            read_pin_and_gen_from_disk(&path),
            PinAndGen {
                pinned_account_index: None,
                affinity_generation: 0
            }
        );
    }

    #[tokio::test]
    async fn journal_replay_rejects_checksum_mismatch_and_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let wal = dir.path().join("a.json.wal");
        let content = r#"{"version":3,"accounts":[{"refreshToken":"rt","addedAt":1,"lastUsed":2}],"activeIndex":0}"#;
        // Valid WAL replays.
        let entry = json!({
            "version": 1,
            "createdAt": 1,
            "path": path.to_string_lossy(),
            "checksum": compute_sha256(content),
            "content": content,
        });
        fs::write(&wal, serde_json::to_string(&entry).unwrap()).unwrap();
        let recovered = load_accounts_from_journal(&path, true).await.expect("replays");
        assert_eq!(recovered.accounts.len(), 1);

        // Checksum mismatch invalidates.
        let bad = json!({
            "version": 1,
            "checksum": "deadbeef",
            "content": content,
        });
        fs::write(&wal, serde_json::to_string(&bad).unwrap()).unwrap();
        assert!(load_accounts_from_journal(&path, true).await.is_none());

        // Reset marker blocks replay entirely.
        fs::write(&wal, serde_json::to_string(&entry).unwrap()).unwrap();
        fs::write(dir.path().join("a.json.reset-intent"), "x").unwrap();
        assert!(load_accounts_from_journal(&path, true).await.is_none());
    }

    #[tokio::test]
    async fn journal_replay_is_fail_closed_on_inner_syntax_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        let wal = dir.path().join("a.json.wal");
        let content = "{not json";
        let entry = json!({
            "version": 1,
            "checksum": compute_sha256(content),
            "content": content,
        });
        fs::write(&wal, serde_json::to_string(&entry).unwrap()).unwrap();
        assert!(load_accounts_from_journal(&path, true).await.is_none());
    }

    #[tokio::test]
    async fn journal_missing_wal_returns_none_silently() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            load_accounts_from_journal(&dir.path().join("a.json"), false)
                .await
                .is_none()
        );
    }
}
