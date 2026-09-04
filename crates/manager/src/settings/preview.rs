//! Port of `lib/codex-manager/settings-preview.ts` — pure preview builders for
//! the settings panels. Preview literals are copy-exact (spec 09 §5.9).

use cma_config::dashboard_settings::{DashboardDisplaySettings, DashboardStatuslineField};
use cma_tui::runtime_options::UiRuntimeOptions;

/// `DEFAULT_STATUSLINE_FIELDS`.
pub const DEFAULT_STATUSLINE_FIELDS: [DashboardStatuslineField; 3] = [
    DashboardStatuslineField::LastUsed,
    DashboardStatuslineField::Limits,
    DashboardStatuslineField::Status,
];

const PREVIEW_ACCOUNT_EMAIL: &str = "demo@example.com";
const PREVIEW_LAST_USED: &str = "today";
const PREVIEW_STATUS: &str = "active";
const PREVIEW_LIMITS: &str = "5h \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2592}\u{2592}\u{2592}\u{2592} 62% | 7d \u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2592}\u{2592}\u{2592}\u{2592}\u{2592} 49%";
const PREVIEW_LIMIT_COOLDOWNS: &str = "5h reset 1h 20m | 7d reset 2d 04h";

/// `PreviewFocusKey` — statusline field, the panel toggle keys, the two cycle
/// items. The TS `null` becomes `Option::<PreviewFocusKey>::None` at the call
/// sites.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewFocusKey {
    // DashboardStatuslineField members
    LastUsed,
    Limits,
    Status,
    // menu* toggle keys
    MenuShowStatusBadge,
    MenuShowCurrentBadge,
    MenuShowLastUsed,
    MenuShowQuotaSummary,
    MenuShowQuotaCooldown,
    MenuShowFetchStatus,
    MenuShowDetailsForUnselectedRows,
    MenuHighlightCurrentRow,
    MenuSortEnabled,
    MenuSortPinCurrent,
    MenuSortQuickSwitchVisibleRow,
    // cycle items
    MenuSortMode,
    MenuLayoutMode,
}

impl PreviewFocusKey {
    pub fn from_statusline_field(field: DashboardStatuslineField) -> Self {
        match field {
            DashboardStatuslineField::LastUsed => Self::LastUsed,
            DashboardStatuslineField::Limits => Self::Limits,
            DashboardStatuslineField::Status => Self::Status,
        }
    }
}

/// Testable core of [`highlight_preview_token`] with the TTY probe injected.
pub(crate) fn highlight_preview_token_with_tty(
    text: &str,
    ui: &UiRuntimeOptions,
    stdout_is_tty: bool,
) -> String {
    if !stdout_is_tty {
        return text.to_string();
    }
    if ui.v2_enabled {
        return format!(
            "{}{}{}{}",
            ui.theme.colors.accent,
            cma_tui::ansi::BOLD,
            text,
            ui.theme.colors.reset
        );
    }
    format!(
        "{}{}{}{}",
        cma_tui::ansi::CYAN,
        cma_tui::ansi::BOLD,
        text,
        cma_tui::ansi::RESET
    )
}

/// `highlightPreviewToken` — plain text on a non-TTY stdout; v2 theme accent
/// or legacy cyan+bold otherwise.
pub fn highlight_preview_token(text: &str, ui: &UiRuntimeOptions) -> String {
    highlight_preview_token_with_tty(text, ui, cma_tui::ansi::is_tty())
}

fn is_last_used_focus(focus: Option<PreviewFocusKey>) -> bool {
    matches!(
        focus,
        Some(PreviewFocusKey::MenuShowLastUsed) | Some(PreviewFocusKey::LastUsed)
    )
}

fn is_limits_focus(focus: Option<PreviewFocusKey>) -> bool {
    matches!(
        focus,
        Some(PreviewFocusKey::MenuShowQuotaSummary) | Some(PreviewFocusKey::Limits)
    )
}

fn is_limits_cooldown_focus(focus: Option<PreviewFocusKey>) -> bool {
    matches!(focus, Some(PreviewFocusKey::MenuShowQuotaCooldown))
}

fn is_status_focus(focus: Option<PreviewFocusKey>) -> bool {
    matches!(
        focus,
        Some(PreviewFocusKey::MenuShowStatusBadge) | Some(PreviewFocusKey::Status)
    )
}

fn is_current_badge_focus(focus: Option<PreviewFocusKey>) -> bool {
    matches!(focus, Some(PreviewFocusKey::MenuShowCurrentBadge))
}

fn is_current_row_focus(focus: Option<PreviewFocusKey>) -> bool {
    matches!(focus, Some(PreviewFocusKey::MenuHighlightCurrentRow))
}

fn is_expanded_rows_focus(focus: Option<PreviewFocusKey>) -> bool {
    matches!(
        focus,
        Some(PreviewFocusKey::MenuShowDetailsForUnselectedRows)
            | Some(PreviewFocusKey::MenuLayoutMode)
    )
}

/// `normalizeStatuslineFields` — default when `None`; dedupe keeping the
/// first occurrence; empty result → fresh copy of defaults.
pub fn normalize_statusline_fields(
    fields: Option<&[DashboardStatuslineField]>,
) -> Vec<DashboardStatuslineField> {
    let source: &[DashboardStatuslineField] = fields.unwrap_or(&DEFAULT_STATUSLINE_FIELDS);
    let mut normalized: Vec<DashboardStatuslineField> = Vec::new();
    for field in source {
        if !normalized.contains(field) {
            normalized.push(*field);
        }
    }
    if normalized.is_empty() {
        return DEFAULT_STATUSLINE_FIELDS.to_vec();
    }
    normalized
}

fn build_summary_preview_text_with_tty(
    settings: &DashboardDisplaySettings,
    ui: &UiRuntimeOptions,
    focus: Option<PreviewFocusKey>,
    stdout_is_tty: bool,
) -> String {
    let highlight =
        |text: &str| -> String { highlight_preview_token_with_tty(text, ui, stdout_is_tty) };

    let mut parts_by_field: Vec<(DashboardStatuslineField, String)> = Vec::new();
    // Normalized settings are always fully populated, so `!== false` becomes
    // the plain boolean.
    if settings.menu_show_last_used {
        let part = format!("last used: {PREVIEW_LAST_USED}");
        let part = if is_last_used_focus(focus) {
            highlight(&part)
        } else {
            part
        };
        parts_by_field.push((DashboardStatuslineField::LastUsed, part));
    }
    if settings.menu_show_quota_summary {
        let limits_text = if !settings.menu_show_quota_cooldown {
            PREVIEW_LIMITS.to_string()
        } else {
            format!("{PREVIEW_LIMITS} | {PREVIEW_LIMIT_COOLDOWNS}")
        };
        let part = format!("limits: {limits_text}");
        let part = if is_limits_focus(focus) || is_limits_cooldown_focus(focus) {
            highlight(&part)
        } else {
            part
        };
        parts_by_field.push((DashboardStatuslineField::Limits, part));
    }
    if !settings.menu_show_status_badge {
        let part = format!("status: {PREVIEW_STATUS}");
        let part = if is_status_focus(focus) {
            highlight(&part)
        } else {
            part
        };
        parts_by_field.push((DashboardStatuslineField::Status, part));
    }

    let normalized = normalize_statusline_fields(Some(&settings.menu_statusline_fields));
    let ordered_parts: Vec<String> = normalized
        .iter()
        .filter_map(|field| {
            parts_by_field
                .iter()
                .find(|(part_field, _)| part_field == field)
                .map(|(_, part)| part.clone())
        })
        .filter(|part| !part.is_empty())
        .collect();
    if !ordered_parts.is_empty() {
        return ordered_parts.join(" | ");
    }

    let shows_status_field = normalized.contains(&DashboardStatuslineField::Status);
    if shows_status_field && settings.menu_show_status_badge {
        let note = "status text appears only when status badges are hidden";
        return if is_status_focus(focus) {
            highlight(note)
        } else {
            note.to_string()
        };
    }
    "no summary text is visible with current account-list settings".to_string()
}

/// `buildSummaryPreviewText`. (The TS `resolveMenuLayoutMode` parameter is
/// unused by the summary builder and is dropped here.)
pub fn build_summary_preview_text(
    settings: &DashboardDisplaySettings,
    ui: &UiRuntimeOptions,
    focus: Option<PreviewFocusKey>,
) -> String {
    build_summary_preview_text_with_tty(settings, ui, focus, cma_tui::ansi::is_tty())
}

/// Result of [`build_account_list_preview`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountListPreview {
    pub label: String,
    pub hint: String,
}

fn build_account_list_preview_with_tty(
    settings: &DashboardDisplaySettings,
    ui: &UiRuntimeOptions,
    resolve_menu_layout_mode: &dyn Fn(
        &DashboardDisplaySettings,
    ) -> cma_config::dashboard_settings::DashboardLayoutMode,
    focus: Option<PreviewFocusKey>,
    stdout_is_tty: bool,
) -> AccountListPreview {
    use cma_config::dashboard_settings::DashboardLayoutMode;
    let highlight =
        |text: &str| -> String { highlight_preview_token_with_tty(text, ui, stdout_is_tty) };

    let mut badges: Vec<String> = Vec::new();
    if settings.menu_show_current_badge {
        let current_badge = "[current]";
        badges.push(if is_current_badge_focus(focus) {
            highlight(current_badge)
        } else {
            current_badge.to_string()
        });
    }
    if settings.menu_show_status_badge {
        let status_badge = "[active]";
        badges.push(if is_status_focus(focus) {
            highlight(status_badge)
        } else {
            status_badge.to_string()
        });
    }
    let badge_suffix = if badges.is_empty() {
        String::new()
    } else {
        format!(" {}", badges.join(" "))
    };
    let account_email = if is_current_row_focus(focus) {
        highlight(PREVIEW_ACCOUNT_EMAIL)
    } else {
        PREVIEW_ACCOUNT_EMAIL.to_string()
    };
    let row_detail_mode = match resolve_menu_layout_mode(settings) {
        DashboardLayoutMode::ExpandedRows => "details shown on all rows",
        DashboardLayoutMode::CompactDetails => "details shown on selected row only",
    };
    let detail_mode_text = if is_expanded_rows_focus(focus) {
        highlight(row_detail_mode)
    } else {
        row_detail_mode.to_string()
    };
    AccountListPreview {
        label: format!("1. {account_email}{badge_suffix}"),
        hint: format!(
            "{}\n{}",
            build_summary_preview_text_with_tty(settings, ui, focus, stdout_is_tty),
            detail_mode_text
        ),
    }
}

/// `buildAccountListPreview`.
pub fn build_account_list_preview(
    settings: &DashboardDisplaySettings,
    ui: &UiRuntimeOptions,
    resolve_menu_layout_mode: &dyn Fn(
        &DashboardDisplaySettings,
    ) -> cma_config::dashboard_settings::DashboardLayoutMode,
    focus: Option<PreviewFocusKey>,
) -> AccountListPreview {
    build_account_list_preview_with_tty(
        settings,
        ui,
        resolve_menu_layout_mode,
        focus,
        cma_tui::ansi::is_tty(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_config::dashboard_settings::DashboardLayoutMode;
    use cma_tui::runtime_options::get_ui_runtime_options;

    fn defaults() -> DashboardDisplaySettings {
        DashboardDisplaySettings::default()
    }

    fn resolver(settings: &DashboardDisplaySettings) -> DashboardLayoutMode {
        crate::settings::hub::resolve_menu_layout_mode(settings)
    }

    #[test]
    fn normalize_statusline_fields_defaults_dedupes_and_backfills() {
        assert_eq!(
            normalize_statusline_fields(None),
            DEFAULT_STATUSLINE_FIELDS.to_vec()
        );
        assert_eq!(
            normalize_statusline_fields(Some(&[
                DashboardStatuslineField::Limits,
                DashboardStatuslineField::Limits,
                DashboardStatuslineField::Status,
            ])),
            vec![
                DashboardStatuslineField::Limits,
                DashboardStatuslineField::Status
            ]
        );
        assert_eq!(
            normalize_statusline_fields(Some(&[])),
            DEFAULT_STATUSLINE_FIELDS.to_vec()
        );
    }

    #[test]
    fn summary_preview_orders_parts_and_hides_status_behind_badges() {
        let ui = get_ui_runtime_options();
        let settings = defaults();
        // Defaults: last-used + limits (with cooldowns); status hidden because
        // badges are shown.
        let text = build_summary_preview_text_with_tty(&settings, &ui, None, false);
        assert_eq!(
            text,
            format!(
                "last used: {PREVIEW_LAST_USED} | limits: {PREVIEW_LIMITS} | {PREVIEW_LIMIT_COOLDOWNS}"
            )
        );
    }

    #[test]
    fn summary_preview_shows_status_text_only_when_badges_hidden() {
        let ui = get_ui_runtime_options();
        let mut settings = defaults();
        settings.menu_show_status_badge = false;
        settings.menu_show_last_used = false;
        settings.menu_show_quota_summary = false;
        let text = build_summary_preview_text_with_tty(&settings, &ui, None, false);
        assert_eq!(text, "status: active");
    }

    #[test]
    fn summary_preview_cooldowns_can_be_suppressed() {
        let ui = get_ui_runtime_options();
        let mut settings = defaults();
        settings.menu_show_quota_cooldown = false;
        settings.menu_show_last_used = false;
        let text = build_summary_preview_text_with_tty(&settings, &ui, None, false);
        assert_eq!(text, format!("limits: {PREVIEW_LIMITS}"));
    }

    #[test]
    fn summary_preview_empty_note_when_status_configured_but_badged() {
        let ui = get_ui_runtime_options();
        let mut settings = defaults();
        settings.menu_show_last_used = false;
        settings.menu_show_quota_summary = false;
        // status stays in the field list but badges are shown.
        let text = build_summary_preview_text_with_tty(&settings, &ui, None, false);
        assert_eq!(
            text,
            "status text appears only when status badges are hidden"
        );
        // Without the status field at all:
        settings.menu_statusline_fields = vec![DashboardStatuslineField::LastUsed];
        let text = build_summary_preview_text_with_tty(&settings, &ui, None, false);
        assert_eq!(
            text,
            "no summary text is visible with current account-list settings"
        );
    }

    #[test]
    fn account_list_preview_badges_and_layout_note() {
        let ui = get_ui_runtime_options();
        let settings = defaults();
        let preview =
            build_account_list_preview_with_tty(&settings, &ui, &resolver, None, false);
        assert_eq!(preview.label, "1. demo@example.com [current] [active]");
        assert!(preview.hint.ends_with("details shown on selected row only"));

        let mut expanded = defaults();
        expanded.menu_layout_mode = DashboardLayoutMode::ExpandedRows;
        let preview =
            build_account_list_preview_with_tty(&expanded, &ui, &resolver, None, false);
        assert!(preview.hint.ends_with("details shown on all rows"));

        let mut no_badges = defaults();
        no_badges.menu_show_current_badge = false;
        no_badges.menu_show_status_badge = false;
        let preview =
            build_account_list_preview_with_tty(&no_badges, &ui, &resolver, None, false);
        assert_eq!(preview.label, "1. demo@example.com");
    }

    #[test]
    fn highlight_is_plain_without_tty() {
        let ui = get_ui_runtime_options();
        assert_eq!(highlight_preview_token_with_tty("x", &ui, false), "x");
        let highlighted = highlight_preview_token_with_tty("x", &ui, true);
        assert!(highlighted.contains('x'));
        assert!(highlighted.contains("\u{1b}["));
    }
}
