//! Port of `lib/request/response-compaction.ts` — server-side `/compact`
//! history compaction with a local trim fallback.
//!
//! Behavior source: spec 06 §18 + the TS source (authority).
//!
//! Sibling seam: the TS module calls `request-transformer.trimInputForFastSession`
//! directly. That transformer module is a sibling agent's file, so the trim is
//! injected as [`TrimInputForFastSession`]; the pipeline wires it to
//! `crate::transformer::trim_input_for_fast_session` once that lands. The
//! seam's `Option` return encodes the TS reference-identity contract
//! (spec 06 gotcha 24): `None` = "no trim applied / identical input" — the
//! `unchanged` signal — while `Some(items)` is a genuinely trimmed list.
//!
//! The TS `fetchImpl` injection maps to a `&reqwest::Client`; the
//! AbortSignal pair (caller signal + local timeout controller) maps to an
//! optional `CancellationToken` plus a `tokio::time::sleep` race.

use cma_core::json_io::stringify_compact;
use cma_core::logger::{log_debug, log_warn};
use http::header::HeaderMap;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::fetch_helpers::DeferredFastSessionInputTrim;
use crate::model_map::get_model_capabilities;
use crate::response_handler::BoxError;

/// Injected `transformer::trim_input_for_fast_session` (sibling seam — see
/// module docs). Arguments mirror the TS call:
/// `(input, maxItems, preferLatestUserOnly)`; `None` means "unchanged".
pub type TrimInputForFastSession<'a> =
    &'a (dyn Fn(&[Value], f64, bool) -> Option<Vec<Value>> + Send + Sync);

/// TS `ResponseCompactionResult.mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseCompactionMode {
    Compacted,
    Trimmed,
    Unchanged,
}

impl ResponseCompactionMode {
    /// The TS literal for this mode.
    pub const fn as_str(self) -> &'static str {
        match self {
            ResponseCompactionMode::Compacted => "compacted",
            ResponseCompactionMode::Trimmed => "trimmed",
            ResponseCompactionMode::Unchanged => "unchanged",
        }
    }
}

/// TS `ResponseCompactionResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseCompactionResult {
    pub body: Map<String, Value>,
    pub mode: ResponseCompactionMode,
}

/// TS `ApplyResponseCompactionParams`.
pub struct ApplyResponseCompactionParams<'a> {
    /// The (already transformed) request body object.
    pub body: &'a Map<String, Value>,
    pub request_url: &'a str,
    /// Headers of the original request; copied with `accept`/`content-type`
    /// forced to `application/json` for the compaction POST.
    pub headers: &'a HeaderMap,
    pub trim: DeferredFastSessionInputTrim,
    /// TS `fetchImpl`.
    pub client: &'a reqwest::Client,
    /// TS `signal` — caller-side abort.
    pub cancel: Option<&'a CancellationToken>,
    /// TS `timeoutMs` — floored at 250 ms, default 4_000 ms.
    pub timeout_ms: Option<f64>,
    /// Sibling seam (see module docs).
    pub trim_input: TrimInputForFastSession<'a>,
}

fn is_input_item_array(value: &Value) -> Option<&Vec<Value>> {
    let items = value.as_array()?;
    // TS `isInputItemArray`: every element must be a record. An EMPTY array
    // passes (`[].every(...)` is true) — the caller's length check handles it.
    if items.iter().all(|item| item.is_object()) {
        Some(items)
    } else {
        None
    }
}

/// TS `extractCompactedInput(payload)` — first array-of-records among
/// `payload.output`, `payload.input`, `payload.response.output`,
/// `payload.response.input`.
fn extract_compacted_input(payload: &Value) -> Option<Vec<Value>> {
    if !payload.is_object() {
        return None;
    }
    if let Some(items) = payload.get("output").and_then(is_input_item_array) {
        return Some(items.clone());
    }
    if let Some(items) = payload.get("input").and_then(is_input_item_array) {
        return Some(items.clone());
    }
    let response = payload.get("response")?;
    if !response.is_object() {
        return None;
    }
    if let Some(items) = response.get("output").and_then(is_input_item_array) {
        return Some(items.clone());
    }
    if let Some(items) = response.get("input").and_then(is_input_item_array) {
        return Some(items.clone());
    }
    None
}

/// TS `buildCompactionUrl(requestUrl)`: base path (query stripped) gets
/// `/compact` appended (idempotent), query string preserved after it.
fn build_compaction_url(request_url: &str) -> String {
    let query_index = request_url.find('?');
    let base_url = match query_index {
        None => request_url,
        Some(index) => &request_url[..index],
    };
    if base_url.ends_with("/compact") {
        return request_url.to_string();
    }
    match query_index {
        None => format!("{request_url}/compact"),
        Some(index) => format!("{base_url}/compact{}", &request_url[index..]),
    }
}

/// TS `createFallbackBody(body, trim)`: local trim of `body.input`; `None`
/// when the input is not an array or the trim is an identity (the caller's
/// "unchanged" signal).
fn create_fallback_body(
    body: &Map<String, Value>,
    trim: &DeferredFastSessionInputTrim,
    trim_input: TrimInputForFastSession<'_>,
) -> Option<Map<String, Value>> {
    let input = body.get("input")?.as_array()?;
    let trimmed = trim_input(input, trim.max_items, trim.prefer_latest_user_only)?;
    let mut fallback = body.clone();
    fallback.insert("input".to_string(), Value::Array(trimmed));
    Some(fallback)
}

enum CompactionRequestOutcome {
    HttpFailure { status: u16, status_text: String },
    Payload(Value),
    TransportError(String),
}

async fn run_compaction_request(
    params: &ApplyResponseCompactionParams<'_>,
    compaction_url: &str,
) -> CompactionRequestOutcome {
    let mut compaction_headers = params.headers.clone();
    compaction_headers.insert("accept", http::HeaderValue::from_static("application/json"));
    compaction_headers.insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );

    // TS: JSON.stringify({ model, input }) — `model` is dropped only when
    // absent (JS `undefined`); an explicit null survives.
    let mut request_body = Map::new();
    if let Some(model) = params.body.get("model") {
        request_body.insert("model".to_string(), model.clone());
    }
    if let Some(input) = params.body.get("input") {
        request_body.insert("input".to_string(), input.clone());
    }

    let response = match params
        .client
        .post(compaction_url)
        .headers(compaction_headers)
        .body(stringify_compact(&Value::Object(request_body)))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return CompactionRequestOutcome::TransportError(error.to_string()),
    };

    let status = response.status();
    if !status.is_success() {
        return CompactionRequestOutcome::HttpFailure {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or("").to_string(),
        };
    }

    let text = match response.text().await {
        Ok(text) => text,
        Err(error) => return CompactionRequestOutcome::TransportError(error.to_string()),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(payload) => CompactionRequestOutcome::Payload(payload),
        Err(error) => CompactionRequestOutcome::TransportError(error.to_string()),
    }
}

/// TS `applyResponseCompaction(params)`.
///
/// Errors only on caller abort (the TS rethrow of `params.signal.reason`);
/// every other failure degrades to the local trim fallback.
pub async fn apply_response_compaction(
    params: ApplyResponseCompactionParams<'_>,
) -> Result<ResponseCompactionResult, BoxError> {
    let model_value = params.body.get("model").and_then(Value::as_str);

    let Some(fallback_body) = create_fallback_body(params.body, &params.trim, params.trim_input)
    else {
        return Ok(ResponseCompactionResult {
            body: params.body.clone(),
            mode: ResponseCompactionMode::Unchanged,
        });
    };

    if !get_model_capabilities(model_value).compaction {
        return Ok(ResponseCompactionResult {
            body: fallback_body,
            mode: ResponseCompactionMode::Trimmed,
        });
    }

    // TS `createTimedAbortSignal`: pre-aborted caller signal aborts before the
    // fetch is issued; the catch path then rethrows the caller's reason.
    if params.cancel.is_some_and(|token| token.is_cancelled()) {
        return Err("Aborted".into());
    }

    let timeout_ms = params.timeout_ms.unwrap_or(4_000.0).max(250.0).floor() as u64;
    let compaction_url = build_compaction_url(params.request_url);
    let model_log = params.body.get("model").cloned().unwrap_or(Value::Null);

    let outcome = {
        let request = run_compaction_request(&params, &compaction_url);
        tokio::pin!(request);
        let timeout = tokio::time::sleep(std::time::Duration::from_millis(timeout_ms));
        tokio::pin!(timeout);

        let cancelled = async {
            match params.cancel {
                Some(token) => token.cancelled().await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(cancelled);

        tokio::select! {
            outcome = &mut request => Some(outcome),
            _ = &mut timeout => None,
            _ = &mut cancelled => {
                // Caller abort — TS rethrows `params.signal.reason` (or a
                // plain `Error("Aborted")`; the reason object itself does not
                // survive the Rust boundary).
                return Err("Aborted".into());
            }
        }
    };

    let Some(outcome) = outcome else {
        // Local timeout abort: warn + trim fallback (frozen strings).
        log_warn(
            "Responses compaction failed; using trim fallback.",
            Some(&json!({
                "model": model_log,
                "error": "Response compaction timeout",
            })),
        );
        return Ok(ResponseCompactionResult {
            body: fallback_body,
            mode: ResponseCompactionMode::Trimmed,
        });
    };

    match outcome {
        CompactionRequestOutcome::HttpFailure {
            status,
            status_text,
        } => {
            log_warn(
                "Responses compaction request failed; using trim fallback.",
                Some(&json!({
                    "status": status,
                    "statusText": status_text,
                    "model": model_log,
                })),
            );
            Ok(ResponseCompactionResult {
                body: fallback_body,
                mode: ResponseCompactionMode::Trimmed,
            })
        }
        CompactionRequestOutcome::TransportError(error) => {
            log_warn(
                "Responses compaction failed; using trim fallback.",
                Some(&json!({ "model": model_log, "error": error })),
            );
            Ok(ResponseCompactionResult {
                body: fallback_body,
                mode: ResponseCompactionMode::Trimmed,
            })
        }
        CompactionRequestOutcome::Payload(payload) => {
            let compacted_input = extract_compacted_input(&payload);
            let Some(compacted_input) = compacted_input.filter(|items| !items.is_empty()) else {
                log_warn(
                    "Responses compaction returned no reusable input; using trim fallback.",
                    Some(&json!({ "model": model_log })),
                );
                return Ok(ResponseCompactionResult {
                    body: fallback_body,
                    mode: ResponseCompactionMode::Trimmed,
                });
            };

            let original_input_length = params
                .body
                .get("input")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            log_debug(
                "Applied server-side response compaction.",
                Some(&json!({
                    "model": model_log,
                    "originalInputLength": original_input_length,
                    "compactedInputLength": compacted_input.len(),
                })),
            );

            let mut compacted_body = params.body.clone();
            compacted_body.insert("input".to_string(), Value::Array(compacted_input));
            Ok(ResponseCompactionResult {
                body: compacted_body,
                mode: ResponseCompactionMode::Compacted,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn build_input(length: usize) -> Vec<Value> {
        (0..length)
            .map(|index| {
                json!({
                    "type": "message",
                    "role": if index == 0 { "developer" } else { "user" },
                    "content": if index == 0 {
                        "system prompt".to_string()
                    } else {
                        format!("message-{index}")
                    },
                })
            })
            .collect()
    }

    fn body_with_input(model: &str, length: usize) -> Map<String, Value> {
        let mut body = Map::new();
        body.insert("model".to_string(), Value::String(model.to_string()));
        body.insert("input".to_string(), Value::Array(build_input(length)));
        body
    }

    /// Fake `trimInputForFastSession`: identity (`None`) when the input
    /// already fits, else keep the last `max_items` items.
    fn fake_trim(input: &[Value], max_items: f64, _prefer_latest_user_only: bool) -> Option<Vec<Value>> {
        let max = max_items.floor().max(0.0) as usize;
        if input.len() <= max {
            return None;
        }
        Some(input[input.len() - max..].to_vec())
    }

    fn trim_directive(max_items: f64) -> DeferredFastSessionInputTrim {
        DeferredFastSessionInputTrim {
            max_items,
            prefer_latest_user_only: false,
        }
    }

    #[test]
    fn compaction_url_builder_matches_ts() {
        assert_eq!(
            build_compaction_url("https://chatgpt.com/backend-api/codex/responses"),
            "https://chatgpt.com/backend-api/codex/responses/compact"
        );
        assert_eq!(
            build_compaction_url("https://chatgpt.com/backend-api/codex/responses?stream=true"),
            "https://chatgpt.com/backend-api/codex/responses/compact?stream=true"
        );
        assert_eq!(
            build_compaction_url("https://x.test/responses/compact?x=1"),
            "https://x.test/responses/compact?x=1"
        );
        assert_eq!(
            build_compaction_url("https://x.test/responses/compact"),
            "https://x.test/responses/compact"
        );
    }

    #[tokio::test]
    async fn returns_unchanged_when_the_fast_session_trim_would_be_a_no_op() {
        let body = body_with_input("gpt-5.4", 2);
        let client = reqwest::Client::new();

        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            // Unroutable: any fetch attempt would error rather than pass.
            request_url: "http://127.0.0.1:9/responses",
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap();

        assert_eq!(result.mode, ResponseCompactionMode::Unchanged);
        assert_eq!(result.body.get("input"), body.get("input"));
    }

    #[tokio::test]
    async fn falls_back_to_local_trimming_when_the_model_does_not_support_compaction() {
        // gpt-5-codex resolves to gpt-5.3-codex → `basic` capabilities.
        let body = body_with_input("gpt-5-codex", 10);
        let client = reqwest::Client::new();

        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: "http://127.0.0.1:9/responses",
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap();

        assert_eq!(result.mode, ResponseCompactionMode::Trimmed);
        assert_eq!(result.body.get("input").unwrap().as_array().unwrap().len(), 8);
    }

    #[tokio::test]
    async fn replaces_request_input_with_server_compacted_output_when_available() {
        let compacted_output = vec![json!({
            "type": "message",
            "role": "assistant",
            "content": "compacted summary",
        })];

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/backend-api/codex/responses/compact"))
            .and(header("accept", "application/json"))
            .and(header("content-type", "application/json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "output": compacted_output.clone() })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let body = body_with_input("gpt-5-mini", 12);
        let client = reqwest::Client::new();
        let mut headers = HeaderMap::new();
        headers.insert("accept", "text/event-stream".parse().unwrap());

        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: &format!("{}/backend-api/codex/responses", server.uri()),
            headers: &headers,
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap();

        assert_eq!(result.mode, ResponseCompactionMode::Compacted);
        assert_eq!(
            result.body.get("input").unwrap(),
            &Value::Array(compacted_output)
        );

        // The compaction POST carries {model, input} of the ORIGINAL body.
        let requests = server.received_requests().await.unwrap();
        let request: &Request = &requests[0];
        let sent: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(sent.get("model"), Some(&Value::String("gpt-5-mini".into())));
        assert_eq!(
            sent.get("input").unwrap().as_array().unwrap().len(),
            12
        );
    }

    #[tokio::test]
    async fn inserts_compact_before_query_params_in_the_compaction_request_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/backend-api/codex/responses/compact"))
            .and(query_param("stream", "true"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "output": build_input(8) })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let body = body_with_input("gpt-5-mini", 12);
        let client = reqwest::Client::new();

        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: &format!("{}/backend-api/codex/responses?stream=true", server.uri()),
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap();
        assert_eq!(result.mode, ResponseCompactionMode::Compacted);
    }

    #[tokio::test]
    async fn falls_back_to_local_trimming_when_the_compaction_request_fails() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/backend-api/codex/responses/compact"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(json!({
                    "error": { "message": "nope" }
                })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let body = body_with_input("gpt-5.4", 12);
        let client = reqwest::Client::new();

        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: &format!("{}/backend-api/codex/responses", server.uri()),
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap();

        assert_eq!(result.mode, ResponseCompactionMode::Trimmed);
        assert_eq!(result.body.get("input").unwrap().as_array().unwrap().len(), 8);
    }

    #[tokio::test]
    async fn empty_and_malformed_payloads_use_the_trim_fallback() {
        for payload in [
            json!({}),
            json!({ "output": [] }),
            json!({ "output": ["not-a-record"] }),
            json!({ "response": { "input": [] } }),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(200).set_body_json(payload))
                .mount(&server)
                .await;

            let body = body_with_input("gpt-5.4", 12);
            let client = reqwest::Client::new();
            let result = apply_response_compaction(ApplyResponseCompactionParams {
                body: &body,
                request_url: &format!("{}/backend-api/codex/responses", server.uri()),
                headers: &HeaderMap::new(),
                trim: trim_directive(8.0),
                client: &client,
                cancel: None,
                timeout_ms: None,
                trim_input: &fake_trim,
            })
            .await
            .unwrap();
            assert_eq!(result.mode, ResponseCompactionMode::Trimmed);
        }
    }

    #[tokio::test]
    async fn nested_response_envelopes_are_extracted() {
        let compacted = build_input(3);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "response": { "output": compacted.clone() } })),
            )
            .mount(&server)
            .await;

        let body = body_with_input("gpt-5.4", 12);
        let client = reqwest::Client::new();
        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: &format!("{}/backend-api/codex/responses", server.uri()),
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap();
        assert_eq!(result.mode, ResponseCompactionMode::Compacted);
        assert_eq!(result.body.get("input").unwrap(), &Value::Array(compacted));
    }

    #[tokio::test]
    async fn transport_failures_degrade_to_the_trim_fallback() {
        let body = body_with_input("gpt-5.4", 12);
        let client = reqwest::Client::new();
        // Nothing listens on port 9 (discard) — connection refused.
        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: "http://127.0.0.1:9/responses",
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            timeout_ms: Some(2_000.0),
            trim_input: &fake_trim,
        })
        .await
        .unwrap();
        assert_eq!(result.mode, ResponseCompactionMode::Trimmed);
    }

    #[tokio::test]
    async fn timeouts_degrade_to_the_trim_fallback() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "output": build_input(3) }))
                    .set_delay(std::time::Duration::from_millis(5_000)),
            )
            .mount(&server)
            .await;

        let body = body_with_input("gpt-5.4", 12);
        let client = reqwest::Client::new();
        let started = std::time::Instant::now();
        let result = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: &format!("{}/backend-api/codex/responses", server.uri()),
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: None,
            // Floors at 250 ms (TS `max(250, timeoutMs ?? 4000)`).
            timeout_ms: Some(1.0),
            trim_input: &fake_trim,
        })
        .await
        .unwrap();
        assert_eq!(result.mode, ResponseCompactionMode::Trimmed);
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
    }

    #[tokio::test]
    async fn caller_abort_is_rethrown_instead_of_falling_back() {
        // Pre-aborted caller signal.
        let body = body_with_input("gpt-5.4", 12);
        let client = reqwest::Client::new();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: "http://127.0.0.1:9/responses",
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: Some(&cancel),
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Aborted");

        // Abort while the request is in flight.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "output": build_input(3) }))
                    .set_delay(std::time::Duration::from_millis(5_000)),
            )
            .mount(&server)
            .await;
        let cancel = CancellationToken::new();
        let abort_after = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            abort_after.cancel();
        });
        let error = apply_response_compaction(ApplyResponseCompactionParams {
            body: &body,
            request_url: &format!("{}/backend-api/codex/responses", server.uri()),
            headers: &HeaderMap::new(),
            trim: trim_directive(8.0),
            client: &client,
            cancel: Some(&cancel),
            timeout_ms: None,
            trim_input: &fake_trim,
        })
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Aborted");
    }
}
