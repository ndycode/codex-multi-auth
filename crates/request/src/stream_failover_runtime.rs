//! Port of `lib/request/stream-failover-runtime.ts` — proxy-side stream
//! forwarding (spec 06 §21; ARCHITECTURE §6.10).
//!
//! Forwards an upstream [`StreamResponse`] onto the local rotation proxy's
//! client connection, scrubbing hop-by-hop headers, `content-encoding` (the
//! HTTP client already decoded the bytes), and every header under the private
//! `x-codex-multi-auth-account-` prefix (account index/label/email/id must
//! never reach the client; prefix matching blocks future additions by
//! default).
//!
//! The Node `ServerResponse` is abstracted as [`ClientStreamWriter`] so the
//! runtime crate can adapt it onto a hyper response channel; the runtime's
//! `RuntimeRotationProxyStatus` counters are reached through
//! [`StreamForwardStatus`] (cma-request must not depend on cma-runtime).

use std::time::Duration;

use futures::StreamExt;
use futures::future::BoxFuture;
use http::HeaderMap;

use crate::response_handler::{BoxError, StreamResponse};

/// TS `HOP_BY_HOP_HEADERS` (RFC 7230 §6.1 connection-specific headers plus
/// `content-length`, which no longer matches the re-chunked body).
pub const HOP_BY_HOP_HEADERS: [&str; 10] = [
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

// Any header under this prefix carries account-identifying rotation metadata
// (index/label/email/id today) and must never reach the client; matching by
// prefix means a future header added under it is blocked by default instead
// of leaking until someone remembers to extend an allowlist.
const PRIVATE_CLIENT_RESPONSE_HEADER_PREFIX: &str = "x-codex-multi-auth-account-";

// The HTTP client returns decoded bytes while preserving the upstream
// encoding header (TS `DECODED_UPSTREAM_RESPONSE_HEADERS`).
const DECODED_UPSTREAM_RESPONSE_HEADERS: [&str; 1] = ["content-encoding"];

/// Whether a (lowercased) header name is in [`HOP_BY_HOP_HEADERS`].
pub fn is_hop_by_hop_header(name: &str) -> bool {
    HOP_BY_HOP_HEADERS.contains(&name)
}

/// Copy upstream headers for the client, dropping hop-by-hop headers, private
/// `x-codex-multi-auth-account-*` rotation metadata, and `content-encoding`
/// (TS `responseHeadersForClient`). Multi-valued headers yield one pair per
/// value; names are lowercase (`http::HeaderName` normalization). Values that
/// are not valid UTF-8 are dropped.
pub fn response_headers_for_client(upstream_headers: &HeaderMap) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in upstream_headers {
        let normalized_key = name.as_str(); // already lowercase
        if is_hop_by_hop_header(normalized_key) {
            continue;
        }
        if normalized_key.starts_with(PRIVATE_CLIENT_RESPONSE_HEADER_PREFIX) {
            continue;
        }
        if DECODED_UPSTREAM_RESPONSE_HEADERS.contains(&normalized_key) {
            continue;
        }
        let Ok(value) = value.to_str() else {
            continue;
        };
        headers.push((normalized_key.to_string(), value.to_string()));
    }
    headers
}

/// Race a future against a timer (TS `withTimeout`). On timeout the returned
/// error carries `message` and is produced BEFORE `on_timeout` runs — the TS
/// ordering contract (onTimeout side effects, e.g. cancelling a stream
/// reader, could otherwise settle the promise cleanly and win the race,
/// turning a stall into silent success). In Rust the select is already
/// decided when the timer fires, so the ordering holds structurally; the
/// timed-out future is dropped (cancelled).
///
/// The timer is clamped to a minimum of 1 ms (TS `Math.max(1, timeoutMs)`).
pub async fn with_timeout<T, F>(
    future: F,
    timeout_ms: f64,
    on_timeout: impl FnOnce(),
    message: &str,
) -> Result<T, BoxError>
where
    F: std::future::Future<Output = T>,
{
    let clamped_ms = if timeout_ms.is_finite() {
        timeout_ms.floor().max(1.0)
    } else {
        1.0
    } as u64;
    match tokio::time::timeout(Duration::from_millis(clamped_ms), future).await {
        Ok(value) => Ok(value),
        Err(_) => {
            let error: BoxError = message.to_string().into();
            on_timeout();
            Err(error)
        }
    }
}

/// Default byte cap for [`read_error_body`] (TS `maxBytes = 1024 * 1024`).
pub const READ_ERROR_BODY_DEFAULT_MAX_BYTES: usize = 1024 * 1024;

/// Bounded error-body read (TS `readErrorBody`): per-chunk idle timeout AND a
/// size cap (the chunk that would overflow the cap is dropped and the loop
/// stops); the stream is cancelled (dropped) on exit. All failures degrade to
/// returning whatever was collected (UTF-8 lossy) or `""` — this helper never
/// errors.
pub async fn read_error_body(
    response: &mut StreamResponse,
    timeout_ms: f64,
    max_bytes: Option<usize>,
) -> String {
    let max_bytes = max_bytes.unwrap_or(READ_ERROR_BODY_DEFAULT_MAX_BYTES);
    let Some(mut body) = response.body.take() else {
        // TS falls back to `response.text()` for bodyless impls, which yields
        // "" for a null body.
        return String::new();
    };

    let idle_ms = if timeout_ms.is_finite() {
        timeout_ms.floor().max(1.0)
    } else {
        1.0
    } as u64;

    let mut chunks: Vec<u8> = Vec::new();
    let mut total: usize = 0;
    loop {
        let read = tokio::time::timeout(Duration::from_millis(idle_ms), body.next()).await;
        match read {
            Err(_) => break, // idle timeout: fall through with what we have
            Ok(None) => break,
            Ok(Some(Err(_))) => break, // stream error: degrade to partial body
            Ok(Some(Ok(chunk))) => {
                total += chunk.len();
                if total > max_bytes {
                    break; // cap: enough for diagnostics, no OOM
                }
                chunks.extend_from_slice(&chunk);
            }
        }
    }
    drop(body); // reader.cancel()
    String::from_utf8_lossy(&chunks).into_owned()
}

/// Minimal view of the runtime proxy status counters this module mutates
/// (TS mutates `RuntimeRotationProxyStatus.streamsStarted` / `.lastError`
/// directly; the concrete struct lives in cma-runtime).
pub trait StreamForwardStatus {
    /// `status.streamsStarted += 1`.
    fn increment_streams_started(&mut self);
    /// `status.lastError = message`.
    fn set_last_error(&mut self, message: String);
}

/// Node `ServerResponse` analogue for the rotation proxy's client connection.
/// The runtime crate implements this over its hyper/axum response plumbing;
/// tests use an in-memory fake.
pub trait ClientStreamWriter: Send {
    /// `res.writeHead(status, headers)`.
    fn write_head(&mut self, status: u16, headers: Vec<(String, String)>);

    /// `res.writableEnded`.
    fn writable_ended(&self) -> bool;

    /// `res.destroyed`.
    fn destroyed(&self) -> bool;

    /// `res.write(chunk)`: `Ok(true)` = accepted and ready for more,
    /// `Ok(false)` = accepted but the client buffer is full (backpressure),
    /// `Err` = the write threw (e.g. write-after-destroy).
    fn write(&mut self, chunk: &[u8]) -> Result<bool, BoxError>;

    /// Resolve once the client can accept more data again — and ALSO on
    /// close/error, so a client that disconnects mid-backpressure cannot park
    /// the forwarder forever (TS `waitForDrain`).
    fn wait_for_drain(&mut self) -> BoxFuture<'_, ()>;

    /// `res.end()`.
    fn end(&mut self);

    /// `res.destroy(error)`.
    fn destroy(&mut self, error: Option<BoxError>);

    /// Resolve when the client connection closes (TS `res.on("close")`); must
    /// NOT resolve for a plain socket error without close. Used to stop
    /// forwarding when the client disconnects mid-stream.
    fn closed(&self) -> BoxFuture<'static, ()>;
}

/// Forward an upstream streaming response to the proxy client (TS
/// `forwardStreamingResponse`). Returns `true` for a clean end (including a
/// client disconnect observed via `closed()`), `false` when the stream failed
/// (stall, upstream read error, or client write error) — in which case
/// `status.lastError` is set, `on_stream_error` has fired, and the client
/// response is destroyed with the error.
pub async fn forward_streaming_response<W, S>(
    mut upstream: StreamResponse,
    res: &mut W,
    status: &mut S,
    on_stream_error: impl FnOnce(),
    stream_stall_timeout_ms: u64,
) -> bool
where
    W: ClientStreamWriter,
    S: StreamForwardStatus,
{
    status.increment_streams_started();
    res.write_head(upstream.status, response_headers_for_client(&upstream.headers));
    let Some(mut body) = upstream.body.take() else {
        res.end();
        return true;
    };

    let mut closed = res.closed();
    let stall_message = format!("upstream stream stalled after {stream_stall_timeout_ms}ms");

    let error: BoxError = loop {
        // TS installs a close handler that cancels the upstream reader so the
        // pending read observes `done`; selecting on `closed()` here has the
        // same observable effect (stop reading, end cleanly).
        let outcome = tokio::select! {
            biased;
            _ = &mut closed => {
                // Client disconnected: cancel upstream (drop) and finish via
                // the clean end-of-stream path.
                drop(body);
                res.end();
                return true;
            }
            read = tokio::time::timeout(
                Duration::from_millis(stream_stall_timeout_ms.max(1)),
                body.next(),
            ) => read,
        };

        match outcome {
            Err(_) => {
                // Stall: the error is created before the reader is cancelled
                // (drop on scope exit) — TS withTimeout ordering.
                break stall_message.clone().into();
            }
            Ok(None) => {
                res.end();
                return true;
            }
            Ok(Some(Err(read_error))) => break read_error,
            Ok(Some(Ok(chunk))) => {
                if chunk.is_empty() {
                    continue;
                }
                // If the response is already finished (clean end by a
                // concurrent close-then-cancel path), stop writing. Do NOT
                // guard on `destroyed()` here: a socket-error-during-
                // backpressure scenario sets destroyed and then lets the next
                // write throw so the catch path records the error and fires
                // on_stream_error correctly.
                if res.writable_ended() {
                    res.end();
                    return true;
                }
                match res.write(&chunk) {
                    Err(write_error) => break write_error,
                    Ok(ready) => {
                        // Respect backpressure: when the client's socket
                        // buffer is full, pause upstream reads until it
                        // drains instead of buffering the whole stream in
                        // memory for a slow consumer.
                        if !ready && !res.destroyed() {
                            res.wait_for_drain().await;
                        }
                    }
                }
            }
        }
    };

    status.set_last_error(error.to_string());
    on_stream_error();
    if !res.destroyed() {
        res.destroy(Some(error));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::header::{HeaderName, HeaderValue};

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

    #[test]
    fn drops_hop_by_hop_private_and_content_encoding_headers() {
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
    fn blocks_any_header_under_the_private_account_prefix() {
        // Regression: the filter used to be an exact-name allowlist, so a
        // future x-codex-multi-auth-account-* header would have leaked.
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
}
