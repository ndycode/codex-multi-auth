//! Port of `lib/auth-rate-limit.ts` — in-memory sliding-window limiter for
//! interactive auth (login) attempts.
//!
//! Behavior source: specs/04-rotation.md §3.
//!
//! Module-level mutable state (a map and a config object) — process-wide
//! singleton semantics, exactly like the TS module. Keys are
//! `accountId.toLowerCase().trim()`. Timestamps strictly greater than
//! `now - windowMs` are kept by the prune (`> cutoff`).
//!
//! NEVER persisted; in-memory only.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use cma_core::utils::now_ms;

/// `AuthRateLimitConfig` — `{ maxAttempts, windowMs }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthRateLimitConfig {
    pub max_attempts: u32,
    pub window_ms: i64,
}

/// Private default `{ maxAttempts: 5, windowMs: 60_000 }`.
const DEFAULT_CONFIG: AuthRateLimitConfig = AuthRateLimitConfig {
    max_attempts: 5,
    window_ms: 60_000,
};

/// Partial-config patch for [`configure_auth_rate_limit`] (TS
/// `Partial<AuthRateLimitConfig>`).
#[derive(Clone, Copy, Debug, Default)]
pub struct AuthRateLimitConfigPatch {
    pub max_attempts: Option<u32>,
    pub window_ms: Option<i64>,
}

struct LimiterState {
    config: AuthRateLimitConfig,
    /// `attemptsByAccount` — timestamps of recorded attempts per lowercased
    /// account key.
    attempts_by_account: HashMap<String, Vec<i64>>,
}

static STATE: LazyLock<Mutex<LimiterState>> = LazyLock::new(|| {
    Mutex::new(LimiterState {
        config: DEFAULT_CONFIG,
        attempts_by_account: HashMap::new(),
    })
});

fn lock_state() -> MutexGuard<'static, LimiterState> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `configureAuthRateLimit(newConfig)` — merges into the current config.
/// Persists across calls; NOT reset by [`reset_all_auth_rate_limits`].
pub fn configure_auth_rate_limit(patch: AuthRateLimitConfigPatch) {
    let mut state = lock_state();
    if let Some(max_attempts) = patch.max_attempts {
        state.config.max_attempts = max_attempts;
    }
    if let Some(window_ms) = patch.window_ms {
        state.config.window_ms = window_ms;
    }
}

/// `getAuthRateLimitConfig()` — returns a copy.
pub fn get_auth_rate_limit_config() -> AuthRateLimitConfig {
    lock_state().config
}

/// `getAccountKey` — `accountId.toLowerCase().trim()`.
fn account_key(account_id: &str) -> String {
    account_id.to_lowercase().trim().to_string()
}

/// `pruneOldAttempts` — keep only timestamps strictly greater than
/// `now - windowMs` (mutates the stored record, as in TS).
fn prune_old_attempts(timestamps: &mut Vec<i64>, window_ms: i64, now: i64) {
    let cutoff = now - window_ms;
    timestamps.retain(|ts| *ts > cutoff);
}

/// `canAttemptAuth(accountId)` — unknown key ⇒ true; else prune, then
/// `count < maxAttempts`.
pub fn can_attempt_auth(account_id: &str) -> bool {
    can_attempt_auth_at(account_id, now_ms())
}

/// [`can_attempt_auth`] with an injectable clock (tests).
pub fn can_attempt_auth_at(account_id: &str, now: i64) -> bool {
    let key = account_key(account_id);
    let mut state = lock_state();
    let LimiterState {
        config,
        attempts_by_account,
    } = &mut *state;
    let Some(record) = attempts_by_account.get_mut(&key) else {
        return true;
    };
    prune_old_attempts(record, config.window_ms, now);
    (record.len() as u32) < config.max_attempts
}

/// `recordAuthAttempt(accountId)` — prune then push `now`. No cap enforcement
/// here; callers should check first.
pub fn record_auth_attempt(account_id: &str) {
    record_auth_attempt_at(account_id, now_ms());
}

/// [`record_auth_attempt`] with an injectable clock (tests).
pub fn record_auth_attempt_at(account_id: &str, now: i64) {
    let key = account_key(account_id);
    let mut state = lock_state();
    let LimiterState {
        config,
        attempts_by_account,
    } = &mut *state;
    let record = attempts_by_account.entry(key).or_default();
    prune_old_attempts(record, config.window_ms, now);
    record.push(now);
}

/// `getAttemptsRemaining(accountId)` — `max(0, maxAttempts - count)` after
/// prune; unknown key ⇒ `maxAttempts`.
pub fn get_attempts_remaining(account_id: &str) -> u32 {
    get_attempts_remaining_at(account_id, now_ms())
}

/// [`get_attempts_remaining`] with an injectable clock (tests).
pub fn get_attempts_remaining_at(account_id: &str, now: i64) -> u32 {
    let key = account_key(account_id);
    let mut state = lock_state();
    let LimiterState {
        config,
        attempts_by_account,
    } = &mut *state;
    let Some(record) = attempts_by_account.get_mut(&key) else {
        return config.max_attempts;
    };
    prune_old_attempts(record, config.window_ms, now);
    config.max_attempts.saturating_sub(record.len() as u32)
}

/// `getTimeUntilReset(accountId)` — 0 when no live attempts; else
/// `max(0, min(timestamps) + windowMs - now)` after prune.
pub fn get_time_until_reset(account_id: &str) -> i64 {
    get_time_until_reset_at(account_id, now_ms())
}

/// [`get_time_until_reset`] with an injectable clock (tests).
pub fn get_time_until_reset_at(account_id: &str, now: i64) -> i64 {
    let key = account_key(account_id);
    let mut state = lock_state();
    let LimiterState {
        config,
        attempts_by_account,
    } = &mut *state;
    let Some(record) = attempts_by_account.get_mut(&key) else {
        return 0;
    };
    if record.is_empty() {
        return 0;
    }
    prune_old_attempts(record, config.window_ms, now);
    if record.is_empty() {
        return 0;
    }
    let oldest_attempt = record.iter().copied().min().unwrap_or(now);
    let reset_time = oldest_attempt + config.window_ms;
    (reset_time - now).max(0)
}

/// `resetAuthRateLimit(accountId)` — delete the account's record.
pub fn reset_auth_rate_limit(account_id: &str) {
    let key = account_key(account_id);
    lock_state().attempts_by_account.remove(&key);
}

/// `resetAllAuthRateLimits()` — clear the map (config untouched).
pub fn reset_all_auth_rate_limits() {
    lock_state().attempts_by_account.clear();
}

/// `AuthRateLimitError` — message deliberately omits the accountId:
/// `` `Auth rate limit exceeded for account. Retry after ${ceil(resetAfterMs/1000)}s` ``.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthRateLimitError {
    pub account_id: String,
    pub attempts_remaining: u32,
    pub reset_after_ms: i64,
    message: String,
}

impl AuthRateLimitError {
    pub fn new(account_id: impl Into<String>, attempts_remaining: u32, reset_after_ms: i64) -> Self {
        let reset_seconds = (reset_after_ms as f64 / 1000.0).ceil() as i64;
        Self {
            account_id: account_id.into(),
            attempts_remaining,
            reset_after_ms,
            message: format!(
                "Auth rate limit exceeded for account. Retry after {reset_seconds}s"
            ),
        }
    }

    /// TS `error.name`.
    pub fn name(&self) -> &'static str {
        "AuthRateLimitError"
    }

    /// TS `error.message`.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for AuthRateLimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AuthRateLimitError {}

/// `checkAuthRateLimit(accountId)` — Err(`AuthRateLimitError`) when
/// `!canAttemptAuth(accountId)`.
pub fn check_auth_rate_limit(account_id: &str) -> Result<(), AuthRateLimitError> {
    check_auth_rate_limit_at(account_id, now_ms())
}

/// [`check_auth_rate_limit`] with an injectable clock (tests).
pub fn check_auth_rate_limit_at(account_id: &str, now: i64) -> Result<(), AuthRateLimitError> {
    if can_attempt_auth_at(account_id, now) {
        return Ok(());
    }
    Err(AuthRateLimitError::new(
        account_id,
        get_attempts_remaining_at(account_id, now),
        get_time_until_reset_at(account_id, now),
    ))
}

// ============================================================================
// Tests (ported from test/auth-rate-limit.test.ts)
//
// Module state is process-global, so every test takes the shared `serial_test`
// key `auth_rate_limit` and re-applies the TS beforeEach (reset + default
// config). Fake timers are ported via the `_at` clock-injection variants,
// with epoch 0 as the vitest `setSystemTime(new Date(0))` baseline.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// vitest beforeEach: `resetAllAuthRateLimits()` +
    /// `configureAuthRateLimit({ maxAttempts: 5, windowMs: 60_000 })`.
    fn before_each() {
        reset_all_auth_rate_limits();
        configure_auth_rate_limit(AuthRateLimitConfigPatch {
            max_attempts: Some(5),
            window_ms: Some(60_000),
        });
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn can_attempt_auth_allows_first_attempt() {
        before_each();
        assert!(can_attempt_auth_at("user@example.com", 0));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn can_attempt_auth_allows_attempts_up_to_limit() {
        before_each();
        for _ in 0..4 {
            record_auth_attempt_at("user@example.com", 0);
        }
        assert!(can_attempt_auth_at("user@example.com", 0));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn can_attempt_auth_denies_after_limit_reached() {
        before_each();
        for _ in 0..5 {
            record_auth_attempt_at("user@example.com", 0);
        }
        assert!(!can_attempt_auth_at("user@example.com", 0));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn can_attempt_auth_is_case_insensitive() {
        before_each();
        for _ in 0..5 {
            record_auth_attempt_at("User@Example.COM", 0);
        }
        assert!(!can_attempt_auth_at("user@example.com", 0));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn record_auth_attempt_records_attempts() {
        before_each();
        assert_eq!(get_attempts_remaining_at("user@test.com", 0), 5);
        record_auth_attempt_at("user@test.com", 0);
        assert_eq!(get_attempts_remaining_at("user@test.com", 0), 4);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn record_auth_attempt_tracks_accounts_separately() {
        before_each();
        record_auth_attempt_at("user1@test.com", 0);
        record_auth_attempt_at("user1@test.com", 0);
        record_auth_attempt_at("user2@test.com", 0);

        assert_eq!(get_attempts_remaining_at("user1@test.com", 0), 3);
        assert_eq!(get_attempts_remaining_at("user2@test.com", 0), 4);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn sliding_window_expires_old_attempts() {
        before_each();
        record_auth_attempt_at("user@test.com", 0);
        record_auth_attempt_at("user@test.com", 0);

        // vi.setSystemTime(new Date(61_000))
        assert_eq!(get_attempts_remaining_at("user@test.com", 61_000), 5);
        assert!(can_attempt_auth_at("user@test.com", 61_000));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn sliding_window_allows_new_attempts_after_window_expires() {
        before_each();
        for _ in 0..5 {
            record_auth_attempt_at("user@test.com", 0);
        }
        assert!(!can_attempt_auth_at("user@test.com", 0));

        assert!(can_attempt_auth_at("user@test.com", 61_000));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn get_time_until_reset_returns_zero_for_new_accounts() {
        before_each();
        assert_eq!(get_time_until_reset_at("new@test.com", 0), 0);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn get_time_until_reset_returns_remaining_window_time() {
        before_each();
        record_auth_attempt_at("user@test.com", 0);
        assert_eq!(get_time_until_reset_at("user@test.com", 30_000), 30_000);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn get_time_until_reset_returns_zero_after_window_expires() {
        before_each();
        record_auth_attempt_at("user@test.com", 0);
        assert_eq!(get_time_until_reset_at("user@test.com", 61_000), 0);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn reset_auth_rate_limit_clears_attempts_for_specific_account() {
        before_each();
        for _ in 0..5 {
            record_auth_attempt_at("user@test.com", 0);
        }
        assert!(!can_attempt_auth_at("user@test.com", 0));

        reset_auth_rate_limit("user@test.com");

        assert!(can_attempt_auth_at("user@test.com", 0));
        assert_eq!(get_attempts_remaining_at("user@test.com", 0), 5);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn reset_all_auth_rate_limits_clears_all_accounts() {
        before_each();
        for _ in 0..5 {
            record_auth_attempt_at("user1@test.com", 0);
            record_auth_attempt_at("user2@test.com", 0);
        }

        reset_all_auth_rate_limits();

        assert!(can_attempt_auth_at("user1@test.com", 0));
        assert!(can_attempt_auth_at("user2@test.com", 0));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn check_auth_rate_limit_does_not_throw_when_under_limit() {
        before_each();
        assert!(check_auth_rate_limit_at("user@test.com", 0).is_ok());
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn check_auth_rate_limit_throws_when_over_limit() {
        before_each();
        for _ in 0..5 {
            record_auth_attempt_at("user@test.com", 0);
        }
        assert!(check_auth_rate_limit_at("user@test.com", 0).is_err());
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn check_auth_rate_limit_includes_reset_time_in_error() {
        before_each();
        for _ in 0..5 {
            record_auth_attempt_at("user@test.com", 0);
        }

        let error = check_auth_rate_limit_at("user@test.com", 0)
            .expect_err("should have thrown");
        assert_eq!(error.reset_after_ms, 60_000);
        assert_eq!(error.attempts_remaining, 0);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn configure_updates_max_attempts() {
        before_each();
        configure_auth_rate_limit(AuthRateLimitConfigPatch {
            max_attempts: Some(3),
            window_ms: None,
        });

        for _ in 0..3 {
            record_auth_attempt_at("user@test.com", 0);
        }
        assert!(!can_attempt_auth_at("user@test.com", 0));
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn configure_updates_window_duration() {
        before_each();
        configure_auth_rate_limit(AuthRateLimitConfigPatch {
            max_attempts: None,
            window_ms: Some(30_000),
        });

        record_auth_attempt_at("user@test.com", 0);
        assert_eq!(get_attempts_remaining_at("user@test.com", 31_000), 5);
    }

    #[test]
    #[serial(auth_rate_limit)]
    fn configure_preserves_other_config_values() {
        before_each();
        configure_auth_rate_limit(AuthRateLimitConfigPatch {
            max_attempts: Some(10),
            window_ms: None,
        });
        let config = get_auth_rate_limit_config();

        assert_eq!(config.max_attempts, 10);
        assert_eq!(config.window_ms, 60_000);
    }

    #[test]
    fn auth_rate_limit_error_has_correct_name() {
        let error = AuthRateLimitError::new("test@test.com", 0, 30_000);
        assert_eq!(error.name(), "AuthRateLimitError");
    }

    #[test]
    fn auth_rate_limit_error_includes_account_and_timing_info() {
        let error = AuthRateLimitError::new("test@test.com", 0, 30_000);
        assert_eq!(error.account_id, "test@test.com");
        assert_eq!(error.attempts_remaining, 0);
        assert_eq!(error.reset_after_ms, 30_000);
    }

    #[test]
    fn auth_rate_limit_error_has_human_readable_message() {
        let error = AuthRateLimitError::new("test@test.com", 0, 30_000);
        assert!(error.message().contains("30s"), "{}", error.message());
        // Exact frozen text (message deliberately omits the accountId).
        assert_eq!(
            error.message(),
            "Auth rate limit exceeded for account. Retry after 30s"
        );
        assert!(!error.message().contains("test@test.com"));
    }
}
