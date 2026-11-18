//! Port of `settings-hub/experimental.ts` + `experimental-settings-prompt.ts`
//! + `experimental-sync-target.ts` (entry shims absorbed) — the experimental
//!   settings panel (oc-chatgpt sync preview/apply, named-backup export,
//!   refresh-guardian toggle + interval).
//!
//! The oc-chatgpt planner/applier lives in the sibling-owned
//! `crate::oc_chatgpt` cluster; this module mirrors the TS DI seam
//! (`ExperimentalSettingsPromptDeps`): the plan/apply operations are injected
//! via [`ExperimentalSyncHooks`] which the dispatcher installs at startup.
//! Everything else (state machine, frozen strings, bounds) lives here.

use std::io::{BufRead, Write};
use std::sync::{Mutex, OnceLock};

use cma_core::schemas::account_storage::AccountStorageV3;
use cma_core::schemas::plugin_config::PluginConfig;
use cma_tui::runtime_options::get_ui_runtime_options;
use cma_tui::select::{select, MenuColor, MenuItem, SelectInputResult, SelectOptions};
use cma_tui::ui_copy;

use crate::settings::backend::clone_backend_plugin_config;
use crate::settings::hub::is_tty_interactive;
use crate::settings::schema::{
    backend_number_option_by_key, map_experimental_menu_hotkey, map_experimental_status_hotkey,
    BackendNumberSettingKey, ExperimentalSettingsAction,
};

// ---------------------------------------------------------------------------
// Sync-target state (`experimental-sync-target.ts`) — generic over the
// detection payload exactly like the TS `<TTargetState>` DI.
// ---------------------------------------------------------------------------

/// `ExperimentalSyncTargetState`.
#[derive(Clone, Debug, PartialEq)]
pub enum ExperimentalSyncTargetState<D> {
    BlockedAmbiguous { detection: D },
    BlockedNone { detection: D },
    Error { message: String },
    Target {
        detection: D,
        /// `None` when the target account file does not exist yet.
        destination: Option<AccountStorageV3>,
    },
}

/// Detection outcome fed into [`load_experimental_sync_target_state`].
#[derive(Clone, Debug, PartialEq)]
pub enum SyncTargetDetection<D> {
    Ambiguous(D),
    None(D),
    Target { detection: D, account_path: String },
}

/// `loadExperimentalSyncTargetState({detectTarget, readJson,
/// normalizeAccountStorage})` — ENOENT → target with `destination: None`;
/// normalize-null → `"Invalid target account storage format"`; other read
/// errors → error with the message.
pub async fn load_experimental_sync_target_state<D, ReadFut>(
    detect_target: impl FnOnce() -> SyncTargetDetection<D>,
    read_json: impl FnOnce(String) -> ReadFut,
    normalize_account_storage: impl FnOnce(&serde_json::Value) -> Option<AccountStorageV3>,
) -> ExperimentalSyncTargetState<D>
where
    ReadFut: std::future::Future<Output = Result<serde_json::Value, std::io::Error>>,
{
    let (detection, account_path) = match detect_target() {
        SyncTargetDetection::Ambiguous(detection) => {
            return ExperimentalSyncTargetState::BlockedAmbiguous { detection };
        }
        SyncTargetDetection::None(detection) => {
            return ExperimentalSyncTargetState::BlockedNone { detection };
        }
        SyncTargetDetection::Target {
            detection,
            account_path,
        } => (detection, account_path),
    };
    match read_json(account_path).await {
        Ok(raw) => match normalize_account_storage(&raw) {
            Some(normalized) => ExperimentalSyncTargetState::Target {
                detection,
                destination: Some(normalized),
            },
            None => ExperimentalSyncTargetState::Error {
                message: "Invalid target account storage format".to_string(),
            },
        },
        Err(error) => {
            if cma_core::fs_retry::code_of(&error) == Some("ENOENT") {
                return ExperimentalSyncTargetState::Target {
                    detection,
                    destination: None,
                };
            }
            ExperimentalSyncTargetState::Error {
                message: error.to_string(),
            }
        }
    }
}

/// `readJson` binding from `experimental-sync-target-entry.ts`:
/// `JSON.parse(readFileWithRetry(path, {EBUSY,EPERM,EAGAIN} × 4, sleep))`.
pub async fn read_sync_target_json(path: String) -> Result<serde_json::Value, std::io::Error> {
    let content = crate::settings::persist::read_file_with_retry(
        std::path::Path::new(&path),
        &["EBUSY", "EPERM", "EAGAIN"],
        4,
        crate::settings::write_queue::default_sleep,
    )
    .await?;
    serde_json::from_str(&content)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))
}

// ---------------------------------------------------------------------------
// Plan / apply data shapes + frozen-string mappers
// (`settings-hub/experimental.ts` accessor lambdas)
// ---------------------------------------------------------------------------

/// Counts shown on the preview screen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExperimentalSyncPlanPreview {
    pub to_add: usize,
    pub to_update: usize,
    pub to_skip: usize,
    pub unchanged_destination_only: usize,
}

/// Cause of a `plan-error` (chatgpt-import-06).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncPlanErrorCause {
    Load,
    Preview,
}

/// Plan outcome, shaped after the TS accessor contract.
#[derive(Clone, Debug, PartialEq)]
pub enum ExperimentalSyncPlan {
    Ready {
        preview: ExperimentalSyncPlanPreview,
        active_selection_behavior: String,
    },
    PlanError {
        cause: SyncPlanErrorCause,
        detail: String,
    },
    BlockedAmbiguous {
        reason: Option<String>,
    },
    Blocked {
        reason: Option<String>,
    },
}

/// Apply outcome, shaped after the TS accessor contract.
#[derive(Clone, Debug, PartialEq)]
pub enum ExperimentalSyncApplied {
    Applied { account_path: Option<String> },
    Error { message: String },
    Other,
}

/// `getPlanBlockedReason` — frozen strings (spec 09 §5.14).
pub fn get_plan_blocked_reason(plan: &ExperimentalSyncPlan) -> String {
    match plan {
        ExperimentalSyncPlan::PlanError { cause, detail } => format!(
            "Sync failed while {}: {detail}",
            match cause {
                SyncPlanErrorCause::Load => "loading the target",
                SyncPlanErrorCause::Preview => "previewing the merge",
            }
        ),
        ExperimentalSyncPlan::BlockedAmbiguous { reason } => format!(
            "Sync blocked: {}",
            reason.as_deref().unwrap_or("unknown")
        ),
        ExperimentalSyncPlan::Blocked { reason } => format!(
            "Sync unavailable: {}",
            reason.as_deref().unwrap_or("unknown")
        ),
        ExperimentalSyncPlan::Ready { .. } => String::new(),
    }
}

/// `getAppliedLabel` — label + tone color.
pub fn get_applied_label(applied: &ExperimentalSyncApplied) -> (String, MenuColor) {
    match applied {
        ExperimentalSyncApplied::Applied { account_path } => (
            format!(
                "Applied sync to {}",
                account_path.as_deref().unwrap_or("target")
            ),
            MenuColor::Green,
        ),
        ExperimentalSyncApplied::Error { message } => (message.clone(), MenuColor::Yellow),
        ExperimentalSyncApplied::Other => ("Sync did not apply".to_string(), MenuColor::Yellow),
    }
}

// ---------------------------------------------------------------------------
// Sync hooks — the DI seam standing in for `oc-chatgpt-orchestrator` /
// `oc-chatgpt-target-detection` (sibling cluster). The dispatcher installs
// concrete bindings at startup.
// ---------------------------------------------------------------------------

pub type SyncPlanFuture = std::pin::Pin<Box<dyn std::future::Future<Output = ExperimentalSyncPlan> + Send>>;
pub type SyncApplyFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = ExperimentalSyncApplied> + Send>>;

pub struct ExperimentalSyncHooks {
    /// `planOcChatgptSync({source, destination, dependencies})` — plan for
    /// preview. `destination` carries the pre-loaded target when the state
    /// was `target`.
    pub plan: Box<
        dyn Fn(Option<AccountStorageV3>, Option<AccountStorageV3>) -> SyncPlanFuture + Send + Sync,
    >,
    /// `applyOcChatgptSync` — the real apply.
    pub apply: Box<
        dyn Fn(Option<AccountStorageV3>, Option<AccountStorageV3>) -> SyncApplyFuture + Send + Sync,
    >,
    /// `loadExperimentalSyncTarget()` — concrete detection + read binding.
    pub load_target: Box<dyn Fn() -> SyncTargetFuture + Send + Sync>,
}

/// Boxed future returned by [`ExperimentalSyncHooks::load_target`].
pub type SyncTargetFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = ExperimentalSyncTargetState<String>> + Send>,
>;

static SYNC_HOOKS: OnceLock<Mutex<Option<ExperimentalSyncHooks>>> = OnceLock::new();

/// Install the concrete oc-chatgpt bindings (dispatcher startup).
pub fn set_experimental_sync_hooks(hooks: Option<ExperimentalSyncHooks>) {
    let cell = SYNC_HOOKS.get_or_init(|| Mutex::new(None));
    *cell.lock().expect("sync hooks poisoned") = hooks;
}

fn with_sync_hooks<T>(f: impl FnOnce(Option<&ExperimentalSyncHooks>) -> T) -> T {
    let cell = SYNC_HOOKS.get_or_init(|| Mutex::new(None));
    let guard = cell.lock().expect("sync hooks poisoned");
    f(guard.as_ref())
}

// ---------------------------------------------------------------------------
// Interactive panel (`experimental-settings-prompt.ts`)
// ---------------------------------------------------------------------------

/// Refresh-interval bounds derived from the `proactiveRefreshIntervalMs`
/// schema entry with the historical fallbacks (settings-hub-01 divergence
/// fix). The Rust schema entry always exists, so the fallbacks are dead but
/// kept for parity documentation: 60_000 / 600_000 / 60_000.
fn refresh_interval_bounds() -> (f64, f64, f64) {
    let option = backend_number_option_by_key(BackendNumberSettingKey::ProactiveRefreshIntervalMs);
    (option.min, option.max, option.step)
}

fn question(prompt: &str) -> String {
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "{prompt}");
    let _ = stdout.flush();
    let mut answer = String::new();
    let _ = std::io::stdin().lock().read_line(&mut answer);
    answer.trim_end_matches(['\r', '\n']).to_string()
}

/// Show a one-line status screen with a single Back item (`q` hotkey).
fn show_status_screen(message: &str, color: MenuColor) {
    let ui = get_ui_runtime_options();
    let items = vec![
        MenuItem::new(message.to_string(), ExperimentalSettingsAction::Back).with_color(color),
        MenuItem::new(ui_copy::settings::BACK, ExperimentalSettingsAction::Back)
            .with_color(MenuColor::Red),
    ];
    let mut options: SelectOptions<'_, ExperimentalSettingsAction> =
        SelectOptions::new(ui_copy::settings::EXPERIMENTAL_TITLE);
    options.subtitle = Some(ui_copy::settings::EXPERIMENTAL_SUBTITLE.to_string());
    options.help = Some(ui_copy::settings::EXPERIMENTAL_HELP_STATUS.to_string());
    options.clear_screen = true;
    options.theme = Some(ui.theme.clone());
    options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
    options.on_input = Some(Box::new(|raw, _ctx| {
        match map_experimental_status_hotkey(raw) {
            Some(action) => SelectInputResult::Finish(Some(action)),
            None => SelectInputResult::Ignored,
        }
    }));
    let _ = select(&items, options);
}

/// The sync flow: load target → plan → preview screen → optional apply.
async fn run_sync_flow() {
    let target_state =
        with_sync_hooks(|hooks| hooks.map(|hooks| (hooks.load_target)()));

    let Some(target_future) = target_state else {
        // No bindings installed: surface the blocked-none path.
        show_status_screen(
            &get_plan_blocked_reason(&ExperimentalSyncPlan::Blocked { reason: None }),
            MenuColor::Yellow,
        );
        return;
    };
    let target = target_future.await;
    if let ExperimentalSyncTargetState::Error { message } = &target {
        show_status_screen(message, MenuColor::Yellow);
        return;
    }
    let source = cma_storage::load::load_accounts()
        .await
        .map(|loaded| loaded.storage);
    let destination = match &target {
        ExperimentalSyncTargetState::Target { destination, .. } => destination.clone(),
        _ => None,
    };
    let plan = with_sync_hooks(|hooks| hooks.map(|hooks| (hooks.plan)(source.clone(), destination.clone())));
    let Some(plan_future) = plan else {
        show_status_screen(
            &get_plan_blocked_reason(&ExperimentalSyncPlan::Blocked { reason: None }),
            MenuColor::Yellow,
        );
        return;
    };
    let plan = plan_future.await;
    let ExperimentalSyncPlan::Ready {
        preview,
        active_selection_behavior,
    } = &plan
    else {
        show_status_screen(&get_plan_blocked_reason(&plan), MenuColor::Yellow);
        return;
    };

    // Preview screen: apply (hotkey `a`) or back.
    let ui = get_ui_runtime_options();
    let items = vec![
        MenuItem::new(
            format!(
                "Preview: add {} | update {} | skip {}",
                preview.to_add, preview.to_update, preview.to_skip
            ),
            ExperimentalSettingsAction::Back,
        )
        .with_color(MenuColor::Green),
        MenuItem::new(
            format!(
                "Preserve destination-only: {}",
                preview.unchanged_destination_only
            ),
            ExperimentalSettingsAction::Back,
        ),
        MenuItem::new(
            format!("Active selection: {active_selection_behavior}"),
            ExperimentalSettingsAction::Back,
        ),
        MenuItem::new(
            ui_copy::settings::EXPERIMENTAL_APPLY_SYNC,
            ExperimentalSettingsAction::Apply,
        )
        .with_color(MenuColor::Green),
        MenuItem::new(ui_copy::settings::BACK, ExperimentalSettingsAction::Back)
            .with_color(MenuColor::Red),
    ];
    let mut options: SelectOptions<'_, ExperimentalSettingsAction> =
        SelectOptions::new(ui_copy::settings::EXPERIMENTAL_TITLE);
    options.subtitle = Some(ui_copy::settings::EXPERIMENTAL_SUBTITLE.to_string());
    options.help = Some(ui_copy::settings::EXPERIMENTAL_HELP_PREVIEW.to_string());
    options.clear_screen = true;
    options.theme = Some(ui.theme.clone());
    options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
    options.on_input = Some(Box::new(|raw, _ctx| {
        let lower = raw.to_lowercase();
        if lower == "a" {
            return SelectInputResult::Finish(Some(ExperimentalSettingsAction::Apply));
        }
        if lower == "q" {
            return SelectInputResult::Finish(Some(ExperimentalSettingsAction::Back));
        }
        SelectInputResult::Ignored
    }));
    let choice = select(&items, options).ok().flatten();
    if choice != Some(ExperimentalSettingsAction::Apply) {
        return;
    }

    let apply =
        with_sync_hooks(|hooks| hooks.map(|hooks| (hooks.apply)(source.clone(), destination)));
    let Some(apply_future) = apply else {
        return;
    };
    let applied = apply_future.await;
    let (label, color) = get_applied_label(&applied);
    show_status_screen(&label, color);
}

/// The backup flow: name prompt → `runNamedBackupExport` → status screen.
async fn run_backup_flow() {
    let answer = question(ui_copy::settings::EXPERIMENTAL_BACKUP_PROMPT);
    let trimmed = answer.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("q") {
        return;
    }
    match cma_storage::named_backups::export_named_backup(trimmed, false).await {
        Ok(path) => show_status_screen(&format!("Saved backup to {path}"), MenuColor::Green),
        Err(error) => {
            // Collision (EEXIST / "File already exists") maps to the frozen
            // collision copy; other errors show their message.
            let message = error.message().to_string();
            if message.starts_with("File already exists: ") {
                let path = message.trim_start_matches("File already exists: ");
                show_status_screen(
                    &format!("Backup already exists: {path}"),
                    MenuColor::Yellow,
                );
            } else {
                show_status_screen(&message, MenuColor::Yellow);
            }
        }
    }
}

/// `promptExperimentalSettings(initialConfig)` — non-interactive → `None`;
/// only "Save and back" returns the draft (spec 09 gotcha 23).
pub async fn prompt_experimental_settings(initial_config: &PluginConfig) -> Option<PluginConfig> {
    if !is_tty_interactive() {
        return None;
    }
    let mut draft = clone_backend_plugin_config(initial_config);
    let (min_interval, max_interval, step_interval) = refresh_interval_bounds();

    loop {
        let ui = get_ui_runtime_options();
        let guard_enabled = draft.proactive_refresh_guardian.unwrap_or(false);
        let interval_ms = draft.proactive_refresh_interval_ms.unwrap_or(60_000.0);
        let interval_label =
            cma_accounts::rate_limits::format_wait_time(interval_ms.round() as i64);

        let mut items: Vec<MenuItem<ExperimentalSettingsAction>> = vec![
            MenuItem::new(
                ui_copy::settings::EXPERIMENTAL_SYNC,
                ExperimentalSettingsAction::Sync,
            )
            .with_color(MenuColor::Yellow),
            MenuItem::new(
                ui_copy::settings::EXPERIMENTAL_BACKUP,
                ExperimentalSettingsAction::Backup,
            )
            .with_color(MenuColor::Green),
            MenuItem::new(
                format!(
                    "{} {}",
                    if guard_enabled { "[x]" } else { "[ ]" },
                    ui_copy::settings::EXPERIMENTAL_REFRESH_GUARD
                ),
                ExperimentalSettingsAction::ToggleRefreshGuardian,
            )
            .with_color(if guard_enabled {
                MenuColor::Green
            } else {
                MenuColor::Yellow
            }),
        ];
        let mut interval_row = MenuItem::new(
            format!(
                "{}: {}",
                ui_copy::settings::EXPERIMENTAL_REFRESH_INTERVAL,
                interval_label
            ),
            ExperimentalSettingsAction::Back,
        );
        interval_row.disabled = true;
        interval_row.hide_unavailable_suffix = true;
        items.push(interval_row);
        items.push(
            MenuItem::new(
                ui_copy::settings::EXPERIMENTAL_DECREASE_INTERVAL,
                ExperimentalSettingsAction::DecreaseRefreshInterval,
            )
            .with_color(MenuColor::Yellow),
        );
        items.push(
            MenuItem::new(
                ui_copy::settings::EXPERIMENTAL_INCREASE_INTERVAL,
                ExperimentalSettingsAction::IncreaseRefreshInterval,
            )
            .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(
                ui_copy::settings::SAVE_AND_BACK,
                ExperimentalSettingsAction::Save,
            )
            .with_color(MenuColor::Green),
        );
        items.push(
            MenuItem::new(ui_copy::settings::BACK, ExperimentalSettingsAction::Back)
                .with_color(MenuColor::Red),
        );

        let mut options: SelectOptions<'_, ExperimentalSettingsAction> =
            SelectOptions::new(ui_copy::settings::EXPERIMENTAL_TITLE);
        options.subtitle = Some(ui_copy::settings::EXPERIMENTAL_SUBTITLE.to_string());
        options.help = Some(ui_copy::settings::EXPERIMENTAL_HELP_MENU.to_string());
        options.clear_screen = true;
        options.theme = Some(ui.theme.clone());
        options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Chip);
        options.on_input = Some(Box::new(|raw, _ctx| {
            match map_experimental_menu_hotkey(raw) {
                Some(action) => SelectInputResult::Finish(Some(action)),
                None => SelectInputResult::Ignored,
            }
        }));

        let result = select(&items, options).ok().flatten()?;
        match result {
            ExperimentalSettingsAction::Back => return None,
            ExperimentalSettingsAction::Save => return Some(draft),
            ExperimentalSettingsAction::ToggleRefreshGuardian => {
                draft.proactive_refresh_guardian = Some(!guard_enabled);
            }
            ExperimentalSettingsAction::DecreaseRefreshInterval => {
                let next = (interval_ms - step_interval).clamp(min_interval, max_interval);
                draft.proactive_refresh_interval_ms = Some(next);
            }
            ExperimentalSettingsAction::IncreaseRefreshInterval => {
                let next = (interval_ms + step_interval).clamp(min_interval, max_interval);
                draft.proactive_refresh_interval_ms = Some(next);
            }
            ExperimentalSettingsAction::Backup => {
                run_backup_flow().await;
            }
            ExperimentalSettingsAction::Sync => {
                run_sync_flow().await;
            }
            ExperimentalSettingsAction::Apply => {
                // Only reachable from the preview screen; ignore here.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sync_target_state_classification() {
        // Ambiguous short-circuits.
        let state = load_experimental_sync_target_state(
            || SyncTargetDetection::Ambiguous("amb"),
            |_path| async { Ok(serde_json::json!({})) },
            |_value| None,
        )
        .await;
        assert!(matches!(
            state,
            ExperimentalSyncTargetState::BlockedAmbiguous { detection: "amb" }
        ));

        // None short-circuits.
        let state = load_experimental_sync_target_state(
            || SyncTargetDetection::None("none"),
            |_path| async { Ok(serde_json::json!({})) },
            |_value| None,
        )
        .await;
        assert!(matches!(
            state,
            ExperimentalSyncTargetState::BlockedNone { detection: "none" }
        ));

        // Normalize-null → frozen invalid-format error.
        let state = load_experimental_sync_target_state(
            || SyncTargetDetection::Target {
                detection: "t",
                account_path: "x.json".to_string(),
            },
            |_path| async { Ok(serde_json::json!({"bogus": true})) },
            |_value| None,
        )
        .await;
        assert_eq!(
            state,
            ExperimentalSyncTargetState::Error {
                message: "Invalid target account storage format".to_string()
            }
        );

        // ENOENT → target with destination None.
        let state = load_experimental_sync_target_state(
            || SyncTargetDetection::Target {
                detection: "t",
                account_path: "missing.json".to_string(),
            },
            |_path| async {
                Err(cma_core::fs_retry::io_error_with_code(
                    "ENOENT",
                    "no such file",
                ))
            },
            |_value| Some(AccountStorageV3::empty()),
        )
        .await;
        assert!(matches!(
            state,
            ExperimentalSyncTargetState::Target {
                destination: None,
                ..
            }
        ));

        // Other errors → error with the message.
        let state = load_experimental_sync_target_state(
            || SyncTargetDetection::Target {
                detection: "t",
                account_path: "busy.json".to_string(),
            },
            |_path| async {
                Err(cma_core::fs_retry::io_error_with_code("EBUSY", "locked"))
            },
            |_value| Some(AccountStorageV3::empty()),
        )
        .await;
        assert!(matches!(state, ExperimentalSyncTargetState::Error { .. }));

        // Valid target parses through.
        let state = load_experimental_sync_target_state(
            || SyncTargetDetection::Target {
                detection: "t",
                account_path: "ok.json".to_string(),
            },
            |_path| async { Ok(serde_json::json!({"version": 3})) },
            |_value| Some(AccountStorageV3::empty()),
        )
        .await;
        assert!(matches!(
            state,
            ExperimentalSyncTargetState::Target {
                destination: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn plan_blocked_reasons_use_the_frozen_strings() {
        assert_eq!(
            get_plan_blocked_reason(&ExperimentalSyncPlan::PlanError {
                cause: SyncPlanErrorCause::Load,
                detail: "corrupt file".to_string(),
            }),
            "Sync failed while loading the target: corrupt file"
        );
        assert_eq!(
            get_plan_blocked_reason(&ExperimentalSyncPlan::PlanError {
                cause: SyncPlanErrorCause::Preview,
                detail: "boom".to_string(),
            }),
            "Sync failed while previewing the merge: boom"
        );
        assert_eq!(
            get_plan_blocked_reason(&ExperimentalSyncPlan::BlockedAmbiguous {
                reason: Some("two targets".to_string()),
            }),
            "Sync blocked: two targets"
        );
        assert_eq!(
            get_plan_blocked_reason(&ExperimentalSyncPlan::Blocked { reason: None }),
            "Sync unavailable: unknown"
        );
    }

    #[test]
    fn applied_labels_use_the_frozen_strings() {
        assert_eq!(
            get_applied_label(&ExperimentalSyncApplied::Applied {
                account_path: Some("/x/accounts.json".to_string()),
            }),
            (
                "Applied sync to /x/accounts.json".to_string(),
                MenuColor::Green
            )
        );
        assert_eq!(
            get_applied_label(&ExperimentalSyncApplied::Applied { account_path: None }),
            ("Applied sync to target".to_string(), MenuColor::Green)
        );
        assert_eq!(
            get_applied_label(&ExperimentalSyncApplied::Error {
                message: "denied".to_string(),
            }),
            ("denied".to_string(), MenuColor::Yellow)
        );
        assert_eq!(
            get_applied_label(&ExperimentalSyncApplied::Other),
            ("Sync did not apply".to_string(), MenuColor::Yellow)
        );
    }

    #[test]
    fn refresh_interval_bounds_come_from_the_schema() {
        assert_eq!(refresh_interval_bounds(), (5_000.0, 600_000.0, 5_000.0));
    }
}
