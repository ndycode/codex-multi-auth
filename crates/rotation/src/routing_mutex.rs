//! Port of `lib/routing-mutex.ts` (PR-N / R4) — in-memory, in-process async
//! mutex serializing cursor-mutation sites in the rotation pipeline.
//!
//! Concurrency background: the legacy rotation path reads `activeIndex` /
//! `activeIndexByFamily`, picks a candidate, and writes the cursor back
//! without any lock; two simultaneous requests can observe the same cursor,
//! both rotate to the same candidate, and race on `markSwitched` /
//! `markAccountCoolingDown` ("lost update"). Gated behind
//! `PluginConfig.routingMutex = "legacy" | "enabled"` (default `"legacy"`).
//!
//! Rust mapping (ARCHITECTURE §5.4):
//! - TS promise-chain FIFO mutex → [`tokio::sync::Mutex`] (fair FIFO queue).
//!   A task's own error propagates through its returned value; a failed
//!   critical section can never poison waiters (the guard drops either way).
//! - TS `AsyncLocalStorage<true>` reentrancy guard → `tokio::task_local!`
//!   flag scoped around the critical-section future. The underlying mutex is
//!   strictly non-reentrant: a section that re-entered `with_routing_mutex`
//!   without the flag would enqueue behind itself and deadlock, hence nested
//!   calls run inline (spec 04 gotcha 6 — the proxy's enabled-mode
//!   select+commit depends on this).
//! - The task-local flag does NOT cross `tokio::spawn`: a spawned task inside
//!   a held section starts un-held and would re-acquire. Any spawn inside a
//!   scoped region must re-wrap explicitly.
//!
//! Non-goal (verbatim from TS): no cross-process coordination — the pool
//! manager is a process singleton.

use std::future::Future;
use std::sync::LazyLock;

use tokio::sync::Mutex;

pub use cma_core::schemas::account_storage::SwitchReason;

/// `RoutingMutexMode = "enabled" | "legacy"`. Config-side default is
/// `"legacy"` (env `CODEX_AUTH_ROUTING_MUTEX`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum RoutingMutexMode {
    /// Serialize every cursor-mutation critical section through the mutex.
    Enabled,
    /// Run inline with no lock and no allocation (zero behaviour change).
    #[default]
    Legacy,
}

impl RoutingMutexMode {
    /// The config-file string form.
    pub fn as_str(&self) -> &'static str {
        match self {
            RoutingMutexMode::Enabled => "enabled",
            RoutingMutexMode::Legacy => "legacy",
        }
    }

    /// Parse the config-file string form; unknown values yield `None`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "enabled" => Some(RoutingMutexMode::Enabled),
            "legacy" => Some(RoutingMutexMode::Legacy),
            _ => None,
        }
    }
}

impl std::fmt::Display for RoutingMutexMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Single selection decision emitted by the rotation pipeline.
///
/// Threaded through the fetch loop so downstream consumers (observability,
/// why-selected trace, failure-policy telemetry) can inspect *why* a
/// particular account was picked for a given request without recomputing
/// scores. All fields are optional except the core identity + reason +
/// timestamp so the record can be produced from both the legacy fast-path
/// and the full scoring path.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionRecord {
    /// Index of the selected account inside the managed pool.
    pub account_index: usize,
    /// Stable account identifier (accountId, email, or runtime key).
    pub account_id: String,
    /// Coarse-grained classification of why this account was selected
    /// (`"initial" | "rotation" | "rate-limit" | "best" | "restore" | "manual"`).
    pub reason: SwitchReason,
    /// Wall-clock timestamp (ms since epoch) when the decision was made.
    pub timestamp: i64,
    /// Quota tracker key (e.g. `"codex"` or `"codex:gpt-5-codex"`) when scoped.
    pub tracker_key_quota: Option<String>,
    /// Health score (0-100) used when ranking candidates.
    pub health: Option<f64>,
    /// Token bucket remaining count used when ranking candidates.
    pub tokens: Option<f64>,
    /// Final hybrid score used during selection.
    pub score: Option<f64>,
}

/// Lazy singleton mutex for rotation critical sections (TS
/// `getRoutingMutex()`); state fully resets whenever unlocked, so no
/// test-reset hook is needed.
static ROUTING_MUTEX: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

tokio::task_local! {
    /// Reentrancy guard: `true` while executing inside a held
    /// `with_routing_mutex(Enabled, …)` section in the same async context
    /// (mirrors `routingMutexHeldContext` / `isStorageLockHeld`).
    static ROUTING_MUTEX_HELD: bool;
}

/// Reports whether the caller is already running inside a
/// [`with_routing_mutex`] critical section (in `Enabled` mode). Callers that
/// may run both standalone and nested under a held mutex use this to avoid
/// re-acquiring and deadlocking.
pub fn is_routing_mutex_held() -> bool {
    ROUTING_MUTEX_HELD.try_with(|held| *held).unwrap_or(false)
}

/// Run `f` under the routing mutex when `mode == Enabled`, otherwise run it
/// inline. Hot-path helper used by account-pool mutation sites so the flag
/// check stays O(1) per call.
///
/// Reentrant: if the caller is already inside a held section
/// ([`is_routing_mutex_held`] is `true`), `f` runs inline rather than
/// re-acquiring the non-reentrant FIFO queue, which would otherwise deadlock.
/// When the lock is acquired, `f`'s future runs inside the held-context scope
/// so any nested `with_routing_mutex` calls it makes are detected as
/// reentrant. Errors propagate through `T` (e.g. a `Result`); the mutex is
/// released either way.
pub async fn with_routing_mutex<F, Fut, T>(mode: RoutingMutexMode, f: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    match mode {
        RoutingMutexMode::Enabled => {
            if is_routing_mutex_held() {
                // Already inside the critical section for this async context:
                // run inline so we don't enqueue behind ourselves and deadlock.
                return f().await;
            }
            let _guard = ROUTING_MUTEX.lock().await;
            ROUTING_MUTEX_HELD.scope(true, f()).await
        }
        RoutingMutexMode::Legacy => f().await,
    }
}

// ============================================================================
// Tests (ported from test/routing-mutex.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    fn push(events: &Arc<StdMutex<Vec<String>>>, event: &str) {
        events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event.to_string());
    }

    #[tokio::test]
    async fn enabled_mode_serializes_concurrent_tasks_fifo() {
        let events: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));

        let make_task = |name: &'static str, delay_ms: u64| {
            let events = events.clone();
            with_routing_mutex(RoutingMutexMode::Enabled, move || async move {
                push(&events, &format!("{name}:start"));
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                push(&events, &format!("{name}:end"));
                name
            })
        };

        // join! polls in order on the current-thread runtime, so the fair
        // FIFO mutex admits A, then B, then C — mirroring the TS chain.
        let (a, b, c) = tokio::join!(make_task("A", 10), make_task("B", 5), make_task("C", 1));

        let recorded = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(
            recorded,
            vec!["A:start", "A:end", "B:start", "B:end", "C:start", "C:end"]
        );
        assert_eq!((a, b, c), ("A", "B", "C"));
    }

    #[tokio::test]
    async fn propagates_errors_but_keeps_the_mutex_alive() {
        let failing: Result<(), String> =
            with_routing_mutex(RoutingMutexMode::Enabled, || async {
                Err("boom".to_string())
            })
            .await;
        assert_eq!(failing, Err("boom".to_string()));

        // A failed section must not poison later waiters.
        let recovered = with_routing_mutex(RoutingMutexMode::Enabled, || async { "ok" }).await;
        assert_eq!(recovered, "ok");
        assert!(!is_routing_mutex_held());
    }

    #[tokio::test]
    async fn legacy_mode_runs_inline_without_entering_the_mutex() {
        let (result, held_inside) = with_routing_mutex(RoutingMutexMode::Legacy, || async {
            ("legacy-result", is_routing_mutex_held())
        })
        .await;
        assert_eq!(result, "legacy-result");
        // Inline execution must not flip the held flag.
        assert!(!held_inside);
    }

    #[tokio::test]
    async fn enabled_mode_routes_through_the_shared_mutex() {
        let held_inside = with_routing_mutex(RoutingMutexMode::Enabled, || async {
            is_routing_mutex_held()
        })
        .await;
        assert!(held_inside);
        assert!(!is_routing_mutex_held());
    }

    #[tokio::test]
    async fn enabled_mode_is_reentrant_within_a_held_section() {
        // A nested acquisition inside the held section must run inline
        // (re-enqueueing behind ourselves would deadlock — 5 s timeout guard).
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            with_routing_mutex(RoutingMutexMode::Enabled, || async {
                assert!(is_routing_mutex_held());
                let inner = with_routing_mutex(RoutingMutexMode::Enabled, || async {
                    is_routing_mutex_held()
                })
                .await;
                assert!(inner);
                42
            }),
        )
        .await
        .expect("nested with_routing_mutex deadlocked");
        assert_eq!(result, 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn enabled_mode_serializes_spawned_callers_without_interleaving() {
        let events: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let mut handles = Vec::new();
        for name in ["a", "b", "c", "d"] {
            let events = events.clone();
            handles.push(tokio::spawn(async move {
                with_routing_mutex(RoutingMutexMode::Enabled, move || async move {
                    push(&events, &format!("{name}:in"));
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    push(&events, &format!("{name}:out"));
                })
                .await;
            }));
        }
        for handle in handles {
            handle.await.expect("task panicked");
        }

        // No interleaving: every in/out pair must be contiguous.
        let order = events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(order.len(), 8);
        for pair in order.chunks(2) {
            let label = pair[0].split(':').next().unwrap();
            assert_eq!(pair[0], format!("{label}:in"));
            assert_eq!(pair[1], format!("{label}:out"));
        }
    }

    #[test]
    fn selection_record_accepts_minimum_and_full_payloads() {
        let minimal = SelectionRecord {
            account_index: 2,
            account_id: "acct_123".to_string(),
            reason: SwitchReason::Rotation,
            timestamp: cma_core::utils::now_ms(),
            tracker_key_quota: None,
            health: None,
            tokens: None,
            score: None,
        };
        assert_eq!(minimal.account_index, 2);
        assert_eq!(minimal.reason.as_str(), "rotation");

        let full = SelectionRecord {
            account_index: 0,
            account_id: "acct_0".to_string(),
            reason: SwitchReason::Best,
            timestamp: 1_700_000_000_000,
            tracker_key_quota: Some("codex:gpt-5-codex".to_string()),
            health: Some(93.0),
            tokens: Some(48.0),
            score: Some(512.0),
        };
        assert_eq!(full.tracker_key_quota.as_deref(), Some("codex:gpt-5-codex"));
        assert_eq!(full.score, Some(512.0));
    }

    #[test]
    fn routing_mutex_mode_parses_and_defaults_to_legacy() {
        assert_eq!(RoutingMutexMode::default(), RoutingMutexMode::Legacy);
        assert_eq!(
            RoutingMutexMode::parse("enabled"),
            Some(RoutingMutexMode::Enabled)
        );
        assert_eq!(
            RoutingMutexMode::parse("legacy"),
            Some(RoutingMutexMode::Legacy)
        );
        assert_eq!(RoutingMutexMode::parse("bogus"), None);
        assert_eq!(RoutingMutexMode::Enabled.as_str(), "enabled");
    }
}
