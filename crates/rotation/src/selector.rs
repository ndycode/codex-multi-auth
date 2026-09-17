//! Port of `lib/rotation.ts` selection half — hybrid account selection plus
//! the jitter/backoff utilities.
//!
//! Contracts carried over verbatim (spec 04 §1):
//! - `select_hybrid_account` returns **`None` when zero accounts are
//!   available** — never an LRU fallback to a blocked candidate
//!   (AUDIT-H2 / D-01; spec 04 gotcha 2). The traced variant mirrors this.
//! - Hybrid weights: health 2 / tokens 5 / freshness 2.0; PID bonus
//!   `(pid % 100) * 0.01`; per-account pseudo-random term
//!   `((index * 0.131 + pidBonus) % 1) * freshnessWeight * 0.1`.
//! - Ties resolve to the first candidate in iteration order (strict `>`).
//! - `exponential_backoff` validates BEFORE any jitter is drawn, with the
//!   exact frozen `TypeError` texts (surfaced as [`ArgError`], ARCHITECTURE
//!   §8.2).
//!
//! The TS `TypeError`s for "accounts is not an array" / "missing trackers"
//! are unrepresentable in Rust's type system and have no port.
//!
//! Nothing here is ever persisted (no `Serialize` anywhere in this crate).

use std::collections::HashMap;
use std::sync::LazyLock;

use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::utils::now_ms;
use serde_json::json;

use crate::trackers::{HealthScoreTracker, TokenBucketTracker, TrackerKey};

static LOG: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("rotation"));

// ============================================================================
// Argument validation error (plain, NOT CodexError — ARCHITECTURE §8.2)
// ============================================================================

/// Plain argument-contract error for dual-call helpers; carries the exact
/// frozen `"<helper> requires …"` message from the TS `TypeError`s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgError {
    message: String,
}

impl ArgError {
    /// Create an [`ArgError`] with the given frozen message.
    pub fn new(message: impl Into<String>) -> Self {
        ArgError {
            message: message.into(),
        }
    }

    /// The frozen error message.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for ArgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ArgError {}

// ============================================================================
// Hybrid account selection
// ============================================================================

/// `AccountWithMetrics` — selection candidate handed to the hybrid selector.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountWithMetrics {
    /// Index of the account inside the managed pool.
    pub index: usize,
    /// Stable tracker key override; falls back to `index` when absent.
    pub tracker_key: Option<TrackerKey>,
    /// Whether the account is currently selectable.
    pub is_available: bool,
    /// Wall-clock ms timestamp of last use (0 = never).
    pub last_used: i64,
}

/// `HybridSelectionConfig` — scoring weights.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HybridSelectionConfig {
    /// Weight for health score (default: 2).
    pub health_weight: f64,
    /// Weight for token count (default: 5).
    pub token_weight: f64,
    /// Weight for freshness/last used (default: 2.0).
    pub freshness_weight: f64,
}

const DEFAULT_HYBRID_SELECTION_CONFIG: HybridSelectionConfig = HybridSelectionConfig {
    health_weight: 2.0,
    token_weight: 5.0,
    freshness_weight: 2.0,
};

impl Default for HybridSelectionConfig {
    fn default() -> Self {
        DEFAULT_HYBRID_SELECTION_CONFIG
    }
}

/// `HybridSelectionOptions`.
#[derive(Debug, Clone, Default)]
pub struct HybridSelectionOptions {
    /// Adds a small deterministic per-process offset so parallel processes
    /// spread across accounts.
    pub pid_offset_enabled: bool,
    /// Optional per-account additive score boost keyed by pool index.
    /// Non-finite values are ignored (treated as 0).
    pub score_boost_by_account: HashMap<usize, f64>,
}

/// `SelectHybridAccountParams` — named-argument bundle (the TS overloads'
/// positional form collapses into this one struct in Rust).
#[derive(Clone)]
pub struct SelectHybridAccountParams<'a> {
    /// Candidate accounts.
    pub accounts: &'a [AccountWithMetrics],
    /// Health tracker consulted per candidate (scoped by `quota_key`).
    pub health_tracker: &'a HealthScoreTracker,
    /// Token tracker consulted per candidate (scoped by `quota_key`).
    pub token_tracker: &'a TokenBucketTracker,
    /// Optional quota key scoping health/token lookups.
    pub quota_key: Option<&'a str>,
    /// Scoring weights (defaults: health 2 / tokens 5 / freshness 2.0).
    pub config: HybridSelectionConfig,
    /// Selection options (PID offset, capability boosts).
    pub options: HybridSelectionOptions,
}

impl<'a> SelectHybridAccountParams<'a> {
    /// Params with default quota key, config, and options.
    pub fn new(
        accounts: &'a [AccountWithMetrics],
        health_tracker: &'a HealthScoreTracker,
        token_tracker: &'a TokenBucketTracker,
    ) -> Self {
        SelectHybridAccountParams {
            accounts,
            health_tracker,
            token_tracker,
            quota_key: None,
            config: HybridSelectionConfig::default(),
            options: HybridSelectionOptions::default(),
        }
    }
}

/// `SelectHybridAccountTracedParams` — same shape as the plain params.
pub type SelectHybridAccountTracedParams<'a> = SelectHybridAccountParams<'a>;

fn resolve_tracker_key(account: &AccountWithMetrics) -> TrackerKey {
    account
        .tracker_key
        .clone()
        .unwrap_or(TrackerKey::Number(account.index as i64))
}

fn capability_boost_for(options: &HybridSelectionOptions, index: usize) -> f64 {
    match options.score_boost_by_account.get(&index) {
        Some(boost) if boost.is_finite() => *boost,
        _ => 0.0,
    }
}

/// Raw score breakdown for one candidate (internal).
struct ScoreBreakdown {
    score: f64,
    health: f64,
    tokens: f64,
    hours_since_used: f64,
    capability_boost: f64,
}

fn score_account(
    account: &AccountWithMetrics,
    params: &SelectHybridAccountParams<'_>,
    cfg: &HybridSelectionConfig,
    now: i64,
    pid_bonus: f64,
) -> ScoreBreakdown {
    let tracker_key = resolve_tracker_key(account);
    let health = params
        .health_tracker
        .get_score(tracker_key.clone(), params.quota_key);
    let tokens = params
        .token_tracker
        .get_tokens(tracker_key, params.quota_key);
    let hours_since_used = (now - account.last_used) as f64 / (1000.0 * 60.0 * 60.0);
    let capability_boost = capability_boost_for(&params.options, account.index);

    let mut score = health * cfg.health_weight
        + tokens * cfg.token_weight
        + hours_since_used * cfg.freshness_weight
        + capability_boost;

    // PID-based offset distributes selection across parallel agents.
    if params.options.pid_offset_enabled {
        score += ((account.index as f64 * 0.131 + pid_bonus) % 1.0) * cfg.freshness_weight * 0.1;
    }

    ScoreBreakdown {
        score,
        health,
        tokens,
        hours_since_used,
        capability_boost,
    }
}

/// Selects the best account using a weighted hybrid score:
///
/// `score = health*healthWeight + tokens*tokenWeight + hoursSinceUsed*freshnessWeight (+ boost + PID term)`
///
/// Returns `None` when NO account is available (all cooling down,
/// rate-limited, circuit-open, or otherwise blocked) — the caller is
/// responsible for surfacing the pool-exhaustion condition instead of
/// retrying through a blocked candidate (AUDIT-H2 / D-01).
pub fn select_hybrid_account(params: SelectHybridAccountParams<'_>) -> Option<AccountWithMetrics> {
    select_hybrid_account_with_pid(params, std::process::id())
}

/// PID-injectable core of [`select_hybrid_account`] (test seam mirroring the
/// TS suite's `process.pid` redefinition).
fn select_hybrid_account_with_pid(
    params: SelectHybridAccountParams<'_>,
    pid: u32,
) -> Option<AccountWithMetrics> {
    let cfg = params.config;
    let available: Vec<&AccountWithMetrics> =
        params.accounts.iter().filter(|a| a.is_available).collect();

    // Contract: if NO account is currently available the selector returns
    // None rather than handing back a known-unavailable candidate via an LRU
    // fallback (AUDIT-H2 / D-01).
    if available.is_empty() {
        return None;
    }
    if available.len() == 1 {
        return available.first().map(|account| (*account).clone());
    }

    let now = now_ms();
    let mut best_account: Option<&AccountWithMetrics> = None;
    let mut best_score = f64::NEG_INFINITY;

    // PID offset: each process gets a small deterministic bonus based on pid.
    let pid_bonus = if params.options.pid_offset_enabled {
        f64::from(pid % 100) * 0.01
    } else {
        0.0
    };

    for account in available.iter().copied() {
        let breakdown = score_account(account, &params, &cfg, now, pid_bonus);
        if breakdown.score > best_score {
            best_score = breakdown.score;
            best_account = Some(account);
        }
    }

    if let Some(best) = best_account
        && available.len() > 1
    {
        let tracker_key = resolve_tracker_key(best);
        let health = params
            .health_tracker
            .get_score(tracker_key.clone(), params.quota_key);
        let tokens = params
            .token_tracker
            .get_tokens(tracker_key, params.quota_key);
        LOG.debug(
            "Selected account",
            Some(&json!({
                "index": best.index,
                "health": health.round() as i64,
                "tokens": tokens.round() as i64,
                "score": best_score.round() as i64,
                "candidateCount": available.len(),
            })),
        );
    }

    best_account.cloned()
}

// ============================================================================
// Trace-mode selection (non-mutating, diagnostic)
// ============================================================================

/// Per-candidate score breakdown emitted by [`select_hybrid_account_traced`].
/// Raw (unrounded) numbers so callers can display exact values.
#[derive(Debug, Clone, PartialEq)]
pub struct HybridSelectionCandidateTrace {
    /// Pool index.
    pub index: usize,
    /// Resolved tracker key (override or index).
    pub tracker_key: TrackerKey,
    /// Availability at trace time.
    pub is_available: bool,
    /// Last-used wall-clock ms.
    pub last_used: i64,
    /// Health score used in the formula.
    pub health: f64,
    /// Token count used in the formula.
    pub tokens: f64,
    /// Hours since last use.
    pub hours_since_used: f64,
    /// Applied capability boost (0 when absent/non-finite).
    pub capability_boost: f64,
    /// Applied PID bonus (0 when the offset is disabled).
    pub pid_bonus: f64,
    /// Final hybrid score.
    pub score: f64,
    /// Set only for unavailable candidates.
    pub reason: Option<&'static str>,
}

/// Result of [`select_hybrid_account_traced`].
#[derive(Debug, Clone, PartialEq)]
pub struct HybridSelectionTraceResult {
    /// The winning account (mirrors production selection), if any.
    pub selected: Option<AccountWithMetrics>,
    /// Winning pool index, if any.
    pub selected_index: Option<usize>,
    /// Human-readable selection reason (exact TS strings).
    pub selection_reason: String,
    /// All candidates, sorted descending by score.
    pub candidates: Vec<HybridSelectionCandidateTrace>,
    /// The resolved scoring weights.
    pub config: HybridSelectionConfig,
    /// The quota key the lookups were scoped to.
    pub quota_key: Option<String>,
    /// Number of available accounts.
    pub available_count: usize,
}

const UNAVAILABLE_REASON: &str = "unavailable (rate-limited, cooling down, or circuit open)";

/// Non-mutating variant of [`select_hybrid_account`] returning the winner
/// alongside a per-candidate score breakdown (used by `why-selected --now`).
/// Scores ALL accounts (unavailable ones get a `reason`); candidates are
/// sorted descending by score. Mirrors the production null-contract exactly.
pub fn select_hybrid_account_traced(
    params: SelectHybridAccountTracedParams<'_>,
) -> HybridSelectionTraceResult {
    select_hybrid_account_traced_with_pid(params, std::process::id())
}

/// PID-injectable core of [`select_hybrid_account_traced`] (test seam).
fn select_hybrid_account_traced_with_pid(
    params: SelectHybridAccountTracedParams<'_>,
    pid: u32,
) -> HybridSelectionTraceResult {
    let cfg = params.config;
    let now = now_ms();
    let pid_bonus = if params.options.pid_offset_enabled {
        f64::from(pid % 100) * 0.01
    } else {
        0.0
    };

    let accounts = params.accounts;
    let available_accounts: Vec<&AccountWithMetrics> =
        accounts.iter().filter(|a| a.is_available).collect();

    let mut candidates: Vec<HybridSelectionCandidateTrace> = accounts
        .iter()
        .map(|account| {
            let breakdown = score_account(account, &params, &cfg, now, pid_bonus);
            HybridSelectionCandidateTrace {
                index: account.index,
                tracker_key: resolve_tracker_key(account),
                is_available: account.is_available,
                last_used: account.last_used,
                health: breakdown.health,
                tokens: breakdown.tokens,
                hours_since_used: breakdown.hours_since_used,
                capability_boost: breakdown.capability_boost,
                pid_bonus: if params.options.pid_offset_enabled {
                    pid_bonus
                } else {
                    0.0
                },
                score: breakdown.score,
                reason: if account.is_available {
                    None
                } else {
                    Some(UNAVAILABLE_REASON)
                },
            }
        })
        .collect();

    // Stable descending sort — ties keep original order, matching JS.
    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut selected: Option<AccountWithMetrics> = None;
    let mut selection_reason = String::from("no accounts provided");

    if accounts.is_empty() {
        selection_reason = String::from("no accounts configured");
    } else if available_accounts.is_empty() {
        // AUDIT-H2 / D-01 contract: when no account is available, selection
        // returns None rather than a blocked LRU candidate; the trace mirrors
        // production so why-selected diagnostics match actual behaviour.
        selected = None;
        selection_reason =
            String::from("all accounts unavailable (rate-limited, cooling down, or circuit open)");
    } else if available_accounts.len() == 1 {
        selected = available_accounts.first().map(|a| (*a).clone());
        selection_reason = String::from("single available account");
    } else if let Some(best_candidate) = candidates.iter().find(|candidate| candidate.is_available)
    {
        selected = accounts
            .iter()
            .find(|account| account.index == best_candidate.index)
            .cloned();
        selection_reason = format!(
            "highest hybrid score ({:.2}) across {} available account(s)",
            best_candidate.score,
            available_accounts.len()
        );
    }

    let selected_index = selected.as_ref().map(|account| account.index);
    HybridSelectionTraceResult {
        selected,
        selected_index,
        selection_reason,
        candidates,
        config: cfg,
        quota_key: params.quota_key.map(str::to_string),
        available_count: available_accounts.len(),
    }
}

// ============================================================================
// Utility functions
// ============================================================================

/// Adds symmetric random jitter to a delay value:
/// `max(0, floor(baseMs + baseMs*jitterFactor*(rand()*2 - 1)))`.
/// TS default `jitter_factor` is `0.1` (±10 %).
pub fn add_jitter(base_ms: f64, jitter_factor: f64) -> i64 {
    let jitter = base_ms * jitter_factor * (rand::random::<f64>() * 2.0 - 1.0);
    (base_ms + jitter).floor().max(0.0) as i64
}

/// Returns a random delay within `[min_ms, max_ms)`:
/// `floor(minMs + rand()*(maxMs - minMs))`.
pub fn random_delay(min_ms: f64, max_ms: f64) -> i64 {
    (min_ms + rand::random::<f64>() * (max_ms - min_ms)).floor() as i64
}

/// `ExponentialBackoffOptions` — named-argument bundle. `attempt` is `f64`
/// so the "positive integer" contract (incl. NaN/∞ rejection) ports exactly.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExponentialBackoffOptions {
    /// Attempt number (1-based; must be a positive integer).
    pub attempt: f64,
    /// Base delay in ms (default 1000).
    pub base_ms: Option<f64>,
    /// Maximum delay in ms (default 60000).
    pub max_ms: Option<f64>,
    /// Jitter factor in `[0, 1]` (default 0.1).
    pub jitter_factor: Option<f64>,
}

impl ExponentialBackoffOptions {
    /// Options with TS defaults for everything but `attempt`.
    pub fn new(attempt: f64) -> Self {
        ExponentialBackoffOptions {
            attempt,
            base_ms: None,
            max_ms: None,
            jitter_factor: None,
        }
    }
}

/// Calculates exponential backoff with jitter:
/// `addJitter(min(baseMs * 2^(attempt-1), maxMs), jitterFactor)`.
///
/// Validates all arguments BEFORE any jitter is drawn; invalid arguments
/// yield an [`ArgError`] with the exact frozen TS `TypeError` message.
pub fn exponential_backoff(options: ExponentialBackoffOptions) -> Result<i64, ArgError> {
    let attempt = options.attempt;
    let base_ms = options.base_ms.unwrap_or(1000.0);
    let max_ms = options.max_ms.unwrap_or(60000.0);
    let jitter_factor = options.jitter_factor.unwrap_or(0.1);

    if !(attempt.is_finite() && attempt.fract() == 0.0) || attempt < 1.0 {
        return Err(ArgError::new(
            "exponentialBackoff requires attempt to be a positive integer",
        ));
    }
    if !base_ms.is_finite() || base_ms < 0.0 {
        return Err(ArgError::new(
            "exponentialBackoff requires baseMs to be a finite non-negative number",
        ));
    }
    if !max_ms.is_finite() || max_ms < 0.0 {
        return Err(ArgError::new(
            "exponentialBackoff requires maxMs to be a finite non-negative number",
        ));
    }
    if !jitter_factor.is_finite() || !(0.0..=1.0).contains(&jitter_factor) {
        return Err(ArgError::new(
            "exponentialBackoff requires jitterFactor to be between 0 and 1",
        ));
    }

    let delay = (base_ms * 2f64.powf(attempt - 1.0)).min(max_ms);
    Ok(add_jitter(delay, jitter_factor))
}

// ============================================================================
// Tests (ported from test/rotation.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn account(index: usize, is_available: bool, last_used: i64) -> AccountWithMetrics {
        AccountWithMetrics {
            index,
            tracker_key: None,
            is_available,
            last_used,
        }
    }

    fn trackers() -> (HealthScoreTracker, TokenBucketTracker) {
        (HealthScoreTracker::new(), TokenBucketTracker::new())
    }

    #[test]
    fn returns_none_when_no_accounts() {
        let (health, token) = trackers();
        let result = select_hybrid_account(SelectHybridAccountParams::new(&[], &health, &token));
        assert!(result.is_none());
    }

    #[test]
    fn returns_none_when_all_accounts_unavailable_audit_h2_contract() {
        let (health, token) = trackers();
        let accounts = vec![account(0, false, 100), account(1, false, 50)];
        // Previously returned the least-recently-used unavailable account as a
        // "fallback" (AUDIT-H2 / D-01). New contract: None.
        let result =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert!(result.is_none());
    }

    #[test]
    fn returns_none_when_single_account_unavailable() {
        let (health, token) = trackers();
        let accounts = vec![account(0, false, 0)];
        let result =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert!(result.is_none());
    }

    #[test]
    fn returns_the_only_available_account() {
        let (health, token) = trackers();
        let accounts = vec![account(0, true, 0)];
        let result =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(result.map(|a| a.index), Some(0));
    }

    #[test]
    fn prefers_healthier_accounts() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];
        health.record_failure(0usize, None);
        let result =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(result.map(|a| a.index), Some(1));
    }

    #[test]
    fn prefers_accounts_with_more_tokens() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];
        token.drain(0usize, None, 40.0);
        let result =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(result.map(|a| a.index), Some(1));
    }

    #[test]
    fn considers_freshness_in_selection() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![
            account(0, true, now),
            account(1, true, now - 1000 * 60 * 60 * 24),
        ];
        let result =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(result.map(|a| a.index), Some(1));
    }

    #[test]
    fn uses_tracker_key_when_runtime_state_keyed_by_identity() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![
            AccountWithMetrics {
                index: 0,
                tracker_key: Some(TrackerKey::Text("email:first@example.com".into())),
                is_available: true,
                last_used: now,
            },
            AccountWithMetrics {
                index: 1,
                tracker_key: Some(TrackerKey::Text("email:second@example.com".into())),
                is_available: true,
                last_used: now,
            },
        ];
        health.record_failure("email:first@example.com", None);
        let result =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(result.map(|a| a.index), Some(1));
    }

    #[test]
    fn pid_offset_disabled_does_not_change_selection() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];
        let mut params = SelectHybridAccountParams::new(&accounts, &health, &token);
        params.options.pid_offset_enabled = false;
        let with_flag = select_hybrid_account(params);
        let baseline =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(
            with_flag.map(|a| a.index),
            baseline.map(|a| a.index)
        );
    }

    #[test]
    fn pid_offset_enabled_returns_a_valid_account() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];
        let mut params = SelectHybridAccountParams::new(&accounts, &health, &token);
        params.options.pid_offset_enabled = true;
        let result = select_hybrid_account(params);
        assert!(matches!(result.map(|a| a.index), Some(0) | Some(1)));
    }

    #[test]
    fn pid_offset_differentiates_selection_across_pids() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![
            account(0, true, now),
            account(1, true, now),
            account(2, true, now),
            account(3, true, now),
        ];
        let mut selected = std::collections::HashSet::new();
        for pid in (0..100u32).step_by(10) {
            let mut params = SelectHybridAccountParams::new(&accounts, &health, &token);
            params.options.pid_offset_enabled = true;
            if let Some(result) = select_hybrid_account_with_pid(params, pid) {
                selected.insert(result.index);
            }
        }
        assert!(selected.len() > 1);
    }

    #[test]
    fn applies_score_boost_to_deterministically_change_winner() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];

        let baseline =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(baseline.map(|a| a.index), Some(0));

        let mut params = SelectHybridAccountParams::new(&accounts, &health, &token);
        params.options.score_boost_by_account = HashMap::from([(1usize, 25.0)]);
        let boosted = select_hybrid_account(params);
        assert_eq!(boosted.map(|a| a.index), Some(1));
    }

    #[test]
    fn ignores_non_finite_score_boosts() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];

        let baseline =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token))
                .map(|a| a.index);

        let mut params = SelectHybridAccountParams::new(&accounts, &health, &token);
        params.options.score_boost_by_account = HashMap::from([(1usize, f64::NAN)]);
        let with_nan = select_hybrid_account(params).map(|a| a.index);

        let mut params = SelectHybridAccountParams::new(&accounts, &health, &token);
        params.options.score_boost_by_account = HashMap::from([(1usize, f64::INFINITY)]);
        let with_inf = select_hybrid_account(params).map(|a| a.index);

        assert_eq!(with_nan, baseline);
        assert_eq!(with_inf, baseline);
    }

    #[test]
    fn boost_behavior_stable_when_pid_offset_enabled() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];
        let mut params = SelectHybridAccountParams::new(&accounts, &health, &token);
        params.options.pid_offset_enabled = true;
        params.options.score_boost_by_account = HashMap::from([(1usize, 100.0)]);
        let result = select_hybrid_account(params);
        assert_eq!(result.map(|a| a.index), Some(1));
    }

    // ---------------- traced ----------------

    #[test]
    fn traced_returns_empty_result_for_no_accounts() {
        let (health, token) = trackers();
        let result =
            select_hybrid_account_traced(SelectHybridAccountParams::new(&[], &health, &token));
        assert!(result.selected.is_none());
        assert!(result.candidates.is_empty());
        assert_eq!(result.available_count, 0);
        assert_eq!(result.selection_reason, "no accounts configured");
    }

    #[test]
    fn traced_returns_the_single_available_account() {
        let (health, token) = trackers();
        let accounts = vec![account(0, true, now_ms() - 3_600_000)];
        let result = select_hybrid_account_traced(SelectHybridAccountParams::new(
            &accounts, &health, &token,
        ));
        assert_eq!(result.selected.as_ref().map(|a| a.index), Some(0));
        assert_eq!(result.selected_index, Some(0));
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.selection_reason, "single available account");
    }

    #[test]
    fn traced_sorts_candidates_descending_and_picks_top() {
        let (health, token) = trackers();
        let now = now_ms();
        token.drain(0usize, None, 40.0);
        let accounts = vec![account(0, true, now - 60_000), account(1, true, now - 60_000)];
        let result = select_hybrid_account_traced(SelectHybridAccountParams::new(
            &accounts, &health, &token,
        ));
        assert_eq!(result.selected.as_ref().map(|a| a.index), Some(1));
        assert_eq!(result.candidates[0].index, 1);
        assert!(result.candidates[0].score >= result.candidates[1].score);
        assert!(
            result
                .selection_reason
                .starts_with("highest hybrid score ("),
            "unexpected reason: {}",
            result.selection_reason
        );
        assert!(
            result
                .selection_reason
                .ends_with("across 2 available account(s)"),
            "unexpected reason: {}",
            result.selection_reason
        );
    }

    #[test]
    fn traced_returns_none_when_no_accounts_available_audit_h2_contract() {
        let (health, token) = trackers();
        let now = now_ms();
        let accounts = vec![account(0, false, now - 1_000), account(1, false, now - 10_000)];
        let result = select_hybrid_account_traced(SelectHybridAccountParams::new(
            &accounts, &health, &token,
        ));
        assert_eq!(result.available_count, 0);
        assert!(result.selected.is_none());
        assert_eq!(
            result.selection_reason,
            "all accounts unavailable (rate-limited, cooling down, or circuit open)"
        );
        for candidate in &result.candidates {
            assert_eq!(
                candidate.reason,
                Some("unavailable (rate-limited, cooling down, or circuit open)")
            );
        }
    }

    #[test]
    fn traced_does_not_mutate_trackers() {
        let (health, token) = trackers();
        let before_health = health.get_score(0usize, None);
        let before_tokens = token.get_tokens(0usize, None);
        let now = now_ms();
        let accounts = vec![account(0, true, now), account(1, true, now)];
        select_hybrid_account_traced(SelectHybridAccountParams::new(&accounts, &health, &token));
        assert_eq!(health.get_score(0usize, None), before_health);
        assert_eq!(token.get_tokens(0usize, None), before_tokens);
    }

    #[test]
    fn traced_agrees_with_plain_selector_on_winning_index() {
        let (health, token) = trackers();
        let now = now_ms();
        token.drain(0usize, None, 30.0);
        let accounts = vec![
            account(0, true, now - 10_000),
            account(1, true, now - 10_000),
            account(2, true, now - 10_000),
        ];
        let plain =
            select_hybrid_account(SelectHybridAccountParams::new(&accounts, &health, &token))
                .map(|a| a.index);
        let traced = select_hybrid_account_traced(SelectHybridAccountParams::new(
            &accounts, &health, &token,
        ));
        assert_eq!(traced.selected.map(|a| a.index), plain);
    }

    // ---------------- utilities ----------------

    #[test]
    fn add_jitter_stays_within_range() {
        let base = 1000.0;
        let factor = 0.2;
        for _ in 0..100 {
            let result = add_jitter(base, factor);
            assert!(result as f64 >= base * (1.0 - factor));
            assert!(result as f64 <= base * (1.0 + factor));
        }
    }

    #[test]
    fn add_jitter_returns_non_negative_values() {
        for _ in 0..100 {
            assert!(add_jitter(10.0, 2.0) >= 0);
        }
    }

    #[test]
    fn random_delay_within_range() {
        for _ in 0..100 {
            let result = random_delay(100.0, 500.0);
            assert!(result >= 100);
            assert!(result <= 500);
        }
    }

    #[test]
    fn exponential_backoff_increases_delay_exponentially() {
        let delay1 = exponential_backoff(ExponentialBackoffOptions {
            attempt: 1.0,
            base_ms: Some(1000.0),
            max_ms: Some(60000.0),
            jitter_factor: Some(0.0),
        })
        .unwrap();
        let delay2 = exponential_backoff(ExponentialBackoffOptions {
            attempt: 2.0,
            base_ms: Some(1000.0),
            max_ms: Some(60000.0),
            jitter_factor: Some(0.0),
        })
        .unwrap();
        let delay3 = exponential_backoff(ExponentialBackoffOptions {
            attempt: 3.0,
            base_ms: Some(1000.0),
            max_ms: Some(60000.0),
            jitter_factor: Some(0.0),
        })
        .unwrap();
        assert_eq!(delay2, delay1 * 2);
        assert_eq!(delay3, delay1 * 4);
    }

    #[test]
    fn exponential_backoff_caps_at_max_ms() {
        let result = exponential_backoff(ExponentialBackoffOptions {
            attempt: 10.0,
            base_ms: Some(1000.0),
            max_ms: Some(5000.0),
            jitter_factor: Some(0.0),
        })
        .unwrap();
        assert_eq!(result, 5000);
    }

    #[test]
    fn exponential_backoff_defaults_match_ts() {
        // attempt only ⇒ base 1000, max 60000, jitter 0.1 (±10 %).
        let result = exponential_backoff(ExponentialBackoffOptions::new(1.0)).unwrap();
        assert!((900..=1100).contains(&result));
    }

    #[test]
    fn exponential_backoff_rejects_invalid_inputs_with_frozen_messages() {
        let attempt_msg = "exponentialBackoff requires attempt to be a positive integer";
        for attempt in [0.0, -1.0, f64::NAN, f64::INFINITY, 1.5] {
            let err = exponential_backoff(ExponentialBackoffOptions {
                attempt,
                base_ms: Some(1000.0),
                max_ms: Some(60000.0),
                jitter_factor: Some(0.1),
            })
            .unwrap_err();
            assert_eq!(err.message(), attempt_msg);
        }

        let err = exponential_backoff(ExponentialBackoffOptions {
            attempt: 1.0,
            base_ms: Some(-1.0),
            max_ms: Some(60000.0),
            jitter_factor: Some(0.1),
        })
        .unwrap_err();
        assert_eq!(
            err.message(),
            "exponentialBackoff requires baseMs to be a finite non-negative number"
        );

        let err = exponential_backoff(ExponentialBackoffOptions {
            attempt: 1.0,
            base_ms: Some(1000.0),
            max_ms: Some(-1.0),
            jitter_factor: Some(0.1),
        })
        .unwrap_err();
        assert_eq!(
            err.message(),
            "exponentialBackoff requires maxMs to be a finite non-negative number"
        );

        let err = exponential_backoff(ExponentialBackoffOptions {
            attempt: 1.0,
            base_ms: None,
            max_ms: None,
            jitter_factor: Some(2.0),
        })
        .unwrap_err();
        assert_eq!(
            err.message(),
            "exponentialBackoff requires jitterFactor to be between 0 and 1"
        );
    }
}
