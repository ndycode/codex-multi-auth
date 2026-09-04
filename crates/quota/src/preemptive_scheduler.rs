//! Port of `lib/preemptive-quota-scheduler.ts` — in-memory per-key
//! (`"{entitlementAccountKey}:{model ?? modelFamily}"`) request deferrals fed
//! by upstream `x-codex-*` response headers.
//!
//! CRITICAL INVARIANTS (spec 05 §5 + gotchas 1/3/11):
//! - State is **per-process, in-memory only**. It must NEVER be persisted
//!   (same bug class as the 6.4.0 persisted-token-bucket regression), which is
//!   why no type in this module implements `serde::Serialize`.
//! - H4: `mark_rate_limited` only preserves a prior PRIMARY reset when that
//!   prior primary was itself a rate-limit/exhausted window, and
//!   `get_deferral`'s 429 branch filters windows through
//!   [`is_rate_limit_window`] so a benign weekly secondary (~7d reset) never
//!   benches an account for the full deferral cap on a transient 429.
//! - The "rounded left-percent == 0" test (`quotaLeftPercentFromUsed(...) ===
//!   0`) is used HERE ONLY. Everywhere else in the quota cluster exhaustion is
//!   the RAW `usedPercent >= 100` predicate. Do NOT unify the two.

use std::collections::HashMap;

use cma_core::utils::now_ms;
use reqwest::header::HeaderMap;

use crate::readiness::quota_left_percent_from_used;

/// TS `DEFAULT_REMAINING_PERCENT_THRESHOLD` (%).
const DEFAULT_REMAINING_PERCENT_THRESHOLD: f64 = 5.0;
/// TS `DEFAULT_MAX_DEFERRAL_MS` (2 h).
const DEFAULT_MAX_DEFERRAL_MS: i64 = 2 * 60 * 60_000;
/// Prune throttle: at most one prune per minute (TS `maybePrune`).
const PRUNE_THROTTLE_MS: i64 = 60_000;

/// TS `interface QuotaSchedulerWindow`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QuotaSchedulerWindow {
    pub used_percent: Option<f64>,
    pub reset_at_ms: Option<i64>,
}

/// TS `interface QuotaSchedulerSnapshot`.
#[derive(Debug, Clone, PartialEq)]
pub struct QuotaSchedulerSnapshot {
    pub status: u16,
    pub primary: QuotaSchedulerWindow,
    pub secondary: QuotaSchedulerWindow,
    pub updated_at: i64,
}

/// TS deferral `reason` union `"rate-limit" | "quota-near-exhaustion"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaDeferralReason {
    RateLimit,
    QuotaNearExhaustion,
}

impl QuotaDeferralReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            QuotaDeferralReason::RateLimit => "rate-limit",
            QuotaDeferralReason::QuotaNearExhaustion => "quota-near-exhaustion",
        }
    }
}

/// TS `interface QuotaDeferralDecision`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuotaDeferralDecision {
    pub defer: bool,
    pub wait_ms: i64,
    pub reason: Option<QuotaDeferralReason>,
}

impl QuotaDeferralDecision {
    const fn no_defer() -> Self {
        Self {
            defer: false,
            wait_ms: 0,
            reason: None,
        }
    }
}

/// TS `interface QuotaSchedulerOptions` — every field optional; non-finite
/// numbers are ignored exactly like the TS `Number.isFinite` guards.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct QuotaSchedulerOptions {
    pub enabled: Option<bool>,
    pub remaining_percent_threshold_primary: Option<f64>,
    pub remaining_percent_threshold_secondary: Option<f64>,
    /// Legacy knob: `remaining = 100 - usedPercentThreshold` applied to BOTH
    /// thresholds (then the specific fields override individually).
    pub used_percent_threshold: Option<f64>,
    pub max_deferral_ms: Option<f64>,
}

/// TS `clampInt(value, min, max)` = `max(min, min(max, floor(value)))`.
fn clamp_int(value: f64, min: f64, max: f64) -> f64 {
    value.floor().min(max).max(min)
}

/// TS `parseFiniteNumberHeader` — `Number(raw)` accepted when finite.
/// (JS `Number` trims whitespace; empty/absent values are rejected first.)
fn parse_finite_number_header(headers: &HeaderMap, name: &str) -> Option<f64> {
    let raw = headers.get(name)?.to_str().ok()?;
    if raw.is_empty() {
        return None;
    }
    let parsed: f64 = raw.trim().parse().ok()?;
    parsed.is_finite().then_some(parsed)
}

/// JS `Number.parseInt(raw, 10)` — leading whitespace + optional sign, then
/// the longest ASCII-digit prefix; NaN when no digits.
fn js_parse_int(raw: &str) -> Option<f64> {
    let s = raw.trim_start();
    let (negative, rest) = match s.as_bytes().first() {
        Some(b'+') => (false, &s[1..]),
        Some(b'-') => (true, &s[1..]),
        _ => (false, s),
    };
    let digits: &str = {
        let end = rest
            .as_bytes()
            .iter()
            .position(|b| !b.is_ascii_digit())
            .unwrap_or(rest.len());
        &rest[..end]
    };
    if digits.is_empty() {
        return None;
    }
    // Parse via f64 to mirror JS number semantics for huge values.
    let value: f64 = digits.parse().ok()?;
    Some(if negative { -value } else { value })
}

/// TS `parseFiniteIntHeader`.
fn parse_finite_int_header(headers: &HeaderMap, name: &str) -> Option<f64> {
    let raw = headers.get(name)?.to_str().ok()?;
    if raw.is_empty() {
        return None;
    }
    let parsed = js_parse_int(raw)?;
    parsed.is_finite().then_some(parsed)
}

/// `Date.parse` subset for header values: RFC 2822 (HTTP date), RFC 3339 /
/// ISO 8601 with offset, and bare `YYYY-MM-DD` (UTC midnight per ES2015+).
fn js_date_parse_ms(trimmed: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(trimmed) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp_millis());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        let dt = date.and_hms_opt(0, 0, 0)?.and_utc();
        return Some(dt.timestamp_millis());
    }
    None
}

/// TS `parseResetAtMs(headers, prefix, now)` — `{prefix}-reset-after-seconds`
/// (relative, from the CALLER-SUPPLIED `now`, not the wall clock) wins when
/// `> 0`; otherwise `{prefix}-reset-at` as all-digits epoch (values
/// `< 10_000_000_000` are seconds) or a parseable date string.
fn parse_reset_at_ms(headers: &HeaderMap, prefix: &str, now: i64) -> Option<i64> {
    if let Some(reset_after_seconds) = parse_finite_int_header(headers, &format!("{prefix}-reset-after-seconds"))
        && reset_after_seconds > 0.0
    {
        return Some(now.saturating_add((reset_after_seconds * 1000.0) as i64));
    }
    let raw = headers.get(format!("{prefix}-reset-at"))?.to_str().ok()?;
    if raw.is_empty() {
        return None;
    }
    let trimmed = raw.trim();
    if !trimmed.is_empty()
        && trimmed.bytes().all(|b| b.is_ascii_digit())
        && let Ok(parsed) = trimmed.parse::<f64>()
        && parsed.is_finite()
        && parsed > 0.0
    {
        return Some(if parsed < 10_000_000_000.0 {
            (parsed * 1000.0) as i64
        } else {
            parsed as i64
        });
    }
    js_date_parse_ms(trimmed)
}

/// TS `readQuotaSchedulerSnapshot(headers, status, now = Date.now())` — parses
/// ONLY the used-percent/reset signals for both windows; `None` unless at
/// least one of the four values parsed. `updated_at = now`.
pub fn read_quota_scheduler_snapshot(
    headers: &HeaderMap,
    status: u16,
    now: i64,
) -> Option<QuotaSchedulerSnapshot> {
    const PRIMARY_PREFIX: &str = "x-codex-primary";
    const SECONDARY_PREFIX: &str = "x-codex-secondary";
    let primary_used = parse_finite_number_header(headers, &format!("{PRIMARY_PREFIX}-used-percent"));
    let secondary_used =
        parse_finite_number_header(headers, &format!("{SECONDARY_PREFIX}-used-percent"));
    let primary_reset_at = parse_reset_at_ms(headers, PRIMARY_PREFIX, now);
    let secondary_reset_at = parse_reset_at_ms(headers, SECONDARY_PREFIX, now);

    let has_signal = primary_used.is_some()
        || secondary_used.is_some()
        || primary_reset_at.is_some()
        || secondary_reset_at.is_some();
    if !has_signal {
        return None;
    }

    Some(QuotaSchedulerSnapshot {
        status,
        primary: QuotaSchedulerWindow {
            used_percent: primary_used,
            reset_at_ms: primary_reset_at,
        },
        secondary: QuotaSchedulerWindow {
            used_percent: secondary_used,
            reset_at_ms: secondary_reset_at,
        },
        updated_at: now,
    })
}

/// H4 helper: a window counts toward a 429 deferral only when it is genuinely
/// a rate-limit / exhaustion window — no finite `usedPercent` at all, or a
/// ROUNDED left percent of 0 (this is the one place the rounded helper is the
/// correct predicate; see module docs).
fn is_rate_limit_window(window: &QuotaSchedulerWindow) -> bool {
    match window.used_percent {
        Some(used) if used.is_finite() => quota_left_percent_from_used(Some(used)) == Some(0),
        _ => true,
    }
}

/// TS `class PreemptiveQuotaScheduler` — in-memory, never persisted.
#[derive(Debug)]
pub struct PreemptiveQuotaScheduler {
    snapshots: HashMap<String, QuotaSchedulerSnapshot>,
    enabled: bool,
    primary_remaining_percent_threshold: f64,
    secondary_remaining_percent_threshold: f64,
    max_deferral_ms: i64,
    last_prune_at: i64,
}

impl Default for PreemptiveQuotaScheduler {
    fn default() -> Self {
        Self::new(QuotaSchedulerOptions::default())
    }
}

impl PreemptiveQuotaScheduler {
    /// TS constructor — defaults, then `configure(options)`.
    pub fn new(options: QuotaSchedulerOptions) -> Self {
        let mut scheduler = Self {
            snapshots: HashMap::new(),
            enabled: true,
            primary_remaining_percent_threshold: DEFAULT_REMAINING_PERCENT_THRESHOLD,
            secondary_remaining_percent_threshold: DEFAULT_REMAINING_PERCENT_THRESHOLD,
            max_deferral_ms: DEFAULT_MAX_DEFERRAL_MS,
            last_prune_at: 0,
        };
        scheduler.configure(options);
        scheduler
    }

    /// TS `configure(options)` — legacy `usedPercentThreshold` derives BOTH
    /// remaining thresholds first, then the specific primary/secondary values
    /// override individually. `maxDeferralMs` is floored with a 1s floor.
    pub fn configure(&mut self, options: QuotaSchedulerOptions) {
        if let Some(enabled) = options.enabled {
            self.enabled = enabled;
        }

        if let Some(legacy) = options.used_percent_threshold
            && legacy.is_finite()
        {
            let clamped_used = clamp_int(legacy, 0.0, 100.0);
            let derived_remaining = clamp_int(100.0 - clamped_used, 0.0, 100.0);
            self.primary_remaining_percent_threshold = derived_remaining;
            self.secondary_remaining_percent_threshold = derived_remaining;
        }

        if let Some(primary) = options.remaining_percent_threshold_primary
            && primary.is_finite()
        {
            self.primary_remaining_percent_threshold = clamp_int(primary, 0.0, 100.0);
        }

        if let Some(secondary) = options.remaining_percent_threshold_secondary
            && secondary.is_finite()
        {
            self.secondary_remaining_percent_threshold = clamp_int(secondary, 0.0, 100.0);
        }

        if let Some(max_deferral_ms) = options.max_deferral_ms
            && max_deferral_ms.is_finite()
        {
            self.max_deferral_ms = (max_deferral_ms.floor() as i64).max(1_000);
        }
    }

    /// TS `maybePrune(now)` — throttled to once per 60 s.
    fn maybe_prune(&mut self, now: i64) {
        if now - self.last_prune_at < PRUNE_THROTTLE_MS {
            return;
        }
        self.prune(now);
        self.last_prune_at = now;
    }

    /// TS `update(key, snapshot)` — whole-snapshot replace; no-op on empty
    /// key. The prune probe uses `snapshot.updatedAt || Date.now()` (falsy
    /// zero falls back to the wall clock).
    pub fn update(&mut self, key: &str, snapshot: QuotaSchedulerSnapshot) {
        if key.is_empty() {
            return;
        }
        let prune_now = if snapshot.updated_at != 0 {
            snapshot.updated_at
        } else {
            now_ms()
        };
        self.maybe_prune(prune_now);
        self.snapshots.insert(key.to_string(), snapshot);
    }

    /// TS `markRateLimited(key, retryAfterMs, now = Date.now())`.
    ///
    /// Stress-audit H4 fix — do not regress: a 429 retry-after defines the
    /// PRIMARY rate-limit window only. A prior primary reset is preserved
    /// ONLY when that prior primary was itself a rate-limit/exhausted window
    /// (no finite usedPercent, or rounded left == 0); a healthy primary from
    /// an earlier 200 snapshot must NOT extend the bench. The secondary
    /// window is carried as-is (it is filtered at read time).
    pub fn mark_rate_limited(&mut self, key: &str, retry_after_ms: f64, now: i64) {
        if key.is_empty() {
            return;
        }
        let wait_ms = if retry_after_ms.is_finite() {
            (retry_after_ms.floor() as i64).max(0)
        } else {
            0
        };
        let existing = self.snapshots.get(key);
        let existing_primary = existing.map(|snapshot| &snapshot.primary);
        let existing_primary_is_rate_limit =
            existing_primary.is_some_and(is_rate_limit_window);
        let existing_primary_reset_at_ms = if existing_primary_is_rate_limit {
            existing_primary.and_then(|window| window.reset_at_ms).unwrap_or(0)
        } else {
            0
        };
        let next_reset_at_ms = existing_primary_reset_at_ms.max(now.saturating_add(wait_ms));
        let secondary = existing
            .map(|snapshot| snapshot.secondary.clone())
            .unwrap_or_default();
        let updated_at = existing.map(|snapshot| snapshot.updated_at).unwrap_or(0).max(now);
        self.snapshots.insert(
            key.to_string(),
            QuotaSchedulerSnapshot {
                status: 429,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(100.0),
                    reset_at_ms: Some(next_reset_at_ms),
                },
                secondary,
                updated_at,
            },
        );
    }

    /// TS `getDeferral(key, now = Date.now())`.
    pub fn get_deferral(&mut self, key: &str, now: i64) -> QuotaDeferralDecision {
        self.maybe_prune(now);
        if !self.enabled {
            return QuotaDeferralDecision::no_defer();
        }

        let Some(snapshot) = self.snapshots.get(key) else {
            return QuotaDeferralDecision::no_defer();
        };

        let window_wait = |window: &QuotaSchedulerWindow| -> i64 {
            match window.reset_at_ms {
                Some(reset_at) if reset_at > now => reset_at - now,
                _ => 0,
            }
        };
        let primary_wait = window_wait(&snapshot.primary);
        let secondary_wait = window_wait(&snapshot.secondary);

        // 429 branch (H4): only windows that are genuinely rate-limit /
        // exhaustion windows contribute; a benign secondary at e.g. 30% used
        // from a prior 200 snapshot is excluded so a transient 429 never
        // benches the account for the full deferral cap.
        let longest_wait = [&snapshot.primary, &snapshot.secondary]
            .into_iter()
            .filter(|window| is_rate_limit_window(window))
            .filter_map(|window| window.reset_at_ms)
            .filter(|reset_at| *reset_at > now)
            .map(|reset_at| reset_at - now)
            .filter(|wait| *wait > 0)
            .max()
            .unwrap_or(0);

        if snapshot.status == 429 && longest_wait > 0 {
            let bounded = longest_wait.min(self.max_deferral_ms);
            if bounded > 0 {
                return QuotaDeferralDecision {
                    defer: true,
                    wait_ms: bounded,
                    reason: Some(QuotaDeferralReason::RateLimit),
                };
            }
        }

        // Near-exhaustion branch (any status): a window is near-exhausted iff
        // its finite usedPercent >= 100 - threshold (per-window thresholds).
        let near_exhausted = |window: &QuotaSchedulerWindow, threshold: f64| -> bool {
            window
                .used_percent
                .is_some_and(|used| used.is_finite() && used >= 100.0 - threshold)
        };
        let primary_near = near_exhausted(&snapshot.primary, self.primary_remaining_percent_threshold);
        let secondary_near =
            near_exhausted(&snapshot.secondary, self.secondary_remaining_percent_threshold);
        let near_exhausted_wait = i64::max(
            if primary_near { primary_wait } else { 0 },
            if secondary_near { secondary_wait } else { 0 },
        );
        if near_exhausted_wait > 0 {
            let bounded = near_exhausted_wait.min(self.max_deferral_ms);
            if bounded > 0 {
                return QuotaDeferralDecision {
                    defer: true,
                    wait_ms: bounded,
                    reason: Some(QuotaDeferralReason::QuotaNearExhaustion),
                };
            }
        }

        QuotaDeferralDecision::no_defer()
    }

    /// TS `prune(now = Date.now())` — removes entries whose latest reset
    /// (`max(primary, secondary)`, absent = 0) is `> 0 && <= now`. Entries
    /// with NO reset timestamps are kept forever (accepted bounded leak).
    pub fn prune(&mut self, now: i64) -> usize {
        let before = self.snapshots.len();
        self.snapshots.retain(|_, snapshot| {
            let latest_reset = i64::max(
                snapshot.primary.reset_at_ms.unwrap_or(0),
                snapshot.secondary.reset_at_ms.unwrap_or(0),
            );
            !(latest_reset > 0 && latest_reset <= now)
        });
        before - self.snapshots.len()
    }

    /// Test/diagnostic access to a stored snapshot (mirrors the TS tests'
    /// reflective `snapshots` map access; read-only).
    #[doc(hidden)]
    pub fn snapshot_for_key(&self, key: &str) -> Option<&QuotaSchedulerSnapshot> {
        self.snapshots.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                name.parse::<HeaderName>().unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn reads_quota_snapshot_from_codex_headers() {
        let headers = headers(&[
            ("x-codex-primary-used-percent", "99"),
            ("x-codex-primary-reset-after-seconds", "120"),
            ("x-codex-secondary-used-percent", "10"),
        ]);
        let snapshot = read_quota_scheduler_snapshot(&headers, 200, 1_000).expect("snapshot");
        assert_eq!(snapshot.status, 200);
        assert_eq!(snapshot.primary.used_percent, Some(99.0));
        assert!(snapshot.primary.reset_at_ms.unwrap() > 1_000);
    }

    #[test]
    fn uses_provided_now_when_parsing_reset_after_seconds() {
        let headers = headers(&[("x-codex-primary-reset-after-seconds", "120")]);
        let snapshot = read_quota_scheduler_snapshot(&headers, 200, 5_000).expect("snapshot");
        assert_eq!(snapshot.primary.reset_at_ms, Some(125_000));
    }

    #[test]
    fn returns_none_when_quota_headers_present_but_invalid() {
        let headers = headers(&[
            ("x-codex-primary-used-percent", "not-a-number"),
            ("x-codex-primary-reset-after-seconds", "oops"),
            ("x-codex-primary-reset-at", "not-a-date"),
            ("x-codex-secondary-reset-at", "still-not-a-date"),
        ]);
        assert!(read_quota_scheduler_snapshot(&headers, 200, 5_000).is_none());
    }

    #[test]
    fn parses_reset_at_as_epoch_seconds_milliseconds_and_http_date() {
        let snapshot = read_quota_scheduler_snapshot(
            &headers(&[
                ("x-codex-primary-reset-at", "1700000000"),
                ("x-codex-secondary-reset-at", "1700000000000"),
            ]),
            200,
            0,
        )
        .expect("snapshot");
        assert_eq!(snapshot.primary.reset_at_ms, Some(1_700_000_000_000));
        assert_eq!(snapshot.secondary.reset_at_ms, Some(1_700_000_000_000));

        // Date.parse("Tue, 14 Nov 2023 22:13:20 GMT") === 1_700_000_000_000.
        let date_snapshot = read_quota_scheduler_snapshot(
            &headers(&[("x-codex-primary-reset-at", "Tue, 14 Nov 2023 22:13:20 GMT")]),
            200,
            0,
        )
        .expect("snapshot");
        assert_eq!(date_snapshot.primary.reset_at_ms, Some(1_700_000_000_000));
    }

    #[test]
    fn defers_requests_for_known_429_window() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        scheduler.mark_rate_limited("acc:model", 30_000.0, 1_000);

        let decision = scheduler.get_deferral("acc:model", 2_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::RateLimit));
        assert!(decision.wait_ms > 0);
    }

    #[test]
    fn preserves_longest_known_rate_limit_reset_across_overlapping_updates() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        scheduler.mark_rate_limited("acc:model", 30_000.0, 1_000);
        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 429,
                primary: QuotaSchedulerWindow::default(),
                secondary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(31_000),
                },
                updated_at: 1_000,
            },
        );
        scheduler.mark_rate_limited("acc:model", 10_000.0, 5_000);

        let decision = scheduler.get_deferral("acc:model", 6_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::RateLimit));
        assert_eq!(decision.wait_ms, 25_000);
    }

    #[test]
    fn uses_longest_active_reset_window_for_429_deferrals() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 429,
                primary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(31_000),
                },
                secondary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(61_000),
                },
                updated_at: 1_000,
            },
        );

        let decision = scheduler.get_deferral("acc:model", 6_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::RateLimit));
        assert_eq!(decision.wait_ms, 55_000);
    }

    #[test]
    fn preserves_secondary_near_exhaustion_state_when_marking_rate_limited() {
        let mut scheduler = PreemptiveQuotaScheduler::new(QuotaSchedulerOptions {
            remaining_percent_threshold_secondary: Some(5.0),
            ..Default::default()
        });
        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(10.0),
                    reset_at_ms: Some(0),
                },
                secondary: QuotaSchedulerWindow {
                    used_percent: Some(97.0),
                    reset_at_ms: Some(61_000),
                },
                updated_at: 1_000,
            },
        );
        scheduler.mark_rate_limited("acc:model", 30_000.0, 1_000);
        let stored = scheduler.snapshot_for_key("acc:model").expect("snapshot");
        assert_eq!(stored.secondary.used_percent, Some(97.0));
        assert_eq!(stored.secondary.reset_at_ms, Some(61_000));
    }

    #[test]
    fn sanitizes_non_finite_retry_after_values() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        scheduler.mark_rate_limited("acc:model", f64::NAN, 1_000);
        assert!(!scheduler.get_deferral("acc:model", 1_000).defer);

        scheduler.mark_rate_limited("acc:model", f64::INFINITY, 2_000);
        assert!(!scheduler.get_deferral("acc:model", 2_000).defer);

        scheduler.mark_rate_limited("acc:model", -1234.0, 3_000);
        assert!(!scheduler.get_deferral("acc:model", 3_000).defer);
    }

    #[test]
    fn defers_when_usage_near_exhaustion_and_reset_pending() {
        let mut scheduler = PreemptiveQuotaScheduler::new(QuotaSchedulerOptions {
            used_percent_threshold: Some(95.0),
            ..Default::default()
        });
        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(97.0),
                    reset_at_ms: Some(70_000),
                },
                secondary: QuotaSchedulerWindow::default(),
                updated_at: 10_000,
            },
        );

        let decision = scheduler.get_deferral("acc:model", 20_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::QuotaNearExhaustion));
    }

    #[test]
    fn uses_longest_near_exhausted_reset_window_for_quota_deferrals() {
        let mut scheduler = PreemptiveQuotaScheduler::new(QuotaSchedulerOptions {
            remaining_percent_threshold_primary: Some(5.0),
            remaining_percent_threshold_secondary: Some(5.0),
            ..Default::default()
        });
        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(96.0),
                    reset_at_ms: Some(70_000),
                },
                secondary: QuotaSchedulerWindow {
                    used_percent: Some(97.0),
                    reset_at_ms: Some(120_000),
                },
                updated_at: 10_000,
            },
        );

        let decision = scheduler.get_deferral("acc:model", 20_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::QuotaNearExhaustion));
        assert_eq!(decision.wait_ms, 100_000);
    }

    #[test]
    fn prunes_expired_snapshots() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        scheduler.update(
            "a",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(1_500),
                },
                secondary: QuotaSchedulerWindow::default(),
                updated_at: 1_000,
            },
        );
        scheduler.update(
            "b",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(20_000),
                },
                secondary: QuotaSchedulerWindow::default(),
                updated_at: 1_000,
            },
        );

        assert_eq!(scheduler.prune(2_000), 1);
        assert!(!scheduler.get_deferral("a", 2_100).defer);
        assert!(!scheduler.get_deferral("b", 2_100).defer);
    }

    #[test]
    fn uses_separate_primary_and_secondary_remaining_thresholds() {
        let mut scheduler = PreemptiveQuotaScheduler::new(QuotaSchedulerOptions {
            remaining_percent_threshold_primary: Some(10.0),
            remaining_percent_threshold_secondary: Some(2.0),
            ..Default::default()
        });
        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(91.0),
                    reset_at_ms: Some(65_000),
                },
                secondary: QuotaSchedulerWindow {
                    used_percent: Some(97.0),
                    reset_at_ms: Some(66_000),
                },
                updated_at: 1_000,
            },
        );

        let decision = scheduler.get_deferral("acc:model", 5_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::QuotaNearExhaustion));
    }

    #[test]
    fn can_disable_preemptive_deferral_without_clearing_snapshots() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        scheduler.mark_rate_limited("acc:model", 30_000.0, 1_000);
        assert!(scheduler.get_deferral("acc:model", 2_000).defer);

        scheduler.configure(QuotaSchedulerOptions {
            enabled: Some(false),
            ..Default::default()
        });
        assert!(!scheduler.get_deferral("acc:model", 2_000).defer);

        scheduler.configure(QuotaSchedulerOptions {
            enabled: Some(true),
            ..Default::default()
        });
        assert!(scheduler.get_deferral("acc:model", 2_000).defer);
    }

    #[test]
    fn ignores_empty_keys_and_falls_back_when_updated_at_is_falsy() {
        let now = now_ms();
        let mut scheduler = PreemptiveQuotaScheduler::default();

        scheduler.update(
            "",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(99.0),
                    reset_at_ms: Some(now + 60_000),
                },
                secondary: QuotaSchedulerWindow::default(),
                updated_at: now,
            },
        );
        scheduler.mark_rate_limited("", 30_000.0, now);
        assert_eq!(
            scheduler.get_deferral("", now + 1_000),
            QuotaDeferralDecision::no_defer()
        );

        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 429,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(100.0),
                    reset_at_ms: Some(now + 45_000),
                },
                secondary: QuotaSchedulerWindow::default(),
                updated_at: 0,
            },
        );
        let decision = scheduler.get_deferral("acc:model", now + 5_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::RateLimit));
    }

    #[test]
    fn prunes_using_latest_reset_from_primary_or_secondary() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        scheduler.update(
            "keep",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(1_000),
                },
                secondary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(7_000),
                },
                updated_at: 0,
            },
        );
        scheduler.update(
            "drop",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(1_000),
                },
                secondary: QuotaSchedulerWindow {
                    used_percent: None,
                    reset_at_ms: Some(1_500),
                },
                updated_at: 0,
            },
        );

        assert_eq!(scheduler.prune(2_000), 1);
        assert_eq!(scheduler.prune(8_000), 1);
    }

    #[test]
    fn h4_transient_429_does_not_bench_account_on_benign_weekly_window() {
        let mut scheduler = PreemptiveQuotaScheduler::default();
        let now: i64 = 1_000_000;
        let week_ms: i64 = 7 * 24 * 60 * 60 * 1000;
        // Healthy 200 snapshot: primary fine, weekly secondary resets ~7d out.
        scheduler.update(
            "acc:model",
            QuotaSchedulerSnapshot {
                status: 200,
                primary: QuotaSchedulerWindow {
                    used_percent: Some(20.0),
                    reset_at_ms: Some(now + 5 * 60_000),
                },
                secondary: QuotaSchedulerWindow {
                    used_percent: Some(30.0),
                    reset_at_ms: Some(now + week_ms),
                },
                updated_at: now,
            },
        );
        // Transient 60s 429.
        scheduler.mark_rate_limited("acc:model", 60_000.0, now);
        let decision = scheduler.get_deferral("acc:model", now + 1_000);
        assert!(decision.defer);
        assert_eq!(decision.reason, Some(QuotaDeferralReason::RateLimit));
        // Must reflect the ~60s retry window, NOT the 7d weekly reset (which
        // would clamp to the 2h deferral cap). Allow the remaining ~59s.
        assert!(decision.wait_ms <= 60_000);
        assert!(decision.wait_ms > 50_000);
        // After the 429 window passes, no longer rate-limit-deferred.
        let after = scheduler.get_deferral("acc:model", now + 61_000);
        assert_ne!(after.reason, Some(QuotaDeferralReason::RateLimit));
    }

    #[test]
    fn rate_limit_window_uses_rounded_left_percent_boundary() {
        // The scheduler is the ONE place the rounded left-percent (readiness
        // `quotaLeftPercentFromUsed`) decides rate-limit-window membership.
        let window = |used: Option<f64>| QuotaSchedulerWindow {
            used_percent: used,
            reset_at_ms: None,
        };
        // 99.6 used -> 0.4 left -> rounds to 0 -> rate-limit window.
        assert!(is_rate_limit_window(&window(Some(99.6))));
        // 99.5 used -> 0.5 left -> JS Math.round(0.5) === 1 -> NOT zero.
        assert!(!is_rate_limit_window(&window(Some(99.5))));
        // Over-100 usage clamps to 0 left.
        assert!(is_rate_limit_window(&window(Some(100.4))));
        assert!(is_rate_limit_window(&window(Some(250.0))));
        // Absent / non-finite usedPercent always counts.
        assert!(is_rate_limit_window(&window(None)));
        assert!(is_rate_limit_window(&window(Some(f64::NAN))));
        // Healthy usage never counts.
        assert!(!is_rate_limit_window(&window(Some(30.0))));
    }
}
