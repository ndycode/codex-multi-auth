//! Port of `lib/codex-manager/formatters/account-formatters.ts`.
//!
//! Tone precedence (danger before warning) is security/UX-relevant — a
//! failure whose text contains "unavailable" must render red, not be
//! downgraded to yellow. See test/codex-manager-detail-tone.test.ts (ported
//! below).

use chrono::{Datelike, TimeZone, Timelike};
use cma_accounts::rate_limits::format_wait_time;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::RateLimitStateV3;
use cma_quota::forecast::{ForecastAvailability, ForecastRiskLevel};

use super::quota::style_quota_summary_with;
use super::text_style::{PromptTone, StyleContext, collapse_whitespace, style_prompt_text_with};

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(needle)
}

/// Any of the (lowercase) needles present, case-insensitively.
fn contains_any_ci(haystack: &str, needles: &[&str]) -> bool {
    let lower = haystack.to_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

fn is_js_word_char(c: char) -> bool {
    // JS `\w` = [A-Za-z0-9_].
    c.is_ascii_alphanumeric() || c == '_'
}

/// JS `/\b(word)\b/i` for a set of all-lowercase words.
fn contains_word_ci(haystack: &str, words: &[&str]) -> bool {
    let lower = haystack.to_lowercase();
    for word in words {
        let mut search_from = 0;
        while let Some(rel) = lower[search_from..].find(word) {
            let start = search_from + rel;
            let end = start + word.len();
            let before_ok = lower[..start]
                .chars()
                .next_back()
                .is_none_or(|c| !is_js_word_char(c));
            let after_ok = lower[end..].chars().next().is_none_or(|c| !is_js_word_char(c));
            if before_ok && after_ok {
                return true;
            }
            search_from = start + 1;
        }
    }
    false
}

/// Hand-rolled match for `/^(.*?)\(([^()]*\d{1,3}%[^()]*)\)(.*)$/` over the
/// collapsed detail: the FIRST `(...)` group containing no nested parens and
/// at least one digit run (1–3 digits, absorbed left by `[^()]*`) followed by
/// `%`. Returns `(prefix, quota, suffix)` (untrimmed).
fn match_quota_detail(compact: &str) -> Option<(&str, &str, &str)> {
    let mut search_from = 0;
    while let Some(rel) = compact[search_from..].find('(') {
        let open = search_from + rel;
        let rest = &compact[open + 1..];
        // The inner group forbids both '(' and ')' — the next paren of either
        // kind must be the closing ')'.
        let next_paren = rest.find(['(', ')']);
        match next_paren {
            Some(close_rel) if rest.as_bytes()[close_rel] == b')' => {
                let inner = &rest[..close_rel];
                if inner_has_percent(inner) {
                    let close = open + 1 + close_rel;
                    return Some((&compact[..open], inner, &compact[close + 1..]));
                }
                search_from = open + 1;
            }
            _ => {
                search_from = open + 1;
            }
        }
    }
    None
}

/// `[^()]*\d{1,3}%[^()]*` — at least one digit immediately before a `%`.
fn inner_has_percent(inner: &str) -> bool {
    let bytes = inner.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'%' && i > 0 && bytes[i - 1].is_ascii_digit() {
            return true;
        }
    }
    false
}

/// TS `styleAccountDetailText(detail, fallbackTone = "muted")` over an
/// explicit context.
pub fn style_account_detail_text_with(
    ctx: &StyleContext,
    detail: &str,
    fallback_tone: PromptTone,
) -> String {
    let compact = collapse_whitespace(detail);
    if compact.is_empty() {
        return style_prompt_text_with(ctx, "", fallback_tone);
    }

    if let Some((raw_prefix, raw_quota, raw_suffix)) = match_quota_detail(&compact) {
        let prefix = raw_prefix.trim();
        let quota = raw_quota.trim();
        let suffix = raw_suffix.trim();

        // danger wins across the WHOLE detail: a failure keyword anywhere —
        // even trapped inside the (…%) quota segment — must keep the prefix
        // red, never let a "working"/"ok" prefix render green over a real
        // failure.
        let detail_has_failure = contains_any_ci(&compact, &["failed", "error", "rate-limited"]);
        let prefix_tone = if detail_has_failure {
            PromptTone::Danger
        } else if contains_word_ci(prefix, &["ok", "working", "succeeded", "valid"]) {
            PromptTone::Success
        } else {
            fallback_tone
        };
        // danger wins first: a real failure whose text happens to contain
        // "unavailable"/"not available" must render red, not yellow.
        let suffix_tone = if contains_any_ci(suffix, &["failed", "error"]) {
            PromptTone::Danger
        } else if contains_any_ci(
            suffix,
            &[
                "re-login",
                "stale",
                "warning",
                "retry",
                "fallback",
                "unavailable",
                "not available",
            ],
        ) {
            PromptTone::Warning
        } else {
            PromptTone::Muted
        };

        let mut chunks: Vec<String> = Vec::new();
        if !prefix.is_empty() {
            chunks.push(style_prompt_text_with(ctx, prefix, prefix_tone));
        }
        chunks.push(format!("({})", style_quota_summary_with(ctx, quota)));
        if !suffix.is_empty() {
            chunks.push(style_prompt_text_with(ctx, suffix, suffix_tone));
        }
        return chunks.join(" ");
    }

    if contains_ci(&compact, "rate-limited") {
        return style_prompt_text_with(ctx, &compact, PromptTone::Danger);
    }
    if contains_any_ci(&compact, &["failed", "error"]) {
        return style_prompt_text_with(ctx, &compact, PromptTone::Danger);
    }
    if contains_any_ci(
        &compact,
        &[
            "re-login",
            "stale",
            "warning",
            "fallback",
            "unavailable",
            "not available",
        ],
    ) {
        return style_prompt_text_with(ctx, &compact, PromptTone::Warning);
    }
    if contains_word_ci(&compact, &["ok", "working", "succeeded", "valid"]) {
        return style_prompt_text_with(ctx, &compact, PromptTone::Success);
    }
    style_prompt_text_with(ctx, &compact, fallback_tone)
}

/// TS `styleAccountDetailText(detail)` — default `"muted"` fallback tone,
/// live context.
pub fn style_account_detail_text(detail: &str) -> String {
    style_account_detail_text_with(&StyleContext::live(), detail, PromptTone::Muted)
}

/// TS `styleAccountDetailText(detail, fallbackTone)` — live context.
pub fn style_account_detail_text_with_tone(detail: &str, fallback_tone: PromptTone) -> String {
    style_account_detail_text_with(&StyleContext::live(), detail, fallback_tone)
}

/// TS `riskTone(level)`.
pub fn risk_tone(level: ForecastRiskLevel) -> PromptTone {
    match level {
        ForecastRiskLevel::Low => PromptTone::Success,
        ForecastRiskLevel::Medium => PromptTone::Warning,
        ForecastRiskLevel::High => PromptTone::Danger,
    }
}

/// TS `availabilityTone(availability)`.
pub fn availability_tone(availability: ForecastAvailability) -> PromptTone {
    match availability {
        ForecastAvailability::Ready => PromptTone::Success,
        ForecastAvailability::Delayed => PromptTone::Warning,
        ForecastAvailability::Unavailable => PromptTone::Danger,
    }
}

/// TS `formatRateLimitEntry(account, now, family = "codex")` — delegates to
/// the runtime helper with `formatWaitTime` injected.
pub fn format_rate_limit_entry(
    rate_limit_reset_times: Option<&RateLimitStateV3>,
    now: i64,
    family: ModelFamily,
) -> Option<String> {
    cma_runtime::account_status::format_rate_limit_entry(
        rate_limit_reset_times,
        now,
        &format_wait_time,
        family,
    )
}

/// TS `formatBackupSavedAt(mtimeMs)` — `toLocaleString(undefined, {month:
/// "short", day: "numeric", year: "numeric", hour: "numeric", minute:
/// "2-digit"})`. Node's default locale is en-US, so the pinned rendering is
/// `"Jul 27, 2026, 2:35 PM"` (local time); other locales diverge in TS and
/// are deliberately not reproduced.
pub fn format_backup_saved_at(mtime_ms: f64) -> String {
    if !mtime_ms.is_finite() {
        return "Invalid Date".to_string();
    }
    let Some(date) = chrono::Local.timestamp_millis_opt(mtime_ms as i64).single() else {
        return "Invalid Date".to_string();
    };
    let (is_pm, hour12) = date.hour12();
    format!(
        "{} {}, {}, {}:{:02} {}",
        date.format("%b"),
        date.day(),
        date.year(),
        hour12,
        date.minute(),
        if is_pm { "PM" } else { "AM" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_tui::ansi;
    use cma_tui::runtime_options::{
        UiRuntimeOptionsPatch, reset_ui_runtime_options, set_ui_runtime_options,
    };
    use serial_test::serial;

    /// Legacy renderer (v2 off) on an interactive stdout, so danger =>
    /// ANSI red and warning => ANSI yellow exactly (mirrors the TS suite).
    fn legacy_tty_ctx() -> StyleContext {
        let ui = set_ui_runtime_options(UiRuntimeOptionsPatch {
            v2_enabled: Some(false),
            ..Default::default()
        });
        StyleContext::new(ui, true)
    }

    fn styled(detail: &str) -> String {
        style_account_detail_text_with(&legacy_tty_ctx(), detail, PromptTone::Muted)
    }

    // Ported from test/codex-manager-detail-tone.test.ts.

    #[test]
    #[serial]
    fn danger_wins_when_a_failure_detail_also_says_unavailable() {
        let s = styled("refresh failed: service unavailable");
        assert!(s.contains(ansi::RED));
        assert!(!s.contains(ansi::YELLOW));
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn not_available_is_treated_the_same_danger_wins() {
        let s = styled("token error (not available)");
        assert!(s.contains(ansi::RED));
        assert!(!s.contains(ansi::YELLOW));
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn normalizes_whitespace_before_matching_tone_keywords() {
        let s = styled("  probe   failed\n  — endpoint unavailable  ");
        assert!(s.contains(ansi::RED));
        assert!(!s.contains(ansi::YELLOW));
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn still_renders_warning_when_only_unavailable_keyword_present() {
        let s = styled("Codex not available for this account");
        assert!(s.contains(ansi::YELLOW));
        assert!(!s.contains(ansi::RED));
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn danger_precedence_applies_to_the_quota_suffix() {
        let s = styled("acct (12%) — refresh failed, now unavailable");
        assert!(s.contains(ansi::RED));
        assert!(!s.contains(ansi::YELLOW));
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn working_prefix_is_not_green_when_failure_is_inside_quota_segment() {
        let s = styled("signed in and working (live check failed: timeout 0%)");
        assert!(s.contains(ansi::RED));
        assert!(!s.contains(ansi::GREEN));
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn clamps_out_of_range_quota_percent_to_100() {
        let clamped = styled("acct (5h 999%)");
        let hundred = styled("acct (5h 100%)");
        assert!(clamped.contains("100%"));
        assert!(!clamped.contains("999%"));
        assert!(clamped.contains(ansi::GREEN));
        assert_eq!(clamped, hundred);
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn renders_the_zero_percent_lower_bound_as_danger() {
        let s = styled("acct (5h 0%)");
        assert!(s.contains("0%"));
        assert!(s.contains(ansi::RED));
        assert!(!s.contains(ansi::GREEN));
        reset_ui_runtime_options();
    }

    #[test]
    #[serial]
    fn success_keyword_requires_word_boundaries() {
        for detail in ["token is invalid or expired", "refresh token revoked"] {
            let s = styled(detail);
            assert!(!s.contains(ansi::GREEN), "{detail} must not be green");
        }
        let s = styled("signed in and working");
        assert!(s.contains(ansi::GREEN));
        reset_ui_runtime_options();
    }

    #[test]
    fn risk_and_availability_tones_map_exactly() {
        assert_eq!(risk_tone(ForecastRiskLevel::Low), PromptTone::Success);
        assert_eq!(risk_tone(ForecastRiskLevel::Medium), PromptTone::Warning);
        assert_eq!(risk_tone(ForecastRiskLevel::High), PromptTone::Danger);
        assert_eq!(
            availability_tone(ForecastAvailability::Ready),
            PromptTone::Success
        );
        assert_eq!(
            availability_tone(ForecastAvailability::Delayed),
            PromptTone::Warning
        );
        assert_eq!(
            availability_tone(ForecastAvailability::Unavailable),
            PromptTone::Danger
        );
    }

    #[test]
    fn format_rate_limit_entry_formats_future_resets_only() {
        let times: RateLimitStateV3 = [("codex".to_string(), 61_000_i64)].into_iter().collect();
        let entry = format_rate_limit_entry(Some(&times), 1_000, ModelFamily::Codex);
        assert_eq!(entry.as_deref(), Some("resets in 1m 0s"));
        assert_eq!(
            format_rate_limit_entry(Some(&times), 61_000, ModelFamily::Codex),
            None
        );
        assert_eq!(format_rate_limit_entry(None, 0, ModelFamily::Codex), None);
    }

    #[test]
    fn format_backup_saved_at_renders_en_us_short_datetime() {
        use chrono::TimeZone;
        let ms = chrono::Local
            .with_ymd_and_hms(2026, 7, 4, 14, 5, 0)
            .single()
            .expect("valid local time")
            .timestamp_millis();
        assert_eq!(format_backup_saved_at(ms as f64), "Jul 4, 2026, 2:05 PM");
        let midnight = chrono::Local
            .with_ymd_and_hms(2026, 1, 1, 0, 7, 0)
            .single()
            .expect("valid local time")
            .timestamp_millis();
        assert_eq!(
            format_backup_saved_at(midnight as f64),
            "Jan 1, 2026, 12:07 AM"
        );
    }
}
