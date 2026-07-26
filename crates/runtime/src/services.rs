//! Port of `lib/runtime/runtime-services.ts` — long-lived service
//! lifecycle helpers (spec 10 §21) — plus the absorbed DI entry shims
//! (`live-sync-entry.ts`, `refresh-guardian-entry.ts`,
//! `session-affinity-entry.ts`, `ui-runtime-entry.ts`;
//! `account-manager-cache-entry.ts` collapsed into
//! [`crate::manager_cache`], `account-storage-scope-entry.ts` into
//! [`crate::storage_scope`]). ARCHITECTURE §6.12 / §4 item 10.
//!
//! These manage singletons owned by the proxy/pipeline entry: compare a
//! config key, stop/recreate on change, register cleanup exactly once.

use crate::refresh_guardian::{
    ensure_runtime_refresh_guardian, js_number_string, EnsureRuntimeRefreshGuardianParams,
    RefreshGuardianLike,
};
use cma_core::schemas::plugin_config::PluginConfig;
use cma_core::types::OAuthAuthDetails;
use std::future::Future;
use std::sync::Arc;

/// TS `LiveAccountSyncLike` / `LiveSyncController` — the watcher lifecycle
/// surface (implemented for `cma_quota::live_account_sync::LiveAccountSync`
/// below).
pub trait LiveAccountSyncLike {
    fn stop(&self);
    fn sync_to_path(&self, path: &str) -> impl Future<Output = std::io::Result<()>> + Send;
}

impl LiveAccountSyncLike for cma_quota::live_account_sync::LiveAccountSync {
    fn stop(&self) {
        cma_quota::live_account_sync::LiveAccountSync::stop(self)
    }
    async fn sync_to_path(&self, path: &str) -> std::io::Result<()> {
        cma_quota::live_account_sync::LiveAccountSync::sync_to_path(self, std::path::Path::new(path))
            .await
    }
}

/// Resulting live-sync state triple (TS return object).
pub struct LiveAccountSyncState<TSync> {
    pub live_account_sync: Option<Arc<TSync>>,
    pub live_account_sync_path: Option<String>,
    pub live_account_sync_config_key: Option<String>,
}

/// TS `ensureLiveAccountSyncState(params)` params.
pub struct EnsureLiveAccountSyncStateParams<'a, TSync: LiveAccountSyncLike> {
    pub enabled: bool,
    pub target_path: String,
    pub current_sync: Option<Arc<TSync>>,
    pub current_path: Option<String>,
    pub current_config_key: Option<String>,
    pub config_key: Option<String>,
    pub auth_fallback: Option<OAuthAuthDetails>,
    pub create_sync: &'a mut dyn FnMut(Option<OAuthAuthDetails>) -> Arc<TSync>,
    pub register_cleanup: &'a mut dyn FnMut(Box<dyn FnOnce() + Send>),
    pub log_warn: &'a mut dyn FnMut(&str),
    pub plugin_name: &'a str,
}

/// TS `ensureLiveAccountSyncState` — disabled ⇒ stop + all-null; config-key
/// change ⇒ stop + recreate; path switch with 3 attempts (25·2^n ms backoff)
/// retrying only EBUSY/EPERM, warning + keeping the previous watcher on
/// exhaustion. Non-transient sync errors propagate (TS rethrow).
pub async fn ensure_live_account_sync_state<TSync>(
    params: EnsureLiveAccountSyncStateParams<'_, TSync>,
) -> std::io::Result<LiveAccountSyncState<TSync>>
where
    TSync: LiveAccountSyncLike + Send + Sync + 'static,
{
    let EnsureLiveAccountSyncStateParams {
        enabled,
        target_path,
        current_sync,
        current_path,
        current_config_key,
        config_key,
        auth_fallback,
        create_sync,
        register_cleanup,
        log_warn,
        plugin_name,
    } = params;

    let mut live_account_sync = current_sync;
    let mut live_account_sync_path = current_path;
    let mut live_account_sync_config_key = current_config_key;

    if !enabled {
        if let Some(sync) = live_account_sync.as_ref() {
            sync.stop();
        }
        return Ok(LiveAccountSyncState {
            live_account_sync: None,
            live_account_sync_path: None,
            live_account_sync_config_key: None,
        });
    }

    let next_config_key = config_key;
    if live_account_sync.is_some()
        && next_config_key.is_some()
        && (live_account_sync_config_key.is_none()
            || live_account_sync_config_key != next_config_key)
    {
        if let Some(sync) = live_account_sync.as_ref() {
            sync.stop();
        }
        live_account_sync = None;
        live_account_sync_path = None;
        live_account_sync_config_key = None;
    }

    if live_account_sync.is_none() {
        let created = create_sync(auth_fallback);
        live_account_sync_config_key = next_config_key;
        let for_cleanup = created.clone();
        register_cleanup(Box::new(move || {
            for_cleanup.stop();
        }));
        live_account_sync = Some(created);
    }

    if live_account_sync_path.as_deref() != Some(target_path.as_str()) {
        let sync = live_account_sync.as_ref().expect("sync exists here");
        let mut switched = false;
        for attempt in 0..3u32 {
            match sync.sync_to_path(&target_path).await {
                Ok(()) => {
                    live_account_sync_path = Some(target_path.clone());
                    switched = true;
                    break;
                }
                Err(error) => {
                    let code = cma_core::fs_retry::code_of(&error);
                    if code != Some("EBUSY") && code != Some("EPERM") {
                        return Err(error);
                    }
                    cma_core::utils::sleep(25 * 2u64.pow(attempt)).await;
                }
            }
        }
        if !switched {
            log_warn(&format!(
                "[{plugin_name}] Live account sync path switch failed due to transient filesystem locks; keeping previous watcher."
            ));
        }
    }

    Ok(LiveAccountSyncState {
        live_account_sync,
        live_account_sync_path,
        live_account_sync_config_key,
    })
}

/// TS `ensureLiveAccountSyncEntry(params)` (absorbed `live-sync-entry.ts`)
/// — derives enabled/target/config-key from the plugin config via
/// `cma-config` getters, then delegates to
/// [`ensure_live_account_sync_state`].
// The parameter list mirrors the TS `ensureLiveAccountSyncEntry(params)`
// object one-to-one; collapsing it into a struct would just rename the shape.
#[allow(clippy::too_many_arguments)]
pub async fn ensure_live_account_sync_entry<TSync>(
    plugin_config: &PluginConfig,
    auth_fallback: Option<OAuthAuthDetails>,
    current_sync: Option<Arc<TSync>>,
    current_path: Option<String>,
    current_config_key: Option<String>,
    create_sync: &mut dyn FnMut(Option<OAuthAuthDetails>) -> Arc<TSync>,
    register_cleanup: &mut dyn FnMut(Box<dyn FnOnce() + Send>),
    log_warn: &mut dyn FnMut(&str),
) -> std::io::Result<LiveAccountSyncState<TSync>>
where
    TSync: LiveAccountSyncLike + Send + Sync + 'static,
{
    let debounce_ms = cma_config::getters::get_live_account_sync_debounce_ms(plugin_config);
    let poll_interval_ms = cma_config::getters::get_live_account_sync_poll_ms(plugin_config);
    ensure_live_account_sync_state(EnsureLiveAccountSyncStateParams {
        enabled: cma_config::getters::get_live_account_sync(plugin_config),
        target_path: cma_storage::facade::get_storage_path(),
        current_sync,
        current_path,
        current_config_key,
        config_key: Some(format!(
            "{}:{}",
            js_number_string(debounce_ms),
            js_number_string(poll_interval_ms)
        )),
        auth_fallback,
        create_sync,
        register_cleanup,
        log_warn,
        plugin_name: cma_core::constants::PLUGIN_NAME,
    })
    .await
}

/// Resulting refresh-guardian state triple (TS return object).
pub struct RefreshGuardianState<TGuardian: RefreshGuardianLike> {
    pub refresh_guardian: Option<Arc<TGuardian>>,
    pub refresh_guardian_config_key: Option<String>,
    pub refresh_guardian_cleanup_registered: bool,
}

/// TS `ensureRefreshGuardianState(params)` params.
pub struct EnsureRefreshGuardianStateParams<'a, TGuardian: RefreshGuardianLike> {
    pub enabled: bool,
    pub interval_ms: f64,
    pub buffer_ms: f64,
    pub current_guardian: Option<Arc<TGuardian>>,
    pub current_config_key: Option<String>,
    pub current_cleanup_registered: bool,
    pub get_current_guardian: Arc<dyn Fn() -> Option<Arc<TGuardian>> + Send + Sync>,
    pub create_guardian: &'a mut dyn FnMut(f64, f64) -> Arc<TGuardian>,
    pub register_cleanup: &'a mut dyn FnMut(Box<dyn FnOnce() + Send>),
}

/// TS `ensureRefreshGuardianState` — adapter over
/// [`ensure_runtime_refresh_guardian`] with a synthetic config (the TS
/// version built `{enabled, intervalMs, bufferMs}` and trivial getters).
pub fn ensure_refresh_guardian_state<TGuardian>(
    params: EnsureRefreshGuardianStateParams<'_, TGuardian>,
) -> RefreshGuardianState<TGuardian>
where
    TGuardian: RefreshGuardianLike + Send + Sync + 'static,
{
    let ensured = ensure_runtime_refresh_guardian(EnsureRuntimeRefreshGuardianParams {
        enabled: params.enabled,
        interval_ms: params.interval_ms,
        buffer_ms: params.buffer_ms,
        current_guardian: params.current_guardian,
        current_config_key: params.current_config_key,
        current_cleanup_registered: params.current_cleanup_registered,
        get_current_guardian: params.get_current_guardian,
        create_guardian: params.create_guardian,
        register_cleanup: params.register_cleanup,
    });
    RefreshGuardianState {
        refresh_guardian: ensured.guardian,
        refresh_guardian_config_key: ensured.config_key,
        refresh_guardian_cleanup_registered: ensured.cleanup_registered,
    }
}

/// TS `ensureRefreshGuardianEntry(params)` (absorbed
/// `refresh-guardian-entry.ts`) — derives the three config values from the
/// plugin config via `cma-config` getters.
pub fn ensure_refresh_guardian_entry<TGuardian>(
    plugin_config: &PluginConfig,
    current_guardian: Option<Arc<TGuardian>>,
    current_config_key: Option<String>,
    current_cleanup_registered: bool,
    get_current_guardian: Arc<dyn Fn() -> Option<Arc<TGuardian>> + Send + Sync>,
    create_guardian: &mut dyn FnMut(f64, f64) -> Arc<TGuardian>,
    register_cleanup: &mut dyn FnMut(Box<dyn FnOnce() + Send>),
) -> RefreshGuardianState<TGuardian>
where
    TGuardian: RefreshGuardianLike + Send + Sync + 'static,
{
    ensure_refresh_guardian_state(EnsureRefreshGuardianStateParams {
        enabled: cma_config::getters::get_proactive_refresh_guardian(plugin_config),
        interval_ms: cma_config::getters::get_proactive_refresh_interval_ms(plugin_config),
        buffer_ms: cma_config::getters::get_proactive_refresh_buffer_ms(plugin_config),
        current_guardian,
        current_config_key,
        current_cleanup_registered,
        get_current_guardian,
        create_guardian,
        register_cleanup,
    })
}

/// Resulting session-affinity state pair (TS return object).
pub struct SessionAffinityState<TStore> {
    pub session_affinity_store: Option<TStore>,
    pub session_affinity_config_key: Option<String>,
}

/// TS `ensureSessionAffinityState(params)` — disabled ⇒ `{null, null}`
/// (deliberately does NOT stop/free the old store — stores are passive);
/// matching `"${ttlMs}:${maxEntries}"` key ⇒ reuse; otherwise create.
pub fn ensure_session_affinity_state<TStore>(
    enabled: bool,
    ttl_ms: f64,
    max_entries: f64,
    current_store: Option<TStore>,
    current_config_key: Option<String>,
    create_store: &mut dyn FnMut(f64, f64) -> TStore,
) -> SessionAffinityState<TStore> {
    if !enabled {
        return SessionAffinityState {
            session_affinity_store: None,
            session_affinity_config_key: None,
        };
    }

    let config_key = format!(
        "{}:{}",
        js_number_string(ttl_ms),
        js_number_string(max_entries)
    );
    if let Some(store) = current_store
        && current_config_key.as_deref() == Some(config_key.as_str())
    {
        return SessionAffinityState {
            session_affinity_store: Some(store),
            session_affinity_config_key: current_config_key,
        };
    }

    SessionAffinityState {
        session_affinity_store: Some(create_store(ttl_ms, max_entries)),
        session_affinity_config_key: Some(config_key),
    }
}

/// TS `ensureSessionAffinityEntry(params)` (absorbed
/// `session-affinity-entry.ts`).
pub fn ensure_session_affinity_entry<TStore>(
    plugin_config: &PluginConfig,
    current_store: Option<TStore>,
    current_config_key: Option<String>,
    create_store: &mut dyn FnMut(f64, f64) -> TStore,
) -> SessionAffinityState<TStore> {
    ensure_session_affinity_state(
        cma_config::getters::get_session_affinity(plugin_config),
        cma_config::getters::get_session_affinity_ttl_ms(plugin_config),
        cma_config::getters::get_session_affinity_max_entries(plugin_config),
        current_store,
        current_config_key,
        create_store,
    )
}

/// TS `resolveUiRuntimeEntry(params)` (absorbed `ui-runtime-entry.ts`) —
/// trivial `resolve(load, apply)` indirection; see
/// [`crate::quota_settings::resolve_ui_runtime_from_config`].
pub fn resolve_ui_runtime_entry<TUi>(
    load_plugin_config: impl FnOnce() -> PluginConfig,
    apply_ui_runtime_from_config: impl FnOnce(&PluginConfig) -> TUi,
) -> TUi {
    crate::quota_settings::resolve_ui_runtime_from_config(
        load_plugin_config,
        apply_ui_runtime_from_config,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    // ---- fake sync ----

    struct FakeSync {
        stopped: AtomicUsize,
        sync_calls: StdMutex<Vec<String>>,
        /// io error codes to fail with, consumed per call (raw OS errors so
        /// `code_of` maps them; 0 = success).
        failures: StdMutex<Vec<Option<std::io::ErrorKind>>>,
    }

    impl FakeSync {
        fn new() -> Arc<Self> {
            Self::failing(Vec::new())
        }

        fn failing(failures: Vec<Option<std::io::ErrorKind>>) -> Arc<Self> {
            Arc::new(Self {
                stopped: AtomicUsize::new(0),
                sync_calls: StdMutex::new(Vec::new()),
                failures: StdMutex::new(failures),
            })
        }
    }

    impl LiveAccountSyncLike for FakeSync {
        fn stop(&self) {
            self.stopped.fetch_add(1, Ordering::SeqCst);
        }
        async fn sync_to_path(&self, path: &str) -> std::io::Result<()> {
            self.sync_calls.lock().unwrap().push(path.to_string());
            let next = self.failures.lock().unwrap().pop();
            match next.flatten() {
                Some(kind) => Err(std::io::Error::new(kind, "boom")),
                None => Ok(()),
            }
        }
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn disabled_live_sync_stops_and_nulls_everything() {
        test_runtime().block_on(async {
            let current = FakeSync::new();
            let mut create = |_auth: Option<OAuthAuthDetails>| FakeSync::new();
            let mut register = |_c: Box<dyn FnOnce() + Send>| {};
            let mut warn = |_m: &str| {};

            let state = ensure_live_account_sync_state(EnsureLiveAccountSyncStateParams {
                enabled: false,
                target_path: "/tmp/accounts.json".to_string(),
                current_sync: Some(current.clone()),
                current_path: Some("/old".to_string()),
                current_config_key: Some("250:2000".to_string()),
                config_key: Some("250:2000".to_string()),
                auth_fallback: None,
                create_sync: &mut create,
                register_cleanup: &mut register,
                log_warn: &mut warn,
                plugin_name: "codex-multi-auth",
            })
            .await
            .unwrap();

            assert!(state.live_account_sync.is_none());
            assert!(state.live_account_sync_path.is_none());
            assert!(state.live_account_sync_config_key.is_none());
            assert_eq!(current.stopped.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn config_key_change_recreates_the_sync_and_registers_cleanup_per_creation() {
        test_runtime().block_on(async {
            let current = FakeSync::new();
            let created = FakeSync::new();
            let created_for_closure = created.clone();
            let mut create = move |_auth: Option<OAuthAuthDetails>| created_for_closure.clone();
            let mut cleanups: Vec<Box<dyn FnOnce() + Send>> = Vec::new();
            let mut register = |cleanup: Box<dyn FnOnce() + Send>| cleanups.push(cleanup);
            let mut warn = |_m: &str| {};

            let state = ensure_live_account_sync_state(EnsureLiveAccountSyncStateParams {
                enabled: true,
                target_path: "/tmp/accounts.json".to_string(),
                current_sync: Some(current.clone()),
                current_path: Some("/tmp/accounts.json".to_string()),
                current_config_key: Some("250:2000".to_string()),
                config_key: Some("500:1000".to_string()),
                auth_fallback: None,
                create_sync: &mut create,
                register_cleanup: &mut register,
                log_warn: &mut warn,
                plugin_name: "codex-multi-auth",
            })
            .await
            .unwrap();

            assert_eq!(current.stopped.load(Ordering::SeqCst), 1);
            assert!(Arc::ptr_eq(state.live_account_sync.as_ref().unwrap(), &created));
            assert_eq!(
                state.live_account_sync_config_key.as_deref(),
                Some("500:1000")
            );
            // The recreated sync had no path yet: it was switched.
            assert_eq!(
                state.live_account_sync_path.as_deref(),
                Some("/tmp/accounts.json")
            );
            assert_eq!(cleanups.len(), 1);
            // The registered cleanup stops the created sync.
            cleanups.pop().unwrap()();
            assert_eq!(created.stopped.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn path_switch_retries_transient_locks_and_keeps_the_previous_watcher() {
        test_runtime().block_on(async {
            // Three EBUSY failures (ResourceBusy maps to "EBUSY" in
            // fs_retry::code_of) — the retryable set is EBUSY/EPERM only.
            let sync = FakeSync::failing(vec![
                Some(std::io::ErrorKind::ResourceBusy),
                Some(std::io::ErrorKind::ResourceBusy),
                Some(std::io::ErrorKind::ResourceBusy),
            ]);
            let mut create = |_auth: Option<OAuthAuthDetails>| panic!("no create expected");
            let mut register = |_c: Box<dyn FnOnce() + Send>| {};
            let mut warnings: Vec<String> = Vec::new();
            let mut warn = |m: &str| warnings.push(m.to_string());

            let state = ensure_live_account_sync_state(EnsureLiveAccountSyncStateParams {
                enabled: true,
                target_path: "/tmp/next.json".to_string(),
                current_sync: Some(sync.clone()),
                current_path: Some("/tmp/prev.json".to_string()),
                current_config_key: Some("250:2000".to_string()),
                config_key: Some("250:2000".to_string()),
                auth_fallback: None,
                create_sync: &mut create,
                register_cleanup: &mut register,
                log_warn: &mut warn,
                plugin_name: "codex-multi-auth",
            })
            .await
            .unwrap();

            assert_eq!(sync.sync_calls.lock().unwrap().len(), 3);
            // Path stays on the previous watcher.
            assert_eq!(state.live_account_sync_path.as_deref(), Some("/tmp/prev.json"));
            assert_eq!(warnings.len(), 1);
            assert_eq!(
                warnings[0],
                "[codex-multi-auth] Live account sync path switch failed due to transient filesystem locks; keeping previous watcher."
            );
        });
    }

    #[test]
    fn non_transient_path_switch_errors_propagate() {
        test_runtime().block_on(async {
            let sync = FakeSync::failing(vec![Some(std::io::ErrorKind::NotFound)]);
            let mut create = |_auth: Option<OAuthAuthDetails>| panic!("no create expected");
            let mut register = |_c: Box<dyn FnOnce() + Send>| {};
            let mut warn = |_m: &str| {};

            let result = ensure_live_account_sync_state(EnsureLiveAccountSyncStateParams {
                enabled: true,
                target_path: "/tmp/next.json".to_string(),
                current_sync: Some(sync),
                current_path: Some("/tmp/prev.json".to_string()),
                current_config_key: Some("250:2000".to_string()),
                config_key: Some("250:2000".to_string()),
                auth_fallback: None,
                create_sync: &mut create,
                register_cleanup: &mut register,
                log_warn: &mut warn,
                plugin_name: "codex-multi-auth",
            })
            .await;

            assert!(result.is_err());
        });
    }

    // ---- session affinity ----

    #[test]
    fn session_affinity_state_lifecycle() {
        #[derive(Clone, PartialEq, Debug)]
        struct FakeStore(u32);
        let mut created = 0u32;
        let mut create = |_ttl: f64, _max: f64| {
            created += 1;
            FakeStore(created)
        };

        // Disabled: all null (old store not freed — passive).
        let state = ensure_session_affinity_state(
            false,
            1_000.0,
            512.0,
            Some(FakeStore(9)),
            Some("1000:512".to_string()),
            &mut create,
        );
        assert!(state.session_affinity_store.is_none());
        assert!(state.session_affinity_config_key.is_none());

        // Enabled, no current: creates.
        let state =
            ensure_session_affinity_state(true, 1_000.0, 512.0, None, None, &mut create);
        assert_eq!(state.session_affinity_store, Some(FakeStore(1)));
        assert_eq!(state.session_affinity_config_key.as_deref(), Some("1000:512"));

        // Matching key: reuse.
        let state = ensure_session_affinity_state(
            true,
            1_000.0,
            512.0,
            state.session_affinity_store,
            state.session_affinity_config_key,
            &mut create,
        );
        assert_eq!(state.session_affinity_store, Some(FakeStore(1)));

        // Key change: recreate.
        let state = ensure_session_affinity_state(
            true,
            2_000.0,
            512.0,
            state.session_affinity_store,
            state.session_affinity_config_key,
            &mut create,
        );
        assert_eq!(state.session_affinity_store, Some(FakeStore(2)));
        assert_eq!(state.session_affinity_config_key.as_deref(), Some("2000:512"));
    }
}
