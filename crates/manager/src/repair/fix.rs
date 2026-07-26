//! Port of `lib/codex-manager/repair-commands.ts` — the `fix` command half,
//! plus the repair plumbing shared with `doctor` / `verify-flagged`
//! (`RepairDeps`, `createEmptyAccountStorage`, `normalizeDoctorIndexes`,
//! placeholder/refresh-token helpers).
//!
//! Behavior source: spec 09 §3.1/§3.2/§3.4. CRITICAL contracts:
//! - `fix` NEVER deletes accounts — hard refresh failures only disable;
//! - all-disabled lockout guard re-enables one account and rewrites its
//!   report to a soft warning with the frozen suffix;
//! - persistence rebases onto fresh disk state: probe/refresh happens
//!   OUTSIDE the storage lock, then each mutated account is RE-LOCATED BY
//!   IDENTITY inside `with_account_storage_transaction` before overwriting
//!   the 7 tracked fields;
//! - quota-cache save failures are partial success (`quotaCacheSaveError`),
//!   never fatal.
//!
//! The TS `RepairCommandDeps` styling/format members are absorbed as direct
//! imports (ARCHITECTURE §4 item 10); the injectable seams kept here are the
//! I/O ones the ported tests exercise (refresh, probe, loaders, mirrors).

use std::collections::HashMap;

use cma_cli_mirror::state::CodexCliState;
use cma_cli_mirror::writer::ActiveSelection;
use cma_core::errors::CodexError;
use cma_core::json_io::stringify_pretty2;
use cma_core::model_family::{DEFAULT_PROBE_MODEL, MODEL_FAMILIES, ModelFamily};
use cma_core::schemas::account_storage::{
    AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily,
};
use cma_core::schemas::flagged::FlaggedAccountStorageV1;
use cma_core::schemas::token::{TokenFailure, TokenResult};
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_quota::cache::QuotaCacheData;
use cma_quota::forecast::{
    ForecastAccountInput, evaluate_forecast_accounts, is_hard_refresh_failure,
    recommend_forecast_account,
};
use cma_quota::probe::{
    CODEX_UNAVAILABLE_PROBE_NOTE, CodexQuotaSnapshot, ProbeCodexQuotaOptions,
    fetch_codex_quota_snapshot,
};
use cma_quota::readiness::build_quota_email_fallback_state;
use cma_request::model_map::resolve_normalized_model;
use cma_runtime::observability::RuntimeObservabilitySnapshot;
use cma_storage::matching::{AccountMatchOptions, find_matching_account_index};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{BoxFuture, LoadAccountsFn, default_load_accounts};
use crate::formatters::account::style_account_detail_text_with_tone;
use crate::formatters::quota::{CompactQuotaFormatOptions, format_compact_quota_snapshot};
use crate::formatters::text_style::{
    PromptTone, ResultSegment, format_result_summary, normalize_failure_detail, style_prompt_text,
};

// ============================================================================
// Shared repair plumbing (TS repair-commands.ts privates used by all three
// commands; doctor.rs / verify_flagged.rs import from here)
// ============================================================================

/// Input to the injectable quota probe seam (the TS
/// `fetchCodexQuotaSnapshot({ accountId, accessToken, model })` call shape).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuotaProbeRequest {
    pub account_id: String,
    pub access_token: String,
    pub model: String,
}

/// Injectable I/O bundle shared by `fix` / `doctor` / `verify-flagged`
/// (Rust spelling of the TS module imports the tests mock; the styling
/// members of the TS `RepairCommandDeps` are direct imports instead).
pub struct RepairDeps {
    pub load_accounts: LoadAccountsFn,
    pub load_flagged_accounts: Box<dyn Fn() -> BoxFuture<FlaggedAccountStorageV1> + Send + Sync>,
    pub queued_refresh: Box<dyn Fn(String) -> BoxFuture<TokenResult> + Send + Sync>,
    pub fetch_codex_quota_snapshot: Box<
        dyn Fn(QuotaProbeRequest) -> BoxFuture<Result<CodexQuotaSnapshot, CodexError>>
            + Send
            + Sync,
    >,
    pub load_quota_cache: Box<dyn Fn() -> BoxFuture<QuotaCacheData> + Send + Sync>,
    pub save_quota_cache:
        Box<dyn Fn(QuotaCacheData) -> BoxFuture<Result<(), CodexError>> + Send + Sync>,
    pub load_codex_cli_state: Box<dyn Fn(bool) -> BoxFuture<Option<CodexCliState>> + Send + Sync>,
    pub set_codex_cli_active_selection:
        Box<dyn Fn(ActiveSelection) -> BoxFuture<bool> + Send + Sync>,
    pub load_runtime_observability_snapshot:
        Box<dyn Fn() -> BoxFuture<Option<RuntimeObservabilitySnapshot>> + Send + Sync>,
    pub get_now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
}

impl Default for RepairDeps {
    fn default() -> Self {
        RepairDeps {
            load_accounts: default_load_accounts(),
            load_flagged_accounts: Box::new(|| {
                Box::pin(cma_storage::flagged::load_flagged_accounts())
            }),
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
            load_quota_cache: Box::new(|| Box::pin(cma_quota::cache::load_quota_cache())),
            save_quota_cache: Box::new(|cache| {
                Box::pin(async move {
                    cma_quota::cache::save_quota_cache(&cache).await;
                    Ok(())
                })
            }),
            load_codex_cli_state: Box::new(|force_refresh| {
                Box::pin(cma_cli_mirror::state::load_codex_cli_state(force_refresh))
            }),
            set_codex_cli_active_selection: Box::new(|selection| {
                Box::pin(async move {
                    cma_cli_mirror::writer::set_codex_cli_active_selection(&selection).await
                })
            }),
            load_runtime_observability_snapshot: Box::new(|| {
                Box::pin(async {
                    cma_runtime::observability::load_persisted_runtime_observability_snapshot()
                })
            }),
            get_now: None,
        }
    }
}

impl RepairDeps {
    pub(crate) fn now(&self) -> i64 {
        match &self.get_now {
            Some(get_now) => get_now(),
            None => cma_core::utils::now_ms(),
        }
    }
}

/// TS `createEmptyAccountStorage()` — `{version: 3, accounts: [],
/// activeIndex: 0, activeIndexByFamily: {every family: 0}}`.
pub fn create_empty_account_storage() -> AccountStorageV3 {
    let mut by_family = ActiveIndexByFamily::default();
    for family in MODEL_FAMILIES {
        by_family.set(family, Some(0));
    }
    let mut storage = AccountStorageV3::empty();
    storage.active_index_by_family = Some(by_family);
    storage
}

/// TS `normalizeDoctorIndexes(storage)` — clamp `activeIndex` to
/// `[0, total-1]` (0 when empty); ensure `activeIndexByFamily` exists; clamp
/// every family slot (missing/non-finite → activeIndex fallback).
pub fn normalize_doctor_indexes(storage: &mut AccountStorageV3) -> bool {
    let total = storage.accounts.len() as i64;
    let next_active = if total == 0 {
        0
    } else {
        storage.active_index.clamp(0, total - 1)
    };
    let mut changed = false;
    if storage.active_index != next_active {
        storage.active_index = next_active;
        changed = true;
    }
    if storage.active_index_by_family.is_none() {
        storage.active_index_by_family = Some(ActiveIndexByFamily::default());
    }
    let active_index = storage.active_index;
    if let Some(by_family) = &mut storage.active_index_by_family {
        for family in MODEL_FAMILIES {
            let raw = by_family.get(family);
            let candidate = raw.unwrap_or(active_index);
            let clamped = if total == 0 {
                0
            } else {
                candidate.clamp(0, total - 1)
            };
            if by_family.get(family) != Some(clamped) {
                by_family.set(family, Some(clamped));
                changed = true;
            }
        }
    }
    changed
}

/// TS `getDoctorRefreshTokenKey(refreshToken)` — trimmed, non-empty.
pub fn get_doctor_refresh_token_key(refresh_token: &str) -> Option<String> {
    let trimmed = refresh_token.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS `hasPlaceholderEmail(value)` — trimmed, lowercased, ends with
/// `@example.com`.
pub fn has_placeholder_email(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let email = value.trim().to_lowercase();
    if email.is_empty() {
        return false;
    }
    email.ends_with("@example.com")
}

/// TS `error instanceof Error ? error.message : String(error)` over the
/// crate error type.
pub(crate) fn codex_error_message(error: &CodexError) -> String {
    error.message().to_string()
}

// ============================================================================
// Arg parsing
// ============================================================================

/// TS `FixCliOptions`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixCliOptions {
    pub dry_run: bool,
    pub json: bool,
    pub live: bool,
    pub model: String,
}

impl Default for FixCliOptions {
    fn default() -> Self {
        FixCliOptions {
            dry_run: false,
            json: false,
            live: false,
            model: DEFAULT_PROBE_MODEL.to_string(),
        }
    }
}

fn print_fix_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:".to_string(),
            "  codex-multi-auth fix [--dry-run] [--json] [--live] [--model <model>]".to_string(),
            String::new(),
            "Options:".to_string(),
            "  --dry-run, -n      Preview changes without writing storage".to_string(),
            "  --json, -j         Print machine-readable JSON output".to_string(),
            "  --live, -l         Run live session probe before deciding health".to_string(),
            format!(
                "  --model, -m        Probe model for live mode (default: {DEFAULT_PROBE_MODEL})"
            ),
            String::new(),
            "Behavior:".to_string(),
            "  - Refreshes tokens for enabled accounts".to_string(),
            "  - Disables hard-failed accounts (never deletes)".to_string(),
            "  - Recommends a better current account when needed".to_string(),
        ]
        .join("\n"),
    );
}

/// TS `parseFixArgs(args)` (exported).
pub fn parse_fix_args(args: &[String]) -> Result<FixCliOptions, String> {
    let mut options = FixCliOptions::default();

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--dry-run" | "-n" => {
                options.dry_run = true;
                i += 1;
                continue;
            }
            "--json" | "-j" => {
                options.json = true;
                i += 1;
                continue;
            }
            "--live" | "-l" => {
                options.live = true;
                i += 1;
                continue;
            }
            "--model" | "-m" => {
                let value = args.get(i + 1).map(|v| v.trim().to_string());
                match value {
                    Some(v) if !v.is_empty() && !v.starts_with('-') => {
                        options.model = v;
                        i += 2;
                        continue;
                    }
                    _ => return Err("Missing value for --model".to_string()),
                }
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
        return Err(format!("Unknown option: {arg}"));
    }

    Ok(options)
}

// ============================================================================
// Reports / mutation plumbing
// ============================================================================

/// TS `FixOutcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FixOutcome {
    Healthy,
    DisabledHardFailure,
    WarningSoftFailure,
    AlreadyDisabled,
}

impl FixOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            FixOutcome::Healthy => "healthy",
            FixOutcome::DisabledHardFailure => "disabled-hard-failure",
            FixOutcome::WarningSoftFailure => "warning-soft-failure",
            FixOutcome::AlreadyDisabled => "already-disabled",
        }
    }
}

/// TS `FixAccountReport`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixAccountReport {
    pub index: usize,
    pub label: String,
    pub outcome: FixOutcome,
    pub message: String,
}

fn report_to_value(report: &FixAccountReport) -> Value {
    let mut row = Map::new();
    row.insert("index".into(), Value::from(report.index as i64));
    row.insert("label".into(), Value::from(report.label.clone()));
    row.insert("outcome".into(), Value::from(report.outcome.as_str()));
    row.insert("message".into(), Value::from(report.message.clone()));
    Value::Object(row)
}

struct FixSummary {
    healthy: usize,
    disabled: usize,
    warnings: usize,
    skipped: usize,
}

fn summarize_fix_reports(reports: &[FixAccountReport]) -> FixSummary {
    let mut summary = FixSummary {
        healthy: 0,
        disabled: 0,
        warnings: 0,
        skipped: 0,
    };
    for report in reports {
        match report.outcome {
            FixOutcome::Healthy => summary.healthy += 1,
            FixOutcome::DisabledHardFailure => summary.disabled += 1,
            FixOutcome::WarningSoftFailure => summary.warnings += 1,
            FixOutcome::AlreadyDisabled => summary.skipped += 1,
        }
    }
    summary
}

struct AccountStorageMutation {
    before: AccountMetadataV3,
    after: AccountMetadataV3,
}

fn has_account_storage_mutation(before: &AccountMetadataV3, after: &AccountMetadataV3) -> bool {
    before.refresh_token != after.refresh_token
        || before.access_token != after.access_token
        || before.expires_at != after.expires_at
        || before.email != after.email
        || before.account_id != after.account_id
        || before.account_id_source != after.account_id_source
        || before.enabled != after.enabled
}

fn collect_account_storage_mutations(
    before_accounts: &[AccountMetadataV3],
    after_accounts: &[AccountMetadataV3],
) -> Vec<AccountStorageMutation> {
    let mut mutations = Vec::new();
    for (i, after) in after_accounts.iter().enumerate() {
        let Some(before) = before_accounts.get(i) else {
            continue;
        };
        if !has_account_storage_mutation(before, after) {
            continue;
        }
        mutations.push(AccountStorageMutation {
            before: before.clone(),
            after: after.clone(),
        });
    }
    mutations
}

/// Re-locate each mutated account BY IDENTITY (before, then after) in the
/// transaction-loaded storage and overwrite the 7 tracked fields. Unmatched
/// mutations are dropped (the account disappeared concurrently).
fn apply_account_storage_mutations(
    storage: &mut AccountStorageV3,
    mutations: &[AccountStorageMutation],
) {
    let options = AccountMatchOptions {
        allow_unique_account_id_fallback_without_email: true,
    };
    for mutation in mutations {
        let target_index = find_matching_account_index(&storage.accounts, &mutation.before, options)
            .or_else(|| find_matching_account_index(&storage.accounts, &mutation.after, options));
        let Some(target_index) = target_index else {
            continue;
        };
        let Some(target) = storage.accounts.get_mut(target_index) else {
            continue;
        };
        target.refresh_token = mutation.after.refresh_token.clone();
        target.access_token = mutation.after.access_token.clone();
        target.expires_at = mutation.after.expires_at;
        target.email = mutation.after.email.clone();
        target.account_id = mutation.after.account_id.clone();
        target.account_id_source = mutation.after.account_id_source;
        target.enabled = mutation.after.enabled;
    }
}

pub(crate) fn account_label(account: &AccountMetadataV3, index: usize) -> String {
    cma_accounts::manager_persistence::format_account_label(
        Some(account as &dyn cma_accounts::manager_persistence::AccountLabelSource),
        index,
    )
}

// ============================================================================
// runFix
// ============================================================================

/// Production entry (dispatcher wiring).
pub async fn run_fix(args: &[String], out: &mut CliOut) -> i32 {
    run_fix_with(args, &RepairDeps::default(), out).await
}

/// TS `runFix(args, deps)`.
pub async fn run_fix_with(args: &[String], deps: &RepairDeps, out: &mut CliOut) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_fix_usage(out);
        return 0;
    }

    let options = match parse_fix_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            print_fix_usage(out);
            return 1;
        }
    };
    let trimmed_model = options.model.trim();
    let probe_model = resolve_normalized_model(Some(if trimmed_model.is_empty() {
        DEFAULT_PROBE_MODEL
    } else {
        trimmed_model
    }));
    // Deliberate: fix output is full detail — the DEFAULT display settings,
    // NOT the user's saved dashboard settings.
    let display = cma_config::dashboard_settings::default_dashboard_display_settings();
    let mut working_quota_cache: Option<QuotaCacheData> = if options.live {
        Some((deps.load_quota_cache)().await)
    } else {
        None
    };
    let mut quota_cache_changed = false;

    cma_storage::facade::set_storage_path(None);
    let mut storage: AccountStorageV3 = match (deps.load_accounts)().await {
        Some(storage) if !storage.accounts.is_empty() => storage,
        _ => {
            if options.json {
                let mut payload = Map::new();
                payload.insert("command".into(), Value::from("fix"));
                payload.insert("dryRun".into(), Value::from(options.dry_run));
                payload.insert("liveProbe".into(), Value::from(options.live));
                payload.insert("model".into(), Value::from(options.model.clone()));
                payload.insert("changed".into(), Value::from(false));
                let mut summary = Map::new();
                summary.insert("healthy".into(), Value::from(0));
                summary.insert("disabled".into(), Value::from(0));
                summary.insert("warnings".into(), Value::from(0));
                summary.insert("skipped".into(), Value::from(0));
                payload.insert("summary".into(), Value::Object(summary));
                let mut recommendation = Map::new();
                recommendation.insert("recommendedIndex".into(), Value::Null);
                recommendation.insert("reason".into(), Value::from("No accounts configured."));
                payload.insert("recommendation".into(), Value::Object(recommendation));
                payload.insert("recommendedSwitchCommand".into(), Value::Null);
                payload.insert("reports".into(), Value::Array(Vec::new()));
                out.info(stringify_pretty2(&Value::Object(payload)));
            } else {
                out.info("No accounts configured.");
            }
            return 0;
        }
    };
    let original_accounts: Vec<AccountMetadataV3> = storage.accounts.clone();
    let mut quota_email_fallback_state = if options.live {
        Some(build_quota_email_fallback_state(&storage.accounts))
    } else {
        None
    };

    let now = deps.now();
    let active_index =
        cma_runtime::account_status::resolve_active_index(&storage, ModelFamily::Codex);
    let mut account_storage_changed = false;
    let mut reports: Vec<FixAccountReport> = Vec::new();
    let mut refresh_failures: HashMap<usize, TokenFailure> = HashMap::new();
    let mut hard_disabled_indexes: Vec<usize> = Vec::new();

    for i in 0..storage.accounts.len() {
        let label = account_label(&storage.accounts[i], i);

        if storage.accounts[i].enabled == Some(false) {
            reports.push(FixAccountReport {
                index: i,
                label,
                outcome: FixOutcome::AlreadyDisabled,
                message: "already disabled".to_string(),
            });
            continue;
        }

        if crate::login::account_credentials::has_usable_access_token(&storage.accounts[i], now) {
            let mut refresh_after_live_probe_failure = false;
            if options.live {
                let current_access_token = storage.accounts[i].access_token.clone();
                let probe_account_id = current_access_token.as_ref().and_then(|token| {
                    storage.accounts[i]
                        .account_id
                        .clone()
                        .or_else(|| extract_account_id(Some(token)))
                });
                if let (Some(probe_account_id), Some(current_access_token)) =
                    (probe_account_id, current_access_token)
                {
                    match (deps.fetch_codex_quota_snapshot)(QuotaProbeRequest {
                        account_id: probe_account_id,
                        access_token: current_access_token,
                        model: probe_model.to_string(),
                    })
                    .await
                    {
                        Ok(snapshot) => {
                            if let Some(working) = &mut working_quota_cache {
                                quota_cache_changed =
                                    crate::quota_cache_helpers::update_quota_cache_for_account(
                                        working,
                                        &storage.accounts[i],
                                        &snapshot,
                                        &storage.accounts,
                                        quota_email_fallback_state.as_ref(),
                                    ) || quota_cache_changed;
                            }
                            reports.push(FixAccountReport {
                                index: i,
                                label,
                                outcome: FixOutcome::Healthy,
                                message: if display.show_quota_details {
                                    format!(
                                        "live session OK ({})",
                                        format_compact_quota_snapshot(
                                            &snapshot,
                                            cma_core::utils::now_ms(),
                                            &CompactQuotaFormatOptions::default(),
                                        )
                                    )
                                } else {
                                    "live session OK".to_string()
                                },
                            });
                            continue;
                        }
                        Err(_) => {
                            refresh_after_live_probe_failure = true;
                        }
                    }
                }
            }

            if !refresh_after_live_probe_failure {
                let refresh_warning =
                    if crate::login::account_credentials::has_likely_invalid_refresh_token(Some(
                        &storage.accounts[i].refresh_token,
                    )) {
                        " (refresh token looks stale; re-login recommended)"
                    } else {
                        ""
                    };
                reports.push(FixAccountReport {
                    index: i,
                    label,
                    outcome: FixOutcome::Healthy,
                    message: format!("access token still valid{refresh_warning}"),
                });
                continue;
            }
        }

        let refresh_result = (deps.queued_refresh)(storage.accounts[i].refresh_token.clone()).await;
        match refresh_result {
            TokenResult::Success(success) => {
                let next_email = sanitize_email(
                    extract_account_email(Some(&success.access), success.id_token.as_deref())
                        .as_deref(),
                );
                let next_account_id = extract_account_id(Some(&success.access));
                let previous_email = storage.accounts[i].email.clone();
                let mut account_changed = false;
                let mut account_identity_changed = false;

                {
                    let account = &mut storage.accounts[i];
                    if account.refresh_token != success.refresh {
                        account.refresh_token = success.refresh.clone();
                        account_changed = true;
                    }
                    if account.access_token.as_deref() != Some(success.access.as_str()) {
                        account.access_token = Some(success.access.clone());
                        account_changed = true;
                    }
                    if account.expires_at != Some(success.expires) {
                        account.expires_at = Some(success.expires);
                        account_changed = true;
                    }
                    if let Some(next_email_value) = &next_email
                        && account.email.as_deref() != Some(next_email_value.as_str())
                    {
                        account.email = Some(next_email_value.clone());
                        account_changed = true;
                        account_identity_changed = true;
                    }
                    if crate::login::account_credentials::apply_token_account_identity(
                        account,
                        next_account_id.as_deref(),
                    ) {
                        account_changed = true;
                        account_identity_changed = true;
                    }
                }

                if account_changed {
                    account_storage_changed = true;
                }
                if account_identity_changed && options.live {
                    let next_state = build_quota_email_fallback_state(&storage.accounts);
                    if let Some(working) = &mut working_quota_cache {
                        quota_cache_changed =
                            crate::quota_cache_helpers::prune_unsafe_quota_email_cache_entry(
                                working,
                                previous_email.as_deref(),
                                &storage.accounts,
                                &next_state,
                            ) || quota_cache_changed;
                    }
                    quota_email_fallback_state = Some(next_state);
                }
                if options.live {
                    let probe_account_id = storage.accounts[i]
                        .account_id
                        .clone()
                        .or_else(|| next_account_id.clone());
                    if let Some(probe_account_id) = probe_account_id {
                        match (deps.fetch_codex_quota_snapshot)(QuotaProbeRequest {
                            account_id: probe_account_id,
                            access_token: success.access.clone(),
                            model: probe_model.to_string(),
                        })
                        .await
                        {
                            Ok(snapshot) => {
                                if let Some(working) = &mut working_quota_cache {
                                    quota_cache_changed =
                                        crate::quota_cache_helpers::update_quota_cache_for_account(
                                            working,
                                            &storage.accounts[i],
                                            &snapshot,
                                            &storage.accounts,
                                            quota_email_fallback_state.as_ref(),
                                        ) || quota_cache_changed;
                                }
                                reports.push(FixAccountReport {
                                    index: i,
                                    label,
                                    outcome: FixOutcome::Healthy,
                                    message: if display.show_quota_details {
                                        format!(
                                            "refresh + live probe succeeded ({})",
                                            format_compact_quota_snapshot(
                                                &snapshot,
                                                cma_core::utils::now_ms(),
                                                &CompactQuotaFormatOptions::default(),
                                            )
                                        )
                                    } else {
                                        "refresh + live probe succeeded".to_string()
                                    },
                                });
                                continue;
                            }
                            Err(error) => {
                                if error.is_codex_unavailable() {
                                    reports.push(FixAccountReport {
                                        index: i,
                                        label,
                                        outcome: FixOutcome::WarningSoftFailure,
                                        message: format!(
                                            "refresh succeeded ({CODEX_UNAVAILABLE_PROBE_NOTE})"
                                        ),
                                    });
                                    continue;
                                }
                                let message = normalize_failure_detail(
                                    Some(&codex_error_message(&error)),
                                    None,
                                );
                                reports.push(FixAccountReport {
                                    index: i,
                                    label,
                                    outcome: FixOutcome::WarningSoftFailure,
                                    message: format!(
                                        "refresh succeeded but live probe failed: {message}"
                                    ),
                                });
                                continue;
                            }
                        }
                    }
                }
                reports.push(FixAccountReport {
                    index: i,
                    label,
                    outcome: FixOutcome::Healthy,
                    message: "refresh succeeded".to_string(),
                });
            }
            TokenResult::Failed(failure) => {
                let detail = normalize_failure_detail(
                    failure.message.as_deref(),
                    failure.reason.map(|reason| reason.as_str()),
                );
                let mut recorded = failure.clone();
                recorded.message = Some(detail.clone());
                refresh_failures.insert(i, recorded);
                if is_hard_refresh_failure(&failure) {
                    storage.accounts[i].enabled = Some(false);
                    account_storage_changed = true;
                    hard_disabled_indexes.push(i);
                    reports.push(FixAccountReport {
                        index: i,
                        label,
                        outcome: FixOutcome::DisabledHardFailure,
                        message: detail,
                    });
                } else {
                    reports.push(FixAccountReport {
                        index: i,
                        label,
                        outcome: FixOutcome::WarningSoftFailure,
                        message: detail,
                    });
                }
            }
        }
    }

    // All-disabled lockout guard: NEVER leave the pool with zero enabled
    // accounts because of this run's hard-disables.
    if !hard_disabled_indexes.is_empty() {
        let enabled_count = storage
            .accounts
            .iter()
            .filter(|account| account.enabled != Some(false))
            .count();
        if enabled_count == 0 {
            let fallback_index = if hard_disabled_indexes.contains(&active_index) {
                active_index
            } else {
                hard_disabled_indexes[0]
            };
            if let Some(fallback) = storage.accounts.get_mut(fallback_index)
                && fallback.enabled == Some(false)
            {
                fallback.enabled = Some(true);
                account_storage_changed = true;
                if let Some(existing_report) = reports.iter_mut().find(|report| {
                    report.index == fallback_index
                        && report.outcome == FixOutcome::DisabledHardFailure
                }) {
                    existing_report.outcome = FixOutcome::WarningSoftFailure;
                    existing_report.message = format!(
                        "{} (kept enabled to avoid lockout; re-login required)",
                        existing_report.message
                    );
                }
            }
        }
    }

    let forecast_inputs: Vec<ForecastAccountInput<'_>> = storage
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| ForecastAccountInput {
            index,
            account,
            is_current: index == active_index,
            now,
            refresh_failure: refresh_failures.get(&index),
            live_quota: None,
            quota_cache: None,
            all_accounts: None,
            runtime_overlay: None,
        })
        .collect();
    let forecast_results = evaluate_forecast_accounts(&forecast_inputs);
    drop(forecast_inputs);
    let recommendation = recommend_forecast_account(&forecast_results);
    let report_summary = summarize_fix_reports(&reports);
    let account_mutations = collect_account_storage_mutations(&original_accounts, &storage.accounts);

    if account_storage_changed && !options.dry_run {
        let persisted = cma_storage::transactions::with_account_storage_transaction(
            move |loaded_storage, persist| async move {
                let mut next_storage = match loaded_storage {
                    Some(loaded) => loaded.clone(),
                    None => create_empty_account_storage(),
                };
                apply_account_storage_mutations(&mut next_storage, &account_mutations);
                persist.persist(&next_storage).await?;
                Ok(())
            },
        )
        .await;
        if let Err(error) = persisted {
            // TS lets the transaction rejection propagate out of the CLI;
            // the Rust surface reports it and exits 1 instead of panicking.
            out.error(codex_error_message(&error));
            return 1;
        }
    }

    let mut quota_cache_save_error: Option<String> = None;
    if !options.dry_run
        && quota_cache_changed
        && let Some(working) = &working_quota_cache
        && let Err(error) = (deps.save_quota_cache)(working.clone()).await
    {
        // Partial success — account storage was already persisted above.
        quota_cache_save_error = Some(codex_error_message(&error));
    }

    let changed = account_storage_changed;

    if options.json {
        let mut payload = Map::new();
        payload.insert("command".into(), Value::from("fix"));
        payload.insert("dryRun".into(), Value::from(options.dry_run));
        payload.insert("liveProbe".into(), Value::from(options.live));
        payload.insert("model".into(), Value::from(options.model.clone()));
        payload.insert("changed".into(), Value::from(changed));
        payload.insert("quotaCacheChanged".into(), Value::from(quota_cache_changed));
        payload.insert(
            "quotaCacheSaveError".into(),
            quota_cache_save_error
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        let mut summary = Map::new();
        summary.insert("healthy".into(), Value::from(report_summary.healthy as i64));
        summary.insert("disabled".into(), Value::from(report_summary.disabled as i64));
        summary.insert("warnings".into(), Value::from(report_summary.warnings as i64));
        summary.insert("skipped".into(), Value::from(report_summary.skipped as i64));
        payload.insert("summary".into(), Value::Object(summary));
        payload.insert(
            "recommendation".into(),
            serde_json::to_value(&recommendation).unwrap_or(Value::Null),
        );
        payload.insert(
            "recommendedSwitchCommand".into(),
            match recommendation.recommended_index {
                Some(index) if index != active_index => {
                    Value::from(format!("codex-multi-auth switch {}", index + 1))
                }
                _ => Value::Null,
            },
        );
        payload.insert(
            "reports".into(),
            Value::Array(reports.iter().map(report_to_value).collect()),
        );
        out.info(stringify_pretty2(&Value::Object(payload)));
        return 0;
    }

    out.info(style_prompt_text(
        &format!(
            "Auto-fix scan ({})",
            if options.dry_run { "preview" } else { "apply" }
        ),
        PromptTone::Accent,
    ));
    out.info(format_result_summary(&[
        ResultSegment::new(
            format!("{} working", report_summary.healthy),
            PromptTone::Success,
        ),
        ResultSegment::new(
            format!("{} disabled", report_summary.disabled),
            if report_summary.disabled > 0 {
                PromptTone::Danger
            } else {
                PromptTone::Muted
            },
        ),
        ResultSegment::new(
            format!(
                "{} warning{}",
                report_summary.warnings,
                if report_summary.warnings == 1 { "" } else { "s" }
            ),
            if report_summary.warnings > 0 {
                PromptTone::Warning
            } else {
                PromptTone::Muted
            },
        ),
        ResultSegment::new(
            format!("{} already disabled", report_summary.skipped),
            PromptTone::Muted,
        ),
    ]));
    if let Some(save_error) = &quota_cache_save_error {
        out.info(style_prompt_text(
            &format!("Warning: quota cache save failed ({save_error}); account fixes were saved."),
            PromptTone::Warning,
        ));
    }
    if display.show_per_account_rows {
        out.info("");
        for report in &reports {
            let prefix = match report.outcome {
                FixOutcome::Healthy => "✓",
                FixOutcome::DisabledHardFailure => "✗",
                FixOutcome::WarningSoftFailure => "!",
                FixOutcome::AlreadyDisabled => "-",
            };
            let tone = match report.outcome {
                FixOutcome::Healthy => PromptTone::Success,
                FixOutcome::DisabledHardFailure => PromptTone::Danger,
                FixOutcome::WarningSoftFailure => PromptTone::Warning,
                FixOutcome::AlreadyDisabled => PromptTone::Muted,
            };
            out.info(format!(
                "{} {} {} {}",
                style_prompt_text(prefix, tone),
                style_prompt_text(
                    &format!("{}. {}", report.index + 1, report.label),
                    PromptTone::Accent
                ),
                style_prompt_text("|", PromptTone::Muted),
                style_account_detail_text_with_tone(
                    &report.message,
                    if tone == PromptTone::Success {
                        PromptTone::Muted
                    } else {
                        tone
                    }
                ),
            ));
        }
    } else {
        out.info("");
        out.info(style_prompt_text(
            "Per-account lines are hidden in dashboard settings.",
            PromptTone::Muted,
        ));
    }

    if display.show_recommendations {
        out.info("");
        if let Some(index) = recommendation.recommended_index {
            let target = index + 1;
            out.info(format!(
                "{} {}",
                style_prompt_text("Best next account:", PromptTone::Accent),
                style_prompt_text(&target.to_string(), PromptTone::Success)
            ));
            out.info(format!(
                "{} {}",
                style_prompt_text("Why:", PromptTone::Accent),
                style_prompt_text(&recommendation.reason, PromptTone::Muted)
            ));
            if index != active_index {
                out.info(format!(
                    "{} codex-multi-auth switch {target}",
                    style_prompt_text("Switch now with:", PromptTone::Accent)
                ));
            }
        } else {
            out.info(format!(
                "{} {}",
                style_prompt_text("Note:", PromptTone::Accent),
                style_prompt_text(&recommendation.reason, PromptTone::Muted)
            ));
        }
    }

    if account_storage_changed && options.dry_run {
        out.info(format!(
            "\n{}",
            style_prompt_text("Preview only: no changes were saved.", PromptTone::Warning)
        ));
    } else if account_storage_changed {
        out.info(format!(
            "\n{}",
            style_prompt_text("Saved updates.", PromptTone::Success)
        ));
    } else if quota_cache_changed {
        out.info(format!(
            "\n{}",
            style_prompt_text(
                "Quota cache refreshed (no account storage changes).",
                PromptTone::Muted
            )
        ));
    } else {
        out.info(format!(
            "\n{}",
            style_prompt_text("No changes were needed.", PromptTone::Muted)
        ));
    }

    0
}

// ============================================================================
// Tests — ported from test/repair-commands.test.ts (fix half)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::{TokenFailureReason, TokenSuccess};
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn account(refresh: &str, email: Option<&str>) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh, 1, 1);
        account.email = email.map(str::to_string);
        account
    }

    fn deps_with_refresh(
        result: impl Fn(String) -> TokenResult + Send + Sync + 'static,
    ) -> RepairDeps {
        RepairDeps {
            queued_refresh: Box::new(move |token| {
                let result = result(token);
                Box::pin(async move { result })
            }),
            get_now: Some(Box::new(|| 1_000)),
            ..RepairDeps::default()
        }
    }

    fn hard_failure() -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason: Some(TokenFailureReason::HttpError),
            status_code: Some(401),
            message: Some("invalid_grant".to_string()),
        })
    }

    fn soft_failure() -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason: Some(TokenFailureReason::NetworkError),
            status_code: None,
            message: Some("socket hang up".to_string()),
        })
    }

    // parseFixArgs rejects a flag-like value after --model instead of
    // consuming it (test/repair-commands.test.ts).
    #[test]
    fn parse_fix_args_rejects_flag_like_model_value() {
        assert_eq!(
            parse_fix_args(&args(&["--model", "--json"])),
            Err("Missing value for --model".to_string())
        );
        assert_eq!(
            parse_fix_args(&args(&["--model="])),
            Err("Missing value for --model".to_string())
        );
        assert_eq!(
            parse_fix_args(&args(&["--bogus"])),
            Err("Unknown option: --bogus".to_string())
        );
        let options = parse_fix_args(&args(&["-n", "-j", "-l", "-m", "gpt-5.5"])).unwrap();
        assert!(options.dry_run && options.json && options.live);
        assert_eq!(options.model, "gpt-5.5");
    }

    // runFix keeps JSON output consistent for the no-account path — the
    // skeleton has NO quotaCacheChanged/quotaCacheSaveError keys.
    #[tokio::test]
    #[serial(env)]
    async fn fix_json_no_account_skeleton_is_exact() {
        let _sandbox = EnvSandbox::new();
        let deps = RepairDeps::default();
        let mut out = CliOut::capture();
        let code = run_fix_with(&args(&["--json", "--model", "gpt-x"]), &deps, &mut out).await;
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
                "dryRun",
                "liveProbe",
                "model",
                "changed",
                "summary",
                "recommendation",
                "recommendedSwitchCommand",
                "reports"
            ]
        );
        assert_eq!(payload["model"], Value::from("gpt-x"));
        assert_eq!(
            payload["recommendation"]["reason"],
            Value::from("No accounts configured.")
        );
        assert_eq!(payload["recommendedSwitchCommand"], Value::Null);
    }

    // Hard refresh failures disable accounts but NEVER delete them; the
    // all-disabled lockout guard re-enables one with the frozen suffix.
    #[tokio::test]
    #[serial(env)]
    async fn fix_disables_hard_failures_and_lockout_guard_re_enables_one() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", Some("a@x.com")));
        storage.accounts.push(account("rt-b", Some("b@x.com")));
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let deps = deps_with_refresh(|_| hard_failure());
        let mut out = CliOut::capture();
        let code = run_fix_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["changed"], Value::from(true));
        // Account 0 (active) was re-enabled by the lockout guard.
        assert_eq!(
            payload["reports"][0]["outcome"],
            Value::from("warning-soft-failure")
        );
        assert!(
            payload["reports"][0]["message"]
                .as_str()
                .unwrap()
                .ends_with("(kept enabled to avoid lockout; re-login required)")
        );
        assert_eq!(
            payload["reports"][1]["outcome"],
            Value::from("disabled-hard-failure")
        );

        // Fix NEVER deletes: both accounts survive on disk; exactly one is
        // disabled.
        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        assert_eq!(saved.accounts.len(), 2);
        assert_eq!(saved.accounts[0].enabled, Some(true));
        assert_eq!(saved.accounts[1].enabled, Some(false));
    }

    // Soft failures warn without disabling.
    #[tokio::test]
    #[serial(env)]
    async fn fix_soft_failures_keep_accounts_enabled() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", None));
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let deps = deps_with_refresh(|_| soft_failure());
        let mut out = CliOut::capture();
        let code = run_fix_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["changed"], Value::from(false));
        assert_eq!(
            payload["reports"][0]["outcome"],
            Value::from("warning-soft-failure")
        );
        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        assert_eq!(saved.accounts[0].enabled, None);
    }

    // Dry-run never writes storage.
    #[tokio::test]
    #[serial(env)]
    async fn fix_dry_run_does_not_persist() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", None));
        storage.accounts.push(account("rt-b", None));
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let deps = deps_with_refresh(|_| hard_failure());
        let mut out = CliOut::capture();
        let code = run_fix_with(&args(&["--dry-run", "--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["dryRun"], Value::from(true));
        assert_eq!(payload["changed"], Value::from(true));
        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        assert_eq!(saved.accounts[0].enabled, None);
        assert_eq!(saved.accounts[1].enabled, None);
    }

    // runFix re-locates mutated accounts by identity inside the transaction
    // (probe-outside-lock → re-locate-by-identity): a concurrent reorder on
    // disk must not clobber the wrong slot.
    #[tokio::test]
    #[serial(env)]
    async fn fix_relocates_mutations_by_identity_in_transaction() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        // Disk order: [b, a] — the pre-scan sees [a, b] via the injected
        // loader, so index-based application would hit the wrong account.
        let mut disk = AccountStorageV3::empty();
        disk.accounts.push(account("rt-b", Some("b@x.com")));
        disk.accounts.push(account("rt-a", Some("a@x.com")));
        cma_storage::save::save_accounts(&disk)
            .await
            .expect("seed save");

        let mut in_memory = AccountStorageV3::empty();
        in_memory.accounts.push(account("rt-a", Some("a@x.com")));
        in_memory.accounts.push(account("rt-b", Some("b@x.com")));
        let deps = RepairDeps {
            load_accounts: Box::new(move || {
                let storage = in_memory.clone();
                Box::pin(async move { Some(storage) })
            }),
            queued_refresh: Box::new(|token| {
                Box::pin(async move {
                    if token == "rt-a" {
                        hard_failure()
                    } else {
                        TokenResult::Success(TokenSuccess {
                            access: "new-access".to_string(),
                            refresh: "rt-b".to_string(),
                            expires: 99_999_999,
                            id_token: None,
                            multi_account: None,
                        })
                    }
                })
            }),
            get_now: Some(Box::new(|| 1_000)),
            ..RepairDeps::default()
        };
        let mut out = CliOut::capture();
        let code = run_fix_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        // Disk slot 1 holds rt-a — the hard-disable must land THERE.
        assert_eq!(saved.accounts[1].refresh_token, "rt-a");
        assert_eq!(saved.accounts[1].enabled, Some(false));
        assert_eq!(saved.accounts[0].refresh_token, "rt-b");
        assert_eq!(saved.accounts[0].access_token.as_deref(), Some("new-access"));
    }

    #[test]
    fn normalize_doctor_indexes_clamps_and_fills_families() {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt", None));
        storage.active_index = 5;
        assert!(normalize_doctor_indexes(&mut storage));
        assert_eq!(storage.active_index, 0);
        let by_family = storage.active_index_by_family.as_ref().expect("families");
        for family in MODEL_FAMILIES {
            assert_eq!(by_family.get(family), Some(0));
        }
        // Second run is a no-op.
        assert!(!normalize_doctor_indexes(&mut storage));
    }

    #[test]
    fn placeholder_and_token_key_helpers() {
        assert!(has_placeholder_email(Some("Demo@Example.com ")));
        assert!(!has_placeholder_email(Some("real@company.com")));
        assert!(!has_placeholder_email(None));
        assert_eq!(get_doctor_refresh_token_key("  "), None);
        assert_eq!(get_doctor_refresh_token_key(" rt "), Some("rt".to_string()));
    }
}
