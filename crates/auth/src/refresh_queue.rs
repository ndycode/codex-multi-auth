//! Port of `lib/refresh-queue.ts` — in-process refresh dedup.
//!
//! Behavior source: specs/04-rotation.md §6.
//!
//! Prevents race conditions when multiple concurrent requests try to refresh
//! the same account's token simultaneously: subsequent callers await the
//! existing in-flight refresh (a [`futures::future::Shared`] here, standing in
//! for the shared TS promise). The body is `tokio::spawn`ed — the Rust
//! equivalent of the TS eagerly-executing async IIFE: it ALWAYS runs to
//! completion even when every awaiter is dropped (e.g. a client disconnect
//! drops the request future mid-refresh), so an in-flight OAuth exchange is
//! never suspended after the POST was sent (which would burn the rotated
//! refresh token) and the pending-entry cleanup always runs (a lazily polled
//! future would wedge the token's refresh lane forever — refresh-stage
//! entries are deliberately never evicted).
//!
//! Token-rotation handling: when OpenAI rotates the refresh token during a
//! refresh, a mapping `oldToken → newToken` lets requests arriving with either
//! token find the same in-flight refresh. Generation counters guard against a
//! stale evicted attempt racing a newer one (supersession: the stale attempt
//! joins the newer generation's future instead of double-refreshing).

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, LazyLock, Mutex as StdMutex, MutexGuard};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde_json::json;
use sha2::{Digest, Sha256};

use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenResult};
use cma_core::utils::now_ms;

use crate::refresh_lease::{
    DEFAULT_WAIT_TIMEOUT_MS, LeaseRole, RefreshLeaseCoordinator, RefreshLeaseHandle,
};

fn log() -> ScopedLogger {
    create_logger("refresh-queue")
}

/// Extra headroom beyond the lease wait budget before an acquire-stage entry
/// is treated as genuinely stuck (a lease `acquire()` polls on an interval and
/// does filesystem work, so it can overshoot its wait deadline slightly).
const ACQUIRE_EVICTION_SLACK_MS: i64 = 5_000;

/// Non-reversible correlation fingerprint for a token, for logs.
///
/// Logging trailing characters of a refresh token (`token.slice(-6)`) would
/// leak recoverable secret material into 0600 log files; a short SHA-256
/// prefix gives the same cross-log correlation without exposing the token.
fn token_fingerprint(token: &str) -> String {
    if token.is_empty() {
        return "none".to_string();
    }
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(8);
    for byte in digest.iter().take(4) {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Coordinator seam the queue depends on (implemented by
/// [`RefreshLeaseCoordinator`]; test doubles model throwing/never-resolving
/// acquires).
pub trait LeaseCoordinatorApi: Send + Sync {
    fn acquire<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>>;
    /// The wait budget the coordinator was ACTUALLY configured with; `None`
    /// models a test double without the getter (falls back to
    /// [`DEFAULT_WAIT_TIMEOUT_MS`]).
    fn configured_wait_timeout_ms(&self) -> Option<i64>;
}

impl LeaseCoordinatorApi for RefreshLeaseCoordinator {
    fn acquire<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>> {
        RefreshLeaseCoordinator::acquire(self, refresh_token).boxed()
    }

    fn configured_wait_timeout_ms(&self) -> Option<i64> {
        Some(RefreshLeaseCoordinator::configured_wait_timeout_ms(self))
    }
}

/// Error surface of the refresh executor, mirroring the TS `refreshAccessToken`
/// throw paths: `is_abort` maps `isAbortError` (name `AbortError` / code
/// `ABORT_ERR`); everything else is treated as a network-class exception.
#[derive(Clone, Debug)]
pub struct RefreshExecError {
    pub message: Option<String>,
    pub is_abort: bool,
}

/// The actual token-refresh call (`refreshAccessToken` in TS). Injectable for
/// tests; the default calls `crate::oauth::refresh_access_token`.
pub type RefreshExecutor =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<TokenResult, RefreshExecError>> + Send + Sync>;

fn default_refresh_executor() -> RefreshExecutor {
    Arc::new(|token: String| async move { Ok(default_refresh(token).await) }.boxed())
}

/// Production path: delegate to the OAuth module's `refresh_access_token`
/// (which never throws — failures come back as `TokenResult::Failed`). The
/// abort/timeout race lives in [`execute_refresh`] via `tokio::time::timeout`,
/// replacing the TS AbortController.
#[cfg(not(test))]
async fn default_refresh(token: String) -> TokenResult {
    crate::oauth::refresh_access_token(&token).await
}

/// Unit tests always inject an executor via [`RefreshQueue::with_parts`]; this
/// stub keeps the test build compiling independently of the oauth module.
#[cfg(test)]
async fn default_refresh(_token: String) -> TokenResult {
    unreachable!("tests must inject a refresh executor via RefreshQueue::with_parts")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Acquire,
    Refresh,
}

type SharedRefresh = Shared<BoxFuture<'static, TokenResult>>;

/// Entry representing an in-flight token refresh operation.
struct RefreshEntry {
    future: SharedRefresh,
    started_at: i64,
    stage: Stage,
    generation: u64,
    stale_warning_logged: bool,
}

struct QueueState {
    pending: HashMap<String, RefreshEntry>,
    /// `oldToken → newToken` after rotation, insertion-ordered (TS Map).
    token_rotation_map: Vec<(String, String)>,
    next_generation: u64,
}

struct QueueInner {
    max_entry_age_ms: i64,
    coordinator: Arc<dyn LeaseCoordinatorApi>,
    executor: RefreshExecutor,
    state: StdMutex<QueueState>,
}

impl QueueInner {
    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// `RefreshQueue` — cheaply cloneable handle over the shared queue state.
#[derive(Clone)]
pub struct RefreshQueue {
    inner: Arc<QueueInner>,
}

impl RefreshQueue {
    /// `new RefreshQueue(maxEntryAgeMs = 30_000)` with the environment lease
    /// coordinator and the real refresh executor.
    pub fn new(max_entry_age_ms: Option<i64>) -> Self {
        Self::with_parts(
            max_entry_age_ms.unwrap_or(30_000),
            Arc::new(RefreshLeaseCoordinator::from_environment()),
            default_refresh_executor(),
        )
    }

    /// `new RefreshQueue(maxEntryAgeMs, leaseCoordinator)`.
    pub fn with_coordinator(
        max_entry_age_ms: i64,
        coordinator: Arc<dyn LeaseCoordinatorApi>,
    ) -> Self {
        Self::with_parts(max_entry_age_ms, coordinator, default_refresh_executor())
    }

    /// Full-injection constructor (tests).
    pub fn with_parts(
        max_entry_age_ms: i64,
        coordinator: Arc<dyn LeaseCoordinatorApi>,
        executor: RefreshExecutor,
    ) -> Self {
        Self {
            inner: Arc::new(QueueInner {
                max_entry_age_ms,
                coordinator,
                executor,
                state: StdMutex::new(QueueState {
                    pending: HashMap::new(),
                    token_rotation_map: Vec::new(),
                    next_generation: 0,
                }),
            }),
        }
    }

    /// `refresh(refreshToken)` — dedupes concurrent requests for the same
    /// refresh token; all concurrent callers get the same result.
    pub async fn refresh(&self, refresh_token: &str) -> TokenResult {
        let token = refresh_token.to_string();
        let future: SharedRefresh = {
            let mut state = self.inner.lock();
            cleanup(&self.inner, &mut state);

            // Direct match on an existing in-flight refresh.
            if let Some(existing) = state.pending.get(&token) {
                log().info(
                    "Reusing in-flight refresh for token",
                    Some(&json!({
                        "tokenSuffix": token_fingerprint(&token),
                        "waitingMs": now_ms() - existing.started_at,
                    })),
                );
                existing.future.clone()
            } else if let Some(rotated_from) = find_original_token(&state, &token)
                && let Some(original_entry) = state.pending.get(&rotated_from)
            {
                // This token was rotated FROM another token that is still
                // refreshing (request A got newToken while its refresh of
                // oldToken is in flight; request B arrives with newToken).
                log().info(
                    "Reusing in-flight refresh via rotation mapping",
                    Some(&json!({
                        "newTokenSuffix": token_fingerprint(&token),
                        "originalTokenSuffix": token_fingerprint(&rotated_from),
                        "waitingMs": now_ms() - original_entry.started_at,
                    })),
                );
                original_entry.future.clone()
            } else {
                // Start a new refresh immediately so local state reflects
                // "in-flight" without waiting on cross-process lease checks.
                state.next_generation += 1;
                let generation = state.next_generation;
                let started_at = now_ms();
                // Eager execution (TS async-IIFE parity, refresh-queue.ts:172):
                // the body is `tokio::spawn`ed so it ALWAYS runs to completion
                // even when every awaiter is dropped (e.g. a client disconnect
                // drops the creating request mid-refresh). A lazily polled
                // Shared future would (1) suspend an already-sent OAuth POST —
                // OpenAI rotates the refresh token server-side, so the stored
                // token is burned and the next refresh gets invalid_grant —
                // and (2) never run the `finally` cleanup below, wedging this
                // token's refresh lane on a stale cached failure forever
                // (refresh-stage entries are deliberately never evicted).
                let body = {
                    let inner = Arc::clone(&self.inner);
                    let token = token.clone();
                    async move {
                        let result =
                            run_refresh_body(Arc::clone(&inner), token.clone(), generation).await;
                        // TS `finally` (refresh-queue.ts:229-237), moved into
                        // the spawned wrapper so it runs even when the
                        // creating caller died: delete the pending entry only
                        // if it is still our generation (or absent), and
                        // clean the rotation mapping.
                        let mut state = inner.lock();
                        let still_ours = state
                            .pending
                            .get(&token)
                            .is_none_or(|entry| entry.generation == generation);
                        if still_ours {
                            state.pending.remove(&token);
                            cleanup_rotation_mapping(&mut state, &token);
                        }
                        result
                    }
                };
                let future: SharedRefresh = tokio::spawn(body)
                    .map(|joined| {
                        joined.unwrap_or_else(|join_error| {
                            TokenResult::Failed(TokenFailure {
                                reason: Some(TokenFailureReason::Unknown),
                                status_code: None,
                                message: Some(format!("Refresh task failed: {join_error}")),
                            })
                        })
                    })
                    .boxed()
                    .shared();
                state.pending.insert(
                    token.clone(),
                    RefreshEntry {
                        future: future.clone(),
                        started_at,
                        stage: Stage::Acquire,
                        generation,
                        stale_warning_logged: false,
                    },
                );
                future
            }
        };
        future.await
    }

    /// `isRefreshing(token)` — true while a refresh is in flight.
    pub fn is_refreshing(&self, refresh_token: &str) -> bool {
        self.inner.lock().pending.contains_key(refresh_token)
    }

    /// `pendingCount` — number of pending refresh operations.
    pub fn pending_count(&self) -> usize {
        self.inner.lock().pending.len()
    }

    /// `clear()` — pending entries + rotation map (primarily for testing).
    pub fn clear(&self) {
        let mut state = self.inner.lock();
        state.pending.clear();
        state.token_rotation_map.clear();
    }
}

/// `findOriginalToken(newToken)` — first rotation-map entry whose VALUE equals
/// the new token (insertion order).
fn find_original_token(state: &QueueState, new_token: &str) -> Option<String> {
    state
        .token_rotation_map
        .iter()
        .find(|(_, mapped_new)| mapped_new == new_token)
        .map(|(old, _)| old.clone())
}

/// `cleanupRotationMapping(token)` — removes `token` as an old-token key AND
/// any mapping whose value equals `token`.
fn cleanup_rotation_mapping(state: &mut QueueState, token: &str) {
    state
        .token_rotation_map
        .retain(|(old, new)| old != token && new != token);
}

/// `markStage(stage)` — only mutates the entry if its generation still equals
/// ours; resets `startedAt` so each stage gets its own age budget.
fn mark_stage(inner: &QueueInner, token: &str, generation: u64, stage: Stage) {
    let mut state = inner.lock();
    let Some(entry) = state.pending.get_mut(token) else {
        return;
    };
    if entry.generation != generation {
        return;
    }
    entry.stage = stage;
    entry.started_at = now_ms();
    entry.stale_warning_logged = false;
}

/// `getSupersedingPromise` — when a NEWER generation replaced our map entry,
/// join its future instead of double-refreshing.
fn superseding_future(inner: &QueueInner, token: &str, generation: u64) -> Option<SharedRefresh> {
    let state = inner.lock();
    let current = state.pending.get(token)?;
    if current.generation == generation {
        return None;
    }
    log().info(
        "Refresh generation superseded; joining newer in-flight refresh",
        Some(&json!({
            "tokenSuffix": token_fingerprint(token),
            "staleGeneration": generation,
            "activeGeneration": current.generation,
        })),
    );
    Some(current.future.clone())
}

/// The per-generation async body (the TS async IIFE).
async fn run_refresh_body(inner: Arc<QueueInner>, token: String, generation: u64) -> TokenResult {
    let lease = match inner.coordinator.acquire(&token).await {
        Ok(lease) => lease,
        Err(error) => {
            log().warn(
                "Refresh lease acquire failed; falling back to local refresh",
                Some(&json!({
                    "tokenSuffix": token_fingerprint(&token),
                    "error": error.to_string(),
                })),
            );
            if let Some(superseding) = superseding_future(&inner, &token, generation) {
                return superseding.await;
            }
            mark_stage(&inner, &token, generation, Stage::Refresh);
            return execute_refresh_with_rotation_tracking(&inner, &token).await;
        }
    };
    if lease.role == LeaseRole::Follower
        && let Some(result) = lease.result.clone()
    {
        log().info(
            "Using refresh result from cross-process lease",
            Some(&json!({ "tokenSuffix": token_fingerprint(&token) })),
        );
        return result;
    }

    // try
    if let Some(superseding) = superseding_future(&inner, &token, generation) {
        // TS `return supersedingPromise;` triggers the
        // `finally { await lease.release(); }` BEFORE the async function's
        // promise adopts the returned promise (finally-before-adoption), so
        // the on-disk lock is unlinked BEFORE the newer generation's refresh
        // runs. Releasing only after `superseding.await` would hold the
        // freshly-acquired Active lock for the whole superseding refresh —
        // the successor's `acquire` would poll it until its wait budget
        // (default 35 s) expires and then BYPASS, refreshing without
        // cross-process single-flight protection.
        release_lease_quietly(&lease, &token).await;
        return superseding.await;
    }
    mark_stage(&inner, &token, generation, Stage::Refresh);
    let outcome = execute_refresh_with_rotation_tracking(&inner, &token).await;
    // Publish the success to cross-process followers; publish errors are
    // warn-only.
    if let Err(error) = lease.release(Some(&outcome)).await {
        log().warn(
            "Failed to publish lease refresh result",
            Some(&json!({
                "tokenSuffix": token_fingerprint(&token),
                "error": error.to_string(),
            })),
        );
    }
    // finally: idempotent unlock; errors warn-only.
    release_lease_quietly(&lease, &token).await;
    outcome
}

/// The TS `finally { await lease.release(); }` — idempotent unlock with
/// warn-only error handling.
async fn release_lease_quietly(lease: &RefreshLeaseHandle, token: &str) {
    if let Err(error) = lease.release(None).await {
        log().warn(
            "Failed to release refresh lease",
            Some(&json!({
                "tokenSuffix": token_fingerprint(token),
                "error": error.to_string(),
            })),
        );
    }
}

/// `executeRefreshWithRotationTracking` — record `old → new` after a rotating
/// success so lookups with either token find the same entry.
async fn execute_refresh_with_rotation_tracking(
    inner: &Arc<QueueInner>,
    refresh_token: &str,
) -> TokenResult {
    let result = execute_refresh(inner, refresh_token).await;

    if let TokenResult::Success(success) = &result
        && success.refresh != refresh_token
    {
        {
            let mut state = inner.lock();
            // Map.set semantics: replace the value when the key exists.
            if let Some(entry) = state
                .token_rotation_map
                .iter_mut()
                .find(|(old, _)| old == refresh_token)
            {
                entry.1 = success.refresh.clone();
            } else {
                state
                    .token_rotation_map
                    .push((refresh_token.to_string(), success.refresh.clone()));
            }
        }
        log().info(
            "Token rotated during refresh",
            Some(&json!({
                "oldTokenSuffix": token_fingerprint(refresh_token),
                "newTokenSuffix": token_fingerprint(&success.refresh),
            })),
        );
    }

    result
}

/// `executeRefresh` — the actual refresh call raced against a
/// `max(1_000, maxEntryAgeMs)` timeout. **Never throws**: aborts/timeouts map
/// to `failed/unknown`, other exceptions to `failed/network_error`.
async fn execute_refresh(inner: &Arc<QueueInner>, refresh_token: &str) -> TokenResult {
    let start_time = now_ms();
    log().info(
        "Starting token refresh",
        Some(&json!({ "tokenSuffix": token_fingerprint(refresh_token) })),
    );
    let timeout_ms = inner.max_entry_age_ms.max(1_000);

    let refresh_future = (inner.executor)(refresh_token.to_string());
    let raced =
        tokio::time::timeout(Duration::from_millis(timeout_ms as u64), refresh_future).await;
    let duration = now_ms() - start_time;

    match raced {
        Ok(Ok(result)) => {
            match &result {
                TokenResult::Success(_) => log().info(
                    "Token refresh succeeded",
                    Some(&json!({
                        "tokenSuffix": token_fingerprint(refresh_token),
                        "durationMs": duration,
                    })),
                ),
                TokenResult::Failed(failure) => log().warn(
                    "Token refresh failed",
                    Some(&json!({
                        "tokenSuffix": token_fingerprint(refresh_token),
                        "reason": failure.reason.map(|reason| reason.as_str()),
                        "durationMs": duration,
                    })),
                ),
            }
            result
        }
        Ok(Err(error)) if error.is_abort => {
            log().warn(
                "Token refresh aborted",
                Some(&json!({
                    "tokenSuffix": token_fingerprint(refresh_token),
                    "error": error.message.clone(),
                    "durationMs": duration,
                })),
            );
            TokenResult::Failed(TokenFailure {
                reason: Some(TokenFailureReason::Unknown),
                status_code: None,
                message: Some(error.message.unwrap_or_else(|| "Refresh aborted".to_string())),
            })
        }
        Ok(Err(error)) => {
            log().error(
                "Token refresh threw exception",
                Some(&json!({
                    "tokenSuffix": token_fingerprint(refresh_token),
                    "error": error.message.clone(),
                    "durationMs": duration,
                })),
            );
            TokenResult::Failed(TokenFailure {
                reason: Some(TokenFailureReason::NetworkError),
                status_code: None,
                message: Some(
                    error
                        .message
                        .unwrap_or_else(|| "Unknown error during refresh".to_string()),
                ),
            })
        }
        Err(_elapsed) => {
            // The TS timeout path rejects with an AbortError carrying this
            // exact message; isAbortError routes it to reason "unknown"
            // (deliberately NOT "timeout").
            let message = format!("Refresh timeout after {timeout_ms}ms");
            log().warn(
                "Token refresh aborted",
                Some(&json!({
                    "tokenSuffix": token_fingerprint(refresh_token),
                    "error": message,
                    "durationMs": duration,
                })),
            );
            TokenResult::Failed(TokenFailure {
                reason: Some(TokenFailureReason::Unknown),
                status_code: None,
                message: Some(message),
            })
        }
    }
}

/// `cleanup()` — evict genuinely-stuck acquire-stage entries; warn ONCE for
/// stale refresh-stage entries (never evicted — a duplicate refresh against a
/// token OpenAI already rotated would hit `invalid_grant`).
fn cleanup(inner: &QueueInner, state: &mut QueueState) {
    let now = now_ms();
    // Read the budget the coordinator was actually CONFIGURED with (constructor
    // option / CODEX_AUTH_REFRESH_LEASE_WAIT_MS) rather than the static
    // default: under a larger configured budget the default would evict too
    // early. A test double without the getter falls back to the default.
    let lease_wait_timeout_ms = inner
        .coordinator
        .configured_wait_timeout_ms()
        .unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
    let acquire_eviction_age_ms = inner
        .max_entry_age_ms
        .max(lease_wait_timeout_ms + ACQUIRE_EVICTION_SLACK_MS);

    let mut evicted: Vec<String> = Vec::new();
    for (token, entry) in state.pending.iter_mut() {
        let age_ms = now - entry.started_at;
        if entry.stage == Stage::Acquire {
            if age_ms <= acquire_eviction_age_ms {
                continue;
            }
            log().warn(
                "Evicting stale refresh entry during lease acquire stage",
                Some(&json!({
                    "tokenSuffix": token_fingerprint(token),
                    "ageMs": age_ms,
                })),
            );
            evicted.push(token.clone());
            continue;
        }
        if age_ms <= inner.max_entry_age_ms {
            continue;
        }
        if !entry.stale_warning_logged {
            log().warn(
                "Refresh entry exceeded stale warning threshold",
                Some(&json!({
                    "tokenSuffix": token_fingerprint(token),
                    "ageMs": age_ms,
                })),
            );
            entry.stale_warning_logged = true;
        }
    }
    for token in evicted {
        state.pending.remove(&token);
        cleanup_rotation_mapping(state, &token);
    }
}

// ============================================================================
// Singleton
// ============================================================================

static REFRESH_QUEUE_SINGLETON: LazyLock<StdMutex<Option<RefreshQueue>>> =
    LazyLock::new(|| StdMutex::new(None));

/// `getRefreshQueue(maxEntryAgeMs?)` — lazy singleton; the argument is honored
/// only on first call.
pub fn get_refresh_queue(max_entry_age_ms: Option<i64>) -> RefreshQueue {
    let mut slot = REFRESH_QUEUE_SINGLETON
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    slot.get_or_insert_with(|| RefreshQueue::new(max_entry_age_ms))
        .clone()
}

/// `resetRefreshQueue()` — `clear()` then drop the singleton.
pub fn reset_refresh_queue() {
    let mut slot = REFRESH_QUEUE_SINGLETON
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(queue) = slot.take() {
        queue.clear();
    }
}

/// `queuedRefresh(refreshToken)` — THE entry point used by proactive-refresh
/// and rotation-token-refresh.
pub async fn queued_refresh(refresh_token: &str) -> TokenResult {
    get_refresh_queue(None).refresh(refresh_token).await
}

// ============================================================================
// Tests (ported from test/refresh-queue.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refresh_lease::{LeaseFs, RefreshLeaseCoordinatorOptions};
    use cma_core::schemas::token::TokenSuccess;
    use std::path::Path;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::sync::Semaphore;

    fn success(access: &str, refresh: &str) -> TokenResult {
        TokenResult::Success(TokenSuccess {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires: now_ms() + 3_600_000,
            id_token: None,
            multi_account: None,
        })
    }

    fn failed(
        reason: TokenFailureReason,
        status_code: Option<i64>,
        message: Option<&str>,
    ) -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason: Some(reason),
            status_code,
            message: message.map(str::to_string),
        })
    }

    /// Coordinator whose acquire always resolves to a bypass handle
    /// immediately (the queue treats bypass and owner identically apart from
    /// release, which is a no-op for bypass).
    struct BypassCoordinator;

    impl LeaseCoordinatorApi for BypassCoordinator {
        fn acquire<'a>(
            &'a self,
            _refresh_token: &'a str,
        ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>> {
            async { Ok(RefreshLeaseHandle::bypass()) }.boxed()
        }
        fn configured_wait_timeout_ms(&self) -> Option<i64> {
            Some(DEFAULT_WAIT_TIMEOUT_MS)
        }
    }

    /// Coordinator whose FIRST acquire never resolves; subsequent acquires
    /// resolve immediately. Tracks call counts.
    struct StickyFirstAcquireCoordinator {
        calls: AtomicU32,
        configured: Option<i64>,
    }

    impl StickyFirstAcquireCoordinator {
        fn new(configured: Option<i64>) -> Self {
            Self {
                calls: AtomicU32::new(0),
                configured,
            }
        }
    }

    impl LeaseCoordinatorApi for StickyFirstAcquireCoordinator {
        fn acquire<'a>(
            &'a self,
            _refresh_token: &'a str,
        ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                std::future::pending().boxed()
            } else {
                async { Ok(RefreshLeaseHandle::bypass()) }.boxed()
            }
        }
        fn configured_wait_timeout_ms(&self) -> Option<i64> {
            self.configured
        }
    }

    /// Coordinator whose acquire always fails (the TS mockRejectedValue path).
    struct FailingAcquireCoordinator;

    impl LeaseCoordinatorApi for FailingAcquireCoordinator {
        fn acquire<'a>(
            &'a self,
            _refresh_token: &'a str,
        ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>> {
            async { Err(io::Error::other("EBUSY lease dir")) }.boxed()
        }
        fn configured_wait_timeout_ms(&self) -> Option<i64> {
            None
        }
    }

    /// Coordinator whose FIRST acquire waits on a gate and then resolves;
    /// subsequent acquires resolve immediately.
    struct GatedFirstAcquireCoordinator {
        calls: AtomicU32,
        gate: Arc<Semaphore>,
    }

    impl LeaseCoordinatorApi for GatedFirstAcquireCoordinator {
        fn acquire<'a>(
            &'a self,
            _refresh_token: &'a str,
        ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let gate = Arc::clone(&self.gate);
            async move {
                if call == 0 {
                    let permit = gate.acquire().await.expect("gate closed");
                    permit.forget();
                }
                Ok(RefreshLeaseHandle::bypass())
            }
            .boxed()
        }
        fn configured_wait_timeout_ms(&self) -> Option<i64> {
            Some(DEFAULT_WAIT_TIMEOUT_MS)
        }
    }

    /// Executor returning a fixed sequence of behaviors (one per call).
    enum ExecStep {
        Ok(TokenResult),
        Err(RefreshExecError),
        Pending,
        /// Wait for a semaphore permit, then return the result.
        Gated(Arc<Semaphore>, TokenResult),
    }

    struct ExecScript {
        steps: StdMutex<Vec<ExecStep>>,
        calls: AtomicU32,
        last_token: StdMutex<Option<String>>,
    }

    impl ExecScript {
        fn new(steps: Vec<ExecStep>) -> Arc<Self> {
            Arc::new(Self {
                steps: StdMutex::new(steps),
                calls: AtomicU32::new(0),
                last_token: StdMutex::new(None),
            })
        }

        fn executor(self: &Arc<Self>) -> RefreshExecutor {
            let script = Arc::clone(self);
            Arc::new(move |token: String| {
                script.calls.fetch_add(1, Ordering::SeqCst);
                *script.last_token.lock().unwrap() = Some(token);
                let step = {
                    let mut steps = script.steps.lock().unwrap();
                    if steps.is_empty() {
                        None
                    } else {
                        Some(steps.remove(0))
                    }
                };
                async move {
                    match step {
                        Some(ExecStep::Ok(result)) => Ok(result),
                        Some(ExecStep::Err(error)) => Err(error),
                        Some(ExecStep::Pending) | None => std::future::pending().await,
                        Some(ExecStep::Gated(gate, result)) => {
                            let permit = gate.acquire().await.expect("gate closed");
                            permit.forget();
                            Ok(result)
                        }
                    }
                }
                .boxed()
            })
        }

        fn calls(&self) -> u32 {
            self.calls.load(Ordering::SeqCst)
        }
    }

    async fn yield_a_few_times() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn rewind_entry(queue: &RefreshQueue, token: &str, by_ms: i64) {
        let mut state = queue.inner.lock();
        let entry = state.pending.get_mut(token).expect("entry present");
        entry.started_at -= by_ms;
    }

    // ---- basic refresh functionality ----

    #[tokio::test]
    async fn calls_refresh_executor_for_a_single_request() {
        let mock = success("new-access-token", "new-refresh-token");
        let script = ExecScript::new(vec![ExecStep::Ok(mock.clone())]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let result = queue.refresh("test-refresh-token").await;

        assert_eq!(result, mock);
        assert_eq!(script.calls(), 1);
        assert_eq!(
            script.last_token.lock().unwrap().as_deref(),
            Some("test-refresh-token")
        );
    }

    #[tokio::test]
    async fn returns_failed_result_when_refresh_fails() {
        let script = ExecScript::new(vec![ExecStep::Ok(failed(
            TokenFailureReason::HttpError,
            Some(401),
            None,
        ))]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let result = queue.refresh("bad-token").await;
        let failure = result.as_failure().expect("failed result");
        assert_eq!(failure.reason, Some(TokenFailureReason::HttpError));
    }

    #[tokio::test]
    async fn catches_exceptions_and_returns_network_error_failure() {
        let script = ExecScript::new(vec![ExecStep::Err(RefreshExecError {
            message: Some("Network timeout".to_string()),
            is_abort: false,
        })]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let result = queue.refresh("test-token").await;
        let failure = result.as_failure().expect("failed result");
        assert_eq!(failure.reason, Some(TokenFailureReason::NetworkError));
        assert_eq!(failure.message.as_deref(), Some("Network timeout"));
    }

    #[tokio::test]
    async fn classifies_abort_errors_as_non_network_failures() {
        let script = ExecScript::new(vec![ExecStep::Err(RefreshExecError {
            message: Some("Request aborted".to_string()),
            is_abort: true,
        })]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let result = queue.refresh("abort-token").await;
        let failure = result.as_failure().expect("failed result");
        assert_eq!(failure.reason, Some(TokenFailureReason::Unknown));
        assert_eq!(failure.message.as_deref(), Some("Request aborted"));
    }

    #[tokio::test]
    async fn handles_non_error_exception_during_refresh() {
        // TS `mockRejectedValue("string error")` — message resolves to the
        // fallback text.
        let script = ExecScript::new(vec![ExecStep::Err(RefreshExecError {
            message: None,
            is_abort: false,
        })]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let result = queue.refresh("test-token").await;
        let failure = result.as_failure().expect("failed result");
        assert_eq!(failure.reason, Some(TokenFailureReason::NetworkError));
        assert_eq!(
            failure.message.as_deref(),
            Some("Unknown error during refresh")
        );
    }

    // ---- deduplication of concurrent requests ----

    #[tokio::test]
    async fn dedupes_concurrent_refresh_requests_for_the_same_token() {
        let gate = Arc::new(Semaphore::new(0));
        let mock = success("deduped-access", "deduped-refresh");
        let script = ExecScript::new(vec![ExecStep::Gated(Arc::clone(&gate), mock.clone())]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let task1 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("same-token").await }
        });
        let task2 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("same-token").await }
        });
        let task3 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("same-token").await }
        });
        yield_a_few_times().await;

        assert_eq!(script.calls(), 1);

        gate.add_permits(1);
        let (result1, result2, result3) = (
            task1.await.unwrap(),
            task2.await.unwrap(),
            task3.await.unwrap(),
        );

        assert_eq!(result1, result2);
        assert_eq!(result2, result3);
        assert_eq!(result1, mock);
        assert_eq!(script.calls(), 1);
    }

    #[tokio::test]
    async fn makes_separate_calls_for_different_tokens() {
        let mock = success("access", "refresh");
        let script = ExecScript::new(vec![
            ExecStep::Ok(mock.clone()),
            ExecStep::Ok(mock.clone()),
            ExecStep::Ok(mock.clone()),
        ]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let (r1, r2, r3) = tokio::join!(
            queue.refresh("token-1"),
            queue.refresh("token-2"),
            queue.refresh("token-3"),
        );
        assert_eq!(r1, mock);
        assert_eq!(r2, mock);
        assert_eq!(r3, mock);
        assert_eq!(script.calls(), 3);
    }

    #[tokio::test]
    async fn allows_new_refresh_after_previous_completes() {
        let mock = success("access", "refresh");
        let script = ExecScript::new(vec![ExecStep::Ok(mock.clone()), ExecStep::Ok(mock.clone())]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        queue.refresh("token").await;
        assert_eq!(script.calls(), 1);

        queue.refresh("token").await;
        assert_eq!(script.calls(), 2);
    }

    // ---- isRefreshing / pendingCount ----

    #[tokio::test]
    async fn is_refreshing_true_while_refresh_is_in_progress() {
        let gate = Arc::new(Semaphore::new(0));
        let script = ExecScript::new(vec![ExecStep::Gated(
            Arc::clone(&gate),
            success("access", "refresh"),
        )]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        assert!(!queue.is_refreshing("token"));

        let task = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("token").await }
        });
        yield_a_few_times().await;
        assert!(queue.is_refreshing("token"));

        gate.add_permits(1);
        task.await.unwrap();

        assert!(!queue.is_refreshing("token"));
    }

    #[tokio::test]
    async fn tracks_the_number_of_pending_refreshes() {
        let gate1 = Arc::new(Semaphore::new(0));
        let gate2 = Arc::new(Semaphore::new(0));
        let script = ExecScript::new(vec![
            ExecStep::Gated(Arc::clone(&gate1), success("access", "refresh")),
            ExecStep::Gated(Arc::clone(&gate2), success("access", "refresh")),
        ]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        assert_eq!(queue.pending_count(), 0);

        let task1 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("token-1").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);

        let task2 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("token-2").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 2);

        gate1.add_permits(1);
        task1.await.unwrap();
        assert_eq!(queue.pending_count(), 1);

        gate2.add_permits(1);
        task2.await.unwrap();
        assert_eq!(queue.pending_count(), 0);
    }

    // ---- stale entry cleanup ----

    #[tokio::test]
    async fn evicts_stale_acquire_stage_entries_and_allows_a_fresh_retry() {
        let coordinator = Arc::new(StickyFirstAcquireCoordinator::new(Some(
            DEFAULT_WAIT_TIMEOUT_MS,
        )));
        let mock = success("access", "refresh");
        let script = ExecScript::new(vec![ExecStep::Ok(mock.clone())]);
        let queue = RefreshQueue::with_parts(1_000, coordinator.clone(), script.executor());

        let _stuck = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("stale-acquire-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);

        // Acquire-stage entries are held until they exceed the lease wait
        // budget (35s) + slack (5s); age this one past that 40s threshold.
        rewind_entry(&queue, "stale-acquire-token", 41_000);

        let second_result = queue.refresh("stale-acquire-token").await;
        assert_eq!(second_result, mock);
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 2);
        assert_eq!(queue.pending_count(), 0);
    }

    #[tokio::test]
    async fn does_not_evict_acquire_entry_younger_than_the_lease_wait_budget() {
        // Regression: a lease acquire() can legitimately block up to
        // DEFAULT_WAIT_TIMEOUT_MS (35s), LONGER than the default maxEntryAgeMs
        // (30s). Evicting earlier spawns a duplicate refresh -> invalid_grant.
        let coordinator = Arc::new(StickyFirstAcquireCoordinator::new(Some(
            DEFAULT_WAIT_TIMEOUT_MS,
        )));
        let script = ExecScript::new(vec![ExecStep::Ok(success("a", "r"))]);
        let queue = RefreshQueue::with_parts(30_000, coordinator.clone(), script.executor());

        let _stuck = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("wait-budget-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 1);

        // Past maxEntryAgeMs (30s) but still within the lease wait budget:
        // the entry must survive; a concurrent refresh dedupes onto it.
        rewind_entry(&queue, "wait-budget-token", DEFAULT_WAIT_TIMEOUT_MS - 3_000);
        let _join = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("wait-budget-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 1);

        // Past the wait budget + slack: genuinely stuck, cleanup evicts, a
        // fresh acquire is allowed.
        rewind_entry(&queue, "wait-budget-token", 11_000);
        let _retry = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("wait-budget-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 2);

        queue.clear();
    }

    #[tokio::test]
    async fn sizes_acquire_eviction_off_the_configured_lease_wait_budget() {
        let configured_wait_ms = DEFAULT_WAIT_TIMEOUT_MS * 3;
        let coordinator = Arc::new(StickyFirstAcquireCoordinator::new(Some(configured_wait_ms)));
        let script = ExecScript::new(vec![ExecStep::Ok(success("a", "r"))]);
        let queue = RefreshQueue::with_parts(30_000, coordinator.clone(), script.executor());

        let _stuck = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("configured-wait-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 1);

        // 45s: past the DEFAULT budget + slack (40s) but well inside the
        // CONFIGURED budget — must survive and dedupe.
        rewind_entry(
            &queue,
            "configured-wait-token",
            DEFAULT_WAIT_TIMEOUT_MS + 10_000,
        );
        let _join = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("configured-wait-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 1);

        // 111s: past the CONFIGURED budget (105s) + slack — evicted.
        rewind_entry(
            &queue,
            "configured-wait-token",
            configured_wait_ms + 6_000 - (DEFAULT_WAIT_TIMEOUT_MS + 10_000),
        );
        let _retry = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("configured-wait-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 2);

        queue.clear();
    }

    #[tokio::test]
    async fn joins_a_superseding_generation_after_stale_acquire_eviction() {
        let acquire_gate = Arc::new(Semaphore::new(0));
        let coordinator = Arc::new(GatedFirstAcquireCoordinator {
            calls: AtomicU32::new(0),
            gate: Arc::clone(&acquire_gate),
        });
        let exec_gate = Arc::new(Semaphore::new(0));
        let superseded = success("access-after-supersede", "refresh-after-supersede");
        let script = ExecScript::new(vec![ExecStep::Gated(
            Arc::clone(&exec_gate),
            superseded.clone(),
        )]);
        let queue = RefreshQueue::with_parts(1_000, coordinator.clone(), script.executor());

        let first = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("superseded-acquire-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);

        // Past the acquire-stage eviction threshold (wait budget 35s + 5s
        // slack): the still-blocked first acquire is evicted and superseded.
        rewind_entry(&queue, "superseded-acquire-token", 41_000);
        let second = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("superseded-acquire-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 2);

        // Release the first (stale-generation) acquire: it must JOIN the
        // newer generation instead of running its own refresh.
        acquire_gate.add_permits(1);
        yield_a_few_times().await;
        assert_eq!(script.calls(), 1);

        exec_gate.add_permits(1);
        let first_result = first.await.unwrap();
        let second_result = second.await.unwrap();
        assert_eq!(first_result, superseded);
        assert_eq!(second_result, superseded);
        assert_eq!(script.calls(), 1);
        assert_eq!(queue.pending_count(), 0);
    }

    /// LeaseFs double that records every unlink (lock release). Reads report
    /// NotFound so `owns_lock` treats the lock as still ours and unlinks it.
    struct RecordingLeaseFs {
        unlinks: StdMutex<Vec<std::path::PathBuf>>,
    }

    impl RecordingLeaseFs {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                unlinks: StdMutex::new(Vec::new()),
            })
        }

        fn unlinked(&self, suffix: &str) -> bool {
            self.unlinks
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.to_string_lossy().ends_with(suffix))
        }
    }

    impl LeaseFs for RecordingLeaseFs {
        fn mkdir_recursive(&self, _dir: &Path, _mode: u32) -> io::Result<()> {
            Ok(())
        }
        fn chmod(&self, _path: &Path, _mode: u32) -> io::Result<()> {
            Ok(())
        }
        fn open_excl_write(&self, _path: &Path, _contents: &str, _mode: u32) -> io::Result<()> {
            Ok(())
        }
        fn write_file(&self, _path: &Path, _contents: &str, _mode: u32) -> io::Result<()> {
            Ok(())
        }
        fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
            Ok(())
        }
        fn unlink(&self, path: &Path) -> io::Result<()> {
            self.unlinks.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
        fn read_to_string(&self, _path: &Path) -> io::Result<String> {
            Err(io::Error::from(io::ErrorKind::NotFound))
        }
        fn mtime_ms(&self, _path: &Path) -> io::Result<f64> {
            Err(io::Error::from(io::ErrorKind::NotFound))
        }
        fn read_dir_files(&self, _dir: &Path) -> io::Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    /// Like [`GatedFirstAcquireCoordinator`] but resolves to OWNER handles
    /// over a [`RecordingLeaseFs`], so lock release timing is observable
    /// (`lock-0` for the first acquire, `lock-1` for the second, …).
    struct GatedOwnerCoordinator {
        calls: AtomicU32,
        gate: Arc<Semaphore>,
        fs: Arc<RecordingLeaseFs>,
    }

    impl LeaseCoordinatorApi for GatedOwnerCoordinator {
        fn acquire<'a>(
            &'a self,
            _refresh_token: &'a str,
        ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let gate = Arc::clone(&self.gate);
            let fs: Arc<dyn LeaseFs> = Arc::clone(&self.fs) as Arc<dyn LeaseFs>;
            async move {
                if call == 0 {
                    let permit = gate.acquire().await.expect("gate closed");
                    permit.forget();
                }
                Ok(RefreshLeaseHandle::owner(
                    format!("hash-{call}"),
                    std::path::PathBuf::from(format!("/lease/lock-{call}")),
                    std::path::PathBuf::from(format!("/lease/result-{call}")),
                    format!("nonce-{call}"),
                    fs,
                ))
            }
            .boxed()
        }
        fn configured_wait_timeout_ms(&self) -> Option<i64> {
            Some(DEFAULT_WAIT_TIMEOUT_MS)
        }
    }

    /// Finding: superseded lease owner must release the on-disk lock BEFORE
    /// awaiting the newer generation's refresh (TS finally-before-adoption),
    /// not after — otherwise the successor polls a live lock for its whole
    /// wait budget and falls back to an unprotected bypass refresh.
    #[tokio::test]
    async fn superseded_owner_releases_the_lease_before_awaiting_the_newer_generation() {
        let acquire_gate = Arc::new(Semaphore::new(0));
        let fs = RecordingLeaseFs::new();
        let coordinator = Arc::new(GatedOwnerCoordinator {
            calls: AtomicU32::new(0),
            gate: Arc::clone(&acquire_gate),
            fs: Arc::clone(&fs),
        });
        let exec_gate = Arc::new(Semaphore::new(0));
        let superseded = success("access-after-supersede", "refresh-after-supersede");
        let script = ExecScript::new(vec![ExecStep::Gated(
            Arc::clone(&exec_gate),
            superseded.clone(),
        )]);
        let queue = RefreshQueue::with_parts(1_000, coordinator.clone(), script.executor());

        // First (stale) generation: acquire blocks on the gate.
        let first = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("release-order-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);

        // Evict the acquire-stage entry, then start the superseding
        // generation, whose refresh parks on the exec gate as lock-1 OWNER.
        rewind_entry(&queue, "release-order-token", 41_000);
        let second = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("release-order-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(coordinator.calls.load(Ordering::SeqCst), 2);
        assert_eq!(script.calls(), 1, "superseding refresh in flight");

        // Unblock the stale acquire: it resolves as lock-0 OWNER, discovers
        // it was superseded, and must unlink lock-0 IMMEDIATELY — while the
        // superseding refresh is still gated (not yet completed).
        acquire_gate.add_permits(1);
        yield_a_few_times().await;
        assert!(
            fs.unlinked("lock-0"),
            "stale owner must release its lock BEFORE the superseding refresh completes; unlinks: {:?}",
            fs.unlinks.lock().unwrap()
        );
        assert!(
            !fs.unlinked("lock-1"),
            "superseding owner still holds its lock while refreshing"
        );

        exec_gate.add_permits(1);
        assert_eq!(first.await.unwrap(), superseded);
        assert_eq!(second.await.unwrap(), superseded);
        assert_eq!(script.calls(), 1);
        assert!(fs.unlinked("lock-1"), "superseding owner releases at the end");
        assert_eq!(queue.pending_count(), 0);
    }

    /// Finding: the refresh body must run EAGERLY to completion (TS async
    /// IIFE) even when the creating caller is dropped mid-refresh (client
    /// disconnect). A lazily polled Shared future would suspend the OAuth
    /// exchange, leave the pending entry wedged at stage=Refresh forever
    /// (cleanup never evicts refresh-stage entries), and serve every later
    /// caller a stale cached "Refresh timeout" failure.
    #[tokio::test]
    async fn refresh_body_completes_and_cleans_up_when_the_creating_caller_is_dropped() {
        let exec_gate = Arc::new(Semaphore::new(0));
        let rotated = success("access-after-drop", "rotated-refresh-token");
        let fresh = success("access-fresh", "fresh-refresh-token");
        let script = ExecScript::new(vec![
            ExecStep::Gated(Arc::clone(&exec_gate), rotated.clone()),
            ExecStep::Ok(fresh.clone()),
        ]);
        let queue =
            RefreshQueue::with_parts(1_000, Arc::new(BypassCoordinator), script.executor());

        let creator = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("dropped-caller-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);
        assert_eq!(script.calls(), 1, "refresh POST already sent");

        // Client disconnect: the sole awaiter is dropped mid-refresh.
        creator.abort();
        let _ = creator.await;

        // The detached body still processes the upstream response and the
        // spawned wrapper runs the TS-`finally` cleanup.
        exec_gate.add_permits(1);
        for _ in 0..200 {
            if queue.pending_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            queue.pending_count(),
            0,
            "pending entry removed even though the creator died"
        );

        // A later caller performs a FRESH refresh (executor called again)
        // instead of joining a wedged future / stale cached failure.
        let second = queue.refresh("dropped-caller-token").await;
        assert_eq!(second, fresh);
        assert_eq!(script.calls(), 2);
    }

    #[tokio::test]
    async fn times_out_stale_unresolved_entries_and_allows_retry() {
        // Real-time test: maxEntryAgeMs 1000 ⇒ the stuck first call times out
        // after ~1 s (tokio's test-util paused clock is not enabled in this
        // workspace).
        let successful = success("access", "refresh");
        let script = ExecScript::new(vec![ExecStep::Pending, ExecStep::Ok(successful.clone())]);
        let queue = RefreshQueue::with_parts(1_000, Arc::new(BypassCoordinator), script.executor());

        let first_result = queue.refresh("stuck-token").await;
        let failure = first_result.as_failure().expect("failed result");
        assert_eq!(failure.reason, Some(TokenFailureReason::Unknown));
        assert!(
            failure
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("Refresh timeout after"),
            "{:?}",
            failure.message
        );
        assert_eq!(queue.pending_count(), 0);

        let second_result = queue.refresh("stuck-token").await;
        assert_eq!(second_result, successful);
        assert_eq!(script.calls(), 2);
    }

    #[tokio::test]
    async fn recovers_after_a_429_response_and_retries_cleanly() {
        let rate_limited = failed(TokenFailureReason::HttpError, Some(429), Some("Rate limited"));
        let successful = success("access-after-429", "refresh-after-429");
        let script = ExecScript::new(vec![
            ExecStep::Ok(rate_limited.clone()),
            ExecStep::Ok(successful.clone()),
        ]);
        let queue = RefreshQueue::with_parts(1_000, Arc::new(BypassCoordinator), script.executor());

        let first_result = queue.refresh("rate-limited-token").await;
        assert_eq!(first_result, rate_limited);
        assert_eq!(queue.pending_count(), 0);

        let second_result = queue.refresh("rate-limited-token").await;
        assert_eq!(second_result, successful);
        assert_eq!(script.calls(), 2);
    }

    #[tokio::test]
    async fn keeps_dedupe_for_same_token_before_timeout_elapses() {
        let gate = Arc::new(Semaphore::new(0));
        let script = ExecScript::new(vec![ExecStep::Gated(Arc::clone(&gate), success("a", "r"))]);
        let queue = RefreshQueue::with_parts(1_000, Arc::new(BypassCoordinator), script.executor());

        let task1 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("same-token").await }
        });
        let task2 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("same-token").await }
        });
        yield_a_few_times().await;

        assert_eq!(script.calls(), 1);
        assert_eq!(queue.pending_count(), 1);

        gate.add_permits(1);
        let (r1, r2) = (task1.await.unwrap(), task2.await.unwrap());
        assert_eq!(r1, r2);
        assert_eq!(queue.pending_count(), 0);
    }

    #[tokio::test]
    async fn logs_stale_refresh_stage_warnings_only_once_per_entry() {
        let script = ExecScript::new(vec![
            ExecStep::Ok(success("a", "r")),
            ExecStep::Ok(success("a", "r")),
        ]);
        let queue = RefreshQueue::with_parts(1_000, Arc::new(BypassCoordinator), script.executor());

        // Inject a stale refresh-stage entry directly (the TS test reaches
        // into the private map the same way).
        {
            let mut state = queue.inner.lock();
            let never: SharedRefresh = std::future::pending::<TokenResult>().boxed().shared();
            state.pending.insert(
                "stale-refresh-token".to_string(),
                RefreshEntry {
                    future: never,
                    started_at: now_ms() - 5_000,
                    stage: Stage::Refresh,
                    generation: 1,
                    stale_warning_logged: false,
                },
            );
        }

        queue.refresh("fresh-token-1").await;
        // After the first cleanup the warning flag is set (warned once)…
        assert!(
            queue
                .inner
                .lock()
                .pending
                .get("stale-refresh-token")
                .expect("refresh-stage entries are never evicted")
                .stale_warning_logged
        );

        queue.refresh("fresh-token-2").await;
        // …and the entry is STILL present (refresh-stage is never evicted)
        // with the flag still set — the second cleanup does not re-warn.
        assert!(
            queue
                .inner
                .lock()
                .pending
                .get("stale-refresh-token")
                .expect("still present")
                .stale_warning_logged
        );
        queue.clear();
    }

    // ---- singleton functions ----

    #[tokio::test]
    #[serial_test::serial(env)]
    async fn get_refresh_queue_returns_singleton_instance() {
        let _sandbox = cma_testkit::sandbox::EnvSandbox::new();
        reset_refresh_queue();
        let queue1 = get_refresh_queue(None);
        let queue2 = get_refresh_queue(None);
        assert!(Arc::ptr_eq(&queue1.inner, &queue2.inner));
        reset_refresh_queue();
    }

    #[tokio::test]
    #[serial_test::serial(env)]
    async fn reset_refresh_queue_clears_the_singleton() {
        let _sandbox = cma_testkit::sandbox::EnvSandbox::new();
        reset_refresh_queue();
        let queue1 = get_refresh_queue(None);
        reset_refresh_queue();
        let queue2 = get_refresh_queue(None);
        assert!(!Arc::ptr_eq(&queue1.inner, &queue2.inner));
        reset_refresh_queue();
    }

    // ---- clear ----

    #[tokio::test]
    async fn clear_removes_all_pending_entries() {
        let script = ExecScript::new(vec![ExecStep::Pending, ExecStep::Pending]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let _t1 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("token-1").await }
        });
        let _t2 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("token-2").await }
        });
        yield_a_few_times().await;

        assert_eq!(queue.pending_count(), 2);

        queue.clear();

        assert_eq!(queue.pending_count(), 0);
    }

    // ---- token rotation handling ----

    #[tokio::test]
    async fn tracks_token_rotation_when_refresh_returns_different_token() {
        let mock = success("access", "new-rotated-token");
        let script = ExecScript::new(vec![ExecStep::Ok(mock.clone())]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let result = queue.refresh("old-token").await;
        let refreshed = result.as_success().expect("success");
        assert_eq!(refreshed.refresh, "new-rotated-token");
    }

    #[tokio::test]
    async fn reuses_pending_refresh_when_request_arrives_with_rotated_token() {
        let gate = Arc::new(Semaphore::new(0));
        let script = ExecScript::new(vec![ExecStep::Gated(
            Arc::clone(&gate),
            success("access", "new-rotated-token"),
        )]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let task1 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("old-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);

        // Simulate a rotation recorded while the refresh is still in flight
        // (the TS test seeds the private map the same way).
        queue
            .inner
            .lock()
            .token_rotation_map
            .push(("old-token".to_string(), "new-rotated-token".to_string()));

        let task2 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("new-rotated-token").await }
        });
        yield_a_few_times().await;

        assert_eq!(script.calls(), 1);

        gate.add_permits(1);
        let (result1, result2) = (task1.await.unwrap(), task2.await.unwrap());
        assert_eq!(result1, result2);
    }

    #[tokio::test]
    async fn finds_original_token_via_rotation_map_and_reuses_pending_entry() {
        let gate = Arc::new(Semaphore::new(0));
        let script = ExecScript::new(vec![ExecStep::Gated(
            Arc::clone(&gate),
            success("access", "rotated-token"),
        )]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        let task1 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("original-token").await }
        });
        yield_a_few_times().await;
        assert_eq!(queue.pending_count(), 1);

        {
            let mut state = queue.inner.lock();
            state
                .token_rotation_map
                .push(("unrelated-token".to_string(), "some-other-token".to_string()));
            state
                .token_rotation_map
                .push(("original-token".to_string(), "rotated-token".to_string()));
        }

        let task2 = tokio::spawn({
            let queue = queue.clone();
            async move { queue.refresh("rotated-token").await }
        });
        yield_a_few_times().await;

        assert_eq!(script.calls(), 1);
        assert_eq!(
            script.last_token.lock().unwrap().as_deref(),
            Some("original-token")
        );

        gate.add_permits(1);
        let (result1, result2) = (task1.await.unwrap(), task2.await.unwrap());
        assert_eq!(result1, result2);
    }

    #[tokio::test]
    async fn cleans_up_rotation_mapping_after_refresh_completes() {
        let script = ExecScript::new(vec![
            ExecStep::Ok(success("access", "new-rotated-token")),
            ExecStep::Ok(success("access2", "another-token")),
        ]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        queue.refresh("old-token").await;
        assert_eq!(queue.pending_count(), 0);
        // Mapping cleaned on completion: refreshing with the rotated token
        // triggers a NEW refresh call, not a stale join.
        queue.refresh("new-rotated-token").await;
        assert_eq!(script.calls(), 2);
    }

    #[tokio::test]
    async fn cleans_up_rotation_entries_pointing_to_the_completed_token() {
        let script = ExecScript::new(vec![ExecStep::Ok(success("access", "token-b"))]);
        let queue =
            RefreshQueue::with_parts(30_000, Arc::new(BypassCoordinator), script.executor());

        {
            let mut state = queue.inner.lock();
            state
                .token_rotation_map
                .push(("token-a".to_string(), "token-b".to_string()));
            state
                .token_rotation_map
                .push(("token-c".to_string(), "token-b".to_string()));
        }

        queue.refresh("token-b").await;

        let state = queue.inner.lock();
        assert!(
            !state
                .token_rotation_map
                .iter()
                .any(|(old, _)| old == "token-a" || old == "token-c")
        );
    }

    // ---- cross-process lease dedupe ----

    #[tokio::test]
    async fn reuses_refresh_result_across_queue_instances_via_lease_files() {
        let lease_dir = tempfile::Builder::new()
            .prefix("codex-refresh-lease-int-")
            .tempdir()
            .unwrap();
        let lease_options = |dir: &Path| RefreshLeaseCoordinatorOptions {
            enabled: Some(true),
            lease_dir: Some(dir.to_path_buf()),
            lease_ttl_ms: Some(5_000),
            wait_timeout_ms: Some(2_000),
            poll_interval_ms: Some(25),
            result_ttl_ms: Some(5_000),
            ..Default::default()
        };
        let lease_a = Arc::new(RefreshLeaseCoordinator::new(lease_options(lease_dir.path())));
        let lease_b = Arc::new(RefreshLeaseCoordinator::new(lease_options(lease_dir.path())));

        let delayed_result = success("shared-access", "shared-refresh-next");
        let gate = Arc::new(Semaphore::new(0));
        let script = ExecScript::new(vec![ExecStep::Gated(
            Arc::clone(&gate),
            delayed_result.clone(),
        )]);
        let executor = script.executor();
        let queue_a = RefreshQueue::with_parts(30_000, lease_a, executor.clone());
        let queue_b = RefreshQueue::with_parts(30_000, lease_b, executor);

        let owner_task = tokio::spawn(async move { queue_a.refresh("same-cross-token").await });
        // Wait until the owner has actually invoked the executor (holding the
        // on-disk lease lock) before the follower starts.
        for _ in 0..200 {
            if script.calls() >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(script.calls(), 1);
        let follower_task = tokio::spawn(async move { queue_b.refresh("same-cross-token").await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        gate.add_permits(1);

        let owner_result = owner_task.await.unwrap();
        let follower_result = follower_task.await.unwrap();
        assert_eq!(owner_result, delayed_result);
        assert_eq!(follower_result, delayed_result);
        assert_eq!(script.calls(), 1);
    }

    // ---- lease failure handling ----

    #[tokio::test]
    async fn falls_back_to_local_refresh_when_lease_acquisition_throws() {
        let mock = success("fallback-access", "fallback-refresh");
        let script = ExecScript::new(vec![ExecStep::Ok(mock.clone())]);
        let queue = RefreshQueue::with_parts(
            30_000,
            Arc::new(FailingAcquireCoordinator),
            script.executor(),
        );

        let result = queue.refresh("token-with-acquire-error").await;

        assert_eq!(result, mock);
        assert_eq!(script.calls(), 1);
    }

    /// LeaseFs whose result-file writes fail (publish errors) and whose
    /// unlinks fail non-retryably (unlock errors) — release() error paths.
    struct FailingReleaseFs;

    impl LeaseFs for FailingReleaseFs {
        fn mkdir_recursive(&self, _dir: &Path, _mode: u32) -> io::Result<()> {
            Ok(())
        }
        fn chmod(&self, _path: &Path, _mode: u32) -> io::Result<()> {
            Ok(())
        }
        fn open_excl_write(&self, _path: &Path, _contents: &str, _mode: u32) -> io::Result<()> {
            Ok(())
        }
        fn write_file(&self, _path: &Path, _contents: &str, _mode: u32) -> io::Result<()> {
            Err(cma_core::fs_retry::io_error_with_code("EIO", "publish failed"))
        }
        fn rename(&self, _from: &Path, _to: &Path) -> io::Result<()> {
            Err(cma_core::fs_retry::io_error_with_code("EIO", "publish failed"))
        }
        fn unlink(&self, _path: &Path) -> io::Result<()> {
            Err(cma_core::fs_retry::io_error_with_code("EINVAL", "unlock failed"))
        }
        fn read_to_string(&self, _path: &Path) -> io::Result<String> {
            Err(cma_core::fs_retry::io_error_with_code("ENOENT", "missing"))
        }
        fn mtime_ms(&self, _path: &Path) -> io::Result<f64> {
            Err(cma_core::fs_retry::io_error_with_code("ENOENT", "missing"))
        }
        fn read_dir_files(&self, _dir: &Path) -> io::Result<Vec<String>> {
            Ok(Vec::new())
        }
    }

    /// Coordinator yielding an OWNER handle whose release() publish fails.
    struct FailingReleaseOwnerCoordinator;

    impl LeaseCoordinatorApi for FailingReleaseOwnerCoordinator {
        fn acquire<'a>(
            &'a self,
            refresh_token: &'a str,
        ) -> BoxFuture<'a, io::Result<RefreshLeaseHandle>> {
            let token = refresh_token.to_string();
            async move {
                let digest = Sha256::digest(token.as_bytes());
                let hash: String = digest.iter().map(|b| format!("{b:02x}")).collect();
                Ok(RefreshLeaseHandle::owner(
                    hash.clone(),
                    std::env::temp_dir().join(format!("{hash}.lock")),
                    std::env::temp_dir().join(format!("{hash}.result.json")),
                    "nonce".to_string(),
                    Arc::new(FailingReleaseFs),
                ))
            }
            .boxed()
        }
        fn configured_wait_timeout_ms(&self) -> Option<i64> {
            Some(DEFAULT_WAIT_TIMEOUT_MS)
        }
    }

    #[tokio::test]
    async fn swallows_lease_release_errors_and_still_returns_token_result() {
        let mock = success("release-safe-access", "release-safe-refresh");
        let script = ExecScript::new(vec![ExecStep::Ok(mock.clone())]);
        let queue = RefreshQueue::with_parts(
            30_000,
            Arc::new(FailingReleaseOwnerCoordinator),
            script.executor(),
        );

        let result = queue.refresh("token-with-release-error").await;

        assert_eq!(result, mock);
        assert_eq!(script.calls(), 1);
    }

    // ---- fingerprint ----

    #[test]
    fn token_fingerprint_is_a_short_hash_prefix_never_the_token() {
        assert_eq!(token_fingerprint(""), "none");
        let fp = token_fingerprint("super-secret-refresh-token");
        assert_eq!(fp.len(), 8);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!"super-secret-refresh-token".contains(&fp));
    }
}
