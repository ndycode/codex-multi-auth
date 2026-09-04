//! Port of `settings-hub/dashboard.ts` (+ `dashboard-display-panel.ts`,
//! `dashboard-settings-controller.ts`, absorbed entry shims) — the option
//! tables, panel key sets, the account-list display panel, and the two
//! dashboard controllers.

use std::cell::RefCell;

use cma_config::dashboard_settings::{
    get_dashboard_settings_path, load_dashboard_display_settings, DashboardAccentColor,
    DashboardAccountSortMode, DashboardDisplaySettings, DashboardLayoutMode,
    DashboardStatuslineField, DashboardThemePreset,
};
use cma_tui::runtime_options::get_ui_runtime_options;
use cma_tui::select::{select, MenuColor, MenuItem, SelectInputResult, SelectOptions};
use cma_tui::ui_copy;

use crate::settings::hub::{
    apply_dashboard_defaults_for_keys, apply_ui_theme_from_dashboard_settings,
    clone_dashboard_settings, dashboard_settings_equal, format_dashboard_setting_state,
    format_menu_layout_mode, format_menu_sort_mode, is_tty_interactive, resolve_menu_layout_mode,
    DashboardSettingKey,
};
use crate::settings::persist::persist_dashboard_settings_selection;
use crate::settings::preview::{build_account_list_preview, PreviewFocusKey};

// ---------------------------------------------------------------------------
// Option tables (`settings-hub/dashboard.ts`, exact strings)
// ---------------------------------------------------------------------------

/// `DashboardDisplaySettingKey` — the 11 toggle rows of the account-list
/// panel (note: `menuShowDetailsForUnselectedRows` is NOT a toggle row; it is
/// controlled by the layout cycle item).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DashboardDisplaySettingKey {
    MenuShowStatusBadge,
    MenuShowCurrentBadge,
    MenuShowLastUsed,
    MenuShowQuotaSummary,
    MenuShowQuotaCooldown,
    MenuShowFetchStatus,
    MenuHighlightCurrentRow,
    MenuSortEnabled,
    MenuSortPinCurrent,
    MenuSortQuickSwitchVisibleRow,
    /// Present in the TS key union but not in the option rows.
    MenuShowDetailsForUnselectedRows,
}

impl DashboardDisplaySettingKey {
    pub fn get(self, settings: &DashboardDisplaySettings) -> bool {
        match self {
            Self::MenuShowStatusBadge => settings.menu_show_status_badge,
            Self::MenuShowCurrentBadge => settings.menu_show_current_badge,
            Self::MenuShowLastUsed => settings.menu_show_last_used,
            Self::MenuShowQuotaSummary => settings.menu_show_quota_summary,
            Self::MenuShowQuotaCooldown => settings.menu_show_quota_cooldown,
            Self::MenuShowFetchStatus => settings.menu_show_fetch_status,
            Self::MenuHighlightCurrentRow => settings.menu_highlight_current_row,
            Self::MenuSortEnabled => settings.menu_sort_enabled,
            Self::MenuSortPinCurrent => settings.menu_sort_pin_current,
            Self::MenuSortQuickSwitchVisibleRow => settings.menu_sort_quick_switch_visible_row,
            Self::MenuShowDetailsForUnselectedRows => {
                settings.menu_show_details_for_unselected_rows
            }
        }
    }

    pub fn set(self, settings: &mut DashboardDisplaySettings, value: bool) {
        match self {
            Self::MenuShowStatusBadge => settings.menu_show_status_badge = value,
            Self::MenuShowCurrentBadge => settings.menu_show_current_badge = value,
            Self::MenuShowLastUsed => settings.menu_show_last_used = value,
            Self::MenuShowQuotaSummary => settings.menu_show_quota_summary = value,
            Self::MenuShowQuotaCooldown => settings.menu_show_quota_cooldown = value,
            Self::MenuShowFetchStatus => settings.menu_show_fetch_status = value,
            Self::MenuHighlightCurrentRow => settings.menu_highlight_current_row = value,
            Self::MenuSortEnabled => settings.menu_sort_enabled = value,
            Self::MenuSortPinCurrent => settings.menu_sort_pin_current = value,
            Self::MenuSortQuickSwitchVisibleRow => {
                settings.menu_sort_quick_switch_visible_row = value
            }
            Self::MenuShowDetailsForUnselectedRows => {
                settings.menu_show_details_for_unselected_rows = value
            }
        }
    }

    pub fn as_preview_focus(self) -> PreviewFocusKey {
        match self {
            Self::MenuShowStatusBadge => PreviewFocusKey::MenuShowStatusBadge,
            Self::MenuShowCurrentBadge => PreviewFocusKey::MenuShowCurrentBadge,
            Self::MenuShowLastUsed => PreviewFocusKey::MenuShowLastUsed,
            Self::MenuShowQuotaSummary => PreviewFocusKey::MenuShowQuotaSummary,
            Self::MenuShowQuotaCooldown => PreviewFocusKey::MenuShowQuotaCooldown,
            Self::MenuShowFetchStatus => PreviewFocusKey::MenuShowFetchStatus,
            Self::MenuHighlightCurrentRow => PreviewFocusKey::MenuHighlightCurrentRow,
            Self::MenuSortEnabled => PreviewFocusKey::MenuSortEnabled,
            Self::MenuSortPinCurrent => PreviewFocusKey::MenuSortPinCurrent,
            Self::MenuSortQuickSwitchVisibleRow => PreviewFocusKey::MenuSortQuickSwitchVisibleRow,
            Self::MenuShowDetailsForUnselectedRows => {
                PreviewFocusKey::MenuShowDetailsForUnselectedRows
            }
        }
    }
}

/// One row of `DASHBOARD_DISPLAY_OPTIONS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DashboardDisplaySettingOption {
    pub key: DashboardDisplaySettingKey,
    pub label: &'static str,
    pub description: &'static str,
}

/// `DASHBOARD_DISPLAY_OPTIONS` (11 entries; order drives numeric hotkeys).
pub const DASHBOARD_DISPLAY_OPTIONS: [DashboardDisplaySettingOption; 10] = [
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuShowStatusBadge,
        label: "Show Status Badges",
        description: "Show [ok], [active], and similar badges.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuShowCurrentBadge,
        label: "Show [current]",
        description: "Mark the account active in Codex.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuShowLastUsed,
        label: "Show Last Used",
        description: "Show relative usage like 'today'.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuShowQuotaSummary,
        label: "Show Limits (5h / 7d)",
        description: "Show limit bars in each row.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuShowQuotaCooldown,
        label: "Show Limit Cooldowns",
        description: "Show reset timers next to 5h/7d bars.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuShowFetchStatus,
        label: "Show Fetch Status",
        description: "Show background limit refresh status in the menu subtitle.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuHighlightCurrentRow,
        label: "Highlight Current Row",
        description: "Use stronger color on the current row.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuSortEnabled,
        label: "Enable Smart Sort",
        description: "Sort accounts by readiness (view only).",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuSortPinCurrent,
        label: "Pin [current] when tied",
        description: "Keep current at top only when it is equally ready.",
    },
    DashboardDisplaySettingOption {
        key: DashboardDisplaySettingKey::MenuSortQuickSwitchVisibleRow,
        label: "Quick Switch Uses Visible Rows",
        description: "Number keys (1-9) follow what you see in the list.",
    },
];

/// One row of `STATUSLINE_FIELD_OPTIONS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatuslineFieldOption {
    pub key: DashboardStatuslineField,
    pub label: &'static str,
    pub description: &'static str,
}

pub const STATUSLINE_FIELD_OPTIONS: [StatuslineFieldOption; 3] = [
    StatuslineFieldOption {
        key: DashboardStatuslineField::LastUsed,
        label: "Show Last Used",
        description: "Example: 'today' or '2d ago'.",
    },
    StatuslineFieldOption {
        key: DashboardStatuslineField::Limits,
        label: "Show Limits (5h / 7d)",
        description: "Uses cached limit data from checks.",
    },
    StatuslineFieldOption {
        key: DashboardStatuslineField::Status,
        label: "Show Status Text",
        description: "Visible when badges are hidden.",
    },
];

pub const AUTO_RETURN_OPTIONS_MS: [i64; 3] = [1_000, 2_000, 4_000];
pub const MENU_QUOTA_TTL_OPTIONS_MS: [i64; 3] = [60_000, 5 * 60_000, 10 * 60_000];
pub const THEME_PRESET_OPTIONS: [DashboardThemePreset; 2] =
    [DashboardThemePreset::Green, DashboardThemePreset::Blue];
pub const ACCENT_COLOR_OPTIONS: [DashboardAccentColor; 4] = [
    DashboardAccentColor::Green,
    DashboardAccentColor::Cyan,
    DashboardAccentColor::Blue,
    DashboardAccentColor::Yellow,
];

/// `ACCOUNT_LIST_PANEL_KEYS` (13 keys — persist/merge/reset scope).
pub const ACCOUNT_LIST_PANEL_KEYS: [DashboardSettingKey; 13] = [
    DashboardSettingKey::MenuShowStatusBadge,
    DashboardSettingKey::MenuShowCurrentBadge,
    DashboardSettingKey::MenuShowLastUsed,
    DashboardSettingKey::MenuShowQuotaSummary,
    DashboardSettingKey::MenuShowQuotaCooldown,
    DashboardSettingKey::MenuShowFetchStatus,
    DashboardSettingKey::MenuShowDetailsForUnselectedRows,
    DashboardSettingKey::MenuHighlightCurrentRow,
    DashboardSettingKey::MenuSortEnabled,
    DashboardSettingKey::MenuSortMode,
    DashboardSettingKey::MenuSortPinCurrent,
    DashboardSettingKey::MenuSortQuickSwitchVisibleRow,
    DashboardSettingKey::MenuLayoutMode,
];

pub const STATUSLINE_PANEL_KEYS: [DashboardSettingKey; 1] =
    [DashboardSettingKey::MenuStatuslineFields];

/// `BEHAVIOR_PANEL_KEYS` — note `menuShowFetchStatus` is in BOTH the
/// account-list and behavior scopes (spec 09 gotcha 21).
pub const BEHAVIOR_PANEL_KEYS: [DashboardSettingKey; 5] = [
    DashboardSettingKey::ActionAutoReturnMs,
    DashboardSettingKey::ActionPauseOnKey,
    DashboardSettingKey::MenuAutoFetchLimits,
    DashboardSettingKey::MenuShowFetchStatus,
    DashboardSettingKey::MenuQuotaTtlMs,
];

pub const THEME_PANEL_KEYS: [DashboardSettingKey; 2] = [
    DashboardSettingKey::UiThemePreset,
    DashboardSettingKey::UiAccentColor,
];

// ---------------------------------------------------------------------------
// Account-list display panel (`dashboard-display-panel.ts`)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DashboardConfigAction {
    Toggle(DashboardDisplaySettingKey),
    CycleSortMode,
    CycleLayoutMode,
    Reset,
    Save,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PanelFocus {
    Key(DashboardDisplaySettingKey),
    SortMode,
    LayoutMode,
}

impl PanelFocus {
    fn as_preview_focus(self) -> PreviewFocusKey {
        match self {
            PanelFocus::Key(key) => key.as_preview_focus(),
            PanelFocus::SortMode => PreviewFocusKey::MenuSortMode,
            PanelFocus::LayoutMode => PreviewFocusKey::MenuLayoutMode,
        }
    }
}

/// `promptDashboardDisplayPanel` — `None` on cancel/non-TTY, the draft on
/// save.
// The focus re-read after `select` mirrors the TS mutable-cursor pattern
// (same rationale as `select.rs`); some arms overwrite it, tripping the lint.
#[allow(unused_assignments)]
pub fn prompt_dashboard_display_panel(
    initial: &DashboardDisplaySettings,
) -> Option<DashboardDisplaySettings> {
    if !is_tty_interactive() {
        return None;
    }
    let ui = get_ui_runtime_options();
    let mut draft = clone_dashboard_settings(initial);
    let mut focus = PanelFocus::Key(DASHBOARD_DISPLAY_OPTIONS[0].key);

    loop {
        let preview = build_account_list_preview(
            &draft,
            &ui,
            &resolve_menu_layout_mode,
            Some(focus.as_preview_focus()),
        );
        let mut items: Vec<MenuItem<DashboardConfigAction>> = vec![
            MenuItem::heading(
                ui_copy::settings::PREVIEW_HEADING,
                DashboardConfigAction::Cancel,
            ),
            {
                let mut item = MenuItem::new(preview.label.clone(), DashboardConfigAction::Cancel)
                    .with_hint(preview.hint.clone())
                    .with_color(MenuColor::Green);
                item.disabled = true;
                item.hide_unavailable_suffix = true;
                item
            },
            MenuItem::separator(DashboardConfigAction::Cancel),
            MenuItem::heading(
                ui_copy::settings::DISPLAY_HEADING,
                DashboardConfigAction::Cancel,
            ),
        ];
        for (index, option) in DASHBOARD_DISPLAY_OPTIONS.iter().enumerate() {
            let enabled = option.key.get(&draft);
            items.push(
                MenuItem::new(
                    format!(
                        "{} {}. {}",
                        format_dashboard_setting_state(enabled),
                        index + 1,
                        option.label
                    ),
                    DashboardConfigAction::Toggle(option.key),
                )
                .with_hint(option.description)
                .with_color(if enabled {
                    MenuColor::Green
                } else {
                    MenuColor::Yellow
                }),
            );
        }
        let sort_mode = draft.menu_sort_mode;
        items.push(
            MenuItem::new(
                format!("Sort mode: {}", format_menu_sort_mode(sort_mode)),
                DashboardConfigAction::CycleSortMode,
            )
            .with_hint("Applies when smart sort is enabled.")
            .with_color(if sort_mode == DashboardAccountSortMode::ReadyFirst {
                MenuColor::Green
            } else {
                MenuColor::Yellow
            }),
        );
        let layout_mode = resolve_menu_layout_mode(&draft);
        items.push(
            MenuItem::new(
                format!("Layout: {}", format_menu_layout_mode(layout_mode)),
                DashboardConfigAction::CycleLayoutMode,
            )
            .with_hint("Compact shows one-line rows with a selected details pane.")
            .with_color(if layout_mode == DashboardLayoutMode::CompactDetails {
                MenuColor::Green
            } else {
                MenuColor::Yellow
            }),
        );
        items.push(MenuItem::separator(DashboardConfigAction::Cancel));
        items.push(
            MenuItem::new(ui_copy::settings::RESET_DEFAULT, DashboardConfigAction::Reset)
                .with_color(MenuColor::Yellow),
        );
        items.push(
            MenuItem::new(ui_copy::settings::SAVE_AND_BACK, DashboardConfigAction::Save)
                .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(ui_copy::settings::BACK_NO_SAVE, DashboardConfigAction::Cancel)
                .with_color(MenuColor::Red),
        );

        let initial_cursor = items.iter().position(|item| match (&item.value, focus) {
            (DashboardConfigAction::Toggle(key), PanelFocus::Key(focus_key)) => *key == focus_key,
            (DashboardConfigAction::CycleSortMode, PanelFocus::SortMode) => true,
            (DashboardConfigAction::CycleLayoutMode, PanelFocus::LayoutMode) => true,
            _ => false,
        });

        let focus_cell: RefCell<PanelFocus> = RefCell::new(focus);
        let focus_ref = &focus_cell;

        let mut options: SelectOptions<'_, DashboardConfigAction> =
            SelectOptions::new(ui_copy::settings::ACCOUNT_LIST_TITLE);
        options.subtitle = Some(ui_copy::settings::ACCOUNT_LIST_SUBTITLE.to_string());
        options.help = Some(ui_copy::settings::ACCOUNT_LIST_HELP.to_string());
        options.clear_screen = true;
        options.theme = Some(ui.theme.clone());
        options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
        options.initial_cursor = initial_cursor.map(|cursor| cursor as i64);
        // NOTE: the TS panel live-rewrites the preview row's label/hint inside
        // onCursorChange; the Rust select API exposes items immutably in
        // callbacks, so the preview refreshes on the next render loop instead
        // (recorded deviation — visual only).
        options.on_cursor_change = Some(Box::new(move |ctx| {
            match ctx.items.get(ctx.cursor).map(|item| &item.value) {
                Some(DashboardConfigAction::Toggle(key)) => {
                    *focus_ref.borrow_mut() = PanelFocus::Key(*key);
                }
                Some(DashboardConfigAction::CycleSortMode) => {
                    *focus_ref.borrow_mut() = PanelFocus::SortMode;
                }
                Some(DashboardConfigAction::CycleLayoutMode) => {
                    *focus_ref.borrow_mut() = PanelFocus::LayoutMode;
                }
                _ => {}
            }
        }));
        options.on_input = Some(Box::new(|raw, _ctx| {
            let lower = raw.to_lowercase();
            match lower.as_str() {
                "q" => return SelectInputResult::Finish(Some(DashboardConfigAction::Cancel)),
                "s" => return SelectInputResult::Finish(Some(DashboardConfigAction::Save)),
                "r" => return SelectInputResult::Finish(Some(DashboardConfigAction::Reset)),
                "m" => {
                    return SelectInputResult::Finish(Some(DashboardConfigAction::CycleSortMode))
                }
                "l" => {
                    return SelectInputResult::Finish(Some(DashboardConfigAction::CycleLayoutMode))
                }
                _ => {}
            }
            if let Ok(parsed) = raw.trim().parse::<usize>() {
                if parsed >= 1 && parsed <= DASHBOARD_DISPLAY_OPTIONS.len() {
                    return SelectInputResult::Finish(Some(DashboardConfigAction::Toggle(
                        DASHBOARD_DISPLAY_OPTIONS[parsed - 1].key,
                    )));
                }
                if parsed == DASHBOARD_DISPLAY_OPTIONS.len() + 1 {
                    return SelectInputResult::Finish(Some(DashboardConfigAction::CycleSortMode));
                }
                if parsed == DASHBOARD_DISPLAY_OPTIONS.len() + 2 {
                    return SelectInputResult::Finish(Some(
                        DashboardConfigAction::CycleLayoutMode,
                    ));
                }
            }
            SelectInputResult::Ignored
        }));

        let result = select(&items, options).ok().flatten();
        focus = *focus_cell.borrow();

        let result = result?;
        match result {
            DashboardConfigAction::Cancel => return None,
            DashboardConfigAction::Save => return Some(draft),
            DashboardConfigAction::Reset => {
                draft = apply_dashboard_defaults_for_keys(&draft, &ACCOUNT_LIST_PANEL_KEYS);
                focus = PanelFocus::Key(DASHBOARD_DISPLAY_OPTIONS[0].key);
            }
            DashboardConfigAction::CycleSortMode => {
                let next_mode = match draft.menu_sort_mode {
                    DashboardAccountSortMode::ReadyFirst => DashboardAccountSortMode::Manual,
                    DashboardAccountSortMode::Manual => DashboardAccountSortMode::ReadyFirst,
                };
                draft.menu_sort_mode = next_mode;
                if next_mode == DashboardAccountSortMode::ReadyFirst {
                    // Selecting ready-first FORCES smart sort on.
                    draft.menu_sort_enabled = true;
                }
                focus = PanelFocus::SortMode;
            }
            DashboardConfigAction::CycleLayoutMode => {
                let next_layout = match resolve_menu_layout_mode(&draft) {
                    DashboardLayoutMode::CompactDetails => DashboardLayoutMode::ExpandedRows,
                    DashboardLayoutMode::ExpandedRows => DashboardLayoutMode::CompactDetails,
                };
                draft.menu_layout_mode = next_layout;
                draft.menu_show_details_for_unselected_rows =
                    next_layout == DashboardLayoutMode::ExpandedRows;
                focus = PanelFocus::LayoutMode;
            }
            DashboardConfigAction::Toggle(key) => {
                focus = PanelFocus::Key(key);
                let current = key.get(&draft);
                key.set(&mut draft, !current);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Controllers (`dashboard-settings-controller.ts`)
// ---------------------------------------------------------------------------

async fn configure_dashboard_settings_with(
    current_settings: Option<&DashboardDisplaySettings>,
    prompt: impl Fn(&DashboardDisplaySettings) -> Option<DashboardDisplaySettings>,
    keys: &[DashboardSettingKey],
    scope: &str,
) -> DashboardDisplaySettings {
    let current = match current_settings {
        Some(settings) => settings.clone(),
        None => load_dashboard_display_settings().await,
    };
    if !is_tty_interactive() {
        println!("Settings require interactive mode.");
        println!(
            "Settings file: {}",
            get_dashboard_settings_path().to_string_lossy()
        );
        return current;
    }
    let Some(selected) = prompt(&current) else {
        return current;
    };
    if dashboard_settings_equal(&current, &selected) {
        return current;
    }
    let merged = persist_dashboard_settings_selection(&selected, keys, scope).await;
    apply_ui_theme_from_dashboard_settings(&merged);
    merged
}

/// `configureDashboardDisplaySettings(currentSettings?)`.
pub async fn configure_dashboard_display_settings(
    current_settings: Option<&DashboardDisplaySettings>,
) -> DashboardDisplaySettings {
    configure_dashboard_settings_with(
        current_settings,
        prompt_dashboard_display_panel,
        &ACCOUNT_LIST_PANEL_KEYS,
        "account-list",
    )
    .await
}

/// `configureStatuslineSettings(currentSettings?)`.
pub async fn configure_statusline_settings(
    current_settings: Option<&DashboardDisplaySettings>,
) -> DashboardDisplaySettings {
    configure_dashboard_settings_with(
        current_settings,
        crate::settings::panels::prompt_statusline_settings_panel,
        &STATUSLINE_PANEL_KEYS,
        "summary-fields",
    )
    .await
}

/// `promptBehaviorSettings(initial)` — thin wiring over the behavior panel.
pub fn prompt_behavior_settings(
    initial: &DashboardDisplaySettings,
) -> Option<DashboardDisplaySettings> {
    crate::settings::panels::prompt_behavior_settings_panel(initial)
}

/// `promptThemeSettings(initial)` — thin wiring over the theme panel.
pub fn prompt_theme_settings(
    initial: &DashboardDisplaySettings,
) -> Option<DashboardDisplaySettings> {
    crate::settings::panels::prompt_theme_settings_panel(initial)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_tables_are_copy_exact_and_ordered() {
        assert_eq!(DASHBOARD_DISPLAY_OPTIONS.len(), 10);
        assert_eq!(DASHBOARD_DISPLAY_OPTIONS[0].label, "Show Status Badges");
        assert_eq!(
            DASHBOARD_DISPLAY_OPTIONS[9].label,
            "Quick Switch Uses Visible Rows"
        );
        assert_eq!(
            DASHBOARD_DISPLAY_OPTIONS[8].description,
            "Keep current at top only when it is equally ready."
        );
        assert_eq!(STATUSLINE_FIELD_OPTIONS.len(), 3);
        assert_eq!(AUTO_RETURN_OPTIONS_MS, [1_000, 2_000, 4_000]);
        assert_eq!(MENU_QUOTA_TTL_OPTIONS_MS, [60_000, 300_000, 600_000]);
    }

    #[test]
    fn panel_key_sets_have_the_documented_scopes() {
        assert_eq!(ACCOUNT_LIST_PANEL_KEYS.len(), 13);
        assert_eq!(STATUSLINE_PANEL_KEYS.len(), 1);
        assert_eq!(BEHAVIOR_PANEL_KEYS.len(), 5);
        assert_eq!(THEME_PANEL_KEYS.len(), 2);
        // menuShowFetchStatus is in BOTH the account-list and behavior scopes.
        assert!(ACCOUNT_LIST_PANEL_KEYS.contains(&DashboardSettingKey::MenuShowFetchStatus));
        assert!(BEHAVIOR_PANEL_KEYS.contains(&DashboardSettingKey::MenuShowFetchStatus));
        // The layout cycle owns both the mode and the legacy boolean.
        assert!(
            ACCOUNT_LIST_PANEL_KEYS.contains(&DashboardSettingKey::MenuShowDetailsForUnselectedRows)
        );
        assert!(ACCOUNT_LIST_PANEL_KEYS.contains(&DashboardSettingKey::MenuLayoutMode));
    }

    #[test]
    fn toggle_key_accessors_round_trip() {
        let mut settings = DashboardDisplaySettings::default();
        assert!(DashboardDisplaySettingKey::MenuShowStatusBadge.get(&settings));
        DashboardDisplaySettingKey::MenuShowStatusBadge.set(&mut settings, false);
        assert!(!settings.menu_show_status_badge);
    }
}
