//! Port of `lib/runtime/live-sync.ts` — the fuller live-account-sync
//! lifecycle variant with commit-callback state publication (spec 10 §21,
//! ARCHITECTURE §6.12: "live-sync entry over cma-quota watcher"; the thin
//! `live-sync-entry.ts` adapter is absorbed into
//! [`crate::services::ensure_live_account_sync_entry`]).

use crate::refresh_guardian::js_number_string;
use crate::services::LiveAccountSyncLike;
use cma_core::types::OAuthAuthDetails;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// The `createSync(onChange, options)` change callback: invoked by the
/// watcher on relevant changes; the production wiring reloads the account
/// manager from disk.
pub type LiveSyncOnChange =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// `createSync` options pair.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LiveSyncCreateOptions {
    pub debounce_ms: f64,
    pub poll_interval_ms: f64,
}

/// The published lifecycle state (TS `commitState` payload / return value).
pub struct RuntimeLiveSyncState<TSync> {
    pub sync: Option<Arc<TSync>>,
    pub path: Option<String>,
    pub config_key: Option<String>,
    pub cleanup_registered: bool,
}

impl<TSync> Clone for RuntimeLiveSyncState<TSync> {
    fn clone(&self) -> Self {
        Self {
            sync: self.sync.clone(),
            path: self.path.clone(),
            config_key: self.config_key.clone(),
            cleanup_registered: self.cleanup_registered,
        }
    }
}

/// Shared shape of the injected manager-reload hook (production:
/// `manager_cache::reload_account_manager_from_disk`).
pub type ReloadAccountManagerFn =
    Arc<dyn Fn(Option<OAuthAuthDetails>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// TS `ensureRuntimeLiveAccountSync(deps)` deps.
pub struct EnsureRuntimeLiveAccountSyncDeps<'a, TSync: LiveAccountSyncLike> {
    /// `${debounceMs}:${pollIntervalMs}` inputs (TS read them from the
    /// plugin config through injected getters).
    pub enabled: bool,
    pub debounce_ms: f64,
    pub poll_interval_ms: f64,
    pub target_path: String,
    pub auth_fallback: Option<OAuthAuthDetails>,
    pub current_sync: Option<Arc<TSync>>,
    pub current_path: Option<String>,
    pub current_config_key: Option<String>,
    pub current_cleanup_registered: bool,
    /// Cleanup resolves the CURRENT sync at shutdown time (TS
    /// `getCurrentSync()?.stop()` — it always stops the latest).
    pub get_current_sync: Arc<dyn Fn() -> Option<Arc<TSync>> + Send + Sync>,
    pub create_sync: &'a mut dyn FnMut(LiveSyncOnChange, LiveSyncCreateOptions) -> Arc<TSync>,
    /// Production: `manager_cache::reload_account_manager_from_disk`.
    pub reload_account_manager_from_disk: ReloadAccountManagerFn,
    pub commit_state: &'a mut dyn FnMut(RuntimeLiveSyncState<TSync>),
    pub register_cleanup: &'a mut dyn FnMut(Box<dyn FnOnce() + Send>),
    pub log_warn: &'a mut dyn FnMut(&str),
    pub plugin_name: &'a str,
}

/// TS `ensureRuntimeLiveAccountSync(deps)` — configKey =
/// `"${debounceMs}:${pollIntervalMs}"`. Disabled ⇒ stop + commit nulls
/// (cleanup registration preserved). Key change ⇒ stop/null out. Creation
/// wires `onChange` to the manager reload and commits state after create
/// AND again after registering cleanup. Path switch retries 3× (25·2^n ms)
/// on EBUSY/EPERM only, warns + keeps the previous watcher on exhaustion;
/// other errors propagate.
pub async fn ensure_runtime_live_account_sync<TSync>(
    deps: EnsureRuntimeLiveAccountSyncDeps<'_, TSync>,
) -> std::io::Result<RuntimeLiveSyncState<TSync>>
where
    TSync: LiveAccountSyncLike + Send + Sync + 'static,
{
    let EnsureRuntimeLiveAccountSyncDeps {
        enabled,
        debounce_ms,
        poll_interval_ms,
        target_path,
        auth_fallback,
        current_sync,
        current_path,
        current_config_key,
        current_cleanup_registered,
        get_current_sync,
        create_sync,
        reload_account_manager_from_disk,
        commit_state,
        register_cleanup,
        log_warn,
        plugin_name,
    } = deps;

    let next_config_key = format!(
        "{}:{}",
        js_number_string(debounce_ms),
        js_number_string(poll_interval_ms)
    );

    if !enabled {
        if let Some(sync) = current_sync.as_ref() {
            sync.stop();
        }
        let state = RuntimeLiveSyncState {
            sync: None,
            path: None,
            config_key: None,
            cleanup_registered: current_cleanup_registered,
        };
        commit_state(state.clone());
        return Ok(state);
    }

    let mut sync = current_sync;
    let mut cleanup_registered = current_cleanup_registered;
    let mut next_path = current_path;
    let mut config_key = current_config_key;

    if sync.is_some() && config_key.is_some() && config_key.as_deref() != Some(&next_config_key) {
        if let Some(current) = sync.as_ref() {
            current.stop();
        }
        sync = None;
        next_path = None;
        config_key = None;
    }

    if sync.is_none() {
        let reload = reload_account_manager_from_disk.clone();
        let auth = auth_fallback.clone();
        let on_change: LiveSyncOnChange = Arc::new(move || {
            let reload = reload.clone();
            let auth = auth.clone();
            Box::pin(async move {
                reload(auth).await;
            })
        });
        let created = create_sync(
            on_change,
            LiveSyncCreateOptions {
                debounce_ms,
                poll_interval_ms,
            },
        );
        sync = Some(created);
        config_key = Some(next_config_key.clone());
        commit_state(RuntimeLiveSyncState {
            sync: sync.clone(),
            path: next_path.clone(),
            config_key: config_key.clone(),
            cleanup_registered,
        });
        if !cleanup_registered {
            let get_current = get_current_sync.clone();
            register_cleanup(Box::new(move || {
                if let Some(current) = get_current() {
                    current.stop();
                }
            }));
            cleanup_registered = true;
            commit_state(RuntimeLiveSyncState {
                sync: sync.clone(),
                path: next_path.clone(),
                config_key: config_key.clone(),
                cleanup_registered,
            });
        }
    }

    if next_path.as_deref() != Some(target_path.as_str()) {
        let current = sync.as_ref().expect("sync exists here");
        let mut switched = false;
        for attempt in 0..3u32 {
            match current.sync_to_path(&target_path).await {
                Ok(()) => {
                    next_path = Some(target_path.clone());
                    commit_state(RuntimeLiveSyncState {
                        sync: sync.clone(),
                        path: next_path.clone(),
                        config_key: config_key.clone(),
                        cleanup_registered,
                    });
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

    Ok(RuntimeLiveSyncState {
        sync,
        path: next_path,
        config_key,
        cleanup_registered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    struct FakeSync {
        stopped: AtomicUsize,
        sync_calls: StdMutex<Vec<String>>,
    }

    impl FakeSync {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                stopped: AtomicUsize::new(0),
                sync_calls: StdMutex::new(Vec::new()),
            })
        }
    }

    impl LiveAccountSyncLike for FakeSync {
        fn stop(&self) {
            self.stopped.fetch_add(1, Ordering::SeqCst);
        }
        async fn sync_to_path(&self, path: &str) -> std::io::Result<()> {
            self.sync_calls.lock().unwrap().push(path.to_string());
            Ok(())
        }
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn creates_wires_on_change_to_the_reload_and_commits_state_twice() {
        test_runtime().block_on(async {
            let created = FakeSync::new();
            let created_for_closure = created.clone();
            let captured_on_change: Arc<StdMutex<Option<LiveSyncOnChange>>> =
                Arc::new(StdMutex::new(None));
            let captured_for_closure = captured_on_change.clone();
            let mut create = move |on_change: LiveSyncOnChange, options: LiveSyncCreateOptions| {
                assert_eq!(options.debounce_ms, 250.0);
                assert_eq!(options.poll_interval_ms, 2_000.0);
                *captured_for_closure.lock().unwrap() = Some(on_change);
                created_for_closure.clone()
            };
            let reload_calls = Arc::new(AtomicUsize::new(0));
            let reload_calls_inner = reload_calls.clone();
            let reload: ReloadAccountManagerFn = Arc::new(move |_auth| {
                let reload_calls = reload_calls_inner.clone();
                Box::pin(async move {
                    reload_calls.fetch_add(1, Ordering::SeqCst);
                })
            });
            // (has_sync, config_key, cleanup_registered) per committed state.
            type CommitLog = Vec<(bool, Option<String>, bool)>;
            let commits: Arc<StdMutex<CommitLog>> = Arc::new(StdMutex::new(Vec::new()));
            let commits_inner = commits.clone();
            let mut commit = move |state: RuntimeLiveSyncState<FakeSync>| {
                commits_inner.lock().unwrap().push((
                    state.sync.is_some(),
                    state.config_key.clone(),
                    state.cleanup_registered,
                ));
            };
            let mut cleanups = 0usize;
            let mut register = |_c: Box<dyn FnOnce() + Send>| cleanups += 1;
            let mut warn = |_m: &str| {};

            let state = ensure_runtime_live_account_sync(EnsureRuntimeLiveAccountSyncDeps {
                enabled: true,
                debounce_ms: 250.0,
                poll_interval_ms: 2_000.0,
                target_path: "/tmp/accounts.json".to_string(),
                auth_fallback: None,
                current_sync: None,
                current_path: None,
                current_config_key: None,
                current_cleanup_registered: false,
                get_current_sync: Arc::new(|| None),
                create_sync: &mut create,
                reload_account_manager_from_disk: reload,
                commit_state: &mut commit,
                register_cleanup: &mut register,
                log_warn: &mut warn,
                plugin_name: "codex-multi-auth",
            })
            .await
            .unwrap();

            assert!(Arc::ptr_eq(state.sync.as_ref().unwrap(), &created));
            assert_eq!(state.config_key.as_deref(), Some("250:2000"));
            assert_eq!(state.path.as_deref(), Some("/tmp/accounts.json"));
            assert!(state.cleanup_registered);
            assert_eq!(cleanups, 1);
            // commit after create, after cleanup registration, after path
            // switch.
            let committed = commits.lock().unwrap().clone();
            assert_eq!(committed.len(), 3);
            assert_eq!(committed[0], (true, Some("250:2000".to_string()), false));
            assert_eq!(committed[1], (true, Some("250:2000".to_string()), true));
            assert_eq!(committed[2], (true, Some("250:2000".to_string()), true));

            // The captured onChange drives the manager reload.
            let on_change = captured_on_change.lock().unwrap().clone().unwrap();
            on_change().await;
            assert_eq!(reload_calls.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn disabled_stops_and_commits_nulls_preserving_cleanup_flag() {
        test_runtime().block_on(async {
            let current = FakeSync::new();
            let mut create = |_on_change: LiveSyncOnChange, _o: LiveSyncCreateOptions| {
                panic!("no create expected")
            };
            let reload: ReloadAccountManagerFn = Arc::new(|_auth| Box::pin(async {}));
            let mut commits = 0usize;
            let mut commit = |state: RuntimeLiveSyncState<FakeSync>| {
                commits += 1;
                assert!(state.sync.is_none());
                assert!(state.cleanup_registered);
            };
            let mut register = |_c: Box<dyn FnOnce() + Send>| {};
            let mut warn = |_m: &str| {};

            let state = ensure_runtime_live_account_sync(EnsureRuntimeLiveAccountSyncDeps {
                enabled: false,
                debounce_ms: 250.0,
                poll_interval_ms: 2_000.0,
                target_path: "/tmp/accounts.json".to_string(),
                auth_fallback: None,
                current_sync: Some(current.clone()),
                current_path: Some("/tmp/accounts.json".to_string()),
                current_config_key: Some("250:2000".to_string()),
                current_cleanup_registered: true,
                get_current_sync: Arc::new(|| None),
                create_sync: &mut create,
                reload_account_manager_from_disk: reload,
                commit_state: &mut commit,
                register_cleanup: &mut register,
                log_warn: &mut warn,
                plugin_name: "codex-multi-auth",
            })
            .await
            .unwrap();

            assert!(state.sync.is_none());
            assert!(state.cleanup_registered);
            assert_eq!(current.stopped.load(Ordering::SeqCst), 1);
            assert_eq!(commits, 1);
        });
    }

    #[test]
    fn config_key_change_stops_and_recreates_without_duplicate_cleanup() {
        test_runtime().block_on(async {
            let previous = FakeSync::new();
            let created = FakeSync::new();
            let created_for_closure = created.clone();
            let mut create = move |_on_change: LiveSyncOnChange, _o: LiveSyncCreateOptions| {
                created_for_closure.clone()
            };
            let reload: ReloadAccountManagerFn = Arc::new(|_auth| Box::pin(async {}));
            let mut commit = |_state: RuntimeLiveSyncState<FakeSync>| {};
            let mut cleanups = 0usize;
            let mut register = |_c: Box<dyn FnOnce() + Send>| cleanups += 1;
            let mut warn = |_m: &str| {};

            let state = ensure_runtime_live_account_sync(EnsureRuntimeLiveAccountSyncDeps {
                enabled: true,
                debounce_ms: 500.0,
                poll_interval_ms: 1_000.0,
                target_path: "/tmp/accounts.json".to_string(),
                auth_fallback: None,
                current_sync: Some(previous.clone()),
                current_path: Some("/tmp/accounts.json".to_string()),
                current_config_key: Some("250:2000".to_string()),
                current_cleanup_registered: true,
                get_current_sync: Arc::new(|| None),
                create_sync: &mut create,
                reload_account_manager_from_disk: reload,
                commit_state: &mut commit,
                register_cleanup: &mut register,
                log_warn: &mut warn,
                plugin_name: "codex-multi-auth",
            })
            .await
            .unwrap();

            assert_eq!(previous.stopped.load(Ordering::SeqCst), 1);
            assert!(Arc::ptr_eq(state.sync.as_ref().unwrap(), &created));
            assert_eq!(state.config_key.as_deref(), Some("500:1000"));
            // Cleanup was already registered: not registered again.
            assert_eq!(cleanups, 0);
        });
    }
}
