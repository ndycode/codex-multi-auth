//! Integration tests for the merged rotation pipeline (`cma_proxy::pipeline`).
//!
//! Ports the highest-value assertions from the TS suites (P0 per spec 14
//! §11): the `index.test.ts` "OpenAIOAuthPlugin fetch handler" rotation
//! behaviors and the `index-retry.test.ts` budget/burst scenarios, driven
//! against a wiremock upstream through the real pipeline.
//!
//! Every test is `#[serial]`: the pipeline touches process-global state
//! (resilience cooldowns, rate-limit backoff, rotation trackers) and the
//! `EnvSandbox` mutates env vars.

use std::sync::Arc;

use cma_accounts::manager::AccountManager;
use cma_accounts::manager_persistence::SharedAccountManager;
use cma_core::schemas::account_storage::AccountStorageV3;
use cma_proxy::pipeline::{PipelineConfig, ProxyPipeline, load_pipeline_config};
use cma_request::failure_policy::FailoverMode;
use cma_request::model_map::get_model_family;
use cma_request::rate_limit_backoff::clear_rate_limit_backoff_state;
use cma_request::resilience::reset_request_resilience_state_for_tests;
use cma_runtime::rotation::proxy_state::{
    RotationProxyState, RotationProxyStateInit, create_rotation_proxy_state,
};
use cma_runtime::rotation::server_types::{RequestContext, RequestMethod, SchedulingStrategy};
use cma_rotation::routing_mutex::RoutingMutexMode;
use cma_testkit::sandbox::EnvSandbox;
use serde_json::{Value, json};
use serial_test::serial;
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn reset_globals() {
    reset_request_resilience_state_for_tests();
    clear_rate_limit_backoff_state();
    AccountManager::reset_volatile_runtime_state();
}

/// Accounts with valid (far-future) access tokens so no refresh happens.
fn storage_with_accounts(count: usize) -> AccountStorageV3 {
    let now = cma_core::utils::now_ms();
    let accounts: Vec<Value> = (0..count)
        .map(|index| {
            json!({
                "refreshToken": format!("refresh-{}", index + 1),
                "accessToken": format!("access-{}", index + 1),
                "expiresAt": now + 3_600_000,
                "accountId": format!("acc-{}", index + 1),
                "email": format!("user{}@example.com", index + 1),
                "addedAt": now,
                "lastUsed": now,
            })
        })
        .collect();
    serde_json::from_value(json!({
        "version": 3,
        "accounts": accounts,
        "activeIndex": 0,
        "activeIndexByFamily": {},
    }))
    .expect("test storage parses")
}

fn test_state(upstream_base_url: &str, account_count: usize) -> RotationProxyState {
    let manager = AccountManager::new(None, Some(&storage_with_accounts(account_count)));
    let shared = SharedAccountManager::new(manager);
    create_rotation_proxy_state(RotationProxyStateInit {
        active_account_manager: shared,
        routing_mutex_mode: RoutingMutexMode::Legacy,
        scheduling_strategy: SchedulingStrategy::Hybrid,
        fetch_client: reqwest::Client::new(),
        upstream_base_url: upstream_base_url.to_string(),
        client_api_key: "test-client-key".to_string(),
        now: Arc::new(cma_core::utils::now_ms),
        token_refresh_skew_ms: 60_000,
        network_error_cooldown_ms: 6_000,
        server_error_cooldown_ms: 4_000,
        token_invalidation_cooldown_ms: 300_000,
        min_rotation_interval_ms: 0,
        pid_offset_enabled: false,
        fetch_timeout_ms: 5_000,
        stream_stall_timeout_ms: 45_000,
        max_runtime_account_attempts: 4,
        max_request_body_bytes: 64 * 1024 * 1024,
        quota_remaining_percent_threshold: 10.0,
        session_affinity_store: None,
        last_observed_affinity_generation: 0,
        forced_account_index: None,
    })
}

/// Deterministic pipeline config: aggressive mode, no same-account retries,
/// no stream failover, no wait-and-retry. `empty_response_max_retries: 2`
/// keeps the outbound budget formula from starving short-429 retries and
/// fallback restarts (TS default configs always leave budget slack).
fn test_config() -> PipelineConfig {
    PipelineConfig {
        rate_limit_toast_debounce_ms: 0,
        retry_all_accounts_rate_limited: false,
        retry_all_accounts_max_wait_ms: 0,
        retry_all_accounts_max_retries: 0,
        fallback_on_unsupported_codex_model: false,
        fallback_to_gpt52_on_unsupported_gpt53: true,
        unsupported_codex_fallback_chain: None,
        toast_duration_ms: 0,
        failover_mode: FailoverMode::Aggressive,
        stream_failover_max: 0,
        stream_failover_soft_timeout_ms: 10_000,
        stream_failover_hard_timeout_ms: 45_000,
        max_same_account_retries: 0,
        empty_response_max_retries: 2,
        empty_response_retry_delay_ms: 0,
        response_continuation_enabled: false,
    }
}

fn responses_ctx(model: &str) -> RequestContext {
    let body = json!({ "model": model, "stream": false });
    RequestContext {
        body: serde_json::to_vec(&body).unwrap(),
        headers: reqwest::header::HeaderMap::new(),
        method: RequestMethod::Post,
        upstream_path: "/codex/responses".to_string(),
        model: Some(model.to_string()),
        family: get_model_family(model),
        stream: false,
        session_key: None,
    }
}

fn ok_response_body() -> Value {
    json!({
        "id": "resp_ok",
        "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "hi" }] }],
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// index.test.ts: "returns success response for successful fetch" + the
/// spec-04 outbound header contract (authorization / chatgpt-account-id /
/// originator: codex_cli_rs — load-bearing, gotcha 24).
#[tokio::test]
#[serial]
async fn success_forwards_upstream_with_rotation_headers() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("authorization", "Bearer access-1"))
        .and(header("chatgpt-account-id", "acc-1"))
        .and(header("originator", "codex_cli_rs"))
        .and(header("openai-beta", "responses=experimental"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(1)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), test_config());
    let mut response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), Some("trace-1".to_string()))
        .await;

    assert_eq!(response.status, 200);
    let text = response.collect_text().await.unwrap();
    assert!(text.contains("resp_ok"), "body forwarded: {text}");
    let metrics = pipeline.metrics_snapshot();
    assert_eq!(metrics.successful_requests, 1);
    assert_eq!(metrics.total_requests, 1);
    // Budget formula: accounts(1) + sameAccountRetries(0) + emptyRetries(2)
    // + streamFailover(0) = 3, clamped to 1..=6 (spec 13 §5.4).
    assert_eq!(metrics.outbound_request_attempt_budget, Some(3));
}

/// index.test.ts fetch-handler rotation: a 429 on the first account rotates
/// to the second and succeeds (rate-limit mark persists on account 1).
#[tokio::test]
#[serial]
async fn rotates_to_next_account_on_429() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    // Long Retry-After (120 s) > short-retry threshold (5 s default) ⇒
    // full rotation, MARK-BEFORE-SLEEP not applicable.
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-1"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "120")
                .set_body_json(json!({"error": {"message": "rate limited"}})),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(1)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 2), test_config());
    let response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 200);
    let metrics = pipeline.metrics_snapshot();
    assert_eq!(metrics.rate_limited_responses, 1);
    assert!(metrics.account_rotations >= 1);
    assert_eq!(metrics.successful_requests, 1);
    // Account 1 carries the persisted rate-limit window.
    let state = pipeline.state().await;
    let mut manager = state.active_account_manager.lock().await;
    let family = get_model_family("gpt-5.3-codex");
    assert!(
        !manager.is_account_available_for_family(0, family, Some("gpt-5.3-codex")),
        "account 1 must be rate-limited after the 429"
    );
}

/// index.test.ts: short 429 retries the SAME account after marking it
/// rate-limited (mark-before-sleep, spec 13 gotcha 5).
#[tokio::test]
#[serial]
async fn short_429_retries_same_account() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-1"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "1")
                .set_body_json(json!({"error": {"message": "rate limited"}})),
        )
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(1)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), test_config());
    let response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 200);
    let metrics = pipeline.metrics_snapshot();
    assert_eq!(metrics.rate_limited_responses, 1);
    assert_eq!(metrics.successful_requests, 1);
    // Two outbound attempts, same account.
    assert_eq!(metrics.total_requests, 2);
}

/// spec 04 gotcha 10: an upstream 401 carrying a token-invalidation phrase
/// STOPS rotation (401 `token_invalidated`, second account untouched) and
/// applies the 300 s monotonic cooldown.
#[tokio::test]
#[serial]
async fn token_invalidation_401_stops_rotation() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-1"))
        .respond_with(
            ResponseTemplate::new(401)
                .insert_header("x-request-id", "req-diag-1")
                .set_body_json(json!({
                    "error": { "message": "Your authentication token has been invalidated. Please try signing in again." }
                })),
        )
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(0)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 2), test_config());
    let mut response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 401);
    // TS builds the reply from responseHeadersForClient(upstream.headers):
    // scrubbed upstream diagnostics (x-request-id) survive and content-type
    // is EXACTLY "application/json" (no charset).
    assert_eq!(
        response
            .headers
            .get("x-request-id")
            .and_then(|v| v.to_str().ok()),
        Some("req-diag-1"),
        "upstream diagnostics forwarded on the token-invalidation reply"
    );
    assert_eq!(
        response
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    let body: Value =
        serde_json::from_str(&response.collect_text().await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "token_invalidated");
    // 300 s cooldown applied to account 1 (monotonic).
    let state = pipeline.state().await;
    let manager = state.active_account_manager.lock().await;
    let cooling_until = manager
        .get_account_by_index(0)
        .and_then(|account| account.meta.cooling_down_until)
        .unwrap_or(0);
    assert!(
        cooling_until >= cma_core::utils::now_ms() + 250_000,
        "invalidation cooldown must be ~300s, got {cooling_until}"
    );
}

/// spec 04 §14 + spec 13 §5.5.5: full exhaustion emits the stable
/// `codex_runtime_rotation_pool_exhausted` body and arms the pool cooldown
/// (the NEXT request fast-fails 429 with the frozen cooldown message).
#[tokio::test]
#[serial]
async fn pool_exhaustion_emits_contract_body_and_arms_cooldown() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "600")
                .set_body_json(json!({"error": {"message": "rate limited"}})),
        )
        .expect(1)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), test_config());
    let mut response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 429, "rate-limit exhaustion maps to 429");
    let body: Value =
        serde_json::from_str(&response.collect_text().await.unwrap()).unwrap();
    assert_eq!(
        body["error"]["code"],
        "codex_runtime_rotation_pool_exhausted"
    );
    assert_eq!(body["error"]["reason"], "rate-limit");
    assert!(body["error"]["retry_after_ms"].as_i64().unwrap() > 0);
    assert_eq!(
        body["error"]["message"],
        "All managed Codex accounts are temporarily unavailable for this runtime request."
    );

    // Second request: pool-exhaustion fast-fail (spec 13 §5.3).
    let mut second = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;
    assert_eq!(second.status, 429);
    let text = second.collect_text().await.unwrap();
    assert!(
        text.contains("The account pool is cooling down after recent rate-limit exhaustion."),
        "fast-fail message frozen: {text}"
    );
    let metrics = pipeline.metrics_snapshot();
    assert_eq!(metrics.pool_exhaustion_fast_fails, 1);
}

/// index.test.ts: "forces Spark fallback even when strict policy disables
/// generic unsupported fallback" + "restarts account traversal after
/// fallback model switch" (spec 13 gotchas 9–11).
#[tokio::test]
#[serial]
async fn spark_unsupported_falls_back_and_restarts_traversal() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(body_string_contains("gpt-5.3-codex-spark"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": {
                "code": "model_not_supported_with_chatgpt_account",
                "message": "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(body_string_contains("\"gpt-5.3-codex\""))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(1)
        .mount(&server)
        .await;

    // Strict policy: fallback_on_unsupported_codex_model = false — spark is
    // force-fallback anyway.
    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), test_config());
    let response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex-spark"), None)
        .await;

    assert_eq!(response.status, 200);
    let metrics = pipeline.metrics_snapshot();
    assert_eq!(metrics.successful_requests, 1);
    assert_eq!(metrics.total_requests, 2);
}

/// index-retry.test.ts: "stops after the bounded outbound request budget" —
/// in the merged pipeline the spec-04 transient budget (min(count, 4)) caps
/// a 5xx storm first; the terminal body reports reason "budget".
#[tokio::test]
#[serial]
async fn server_error_storm_stops_at_transient_budget() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(
            ResponseTemplate::new(500)
                .set_body_json(json!({"error": {"message": "server exploded"}})),
        )
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 8), test_config());
    let mut response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 503);
    let body: Value =
        serde_json::from_str(&response.collect_text().await.unwrap()).unwrap();
    assert_eq!(
        body["error"]["code"],
        "codex_runtime_rotation_pool_exhausted"
    );
    assert_eq!(body["error"]["reason"], "budget");
    // Transient budget = min(accountCount=8, 4) ⇒ exactly 4 upstream hits.
    let received = server.received_requests().await.unwrap();
    assert_eq!(received.len(), 4, "transient budget caps upstream attempts");
    let metrics = pipeline.metrics_snapshot();
    assert_eq!(metrics.server_errors, 4);
}

/// Pinned account unavailable ⇒ hard 503 `codex_pinned_account_unavailable`
/// with a structured skip reason; NEVER falls through to rotation (#474).
#[tokio::test]
#[serial]
async fn pinned_unavailable_hard_fails_without_rotation() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(0)
        .mount(&server)
        .await;

    let mut state = test_state(&server.uri(), 2);
    state.forced_account_index = Some(1);
    // Disable the pinned account so it fails availability.
    {
        let mut manager = state.active_account_manager.manager().try_lock().unwrap();
        manager.set_account_enabled(1, false);
    }
    let pipeline = ProxyPipeline::new(state, test_config());
    let mut response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 503);
    let body: Value =
        serde_json::from_str(&response.collect_text().await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "codex_pinned_account_unavailable");
}

/// load_pipeline_config honors the env-driven failover settings, incl. the
/// `capStreamFailoverMax` clamp to 1 (spec 13 gotcha 1).
#[tokio::test]
#[serial]
async fn stream_failover_max_is_clamped_to_one() {
    let mut sandbox = EnvSandbox::new();
    sandbox.set_var("CODEX_AUTH_FAILOVER_MODE", "balanced");
    sandbox.set_var("CODEX_AUTH_STREAM_FAILOVER_MAX", "5");
    let config = load_pipeline_config(&cma_core::schemas::plugin_config::PluginConfig::default());
    assert_eq!(
        config.stream_failover_max, 1,
        "mode default 2 and env 5 both clamp to 1"
    );
    assert_eq!(config.max_same_account_retries, 1, "balanced ⇒ 1");
    sandbox.set_var("CODEX_AUTH_FAILOVER_MODE", "conservative");
    let config = load_pipeline_config(&cma_core::schemas::plugin_config::PluginConfig::default());
    assert_eq!(config.max_same_account_retries, 2, "conservative ⇒ 2");
    sandbox.set_var("CODEX_AUTH_FAILOVER_MODE", "aggressive");
    let config = load_pipeline_config(&cma_core::schemas::plugin_config::PluginConfig::default());
    assert_eq!(config.max_same_account_retries, 0, "aggressive ⇒ 0");
}

// ---------------------------------------------------------------------------
// Parity-fix pins (TS-vs-Rust divergence findings)
// ---------------------------------------------------------------------------

fn ledger_rows(sandbox: &EnvSandbox) -> Vec<Value> {
    let path = sandbox
        .codex_multi_auth_dir()
        .join("usage")
        .join("usage-ledger.jsonl");
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    contents
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("ledger row parses"))
        .collect()
}

/// Finding: the error ladder keys off the REMAPPED status. A structured 404
/// usage-limit body (which upstream really uses for quota exhaustion on this
/// endpoint) is remapped to 429 by handle_error_response and MUST take the
/// rate-limit path -- mark the account rate-limited and rotate -- not the
/// generic return (which would 429 the client while leaving the exhausted
/// account eligible for immediate re-selection).
#[tokio::test]
#[serial]
async fn mapped_404_usage_limit_marks_rate_limited_and_rotates() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-1"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "error": { "code": "usage_limit_reached", "message": "limit reached" }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(1)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 2), test_config());
    let response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 200, "rotated to the healthy account");
    let metrics = pipeline.metrics_snapshot();
    assert_eq!(metrics.rate_limited_responses, 1, "took the 429 ladder branch");
    assert!(metrics.account_rotations >= 1);
    let state = pipeline.state().await;
    let mut manager = state.active_account_manager.lock().await;
    let family = get_model_family("gpt-5.3-codex");
    assert!(
        !manager.is_account_available_for_family(0, family, Some("gpt-5.3-codex")),
        "the exhausted account must carry a rate-limit mark"
    );
}

/// Finding: a 404 entitlement body (remapped to 403) must cache the
/// plan-entitlement block exactly like a raw 403 -- the NEXT request for the
/// same account fast-fails from the cache instead of re-hitting upstream.
#[tokio::test]
#[serial]
async fn mapped_404_entitlement_caches_the_plan_block() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "error": { "code": "usage_not_included", "message": "Usage not included in your plan" }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), test_config());
    let first = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;
    assert_eq!(first.status, 403, "remapped entitlement response");

    // Second request: served from the entitlement cache (upstream expect(1)
    // is verified on MockServer drop -- a second upstream hit panics).
    let second = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;
    assert_ne!(second.status, 200);
    let requests = server.received_requests().await.expect("recorded");
    assert_eq!(
        requests.len(),
        1,
        "cached plan-entitlement block prevents the second upstream call"
    );
}

/// Finding: a STREAMING upstream success must NOT eagerly record the ledger
/// row -- the record is deferred to the client-forward stage (`forwarded ?
/// success : failure/stream_forward_failed`), which also owns the
/// network-failure account cleanup on a mid-stream stall.
#[tokio::test]
#[serial]
async fn streaming_success_defers_the_ledger_row_to_the_forward_stage() {
    let sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), test_config());
    let mut ctx = responses_ctx("gpt-5.3-codex");
    ctx.stream = true;
    ctx.body = serde_json::to_vec(&json!({ "model": "gpt-5.3-codex", "stream": true })).unwrap();
    ctx.session_key = Some("session-defer".to_string());

    let outcome = pipeline.handle_responses_for_server(ctx, None).await;
    assert_eq!(outcome.response.status, 200);
    let deferred = outcome
        .deferred
        .expect("streaming success hands the record to the forward stage");
    assert_eq!(deferred.account_index, 0);
    assert_eq!(deferred.model.as_deref(), Some("gpt-5.3-codex"));
    assert_eq!(deferred.session_key.as_deref(), Some("session-defer"));
    assert!(
        ledger_rows(&sandbox).is_empty(),
        "no ledger row before the client forward resolves"
    );

    // Forward stage failure: the row becomes failure/stream_forward_failed
    // (mirrors server.rs StreamUsage on_failure).
    deferred
        .recorder
        .record(cma_quota::runtime_policy::RuntimeUsageRecordInput {
            outcome: Some(cma_usage::types::UsageLedgerOutcome::Failure),
            status_code: Some(200),
            error_code: Some("stream_forward_failed".to_string()),
            ..Default::default()
        })
        .await;
    let rows = ledger_rows(&sandbox);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["outcome"], "failure");
    assert_eq!(rows[0]["errorCode"], "stream_forward_failed");

    // The plain handle_responses entry point (in-process callers with no
    // separate forward stage) records the deferred success itself.
    let mut ctx = responses_ctx("gpt-5.3-codex");
    ctx.stream = true;
    ctx.body = serde_json::to_vec(&json!({ "model": "gpt-5.3-codex", "stream": true })).unwrap();
    let response = pipeline.handle_responses(ctx, None).await;
    assert_eq!(response.status, 200);
    let rows = ledger_rows(&sandbox);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["outcome"], "success");
}

/// Finding: a handled context-overflow returns TS's DEFAULT ledger row
/// (failure / plugin_host_request_failed / statusCode null) -- TS never
/// updates usageCompletion on that early return -- not a success row.
#[tokio::test]
#[serial]
async fn context_overflow_handled_records_the_ts_default_failure_row() {
    let sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": { "message": "This request exceeds the maximum context length (context_length_exceeded)." }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), test_config());
    let mut response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;

    assert_eq!(response.status, 200, "synthetic overflow SSE response");
    let text = response.collect_text().await.unwrap();
    assert!(text.contains("Context is too long"), "overflow notice: {text}");
    let rows = ledger_rows(&sandbox);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["outcome"], "failure", "TS default completion");
    assert_eq!(rows[0]["errorCode"], "plugin_host_request_failed");
    assert!(
        rows[0].get("statusCode").is_none_or(Value::is_null),
        "statusCode stays null like TS: {:?}",
        rows[0]
    );
}

/// Finding: the 429 short-retry toast is gated by the per-account
/// shouldShowAccountToast debounce and records markToastShown -- a burst of
/// 429s emits at most ONE rate-limit toast per debounce window per account.
#[tokio::test]
#[serial]
async fn rate_limit_toasts_debounce_per_account() {
    let _sandbox = EnvSandbox::new();
    reset_globals();
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "1")
                .set_body_json(json!({"error": {"message": "rate limited"}})),
        )
        .up_to_n_times(2)
        .expect(2)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_response_body()))
        .expect(1)
        .mount(&server)
        .await;

    let mut config = test_config();
    config.rate_limit_toast_debounce_ms = 30_000;
    let pipeline = ProxyPipeline::new(test_state(&server.uri(), 1), config);
    cma_runtime::toast::start_toast_capture_for_tests();
    let response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;
    let toasts = cma_runtime::toast::take_captured_toasts_for_tests();

    assert_eq!(response.status, 200);
    assert_eq!(pipeline.metrics_snapshot().rate_limited_responses, 2);
    let rate_limit_toasts: Vec<&(String, String)> = toasts
        .iter()
        .filter(|(_, message)| message.contains("Rate limited"))
        .collect();
    assert_eq!(
        rate_limit_toasts.len(),
        1,
        "one toast per account per debounce window, got {toasts:?}"
    );
    // markToastShown was recorded, so the debounce window is armed.
    let state = pipeline.state().await;
    let manager = state.active_account_manager.lock().await;
    assert!(
        !manager.should_show_account_toast(0, Some(30_000)),
        "mark_toast_shown must be recorded on the 429 toast path"
    );
}

/// Finding: the 429 backoff stable key reads the request-resolved accountId
/// (written back onto the live account object in TS). An account stored
/// WITHOUT accountId whose id resolves from the access token this request
/// must key its backoff state under the resolved id, not slot/email.
#[tokio::test]
#[serial]
async fn backoff_stable_key_uses_the_request_resolved_account_id() {
    use base64::Engine as _;
    let _sandbox = EnvSandbox::new();
    reset_globals();

    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let jwt = format!(
        "{}.{}.sig",
        b64.encode(json!({ "alg": "none", "typ": "JWT" }).to_string()),
        b64.encode(
            json!({
                "https://api.openai.com/auth": { "chatgpt_account_id": "acc-jwt-1" }
            })
            .to_string()
        ),
    );
    let now = cma_core::utils::now_ms();
    let storage: AccountStorageV3 = serde_json::from_value(json!({
        "version": 3,
        "accounts": [{
            "refreshToken": "refresh-jwt",
            "accessToken": jwt,
            "expiresAt": now + 3_600_000,
            "addedAt": now,
            "lastUsed": now,
        }],
        "activeIndex": 0,
        "activeIndexByFamily": {},
    }))
    .expect("storage parses");

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc-jwt-1"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "120")
                .set_body_json(json!({"error": {"message": "rate limited"}})),
        )
        .expect(1)
        .mount(&server)
        .await;

    let manager = AccountManager::new(None, Some(&storage));
    let shared = SharedAccountManager::new(manager);
    let state = create_rotation_proxy_state(RotationProxyStateInit {
        active_account_manager: shared,
        routing_mutex_mode: RoutingMutexMode::Legacy,
        scheduling_strategy: SchedulingStrategy::Hybrid,
        fetch_client: reqwest::Client::new(),
        upstream_base_url: server.uri(),
        client_api_key: "test-client-key".to_string(),
        now: Arc::new(cma_core::utils::now_ms),
        token_refresh_skew_ms: 60_000,
        network_error_cooldown_ms: 6_000,
        server_error_cooldown_ms: 4_000,
        token_invalidation_cooldown_ms: 300_000,
        min_rotation_interval_ms: 0,
        pid_offset_enabled: false,
        fetch_timeout_ms: 5_000,
        stream_stall_timeout_ms: 45_000,
        max_runtime_account_attempts: 4,
        max_request_body_bytes: 64 * 1024 * 1024,
        quota_remaining_percent_threshold: 10.0,
        session_affinity_store: None,
        last_observed_affinity_generation: 0,
        forced_account_index: None,
    });
    let pipeline = ProxyPipeline::new(state, test_config());
    let response = pipeline
        .handle_responses(responses_ctx("gpt-5.3-codex"), None)
        .await;
    assert_eq!(response.status, 429, "single exhausted account");

    // The pipeline recorded the backoff under the RESOLVED id: probing the
    // same key immediately lands in the dedup window (entry exists). Under
    // the pre-fix slot/email key this probe would create a FRESH entry
    // (is_duplicate == false, attempt 1).
    let family = get_model_family("gpt-5.3-codex");
    let quota_key = format!("{}:gpt-5.3-codex", family.as_str());
    let probe = cma_request::rate_limit_backoff::get_rate_limit_backoff(
        0,
        &quota_key,
        None,
        Some("acc-jwt-1"),
    );
    assert!(
        probe.is_duplicate,
        "backoff state must live under the resolved accountId key: {probe:?}"
    );
}
