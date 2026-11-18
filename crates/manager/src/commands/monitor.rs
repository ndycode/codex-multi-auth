//! Port of `lib/codex-manager/commands/monitor.ts`.
//!
//! Behavior source: spec 08 §4.13 — local governance monitor aggregating
//! runtime, usage, policy, profile, model, quota, and project context.

use cma_accounts::account_policy::{load_account_policy_store, AccountPolicyStore};
use cma_accounts::capability_matrix::{
    build_model_capability_matrix, ModelCapabilityMatrixInput,
};
use cma_accounts::routing_profiles::{
    resolve_project_routing_profile, ProjectRoutingProfileContext,
};
use cma_core::json_io::stringify_pretty2;
use cma_core::utils::now_ms;
use cma_quota::budget_guard::{load_budget_guard_store, BudgetGuardStore};
use cma_quota::cache::{load_quota_cache, QuotaCacheData};
use cma_quota::readiness::find_quota_cache_entry_for_account;
use cma_request::model_map::RequestModelCatalog;
use cma_runtime::observability::{
    load_persisted_runtime_observability_snapshot, RuntimeObservabilitySnapshot,
};
use cma_usage::ledger::summarize_usage_ledger;
use cma_usage::types::{UsageSummary, UsageSummaryGroupBy, UsageSummaryQuery};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    default_load_accounts, default_set_storage_path, BoxFuture, LoadAccountsFn, SetStoragePathFn,
};

/// TS `MonitorCommandDeps` (log sinks live on [`CliOut`]).
pub struct MonitorCommandDeps {
    pub set_storage_path: SetStoragePathFn,
    pub load_accounts: LoadAccountsFn,
    pub load_runtime_observability_snapshot:
        Box<dyn Fn() -> BoxFuture<Option<RuntimeObservabilitySnapshot>> + Send + Sync>,
    pub load_quota_cache: Box<dyn Fn() -> BoxFuture<QuotaCacheData> + Send + Sync>,
    pub load_account_policy_store: Box<dyn Fn() -> BoxFuture<AccountPolicyStore> + Send + Sync>,
    pub load_budget_guard_store: Box<dyn Fn() -> BoxFuture<BudgetGuardStore> + Send + Sync>,
    pub resolve_project_routing_profile:
        Box<dyn Fn() -> BoxFuture<ProjectRoutingProfileContext> + Send + Sync>,
    pub summarize_usage_ledger:
        Box<dyn Fn(UsageSummaryQuery) -> BoxFuture<std::io::Result<UsageSummary>> + Send + Sync>,
    pub get_now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
}

impl Default for MonitorCommandDeps {
    fn default() -> Self {
        MonitorCommandDeps {
            set_storage_path: default_set_storage_path(),
            load_accounts: default_load_accounts(),
            load_runtime_observability_snapshot: Box::new(|| {
                Box::pin(async { load_persisted_runtime_observability_snapshot() })
            }),
            load_quota_cache: Box::new(|| Box::pin(load_quota_cache())),
            load_account_policy_store: Box::new(|| Box::pin(load_account_policy_store())),
            load_budget_guard_store: Box::new(|| Box::pin(load_budget_guard_store())),
            resolve_project_routing_profile: Box::new(|| {
                Box::pin(async {
                    let start_dir = std::env::current_dir().unwrap_or_default();
                    resolve_project_routing_profile(&start_dir).await
                })
            }),
            summarize_usage_ledger: Box::new(|query| {
                Box::pin(async move { summarize_usage_ledger(&query).await })
            }),
            get_now: None,
        }
    }
}

fn print_monitor_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth monitor [--json]",
            "",
            "Aggregates local runtime, usage, policy, profile, model, quota, and project context.",
        ]
        .join("\n"),
    );
}

fn path_to_value(path: Option<&std::path::Path>) -> Value {
    match path {
        Some(path) => Value::from(path.to_string_lossy().into_owned()),
        None => Value::Null,
    }
}

/// Production entry.
pub async fn run_monitor_command(args: &[String], out: &mut CliOut) -> i32 {
    run_monitor_command_with(args, &MonitorCommandDeps::default(), out).await
}

/// TS `runMonitorCommand(args, deps)`.
pub async fn run_monitor_command_with(
    args: &[String],
    deps: &MonitorCommandDeps,
    out: &mut CliOut,
) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_monitor_usage(out);
        return 0;
    }
    let mut json = false;
    for arg in args {
        if arg == "--json" || arg == "-j" {
            json = true;
            continue;
        }
        out.error(format!("Unknown monitor option: {arg}"));
        return 1;
    }

    (deps.set_storage_path)(None);
    let (storage, runtime, quota_cache, account_policies, budget_guards, project, usage) = tokio::join!(
        (deps.load_accounts)(),
        (deps.load_runtime_observability_snapshot)(),
        (deps.load_quota_cache)(),
        (deps.load_account_policy_store)(),
        (deps.load_budget_guard_store)(),
        (deps.resolve_project_routing_profile)(),
        (deps.summarize_usage_ledger)(UsageSummaryQuery {
            since: None,
            until: None,
            include_archives: false,
            by: Some(UsageSummaryGroupBy::Outcome),
        }),
    );
    let usage = match usage {
        Ok(usage) => usage,
        Err(error) => {
            // TS lets a ledger read rejection propagate; surface as an error
            // exit instead of a crash.
            out.error(format!("Failed to read usage ledger: {error}"));
            return 1;
        }
    };

    let now = deps.get_now.as_ref().map(|f| f()).unwrap_or_else(now_ms);
    let quota_by_account: Option<Vec<Option<Value>>> = storage.as_ref().map(|storage| {
        storage
            .accounts
            .iter()
            .map(|account| {
                find_quota_cache_entry_for_account(
                    Some(&quota_cache),
                    account,
                    &storage.accounts,
                )
                .map(|entry| serde_json::to_value(entry).unwrap_or(Value::Null))
            })
            .collect()
    });
    let matrix = build_model_capability_matrix(
        &RequestModelCatalog,
        &ModelCapabilityMatrixInput {
            storage: storage.as_ref(),
            models: None,
            entitlements: None,
            capability_policy: None,
            quota_by_account: quota_by_account.as_deref(),
            now: Some(now),
        },
    );

    let account_count = storage
        .as_ref()
        .map(|storage| storage.accounts.len())
        .unwrap_or(0);
    let policy_count = account_policies.len();
    let available = matrix.entries.iter().filter(|entry| entry.available).count();
    let unavailable = matrix.entries.iter().filter(|entry| !entry.available).count();

    let mut payload = Map::new();
    payload.insert("command".into(), Value::from("monitor"));
    let mut project_obj = Map::new();
    project_obj.insert(
        "projectKey".into(),
        project
            .project_key
            .clone()
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    project_obj.insert("projectRoot".into(), path_to_value(project.project_root.as_deref()));
    project_obj.insert("hasProfile".into(), Value::from(project.profile.is_some()));
    project_obj.insert(
        "budgetKey".into(),
        project
            .profile
            .as_ref()
            .and_then(|profile| profile.budget_key.clone())
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    payload.insert("project".into(), Value::Object(project_obj));
    let mut accounts_obj = Map::new();
    accounts_obj.insert("count".into(), Value::from(account_count as i64));
    accounts_obj.insert("policyCount".into(), Value::from(policy_count as i64));
    payload.insert("accounts".into(), Value::Object(accounts_obj));
    payload.insert(
        "runtime".into(),
        runtime
            .as_ref()
            .map(|snapshot| serde_json::to_value(snapshot).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "usage".into(),
        serde_json::to_value(&usage).unwrap_or(Value::Null),
    );
    payload.insert("budgetGuardCount".into(), Value::from(budget_guards.len() as i64));
    payload.insert(
        "routingProfile".into(),
        project
            .profile
            .as_ref()
            .map(|profile| serde_json::to_value(profile).unwrap_or(Value::Null))
            .unwrap_or(Value::Null),
    );
    let mut matrix_obj = Map::new();
    matrix_obj.insert(
        "models".into(),
        Value::Array(matrix.models.iter().cloned().map(Value::from).collect()),
    );
    matrix_obj.insert("entries".into(), Value::from(matrix.entries.len() as i64));
    matrix_obj.insert("available".into(), Value::from(available as i64));
    matrix_obj.insert("unavailable".into(), Value::from(unavailable as i64));
    payload.insert("modelMatrix".into(), Value::Object(matrix_obj));
    let mut quota_obj = Map::new();
    quota_obj.insert(
        "byAccountId".into(),
        Value::from(quota_cache.by_account_id.len() as i64),
    );
    quota_obj.insert("byEmail".into(), Value::from(quota_cache.by_email.len() as i64));
    payload.insert("quotaCache".into(), Value::Object(quota_obj));

    if json {
        out.info(stringify_pretty2(&Value::Object(payload)));
        return 0;
    }

    out.info("Local governance monitor");
    out.info(format!(
        "Project: {}",
        project.project_key.as_deref().unwrap_or("none")
    ));
    out.info(format!("Accounts: {account_count} ({policy_count} policies)"));
    out.info(format!(
        "Usage: {} requests, {} tokens, ${:.6}",
        usage.totals.requests, usage.totals.total_tokens, usage.totals.cost_usd
    ));
    out.info(format!("Budgets: {}", budget_guards.len()));
    out.info(format!(
        "Models: {available}/{} available",
        matrix.entries.len()
    ));
    out.info(format!(
        "Quota cache: {} account ids, {} emails",
        quota_cache.by_account_id.len(),
        quota_cache.by_email.len()
    ));
    if let Some(runtime) = runtime {
        out.info(format!(
            "Runtime: responses={}, refresh={}, failures={}",
            runtime.responses_requests,
            runtime.auth_refresh_requests,
            runtime.runtime_metrics.failed_requests
        ));
    } else {
        out.info("Runtime: no persisted snapshot");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};

    fn storage() -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        let mut account = AccountMetadataV3::new("refresh", 1, 1);
        account.email = Some("owner@example.com".to_string());
        account.account_id = Some("acct_1".to_string());
        storage.accounts.push(account);
        storage
    }

    fn deps() -> MonitorCommandDeps {
        let storage = storage();
        MonitorCommandDeps {
            set_storage_path: Box::new(|_| {}),
            load_accounts: Box::new(move || {
                let storage = storage.clone();
                Box::pin(async move { Some(storage) })
            }),
            load_runtime_observability_snapshot: Box::new(|| Box::pin(async { None })),
            load_quota_cache: Box::new(|| Box::pin(async { QuotaCacheData::default() })),
            load_account_policy_store: Box::new(|| Box::pin(async { AccountPolicyStore::empty() })),
            load_budget_guard_store: Box::new(|| Box::pin(async { BudgetGuardStore::empty() })),
            resolve_project_routing_profile: Box::new(|| {
                Box::pin(async {
                    ProjectRoutingProfileContext {
                        start_dir: "/repo".into(),
                        project_root: Some("/repo".into()),
                        identity_root: Some("/repo".into()),
                        project_key: Some("project-a".to_string()),
                        profile: None,
                    }
                })
            }),
            summarize_usage_ledger: Box::new(|query| {
                Box::pin(async move {
                    Ok(UsageSummary {
                        since: None,
                        until: None,
                        by: query.by.unwrap_or_default(),
                        totals: cma_usage::types::UsageSummaryBucket {
                            key: "total".into(),
                            requests: 2,
                            successes: 1,
                            failures: 1,
                            blocked: 0,
                            cancelled: 0,
                            input_tokens: 10,
                            output_tokens: 20,
                            cached_input_tokens: 0,
                            reasoning_tokens: 0,
                            total_tokens: 30,
                            cost_usd: 0.001,
                        },
                        buckets: vec![],
                    })
                })
            }),
            get_now: Some(Box::new(|| 123)),
        }
    }

    #[tokio::test]
    async fn prints_json_aggregate_output_without_raw_account_labels() {
        let d = deps();
        let mut out = CliOut::capture();
        let exit_code = run_monitor_command_with(&["--json".to_string()], &d, &mut out).await;
        assert_eq!(exit_code, 0);
        let output = out.info_text();
        let payload: Value = serde_json::from_str(&output).expect("json");
        assert_eq!(payload["project"]["projectKey"], Value::from("project-a"));
        assert_eq!(payload["accounts"]["count"], Value::from(1));
        assert!(payload["modelMatrix"]["entries"].as_i64().unwrap() > 0);
        assert!(!output.contains("owner@example.com"));
    }

    #[tokio::test]
    async fn rejects_unknown_options() {
        let d = deps();
        let mut out = CliOut::capture();
        let exit_code = run_monitor_command_with(&["--bad".to_string()], &d, &mut out).await;
        assert_eq!(exit_code, 1);
        assert!(out.error_text().contains("Unknown monitor option"));
    }

    #[tokio::test]
    async fn text_mode_prints_governance_lines() {
        let d = deps();
        let mut out = CliOut::capture();
        let exit_code = run_monitor_command_with(&[], &d, &mut out).await;
        assert_eq!(exit_code, 0);
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "Local governance monitor");
        assert_eq!(lines[1], "Project: project-a");
        assert_eq!(lines[2], "Accounts: 1 (0 policies)");
        assert_eq!(lines[3], "Usage: 2 requests, 30 tokens, $0.001000");
        assert_eq!(lines[4], "Budgets: 0");
        assert!(lines[5].ends_with("available"));
        assert_eq!(lines[6], "Quota cache: 0 account ids, 0 emails");
        assert_eq!(lines[7], "Runtime: no persisted snapshot");
    }
}
