//! Port of `lib/codex-manager/forecast-report-shared.ts` (+ the shared
//! command plumbing this crate's command modules need: log sinks and the
//! atomic `--out` writer that report.ts/usage.ts duplicate).
//!
//! Behavior source: spec 08 §3 + spec 09 §4.3. CRITICAL divergent
//! persistence strategies preserved exactly (spec 08 gotchas 2/3):
//! - `best` uses plain `saveAccounts` for probe-refresh persistence;
//! - `forecast` applies the in-memory patch BEFORE persisting;
//! - `report` persists FIRST and applies in-memory only on success.
//!
//! The reload-clone-match-save helper here is what forecast/report share.

use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

use cma_core::errors::CodexError;
use cma_core::fs_retry::code_of;
use cma_core::schemas::account_storage::{AccountIdSource, AccountMetadataV3, AccountStorageV3};
use cma_core::schemas::token::{TokenFailure, TokenResult};
use cma_core::temp_path::temp_path_for;
use cma_quota::forecast::ForecastAccountResult;
use cma_quota::probe::CodexQuotaSnapshot;
use cma_storage::identity::AccountIdentityLike;
use cma_storage::matching::{find_matching_account_index, AccountMatchOptions};
use serde_json::{Map, Value};

// Re-exported to preserve the historical import surface (the TS module
// re-exports `saveAccountsWithRetry` from `lib/storage/save-retry.ts`).
pub use cma_storage::save_retry::{save_accounts_with_retry, save_accounts_with_retry_via};

// ============================================================================
// Shared DI plumbing for the command modules (Rust-only structure; the TS
// commands use per-file `deps` objects with `console.log`/`console.error`
// defaults — these aliases are that pattern's Rust spelling).
// ============================================================================

/// Boxed future for injectable async deps.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// `logInfo` / `logError` / `logWarn` sink (default: stdout/stderr line).
pub type LogFn = Box<dyn Fn(&str) + Send + Sync>;

/// Default `logInfo` (TS `console.log`).
pub fn default_log_info() -> LogFn {
    Box::new(|message| println!("{message}"))
}

/// Default `logError` / `logWarn` (TS `console.error` / `console.warn`).
pub fn default_log_error() -> LogFn {
    Box::new(|message| eprintln!("{message}"))
}

/// `setStoragePath(path: string | null)` seam.
pub type SetStoragePathFn = Box<dyn Fn(Option<&str>) + Send + Sync>;
/// `getStoragePath(): string` seam.
pub type GetStoragePathFn = Box<dyn Fn() -> String + Send + Sync>;
/// `loadAccounts(): Promise<AccountStorageV3 | null>` seam.
pub type LoadAccountsFn = Box<dyn Fn() -> BoxFuture<Option<AccountStorageV3>> + Send + Sync>;
/// `saveAccounts(storage): Promise<void>` seam.
pub type SaveAccountsFn =
    Box<dyn Fn(AccountStorageV3) -> BoxFuture<Result<(), CodexError>> + Send + Sync>;

/// Real `setStoragePath` (storage facade).
pub fn default_set_storage_path() -> SetStoragePathFn {
    Box::new(|path| cma_storage::facade::set_storage_path(path.map(Path::new)))
}

/// Real `getStoragePath` (storage facade).
pub fn default_get_storage_path() -> GetStoragePathFn {
    Box::new(cma_storage::facade::get_storage_path)
}

/// Real `loadAccounts` (storage half only; restore metadata is dropped —
/// `status` wires its own loader that keeps it).
pub fn default_load_accounts() -> LoadAccountsFn {
    Box::new(|| {
        Box::pin(async { cma_storage::load::load_accounts().await.map(|loaded| loaded.storage) })
    })
}

/// Real `saveAccounts`.
pub fn default_save_accounts() -> SaveAccountsFn {
    Box::new(|storage| Box::pin(async move { cma_storage::save::save_accounts(&storage).await }))
}

/// `saveAccountsWithRetry(storage, deps.saveAccounts)` over the boxed seam.
pub async fn save_accounts_with_retry_boxed(
    storage: &AccountStorageV3,
    save_accounts: &SaveAccountsFn,
) -> Result<(), CodexError> {
    save_accounts_with_retry_via(storage, |s: &AccountStorageV3| save_accounts(s.clone())).await
}

/// TS `error instanceof Error ? error.message : String(error)`.
pub fn error_message(error: &CodexError) -> String {
    error.message().to_string()
}

// ============================================================================
// forecast-report-shared.ts proper
// ============================================================================

/// TS `AccountIdentityMatch = Pick<AccountMetadataV3, "accountId" | "email" |
/// "refreshToken">`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountIdentityMatch {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub refresh_token: Option<String>,
}

impl AccountIdentityLike for AccountIdentityMatch {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }
}

/// TS `RefreshedAccountPatch`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RefreshedAccountPatch {
    pub refresh_token: String,
    pub access_token: String,
    pub expires_at: i64,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub account_id_source: Option<AccountIdSource>,
}

impl AccountIdentityLike for RefreshedAccountPatch {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        Some(self.refresh_token.as_str())
    }
}

/// TS `applyRefreshedAccountPatch(account, patch)` — unconditional assign of
/// the token triple; `email` only when truthy; `accountId` **and**
/// `accountIdSource` only when `accountId` truthy.
pub fn apply_refreshed_account_patch(account: &mut AccountMetadataV3, patch: &RefreshedAccountPatch) {
    account.refresh_token = patch.refresh_token.clone();
    account.access_token = Some(patch.access_token.clone());
    account.expires_at = Some(patch.expires_at);
    if patch.email.as_deref().is_some_and(|email| !email.is_empty()) {
        account.email = patch.email.clone();
    }
    if patch
        .account_id
        .as_deref()
        .is_some_and(|account_id| !account_id.is_empty())
    {
        account.account_id = patch.account_id.clone();
        account.account_id_source = patch.account_id_source;
    }
}

/// TS `persistRefreshedAccountPatch(storage, accountMatch, patch,
/// loadAccounts, saveAccounts)` — reload-latest (fallback to the given
/// storage), clone, locate by `accountMatch` then by `patch` (both with
/// `allowUniqueAccountIdFallbackWithoutEmail: true`); unresolvable → error
/// with the FROZEN message; apply the patch; `saveAccountsWithRetry`.
///
/// Note: the caller's in-memory `storage` object is *not* what gets saved.
pub async fn persist_refreshed_account_patch<LF, LFut, SF, SFut>(
    storage: &AccountStorageV3,
    account_match: &AccountIdentityMatch,
    patch: &RefreshedAccountPatch,
    load_accounts: LF,
    save_accounts: SF,
) -> Result<(), CodexError>
where
    LF: FnOnce() -> LFut,
    LFut: Future<Output = Option<AccountStorageV3>>,
    SF: FnMut(&AccountStorageV3) -> SFut,
    SFut: Future<Output = Result<(), CodexError>>,
{
    let latest_storage = load_accounts().await.unwrap_or_else(|| storage.clone());
    let mut next_storage = latest_storage.clone();
    let options = AccountMatchOptions {
        allow_unique_account_id_fallback_without_email: true,
    };
    let target_index = find_matching_account_index(&next_storage.accounts, account_match, options)
        .or_else(|| find_matching_account_index(&next_storage.accounts, patch, options));
    let Some(target_index) = target_index else {
        return Err(CodexError::new(
            "Unable to resolve refreshed account for persistence",
        ));
    };
    let Some(target_account) = next_storage.accounts.get_mut(target_index) else {
        return Err(CodexError::new(
            "Unable to resolve refreshed account for persistence",
        ));
    };
    apply_refreshed_account_patch(target_account, patch);
    save_accounts_with_retry_via(&next_storage, save_accounts).await
}

/// Serialize a [`TokenFailure`] with its `type: "failed"` tag (the TS record
/// spreads a `TokenResult` failure object, so the tag key is present).
pub fn token_failure_to_value(failure: &TokenFailure) -> Value {
    serde_json::to_value(TokenResult::Failed(failure.clone())).unwrap_or(Value::Null)
}

/// TS `serializeForecastResults(results, liveQuotaByIndex, refreshFailures,
/// formatQuotaSnapshotLine)` — the JSON rows used by `forecast --json` and
/// `report`. `selected` is always `false` here; `report` flips one to `true`
/// afterwards. Keys are emitted in the exact TS object-literal order and
/// `undefined` keys are omitted (JSON.stringify semantics).
pub fn serialize_forecast_results(
    results: &[ForecastAccountResult],
    live_quota_by_index: &HashMap<usize, CodexQuotaSnapshot>,
    refresh_failures: &HashMap<usize, TokenFailure>,
    format_quota_snapshot_line: &dyn Fn(&CodexQuotaSnapshot) -> String,
) -> Vec<Value> {
    results
        .iter()
        .map(|result| {
            let mut row = Map::new();
            row.insert("index".into(), Value::from(result.index as i64));
            row.insert("label".into(), Value::from(result.label.clone()));
            row.insert("isCurrent".into(), Value::from(result.is_current));
            row.insert("selected".into(), Value::from(false));
            if let Some(primary_reason) = result.reasons.first() {
                row.insert("primaryReason".into(), Value::from(primary_reason.clone()));
            }
            row.insert(
                "availability".into(),
                serde_json::to_value(result.availability).unwrap_or(Value::Null),
            );
            row.insert("riskScore".into(), Value::from(result.risk_score));
            row.insert(
                "riskLevel".into(),
                serde_json::to_value(result.risk_level).unwrap_or(Value::Null),
            );
            row.insert("waitMs".into(), Value::from(result.wait_ms));
            row.insert(
                "reasons".into(),
                Value::Array(result.reasons.iter().cloned().map(Value::from).collect()),
            );
            if let Some(live_quota) = live_quota_by_index.get(&result.index) {
                let mut quota = Map::new();
                quota.insert("status".into(), Value::from(live_quota.status));
                if let Some(plan_type) = &live_quota.plan_type {
                    quota.insert("planType".into(), Value::from(plan_type.clone()));
                }
                if let Some(active_limit) = live_quota.active_limit {
                    quota.insert("activeLimit".into(), Value::from(active_limit));
                }
                quota.insert("model".into(), Value::from(live_quota.model.clone()));
                quota.insert(
                    "summary".into(),
                    Value::from(format_quota_snapshot_line(live_quota)),
                );
                row.insert("liveQuota".into(), Value::Object(quota));
            }
            if let Some(refresh_failure) = refresh_failures.get(&result.index) {
                row.insert("refreshFailure".into(), token_failure_to_value(refresh_failure));
            }
            Value::Object(row)
        })
        .collect()
}

// ============================================================================
// Atomic `--out` writer (TS `defaultWriteFile`, duplicated verbatim in
// report.ts and usage.ts — one Rust copy, same behavior at both call sites)
// ============================================================================

const RETRYABLE_WRITE_CODES: [&str; 2] = ["EBUSY", "EPERM"];

fn is_retryable_write_error(error: &std::io::Error) -> bool {
    code_of(error).is_some_and(|code| RETRYABLE_WRITE_CODES.contains(&code))
}

/// TS `defaultWriteFile(path, contents)` — mkdir -p, write to
/// `tempPathFor(path)`, rename with up to 5 attempts retrying only
/// EBUSY/EPERM with `10 * 2^attempt` ms backoff; best-effort temp unlink on
/// failure.
pub async fn default_write_file(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temp_path = temp_path_for(path);
    let mut moved = false;
    let result = async {
        tokio::fs::write(&temp_path, contents.as_bytes()).await?;
        let mut attempt: u32 = 0;
        loop {
            match tokio::fs::rename(&temp_path, path).await {
                Ok(()) => {
                    moved = true;
                    return Ok(());
                }
                Err(error) => {
                    if !is_retryable_write_error(&error) || attempt >= 4 {
                        return Err(error);
                    }
                    tokio::time::sleep(Duration::from_millis(
                        10u64.saturating_mul(2u64.saturating_pow(attempt)),
                    ))
                    .await;
                    attempt += 1;
                }
            }
        }
    }
    .await;
    if !moved {
        // Best-effort temp cleanup.
        let _ = tokio::fs::remove_file(&temp_path).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn account(refresh: &str, email: Option<&str>, id: Option<&str>) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh, 1, 1);
        account.email = email.map(str::to_string);
        account.account_id = id.map(str::to_string);
        account
    }

    fn storage_with(accounts: Vec<AccountMetadataV3>) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts = accounts;
        storage
    }

    #[test]
    fn apply_patch_sets_token_triple_and_conditionals() {
        let mut target = account("old-refresh", Some("old@x.com"), Some("acct-old"));
        target.account_id_source = Some(AccountIdSource::Manual);
        apply_refreshed_account_patch(
            &mut target,
            &RefreshedAccountPatch {
                refresh_token: "new-refresh".into(),
                access_token: "new-access".into(),
                expires_at: 999,
                email: None,
                account_id: None,
                account_id_source: None,
            },
        );
        assert_eq!(target.refresh_token, "new-refresh");
        assert_eq!(target.access_token.as_deref(), Some("new-access"));
        assert_eq!(target.expires_at, Some(999));
        // email / accountId untouched when the patch omits them.
        assert_eq!(target.email.as_deref(), Some("old@x.com"));
        assert_eq!(target.account_id.as_deref(), Some("acct-old"));
        assert_eq!(target.account_id_source, Some(AccountIdSource::Manual));

        apply_refreshed_account_patch(
            &mut target,
            &RefreshedAccountPatch {
                refresh_token: "r2".into(),
                access_token: "a2".into(),
                expires_at: 1000,
                email: Some("new@x.com".into()),
                account_id: Some("acct-new".into()),
                account_id_source: Some(AccountIdSource::Token),
            },
        );
        assert_eq!(target.email.as_deref(), Some("new@x.com"));
        assert_eq!(target.account_id.as_deref(), Some("acct-new"));
        assert_eq!(target.account_id_source, Some(AccountIdSource::Token));
    }

    #[tokio::test]
    async fn persist_patch_reloads_latest_and_saves_clone() {
        // The reload returns a DIFFERENT storage than the caller's in-memory
        // one; the save must land on the reloaded clone.
        let in_memory = storage_with(vec![account("stale", Some("a@x.com"), None)]);
        let latest = storage_with(vec![account("fresh", Some("a@x.com"), None)]);
        let saved: Arc<std::sync::Mutex<Option<AccountStorageV3>>> =
            Arc::new(std::sync::Mutex::new(None));
        let saved_clone = Arc::clone(&saved);
        persist_refreshed_account_patch(
            &in_memory,
            &AccountIdentityMatch {
                account_id: None,
                email: Some("a@x.com".into()),
                refresh_token: Some("fresh".into()),
            },
            &RefreshedAccountPatch {
                refresh_token: "rotated".into(),
                access_token: "access".into(),
                expires_at: 5,
                email: None,
                account_id: None,
                account_id_source: None,
            },
            move || {
                let latest = latest.clone();
                async move { Some(latest) }
            },
            move |storage| {
                let saved = Arc::clone(&saved_clone);
                let storage = storage.clone();
                async move {
                    *saved.lock().unwrap() = Some(storage);
                    Ok(())
                }
            },
        )
        .await
        .expect("persist succeeds");
        let saved = saved.lock().unwrap().clone().expect("saved");
        assert_eq!(saved.accounts[0].refresh_token, "rotated");
        assert_eq!(saved.accounts[0].access_token.as_deref(), Some("access"));
    }

    #[tokio::test]
    async fn persist_patch_unresolvable_account_errors_with_frozen_message() {
        let storage = storage_with(vec![]);
        let error = persist_refreshed_account_patch(
            &storage,
            &AccountIdentityMatch {
                account_id: None,
                email: Some("missing@x.com".into()),
                refresh_token: Some("nope".into()),
            },
            &RefreshedAccountPatch {
                refresh_token: "r".into(),
                access_token: "a".into(),
                expires_at: 1,
                ..Default::default()
            },
            || async { None },
            |_storage| async { Ok(()) },
        )
        .await
        .expect_err("must fail");
        assert_eq!(
            error.message(),
            "Unable to resolve refreshed account for persistence"
        );
    }

    #[tokio::test]
    async fn save_accounts_with_retry_via_retries_ebusy_then_succeeds() {
        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = Arc::clone(&attempts);
        let storage = storage_with(vec![account("r", None, None)]);
        save_accounts_with_retry_via(&storage, move |_s| {
            let attempts = Arc::clone(&attempts_clone);
            async move {
                if attempts.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(CodexError::storage("busy", "EBUSY", "/x", "hint", None))
                } else {
                    Ok(())
                }
            }
        })
        .await
        .expect("eventually succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn serialize_results_row_shape_and_optional_keys() {
        use cma_quota::forecast::ForecastAccountInput;
        let acct = account("r", Some("a@x.com"), None);
        let results = cma_quota::forecast::evaluate_forecast_accounts(&[
            ForecastAccountInput::new(0, &acct, true, 1_000),
        ]);
        let mut live = HashMap::new();
        live.insert(
            0usize,
            CodexQuotaSnapshot {
                status: 200,
                plan_type: Some("plus".into()),
                active_limit: None,
                primary: Default::default(),
                secondary: Default::default(),
                model: "gpt-5.5".into(),
            },
        );
        let mut failures = HashMap::new();
        failures.insert(
            0usize,
            TokenFailure {
                reason: None,
                status_code: Some(401),
                message: Some("bad".into()),
            },
        );
        let rows =
            serialize_forecast_results(&results, &live, &failures, &|_snapshot| "line".to_string());
        assert_eq!(rows.len(), 1);
        let row = rows[0].as_object().expect("object row");
        let keys: Vec<&str> = row.keys().map(String::as_str).collect();
        // primaryReason mirrors JSON.stringify semantics: present only when
        // reasons[0] exists.
        let mut expected = vec!["index", "label", "isCurrent", "selected"];
        if !results[0].reasons.is_empty() {
            expected.push("primaryReason");
        }
        expected.extend([
            "availability",
            "riskScore",
            "riskLevel",
            "waitMs",
            "reasons",
            "liveQuota",
            "refreshFailure",
        ]);
        assert_eq!(keys, expected);
        assert_eq!(row["selected"], Value::from(false));
        let quota = row["liveQuota"].as_object().expect("liveQuota");
        let quota_keys: Vec<&str> = quota.keys().map(String::as_str).collect();
        assert_eq!(quota_keys, vec!["status", "planType", "model", "summary"]);
        assert_eq!(quota["summary"], Value::from("line"));
        let failure = row["refreshFailure"].as_object().expect("refreshFailure");
        assert_eq!(failure["type"], Value::from("failed"));
        assert_eq!(failure["statusCode"], Value::from(401));
    }

    #[tokio::test]
    async fn default_write_file_writes_atomically_and_cleans_temp() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("nested").join("report.json");
        default_write_file(&target, "{}\n").await.expect("write ok");
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "{}\n");
        // No stray .tmp files remain.
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
