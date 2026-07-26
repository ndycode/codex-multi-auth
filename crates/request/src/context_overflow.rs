//! Port of `lib/context-overflow.ts` — context overflow handler
//! (ARCHITECTURE §6.10: 400 prompt-too-long → synthetic 200 SSE).
//!
//! Handles "Prompt too long" / context length exceeded errors by returning a
//! synthetic SSE response that advises the user to use /compact or /clear.
//! This prevents the host session from getting locked on 400 errors.
//!
//! The synthetic stream speaks the OpenAI **Responses API** SSE dialect
//! (`response.*` events) — the dialect the Codex CLI client and this crate's
//! own `convert_sse_to_json` parser speak (recovery-01: the old Anthropic
//! Messages envelope was unparseable, so the notice never reached the user).

use std::sync::atomic::{AtomicU64, Ordering};

use http::HeaderMap;
use http::header::HeaderValue;
use serde_json::Value;

use cma_core::json_io::stringify_compact;
use cma_core::logger::log_debug;
use cma_core::utils::now_ms;

use crate::response_handler::StreamResponse;

/// Error patterns that indicate context overflow (TS
/// `CONTEXT_OVERFLOW_PATTERNS` — frozen, matched case-insensitively).
const CONTEXT_OVERFLOW_PATTERNS: [&str; 7] = [
    "prompt is too long",
    "prompt_too_long",
    "context length exceeded",
    "context_length_exceeded",
    "maximum context length",
    "token limit exceeded",
    "too many tokens",
];

/// Check if an error body indicates context overflow (TS
/// `isContextOverflowError`). Only 400 responses with a non-empty body match.
pub fn is_context_overflow_error(status: u16, body_text: &str) -> bool {
    if status != 400 {
        return false;
    }
    if body_text.is_empty() {
        return false;
    }
    let lower_body = body_text.to_lowercase();
    CONTEXT_OVERFLOW_PATTERNS
        .iter()
        .any(|pattern| lower_body.contains(pattern))
}

/// The message shown to users when context overflow occurs (frozen text — TS
/// `CONTEXT_OVERFLOW_MESSAGE`).
const CONTEXT_OVERFLOW_MESSAGE: &str = "[Plugin Notice] Context is too long for this model.\n\nPlease use one of these commands to reduce context size:\n\n\u{2022} **/compact** - Compress conversation history (recommended)\n\u{2022} **/clear** - Start fresh with empty context\n\u{2022} **/undo** - Remove recent messages\n\nThen retry your request.\n\nAlternatively, you can switch to a model with a larger context window.";

/// Monotonic tie-breaker mixed into the synthetic id suffix (the TS
/// `Math.random().toString(36).slice(2, 8)` analogue — 6 base-36 chars).
static SYNTHETIC_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn random_base36_suffix() -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let counter = SYNTHETIC_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    // Cheap splitmix-style scramble so consecutive calls do not share a prefix.
    let mut x = nanos
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(counter.wrapping_mul(0xBF58_476D_1CE4_E5B9));
    x ^= x >> 31;
    let mut out = String::with_capacity(6);
    for _ in 0..6 {
        out.push(DIGITS[(x % 36) as usize] as char);
        x /= 36;
    }
    out
}

fn push_event(events: &mut String, event_type: &str, payload: &Value) {
    // TS: `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
    // with `type` serialized FIRST. Callers build the payload with `type` as
    // the first key so serde's preserve_order emits identical bytes.
    events.push_str("event: ");
    events.push_str(event_type);
    events.push_str("\ndata: ");
    events.push_str(&stringify_compact(payload));
    events.push_str("\n\n");
}

/// Creates a synthetic SSE response for context overflow errors (TS
/// `createContextOverflowResponse`). Returns 200 OK so the host session does
/// not lock on the 400.
pub fn create_context_overflow_response(model: Option<&str>) -> StreamResponse {
    let model = model.unwrap_or("unknown");
    let now = now_ms();
    let message_id = format!("msg_synthetic_overflow_{now}_{}", random_base36_suffix());
    let response_id = format!("resp_synthetic_overflow_{now}_{}", random_base36_suffix());

    let mut events = String::new();

    // response.created
    push_event(
        &mut events,
        "response.created",
        &serde_json::json!({
            "type": "response.created",
            "response": {
                "id": response_id,
                "object": "response",
                "model": model,
                "status": "in_progress"
            }
        }),
    );

    // output item (assistant message) added
    push_event(
        &mut events,
        "response.output_item.added",
        &serde_json::json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "content": []
            }
        }),
    );

    // streamed text + its terminal "done" carrying the final canonical text
    push_event(
        &mut events,
        "response.output_text.delta",
        &serde_json::json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "content_index": 0,
            "delta": CONTEXT_OVERFLOW_MESSAGE
        }),
    );
    push_event(
        &mut events,
        "response.output_text.done",
        &serde_json::json!({
            "type": "response.output_text.done",
            "output_index": 0,
            "content_index": 0,
            "text": CONTEXT_OVERFLOW_MESSAGE
        }),
    );

    // terminal response.completed with the full output array
    push_event(
        &mut events,
        "response.completed",
        &serde_json::json!({
            "type": "response.completed",
            "response": {
                "id": response_id,
                "object": "response",
                "model": model,
                "status": "completed",
                "output": [
                    {
                        "id": message_id,
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": CONTEXT_OVERFLOW_MESSAGE }]
                    }
                ],
                "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
            }
        }),
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        http::header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        http::HeaderName::from_static("x-codex-plugin-synthetic"),
        HeaderValue::from_static("true"),
    );
    headers.insert(
        http::HeaderName::from_static("x-codex-plugin-error-type"),
        HeaderValue::from_static("context_overflow"),
    );

    // TS `new Response(..., { status: 200 })` leaves statusText empty.
    StreamResponse::from_text(200, "", headers, events)
}

/// Result of [`handle_context_overflow`].
///
/// The TS version clones the `Response` before reading so the caller keeps a
/// readable original on the `handled: false` path. Rust bodies are one-shot
/// streams, so the non-handled variant returns the original response with its
/// body re-buffered from the bytes read during inspection (the "clone before
/// return" contract).
#[derive(Debug)]
pub enum ContextOverflowOutcome {
    /// Overflow detected: `response` is the synthetic 200 SSE notice.
    Handled { response: StreamResponse },
    /// Not an overflow: `response` is the original response (body preserved).
    NotHandled { response: StreamResponse },
}

impl ContextOverflowOutcome {
    /// TS `result.handled`.
    pub fn handled(&self) -> bool {
        matches!(self, ContextOverflowOutcome::Handled { .. })
    }

    /// Unwrap to the response either way (both variants carry one).
    pub fn into_response(self) -> StreamResponse {
        match self {
            ContextOverflowOutcome::Handled { response }
            | ContextOverflowOutcome::NotHandled { response } => response,
        }
    }
}

/// Check a response for context overflow and return a synthetic response if
/// needed (TS `handleContextOverflow`).
///
/// Read errors are swallowed (TS `catch {}`): the outcome degrades to
/// `NotHandled` with whatever bytes were collected before the failure.
pub async fn handle_context_overflow(
    mut response: StreamResponse,
    model: Option<&str>,
) -> ContextOverflowOutcome {
    if response.status != 400 {
        return ContextOverflowOutcome::NotHandled { response };
    }

    let Some(mut body) = response.body.take() else {
        // No body: nothing to match on (TS reads "" and finds no pattern).
        return ContextOverflowOutcome::NotHandled { response };
    };

    // Buffer the body so it can be handed back on the NotHandled path.
    let mut collected: Vec<u8> = Vec::new();
    let mut read_failed = false;
    {
        use futures::StreamExt;
        while let Some(item) = body.next().await {
            match item {
                Ok(chunk) => collected.extend_from_slice(&chunk),
                Err(_) => {
                    // Ignore read errors (TS `catch { /* Ignore */ }`).
                    read_failed = true;
                    break;
                }
            }
        }
    }

    if !read_failed {
        let body_text = String::from_utf8_lossy(&collected);
        if is_context_overflow_error(response.status, &body_text) {
            log_debug("Context overflow detected, returning synthetic response", None);
            return ContextOverflowOutcome::Handled {
                response: create_context_overflow_response(model),
            };
        }
    }

    response.body = Some(crate::response_handler::body_stream_from_bytes(
        bytes::Bytes::from(collected),
    ));
    ContextOverflowOutcome::NotHandled { response }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_message_is_frozen() {
        assert!(CONTEXT_OVERFLOW_MESSAGE.starts_with("[Plugin Notice] Context is too long"));
        assert!(CONTEXT_OVERFLOW_MESSAGE.contains("\u{2022} **/compact** - Compress conversation history (recommended)"));
        assert!(CONTEXT_OVERFLOW_MESSAGE.ends_with("switch to a model with a larger context window."));
    }

    #[test]
    fn random_base36_suffix_shape() {
        let a = random_base36_suffix();
        let b = random_base36_suffix();
        assert_eq!(a.len(), 6);
        assert!(a.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        // Consecutive calls must differ (counter mixing).
        assert_ne!(a, b);
    }

    #[test]
    fn push_event_serializes_type_first() {
        let mut events = String::new();
        push_event(
            &mut events,
            "response.created",
            &serde_json::json!({ "type": "response.created", "response": { "id": "r" } }),
        );
        assert_eq!(
            events,
            "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n"
        );
    }
}
