//! Port of `lib/codex-manager/commands/status.ts` (`status`/`list` +
//! `features`).
//!
//! Behavior source: spec 08 §4.16. `status --json` emits the identical key
//! set in the empty-storage branch (nulls + `accounts: []`) — consumers rely
//! on one stable shape (gotcha 11). The marker order is contract (gotcha 12):
//! current → disabled → rate-limited → 429-from-quota (dedup via
//! `isRateLimitedMarker`) → quota-exhausted → cooldown.

use cma_accounts::manager_persistence::{format_account_label, format_cooldown, format_workspace_lines};
use cma_accounts::rate_limits::format_wait_time;
use cma_core::json_io::stringify_pretty2;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
use cma_core::utils::now_ms;
use cma_quota::cache::{load_quota_cache, QuotaCacheData};
use cma_quota::forecast::{evaluate_forecast_accounts, recommend_forecast_account, ForecastAccountInput};
use cma_quota::readiness::{find_quota_cache_entry_for_account, is_quota_cache_entry_exhausted};
use cma_runtime::app_bind::{get_app_bind_status, AppBindOptions, AppBindRouterStatus};
use cma_runtime::current_account::{
    read_app_runtime_helper_account_signal, resolve_account_current_markers,
    resolve_runtime_current_account, RuntimeAccountSignal, RuntimeCurrentAccountOptions,
    RuntimeCurrentAccountSelection, RuntimeCurrentAccountSources,
};
use cma_runtime::observability::{
    load_persisted_runtime_observability_snapshot, RuntimeObservabilitySnapshot,
};
use cma_storage::health::{inspect_storage_health, StorageHealthSummary};
use cma_storage::load::LoadedAccountStorage;
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    default_get_storage_path, default_set_storage_path, BoxFuture, GetStoragePathFn,
    SetStoragePathFn,
};
use crate::rate_limit_markers::is_rate_limited_marker;

// ============================================================================
// IMPLEMENTED_FEATURES (dispatcher table; ids and names are output verbatim)
// ============================================================================

/// TS `IMPLEMENTED_FEATURES` — used by the `features` command.
pub const IMPLEMENTED_FEATURES: [(u32, &str); 54] = [
    (1, "Multi-account OAuth login dashboard"),
    (2, "Account add/update dedupe by token/id/email"),
    (3, "Set current account command"),
    (4, "Per-family active index handling"),
    (5, "Quick health check command"),
    (6, "Full refresh check command"),
    (7, "Flagged account verification command"),
    (8, "Flagged account restore flow"),
    (9, "Best account forecast engine"),
    (10, "Forecast live quota probing"),
    (11, "Auto-fix command (safe mode)"),
    (12, "Doctor diagnostics command"),
    (13, "JSON outputs for machine automation"),
    (14, "Report generation command"),
    (15, "Storage v3 normalization and migration"),
    (16, "Storage backup and recovery journal"),
    (17, "Project-scoped and global storage paths"),
    (18, "Quota cache storage"),
    (19, "Live account sync watcher"),
    (20, "Session affinity store"),
    (21, "Refresh queue dedupe (in-process)"),
    (22, "Refresh lease dedupe (cross-process)"),
    (23, "Token rotation mapping in refresh queue"),
    (24, "Refresh guardian (proactive refresh)"),
    (25, "Preemptive quota scheduler"),
    (26, "Entitlement cache for unsupported models"),
    (27, "Capability policy scoring store"),
    (28, "Failure policy evaluation module"),
    (29, "Streaming failover pipeline"),
    (30, "Rate-limit backoff and cooldown handling"),
    (31, "Host request transformer bridge"),
    (32, "Prompt template sync with cache"),
    (33, "Codex CLI active-account state sync"),
    (34, "TUI quick-switch hotkeys (1-9)"),
    (35, "TUI search and help toggles"),
    (36, "TUI account detail hotkeys (S/R/E/D)"),
    (37, "TUI settings hub (list/summary/behavior/theme)"),
    (38, "Dashboard display customization"),
    (39, "Unified color/theme runtime (v2 UI)"),
    (40, "OAuth browser-first flow with manual callback fallback"),
    (41, "Auto-switch to best account command"),
    (42, "Device-code OAuth login (--device-auth)"),
    (43, "Workspace/org-bound login (--org)"),
    (44, "Manual pin, unpin, and affinity-generation invalidation"),
    (45, "Per-account workspace selection command"),
    (46, "Default-on runtime Responses rotation proxy"),
    (47, "Reversible packaged Codex app bind and launcher routing"),
    (48, "Local usage ledger, budgets, and account policies"),
    (49, "Routing profiles and model capability matrix"),
    (50, "Local bridge tokens and integration snippets"),
    (51, "Provider-agnostic local history listing"),
    (52, "Why-selected and monitor diagnostics"),
    (53, "Config explain, init-config templates, and debug bundle"),
    (54, "mcodex convenience launcher (monitor/tmux/forward)"),
];

/// TS `runFeaturesCommand(deps)`.
pub fn run_features_command(out: &mut CliOut) -> i32 {
    out.info(format!("Implemented features ({})", IMPLEMENTED_FEATURES.len()));
    out.info("");
    for (id, name) in IMPLEMENTED_FEATURES {
        out.info(format!("{id}. {name}"));
    }
    0
}

// ============================================================================
// status / list
// ============================================================================

type FormatRateLimitEntryFn =
    Box<dyn Fn(&AccountMetadataV3, i64) -> Option<String> + Send + Sync>;

/// TS `StatusCommandDeps` (log sinks live on [`CliOut`]).
pub struct StatusCommandDeps {
    pub set_storage_path: SetStoragePathFn,
    pub get_storage_path: GetStoragePathFn,
    pub load_accounts: Box<dyn Fn() -> BoxFuture<Option<LoadedAccountStorage>> + Send + Sync>,
    pub resolve_active_index: Box<dyn Fn(&AccountStorageV3) -> usize + Send + Sync>,
    pub format_rate_limit_entry: FormatRateLimitEntryFn,
    pub load_runtime_observability_snapshot:
        Option<Box<dyn Fn() -> BoxFuture<Option<RuntimeObservabilitySnapshot>> + Send + Sync>>,
    pub load_app_bind_status:
        Option<Box<dyn Fn() -> BoxFuture<Option<AppBindRouterStatus>> + Send + Sync>>,
    pub load_app_helper_status: Option<Box<dyn Fn() -> Option<RuntimeAccountSignal> + Send + Sync>>,
    pub load_quota_cache: Option<Box<dyn Fn() -> BoxFuture<Option<QuotaCacheData>> + Send + Sync>>,
    pub inspect_storage_health:
        Option<Box<dyn Fn() -> BoxFuture<StorageHealthSummary> + Send + Sync>>,
    pub get_now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
    /// When true, emit a single machine-readable JSON object (cli-manager-03).
    pub json: bool,
}

impl StatusCommandDeps {
    /// Production wiring (matches the TS dispatcher's `runListOrStatusCommand`).
    pub fn production(json: bool) -> Self {
        StatusCommandDeps {
            set_storage_path: default_set_storage_path(),
            get_storage_path: default_get_storage_path(),
            load_accounts: Box::new(|| Box::pin(cma_storage::load::load_accounts())),
            resolve_active_index: Box::new(|storage| {
                cma_runtime::account_status::resolve_active_index(storage, ModelFamily::Codex)
            }),
            format_rate_limit_entry: Box::new(|account, now| {
                cma_runtime::account_status::format_rate_limit_entry(
                    account.rate_limit_reset_times.as_ref(),
                    now,
                    &format_wait_time,
                    ModelFamily::Codex,
                )
            }),
            load_runtime_observability_snapshot: Some(Box::new(|| {
                Box::pin(async { load_persisted_runtime_observability_snapshot() })
            })),
            load_app_bind_status: Some(Box::new(|| {
                Box::pin(async {
                    // TS: getAppBindStatus().then(s => s.running ? s.router :
                    // null).catch(() => null)
                    match get_app_bind_status(&AppBindOptions::default()).await {
                        Ok(status) if status.running => status.router,
                        _ => None,
                    }
                })
            })),
            load_app_helper_status: Some(Box::new(read_app_runtime_helper_account_signal)),
            load_quota_cache: Some(Box::new(|| {
                Box::pin(async { Some(load_quota_cache().await) })
            })),
            inspect_storage_health: Some(Box::new(|| Box::pin(inspect_storage_health()))),
            get_now: None,
            json,
        }
    }
}

const RESTORE_REASONS: [&str; 3] = ["empty-storage", "intentional-reset", "missing-storage"];

/// Build the status marker list for one account (cli-manager-03). Order
/// matters and is preserved: current → disabled → rate-limited →
/// 429-from-quota → quota-exhausted → cooldown.
#[allow(clippy::too_many_arguments)]
fn build_account_markers(
    account: &AccountMetadataV3,
    index: usize,
    active_index: usize,
    runtime_current: Option<&RuntimeCurrentAccountSelection>,
    now: i64,
    quota_cache: Option<&QuotaCacheData>,
    all_accounts: &[AccountMetadataV3],
    format_rate_limit_entry: &FormatRateLimitEntryFn,
) -> Vec<String> {
    let mut markers: Vec<String> = resolve_account_current_markers(index, active_index, runtime_current)
        .into_iter()
        .map(|marker| marker.as_str().to_string())
        .collect();
    if account.enabled == Some(false) {
        markers.push("disabled".to_string());
    }
    if format_rate_limit_entry(account, now).is_some() {
        markers.push("rate-limited".to_string());
    }
    let quota_entry = find_quota_cache_entry_for_account(quota_cache, account, all_accounts);
    if quota_entry.is_some_and(|entry| entry.status == 429.0)
        && !markers.iter().any(|marker| is_rate_limited_marker(marker))
    {
        markers.push("rate-limited".to_string());
    }
    if is_quota_cache_entry_exhausted(quota_entry, now) {
        markers.push("quota-exhausted".to_string());
    }
    if let Some(cooldown) = format_cooldown(
        account.cooling_down_until,
        account.cooldown_reason.as_ref().map(|reason| reason.as_str()),
        now,
    ) {
        markers.push(format!("cooldown:{cooldown}"));
    }
    markers
}

fn format_runtime_last_account(snapshot: &RuntimeObservabilitySnapshot) -> Option<String> {
    if let Some(label) = &snapshot.last_account_label
        && !label.is_empty()
        && !label.contains('@')
    {
        return Some(label.clone());
    }
    if let Some(id) = &snapshot.last_account_id
        && !id.is_empty()
    {
        return Some(match snapshot.last_account_index {
            Some(index) => format!("Account {} ({id})", index + 1),
            None => id.clone(),
        });
    }
    if let Some(index) = snapshot.last_account_index {
        return Some(format!("Account {}", index + 1));
    }
    None
}

/// Production entry (dispatcher precomputes `json` from `--json`/`-j`).
pub async fn run_status_command(json: bool, out: &mut CliOut) -> i32 {
    run_status_command_with(&StatusCommandDeps::production(json), out).await
}

/// TS `runStatusCommand(deps)`.
pub async fn run_status_command_with(deps: &StatusCommandDeps, out: &mut CliOut) -> i32 {
    (deps.set_storage_path)(None);
    let loaded = (deps.load_accounts)().await;
    let path = (deps.get_storage_path)();
    let storage_health = match &deps.inspect_storage_health {
        Some(inspect) => Some(inspect().await),
        None => None,
    };

    let is_empty = loaded
        .as_ref()
        .map(|loaded| loaded.storage.accounts.is_empty())
        .unwrap_or(true);
    if is_empty {
        let restore_reason = loaded
            .as_ref()
            .and_then(|loaded| loaded.restore.as_ref())
            .map(|restore| restore.restore_reason)
            .filter(|reason| RESTORE_REASONS.contains(reason));
        let effective_state: Option<String> = if restore_reason == Some("intentional-reset") {
            Some("intentional-reset".to_string())
        } else if let Some(health) = &storage_health {
            Some(health.state.as_str().to_string())
        } else if matches!(restore_reason, Some("empty-storage") | Some("missing-storage")) {
            Some("empty".to_string())
        } else {
            None
        };
        if deps.json {
            let mut payload = Map::new();
            payload.insert("storagePath".into(), Value::from(path));
            payload.insert(
                "storageHealth".into(),
                effective_state.clone().map(Value::from).unwrap_or(Value::Null),
            );
            payload.insert("accountCount".into(), Value::from(0));
            // Emit the same keys the populated branch does (as null) so a
            // --json consumer sees one stable shape regardless of account
            // count.
            payload.insert("activeIndex".into(), Value::Null);
            payload.insert("pinnedAccountIndex".into(), Value::Null);
            payload.insert("recommendedIndex".into(), Value::Null);
            payload.insert("recommendationReason".into(), Value::Null);
            payload.insert("runtimeInUseIndex".into(), Value::Null);
            payload.insert("accounts".into(), Value::Array(Vec::new()));
            out.info(stringify_pretty2(&Value::Object(payload)));
            return 0;
        }
        out.info(match effective_state.as_deref() {
            Some("intentional-reset") => "No accounts configured. Storage was intentionally reset.",
            Some("recoverable") => "No accounts configured. Recovery artifacts are available.",
            Some("corrupt") => "No accounts configured. Storage appears corrupted.",
            _ => "No accounts configured.",
        });
        out.info(format!("Storage: {path}"));
        if let Some(state) = effective_state {
            out.info(format!("Storage health: {state}"));
        }
        return 0;
    }

    let storage = loaded.expect("non-empty checked above").storage;
    let now = deps.get_now.as_ref().map(|f| f()).unwrap_or_else(now_ms);
    let active_index = (deps.resolve_active_index)(&storage);
    let forecast_inputs: Vec<ForecastAccountInput<'_>> = storage
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| ForecastAccountInput::new(index, account, index == active_index, now))
        .collect();
    let forecast_results = evaluate_forecast_accounts(&forecast_inputs);
    let recommendation = recommend_forecast_account(&forecast_results);
    if !deps.json {
        out.info(format!("Accounts ({})", storage.accounts.len()));
        out.info(format!("Storage: {path}"));
        if let Some(recommended_index) = recommendation.recommended_index {
            out.info(format!(
                "Selection reason: account {} ({})",
                recommended_index + 1,
                recommendation.reason
            ));
        }
        if let Some(health) = &storage_health {
            out.info(format!("Storage health: {}", health.state.as_str()));
        }
    }
    let app_helper_status = deps.load_app_helper_status.as_ref().and_then(|load| load());
    let (runtime_snapshot, app_bind_status, quota_cache) = tokio::join!(
        async {
            match &deps.load_runtime_observability_snapshot {
                Some(load) => load().await,
                None => None,
            }
        },
        async {
            match &deps.load_app_bind_status {
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
            runtime_snapshot: runtime_snapshot.clone(),
            app_bind_status,
            app_helper_status,
        },
        RuntimeCurrentAccountOptions {
            now: Some(now),
            max_age_ms: None,
        },
    );

    // cli-manager-03: machine-readable output for status/list.
    if deps.json {
        let accounts: Vec<Value> = storage
            .accounts
            .iter()
            .enumerate()
            .map(|(i, account)| {
                let markers = build_account_markers(
                    account,
                    i,
                    active_index,
                    runtime_current.as_ref(),
                    now,
                    quota_cache.as_ref(),
                    &storage.accounts,
                    &deps.format_rate_limit_entry,
                );
                let mut row = Map::new();
                row.insert("index".into(), Value::from(i as i64));
                row.insert(
                    "label".into(),
                    Value::from(format_account_label(Some(account), i)),
                );
                row.insert("enabled".into(), Value::from(account.enabled != Some(false)));
                row.insert("current".into(), Value::from(i == active_index));
                row.insert(
                    "markers".into(),
                    Value::Array(markers.into_iter().map(Value::from).collect()),
                );
                row.insert(
                    "lastUsed".into(),
                    if account.last_used > 0 {
                        Value::from(account.last_used)
                    } else {
                        Value::Null
                    },
                );
                row.insert(
                    "reason".into(),
                    forecast_results
                        .get(i)
                        .and_then(|result| result.reasons.first())
                        .map(|reason| Value::from(reason.clone()))
                        .unwrap_or(Value::Null),
                );
                Value::Object(row)
            })
            .collect();
        let mut payload = Map::new();
        payload.insert("storagePath".into(), Value::from(path));
        payload.insert(
            "storageHealth".into(),
            storage_health
                .as_ref()
                .map(|health| Value::from(health.state.as_str()))
                .unwrap_or(Value::Null),
        );
        payload.insert("accountCount".into(), Value::from(storage.accounts.len() as i64));
        payload.insert("activeIndex".into(), Value::from(active_index as i64));
        payload.insert(
            "pinnedAccountIndex".into(),
            storage
                .pinned_account_index
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        payload.insert(
            "recommendedIndex".into(),
            recommendation
                .recommended_index
                .map(|index| Value::from(index as i64))
                .unwrap_or(Value::Null),
        );
        payload.insert(
            "recommendationReason".into(),
            Value::from(recommendation.reason.clone()),
        );
        payload.insert(
            "runtimeInUseIndex".into(),
            runtime_current
                .as_ref()
                .map(|current| Value::from(current.index as i64))
                .unwrap_or(Value::Null),
        );
        payload.insert("accounts".into(), Value::Array(accounts));
        out.info(stringify_pretty2(&Value::Object(payload)));
        return 0;
    }

    if let Some(snapshot) = &runtime_snapshot {
        let runtime_metrics = &snapshot.runtime_metrics;
        let pool_cooldown = snapshot
            .pool_exhaustion_cooldown_until
            .filter(|until| *until > now)
            .map(|until| format_wait_time(until - now));
        let server_cooldown = snapshot
            .server_burst_cooldown_until
            .filter(|until| *until > now)
            .map(|until| format_wait_time(until - now));
        out.info(format!(
            "Runtime: responses={}, refresh={}, probes={}, budgetExhaustions={}",
            snapshot.responses_requests,
            snapshot.auth_refresh_requests,
            snapshot.diagnostic_probe_requests,
            runtime_metrics.request_attempt_budget_exhaustions
        ));
        if let Some(last_runtime_account) = format_runtime_last_account(snapshot) {
            out.info(format!("Last runtime account: {last_runtime_account}"));
        }
        if pool_cooldown.is_some() || server_cooldown.is_some() {
            out.info(format!(
                "Cooldowns: pool={}, server-burst={}",
                pool_cooldown.as_deref().unwrap_or("none"),
                server_cooldown.as_deref().unwrap_or("none")
            ));
        }
        if let Some(current_request_id) = &snapshot.current_request_id
            && !current_request_id.is_empty()
        {
            out.info(format!("Last request trace: {current_request_id}"));
        }
    }
    if let Some(current) = &runtime_current {
        out.info(format!(
            "Runtime in use: account {} ({})",
            current.index + 1,
            current.source.as_str()
        ));
    }
    if let Some(pinned_account_index) = storage.pinned_account_index {
        if pinned_account_index < 0 || pinned_account_index >= storage.accounts.len() as i64 {
            out.info(format!(
                "Pinned: invalid account index {pinned_account_index}; run codex-multi-auth unpin"
            ));
        } else {
            out.info(format!("Pinned: account {} (set by switch)", pinned_account_index + 1));
            if let Some(current) = &runtime_current
                && current.index as i64 != pinned_account_index
            {
                out.info(format!(
                    "  warning: runtime currently using account {} but pin requests account {}; the proxy will pick up the pin on the next request.",
                    current.index + 1,
                    pinned_account_index + 1
                ));
            }
        }
    }
    out.info("");

    for (i, account) in storage.accounts.iter().enumerate() {
        let label = format_account_label(Some(account), i);
        let markers = build_account_markers(
            account,
            i,
            active_index,
            runtime_current.as_ref(),
            now,
            quota_cache.as_ref(),
            &storage.accounts,
            &deps.format_rate_limit_entry,
        );
        let marker_label = if markers.is_empty() {
            String::new()
        } else {
            format!(" [{}]", markers.join(", "))
        };
        let last_used = if account.last_used > 0 {
            format!("used {} ago", format_wait_time(now - account.last_used))
        } else {
            "never used".to_string()
        };
        out.info(format!("{}. {label}{marker_label} {last_used}", i + 1));
        if let Some(primary_reason) = forecast_results
            .get(i)
            .and_then(|result| result.reasons.first())
        {
            out.info(format!("   reason: {primary_reason}"));
        }
        // Surface every workspace a same-email account can rotate between, so
        // personal Plus vs business/team stay visible at once (issue #491).
        if account.workspaces.as_ref().map(Vec::len).unwrap_or(0) > 1 {
            out.info("   workspaces:");
            for workspace_line in format_workspace_lines(Some(account), "     ") {
                out.info(workspace_line);
            }
        }
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::RateLimitStateV3;
    use cma_storage::load::RestoreMetadata;

    fn deps_with(
        loaded: Option<LoadedAccountStorage>,
        json: bool,
        now: i64,
    ) -> StatusCommandDeps {
        StatusCommandDeps {
            set_storage_path: Box::new(|_| {}),
            get_storage_path: Box::new(|| "/tmp/accounts.json".to_string()),
            load_accounts: Box::new(move || {
                let loaded = loaded.clone();
                Box::pin(async move { loaded })
            }),
            resolve_active_index: Box::new(|storage| {
                cma_runtime::account_status::resolve_active_index(storage, ModelFamily::Codex)
            }),
            format_rate_limit_entry: Box::new(|account, now| {
                cma_runtime::account_status::format_rate_limit_entry(
                    account.rate_limit_reset_times.as_ref(),
                    now,
                    &format_wait_time,
                    ModelFamily::Codex,
                )
            }),
            load_runtime_observability_snapshot: None,
            load_app_bind_status: None,
            load_app_helper_status: None,
            load_quota_cache: None,
            inspect_storage_health: None,
            get_now: Some(Box::new(move || now)),
            json,
        }
    }

    fn storage_with_accounts(count: usize) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        for i in 0..count {
            let mut account = AccountMetadataV3::new(format!("token-{i}"), 1, 1_000);
            account.email = Some(format!("user{i}@example.com"));
            storage.accounts.push(account);
        }
        storage
    }

    #[tokio::test]
    async fn empty_storage_json_emits_stable_key_set() {
        let deps = deps_with(None, true, 5_000);
        let mut out = CliOut::capture();
        assert_eq!(run_status_command_with(&deps, &mut out).await, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        let object = payload.as_object().expect("object");
        let keys: Vec<&str> = object.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "storagePath",
                "storageHealth",
                "accountCount",
                "activeIndex",
                "pinnedAccountIndex",
                "recommendedIndex",
                "recommendationReason",
                "runtimeInUseIndex",
                "accounts",
            ]
        );
        assert_eq!(payload["accountCount"], Value::from(0));
        assert_eq!(payload["activeIndex"], Value::Null);
        assert_eq!(payload["accounts"], Value::Array(vec![]));
    }

    #[tokio::test]
    async fn empty_storage_intentional_reset_message() {
        let loaded = LoadedAccountStorage {
            storage: AccountStorageV3::empty(),
            restore: Some(RestoreMetadata {
                restore_eligible: false,
                restore_reason: "intentional-reset",
            }),
        };
        let deps = deps_with(Some(loaded), false, 5_000);
        let mut out = CliOut::capture();
        assert_eq!(run_status_command_with(&deps, &mut out).await, 0);
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "No accounts configured. Storage was intentionally reset.");
        assert_eq!(lines[1], "Storage: /tmp/accounts.json");
        assert_eq!(lines[2], "Storage health: intentional-reset");
    }

    #[tokio::test]
    async fn populated_json_has_markers_and_recommendation() {
        let mut storage = storage_with_accounts(2);
        storage.accounts[1].enabled = Some(false);
        let mut times = RateLimitStateV3::new();
        times.insert("codex", 999_999);
        storage.accounts[0].rate_limit_reset_times = Some(times);
        let loaded = LoadedAccountStorage { storage, restore: None };
        let deps = deps_with(Some(loaded), true, 5_000);
        let mut out = CliOut::capture();
        assert_eq!(run_status_command_with(&deps, &mut out).await, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["accountCount"], Value::from(2));
        assert_eq!(payload["activeIndex"], Value::from(0));
        let accounts = payload["accounts"].as_array().expect("accounts");
        // Account 0 is current + rate-limited; account 1 disabled.
        let markers0: Vec<&str> = accounts[0]["markers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(markers0, vec!["current", "rate-limited"]);
        let markers1: Vec<&str> = accounts[1]["markers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(markers1, vec!["disabled"]);
        assert_eq!(accounts[0]["lastUsed"], Value::from(1_000));
    }

    #[tokio::test]
    async fn text_mode_lists_accounts_with_used_ago() {
        let storage = storage_with_accounts(1);
        let loaded = LoadedAccountStorage { storage, restore: None };
        let deps = deps_with(Some(loaded), false, 3_601_000);
        let mut out = CliOut::capture();
        assert_eq!(run_status_command_with(&deps, &mut out).await, 0);
        let text = out.info_text();
        assert!(text.starts_with("Accounts (1)\nStorage: /tmp/accounts.json"));
        // formatWaitTime is minutes-based (`Xm Ys`, frozen): 3,600,000 ms
        // renders as "60m 0s", never "1h".
        assert!(text.contains("1. Account 1 (user0@example.com) [current] used 60m 0s ago"));
    }

    #[tokio::test]
    async fn invalid_pin_prints_unpin_hint() {
        let mut storage = storage_with_accounts(1);
        storage.pinned_account_index = Some(9);
        let loaded = LoadedAccountStorage { storage, restore: None };
        let deps = deps_with(Some(loaded), false, 5_000);
        let mut out = CliOut::capture();
        assert_eq!(run_status_command_with(&deps, &mut out).await, 0);
        assert!(out
            .info_text()
            .contains("Pinned: invalid account index 9; run codex-multi-auth unpin"));
    }

    #[test]
    fn features_command_lists_all_54() {
        let mut out = CliOut::capture();
        assert_eq!(run_features_command(&mut out), 0);
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "Implemented features (54)");
        assert_eq!(lines[1], "");
        assert_eq!(lines[2], "1. Multi-account OAuth login dashboard");
        assert_eq!(lines[55], "54. mcodex convenience launcher (monitor/tmux/forward)");
    }

    #[test]
    fn runtime_last_account_label_email_guard() {
        let mut snapshot = cma_runtime::observability::create_default_snapshot();
        snapshot.last_account_label = Some("user@example.com".to_string());
        snapshot.last_account_id = Some("acct_123".to_string());
        snapshot.last_account_index = Some(1);
        // Label containing '@' is suppressed in favor of the id form.
        assert_eq!(
            format_runtime_last_account(&snapshot).as_deref(),
            Some("Account 2 (acct_123)")
        );
        snapshot.last_account_label = Some("Team account".to_string());
        assert_eq!(
            format_runtime_last_account(&snapshot).as_deref(),
            Some("Team account")
        );
    }
}
