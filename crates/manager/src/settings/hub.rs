//! Port of `lib/codex-manager/settings-hub.ts` + `settings-hub/{index,shared}.ts`
//! (+ the absorbed `settings-hub-entry/-menu/-prompt` DI shims) — the settings
//! hub menu and the shared normalization/clone/merge helpers.
//!
//! The Rust `DashboardDisplaySettings` is the fully-normalized shape (every
//! field concrete), so `cloneDashboardSettingsData`'s "`?? default`" baking is
//! a plain clone plus the two derived rules the TS clone applied on top:
//! layout resolution and `menuShowDetailsForUnselectedRows = (layout ==
//! expanded-rows)`, and statusline-field normalization (spec 09 §5.7).

use cma_config::dashboard_settings::{DashboardDisplaySettings, DashboardLayoutMode};
use cma_tui::select::{select, MenuColor, MenuItem, SelectOptions};
use cma_tui::ui_copy;
use std::io::IsTerminal;

use crate::settings::preview::normalize_statusline_fields;
use crate::settings::schema::BackendNumberSettingOption;

// ---------------------------------------------------------------------------
// Shared helpers (`settings-hub/shared.ts`)
// ---------------------------------------------------------------------------

/// `isTtyInteractive()` — both stdin AND stdout must be TTYs.
pub fn is_tty_interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

/// `keyof DashboardDisplaySettings` — every settings field, for the per-panel
/// key sets (copy/merge/reset are keyed by these).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DashboardSettingKey {
    ShowPerAccountRows,
    ShowQuotaDetails,
    ShowForecastReasons,
    ShowRecommendations,
    ShowLiveProbeNotes,
    ActionAutoReturnMs,
    ActionPauseOnKey,
    MenuAutoFetchLimits,
    MenuSortEnabled,
    MenuSortMode,
    MenuSortPinCurrent,
    MenuSortQuickSwitchVisibleRow,
    UiThemePreset,
    UiAccentColor,
    MenuShowStatusBadge,
    MenuShowCurrentBadge,
    MenuShowLastUsed,
    MenuShowQuotaSummary,
    MenuShowQuotaCooldown,
    MenuShowFetchStatus,
    MenuShowDetailsForUnselectedRows,
    MenuLayoutMode,
    MenuQuotaTtlMs,
    MenuFocusStyle,
    MenuHighlightCurrentRow,
    MenuStatuslineFields,
}

/// `copyDashboardSettingValue(target, source, key)` — one key, arrays copied.
pub fn copy_dashboard_setting_value(
    target: &mut DashboardDisplaySettings,
    source: &DashboardDisplaySettings,
    key: DashboardSettingKey,
) {
    use DashboardSettingKey as K;
    match key {
        K::ShowPerAccountRows => target.show_per_account_rows = source.show_per_account_rows,
        K::ShowQuotaDetails => target.show_quota_details = source.show_quota_details,
        K::ShowForecastReasons => target.show_forecast_reasons = source.show_forecast_reasons,
        K::ShowRecommendations => target.show_recommendations = source.show_recommendations,
        K::ShowLiveProbeNotes => target.show_live_probe_notes = source.show_live_probe_notes,
        K::ActionAutoReturnMs => target.action_auto_return_ms = source.action_auto_return_ms,
        K::ActionPauseOnKey => target.action_pause_on_key = source.action_pause_on_key,
        K::MenuAutoFetchLimits => target.menu_auto_fetch_limits = source.menu_auto_fetch_limits,
        K::MenuSortEnabled => target.menu_sort_enabled = source.menu_sort_enabled,
        K::MenuSortMode => target.menu_sort_mode = source.menu_sort_mode,
        K::MenuSortPinCurrent => target.menu_sort_pin_current = source.menu_sort_pin_current,
        K::MenuSortQuickSwitchVisibleRow => {
            target.menu_sort_quick_switch_visible_row = source.menu_sort_quick_switch_visible_row
        }
        K::UiThemePreset => target.ui_theme_preset = source.ui_theme_preset,
        K::UiAccentColor => target.ui_accent_color = source.ui_accent_color,
        K::MenuShowStatusBadge => target.menu_show_status_badge = source.menu_show_status_badge,
        K::MenuShowCurrentBadge => target.menu_show_current_badge = source.menu_show_current_badge,
        K::MenuShowLastUsed => target.menu_show_last_used = source.menu_show_last_used,
        K::MenuShowQuotaSummary => target.menu_show_quota_summary = source.menu_show_quota_summary,
        K::MenuShowQuotaCooldown => {
            target.menu_show_quota_cooldown = source.menu_show_quota_cooldown
        }
        K::MenuShowFetchStatus => target.menu_show_fetch_status = source.menu_show_fetch_status,
        K::MenuShowDetailsForUnselectedRows => {
            target.menu_show_details_for_unselected_rows =
                source.menu_show_details_for_unselected_rows
        }
        K::MenuLayoutMode => target.menu_layout_mode = source.menu_layout_mode,
        K::MenuQuotaTtlMs => target.menu_quota_ttl_ms = source.menu_quota_ttl_ms,
        K::MenuFocusStyle => target.menu_focus_style = source.menu_focus_style,
        K::MenuHighlightCurrentRow => {
            target.menu_highlight_current_row = source.menu_highlight_current_row
        }
        K::MenuStatuslineFields => {
            target.menu_statusline_fields = source.menu_statusline_fields.clone()
        }
    }
}

/// `resolveMenuLayoutMode` — explicit layout wins; the legacy-boolean fallback
/// only matters for pre-normalized data (unreachable on the normalized Rust
/// struct but kept for faithful behavior of merged drafts).
pub fn resolve_menu_layout_mode(settings: &DashboardDisplaySettings) -> DashboardLayoutMode {
    settings.menu_layout_mode
}

/// `cloneDashboardSettings` (via `cloneDashboardSettingsData`) — clone with
/// the TS clone's derived rules re-applied: resolved layout mode, the legacy
/// boolean re-derived from the layout, and normalized statusline fields.
pub fn clone_dashboard_settings(settings: &DashboardDisplaySettings) -> DashboardDisplaySettings {
    let mut clone = settings.clone();
    let layout = resolve_menu_layout_mode(settings);
    clone.menu_layout_mode = layout;
    clone.menu_show_details_for_unselected_rows = layout == DashboardLayoutMode::ExpandedRows;
    clone.menu_statusline_fields =
        normalize_statusline_fields(Some(&settings.menu_statusline_fields));
    clone
}

/// `dashboardSettingsEqual` — default-insensitive comparison (both sides pass
/// through the normalizing clone first).
pub fn dashboard_settings_equal(
    left: &DashboardDisplaySettings,
    right: &DashboardDisplaySettings,
) -> bool {
    clone_dashboard_settings(left) == clone_dashboard_settings(right)
}

/// `applyDashboardDefaultsForKeys` — clone draft, copy each listed key from
/// the defaults.
pub fn apply_dashboard_defaults_for_keys(
    draft: &DashboardDisplaySettings,
    keys: &[DashboardSettingKey],
) -> DashboardDisplaySettings {
    let mut next = clone_dashboard_settings(draft);
    let defaults = clone_dashboard_settings(&DashboardDisplaySettings::default());
    for key in keys {
        copy_dashboard_setting_value(&mut next, &defaults, *key);
    }
    next
}

/// `mergeDashboardSettingsForKeys` — clone base, copy listed keys from
/// selected, clone again (re-normalizes the derived fields).
pub fn merge_dashboard_settings_for_keys(
    base: &DashboardDisplaySettings,
    selected: &DashboardDisplaySettings,
    keys: &[DashboardSettingKey],
) -> DashboardDisplaySettings {
    let mut next = clone_dashboard_settings(base);
    for key in keys {
        copy_dashboard_setting_value(&mut next, selected, *key);
    }
    clone_dashboard_settings(&next)
}

/// `clampBackendNumber(option, value)` = `max(min, min(max, round(value)))`.
pub fn clamp_backend_number(option: &BackendNumberSettingOption, value: f64) -> f64 {
    option.min.max(option.max.min(value.round()))
}

// -------------------------------------------------------------------------
// Local mirrors of `dashboard-formatters.ts` (canonical Rust home is the
// sibling-owned `crate::formatters::dashboard`; these crate-private copies
// keep the settings cluster self-contained until integration).
// -------------------------------------------------------------------------

/// `formatDashboardSettingState(v)` → `"[x]"` / `"[ ]"`.
pub(crate) fn format_dashboard_setting_state(value: bool) -> &'static str {
    if value {
        "[x]"
    } else {
        "[ ]"
    }
}

/// `formatMenuSortMode(mode)` → `"Ready-First"` / `"Manual"`.
pub(crate) fn format_menu_sort_mode(
    mode: cma_config::dashboard_settings::DashboardAccountSortMode,
) -> &'static str {
    match mode {
        cma_config::dashboard_settings::DashboardAccountSortMode::ReadyFirst => "Ready-First",
        cma_config::dashboard_settings::DashboardAccountSortMode::Manual => "Manual",
    }
}

/// `formatMenuLayoutMode(mode)` → `"Expanded Rows"` / `"Compact + Details Pane"`.
pub(crate) fn format_menu_layout_mode(mode: DashboardLayoutMode) -> &'static str {
    match mode {
        DashboardLayoutMode::ExpandedRows => "Expanded Rows",
        DashboardLayoutMode::CompactDetails => "Compact + Details Pane",
    }
}

/// `formatMenuQuotaTtl(ms)` — `Nm` / `Ns` / `Nms` by divisibility, not
/// magnitude (90_000 → `"90s"`, spec 09 gotcha 34).
pub(crate) fn format_menu_quota_ttl(ttl_ms: i64) -> String {
    if ttl_ms >= 60_000 && ttl_ms % 60_000 == 0 {
        return format!("{}m", ttl_ms / 60_000);
    }
    if ttl_ms >= 1_000 && ttl_ms % 1_000 == 0 {
        return format!("{}s", ttl_ms / 1_000);
    }
    format!("{ttl_ms}ms")
}

/// `applyUiThemeFromDashboardSettings(settings)` — preserves runtime-detected
/// capabilities (v2 flag, color profile, glyph mode) and swaps only the
/// palette/accent from the dashboard settings. (TS source:
/// `settings-hub/dashboard.ts`; exposed from the hub module because the
/// dispatcher and login flow consume it from here.)
pub fn apply_ui_theme_from_dashboard_settings(settings: &DashboardDisplaySettings) {
    use cma_config::dashboard_settings::{DashboardAccentColor, DashboardThemePreset};
    use cma_tui::theme::{UiAccent, UiPalette};
    let current = cma_tui::runtime_options::get_ui_runtime_options();
    let palette = match settings.ui_theme_preset {
        DashboardThemePreset::Green => UiPalette::Green,
        DashboardThemePreset::Blue => UiPalette::Blue,
    };
    let accent = match settings.ui_accent_color {
        DashboardAccentColor::Green => UiAccent::Green,
        DashboardAccentColor::Cyan => UiAccent::Cyan,
        DashboardAccentColor::Blue => UiAccent::Blue,
        DashboardAccentColor::Yellow => UiAccent::Yellow,
    };
    cma_tui::runtime_options::set_ui_runtime_options(cma_tui::runtime_options::UiRuntimeOptionsPatch {
        v2_enabled: Some(current.v2_enabled),
        color_profile: Some(current.color_profile),
        glyph_mode: Some(current.glyph_mode),
        palette: Some(palette),
        accent: Some(accent),
    });
}

// ---------------------------------------------------------------------------
// Hub menu (`settings-hub-menu.ts` / `settings-hub-prompt.ts`)
// ---------------------------------------------------------------------------

/// `SettingsHubMenuAction` / `SettingsHubAction` — one shared enum in Rust.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsHubAction {
    AccountList,
    SummaryFields,
    Behavior,
    Theme,
    Experimental,
    Backend,
    Back,
}

impl SettingsHubAction {
    pub fn type_str(self) -> &'static str {
        match self {
            Self::AccountList => "account-list",
            Self::SummaryFields => "summary-fields",
            Self::Behavior => "behavior",
            Self::Theme => "theme",
            Self::Experimental => "experimental",
            Self::Backend => "backend",
            Self::Back => "back",
        }
    }
}

/// `buildSettingsHubItems(UI_COPY.settings)` — fixed layout.
pub fn build_settings_hub_items() -> Vec<MenuItem<SettingsHubAction>> {
    vec![
        MenuItem::heading(ui_copy::settings::SECTION_TITLE, SettingsHubAction::Back),
        MenuItem::new(ui_copy::settings::ACCOUNT_LIST, SettingsHubAction::AccountList)
            .with_color(MenuColor::Green),
        MenuItem::new(
            ui_copy::settings::SUMMARY_FIELDS,
            SettingsHubAction::SummaryFields,
        )
        .with_color(MenuColor::Green),
        MenuItem::new(ui_copy::settings::BEHAVIOR, SettingsHubAction::Behavior)
            .with_color(MenuColor::Green),
        MenuItem::new(ui_copy::settings::THEME, SettingsHubAction::Theme)
            .with_color(MenuColor::Green),
        MenuItem::separator(SettingsHubAction::Back),
        MenuItem::heading(ui_copy::settings::ADVANCED_TITLE, SettingsHubAction::Back),
        MenuItem::new(
            ui_copy::settings::EXPERIMENTAL,
            SettingsHubAction::Experimental,
        )
        .with_color(MenuColor::Yellow),
        MenuItem::new(ui_copy::settings::BACKEND, SettingsHubAction::Backend)
            .with_color(MenuColor::Green),
        MenuItem::separator(SettingsHubAction::Back),
        MenuItem::heading(ui_copy::settings::EXIT_TITLE, SettingsHubAction::Back),
        MenuItem::new(ui_copy::settings::BACK, SettingsHubAction::Back).with_color(MenuColor::Red),
    ]
}

/// `findSettingsHubInitialCursor` — first non-separator/disabled/heading item
/// with the requested action type.
pub fn find_settings_hub_initial_cursor(
    items: &[MenuItem<SettingsHubAction>],
    initial_focus: SettingsHubAction,
) -> Option<i64> {
    items
        .iter()
        .position(|item| {
            if item.separator || item.disabled || item.heading {
                return false;
            }
            item.value == initial_focus
        })
        .map(|index| index as i64)
}

/// `promptSettingsHubMenu` — non-interactive → `None`; hotkey `q` → back.
pub fn prompt_settings_hub_menu(initial_focus: SettingsHubAction) -> Option<SettingsHubAction> {
    if !is_tty_interactive() {
        return None;
    }
    let ui = cma_tui::runtime_options::get_ui_runtime_options();
    let items = build_settings_hub_items();
    let initial_cursor = find_settings_hub_initial_cursor(&items, initial_focus);

    let mut options: SelectOptions<'_, SettingsHubAction> =
        SelectOptions::new(ui_copy::settings::TITLE);
    options.subtitle = Some(ui_copy::settings::SUBTITLE.to_string());
    options.help = Some(ui_copy::settings::HELP.to_string());
    options.clear_screen = true;
    options.theme = Some(ui.theme.clone());
    options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
    options.initial_cursor = initial_cursor;
    options.on_input = Some(Box::new(|raw, _ctx| {
        if raw.to_lowercase() == "q" {
            cma_tui::select::SelectInputResult::Finish(Some(SettingsHubAction::Back))
        } else {
            cma_tui::select::SelectInputResult::Ignored
        }
    }));

    select(&items, options).ok().flatten()
}

/// `promptSettingsHub(initialFocus = "account-list")`.
pub fn prompt_settings_hub(initial_focus: SettingsHubAction) -> Option<SettingsHubAction> {
    prompt_settings_hub_menu(initial_focus)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_config::dashboard_settings::{
        DashboardAccountSortMode, DashboardStatuslineField, DashboardThemePreset,
    };

    #[test]
    fn hub_items_have_the_fixed_layout() {
        let items = build_settings_hub_items();
        assert_eq!(items.len(), 12);
        assert!(items[0].heading);
        assert_eq!(items[0].label, "Basic");
        assert_eq!(items[1].value, SettingsHubAction::AccountList);
        assert_eq!(items[1].color, Some(MenuColor::Green));
        assert_eq!(items[4].value, SettingsHubAction::Theme);
        assert!(items[5].separator);
        assert_eq!(items[6].label, "Advanced");
        assert_eq!(items[7].value, SettingsHubAction::Experimental);
        assert_eq!(items[7].color, Some(MenuColor::Yellow));
        assert_eq!(items[8].value, SettingsHubAction::Backend);
        assert!(items[9].separator);
        assert_eq!(items[10].label, "Back");
        assert_eq!(items[11].value, SettingsHubAction::Back);
        assert_eq!(items[11].color, Some(MenuColor::Red));
    }

    #[test]
    fn initial_cursor_skips_headings_and_separators() {
        let items = build_settings_hub_items();
        assert_eq!(
            find_settings_hub_initial_cursor(&items, SettingsHubAction::AccountList),
            Some(1)
        );
        assert_eq!(
            find_settings_hub_initial_cursor(&items, SettingsHubAction::Backend),
            Some(8)
        );
        // "back" resolves to the LAST item (headings/separators carry the
        // back value but are filtered out).
        assert_eq!(
            find_settings_hub_initial_cursor(&items, SettingsHubAction::Back),
            Some(11)
        );
    }

    #[test]
    fn clone_derives_legacy_boolean_from_layout() {
        let settings = DashboardDisplaySettings {
            menu_layout_mode: DashboardLayoutMode::ExpandedRows,
            menu_show_details_for_unselected_rows: false, // stale
            ..Default::default()
        };
        let clone = clone_dashboard_settings(&settings);
        assert!(clone.menu_show_details_for_unselected_rows);
        assert_eq!(clone.menu_layout_mode, DashboardLayoutMode::ExpandedRows);
    }

    #[test]
    fn clone_normalizes_statusline_fields() {
        let settings = DashboardDisplaySettings {
            menu_statusline_fields: vec![
                DashboardStatuslineField::Limits,
                DashboardStatuslineField::Limits,
            ],
            ..Default::default()
        };
        let clone = clone_dashboard_settings(&settings);
        assert_eq!(
            clone.menu_statusline_fields,
            vec![DashboardStatuslineField::Limits]
        );
    }

    #[test]
    fn equality_is_normalization_insensitive() {
        let left = DashboardDisplaySettings::default();
        let mut right = DashboardDisplaySettings {
            menu_statusline_fields: vec![
                DashboardStatuslineField::LastUsed,
                DashboardStatuslineField::LastUsed,
                DashboardStatuslineField::Limits,
                DashboardStatuslineField::Status,
            ],
            ..Default::default()
        };
        assert!(dashboard_settings_equal(&left, &right));
        right.menu_sort_mode = DashboardAccountSortMode::Manual;
        assert!(!dashboard_settings_equal(&left, &right));
    }

    #[test]
    fn merge_copies_only_the_listed_keys() {
        let base = DashboardDisplaySettings::default();
        let selected = DashboardDisplaySettings {
            menu_show_fetch_status: false,
            ui_theme_preset: DashboardThemePreset::Blue,
            ..Default::default()
        };
        let merged = merge_dashboard_settings_for_keys(
            &base,
            &selected,
            &[DashboardSettingKey::MenuShowFetchStatus],
        );
        assert!(!merged.menu_show_fetch_status);
        // ui_theme_preset was NOT in the key set — stays at base value.
        assert_eq!(merged.ui_theme_preset, DashboardThemePreset::Green);
    }

    #[test]
    fn apply_defaults_resets_only_the_listed_keys() {
        let draft = DashboardDisplaySettings {
            menu_show_fetch_status: false,
            action_auto_return_ms: 4_000,
            ..Default::default()
        };
        let reset = apply_dashboard_defaults_for_keys(
            &draft,
            &[DashboardSettingKey::MenuShowFetchStatus],
        );
        assert!(reset.menu_show_fetch_status);
        assert_eq!(reset.action_auto_return_ms, 4_000);
    }

    #[test]
    fn clamp_backend_number_rounds_then_clamps() {
        let option = crate::settings::schema::backend_number_option_by_key(
            crate::settings::schema::BackendNumberSettingKey::ParallelProbingMaxConcurrency,
        );
        assert_eq!(clamp_backend_number(option, 2.4), 2.0);
        assert_eq!(clamp_backend_number(option, 99.0), 5.0);
        assert_eq!(clamp_backend_number(option, -3.0), 1.0);
        assert_eq!(clamp_backend_number(option, 2.6), 3.0);
    }
}
