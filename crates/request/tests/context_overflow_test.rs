//! Port of `test/context-overflow.test.ts`.
//!
//! The TS "handles response read errors gracefully" test stubs
//! `response.clone()` to throw; Rust bodies are one-shot streams, so the
//! equivalent scenario is a body stream that errors mid-read — it must
//! degrade to `NotHandled` (read errors are swallowed).

use bytes::Bytes;
use futures::StreamExt;
use http::HeaderMap;
use http::header::HeaderName;
use serde_json::Value;

use cma_request::context_overflow::{
    ContextOverflowOutcome, create_context_overflow_response, handle_context_overflow,
    is_context_overflow_error,
};
use cma_request::response_handler::{
    BodyStream, BoxError, ConvertSseOptions, StreamResponse, convert_sse_to_json,
};

fn body_response(status: u16, body: &str) -> StreamResponse {
    StreamResponse::from_text(status, "", HeaderMap::new(), body)
}

fn header(response: &StreamResponse, name: &str) -> Option<String> {
    response
        .headers
        .get(HeaderName::from_bytes(name.as_bytes()).unwrap())
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string())
}

// ---------------------------------------------------------------------------
// isContextOverflowError
// ---------------------------------------------------------------------------

#[test]
fn returns_false_for_non_400_status() {
    assert!(!is_context_overflow_error(200, "prompt is too long"));
    assert!(!is_context_overflow_error(429, "prompt is too long"));
    assert!(!is_context_overflow_error(500, "prompt is too long"));
}

#[test]
fn returns_false_for_empty_body() {
    assert!(!is_context_overflow_error(400, ""));
}

#[test]
fn detects_prompt_too_long_pattern() {
    assert!(is_context_overflow_error(400, r#"{"error": {"code": "prompt_too_long"}}"#));
}

#[test]
fn detects_prompt_is_too_long_pattern() {
    assert!(is_context_overflow_error(400, "Error: prompt is too long for this model"));
}

#[test]
fn detects_context_length_exceeded_code_pattern() {
    assert!(is_context_overflow_error(400, r#"{"error": {"code": "context_length_exceeded"}}"#));
}

#[test]
fn detects_context_length_exceeded_text_pattern() {
    assert!(is_context_overflow_error(400, "The context length exceeded the maximum"));
}

#[test]
fn detects_maximum_context_length_pattern() {
    assert!(is_context_overflow_error(400, "This request exceeds maximum context length"));
}

#[test]
fn detects_token_limit_exceeded_pattern() {
    assert!(is_context_overflow_error(400, "Token limit exceeded for this model"));
}

#[test]
fn detects_too_many_tokens_pattern() {
    assert!(is_context_overflow_error(400, "Request has too many tokens"));
}

#[test]
fn is_case_insensitive() {
    assert!(is_context_overflow_error(400, "PROMPT IS TOO LONG"));
    assert!(is_context_overflow_error(400, "CONTEXT_LENGTH_EXCEEDED"));
}

#[test]
fn returns_false_for_unrelated_400_errors() {
    assert!(!is_context_overflow_error(400, r#"{"error": {"code": "invalid_api_key"}}"#));
    assert!(!is_context_overflow_error(400, "Bad request: missing model parameter"));
}

// ---------------------------------------------------------------------------
// createContextOverflowResponse
// ---------------------------------------------------------------------------

#[test]
fn returns_a_200_ok_response() {
    let response = create_context_overflow_response(Some("gpt-5.1-codex"));
    assert_eq!(response.status, 200);
}

#[test]
fn has_text_event_stream_content_type() {
    let response = create_context_overflow_response(Some("gpt-5.1-codex"));
    assert_eq!(header(&response, "content-type").as_deref(), Some("text/event-stream"));
}

#[test]
fn has_synthetic_response_marker_headers() {
    let response = create_context_overflow_response(Some("gpt-5.1-codex"));
    assert_eq!(header(&response, "x-codex-plugin-synthetic").as_deref(), Some("true"));
    assert_eq!(
        header(&response, "x-codex-plugin-error-type").as_deref(),
        Some("context_overflow")
    );
}

#[tokio::test]
async fn includes_responses_api_sse_events_with_helpful_message() {
    let mut response = create_context_overflow_response(Some("gpt-5.1-codex"));
    let text = response.collect_text().await.unwrap();

    // Responses-API dialect (recovery-01) — NOT Anthropic Messages events.
    assert!(text.contains("event: response.created"));
    assert!(text.contains("event: response.output_item.added"));
    assert!(text.contains("event: response.output_text.delta"));
    assert!(text.contains("event: response.output_text.done"));
    assert!(text.contains("event: response.completed"));
    // Old Anthropic envelope must be gone.
    assert!(!text.contains("event: message_start"));
    assert!(!text.contains("content_block_delta"));
    assert!(text.contains("/compact"));
    assert!(text.contains("/clear"));
    assert!(text.contains("/undo"));
}

#[tokio::test]
async fn round_trips_through_the_responses_sse_parser_the_client_uses() {
    let response = create_context_overflow_response(Some("gpt-5.1-codex"));
    let mut parsed = convert_sse_to_json(response, &HeaderMap::new(), ConvertSseOptions::default())
        .await
        .unwrap();
    assert!(parsed.ok());
    let body: Value = parsed.collect_json().await.unwrap();
    // The notice is actually recoverable by the client (the whole point of
    // recovery-01): both the flattened output_text and the structured output
    // carry the advisory message.
    assert!(body["output_text"].as_str().unwrap().contains("/compact"));
    assert!(
        body["output"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Context is too long")
    );
}

#[tokio::test]
async fn includes_model_in_response() {
    let mut response = create_context_overflow_response(Some("gpt-5.1-codex"));
    let text = response.collect_text().await.unwrap();
    assert!(text.contains(r#""model":"gpt-5.1-codex""#));
}

#[tokio::test]
async fn uses_unknown_as_default_model() {
    let mut response = create_context_overflow_response(None);
    let text = response.collect_text().await.unwrap();
    assert!(text.contains(r#""model":"unknown""#));
}

// ---------------------------------------------------------------------------
// handleContextOverflow
// ---------------------------------------------------------------------------

#[tokio::test]
async fn returns_not_handled_for_non_400_responses() {
    let response = body_response(200, "OK");
    let result = handle_context_overflow(response, Some("gpt-5.1-codex")).await;
    assert!(!result.handled());
}

#[tokio::test]
async fn returns_not_handled_for_400_without_overflow_pattern() {
    let response = body_response(400, r#"{"error": {"code": "invalid_request"}}"#);
    let result = handle_context_overflow(response, Some("gpt-5.1-codex")).await;
    assert!(!result.handled());
}

#[tokio::test]
async fn not_handled_response_keeps_a_readable_body() {
    // Clone-before-return contract: the caller gets the original body back.
    let original_body = r#"{"error": {"code": "invalid_request"}}"#;
    let response = body_response(400, original_body);
    let result = handle_context_overflow(response, Some("gpt-5.1-codex")).await;
    match result {
        ContextOverflowOutcome::NotHandled { mut response } => {
            assert_eq!(response.status, 400);
            assert_eq!(response.collect_text().await.unwrap(), original_body);
        }
        ContextOverflowOutcome::Handled { .. } => panic!("must not be handled"),
    }
}

#[tokio::test]
async fn returns_handled_with_synthetic_response_for_overflow_error() {
    let response = body_response(400, r#"{"error": {"code": "prompt_too_long"}}"#);
    let result = handle_context_overflow(response, Some("gpt-5.1-codex")).await;
    assert!(result.handled());
    match result {
        ContextOverflowOutcome::Handled { response } => {
            assert_eq!(response.status, 200);
            assert_eq!(header(&response, "x-codex-plugin-synthetic").as_deref(), Some("true"));
        }
        ContextOverflowOutcome::NotHandled { .. } => panic!("must be handled"),
    }
}

#[tokio::test]
async fn handles_response_read_errors_gracefully() {
    let stream: BodyStream = futures::stream::once(async {
        Ok::<_, BoxError>(Bytes::from_static(b"prompt is too long"))
    })
    .chain(futures::stream::once(async {
        Err::<Bytes, BoxError>("Clone failed".to_string().into())
    }))
    .boxed();
    let response = StreamResponse::new(400, "", HeaderMap::new(), Some(stream));
    let result = handle_context_overflow(response, Some("gpt-5.1-codex")).await;
    assert!(!result.handled());
}
