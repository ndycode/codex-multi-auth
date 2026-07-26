//! Port of `lib/health.ts` — a PURE shape-transformation utility producing
//! the `PluginHealth` report (AUDIT-M08/D-04).
//!
//! Callers pass an already-flattened accounts array; the field-name mapping
//! the caller must perform from `ManagedAccount` (kept in docs):
//!
//! | [`HealthAccountInput`] field | `ManagedAccount` source                          |
//! |------------------------------|--------------------------------------------------|
//! | `rate_limited_until`         | computed from `rateLimitResetTimes` per family   |
//! | `cooldown_until`             | `coolingDownUntil`                               |
//! | `last_used_at`               | `lastUsed`                                       |
//! | `health`                     | computed from `getHealthTracker().getScore()`    |
//!
//! Side effect (spec 05 gotcha 18): fetching a circuit breaker CREATES one
//! in the global registry when absent (registry FIFO-capped).

use cma_core::json_io::format_js_number;
use cma_rotation::circuit_breaker::{CircuitState, get_circuit_breaker};
use cma_storage::identity::{AccountIdentityLike, get_account_identity_key};

/// One flattened account row (the TS inline parameter shape).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HealthAccountInput {
    pub index: usize,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub refresh_token: Option<String>,
    /// Health score 0..=100 (tracker-derived; may be fractional).
    pub health: f64,
    pub rate_limited_until: Option<i64>,
    pub cooldown_until: Option<i64>,
    pub cooldown_reason: Option<String>,
    pub last_used_at: Option<i64>,
}

impl AccountIdentityLike for HealthAccountInput {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }
}

/// TS `AccountHealth`. (No `Serialize`: `CircuitState` is rotation runtime
/// state and stays compiler-enforced non-serializable — render via
/// [`format_health_report`] or map manually.)
#[derive(Clone, Debug, PartialEq)]
pub struct AccountHealth {
    pub index: usize,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub health: f64,
    pub is_rate_limited: bool,
    pub is_cooling_down: bool,
    pub cooldown_reason: Option<String>,
    pub last_used: Option<i64>,
    pub circuit_state: CircuitState,
}

/// TS `PluginHealth["status"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginHealthStatus {
    Healthy,
    Degraded,
    Unhealthy,
}

impl PluginHealthStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            PluginHealthStatus::Healthy => "healthy",
            PluginHealthStatus::Degraded => "degraded",
            PluginHealthStatus::Unhealthy => "unhealthy",
        }
    }
}

impl std::fmt::Display for PluginHealthStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// TS `PluginHealth`.
#[derive(Clone, Debug, PartialEq)]
pub struct PluginHealth {
    pub status: PluginHealthStatus,
    pub account_count: usize,
    pub healthy_account_count: usize,
    pub rate_limited_count: usize,
    pub cooling_down_count: usize,
    pub accounts: Vec<AccountHealth>,
    pub timestamp: i64,
}

/// TS `getAccountHealth(accounts, now = Date.now())`.
///
/// A healthy account is not rate-limited, not cooling down, `health >= 50`,
/// and has a CLOSED circuit. Status: no healthy among a non-empty pool →
/// `unhealthy`; some unhealthy → `degraded`; else `healthy` (empty input is
/// `healthy`).
pub fn get_account_health(accounts: &[HealthAccountInput], now: Option<i64>) -> PluginHealth {
    let now = now.unwrap_or_else(cma_core::utils::now_ms);
    let account_healths: Vec<AccountHealth> = accounts
        .iter()
        .map(|acc| {
            let circuit_key =
                get_account_identity_key(acc).unwrap_or_else(|| format!("account:{}", acc.index));
            // Side effect: creates the breaker in the global registry when
            // absent (FIFO-capped).
            let circuit = get_circuit_breaker(&circuit_key, None);
            AccountHealth {
                index: acc.index,
                email: acc.email.clone(),
                account_id: acc.account_id.clone(),
                health: acc.health,
                is_rate_limited: acc.rate_limited_until.unwrap_or(0) > now,
                is_cooling_down: acc.cooldown_until.unwrap_or(0) > now,
                cooldown_reason: acc.cooldown_reason.clone(),
                last_used: acc.last_used_at,
                circuit_state: circuit.get_state(),
            }
        })
        .collect();

    let healthy_count = account_healths
        .iter()
        .filter(|a| {
            !a.is_rate_limited
                && !a.is_cooling_down
                && a.health >= 50.0
                && a.circuit_state == CircuitState::Closed
        })
        .count();
    let rate_limited_count = account_healths.iter().filter(|a| a.is_rate_limited).count();
    let cooling_down_count = account_healths.iter().filter(|a| a.is_cooling_down).count();

    let status = if healthy_count == 0 && !accounts.is_empty() {
        PluginHealthStatus::Unhealthy
    } else if healthy_count < accounts.len() {
        PluginHealthStatus::Degraded
    } else {
        PluginHealthStatus::Healthy
    };

    PluginHealth {
        status,
        account_count: accounts.len(),
        healthy_account_count: healthy_count,
        rate_limited_count,
        cooling_down_count,
        accounts: account_healths,
        timestamp: now,
    }
}

/// TS `formatHealthReport(health)` — exact lines joined by `"\n"` (FROZEN
/// user-visible strings).
pub fn format_health_report(health: &PluginHealth) -> String {
    let mut lines: Vec<String> = vec![
        format!("Plugin Health: {}", health.status.as_str().to_uppercase()),
        String::new(),
        format!(
            "Accounts: {}/{} healthy",
            health.healthy_account_count, health.account_count
        ),
    ];

    if health.rate_limited_count > 0 {
        lines.push(format!("Rate Limited: {}", health.rate_limited_count));
    }
    if health.cooling_down_count > 0 {
        lines.push(format!("Cooling Down: {}", health.cooling_down_count));
    }

    if !health.accounts.is_empty() {
        lines.push(String::new());
        lines.push("Account Details:".to_string());
        for acc in &health.accounts {
            let email = acc
                .email
                .clone()
                .unwrap_or_else(|| format!("Account {}", acc.index + 1));
            let mut flags: Vec<String> = Vec::new();
            if acc.is_rate_limited {
                flags.push("rate-limited".to_string());
            }
            if acc.is_cooling_down {
                flags.push(format!(
                    "cooling-{}",
                    acc.cooldown_reason.as_deref().unwrap_or("down")
                ));
            }
            if acc.circuit_state != CircuitState::Closed {
                flags.push(format!("circuit-{}", acc.circuit_state.as_str()));
            }
            let flag_str = if flags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", flags.join(", "))
            };
            lines.push(format!(
                "  [{}] {}: {}%{}",
                acc.index + 1,
                email,
                format_js_number(acc.health),
                flag_str
            ));
        }
    }

    lines.join("\n")
}

// ============================================================================
// Tests — ported from test/health.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_rotation::circuit_breaker::reset_all_circuit_breakers;
    use serial_test::serial;

    const NOW: i64 = 1_700_000_000_000;

    fn input(index: usize, health: f64) -> HealthAccountInput {
        HealthAccountInput {
            index,
            email: Some(format!("user{index}@example.com")),
            account_id: Some(format!("acc_{index}")),
            health,
            ..HealthAccountInput::default()
        }
    }

    #[test]
    #[serial(circuit)]
    fn returns_healthy_status_when_all_accounts_are_good() {
        reset_all_circuit_breakers();
        let health = get_account_health(&[input(0, 100.0), input(1, 80.0)], Some(NOW));
        assert_eq!(health.status, PluginHealthStatus::Healthy);
        assert_eq!(health.account_count, 2);
        assert_eq!(health.healthy_account_count, 2);
        assert_eq!(health.timestamp, NOW);
    }

    #[test]
    #[serial(circuit)]
    fn returns_degraded_status_when_some_accounts_are_rate_limited() {
        reset_all_circuit_breakers();
        let mut limited = input(1, 100.0);
        limited.rate_limited_until = Some(NOW + 60_000);
        let health = get_account_health(&[input(0, 100.0), limited], Some(NOW));
        assert_eq!(health.status, PluginHealthStatus::Degraded);
        assert_eq!(health.healthy_account_count, 1);
        assert_eq!(health.rate_limited_count, 1);
    }

    #[test]
    #[serial(circuit)]
    fn returns_unhealthy_status_when_all_accounts_are_unavailable() {
        reset_all_circuit_breakers();
        let mut a = input(0, 100.0);
        a.rate_limited_until = Some(NOW + 60_000);
        let mut b = input(1, 100.0);
        b.cooldown_until = Some(NOW + 60_000);
        let health = get_account_health(&[a, b], Some(NOW));
        assert_eq!(health.status, PluginHealthStatus::Unhealthy);
        assert_eq!(health.healthy_account_count, 0);
        assert_eq!(health.cooling_down_count, 1);
    }

    #[test]
    #[serial(circuit)]
    fn returns_healthy_for_empty_accounts() {
        reset_all_circuit_breakers();
        let health = get_account_health(&[], Some(NOW));
        assert_eq!(health.status, PluginHealthStatus::Healthy);
        assert_eq!(health.account_count, 0);
    }

    #[test]
    #[serial(circuit)]
    fn marks_low_health_accounts_as_not_healthy() {
        reset_all_circuit_breakers();
        let health = get_account_health(&[input(0, 49.0)], Some(NOW));
        assert_eq!(health.status, PluginHealthStatus::Unhealthy);
        // Boundary: exactly 50 counts as healthy.
        let health = get_account_health(&[input(0, 50.0)], Some(NOW));
        assert_eq!(health.status, PluginHealthStatus::Healthy);
    }

    #[test]
    #[serial(circuit)]
    fn includes_circuit_breaker_state_in_account_health() {
        reset_all_circuit_breakers();
        let health = get_account_health(&[input(0, 100.0)], Some(NOW));
        assert_eq!(health.accounts[0].circuit_state, CircuitState::Closed);
    }

    #[test]
    #[serial(circuit)]
    fn does_not_count_circuit_open_accounts_as_healthy() {
        reset_all_circuit_breakers();
        let acc = input(0, 100.0);
        // Force the account's breaker open (3 failures in the window). The
        // registry key must match what getAccountHealth derives.
        let key = get_account_identity_key(&acc).expect("identity key");
        let breaker = get_circuit_breaker(&key, None);
        breaker.record_failure();
        breaker.record_failure();
        breaker.record_failure();

        let health = get_account_health(&[acc], Some(NOW));
        assert_eq!(health.accounts[0].circuit_state, CircuitState::Open);
        assert_eq!(health.healthy_account_count, 0);
        assert_eq!(health.status, PluginHealthStatus::Unhealthy);
    }

    #[test]
    #[serial(circuit)]
    fn falls_back_to_an_index_scoped_circuit_key_without_identity() {
        reset_all_circuit_breakers();
        let anonymous = HealthAccountInput {
            index: 3,
            health: 100.0,
            ..HealthAccountInput::default()
        };
        // No identity fields at all → "account:{index}" key; must not panic
        // and must stay healthy with a fresh (closed) breaker.
        let health = get_account_health(&[anonymous], Some(NOW));
        assert_eq!(health.status, PluginHealthStatus::Healthy);
        assert_eq!(health.accounts[0].circuit_state, CircuitState::Closed);
    }

    #[test]
    #[serial(circuit)]
    fn formats_health_report_correctly() {
        reset_all_circuit_breakers();
        let mut limited = HealthAccountInput {
            index: 1,
            health: 30.0,
            ..HealthAccountInput::default()
        };
        limited.rate_limited_until = Some(NOW + 60_000);
        let mut cooling = HealthAccountInput {
            index: 2,
            health: 75.5,
            ..HealthAccountInput::default()
        };
        cooling.cooldown_until = Some(NOW + 60_000);
        cooling.cooldown_reason = Some("auth".to_string());
        let healthy = HealthAccountInput {
            index: 0,
            email: Some("a@b.com".to_string()),
            health: 100.0,
            ..HealthAccountInput::default()
        };

        let health = get_account_health(&[healthy, limited, cooling], Some(NOW));
        let report = format_health_report(&health);
        assert_eq!(
            report,
            "Plugin Health: DEGRADED\n\
             \n\
             Accounts: 1/3 healthy\n\
             Rate Limited: 1\n\
             Cooling Down: 1\n\
             \n\
             Account Details:\n\
             \x20 [1] a@b.com: 100%\n\
             \x20 [2] Account 2: 30% [rate-limited]\n\
             \x20 [3] Account 3: 75.5% [cooling-auth]"
        );
    }
}
