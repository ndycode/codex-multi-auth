//! Port of `lib/runtime/rotation-token-refresh.ts` — per-request token
//! freshness for the proxy hot path (spec 10 §9, ARCHITECTURE §6.12).
//!
//! Key contracts:
//! - `apply_monotonic_auth_cooldown` — cooldowns only EXTEND, never
//!   shorten, and the comparison runs on the REAL wall clock
//!   (`cma_core::utils::now_ms`), never an injected clock: `coolingDownUntil`
//!   is written with real wall-clock time, so comparing an injected clock
//!   against it would silently defeat the guard.
//! - `ensure_fresh_access_token` — queued refresh + commit dedupe, 30s
//!   default auth-failure cooldown, 5-minute (configured) invalidation
//!   cooldown, `invalidated: true` tells the caller to STOP rotating (don't
//!   present other accounts' tokens from the same IP).

use cma_accounts::manager::{AccountIdentityCandidate, AccountManager, ManagedAccount};
use cma_accounts::manager_persistence::{SharedAccountManager, SAVE_DEBOUNCE_DEFAULT_MS};
use cma_auth::refresh_queue::queued_refresh;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::CooldownReason;
use cma_core::schemas::token::TokenResult;
use cma_core::types::OAuthAuthDetails;
use cma_core::utils::now_ms;
use cma_request::rate_limit_decision::{is_token_invalidation_error, is_token_refresh_retryable};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

/// TS `DEFAULT_AUTH_FAILURE_COOLDOWN_MS` (`@internal`, exported).
pub const DEFAULT_AUTH_FAILURE_COOLDOWN_MS: i64 = 30_000;

/// TS `applyMonotonicAuthCooldown(accountManager, account, cooldownMs)`.
///
/// Monotonic auth-failure cooldown: only extend, never shorten. Two
/// concurrent requests on the same account can race so that an invalidation
/// path sets a long cooldown (5 min) and a subsequent generic 401 truncates
/// it (30 s). Reading the live `cooling_down_until` before writing prevents
/// that race.
///
/// Intentionally `now_ms()` (== `Date.now()`), not any injected clock:
/// `cooling_down_until` is written by `mark_account_cooling_down` via the
/// real wall clock, so both sides of this comparison must live in the same
/// real-wall-clock domain.
pub fn apply_monotonic_auth_cooldown(
    account_manager: &mut AccountManager,
    account: &ManagedAccount,
    cooldown_ms: i64,
) {
    let existing = account_manager
        .get_account_by_index(account.index as i64)
        .and_then(|live| live.meta.cooling_down_until)
        .unwrap_or(0);
    if now_ms() + cooldown_ms > existing {
        account_manager.mark_account_cooling_down(
            account.index as i64,
            cooldown_ms,
            CooldownReason::AuthFailure,
        );
    }
}

/// TS private `hasUsableAccessToken(account, now, skewMs)`.
fn has_usable_access_token(account: &ManagedAccount, now: i64, skew_ms: i64) -> bool {
    let access_ok = account
        .meta
        .access_token
        .as_deref()
        .is_some_and(|access| !access.trim().is_empty());
    let expires_ok = account
        .meta
        .expires_at
        .is_some_and(|expires| expires > now + skew_ms.max(0));
    access_ok && expires_ok
}

/// The injectable refresh seam (TS module import `queuedRefresh`; the TS
/// tests replace it with `vi.mock`).
pub type RefreshTokenFn<'a> =
    &'a (dyn Fn(String) -> Pin<Box<dyn Future<Output = TokenResult> + Send>> + Sync);

/// TS `ensureFreshAccessToken` params object.
pub struct EnsureFreshAccessTokenParams<'a> {
    pub account_manager: &'a SharedAccountManager,
    /// Snapshot of the selected account (TS passed the live object).
    pub account: &'a ManagedAccount,
    pub family: ModelFamily,
    pub model: Option<&'a str>,
    pub now: i64,
    pub token_refresh_skew_ms: i64,
    pub token_invalidation_cooldown_ms: i64,
}

/// TS return union of `ensureFreshAccessToken`.
///
/// The `Ok` arm intentionally carries the full [`ManagedAccount`] inline
/// (TS returned the live account object); boxing it would push the cost
/// onto every success-path caller to shave bytes off the rare failure arm.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq)]
pub enum EnsureFreshAccessTokenResult {
    Ok {
        access_token: String,
        account: ManagedAccount,
    },
    Failed {
        retryable: bool,
        /// `true` = server-side refresh-token revocation: stop rotating.
        invalidated: bool,
    },
}

impl EnsureFreshAccessTokenResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, EnsureFreshAccessTokenResult::Ok { .. })
    }
}

// TS `runtimeRefreshCommitQueues: WeakMap<AccountManager, Map<key, Promise>>`
// — per-(manager, account-key) in-flight commit dedup. Keyed by the shared
// handle's inner Arc pointer; entries are removed when the commit settles,
// so a dead manager leaves nothing behind (WeakMap parity in practice).
type CommitOutcome = Result<Option<usize>, String>;
type CommitCell = tokio::sync::OnceCell<CommitOutcome>;
type CommitQueueMap = HashMap<(usize, String), Arc<CommitCell>>;
static RUNTIME_REFRESH_COMMIT_QUEUES: LazyLock<StdMutex<CommitQueueMap>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn commit_dedupe_key(account: &ManagedAccount) -> String {
    [
        account.index.to_string(),
        account.meta.account_id.clone().unwrap_or_default(),
        account.meta.email.clone().unwrap_or_default(),
        account.meta.refresh_token.clone(),
    ]
    .join("\0")
}

/// TS `commitRefreshedAuthOnce` — concurrent callers for the same
/// (manager, account) share one in-flight `commit_refreshed_auth` call.
async fn commit_refreshed_auth_once(
    account_manager: &SharedAccountManager,
    account: &ManagedAccount,
    auth: &OAuthAuthDetails,
) -> CommitOutcome {
    let map_key = (
        Arc::as_ptr(account_manager.manager()) as usize,
        commit_dedupe_key(account),
    );
    let (cell, inserted) = {
        let mut queues = RUNTIME_REFRESH_COMMIT_QUEUES
            .lock()
            .expect("commit queue poisoned");
        match queues.get(&map_key) {
            Some(existing) => (existing.clone(), false),
            None => {
                let cell = Arc::new(CommitCell::new());
                queues.insert(map_key.clone(), cell.clone());
                (cell, true)
            }
        }
    };

    let candidate = AccountIdentityCandidate {
        account_id: account.meta.account_id.clone(),
        email: account.meta.email.clone(),
        refresh_token: Some(account.meta.refresh_token.clone()),
        index: Some(account.index as i64),
    };
    let outcome = cell
        .get_or_init(|| async {
            let mut manager = account_manager.lock().await;
            manager
                .commit_refreshed_auth(&candidate, auth)
                .await
                .map_err(|error| error.to_string())
        })
        .await
        .clone();

    // TS `.finally(() => queue?.delete(key))` — the inserting caller removes
    // the entry once the shared commit settles; late waiters still hold the
    // Arc, new callers start a fresh commit.
    if inserted {
        RUNTIME_REFRESH_COMMIT_QUEUES
            .lock()
            .expect("commit queue poisoned")
            .remove(&map_key);
    }
    outcome
}

/// TS `ensureFreshAccessToken(params)` using the real global refresh queue.
pub async fn ensure_fresh_access_token(
    params: EnsureFreshAccessTokenParams<'_>,
) -> EnsureFreshAccessTokenResult {
    ensure_fresh_access_token_with(params, &|refresh_token| {
        Box::pin(async move { queued_refresh(&refresh_token).await })
    })
    .await
}

/// Seam variant used by tests (TS `vi.mock` of `queuedRefresh`). Behavior
/// is otherwise identical to [`ensure_fresh_access_token`].
pub async fn ensure_fresh_access_token_with(
    params: EnsureFreshAccessTokenParams<'_>,
    refresh: RefreshTokenFn<'_>,
) -> EnsureFreshAccessTokenResult {
    let EnsureFreshAccessTokenParams {
        account_manager,
        account,
        family,
        model,
        now,
        token_refresh_skew_ms,
        token_invalidation_cooldown_ms,
    } = params;

    if has_usable_access_token(account, now, token_refresh_skew_ms) {
        return EnsureFreshAccessTokenResult::Ok {
            access_token: account.meta.access_token.clone().unwrap_or_default(),
            account: account.clone(),
        };
    }

    let refresh_result = refresh(account.meta.refresh_token.clone()).await;
    let success = match refresh_result {
        TokenResult::Failed(failure) => {
            {
                let mut manager = account_manager.lock().await;
                manager.record_failure(account.index as i64, family, model);
                if let Some(live) = manager.get_account_by_index_mut(account.index as i64) {
                    live.increment_auth_failures();
                }
                // If the refresh endpoint itself returns an explicit
                // invalidation message (e.g. SSO revokes the refresh token
                // server-side), apply the long cooldown and signal the caller
                // to stop rotating.
                let invalidated =
                    is_token_invalidation_error(failure.message.as_deref().unwrap_or(""));
                apply_monotonic_auth_cooldown(
                    &mut manager,
                    account,
                    if invalidated {
                        token_invalidation_cooldown_ms
                    } else {
                        DEFAULT_AUTH_FAILURE_COOLDOWN_MS
                    },
                );
                account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                return EnsureFreshAccessTokenResult::Failed {
                    retryable: is_token_refresh_retryable(&failure),
                    invalidated,
                };
            }
        }
        TokenResult::Success(success) => success,
    };

    let auth = OAuthAuthDetails {
        access: success.access.clone(),
        refresh: success.refresh.clone(),
        expires: success.expires,
    };
    match commit_refreshed_auth_once(account_manager, account, &auth).await {
        Ok(committed_index) => {
            // If commit succeeded, use the stored access token from the
            // committed account (also covers the dedup case — both callers
            // end up with the same committed token). If commit returned None
            // (account missing from storage after persist), fall back to the
            // original account object but ALWAYS use the refresh result's
            // access token: the original account may carry an expired token,
            // and using that would 401 downstream and mis-trigger the
            // invalidation-cooldown logic.
            match committed_index {
                Some(index) => {
                    let updated = {
                        let manager = account_manager.lock().await;
                        manager.get_account_by_index(index as i64).cloned()
                    };
                    match updated {
                        Some(updated) => EnsureFreshAccessTokenResult::Ok {
                            access_token: updated
                                .meta
                                .access_token
                                .clone()
                                .unwrap_or_else(|| success.access.clone()),
                            account: updated,
                        },
                        None => EnsureFreshAccessTokenResult::Ok {
                            access_token: success.access.clone(),
                            account: account.clone(),
                        },
                    }
                }
                None => EnsureFreshAccessTokenResult::Ok {
                    access_token: success.access.clone(),
                    account: account.clone(),
                },
            }
        }
        Err(_) => {
            // TS catch branch: record failure, fixed 30s cooldown (direct,
            // not monotonic — TS parity), debounced save, retryable.
            let mut manager = account_manager.lock().await;
            manager.record_failure(account.index as i64, family, model);
            manager.mark_account_cooling_down(
                account.index as i64,
                DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
                CooldownReason::AuthFailure,
            );
            drop(manager);
            account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
            EnsureFreshAccessTokenResult::Failed {
                retryable: true,
                invalidated: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{
        AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily,
    };
    use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenSuccess};
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    const FAMILY: ModelFamily = ModelFamily::Gpt5Codex;
    const SKEW_MS: i64 = 30_000;
    const INVALIDATION_COOLDOWN_MS: i64 = 300_000;

    fn storage_with(expires_at: i64) -> AccountStorageV3 {
        let now = now_ms();
        let mut meta = AccountMetadataV3::new("refresh-1", now - 60_000, now - 60_000);
        meta.email = Some("account-1@example.com".to_string());
        meta.account_id = Some("acc_1".to_string());
        meta.access_token = Some("access-1".to_string());
        meta.expires_at = Some(expires_at);
        let mut storage = AccountStorageV3::empty();
        storage.accounts = vec![meta];
        let mut by_family = ActiveIndexByFamily::default();
        by_family.set(FAMILY, Some(0));
        storage.active_index_by_family = Some(by_family);
        storage
    }

    fn shared_manager_with(expires_at: i64) -> SharedAccountManager {
        AccountManager::reset_volatile_runtime_state();
        SharedAccountManager::new(AccountManager::new(None, Some(&storage_with(expires_at))))
    }

    fn refresh_success() -> TokenResult {
        TokenResult::Success(TokenSuccess {
            access: "access-new".to_string(),
            refresh: "refresh-new".to_string(),
            expires: now_ms() + 7_200_000,
            id_token: None,
            multi_account: None,
        })
    }

    fn refresh_failure(
        reason: TokenFailureReason,
        status_code: Option<i64>,
        message: &str,
    ) -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason: Some(reason),
            status_code,
            message: Some(message.to_string()),
        })
    }

    async fn run_ensure(
        shared: &SharedAccountManager,
        result: TokenResult,
    ) -> (EnsureFreshAccessTokenResult, usize) {
        let account = shared.lock().await.get_account_by_index(0).cloned().unwrap();
        let call_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let call_count_inner = call_count.clone();
        let refresh = move |_token: String| {
            call_count_inner.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let result = result.clone();
            Box::pin(async move { result }) as Pin<Box<dyn Future<Output = TokenResult> + Send>>
        };
        let outcome = ensure_fresh_access_token_with(
            EnsureFreshAccessTokenParams {
                account_manager: shared,
                account: &account,
                family: FAMILY,
                model: None,
                now: now_ms(),
                token_refresh_skew_ms: SKEW_MS,
                token_invalidation_cooldown_ms: INVALIDATION_COOLDOWN_MS,
            },
            &refresh,
        )
        .await;
        let calls = call_count.load(std::sync::atomic::Ordering::SeqCst);
        (outcome, calls)
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    #[serial(env)]
    fn uses_a_fresh_token_as_is_without_touching_the_refresh_queue() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let shared = shared_manager_with(now_ms() + 3_600_000);

            let (result, refresh_calls) = run_ensure(&shared, refresh_success()).await;

            assert_eq!(refresh_calls, 0);
            match result {
                EnsureFreshAccessTokenResult::Ok { access_token, .. } => {
                    assert_eq!(access_token, "access-1");
                }
                other => panic!("expected ok, got {other:?}"),
            }
            shared.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn refreshes_a_stale_token_and_commits_the_rotated_credentials() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            // Inside the refresh skew window: must refresh before use.
            let shared = shared_manager_with(now_ms() + 10_000);

            let (result, refresh_calls) = run_ensure(&shared, refresh_success()).await;

            assert_eq!(refresh_calls, 1);
            match result {
                EnsureFreshAccessTokenResult::Ok {
                    access_token,
                    account,
                } => {
                    assert_eq!(access_token, "access-new");
                    assert_eq!(account.meta.access_token.as_deref(), Some("access-new"));
                }
                other => panic!("expected ok, got {other:?}"),
            }
            // The in-memory pool now carries the rotated credentials.
            let live = shared.lock().await.get_account_by_index(0).cloned().unwrap();
            assert_eq!(live.meta.access_token.as_deref(), Some("access-new"));
            assert_eq!(live.meta.refresh_token, "refresh-new");
            shared.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn applies_the_short_cooldown_on_a_non_retryable_auth_failure() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let now = now_ms();
            let shared = shared_manager_with(now + 10_000);

            let (result, _) = run_ensure(
                &shared,
                refresh_failure(TokenFailureReason::HttpError, Some(401), "token expired"),
            )
            .await;

            assert_eq!(
                result,
                EnsureFreshAccessTokenResult::Failed {
                    retryable: false,
                    invalidated: false,
                }
            );
            let cooling_down_until = shared
                .lock()
                .await
                .get_account_by_index(0)
                .and_then(|a| a.meta.cooling_down_until)
                .unwrap_or(0);
            assert!(cooling_down_until > now);
            assert!(cooling_down_until <= now_ms() + DEFAULT_AUTH_FAILURE_COOLDOWN_MS);
            shared.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn marks_transient_refresh_failures_retryable() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let shared = shared_manager_with(now_ms() + 10_000);

            let (result, _) = run_ensure(
                &shared,
                refresh_failure(TokenFailureReason::NetworkError, None, "fetch failed"),
            )
            .await;

            match result {
                EnsureFreshAccessTokenResult::Failed { retryable, .. } => assert!(retryable),
                other => panic!("expected failed, got {other:?}"),
            }
            shared.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn applies_the_long_cooldown_and_signals_invalidation_on_a_revoked_token() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let now = now_ms();
            let shared = shared_manager_with(now + 10_000);

            let (result, _) = run_ensure(
                &shared,
                refresh_failure(
                    TokenFailureReason::HttpError,
                    Some(401),
                    "OAuth token has been invalidated",
                ),
            )
            .await;

            match result {
                EnsureFreshAccessTokenResult::Failed { invalidated, .. } => assert!(invalidated),
                other => panic!("expected failed, got {other:?}"),
            }
            let cooling_down_until = shared
                .lock()
                .await
                .get_account_by_index(0)
                .and_then(|a| a.meta.cooling_down_until)
                .unwrap_or(0);
            // The invalidation cooldown is the long one, far beyond 30s.
            assert!(cooling_down_until > now + INVALIDATION_COOLDOWN_MS - 10_000);
            shared.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn never_lets_a_later_generic_failure_truncate_an_invalidation_cooldown() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let shared = shared_manager_with(now_ms() + 10_000);
            let long_deadline = {
                let mut manager = shared.lock().await;
                manager.mark_account_cooling_down(
                    0,
                    INVALIDATION_COOLDOWN_MS,
                    CooldownReason::AuthFailure,
                );
                manager
                    .get_account_by_index(0)
                    .and_then(|a| a.meta.cooling_down_until)
                    .unwrap()
            };

            // Refresh path skips the cooldown check itself (that lives in
            // selection); a generic 401 arrives while the long cooldown is
            // live.
            let (_result, _) = run_ensure(
                &shared,
                refresh_failure(TokenFailureReason::HttpError, Some(401), "token expired"),
            )
            .await;

            // Monotonic guard: the 30s generic cooldown must not shorten the
            // 5-minute invalidation cooldown set by a concurrent request.
            let after = shared
                .lock()
                .await
                .get_account_by_index(0)
                .and_then(|a| a.meta.cooling_down_until)
                .unwrap();
            assert_eq!(after, long_deadline);
            shared.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn apply_monotonic_extends_but_never_shortens() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let shared = shared_manager_with(now_ms() + 3_600_000);
            let mut manager = shared.lock().await;
            let account = manager.get_account_by_index(0).cloned().unwrap();

            apply_monotonic_auth_cooldown(&mut manager, &account, 60_000);
            let first_deadline = manager
                .get_account_by_index(0)
                .and_then(|a| a.meta.cooling_down_until)
                .unwrap();
            assert!(first_deadline > now_ms() - 1_000);

            apply_monotonic_auth_cooldown(&mut manager, &account, 1_000);
            assert_eq!(
                manager
                    .get_account_by_index(0)
                    .and_then(|a| a.meta.cooling_down_until)
                    .unwrap(),
                first_deadline
            );

            apply_monotonic_auth_cooldown(&mut manager, &account, 600_000);
            assert!(
                manager
                    .get_account_by_index(0)
                    .and_then(|a| a.meta.cooling_down_until)
                    .unwrap()
                    > first_deadline
            );
        });
    }
}
