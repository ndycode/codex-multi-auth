//! Port of `lib/request/fetch-helpers.ts` — orchestration helpers for the
//! custom fetch implementation.
//!
//! Behavior source: spec 06 §6 + the TS source (authority).
//!
//! Like the TS module, this file re-exports the public surfaces of
//! `error_classification`, `url_rewriting`, `headers`, and `token_refresh`
//! so importers can keep using one canonical entry point.
//!
//! Shared HTTP client (ARCHITECTURE §5.1): ONE `reqwest::Client` per process,
//! built here ([`shared_client`]). The 60 s fetch timeout is enforced
//! per-request by callers via `tokio::time::timeout` (driven by
//! `cma_config::getters::get_fetch_timeout_ms`), mirroring the TS
//! AbortController pattern — NEVER as a client-wide timeout (that would also
//! kill healthy long-lived SSE streams).
//!
//! Sibling seam: the TS `transformRequestForCodex` calls
//! `request-transformer.transformRequestBody` and
//! `prompts/codex.getCodexInstructions` directly. Those live in sibling
//! agents' files (`transformer.rs`, `prompts/codex.rs`), so they are injected
//! through [`TransformRequestForCodexDeps`]; the pipeline wires the real
//! functions once they land. Everything already implemented (`model_map`,
//! `response_handler`, `error_classification`, `headers`, `url_rewriting`) is
//! called directly.

use std::sync::OnceLock;

use cma_core::constants::{ERROR_MESSAGES, HTTP_STATUS, LOG_STAGES, MAX_RATE_LIMIT_DELAY_MS};
use cma_core::json_io::stringify_compact;
use cma_core::logger::{log_error, log_request, log_warn};
use cma_core::types::UserConfig;
use cma_core::utils::{now_ms, to_string_value};
use futures::future::BoxFuture;
use http::header::{HeaderMap, HeaderValue};
use regex::Regex;
use serde_json::{Map, Value};

use crate::error_classification::{
    CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE, is_unsupported_codex_model_for_chatgpt,
};
use crate::headers::log_deprecation_headers;
use crate::model_map::{get_model_family, resolve_normalized_model};
use crate::request_init::{BodyInit, RequestInit};
use crate::response_handler::{
    BoxError, ConvertSseOptions, StreamResponse, attach_response_id_capture, convert_sse_to_json,
    ensure_content_type,
};
use crate::response_metadata::js_date_parse_ms;

// ---------------------------------------------------------------------------
// Re-export surface (TS `export ... from` block in fetch-helpers.ts)
// ---------------------------------------------------------------------------

pub use crate::error_classification::{
    DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN, ResolveUnsupportedCodexFallbackOptions,
    UnsupportedCodexModelInfo, create_entitlement_error_response,
    extract_unsupported_codex_model_from_text, get_unsupported_codex_model_info,
    is_entitlement_error, is_workspace_disabled_error, resolve_unsupported_codex_fallback_model,
    should_fallback_to_gpt52_on_unsupported_gpt53,
};
pub use crate::headers::{
    ArgError, CreateCodexHeadersOptions, CreateCodexHeadersParams, create_codex_headers,
    create_codex_headers_positional,
};
pub use crate::token_refresh::{
    Auth, AuthPersistPayload, AuthSetterFn, refresh_and_update_token,
    refresh_and_update_token_with, should_refresh_token, should_refresh_token_at,
};
pub use crate::url_rewriting::{
    close_shared_proxy_dispatchers, extract_request_url, resolve_client_for_request,
    resolve_proxy_url_for_request, rewrite_url_for_codex,
};

// ---------------------------------------------------------------------------
// Shared response/client primitives
// ---------------------------------------------------------------------------

/// A fully-buffered synthetic `Response` (the web `new Response(text, ...)`
/// analogue used by the error-normalization paths, where bodies are always
/// small JSON strings).
#[derive(Debug, Clone)]
pub struct SyntheticResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HeaderMap,
    pub body: String,
}

impl SyntheticResponse {
    /// Parse the buffered body as JSON (test/consumer convenience — the TS
    /// `await response.json()`).
    pub fn json(&self) -> Option<Value> {
        serde_json::from_str(&self.body).ok()
    }

    /// Convert into a streaming response (single-chunk body).
    pub fn into_stream_response(self) -> StreamResponse {
        StreamResponse::from_text(self.status, self.status_text, self.headers, self.body)
    }
}

/// The ONE process-wide direct `reqwest::Client` (ARCHITECTURE §5.1).
///
/// Deliberately built WITHOUT a client-wide timeout: per-request deadlines are
/// the caller's `tokio::time::timeout` (60 s default via config), and the
/// 45 s stream-stall timeout applies between chunks in `response_handler`.
pub fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .expect("failed to build the shared HTTP client")
    })
}

// ---------------------------------------------------------------------------
// Types (TS interfaces)
// ---------------------------------------------------------------------------

/// TS `RateLimitInfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimitInfo {
    pub retry_after_ms: i64,
    /// The parsed `error.code`/`error.type` string; `Some("")` when the body
    /// parsed but carried no code (TS keeps the empty string).
    pub code: Option<String>,
}

/// TS `FastSessionInputTrimPlan["trim"]` — the deferred-trim directive handed
/// from the transform step to `response_compaction`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeferredFastSessionInputTrim {
    pub max_items: f64,
    pub prefer_latest_user_only: bool,
}

/// TS `"hybrid" | "always"` fast-session strategy union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FastSessionStrategy {
    #[default]
    Hybrid,
    Always,
}

impl FastSessionStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            FastSessionStrategy::Hybrid => "hybrid",
            FastSessionStrategy::Always => "always",
        }
    }
}

/// TS `TransformRequestForCodexResult`.
#[derive(Debug, Clone)]
pub struct TransformRequestForCodexResult {
    pub body: Map<String, Value>,
    pub updated_init: RequestInit,
    pub deferred_fast_session_input_trim: Option<DeferredFastSessionInputTrim>,
}

/// The TS optional `options` bag of `transformRequestForCodex`.
#[derive(Debug, Clone, Copy)]
pub struct TransformRequestForCodexOptions {
    pub fast_session: bool,
    pub fast_session_strategy: FastSessionStrategy,
    pub fast_session_max_input_items: f64,
    pub defer_fast_session_input_trimming: bool,
    pub allow_background_responses: bool,
}

impl Default for TransformRequestForCodexOptions {
    fn default() -> Self {
        TransformRequestForCodexOptions {
            fast_session: false,
            fast_session_strategy: FastSessionStrategy::Hybrid,
            fast_session_max_input_items: 30.0,
            defer_fast_session_input_trimming: false,
            allow_background_responses: false,
        }
    }
}

/// Arguments forwarded to the injected `transformRequestBody` (the TS
/// positional call in `transformRequestForCodex`).
#[derive(Debug, Clone)]
pub struct TransformRequestBodyArgs {
    pub body: Map<String, Value>,
    pub codex_instructions: String,
    pub user_config: UserConfig,
    pub codex_mode: bool,
    pub fast_session: bool,
    pub fast_session_strategy: FastSessionStrategy,
    pub fast_session_max_input_items: f64,
    pub defer_fast_session_input_trimming: bool,
    pub allow_background_responses: bool,
}

/// `transformer::resolve_fast_session_input_trim_plan(...).trim` seam:
/// `(body, fastSession, strategy, maxItems)` → the deferred-trim directive
/// (`None` when the plan does not apply).
pub type ResolveFastSessionInputTrimFn<'a> = &'a (dyn Fn(
    &Map<String, Value>,
    bool,
    FastSessionStrategy,
    f64,
) -> Option<DeferredFastSessionInputTrim>
              + Send
              + Sync);

/// `prompts::codex::get_codex_instructions(normalizedModel)` seam.
pub type GetCodexInstructionsFn<'a> =
    &'a (dyn Fn(&str) -> BoxFuture<'static, Result<String, BoxError>> + Send + Sync);

/// `transformer::transform_request_body(...)` seam. Errors whose message
/// starts with `"Responses background mode"` MUST surface as errors — they
/// are rethrown; everything else degrades to `None`.
pub type TransformRequestBodyFn<'a> = &'a (dyn Fn(
    TransformRequestBodyArgs,
)
    -> BoxFuture<'static, Result<Map<String, Value>, BoxError>>
              + Send
              + Sync);

/// Sibling seam for `transformRequestForCodex` (see module docs). The
/// pipeline wires the three closures to the real `transformer`/`prompts`
/// functions once those sibling modules land.
pub struct TransformRequestForCodexDeps<'a> {
    pub resolve_fast_session_input_trim: ResolveFastSessionInputTrimFn<'a>,
    pub get_codex_instructions: GetCodexInstructionsFn<'a>,
    pub transform_request_body: TransformRequestBodyFn<'a>,
}

/// TS `ErrorHandlingResult`. `error_body` is the NORMALIZED payload (spec 06
/// gotcha 27), not the raw upstream JSON.
#[derive(Debug, Clone)]
pub struct ErrorHandlingResult {
    pub response: SyntheticResponse,
    pub rate_limit: Option<RateLimitInfo>,
    pub error_body: Option<Value>,
}

/// TS `ErrorHandlingOptions`.
#[derive(Debug, Clone, Default)]
pub struct ErrorHandlingOptions {
    pub request_correlation_id: Option<String>,
    pub thread_id: Option<String>,
}

// ---------------------------------------------------------------------------
// transformRequestForCodex
// ---------------------------------------------------------------------------

/// JS truthiness for logging fields (`!!value`).
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// TS `body.input?.length` — array length, or UTF-16 length for string input.
fn js_input_length(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Array(items)) => Some(items.len() as u64),
        Some(Value::String(s)) => Some(s.encode_utf16().count() as u64),
        _ => None,
    }
}

fn transform_log_common(map: &mut Map<String, Value>, body: &Map<String, Value>) {
    map.insert(
        "hasTools".to_string(),
        Value::Bool(js_truthy(body.get("tools"))),
    );
    map.insert(
        "hasInput".to_string(),
        Value::Bool(js_truthy(body.get("input"))),
    );
    if let Some(length) = js_input_length(body.get("input")) {
        map.insert("inputLength".to_string(), Value::from(length));
    }
}

/// TS `transformRequestForCodex(init, url, userConfig, codexMode, parsedBody,
/// options)`.
///
/// Returns:
/// - `Ok(None)` for the TS `undefined` outcomes (no body, non-string body,
///   parse failure — logged as `"Error parsing request"`);
/// - `Err(_)` ONLY for rethrown background-mode violations (message starts
///   with `"Responses background mode"`).
pub async fn transform_request_for_codex(
    init: Option<&RequestInit>,
    url: &str,
    user_config: &UserConfig,
    codex_mode: bool,
    parsed_body: Option<&Map<String, Value>>,
    options: TransformRequestForCodexOptions,
    deps: &TransformRequestForCodexDeps<'_>,
) -> Result<Option<TransformRequestForCodexResult>, BoxError> {
    let has_parsed_body = parsed_body.map(|map| !map.is_empty()).unwrap_or(false);
    // TS truthiness on init.body: an empty string is falsy; byte bodies (the
    // Blob/Uint8Array arms) are truthy but fail the string check below.
    let init_body = init.and_then(|i| i.body.as_ref()).filter(|body| match body {
        BodyInit::Text(text) => !text.is_empty(),
        BodyInit::Bytes(_) => true,
    });
    if init_body.is_none() && !has_parsed_body {
        return Ok(None);
    }

    let body: Map<String, Value> = if has_parsed_body {
        parsed_body.expect("has_parsed_body").clone()
    } else {
        match init_body {
            Some(BodyInit::Text(text)) => match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(map)) => map,
                // Non-object JSON dies inside the TS transform with a caught
                // TypeError; parse failures die at JSON.parse. Both land in
                // the same logError + undefined outcome.
                Ok(_) | Err(_) => {
                    log_error(ERROR_MESSAGES.request_parse_error, None);
                    return Ok(None);
                }
            },
            _ => return Ok(None),
        }
    };

    let original_model = body.get("model").and_then(Value::as_str).map(str::to_string);
    let trim_directive = (deps.resolve_fast_session_input_trim)(
        &body,
        options.fast_session,
        options.fast_session_strategy,
        options.fast_session_max_input_items,
    );

    // Normalize first so the correct model-specific prompt is fetched.
    let normalized_model = resolve_normalized_model(original_model.as_deref());
    let model_family = get_model_family(normalized_model);

    // Log original request.
    let mut before = Map::new();
    before.insert("url".to_string(), Value::String(url.to_string()));
    before.insert(
        "originalModel".to_string(),
        original_model
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    before.insert(
        "model".to_string(),
        body.get("model").cloned().unwrap_or(Value::Null),
    );
    transform_log_common(&mut before, &body);
    before.insert("codexMode".to_string(), Value::Bool(codex_mode));
    before.insert("body".to_string(), Value::Object(body.clone()));
    log_request(LOG_STAGES.before_transform, &before);

    // Fetch model-specific Codex instructions (cached per model family).
    let codex_instructions = match (deps.get_codex_instructions)(normalized_model).await {
        Ok(instructions) => instructions,
        Err(error) => {
            log_error(
                ERROR_MESSAGES.request_parse_error,
                Some(&Value::String(error.to_string())),
            );
            return Ok(None);
        }
    };

    // Transform request body.
    let transformed_body = match (deps.transform_request_body)(TransformRequestBodyArgs {
        body,
        codex_instructions,
        user_config: user_config.clone(),
        codex_mode,
        fast_session: options.fast_session,
        fast_session_strategy: options.fast_session_strategy,
        fast_session_max_input_items: options.fast_session_max_input_items,
        defer_fast_session_input_trimming: options.defer_fast_session_input_trimming,
        allow_background_responses: options.allow_background_responses,
    })
    .await
    {
        Ok(transformed) => transformed,
        Err(error) => {
            // Background-mode violations are RETHROWN (TS
            // `e.message.startsWith("Responses background mode")`).
            if error.to_string().starts_with("Responses background mode") {
                return Err(error);
            }
            log_error(
                ERROR_MESSAGES.request_parse_error,
                Some(&Value::String(error.to_string())),
            );
            return Ok(None);
        }
    };

    // Log transformed request. (TS logs `transformedBody.model` under the
    // `normalizedModel` key — the transformer never rewrites `body.model`.)
    let mut after = Map::new();
    after.insert("url".to_string(), Value::String(url.to_string()));
    after.insert(
        "originalModel".to_string(),
        original_model.map(Value::String).unwrap_or(Value::Null),
    );
    after.insert(
        "normalizedModel".to_string(),
        transformed_body.get("model").cloned().unwrap_or(Value::Null),
    );
    after.insert(
        "modelFamily".to_string(),
        Value::String(model_family.as_str().to_string()),
    );
    transform_log_common(&mut after, &transformed_body);
    if let Some(reasoning) = transformed_body.get("reasoning") {
        after.insert("reasoning".to_string(), reasoning.clone());
    }
    if let Some(verbosity) = transformed_body
        .get("text")
        .and_then(|text| text.get("verbosity"))
    {
        after.insert("textVerbosity".to_string(), verbosity.clone());
    }
    if let Some(include) = transformed_body.get("include") {
        after.insert("include".to_string(), include.clone());
    }
    after.insert("body".to_string(), Value::Object(transformed_body.clone()));
    log_request(LOG_STAGES.after_transform, &after);

    let mut updated_init = init.cloned().unwrap_or_default();
    updated_init.body = Some(BodyInit::Text(stringify_compact(&Value::Object(
        transformed_body.clone(),
    ))));

    let background = transformed_body.get("background") == Some(&Value::Bool(true));
    Ok(Some(TransformRequestForCodexResult {
        body: transformed_body,
        updated_init,
        deferred_fast_session_input_trim: if options.defer_fast_session_input_trimming
            && !background
        {
            trim_directive
        } else {
            None
        },
    }))
}

// ---------------------------------------------------------------------------
// handleErrorResponse
// ---------------------------------------------------------------------------

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<std::borrow::Cow<'a, str>> {
    headers
        .get(name)
        .map(|value| String::from_utf8_lossy(value.as_bytes()))
}

/// JS `Number.parseInt(value, 10)`: leading whitespace + optional sign +
/// leading digit run; anything else → NaN (`None`).
fn js_parse_int(value: &str) -> Option<f64> {
    let trimmed = value.trim_start();
    let (sign, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1.0, &trimmed[1..]),
        Some(b'+') => (1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    let digits: &str = {
        let end = rest
            .as_bytes()
            .iter()
            .position(|byte| !byte.is_ascii_digit())
            .unwrap_or(rest.len());
        &rest[..end]
    };
    if digits.is_empty() {
        return None;
    }
    digits.parse::<f64>().ok().map(|parsed| sign * parsed)
}

/// TS `toNumber(value)`: `null`/absent → `None`; `Number(value)` with the
/// non-finite results filtered.
fn js_to_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => None,
        Value::Number(number) => number.as_f64().filter(|f| f.is_finite()),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            trimmed.parse::<f64>().ok().filter(|f| f.is_finite())
        }
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// TS `clampRateLimitDelayMs`: non-finite → None; floor; ≤ 0 → None;
/// `min(value, MAX_RATE_LIMIT_DELAY_MS)` (7-day clamp).
fn clamp_rate_limit_delay_ms(value: f64) -> Option<i64> {
    if !value.is_finite() {
        return None;
    }
    let normalized = value.floor();
    if normalized <= 0.0 {
        return None;
    }
    Some((normalized as i64).min(MAX_RATE_LIMIT_DELAY_MS))
}

fn normalize_retry_after_ms(value: f64) -> Option<i64> {
    clamp_rate_limit_delay_ms(value)
}

fn normalize_retry_after_seconds(value: f64) -> Option<i64> {
    clamp_rate_limit_delay_ms(value * 1000.0)
}

/// TS `parseResetTimestampMs`: all-digits → epoch seconds when
/// `< 10_000_000_000`, else epoch ms; otherwise `Date.parse`.
fn parse_reset_timestamp_ms(raw_value: &str) -> Option<f64> {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return None;
    }

    if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(parsed) = trimmed.parse::<f64>()
            && parsed.is_finite() && parsed > 0.0 {
                return Some(if parsed < 10_000_000_000.0 {
                    parsed * 1000.0
                } else {
                    parsed
                });
            }

    js_date_parse_ms(trimmed).map(|ms| ms as f64)
}

/// Parsed `parseRateLimitBody` output.
#[derive(Debug, Clone, PartialEq)]
struct ParsedRateLimitBody {
    code: String,
    resets_at: Option<f64>,
    retry_after_ms: Option<f64>,
    retry_after_seconds: Option<f64>,
}

/// TS `parseRateLimitBody(body)`.
fn parse_rate_limit_body(body: &str) -> Option<ParsedRateLimitBody> {
    if body.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(body).ok()?;
    let empty = Map::new();
    let error = parsed.get("error").and_then(Value::as_object).unwrap_or(&empty);

    // `(error.code ?? error.type ?? "").toString()` — null coalesces onward.
    let code = error
        .get("code")
        .filter(|value| !value.is_null())
        .or_else(|| error.get("type").filter(|value| !value.is_null()))
        .map(to_string_value)
        .unwrap_or_default();
    let resets_at = js_to_number(
        error
            .get("resets_at")
            .filter(|value| !value.is_null())
            .or_else(|| error.get("reset_at").filter(|value| !value.is_null())),
    );
    let retry_after_ms = js_to_number(error.get("retry_after_ms"));
    let retry_after_seconds = js_to_number(error.get("retry_after"));
    Some(ParsedRateLimitBody {
        code,
        resets_at,
        retry_after_ms,
        retry_after_seconds,
    })
}

fn retry_after_duration_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:try|retry)\s+again\s+in\s+(\d+)\s*(second|minute|hour|day)s?\b")
            .unwrap()
    })
}

fn retry_after_clock_time_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:try|retry)\s+again\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b")
            .unwrap()
    })
}

/// TS `parseRetryAfterTextMs(bodyText, now)` — natural-language retry hints.
pub(crate) fn parse_retry_after_text_ms_at(body_text: &str, now_ms: i64) -> Option<i64> {
    if body_text.is_empty() {
        return None;
    }

    if let Some(captures) = retry_after_duration_pattern().captures(body_text) {
        let amount = captures
            .get(1)
            .and_then(|amount| js_parse_int(amount.as_str()));
        let unit = captures
            .get(2)
            .map(|unit| unit.as_str().to_lowercase())
            .unwrap_or_default();
        if let Some(amount) = amount.filter(|amount| *amount > 0.0) {
            let multiplier: f64 = match unit.as_str() {
                "second" => 1000.0,
                "minute" => 60_000.0,
                "hour" => 3_600_000.0,
                "day" => 86_400_000.0,
                _ => 0.0,
            };
            if multiplier > 0.0 {
                return clamp_rate_limit_delay_ms(amount * multiplier);
            }
        }
    }

    let captures = retry_after_clock_time_pattern().captures(body_text)?;
    let hour12 = captures.get(1).and_then(|h| js_parse_int(h.as_str()))?;
    let minute = captures
        .get(2)
        .map(|m| js_parse_int(m.as_str()))
        .unwrap_or(Some(0.0))?;
    let meridiem = captures
        .get(3)
        .map(|m| m.as_str().to_lowercase())
        .unwrap_or_default();
    if !(1.0..=12.0).contains(&hour12)
        || !(0.0..=59.0).contains(&minute)
        || (meridiem != "am" && meridiem != "pm")
    {
        return None;
    }

    // Next LOCAL occurrence of that clock time (TS `target.setHours(...)`).
    use chrono::TimeZone;
    let mut hour24 = (hour12 as u32) % 12;
    if meridiem == "pm" {
        hour24 += 12;
    }
    let now_local = chrono::Local.timestamp_millis_opt(now_ms).single()?;
    let today = now_local.date_naive();
    let resolve = |date: chrono::NaiveDate| -> Option<i64> {
        let naive = date.and_hms_opt(hour24, minute as u32, 0)?;
        let local = chrono::Local
            .from_local_datetime(&naive)
            .earliest()?;
        Some(local.timestamp_millis())
    };
    let mut target_ms = resolve(today)?;
    if target_ms <= now_ms {
        target_ms = resolve(today.succ_opt()?)?;
    }
    clamp_rate_limit_delay_ms((target_ms - now_ms) as f64)
}

/// TS `parseRetryAfterMs(response, bodyText, parsedBody)` — full precedence
/// order (spec 06 §6), everything clamped to the 7-day cap.
fn parse_retry_after_ms_at(
    headers: &HeaderMap,
    body_text: &str,
    parsed_body: Option<&ParsedRateLimitBody>,
    now_ms: i64,
) -> Option<i64> {
    if let Some(retry_after_ms) = parsed_body.and_then(|parsed| parsed.retry_after_ms)
        && let Some(normalized) = normalize_retry_after_ms(retry_after_ms) {
            return Some(normalized);
        }
    if let Some(retry_after_seconds) = parsed_body.and_then(|parsed| parsed.retry_after_seconds)
        && let Some(normalized) = normalize_retry_after_seconds(retry_after_seconds) {
            return Some(normalized);
        }

    if let Some(header) = header_str(headers, "retry-after-ms").filter(|value| !value.is_empty())
        && let Some(parsed) = js_parse_int(&header)
            && let Some(normalized) = normalize_retry_after_ms(parsed) {
                return Some(normalized);
            }

    if let Some(header) = header_str(headers, "retry-after").filter(|value| !value.is_empty()) {
        if let Some(parsed) = js_parse_int(&header)
            && let Some(normalized) = normalize_retry_after_seconds(parsed) {
                return Some(normalized);
            }
        if let Some(parsed_date_ms) = js_date_parse_ms(header.trim())
            && let Some(normalized) = normalize_retry_after_ms((parsed_date_ms - now_ms) as f64) {
                return Some(normalized);
            }
    }

    let mut reset_candidates: Vec<i64> = Vec::new();
    for header in [
        "x-codex-primary-reset-after-seconds",
        "x-codex-secondary-reset-after-seconds",
    ] {
        let Some(value) = header_str(headers, header).filter(|value| !value.is_empty()) else {
            continue;
        };
        if let Some(parsed) = js_parse_int(&value)
            && let Some(normalized) = normalize_retry_after_seconds(parsed) {
                reset_candidates.push(normalized);
            }
    }

    for header in [
        "x-codex-primary-reset-at",
        "x-codex-secondary-reset-at",
        "x-ratelimit-reset",
    ] {
        let Some(value) = header_str(headers, header).filter(|value| !value.is_empty()) else {
            continue;
        };
        let Some(timestamp) = parse_reset_timestamp_ms(&value) else {
            continue;
        };
        if let Some(delta) = normalize_retry_after_ms(timestamp - now_ms as f64) {
            reset_candidates.push(delta);
        }
    }

    // `if (parsedBody?.resetsAt)` — TS truthiness: 0 is falsy.
    if let Some(resets_at) = parsed_body
        .and_then(|parsed| parsed.resets_at)
        .filter(|value| *value != 0.0)
    {
        let timestamp = if resets_at < 10_000_000_000.0 {
            resets_at * 1000.0
        } else {
            resets_at
        };
        if let Some(delta) = normalize_retry_after_ms(timestamp - now_ms as f64) {
            reset_candidates.push(delta);
        }
    }

    if let Some(max) = reset_candidates.into_iter().max() {
        return Some(max);
    }

    parse_retry_after_text_ms_at(body_text, now_ms)
}

/// Outcome of the TS `mapUsageLimit404WithBody`.
enum Usage404Mapping {
    Untouched,
    /// Entitlement 404 → the fixed 403 response.
    Entitlement(SyntheticResponse),
    /// Structured quota-limit 404 → remap to 429 "Too Many Requests".
    RateLimited,
}

fn map_usage_limit_404_with_body(status: u16, body_text: &str) -> Usage404Mapping {
    if status != HTTP_STATUS.not_found || body_text.is_empty() {
        return Usage404Mapping::Untouched;
    }

    let (code, error_type) = match serde_json::from_str::<Value>(body_text) {
        Ok(parsed) => {
            let error = parsed.get("error").cloned().unwrap_or(Value::Null);
            let code = error
                .get("code")
                .filter(|value| !value.is_null())
                .map(to_string_value)
                .unwrap_or_default();
            let error_type = error
                .get("type")
                .filter(|value| !value.is_null())
                .map(to_string_value)
                .unwrap_or_default();
            (code, error_type)
        }
        Err(_) => (String::new(), String::new()),
    };

    let normalized_signals: Vec<String> = [code, error_type]
        .into_iter()
        .map(|value| value.to_lowercase())
        .filter(|value| !value.is_empty())
        .collect();

    // Entitlement errors first — these are NOT rate limits.
    if is_entitlement_error(&normalized_signals.join(" "), body_text) {
        return Usage404Mapping::Entitlement(create_entitlement_error_response());
    }

    // Only structured quota-limit codes remap 404 → 429; free-text 404 bodies
    // stay untouched (spec 06 gotcha 28).
    if !normalized_signals
        .iter()
        .any(|value| value.contains("usage_limit") || value.contains("rate_limit_exceeded"))
    {
        return Usage404Mapping::Untouched;
    }

    Usage404Mapping::RateLimited
}

fn extract_rate_limit_info(
    status: u16,
    headers: &HeaderMap,
    body_text: &str,
) -> Option<RateLimitInfo> {
    let parsed = parse_rate_limit_body(body_text);

    // Entitlement errors should not be treated as rate limits.
    let code_for_entitlement = parsed
        .as_ref()
        .map(|parsed| parsed.code.as_str())
        .unwrap_or("");
    if is_entitlement_error(code_for_entitlement, body_text) {
        return None;
    }

    if status != HTTP_STATUS.too_many_requests {
        return None;
    }

    let retry_after_ms = parse_retry_after_ms_at(headers, body_text, parsed.as_ref(), now_ms())
        .unwrap_or(60_000);
    Some(RateLimitInfo {
        retry_after_ms,
        code: parsed.map(|parsed| parsed.code),
    })
}

/// TS `extractErrorDiagnostics` — ordered `{httpStatus, requestId, cfRay,
/// correlationId, threadId}` with empty/absent fields removed.
fn extract_error_diagnostics(
    headers: &HeaderMap,
    status: u16,
    options: Option<&ErrorHandlingOptions>,
) -> Option<Map<String, Value>> {
    // First PRESENT header wins even when empty (the TS `??` chain stops at
    // `""`); empty strings are then dropped by the cleanup pass.
    let request_id = [
        "x-request-id",
        "request-id",
        "openai-request-id",
        "x-openai-request-id",
    ]
    .iter()
    .find_map(|name| header_str(headers, name).map(|value| value.into_owned()));
    let cf_ray = header_str(headers, "cf-ray").map(|value| value.into_owned());

    let mut diagnostics = Map::new();
    diagnostics.insert("httpStatus".to_string(), Value::from(status));
    if let Some(request_id) = request_id.filter(|value| !value.is_empty()) {
        diagnostics.insert("requestId".to_string(), Value::String(request_id));
    }
    if let Some(cf_ray) = cf_ray.filter(|value| !value.is_empty()) {
        diagnostics.insert("cfRay".to_string(), Value::String(cf_ray));
    }
    if let Some(correlation_id) = options
        .and_then(|options| options.request_correlation_id.clone())
        .filter(|value| !value.is_empty())
    {
        diagnostics.insert("correlationId".to_string(), Value::String(correlation_id));
    }
    if let Some(thread_id) = options
        .and_then(|options| options.thread_id.clone())
        .filter(|value| !value.is_empty())
    {
        diagnostics.insert("threadId".to_string(), Value::String(thread_id));
    }

    if diagnostics.is_empty() {
        None
    } else {
        Some(diagnostics)
    }
}

const LOGIN_HINT_SUFFIX: &str = " (run `codex-multi-auth login` if this persists)";

/// TS `normalizeErrorPayload` → `{ error: { message, type?, code?,
/// unsupported_model?, diagnostics? } }`.
fn normalize_error_payload(
    error_body: Option<&Value>,
    body_text: &str,
    status_text: &str,
    status: u16,
    diagnostics: Option<&Map<String, Value>>,
) -> Value {
    let attach_diagnostics = |error: &mut Map<String, Value>| {
        if let Some(diagnostics) = diagnostics
            && !diagnostics.is_empty() {
                error.insert(
                    "diagnostics".to_string(),
                    Value::Object(diagnostics.clone()),
                );
            }
    };
    let append_login_hint = |error: &mut Map<String, Value>| {
        if status == HTTP_STATUS.unauthorized
            && let Some(Value::String(message)) = error.get_mut("message") {
                message.push_str(LOGIN_HINT_SUFFIX);
            }
    };
    let wrap = |error: Map<String, Value>| -> Value {
        let mut payload = Map::new();
        payload.insert("error".to_string(), Value::Object(error));
        Value::Object(payload)
    };

    if is_unsupported_codex_model_for_chatgpt(status, body_text) {
        let unsupported_model = extract_unsupported_codex_model_from_text(body_text)
            .unwrap_or_else(|| "requested model".to_string());
        let message = format!(
            "The model '{unsupported_model}' is not currently available for this ChatGPT account when using Codex OAuth. \
This is an account/workspace entitlement gate, not a temporary rate limit. \
Try 'gpt-5.3-codex' (current), or legacy aliases like 'gpt-5-codex'/'gpt-5.2-codex', or enable automatic fallback via \
unsupportedCodexPolicy: \"fallback\" (or CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback). \
(Legacy: CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1 or fallbackOnUnsupportedCodexModel)."
        );
        let mut error = Map::new();
        error.insert("message".to_string(), Value::String(message));
        error.insert(
            "type".to_string(),
            Value::String("entitlement_error".to_string()),
        );
        error.insert(
            "code".to_string(),
            Value::String(CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE.to_string()),
        );
        error.insert(
            "unsupported_model".to_string(),
            Value::String(unsupported_model),
        );
        attach_diagnostics(&mut error);
        return wrap(error);
    }

    if let Some(Value::Object(body)) = error_body {
        if let Some(Value::Object(maybe_error)) = body.get("error")
            && let Some(Value::String(message)) = maybe_error.get("message") {
                let mut error = Map::new();
                error.insert("message".to_string(), Value::String(message.clone()));
                if let Some(Value::String(error_type)) = maybe_error.get("type") {
                    error.insert("type".to_string(), Value::String(error_type.clone()));
                }
                match maybe_error.get("code") {
                    Some(code @ Value::String(_)) | Some(code @ Value::Number(_)) => {
                        error.insert("code".to_string(), code.clone());
                    }
                    _ => {}
                }
                attach_diagnostics(&mut error);
                append_login_hint(&mut error);
                return wrap(error);
            }

        if let Some(Value::String(message)) = body.get("message") {
            let mut error = Map::new();
            error.insert("message".to_string(), Value::String(message.clone()));
            attach_diagnostics(&mut error);
            append_login_hint(&mut error);
            return wrap(error);
        }
    }

    let trimmed = body_text.trim();
    let message = if !trimmed.is_empty() {
        trimmed.to_string()
    } else if !status_text.is_empty() {
        status_text.to_string()
    } else {
        "Request failed".to_string()
    };
    let mut error = Map::new();
    error.insert("message".to_string(), Value::String(message));
    attach_diagnostics(&mut error);
    append_login_hint(&mut error);
    wrap(error)
}

/// TS `ensureJsonErrorResponse` — JSON body with the original status/statusText
/// and `content-type: application/json; charset=utf-8`.
fn ensure_json_error_response(
    status: u16,
    status_text: &str,
    headers: &HeaderMap,
    payload: &Value,
) -> SyntheticResponse {
    let mut response_headers = headers.clone();
    response_headers.insert(
        "content-type",
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    SyntheticResponse {
        status,
        status_text: status_text.to_string(),
        headers: response_headers,
        body: stringify_compact(payload),
    }
}

/// TS `handleErrorResponse(response, options?)`.
pub async fn handle_error_response(
    mut response: StreamResponse,
    options: Option<&ErrorHandlingOptions>,
) -> ErrorHandlingResult {
    // request-01: deprecation/sunset headers are logged on the error path too.
    log_deprecation_headers(&response.headers);

    // TS safeReadBody: read failures degrade to "".
    let body_text = response.collect_text().await.unwrap_or_default();
    let status = response.status;
    let status_text = response.status_text.clone();
    let headers = response.headers.clone();

    let (final_status, final_status_text) = match map_usage_limit_404_with_body(status, &body_text)
    {
        Usage404Mapping::Entitlement(entitlement_response) => {
            // Entitlement errors return the ready-to-use 403 immediately.
            return ErrorHandlingResult {
                response: entitlement_response,
                rate_limit: None,
                error_body: None,
            };
        }
        Usage404Mapping::RateLimited => (
            HTTP_STATUS.too_many_requests,
            "Too Many Requests".to_string(),
        ),
        Usage404Mapping::Untouched => (status, status_text),
    };

    let rate_limit = extract_rate_limit_info(final_status, &headers, &body_text);

    let error_body_raw: Option<Value> = if body_text.is_empty() {
        None
    } else {
        match serde_json::from_str::<Value>(&body_text) {
            Ok(parsed) => Some(parsed),
            Err(_) => {
                let mut fallback = Map::new();
                fallback.insert("message".to_string(), Value::String(body_text.clone()));
                Some(Value::Object(fallback))
            }
        }
    };

    let diagnostics = extract_error_diagnostics(&headers, final_status, options);
    let normalized_error = normalize_error_payload(
        error_body_raw.as_ref(),
        &body_text,
        &final_status_text,
        final_status,
        diagnostics.as_ref(),
    );
    let error_response = ensure_json_error_response(
        final_status,
        &final_status_text,
        &headers,
        &normalized_error,
    );

    if final_status == HTTP_STATUS.unauthorized {
        log_warn(
            "Codex upstream returned 401 Unauthorized",
            diagnostics
                .as_ref()
                .map(|diagnostics| Value::Object(diagnostics.clone()))
                .as_ref(),
        );
    }

    let mut log_data = Map::new();
    log_data.insert("status".to_string(), Value::from(final_status));
    log_data.insert(
        "statusText".to_string(),
        Value::String(final_status_text.clone()),
    );
    if let Some(diagnostics) = diagnostics {
        log_data.insert("diagnostics".to_string(), Value::Object(diagnostics));
    }
    log_request(LOG_STAGES.error_response, &log_data);

    ErrorHandlingResult {
        response: error_response,
        rate_limit,
        error_body: Some(normalized_error),
    }
}

// ---------------------------------------------------------------------------
// handleSuccessResponse
// ---------------------------------------------------------------------------

/// TS `handleSuccessResponse(response, isStreaming, options?)`.
///
/// Non-streaming callers get the SSE stream converted to a single JSON body;
/// streaming callers get the stream as-is with response-id sniffing attached.
pub async fn handle_success_response(
    response: StreamResponse,
    is_streaming: bool,
    options: ConvertSseOptions,
) -> Result<StreamResponse, BoxError> {
    // Check for deprecation headers (RFC 8594).
    log_deprecation_headers(&response.headers);

    let response_headers = ensure_content_type(&response.headers);

    if !is_streaming {
        return convert_sse_to_json(response, &response_headers, options).await;
    }

    Ok(attach_response_id_capture(
        response,
        response_headers,
        options.on_response_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use http::header::HeaderName;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::try_from(*name).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    fn resp(status: u16, status_text: &str, header_pairs: &[(&str, &str)], body: &str) -> StreamResponse {
        StreamResponse::from_text(status, status_text, headers(header_pairs), body)
    }

    fn json_resp(status: u16, body: Value) -> StreamResponse {
        resp(status, "", &[], &stringify_compact(&body))
    }

    // -- 404 usage-limit / entitlement mapping ------------------------------

    #[tokio::test]
    async fn maps_usage_limit_404_errors_to_429() {
        let body = serde_json::json!({
            "error": { "code": "usage_limit_reached", "message": "limit reached" }
        });
        let result = handle_error_response(json_resp(404, body), None).await;
        assert_eq!(result.response.status, 429);
        assert_eq!(result.response.status_text, "Too Many Requests");
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["code"], "usage_limit_reached");
        assert!(result.rate_limit.unwrap().retry_after_ms > 0);
    }

    #[tokio::test]
    async fn maps_usage_limit_404_errors_to_429_when_signal_comes_from_error_type() {
        let body = serde_json::json!({
            "error": { "type": "usage_limit_reached", "message": "limit reached" }
        });
        let result = handle_error_response(json_resp(404, body), None).await;
        assert_eq!(result.response.status, 429);
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["type"], "usage_limit_reached");
        assert!(result.rate_limit.unwrap().retry_after_ms > 0);
    }

    #[tokio::test]
    async fn maps_usage_limit_404_errors_to_429_when_code_and_type_disagree() {
        let body = serde_json::json!({
            "error": {
                "code": "rate_limit_exceeded",
                "type": "usage_limit_reached",
                "message": "limit reached"
            }
        });
        let result = handle_error_response(json_resp(404, body), None).await;
        assert_eq!(result.response.status, 429);
        assert!(result.rate_limit.unwrap().retry_after_ms > 0);
    }

    #[tokio::test]
    async fn maps_entitlement_style_404_errors_to_403_when_only_type_carries_the_signal() {
        let body = serde_json::json!({
            "error": {
                "code": "not_found",
                "type": "usage_not_included",
                "message": "Not included in your plan"
            }
        });
        let result = handle_error_response(json_resp(404, body), None).await;
        assert_eq!(result.response.status, 403);
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["code"], "usage_not_included");
        assert!(json["error"]["message"].as_str().unwrap().contains("not included"));
        assert!(result.rate_limit.is_none());
        assert!(result.error_body.is_none());
    }

    #[tokio::test]
    async fn prioritizes_entitlement_over_rate_limit_when_signals_conflict() {
        let body = serde_json::json!({
            "error": {
                "code": "usage_not_included",
                "type": "usage_limit_reached",
                "message": "mixed signals"
            }
        });
        let result = handle_error_response(json_resp(404, body), None).await;
        assert_eq!(result.response.status, 403);
        assert!(result.rate_limit.is_none());
    }

    #[tokio::test]
    async fn leaves_non_usage_404_errors_unchanged() {
        let body = serde_json::json!({ "error": { "code": "not_found", "message": "nope" } });
        let result = handle_error_response(json_resp(404, body), None).await;
        assert_eq!(result.response.status, 404);
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["code"], "not_found");
        assert!(result.rate_limit.is_none());
    }

    #[tokio::test]
    async fn maps_usage_not_included_404_to_403_entitlement_error_not_rate_limit() {
        let body = serde_json::json!({
            "error": { "code": "usage_not_included", "message": "Usage not included in your plan" }
        });
        let result = handle_error_response(json_resp(404, body), None).await;
        assert_eq!(result.response.status, 403);
        assert!(result.rate_limit.is_none());
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["type"], "entitlement_error");
        assert!(
            json["error"]["message"]
                .as_str()
                .unwrap()
                .contains("not included in your ChatGPT subscription")
        );
    }

    #[tokio::test]
    async fn does_not_remap_404s_with_free_text_usage_limit_messages() {
        let result = handle_error_response(
            resp(404, "", &[], "usage limit exceeded - please try again"),
            None,
        )
        .await;
        assert_eq!(result.response.status, 404);
        assert!(result.rate_limit.is_none());
    }

    #[tokio::test]
    async fn does_not_remap_404s_with_malformed_json_bodies() {
        let result = handle_error_response(resp(404, "", &[], "{ invalid json"), None).await;
        assert_eq!(result.response.status, 404);
        assert!(result.rate_limit.is_none());
    }

    #[tokio::test]
    async fn does_not_remap_empty_404_bodies_to_rate_limits() {
        let result = handle_error_response(resp(404, "", &[], ""), None).await;
        assert_eq!(result.response.status, 404);
        assert!(result.rate_limit.is_none());
    }

    // -- error normalization -------------------------------------------------

    #[tokio::test]
    async fn extracts_nested_error_message() {
        let body = serde_json::json!({
            "error": { "message": "nested error message", "type": "test_type", "code": "test_code" }
        });
        let result = handle_error_response(json_resp(500, body), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["message"], "nested error message");
        assert_eq!(json["error"]["type"], "test_type");
        assert_eq!(json["error"]["code"], "test_code");
        // errorBody is the NORMALIZED payload (gotcha 27).
        assert_eq!(result.error_body.unwrap(), json);
    }

    #[tokio::test]
    async fn extracts_top_level_message() {
        let body = serde_json::json!({ "message": "top-level message" });
        let result = handle_error_response(json_resp(500, body), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["message"], "top-level message");
    }

    #[tokio::test]
    async fn uses_trimmed_body_text_when_json_parses_to_non_record() {
        let result = handle_error_response(resp(500, "", &[], "\"just a string\""), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["message"], "\"just a string\"");
    }

    #[tokio::test]
    async fn uses_body_text_when_no_structured_error() {
        let result = handle_error_response(resp(500, "", &[], "plain text error"), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["message"], "plain text error");
    }

    #[tokio::test]
    async fn uses_status_text_when_body_is_empty() {
        let result =
            handle_error_response(resp(500, "Internal Server Error", &[], ""), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["message"], "Internal Server Error");
    }

    #[tokio::test]
    async fn uses_fallback_message_when_everything_is_empty() {
        let result = handle_error_response(resp(500, "", &[], ""), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["message"], "Request failed");
    }

    #[tokio::test]
    async fn handles_numeric_error_codes() {
        let body = serde_json::json!({ "error": { "message": "error", "code": 12345 } });
        let result = handle_error_response(json_resp(500, body), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["code"], 12345);
    }

    #[tokio::test]
    async fn error_response_forces_json_content_type() {
        let result = handle_error_response(
            resp(500, "", &[("content-type", "text/plain")], "boom"),
            None,
        )
        .await;
        assert_eq!(
            result.response.headers.get("content-type").unwrap(),
            "application/json; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn includes_401_diagnostics_from_response_headers() {
        let body = serde_json::json!({ "error": { "message": "Unauthorized" } });
        let result = handle_error_response(
            resp(
                401,
                "",
                &[("cf-ray", "abc123-def"), ("x-request-id", "req_123")],
                &stringify_compact(&body),
            ),
            Some(&ErrorHandlingOptions {
                request_correlation_id: Some("corr-1".into()),
                thread_id: Some("thread-1".into()),
            }),
        )
        .await;
        let json = result.response.json().unwrap();
        assert!(
            json["error"]["message"]
                .as_str()
                .unwrap()
                .contains("codex-multi-auth login")
        );
        let diagnostics = &json["error"]["diagnostics"];
        assert_eq!(diagnostics["cfRay"], "abc123-def");
        assert_eq!(diagnostics["requestId"], "req_123");
        assert_eq!(diagnostics["correlationId"], "corr-1");
        assert_eq!(diagnostics["threadId"], "thread-1");
        assert_eq!(diagnostics["httpStatus"], 401);
    }

    #[tokio::test]
    async fn adds_login_hint_for_all_401_message_branches() {
        // top-level message
        let top_level = handle_error_response(
            resp(
                401,
                "Unauthorized",
                &[],
                &stringify_compact(&serde_json::json!({ "message": "token invalid" })),
            ),
            None,
        )
        .await;
        assert!(
            top_level.response.json().unwrap()["error"]["message"]
                .as_str()
                .unwrap()
                .contains("codex-multi-auth login")
        );
        // trimmed body text
        let trimmed =
            handle_error_response(resp(401, "Unauthorized", &[], "plain auth failure"), None).await;
        assert!(
            trimmed.response.json().unwrap()["error"]["message"]
                .as_str()
                .unwrap()
                .contains("codex-multi-auth login")
        );
        // statusText
        let status_text = handle_error_response(resp(401, "Unauthorized", &[], ""), None).await;
        assert!(
            status_text.response.json().unwrap()["error"]["message"]
                .as_str()
                .unwrap()
                .contains("codex-multi-auth login")
        );
        // fallback
        let fallback = handle_error_response(resp(401, "", &[], ""), None).await;
        assert_eq!(
            fallback.response.json().unwrap()["error"]["message"],
            format!("Request failed{LOGIN_HINT_SUFFIX}")
        );
    }

    // -- unsupported-model 400 handling --------------------------------------

    #[tokio::test]
    async fn normalizes_chatgpt_model_not_supported_400_to_actionable_entitlement_error() {
        let body = serde_json::json!({
            "detail": "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."
        });
        let result = handle_error_response(json_resp(400, body), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["type"], "entitlement_error");
        assert_eq!(
            json["error"]["code"],
            "model_not_supported_with_chatgpt_account"
        );
        let message = json["error"]["message"].as_str().unwrap();
        assert!(message.contains("'gpt-5.3-codex'"));
        assert!(message.contains("CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL"));
        assert_eq!(json["error"]["unsupported_model"], "gpt-5.3-codex");
    }

    #[tokio::test]
    async fn rewrites_normalized_not_currently_available_400_wording_as_entitlement_error() {
        let result = handle_error_response(
            resp(
                400,
                "",
                &[],
                "The model 'gpt-5.3-codex' is not currently available for this chatgpt account.",
            ),
            None,
        )
        .await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["type"], "entitlement_error");
        assert_eq!(
            json["error"]["code"],
            "model_not_supported_with_chatgpt_account"
        );
        assert_eq!(json["error"]["unsupported_model"], "gpt-5.3-codex");
        assert!(json["error"]["message"].as_str().unwrap().contains("entitlement gate"));
    }

    #[tokio::test]
    async fn uses_generic_unsupported_model_placeholder_when_body_has_no_quoted_model() {
        let body = serde_json::json!({
            "detail": "model is not supported when using Codex with a ChatGPT account"
        });
        let result = handle_error_response(json_resp(400, body), None).await;
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["unsupported_model"], "requested model");
    }

    // -- rate limit extraction ------------------------------------------------

    #[tokio::test]
    async fn parses_retry_after_ms_from_body() {
        let body = serde_json::json!({ "error": { "message": "rate limited", "retry_after_ms": 5000 } });
        let result = handle_error_response(json_resp(429, body), None).await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 5000);
    }

    #[tokio::test]
    async fn keeps_retry_after_ms_values_in_milliseconds() {
        let body = serde_json::json!({ "error": { "message": "rate limited", "retry_after_ms": 5 } });
        let result = handle_error_response(json_resp(429, body), None).await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 5);
    }

    #[tokio::test]
    async fn interprets_retry_after_values_as_seconds() {
        let body = serde_json::json!({ "error": { "message": "rate limited", "retry_after": 5 } });
        let result = handle_error_response(json_resp(429, body), None).await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 5000);
    }

    #[tokio::test]
    async fn parses_retry_after_ms_header() {
        let result = handle_error_response(
            resp(
                429,
                "",
                &[("retry-after-ms", "3000")],
                &stringify_compact(&serde_json::json!({ "error": { "message": "rate limited" } })),
            ),
            None,
        )
        .await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 3000);
    }

    #[tokio::test]
    async fn parses_retry_after_header_seconds() {
        let result = handle_error_response(
            resp(
                429,
                "",
                &[("retry-after", "10")],
                &stringify_compact(&serde_json::json!({ "error": { "message": "rate limited" } })),
            ),
            None,
        )
        .await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 10_000);
    }

    #[tokio::test]
    async fn falls_back_to_retry_after_headers_when_body_retry_values_are_invalid() {
        let body = serde_json::json!({ "error": { "message": "rate limited", "retry_after_ms": -1 } });
        let result = handle_error_response(
            resp(429, "", &[("retry-after-ms", "2500")], &stringify_compact(&body)),
            None,
        )
        .await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 2500);
    }

    #[tokio::test]
    async fn handles_invalid_retry_after_header_with_default_fallback() {
        let result = handle_error_response(
            resp(
                429,
                "",
                &[("retry-after", "invalid")],
                &stringify_compact(&serde_json::json!({ "error": { "message": "rate limited" } })),
            ),
            None,
        )
        .await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 60_000);
    }

    #[tokio::test]
    async fn falls_back_to_default_retry_window_when_retry_metadata_is_invalid() {
        let past_unix_seconds = now_ms() / 1000 - 60;
        let body = serde_json::json!({
            "error": {
                "message": "rate limited",
                "retry_after_ms": "not-a-number",
                "retry_after": 0,
                "resets_at": "also-bad",
            }
        });
        let result = handle_error_response(
            resp(
                429,
                "",
                &[
                    ("retry-after-ms", "NaN"),
                    ("retry-after", "0"),
                    ("x-ratelimit-reset", &past_unix_seconds.to_string()),
                ],
                &stringify_compact(&body),
            ),
            None,
        )
        .await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 60_000);
    }

    #[tokio::test]
    async fn handles_resets_at_in_the_past_with_default_fallback() {
        let past_timestamp = now_ms() / 1000 - 60;
        let body = serde_json::json!({
            "error": { "message": "rate limited", "resets_at": past_timestamp }
        });
        let result = handle_error_response(json_resp(429, body), None).await;
        assert_eq!(result.rate_limit.unwrap().retry_after_ms, 60_000);
    }

    #[tokio::test]
    async fn parses_x_ratelimit_reset_unix_seconds_header() {
        let future_timestamp = now_ms() / 1000 + 60;
        let result = handle_error_response(
            resp(
                429,
                "",
                &[("x-ratelimit-reset", &future_timestamp.to_string())],
                &stringify_compact(&serde_json::json!({ "error": { "message": "rate limited" } })),
            ),
            None,
        )
        .await;
        let retry_after_ms = result.rate_limit.unwrap().retry_after_ms;
        assert!(retry_after_ms > 0);
        assert!(retry_after_ms <= 60_000);
    }

    #[tokio::test]
    async fn parses_resets_at_in_milliseconds_format_from_body() {
        let future_timestamp_ms = now_ms() + 30_000;
        let body = serde_json::json!({
            "error": { "message": "rate limited", "resets_at": future_timestamp_ms }
        });
        let result = handle_error_response(json_resp(429, body), None).await;
        let retry_after_ms = result.rate_limit.unwrap().retry_after_ms;
        assert!(retry_after_ms > 0);
        assert!(retry_after_ms <= 30_000);
    }

    #[tokio::test]
    async fn caps_retry_after_ms_body_values_at_7_days() {
        let body = serde_json::json!({
            "error": { "message": "rate limited", "retry_after_ms": 10 * 24 * 60 * 60 * 1000 }
        });
        let result = handle_error_response(json_resp(429, body), None).await;
        assert_eq!(
            result.rate_limit.unwrap().retry_after_ms,
            7 * 24 * 60 * 60 * 1000
        );
    }

    #[tokio::test]
    async fn caps_retry_after_ms_header_values_at_7_days() {
        let ten_days_ms = (10 * 24 * 60 * 60 * 1000i64).to_string();
        let result = handle_error_response(
            resp(
                429,
                "",
                &[("retry-after-ms", &ten_days_ms)],
                &stringify_compact(&serde_json::json!({ "error": { "message": "rate limited" } })),
            ),
            None,
        )
        .await;
        assert_eq!(
            result.rate_limit.unwrap().retry_after_ms,
            7 * 24 * 60 * 60 * 1000
        );
    }

    #[tokio::test]
    async fn caps_reset_timestamp_hints_at_7_days() {
        let reset_at_seconds = now_ms() / 1000 + 10 * 24 * 60 * 60;
        let result = handle_error_response(
            resp(
                429,
                "",
                &[("x-ratelimit-reset", &reset_at_seconds.to_string())],
                &stringify_compact(&serde_json::json!({ "error": { "message": "rate limited" } })),
            ),
            None,
        )
        .await;
        assert_eq!(
            result.rate_limit.unwrap().retry_after_ms,
            7 * 24 * 60 * 60 * 1000
        );
    }

    #[tokio::test]
    async fn handles_429_with_entitlement_code_or_text_as_non_rate_limit() {
        let by_code =
            serde_json::json!({ "error": { "code": "usage_not_included", "message": "Not included" } });
        let result = handle_error_response(json_resp(429, by_code), None).await;
        assert_eq!(result.response.status, 429);
        assert!(result.rate_limit.is_none());

        let by_text =
            serde_json::json!({ "error": { "message": "Usage not included in your plan" } });
        let result = handle_error_response(json_resp(429, by_text), None).await;
        assert_eq!(result.response.status, 429);
        assert!(result.rate_limit.is_none());
    }

    #[tokio::test]
    async fn does_not_treat_non_429_rate_limit_text_as_a_cooldown_signal() {
        let result = handle_error_response(
            resp(500, "", &[], "rate_limit_exceeded - upstream overloaded"),
            None,
        )
        .await;
        assert_eq!(result.response.status, 500);
        assert!(result.rate_limit.is_none());
    }

    #[tokio::test]
    async fn body_read_failures_degrade_to_the_request_failed_payload() {
        // safeReadBody catch: an erroring body stream reads as "".
        let failing_body: crate::response_handler::BodyStream =
            futures::stream::once(async { Err::<bytes::Bytes, BoxError>("boom".into()) }).boxed();
        let response = StreamResponse::new(500, "", HeaderMap::new(), Some(failing_body));
        let result = handle_error_response(response, None).await;
        assert_eq!(result.response.status, 500);
        let json = result.response.json().unwrap();
        assert_eq!(json["error"]["message"], "Request failed");
    }

    // -- deterministic parseRetryAfterMs internals ---------------------------

    /// Fixed "now": 2026-04-05T00:00:00.000Z.
    const NOW_MS: i64 = 1_775_347_200_000;

    #[test]
    fn now_constant_matches_the_ts_fake_clock() {
        let expected = chrono::DateTime::parse_from_rfc3339("2026-04-05T00:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(NOW_MS, expected);
    }

    #[test]
    fn parses_retry_after_header_http_date() {
        let headers = headers(&[("retry-after", "Sun, 05 Apr 2026 00:01:30 GMT")]);
        assert_eq!(
            parse_retry_after_ms_at(&headers, "", None, NOW_MS),
            Some(90_000)
        );
    }

    #[test]
    fn prefers_the_longest_reset_hint_across_headers() {
        let headers = headers(&[
            ("x-codex-primary-reset-after-seconds", "60"),
            ("x-codex-secondary-reset-at", "Sun, 05 Apr 2026 01:30:00 GMT"),
        ]);
        assert_eq!(
            parse_retry_after_ms_at(&headers, "", None, NOW_MS),
            Some(90 * 60 * 1000)
        );
    }

    #[test]
    fn millisecond_epoch_reset_headers_skip_the_seconds_multiplier() {
        let reset_ms = NOW_MS + 45_000;
        let headers = headers(&[("x-ratelimit-reset", &reset_ms.to_string())]);
        assert_eq!(
            parse_retry_after_ms_at(&headers, "", None, NOW_MS),
            Some(45_000)
        );
    }

    #[test]
    fn parses_natural_language_retry_durations() {
        assert_eq!(
            parse_retry_after_text_ms_at(
                "You've hit your usage limit. Please try again in 2 hours.",
                NOW_MS
            ),
            Some(2 * 60 * 60 * 1000)
        );
        assert_eq!(
            parse_retry_after_text_ms_at("retry again in 45 seconds", NOW_MS),
            Some(45_000)
        );
        assert_eq!(
            parse_retry_after_text_ms_at("try again in 1 day", NOW_MS),
            Some(24 * 60 * 60 * 1000)
        );
        assert_eq!(parse_retry_after_text_ms_at("no hints here", NOW_MS), None);
    }

    #[test]
    fn parses_natural_language_clock_times_in_local_time() {
        use chrono::TimeZone;
        // "today" at 04:00 LOCAL (DST transitions happen before 04:00, so the
        // 04:00 → 06:26 window is transition-free).
        let date = chrono::Local::now().date_naive();
        let four_am = chrono::Local
            .from_local_datetime(&date.and_hms_opt(4, 0, 0).unwrap())
            .earliest()
            .unwrap();
        let now = four_am.timestamp_millis();

        let parsed = parse_retry_after_text_ms_at(
            "You've hit your usage limit. To get more access now, send a request to your admin or try again at 6:26 AM.",
            now,
        );
        assert_eq!(parsed, Some((2 * 60 + 26) * 60 * 1000));

        // A clock time already past rolls to the next day.
        let rolled = parse_retry_after_text_ms_at("try again at 3:00 AM", now).unwrap();
        assert!(rolled > 0);
        assert!(rolled <= 24 * 60 * 60 * 1000);
    }

    #[test]
    fn seven_day_clamp_applies_to_every_source() {
        assert_eq!(
            clamp_rate_limit_delay_ms(10.0 * 24.0 * 60.0 * 60.0 * 1000.0),
            Some(MAX_RATE_LIMIT_DELAY_MS)
        );
        assert_eq!(clamp_rate_limit_delay_ms(0.0), None);
        assert_eq!(clamp_rate_limit_delay_ms(-5.0), None);
        assert_eq!(clamp_rate_limit_delay_ms(f64::NAN), None);
        assert_eq!(
            parse_retry_after_text_ms_at("try again in 30 days", NOW_MS),
            Some(MAX_RATE_LIMIT_DELAY_MS)
        );
    }

    // -- handleSuccessResponse -----------------------------------------------

    #[tokio::test]
    async fn returns_stream_as_is_for_streaming_requests() {
        let response = resp(200, "", &[], "stream body");
        let mut result = handle_success_response(response, true, ConvertSseOptions::default())
            .await
            .unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.collect_text().await.unwrap(), "stream body");
    }

    #[tokio::test]
    async fn captures_response_ids_from_streaming_sse_without_rewriting_the_stream() {
        let sse = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream_123\"}}\n\n\
data: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_stream_123\"}}\n\n";
        let response = resp(
            200,
            "",
            &[("content-type", "text/event-stream")],
            sse,
        );
        let seen: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        let seen_in_callback = Arc::clone(&seen);
        let mut result = handle_success_response(
            response,
            true,
            ConvertSseOptions {
                on_response_id: Some(Arc::new(move |id| {
                    assert_eq!(id, "resp_stream_123");
                    seen_in_callback.fetch_add(1, Ordering::SeqCst);
                })),
                stream_stall_timeout_ms: None,
            },
        )
        .await
        .unwrap();

        let text = result.collect_text().await.unwrap();
        assert!(text.contains("\"resp_stream_123\""));
        assert_eq!(seen.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn converts_sse_to_json_for_non_streaming_requests() {
        let sse = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"output\":[]}}\n\n";
        let response = resp(200, "OK", &[("content-type", "text/event-stream")], sse);
        let mut result = handle_success_response(response, false, ConvertSseOptions::default())
            .await
            .unwrap();
        assert_eq!(
            result.headers.get("content-type").unwrap(),
            "application/json; charset=utf-8"
        );
        let text = result.collect_text().await.unwrap();
        let json: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["id"], "resp_1");
    }

    // -- transformRequestForCodex (sibling seam injected) ---------------------

    struct DepsFixture {
        instruction_calls: Arc<AtomicUsize>,
    }

    impl DepsFixture {
        fn new() -> Self {
            DepsFixture {
                instruction_calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    fn passthrough_transform(
        args: TransformRequestBodyArgs,
    ) -> BoxFuture<'static, Result<Map<String, Value>, BoxError>> {
        Box::pin(async move {
            let mut body = args.body;
            body.insert(
                "instructions".to_string(),
                Value::String(args.codex_instructions),
            );
            body.insert("stream".to_string(), Value::Bool(true));
            Ok(body)
        })
    }

    fn trim_when_fast(
        _body: &Map<String, Value>,
        fast_session: bool,
        _strategy: FastSessionStrategy,
        max_items: f64,
    ) -> Option<DeferredFastSessionInputTrim> {
        fast_session.then_some(DeferredFastSessionInputTrim {
            max_items,
            prefer_latest_user_only: false,
        })
    }

    async fn run_transform(
        init: Option<&RequestInit>,
        parsed_body: Option<&Map<String, Value>>,
        options: TransformRequestForCodexOptions,
        transform: TransformRequestBodyFn<'_>,
        fixture: &DepsFixture,
    ) -> Result<Option<TransformRequestForCodexResult>, BoxError> {
        let calls = Arc::clone(&fixture.instruction_calls);
        let get_instructions = move |_model: &str| -> BoxFuture<'static, Result<String, BoxError>> {
            calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok("TEST INSTRUCTIONS".to_string()) })
        };
        let deps = TransformRequestForCodexDeps {
            resolve_fast_session_input_trim: &trim_when_fast,
            get_codex_instructions: &get_instructions,
            transform_request_body: transform,
        };
        transform_request_for_codex(
            init,
            "https://example.com",
            &UserConfig::default(),
            true,
            parsed_body,
            options,
            &deps,
        )
        .await
    }

    fn text_init(body: &str) -> RequestInit {
        RequestInit {
            method: Some("POST".into()),
            headers: None,
            body: Some(BodyInit::Text(body.to_string())),
        }
    }

    #[tokio::test]
    async fn returns_none_when_init_and_parsed_body_are_missing() {
        let fixture = DepsFixture::new();
        let result = run_transform(
            None,
            None,
            TransformRequestForCodexOptions::default(),
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap();
        assert!(result.is_none());

        // init without a body
        let init = RequestInit::default();
        let result = run_transform(
            Some(&init),
            None,
            TransformRequestForCodexOptions::default(),
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap();
        assert!(result.is_none());
        assert_eq!(fixture.instruction_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn returns_none_when_init_body_is_not_a_string() {
        let fixture = DepsFixture::new();
        let init = RequestInit {
            body: Some(BodyInit::Bytes(b"test".to_vec())),
            ..Default::default()
        };
        let result = run_transform(
            Some(&init),
            None,
            TransformRequestForCodexOptions::default(),
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn returns_none_when_parsed_body_is_empty_and_init_body_is_unavailable() {
        let fixture = DepsFixture::new();
        let init = RequestInit {
            body: Some(BodyInit::Bytes(b"ignored".to_vec())),
            ..Default::default()
        };
        let empty = Map::new();
        let result = run_transform(
            Some(&init),
            Some(&empty),
            TransformRequestForCodexOptions::default(),
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn returns_none_and_logs_when_json_parsing_fails() {
        let fixture = DepsFixture::new();
        let init = text_init("not valid json {{{");
        let result = run_transform(
            Some(&init),
            None,
            TransformRequestForCodexOptions::default(),
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap();
        assert!(result.is_none());
        assert_eq!(fixture.instruction_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn transforms_request_body_successfully() {
        let fixture = DepsFixture::new();
        let init = text_init(&stringify_compact(
            &serde_json::json!({ "model": "gpt-5.1", "input": "Hello" }),
        ));
        let result = run_transform(
            Some(&init),
            None,
            TransformRequestForCodexOptions::default(),
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(result.body.get("model"), Some(&Value::String("gpt-5.1".into())));
        assert_eq!(
            result.body.get("instructions"),
            Some(&Value::String("TEST INSTRUCTIONS".into()))
        );
        let updated_body = result.updated_init.body.unwrap();
        let text = updated_body.as_text().unwrap();
        let round_trip: Value = serde_json::from_str(text).unwrap();
        assert_eq!(round_trip["model"], "gpt-5.1");
        assert_eq!(fixture.instruction_calls.load(Ordering::SeqCst), 1);
        assert!(result.deferred_fast_session_input_trim.is_none());
    }

    #[tokio::test]
    async fn transforms_parsed_body_when_init_is_missing_or_binary() {
        let fixture = DepsFixture::new();
        let parsed: Map<String, Value> = serde_json::from_value(serde_json::json!({
            "model": "gpt-5.3-codex",
            "input": [{ "type": "message", "role": "user", "content": "hi" }],
        }))
        .unwrap();

        let result = run_transform(
            None,
            Some(&parsed),
            TransformRequestForCodexOptions {
                fast_session: true,
                fast_session_strategy: FastSessionStrategy::Always,
                fast_session_max_input_items: 12.0,
                ..Default::default()
            },
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            result.body.get("model"),
            Some(&Value::String("gpt-5.3-codex".into()))
        );
        assert!(result.updated_init.body.unwrap().as_text().is_some());
    }

    #[tokio::test]
    async fn rethrows_background_mode_compatibility_errors() {
        let fixture = DepsFixture::new();
        let background_rejecting = |_args: TransformRequestBodyArgs| -> BoxFuture<
            'static,
            Result<Map<String, Value>, BoxError>,
        > {
            Box::pin(async {
                Err::<Map<String, Value>, BoxError>(
                    "Responses background mode is disabled. Enable pluginConfig.backgroundResponses or CODEX_AUTH_BACKGROUND_RESPONSES=1 to opt in."
                        .into(),
                )
            })
        };
        let init = text_init(&stringify_compact(&serde_json::json!({
            "model": "gpt-5.4",
            "background": true,
            "input": [{ "type": "message", "role": "user", "content": "hello" }],
        })));
        let error = run_transform(
            Some(&init),
            None,
            TransformRequestForCodexOptions::default(),
            &background_rejecting,
            &fixture,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().starts_with("Responses background mode"));
    }

    #[tokio::test]
    async fn other_transform_errors_degrade_to_none() {
        let fixture = DepsFixture::new();
        let failing = |_args: TransformRequestBodyArgs| -> BoxFuture<
            'static,
            Result<Map<String, Value>, BoxError>,
        > { Box::pin(async { Err::<Map<String, Value>, BoxError>("kaboom".into()) }) };
        let init = text_init(&stringify_compact(&serde_json::json!({ "model": "gpt-5.1" })));
        let result = run_transform(
            Some(&init),
            None,
            TransformRequestForCodexOptions::default(),
            &failing,
            &fixture,
        )
        .await
        .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn defers_fast_session_trim_only_for_non_background_requests() {
        let fixture = DepsFixture::new();
        let options = TransformRequestForCodexOptions {
            fast_session: true,
            fast_session_strategy: FastSessionStrategy::Always,
            fast_session_max_input_items: 1.0,
            defer_fast_session_input_trimming: true,
            ..Default::default()
        };

        // Non-background: the deferred directive is handed back.
        let init = text_init(&stringify_compact(&serde_json::json!({
            "model": "gpt-5.4",
            "input": [{ "type": "message", "role": "user", "content": "hello" }],
        })));
        let result = run_transform(
            Some(&init),
            None,
            options,
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            result.deferred_fast_session_input_trim,
            Some(DeferredFastSessionInputTrim {
                max_items: 1.0,
                prefer_latest_user_only: false,
            })
        );

        // Background=true suppresses the deferred trim.
        let init = text_init(&stringify_compact(&serde_json::json!({
            "model": "gpt-5.4",
            "background": true,
            "input": [
                { "id": "msg_1", "type": "message", "role": "user", "content": "hello" },
                { "id": "msg_2", "type": "message", "role": "assistant", "content": "hi" },
            ],
        })));
        let result = run_transform(
            Some(&init),
            None,
            options,
            &passthrough_transform,
            &fixture,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.body.get("background"), Some(&Value::Bool(true)));
        assert!(result.deferred_fast_session_input_trim.is_none());
    }

    // -- misc helpers ---------------------------------------------------------

    #[test]
    fn js_parse_int_matches_parse_int_semantics() {
        assert_eq!(js_parse_int("2500"), Some(2500.0));
        assert_eq!(js_parse_int("  42abc"), Some(42.0));
        assert_eq!(js_parse_int("-7"), Some(-7.0));
        assert_eq!(js_parse_int("+8"), Some(8.0));
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int(""), None);
        assert_eq!(js_parse_int("Sun, 05 Apr 2026 00:01:30 GMT"), None);
    }

    #[test]
    fn shared_client_is_a_singleton() {
        let first = shared_client() as *const reqwest::Client;
        let second = shared_client() as *const reqwest::Client;
        assert_eq!(first, second);
    }
}
