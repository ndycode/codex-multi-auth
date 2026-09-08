//! Port of `lib/codex-manager/commands/why-selected.ts`.
//!
//! Behavior source: spec 08 §4.22 (+ gotcha 22): `--last` performs a live
//! recomputation (there is no persisted selection tracker); the runtime
//! snapshot only contributes `generatedAt` via the dispatcher wrapper.
//! Non-finite scores print `"NaN"`.

use cma_core::schemas::account_storage::AccountStorageV3;
use cma_core::token_utils::sanitize_email;
use cma_core::utils::now_ms;
use cma_rotation::selector::{
    select_hybrid_account_traced, AccountWithMetrics, HybridSelectionCandidateTrace,
    HybridSelectionTraceResult, SelectHybridAccountParams,
};
use cma_rotation::trackers::{get_health_tracker, get_token_tracker, TrackerKey};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    default_load_accounts, default_set_storage_path, BoxFuture, LoadAccountsFn, SetStoragePathFn,
};

/// TS `WhySelectedCliOptions`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WhySelectedCliOptions {
    pub json: bool,
    pub mode: WhySelectedMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WhySelectedMode {
    Now,
    Last,
}

impl WhySelectedMode {
    fn as_str(self) -> &'static str {
        match self {
            WhySelectedMode::Now => "now",
            WhySelectedMode::Last => "last",
        }
    }
}

/// The dispatcher's snapshot wrapper output — ONLY `generatedAt` passes
/// through (number|string), everything else is dropped.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WhySelectedRuntimeSnapshot {
    pub generated_at: Option<Value>,
}

/// TS `WhySelectedCommandDeps` (log sinks live on [`CliOut`]).
#[allow(clippy::type_complexity)] // boxed DI seams mirror the TS deps object 1:1
pub struct WhySelectedCommandDeps {
    pub set_storage_path: SetStoragePathFn,
    pub load_accounts: LoadAccountsFn,
    pub select_account_traced:
        Box<dyn Fn(&AccountStorageV3) -> HybridSelectionTraceResult + Send + Sync>,
    pub load_runtime_observability_snapshot:
        Option<Box<dyn Fn() -> BoxFuture<Option<WhySelectedRuntimeSnapshot>> + Send + Sync>>,
    pub sanitize_email: Box<dyn Fn(Option<&str>) -> Option<String> + Send + Sync>,
}

/// TS dispatcher `buildSelectAccountTraced()` — builds `AccountWithMetrics`
/// from persisted storage and runs the traced hybrid selector against the
/// process-global (volatile, never persisted) trackers.
pub fn select_account_traced_production(storage: &AccountStorageV3) -> HybridSelectionTraceResult {
    let now = now_ms();
    let health_tracker = get_health_tracker(None);
    let token_tracker = get_token_tracker(None);
    let accounts_with_metrics: Vec<AccountWithMetrics> = storage
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let enabled = account.enabled != Some(false);
            let rate_limited = account
                .rate_limit_reset_times
                .as_ref()
                .map(|times| times.iter().any(|(_, value)| value > now))
                .unwrap_or(false);
            let cooling_down = account.cooling_down_until.is_some_and(|until| until > now);
            AccountWithMetrics {
                index,
                tracker_key: account
                    .account_id
                    .clone()
                    .map(TrackerKey::from)
                    .or(Some(TrackerKey::Number(index as i64))),
                is_available: enabled && !rate_limited && !cooling_down,
                last_used: account.last_used,
            }
        })
        .collect();
    let metrics_ref: &[AccountWithMetrics] = &accounts_with_metrics;
    select_hybrid_account_traced(SelectHybridAccountParams::new(
        metrics_ref,
        health_tracker,
        token_tracker,
    ))
}

impl Default for WhySelectedCommandDeps {
    fn default() -> Self {
        WhySelectedCommandDeps {
            set_storage_path: default_set_storage_path(),
            load_accounts: default_load_accounts(),
            select_account_traced: Box::new(select_account_traced_production),
            load_runtime_observability_snapshot: Some(Box::new(|| {
                Box::pin(async {
                    let snapshot =
                        cma_runtime::observability::load_persisted_runtime_observability_snapshot()?;
                    // Only {generatedAt} passes through (number|string).
                    match snapshot.extra.get("generatedAt") {
                        Some(value) if value.is_number() || value.is_string() => {
                            Some(WhySelectedRuntimeSnapshot {
                                generated_at: Some(value.clone()),
                            })
                        }
                        _ => None,
                    }
                })
            })),
            sanitize_email: Box::new(sanitize_email),
        }
    }
}

/// TS `parseWhySelectedArgs(args)`.
pub fn parse_why_selected_args(args: &[String]) -> Result<WhySelectedCliOptions, String> {
    let mut options = WhySelectedCliOptions {
        json: false,
        mode: WhySelectedMode::Now,
    };
    let mut mode_explicitly_set = false;
    for arg in args {
        if arg == "--json" || arg == "-j" {
            options.json = true;
            continue;
        }
        if arg == "--now" || arg == "-n" {
            if mode_explicitly_set && options.mode != WhySelectedMode::Now {
                return Err("Cannot combine --now with --last".to_string());
            }
            options.mode = WhySelectedMode::Now;
            mode_explicitly_set = true;
            continue;
        }
        if arg == "--last" || arg == "-l" {
            if mode_explicitly_set && options.mode != WhySelectedMode::Last {
                return Err("Cannot combine --now with --last".to_string());
            }
            options.mode = WhySelectedMode::Last;
            mode_explicitly_set = true;
            continue;
        }
        return Err(format!("Unknown option: {arg}"));
    }
    Ok(options)
}

/// TS `printWhySelectedUsage()`.
pub fn print_why_selected_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth why-selected [--now | --last] [--json]",
            "",
            "Options:",
            "  --now, -n     Run selection now with live state (default)",
            "  --last, -l    Recompute selection using current state + last persisted runtime snapshot",
            "  --json, -j    Print machine-readable JSON output",
            "",
            "Exits 0 when an account is selected, 1 when no account can be selected.",
        ]
        .join("\n"),
    );
}

fn format_score(value: f64) -> String {
    if !value.is_finite() {
        return "NaN".to_string();
    }
    format!("{value:.2}")
}

fn number_value(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

struct CandidateRecord {
    index: usize,
    one_based_index: usize,
    email: Option<String>,
    account_id: Option<String>,
    enabled: bool,
    available: bool,
    health: f64,
    tokens: f64,
    hours_since_used: f64,
    capability_boost: f64,
    pid_bonus: f64,
    score: f64,
    last_switch_reason: Option<String>,
    last_rate_limit_reason: Option<String>,
    cooldown_reason: Option<String>,
    reason: Option<String>,
}

fn build_candidate_record(
    storage: &AccountStorageV3,
    candidate: &HybridSelectionCandidateTrace,
    sanitize: &(dyn Fn(Option<&str>) -> Option<String> + Send + Sync),
) -> CandidateRecord {
    let account = storage.accounts.get(candidate.index);
    CandidateRecord {
        index: candidate.index,
        one_based_index: candidate.index + 1,
        email: sanitize(account.and_then(|account| account.email.as_deref())),
        account_id: account.and_then(|account| account.account_id.clone()),
        enabled: account.map(|account| account.enabled != Some(false)).unwrap_or(true),
        available: candidate.is_available,
        health: candidate.health,
        tokens: candidate.tokens,
        hours_since_used: candidate.hours_since_used,
        capability_boost: candidate.capability_boost,
        pid_bonus: candidate.pid_bonus,
        score: candidate.score,
        last_switch_reason: account
            .and_then(|account| account.last_switch_reason)
            .map(|reason| reason.as_str().to_string()),
        // Runtime-only ManagedAccount field; never present on persisted
        // storage (the TS CLI reads it as undefined here too).
        last_rate_limit_reason: None,
        cooldown_reason: account
            .and_then(|account| account.cooldown_reason)
            .map(|reason| reason.as_str().to_string()),
        reason: candidate.reason.map(str::to_string),
    }
}

fn candidate_to_value(record: &CandidateRecord) -> Value {
    let mut row = Map::new();
    row.insert("index".into(), Value::from(record.index as i64));
    row.insert("oneBasedIndex".into(), Value::from(record.one_based_index as i64));
    if let Some(email) = &record.email {
        row.insert("email".into(), Value::from(email.clone()));
    }
    if let Some(account_id) = &record.account_id {
        row.insert("accountId".into(), Value::from(account_id.clone()));
    }
    row.insert("enabled".into(), Value::from(record.enabled));
    row.insert("available".into(), Value::from(record.available));
    row.insert("health".into(), number_value(record.health));
    row.insert("tokens".into(), number_value(record.tokens));
    row.insert("hoursSinceUsed".into(), number_value(record.hours_since_used));
    row.insert("capabilityBoost".into(), number_value(record.capability_boost));
    row.insert("pidBonus".into(), number_value(record.pid_bonus));
    row.insert("score".into(), number_value(record.score));
    if let Some(last_switch_reason) = &record.last_switch_reason {
        row.insert("lastSwitchReason".into(), Value::from(last_switch_reason.clone()));
    }
    if let Some(last_rate_limit_reason) = &record.last_rate_limit_reason {
        row.insert(
            "lastRateLimitReason".into(),
            Value::from(last_rate_limit_reason.clone()),
        );
    }
    if let Some(cooldown_reason) = &record.cooldown_reason {
        row.insert("cooldownReason".into(), Value::from(cooldown_reason.clone()));
    }
    if let Some(reason) = &record.reason {
        row.insert("reason".into(), Value::from(reason.clone()));
    }
    Value::Object(row)
}

/// Production entry.
pub async fn run_why_selected_command(args: &[String], out: &mut CliOut) -> i32 {
    run_why_selected_command_with(args, &WhySelectedCommandDeps::default(), out).await
}

/// TS `runWhySelectedCommand(args, deps)`.
pub async fn run_why_selected_command_with(
    args: &[String],
    deps: &WhySelectedCommandDeps,
    out: &mut CliOut,
) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_why_selected_usage(out);
        return 0;
    }

    let options = match parse_why_selected_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            print_why_selected_usage(out);
            return 1;
        }
    };

    (deps.set_storage_path)(None);
    let storage = (deps.load_accounts)().await;
    let Some(storage) = storage.filter(|storage| !storage.accounts.is_empty()) else {
        if options.json {
            let mut payload = Map::new();
            payload.insert("command".into(), Value::from("why-selected"));
            payload.insert("mode".into(), Value::from(options.mode.as_str()));
            payload.insert("ok".into(), Value::from(false));
            payload.insert("error".into(), Value::from("no accounts configured"));
            payload.insert("selected".into(), Value::Null);
            payload.insert("candidates".into(), Value::Array(Vec::new()));
            out.info(cma_core::json_io::stringify_pretty2(&Value::Object(payload)));
        } else {
            out.error("No accounts configured. Run `codex-multi-auth login` to add an account.");
        }
        return 1;
    };

    let trace = (deps.select_account_traced)(&storage);
    let candidates: Vec<CandidateRecord> = trace
        .candidates
        .iter()
        .map(|candidate| build_candidate_record(&storage, candidate, deps.sanitize_email.as_ref()))
        .collect();

    let selected_record: Option<(CandidateRecord, String)> = trace.selected_index.and_then(|selected_index| {
        trace
            .candidates
            .iter()
            .find(|candidate| candidate.index == selected_index)
            .map(|base_candidate| {
                (
                    build_candidate_record(&storage, base_candidate, deps.sanitize_email.as_ref()),
                    trace.selection_reason.clone(),
                )
            })
    });

    let mut runtime_snapshot: Option<WhySelectedRuntimeSnapshot> = None;
    if options.mode == WhySelectedMode::Last
        && let Some(load) = &deps.load_runtime_observability_snapshot
    {
        runtime_snapshot = load().await;
    }

    if options.json {
        let mut payload = Map::new();
        payload.insert("command".into(), Value::from("why-selected"));
        payload.insert("mode".into(), Value::from(options.mode.as_str()));
        payload.insert("ok".into(), Value::from(selected_record.is_some()));
        payload.insert(
            "availableCount".into(),
            Value::from(trace.available_count as i64),
        );
        payload.insert("totalCount".into(), Value::from(storage.accounts.len() as i64));
        if let Some(quota_key) = &trace.quota_key {
            payload.insert("quotaKey".into(), Value::from(quota_key.clone()));
        }
        let mut config = Map::new();
        config.insert("healthWeight".into(), number_value(trace.config.health_weight));
        config.insert("tokenWeight".into(), number_value(trace.config.token_weight));
        config.insert(
            "freshnessWeight".into(),
            number_value(trace.config.freshness_weight),
        );
        payload.insert("config".into(), Value::Object(config));
        payload.insert(
            "selected".into(),
            selected_record
                .as_ref()
                .map(|(record, selection_reason)| {
                    let mut value = candidate_to_value(record);
                    if let Some(object) = value.as_object_mut() {
                        object.insert(
                            "selectionReason".into(),
                            Value::from(selection_reason.clone()),
                        );
                    }
                    value
                })
                .unwrap_or(Value::Null),
        );
        payload.insert(
            "candidates".into(),
            Value::Array(candidates.iter().map(candidate_to_value).collect()),
        );
        if options.mode == WhySelectedMode::Last {
            payload.insert(
                "runtimeSnapshot".into(),
                runtime_snapshot
                    .as_ref()
                    .map(|snapshot| {
                        let mut object = Map::new();
                        if let Some(generated_at) = &snapshot.generated_at {
                            object.insert("generatedAt".into(), generated_at.clone());
                        }
                        Value::Object(object)
                    })
                    .unwrap_or(Value::Null),
            );
        }
        out.info(cma_core::json_io::stringify_pretty2(&Value::Object(payload)));
        return if selected_record.is_some() { 0 } else { 1 };
    }

    let mode_label = match options.mode {
        WhySelectedMode::Last => "Last selection (live recomputation; no persistent tracker)",
        WhySelectedMode::Now => "Selection right now (live)",
    };
    out.info(format!("why-selected: {mode_label}"));
    if let Some(quota_key) = &trace.quota_key {
        out.info(format!("Quota key: {quota_key}"));
    }
    out.info(format!(
        "Available: {} of {} account(s)",
        trace.available_count,
        storage.accounts.len()
    ));
    out.info("");

    if let Some((record, selection_reason)) = &selected_record {
        let label = match &record.email {
            Some(email) => format!("Selected: account {} <{email}>", record.one_based_index),
            None => format!("Selected: account {}", record.one_based_index),
        };
        out.info(label);
        out.info(format!("  score: {}", format_score(record.score)));
        out.info(format!("  health: {:.1}", record.health));
        out.info(format!("  tokens: {:.1}", record.tokens));
        out.info(format!("  hoursSinceUsed: {:.2}", record.hours_since_used));
        out.info(format!("  reason: {selection_reason}"));
        if let Some(last_switch_reason) = &record.last_switch_reason {
            out.info(format!("  lastSwitchReason: {last_switch_reason}"));
        }
        if let Some(last_rate_limit_reason) = &record.last_rate_limit_reason {
            out.info(format!("  lastRateLimitReason: {last_rate_limit_reason}"));
        }
        if let Some(cooldown_reason) = &record.cooldown_reason {
            out.info(format!("  cooldownReason: {cooldown_reason}"));
        }
    } else {
        out.error(format!(
            "No account could be selected: {}. Run `codex-multi-auth check` or `codex-multi-auth doctor` for diagnostics.",
            trace.selection_reason
        ));
    }

    out.info("");
    out.info("Candidates (sorted by score desc):");
    for candidate in &candidates {
        let marker = if selected_record
            .as_ref()
            .is_some_and(|(record, _)| candidate.index == record.index)
        {
            "*"
        } else if candidate.available {
            " "
        } else {
            "x"
        };
        let email_segment = candidate
            .email
            .as_ref()
            .map(|email| format!(" <{email}>"))
            .unwrap_or_default();
        let reason_segment = candidate
            .reason
            .as_ref()
            .map(|reason| format!(" ({reason})"))
            .unwrap_or_default();
        out.info(format!(
            "  {marker} {}{email_segment}: score={} health={:.0} tokens={:.0} hrs={:.1}{reason_segment}",
            candidate.one_based_index,
            format_score(candidate.score),
            candidate.health,
            candidate.tokens,
            candidate.hours_since_used,
        ));
    }

    if options.mode == WhySelectedMode::Last && runtime_snapshot.is_none() {
        out.info("");
        out.info(
            "Note: no persistent selection tracker exists. Output above is a live recomputation from current state.",
        );
    }

    if selected_record.is_some() { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_rotation::selector::HybridSelectionConfig;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    fn storage_with(count: usize) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        for i in 0..count {
            let mut account = AccountMetadataV3::new(format!("token-{i}"), 1, 1);
            account.email = Some(format!("user{i}@example.com"));
            account.account_id = Some(format!("acct-{i}"));
            storage.accounts.push(account);
        }
        storage
    }

    fn trace_with(selected: Option<usize>, candidates: Vec<HybridSelectionCandidateTrace>) -> HybridSelectionTraceResult {
        HybridSelectionTraceResult {
            selected: None,
            selected_index: selected,
            selection_reason: if selected.is_some() {
                "highest hybrid score".to_string()
            } else {
                "no accounts available".to_string()
            },
            candidates,
            config: HybridSelectionConfig::default(),
            quota_key: None,
            available_count: selected.map(|_| 1).unwrap_or(0),
        }
    }

    fn candidate(index: usize, score: f64, available: bool) -> HybridSelectionCandidateTrace {
        HybridSelectionCandidateTrace {
            index,
            tracker_key: TrackerKey::Number(index as i64),
            is_available: available,
            last_used: 0,
            health: 100.0,
            tokens: 50.0,
            hours_since_used: 1.25,
            capability_boost: 0.0,
            pid_bonus: 0.0,
            score,
            reason: if available {
                None
            } else {
                Some("unavailable (rate-limited, cooling down, or circuit open)")
            },
        }
    }

    fn deps_with(
        storage: Option<AccountStorageV3>,
        trace: HybridSelectionTraceResult,
        snapshot: Option<WhySelectedRuntimeSnapshot>,
    ) -> WhySelectedCommandDeps {
        WhySelectedCommandDeps {
            set_storage_path: Box::new(|_| {}),
            load_accounts: Box::new(move || {
                let storage = storage.clone();
                Box::pin(async move { storage })
            }),
            select_account_traced: Box::new(move |_storage| trace.clone()),
            load_runtime_observability_snapshot: Some(Box::new(move || {
                let snapshot = snapshot.clone();
                Box::pin(async move { snapshot })
            })),
            sanitize_email: Box::new(sanitize_email),
        }
    }

    #[tokio::test]
    async fn empty_storage_json_payload_and_exit_1() {
        let deps = deps_with(None, trace_with(None, vec![]), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_why_selected_command_with(&args(&["--json"]), &deps, &mut out).await,
            1
        );
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["command"], Value::from("why-selected"));
        assert_eq!(payload["mode"], Value::from("now"));
        assert_eq!(payload["ok"], Value::from(false));
        assert_eq!(payload["error"], Value::from("no accounts configured"));
        assert_eq!(payload["selected"], Value::Null);
    }

    #[tokio::test]
    async fn conflicting_modes_rejected() {
        let deps = deps_with(Some(storage_with(1)), trace_with(Some(0), vec![candidate(0, 5.0, true)]), None);
        let mut out = CliOut::capture();
        assert_eq!(
            run_why_selected_command_with(&args(&["--now", "--last"]), &deps, &mut out).await,
            1
        );
        assert_eq!(out.error_text(), "Cannot combine --now with --last");
    }

    #[tokio::test]
    async fn selected_json_includes_selection_reason_and_exit_0() {
        let deps = deps_with(
            Some(storage_with(2)),
            trace_with(Some(0), vec![candidate(0, 5.0, true), candidate(1, 2.0, false)]),
            None,
        );
        let mut out = CliOut::capture();
        assert_eq!(
            run_why_selected_command_with(&args(&["--json"]), &deps, &mut out).await,
            0
        );
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["ok"], Value::from(true));
        assert_eq!(payload["selected"]["selectionReason"], Value::from("highest hybrid score"));
        assert_eq!(payload["selected"]["oneBasedIndex"], Value::from(1));
        assert_eq!(payload["candidates"].as_array().unwrap().len(), 2);
        // runtimeSnapshot key absent in `now` mode.
        assert!(payload.get("runtimeSnapshot").is_none());
        // JS number semantics: JSON.stringify(2) is "2" (integer form),
        // never "2.0".
        assert_eq!(payload["config"]["healthWeight"], Value::from(2));
    }

    #[tokio::test]
    async fn text_mode_prints_candidates_with_markers() {
        let deps = deps_with(
            Some(storage_with(2)),
            trace_with(Some(0), vec![candidate(0, 5.0, true), candidate(1, 2.0, false)]),
            None,
        );
        let mut out = CliOut::capture();
        assert_eq!(run_why_selected_command_with(&[], &deps, &mut out).await, 0);
        let text = out.info_text();
        assert!(text.starts_with("why-selected: Selection right now (live)"));
        assert!(text.contains("Available: 1 of 2 account(s)"));
        assert!(text.contains("Selected: account 1 <user0@example.com>"));
        assert!(text.contains("  score: 5.00"));
        assert!(text.contains("  health: 100.0"));
        assert!(text.contains("  hoursSinceUsed: 1.25"));
        assert!(text.contains("Candidates (sorted by score desc):"));
        assert!(text.contains("  * 1 <user0@example.com>: score=5.00 health=100 tokens=50 hrs=1.2"));
        assert!(text.contains(
            "  x 2 <user1@example.com>: score=2.00 health=100 tokens=50 hrs=1.2 (unavailable (rate-limited, cooling down, or circuit open))"
        ));
    }

    #[tokio::test]
    async fn last_mode_without_snapshot_appends_note_and_null_snapshot() {
        let deps = deps_with(
            Some(storage_with(1)),
            trace_with(Some(0), vec![candidate(0, 5.0, true)]),
            None,
        );
        let mut out = CliOut::capture();
        assert_eq!(
            run_why_selected_command_with(&args(&["--last", "--json"]), &deps, &mut out).await,
            0
        );
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["mode"], Value::from("last"));
        assert_eq!(payload["runtimeSnapshot"], Value::Null);

        let deps = deps_with(
            Some(storage_with(1)),
            trace_with(Some(0), vec![candidate(0, 5.0, true)]),
            None,
        );
        let mut out = CliOut::capture();
        run_why_selected_command_with(&args(&["--last"]), &deps, &mut out).await;
        assert!(out.info_text().contains(
            "Note: no persistent selection tracker exists. Output above is a live recomputation from current state."
        ));
    }

    #[tokio::test]
    async fn no_selection_exits_1_with_diagnostics_hint() {
        let deps = deps_with(
            Some(storage_with(1)),
            trace_with(None, vec![candidate(0, f64::NEG_INFINITY, false)]),
            None,
        );
        let mut out = CliOut::capture();
        assert_eq!(run_why_selected_command_with(&[], &deps, &mut out).await, 1);
        assert_eq!(
            out.error_text(),
            "No account could be selected: no accounts available. Run `codex-multi-auth check` or `codex-multi-auth doctor` for diagnostics."
        );
        // Non-finite scores print NaN.
        assert!(out.info_text().contains("score=NaN"));
    }

    #[test]
    fn unknown_option_message() {
        assert_eq!(
            parse_why_selected_args(&args(&["--bogus"])).unwrap_err(),
            "Unknown option: --bogus"
        );
    }
}
