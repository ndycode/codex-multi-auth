//! Port of `test/local-bridge.test.ts` — loopback + requireAuth invariants,
//! header hygiene, upstream failure mapping, and usage-ledger rows with
//! `source: "local-bridge"`.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use cma_auth::local_client_tokens::{LocalClientTokenRecord, create_local_client_token_record};
use cma_proxy::local_bridge::{LocalBridgeOptions, VerifyBearerTokenFn, start_local_bridge};
use cma_testkit::sandbox::EnvSandbox;
use serde_json::{Value, json};
use serial_test::serial;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn record() -> LocalClientTokenRecord {
    create_local_client_token_record(Some("test"), None).record
}

/// A verify seam that accepts everything and counts invocations.
fn accept_all(counter: Arc<AtomicUsize>) -> VerifyBearerTokenFn {
    Arc::new(move |_authorization, _now| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(Some(record())) })
    })
}

/// A verify seam that rejects everything (returns `None`).
fn reject_all() -> VerifyBearerTokenFn {
    Arc::new(|_authorization, _now| Box::pin(async move { Ok(None) }))
}

async fn body_json(response: reqwest::Response) -> Value {
    serde_json::from_str(&response.text().await.expect("body text")).expect("json body")
}

fn read_ledger_rows(sandbox: &EnvSandbox) -> Vec<Value> {
    let path = sandbox
        .codex_multi_auth_dir()
        .join("usage")
        .join("usage-ledger.jsonl");
    match std::fs::read_to_string(path) {
        Ok(content) => content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("ledger row json"))
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tokio::test]
#[serial(env)]
async fn startup_validation_uses_the_frozen_error_messages() {
    let _sandbox = EnvSandbox::new();

    let error = start_local_bridge(LocalBridgeOptions {
        host: Some("0.0.0.0".to_string()),
        runtime_base_url: "http://127.0.0.1:1456".to_string(),
        ..Default::default()
    })
    .await
    .expect_err("non-loopback bind host");
    assert_eq!(error, "Local bridge only supports loopback hosts.");

    let error = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: "   ".to_string(),
        ..Default::default()
    })
    .await
    .expect_err("empty runtimeBaseUrl");
    assert_eq!(error, "Local bridge requires a runtimeBaseUrl.");

    let error = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: "not a url".to_string(),
        ..Default::default()
    })
    .await
    .expect_err("invalid runtimeBaseUrl");
    assert_eq!(
        error,
        "Local bridge runtimeBaseUrl is not a valid URL: not a url"
    );

    let error = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: "https://example.com/backend".to_string(),
        ..Default::default()
    })
    .await
    .expect_err("non-loopback runtimeBaseUrl");
    assert_eq!(
        error,
        "Local bridge refuses to forward to non-loopback runtimeBaseUrl host \"example.com\". It must target the loopback runtime proxy."
    );

    let error = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: "http://127.0.0.1:1456".to_string(),
        runtime_client_api_key: Some("runtime-key".to_string()),
        require_auth: Some(false),
        ..Default::default()
    })
    .await
    .expect_err("key without inbound auth");
    assert_eq!(
        error,
        "Local bridge requires requireAuth=true when runtimeClientApiKey is configured."
    );
}

#[tokio::test]
#[serial(env)]
async fn health_needs_no_auth_and_reports_the_trimmed_runtime_base_url() {
    let _sandbox = EnvSandbox::new();
    let bridge = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: "http://127.0.0.1:1456///".to_string(),
        verify_bearer_token: Some(reject_all()),
        ..Default::default()
    })
    .await
    .expect("bridge starts");

    let response = reqwest::get(format!("{}/health", bridge.base_url))
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    let body = body_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["service"], "codex-multi-auth-local-bridge");
    // Trailing slashes stripped at startup.
    assert_eq!(body["runtimeBaseUrl"], "http://127.0.0.1:1456");
    bridge.close().await;
}

#[tokio::test]
#[serial(env)]
async fn unknown_paths_and_methods_get_the_stable_404() {
    let _sandbox = EnvSandbox::new();
    let bridge = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: "http://127.0.0.1:1456".to_string(),
        verify_bearer_token: Some(accept_all(Arc::new(AtomicUsize::new(0)))),
        ..Default::default()
    })
    .await
    .expect("bridge starts");
    let client = reqwest::Client::new();

    for (send_method, url) in [
        (reqwest::Method::GET, format!("{}/v1/other", bridge.base_url)),
        // Method mismatches fall through to the catch-all 404.
        (reqwest::Method::POST, format!("{}/v1/models", bridge.base_url)),
        (reqwest::Method::GET, format!("{}/v1/responses", bridge.base_url)),
        (reqwest::Method::POST, format!("{}/health", bridge.base_url)),
    ] {
        let response = client
            .request(send_method.clone(), &url)
            .send()
            .await
            .expect("request");
        assert_eq!(response.status().as_u16(), 404, "{send_method} {url}");
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "local_bridge_not_found");
        assert_eq!(
            body["error"]["message"],
            "Local bridge only accepts /health, /v1/models, and /v1/responses."
        );
    }
    bridge.close().await;
}

#[tokio::test]
#[serial(env)]
async fn rejects_unauthenticated_requests_with_401() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    let bridge = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: upstream.uri(),
        verify_bearer_token: Some(reject_all()),
        ..Default::default()
    })
    .await
    .expect("bridge starts");

    let response = reqwest::Client::new()
        .get(format!("{}/v1/models", bridge.base_url))
        .header("authorization", "Bearer nope")
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "application/json; charset=utf-8"
    );
    let body = body_json(response).await;
    assert_eq!(body["error"]["code"], "local_bridge_unauthorized");
    assert_eq!(
        body["error"]["message"],
        "Local bridge rejected an unauthenticated request."
    );
    // Nothing crossed the bridge.
    assert!(upstream.received_requests().await.unwrap_or_default().is_empty());
    bridge.close().await;
}

#[tokio::test]
#[serial(env)]
async fn forwards_with_the_runtime_client_key_and_scrubs_inbound_credentials() {
    let sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "data": [] }))
                .insert_header("x-upstream", "yes"),
        )
        .mount(&upstream)
        .await;

    let verified = Arc::new(AtomicUsize::new(0));
    let bridge = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: upstream.uri(),
        verify_bearer_token: Some(accept_all(Arc::clone(&verified))),
        runtime_client_api_key: Some("runtime-key".to_string()),
        ..Default::default()
    })
    .await
    .expect("bridge starts");

    let response = reqwest::Client::new()
        .get(format!("{}/v1/models", bridge.base_url))
        .header("authorization", "Bearer cma_local_secret")
        .header("x-api-key", "leak")
        .header("cookie", "sid=1")
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    // content-encoding never reaches the client (the header-filter contract
    // is pinned in the local_bridge unit tests; the HTTP client also decodes
    // upstream bodies before the bridge re-streams them).
    assert!(response.headers().get("content-encoding").is_none());
    assert_eq!(response.headers().get("x-upstream").unwrap(), "yes");
    assert_eq!(verified.load(Ordering::SeqCst), 1);

    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
    let forwarded = &requests[0];
    // The inbound (validated) token is REPLACED by the runtime client key.
    assert_eq!(
        forwarded.headers.get("authorization").unwrap(),
        "Bearer runtime-key"
    );
    assert!(forwarded.headers.get("x-api-key").is_none());
    assert!(forwarded.headers.get("cookie").is_none());

    // Ledger row: source local-bridge, operation models, outcome success.
    let rows = read_ledger_rows(&sandbox);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["source"], "local-bridge");
    assert_eq!(rows[0]["operation"], "models");
    assert_eq!(rows[0]["outcome"], "success");
    assert_eq!(rows[0]["statusCode"], 200);
    bridge.close().await;
}

#[tokio::test]
#[serial(env)]
async fn drops_the_inbound_authorization_when_no_runtime_key_is_configured() {
    let _sandbox = EnvSandbox::new();
    let upstream = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_string("data: ok\n\n"))
        .mount(&upstream)
        .await;
    let bridge = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: upstream.uri(),
        verify_bearer_token: Some(accept_all(Arc::new(AtomicUsize::new(0)))),
        ..Default::default()
    })
    .await
    .expect("bridge starts");

    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", bridge.base_url))
        .header("authorization", "Bearer cma_local_secret")
        .json(&json!({ "model": "gpt-5-codex" }))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.text().await.expect("body"), "data: ok\n\n");

    let requests = upstream.received_requests().await.expect("recorded");
    assert_eq!(requests.len(), 1);
    // Never leak the caller's bridge token upstream.
    assert!(requests[0].headers.get("authorization").is_none());
    assert_eq!(
        requests[0].body,
        serde_json::to_vec(&json!({ "model": "gpt-5-codex" })).unwrap()
    );
    bridge.close().await;
}

#[tokio::test]
#[serial(env)]
async fn maps_unreachable_upstreams_to_502_and_records_the_failure_row() {
    let sandbox = EnvSandbox::new();
    let bridge = start_local_bridge(LocalBridgeOptions {
        // Nothing listens on port 9 (discard) — the fetch fails fast.
        runtime_base_url: "http://127.0.0.1:9".to_string(),
        require_auth: Some(false),
        ..Default::default()
    })
    .await
    .expect("bridge starts");

    let response = reqwest::Client::new()
        .get(format!("{}/v1/models", bridge.base_url))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 502);
    let body = body_json(response).await;
    assert_eq!(body["error"]["code"], "local_bridge_upstream_error");
    assert_eq!(
        body["error"]["message"],
        "Local bridge failed to reach the runtime proxy."
    );
    let rows = read_ledger_rows(&sandbox);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["source"], "local-bridge");
    assert_eq!(rows[0]["outcome"], "failure");
    assert_eq!(rows[0]["statusCode"], 502);
    assert_eq!(rows[0]["errorCode"], "local_bridge_upstream_error");
    bridge.close().await;
}

#[tokio::test]
#[serial(env)]
async fn accepts_bracketed_ipv6_loopback_runtime_base_urls() {
    let _sandbox = EnvSandbox::new();
    // `new URL("http://[::1]:1456").hostname` yields "[::1]" — the bracketed
    // form must count as loopback (TS regression).
    let bridge = start_local_bridge(LocalBridgeOptions {
        runtime_base_url: "http://[::1]:1456".to_string(),
        verify_bearer_token: Some(reject_all()),
        ..Default::default()
    })
    .await
    .expect("bracketed IPv6 loopback accepted");
    bridge.close().await;
}
