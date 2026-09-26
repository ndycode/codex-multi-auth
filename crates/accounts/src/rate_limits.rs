//! Port of `lib/accounts/rate-limits.ts` — pure rate-limit helpers (quota
//! keys, expiry clearing, wait-time formatting).
//!
//! Behavior source: spec 03 §2 + gotchas 1/11/31. TS source is authoritative.
//!
//! Key contracts:
//! - [`get_quota_key`] builds `family` or `family:model` keys; the model
//!   string is used RAW (no normalization here).
//! - [`is_rate_limited_for_family`] has a deliberate SIDE EFFECT: it prunes
//!   expired windows via [`clear_expired_rate_limits`] before answering
//!   (gotcha 11 — persisted snapshots include the cleaned map).
//! - [`clear_all_rate_limits`] drops still-future windows too (issue #606
//!   stale-runtime recovery).
//! - [`format_wait_time`] floors: 59.9 s → `"59s"`; `"Xm Ys"` without
//!   zero-padding (gotcha 31). Strings are user-visible — FROZEN.

use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{RateLimitReason, RateLimitStateV3};
use cma_core::utils::now_ms;

/// TS `type BaseQuotaKey = ModelFamily`.
pub type BaseQuotaKey = ModelFamily;

/// TS `type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}``.
///
/// Quota keys are plain strings in the persisted `rateLimitResetTimes` map,
/// so the Rust port models them as `String` built via [`get_quota_key`].
pub type QuotaKey = String;

/// TS `parseRateLimitReason(code)` — classify an upstream error-code string.
///
/// Empty/absent → `"unknown"`. Lowercased substring checks IN ORDER (a code
/// containing both "quota" and "token" is `"quota"`):
/// 1. `"quota"` / `"usage_limit"` → [`RateLimitReason::Quota`]
/// 2. `"token"` / `"tpm"` / `"rpm"` → [`RateLimitReason::Tokens`]
/// 3. `"concurrent"` / `"parallel"` → [`RateLimitReason::Concurrent`]
/// 4. else → [`RateLimitReason::Unknown`]
pub fn parse_rate_limit_reason(code: Option<&str>) -> RateLimitReason {
    let Some(code) = code else {
        return RateLimitReason::Unknown;
    };
    if code.is_empty() {
        return RateLimitReason::Unknown;
    }
    let lc = code.to_lowercase();
    if lc.contains("quota") || lc.contains("usage_limit") {
        return RateLimitReason::Quota;
    }
    if lc.contains("token") || lc.contains("tpm") || lc.contains("rpm") {
        return RateLimitReason::Tokens;
    }
    if lc.contains("concurrent") || lc.contains("parallel") {
        return RateLimitReason::Concurrent;
    }
    RateLimitReason::Unknown
}

/// TS `getQuotaKey(family, model?)` — `` `${family}:${model}` `` when a
/// (truthy = non-empty) model is given, else the bare family literal.
pub fn get_quota_key(family: ModelFamily, model: Option<&str>) -> QuotaKey {
    match model {
        Some(model) if !model.is_empty() => format!("{}:{model}", family.as_str()),
        _ => family.as_str().to_string(),
    }
}

/// TS `clampNonNegativeInt(value, fallback)` — non-number / non-finite →
/// `fallback` (fallback NOT validated); negative → `0`; else `Math.floor`.
///
/// The TS `unknown` input maps to `Option<f64>`: `None` covers
/// undefined/non-number values, non-finite floats cover NaN/±Infinity.
pub fn clamp_non_negative_int(value: Option<f64>, fallback: i64) -> i64 {
    let Some(value) = value else {
        return fallback;
    };
    if !value.is_finite() {
        return fallback;
    }
    if value < 0.0 {
        return 0;
    }
    value.floor() as i64
}

/// Integer convenience over [`clamp_non_negative_int`] for call sites whose
/// inputs are already `i64` (schema-validated epochs/indexes): `None` →
/// `fallback`; negative → `0`; else the value (floor is the identity).
pub fn clamp_non_negative_int_i64(value: Option<i64>, fallback: i64) -> i64 {
    match value {
        None => fallback,
        Some(value) if value < 0 => 0,
        Some(value) => value,
    }
}

/// TS `interface RateLimitedEntity { rateLimitResetTimes: RateLimitState }` —
/// anything carrying a mutable quota-key → epoch-ms reset-time map.
pub trait RateLimitedEntity {
    fn rate_limit_reset_times(&self) -> &RateLimitStateV3;
    fn rate_limit_reset_times_mut(&mut self) -> &mut RateLimitStateV3;
}

/// A bare map is its own rate-limited entity.
impl RateLimitedEntity for RateLimitStateV3 {
    fn rate_limit_reset_times(&self) -> &RateLimitStateV3 {
        self
    }
    fn rate_limit_reset_times_mut(&mut self) -> &mut RateLimitStateV3 {
        self
    }
}

/// TS `clearExpiredRateLimits(entity)` — delete every key whose reset time
/// has arrived (`now >= resetTime`). Mutates the entity.
pub fn clear_expired_rate_limits(entity: &mut impl RateLimitedEntity) {
    let now = now_ms();
    entity
        .rate_limit_reset_times_mut()
        .retain(|_, reset_time| now < reset_time);
}

/// TS `clearAllRateLimits(entity)` — remove EVERY entry, including
/// still-future windows (issue #606 recovery clean slate).
pub fn clear_all_rate_limits(entity: &mut impl RateLimitedEntity) {
    entity.rate_limit_reset_times_mut().clear();
}

/// TS `isRateLimitedForQuotaKey(entity, key)` — limited while a reset time
/// exists and lies strictly in the future. Pure (no pruning).
pub fn is_rate_limited_for_quota_key(entity: &impl RateLimitedEntity, key: &str) -> bool {
    match entity.rate_limit_reset_times().get(key) {
        Some(reset_time) => now_ms() < reset_time,
        None => false,
    }
}

/// TS `isRateLimitedForFamily(entity, family, model?)`.
///
/// SIDE EFFECT: prunes expired windows first (gotcha 11). Then, when a model
/// is given, the model-scoped key is checked first; the base family key is
/// ALWAYS checked afterwards — limited if either hits.
pub fn is_rate_limited_for_family(
    entity: &mut impl RateLimitedEntity,
    family: ModelFamily,
    model: Option<&str>,
) -> bool {
    clear_expired_rate_limits(entity);

    if let Some(model) = model
        && !model.is_empty()
    {
        let model_key = get_quota_key(family, Some(model));
        if is_rate_limited_for_quota_key(entity, &model_key) {
            return true;
        }
    }

    let base_key = get_quota_key(family, None);
    is_rate_limited_for_quota_key(entity, &base_key)
}

/// TS `formatWaitTime(ms)` — `totalSeconds = max(0, floor(ms/1000))`;
/// `"Xm Ys"` when minutes > 0 else `"Xs"`. FROZEN user-visible strings.
pub fn format_wait_time(ms: i64) -> String {
    let total_seconds = (ms.div_euclid(1000)).max(0);
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    }
}

// ============================================================================
// Tests — ported from test/account-rate-limits.test.ts (+ the
// parseRateLimitReason / formatWaitTime suites of test/accounts.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn state_of(entries: &[(&str, i64)]) -> RateLimitStateV3 {
        let mut state = RateLimitStateV3::new();
        for (key, value) in entries {
            state.insert(*key, *value);
        }
        state
    }

    // -- parseRateLimitReason ------------------------------------------------

    #[test]
    fn parse_returns_quota_for_quota_related_codes() {
        assert_eq!(
            parse_rate_limit_reason(Some("insufficient_quota")),
            RateLimitReason::Quota
        );
        assert_eq!(
            parse_rate_limit_reason(Some("usage_limit_reached")),
            RateLimitReason::Quota
        );
        assert_eq!(
            parse_rate_limit_reason(Some("QUOTA_EXCEEDED")),
            RateLimitReason::Quota
        );
    }

    #[test]
    fn parse_returns_tokens_for_token_related_codes() {
        assert_eq!(
            parse_rate_limit_reason(Some("tokens_exhausted")),
            RateLimitReason::Tokens
        );
        assert_eq!(
            parse_rate_limit_reason(Some("tpm_limit")),
            RateLimitReason::Tokens
        );
        assert_eq!(
            parse_rate_limit_reason(Some("rpm_exceeded")),
            RateLimitReason::Tokens
        );
    }

    #[test]
    fn parse_returns_concurrent_for_concurrency_codes() {
        assert_eq!(
            parse_rate_limit_reason(Some("concurrent_requests")),
            RateLimitReason::Concurrent
        );
        assert_eq!(
            parse_rate_limit_reason(Some("too_many_parallel")),
            RateLimitReason::Concurrent
        );
    }

    #[test]
    fn parse_returns_unknown_for_absent_or_empty() {
        assert_eq!(parse_rate_limit_reason(None), RateLimitReason::Unknown);
        assert_eq!(parse_rate_limit_reason(Some("")), RateLimitReason::Unknown);
    }

    #[test]
    fn parse_returns_unknown_for_unrecognized_codes() {
        assert_eq!(
            parse_rate_limit_reason(Some("server_error")),
            RateLimitReason::Unknown
        );
        assert_eq!(
            parse_rate_limit_reason(Some("something_else")),
            RateLimitReason::Unknown
        );
    }

    #[test]
    fn parse_order_matters_quota_wins_over_tokens() {
        // A code containing both "quota" and "token" classifies as quota.
        assert_eq!(
            parse_rate_limit_reason(Some("token_quota_exceeded")),
            RateLimitReason::Quota
        );
    }

    // -- getQuotaKey ---------------------------------------------------------

    #[test]
    fn quota_key_returns_bare_family_when_no_model() {
        assert_eq!(get_quota_key(ModelFamily::Codex, None), "codex");
        assert_eq!(get_quota_key(ModelFamily::Gpt5_2, None), "gpt-5.2");
        // TS falsy model ("" or null) also yields the bare family.
        assert_eq!(get_quota_key(ModelFamily::Codex, Some("")), "codex");
    }

    #[test]
    fn quota_key_scopes_to_model_when_given() {
        assert_eq!(
            get_quota_key(ModelFamily::Codex, Some("gpt-5.3-codex")),
            "codex:gpt-5.3-codex"
        );
        assert_eq!(
            get_quota_key(ModelFamily::Gpt5_2, Some("gpt-5.2-pro")),
            "gpt-5.2:gpt-5.2-pro"
        );
    }

    // -- clampNonNegativeInt -------------------------------------------------

    #[test]
    fn clamp_falls_back_for_non_numbers_and_non_finite() {
        assert_eq!(clamp_non_negative_int(None, 42), 42);
        assert_eq!(clamp_non_negative_int(Some(f64::NAN), 42), 42);
        assert_eq!(clamp_non_negative_int(Some(f64::INFINITY), 42), 42);
        assert_eq!(clamp_non_negative_int(Some(f64::NEG_INFINITY), 42), 42);
        // Fallback is NOT validated.
        assert_eq!(clamp_non_negative_int(None, -7), -7);
    }

    #[test]
    fn clamp_zeroes_negatives_and_floors_fractions() {
        assert_eq!(clamp_non_negative_int(Some(-5.0), 42), 0);
        assert_eq!(clamp_non_negative_int(Some(-0.5), 42), 0);
        assert_eq!(clamp_non_negative_int(Some(3.9), 42), 3);
        assert_eq!(clamp_non_negative_int(Some(0.0), 42), 0);
        assert_eq!(clamp_non_negative_int(Some(7.0), 42), 7);
    }

    #[test]
    fn clamp_i64_convenience_matches_semantics() {
        assert_eq!(clamp_non_negative_int_i64(None, 9), 9);
        assert_eq!(clamp_non_negative_int_i64(Some(-3), 9), 0);
        assert_eq!(clamp_non_negative_int_i64(Some(4), 9), 4);
    }

    // -- clearExpiredRateLimits / clearAllRateLimits -------------------------

    #[test]
    fn clear_expired_removes_due_entries_and_keeps_future_ones() {
        let now = now_ms();
        let mut state = state_of(&[
            ("codex", now - 1_000),
            ("codex:gpt-5.3-codex", now + 60_000),
            ("gpt-5.2", now), // exactly-now counts as expired (now >= reset)
        ]);
        clear_expired_rate_limits(&mut state);
        assert!(!state.contains_key("codex"));
        assert!(!state.contains_key("gpt-5.2"));
        assert_eq!(state.get("codex:gpt-5.3-codex"), Some(now + 60_000));
        assert_eq!(state.len(), 1);
    }

    #[test]
    fn clear_all_drops_future_windows_too_issue_606() {
        let now = now_ms();
        let mut state = state_of(&[
            ("codex", now + 600_000),
            ("gpt-5.2:gpt-5.2-pro", now + 3_600_000),
        ]);
        clear_all_rate_limits(&mut state);
        assert!(state.is_empty());
    }

    // -- isRateLimitedForQuotaKey --------------------------------------------

    #[test]
    fn limited_for_quota_key_only_while_reset_in_future() {
        let now = now_ms();
        let state = state_of(&[("codex", now + 30_000), ("gpt-5.2", now - 30_000)]);
        assert!(is_rate_limited_for_quota_key(&state, "codex"));
        assert!(!is_rate_limited_for_quota_key(&state, "gpt-5.2"));
        assert!(!is_rate_limited_for_quota_key(&state, "codex-max"));
    }

    // -- isRateLimitedForFamily ----------------------------------------------

    #[test]
    fn family_check_treats_missing_model_as_family_key_only() {
        let now = now_ms();
        let mut state = state_of(&[("codex", now + 30_000)]);
        assert!(is_rate_limited_for_family(&mut state, ModelFamily::Codex, None));
        let mut clear = state_of(&[("codex:gpt-5.3-codex", now + 30_000)]);
        // Family-only check ignores model-scoped entries.
        assert!(!is_rate_limited_for_family(
            &mut clear,
            ModelFamily::Codex,
            None
        ));
    }

    #[test]
    fn family_check_honors_model_scoped_limit_when_family_clear() {
        let now = now_ms();
        let mut state = state_of(&[("codex:gpt-5.3-codex", now + 30_000)]);
        assert!(is_rate_limited_for_family(
            &mut state,
            ModelFamily::Codex,
            Some("gpt-5.3-codex")
        ));
        // A different model in the same family stays routable.
        assert!(!is_rate_limited_for_family(
            &mut state,
            ModelFamily::Codex,
            Some("codex-mini")
        ));
    }

    #[test]
    fn family_wide_limit_applies_to_every_model_in_the_family() {
        let now = now_ms();
        let mut state = state_of(&[("codex", now + 30_000)]);
        assert!(is_rate_limited_for_family(
            &mut state,
            ModelFamily::Codex,
            Some("gpt-5.3-codex")
        ));
        assert!(is_rate_limited_for_family(
            &mut state,
            ModelFamily::Codex,
            Some("codex-mini")
        ));
        assert!(is_rate_limited_for_family(&mut state, ModelFamily::Codex, None));
    }

    #[test]
    fn family_check_prunes_expired_entries_as_a_side_effect() {
        let now = now_ms();
        let mut state = state_of(&[
            ("codex", now - 1_000),
            ("codex:gpt-5.3-codex", now - 2_000),
            ("gpt-5.1", now + 60_000),
        ]);
        assert!(!is_rate_limited_for_family(
            &mut state,
            ModelFamily::Codex,
            Some("gpt-5.3-codex")
        ));
        // Expired entries were deleted; the future one survives.
        assert!(!state.contains_key("codex"));
        assert!(!state.contains_key("codex:gpt-5.3-codex"));
        assert!(state.contains_key("gpt-5.1"));
    }

    // -- formatWaitTime ------------------------------------------------------

    #[test]
    fn format_wait_time_exact_strings() {
        assert_eq!(format_wait_time(0), "0s");
        assert_eq!(format_wait_time(-5_000), "0s");
        assert_eq!(format_wait_time(1_000), "1s");
        assert_eq!(format_wait_time(59_000), "59s");
        assert_eq!(format_wait_time(59_900), "59s"); // floors partial seconds
        assert_eq!(format_wait_time(60_000), "1m 0s");
        assert_eq!(format_wait_time(90_000), "1m 30s");
        assert_eq!(format_wait_time(3_661_000), "61m 1s");
        assert_eq!(format_wait_time(125_500), "2m 5s");
    }
}
