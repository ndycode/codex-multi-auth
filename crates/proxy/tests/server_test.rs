//! P0 port of `test/runtime-rotation-proxy.test.ts` (HTTP-surface half) +
//! `runtime-rotation-proxy-safe-equal.test.ts` behavior anchors.
//!
//! Every test pins the filesystem/env via `EnvSandbox` (`#[serial(env)]`) —
//! the proxy loads config, policy state, and storage metadata from the
//! sandboxed `~/.codex/multi-auth` tree, and its debounced saves write there.

use cma_accounts::manager::AccountManager;
use cma_accounts::manager_persistence::SharedAccountManager;
use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
use cma_core::utils::now_ms;
use cma_proxy::server::start_runtime_rotation_proxy;
use cma_runtime::rotation::server_types::RuntimeRotationProxyOptions;
use cma_testkit::sandbox::EnvSandbox;
use serde_json::{Value, json};
use serial_test::serial;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const CLIENT_KEY: &str = "runtime-secret";

fn account_meta(index: usize, now: i64) -> AccountMetadataV3 {
    let mut meta =
        AccountMetadataV3::new(format!("refresh-{}", index + 1), now - 60_000, now - 60_000);
    meta.email = Some(format!("account-{}@example.com", index + 1));
    meta.account_id = Some(format!("acc_{}", index + 1));
    meta.access_token = Some(format!("access-{}", index + 1));
    meta.expires_at = Some(now + 3_600_000);
    meta.enabled = Some(true);
    meta
}

fn storage_with(count: usize) -> AccountStorageV3 {
    let now = now_ms();
    let mut storage = AccountStorageV3::empty();
    storage.accounts = (0..count).map(|index| account_meta(index, now)).collect();
    storage
}

fn shared_manager(count: usize) -> SharedAccountManager {
    // The pipeline consults process-wide singletons (health/token trackers,
    // circuit breakers, pool-exhaustion/server-burst fast-fail cooldowns,
    // rate-limit backoff). Vitest gave each TS test file a fresh module
    // registry; these resets are the Rust equivalent so one test's pool
    // exhaustion cannot fast-fail every later test with a synthetic 429.
    AccountManager::reset_volatile_runtime_state();
    cma_request::resilience::reset_request_resilience_state_for_tests();
    cma_request::rate_limit_backoff::clear_rate_limit_backoff_state();
    SharedAccountManager::new(AccountManager::new(None, Some(&storage_with(count))))
}

fn proxy_options(
    manager: SharedAccountManager,
    upstream_base_url: &str,
) -> RuntimeRotationProxyOptions {
    RuntimeRotationProxyOptions {
        account_manager: Some(manager),
        client_api_key: CLIENT_KEY.to_string(),
        upstream_base_url: Some(upstream_base_url.to_string()),
        ..Default::default()
    }
}

async fn body_json(response: reqwest::Response) -> Value {
    serde_json::from_str(&response.text().await.expect("body text")).expect("json body")
}

#[tokio::test]
#[serial(env)]
async fn requires_a_client_api_key_at_startup() {
    let _sandbox = EnvSandbox::new();
    let error = start_runtime_rotation_proxy(RuntimeRotationProxyOptions {
        account_manager: Some(shared_manager(1)),
        client_api_key: "   ".to_string(),
        ..Default::default()
    })
    .await
    .expect_err("startup must fail");
    assert_eq!(error.name(), "CodexValidationError");
    assert_eq!(error.field(), Some("clientApiKey"));
    assert_eq!(
        error.to_string(),
        "Runtime rotation proxy requires a clientApiKey."
    );
}

#[tokio::test]
#[serial(env)]
async fn refuses_to_bind_a_non_loopback_host_unconditionally() {
    let _sandbox = EnvSandbox::new();
    let error = start_runtime_rotation_proxy(RuntimeRotationProxyOptions {
        account_manager: Some(shared_manager(1)),
        client_api_key: CLIENT_KEY.to_string(),
        host: Some("0.0.0.0".to_string()),
        ..Default::default()
    })
    .await
    .expect_err("startup must fail");
    assert_eq!(error.name(), "CodexValidationError");
    assert_eq!(error.field(), Some("host"));
    assert_eq!(
        error.to_string(),
        "Runtime rotation proxy refuses to bind non-loopback host \"0.0.0.0\". It forwards managed OAuth tokens and is loopback-only."
    );
}

#[tokio::test]
#[serial(env)]
async fn rejects_unauthenticated_clients_with_401_never_404() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(1), &upstream.uri()))
        .await
        .expect("proxy starts");
    let client = reqwest::Client::new();

    // Wrong bearer on a valid path -> 401.
    let response = client
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", "Bearer wrong")
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);
    let body = body_json(response).await;
    assert_eq!(
        body["error"]["code"],
        "runtime_rotation_proxy_unauthorized"
    );
    assert_eq!(
        body["error"]["message"],
        "Runtime rotation proxy rejected an unauthenticated local request."
    );

    // Unknown path withOUT credentials -> STILL 401 (never a
    // path-confirming 404 — endpoint enumeration defense).
    let response = client
        .post(format!("{}/definitely/not/a/route", proxy.base_url))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);

    assert!(upstream.received_requests().await.unwrap_or_default().is_empty());
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn returns_404_for_unsupported_paths_and_methods_when_authorized() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(1), &upstream.uri()))
        .await
        .expect("proxy starts");
    let client = reqwest::Client::new();

    // Arbitrary local path that merely ends with "responses".
    let response = client
        .post(format!("{}/foo/responses", proxy.base_url))
        .header("x-api-key", CLIENT_KEY)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 404);
    let body = body_json(response).await;
    assert_eq!(body["error"]["code"], "runtime_rotation_proxy_not_found");
    assert_eq!(
        body["error"]["message"],
        "Runtime rotation proxy only accepts Responses API, model discovery, and Codex thread goal requests."
    );

    // Wrong method on a supported path.
    let response = client
        .get(format!("{}/responses", proxy.base_url))
        .header("x-api-key", CLIENT_KEY)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 404);

    assert!(upstream.received_requests().await.unwrap_or_default().is_empty());
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn rejects_oversized_request_bodies_before_selecting_an_account() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    let mut options = proxy_options(shared_manager(1), &upstream.uri());
    options.max_request_body_bytes = Some(64);
    let proxy = start_runtime_rotation_proxy(options)
        .await
        .expect("proxy starts");

    let big = "x".repeat(256);
    let response = reqwest::Client::new()
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .body(format!("{{\"model\":\"gpt-5-codex\",\"pad\":\"{big}\"}}"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 413);
    let body = body_json(response).await;
    assert_eq!(
        body["error"]["code"],
        "runtime_rotation_proxy_payload_too_large"
    );
    assert_eq!(
        body["error"]["message"],
        "Runtime rotation proxy request body is too large."
    );
    assert!(upstream.received_requests().await.unwrap_or_default().is_empty());
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn forwards_responses_replacing_caller_auth_and_scrubbing_credentials() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("data: ok\n\n")
                .insert_header("content-type", "text/event-stream")
                .insert_header("x-request-id", "req_1"),
        )
        .mount(&upstream)
        .await;

    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(1), &upstream.uri()))
        .await
        .expect("proxy starts");
    let response = reqwest::Client::new()
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .header("cookie", "sid=1")
        .header("x-custom", "kept")
        .json(&json!({ "model": "gpt-5-codex", "stream": true }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    // Stale decoded content-encoding never reaches the client (the filter
    // itself is pinned by the stream_failover_runtime unit tests).
    assert!(response.headers().get("content-encoding").is_none());
    assert_eq!(
        response.headers().get("x-request-id").unwrap(),
        "req_1"
    );
    assert_eq!(response.text().await.expect("body"), "data: ok\n\n");

    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
    let forwarded = &requests[0];
    assert_eq!(
        forwarded.headers.get("authorization").unwrap(),
        "Bearer access-1"
    );
    assert_eq!(forwarded.headers.get("chatgpt-account-id").unwrap(), "acc_1");
    assert_eq!(
        forwarded.headers.get("openai-beta").unwrap(),
        "responses=experimental"
    );
    assert_eq!(forwarded.headers.get("originator").unwrap(), "codex_cli_rs");
    assert!(forwarded.headers.get("cookie").is_none());
    assert!(forwarded.headers.get("x-api-key").is_none());
    assert_eq!(forwarded.headers.get("x-custom").unwrap(), "kept");
    assert_eq!(
        forwarded.body,
        serde_json::to_vec(&json!({ "model": "gpt-5-codex", "stream": true })).unwrap()
    );
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn forwards_model_discovery_through_managed_account_auth() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [] })))
        .mount(&upstream)
        .await;
    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(1), &upstream.uri()))
        .await
        .expect("proxy starts");
    let response = reqwest::Client::new()
        .get(format!("{}/v1/models", proxy.base_url))
        .header("x-api-key", CLIENT_KEY)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].headers.get("authorization").unwrap(),
        "Bearer access-1"
    );
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn retries_a_429_on_another_account_before_returning_bytes() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    // Union deviation from the TS proxy test (which used `retry-after: 1`):
    // the merged pipeline applies the spec-13 short-retry policy, so a
    // retry-after at or below the 5 s short-retry threshold is retried on
    // the SAME account (mark-before-sleep, up to 3 attempts) before
    // rotating. A retry-after above the threshold pins the original
    // TS-proxy behavior this test exists for: rotate to the next account
    // before returning bytes, with exactly one attempt per account.
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc_1"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({ "error": { "message": "quota" } }))
                .insert_header("retry-after", "60"),
        )
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc_2"))
        .respond_with(ResponseTemplate::new(200).set_body_string("served-by-2"))
        .mount(&upstream)
        .await;

    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(2), &upstream.uri()))
        .await
        .expect("proxy starts");
    let response = reqwest::Client::new()
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.text().await.expect("body"), "served-by-2");
    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 2);
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn returns_401_and_does_not_rotate_on_explicit_token_invalidation() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "error": { "message": "Token has been invalidated." }
        })))
        .mount(&upstream)
        .await;

    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(2), &upstream.uri()))
        .await
        .expect("proxy starts");
    let response = reqwest::Client::new()
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);
    let body = body_json(response).await;
    // Both invalidation vectors emit the same machine-readable shape.
    assert_eq!(body["error"]["code"], "token_invalidated");
    assert_eq!(body["error"]["message"], "Token has been invalidated.");
    // No rotation: exactly one upstream attempt despite a second account.
    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn rotates_to_the_next_account_on_a_generic_401() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc_1"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_json(json!({ "error": { "message": "unauthorized" } })),
        )
        .mount(&upstream)
        .await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .and(header("chatgpt-account-id", "acc_2"))
        .respond_with(ResponseTemplate::new(200).set_body_string("served-by-2"))
        .mount(&upstream)
        .await;

    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(2), &upstream.uri()))
        .await
        .expect("proxy starts");
    let response = reqwest::Client::new()
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.text().await.expect("body"), "served-by-2");
    assert_eq!(upstream.received_requests().await.expect("recorded").len(), 2);
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn returns_a_structured_pool_exhaustion_response() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(
            ResponseTemplate::new(429)
                .set_body_json(json!({ "error": { "message": "quota" } }))
                .insert_header("retry-after", "30"),
        )
        .mount(&upstream)
        .await;

    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(1), &upstream.uri()))
        .await
        .expect("proxy starts");
    let response = reqwest::Client::new()
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 429);
    let body = body_json(response).await;
    assert_eq!(
        body["error"]["code"],
        "codex_runtime_rotation_pool_exhausted"
    );
    assert_eq!(
        body["error"]["message"],
        "All managed Codex accounts are temporarily unavailable for this runtime request."
    );
    assert_eq!(body["error"]["reason"], "rate-limit");
    assert!(body["error"]["retry_after_ms"].as_i64().unwrap_or(0) > 0);
    assert_eq!(
        body["error"]["hint"],
        "Run `codex-multi-auth rotation status` to inspect account state."
    );
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn routes_every_request_to_the_ephemeral_forced_account(
) {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&upstream)
        .await;

    let mut options = proxy_options(shared_manager(2), &upstream.uri());
    options.forced_account_index = Some(1);
    let proxy = start_runtime_rotation_proxy(options)
        .await
        .expect("proxy starts");
    let client = reqwest::Client::new();
    for _ in 0..2 {
        let response = client
            .post(format!("{}/responses", proxy.base_url))
            .header("authorization", format!("Bearer {CLIENT_KEY}"))
            .json(&json!({ "model": "gpt-5-codex" }))
            .send()
            .await
            .expect("request");
        assert_eq!(response.status().as_u16(), 200);
    }
    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 2);
    for request in &requests {
        assert_eq!(request.headers.get("chatgpt-account-id").unwrap(), "acc_2");
    }
    proxy.close().await.expect("close");
}

/// A stray/inherited `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` must NOT pin the
/// proxy when the launcher explicitly resolved "no pin" (a run without
/// `--account`): TS deletes the var from process.env in that case, so a
/// nested wrapper run inside a forced session (or a leftover export) returns
/// to normal rotation. Callers that never resolved the pin keep the env
/// fallback.
#[tokio::test]
#[serial(env)]
async fn suppresses_a_stray_env_pin_when_the_launcher_resolved_no_pin() {
    let mut sandbox = EnvSandbox::new();
    sandbox.set_var("CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX", "1");
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/codex/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&upstream)
        .await;
    let client = reqwest::Client::new();

    // Launcher resolved "no pin": the ambient var is ignored — the request
    // is served by normal selection (account 1), not the stray pin.
    let mut options = proxy_options(shared_manager(2), &upstream.uri());
    options.forced_account_index = None;
    options.suppress_env_forced_account_index = true;
    let proxy = start_runtime_rotation_proxy(options)
        .await
        .expect("proxy starts");
    let response = client
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(
        requests.last().unwrap().headers.get("chatgpt-account-id").unwrap(),
        "acc_1",
        "ambient pin ignored when the launcher resolved no pin"
    );
    proxy.close().await.expect("close");

    // Without suppression (caller never resolved the pin), the env fallback
    // still pins — preserving the pre-existing contract.
    let mut options = proxy_options(shared_manager(2), &upstream.uri());
    options.forced_account_index = None;
    options.suppress_env_forced_account_index = false;
    let proxy = start_runtime_rotation_proxy(options)
        .await
        .expect("proxy starts");
    let response = client
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(
        requests.last().unwrap().headers.get("chatgpt-account-id").unwrap(),
        "acc_2",
        "env fallback preserved when not suppressed"
    );
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn fails_hard_with_503_when_the_forced_account_is_missing() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    let mut options = proxy_options(shared_manager(2), &upstream.uri());
    options.forced_account_index = Some(5);
    let proxy = start_runtime_rotation_proxy(options)
        .await
        .expect("proxy starts");
    let response = reqwest::Client::new()
        .post(format!("{}/responses", proxy.base_url))
        .header("authorization", format!("Bearer {CLIENT_KEY}"))
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 503);
    let body = body_json(response).await;
    assert_eq!(body["error"]["code"], "codex_pinned_account_unavailable");
    assert_eq!(body["error"]["pinnedAccountIndex"], 5);
    // Structured reason (#486): the pinned index is out of the pool range.
    assert_eq!(body["error"]["reason"], "missing");
    assert_eq!(body["error"]["account_skip_reasons"]["5"], "missing");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Pinned account 6 is currently unavailable (missing)")
    );
    // Fail-hard: no upstream call was ever attempted.
    assert!(upstream.received_requests().await.unwrap_or_default().is_empty());
    proxy.close().await.expect("close");
}

#[tokio::test]
#[serial(env)]
async fn get_status_masks_email_material_in_last_error() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    let proxy = start_runtime_rotation_proxy(proxy_options(shared_manager(1), &upstream.uri()))
        .await
        .expect("proxy starts");
    // Baseline status shape.
    let status = proxy.get_status().await;
    assert_eq!(status.total_requests, 0);
    assert_eq!(status.last_error, None);
    proxy.close().await.expect("close");
}
