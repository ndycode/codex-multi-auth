//! Port of `lib/parallel-probe.ts` — candidate ranking by hybrid score plus
//! a first-success-wins parallel probe race.
//!
//! Contracts (spec 05 §7 + gotchas 16/17):
//! - Ranking score = `health * 2 + tokens * 5 + hoursSinceUsed * 2.0` over
//!   the singleton trackers (untracked accounts score at the tracker maxima).
//! - `get_top_candidates` MUTATES its snapshot accounts:
//!   `clear_expired_rate_limits` prunes expired windows before availability
//!   checks. (In TS the snapshot shared `rateLimitResetTimes` with the live
//!   pool so the pruning leaked back; the Rust snapshot is a deep clone, so
//!   the pruning stays local — behavior-neutral, the live pool lazily prunes
//!   on its own reads.)
//! - `probe_accounts_in_parallel` IGNORES its options parameter (declared
//!   for API compatibility). Single-candidate failures return a `Failure`
//!   result; multi-candidate all-fail returns `None` — asymmetric by design.
//! - On a win every OTHER candidate's controller is aborted (compared by
//!   `account.index`) and late results are ignored.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use cma_accounts::manager::{AccountManager, ManagedAccount, get_runtime_tracker_key};
use cma_accounts::rate_limits::{
    clear_expired_rate_limits, get_quota_key, is_rate_limited_for_family,
};
use cma_core::logger::create_logger;
use cma_core::model_family::ModelFamily;
use cma_core::utils::now_ms;
use cma_request::headers::ArgError;
use cma_rotation::trackers::{get_health_tracker, get_token_tracker};
use futures::StreamExt;
use futures::stream::FuturesUnordered;

/// AbortController analogue for probe candidates (`tokio`-native; no
/// `tokio-util` dependency in this crate).
#[derive(Clone, Debug, Default)]
pub struct ProbeAbortController {
    inner: Arc<AbortInner>,
}

#[derive(Debug, Default)]
struct AbortInner {
    aborted: AtomicBool,
    notify: tokio::sync::Notify,
}

impl ProbeAbortController {
    pub fn new() -> Self {
        Self::default()
    }

    /// Signal abort to every clone/signal of this controller.
    pub fn abort(&self) {
        self.inner.aborted.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.inner.aborted.load(Ordering::SeqCst)
    }

    /// The `AbortSignal` half handed to probe functions.
    pub fn signal(&self) -> ProbeAbortSignal {
        ProbeAbortSignal {
            inner: Arc::clone(&self.inner),
        }
    }
}

/// AbortSignal analogue — poll [`Self::is_aborted`] or await
/// [`Self::cancelled`].
#[derive(Clone, Debug)]
pub struct ProbeAbortSignal {
    inner: Arc<AbortInner>,
}

impl ProbeAbortSignal {
    pub fn is_aborted(&self) -> bool {
        self.inner.aborted.load(Ordering::SeqCst)
    }

    /// Resolves once the owning controller aborts (immediately when already
    /// aborted).
    pub async fn cancelled(&self) {
        loop {
            if self.is_aborted() {
                return;
            }
            let notified = self.inner.notify.notified();
            if self.is_aborted() {
                return;
            }
            notified.await;
        }
    }
}

/// TS `ProbeCandidate` — one account with a fresh abort controller.
#[derive(Clone, Debug)]
pub struct ProbeCandidate {
    pub account: ManagedAccount,
    pub controller: ProbeAbortController,
}

/// TS `ProbeResult<T>` — the `type: "success" | "failure"` union as an enum.
#[derive(Debug)]
pub enum ProbeResult<T, E> {
    Success {
        account: ManagedAccount,
        response: T,
    },
    Failure {
        account: ManagedAccount,
        error: E,
    },
}

impl<T, E> ProbeResult<T, E> {
    pub fn account(&self) -> &ManagedAccount {
        match self {
            ProbeResult::Success { account, .. } | ProbeResult::Failure { account, .. } => account,
        }
    }

    pub fn is_success(&self) -> bool {
        matches!(self, ProbeResult::Success { .. })
    }
}

/// TS `ParallelProbeOptions` — **declared but unused**:
/// `probe_accounts_in_parallel` ignores it (no concurrency cap, no timeout).
/// Kept for API compatibility.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ParallelProbeOptions {
    pub max_concurrency: usize,
    pub timeout_ms: u64,
}

/// TS `getTopCandidates` — top-N candidates ranked by hybrid score WITHOUT
/// mutating AccountManager state (beyond the snapshot materialization).
///
/// The TS dual-call overload collapses into one typed signature; the
/// `accountManager`/`modelFamily` TypeErrors are unrepresentable in Rust,
/// while the `maxCandidates` validation survives as an [`ArgError`] with the
/// frozen TS message.
pub fn get_top_candidates(
    account_manager: &mut AccountManager,
    model_family: ModelFamily,
    model: Option<&str>,
    max_candidates: usize,
) -> Result<Vec<ManagedAccount>, ArgError> {
    if max_candidates == 0 {
        return Err(ArgError::new(
            "getTopCandidates requires maxCandidates to be a positive integer",
        ));
    }

    let accounts = account_manager.get_accounts_snapshot();
    if accounts.is_empty() {
        return Ok(Vec::new());
    }

    let quota_key = get_quota_key(model_family, model);
    let health_tracker = get_health_tracker(None);
    let token_tracker = get_token_tracker(None);

    struct Metrics {
        account: ManagedAccount,
        tracker_key: cma_rotation::trackers::TrackerKey,
        is_available: bool,
    }

    let mut accounts_with_metrics: Vec<Metrics> = Vec::with_capacity(accounts.len());
    for mut account in accounts {
        clear_expired_rate_limits(&mut account);
        let is_rate_limited = is_rate_limited_for_family(&mut account, model_family, model);
        // Fresh clock per account (TS `Date.now()` inside the loop).
        let is_cooling_down = matches!(account.cooling_down_until, Some(until) if until > now_ms());
        let is_available = !is_rate_limited && !is_cooling_down;
        let tracker_key = get_runtime_tracker_key(&mut account);
        accounts_with_metrics.push(Metrics {
            account,
            tracker_key,
            is_available,
        });
    }

    let available: Vec<Metrics> = accounts_with_metrics
        .into_iter()
        .filter(|metrics| metrics.is_available)
        .collect();
    if available.is_empty() {
        return Ok(Vec::new());
    }

    let now = now_ms();
    let mut scored: Vec<(ManagedAccount, f64)> = available
        .into_iter()
        .map(|metrics| {
            let health = health_tracker.get_score(metrics.tracker_key.clone(), Some(&quota_key));
            let tokens = token_tracker.get_tokens(metrics.tracker_key.clone(), Some(&quota_key));
            let hours_since_used =
                (now - metrics.account.last_used) as f64 / (1000.0 * 60.0 * 60.0);
            let score = health * 2.0 + tokens * 5.0 + hours_since_used * 2.0;
            (metrics.account, score)
        })
        .collect();

    // Descending by score; Rust `sort_by` is stable, so ties keep input
    // order (Node's sort is stable too).
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(max_candidates);
    Ok(scored.into_iter().map(|(account, _)| account).collect())
}

/// TS `probeAccountsInParallel(candidates, probeFn, _options)` — probe with
/// first-success-wins racing; losing candidates are aborted immediately when
/// a winner is found. `_options` is ignored (TS parity — see
/// [`ParallelProbeOptions`]).
pub async fn probe_accounts_in_parallel<T, E, F, Fut>(
    candidates: &[ProbeCandidate],
    probe_fn: F,
    _options: Option<&ParallelProbeOptions>,
) -> Option<ProbeResult<T, E>>
where
    F: Fn(ManagedAccount, ProbeAbortSignal) -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let log = create_logger("parallel-probe");

    if candidates.is_empty() {
        return None;
    }

    if candidates.len() == 1 {
        let candidate = &candidates[0];
        let account = candidate.account.clone();
        return match probe_fn(account.clone(), candidate.controller.signal()).await {
            Ok(response) => Some(ProbeResult::Success { account, response }),
            Err(error) => Some(ProbeResult::Failure { account, error }),
        };
    }

    log.debug(
        &format!("Probing {} accounts in parallel", candidates.len()),
        None,
    );

    let mut in_flight = FuturesUnordered::new();
    for (position, candidate) in candidates.iter().enumerate() {
        let future = probe_fn(candidate.account.clone(), candidate.controller.signal());
        in_flight.push(async move { (position, future.await) });
    }

    while let Some((position, result)) = in_flight.next().await {
        match result {
            Ok(response) => {
                let account = candidates[position].account.clone();
                log.debug(
                    &format!(
                        "Parallel probe succeeded with account {}",
                        account.index + 1
                    ),
                    None,
                );
                for candidate in candidates {
                    if candidate.account.index != account.index {
                        candidate.controller.abort();
                    }
                }
                // Dropping `in_flight` cancels the losing futures; their
                // late results are ignored (TS: `then` sees the winner set).
                return Some(ProbeResult::Success { account, response });
            }
            Err(_error) => {
                // Losing rejections are swallowed; all-fail resolves None
                // when the stream drains.
            }
        }
    }

    None
}

/// TS `createProbeCandidates(accounts)` — one fresh controller per account.
pub fn create_probe_candidates(accounts: Vec<ManagedAccount>) -> Vec<ProbeCandidate> {
    accounts
        .into_iter()
        .map(|account| ProbeCandidate {
            account,
            controller: ProbeAbortController::new(),
        })
        .collect()
}

// ============================================================================
// Tests — ported from test/parallel-probe.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{
        AccountMetadataV3, AccountStorageV3, RateLimitStateV3,
    };

    fn stored_account(refresh: &str, last_used: i64) -> AccountMetadataV3 {
        AccountMetadataV3::new(refresh, now_ms() - 1_000, last_used)
    }

    fn manager_of(accounts: Vec<AccountMetadataV3>) -> AccountManager {
        let mut storage = AccountStorageV3::empty();
        storage.accounts = accounts;
        storage.active_index = 0;
        AccountManager::new(None, Some(&storage))
    }

    fn candidates_of(manager: &mut AccountManager) -> Vec<ProbeCandidate> {
        create_probe_candidates(manager.get_accounts_snapshot())
    }

    // -- createProbeCandidates ----------------------------------------------

    #[test]
    fn creates_candidates_with_abort_controllers() {
        let mut manager = manager_of(vec![
            stored_account("token-1", now_ms()),
            stored_account("token-2", now_ms()),
        ]);
        let candidates = candidates_of(&mut manager);
        assert_eq!(candidates.len(), 2);
        for candidate in &candidates {
            assert!(!candidate.controller.is_aborted());
        }
    }

    // -- probeAccountsInParallel --------------------------------------------

    #[tokio::test]
    async fn returns_none_for_empty_candidates() {
        let result: Option<ProbeResult<&str, String>> =
            probe_accounts_in_parallel(&[], |_, _| async { Ok("unused") }, None).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn returns_success_for_single_candidate() {
        let mut manager = manager_of(vec![stored_account("token-1", now_ms())]);
        let candidates = candidates_of(&mut manager);
        let result: Option<ProbeResult<&str, String>> =
            probe_accounts_in_parallel(&candidates, |_, _| async { Ok("ok") }, None).await;
        match result.expect("result") {
            ProbeResult::Success { account, response } => {
                assert_eq!(account.index, 0);
                assert_eq!(response, "ok");
            }
            ProbeResult::Failure { .. } => panic!("expected success"),
        }
    }

    #[tokio::test]
    async fn returns_failure_for_single_failing_candidate() {
        let mut manager = manager_of(vec![stored_account("token-1", now_ms())]);
        let candidates = candidates_of(&mut manager);
        let result: Option<ProbeResult<&str, String>> = probe_accounts_in_parallel(
            &candidates,
            |_, _| async { Err("probe failed".to_string()) },
            None,
        )
        .await;
        match result.expect("result") {
            ProbeResult::Failure { account, error } => {
                assert_eq!(account.index, 0);
                assert_eq!(error, "probe failed");
            }
            ProbeResult::Success { .. } => panic!("expected failure"),
        }
    }

    #[tokio::test]
    async fn returns_first_success_in_parallel_probing() {
        let mut manager = manager_of(vec![
            stored_account("token-1", now_ms()),
            stored_account("token-2", now_ms()),
            stored_account("token-3", now_ms()),
        ]);
        let candidates = candidates_of(&mut manager);
        // Account 1 (index 1) resolves fastest; 0 is slow; 2 fails fast.
        let result: Option<ProbeResult<usize, String>> = probe_accounts_in_parallel(
            &candidates,
            |account, _signal| async move {
                match account.index {
                    0 => {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        Ok(0)
                    }
                    1 => {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        Ok(1)
                    }
                    _ => Err("fast failure".to_string()),
                }
            },
            None,
        )
        .await;
        match result.expect("result") {
            ProbeResult::Success { account, response } => {
                assert_eq!(account.index, 1);
                assert_eq!(response, 1);
            }
            ProbeResult::Failure { .. } => panic!("expected success"),
        }
    }

    #[tokio::test]
    async fn aborts_losing_candidates_after_winner_found() {
        let mut manager = manager_of(vec![
            stored_account("token-1", now_ms()),
            stored_account("token-2", now_ms()),
        ]);
        let candidates = candidates_of(&mut manager);
        let result: Option<ProbeResult<usize, String>> = probe_accounts_in_parallel(
            &candidates,
            |account, signal| async move {
                if account.index == 0 {
                    Ok(0)
                } else {
                    // The loser waits on its abort signal.
                    signal.cancelled().await;
                    Err("aborted".to_string())
                }
            },
            None,
        )
        .await;
        assert!(result.expect("result").is_success());
        assert!(!candidates[0].controller.is_aborted(), "winner not aborted");
        assert!(candidates[1].controller.is_aborted(), "loser aborted");
    }

    #[tokio::test]
    async fn returns_none_when_all_candidates_fail() {
        let mut manager = manager_of(vec![
            stored_account("token-1", now_ms()),
            stored_account("token-2", now_ms()),
        ]);
        let candidates = candidates_of(&mut manager);
        let result: Option<ProbeResult<usize, String>> = probe_accounts_in_parallel(
            &candidates,
            |account, _| async move { Err(format!("failure {}", account.index)) },
            None,
        )
        .await;
        assert!(result.is_none(), "multi-candidate all-fail must be None");
    }

    #[tokio::test]
    async fn options_parameter_is_accepted_and_ignored() {
        let mut manager = manager_of(vec![stored_account("token-1", now_ms())]);
        let candidates = candidates_of(&mut manager);
        let options = ParallelProbeOptions {
            max_concurrency: 1,
            timeout_ms: 1,
        };
        let result: Option<ProbeResult<&str, String>> =
            probe_accounts_in_parallel(&candidates, |_, _| async { Ok("ok") }, Some(&options))
                .await;
        assert!(result.expect("result").is_success());
    }

    // -- getTopCandidates ---------------------------------------------------

    #[test]
    fn returns_empty_array_when_no_accounts_available() {
        let mut manager = manager_of(Vec::new());
        let top = get_top_candidates(&mut manager, ModelFamily::Codex, None, 3).expect("ok");
        assert!(top.is_empty());
    }

    #[test]
    fn returns_up_to_max_candidates_accounts() {
        let now = now_ms();
        let mut manager = manager_of(vec![
            stored_account("token-1", now),
            stored_account("token-2", now),
            stored_account("token-3", now),
        ]);
        let top = get_top_candidates(&mut manager, ModelFamily::Codex, None, 2).expect("ok");
        assert_eq!(top.len(), 2);
    }

    #[test]
    fn filters_out_rate_limited_accounts() {
        let now = now_ms();
        let mut limited = stored_account("token-1", now);
        let mut times = RateLimitStateV3::new();
        times.insert("codex", now + 60_000);
        limited.rate_limit_reset_times = Some(times);
        let mut manager = manager_of(vec![limited, stored_account("token-2", now)]);
        let top = get_top_candidates(&mut manager, ModelFamily::Codex, None, 5).expect("ok");
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].meta.refresh_token, "token-2");
    }

    #[test]
    fn expired_rate_limits_are_cleared_before_the_availability_check() {
        let now = now_ms();
        let mut expired = stored_account("token-1", now);
        let mut times = RateLimitStateV3::new();
        times.insert("codex", now - 60_000);
        expired.rate_limit_reset_times = Some(times);
        let mut manager = manager_of(vec![expired]);
        let top = get_top_candidates(&mut manager, ModelFamily::Codex, None, 5).expect("ok");
        assert_eq!(top.len(), 1, "expired window must not exclude the account");
    }

    #[test]
    fn filters_out_cooling_down_accounts() {
        let now = now_ms();
        let mut cooling = stored_account("token-1", now);
        cooling.cooling_down_until = Some(now + 60_000);
        let mut manager = manager_of(vec![cooling, stored_account("token-2", now)]);
        let top = get_top_candidates(&mut manager, ModelFamily::Codex, None, 5).expect("ok");
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].meta.refresh_token, "token-2");
    }

    #[test]
    fn returns_accounts_sorted_by_hybrid_score() {
        let now = now_ms();
        // Untracked accounts share the tracker maxima; only idle hours
        // differentiate: older lastUsed → higher score.
        let mut manager = manager_of(vec![
            stored_account("token-1", now - 3_600_000),
            stored_account("token-2", now - 10 * 3_600_000),
            stored_account("token-3", now - 5 * 3_600_000),
        ]);
        let top = get_top_candidates(&mut manager, ModelFamily::Codex, None, 3).expect("ok");
        let order: Vec<&str> = top
            .iter()
            .map(|account| account.meta.refresh_token.as_str())
            .collect();
        assert_eq!(order, vec!["token-2", "token-3", "token-1"]);
    }

    #[test]
    fn model_scoped_rate_limits_exclude_candidates_for_that_model() {
        let now = now_ms();
        let mut limited = stored_account("token-1", now);
        let mut times = RateLimitStateV3::new();
        times.insert("codex:gpt-5.3-codex", now + 60_000);
        limited.rate_limit_reset_times = Some(times);
        let mut manager = manager_of(vec![limited, stored_account("token-2", now)]);

        let top = get_top_candidates(&mut manager, ModelFamily::Codex, Some("gpt-5.3-codex"), 5)
            .expect("ok");
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].meta.refresh_token, "token-2");

        // Without the model scope only the base family key applies.
        let top = get_top_candidates(&mut manager, ModelFamily::Codex, None, 5).expect("ok");
        assert_eq!(top.len(), 2);
    }

    #[test]
    fn rejects_non_positive_max_candidates_with_the_frozen_message() {
        let mut manager = manager_of(vec![stored_account("token-1", now_ms())]);
        let error =
            get_top_candidates(&mut manager, ModelFamily::Codex, None, 0).expect_err("error");
        assert_eq!(
            error.message(),
            "getTopCandidates requires maxCandidates to be a positive integer"
        );
    }
}
