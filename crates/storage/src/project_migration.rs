//! Port of `lib/storage/project-migration.ts` (spec 02 §5.4–§5.5).
//!
//! - [`load_normalized_storage_from_path`]: warn + `None` on any failure
//!   (non-ENOENT failures logged) — the tolerant read used by the legacy
//!   project-storage migration and the synthetic-fixture save guard.
//! - [`merge_storage_for_migration`]: pin captured BY IDENTITY **before** the
//!   merge (gotcha 8) — `normalizeAccountStorage` only range-validates the
//!   pin, so it must be re-pointed (or cleared) after dedupe.
//!
//! The `migrateLegacyProjectStorageIfNeeded` ladder itself is private to
//! `lib/storage.ts` and lives in `crate::load` (commit mode) /
//! `crate::load::load_accounts_for_export` (export mode) — this module only
//! provides the two helpers project-migration.ts exports (gotcha 35: one
//! canonical copy, no divergent duplicates).

use std::io;
use std::path::Path;

use serde_json::{Map, Value, json};

use cma_core::fs_retry::code_of;
use cma_core::logger::create_logger;
use cma_core::schemas::account_storage::AccountStorageV3;

use crate::matching::{AccountMatchOptions, find_matching_account_index};

fn is_enoent(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || code_of(error) == Some("ENOENT")
}

/// TS `loadNormalizedStorageFromPath(path, label)` — warn + `None` on any
/// failure (non-ENOENT failures logged; schema warnings truncated to the
/// first 5 like the storage loader).
pub async fn load_normalized_storage_from_path(
    path: impl AsRef<Path>,
    label: &str,
) -> Option<AccountStorageV3> {
    let log = create_logger("storage");
    let path = path.as_ref();
    let path_display = path.to_string_lossy();
    match crate::parser::load_accounts_from_path(path).await {
        Ok(parsed) => {
            if !parsed.schema_errors.is_empty() {
                let errors: Vec<&String> = parsed.schema_errors.iter().take(5).collect();
                log.warn(
                    &format!("{label} schema validation warnings"),
                    Some(&json!({ "path": path_display, "errors": errors })),
                );
            }
            parsed.normalized
        }
        Err(error) => {
            if !is_enoent(&error) {
                log.warn(
                    &format!("Failed to load {label}"),
                    Some(&json!({ "path": path_display, "error": error.to_string() })),
                );
            }
            None
        }
    }
}

/// TS `mergeStorageForMigration(current, incoming, normalize, findMatch)`.
///
/// `current == None` ⇒ incoming verbatim. Otherwise the concatenated account
/// list is pushed through `normalizeAccountStorage` (dedupe + index
/// re-resolution); normalize failure returns `current` unchanged. A manual
/// pin is captured by index BEFORE the merge and re-resolved by identity
/// afterwards — cleared when the pinned account no longer resolves (#474).
pub fn merge_storage_for_migration(
    current: Option<&AccountStorageV3>,
    incoming: &AccountStorageV3,
) -> AccountStorageV3 {
    let Some(current) = current else {
        return incoming.clone();
    };

    // Resolve the pinned account by IDENTITY before merging (#474).
    let pinned_account = current
        .pinned_account_index
        .and_then(|index| usize::try_from(index).ok())
        .and_then(|index| current.accounts.get(index).cloned());

    let mut payload = Map::new();
    payload.insert("version".to_string(), Value::from(3));
    payload.insert("activeIndex".to_string(), Value::from(current.active_index));
    if let Some(by_family) = &current.active_index_by_family {
        payload.insert(
            "activeIndexByFamily".to_string(),
            serde_json::to_value(by_family).unwrap_or(Value::Object(Map::new())),
        );
    }
    let mut merged_accounts: Vec<Value> = Vec::new();
    for account in current.accounts.iter().chain(incoming.accounts.iter()) {
        merged_accounts.push(serde_json::to_value(account).unwrap_or(Value::Null));
    }
    payload.insert("accounts".to_string(), Value::Array(merged_accounts));
    // Carry the manual pin (#474) and affinity generation through the
    // migration; the normalizer validates/clamps them against the merged
    // list.
    if let Some(pinned_index) = current.pinned_account_index {
        payload.insert("pinnedAccountIndex".to_string(), Value::from(pinned_index));
    }
    if let Some(affinity_generation) = current.affinity_generation {
        payload.insert(
            "affinityGeneration".to_string(),
            Value::from(affinity_generation),
        );
    }

    let Some(mut merged) = crate::normalize::normalize_account_storage(&Value::Object(payload))
    else {
        return current.clone();
    };
    let Some(pinned_account) = pinned_account else {
        return merged;
    };
    // Re-point the pin at the account the user actually pinned; clear it when
    // that account no longer resolves in the normalized list.
    merged.pinned_account_index = find_matching_account_index(
        &merged.accounts,
        &pinned_account,
        AccountMatchOptions::default(),
    )
    .map(|index| index as i64);
    merged
}

// ============================================================================
// migrateLegacyProjectStorageIfNeeded (storage.ts private; canonical here,
// consumed by crate::load in both commit and export modes)
// ============================================================================

/// How a committed migration should persist the merged storage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationPersist {
    /// `saveAccounts` — takes the storage lock (default TS persist).
    Locked,
    /// `saveAccountsUnlocked` — the lock is already held
    /// (`loadAccountsInternal` inside a transaction).
    Unlocked,
    /// `commit: false` — export mode, no writes and no legacy unlinks.
    None,
}

async fn persist_merged(
    persist: MigrationPersist,
    storage: &AccountStorageV3,
) -> Result<(), cma_core::errors::CodexError> {
    match persist {
        MigrationPersist::Locked => crate::save::save_accounts(storage).await,
        MigrationPersist::Unlocked => crate::save::save_accounts_unlocked(storage).await,
        MigrationPersist::None => Ok(()),
    }
}

struct LiveCurrentStorage {
    exists: bool,
    storage: Option<AccountStorageV3>,
}

/// Export-mode-only live re-read of the current storage file (a concurrent
/// writer creating it mid-migration wins the race). Non-ENOENT read errors
/// PROPAGATE (spec §8.6).
async fn read_live_current_storage_if_export_mode(
    commit: bool,
    current_storage_path: &str,
) -> Result<LiveCurrentStorage, cma_core::errors::CodexError> {
    let log = create_logger("storage");
    if commit || !Path::new(current_storage_path).exists() {
        return Ok(LiveCurrentStorage {
            exists: false,
            storage: None,
        });
    }
    match crate::parser::load_accounts_from_path(current_storage_path).await {
        Ok(parsed) => {
            if !parsed.schema_errors.is_empty() {
                let errors: Vec<&String> = parsed.schema_errors.iter().take(5).collect();
                log.warn(
                    "current account storage schema validation warnings",
                    Some(&json!({ "path": current_storage_path, "errors": errors })),
                );
            }
            Ok(LiveCurrentStorage {
                exists: true,
                storage: parsed.normalized,
            })
        }
        Err(error) if is_enoent(&error) => Ok(LiveCurrentStorage {
            exists: false,
            storage: None,
        }),
        Err(error) => {
            let mapped = cma_core::errors::CodexError::new(error.to_string());
            Err(match code_of(&error) {
                Some(code) => mapped.with_code(code).with_cause(error),
                None => mapped.with_cause(error),
            })
        }
    }
}

/// TS `migrateLegacyProjectStorageIfNeeded({persist, commit})` — merge legacy
/// worktree/project storage files into the current project-scoped storage.
/// Returns the merged storage when anything migrated; else the loaded
/// current storage if the current file doesn't exist; else `None`. Commit
/// mode never errors (persist failures are warn-only); export-mode live
/// re-read failures propagate.
pub async fn migrate_legacy_project_storage_if_needed(
    persist: MigrationPersist,
) -> Result<Option<AccountStorageV3>, cma_core::errors::CodexError> {
    let log = create_logger("storage");
    let commit = persist != MigrationPersist::None;
    let state = crate::path_state::get_storage_path_state();
    let Some(current_storage_path) = state.current_storage_path.clone() else {
        return Ok(None);
    };

    let mut candidate_paths: Vec<String> = Vec::new();
    for candidate in [
        state.current_legacy_worktree_storage_path.as_ref(),
        state.current_legacy_project_storage_path.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if candidate.is_empty() || *candidate == current_storage_path {
            continue;
        }
        if !candidate_paths.contains(candidate) {
            candidate_paths.push(candidate.clone());
        }
    }
    if candidate_paths.is_empty() {
        return Ok(None);
    }

    let existing_candidate_paths: Vec<String> = candidate_paths
        .into_iter()
        .filter(|legacy_path| Path::new(legacy_path).exists())
        .collect();
    if existing_candidate_paths.is_empty() {
        return Ok(None);
    }

    let mut target_storage =
        load_normalized_storage_from_path(&current_storage_path, "current account storage").await;
    let mut migrated = false;

    for legacy_path in &existing_candidate_paths {
        let live_before_merge =
            read_live_current_storage_if_export_mode(commit, &current_storage_path).await?;
        if live_before_merge.exists {
            return Ok(live_before_merge.storage);
        }

        let Some(legacy_storage) =
            load_normalized_storage_from_path(legacy_path, "legacy account storage").await
        else {
            continue;
        };

        let live_after_legacy_read =
            read_live_current_storage_if_export_mode(commit, &current_storage_path).await?;
        if live_after_legacy_read.exists {
            return Ok(live_after_legacy_read.storage);
        }

        let merged_storage = merge_storage_for_migration(target_storage.as_ref(), &legacy_storage);
        let fallback_storage = target_storage.clone().or(Some(legacy_storage));

        if commit {
            match persist_merged(persist, &merged_storage).await {
                Ok(()) => {
                    target_storage = Some(merged_storage.clone());
                    migrated = true;
                }
                Err(error) => {
                    target_storage = fallback_storage;
                    log.warn(
                        "Failed to persist migrated account storage",
                        Some(&json!({
                            "from": legacy_path,
                            "to": current_storage_path,
                            "error": error.to_string(),
                        })),
                    );
                    continue;
                }
            }

            match tokio::fs::remove_file(legacy_path).await {
                Ok(()) => {}
                Err(unlink_error) => {
                    if !is_enoent(&unlink_error) {
                        log.warn(
                            "Failed to remove legacy account storage file after migration",
                            Some(&json!({
                                "path": legacy_path,
                                "error": unlink_error.to_string(),
                            })),
                        );
                    }
                }
            }

            log.info(
                "Migrated legacy project account storage",
                Some(&json!({
                    "from": legacy_path,
                    "to": current_storage_path,
                    "accounts": merged_storage.accounts.len(),
                })),
            );
            continue;
        }

        target_storage = Some(merged_storage);
        migrated = true;
    }

    if migrated {
        return Ok(target_storage);
    }
    if target_storage.is_some() && !Path::new(&current_storage_path).exists() {
        return Ok(target_storage);
    }
    Ok(None)
}

// ============================================================================
// Tests (merge semantics ported from the project-migration suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;

    fn account(id: &str, rt: &str, last_used: i64) -> AccountMetadataV3 {
        let mut a = AccountMetadataV3::new(rt, 1, last_used);
        a.account_id = Some(id.to_string());
        a.email = Some(format!("{id}@example.com"));
        a
    }

    fn storage(accounts: Vec<AccountMetadataV3>) -> AccountStorageV3 {
        let mut s = AccountStorageV3::empty();
        s.accounts = accounts;
        s
    }

    #[test]
    fn none_current_returns_incoming() {
        let incoming = storage(vec![account("a", "rt_a", 10)]);
        let merged = merge_storage_for_migration(None, &incoming);
        assert_eq!(merged, incoming);
    }

    #[test]
    fn merges_and_dedupes_accounts() {
        let current = storage(vec![account("a", "rt_a", 10)]);
        let incoming = storage(vec![account("a", "rt_a_new", 20), account("b", "rt_b", 5)]);
        let merged = merge_storage_for_migration(Some(&current), &incoming);
        assert_eq!(merged.accounts.len(), 2);
        // Newest content wins the duplicate identity's slot.
        assert_eq!(merged.accounts[0].refresh_token, "rt_a_new");
    }

    #[test]
    fn pin_is_captured_before_merge_and_reresolved_by_identity() {
        let mut current = storage(vec![account("a", "rt_a", 10), account("b", "rt_b", 30)]);
        current.pinned_account_index = Some(1); // pins "b"
        current.affinity_generation = Some(4);
        // Incoming duplicates "a" with newer content — dedupe keeps 2 slots,
        // pin must still point at "b".
        let incoming = storage(vec![account("a", "rt_a_new", 40)]);
        let merged = merge_storage_for_migration(Some(&current), &incoming);
        assert_eq!(merged.pinned_account_index, Some(1));
        assert_eq!(merged.affinity_generation, Some(4));
        assert_eq!(merged.accounts[1].refresh_token, "rt_b");
    }

    #[test]
    fn unresolvable_pin_is_cleared() {
        let mut current = storage(vec![account("a", "rt_a", 10)]);
        current.pinned_account_index = Some(7); // dangling ⇒ no pinned account
        let incoming = storage(vec![account("b", "rt_b", 10)]);
        let merged = merge_storage_for_migration(Some(&current), &incoming);
        assert_eq!(merged.pinned_account_index, None);
    }

    #[test]
    fn keeps_current_active_index_through_normalizer() {
        let mut current = storage(vec![account("a", "rt_a", 10), account("b", "rt_b", 20)]);
        current.active_index = 1;
        let incoming = storage(vec![account("c", "rt_c", 5)]);
        let merged = merge_storage_for_migration(Some(&current), &incoming);
        // Identity-follow keeps "b" active after the merge.
        assert_eq!(merged.active_index, 1);
        assert_eq!(merged.accounts.len(), 3);
    }
}
