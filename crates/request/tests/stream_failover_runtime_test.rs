//! Port of `test/stream-failover-runtime.test.ts`.
//!
//! `FakeServerResponse` mirrors the TS test double for Node's
//! `ServerResponse` via the `ClientStreamWriter` trait: per-index
//! backpressure, an event log for ordering assertions, drain/close/error
//! signals, and production-faithful write-after-destroy throwing.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use futures::future::BoxFuture;
use http::HeaderMap;
use http::header::{HeaderName, HeaderValue};

use cma_request::response_handler::{BodyStream, BoxError, StreamResponse};
use cma_request::stream_failover_runtime::{
    ClientStreamWriter, HOP_BY_HOP_HEADERS, StreamForwardStatus, forward_streaming_response,
    read_error_body, response_headers_for_client, with_timeout,
};

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// TS `createStatus()` — only the fields this module touches.
#[derive(Default)]
struct TestStatus {
    streams_started: u32,
    last_error: Option<String>,
}

impl StreamForwardStatus for TestStatus {
    fn increment_streams_started(&mut self) {
        self.streams_started += 1;
    }

    fn set_last_error(&mut self, message: String) {
        self.last_error = Some(message);
    }
}

#[derive(Default)]
struct FakeState {
    status_code: Option<u16>,
    headers: Vec<(String, String)>,
    chunks: Vec<Vec<u8>>,
    ended: bool,
    destroyed: bool,
    destroy_error: Option<String>,
    /// Indices (0-based write order) for which write() reports a full buffer.
    backpressure_writes: HashSet<usize>,
    events: Vec<String>,
}

struct FakeInner {
    state: Mutex<FakeState>,
    /// Settles `wait_for_drain` (drain OR close OR error).
    settle: tokio::sync::Notify,
    closed_tx: tokio::sync::watch::Sender<bool>,
    closed_rx: tokio::sync::watch::Receiver<bool>,
}

#[derive(Clone)]
struct FakeServerResponse {
    inner: Arc<FakeInner>,
}

impl FakeServerResponse {
    fn new() -> Self {
        let (closed_tx, closed_rx) = tokio::sync::watch::channel(false);
        Self {
            inner: Arc::new(FakeInner {
                state: Mutex::new(FakeState::default()),
                settle: tokio::sync::Notify::new(),
                closed_tx,
                closed_rx,
            }),
        }
    }

    fn with_backpressure(indices: &[usize]) -> Self {
        let fake = Self::new();
        fake.inner.state.lock().unwrap().backpressure_writes = indices.iter().copied().collect();
        fake
    }

    fn emit_drain(&self) {
        self.inner.state.lock().unwrap().events.push("drain".to_string());
        self.inner.settle.notify_waiters();
    }

    fn emit_close(&self) {
        let _ = self.inner.closed_tx.send(true);
        self.inner.settle.notify_waiters();
    }

    /// Node destroys the response on a socket error before emitting it.
    fn emit_error_after_destroy(&self) {
        self.inner.state.lock().unwrap().destroyed = true;
        self.inner.settle.notify_waiters();
    }

    fn state<T>(&self, f: impl FnOnce(&FakeState) -> T) -> T {
        f(&self.inner.state.lock().unwrap())
    }

    fn body_text(&self) -> String {
        self.state(|s| {
            String::from_utf8_lossy(&s.chunks.iter().flatten().copied().collect::<Vec<u8>>())
                .into_owned()
        })
    }
}

impl ClientStreamWriter for FakeServerResponse {
    fn write_head(&mut self, status: u16, headers: Vec<(String, String)>) {
        let mut state = self.inner.state.lock().unwrap();
        state.status_code = Some(status);
        state.headers = headers;
    }

    fn writable_ended(&self) -> bool {
        self.inner.state.lock().unwrap().ended
    }

    fn destroyed(&self) -> bool {
        self.inner.state.lock().unwrap().destroyed
    }

    fn write(&mut self, chunk: &[u8]) -> Result<bool, BoxError> {
        let mut state = self.inner.state.lock().unwrap();
        // Production-faithful: writing to a destroyed ServerResponse throws.
        if state.destroyed {
            return Err("ERR_STREAM_DESTROYED: write after destroy".to_string().into());
        }
        let index = state.chunks.len();
        state.chunks.push(chunk.to_vec());
        state.events.push(format!("write:{index}"));
        Ok(!state.backpressure_writes.contains(&index))
    }

    fn wait_for_drain(&mut self) -> BoxFuture<'_, ()> {
        let inner = self.inner.clone();
        Box::pin(async move {
            inner.settle.notified().await;
        })
    }

    fn end(&mut self) {
        self.inner.state.lock().unwrap().ended = true;
    }

    fn destroy(&mut self, error: Option<BoxError>) {
        let mut state = self.inner.state.lock().unwrap();
        state.destroyed = true;
        state.destroy_error = error.map(|e| e.to_string());
    }

    fn closed(&self) -> BoxFuture<'static, ()> {
        let mut rx = self.inner.closed_rx.clone();
        Box::pin(async move {
            loop {
                if *rx.borrow() {
                    return;
                }
                if rx.changed().await.is_err() {
                    futures::future::pending::<()>().await;
                }
            }
        })
    }
}

fn stream_of(chunks: Vec<Bytes>) -> BodyStream {
    futures::stream::iter(chunks.into_iter().map(Ok::<_, BoxError>)).boxed()
}

fn upstream_with_chunks(status: u16, headers: HeaderMap, chunks: Vec<&str>) -> StreamResponse {
    StreamResponse::new(
        status,
        "",
        headers,
        Some(stream_of(chunks.into_iter().map(|c| Bytes::copy_from_slice(c.as_bytes())).collect())),
    )
}

fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

fn error_counter() -> (Arc<AtomicU32>, impl FnOnce()) {
    let count = Arc::new(AtomicU32::new(0));
    let inc = count.clone();
    (count, move || {
        inc.fetch_add(1, Ordering::SeqCst);
    })
}

// ---------------------------------------------------------------------------
// responseHeadersForClient
// ---------------------------------------------------------------------------

#[test]
fn drops_hop_by_hop_private_rotation_and_content_encoding_headers() {
    let upstream = header_map(&[
        ("content-type", "application/json"),
        ("x-request-id", "req_1"),
        ("connection", "keep-alive"),
        ("transfer-encoding", "chunked"),
        ("content-encoding", "gzip"),
        ("x-codex-multi-auth-account-email", "user@example.com"),
        ("x-codex-multi-auth-account-id", "acc_1"),
    ]);
    let mut filtered = response_headers_for_client(&upstream);
    filtered.sort();
    assert_eq!(
        filtered,
        vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("x-request-id".to_string(), "req_1".to_string()),
        ]
    );
}

#[test]
fn blocks_any_header_under_the_private_account_prefix_not_just_known_names() {
    let upstream = header_map(&[
        ("content-type", "application/json"),
        ("x-codex-multi-auth-account-plan", "pro"),
        ("x-codex-multi-auth-account-future-field", "secret"),
    ]);
    assert_eq!(
        response_headers_for_client(&upstream),
        vec![("content-type".to_string(), "application/json".to_string())]
    );
}

#[test]
fn covers_every_hop_by_hop_header_in_the_exported_set() {
    let mut upstream = HeaderMap::new();
    for name in HOP_BY_HOP_HEADERS {
        upstream.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_static("1"),
        );
    }
    assert_eq!(response_headers_for_client(&upstream), Vec::new());
}

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

#[tokio::test]
async fn with_timeout_resolves_with_the_underlying_future_before_the_deadline() {
    let result = with_timeout(async { "ok" }, 1_000.0, || (), "stalled").await;
    assert_eq!(result.unwrap(), "ok");
}

#[tokio::test]
async fn with_timeout_rejects_with_message_and_fires_on_timeout_on_stall() {
    let (count, on_timeout) = error_counter();
    let error = with_timeout(
        futures::future::pending::<()>(),
        30.0,
        on_timeout,
        "upstream stalled",
    )
    .await
    .expect_err("must time out");
    assert_eq!(error.to_string(), "upstream stalled");
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn with_timeout_enforces_a_minimum_1ms_timer_for_non_positive_timeouts() {
    let error = with_timeout(futures::future::pending::<()>(), 0.0, || (), "stalled")
        .await
        .expect_err("must time out");
    assert_eq!(error.to_string(), "stalled");
}

// ---------------------------------------------------------------------------
// readErrorBody
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reads_a_streamed_body_to_completion() {
    let mut response = StreamResponse::new(
        200,
        "",
        HeaderMap::new(),
        Some(stream_of(vec![
            Bytes::from_static(br#"{"error":"#),
            Bytes::from_static(br#""nope"}"#),
        ])),
    );
    assert_eq!(read_error_body(&mut response, 1_000.0, None).await, r#"{"error":"nope"}"#);
}

#[tokio::test]
async fn caps_the_body_at_max_bytes_and_returns_the_bytes_read_so_far() {
    let big = Bytes::from(vec![b'x'; 64]);
    let mut response = StreamResponse::new(
        200,
        "",
        HeaderMap::new(),
        Some(stream_of(vec![big.clone(), big.clone(), big])),
    );
    // Cap below the second chunk's cumulative size: the overflowing chunk is
    // dropped, so only the first 64 bytes survive.
    assert_eq!(
        read_error_body(&mut response, 1_000.0, Some(100)).await,
        "x".repeat(64)
    );
}

#[tokio::test]
async fn returns_the_partial_body_when_a_later_chunk_stalls_past_the_idle_timeout() {
    let stream: BodyStream = futures::stream::once(async {
        Ok::<_, BoxError>(Bytes::from_static(b"partial"))
    })
    .chain(futures::stream::pending())
    .boxed();
    let mut response = StreamResponse::new(200, "", HeaderMap::new(), Some(stream));
    assert_eq!(read_error_body(&mut response, 25.0, None).await, "partial");
}

#[tokio::test]
async fn falls_back_to_empty_when_the_response_has_no_streamable_body() {
    let mut response = StreamResponse::new(200, "", HeaderMap::new(), None);
    assert_eq!(read_error_body(&mut response, 50.0, None).await, "");
}

// ---------------------------------------------------------------------------
// forwardStreamingResponse
// ---------------------------------------------------------------------------

#[tokio::test]
async fn forwards_status_filtered_headers_and_chunks_then_ends() {
    let mut res = FakeServerResponse::new();
    let mut status = TestStatus::default();
    let upstream = upstream_with_chunks(
        200,
        header_map(&[
            ("content-type", "text/event-stream"),
            ("connection", "keep-alive"),
            ("x-codex-multi-auth-account-id", "acc_1"),
        ]),
        vec!["data: a\n\n", "data: b\n\n"],
    );

    let (errors, on_stream_error) = error_counter();
    let ok = forward_streaming_response(upstream, &mut res, &mut status, on_stream_error, 1_000).await;

    assert!(ok);
    assert_eq!(status.streams_started, 1);
    assert_eq!(res.state(|s| s.status_code), Some(200));
    assert_eq!(
        res.state(|s| s.headers.clone()),
        vec![("content-type".to_string(), "text/event-stream".to_string())]
    );
    assert_eq!(res.body_text(), "data: a\n\ndata: b\n\n");
    assert!(res.state(|s| s.ended));
    assert_eq!(errors.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn pauses_writes_while_the_client_buffer_is_full_and_resumes_on_drain() {
    let mut res = FakeServerResponse::with_backpressure(&[0]);
    let mut status = TestStatus::default();
    let upstream = upstream_with_chunks(200, HeaderMap::new(), vec!["data: a\n\n", "data: b\n\n"]);

    let drain_handle = {
        let res = res.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            res.emit_drain();
        })
    };

    let ok =
        forward_streaming_response(upstream, &mut res, &mut status, || (), 5_000).await;
    drain_handle.await.unwrap();

    assert!(ok);
    assert_eq!(res.body_text(), "data: a\n\ndata: b\n\n");
    let events = res.state(|s| s.events.clone());
    let drain = events.iter().position(|e| e == "drain").unwrap();
    let write0 = events.iter().position(|e| e == "write:0").unwrap();
    let write1 = events.iter().position(|e| e == "write:1").unwrap();
    assert!(drain > write0);
    assert!(write1 > drain);
    assert!(res.state(|s| s.ended));
}

#[tokio::test]
async fn waits_for_a_drain_per_backpressured_write_across_multiple_chunks() {
    let mut res = FakeServerResponse::with_backpressure(&[0, 2]);
    let mut status = TestStatus::default();
    let upstream = upstream_with_chunks(200, HeaderMap::new(), vec!["a", "b", "c"]);

    // Each backpressured write gets its own drain; emit one per pause.
    let drain_task = {
        let res = res.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(15)).await;
                res.emit_drain();
            }
        })
    };

    let ok =
        forward_streaming_response(upstream, &mut res, &mut status, || (), 5_000).await;
    drain_task.abort();

    assert!(ok);
    assert_eq!(res.body_text(), "abc");
    let events = res.state(|s| s.events.clone());
    let first_drain = events.iter().position(|e| e == "drain").unwrap();
    let last_drain = events.iter().rposition(|e| e == "drain").unwrap();
    let write0 = events.iter().position(|e| e == "write:0").unwrap();
    let write1 = events.iter().position(|e| e == "write:1").unwrap();
    let write2 = events.iter().position(|e| e == "write:2").unwrap();
    assert!(first_drain > write0);
    assert!(write1 > first_drain);
    assert!(last_drain > write2);
    assert!(res.state(|s| s.ended));
}

#[tokio::test]
async fn does_not_park_forever_when_the_client_closes_during_backpressure() {
    let mut res = FakeServerResponse::with_backpressure(&[0]);
    let mut status = TestStatus::default();
    let upstream = upstream_with_chunks(200, HeaderMap::new(), vec!["data: a\n\n", "data: b\n\n"]);

    // The client disconnects instead of draining: the forwarder must finish
    // via the client-close path instead of parking on the drain wait.
    let close_handle = {
        let res = res.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            res.emit_close();
        })
    };

    let ok =
        forward_streaming_response(upstream, &mut res, &mut status, || (), 5_000).await;
    close_handle.await.unwrap();

    assert!(ok);
    assert_eq!(res.body_text(), "data: a\n\n");
}

#[tokio::test]
async fn fails_the_stream_when_the_socket_errors_during_backpressure() {
    // The error event settles the drain wait silently; the failure must then
    // surface through the next write throwing on the destroyed response and
    // the catch path recording it.
    let mut res = FakeServerResponse::with_backpressure(&[0]);
    let mut status = TestStatus::default();
    let upstream = upstream_with_chunks(200, HeaderMap::new(), vec!["data: a\n\n", "data: b\n\n"]);

    let error_handle = {
        let res = res.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            res.emit_error_after_destroy();
        })
    };

    let (errors, on_stream_error) = error_counter();
    let ok =
        forward_streaming_response(upstream, &mut res, &mut status, on_stream_error, 5_000).await;
    error_handle.await.unwrap();

    assert!(!ok);
    assert_eq!(errors.load(Ordering::SeqCst), 1);
    assert!(status.last_error.unwrap().contains("write after destroy"));
    assert_eq!(res.body_text(), "data: a\n\n");
    assert!(!res.state(|s| s.ended));
}

#[tokio::test]
async fn ends_immediately_when_the_upstream_has_no_body() {
    let mut res = FakeServerResponse::new();
    let mut status = TestStatus::default();
    let upstream = StreamResponse::new(204, "", HeaderMap::new(), None);

    let ok = forward_streaming_response(upstream, &mut res, &mut status, || (), 1_000).await;

    assert!(ok);
    assert_eq!(res.state(|s| s.status_code), Some(204));
    assert!(res.state(|s| s.ended));
    assert!(res.state(|s| s.chunks.is_empty()));
}

#[tokio::test]
async fn records_the_stall_error_destroys_the_response_and_reports_failure() {
    let mut res = FakeServerResponse::new();
    let mut status = TestStatus::default();
    let stream: BodyStream = futures::stream::once(async {
        Ok::<_, BoxError>(Bytes::from_static(b"data: a\n\n"))
    })
    .chain(futures::stream::pending())
    .boxed();
    let upstream = StreamResponse::new(200, "", HeaderMap::new(), Some(stream));

    let (errors, on_stream_error) = error_counter();
    let ok = forward_streaming_response(upstream, &mut res, &mut status, on_stream_error, 25).await;

    assert!(!ok);
    assert_eq!(errors.load(Ordering::SeqCst), 1);
    assert_eq!(status.last_error.as_deref(), Some("upstream stream stalled after 25ms"));
    assert!(res.state(|s| s.destroyed));
    assert!(res.state(|s| s.destroy_error.is_some()));
    assert_eq!(res.body_text(), "data: a\n\n");
    assert!(!res.state(|s| s.ended));
}

#[tokio::test]
async fn fails_the_stream_when_the_upstream_read_rejects_mid_stream() {
    let mut res = FakeServerResponse::new();
    let mut status = TestStatus::default();
    let stream: BodyStream = futures::stream::once(async {
        Ok::<_, BoxError>(Bytes::from_static(b"data: a\n\n"))
    })
    .chain(futures::stream::once(async {
        Err::<Bytes, BoxError>("socket reset".to_string().into())
    }))
    .boxed();
    let upstream = StreamResponse::new(200, "", HeaderMap::new(), Some(stream));

    let (errors, on_stream_error) = error_counter();
    let ok =
        forward_streaming_response(upstream, &mut res, &mut status, on_stream_error, 1_000).await;

    assert!(!ok);
    assert_eq!(errors.load(Ordering::SeqCst), 1);
    assert_eq!(status.last_error.as_deref(), Some("socket reset"));
    assert!(res.state(|s| s.destroyed));
    assert!(res.state(|s| s.destroy_error.is_some()));
    assert!(!res.state(|s| s.ended));
}
