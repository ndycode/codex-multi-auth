//! Port of `lib/codex-manager/formatters/quota-formatters.ts`.
//!
//! Type notes vs the TS source:
//! - `QuotaCacheEntry` windows are `f64` in the cache schema while
//!   `CodexQuotaSnapshot` windows are `i64`; the TS code shares one duck-typed
//!   shape. Conversions here truncate fractional `windowMinutes`/`resetAtMs`
//!   (real values are always integral).
//! - The exhaustion check reuses `cma_quota::readiness::is_quota_cache_entry_exhausted`;
//!   snapshots have no `updatedAt`, mirrored by a `NaN` `updated_at` (the TS
//!   `undefined` disables the staleness escape the same way).

use cma_config::dashboard_settings::DashboardDisplaySettings;
use cma_core::json_io::format_js_number;
use cma_quota::cache::{QuotaCacheEntry, QuotaCacheWindow};
use cma_quota::probe::{CodexQuotaSnapshot, CodexQuotaWindow, format_quota_reset_at, format_quota_snapshot_line};
use cma_quota::readiness::{is_quota_cache_entry_exhausted, quota_left_percent_from_used};
use cma_tui::format::{UiTextTone, quota_tone_from_left_percent};

use super::text_style::{
    PromptTone, StyleContext, collapse_whitespace, join_styled_segments_with,
    style_prompt_text_with,
};

fn prompt_tone_from_quota_tone(tone: UiTextTone) -> PromptTone {
    match tone {
        UiTextTone::Danger => PromptTone::Danger,
        UiTextTone::Warning => PromptTone::Warning,
        _ => PromptTone::Success,
    }
}

/// JS `\s` (incl. U+FEFF; only plain spaces survive `collapseWhitespace`).
fn is_js_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Hand-rolled match for the TS segment regex
/// `/^([0-9a-zA-Z]+)\s+(\d{1,3})%(,\s*resets\s+\S.*)?$/`.
/// Returns `(window_label, left_percent_digits, reset_suffix)`.
fn parse_quota_segment(segment: &str) -> Option<(&str, &str, Option<&str>)> {
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_alphanumeric() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let label = &segment[..i];
    let ws_start = i;
    while let Some(c) = segment[i..].chars().next() {
        if !is_js_ws(c) {
            break;
        }
        i += c.len_utf8();
    }
    if i == ws_start {
        return None;
    }
    let digit_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let digit_len = i - digit_start;
    if digit_len == 0 || digit_len > 3 {
        return None;
    }
    let digits = &segment[digit_start..i];
    if i >= bytes.len() || bytes[i] != b'%' {
        return None;
    }
    i += 1;
    if i == bytes.len() {
        return Some((label, digits, None));
    }
    // Optional `,\s*resets\s+\S.*` suffix — must consume the rest exactly.
    let suffix = &segment[i..];
    let mut rest = suffix;
    rest = rest.strip_prefix(',')?;
    rest = rest.trim_start();
    rest = rest.strip_prefix("resets")?;
    let after_resets = rest;
    rest = rest.trim_start();
    if rest.len() == after_resets.len() {
        // `\s+` requires at least one whitespace char after "resets".
        return None;
    }
    // `\S` — at least one non-whitespace char must follow.
    if rest.is_empty() {
        return None;
    }
    Some((label, digits, Some(suffix)))
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// TS `styleQuotaSummary(summary)` over an explicit context.
pub fn style_quota_summary_with(ctx: &StyleContext, summary: &str) -> String {
    let normalized = collapse_whitespace(summary);
    if normalized.is_empty() {
        return style_prompt_text_with(ctx, summary, PromptTone::Muted);
    }
    let segments: Vec<&str> = normalized
        .split('|')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        return style_prompt_text_with(ctx, &normalized, PromptTone::Muted);
    }

    let rendered: Vec<String> = segments
        .iter()
        .map(|segment| {
            if contains_ci(segment, "rate-limited") {
                return style_prompt_text_with(ctx, segment, PromptTone::Danger);
            }
            let Some((label, digits, reset_suffix)) = parse_quota_segment(segment) else {
                return style_prompt_text_with(ctx, segment, PromptTone::Muted);
            };
            let left_percent = digits.parse::<i64>().unwrap_or(0).clamp(0, 100);
            let tone =
                prompt_tone_from_quota_tone(quota_tone_from_left_percent(left_percent as f64));
            let reset_rendered = reset_suffix
                .map(|suffix| style_prompt_text_with(ctx, suffix, PromptTone::Muted))
                .unwrap_or_default();
            format!(
                "{} {}{}",
                style_prompt_text_with(ctx, label, PromptTone::Muted),
                style_prompt_text_with(ctx, &format!("{left_percent}%"), tone),
                reset_rendered
            )
        })
        .collect();

    join_styled_segments_with(ctx, &rendered)
}

/// TS `styleQuotaSummary(summary)` — live context.
pub fn style_quota_summary(summary: &str) -> String {
    style_quota_summary_with(&StyleContext::live(), summary)
}

/// Render the per-account health line printed by `codex-multi-auth check`.
///
/// `check` is the only caller, and unlike the dashboard rows and account menu
/// it prints one account per line with no width pressure, so it opts into the
/// absolute reset clock for each quota window.
pub fn format_quota_snapshot_for_dashboard(
    snapshot: &CodexQuotaSnapshot,
    settings: &DashboardDisplaySettings,
    now: i64,
) -> String {
    if !settings.show_quota_details {
        return "live session OK".to_string();
    }
    format!(
        "live session OK ({})",
        format_compact_quota_snapshot(
            snapshot,
            now,
            &CompactQuotaFormatOptions { show_reset: true }
        )
    )
}

/// TS `quotaCacheEntryToSnapshot(entry)` — maps exactly the snapshot fields.
pub fn quota_cache_entry_to_snapshot(entry: &QuotaCacheEntry) -> CodexQuotaSnapshot {
    let window = |w: &QuotaCacheWindow| CodexQuotaWindow {
        used_percent: w.used_percent,
        window_minutes: w.window_minutes.map(|m| m as i64),
        reset_at_ms: w.reset_at_ms.map(|r| r as i64),
    };
    CodexQuotaSnapshot {
        status: entry.status as u16,
        plan_type: entry.plan_type.clone(),
        active_limit: None,
        primary: window(&entry.primary),
        secondary: window(&entry.secondary),
        model: entry.model.clone(),
    }
}

/// TS private `formatCompactQuotaWindowLabel(windowMinutes)`.
fn format_compact_quota_window_label(window_minutes: Option<f64>) -> String {
    let Some(m) = window_minutes else {
        return "quota".to_string();
    };
    // TS `!windowMinutes` — 0 (and NaN) is falsy.
    if m == 0.0 || !m.is_finite() || m <= 0.0 {
        return "quota".to_string();
    }
    if m % 1440.0 == 0.0 {
        return format!("{}d", format_js_number(m / 1440.0));
    }
    if m % 60.0 == 0.0 {
        return format!("{}h", format_js_number(m / 60.0));
    }
    format!("{}m", format_js_number(m))
}

/// Options shared by the compact quota formatters (TS
/// `CompactQuotaFormatOptions`). `show_reset` is opt-in so space-constrained
/// surfaces keep their single-line width while `check` appends reset clocks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CompactQuotaFormatOptions {
    pub show_reset: bool,
}

/// TS private `formatCompactQuotaPart`.
fn format_compact_quota_part(
    window_minutes: Option<f64>,
    used_percent: Option<f64>,
    reset_at_ms: Option<f64>,
    options: &CompactQuotaFormatOptions,
    now: i64,
) -> Option<String> {
    let label = format_compact_quota_window_label(window_minutes);
    let used = used_percent?;
    if !used.is_finite() {
        return None;
    }
    let left = quota_left_percent_from_used(Some(used))?;
    let part = format!("{label} {left}%");
    if !options.show_reset {
        return Some(part);
    }
    // A missing or malformed reset timestamp must never drop the percentage.
    let reset_ms = reset_at_ms.filter(|r| r.is_finite()).map(|r| r as i64);
    match format_quota_reset_at(reset_ms, Some(now)) {
        Some(reset) => Some(format!("{part}, resets {reset}")),
        None => Some(part),
    }
}

/// Exhaustion probe for a snapshot: the TS code passes the snapshot (which
/// has no `updatedAt`) straight into `isQuotaCacheEntryExhausted`; `NaN`
/// reproduces the `undefined` staleness-escape suppression.
fn snapshot_is_exhausted(snapshot: &CodexQuotaSnapshot, now: i64) -> bool {
    let window = |w: &CodexQuotaWindow| QuotaCacheWindow {
        used_percent: w.used_percent,
        window_minutes: w.window_minutes.map(|m| m as f64),
        reset_at_ms: w.reset_at_ms.map(|r| r as f64),
    };
    let entry = QuotaCacheEntry {
        updated_at: f64::NAN,
        status: f64::from(snapshot.status),
        model: snapshot.model.clone(),
        plan_type: snapshot.plan_type.clone(),
        primary: window(&snapshot.primary),
        secondary: window(&snapshot.secondary),
    };
    is_quota_cache_entry_exhausted(Some(&entry), now)
}

/// TS `formatCompactQuotaSnapshot(snapshot, now, options)`.
pub fn format_compact_quota_snapshot(
    snapshot: &CodexQuotaSnapshot,
    now: i64,
    options: &CompactQuotaFormatOptions,
) -> String {
    let mut parts: Vec<String> = [
        format_compact_quota_part(
            snapshot.primary.window_minutes.map(|m| m as f64),
            snapshot.primary.used_percent,
            snapshot.primary.reset_at_ms.map(|r| r as f64),
            options,
            now,
        ),
        format_compact_quota_part(
            snapshot.secondary.window_minutes.map(|m| m as f64),
            snapshot.secondary.used_percent,
            snapshot.secondary.reset_at_ms.map(|r| r as f64),
            options,
            now,
        ),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect();
    if snapshot.status == 429 {
        parts.push("rate-limited".to_string());
    }
    if snapshot_is_exhausted(snapshot, now) {
        parts.push("quota-exhausted".to_string());
    }
    if !parts.is_empty() {
        return parts.join(" | ");
    }
    format_quota_snapshot_line(snapshot)
}

/// TS `formatAccountQuotaSummary(entry, now, options)`.
pub fn format_account_quota_summary(
    entry: &QuotaCacheEntry,
    now: i64,
    options: &CompactQuotaFormatOptions,
) -> String {
    let mut parts: Vec<String> = [
        format_compact_quota_part(
            entry.primary.window_minutes,
            entry.primary.used_percent,
            entry.primary.reset_at_ms,
            options,
            now,
        ),
        format_compact_quota_part(
            entry.secondary.window_minutes,
            entry.secondary.used_percent,
            entry.secondary.reset_at_ms,
            options,
            now,
        ),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect();
    if entry.status == 429.0 {
        parts.push("rate-limited".to_string());
    }
    if is_quota_cache_entry_exhausted(Some(entry), now) {
        parts.push("quota-exhausted".to_string());
    }
    if !parts.is_empty() {
        return parts.join(" | ");
    }
    format_quota_snapshot_line(&quota_cache_entry_to_snapshot(entry))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_config::dashboard_settings::default_dashboard_display_settings;
    use cma_tui::runtime_options::get_ui_runtime_options;

    fn plain_ctx() -> StyleContext {
        StyleContext::new(get_ui_runtime_options(), false)
    }

    // Ported from test/codex-manager-formatters.test.ts ("quota formatters" +
    // "compact quota reset timestamps"). Local-time expectations are derived
    // from the same helper the formatter uses instead of hardcoding a zone.

    // 2026-07-22T09:00 local; +2h stays on the same local day, +8d does not.
    fn now_local() -> i64 {
        use chrono::TimeZone;
        chrono::Local
            .with_ymd_and_hms(2026, 7, 22, 9, 0, 0)
            .single()
            .expect("valid local time")
            .timestamp_millis()
    }

    fn snapshot(primary_reset: Option<i64>, secondary_reset: Option<i64>) -> CodexQuotaSnapshot {
        CodexQuotaSnapshot {
            status: 200,
            plan_type: Some("plus".to_string()),
            active_limit: None,
            primary: CodexQuotaWindow {
                used_percent: Some(0.0),
                window_minutes: Some(300),
                reset_at_ms: primary_reset,
            },
            secondary: CodexQuotaWindow {
                used_percent: Some(7.0),
                window_minutes: Some(10080),
                reset_at_ms: secondary_reset,
            },
            model: "gpt-5.3-codex".to_string(),
        }
    }

    #[test]
    fn style_quota_summary_keeps_segments_and_clamps() {
        let ctx = plain_ctx();
        assert_eq!(
            style_quota_summary_with(&ctx, "5h 80% | weekly 15%"),
            "5h 80% | weekly 15%"
        );
        assert_eq!(
            style_quota_summary_with(&ctx, "rate-limited until 18:00"),
            "rate-limited until 18:00"
        );
        // \d{1,3} admits values over 100; the formatter clamps them
        assert_eq!(style_quota_summary_with(&ctx, "5h 150%"), "5h 100%");
        assert_eq!(style_quota_summary_with(&ctx, "   "), "   ");
        assert_eq!(
            style_quota_summary_with(&ctx, "no percent here"),
            "no percent here"
        );
    }

    #[test]
    fn style_quota_summary_tones_segments_with_reset_suffix() {
        let ctx = plain_ctx();
        assert_eq!(
            style_quota_summary_with(&ctx, "5h 80%, resets 14:05 | 7d 15%"),
            "5h 80%, resets 14:05 | 7d 15%"
        );
        assert_eq!(
            style_quota_summary_with(&ctx, "7d 150%, resets 14:05 on Jul 29"),
            "7d 100%, resets 14:05 on Jul 29"
        );
        // A trailing "resets" with no value is not a reset suffix.
        assert_eq!(
            style_quota_summary_with(&ctx, "5h 80%, resets"),
            "5h 80%, resets"
        );
    }

    #[test]
    fn quota_cache_entry_to_snapshot_maps_exactly_the_snapshot_fields() {
        let entry = QuotaCacheEntry {
            updated_at: 123.0,
            status: 200.0,
            model: "gpt-5.3-codex".to_string(),
            plan_type: Some("plus".to_string()),
            primary: QuotaCacheWindow {
                used_percent: Some(20.0),
                window_minutes: Some(300.0),
                reset_at_ms: Some(1000.0),
            },
            secondary: QuotaCacheWindow {
                used_percent: Some(5.0),
                window_minutes: Some(10080.0),
                reset_at_ms: Some(2000.0),
            },
        };
        let snapshot = quota_cache_entry_to_snapshot(&entry);
        assert_eq!(snapshot.status, 200);
        assert_eq!(snapshot.plan_type.as_deref(), Some("plus"));
        assert_eq!(snapshot.model, "gpt-5.3-codex");
        assert_eq!(snapshot.active_limit, None);
        assert_eq!(snapshot.primary.used_percent, Some(20.0));
        assert_eq!(snapshot.primary.window_minutes, Some(300));
        assert_eq!(snapshot.primary.reset_at_ms, Some(1000));
        assert_eq!(snapshot.secondary.window_minutes, Some(10080));
        assert_eq!(snapshot.secondary.reset_at_ms, Some(2000));
    }

    #[test]
    fn omits_reset_times_unless_the_caller_opts_in() {
        let now = now_local();
        let same_day = now + 2 * 60 * 60 * 1000;
        let next_week = now + 8 * 24 * 60 * 60 * 1000;
        assert_eq!(
            format_compact_quota_snapshot(
                &snapshot(Some(same_day), Some(next_week)),
                now,
                &CompactQuotaFormatOptions::default()
            ),
            "5h 100% | 7d 93%"
        );
    }

    #[test]
    fn appends_a_per_window_reset_time_when_show_reset_is_set() {
        let now = now_local();
        let same_day = now + 2 * 60 * 60 * 1000;
        let next_week = now + 8 * 24 * 60 * 60 * 1000;
        let expected = format!(
            "5h 100%, resets {} | 7d 93%, resets {}",
            format_quota_reset_at(Some(same_day), Some(now)).unwrap(),
            format_quota_reset_at(Some(next_week), Some(now)).unwrap(),
        );
        assert_eq!(
            format_compact_quota_snapshot(
                &snapshot(Some(same_day), Some(next_week)),
                now,
                &CompactQuotaFormatOptions { show_reset: true }
            ),
            expected
        );
    }

    #[test]
    fn keeps_the_percentage_when_a_reset_timestamp_is_missing() {
        let now = now_local();
        assert_eq!(
            format_compact_quota_snapshot(
                &snapshot(None, None),
                now,
                &CompactQuotaFormatOptions { show_reset: true }
            ),
            "5h 100% | 7d 93%"
        );
    }

    #[test]
    fn format_account_quota_summary_honors_show_reset_the_same_way() {
        let now = now_local();
        let same_day = now + 2 * 60 * 60 * 1000;
        let entry = QuotaCacheEntry {
            updated_at: now as f64,
            status: 200.0,
            model: "gpt-5.3-codex".to_string(),
            plan_type: Some("plus".to_string()),
            primary: QuotaCacheWindow {
                used_percent: Some(0.0),
                window_minutes: Some(300.0),
                reset_at_ms: Some(same_day as f64),
            },
            secondary: QuotaCacheWindow {
                used_percent: Some(7.0),
                window_minutes: Some(10080.0),
                reset_at_ms: None,
            },
        };
        assert_eq!(
            format_account_quota_summary(&entry, now, &CompactQuotaFormatOptions::default()),
            "5h 100% | 7d 93%"
        );
        assert_eq!(
            format_account_quota_summary(
                &entry,
                now,
                &CompactQuotaFormatOptions { show_reset: true }
            ),
            format!(
                "5h 100%, resets {} | 7d 93%",
                format_quota_reset_at(Some(same_day), Some(now)).unwrap()
            )
        );
    }

    #[test]
    fn format_quota_snapshot_for_dashboard_is_the_check_line_and_shows_resets() {
        let now = now_local();
        let same_day = now + 2 * 60 * 60 * 1000;
        let next_week = now + 8 * 24 * 60 * 60 * 1000;
        let display = default_dashboard_display_settings();
        assert!(display.show_quota_details);
        assert_eq!(
            format_quota_snapshot_for_dashboard(
                &snapshot(Some(same_day), Some(next_week)),
                &display,
                now
            ),
            format!(
                "live session OK (5h 100%, resets {} | 7d 93%, resets {})",
                format_quota_reset_at(Some(same_day), Some(now)).unwrap(),
                format_quota_reset_at(Some(next_week), Some(now)).unwrap(),
            )
        );
    }

    #[test]
    fn format_quota_snapshot_for_dashboard_stays_bare_when_details_off() {
        let now = now_local();
        let mut display = default_dashboard_display_settings();
        display.show_quota_details = false;
        assert_eq!(
            format_quota_snapshot_for_dashboard(&snapshot(Some(now), Some(now)), &display, now),
            "live session OK"
        );
    }

    #[test]
    fn rate_limited_and_exhausted_markers_are_appended() {
        let now = now_local();
        let mut s = snapshot(None, None);
        s.status = 429;
        assert_eq!(
            format_compact_quota_snapshot(&s, now, &CompactQuotaFormatOptions::default()),
            "5h 100% | 7d 93% | rate-limited"
        );
        // Fully-used primary window with a future reset => quota-exhausted.
        let mut exhausted = snapshot(Some(now + 60_000), None);
        exhausted.primary.used_percent = Some(100.0);
        assert_eq!(
            format_compact_quota_snapshot(&exhausted, now, &CompactQuotaFormatOptions::default()),
            "5h 0% | 7d 93% | quota-exhausted"
        );
    }

    #[test]
    fn window_label_uses_duration_derived_units() {
        assert_eq!(format_compact_quota_window_label(Some(300.0)), "5h");
        assert_eq!(format_compact_quota_window_label(Some(10080.0)), "7d");
        assert_eq!(format_compact_quota_window_label(Some(43200.0)), "30d");
        assert_eq!(format_compact_quota_window_label(Some(90.0)), "90m");
        assert_eq!(format_compact_quota_window_label(Some(0.0)), "quota");
        assert_eq!(format_compact_quota_window_label(None), "quota");
    }
}
