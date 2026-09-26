//! Port of `lib/codex-manager/dashboard-formatters.ts` (spec 09 §5.7).

use cma_config::dashboard_settings::{DashboardAccountSortMode, DashboardLayoutMode};

/// TS `formatDashboardSettingState(value)` — `"[x]"` / `"[ ]"`.
pub fn format_dashboard_setting_state(value: bool) -> String {
    if value { "[x]" } else { "[ ]" }.to_string()
}

/// TS `formatMenuSortMode(mode)` — `"Ready-First"` / `"Manual"`.
pub fn format_menu_sort_mode(mode: DashboardAccountSortMode) -> String {
    match mode {
        DashboardAccountSortMode::ReadyFirst => "Ready-First",
        DashboardAccountSortMode::Manual => "Manual",
    }
    .to_string()
}

/// TS `formatMenuLayoutMode(mode)` — `"Expanded Rows"` /
/// `"Compact + Details Pane"`.
pub fn format_menu_layout_mode(mode: DashboardLayoutMode) -> String {
    match mode {
        DashboardLayoutMode::ExpandedRows => "Expanded Rows",
        DashboardLayoutMode::CompactDetails => "Compact + Details Pane",
    }
    .to_string()
}

/// TS `formatMenuQuotaTtl(ttlMs)` — `Nm` when divisible by 60 000 and
/// ≥ 60 000, `Ns` when divisible by 1 000 and ≥ 1 000, else `Nms`.
pub fn format_menu_quota_ttl(ttl_ms: i64) -> String {
    if ttl_ms >= 60_000 && ttl_ms % 60_000 == 0 {
        return format!("{}m", ttl_ms / 60_000);
    }
    if ttl_ms >= 1_000 && ttl_ms % 1_000 == 0 {
        return format!("{}s", ttl_ms / 1_000);
    }
    format!("{ttl_ms}ms")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from test/dashboard-formatters.test.ts.

    #[test]
    fn formats_dashboard_toggle_states() {
        assert_eq!(format_dashboard_setting_state(true), "[x]");
        assert_eq!(format_dashboard_setting_state(false), "[ ]");
    }

    #[test]
    fn formats_sort_mode_labels() {
        assert_eq!(
            format_menu_sort_mode(DashboardAccountSortMode::ReadyFirst),
            "Ready-First"
        );
        assert_eq!(
            format_menu_sort_mode(DashboardAccountSortMode::Manual),
            "Manual"
        );
    }

    #[test]
    fn formats_layout_mode_labels() {
        assert_eq!(
            format_menu_layout_mode(DashboardLayoutMode::ExpandedRows),
            "Expanded Rows"
        );
        assert_eq!(
            format_menu_layout_mode(DashboardLayoutMode::CompactDetails),
            "Compact + Details Pane"
        );
    }

    #[test]
    fn formats_quota_ttl_across_branches() {
        assert_eq!(format_menu_quota_ttl(120_000), "2m");
        assert_eq!(format_menu_quota_ttl(5_000), "5s");
        assert_eq!(format_menu_quota_ttl(500), "500ms");
        assert_eq!(format_menu_quota_ttl(1_500), "1500ms");
    }
}
