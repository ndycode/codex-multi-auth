//! Port of `lib/codex-manager/login-flow.ts` — the interactive control loop
//! for the `login` command: the account dashboard menu and the
//! add-account/onboarding flow.
//!
//! The TS closure-mutable menu quota-refresh bookkeeping is an explicit
//! [`MenuQuotaRefreshState`]: the fire-and-forget refresh runs as a spawned
//! tokio task sharing status/generation/skip-flag cells, and
//! [`drain_pending_menu_quota_refresh`] awaits it on EVERY path that leaves
//! the dashboard loop (add-account, cancel/exit, empty pool) so the cache
//! save cannot race an account-pool write (Windows EBUSY/EPERM on sibling
//! files) or be orphaned mid-write.
//!
//! The TS `LoginFlowDeps` DI shim (runForecast/createRepairCommandDeps) is
//! absorbed per ARCHITECTURE §4 item 10 — the sibling command modules are
//! called directly.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cma_auth::browser::is_browser_launch_suppressed;
use cma_config::dashboard_settings::load_dashboard_display_settings;
use cma_core::constants::ACCOUNT_LIMITS;
use cma_core::errors::CodexError;
use cma_core::logger::create_logger;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{AccountStorageV3, PersistedSwitchReason};
use cma_core::schemas::token::TokenResult;
use cma_core::utils::now_ms;
use cma_quota::cache::{load_quota_cache, QuotaCacheEntry};
use cma_runtime::account_status::resolve_active_index;
use cma_storage::backup_restore::restore_accounts_from_backup;
use cma_storage::clear::clear_accounts;
use cma_storage::flagged::load_flagged_accounts;
use cma_storage::load::load_accounts;
use cma_storage::misc::format_storage_error_hint_for_code;
use cma_storage::named_backups::{get_named_backups, NamedBackupSummary};
use cma_tui::auth_menu_builder::{AuthMenuOptions, StatusMessage};
use cma_tui::confirm::confirm;
use cma_tui::login_prompts::{
    prompt_add_another_account, prompt_login_mode, LoginMenuResult, LoginMode,
};
use cma_tui::ui_copy;

use crate::dispatcher::CliOut;
use crate::formatters::quota::{format_account_quota_summary, CompactQuotaFormatOptions};
use crate::formatters::text_style::{style_prompt_text, PromptTone};
use crate::help::{parse_auth_login_args, print_usage, AuthLoginOptions, ParsedAuthLoginArgs};
use crate::login::account_pool_write::AccountPoolWriteOutcome;
use crate::login::action_panel::run_action_panel;
use crate::login::menu_actions::{
    handle_manage_action, prompt_backup_restore_mode, prompt_manual_backup_selection,
    prompt_oauth_sign_in_mode, BackupRestoreMode,
};
use crate::login::menu_data::{
    count_menu_quota_refresh_targets, load_runtime_current_selection_for_storage,
    refresh_quota_cache_for_menu, sync_codex_cli_active_selection_if_drifted,
    to_existing_account_info,
};
use crate::login::oauth::{
    is_oauth_cancellation, persist_account_pool, resolve_account_selection, run_sign_in_flow,
    sync_selection_to_codex, OAuthSignInMode,
};
use crate::login::persist_selected::{
    persist_and_sync_selected_account, PersistSelectedAccountParams,
};
use crate::settings::hub::apply_ui_theme_from_dashboard_settings;
use crate::settings::persist::configure_unified_settings;

/// Cells shared with the fire-and-forget quota-refresh task (the TS
/// closure-captured `MenuQuotaRefreshState` fields that outlive one loop
/// pass).
struct MenuQuotaShared {
    /// `menuQuotaRefreshStatus` — the live `Fetching account limits...
    /// [n/total]` subtitle.
    status: Mutex<Option<String>>,
    /// `menuQuotaRefreshGeneration` — invalidates the in-flight refresh's
    /// "skip next pass" side effect.
    generation: AtomicU64,
    /// `skipNextMenuQuotaAutoRefresh`.
    skip_next: AtomicBool,
}

/// TS `MenuQuotaRefreshState`.
pub(crate) struct MenuQuotaRefreshState {
    shared: Arc<MenuQuotaShared>,
    /// `pendingMenuQuotaRefresh` — the in-flight refresh task, if any.
    pending: Option<tokio::task::JoinHandle<()>>,
}

impl MenuQuotaRefreshState {
    fn new() -> Self {
        MenuQuotaRefreshState {
            shared: Arc::new(MenuQuotaShared {
                status: Mutex::new(None),
                generation: AtomicU64::new(0),
                skip_next: AtomicBool::new(false),
            }),
            pending: None,
        }
    }

    /// TS `pendingMenuQuotaRefresh !== null` (the promise nulls itself in
    /// `.finally`; a finished join handle is equivalent).
    fn has_pending(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
    }
}

/// TS `clearMenuQuotaAutoRefreshSkip(state)`.
fn clear_menu_quota_auto_refresh_skip(state: &MenuQuotaRefreshState) {
    state.shared.skip_next.store(false, Ordering::SeqCst);
    state.shared.generation.fetch_add(1, Ordering::SeqCst);
}

/// TS `drainPendingMenuQuotaRefresh(state)` — must run on every exit path
/// from the dashboard loop. The chain never rejects (all failure paths are
/// absorbed inside the task).
async fn drain_pending_menu_quota_refresh(state: &mut MenuQuotaRefreshState) {
    if let Some(handle) = state.pending.take() {
        let _ = handle.await;
    }
}

/// `runLoginDashboardLoop` outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DashboardOutcome {
    AddAccount,
    Exit,
}

/// The message printed after a successful sign-in persist (issue #512: only
/// claim a new saved slot when one was actually appended).
pub(crate) fn outcome_message(outcome: Option<AccountPoolWriteOutcome>, count: usize) -> String {
    match outcome {
        Some(AccountPoolWriteOutcome::Rebound) => {
            format!("Rebound workspace for existing account. Total: {count}")
        }
        Some(AccountPoolWriteOutcome::Updated) => {
            format!("Updated existing account. Total: {count}")
        }
        _ => format!("Added account. Total: {count}"),
    }
}

/// Explicit transports (`--device-auth`, `--manual`, `--no-browser`) bypass
/// the dashboard AND every "fall back to menu" path (spec 09 gotcha 13).
pub(crate) fn is_explicit_sign_in_mode(options: &AuthLoginOptions) -> bool {
    options.device_auth || options.manual
}

/// Resolve the sign-in transport without prompting; `None` means "ask the
/// user" (TS: `deviceAuth ? "device" : preferManualMode ? "manual" : prompt`).
pub(crate) fn resolve_forced_sign_in_mode(
    device_auth: bool,
    prefer_manual: bool,
) -> Option<OAuthSignInMode> {
    if device_auth {
        Some(OAuthSignInMode::Device)
    } else if prefer_manual {
        Some(OAuthSignInMode::Manual)
    } else {
        None
    }
}

/// Restore-panel failure: the TS catch distinguishes `StorageError` (printed
/// through `formatStorageErrorHint`) from every other error message.
enum RestoreActionError {
    Storage(CodexError),
    Message(String),
}

impl std::fmt::Display for RestoreActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RestoreActionError::Storage(error) => f.write_str(error.message()),
            RestoreActionError::Message(message) => f.write_str(message),
        }
    }
}

/// `@internal runAuthLogin(args, deps)`.
pub async fn run_auth_login(args: &[String], out: &mut CliOut) -> i32 {
    match parse_auth_login_args(args) {
        ParsedAuthLoginArgs::Error(message) => {
            out.error(message);
            print_usage(out);
            1
        }
        // The parent dispatcher prints usage for `--help`; this layer returns
        // 0 silently (TS parity).
        ParsedAuthLoginArgs::Help => 0,
        ParsedAuthLoginArgs::Ok(options) => {
            // `--org <id>` binds this login to a specific workspace/org
            // (issue #491); threaded explicitly, no env mutation.
            if let Some(org) = &options.org {
                out.info(format!("Binding this login to workspace org id: {org}"));
            }
            run_auth_login_flow(&options, out).await
        }
    }
}

async fn run_login_dashboard_loop(
    menu_state: &mut MenuQuotaRefreshState,
    out: &mut CliOut,
) -> Result<DashboardOutcome, String> {
    loop {
        let existing_storage = load_accounts().await.map(|loaded| loaded.storage);
        let Some(mut current_storage) = existing_storage else {
            drain_pending_menu_quota_refresh(menu_state).await;
            return Ok(DashboardOutcome::AddAccount);
        };
        if current_storage.accounts.is_empty() {
            drain_pending_menu_quota_refresh(menu_state).await;
            return Ok(DashboardOutcome::AddAccount);
        }

        let display_settings = load_dashboard_display_settings().await;
        apply_ui_theme_from_dashboard_settings(&display_settings);
        let quota_cache = load_quota_cache().await;
        // The Rust settings struct bakes the `?? true` / TTL defaults in at
        // normalize time (spec 01 §2.11), matching the TS `??` fallbacks.
        let should_auto_fetch_limits = display_settings.menu_auto_fetch_limits;
        let show_fetch_status = display_settings.menu_show_fetch_status;
        let quota_ttl_ms = display_settings.menu_quota_ttl_ms;

        let has_pending = menu_state.has_pending();
        let should_skip_auto_fetch_this_pass =
            !has_pending && menu_state.shared.skip_next.load(Ordering::SeqCst);
        if should_skip_auto_fetch_this_pass {
            menu_state.shared.skip_next.store(false, Ordering::SeqCst);
        }
        if should_auto_fetch_limits && !has_pending && !should_skip_auto_fetch_this_pass {
            let stale_count = count_menu_quota_refresh_targets(
                &current_storage,
                &quota_cache,
                quota_ttl_ms,
                now_ms(),
            );
            if stale_count > 0 {
                if show_fetch_status
                    && let Ok(mut guard) = menu_state.shared.status.lock() {
                        *guard = Some(format!(
                            "{} [0/{stale_count}]",
                            ui_copy::main_menu::LOADING_LIMITS
                        ));
                    }
                let refresh_generation = menu_state.shared.generation.load(Ordering::SeqCst);
                let progress_shared = menu_state.shared.clone();
                let done_shared = menu_state.shared.clone();
                let storage_clone = current_storage.clone();
                let cache_clone = quota_cache.clone();
                let handle = tokio::spawn(async move {
                    let mut progress = move |current: usize, total: usize| {
                        if !show_fetch_status {
                            return;
                        }
                        if let Ok(mut guard) = progress_shared.status.lock() {
                            *guard = Some(format!(
                                "{} [{current}/{total}]",
                                ui_copy::main_menu::LOADING_LIMITS
                            ));
                        }
                    };
                    // Never rejects: probe failures keep cached values and
                    // save failures only warn (spec 09 §1.7).
                    let _ = refresh_quota_cache_for_menu(
                        &storage_clone,
                        &cache_clone,
                        quota_ttl_ms,
                        Some(&mut progress),
                    )
                    .await;
                    if refresh_generation == done_shared.generation.load(Ordering::SeqCst) {
                        done_shared.skip_next.store(true, Ordering::SeqCst);
                    }
                    if let Ok(mut guard) = done_shared.status.lock() {
                        *guard = None;
                    }
                });
                menu_state.pending = Some(handle);
            }
        }

        let flagged_storage = load_flagged_accounts().await;
        let _ = sync_codex_cli_active_selection_if_drifted(&current_storage).await;
        let runtime_current =
            load_runtime_current_selection_for_storage(&current_storage, now_ms()).await;

        let summary_options = CompactQuotaFormatOptions::default();
        let summary_fn = |entry: &QuotaCacheEntry, now: i64| -> String {
            format_account_quota_summary(entry, now, &summary_options)
        };
        let rows = to_existing_account_info(
            &current_storage,
            &quota_cache,
            &display_settings,
            runtime_current.as_ref(),
            &summary_fn,
        );

        let status_shared = menu_state.shared.clone();
        let menu_options = AuthMenuOptions {
            flagged_count: Some(flagged_storage.accounts.len() as i64),
            status_message: if show_fetch_status {
                Some(StatusMessage::Dynamic(Box::new(move || {
                    status_shared
                        .status
                        .lock()
                        .ok()
                        .and_then(|guard| guard.clone())
                })))
            } else {
                None
            },
        };
        let menu_result = prompt_login_mode(&rows, &menu_options)
            .unwrap_or_else(|_| LoginMenuResult::mode(LoginMode::Cancel));

        match menu_result.mode {
            LoginMode::Cancel => {
                out.info("Cancelled.");
                drain_pending_menu_quota_refresh(menu_state).await;
                return Ok(DashboardOutcome::Exit);
            }
            LoginMode::Check => {
                clear_menu_quota_auto_refresh_skip(menu_state);
                let _: Result<(), std::convert::Infallible> = run_action_panel(
                    "Quick Check",
                    "Checking local session + live status",
                    out,
                    Some(&display_settings),
                    |mut panel_out| async move {
                        crate::health_check::run_health_check_with(
                            crate::health_check::HealthCheckOptions {
                                force_refresh: false,
                                live_probe: true,
                                ..Default::default()
                            },
                            &mut panel_out,
                        )
                        .await;
                        (panel_out, Ok(()))
                    },
                )
                .await;
            }
            LoginMode::DeepCheck => {
                clear_menu_quota_auto_refresh_skip(menu_state);
                let _: Result<(), std::convert::Infallible> = run_action_panel(
                    "Deep Check",
                    "Refreshing and testing all accounts",
                    out,
                    Some(&display_settings),
                    |mut panel_out| async move {
                        crate::health_check::run_health_check_with(
                            crate::health_check::HealthCheckOptions {
                                force_refresh: true,
                                live_probe: true,
                                ..Default::default()
                            },
                            &mut panel_out,
                        )
                        .await;
                        (panel_out, Ok(()))
                    },
                )
                .await;
            }
            LoginMode::Forecast => {
                clear_menu_quota_auto_refresh_skip(menu_state);
                let _: Result<(), std::convert::Infallible> = run_action_panel(
                    "Best Account",
                    "Comparing accounts",
                    out,
                    Some(&display_settings),
                    |mut panel_out| async move {
                        let args = vec!["--live".to_string()];
                        let _ = crate::commands::forecast::run_forecast_command(
                            &args,
                            &mut panel_out,
                        )
                        .await;
                        (panel_out, Ok(()))
                    },
                )
                .await;
            }
            LoginMode::Fix => {
                clear_menu_quota_auto_refresh_skip(menu_state);
                let _: Result<(), std::convert::Infallible> = run_action_panel(
                    "Auto-Fix",
                    "Checking and fixing common issues",
                    out,
                    Some(&display_settings),
                    |mut panel_out| async move {
                        let args = vec!["--live".to_string()];
                        let _ = crate::repair::fix::run_fix(&args, &mut panel_out).await;
                        (panel_out, Ok(()))
                    },
                )
                .await;
            }
            LoginMode::Settings => {
                clear_menu_quota_auto_refresh_skip(menu_state);
                let _ = configure_unified_settings(Some(&display_settings)).await;
            }
            LoginMode::VerifyFlagged => {
                clear_menu_quota_auto_refresh_skip(menu_state);
                let _: Result<(), std::convert::Infallible> = run_action_panel(
                    "Problem Account Check",
                    "Checking problem accounts",
                    out,
                    Some(&display_settings),
                    |mut panel_out| async move {
                        let _ = crate::repair::verify_flagged::run_verify_flagged(
                            &[],
                            &mut panel_out,
                        )
                        .await;
                        (panel_out, Ok(()))
                    },
                )
                .await;
            }
            LoginMode::Fresh => {
                if !menu_result.delete_all {
                    continue;
                }
                clear_menu_quota_auto_refresh_skip(menu_state);
                let panel_result: Result<(), String> = run_action_panel(
                    "Reset Accounts",
                    "Deleting all saved accounts",
                    out,
                    Some(&display_settings),
                    |mut panel_out| async move {
                        match clear_accounts().await {
                            Ok(()) => {
                                panel_out.info(
                                    "Cleared saved accounts from active storage. Recovery snapshots remain available.",
                                );
                                (panel_out, Ok(()))
                            }
                            Err(error) => (panel_out, Err(error.to_string())),
                        }
                    },
                )
                .await;
                panel_result?;
            }
            LoginMode::Manage => {
                clear_menu_quota_auto_refresh_skip(menu_state);
                let requires_interactive_oauth = menu_result.refresh_account_index.is_some();
                if requires_interactive_oauth {
                    // Interactive OAuth prompts need the real terminal — the
                    // action panel would capture output and break them.
                    handle_manage_action(&mut current_storage, &menu_result, out)
                        .await
                        .map_err(|error| error.message().to_string())?;
                } else {
                    let storage_ref = &mut current_storage;
                    let menu_result_ref = &menu_result;
                    let panel_result: Result<(), CodexError> = run_action_panel(
                        "Applying Change",
                        "Updating selected account",
                        out,
                        Some(&display_settings),
                        move |mut panel_out| async move {
                            let result =
                                handle_manage_action(storage_ref, menu_result_ref, &mut panel_out)
                                    .await;
                            (panel_out, result)
                        },
                    )
                    .await;
                    if let Err(error) = panel_result {
                        return Err(error.message().to_string());
                    }
                }
            }
            LoginMode::Add => {
                drain_pending_menu_quota_refresh(menu_state).await;
                return Ok(DashboardOutcome::AddAccount);
            }
        }
    }
}

/// TS `loadNamedBackupsForOnboarding` — onboarding-only discovery; a
/// non-ENOENT failure surfaces the frozen warning string and continues with
/// browser/manual sign-in only.
async fn load_named_backups_for_onboarding(
    existing_count: usize,
    warning: &mut Option<String>,
    out: &mut CliOut,
) -> Vec<NamedBackupSummary> {
    if existing_count > 0 {
        *warning = None;
        return Vec::new();
    }
    *warning = None;
    match get_named_backups().await {
        Ok(backups) => backups,
        Err(error) => {
            let code = error.code().to_string();
            create_logger("codex-manager").debug(
                "getNamedBackups failed, skipping restore option",
                Some(&serde_json::json!({
                    "code": code,
                    "error": error.message(),
                })),
            );
            if !code.is_empty() && code != "ENOENT" {
                let text =
                    "Named backup discovery failed. Continuing with browser or manual sign-in only.";
                *warning = Some(text.to_string());
                out.warn(text);
            } else {
                *warning = None;
            }
            Vec::new()
        }
    }
}

/// The Load Backup panel action: restore without persisting, then persist +
/// sync through `persistAndSyncSelectedAccount` with
/// `preserveActiveIndexByFamily: true` and switch reason `"restore"`.
async fn restore_backup_action(
    backup_path: &str,
    backup_file_name: &str,
    out: &mut CliOut,
) -> Result<(), RestoreActionError> {
    let restored_storage: AccountStorageV3 =
        restore_accounts_from_backup(backup_path, Some(false))
            .await
            .map_err(|error| {
                if matches!(error, CodexError::Storage { .. }) {
                    RestoreActionError::Storage(error)
                } else {
                    RestoreActionError::Message(error.message().to_string())
                }
            })?;
    let target_index = resolve_active_index(&restored_storage, ModelFamily::Codex);
    if restored_storage.accounts.get(target_index).is_none() {
        // TS: persistAndSyncSelectedAccount throws `Account ${parsed} not
        // found.` and the restore catch prints it.
        return Err(RestoreActionError::Message(format!(
            "Account {} not found.",
            target_index + 1
        )));
    }
    let account_count = restored_storage.accounts.len();
    let outcome = persist_and_sync_selected_account(PersistSelectedAccountParams {
        storage: restored_storage,
        target_index,
        parsed: target_index as i64 + 1,
        switch_reason: PersistedSwitchReason::Restore,
        initial_sync_id_token: None,
        preserve_active_index_by_family: true,
        set_pin: false,
        clear_pin: false,
        bump_affinity_generation: false,
    })
    .await;
    out.info(ui_copy::oauth::restore_backup_loaded(
        backup_file_name,
        account_count as i64,
    ));
    if !outcome.synced {
        out.warn(ui_copy::oauth::RESTORE_BACKUP_SYNC_WARNING);
    }
    Ok(())
}

async fn run_auth_login_flow(login_options: &AuthLoginOptions, out: &mut CliOut) -> i32 {
    cma_storage::facade::set_storage_path(None);
    let mut menu_state = MenuQuotaRefreshState::new();
    // Explicit transport flags bypass the dashboard even when accounts exist
    // (`login --device-auth` from scripts).
    let explicit_sign_in_mode = is_explicit_sign_in_mode(login_options);

    'login_flow: loop {
        let existing_storage = load_accounts().await.map(|loaded| loaded.storage);
        if !explicit_sign_in_mode
            && existing_storage
                .as_ref()
                .is_some_and(|storage| !storage.accounts.is_empty())
        {
            match run_login_dashboard_loop(&mut menu_state, out).await {
                Ok(DashboardOutcome::Exit) => return 0,
                Ok(DashboardOutcome::AddAccount) => {}
                Err(message) => {
                    // TS surfaced these as an uncaught rejection that ended
                    // the CLI with a nonzero exit; print the message instead
                    // of a Node stack trace.
                    out.error(format!("Error: {message}"));
                    return 1;
                }
            }
        }

        let refreshed_storage = load_accounts().await.map(|loaded| loaded.storage);
        let mut existing_count = refreshed_storage
            .as_ref()
            .map_or(0, |storage| storage.accounts.len());
        let mut force_new_login = existing_count > 0;
        let mut onboarding_backup_discovery_warning: Option<String> = None;
        let mut named_backups =
            load_named_backups_for_onboarding(existing_count, &mut onboarding_backup_discovery_warning, out)
                .await;

        loop {
            let latest_named_backup = named_backups.first().cloned();
            let prefer_manual_mode = login_options.manual || is_browser_launch_suppressed();
            let sign_in_mode = match resolve_forced_sign_in_mode(
                login_options.device_auth,
                prefer_manual_mode,
            ) {
                Some(mode) => mode,
                None => prompt_oauth_sign_in_mode(
                    latest_named_backup.as_ref(),
                    onboarding_backup_discovery_warning.as_deref(),
                ),
            };

            if sign_in_mode == OAuthSignInMode::Cancel {
                if existing_count > 0 {
                    out.info(style_prompt_text(
                        ui_copy::oauth::CANCELLED_BACK_TO_MENU,
                        PromptTone::Muted,
                    ));
                    continue 'login_flow;
                }
                out.info("Cancelled.");
                return 0;
            }

            if sign_in_mode == OAuthSignInMode::RestoreBackup {
                let Some(latest_available_backup) = named_backups.first().cloned() else {
                    named_backups = load_named_backups_for_onboarding(
                        existing_count,
                        &mut onboarding_backup_discovery_warning,
                        out,
                    )
                    .await;
                    continue;
                };
                let restore_mode = prompt_backup_restore_mode(&latest_available_backup);
                if restore_mode == BackupRestoreMode::Back {
                    named_backups = load_named_backups_for_onboarding(
                        existing_count,
                        &mut onboarding_backup_discovery_warning,
                        out,
                    )
                    .await;
                    continue;
                }

                let selected_backup = if restore_mode == BackupRestoreMode::Manual {
                    prompt_manual_backup_selection(&named_backups)
                } else {
                    Some(latest_available_backup)
                };
                let Some(selected_backup) = selected_backup else {
                    named_backups = load_named_backups_for_onboarding(
                        existing_count,
                        &mut onboarding_backup_discovery_warning,
                        out,
                    )
                    .await;
                    continue;
                };

                let confirmed = confirm(
                    &ui_copy::oauth::restore_backup_confirm(
                        &selected_backup.file_name,
                        selected_backup.account_count as i64,
                    ),
                    false,
                )
                .unwrap_or(false);
                if !confirmed {
                    named_backups = load_named_backups_for_onboarding(
                        existing_count,
                        &mut onboarding_backup_discovery_warning,
                        out,
                    )
                    .await;
                    continue;
                }

                let display_settings = load_dashboard_display_settings().await;
                apply_ui_theme_from_dashboard_settings(&display_settings);
                let backup_path = selected_backup.path.clone();
                let backup_file_name = selected_backup.file_name.clone();
                let panel_result: Result<(), RestoreActionError> = run_action_panel(
                    "Load Backup",
                    &format!("Loading {}", selected_backup.file_name),
                    out,
                    Some(&display_settings),
                    move |mut panel_out| async move {
                        let result =
                            restore_backup_action(&backup_path, &backup_file_name, &mut panel_out)
                                .await;
                        (panel_out, result)
                    },
                )
                .await;

                match panel_result {
                    Ok(()) => continue 'login_flow,
                    Err(error) => {
                        match &error {
                            RestoreActionError::Storage(storage_error) => {
                                out.error(format_storage_error_hint_for_code(
                                    Some(storage_error.code()),
                                    &selected_backup.path,
                                ));
                            }
                            RestoreActionError::Message(message) => {
                                out.error(format!("Backup restore failed: {message}"));
                            }
                        }
                        let storage_after_restore_attempt =
                            load_accounts().await.map(|loaded| loaded.storage);
                        if storage_after_restore_attempt
                            .is_some_and(|storage| !storage.accounts.is_empty())
                        {
                            continue 'login_flow;
                        }
                        named_backups = load_named_backups_for_onboarding(
                            existing_count,
                            &mut onboarding_backup_discovery_warning,
                            out,
                        )
                        .await;
                        continue;
                    }
                }
            }

            if !matches!(
                sign_in_mode,
                OAuthSignInMode::Browser | OAuthSignInMode::Manual | OAuthSignInMode::Device
            ) {
                continue;
            }

            let token_result = run_sign_in_flow(force_new_login, sign_in_mode, None).await;
            let tokens = match token_result {
                TokenResult::Success(tokens) => tokens,
                failure => {
                    if is_oauth_cancellation(&failure) {
                        // Explicit mode bypassed the dashboard; falling back
                        // to it would trap the user in the same transport.
                        if explicit_sign_in_mode {
                            out.info("Cancelled.");
                            return 0;
                        }
                        if existing_count > 0 {
                            out.info(style_prompt_text(
                                ui_copy::oauth::CANCELLED_BACK_TO_MENU,
                                PromptTone::Muted,
                            ));
                            continue 'login_flow;
                        }
                        out.info("Cancelled.");
                        return 0;
                    }
                    let detail = match &failure {
                        TokenResult::Failed(failed) => failed
                            .message
                            .clone()
                            .or_else(|| failed.reason.map(|reason| reason.as_str().to_string()))
                            .unwrap_or_else(|| "unknown error".to_string()),
                        TokenResult::Success(_) => unreachable!(),
                    };
                    out.error(format!("Login failed: {detail}"));
                    return 1;
                }
            };

            let resolved = resolve_account_selection(&tokens, login_options.org.as_deref());
            let persist_outcome = match persist_account_pool(std::slice::from_ref(&resolved), false).await {
                Ok(outcome) => outcome,
                Err(error) => {
                    out.error(format!("Error: {}", error.message()));
                    return 1;
                }
            };
            sync_selection_to_codex(&resolved).await;

            let latest_storage = load_accounts().await.map(|loaded| loaded.storage);
            let count = latest_storage.map_or(1, |storage| storage.accounts.len());
            existing_count = count;
            named_backups = Vec::new();
            onboarding_backup_discovery_warning = None;
            out.info(outcome_message(persist_outcome, count));
            out.info("Next steps:");
            out.info("  codex-multi-auth status  Check that the wrapper is active.");
            out.info("  codex-multi-auth check   Confirm your saved accounts look healthy.");
            out.info("  codex-multi-auth list    Review saved accounts before switching.");

            if count >= ACCOUNT_LIMITS.max_accounts {
                out.info(format!(
                    "Reached maximum account limit ({}).",
                    ACCOUNT_LIMITS.max_accounts
                ));
                // In explicit mode the dashboard is bypassed, so falling out
                // of the inner loop would silently start another sign-in
                // session despite the cap.
                if explicit_sign_in_mode {
                    return 0;
                }
                break;
            }

            let add_another = prompt_add_another_account(count as i64);
            if !add_another {
                if explicit_sign_in_mode {
                    return 0;
                }
                break;
            }
            force_new_login = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatcher::OutLine;

    // Port of the login-flow arg handling assertions: parse errors print the
    // message plus usage and exit 1; --help exits 0 silently (the parent
    // dispatcher owns the usage print).
    #[tokio::test]
    async fn parse_error_prints_message_and_usage_then_returns_1() {
        let mut out = CliOut::capture();
        let code = run_auth_login(&["--bogus".to_string()], &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown login option: --bogus");
        // printUsage output follows on stdout.
        assert!(out.info_text().contains("Codex Multi-Auth CLI"));
    }

    #[tokio::test]
    async fn device_auth_combined_with_manual_is_rejected() {
        let mut out = CliOut::capture();
        let code = run_auth_login(
            &["--device-auth".to_string(), "--manual".to_string()],
            &mut out,
        )
        .await;
        assert_eq!(code, 1);
        assert_eq!(
            out.error_text(),
            "Cannot combine --device-auth with --manual"
        );
    }

    // Port of test/login-flow.test.ts "rejects --org without a value and
    // prints usage".
    #[tokio::test]
    async fn org_without_value_is_rejected_with_usage() {
        let mut out = CliOut::capture();
        let code = run_auth_login(&["--org".to_string()], &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(
            out.error_text(),
            "Missing value for --org. Usage: codex-multi-auth login --org <org_id>"
        );
        assert!(out.info_text().contains("Codex Multi-Auth CLI"));
    }

    // Port of "treats a missing backup directory as normal, without warning".
    #[tokio::test]
    #[serial_test::serial(env)]
    async fn missing_backup_directory_is_silent() {
        let _sandbox = cma_testkit::sandbox::EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut warning: Option<String> = None;
        let mut out = CliOut::capture();
        let backups = load_named_backups_for_onboarding(0, &mut warning, &mut out).await;
        assert!(backups.is_empty());
        assert!(warning.is_none());
        assert_eq!(out.warn_text(), "");
    }

    // Discovery is skipped entirely (and the warning cleared) once accounts
    // exist — onboarding-only behavior.
    #[tokio::test]
    #[serial_test::serial(env)]
    async fn backup_discovery_skipped_when_accounts_exist() {
        let _sandbox = cma_testkit::sandbox::EnvSandbox::new();
        let mut warning = Some("stale".to_string());
        let mut out = CliOut::capture();
        let backups = load_named_backups_for_onboarding(2, &mut warning, &mut out).await;
        assert!(backups.is_empty());
        assert!(warning.is_none());
        assert!(out.lines().is_empty());
    }

    #[tokio::test]
    async fn help_returns_0_without_printing() {
        let mut out = CliOut::capture();
        let code = run_auth_login(&["--help".to_string()], &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.lines(), &[] as &[OutLine]);
    }

    #[test]
    fn outcome_message_matches_issue_512_wording() {
        assert_eq!(
            outcome_message(Some(AccountPoolWriteOutcome::Rebound), 3),
            "Rebound workspace for existing account. Total: 3"
        );
        assert_eq!(
            outcome_message(Some(AccountPoolWriteOutcome::Updated), 2),
            "Updated existing account. Total: 2"
        );
        assert_eq!(
            outcome_message(Some(AccountPoolWriteOutcome::Inserted), 4),
            "Added account. Total: 4"
        );
        assert_eq!(outcome_message(None, 1), "Added account. Total: 1");
    }

    #[test]
    fn explicit_mode_covers_device_and_manual_flags() {
        let device = AuthLoginOptions {
            manual: false,
            device_auth: true,
            org: None,
        };
        let manual = AuthLoginOptions {
            manual: true,
            device_auth: false,
            org: None,
        };
        let neither = AuthLoginOptions {
            manual: false,
            device_auth: false,
            org: None,
        };
        assert!(is_explicit_sign_in_mode(&device));
        assert!(is_explicit_sign_in_mode(&manual));
        assert!(!is_explicit_sign_in_mode(&neither));
    }

    #[test]
    fn forced_sign_in_mode_prefers_device_then_manual() {
        assert_eq!(
            resolve_forced_sign_in_mode(true, true),
            Some(OAuthSignInMode::Device)
        );
        assert_eq!(
            resolve_forced_sign_in_mode(false, true),
            Some(OAuthSignInMode::Manual)
        );
        assert_eq!(resolve_forced_sign_in_mode(false, false), None);
    }

    #[test]
    fn menu_quota_state_generation_invalidates_skip() {
        let state = MenuQuotaRefreshState::new();
        state.shared.skip_next.store(true, Ordering::SeqCst);
        let generation_before = state.shared.generation.load(Ordering::SeqCst);
        clear_menu_quota_auto_refresh_skip(&state);
        assert!(!state.shared.skip_next.load(Ordering::SeqCst));
        assert_eq!(
            state.shared.generation.load(Ordering::SeqCst),
            generation_before + 1
        );
    }

    #[tokio::test]
    async fn drain_awaits_and_clears_the_pending_handle() {
        let mut state = MenuQuotaRefreshState::new();
        let shared = state.shared.clone();
        state.pending = Some(tokio::spawn(async move {
            shared.skip_next.store(true, Ordering::SeqCst);
        }));
        drain_pending_menu_quota_refresh(&mut state).await;
        assert!(state.pending.is_none());
        assert!(state.shared.skip_next.load(Ordering::SeqCst));
        assert!(!state.has_pending());
    }
}
