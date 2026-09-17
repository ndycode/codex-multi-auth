//! Port of `lib/request/request-resilience.ts` — per-process pool-exhaustion
//! and server-burst cooldowns plus the adaptive stream-failover candidate
//! order (spec 06 §17).
//!
//! **CRITICAL anti-requirement (spec 06 §23):** this is per-process in-memory
//! state only; it must NEVER be serialized into persisted account/rate-limit
//! files. No type here implements `Serialize`.
//!
//! Every entry point takes an explicit `now` (epoch ms) — the TS default of
//! `Date.now()` is supplied by callers via `cma_core::utils::now_ms()`.

use std::collections::HashSet;
use std::sync::Mutex;

use cma_core::schemas::account_storage::RateLimitStateV3;

const POOL_EXHAUSTION_COOLDOWN_MS: i64 = 15_000;
const SERVER_BURST_COOLDOWN_MS: i64 = 10_000;
const SERVER_BURST_THRESHOLD: usize = 3;

#[derive(Debug)]
struct ServerBurstState {
    window_started_at: i64,
    account_indices: HashSet<usize>,
    cooldown_until: Option<i64>,
}

impl ServerBurstState {
    fn cleared() -> Self {
        Self {
            window_started_at: 0,
            account_indices: HashSet::new(),
            cooldown_until: None,
        }
    }
}

static POOL_EXHAUSTION_COOLDOWN_UNTIL: Mutex<Option<i64>> = Mutex::new(None);
static SERVER_BURST_STATE: Mutex<Option<ServerBurstState>> = Mutex::new(None);

fn with_burst_state<T>(f: impl FnOnce(&mut ServerBurstState) -> T) -> T {
    let mut guard = SERVER_BURST_STATE
        .lock()
        .expect("server burst state poisoned");
    f(guard.get_or_insert_with(ServerBurstState::cleared))
}

/// TS `getPoolExhaustionCooldownRemaining(now)` — 0 when unset/expired.
pub fn get_pool_exhaustion_cooldown_remaining(now: i64) -> i64 {
    let guard = POOL_EXHAUSTION_COOLDOWN_UNTIL
        .lock()
        .expect("pool exhaustion cooldown poisoned");
    match *guard {
        Some(until) if until > now => until - now,
        _ => 0,
    }
}

/// TS `armPoolExhaustionCooldown(waitMs, now)` — `bounded = max(15_000,
/// floor(waitMs))`; the expiry is MONOTONIC (`max(existing, now + bounded)` —
/// re-arming with a shorter wait never shortens it). Returns the expiry.
pub fn arm_pool_exhaustion_cooldown(wait_ms: f64, now: i64) -> i64 {
    let bounded = if wait_ms.is_finite() {
        (wait_ms.floor() as i64).max(POOL_EXHAUSTION_COOLDOWN_MS)
    } else if wait_ms.is_infinite() && wait_ms > 0.0 {
        i64::MAX - now // Math.floor(Infinity) stays Infinity in TS; saturate.
    } else {
        POOL_EXHAUSTION_COOLDOWN_MS
    };
    let next_expiry = now.saturating_add(bounded);
    let mut guard = POOL_EXHAUSTION_COOLDOWN_UNTIL
        .lock()
        .expect("pool exhaustion cooldown poisoned");
    let updated = guard.unwrap_or(0).max(next_expiry);
    *guard = Some(updated);
    updated
}

/// TS `clearPoolExhaustionCooldown()`.
pub fn clear_pool_exhaustion_cooldown() {
    *POOL_EXHAUSTION_COOLDOWN_UNTIL
        .lock()
        .expect("pool exhaustion cooldown poisoned") = None;
}

/// TS `getServerBurstCooldownRemaining(now)`.
pub fn get_server_burst_cooldown_remaining(now: i64) -> i64 {
    with_burst_state(|state| match state.cooldown_until {
        Some(until) if until > now => until - now,
        _ => 0,
    })
}

/// TS `recordServerBurstFailure(accountIndex, now)`.
///
/// While a cooldown is active it is returned unchanged (no accumulation).
/// A window older than 10 s (with no active cooldown) resets the window.
/// Once >= 3 DISTINCT account indices fail inside the window, the 10 s
/// cooldown arms. Returns `cooldown_until ?? 0`.
pub fn record_server_burst_failure(account_index: usize, now: i64) -> i64 {
    with_burst_state(|state| {
        if let Some(until) = state.cooldown_until
            && until > now
        {
            return until;
        }
        let cooldown_expired = match state.cooldown_until {
            None => true,
            Some(until) => until <= now,
        };
        if cooldown_expired && now - state.window_started_at > SERVER_BURST_COOLDOWN_MS {
            *state = ServerBurstState {
                window_started_at: now,
                account_indices: HashSet::new(),
                cooldown_until: None,
            };
        }
        if state.window_started_at == 0 {
            state.window_started_at = now;
        }
        state.account_indices.insert(account_index);
        if state.account_indices.len() >= SERVER_BURST_THRESHOLD {
            state.cooldown_until = Some(now + SERVER_BURST_COOLDOWN_MS);
        }
        state.cooldown_until.unwrap_or(0)
    })
}

/// TS `clearServerBurstCooldown()`.
pub fn clear_server_burst_cooldown() {
    *SERVER_BURST_STATE
        .lock()
        .expect("server burst state poisoned") = Some(ServerBurstState::cleared());
}

/// The `Pick<ManagedAccount, ...>` slice consumed by
/// [`build_adaptive_stream_failover_candidate_order`]. Callers map their
/// `cma_accounts::ManagedAccount`s into this shape (`index`,
/// `last_used`, `enabled`, `cooling_down_until`, `rate_limit_reset_times`).
#[derive(Clone, Debug, Default)]
pub struct AdaptiveFailoverAccount {
    pub index: usize,
    pub last_used: Option<i64>,
    /// TS convention: only an explicit `false` disables.
    pub enabled: Option<bool>,
    pub cooling_down_until: Option<i64>,
    pub rate_limit_reset_times: RateLimitStateV3,
}

/// TS `buildAdaptiveStreamFailoverCandidateOrder(primaryIndex, accounts, now)`.
///
/// Alternates are accounts other than the primary that are not explicitly
/// disabled, not cooling down, and hold NO rate-limit reset time in the
/// future; sorted most-recently-used first (stable), take 1. The primary is
/// always first (its own index when present in the snapshot, else
/// `primary_index`).
pub fn build_adaptive_stream_failover_candidate_order(
    primary_index: usize,
    accounts: &[AdaptiveFailoverAccount],
    now: i64,
) -> Vec<usize> {
    let primary = accounts.iter().find(|account| account.index == primary_index);
    let mut alternates: Vec<&AdaptiveFailoverAccount> = accounts
        .iter()
        .filter(|account| account.index != primary_index && account.enabled != Some(false))
        .filter(|account| {
            if account.cooling_down_until.unwrap_or(0) > now {
                return false;
            }
            !account
                .rate_limit_reset_times
                .iter()
                .any(|(_, value)| value > now)
        })
        .collect();
    // JS `Array.prototype.sort` is stable; sort lastUsed DESC.
    alternates.sort_by_key(|account| std::cmp::Reverse(account.last_used.unwrap_or(0)));
    let mut order = vec![primary.map(|account| account.index).unwrap_or(primary_index)];
    order.extend(alternates.iter().take(1).map(|account| account.index));
    order
}

/// TS `resetRequestResilienceStateForTests()`.
pub fn reset_request_resilience_state_for_tests() {
    clear_pool_exhaustion_cooldown();
    clear_server_burst_cooldown();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn base_now() -> i64 {
        // Date.parse("2026-04-06T00:00:00.000Z")
        chrono::DateTime::parse_from_rfc3339("2026-04-06T00:00:00.000Z")
            .expect("valid date")
            .timestamp_millis()
    }

    #[test]
    #[serial(request_resilience)]
    fn arms_and_clears_the_pool_exhaustion_cooldown() {
        reset_request_resilience_state_for_tests();
        let now = base_now();
        arm_pool_exhaustion_cooldown(5_000.0, now);
        // The 15s floor applies: 15_000 - 1_000 elapsed = 14_000.
        assert_eq!(get_pool_exhaustion_cooldown_remaining(now + 1_000), 14_000);
        clear_pool_exhaustion_cooldown();
        assert_eq!(get_pool_exhaustion_cooldown_remaining(now + 1_000), 0);
    }

    #[test]
    #[serial(request_resilience)]
    fn keeps_pool_exhaustion_cooldown_monotonic_on_shorter_rearm() {
        reset_request_resilience_state_for_tests();
        let now = base_now();
        let first = arm_pool_exhaustion_cooldown(30_000.0, now);
        let second = arm_pool_exhaustion_cooldown(5_000.0, now + 1_000);
        assert_eq!(second, first);
        assert_eq!(get_pool_exhaustion_cooldown_remaining(now + 2_000), 28_000);
    }

    #[test]
    #[serial(request_resilience)]
    fn arms_server_burst_cooldown_after_multi_account_5xx_failures() {
        reset_request_resilience_state_for_tests();
        let now = base_now();
        assert_eq!(record_server_burst_failure(0, now), 0);
        assert_eq!(record_server_burst_failure(1, now + 500), 0);
        let cooldown_until = record_server_burst_failure(2, now + 1_000);
        assert!(cooldown_until > now + 1_000);
        assert!(get_server_burst_cooldown_remaining(now + 2_000) > 0);
        clear_server_burst_cooldown();
        assert_eq!(get_server_burst_cooldown_remaining(now + 2_000), 0);
    }

    #[test]
    #[serial(request_resilience)]
    fn same_account_repeats_do_not_arm_the_burst_cooldown() {
        reset_request_resilience_state_for_tests();
        let now = base_now();
        assert_eq!(record_server_burst_failure(0, now), 0);
        assert_eq!(record_server_burst_failure(0, now + 100), 0);
        assert_eq!(record_server_burst_failure(0, now + 200), 0);
        assert_eq!(get_server_burst_cooldown_remaining(now + 300), 0);
    }

    #[test]
    #[serial(request_resilience)]
    fn keeps_armed_burst_cooldown_active_across_later_failures() {
        reset_request_resilience_state_for_tests();
        let now = base_now();
        assert_eq!(record_server_burst_failure(0, now), 0);
        assert_eq!(record_server_burst_failure(1, now + 5_000), 0);
        let cooldown_until = record_server_burst_failure(2, now + 9_000);
        assert!(cooldown_until > now + 9_000);

        let later_failure = record_server_burst_failure(3, now + 12_000);
        assert_eq!(later_failure, cooldown_until);
        assert!(get_server_burst_cooldown_remaining(now + 12_500) > 0);
    }

    #[test]
    #[serial(request_resilience)]
    fn stale_window_resets_before_counting() {
        reset_request_resilience_state_for_tests();
        let now = base_now();
        assert_eq!(record_server_burst_failure(0, now), 0);
        assert_eq!(record_server_burst_failure(1, now + 1_000), 0);
        // > 10s later: the window resets, so this is failure #1 of a new window.
        assert_eq!(record_server_burst_failure(2, now + 12_000), 0);
        assert_eq!(get_server_burst_cooldown_remaining(now + 12_100), 0);
    }

    fn account(
        index: usize,
        last_used: i64,
        cooling_down_until: Option<i64>,
    ) -> AdaptiveFailoverAccount {
        AdaptiveFailoverAccount {
            index,
            last_used: Some(last_used),
            enabled: Some(true),
            cooling_down_until,
            rate_limit_reset_times: RateLimitStateV3::new(),
        }
    }

    #[test]
    fn prefers_freshest_eligible_alternate_for_stream_failover() {
        let now = base_now();
        let accounts = vec![
            account(0, now - 5_000, None),
            account(1, now - 20_000, None),
            account(2, now - 1_000, None),
            account(3, now, Some(now + 10_000)),
        ];
        assert_eq!(
            build_adaptive_stream_failover_candidate_order(0, &accounts, now),
            vec![0, 2]
        );
    }

    #[test]
    fn skips_rate_limited_and_disabled_alternates() {
        let now = base_now();
        let mut rate_limited = account(1, now, None);
        rate_limited
            .rate_limit_reset_times
            .insert("gpt-5.2", now + 60_000);
        let disabled = AdaptiveFailoverAccount {
            enabled: Some(false),
            ..account(2, now, None)
        };
        let ok = account(3, now - 50_000, None);
        let accounts = vec![account(0, now, None), rate_limited, disabled, ok.clone()];
        assert_eq!(
            build_adaptive_stream_failover_candidate_order(0, &accounts, now),
            vec![0, 3]
        );
    }

    #[test]
    fn missing_primary_falls_back_to_requested_index() {
        let now = base_now();
        let accounts = vec![account(4, now, None)];
        assert_eq!(
            build_adaptive_stream_failover_candidate_order(9, &accounts, now),
            vec![9, 4]
        );
    }
}
