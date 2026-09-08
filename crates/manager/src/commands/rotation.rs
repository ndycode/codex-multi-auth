//! Port of `lib/codex-manager/commands/rotation.ts`.
//!
//! Behavior source: spec 08 §4.15. Gotchas honored here:
//! - `rotation status` and `reset-rate-limits` save/restore the process
//!   storage-path scope (all other commands just set null and leave it);
//!   `reset-rate-limits` HOLDS the null scope across load AND save.
//! - reset-rate-limits deletes only rate-limit keys whose reset time is in
//!   the FUTURE; the JSON `changes` array must equal the actual mutation;
//!   `restartHint` only on real (non-dry-run) changes.
//! - Helper-status file: 1 MiB cap, `kind` must equal
//!   `"codex-app-runtime-rotation-helper"`, `state ∈ {stopped, idle-timeout}`
//!   counts as not running, EPERM-alive PID check, label suppressed when it
//!   contains `"@"` (email leak guard), `lastAccountEmail` never read.
//! - `reset-runtime` / `reset-rate-limits` JSON output is COMPACT.

use cma_accounts::manager::AccountManager;
use cma_accounts::manager_persistence::{format_account_label, format_cooldown};
use cma_accounts::rate_limits::format_wait_time;
use cma_core::constants::APP_RUNTIME_HELPER_STATUS_FILE;
use cma_core::env_parsing::parse_boolean_env;
use cma_core::json_io::stringify_compact;
use cma_core::model_family::ModelFamily;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
use cma_core::schemas::plugin_config::PluginConfig;
use cma_core::utils::now_ms;
use cma_quota::cache::{load_quota_cache, QuotaCacheData};
use cma_quota::readiness::{find_quota_cache_entry_for_account, is_quota_cache_entry_exhausted};
use cma_runtime::app_bind::{
    bind_codex_app_runtime_rotation, format_app_bind_status, get_app_bind_status,
    is_process_alive, unbind_codex_app_runtime_rotation, AppBindOptions, AppBindResult,
    AppBindStatus,
};
use cma_runtime::current_account::{
    app_runtime_helper_status_to_signal, resolve_account_current_markers,
    resolve_runtime_current_account, AppRuntimeHelperAccountStatus, RuntimeCurrentAccountOptions,
    RuntimeCurrentAccountSources,
};
use cma_runtime::observability::{
    load_persisted_runtime_observability_snapshot, record_runtime_reset,
    RuntimeObservabilitySnapshot,
};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    default_get_storage_path, default_load_accounts, default_save_accounts,
    default_set_storage_path, save_accounts_with_retry_boxed, BoxFuture, GetStoragePathFn,
    LoadAccountsFn, SaveAccountsFn, SetStoragePathFn,
};
use crate::rate_limit_markers::is_rate_limited_marker;

// ============================================================================
// App-runtime-helper status file (rotation.ts keeps its OWN tolerant reader —
// it additionally reads idleExpiresAt/totalRequests/rotations and hardcodes
// lastAccountEmail to null for privacy)
// ============================================================================

const MAX_STATUS_FILE_BYTES: u64 = 1024 * 1024; // 1 MB sanity cap

/// TS local `AppRuntimeHelperStatus`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AppRuntimeHelperStatus {
    pub kind: Option<String>,
    pub state: Option<String>,
    pub pid: Option<i64>,
    pub idle_expires_at: Option<i64>,
    pub total_requests: Option<i64>,
    pub rotations: Option<i64>,
    pub last_account_index: Option<i64>,
    pub last_account_label: Option<String>,
    /// Deliberately never read from disk — privacy.
    pub last_account_email: Option<String>,
    pub last_account_id: Option<String>,
    pub last_account_updated_at: Option<i64>,
    pub updated_at: Option<i64>,
}

fn read_optional_number(record: &Map<String, Value>, key: &str) -> Option<i64> {
    let value = record.get(key)?;
    let number = value.as_f64().filter(|v| v.is_finite())?;
    Some(number as i64)
}

fn read_optional_string(record: &Map<String, Value>, key: &str) -> Option<String> {
    let value = record.get(key)?.as_str()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS `readAppRuntimeHelperStatus()`.
pub fn read_app_runtime_helper_status() -> Option<AppRuntimeHelperStatus> {
    let status_path = get_codex_multi_auth_dir().join(APP_RUNTIME_HELPER_STATUS_FILE);
    if !status_path.exists() {
        return None;
    }
    let metadata = std::fs::metadata(&status_path).ok()?;
    if metadata.len() > MAX_STATUS_FILE_BYTES {
        return None;
    }
    let raw = std::fs::read_to_string(&status_path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let record = parsed.as_object()?;
    Some(AppRuntimeHelperStatus {
        state: read_optional_string(record, "state"),
        kind: read_optional_string(record, "kind"),
        pid: read_optional_number(record, "pid"),
        idle_expires_at: read_optional_number(record, "idleExpiresAt"),
        total_requests: read_optional_number(record, "totalRequests"),
        rotations: read_optional_number(record, "rotations"),
        last_account_index: read_optional_number(record, "lastAccountIndex"),
        last_account_label: read_optional_string(record, "lastAccountLabel"),
        last_account_email: None,
        last_account_id: read_optional_string(record, "lastAccountId"),
        last_account_updated_at: read_optional_number(record, "lastAccountUpdatedAt"),
        updated_at: read_optional_number(record, "updatedAt"),
    })
}

fn format_helper_last_account(status: &AppRuntimeHelperStatus) -> Option<String> {
    if let Some(label) = &status.last_account_label
        && !label.contains('@')
    {
        return Some(label.clone());
    }
    if let Some(id) = &status.last_account_id {
        return Some(match status.last_account_index {
            Some(index) => format!("Account {} ({id})", index + 1),
            None => id.clone(),
        });
    }
    status
        .last_account_index
        .map(|index| format!("Account {}", index + 1))
}

/// TS `formatAppRuntimeHelperStatus(now, status)`.
pub fn format_app_runtime_helper_status(now: i64, status: Option<&AppRuntimeHelperStatus>) -> String {
    let Some(status) = status else {
        return "Codex app helper: not running".to_string();
    };
    if status.kind.as_deref() != Some("codex-app-runtime-rotation-helper") {
        return "Codex app helper: not running".to_string();
    }
    let alive = is_process_alive(status.pid);
    if !alive
        || status.state.as_deref() == Some("stopped")
        || status.state.as_deref() == Some("idle-timeout")
    {
        return "Codex app helper: not running".to_string();
    }
    let mut parts = vec![match status.pid {
        Some(pid) if pid != 0 => format!("running pid={pid}"),
        _ => "running".to_string(),
    }];
    if let Some(total_requests) = status.total_requests {
        parts.push(format!("requests={total_requests}"));
    }
    if let Some(rotations) = status.rotations {
        parts.push(format!("rotations={rotations}"));
    }
    if let Some(last_account) = format_helper_last_account(status) {
        parts.push(format!("lastAccount={last_account}"));
    }
    if let Some(idle_expires_at) = status.idle_expires_at
        && idle_expires_at > now
    {
        parts.push(format!("idle-expires={}", format_wait_time(idle_expires_at - now)));
    }
    format!("Codex app helper: {}", parts.join(", "))
}

fn to_runtime_helper_account_status(status: &AppRuntimeHelperStatus) -> AppRuntimeHelperAccountStatus {
    AppRuntimeHelperAccountStatus {
        kind: status.kind.clone(),
        state: status.state.clone(),
        pid: status.pid,
        last_account_index: status.last_account_index,
        last_account_label: status.last_account_label.clone(),
        last_account_email: status.last_account_email.clone(),
        last_account_id: status.last_account_id.clone(),
        last_account_updated_at: status.last_account_updated_at,
        updated_at: status.updated_at,
    }
}

/// TS `shouldAutoBindCodexApp(env)` — `CODEX_MULTI_AUTH_APP_BIND_INSTALL`,
/// default `"1"`; auto-bind disabled only when ∈ {"0","false","no"}.
fn should_auto_bind_codex_app() -> bool {
    let override_value = std::env::var("CODEX_MULTI_AUTH_APP_BIND_INSTALL")
        .unwrap_or_else(|_| "1".to_string())
        .trim()
        .to_lowercase();
    !matches!(override_value.as_str(), "0" | "false" | "no")
}

fn format_env_override() -> String {
    let raw = std::env::var("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY").ok();
    let Some(raw) = raw else {
        return "none".to_string();
    };
    if raw.trim().is_empty() {
        return "none".to_string();
    }
    match parse_boolean_env(Some(&raw)) {
        None => format!("invalid ({raw})"),
        Some(true) => "enabled".to_string(),
        Some(false) => "disabled".to_string(),
    }
}

// ============================================================================
// Deps
// ============================================================================

type AppBindActionFn = Box<dyn Fn() -> BoxFuture<Result<AppBindResult, String>> + Send + Sync>;

/// TS `RotationCommandDeps` (log sinks live on [`CliOut`]).
#[allow(clippy::type_complexity)] // boxed DI seams mirror the TS deps object 1:1
pub struct RotationCommandDeps {
    pub load_plugin_config: Box<dyn Fn() -> PluginConfig + Send + Sync>,
    pub save_plugin_config:
        Box<dyn Fn(Map<String, Value>) -> BoxFuture<Result<(), String>> + Send + Sync>,
    pub get_codex_runtime_rotation_proxy: Box<dyn Fn(&PluginConfig) -> bool + Send + Sync>,
    pub load_accounts: LoadAccountsFn,
    pub save_accounts: Option<SaveAccountsFn>,
    pub resolve_active_index: Box<dyn Fn(&AccountStorageV3) -> usize + Send + Sync>,
    pub get_storage_path: GetStoragePathFn,
    pub set_storage_path: SetStoragePathFn,
    pub bind_codex_app: Option<AppBindActionFn>,
    pub unbind_codex_app: Option<AppBindActionFn>,
    pub get_codex_app_bind_status:
        Option<Box<dyn Fn() -> BoxFuture<Result<AppBindStatus, String>> + Send + Sync>>,
    pub load_runtime_observability_snapshot:
        Option<Box<dyn Fn() -> BoxFuture<Option<RuntimeObservabilitySnapshot>> + Send + Sync>>,
    pub load_quota_cache: Option<Box<dyn Fn() -> BoxFuture<Option<QuotaCacheData>> + Send + Sync>>,
    pub get_now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
    /// Test seams for the process-global reset effects.
    pub reset_volatile_runtime_state: Box<dyn Fn() + Send + Sync>,
    pub record_runtime_reset: Box<dyn Fn(&str) + Send + Sync>,
    /// Test seam over [`read_app_runtime_helper_status`].
    pub read_helper_status: Box<dyn Fn() -> Option<AppRuntimeHelperStatus> + Send + Sync>,
}

impl Default for RotationCommandDeps {
    fn default() -> Self {
        RotationCommandDeps {
            load_plugin_config: Box::new(cma_config::load::load_plugin_config),
            save_plugin_config: Box::new(|patch| {
                Box::pin(async move {
                    cma_config::save::save_plugin_config(&patch)
                        .await
                        .map_err(|error| error.to_string())
                })
            }),
            get_codex_runtime_rotation_proxy: Box::new(|config| {
                cma_config::getters::get_codex_runtime_rotation_proxy(config)
            }),
            load_accounts: default_load_accounts(),
            save_accounts: Some(default_save_accounts()),
            resolve_active_index: Box::new(|storage| {
                cma_runtime::account_status::resolve_active_index(storage, ModelFamily::Codex)
            }),
            get_storage_path: default_get_storage_path(),
            set_storage_path: default_set_storage_path(),
            bind_codex_app: Some(Box::new(|| {
                Box::pin(async { bind_codex_app_runtime_rotation(&AppBindOptions::default()).await })
            })),
            unbind_codex_app: Some(Box::new(|| {
                Box::pin(async {
                    unbind_codex_app_runtime_rotation(&AppBindOptions::default()).await
                })
            })),
            get_codex_app_bind_status: Some(Box::new(|| {
                Box::pin(async { get_app_bind_status(&AppBindOptions::default()).await })
            })),
            load_runtime_observability_snapshot: Some(Box::new(|| {
                Box::pin(async { load_persisted_runtime_observability_snapshot() })
            })),
            load_quota_cache: Some(Box::new(|| {
                Box::pin(async { Some(load_quota_cache().await) })
            })),
            get_now: None,
            reset_volatile_runtime_state: Box::new(AccountManager::reset_volatile_runtime_state),
            record_runtime_reset: Box::new(record_runtime_reset),
            read_helper_status: Box::new(read_app_runtime_helper_status),
        }
    }
}

fn print_rotation_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth rotation enable",
            "  codex-multi-auth rotation disable",
            "  codex-multi-auth rotation status",
            "  codex-multi-auth rotation bind-app",
            "  codex-multi-auth rotation unbind-app",
            "  codex-multi-auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]",
            "  codex-multi-auth rotation reset-runtime [--json]",
            "",
            "Behavior:",
            "  - Runtime rotation is enabled by default for request-bearing Codex sessions",
            "  - Binds the packaged Codex desktop app to the same localhost router when enabled or repaired",
            "  - Use CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0 to disable the proxy for the current process without changing persistent settings",
            "  - reset-rate-limits clears stored rateLimitResetTimes and active coolingDownUntil entries; use when `fix --live` confirms quota is available but the proxy still returns 503 pool-exhausted",
            "  - reset-runtime clears process-local runtime trackers and re-applies the Codex app bind when available",
        ]
        .join("\n"),
    );
}

// ============================================================================
// reset-runtime
// ============================================================================

async fn run_reset_runtime(args: &[String], deps: &RotationCommandDeps, out: &mut CliOut) -> i32 {
    let mut json = false;
    for arg in args {
        if arg == "--json" || arg == "-j" {
            json = true;
            continue;
        }
        if arg == "--help" || arg == "-h" || arg == "help" {
            out.info("Usage: codex-multi-auth rotation reset-runtime [--json]");
            return 0;
        }
        out.error(format!("Unknown reset-runtime option: {arg}"));
        return 1;
    }

    let mut unbind: Option<AppBindResult> = None;
    let mut bind: Option<AppBindResult> = None;
    let mut app_bind_restarted = false;
    if let (Some(unbind_codex_app), Some(bind_codex_app)) =
        (&deps.unbind_codex_app, &deps.bind_codex_app)
    {
        let restart = async {
            let unbind_result = unbind_codex_app().await?;
            let bind_result = bind_codex_app().await?;
            Ok::<(AppBindResult, AppBindResult), String>((unbind_result, bind_result))
        }
        .await;
        match restart {
            Ok((unbind_result, bind_result)) => {
                unbind = Some(unbind_result);
                bind = Some(bind_result);
                app_bind_restarted = true;
            }
            Err(message) => {
                if json {
                    let mut payload = Map::new();
                    payload.insert("ok".into(), Value::from(false));
                    payload.insert("command".into(), Value::from("rotation reset-runtime"));
                    payload.insert("resetVolatileRuntimeState".into(), Value::from(false));
                    payload.insert("appBindRestarted".into(), Value::from(app_bind_restarted));
                    payload.insert("error".into(), Value::from(message));
                    out.info(stringify_compact(&Value::Object(payload)));
                } else {
                    out.error(format!(
                        "Runtime reset completed, but app bind restart failed: {message}"
                    ));
                }
                return 1;
            }
        }
    }
    (deps.reset_volatile_runtime_state)();
    (deps.record_runtime_reset)("rotation-reset-runtime");
    if json {
        let mut payload = Map::new();
        payload.insert("ok".into(), Value::from(true));
        payload.insert("command".into(), Value::from("rotation reset-runtime"));
        payload.insert("resetVolatileRuntimeState".into(), Value::from(true));
        payload.insert("appBindRestarted".into(), Value::from(app_bind_restarted));
        payload.insert(
            "unbindStatus".into(),
            unbind
                .as_ref()
                .and_then(|result| result.status.state.as_ref())
                .map(|state| serde_json::to_value(state).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
        );
        payload.insert(
            "bindStatus".into(),
            bind.as_ref()
                .and_then(|result| result.status.state.as_ref())
                .map(|state| serde_json::to_value(state).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
        );
        out.info(stringify_compact(&Value::Object(payload)));
    } else {
        out.info("Runtime rotation volatile state reset.");
        if app_bind_restarted {
            out.info("Codex app bind restarted.");
        } else {
            out.info("Codex app bind helpers unavailable; new wrapper sessions will use the reset state.");
        }
    }
    0
}

// ============================================================================
// reset-rate-limits
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResetScope {
    All,
    Account,
}

impl ResetScope {
    fn as_str(self) -> &'static str {
        match self {
            ResetScope::All => "all",
            ResetScope::Account => "account",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct ResetRateLimitsOptions {
    scope: ResetScope,
    account_index: Option<usize>,
    dry_run: bool,
    json: bool,
}

enum ParseResetRateLimits {
    Ok(ResetRateLimitsOptions),
    Help,
    Err(String),
}

fn parse_reset_rate_limits_args(args: &[String]) -> ParseResetRateLimits {
    let mut scope = ResetScope::All;
    let mut scope_explicit = false;
    let mut account_index: Option<usize> = None;
    let mut dry_run = false;
    let mut json = false;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--help" || arg == "-h" || arg == "help" {
            return ParseResetRateLimits::Help;
        }
        if arg == "--all" {
            if scope_explicit && scope != ResetScope::All {
                return ParseResetRateLimits::Err(
                    "--all and --account are mutually exclusive".to_string(),
                );
            }
            scope = ResetScope::All;
            scope_explicit = true;
            i += 1;
            continue;
        }
        if arg == "--account" {
            if scope_explicit && scope == ResetScope::All {
                return ParseResetRateLimits::Err(
                    "--all and --account are mutually exclusive".to_string(),
                );
            }
            let Some(next) = args.get(i + 1) else {
                return ParseResetRateLimits::Err("--account requires a 1-based index".to_string());
            };
            if next.is_empty() || !next.chars().all(|c| c.is_ascii_digit()) {
                return ParseResetRateLimits::Err(format!(
                    "--account expects a positive 1-based integer, got: {next}"
                ));
            }
            let Ok(parsed) = next.parse::<i64>() else {
                return ParseResetRateLimits::Err(format!(
                    "--account expects a positive 1-based integer, got: {next}"
                ));
            };
            if parsed < 1 {
                return ParseResetRateLimits::Err(format!(
                    "--account expects a positive 1-based integer, got: {next}"
                ));
            }
            scope = ResetScope::Account;
            scope_explicit = true;
            account_index = Some((parsed - 1) as usize);
            i += 2;
            continue;
        }
        if arg == "--dry-run" {
            dry_run = true;
            i += 1;
            continue;
        }
        if arg == "--json" || arg == "-j" {
            json = true;
            i += 1;
            continue;
        }
        return ParseResetRateLimits::Err(format!("Unknown reset-rate-limits option: {arg}"));
    }

    ParseResetRateLimits::Ok(ResetRateLimitsOptions {
        scope,
        account_index,
        dry_run,
        json,
    })
}

fn print_reset_rate_limits_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth rotation reset-rate-limits [--all | --account <idx>] [--dry-run] [--json]",
            "",
            "Options:",
            "  --all              Clear timers for every account (default)",
            "  --account <idx>    Clear timers for a single 1-based account index",
            "  --dry-run          Report what would change without writing",
            "  --json, -j         Print machine-readable JSON output",
            "",
            "Notes:",
            "  - Clears stored rateLimitResetTimes entries with reset times still in the future",
            "    and any active coolingDownUntil entries.",
            "  - Use when `codex-multi-auth fix --live` confirms upstream quota is available but the",
            "    runtime rotation proxy still returns 503 pool-exhausted.",
            "  - If a runtime rotation proxy is currently running it may re-persist its in-memory",
            "    timers and revert these changes. After clearing, run `codex-multi-auth rotation disable`",
            "    then `codex-multi-auth rotation enable` (or restart the Codex app) to flush in-memory",
            "    state and reload from disk.",
        ]
        .join("\n"),
    );
}

const RESET_RATE_LIMITS_RESTART_HINT: &str =
    "If a runtime rotation proxy is currently running it may re-persist its in-memory timers and revert these changes. Run `codex-multi-auth rotation disable` then `codex-multi-auth rotation enable` (or restart the Codex app) to flush in-memory state and reload from disk.";

/// Build a privacy-safe label for reset-rate-limits change reports —
/// deliberately no email (PII): `account {i+1} (id:***{last4})`.
fn redacted_reset_rate_limits_label(account: &AccountMetadataV3, index: usize) -> String {
    let id = account.account_id.as_deref().unwrap_or("");
    let tail = if id.chars().count() > 4 {
        let count = id.chars().count();
        let (byte_idx, _) = id.char_indices().nth(count - 4).expect("count > 4");
        format!("***{}", &id[byte_idx..])
    } else {
        "***".to_string()
    };
    format!("account {} (id:{tail})", index + 1)
}

struct ResetRateLimitsAccountChange {
    index: usize,
    label: String,
    cleared_rate_limit_keys: Vec<String>,
    cleared_cooling_down: bool,
}

async fn run_reset_rate_limits(
    args: &[String],
    deps: &RotationCommandDeps,
    out: &mut CliOut,
) -> i32 {
    let now = deps.get_now.as_ref().map(|f| f()).unwrap_or_else(now_ms);

    let options = match parse_reset_rate_limits_args(args) {
        ParseResetRateLimits::Err(error) => {
            out.error(error);
            return 1;
        }
        ParseResetRateLimits::Help => {
            print_reset_rate_limits_usage(out);
            return 0;
        }
        ParseResetRateLimits::Ok(options) => options,
    };
    let ResetRateLimitsOptions {
        scope,
        account_index,
        dry_run,
        json,
    } = options;

    // Keep the shared (non-project-scoped) path scope active across both load
    // AND save so that `saveAccounts` writes to the same file we loaded from.
    // Restoring the previous path between load and save would silently route
    // the write to the project storage file.
    let previous_storage_path = (deps.get_storage_path)();
    (deps.set_storage_path)(None);
    let result = run_reset_rate_limits_scoped(
        deps,
        out,
        now,
        scope,
        account_index,
        dry_run,
        json,
    )
    .await;
    (deps.set_storage_path)(Some(previous_storage_path.as_str()));
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_reset_rate_limits_scoped(
    deps: &RotationCommandDeps,
    out: &mut CliOut,
    now: i64,
    scope: ResetScope,
    account_index: Option<usize>,
    dry_run: bool,
    json: bool,
) -> i32 {
    let storage = (deps.load_accounts)().await;
    let storage_path = (deps.get_storage_path)();

    let Some(mut storage) = storage.filter(|storage| !storage.accounts.is_empty()) else {
        if json {
            let mut payload = Map::new();
            payload.insert("ok".into(), Value::from(false));
            payload.insert("error".into(), Value::from("no accounts configured"));
            payload.insert("storagePath".into(), Value::from(storage_path));
            out.info(stringify_compact(&Value::Object(payload)));
        } else {
            out.error("No accounts configured.");
        }
        return 1;
    };

    if scope == ResetScope::Account {
        let Some(index) = account_index else {
            out.error("internal: account scope without index");
            return 1;
        };
        if index >= storage.accounts.len() {
            let message = format!(
                "Account index out of range (1..{}): {}",
                storage.accounts.len(),
                index + 1
            );
            if json {
                let mut payload = Map::new();
                payload.insert("ok".into(), Value::from(false));
                payload.insert("error".into(), Value::from(message));
                payload.insert("storagePath".into(), Value::from(storage_path));
                out.info(stringify_compact(&Value::Object(payload)));
            } else {
                out.error(message);
            }
            return 1;
        }
    }

    let target_indexes: Vec<usize> = match scope {
        ResetScope::All => (0..storage.accounts.len()).collect(),
        ResetScope::Account => account_index.into_iter().collect(),
    };
    let mut changes: Vec<ResetRateLimitsAccountChange> = Vec::new();

    for &index in &target_indexes {
        let Some(account) = storage.accounts.get_mut(index) else {
            continue;
        };
        let cleared_rate_limit_keys: Vec<String> = account
            .rate_limit_reset_times
            .as_ref()
            .map(|times| {
                times
                    .iter()
                    .filter(|(_, value)| *value > now)
                    .map(|(key, _)| key.to_string())
                    .collect()
            })
            .unwrap_or_default();
        let cleared_cooling_down = account.cooling_down_until.is_some_and(|until| until > now);
        if cleared_rate_limit_keys.is_empty() && !cleared_cooling_down {
            continue;
        }
        changes.push(ResetRateLimitsAccountChange {
            index,
            label: redacted_reset_rate_limits_label(account, index),
            cleared_rate_limit_keys: cleared_rate_limit_keys.clone(),
            cleared_cooling_down,
        });
        if !dry_run {
            // Only delete the keys we reported (future-active resets) so
            // callers who inspect the JSON output can trust the report matches
            // the action exactly. Past entries are no-ops and are pruned
            // naturally by clearExpiredRateLimits.
            if let Some(times) = account.rate_limit_reset_times.as_mut() {
                for key in &cleared_rate_limit_keys {
                    times.remove(key);
                }
            }
            if cleared_cooling_down {
                account.cooling_down_until = None;
            }
        }
    }

    if !dry_run && !changes.is_empty() {
        let Some(save_accounts) = &deps.save_accounts else {
            let message =
                "reset-rate-limits requires writable account storage but saveAccounts dep was not provided";
            if json {
                let mut payload = Map::new();
                payload.insert("ok".into(), Value::from(false));
                payload.insert("error".into(), Value::from(message));
                payload.insert("storagePath".into(), Value::from(storage_path));
                out.info(stringify_compact(&Value::Object(payload)));
            } else {
                out.error(message);
            }
            return 1;
        };
        // Use saveAccountsWithRetry to absorb transient Windows EBUSY/EPERM
        // contention, matching every other saveAccounts call site.
        if let Err(error) = save_accounts_with_retry_boxed(&storage, save_accounts).await {
            let code = error.code();
            let message = if !code.is_empty() {
                format!("Failed to persist reset-rate-limits ({code}); rate-limit timers were not cleared.")
            } else {
                format!("Failed to persist reset-rate-limits: {}", error.message())
            };
            if json {
                let mut payload = Map::new();
                payload.insert("ok".into(), Value::from(false));
                payload.insert("error".into(), Value::from(message));
                payload.insert("storagePath".into(), Value::from(storage_path));
                out.info(stringify_compact(&Value::Object(payload)));
            } else {
                out.error(message);
            }
            return 1;
        }
    }

    if json {
        let mut payload = Map::new();
        payload.insert("ok".into(), Value::from(true));
        payload.insert("dryRun".into(), Value::from(dry_run));
        payload.insert("scope".into(), Value::from(scope.as_str()));
        payload.insert("storagePath".into(), Value::from(storage_path));
        payload.insert(
            "accountsScanned".into(),
            Value::from(target_indexes.len() as i64),
        );
        payload.insert("accountsChanged".into(), Value::from(changes.len() as i64));
        payload.insert(
            "changes".into(),
            Value::Array(
                changes
                    .iter()
                    .map(|change| {
                        let mut row = Map::new();
                        row.insert("index".into(), Value::from(change.index as i64));
                        row.insert("label".into(), Value::from(change.label.clone()));
                        row.insert(
                            "clearedRateLimitKeys".into(),
                            Value::Array(
                                change
                                    .cleared_rate_limit_keys
                                    .iter()
                                    .cloned()
                                    .map(Value::from)
                                    .collect(),
                            ),
                        );
                        row.insert(
                            "clearedCoolingDown".into(),
                            Value::from(change.cleared_cooling_down),
                        );
                        Value::Object(row)
                    })
                    .collect(),
            ),
        );
        if !changes.is_empty() && !dry_run {
            payload.insert(
                "restartHint".into(),
                Value::from(RESET_RATE_LIMITS_RESTART_HINT),
            );
        }
        out.info(stringify_compact(&Value::Object(payload)));
        return 0;
    }

    if changes.is_empty() {
        out.info(match scope {
            ResetScope::All => {
                "No accounts had active rate-limit or cooldown timers to clear.".to_string()
            }
            ResetScope::Account => format!(
                "Account {} had no active rate-limit or cooldown timers to clear.",
                account_index.unwrap_or(0) + 1
            ),
        });
        return 0;
    }

    out.info(format!(
        "{} {}/{} account(s):",
        if dry_run { "Would clear" } else { "Cleared" },
        changes.len(),
        target_indexes.len()
    ));
    for change in &changes {
        let mut parts: Vec<String> = Vec::new();
        if !change.cleared_rate_limit_keys.is_empty() {
            parts.push(format!(
                "rate-limit keys: {}",
                change.cleared_rate_limit_keys.join(", ")
            ));
        }
        if change.cleared_cooling_down {
            parts.push("cooldown".to_string());
        }
        out.info(format!(
            "  {}. {} | {}",
            change.index + 1,
            change.label,
            parts.join(" | ")
        ));
    }
    if dry_run {
        out.info("(dry-run; no changes written)");
    } else {
        out.info(format!("Note: {RESET_RATE_LIMITS_RESTART_HINT}"));
    }
    0
}

// ============================================================================
// status
// ============================================================================

async fn print_codex_app_bind_status(
    deps: &RotationCommandDeps,
    out: &mut CliOut,
) -> Option<AppBindStatus> {
    let Some(get_status) = &deps.get_codex_app_bind_status else {
        out.info("Codex app bind: unavailable");
        return None;
    };
    match get_status().await {
        Ok(status) => {
            out.info(format_app_bind_status(&status));
            Some(status)
        }
        Err(message) => {
            out.info(format!("Codex app bind: unavailable ({message})"));
            None
        }
    }
}

async fn print_rotation_status(deps: &RotationCommandDeps, out: &mut CliOut) -> i32 {
    let previous_storage_path = (deps.get_storage_path)();
    let now = deps.get_now.as_ref().map(|f| f()).unwrap_or_else(now_ms);
    // Rotation status reports the shared Codex account pool, not a
    // project-scoped override.
    (deps.set_storage_path)(None);
    let config = (deps.load_plugin_config)();
    let env_override =
        parse_boolean_env(std::env::var("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY").ok().as_deref());
    let enabled = env_override.unwrap_or_else(|| (deps.get_codex_runtime_rotation_proxy)(&config));
    let storage = (deps.load_accounts)().await;
    let storage_path = (deps.get_storage_path)();
    (deps.set_storage_path)(Some(previous_storage_path.as_str()));

    out.info(format!(
        "Runtime rotation proxy: {}",
        if enabled { "enabled" } else { "disabled" }
    ));
    out.info(format!(
        "Stored setting: {}",
        if config.codex_runtime_rotation_proxy == Some(true) {
            "enabled"
        } else {
            "disabled"
        }
    ));
    out.info(format!("Env override: {}", format_env_override()));
    let helper_status = (deps.read_helper_status)();
    out.info(format_app_runtime_helper_status(now, helper_status.as_ref()));
    let app_bind_status = print_codex_app_bind_status(deps, out).await;
    out.info(format!("Storage: {storage_path}"));

    let Some(storage) = storage.filter(|storage| !storage.accounts.is_empty()) else {
        out.info("Accounts: none configured");
        return 0;
    };

    let active_index = (deps.resolve_active_index)(&storage);
    let (runtime_snapshot, quota_cache) = tokio::join!(
        async {
            match &deps.load_runtime_observability_snapshot {
                Some(load) => load().await,
                None => None,
            }
        },
        async {
            match &deps.load_quota_cache {
                Some(load) => load().await,
                None => None,
            }
        },
    );
    let runtime_current = resolve_runtime_current_account(
        &storage,
        &RuntimeCurrentAccountSources {
            runtime_snapshot,
            app_bind_status: app_bind_status
                .as_ref()
                .filter(|status| status.running)
                .and_then(|status| status.router.clone()),
            app_helper_status: app_runtime_helper_status_to_signal(
                helper_status
                    .as_ref()
                    .map(to_runtime_helper_account_status)
                    .as_ref(),
            ),
        },
        RuntimeCurrentAccountOptions {
            now: Some(now),
            max_age_ms: None,
        },
    );
    out.info(format!("Accounts: {}", storage.accounts.len()));
    for (index, account) in storage.accounts.iter().enumerate() {
        let mut markers: Vec<String> =
            resolve_account_current_markers(index, active_index, runtime_current.as_ref())
                .into_iter()
                .map(|marker| marker.as_str().to_string())
                .collect();
        if account.enabled == Some(false) {
            markers.push("disabled".to_string());
        }
        if let Some(cooldown) = format_cooldown(
            account.cooling_down_until,
            account.cooldown_reason.as_ref().map(|reason| reason.as_str()),
            now,
        ) {
            markers.push(format!("cooldown:{cooldown}"));
        }
        let future_resets: Vec<i64> = account
            .rate_limit_reset_times
            .as_ref()
            .map(|times| times.iter().map(|(_, value)| value).filter(|v| *v > now).collect())
            .unwrap_or_default();
        if !future_resets.is_empty() {
            let wait_ms = future_resets.iter().min().copied().unwrap_or(now) - now;
            markers.push(format!("rate-limited:{}", format_wait_time(wait_ms)));
        }
        let quota_entry =
            find_quota_cache_entry_for_account(quota_cache.as_ref(), account, &storage.accounts);
        if quota_entry.is_some_and(|entry| entry.status == 429.0)
            && !markers.iter().any(|marker| is_rate_limited_marker(marker))
        {
            markers.push("rate-limited".to_string());
        }
        if is_quota_cache_entry_exhausted(quota_entry, now) {
            markers.push("quota-exhausted".to_string());
        }
        let marker_label = if markers.is_empty() {
            String::new()
        } else {
            format!(" [{}]", markers.join(", "))
        };
        out.info(format!(
            "{}. {}{marker_label}",
            index + 1,
            format_account_label(Some(account), index)
        ));
    }

    0
}

// ============================================================================
// entry
// ============================================================================

/// Production entry.
pub async fn run_rotation_command(args: &[String], out: &mut CliOut) -> i32 {
    run_rotation_command_with(args, &RotationCommandDeps::default(), out).await
}

/// TS `runRotationCommand(args, deps)`.
pub async fn run_rotation_command_with(
    args: &[String],
    deps: &RotationCommandDeps,
    out: &mut CliOut,
) -> i32 {
    let subcommand = args.first().map(String::as_str);
    let rest = if args.len() > 1 { &args[1..] } else { &[] };
    match subcommand {
        None | Some("status") => {
            if let Some(first) = rest.first() {
                out.error(format!("Unknown rotation status option: {first}"));
                return 1;
            }
            return print_rotation_status(deps, out).await;
        }
        Some("--help") | Some("-h") | Some("help") => {
            print_rotation_usage(out);
            return 0;
        }
        Some("reset-rate-limits") => return run_reset_rate_limits(rest, deps, out).await,
        Some("reset-runtime") => return run_reset_runtime(rest, deps, out).await,
        _ => {}
    }
    let subcommand = subcommand.expect("checked above");
    if let Some(first) = rest.first() {
        // enable/disable/bind-app/unbind-app take no extra args; the unknown
        // check runs before the subcommand branch (TS order).
        if matches!(subcommand, "enable" | "disable" | "bind-app" | "unbind-app") {
            out.error(format!("Unknown rotation option: {first}"));
            return 1;
        }
    }
    match subcommand {
        "enable" => {
            let mut patch = Map::new();
            patch.insert("codexRuntimeRotationProxy".into(), Value::from(true));
            if let Err(error) = (deps.save_plugin_config)(patch).await {
                out.error(error);
                return 1;
            }
            out.info("Runtime rotation proxy enabled.");
            out.info("New Codex sessions will route Responses traffic through the localhost proxy.");
            if let Some(bind_codex_app) = &deps.bind_codex_app
                && should_auto_bind_codex_app()
            {
                match bind_codex_app().await {
                    Ok(result) => {
                        out.info(result.message.clone());
                        out.info(format_app_bind_status(&result.status));
                    }
                    Err(message) => {
                        out.error(format!("Codex app bind failed: {message}"));
                        out.info("Wrapper-launched CLI and app sessions still use runtime rotation.");
                    }
                }
            }
            0
        }
        "disable" => {
            let mut patch = Map::new();
            patch.insert("codexRuntimeRotationProxy".into(), Value::from(false));
            if let Err(error) = (deps.save_plugin_config)(patch).await {
                out.error(error);
                return 1;
            }
            out.info("Runtime rotation proxy disabled.");
            if let Some(unbind_codex_app) = &deps.unbind_codex_app {
                match unbind_codex_app().await {
                    Ok(result) => {
                        out.info(result.message.clone());
                        out.info(format_app_bind_status(&result.status));
                    }
                    Err(message) => {
                        out.error(format!("Codex app unbind failed: {message}"));
                        return 1;
                    }
                }
            }
            0
        }
        "bind-app" => {
            let Some(bind_codex_app) = &deps.bind_codex_app else {
                out.error("Codex app bind is unavailable in this build.");
                return 1;
            };
            match bind_codex_app().await {
                Ok(result) => {
                    out.info(result.message.clone());
                    out.info(format_app_bind_status(&result.status));
                    0
                }
                Err(message) => {
                    out.error(message);
                    1
                }
            }
        }
        "unbind-app" => {
            let Some(unbind_codex_app) = &deps.unbind_codex_app else {
                out.error("Codex app bind is unavailable in this build.");
                return 1;
            };
            match unbind_codex_app().await {
                Ok(result) => {
                    out.info(result.message.clone());
                    out.info(format_app_bind_status(&result.status));
                    0
                }
                Err(message) => {
                    out.error(message);
                    1
                }
            }
        }
        other => {
            out.error(format!("Unknown rotation command: {other}"));
            print_rotation_usage(out);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::RateLimitStateV3;
    use std::sync::{Arc, Mutex};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    struct Harness {
        deps: RotationCommandDeps,
        saved: Arc<Mutex<Option<AccountStorageV3>>>,
        saved_config: Arc<Mutex<Vec<Map<String, Value>>>>,
        path_scopes: Arc<Mutex<Vec<Option<String>>>>,
    }

    fn harness(storage: Option<AccountStorageV3>) -> Harness {
        let saved: Arc<Mutex<Option<AccountStorageV3>>> = Arc::new(Mutex::new(None));
        let saved_clone = Arc::clone(&saved);
        let saved_config: Arc<Mutex<Vec<Map<String, Value>>>> = Arc::new(Mutex::new(Vec::new()));
        let saved_config_clone = Arc::clone(&saved_config);
        let path_scopes: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let path_scopes_clone = Arc::clone(&path_scopes);
        let deps = RotationCommandDeps {
            load_plugin_config: Box::new(PluginConfig::default),
            save_plugin_config: Box::new(move |patch| {
                saved_config_clone.lock().unwrap().push(patch);
                Box::pin(async { Ok(()) })
            }),
            get_codex_runtime_rotation_proxy: Box::new(|config| {
                config.codex_runtime_rotation_proxy.unwrap_or(true)
            }),
            load_accounts: Box::new(move || {
                let storage = storage.clone();
                Box::pin(async move { storage })
            }),
            save_accounts: Some(Box::new(move |storage| {
                let saved = Arc::clone(&saved_clone);
                Box::pin(async move {
                    *saved.lock().unwrap() = Some(storage);
                    Ok(())
                })
            })),
            resolve_active_index: Box::new(|_| 0),
            get_storage_path: Box::new(|| "/shared/accounts.json".to_string()),
            set_storage_path: Box::new(move |path| {
                path_scopes_clone
                    .lock()
                    .unwrap()
                    .push(path.map(str::to_string));
            }),
            bind_codex_app: None,
            unbind_codex_app: None,
            get_codex_app_bind_status: None,
            load_runtime_observability_snapshot: None,
            load_quota_cache: None,
            get_now: Some(Box::new(|| 1_000_000)),
            reset_volatile_runtime_state: Box::new(|| {}),
            record_runtime_reset: Box::new(|_| {}),
            read_helper_status: Box::new(|| None),
        };
        Harness {
            deps,
            saved,
            saved_config,
            path_scopes,
        }
    }

    fn storage_with_timers() -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        // Account 1: future + past rate limits and an active cooldown.
        let mut a = AccountMetadataV3::new("token-a", 1, 1);
        a.account_id = Some("acct_1234567890".to_string());
        let mut times = RateLimitStateV3::new();
        times.insert("codex", 2_000_000); // future
        times.insert("codex:gpt-5.5", 500); // past — preserved
        a.rate_limit_reset_times = Some(times);
        a.cooling_down_until = Some(1_500_000);
        storage.accounts.push(a);
        // Account 2: nothing active.
        storage.accounts.push(AccountMetadataV3::new("token-b", 1, 1));
        storage
    }

    #[tokio::test]
    async fn reset_rate_limits_clears_future_only_and_persists() {
        let h = harness(Some(storage_with_timers()));
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(&args(&["reset-rate-limits"]), &h.deps, &mut out).await,
            0
        );
        let saved = h.saved.lock().unwrap().clone().expect("saved");
        let times = saved.accounts[0].rate_limit_reset_times.as_ref().unwrap();
        assert!(!times.contains_key("codex"));
        // Past entry deliberately preserved.
        assert_eq!(times.get("codex:gpt-5.5"), Some(500));
        assert_eq!(saved.accounts[0].cooling_down_until, None);
        let text = out.info_text();
        assert!(text.starts_with("Cleared 1/2 account(s):"));
        assert!(text.contains("  1. account 1 (id:***7890) | rate-limit keys: codex | cooldown"));
        assert!(text.contains(&format!("Note: {RESET_RATE_LIMITS_RESTART_HINT}")));
    }

    #[tokio::test]
    async fn reset_rate_limits_dry_run_reports_without_saving() {
        let h = harness(Some(storage_with_timers()));
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(
                &args(&["reset-rate-limits", "--dry-run"]),
                &h.deps,
                &mut out
            )
            .await,
            0
        );
        assert!(h.saved.lock().unwrap().is_none());
        let text = out.info_text();
        assert!(text.starts_with("Would clear 1/2 account(s):"));
        assert!(text.contains("(dry-run; no changes written)"));
    }

    #[tokio::test]
    async fn reset_rate_limits_json_is_compact_with_restart_hint() {
        let h = harness(Some(storage_with_timers()));
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(&args(&["reset-rate-limits", "--json"]), &h.deps, &mut out)
                .await,
            0
        );
        let text = out.info_text();
        assert!(!text.contains('\n'));
        let payload: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(payload["ok"], Value::from(true));
        assert_eq!(payload["scope"], Value::from("all"));
        assert_eq!(payload["accountsScanned"], Value::from(2));
        assert_eq!(payload["accountsChanged"], Value::from(1));
        assert_eq!(
            payload["changes"][0]["clearedRateLimitKeys"],
            serde_json::json!(["codex"])
        );
        assert_eq!(payload["changes"][0]["clearedCoolingDown"], Value::from(true));
        assert_eq!(
            payload["restartHint"],
            Value::from(RESET_RATE_LIMITS_RESTART_HINT)
        );
        // No email leaked into labels.
        assert!(!text.contains('@'));
    }

    #[tokio::test]
    async fn reset_rate_limits_json_omits_hint_for_dry_run_and_noop() {
        let h = harness(Some(storage_with_timers()));
        let mut out = CliOut::capture();
        run_rotation_command_with(
            &args(&["reset-rate-limits", "--json", "--dry-run"]),
            &h.deps,
            &mut out,
        )
        .await;
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert!(payload.get("restartHint").is_none());

        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(AccountMetadataV3::new("t", 1, 1));
        let h = harness(Some(storage));
        let mut out = CliOut::capture();
        run_rotation_command_with(&args(&["reset-rate-limits", "--json"]), &h.deps, &mut out)
            .await;
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["accountsChanged"], Value::from(0));
        assert!(payload.get("restartHint").is_none());
    }

    #[tokio::test]
    async fn reset_rate_limits_scope_and_range_checks() {
        let h = harness(Some(storage_with_timers()));
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(
                &args(&["reset-rate-limits", "--account", "9"]),
                &h.deps,
                &mut out
            )
            .await,
            1
        );
        assert_eq!(out.error_text(), "Account index out of range (1..2): 9");

        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(
                &args(&["reset-rate-limits", "--all", "--account", "1"]),
                &h.deps,
                &mut out
            )
            .await,
            1
        );
        assert_eq!(out.error_text(), "--all and --account are mutually exclusive");

        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(
                &args(&["reset-rate-limits", "--account", "1", "--all"]),
                &h.deps,
                &mut out
            )
            .await,
            1
        );
        assert_eq!(out.error_text(), "--all and --account are mutually exclusive");

        for bad in ["1.5", "abc", "-2", "0"] {
            let mut out = CliOut::capture();
            assert_eq!(
                run_rotation_command_with(
                    &args(&["reset-rate-limits", "--account", bad]),
                    &h.deps,
                    &mut out
                )
                .await,
                1,
                "value {bad:?}"
            );
            assert_eq!(
                out.error_text(),
                format!("--account expects a positive 1-based integer, got: {bad}")
            );
        }
    }

    #[tokio::test]
    async fn reset_rate_limits_noop_message_without_save_dep() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(AccountMetadataV3::new("t", 1, 1));
        let mut h = harness(Some(storage));
        h.deps.save_accounts = None;
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(&args(&["reset-rate-limits"]), &h.deps, &mut out).await,
            0
        );
        assert_eq!(
            out.info_text(),
            "No accounts had active rate-limit or cooldown timers to clear."
        );
    }

    #[tokio::test]
    async fn reset_rate_limits_fails_fast_when_save_dep_missing() {
        let mut h = harness(Some(storage_with_timers()));
        h.deps.save_accounts = None;
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(&args(&["reset-rate-limits"]), &h.deps, &mut out).await,
            1
        );
        assert_eq!(
            out.error_text(),
            "reset-rate-limits requires writable account storage but saveAccounts dep was not provided"
        );
    }

    #[tokio::test]
    async fn reset_rate_limits_holds_null_scope_across_load_and_save() {
        let h = harness(Some(storage_with_timers()));
        let mut out = CliOut::capture();
        run_rotation_command_with(&args(&["reset-rate-limits"]), &h.deps, &mut out).await;
        let scopes = h.path_scopes.lock().unwrap().clone();
        // set(null) up front, restore(previous) at the end — nothing between.
        assert_eq!(
            scopes,
            vec![None, Some("/shared/accounts.json".to_string())]
        );
    }

    #[tokio::test]
    async fn reset_runtime_json_without_helpers() {
        let reset_called = Arc::new(Mutex::new(false));
        let reset_clone = Arc::clone(&reset_called);
        let recorded: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded_clone = Arc::clone(&recorded);
        let mut h = harness(None);
        h.deps.reset_volatile_runtime_state = Box::new(move || {
            *reset_clone.lock().unwrap() = true;
        });
        h.deps.record_runtime_reset = Box::new(move |reason| {
            recorded_clone.lock().unwrap().push(reason.to_string());
        });
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(&args(&["reset-runtime", "--json"]), &h.deps, &mut out).await,
            0
        );
        let text = out.info_text();
        assert!(!text.contains('\n'));
        let payload: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(payload["ok"], Value::from(true));
        assert_eq!(payload["command"], Value::from("rotation reset-runtime"));
        assert_eq!(payload["resetVolatileRuntimeState"], Value::from(true));
        assert_eq!(payload["appBindRestarted"], Value::from(false));
        assert_eq!(payload["unbindStatus"], Value::Null);
        assert_eq!(payload["bindStatus"], Value::Null);
        assert!(*reset_called.lock().unwrap());
        assert_eq!(recorded.lock().unwrap().as_slice(), ["rotation-reset-runtime"]);
    }

    #[tokio::test]
    async fn reset_runtime_text_reports_wrapper_fallback() {
        let h = harness(None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(&args(&["reset-runtime"]), &h.deps, &mut out).await,
            0
        );
        let text = out.info_text();
        assert!(text.contains("Runtime rotation volatile state reset."));
        assert!(text.contains(
            "Codex app bind helpers unavailable; new wrapper sessions will use the reset state."
        ));
    }

    #[tokio::test]
    async fn enable_and_disable_write_config() {
        let h = harness(None);
        let mut out = CliOut::capture();
        assert_eq!(run_rotation_command_with(&args(&["enable"]), &h.deps, &mut out).await, 0);
        let text = out.info_text();
        assert!(text.contains("Runtime rotation proxy enabled."));
        assert!(text.contains(
            "New Codex sessions will route Responses traffic through the localhost proxy."
        ));
        let mut out = CliOut::capture();
        assert_eq!(run_rotation_command_with(&args(&["disable"]), &h.deps, &mut out).await, 0);
        assert!(out.info_text().contains("Runtime rotation proxy disabled."));
        let saved = h.saved_config.lock().unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0]["codexRuntimeRotationProxy"], Value::from(true));
        assert_eq!(saved[1]["codexRuntimeRotationProxy"], Value::from(false));
    }

    #[tokio::test]
    async fn bind_app_unavailable_in_this_build() {
        let h = harness(None);
        let mut out = CliOut::capture();
        assert_eq!(run_rotation_command_with(&args(&["bind-app"]), &h.deps, &mut out).await, 1);
        assert_eq!(out.error_text(), "Codex app bind is unavailable in this build.");
    }

    #[tokio::test]
    async fn unknown_subcommand_prints_usage() {
        let h = harness(None);
        let mut out = CliOut::capture();
        assert_eq!(run_rotation_command_with(&args(&["bogus"]), &h.deps, &mut out).await, 1);
        assert_eq!(out.error_text(), "Unknown rotation command: bogus");
        assert!(out.info_text().starts_with("Usage:"));
    }

    #[tokio::test]
    async fn status_rejects_extra_args() {
        let h = harness(None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_rotation_command_with(&args(&["status", "--json"]), &h.deps, &mut out).await,
            1
        );
        assert_eq!(out.error_text(), "Unknown rotation status option: --json");
    }

    #[test]
    fn helper_status_formatting_guards() {
        // Not running: wrong kind.
        let status = AppRuntimeHelperStatus {
            kind: Some("other".to_string()),
            ..Default::default()
        };
        assert_eq!(
            format_app_runtime_helper_status(0, Some(&status)),
            "Codex app helper: not running"
        );
        // Running: own pid is alive; email-shaped label suppressed.
        let status = AppRuntimeHelperStatus {
            kind: Some("codex-app-runtime-rotation-helper".to_string()),
            state: Some("running".to_string()),
            pid: Some(std::process::id() as i64),
            total_requests: Some(7),
            rotations: Some(2),
            last_account_index: Some(0),
            last_account_label: Some("user@example.com".to_string()),
            last_account_id: Some("acct_9".to_string()),
            idle_expires_at: Some(61_000),
            ..Default::default()
        };
        let line = format_app_runtime_helper_status(1_000, Some(&status));
        assert!(line.starts_with(&format!(
            "Codex app helper: running pid={}",
            std::process::id()
        )));
        assert!(line.contains("requests=7"));
        assert!(line.contains("rotations=2"));
        assert!(line.contains("lastAccount=Account 1 (acct_9)"));
        assert!(!line.contains("user@example.com"));
        assert!(line.contains("idle-expires=1m"));
        // stopped state counts as not running even when alive.
        let stopped = AppRuntimeHelperStatus {
            state: Some("stopped".to_string()),
            ..status
        };
        assert_eq!(
            format_app_runtime_helper_status(1_000, Some(&stopped)),
            "Codex app helper: not running"
        );
    }
}
