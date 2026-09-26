//! Port of `lib/request/stream-failover.ts` — client-visible stream failover
//! wrapper (spec 06 §20).
//!
//! Wraps a streaming [`StreamResponse`] so the stream can switch to a fallback
//! source when the primary stalls or errors — but ONLY before any bytes have
//! been flushed to the consumer (`emitted_bytes > 0` refuses replay: reissuing
//! the upstream request after partial output can duplicate streamed text and
//! side-effectful tool activity). The overall failover cap is enforced
//! elsewhere to 1 (`failover_config::cap_stream_failover_max`).
//!
//! Concurrency: the wrapper expects a single consumer of the returned body.
//! The pump runs as a spawned task feeding a bounded channel, mirroring the
//! TS `ReadableStream`/controller pattern; dropping the returned body cancels
//! the pump and the current upstream stream (TS `cancel()`).

use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use tokio::sync::mpsc;

use crate::response_handler::{BodyStream, BoxError, StreamResponse, ensure_content_type};

pub const DEFAULT_MAX_FAILOVERS: f64 = 1.0;
pub const DEFAULT_STALL_TIMEOUT_MS: f64 = 45_000.0;
pub const DEFAULT_SOFT_TIMEOUT_MS: f64 = 15_000.0;
pub const MAX_REQUEST_INSTANCE_ID_LENGTH: usize = 64;

/// TS `StreamFailoverOptions`.
#[derive(Debug, Clone, Default)]
pub struct StreamFailoverOptions {
    pub max_failovers: Option<f64>,
    pub stall_timeout_ms: Option<f64>,
    pub soft_timeout_ms: Option<f64>,
    pub hard_timeout_ms: Option<f64>,
    pub request_instance_id: Option<String>,
}

/// TS `StallTimeoutError` — message `"SSE stream stalled for {ms}ms"`.
/// Detection is by downcast ([`is_stall_timeout_error`]); the TS structural
/// `isStallTimeout` marker protocol has no Rust analogue (all producers are
/// in-crate).
#[derive(Debug)]
pub struct StallTimeoutError {
    pub timeout_ms: u64,
}

impl std::fmt::Display for StallTimeoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SSE stream stalled for {}ms", self.timeout_ms)
    }
}

impl std::error::Error for StallTimeoutError {}

/// Whether an error is an SSE stall timeout.
pub fn is_stall_timeout_error(error: &BoxError) -> bool {
    error.downcast_ref::<StallTimeoutError>().is_some()
}

/// Trim + truncate a request instance id to 64 chars; empty ⇒ `None`.
fn normalize_request_instance_id(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_REQUEST_INSTANCE_ID_LENGTH {
        return Some(trimmed.to_string());
    }
    Some(trimmed.chars().take(MAX_REQUEST_INSTANCE_ID_LENGTH).collect())
}

enum ReadOutcome {
    Chunk(Bytes),
    Done,
}

fn map_read_item(item: Option<Result<Bytes, BoxError>>) -> Result<ReadOutcome, BoxError> {
    match item {
        None => Ok(ReadOutcome::Done),
        Some(Ok(bytes)) => Ok(ReadOutcome::Chunk(bytes)),
        Some(Err(error)) => Err(error),
    }
}

/// Read one chunk with a soft/hard stall window. A SINGLE logical read stays
/// pending across both windows (the future is polled by reference — a chunk
/// resolving during the second window is never dropped). A read ERROR during
/// the soft window propagates immediately without opening the hard window.
async fn read_chunk_with_soft_hard_timeout(
    stream: &mut BodyStream,
    soft_timeout_ms: u64,
    hard_timeout_ms: u64,
) -> Result<ReadOutcome, BoxError> {
    let mut read_future = stream.next();
    match tokio::time::timeout(Duration::from_millis(soft_timeout_ms), &mut read_future).await {
        Ok(item) => map_read_item(item),
        Err(_) => {
            if hard_timeout_ms <= soft_timeout_ms {
                return Err(Box::new(StallTimeoutError { timeout_ms: soft_timeout_ms }));
            }
            let remaining = hard_timeout_ms - soft_timeout_ms;
            match tokio::time::timeout(Duration::from_millis(remaining), &mut read_future).await {
                Ok(item) => map_read_item(item),
                Err(_) => Err(Box::new(StallTimeoutError { timeout_ms: remaining })),
            }
        }
    }
}

/// Wrap an SSE-like streaming response so it can fail over to fallback
/// sources on stalls or errors (TS `withStreamingFailover`).
///
/// `get_fallback` receives the 1-based attempt number and total emitted bytes
/// and returns the fallback response (`Ok(None)` / a body-less response ⇒ no
/// fallback, the ORIGINAL error propagates; `Err` ⇒ THAT error propagates).
/// On a successful failover an SSE comment marker
/// `": codex-multi-auth failover {n}[ req:{id}]\n\n"` is injected (byte-exact
/// contract, spec 06 gotcha 14).
///
/// Must be called within a tokio runtime (the pump is a spawned task).
pub fn with_streaming_failover<F, Fut>(
    mut initial_response: StreamResponse,
    get_fallback_response: F,
    options: StreamFailoverOptions,
) -> StreamResponse
where
    F: FnMut(u32, u64) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<Option<StreamResponse>, BoxError>> + Send + 'static,
{
    let max_failovers = options
        .max_failovers
        .unwrap_or(DEFAULT_MAX_FAILOVERS)
        .floor()
        .max(0.0) as i64;
    let default_hard_timeout_ms = options.stall_timeout_ms.unwrap_or(DEFAULT_STALL_TIMEOUT_MS);
    let soft_timeout_ms = options
        .soft_timeout_ms
        .unwrap_or_else(|| default_hard_timeout_ms.min(DEFAULT_SOFT_TIMEOUT_MS))
        .floor()
        .max(1_000.0);
    let hard_timeout_ms = options
        .hard_timeout_ms
        .unwrap_or(default_hard_timeout_ms)
        .floor()
        .max(soft_timeout_ms);
    let request_instance_id = normalize_request_instance_id(options.request_instance_id.as_deref());
    let headers = ensure_content_type(&initial_response.headers);

    if initial_response.body.is_none() || max_failovers <= 0 {
        return initial_response;
    }

    let body = initial_response.body.take().expect("checked above");
    let (tx, rx) = mpsc::channel::<Result<Bytes, BoxError>>(1);
    tokio::spawn(pump(
        body,
        tx,
        get_fallback_response,
        max_failovers as u32,
        soft_timeout_ms as u64,
        hard_timeout_ms as u64,
        request_instance_id,
    ));

    let wrapped: BodyStream = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    })
    .boxed();

    StreamResponse::new(
        initial_response.status,
        initial_response.status_text.clone(),
        headers,
        Some(wrapped),
    )
}

#[allow(clippy::too_many_arguments)]
async fn pump<F, Fut>(
    mut current: BodyStream,
    tx: mpsc::Sender<Result<Bytes, BoxError>>,
    mut get_fallback_response: F,
    max_failovers: u32,
    soft_timeout_ms: u64,
    hard_timeout_ms: u64,
    request_instance_id: Option<String>,
) where
    F: FnMut(u32, u64) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<Option<StreamResponse>, BoxError>> + Send + 'static,
{
    let mut failover_attempt: u32 = 0;
    let mut emitted_bytes: u64 = 0;

    loop {
        let outcome = tokio::select! {
            // Consumer cancelled the wrapped stream: stop pumping; dropping
            // `current` cancels the upstream (TS cancel() → reader.cancel()).
            _ = tx.closed() => return,
            outcome = read_chunk_with_soft_hard_timeout(&mut current, soft_timeout_ms, hard_timeout_ms) => outcome,
        };

        match outcome {
            Ok(ReadOutcome::Done) => {
                // Normal end: dropping tx closes the channel (controller.close()).
                return;
            }
            Ok(ReadOutcome::Chunk(bytes)) => {
                if !bytes.is_empty() {
                    emitted_bytes += bytes.len() as u64;
                    if tx.send(Ok(bytes)).await.is_err() {
                        return;
                    }
                }
            }
            Err(error) => {
                // Stall or read error → attempt failover.
                if failover_attempt >= max_failovers || emitted_bytes > 0 {
                    // Never replay after partial output; propagate the error.
                    let _ = tx.send(Err(error)).await;
                    return;
                }
                failover_attempt += 1;
                match get_fallback_response(failover_attempt, emitted_bytes).await {
                    Err(failover_error) => {
                        // Failover-callback exceptions error the stream with
                        // THAT error.
                        let _ = tx.send(Err(failover_error)).await;
                        return;
                    }
                    Ok(fallback) => {
                        let fallback_body = fallback.and_then(|mut r| r.body.take());
                        let Some(fallback_body) = fallback_body else {
                            // No usable fallback: give up, propagate original.
                            let _ = tx.send(Err(error)).await;
                            return;
                        };
                        // Release the old reader BEFORE the marker (TS order).
                        drop(std::mem::replace(&mut current, fallback_body));
                        let marker_label = match &request_instance_id {
                            Some(id) => format!(
                                ": codex-multi-auth failover {failover_attempt} req:{id}\n\n"
                            ),
                            None => format!(": codex-multi-auth failover {failover_attempt}\n\n"),
                        };
                        if tx.send(Ok(Bytes::from(marker_label))).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_request_instance_id() {
        assert_eq!(normalize_request_instance_id(None), None);
        assert_eq!(normalize_request_instance_id(Some("   ")), None);
        assert_eq!(
            normalize_request_instance_id(Some("  req-1  ")),
            Some("req-1".to_string())
        );
        let long = "x".repeat(100);
        assert_eq!(
            normalize_request_instance_id(Some(&long)),
            Some("x".repeat(MAX_REQUEST_INSTANCE_ID_LENGTH))
        );
    }

    #[test]
    fn stall_timeout_error_message_is_frozen() {
        let error = StallTimeoutError { timeout_ms: 15_000 };
        assert_eq!(error.to_string(), "SSE stream stalled for 15000ms");
        let boxed: BoxError = Box::new(StallTimeoutError { timeout_ms: 1 });
        assert!(is_stall_timeout_error(&boxed));
        let other: BoxError = "some other error".to_string().into();
        assert!(!is_stall_timeout_error(&other));
    }
}
