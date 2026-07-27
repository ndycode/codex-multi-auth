//! Port of `lib/ui/auth-menu-builder.ts` — pure builders/formatters for the
//! accounts dashboard (titles, badges, quota bars, hints).
//!
//! Key contracts preserved (spec 12 §9 + gotchas):
//! - `quota5h*`/`quota7d*` are the *primary/secondary* windows positionally;
//!   real durations live in `quota_primary_window_minutes` /
//!   `quota_secondary_window_minutes` (a Codex Business monthly window labels
//!   "30d", not "5h") — labels are duration-derived, never hard-coded.
//! - quota bars use Unicode block glyphs ONLY when the theme's stored
//!   (requested) glyph mode is literally `unicode`; `auto` stays ASCII (ui-03).
//! - `account_row_color` default (unknown status) is yellow, not green.
//! - `format_account_hint` shows `Status:` only when the badge is HIDDEN.

use crate::ansi;
use crate::format::{format_ui_badge, paint_ui_text, quota_tone_from_left_percent, UiBadgeTone, UiTextTone};
use crate::runtime_options::{get_ui_runtime_options, UiRuntimeOptions};
use crate::select::MenuColor;
use crate::theme::UiGlyphMode;
use crate::ui_copy;

/// TS `AccountStatus` string union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountStatus {
    Active,
    Ok,
    QuotaExhausted,
    RateLimited,
    Cooldown,
    Disabled,
    Error,
    Flagged,
    Unknown,
}

impl AccountStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountStatus::Active => "active",
            AccountStatus::Ok => "ok",
            AccountStatus::QuotaExhausted => "quota-exhausted",
            AccountStatus::RateLimited => "rate-limited",
            AccountStatus::Cooldown => "cooldown",
            AccountStatus::Disabled => "disabled",
            AccountStatus::Error => "error",
            AccountStatus::Flagged => "flagged",
            AccountStatus::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(AccountStatus::Active),
            "ok" => Some(AccountStatus::Ok),
            "quota-exhausted" => Some(AccountStatus::QuotaExhausted),
            "rate-limited" => Some(AccountStatus::RateLimited),
            "cooldown" => Some(AccountStatus::Cooldown),
            "disabled" => Some(AccountStatus::Disabled),
            "error" => Some(AccountStatus::Error),
            "flagged" => Some(AccountStatus::Flagged),
            "unknown" => Some(AccountStatus::Unknown),
            _ => None,
        }
    }
}

/// TS `AccountCurrentMarker` (from `lib/runtime/runtime-current-account.ts`).
/// Defined here because `cma-tui` sits below `cma-runtime` in the crate DAG;
/// `cma-runtime`/`cma-manager` convert to/from this enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountCurrentMarker {
    Current,
    InUse,
    Selected,
}

impl AccountCurrentMarker {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountCurrentMarker::Current => "current",
            AccountCurrentMarker::InUse => "in-use",
            AccountCurrentMarker::Selected => "selected",
        }
    }
}

/// TS `AccountInfo` — display payload for one dashboard row. All fields except
/// `index` are optional.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccountInfo {
    pub index: i64,
    pub source_index: Option<i64>,
    pub quick_switch_number: Option<i64>,
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub email: Option<String>,
    pub added_at: Option<i64>,
    pub last_used: Option<i64>,
    pub status: Option<AccountStatus>,
    pub quota_summary: Option<String>,
    // Positional primary/secondary windows; see module docs.
    pub quota_5h_left_percent: Option<f64>,
    pub quota_5h_reset_at_ms: Option<f64>,
    pub quota_7d_left_percent: Option<f64>,
    pub quota_7d_reset_at_ms: Option<f64>,
    pub quota_primary_window_minutes: Option<f64>,
    pub quota_secondary_window_minutes: Option<f64>,
    pub quota_rate_limited: Option<bool>,
    pub quota_exhausted: Option<bool>,
    pub is_current_account: Option<bool>,
    pub is_default_account: Option<bool>,
    pub is_runtime_current_account: Option<bool>,
    pub current_markers: Option<Vec<AccountCurrentMarker>>,
    pub enabled: Option<bool>,
    pub show_status_badge: Option<bool>,
    pub show_current_badge: Option<bool>,
    pub show_last_used: Option<bool>,
    pub show_quota_cooldown: Option<bool>,
    pub show_hints_for_unselected_rows: Option<bool>,
    pub highlight_current_row: Option<bool>,
    pub focus_style: Option<crate::select::FocusStyle>,
    pub statusline_fields: Option<Vec<String>>,
}

/// Status message for the dashboard subtitle: static text or a live closure.
pub enum StatusMessage<'a> {
    Text(String),
    Dynamic(Box<dyn Fn() -> Option<String> + 'a>),
}

impl StatusMessage<'_> {
    pub fn resolve(&self) -> Option<String> {
        match self {
            StatusMessage::Text(text) => Some(text.clone()),
            StatusMessage::Dynamic(f) => f(),
        }
    }
}

/// TS `AuthMenuOptions`.
#[derive(Default)]
pub struct AuthMenuOptions<'a> {
    pub flagged_count: Option<i64>,
    pub status_message: Option<StatusMessage<'a>>,
}

/// TS `AuthMenuAction` tagged union.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthMenuAction {
    Add,
    Forecast,
    Fix,
    Settings,
    Fresh,
    Check,
    DeepCheck,
    VerifyFlagged,
    SelectAccount(AccountInfo),
    SetCurrentAccount(AccountInfo),
    RefreshAccount(AccountInfo),
    ToggleAccount(AccountInfo),
    DeleteAccount(AccountInfo),
    Search,
    DeleteAll,
    Cancel,
}

impl AuthMenuAction {
    /// The TS discriminant string (`action.type`).
    pub fn type_str(&self) -> &'static str {
        match self {
            AuthMenuAction::Add => "add",
            AuthMenuAction::Forecast => "forecast",
            AuthMenuAction::Fix => "fix",
            AuthMenuAction::Settings => "settings",
            AuthMenuAction::Fresh => "fresh",
            AuthMenuAction::Check => "check",
            AuthMenuAction::DeepCheck => "deep-check",
            AuthMenuAction::VerifyFlagged => "verify-flagged",
            AuthMenuAction::SelectAccount(_) => "select-account",
            AuthMenuAction::SetCurrentAccount(_) => "set-current-account",
            AuthMenuAction::RefreshAccount(_) => "refresh-account",
            AuthMenuAction::ToggleAccount(_) => "toggle-account",
            AuthMenuAction::DeleteAccount(_) => "delete-account",
            AuthMenuAction::Search => "search",
            AuthMenuAction::DeleteAll => "delete-all",
            AuthMenuAction::Cancel => "cancel",
        }
    }

    pub fn account(&self) -> Option<&AccountInfo> {
        match self {
            AuthMenuAction::SelectAccount(a)
            | AuthMenuAction::SetCurrentAccount(a)
            | AuthMenuAction::RefreshAccount(a)
            | AuthMenuAction::ToggleAccount(a)
            | AuthMenuAction::DeleteAccount(a) => Some(a),
            _ => None,
        }
    }
}

/// TS `AccountAction` string union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountAction {
    Back,
    Delete,
    Refresh,
    Toggle,
    SetCurrent,
    Cancel,
}

fn resolve_cli_version_label_from(raw: Option<&str>) -> Option<String> {
    let raw = raw.unwrap_or("").trim().to_string();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with('v') {
        Some(raw)
    } else {
        Some(format!("v{raw}"))
    }
}

/// Testable core of [`main_menu_title_with_version`].
pub(crate) fn main_menu_title_with_version_from(raw: Option<&str>) -> String {
    match resolve_cli_version_label_from(raw) {
        None => ui_copy::main_menu::TITLE.to_string(),
        Some(version_label) => format!("{} ({version_label})", ui_copy::main_menu::TITLE),
    }
}

/// Reads env `CODEX_MULTI_AUTH_CLI_VERSION` (trimmed); prefixes `v` only when
/// the value does not already start with lowercase `v`.
pub fn main_menu_title_with_version() -> String {
    let raw = std::env::var("CODEX_MULTI_AUTH_CLI_VERSION").ok();
    main_menu_title_with_version_from(raw.as_deref())
}

/// Strip ANSI CSI sequences (`\x1b\[[0-?]*[ -/]*[@-~]`) and C0/DEL control
/// characters, then trim; empty results become `None`.
fn sanitize_terminal_text(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    // Pass 1: strip full CSI sequences.
    let mut stripped = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            while j < bytes.len() && (0x30..=0x3f).contains(&bytes[j]) {
                j += 1;
            }
            while j < bytes.len() && (0x20..=0x2f).contains(&bytes[j]) {
                j += 1;
            }
            if j < bytes.len() && (0x40..=0x7e).contains(&bytes[j]) {
                i = j + 1; // full CSI matched: drop it
                continue;
            }
        }
        // Copy one full UTF-8 char.
        let ch = value[i..].chars().next().unwrap();
        stripped.push(ch);
        i += ch.len_utf8();
    }
    // Pass 2: strip C0 controls (U+0000-U+001F) and DEL (U+007F), then trim.
    let cleaned: String = stripped
        .chars()
        .filter(|&c| !(c as u32 <= 0x1f || c as u32 == 0x7f))
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Days-from-epoch to civil date (Howard Hinnant's algorithm), UTC.
fn civil_from_ms(timestamp_ms: i64) -> (i64, u32, u32) {
    let days = (timestamp_ms as f64 / 86_400_000.0).floor() as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32)
}

/// Locale-date analogue of `new Date(ts).toLocaleDateString()`.
///
/// DIVERGENCE (documented per spec 12 gotcha 30, scoped to the FORMAT only):
/// the TS output is locale/OS dependent; this port pins the en-US `M/D/YYYY`
/// form. The calendar day itself is computed in the LOCAL timezone exactly
/// like `toLocaleDateString()` — using the UTC day would render `Added:` /
/// `Last used:` one calendar day off for any user east/west of UTC when the
/// timestamp falls near local midnight. The UTC civil algorithm remains only
/// as the (practically unreachable) fallback when the local conversion is
/// not representable.
fn format_locale_date(timestamp_ms: i64) -> String {
    use chrono::{Datelike, TimeZone};
    if let Some(local) = chrono::Local.timestamp_millis_opt(timestamp_ms).single() {
        return format!("{}/{}/{}", local.month(), local.day(), local.year());
    }
    let (year, month, day) = civil_from_ms(timestamp_ms);
    format!("{month}/{day}/{year}")
}

/// Testable core of [`format_relative_time`].
pub(crate) fn format_relative_time_at(timestamp: Option<i64>, now_ms: i64) -> String {
    let ts = match timestamp {
        None | Some(0) => return "never".to_string(), // TS falsy check
        Some(ts) => ts,
    };
    let days = ((now_ms - ts) as f64 / 86_400_000.0).floor() as i64;
    if days <= 0 {
        return "today".to_string();
    }
    if days == 1 {
        return "yesterday".to_string();
    }
    if days < 7 {
        return format!("{days}d ago");
    }
    if days < 30 {
        return format!("{}w ago", days / 7);
    }
    format_locale_date(ts)
}

pub fn format_relative_time(timestamp: Option<i64>) -> String {
    format_relative_time_at(timestamp, cma_core::utils::now_ms())
}

pub fn format_date(timestamp: Option<i64>) -> String {
    match timestamp {
        None | Some(0) => "unknown".to_string(), // TS falsy check
        Some(ts) => format_locale_date(ts),
    }
}

fn status_tone(status: Option<AccountStatus>) -> UiBadgeTone {
    match status {
        Some(AccountStatus::Active) | Some(AccountStatus::Ok) => UiBadgeTone::Success,
        Some(AccountStatus::QuotaExhausted)
        | Some(AccountStatus::RateLimited)
        | Some(AccountStatus::Cooldown) => UiBadgeTone::Warning,
        Some(AccountStatus::Disabled)
        | Some(AccountStatus::Error)
        | Some(AccountStatus::Flagged) => UiBadgeTone::Danger,
        Some(AccountStatus::Unknown) | None => UiBadgeTone::Muted,
    }
}

fn status_text(status: Option<AccountStatus>) -> &'static str {
    status.map(AccountStatus::as_str).unwrap_or("unknown")
}

fn badge_with_tone(ui: &UiRuntimeOptions, label: &str, tone: UiBadgeTone) -> String {
    if ui.v2_enabled {
        return format_ui_badge(ui, label, tone);
    }
    match tone {
        UiBadgeTone::Primary | UiBadgeTone::Accent | UiBadgeTone::Success => format!(
            "{}{}[{label}]{}",
            ansi::BG_GREEN,
            ansi::BLACK,
            ansi::RESET
        ),
        UiBadgeTone::Warning => format!(
            "{}{}[{label}]{}",
            ansi::BG_YELLOW,
            ansi::BLACK,
            ansi::RESET
        ),
        UiBadgeTone::Danger => {
            format!("{}{}[{label}]{}", ansi::BG_RED, ansi::WHITE, ansi::RESET)
        }
        UiBadgeTone::Muted => format!("{}[{label}]{}", ansi::INVERSE, ansi::RESET),
    }
}

/// Maps a status to a `[label]` badge (v2 badge or legacy ANSI). The label is
/// the status string itself; missing/unknown → "unknown" muted.
pub fn status_badge(status: Option<AccountStatus>) -> String {
    let ui = get_ui_runtime_options();
    let label = status_text(status);
    badge_with_tone(&ui, label, status_tone(status))
}

fn account_number(account: &AccountInfo) -> i64 {
    account.quick_switch_number.unwrap_or(account.index + 1)
}

/// `accountTitle` — `${accountNumber}. ${base}` where base is the first
/// non-empty of sanitized email, label, id, else `Account ${accountNumber}`.
pub fn account_title(account: &AccountInfo) -> String {
    let number = account_number(account);
    let base = sanitize_terminal_text(account.email.as_deref())
        .or_else(|| sanitize_terminal_text(account.account_label.as_deref()))
        .or_else(|| sanitize_terminal_text(account.account_id.as_deref()))
        .unwrap_or_else(|| format!("Account {number}"));
    format!("{number}. {base}")
}

/// `accountSearchText` — sanitized identity fields + the row number, joined
/// with spaces and lowercased.
pub fn account_search_text(account: &AccountInfo) -> String {
    let mut parts: Vec<String> = Vec::new();
    for value in [
        sanitize_terminal_text(account.email.as_deref()),
        sanitize_terminal_text(account.account_label.as_deref()),
        sanitize_terminal_text(account.account_id.as_deref()),
        Some(account_number(account).to_string()),
    ]
    .into_iter()
    .flatten()
    {
        if !value.trim().is_empty() {
            parts.push(value);
        }
    }
    parts.join(" ").to_lowercase()
}

/// `accountRowColor` — current row (highlighting enabled) is green; otherwise
/// mapped by status with a **yellow** default for unknown statuses.
pub fn account_row_color(account: &AccountInfo) -> MenuColor {
    if account.is_current_account == Some(true) && account.highlight_current_row != Some(false) {
        return MenuColor::Green;
    }
    match account.status {
        Some(AccountStatus::Active) | Some(AccountStatus::Ok) => MenuColor::Green,
        Some(AccountStatus::QuotaExhausted)
        | Some(AccountStatus::RateLimited)
        | Some(AccountStatus::Cooldown) => MenuColor::Yellow,
        Some(AccountStatus::Disabled)
        | Some(AccountStatus::Error)
        | Some(AccountStatus::Flagged) => MenuColor::Red,
        _ => MenuColor::Yellow,
    }
}

/// `currentMarkerLabel` — `"in-use"` humanizes to `"in use"`.
pub fn current_marker_label(marker: AccountCurrentMarker) -> &'static str {
    match marker {
        AccountCurrentMarker::InUse => "in use",
        marker => marker.as_str(),
    }
}

fn normalize_quota_percent(value: Option<f64>) -> Option<i64> {
    let value = value?;
    if !value.is_finite() {
        return None;
    }
    Some((value.round() as i64).clamp(0, 100))
}

/// `Number.parseInt(value, 10)` prefix-parse semantics.
pub(crate) fn parse_int_prefix(value: &str) -> Option<i64> {
    let trimmed = value.trim_start();
    let mut chars = trimmed.chars().peekable();
    let mut digits = String::new();
    let mut negative = false;
    if let Some(&sign) = chars.peek()
        && (sign == '-' || sign == '+') {
            negative = sign == '-';
            chars.next();
        }
    for ch in chars {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    let magnitude: i64 = digits.parse().ok()?;
    Some(if negative { -magnitude } else { magnitude })
}

fn parse_left_percent_from_summary(summary: &str, window_label: &str) -> Option<i64> {
    for segment in summary.split('|') {
        let trimmed = segment.trim().to_lowercase();
        if !trimmed.starts_with(&format!("{window_label} ")) {
            continue;
        }
        let percent_token = trimmed[window_label.len()..]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        let parsed = match parse_int_prefix(&percent_token.replacen('%', "", 1)) {
            Some(parsed) => parsed,
            None => continue,
        };
        return Some(parsed.clamp(0, 100));
    }
    None
}

fn format_duration_compact(milliseconds: f64) -> String {
    let total_seconds = ((milliseconds / 1_000.0).ceil() as i64).max(0);
    if total_seconds < 60 {
        return format!("{total_seconds}s");
    }
    let total_minutes = total_seconds / 60;
    if total_minutes < 60 {
        let seconds = total_seconds % 60;
        return if seconds > 0 {
            format!("{total_minutes}m {seconds}s")
        } else {
            format!("{total_minutes}m")
        };
    }
    let total_hours = total_minutes / 60;
    if total_hours < 24 {
        let minutes = total_minutes % 60;
        return if minutes > 0 {
            format!("{total_hours}h {minutes}m")
        } else {
            format!("{total_hours}h")
        };
    }
    let days = total_hours / 24;
    let hours = total_hours % 24;
    if hours > 0 {
        format!("{days}d {hours}h")
    } else {
        format!("{days}d")
    }
}

fn format_limit_cooldown(reset_at_ms: Option<f64>, now_ms: i64) -> Option<String> {
    let reset_at = reset_at_ms?;
    if !reset_at.is_finite() {
        return None;
    }
    let remaining = reset_at - now_ms as f64;
    if remaining <= 0.0 {
        return Some("reset ready".to_string());
    }
    Some(format!("reset {}", format_duration_compact(remaining)))
}

fn format_quota_bar(left_percent: Option<i64>, ui: &UiRuntimeOptions) -> String {
    let width: i64 = 10;
    let ratio = left_percent.unwrap_or(0) as f64 / 100.0;
    let filled = ((ratio * width as f64).round() as i64).clamp(0, width) as usize;
    // ui-03: honor glyph mode — the check reads the theme's STORED (requested)
    // glyph mode, and only a literal `unicode` gets block glyphs; `auto`
    // deliberately stays ASCII.
    let use_unicode_bar = ui.theme.glyph_mode == UiGlyphMode::Unicode;
    let fill_char = if use_unicode_bar { "\u{2588}" } else { "#" };
    let empty_char = if use_unicode_bar { "\u{2592}" } else { "-" };
    let filled_text = fill_char.repeat(filled);
    let empty_text = empty_char.repeat((width as usize) - filled);
    if ui.v2_enabled {
        let tone = match left_percent {
            None => UiTextTone::Muted,
            Some(percent) => quota_tone_from_left_percent(percent as f64),
        };
        let filled_segment = if !filled_text.is_empty() {
            paint_ui_text(ui, &filled_text, tone)
        } else {
            String::new()
        };
        let empty_segment = if !empty_text.is_empty() {
            paint_ui_text(ui, &empty_text, UiTextTone::Muted)
        } else {
            String::new()
        };
        return format!("{filled_segment}{empty_segment}");
    }
    let left_percent = match left_percent {
        None => return format!("{}{empty_text}{}", ansi::DIM, ansi::RESET),
        Some(percent) => percent,
    };
    let color = if left_percent <= 15 {
        ansi::RED
    } else if left_percent <= 35 {
        ansi::YELLOW
    } else {
        ansi::GREEN
    };
    let filled_segment = if !filled_text.is_empty() {
        format!("{color}{filled_text}{}", ansi::RESET)
    } else {
        String::new()
    };
    let empty_segment = if !empty_text.is_empty() {
        format!("{}{empty_text}{}", ansi::DIM, ansi::RESET)
    } else {
        String::new()
    };
    format!("{filled_segment}{empty_segment}")
}

fn format_quota_percent(left_percent: Option<i64>, ui: &UiRuntimeOptions) -> Option<String> {
    let left_percent = left_percent?;
    let percent_text = format!("{left_percent}%");
    if !ui.v2_enabled {
        let color = if left_percent <= 15 {
            ansi::RED
        } else if left_percent <= 35 {
            ansi::YELLOW
        } else {
            ansi::GREEN
        };
        return Some(format!("{color}{percent_text}{}", ansi::RESET));
    }
    let tone = quota_tone_from_left_percent(left_percent as f64);
    Some(paint_ui_text(ui, &percent_text, tone))
}

/// JS-style number rendering: integers print without a decimal point.
fn format_js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// Resolve a quota-window label from its duration in minutes (`Nd`/`Nh`/`Nm`);
/// falls back to the positional label when the duration is unknown or invalid.
pub fn resolve_quota_window_label(window_minutes: Option<f64>, fallback_label: &str) -> String {
    let minutes = match window_minutes {
        Some(minutes) if minutes.is_finite() && minutes > 0.0 => minutes,
        _ => return fallback_label.to_string(),
    };
    if minutes % 1440.0 == 0.0 {
        return format!("{}d", format_js_number(minutes / 1440.0));
    }
    if minutes % 60.0 == 0.0 {
        return format!("{}h", format_js_number(minutes / 60.0));
    }
    format!("{}m", format_js_number(minutes))
}

fn format_quota_window(
    label: &str,
    left_percent: Option<i64>,
    reset_at_ms: Option<f64>,
    show_cooldown: bool,
    ui: &UiRuntimeOptions,
    now_ms: i64,
) -> String {
    let label_text = if ui.v2_enabled {
        paint_ui_text(ui, label, UiTextTone::Muted)
    } else {
        label.to_string()
    };
    let bar = format_quota_bar(left_percent, ui);
    let percent = format_quota_percent(left_percent, ui);
    if !show_cooldown {
        return match percent {
            Some(percent) => format!("{label_text} {bar} {percent}"),
            None => format!("{label_text} {bar}"),
        };
    }
    let cooldown = format_limit_cooldown(reset_at_ms, now_ms);
    let cooldown = match cooldown {
        None => {
            return match percent {
                Some(percent) => format!("{label_text} {bar} {percent}"),
                None => format!("{label_text} {bar}"),
            };
        }
        Some(cooldown) => cooldown,
    };
    let cooldown_text = if ui.v2_enabled {
        paint_ui_text(ui, &cooldown, UiTextTone::Muted)
    } else {
        cooldown
    };
    match percent {
        None => format!("{label_text} {bar} {cooldown_text}"),
        Some(percent) => format!("{label_text} {bar} {percent} {cooldown_text}"),
    }
}

fn format_quota_summary(account: &AccountInfo, ui: &UiRuntimeOptions, now_ms: i64) -> String {
    let summary = account.quota_summary.clone().unwrap_or_default();
    let show_cooldown = account.show_quota_cooldown != Some(false);
    // Resolve window labels BEFORE parsing the summary — the summary string is
    // already labelled by duration (a Business row reads "30d 18%, ..."), so
    // searching it for a literal "5h"/"7d" would silently drop the bar.
    let primary_label = resolve_quota_window_label(account.quota_primary_window_minutes, "5h");
    let secondary_label = resolve_quota_window_label(account.quota_secondary_window_minutes, "7d");
    let left_5h = normalize_quota_percent(account.quota_5h_left_percent)
        .or_else(|| parse_left_percent_from_summary(&summary, &primary_label));
    let left_7d = normalize_quota_percent(account.quota_7d_left_percent)
        .or_else(|| parse_left_percent_from_summary(&summary, &secondary_label));
    let mut segments: Vec<String> = Vec::new();

    if left_5h.is_some() || account.quota_5h_reset_at_ms.is_some() {
        segments.push(format_quota_window(
            &primary_label,
            left_5h,
            account.quota_5h_reset_at_ms,
            show_cooldown,
            ui,
            now_ms,
        ));
    }
    if left_7d.is_some() || account.quota_7d_reset_at_ms.is_some() {
        segments.push(format_quota_window(
            &secondary_label,
            left_7d,
            account.quota_7d_reset_at_ms,
            show_cooldown,
            ui,
            now_ms,
        ));
    }
    let summary_lower = summary.to_lowercase();
    if account.quota_rate_limited == Some(true) || summary_lower.contains("rate-limited") {
        segments.push(if ui.v2_enabled {
            paint_ui_text(ui, "rate-limited", UiTextTone::Danger)
        } else {
            format!("{}rate-limited{}", ansi::RED, ansi::RESET)
        });
    }
    if account.quota_exhausted == Some(true) || summary_lower.contains("quota-exhausted") {
        segments.push(if ui.v2_enabled {
            paint_ui_text(ui, "quota-exhausted", UiTextTone::Danger)
        } else {
            format!("{}quota-exhausted{}", ansi::RED, ansi::RESET)
        });
    }

    if segments.is_empty() {
        if summary.is_empty() {
            return String::new();
        }
        return if ui.v2_enabled {
            paint_ui_text(ui, &summary, UiTextTone::Muted)
        } else {
            summary
        };
    }

    let separator = if ui.v2_enabled {
        format!(" {} ", paint_ui_text(ui, "|", UiTextTone::Muted))
    } else {
        " | ".to_string()
    };
    segments.join(&separator)
}

fn badge_tone_to_text_tone(tone: UiBadgeTone) -> UiTextTone {
    match tone {
        UiBadgeTone::Primary => UiTextTone::Primary,
        UiBadgeTone::Accent => UiTextTone::Accent,
        UiBadgeTone::Success => UiTextTone::Success,
        UiBadgeTone::Warning => UiTextTone::Warning,
        UiBadgeTone::Danger => UiTextTone::Danger,
        UiBadgeTone::Muted => UiTextTone::Muted,
    }
}

/// `formatAccountHint` — builds the `status` / `last-used` / `limits` parts and
/// joins them per `statusline_fields` (default `["last-used","limits","status"]`).
pub fn format_account_hint(account: &AccountInfo, ui: &UiRuntimeOptions) -> String {
    let now_ms = cma_core::utils::now_ms();
    let with_key = |key: &str, value: &str, tone: UiTextTone| -> String {
        if !ui.v2_enabled {
            return format!("{key} {value}");
        }
        if value.contains("\x1b[") {
            return format!("{} {value}", paint_ui_text(ui, key, UiTextTone::Muted));
        }
        format!(
            "{} {}",
            paint_ui_text(ui, key, UiTextTone::Muted),
            paint_ui_text(ui, value, tone)
        )
    };

    let mut parts_by_key: Vec<(&str, String)> = Vec::new();
    if account.show_status_badge == Some(false) {
        parts_by_key.push((
            "status",
            with_key(
                "Status:",
                status_text(account.status),
                badge_tone_to_text_tone(status_tone(account.status)),
            ),
        ));
    }
    if account.show_last_used != Some(false) {
        parts_by_key.push((
            "last-used",
            with_key(
                "Last used:",
                &format_relative_time_at(account.last_used, now_ms),
                UiTextTone::Heading,
            ),
        ));
    }
    let quota_summary_text = format_quota_summary(account, ui, now_ms);
    if !quota_summary_text.is_empty() {
        parts_by_key.push(("limits", with_key("Limits:", &quota_summary_text, UiTextTone::Accent)));
    }

    let default_fields = ["last-used", "limits", "status"];
    let configured: Vec<&str> = account
        .statusline_fields
        .as_ref()
        .filter(|f| !f.is_empty())
        .map(|f| f.iter().map(String::as_str).collect())
        .unwrap_or_else(|| default_fields.to_vec());
    let mut ordered_parts: Vec<String> = Vec::new();
    for field in configured {
        if let Some((_, part)) = parts_by_key.iter().find(|(key, _)| *key == field) {
            ordered_parts.push(part.clone());
        }
    }

    if ordered_parts.is_empty() {
        return String::new();
    }
    let separator = if ui.v2_enabled {
        format!(" {} ", paint_ui_text(ui, "|", UiTextTone::Muted))
    } else {
        " | ".to_string()
    };
    if ordered_parts.len() == 1 {
        return ordered_parts[0].clone();
    }

    // NOTE: not actually two lines — a single string (spec 12 gotcha 11).
    let first_line = ordered_parts[..2].join(&separator);
    let second_line = ordered_parts[2..].join(&separator);
    if second_line.is_empty() {
        first_line
    } else {
        format!("{first_line}{separator}{second_line}")
    }
}

/// `authMenuFocusKey` — account-carrying actions key by storage position;
/// static actions key by their type.
pub fn auth_menu_focus_key(action: &AuthMenuAction) -> String {
    match action.account() {
        Some(account) => format!(
            "account:{}",
            account.source_index.unwrap_or(account.index)
        ),
        None => format!("action:{}", action.type_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{create_ui_theme, CreateUiThemeOptions, UiAccent, UiColorProfile, UiPalette};
    use serial_test::serial;

    const DAY_MS: i64 = 86_400_000;

    fn strip_ansi(value: &str) -> String {
        crate::select::strip_ansi(value)
    }

    fn account(overrides: impl FnOnce(&mut AccountInfo)) -> AccountInfo {
        let mut info = AccountInfo {
            index: 0,
            ..Default::default()
        };
        overrides(&mut info);
        info
    }

    fn fixed_ui(v2: bool, glyph_mode: UiGlyphMode) -> UiRuntimeOptions {
        UiRuntimeOptions {
            v2_enabled: v2,
            color_profile: UiColorProfile::Truecolor,
            glyph_mode,
            palette: UiPalette::Green,
            accent: UiAccent::Green,
            theme: create_ui_theme(CreateUiThemeOptions {
                profile: Some(UiColorProfile::Truecolor),
                glyph_mode: Some(glyph_mode),
                disable_color: Some(false),
                ..Default::default()
            }),
        }
    }

    // ---- mainMenuTitleWithVersion ----

    #[test]
    fn returns_bare_title_when_no_cli_version_is_exported() {
        assert_eq!(main_menu_title_with_version_from(None), "Accounts Dashboard");
        assert_eq!(
            main_menu_title_with_version_from(Some("  ")),
            "Accounts Dashboard"
        );
    }

    #[test]
    fn appends_the_version_prefixing_v_only_when_missing() {
        assert_eq!(
            main_menu_title_with_version_from(Some("1.2.3")),
            "Accounts Dashboard (v1.2.3)"
        );
        assert_eq!(
            main_menu_title_with_version_from(Some("v2.0.0")),
            "Accounts Dashboard (v2.0.0)"
        );
        // Capital V is not recognized — becomes vV1.2.3 (gotcha 29).
        assert_eq!(
            main_menu_title_with_version_from(Some("V1.2.3")),
            "Accounts Dashboard (vV1.2.3)"
        );
    }

    // ---- formatRelativeTime ----

    #[test]
    fn renders_relative_times() {
        let now = cma_core::utils::now_ms();
        assert_eq!(format_relative_time_at(None, now), "never");
        assert_eq!(format_relative_time_at(Some(0), now), "never");
        assert_eq!(format_relative_time_at(Some(now - 1_000), now), "today");
        assert_eq!(
            format_relative_time_at(Some(now - DAY_MS - 1_000), now),
            "yesterday"
        );
        assert_eq!(
            format_relative_time_at(Some(now - 3 * DAY_MS - 1_000), now),
            "3d ago"
        );
        assert_eq!(
            format_relative_time_at(Some(now - 15 * DAY_MS), now),
            "2w ago"
        );
    }

    #[test]
    fn falls_back_to_a_date_beyond_a_month() {
        let now = cma_core::utils::now_ms();
        let old = now - 60 * DAY_MS;
        let rendered = format_relative_time_at(Some(old), now);
        // M/D/YYYY shape.
        let parts: Vec<&str> = rendered.split('/').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())));
    }

    #[test]
    fn civil_date_conversion_is_correct() {
        // The UTC civil fallback algorithm itself.
        // 1784937600000 ms = day 20659 since the epoch = 2026-07-25 UTC.
        assert_eq!(civil_from_ms(1_784_937_600_000), (2026, 7, 25));
        assert_eq!(civil_from_ms(0), (1970, 1, 1));
    }

    /// `toLocaleDateString()` parity: the rendered day is the LOCAL calendar
    /// day (timezone-aware expectation so this passes in any TZ), pinned to
    /// the en-US M/D/YYYY shape.
    #[test]
    fn locale_date_uses_the_local_calendar_day() {
        use chrono::{Datelike, TimeZone};
        for ts in [1_784_937_600_000_i64, 0_i64] {
            let local = chrono::Local
                .timestamp_millis_opt(ts)
                .single()
                .expect("local conversion");
            assert_eq!(
                format_locale_date(ts),
                format!("{}/{}/{}", local.month(), local.day(), local.year()),
                "ts {ts}"
            );
        }
    }

    // ---- accountTitle ----

    #[test]
    fn prefers_email_then_label_then_id_then_generic() {
        assert_eq!(
            account_title(&account(|a| a.email = Some("a@example.com".into()))),
            "1. a@example.com"
        );
        assert_eq!(
            account_title(&account(|a| a.account_label = Some("Team A".into()))),
            "1. Team A"
        );
        assert_eq!(
            account_title(&account(|a| a.account_id = Some("acc_1".into()))),
            "1. acc_1"
        );
        assert_eq!(account_title(&account(|_| {})), "1. Account 1");
    }

    #[test]
    fn numbers_rows_by_quick_switch_number_when_present() {
        assert_eq!(
            account_title(&account(|a| {
                a.index = 4;
                a.quick_switch_number = Some(2);
                a.email = Some("a@b.c".into());
            })),
            "2. a@b.c"
        );
    }

    #[test]
    fn strips_ansi_escapes_and_control_chars_from_identity_fields() {
        assert_eq!(
            account_title(&account(|a| a.account_label =
                Some("\x1b[31mEvil\x1b[0m Label".into()))),
            "1. Evil Label"
        );
        assert_eq!(
            account_title(&account(|a| a.email = Some("\x1b[2Jevil@example.com".into()))),
            "1. evil@example.com"
        );
        assert_eq!(
            account_title(&account(|a| a.account_id = Some("acc\x1b[31m_red".into()))),
            "1. acc_red"
        );
    }

    // ---- accountSearchText ----

    #[test]
    fn joins_lowercased_identity_fields_and_row_number() {
        assert_eq!(
            account_search_text(&account(|a| {
                a.index = 1;
                a.email = Some("User@Example.com".into());
                a.account_label = Some("Team A".into());
                a.account_id = Some("ACC_9".into());
            })),
            "user@example.com team a acc_9 2"
        );
    }

    // ---- accountRowColor ----

    #[test]
    fn highlights_current_row_green_unless_highlighting_disabled() {
        assert_eq!(
            account_row_color(&account(|a| {
                a.is_current_account = Some(true);
                a.status = Some(AccountStatus::Disabled);
            })),
            MenuColor::Green
        );
        assert_eq!(
            account_row_color(&account(|a| {
                a.is_current_account = Some(true);
                a.highlight_current_row = Some(false);
                a.status = Some(AccountStatus::Disabled);
            })),
            MenuColor::Red
        );
    }

    #[test]
    fn maps_status_to_row_color_with_yellow_default() {
        assert_eq!(
            account_row_color(&account(|a| a.status = Some(AccountStatus::Ok))),
            MenuColor::Green
        );
        assert_eq!(
            account_row_color(&account(|a| a.status = Some(AccountStatus::RateLimited))),
            MenuColor::Yellow
        );
        assert_eq!(
            account_row_color(&account(|a| a.status = Some(AccountStatus::Cooldown))),
            MenuColor::Yellow
        );
        assert_eq!(
            account_row_color(&account(|a| a.status = Some(AccountStatus::Flagged))),
            MenuColor::Red
        );
        // Unknown/missing status defaults to yellow, not green (gotcha 10).
        assert_eq!(account_row_color(&account(|_| {})), MenuColor::Yellow);
    }

    // ---- statusBadge ----

    #[test]
    #[serial]
    fn labels_badges_with_their_status() {
        crate::runtime_options::reset_ui_runtime_options();
        for status in [
            AccountStatus::Active,
            AccountStatus::Ok,
            AccountStatus::QuotaExhausted,
            AccountStatus::RateLimited,
            AccountStatus::Cooldown,
            AccountStatus::Flagged,
            AccountStatus::Disabled,
            AccountStatus::Error,
        ] {
            assert!(strip_ansi(&status_badge(Some(status))).contains(status.as_str()));
        }
        assert!(strip_ansi(&status_badge(None)).contains("unknown"));
    }

    #[test]
    #[serial]
    fn legacy_badges_have_same_text_content() {
        crate::runtime_options::set_ui_runtime_options(
            crate::runtime_options::UiRuntimeOptionsPatch {
                v2_enabled: Some(false),
                ..Default::default()
            },
        );
        let result = std::panic::catch_unwind(|| {
            assert!(
                strip_ansi(&status_badge(Some(AccountStatus::RateLimited)))
                    .contains("rate-limited")
            );
            assert!(strip_ansi(&status_badge(None)).contains("unknown"));
        });
        crate::runtime_options::reset_ui_runtime_options();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }

    // ---- formatDate ----

    #[test]
    fn format_date_renders_unknown_for_missing_timestamps() {
        assert_eq!(format_date(None), "unknown");
        assert_eq!(format_date(Some(0)), "unknown");
        assert!(format_date(Some(1_784_937_600_000)).contains('/'));
    }

    // ---- currentMarkerLabel ----

    #[test]
    fn humanizes_in_use_and_passes_other_markers_through() {
        assert_eq!(current_marker_label(AccountCurrentMarker::InUse), "in use");
        assert_eq!(current_marker_label(AccountCurrentMarker::Current), "current");
        assert_eq!(
            current_marker_label(AccountCurrentMarker::Selected),
            "selected"
        );
    }

    // ---- formatAccountHint ----

    #[test]
    fn renders_last_used_and_quota_limits_in_default_order() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let now = cma_core::utils::now_ms();
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.last_used = Some(now - 1_000);
                a.quota_5h_left_percent = Some(50.0);
                a.quota_5h_reset_at_ms = Some((now + 30_000) as f64);
            }),
            &ui,
        ));
        assert!(hint.starts_with("Last used: today | Limits: 5h "), "{hint}");
        assert!(hint.contains("50%"));
        assert!(hint.contains("reset "));
    }

    #[test]
    fn includes_status_text_only_when_badge_column_is_hidden() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let now = cma_core::utils::now_ms();
        let visible_badge = strip_ansi(&format_account_hint(
            &account(|a| {
                a.status = Some(AccountStatus::Ok);
                a.last_used = Some(now);
            }),
            &ui,
        ));
        assert!(!visible_badge.contains("Status:"));

        let hidden_badge = strip_ansi(&format_account_hint(
            &account(|a| {
                a.status = Some(AccountStatus::Ok);
                a.last_used = Some(now);
                a.show_status_badge = Some(false);
            }),
            &ui,
        ));
        assert!(hidden_badge.contains("Status: ok"));
    }

    #[test]
    fn orders_parts_by_configured_statusline_fields() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let now = cma_core::utils::now_ms();
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.status = Some(AccountStatus::Ok);
                a.last_used = Some(now);
                a.show_status_badge = Some(false);
                a.statusline_fields = Some(vec!["status".into(), "last-used".into()]);
            }),
            &ui,
        ));
        let status_idx = hint.find("Status:").expect("status part");
        let last_used_idx = hint.find("Last used:").expect("last-used part");
        assert!(status_idx < last_used_idx);
    }

    #[test]
    fn flags_rate_limited_and_exhausted_accounts_in_limits_segment() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let now = cma_core::utils::now_ms();
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.last_used = Some(now);
                a.quota_rate_limited = Some(true);
                a.quota_exhausted = Some(true);
            }),
            &ui,
        ));
        assert!(hint.contains("rate-limited"));
        assert!(hint.contains("quota-exhausted"));
    }

    #[test]
    fn returns_empty_string_when_every_field_is_hidden() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        assert_eq!(
            format_account_hint(&account(|a| a.show_last_used = Some(false)), &ui),
            ""
        );
    }

    // Regression for issue #635: window labels derive from real durations.
    #[test]
    fn labels_primary_window_from_duration_instead_of_positional_5h() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let now = cma_core::utils::now_ms();
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.last_used = Some(now - 2 * DAY_MS);
                a.quota_5h_left_percent = Some(18.0);
                a.quota_5h_reset_at_ms = Some((now + 28 * DAY_MS) as f64);
                a.quota_primary_window_minutes = Some((30 * 24 * 60) as f64);
                a.quota_7d_left_percent = Some(100.0);
                a.quota_secondary_window_minutes = Some((7 * 24 * 60) as f64);
            }),
            &ui,
        ));
        assert!(hint.contains("30d "), "{hint}");
        assert!(hint.contains("7d "), "{hint}");
        assert!(!hint.contains("5h"), "{hint}");
    }

    #[test]
    fn falls_back_to_positional_labels_when_durations_unknown() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let now = cma_core::utils::now_ms();
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.last_used = Some(now);
                a.quota_5h_left_percent = Some(50.0);
                a.quota_7d_left_percent = Some(80.0);
            }),
            &ui,
        ));
        assert!(hint.contains("5h "));
        assert!(hint.contains("7d "));
    }

    fn window_label_for(window_minutes: Option<f64>, primary: bool) -> String {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.show_last_used = Some(false);
                if primary {
                    a.quota_5h_left_percent = Some(50.0);
                    a.quota_primary_window_minutes = window_minutes;
                } else {
                    a.quota_7d_left_percent = Some(50.0);
                    a.quota_secondary_window_minutes = window_minutes;
                }
            }),
            &ui,
        ));
        hint.strip_prefix("Limits: ")
            .unwrap_or(&hint)
            .split(' ')
            .next()
            .unwrap_or("")
            .to_string()
    }

    #[test]
    fn labels_windows_by_duration_table() {
        assert_eq!(window_label_for(Some(1_440.0), true), "1d");
        assert_eq!(window_label_for(Some(43_200.0), true), "30d");
        assert_eq!(window_label_for(Some(300.0), true), "5h");
        assert_eq!(window_label_for(Some(720.0), true), "12h");
        assert_eq!(window_label_for(Some(100.0), true), "100m");
        assert_eq!(window_label_for(Some(90.0), true), "90m");
    }

    #[test]
    fn keeps_positional_labels_for_corrupt_durations() {
        for bad in [Some(0.0), Some(-1.0), Some(f64::NAN), Some(f64::INFINITY)] {
            assert_eq!(window_label_for(bad, true), "5h");
            assert_eq!(window_label_for(bad, false), "7d");
        }
    }

    #[test]
    fn recovers_percent_from_summary_using_resolved_window_label() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.show_last_used = Some(false);
                a.quota_summary = Some("30d 42%, resets in 12d | 7d 80%".into());
                a.quota_primary_window_minutes = Some((30 * 24 * 60) as f64);
                a.quota_secondary_window_minutes = Some((7 * 24 * 60) as f64);
            }),
            &ui,
        ));
        assert!(hint.contains("30d "), "{hint}");
        assert!(hint.contains("42%"), "{hint}");
        assert!(hint.contains("80%"), "{hint}");
    }

    #[test]
    fn legacy_v1_rendering_has_same_text_content() {
        let mut ui = fixed_ui(false, UiGlyphMode::Ascii);
        ui.v2_enabled = false;
        let now = cma_core::utils::now_ms();
        let hint = strip_ansi(&format_account_hint(
            &account(|a| {
                a.last_used = Some(now - 1_000);
                a.quota_5h_left_percent = Some(50.0);
                a.quota_5h_reset_at_ms = Some((now + 30_000) as f64);
            }),
            &ui,
        ));
        assert!(hint.starts_with("Last used: today | Limits: 5h "), "{hint}");
        assert!(hint.contains("50%"));
    }

    // ---- quota bar glyph modes (ui-03), via the public formatter ----

    #[test]
    fn quota_bar_renders_unicode_block_glyphs_in_unicode_mode() {
        let ui = fixed_ui(true, UiGlyphMode::Unicode);
        let hint = format_account_hint(
            &account(|a| {
                a.show_last_used = Some(false);
                a.quota_5h_left_percent = Some(50.0);
            }),
            &ui,
        );
        assert!(hint.contains('\u{2588}'));
        assert!(hint.contains('\u{2592}'));
        assert!(!hint.contains('#'));
    }

    #[test]
    fn quota_bar_renders_ascii_glyphs_in_ascii_mode() {
        let ui = fixed_ui(true, UiGlyphMode::Ascii);
        let hint = format_account_hint(
            &account(|a| {
                a.show_last_used = Some(false);
                a.quota_5h_left_percent = Some(50.0);
            }),
            &ui,
        );
        assert!(hint.contains('#'));
        assert!(!hint.contains('\u{2588}'));
        assert!(!hint.contains('\u{2592}'));
    }

    #[test]
    fn quota_bar_falls_back_to_ascii_in_auto_mode() {
        // The theme keeps the raw "auto" and only a literal "unicode" gets the
        // block glyphs, so auto -> ascii regardless of the resolved glyph set.
        let ui = fixed_ui(true, UiGlyphMode::Auto);
        let hint = format_account_hint(
            &account(|a| {
                a.show_last_used = Some(false);
                a.quota_5h_left_percent = Some(50.0);
            }),
            &ui,
        );
        assert!(hint.contains('#'));
        assert!(!hint.contains('\u{2588}'));
        assert!(!hint.contains('\u{2592}'));
    }

    // ---- authMenuFocusKey ----

    #[test]
    fn keys_account_actions_by_storage_position() {
        let row = account(|a| {
            a.index = 2;
            a.source_index = Some(5);
        });
        assert_eq!(
            auth_menu_focus_key(&AuthMenuAction::SelectAccount(row)),
            "account:5"
        );
        assert_eq!(
            auth_menu_focus_key(&AuthMenuAction::DeleteAccount(account(|a| a.index = 2))),
            "account:2"
        );
    }

    #[test]
    fn keys_static_actions_by_their_type() {
        assert_eq!(auth_menu_focus_key(&AuthMenuAction::Add), "action:add");
        assert_eq!(auth_menu_focus_key(&AuthMenuAction::Cancel), "action:cancel");
        assert_eq!(
            auth_menu_focus_key(&AuthMenuAction::DeepCheck),
            "action:deep-check"
        );
    }

    // ---- helpers ----

    #[test]
    fn parse_int_prefix_matches_js_parseint() {
        assert_eq!(parse_int_prefix("42,"), Some(42));
        assert_eq!(parse_int_prefix("42"), Some(42));
        assert_eq!(parse_int_prefix("-7x"), Some(-7));
        assert_eq!(parse_int_prefix("x42"), None);
        assert_eq!(parse_int_prefix(""), None);
    }

    #[test]
    fn duration_compact_formats_all_magnitudes() {
        assert_eq!(format_duration_compact(500.0), "1s");
        assert_eq!(format_duration_compact(59_000.0), "59s");
        assert_eq!(format_duration_compact(60_000.0), "1m");
        assert_eq!(format_duration_compact(90_000.0), "1m 30s");
        assert_eq!(format_duration_compact(3_600_000.0), "1h");
        assert_eq!(format_duration_compact(5_400_000.0), "1h 30m");
        assert_eq!(format_duration_compact(86_400_000.0), "1d");
        assert_eq!(format_duration_compact(90_000_000.0), "1d 1h");
        assert_eq!(format_duration_compact(-5.0), "0s");
    }
}
