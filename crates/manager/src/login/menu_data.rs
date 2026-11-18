//! Port of `lib/codex-manager/login-menu-data.ts` — the login dashboard's
//! data layer: menu quota refresh (5-minute TTL), the account-row view-model
//! builder with ready-first ordering (duration-derived window labels — spec
//! 09 gotcha 10), the runtime-current resolution, and the Codex CLI drift
//! sync.
//!
//! The quota-summary string formatter lives in the sibling-owned
//! `crate::formatters::quota`; it is injected here exactly like the TS DI
//! seams so this module stays testable in isolation.

use cma_config::dashboard_settings::{
    DashboardAccountSortMode, DashboardDisplaySettings, DashboardLayoutMode,
};
use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
use cma_core::token_utils::{extract_account_id, sanitize_email};
use cma_core::utils::now_ms;
use cma_quota::cache::{load_quota_cache, save_quota_cache, QuotaCacheData, QuotaCacheEntry};
use cma_quota::probe::{fetch_codex_quota_snapshot, ProbeCodexQuotaOptions};
use cma_quota::readiness::{
    build_quota_email_fallback_state, has_safe_quota_email_fallback, has_unique_quota_account_id,
    is_quota_cache_entry_exhausted, normalize_quota_account_id, quota_left_percent_from_used,
};
use cma_runtime::account_status::{format_rate_limit_entry, resolve_active_index};
use cma_runtime::current_account::{
    is_display_current_account, read_app_runtime_helper_account_signal,
    resolve_account_current_markers, resolve_runtime_current_account,
    RuntimeCurrentAccountOptions, RuntimeCurrentAccountSelection, RuntimeCurrentAccountSources,
};
use cma_tui::auth_menu_builder::{resolve_quota_window_label, AccountStatus};
use cma_tui::login_prompts::ExistingAccountInfo;

use crate::login::account_credentials::has_usable_access_token;
use crate::quota_cache_helpers::{
    clone_quota_cache_data, get_persisted_quota_view_for_account, update_quota_cache_for_account,
    PersistedQuotaViewAccount, DEFAULT_LIVE_PROBE_MODEL,
};

/// `DEFAULT_MENU_QUOTA_REFRESH_TTL_MS` (5 minutes).
pub const DEFAULT_MENU_QUOTA_REFRESH_TTL_MS: i64 = 5 * 60_000;

/// Injected quota-summary formatter (`formatAccountQuotaSummary` from the
/// sibling formatters cluster).
pub type FormatAccountQuotaSummaryFn<'a> = &'a dyn Fn(&QuotaCacheEntry, i64) -> String;

// ---------------------------------------------------------------------------
// Probe eligibility (`resolveMenuQuotaProbeInput`, private in TS)
// ---------------------------------------------------------------------------

struct MenuQuotaProbeInput {
    account_index: usize,
    probe_account_id: String,
    access_token: String,
}

fn resolve_menu_quota_probe_input(
    storage: &AccountStorageV3,
    cache: &QuotaCacheData,
    account_index: usize,
    max_age_ms: i64,
    now: i64,
    email_state: &std::collections::HashMap<String, cma_quota::readiness::QuotaEmailFallbackState>,
) -> Option<MenuQuotaProbeInput> {
    let account = storage.accounts.get(account_index)?;
    // Skip disabled accounts.
    if account.enabled == Some(false) {
        return None;
    }
    // Skip accounts without a usable access token.
    if !has_usable_access_token(account, now) {
        return None;
    }
    // Skip when the persisted quota view is still fresh.
    let view = get_persisted_quota_view_for_account(
        Some(cache),
        &PersistedQuotaViewAccount {
            account_id: account.account_id.as_deref(),
            email: account.email.as_deref(),
            rate_limit_reset_times: account.rate_limit_reset_times.as_ref(),
        },
        &storage.accounts,
        now,
        Some(email_state),
    );
    if let Some(view) = view
        && now as f64 - view.updated_at < max_age_ms as f64 {
            return None;
        }
    // Skip unless the result can be stored under a safe key.
    let has_safe_id_key = normalize_quota_account_id(account.account_id.as_deref()).is_some()
        && has_unique_quota_account_id(&storage.accounts, account);
    let has_safe_email_key = has_safe_quota_email_fallback(email_state, account);
    if !has_safe_id_key && !has_safe_email_key {
        return None;
    }
    // Probe id = accountId ?? extractAccountId(accessToken); both required.
    let access_token = account.access_token.clone()?;
    let probe_account_id = account
        .account_id
        .clone()
        .or_else(|| extract_account_id(Some(&access_token)))?;
    Some(MenuQuotaProbeInput {
        account_index,
        probe_account_id,
        access_token,
    })
}

fn collect_probe_targets(
    storage: &AccountStorageV3,
    cache: &QuotaCacheData,
    max_age_ms: i64,
    now: i64,
) -> Vec<MenuQuotaProbeInput> {
    let email_state = build_quota_email_fallback_state(&storage.accounts);
    (0..storage.accounts.len())
        .filter_map(|index| {
            resolve_menu_quota_probe_input(storage, cache, index, max_age_ms, now, &email_state)
        })
        .collect()
}

/// `countMenuQuotaRefreshTargets(storage, cache, maxAgeMs, now)`.
pub fn count_menu_quota_refresh_targets(
    storage: &AccountStorageV3,
    cache: &QuotaCacheData,
    max_age_ms: i64,
    now: i64,
) -> usize {
    collect_probe_targets(storage, cache, max_age_ms, now).len()
}

/// `refreshQuotaCacheForMenu(storage, cache, maxAgeMs, onProgress)`:
/// clone → probe stale targets → apply onto the clone → RE-LOAD the persisted
/// cache and re-apply this run's snapshots onto it before saving (prevents
/// last-write-wins clobbering; spec 09 gotcha 9). Save failures only warn.
pub async fn refresh_quota_cache_for_menu(
    storage: &AccountStorageV3,
    cache: &QuotaCacheData,
    max_age_ms: i64,
    mut on_progress: Option<&mut (dyn FnMut(usize, usize) + Send)>,
) -> QuotaCacheData {
    if storage.accounts.is_empty() {
        return cache.clone();
    }
    let now = now_ms();
    let mut working = clone_quota_cache_data(cache);
    let targets = collect_probe_targets(storage, cache, max_age_ms, now);
    let total = targets.len();
    if let Some(progress) = on_progress.as_deref_mut() {
        progress(0, total);
    }

    // Applied snapshots: (account index, snapshot) for the re-apply pass.
    let mut applied: Vec<(usize, cma_quota::probe::CodexQuotaSnapshot)> = Vec::new();
    let mut changed = false;
    for (processed, target) in targets.iter().enumerate() {
        if let Some(progress) = on_progress.as_deref_mut() {
            progress(processed, total);
        }
        let snapshot = fetch_codex_quota_snapshot(&ProbeCodexQuotaOptions {
            account_id: target.probe_account_id.clone(),
            access_token: target.access_token.clone(),
            model: Some(DEFAULT_LIVE_PROBE_MODEL.to_string()),
            ..Default::default()
        })
        .await;
        // Probe failures silently keep the cached values.
        if let Ok(snapshot) = snapshot {
            let account = &storage.accounts[target.account_index];
            if update_quota_cache_for_account(
                &mut working,
                account,
                &snapshot,
                &storage.accounts,
                None,
            ) {
                changed = true;
            }
            applied.push((target.account_index, snapshot));
        }
    }

    if !changed {
        return working;
    }

    // Re-base: reload the persisted cache and re-apply this run's snapshots
    // onto the fresh state; an empty persisted cache (read failure/empty
    // file) falls back to the local clone.
    let persisted = load_quota_cache().await;
    let has_persisted_data =
        !persisted.by_account_id.is_empty() || !persisted.by_email.is_empty();
    let to_save = if has_persisted_data {
        let mut rebased = persisted;
        for (account_index, snapshot) in &applied {
            let account = &storage.accounts[*account_index];
            update_quota_cache_for_account(
                &mut rebased,
                account,
                snapshot,
                &storage.accounts,
                None,
            );
        }
        rebased
    } else {
        working
    };
    // `saveQuotaCache` never throws (Windows EBUSY/EPERM tolerated inside).
    save_quota_cache(&to_save).await;
    to_save
}

// ---------------------------------------------------------------------------
// Account-row view model (`toExistingAccountInfo`)
// ---------------------------------------------------------------------------

fn map_account_status(
    account: &AccountMetadataV3,
    entry: Option<&QuotaCacheEntry>,
    now: i64,
    is_current: bool,
) -> AccountStatus {
    if account.enabled == Some(false) {
        return AccountStatus::Disabled;
    }
    if account.cooling_down_until.is_some_and(|until| until > now) {
        return AccountStatus::Cooldown;
    }
    if is_quota_cache_entry_exhausted(entry, now) {
        return AccountStatus::QuotaExhausted;
    }
    if entry.is_some_and(|entry| entry.status == 429.0) {
        return AccountStatus::RateLimited;
    }
    let rate_limit_line = format_rate_limit_entry(
        account.rate_limit_reset_times.as_ref(),
        now,
        &|ms| cma_accounts::rate_limits::format_wait_time(ms),
        cma_core::model_family::ModelFamily::Codex,
    );
    if rate_limit_line.is_some() {
        return AccountStatus::RateLimited;
    }
    if is_current {
        return AccountStatus::Active;
    }
    AccountStatus::Ok
}

/// `toExistingAccountInfo(storage, quotaCache, displaySettings,
/// runtimeCurrent)` — builds and orders the dashboard rows.
pub fn to_existing_account_info(
    storage: &AccountStorageV3,
    quota_cache: &QuotaCacheData,
    display_settings: &DashboardDisplaySettings,
    runtime_current: Option<&RuntimeCurrentAccountSelection>,
    format_account_quota_summary: FormatAccountQuotaSummaryFn<'_>,
) -> Vec<ExistingAccountInfo> {
    let now = now_ms();
    let active_index = resolve_active_index(storage, cma_core::model_family::ModelFamily::Codex);
    let email_state = build_quota_email_fallback_state(&storage.accounts);
    let layout_mode = display_settings.menu_layout_mode;

    let mut rows: Vec<ExistingAccountInfo> = storage
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let entry = get_persisted_quota_view_for_account(
                Some(quota_cache),
                &PersistedQuotaViewAccount {
                    account_id: account.account_id.as_deref(),
                    email: account.email.as_deref(),
                    rate_limit_reset_times: account.rate_limit_reset_times.as_ref(),
                },
                &storage.accounts,
                now,
                Some(&email_state),
            );
            let markers = resolve_account_current_markers(index, active_index, runtime_current);
            let is_current = is_display_current_account(index, active_index, runtime_current);
            let status = map_account_status(account, entry.as_ref(), now, is_current);

            let quota_summary = if display_settings.menu_show_quota_summary {
                entry
                    .as_ref()
                    .map(|entry| format_account_quota_summary(entry, now))
            } else {
                None
            };
            let tui_markers: Vec<cma_tui::auth_menu_builder::AccountCurrentMarker> = markers
                .iter()
                .map(|marker| match marker {
                    cma_runtime::current_account::AccountCurrentMarker::Current => {
                        cma_tui::auth_menu_builder::AccountCurrentMarker::Current
                    }
                    cma_runtime::current_account::AccountCurrentMarker::InUse => {
                        cma_tui::auth_menu_builder::AccountCurrentMarker::InUse
                    }
                    cma_runtime::current_account::AccountCurrentMarker::Selected => {
                        cma_tui::auth_menu_builder::AccountCurrentMarker::Selected
                    }
                })
                .collect();

            ExistingAccountInfo {
                index: index as i64,
                source_index: Some(index as i64),
                quick_switch_number: None,
                account_id: account.account_id.clone(),
                account_label: account.account_label.clone(),
                email: account.email.clone(),
                added_at: Some(account.added_at),
                last_used: Some(account.last_used),
                status: Some(status),
                quota_summary,
                quota_5h_left_percent: entry
                    .as_ref()
                    .and_then(|entry| quota_left_percent_from_used(entry.primary.used_percent))
                    .map(|value| value as f64),
                quota_5h_reset_at_ms: entry.as_ref().and_then(|entry| entry.primary.reset_at_ms),
                quota_7d_left_percent: entry
                    .as_ref()
                    .and_then(|entry| quota_left_percent_from_used(entry.secondary.used_percent))
                    .map(|value| value as f64),
                quota_7d_reset_at_ms: entry.as_ref().and_then(|entry| entry.secondary.reset_at_ms),
                quota_primary_window_minutes: entry
                    .as_ref()
                    .and_then(|entry| entry.primary.window_minutes),
                quota_secondary_window_minutes: entry
                    .as_ref()
                    .and_then(|entry| entry.secondary.window_minutes),
                quota_rate_limited: Some(entry.as_ref().is_some_and(|entry| entry.status == 429.0)),
                quota_exhausted: Some(is_quota_cache_entry_exhausted(entry.as_ref(), now)),
                is_current_account: Some(is_current),
                is_default_account: Some(index == active_index),
                is_runtime_current_account: Some(
                    runtime_current.is_some_and(|current| current.index == index),
                ),
                current_markers: Some(tui_markers),
                enabled: Some(account.enabled != Some(false)),
                show_status_badge: Some(display_settings.menu_show_status_badge),
                show_current_badge: Some(display_settings.menu_show_current_badge),
                show_last_used: Some(display_settings.menu_show_last_used),
                show_quota_cooldown: Some(display_settings.menu_show_quota_cooldown),
                show_hints_for_unselected_rows: Some(
                    layout_mode == DashboardLayoutMode::ExpandedRows,
                ),
                highlight_current_row: Some(display_settings.menu_highlight_current_row),
                focus_style: Some(match display_settings.menu_focus_style {
                    cma_config::dashboard_settings::DashboardFocusStyle::RowInvert => {
                        cma_tui::select::FocusStyle::RowInvert
                    }
                }),
                statusline_fields: Some(
                    display_settings
                        .menu_statusline_fields
                        .iter()
                        .map(|field| field.as_str().to_string())
                        .collect(),
                ),
            }
        })
        .collect();

    apply_account_menu_ordering(&mut rows, display_settings);
    rows
}

// ---------------------------------------------------------------------------
// Ready-first ordering
// ---------------------------------------------------------------------------

fn readiness_bucket(account: &ExistingAccountInfo) -> i32 {
    let mut bucket = match account.status {
        Some(AccountStatus::Active) | Some(AccountStatus::Ok) => 0,
        Some(AccountStatus::QuotaExhausted)
        | Some(AccountStatus::Cooldown)
        | Some(AccountStatus::RateLimited) => 2,
        Some(AccountStatus::Disabled)
        | Some(AccountStatus::Error)
        | Some(AccountStatus::Flagged) => 3,
        Some(AccountStatus::Unknown) | None => 1,
    };
    // Also forced to >= 2 when the quota view says limited/exhausted.
    if account.quota_rate_limited == Some(true) || account.quota_exhausted == Some(true) {
        bucket = bucket.max(2);
    }
    bucket
}

/// Hand-rolled equivalent of the TS regex
/// `(?:^|\|)\s*${windowLabel}\s+(\d{1,3})%` (case-insensitive) — the `regex`
/// crate is not a manager dependency.
fn parse_left_percent_from_summary(summary: &str, window_label: &str) -> Option<i64> {
    let label_lower = window_label.to_lowercase();
    for segment in summary.split('|') {
        let trimmed = segment.trim_start();
        let lower = trimmed.to_lowercase();
        let Some(rest) = lower.strip_prefix(&label_lower) else {
            continue;
        };
        // Require at least one whitespace char after the label.
        let mut chars = rest.chars();
        let Some(first) = chars.next() else { continue };
        if !first.is_whitespace() {
            continue;
        }
        let after_ws: String = {
            let mut s: &str = rest;
            s = s.trim_start();
            s.to_string()
        };
        // 1–3 digits immediately followed by '%'.
        let digits: String = after_ws.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || digits.len() > 3 {
            continue;
        }
        if !after_ws[digits.len()..].starts_with('%') {
            continue;
        }
        return digits.parse::<i64>().ok();
    }
    None
}

/// `readQuotaLeftPercent` — direct numeric field clamped/rounded 0–100, else
/// parse from the summary string using DURATION-DERIVED window labels (a 30d
/// Business window matches `"30d"`, not the positional `"7d"`); no match →
/// −1 (sinks to the bottom).
fn read_quota_left_percent(account: &ExistingAccountInfo, primary_window: bool) -> i64 {
    let direct = if primary_window {
        account.quota_5h_left_percent
    } else {
        account.quota_7d_left_percent
    };
    if let Some(direct) = direct
        && direct.is_finite() {
            return (direct.round() as i64).clamp(0, 100);
        }
    let Some(summary) = &account.quota_summary else {
        return -1;
    };
    let (window_minutes, fallback) = if primary_window {
        (account.quota_primary_window_minutes, "5h")
    } else {
        (account.quota_secondary_window_minutes, "7d")
    };
    let label = resolve_quota_window_label(window_minutes, fallback);
    parse_left_percent_from_summary(summary, &label).unwrap_or(-1)
}

/// `compareReadyFirstAccounts(a, b)` — readiness bucket, then higher quota
/// floor, then higher 5h, higher 7d, more recent lastUsed, lower sourceIndex.
pub(crate) fn compare_ready_first_accounts(
    a: &ExistingAccountInfo,
    b: &ExistingAccountInfo,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let bucket = readiness_bucket(a).cmp(&readiness_bucket(b));
    if bucket != Ordering::Equal {
        return bucket;
    }
    let a5 = read_quota_left_percent(a, true);
    let a7 = read_quota_left_percent(a, false);
    let b5 = read_quota_left_percent(b, true);
    let b7 = read_quota_left_percent(b, false);
    let floor = (b5.min(b7)).cmp(&(a5.min(a7)));
    if floor != Ordering::Equal {
        return floor;
    }
    let five = b5.cmp(&a5);
    if five != Ordering::Equal {
        return five;
    }
    let seven = b7.cmp(&a7);
    if seven != Ordering::Equal {
        return seven;
    }
    let last_used = b.last_used.unwrap_or(0).cmp(&a.last_used.unwrap_or(0));
    if last_used != Ordering::Equal {
        return last_used;
    }
    a.source_index
        .unwrap_or(0)
        .cmp(&b.source_index.unwrap_or(0))
}

/// `applyAccountMenuOrdering` — ready-first sort (when enabled), the
/// pin-current-when-tied rule, then display re-indexing + quick-switch
/// numbers.
pub(crate) fn apply_account_menu_ordering(
    rows: &mut Vec<ExistingAccountInfo>,
    settings: &DashboardDisplaySettings,
) {
    let sort_active = settings.menu_sort_enabled
        && settings.menu_sort_mode == DashboardAccountSortMode::ReadyFirst;
    if sort_active {
        rows.sort_by(compare_ready_first_accounts);

        if settings.menu_sort_pin_current {
            let current_position = rows
                .iter()
                .position(|row| row.is_current_account == Some(true));
            if let Some(position) = current_position
                && position > 0 {
                    // Move to the front ONLY when tied-or-better vs the
                    // current first row (gotcha 11).
                    let ordering = compare_ready_first_accounts(&rows[position], &rows[0]);
                    if ordering != std::cmp::Ordering::Greater {
                        let row = rows.remove(position);
                        rows.insert(0, row);
                    }
                }
        }
    }

    for (display_index, row) in rows.iter_mut().enumerate() {
        row.index = display_index as i64;
        row.quick_switch_number = Some(if settings.menu_sort_quick_switch_visible_row {
            display_index as i64 + 1
        } else {
            row.source_index.unwrap_or(display_index as i64) + 1
        });
    }
}

// ---------------------------------------------------------------------------
// Runtime current + Codex CLI drift sync
// ---------------------------------------------------------------------------

/// `loadRuntimeCurrentSelectionForStorage(storage, now)` — merges the
/// runtime-observability snapshot, the app-bind router status (only when
/// running), and the app-helper signal; every source failure degrades to
/// `None`.
pub async fn load_runtime_current_selection_for_storage(
    storage: &AccountStorageV3,
    now: i64,
) -> Option<RuntimeCurrentAccountSelection> {
    let runtime_snapshot =
        cma_runtime::observability::load_persisted_runtime_observability_snapshot();
    let app_bind_status = match cma_runtime::app_bind::get_app_bind_status(
        &cma_runtime::app_bind::AppBindOptions::default(),
    )
    .await
    {
        Ok(status) if status.running => status.router,
        _ => None,
    };
    resolve_runtime_current_account(
        storage,
        &RuntimeCurrentAccountSources {
            runtime_snapshot,
            app_bind_status,
            app_helper_status: read_app_runtime_helper_account_signal(),
        },
        RuntimeCurrentAccountOptions {
            now: Some(now),
            max_age_ms: None,
        },
    )
}

/// `syncCodexCliActiveSelectionIfDrifted(storage)` — pushes the manager's
/// active account into the Codex CLI files when the identities no longer
/// match. Match rule: trimmed accountId equality when both present; else
/// sanitized email equality when both present; else DRIFTED. All errors →
/// `false`.
pub async fn sync_codex_cli_active_selection_if_drifted(storage: &AccountStorageV3) -> bool {
    let active_index = resolve_active_index(storage, cma_core::model_family::ModelFamily::Codex);
    let Some(account) = storage.accounts.get(active_index) else {
        return false;
    };
    let Some(state) = cma_cli_mirror::state::load_codex_cli_state(true).await else {
        return false;
    };

    let manager_id = account
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let cli_id = state
        .active_account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let manager_email = sanitize_email(account.email.as_deref());
    let cli_email = sanitize_email(state.active_email.as_deref());

    let matching = match (manager_id, cli_id) {
        (Some(manager_id), Some(cli_id)) => manager_id == cli_id,
        _ => match (&manager_email, &cli_email) {
            (Some(manager_email), Some(cli_email)) => manager_email == cli_email,
            // Neither identity comparable → treat as drifted.
            _ => false,
        },
    };
    if matching {
        return false;
    }

    cma_cli_mirror::writer::set_codex_cli_active_selection(&cma_cli_mirror::writer::ActiveSelection {
        account_id: account.account_id.clone(),
        email: account.email.clone(),
        access_token: account.access_token.clone(),
        refresh_token: Some(account.refresh_token.clone()),
        expires_at: account.expires_at.map(|value| value as f64),
        id_token: None,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        source_index: i64,
        status: AccountStatus,
        left_5h: Option<f64>,
        left_7d: Option<f64>,
        last_used: i64,
    ) -> ExistingAccountInfo {
        ExistingAccountInfo {
            index: source_index,
            source_index: Some(source_index),
            status: Some(status),
            quota_5h_left_percent: left_5h,
            quota_7d_left_percent: left_7d,
            last_used: Some(last_used),
            ..Default::default()
        }
    }

    fn default_settings() -> DashboardDisplaySettings {
        DashboardDisplaySettings::default()
    }

    #[test]
    fn ready_first_orders_by_bucket_then_quota_floor() {
        let mut rows = vec![
            row(0, AccountStatus::RateLimited, Some(90.0), Some(90.0), 10),
            row(1, AccountStatus::Ok, Some(20.0), Some(80.0), 10),
            row(2, AccountStatus::Ok, Some(70.0), Some(60.0), 10),
            row(3, AccountStatus::Disabled, Some(100.0), Some(100.0), 10),
        ];
        apply_account_menu_ordering(&mut rows, &default_settings());
        let order: Vec<i64> = rows.iter().filter_map(|r| r.source_index).collect();
        // Ok rows first (higher floor 60 beats floor 20), then rate-limited,
        // then disabled.
        assert_eq!(order, vec![2, 1, 0, 3]);
        // Display re-indexing + quick-switch numbers follow visible rows.
        assert_eq!(rows[0].index, 0);
        assert_eq!(rows[0].quick_switch_number, Some(1));
        assert_eq!(rows[3].quick_switch_number, Some(4));
    }

    #[test]
    fn quota_flags_force_the_limited_bucket() {
        let mut limited = row(0, AccountStatus::Ok, Some(100.0), Some(100.0), 10);
        limited.quota_rate_limited = Some(true);
        let healthy = row(1, AccountStatus::Ok, Some(10.0), Some(10.0), 10);
        let mut rows = vec![limited, healthy];
        apply_account_menu_ordering(&mut rows, &default_settings());
        assert_eq!(rows[0].source_index, Some(1));
    }

    #[test]
    fn summary_parse_uses_duration_derived_labels() {
        let mut business = row(0, AccountStatus::Ok, None, None, 10);
        business.quota_summary = Some("5h 80% | 30d 70%".to_string());
        // 30-day window: label resolves to "30d" (not the positional "7d").
        business.quota_primary_window_minutes = Some(300.0);
        business.quota_secondary_window_minutes = Some(30.0 * 24.0 * 60.0);
        assert_eq!(read_quota_left_percent(&business, true), 80);
        assert_eq!(read_quota_left_percent(&business, false), 70);

        // Positional fallback when no window minutes are present.
        let mut plain = row(1, AccountStatus::Ok, None, None, 10);
        plain.quota_summary = Some("5h 15% | 7d 25%".to_string());
        assert_eq!(read_quota_left_percent(&plain, true), 15);
        assert_eq!(read_quota_left_percent(&plain, false), 25);

        // No match → −1 (sinks to the bottom).
        let mut none = row(2, AccountStatus::Ok, None, None, 10);
        none.quota_summary = Some("rate-limited".to_string());
        assert_eq!(read_quota_left_percent(&none, true), -1);
    }

    #[test]
    fn direct_percent_field_wins_and_is_clamped() {
        let mut info = row(0, AccountStatus::Ok, Some(250.0), Some(-9.0), 10);
        info.quota_summary = Some("5h 10% | 7d 10%".to_string());
        assert_eq!(read_quota_left_percent(&info, true), 100);
        assert_eq!(read_quota_left_percent(&info, false), 0);
    }

    #[test]
    fn pin_current_moves_to_front_only_when_tied() {
        let mut settings = default_settings();
        settings.menu_sort_pin_current = true;

        // Current row equally ready → pinned to the front.
        let mut current = row(0, AccountStatus::Active, Some(50.0), Some(50.0), 10);
        current.is_current_account = Some(true);
        let other = row(1, AccountStatus::Ok, Some(50.0), Some(50.0), 10);
        let mut rows = vec![other.clone(), current.clone()];
        apply_account_menu_ordering(&mut rows, &settings);
        assert_eq!(rows[0].is_current_account, Some(true));

        // Current row strictly worse (rate-limited) → stays where sorted.
        let mut limited_current = row(0, AccountStatus::RateLimited, Some(0.0), Some(0.0), 10);
        limited_current.is_current_account = Some(true);
        let mut rows = vec![other.clone(), limited_current];
        apply_account_menu_ordering(&mut rows, &settings);
        assert_eq!(rows[0].is_current_account, None);
        assert_eq!(rows[1].is_current_account, Some(true));
    }

    #[test]
    fn quick_switch_can_follow_source_indexes() {
        let mut settings = default_settings();
        settings.menu_sort_quick_switch_visible_row = false;
        let mut rows = vec![
            row(0, AccountStatus::RateLimited, Some(10.0), Some(10.0), 10),
            row(1, AccountStatus::Ok, Some(90.0), Some(90.0), 10),
        ];
        apply_account_menu_ordering(&mut rows, &settings);
        // Visible first row is source index 1 → quick switch number stays 2.
        assert_eq!(rows[0].source_index, Some(1));
        assert_eq!(rows[0].quick_switch_number, Some(2));
    }

    #[test]
    fn manual_sort_mode_keeps_source_order() {
        let mut settings = default_settings();
        settings.menu_sort_mode = DashboardAccountSortMode::Manual;
        let mut rows = vec![
            row(0, AccountStatus::Disabled, None, None, 0),
            row(1, AccountStatus::Ok, Some(90.0), Some(90.0), 10),
        ];
        apply_account_menu_ordering(&mut rows, &settings);
        assert_eq!(rows[0].source_index, Some(0));
        assert_eq!(rows[0].quick_switch_number, Some(1));
    }
}
