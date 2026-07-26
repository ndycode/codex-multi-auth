//! Port of `lib/forecast.ts` — PURE account-availability forecasting, risk
//! scoring, and recommendation. No I/O, no env.
//!
//! H5 rules (stress audit, spec 05 gotchas 2/4/5):
//! - On a 200 probe under usage pressure, only actually-exhausted windows
//!   (RAW `usedPercent >= 100`) contribute waits — a healthy weekly window's
//!   ~7d reset must never inflate `waitMs`. On a 429 every future window
//!   counts.
//! - A live window at 100% used with NO `resetAtMs` ⇒ `exhausted = true`
//!   (ready → delayed) even on a 200.
//! - Quota-exhausted accounts are classified `"delayed"` for display/sorting
//!   but carry `exhausted: true` and are EXCLUDED from the recommendation:
//!   an all-exhausted pool returns the null recommendation, never a bogus
//!   "pick shortest wait".

use std::collections::HashMap;

use cma_accounts::manager_persistence::{AccountLabelSource, format_account_label};
use cma_accounts::rate_limits::format_wait_time;
use cma_core::schemas::account_storage::AccountMetadataV3;
use cma_core::schemas::token::TokenFailure;
use serde::Serialize;

use crate::cache::QuotaCacheData;
use crate::probe::CodexQuotaSnapshot;
use crate::readiness::{
    find_quota_cache_entry_for_account, is_quota_cache_entry_exhausted,
    quota_used_percent_is_exhausted,
};

/// TS `ForecastAvailability = "ready" | "delayed" | "unavailable"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForecastAvailability {
    Ready,
    Delayed,
    Unavailable,
}

impl ForecastAvailability {
    pub const fn as_str(self) -> &'static str {
        match self {
            ForecastAvailability::Ready => "ready",
            ForecastAvailability::Delayed => "delayed",
            ForecastAvailability::Unavailable => "unavailable",
        }
    }

    /// Sort rank: ready=0, delayed=1, unavailable=2.
    const fn rank(self) -> u8 {
        match self {
            ForecastAvailability::Ready => 0,
            ForecastAvailability::Delayed => 1,
            ForecastAvailability::Unavailable => 2,
        }
    }
}

impl std::fmt::Display for ForecastAvailability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// TS `ForecastRiskLevel = "low" | "medium" | "high"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForecastRiskLevel {
    Low,
    Medium,
    High,
}

impl ForecastRiskLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            ForecastRiskLevel::Low => "low",
            ForecastRiskLevel::Medium => "medium",
            ForecastRiskLevel::High => "high",
        }
    }
}

impl std::fmt::Display for ForecastRiskLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// TS `RuntimeForecastOverlay` — persisted runtime-observability skip-reason
/// maps keyed by `String(index)` plus the policy-blocked index list.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RuntimeForecastOverlay {
    pub account_skip_reasons: HashMap<String, String>,
    pub last_pool_exhaustion_skip_reasons: HashMap<String, String>,
    pub policy_blocked_indexes: Vec<usize>,
}

/// TS `ForecastAccountInput`.
#[derive(Clone, Copy, Debug)]
pub struct ForecastAccountInput<'a> {
    pub index: usize,
    pub account: &'a AccountMetadataV3,
    pub is_current: bool,
    /// Caller-supplied clock (epoch ms).
    pub now: i64,
    pub refresh_failure: Option<&'a TokenFailure>,
    pub live_quota: Option<&'a CodexQuotaSnapshot>,
    pub quota_cache: Option<&'a QuotaCacheData>,
    /// Defaults to `[account]` when absent.
    pub all_accounts: Option<&'a [AccountMetadataV3]>,
    pub runtime_overlay: Option<&'a RuntimeForecastOverlay>,
}

impl<'a> ForecastAccountInput<'a> {
    /// Minimal input (everything optional unset) — mirrors the TS object
    /// literal with only the required fields.
    pub fn new(index: usize, account: &'a AccountMetadataV3, is_current: bool, now: i64) -> Self {
        ForecastAccountInput {
            index,
            account,
            is_current,
            now,
            refresh_failure: None,
            live_quota: None,
            quota_cache: None,
            all_accounts: None,
            runtime_overlay: None,
        }
    }
}

/// TS `ForecastAccountResult`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastAccountResult {
    pub index: usize,
    /// `redactEmails(formatAccountLabel(account, index))`.
    pub label: String,
    pub is_current: bool,
    pub availability: ForecastAvailability,
    /// Clamped int 0..=100.
    pub risk_score: i64,
    pub risk_level: ForecastRiskLevel,
    /// `Math.max(0, Math.floor(waitMs))`.
    pub wait_ms: i64,
    pub reasons: Vec<String>,
    pub hard_failure: bool,
    pub disabled: bool,
    /// Blocked solely by quota exhaustion; classified "delayed" but never
    /// recommendable.
    pub exhausted: bool,
}

/// TS `ForecastRecommendation`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastRecommendation {
    pub recommended_index: Option<usize>,
    pub reason: String,
}

/// One `considered` row of [`ForecastExplanation`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastExplanationAccount {
    pub index: usize,
    pub label: String,
    pub is_current: bool,
    pub availability: ForecastAvailability,
    pub risk_score: i64,
    pub risk_level: ForecastRiskLevel,
    pub wait_ms: i64,
    pub reasons: Vec<String>,
    pub selected: bool,
}

/// TS `ForecastExplanation`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastExplanation {
    pub recommended_index: Option<usize>,
    pub recommendation_reason: String,
    pub considered: Vec<ForecastExplanationAccount>,
}

/// TS `ForecastSummary`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastSummary {
    pub total: usize,
    pub ready: usize,
    pub delayed: usize,
    pub unavailable: usize,
    pub high_risk: usize,
}

// ---------------------------------------------------------------------------
// Redaction helpers (private but behavior-critical for output strings)
// ---------------------------------------------------------------------------

/// forecast.ts's OWN `maskEmail` — `atIndex <= 0` masks fully and the tld
/// fallback is `"***"`. Deliberately different from logger.ts's variant
/// (`atIndex < 0`, empty tld fallback) — do not unify (spec 05 gotcha 15).
fn mask_email(value: &str) -> String {
    let Some(at_index) = value.find('@') else {
        return "***@***".to_string();
    };
    if at_index == 0 {
        return "***@***".to_string();
    }
    let local = &value[..at_index];
    let domain = &value[at_index + 1..];
    // JS `domain.split(".").pop()` — the last dot segment (the whole domain
    // when it has no dot; `""` for an empty domain).
    let tld = domain.rsplit('.').next().unwrap_or("");
    let prefix: String = local.chars().take(2).collect();
    let tld = if tld.is_empty() { "***" } else { tld };
    format!("{prefix}***@***.{tld}")
}

fn is_email_local_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
}

fn is_email_domain_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-')
}

/// Hand-rolled equivalent of the JS global regex
/// `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g` with each match
/// replaced by [`mask_email`] (the `regex` crate is not a cma-quota
/// dependency; the charset is ASCII-only so a scanner reproduces the
/// leftmost-greedy semantics exactly).
fn redact_emails(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut scan_from = 0usize; // chars at < scan_from are already emitted
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }
        // Local part: maximal run of local chars ending right before the '@'
        // (must not reach into already-consumed output).
        let mut local_start = i;
        while local_start > scan_from && is_email_local_char(chars[local_start - 1]) {
            local_start -= 1;
        }
        if local_start == i {
            i += 1;
            continue; // no local part → no match at this '@'
        }
        // Domain run after '@'.
        let run_start = i + 1;
        let mut run_end = run_start;
        while run_end < chars.len() && is_email_domain_char(chars[run_end]) {
            run_end += 1;
        }
        if run_end == run_start {
            i += 1;
            continue;
        }
        // Greedy domain with backtracking: the RIGHTMOST '.' inside the run
        // that (a) leaves a non-empty domain part before it and (b) is
        // followed by >= 2 ASCII letters. The tld is the maximal letter run
        // after that dot (the match may end before run_end, e.g. "b.comx2").
        let mut match_end: Option<usize> = None;
        for d in (run_start + 1..run_end).rev() {
            if chars[d] != '.' {
                continue;
            }
            let mut t_end = d + 1;
            while t_end < run_end && chars[t_end].is_ascii_alphabetic() {
                t_end += 1;
            }
            if t_end - (d + 1) >= 2 {
                match_end = Some(t_end);
                break;
            }
        }
        let Some(match_end) = match_end else {
            i += 1;
            continue;
        };
        // Emit the unmatched prefix, then the masked match.
        out.extend(&chars[scan_from..local_start]);
        let matched: String = chars[local_start..match_end].iter().collect();
        out.push_str(&mask_email(&matched));
        scan_from = match_end;
        i = match_end;
    }
    out.extend(&chars[scan_from..]);
    out
}

/// Hand-rolled `/Bearer\s+\S+/gi` → `"Bearer ***"`.
fn redact_bearer_tokens(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0usize;
    while i < chars.len() {
        let is_bearer = chars.len() - i >= 6
            && chars[i..i + 6]
                .iter()
                .zip("bearer".chars())
                .all(|(c, b)| c.to_ascii_lowercase() == b);
        if is_bearer {
            let mut j = i + 6;
            let ws_start = j;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j > ws_start {
                let token_start = j;
                while j < chars.len() && !chars[j].is_whitespace() {
                    j += 1;
                }
                if j > token_start {
                    out.push_str("Bearer ***");
                    i = j;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Hand-rolled `/\b(sk-[A-Za-z0-9]{10,})\b/g` → `"***"` (JS word chars are
/// `[A-Za-z0-9_]`; a trailing `_` breaks the closing `\b`).
fn redact_sk_tokens(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0usize;
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    while i < chars.len() {
        let starts_sk =
            chars.len() - i >= 3 && chars[i] == 's' && chars[i + 1] == 'k' && chars[i + 2] == '-';
        let boundary_before = i == 0 || !is_word(chars[i - 1]);
        if starts_sk && boundary_before {
            let mut j = i + 3;
            while j < chars.len() && chars[j].is_ascii_alphanumeric() {
                j += 1;
            }
            let run_len = j - (i + 3);
            let boundary_after = j >= chars.len() || !is_word(chars[j]);
            if run_len >= 10 && boundary_after {
                out.push_str("***");
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// TS `redactSensitiveReason` — Bearer tokens, `sk-` keys, then emails.
fn redact_sensitive_reason(value: &str) -> String {
    redact_emails(&redact_sk_tokens(&redact_bearer_tokens(value)))
}

/// TS `summarizeRefreshFailure` — reason code (plus `" (status)"`) wins;
/// otherwise the redacted message (or `"refresh failed"`) capped at 160.
fn summarize_refresh_failure(failure: &TokenFailure) -> String {
    if let Some(reason) = &failure.reason {
        let status_code = match failure.status_code {
            Some(status) => format!(" ({status})"),
            None => String::new(),
        };
        return format!("{}{status_code}", reason.as_str());
    }
    let fallback = failure
        .message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .unwrap_or("refresh failed");
    redact_sensitive_reason(fallback)
        .chars()
        .take(160)
        .collect()
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/// TS `clampRisk` — `max(0, min(100, round(score)))` (i64 scores are always
/// finite integers; the TS non-finite → 100 branch is unreachable here).
fn clamp_risk(score: i64) -> i64 {
    score.clamp(0, 100)
}

/// TS `getRiskLevel` — `>= 75` high, `>= 40` medium, else low.
fn get_risk_level(score: i64) -> ForecastRiskLevel {
    if score >= 75 {
        ForecastRiskLevel::High
    } else if score >= 40 {
        ForecastRiskLevel::Medium
    } else {
        ForecastRiskLevel::Low
    }
}

/// Local port of `getRateLimitResetTimeForFamily(account, now, "codex")`
/// (TS `lib/runtime/account-status.ts` — that module lands in `cma-runtime`,
/// which sits ABOVE this crate in the DAG, so forecast carries its own copy):
/// minimum strictly-future value among `rateLimitResetTimes` entries whose
/// key is exactly the family or starts with `"{family}:"`.
fn rate_limit_reset_time_for_codex_family(account: &AccountMetadataV3, now: i64) -> Option<i64> {
    let times = account.rate_limit_reset_times.as_ref()?;
    let mut min_reset: Option<i64> = None;
    for (key, value) in times.iter() {
        if value <= now {
            continue;
        }
        if key != "codex" && !key.starts_with("codex:") {
            continue;
        }
        if min_reset.is_none_or(|current| value < current) {
            min_reset = Some(value);
        }
    }
    min_reset
}

/// TS `getLiveQuotaWaitMs(snapshot, now, onlyExhausted)`.
///
/// Under pure usage pressure (not a 429), only an actually-exhausted window
/// (100% used, RAW) imposes a wait — a healthy weekly secondary normally
/// resets ~7d out; folding that in would overstate the wait by orders of
/// magnitude and invert the recommendation (stress audit H5). On a 429 every
/// future window is honored.
fn get_live_quota_wait_ms(snapshot: &CodexQuotaSnapshot, now: i64, only_exhausted: bool) -> i64 {
    let mut max_wait: Option<i64> = None;
    for window in [&snapshot.primary, &snapshot.secondary] {
        if only_exhausted && !quota_used_percent_is_exhausted(window.used_percent) {
            continue;
        }
        let Some(reset_at) = window.reset_at_ms else {
            continue;
        };
        let remaining = reset_at - now;
        if remaining > 0 && max_wait.is_none_or(|current| remaining > current) {
            max_wait = Some(remaining);
        }
    }
    max_wait.unwrap_or(0)
}

/// TS `describeQuotaUsage` — `"{label} quota {bounded}% used"` with the
/// bounded ROUNDED percent (display only).
fn describe_quota_usage(label: &str, used_percent: Option<f64>) -> Option<String> {
    let used = used_percent?;
    if !used.is_finite() {
        return None;
    }
    let bounded = used.round().clamp(0.0, 100.0) as i64;
    Some(format!("{label} quota {bounded}% used"))
}

/// TS `isHardRefreshFailure` — `missing_refresh`, 401, or a 400 whose
/// message mentions an invalid/revoked grant.
pub fn is_hard_refresh_failure(failure: &TokenFailure) -> bool {
    use cma_core::schemas::token::TokenFailureReason;
    if failure.reason == Some(TokenFailureReason::MissingRefresh) {
        return true;
    }
    if failure.status_code == Some(401) {
        return true;
    }
    if failure.status_code != Some(400) {
        return false;
    }
    let message = failure.message.as_deref().unwrap_or("").to_lowercase();
    message.contains("invalid_grant")
        || message.contains("invalid refresh")
        || message.contains("token has been revoked")
}

/// TS `appendWaitReason` — only appended when the wait is positive.
fn append_wait_reason(reasons: &mut Vec<String>, prefix: &str, wait_ms: i64) {
    if wait_ms <= 0 {
        return;
    }
    reasons.push(format!("{prefix} {}", format_wait_time(wait_ms)));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/// TS `evaluateForecastAccount(input)` — order matters; risk deltas are
/// additive. See the module docs for the H5 rules.
pub fn evaluate_forecast_account(input: &ForecastAccountInput<'_>) -> ForecastAccountResult {
    let account = input.account;
    let index = input.index;
    let now = input.now;
    let mut reasons: Vec<String> = Vec::new();
    let mut availability = ForecastAvailability::Ready;
    let mut risk_score: i64 = if input.is_current { -5 } else { 0 };
    let mut wait_ms: f64 = 0.0;
    let mut hard_failure = false;
    let mut exhausted = false;
    // Only strict `false` disables; `undefined` is enabled.
    let disabled = account.enabled == Some(false);

    if disabled {
        availability = ForecastAvailability::Unavailable;
        risk_score += 95;
        reasons.push("account is disabled".to_string());
    }

    if let Some(failure) = input.refresh_failure {
        let hard = is_hard_refresh_failure(failure);
        hard_failure = hard;
        let detail = summarize_refresh_failure(failure);
        if hard {
            availability = ForecastAvailability::Unavailable;
            risk_score += 90;
            reasons.push(format!("hard auth failure: {detail}"));
        } else {
            risk_score += 25;
            reasons.push(format!("refresh warning: {detail}"));
        }
    }

    let cooling_down_active = matches!(account.cooling_down_until, Some(until) if until > now);
    if let Some(cooling_down_until) = account.cooling_down_until
        && cooling_down_until > now
    {
        let remaining = cooling_down_until - now;
        wait_ms = wait_ms.max(remaining as f64);
        if availability == ForecastAvailability::Ready {
            availability = ForecastAvailability::Delayed;
        }
        risk_score += 45;
        append_wait_reason(&mut reasons, "cooldown remaining", remaining);
    }

    let rate_limit_reset_at = rate_limit_reset_time_for_codex_family(account, now);
    if let Some(reset_at) = rate_limit_reset_at {
        let remaining = (reset_at - now).max(0);
        wait_ms = wait_ms.max(remaining as f64);
        if availability == ForecastAvailability::Ready {
            availability = ForecastAvailability::Delayed;
        }
        risk_score += 35;
        append_wait_reason(&mut reasons, "rate limit resets in", remaining);
    }

    let single_account = std::slice::from_ref(account);
    let all_accounts = input.all_accounts.unwrap_or(single_account);
    let quota_entry = find_quota_cache_entry_for_account(input.quota_cache, &account, all_accounts);
    if is_quota_cache_entry_exhausted(quota_entry, now) {
        // Only a window that is genuinely at/over 100% used contributes its
        // reset time. Testing the ROUNDED left-percent instead would treat a
        // 99.6%-used sibling as at-limit and fold its (possibly far-future)
        // reset into the max below, overstating the wait for an account whose
        // actually-exhausted window recovers much sooner.
        let mut reset_ats: Vec<f64> = Vec::new();
        if let Some(entry) = quota_entry {
            for window in [&entry.primary, &entry.secondary] {
                if quota_used_percent_is_exhausted(window.used_percent)
                    && let Some(reset_at) = window.reset_at_ms
                    && reset_at.is_finite()
                    && reset_at > now as f64
                {
                    reset_ats.push(reset_at);
                }
            }
        }
        // Fallback to the CURRENT waitMs (not 0) when no window carries a
        // usable future reset (spec 05 gotcha 22).
        let quota_wait = if reset_ats.is_empty() {
            wait_ms
        } else {
            reset_ats.iter().copied().fold(f64::MIN, f64::max) - now as f64
        };
        wait_ms = wait_ms.max(quota_wait);
        if availability == ForecastAvailability::Ready {
            availability = ForecastAvailability::Delayed;
        }
        exhausted = true;
        risk_score += 60;
        reasons.push("quota cache exhausted".to_string());
        append_wait_reason(&mut reasons, "quota resets in", quota_wait.floor() as i64);
    }

    // Time-bounded overlay reasons ("rate-limited", "cooling-down:...") are
    // persisted to runtime-observability.json on pool exhaustion and only
    // ever cleared by an explicit runtime reset, never on a subsequent
    // successful request. That leaves a stale reason on disk after the
    // underlying window expires, so the forecast would keep marking a working
    // account as unavailable. Cross-reference the time-aware disk state
    // before applying: drop the overlay reason when the condition it
    // describes is no longer active. Each reason validates only against its
    // own backing disk state ("rate-limited" → rateLimitResetTimes,
    // "cooling-down" → coolingDownUntil) so we never substitute a misleading
    // reason string. Non-time-bounded reasons ("circuit-open",
    // "token-exhausted", "policy-blocked") have no disk expiry to check and
    // are always applied.
    let overlay = input.runtime_overlay;
    let index_key = index.to_string();
    let overlay_reason: Option<&str> = overlay.and_then(|overlay| {
        overlay
            .account_skip_reasons
            .get(&index_key)
            .or_else(|| overlay.last_pool_exhaustion_skip_reasons.get(&index_key))
            .map(String::as_str)
    });
    let is_stale_overlay_reason = match overlay_reason {
        Some("rate-limited") => rate_limit_reset_at.is_none(),
        Some(reason) if reason.starts_with("cooling-down") => !cooling_down_active,
        _ => false,
    };
    if overlay.is_some_and(|overlay| overlay.policy_blocked_indexes.contains(&index)) {
        availability = ForecastAvailability::Unavailable;
        risk_score += 95;
        reasons.push("runtime policy blocked account".to_string());
    } else if let Some(reason) = overlay_reason
        && reason != "already-attempted"
        && !is_stale_overlay_reason
    {
        availability = ForecastAvailability::Unavailable;
        risk_score += match reason {
            "circuit-open" => 90,
            "token-exhausted" => 70,
            _ => 50,
        };
        reasons.push(format!("runtime skip: {reason}"));
    }

    if let Some(quota) = input.live_quota {
        let primary_used = quota.primary.used_percent.unwrap_or(0.0);
        let secondary_used = quota.secondary.used_percent.unwrap_or(0.0);
        let quota_pressure = quota.status == 429 || primary_used >= 90.0 || secondary_used >= 90.0;

        if quota.status == 429 {
            if availability != ForecastAvailability::Unavailable {
                availability = ForecastAvailability::Delayed;
            }
            risk_score += 35;
            reasons.push("live probe returned 429".to_string());
        }
        let live_wait = if quota_pressure {
            get_live_quota_wait_ms(quota, now, quota.status != 429)
        } else {
            0
        };
        wait_ms = wait_ms.max(live_wait as f64);
        if live_wait > 0 && availability == ForecastAvailability::Ready {
            availability = ForecastAvailability::Delayed;
        }

        // A live window at 100% used with NO resetAtMs has no known recovery
        // time — on a 200 probe getLiveQuotaWaitMs yields 0 and the 429
        // branch never fires, so without this the account would stay "ready"
        // and be recommended as a healthy pick. A window WITH a resetAtMs is
        // only *delayed*, not exhausted. The raw-usedPercent test keeps 99.6%
        // from being falsely benched.
        let live_exhausted = (quota_used_percent_is_exhausted(quota.primary.used_percent)
            && quota.primary.reset_at_ms.is_none())
            || (quota_used_percent_is_exhausted(quota.secondary.used_percent)
                && quota.secondary.reset_at_ms.is_none());
        if live_exhausted {
            exhausted = true;
            if availability == ForecastAvailability::Ready {
                availability = ForecastAvailability::Delayed;
            }
        }

        if let Some(usage) = describe_quota_usage("primary", quota.primary.used_percent) {
            reasons.push(usage);
        }
        if let Some(usage) = describe_quota_usage("secondary", quota.secondary.used_percent) {
            reasons.push(usage);
        }

        if primary_used >= 98.0 || secondary_used >= 98.0 {
            risk_score += 55;
        } else if primary_used >= 90.0 || secondary_used >= 90.0 {
            risk_score += 35;
        } else if primary_used >= 80.0 || secondary_used >= 80.0 {
            risk_score += 20;
        } else if primary_used >= 70.0 || secondary_used >= 70.0 {
            risk_score += 10;
        }
    }

    // Staleness: `lastUsed` in the future (negative age) → +5; older than
    // 7 days → +10. `lastUsed <= 0` means "never" — no penalty at all.
    let has_last_used = account.last_used > 0;
    if has_last_used {
        let last_used_age = now - account.last_used;
        if last_used_age < 0 {
            risk_score += 5;
        } else if last_used_age > 7 * 24 * 60 * 60 * 1000 {
            risk_score += 10;
        }
    }

    let final_risk = clamp_risk(risk_score);
    ForecastAccountResult {
        index,
        label: redact_emails(&format_account_label(
            Some(account as &dyn AccountLabelSource),
            index,
        )),
        is_current: input.is_current,
        availability,
        risk_score: final_risk,
        risk_level: get_risk_level(final_risk),
        wait_ms: (wait_ms.floor() as i64).max(0),
        reasons,
        hard_failure,
        disabled,
        exhausted,
    }
}

/// TS `evaluateForecastAccounts(inputs)` — simple map.
pub fn evaluate_forecast_accounts(
    inputs: &[ForecastAccountInput<'_>],
) -> Vec<ForecastAccountResult> {
    inputs.iter().map(evaluate_forecast_account).collect()
}

/// TS `compareForecastResults` — availability rank, then (both-delayed)
/// ascending wait, then ascending risk, current-first, ascending index.
fn compare_forecast_results(
    a: &ForecastAccountResult,
    b: &ForecastAccountResult,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let rank = a.availability.rank().cmp(&b.availability.rank());
    if rank != Ordering::Equal {
        return rank;
    }
    if a.availability == ForecastAvailability::Delayed
        && b.availability == ForecastAvailability::Delayed
        && a.wait_ms != b.wait_ms
    {
        return a.wait_ms.cmp(&b.wait_ms);
    }
    if a.risk_score != b.risk_score {
        return a.risk_score.cmp(&b.risk_score);
    }
    if a.is_current != b.is_current {
        return if a.is_current {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    a.index.cmp(&b.index)
}

/// TS `recommendForecastAccount(results)`.
///
/// Excludes disabled, hard-failed, `exhausted`, and unavailable accounts —
/// an all-exhausted pool returns the null recommendation, never a bogus
/// "shortest wait" pick.
pub fn recommend_forecast_account(results: &[ForecastAccountResult]) -> ForecastRecommendation {
    let candidates: Vec<&ForecastAccountResult> = results
        .iter()
        .filter(|result| {
            !result.disabled
                && !result.hard_failure
                && !result.exhausted
                && result.availability != ForecastAvailability::Unavailable
        })
        .collect();
    if candidates.is_empty() {
        // Distinguish "blocked/exhausted" accounts (unavailable but neither
        // disabled nor hard-failed, or quota-exhausted "delayed" ones) from
        // disabled/hard-failed pools so the guidance matches the blocker.
        let has_blocked_or_exhausted = results.iter().any(|result| {
            !result.disabled
                && !result.hard_failure
                && (result.exhausted || result.availability == ForecastAvailability::Unavailable)
        });
        return ForecastRecommendation {
            recommended_index: None,
            reason: if has_blocked_or_exhausted {
                "All accounts are blocked or exhausted. Wait for a reset, clear the block, or run `codex-multi-auth login` to add a fresh account.".to_string()
            } else {
                "No healthy accounts are available. Run `codex-multi-auth login` to add a fresh account.".to_string()
            },
        };
    }

    let mut sorted = candidates;
    sorted.sort_by(|a, b| compare_forecast_results(a, b));
    let Some(best) = sorted.first() else {
        // Defensive branch (unreachable in practice — mirrors the TS).
        return ForecastRecommendation {
            recommended_index: None,
            reason: "No recommendation available.".to_string(),
        };
    };

    if best.availability == ForecastAvailability::Ready {
        return ForecastRecommendation {
            recommended_index: Some(best.index),
            reason: format!(
                "Lowest risk ready account ({}, score {}).",
                best.risk_level, best.risk_score
            ),
        };
    }

    ForecastRecommendation {
        recommended_index: Some(best.index),
        reason: format!(
            "No account is immediately ready; pick shortest wait ({}).",
            format_wait_time(best.wait_ms)
        ),
    }
}

/// TS `summarizeForecast(results)`.
pub fn summarize_forecast(results: &[ForecastAccountResult]) -> ForecastSummary {
    ForecastSummary {
        total: results.len(),
        ready: results
            .iter()
            .filter(|result| result.availability == ForecastAvailability::Ready)
            .count(),
        delayed: results
            .iter()
            .filter(|result| result.availability == ForecastAvailability::Delayed)
            .count(),
        unavailable: results
            .iter()
            .filter(|result| result.availability == ForecastAvailability::Unavailable)
            .count(),
        high_risk: results
            .iter()
            .filter(|result| result.risk_level == ForecastRiskLevel::High)
            .count(),
    }
}

/// TS `buildForecastExplanation(results, recommendation)` —
/// `selected = recommendation.recommendedIndex === result.index`.
pub fn build_forecast_explanation(
    results: &[ForecastAccountResult],
    recommendation: &ForecastRecommendation,
) -> ForecastExplanation {
    ForecastExplanation {
        recommended_index: recommendation.recommended_index,
        recommendation_reason: recommendation.reason.clone(),
        considered: results
            .iter()
            .map(|result| ForecastExplanationAccount {
                index: result.index,
                label: result.label.clone(),
                is_current: result.is_current,
                availability: result.availability,
                risk_score: result.risk_score,
                risk_level: result.risk_level,
                wait_ms: result.wait_ms,
                reasons: result.reasons.clone(),
                selected: recommendation.recommended_index == Some(result.index),
            })
            .collect(),
    }
}

// ============================================================================
// Tests — ported from test/forecast.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::{QuotaCacheEntry, QuotaCacheWindow};
    use crate::probe::CodexQuotaWindow;
    use cma_core::schemas::account_storage::RateLimitStateV3;
    use cma_core::schemas::token::TokenFailureReason;

    const NOW: i64 = 1_700_000_000_000;

    fn account(now: i64) -> AccountMetadataV3 {
        AccountMetadataV3::new("refresh-1", now - 10_000, now - 10_000)
    }

    fn failure(
        reason: Option<TokenFailureReason>,
        status_code: Option<i64>,
        message: Option<&str>,
    ) -> TokenFailure {
        TokenFailure {
            reason,
            status_code,
            message: message.map(str::to_string),
        }
    }

    fn live_quota(
        status: u16,
        primary: CodexQuotaWindow,
        secondary: CodexQuotaWindow,
    ) -> CodexQuotaSnapshot {
        CodexQuotaSnapshot {
            status,
            plan_type: None,
            active_limit: None,
            primary,
            secondary,
            model: "gpt-5-codex".to_string(),
        }
    }

    fn live_window(used_percent: Option<f64>, reset_at_ms: Option<i64>) -> CodexQuotaWindow {
        CodexQuotaWindow {
            used_percent,
            window_minutes: None,
            reset_at_ms,
        }
    }

    fn exhausted_cache(account_id: &str, entry: QuotaCacheEntry) -> QuotaCacheData {
        let mut cache = QuotaCacheData::default();
        cache.by_account_id.insert(account_id, entry);
        cache
    }

    fn cache_entry(primary: QuotaCacheWindow, secondary: QuotaCacheWindow) -> QuotaCacheEntry {
        QuotaCacheEntry {
            updated_at: NOW as f64,
            status: 200.0,
            model: "gpt-5.3-codex".to_string(),
            plan_type: None,
            primary,
            secondary,
        }
    }

    fn cache_window(used_percent: Option<f64>, reset_at_ms: Option<f64>) -> QuotaCacheWindow {
        QuotaCacheWindow {
            used_percent,
            window_minutes: None,
            reset_at_ms,
        }
    }

    #[test]
    fn marks_disabled_account_as_unavailable_high_risk() {
        let mut meta = AccountMetadataV3::new("refresh-1", NOW - 1_000, NOW - 1_000);
        meta.enabled = Some(false);
        let result = evaluate_forecast_account(&ForecastAccountInput::new(0, &meta, false, NOW));
        assert_eq!(result.availability, ForecastAvailability::Unavailable);
        assert_eq!(result.risk_level, ForecastRiskLevel::High);
        assert!(result.disabled);
    }

    #[test]
    fn detects_hard_refresh_failures() {
        assert!(is_hard_refresh_failure(&failure(
            Some(TokenFailureReason::MissingRefresh),
            None,
            None
        )));
        assert!(is_hard_refresh_failure(&failure(
            Some(TokenFailureReason::HttpError),
            Some(400),
            Some("invalid_grant: token revoked")
        )));
        assert!(!is_hard_refresh_failure(&failure(
            Some(TokenFailureReason::NetworkError),
            None,
            Some("timeout")
        )));
    }

    #[test]
    fn raises_risk_when_live_quota_usage_is_very_high() {
        let meta = account(NOW);
        let quota = live_quota(
            200,
            live_window(Some(95.0), None),
            live_window(Some(20.0), None),
        );
        let mut input = ForecastAccountInput::new(0, &meta, true, NOW);
        input.live_quota = Some(&quota);
        let result = evaluate_forecast_account(&input);
        assert!(result.risk_score >= 30);
        assert!(
            result
                .reasons
                .iter()
                .any(|reason| reason.contains("primary quota"))
        );
    }

    #[test]
    fn marks_quota_cache_exhausted_accounts_as_delayed_instead_of_ready() {
        let mut meta = account(NOW);
        meta.email = Some("quota@example.com".to_string());
        meta.account_id = Some("acc_quota".to_string());
        let cache = exhausted_cache(
            "acc_quota",
            cache_entry(
                cache_window(Some(100.0), Some((NOW + 60_000) as f64)),
                cache_window(Some(25.0), Some((NOW + 300_000) as f64)),
            ),
        );
        let all = vec![meta.clone()];
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.quota_cache = Some(&cache);
        input.all_accounts = Some(&all);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert_eq!(result.wait_ms, 60_000);
        assert!(result.reasons.iter().any(|r| r == "quota cache exhausted"));
        assert!(result.exhausted);
    }

    #[test]
    fn waits_for_the_later_quota_reset_when_both_cached_windows_are_exhausted() {
        let mut meta = account(NOW);
        meta.email = Some("quota@example.com".to_string());
        meta.account_id = Some("acc_quota".to_string());
        let cache = exhausted_cache(
            "acc_quota",
            cache_entry(
                cache_window(Some(100.0), Some((NOW + 60_000) as f64)),
                cache_window(Some(100.0), Some((NOW + 300_000) as f64)),
            ),
        );
        let all = vec![meta.clone()];
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.quota_cache = Some(&cache);
        input.all_accounts = Some(&all);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert_eq!(result.wait_ms, 300_000);
        assert!(result.reasons.iter().any(|r| r == "quota cache exhausted"));
        assert!(result.reasons.iter().any(|r| r == "quota resets in 5m 0s"));
    }

    #[test]
    fn ignores_a_99_6_used_sibling_window_when_computing_the_exhausted_wait() {
        let mut meta = account(NOW);
        meta.email = Some("quota@example.com".to_string());
        meta.account_id = Some("acc_quota".to_string());
        let cache = exhausted_cache(
            "acc_quota",
            cache_entry(
                // Genuinely exhausted, recovers in a minute.
                cache_window(Some(100.0), Some((NOW + 60_000) as f64)),
                // 99.6% used ROUNDS to 0 left but still has quota; its
                // 28-day monthly reset must not be folded in.
                cache_window(Some(99.6), Some((NOW + 28 * 86_400_000) as f64)),
            ),
        );
        let all = vec![meta.clone()];
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.quota_cache = Some(&cache);
        input.all_accounts = Some(&all);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert_eq!(result.wait_ms, 60_000);
    }

    #[test]
    fn applies_runtime_overlay_skip_reasons_to_forecast_availability() {
        let meta = account(NOW);
        let raw = evaluate_forecast_account(&ForecastAccountInput::new(0, &meta, false, NOW));
        assert_eq!(raw.availability, ForecastAvailability::Ready);

        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .last_pool_exhaustion_skip_reasons
            .insert("0".to_string(), "circuit-open".to_string());
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let overlaid = evaluate_forecast_account(&input);
        assert_eq!(overlaid.availability, ForecastAvailability::Unavailable);
        assert!(
            overlaid
                .reasons
                .iter()
                .any(|r| r == "runtime skip: circuit-open")
        );
    }

    #[test]
    fn marks_non_time_bounded_runtime_skip_reasons_as_unavailable() {
        for reason in ["circuit-open", "token-exhausted", "workspace-disabled"] {
            let meta = account(NOW);
            let mut overlay = RuntimeForecastOverlay::default();
            overlay
                .last_pool_exhaustion_skip_reasons
                .insert("0".to_string(), reason.to_string());
            let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
            input.runtime_overlay = Some(&overlay);
            let result = evaluate_forecast_account(&input);
            assert_eq!(result.availability, ForecastAvailability::Unavailable);
            assert!(
                result
                    .reasons
                    .iter()
                    .any(|r| r == &format!("runtime skip: {reason}"))
            );
        }
    }

    #[test]
    fn ignores_a_stale_rate_limited_overlay_when_no_rate_limit_is_active_on_disk() {
        let mut meta = account(NOW);
        // Expired entry: no longer an active rate limit.
        let mut times = RateLimitStateV3::new();
        times.insert("codex", NOW - 30_000);
        meta.rate_limit_reset_times = Some(times);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .last_pool_exhaustion_skip_reasons
            .insert("0".to_string(), "rate-limited".to_string());
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Ready);
        assert!(result.reasons.is_empty());
    }

    #[test]
    fn ignores_a_stale_rate_limited_overlay_when_rate_limit_reset_times_is_absent() {
        let meta = account(NOW);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .last_pool_exhaustion_skip_reasons
            .insert("0".to_string(), "rate-limited".to_string());
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Ready);
    }

    #[test]
    fn applies_a_rate_limited_overlay_when_the_rate_limit_is_still_active_on_disk() {
        let mut meta = account(NOW);
        let mut times = RateLimitStateV3::new();
        times.insert("codex", NOW + 120_000);
        meta.rate_limit_reset_times = Some(times);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .account_skip_reasons
            .insert("0".to_string(), "rate-limited".to_string());
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Unavailable);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "runtime skip: rate-limited")
        );
    }

    #[test]
    fn applies_a_rate_limited_overlay_when_a_model_scoped_limit_is_active_on_disk() {
        let mut meta = account(NOW);
        let mut times = RateLimitStateV3::new();
        times.insert("codex:gpt-5.3-codex", NOW + 120_000);
        meta.rate_limit_reset_times = Some(times);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .account_skip_reasons
            .insert("0".to_string(), "rate-limited".to_string());
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Unavailable);
    }

    #[test]
    fn cooling_down_overlay_staleness_rules() {
        // Elapsed cooldown → stale, ignored.
        let mut meta = account(NOW);
        meta.cooling_down_until = Some(NOW - 1_000);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .account_skip_reasons
            .insert("0".to_string(), "cooling-down:server-error".to_string());
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Ready);

        // Absent coolingDownUntil → stale, ignored.
        let meta = account(NOW);
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Ready);

        // Active cooldown → applied.
        let mut meta = account(NOW);
        meta.cooling_down_until = Some(NOW + 60_000);
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Unavailable);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "runtime skip: cooling-down:server-error")
        );
    }

    #[test]
    fn already_attempted_overlay_reason_is_always_ignored() {
        let meta = account(NOW);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .account_skip_reasons
            .insert("0".to_string(), "already-attempted".to_string());
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Ready);
    }

    #[test]
    fn policy_block_takes_precedence_over_skip_reasons() {
        let meta = account(NOW);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay
            .account_skip_reasons
            .insert("0".to_string(), "circuit-open".to_string());
        overlay.policy_blocked_indexes.push(0);
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Unavailable);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "runtime policy blocked account")
        );
        assert!(!result.reasons.iter().any(|r| r.starts_with("runtime skip")));
    }

    #[test]
    fn recommends_the_best_ready_account() {
        let meta_a = account(NOW);
        let meta_b = account(NOW);
        let results = vec![
            evaluate_forecast_account(&ForecastAccountInput::new(0, &meta_a, false, NOW)),
            evaluate_forecast_account(&ForecastAccountInput::new(1, &meta_b, true, NOW)),
        ];
        let recommendation = recommend_forecast_account(&results);
        // The current account starts at -5 risk (clamped to 0) and ties are
        // broken current-first.
        assert_eq!(recommendation.recommended_index, Some(1));
        assert_eq!(
            recommendation.reason,
            "Lowest risk ready account (low, score 0)."
        );
    }

    #[test]
    fn redacts_sensitive_refresh_warning_details() {
        let meta = account(NOW);
        let refresh_failure = failure(
            None,
            None,
            Some("Bearer abc.def.ghi rejected for user@example.com (key sk-abcdefghij12345)"),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.refresh_failure = Some(&refresh_failure);
        let result = evaluate_forecast_account(&input);
        let reason = result
            .reasons
            .iter()
            .find(|r| r.starts_with("refresh warning:"))
            .expect("refresh warning reason");
        assert!(!reason.contains("abc.def.ghi"), "bearer leaked: {reason}");
        assert!(
            !reason.contains("user@example.com"),
            "email leaked: {reason}"
        );
        assert!(
            !reason.contains("sk-abcdefghij12345"),
            "key leaked: {reason}"
        );
        assert_eq!(
            reason,
            "refresh warning: Bearer *** rejected for us***@***.com (key ***)"
        );
    }

    #[test]
    fn marks_hard_refresh_failure_as_unavailable() {
        let meta = account(NOW);
        let refresh_failure = failure(Some(TokenFailureReason::MissingRefresh), None, None);
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.refresh_failure = Some(&refresh_failure);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Unavailable);
        assert!(result.hard_failure);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "hard auth failure: missing_refresh")
        );
    }

    #[test]
    fn prefers_refresh_failure_reason_code_over_raw_message_text() {
        let meta = account(NOW);
        let refresh_failure = failure(
            Some(TokenFailureReason::HttpError),
            Some(429),
            Some("something noisy"),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.refresh_failure = Some(&refresh_failure);
        let result = evaluate_forecast_account(&input);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "refresh warning: http_error (429)")
        );
    }

    #[test]
    fn uses_redacted_fallback_refresh_messages_when_reason_code_is_blank() {
        let meta = account(NOW);
        let refresh_failure = failure(None, None, Some("   "));
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.refresh_failure = Some(&refresh_failure);
        let result = evaluate_forecast_account(&input);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "refresh warning: refresh failed")
        );
    }

    #[test]
    fn uses_max_of_cooldown_and_rate_limit_wait_for_delayed_availability() {
        let mut meta = account(NOW);
        meta.cooling_down_until = Some(NOW + 30_000);
        let mut times = RateLimitStateV3::new();
        times.insert("codex", NOW + 90_000);
        meta.rate_limit_reset_times = Some(times);
        let result = evaluate_forecast_account(&ForecastAccountInput::new(0, &meta, false, NOW));
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert_eq!(result.wait_ms, 90_000);
        assert!(result.reasons.iter().any(|r| r == "cooldown remaining 30s"));
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "rate limit resets in 1m 30s")
        );
    }

    #[test]
    fn marks_delayed_on_live_429_and_tracks_quota_reset_wait() {
        let meta = account(NOW);
        // 429 honors EVERY future window, including a healthy one.
        let quota = live_quota(
            429,
            live_window(Some(50.0), Some(NOW + 45_000)),
            live_window(Some(10.0), None),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.live_quota = Some(&quota);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert_eq!(result.wait_ms, 45_000);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "live probe returned 429")
        );
        assert!(!result.exhausted);
    }

    #[test]
    fn does_not_delay_healthy_accounts_only_because_quota_reset_headers_exist() {
        let meta = account(NOW);
        let quota = live_quota(
            200,
            live_window(Some(12.0), Some(NOW + 3_600_000)),
            live_window(Some(3.0), Some(NOW + 7 * 86_400_000)),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.live_quota = Some(&quota);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Ready);
        assert_eq!(result.wait_ms, 0);
    }

    #[test]
    fn does_not_delay_a_99_6_used_live_window_whose_reset_is_still_in_the_future() {
        let meta = account(NOW);
        // 99.6% is usage pressure (>= 90) but NOT raw-exhausted; on a 200 the
        // only-exhausted filter keeps its future reset out of the wait.
        let quota = live_quota(
            200,
            live_window(Some(99.6), Some(NOW + 28 * 86_400_000)),
            live_window(Some(10.0), None),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.live_quota = Some(&quota);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Ready);
        assert_eq!(result.wait_ms, 0);
        assert!(!result.exhausted);
    }

    #[test]
    fn h5_live_quota_wait_reflects_only_the_exhausted_window_not_a_healthy_7d_secondary() {
        let meta = account(NOW);
        let quota = live_quota(
            200,
            live_window(Some(100.0), Some(NOW + 60_000)),
            live_window(Some(50.0), Some(NOW + 7 * 86_400_000)),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.live_quota = Some(&quota);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert_eq!(result.wait_ms, 60_000);
    }

    #[test]
    fn h5_recommends_the_account_that_actually_frees_first_under_live_quota_pressure() {
        let meta_a = account(NOW);
        let meta_b = account(NOW);
        // A frees in 60 s; B frees in 10 min. Folding healthy secondaries in
        // would have made both waits ~7 d and scrambled the order.
        let quota_a = live_quota(
            200,
            live_window(Some(100.0), Some(NOW + 60_000)),
            live_window(Some(40.0), Some(NOW + 7 * 86_400_000)),
        );
        let quota_b = live_quota(
            200,
            live_window(Some(100.0), Some(NOW + 600_000)),
            live_window(Some(45.0), Some(NOW + 7 * 86_400_000)),
        );
        let mut input_a = ForecastAccountInput::new(0, &meta_a, false, NOW);
        input_a.live_quota = Some(&quota_a);
        let mut input_b = ForecastAccountInput::new(1, &meta_b, false, NOW);
        input_b.live_quota = Some(&quota_b);
        let results = vec![
            evaluate_forecast_account(&input_a),
            evaluate_forecast_account(&input_b),
        ];
        let recommendation = recommend_forecast_account(&results);
        assert_eq!(recommendation.recommended_index, Some(0));
        assert_eq!(
            recommendation.reason,
            "No account is immediately ready; pick shortest wait (1m 0s)."
        );
    }

    #[test]
    fn flags_a_live_200_probe_at_100_used_with_no_reset_at_as_exhausted_not_ready() {
        let meta = account(NOW);
        let quota = live_quota(
            200,
            live_window(Some(100.0), None),
            live_window(Some(10.0), None),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.live_quota = Some(&quota);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert!(result.exhausted);
    }

    #[test]
    fn applies_higher_risk_at_higher_quota_usage_thresholds() {
        let meta = account(NOW);
        let expectations = [(65.0, 0), (70.0, 10), (80.0, 20), (90.0, 35), (98.0, 55)];
        for (used, expected_delta) in expectations {
            let quota = live_quota(
                200,
                live_window(Some(used), None),
                live_window(Some(0.0), None),
            );
            let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
            input.live_quota = Some(&quota);
            let result = evaluate_forecast_account(&input);
            assert_eq!(
                result.risk_score, expected_delta,
                "usedPercent {used} → +{expected_delta}"
            );
        }
    }

    #[test]
    fn adds_stale_age_risk_penalties_for_invalid_and_old_usage_timestamps() {
        // lastUsed in the future → negative age → +5.
        let future = AccountMetadataV3::new("refresh-1", NOW - 1_000, NOW + 60_000);
        let result = evaluate_forecast_account(&ForecastAccountInput::new(0, &future, false, NOW));
        assert_eq!(result.risk_score, 5);

        // Older than 7 days → +10.
        let old = AccountMetadataV3::new("refresh-1", NOW - 1_000, NOW - 8 * 86_400_000);
        let result = evaluate_forecast_account(&ForecastAccountInput::new(0, &old, false, NOW));
        assert_eq!(result.risk_score, 10);

        // lastUsed 0 (never) → no staleness penalty at all.
        let never = AccountMetadataV3::new("refresh-1", NOW - 1_000, 0);
        let result = evaluate_forecast_account(&ForecastAccountInput::new(0, &never, false, NOW));
        assert_eq!(result.risk_score, 0);
    }

    #[test]
    fn returns_delayed_recommendation_when_no_account_is_immediately_ready() {
        let mut meta = account(NOW);
        meta.cooling_down_until = Some(NOW + 90_000);
        let results = vec![evaluate_forecast_account(&ForecastAccountInput::new(
            0, &meta, false, NOW,
        ))];
        let recommendation = recommend_forecast_account(&results);
        assert_eq!(recommendation.recommended_index, Some(0));
        assert_eq!(
            recommendation.reason,
            "No account is immediately ready; pick shortest wait (1m 30s)."
        );
    }

    #[test]
    fn uses_codex_family_reset_keys_and_ignores_stale_or_invalid_entries() {
        let mut meta = account(NOW);
        let mut times = RateLimitStateV3::new();
        times.insert("codex", NOW - 1_000); // stale — ignored
        times.insert("codex:gpt-5.3-codex", NOW + 120_000);
        times.insert("gpt-5.2", NOW + 60_000); // different family — ignored
        meta.rate_limit_reset_times = Some(times);
        let result = evaluate_forecast_account(&ForecastAccountInput::new(0, &meta, false, NOW));
        assert_eq!(result.availability, ForecastAvailability::Delayed);
        assert_eq!(result.wait_ms, 120_000);
        assert!(
            result
                .reasons
                .iter()
                .any(|r| r == "rate limit resets in 2m 0s")
        );
    }

    #[test]
    fn keeps_unavailable_state_when_live_quota_returns_429_on_an_unavailable_account() {
        let mut meta = account(NOW);
        meta.enabled = Some(false);
        let quota = live_quota(
            429,
            live_window(Some(100.0), Some(NOW + 60_000)),
            live_window(None, None),
        );
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.live_quota = Some(&quota);
        let result = evaluate_forecast_account(&input);
        assert_eq!(result.availability, ForecastAvailability::Unavailable);
    }

    #[test]
    fn breaks_delayed_recommendation_ties_in_favor_of_the_current_account() {
        let mut meta_a = account(NOW);
        meta_a.cooling_down_until = Some(NOW + 60_000);
        let mut meta_b = account(NOW);
        meta_b.cooling_down_until = Some(NOW + 60_000);
        let results = vec![
            evaluate_forecast_account(&ForecastAccountInput::new(0, &meta_a, false, NOW)),
            evaluate_forecast_account(&ForecastAccountInput::new(1, &meta_b, true, NOW)),
        ];
        let recommendation = recommend_forecast_account(&results);
        assert_eq!(recommendation.recommended_index, Some(1));
    }

    #[test]
    fn returns_null_recommendation_when_all_candidates_are_disabled_or_hard_failed() {
        let mut disabled_meta = account(NOW);
        disabled_meta.enabled = Some(false);
        let hard_meta = account(NOW);
        let hard = failure(Some(TokenFailureReason::MissingRefresh), None, None);
        let mut hard_input = ForecastAccountInput::new(1, &hard_meta, false, NOW);
        hard_input.refresh_failure = Some(&hard);
        let results = vec![
            evaluate_forecast_account(&ForecastAccountInput::new(0, &disabled_meta, false, NOW)),
            evaluate_forecast_account(&hard_input),
        ];
        let recommendation = recommend_forecast_account(&results);
        assert_eq!(recommendation.recommended_index, None);
        assert_eq!(
            recommendation.reason,
            "No healthy accounts are available. Run `codex-multi-auth login` to add a fresh account."
        );
    }

    #[test]
    fn returns_null_recommendation_when_all_accounts_are_policy_blocked_or_exhausted() {
        let meta = account(NOW);
        let mut overlay = RuntimeForecastOverlay::default();
        overlay.policy_blocked_indexes.push(0);
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.runtime_overlay = Some(&overlay);
        let results = vec![evaluate_forecast_account(&input)];
        let recommendation = recommend_forecast_account(&results);
        assert_eq!(recommendation.recommended_index, None);
        assert_eq!(
            recommendation.reason,
            "All accounts are blocked or exhausted. Wait for a reset, clear the block, or run `codex-multi-auth login` to add a fresh account."
        );
    }

    #[test]
    fn returns_null_recommendation_when_all_accounts_are_quota_exhausted() {
        let mut meta = account(NOW);
        meta.email = Some("quota@example.com".to_string());
        meta.account_id = Some("acc_quota".to_string());
        let cache = exhausted_cache(
            "acc_quota",
            cache_entry(
                cache_window(Some(100.0), Some((NOW + 60_000) as f64)),
                cache_window(Some(10.0), None),
            ),
        );
        let all = vec![meta.clone()];
        let mut input = ForecastAccountInput::new(0, &meta, false, NOW);
        input.quota_cache = Some(&cache);
        input.all_accounts = Some(&all);
        let results = vec![evaluate_forecast_account(&input)];
        // Exhausted accounts are "delayed" for display but never win a
        // shortest-wait recommendation.
        assert_eq!(results[0].availability, ForecastAvailability::Delayed);
        assert!(results[0].exhausted);
        let recommendation = recommend_forecast_account(&results);
        assert_eq!(recommendation.recommended_index, None);
        assert_eq!(
            recommendation.reason,
            "All accounts are blocked or exhausted. Wait for a reset, clear the block, or run `codex-multi-auth login` to add a fresh account."
        );
    }

    #[test]
    fn summarize_and_explanation_shapes() {
        let ready_meta = account(NOW);
        let mut delayed_meta = account(NOW);
        delayed_meta.cooling_down_until = Some(NOW + 60_000);
        let mut disabled_meta = account(NOW);
        disabled_meta.enabled = Some(false);
        let results = vec![
            evaluate_forecast_account(&ForecastAccountInput::new(0, &ready_meta, false, NOW)),
            evaluate_forecast_account(&ForecastAccountInput::new(1, &delayed_meta, false, NOW)),
            evaluate_forecast_account(&ForecastAccountInput::new(2, &disabled_meta, false, NOW)),
        ];
        let summary = summarize_forecast(&results);
        assert_eq!(
            summary,
            ForecastSummary {
                total: 3,
                ready: 1,
                delayed: 1,
                unavailable: 1,
                high_risk: 1,
            }
        );

        let recommendation = recommend_forecast_account(&results);
        let explanation = build_forecast_explanation(&results, &recommendation);
        assert_eq!(explanation.recommended_index, Some(0));
        assert_eq!(explanation.considered.len(), 3);
        assert!(explanation.considered[0].selected);
        assert!(!explanation.considered[1].selected);
    }

    #[test]
    fn redacts_email_in_the_account_label() {
        let mut meta = account(NOW);
        meta.email = Some("user.name@example.co.uk".to_string());
        let result = evaluate_forecast_account(&ForecastAccountInput::new(0, &meta, false, NOW));
        assert!(
            !result.label.contains("user.name@example.co.uk"),
            "label leaked email: {}",
            result.label
        );
        assert!(result.label.contains("us***@***.uk"), "{}", result.label);
    }
}
