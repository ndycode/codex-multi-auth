//! Port of `lib/storage/import-export.ts` + `lib/storage/account-port.ts`
//! and the `exportAccounts` / `importAccounts` wiring from `lib/storage.ts`
//! (spec 02 §12.1–§12.2).
//!
//! - Export payload (§3.7): `{version, accounts, activeIndex,
//!   activeIndexByFamily}` — **deliberately omits `pinnedAccountIndex` and
//!   `affinityGeneration`** (gotcha 1): exports are portable snapshots, pins
//!   are machine-local.
//! - Export source selection is transaction-aware (gotcha 11): an active
//!   transaction on the SAME path uses the in-memory snapshot; a transaction
//!   on a DIFFERENT path uses the unlocked read; otherwise a locked read.
//! - Import: 4 MiB cap, 20-account cap (dedupe first), pin re-resolved BY
//!   IDENTITY against the deduplicated list (#474), count arithmetic
//!   verbatim (gotcha 29 — do not clamp).

// `CodexError` is core's frozen error shape (192 bytes); the sibling-crate API
// contract pins these `Result<_, CodexError>` signatures, so boxing is not an
// option here.
#![allow(clippy::result_large_err)]

use std::io;
use std::path::Path;

use serde_json::{Map, Value, json};

use cma_core::constants::ACCOUNT_LIMITS;
use cma_core::errors::CodexError;
use cma_core::fs_retry::{code_of, should_retry_file_operation};
use cma_core::logger::create_logger;
use cma_core::schemas::account_storage::AccountStorageV3;
use cma_core::temp_path::temp_path_for_str;
use cma_core::utils::sleep;

use crate::matching::{AccountMatchOptions, deduplicate_accounts, find_matching_account_index};

const EXPORT_RENAME_MAX_ATTEMPTS: u32 = 4;
const EXPORT_RENAME_BASE_DELAY_MS: u64 = 25;
const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024;

/// Hook invoked right before the final export rename (named-backup
/// containment re-check). Synchronous in the Rust port.
pub type BeforeCommitHook<'a> = &'a (dyn Fn(&str) -> Result<(), CodexError> + Send + Sync);

fn io_to_codex(error: io::Error) -> CodexError {
    let mapped = CodexError::new(error.to_string());
    match code_of(&error) {
        Some(code) => mapped.with_code(code).with_cause(error),
        None => mapped.with_cause(error),
    }
}

fn read_json_to_codex(error: cma_core::json_io::ReadJsonError) -> CodexError {
    match error {
        cma_core::json_io::ReadJsonError::Io(io_error) => io_to_codex(io_error),
        cma_core::json_io::ReadJsonError::Parse(parse_error) => {
            CodexError::new(parse_error.to_string())
        }
    }
}

/// `resolvePath` boundary with its frozen `Error` messages surfaced as plain
/// `CodexError`s (TS throws bare `Error`s the CLI matches on).
fn resolve_path_string(file_path: &str) -> Result<String, CodexError> {
    match crate::paths::resolve_path(file_path) {
        Ok(path) => Ok(path.to_string_lossy().into_owned()),
        Err(error) => Err(CodexError::new(error.0)),
    }
}

async fn rename_export_file_with_retry(
    source_path: &str,
    destination_path: &str,
) -> io::Result<()> {
    for attempt in 0..EXPORT_RENAME_MAX_ATTEMPTS {
        match tokio::fs::rename(source_path, destination_path).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                // storage-07: shared retryable-code set (adds
                // ENOTEMPTY/EACCES) rather than a local subset.
                let can_retry = should_retry_file_operation(&error)
                    && attempt + 1 < EXPORT_RENAME_MAX_ATTEMPTS;
                if !can_retry {
                    return Err(error);
                }
                sleep(EXPORT_RENAME_BASE_DELAY_MS * 2u64.pow(attempt)).await;
            }
        }
    }
    unreachable!("loop returns before exhausting attempts");
}

/// Best-effort removal of the staged export temp file, retried on transient
/// Windows locks. The temp file briefly holds the full account export
/// (refresh tokens) — a single-shot unlink losing to a transient lock would
/// strand a secret-bearing `.tmp` next to the destination. Never fails.
async fn unlink_export_file_best_effort(temp_path: &str) {
    for attempt in 0..EXPORT_RENAME_MAX_ATTEMPTS {
        match tokio::fs::remove_file(temp_path).await {
            Ok(()) => return,
            Err(error) => {
                if error.kind() == io::ErrorKind::NotFound {
                    return; // already gone (e.g. rename consumed it)
                }
                let can_retry = should_retry_file_operation(&error)
                    && attempt + 1 < EXPORT_RENAME_MAX_ATTEMPTS;
                if !can_retry {
                    return; // give up silently; cleanup is best-effort
                }
                sleep(EXPORT_RENAME_BASE_DELAY_MS * 2u64.pow(attempt)).await;
            }
        }
    }
}

/// Build the §3.7 export payload: `version, accounts, activeIndex,
/// activeIndexByFamily` — pin/generation omitted on purpose.
fn build_export_payload(storage: &AccountStorageV3) -> Value {
    let mut object = Map::new();
    object.insert("version".to_string(), Value::from(3));
    object.insert(
        "accounts".to_string(),
        serde_json::to_value(&storage.accounts).unwrap_or(Value::Array(Vec::new())),
    );
    object.insert("activeIndex".to_string(), Value::from(storage.active_index));
    if let Some(by_family) = &storage.active_index_by_family {
        object.insert(
            "activeIndexByFamily".to_string(),
            serde_json::to_value(by_family).unwrap_or(Value::Object(Map::new())),
        );
    }
    Value::Object(object)
}

/// Node `fs.writeFile(..., { mode: 0o600 })` parity: mode applied atomically
/// at open(2) on unix so the export temp file (refresh-token material) never
/// exists with broader permissions — no write-then-chmod window.
async fn write_file_mode_600(path: &str, content: &str) -> io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    use tokio::io::AsyncWriteExt;
    file.write_all(content.as_bytes()).await?;
    file.flush().await?;
    Ok(())
}

/// TS `exportAccountsToFile` — atomic export with the frozen error strings.
pub async fn export_accounts_to_file(
    resolved_path: &str,
    force: bool,
    storage: Option<&AccountStorageV3>,
    before_commit: Option<BeforeCommitHook<'_>>,
) -> Result<(), CodexError> {
    let log = create_logger("storage");
    if !force && Path::new(resolved_path).exists() {
        return Err(CodexError::new(format!(
            "File already exists: {resolved_path}"
        )));
    }
    let storage = match storage {
        Some(storage) if !storage.accounts.is_empty() => storage,
        _ => return Err(CodexError::new("No accounts to export")),
    };

    if let Some(parent) = Path::new(resolved_path).parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io_to_codex)?;
    }
    if let Some(before_commit) = before_commit {
        before_commit(resolved_path)?;
    }
    // TOCTOU narrowing: re-check after mkdir + beforeCommit.
    if !force && Path::new(resolved_path).exists() {
        return Err(CodexError::new(format!(
            "File already exists: {resolved_path}"
        )));
    }

    let content = cma_core::json_io::stringify_pretty2(&build_export_payload(storage));
    let temp_path = temp_path_for_str(resolved_path);
    let write_attempt = async {
        write_file_mode_600(&temp_path, &content).await?;
        rename_export_file_with_retry(&temp_path, resolved_path).await
    }
    .await;
    if let Err(error) = write_attempt {
        unlink_export_file_best_effort(&temp_path).await;
        return Err(io_to_codex(error));
    }
    log.info(
        "Exported accounts",
        Some(&json!({ "path": resolved_path, "count": storage.accounts.len() })),
    );
    Ok(())
}

/// TS `readImportFile` — size-capped, JSON-boundary-guarded import read.
pub async fn read_import_file(resolved_path: &str) -> Result<AccountStorageV3, CodexError> {
    if !Path::new(resolved_path).exists() {
        return Err(CodexError::new(format!(
            "Import file not found: {resolved_path}"
        )));
    }

    let metadata = tokio::fs::metadata(resolved_path)
        .await
        .map_err(io_to_codex)?;
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(CodexError::new(format!(
            "Import file exceeds maximum size of {MAX_IMPORT_BYTES} bytes: {resolved_path}"
        )));
    }
    let content = tokio::fs::read_to_string(resolved_path)
        .await
        .map_err(io_to_codex)?;

    // Zod-first in TS; both the validated and the raw path feed the same
    // normalizer, so a single parse is behaviorally equivalent. Syntax errors
    // map to the frozen "Invalid JSON" message; structurally-unknown payloads
    // flow to the normalizer (legacy shapes).
    let imported: Value = serde_json::from_str(&content).map_err(|_| {
        CodexError::new(format!("Invalid JSON in import file: {resolved_path}"))
    })?;

    crate::normalize::normalize_account_storage(&imported)
        .ok_or_else(|| CodexError::new("Invalid account storage format"))
}

/// Result of [`merge_imported_accounts`]. Counts reproduce the TS arithmetic
/// verbatim — they can go negative in edge cases (gotcha 29); do not clamp.
#[derive(Clone, Debug)]
pub struct MergedImport {
    pub new_storage: AccountStorageV3,
    pub imported: i64,
    pub total: i64,
    pub skipped: i64,
}

/// TS `mergeImportedAccounts`.
pub fn merge_imported_accounts(
    existing: Option<&AccountStorageV3>,
    imported: &AccountStorageV3,
    max_accounts: usize,
) -> Result<MergedImport, CodexError> {
    let existing_accounts = existing.map(|s| s.accounts.clone()).unwrap_or_default();
    let existing_active_index = existing.map(|s| s.active_index).unwrap_or(0);
    // Resolve the pinned account by IDENTITY before merging — dedupe below
    // can move accounts to different positions (#474).
    let pinned_account = existing
        .and_then(|s| s.pinned_account_index)
        .and_then(|index| usize::try_from(index).ok())
        .and_then(|index| existing_accounts.get(index).cloned());

    let mut merged = existing_accounts.clone();
    merged.extend(imported.accounts.iter().cloned());

    if merged.len() > max_accounts {
        let deduped = deduplicate_accounts(&merged);
        if deduped.len() > max_accounts {
            return Err(CodexError::new(format!(
                "Import would exceed maximum of {max_accounts} accounts (would have {})",
                deduped.len()
            )));
        }
    }

    let deduplicated_accounts = deduplicate_accounts(&merged);
    let deduplicated_existing_accounts = deduplicate_accounts(&existing_accounts);
    let mut new_storage = AccountStorageV3 {
        version: Default::default(),
        accounts: deduplicated_accounts,
        active_index: existing_active_index,
        active_index_by_family: existing.and_then(|s| s.active_index_by_family.clone()),
        pinned_account_index: None,
        affinity_generation: None,
    };
    // Preserve the manual pin (#474) by re-resolving it against the deduped
    // list; drop it when the pinned account no longer resolves.
    if let Some(pinned_account) = &pinned_account
        && let Some(remapped_index) = find_matching_account_index(
            &new_storage.accounts,
            pinned_account,
            AccountMatchOptions::default(),
        )
    {
        new_storage.pinned_account_index = Some(remapped_index as i64);
    }
    if let Some(affinity_generation) = existing.and_then(|s| s.affinity_generation) {
        new_storage.affinity_generation = Some(affinity_generation);
    }
    let imported_count =
        new_storage.accounts.len() as i64 - deduplicated_existing_accounts.len() as i64;
    let skipped_count = imported.accounts.len() as i64 - imported_count;
    Ok(MergedImport {
        total: new_storage.accounts.len() as i64,
        imported: imported_count,
        skipped: skipped_count,
        new_storage,
    })
}

/// TS `exportAccounts(filePath, force = true, beforeCommit?)` — resolves the
/// destination through the `resolvePath` security boundary and selects the
/// storage source transaction-awareness first (spec §11).
pub async fn export_accounts(
    file_path: &str,
    force: bool,
    before_commit: Option<BeforeCommitHook<'_>>,
) -> Result<(), CodexError> {
    let resolved_path = resolve_path_string(file_path)?;
    let current_storage_path = std::path::PathBuf::from(crate::facade::get_storage_path());
    let transaction_state = crate::transactions::get_transaction_snapshot_state();

    let storage: Option<AccountStorageV3> = match &transaction_state {
        Some(state) if state.active && state.storage_path == current_storage_path => {
            state.snapshot()
        }
        Some(state) if state.active => crate::load::load_accounts_for_export()
            .await
            .map_err(read_json_to_codex)?
            .map(|loaded| loaded.storage),
        _ => crate::transactions::with_storage_lock(crate::load::load_accounts_for_export)
            .await
            .map_err(read_json_to_codex)?
            .map(|loaded| loaded.storage),
    };

    export_accounts_to_file(&resolved_path, force, storage.as_ref(), before_commit).await
}

/// Import summary returned by [`import_accounts`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImportSummary {
    pub imported: i64,
    pub total: i64,
    pub skipped: i64,
}

/// TS `importAccounts(filePath)` — merge under the account-storage
/// transaction.
pub async fn import_accounts(file_path: &str) -> Result<ImportSummary, CodexError> {
    let log = create_logger("storage");
    let resolved_path = resolve_path_string(file_path)?;
    let normalized = read_import_file(&resolved_path).await?;

    let result = crate::transactions::with_account_storage_transaction(
        move |existing, persist| async move {
            let merged = merge_imported_accounts(
                existing.as_ref(),
                &normalized,
                ACCOUNT_LIMITS.max_accounts,
            )?;
            persist.persist(&merged.new_storage).await?;
            Ok(ImportSummary {
                imported: merged.imported,
                total: merged.total,
                skipped: merged.skipped,
            })
        },
    )
    .await?;

    log.info(
        "Imported accounts",
        Some(&json!({
            "path": resolved_path,
            "imported": result.imported,
            "skipped": result.skipped,
            "total": result.total,
        })),
    );
    Ok(result)
}

// ============================================================================
// Tests (ported from test/import-export.test.ts merge/count suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{ActiveIndexByFamily, AccountMetadataV3};

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
    fn merge_appends_new_accounts_and_counts() {
        let existing = storage(vec![account("a", "rt_a", 10)]);
        let imported = storage(vec![account("b", "rt_b", 10)]);
        let merged = merge_imported_accounts(Some(&existing), &imported, 20).expect("merges");
        assert_eq!(merged.new_storage.accounts.len(), 2);
        assert_eq!(merged.imported, 1);
        assert_eq!(merged.total, 2);
        assert_eq!(merged.skipped, 0);
    }

    #[test]
    fn merge_dedupes_and_reports_skipped() {
        let existing = storage(vec![account("a", "rt_a", 10)]);
        let imported = storage(vec![account("a", "rt_a2", 20), account("b", "rt_b", 5)]);
        let merged = merge_imported_accounts(Some(&existing), &imported, 20).expect("merges");
        assert_eq!(merged.new_storage.accounts.len(), 2);
        // Newest content for the duplicate identity survives.
        assert_eq!(merged.new_storage.accounts[0].refresh_token, "rt_a2");
        assert_eq!(merged.imported, 1);
        assert_eq!(merged.skipped, 1);
    }

    #[test]
    fn merge_keeps_existing_active_index_verbatim() {
        let mut existing = storage(vec![account("a", "rt_a", 10)]);
        existing.active_index = 7; // NOT re-resolved / clamped here (gotcha 30)
        existing.active_index_by_family = Some(ActiveIndexByFamily {
            codex: Some(1),
            ..Default::default()
        });
        let imported = storage(vec![account("b", "rt_b", 10)]);
        let merged = merge_imported_accounts(Some(&existing), &imported, 20).expect("merges");
        assert_eq!(merged.new_storage.active_index, 7);
        assert_eq!(
            merged
                .new_storage
                .active_index_by_family
                .as_ref()
                .and_then(|f| f.codex),
            Some(1)
        );
    }

    #[test]
    fn merge_enforces_max_after_dedupe() {
        let existing = storage(vec![account("a", "rt_a", 10), account("b", "rt_b", 10)]);
        let imported = storage(vec![
            account("c", "rt_c", 10),
            account("d", "rt_d", 10),
        ]);
        let error =
            merge_imported_accounts(Some(&existing), &imported, 3).expect_err("over cap");
        assert_eq!(
            error.message(),
            "Import would exceed maximum of 3 accounts (would have 4)"
        );
        // Duplicates shrink below the cap ⇒ allowed.
        let duplicate_import = storage(vec![account("a", "rt_a", 20), account("c", "rt_c", 10)]);
        let merged =
            merge_imported_accounts(Some(&existing), &duplicate_import, 3).expect("fits");
        assert_eq!(merged.new_storage.accounts.len(), 3);
    }

    #[test]
    fn merge_reresolves_pin_by_identity_and_preserves_generation() {
        let mut existing = storage(vec![account("a", "rt_a", 10), account("b", "rt_b", 30)]);
        existing.pinned_account_index = Some(1); // pins "b"
        existing.affinity_generation = Some(6);
        // Import a newer copy of "b" that dedupes into position 1 anyway,
        // plus an "a" duplicate whose newest content wins slot 0.
        let imported = storage(vec![account("b", "rt_b_new", 40)]);
        let merged = merge_imported_accounts(Some(&existing), &imported, 20).expect("merges");
        assert_eq!(merged.new_storage.pinned_account_index, Some(1));
        assert_eq!(merged.new_storage.affinity_generation, Some(6));
        assert_eq!(merged.new_storage.accounts[1].refresh_token, "rt_b_new");
    }

    #[test]
    fn merge_drops_unresolvable_pin() {
        let mut existing = storage(vec![account("a", "rt_a", 10)]);
        existing.pinned_account_index = Some(5); // out of range ⇒ no pinned account
        let imported = storage(vec![account("b", "rt_b", 10)]);
        let merged = merge_imported_accounts(Some(&existing), &imported, 20).expect("merges");
        assert_eq!(merged.new_storage.pinned_account_index, None);
    }

    #[test]
    fn merge_with_no_existing_storage() {
        let imported = storage(vec![account("a", "rt_a", 10)]);
        let merged = merge_imported_accounts(None, &imported, 20).expect("merges");
        assert_eq!(merged.new_storage.active_index, 0);
        assert_eq!(merged.imported, 1);
        assert_eq!(merged.total, 1);
        assert_eq!(merged.skipped, 0);
    }

    #[test]
    fn export_payload_omits_pin_and_generation() {
        let mut s = storage(vec![account("a", "rt_a", 10)]);
        s.pinned_account_index = Some(0);
        s.affinity_generation = Some(9);
        s.active_index_by_family = Some(ActiveIndexByFamily {
            gpt5_codex: Some(0),
            ..Default::default()
        });
        let payload = build_export_payload(&s);
        let object = payload.as_object().expect("object");
        let keys: Vec<&String> = object.keys().collect();
        assert_eq!(keys, ["version", "accounts", "activeIndex", "activeIndexByFamily"]);
        assert!(object.get("pinnedAccountIndex").is_none());
        assert!(object.get("affinityGeneration").is_none());
    }

    #[test]
    fn export_payload_omits_missing_active_index_by_family() {
        let s = storage(vec![account("a", "rt_a", 10)]);
        let payload = build_export_payload(&s);
        assert!(payload.get("activeIndexByFamily").is_none());
    }
}
