//! Port of `settings-panels.ts` + `behavior-settings-panel.ts` +
//! `statusline-settings-panel.ts` + `theme-settings-panel.ts` (entry shims
//! absorbed) — the remaining interactive settings panels.
//!
//! Shared panel contract (spec 09 §5.10): TTY-gate (`None` when not fully
//! TTY), clone-into-draft, `select` loop with `clearScreen`, focus restored
//! via `initialCursor`, and: `None` on cancel (`q`/escape/null), the draft on
//! save (`s`), reset (`r`) re-applies the panel's key-set defaults. The theme
//! panel applies theme changes LIVE and restores the baseline on cancel.

use std::cell::RefCell;

use cma_config::dashboard_settings::{
    DashboardAccentColor, DashboardDisplaySettings, DashboardStatuslineField, DashboardThemePreset,
};
use cma_tui::runtime_options::get_ui_runtime_options;
use cma_tui::select::{select, MenuColor, MenuItem, SelectInputResult, SelectOptions};
use cma_tui::ui_copy;

use crate::settings::dashboard::{
    ACCENT_COLOR_OPTIONS, AUTO_RETURN_OPTIONS_MS, BEHAVIOR_PANEL_KEYS, MENU_QUOTA_TTL_OPTIONS_MS,
    STATUSLINE_FIELD_OPTIONS, STATUSLINE_PANEL_KEYS, THEME_PANEL_KEYS, THEME_PRESET_OPTIONS,
};
use crate::settings::hub::{
    apply_dashboard_defaults_for_keys, apply_ui_theme_from_dashboard_settings,
    clone_dashboard_settings, format_dashboard_setting_state, format_menu_quota_ttl,
    is_tty_interactive, resolve_menu_layout_mode,
};
use crate::settings::preview::{
    build_account_list_preview, normalize_statusline_fields, PreviewFocusKey,
};

// ---------------------------------------------------------------------------
// Pure helpers (`settings-panels.ts`)
// ---------------------------------------------------------------------------

/// `reorderStatuslineField(fields, key, direction)` — swap with the
/// neighbor; out-of-range or missing → the input unchanged.
pub fn reorder_statusline_field(
    fields: &[DashboardStatuslineField],
    key: DashboardStatuslineField,
    direction: i32,
) -> Vec<DashboardStatuslineField> {
    let Some(index) = fields.iter().position(|field| *field == key) else {
        return fields.to_vec();
    };
    let target = index as i64 + direction as i64;
    if target < 0 || target >= fields.len() as i64 {
        return fields.to_vec();
    }
    let mut next = fields.to_vec();
    next.swap(index, target as usize);
    next
}

/// `formatAutoReturnDelayLabel(delayMs)` — `<= 0` → `"Instant return"`, else
/// `"<round(ms/1000)>s auto-return"`.
pub fn format_auto_return_delay_label(delay_ms: i64) -> String {
    if delay_ms <= 0 {
        "Instant return".to_string()
    } else {
        format!("{}s auto-return", ((delay_ms as f64) / 1000.0).round() as i64)
    }
}

// ---------------------------------------------------------------------------
// Behavior panel (`behavior-settings-panel.ts`)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BehaviorConfigAction {
    SetDelay(i64),
    TogglePause,
    ToggleMenuLimitFetch,
    ToggleMenuFetchStatus,
    SetMenuQuotaTtl(i64),
    Reset,
    Save,
    Cancel,
}

/// `promptBehaviorSettingsPanel`.
// The focus re-read after `select` mirrors the TS mutable-cursor pattern
// (same rationale as `select.rs`); some arms overwrite it, tripping the lint.
#[allow(unused_assignments)]
pub fn prompt_behavior_settings_panel(
    initial: &DashboardDisplaySettings,
) -> Option<DashboardDisplaySettings> {
    if !is_tty_interactive() {
        return None;
    }
    let ui = get_ui_runtime_options();
    let mut draft = clone_dashboard_settings(initial);
    let mut focus = BehaviorConfigAction::SetDelay(draft.action_auto_return_ms);

    loop {
        let current_delay = draft.action_auto_return_ms;
        let pause_on_key = draft.action_pause_on_key;
        let auto_fetch_limits = draft.menu_auto_fetch_limits;
        let fetch_status_visible = draft.menu_show_fetch_status;
        let menu_quota_ttl_ms = draft.menu_quota_ttl_ms;

        let mut items: Vec<MenuItem<BehaviorConfigAction>> = vec![MenuItem::heading(
            ui_copy::settings::ACTION_TIMING,
            BehaviorConfigAction::Cancel,
        )];
        for delay_ms in AUTO_RETURN_OPTIONS_MS {
            let selected = current_delay == delay_ms;
            items.push(
                MenuItem::new(
                    format!(
                        "{} {}",
                        if selected { "[x]" } else { "[ ]" },
                        format_auto_return_delay_label(delay_ms)
                    ),
                    BehaviorConfigAction::SetDelay(delay_ms),
                )
                .with_hint(match delay_ms {
                    1_000 => "Fastest loop for frequent actions.",
                    2_000 => "Balanced default for most users.",
                    _ => "More time to read action output.",
                })
                .with_color(if selected {
                    MenuColor::Green
                } else {
                    MenuColor::Yellow
                }),
            );
        }
        items.push(MenuItem::separator(BehaviorConfigAction::Cancel));
        items.push(
            MenuItem::new(
                format!(
                    "{} Pause on key press",
                    if pause_on_key { "[x]" } else { "[ ]" }
                ),
                BehaviorConfigAction::TogglePause,
            )
            .with_hint("Press any key to stop auto-return.")
            .with_color(if pause_on_key {
                MenuColor::Green
            } else {
                MenuColor::Yellow
            }),
        );
        items.push(
            MenuItem::new(
                format!(
                    "{} Auto-fetch limits on menu open (5m cache)",
                    if auto_fetch_limits { "[x]" } else { "[ ]" }
                ),
                BehaviorConfigAction::ToggleMenuLimitFetch,
            )
            .with_hint("Refreshes account limits automatically when opening the menu.")
            .with_color(if auto_fetch_limits {
                MenuColor::Green
            } else {
                MenuColor::Yellow
            }),
        );
        items.push(
            MenuItem::new(
                format!(
                    "{} Show limit refresh status",
                    if fetch_status_visible { "[x]" } else { "[ ]" }
                ),
                BehaviorConfigAction::ToggleMenuFetchStatus,
            )
            .with_hint("Shows background fetch progress like [2/7] in menu subtitle.")
            .with_color(if fetch_status_visible {
                MenuColor::Green
            } else {
                MenuColor::Yellow
            }),
        );
        items.push(
            MenuItem::new(
                format!(
                    "Limit cache TTL: {}",
                    format_menu_quota_ttl(menu_quota_ttl_ms)
                ),
                BehaviorConfigAction::SetMenuQuotaTtl(menu_quota_ttl_ms),
            )
            .with_hint("How fresh cached quota data must be before refresh runs.")
            .with_color(MenuColor::Yellow),
        );
        items.push(MenuItem::separator(BehaviorConfigAction::Cancel));
        items.push(
            MenuItem::new(ui_copy::settings::RESET_DEFAULT, BehaviorConfigAction::Reset)
                .with_color(MenuColor::Yellow),
        );
        items.push(
            MenuItem::new(ui_copy::settings::SAVE_AND_BACK, BehaviorConfigAction::Save)
                .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(ui_copy::settings::BACK_NO_SAVE, BehaviorConfigAction::Cancel)
                .with_color(MenuColor::Red),
        );

        let initial_cursor = items.iter().position(|item| item.value == focus);

        let focus_cell: RefCell<BehaviorConfigAction> = RefCell::new(focus);
        let focus_ref = &focus_cell;

        let mut options: SelectOptions<'_, BehaviorConfigAction> =
            SelectOptions::new(ui_copy::settings::BEHAVIOR_TITLE);
        options.subtitle = Some(ui_copy::settings::BEHAVIOR_SUBTITLE.to_string());
        options.help = Some(ui_copy::settings::BEHAVIOR_HELP.to_string());
        options.clear_screen = true;
        options.theme = Some(ui.theme.clone());
        options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
        options.initial_cursor = initial_cursor.map(|cursor| cursor as i64);
        options.on_cursor_change = Some(Box::new(move |ctx| {
            if let Some(item) = ctx.items.get(ctx.cursor)
                && !item.separator && !item.heading {
                    *focus_ref.borrow_mut() = item.value;
                }
        }));
        options.on_input = Some(Box::new(move |raw, _ctx| {
            let lower = raw.to_lowercase();
            match lower.as_str() {
                "q" => return SelectInputResult::Finish(Some(BehaviorConfigAction::Cancel)),
                "s" => return SelectInputResult::Finish(Some(BehaviorConfigAction::Save)),
                "r" => return SelectInputResult::Finish(Some(BehaviorConfigAction::Reset)),
                "p" => return SelectInputResult::Finish(Some(BehaviorConfigAction::TogglePause)),
                "l" => {
                    return SelectInputResult::Finish(Some(
                        BehaviorConfigAction::ToggleMenuLimitFetch,
                    ))
                }
                "f" => {
                    return SelectInputResult::Finish(Some(
                        BehaviorConfigAction::ToggleMenuFetchStatus,
                    ))
                }
                "t" => {
                    return SelectInputResult::Finish(Some(BehaviorConfigAction::SetMenuQuotaTtl(
                        menu_quota_ttl_ms,
                    )))
                }
                _ => {}
            }
            if let Ok(parsed) = raw.trim().parse::<usize>()
                && parsed >= 1 && parsed <= AUTO_RETURN_OPTIONS_MS.len() {
                    return SelectInputResult::Finish(Some(BehaviorConfigAction::SetDelay(
                        AUTO_RETURN_OPTIONS_MS[parsed - 1],
                    )));
                }
            SelectInputResult::Ignored
        }));

        let result = select(&items, options).ok().flatten();
        focus = *focus_cell.borrow();

        let result = result?;
        match result {
            BehaviorConfigAction::Cancel => return None,
            BehaviorConfigAction::Save => return Some(draft),
            BehaviorConfigAction::Reset => {
                draft = apply_dashboard_defaults_for_keys(&draft, &BEHAVIOR_PANEL_KEYS);
                focus = BehaviorConfigAction::SetDelay(draft.action_auto_return_ms);
            }
            BehaviorConfigAction::TogglePause => {
                draft.action_pause_on_key = !draft.action_pause_on_key;
                focus = result;
            }
            BehaviorConfigAction::ToggleMenuLimitFetch => {
                draft.menu_auto_fetch_limits = !draft.menu_auto_fetch_limits;
                focus = result;
            }
            BehaviorConfigAction::ToggleMenuFetchStatus => {
                draft.menu_show_fetch_status = !draft.menu_show_fetch_status;
                focus = result;
            }
            BehaviorConfigAction::SetMenuQuotaTtl(_) => {
                let current_index = MENU_QUOTA_TTL_OPTIONS_MS
                    .iter()
                    .position(|value| *value == menu_quota_ttl_ms);
                let next_index = match current_index {
                    None => 0,
                    Some(index) => (index + 1) % MENU_QUOTA_TTL_OPTIONS_MS.len(),
                };
                let next_ttl = MENU_QUOTA_TTL_OPTIONS_MS[next_index];
                draft.menu_quota_ttl_ms = next_ttl;
                focus = BehaviorConfigAction::SetMenuQuotaTtl(next_ttl);
            }
            BehaviorConfigAction::SetDelay(delay_ms) => {
                draft.action_auto_return_ms = delay_ms;
                focus = result;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Statusline panel (`statusline-settings-panel.ts`)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatuslineConfigAction {
    Toggle(DashboardStatuslineField),
    MoveUp(DashboardStatuslineField),
    MoveDown(DashboardStatuslineField),
    Reset,
    Save,
    Cancel,
}

/// `promptStatuslineSettingsPanel` — toggling off the LAST remaining field is
/// prevented (the field set never becomes empty).
// See prompt_behavior_settings_panel for the unused_assignments rationale.
#[allow(unused_assignments)]
pub fn prompt_statusline_settings_panel(
    initial: &DashboardDisplaySettings,
) -> Option<DashboardDisplaySettings> {
    if !is_tty_interactive() {
        return None;
    }
    let ui = get_ui_runtime_options();
    let mut draft = clone_dashboard_settings(initial);
    let mut focus_key = draft
        .menu_statusline_fields
        .first()
        .copied()
        .unwrap_or(DashboardStatuslineField::LastUsed);

    loop {
        let preview = build_account_list_preview(
            &draft,
            &ui,
            &resolve_menu_layout_mode,
            Some(PreviewFocusKey::from_statusline_field(focus_key)),
        );
        let ordered = normalize_statusline_fields(Some(&draft.menu_statusline_fields));

        let mut items: Vec<MenuItem<StatuslineConfigAction>> = vec![
            MenuItem::heading(
                ui_copy::settings::PREVIEW_HEADING,
                StatuslineConfigAction::Cancel,
            ),
            {
                let mut item = MenuItem::new(preview.label.clone(), StatuslineConfigAction::Cancel)
                    .with_hint(preview.hint.clone())
                    .with_color(MenuColor::Green);
                item.disabled = true;
                item.hide_unavailable_suffix = true;
                item
            },
            MenuItem::separator(StatuslineConfigAction::Cancel),
            MenuItem::heading(
                ui_copy::settings::DISPLAY_HEADING,
                StatuslineConfigAction::Cancel,
            ),
        ];
        for (index, option) in STATUSLINE_FIELD_OPTIONS.iter().enumerate() {
            let enabled = ordered.contains(&option.key);
            let rank = ordered.iter().position(|field| *field == option.key);
            let rank_suffix = match rank {
                Some(rank) => format!(" (order {})", rank + 1),
                None => String::new(),
            };
            items.push(
                MenuItem::new(
                    format!(
                        "{} {}. {}{}",
                        format_dashboard_setting_state(enabled),
                        index + 1,
                        option.label,
                        rank_suffix
                    ),
                    StatuslineConfigAction::Toggle(option.key),
                )
                .with_hint(option.description)
                .with_color(if enabled {
                    MenuColor::Green
                } else {
                    MenuColor::Yellow
                }),
            );
        }
        items.push(MenuItem::separator(StatuslineConfigAction::Cancel));
        items.push(
            MenuItem::new(
                ui_copy::settings::MOVE_UP,
                StatuslineConfigAction::MoveUp(focus_key),
            )
            .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(
                ui_copy::settings::MOVE_DOWN,
                StatuslineConfigAction::MoveDown(focus_key),
            )
            .with_color(MenuColor::Green),
        );
        items.push(MenuItem::separator(StatuslineConfigAction::Cancel));
        items.push(
            MenuItem::new(
                ui_copy::settings::RESET_DEFAULT,
                StatuslineConfigAction::Reset,
            )
            .with_color(MenuColor::Yellow),
        );
        items.push(
            MenuItem::new(ui_copy::settings::SAVE_AND_BACK, StatuslineConfigAction::Save)
                .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(ui_copy::settings::BACK_NO_SAVE, StatuslineConfigAction::Cancel)
                .with_color(MenuColor::Red),
        );

        let initial_cursor = items.iter().position(
            |item| matches!(item.value, StatuslineConfigAction::Toggle(key) if key == focus_key),
        );

        let focus_cell: RefCell<DashboardStatuslineField> = RefCell::new(focus_key);
        let focus_for_cursor = &focus_cell;
        let focus_for_input = &focus_cell;

        let mut options: SelectOptions<'_, StatuslineConfigAction> =
            SelectOptions::new(ui_copy::settings::SUMMARY_TITLE);
        options.subtitle = Some(ui_copy::settings::SUMMARY_SUBTITLE.to_string());
        options.help = Some(ui_copy::settings::SUMMARY_HELP.to_string());
        options.clear_screen = true;
        options.theme = Some(ui.theme.clone());
        options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
        options.initial_cursor = initial_cursor.map(|cursor| cursor as i64);
        options.on_cursor_change = Some(Box::new(move |ctx| {
            if let Some(StatuslineConfigAction::Toggle(key)) =
                ctx.items.get(ctx.cursor).map(|item| item.value)
            {
                *focus_for_cursor.borrow_mut() = key;
            }
        }));
        options.on_input = Some(Box::new(move |raw, _ctx| {
            let lower = raw.to_lowercase();
            match lower.as_str() {
                "q" => return SelectInputResult::Finish(Some(StatuslineConfigAction::Cancel)),
                "s" => return SelectInputResult::Finish(Some(StatuslineConfigAction::Save)),
                "r" => return SelectInputResult::Finish(Some(StatuslineConfigAction::Reset)),
                "[" => {
                    return SelectInputResult::Finish(Some(StatuslineConfigAction::MoveUp(
                        *focus_for_input.borrow(),
                    )))
                }
                "]" => {
                    return SelectInputResult::Finish(Some(StatuslineConfigAction::MoveDown(
                        *focus_for_input.borrow(),
                    )))
                }
                _ => {}
            }
            if let Ok(parsed) = raw.trim().parse::<usize>()
                && parsed >= 1 && parsed <= STATUSLINE_FIELD_OPTIONS.len() {
                    return SelectInputResult::Finish(Some(StatuslineConfigAction::Toggle(
                        STATUSLINE_FIELD_OPTIONS[parsed - 1].key,
                    )));
                }
            SelectInputResult::Ignored
        }));

        let result = select(&items, options).ok().flatten();
        focus_key = *focus_cell.borrow();

        let result = result?;
        match result {
            StatuslineConfigAction::Cancel => return None,
            StatuslineConfigAction::Save => return Some(draft),
            StatuslineConfigAction::Reset => {
                draft = apply_dashboard_defaults_for_keys(&draft, &STATUSLINE_PANEL_KEYS);
                focus_key = draft
                    .menu_statusline_fields
                    .first()
                    .copied()
                    .unwrap_or(DashboardStatuslineField::LastUsed);
            }
            StatuslineConfigAction::MoveUp(key) => {
                let fields = normalize_statusline_fields(Some(&draft.menu_statusline_fields));
                draft.menu_statusline_fields = reorder_statusline_field(&fields, key, -1);
                focus_key = key;
            }
            StatuslineConfigAction::MoveDown(key) => {
                let fields = normalize_statusline_fields(Some(&draft.menu_statusline_fields));
                draft.menu_statusline_fields = reorder_statusline_field(&fields, key, 1);
                focus_key = key;
            }
            StatuslineConfigAction::Toggle(key) => {
                focus_key = key;
                let fields = normalize_statusline_fields(Some(&draft.menu_statusline_fields));
                if fields.contains(&key) {
                    let next: Vec<_> =
                        fields.iter().copied().filter(|field| *field != key).collect();
                    draft.menu_statusline_fields =
                        if next.is_empty() { vec![key] } else { next };
                } else {
                    let mut next = fields;
                    next.push(key);
                    draft.menu_statusline_fields = next;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Theme panel (`theme-settings-panel.ts`)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThemeConfigAction {
    SetPalette(DashboardThemePreset),
    SetAccent(DashboardAccentColor),
    Reset,
    Save,
    Cancel,
}

/// `promptThemeSettingsPanel` — every palette/accent/reset change applies the
/// theme LIVE; cancel restores the baseline theme before returning `None`.
// See prompt_behavior_settings_panel for the unused_assignments rationale.
#[allow(unused_assignments)]
pub fn prompt_theme_settings_panel(
    initial: &DashboardDisplaySettings,
) -> Option<DashboardDisplaySettings> {
    if !is_tty_interactive() {
        return None;
    }
    let baseline = clone_dashboard_settings(initial);
    let mut draft = clone_dashboard_settings(initial);
    let mut focus = ThemeConfigAction::SetPalette(draft.ui_theme_preset);

    loop {
        // Re-read every iteration so the menu renders in the just-applied
        // theme.
        let ui = get_ui_runtime_options();
        let palette = draft.ui_theme_preset;
        let accent = draft.ui_accent_color;

        let mut items: Vec<MenuItem<ThemeConfigAction>> = vec![MenuItem::heading(
            ui_copy::settings::BASE_THEME,
            ThemeConfigAction::Cancel,
        )];
        for (index, candidate) in THEME_PRESET_OPTIONS.iter().enumerate() {
            let selected = palette == *candidate;
            items.push(
                MenuItem::new(
                    format!(
                        "{} {}. {}",
                        if selected { "[x]" } else { "[ ]" },
                        index + 1,
                        match candidate {
                            DashboardThemePreset::Green => "Green base",
                            DashboardThemePreset::Blue => "Blue base",
                        }
                    ),
                    ThemeConfigAction::SetPalette(*candidate),
                )
                .with_hint(match candidate {
                    DashboardThemePreset::Green => "High-contrast default.",
                    DashboardThemePreset::Blue => "Codex-style blue look.",
                })
                .with_color(if selected {
                    MenuColor::Green
                } else {
                    MenuColor::Yellow
                }),
            );
        }
        items.push(MenuItem::separator(ThemeConfigAction::Cancel));
        items.push(MenuItem::heading(
            ui_copy::settings::ACCENT_COLOR,
            ThemeConfigAction::Cancel,
        ));
        for candidate in ACCENT_COLOR_OPTIONS {
            let selected = accent == candidate;
            items.push(
                MenuItem::new(
                    format!(
                        "{} {}",
                        if selected { "[x]" } else { "[ ]" },
                        candidate.as_str()
                    ),
                    ThemeConfigAction::SetAccent(candidate),
                )
                .with_color(if selected {
                    MenuColor::Green
                } else {
                    MenuColor::Yellow
                }),
            );
        }
        items.push(MenuItem::separator(ThemeConfigAction::Cancel));
        items.push(
            MenuItem::new(ui_copy::settings::RESET_DEFAULT, ThemeConfigAction::Reset)
                .with_color(MenuColor::Yellow),
        );
        items.push(
            MenuItem::new(ui_copy::settings::SAVE_AND_BACK, ThemeConfigAction::Save)
                .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(ui_copy::settings::BACK_NO_SAVE, ThemeConfigAction::Cancel)
                .with_color(MenuColor::Red),
        );

        let initial_cursor = items.iter().position(|item| item.value == focus);

        let focus_cell: RefCell<ThemeConfigAction> = RefCell::new(focus);
        let focus_ref = &focus_cell;

        let mut options: SelectOptions<'_, ThemeConfigAction> =
            SelectOptions::new(ui_copy::settings::THEME_TITLE);
        options.subtitle = Some(ui_copy::settings::THEME_SUBTITLE.to_string());
        options.help = Some(ui_copy::settings::THEME_HELP.to_string());
        options.clear_screen = true;
        options.theme = Some(ui.theme.clone());
        options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
        options.initial_cursor = initial_cursor.map(|cursor| cursor as i64);
        options.on_cursor_change = Some(Box::new(move |ctx| {
            if let Some(item) = ctx.items.get(ctx.cursor)
                && !item.separator && !item.heading {
                    *focus_ref.borrow_mut() = item.value;
                }
        }));
        options.on_input = Some(Box::new(|raw, _ctx| {
            let lower = raw.to_lowercase();
            match lower.as_str() {
                "q" => return SelectInputResult::Finish(Some(ThemeConfigAction::Cancel)),
                "s" => return SelectInputResult::Finish(Some(ThemeConfigAction::Save)),
                "r" => return SelectInputResult::Finish(Some(ThemeConfigAction::Reset)),
                _ => {}
            }
            if raw == "1" {
                return SelectInputResult::Finish(Some(ThemeConfigAction::SetPalette(
                    DashboardThemePreset::Green,
                )));
            }
            if raw == "2" {
                return SelectInputResult::Finish(Some(ThemeConfigAction::SetPalette(
                    DashboardThemePreset::Blue,
                )));
            }
            SelectInputResult::Ignored
        }));

        let result = select(&items, options).ok().flatten();
        focus = *focus_cell.borrow();

        let Some(result) = result else {
            apply_ui_theme_from_dashboard_settings(&baseline);
            return None;
        };
        match result {
            ThemeConfigAction::Cancel => {
                apply_ui_theme_from_dashboard_settings(&baseline);
                return None;
            }
            ThemeConfigAction::Save => return Some(draft),
            ThemeConfigAction::Reset => {
                draft = apply_dashboard_defaults_for_keys(&draft, &THEME_PANEL_KEYS);
                focus = ThemeConfigAction::SetPalette(draft.ui_theme_preset);
                apply_ui_theme_from_dashboard_settings(&draft);
            }
            ThemeConfigAction::SetPalette(palette) => {
                draft.ui_theme_preset = palette;
                focus = result;
                apply_ui_theme_from_dashboard_settings(&draft);
            }
            ThemeConfigAction::SetAccent(accent) => {
                draft.ui_accent_color = accent;
                focus = result;
                apply_ui_theme_from_dashboard_settings(&draft);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use DashboardStatuslineField as F;

    #[test]
    fn reorder_swaps_neighbors_and_ignores_out_of_range() {
        let fields = [F::LastUsed, F::Limits, F::Status];
        assert_eq!(
            reorder_statusline_field(&fields, F::Limits, -1),
            vec![F::Limits, F::LastUsed, F::Status]
        );
        assert_eq!(
            reorder_statusline_field(&fields, F::Limits, 1),
            vec![F::LastUsed, F::Status, F::Limits]
        );
        // First item up / last item down → unchanged.
        assert_eq!(
            reorder_statusline_field(&fields, F::LastUsed, -1),
            fields.to_vec()
        );
        assert_eq!(
            reorder_statusline_field(&fields, F::Status, 1),
            fields.to_vec()
        );
        // Missing key → unchanged.
        assert_eq!(
            reorder_statusline_field(&[F::LastUsed], F::Status, 1),
            vec![F::LastUsed]
        );
    }

    #[test]
    fn auto_return_delay_labels() {
        assert_eq!(format_auto_return_delay_label(0), "Instant return");
        assert_eq!(format_auto_return_delay_label(-5), "Instant return");
        assert_eq!(format_auto_return_delay_label(1_000), "1s auto-return");
        assert_eq!(format_auto_return_delay_label(2_000), "2s auto-return");
        assert_eq!(format_auto_return_delay_label(1_500), "2s auto-return");
    }
}
