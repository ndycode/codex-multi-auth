//! Port of `lib/local-bridge.ts` — the loopback HTTP façade in front of the
//! runtime rotation proxy (spec 07 §10; ARCHITECTURE §6.13).
//!
//! Surfaces ONLY `/health`, `GET /v1/models`, and `POST /v1/responses`;
//! everything else is a 404. Invariants (all frozen strings / stable codes):
//! - bind host AND `runtimeBaseUrl` must both be loopback (egress guard —
//!   runtime-proxy-02);
//! - `runtimeClientApiKey` set ⇒ `requireAuth` MUST be true (otherwise the
//!   bridge becomes an open local capability proxy);
//! - inbound `x-api-key`/`cookie`/`proxy-authorization` never cross the
//!   bridge; the inbound `authorization` is REPLACED by the runtime client
//!   key (or dropped entirely when none is configured);
//! - bearer auth via `cma_auth::local_client_tokens`;
//! - usage ledger rows with `source: "local-bridge"`;
//! - error codes: `local_bridge_unauthorized` (401),
//!   `local_bridge_upstream_error` (502), `local_bridge_not_found` (404),
//!   `local_bridge_error` (500).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use bytes::Bytes;
use futures::StreamExt;
use futures::future::BoxFuture;
use http::{HeaderMap, Request, Response};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Incoming;
use serde_json::json;

use cma_auth::local_client_tokens::{LocalClientTokenRecord, verify_local_client_bearer_token};
use cma_core::json_io::stringify_compact;
use cma_usage::ledger::append_usage_ledger_row;
use cma_usage::types::UsageLedgerAppendInput;

/// The bridge's response body type (buffered JSON or streamed upstream body).
pub type BridgeBody = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

fn full_body(text: impl Into<Bytes>) -> BridgeBody {
    Full::new(text.into())
        .map_err(|never| match never {})
        .boxed()
}

/// Injectable `verifyBearerToken` seam (TS default:
/// `verifyLocalClientBearerToken`). Arguments: the raw `authorization`
/// header value (if any) and `startedAt` (epoch ms).
pub type VerifyBearerTokenFn = Arc<
    dyn Fn(Option<String>, i64) -> BoxFuture<'static, std::io::Result<Option<LocalClientTokenRecord>>>
        + Send
        + Sync,
>;

/// TS `LocalBridgeOptions`.
#[derive(Clone, Default)]
pub struct LocalBridgeOptions {
    /// Default `"127.0.0.1"`.
    pub host: Option<String>,
    /// Default `0` (ephemeral, OS-assigned).
    pub port: Option<u16>,
    /// REQUIRED; must be loopback.
    pub runtime_base_url: String,
    /// Replaces the TS `fetchImpl` seam.
    pub fetch_client: Option<reqwest::Client>,
    /// Default `true`.
    pub require_auth: Option<bool>,
    /// Default: [`verify_local_client_bearer_token`].
    pub verify_bearer_token: Option<VerifyBearerTokenFn>,
    /// Client API key for an auth-enabled runtime proxy (runtime-proxy-03).
    pub runtime_client_api_key: Option<String>,
}

/// TS `LocalBridgeServer`.
pub struct LocalBridgeServer {
    /// Bind host in its RAW literal form (`"::1"`, not `"[::1]"`).
    pub host: String,
    pub port: u16,
    /// `http://<urlHost>:<port>` with the BRACKETED IPv6 form.
    pub base_url: String,
    accept_task: tokio::task::JoinHandle<()>,
    connections: Arc<StdMutex<Vec<tokio::task::AbortHandle>>>,
    closed: AtomicBool,
}

impl std::fmt::Debug for LocalBridgeServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalBridgeServer")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("base_url", &self.base_url)
            .finish()
    }
}

impl LocalBridgeServer {
    /// TS `close()` — stop accepting and destroy every tracked connection.
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.accept_task.abort();
        let handles: Vec<tokio::task::AbortHandle> = {
            let mut connections = self
                .connections
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            connections.drain(..).collect()
        };
        for handle in handles {
            handle.abort();
        }
    }
}

impl Drop for LocalBridgeServer {
    fn drop(&mut self) {
        self.accept_task.abort();
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        for handle in connections.drain(..) {
            handle.abort();
        }
    }
}

// ---------------------------------------------------------------------------
// Host / header helpers (TS parity — the bridge has its OWN copies)
// ---------------------------------------------------------------------------

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().to_lowercase();
    // `new URL("http://[::1]:p").hostname` yields the bracketed form, so the
    // IPv6 loopback runtimeBaseUrl must match here too.
    normalized == "127.0.0.1"
        || normalized == "localhost"
        || normalized == "::1"
        || normalized == "[::1]"
}

fn strip_ipv6_brackets(host: &str) -> &str {
    let trimmed = host.trim();
    if let Some(stripped) = trimmed.strip_prefix('[')
        && let Some(stripped) = stripped.strip_suffix(']')
    {
        return stripped;
    }
    trimmed
}

fn to_bind_host(host: &str) -> String {
    strip_ipv6_brackets(host).to_string()
}

fn to_url_host(host: &str) -> String {
    let bare = strip_ipv6_brackets(host);
    if bare.contains(':') {
        format!("[{bare}]")
    } else {
        bare.to_string()
    }
}

const HOP_BY_HOP_HEADERS: [&str; 10] = [
    "connection",
    "content-length",
    "expect",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// TS bridge-local `responseHeadersForClient` — drops hop-by-hop headers AND
/// `content-encoding` (the HTTP client auto-decodes; keeping the header would
/// corrupt the client's view). Deliberately does NOT strip anything else —
/// this is the bridge's own filter, not the proxy's.
fn response_headers_for_client(headers: &HeaderMap) -> Vec<(String, String)> {
    let mut result: Vec<(String, String)> = Vec::new();
    for (name, value) in headers {
        let key = name.as_str();
        if HOP_BY_HOP_HEADERS.contains(&key) || key == "content-encoding" {
            continue;
        }
        let Ok(value) = value.to_str() else {
            continue;
        };
        result.push((key.to_string(), value.to_string()));
    }
    result
}

/// TS `forwardHeaders(headers, runtimeClientApiKey)` — order matters.
fn forward_headers(headers: &HeaderMap, runtime_client_api_key: Option<&str>) -> HeaderMap {
    let mut result = headers.clone();
    for name in HOP_BY_HOP_HEADERS {
        result.remove(name);
    }
    result.remove("host");
    // runtime-proxy-02: never forward inbound client credentials upstream.
    result.remove("x-api-key");
    result.remove("cookie");
    result.remove("proxy-authorization");
    // runtime-proxy-03: present the runtime proxy's client token — replace
    // the (already validated) inbound Authorization, or strip it entirely.
    match runtime_client_api_key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => {
            if let Ok(value) = http::header::HeaderValue::from_str(&format!("Bearer {key}")) {
                result.insert("authorization", value);
            }
        }
        None => {
            result.remove("authorization");
        }
    }
    result
}

// ---------------------------------------------------------------------------
// JSON responses (stable error codes)
// ---------------------------------------------------------------------------

fn json_response(status: u16, content_type: &str, payload: &serde_json::Value) -> Response<BridgeBody> {
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(full_body(stringify_compact(payload)))
        .expect("static response")
}

fn unauthorized_response() -> Response<BridgeBody> {
    json_response(
        401,
        "application/json; charset=utf-8",
        &json!({
            "error": {
                "message": "Local bridge rejected an unauthenticated request.",
                "code": "local_bridge_unauthorized",
            }
        }),
    )
}

fn upstream_error_response() -> Response<BridgeBody> {
    json_response(
        502,
        "application/json; charset=utf-8",
        &json!({
            "error": {
                "message": "Local bridge failed to reach the runtime proxy.",
                "code": "local_bridge_upstream_error",
            }
        }),
    )
}

fn not_found_response() -> Response<BridgeBody> {
    json_response(
        404,
        "application/json",
        &json!({
            "error": {
                "message": "Local bridge only accepts /health, /v1/models, and /v1/responses.",
                "code": "local_bridge_not_found",
            }
        }),
    )
}

/// TS handler-level 500 (`local_bridge_error`) — note the trailing `\n`.
fn bridge_error_response() -> Response<BridgeBody> {
    let payload = json!({
        "error": {
            "message": "Local bridge failed before forwarding the request.",
            "code": "local_bridge_error",
        }
    });
    Response::builder()
        .status(500)
        .header("content-type", "application/json; charset=utf-8")
        .body(full_body(format!("{}\n", stringify_compact(&payload))))
        .expect("static response")
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

struct BridgeShared {
    runtime_base_url: String,
    fetch_client: reqwest::Client,
    require_auth: bool,
    verify_bearer_token: VerifyBearerTokenFn,
    runtime_client_api_key: Option<String>,
}

/// TS `startLocalBridge(options)`. Startup validation failures return the
/// exact TS `Error` message strings.
pub async fn start_local_bridge(options: LocalBridgeOptions) -> Result<LocalBridgeServer, String> {
    let host = options
        .host
        .clone()
        .unwrap_or_else(|| "127.0.0.1".to_string());
    if !is_loopback_host(&host) {
        return Err("Local bridge only supports loopback hosts.".to_string());
    }
    let bind_host = to_bind_host(&host);
    let url_host = to_url_host(&host);
    let runtime_base_url = options
        .runtime_base_url
        .trim()
        .trim_end_matches('/')
        .to_string();
    if runtime_base_url.is_empty() {
        return Err("Local bridge requires a runtimeBaseUrl.".to_string());
    }
    // Egress guard (runtime-proxy-02): the bridge forwards credentials to
    // runtimeBaseUrl — it must be the loopback runtime proxy, never remote.
    let runtime_host = match reqwest::Url::parse(&runtime_base_url) {
        Ok(url) => url
            .host_str()
            .map(str::to_string)
            .unwrap_or_default(),
        Err(_) => {
            return Err(format!(
                "Local bridge runtimeBaseUrl is not a valid URL: {runtime_base_url}"
            ));
        }
    };
    if !is_loopback_host(&runtime_host) {
        return Err(format!(
            "Local bridge refuses to forward to non-loopback runtimeBaseUrl host \"{runtime_host}\". It must target the loopback runtime proxy."
        ));
    }
    let port = options.port.unwrap_or(0);
    let require_auth = options.require_auth.unwrap_or(true);
    let runtime_client_api_key = options
        .runtime_client_api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string);
    if runtime_client_api_key.is_some() && !require_auth {
        // Security: key injection without inbound auth = open local
        // capability proxy. Fail fast.
        return Err(
            "Local bridge requires requireAuth=true when runtimeClientApiKey is configured."
                .to_string(),
        );
    }
    let verify_bearer_token: VerifyBearerTokenFn =
        options.verify_bearer_token.clone().unwrap_or_else(|| {
            Arc::new(|authorization, started_at| {
                Box::pin(async move {
                    verify_local_client_bearer_token(authorization.as_deref(), Some(started_at))
                        .await
                })
            })
        });
    let shared = Arc::new(BridgeShared {
        runtime_base_url,
        fetch_client: options.fetch_client.clone().unwrap_or_default(),
        require_auth,
        verify_bearer_token,
        runtime_client_api_key,
    });

    let listener = tokio::net::TcpListener::bind((bind_host.as_str(), port))
        .await
        .map_err(|error| format!("listen {bind_host}:{port}: {error}"))?;
    let resolved_port = listener
        .local_addr()
        .map(|address| address.port())
        .unwrap_or(port);

    let connections: Arc<StdMutex<Vec<tokio::task::AbortHandle>>> =
        Arc::new(StdMutex::new(Vec::new()));
    let accept_connections = Arc::clone(&connections);
    let accept_shared = Arc::clone(&shared);
    let accept_task = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let connection_shared = Arc::clone(&accept_shared);
                    let handle = tokio::spawn(async move {
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let service = hyper::service::service_fn(move |req: Request<Incoming>| {
                            let shared = Arc::clone(&connection_shared);
                            async move {
                                Ok::<_, std::convert::Infallible>(handle_request(shared, req).await)
                            }
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(io, service)
                            .await;
                    });
                    let mut tracked = accept_connections
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    tracked.retain(|existing| !existing.is_finished());
                    tracked.push(handle.abort_handle());
                }
                Err(_) => {
                    // Accept errors are transient; keep serving (the TS
                    // server had no error path here at all).
                }
            }
        }
    });

    Ok(LocalBridgeServer {
        host: bind_host,
        port: resolved_port,
        base_url: format!("http://{url_host}:{resolved_port}"),
        accept_task,
        connections,
        closed: AtomicBool::new(false),
    })
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async fn handle_request(shared: Arc<BridgeShared>, req: Request<Incoming>) -> Response<BridgeBody> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    if method == http::Method::GET && path == "/health" {
        return json_response(
            200,
            "application/json",
            &json!({
                "ok": true,
                "service": "codex-multi-auth-local-bridge",
                "runtimeBaseUrl": shared.runtime_base_url,
            }),
        );
    }
    let target_path = if method == http::Method::GET && path == "/v1/models" {
        "/v1/models"
    } else if method == http::Method::POST && path == "/v1/responses" {
        "/v1/responses"
    } else {
        return not_found_response();
    };
    forward(shared, req, target_path).await
}

async fn forward(
    shared: Arc<BridgeShared>,
    req: Request<Incoming>,
    target_path: &str,
) -> Response<BridgeBody> {
    let started_at = cma_core::utils::now_ms();
    let (parts, body) = req.into_parts();

    if shared.require_auth {
        let authorization = parts
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        match (shared.verify_bearer_token)(authorization, started_at).await {
            Ok(Some(_record)) => {}
            Ok(None) => return unauthorized_response(),
            // TS: a rejected verify promise escapes `forward` and hits the
            // server-level handler → 500 `local_bridge_error`.
            Err(_) => return bridge_error_response(),
        }
    }

    // Body: fully buffered inbound bytes (NOT streamed upstream — TS parity).
    let body_bytes: Option<Bytes> =
        if parts.method == http::Method::GET || parts.method == http::Method::HEAD {
            None
        } else {
            match body.collect().await {
                Ok(collected) => Some(collected.to_bytes()),
                Err(_) => return bridge_error_response(),
            }
        };

    let operation = if target_path == "/v1/models" {
        "models"
    } else {
        "responses"
    };
    let target_url = format!("{}{}", shared.runtime_base_url, target_path);
    let mut request_builder = shared
        .fetch_client
        .request(parts.method.clone(), &target_url)
        .headers(forward_headers(
            &parts.headers,
            shared.runtime_client_api_key.as_deref(),
        ));
    if let Some(bytes) = body_bytes {
        request_builder = request_builder.body(bytes);
    }
    let upstream = match request_builder.send().await {
        Ok(upstream) => upstream,
        Err(_) => {
            let _ = append_usage_ledger_row(&UsageLedgerAppendInput {
                source: Some("local-bridge".to_string()),
                operation: Some(operation.to_string()),
                outcome: Some("failure".to_string()),
                status_code: Some(502.0),
                error_code: Some("local_bridge_upstream_error".to_string()),
                duration_ms: Some((cma_core::utils::now_ms() - started_at) as f64),
                ..Default::default()
            })
            .await;
            return upstream_error_response();
        }
    };

    let status = upstream.status().as_u16();
    let ok = upstream.status().is_success();
    let _ = append_usage_ledger_row(&UsageLedgerAppendInput {
        source: Some("local-bridge".to_string()),
        operation: Some(operation.to_string()),
        outcome: Some(if ok { "success" } else { "failure" }.to_string()),
        status_code: Some(status as f64),
        duration_ms: Some((cma_core::utils::now_ms() - started_at) as f64),
        ..Default::default()
    })
    .await;

    // Respond with upstream status, filtered headers, and the STREAMED body
    // (SSE flows through).
    let client_headers = response_headers_for_client(upstream.headers());
    let stream = upstream.bytes_stream().map(|item| {
        item.map(hyper::body::Frame::data)
            .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> { Box::new(error) })
    });
    let body: BridgeBody = BodyExt::boxed(StreamBody::new(stream));
    let mut builder = Response::builder().status(status);
    for (name, value) in client_headers {
        builder = builder.header(name, value);
    }
    builder.body(body).unwrap_or_else(|_| bridge_error_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                name.parse::<http::header::HeaderName>().unwrap(),
                http::header::HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn forward_headers_replace_authorization_with_runtime_key() {
        let inbound = headers(&[
            ("authorization", "Bearer cma_local_token"),
            ("x-api-key", "leak"),
            ("cookie", "sid=1"),
            ("proxy-authorization", "Basic x"),
            ("host", "127.0.0.1:9"),
            ("connection", "keep-alive"),
            ("content-type", "application/json"),
        ]);
        let forwarded = forward_headers(&inbound, Some("  runtime-key  "));
        assert_eq!(forwarded.get("authorization").unwrap(), "Bearer runtime-key");
        assert!(forwarded.get("x-api-key").is_none());
        assert!(forwarded.get("cookie").is_none());
        assert!(forwarded.get("proxy-authorization").is_none());
        assert!(forwarded.get("host").is_none());
        assert!(forwarded.get("connection").is_none());
        assert_eq!(forwarded.get("content-type").unwrap(), "application/json");
    }

    #[test]
    fn forward_headers_drop_authorization_without_runtime_key() {
        let inbound = headers(&[("authorization", "Bearer cma_local_token")]);
        assert!(forward_headers(&inbound, None).get("authorization").is_none());
        // Blank key behaves like no key.
        assert!(
            forward_headers(&inbound, Some("   "))
                .get("authorization")
                .is_none()
        );
    }

    #[test]
    fn response_headers_drop_hop_by_hop_and_content_encoding_only() {
        let upstream = headers(&[
            ("content-type", "text/event-stream"),
            ("content-encoding", "gzip"),
            ("transfer-encoding", "chunked"),
            ("x-request-id", "req_1"),
            // The bridge does NOT strip private account headers — that is the
            // runtime proxy's job (TS parity).
            ("x-codex-multi-auth-account-id", "acc_1"),
        ]);
        let mut filtered = response_headers_for_client(&upstream);
        filtered.sort();
        assert_eq!(
            filtered,
            vec![
                ("content-type".to_string(), "text/event-stream".to_string()),
                (
                    "x-codex-multi-auth-account-id".to_string(),
                    "acc_1".to_string()
                ),
                ("x-request-id".to_string(), "req_1".to_string()),
            ]
        );
    }

    #[test]
    fn loopback_matrix_includes_bracketed_ipv6() {
        for host in ["127.0.0.1", "localhost", "::1", "[::1]"] {
            assert!(is_loopback_host(host), "{host}");
        }
        assert!(!is_loopback_host("example.com"));
        assert!(!is_loopback_host("0.0.0.0"));
    }
}
