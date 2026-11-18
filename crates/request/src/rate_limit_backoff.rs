//! Port of `lib/request/rate-limit-backoff.ts` — per-process 429 backoff
//! with time-window deduplication (spec 06 §13).
//!
//! **CRITICAL anti-requirement (spec 06 §23 / 6.4.0 regression):** this state
//! is per-process, in-memory ONLY. It must NEVER be serialized into the
//! persisted account/rate-limit files. No type here implements `Serialize`.
//!
//! Behavior pins:
//! - Deduplicate concurrent 429s inside `dedup_window_ms` (returns the
//!   PREVIOUS attempt/delay without touching state).
//! - Reset backoff after a quiet period (`state_reset_ms`).
//! - Server retry-after acts as a FLOOR on the jittered exponential delay.
//! - Reason multiplier is applied WITHOUT re-applying `2^(attempt-1)`
//!   (audit REQ-HIGH-01); the first fresh attempt applies it to the
//!   UN-jittered normalized base.

use std::collections::HashMap;
use std::sync::Mutex;

use cma_core::schemas::account_storage::RateLimitReason;
use cma_core::utils::now_ms;

/// Defaults mirror `DEFAULT_PLUGIN_CONFIG` (`lib/config.ts`):
/// `rateLimitDedupWindowMs ?? 2_000`, `rateLimitStateResetMs ?? 120_000`,
/// `rateLimitMaxBackoffMs ?? 60_000`, `rateLimitShortRetryThresholdMs ?? 5_000`.
const DEFAULT_RATE_LIMIT_DEDUP_WINDOW_MS: i64 = 2_000;
const DEFAULT_RATE_LIMIT_STATE_RESET_MS: i64 = 120_000;
const DEFAULT_MAX_BACKOFF_MS: i64 = 60_000;
const DEFAULT_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS: i64 = 5_000;
const RATE_LIMIT_BACKOFF_JITTER_FACTOR: f64 = 0.2;

/// Maximum number of consecutive short-cooldown 429 retries before falling
/// through to the long-cooldown rotation path. Without this bound, an
/// upstream that perpetually returns short Retry-After values (at or below
/// the short-retry threshold) would keep the request loop spinning on the
/// same account indefinitely.
pub const MAX_SHORT_RETRY_ATTEMPTS: u32 = 3;

/// TS `RateLimitBackoffResult`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimitBackoffResult {
    pub attempt: u32,
    pub delay_ms: i64,
    pub is_duplicate: bool,
    pub reason: Option<RateLimitReason>,
}

#[derive(Clone, Copy, Debug)]
struct RateLimitBackoffConfig {
    dedup_window_ms: i64,
    state_reset_ms: i64,
    max_backoff_ms: i64,
    short_retry_threshold_ms: i64,
}

impl RateLimitBackoffConfig {
    const fn defaults() -> Self {
        Self {
            dedup_window_ms: DEFAULT_RATE_LIMIT_DEDUP_WINDOW_MS,
            state_reset_ms: DEFAULT_RATE_LIMIT_STATE_RESET_MS,
            max_backoff_ms: DEFAULT_MAX_BACKOFF_MS,
            short_retry_threshold_ms: DEFAULT_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS,
        }
    }
}

/// TS `Partial<RateLimitBackoffConfig>` overrides for
/// [`configure_rate_limit_backoff`]. Non-finite values are ignored, exactly
/// like the TS `typeof === "number" && Number.isFinite` guards.
#[derive(Clone, Copy, Debug, Default)]
pub struct RateLimitBackoffOverrides {
    pub dedup_window_ms: Option<f64>,
    pub state_reset_ms: Option<f64>,
    pub max_backoff_ms: Option<f64>,
    pub short_retry_threshold_ms: Option<f64>,
}

#[derive(Clone, Debug)]
struct RateLimitState {
    consecutive_429: u32,
    last_at: i64,
    #[allow(dead_code)] // parity with the TS state shape; useful in debugging
    quota_key: String,
    last_delay_ms: i64,
}

static CONFIG: Mutex<RateLimitBackoffConfig> = Mutex::new(RateLimitBackoffConfig::defaults());
static STATE: Mutex<Option<HashMap<String, RateLimitState>>> = Mutex::new(None);

fn config() -> RateLimitBackoffConfig {
    *CONFIG.lock().expect("rate-limit backoff config poisoned")
}

fn with_state<T>(f: impl FnOnce(&mut HashMap<String, RateLimitState>) -> T) -> T {
    let mut guard = STATE.lock().expect("rate-limit backoff state poisoned");
    f(guard.get_or_insert_with(HashMap::new))
}

/// TS `configureRateLimitBackoff(overrides)` — each provided finite value is
/// floored and clamped to its minimum (dedup >= 0, stateReset >= 1000,
/// maxBackoff >= 1000, shortRetryThreshold >= 0); invalid values are ignored.
pub fn configure_rate_limit_backoff(overrides: RateLimitBackoffOverrides) {
    let mut cfg = CONFIG.lock().expect("rate-limit backoff config poisoned");
    if let Some(v) = overrides.dedup_window_ms
        && v.is_finite()
    {
        cfg.dedup_window_ms = (v.floor() as i64).max(0);
    }
    if let Some(v) = overrides.state_reset_ms
        && v.is_finite()
    {
        cfg.state_reset_ms = (v.floor() as i64).max(1_000);
    }
    if let Some(v) = overrides.max_backoff_ms
        && v.is_finite()
    {
        cfg.max_backoff_ms = (v.floor() as i64).max(1_000);
    }
    if let Some(v) = overrides.short_retry_threshold_ms
        && v.is_finite()
    {
        cfg.short_retry_threshold_ms = (v.floor() as i64).max(0);
    }
}

/// TS `resetRateLimitBackoffConfig()`.
pub fn reset_rate_limit_backoff_config() {
    *CONFIG.lock().expect("rate-limit backoff config poisoned") =
        RateLimitBackoffConfig::defaults();
}

/// TS `getRateLimitShortRetryThresholdMs()` — the module-local getter.
pub fn get_rate_limit_short_retry_threshold_ms() -> i64 {
    config().short_retry_threshold_ms
}

/// The `lib/index.ts` barrel RENAME `getConfiguredRateLimitShortRetryThresholdMs`
/// (spec 01 §2.13 / ARCHITECTURE §6.1 note): same value as
/// [`get_rate_limit_short_retry_threshold_ms`], distinct from cma-config's
/// `get_rate_limit_short_retry_threshold_ms` env/config getter. Both exist.
pub fn configured_rate_limit_short_retry_threshold_ms() -> i64 {
    get_rate_limit_short_retry_threshold_ms()
}

fn resolve_rate_limit_state_key(
    account_index: usize,
    quota_key: &str,
    stable_account_key: Option<&str>,
) -> String {
    let normalized = stable_account_key.map(str::trim).unwrap_or("");
    if normalized.is_empty() {
        format!("slot:{account_index}:{quota_key}")
    } else {
        format!("{normalized}:{quota_key}")
    }
}

/// TS `normalizeDelayMs` — non-finite/absent -> fallback, then
/// `max(0, floor(v))`.
fn normalize_delay_ms(value: Option<f64>, fallback: i64) -> i64 {
    match value {
        Some(v) if v.is_finite() => (v.floor() as i64).max(0),
        // NaN / ±Infinity fail the TS `Number.isFinite` guard -> fallback.
        _ => fallback.max(0),
    }
}

/// `Math.random()` analogue — a uniform `[0,1)` draw for the ±20% jitter.
///
/// The foundation Cargo.toml for this crate does not include `rand`, and the
/// jitter needs no cryptographic strength, so this derives the sample from
/// `std::hash::RandomState` (per-instance random keys seeded from OS
/// entropy). 53 bits of the hash map onto the JS double-precision unit
/// interval.
fn random_unit() -> f64 {
    use std::hash::{BuildHasher, Hasher, RandomState};
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(0x9e37_79b9_7f4a_7c15);
    ((hasher.finish() >> 11) as f64) / ((1u64 << 53) as f64)
}

/// TS `addBackoffJitter` with the `Math.random()` draw injected:
/// `jitter_unit` is the uniform `[0,1)` sample.
fn add_backoff_jitter(base_ms: f64, jitter_unit: f64) -> i64 {
    let jitter = base_ms * RATE_LIMIT_BACKOFF_JITTER_FACTOR * (jitter_unit * 2.0 - 1.0);
    ((base_ms + jitter).floor() as i64).max(0)
}

fn prune_stale_rate_limit_state(now: i64, state_reset_ms: i64) {
    with_state(|state| {
        state.retain(|_, entry| now - entry.last_at <= state_reset_ms);
    });
}

fn get_rate_limit_backoff_at(
    account_index: usize,
    quota_key: &str,
    server_retry_after_ms: Option<f64>,
    stable_account_key: Option<&str>,
    now: i64,
    jitter_unit: f64,
) -> RateLimitBackoffResult {
    let cfg = config();
    prune_stale_rate_limit_state(now, cfg.state_reset_ms);
    let state_key = resolve_rate_limit_state_key(account_index, quota_key, stable_account_key);
    let base_delay = normalize_delay_ms(server_retry_after_ms, 1_000);

    with_state(|state| {
        if let Some(previous) = state.get(&state_key)
            && now - previous.last_at < cfg.dedup_window_ms
        {
            // Concurrent 429s within the dedup window must not over-increment:
            // return the previous verdict WITHOUT updating state.
            return RateLimitBackoffResult {
                attempt: previous.consecutive_429,
                delay_ms: previous.last_delay_ms,
                is_duplicate: true,
                reason: None,
            };
        }

        let attempt = match state.get(&state_key) {
            Some(previous) if now - previous.last_at < cfg.state_reset_ms => {
                previous.consecutive_429 + 1
            }
            _ => 1,
        };

        let backoff_delay = ((base_delay as f64) * 2f64.powi(attempt as i32 - 1))
            .min(cfg.max_backoff_ms as f64);
        let jittered_delay = add_backoff_jitter(backoff_delay, jitter_unit).min(cfg.max_backoff_ms);
        // The server hint is a FLOOR on the jittered delay.
        let delay_ms = base_delay.max(jittered_delay);
        state.insert(
            state_key,
            RateLimitState {
                consecutive_429: attempt,
                last_at: now,
                quota_key: quota_key.to_string(),
                last_delay_ms: delay_ms,
            },
        );
        RateLimitBackoffResult {
            attempt,
            delay_ms,
            is_duplicate: false,
            reason: None,
        }
    })
}

/// TS `getRateLimitBackoff(accountIndex, quotaKey, serverRetryAfterMs,
/// stableAccountKey?)` — compute rate-limit backoff for an account+quota key.
pub fn get_rate_limit_backoff(
    account_index: usize,
    quota_key: &str,
    server_retry_after_ms: Option<f64>,
    stable_account_key: Option<&str>,
) -> RateLimitBackoffResult {
    get_rate_limit_backoff_at(
        account_index,
        quota_key,
        server_retry_after_ms,
        stable_account_key,
        now_ms(),
        random_unit(),
    )
}

/// TS `resetRateLimitBackoff` — delete one state entry.
pub fn reset_rate_limit_backoff(
    account_index: usize,
    quota_key: &str,
    stable_account_key: Option<&str>,
) {
    let key = resolve_rate_limit_state_key(account_index, quota_key, stable_account_key);
    with_state(|state| {
        state.remove(&key);
    });
}

/// TS `clearRateLimitBackoffState()` — clear the whole map.
pub fn clear_rate_limit_backoff_state() {
    with_state(|state| state.clear());
}

fn backoff_multiplier(reason: RateLimitReason) -> f64 {
    match reason {
        RateLimitReason::Quota => 3.0,
        RateLimitReason::Tokens => 1.5,
        RateLimitReason::Concurrent => 0.5,
        RateLimitReason::Unknown => 1.0,
    }
}

/// TS `calculateBackoffMs(baseDelayMs, _attempt, reason = "unknown")`.
///
/// Applies ONLY the reason multiplier to `base_delay_ms` (which is expected
/// to already incorporate the exponential progression + jitter from
/// [`get_rate_limit_backoff`]) and clamps to the configured max backoff.
/// It deliberately does NOT re-apply `2^(attempt-1)` — doing so double-applied
/// the exponential and saturated `max_backoff_ms` after two consecutive 429s
/// (audit finding REQ-HIGH-01). `_attempt` is retained for API compatibility.
pub fn calculate_backoff_ms(base_delay_ms: f64, _attempt: u32, reason: RateLimitReason) -> i64 {
    let multiplier = backoff_multiplier(reason);
    let scaled = (base_delay_ms * multiplier).floor().max(0.0);
    let max = config().max_backoff_ms;
    if scaled >= max as f64 { max } else { scaled as i64 }
}

/// TS `RateLimitBackoffWithReasonParams` (named-parameter form; the
/// positional TS overload maps to the same struct).
#[derive(Clone, Debug)]
pub struct RateLimitBackoffWithReasonParams<'a> {
    pub account_index: usize,
    pub quota_key: &'a str,
    pub server_retry_after_ms: Option<f64>,
    /// Defaults to [`RateLimitReason::Unknown`] when `None`.
    pub reason: Option<RateLimitReason>,
    pub stable_account_key: Option<&'a str>,
}

/// Argument-validation error for [`get_rate_limit_backoff_with_reason`]
/// (TS threw `TypeError`; message text frozen).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateLimitBackoffArgError(pub String);

impl std::fmt::Display for RateLimitBackoffArgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RateLimitBackoffArgError {}

/// TS `getRateLimitBackoffWithReason(...)`.
///
/// Validates the quota key (frozen message
/// `"getRateLimitBackoffWithReason requires a non-empty quotaKey"`; the TS
/// non-negative-integer accountIndex check is statically guaranteed by
/// `usize`), trims it, chains [`get_rate_limit_backoff`], then applies the
/// reason multiplier: the first fresh attempt uses the UN-jittered normalized
/// base (deterministic), later/duplicate attempts use the already-jittered
/// exponential delay (REQ-HIGH-01: the exponential is never double-applied).
pub fn get_rate_limit_backoff_with_reason(
    params: RateLimitBackoffWithReasonParams<'_>,
) -> Result<RateLimitBackoffResult, RateLimitBackoffArgError> {
    get_rate_limit_backoff_with_reason_at(params, now_ms(), random_unit())
}

fn get_rate_limit_backoff_with_reason_at(
    params: RateLimitBackoffWithReasonParams<'_>,
    now: i64,
    jitter_unit: f64,
) -> Result<RateLimitBackoffResult, RateLimitBackoffArgError> {
    if params.quota_key.trim().is_empty() {
        return Err(RateLimitBackoffArgError(
            "getRateLimitBackoffWithReason requires a non-empty quotaKey".to_string(),
        ));
    }
    let normalized_quota_key = params.quota_key.trim();
    let resolved_reason = params.reason.unwrap_or(RateLimitReason::Unknown);
    let result = get_rate_limit_backoff_at(
        params.account_index,
        normalized_quota_key,
        params.server_retry_after_ms,
        params.stable_account_key,
        now,
        jitter_unit,
    );
    let normalized_base_delay = normalize_delay_ms(params.server_retry_after_ms, 1_000);
    let multiplier_input = if result.attempt == 1 && !result.is_duplicate {
        normalized_base_delay as f64
    } else {
        result.delay_ms as f64
    };
    let adjusted_delay = calculate_backoff_ms(multiplier_input, result.attempt, resolved_reason);
    Ok(RateLimitBackoffResult {
        delay_ms: adjusted_delay,
        reason: Some(resolved_reason),
        ..result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    /// Every test resets the shared per-process state (config + map) and uses
    /// injected `now`/jitter, so they serialize on the module state.
    fn reset_all() {
        clear_rate_limit_backoff_state();
        reset_rate_limit_backoff_config();
    }

    /// `Math.random() == 0.5` -> zero jitter (the TS suite's baseline mock).
    const MID: f64 = 0.5;

    fn backoff_at(
        index: usize,
        key: &str,
        retry_after: Option<f64>,
        stable: Option<&str>,
        now: i64,
        jitter: f64,
    ) -> RateLimitBackoffResult {
        get_rate_limit_backoff_at(index, key, retry_after, stable, now, jitter)
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn deduplicates_concurrent_429s_within_the_window() {
        reset_all();
        let first = backoff_at(0, "codex", Some(1000.0), None, 0, MID);
        assert_eq!(
            first,
            RateLimitBackoffResult {
                attempt: 1,
                delay_ms: 1000,
                is_duplicate: false,
                reason: None
            }
        );

        let second = backoff_at(0, "codex", Some(1000.0), None, 1000, MID);
        assert_eq!(second.attempt, 1);
        assert_eq!(second.delay_ms, 1000);
        assert!(second.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn increments_after_dedup_window() {
        reset_all();
        backoff_at(0, "codex", Some(1000.0), None, 0, MID);
        let second = backoff_at(0, "codex", Some(1000.0), None, 2500, MID);
        assert_eq!(second.attempt, 2);
        assert_eq!(second.delay_ms, 2000);
        assert!(!second.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn applies_jitter_to_new_windows_but_keeps_duplicates_stable() {
        reset_all();
        // Math.random() == 1 -> +20% jitter.
        let first = backoff_at(4, "jitter-test", Some(1000.0), None, 0, 1.0);
        assert_eq!(first.delay_ms, 1200);

        // Duplicate window: previous delay returned regardless of jitter draw.
        let duplicate = backoff_at(4, "jitter-test", Some(1000.0), None, 1000, 0.0);
        assert_eq!(duplicate.delay_ms, 1200);
        assert!(duplicate.is_duplicate);

        // Math.random() == 0 -> -20% jitter, but server hint floors at 1000...
        // exponential base is 2000 so -20% -> 1600.
        let second = backoff_at(4, "jitter-test", Some(1000.0), None, 2500, 0.0);
        assert_eq!(second.delay_ms, 1600);
        assert!(!second.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn resets_after_quiet_period() {
        reset_all();
        backoff_at(0, "codex", Some(1000.0), None, 0, MID);
        let next = backoff_at(0, "codex", Some(1000.0), None, 121_000, MID);
        assert_eq!(next.attempt, 1);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn reset_rate_limit_backoff_clears_state() {
        reset_all();
        backoff_at(0, "codex", Some(1000.0), None, 0, MID);
        reset_rate_limit_backoff(0, "codex", None);
        let next = backoff_at(0, "codex", Some(1000.0), None, 0, MID);
        assert_eq!(next.attempt, 1);
        assert!(!next.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn uses_configurable_dedup_and_state_reset_windows() {
        reset_all();
        configure_rate_limit_backoff(RateLimitBackoffOverrides {
            dedup_window_ms: Some(5_000.0),
            state_reset_ms: Some(10_000.0),
            ..Default::default()
        });
        backoff_at(0, "codex", Some(1000.0), None, 0, MID);
        assert!(backoff_at(0, "codex", Some(1000.0), None, 3_000, MID).is_duplicate);
        assert_eq!(backoff_at(0, "codex", Some(1000.0), None, 11_000, MID).attempt, 1);
        reset_all();
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn does_not_carry_state_across_slot_reuse_when_stable_key_changes() {
        reset_all();
        backoff_at(0, "codex", Some(1000.0), Some("acc-1"), 0, MID);
        let next_account = backoff_at(0, "codex", Some(1000.0), Some("acc-2"), 2_500, MID);
        assert_eq!(next_account.attempt, 1);
        assert!(!next_account.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn blank_stable_key_falls_back_to_slot_key() {
        reset_all();
        backoff_at(3, "codex", Some(1000.0), Some("   "), 0, MID);
        // Same slot, no stable key -> same state entry (duplicate window).
        let dup = backoff_at(3, "codex", Some(1000.0), None, 500, MID);
        assert!(dup.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn calculate_backoff_applies_reason_multipliers() {
        reset_all();
        assert_eq!(calculate_backoff_ms(1000.0, 1, RateLimitReason::Quota), 3000);
        assert_eq!(calculate_backoff_ms(1000.0, 1, RateLimitReason::Tokens), 1500);
        assert_eq!(calculate_backoff_ms(1000.0, 1, RateLimitReason::Concurrent), 500);
        assert_eq!(calculate_backoff_ms(1000.0, 1, RateLimitReason::Unknown), 1000);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn calculate_backoff_does_not_reapply_exponential() {
        reset_all();
        // REQ-HIGH-01: attempt number must not change the result.
        assert_eq!(calculate_backoff_ms(1000.0, 1, RateLimitReason::Unknown), 1000);
        assert_eq!(calculate_backoff_ms(1000.0, 2, RateLimitReason::Unknown), 1000);
        assert_eq!(calculate_backoff_ms(1000.0, 3, RateLimitReason::Unknown), 1000);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn calculate_backoff_caps_at_max_backoff() {
        reset_all();
        let huge = 10.0 * 60.0 * 1000.0;
        assert!(calculate_backoff_ms(huge, 20, RateLimitReason::Quota) <= 5 * 60 * 1000);
        assert_eq!(
            calculate_backoff_ms(huge, 20, RateLimitReason::Quota),
            DEFAULT_MAX_BACKOFF_MS
        );
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn calculate_backoff_uses_configurable_cap() {
        reset_all();
        configure_rate_limit_backoff(RateLimitBackoffOverrides {
            max_backoff_ms: Some(12_000.0),
            ..Default::default()
        });
        assert_eq!(calculate_backoff_ms(10_000.0, 20, RateLimitReason::Quota), 12_000);
        reset_all();
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn exposes_configurable_short_retry_threshold() {
        reset_all();
        assert_eq!(get_rate_limit_short_retry_threshold_ms(), 5_000);
        assert_eq!(configured_rate_limit_short_retry_threshold_ms(), 5_000);
        configure_rate_limit_backoff(RateLimitBackoffOverrides {
            short_retry_threshold_ms: Some(9_000.0),
            ..Default::default()
        });
        assert_eq!(get_rate_limit_short_retry_threshold_ms(), 9_000);
        assert_eq!(configured_rate_limit_short_retry_threshold_ms(), 9_000);
        reset_all();
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn config_defaults_match_default_plugin_config() {
        // TS pulls these defaults from DEFAULT_PLUGIN_CONFIG with ?? fallbacks;
        // keep the consts pinned against the resolved config defaults.
        let resolved = cma_core::schemas::plugin_config::PluginConfig::default_resolved();
        assert_eq!(
            resolved.rate_limit_dedup_window_ms,
            Some(DEFAULT_RATE_LIMIT_DEDUP_WINDOW_MS as f64)
        );
        assert_eq!(
            resolved.rate_limit_state_reset_ms,
            Some(DEFAULT_RATE_LIMIT_STATE_RESET_MS as f64)
        );
        assert_eq!(
            resolved.rate_limit_max_backoff_ms,
            Some(DEFAULT_MAX_BACKOFF_MS as f64)
        );
        assert_eq!(
            resolved.rate_limit_short_retry_threshold_ms,
            Some(DEFAULT_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS as f64)
        );
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn normalize_delay_edge_cases_fall_back_to_1000() {
        reset_all();
        for (i, retry) in [
            (10usize, None),
            (12, Some(f64::NAN)),
            (13, Some(f64::INFINITY)),
            (14, Some(f64::NEG_INFINITY)),
        ] {
            let result = backoff_at(i, "edge-test", retry, None, 0, MID);
            assert_eq!(result.delay_ms, 1000, "case {i}");
        }
        // Negative floors to 0 -> exponential base 0, delay 0.
        let neg = backoff_at(15, "edge-neg", Some(-50.0), None, 0, MID);
        assert_eq!(neg.delay_ms, 0);
    }

    fn with_reason_at(
        index: usize,
        key: &str,
        retry: Option<f64>,
        reason: Option<RateLimitReason>,
        now: i64,
    ) -> RateLimitBackoffResult {
        get_rate_limit_backoff_with_reason_at(
            RateLimitBackoffWithReasonParams {
                account_index: index,
                quota_key: key,
                server_retry_after_ms: retry,
                reason,
                stable_account_key: None,
            },
            now,
            MID,
        )
        .expect("valid args")
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn with_reason_returns_adjusted_delay() {
        reset_all();
        let quota = with_reason_at(0, "test-quota", Some(1000.0), Some(RateLimitReason::Quota), 0);
        assert_eq!(quota.reason, Some(RateLimitReason::Quota));
        assert_eq!(quota.delay_ms, 3000);
        assert_eq!(quota.attempt, 1);

        let tokens =
            with_reason_at(1, "test-tokens", Some(2000.0), Some(RateLimitReason::Tokens), 0);
        assert_eq!(tokens.reason, Some(RateLimitReason::Tokens));
        assert_eq!(tokens.delay_ms, 3000);

        let default = with_reason_at(2, "test-default", Some(1000.0), None, 0);
        assert_eq!(default.reason, Some(RateLimitReason::Unknown));
        assert_eq!(default.delay_ms, 1000);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn with_reason_increments_attempt_on_subsequent_calls() {
        reset_all();
        with_reason_at(3, "test-increment", Some(1000.0), Some(RateLimitReason::Quota), 0);
        let second =
            with_reason_at(3, "test-increment", Some(1000.0), Some(RateLimitReason::Quota), 2500);
        assert_eq!(second.attempt, 2);
        // 1000 * 2^1 = 2000 (zero jitter), * quota(3.0) = 6000 — NOT 12000
        // (REQ-HIGH-01 double-exponential regression).
        assert_eq!(second.delay_ms, 6000);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn with_reason_rejects_blank_quota_key_without_mutating_state() {
        reset_all();
        let err = get_rate_limit_backoff_with_reason_at(
            RateLimitBackoffWithReasonParams {
                account_index: 0,
                quota_key: "   ",
                server_retry_after_ms: Some(1000.0),
                reason: None,
                stable_account_key: None,
            },
            0,
            MID,
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "getRateLimitBackoffWithReason requires a non-empty quotaKey"
        );

        let first_valid =
            with_reason_at(7, "state-safe", Some(1000.0), Some(RateLimitReason::Unknown), 0);
        assert_eq!(first_valid.attempt, 1);
        assert!(!first_valid.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn with_reason_trims_quota_key() {
        reset_all();
        with_reason_at(9, "trim-key", Some(1000.0), None, 0);
        let dup = get_rate_limit_backoff_with_reason_at(
            RateLimitBackoffWithReasonParams {
                account_index: 9,
                quota_key: "  trim-key  ",
                server_retry_after_ms: Some(1000.0),
                reason: None,
                stable_account_key: None,
            },
            500,
            MID,
        )
        .expect("valid");
        assert!(dup.is_duplicate);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn does_not_double_apply_exponential_across_chained_attempts() {
        reset_all();
        let base = Some(1000.0);
        let tokens = Some(RateLimitReason::Tokens);
        let first = with_reason_at(42, "req-high-01-regression", base, tokens, 0);
        assert_eq!(first.attempt, 1);
        assert_eq!(first.delay_ms, 1500); // 1000 * 2^0 * 1.5

        let second = with_reason_at(42, "req-high-01-regression", base, tokens, 2_500);
        assert_eq!(second.attempt, 2);
        assert_eq!(second.delay_ms, 3000); // 1000 * 2^1 * 1.5

        let third = with_reason_at(42, "req-high-01-regression", base, tokens, 5_000);
        assert_eq!(third.attempt, 3);
        assert_eq!(third.delay_ms, 6000); // 1000 * 2^2 * 1.5
        assert!(third.delay_ms < 60_000);

        // Ratio attempt=1 -> attempt=3 reflects a SINGLE exponential (4x).
        let ratio = third.delay_ms as f64 / first.delay_ms as f64;
        assert!((ratio - 4.0).abs() < 0.1);
        assert!(ratio < 8.0);
    }

    #[test]
    #[serial(rate_limit_backoff)]
    fn max_short_retry_attempts_is_three() {
        assert_eq!(MAX_SHORT_RETRY_ATTEMPTS, 3);
    }
}
