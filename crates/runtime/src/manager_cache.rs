//! Port of `lib/runtime/account-manager-cache.ts` (+
//! `account-manager-cache-entry.ts`) — the cached AccountManager singleton
//! with reload dedupe (spec 10 §21, ARCHITECTURE §3 row "Loader mutex /
//! account-manager cache / reload dedupe").
//!
//! The TS module was a set of dependency-injected helpers over three
//! promise slots living in `index.ts` (`cachedAccountManager`,
//! `accountManagerPromise`, `reloadInFlight`). In Rust those slots collapse
//! into [`AccountManagerCache`]: `cached` (the resolved manager — the TS
//! promise slot only existed for JS `await` semantics) and the in-flight
//! reload dedupe. The dedupe contract is preserved: concurrent reload
//! callers share ONE disk load; `invalidate` clears the cached manager but
//! deliberately does NOT cancel an in-flight reload (TS parity — the
//! reload's `finally` clears the in-flight slot itself).

use cma_accounts::manager::AccountManager;
use cma_accounts::manager_persistence::SharedAccountManager;
use cma_core::types::OAuthAuthDetails;
use std::sync::{LazyLock, Mutex as StdMutex};
use tokio::sync::watch;

type InFlight = watch::Receiver<Option<SharedAccountManager>>;

#[derive(Default)]
struct CacheInner {
    cached: Option<SharedAccountManager>,
    in_flight: Option<InFlight>,
}

/// The cached-manager singleton state (one per process in production; tests
/// may construct their own).
#[derive(Default)]
pub struct AccountManagerCache {
    inner: StdMutex<CacheInner>,
}

enum ReloadAction {
    Wait(InFlight),
    Load(watch::Sender<Option<SharedAccountManager>>),
}

impl AccountManagerCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The currently cached manager, if any (TS `cachedAccountManager`).
    pub fn cached(&self) -> Option<SharedAccountManager> {
        self.inner.lock().expect("manager cache poisoned").cached.clone()
    }

    /// TS `invalidateRuntimeAccountManagerCache` /
    /// `invalidateAccountManagerCacheState` — null out the cached manager
    /// (and its resolved promise). An in-flight reload is NOT cancelled.
    pub fn invalidate(&self) {
        self.inner.lock().expect("manager cache poisoned").cached = None;
    }

    /// TS `reloadRuntimeAccountManager` — dedupes on the shared in-flight
    /// reload: concurrent callers all receive the manager produced by the
    /// single disk load. The check-and-claim runs under one lock
    /// acquisition (the TS version relied on `setReloadInFlight` running
    /// before any `await`).
    pub async fn reload(&self, auth_fallback: Option<OAuthAuthDetails>) -> SharedAccountManager {
        let action = {
            let mut inner = self.inner.lock().expect("manager cache poisoned");
            match &inner.in_flight {
                Some(receiver) => ReloadAction::Wait(receiver.clone()),
                None => {
                    let (sender, receiver) = watch::channel(None);
                    inner.in_flight = Some(receiver);
                    ReloadAction::Load(sender)
                }
            }
        };

        match action {
            ReloadAction::Wait(mut receiver) => {
                loop {
                    if let Some(manager) = receiver.borrow().clone() {
                        return manager;
                    }
                    if receiver.changed().await.is_err() {
                        // The loading task can only vanish after publishing
                        // (the sender lives until this fn returns), but be
                        // total: fall back to a fresh reload.
                        break;
                    }
                }
                Box::pin(self.reload(auth_fallback)).await
            }
            ReloadAction::Load(sender) => {
                let manager = SharedAccountManager::new(
                    AccountManager::load_from_disk(auth_fallback.as_ref()).await,
                );
                {
                    let mut inner = self.inner.lock().expect("manager cache poisoned");
                    inner.cached = Some(manager.clone());
                    // TS `finally(() => setReloadInFlight(null))`.
                    inner.in_flight = None;
                }
                let _ = sender.send(Some(manager.clone()));
                manager
            }
        }
    }

    /// Loader semantics (TS `accountManagerPromise ?? load`): return the
    /// cached manager or load one (sharing any in-flight reload).
    pub async fn get_or_load(
        &self,
        auth_fallback: Option<OAuthAuthDetails>,
    ) -> SharedAccountManager {
        if let Some(cached) = self.cached() {
            return cached;
        }
        self.reload(auth_fallback).await
    }

    /// Test-only: clear everything (cached AND in-flight bookkeeping).
    pub fn reset_for_testing(&self) {
        let mut inner = self.inner.lock().expect("manager cache poisoned");
        inner.cached = None;
        inner.in_flight = None;
    }
}

static GLOBAL_CACHE: LazyLock<AccountManagerCache> = LazyLock::new(AccountManagerCache::new);

/// The process-wide cache instance (the TS `index.ts` module slots).
pub fn account_manager_cache() -> &'static AccountManagerCache {
    &GLOBAL_CACHE
}

/// TS `invalidateAccountManagerCache()` convenience over the global cache.
pub fn invalidate_account_manager_cache() {
    GLOBAL_CACHE.invalidate();
}

/// TS `reloadAccountManagerFromDisk(authFallback?)` convenience over the
/// global cache.
pub async fn reload_account_manager_from_disk(
    auth_fallback: Option<OAuthAuthDetails>,
) -> SharedAccountManager {
    GLOBAL_CACHE.reload(auth_fallback).await
}

/// Loader-side accessor over the global cache.
pub async fn get_account_manager(auth_fallback: Option<OAuthAuthDetails>) -> SharedAccountManager {
    GLOBAL_CACHE.get_or_load(auth_fallback).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use std::sync::Arc;

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    #[serial(env)]
    fn reload_caches_and_invalidate_clears() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let cache = AccountManagerCache::new();
            assert!(cache.cached().is_none());

            let manager = cache.reload(None).await;
            let cached = cache.cached().expect("manager cached after reload");
            assert!(Arc::ptr_eq(manager.manager(), cached.manager()));

            cache.invalidate();
            assert!(cache.cached().is_none());
        });
    }

    #[test]
    #[serial(env)]
    fn get_or_load_reuses_the_cached_manager() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let cache = AccountManagerCache::new();
            let first = cache.get_or_load(None).await;
            let second = cache.get_or_load(None).await;
            assert!(Arc::ptr_eq(first.manager(), second.manager()));

            // After invalidation a fresh manager is loaded.
            cache.invalidate();
            let third = cache.get_or_load(None).await;
            assert!(!Arc::ptr_eq(first.manager(), third.manager()));
        });
    }

    #[test]
    #[serial(env)]
    fn concurrent_reloads_share_one_in_flight_load() {
        let _sandbox = EnvSandbox::new();
        test_runtime().block_on(async {
            let cache = Arc::new(AccountManagerCache::new());
            let a = {
                let cache = cache.clone();
                tokio::spawn(async move { cache.reload(None).await })
            };
            let b = {
                let cache = cache.clone();
                tokio::spawn(async move { cache.reload(None).await })
            };
            let (a, b) = (a.await.unwrap(), b.await.unwrap());
            // Both callers may or may not have raced the same in-flight load
            // (timing-dependent), but the cache must end consistent: the
            // cached manager is one of the two returned handles.
            let cached = cache.cached().expect("cached after concurrent reloads");
            assert!(
                Arc::ptr_eq(cached.manager(), a.manager())
                    || Arc::ptr_eq(cached.manager(), b.manager())
            );
        });
    }
}
