//! Port of `lib/dashboard-settings.ts` — dashboard display settings:
//! normalization (clamps/enums/defaults), load from unified settings with a
//! one-time migration from the legacy `dashboard-settings.json`.
//!
//! Gotcha 9 (layout-mode derivation): `menuShowDetailsForUnselectedRows` is
//! an OUTPUT derived from `menuLayoutMode` — the input boolean only serves as
//! the legacy fallback hint:
//! `derived = menuLayoutMode == "expanded-rows" ? expanded
//!          : (menuShowDetailsForUnselectedRows == true ? expanded : compact)`
//! and the emitted boolean is `derived == expanded`.
//!
//! The legacy file wraps its payload under a `settings` key, is read with a
//! 4-attempt 20/40/80 ms retry on EBUSY/EPERM/EAGAIN, is NOT deleted after
//! migration, and migration write failures are swallowed.

use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use cma_core::fs_retry::{Backoff, RetryOptions, with_retry};
use cma_core::json_io::read_text_file;
use cma_core::logger::log_warn;
use cma_core::runtime_paths::get_codex_multi_auth_dir;

use crate::unified_settings::{
    get_unified_settings_path, load_unified_dashboard_settings, save_unified_dashboard_settings,
};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

macro_rules! dashboard_str_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
        }
    };
}

dashboard_str_enum!(
    /// `DashboardThemePreset = "green" | "blue"`.
    DashboardThemePreset { Green => "green", Blue => "blue" }
);

dashboard_str_enum!(
    /// `DashboardAccentColor = "green" | "cyan" | "blue" | "yellow"`.
    DashboardAccentColor {
        Green => "green",
        Cyan => "cyan",
        Blue => "blue",
        Yellow => "yellow",
    }
);

dashboard_str_enum!(
    /// `DashboardAccountSortMode = "manual" | "ready-first"`.
    DashboardAccountSortMode { Manual => "manual", ReadyFirst => "ready-first" }
);

dashboard_str_enum!(
    /// `DashboardStatuslineField = "last-used" | "limits" | "status"`.
    DashboardStatuslineField {
        LastUsed => "last-used",
        Limits => "limits",
        Status => "status",
    }
);

dashboard_str_enum!(
    /// (private in TS) `DashboardLayoutMode = "compact-details" | "expanded-rows"`.
    DashboardLayoutMode { CompactDetails => "compact-details", ExpandedRows => "expanded-rows" }
);

dashboard_str_enum!(
    /// (private in TS) `DashboardFocusStyle = "row-invert"` — the only value.
    DashboardFocusStyle { RowInvert => "row-invert" }
);

// ---------------------------------------------------------------------------
// Settings struct (serde field order == TS interface / output-literal order)
// ---------------------------------------------------------------------------

/// `DashboardDisplaySettings` — the normalized shape is always fully
/// populated (the TS optionals exist only pre-normalization). Serialization
/// order matches the TS normalize output literal, which is what lands in
/// `settings.json` (golden-verified).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardDisplaySettings {
    pub show_per_account_rows: bool,
    pub show_quota_details: bool,
    pub show_forecast_reasons: bool,
    pub show_recommendations: bool,
    pub show_live_probe_notes: bool,
    pub action_auto_return_ms: i64,
    pub action_pause_on_key: bool,
    pub menu_auto_fetch_limits: bool,
    pub menu_sort_enabled: bool,
    pub menu_sort_mode: DashboardAccountSortMode,
    pub menu_sort_pin_current: bool,
    pub menu_sort_quick_switch_visible_row: bool,
    pub ui_theme_preset: DashboardThemePreset,
    pub ui_accent_color: DashboardAccentColor,
    pub menu_show_status_badge: bool,
    pub menu_show_current_badge: bool,
    pub menu_show_last_used: bool,
    pub menu_show_quota_summary: bool,
    pub menu_show_quota_cooldown: bool,
    pub menu_show_fetch_status: bool,
    pub menu_show_details_for_unselected_rows: bool,
    pub menu_layout_mode: DashboardLayoutMode,
    pub menu_quota_ttl_ms: i64,
    pub menu_focus_style: DashboardFocusStyle,
    pub menu_highlight_current_row: bool,
    pub menu_statusline_fields: Vec<DashboardStatuslineField>,
}

impl Default for DashboardDisplaySettings {
    /// `DEFAULT_DASHBOARD_DISPLAY_SETTINGS` (spec 01 §2.11, exact values).
    fn default() -> Self {
        DashboardDisplaySettings {
            show_per_account_rows: true,
            show_quota_details: true,
            show_forecast_reasons: true,
            show_recommendations: true,
            show_live_probe_notes: true,
            action_auto_return_ms: 2_000,
            action_pause_on_key: true,
            menu_auto_fetch_limits: true,
            menu_sort_enabled: true,
            menu_sort_mode: DashboardAccountSortMode::ReadyFirst,
            menu_sort_pin_current: false,
            menu_sort_quick_switch_visible_row: true,
            ui_theme_preset: DashboardThemePreset::Green,
            ui_accent_color: DashboardAccentColor::Green,
            menu_show_status_badge: true,
            menu_show_current_badge: true,
            menu_show_last_used: true,
            menu_show_quota_summary: true,
            menu_show_quota_cooldown: true,
            menu_show_fetch_status: true,
            menu_show_details_for_unselected_rows: false,
            menu_layout_mode: DashboardLayoutMode::CompactDetails,
            menu_quota_ttl_ms: 300_000,
            menu_focus_style: DashboardFocusStyle::RowInvert,
            menu_highlight_current_row: true,
            menu_statusline_fields: vec![
                DashboardStatuslineField::LastUsed,
                DashboardStatuslineField::Limits,
                DashboardStatuslineField::Status,
            ],
        }
    }
}

/// `DEFAULT_DASHBOARD_DISPLAY_SETTINGS` as a function (TS exports a const).
pub fn default_dashboard_display_settings() -> DashboardDisplaySettings {
    DashboardDisplaySettings::default()
}

// ---------------------------------------------------------------------------
// Normalization (pure)
// ---------------------------------------------------------------------------

fn normalize_boolean(value: Option<&Value>, fallback: bool) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        _ => fallback,
    }
}

fn normalize_theme_preset(value: Option<&Value>) -> DashboardThemePreset {
    match value.and_then(Value::as_str) {
        Some("blue") => DashboardThemePreset::Blue,
        _ => DashboardThemePreset::Green,
    }
}

fn normalize_accent_color(value: Option<&Value>) -> DashboardAccentColor {
    match value.and_then(Value::as_str) {
        Some("cyan") => DashboardAccentColor::Cyan,
        Some("blue") => DashboardAccentColor::Blue,
        Some("yellow") => DashboardAccentColor::Yellow,
        _ => DashboardAccentColor::Green,
    }
}

fn normalize_layout_mode(value: Option<&Value>, fallback: DashboardLayoutMode) -> DashboardLayoutMode {
    match value.and_then(Value::as_str) {
        Some("expanded-rows") => DashboardLayoutMode::ExpandedRows,
        _ => fallback,
    }
}

fn normalize_account_sort_mode(
    value: Option<&Value>,
    fallback: DashboardAccountSortMode,
) -> DashboardAccountSortMode {
    match value.and_then(Value::as_str) {
        Some("ready-first") => DashboardAccountSortMode::ReadyFirst,
        Some("manual") => DashboardAccountSortMode::Manual,
        _ => fallback,
    }
}

/// finite number → round, clamp [60_000, 1_800_000]; else fallback.
fn normalize_quota_ttl_ms(value: Option<&Value>, fallback: i64) -> i64 {
    match value.and_then(Value::as_f64) {
        Some(number) if number.is_finite() => {
            let rounded = number.round();
            rounded.clamp(60_000.0, 1_800_000.0) as i64
        }
        _ => fallback,
    }
}

/// finite number → round, clamp [0, 10_000]; else fallback.
fn normalize_auto_return_ms(value: Option<&Value>, fallback: i64) -> i64 {
    match value.and_then(Value::as_f64) {
        Some(number) if number.is_finite() => {
            let rounded = number.round();
            rounded.clamp(0.0, 10_000.0) as i64
        }
        _ => fallback,
    }
}

/// Array → keep allowed strings, dedupe preserving order; empty result or
/// non-array → the default triple.
fn normalize_statusline_fields(value: Option<&Value>) -> Vec<DashboardStatuslineField> {
    let default_fields = DashboardDisplaySettings::default().menu_statusline_fields;
    let Some(Value::Array(entries)) = value else {
        return default_fields;
    };
    let mut fields: Vec<DashboardStatuslineField> = Vec::new();
    for entry in entries {
        let Some(text) = entry.as_str() else { continue };
        let typed = match text {
            "last-used" => DashboardStatuslineField::LastUsed,
            "limits" => DashboardStatuslineField::Limits,
            "status" => DashboardStatuslineField::Status,
            _ => continue,
        };
        if !fields.contains(&typed) {
            fields.push(typed);
        }
    }
    if fields.is_empty() { default_fields } else { fields }
}

/// `normalizeDashboardDisplaySettings(value)` — pure; non-record input yields
/// a defaults copy. See the module docs for the layout-mode derivation.
pub fn normalize_dashboard_display_settings(value: &Value) -> DashboardDisplaySettings {
    let Some(record) = value.as_object() else {
        return DashboardDisplaySettings::default();
    };
    let defaults = DashboardDisplaySettings::default();
    let derived_layout_mode = normalize_layout_mode(
        record.get("menuLayoutMode"),
        if record.get("menuShowDetailsForUnselectedRows") == Some(&Value::Bool(true)) {
            DashboardLayoutMode::ExpandedRows
        } else {
            DashboardLayoutMode::CompactDetails
        },
    );
    DashboardDisplaySettings {
        show_per_account_rows: normalize_boolean(
            record.get("showPerAccountRows"),
            defaults.show_per_account_rows,
        ),
        show_quota_details: normalize_boolean(
            record.get("showQuotaDetails"),
            defaults.show_quota_details,
        ),
        show_forecast_reasons: normalize_boolean(
            record.get("showForecastReasons"),
            defaults.show_forecast_reasons,
        ),
        show_recommendations: normalize_boolean(
            record.get("showRecommendations"),
            defaults.show_recommendations,
        ),
        show_live_probe_notes: normalize_boolean(
            record.get("showLiveProbeNotes"),
            defaults.show_live_probe_notes,
        ),
        action_auto_return_ms: normalize_auto_return_ms(
            record.get("actionAutoReturnMs"),
            defaults.action_auto_return_ms,
        ),
        action_pause_on_key: normalize_boolean(
            record.get("actionPauseOnKey"),
            defaults.action_pause_on_key,
        ),
        menu_auto_fetch_limits: normalize_boolean(
            record.get("menuAutoFetchLimits"),
            defaults.menu_auto_fetch_limits,
        ),
        // NOTE (spec 01 §2.11): the TS `?? false` / `?? true` right-hand
        // sides after the DEFAULT lookups are dead code (the defaults are all
        // defined); the DEFAULT object values are the effective fallbacks.
        menu_sort_enabled: normalize_boolean(
            record.get("menuSortEnabled"),
            defaults.menu_sort_enabled,
        ),
        menu_sort_mode: normalize_account_sort_mode(
            record.get("menuSortMode"),
            defaults.menu_sort_mode,
        ),
        menu_sort_pin_current: normalize_boolean(
            record.get("menuSortPinCurrent"),
            defaults.menu_sort_pin_current,
        ),
        menu_sort_quick_switch_visible_row: normalize_boolean(
            record.get("menuSortQuickSwitchVisibleRow"),
            defaults.menu_sort_quick_switch_visible_row,
        ),
        ui_theme_preset: normalize_theme_preset(record.get("uiThemePreset")),
        ui_accent_color: normalize_accent_color(record.get("uiAccentColor")),
        menu_show_status_badge: normalize_boolean(
            record.get("menuShowStatusBadge"),
            defaults.menu_show_status_badge,
        ),
        menu_show_current_badge: normalize_boolean(
            record.get("menuShowCurrentBadge"),
            defaults.menu_show_current_badge,
        ),
        menu_show_last_used: normalize_boolean(
            record.get("menuShowLastUsed"),
            defaults.menu_show_last_used,
        ),
        menu_show_quota_summary: normalize_boolean(
            record.get("menuShowQuotaSummary"),
            defaults.menu_show_quota_summary,
        ),
        menu_show_quota_cooldown: normalize_boolean(
            record.get("menuShowQuotaCooldown"),
            defaults.menu_show_quota_cooldown,
        ),
        menu_show_fetch_status: normalize_boolean(
            record.get("menuShowFetchStatus"),
            defaults.menu_show_fetch_status,
        ),
        // Gotcha 9: DERIVED from the layout mode, never the raw input bool.
        menu_show_details_for_unselected_rows: derived_layout_mode
            == DashboardLayoutMode::ExpandedRows,
        menu_layout_mode: derived_layout_mode,
        menu_quota_ttl_ms: normalize_quota_ttl_ms(
            record.get("menuQuotaTtlMs"),
            defaults.menu_quota_ttl_ms,
        ),
        menu_focus_style: DashboardFocusStyle::RowInvert,
        menu_highlight_current_row: normalize_boolean(
            record.get("menuHighlightCurrentRow"),
            defaults.menu_highlight_current_row,
        ),
        menu_statusline_fields: normalize_statusline_fields(record.get("menuStatuslineFields")),
    }
}

/// `toJsonRecord` — serialize into an order-preserving JSON record (field
/// order == struct declaration order == TS output-literal order).
pub fn to_json_record(settings: &DashboardDisplaySettings) -> Map<String, Value> {
    match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/// `getDashboardSettingsPath` — returns the UNIFIED settings path
/// (settings.json), NOT the legacy file.
pub fn get_dashboard_settings_path() -> PathBuf {
    get_unified_settings_path()
}

/// The legacy `<multi-auth-dir>/dashboard-settings.json` location.
fn legacy_dashboard_settings_path() -> PathBuf {
    get_codex_multi_auth_dir().join("dashboard-settings.json")
}

const RETRYABLE_READ_CODES: &[&str] = &["EBUSY", "EPERM", "EAGAIN"];
const LEGACY_READ_MAX_ATTEMPTS: u32 = 4;
const LEGACY_READ_BASE_DELAY_MS: u64 = 20;

/// `readLegacySettingsFile` — 4 attempts, sleeps 20/40/80 ms between
/// retryable failures (EBUSY/EPERM/EAGAIN); other errors propagate.
async fn read_legacy_settings_file(path: &std::path::Path) -> io::Result<String> {
    with_retry(
        || {
            let path = path.to_path_buf();
            async move { read_text_file(&path) }
        },
        RetryOptions::<io::Error>::new(
            LEGACY_READ_MAX_ATTEMPTS,
            Backoff::from_fn(|attempt| {
                LEGACY_READ_BASE_DELAY_MS
                    .saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
            }),
        )
        .with_codes(RETRYABLE_READ_CODES),
    )
    .await
}

/// `loadDashboardDisplaySettings` — unified section → normalize; else legacy
/// file (retrying reads) with best-effort migration into unified settings
/// (the legacy file is NOT deleted); any failure → defaults (read/parse
/// failures warn with the frozen prefix).
pub async fn load_dashboard_display_settings() -> DashboardDisplaySettings {
    if let Some(unified_settings) = load_unified_dashboard_settings().await {
        return normalize_dashboard_display_settings(&Value::Object(unified_settings));
    }

    let legacy_path = legacy_dashboard_settings_path();
    if !legacy_path.exists() {
        return DashboardDisplaySettings::default();
    }

    let outcome: Result<DashboardDisplaySettings, String> = async {
        let raw = read_legacy_settings_file(&legacy_path)
            .await
            .map_err(|error| error.to_string())?;
        let parsed: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        if !parsed.is_object() {
            return Ok(DashboardDisplaySettings::default());
        }
        let normalized = normalize_dashboard_display_settings(
            parsed.get("settings").unwrap_or(&Value::Null),
        );
        // Best-effort migration; the legacy file stays in place.
        let _ = save_unified_dashboard_settings(&to_json_record(&normalized)).await;
        Ok(normalized)
    }
    .await;

    match outcome {
        Ok(settings) => settings,
        Err(message) => {
            log_warn(
                &format!(
                    "Failed to load dashboard settings from {}: {}",
                    legacy_path.display(),
                    message
                ),
                None,
            );
            DashboardDisplaySettings::default()
        }
    }
}

/// `saveDashboardDisplaySettings` — normalize, then persist through the
/// unified `dashboardDisplaySettings` section.
pub async fn save_dashboard_display_settings(
    settings: &DashboardDisplaySettings,
) -> io::Result<()> {
    let as_value = serde_json::to_value(settings).unwrap_or(Value::Null);
    let normalized = normalize_dashboard_display_settings(&as_value);
    save_unified_dashboard_settings(&to_json_record(&normalized)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn non_record_input_yields_defaults_copy() {
        for value in [json!(null), json!("x"), json!([1]), json!(7)] {
            assert_eq!(
                normalize_dashboard_display_settings(&value),
                DashboardDisplaySettings::default()
            );
        }
    }

    #[test]
    fn layout_mode_derivation_matrix() {
        // Explicit expanded-rows wins.
        let s = normalize_dashboard_display_settings(&json!({
            "menuLayoutMode": "expanded-rows",
            "menuShowDetailsForUnselectedRows": false,
        }));
        assert_eq!(s.menu_layout_mode, DashboardLayoutMode::ExpandedRows);
        assert!(s.menu_show_details_for_unselected_rows, "boolean is DERIVED");

        // Legacy boolean hint promotes to expanded-rows.
        let s = normalize_dashboard_display_settings(&json!({
            "menuShowDetailsForUnselectedRows": true,
        }));
        assert_eq!(s.menu_layout_mode, DashboardLayoutMode::ExpandedRows);
        assert!(s.menu_show_details_for_unselected_rows);

        // Unknown layout string + false hint → compact.
        let s = normalize_dashboard_display_settings(&json!({
            "menuLayoutMode": "weird",
            "menuShowDetailsForUnselectedRows": "yes",
        }));
        assert_eq!(s.menu_layout_mode, DashboardLayoutMode::CompactDetails);
        assert!(!s.menu_show_details_for_unselected_rows);
    }

    #[test]
    fn clamps_and_enum_fallbacks() {
        let s = normalize_dashboard_display_settings(&json!({
            "menuQuotaTtlMs": 10,             // clamps up to 60_000
            "actionAutoReturnMs": 99_999,     // clamps down to 10_000
            "uiThemePreset": "purple",        // → green
            "uiAccentColor": "yellow",
            "menuSortMode": "manual",
            "menuFocusStyle": "anything",     // always row-invert
            "menuStatuslineFields": ["limits", "bogus", "limits", "status", 3],
        }));
        assert_eq!(s.menu_quota_ttl_ms, 60_000);
        assert_eq!(s.action_auto_return_ms, 10_000);
        assert_eq!(s.ui_theme_preset, DashboardThemePreset::Green);
        assert_eq!(s.ui_accent_color, DashboardAccentColor::Yellow);
        assert_eq!(s.menu_sort_mode, DashboardAccountSortMode::Manual);
        assert_eq!(s.menu_focus_style, DashboardFocusStyle::RowInvert);
        assert_eq!(
            s.menu_statusline_fields,
            vec![
                DashboardStatuslineField::Limits,
                DashboardStatuslineField::Status
            ],
            "dedupe preserving order, invalid entries dropped"
        );

        let upper = normalize_dashboard_display_settings(&json!({ "menuQuotaTtlMs": 99_999_999 }));
        assert_eq!(upper.menu_quota_ttl_ms, 1_800_000);
        let rounded = normalize_dashboard_display_settings(&json!({ "menuQuotaTtlMs": 61_000.6 }));
        assert_eq!(rounded.menu_quota_ttl_ms, 61_001);
    }

    #[test]
    fn empty_or_invalid_statusline_fields_fall_back_to_the_default_triple() {
        let default_triple = DashboardDisplaySettings::default().menu_statusline_fields;
        let s = normalize_dashboard_display_settings(&json!({ "menuStatuslineFields": [] }));
        assert_eq!(s.menu_statusline_fields, default_triple);
        let s = normalize_dashboard_display_settings(&json!({ "menuStatuslineFields": "limits" }));
        assert_eq!(s.menu_statusline_fields, default_triple);
        let s = normalize_dashboard_display_settings(&json!({ "menuStatuslineFields": [1, true] }));
        assert_eq!(s.menu_statusline_fields, default_triple);
    }

    #[test]
    fn booleans_only_accept_actual_booleans() {
        let s = normalize_dashboard_display_settings(&json!({
            "showPerAccountRows": "false",  // not a boolean → default true
            "menuSortPinCurrent": true,
            "menuHighlightCurrentRow": 0,
        }));
        assert!(s.show_per_account_rows);
        assert!(s.menu_sort_pin_current);
        assert!(s.menu_highlight_current_row);
    }

    #[test]
    fn json_record_field_order_matches_the_golden_section() {
        let record = to_json_record(&DashboardDisplaySettings::default());
        let keys: Vec<&str> = record.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "showPerAccountRows",
                "showQuotaDetails",
                "showForecastReasons",
                "showRecommendations",
                "showLiveProbeNotes",
                "actionAutoReturnMs",
                "actionPauseOnKey",
                "menuAutoFetchLimits",
                "menuSortEnabled",
                "menuSortMode",
                "menuSortPinCurrent",
                "menuSortQuickSwitchVisibleRow",
                "uiThemePreset",
                "uiAccentColor",
                "menuShowStatusBadge",
                "menuShowCurrentBadge",
                "menuShowLastUsed",
                "menuShowQuotaSummary",
                "menuShowQuotaCooldown",
                "menuShowFetchStatus",
                "menuShowDetailsForUnselectedRows",
                "menuLayoutMode",
                "menuQuotaTtlMs",
                "menuFocusStyle",
                "menuHighlightCurrentRow",
                "menuStatuslineFields",
            ]
        );
        assert_eq!(record.get("menuQuotaTtlMs"), Some(&json!(300000)));
        assert_eq!(record.get("menuSortMode"), Some(&json!("ready-first")));
    }

    #[test]
    fn defaults_match_the_spec_table() {
        let d = DashboardDisplaySettings::default();
        assert!(d.menu_sort_enabled);
        assert!(!d.menu_sort_pin_current);
        assert_eq!(d.action_auto_return_ms, 2_000);
        assert_eq!(d.menu_quota_ttl_ms, 300_000);
        assert!(!d.menu_show_details_for_unselected_rows);
        assert_eq!(d.menu_layout_mode, DashboardLayoutMode::CompactDetails);
    }
}
