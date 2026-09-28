//! Port of `lib/policy/runtime-policy.ts` — the pre-request policy gate the
//! proxy pipeline consults before any account work, plus the once-only usage
//! recorder factory.
//!
//! Gate order (spec 13 §5.2 + ARCHITECTURE 6.11): model allow/deny substring
//! match → soft budget evaluation (vs the usage ledger with
//! `include_archives: true` — quota-forecast-03) → pause/drain blocks →
//! tag/weight score boosts → capability suppression, which is keyed by the
//! ENTITLEMENT account key (`resolveEntitlementAccountKey`), NOT the policy
//! key — quota-forecast-01: the capability store is written under the
//! entitlement key at the `recordUnsupported` sites, so the read must use the
//! same key or suppression is dead.
//!
//! Budget enforcement is soft / eventually-consistent under concurrency
//! (audit L10): evaluations read a pre-request ledger snapshot while
//! consumption is only recorded at completion, so racing requests can
//! transiently overshoot. Intentional — budgets are a best-effort guard.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use cma_accounts::account_policy::{
    AccountPolicyStore, get_account_policy_key_from_parts, load_account_policy_store,
};
use cma_accounts::capability_policy::CapabilityPolicyStore;
use cma_accounts::entitlement_cache::{EntitlementAccountRef, resolve_entitlement_account_key};
use cma_accounts::routing_profiles::{
    ProjectRoutingProfileContext, resolve_project_routing_profile,
};
use cma_core::utils::now_ms;
use cma_usage::ledger::{append_usage_ledger_row, summarize_usage_ledger};
use cma_usage::types::{
    UsageLedgerAppendInput, UsageLedgerOperation, UsageLedgerOutcome, UsageLedgerRow,
    UsageLedgerSource, UsageSummaryQuery,
};

use crate::budget_guard::{
    BudgetGuardEvaluation, BudgetGuardStore, evaluate_budget_guard, get_budget_window_start,
    load_budget_guard_store, normalize_budget_key,
};

/// TS `interface RuntimePolicyAccount`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimePolicyAccount {
    pub index: i64,
    pub account_id: Option<String>,
    pub email: Option<String>,
}

/// TS `interface RuntimePolicyDecision`.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimePolicyDecision {
    pub allowed: bool,
    /// 429 when blocked by a budget, 403 otherwise (only meaningful when
    /// `allowed == false`).
    pub status_code: u16,
    /// `None` when allowed; `"budget_blocked"` / `"policy_blocked"`.
    pub error_code: Option<String>,
    pub reasons: Vec<String>,
    pub project_key: Option<String>,
    pub blocked_account_indexes: HashSet<i64>,
    pub score_boost_by_account: HashMap<i64, f64>,
    pub budget_evaluations: Vec<BudgetGuardEvaluation>,
}

/// TS `interface RuntimePolicyState`.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimePolicyState {
    pub account_policies: AccountPolicyStore,
    pub budgets: BudgetGuardStore,
    pub project: ProjectRoutingProfileContext,
}

/// TS `loadRuntimePolicyState(startDir = process.cwd())` — the three loads
/// run concurrently (`Promise.all`); each is individually never-failing.
pub async fn load_runtime_policy_state(start_dir: &Path) -> RuntimePolicyState {
    let (account_policies, budgets, project) = tokio::join!(
        load_account_policy_store(),
        load_budget_guard_store(),
        resolve_project_routing_profile(start_dir),
    );
    RuntimePolicyState {
        account_policies,
        budgets,
        project,
    }
}

/// TS `normalizeToken` — trim + lowercase, `None` when empty.
fn normalize_token(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim().to_lowercase();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

/// TS `matchesModel(patterns, model)` — exact OR substring match over
/// normalized tokens; an un-normalizable model never matches.
fn matches_model(patterns: &[String], model: Option<&str>) -> bool {
    let Some(normalized_model) = normalize_token(model) else {
        return false;
    };
    patterns
        .iter()
        .any(|pattern| match normalize_token(Some(pattern)) {
            Some(normalized_pattern) => {
                normalized_model == normalized_pattern
                    || normalized_model.contains(&normalized_pattern)
            }
            None => false,
        })
}

/// TS `intersects(left, right)`.
fn intersects(left: &[String], right: &[String]) -> bool {
    let right_set: HashSet<&str> = right.iter().map(String::as_str).collect();
    left.iter().any(|entry| right_set.contains(entry.as_str()))
}

/// TS `evaluateBudgets` — checks `global`, the normalized
/// `project:{projectKey}` and the normalized profile `budgetKey` (dedupe,
/// insertion order). Keys are looked up through [`normalize_budget_key`]
/// because the store only ever holds normalized keys — an un-normalized
/// runtime key (`project:MyApp`) must still hit its stored `project:myapp`
/// limit or the budget is silently unenforced.
async fn evaluate_budgets(
    state: &RuntimePolicyState,
    now: i64,
) -> io::Result<Vec<BudgetGuardEvaluation>> {
    let mut keys: Vec<String> = vec!["global".to_string()];
    if let Some(project_key) = &state.project.project_key
        && let Some(key) = normalize_budget_key(&format!("project:{project_key}"))
        && !keys.contains(&key)
    {
        keys.push(key);
    }
    if let Some(profile) = &state.project.profile
        && let Some(budget_key) = &profile.budget_key
        && let Some(key) = normalize_budget_key(budget_key)
        && !keys.contains(&key)
    {
        keys.push(key);
    }
    let mut evaluations = Vec::new();
    for key in keys {
        let Some(limit) = state.budgets.get(&key) else {
            continue;
        };
        let summary = summarize_usage_ledger(&UsageSummaryQuery {
            since: Some(get_budget_window_start(limit.window, now) as f64),
            until: Some(now as f64),
            // Budget windows (e.g. monthly) can span a ledger rotation.
            // Without archives, rotated-out rows are dropped from the sum,
            // under-counting spend (quota-forecast-03).
            include_archives: true,
            by: None,
        })
        .await?;
        evaluations.push(evaluate_budget_guard(limit, &summary));
    }
    Ok(evaluations)
}

/// Input for [`evaluate_runtime_policy`].
#[derive(Clone, Copy)]
pub struct EvaluateRuntimePolicyInput<'a> {
    pub state: &'a RuntimePolicyState,
    pub accounts: &'a [RuntimePolicyAccount],
    pub model: Option<&'a str>,
    pub capability_policy: Option<&'a CapabilityPolicyStore>,
    /// `None` → wall clock (TS `now ?? Date.now()`).
    pub now: Option<i64>,
}

/// TS `evaluateRuntimePolicy(input)`.
///
/// Errors bubble up from the usage-ledger read (the TS promise rejected the
/// same way); the pipeline caller treats any error as FAIL-OPEN.
pub async fn evaluate_runtime_policy(
    input: EvaluateRuntimePolicyInput<'_>,
) -> io::Result<RuntimePolicyDecision> {
    let now = input.now.unwrap_or_else(now_ms);
    let mut reasons: Vec<String> = Vec::new();
    let mut blocked_account_indexes: HashSet<i64> = HashSet::new();
    let mut score_boost_by_account: HashMap<i64, f64> = HashMap::new();
    let profile = input.state.project.profile.as_ref();

    if let Some(profile) = profile
        && !profile.model_denylist.is_empty()
        && matches_model(&profile.model_denylist, input.model)
    {
        reasons.push("routing profile denies requested model".to_string());
    }
    if let Some(profile) = profile
        && !profile.model_allowlist.is_empty()
        && !matches_model(&profile.model_allowlist, input.model)
    {
        reasons.push("routing profile does not allow requested model".to_string());
    }

    let budget_evaluations = evaluate_budgets(input.state, now).await?;
    for evaluation in &budget_evaluations {
        if !evaluation.allowed {
            reasons.push(format!(
                "budget {} blocked request: {}",
                evaluation.key,
                evaluation.reasons.join("; ")
            ));
        }
    }

    for account in input.accounts {
        let account_key = get_account_policy_key_from_parts(
            account.account_id.as_deref(),
            account.email.as_deref(),
        );
        let account_policy = input.state.account_policies.get(&account_key);
        let mut boost = 0.0_f64;
        if let Some(policy) = account_policy {
            if policy.paused {
                blocked_account_indexes.insert(account.index);
            }
            if policy.drained {
                blocked_account_indexes.insert(account.index);
            }
            boost += (policy.weight - 1.0) * 2.0;
            if let Some(profile) = profile {
                if !profile.preferred_tags.is_empty()
                    && intersects(&policy.tags, &profile.preferred_tags)
                {
                    boost += 8.0;
                }
                if !profile.avoid_tags.is_empty() && intersects(&policy.tags, &profile.avoid_tags) {
                    boost -= 8.0;
                }
            }
        }
        if let Some(profile) = profile
            && let Some(weight) = profile.account_weight_by_key.get(&account_key)
        {
            boost += weight * 2.0;
        }
        // quota-forecast-01: read the capability store under the SAME key the
        // recordUnsupported sites write (the entitlement key), never the
        // policy key.
        let capability_key = resolve_entitlement_account_key(&EntitlementAccountRef {
            account_id: account.account_id.clone(),
            email: account.email.clone(),
            refresh_token: None,
            index: Some(account.index),
        });
        if let Some(capability_policy) = input.capability_policy
            && let Some(snapshot) =
                capability_policy.get_snapshot(&capability_key, input.model.unwrap_or("unknown"))
            && snapshot.unsupported > 0
        {
            blocked_account_indexes.insert(account.index);
        }
        score_boost_by_account.insert(account.index, boost);
    }

    let blocked_by_budget = budget_evaluations
        .iter()
        .any(|evaluation| !evaluation.allowed);
    let allowed = reasons.is_empty() && !blocked_by_budget;
    Ok(RuntimePolicyDecision {
        allowed,
        status_code: if blocked_by_budget { 429 } else { 403 },
        error_code: if allowed {
            None
        } else if blocked_by_budget {
            Some("budget_blocked".to_string())
        } else {
            Some("policy_blocked".to_string())
        },
        reasons,
        project_key: input.state.project.project_key.clone(),
        blocked_account_indexes,
        score_boost_by_account,
        budget_evaluations,
    })
}

/// Boxed append future (test seam for the TS injectable `append`).
pub type UsageAppendFuture =
    Pin<Box<dyn std::future::Future<Output = io::Result<UsageLedgerRow>> + Send>>;
/// Injectable append function (defaults to `appendUsageLedgerRow`).
pub type UsageAppendFn = Arc<dyn Fn(UsageLedgerAppendInput) -> UsageAppendFuture + Send + Sync>;

/// TS `createRuntimeUsageRecorder` options.
#[derive(Clone)]
pub struct RuntimeUsageRecorderOptions {
    pub source: UsageLedgerSource,
    pub operation: UsageLedgerOperation,
    pub model: Option<String>,
    pub project_key: Option<String>,
    pub request_id: Option<String>,
    /// `None` → wall clock at creation.
    pub started_at: Option<i64>,
    /// Test seam; `None` uses [`append_usage_ledger_row`].
    pub append: Option<UsageAppendFn>,
}

/// TS `interface RuntimeUsageRecordInput`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuntimeUsageRecordInput {
    /// Required in TS; `Default` falls back to `Failure` (an unclassifiable
    /// outcome must never count as a success) — always set it explicitly.
    pub outcome: Option<UsageLedgerOutcome>,
    pub status_code: Option<i64>,
    pub error_code: Option<String>,
    pub duration_ms: Option<i64>,
    pub account: Option<RuntimePolicyAccount>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cached_input_tokens: Option<f64>,
    pub reasoning_tokens: Option<f64>,
    pub total_tokens: Option<f64>,
}

/// TS `interface RuntimeUsageRecorder` — records AT MOST once per request
/// lifecycle; later calls are silent no-ops. Append failures are swallowed
/// (`.catch(() => undefined)`).
pub struct RuntimeUsageRecorder {
    recorded: AtomicBool,
    source: UsageLedgerSource,
    operation: UsageLedgerOperation,
    model: Option<String>,
    project_key: Option<String>,
    request_id: Option<String>,
    started_at: i64,
    append: Option<UsageAppendFn>,
}

impl std::fmt::Debug for RuntimeUsageRecorder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeUsageRecorder")
            .field("recorded", &self.has_recorded())
            .field("source", &self.source)
            .field("operation", &self.operation)
            .finish()
    }
}

/// TS `createRuntimeUsageRecorder(input)`.
pub fn create_runtime_usage_recorder(options: RuntimeUsageRecorderOptions) -> RuntimeUsageRecorder {
    RuntimeUsageRecorder {
        recorded: AtomicBool::new(false),
        source: options.source,
        operation: options.operation,
        model: options.model,
        project_key: options.project_key,
        request_id: options.request_id,
        started_at: options.started_at.unwrap_or_else(now_ms),
        append: options.append,
    }
}

impl RuntimeUsageRecorder {
    /// TS `hasRecorded()`.
    pub fn has_recorded(&self) -> bool {
        self.recorded.load(Ordering::SeqCst)
    }

    /// TS `record(input)` — first call wins; builds the append row
    /// (`durationMs ?? Date.now() - startedAt`) and swallows append errors.
    pub async fn record(&self, input: RuntimeUsageRecordInput) {
        if self.recorded.swap(true, Ordering::SeqCst) {
            return;
        }
        let account = input.account.as_ref();
        let row = UsageLedgerAppendInput {
            id: None,
            created_at: None,
            source: Some(self.source.as_str().to_string()),
            operation: Some(self.operation.as_str().to_string()),
            outcome: Some(
                input
                    .outcome
                    .unwrap_or(UsageLedgerOutcome::Failure)
                    .as_str()
                    .to_string(),
            ),
            model: self.model.clone(),
            project_key: self.project_key.clone(),
            account_id: account.and_then(|a| a.account_id.clone()),
            email: account.and_then(|a| a.email.clone()),
            account_index: account.map(|a| a.index as f64),
            request_id: self.request_id.clone(),
            status_code: input.status_code.map(|code| code as f64),
            error_code: input.error_code.clone(),
            duration_ms: Some(
                input
                    .duration_ms
                    .unwrap_or_else(|| now_ms() - self.started_at) as f64,
            ),
            input_tokens: input.input_tokens,
            output_tokens: input.output_tokens,
            cached_input_tokens: input.cached_input_tokens,
            reasoning_tokens: input.reasoning_tokens,
            total_tokens: input.total_tokens,
            cost_usd: None,
        };
        match &self.append {
            Some(append) => {
                let _ = append(row).await;
            }
            None => {
                let _ = append_usage_ledger_row(&row).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget_guard::{BudgetLimit, BudgetWindow};
    use cma_accounts::account_policy::AccountPolicy;
    use cma_accounts::routing_profiles::{AccountWeightMap, RoutingProfile};
    use cma_testkit::sandbox::EnvSandbox;
    use cma_usage::ledger::rotate_usage_ledger;
    use cma_usage::ledger::RotateUsageLedgerOptions;
    use serial_test::serial;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn utc_ms(year: i32, month: u32, day: u32, hour: u32) -> i64 {
        use chrono::TimeZone;
        chrono::Utc
            .with_ymd_and_hms(year, month, day, hour, 0, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn state() -> RuntimePolicyState {
        RuntimePolicyState {
            account_policies: AccountPolicyStore::empty(),
            budgets: BudgetGuardStore::empty(),
            project: ProjectRoutingProfileContext {
                start_dir: PathBuf::from("/repo"),
                project_root: Some(PathBuf::from("/repo")),
                identity_root: Some(PathBuf::from("/repo")),
                project_key: Some("project-a".to_string()),
                profile: None,
            },
        }
    }

    fn profile() -> RoutingProfile {
        RoutingProfile {
            project_key: "project-a".to_string(),
            project_name: "Project A".to_string(),
            identity_root: "/repo".to_string(),
            preferred_tags: Vec::new(),
            avoid_tags: Vec::new(),
            model_allowlist: Vec::new(),
            model_denylist: Vec::new(),
            account_weight_by_key: AccountWeightMap::new(),
            budget_key: None,
            updated_at: 1.0,
        }
    }

    fn day_limit(key: &str, max_requests: f64) -> BudgetLimit {
        BudgetLimit {
            key: key.to_string(),
            window: BudgetWindow::Day,
            max_requests: Some(max_requests),
            max_tokens: None,
            max_cost_usd: None,
            updated_at: 1.0,
        }
    }

    async fn append_success_row(id: Option<&str>, created_at: i64) {
        append_usage_ledger_row(&UsageLedgerAppendInput {
            id: id.map(str::to_string),
            created_at: Some(created_at as f64),
            source: Some("runtime-proxy".to_string()),
            operation: Some("responses".to_string()),
            outcome: Some("success".to_string()),
            model: Some("gpt-5.3-codex".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();
    }

    fn append_stub_row() -> io::Result<UsageLedgerRow> {
        // Minimal well-formed row for the injected-append seam.
        Ok(UsageLedgerRow {
            version: 1,
            id: "row-1".to_string(),
            created_at: 100.0,
            source: UsageLedgerSource::PluginHost,
            operation: UsageLedgerOperation::Responses,
            outcome: UsageLedgerOutcome::Success,
            model: None,
            project_key: None,
            account: None,
            request_id: None,
            status_code: None,
            error_code: None,
            duration_ms: Some(0),
            tokens: Default::default(),
            cost_usd: None,
        })
    }

    #[tokio::test]
    async fn blocks_paused_accounts_and_adds_profile_score_boosts() {
        let mut policy_state = state();
        let account_key = get_account_policy_key_from_parts(Some("acct_1"), None);
        policy_state.account_policies.insert(
            account_key.clone(),
            AccountPolicy {
                account_key: account_key.clone(),
                tags: vec!["fast".to_string()],
                weight: 3.0,
                paused: true,
                drained: false,
                note: None,
                updated_at: 1.0,
            },
        );
        let mut project_profile = profile();
        project_profile.preferred_tags = vec!["fast".to_string()];
        project_profile.model_allowlist = vec!["gpt-5.3-codex".to_string()];
        project_profile
            .account_weight_by_key
            .insert(account_key.clone(), 2.0);
        policy_state.project.profile = Some(project_profile);

        let accounts = [RuntimePolicyAccount {
            index: 0,
            account_id: Some("acct_1".to_string()),
            email: Some("owner@example.com".to_string()),
        }];
        let decision = evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &accounts,
            model: Some("gpt-5.3-codex"),
            capability_policy: None,
            now: Some(100),
        })
        .await
        .unwrap();

        assert!(decision.allowed);
        assert!(decision.blocked_account_indexes.contains(&0));
        // (weight 3 - 1) * 2 + preferred-tag 8 + account-weight 2 * 2 = 16.
        assert_eq!(decision.score_boost_by_account.get(&0), Some(&16.0));
    }

    #[tokio::test]
    async fn denylist_and_allowlist_reasons_are_frozen() {
        let mut policy_state = state();
        let mut project_profile = profile();
        project_profile.model_denylist = vec!["sol".to_string()];
        project_profile.model_allowlist = vec!["gpt-5.3-codex".to_string()];
        policy_state.project.profile = Some(project_profile);

        let decision = evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &[],
            model: Some("gpt-5.6-sol"),
            capability_policy: None,
            now: Some(100),
        })
        .await
        .unwrap();

        assert!(!decision.allowed);
        assert_eq!(decision.status_code, 403);
        assert_eq!(decision.error_code.as_deref(), Some("policy_blocked"));
        assert_eq!(
            decision.reasons,
            vec![
                "routing profile denies requested model".to_string(),
                "routing profile does not allow requested model".to_string(),
            ]
        );
    }

    // quota-forecast-01: capability suppression reads the store under the
    // SAME key the recordUnsupported sites write (entitlement key). A record
    // written under that key must block the account here.
    #[tokio::test]
    async fn blocks_account_whose_model_was_recorded_unsupported() {
        let mut capability_policy = CapabilityPolicyStore::new();
        let account = RuntimePolicyAccount {
            index: 0,
            account_id: Some("acct_cap".to_string()),
            email: Some("cap@example.com".to_string()),
        };
        let model = "gpt-5.3-codex";
        let entitlement_key = resolve_entitlement_account_key(&EntitlementAccountRef {
            account_id: account.account_id.clone(),
            email: account.email.clone(),
            refresh_token: None,
            index: Some(account.index),
        });
        capability_policy.record_unsupported(&entitlement_key, model, 100);

        let policy_state = state();
        let accounts = [account];
        let decision = evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &accounts,
            model: Some(model),
            capability_policy: Some(&capability_policy),
            now: Some(100),
        })
        .await
        .unwrap();

        assert!(decision.blocked_account_indexes.contains(&0));
    }

    #[tokio::test]
    #[serial(env)]
    async fn blocks_requests_when_matching_budget_is_exhausted() {
        let _sandbox = EnvSandbox::new();
        let mut policy_state = state();
        policy_state
            .budgets
            .insert("global", day_limit("global", 1.0));
        append_success_row(None, utc_ms(2026, 4, 29, 1)).await;

        let decision = evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &[],
            model: Some("gpt-5.3-codex"),
            capability_policy: None,
            now: Some(utc_ms(2026, 4, 29, 2)),
        })
        .await
        .unwrap();

        assert!(!decision.allowed);
        assert_eq!(decision.status_code, 429);
        assert_eq!(decision.error_code.as_deref(), Some("budget_blocked"));
    }

    // budget-guard stores limits ONLY under normalizeBudgetKey; a runtime
    // projectKey carrying uppercase must be normalized before lookup or the
    // budget is silently unenforced.
    #[tokio::test]
    #[serial(env)]
    async fn enforces_project_budget_stored_under_normalized_key() {
        let _sandbox = EnvSandbox::new();
        let mut policy_state = state();
        policy_state.project.project_key = Some("MyApp".to_string());
        policy_state
            .budgets
            .insert("project:myapp", day_limit("project:myapp", 1.0));
        append_success_row(None, utc_ms(2026, 4, 29, 1)).await;

        let decision = evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &[],
            model: Some("gpt-5.3-codex"),
            capability_policy: None,
            now: Some(utc_ms(2026, 4, 29, 2)),
        })
        .await
        .unwrap();

        assert!(!decision.allowed);
        assert_eq!(decision.status_code, 429);
        assert_eq!(decision.error_code.as_deref(), Some("budget_blocked"));
        assert!(
            decision
                .budget_evaluations
                .iter()
                .any(|evaluation| evaluation.key == "project:myapp" && !evaluation.allowed)
        );
    }

    // Same normalization gap on the routing profile's budgetKey: stored as
    // `team-alpha`, carried at runtime as `Team Alpha`.
    #[tokio::test]
    #[serial(env)]
    async fn enforces_profile_budget_stored_under_normalized_key() {
        let _sandbox = EnvSandbox::new();
        let mut policy_state = state();
        let mut project_profile = profile();
        project_profile.budget_key = Some("Team Alpha".to_string());
        policy_state.project.profile = Some(project_profile);
        policy_state
            .budgets
            .insert("team-alpha", day_limit("team-alpha", 1.0));
        append_success_row(None, utc_ms(2026, 4, 29, 1)).await;

        let decision = evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &[],
            model: Some("gpt-5.3-codex"),
            capability_policy: None,
            now: Some(utc_ms(2026, 4, 29, 2)),
        })
        .await
        .unwrap();

        assert!(!decision.allowed);
        assert_eq!(decision.error_code.as_deref(), Some("budget_blocked"));
        assert!(
            decision
                .budget_evaluations
                .iter()
                .any(|evaluation| evaluation.key == "team-alpha" && !evaluation.allowed)
        );
    }

    #[tokio::test]
    async fn records_usage_at_most_once() {
        let seen: Arc<Mutex<Vec<UsageLedgerAppendInput>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let append: UsageAppendFn = Arc::new(move |row| {
            let sink = Arc::clone(&sink);
            Box::pin(async move {
                sink.lock().unwrap().push(row);
                append_stub_row()
            })
        });
        let recorder = create_runtime_usage_recorder(RuntimeUsageRecorderOptions {
            source: UsageLedgerSource::PluginHost,
            operation: UsageLedgerOperation::Responses,
            model: Some("gpt-5.3-codex".to_string()),
            project_key: Some("project-a".to_string()),
            request_id: Some("req-1".to_string()),
            started_at: Some(100),
            append: Some(append),
        });

        recorder
            .record(RuntimeUsageRecordInput {
                outcome: Some(UsageLedgerOutcome::Success),
                status_code: Some(200),
                account: Some(RuntimePolicyAccount {
                    index: 0,
                    account_id: Some("acct_1".to_string()),
                    email: Some("owner@example.com".to_string()),
                }),
                ..Default::default()
            })
            .await;
        recorder
            .record(RuntimeUsageRecordInput {
                outcome: Some(UsageLedgerOutcome::Failure),
                status_code: Some(500),
                ..Default::default()
            })
            .await;

        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let row = &calls[0];
        assert_eq!(row.source.as_deref(), Some("plugin-host"));
        assert_eq!(row.operation.as_deref(), Some("responses"));
        assert_eq!(row.outcome.as_deref(), Some("success"));
        assert_eq!(row.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(row.project_key.as_deref(), Some("project-a"));
        assert_eq!(row.request_id.as_deref(), Some("req-1"));
        assert_eq!(row.status_code, Some(200.0));
        assert_eq!(row.account_id.as_deref(), Some("acct_1"));
        assert_eq!(row.email.as_deref(), Some("owner@example.com"));
        assert_eq!(row.account_index, Some(0.0));
        assert!(recorder.has_recorded());
    }

    #[tokio::test]
    async fn records_thread_goal_usage_as_distinct_operation() {
        let seen: Arc<Mutex<Vec<UsageLedgerAppendInput>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let append: UsageAppendFn = Arc::new(move |row| {
            let sink = Arc::clone(&sink);
            Box::pin(async move {
                sink.lock().unwrap().push(row);
                append_stub_row()
            })
        });
        let recorder = create_runtime_usage_recorder(RuntimeUsageRecorderOptions {
            source: UsageLedgerSource::RuntimeProxy,
            operation: UsageLedgerOperation::ThreadGoal,
            model: None,
            project_key: Some("project-a".to_string()),
            request_id: Some("thread-1".to_string()),
            started_at: Some(100),
            append: Some(append),
        });

        recorder
            .record(RuntimeUsageRecordInput {
                outcome: Some(UsageLedgerOutcome::Failure),
                status_code: Some(403),
                error_code: Some("thread_goal_upstream_blocked".to_string()),
                ..Default::default()
            })
            .await;

        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let row = &calls[0];
        assert_eq!(row.source.as_deref(), Some("runtime-proxy"));
        assert_eq!(row.operation.as_deref(), Some("thread-goal"));
        assert_eq!(row.outcome.as_deref(), Some("failure"));
        assert_eq!(row.request_id.as_deref(), Some("thread-1"));
        assert_eq!(row.status_code, Some(403.0));
        assert_eq!(
            row.error_code.as_deref(),
            Some("thread_goal_upstream_blocked")
        );
    }

    // quota-forecast-03: a budget window can span a usage-ledger rotation.
    // A pre-rotation row lives only in the archives; blocking proves the
    // archived row is counted (includeArchives: true).
    #[tokio::test]
    #[serial(env)]
    async fn counts_archived_spend_when_budget_window_spans_ledger_rotation() {
        let _sandbox = EnvSandbox::new();
        let mut policy_state = state();
        policy_state
            .budgets
            .insert("global", day_limit("global", 2.0));

        append_success_row(Some("before-rotate"), utc_ms(2026, 4, 29, 1)).await;
        let rotated = rotate_usage_ledger(&RotateUsageLedgerOptions {
            now: Some(utc_ms(2026, 4, 29, 2) as f64),
            if_larger_than_bytes: None,
        })
        .await
        .unwrap();
        assert!(rotated.is_some());
        append_success_row(Some("after-rotate"), utc_ms(2026, 4, 29, 3)).await;

        let decision = evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &[],
            model: Some("gpt-5.3-codex"),
            capability_policy: None,
            now: Some(utc_ms(2026, 4, 29, 4)),
        })
        .await
        .unwrap();

        // 2 requests in-window (1 archived + 1 current) >= maxRequests:2.
        assert!(!decision.allowed);
        assert_eq!(decision.status_code, 429);
        assert_eq!(decision.error_code.as_deref(), Some("budget_blocked"));
        let global_eval = decision
            .budget_evaluations
            .iter()
            .find(|evaluation| evaluation.key == "global")
            .expect("global evaluation");
        assert_eq!(global_eval.usage.requests, 2);
    }
}
