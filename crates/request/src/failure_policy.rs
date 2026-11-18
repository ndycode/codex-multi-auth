//! Port of `lib/request/failure-policy.ts` — the per-failure-kind decision
//! table consumed by the runtime rotation loop (spec 06 §11).
//!
//! Pure and concurrency-safe: no filesystem access, no logging, no token
//! exposure. Gotcha (spec 06 §27 item 12): a missing `failover_mode` on the
//! INPUT defaults to `Aggressive` here, whereas
//! [`crate::failover_config::parse_failover_mode`] defaults unknown strings to
//! `Balanced`. Both are deliberate.

use cma_core::constants::ACCOUNT_LIMITS;
use cma_core::schemas::account_storage::CooldownReason;

/// TS `FailureKind`. The extra [`FailureKind::Unknown`] variant models the
/// TS `switch` default arm (reachable there only via unsound casts, but its
/// decision row is contractual and test-pinned).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FailureKind {
    AuthRefresh,
    Network,
    Server,
    RateLimit,
    EmptyResponse,
    /// Defensive default row (TS `default:` arm).
    Unknown,
}

/// TS `FailoverMode = "aggressive" | "balanced" | "conservative"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FailoverMode {
    Aggressive,
    Balanced,
    Conservative,
}

impl FailoverMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Aggressive => "aggressive",
            Self::Balanced => "balanced",
            Self::Conservative => "conservative",
        }
    }
}

/// TS `handoffStrategy: "soft" | "hard"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HandoffStrategy {
    Soft,
    Hard,
}

impl HandoffStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Soft => "soft",
            Self::Hard => "hard",
        }
    }
}

/// TS `FailurePolicyInput`. Numeric hints are `f64` because the TS callers
/// may pass arbitrary numbers; the policy floors/clamps exactly like the TS.
#[derive(Clone, Copy, Debug, Default)]
pub struct FailurePolicyInput {
    pub kind: Option<FailureKind>,
    pub consecutive_auth_failures: Option<f64>,
    pub max_auth_failures_before_removal: Option<f64>,
    pub server_retry_after_ms: Option<f64>,
    pub failover_mode: Option<FailoverMode>,
}

impl FailurePolicyInput {
    pub fn for_kind(kind: FailureKind) -> Self {
        Self {
            kind: Some(kind),
            ..Self::default()
        }
    }
}

/// TS `FailurePolicyDecision`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FailurePolicyDecision {
    pub rotate_account: bool,
    pub refund_token: bool,
    pub record_failure: bool,
    pub mark_rate_limited: bool,
    pub remove_account: bool,
    pub cooldown_ms: Option<i64>,
    pub cooldown_reason: Option<CooldownReason>,
    pub retry_same_account: bool,
    pub retry_delay_ms: Option<i64>,
    pub handoff_strategy: HandoffStrategy,
}

/// TS optional second argument to `evaluateFailurePolicy`.
#[derive(Clone, Copy, Debug, Default)]
pub struct FailurePolicyOverrides {
    pub network_cooldown_ms: Option<f64>,
    pub server_cooldown_ms: Option<f64>,
}

const DEFAULT_NETWORK_COOLDOWN_MS: f64 = 6_000.0;
const DEFAULT_SERVER_COOLDOWN_MS: f64 = 4_000.0;

fn network_retry_delay_ms(mode: FailoverMode) -> i64 {
    match mode {
        FailoverMode::Aggressive => 0,
        FailoverMode::Balanced => 250,
        FailoverMode::Conservative => 900,
    }
}

fn empty_response_retry_delay_ms(mode: FailoverMode) -> i64 {
    match mode {
        FailoverMode::Aggressive => 0,
        FailoverMode::Balanced => 200,
        FailoverMode::Conservative => 600,
    }
}

/// TS `getFailoverMode` — input mode or `aggressive` when unset.
fn get_failover_mode(input: &FailurePolicyInput) -> FailoverMode {
    input.failover_mode.unwrap_or(FailoverMode::Aggressive)
}

/// `Math.max(lo, Math.floor(v ?? fallback))`.
fn floored_at_least(value: Option<f64>, fallback: f64, lo: i64) -> i64 {
    let candidate = value.unwrap_or(fallback);
    let floored = if candidate.is_finite() {
        candidate.floor() as i64
    } else if candidate.is_infinite() && candidate > 0.0 {
        i64::MAX
    } else {
        // NaN / -Infinity floor below any finite -> clamps to `lo`.
        i64::MIN
    };
    floored.max(lo)
}

/// Port of TS `evaluateFailurePolicy(input, overrides?)`.
pub fn evaluate_failure_policy(
    input: &FailurePolicyInput,
    overrides: Option<&FailurePolicyOverrides>,
) -> FailurePolicyDecision {
    let overrides = overrides.copied().unwrap_or_default();
    match input.kind {
        Some(FailureKind::AuthRefresh) => {
            let failures = floored_at_least(input.consecutive_auth_failures, 0.0, 0);
            let max_failures = floored_at_least(
                input.max_auth_failures_before_removal,
                ACCOUNT_LIMITS.max_auth_failures_before_removal as f64,
                1,
            );
            FailurePolicyDecision {
                rotate_account: true,
                refund_token: false,
                record_failure: false,
                mark_rate_limited: false,
                remove_account: failures >= max_failures,
                cooldown_ms: Some(ACCOUNT_LIMITS.auth_failure_cooldown_ms),
                cooldown_reason: Some(CooldownReason::AuthFailure),
                retry_same_account: false,
                retry_delay_ms: None,
                handoff_strategy: HandoffStrategy::Hard,
            }
        }
        Some(FailureKind::Network) => {
            let mode = get_failover_mode(input);
            let cooldown_ms = floored_at_least(
                overrides.network_cooldown_ms,
                DEFAULT_NETWORK_COOLDOWN_MS,
                0,
            );
            let retry_delay_ms = network_retry_delay_ms(mode);
            let retry_same_account = retry_delay_ms > 0;
            FailurePolicyDecision {
                rotate_account: !retry_same_account,
                refund_token: true,
                record_failure: true,
                mark_rate_limited: false,
                remove_account: false,
                cooldown_ms: Some(cooldown_ms),
                cooldown_reason: (cooldown_ms > 0).then_some(CooldownReason::NetworkError),
                retry_same_account,
                retry_delay_ms: retry_same_account.then_some(retry_delay_ms),
                handoff_strategy: HandoffStrategy::Soft,
            }
        }
        Some(FailureKind::Server) => {
            let mode = get_failover_mode(input);
            let retry_after_ms = floored_at_least(input.server_retry_after_ms, 0.0, 0);
            let fallback_cooldown =
                floored_at_least(overrides.server_cooldown_ms, DEFAULT_SERVER_COOLDOWN_MS, 0);
            let cooldown_ms = if retry_after_ms > 0 {
                retry_after_ms
            } else {
                fallback_cooldown
            };
            let retry_same_account = mode == FailoverMode::Conservative && retry_after_ms <= 0;
            FailurePolicyDecision {
                rotate_account: !retry_same_account,
                refund_token: true,
                record_failure: true,
                mark_rate_limited: false,
                remove_account: false,
                cooldown_ms: Some(cooldown_ms),
                cooldown_reason: (cooldown_ms > 0).then_some(CooldownReason::ServerError),
                retry_same_account,
                retry_delay_ms: retry_same_account.then_some(500),
                handoff_strategy: HandoffStrategy::Hard,
            }
        }
        Some(FailureKind::RateLimit) => FailurePolicyDecision {
            rotate_account: true,
            refund_token: false,
            record_failure: false,
            mark_rate_limited: true,
            remove_account: false,
            cooldown_ms: None,
            cooldown_reason: None,
            retry_same_account: false,
            retry_delay_ms: None,
            handoff_strategy: HandoffStrategy::Hard,
        },
        Some(FailureKind::EmptyResponse) => {
            let mode = get_failover_mode(input);
            let retry_delay_ms = empty_response_retry_delay_ms(mode);
            let retry_same_account = retry_delay_ms > 0;
            FailurePolicyDecision {
                rotate_account: !retry_same_account,
                refund_token: true,
                record_failure: true,
                mark_rate_limited: false,
                remove_account: false,
                cooldown_ms: None,
                cooldown_reason: None,
                retry_same_account,
                retry_delay_ms: retry_same_account.then_some(retry_delay_ms),
                handoff_strategy: HandoffStrategy::Soft,
            }
        }
        Some(FailureKind::Unknown) | None => FailurePolicyDecision {
            rotate_account: true,
            refund_token: true,
            record_failure: true,
            mark_rate_limited: false,
            remove_account: false,
            cooldown_ms: None,
            cooldown_reason: None,
            retry_same_account: false,
            retry_delay_ms: None,
            handoff_strategy: HandoffStrategy::Hard,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: FailureKind) -> FailurePolicyInput {
        FailurePolicyInput::for_kind(kind)
    }

    #[test]
    fn auth_refresh_removal_boundary() {
        for (failures, remove) in [(0.0, false), (2.0, false), (3.0, true)] {
            let decision = evaluate_failure_policy(
                &FailurePolicyInput {
                    kind: Some(FailureKind::AuthRefresh),
                    consecutive_auth_failures: Some(failures),
                    max_auth_failures_before_removal: Some(3.0),
                    ..Default::default()
                },
                None,
            );
            assert_eq!(decision.remove_account, remove, "failures={failures}");
            assert!(decision.rotate_account);
            assert_eq!(decision.handoff_strategy, HandoffStrategy::Hard);
        }
    }

    #[test]
    fn auth_refresh_removal_sets_cooldown_reason() {
        let decision = evaluate_failure_policy(
            &FailurePolicyInput {
                kind: Some(FailureKind::AuthRefresh),
                consecutive_auth_failures: Some(3.0),
                max_auth_failures_before_removal: Some(3.0),
                ..Default::default()
            },
            None,
        );
        assert!(decision.remove_account);
        assert_eq!(decision.cooldown_reason, Some(CooldownReason::AuthFailure));
        assert_eq!(decision.cooldown_ms, Some(30_000));
    }

    #[test]
    fn network_configured_cooldown_rotates() {
        let decision = evaluate_failure_policy(
            &input(FailureKind::Network),
            Some(&FailurePolicyOverrides {
                network_cooldown_ms: Some(9_000.0),
                ..Default::default()
            }),
        );
        assert!(decision.rotate_account);
        assert!(decision.refund_token);
        assert_eq!(decision.cooldown_ms, Some(9_000));
        assert_eq!(decision.cooldown_reason, Some(CooldownReason::NetworkError));
    }

    #[test]
    fn network_balanced_retries_same_account() {
        let decision = evaluate_failure_policy(
            &FailurePolicyInput {
                kind: Some(FailureKind::Network),
                failover_mode: Some(FailoverMode::Balanced),
                ..Default::default()
            },
            Some(&FailurePolicyOverrides {
                network_cooldown_ms: Some(9_000.0),
                ..Default::default()
            }),
        );
        assert!(decision.retry_same_account);
        assert_eq!(decision.retry_delay_ms, Some(250));
        assert!(!decision.rotate_account);
        assert_eq!(decision.handoff_strategy, HandoffStrategy::Soft);
    }

    #[test]
    fn network_mode_matrix() {
        for (mode, retry_same, delay) in [
            (FailoverMode::Aggressive, false, None),
            (FailoverMode::Balanced, true, Some(250)),
            (FailoverMode::Conservative, true, Some(900)),
        ] {
            let decision = evaluate_failure_policy(
                &FailurePolicyInput {
                    kind: Some(FailureKind::Network),
                    failover_mode: Some(mode),
                    ..Default::default()
                },
                None,
            );
            assert_eq!(decision.retry_same_account, retry_same);
            assert_eq!(decision.retry_delay_ms, delay);
            assert_eq!(decision.rotate_account, !retry_same);
            assert_eq!(decision.handoff_strategy, HandoffStrategy::Soft);
        }
    }

    #[test]
    fn server_mode_matrix_zero_retry_after() {
        for (mode, retry_same, delay, rotate) in [
            (FailoverMode::Aggressive, false, None, true),
            (FailoverMode::Balanced, false, None, true),
            (FailoverMode::Conservative, true, Some(500), false),
        ] {
            let decision = evaluate_failure_policy(
                &FailurePolicyInput {
                    kind: Some(FailureKind::Server),
                    failover_mode: Some(mode),
                    server_retry_after_ms: Some(0.0),
                    ..Default::default()
                },
                None,
            );
            assert_eq!(decision.retry_same_account, retry_same);
            assert_eq!(decision.retry_delay_ms, delay);
            assert_eq!(decision.rotate_account, rotate);
            assert_eq!(decision.handoff_strategy, HandoffStrategy::Hard);
        }
    }

    #[test]
    fn server_conservative_without_retry_after_retries_same() {
        let decision = evaluate_failure_policy(
            &FailurePolicyInput {
                kind: Some(FailureKind::Server),
                failover_mode: Some(FailoverMode::Conservative),
                ..Default::default()
            },
            Some(&FailurePolicyOverrides {
                server_cooldown_ms: Some(4_000.0),
                ..Default::default()
            }),
        );
        assert!(decision.retry_same_account);
        assert_eq!(decision.retry_delay_ms, Some(500));
        assert!(!decision.rotate_account);
        assert_eq!(decision.cooldown_reason, Some(CooldownReason::ServerError));
    }

    #[test]
    fn server_rotates_when_retry_after_provided() {
        let decision = evaluate_failure_policy(
            &FailurePolicyInput {
                kind: Some(FailureKind::Server),
                failover_mode: Some(FailoverMode::Conservative),
                server_retry_after_ms: Some(3_000.0),
                ..Default::default()
            },
            None,
        );
        assert!(!decision.retry_same_account);
        assert!(decision.rotate_account);
        assert_eq!(decision.cooldown_ms, Some(3_000));
        assert_eq!(decision.cooldown_reason, Some(CooldownReason::ServerError));
    }

    #[test]
    fn rate_limit_marks_without_cooldown() {
        let decision = evaluate_failure_policy(&input(FailureKind::RateLimit), None);
        assert!(decision.mark_rate_limited);
        assert!(!decision.refund_token);
        assert_eq!(decision.cooldown_ms, None);
    }

    #[test]
    fn empty_response_mode_matrix() {
        for (mode, retry_same, delay) in [
            (FailoverMode::Aggressive, false, None),
            (FailoverMode::Balanced, true, Some(200)),
            (FailoverMode::Conservative, true, Some(600)),
        ] {
            let decision = evaluate_failure_policy(
                &FailurePolicyInput {
                    kind: Some(FailureKind::EmptyResponse),
                    failover_mode: Some(mode),
                    ..Default::default()
                },
                None,
            );
            assert_eq!(decision.retry_same_account, retry_same);
            assert_eq!(decision.retry_delay_ms, delay);
            assert_eq!(decision.rotate_account, !retry_same);
            assert_eq!(decision.handoff_strategy, HandoffStrategy::Soft);
        }
    }

    #[test]
    fn zero_override_cooldowns_clear_reason() {
        let network = evaluate_failure_policy(
            &FailurePolicyInput {
                kind: Some(FailureKind::Network),
                failover_mode: Some(FailoverMode::Aggressive),
                ..Default::default()
            },
            Some(&FailurePolicyOverrides {
                network_cooldown_ms: Some(0.0),
                ..Default::default()
            }),
        );
        let server = evaluate_failure_policy(
            &FailurePolicyInput {
                kind: Some(FailureKind::Server),
                failover_mode: Some(FailoverMode::Aggressive),
                server_retry_after_ms: Some(0.0),
                ..Default::default()
            },
            Some(&FailurePolicyOverrides {
                server_cooldown_ms: Some(0.0),
                ..Default::default()
            }),
        );
        assert_eq!(network.cooldown_ms, Some(0));
        assert_eq!(network.cooldown_reason, None);
        assert_eq!(server.cooldown_ms, Some(0));
        assert_eq!(server.cooldown_reason, None);
    }

    #[test]
    fn unknown_kind_falls_back_to_hard_default() {
        for probe in [input(FailureKind::Unknown), FailurePolicyInput::default()] {
            let decision = evaluate_failure_policy(&probe, None);
            assert!(decision.rotate_account);
            assert!(decision.refund_token);
            assert!(decision.record_failure);
            assert!(!decision.remove_account);
            assert!(!decision.retry_same_account);
            assert_eq!(decision.handoff_strategy, HandoffStrategy::Hard);
        }
    }

    #[test]
    fn missing_failover_mode_defaults_to_aggressive() {
        // Gotcha 12: input default is aggressive (0-delay -> immediate rotate).
        let decision = evaluate_failure_policy(&input(FailureKind::Network), None);
        assert!(!decision.retry_same_account);
        assert!(decision.rotate_account);
    }
}
