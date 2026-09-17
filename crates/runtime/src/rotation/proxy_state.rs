//! Port of `lib/runtime/rotation-proxy-state.ts` — the per-instance state
//! container of the runtime rotation proxy plus the full-pool-exhaustion
//! recovery (issue #606). Spec 10 §6, spec 04 (proxy state recovery),
//! ARCHITECTURE §6.12.

use crate::observability::{record_runtime_reload, record_runtime_reset};
use crate::rotation::server_types::{NowFn, RuntimeRotationProxyStatus, SchedulingStrategy};
use cma_accounts::manager::AccountManager;
use cma_accounts::manager_persistence::SharedAccountManager;
use cma_accounts::session_affinity::SessionAffinityStore;
use cma_core::utils::now_ms;
use cma_rotation::routing_mutex::RoutingMutexMode;
use std::sync::{Arc, Mutex as StdMutex};

/// TS `STALE_RUNTIME_RELOAD_DEDUPE_MS` — recovery re-probing is bounded to
/// ~1/second.
pub const STALE_RUNTIME_RELOAD_DEDUPE_MS: i64 = 1_000;

/// TS `RotationProxyStateInit` — per-instance configuration resolved once in
/// `startRuntimeRotationProxy`, captured as explicit fields instead of
/// closure variables so the request handler and the stale-reload recovery
/// can be plain functions.
///
/// All millisecond values are epoch/duration ms as TS numbers.
/// `forced_account_index` is the ephemeral per-invocation pin (issue #623 —
/// NEVER persisted; see `rotation-server-types`).
#[derive(Clone)]
pub struct RotationProxyStateInit {
    pub active_account_manager: SharedAccountManager,
    pub routing_mutex_mode: RoutingMutexMode,
    pub scheduling_strategy: SchedulingStrategy,
    /// Replaces the TS `fetchImpl` seam (injected undici fetch) — the
    /// pipeline's outbound HTTP client.
    pub fetch_client: reqwest::Client,
    pub upstream_base_url: String,
    pub client_api_key: String,
    pub now: NowFn,
    pub token_refresh_skew_ms: i64,
    pub network_error_cooldown_ms: i64,
    pub server_error_cooldown_ms: i64,
    pub token_invalidation_cooldown_ms: i64,
    pub min_rotation_interval_ms: i64,
    pub pid_offset_enabled: bool,
    pub fetch_timeout_ms: i64,
    pub stream_stall_timeout_ms: i64,
    pub max_runtime_account_attempts: i64,
    pub max_request_body_bytes: usize,
    pub quota_remaining_percent_threshold: f64,
    /// Shared mutable store (the TS object was mutated in place by the
    /// single-threaded event loop; Rust callers lock it around each use).
    pub session_affinity_store: Option<Arc<StdMutex<SessionAffinityStore>>>,
    pub last_observed_affinity_generation: i64,
    /// Ephemeral per-invocation account pin (0-based) or `None` — issue
    /// #623. Never written to disk.
    pub forced_account_index: Option<i64>,
}

/// TS `RotationProxyState` — mutable rotation-loop state shared by every
/// request of one proxy instance. `active_account_manager` and
/// `last_observed_affinity_generation` are reassigned at runtime
/// (stale-state recovery and affinity-generation tracking), so the whole
/// container is passed by reference and never copied.
pub struct RotationProxyState {
    // ---- init fields (TS `extends RotationProxyStateInit`) ----
    pub active_account_manager: SharedAccountManager,
    pub routing_mutex_mode: RoutingMutexMode,
    pub scheduling_strategy: SchedulingStrategy,
    pub fetch_client: reqwest::Client,
    pub upstream_base_url: String,
    pub client_api_key: String,
    pub now: NowFn,
    pub token_refresh_skew_ms: i64,
    pub network_error_cooldown_ms: i64,
    pub server_error_cooldown_ms: i64,
    pub token_invalidation_cooldown_ms: i64,
    pub min_rotation_interval_ms: i64,
    pub pid_offset_enabled: bool,
    pub fetch_timeout_ms: i64,
    pub stream_stall_timeout_ms: i64,
    pub max_runtime_account_attempts: i64,
    pub max_request_body_bytes: usize,
    pub quota_remaining_percent_threshold: f64,
    pub session_affinity_store: Option<Arc<StdMutex<SessionAffinityStore>>>,
    pub last_observed_affinity_generation: i64,
    pub forced_account_index: Option<i64>,
    // ---- runtime fields ----
    /// TS `Set<AccountManager>` — identity set of every manager this
    /// instance has ever served (previous managers stay known so in-flight
    /// requests can finish against them). Identity = the shared handle's
    /// inner `Arc` pointer.
    pub known_account_managers: Vec<SharedAccountManager>,
    pub status: RuntimeRotationProxyStatus,
    pub thread_goal_fallbacks: std::collections::HashMap<String, Option<String>>,
    pub last_global_account_index: Option<i64>,
    pub last_global_switch_at: i64,
    pub last_stale_runtime_reload_at: i64,
}

fn same_manager(a: &SharedAccountManager, b: &SharedAccountManager) -> bool {
    Arc::ptr_eq(a.manager(), b.manager())
}

impl RotationProxyState {
    /// TS `state.knownAccountManagers.add(manager)` (Set semantics).
    pub fn add_known_account_manager(&mut self, manager: SharedAccountManager) {
        if !self
            .known_account_managers
            .iter()
            .any(|known| same_manager(known, &manager))
        {
            self.known_account_managers.push(manager);
        }
    }

    /// TS `state.knownAccountManagers.has(manager)`.
    pub fn knows_account_manager(&self, manager: &SharedAccountManager) -> bool {
        self.known_account_managers
            .iter()
            .any(|known| same_manager(known, manager))
    }
}

/// TS `createRotationProxyState(init)`.
pub fn create_rotation_proxy_state(init: RotationProxyStateInit) -> RotationProxyState {
    let started_at = (init.now)();
    RotationProxyState {
        known_account_managers: vec![init.active_account_manager.clone()],
        status: RuntimeRotationProxyStatus {
            started_at,
            total_requests: 0,
            upstream_requests: 0,
            retries: 0,
            rotations: 0,
            streams_started: 0,
            last_error: None,
            last_account_index: None,
            last_account_label: None,
            last_account_id: None,
            last_account_updated_at: None,
        },
        thread_goal_fallbacks: std::collections::HashMap::new(),
        last_global_account_index: None,
        last_global_switch_at: 0,
        last_stale_runtime_reload_at: 0,
        active_account_manager: init.active_account_manager,
        routing_mutex_mode: init.routing_mutex_mode,
        scheduling_strategy: init.scheduling_strategy,
        fetch_client: init.fetch_client,
        upstream_base_url: init.upstream_base_url,
        client_api_key: init.client_api_key,
        now: init.now,
        token_refresh_skew_ms: init.token_refresh_skew_ms,
        network_error_cooldown_ms: init.network_error_cooldown_ms,
        server_error_cooldown_ms: init.server_error_cooldown_ms,
        token_invalidation_cooldown_ms: init.token_invalidation_cooldown_ms,
        min_rotation_interval_ms: init.min_rotation_interval_ms,
        pid_offset_enabled: init.pid_offset_enabled,
        fetch_timeout_ms: init.fetch_timeout_ms,
        stream_stall_timeout_ms: init.stream_stall_timeout_ms,
        max_runtime_account_attempts: init.max_runtime_account_attempts,
        max_request_body_bytes: init.max_request_body_bytes,
        quota_remaining_percent_threshold: init.quota_remaining_percent_threshold,
        session_affinity_store: init.session_affinity_store,
        last_observed_affinity_generation: init.last_observed_affinity_generation,
        forced_account_index: init.forced_account_index,
    }
}

/// TS `recoverStaleRuntimeState(state)` — full-pool-exhaustion recovery
/// (issue #606).
///
/// 1. If a recovery completed within the last second (REAL wall clock, not
///    the injected `now()`) → return the current manager (dedupe re-probing
///    to ~1/sec).
/// 2. Otherwise: reset the global volatile singletons (trackers, circuit
///    breakers), record the observability reset, reload the pool from disk,
///    restore the configured routing-mutex mode, then clear the per-account
///    transient state **after** the reload — cooldowns and rate-limit
///    windows are serialized to disk, so a reload alone restores the same
///    wedged state. This also drops still-future rate-limit windows from
///    genuine upstream 429s; that is the intended trade-off (availability
///    over honoring backoff in an already-degraded state, bounded by the 1s
///    dedupe). Then `flush_pending_save()` forces the cleared snapshot to
///    disk immediately (a debounced save could lose the clean state on
///    process exit), and only after all of that is the reloaded manager
///    published as `state.active_account_manager` — no concurrent request
///    can observe it with stale state.
///
/// Errors set `status.last_error` and resolve `None`; a failure does NOT
/// arm the dedupe window, so the next call retries.
///
/// Concurrency note (deviation from TS): the TS version shared one
/// in-flight promise among concurrent callers. In Rust the caller holds the
/// proxy-state lock (`&mut state`), so concurrent callers serialize on that
/// lock instead and the second caller lands in the 1-second dedupe
/// fast-path — the observable outcome (single reload, both callers get the
/// reloaded manager) is identical.
pub async fn recover_stale_runtime_state(
    state: &mut RotationProxyState,
) -> Option<SharedAccountManager> {
    if now_ms() - state.last_stale_runtime_reload_at <= STALE_RUNTIME_RELOAD_DEDUPE_MS {
        return Some(state.active_account_manager.clone());
    }

    AccountManager::reset_volatile_runtime_state();
    record_runtime_reset("pool-exhausted-no-account");
    let reloaded = SharedAccountManager::new(AccountManager::load_from_disk(None).await);
    {
        let mut manager = reloaded.lock().await;
        manager.set_routing_mutex_mode(state.routing_mutex_mode);
    }
    // Wipe per-account cooldowns and rate-limit windows on the freshly
    // reloaded pool BEFORE publishing it (issue #606; see fn docs).
    reloaded.clear_account_transient_state().await;
    // Force the cleared snapshot to disk now rather than waiting out the
    // debounce window; makes the "next reload starts clean" guarantee
    // durable across a restart.
    if let Err(error) = reloaded.flush_pending_save().await {
        state.status.last_error = Some(error.to_string());
        return None;
    }
    state.active_account_manager = reloaded.clone();
    state.add_known_account_manager(reloaded.clone());
    state.last_stale_runtime_reload_at = now_ms();
    record_runtime_reload("pool-exhausted-no-account");
    Some(reloaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::json_io;
    use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn account_meta(index: usize, now: i64) -> AccountMetadataV3 {
        let mut meta =
            AccountMetadataV3::new(format!("refresh-{}", index + 1), now - 60_000, now - 60_000);
        meta.email = Some(format!("account-{}@example.com", index + 1));
        meta.account_id = Some(format!("acc_{}", index + 1));
        meta.access_token = Some(format!("access-{}", index + 1));
        meta.expires_at = Some(now + 3_600_000);
        meta
    }

    fn storage_with(count: usize) -> AccountStorageV3 {
        let now = now_ms();
        let mut storage = AccountStorageV3::empty();
        storage.accounts = (0..count).map(|index| account_meta(index, now)).collect();
        storage
    }

    fn write_storage_to_disk(storage: &AccountStorageV3) {
        let path = cma_storage::facade::get_storage_path();
        let value = serde_json::to_value(storage).expect("serialize storage");
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{}\n", json_io::stringify_pretty2(&value))).unwrap();
    }

    fn state_init(manager: SharedAccountManager) -> RotationProxyStateInit {
        let now = now_ms();
        RotationProxyStateInit {
            active_account_manager: manager,
            routing_mutex_mode: RoutingMutexMode::Enabled,
            scheduling_strategy: SchedulingStrategy::Hybrid,
            fetch_client: reqwest::Client::new(),
            upstream_base_url: "https://upstream.example".to_string(),
            client_api_key: "key".to_string(),
            now: Arc::new(move || now),
            token_refresh_skew_ms: 30_000,
            network_error_cooldown_ms: 10_000,
            server_error_cooldown_ms: 10_000,
            token_invalidation_cooldown_ms: 300_000,
            min_rotation_interval_ms: 0,
            pid_offset_enabled: false,
            fetch_timeout_ms: 30_000,
            stream_stall_timeout_ms: 30_000,
            max_runtime_account_attempts: 3,
            max_request_body_bytes: 1024,
            quota_remaining_percent_threshold: 0.0,
            session_affinity_store: None,
            last_observed_affinity_generation: 0,
            forced_account_index: None,
        }
    }

    #[test]
    #[serial(env)]
    fn create_seeds_known_managers_and_zeroed_status() {
        let _sandbox = EnvSandbox::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let manager =
                SharedAccountManager::new(AccountManager::new(None, Some(&storage_with(1))));
            let init = state_init(manager.clone());
            let started_at = (init.now)();

            let state = create_rotation_proxy_state(init);

            assert_eq!(state.known_account_managers.len(), 1);
            assert!(state.knows_account_manager(&manager));
            assert_eq!(
                state.status,
                RuntimeRotationProxyStatus {
                    started_at,
                    total_requests: 0,
                    upstream_requests: 0,
                    retries: 0,
                    rotations: 0,
                    streams_started: 0,
                    last_error: None,
                    last_account_index: None,
                    last_account_label: None,
                    last_account_id: None,
                    last_account_updated_at: None,
                }
            );
            assert_eq!(state.last_global_account_index, None);
            assert_eq!(state.last_stale_runtime_reload_at, 0);
        });
    }

    #[test]
    #[serial(env)]
    fn recover_reloads_from_disk_swaps_manager_and_clears_transient_state() {
        let _sandbox = EnvSandbox::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            // On-disk pool: 2 accounts, both wedged with future rate-limit
            // windows and cooldowns (the #606 scenario — a reload alone
            // would restore this state).
            let mut wedged = storage_with(2);
            let far_future = now_ms() + 3_600_000;
            for account in wedged.accounts.iter_mut() {
                let mut windows = cma_core::schemas::account_storage::RateLimitStateV3::default();
                windows.insert("codex".to_string(), far_future);
                account.rate_limit_reset_times = Some(windows);
                account.cooling_down_until = Some(far_future);
                account.cooldown_reason =
                    Some(cma_core::schemas::account_storage::CooldownReason::AuthFailure);
            }
            write_storage_to_disk(&wedged);

            let previous =
                SharedAccountManager::new(AccountManager::new(None, Some(&storage_with(1))));
            let mut state = create_rotation_proxy_state(state_init(previous.clone()));

            let result = recover_stale_runtime_state(&mut state).await;
            let reloaded = result.expect("recovery returns the reloaded manager");

            // The active manager was swapped and both managers stay known.
            assert!(same_manager(&state.active_account_manager, &reloaded));
            assert!(!same_manager(&reloaded, &previous));
            assert!(state.knows_account_manager(&previous));
            assert!(state.knows_account_manager(&reloaded));
            assert!(state.last_stale_runtime_reload_at > 0);

            {
                let mut manager = reloaded.lock().await;
                assert_eq!(manager.get_account_count(), 2);
                // The configured mutex mode carries over to the reloaded pool.
                assert_eq!(manager.get_routing_mutex_mode(), RoutingMutexMode::Enabled);
                // Transient state was cleared AFTER the reload: no wedged
                // windows or cooldowns survive.
                for index in 0..2 {
                    let account = manager.get_account_by_index(index).unwrap().clone();
                    assert!(account.rate_limit_reset_times.is_empty());
                    assert_eq!(account.meta.cooling_down_until, None);
                    let reason = manager.get_account_runtime_skip_reason(
                        index,
                        cma_core::model_family::ModelFamily::Codex,
                        None,
                    );
                    assert_eq!(reason, None);
                }
            }

            // The cleared snapshot was flushed to disk synchronously: the
            // next startup must not reload the wedged state.
            let on_disk = std::fs::read_to_string(cma_storage::facade::get_storage_path()).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
            for account in parsed["accounts"].as_array().unwrap() {
                assert!(account.get("coolingDownUntil").is_none());
                let windows = account.get("rateLimitResetTimes");
                assert!(
                    windows.is_none()
                        || windows.unwrap().as_object().map(|m| m.is_empty()) == Some(true)
                );
            }
        });
    }

    #[test]
    #[serial(env)]
    fn recover_dedupes_within_the_one_second_window() {
        let _sandbox = EnvSandbox::new();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            write_storage_to_disk(&storage_with(2));
            let previous =
                SharedAccountManager::new(AccountManager::new(None, Some(&storage_with(1))));
            let mut state = create_rotation_proxy_state(state_init(previous));

            let first = recover_stale_runtime_state(&mut state)
                .await
                .expect("first recovery succeeds");
            assert_eq!(first.lock().await.get_account_count(), 2);

            // Mutate the disk; the second call inside the dedupe window must
            // NOT re-read it.
            write_storage_to_disk(&storage_with(3));
            let second = recover_stale_runtime_state(&mut state)
                .await
                .expect("deduped recovery returns the current manager");
            assert!(same_manager(&first, &second));
            assert_eq!(second.lock().await.get_account_count(), 2);
        });
    }
}
