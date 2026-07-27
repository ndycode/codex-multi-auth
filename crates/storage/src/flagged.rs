//! Port of `lib/storage/flagged-storage.ts`, `flagged-storage-file.ts`,
//! `flagged-storage-io.ts` and the flagged wiring/entries from
//! `lib/storage.ts` (spec 02 §3.5, §9).
//!
//! Key contracts:
//! - Every write goes through [`normalize_flagged_storage`]; the persisted
//!   field set is the normalizer's whitelist in EXACT insertion order
//!   (`refreshToken, addedAt, lastUsed, accountId, accountIdSource,
//!   accountLabel, email, accessToken, expiresAt, enabled, lastSwitchReason,
//!   rateLimitResetTimes, coolingDownUntil, cooldownReason, workspaces,
//!   currentWorkspaceIndex, flaggedAt, flaggedReason, lastError`) — NOT the
//!   schema declaration order (golden `flagged-v1.json`).
//! - Dedupe by trimmed `refreshToken`, **last occurrence wins** but the FIRST
//!   occurrence's position is kept (JS `Map.set` semantics).
//! - Load ladder: reset marker → primary (validity-checked) → `.bak`/`.bak.1`
//!   /`.bak.2` recovery (persisted via the UNLOCKED save when the storage
//!   lock is already held — deadlock avoidance) → legacy
//!   `openai-codex-blocked-accounts.json` migration.
//! - Save: single `.bak` snapshot, atomic temp+rename, marker unlink;
//!   errors are RAW (not `StorageError`) — code preserved on the
//!   [`CodexError`].
//! - Clear: `"reset"` marker FIRST; marker removed only when every deletion
//!   succeeded.

use std::io;
use std::path::Path;

use serde_json::{Map, Value, json};

use cma_core::errors::CodexError;
use cma_core::fs_retry::{Backoff, FILE_RETRY_CODES, RetryOptions, code_of, with_retry};
use cma_core::logger::create_logger;
use cma_core::schemas::account_storage::{
    AccountIdSource, CooldownReason, RateLimitStateV3, SwitchReason, Workspace,
};
use cma_core::schemas::flagged::{FlaggedAccountMetadataV1, FlaggedAccountStorageV1};
use cma_core::schemas::parse::number_to_i64_lossy;
use cma_core::temp_path::temp_path_for_str;
use cma_core::utils::{is_record, now_ms};

const FLAGGED_ACCOUNTS_FILE_NAME: &str = "openai-codex-flagged-accounts.json";
const LEGACY_FLAGGED_ACCOUNTS_FILE_NAME: &str = "openai-codex-blocked-accounts.json";

/// TS `getFlaggedAccountsPath()` — sibling of the accounts file.
pub fn get_flagged_accounts_path() -> String {
    crate::backup_paths::get_flagged_accounts_path(
        crate::facade::get_storage_path(),
        FLAGGED_ACCOUNTS_FILE_NAME,
    )
}

fn get_legacy_flagged_accounts_path() -> String {
    crate::backup_paths::get_legacy_flagged_accounts_path(
        crate::facade::get_storage_path(),
        LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
    )
}

fn io_to_codex(error: io::Error) -> CodexError {
    let mapped = CodexError::new(error.to_string());
    match code_of(&error) {
        Some(code) => mapped.with_code(code).with_cause(error),
        None => mapped.with_cause(error),
    }
}

// ============================================================================
// normalizeFlaggedStorage (flagged-storage.ts)
// ============================================================================

fn value_as_number(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => Some(number_to_i64_lossy(n)),
        _ => None,
    }
}

fn value_as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// TS `normalizeFlaggedStorage(data, {isRecord, now})` with an injectable
/// clock (called once per account whose `flaggedAt` is missing).
pub fn normalize_flagged_storage_with(
    data: &Value,
    now: &mut dyn FnMut() -> i64,
) -> FlaggedAccountStorageV1 {
    let is_version_1 = data
        .get("version")
        .and_then(Value::as_f64)
        .is_some_and(|version| version == 1.0);
    let accounts = data.get("accounts").and_then(Value::as_array);
    let (true, Some(raw_accounts)) = (is_record(data) && is_version_1, accounts) else {
        return FlaggedAccountStorageV1::empty();
    };

    // Keyed by refreshToken; last occurrence wins but the FIRST occurrence's
    // position is preserved (JS `Map.set`).
    let mut by_refresh_token: Vec<(String, FlaggedAccountMetadataV1)> = Vec::new();
    for raw_account in raw_accounts {
        if !is_record(raw_account) {
            continue;
        }
        let refresh_token = match raw_account.get("refreshToken") {
            Some(Value::String(s)) => s.trim().to_string(),
            _ => String::new(),
        };
        if refresh_token.is_empty() {
            continue;
        }

        let flagged_at = value_as_number(raw_account.get("flaggedAt")).unwrap_or_else(&mut *now);

        let rate_limit_reset_times: Option<RateLimitStateV3> = match raw_account
            .get("rateLimitResetTimes")
        {
            Some(map_value) if is_record(map_value) => {
                let mut normalized = RateLimitStateV3::new();
                if let Some(object) = map_value.as_object() {
                    for (key, value) in object {
                        if let Value::Number(n) = value {
                            normalized.insert(key.clone(), number_to_i64_lossy(n));
                        }
                    }
                }
                if normalized.is_empty() {
                    None
                } else {
                    Some(normalized)
                }
            }
            _ => None,
        };

        let account_id_source = raw_account
            .get("accountIdSource")
            .and_then(Value::as_str)
            .and_then(AccountIdSource::parse);
        let last_switch_reason = raw_account
            .get("lastSwitchReason")
            .and_then(Value::as_str)
            .and_then(SwitchReason::parse);
        let cooldown_reason = raw_account
            .get("cooldownReason")
            .and_then(Value::as_str)
            .and_then(CooldownReason::parse);

        // TS keeps any array verbatim (contents NOT validated); the typed
        // Rust struct requires parseable workspace entries — a malformed
        // array is dropped instead of passed through (recorded deviation).
        let workspaces: Option<Vec<Workspace>> = match raw_account.get("workspaces") {
            Some(Value::Array(_)) => {
                serde_json::from_value(raw_account.get("workspaces").unwrap().clone()).ok()
            }
            _ => None,
        };

        let normalized = FlaggedAccountMetadataV1 {
            account_id: value_as_string(raw_account.get("accountId")),
            account_id_source,
            account_label: value_as_string(raw_account.get("accountLabel")),
            email: value_as_string(raw_account.get("email")),
            refresh_token: refresh_token.clone(),
            access_token: value_as_string(raw_account.get("accessToken")),
            expires_at: value_as_number(raw_account.get("expiresAt")),
            enabled: match raw_account.get("enabled") {
                Some(Value::Bool(b)) => Some(*b),
                _ => None,
            },
            added_at: value_as_number(raw_account.get("addedAt")).unwrap_or(flagged_at),
            last_used: value_as_number(raw_account.get("lastUsed")).unwrap_or(flagged_at),
            last_switch_reason,
            rate_limit_reset_times,
            cooling_down_until: value_as_number(raw_account.get("coolingDownUntil")),
            cooldown_reason,
            workspaces,
            current_workspace_index: value_as_number(raw_account.get("currentWorkspaceIndex")),
            flagged_at,
            flagged_reason: value_as_string(raw_account.get("flaggedReason")),
            last_error: value_as_string(raw_account.get("lastError")),
            extra: Map::new(),
        };
        match by_refresh_token
            .iter_mut()
            .find(|(key, _)| *key == refresh_token)
        {
            Some(entry) => entry.1 = normalized,
            None => by_refresh_token.push((refresh_token, normalized)),
        }
    }

    FlaggedAccountStorageV1 {
        version: Default::default(),
        accounts: by_refresh_token
            .into_iter()
            .map(|(_, account)| account)
            .collect(),
    }
}

/// [`normalize_flagged_storage_with`] using the wall clock.
pub fn normalize_flagged_storage(data: &Value) -> FlaggedAccountStorageV1 {
    normalize_flagged_storage_with(data, &mut now_ms)
}

// ============================================================================
// Byte-compatible persist serialization (whitelist insertion order, §3.5)
// ============================================================================

fn push_opt_string(object: &mut Map<String, Value>, key: &str, value: Option<&String>) {
    if let Some(value) = value {
        object.insert(key.to_string(), Value::String(value.clone()));
    }
}

fn push_opt_number(object: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    if let Some(value) = value {
        object.insert(key.to_string(), Value::from(value));
    }
}

/// Serialize one normalized flagged account in the normalizer's insertion
/// order (spec 02 §3.5; golden `flagged-v1.json`).
fn flagged_account_to_persist_value(account: &FlaggedAccountMetadataV1) -> Value {
    let mut object = Map::new();
    object.insert(
        "refreshToken".to_string(),
        Value::String(account.refresh_token.clone()),
    );
    object.insert("addedAt".to_string(), Value::from(account.added_at));
    object.insert("lastUsed".to_string(), Value::from(account.last_used));
    push_opt_string(&mut object, "accountId", account.account_id.as_ref());
    if let Some(source) = account.account_id_source {
        object.insert(
            "accountIdSource".to_string(),
            Value::String(source.as_str().to_string()),
        );
    }
    push_opt_string(&mut object, "accountLabel", account.account_label.as_ref());
    push_opt_string(&mut object, "email", account.email.as_ref());
    push_opt_string(&mut object, "accessToken", account.access_token.as_ref());
    push_opt_number(&mut object, "expiresAt", account.expires_at);
    if let Some(enabled) = account.enabled {
        object.insert("enabled".to_string(), Value::Bool(enabled));
    }
    if let Some(reason) = account.last_switch_reason {
        object.insert(
            "lastSwitchReason".to_string(),
            Value::String(reason.as_str().to_string()),
        );
    }
    if let Some(resets) = &account.rate_limit_reset_times {
        let mut map = Map::new();
        for (key, value) in resets.iter() {
            map.insert(key.to_string(), Value::from(value));
        }
        object.insert("rateLimitResetTimes".to_string(), Value::Object(map));
    }
    push_opt_number(&mut object, "coolingDownUntil", account.cooling_down_until);
    if let Some(reason) = account.cooldown_reason {
        object.insert(
            "cooldownReason".to_string(),
            Value::String(reason.as_str().to_string()),
        );
    }
    if let Some(workspaces) = &account.workspaces {
        object.insert(
            "workspaces".to_string(),
            serde_json::to_value(workspaces).unwrap_or(Value::Array(Vec::new())),
        );
    }
    push_opt_number(
        &mut object,
        "currentWorkspaceIndex",
        account.current_workspace_index,
    );
    object.insert("flaggedAt".to_string(), Value::from(account.flagged_at));
    push_opt_string(&mut object, "flaggedReason", account.flagged_reason.as_ref());
    push_opt_string(&mut object, "lastError", account.last_error.as_ref());
    Value::Object(object)
}

/// Serialize normalized flagged storage for persistence (byte-compatible
/// with `JSON.stringify(normalizeFlaggedStorage(storage), null, 2)`).
fn flagged_storage_to_persist_value(storage: &FlaggedAccountStorageV1) -> Value {
    let mut object = Map::new();
    object.insert("version".to_string(), Value::from(1));
    object.insert(
        "accounts".to_string(),
        Value::Array(
            storage
                .accounts
                .iter()
                .map(flagged_account_to_persist_value)
                .collect(),
        ),
    );
    Value::Object(object)
}

// ============================================================================
// File primitives (flagged-storage-file.ts)
// ============================================================================

/// TS `readFileWithRetry` — 4 total attempts, retry {EBUSY, EPERM, EAGAIN}
/// (Windows AV/indexer briefly locks recently-written files — AUDIT-M05 /
/// E-08), delays 10·2^(n-1) ms.
pub async fn read_file_with_retry(path: &str) -> io::Result<String> {
    let path = path.to_string();
    with_retry(
        || tokio::fs::read_to_string(&path),
        RetryOptions::new(4, Backoff::from_fn(|n| 10 * 2u64.pow(n - 1)))
            .with_codes(&["EBUSY", "EPERM", "EAGAIN"]),
    )
    .await
}

fn json_syntax_error(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

/// Parse flagged storage content. Zod-first in TS; behaviorally the Zod-valid
/// and raw-JSON paths both feed the same normalizer, so a single raw parse is
/// equivalent. JSON syntax errors propagate (callers fall back to backups).
fn parse_flagged_storage_content(content: &str) -> io::Result<Value> {
    serde_json::from_str::<Value>(content).map_err(json_syntax_error)
}

/// TS `loadFlaggedAccountsFromFile` — read with retry, parse, normalize.
pub async fn load_flagged_accounts_from_file(path: &str) -> io::Result<FlaggedAccountStorageV1> {
    let content = read_file_with_retry(path).await?;
    let data = parse_flagged_storage_content(&content)?;
    Ok(normalize_flagged_storage(&data))
}

/// TS `isValidFlaggedStorageCandidate` — raw data must own `version` and
/// `accounts`, `version === 1`, accounts an array, and (raw accounts empty OR
/// normalized accounts non-empty). A file of 100% invalid accounts is
/// treated as corrupt, not empty (gotcha 18).
fn is_valid_flagged_storage_candidate(data: &Value, storage: &FlaggedAccountStorageV1) -> bool {
    let Some(object) = data.as_object() else {
        return false;
    };
    if !object.contains_key("version") || !object.contains_key("accounts") {
        return false;
    }
    let version_is_1 = object
        .get("version")
        .and_then(Value::as_f64)
        .is_some_and(|version| version == 1.0);
    let Some(accounts) = object.get("accounts").and_then(Value::as_array) else {
        return false;
    };
    if !version_is_1 {
        return false;
    }
    accounts.is_empty() || !storage.accounts.is_empty()
}

fn get_flagged_backup_paths(path: &str) -> Vec<String> {
    vec![
        format!("{path}.bak"),
        format!("{path}.bak.1"),
        format!("{path}.bak.2"),
    ]
}

async fn unlink_with_retry(candidate_path: &str) -> io::Result<()> {
    let candidate = candidate_path.to_string();
    let result = with_retry(
        || tokio::fs::remove_file(&candidate),
        RetryOptions::new(5, Backoff::from_fn(|n| 10 * 2u64.pow(n - 1)))
            .with_codes(FILE_RETRY_CODES),
    )
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn copy_file_with_retry(
    source_path: &str,
    destination_path: &str,
    allow_missing_source: bool,
) -> io::Result<()> {
    let source = source_path.to_string();
    let destination = destination_path.to_string();
    let result = with_retry(
        || async {
            tokio::fs::copy(&source, &destination).await?;
            Ok::<(), io::Error>(())
        },
        RetryOptions::new(5, Backoff::from_fn(|n| 10 * 2u64.pow(n - 1))),
    )
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(error) if allow_missing_source && error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn rename_file_with_retry(source_path: &str, destination_path: &str) -> io::Result<()> {
    let source = source_path.to_string();
    let destination = destination_path.to_string();
    with_retry(
        || tokio::fs::rename(&source, &destination),
        RetryOptions::new(5, Backoff::from_fn(|n| 10 * 2u64.pow(n - 1))).with_jitter(10),
    )
    .await
}

/// Node `fs.writeFile(..., { mode: 0o600 })` parity: mode applied atomically
/// at open(2) on unix so the flagged temp file (refresh-token material) never
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

fn is_enoent(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || code_of(error) == Some("ENOENT")
}

// ============================================================================
// Load ladder (flagged-storage-io.ts loadFlaggedAccountsState)
// ============================================================================

/// Persist a recovered backup while respecting the reset marker and the
/// non-reentrant storage lock (unlocked save when the lock is already held).
async fn persist_recovered_backup(
    storage: &FlaggedAccountStorageV1,
    reset_marker_path: &str,
) -> Result<bool, CodexError> {
    let recover = |storage: FlaggedAccountStorageV1, marker: String| async move {
        if Path::new(&marker).exists() {
            return Ok(false);
        }
        save_flagged_accounts_unlocked(&storage).await?;
        Ok(true)
    };
    if crate::transactions::is_storage_lock_held() {
        recover(storage.clone(), reset_marker_path.to_string()).await
    } else {
        let storage = storage.clone();
        let marker = reset_marker_path.to_string();
        crate::transactions::with_storage_lock(move || recover(storage, marker)).await
    }
}

/// Persist used by the legacy migration: unlocked when the lock is held,
/// locked otherwise (same deadlock-avoidance as `persist_recovered_backup`).
async fn save_flagged_for_migration(storage: &FlaggedAccountStorageV1) -> Result<(), CodexError> {
    if crate::transactions::is_storage_lock_held() {
        save_flagged_accounts_unlocked(storage).await
    } else {
        save_flagged_accounts(storage).await
    }
}

async fn load_flagged_backup(
    path: &str,
    reset_marker_path: &str,
) -> Option<FlaggedAccountStorageV1> {
    let log = create_logger("storage");
    for backup_path in get_flagged_backup_paths(path) {
        if !Path::new(&backup_path).exists() {
            continue;
        }
        let attempt = async {
            let backup_content = read_file_with_retry(&backup_path).await?;
            let backup_data = parse_flagged_storage_content(&backup_content)?;
            Ok::<(Value, FlaggedAccountStorageV1), io::Error>((
                backup_data.clone(),
                normalize_flagged_storage(&backup_data),
            ))
        }
        .await;
        match attempt {
            Ok((backup_data, recovered)) => {
                if !is_valid_flagged_storage_candidate(&backup_data, &recovered) {
                    log.error(
                        "Skipping invalid flagged account backup payload",
                        Some(&json!({ "from": backup_path, "to": path })),
                    );
                    continue;
                }
                if Path::new(reset_marker_path).exists() {
                    return Some(FlaggedAccountStorageV1::empty());
                }
                if !recovered.accounts.is_empty() {
                    match persist_recovered_backup(&recovered, reset_marker_path).await {
                        Ok(false) => return Some(FlaggedAccountStorageV1::empty()),
                        Ok(true) => {}
                        Err(persist_error) => {
                            log.error(
                                "Failed to persist recovered flagged account storage",
                                Some(&json!({
                                    "from": backup_path,
                                    "to": path,
                                    "error": persist_error.to_string(),
                                })),
                            );
                            return Some(recovered);
                        }
                    }
                }
                log.info(
                    "Recovered flagged account storage from backup",
                    Some(&json!({
                        "from": backup_path,
                        "to": path,
                        "accounts": recovered.accounts.len(),
                    })),
                );
                return Some(recovered);
            }
            Err(backup_error) => {
                log.error(
                    "Failed to recover flagged account storage from backup",
                    Some(&json!({
                        "from": backup_path,
                        "to": path,
                        "error": backup_error.to_string(),
                    })),
                );
            }
        }
    }
    None
}

/// TS `loadFlaggedAccounts()` — never throws; ladder per spec 02 §9.1.
pub async fn load_flagged_accounts() -> FlaggedAccountStorageV1 {
    let log = create_logger("storage");
    let path = get_flagged_accounts_path();
    let legacy_path = get_legacy_flagged_accounts_path();
    let reset_marker_path = crate::backup_paths::get_intentional_reset_marker_path(&path);

    if Path::new(&reset_marker_path).exists() {
        return FlaggedAccountStorageV1::empty();
    }

    let primary_attempt = async {
        let content = read_file_with_retry(&path).await?;
        let data = parse_flagged_storage_content(&content)?;
        let loaded = normalize_flagged_storage(&data);
        if !is_valid_flagged_storage_candidate(&data, &loaded) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid flagged account storage payload",
            ));
        }
        Ok::<FlaggedAccountStorageV1, io::Error>(loaded)
    }
    .await;

    match primary_attempt {
        Ok(loaded) => {
            if Path::new(&reset_marker_path).exists() {
                return FlaggedAccountStorageV1::empty();
            }
            return loaded;
        }
        Err(error) if !is_enoent(&error) => {
            log.error(
                "Failed to load flagged account storage",
                Some(&json!({ "path": path, "error": error.to_string() })),
            );
            return load_flagged_backup(&path, &reset_marker_path)
                .await
                .unwrap_or_else(FlaggedAccountStorageV1::empty);
        }
        Err(_enoent) => {}
    }

    if let Some(recovered_backup) = load_flagged_backup(&path, &reset_marker_path).await {
        return recovered_backup;
    }

    if !Path::new(&legacy_path).exists() {
        return FlaggedAccountStorageV1::empty();
    }

    let migration_attempt = async {
        let legacy_content = read_file_with_retry(&legacy_path)
            .await
            .map_err(io_to_codex)?;
        let legacy_data =
            parse_flagged_storage_content(&legacy_content).map_err(io_to_codex)?;
        let migrated = normalize_flagged_storage(&legacy_data);
        if !migrated.accounts.is_empty() {
            save_flagged_for_migration(&migrated).await?;
        }
        Ok::<FlaggedAccountStorageV1, CodexError>(migrated)
    }
    .await;

    match migration_attempt {
        Ok(migrated) => {
            // Best-effort legacy cleanup.
            let _ = tokio::fs::remove_file(&legacy_path).await;
            log.info(
                "Migrated legacy flagged account storage",
                Some(&json!({
                    "from": legacy_path,
                    "to": path,
                    "accounts": migrated.accounts.len(),
                })),
            );
            migrated
        }
        Err(error) => {
            log.error(
                "Failed to migrate legacy flagged account storage",
                Some(&json!({
                    "from": legacy_path,
                    "to": path,
                    "error": error.to_string(),
                })),
            );
            FlaggedAccountStorageV1::empty()
        }
    }
}

// ============================================================================
// Save (flagged-storage-io.ts saveFlaggedAccountsUnlockedToDisk)
// ============================================================================

/// TS `saveFlaggedAccountsUnlocked` — callers must already hold the storage
/// lock (or be on a deliberate unlocked path).
pub async fn save_flagged_accounts_unlocked(
    storage: &FlaggedAccountStorageV1,
) -> Result<(), CodexError> {
    let log = create_logger("storage");
    let path = get_flagged_accounts_path();
    let marker_path = crate::backup_paths::get_intentional_reset_marker_path(&path);
    let temp_path = temp_path_for_str(&path);

    let attempt = async {
        if let Some(parent) = Path::new(&path).parent() {
            // Default directory mode here — deliberately NOT 0700 (spec §9.2).
            tokio::fs::create_dir_all(parent).await?;
        }
        if Path::new(&path).exists()
            && let Err(backup_error) =
                copy_file_with_retry(&path, &format!("{path}.bak"), true).await
        {
            log.warn(
                "Failed to create flagged backup snapshot",
                Some(&json!({ "path": path, "error": backup_error.to_string() })),
            );
        }
        let normalized =
            normalize_flagged_storage(&serde_json::to_value(storage).unwrap_or(Value::Null));
        let content = cma_core::json_io::stringify_pretty2(&flagged_storage_to_persist_value(
            &normalized,
        ));
        write_file_mode_600(&temp_path, &content).await?;
        rename_file_with_retry(&temp_path, &path).await?;
        // Best-effort marker cleanup.
        let _ = tokio::fs::remove_file(&marker_path).await;
        Ok::<(), io::Error>(())
    }
    .await;

    match attempt {
        Ok(()) => Ok(()),
        Err(error) => {
            // Best-effort temp cleanup.
            let _ = tokio::fs::remove_file(&temp_path).await;
            log.error(
                "Failed to save flagged account storage",
                Some(&json!({ "path": path, "error": error.to_string() })),
            );
            // RAW error contract: rethrown unwrapped (code preserved).
            Err(io_to_codex(error))
        }
    }
}

/// TS `saveFlaggedAccounts(storage)` — lock + unlocked save.
pub async fn save_flagged_accounts(storage: &FlaggedAccountStorageV1) -> Result<(), CodexError> {
    let storage = storage.clone();
    crate::transactions::with_storage_lock(move || async move {
        save_flagged_accounts_unlocked(&storage).await
    })
    .await
}

// ============================================================================
// Clear (flagged-storage-io.ts clearFlaggedAccountsOnDisk)
// ============================================================================

async fn clear_flagged_accounts_on_disk(
    path: &str,
    marker_path: &str,
    backup_paths: &[String],
) -> Result<(), CodexError> {
    let log = create_logger("storage");
    let mut keep_reset_marker = false;
    if let Err(error) = write_file_mode_600(marker_path, "reset").await {
        log.error(
            "Failed to write flagged reset marker",
            Some(&json!({
                "path": path,
                "markerPath": marker_path,
                "error": error.to_string(),
            })),
        );
        return Err(io_to_codex(error));
    }
    let mut candidates: Vec<&str> = vec![path];
    candidates.extend(backup_paths.iter().map(String::as_str));
    for candidate in candidates {
        if let Err(error) = unlink_with_retry(candidate).await
            && !is_enoent(&error)
        {
            log.error(
                "Failed to clear flagged account storage",
                Some(&json!({ "path": candidate, "error": error.to_string() })),
            );
            if candidate == path {
                return Err(io_to_codex(error));
            }
            keep_reset_marker = true;
        }
    }
    if !keep_reset_marker
        && let Err(error) = unlink_with_retry(marker_path).await
        && !is_enoent(&error)
    {
        log.error(
            "Failed to clear flagged account storage",
            Some(&json!({ "path": marker_path, "error": error.to_string() })),
        );
        return Err(io_to_codex(error));
    }
    Ok(())
}

/// TS `clearFlaggedAccounts()` — lock + marker-first artifact clear.
pub async fn clear_flagged_accounts() -> Result<(), CodexError> {
    let path = get_flagged_accounts_path();
    let marker_path = crate::backup_paths::get_intentional_reset_marker_path(&path);
    crate::transactions::with_storage_lock(move || async move {
        let backup_paths =
            crate::backups::get_accounts_backup_recovery_candidates_with_discovery(&path).await;
        clear_flagged_accounts_on_disk(&path, &marker_path, &backup_paths).await
    })
    .await
}

// ============================================================================
// Tests (ported from test/flagged-storage.test.ts + persist-order golden)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_returns_empty_for_invalid_shapes() {
        for value in [
            json!(null),
            json!([]),
            json!("nope"),
            json!({ "version": 2, "accounts": [] }),
            json!({ "version": 1, "accounts": "not-array" }),
            json!({ "version": 1 }),
        ] {
            let normalized = normalize_flagged_storage(&value);
            assert!(normalized.accounts.is_empty(), "value: {value}");
        }
    }

    #[test]
    fn normalize_skips_accounts_without_refresh_token() {
        let data = json!({
            "version": 1,
            "accounts": [
                { "flaggedAt": 5 },
                { "refreshToken": "   ", "flaggedAt": 5 },
                { "refreshToken": "rt_ok", "flaggedAt": 5 },
                "not-a-record",
            ],
        });
        let normalized = normalize_flagged_storage(&data);
        assert_eq!(normalized.accounts.len(), 1);
        assert_eq!(normalized.accounts[0].refresh_token, "rt_ok");
    }

    #[test]
    fn normalize_dedupes_by_refresh_token_last_wins_first_position() {
        let data = json!({
            "version": 1,
            "accounts": [
                { "refreshToken": "rt_a", "flaggedAt": 1, "flaggedReason": "first" },
                { "refreshToken": "rt_b", "flaggedAt": 2 },
                { "refreshToken": "rt_a", "flaggedAt": 3, "flaggedReason": "second" },
            ],
        });
        let normalized = normalize_flagged_storage(&data);
        assert_eq!(normalized.accounts.len(), 2);
        // rt_a keeps its FIRST position, with the LAST occurrence's content.
        assert_eq!(normalized.accounts[0].refresh_token, "rt_a");
        assert_eq!(normalized.accounts[0].flagged_reason.as_deref(), Some("second"));
        assert_eq!(normalized.accounts[0].flagged_at, 3);
        assert_eq!(normalized.accounts[1].refresh_token, "rt_b");
    }

    #[test]
    fn normalize_defaults_added_at_and_last_used_to_flagged_at() {
        let data = json!({
            "version": 1,
            "accounts": [{ "refreshToken": "rt", "flaggedAt": 777 }],
        });
        let normalized = normalize_flagged_storage(&data);
        assert_eq!(normalized.accounts[0].added_at, 777);
        assert_eq!(normalized.accounts[0].last_used, 777);
    }

    #[test]
    fn normalize_uses_injected_now_when_flagged_at_missing() {
        let data = json!({
            "version": 1,
            "accounts": [{ "refreshToken": "rt" }],
        });
        let mut now = || 12_345_i64;
        let normalized = normalize_flagged_storage_with(&data, &mut now);
        assert_eq!(normalized.accounts[0].flagged_at, 12_345);
        assert_eq!(normalized.accounts[0].added_at, 12_345);
        assert_eq!(normalized.accounts[0].last_used, 12_345);
    }

    #[test]
    fn normalize_validates_enum_fields_by_value() {
        let data = json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt",
                "flaggedAt": 1,
                "accountIdSource": "bogus",
                "lastSwitchReason": "rotation",
                "cooldownReason": "nope",
            }],
        });
        let normalized = normalize_flagged_storage(&data);
        let account = &normalized.accounts[0];
        assert_eq!(account.account_id_source, None);
        assert_eq!(account.last_switch_reason, Some(SwitchReason::Rotation));
        assert_eq!(account.cooldown_reason, None);
    }

    #[test]
    fn normalize_filters_rate_limit_reset_times_to_numbers() {
        let data = json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt",
                "flaggedAt": 1,
                "rateLimitResetTimes": { "codex": 5, "gpt-5.2": "soon", "codex-max": 7 },
            }],
        });
        let normalized = normalize_flagged_storage(&data);
        let resets = normalized.accounts[0]
            .rate_limit_reset_times
            .as_ref()
            .expect("kept");
        assert_eq!(resets.get("codex"), Some(5));
        assert_eq!(resets.get("codex-max"), Some(7));
        assert!(!resets.contains_key("gpt-5.2"));
        // All-invalid map collapses to None.
        let all_invalid = json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt",
                "flaggedAt": 1,
                "rateLimitResetTimes": { "codex": "soon" },
            }],
        });
        assert!(
            normalize_flagged_storage(&all_invalid).accounts[0]
                .rate_limit_reset_times
                .is_none()
        );
    }

    #[test]
    fn normalize_drops_unknown_fields() {
        let data = json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt",
                "flaggedAt": 1,
                "someFutureField": { "nested": true },
            }],
        });
        let normalized = normalize_flagged_storage(&data);
        assert!(normalized.accounts[0].extra.is_empty());
        let persisted = flagged_storage_to_persist_value(&normalized);
        assert!(persisted["accounts"][0].get("someFutureField").is_none());
    }

    #[test]
    fn persist_value_matches_golden_byte_layout() {
        // Mirrors crates/testkit/goldens/flagged-v1.json exactly (whitelist
        // insertion order, not schema order).
        let data = json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt-fixture-flagged-0000000003",
                "addedAt": 1_749_800_000_000_i64,
                "lastUsed": 1_749_990_000_000_i64,
                "accountId": "acct-user-three",
                "accountIdSource": "id_token",
                "accountLabel": "Flagged Account",
                "email": "user.three@example.com",
                "accessToken": "at-fixture-flagged-0000000003",
                "expiresAt": 1_750_003_600_000_i64,
                "enabled": false,
                "lastSwitchReason": "rate-limit",
                "rateLimitResetTimes": { "codex": 1_750_000_900_000_i64 },
                "coolingDownUntil": 1_750_003_600_000_i64,
                "cooldownReason": "auth-failure",
                "workspaces": [{
                    "id": "ws-three-1",
                    "name": "Personal",
                    "enabled": true,
                    "isDefault": true,
                }],
                "currentWorkspaceIndex": 0,
                "flaggedAt": 1_750_000_000_000_i64,
                "flaggedReason": "invalid_grant on refresh",
                "lastError": "401 Unauthorized: invalid_grant",
            }],
        });
        let normalized = normalize_flagged_storage(&data);
        let content =
            cma_core::json_io::stringify_pretty2(&flagged_storage_to_persist_value(&normalized));
        let golden = cma_testkit::goldens::read_golden_string("flagged-v1.json");
        assert_eq!(content, golden);
    }

    #[test]
    fn valid_candidate_rules() {
        let empty_storage = FlaggedAccountStorageV1::empty();
        // Missing own keys.
        assert!(!is_valid_flagged_storage_candidate(&json!({}), &empty_storage));
        assert!(!is_valid_flagged_storage_candidate(
            &json!({ "version": 1 }),
            &empty_storage
        ));
        // version !== 1.
        assert!(!is_valid_flagged_storage_candidate(
            &json!({ "version": 2, "accounts": [] }),
            &empty_storage
        ));
        // Raw accounts empty ⇒ valid even with empty normalized storage.
        assert!(is_valid_flagged_storage_candidate(
            &json!({ "version": 1, "accounts": [] }),
            &empty_storage
        ));
        // Raw accounts present but normalized empty (100% invalid rows) ⇒
        // corrupt, NOT empty (gotcha 18).
        assert!(!is_valid_flagged_storage_candidate(
            &json!({ "version": 1, "accounts": [{ "bad": true }] }),
            &empty_storage
        ));
    }
}
