//! Port of `lib/runtime-rotation-proxy.ts` — the loopback rotation proxy HTTP
//! surface (spec 04 §9; ARCHITECTURE §6.13).
//!
//! A loopback-only HTTP server that authenticates local clients with a shared
//! API key and serves three route families:
//! - `POST /responses` (+ aliases) — handed to [`crate::pipeline::ProxyPipeline`]
//!   (the merged index.ts ∪ proxy request loop, ARCHITECTURE §3 row 1), which
//!   owns selection/refresh/forward/rotation AND the usage-ledger record;
//! - `GET /models` and `/thread/goal/*` — served by this module's own
//!   spec-04 rotation loop (selection, refresh, status mapping, thread-goal
//!   local fallback, pool-exhaustion bodies);
//! - everything else — 404.
//!
//! Contract highlights (spec 04):
//! - loopback-only bind with NO opt-out (`CodexValidationError` field `host`)
//!   and a required `clientApiKey` (field `clientApiKey`), validated BEFORE
//!   serving;
//! - IPv6 normalized ONCE at startup: bind uses the raw literal (`::1`), the
//!   baseUrl uses the bracketed literal (`[::1]`);
//! - client auth (timing-safe, Bearer or `x-api-key`) runs BEFORE path
//!   routing — unknown callers always get 401, never 404 (gotcha 22);
//! - 64 MiB body cap → 413; stable `error.code` payloads per spec 14 §7;
//! - header scrubbing via `cma_request::stream_failover_runtime`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use bytes::Bytes;
use futures::StreamExt;
use http::{HeaderMap, Request, Response};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Incoming;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use cma_accounts::manager::{AccountManager, ManagedAccount};
use cma_accounts::manager_persistence::{SAVE_DEBOUNCE_DEFAULT_MS, SharedAccountManager};
use cma_accounts::session_affinity::{SessionAffinityOptions, SessionAffinityStore};
use cma_config::getters::{
    get_fetch_timeout_ms, get_min_rotation_interval_ms, get_network_error_cooldown_ms,
    get_pid_offset_enabled, get_retry_all_accounts_max_retries, get_routing_mutex_mode,
    get_scheduling_strategy, get_server_error_cooldown_ms, get_session_affinity,
    get_session_affinity_max_entries, get_session_affinity_ttl_ms, get_stream_stall_timeout_ms,
    get_token_invalidation_cooldown_ms, get_token_refresh_skew_ms,
};
use cma_config::load::load_plugin_config;
use cma_core::constants::{
    CODEX_BASE_URL, HTTP_STATUS, OPENAI_HEADER_VALUES, OPENAI_HEADERS, URL_PATHS,
};
use cma_core::errors::CodexError;
use cma_core::json_io::stringify_compact;
use cma_core::logger::{create_logger, mask_string, run_with_correlation_id};
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{CooldownReason, RateLimitReason, SwitchReason};
use cma_core::schemas::plugin_config as core_config;
use cma_core::token_utils::extract_account_id;
use cma_quota::runtime_policy::{
    EvaluateRuntimePolicyInput, RuntimePolicyAccount, RuntimePolicyDecision,
    RuntimeUsageRecordInput, RuntimeUsageRecorder, RuntimeUsageRecorderOptions,
    create_runtime_usage_recorder, evaluate_runtime_policy, load_runtime_policy_state,
};
use cma_request::error_classification::is_workspace_disabled_error;
use cma_request::model_map::CURRENT_CODEX_MODEL;
use cma_request::prompts::codex::get_model_family;
use cma_request::rate_limit_decision::{
    build_pinned_unavailable_error_body, build_token_invalidation_body,
    extract_error_code_from_body, get_quota_near_exhaustion_wait_ms, is_token_invalidation_error,
    normalize_exhaustion_status, parse_retry_after_body_ms, parse_retry_after_header_ms,
};
use cma_request::response_handler::{BodyStream, BoxError, StreamResponse};
use cma_request::stream_failover_runtime::{
    ClientStreamWriter, HOP_BY_HOP_HEADERS, StreamForwardStatus, forward_streaming_response,
    read_error_body, response_headers_for_client, with_timeout,
};
use cma_rotation::routing_mutex::{RoutingMutexMode, with_routing_mutex};
use cma_runtime::observability::{
    mutate_runtime_observability_snapshot, record_runtime_account_recovery,
    record_runtime_pool_exhaustion,
};
use cma_runtime::rotation::account_selection::{
    ChooseAccountParams, choose_account, normalize_forced_account_index,
    normalize_forced_account_index_number,
};
use cma_runtime::rotation::proxy_state::{
    RotationProxyState, RotationProxyStateInit, create_rotation_proxy_state,
    recover_stale_runtime_state,
};
use cma_runtime::rotation::server_types::{
    ExhaustionReason, NowFn, RequestContext, RequestMethod, RuntimeProxyHttpError,
    RuntimeRotationProxyOptions, RuntimeRotationProxyStatus, SchedulingStrategy,
};
use cma_runtime::rotation::storage_meta::read_storage_meta_from_disk;
use cma_runtime::rotation::token_refresh::{
    DEFAULT_AUTH_FAILURE_COOLDOWN_MS, EnsureFreshAccessTokenParams, EnsureFreshAccessTokenResult,
    apply_monotonic_auth_cooldown, ensure_fresh_access_token,
};
use cma_usage::types::{UsageLedgerOperation, UsageLedgerOutcome, UsageLedgerSource};

use crate::client_auth::is_authorized_client;
use crate::pipeline::{ProxyPipeline, load_pipeline_config};

// ---------------------------------------------------------------------------
// Module constants (TS parity)
// ---------------------------------------------------------------------------

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_QUOTA_REMAINING_THRESHOLD: f64 = 10.0;
const DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS: i64 = 4;
/// TS `MAX_REQUEST_BODY_BYTES` = 64 MiB.
pub const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;
/// TS `MAX_THREAD_GOAL_FALLBACKS` — LRU cap of the local thread-goal map.
pub const MAX_THREAD_GOAL_FALLBACKS: usize = 512;

/// The proxy's response body type: either a buffered JSON payload or the
/// streamed upstream body.
pub type ProxyBody = BoxBody<Bytes, BoxError>;

fn full_body(text: impl Into<Bytes>) -> ProxyBody {
    BodyExt::boxed(Full::new(text.into()).map_err(|never| match never {}))
}

// ---------------------------------------------------------------------------
// Host normalization (TS `isLoopbackHost` / `toBindHost` / `toUrlHost`)
// ---------------------------------------------------------------------------

fn is_loopback_host(host: &str) -> bool {
    let normalized = host.trim().to_lowercase();
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

/// Raw literal suitable for the listener bind: `"[::1]"` → `"::1"`.
fn to_bind_host(host: &str) -> String {
    strip_ipv6_brackets(host).to_string()
}

/// URL authority host: IPv6 literals bracketed (`"::1"` → `"[::1]"`).
fn to_url_host(host: &str) -> String {
    let bare = strip_ipv6_brackets(host);
    if bare.contains(':') {
        format!("[{bare}]")
    } else {
        bare.to_string()
    }
}

// ---------------------------------------------------------------------------
// Path discrimination
// ---------------------------------------------------------------------------

fn is_responses_path(pathname: &str) -> bool {
    pathname == URL_PATHS.responses
        || pathname == URL_PATHS.codex_responses
        || pathname == "/v1/responses"
        || pathname == "/v1/codex/responses"
}

fn is_models_path(pathname: &str) -> bool {
    pathname == URL_PATHS.models || pathname == "/v1/models"
}

fn is_thread_goal_path(pathname: &str) -> bool {
    matches!(
        pathname,
        "/thread/goal/get"
            | "/thread/goal/set"
            | "/codex/thread/goal/get"
            | "/codex/thread/goal/set"
    )
}

fn normalize_thread_goal_upstream_path(pathname: &str) -> String {
    if pathname.starts_with("/codex/") {
        pathname.to_string()
    } else {
        format!("/codex{pathname}")
    }
}

// ---------------------------------------------------------------------------
// Shared proxy handle
// ---------------------------------------------------------------------------

/// The pipeline (which owns [`RotationProxyState`]) plus the server-local
/// insertion-order queue for the thread-goal LRU
/// (`RotationProxyState.thread_goal_fallbacks` is a `HashMap`; the TS `Map`
/// was insertion-ordered). Lock order: `thread_goal_order` BEFORE
/// `pipeline.state()`.
struct ProxyShared {
    pipeline: ProxyPipeline,
    thread_goal_order: tokio::sync::Mutex<VecDeque<String>>,
}

/// Immutable per-instance configuration snapshot taken once per request.
#[derive(Clone)]
struct ReqConfig {
    client_api_key: String,
    upstream_base_url: String,
    fetch_client: reqwest::Client,
    now: NowFn,
    routing_mutex_mode: RoutingMutexMode,
    scheduling_strategy: SchedulingStrategy,
    pid_offset_enabled: bool,
    token_refresh_skew_ms: i64,
    network_error_cooldown_ms: i64,
    server_error_cooldown_ms: i64,
    token_invalidation_cooldown_ms: i64,
    min_rotation_interval_ms: i64,
    fetch_timeout_ms: i64,
    stream_stall_timeout_ms: i64,
    max_runtime_account_attempts: i64,
    max_request_body_bytes: usize,
    quota_remaining_percent_threshold: f64,
    session_affinity_store: Option<Arc<StdMutex<SessionAffinityStore>>>,
    forced_account_index: Option<i64>,
}

// ---------------------------------------------------------------------------
// Server handle
// ---------------------------------------------------------------------------

/// TS `RuntimeRotationProxyServer` — the handle returned by
/// [`start_runtime_rotation_proxy`].
pub struct RuntimeRotationProxyServer {
    /// Bind host in its RAW literal form (`"::1"`, not `"[::1]"`).
    pub host: String,
    pub port: u16,
    /// `http://<urlHost>:<port>` with the BRACKETED IPv6 form.
    pub base_url: String,
    shared: Arc<ProxyShared>,
    accept_task: tokio::task::JoinHandle<()>,
    connections: Arc<StdMutex<Vec<tokio::task::AbortHandle>>>,
    closed: AtomicBool,
}

impl RuntimeRotationProxyServer {
    /// TS `close()` — stop accepting, destroy every tracked connection, then
    /// `flushPendingSave()` on the active account manager (propagating its
    /// error, as the TS promise did).
    pub async fn close(&self) -> Result<(), CodexError> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
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
        let manager = {
            let state = self.shared.pipeline.state().await;
            state.active_account_manager.clone()
        };
        manager.flush_pending_save().await
    }

    /// TS `getStatus()` — snapshot copy with `lastError` passed through
    /// `maskString` (errors-logging-08).
    pub async fn get_status(&self) -> RuntimeRotationProxyStatus {
        let state = self.shared.pipeline.state().await;
        let mut status = state.status.clone();
        status.last_error = status.last_error.map(|error| mask_string(&error));
        status
    }

    /// The pipeline handle serving this proxy's `/responses` route (metrics
    /// and state surfaces for the wrapper / report commands).
    pub fn pipeline(&self) -> ProxyPipeline {
        self.shared.pipeline.clone()
    }
}

impl std::fmt::Debug for RuntimeRotationProxyServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeRotationProxyServer")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("base_url", &self.base_url)
            .finish()
    }
}

impl Drop for RuntimeRotationProxyServer {
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
// Startup
// ---------------------------------------------------------------------------

fn map_routing_mutex_mode(mode: core_config::RoutingMutexMode) -> RoutingMutexMode {
    match mode {
        core_config::RoutingMutexMode::Enabled => RoutingMutexMode::Enabled,
        core_config::RoutingMutexMode::Legacy => RoutingMutexMode::Legacy,
    }
}

fn map_scheduling_strategy(strategy: core_config::SchedulingStrategy) -> SchedulingStrategy {
    match strategy {
        core_config::SchedulingStrategy::Hybrid => SchedulingStrategy::Hybrid,
        core_config::SchedulingStrategy::Sequential => SchedulingStrategy::Sequential,
    }
}

/// TS `startRuntimeRotationProxy(options)`.
pub async fn start_runtime_rotation_proxy(
    options: RuntimeRotationProxyOptions,
) -> Result<RuntimeRotationProxyServer, CodexError> {
    let plugin_config = load_plugin_config();
    let active_account_manager = match options.account_manager.clone() {
        Some(manager) => manager,
        None => SharedAccountManager::new(AccountManager::load_from_disk(None).await),
    };
    let routing_mutex_mode = map_routing_mutex_mode(get_routing_mutex_mode(&plugin_config));
    {
        let mut manager = active_account_manager.lock().await;
        manager.set_routing_mutex_mode(routing_mutex_mode);
    }
    let scheduling_strategy = map_scheduling_strategy(get_scheduling_strategy(&plugin_config));
    let fetch_client = options.fetch_client.clone().unwrap_or_default();
    let host = options
        .host
        .clone()
        .unwrap_or_else(|| DEFAULT_HOST.to_string());
    // Defense in depth (runtime-proxy-01): loopback-only with NO opt-out.
    if !is_loopback_host(&host) {
        let mut context = Map::new();
        context.insert("host".to_string(), Value::String(host.clone()));
        return Err(CodexError::validation(format!(
            "Runtime rotation proxy refuses to bind non-loopback host \"{host}\". It forwards managed OAuth tokens and is loopback-only."
        ))
        .with_field("host")
        .with_expected("a loopback host")
        .with_context(context));
    }
    let bind_host = to_bind_host(&host);
    let url_host = to_url_host(&host);
    let port = options.port.unwrap_or(0);
    let upstream_base_url = options
        .upstream_base_url
        .clone()
        .unwrap_or_else(|| CODEX_BASE_URL.to_string());
    let client_api_key = options.client_api_key.trim().to_string();
    if client_api_key.is_empty() {
        return Err(
            CodexError::validation("Runtime rotation proxy requires a clientApiKey.")
                .with_field("clientApiKey")
                .with_expected("a non-empty string"),
        );
    }
    let now: NowFn = options
        .now
        .clone()
        .unwrap_or_else(|| Arc::new(cma_core::utils::now_ms));
    // Ephemeral per-invocation pin (issue #623): explicit option (even 0)
    // wins; `None` defers to the launcher's env. Invalid values collapse to
    // None instead of throwing (chooseAccount reports per-request).
    let forced_account_index = match options.forced_account_index {
        Some(value) => normalize_forced_account_index_number(Some(value as f64)),
        None => normalize_forced_account_index(
            std::env::var("CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX")
                .ok()
                .as_deref(),
        ),
    };
    let token_refresh_skew_ms = get_token_refresh_skew_ms(&plugin_config) as i64;
    let network_error_cooldown_ms = get_network_error_cooldown_ms(&plugin_config) as i64;
    let server_error_cooldown_ms = get_server_error_cooldown_ms(&plugin_config) as i64;
    let token_invalidation_cooldown_ms = get_token_invalidation_cooldown_ms(&plugin_config) as i64;
    let min_rotation_interval_ms = get_min_rotation_interval_ms(&plugin_config) as i64;
    let pid_offset_enabled = get_pid_offset_enabled(&plugin_config);
    let fetch_timeout_ms = options
        .fetch_timeout_ms
        .unwrap_or_else(|| get_fetch_timeout_ms(&plugin_config) as i64);
    let stream_stall_timeout_ms = options
        .stream_stall_timeout_ms
        .unwrap_or_else(|| get_stream_stall_timeout_ms(&plugin_config) as i64);
    let configured_max_retries = get_retry_all_accounts_max_retries(&plugin_config) as i64;
    let max_runtime_account_attempts = if configured_max_retries > 0 {
        configured_max_retries + 1
    } else {
        DEFAULT_MAX_RUNTIME_ACCOUNT_ATTEMPTS
    };
    let max_request_body_bytes = options
        .max_request_body_bytes
        .unwrap_or(MAX_REQUEST_BODY_BYTES);
    let quota_remaining_percent_threshold = options
        .quota_remaining_percent_threshold
        .unwrap_or(DEFAULT_QUOTA_REMAINING_THRESHOLD);
    let session_affinity_store = if get_session_affinity(&plugin_config) {
        Some(Arc::new(StdMutex::new(SessionAffinityStore::new(
            SessionAffinityOptions {
                ttl_ms: Some(get_session_affinity_ttl_ms(&plugin_config) as i64),
                max_entries: Some(get_session_affinity_max_entries(&plugin_config) as i64),
            },
        ))))
    } else {
        None
    };
    // Initialize from disk so the proxy starts in sync with the stored
    // affinity generation; per-request reads detect later CLI bumps (#474).
    let last_observed_affinity_generation = read_storage_meta_from_disk(None).affinity_generation;
    let state = create_rotation_proxy_state(RotationProxyStateInit {
        active_account_manager,
        routing_mutex_mode,
        scheduling_strategy,
        fetch_client,
        upstream_base_url,
        client_api_key,
        now,
        token_refresh_skew_ms,
        network_error_cooldown_ms,
        server_error_cooldown_ms,
        token_invalidation_cooldown_ms,
        min_rotation_interval_ms,
        pid_offset_enabled,
        fetch_timeout_ms,
        stream_stall_timeout_ms,
        max_runtime_account_attempts,
        max_request_body_bytes,
        quota_remaining_percent_threshold,
        session_affinity_store,
        last_observed_affinity_generation,
        forced_account_index,
    });
    // SEAM: the pipeline owns the rotation state; the HTTP surface reads it
    // through `pipeline.state()` and routes `/responses` through
    // `pipeline.handle_responses`.
    let pipeline = ProxyPipeline::new(state, load_pipeline_config(&plugin_config));
    let shared = Arc::new(ProxyShared {
        pipeline,
        thread_goal_order: tokio::sync::Mutex::new(VecDeque::new()),
    });

    let listener = tokio::net::TcpListener::bind((bind_host.as_str(), port))
        .await
        .map_err(|error| CodexError::new(format!("listen {bind_host}:{port}: {error}")))?;
    let resolved_port = listener
        .local_addr()
        .map(|address| address.port())
        .unwrap_or(port);

    let connections: Arc<StdMutex<Vec<tokio::task::AbortHandle>>> =
        Arc::new(StdMutex::new(Vec::new()));
    let accept_shared = Arc::clone(&shared);
    let accept_connections = Arc::clone(&connections);
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
                Err(error) => {
                    // TS post-startup `server.on("error")` — record and keep
                    // serving.
                    let mut state = accept_shared.pipeline.state().await;
                    state.status.last_error = Some(error.to_string());
                }
            }
        }
    });

    Ok(RuntimeRotationProxyServer {
        host: bind_host,
        port: resolved_port,
        base_url: format!("http://{url_host}:{resolved_port}"),
        shared,
        accept_task,
        connections,
        closed: AtomicBool::new(false),
    })
}

// ---------------------------------------------------------------------------
// JSON response helpers (TS `writeJson` — compact JSON + trailing `\n`)
// ---------------------------------------------------------------------------

fn json_response(status: u16, payload: &Value) -> Response<ProxyBody> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json; charset=utf-8")
        .body(full_body(format!("{}\n", stringify_compact(payload))))
        .expect("static response")
}

fn proxy_error_response() -> Response<ProxyBody> {
    json_response(
        500,
        &json!({
            "error": {
                "message": "Runtime rotation proxy failed before forwarding the request.",
                "code": "codex_runtime_rotation_proxy_error",
            }
        }),
    )
}

fn write_unauthorized() -> Response<ProxyBody> {
    json_response(
        HTTP_STATUS.unauthorized,
        &json!({
            "error": {
                "message": "Runtime rotation proxy rejected an unauthenticated local request.",
                "code": "runtime_rotation_proxy_unauthorized",
            }
        }),
    )
}

fn write_method_or_path_error() -> Response<ProxyBody> {
    json_response(
        404,
        &json!({
            "error": {
                "message": "Runtime rotation proxy only accepts Responses API, model discovery, and Codex thread goal requests.",
                "code": "runtime_rotation_proxy_not_found",
            }
        }),
    )
}

// ---------------------------------------------------------------------------
// Request-context construction
// ---------------------------------------------------------------------------

fn parse_request_body(body: &[u8]) -> Option<Map<String, Value>> {
    if body.is_empty() {
        return None;
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn read_string_record_value(record: &Map<String, Value>, key: &str) -> Option<String> {
    let value = record.get(key)?.as_str()?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn resolve_session_key(
    headers: &HeaderMap,
    parsed_body: Option<&Map<String, Value>>,
) -> Option<String> {
    let header_key = header_str(headers, OPENAI_HEADERS.session_id)
        .or_else(|| header_str(headers, OPENAI_HEADERS.conversation_id));
    if let Some(key) = header_key {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let body = parsed_body?;
    if let Some(key) = body.get("prompt_cache_key").and_then(Value::as_str) {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(key) = body.get("previous_response_id").and_then(Value::as_str) {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(metadata) = body.get("metadata").and_then(Value::as_object) {
        return read_string_record_value(metadata, "session_id")
            .or_else(|| read_string_record_value(metadata, "conversation_id"))
            .or_else(|| read_string_record_value(metadata, "thread_id"));
    }
    None
}

fn read_string_search_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let name = parts.next().unwrap_or("");
        if name != key {
            continue;
        }
        let raw = parts.next().unwrap_or("");
        let decoded = percent_decode(raw);
        let trimmed = decoded.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
        return None;
    }
    None
}

/// Minimal `application/x-www-form-urlencoded` component decode (`+` → space,
/// `%XX` → byte) — enough for `URLSearchParams.get` parity on thread ids.
fn percent_decode(raw: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn build_responses_request_context(headers: HeaderMap, body: Vec<u8>) -> RequestContext {
    let parsed_body = parse_request_body(&body);
    let model = parsed_body
        .as_ref()
        .and_then(|parsed| parsed.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let session_key = resolve_session_key(&headers, parsed_body.as_ref());
    let stream = parsed_body
        .as_ref()
        .and_then(|parsed| parsed.get("stream"))
        .and_then(Value::as_bool)
        == Some(true);
    // A model-less request buckets into the CODEX family (fall back to the
    // current codex model, NOT the general default model — gotcha 16).
    let family = get_model_family(model.as_deref().unwrap_or(CURRENT_CODEX_MODEL));
    RequestContext {
        body,
        headers,
        method: RequestMethod::Post,
        upstream_path: URL_PATHS.codex_responses.to_string(),
        model,
        family,
        stream,
        session_key,
    }
}

fn build_models_request_context(headers: HeaderMap) -> RequestContext {
    RequestContext {
        body: Vec::new(),
        headers,
        method: RequestMethod::Get,
        upstream_path: URL_PATHS.models.to_string(),
        model: None,
        family: ModelFamily::Codex,
        stream: false,
        session_key: None,
    }
}

fn build_thread_goal_request_context(
    headers: HeaderMap,
    body: Vec<u8>,
    pathname: &str,
    query: Option<&str>,
    is_get: bool,
) -> RequestContext {
    let parsed_body = parse_request_body(&body);
    let query_thread_key = read_string_search_param(query, "thread_id")
        .or_else(|| read_string_search_param(query, "threadId"));
    let body_thread_key = parsed_body.as_ref().and_then(|parsed| {
        read_string_record_value(parsed, "thread_id")
            .or_else(|| read_string_record_value(parsed, "threadId"))
    });
    let session_key = body_thread_key
        .or(query_thread_key)
        .or_else(|| resolve_session_key(&headers, parsed_body.as_ref()));
    RequestContext {
        body,
        headers,
        method: if is_get {
            RequestMethod::Get
        } else {
            RequestMethod::Post
        },
        upstream_path: normalize_thread_goal_upstream_path(pathname),
        model: None,
        family: ModelFamily::Codex,
        stream: false,
        session_key,
    }
}

fn build_upstream_url(
    upstream_base_url: &str,
    upstream_path: &str,
    query: Option<&str>,
) -> Result<String, HandlerError> {
    let mut upstream = reqwest::Url::parse(upstream_base_url)
        .map_err(|error| HandlerError::Other(format!("Invalid URL: {error}")))?;
    let base_path = upstream.path().trim_end_matches('/').to_string();
    upstream.set_path(&format!("{base_path}{upstream_path}"));
    upstream.set_query(query.filter(|value| !value.is_empty()));
    Ok(upstream.to_string())
}

// ---------------------------------------------------------------------------
// Thread-goal LRU (TS Map insertion-order semantics over the state HashMap)
// ---------------------------------------------------------------------------

fn set_thread_goal_fallback(
    state: &mut RotationProxyState,
    order: &mut VecDeque<String>,
    key: &str,
    goal: Option<String>,
) {
    if state.thread_goal_fallbacks.contains_key(key) {
        state.thread_goal_fallbacks.remove(key);
        order.retain(|existing| existing != key);
    }
    state.thread_goal_fallbacks.insert(key.to_string(), goal);
    order.push_back(key.to_string());
    while state.thread_goal_fallbacks.len() > MAX_THREAD_GOAL_FALLBACKS {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        state.thread_goal_fallbacks.remove(&oldest);
    }
}

fn get_thread_goal_fallback(
    state: &mut RotationProxyState,
    order: &mut VecDeque<String>,
    key: &str,
) -> Option<String> {
    if !state.thread_goal_fallbacks.contains_key(key) {
        return None;
    }
    let goal = state.thread_goal_fallbacks.remove(key).unwrap_or(None);
    order.retain(|existing| existing != key);
    state
        .thread_goal_fallbacks
        .insert(key.to_string(), goal.clone());
    order.push_back(key.to_string());
    goal
}

// ---------------------------------------------------------------------------
// Skip-reason bookkeeping (JS Map insertion order over choose_account's map)
// ---------------------------------------------------------------------------

fn sync_skip_order(ordered: &mut Vec<(i64, String)>, map: &HashMap<i64, String>) {
    for (index, reason) in ordered.iter_mut() {
        if let Some(updated) = map.get(index) {
            *reason = updated.clone();
        }
    }
    let mut new_keys: Vec<i64> = map
        .keys()
        .copied()
        .filter(|key| !ordered.iter().any(|(existing, _)| existing == key))
        .collect();
    new_keys.sort_unstable();
    for key in new_keys {
        ordered.push((key, map[&key].clone()));
    }
}

fn record_skip(
    ordered: &mut Vec<(i64, String)>,
    map: &mut HashMap<i64, String>,
    index: i64,
    reason: &str,
) {
    map.insert(index, reason.to_string());
    sync_skip_order(ordered, map);
}

fn skip_reasons_to_json(ordered: &[(i64, String)]) -> Map<String, Value> {
    let mut reasons = Map::new();
    for (index, reason) in ordered {
        reasons.insert(index.to_string(), Value::String(reason.clone()));
    }
    reasons
}

// ---------------------------------------------------------------------------
// Outbound headers (TS `createOutboundHeaders`)
// ---------------------------------------------------------------------------

fn create_outbound_headers(incoming: &HeaderMap, access_token: &str, account_id: &str) -> HeaderMap {
    let mut headers = incoming.clone();
    for name in HOP_BY_HOP_HEADERS {
        headers.remove(name);
    }
    headers.remove("host");
    headers.remove("x-api-key");
    // Never forward inbound client credentials upstream.
    headers.remove("cookie");
    headers.remove("proxy-authorization");
    let set = |headers: &mut HeaderMap, name: &str, value: &str| {
        if let (Ok(name), Ok(value)) = (
            http::header::HeaderName::from_bytes(name.as_bytes()),
            http::header::HeaderValue::from_str(value),
        ) {
            headers.insert(name, value);
        }
    };
    set(
        &mut headers,
        "authorization",
        &format!("Bearer {access_token}"),
    );
    set(&mut headers, OPENAI_HEADERS.account_id, account_id);
    set(
        &mut headers,
        OPENAI_HEADERS.beta,
        OPENAI_HEADER_VALUES.beta_responses,
    );
    set(
        &mut headers,
        OPENAI_HEADERS.originator,
        OPENAI_HEADER_VALUES.originator_codex,
    );
    headers
}

fn read_trimmed_string(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Streaming plumbing (Node ServerResponse analogue over an mpsc channel)
// ---------------------------------------------------------------------------

/// The head handed from the streaming writer to the HTTP response builder:
/// `(status, headers)`.
type ResponseHead = (u16, Vec<(String, String)>);

struct ChannelWriter {
    head_tx: Option<oneshot::Sender<ResponseHead>>,
    body_tx: Option<mpsc::Sender<Result<Bytes, BoxError>>>,
    /// A clone kept alive for `closed()` after `end()`/`destroy()`.
    closed_probe: mpsc::Sender<Result<Bytes, BoxError>>,
    pending: Option<Bytes>,
    destroyed: bool,
}

impl ClientStreamWriter for ChannelWriter {
    fn write_head(&mut self, status: u16, headers: Vec<(String, String)>) {
        if let Some(tx) = self.head_tx.take() {
            let _ = tx.send((status, headers));
        }
    }

    fn writable_ended(&self) -> bool {
        self.body_tx.is_none()
    }

    fn destroyed(&self) -> bool {
        self.destroyed
    }

    fn write(&mut self, chunk: &[u8]) -> Result<bool, BoxError> {
        if self.destroyed {
            return Err("write after destroy".into());
        }
        let Some(tx) = self.body_tx.as_ref() else {
            return Err("write after end".into());
        };
        match tx.try_send(Ok(Bytes::copy_from_slice(chunk))) {
            Ok(()) => Ok(true),
            Err(mpsc::error::TrySendError::Full(value)) => {
                // Chunk accepted; delivered during wait_for_drain
                // (backpressure).
                if let Ok(bytes) = value {
                    self.pending = Some(bytes);
                }
                Ok(false)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err("client connection closed".into()),
        }
    }

    fn wait_for_drain(&mut self) -> futures::future::BoxFuture<'_, ()> {
        let pending = self.pending.take();
        let tx = self.body_tx.clone();
        Box::pin(async move {
            if let (Some(chunk), Some(tx)) = (pending, tx) {
                // Resolves on capacity OR channel close — a disconnected
                // client cannot park the forwarder forever.
                let _ = tx.send(Ok(chunk)).await;
            }
        })
    }

    fn end(&mut self) {
        self.body_tx = None;
    }

    fn destroy(&mut self, error: Option<BoxError>) {
        if let Some(tx) = self.body_tx.take() {
            let _ = tx.try_send(Err(error.unwrap_or_else(|| "destroyed".into())));
        }
        self.destroyed = true;
    }

    fn closed(&self) -> futures::future::BoxFuture<'static, ()> {
        let probe = self.closed_probe.clone();
        Box::pin(async move {
            probe.closed().await;
        })
    }
}

/// Buffered [`StreamForwardStatus`] — applied to the shared status after the
/// forward completes (the canonical status lives behind the async state
/// lock, which the sync trait methods cannot take).
#[derive(Default)]
struct StatusBuffer {
    streams_started: i64,
    last_error: Option<String>,
}

impl StreamForwardStatus for StatusBuffer {
    fn increment_streams_started(&mut self) {
        self.streams_started += 1;
    }

    fn set_last_error(&mut self, message: String) {
        self.last_error = Some(message);
    }
}

/// Post-stream-failure cleanup data (the TS `onStreamFailure` closure body,
/// run after `forward_streaming_response` reports failure).
enum StreamCleanup {
    None,
    NetworkFailure {
        account_index: i64,
        family: ModelFamily,
        model: Option<String>,
        session_key: Option<String>,
        cooldown_ms: i64,
    },
}

struct StreamUsage {
    recorder: Arc<RuntimeUsageRecorder>,
    status_code: u16,
    account: Option<RuntimePolicyAccount>,
    /// (`outcome`, `errorCode`) when the forward succeeds.
    on_success: (UsageLedgerOutcome, Option<String>),
    /// (`outcome`, `errorCode`) when the forward fails.
    on_failure: (UsageLedgerOutcome, Option<String>),
}

/// Stream `upstream` to the client: spawns the pump task, waits for the
/// response head, and returns the streaming client response while the pump
/// (and its cleanup + usage record) continues in the background.
///
/// `usage` is `None` on the `/responses` path — the pipeline owns that
/// route's usage-ledger record.
async fn stream_upstream_to_client(
    shared: Arc<ProxyShared>,
    manager: SharedAccountManager,
    upstream: StreamResponse,
    stream_stall_timeout_ms: i64,
    cleanup: StreamCleanup,
    usage: Option<StreamUsage>,
) -> Response<ProxyBody> {
    let (head_tx, head_rx) = oneshot::channel::<(u16, Vec<(String, String)>)>();
    let (body_tx, mut body_rx) = mpsc::channel::<Result<Bytes, BoxError>>(16);
    let closed_probe = body_tx.clone();
    let mut writer = ChannelWriter {
        head_tx: Some(head_tx),
        body_tx: Some(body_tx),
        closed_probe,
        pending: None,
        destroyed: false,
    };
    tokio::spawn(async move {
        let mut status_buffer = StatusBuffer::default();
        let forwarded = forward_streaming_response(
            upstream,
            &mut writer,
            &mut status_buffer,
            || {},
            stream_stall_timeout_ms.max(1) as u64,
        )
        .await;
        drop(writer);
        {
            let mut state = shared.pipeline.state().await;
            state.status.streams_started += status_buffer.streams_started;
            if let Some(error) = status_buffer.last_error {
                state.status.last_error = Some(error);
            }
        }
        if !forwarded
            && let StreamCleanup::NetworkFailure {
                account_index,
                family,
                model,
                session_key,
                cooldown_ms,
            } = cleanup
        {
            {
                let mut mgr = manager.lock().await;
                mgr.record_failure(account_index, family, model.as_deref());
                mgr.mark_account_cooling_down(
                    account_index,
                    cooldown_ms,
                    CooldownReason::NetworkError,
                );
            }
            forget_affinity(&shared, session_key.as_deref()).await;
            manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
        }
        if let Some(usage) = usage {
            let (outcome, error_code) = if forwarded {
                usage.on_success
            } else {
                usage.on_failure
            };
            usage
                .recorder
                .record(RuntimeUsageRecordInput {
                    outcome: Some(outcome),
                    status_code: Some(usage.status_code as i64),
                    error_code,
                    account: usage.account,
                    ..Default::default()
                })
                .await;
        }
    });
    match head_rx.await {
        Ok((status, headers)) => {
            let stream = futures::stream::poll_fn(move |cx| body_rx.poll_recv(cx));
            let body: ProxyBody = BodyExt::boxed(StreamBody::new(
                stream.map(|item| item.map(hyper::body::Frame::data)),
            ));
            let mut builder = Response::builder().status(status);
            for (name, value) in headers {
                builder = builder.header(name, value);
            }
            builder.body(body).unwrap_or_else(|_| proxy_error_response())
        }
        Err(_) => proxy_error_response(),
    }
}

async fn forget_affinity(shared: &Arc<ProxyShared>, session_key: Option<&str>) {
    let store = {
        let state = shared.pipeline.state().await;
        state.session_affinity_store.clone()
    };
    if let Some(store) = store {
        let mut store = store.lock().unwrap_or_else(|poison| poison.into_inner());
        store.forget_session(session_key);
    }
}

// ---------------------------------------------------------------------------
// Upstream fetch → StreamResponse
// ---------------------------------------------------------------------------

fn to_stream_response(response: reqwest::Response) -> StreamResponse {
    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let headers = response.headers().clone();
    let body: BodyStream = response
        .bytes_stream()
        .map(|item| item.map_err(|error| -> BoxError { Box::new(error) }))
        .boxed();
    StreamResponse {
        status,
        status_text,
        headers,
        body: Some(body),
    }
}

// ---------------------------------------------------------------------------
// Persist-active-account (TS `persistRuntimeActiveAccount`)
// ---------------------------------------------------------------------------

async fn persist_runtime_active_account(
    manager: &SharedAccountManager,
    account_index: i64,
    family: ModelFamily,
    is_pinned: bool,
    scheduling_strategy: SchedulingStrategy,
) {
    if is_pinned {
        // #474: pinned requests never commit/persist/sync anything.
        return;
    }
    // Whole body is try/catch-ignore in TS — forwarding must not fail after a
    // valid upstream response.
    let mode = {
        let manager = manager.lock().await;
        manager.get_routing_mutex_mode()
    };
    if mode != RoutingMutexMode::Enabled && scheduling_strategy != SchedulingStrategy::Sequential {
        let mut mgr = manager.lock().await;
        mgr.mark_switched_locked(account_index, SwitchReason::Rotation, family, None)
            .await;
    }
    manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
    let mgr = manager.lock().await;
    mgr.sync_codex_cli_active_selection_for_index(account_index)
        .await;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

enum HandlerError {
    Http(RuntimeProxyHttpError),
    Other(String),
}

async fn read_request_body(body: Incoming, max_bytes: usize) -> Result<Vec<u8>, HandlerError> {
    let mut body = body;
    let mut collected: Vec<u8> = Vec::new();
    loop {
        let Some(frame) = body.frame().await else {
            break;
        };
        let frame = frame.map_err(|error| HandlerError::Other(error.to_string()))?;
        if let Ok(data) = frame.into_data() {
            if collected.len() + data.len() > max_bytes {
                return Err(HandlerError::Http(RuntimeProxyHttpError::new(
                    "Runtime rotation proxy request body is too large.",
                    HTTP_STATUS.payload_too_large,
                    "runtime_rotation_proxy_payload_too_large",
                )));
            }
            collected.extend_from_slice(&data);
        }
    }
    Ok(collected)
}

async fn handle_request(shared: Arc<ProxyShared>, req: Request<Incoming>) -> Response<ProxyBody> {
    let trace_id = uuid::Uuid::new_v4().to_string();
    run_with_correlation_id(
        Some(trace_id.clone()),
        handle_request_inner(shared, req, trace_id),
    )
    .await
}

async fn handle_request_inner(
    shared: Arc<ProxyShared>,
    req: Request<Incoming>,
    trace_id: String,
) -> Response<ProxyBody> {
    let usage_slot: Arc<StdMutex<Option<Arc<RuntimeUsageRecorder>>>> =
        Arc::new(StdMutex::new(None));
    match run_request(Arc::clone(&shared), req, &trace_id, Arc::clone(&usage_slot)).await {
        Ok(response) => response,
        Err(error) => {
            let (raw_message, code, http_error) = match &error {
                HandlerError::Http(http_error) => (
                    http_error.message.clone(),
                    http_error.code.clone(),
                    Some(http_error.clone()),
                ),
                HandlerError::Other(message) => (
                    message.clone(),
                    "codex_runtime_rotation_proxy_error".to_string(),
                    None,
                ),
            };
            // errors-logging-08: redact before status/log consumers see it.
            let masked = mask_string(&raw_message);
            {
                let mut state = shared.pipeline.state().await;
                state.status.last_error = Some(masked.clone());
            }
            create_logger("runtime-proxy").error(
                "runtime proxy request failed",
                Some(&json!({
                    "traceId": trace_id,
                    "code": code,
                    "error": masked,
                })),
            );
            let recorder = usage_slot
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone();
            match http_error {
                Some(http_error) => {
                    if let Some(recorder) = recorder {
                        recorder
                            .record(RuntimeUsageRecordInput {
                                outcome: Some(UsageLedgerOutcome::Failure),
                                status_code: Some(http_error.status_code as i64),
                                error_code: Some(http_error.code.clone()),
                                ..Default::default()
                            })
                            .await;
                    }
                    json_response(
                        http_error.status_code,
                        &json!({
                            "error": { "message": http_error.message, "code": http_error.code }
                        }),
                    )
                }
                None => {
                    if let Some(recorder) = recorder {
                        recorder
                            .record(RuntimeUsageRecordInput {
                                outcome: Some(UsageLedgerOutcome::Failure),
                                status_code: Some(500),
                                error_code: Some("codex_runtime_rotation_proxy_error".to_string()),
                                ..Default::default()
                            })
                            .await;
                    }
                    proxy_error_response()
                }
            }
        }
    }
}

fn account_ref(account: &ManagedAccount) -> RuntimePolicyAccount {
    RuntimePolicyAccount {
        index: account.index as i64,
        account_id: account.meta.account_id.clone(),
        email: account.meta.email.clone(),
    }
}

async fn record_usage(
    recorder: &Arc<RuntimeUsageRecorder>,
    outcome: UsageLedgerOutcome,
    status_code: u16,
    error_code: Option<&str>,
    account: Option<RuntimePolicyAccount>,
) {
    recorder
        .record(RuntimeUsageRecordInput {
            outcome: Some(outcome),
            status_code: Some(status_code as i64),
            error_code: error_code.map(str::to_string),
            account,
            ..Default::default()
        })
        .await;
}

async fn bump_transient_counters(shared: &Arc<ProxyShared>) {
    let mut state = shared.pipeline.state().await;
    state.status.retries += 1;
    state.status.rotations += 1;
}

#[expect(
    clippy::too_many_lines,
    reason = "direct port of the TS handleRequestInner rotation loop; splitting \
              would scatter the status-mapping contract the spec pins as one unit"
)]
async fn run_request(
    shared: Arc<ProxyShared>,
    req: Request<Incoming>,
    trace_id: &str,
    usage_slot: Arc<StdMutex<Option<Arc<RuntimeUsageRecorder>>>>,
) -> Result<Response<ProxyBody>, HandlerError> {
    let (parts, incoming_body) = req.into_parts();
    let method = parts.method;
    let pathname = parts.uri.path().to_string();
    let query = parts.uri.query().map(str::to_string);
    let incoming_headers = parts.headers;

    // Per-request config snapshot + manager handle (one short lock).
    let config: ReqConfig = {
        let state = shared.pipeline.state().await;
        ReqConfig {
            client_api_key: state.client_api_key.clone(),
            upstream_base_url: state.upstream_base_url.clone(),
            fetch_client: state.fetch_client.clone(),
            now: state.now.clone(),
            routing_mutex_mode: state.routing_mutex_mode,
            scheduling_strategy: state.scheduling_strategy,
            pid_offset_enabled: state.pid_offset_enabled,
            token_refresh_skew_ms: state.token_refresh_skew_ms,
            network_error_cooldown_ms: state.network_error_cooldown_ms,
            server_error_cooldown_ms: state.server_error_cooldown_ms,
            token_invalidation_cooldown_ms: state.token_invalidation_cooldown_ms,
            min_rotation_interval_ms: state.min_rotation_interval_ms,
            fetch_timeout_ms: state.fetch_timeout_ms,
            stream_stall_timeout_ms: state.stream_stall_timeout_ms,
            max_runtime_account_attempts: state.max_runtime_account_attempts,
            max_request_body_bytes: state.max_request_body_bytes,
            quota_remaining_percent_threshold: state.quota_remaining_percent_threshold,
            session_affinity_store: state.session_affinity_store.clone(),
            forced_account_index: state.forced_account_index,
        }
    };
    let now = || (config.now)();

    // Authenticate BEFORE discriminating path/method (gotcha 22): an unknown
    // caller always gets 401, never a path-confirming 404.
    if !is_authorized_client(&incoming_headers, &config.client_api_key) {
        return Ok(write_unauthorized());
    }

    let is_responses_request = method == http::Method::POST && is_responses_path(&pathname);
    let is_models_request = method == http::Method::GET && is_models_path(&pathname);
    let is_thread_goal_request = (method == http::Method::GET || method == http::Method::POST)
        && is_thread_goal_path(&pathname);
    if !is_responses_request && !is_models_request && !is_thread_goal_request {
        return Ok(write_method_or_path_error());
    }

    {
        let mut state = shared.pipeline.state().await;
        state.status.total_requests += 1;
    }

    let request_body =
        if is_responses_request || (is_thread_goal_request && method == http::Method::POST) {
            read_request_body(incoming_body, config.max_request_body_bytes).await?
        } else {
            Vec::new()
        };

    // ---- SEAM: `/responses` goes through the merged pipeline ----
    // The pipeline owns selection/refresh/forward/rotation AND the
    // usage-ledger record (source runtime-proxy, operation responses); the
    // server contributes auth, routing, the body cap, and the client-side
    // stream forward. The incoming query string rides on `upstream_path`.
    if is_responses_request {
        let mut context = build_responses_request_context(incoming_headers, request_body);
        if let Some(query) = query.as_deref()
            && !query.is_empty()
        {
            context.upstream_path = format!("{}?{query}", context.upstream_path);
        }
        let upstream = shared
            .pipeline
            .handle_responses(context, Some(trace_id.to_string()))
            .await;
        let manager = {
            let state = shared.pipeline.state().await;
            state.active_account_manager.clone()
        };
        return Ok(stream_upstream_to_client(
            Arc::clone(&shared),
            manager,
            upstream,
            config.stream_stall_timeout_ms,
            StreamCleanup::None,
            None,
        )
        .await);
    }

    // ---- Server-owned routes: /models and /thread/goal/* ----
    let context = if is_models_request {
        build_models_request_context(incoming_headers.clone())
    } else {
        build_thread_goal_request_context(
            incoming_headers.clone(),
            request_body,
            &pathname,
            query.as_deref(),
            method == http::Method::GET,
        )
    };
    let request_started_at = now();

    let mut account_manager: SharedAccountManager = {
        let state = shared.pipeline.state().await;
        state.active_account_manager.clone()
    };

    // Runtime policy gate (server-owned routes FAIL CLOSED — spec 04).
    let mut policy_decision: Option<RuntimePolicyDecision> = None;
    let mut policy_error: Option<String> = None;
    let project_key: Option<String>;
    {
        let start_dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let policy_state = load_runtime_policy_state(&start_dir).await;
        project_key = policy_state.project.project_key.clone();
        let accounts: Vec<RuntimePolicyAccount> = {
            let mut manager = account_manager.lock().await;
            manager
                .get_accounts_snapshot()
                .iter()
                .map(account_ref)
                .collect()
        };
        match evaluate_runtime_policy(EvaluateRuntimePolicyInput {
            state: &policy_state,
            accounts: &accounts,
            model: context.model.as_deref(),
            capability_policy: None,
            now: Some(request_started_at),
        })
        .await
        {
            Ok(decision) => {
                let mut blocked: Vec<i64> =
                    decision.blocked_account_indexes.iter().copied().collect();
                blocked.sort_unstable();
                mutate_runtime_observability_snapshot(|snapshot| {
                    snapshot.policy_blocked_indexes = blocked.clone();
                    let mut reasons = Map::new();
                    for index in &blocked {
                        reasons.insert(
                            index.to_string(),
                            Value::String("policy-blocked".to_string()),
                        );
                    }
                    snapshot.policy_blocked_reasons = reasons;
                });
                policy_decision = Some(decision);
            }
            Err(error) => {
                let message = error.to_string();
                policy_error = Some(message.clone());
                let mut state = shared.pipeline.state().await;
                state.status.last_error = Some(message);
            }
        }
    }
    let usage_recorder = Arc::new(create_runtime_usage_recorder(RuntimeUsageRecorderOptions {
        source: UsageLedgerSource::RuntimeProxy,
        operation: if is_models_request {
            UsageLedgerOperation::Models
        } else {
            UsageLedgerOperation::ThreadGoal
        },
        model: context.model.clone(),
        project_key,
        request_id: Some(trace_id.to_string()),
        started_at: Some(request_started_at),
        append: None,
    }));
    *usage_slot
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some(Arc::clone(&usage_recorder));
    if policy_error.is_some() {
        record_usage(
            &usage_recorder,
            UsageLedgerOutcome::Failure,
            HTTP_STATUS.service_unavailable,
            Some("runtime_policy_unavailable"),
            None,
        )
        .await;
        return Ok(json_response(
            HTTP_STATUS.service_unavailable,
            &json!({
                "error": {
                    "message": "Runtime policy could not be loaded for this local request.",
                    "code": "runtime_policy_unavailable",
                }
            }),
        ));
    }
    if let Some(decision) = policy_decision.as_ref()
        && !decision.allowed
    {
        record_usage(
            &usage_recorder,
            UsageLedgerOutcome::Blocked,
            decision.status_code,
            decision.error_code.as_deref(),
            None,
        )
        .await;
        return Ok(json_response(
            decision.status_code,
            &json!({
                "error": {
                    "message": "Runtime policy blocked this local request.",
                    "code": decision
                        .error_code
                        .clone()
                        .unwrap_or_else(|| "policy_blocked".to_string()),
                    "reasons": decision.reasons,
                }
            }),
        ));
    }

    let upstream_url = build_upstream_url(
        &config.upstream_base_url,
        &context.upstream_path,
        query.as_deref(),
    )?;

    let mut attempted_indexes: HashSet<i64> = HashSet::new();
    let mut exhaustion_reason = ExhaustionReason::NoAccount;
    let mut account_count = account_manager.lock().await.get_account_count() as i64;
    let mut transient_attempt_limit = account_count
        .min(config.max_runtime_account_attempts)
        .max(1);
    let mut transient_attempts: i64 = 0;
    let mut transient_exhaustion_reason: Option<ExhaustionReason> = None;
    let mut skip_map: HashMap<i64, String> = HashMap::new();
    let mut skip_order: Vec<(i64, String)> = Vec::new();
    let mut reloaded_after_no_account = false;

    // Per-request pin/affinity read (sha1-content-hash cached — #474/#623).
    // Forced index 0 must win, hence `.or(...)` (TS `??`).
    let storage_meta = read_storage_meta_from_disk(None);
    let pinned_index = config
        .forced_account_index
        .or(storage_meta.pinned_account_index);
    let is_pinned = pinned_index.is_some();
    {
        let mut state = shared.pipeline.state().await;
        if storage_meta.affinity_generation > state.last_observed_affinity_generation {
            if let Some(store) = state.session_affinity_store.clone() {
                store
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .clear_all();
            }
            state.last_observed_affinity_generation = storage_meta.affinity_generation;
        }
    }

    while (attempted_indexes.len() as i64) < account_count
        && transient_attempts < transient_attempt_limit
    {
        // Sticky boost: keep the proxy on the last-served account within the
        // min-rotation window (flat 1000).
        let rotation_sticky_boost: HashMap<i64, f64> = {
            let state = shared.pipeline.state().await;
            match state.last_global_account_index {
                Some(last_index)
                    if config.min_rotation_interval_ms > 0
                        && now() - state.last_global_switch_at
                            < config.min_rotation_interval_ms =>
                {
                    let mut boost = HashMap::new();
                    boost.insert(last_index, 1000.0);
                    boost
                }
                _ => HashMap::new(),
            }
        };

        // Selection. In `enabled` mode, run selection AND the cursor
        // re-commit inside ONE routing-mutex acquisition (L4 fix); the inner
        // `mark_switched_locked` runs inline via the reentrancy flag. Skips:
        // pinned (#474) and sequential (#509).
        let selected: Option<ManagedAccount> = {
            let manager = account_manager.clone();
            let affinity = config.session_affinity_store.clone();
            let session_key = context.session_key.as_deref();
            let family = context.family;
            let model = context.model.as_deref();
            let attempted = &attempted_indexes;
            let policy = policy_decision.as_ref();
            let skip = &mut skip_map;
            let boost = &rotation_sticky_boost;
            let selection_now = now();
            if config.routing_mutex_mode == RoutingMutexMode::Enabled {
                with_routing_mutex(RoutingMutexMode::Enabled, || async move {
                    let mut mgr = manager.lock().await;
                    let candidate = {
                        let mut affinity_guard = affinity
                            .as_ref()
                            .map(|store| store.lock().unwrap_or_else(|poison| poison.into_inner()));
                        choose_account(ChooseAccountParams {
                            account_manager: &mut mgr,
                            session_affinity_store: affinity_guard.as_deref_mut(),
                            session_key,
                            family,
                            model,
                            attempted_indexes: attempted,
                            now: selection_now,
                            policy,
                            pinned_index,
                            skip_reasons: Some(skip),
                            sticky_boost_by_account: Some(boost),
                            pid_offset_enabled: config.pid_offset_enabled,
                            scheduling_strategy: config.scheduling_strategy,
                        })
                    };
                    if let Some(candidate) = &candidate
                        && pinned_index.is_none()
                        && config.scheduling_strategy != SchedulingStrategy::Sequential
                    {
                        mgr.mark_switched_locked(
                            candidate.index as i64,
                            SwitchReason::Rotation,
                            family,
                            None,
                        )
                        .await;
                    }
                    candidate
                })
                .await
            } else {
                let mut mgr = manager.lock().await;
                let mut affinity_guard = affinity
                    .as_ref()
                    .map(|store| store.lock().unwrap_or_else(|poison| poison.into_inner()));
                choose_account(ChooseAccountParams {
                    account_manager: &mut mgr,
                    session_affinity_store: affinity_guard.as_deref_mut(),
                    session_key,
                    family,
                    model,
                    attempted_indexes: attempted,
                    now: selection_now,
                    policy,
                    pinned_index,
                    skip_reasons: Some(skip),
                    sticky_boost_by_account: Some(boost),
                    pid_offset_enabled: config.pid_offset_enabled,
                    scheduling_strategy: config.scheduling_strategy,
                })
            }
        };
        sync_skip_order(&mut skip_order, &skip_map);

        let Some(selected) = selected else {
            // One-shot stale-state recovery (issue #606). Only policy blocks
            // suppress it; transient "rate-limited"/"cooling-down*" reasons
            // deliberately do NOT.
            let policy_blocked_empty = policy_decision
                .as_ref()
                .is_none_or(|decision| decision.blocked_account_indexes.is_empty());
            let has_policy_skip = skip_map.values().any(|reason| reason == "policy-blocked");
            if !reloaded_after_no_account
                && !is_pinned
                && account_count > 0
                && exhaustion_reason == ExhaustionReason::NoAccount
                && policy_blocked_empty
                && !has_policy_skip
            {
                reloaded_after_no_account = true;
                let reloaded = {
                    let mut state = shared.pipeline.state().await;
                    recover_stale_runtime_state(&mut state).await
                };
                if let Some(reloaded_manager) = reloaded {
                    account_manager = reloaded_manager;
                    account_count = account_manager.lock().await.get_account_count() as i64;
                    transient_attempt_limit = account_count
                        .min(config.max_runtime_account_attempts)
                        .max(1);
                    skip_map.clear();
                    skip_order.clear();
                    attempted_indexes.clear();
                    continue;
                }
            }
            break;
        };
        let selected_index = selected.index as i64;
        attempted_indexes.insert(selected_index);

        // Local token bucket — a refusal is NOT a transient attempt.
        let consumed = {
            let mut mgr = account_manager.lock().await;
            mgr.consume_token(selected_index, context.family, context.model.as_deref())
        };
        if !consumed {
            record_skip(
                &mut skip_order,
                &mut skip_map,
                selected_index,
                "token-exhausted",
            );
            exhaustion_reason = ExhaustionReason::RateLimit;
            continue;
        }

        // Token freshness.
        let refreshed = ensure_fresh_access_token(EnsureFreshAccessTokenParams {
            account_manager: &account_manager,
            account: &selected,
            family: context.family,
            model: context.model.as_deref(),
            now: now(),
            token_refresh_skew_ms: config.token_refresh_skew_ms,
            token_invalidation_cooldown_ms: config.token_invalidation_cooldown_ms,
        })
        .await;
        let (access_token, refreshed_account) = match refreshed {
            EnsureFreshAccessTokenResult::Failed {
                retryable,
                invalidated,
            } => {
                {
                    let mut mgr = account_manager.lock().await;
                    mgr.refund_token(selected_index, context.family, context.model.as_deref());
                }
                exhaustion_reason = ExhaustionReason::AuthFailure;
                if invalidated {
                    // Refresh endpoint explicitly revoked the token — STOP the
                    // cascade: 401 to the client, no rotation (gotcha 10).
                    forget_affinity(&shared, context.session_key.as_deref()).await;
                    record_usage(
                        &usage_recorder,
                        UsageLedgerOutcome::Failure,
                        HTTP_STATUS.unauthorized,
                        Some("token_invalidated"),
                        Some(account_ref(&selected)),
                    )
                    .await;
                    return Ok(Response::builder()
                        .status(HTTP_STATUS.unauthorized)
                        .header("content-type", "application/json")
                        .body(full_body(build_token_invalidation_body("")))
                        .unwrap_or_else(|_| proxy_error_response()));
                }
                if !retryable {
                    continue;
                }
                transient_attempts += 1;
                transient_exhaustion_reason = Some(ExhaustionReason::AuthFailure);
                bump_transient_counters(&shared).await;
                continue;
            }
            EnsureFreshAccessTokenResult::Ok {
                access_token,
                account,
            } => (access_token, account),
        };
        let refreshed_index = refreshed_account.index as i64;

        // Account id.
        let account_id = read_trimmed_string(refreshed_account.meta.account_id.as_deref())
            .or_else(|| {
                extract_account_id(Some(access_token.as_str()))
                    .map(|id| id.trim().to_string())
                    .filter(|id| !id.is_empty())
            });
        let Some(account_id) = account_id else {
            {
                let mut mgr = account_manager.lock().await;
                mgr.refund_token(refreshed_index, context.family, context.model.as_deref());
                mgr.record_failure(refreshed_index, context.family, context.model.as_deref());
                mgr.mark_account_cooling_down(
                    refreshed_index,
                    DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
                    CooldownReason::AuthFailure,
                );
            }
            // Cooldowns are serialized in the V3 snapshot — persist like
            // every other cooldown branch (gotcha 19).
            account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
            exhaustion_reason = ExhaustionReason::AuthFailure;
            transient_attempts += 1;
            transient_exhaustion_reason = Some(ExhaustionReason::AuthFailure);
            bump_transient_counters(&shared).await;
            continue;
        };

        // Record the served identity (label only — email intentionally null).
        let identity_updated_at = now();
        let identity_label = format!("Account {}", refreshed_index + 1);
        let identity_account_id = read_trimmed_string(refreshed_account.meta.account_id.as_deref());
        {
            let mut state = shared.pipeline.state().await;
            state.status.last_account_index = Some(refreshed_index);
            state.status.last_account_label = Some(identity_label.clone());
            state.status.last_account_id = identity_account_id.clone();
            state.status.last_account_updated_at = Some(identity_updated_at);
        }
        mutate_runtime_observability_snapshot(|snapshot| {
            snapshot.last_account_index = Some(refreshed_index);
            snapshot.last_account_label = Some(identity_label.clone());
            snapshot.last_account_email = None;
            snapshot.last_account_id = identity_account_id.clone();
            snapshot.last_account_updated_at = Some(identity_updated_at);
        });

        let outbound_headers = create_outbound_headers(&context.headers, &access_token, &account_id);

        // Upstream fetch.
        {
            let mut state = shared.pipeline.state().await;
            state.status.upstream_requests += 1;
        }
        let request_builder = config
            .fetch_client
            .request(
                match context.method {
                    RequestMethod::Post => reqwest::Method::POST,
                    RequestMethod::Get => reqwest::Method::GET,
                },
                &upstream_url,
            )
            .headers(outbound_headers);
        let request_builder = if context.method == RequestMethod::Post {
            request_builder.body(context.body.clone())
        } else {
            request_builder
        };
        let timeout_message =
            format!("upstream fetch timed out after {}ms", config.fetch_timeout_ms);
        let fetch_result = with_timeout(
            request_builder.send(),
            config.fetch_timeout_ms as f64,
            || {},
            &timeout_message,
        )
        .await;
        let upstream_response = match fetch_result {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                handle_fetch_failure(
                    &shared,
                    &account_manager,
                    &config,
                    &context,
                    refreshed_index,
                    error.to_string(),
                )
                .await;
                exhaustion_reason = ExhaustionReason::NetworkError;
                transient_attempts += 1;
                transient_exhaustion_reason = Some(ExhaustionReason::NetworkError);
                bump_transient_counters(&shared).await;
                continue;
            }
            Err(timeout_error) => {
                handle_fetch_failure(
                    &shared,
                    &account_manager,
                    &config,
                    &context,
                    refreshed_index,
                    timeout_error.to_string(),
                )
                .await;
                exhaustion_reason = ExhaustionReason::NetworkError;
                transient_attempts += 1;
                transient_exhaustion_reason = Some(ExhaustionReason::NetworkError);
                bump_transient_counters(&shared).await;
                continue;
            }
        };
        let mut upstream = to_stream_response(upstream_response);
        let upstream_status = upstream.status;

        // ---- Status mapping (exact order) ----
        if upstream_status == HTTP_STATUS.too_many_requests {
            let body_text =
                read_error_body(&mut upstream, config.stream_stall_timeout_ms as f64, None).await;
            let retry_after_ms = parse_retry_after_header_ms(&upstream.headers, now())
                .or_else(|| parse_retry_after_body_ms(&body_text, now()))
                .unwrap_or(60_000);
            // 429 = genuine quota consumption: token NOT refunded (gotcha 17).
            {
                let mut mgr = account_manager.lock().await;
                mgr.record_rate_limit(refreshed_index, context.family, context.model.as_deref());
                mgr.mark_rate_limited_with_reason(
                    refreshed_index,
                    retry_after_ms,
                    context.family,
                    RateLimitReason::Quota,
                    context.model.as_deref(),
                );
            }
            account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
            exhaustion_reason = ExhaustionReason::RateLimit;
            transient_attempts += 1;
            transient_exhaustion_reason = Some(ExhaustionReason::RateLimit);
            bump_transient_counters(&shared).await;
            continue;
        }

        if upstream_status == 402 || upstream_status == HTTP_STATUS.forbidden {
            let body_text =
                read_error_body(&mut upstream, config.stream_stall_timeout_ms as f64, None).await;
            let error_code = extract_error_code_from_body(&body_text);
            let code_value = error_code.clone().map(Value::String).unwrap_or(Value::Null);
            if is_workspace_disabled_error(upstream_status, &code_value, &body_text) {
                let account_was_enabled = {
                    let mgr = account_manager.lock().await;
                    !matches!(
                        mgr.get_account_by_index(refreshed_index),
                        Some(account) if !account.is_enabled()
                    )
                };
                {
                    let mut mgr = account_manager.lock().await;
                    mgr.refund_token(refreshed_index, context.family, context.model.as_deref());
                    if account_was_enabled {
                        mgr.record_failure(
                            refreshed_index,
                            context.family,
                            context.model.as_deref(),
                        );
                        mgr.set_account_enabled(refreshed_index, false);
                    }
                }
                if account_was_enabled {
                    account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                }
                forget_affinity(&shared, context.session_key.as_deref()).await;
                exhaustion_reason = ExhaustionReason::Deactivated;
                // Deactivation bumps retries/rotations but NOT the transient
                // budget.
                bump_transient_counters(&shared).await;
                continue;
            }

            if is_thread_goal_request && upstream_status == HTTP_STATUS.forbidden {
                // Local memory of goals when upstream forbids them.
                let parsed_goal_body = parse_request_body(&context.body);
                let goal = parsed_goal_body
                    .as_ref()
                    .and_then(|body| body.get("goal"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                match context.session_key.clone() {
                    None => {
                        if context.upstream_path.ends_with("/get") {
                            let response = json_response(HTTP_STATUS.ok, &json!({ "goal": null }));
                            record_usage(
                                &usage_recorder,
                                UsageLedgerOutcome::Failure,
                                upstream_status,
                                Some("thread_goal_session_key_required"),
                                Some(account_ref(&refreshed_account)),
                            )
                            .await;
                            return Ok(response);
                        }
                        record_usage(
                            &usage_recorder,
                            UsageLedgerOutcome::Failure,
                            HTTP_STATUS.bad_request,
                            Some("thread_goal_session_key_required"),
                            Some(account_ref(&refreshed_account)),
                        )
                        .await;
                        return Ok(json_response(
                            HTTP_STATUS.bad_request,
                            &json!({
                                "error": {
                                    "message": "Thread goal fallback requires a thread_id, threadId, or session header.",
                                    "code": "thread_goal_session_key_required",
                                }
                            }),
                        ));
                    }
                    Some(fallback_key) => {
                        record_usage(
                            &usage_recorder,
                            UsageLedgerOutcome::Failure,
                            upstream_status,
                            Some("thread_goal_upstream_blocked"),
                            Some(account_ref(&refreshed_account)),
                        )
                        .await;
                        if context.upstream_path.ends_with("/set") {
                            {
                                let mut order = shared.thread_goal_order.lock().await;
                                let mut state = shared.pipeline.state().await;
                                set_thread_goal_fallback(
                                    &mut state,
                                    &mut order,
                                    &fallback_key,
                                    goal.clone(),
                                );
                            }
                            return Ok(json_response(
                                HTTP_STATUS.ok,
                                &json!({ "ok": true, "goal": goal }),
                            ));
                        }
                        let stored = {
                            let mut order = shared.thread_goal_order.lock().await;
                            let mut state = shared.pipeline.state().await;
                            get_thread_goal_fallback(&mut state, &mut order, &fallback_key)
                        };
                        return Ok(json_response(HTTP_STATUS.ok, &json!({ "goal": stored })));
                    }
                }
            }

            if is_thread_goal_request && context.upstream_path.ends_with("/get") {
                let response = json_response(HTTP_STATUS.ok, &json!({ "goal": null }));
                record_usage(
                    &usage_recorder,
                    UsageLedgerOutcome::Failure,
                    upstream_status,
                    error_code.as_deref(),
                    Some(account_ref(&refreshed_account)),
                )
                .await;
                return Ok(response);
            }
            // Forward the client-safe headers + body verbatim.
            let mut builder = Response::builder().status(upstream_status);
            for (name, value) in response_headers_for_client(&upstream.headers) {
                builder = builder.header(name, value);
            }
            let response = builder
                .body(full_body(body_text))
                .unwrap_or_else(|_| proxy_error_response());
            record_usage(
                &usage_recorder,
                UsageLedgerOutcome::Failure,
                upstream_status,
                error_code.as_deref(),
                Some(account_ref(&refreshed_account)),
            )
            .await;
            return Ok(response);
        }

        if upstream_status == HTTP_STATUS.unauthorized {
            let body_text =
                read_error_body(&mut upstream, config.stream_stall_timeout_ms as f64, None).await;
            {
                let mut mgr = account_manager.lock().await;
                mgr.refund_token(refreshed_index, context.family, context.model.as_deref());
                mgr.record_failure(refreshed_index, context.family, context.model.as_deref());
            }
            if is_token_invalidation_error(&body_text) {
                // Explicit upstream revocation: long cooldown, no rotation
                // (cascade-invalidation defense), 401 straight to the client.
                {
                    let mut mgr = account_manager.lock().await;
                    apply_monotonic_auth_cooldown(
                        &mut mgr,
                        &refreshed_account,
                        config.token_invalidation_cooldown_ms,
                    );
                }
                forget_affinity(&shared, context.session_key.as_deref()).await;
                account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
                let mut client_headers = response_headers_for_client(&upstream.headers);
                client_headers.retain(|(name, _)| name != "content-type");
                client_headers.push(("content-type".to_string(), "application/json".to_string()));
                let mut builder = Response::builder().status(upstream_status);
                for (name, value) in client_headers {
                    builder = builder.header(name, value);
                }
                let response = builder
                    .body(full_body(build_token_invalidation_body(&body_text)))
                    .unwrap_or_else(|_| proxy_error_response());
                record_usage(
                    &usage_recorder,
                    UsageLedgerOutcome::Failure,
                    upstream_status,
                    Some("token_invalidated"),
                    Some(account_ref(&refreshed_account)),
                )
                .await;
                return Ok(response);
            }
            {
                let mut mgr = account_manager.lock().await;
                apply_monotonic_auth_cooldown(
                    &mut mgr,
                    &refreshed_account,
                    DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
                );
            }
            account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
            exhaustion_reason = ExhaustionReason::AuthFailure;
            transient_attempts += 1;
            transient_exhaustion_reason = Some(ExhaustionReason::AuthFailure);
            bump_transient_counters(&shared).await;
            continue;
        }

        if upstream_status >= 500 {
            let _ =
                read_error_body(&mut upstream, config.stream_stall_timeout_ms as f64, None).await;
            {
                let mut mgr = account_manager.lock().await;
                mgr.refund_token(refreshed_index, context.family, context.model.as_deref());
                mgr.record_failure(refreshed_index, context.family, context.model.as_deref());
                mgr.mark_account_cooling_down(
                    refreshed_index,
                    config.server_error_cooldown_ms,
                    CooldownReason::ServerError,
                );
            }
            account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
            exhaustion_reason = ExhaustionReason::ServerError;
            transient_attempts += 1;
            transient_exhaustion_reason = Some(ExhaustionReason::ServerError);
            bump_transient_counters(&shared).await;
            continue;
        }

        if is_thread_goal_request && upstream_status >= 400 {
            if context.upstream_path.ends_with("/get") {
                let response = json_response(HTTP_STATUS.ok, &json!({ "goal": null }));
                record_usage(
                    &usage_recorder,
                    UsageLedgerOutcome::Failure,
                    upstream_status,
                    Some("thread_goal_upstream_error"),
                    Some(account_ref(&refreshed_account)),
                )
                .await;
                return Ok(response);
            }
            return Ok(stream_upstream_to_client(
                Arc::clone(&shared),
                account_manager.clone(),
                upstream,
                config.stream_stall_timeout_ms,
                StreamCleanup::None,
                Some(StreamUsage {
                    recorder: Arc::clone(&usage_recorder),
                    status_code: upstream_status,
                    account: Some(account_ref(&refreshed_account)),
                    on_success: (
                        UsageLedgerOutcome::Failure,
                        Some("thread_goal_upstream_error".to_string()),
                    ),
                    on_failure: (
                        UsageLedgerOutcome::Failure,
                        Some("stream_forward_failed".to_string()),
                    ),
                }),
            )
            .await);
        }

        // ---- Success (2xx/3xx) ----
        account_manager
            .record_success(refreshed_index, context.family, context.model.as_deref())
            .await;
        // Clear any persisted runtime skip-reason overlay (no-op when none —
        // the hot path stays write-free).
        record_runtime_account_recovery(refreshed_index);
        let near_exhaustion_wait_ms = get_quota_near_exhaustion_wait_ms(
            &upstream.headers,
            config.quota_remaining_percent_threshold,
            now(),
        );
        if near_exhaustion_wait_ms > 0 {
            {
                let mut mgr = account_manager.lock().await;
                mgr.mark_rate_limited_with_reason(
                    refreshed_index,
                    near_exhaustion_wait_ms,
                    context.family,
                    RateLimitReason::Quota,
                    context.model.as_deref(),
                );
            }
            forget_affinity(&shared, context.session_key.as_deref()).await;
            account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
        } else {
            if let Some(store) = config.session_affinity_store.as_ref() {
                store
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remember(context.session_key.as_deref(), refreshed_index, now());
            }
            let mut state = shared.pipeline.state().await;
            if state.last_global_account_index != Some(refreshed_index) {
                state.last_global_account_index = Some(refreshed_index);
            }
            state.last_global_switch_at = now();
        }
        persist_runtime_active_account(
            &account_manager,
            refreshed_index,
            context.family,
            is_pinned && pinned_index == Some(refreshed_index),
            config.scheduling_strategy,
        )
        .await;

        return Ok(stream_upstream_to_client(
            Arc::clone(&shared),
            account_manager.clone(),
            upstream,
            config.stream_stall_timeout_ms,
            StreamCleanup::NetworkFailure {
                account_index: refreshed_index,
                family: context.family,
                model: context.model.clone(),
                session_key: context.session_key.clone(),
                cooldown_ms: config.network_error_cooldown_ms,
            },
            Some(StreamUsage {
                recorder: Arc::clone(&usage_recorder),
                status_code: upstream_status,
                account: Some(account_ref(&refreshed_account)),
                on_success: (UsageLedgerOutcome::Success, None),
                on_failure: (
                    UsageLedgerOutcome::Failure,
                    Some("stream_forward_failed".to_string()),
                ),
            }),
        )
        .await);
    }

    // ---- Loop exit / exhaustion ----
    if transient_attempts >= transient_attempt_limit
        && (attempted_indexes.len() as i64) < account_count
    {
        exhaustion_reason = ExhaustionReason::Budget;
    } else if exhaustion_reason == ExhaustionReason::Deactivated
        && let Some(transient) = transient_exhaustion_reason
    {
        exhaustion_reason = transient;
    }

    // Pinned: hard-fail 503 — never silently fall through to rotation (#474;
    // structured reason per #486).
    if is_pinned {
        let ordered: Vec<(usize, String)> = skip_order
            .iter()
            .filter(|(index, _)| *index >= 0)
            .map(|(index, reason)| (*index as usize, reason.clone()))
            .collect();
        let error_body = build_pinned_unavailable_error_body(pinned_index, &ordered);
        if error_body.reason.is_none() {
            let mut state = shared.pipeline.state().await;
            state.status.last_error = Some(format!(
                "pinned-503 missing skip reason (pinnedIndex={})",
                pinned_index.unwrap_or_default()
            ));
        }
        record_usage(
            &usage_recorder,
            UsageLedgerOutcome::Failure,
            HTTP_STATUS.service_unavailable,
            Some("codex_pinned_account_unavailable"),
            None,
        )
        .await;
        return Ok(json_response(
            HTTP_STATUS.service_unavailable,
            &json!({ "error": serde_json::to_value(&error_body).unwrap_or(Value::Null) }),
        ));
    }

    let is_thread_goal_get = is_thread_goal_request && context.upstream_path.ends_with("/get");
    record_usage(
        &usage_recorder,
        UsageLedgerOutcome::Failure,
        normalize_exhaustion_status(exhaustion_reason.as_str()),
        Some(if is_thread_goal_get {
            "thread_goal_pool_exhausted"
        } else {
            exhaustion_reason.as_str()
        }),
        None,
    )
    .await;
    if is_thread_goal_get {
        return Ok(json_response(HTTP_STATUS.ok, &json!({ "goal": null })));
    }

    // TS `writePoolExhausted`.
    let (wait_ms, final_account_count) = {
        let mut mgr = account_manager.lock().await;
        (
            mgr.get_min_wait_time_for_family(context.family, context.model.as_deref()),
            mgr.get_account_count() as i64,
        )
    };
    let skip_reasons_json = skip_reasons_to_json(&skip_order);
    record_runtime_pool_exhaustion(exhaustion_reason.as_str(), wait_ms, &skip_reasons_json);
    let hint = if exhaustion_reason == ExhaustionReason::NoAccount && final_account_count > 0 {
        "Accounts exist but all failed runtime availability checks. Run `codex-multi-auth report --json` to inspect runtime skip reasons, or `codex-multi-auth rotation reset-runtime` to reload the runtime proxy."
    } else {
        "Run `codex-multi-auth rotation status` to inspect account state."
    };
    Ok(json_response(
        normalize_exhaustion_status(exhaustion_reason.as_str()),
        &json!({
            "error": {
                "message": "All managed Codex accounts are temporarily unavailable for this runtime request.",
                "code": "codex_runtime_rotation_pool_exhausted",
                "reason": exhaustion_reason.as_str(),
                "retry_after_ms": wait_ms,
                "account_skip_reasons": skip_reasons_json,
                "hint": hint,
            }
        }),
    ))
}

/// Shared fetch-failure bookkeeping (TS catch around the upstream fetch).
async fn handle_fetch_failure(
    shared: &Arc<ProxyShared>,
    account_manager: &SharedAccountManager,
    config: &ReqConfig,
    context: &RequestContext,
    account_index: i64,
    message: String,
) {
    {
        let mut state = shared.pipeline.state().await;
        state.status.last_error = Some(message);
    }
    {
        let mut mgr = account_manager.lock().await;
        mgr.refund_token(account_index, context.family, context.model.as_deref());
        mgr.record_failure(account_index, context.family, context.model.as_deref());
        mgr.mark_account_cooling_down(
            account_index,
            config.network_error_cooldown_ms,
            CooldownReason::NetworkError,
        );
    }
    account_manager.save_to_disk_debounced(SAVE_DEBOUNCE_DEFAULT_MS);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_host_matrix_matches_ts() {
        for host in ["127.0.0.1", "localhost", "::1", "[::1]", " LOCALHOST "] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in ["0.0.0.0", "192.168.1.10", "example.com", ""] {
            assert!(!is_loopback_host(host), "{host} should NOT be loopback");
        }
    }

    #[test]
    fn ipv6_bind_and_url_hosts_normalize_once() {
        assert_eq!(to_bind_host("[::1]"), "::1");
        assert_eq!(to_bind_host("::1"), "::1");
        assert_eq!(to_bind_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(to_url_host("::1"), "[::1]");
        assert_eq!(to_url_host("[::1]"), "[::1]");
        assert_eq!(to_url_host("localhost"), "localhost");
    }

    #[test]
    fn path_discrimination_matches_the_allowed_sets() {
        for path in [
            "/responses",
            "/codex/responses",
            "/v1/responses",
            "/v1/codex/responses",
        ] {
            assert!(is_responses_path(path), "{path}");
        }
        assert!(!is_responses_path("/foo/responses"));
        assert!(!is_responses_path("/responses/"));
        assert!(is_models_path("/models"));
        assert!(is_models_path("/v1/models"));
        assert!(!is_models_path("/v2/models"));
        for path in [
            "/thread/goal/get",
            "/thread/goal/set",
            "/codex/thread/goal/get",
            "/codex/thread/goal/set",
        ] {
            assert!(is_thread_goal_path(path), "{path}");
        }
        assert_eq!(
            normalize_thread_goal_upstream_path("/thread/goal/set"),
            "/codex/thread/goal/set"
        );
        assert_eq!(
            normalize_thread_goal_upstream_path("/codex/thread/goal/get"),
            "/codex/thread/goal/get"
        );
    }

    #[test]
    fn session_key_resolution_precedence() {
        let mut headers = HeaderMap::new();
        headers.insert("session_id", "  header-key  ".parse().unwrap());
        let body = parse_request_body(br#"{"prompt_cache_key":"body-key"}"#);
        assert_eq!(
            resolve_session_key(&headers, body.as_ref()),
            Some("header-key".to_string())
        );

        let headers = HeaderMap::new();
        let body =
            parse_request_body(br#"{"prompt_cache_key":" cache ","previous_response_id":"prev"}"#);
        assert_eq!(
            resolve_session_key(&headers, body.as_ref()),
            Some("cache".to_string())
        );

        let body = parse_request_body(br#"{"metadata":{"thread_id":"meta-thread"}}"#);
        assert_eq!(
            resolve_session_key(&HeaderMap::new(), body.as_ref()),
            Some("meta-thread".to_string())
        );
        assert_eq!(resolve_session_key(&HeaderMap::new(), None), None);
    }

    #[test]
    fn upstream_url_preserves_query_and_strips_trailing_base_slashes() {
        let url = build_upstream_url(
            "https://example.test/backend-api///",
            "/codex/responses",
            Some("a=1&b=2"),
        )
        .ok()
        .unwrap();
        assert_eq!(
            url,
            "https://example.test/backend-api/codex/responses?a=1&b=2"
        );
        let url = build_upstream_url("https://example.test/backend-api", "/models", None)
            .ok()
            .unwrap();
        assert_eq!(url, "https://example.test/backend-api/models");
    }

    #[test]
    fn outbound_headers_scrub_credentials_and_set_account_headers() {
        let mut incoming = HeaderMap::new();
        incoming.insert("cookie", "secret=1".parse().unwrap());
        incoming.insert("x-api-key", "local".parse().unwrap());
        incoming.insert("proxy-authorization", "Basic x".parse().unwrap());
        incoming.insert("host", "127.0.0.1".parse().unwrap());
        incoming.insert("connection", "keep-alive".parse().unwrap());
        incoming.insert("x-custom", "kept".parse().unwrap());
        let headers = create_outbound_headers(&incoming, "token-1", "acc_1");
        assert!(headers.get("cookie").is_none());
        assert!(headers.get("x-api-key").is_none());
        assert!(headers.get("proxy-authorization").is_none());
        assert!(headers.get("host").is_none());
        assert!(headers.get("connection").is_none());
        assert_eq!(headers.get("x-custom").unwrap(), "kept");
        assert_eq!(headers.get("authorization").unwrap(), "Bearer token-1");
        assert_eq!(headers.get("chatgpt-account-id").unwrap(), "acc_1");
        assert_eq!(headers.get("OpenAI-Beta").unwrap(), "responses=experimental");
        assert_eq!(headers.get("originator").unwrap(), "codex_cli_rs");
    }

    #[test]
    fn thread_goal_lru_evicts_oldest_and_get_reinserts() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut state = create_rotation_proxy_state(RotationProxyStateInit {
                active_account_manager: SharedAccountManager::new(AccountManager::new(None, None)),
                routing_mutex_mode: RoutingMutexMode::Legacy,
                scheduling_strategy: SchedulingStrategy::Hybrid,
                fetch_client: reqwest::Client::new(),
                upstream_base_url: "https://example.test".to_string(),
                client_api_key: "key".to_string(),
                now: Arc::new(cma_core::utils::now_ms),
                token_refresh_skew_ms: 0,
                network_error_cooldown_ms: 0,
                server_error_cooldown_ms: 0,
                token_invalidation_cooldown_ms: 0,
                min_rotation_interval_ms: 0,
                pid_offset_enabled: false,
                fetch_timeout_ms: 1_000,
                stream_stall_timeout_ms: 1_000,
                max_runtime_account_attempts: 4,
                max_request_body_bytes: 1024,
                quota_remaining_percent_threshold: 10.0,
                session_affinity_store: None,
                last_observed_affinity_generation: 0,
                forced_account_index: None,
            });
            let mut order = VecDeque::new();
            for index in 0..MAX_THREAD_GOAL_FALLBACKS + 1 {
                set_thread_goal_fallback(
                    &mut state,
                    &mut order,
                    &format!("key-{index}"),
                    Some("g".into()),
                );
            }
            assert_eq!(state.thread_goal_fallbacks.len(), MAX_THREAD_GOAL_FALLBACKS);
            // key-0 (oldest) evicted.
            assert!(!state.thread_goal_fallbacks.contains_key("key-0"));
            // Stored null goals are distinguishable from absent keys.
            set_thread_goal_fallback(&mut state, &mut order, "null-goal", None);
            assert_eq!(
                get_thread_goal_fallback(&mut state, &mut order, "null-goal"),
                None
            );
            assert!(state.thread_goal_fallbacks.contains_key("null-goal"));
            assert_eq!(
                get_thread_goal_fallback(&mut state, &mut order, "absent"),
                None
            );
            assert!(!state.thread_goal_fallbacks.contains_key("absent"));
        });
    }

    #[test]
    fn percent_decode_handles_plus_and_hex() {
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("thread%2Did"), "thread-id");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("bad%zz"), "bad%zz");
    }
}
