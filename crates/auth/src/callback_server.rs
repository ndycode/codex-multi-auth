//! Port of `lib/auth/server.ts` — the localhost HTTP server that captures the
//! OAuth authorization code redirected to `/auth/callback` (spec 07 §8).
//!
//! Behavior contract (verified against the TS source):
//! - [`start_local_oauth_server`] **never fails**: a bind error resolves to a
//!   handle with `ready = false` + `bind_error_code` so the caller can fall
//!   back to manual paste (spec 07 gotcha 7). The callback port is the
//!   provider-registered [`AUTH_REDIRECT`] port 1455 and is immovable
//!   (spec 07 gotcha 8).
//! - Captured code/state live in **per-call state** ([`Shared`]), never on a
//!   process-global — two concurrent logins in one process must not cross-bind
//!   (spec 07 gotcha 6; a prior bug shared `server._lastCode`).
//! - The first valid code wins; later callbacks still get the success page but
//!   are ignored with a warning. The success page is written *before* the
//!   duplicate check.
//! - `wait_for_code` polls the closure every 100 ms for up to 5 minutes.
//! - The success page is embedded from `crates/auth/assets/oauth-success.html`
//!   via `include_str!` (spec 07 gotcha 22 — the TS module reads it at load).
//!
//! Implementation note (deviation): the TS server is a raw `node:http` server
//! with one handler. Rust serves it with `hyper` 1.x `http1::serve_connection`
//! over a self-bound `tokio::net::TcpListener`. This is the same "bind our own
//! listener so bind-failure is observable, never-reject" shape ARCHITECTURE
//! §5.2 calls for; a full `axum::Router` would add extractor machinery for a
//! single route with no behavioral gain. Node's `server.listen(port,
//! "localhost")` binds ONE resolved address — the Rust port mirrors that
//! (single-address bind), which also keeps the contended-port contract
//! deterministic.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use cma_core::fs_retry::code_of;
use cma_core::logger::{log_error, log_warn};

pub use cma_core::types::OAuthServerInfo;

use crate::oauth::AUTH_REDIRECT;

/// The OAuth success page shown to the browser after a valid callback. Embedded
/// at build time so the binary is self-contained (TS reads the sibling
/// `lib/oauth-success.html` synchronously at module load).
const SUCCESS_HTML: &str = include_str!("../assets/oauth-success.html");

/// The exact `Content-Security-Policy` the success page is served with — locks
/// the page down to inline styles only (FROZEN copy of the TS header).
const SUCCESS_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; \
     font-src 'self' data:; script-src 'none'; base-uri 'none'; form-action 'none'; \
     frame-ancestors 'none'";

/// `waitForCode` poll cadence (TS `POLL_INTERVAL_MS`).
const POLL_INTERVAL_MS: u64 = 100;
/// `waitForCode` total budget: 5 minutes (TS `TIMEOUT_MS`).
const TIMEOUT_MS: u64 = 5 * 60 * 1000;
/// Poll iterations before timing out (TS `maxIterations = floor(TIMEOUT/POLL)`).
const MAX_ITERATIONS: u32 = (TIMEOUT_MS / POLL_INTERVAL_MS) as u32;

/// The code + state captured from the first valid callback. Kept in per-call
/// [`Shared`] state, not on a global (spec 07 gotcha 6).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Captured {
    code: String,
    state: String,
}

/// Result of [`LocalOAuthServer::wait_for_code`] — mirrors the TS
/// `{ code: string }` resolution shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedCode {
    pub code: String,
}

/// Per-server state shared between the accept loop, the request handler, and
/// the [`LocalOAuthServer`] handle. One instance per `start_local_oauth_server`
/// call keeps concurrent logins isolated.
#[derive(Default)]
struct Shared {
    /// The first captured code/state; `None` until a valid callback arrives.
    captured: Mutex<Option<Captured>>,
    /// Set by `close()` — an in-flight `wait_for_code` returns `None` on its
    /// next poll (TS `pollAborted`).
    poll_aborted: AtomicBool,
    /// Set by `close()` — the accept loop stops and releases the port
    /// (TS `server.close()`).
    shutdown: AtomicBool,
    /// Wakes the accept loop's `select!` so `close()` takes effect immediately.
    notify: Notify,
}

/// Handle over a running (or failed-to-bind) OAuth callback server. Combines the
/// TS `OAuthServerInfo` data (`port`/`ready`/`bindErrorCode`) with its behavior
/// (`close`/`waitForCode`).
pub struct LocalOAuthServer {
    port: u16,
    ready: bool,
    bind_error_code: Option<String>,
    shared: Arc<Shared>,
}

impl LocalOAuthServer {
    /// The callback port (always [`AUTH_REDIRECT`]`.port` = 1455).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether the listener bound successfully. `false` signals the caller to
    /// use the manual-paste fallback.
    pub fn ready(&self) -> bool {
        self.ready
    }

    /// The `errno`-style code from a failed bind (for example `"EADDRINUSE"`),
    /// or `None` when [`ready`](Self::ready) is `true`. Feeds
    /// `describe_callback_failure`.
    pub fn bind_error_code(&self) -> Option<&str> {
        self.bind_error_code.as_deref()
    }

    /// Data-only snapshot matching the serializable TS `OAuthServerInfo`.
    pub fn info(&self) -> OAuthServerInfo {
        OAuthServerInfo {
            port: self.port,
            ready: self.ready,
            bind_error_code: self.bind_error_code.clone(),
        }
    }

    /// Abort any in-flight [`wait_for_code`](Self::wait_for_code) and stop the
    /// server, releasing the callback port. Idempotent and infallible
    /// (TS `close()`).
    pub fn close(&self) {
        self.shared.poll_aborted.store(true, Ordering::SeqCst);
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.notify.notify_waiters();
    }

    /// Wait for a captured authorization code whose state matches
    /// `expected_state`, polling every 100 ms for up to 5 minutes.
    ///
    /// Returns `None` on abort (`close()`), a captured state that does not match
    /// `expected_state`, timeout, or when the server never bound
    /// (`ready == false` returns immediately — a failed server must not strand
    /// the caller).
    pub async fn wait_for_code(&self, expected_state: &str) -> Option<CapturedCode> {
        if !self.ready {
            // TS bind-failure handle: `waitForCode: () => Promise.resolve(null)`.
            return None;
        }
        poll_captured(
            &self.shared,
            expected_state,
            Duration::from_millis(POLL_INTERVAL_MS),
            MAX_ITERATIONS,
        )
        .await
    }
}

/// Poll [`Shared::captured`] for a code matching `expected_state`. Factored out
/// of [`LocalOAuthServer::wait_for_code`] so the abort/mismatch/timeout wiring
/// is testable without the 5-minute wall clock or binding port 1455.
async fn poll_captured(
    shared: &Shared,
    expected_state: &str,
    interval: Duration,
    max_iterations: u32,
) -> Option<CapturedCode> {
    for _ in 0..max_iterations {
        if shared.poll_aborted.load(Ordering::SeqCst) {
            return None;
        }
        // Clone out of the lock so it is released before we sleep (no lock held
        // across an await).
        let last = shared.captured.lock().unwrap().clone();
        if let Some(captured) = last {
            if captured.state != expected_state {
                log_warn(
                    "Discarding OAuth callback due to state mismatch in waitForCode",
                    None,
                );
                return None;
            }
            return Some(CapturedCode {
                code: captured.code,
            });
        }
        tokio::time::sleep(interval).await;
    }
    log_warn("OAuth poll timeout after 5 minutes", None);
    None
}

/// Start a local server that captures the OAuth authorization code redirected to
/// `/auth/callback`. **Never fails** — a bind error yields a handle with
/// `ready == false` and the bind `errno` code for the manual-paste fallback.
pub async fn start_local_oauth_server(state: &str) -> LocalOAuthServer {
    let shared = Arc::new(Shared::default());
    match bind_callback_listener().await {
        Ok(listener) => {
            spawn_accept_loop(listener, shared.clone(), state.to_string());
            LocalOAuthServer {
                port: AUTH_REDIRECT.port,
                ready: true,
                bind_error_code: None,
                shared,
            }
        }
        Err(error) => {
            let code = code_of(&error).map(String::from);
            let shown = code.as_deref().unwrap_or("unknown");
            log_error(
                &format!(
                    "Failed to bind {} ({shown}). Falling back to manual paste.",
                    AUTH_REDIRECT.origin
                ),
                None,
            );
            LocalOAuthServer {
                port: AUTH_REDIRECT.port,
                ready: false,
                bind_error_code: code,
                shared,
            }
        }
    }
}

/// Bind the callback listener on the first resolved address of
/// `localhost:1455`, mirroring Node's single-address `server.listen(port,
/// "localhost")`. Binding one concrete address (rather than every resolved
/// family) keeps the contended-port contract deterministic — whoever holds that
/// address wins.
async fn bind_callback_listener() -> std::io::Result<TcpListener> {
    let mut addrs = tokio::net::lookup_host((AUTH_REDIRECT.host, AUTH_REDIRECT.port)).await?;
    let addr = addrs.next().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "no socket address resolved for the OAuth callback host",
        )
    })?;
    TcpListener::bind(addr).await
}

/// Spawn the accept loop: serve each connection with the single-route handler
/// until `close()` flips [`Shared::shutdown`]. Dropping the listener on exit
/// releases the fixed callback port.
fn spawn_accept_loop(listener: TcpListener, shared: Arc<Shared>, state: String) {
    tokio::spawn(async move {
        let state = Arc::new(state);
        loop {
            if shared.shutdown.load(Ordering::SeqCst) {
                break;
            }
            tokio::select! {
                _ = shared.notify.notified() => break,
                accepted = listener.accept() => {
                    let stream = match accepted {
                        Ok((stream, _peer)) => stream,
                        // Transient accept errors are ignored (parity with the
                        // TS server, which keeps listening).
                        Err(_) => continue,
                    };
                    let conn_shared = shared.clone();
                    let conn_state = state.clone();
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);
                        let service = service_fn(move |req: Request<hyper::body::Incoming>| {
                            let response =
                                handle_request(&req, conn_shared.as_ref(), conn_state.as_str());
                            async move { Ok::<_, Infallible>(response) }
                        });
                        // Client-side errors (disconnects) are expected; the
                        // capture already happened in `handle_request`.
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(io, service)
                            .await;
                    });
                }
            }
        }
        drop(listener);
    });
}

/// Handle one callback request. Pure over [`Shared`] (records the first valid
/// code as a side effect) — no I/O — so it is unit-testable without a socket.
fn handle_request<B>(req: &Request<B>, shared: &Shared, expected_state: &str) -> Response<Full<Bytes>> {
    // Parse relative to the fixed callback origin, matching TS
    // `new URL(req.url, AUTH_REDIRECT.origin)`. hyper has already validated the
    // request target, so this parse effectively never fails; the 500 branch
    // mirrors the TS try/catch (no throwing equivalent exists in Rust).
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let Ok(url) = url::Url::parse(&format!("{}{}", AUTH_REDIRECT.origin, path_and_query)) else {
        log_error("Request handler error: could not parse request URL", None);
        return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal error");
    };

    if url.path() != AUTH_REDIRECT.path {
        return text_response(StatusCode::NOT_FOUND, "Not found");
    }

    let query_state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned());
    if query_state.as_deref() != Some(expected_state) {
        return text_response(StatusCode::BAD_REQUEST, "State mismatch");
    }

    // TS `if (!code)` treats both a missing param and an empty string as
    // "missing".
    let code = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned());
    let code = match code {
        Some(code) if !code.is_empty() => code,
        _ => return text_response(StatusCode::BAD_REQUEST, "Missing authorization code"),
    };

    // Build the success response first — the TS handler writes the page before
    // the duplicate check, so a duplicate callback also gets the success page —
    // then record the capture (first code wins).
    let response = success_response();
    {
        let mut guard = shared.captured.lock().unwrap();
        if guard.is_some() {
            log_warn(
                "Duplicate OAuth callback received; preserving first authorization code",
                None,
            );
        } else {
            *guard = Some(Captured {
                code,
                state: expected_state.to_string(),
            });
        }
    }
    response
}

/// A plain-text response with a static body (the 404/400/500 error pages — the
/// TS handler sets a status and `res.end(text)` with no content type).
fn text_response(status: StatusCode, body: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::from_static(body.as_bytes())))
        .expect("static text response is always valid")
}

/// The 200 success response: the embedded HTML page plus the FROZEN security
/// header set.
fn success_response() -> Response<Full<Bytes>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("X-Frame-Options", "DENY")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", SUCCESS_CSP)
        .body(Full::new(Bytes::from_static(SUCCESS_HTML.as_bytes())))
        .expect("success response is always valid")
}

// ===========================================================================
// Tests — ported from test/server.unit.test.ts,
// test/oauth-server.integration.test.ts, and
// test/oauth-server-port-conflict.test.ts.
//
// Port-1455 tests carry #[serial(oauth_1455)] and release the port before
// returning (ARCHITECTURE §9.4 / cma-testkit::port1455). Handler and poll
// wiring are exercised directly without a socket, so those tests need no serial
// guard and no 5-minute wall clock.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    use cma_testkit::port1455::serial;

    // ----- pure request-handler tests (no socket) --------------------------

    fn request(uri: &str) -> Request<()> {
        Request::builder().uri(uri).body(()).unwrap()
    }

    #[test]
    fn handler_returns_404_for_non_callback_paths() {
        let shared = Shared::default();
        let resp = handle_request(&request("/other-path"), &shared, "test-state");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert!(shared.captured.lock().unwrap().is_none());
    }

    #[test]
    fn handler_returns_400_for_state_mismatch() {
        let shared = Shared::default();
        let resp = handle_request(
            &request("/auth/callback?code=abc&state=wrong-state"),
            &shared,
            "test-state",
        );
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(shared.captured.lock().unwrap().is_none());
    }

    #[test]
    fn handler_returns_400_for_missing_code() {
        let shared = Shared::default();
        let resp = handle_request(
            &request("/auth/callback?state=test-state"),
            &shared,
            "test-state",
        );
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(shared.captured.lock().unwrap().is_none());
    }

    #[test]
    fn handler_returns_400_for_empty_code() {
        // TS `if (!code)` — a present-but-empty `code=` is still "missing".
        let shared = Shared::default();
        let resp = handle_request(
            &request("/auth/callback?code=&state=test-state"),
            &shared,
            "test-state",
        );
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(shared.captured.lock().unwrap().is_none());
    }

    #[test]
    fn handler_returns_200_with_html_and_security_headers() {
        let shared = Shared::default();
        let resp = handle_request(
            &request("/auth/callback?code=test-code&state=test-state"),
            &shared,
            "test-state",
        );
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(resp.headers().get("x-frame-options").unwrap(), "DENY");
        assert_eq!(
            resp.headers().get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert_eq!(
            resp.headers().get("content-security-policy").unwrap(),
            SUCCESS_CSP
        );
    }

    #[test]
    fn handler_captures_first_code_via_shared_state() {
        let shared = Shared::default();
        handle_request(
            &request("/auth/callback?code=captured-code&state=test-state"),
            &shared,
            "test-state",
        );
        assert_eq!(
            shared.captured.lock().unwrap().as_ref().map(|c| c.code.clone()),
            Some("captured-code".to_string())
        );
    }

    #[test]
    fn handler_keeps_first_code_when_duplicate_callbacks_arrive() {
        let shared = Shared::default();
        handle_request(
            &request("/auth/callback?code=first-code&state=test-state"),
            &shared,
            "test-state",
        );
        let second = handle_request(
            &request("/auth/callback?code=second-code&state=test-state"),
            &shared,
            "test-state",
        );
        // The duplicate still receives the success page…
        assert_eq!(second.status(), StatusCode::OK);
        // …but the first code is preserved.
        assert_eq!(shared.captured.lock().unwrap().as_ref().unwrap().code, "first-code");
    }

    #[test]
    fn handler_keeps_capture_state_isolated_between_instances() {
        // Mirrors the TS "keeps capture state isolated between two concurrent
        // server instances": capture lives on per-call `Shared`, not a global.
        let a = Shared::default();
        let b = Shared::default();
        handle_request(
            &request("/auth/callback?code=code-a&state=state-a"),
            &a,
            "state-a",
        );
        handle_request(
            &request("/auth/callback?code=code-b&state=state-b"),
            &b,
            "state-b",
        );
        assert_eq!(a.captured.lock().unwrap().as_ref().unwrap().code, "code-a");
        assert_eq!(b.captured.lock().unwrap().as_ref().unwrap().code, "code-b");
    }

    // ----- poll wiring tests (no socket, no 5-minute wall clock) -----------

    #[tokio::test]
    async fn poll_returns_captured_code_when_state_matches() {
        let shared = Shared::default();
        *shared.captured.lock().unwrap() = Some(Captured {
            code: "the-code".to_string(),
            state: "test-state".to_string(),
        });
        let out = poll_captured(&shared, "test-state", Duration::from_millis(1), MAX_ITERATIONS).await;
        assert_eq!(out, Some(CapturedCode { code: "the-code".to_string() }));
    }

    #[tokio::test]
    async fn poll_discards_code_on_state_mismatch() {
        let shared = Shared::default();
        *shared.captured.lock().unwrap() = Some(Captured {
            code: "the-code".to_string(),
            state: "other-state".to_string(),
        });
        let out = poll_captured(&shared, "expected-state", Duration::from_millis(1), MAX_ITERATIONS).await;
        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn poll_returns_none_immediately_when_aborted() {
        let shared = Shared::default();
        shared.poll_aborted.store(true, Ordering::SeqCst);
        // Even with a code present, an aborted poll returns None.
        *shared.captured.lock().unwrap() = Some(Captured {
            code: "x".to_string(),
            state: "expected".to_string(),
        });
        let out = poll_captured(&shared, "expected", Duration::from_millis(1), MAX_ITERATIONS).await;
        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn poll_times_out_to_none_without_a_code() {
        // Exercises the timeout branch (returns None + warn log) with a tiny
        // iteration budget instead of the real 3000 × 100 ms.
        let shared = Shared::default();
        let out = poll_captured(&shared, "test-state", Duration::from_millis(1), 3).await;
        assert_eq!(out, None);
    }

    #[test]
    fn timeout_constants_match_ts() {
        // Guards the REAL 5-minute / 100 ms budget without waiting for it.
        assert_eq!(POLL_INTERVAL_MS, 100);
        assert_eq!(TIMEOUT_MS, 5 * 60 * 1000);
        assert_eq!(MAX_ITERATIONS, 3000);
    }

    // ----- handle-level behavior (no socket) -------------------------------

    #[tokio::test]
    async fn wait_for_code_is_none_when_not_ready() {
        let server = LocalOAuthServer {
            port: 1455,
            ready: false,
            bind_error_code: Some("EADDRINUSE".to_string()),
            shared: Arc::new(Shared::default()),
        };
        assert_eq!(server.wait_for_code("test-state").await, None);
    }

    #[test]
    fn close_sets_abort_and_shutdown_flags() {
        let server = LocalOAuthServer {
            port: 1455,
            ready: true,
            bind_error_code: None,
            shared: Arc::new(Shared::default()),
        };
        server.close();
        assert!(server.shared.poll_aborted.load(Ordering::SeqCst));
        assert!(server.shared.shutdown.load(Ordering::SeqCst));
    }

    #[test]
    fn info_reflects_bind_failure_shape() {
        let server = LocalOAuthServer {
            port: 1455,
            ready: false,
            bind_error_code: Some("EADDRINUSE".to_string()),
            shared: Arc::new(Shared::default()),
        };
        let info = server.info();
        assert_eq!(info.port, 1455);
        assert!(!info.ready);
        assert_eq!(info.bind_error_code.as_deref(), Some("EADDRINUSE"));
    }

    #[test]
    fn bind_error_code_feeds_contention_guidance() {
        // Mirrors the TS port-conflict "feeds the bind error into guidance"
        // test: EADDRINUSE selects the assertive branch. Pure — no socket.
        use crate::callback_guidance::{
            CallbackFailureContext, CallbackFailureReason, describe_callback_failure,
        };
        let ctx = CallbackFailureContext {
            bind_error_code: Some("EADDRINUSE".to_string()),
        };
        let guidance = describe_callback_failure(CallbackFailureReason::BindFailed, &ctx).join("\n");
        assert!(guidance.contains("another process already holds it"));
        assert!(guidance.contains(&AUTH_REDIRECT.port.to_string()));
        assert!(guidance.contains("--device-auth"));
    }

    // ----- live integration tests (bind port 1455) -------------------------

    /// Resolve the single address the server will bind (same first-address rule
    /// as `bind_callback_listener`), so test clients hit exactly that socket —
    /// deterministic on dual-stack hosts.
    async fn callback_addr() -> SocketAddr {
        tokio::net::lookup_host((AUTH_REDIRECT.host, AUTH_REDIRECT.port))
            .await
            .expect("resolve localhost:1455")
            .next()
            .expect("at least one address for localhost:1455")
    }

    /// Poll-bind `addr` until it is free (or fail loudly), mirroring the TS
    /// integration suite's awaited port release. `close()` drops the listener
    /// asynchronously, so the next binder must wait for the socket to clear.
    async fn wait_for_addr_free(addr: SocketAddr) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match std::net::TcpListener::bind(addr) {
                Ok(listener) => {
                    drop(listener);
                    return;
                }
                Err(_) if std::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => {
                    panic!("callback port {addr} did not free during teardown: {error}")
                }
            }
        }
    }

    #[tokio::test]
    #[serial(oauth_1455)]
    async fn captures_authorization_code_from_valid_callback() {
        let addr = callback_addr().await;
        wait_for_addr_free(addr).await;

        let state = "test-state-12345";
        let server = start_local_oauth_server(state).await;
        assert!(server.ready());
        assert_eq!(server.port(), 1455);
        assert_eq!(server.bind_error_code(), None);

        let code = "auth-code-67890";
        let response = reqwest::get(format!("http://{addr}/auth/callback?code={code}&state={state}"))
            .await
            .expect("callback request succeeds");
        assert_eq!(response.status(), 200);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(content_type.contains("text/html"), "content-type was {content_type:?}");
        let body = response.text().await.expect("body");
        assert!(body.contains("Sign-in complete"), "unexpected success page body");

        let captured = server.wait_for_code(state).await;
        assert_eq!(captured, Some(CapturedCode { code: code.to_string() }));

        server.close();
        wait_for_addr_free(addr).await;
    }

    #[tokio::test]
    #[serial(oauth_1455)]
    async fn first_code_wins_when_duplicate_callbacks_arrive() {
        let addr = callback_addr().await;
        wait_for_addr_free(addr).await;

        let state = "dup-state";
        let server = start_local_oauth_server(state).await;
        assert!(server.ready());

        // The capture is recorded before the response is sent, so once the first
        // request returns 200 the code is already stored.
        let first = reqwest::get(format!("http://{addr}/auth/callback?code=first-code&state={state}"))
            .await
            .expect("first callback");
        assert_eq!(first.status(), 200);
        let second = reqwest::get(format!("http://{addr}/auth/callback?code=second-code&state={state}"))
            .await
            .expect("second callback");
        assert_eq!(second.status(), 200);

        let captured = server.wait_for_code(state).await;
        assert_eq!(captured, Some(CapturedCode { code: "first-code".to_string() }));

        server.close();
        wait_for_addr_free(addr).await;
    }

    #[tokio::test]
    #[serial(oauth_1455)]
    async fn rejects_invalid_callbacks_over_the_wire() {
        let addr = callback_addr().await;
        wait_for_addr_free(addr).await;

        let state = "reject-state";
        let server = start_local_oauth_server(state).await;
        assert!(server.ready());

        let not_found = reqwest::get(format!("http://{addr}/other-path")).await.unwrap();
        assert_eq!(not_found.status(), 404);
        assert!(not_found.text().await.unwrap().contains("Not found"));

        let mismatch = reqwest::get(format!("http://{addr}/auth/callback?code=x&state=wrong"))
            .await
            .unwrap();
        assert_eq!(mismatch.status(), 400);
        assert!(mismatch.text().await.unwrap().contains("State mismatch"));

        let missing = reqwest::get(format!("http://{addr}/auth/callback?state={state}"))
            .await
            .unwrap();
        assert_eq!(missing.status(), 400);
        assert!(missing.text().await.unwrap().contains("Missing authorization code"));

        server.close();
        wait_for_addr_free(addr).await;
    }

    #[tokio::test]
    #[serial(oauth_1455)]
    async fn bind_conflict_reports_not_ready_with_eaddrinuse() {
        let addr = callback_addr().await;
        wait_for_addr_free(addr).await;

        // Occupy the exact address the server will attempt to bind, forcing the
        // never-reject fallback (spec 07 gotcha 7).
        let squatter = std::net::TcpListener::bind(addr).expect("squat callback port");

        let server = start_local_oauth_server("test-state").await;
        assert!(!server.ready());
        assert_eq!(server.port(), 1455);
        assert_eq!(server.bind_error_code(), Some("EADDRINUSE"));
        // A server that never bound must not strand the caller.
        assert_eq!(server.wait_for_code("test-state").await, None);
        server.close();

        drop(squatter);
        wait_for_addr_free(addr).await;
    }

    #[tokio::test]
    #[serial(oauth_1455)]
    async fn close_releases_the_callback_port() {
        let addr = callback_addr().await;
        wait_for_addr_free(addr).await;

        let server = start_local_oauth_server("cleanup").await;
        assert!(server.ready());
        server.close();
        wait_for_addr_free(addr).await;

        // The port must be free for the next login to bind cleanly.
        let again = start_local_oauth_server("cleanup-2").await;
        assert!(again.ready(), "callback port should rebind after close");
        again.close();
        wait_for_addr_free(addr).await;
    }
}
