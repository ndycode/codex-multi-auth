//! Port of `test/stream-failover.test.ts`.
//!
//! Not ported 1:1: the two "unhandled rejection" tests (hostile
//! `releaseLock`, pump-rejection safety net) exercise web-streams lock
//! mechanics with no Rust analogue; the cancellation test below covers the
//! equivalent guarantee (dropping the wrapped body cancels the source).
//!
//! Timing note: soft/stall timeouts floor at 1000 ms (same as TS), so the
//! stall-driven tests each take about a second of wall time.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use bytes::Bytes;
use futures::StreamExt;
use http::HeaderMap;
use http::header::{CONTENT_TYPE, HeaderValue};

use cma_request::response_handler::{BodyStream, BoxError, StreamResponse};
use cma_request::stream_failover::{StreamFailoverOptions, with_streaming_failover};

fn event_stream_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    headers
}

fn make_sse_response(payload: &str) -> StreamResponse {
    StreamResponse::from_text(200, "", event_stream_headers(), payload)
}

/// A response whose stream yields one chunk then stalls forever.
fn make_stalling_response() -> StreamResponse {
    let stream: BodyStream = futures::stream::once(async {
        Ok::<_, BoxError>(Bytes::from_static(b"data: first\n\n"))
    })
    .chain(futures::stream::pending())
    .boxed();
    StreamResponse::new(200, "", event_stream_headers(), Some(stream))
}

/// A response whose stream never yields anything.
fn make_idle_response() -> StreamResponse {
    let stream: BodyStream = futures::stream::pending().boxed();
    StreamResponse::new(200, "", event_stream_headers(), Some(stream))
}

#[tokio::test]
async fn returns_original_response_when_max_failovers_disabled() {
    let mut response = with_streaming_failover(
        make_sse_response("data: ok\n\n"),
        |_attempt, _emitted| async { Ok(Some(make_sse_response("data: fallback\n\n"))) },
        StreamFailoverOptions {
            max_failovers: Some(0.0),
            stall_timeout_ms: Some(10.0),
            ..Default::default()
        },
    );
    let text = response.collect_text().await.unwrap();
    assert!(text.contains("data: ok"));
}

#[tokio::test]
async fn switches_to_fallback_stream_when_primary_stalls() {
    let calls = Arc::new(AtomicU32::new(0));
    let counter = calls.clone();
    let mut response = with_streaming_failover(
        make_idle_response(),
        move |_attempt, _emitted| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(Some(make_sse_response("data: second\n\n")))
            }
        },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            stall_timeout_ms: Some(10.0),
            ..Default::default()
        },
    );
    let text = response.collect_text().await.unwrap();
    assert!(text.contains("codex-multi-auth failover 1"));
    assert!(text.contains("data: second"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn includes_request_id_marker_when_provided() {
    let mut response = with_streaming_failover(
        make_idle_response(),
        |_attempt, _emitted| async { Ok(Some(make_sse_response("data: fallback\n\n"))) },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            stall_timeout_ms: Some(10.0),
            request_instance_id: Some("req-123".to_string()),
            ..Default::default()
        },
    );
    let text = response.collect_text().await.unwrap();
    assert!(text.contains("codex-multi-auth failover 1 req:req-123"));
}

#[tokio::test]
async fn failover_marker_bytes_are_exact() {
    let mut response = with_streaming_failover(
        make_idle_response(),
        |_attempt, _emitted| async { Ok(Some(make_sse_response("data: fallback\n\n"))) },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            stall_timeout_ms: Some(10.0),
            ..Default::default()
        },
    );
    let text = response.collect_text().await.unwrap();
    // Byte-exact SSE comment contract (spec 06 gotcha 14).
    assert_eq!(text, ": codex-multi-auth failover 1\n\ndata: fallback\n\n");
}

#[tokio::test]
async fn errors_when_fallback_is_unavailable() {
    let mut response = with_streaming_failover(
        make_idle_response(),
        |_attempt, _emitted| async { Ok(None) },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            stall_timeout_ms: Some(10.0),
            ..Default::default()
        },
    );
    let error = response.collect_text().await.expect_err("must stall");
    assert!(error.to_string().contains("SSE stream stalled"));
}

#[tokio::test]
async fn propagates_fallback_provider_exceptions_deterministically() {
    let mut response = with_streaming_failover(
        make_idle_response(),
        |_attempt, _emitted| async { Err::<Option<StreamResponse>, BoxError>("fallback exploded".to_string().into()) },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            stall_timeout_ms: Some(10.0),
            ..Default::default()
        },
    );
    let error = response.collect_text().await.expect_err("must explode");
    assert!(error.to_string().contains("fallback exploded"));
}

#[tokio::test]
async fn does_not_trigger_fallback_when_read_error_races_after_bytes_emitted() {
    let calls = Arc::new(AtomicU32::new(0));
    let counter = calls.clone();
    // Primary emits a chunk, then errors ~20ms later.
    let stream: BodyStream = futures::stream::once(async {
        Ok::<_, BoxError>(Bytes::from_static(b"data: first\n\n"))
    })
    .chain(futures::stream::once(async {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        Err::<Bytes, BoxError>("primary read failure".to_string().into())
    }))
    .boxed();
    let race_response = StreamResponse::new(200, "", event_stream_headers(), Some(stream));

    let mut response = with_streaming_failover(
        race_response,
        move |_attempt, _emitted| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(Some(make_sse_response("data: fallback\n\n")))
            }
        },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            soft_timeout_ms: Some(10.0),
            hard_timeout_ms: Some(20.0),
            ..Default::default()
        },
    );
    let error = response.collect_text().await.expect_err("must fail");
    assert!(error.to_string().contains("primary read failure"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn does_not_replay_after_bytes_have_already_been_emitted() {
    let calls = Arc::new(AtomicU32::new(0));
    let counter = calls.clone();
    let mut response = with_streaming_failover(
        make_stalling_response(),
        move |_attempt, _emitted| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(Some(make_sse_response("data: fallback\n\n")))
            }
        },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            stall_timeout_ms: Some(10.0),
            ..Default::default()
        },
    );
    let error = response.collect_text().await.expect_err("must stall");
    assert!(error.to_string().contains("SSE stream stalled"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

/// Guard whose Drop marks the source stream as cancelled.
struct DropGuard(Arc<AtomicBool>);

impl Drop for DropGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn releases_underlying_source_when_wrapped_stream_is_cancelled() {
    let cancelled = Arc::new(AtomicBool::new(false));
    let guard = DropGuard(cancelled.clone());
    // Source: one chunk, then pending forever; dropping it drops the guard.
    let stream: BodyStream = futures::stream::unfold(
        (Some(Bytes::from_static(b"data: first\n\n")), guard),
        |(chunk, guard)| async move {
            match chunk {
                Some(chunk) => Some((Ok::<_, BoxError>(chunk), (None, guard))),
                None => {
                    futures::future::pending::<()>().await;
                    unreachable!()
                }
            }
        },
    )
    .boxed();
    let source = StreamResponse::new(200, "", event_stream_headers(), Some(stream));

    let mut response = with_streaming_failover(
        source,
        |_attempt, _emitted| async { Ok(None) },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            stall_timeout_ms: Some(10_000.0),
            ..Default::default()
        },
    );

    let mut body = response.body.take().expect("wrapped body");
    let first = body.next().await.expect("first chunk").expect("ok chunk");
    assert_eq!(&first[..], b"data: first\n\n");

    // Cancel the wrapped stream (TS reader.cancel()): drop it, give the pump
    // a moment to observe the closed channel, then check the source was
    // cancelled (dropped).
    drop(body);
    for _ in 0..50 {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(cancelled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn preserves_status_and_ensures_content_type_on_the_wrapper() {
    // Headers WITHOUT content-type: the wrapper must add the SSE default.
    let stream: BodyStream = futures::stream::once(async {
        Ok::<_, BoxError>(Bytes::from_static(b"data: ok\n\n"))
    })
    .boxed();
    let source = StreamResponse::new(201, "Created", HeaderMap::new(), Some(stream));
    let response = with_streaming_failover(
        source,
        |_attempt, _emitted| async { Ok(None) },
        StreamFailoverOptions {
            max_failovers: Some(1.0),
            ..Default::default()
        },
    );
    assert_eq!(response.status, 201);
    assert_eq!(response.status_text, "Created");
    assert_eq!(
        response.headers.get(CONTENT_TYPE).unwrap(),
        "text/event-stream; charset=utf-8"
    );
}
