//! Port of `lib/codex-manager/commands/report.ts`.
//!
//! `report [--live] [--json] [--explain] [--model M] [--max-accounts N]
//! [--max-probes N] [--cached-only] [--out PATH]` — full machine-readable
//! account/forecast/runtime report.
//!
//! Contract divergences vs `best`/`forecast` (spec 08 gotchas 2/3/4):
//! - probe-refresh patches persist FIRST (reload-clone-match-save) and the
//!   in-memory apply happens only AFTER the persist succeeds (forecast is
//!   the other way around);
//! - `--model` without `--live` is silently accepted;
//! - live probing is budgeted: `--max-accounts` caps considered accounts
//!   (checked at the TOP of each iteration, before the enabled filter),
//!   `--max-probes` caps executed probes (checked just before probing);
//! - `--out` writes the pretty JSON + trailing newline atomically in BOTH
//!   output modes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, TimeZone, Utc};
use cma_core::errors::CodexError;
use cma_core::json_io::stringify_pretty2;
use cma_core::model_family::{DEFAULT_PROBE_MODEL, ModelFamily};
use cma_core::schemas::account_storage::{AccountIdSource, AccountStorageV3};
use cma_core::schemas::token::{TokenFailure, TokenResult};
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_quota::cache::QuotaCacheData;
use cma_quota::forecast::{
    ForecastAccountInput, evaluate_forecast_accounts, recommend_forecast_account,
    summarize_forecast,
};
use cma_quota::probe::{
    CodexQuotaSnapshot, ProbeCodexQuotaOptions, describe_codex_probe_failure,
    fetch_codex_quota_snapshot, format_quota_snapshot_line,
};
use cma_runtime::observability::RuntimeObservabilitySnapshot;
use cma_storage::health::StorageHealthSummary;
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    AccountIdentityMatch, BoxFuture, GetStoragePathFn, LoadAccountsFn, RefreshedAccountPatch,
    SaveAccountsFn, SetStoragePathFn, apply_refreshed_account_patch, default_get_storage_path,
    default_load_accounts, default_save_accounts, default_set_storage_path, default_write_file,
    persist_refreshed_account_patch, serialize_forecast_results,
};
use crate::formatters::model::{ModelInspection, format_model_inspection, inspect_requested_model};
use crate::formatters::text_style::normalize_failure_detail;
use crate::repair::fix::QuotaProbeRequest;

// ============================================================================
// Options / parsing
// ============================================================================

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReportCliOptions {
    live: bool,
    json: bool,
    explain: bool,
    model: String,
    max_accounts: Option<usize>,
    max_probes: Option<usize>,
    cached_only: bool,
    out_path: Option<String>,
}

impl Default for ReportCliOptions {
    fn default() -> Self {
        ReportCliOptions {
            live: false,
            json: false,
            explain: false,
            model: DEFAULT_PROBE_MODEL.to_string(),
            max_accounts: None,
            max_probes: None,
            cached_only: false,
            out_path: None,
        }
    }
}

fn print_report_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage: codex-multi-auth report [--live] [--json] [--explain] [--model MODEL] [--out PATH]".to_string(),
            String::new(),
            "Options:".to_string(),
            "  --live, -l         Probe live quota headers via Codex backend".to_string(),
            "  --json, -j         Print machine-readable JSON output".to_string(),
            "  --explain          Print per-account reasoning in text mode".to_string(),
            format!("  --model, -m        Probe model for live mode (default: {DEFAULT_PROBE_MODEL})"),
            "  --max-accounts N   Limit how many enabled accounts live mode can consider".to_string(),
            "  --max-probes N     Limit how many live quota probes can run".to_string(),
            "  --cached-only      Skip refreshes and only use already-usable access tokens".to_string(),
            "  --out              Write JSON report to a file path".to_string(),
        ]
        .join("\n"),
    );
}

/// TS `parsePositiveIntegerOption(rawValue)` — trimmed, digit-only, safe
/// integer `>= 1`.
fn parse_positive_integer_option(raw_value: &str) -> Option<usize> {
    let normalized = raw_value.trim();
    if normalized.is_empty() || !normalized.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let parsed: u64 = normalized.parse().ok()?;
    if !(1..=9_007_199_254_740_991).contains(&parsed) {
        return None;
    }
    Some(parsed as usize)
}

fn parse_report_args(args: &[String]) -> Result<ReportCliOptions, String> {
    let mut options = ReportCliOptions::default();

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        match arg {
            "--live" | "-l" => {
                options.live = true;
                i += 1;
                continue;
            }
            "--json" | "-j" => {
                options.json = true;
                i += 1;
                continue;
            }
            "--explain" => {
                options.explain = true;
                i += 1;
                continue;
            }
            "--cached-only" => {
                options.cached_only = true;
                i += 1;
                continue;
            }
            "--model" | "-m" => {
                let value = args.get(i + 1).map(|value| value.trim().to_string());
                match value {
                    Some(value) if !value.is_empty() && !value.starts_with('-') => {
                        options.model = value;
                        i += 2;
                        continue;
                    }
                    _ => return Err("Missing value for --model".to_string()),
                }
            }
            "--max-accounts" => {
                let Some(value) = args.get(i + 1) else {
                    return Err("Missing value for --max-accounts".to_string());
                };
                if value.is_empty() {
                    return Err("Missing value for --max-accounts".to_string());
                }
                let Some(parsed) = parse_positive_integer_option(value) else {
                    return Err("--max-accounts must be a positive integer".to_string());
                };
                options.max_accounts = Some(parsed);
                i += 2;
                continue;
            }
            "--max-probes" => {
                let Some(value) = args.get(i + 1) else {
                    return Err("Missing value for --max-probes".to_string());
                };
                if value.is_empty() {
                    return Err("Missing value for --max-probes".to_string());
                }
                let Some(parsed) = parse_positive_integer_option(value) else {
                    return Err("--max-probes must be a positive integer".to_string());
                };
                options.max_probes = Some(parsed);
                i += 2;
                continue;
            }
            "--out" => {
                let Some(value) = args.get(i + 1) else {
                    return Err("Missing value for --out".to_string());
                };
                if value.is_empty() {
                    return Err("Missing value for --out".to_string());
                }
                options.out_path = Some(value.clone());
                i += 2;
                continue;
            }
            _ => {}
        }
        if let Some(raw) = arg.strip_prefix("--model=") {
            let value = raw.trim();
            if value.is_empty() || value.starts_with('-') {
                return Err("Missing value for --model".to_string());
            }
            options.model = value.to_string();
            i += 1;
            continue;
        }
        if let Some(raw) = arg.strip_prefix("--max-accounts=") {
            let Some(parsed) = parse_positive_integer_option(raw) else {
                return Err("--max-accounts must be a positive integer".to_string());
            };
            options.max_accounts = Some(parsed);
            i += 1;
            continue;
        }
        if let Some(raw) = arg.strip_prefix("--max-probes=") {
            let Some(parsed) = parse_positive_integer_option(raw) else {
                return Err("--max-probes must be a positive integer".to_string());
            };
            options.max_probes = Some(parsed);
            i += 1;
            continue;
        }
        if let Some(raw) = arg.strip_prefix("--out=") {
            let value = raw.trim();
            if value.is_empty() {
                return Err("Missing value for --out".to_string());
            }
            options.out_path = Some(value.to_string());
            i += 1;
            continue;
        }
        return Err(format!("Unknown option: {arg}"));
    }

    Ok(options)
}

// ============================================================================
// Deps
// ============================================================================

/// TS `ReportCommandDeps` (log sinks live on [`CliOut`]).
#[allow(clippy::type_complexity)] // boxed DI seams mirror the TS deps object 1:1
pub struct ReportCommandDeps {
    pub set_storage_path: SetStoragePathFn,
    pub get_storage_path: GetStoragePathFn,
    pub load_accounts: LoadAccountsFn,
    pub save_accounts: SaveAccountsFn,
    pub queued_refresh: Box<dyn Fn(String) -> BoxFuture<TokenResult> + Send + Sync>,
    pub fetch_codex_quota_snapshot: Box<
        dyn Fn(QuotaProbeRequest) -> BoxFuture<Result<CodexQuotaSnapshot, CodexError>>
            + Send
            + Sync,
    >,
    pub inspect_storage_health:
        Option<Box<dyn Fn() -> BoxFuture<StorageHealthSummary> + Send + Sync>>,
    pub load_runtime_observability_snapshot: Option<
        Box<
            dyn Fn() -> BoxFuture<Result<Option<RuntimeObservabilitySnapshot>, CodexError>>
                + Send
                + Sync,
        >,
    >,
    pub load_quota_cache: Option<Box<dyn Fn() -> BoxFuture<QuotaCacheData> + Send + Sync>>,
    pub get_now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
    pub get_cwd: Option<Box<dyn Fn() -> PathBuf + Send + Sync>>,
    pub write_file: Option<
        Box<dyn Fn(PathBuf, String) -> BoxFuture<std::io::Result<()>> + Send + Sync>,
    >,
}

impl Default for ReportCommandDeps {
    fn default() -> Self {
        ReportCommandDeps {
            set_storage_path: default_set_storage_path(),
            get_storage_path: default_get_storage_path(),
            load_accounts: default_load_accounts(),
            save_accounts: default_save_accounts(),
            queued_refresh: Box::new(|refresh_token| {
                Box::pin(
                    async move { cma_auth::refresh_queue::queued_refresh(&refresh_token).await },
                )
            }),
            fetch_codex_quota_snapshot: Box::new(|request| {
                Box::pin(async move {
                    fetch_codex_quota_snapshot(&ProbeCodexQuotaOptions {
                        account_id: request.account_id,
                        access_token: request.access_token,
                        model: Some(request.model),
                        ..Default::default()
                    })
                    .await
                })
            }),
            inspect_storage_health: Some(Box::new(|| {
                Box::pin(cma_storage::health::inspect_storage_health())
            })),
            load_runtime_observability_snapshot: Some(Box::new(|| {
                Box::pin(async {
                    Ok(
                        cma_runtime::observability::load_persisted_runtime_observability_snapshot(
                        ),
                    )
                })
            })),
            load_quota_cache: Some(Box::new(|| Box::pin(cma_quota::cache::load_quota_cache()))),
            get_now: None,
            get_cwd: None,
            write_file: None,
        }
    }
}

/// `new Date(now).toISOString()`.
fn to_iso_string(now: i64) -> String {
    Utc.timestamp_millis_opt(now)
        .single()
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

// ============================================================================
// runReportCommand
// ============================================================================

/// Production entry (dispatcher wiring).
pub async fn run_report_command(args: &[String], out: &mut CliOut) -> i32 {
    run_report_command_with(args, &ReportCommandDeps::default(), out).await
}

/// TS `runReportCommand(args, deps)`.
pub async fn run_report_command_with(
    args: &[String],
    deps: &ReportCommandDeps,
    out: &mut CliOut,
) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_report_usage(out);
        return 0;
    }

    let options = match parse_report_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            print_report_usage(out);
            return 1;
        }
    };
    let trimmed_model = options.model.trim();
    let requested_model = if trimmed_model.is_empty() {
        DEFAULT_PROBE_MODEL.to_string()
    } else {
        trimmed_model.to_string()
    };
    let model_inspection: ModelInspection = inspect_requested_model(&requested_model);

    (deps.set_storage_path)(None);
    let storage_path = (deps.get_storage_path)();
    let mut storage: Option<AccountStorageV3> = (deps.load_accounts)().await;
    let storage_health = match &deps.inspect_storage_health {
        Some(inspect) => Some(inspect().await),
        None => None,
    };
    let now = deps
        .get_now
        .as_ref()
        .map(|get_now| get_now())
        .unwrap_or_else(cma_core::utils::now_ms);
    let account_count = storage
        .as_ref()
        .map(|storage| storage.accounts.len())
        .unwrap_or(0);
    let active_index = storage
        .as_ref()
        .map(|storage| {
            cma_runtime::account_status::resolve_active_index(storage, ModelFamily::Codex)
        })
        .unwrap_or(0);
    let mut refresh_failures: HashMap<usize, TokenFailure> = HashMap::new();
    let mut live_quota_by_index: HashMap<usize, CodexQuotaSnapshot> = HashMap::new();
    let mut probe_errors: Vec<String> = Vec::new();
    let quota_cache: Option<QuotaCacheData> = match &deps.load_quota_cache {
        Some(load_quota_cache) => Some(load_quota_cache().await),
        None => None,
    };
    let mut runtime_snapshot: Option<RuntimeObservabilitySnapshot> = None;
    let mut runtime_key_present = false;
    let mut runtime_snapshot_load_error: Option<String> = None;
    if let Some(load_snapshot) = &deps.load_runtime_observability_snapshot {
        runtime_key_present = true;
        match load_snapshot().await {
            Ok(snapshot) => runtime_snapshot = snapshot,
            Err(error) => {
                runtime_snapshot = None;
                let message = error.message().to_string();
                out.error(format!(
                    "Runtime observability snapshot unavailable: {message}"
                ));
                runtime_snapshot_load_error = Some(message);
            }
        }
    }
    let mut considered_live_accounts = 0usize;
    let mut executed_live_probes = 0usize;

    if let Some(storage) = &mut storage
        && options.live
    {
        for i in 0..storage.accounts.len() {
            // Account budget — checked at the TOP of each iteration, BEFORE
            // the enabled filter.
            if let Some(max_accounts) = options.max_accounts
                && considered_live_accounts >= max_accounts
            {
                probe_errors.push(format!(
                    "live probe account budget reached ({max_accounts})"
                ));
                break;
            }
            if storage.accounts[i].enabled == Some(false) {
                continue;
            }
            considered_live_accounts += 1;

            let label = crate::repair::fix::account_label(&storage.accounts[i], i);
            let mut probe_access_token = storage.accounts[i].access_token.clone();
            let mut probe_account_id = storage.accounts[i]
                .account_id
                .clone()
                .or_else(|| extract_account_id(storage.accounts[i].access_token.as_deref()));
            if !crate::login::account_credentials::has_usable_access_token(
                &storage.accounts[i],
                now,
            ) {
                if options.cached_only {
                    probe_errors.push(format!(
                        "{label}: skipped refresh because --cached-only is enabled"
                    ));
                    continue;
                }
                let refresh_result =
                    (deps.queued_refresh)(storage.accounts[i].refresh_token.clone()).await;
                let success = match refresh_result {
                    TokenResult::Success(success) => success,
                    TokenResult::Failed(failure) => {
                        let mut normalized = failure.clone();
                        normalized.message = Some(normalize_failure_detail(
                            failure.message.as_deref(),
                            failure.reason.map(|reason| reason.as_str()),
                        ));
                        refresh_failures.insert(i, normalized);
                        continue;
                    }
                };

                let refreshed_email = sanitize_email(
                    extract_account_email(Some(&success.access), success.id_token.as_deref())
                        .as_deref(),
                );
                let token_derived_account_id = extract_account_id(Some(&success.access));
                let refreshed_account_id = storage.accounts[i]
                    .account_id
                    .clone()
                    .or_else(|| token_derived_account_id.clone());
                let previous_refresh_token = storage.accounts[i].refresh_token.clone();
                let previous_access_token = storage.accounts[i].access_token.clone();
                let previous_expires_at = storage.accounts[i].expires_at;
                let previous_email = storage.accounts[i].email.clone();
                let previous_account_id = storage.accounts[i].account_id.clone();
                let mut refresh_patch = RefreshedAccountPatch {
                    refresh_token: success.refresh.clone(),
                    access_token: success.access.clone(),
                    expires_at: success.expires,
                    email: None,
                    account_id: None,
                    account_id_source: None,
                };
                if let Some(email) = &refreshed_email {
                    refresh_patch.email = Some(email.clone());
                }
                if let Some(account_id) = &token_derived_account_id {
                    refresh_patch.account_id = Some(account_id.clone());
                    refresh_patch.account_id_source = Some(AccountIdSource::Token);
                }
                let account_match = AccountIdentityMatch {
                    refresh_token: Some(previous_refresh_token.clone()),
                    email: previous_email.clone(),
                    account_id: previous_account_id.clone(),
                };
                if previous_refresh_token != refresh_patch.refresh_token
                    || previous_access_token.as_deref()
                        != Some(refresh_patch.access_token.as_str())
                    || previous_expires_at != Some(refresh_patch.expires_at)
                {
                    // Persist FIRST; the in-memory apply happens only after
                    // the persist succeeds (spec 08 gotcha 3 — the reverse
                    // of forecast).
                    let persisted = persist_refreshed_account_patch(
                        storage,
                        &account_match,
                        &refresh_patch,
                        || (deps.load_accounts)(),
                        |next_storage: &AccountStorageV3| {
                            (deps.save_accounts)(next_storage.clone())
                        },
                    )
                    .await;
                    if let Err(error) = persisted {
                        let message =
                            normalize_failure_detail(Some(error.message()), None);
                        probe_errors.push(format!("{label}: {message}"));
                        continue;
                    }
                    apply_refreshed_account_patch(&mut storage.accounts[i], &refresh_patch);
                }
                probe_access_token = Some(success.access.clone());
                probe_account_id = refresh_patch
                    .account_id
                    .clone()
                    .or_else(|| storage.accounts[i].account_id.clone())
                    .or(refreshed_account_id);
            }

            let (Some(probe_access_token), Some(probe_account_id)) =
                (probe_access_token, probe_account_id)
            else {
                probe_errors.push(format!("{label}: missing accountId for live probe"));
                continue;
            };
            // Probe budget — checked just before probing.
            if let Some(max_probes) = options.max_probes
                && executed_live_probes >= max_probes
            {
                probe_errors.push(format!("live probe request budget reached ({max_probes})"));
                break;
            }

            executed_live_probes += 1;
            match (deps.fetch_codex_quota_snapshot)(QuotaProbeRequest {
                account_id: probe_account_id,
                access_token: probe_access_token,
                model: model_inspection.normalized.clone(),
            })
            .await
            {
                Ok(live_quota) => {
                    live_quota_by_index.insert(i, live_quota);
                }
                Err(error) => {
                    let message = describe_codex_probe_failure(
                        &error,
                        Some(&|raw: &str| normalize_failure_detail(Some(raw), None)),
                    );
                    probe_errors.push(format!("{label}: {message}"));
                }
            }
        }
    }

    let runtime_overlay = runtime_snapshot
        .as_ref()
        .map(crate::repair::doctor::snapshot_to_overlay);
    let forecast_results = match &storage {
        Some(storage) => {
            let inputs: Vec<ForecastAccountInput<'_>> = storage
                .accounts
                .iter()
                .enumerate()
                .map(|(index, account)| ForecastAccountInput {
                    index,
                    account,
                    is_current: index == active_index,
                    now,
                    refresh_failure: refresh_failures.get(&index),
                    live_quota: live_quota_by_index.get(&index),
                    quota_cache: quota_cache.as_ref(),
                    all_accounts: Some(&storage.accounts),
                    runtime_overlay: runtime_overlay.as_ref(),
                })
                .collect();
            evaluate_forecast_accounts(&inputs)
        }
        None => Vec::new(),
    };
    let forecast_summary = summarize_forecast(&forecast_results);
    let recommendation = recommend_forecast_account(&forecast_results);
    let enabled_count = storage
        .as_ref()
        .map(|storage| {
            storage
                .accounts
                .iter()
                .filter(|account| account.enabled != Some(false))
                .count()
        })
        .unwrap_or(0);
    let disabled_count = account_count.saturating_sub(enabled_count);
    let cooling_count = storage
        .as_ref()
        .map(|storage| {
            storage
                .accounts
                .iter()
                .filter(|account| {
                    matches!(account.cooling_down_until, Some(until) if until > now)
                })
                .count()
        })
        .unwrap_or(0);
    let rate_limited_count = storage
        .as_ref()
        .map(|storage| {
            storage
                .accounts
                .iter()
                .filter(|account| {
                    cma_runtime::account_status::format_rate_limit_entry(
                        account.rate_limit_reset_times.as_ref(),
                        now,
                        &cma_accounts::rate_limits::format_wait_time,
                        ModelFamily::Codex,
                    )
                    .is_some()
                })
                .count()
        })
        .unwrap_or(0);

    // Report object — exact key order (spec 08 §4.14 step 6).
    let generated_at = to_iso_string(now);
    let mut report = Map::new();
    report.insert("command".into(), Value::from("report"));
    report.insert("generatedAt".into(), Value::from(generated_at.clone()));
    report.insert("storagePath".into(), Value::from(storage_path.clone()));
    if let Some(storage_health) = &storage_health {
        report.insert(
            "storageHealth".into(),
            serde_json::to_value(storage_health).unwrap_or(Value::Null),
        );
    }
    report.insert("model".into(), Value::from(requested_model.clone()));
    let mut model_selection = Map::new();
    model_selection.insert(
        "requested".into(),
        Value::from(model_inspection.requested.clone()),
    );
    model_selection.insert(
        "normalized".into(),
        Value::from(model_inspection.normalized.clone()),
    );
    model_selection.insert("remapped".into(), Value::from(model_inspection.remapped));
    model_selection.insert(
        "promptFamily".into(),
        serde_json::to_value(model_inspection.prompt_family).unwrap_or(Value::Null),
    );
    model_selection.insert(
        "capabilities".into(),
        serde_json::to_value(model_inspection.capabilities).unwrap_or(Value::Null),
    );
    report.insert("modelSelection".into(), Value::Object(model_selection));
    report.insert("liveProbe".into(), Value::from(options.live));
    let mut live_probe_budget = Map::new();
    live_probe_budget.insert("cachedOnly".into(), Value::from(options.cached_only));
    live_probe_budget.insert(
        "maxAccounts".into(),
        options
            .max_accounts
            .map(|value| Value::from(value as i64))
            .unwrap_or(Value::Null),
    );
    live_probe_budget.insert(
        "maxProbes".into(),
        options
            .max_probes
            .map(|value| Value::from(value as i64))
            .unwrap_or(Value::Null),
    );
    live_probe_budget.insert(
        "consideredAccounts".into(),
        Value::from(considered_live_accounts as i64),
    );
    live_probe_budget.insert(
        "executedProbes".into(),
        Value::from(executed_live_probes as i64),
    );
    report.insert("liveProbeBudget".into(), Value::Object(live_probe_budget));
    let mut accounts_obj = Map::new();
    accounts_obj.insert("total".into(), Value::from(account_count as i64));
    accounts_obj.insert("enabled".into(), Value::from(enabled_count as i64));
    accounts_obj.insert("disabled".into(), Value::from(disabled_count as i64));
    accounts_obj.insert("coolingDown".into(), Value::from(cooling_count as i64));
    accounts_obj.insert("rateLimited".into(), Value::from(rate_limited_count as i64));
    report.insert("accounts".into(), Value::Object(accounts_obj));
    report.insert(
        "activeIndex".into(),
        if account_count > 0 {
            Value::from((active_index + 1) as i64)
        } else {
            Value::Null
        },
    );
    let mut forecast_obj = Map::new();
    forecast_obj.insert(
        "summary".into(),
        serde_json::to_value(forecast_summary).unwrap_or(Value::Null),
    );
    let mut recommendation_obj = serde_json::to_value(&recommendation)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    recommendation_obj.insert(
        "selectedReason".into(),
        match recommendation.recommended_index {
            Some(recommended_index) => forecast_results
                .get(recommended_index)
                .and_then(|result| result.reasons.first().cloned())
                .map(Value::from)
                .unwrap_or_else(|| Value::from(recommendation.reason.clone())),
            None => Value::from(recommendation.reason.clone()),
        },
    );
    forecast_obj.insert("recommendation".into(), Value::Object(recommendation_obj));
    forecast_obj.insert(
        "probeErrors".into(),
        Value::Array(probe_errors.iter().cloned().map(Value::from).collect()),
    );
    let mut forecast_account_rows = serialize_forecast_results(
        &forecast_results,
        &live_quota_by_index,
        &refresh_failures,
        &|snapshot: &CodexQuotaSnapshot| format_quota_snapshot_line(snapshot),
    );
    // Flip `selected` on the recommended row (array position == account
    // index because inputs are built in index order).
    if let Some(recommended_index) = recommendation.recommended_index
        && let Some(Value::Object(selected_row)) = forecast_account_rows.get_mut(recommended_index)
    {
        selected_row.insert("selected".into(), Value::from(true));
    }
    forecast_obj.insert("accounts".into(), Value::Array(forecast_account_rows));
    report.insert("forecast".into(), Value::Object(forecast_obj));
    report.insert(
        "runtimeOverlay".into(),
        Value::from(runtime_snapshot.is_some()),
    );
    if runtime_key_present {
        report.insert(
            "runtime".into(),
            runtime_snapshot
                .as_ref()
                .map(|snapshot| serde_json::to_value(snapshot).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
        );
    }
    report.insert(
        "runtimeSnapshotLoadError".into(),
        runtime_snapshot_load_error
            .clone()
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    let report_value = Value::Object(report);

    let cwd = deps
        .get_cwd
        .as_ref()
        .map(|get_cwd| get_cwd())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let resolved_out_path = options
        .out_path
        .as_ref()
        .map(|out_path| resolve_against(&cwd, out_path));
    if let Some(output_path) = &resolved_out_path {
        let contents = format!("{}\n", stringify_pretty2(&report_value));
        let written = match &deps.write_file {
            Some(write_file) => write_file(output_path.clone(), contents).await,
            None => default_write_file(output_path, &contents).await,
        };
        if let Err(error) = written {
            // TS lets the write rejection propagate; the Rust surface
            // reports it and exits 1.
            out.error(error.to_string());
            return 1;
        }
    }

    if options.json {
        out.info(stringify_pretty2(&report_value));
        return 0;
    }

    out.info(format!("Report generated at {generated_at}"));
    out.info(format!("Storage: {storage_path}"));
    if let Some(storage_health) = &storage_health {
        out.info(format!("Storage health: {}", storage_health.state.as_str()));
    }
    out.info(format!(
        "Model: {}",
        format_model_inspection(&model_inspection)
    ));
    if options.live {
        let mut budget_parts = vec![
            format!("considered {considered_live_accounts} account(s)"),
            format!("executed {executed_live_probes} probe(s)"),
        ];
        if let Some(max_accounts) = options.max_accounts {
            budget_parts.push(format!("max-accounts {max_accounts}"));
        }
        if let Some(max_probes) = options.max_probes {
            budget_parts.push(format!("max-probes {max_probes}"));
        }
        if options.cached_only {
            budget_parts.push("cached-only".to_string());
        }
        out.info(format!("Live probe budget: {}", budget_parts.join(", ")));
    }
    out.info(format!(
        "Accounts: {account_count} total ({enabled_count} enabled, {disabled_count} disabled, {cooling_count} cooling, {rate_limited_count} rate-limited)"
    ));
    if account_count > 0 {
        out.info(format!("Active account: {}", active_index + 1));
    }
    out.info(format!(
        "Forecast: {} ready, {} delayed, {} unavailable",
        forecast_summary.ready, forecast_summary.delayed, forecast_summary.unavailable
    ));
    match recommendation.recommended_index {
        Some(recommended_index) => {
            out.info(format!(
                "Recommendation: account {} ({})",
                recommended_index + 1,
                recommendation.reason
            ));
        }
        None => {
            out.info(format!("Recommendation: {}", recommendation.reason));
        }
    }
    if let Some(output_path) = &resolved_out_path {
        out.info(format!("Report written: {}", output_path.display()));
    }
    if !probe_errors.is_empty() {
        out.info(format!("Probe notes: {}", probe_errors.len()));
    }
    if let Some(snapshot) = &runtime_snapshot {
        out.info(format!(
            "Runtime traffic: responses={}, refresh={}, probes={}",
            snapshot.responses_requests,
            snapshot.auth_refresh_requests,
            snapshot.diagnostic_probe_requests
        ));
    }
    if options.explain {
        out.info("");
        for result in &forecast_results {
            out.info(format!(
                "Account {}: {}, {} risk ({})",
                result.index + 1,
                result.availability.as_str(),
                result.risk_level.as_str(),
                result.risk_score
            ));
            if !result.reasons.is_empty() {
                out.info(format!("  Reasons: {}", result.reasons.join("; ")));
            }
            if let Some(refresh_failure) = refresh_failures.get(&result.index)
                && let Some(message) = &refresh_failure.message
            {
                out.info(format!("  Refresh failure: {message}"));
            }
            if let Some(live_quota) = live_quota_by_index.get(&result.index) {
                out.info(format!(
                    "  Live quota: {}",
                    format_quota_snapshot_line(live_quota)
                ));
            }
        }
    }
    0
}

/// Node `path.resolve(cwd, value)` (absolute value wins), including Node's
/// lexical normalization: `.`/`..` segments collapse and separators become
/// the platform's, so the `Report written:` echo matches TS byte-for-byte
/// (`--out C:/x/./report.json` echoes `C:\x\report.json` on Windows). No
/// filesystem access. Mirrors `cma_storage`'s `node_resolve` component walk.
fn resolve_against(cwd: &Path, value: &str) -> PathBuf {
    use std::path::Component;
    let candidate = Path::new(value);
    let joined: PathBuf = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else if cfg!(windows) && candidate.has_root() {
        // win32 `\foo` resolves onto the cwd's drive.
        let mut prefixed = PathBuf::new();
        if let Some(Component::Prefix(prefix)) = cwd.components().next() {
            prefixed.push(prefix.as_os_str());
        }
        prefixed.push(candidate);
        prefixed
    } else {
        cwd.join(candidate)
    };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(std::path::MAIN_SEPARATOR_STR),
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    normalized.components().next_back(),
                    None | Some(Component::Prefix(_)) | Some(Component::RootDir)
                ) {
                    normalized.pop();
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

// ============================================================================
// Tests — ported from test/codex-manager-report-command.test.ts (core
// assertions)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_core::schemas::token::TokenSuccess;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// Node `path.resolve` parity for the `Report written:` echo: separators
    /// normalize to the platform's and `.`/`..` segments collapse.
    #[cfg(windows)]
    #[test]
    fn resolve_against_normalizes_like_node_path_resolve_on_windows() {
        let cwd = Path::new(r"C:\work");
        assert_eq!(
            resolve_against(cwd, "C:/x/./report.json"),
            PathBuf::from(r"C:\x\report.json")
        );
        assert_eq!(
            resolve_against(cwd, "C:/x/sub/../report.json"),
            PathBuf::from(r"C:\x\report.json")
        );
        assert_eq!(
            resolve_against(cwd, "out/report.json"),
            PathBuf::from(r"C:\work\out\report.json")
        );
        // Drive-relative `\foo` resolves onto the cwd's drive.
        assert_eq!(
            resolve_against(cwd, r"\x\report.json"),
            PathBuf::from(r"C:\x\report.json")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_against_collapses_dot_segments_like_node_path_resolve() {
        let cwd = Path::new("/work");
        assert_eq!(
            resolve_against(cwd, "/x/./report.json"),
            PathBuf::from("/x/report.json")
        );
        assert_eq!(
            resolve_against(cwd, "out/../report.json"),
            PathBuf::from("/work/report.json")
        );
    }

    fn account(refresh: &str, email: Option<&str>, usable: bool) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh, 1, 1);
        account.email = email.map(str::to_string);
        account.account_id = Some(format!("acct-{refresh}"));
        if usable {
            account.access_token = Some(format!("access-{refresh}"));
            account.expires_at = Some(1_000_000 + 10 * 60 * 1000);
        }
        account
    }

    fn snapshot() -> CodexQuotaSnapshot {
        CodexQuotaSnapshot {
            status: 200,
            plan_type: Some("plus".to_string()),
            active_limit: None,
            primary: Default::default(),
            secondary: Default::default(),
            model: "gpt-5.5".to_string(),
        }
    }

    fn deps_with_storage(storage: AccountStorageV3) -> ReportCommandDeps {
        ReportCommandDeps {
            set_storage_path: Box::new(|_| {}),
            get_storage_path: Box::new(|| "/tmp/accounts.json".to_string()),
            load_accounts: Box::new(move || {
                let storage = storage.clone();
                Box::pin(async move { Some(storage) })
            }),
            save_accounts: Box::new(|_| Box::pin(async { Ok(()) })),
            queued_refresh: Box::new(|_| {
                Box::pin(async {
                    TokenResult::Success(TokenSuccess {
                        access: "refreshed-access".to_string(),
                        refresh: "refreshed-refresh".to_string(),
                        expires: 99_999_999,
                        id_token: None,
                        multi_account: None,
                    })
                })
            }),
            fetch_codex_quota_snapshot: Box::new(|_| Box::pin(async { Ok(snapshot()) })),
            inspect_storage_health: None,
            load_runtime_observability_snapshot: Some(Box::new(|| Box::pin(async { Ok(None) }))),
            load_quota_cache: Some(Box::new(|| Box::pin(async { QuotaCacheData::default() }))),
            get_now: Some(Box::new(|| 1_000_000)),
            get_cwd: Some(Box::new(|| PathBuf::from("/tmp"))),
            write_file: Some(Box::new(|_, _| Box::pin(async { Ok(()) }))),
        }
    }

    #[test]
    fn parse_rejects_invalid_budget_values_and_missing_model() {
        assert_eq!(
            parse_report_args(&args(&["--max-accounts", "1.5"])),
            Err("--max-accounts must be a positive integer".to_string())
        );
        assert_eq!(
            parse_report_args(&args(&["--max-accounts", "0"])),
            Err("--max-accounts must be a positive integer".to_string())
        );
        assert_eq!(
            parse_report_args(&args(&["--max-probes=2abc"])),
            Err("--max-probes must be a positive integer".to_string())
        );
        assert_eq!(
            parse_report_args(&args(&["--model"])),
            Err("Missing value for --model".to_string())
        );
        assert_eq!(
            parse_report_args(&args(&["--out"])),
            Err("Missing value for --out".to_string())
        );
        assert_eq!(
            parse_report_args(&args(&["--bogus"])),
            Err("Unknown option: --bogus".to_string())
        );
        let options = parse_report_args(&args(&[
            "--live",
            "--json",
            "--explain",
            "--cached-only",
            "--max-accounts=2",
            "--max-probes",
            "3",
            "--model=gpt-5.5",
            "--out=report.json",
        ]))
        .unwrap();
        assert!(options.live && options.json && options.explain && options.cached_only);
        assert_eq!(options.max_accounts, Some(2));
        assert_eq!(options.max_probes, Some(3));
        assert_eq!(options.model, "gpt-5.5");
        assert_eq!(options.out_path.as_deref(), Some("report.json"));
    }

    #[tokio::test]
    async fn report_json_shape_and_selected_flag() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", Some("a@x.com"), true));
        let deps = deps_with_storage(storage);
        let mut out = CliOut::capture();
        let code = run_report_command_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        let keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "command",
                "generatedAt",
                "storagePath",
                "model",
                "modelSelection",
                "liveProbe",
                "liveProbeBudget",
                "accounts",
                "activeIndex",
                "forecast",
                "runtimeOverlay",
                "runtime",
                "runtimeSnapshotLoadError"
            ]
        );
        assert_eq!(payload["generatedAt"], Value::from("1970-01-01T00:16:40.000Z"));
        assert_eq!(payload["model"], Value::from(DEFAULT_PROBE_MODEL));
        assert_eq!(payload["activeIndex"], Value::from(1));
        assert_eq!(payload["runtimeOverlay"], Value::from(false));
        assert_eq!(payload["runtime"], Value::Null);
        assert_eq!(payload["runtimeSnapshotLoadError"], Value::Null);
        // The recommended row is flipped to selected: true.
        let accounts = payload["forecast"]["accounts"].as_array().unwrap();
        let recommended = payload["forecast"]["recommendation"]["recommendedIndex"]
            .as_u64()
            .expect("recommended index") as usize;
        assert_eq!(accounts[recommended]["selected"], Value::from(true));
        assert!(
            payload["forecast"]["recommendation"]
                .get("selectedReason")
                .is_some()
        );
    }

    // Account budget: checked at the TOP of each iteration; the budget note
    // lands in probeErrors and stops the loop.
    #[tokio::test]
    async fn live_account_budget_stops_probing() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", Some("a@x.com"), true));
        storage.accounts.push(account("rt-b", Some("b@x.com"), true));
        let probes = Arc::new(AtomicUsize::new(0));
        let probes_clone = Arc::clone(&probes);
        let mut deps = deps_with_storage(storage);
        deps.fetch_codex_quota_snapshot = Box::new(move |_| {
            probes_clone.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(snapshot()) })
        });
        let mut out = CliOut::capture();
        let code = run_report_command_with(
            &args(&["--json", "--live", "--max-accounts", "1"]),
            &deps,
            &mut out,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(probes.load(Ordering::SeqCst), 1);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(
            payload["liveProbeBudget"]["consideredAccounts"],
            Value::from(1)
        );
        assert_eq!(payload["liveProbeBudget"]["executedProbes"], Value::from(1));
        let probe_errors = payload["forecast"]["probeErrors"].as_array().unwrap();
        assert!(probe_errors.contains(&Value::from("live probe account budget reached (1)")));
    }

    // --cached-only skips refreshes for unusable tokens with the frozen note.
    #[tokio::test]
    async fn cached_only_skips_refresh() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", Some("a@x.com"), false));
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshes_clone = Arc::clone(&refreshes);
        let mut deps = deps_with_storage(storage);
        deps.queued_refresh = Box::new(move |_| {
            refreshes_clone.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                TokenResult::Failed(TokenFailure::default())
            })
        });
        let mut out = CliOut::capture();
        let code = run_report_command_with(
            &args(&["--json", "--live", "--cached-only"]),
            &deps,
            &mut out,
        )
        .await;
        assert_eq!(code, 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        let probe_errors = payload["forecast"]["probeErrors"].as_array().unwrap();
        assert_eq!(payload["liveProbeBudget"]["cachedOnly"], Value::from(true));
        assert!(
            probe_errors
                .iter()
                .any(|error| error.as_str().unwrap().ends_with(
                    ": skipped refresh because --cached-only is enabled"
                ))
        );
    }

    // Report persists FIRST: when the persist fails the in-memory account is
    // NOT patched and the probe is skipped with a probe error.
    #[tokio::test]
    async fn persist_failure_skips_in_memory_apply_and_probe() {
        let mut storage = AccountStorageV3::empty();
        let mut unusable = account("rt-a", Some("a@x.com"), false);
        unusable.account_id = None;
        storage.accounts.push(unusable);
        let probes = Arc::new(AtomicUsize::new(0));
        let probes_clone = Arc::clone(&probes);
        let mut deps = deps_with_storage(storage);
        deps.save_accounts = Box::new(|_| {
            Box::pin(async { Err(CodexError::new("save exploded")) })
        });
        deps.fetch_codex_quota_snapshot = Box::new(move |_| {
            probes_clone.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(snapshot()) })
        });
        let mut out = CliOut::capture();
        let code =
            run_report_command_with(&args(&["--json", "--live"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        // Persist failed → probe never ran for that account.
        assert_eq!(probes.load(Ordering::SeqCst), 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        let probe_errors = payload["forecast"]["probeErrors"].as_array().unwrap();
        assert_eq!(probe_errors.len(), 1);
        assert!(probe_errors[0].as_str().unwrap().contains("save exploded"));
        // No liveQuota / refreshFailure on the serialized row.
        let row = &payload["forecast"]["accounts"][0];
        assert!(row.get("liveQuota").is_none());
        assert!(row.get("refreshFailure").is_none());
    }

    // --out writes the pretty report + trailing newline atomically (real
    // writer) in text mode, and prints the confirmation line.
    #[tokio::test]
    async fn out_flag_writes_report_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", Some("a@x.com"), true));
        let mut deps = deps_with_storage(storage);
        let cwd = dir.path().to_path_buf();
        deps.get_cwd = Some(Box::new(move || cwd.clone()));
        deps.write_file = None; // real atomic writer
        let mut out = CliOut::capture();
        let code = run_report_command_with(
            &args(&["--out", "nested/report.json"]),
            &deps,
            &mut out,
        )
        .await;
        assert_eq!(code, 0);
        let written =
            std::fs::read_to_string(dir.path().join("nested").join("report.json")).expect("read");
        assert!(written.ends_with("\n"));
        let payload: Value = serde_json::from_str(&written).expect("json");
        assert_eq!(payload["command"], Value::from("report"));
        assert!(out.info_text().contains("Report written: "));
    }

    // Text mode prints the frozen lines in order.
    #[tokio::test]
    async fn text_mode_prints_report_lines() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", Some("a@x.com"), true));
        let deps = deps_with_storage(storage);
        let mut out = CliOut::capture();
        let code = run_report_command_with(&args(&["--explain"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "Report generated at 1970-01-01T00:16:40.000Z");
        assert_eq!(lines[1], "Storage: /tmp/accounts.json");
        assert!(lines[2].starts_with("Model: "));
        assert!(lines[3].starts_with("Accounts: 1 total (1 enabled, 0 disabled"));
        assert_eq!(lines[4], "Active account: 1");
        assert!(lines[5].starts_with("Forecast: "));
        assert!(lines[6].starts_with("Recommendation: "));
        assert!(text.contains("Account 1: "));
    }
}
