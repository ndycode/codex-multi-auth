//! Port of `lib/ui/auth-menu.ts` — the stateful accounts dashboard and the
//! per-account details menu (search mode, 1-9 quick switch, confirms).
//!
//! Contracts preserved (spec 12 §10 + gotchas):
//! - duplicate quick-switch numbers: the FIRST account keeps the map slot AND
//!   the digit is fully disabled (pressing it does nothing);
//! - the dashboard re-renders its subtitle every 200 ms via `dynamicSubtitle`
//!   (`status_message` may be a closure returning fresh text);
//! - `?` toggles the detailed-help flag (visible on the next `select` run —
//!   the help text is captured per iteration, bug-compatible with TS);
//! - refused confirms loop instead of returning;
//! - focus is restored across loop iterations via `auth_menu_focus_key`.
//!
//! The item-list builder is exported as a pure function
//! ([`build_auth_menu_items`]) so tests can assert the exact menu structure
//! without a TTY.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, IsTerminal, Write};

pub use crate::ansi::is_tty;
use crate::ansi;
use crate::auth_menu_builder::{
    account_row_color, account_search_text, account_title, auth_menu_focus_key,
    current_marker_label, format_account_hint, format_date, format_relative_time,
    main_menu_title_with_version, status_badge, AccountAction, AccountCurrentMarker, AccountInfo,
    AuthMenuAction, AuthMenuOptions,
};
use crate::confirm::confirm;
use crate::format::{format_ui_badge, paint_ui_text, UiBadgeTone, UiTextTone};
use crate::runtime_options::{get_ui_runtime_options, UiRuntimeOptions};
use crate::select::{
    select, FocusStyle, MenuItem, SelectError, SelectInputResult, SelectOptions,
};
use crate::ui_copy;

/// Readline search prompt: non-TTY returns the current query unchanged;
/// otherwise `Search[ (current)] (blank clears): `, trimmed + lowercased.
fn prompt_search_query(current: &str) -> String {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return current.to_string();
    }
    let suffix = if current.is_empty() {
        String::new()
    } else {
        format!(" ({current})")
    };
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "Search{suffix} (blank clears): ");
    let _ = stdout.flush();
    let mut answer = String::new();
    let _ = std::io::stdin().lock().read_line(&mut answer);
    answer.trim().to_lowercase()
}

/// Pure builder for the dashboard menu structure (headings, quick actions,
/// account rows, danger zone). Exactly mirrors the TS item list.
pub fn build_auth_menu_items(
    visible_accounts: &[AccountInfo],
    verify_label: &str,
    flagged_count: i64,
    ui: &UiRuntimeOptions,
) -> Vec<MenuItem<AuthMenuAction>> {
    let mut items: Vec<MenuItem<AuthMenuAction>> = vec![
        MenuItem::heading(ui_copy::main_menu::QUICK_START, AuthMenuAction::Cancel),
        MenuItem::new(ui_copy::main_menu::ADD_ACCOUNT, AuthMenuAction::Add)
            .with_color(crate::select::MenuColor::Green),
        MenuItem::new(ui_copy::main_menu::CHECK_ACCOUNTS, AuthMenuAction::Check)
            .with_color(crate::select::MenuColor::Green),
        MenuItem::new(ui_copy::main_menu::BEST_ACCOUNT, AuthMenuAction::Forecast)
            .with_color(crate::select::MenuColor::Green),
        MenuItem::new(ui_copy::main_menu::FIX_ISSUES, AuthMenuAction::Fix)
            .with_color(crate::select::MenuColor::Green),
        MenuItem::new(ui_copy::main_menu::SETTINGS, AuthMenuAction::Settings)
            .with_color(crate::select::MenuColor::Green),
        MenuItem::separator(AuthMenuAction::Cancel),
        MenuItem::heading(ui_copy::main_menu::MORE_CHECKS, AuthMenuAction::Cancel),
        MenuItem::new(ui_copy::main_menu::REFRESH_CHECKS, AuthMenuAction::DeepCheck)
            .with_color(crate::select::MenuColor::Green),
        MenuItem::new(verify_label, AuthMenuAction::VerifyFlagged).with_color(
            if flagged_count > 0 {
                crate::select::MenuColor::Red
            } else {
                crate::select::MenuColor::Yellow
            },
        ),
        MenuItem::separator(AuthMenuAction::Cancel),
        MenuItem::heading(ui_copy::main_menu::ACCOUNTS, AuthMenuAction::Cancel),
    ];

    if visible_accounts.is_empty() {
        let mut row = MenuItem::new(ui_copy::main_menu::NO_SEARCH_MATCHES, AuthMenuAction::Cancel);
        row.disabled = true;
        items.push(row);
    } else {
        for account in visible_accounts {
            let current_markers: Vec<AccountCurrentMarker> = account
                .current_markers
                .clone()
                .unwrap_or_else(|| {
                    if account.is_current_account == Some(true) {
                        vec![AccountCurrentMarker::Current]
                    } else {
                        Vec::new()
                    }
                });
            let current_badge = if account.show_current_badge != Some(false) {
                current_markers
                    .iter()
                    .map(|&marker| {
                        if ui.v2_enabled {
                            format!(
                                " {}",
                                format_ui_badge(
                                    ui,
                                    current_marker_label(marker),
                                    if marker == AccountCurrentMarker::Current {
                                        UiBadgeTone::Accent
                                    } else {
                                        UiBadgeTone::Muted
                                    }
                                )
                            )
                        } else {
                            format!(
                                " {}[{}]{}",
                                ansi::CYAN,
                                current_marker_label(marker),
                                ansi::RESET
                            )
                        }
                    })
                    .collect::<String>()
            } else {
                String::new()
            };
            let badge = if account.show_status_badge == Some(false) {
                String::new()
            } else {
                status_badge(account.status)
            };
            let status_suffix = if badge.is_empty() {
                String::new()
            } else {
                format!(" {badge}")
            };
            let title = if ui.v2_enabled {
                paint_ui_text(
                    ui,
                    &account_title(account),
                    if account.is_current_account == Some(true) {
                        UiTextTone::Accent
                    } else {
                        UiTextTone::Heading
                    },
                )
            } else {
                account_title(account)
            };
            let label = format!("{title}{current_badge}{status_suffix}");
            let hint = format_account_hint(account, ui);
            let mut row = MenuItem::new(label, AuthMenuAction::SelectAccount(account.clone()));
            if !hint.is_empty() {
                row.hint = Some(hint);
            }
            row.color = Some(account_row_color(account));
            items.push(row);
        }
    }

    items.push(MenuItem::separator(AuthMenuAction::Cancel));
    items.push(MenuItem::heading(
        ui_copy::main_menu::DANGER_ZONE,
        AuthMenuAction::Cancel,
    ));
    items.push(
        MenuItem::new(
            ui_copy::main_menu::REMOVE_ALL_ACCOUNTS,
            AuthMenuAction::DeleteAll,
        )
        .with_color(crate::select::MenuColor::Red),
    );
    items
}

/// Show the accounts dashboard and return the chosen action. Loops internally
/// on search / refused confirms, exactly like the TS.
// focus-key bookkeeping mirrors the TS assignment order (set before every
// return/continue), which trips the dead-store lint on the final assignment.
#[allow(unused_assignments)]
pub fn show_auth_menu(
    accounts: &[AccountInfo],
    options: &AuthMenuOptions<'_>,
) -> Result<AuthMenuAction, SelectError> {
    let flagged_count = options.flagged_count.unwrap_or(0);
    let verify_label = ui_copy::format_check_flagged_label(flagged_count);
    let ui = get_ui_runtime_options();
    let show_detailed_help = Cell::new(false);
    let mut search_query = String::new();
    let mut focus_key = "action:add".to_string();

    loop {
        let normalized_search = search_query.trim().to_lowercase();
        let visible_accounts: Vec<AccountInfo> = if normalized_search.is_empty() {
            accounts.to_vec()
        } else {
            accounts
                .iter()
                .filter(|account| account_search_text(account).contains(&normalized_search))
                .cloned()
                .collect()
        };
        let mut visible_by_number: HashMap<i64, AccountInfo> = HashMap::new();
        let mut duplicate_quick_switch_numbers: HashSet<i64> = HashSet::new();
        for account in &visible_accounts {
            let quick_switch_number = account.quick_switch_number.unwrap_or(account.index + 1);
            if visible_by_number.contains_key(&quick_switch_number) {
                duplicate_quick_switch_numbers.insert(quick_switch_number);
                continue;
            }
            visible_by_number.insert(quick_switch_number, account.clone());
        }

        let items = build_auth_menu_items(&visible_accounts, &verify_label, flagged_count, &ui);

        let show_hints_for_unselected_rows = visible_accounts
            .first()
            .and_then(|a| a.show_hints_for_unselected_rows)
            .or_else(|| accounts.first().and_then(|a| a.show_hints_for_unselected_rows))
            .unwrap_or(false);
        let focus_style = visible_accounts
            .first()
            .and_then(|a| a.focus_style)
            .or_else(|| accounts.first().and_then(|a| a.focus_style))
            .unwrap_or(FocusStyle::RowInvert);
        let resolve_status_message = || -> Option<String> {
            let raw = options.status_message.as_ref()?.resolve()?;
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        };
        let normalized_search_for_subtitle = normalized_search.clone();
        let build_subtitle = move || -> Option<String> {
            let mut parts: Vec<String> = Vec::new();
            if !normalized_search_for_subtitle.is_empty() {
                parts.push(format!(
                    "{} {}",
                    ui_copy::main_menu::SEARCH_SUBTITLE_PREFIX,
                    normalized_search_for_subtitle
                ));
            }
            if let Some(status_text) = resolve_status_message() {
                parts.push(status_text);
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" | "))
            }
        };
        let initial_cursor = items.iter().position(|item| {
            if item.separator || item.disabled || item.heading {
                return false;
            }
            auth_menu_focus_key(&item.value) == focus_key
        });

        let focus_key_cell: RefCell<Option<String>> = RefCell::new(None);

        let mut select_options = SelectOptions::new(main_menu_title_with_version());
        select_options.subtitle = build_subtitle();
        select_options.dynamic_subtitle = Some(Box::new(build_subtitle.clone()));
        select_options.help = Some(if show_detailed_help.get() {
            ui_copy::main_menu::HELP_DETAILED.to_string()
        } else {
            ui_copy::main_menu::HELP_COMPACT.to_string()
        });
        select_options.clear_screen = true;
        select_options.selected_emphasis = Some(crate::select::SelectedEmphasis::Minimal);
        select_options.focus_style = Some(focus_style);
        select_options.show_hints_for_unselected = Some(show_hints_for_unselected_rows);
        select_options.refresh_interval_ms = Some(200.0);
        select_options.initial_cursor = initial_cursor.map(|i| i as i64);
        select_options.theme = Some(ui.theme.clone());
        select_options.on_input = Some(Box::new(|input, context| {
            let lower = input.to_lowercase();
            if lower == "?" {
                show_detailed_help.set(!show_detailed_help.get());
                context.request_rerender();
                return SelectInputResult::Ignored;
            }
            if lower == "q" {
                return SelectInputResult::Finish(Some(AuthMenuAction::Cancel));
            }
            if lower == "/" {
                return SelectInputResult::Finish(Some(AuthMenuAction::Search));
            }
            if let Some(parsed) = crate::auth_menu_builder::parse_int_prefix(input)
                && (1..=9).contains(&parsed) {
                    if duplicate_quick_switch_numbers.contains(&parsed) {
                        return SelectInputResult::Ignored;
                    }
                    if let Some(direct) = visible_by_number.get(&parsed) {
                        return SelectInputResult::Finish(Some(AuthMenuAction::SetCurrentAccount(
                            direct.clone(),
                        )));
                    }
                }
            SelectInputResult::Ignored
        }));
        select_options.on_cursor_change = Some(Box::new(|context| {
            let selected = &context.items[context.cursor];
            if selected.separator || selected.disabled || selected.heading {
                return;
            }
            *focus_key_cell.borrow_mut() = Some(auth_menu_focus_key(&selected.value));
        }));

        let result = select(&items, select_options)?;
        if let Some(tracked) = focus_key_cell.borrow_mut().take() {
            focus_key = tracked;
        }

        let result = match result {
            None => return Ok(AuthMenuAction::Cancel),
            Some(result) => result,
        };
        match &result {
            AuthMenuAction::Search => {
                search_query = prompt_search_query(&search_query);
                focus_key = "action:search".to_string();
                continue;
            }
            AuthMenuAction::DeleteAll => {
                let confirmed = confirm("Delete all accounts?", false)?;
                if !confirmed {
                    continue;
                }
            }
            AuthMenuAction::DeleteAccount(account) => {
                let confirmed = confirm(&format!("Delete {}?", account_title(account)), false)?;
                if !confirmed {
                    continue;
                }
            }
            AuthMenuAction::RefreshAccount(account) => {
                let confirmed = confirm(
                    &format!("Re-authenticate {}?", account_title(account)),
                    false,
                )?;
                if !confirmed {
                    continue;
                }
            }
            _ => {}
        }
        focus_key = auth_menu_focus_key(&result);
        return Ok(result);
    }
}

/// Show the per-account details menu and return the chosen action.
// focus-action bookkeeping mirrors the TS assignment order; see show_auth_menu.
#[allow(unused_assignments)]
pub fn show_account_details(account: &AccountInfo) -> Result<AccountAction, SelectError> {
    let ui = get_ui_runtime_options();
    let disabled_suffix = if account.enabled == Some(false) {
        if ui.v2_enabled {
            format!(" {}", format_ui_badge(&ui, "disabled", UiBadgeTone::Danger))
        } else {
            format!(" {}[disabled]{}", ansi::RED, ansi::RESET)
        }
    } else {
        String::new()
    };
    let header = format!(
        "{} {}{disabled_suffix}",
        account_title(account),
        status_badge(account.status)
    );
    let status_label = account
        .status
        .map(crate::auth_menu_builder::AccountStatus::as_str)
        .unwrap_or("unknown");
    let subtitle = format!(
        "Added: {} | Used: {} | Status: {status_label}",
        format_date(account.added_at),
        format_relative_time(account.last_used)
    );
    let mut focus_action = AccountAction::Back;

    loop {
        let items: Vec<MenuItem<AccountAction>> = vec![
            MenuItem::new(ui_copy::account_details::BACK, AccountAction::Back),
            MenuItem::new(
                if account.enabled == Some(false) {
                    ui_copy::account_details::ENABLE
                } else {
                    ui_copy::account_details::DISABLE
                },
                AccountAction::Toggle,
            )
            .with_color(if account.enabled == Some(false) {
                crate::select::MenuColor::Green
            } else {
                crate::select::MenuColor::Yellow
            }),
            MenuItem::new(ui_copy::account_details::SET_CURRENT, AccountAction::SetCurrent)
                .with_color(crate::select::MenuColor::Green),
            MenuItem::new(ui_copy::account_details::REFRESH, AccountAction::Refresh)
                .with_color(crate::select::MenuColor::Green),
            MenuItem::new(ui_copy::account_details::REMOVE, AccountAction::Delete)
                .with_color(crate::select::MenuColor::Red),
        ];
        let initial_cursor = items.iter().position(|item| item.value == focus_action);

        let focus_cell: RefCell<Option<AccountAction>> = RefCell::new(None);
        let mut select_options = SelectOptions::new(header.clone());
        select_options.subtitle = Some(subtitle.clone());
        select_options.help = Some(ui_copy::account_details::HELP.to_string());
        select_options.clear_screen = true;
        select_options.selected_emphasis = Some(crate::select::SelectedEmphasis::Minimal);
        select_options.focus_style = Some(account.focus_style.unwrap_or(FocusStyle::RowInvert));
        select_options.initial_cursor = initial_cursor.map(|i| i as i64);
        select_options.theme = Some(ui.theme.clone());
        select_options.on_input = Some(Box::new(|input, _context| {
            let lower = input.to_lowercase();
            match lower.as_str() {
                "q" => SelectInputResult::Finish(Some(AccountAction::Cancel)),
                "s" => SelectInputResult::Finish(Some(AccountAction::SetCurrent)),
                "r" => SelectInputResult::Finish(Some(AccountAction::Refresh)),
                "t" | "e" | "x" => SelectInputResult::Finish(Some(AccountAction::Toggle)),
                "d" => SelectInputResult::Finish(Some(AccountAction::Delete)),
                _ => SelectInputResult::Ignored,
            }
        }));
        select_options.on_cursor_change = Some(Box::new(|context| {
            let selected = &context.items[context.cursor];
            if selected.separator || selected.disabled || selected.heading {
                return;
            }
            *focus_cell.borrow_mut() = Some(selected.value);
        }));

        let action = select(&items, select_options)?;
        if let Some(tracked) = focus_cell.borrow_mut().take() {
            focus_action = tracked;
        }

        let action = match action {
            None => return Ok(AccountAction::Cancel),
            Some(action) => action,
        };
        focus_action = action;
        if action == AccountAction::Delete {
            let confirmed = confirm(&format!("Delete {}?", account_title(account)), false)?;
            if !confirmed {
                continue;
            }
        }
        if action == AccountAction::Refresh {
            let confirmed = confirm(
                &format!("Re-authenticate {}?", account_title(account)),
                false,
            )?;
            if !confirmed {
                continue;
            }
        }
        return Ok(action);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth_menu_builder::AccountStatus;
    use crate::theme::{create_ui_theme, CreateUiThemeOptions, UiAccent, UiColorProfile, UiGlyphMode, UiPalette};

    fn fixed_ui() -> UiRuntimeOptions {
        UiRuntimeOptions {
            v2_enabled: true,
            color_profile: UiColorProfile::Truecolor,
            glyph_mode: UiGlyphMode::Ascii,
            palette: UiPalette::Green,
            accent: UiAccent::Green,
            theme: create_ui_theme(CreateUiThemeOptions {
                profile: Some(UiColorProfile::Truecolor),
                glyph_mode: Some(UiGlyphMode::Ascii),
                disable_color: Some(false),
                ..Default::default()
            }),
        }
    }

    fn sample_account() -> AccountInfo {
        AccountInfo {
            index: 0,
            email: Some("owner@example.com".into()),
            status: Some(AccountStatus::Ok),
            last_used: Some(1_700_000_000_000),
            quota_5h_left_percent: Some(50.0),
            ..Default::default()
        }
    }

    #[test]
    fn builds_menu_with_exact_structure_and_order() {
        let ui = fixed_ui();
        let items = build_auth_menu_items(&[sample_account()], "Check Problem Accounts", 0, &ui);
        // Quick actions heading + 5 actions.
        assert!(items[0].heading);
        assert_eq!(items[0].label, "Quick Actions");
        assert_eq!(items[1].value, AuthMenuAction::Add);
        assert_eq!(items[2].value, AuthMenuAction::Check);
        assert_eq!(items[3].value, AuthMenuAction::Forecast);
        assert_eq!(items[4].value, AuthMenuAction::Fix);
        assert_eq!(items[5].value, AuthMenuAction::Settings);
        assert!(items[6].separator);
        assert!(items[7].heading);
        assert_eq!(items[7].label, "Advanced Checks");
        assert_eq!(items[8].value, AuthMenuAction::DeepCheck);
        assert_eq!(items[9].value, AuthMenuAction::VerifyFlagged);
        // Non-flagged verify row is yellow.
        assert_eq!(items[9].color, Some(crate::select::MenuColor::Yellow));
        assert!(items[10].separator);
        assert!(items[11].heading);
        assert_eq!(items[11].label, "Saved Accounts");
        // Account row.
        match &items[12].value {
            AuthMenuAction::SelectAccount(account) => {
                assert_eq!(account.email.as_deref(), Some("owner@example.com"));
            }
            other => panic!("expected select-account, got {other:?}"),
        }
        assert!(items[12].hint.is_some());
        // Danger zone tail.
        let n = items.len();
        assert!(items[n - 3].separator);
        assert!(items[n - 2].heading);
        assert_eq!(items[n - 2].label, "Danger Zone");
        assert_eq!(items[n - 1].value, AuthMenuAction::DeleteAll);
        assert_eq!(items[n - 1].color, Some(crate::select::MenuColor::Red));
    }

    #[test]
    fn flagged_count_colors_verify_row_red_and_labels_it() {
        let ui = fixed_ui();
        let items = build_auth_menu_items(
            &[],
            &ui_copy::format_check_flagged_label(2),
            2,
            &ui,
        );
        assert_eq!(items[9].label, "Check Problem Accounts (2)");
        assert_eq!(items[9].color, Some(crate::select::MenuColor::Red));
    }

    #[test]
    fn empty_visible_accounts_render_disabled_no_matches_row() {
        let ui = fixed_ui();
        let items = build_auth_menu_items(&[], "Check Problem Accounts", 0, &ui);
        let row = &items[12];
        assert!(row.disabled);
        assert_eq!(row.label, "No accounts match your search");
    }

    #[test]
    fn account_row_hint_contains_quota_bar() {
        // ui-03 end-to-end: the account row's hint carries the rendered quota
        // bar in the requested glyph mode.
        let mut ui = fixed_ui();
        ui.glyph_mode = UiGlyphMode::Unicode;
        ui.theme = create_ui_theme(CreateUiThemeOptions {
            profile: Some(UiColorProfile::Truecolor),
            glyph_mode: Some(UiGlyphMode::Unicode),
            disable_color: Some(false),
            ..Default::default()
        });
        let items = build_auth_menu_items(&[sample_account()], "x", 0, &ui);
        let hint = items[12].hint.as_deref().unwrap_or("");
        assert!(hint.contains('\u{2588}'));
        assert!(hint.contains('\u{2592}'));
        assert!(!hint.contains('#'));
    }

    #[test]
    fn current_account_gets_current_badge_and_accent_title() {
        let ui = fixed_ui();
        let mut account = sample_account();
        account.is_current_account = Some(true);
        let items = build_auth_menu_items(&[account], "x", 0, &ui);
        let label = &items[12].label;
        assert!(label.contains("[current]"), "{label}");
        // Status badge appended after the current badge.
        assert!(label.contains("[ok]"), "{label}");
    }

    #[test]
    fn hidden_badges_are_omitted_from_the_row_label() {
        let ui = fixed_ui();
        let mut account = sample_account();
        account.is_current_account = Some(true);
        account.show_current_badge = Some(false);
        account.show_status_badge = Some(false);
        let items = build_auth_menu_items(&[account], "x", 0, &ui);
        let label = &items[12].label;
        assert!(!label.contains("[current]"), "{label}");
        assert!(!label.contains("[ok]"), "{label}");
    }
}
