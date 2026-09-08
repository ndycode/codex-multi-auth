//! Port of `lib/proactive-refresh.ts` — proactive token refresh: refreshes
//! OAuth tokens before they expire to prevent auth failures mid-request
//! (spec 10, ARCHITECTURE §6.12: 5-min buffer, 250 ms stagger, batch
//! refresh).

use cma_accounts::manager::ManagedAccount;
use cma_auth::refresh_queue::queued_refresh;
use cma_core::logger::{create_logger, mask_email, ScopedLogger};
use cma_core::schemas::token::{TokenResult, TokenSuccess};
use cma_core::token_utils::{
    extract_account_email, extract_account_id, sanitize_email, should_update_account_id_from_token,
};
use cma_core::schemas::account_storage::AccountIdSource;
use cma_core::utils::{now_ms, sleep};
use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

fn log() -> &'static ScopedLogger {
    static LOG: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("proactive-refresh"));
    &LOG
}

/// Default buffer before expiry to trigger proactive refresh (5 minutes).
pub const DEFAULT_PROACTIVE_BUFFER_MS: i64 = 5 * 60 * 1000;

/// Minimum buffer to prevent unnecessary refreshes (30 seconds).
pub const MIN_PROACTIVE_BUFFER_MS: i64 = 30 * 1000;

const PROACTIVE_REFRESH_STAGGER_MS: u64 = 250;

/// TS `ProactiveRefreshResult.reason` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProactiveRefreshReason {
    NotNeeded,
    NoRefreshToken,
    Success,
    Failed,
}

impl ProactiveRefreshReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProactiveRefreshReason::NotNeeded => "not_needed",
            ProactiveRefreshReason::NoRefreshToken => "no_refresh_token",
            ProactiveRefreshReason::Success => "success",
            ProactiveRefreshReason::Failed => "failed",
        }
    }
}

/// TS `ProactiveRefreshResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProactiveRefreshResult {
    pub refreshed: bool,
    pub token_result: Option<TokenResult>,
    pub reason: ProactiveRefreshReason,
}

/// The injectable refresh seam (production: the global refresh queue; the
/// TS tests replaced the module import with `vi.mock`).
pub type RefreshFn =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = TokenResult> + Send>> + Send + Sync>;

/// The production refresh function — `queuedRefresh` over the global
/// cross-request refresh queue.
pub fn queued_refresh_fn() -> RefreshFn {
    Arc::new(|refresh_token| Box::pin(async move { queued_refresh(&refresh_token).await }))
}

/// Per-account result callback (TS `onResult`). Receives clones so the
/// returned future is `'static` (the TS closure captured everything by
/// reference on a single thread).
pub type OnRefreshResult = Box<
    dyn FnMut(ManagedAccount, ProactiveRefreshResult) -> Pin<Box<dyn Future<Output = ()> + Send>>
        + Send,
>;

/// TS `shouldRefreshProactively(account, bufferMs)` — true if the token is
/// approaching expiry and should be refreshed. No access token ⇒ true; no
/// expiry ⇒ false (can't determine); otherwise `now >= expires -
/// max(MIN_PROACTIVE_BUFFER_MS, bufferMs)`.
pub fn should_refresh_proactively(account: &ManagedAccount, buffer_ms: i64) -> bool {
    // TS `if (!account.access)` — undefined AND empty string are falsy.
    match account.meta.access_token.as_deref() {
        None | Some("") => return true,
        Some(_) => {}
    }
    let Some(expires_at) = account.meta.expires_at else {
        return false;
    };
    let safe_buffer_ms = buffer_ms.max(MIN_PROACTIVE_BUFFER_MS);
    now_ms() >= expires_at - safe_buffer_ms
}

/// TS `getTimeUntilExpiry(account)` — ms until expiry (`>= 0`), or `None`
/// for "no expiry set" (TS `Infinity`).
pub fn get_time_until_expiry(account: &ManagedAccount) -> Option<i64> {
    account
        .meta
        .expires_at
        .map(|expires_at| (expires_at - now_ms()).max(0))
}

/// TS `proactiveRefreshAccount(account, bufferMs)` using the global refresh
/// queue.
pub async fn proactive_refresh_account(
    account: &ManagedAccount,
    buffer_ms: i64,
) -> ProactiveRefreshResult {
    proactive_refresh_account_with(account, buffer_ms, &queued_refresh_fn()).await
}

/// Seam variant of [`proactive_refresh_account`] (tests inject the refresh
/// function).
pub async fn proactive_refresh_account_with(
    account: &ManagedAccount,
    buffer_ms: i64,
    refresh: &RefreshFn,
) -> ProactiveRefreshResult {
    if !should_refresh_proactively(account, buffer_ms) {
        return ProactiveRefreshResult {
            refreshed: false,
            token_result: None,
            reason: ProactiveRefreshReason::NotNeeded,
        };
    }

    if account.meta.refresh_token.is_empty() {
        log().warn(
            "Cannot proactively refresh account without refresh token",
            Some(&json!({ "accountIndex": account.index })),
        );
        return ProactiveRefreshResult {
            refreshed: false,
            token_result: None,
            reason: ProactiveRefreshReason::NoRefreshToken,
        };
    }

    let time_until_expiry = get_time_until_expiry(account);
    let mut data = serde_json::Map::new();
    data.insert("accountIndex".to_string(), json!(account.index));
    if let Some(email) = account.meta.email.as_deref() {
        data.insert("emailMasked".to_string(), json!(mask_email(email)));
    }
    // TS logs Infinity when no expiry is set; JSON.stringify(Infinity) is
    // null, which `Value::Null` matches.
    data.insert(
        "expiresInMs".to_string(),
        time_until_expiry.map_or(serde_json::Value::Null, |ms| json!(ms)),
    );
    data.insert(
        "expiresInMinutes".to_string(),
        time_until_expiry.map_or(serde_json::Value::Null, |ms| {
            json!(((ms as f64) / 60_000.0).round() as i64)
        }),
    );
    log().info(
        "Proactively refreshing token",
        Some(&serde_json::Value::Object(data)),
    );

    crate::observability::mutate_runtime_observability_snapshot(|snapshot| {
        snapshot.auth_refresh_requests += 1;
        snapshot.runtime_metrics.auth_refresh_requests += 1;
    });
    let result = refresh(account.meta.refresh_token.clone()).await;

    let mut identity = serde_json::Map::new();
    identity.insert("accountIndex".to_string(), json!(account.index));
    if let Some(email) = account.meta.email.as_deref() {
        identity.insert("emailMasked".to_string(), json!(mask_email(email)));
    }

    match &result {
        TokenResult::Success(_) => {
            log().info(
                "Proactive refresh succeeded",
                Some(&serde_json::Value::Object(identity)),
            );
            ProactiveRefreshResult {
                refreshed: true,
                token_result: Some(result),
                reason: ProactiveRefreshReason::Success,
            }
        }
        TokenResult::Failed(failure) => {
            identity.insert(
                "failureReason".to_string(),
                failure
                    .reason
                    .as_ref()
                    .map_or(serde_json::Value::Null, |reason| json!(reason.as_str())),
            );
            log().warn(
                "Proactive refresh failed",
                Some(&serde_json::Value::Object(identity)),
            );
            ProactiveRefreshResult {
                refreshed: true,
                token_result: Some(result),
                reason: ProactiveRefreshReason::Failed,
            }
        }
    }
}

/// TS `refreshExpiringAccounts(accounts, bufferMs, onResult?)` using the
/// global refresh queue.
pub async fn refresh_expiring_accounts(
    accounts: &[ManagedAccount],
    buffer_ms: i64,
    on_result: Option<OnRefreshResult>,
) -> HashMap<usize, ProactiveRefreshResult> {
    refresh_expiring_accounts_with(accounts, buffer_ms, on_result, &queued_refresh_fn()).await
}

/// Seam variant of [`refresh_expiring_accounts`]. Refreshes sequentially
/// with a 250 ms stagger between accounts; `on_result` runs per account as
/// each refresh settles. Returns a map keyed by `account.index`.
pub async fn refresh_expiring_accounts_with(
    accounts: &[ManagedAccount],
    buffer_ms: i64,
    mut on_result: Option<OnRefreshResult>,
    refresh: &RefreshFn,
) -> HashMap<usize, ProactiveRefreshResult> {
    let mut results: HashMap<usize, ProactiveRefreshResult> = HashMap::new();
    let accounts_to_refresh: Vec<&ManagedAccount> = accounts
        .iter()
        .filter(|account| should_refresh_proactively(account, buffer_ms))
        .collect();

    if accounts_to_refresh.is_empty() {
        log().debug("No accounts need proactive refresh", None);
        return results;
    }

    log().info(
        &format!(
            "Proactively refreshing {} account(s)",
            accounts_to_refresh.len()
        ),
        None,
    );

    let mut outcomes: Vec<(usize, ProactiveRefreshResult)> = Vec::new();
    for (position, account) in accounts_to_refresh.iter().enumerate() {
        if position > 0 {
            sleep(PROACTIVE_REFRESH_STAGGER_MS).await;
        }
        let result = proactive_refresh_account_with(account, buffer_ms, refresh).await;
        if let Some(on_result) = on_result.as_mut() {
            on_result((*account).clone(), result.clone()).await;
        }
        outcomes.push((account.index, result));
    }

    for (index, result) in outcomes {
        results.insert(index, result);
    }

    let succeeded = results
        .values()
        .filter(|r| r.reason == ProactiveRefreshReason::Success)
        .count();
    let failed = results
        .values()
        .filter(|r| r.reason == ProactiveRefreshReason::Failed)
        .count();
    if succeeded > 0 || failed > 0 {
        log().info(
            "Proactive refresh complete",
            Some(&json!({
                "total": accounts_to_refresh.len(),
                "succeeded": succeeded,
                "failed": failed,
            })),
        );
    }

    results
}

/// TS `applyRefreshResult(account, result)` — update a `ManagedAccount`
/// with fresh token data from a successful refresh.
pub fn apply_refresh_result(account: &mut ManagedAccount, result: &TokenSuccess) {
    account.meta.access_token = Some(result.access.clone());
    account.meta.expires_at = Some(result.expires);
    if result.refresh != account.meta.refresh_token {
        account.meta.refresh_token = result.refresh.clone();
    }
    let token_account_id = extract_account_id(Some(result.access.as_str()))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if let Some(token_account_id) = token_account_id
        && should_update_account_id_from_token(
            account.meta.account_id_source.as_ref(),
            account.meta.account_id.as_deref(),
        )
    {
        account.meta.account_id = Some(token_account_id);
        account.meta.account_id_source = Some(AccountIdSource::Token);
    }
    account.meta.email =
        sanitize_email(extract_account_email(Some(result.access.as_str()), None).as_deref())
            .or(account.meta.email.take());
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
    use cma_accounts::manager::AccountManager;

    fn account_with(access: Option<&str>, expires_at: Option<i64>) -> ManagedAccount {
        let now = now_ms();
        let mut meta = AccountMetadataV3::new("refresh-1", now, now);
        meta.access_token = access.map(|s| s.to_string());
        meta.expires_at = expires_at;
        let mut storage = AccountStorageV3::empty();
        storage.accounts = vec![meta];
        let manager = AccountManager::new(None, Some(&storage));
        manager.get_account_by_index(0).cloned().unwrap()
    }

    #[test]
    fn missing_or_empty_access_token_always_needs_refresh() {
        let account = account_with(None, Some(now_ms() + 3_600_000));
        assert!(should_refresh_proactively(&account, DEFAULT_PROACTIVE_BUFFER_MS));
        let account = account_with(Some(""), Some(now_ms() + 3_600_000));
        assert!(should_refresh_proactively(&account, DEFAULT_PROACTIVE_BUFFER_MS));
    }

    #[test]
    fn missing_expiry_means_no_refresh() {
        let account = account_with(Some("access"), None);
        assert!(!should_refresh_proactively(&account, DEFAULT_PROACTIVE_BUFFER_MS));
        assert_eq!(get_time_until_expiry(&account), None);
    }

    #[test]
    fn buffer_is_clamped_to_the_minimum() {
        // Expiry 60s out: a 1ms buffer clamps to 30s → not yet in window.
        let account = account_with(Some("access"), Some(now_ms() + 60_000));
        assert!(!should_refresh_proactively(&account, 1));
        // Expiry 20s out: inside the clamped 30s window.
        let account = account_with(Some("access"), Some(now_ms() + 20_000));
        assert!(should_refresh_proactively(&account, 1));
        // A large buffer widens the window.
        let account = account_with(Some("access"), Some(now_ms() + 60_000));
        assert!(should_refresh_proactively(&account, 120_000));
    }

    #[test]
    fn time_until_expiry_clamps_at_zero() {
        let account = account_with(Some("access"), Some(now_ms() - 5_000));
        assert_eq!(get_time_until_expiry(&account), Some(0));
    }

    #[test]
    fn reason_strings_are_frozen() {
        assert_eq!(ProactiveRefreshReason::NotNeeded.as_str(), "not_needed");
        assert_eq!(
            ProactiveRefreshReason::NoRefreshToken.as_str(),
            "no_refresh_token"
        );
        assert_eq!(ProactiveRefreshReason::Success.as_str(), "success");
        assert_eq!(ProactiveRefreshReason::Failed.as_str(), "failed");
    }
}
