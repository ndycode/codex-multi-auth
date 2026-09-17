//! Port of `lib/refresh-guardian.ts` (the `RefreshGuardian` background
//! loop) + `lib/runtime/refresh-guardian.ts` (the
//! `ensureRuntimeRefreshGuardian` lifecycle helper, absorbed entry:
//! `refresh-guardian-entry.ts`). Spec 10 §21, ARCHITECTURE §6.12: 60 s
//! loop, family `"codex"` bookkeeping, disable-on-no-refresh-token.
//!
//! The interval task is spawned on the ambient tokio runtime (the TS timer
//! was `unref()`'d — tokio tasks likewise never keep a process alive on
//! their own); lifecycle owners register a stop cleanup with
//! `cma_core::shutdown` through [`ensure_runtime_refresh_guardian`]'s
//! `register_cleanup` seam.

use crate::proactive_refresh::{
    refresh_expiring_accounts_with, queued_refresh_fn, ProactiveRefreshReason,
    ProactiveRefreshResult, RefreshFn,
};
use cma_accounts::manager::{AccountIdentityCandidate, ManagedAccount};
use cma_accounts::manager_persistence::{SharedAccountManager, SAVE_DEBOUNCE_DEFAULT_MS};
use cma_core::constants::ACCOUNT_LIMITS;
use cma_core::errors::CodexError;
use cma_core::logger::{create_logger, ScopedLogger};
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::CooldownReason;
use cma_core::schemas::token::TokenResult;
use cma_core::types::OAuthAuthDetails;
use cma_core::utils::now_ms;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

fn log() -> &'static ScopedLogger {
    static LOG: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("refresh-guardian"));
    &LOG
}

const REFRESH_HEALTH_FAMILY: ModelFamily = ModelFamily::Codex;
const DEFAULT_INTERVAL_MS: i64 = 60_000;
const NETWORK_FAILURE_COOLDOWN_MS: i64 = 6_000;

/// TS `RefreshGuardianOptions`.
#[derive(Default, Clone)]
pub struct RefreshGuardianOptions {
    pub interval_ms: Option<f64>,
    pub buffer_ms: Option<f64>,
    /// Test seam replacing the TS `vi.mock` of `queuedRefresh`. `None` uses
    /// the global refresh queue.
    pub refresh_fn: Option<RefreshFn>,
}

/// TS `RefreshGuardianStats`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RefreshGuardianStats {
    pub runs: i64,
    pub refreshed: i64,
    pub failed: i64,
    pub not_needed: i64,
    pub no_refresh_token: i64,
    pub rate_limited: i64,
    pub network_failed: i64,
    pub auth_failed: i64,
    pub last_run_at: Option<i64>,
}

/// The manager accessor (TS `getAccountManager: () => AccountManager |
/// null`).
pub type GetAccountManagerFn = Arc<dyn Fn() -> Option<SharedAccountManager> + Send + Sync>;

struct GuardianInner {
    get_account_manager: GetAccountManagerFn,
    interval_ms: i64,
    buffer_ms: i64,
    refresh_fn: RefreshFn,
    running: AtomicBool,
    stats: StdMutex<RefreshGuardianStats>,
    timer: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

/// TS `class RefreshGuardian` — cheaply clonable handle (the interval task
/// holds one).
#[derive(Clone)]
pub struct RefreshGuardian {
    inner: Arc<GuardianInner>,
}

impl RefreshGuardian {
    /// TS `constructor(getAccountManager, options)` — interval floor 5 s,
    /// buffer floor 30 s.
    pub fn new(get_account_manager: GetAccountManagerFn, options: RefreshGuardianOptions) -> Self {
        let interval_ms = options
            .interval_ms
            .unwrap_or(DEFAULT_INTERVAL_MS as f64)
            .floor()
            .max(5_000.0) as i64;
        let buffer_ms = options
            .buffer_ms
            .unwrap_or((5 * 60_000) as f64)
            .floor()
            .max(30_000.0) as i64;
        Self {
            inner: Arc::new(GuardianInner {
                get_account_manager,
                interval_ms,
                buffer_ms,
                refresh_fn: options.refresh_fn.unwrap_or_else(queued_refresh_fn),
                running: AtomicBool::new(false),
                stats: StdMutex::new(RefreshGuardianStats::default()),
                timer: StdMutex::new(None),
            }),
        }
    }

    pub fn interval_ms(&self) -> i64 {
        self.inner.interval_ms
    }

    pub fn buffer_ms(&self) -> i64 {
        self.inner.buffer_ms
    }

    /// TS `start()` — idempotent; spawns the interval loop (first tick
    /// after one interval, `setInterval` parity). Must be called from
    /// within a tokio runtime.
    pub fn start(&self) {
        let mut timer = self.inner.timer.lock().expect("guardian timer poisoned");
        if timer.is_some() {
            return;
        }
        let guardian = self.clone();
        *timer = Some(tokio::spawn(async move {
            loop {
                cma_core::utils::sleep(guardian.inner.interval_ms as u64).await;
                guardian.tick().await;
            }
        }));
        log().debug(
            "Refresh guardian started",
            Some(&json!({
                "intervalMs": self.inner.interval_ms,
                "bufferMs": self.inner.buffer_ms,
            })),
        );
    }

    /// TS `stop()` — idempotent.
    pub fn stop(&self) {
        let mut timer = self.inner.timer.lock().expect("guardian timer poisoned");
        if let Some(handle) = timer.take() {
            handle.abort();
        }
    }

    /// TS `getStats()` — a copy.
    pub fn get_stats(&self) -> RefreshGuardianStats {
        self.inner.stats.lock().expect("guardian stats poisoned").clone()
    }

    /// TS `async tick()` — one guardian pass; re-entrancy-guarded.
    pub async fn tick(&self) {
        // TS: `if (this.running) return;` then manager lookup, then
        // `running = true`.
        if self.inner.running.load(Ordering::SeqCst) {
            return;
        }
        let Some(manager) = (self.inner.get_account_manager)() else {
            return;
        };
        if self.inner.running.swap(true, Ordering::SeqCst) {
            return;
        }
        self.run_tick(&manager).await;
        self.inner.running.store(false, Ordering::SeqCst);
    }

    async fn run_tick(&self, manager: &SharedAccountManager) {
        let snapshot: Vec<ManagedAccount> = {
            let mut pool = manager.lock().await;
            pool.get_accounts_snapshot()
                .into_iter()
                .filter(|account| account.is_enabled())
                .collect()
        };
        if snapshot.is_empty() {
            return;
        }

        let eligible: Vec<ManagedAccount> = {
            let mut pool = manager.lock().await;
            snapshot
                .into_iter()
                .filter(|account| !pool.is_account_cooling_down(account.index as i64))
                .collect()
        };
        if eligible.is_empty() {
            let mut stats = self.inner.stats.lock().expect("guardian stats poisoned");
            stats.runs += 1;
            stats.last_run_at = Some(now_ms());
            return;
        }

        let requires_save = Arc::new(AtomicBool::new(false));
        let on_result = {
            let inner = self.inner.clone();
            let manager = manager.clone();
            let requires_save = requires_save.clone();
            Box::new(
                move |account: ManagedAccount, result: ProactiveRefreshResult| {
                    let inner = inner.clone();
                    let manager = manager.clone();
                    let requires_save = requires_save.clone();
                    Box::pin(async move {
                        let save_needed =
                            apply_refresh_outcome(&inner, &manager, &account, &result).await;
                        if save_needed {
                            requires_save.store(true, Ordering::SeqCst);
                        }
                    }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
                },
            )
        };

        let refresh_results = refresh_expiring_accounts_with(
            &eligible,
            self.inner.buffer_ms,
            Some(on_result),
            &self.inner.refresh_fn,
        )
        .await;

        if refresh_results.is_empty() {
            let mut stats = self.inner.stats.lock().expect("guardian stats poisoned");
            stats.runs += 1;
            stats.last_run_at = Some(now_ms());
            return;
        }

        if requires_save.load(Ordering::SeqCst) {
            manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
        }
        let mut stats = self.inner.stats.lock().expect("guardian stats poisoned");
        stats.runs += 1;
        stats.last_run_at = Some(now_ms());
    }
}

fn identity_candidate(account: &ManagedAccount) -> AccountIdentityCandidate {
    AccountIdentityCandidate {
        account_id: account.meta.account_id.clone(),
        email: account.meta.email.clone(),
        refresh_token: Some(account.meta.refresh_token.clone()),
        index: Some(account.index as i64),
    }
}

/// TS private `classifyFailureReason(tokenResult)`.
fn classify_failure_reason(token_result: Option<&TokenResult>) -> CooldownReason {
    let Some(TokenResult::Failed(failure)) = token_result else {
        return CooldownReason::NetworkError;
    };
    use cma_core::schemas::token::TokenFailureReason as Reason;
    if failure.status_code == Some(429) {
        return CooldownReason::RateLimit;
    }
    match failure.reason {
        Some(Reason::NetworkError) => CooldownReason::NetworkError,
        Some(Reason::MissingRefresh) | Some(Reason::InvalidResponse) => CooldownReason::AuthFailure,
        Some(Reason::HttpError)
            if matches!(failure.status_code, Some(400) | Some(401) | Some(403)) =>
        {
            CooldownReason::AuthFailure
        }
        _ => CooldownReason::NetworkError,
    }
}

fn network_failure_cooldown_ms(buffer_ms: i64) -> i64 {
    buffer_ms.min(NETWORK_FAILURE_COOLDOWN_MS)
}

fn auth_failure_cooldown_ms(buffer_ms: i64, failure_count: u32) -> i64 {
    let streak = i64::from(failure_count).max(1);
    buffer_ms.min(ACCOUNT_LIMITS.auth_failure_cooldown_ms * streak)
}

/// Locate the live account by identity and apply the network-failure
/// treatment (clear auth failures, short network cooldown, health failure).
/// Returns whether an account was found (⇒ save needed).
async fn apply_network_failure(
    inner: &GuardianInner,
    manager: &SharedAccountManager,
    candidate: &AccountIdentityCandidate,
    auth: Option<&OAuthAuthDetails>,
) -> bool {
    let mut pool = manager.lock().await;
    let account_index = pool
        .get_account_by_identity(candidate, auth)
        .map(|account| account.index as i64)
        .or_else(|| {
            auth.and_then(|_| {
                pool.get_account_by_identity(candidate, None)
                    .map(|account| account.index as i64)
            })
        });
    let Some(index) = account_index else {
        return false;
    };
    if let Some(live) = pool.get_account_by_index_mut(index) {
        live.clear_auth_failures();
    }
    pool.mark_account_cooling_down(
        index,
        network_failure_cooldown_ms(inner.buffer_ms),
        CooldownReason::NetworkError,
    );
    pool.record_failure(index, REFRESH_HEALTH_FAMILY, None);
    true
}

/// TS private `applyRefreshOutcome(manager, sourceAccount, result)` —
/// returns `true` when the caller must schedule a debounced save.
async fn apply_refresh_outcome(
    inner: &GuardianInner,
    manager: &SharedAccountManager,
    source_account: &ManagedAccount,
    result: &ProactiveRefreshResult,
) -> bool {
    let candidate = identity_candidate(source_account);
    match result.reason {
        ProactiveRefreshReason::Success => {
            let Some(TokenResult::Success(token)) = result.token_result.as_ref() else {
                // Defensive TS branch: a "success" result without a success
                // token is treated as a network failure.
                let found = apply_network_failure(inner, manager, &candidate, None).await;
                let mut stats = inner.stats.lock().expect("guardian stats poisoned");
                stats.failed += 1;
                stats.network_failed += 1;
                return found;
            };

            let refreshed_auth = OAuthAuthDetails {
                access: token.access.clone(),
                refresh: token.refresh.clone(),
                expires: token.expires,
            };
            let commit_result: Result<Option<usize>, CodexError> = {
                let mut pool = manager.lock().await;
                pool.commit_refreshed_auth(&candidate, &refreshed_auth).await
            };
            match commit_result {
                Ok(Some(committed_index)) => {
                    // recordSuccess schedules its own debounced save when it
                    // heals state (SharedAccountManager wrapper parity).
                    manager
                        .record_success(committed_index as i64, REFRESH_HEALTH_FAMILY, None)
                        .await;
                    let mut stats = inner.stats.lock().expect("guardian stats poisoned");
                    stats.refreshed += 1;
                    false
                }
                Ok(None) => {
                    let found =
                        apply_network_failure(inner, manager, &candidate, Some(&refreshed_auth))
                            .await;
                    let mut stats = inner.stats.lock().expect("guardian stats poisoned");
                    stats.failed += 1;
                    stats.network_failed += 1;
                    found
                }
                Err(error) => {
                    log().warn(
                        "Refresh guardian commit failed",
                        Some(&json!({
                            "sourceIndex": source_account.index,
                            "error": error.to_string(),
                        })),
                    );
                    let cooldown_reason = match &error {
                        CodexError::Auth { retryable, .. } if !*retryable => {
                            CooldownReason::AuthFailure
                        }
                        _ => CooldownReason::NetworkError,
                    };
                    let found = {
                        let mut pool = manager.lock().await;
                        let account_index = pool
                            .get_account_by_identity(&candidate, Some(&refreshed_auth))
                            .map(|account| account.index as i64)
                            .or_else(|| {
                                pool.get_account_by_identity(&candidate, None)
                                    .map(|account| account.index as i64)
                            });
                        if let Some(index) = account_index {
                            if cooldown_reason == CooldownReason::AuthFailure {
                                let failure_count = pool
                                    .get_account_by_index_mut(index)
                                    .map(|live| live.increment_auth_failures())
                                    .unwrap_or(1);
                                pool.mark_account_cooling_down(
                                    index,
                                    auth_failure_cooldown_ms(inner.buffer_ms, failure_count),
                                    cooldown_reason,
                                );
                            } else {
                                if let Some(live) = pool.get_account_by_index_mut(index) {
                                    live.clear_auth_failures();
                                }
                                pool.mark_account_cooling_down(
                                    index,
                                    network_failure_cooldown_ms(inner.buffer_ms),
                                    cooldown_reason,
                                );
                            }
                            pool.record_failure(index, REFRESH_HEALTH_FAMILY, None);
                            true
                        } else {
                            false
                        }
                    };
                    let mut stats = inner.stats.lock().expect("guardian stats poisoned");
                    stats.failed += 1;
                    if cooldown_reason == CooldownReason::AuthFailure {
                        stats.auth_failed += 1;
                    } else {
                        stats.network_failed += 1;
                    }
                    found
                }
            }
        }
        ProactiveRefreshReason::Failed => {
            let mut pool = manager.lock().await;
            let Some(index) = pool
                .get_account_by_identity(&candidate, None)
                .map(|account| account.index as i64)
            else {
                return false;
            };
            let cooldown_reason = classify_failure_reason(result.token_result.as_ref());
            match cooldown_reason {
                CooldownReason::RateLimit => {
                    if let Some(live) = pool.get_account_by_index_mut(index) {
                        live.clear_auth_failures();
                    }
                    pool.mark_rate_limited(index, inner.buffer_ms, ModelFamily::Codex, None);
                    pool.record_rate_limit(index, REFRESH_HEALTH_FAMILY, None);
                }
                CooldownReason::AuthFailure => {
                    let failure_count = pool
                        .get_account_by_index_mut(index)
                        .map(|live| live.increment_auth_failures())
                        .unwrap_or(1);
                    pool.mark_account_cooling_down(
                        index,
                        auth_failure_cooldown_ms(inner.buffer_ms, failure_count),
                        cooldown_reason,
                    );
                    pool.record_failure(index, REFRESH_HEALTH_FAMILY, None);
                }
                _ => {
                    if let Some(live) = pool.get_account_by_index_mut(index) {
                        live.clear_auth_failures();
                    }
                    pool.mark_account_cooling_down(
                        index,
                        network_failure_cooldown_ms(inner.buffer_ms),
                        cooldown_reason,
                    );
                    pool.record_failure(index, REFRESH_HEALTH_FAMILY, None);
                }
            }
            drop(pool);
            let mut stats = inner.stats.lock().expect("guardian stats poisoned");
            stats.failed += 1;
            match cooldown_reason {
                CooldownReason::RateLimit => stats.rate_limited += 1,
                CooldownReason::AuthFailure => stats.auth_failed += 1,
                _ => stats.network_failed += 1,
            }
            true
        }
        ProactiveRefreshReason::NotNeeded => {
            let mut stats = inner.stats.lock().expect("guardian stats poisoned");
            stats.not_needed += 1;
            false
        }
        ProactiveRefreshReason::NoRefreshToken => {
            let mut pool = manager.lock().await;
            let Some(index) = pool
                .get_account_by_identity(&candidate, None)
                .map(|account| account.index as i64)
            else {
                return false;
            };
            let failure_count = pool
                .get_account_by_index_mut(index)
                .map(|live| live.increment_auth_failures())
                .unwrap_or(1);
            pool.mark_account_cooling_down(
                index,
                auth_failure_cooldown_ms(inner.buffer_ms, failure_count),
                CooldownReason::AuthFailure,
            );
            pool.record_failure(index, REFRESH_HEALTH_FAMILY, None);
            pool.set_account_enabled(index, false);
            drop(pool);
            let mut stats = inner.stats.lock().expect("guardian stats poisoned");
            stats.no_refresh_token += 1;
            stats.failed += 1;
            stats.auth_failed += 1;
            true
        }
    }
}

// ============================================================================
// `lib/runtime/refresh-guardian.ts` — ensureRuntimeRefreshGuardian
// ============================================================================

/// TS `RefreshGuardianController` (start/stop lifecycle).
pub trait RefreshGuardianLike {
    fn start(&self);
    fn stop(&self);
}

impl RefreshGuardianLike for RefreshGuardian {
    fn start(&self) {
        RefreshGuardian::start(self)
    }
    fn stop(&self) {
        RefreshGuardian::stop(self)
    }
}

/// TS `ensureRuntimeRefreshGuardian(deps)` params — config values are
/// precomputed by the caller (the entry shim derived them from
/// `PluginConfig` getters; see
/// [`crate::services::ensure_refresh_guardian_entry`]).
pub struct EnsureRuntimeRefreshGuardianParams<'a, TGuardian: RefreshGuardianLike> {
    pub enabled: bool,
    pub interval_ms: f64,
    pub buffer_ms: f64,
    pub current_guardian: Option<Arc<TGuardian>>,
    pub current_config_key: Option<String>,
    pub current_cleanup_registered: bool,
    /// Cleanup closures resolve the CURRENT guardian at shutdown time (TS
    /// `getCurrentGuardian()?.stop()`).
    pub get_current_guardian: Arc<dyn Fn() -> Option<Arc<TGuardian>> + Send + Sync>,
    pub create_guardian: &'a mut dyn FnMut(f64, f64) -> Arc<TGuardian>,
    pub register_cleanup: &'a mut dyn FnMut(Box<dyn FnOnce() + Send>),
}

/// TS `ensureRuntimeRefreshGuardian` result.
pub struct EnsureRuntimeRefreshGuardianResult<TGuardian: RefreshGuardianLike> {
    pub guardian: Option<Arc<TGuardian>>,
    pub config_key: Option<String>,
    pub cleanup_registered: bool,
}

/// JS template-literal number formatting for config keys
/// (`${intervalMs}:${bufferMs}` — integers print without a decimal point).
pub(crate) fn js_number_string(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// TS `ensureRuntimeRefreshGuardian(deps)` — disabled ⇒ stop current;
/// matching config key ⇒ reuse; otherwise stop old, create + START a new
/// guardian and register the stop-cleanup exactly once per process slot.
pub fn ensure_runtime_refresh_guardian<TGuardian>(
    params: EnsureRuntimeRefreshGuardianParams<'_, TGuardian>,
) -> EnsureRuntimeRefreshGuardianResult<TGuardian>
where
    TGuardian: RefreshGuardianLike + Send + Sync + 'static,
{
    let EnsureRuntimeRefreshGuardianParams {
        enabled,
        interval_ms,
        buffer_ms,
        current_guardian,
        current_config_key,
        current_cleanup_registered,
        get_current_guardian,
        create_guardian,
        register_cleanup,
    } = params;

    if !enabled {
        if let Some(current) = current_guardian.as_ref() {
            current.stop();
        }
        return EnsureRuntimeRefreshGuardianResult {
            guardian: None,
            config_key: None,
            cleanup_registered: current_cleanup_registered,
        };
    }

    let config_key = format!(
        "{}:{}",
        js_number_string(interval_ms),
        js_number_string(buffer_ms)
    );
    if let Some(current) = current_guardian.as_ref()
        && current_config_key.as_deref() == Some(config_key.as_str())
    {
        return EnsureRuntimeRefreshGuardianResult {
            guardian: Some(current.clone()),
            config_key: current_config_key,
            cleanup_registered: current_cleanup_registered,
        };
    }

    if let Some(current) = current_guardian.as_ref() {
        current.stop();
    }
    let guardian = create_guardian(interval_ms, buffer_ms);
    guardian.start();
    let mut cleanup_registered = current_cleanup_registered;
    if !cleanup_registered {
        let get_current = get_current_guardian.clone();
        register_cleanup(Box::new(move || {
            if let Some(current) = get_current() {
                current.stop();
            }
        }));
        cleanup_registered = true;
    }
    EnsureRuntimeRefreshGuardianResult {
        guardian: Some(guardian),
        config_key: Some(config_key),
        cleanup_registered,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_accounts::manager::AccountManager;
    use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenSuccess};
    use cma_core::schemas::account_storage::{
        AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily,
    };
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use std::sync::atomic::AtomicUsize;

    // ---- classifyFailureReason matrix ----

    fn failed(reason: Option<TokenFailureReason>, status_code: Option<i64>) -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason,
            status_code,
            message: None,
        })
    }

    #[test]
    fn classify_failure_reason_matrix() {
        use TokenFailureReason as R;
        assert_eq!(classify_failure_reason(None), CooldownReason::NetworkError);
        assert_eq!(
            classify_failure_reason(Some(&failed(Some(R::HttpError), Some(429)))),
            CooldownReason::RateLimit
        );
        assert_eq!(
            classify_failure_reason(Some(&failed(Some(R::NetworkError), None))),
            CooldownReason::NetworkError
        );
        assert_eq!(
            classify_failure_reason(Some(&failed(Some(R::MissingRefresh), None))),
            CooldownReason::AuthFailure
        );
        assert_eq!(
            classify_failure_reason(Some(&failed(Some(R::InvalidResponse), None))),
            CooldownReason::AuthFailure
        );
        for status in [400, 401, 403] {
            assert_eq!(
                classify_failure_reason(Some(&failed(Some(R::HttpError), Some(status)))),
                CooldownReason::AuthFailure
            );
        }
        assert_eq!(
            classify_failure_reason(Some(&failed(Some(R::HttpError), Some(500)))),
            CooldownReason::NetworkError
        );
        assert_eq!(
            classify_failure_reason(Some(&failed(None, None))),
            CooldownReason::NetworkError
        );
    }

    #[test]
    fn cooldown_budgets_are_clamped_by_the_buffer() {
        assert_eq!(network_failure_cooldown_ms(300_000), 6_000);
        assert_eq!(network_failure_cooldown_ms(4_000), 4_000);
        // 30s * streak, capped at buffer.
        assert_eq!(auth_failure_cooldown_ms(300_000, 1), 30_000);
        assert_eq!(auth_failure_cooldown_ms(300_000, 3), 90_000);
        assert_eq!(auth_failure_cooldown_ms(50_000, 3), 50_000);
        assert_eq!(auth_failure_cooldown_ms(300_000, 0), 30_000);
    }

    #[test]
    fn constructor_clamps_interval_and_buffer() {
        let guardian = RefreshGuardian::new(
            Arc::new(|| None),
            RefreshGuardianOptions {
                interval_ms: Some(1.0),
                buffer_ms: Some(1.0),
                refresh_fn: None,
            },
        );
        assert_eq!(guardian.interval_ms(), 5_000);
        assert_eq!(guardian.buffer_ms(), 30_000);

        let guardian = RefreshGuardian::new(Arc::new(|| None), RefreshGuardianOptions::default());
        assert_eq!(guardian.interval_ms(), 60_000);
        assert_eq!(guardian.buffer_ms(), 300_000);
    }

    // ---- tick behavior against a real pool ----

    fn storage_with_expiring_account(expires_at: i64) -> AccountStorageV3 {
        let now = now_ms();
        let mut meta = AccountMetadataV3::new("refresh-1", now - 60_000, now - 60_000);
        meta.email = Some("account-1@example.com".to_string());
        meta.account_id = Some("acc_1".to_string());
        meta.access_token = Some("access-1".to_string());
        meta.expires_at = Some(expires_at);
        let mut storage = AccountStorageV3::empty();
        storage.accounts = vec![meta];
        let mut by_family = ActiveIndexByFamily::default();
        by_family.set(ModelFamily::Codex, Some(0));
        storage.active_index_by_family = Some(by_family);
        storage
    }

    fn static_refresh(result: TokenResult, calls: Arc<AtomicUsize>) -> RefreshFn {
        Arc::new(move |_token| {
            calls.fetch_add(1, Ordering::SeqCst);
            let result = result.clone();
            Box::pin(async move { result })
        })
    }

    fn guardian_for(manager: SharedAccountManager, refresh_fn: RefreshFn) -> RefreshGuardian {
        RefreshGuardian::new(
            Arc::new(move || Some(manager.clone())),
            RefreshGuardianOptions {
                interval_ms: Some(60_000.0),
                buffer_ms: Some(300_000.0),
                refresh_fn: Some(refresh_fn),
            },
        )
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    #[serial(env)]
    fn tick_counts_a_run_without_refreshing_fresh_tokens() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            AccountManager::reset_volatile_runtime_state();
            let manager = SharedAccountManager::new(AccountManager::new(
                None,
                Some(&storage_with_expiring_account(now_ms() + 3_600_000)),
            ));
            let calls = Arc::new(AtomicUsize::new(0));
            let guardian = guardian_for(
                manager.clone(),
                static_refresh(
                    TokenResult::Failed(TokenFailure {
                        reason: None,
                        status_code: None,
                        message: None,
                    }),
                    calls.clone(),
                ),
            );

            guardian.tick().await;

            // Fresh token: nothing to refresh, no refresh call, one run.
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            let stats = guardian.get_stats();
            assert_eq!(stats.runs, 1);
            assert_eq!(stats.refreshed, 0);
            assert!(stats.last_run_at.is_some());
            manager.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn tick_commits_a_successful_refresh_and_counts_it() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            AccountManager::reset_volatile_runtime_state();
            // Expiring inside the 5-minute buffer.
            let manager = SharedAccountManager::new(AccountManager::new(
                None,
                Some(&storage_with_expiring_account(now_ms() + 60_000)),
            ));
            let calls = Arc::new(AtomicUsize::new(0));
            let guardian = guardian_for(
                manager.clone(),
                static_refresh(
                    TokenResult::Success(TokenSuccess {
                        access: "access-new".to_string(),
                        refresh: "refresh-new".to_string(),
                        expires: now_ms() + 7_200_000,
                        id_token: None,
                        multi_account: None,
                    }),
                    calls.clone(),
                ),
            );

            guardian.tick().await;

            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let stats = guardian.get_stats();
            assert_eq!(stats.runs, 1);
            assert_eq!(stats.refreshed, 1);
            assert_eq!(stats.failed, 0);
            let live = manager.lock().await.get_account_by_index(0).cloned().unwrap();
            assert_eq!(live.meta.access_token.as_deref(), Some("access-new"));
            assert_eq!(live.meta.refresh_token, "refresh-new");
            manager.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn tick_rate_limits_the_account_on_a_429_refresh_failure() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            AccountManager::reset_volatile_runtime_state();
            let manager = SharedAccountManager::new(AccountManager::new(
                None,
                Some(&storage_with_expiring_account(now_ms() + 60_000)),
            ));
            let calls = Arc::new(AtomicUsize::new(0));
            let guardian = guardian_for(
                manager.clone(),
                static_refresh(
                    failed(Some(TokenFailureReason::HttpError), Some(429)),
                    calls.clone(),
                ),
            );

            guardian.tick().await;

            let stats = guardian.get_stats();
            assert_eq!(stats.failed, 1);
            assert_eq!(stats.rate_limited, 1);
            assert_eq!(stats.auth_failed, 0);
            let live = manager.lock().await.get_account_by_index(0).cloned().unwrap();
            assert!(live.rate_limit_reset_times.get("codex").is_some());
            manager.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn tick_cools_down_the_account_on_an_auth_refresh_failure() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            AccountManager::reset_volatile_runtime_state();
            let manager = SharedAccountManager::new(AccountManager::new(
                None,
                Some(&storage_with_expiring_account(now_ms() + 60_000)),
            ));
            let calls = Arc::new(AtomicUsize::new(0));
            let guardian = guardian_for(
                manager.clone(),
                static_refresh(failed(Some(TokenFailureReason::MissingRefresh), None), calls),
            );

            guardian.tick().await;

            let stats = guardian.get_stats();
            assert_eq!(stats.failed, 1);
            assert_eq!(stats.auth_failed, 1);
            let live = manager.lock().await.get_account_by_index(0).cloned().unwrap();
            assert!(live.meta.cooling_down_until.unwrap_or(0) > now_ms() - 1_000);
            assert_eq!(
                live.meta.cooldown_reason,
                Some(CooldownReason::AuthFailure)
            );
            manager.flush_pending_save().await.ok();
        });
    }

    #[test]
    #[serial(env)]
    fn tick_skips_cooling_down_accounts_but_still_counts_the_run() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            AccountManager::reset_volatile_runtime_state();
            let manager = SharedAccountManager::new(AccountManager::new(
                None,
                Some(&storage_with_expiring_account(now_ms() + 60_000)),
            ));
            manager.lock().await.mark_account_cooling_down(
                0,
                60_000,
                CooldownReason::NetworkError,
            );
            let calls = Arc::new(AtomicUsize::new(0));
            let guardian = guardian_for(
                manager.clone(),
                static_refresh(failed(None, None), calls.clone()),
            );

            guardian.tick().await;

            assert_eq!(calls.load(Ordering::SeqCst), 0);
            let stats = guardian.get_stats();
            assert_eq!(stats.runs, 1);
            manager.flush_pending_save().await.ok();
        });
    }

    // ---- ensureRuntimeRefreshGuardian (runtime-refresh-guardian.test.ts) ----

    struct FakeGuardian {
        started: AtomicUsize,
        stopped: AtomicUsize,
        interval_ms: f64,
        buffer_ms: f64,
    }

    impl FakeGuardian {
        fn new(interval_ms: f64, buffer_ms: f64) -> Arc<Self> {
            Arc::new(Self {
                started: AtomicUsize::new(0),
                stopped: AtomicUsize::new(0),
                interval_ms,
                buffer_ms,
            })
        }
    }

    impl RefreshGuardianLike for FakeGuardian {
        fn start(&self) {
            self.started.fetch_add(1, Ordering::SeqCst);
        }
        fn stop(&self) {
            self.stopped.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn stops_and_clears_the_current_guardian_when_disabled() {
        let current = FakeGuardian::new(60_000.0, 300_000.0);
        let current_for_getter = current.clone();
        let mut create_calls = 0usize;
        let mut cleanup_calls = 0usize;
        let mut create = |interval: f64, buffer: f64| {
            create_calls += 1;
            FakeGuardian::new(interval, buffer)
        };
        let mut register = |_cleanup: Box<dyn FnOnce() + Send>| cleanup_calls += 1;

        let result = ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
            enabled: false,
            interval_ms: 60_000.0,
            buffer_ms: 300_000.0,
            current_guardian: Some(current.clone()),
            current_config_key: Some("60000:300000".to_string()),
            current_cleanup_registered: true,
            get_current_guardian: Arc::new(move || Some(current_for_getter.clone())),
            create_guardian: &mut create,
            register_cleanup: &mut register,
        });

        assert!(result.guardian.is_none());
        assert_eq!(result.config_key, None);
        assert!(result.cleanup_registered);
        assert_eq!(current.stopped.load(Ordering::SeqCst), 1);
        assert_eq!(create_calls, 0);
        assert_eq!(cleanup_calls, 0);
    }

    #[test]
    fn returns_the_existing_guardian_when_the_config_is_unchanged() {
        let current = FakeGuardian::new(60_000.0, 300_000.0);
        let current_for_getter = current.clone();
        let mut create_calls = 0usize;
        let mut cleanup_calls = 0usize;
        let mut create = |interval: f64, buffer: f64| {
            create_calls += 1;
            FakeGuardian::new(interval, buffer)
        };
        let mut register = |_cleanup: Box<dyn FnOnce() + Send>| cleanup_calls += 1;

        let result = ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
            enabled: true,
            interval_ms: 60_000.0,
            buffer_ms: 300_000.0,
            current_guardian: Some(current.clone()),
            current_config_key: Some("60000:300000".to_string()),
            current_cleanup_registered: true,
            get_current_guardian: Arc::new(move || Some(current_for_getter.clone())),
            create_guardian: &mut create,
            register_cleanup: &mut register,
        });

        assert!(Arc::ptr_eq(result.guardian.as_ref().unwrap(), &current));
        assert_eq!(result.config_key.as_deref(), Some("60000:300000"));
        assert!(result.cleanup_registered);
        assert_eq!(create_calls, 0);
        assert_eq!(cleanup_calls, 0);
        assert_eq!(current.stopped.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn creates_starts_and_registers_cleanup_on_first_creation() {
        let mut created: Vec<Arc<FakeGuardian>> = Vec::new();
        let mut cleanup_calls = 0usize;
        let mut create = |interval: f64, buffer: f64| {
            let guardian = FakeGuardian::new(interval, buffer);
            created.push(guardian.clone());
            guardian
        };
        let mut register = |_cleanup: Box<dyn FnOnce() + Send>| cleanup_calls += 1;

        let result = ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
            enabled: true,
            interval_ms: 60_000.0,
            buffer_ms: 300_000.0,
            current_guardian: None::<Arc<FakeGuardian>>,
            current_config_key: None,
            current_cleanup_registered: false,
            get_current_guardian: Arc::new(|| None),
            create_guardian: &mut create,
            register_cleanup: &mut register,
        });

        let guardian = result.guardian.expect("created");
        assert_eq!(guardian.interval_ms, 60_000.0);
        assert_eq!(guardian.buffer_ms, 300_000.0);
        assert_eq!(guardian.started.load(Ordering::SeqCst), 1);
        assert_eq!(result.config_key.as_deref(), Some("60000:300000"));
        assert!(result.cleanup_registered);
        assert_eq!(cleanup_calls, 1);
    }

    #[test]
    fn replaces_the_guardian_without_registering_duplicate_cleanup() {
        let previous = FakeGuardian::new(60_000.0, 300_000.0);
        let mut cleanup_calls = 0usize;
        let mut create = |interval: f64, buffer: f64| FakeGuardian::new(interval, buffer);
        let mut register = |_cleanup: Box<dyn FnOnce() + Send>| cleanup_calls += 1;

        let result = ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
            enabled: true,
            interval_ms: 120_000.0,
            buffer_ms: 600_000.0,
            current_guardian: Some(previous.clone()),
            current_config_key: Some("60000:300000".to_string()),
            current_cleanup_registered: true,
            get_current_guardian: Arc::new(|| None),
            create_guardian: &mut create,
            register_cleanup: &mut register,
        });

        assert_eq!(previous.stopped.load(Ordering::SeqCst), 1);
        let replacement = result.guardian.expect("replacement created");
        assert!(!Arc::ptr_eq(&replacement, &previous));
        assert_eq!(replacement.started.load(Ordering::SeqCst), 1);
        assert_eq!(result.config_key.as_deref(), Some("120000:600000"));
        assert_eq!(cleanup_calls, 0);
    }

    #[test]
    fn does_not_accumulate_cleanup_handlers_across_disable_reenable_cycles() {
        let mut cleanup_calls = 0usize;
        let mut create = |interval: f64, buffer: f64| FakeGuardian::new(interval, buffer);

        let first = {
            let mut register = |_cleanup: Box<dyn FnOnce() + Send>| cleanup_calls += 1;
            ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
                enabled: true,
                interval_ms: 60_000.0,
                buffer_ms: 300_000.0,
                current_guardian: None::<Arc<FakeGuardian>>,
                current_config_key: None,
                current_cleanup_registered: false,
                get_current_guardian: Arc::new(|| None),
                create_guardian: &mut create,
                register_cleanup: &mut register,
            })
        };
        assert_eq!(cleanup_calls, 1);

        let disabled = {
            let mut register = |_cleanup: Box<dyn FnOnce() + Send>| cleanup_calls += 1;
            ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
                enabled: false,
                interval_ms: 60_000.0,
                buffer_ms: 300_000.0,
                current_guardian: first.guardian,
                current_config_key: first.config_key,
                current_cleanup_registered: first.cleanup_registered,
                get_current_guardian: Arc::new(|| None),
                create_guardian: &mut create,
                register_cleanup: &mut register,
            })
        };

        {
            let mut register = |_cleanup: Box<dyn FnOnce() + Send>| cleanup_calls += 1;
            ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
                enabled: true,
                interval_ms: 60_000.0,
                buffer_ms: 300_000.0,
                current_guardian: disabled.guardian,
                current_config_key: disabled.config_key,
                current_cleanup_registered: disabled.cleanup_registered,
                get_current_guardian: Arc::new(|| None),
                create_guardian: &mut create,
                register_cleanup: &mut register,
            })
        };

        assert_eq!(cleanup_calls, 1);
    }
}
