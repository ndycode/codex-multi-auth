//! Port of `test/response-handler.test.ts` + `test/response-handler-sse-buffer.test.ts`
//! — the regression gate for ARCHITECTURE §11 risk 1 (SSE state machine).
//!
//! Not ported: `test/response-handler-logging.test.ts` (asserts on a mocked
//! logger module; the Rust logger is not injectable — log-only behavior).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use futures::StreamExt;
use http::HeaderMap;
use http::header::{CONTENT_TYPE, HeaderValue};
use serde_json::{Value, json};

use cma_request::response_handler::{
    BodyStream, BoxError, ConvertSseOptions, ResponseIdCallback, StreamResponse,
    attach_response_id_capture, convert_sse_to_json, ensure_content_type, is_empty_response,
};

const MAX_SSE_SIZE_FOR_TEST: usize = 10 * 1024 * 1024; // must match lib constant

fn sse_response(content: &str) -> StreamResponse {
    // TS `new Response(content)` — status 200, empty statusText.
    StreamResponse::from_text(200, "", HeaderMap::new(), content)
}

async fn convert(response: StreamResponse) -> StreamResponse {
    convert_sse_to_json(response, &HeaderMap::new(), ConvertSseOptions::default())
        .await
        .expect("convertSseToJson should succeed")
}

async fn convert_json(response: StreamResponse) -> Value {
    convert(response)
        .await
        .collect_json()
        .await
        .expect("JSON body")
}

fn recording_callback() -> (ResponseIdCallback, Arc<Mutex<Vec<String>>>) {
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = calls.clone();
    let callback: ResponseIdCallback = Arc::new(move |id: &str| {
        sink.lock().unwrap().push(id.to_string());
    });
    (callback, calls)
}

fn counting_stream(chunks: Vec<Bytes>) -> (BodyStream, Arc<AtomicUsize>) {
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    let stream = futures::stream::iter(chunks.into_iter().map(Ok::<_, BoxError>))
        .inspect(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .boxed();
    (stream, count)
}

// ---------------------------------------------------------------------------
// ensureContentType
// ---------------------------------------------------------------------------

#[test]
fn ensure_content_type_preserves_existing_content_type() {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let result = ensure_content_type(&headers);
    assert_eq!(result.get(CONTENT_TYPE).unwrap(), "application/json");
}

#[test]
fn ensure_content_type_adds_default_when_missing() {
    let headers = HeaderMap::new();
    let result = ensure_content_type(&headers);
    assert_eq!(
        result.get(CONTENT_TYPE).unwrap(),
        "text/event-stream; charset=utf-8"
    );
}

#[test]
fn ensure_content_type_does_not_modify_original_headers() {
    let headers = HeaderMap::new();
    let result = ensure_content_type(&headers);
    assert!(!headers.contains_key(CONTENT_TYPE));
    assert!(result.contains_key(CONTENT_TYPE));
}

// ---------------------------------------------------------------------------
// convertSseToJson
// ---------------------------------------------------------------------------

#[tokio::test]
async fn errors_when_response_has_no_body() {
    let response = StreamResponse::new(200, "", HeaderMap::new(), None);
    let error = convert_sse_to_json(response, &HeaderMap::new(), ConvertSseOptions::default())
        .await
        .expect_err("must error");
    assert_eq!(error.to_string(), "[codex-multi-auth] Response has no body");
}

#[tokio::test]
async fn parses_sse_stream_with_response_done_event() {
    let sse_content = "data: {\"type\":\"response.started\"}\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_123\",\"output\":\"test\"}}\n";
    let mut result = convert(sse_response(sse_content)).await;
    assert_eq!(
        result.headers.get(CONTENT_TYPE).unwrap(),
        "application/json; charset=utf-8"
    );
    let body = result.collect_json().await.unwrap();
    assert_eq!(body, json!({ "id": "resp_123", "output": "test" }));
}

#[tokio::test]
async fn parses_sse_stream_with_response_completed_event() {
    let sse_content = "data: {\"type\":\"response.started\"}\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_456\",\"output\":\"done\"}}\n";
    let body = convert_json(sse_response(sse_content)).await;
    assert_eq!(body, json!({ "id": "resp_456", "output": "done" }));
}

#[tokio::test]
async fn synthesizes_output_text_and_reasoning_summaries_from_semantic_events() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_semantic_123","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello ","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"world","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello world","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_123","type":"reasoning"}}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Need more context."}"#,
        r#"data: {"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"text":"Need more context."}"#,
        r#"data: {"type":"response.completed","response":{"id":"resp_semantic_123","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["id"], json!("resp_semantic_123"));
    assert_eq!(body["output_text"], json!("Hello world"));
    assert_eq!(body["reasoning_summary_text"], json!("Need more context."));
    assert_eq!(body["phase"], json!("final_answer"));
    assert_eq!(body["final_answer_text"], json!("Hello world"));
    assert_eq!(body["phase_text"], json!({ "final_answer": "Hello world" }));
    assert_eq!(
        body["output"][0]["content"][0],
        json!({ "type": "output_text", "text": "Hello world" })
    );
    assert_eq!(
        body["output"][1]["summary"][0],
        json!({ "type": "summary_text", "text": "Need more context." })
    );
}

#[tokio::test]
async fn preserves_canonical_terminal_reasoning_summary_text_over_synthesized() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_semantic_canonical","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_456","type":"reasoning"}}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Draft summary"}"#,
        r#"data: {"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"text":"Draft summary"}"#,
        r#"data: {"type":"response.completed","response":{"id":"resp_semantic_canonical","object":"response","reasoning_summary_text":"Canonical summary"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["reasoning_summary_text"], json!("Canonical summary"));
    assert_eq!(body["output"][1]["summary"][0]["text"], json!("Draft summary"));
}

#[tokio::test]
async fn preserves_canonical_terminal_reasoning_summary_parts_over_synthesized() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_semantic_part_canonical","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_789","type":"reasoning"}}"#,
        r#"data: {"type":"response.reasoning_summary_part.added","output_index":1,"summary_index":0,"part":{"text":"Draft summary"}}"#,
        r#"data: {"type":"response.reasoning_summary_part.done","output_index":1,"summary_index":0,"part":{"text":"Draft summary"}}"#,
        r#"data: {"type":"response.completed","response":{"id":"resp_semantic_part_canonical","object":"response","output":[{},{"type":"reasoning","summary":[{"type":"summary_text","text":"Canonical summary part"}]}]}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["reasoning_summary_text"], json!("Canonical summary part"));
    assert_eq!(
        body["output"][1]["summary"][0],
        json!({ "type": "summary_text", "text": "Canonical summary part" })
    );
}

#[tokio::test]
async fn synthesizes_reasoning_summaries_from_part_events() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_summary_part","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_part","type":"reasoning"}}"#,
        r#"data: {"type":"response.reasoning_summary_part.added","output_index":1,"summary_index":0,"part":{"text":"Draft summary"}}"#,
        r#"data: {"type":"response.reasoning_summary_part.done","output_index":1,"summary_index":0,"part":{"text":"Need more context."}}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_summary_part","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["reasoning_summary_text"], json!("Need more context."));
    assert_eq!(
        body["output"][1]["summary"][0],
        json!({ "type": "summary_text", "text": "Need more context." })
    );
}

#[tokio::test]
async fn preserves_canonical_terminal_reasoning_summary_over_summary_deltas() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_semantic_nested","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_nested","type":"reasoning"}}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Draft nested summary"}"#,
        r#"data: {"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"text":"Draft nested summary"}"#,
        r#"data: {"type":"response.completed","response":{"id":"resp_semantic_nested","object":"response","output":[{},{"id":"rs_nested","type":"reasoning","summary":[{"type":"summary_text","text":"Canonical nested summary"}]}]}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(
        body["output"][1]["summary"][0]["text"],
        json!("Canonical nested summary")
    );
    assert_eq!(body["reasoning_summary_text"], json!("Canonical nested summary"));
}

#[tokio::test]
async fn synthesizes_output_text_from_content_part_events() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_content_part","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_part","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello ","phase":"final_answer"}}"#,
        r#"data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello world","phase":"final_answer"}}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_content_part","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(
        body["output"][0]["content"][0],
        json!({ "type": "output_text", "text": "Hello world" })
    );
    assert_eq!(body["output_text"], json!("Hello world"));
    assert_eq!(body["final_answer_text"], json!("Hello world"));
    assert_eq!(body["phase_text"], json!({ "final_answer": "Hello world" }));
}

#[tokio::test]
async fn preserves_whitespace_only_semantic_deltas_when_no_done_events_override() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_whitespace_delta","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_space","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":" ","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"world","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_space","type":"reasoning"}}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Need"}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":" "}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"context."}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_whitespace_delta","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["output"][0]["content"][0]["text"], json!("Hello world"));
    assert_eq!(body["output_text"], json!("Hello world"));
    assert_eq!(body["final_answer_text"], json!("Hello world"));
    assert_eq!(body["output"][1]["summary"][0]["text"], json!("Need context."));
    assert_eq!(body["reasoning_summary_text"], json!("Need context."));
}

#[tokio::test]
async fn preserves_richer_terminal_output_when_semantic_items_have_empty_content() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_rich_123","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","content":[]}}"#,
        r#"data: {"type":"response.completed","response":{"id":"resp_rich_123","object":"response","output":[{"id":"msg_123","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello rich world"},{"type":"annotation","label":"kept"}]}]}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["id"], json!("resp_rich_123"));
    assert_eq!(
        body["output"][0]["content"],
        json!([
            { "type": "output_text", "text": "Hello rich world" },
            { "type": "annotation", "label": "kept" },
        ])
    );
}

#[tokio::test]
async fn preserves_canonical_terminal_content_over_accumulated_deltas() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_canonical_slot","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_canonical","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Draft answer","phase":"final_answer"}"#,
        r#"data: {"type":"response.completed","response":{"id":"resp_canonical_slot","object":"response","output":[{"id":"msg_canonical","type":"message","role":"assistant","content":[{"type":"output_text","text":"Canonical answer"}]}]}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["output"][0]["content"][0]["text"], json!("Canonical answer"));
    assert_eq!(body["output_text"], json!("Canonical answer"));
    assert_eq!(body["final_answer_text"], json!("Canonical answer"));
    assert_eq!(body["phase_text"], json!({ "final_answer": "Canonical answer" }));
}

#[tokio::test]
async fn clears_stale_output_text_deltas_when_done_omits_canonical_text() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_stale_delta","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_stale","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hello ","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":" ","phase":"final_answer"}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_stale_delta","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert!(body["output"][0].get("content").is_none());
    assert!(body.get("output_text").is_none());
    assert!(body.get("final_answer_text").is_none());
    assert!(body.get("phase_text").is_none());
}

#[tokio::test]
async fn clears_stale_reasoning_summary_deltas_when_done_omits_canonical_text() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_stale_reasoning","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":1,"item":{"id":"rs_stale","type":"reasoning"}}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"delta":"Need more context"}"#,
        r#"data: {"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"text":" "}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_stale_reasoning","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert!(body["output"][1].get("summary").is_none());
    assert!(body.get("reasoning_summary_text").is_none());
}

#[tokio::test]
async fn tracks_commentary_and_final_answer_phase_text_separately() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_phase_123","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"commentary"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Thinking...","phase":"commentary"}"#,
        r#"data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Thinking...","phase":"commentary"}"#,
        r#"data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_123","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.output_text.done","output_index":0,"content_index":1,"text":"Done.","phase":"final_answer"}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_phase_123","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["phase"], json!("final_answer"));
    assert_eq!(body["commentary_text"], json!("Thinking..."));
    assert_eq!(body["final_answer_text"], json!("Done."));
    assert_eq!(
        body["phase_text"],
        json!({ "commentary": "Thinking...", "final_answer": "Done." })
    );
    assert_eq!(body["output_text"], json!("Thinking...Done."));
}

#[tokio::test]
async fn replaces_phase_text_when_output_text_done_corrects_earlier_deltas() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_phase_fix","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_fix","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hellp","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello","phase":"final_answer"}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_phase_fix","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["output"][0]["content"][0]["text"], json!("Hello"));
    assert_eq!(body["output_text"], json!("Hello"));
    assert_eq!(body["final_answer_text"], json!("Hello"));
    assert_eq!(body["phase_text"], json!({ "final_answer": "Hello" }));
}

#[tokio::test]
async fn replaces_phase_text_when_output_text_done_omits_phase() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_phase_fix_missing","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_fix_missing","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"Hellp","phase":"final_answer"}"#,
        r#"data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"Hello"}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_phase_fix_missing","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["output"][0]["content"][0]["text"], json!("Hello"));
    assert_eq!(body["output_text"], json!("Hello"));
    assert_eq!(body["final_answer_text"], json!("Hello"));
    assert_eq!(body["phase_text"], json!({ "final_answer": "Hello" }));
}

#[tokio::test]
async fn handles_content_part_added_for_output_text_parts() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_content_part_added","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_part_added","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello from added part","phase":"final_answer"}}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_content_part_added","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(
        body["output"][0]["content"][0],
        json!({ "type": "output_text", "text": "Hello from added part" })
    );
    assert_eq!(body["output_text"], json!("Hello from added part"));
    assert_eq!(body["final_answer_text"], json!("Hello from added part"));
    assert_eq!(body["phase_text"], json!({ "final_answer": "Hello from added part" }));
}

#[tokio::test]
async fn handles_content_part_done_for_output_text_parts() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_content_part_done","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_part_done","type":"message","role":"assistant","phase":"final_answer"}}"#,
        r#"data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello from done part","phase":"final_answer"}}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_content_part_done","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(
        body["output"][0]["content"][0],
        json!({ "type": "output_text", "text": "Hello from done part" })
    );
    assert_eq!(body["output_text"], json!("Hello from done part"));
    assert_eq!(body["final_answer_text"], json!("Hello from done part"));
    assert_eq!(body["phase_text"], json!({ "final_answer": "Hello from done part" }));
}

#[tokio::test]
async fn captures_phase_from_non_output_text_parts_without_mutating_output() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_content_part_annotation","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_part_annotation","type":"message","role":"assistant"}}"#,
        r#"data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"annotation","text":"ignored","phase":"commentary"}}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_content_part_annotation","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;

    assert_eq!(body["phase"], json!("commentary"));
    assert!(body["output"][0].get("content").is_none());
    assert!(body.get("output_text").is_none());
    assert!(body.get("phase_text").is_none());
}

#[tokio::test]
async fn returns_original_text_when_no_final_response_found() {
    let sse_content = "data: {\"type\":\"response.started\"}\ndata: {\"type\":\"chunk\",\"delta\":\"text\"}\n";
    let mut result = convert(sse_response(sse_content)).await;
    let text = result.collect_text().await.unwrap();
    assert_eq!(text, sse_content);
}

#[tokio::test]
async fn skips_malformed_json_in_sse_stream() {
    let sse_content = "data: not-json\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_789\"}}\n";
    let body = convert_json(sse_response(sse_content)).await;
    assert_eq!(body, json!({ "id": "resp_789" }));
}

#[tokio::test]
async fn handles_empty_sse_stream() {
    let mut result = convert(sse_response("")).await;
    let text = result.collect_text().await.unwrap();
    assert_eq!(text, "");
}

#[tokio::test]
async fn preserves_response_status_and_status_text() {
    let sse_content = r#"data: {"type":"response.done","response":{"id":"x"}}"#;
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let result = convert(response).await;
    assert_eq!(result.status, 200);
    assert_eq!(result.status_text, "OK");
}

#[tokio::test]
async fn reports_the_final_response_id_while_converting() {
    let (callback, calls) = recording_callback();
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_123","object":"response"}}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_123","output":"test"}}"#,
        "",
    ]
    .join("\n");
    let mut result = convert_sse_to_json(
        sse_response(&sse_content),
        &HeaderMap::new(),
        ConvertSseOptions { on_response_id: Some(callback), stream_stall_timeout_ms: None },
    )
    .await
    .unwrap();
    let body = result.collect_json().await.unwrap();
    assert_eq!(body, json!({ "id": "resp_123", "output": "test" }));
    assert_eq!(&*calls.lock().unwrap(), &["resp_123".to_string()]);
}

#[tokio::test]
async fn h6_error_event_before_done_yields_non_2xx_and_no_id_capture() {
    let (callback, calls) = recording_callback();
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_bad_123","object":"response"}}"#,
        "",
        r#"data: {"type":"error","message":"quota exceeded"}"#,
        "",
        r#"data: {"type":"response.done","response":{"id":"resp_bad_123","output":"bad"}}"#,
        "",
    ]
    .join("\n");
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let result = convert_sse_to_json(
        response,
        &HeaderMap::new(),
        ConvertSseOptions { on_response_id: Some(callback), stream_stall_timeout_ms: None },
    )
    .await
    .unwrap();
    assert!(!result.ok());
    assert!(result.status >= 400);
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn returns_raw_sse_text_when_stream_ends_without_terminal_event() {
    let (callback, calls) = recording_callback();
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_partial_123","object":"response"}}"#,
        "",
        r#"data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}"#,
        "",
    ]
    .join("\n");
    let mut result = convert_sse_to_json(
        sse_response(&sse_content),
        &HeaderMap::new(),
        ConvertSseOptions { on_response_id: Some(callback), stream_stall_timeout_ms: None },
    )
    .await
    .unwrap();
    let text = result.collect_text().await.unwrap();
    assert_eq!(text, sse_content);
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ignores_oversized_semantic_indices() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_guarded_indices","object":"response"}}"#,
        r#"data: {"type":"response.output_item.added","output_index":1000000,"item":{"id":"msg_big","type":"message","role":"assistant"}}"#,
        r#"data: {"type":"response.output_text.done","output_index":1000000,"content_index":1000000,"text":"ignored"}"#,
        r#"data: {"type":"response.reasoning_summary_part.done","output_index":1000000,"summary_index":1000000,"part":{"text":"ignored"}}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_guarded_indices","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;
    assert_eq!(body, json!({ "id": "resp_guarded_indices", "object": "response" }));
}

#[tokio::test]
async fn ignores_delta_events_with_missing_output_index() {
    let sse_content = [
        r#"data: {"type":"response.created","response":{"id":"resp_no_index","object":"response"}}"#,
        r#"data: {"type":"response.output_text.delta","content_index":0,"delta":"orphan"}"#,
        r#"data: {"type":"response.reasoning_summary_text.delta","summary_index":0,"delta":"orphan"}"#,
        r#"data: {"type":"response.done","response":{"id":"resp_no_index","object":"response"}}"#,
        "",
    ]
    .join("\n");
    let body = convert_json(sse_response(&sse_content)).await;
    assert_eq!(body["id"], json!("resp_no_index"));
    assert!(body.get("output_text").is_none());
    assert!(body.get("reasoning_summary_text").is_none());
}

#[tokio::test]
async fn errors_when_sse_stream_exceeds_size_limit() {
    let large_content = "a".repeat(20 * 1024 * 1024 + 1);
    let error = convert_sse_to_json(
        sse_response(&large_content),
        &HeaderMap::new(),
        ConvertSseOptions::default(),
    )
    .await
    .expect_err("must exceed cap");
    assert_eq!(error.to_string(), "SSE response exceeds 10485760 bytes limit");
}

#[tokio::test]
async fn errors_when_stream_read_fails() {
    let stream: BodyStream = futures::stream::once(async {
        Err::<Bytes, BoxError>("Stream read error".to_string().into())
    })
    .boxed();
    let response = StreamResponse::new(200, "OK", HeaderMap::new(), Some(stream));
    let error = convert_sse_to_json(response, &HeaderMap::new(), ConvertSseOptions::default())
        .await
        .expect_err("must propagate read error");
    assert_eq!(error.to_string(), "Stream read error");
}

#[tokio::test]
async fn errors_when_stream_stalls_past_timeout() {
    let stream: BodyStream = futures::stream::pending().boxed();
    let response = StreamResponse::new(200, "OK", HeaderMap::new(), Some(stream));
    let error = convert_sse_to_json(
        response,
        &HeaderMap::new(),
        ConvertSseOptions { on_response_id: None, stream_stall_timeout_ms: Some(1_000.0) },
    )
    .await
    .expect_err("must stall");
    assert_eq!(
        error.to_string(),
        "SSE stream stalled for 1000ms while waiting for a terminal response event"
    );
}

// ---------------------------------------------------------------------------
// attachResponseIdCapture
// ---------------------------------------------------------------------------

#[tokio::test]
async fn captures_response_ids_while_preserving_the_sse_stream() {
    let (callback, calls) = recording_callback();
    let sse_content = [
        r#"data: {"type":"response.started"}"#,
        "",
        r#"data: {"type":"response.done","response":{"id":"resp_stream_123","output":"done"}}"#,
        "",
    ]
    .join("\n");
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));

    let mut captured =
        attach_response_id_capture(sse_response(&sse_content), headers, Some(callback));
    let text = captured.collect_text().await.unwrap();

    assert_eq!(text, sse_content);
    assert_eq!(&*calls.lock().unwrap(), &["resp_stream_123".to_string()]);
    assert_eq!(captured.headers.get(CONTENT_TYPE).unwrap(), "text/event-stream");
}

#[tokio::test]
async fn stops_capturing_response_ids_after_an_sse_error_event() {
    let (callback, calls) = recording_callback();
    let sse_content = [
        r#"data: {"type":"error","message":"quota exceeded"}"#,
        "",
        r#"data: {"type":"response.done","response":{"id":"resp_bad_123","output":"done"}}"#,
        "",
    ]
    .join("\n");
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));

    let mut captured =
        attach_response_id_capture(sse_response(&sse_content), headers, Some(callback));
    let text = captured.collect_text().await.unwrap();

    assert_eq!(text, sse_content);
    assert!(calls.lock().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// isEmptyResponse
// ---------------------------------------------------------------------------

#[test]
fn is_empty_response_suite() {
    // null / undefined
    assert!(is_empty_response(Some(&Value::Null)));
    assert!(is_empty_response(None));
    // empty / whitespace strings
    assert!(is_empty_response(Some(&json!(""))));
    assert!(is_empty_response(Some(&json!("   "))));
    // empty object
    assert!(is_empty_response(Some(&json!({}))));
    // response object without meaningful content
    assert!(is_empty_response(Some(&json!({ "id": "resp_123" }))));
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "model": "gpt-5.2" }))));
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "object": "response" }))));
    // null output (undefined output ≙ absent key, also empty)
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "output": null }))));
    // empty output array
    assert!(is_empty_response(Some(&json!({
        "id": "resp_123",
        "object": "response",
        "model": "gpt-5.2",
        "output": [],
    }))));
    // output entries all empty
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "output": [{}] }))));
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "output": [{}, null] }))));
    // empty / whitespace string output
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "output": "" }))));
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "output": "   " }))));
    // empty choices array
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "choices": [] }))));
    // real output
    assert!(!is_empty_response(Some(&json!({ "output": [{ "text": "hello" }] }))));
    assert!(!is_empty_response(Some(&json!({ "id": "resp_123", "output": "some output" }))));
    // real choices
    assert!(!is_empty_response(Some(
        &json!({ "choices": [{ "message": { "content": "hi" } }] })
    )));
    // empty choice objects
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "choices": [{}] }))));
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "choices": [null] }))));
    // content
    assert!(!is_empty_response(Some(&json!({ "content": "hello world" }))));
    assert!(!is_empty_response(Some(&json!({ "id": "resp_123", "content": [] }))));
    // empty string content
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "content": "" }))));
    assert!(is_empty_response(Some(&json!({ "id": "resp_123", "content": "   " }))));
    // non-object primitives
    assert!(!is_empty_response(Some(&json!(123))));
    assert!(!is_empty_response(Some(&json!(true))));
    assert!(!is_empty_response(Some(&json!("non-empty string"))));
    // objects that are not response-like
    assert!(!is_empty_response(Some(&json!({ "foo": "bar" }))));
    assert!(!is_empty_response(Some(&json!({ "data": [1, 2, 3] }))));
}

// ---------------------------------------------------------------------------
// SSE failure classification (stress audit H6/H7/M1)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn h6_mid_stream_error_event_yields_non_2xx() {
    let sse_content = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\ndata: {\"type\":\"error\",\"error\":{\"message\":\"upstream blew up\"}}\n";
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let result = convert(response).await;
    // Must NOT be a 200 — otherwise the caller records an account success.
    assert!(!result.ok());
    assert!(result.status >= 400);
}

#[tokio::test]
async fn h7_response_failed_terminal_event_yields_non_2xx() {
    let sse_content = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\ndata: {\"type\":\"response.failed\",\"response\":{\"id\":\"r1\",\"status\":\"failed\"}}\n";
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let result = convert(response).await;
    assert!(!result.ok());
    assert!(result.status >= 400);
}

#[tokio::test]
async fn h7_terminal_error_body_shape_is_byte_exact() {
    let sse_content = "data: {\"type\":\"response.failed\",\"response\":{\"id\":\"r1\"}}\n";
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let mut result = convert(response).await;
    assert_eq!(result.status, 502);
    assert_eq!(result.status_text, "Bad Gateway");
    assert_eq!(
        result.headers.get(CONTENT_TYPE).unwrap(),
        "application/json; charset=utf-8"
    );
    let text = result.collect_text().await.unwrap();
    assert_eq!(
        text,
        r#"{"error":{"message":"Upstream SSE stream terminated with a failure event","type":"upstream_stream_error","code":"sse_terminal_error"}}"#
    );
}

#[tokio::test]
async fn h7_response_incomplete_delivers_partial_response_as_success() {
    // Hitting max_output_tokens / a content filter is a NORMAL early stop.
    let sse_content = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r2\"}}\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"r2\",\"status\":\"incomplete\",\"output\":\"partial\"}}\n";
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let mut result = convert(response).await;
    assert!(result.ok());
    let body = result.collect_json().await.unwrap();
    assert_eq!(body["id"], json!("r2"));
    assert_eq!(body["status"], json!("incomplete"));
}

#[tokio::test]
async fn control_clean_response_completed_stream_is_a_200_success() {
    let sse_content = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"ok1\",\"output\":\"done\"}}\n";
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let mut result = convert(response).await;
    assert!(result.ok());
    let body = result.collect_json().await.unwrap();
    assert_eq!(body, json!({ "id": "ok1", "output": "done" }));
}

#[tokio::test]
async fn m1_parses_data_events_with_no_space_after_the_colon() {
    let sse_content = "data:{\"type\":\"response.completed\",\"response\":{\"id\":\"nospace\",\"output\":\"ok\"}}\n";
    let response = StreamResponse::from_text(200, "OK", HeaderMap::new(), sse_content);
    let mut result = convert(response).await;
    assert!(result.ok());
    let body = result.collect_json().await.unwrap();
    assert_eq!(body, json!({ "id": "nospace", "output": "ok" }));
}

// ---------------------------------------------------------------------------
// REQ-HIGH-03: linear buffering with pre-append cap
// (port of test/response-handler-sse-buffer.test.ts)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn accumulates_many_chunks_under_the_cap_without_throwing() {
    let filler = "x".repeat(9 * 1024 * 1024);
    let sse = format!(
        "data: {{\"type\":\"response.started\"}}\ndata: {{\"type\":\"response.done\",\"response\":{{\"id\":\"resp_big\",\"output\":{}}}}}\n",
        serde_json::to_string(&filler).unwrap()
    );
    let bytes = sse.as_bytes();
    assert!(bytes.len() < MAX_SSE_SIZE_FOR_TEST);

    let chunk_size = 128 * 1024;
    let chunks: Vec<Bytes> = bytes
        .chunks(chunk_size)
        .map(Bytes::copy_from_slice)
        .collect();
    assert!(chunks.len() > 1);
    let expected_chunks = chunks.len();

    let (stream, count) = counting_stream(chunks);
    let response = StreamResponse::new(200, "OK", HeaderMap::new(), Some(stream));
    let body = convert_json(response).await;

    assert_eq!(body["id"], json!("resp_big"));
    assert_eq!(body["output"].as_str().unwrap().len(), filler.len());
    // Every chunk was consumed (the done signal is the stream ending).
    assert_eq!(count.load(Ordering::SeqCst), expected_chunks);
}

#[tokio::test]
async fn throws_on_the_first_chunk_that_would_exceed_the_cap() {
    // Chunk 1 stays under the cap; chunk 2 is small but pushes the total past
    // MAX_SSE_SIZE. The pre-append check must reject before retaining it.
    let near_cap = Bytes::from(vec![0x61u8; MAX_SSE_SIZE_FOR_TEST - 16]); // 'a'
    let overflow = Bytes::from(vec![0x62u8; 64]); // 'b'
    let (stream, count) = counting_stream(vec![near_cap, overflow]);
    let response = StreamResponse::new(200, "OK", HeaderMap::new(), Some(stream));

    let error = convert_sse_to_json(response, &HeaderMap::new(), ConvertSseOptions::default())
        .await
        .expect_err("must exceed cap");
    assert!(error.to_string().contains("exceeds"));
    assert!(error.to_string().contains("bytes limit"));
    // Two reads: first accepted, second rejected pre-append; none after.
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn throws_on_the_very_first_chunk_when_it_alone_exceeds_the_cap() {
    let too_big = Bytes::from(vec![0x63u8; MAX_SSE_SIZE_FOR_TEST + 1]); // 'c'
    let (stream, count) = counting_stream(vec![too_big]);
    let response = StreamResponse::new(200, "OK", HeaderMap::new(), Some(stream));

    let error = convert_sse_to_json(response, &HeaderMap::new(), ConvertSseOptions::default())
        .await
        .expect_err("must exceed cap");
    assert!(error.to_string().contains("exceeds"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn counts_utf8_bytes_rather_than_utf16_code_units_in_the_guard() {
    // 😀 is 2 UTF-16 code units but 4 UTF-8 bytes. The guard must count bytes.
    let repeats = (MAX_SSE_SIZE_FOR_TEST + 16).div_ceil(4);
    let filler = "😀".repeat(repeats);
    let sse = format!(
        "data: {{\"type\":\"response.started\"}}\ndata: {{\"type\":\"response.done\",\"response\":{{\"id\":\"resp_emoji\",\"output\":{}}}}}\n",
        serde_json::to_string(&filler).unwrap()
    );
    let bytes = sse.into_bytes();
    assert!(bytes.len() > MAX_SSE_SIZE_FOR_TEST);

    let (stream, count) = counting_stream(vec![Bytes::from(bytes)]);
    let response = StreamResponse::new(200, "OK", HeaderMap::new(), Some(stream));

    let error = convert_sse_to_json(response, &HeaderMap::new(), ConvertSseOptions::default())
        .await
        .expect_err("must exceed cap");
    assert!(error.to_string().contains("exceeds"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

// ---------------------------------------------------------------------------
// UTF-8 chunk-boundary integrity through the capture stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn attach_capture_handles_multibyte_sequences_split_across_chunks() {
    let sse = "data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_😀\"}}\n";
    let bytes = sse.as_bytes();
    // Split inside the emoji's 4-byte sequence.
    let split = sse.find("😀").unwrap() + 2;
    let chunks = vec![
        Bytes::copy_from_slice(&bytes[..split]),
        Bytes::copy_from_slice(&bytes[split..]),
    ];
    let (stream, _count) = counting_stream(chunks);
    let response = StreamResponse::new(200, "OK", HeaderMap::new(), Some(stream));

    let (callback, calls) = recording_callback();
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    let mut captured = attach_response_id_capture(response, headers, Some(callback));
    let text = captured.collect_text().await.unwrap();

    assert_eq!(text, sse);
    assert_eq!(&*calls.lock().unwrap(), &["resp_😀".to_string()]);
}
