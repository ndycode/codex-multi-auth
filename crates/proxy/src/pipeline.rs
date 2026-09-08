//! THE merged per-request rotation pipeline (ARCHITECTURE §3 row 1).
//!
//! One pipeline implements the UNION of the two TS rotation loops:
//! - `index.ts` `auth.loader` custom fetch (spec 13 §5 — AUTHORITATIVE for
//!   the request loop; all 29 gotchas of §15 apply), and
//! - the request-loop half of `lib/runtime-rotation-proxy.ts` (spec 04 §9 —
//!   authoritative for the HTTP surface: status mapping, stable error
//!   codes, header scrubbing).
//!
//! Invoked by (a) the proxy HTTP surface (`server.rs`), (b) the wrapper's
//! in-process client, (c) the local bridge (via the proxy). The server owns
//! client auth, routing, the 64 MiB cap and the models/thread-goal routes;
//! this module owns everything that happens to a `/responses` request after
//! `RequestContext` construction, INCLUDING the usage-ledger record for the
//! responses operation (the server must not double-record it).
//!
//! Stage order (spec 13 §5 ∪ spec 04):
//! upstream-URL join → response-continuation injection → policy gate
//! (FAIL-OPEN) → pool-exhaustion/server-burst fast-fail → outbound attempt
//! budget (cap 6) → account selection (pin > sequential > affinity > hybrid,
//! capability/policy/sticky boosts) → token refresh (auth-failure removal
//! policy) → identity/entitlement gates → preemptive quota deferral → local
//! token bucket → upstream fetch → status ladder (context overflow →
//! unsupported-model traversal + fallback chains → workspace rotation → 403
//! entitlement → 5xx rotation → 429 short-retry MARK-BEFORE-SLEEP → 401
//! token-invalidation no-rotate + 300 s cooldown) → stream failover (cap 1,
//! only before first byte) → empty-response retries → terminal synthetic
//! bodies → session-affinity writes → metrics/observability.
//!
//! Counters SURVIVE model-fallback restarts (spec 13 gotcha 7). The local
//! token bucket is per-process and never persisted (gotcha 6); every
//! cooldown/rate-limit mark is followed by a debounced save (spec 04
//! gotcha 19; the `record_success` "healed" seam schedules its own save via
//! `SharedAccountManager`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use cma_accounts::capability_policy::CapabilityPolicyStore;
use cma_accounts::entitlement_cache::{
    EntitlementAccountRef, EntitlementBlockReason, EntitlementCache,
    resolve_entitlement_account_key,
};
use cma_accounts::manager::ManagedAccount;
use cma_accounts::manager_persistence::{
    AccountLabelSource, SAVE_DEBOUNCE_DEFAULT_MS, SharedAccountManager, format_account_label,
};
use cma_accounts::rate_limits::{format_wait_time, parse_rate_limit_reason};
use cma_accounts::session_affinity::SessionAffinityStore;
use cma_config::getters;
use cma_core::schemas::plugin_config::FallbackChain;
use cma_core::constants::ACCOUNT_LIMITS;
use cma_core::logger::{log_info, log_warn};
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{CooldownReason, RateLimitReason, SwitchReason};
use cma_core::schemas::plugin_config::PluginConfig;
use cma_core::token_utils::{
    ResolveRuntimeRequestIdentityInput, resolve_runtime_request_identity,
};
use cma_core::utils::now_ms;
use cma_quota::preemptive_scheduler::{PreemptiveQuotaScheduler, read_quota_scheduler_snapshot};
use cma_quota::runtime_policy::{
    EvaluateRuntimePolicyInput, RuntimePolicyAccount, RuntimePolicyDecision,
    RuntimeUsageRecordInput, RuntimeUsageRecorder, RuntimeUsageRecorderOptions,
    create_runtime_usage_recorder, evaluate_runtime_policy, load_runtime_policy_state,
};
use cma_request::attempt_budget::{
    OutboundRequestAttemptBudgetParams, cap_stream_failover_max,
    compute_outbound_request_attempt_budget,
};
use cma_request::context_overflow::handle_context_overflow;
use cma_request::error_classification::{
    get_unsupported_codex_model_info, is_workspace_disabled_error,
};
use cma_request::failover_config::{parse_env_int, parse_failover_mode};
use cma_request::failure_policy::{
    FailoverMode, FailurePolicyInput, FailurePolicyOverrides, FailureKind,
    evaluate_failure_policy,
};
use cma_request::fetch_helpers::{ErrorHandlingOptions, handle_error_response};
use cma_request::fetch_helpers::handle_success_response;
use cma_request::model_map::get_model_family;
use cma_request::rate_limit_backoff::{
    RateLimitBackoffOverrides, configure_rate_limit_backoff,
    configured_rate_limit_short_retry_threshold_ms, get_rate_limit_backoff,
    reset_rate_limit_backoff,
};
use cma_request::rate_limit_decision::{
    build_token_invalidation_body, get_quota_near_exhaustion_wait_ms,
    is_token_invalidation_error, normalize_exhaustion_status,
};
use cma_request::resilience::{
    AdaptiveFailoverAccount, arm_pool_exhaustion_cooldown,
    build_adaptive_stream_failover_candidate_order, clear_pool_exhaustion_cooldown,
    clear_server_burst_cooldown, get_pool_exhaustion_cooldown_remaining,
    get_server_burst_cooldown_remaining, record_server_burst_failure,
};
use cma_request::response_handler::{
    BodyStream, ConvertSseOptions, StreamResponse, is_empty_response,
};
use cma_request::response_metadata::parse_retry_after_hint_ms;
use cma_request::stream_failover::{StreamFailoverOptions, with_streaming_failover};
use cma_request::wait_utils::abortable_sleep;
use cma_rotation::selector::add_jitter;
use cma_runtime::observability::{
    RuntimeMetricsSnapshot, mutate_runtime_observability_snapshot,
    record_runtime_account_recovery, record_runtime_pool_exhaustion,
};
use cma_runtime::rotation::account_selection::{ChooseAccountParams, choose_account};
use cma_runtime::rotation::proxy_state::{RotationProxyState, recover_stale_runtime_state};
use cma_runtime::rotation::server_types::{
    ExhaustionReason, RequestContext, SchedulingStrategy,
};
use cma_runtime::rotation::token_refresh::{
    DEFAULT_AUTH_FAILURE_COOLDOWN_MS, EnsureFreshAccessTokenParams,
    EnsureFreshAccessTokenResult, apply_monotonic_auth_cooldown, ensure_fresh_access_token,
};
use cma_runtime::toast::{ToastVariant, show_runtime_toast};
use cma_rotation::routing_mutex::RoutingMutexMode;
use cma_usage::types::{UsageLedgerOperation, UsageLedgerOutcome, UsageLedgerSource};
use futures::StreamExt;
use http::HeaderMap;
use http::header::HeaderValue;
use serde_json::Value;

use crate::model_fallback::{
    self, UnsupportedModelContext, UnsupportedModelPlan, plan_unsupported_model,
    rebuild_body_with_model,
};
use crate::retry_loop::{
    self, OutboundAttemptBudget, RateLimit429Decision, RetryCounters, decide_rate_limit_429,
    error_message_body, synthetic_json_headers,
};

/// `MIN_BACKOFF_MS` (spec 13 §10) — floor for network/server same-account
/// retry delays and the short-429 sleep.
pub const MIN_BACKOFF_MS: i64 = 100;

/// Stream-failover defaults by mode (spec 13 §3). The effective max is
/// clamped to 1 by `cap_stream_failover_max` (gotcha 1).
const STREAM_FAILOVER_MAX_BY_MODE: [(FailoverMode, i64); 3] = [
    (FailoverMode::Aggressive, 1),
    (FailoverMode::Balanced, 2),
    (FailoverMode::Conservative, 2),
];
const STREAM_FAILOVER_SOFT_TIMEOUT_BY_MODE: [(FailoverMode, i64); 3] = [
    (FailoverMode::Aggressive, 10_000),
    (FailoverMode::Balanced, 15_000),
    (FailoverMode::Conservative, 20_000),
];

fn mode_lookup(table: &[(FailoverMode, i64); 3], mode: FailoverMode) -> i64 {
    table
        .iter()
        .find(|(m, _)| *m == mode)
        .map(|(_, v)| *v)
        .unwrap_or(table[1].1)
}

// ===========================================================================
// RuntimeMetrics (spec 13 §3)
// ===========================================================================

/// TS `RuntimeMetrics` — per-process request metrics mirrored into the
/// observability snapshot on every state transition.
#[derive(Debug, Clone)]
pub struct RuntimeMetrics {
    pub started_at: i64,
    pub total_requests: i64,
    pub successful_requests: i64,
    pub failed_requests: i64,
    pub responses_requests: i64,
    pub auth_refresh_requests: i64,
    pub diagnostic_probe_requests: i64,
    pub outbound_request_attempt_budget: Option<i64>,
    pub outbound_request_attempts_consumed: i64,
    pub request_attempt_budget_exhaustions: i64,
    pub pool_exhaustion_fast_fails: i64,
    pub server_burst_fast_fails: i64,
    pub rate_limited_responses: i64,
    pub server_errors: i64,
    pub network_errors: i64,
    pub user_aborts: i64,
    pub auth_refresh_failures: i64,
    pub empty_response_retries: i64,
    pub account_rotations: i64,
    pub same_account_retries: i64,
    pub stream_failover_attempts: i64,
    pub stream_failover_candidates_considered: i64,
    pub last_stream_failover_candidate_count: i64,
    pub stream_failover_recoveries: i64,
    pub stream_failover_cross_account_recoveries: i64,
    pub cumulative_latency_ms: i64,
    pub last_request_at: Option<i64>,
    pub last_error: Option<String>,
}

impl RuntimeMetrics {
    pub fn new(started_at: i64) -> Self {
        Self {
            started_at,
            total_requests: 0,
            successful_requests: 0,
            failed_requests: 0,
            responses_requests: 0,
            auth_refresh_requests: 0,
            diagnostic_probe_requests: 0,
            outbound_request_attempt_budget: None,
            outbound_request_attempts_consumed: 0,
            request_attempt_budget_exhaustions: 0,
            pool_exhaustion_fast_fails: 0,
            server_burst_fast_fails: 0,
            rate_limited_responses: 0,
            server_errors: 0,
            network_errors: 0,
            user_aborts: 0,
            auth_refresh_failures: 0,
            empty_response_retries: 0,
            account_rotations: 0,
            same_account_retries: 0,
            stream_failover_attempts: 0,
            stream_failover_candidates_considered: 0,
            last_stream_failover_candidate_count: 0,
            stream_failover_recoveries: 0,
            stream_failover_cross_account_recoveries: 0,
            cumulative_latency_ms: 0,
            last_request_at: None,
            last_error: None,
        }
    }

    /// Shallow copy into the persisted observability shape.
    pub fn to_snapshot(&self) -> RuntimeMetricsSnapshot {
        RuntimeMetricsSnapshot {
            started_at: self.started_at,
            total_requests: self.total_requests,
            successful_requests: self.successful_requests,
            failed_requests: self.failed_requests,
            responses_requests: self.responses_requests,
            auth_refresh_requests: self.auth_refresh_requests,
            diagnostic_probe_requests: self.diagnostic_probe_requests,
            outbound_request_attempt_budget: self.outbound_request_attempt_budget,
            outbound_request_attempts_consumed: self.outbound_request_attempts_consumed,
            request_attempt_budget_exhaustions: self.request_attempt_budget_exhaustions,
            pool_exhaustion_fast_fails: self.pool_exhaustion_fast_fails,
            server_burst_fast_fails: self.server_burst_fast_fails,
            rate_limited_responses: self.rate_limited_responses,
            server_errors: self.server_errors,
            network_errors: self.network_errors,
            user_aborts: self.user_aborts,
            auth_refresh_failures: self.auth_refresh_failures,
            empty_response_retries: self.empty_response_retries,
            account_rotations: self.account_rotations,
            same_account_retries: self.same_account_retries,
            stream_failover_attempts: self.stream_failover_attempts,
            stream_failover_candidates_considered: self.stream_failover_candidates_considered,
            last_stream_failover_candidate_count: self.last_stream_failover_candidate_count,
            stream_failover_recoveries: self.stream_failover_recoveries,
            stream_failover_cross_account_recoveries: self
                .stream_failover_cross_account_recoveries,
            cumulative_latency_ms: self.cumulative_latency_ms,
            last_request_at: self.last_request_at,
            last_error: self.last_error.clone(),
            extra: serde_json::Map::new(),
        }
    }
}

// ===========================================================================
// PipelineConfig (loader-time resolution — spec 13 §4 steps 11–13)
// ===========================================================================

/// Config the loader resolved ONCE (per loader call in TS; per pipeline
/// construction here). Spec-04 fields (fetch timeout, cooldowns, skew,
/// invalidation cooldown, pid offset, scheduling) live on
/// [`RotationProxyState`] — this struct carries only the spec-13 extras.
#[derive(Debug, Clone)]
pub struct PipelineConfig {
    pub rate_limit_toast_debounce_ms: i64,
    pub retry_all_accounts_rate_limited: bool,
    pub retry_all_accounts_max_wait_ms: i64,
    pub retry_all_accounts_max_retries: i64,
    pub fallback_on_unsupported_codex_model: bool,
    pub fallback_to_gpt52_on_unsupported_gpt53: bool,
    pub unsupported_codex_fallback_chain: Option<FallbackChain>,
    pub toast_duration_ms: i64,
    pub failover_mode: FailoverMode,
    /// Effective max ≤ 1 (spec 13 gotcha 1).
    pub stream_failover_max: u32,
    pub stream_failover_soft_timeout_ms: i64,
    pub stream_failover_hard_timeout_ms: i64,
    /// conservative 2 / balanced 1 / aggressive 0.
    pub max_same_account_retries: u32,
    pub empty_response_max_retries: i64,
    pub empty_response_retry_delay_ms: i64,
    pub response_continuation_enabled: bool,
}

/// Resolve the pipeline config from plugin config + env (spec 13 §4 steps
/// 11–13). Also applies `configureRateLimitBackoff` — the module-level
/// backoff config the short-retry threshold getter reads (gotcha:
/// `getConfiguredRateLimitShortRetryThresholdMs` ≠ the config getter).
pub fn load_pipeline_config(plugin_config: &PluginConfig) -> PipelineConfig {
    configure_rate_limit_backoff(RateLimitBackoffOverrides {
        dedup_window_ms: Some(getters::get_rate_limit_dedup_window_ms(plugin_config)),
        state_reset_ms: Some(getters::get_rate_limit_state_reset_ms(plugin_config)),
        max_backoff_ms: Some(getters::get_rate_limit_max_backoff_ms(plugin_config)),
        short_retry_threshold_ms: Some(getters::get_rate_limit_short_retry_threshold_ms(
            plugin_config,
        )),
    });

    let stream_stall_timeout_ms = getters::get_stream_stall_timeout_ms(plugin_config);
    let failover_mode = parse_failover_mode(std::env::var("CODEX_AUTH_FAILOVER_MODE").ok().as_deref());
    let stream_failover_max = {
        let configured = parse_env_int(
            std::env::var("CODEX_AUTH_STREAM_FAILOVER_MAX").ok().as_deref(),
        )
        .unwrap_or_else(|| mode_lookup(&STREAM_FAILOVER_MAX_BY_MODE, failover_mode));
        // capStreamFailoverMax clamps to [0, 1] (MAX_STREAM_FAILOVERS = 1),
        // then Math.max(0, …) — spec 13 gotcha 1.
        cap_stream_failover_max(configured as f64)
    };
    let stream_failover_soft_timeout_ms = parse_env_int(
        std::env::var("CODEX_AUTH_STREAM_STALL_SOFT_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
    .unwrap_or_else(|| mode_lookup(&STREAM_FAILOVER_SOFT_TIMEOUT_BY_MODE, failover_mode))
    .max(1_000);
    let stream_failover_hard_timeout_ms = parse_env_int(
        std::env::var("CODEX_AUTH_STREAM_STALL_HARD_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
    .unwrap_or(stream_stall_timeout_ms as i64)
    .max(stream_failover_soft_timeout_ms);
    let max_same_account_retries = match failover_mode {
        FailoverMode::Conservative => 2,
        FailoverMode::Balanced => 1,
        FailoverMode::Aggressive => 0,
    };

    PipelineConfig {
        rate_limit_toast_debounce_ms: getters::get_rate_limit_toast_debounce_ms(plugin_config)
            as i64,
        retry_all_accounts_rate_limited: getters::get_retry_all_accounts_rate_limited(
            plugin_config,
        ),
        retry_all_accounts_max_wait_ms: getters::get_retry_all_accounts_max_wait_ms(plugin_config)
            as i64,
        retry_all_accounts_max_retries: getters::get_retry_all_accounts_max_retries(plugin_config)
            as i64,
        fallback_on_unsupported_codex_model: getters::get_fallback_on_unsupported_codex_model(
            plugin_config,
        ),
        fallback_to_gpt52_on_unsupported_gpt53:
            getters::get_fallback_to_gpt52_on_unsupported_gpt53(plugin_config),
        unsupported_codex_fallback_chain: Some(getters::get_unsupported_codex_fallback_chain(
            plugin_config,
        )),
        toast_duration_ms: getters::get_toast_duration_ms(plugin_config) as i64,
        failover_mode,
        stream_failover_max,
        stream_failover_soft_timeout_ms,
        stream_failover_hard_timeout_ms,
        max_same_account_retries,
        empty_response_max_retries: getters::get_empty_response_max_retries(plugin_config) as i64,
        empty_response_retry_delay_ms: getters::get_empty_response_retry_delay_ms(plugin_config)
            as i64,
        response_continuation_enabled: getters::get_response_continuation(plugin_config),
    }
}

// ===========================================================================
// ProxyPipeline
// ===========================================================================

/// Shared pipeline state — the union of the `index.ts` factory closure state
/// (spec 13 §3) and the proxy's `RotationProxyState` (spec 04). Cheap-clone
/// handle; every clone shares the same state.
#[derive(Clone)]
pub struct ProxyPipeline {
    inner: Arc<PipelineShared>,
}

struct PipelineShared {
    state: tokio::sync::Mutex<RotationProxyState>,
    config: PipelineConfig,
    metrics: StdMutex<RuntimeMetrics>,
    entitlement_cache: StdMutex<EntitlementCache>,
    capability_policy: StdMutex<CapabilityPolicyStore>,
    preemptive_scheduler: StdMutex<PreemptiveQuotaScheduler>,
    /// Per-request monotonic session-affinity write version (spec 13 §3).
    session_affinity_write_version: AtomicI64,
}

/// Outcome of a failover attempt shared between the pump closure and the
/// (possibly already finished) bookkeeping (same benign race as TS —
/// `successAccountForResponse` mutated by the failover fn during streaming).
#[derive(Debug, Clone)]
struct FailoverSuccess {
    index: i64,
    entitlement_key: String,
    cross_account: bool,
}

/// How the caller must finish the usage-ledger row for a `/responses` run.
enum RunCompletion {
    /// Record the row immediately (TS `finally` semantics).
    Record(RuntimeUsageRecordInput),
    /// STREAMING upstream success: the record is deferred to the
    /// client-forward stage (`forwarded ? success : stream_forward_failed`),
    /// which also owns the network-failure account cleanup on a forward
    /// stall (TS runtime-rotation-proxy.ts:1424-1450 onStreamError).
    DeferStream {
        success_completion: RuntimeUsageRecordInput,
        account_index: i64,
        family: ModelFamily,
        model: Option<String>,
        session_key: Option<String>,
    },
}

/// Deferred bookkeeping for a STREAMING `/responses` success handed to the
/// server's client-forward stage: on a mid-stream stall / upstream read
/// error / client write error the serving account gets recordFailure + a
/// network-error cooldown, session affinity is forgotten, and the ledger row
/// becomes failure/`stream_forward_failed`; on a clean forward the row is
/// the success completion (TS runtime-rotation-proxy.ts:1424-1450).
pub struct ResponsesStreamBookkeeping {
    pub recorder: RuntimeUsageRecorder,
    pub success_completion: RuntimeUsageRecordInput,
    pub account_index: i64,
    pub family: ModelFamily,
    pub model: Option<String>,
    pub session_key: Option<String>,
}

/// Result of [`ProxyPipeline::handle_responses_for_server`].
pub struct ResponsesOutcome {
    pub response: StreamResponse,
    /// `Some` only for a streaming upstream success — everything else was
    /// already recorded by the pipeline.
    pub deferred: Option<ResponsesStreamBookkeeping>,
}

impl ProxyPipeline {
    pub fn new(state: RotationProxyState, config: PipelineConfig) -> Self {
        let started_at = now_ms();
        Self {
            inner: Arc::new(PipelineShared {
                state: tokio::sync::Mutex::new(state),
                config,
                metrics: StdMutex::new(RuntimeMetrics::new(started_at)),
                entitlement_cache: StdMutex::new(EntitlementCache::new()),
                capability_policy: StdMutex::new(CapabilityPolicyStore::new()),
                preemptive_scheduler: StdMutex::new(PreemptiveQuotaScheduler::default()),
                session_affinity_write_version: AtomicI64::new(0),
            }),
        }
    }

    /// The proxy state (server surface reads status / thread goals here).
    pub async fn state(&self) -> tokio::sync::MutexGuard<'_, RotationProxyState> {
        self.inner.state.lock().await
    }

    pub fn config(&self) -> &PipelineConfig {
        &self.inner.config
    }

    /// Snapshot of the runtime metrics (codex-metrics / report surfaces).
    pub fn metrics_snapshot(&self) -> RuntimeMetricsSnapshot {
        self.lock_metrics().to_snapshot()
    }

    fn lock_metrics(&self) -> std::sync::MutexGuard<'_, RuntimeMetrics> {
        self.inner
            .metrics
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `syncRuntimeObservability(requestId)` — mirror metrics + cooldowns
    /// into the shared observability snapshot (spec 13 §3).
    fn sync_runtime_observability(&self, request_id: Option<&str>) {
        let now = now_ms();
        let pool_remaining = get_pool_exhaustion_cooldown_remaining(now);
        let burst_remaining = get_server_burst_cooldown_remaining(now);
        let metrics = self.lock_metrics().clone();
        let request_id = request_id.map(str::to_string);
        mutate_runtime_observability_snapshot(move |snapshot| {
            snapshot.current_request_id = request_id.clone();
            snapshot.pool_exhaustion_cooldown_until =
                (pool_remaining > 0).then_some(now + pool_remaining);
            snapshot.server_burst_cooldown_until =
                (burst_remaining > 0).then_some(now + burst_remaining);
            snapshot.responses_requests = metrics.responses_requests;
            snapshot.auth_refresh_requests = metrics.auth_refresh_requests;
            snapshot.diagnostic_probe_requests = metrics.diagnostic_probe_requests;
            snapshot.runtime_metrics = metrics.to_snapshot();
        });
    }

    fn forget_session(&self, affinity: &Option<Arc<StdMutex<SessionAffinityStore>>>, key: Option<&str>) {
        if let Some(store) = affinity {
            store
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .forget_session(key);
        }
    }

    /// Entry point for `/responses` requests from callers that consume the
    /// response themselves (tests, in-process clients). Records the
    /// usage-ledger row (source `runtime-proxy`, operation `responses`)
    /// exactly once — a deferred streaming-success row is recorded here
    /// because no separate forward stage exists for these callers.
    pub async fn handle_responses(
        &self,
        ctx: RequestContext,
        trace_id: Option<String>,
    ) -> StreamResponse {
        let outcome = self.handle_responses_for_server(ctx, trace_id).await;
        if let Some(deferred) = outcome.deferred {
            deferred.recorder.record(deferred.success_completion).await;
        }
        outcome.response
    }

    /// `/responses` entry point for the HTTP server: like
    /// [`Self::handle_responses`], but for a STREAMING upstream success the
    /// usage-ledger record and the network-failure account cleanup are
    /// DEFERRED to the caller's client-forward stage — the row is
    /// `forwarded ? success : failure/stream_forward_failed` and a
    /// mid-stream stall cools the serving account down and forgets session
    /// affinity (TS runtime-rotation-proxy.ts:1424-1450). Mirrors metrics
    /// into observability on exit (the TS `finally`).
    pub async fn handle_responses_for_server(
        &self,
        ctx: RequestContext,
        trace_id: Option<String>,
    ) -> ResponsesOutcome {
        let started_at = now_ms();
        {
            let mut metrics = self.lock_metrics();
            metrics.last_request_at = Some(started_at);
        }
        self.sync_runtime_observability(trace_id.as_deref());

        // Policy gate runs inside `run`; the recorder needs the decision's
        // project key, so `run` creates it and returns the completion.
        let (response, recorder, completion) = self.run(ctx, trace_id.as_deref()).await;
        let deferred = match completion {
            RunCompletion::Record(completion) => {
                recorder.record(completion).await;
                None
            }
            RunCompletion::DeferStream {
                success_completion,
                account_index,
                family,
                model,
                session_key,
            } => Some(ResponsesStreamBookkeeping {
                recorder,
                success_completion,
                account_index,
                family,
                model,
                session_key,
            }),
        };
        self.sync_runtime_observability(None);
        ResponsesOutcome { response, deferred }
    }

    /// The merged request state machine. Returns the response plus the
    /// usage recorder + completion (recorded by the caller — TS `finally`).
    async fn run(
        &self,
        mut ctx: RequestContext,
        trace_id: Option<&str>,
    ) -> (StreamResponse, RuntimeUsageRecorder, RunCompletion) {
        let config = &self.inner.config;

        // ------------------------------------------------------------------
        // §5.1 setup
        // ------------------------------------------------------------------
        let (shared_manager, upstream_base_url, fetch_client, affinity, env) = {
            let state = self.inner.state.lock().await;
            (
                state.active_account_manager.clone(),
                state.upstream_base_url.clone(),
                state.fetch_client.clone(),
                state.session_affinity_store.clone(),
                StateEnv {
                    fetch_timeout_ms: state.fetch_timeout_ms.max(0) as u64,
                    stream_stall_timeout_ms: state.stream_stall_timeout_ms,
                    token_refresh_skew_ms: state.token_refresh_skew_ms,
                    network_error_cooldown_ms: state.network_error_cooldown_ms,
                    server_error_cooldown_ms: state.server_error_cooldown_ms,
                    token_invalidation_cooldown_ms: state.token_invalidation_cooldown_ms,
                    min_rotation_interval_ms: state.min_rotation_interval_ms,
                    pid_offset_enabled: state.pid_offset_enabled,
                    max_runtime_account_attempts: state.max_runtime_account_attempts,
                    quota_remaining_percent_threshold: state.quota_remaining_percent_threshold,
                    routing_mutex_mode: state.routing_mutex_mode,
                    scheduling_strategy: state.scheduling_strategy,
                    forced_account_index: state.forced_account_index,
                },
            )
        };

        // Upstream URL: base (trailing slashes stripped) + upstream path.
        // `upstream_path` carries the incoming query string when present
        // (spec 04 "incoming query string preserved" — the server encodes it
        // into the path). Equivalent output to `rewriteUrlForCodex` for the
        // default base URL.
        let url = format!(
            "{}{}",
            upstream_base_url.trim_end_matches('/'),
            ctx.upstream_path
        );

        let is_streaming = ctx.stream;
        let mut model: Option<String> = ctx.model.clone();
        let mut model_family: ModelFamily = ctx.family;
        let mut quota_key = build_quota_key(model_family, model.as_deref());
        let session_key: Option<String> = ctx.session_key.clone();
        let session_affinity_version = self
            .inner
            .session_affinity_write_version
            .fetch_add(1, Ordering::SeqCst)
            + 1;

        // Parsed request body (`transformedBody` analogue). The proxy
        // surface forwards Codex-shaped bodies verbatim — the identity
        // transform (see module docs / deviations).
        let mut transformed_body: Option<Value> = serde_json::from_slice(&ctx.body).ok();

        // §5.1 step 7 — response continuation injection.
        if config.response_continuation_enabled
            && let Some(Value::Object(body)) = transformed_body.as_mut()
            && !body.contains_key("previous_response_id")
            && let Some(store) = affinity.as_ref()
        {
            let last_id = store
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get_last_response_id(session_key.as_deref(), now_ms());
            if let Some(last_id) = last_id {
                body.insert(
                    "previous_response_id".to_string(),
                    Value::String(last_id),
                );
                if let Ok(serialized) = serde_json::to_vec(&Value::Object(body.clone())) {
                    ctx.body = serialized;
                }
            }
        }
        if let Some(store) = affinity.as_ref() {
            store
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .prune(now_ms());
        }

        // ------------------------------------------------------------------
        // §5.2 runtime policy gate (FAIL-OPEN)
        // ------------------------------------------------------------------
        let policy_decision: Option<RuntimePolicyDecision> = {
            let accounts: Vec<RuntimePolicyAccount> = {
                let mut manager = shared_manager.lock().await;
                manager
                    .get_accounts_snapshot()
                    .iter()
                    .map(|account| RuntimePolicyAccount {
                        index: account.index as i64,
                        account_id: account.meta.account_id.clone(),
                        email: account.meta.email.clone(),
                    })
                    .collect()
            };
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let state = load_runtime_policy_state(&cwd).await;
            // `capability_policy` lives behind a std mutex that must NOT be
            // held across `evaluate_runtime_policy`'s internal await
            // (`evaluate_budgets` file IO). The store's only contribution
            // there is the capability-unsupported blocking rule
            // (quota-forecast-01), which runs strictly AFTER that await —
            // so evaluate with `None` and apply the identical rule
            // synchronously on the returned decision.
            match evaluate_runtime_policy(EvaluateRuntimePolicyInput {
                state: &state,
                accounts: &accounts,
                model: model.as_deref(),
                capability_policy: None,
                now: None,
            })
            .await
            {
                Ok(mut decision) => {
                    let capability = self
                        .inner
                        .capability_policy
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    for account in &accounts {
                        let capability_key =
                            resolve_entitlement_account_key(&EntitlementAccountRef {
                                account_id: account.account_id.clone(),
                                email: account.email.clone(),
                                refresh_token: None,
                                index: Some(account.index),
                            });
                        if let Some(snapshot) = capability.get_snapshot(
                            &capability_key,
                            model.as_deref().unwrap_or("unknown"),
                        ) && snapshot.unsupported > 0
                        {
                            decision.blocked_account_indexes.insert(account.index);
                        }
                    }
                    Some(decision)
                }
                Err(error) => {
                    let data = serde_json::json!({ "error": error.to_string() });
                    log_warn("Runtime policy evaluation failed open.", Some(&data));
                    None
                }
            }
        };

        let recorder = create_runtime_usage_recorder(RuntimeUsageRecorderOptions {
            source: UsageLedgerSource::RuntimeProxy,
            operation: UsageLedgerOperation::Responses,
            model: model.clone(),
            project_key: policy_decision
                .as_ref()
                .and_then(|decision| decision.project_key.clone()),
            request_id: trace_id.map(str::to_string),
            started_at: Some(now_ms()),
            append: None,
        });
        // Default completion (spec 13 §5.2).
        let failure_completion = |status: Option<i64>, code: &str| {
            RunCompletion::Record(RuntimeUsageRecordInput {
                outcome: Some(UsageLedgerOutcome::Failure),
                status_code: status,
                error_code: Some(code.to_string()),
                ..Default::default()
            })
        };

        if let Some(decision) = policy_decision.as_ref().filter(|decision| !decision.allowed) {
            {
                let mut metrics = self.lock_metrics();
                metrics.failed_requests += 1;
                metrics.last_error = Some("Runtime policy blocked request".to_string());
            }
            let code = decision
                .error_code
                .clone()
                .unwrap_or_else(|| "policy_blocked".to_string());
            let body = serde_json::to_string(&serde_json::json!({
                "error": {
                    "message": "Runtime policy blocked this local request.",
                    "code": code,
                    "reasons": decision.reasons,
                }
            }))
            .unwrap_or_default();
            let completion = RunCompletion::Record(RuntimeUsageRecordInput {
                outcome: Some(UsageLedgerOutcome::Blocked),
                status_code: Some(decision.status_code as i64),
                error_code: Some(code),
                ..Default::default()
            });
            return (
                StreamResponse::from_text(
                    decision.status_code,
                    "",
                    synthetic_json_headers(),
                    body,
                ),
                recorder,
                completion,
            );
        }

        // ------------------------------------------------------------------
        // §5.3 fast-fail cooldowns
        // ------------------------------------------------------------------
        let now = now_ms();
        let pool_remaining = get_pool_exhaustion_cooldown_remaining(now);
        if pool_remaining > 0 {
            {
                let mut metrics = self.lock_metrics();
                metrics.failed_requests += 1;
                metrics.pool_exhaustion_fast_fails += 1;
                metrics.last_error = Some("Pool exhaustion cooldown active".to_string());
            }
            let body = error_message_body(&retry_loop::pool_exhaustion_cooldown_message(
                &format_wait_time(pool_remaining),
            ));
            return (
                StreamResponse::from_text(429, "", synthetic_json_headers(), body),
                recorder,
                failure_completion(Some(429), "pool_exhaustion_cooldown"),
            );
        }
        let burst_remaining = get_server_burst_cooldown_remaining(now);
        if burst_remaining > 0 {
            {
                let mut metrics = self.lock_metrics();
                metrics.failed_requests += 1;
                metrics.server_burst_fast_fails += 1;
                metrics.last_error = Some("Server burst cooldown active".to_string());
            }
            let body = error_message_body(&retry_loop::server_burst_cooldown_message(
                &format_wait_time(burst_remaining),
            ));
            return (
                StreamResponse::from_text(503, "", synthetic_json_headers(), body),
                recorder,
                failure_completion(Some(503), "server_burst_cooldown"),
            );
        }

        // ------------------------------------------------------------------
        // §5.4 outbound attempt budget (cap 6)
        // ------------------------------------------------------------------
        let mut account_count = { shared_manager.lock().await.get_account_count() };
        let budget_value = compute_outbound_request_attempt_budget(
            OutboundRequestAttemptBudgetParams {
                account_count: account_count as f64,
                max_same_account_retries: config.max_same_account_retries as f64,
                empty_response_max_retries: config.empty_response_max_retries as f64,
                stream_failover_max: config.stream_failover_max as f64,
            },
        );
        let budget = Arc::new(OutboundAttemptBudget::new(budget_value));
        {
            let mut metrics = self.lock_metrics();
            // `??=` — only the first request records the budget (gotcha 15).
            metrics
                .outbound_request_attempt_budget
                .get_or_insert(budget_value as i64);
        }

        // Transient attempt budget (spec 04): default 4.
        let transient_attempt_limit = env
            .max_runtime_account_attempts
            .min(account_count.max(1) as i64)
            .max(1);

        // Pin/affinity meta (spec 04 per-request read).
        let (pinned_index, is_pinned) = {
            let mut state = self.inner.state.lock().await;
            let meta = cma_runtime::rotation::storage_meta::read_storage_meta_from_disk(None);
            if meta.affinity_generation > state.last_observed_affinity_generation {
                if let Some(store) = state.session_affinity_store.as_ref() {
                    store
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .clear_all();
                }
                state.last_observed_affinity_generation = meta.affinity_generation;
            }
            let pinned = env.forced_account_index.or(meta.pinned_account_index);
            (pinned, env.forced_account_index.or(meta.pinned_account_index).is_some())
        };

        // Counters OUTSIDE the outer loop (gotcha 7).
        let mut counters = RetryCounters::default();
        let mut attempted_unsupported_fallback_models: Vec<String> = Vec::new();
        if let Some(model) = model.as_deref() {
            attempted_unsupported_fallback_models.push(model.to_string());
        }

        // ------------------------------------------------------------------
        // §5.5 outer loop — model-fallback restarts
        // ------------------------------------------------------------------
        'outer: loop {
            let mut attempted: HashSet<i64> = HashSet::new();
            let mut skip_reasons: HashMap<i64, String> = HashMap::new();
            let mut restart_with_fallback = false;
            let mut retry_next_account_before_fallback = false;
            let mut transient_attempts: i64 = 0;
            let mut exhaustion_reason = ExhaustionReason::NoAccount;
            let mut transient_exhaustion_reason: Option<ExhaustionReason> = None;
            let mut reloaded_after_no_account = false;

            // Capability + policy score boosts (merged additively). The
            // sticky min-rotation boost is NOT folded in here: TS recomputes
            // it on EVERY iteration of the account-attempt while-loop
            // (runtime-rotation-proxy.ts:956-961), re-reading
            // lastGlobalAccountIndex/lastGlobalSwitchAt, so attempts that
            // span the min-rotation window (429 short-retry sleeps,
            // stream-failover waits) or race a concurrent request drop or
            // retarget the boost mid-request.
            let base_score_boost_by_account: HashMap<i64, f64> = {
                let mut manager = shared_manager.lock().await;
                let snapshot = manager.get_accounts_snapshot();
                let capability = self
                    .inner
                    .capability_policy
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                let now = now_ms();
                let mut boosts: HashMap<i64, f64> = snapshot
                    .iter()
                    .map(|account| {
                        let key = entitlement_key_for(account);
                        let boost_model = model
                            .clone()
                            .unwrap_or_else(|| model_family.as_str().to_string());
                        (
                            account.index as i64,
                            capability.get_boost(&key, &boost_model, now),
                        )
                    })
                    .collect();
                if let Some(decision) = policy_decision.as_ref() {
                    for (index, boost) in &decision.score_boost_by_account {
                        *boosts.entry(*index).or_insert(0.0) += *boost;
                    }
                }
                boosts
            };

            // --------------------------------------------------------------
            // §5.5.1 account attempt loop
            // --------------------------------------------------------------
            'account: while attempted.len() < account_count.max(1)
                && transient_attempts < transient_attempt_limit
            {
                // Sticky min-rotation boost (spec 04 rotation loop step 1) —
                // recomputed PER ATTEMPT into a fresh clone of the base map
                // (never += into a persistent map: that would stack +1000 per
                // attempt).
                let score_boost_by_account: HashMap<i64, f64> = {
                    let state = self.inner.state.lock().await;
                    merge_sticky_min_rotation_boost(
                        &base_score_boost_by_account,
                        env.min_rotation_interval_ms,
                        state.last_global_account_index,
                        state.last_global_switch_at,
                        now_ms(),
                    )
                };

                // Selection (pin > sequential > affinity > hybrid).
                let selected: Option<ManagedAccount> = {
                    let mut manager = shared_manager.lock().await;
                    // Block-scope the std MutexGuard so the async Send
                    // analysis sees it released before the await below
                    // (an explicit `drop()` is not enough for the generator
                    // Send check; the guard type is !Send).
                    let candidate = {
                        let mut affinity_guard = affinity
                            .as_ref()
                            .map(|store| store.lock().unwrap_or_else(|poison| poison.into_inner()));
                        choose_account(ChooseAccountParams {
                            account_manager: &mut manager,
                            session_affinity_store: affinity_guard.as_deref_mut(),
                            session_key: session_key.as_deref(),
                            family: model_family,
                            model: model.as_deref(),
                            attempted_indexes: &attempted,
                            now: now_ms(),
                            policy: policy_decision.as_ref(),
                            pinned_index,
                            skip_reasons: Some(&mut skip_reasons),
                            sticky_boost_by_account: Some(&score_boost_by_account),
                            pid_offset_enabled: env.pid_offset_enabled,
                            scheduling_strategy: env.scheduling_strategy,
                        })
                    };
                    // Enabled-mutex cursor commit inside the same lock scope
                    // (spec 04 gotcha 7): skip when pinned or sequential.
                    if let Some(candidate) = candidate.as_ref()
                        && env.routing_mutex_mode == RoutingMutexMode::Enabled
                        && pinned_index.is_none()
                        && env.scheduling_strategy != SchedulingStrategy::Sequential
                    {
                        manager
                            .mark_switched_locked(
                                candidate.index as i64,
                                SwitchReason::Rotation,
                                model_family,
                                None,
                            )
                            .await;
                    }
                    candidate
                };

                let Some(account) = selected else {
                    // One-shot stale-state recovery (issue #606; spec 04
                    // step 3).
                    let policy_blocked_empty = policy_decision
                        .as_ref()
                        .map(|decision| decision.blocked_account_indexes.is_empty())
                        .unwrap_or(true);
                    let has_policy_skip = skip_reasons
                        .values()
                        .any(|reason| reason == "policy-blocked");
                    if !reloaded_after_no_account
                        && !is_pinned
                        && account_count > 0
                        && exhaustion_reason == ExhaustionReason::NoAccount
                        && policy_blocked_empty
                        && !has_policy_skip
                    {
                        reloaded_after_no_account = true;
                        let recovered = {
                            let mut state = self.inner.state.lock().await;
                            recover_stale_runtime_state(&mut state).await
                        };
                        if let Some(_reloaded) = recovered {
                            account_count =
                                shared_manager.lock().await.get_account_count();
                            skip_reasons.clear();
                            attempted.clear();
                            continue 'account;
                        }
                    }
                    break 'account;
                };

                let account_index = account.index as i64;
                if attempted.contains(&account_index) {
                    break 'account;
                }
                attempted.insert(account_index);
                if policy_decision
                    .as_ref()
                    .is_some_and(|decision| decision.blocked_account_indexes.contains(&account_index))
                {
                    continue 'account;
                }

                // ------------------------------------------------------
                // Token refresh (spec 13 order: refresh BEFORE bucket).
                // ------------------------------------------------------
                let needs_refresh = {
                    let access_empty = account
                        .meta
                        .access_token
                        .as_deref()
                        .unwrap_or("")
                        .trim()
                        .is_empty();
                    let expires = account.meta.expires_at.unwrap_or(0);
                    access_empty
                        || expires <= now_ms() + env.token_refresh_skew_ms.max(0)
                };
                if needs_refresh {
                    self.lock_metrics().auth_refresh_requests += 1;
                }
                let fresh = ensure_fresh_access_token(EnsureFreshAccessTokenParams {
                    account_manager: &shared_manager,
                    account: &account,
                    family: model_family,
                    model: model.as_deref(),
                    now: now_ms(),
                    token_refresh_skew_ms: env.token_refresh_skew_ms,
                    token_invalidation_cooldown_ms: env.token_invalidation_cooldown_ms,
                })
                .await;
                let (access_token, mut account) = match fresh {
                    EnsureFreshAccessTokenResult::Ok {
                        access_token,
                        account,
                    } => (access_token, account),
                    EnsureFreshAccessTokenResult::Failed {
                        retryable,
                        invalidated,
                    } => {
                        {
                            let mut metrics = self.lock_metrics();
                            metrics.auth_refresh_failures += 1;
                            metrics.failed_requests += 1;
                            metrics.account_rotations += 1;
                            metrics.last_error =
                                Some("Failed to refresh token, authentication required".to_string());
                        }
                        self.forget_session(&affinity, session_key.as_deref());
                        exhaustion_reason = ExhaustionReason::AuthFailure;
                        if invalidated {
                            // Token invalidation: STOP the cascade (spec 04
                            // gotcha 10) — no rotation, 401 token_invalidated.
                            let body = build_token_invalidation_body("");
                            return (
                                StreamResponse::from_text(
                                    401,
                                    "",
                                    synthetic_json_headers(),
                                    body,
                                ),
                                recorder,
                                failure_completion(Some(401), "token_invalidated"),
                            );
                        }
                        if retryable {
                            self.lock_metrics().network_errors += 1;
                            transient_attempts += 1;
                            transient_exhaustion_reason = Some(ExhaustionReason::AuthFailure);
                            let mut state = self.inner.state.lock().await;
                            state.status.retries += 1;
                            state.status.rotations += 1;
                            continue 'account;
                        }
                        // Non-retryable: auth-failure removal policy
                        // (spec 13 §5.5.1 — union seam).
                        let failures = {
                            let manager = shared_manager.lock().await;
                            manager
                                .get_account_by_index(account_index)
                                .and_then(|account| account.runtime.consecutive_auth_failures)
                                .unwrap_or(0)
                        };
                        let policy = evaluate_failure_policy(
                            &FailurePolicyInput {
                                kind: Some(FailureKind::AuthRefresh),
                                consecutive_auth_failures: Some(failures as f64),
                                max_auth_failures_before_removal: None,
                                server_retry_after_ms: None,
                                failover_mode: Some(config.failover_mode),
                            },
                            None,
                        );
                        if policy.remove_account {
                            let label = {
                                let mut manager = shared_manager.lock().await;
                                let label = format_account_label(
                                    manager
                                        .get_account_by_index(account_index)
                                        .map(|account| account as &dyn AccountLabelSource),
                                    account_index as usize,
                                );
                                if let Some(store) = affinity.as_ref() {
                                    let mut store = store
                                        .lock()
                                        .unwrap_or_else(|poison| poison.into_inner());
                                    store.forget_account(account_index);
                                    manager.remove_account_by_index(account_index);
                                    store.reindex_after_removal(account_index);
                                } else {
                                    manager.remove_account_by_index(account_index);
                                }
                                label
                            };
                            account_count =
                                shared_manager.lock().await.get_account_count();
                            shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                            show_runtime_toast(
                                &retry_loop::auth_failure_removal_toast(&label, failures),
                                ToastVariant::Error,
                            );
                            continue 'account;
                        }
                        if let (Some(cooldown_ms), Some(reason)) =
                            (policy.cooldown_ms, policy.cooldown_reason)
                        {
                            let mut manager = shared_manager.lock().await;
                            manager.mark_account_cooling_down(
                                account_index,
                                cooldown_ms,
                                reason,
                            );
                            drop(manager);
                            shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                        }
                        continue 'account;
                    }
                };

                // ------------------------------------------------------
                // Identity resolution (spec 13 §5.5.1).
                // ------------------------------------------------------
                let current_workspace = account.get_current_workspace().cloned();
                let stored_account_id = current_workspace
                    .as_ref()
                    .map(|workspace| workspace.id.clone())
                    .or_else(|| account.meta.account_id.clone());
                let stored_source = if current_workspace.is_some() {
                    Some(cma_core::schemas::account_storage::AccountIdSource::Manual)
                } else {
                    account.meta.account_id_source
                };
                let identity = resolve_runtime_request_identity(
                    ResolveRuntimeRequestIdentityInput {
                        stored_account_id: stored_account_id.as_deref(),
                        source: stored_source,
                        stored_email: account.meta.email.as_deref(),
                        access_token: Some(access_token.as_str()),
                        id_token: None,
                    },
                );
                let Some(resolved_account_id) =
                    identity.account_id.clone().filter(|id| !id.trim().is_empty())
                else {
                    {
                        let mut manager = shared_manager.lock().await;
                        manager.refund_token(account_index, model_family, model.as_deref());
                        manager.record_failure(account_index, model_family, model.as_deref());
                        manager.mark_account_cooling_down(
                            account_index,
                            ACCOUNT_LIMITS.auth_failure_cooldown_ms,
                            CooldownReason::AuthFailure,
                        );
                    }
                    shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                    exhaustion_reason = ExhaustionReason::AuthFailure;
                    transient_attempts += 1;
                    continue 'account;
                };
                let entitlement_key = resolve_entitlement_account_key(&EntitlementAccountRef {
                    account_id: Some(
                        stored_account_id
                            .clone()
                            .unwrap_or_else(|| resolved_account_id.clone()),
                    ),
                    email: identity.email.clone(),
                    refresh_token: Some(account.meta.refresh_token.clone()),
                    index: Some(account_index),
                });
                let capability_model_key = model
                    .clone()
                    .unwrap_or_else(|| model_family.as_str().to_string());

                // Entitlement cached block (spec 13 §5.5.1).
                let block = {
                    let mut cache = self
                        .inner
                        .entitlement_cache
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    cache.is_blocked(&entitlement_key, &capability_model_key, now_ms())
                };
                if block.blocked {
                    {
                        let mut metrics = self.lock_metrics();
                        metrics.account_rotations += 1;
                        metrics.last_error = Some(format!(
                            "Entitlement cached block for account {}",
                            account_index + 1
                        ));
                    }
                    let data = serde_json::json!({
                        "accountIndex": account_index,
                        "waitTime": format_wait_time(block.wait_ms),
                    });
                    log_warn("Entitlement cached block; rotating.", Some(&data));
                    continue 'account;
                }

                // Identity write-back (NOT persisted here — hitchhikes on
                // later debounced saves, spec 13 §5.5.1).
                {
                    let mut manager = shared_manager.lock().await;
                    if let Some(live) = manager.get_account_by_index_mut(account_index) {
                        let had_account_id = live
                            .meta
                            .account_id
                            .as_deref()
                            .is_some_and(|id| !id.trim().is_empty());
                        live.meta.account_id = Some(resolved_account_id.clone());
                        if !had_account_id
                            && identity
                                .token_account_id
                                .as_deref()
                                .is_some_and(|token_id| token_id == resolved_account_id)
                        {
                            live.meta.account_id_source = stored_source.or(Some(
                                cma_core::schemas::account_storage::AccountIdSource::Token,
                            ));
                        }
                        if let Some(email) = identity.email.clone() {
                            live.meta.email = Some(email);
                        }
                    }
                }
                // Mirror the write-back onto the local clone: TS mutates the
                // LIVE account object (`account.accountId = accountId`,
                // index.ts:1467-1478), so later reads through `account` —
                // e.g. the 429 backoff stable key
                // (`account.accountId ?? account.email ?? null`) — always
                // see the resolved id even when the stored metadata had none.
                {
                    let had_account_id = account
                        .meta
                        .account_id
                        .as_deref()
                        .is_some_and(|id| !id.trim().is_empty());
                    account.meta.account_id = Some(resolved_account_id.clone());
                    if !had_account_id
                        && identity
                            .token_account_id
                            .as_deref()
                            .is_some_and(|token_id| token_id == resolved_account_id)
                    {
                        account.meta.account_id_source = stored_source.or(Some(
                            cma_core::schemas::account_storage::AccountIdSource::Token,
                        ));
                    }
                    if let Some(email) = identity.email.clone() {
                        account.meta.email = Some(email);
                    }
                }

                // Account toast (spec 13 §5.5.1).
                if account_count > 1 {
                    let mut manager = shared_manager.lock().await;
                    if manager.should_show_account_toast(
                        account_index,
                        Some(config.rate_limit_toast_debounce_ms),
                    ) {
                        let label = format_account_label(
                            manager
                                .get_account_by_index(account_index)
                                .map(|account| account as &dyn AccountLabelSource),
                            account_index as usize,
                        );
                        manager.mark_toast_shown(account_index);
                        drop(manager);
                        show_runtime_toast(
                            &format!(
                                "Using {label} ({}/{account_count})",
                                account_index + 1
                            ),
                            ToastVariant::Info,
                        );
                    }
                }

                // Outbound headers (spec 04 step 9 — HTTP-surface
                // authoritative: scrub + auth + originator).
                let headers = build_outbound_headers(
                    &ctx.headers,
                    &access_token,
                    &resolved_account_id,
                );

                // Record identity into proxy status (spec 04 step 8).
                {
                    let mut state = self.inner.state.lock().await;
                    state.status.last_account_index = Some(account_index);
                    state.status.last_account_label =
                        Some(format!("Account {}", account_index + 1));
                    state.status.last_account_id = Some(resolved_account_id.clone());
                    state.status.last_account_updated_at = Some(now_ms());
                }

                // Preemptive quota deferral (spec 13 §5.5.1).
                let quota_schedule_key =
                    format!("{entitlement_key}:{capability_model_key}");
                let deferral = {
                    let mut scheduler = self
                        .inner
                        .preemptive_scheduler
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    scheduler.get_deferral(&quota_schedule_key, now_ms())
                };
                if deferral.defer && deferral.wait_ms > 0 {
                    {
                        let mut manager = shared_manager.lock().await;
                        manager.mark_rate_limited_with_reason(
                            account_index,
                            deferral.wait_ms,
                            model_family,
                            RateLimitReason::Quota,
                            model.as_deref(),
                        );
                        manager.record_rate_limit(
                            account_index,
                            model_family,
                            model.as_deref(),
                        );
                    }
                    {
                        let mut metrics = self.lock_metrics();
                        metrics.account_rotations += 1;
                        metrics.last_error = Some(format!(
                            "Preemptive quota deferral for account {}",
                            account_index + 1
                        ));
                    }
                    shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                    exhaustion_reason = ExhaustionReason::RateLimit;
                    continue 'account;
                }

                // Local token bucket (per-process, NEVER persisted —
                // gotcha 6 / spec 04 gotcha 1).
                let consumed = {
                    let mut manager = shared_manager.lock().await;
                    manager.consume_token(account_index, model_family, model.as_deref())
                };
                if !consumed {
                    {
                        let mut manager = shared_manager.lock().await;
                        manager.record_rate_limit(
                            account_index,
                            model_family,
                            model.as_deref(),
                        );
                    }
                    {
                        let mut metrics = self.lock_metrics();
                        metrics.account_rotations += 1;
                        metrics.last_error = Some(format!(
                            "Local token bucket depleted for account {} ({quota_key})",
                            account_index + 1
                        ));
                    }
                    log_warn("Local token bucket depleted.", None);
                    skip_reasons.insert(account_index, "token-exhausted".to_string());
                    exhaustion_reason = ExhaustionReason::RateLimit;
                    continue 'account;
                }

                // ------------------------------------------------------
                // §5.5.2 inner same-account retry loop
                // ------------------------------------------------------
                let mut same_account_retry_count: u32 = 0;
                let mut short_rate_limit_retry_count: u32 = 0;

                'inner: loop {
                    // Budget consume ("primary").
                    if !budget.try_consume() {
                        let last_error = budget.exhausted_last_error();
                        {
                            let mut metrics = self.lock_metrics();
                            metrics.request_attempt_budget_exhaustions += 1;
                            metrics.last_error = Some(last_error.clone());
                        }
                        log_warn("Request attempt budget exhausted.", None);
                        let body = error_message_body(
                            &retry_loop::budget_exhausted_response_message(Some(
                                &last_error,
                            )),
                        );
                        return (
                            StreamResponse::from_text(
                                503,
                                "",
                                synthetic_json_headers(),
                                body,
                            ),
                            recorder,
                            failure_completion(Some(503), "plugin_host_request_failed"),
                        );
                    }
                    self.lock_metrics().outbound_request_attempts_consumed += 1;

                    {
                        let mut metrics = self.lock_metrics();
                        metrics.total_requests += 1;
                        metrics.responses_requests += 1;
                    }
                    {
                        let mut state = self.inner.state.lock().await;
                        state.status.upstream_requests += 1;
                    }
                    self.sync_runtime_observability(trace_id);

                    let fetch_start = std::time::Instant::now();
                    let fetch_result = tokio::time::timeout(
                        std::time::Duration::from_millis(env.fetch_timeout_ms),
                        fetch_client
                            .post(&url)
                            .headers(headers.clone())
                            .body(ctx.body.clone())
                            .send(),
                    )
                    .await;

                    let upstream = match fetch_result {
                        Ok(Ok(response)) => response,
                        Ok(Err(error)) => {
                            match self
                                .handle_network_failure(
                                    &shared_manager,
                                    &affinity,
                                    account_index,
                                    model_family,
                                    model.as_deref(),
                                    session_key.as_deref(),
                                    &entitlement_key,
                                    &capability_model_key,
                                    error.to_string(),
                                    same_account_retry_count,
                                    &env,
                                )
                                .await
                            {
                                NetworkFailureNext::RetrySameAccount => {
                                    same_account_retry_count += 1;
                                    continue 'inner;
                                }
                                NetworkFailureNext::NextAccount => {
                                    exhaustion_reason = ExhaustionReason::NetworkError;
                                    transient_attempts += 1;
                                    transient_exhaustion_reason =
                                        Some(ExhaustionReason::NetworkError);
                                    let mut state = self.inner.state.lock().await;
                                    state.status.retries += 1;
                                    state.status.rotations += 1;
                                    drop(state);
                                    break 'inner;
                                }
                            }
                        }
                        Err(_elapsed) => {
                            // Timeout-triggered abort is a network failure
                            // (frozen message — spec 13 gotcha 20).
                            match self
                                .handle_network_failure(
                                    &shared_manager,
                                    &affinity,
                                    account_index,
                                    model_family,
                                    model.as_deref(),
                                    session_key.as_deref(),
                                    &entitlement_key,
                                    &capability_model_key,
                                    "Request timeout".to_string(),
                                    same_account_retry_count,
                                    &env,
                                )
                                .await
                            {
                                NetworkFailureNext::RetrySameAccount => {
                                    same_account_retry_count += 1;
                                    continue 'inner;
                                }
                                NetworkFailureNext::NextAccount => {
                                    exhaustion_reason = ExhaustionReason::NetworkError;
                                    transient_attempts += 1;
                                    transient_exhaustion_reason =
                                        Some(ExhaustionReason::NetworkError);
                                    let mut state = self.inner.state.lock().await;
                                    state.status.retries += 1;
                                    state.status.rotations += 1;
                                    drop(state);
                                    break 'inner;
                                }
                            }
                        }
                    };

                    let fetch_latency_ms = fetch_start.elapsed().as_millis() as i64;
                    let response = stream_response_from_reqwest(upstream);
                    let response_headers = response.headers.clone();
                    let status = response.status;

                    // Quota scheduler snapshot (ok AND error responses).
                    if let Some(snapshot) =
                        read_quota_scheduler_snapshot(&response_headers, status, now_ms())
                    {
                        let mut scheduler = self
                            .inner
                            .preemptive_scheduler
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        scheduler.update(&quota_schedule_key, snapshot);
                    }

                    if !response.ok() {
                        // ----------------------------------------------
                        // §5.5.3 error precedence ladder
                        // ----------------------------------------------
                        // 1. Context overflow.
                        let outcome =
                            handle_context_overflow(response, model.as_deref()).await;
                        let response = match outcome {
                            cma_request::context_overflow::ContextOverflowOutcome::Handled {
                                response,
                            } => {
                                // TS returns early WITHOUT updating
                                // usageCompletion, so the finally block
                                // records the initialized default row:
                                // failure / plugin_host_request_failed /
                                // statusCode null (looks like a TS oversight,
                                // but the ledger shape must match — change
                                // both sides together if this is ever fixed).
                                return (
                                    response,
                                    recorder,
                                    failure_completion(
                                        None,
                                        "plugin_host_request_failed",
                                    ),
                                );
                            }
                            cma_request::context_overflow::ContextOverflowOutcome::NotHandled {
                                response,
                            } => response,
                        };

                        // Raw upstream body (pre-normalization) for the
                        // token-invalidation vector: spec 04 feeds
                        // `readErrorBody` output (NOT the normalized payload
                        // with the login hint appended) to
                        // `isTokenInvalidationError` and
                        // `buildTokenInvalidationBody`. Capture it BEFORE
                        // `handle_error_response` consumes the body, then
                        // rebuild the response for the ladder.
                        let mut response = response;
                        let raw_error_body_text =
                            response.collect_text().await.unwrap_or_default();
                        let response = StreamResponse::from_text(
                            response.status,
                            response.status_text.clone(),
                            response.headers.clone(),
                            raw_error_body_text.clone(),
                        );

                        // 2. handleErrorResponse.
                        let error_result = handle_error_response(
                            response,
                            Some(&ErrorHandlingOptions {
                                request_correlation_id: trace_id.map(str::to_string),
                                thread_id: session_key.clone(),
                            }),
                        )
                        .await;
                        let error_body_value = error_result
                            .error_body
                            .clone()
                            .unwrap_or(Value::Null);
                        // The ladder keys off the REMAPPED status
                        // (mapUsageLimit404WithBody rewrites structured 404
                        // usage-limit bodies to 429 and 404 entitlement
                        // bodies to 403): TS reads `errorResponse.status` in
                        // the workspace-disabled, 403-entitlement, 429 and
                        // step-10 catch-all predicates. The RAW `status`
                        // stays in place everywhere TS also reads
                        // `response.status` (quota-scheduler snapshot, 5xx
                        // check, lastError, failure completion) and for the
                        // 401 vector (the remap never produces 401).
                        let mapped_status = error_result.response.status;

                        // 3. Unsupported model traversal + fallback chains.
                        let info = get_unsupported_codex_model_info(&error_body_value);
                        let has_remaining_accounts =
                            attempted.len() < account_count.max(1);
                        let plan = plan_unsupported_model(&UnsupportedModelContext {
                            info: &info,
                            error_body: &error_body_value,
                            model: model.as_deref(),
                            has_remaining_accounts,
                            fallback_on_unsupported_codex_model: config
                                .fallback_on_unsupported_codex_model,
                            fallback_to_gpt52_on_unsupported_gpt53: config
                                .fallback_to_gpt52_on_unsupported_gpt53,
                            custom_chain: config.unsupported_codex_fallback_chain.as_ref(),
                            attempted_models: &attempted_unsupported_fallback_models,
                        });
                        match plan {
                            UnsupportedModelPlan::NotUnsupported => {}
                            UnsupportedModelPlan::TryOtherAccountsFirst { blocked_model } => {
                                self.mark_unsupported(
                                    &entitlement_key,
                                    &blocked_model,
                                );
                                {
                                    let mut manager = shared_manager.lock().await;
                                    manager.refund_token(
                                        account_index,
                                        model_family,
                                        model.as_deref(),
                                    );
                                    manager.record_failure(
                                        account_index,
                                        model_family,
                                        model.as_deref(),
                                    );
                                    if let Some(live) =
                                        manager.get_account_by_index_mut(account_index)
                                    {
                                        live.meta.last_switch_reason =
                                            Some(SwitchReason::Rotation);
                                    }
                                }
                                self.record_capability_failure(
                                    &entitlement_key,
                                    &capability_model_key,
                                );
                                self.forget_session(&affinity, session_key.as_deref());
                                self.lock_metrics().last_error =
                                    Some(model_fallback::unsupported_rotation_last_error(
                                        account_index + 1,
                                        &blocked_model,
                                    ));
                                let data = serde_json::json!({
                                    "requestedModel": model,
                                    "fallbackApplied": false,
                                    "fallbackReason": "unsupported-model-entitlement",
                                });
                                log_warn(
                                    "Unsupported model on account; trying other accounts first.",
                                    Some(&data),
                                );
                                retry_next_account_before_fallback = true;
                                break 'inner;
                            }
                            UnsupportedModelPlan::Fallback {
                                previous_model,
                                fallback_model,
                                ..
                            } => {
                                if !attempted_unsupported_fallback_models
                                    .contains(&previous_model)
                                {
                                    attempted_unsupported_fallback_models
                                        .push(previous_model.clone());
                                }
                                if !attempted_unsupported_fallback_models
                                    .contains(&fallback_model)
                                {
                                    attempted_unsupported_fallback_models
                                        .push(fallback_model.clone());
                                }
                                self.mark_unsupported(&entitlement_key, &previous_model);
                                let previous_family = model
                                    .as_deref()
                                    .map(get_model_family)
                                    .unwrap_or(model_family);
                                {
                                    let mut manager = shared_manager.lock().await;
                                    manager.refund_token(
                                        account_index,
                                        previous_family,
                                        model.as_deref(),
                                    );
                                }
                                // Swap model/family/quota keys + rebuild body
                                // (gotchas 10–11).
                                let (rebuilt, serialized) = rebuild_body_with_model(
                                    transformed_body.as_ref(),
                                    &ctx.body,
                                    &fallback_model,
                                );
                                transformed_body = Some(rebuilt);
                                ctx.body = serialized.into_bytes();
                                model = Some(fallback_model.clone());
                                model_family = get_model_family(&fallback_model);
                                quota_key =
                                    build_quota_key(model_family, model.as_deref());
                                self.lock_metrics().last_error =
                                    Some(model_fallback::fallback_last_error(
                                        &previous_model,
                                        &fallback_model,
                                    ));
                                log_warn("Applying model fallback.", None);
                                show_runtime_toast(
                                    &model_fallback::fallback_toast_message(
                                        &previous_model,
                                        &fallback_model,
                                    ),
                                    ToastVariant::Warning,
                                );
                                restart_with_fallback = true;
                                break 'inner;
                            }
                            UnsupportedModelPlan::StrictBlock { blocked_model } => {
                                self.mark_unsupported(&entitlement_key, &blocked_model);
                                self.lock_metrics().last_error = Some(
                                    model_fallback::strict_block_last_error(&blocked_model),
                                );
                                show_runtime_toast(
                                    &model_fallback::strict_block_toast_message(
                                        &blocked_model,
                                    ),
                                    ToastVariant::Warning,
                                );
                                // FALLS THROUGH to the generic return below.
                            }
                            UnsupportedModelPlan::BookkeepOnly { blocked_model } => {
                                self.mark_unsupported(&entitlement_key, &blocked_model);
                            }
                        }

                        // 4. Workspace disabled (spec 13 §5.5.3 step 4).
                        let error_code_value = error_body_value
                            .pointer("/error/code")
                            .cloned()
                            .unwrap_or(Value::String(String::new()));
                        let error_message_text = error_body_value
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if !info.is_unsupported
                            && is_workspace_disabled_error(
                                mapped_status,
                                &error_code_value,
                                &error_message_text,
                            )
                        {
                            {
                                let mut metrics = self.lock_metrics();
                                metrics.failed_requests += 1;
                                metrics.last_error = Some(format!(
                                    "Workspace disabled for account {}",
                                    account_index + 1
                                ));
                            }
                            let has_workspaces = account
                                .meta
                                .workspaces
                                .as_ref()
                                .is_some_and(|workspaces| !workspaces.is_empty());
                            if !has_workspaces {
                                log_warn(
                                    "Workspace disabled but account tracks no workspaces. Leaving account enabled.",
                                    None,
                                );
                                if attempted.len() < account_count.max(1) {
                                    continue 'account;
                                }
                                return (
                                    error_result.response.into_stream_response(),
                                    recorder,
                                    failure_completion(
                                        Some(status as i64),
                                        "plugin_host_request_failed",
                                    ),
                                );
                            }
                            // Disable current workspace + rotate.
                            let rotated = {
                                let mut manager = shared_manager.lock().await;
                                if let Some(live) =
                                    manager.get_account_by_index_mut(account_index)
                                {
                                    let current_id = current_workspace
                                        .as_ref()
                                        .map(|workspace| workspace.id.clone());
                                    live.disable_current_workspace(current_id.as_deref());
                                    live.rotate_to_next_workspace().map(|workspace| {
                                        workspace
                                            .name
                                            .clone()
                                            .unwrap_or_else(|| workspace.id.clone())
                                    })
                                } else {
                                    None
                                }
                            };
                            shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                            if let Some(next_name) = rotated {
                                let old_name = current_workspace
                                    .as_ref()
                                    .and_then(|workspace| workspace.name.clone())
                                    .unwrap_or_else(|| "workspace".to_string());
                                show_runtime_toast(
                                    &format!(
                                        "Workspace {old_name} disabled. Switched to {next_name}."
                                    ),
                                    ToastVariant::Warning,
                                );
                                log_info("Workspace rotated after disable.", None);
                                // Same account becomes selectable again
                                // (gotcha 8).
                                attempted.remove(&account_index);
                                continue 'account;
                            }
                            {
                                let mut manager = shared_manager.lock().await;
                                manager.set_account_enabled(account_index, false);
                            }
                            shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                            show_runtime_toast(
                                &format!(
                                    "All workspaces disabled for account {}. Switching to another account.",
                                    account_index + 1
                                ),
                                ToastVariant::Warning,
                            );
                            self.forget_session(&affinity, session_key.as_deref());
                            exhaustion_reason = ExhaustionReason::Deactivated;
                            continue 'account;
                        }

                        // 5. 403 (not unsupported, not workspace):
                        // plan-entitlement block. Mapped status: a
                        // 404-entitlement body remapped to 403 must cache the
                        // block exactly like a raw 403 (TS index.ts:2114).
                        if mapped_status == 403 && !info.is_unsupported {
                            {
                                let mut cache = self
                                    .inner
                                    .entitlement_cache
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner());
                                cache.mark_blocked(
                                    &entitlement_key,
                                    &capability_model_key,
                                    EntitlementBlockReason::PlanEntitlement,
                                    None,
                                    now_ms(),
                                );
                            }
                            self.record_capability_failure(
                                &entitlement_key,
                                &capability_model_key,
                            );
                        }

                        // 7. 5xx rotation (spec 13 §5.5.3 step 7 ∪ spec 04).
                        if (500..=599).contains(&status) {
                            let data = serde_json::json!({
                                "status": status,
                                "accountIndex": account_index,
                            });
                            log_warn("Server error; rotating to next account.", Some(&data));
                            {
                                let mut metrics = self.lock_metrics();
                                metrics.failed_requests += 1;
                                metrics.server_errors += 1;
                                metrics.account_rotations += 1;
                                metrics.last_error = Some(format!("HTTP {status}"));
                            }
                            let server_retry_after_ms =
                                parse_retry_after_hint_ms(&response_headers);
                            let policy = evaluate_failure_policy(
                                &FailurePolicyInput {
                                    kind: Some(FailureKind::Server),
                                    consecutive_auth_failures: None,
                                    max_auth_failures_before_removal: None,
                                    server_retry_after_ms: server_retry_after_ms
                                        .map(|ms| ms as f64),
                                    failover_mode: Some(config.failover_mode),
                                },
                                Some(&FailurePolicyOverrides {
                                    network_cooldown_ms: None,
                                    server_cooldown_ms: Some(
                                        env.server_error_cooldown_ms as f64,
                                    ),
                                }),
                            );
                            let armed_until =
                                record_server_burst_failure(account_index as usize, now_ms());
                            if armed_until > 0 {
                                self.lock_metrics().last_error = Some(
                                    "Repeated upstream server errors across the account pool"
                                        .to_string(),
                                );
                            }
                            if matches!(status, 502 | 503 | 529)
                                && let Some(cooldown_ms) = policy.cooldown_ms
                            {
                                let mut scheduler = self
                                    .inner
                                    .preemptive_scheduler
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner());
                                scheduler.mark_rate_limited(
                                    &quota_schedule_key,
                                    cooldown_ms as f64,
                                    now_ms(),
                                );
                            }
                            {
                                let mut manager = shared_manager.lock().await;
                                if policy.refund_token {
                                    manager.refund_token(
                                        account_index,
                                        model_family,
                                        model.as_deref(),
                                    );
                                }
                                if policy.record_failure {
                                    manager.record_failure(
                                        account_index,
                                        model_family,
                                        model.as_deref(),
                                    );
                                }
                            }
                            if policy.record_failure {
                                self.record_capability_failure(
                                    &entitlement_key,
                                    &capability_model_key,
                                );
                            }
                            if policy.retry_same_account
                                && same_account_retry_count < config.max_same_account_retries
                            {
                                same_account_retry_count += 1;
                                self.lock_metrics().same_account_retries += 1;
                                let delay =
                                    policy.retry_delay_ms.unwrap_or(500).max(MIN_BACKOFF_MS);
                                let _ = abortable_sleep(
                                    add_jitter(delay as f64, 0.2) as u64,
                                    None,
                                )
                                .await;
                                continue 'inner;
                            }
                            if let (Some(cooldown_ms), Some(reason)) =
                                (policy.cooldown_ms, policy.cooldown_reason)
                            {
                                let mut manager = shared_manager.lock().await;
                                manager.mark_account_cooling_down(
                                    account_index,
                                    cooldown_ms,
                                    reason,
                                );
                                drop(manager);
                                shared_manager
                                    .save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                            }
                            self.forget_session(&affinity, session_key.as_deref());
                            exhaustion_reason = ExhaustionReason::ServerError;
                            transient_attempts += 1;
                            transient_exhaustion_reason =
                                Some(ExhaustionReason::ServerError);
                            {
                                let mut state = self.inner.state.lock().await;
                                state.status.retries += 1;
                                state.status.rotations += 1;
                            }
                            break 'inner;
                        }

                        // 8. 429 with rate-limit metadata (MARK-BEFORE-SLEEP).
                        // Mapped status: upstream reports quota exhaustion as
                        // a structured 404 on this endpoint, which
                        // handle_error_response remaps to 429 — that response
                        // MUST take the rate-limit path (mark + rotate), not
                        // the generic return (TS index.ts:2241).
                        if mapped_status == 429 && let Some(rate_limit) = error_result.rate_limit.as_ref() {
                            self.lock_metrics().rate_limited_responses += 1;
                            let retry_after_ms = if rate_limit.retry_after_ms > 0 {
                                rate_limit.retry_after_ms
                            } else {
                                60_000
                            };
                            let stable_key = account
                                .meta
                                .account_id
                                .clone()
                                .or_else(|| account.meta.email.clone());
                            let backoff = get_rate_limit_backoff(
                                account_index as usize,
                                &quota_key,
                                Some(retry_after_ms as f64),
                                stable_key.as_deref(),
                            );
                            let cooldown_ms = backoff.delay_ms.max(retry_after_ms);
                            {
                                let mut scheduler = self
                                    .inner
                                    .preemptive_scheduler
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner());
                                scheduler.mark_rate_limited(
                                    &quota_schedule_key,
                                    cooldown_ms as f64,
                                    now_ms(),
                                );
                            }
                            let threshold =
                                configured_rate_limit_short_retry_threshold_ms();
                            let reason =
                                parse_rate_limit_reason(rate_limit.code.as_deref());
                            match decide_rate_limit_429(
                                cooldown_ms,
                                threshold,
                                short_rate_limit_retry_count,
                            ) {
                                RateLimit429Decision::ShortRetry => {
                                    short_rate_limit_retry_count += 1;
                                    // MARK BEFORE SLEEP (AUDIT-H3 / D-07,
                                    // gotcha 5) + debounced save so a crash
                                    // mid-sleep cannot lose the cooldown.
                                    {
                                        let mut manager = shared_manager.lock().await;
                                        manager.mark_rate_limited_with_reason(
                                            account_index,
                                            cooldown_ms,
                                            model_family,
                                            reason,
                                            model.as_deref(),
                                        );
                                        manager.record_rate_limit(
                                            account_index,
                                            model_family,
                                            model.as_deref(),
                                        );
                                    }
                                    shared_manager
                                        .save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                                    // Per-account 30s debounce gate (TS
                                    // index.ts:2292-2305): at most one
                                    // rate-limit toast per account per
                                    // debounce window.
                                    {
                                        let mut manager = shared_manager.lock().await;
                                        if manager.should_show_account_toast(
                                            account_index,
                                            Some(config.rate_limit_toast_debounce_ms),
                                        ) {
                                            manager.mark_toast_shown(account_index);
                                            drop(manager);
                                            show_runtime_toast(
                                                &retry_loop::short_retry_toast(
                                                    &format_wait_time(cooldown_ms),
                                                    short_rate_limit_retry_count,
                                                ),
                                                ToastVariant::Warning,
                                            );
                                        }
                                    }
                                    let _ = abortable_sleep(
                                        add_jitter(
                                            cooldown_ms.max(MIN_BACKOFF_MS) as f64,
                                            0.2,
                                        ) as u64,
                                        None,
                                    )
                                    .await;
                                    continue 'inner;
                                }
                                RateLimit429Decision::Rotate => {
                                    {
                                        let mut manager = shared_manager.lock().await;
                                        manager.mark_rate_limited_with_reason(
                                            account_index,
                                            cooldown_ms,
                                            model_family,
                                            reason,
                                            model.as_deref(),
                                        );
                                        manager.record_rate_limit(
                                            account_index,
                                            model_family,
                                            model.as_deref(),
                                        );
                                        if let Some(live) =
                                            manager.get_account_by_index_mut(account_index)
                                        {
                                            live.meta.last_switch_reason =
                                                Some(SwitchReason::RateLimit);
                                        }
                                    }
                                    self.forget_session(
                                        &affinity,
                                        session_key.as_deref(),
                                    );
                                    self.lock_metrics().account_rotations += 1;
                                    shared_manager
                                        .save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                                    log_warn("Rate limited. Rotating account.", None);
                                    // Count check ANDs with the per-account
                                    // debounce gate (TS index.ts:2338-2352).
                                    if account_count > 1 {
                                        let mut manager = shared_manager.lock().await;
                                        if manager.should_show_account_toast(
                                            account_index,
                                            Some(config.rate_limit_toast_debounce_ms),
                                        ) {
                                            manager.mark_toast_shown(account_index);
                                            drop(manager);
                                            show_runtime_toast(
                                                &retry_loop::rate_limit_rotation_toast(
                                                    &format_wait_time(cooldown_ms),
                                                ),
                                                ToastVariant::Warning,
                                            );
                                        }
                                    }
                                    // 429 does NOT refund the token (spec 04
                                    // gotcha 17).
                                    exhaustion_reason = ExhaustionReason::RateLimit;
                                    transient_attempts += 1;
                                    transient_exhaustion_reason =
                                        Some(ExhaustionReason::RateLimit);
                                    {
                                        let mut state = self.inner.state.lock().await;
                                        state.status.retries += 1;
                                        state.status.rotations += 1;
                                    }
                                    break 'inner;
                                }
                            }
                        }

                        // 9. 401 — token invalidation (spec 04, union
                        // insert): no-rotate + 300 s cooldown.
                        if status == 401 {
                            {
                                let mut manager = shared_manager.lock().await;
                                manager.refund_token(
                                    account_index,
                                    model_family,
                                    model.as_deref(),
                                );
                                manager.record_failure(
                                    account_index,
                                    model_family,
                                    model.as_deref(),
                                );
                            }
                            if is_token_invalidation_error(&raw_error_body_text) {
                                {
                                    let mut manager = shared_manager.lock().await;
                                    apply_monotonic_auth_cooldown(
                                        &mut manager,
                                        &account,
                                        env.token_invalidation_cooldown_ms,
                                    );
                                }
                                self.forget_session(&affinity, session_key.as_deref());
                                shared_manager
                                    .save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                                self.lock_metrics().failed_requests += 1;
                                let body = build_token_invalidation_body(&raw_error_body_text);
                                // TS builds the reply from
                                // responseHeadersForClient(upstream.headers)
                                // (scrubbed diagnostics like x-request-id
                                // survive) and sets content-type to exactly
                                // "application/json" (no charset) — mirror
                                // server.rs's upstream-401 path.
                                let mut client_headers = HeaderMap::new();
                                for (name, value) in
                                    cma_request::stream_failover_runtime::response_headers_for_client(
                                        &response_headers,
                                    )
                                {
                                    if name == "content-type" {
                                        continue;
                                    }
                                    if let (Ok(header_name), Ok(header_value)) = (
                                        name.parse::<http::header::HeaderName>(),
                                        http::header::HeaderValue::from_str(&value),
                                    ) {
                                        client_headers.append(header_name, header_value);
                                    }
                                }
                                client_headers.insert(
                                    http::header::CONTENT_TYPE,
                                    http::header::HeaderValue::from_static(
                                        "application/json",
                                    ),
                                );
                                return (
                                    StreamResponse::from_text(
                                        401,
                                        "",
                                        client_headers,
                                        body,
                                    ),
                                    recorder,
                                    failure_completion(Some(401), "token_invalidated"),
                                );
                            }
                            {
                                let mut manager = shared_manager.lock().await;
                                apply_monotonic_auth_cooldown(
                                    &mut manager,
                                    &account,
                                    DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
                                );
                            }
                            shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                            self.lock_metrics().failed_requests += 1;
                            exhaustion_reason = ExhaustionReason::AuthFailure;
                            transient_attempts += 1;
                            transient_exhaustion_reason =
                                Some(ExhaustionReason::AuthFailure);
                            {
                                let mut state = self.inner.state.lock().await;
                                state.status.retries += 1;
                                state.status.rotations += 1;
                            }
                            break 'inner;
                        }

                        // 10. Everything else → return the sanitized error
                        // response. `mapped_status != 403` — TS keys the
                        // catch-all guard off errorResponse.status
                        // (index.ts:2358), so a mapped 403 never records a
                        // capability failure here.
                        if error_result.rate_limit.is_none()
                            && !info.is_unsupported
                            && mapped_status != 403
                        {
                            self.record_capability_failure(
                                &entitlement_key,
                                &capability_model_key,
                            );
                        }
                        {
                            let mut metrics = self.lock_metrics();
                            metrics.failed_requests += 1;
                            metrics.last_error = Some(format!("HTTP {status}"));
                        }
                        return (
                            error_result.response.into_stream_response(),
                            recorder,
                            failure_completion(
                                Some(status as i64),
                                "plugin_host_request_failed",
                            ),
                        );
                    }

                    // --------------------------------------------------
                    // §5.5.4 success path
                    // --------------------------------------------------
                    // TS resetRateLimitBackoff(idx, quotaKey) — no stable
                    // account key (parity with the 2-arg TS call).
                    reset_rate_limit_backoff(account_index as usize, &quota_key, None);
                    self.lock_metrics().cumulative_latency_ms += fetch_latency_ms;

                    let failover_success: Arc<StdMutex<Option<FailoverSuccess>>> =
                        Arc::new(StdMutex::new(None));
                    let response_for_success = if is_streaming
                        && config.stream_failover_max > 0
                    {
                        let candidate_order = {
                            let mut manager = shared_manager.lock().await;
                            let snapshot: Vec<AdaptiveFailoverAccount> = manager
                                .get_accounts_snapshot()
                                .iter()
                                .map(|account| AdaptiveFailoverAccount {
                                    index: account.index,
                                    last_used: Some(account.meta.last_used),
                                    enabled: account.meta.enabled,
                                    cooling_down_until: account.meta.cooling_down_until,
                                    rate_limit_reset_times: account
                                        .rate_limit_reset_times
                                        .clone(),
                                })
                                .collect();
                            build_adaptive_stream_failover_candidate_order(
                                account_index as usize,
                                &snapshot,
                                now_ms(),
                            )
                        };
                        {
                            let mut metrics = self.lock_metrics();
                            metrics.last_stream_failover_candidate_count =
                                candidate_order.len() as i64;
                            metrics.stream_failover_candidates_considered +=
                                candidate_order.len() as i64;
                        }
                        let failover_ctx = FailoverCtx {
                            pipeline: self.clone(),
                            shared_manager: shared_manager.clone(),
                            candidates: candidate_order
                                .into_iter()
                                .map(|index| index as i64)
                                .collect(),
                            primary_index: account_index,
                            family: model_family,
                            model: model.clone(),
                            quota_key: quota_key.clone(),
                            quota_schedule_key_base: model
                                .clone()
                                .unwrap_or_else(|| model_family.as_str().to_string()),
                            client_headers: ctx.headers.clone(),
                            body: ctx.body.clone(),
                            url: url.clone(),
                            budget: budget.clone(),
                            fetch_client: fetch_client.clone(),
                            env: env.clone(),
                            success: failover_success.clone(),
                            affinity: affinity.clone(),
                            session_key: session_key.clone(),
                            session_affinity_version,
                            response_continuation_enabled: config
                                .response_continuation_enabled,
                        };
                        with_streaming_failover(
                            response,
                            move |attempt, emitted_bytes| {
                                let ctx = failover_ctx.clone();
                                async move {
                                    failover_attempt(ctx, attempt, emitted_bytes).await
                                }
                            },
                            StreamFailoverOptions {
                                max_failovers: Some(config.stream_failover_max as f64),
                                stall_timeout_ms: None,
                                soft_timeout_ms: Some(
                                    config.stream_failover_soft_timeout_ms as f64,
                                ),
                                hard_timeout_ms: Some(
                                    config.stream_failover_hard_timeout_ms as f64,
                                ),
                                request_instance_id: trace_id.map(str::to_string),
                            },
                        )
                    } else {
                        response
                    };

                    // Response-id capture → session affinity writes.
                    let stored_response_id = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    let on_response_id: Option<
                        cma_request::response_handler::ResponseIdCallback,
                    > = if config.response_continuation_enabled {
                        let affinity = affinity.clone();
                        let session_key = session_key.clone();
                        let stored_flag = stored_response_id.clone();
                        let success_state = failover_success.clone();
                        let primary_index = account_index;
                        let version = session_affinity_version;
                        Some(Arc::new(move |response_id: &str| {
                            let index = success_state
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner())
                                .as_ref()
                                .map(|success| success.index)
                                .unwrap_or(primary_index);
                            if let Some(store) = affinity.as_ref() {
                                let mut store = store
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner());
                                let now = now_ms();
                                store.remember_with_version(
                                    session_key.as_deref(),
                                    index,
                                    now,
                                    Some(version),
                                );
                                store.update_last_response_id(
                                    session_key.as_deref(),
                                    Some(response_id),
                                    now,
                                    Some(version),
                                );
                            }
                            stored_flag.store(true, Ordering::SeqCst);
                        }))
                    } else {
                        None
                    };

                    let success_response = match handle_success_response(
                        response_for_success,
                        is_streaming,
                        ConvertSseOptions {
                            on_response_id,
                            stream_stall_timeout_ms: Some(env.stream_stall_timeout_ms as f64),
                        },
                    )
                    .await
                    {
                        Ok(response) => response,
                        Err(error) => {
                            // Body-less upstream success — treat like a
                            // network failure on this account.
                            match self
                                .handle_network_failure(
                                    &shared_manager,
                                    &affinity,
                                    account_index,
                                    model_family,
                                    model.as_deref(),
                                    session_key.as_deref(),
                                    &entitlement_key,
                                    &capability_model_key,
                                    error.to_string(),
                                    same_account_retry_count,
                                    &env,
                                )
                                .await
                            {
                                NetworkFailureNext::RetrySameAccount => {
                                    same_account_retry_count += 1;
                                    continue 'inner;
                                }
                                NetworkFailureNext::NextAccount => {
                                    exhaustion_reason = ExhaustionReason::NetworkError;
                                    transient_attempts += 1;
                                    break 'inner;
                                }
                            }
                        }
                    };

                    // Empty-response retry (non-streaming only).
                    let mut success_response = success_response;
                    if !is_streaming && config.empty_response_max_retries > 0 {
                        let bytes = success_response.collect_bytes().await.unwrap_or_default();
                        // TS parity: `bodyText ? JSON.parse(bodyText) : null`
                        // runs inside a try/catch — an EMPTY body is empty,
                        // but a non-empty body that fails to parse THROWS and
                        // is swallowed, i.e. it is NOT an empty response.
                        let empty = if bytes.is_empty() {
                            true
                        } else {
                            match serde_json::from_slice::<Value>(&bytes) {
                                Ok(parsed) => is_empty_response(Some(&parsed)),
                                Err(_) => false,
                            }
                        };
                        // Rebuild the (buffered) response either way —
                        // clone-before-return semantics (gotcha 21).
                        let rebuilt = StreamResponse::from_bytes(
                            success_response.status,
                            success_response.status_text.clone(),
                            success_response.headers.clone(),
                            bytes.clone().into(),
                        );
                        if empty {
                            if counters.empty_response_retries
                                < config.empty_response_max_retries
                            {
                                counters.empty_response_retries += 1;
                                self.lock_metrics().empty_response_retries += 1;
                                log_warn("Empty response. Retrying.", None);
                                show_runtime_toast(
                                    &retry_loop::empty_response_retry_toast(
                                        counters.empty_response_retries,
                                        config.empty_response_max_retries,
                                    ),
                                    ToastVariant::Warning,
                                );
                                {
                                    let mut manager = shared_manager.lock().await;
                                    manager.refund_token(
                                        account_index,
                                        model_family,
                                        model.as_deref(),
                                    );
                                    manager.record_failure(
                                        account_index,
                                        model_family,
                                        model.as_deref(),
                                    );
                                }
                                self.record_capability_failure(
                                    &entitlement_key,
                                    &capability_model_key,
                                );
                                let policy = evaluate_failure_policy(
                                    &FailurePolicyInput {
                                        kind: Some(FailureKind::EmptyResponse),
                                        consecutive_auth_failures: None,
                                        max_auth_failures_before_removal: None,
                                        server_retry_after_ms: None,
                                        failover_mode: Some(config.failover_mode),
                                    },
                                    None,
                                );
                                match retry_loop::decide_empty_response_retry(
                                    policy.retry_same_account,
                                    policy.retry_delay_ms,
                                    same_account_retry_count,
                                    config.max_same_account_retries,
                                    config.empty_response_retry_delay_ms,
                                ) {
                                    retry_loop::EmptyResponseRetryAction::SameAccount {
                                        delay_ms,
                                    } => {
                                        same_account_retry_count += 1;
                                        self.lock_metrics().same_account_retries += 1;
                                        if delay_ms > 0 {
                                            let _ = abortable_sleep(
                                                add_jitter(delay_ms as f64, 0.2) as u64,
                                                None,
                                            )
                                            .await;
                                        }
                                        continue 'inner;
                                    }
                                    retry_loop::EmptyResponseRetryAction::NextAccount => {
                                        self.forget_session(
                                            &affinity,
                                            session_key.as_deref(),
                                        );
                                        let _ = abortable_sleep(
                                            add_jitter(
                                                config.empty_response_retry_delay_ms as f64,
                                                0.2,
                                            )
                                                as u64,
                                            None,
                                        )
                                        .await;
                                        break 'inner;
                                    }
                                }
                            }
                            // Retries exhausted.
                            if success_response.status >= 500 {
                                let armed =
                                    record_server_burst_failure(account_index as usize, now_ms());
                                if armed > 0 {
                                    {
                                        let mut metrics = self.lock_metrics();
                                        metrics.server_burst_fast_fails += 1;
                                        metrics.last_error = Some(
                                            "Repeated upstream server errors across the account pool"
                                                .to_string(),
                                        );
                                    }
                                    // Wait label computed at response-build
                                    // time (gotcha 22).
                                    let wait =
                                        get_server_burst_cooldown_remaining(now_ms());
                                    let body = error_message_body(
                                        &retry_loop::empty_response_server_burst_message(
                                            &format_wait_time(wait),
                                        ),
                                    );
                                    return (
                                        StreamResponse::from_text(
                                            503,
                                            "",
                                            synthetic_json_headers(),
                                            body,
                                        ),
                                        recorder,
                                        failure_completion(
                                            Some(503),
                                            "server_burst_cooldown",
                                        ),
                                    );
                                }
                            }
                            log_warn("Empty response after retries. Returning as-is.", None);
                        }
                        success_response = rebuilt;
                    }

                    // Final bookkeeping (spec 13 §5.5.4 step 5 ∪ spec 04
                    // success mapping).
                    let success = failover_success
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .clone();
                    let (success_index, success_key, cross_account) = match success {
                        Some(success) => (
                            success.index,
                            success.entitlement_key,
                            success.cross_account,
                        ),
                        None => (account_index, entitlement_key.clone(), false),
                    };
                    if cross_account {
                        let mut manager = shared_manager.lock().await;
                        manager.mark_switched(
                            success_index,
                            SwitchReason::Rotation,
                            model_family,
                        );
                    }
                    // record_success — the "healed" seam schedules the
                    // debounced save (SharedAccountManager::record_success).
                    shared_manager
                        .record_success(success_index, model_family, model.as_deref())
                        .await;
                    {
                        let mut capability = self
                            .inner
                            .capability_policy
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        capability.record_success(
                            &success_key,
                            &capability_model_key,
                            now_ms(),
                        );
                    }
                    {
                        let mut cache = self
                            .inner
                            .entitlement_cache
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        cache.clear(&success_key, Some(&capability_model_key));
                    }
                    record_runtime_account_recovery(success_index);

                    // Near-exhaustion preemptive rate limit (spec 04 success
                    // mapping) — else affinity remember + sticky window.
                    let near_exhaustion_wait = get_quota_near_exhaustion_wait_ms(
                        &response_headers,
                        env.quota_remaining_percent_threshold,
                        now_ms(),
                    );
                    if near_exhaustion_wait > 0 {
                        {
                            let mut manager = shared_manager.lock().await;
                            manager.mark_rate_limited_with_reason(
                                success_index,
                                near_exhaustion_wait,
                                model_family,
                                RateLimitReason::Quota,
                                model.as_deref(),
                            );
                        }
                        self.forget_session(&affinity, session_key.as_deref());
                        shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                    } else {
                        // Session-affinity remember rule (gotcha 14).
                        if (!config.response_continuation_enabled
                            || (!is_streaming
                                && !stored_response_id.load(Ordering::SeqCst)))
                            && let Some(store) = affinity.as_ref()
                        {
                            store
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner())
                                .remember_with_version(
                                    session_key.as_deref(),
                                    success_index,
                                    now_ms(),
                                    Some(session_affinity_version),
                                );
                        }
                        let mut state = self.inner.state.lock().await;
                        state.last_global_account_index = Some(success_index);
                        state.last_global_switch_at = now_ms();
                    }

                    // persistRuntimeActiveAccount (spec 04 step 12): pinned
                    // requests never commit/persist/sync (#474); enabled
                    // mode already committed under the mutex; sequential
                    // never advances the drain-first primary (#509).
                    if !(is_pinned && Some(success_index) == pinned_index) {
                        if env.routing_mutex_mode != RoutingMutexMode::Enabled
                            && env.scheduling_strategy != SchedulingStrategy::Sequential
                        {
                            let mut manager = shared_manager.lock().await;
                            manager
                                .mark_switched_locked(
                                    success_index,
                                    SwitchReason::Rotation,
                                    model_family,
                                    None,
                                )
                                .await;
                        }
                        shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                        let sync_manager = shared_manager.clone();
                        tokio::spawn(async move {
                            let manager = sync_manager.lock().await;
                            manager
                                .sync_codex_cli_active_selection_for_index(success_index)
                                .await;
                        });
                    }

                    {
                        let mut metrics = self.lock_metrics();
                        metrics.successful_requests += 1;
                        metrics.last_error = None;
                    }
                    clear_pool_exhaustion_cooldown();
                    clear_server_burst_cooldown();
                    self.sync_runtime_observability(trace_id);

                    let (final_account_id, final_email) = {
                        let manager = shared_manager.lock().await;
                        manager
                            .get_account_by_index(success_index)
                            .map(|account| {
                                (
                                    account.meta.account_id.clone(),
                                    account.meta.email.clone(),
                                )
                            })
                            .unwrap_or((None, None))
                    };
                    let completion = RuntimeUsageRecordInput {
                        outcome: Some(UsageLedgerOutcome::Success),
                        status_code: Some(success_response.status as i64),
                        error_code: None,
                        account: Some(RuntimePolicyAccount {
                            index: success_index,
                            account_id: final_account_id,
                            email: final_email,
                        }),
                        ..Default::default()
                    };
                    // Streaming: the ledger row is decided by the client
                    // forward (`forwarded ? success : stream_forward_failed`)
                    // and the forward stage owns the network-error cleanup —
                    // recording Success here would permanently say success
                    // for a mid-stream stall (TS records after
                    // forwardStreamingResponse resolves).
                    if is_streaming {
                        return (
                            success_response,
                            recorder,
                            RunCompletion::DeferStream {
                                success_completion: completion,
                                account_index: success_index,
                                family: model_family,
                                model: model.clone(),
                                session_key: session_key.clone(),
                            },
                        );
                    }
                    return (success_response, recorder, RunCompletion::Record(completion));
                } // 'inner

                if retry_next_account_before_fallback {
                    retry_next_account_before_fallback = false;
                    continue 'account;
                }
                if restart_with_fallback {
                    break 'account;
                }
            } // 'account

            if restart_with_fallback {
                continue 'outer;
            }

            // --------------------------------------------------------------
            // §5.5.5 pool exhausted (∪ spec 04 loop exit)
            // --------------------------------------------------------------
            if transient_attempts >= transient_attempt_limit
                && attempted.len() < account_count.max(1)
            {
                exhaustion_reason = ExhaustionReason::Budget;
            } else if exhaustion_reason == ExhaustionReason::Deactivated
                && let Some(transient) = transient_exhaustion_reason
            {
                exhaustion_reason = transient;
            }

            let wait_ms = {
                let mut manager = shared_manager.lock().await;
                manager.get_min_wait_time_for_family(model_family, model.as_deref())
            };

            // Pinned: hard-fail 503 (never falls through to rotation, #474).
            if is_pinned && let Some(pinned) = pinned_index {
                let pinned_reason = skip_reasons.get(&pinned).cloned();
                if pinned_reason.is_none() {
                    let mut state = self.inner.state.lock().await;
                    state.status.last_error = Some(format!(
                        "pinned-503 missing skip reason (pinnedIndex={pinned})"
                    ));
                }
                let skip_list: Vec<(usize, String)> = skip_reasons
                    .iter()
                    .filter(|(index, _)| **index >= 0)
                    .map(|(index, reason)| (*index as usize, reason.clone()))
                    .collect();
                let body = cma_request::rate_limit_decision::build_pinned_unavailable_error_body(
                    Some(pinned),
                    &skip_list,
                );
                let body_json = serde_json::to_string(&serde_json::json!({ "error": body }))
                    .unwrap_or_default();
                self.lock_metrics().failed_requests += 1;
                return (
                    StreamResponse::from_text(503, "", synthetic_json_headers(), body_json),
                    recorder,
                    failure_completion(Some(503), "codex_pinned_account_unavailable"),
                );
            }

            // Wait-and-retry when every account is rate-limited (spec 13).
            if config.retry_all_accounts_rate_limited
                && account_count > 0
                && wait_ms > 0
                && (config.retry_all_accounts_max_wait_ms == 0
                    || wait_ms <= config.retry_all_accounts_max_wait_ms)
                && counters.all_rate_limited_retries < config.retry_all_accounts_max_retries
            {
                let message = retry_loop::all_rate_limited_countdown_message(account_count);
                show_runtime_toast(&message, ToastVariant::Warning);
                let _ = abortable_sleep(add_jitter(wait_ms as f64, 0.2) as u64, None).await;
                counters.all_rate_limited_retries += 1;
                continue 'outer;
            }

            // Terminal exhaustion: arm the pool cooldown (spec 13) + emit
            // the spec-04 machine-readable body (HTTP-surface contract).
            let now = now_ms();
            let pool_cooldown_until = if account_count > 0 && wait_ms > 0 {
                arm_pool_exhaustion_cooldown(wait_ms as f64, now)
            } else {
                0
            };
            let effective_wait_ms = if pool_cooldown_until > 0 {
                (pool_cooldown_until - now).max(0)
            } else {
                wait_ms
            };
            let wait_label = if effective_wait_ms > 0 {
                format_wait_time(effective_wait_ms)
            } else {
                "a bit".to_string()
            };
            let message = retry_loop::terminal_pool_message(
                account_count,
                effective_wait_ms,
                &wait_label,
            );
            {
                let mut metrics = self.lock_metrics();
                metrics.failed_requests += 1;
                metrics.last_error = Some(message);
            }
            let skip_map: serde_json::Map<String, Value> = skip_reasons
                .iter()
                .map(|(index, reason)| (index.to_string(), Value::String(reason.clone())))
                .collect();
            record_runtime_pool_exhaustion(
                exhaustion_reason.as_str(),
                wait_ms,
                &skip_map,
            );
            let status = normalize_exhaustion_status(exhaustion_reason.as_str());
            let body = retry_loop::build_pool_exhausted_body(
                exhaustion_reason.as_str(),
                wait_ms,
                &skip_reasons,
                account_count,
            );
            return (
                StreamResponse::from_text(status, "", synthetic_json_headers(), body),
                recorder,
                failure_completion(
                    Some(status as i64),
                    "codex_runtime_rotation_pool_exhausted",
                ),
            );
        } // 'outer
    }

    fn mark_unsupported(&self, entitlement_key: &str, blocked_model: &str) {
        {
            let mut cache = self
                .inner
                .entitlement_cache
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            cache.mark_blocked(
                entitlement_key,
                blocked_model,
                EntitlementBlockReason::UnsupportedModel,
                None,
                now_ms(),
            );
        }
        let mut capability = self
            .inner
            .capability_policy
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        capability.record_unsupported(entitlement_key, blocked_model, now_ms());
    }

    fn record_capability_failure(&self, entitlement_key: &str, capability_model_key: &str) {
        let mut capability = self
            .inner
            .capability_policy
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        capability.record_failure(entitlement_key, capability_model_key, now_ms());
    }

    /// Network-error handling (spec 13 §5.5.2 step 4, non-abort branch).
    #[allow(clippy::too_many_arguments)]
    async fn handle_network_failure(
        &self,
        shared_manager: &SharedAccountManager,
        affinity: &Option<Arc<StdMutex<SessionAffinityStore>>>,
        account_index: i64,
        family: ModelFamily,
        model: Option<&str>,
        session_key: Option<&str>,
        entitlement_key: &str,
        capability_model_key: &str,
        message: String,
        same_account_retry_count: u32,
        env: &StateEnv,
    ) -> NetworkFailureNext {
        log_warn(
            &format!(
                "Network error for account {}: {message}",
                account_index + 1
            ),
            None,
        );
        {
            let mut metrics = self.lock_metrics();
            metrics.failed_requests += 1;
            metrics.network_errors += 1;
            metrics.account_rotations += 1;
            metrics.last_error = Some(message);
        }
        let policy = evaluate_failure_policy(
            &FailurePolicyInput {
                kind: Some(FailureKind::Network),
                consecutive_auth_failures: None,
                max_auth_failures_before_removal: None,
                server_retry_after_ms: None,
                failover_mode: Some(self.inner.config.failover_mode),
            },
            Some(&FailurePolicyOverrides {
                network_cooldown_ms: Some(env.network_error_cooldown_ms as f64),
                server_cooldown_ms: None,
            }),
        );
        {
            let mut manager = shared_manager.lock().await;
            if policy.refund_token {
                manager.refund_token(account_index, family, model);
            }
            if policy.record_failure {
                manager.record_failure(account_index, family, model);
            }
        }
        if policy.record_failure {
            self.record_capability_failure(entitlement_key, capability_model_key);
        }
        if policy.retry_same_account
            && same_account_retry_count < self.inner.config.max_same_account_retries
        {
            self.lock_metrics().same_account_retries += 1;
            let delay = policy.retry_delay_ms.unwrap_or(250).max(MIN_BACKOFF_MS);
            let _ = abortable_sleep(add_jitter(delay as f64, 0.2) as u64, None).await;
            return NetworkFailureNext::RetrySameAccount;
        }
        if let (Some(cooldown_ms), Some(reason)) = (policy.cooldown_ms, policy.cooldown_reason) {
            let mut manager = shared_manager.lock().await;
            manager.mark_account_cooling_down(account_index, cooldown_ms, reason);
            drop(manager);
            shared_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
        }
        self.forget_session(affinity, session_key);
        NetworkFailureNext::NextAccount
    }
}

enum NetworkFailureNext {
    RetrySameAccount,
    NextAccount,
}

/// Spec-04 fields resolved at proxy startup, snapshotted per request.
#[derive(Clone)]
struct StateEnv {
    fetch_timeout_ms: u64,
    stream_stall_timeout_ms: i64,
    token_refresh_skew_ms: i64,
    network_error_cooldown_ms: i64,
    server_error_cooldown_ms: i64,
    token_invalidation_cooldown_ms: i64,
    min_rotation_interval_ms: i64,
    pid_offset_enabled: bool,
    max_runtime_account_attempts: i64,
    quota_remaining_percent_threshold: f64,
    routing_mutex_mode: RoutingMutexMode,
    scheduling_strategy: SchedulingStrategy,
    forced_account_index: Option<i64>,
}

fn build_quota_key(family: ModelFamily, model: Option<&str>) -> String {
    match model {
        Some(model) => format!("{}:{model}", family.as_str()),
        None => family.as_str().to_string(),
    }
}

fn entitlement_key_for(account: &ManagedAccount) -> String {
    resolve_entitlement_account_key(&EntitlementAccountRef {
        account_id: account.meta.account_id.clone(),
        email: account.meta.email.clone(),
        refresh_token: Some(account.meta.refresh_token.clone()),
        index: Some(account.index as i64),
    })
}

/// Outbound header construction (spec 04 step 9 — the HTTP-surface
/// authoritative scrub): copy incoming, delete hop-by-hop + `host` +
/// `x-api-key` + `cookie` + `proxy-authorization`, set `authorization`,
/// `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`,
/// `originator: codex_cli_rs` (load-bearing — backend gates some models per
/// originator).
pub fn build_outbound_headers(
    incoming: &HeaderMap,
    access_token: &str,
    account_id: &str,
) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in incoming {
        let lower = name.as_str().to_ascii_lowercase();
        if cma_request::stream_failover_runtime::is_hop_by_hop_header(&lower)
            || matches!(
                lower.as_str(),
                "host" | "x-api-key" | "cookie" | "proxy-authorization" | "authorization"
                    | "content-length"
            )
        {
            continue;
        }
        headers.append(name.clone(), value.clone());
    }
    if let Ok(value) = HeaderValue::from_str(&format!("Bearer {access_token}")) {
        headers.insert(http::header::AUTHORIZATION, value);
    }
    if let Ok(value) = HeaderValue::from_str(account_id) {
        headers.insert("chatgpt-account-id", value);
    }
    headers.insert("openai-beta", HeaderValue::from_static("responses=experimental"));
    headers.insert("originator", HeaderValue::from_static("codex_cli_rs"));
    headers
}

/// Convert a `reqwest::Response` into the crate-standard [`StreamResponse`].
fn stream_response_from_reqwest(response: reqwest::Response) -> StreamResponse {
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers = response.headers().clone();
    let stream: BodyStream = response
        .bytes_stream()
        .map(|chunk| {
            chunk.map_err(|error| {
                Box::new(error) as cma_request::response_handler::BoxError
            })
        })
        .boxed();
    StreamResponse::new(status.as_u16(), status_text, headers, Some(stream))
}

// ===========================================================================
// Stream failover attempt (spec 13 §5.5.4 step 2)
// ===========================================================================

#[derive(Clone)]
struct FailoverCtx {
    pipeline: ProxyPipeline,
    shared_manager: SharedAccountManager,
    candidates: Vec<i64>,
    primary_index: i64,
    family: ModelFamily,
    model: Option<String>,
    quota_key: String,
    quota_schedule_key_base: String,
    client_headers: HeaderMap,
    body: Vec<u8>,
    url: String,
    budget: Arc<OutboundAttemptBudget>,
    fetch_client: reqwest::Client,
    env: StateEnv,
    success: Arc<StdMutex<Option<FailoverSuccess>>>,
    affinity: Option<Arc<StdMutex<SessionAffinityStore>>>,
    session_key: Option<String>,
    session_affinity_version: i64,
    response_continuation_enabled: bool,
}

async fn failover_attempt(
    ctx: FailoverCtx,
    attempt: u32,
    emitted_bytes: u64,
) -> Result<Option<StreamResponse>, cma_request::response_handler::BoxError> {
    ctx.pipeline.lock_metrics().stream_failover_attempts += 1;
    for candidate_index in &ctx.candidates {
        let candidate_index = *candidate_index;
        // Availability + account snapshot.
        let account = {
            let mut manager = ctx.shared_manager.lock().await;
            if !manager.is_account_available_for_family(
                candidate_index,
                ctx.family,
                ctx.model.as_deref(),
            ) {
                continue;
            }
            match manager.get_account_by_index(candidate_index) {
                Some(account) => account.clone(),
                None => continue,
            }
        };
        // Refresh (failure → warn + skip).
        let fresh = ensure_fresh_access_token(EnsureFreshAccessTokenParams {
            account_manager: &ctx.shared_manager,
            account: &account,
            family: ctx.family,
            model: ctx.model.as_deref(),
            now: now_ms(),
            token_refresh_skew_ms: ctx.env.token_refresh_skew_ms,
            token_invalidation_cooldown_ms: ctx.env.token_invalidation_cooldown_ms,
        })
        .await;
        let (access_token, account) = match fresh {
            EnsureFreshAccessTokenResult::Ok {
                access_token,
                account,
            } => (access_token, account),
            EnsureFreshAccessTokenResult::Failed { .. } => {
                log_warn("Stream failover: token refresh failed; skipping candidate.", None);
                continue;
            }
        };
        // Identity (skip if none).
        let current_workspace = account.get_current_workspace().cloned();
        let stored_account_id = current_workspace
            .as_ref()
            .map(|workspace| workspace.id.clone())
            .or_else(|| account.meta.account_id.clone());
        let stored_source = if current_workspace.is_some() {
            Some(cma_core::schemas::account_storage::AccountIdSource::Manual)
        } else {
            account.meta.account_id_source
        };
        let identity = resolve_runtime_request_identity(ResolveRuntimeRequestIdentityInput {
            stored_account_id: stored_account_id.as_deref(),
            source: stored_source,
            stored_email: account.meta.email.as_deref(),
            access_token: Some(access_token.as_str()),
            id_token: None,
        });
        let Some(account_id) = identity
            .account_id
            .clone()
            .filter(|id| !id.trim().is_empty())
        else {
            continue;
        };
        let entitlement_key = resolve_entitlement_account_key(&EntitlementAccountRef {
            account_id: Some(stored_account_id.clone().unwrap_or_else(|| account_id.clone())),
            email: identity.email.clone(),
            refresh_token: Some(account.meta.refresh_token.clone()),
            index: Some(candidate_index),
        });
        // Entitlement block check (skip + warn).
        let blocked = {
            let mut cache = ctx
                .pipeline
                .inner
                .entitlement_cache
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            cache
                .is_blocked(&entitlement_key, &ctx.quota_schedule_key_base, now_ms())
                .blocked
        };
        if blocked {
            log_warn("Stream failover: entitlement block; skipping candidate.", None);
            continue;
        }
        // Budget consume ("stream-failover") — exhaustion ends failover
        // entirely (returns None).
        if !ctx.budget.try_consume() {
            let mut metrics = ctx.pipeline.lock_metrics();
            metrics.request_attempt_budget_exhaustions += 1;
            metrics.last_error = Some(ctx.budget.exhausted_last_error());
            return Ok(None);
        }
        ctx.pipeline.lock_metrics().outbound_request_attempts_consumed += 1;
        // Local token bucket.
        let consumed = {
            let mut manager = ctx.shared_manager.lock().await;
            manager.consume_token(candidate_index, ctx.family, ctx.model.as_deref())
        };
        if !consumed {
            continue;
        }
        // Identity write-back (same rules as primary).
        {
            let mut manager = ctx.shared_manager.lock().await;
            if let Some(live) = manager.get_account_by_index_mut(candidate_index) {
                let had_account_id = live
                    .meta
                    .account_id
                    .as_deref()
                    .is_some_and(|id| !id.trim().is_empty());
                live.meta.account_id = Some(account_id.clone());
                if !had_account_id
                    && identity
                        .token_account_id
                        .as_deref()
                        .is_some_and(|token_id| token_id == account_id)
                {
                    live.meta.account_id_source = stored_source.or(Some(
                        cma_core::schemas::account_storage::AccountIdSource::Token,
                    ));
                }
                if let Some(email) = identity.email.clone() {
                    live.meta.email = Some(email);
                }
            }
        }
        let headers = build_outbound_headers(&ctx.client_headers, &access_token, &account_id);
        {
            let mut metrics = ctx.pipeline.lock_metrics();
            metrics.total_requests += 1;
            metrics.responses_requests += 1;
        }
        let fetch_result = tokio::time::timeout(
            std::time::Duration::from_millis(ctx.env.fetch_timeout_ms),
            ctx.fetch_client
                .post(&ctx.url)
                .headers(headers)
                .body(ctx.body.clone())
                .send(),
        )
        .await;
        let upstream = match fetch_result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let mut manager = ctx.shared_manager.lock().await;
                manager.refund_token(candidate_index, ctx.family, ctx.model.as_deref());
                manager.record_failure(candidate_index, ctx.family, ctx.model.as_deref());
                drop(manager);
                ctx.pipeline
                    .record_capability_failure(&entitlement_key, &ctx.quota_schedule_key_base);
                log_warn(
                    &format!("Stream failover fetch error: {error}"),
                    None,
                );
                continue;
            }
            Err(_elapsed) => {
                let mut manager = ctx.shared_manager.lock().await;
                manager.refund_token(candidate_index, ctx.family, ctx.model.as_deref());
                manager.record_failure(candidate_index, ctx.family, ctx.model.as_deref());
                drop(manager);
                ctx.pipeline
                    .record_capability_failure(&entitlement_key, &ctx.quota_schedule_key_base);
                continue;
            }
        };
        let response = stream_response_from_reqwest(upstream);
        // Quota scheduler update with the FALLBACK key.
        let fallback_schedule_key =
            format!("{entitlement_key}:{}", ctx.quota_schedule_key_base);
        if let Some(snapshot) =
            read_quota_scheduler_snapshot(&response.headers, response.status, now_ms())
        {
            let mut scheduler = ctx
                .pipeline
                .inner
                .preemptive_scheduler
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            scheduler.update(&fallback_schedule_key, snapshot);
        }
        if !response.ok() {
            let handled = handle_error_response(response, None).await;
            if handled.response.status == 429 {
                let retry_after_ms = handled
                    .rate_limit
                    .as_ref()
                    .map(|info| info.retry_after_ms)
                    .filter(|ms| *ms > 0)
                    .unwrap_or(60_000);
                // No stable-account-key 4th arg on the failover path
                // (gotcha 12); reason hardcoded "quota".
                let backoff = get_rate_limit_backoff(
                    candidate_index as usize,
                    &ctx.quota_key,
                    Some(retry_after_ms as f64),
                    None,
                );
                let cooldown_ms = backoff.delay_ms.max(retry_after_ms);
                {
                    let mut scheduler = ctx
                        .pipeline
                        .inner
                        .preemptive_scheduler
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    scheduler.mark_rate_limited(
                        &fallback_schedule_key,
                        cooldown_ms as f64,
                        now_ms(),
                    );
                }
                {
                    let mut manager = ctx.shared_manager.lock().await;
                    manager.mark_rate_limited_with_reason(
                        candidate_index,
                        cooldown_ms,
                        ctx.family,
                        RateLimitReason::Quota,
                        ctx.model.as_deref(),
                    );
                    manager.record_rate_limit(
                        candidate_index,
                        ctx.family,
                        ctx.model.as_deref(),
                    );
                }
                ctx.shared_manager
                    .save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
            } else {
                let mut manager = ctx.shared_manager.lock().await;
                manager.record_failure(candidate_index, ctx.family, ctx.model.as_deref());
                drop(manager);
                ctx.pipeline
                    .record_capability_failure(&entitlement_key, &ctx.quota_schedule_key_base);
            }
            continue;
        }
        // Fallback success.
        let cross_account = candidate_index != ctx.primary_index;
        {
            let mut success = ctx
                .success
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *success = Some(FailoverSuccess {
                index: candidate_index,
                entitlement_key: entitlement_key.clone(),
                cross_account,
            });
        }
        {
            let mut metrics = ctx.pipeline.lock_metrics();
            metrics.stream_failover_recoveries += 1;
            if cross_account {
                metrics.stream_failover_cross_account_recoveries += 1;
                metrics.account_rotations += 1;
            }
        }
        if cross_account
            && !ctx.response_continuation_enabled
            && let Some(store) = ctx.affinity.as_ref()
        {
            store
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remember_with_version(
                    ctx.session_key.as_deref(),
                    candidate_index,
                    now_ms(),
                    Some(ctx.session_affinity_version),
                );
        }
        let data = serde_json::json!({ "emittedBytes": emitted_bytes });
        log_info(
            &format!(
                "Recovered stream via failover attempt {attempt} using account {}.",
                candidate_index + 1
            ),
            Some(&data),
        );
        return Ok(Some(response));
    }
    Ok(None)
}

/// Sticky min-rotation boost (spec 04 rotation loop step 1), merged into a
/// FRESH clone of the base capability+policy boost map. TS recomputes this on
/// EVERY iteration of the account-attempt while-loop
/// (runtime-rotation-proxy.ts:956-961), re-reading `lastGlobalAccountIndex` /
/// `lastGlobalSwitchAt` — so attempts that span the min-rotation window (429
/// short-retry sleeps, stream-failover waits) or race a concurrent request
/// drop or retarget the boost mid-request instead of applying a frozen one.
/// Cloning per call (instead of `+=` into a persistent map) also guarantees
/// the boost can never stack across attempts.
fn merge_sticky_min_rotation_boost(
    base: &HashMap<i64, f64>,
    min_rotation_interval_ms: i64,
    last_global_account_index: Option<i64>,
    last_global_switch_at: i64,
    now_ms: i64,
) -> HashMap<i64, f64> {
    let mut boosts = base.clone();
    if min_rotation_interval_ms > 0
        && let Some(last_index) = last_global_account_index
        && now_ms - last_global_switch_at < min_rotation_interval_ms
    {
        *boosts.entry(last_index).or_insert(0.0) += 1_000.0;
    }
    boosts
}

#[cfg(test)]
mod sticky_boost_tests {
    use super::*;

    /// Finding: the sticky boost must be recomputed per attempt from the
    /// CURRENT rotation state, not frozen per traversal — and re-merging
    /// must never stack +1000 across attempts.
    #[test]
    fn sticky_boost_is_recomputed_per_attempt_and_never_stacks() {
        let mut base = HashMap::new();
        base.insert(0_i64, 5.0_f64);

        // Within the min-rotation window: +1000 on the sticky account.
        let attempt1 = merge_sticky_min_rotation_boost(&base, 60_000, Some(0), 1_000, 2_000);
        assert_eq!(attempt1.get(&0), Some(&1_005.0));

        // A later attempt re-reads state: window expired -> boost dropped
        // (a frozen per-traversal map would still carry +1000 here).
        let attempt2 = merge_sticky_min_rotation_boost(&base, 60_000, Some(0), 1_000, 61_001);
        assert_eq!(attempt2.get(&0), Some(&5.0));

        // Concurrent request moved the sticky index: boost retargets.
        let attempt3 = merge_sticky_min_rotation_boost(&base, 60_000, Some(1), 2_500, 3_000);
        assert_eq!(attempt3.get(&0), Some(&5.0));
        assert_eq!(attempt3.get(&1), Some(&1_000.0));

        // Re-merging from the same base never stacks (fresh clone per call).
        for _ in 0..3 {
            let again = merge_sticky_min_rotation_boost(&base, 60_000, Some(0), 1_000, 2_000);
            assert_eq!(again.get(&0), Some(&1_005.0));
        }
        // Base map untouched.
        assert_eq!(base.get(&0), Some(&5.0));

        // Disabled interval or no sticky index: base passes through.
        assert_eq!(
            merge_sticky_min_rotation_boost(&base, 0, Some(0), 1_000, 1_500),
            base
        );
        assert_eq!(
            merge_sticky_min_rotation_boost(&base, 60_000, None, 1_000, 1_500),
            base
        );
    }
}
