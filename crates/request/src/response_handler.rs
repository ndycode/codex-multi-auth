//! Port of `lib/request/response-handler.ts` — SSE parsing & response
//! reconstruction (spec 06 §5; ARCHITECTURE §6.10 + §11 risk 1).
//!
//! This module is THE parity-critical SSE state machine:
//! - `response.incomplete` is a SUCCESS terminal event (partial output IS the
//!   answer — re-audit correction to stress-audit H7).
//! - `error` / `response.failed` ⇒ synthetic 502 `sse_terminal_error` (or the
//!   upstream status when it was already >= 400).
//! - No terminal event and no error ⇒ raw SSE passthrough at the ORIGINAL
//!   status (feeds the caller's empty-response retry path — never an error).
//! - `data:` lines parse with AND without the space after the colon (M1).
//! - `[DONE]` and empty payloads are skipped; malformed JSON is counted and
//!   warned once (+ rollup), never fatal.
//!
//! The TS `Response` object is modelled as [`StreamResponse`]: status +
//! statusText + `http::HeaderMap` + an optional boxed byte stream. reqwest
//! (`bytes_stream()`) and hyper (`Body::from_stream`) both map onto it.

use std::collections::HashSet;
use std::sync::Arc;

use bytes::Bytes;
use futures::StreamExt;
use futures::stream::BoxStream;
use http::HeaderMap;
use http::header::{CONTENT_TYPE, HeaderValue};
use serde_json::{Map, Value};

use cma_core::constants::{HTTP_STATUS, PLUGIN_NAME};
use cma_core::json_io::stringify_compact;
use cma_core::logger::{ScopedLogger, create_logger, log_request, logging_enabled};
use cma_core::utils::is_record;

/// 10 MiB limit to prevent memory exhaustion (TS `MAX_SSE_SIZE`).
pub const MAX_SSE_SIZE: usize = 10 * 1024 * 1024;
/// TS `DEFAULT_STREAM_STALL_TIMEOUT_MS`.
pub const DEFAULT_STREAM_STALL_TIMEOUT_MS: f64 = 45_000.0;
/// TS `MAX_SYNTHESIZED_EVENT_INDEX` — indexes above this are ignored, not errors.
pub const MAX_SYNTHESIZED_EVENT_INDEX: usize = 255;

/// Boxed error used across the request streaming layer (TS thrown `Error`s).
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;
/// Byte-stream body: the Rust analogue of a web `ReadableStream<Uint8Array>`.
pub type BodyStream = BoxStream<'static, Result<Bytes, BoxError>>;
/// TS `onResponseId` callback. Rust closures cannot throw, so the TS
/// exception-swallowing around the callback has no analogue.
pub type ResponseIdCallback = Arc<dyn Fn(&str) + Send + Sync + 'static>;

fn log() -> ScopedLogger {
    create_logger("response-handler")
}

// ---------------------------------------------------------------------------
// StreamResponse — the fetch `Response` analogue shared by this crate's
// streaming modules (stream_failover, stream_failover_runtime,
// context_overflow all import it from here, mirroring the TS import graph).
// ---------------------------------------------------------------------------

/// Rust analogue of the web `Response` used by the TS request cluster.
///
/// The body is a one-shot byte stream (no `.clone()` — callers that need to
/// inspect a body AND return it must buffer the bytes first; that is the TS
/// "clone before read" pattern, e.g. `isEmptyResponse` callers clone the
/// Response before parsing so the returned body stays readable).
pub struct StreamResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HeaderMap,
    pub body: Option<BodyStream>,
}

impl std::fmt::Debug for StreamResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamResponse")
            .field("status", &self.status)
            .field("status_text", &self.status_text)
            .field("headers", &self.headers)
            .field("body", &self.body.as_ref().map(|_| "<stream>"))
            .finish()
    }
}

/// Build a single-chunk body stream from bytes.
pub fn body_stream_from_bytes(bytes: Bytes) -> BodyStream {
    futures::stream::once(async move { Ok(bytes) }).boxed()
}

impl StreamResponse {
    pub fn new(
        status: u16,
        status_text: impl Into<String>,
        headers: HeaderMap,
        body: Option<BodyStream>,
    ) -> Self {
        Self { status, status_text: status_text.into(), headers, body }
    }

    /// Response with a single-chunk UTF-8 text body.
    pub fn from_text(
        status: u16,
        status_text: impl Into<String>,
        headers: HeaderMap,
        text: impl Into<String>,
    ) -> Self {
        Self::new(status, status_text, headers, Some(body_stream_from_bytes(Bytes::from(text.into()))))
    }

    /// Response with a single-chunk byte body.
    pub fn from_bytes(
        status: u16,
        status_text: impl Into<String>,
        headers: HeaderMap,
        bytes: Bytes,
    ) -> Self {
        Self::new(status, status_text, headers, Some(body_stream_from_bytes(bytes)))
    }

    /// `response.ok` analogue: `true` for 2xx statuses.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Consume the body, collecting it into a lossily-decoded UTF-8 string
    /// (TS `await response.text()`). A body-less response yields `""`.
    /// Propagates the first stream error.
    pub async fn collect_text(&mut self) -> Result<String, BoxError> {
        let bytes = self.collect_bytes().await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Consume the body into raw bytes.
    pub async fn collect_bytes(&mut self) -> Result<Vec<u8>, BoxError> {
        let Some(mut body) = self.body.take() else {
            return Ok(Vec::new());
        };
        let mut out: Vec<u8> = Vec::new();
        while let Some(item) = body.next().await {
            out.extend_from_slice(&item?);
        }
        Ok(out)
    }

    /// Consume the body and parse it as JSON (TS `await response.json()`).
    pub async fn collect_json(&mut self) -> Result<Value, BoxError> {
        let text = self.collect_text().await?;
        Ok(serde_json::from_str(&text)?)
    }
}

// ---------------------------------------------------------------------------
// Incremental UTF-8 decoder — `TextDecoder(..., { stream: true })` analogue.
// ---------------------------------------------------------------------------

/// Streaming UTF-8 decoder: holds back an incomplete trailing multi-byte
/// sequence between chunks; invalid sequences become U+FFFD (lossy), matching
/// the WHATWG TextDecoder's non-fatal mode closely enough for SSE payloads.
#[derive(Debug, Default)]
struct Utf8StreamDecoder {
    carry: Vec<u8>,
}

/// Index where an incomplete trailing UTF-8 sequence starts, or `len` when the
/// buffer ends on a complete (or irrecoverably invalid) boundary.
fn incomplete_suffix_start(buf: &[u8]) -> usize {
    let len = buf.len();
    if len == 0 {
        return 0;
    }
    let lower = len.saturating_sub(3);
    let mut i = len;
    while i > lower {
        i -= 1;
        let b = buf[i];
        if b < 0x80 {
            // ASCII: everything after it (continuations without a lead) is
            // invalid, not incomplete — decode it all (lossy replacement).
            return len;
        }
        if b >= 0xC0 {
            // Lead byte: hold it back when its sequence is still incomplete.
            let need = if b >= 0xF0 {
                4
            } else if b >= 0xE0 {
                3
            } else {
                2
            };
            return if i + need > len { i } else { len };
        }
        // Continuation byte — keep scanning backwards.
    }
    len
}

impl Utf8StreamDecoder {
    /// `decoder.decode(value, { stream: true })`.
    fn decode_stream(&mut self, chunk: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        let split = incomplete_suffix_start(&buf);
        self.carry = buf[split..].to_vec();
        String::from_utf8_lossy(&buf[..split]).into_owned()
    }

    /// `decoder.decode()` — flush: an incomplete trailing sequence becomes
    /// replacement characters.
    fn flush(&mut self) -> String {
        let rest = std::mem::take(&mut self.carry);
        String::from_utf8_lossy(&rest).into_owned()
    }
}

// ---------------------------------------------------------------------------
// OrderedMap — JS `Map` semantics (insertion-order iteration, in-place update
// on re-set, order-preserving delete). serde_json's preserve_order Map uses
// swap_remove on delete, which would corrupt iteration order — so the parser
// state uses this tiny Vec-backed map instead.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct OrderedMap<K, V> {
    entries: Vec<(K, V)>,
}

impl<K: PartialEq, V> OrderedMap<K, V> {
    fn new() -> Self {
        Self { entries: Vec::new() }
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.entries.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// JS `map.set(key, value)`: update in place keeping position, else append.
    fn set(&mut self, key: K, value: V) {
        if let Some(existing) = self.get_mut(&key) {
            *existing = value;
        } else {
            self.entries.push((key, value));
        }
    }

    /// JS `map.delete(key)`: order of remaining entries preserved.
    fn remove(&mut self, key: &K) {
        if let Some(pos) = self.entries.iter().position(|(k, _)| k == key) {
            self.entries.remove(pos);
        }
    }

    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn iter(&self) -> std::slice::Iter<'_, (K, V)> {
        self.entries.iter()
    }
}

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

type JsonMap = Map<String, Value>;

struct ParsedResponseState {
    final_response: Option<JsonMap>,
    last_phase: Option<String>,
    output_items: OrderedMap<usize, JsonMap>,
    output_text: OrderedMap<String, String>,
    output_text_phases: OrderedMap<String, String>,
    phase_text_segments: OrderedMap<String, String>,
    phase_segment_order: OrderedMap<String, Vec<String>>,
    phase_text: OrderedMap<String, String>,
    reasoning_summary_text: OrderedMap<String, String>,
    seen_response_ids: HashSet<String>,
    encountered_error: bool,
}

fn create_parsed_response_state() -> ParsedResponseState {
    ParsedResponseState {
        final_response: None,
        last_phase: None,
        output_items: OrderedMap::new(),
        output_text: OrderedMap::new(),
        output_text_phases: OrderedMap::new(),
        phase_text_segments: OrderedMap::new(),
        phase_segment_order: OrderedMap::new(),
        phase_text: OrderedMap::new(),
        reasoning_summary_text: OrderedMap::new(),
        seen_response_ids: HashSet::new(),
        encountered_error: false,
    }
}

fn to_mutable_record(value: Option<&Value>) -> Option<JsonMap> {
    match value {
        Some(Value::Object(map)) => Some(map.clone()),
        _ => None,
    }
}

fn get_number_field(record: &JsonMap, key: &str) -> Option<f64> {
    record.get(key).and_then(Value::as_f64).filter(|v| v.is_finite())
}

/// Trimmed, non-empty string field for identifier-like values.
/// Returns the ORIGINAL (untrimmed) string, matching TS `getStringField`.
fn get_string_field(record: &JsonMap, key: &str) -> Option<String> {
    match record.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// Non-empty string field where whitespace is meaningful (TS `getDeltaField`).
fn get_delta_field(record: &JsonMap, key: &str) -> Option<String> {
    match record.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// TS `isValidSynthesizedIndex`: finite integer in `[0, 255]`.
fn valid_synth_index(index: Option<f64>) -> Option<usize> {
    let v = index?;
    if v.is_finite() && v.fract() == 0.0 && (0.0..=MAX_SYNTHESIZED_EVENT_INDEX as f64).contains(&v) {
        Some(v as usize)
    } else {
        None
    }
}

fn clone_content_array(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| is_record(item))
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

/// TS `mergeRecord` — JS spread semantics: base keys keep their positions,
/// update values overwrite in place, new update keys append; `content` arrays
/// prefer the update's content when non-empty (or when base lacks content),
/// else the base's cloned content.
fn merge_record(base: Option<&JsonMap>, update: &JsonMap) -> JsonMap {
    let Some(base) = base else {
        return update.clone();
    };
    let mut merged = base.clone();
    for (key, value) in update {
        merged.insert(key.clone(), value.clone());
    }
    if update.contains_key("content") || base.contains_key("content") {
        let update_content = clone_content_array(update.get("content"));
        let content = if !update_content.is_empty() || !base.contains_key("content") {
            update_content
        } else {
            clone_content_array(base.get("content"))
        };
        merged.insert("content".to_string(), Value::Array(content));
    }
    merged
}

fn make_output_text_key(output_index: Option<f64>, content_index: Option<f64>) -> Option<String> {
    let oi = valid_synth_index(output_index)?;
    let ci = valid_synth_index(content_index)?;
    Some(format!("{oi}:{ci}"))
}

fn make_phase_text_segment_key(phase: &str, output_text_key: &str) -> String {
    format!("{phase}\u{0000}{output_text_key}")
}

fn make_summary_key(output_index: Option<f64>, summary_index: Option<f64>) -> Option<String> {
    let oi = valid_synth_index(output_index)?;
    let si = valid_synth_index(summary_index)?;
    Some(format!("{oi}:{si}"))
}

fn get_part_text(part: Option<&Value>) -> Option<String> {
    match part {
        Some(Value::Object(map)) => get_string_field(map, "text"),
        _ => None,
    }
}

fn capture_phase(state: &mut ParsedResponseState, phase: Option<&Value>) {
    if let Some(Value::String(s)) = phase {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            state.last_phase = Some(trimmed.to_string());
        }
    }
}

fn remember_phase_segment_order(state: &mut ParsedResponseState, phase: &str, segment_key: &str) {
    if let Some(existing) = state.phase_segment_order.get(&phase.to_string())
        && existing.iter().any(|k| k == segment_key)
    {
        return;
    }
    let mut next = state
        .phase_segment_order
        .get(&phase.to_string())
        .cloned()
        .unwrap_or_default();
    next.push(segment_key.to_string());
    state.phase_segment_order.set(phase.to_string(), next);
}

fn remove_phase_segment_order(state: &mut ParsedResponseState, phase: &str, segment_key: &str) {
    let Some(existing) = state.phase_segment_order.get(&phase.to_string()) else {
        return;
    };
    let next: Vec<String> = existing.iter().filter(|k| *k != segment_key).cloned().collect();
    if next.is_empty() {
        state.phase_segment_order.remove(&phase.to_string());
        return;
    }
    state.phase_segment_order.set(phase.to_string(), next);
}

fn rebuild_phase_text(state: &mut ParsedResponseState, phase: &str) {
    let ordered_keys = state
        .phase_segment_order
        .get(&phase.to_string())
        .cloned()
        .unwrap_or_default();
    let text: String = ordered_keys
        .iter()
        .filter_map(|key| state.phase_text_segments.get(key))
        .filter(|value| !value.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        state.phase_text.remove(&phase.to_string());
        return;
    }
    state.phase_text.set(phase.to_string(), text);
}

fn normalize_phase_for_key(
    state: &ParsedResponseState,
    phase: Option<&Value>,
    output_text_key: &str,
) -> Option<String> {
    match phase {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => state.output_text_phases.get(&output_text_key.to_string()).cloned(),
    }
}

fn set_phase_text_segment(
    state: &mut ParsedResponseState,
    phase: Option<&Value>,
    output_text_key: &str,
    text: Option<&str>,
) {
    let Some(normalized_phase) = normalize_phase_for_key(state, phase, output_text_key) else {
        return;
    };
    state
        .output_text_phases
        .set(output_text_key.to_string(), normalized_phase.clone());
    state.last_phase = Some(normalized_phase.clone());
    let segment_key = make_phase_text_segment_key(&normalized_phase, output_text_key);
    match text {
        None | Some("") => {
            state.phase_text_segments.remove(&segment_key);
            remove_phase_segment_order(state, &normalized_phase, &segment_key);
            rebuild_phase_text(state, &normalized_phase);
        }
        Some(text) => {
            remember_phase_segment_order(state, &normalized_phase, &segment_key);
            state.phase_text_segments.set(segment_key, text.to_string());
            rebuild_phase_text(state, &normalized_phase);
        }
    }
}

fn append_phase_text_segment(
    state: &mut ParsedResponseState,
    phase: Option<&Value>,
    output_text_key: &str,
    delta: Option<&str>,
) {
    let Some(delta) = delta else {
        return;
    };
    if delta.is_empty() {
        return;
    }
    let Some(normalized_phase) = normalize_phase_for_key(state, phase, output_text_key) else {
        return;
    };
    state
        .output_text_phases
        .set(output_text_key.to_string(), normalized_phase.clone());
    state.last_phase = Some(normalized_phase.clone());
    let segment_key = make_phase_text_segment_key(&normalized_phase, output_text_key);
    remember_phase_segment_order(state, &normalized_phase, &segment_key);
    let existing = state.phase_text_segments.get(&segment_key).cloned().unwrap_or_default();
    state
        .phase_text_segments
        .set(segment_key.clone(), format!("{existing}{delta}"));
    let is_latest_segment = state
        .phase_segment_order
        .get(&normalized_phase)
        .and_then(|order| order.last())
        .is_some_and(|last| last == &segment_key);
    if is_latest_segment {
        let existing_phase_text = state
            .phase_text
            .get(&normalized_phase)
            .cloned()
            .unwrap_or_default();
        state
            .phase_text
            .set(normalized_phase, format!("{existing_phase_text}{delta}"));
        return;
    }
    rebuild_phase_text(state, &normalized_phase);
}

fn upsert_output_item(state: &mut ParsedResponseState, output_index: Option<f64>, item: Option<&Value>) {
    let Some(index) = valid_synth_index(output_index) else {
        return;
    };
    let Some(item_map) = to_mutable_record(item) else {
        return;
    };
    let current = state.output_items.get(&index).cloned();
    let merged = merge_record(current.as_ref(), &item_map);
    let phase = merged.get("phase").cloned();
    state.output_items.set(index, merged);
    capture_phase(state, phase.as_ref());
}

fn set_output_text_value(
    state: &mut ParsedResponseState,
    output_index: Option<f64>,
    content_index: Option<f64>,
    text: Option<String>,
    phase: Option<&Value>,
) {
    let Some(key) = make_output_text_key(output_index, content_index) else {
        return;
    };
    match text {
        None => {
            state.output_text.remove(&key);
            set_phase_text_segment(state, phase, &key, None);
        }
        Some(text) => {
            state.output_text.set(key.clone(), text.clone());
            set_phase_text_segment(state, phase, &key, Some(&text));
        }
    }
}

fn append_output_text_value(
    state: &mut ParsedResponseState,
    output_index: Option<f64>,
    content_index: Option<f64>,
    delta: Option<String>,
    phase: Option<&Value>,
) {
    let Some(delta) = delta else {
        return;
    };
    let Some(key) = make_output_text_key(output_index, content_index) else {
        return;
    };
    let existing = state.output_text.get(&key).cloned().unwrap_or_default();
    state.output_text.set(key.clone(), format!("{existing}{delta}"));
    append_phase_text_segment(state, phase, &key, Some(&delta));
}

fn set_reasoning_summary_value(
    state: &mut ParsedResponseState,
    output_index: Option<f64>,
    summary_index: Option<f64>,
    text: Option<String>,
) {
    let Some(key) = make_summary_key(output_index, summary_index) else {
        return;
    };
    match text {
        None => state.reasoning_summary_text.remove(&key),
        Some(text) => state.reasoning_summary_text.set(key, text),
    }
}

fn append_reasoning_summary_value(
    state: &mut ParsedResponseState,
    output_index: Option<f64>,
    summary_index: Option<f64>,
    delta: Option<String>,
) {
    let Some(delta) = delta else {
        return;
    };
    let Some(key) = make_summary_key(output_index, summary_index) else {
        return;
    };
    let existing = state.reasoning_summary_text.get(&key).cloned().unwrap_or_default();
    state.reasoning_summary_text.set(key, format!("{existing}{delta}"));
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

fn ensure_output_item_at_index(output: &mut Vec<Value>, index: usize) -> bool {
    if index > MAX_SYNTHESIZED_EVENT_INDEX {
        return false;
    }
    while output.len() <= index {
        output.push(Value::Object(JsonMap::new()));
    }
    if !output[index].is_object() {
        output[index] = Value::Object(JsonMap::new());
    }
    true
}

/// Pad/normalize `item.content` so `content[index]` is a record; returns
/// whether the slot is usable. The caller re-borrows the part afterwards.
fn ensure_content_part_at_index(item: &mut JsonMap, index: usize) -> bool {
    if index > MAX_SYNTHESIZED_EVENT_INDEX {
        return false;
    }
    let mut content: Vec<Value> = match item.get("content") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    while content.len() <= index {
        content.push(Value::Object(JsonMap::new()));
    }
    if !content[index].is_object() {
        content[index] = Value::Object(JsonMap::new());
    }
    item.insert("content".to_string(), Value::Array(content));
    true
}

fn apply_accumulated_output_text(response: &mut JsonMap, state: &mut ParsedResponseState) {
    if state.output_text.is_empty() {
        return;
    }
    let mut output: Vec<Value> = match response.get("output") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };

    let entries: Vec<(String, String)> = state
        .output_text
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (key, text) in entries {
        let mut parts = key.split(':');
        let output_index = parts.next().and_then(|s| s.parse::<f64>().ok());
        let content_index = parts.next().and_then(|s| s.parse::<f64>().ok());
        let (Some(output_index), Some(content_index)) =
            (valid_synth_index(output_index), valid_synth_index(content_index))
        else {
            continue;
        };
        if !ensure_output_item_at_index(&mut output, output_index) {
            continue;
        }
        // Re-borrow the item map, prepare the content slot, then decide.
        let usable = {
            let Some(item) = output[output_index].as_object_mut() else {
                continue;
            };
            ensure_content_part_at_index(item, content_index)
        };
        if !usable {
            continue;
        }
        // Read out what we need from the part before mutating state.
        let (has_string_text, existing_text, part_phase, needs_type) = {
            let item = output[output_index].as_object_mut().expect("ensured object");
            let part = item
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .and_then(|c| c.get_mut(content_index))
                .and_then(Value::as_object_mut)
                .expect("ensured content part");
            let needs_type = get_string_field(part, "type").is_none();
            match part.get("text") {
                Some(Value::String(s)) => (true, Some(s.clone()), part.get("phase").cloned(), needs_type),
                _ => (false, None, None, needs_type),
            }
        };
        {
            let item = output[output_index].as_object_mut().expect("ensured object");
            let part = item
                .get_mut("content")
                .and_then(Value::as_array_mut)
                .and_then(|c| c.get_mut(content_index))
                .and_then(Value::as_object_mut)
                .expect("ensured content part");
            if needs_type {
                part.insert("type".to_string(), Value::String("output_text".to_string()));
            }
            if !has_string_text {
                part.insert("text".to_string(), Value::String(text.clone()));
            }
        }
        if has_string_text {
            // Existing terminal text wins; re-register it as the phase segment.
            set_phase_text_segment(state, part_phase.as_ref(), &key, existing_text.as_deref());
            continue;
        }
    }

    if !output.is_empty() {
        response.insert("output".to_string(), Value::Array(output));
    }
}

fn merge_output_items_into_response(response: &mut JsonMap, state: &ParsedResponseState) {
    if state.output_items.is_empty() {
        return;
    }
    let mut output: Vec<Value> = match response.get("output") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };

    for (output_index, item) in state.output_items.iter() {
        if *output_index > MAX_SYNTHESIZED_EVENT_INDEX {
            continue;
        }
        while output.len() <= *output_index {
            output.push(Value::Object(JsonMap::new()));
        }
        let base = match &output[*output_index] {
            Value::Object(map) => Some(map.clone()),
            _ => None,
        };
        output[*output_index] = Value::Object(merge_record(base.as_ref(), item));
    }

    response.insert("output".to_string(), Value::Array(output));
}

fn collect_message_output_text(output: &[Value]) -> String {
    output
        .iter()
        .filter_map(Value::as_object)
        .map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("message") {
                return String::new();
            }
            let content = match item.get("content") {
                Some(Value::Array(items)) => items.as_slice(),
                _ => &[],
            };
            content
                .iter()
                .filter_map(Value::as_object)
                .map(|part| {
                    if part.get("type").and_then(Value::as_str) != Some("output_text") {
                        return String::new();
                    }
                    match part.get("text") {
                        Some(Value::String(s)) => s.clone(),
                        _ => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("")
}

fn collect_reasoning_summary_text(output: &[Value]) -> String {
    output
        .iter()
        .filter_map(Value::as_object)
        .map(|item| {
            if item.get("type").and_then(Value::as_str) != Some("reasoning") {
                return String::new();
            }
            let summary = match item.get("summary") {
                Some(Value::Array(items)) => items.as_slice(),
                _ => &[],
            };
            summary
                .iter()
                .filter_map(Value::as_object)
                .map(|part| match part.get("text") {
                    Some(Value::String(s)) => s.clone(),
                    _ => String::new(),
                })
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn apply_reasoning_summaries(response: &mut JsonMap, state: &ParsedResponseState) {
    if state.reasoning_summary_text.is_empty() {
        return;
    }
    let mut output: Vec<Value> = match response.get("output") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };

    for (key, text) in state.reasoning_summary_text.iter() {
        let mut parts = key.split(':');
        let output_index = parts.next().and_then(|s| s.parse::<f64>().ok());
        let summary_index = parts.next().and_then(|s| s.parse::<f64>().ok());
        let (Some(output_index), Some(summary_index)) =
            (valid_synth_index(output_index), valid_synth_index(summary_index))
        else {
            continue;
        };
        if !ensure_output_item_at_index(&mut output, output_index) {
            continue;
        }
        let Some(item) = output[output_index].as_object_mut() else {
            continue;
        };
        let mut summary: Vec<Value> = match item.get("summary") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        while summary.len() <= summary_index {
            summary.push(Value::Object(JsonMap::new()));
        }
        let mut next_part: JsonMap = match &summary[summary_index] {
            Value::Object(map) => map.clone(),
            _ => JsonMap::new(),
        };
        if get_string_field(&next_part, "type").is_none() {
            next_part.insert("type".to_string(), Value::String("summary_text".to_string()));
        }
        if matches!(next_part.get("text"), Some(Value::String(_))) {
            // Existing terminal text wins; the local pads/type-default are
            // deliberately discarded (TS `continue` before assignment).
            continue;
        }
        next_part.insert("text".to_string(), Value::String(text.clone()));
        summary[summary_index] = Value::Object(next_part);
        item.insert("summary".to_string(), Value::Array(summary));
        if get_string_field(item, "type").is_none() {
            item.insert("type".to_string(), Value::String("reasoning".to_string()));
        }
    }

    if !output.is_empty() {
        response.insert("output".to_string(), Value::Array(output));
    }
}

fn finalize_parsed_response(state: &mut ParsedResponseState) -> Option<JsonMap> {
    let mut response = state.final_response.clone()?;
    if state.encountered_error {
        return None;
    }

    merge_output_items_into_response(&mut response, state);
    apply_accumulated_output_text(&mut response, state);
    apply_reasoning_summaries(&mut response, state);

    let output: Vec<Value> = match response.get("output") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    if !matches!(response.get("output_text"), Some(Value::String(_))) {
        let output_text = collect_message_output_text(&output);
        if !output_text.is_empty() {
            response.insert("output_text".to_string(), Value::String(output_text));
        }
    }

    let reasoning_summary_text = collect_reasoning_summary_text(&output);
    if !reasoning_summary_text.is_empty()
        && !matches!(response.get("reasoning_summary_text"), Some(Value::String(_)))
    {
        response.insert(
            "reasoning_summary_text".to_string(),
            Value::String(reasoning_summary_text),
        );
    }

    if let Some(last_phase) = &state.last_phase
        && !matches!(response.get("phase"), Some(Value::String(_)))
    {
        response.insert("phase".to_string(), Value::String(last_phase.clone()));
    }

    if !state.phase_text.is_empty() {
        let mut phase_text = JsonMap::new();
        for (phase, text) in state.phase_text.iter() {
            phase_text.insert(phase.clone(), Value::String(text.clone()));
            if phase == "commentary" {
                response.insert("commentary_text".to_string(), Value::String(text.clone()));
            }
            if phase == "final_answer" {
                response.insert("final_answer_text".to_string(), Value::String(text.clone()));
            }
        }
        response.insert("phase_text".to_string(), Value::Object(phase_text));
    }

    Some(response)
}

// ---------------------------------------------------------------------------
// Response-id capture
// ---------------------------------------------------------------------------

fn extract_response_id(response: Option<&Value>) -> Option<String> {
    let map = response?.as_object()?;
    match map.get("id") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

fn notify_response_id(
    state: &mut ParsedResponseState,
    on_response_id: Option<&ResponseIdCallback>,
    response: Option<&Value>,
) {
    let Some(response_id) = extract_response_id(response) else {
        return;
    };
    let Some(on_response_id) = on_response_id else {
        return;
    };
    if state.seen_response_ids.contains(&response_id) {
        return;
    }
    state.seen_response_ids.insert(response_id.clone());
    on_response_id(&response_id);
}

fn truncate_diagnostic_text(value: Option<&Value>, max_length: usize) -> Option<String> {
    let Some(Value::String(s)) = value else {
        return None;
    };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > max_length {
        let cut: String = trimmed.chars().take(max_length).collect();
        Some(format!("{cut}..."))
    } else {
        Some(trimmed.to_string())
    }
}

fn log_stream_diagnostics(final_response: &JsonMap) {
    if !logging_enabled() {
        return;
    }
    let response_id = extract_response_id(Some(&Value::Object(final_response.clone())));
    let phase = get_string_field(final_response, "phase");
    let commentary_text = truncate_diagnostic_text(final_response.get("commentary_text"), 400);
    let final_answer_text = truncate_diagnostic_text(final_response.get("final_answer_text"), 400);
    let reasoning_summary_text =
        truncate_diagnostic_text(final_response.get("reasoning_summary_text"), 400);
    if phase.is_some()
        || commentary_text.is_some()
        || final_answer_text.is_some()
        || reasoning_summary_text.is_some()
    {
        let mut data = JsonMap::new();
        if let Some(v) = response_id {
            data.insert("responseId".to_string(), Value::String(v));
        }
        if let Some(v) = phase {
            data.insert("phase".to_string(), Value::String(v));
        }
        if let Some(v) = commentary_text {
            data.insert("commentaryText".to_string(), Value::String(v));
        }
        if let Some(v) = final_answer_text {
            data.insert("finalAnswerText".to_string(), Value::String(v));
        }
        if let Some(v) = reasoning_summary_text {
            data.insert("reasoningSummaryText".to_string(), Value::String(v));
        }
        log_request("stream-diagnostics", &data);
    }
}

// ---------------------------------------------------------------------------
// Event state machine
// ---------------------------------------------------------------------------

fn maybe_capture_response_event(
    state: &mut ParsedResponseState,
    data: &Value,
    on_response_id: Option<&ResponseIdCallback>,
) {
    let event_type = data.get("type").and_then(Value::as_str).unwrap_or("");

    if event_type == "error" {
        log().error("SSE error event received", Some(&serde_json::json!({ "error": data })));
        state.encountered_error = true;
        return;
    }

    // response.failed is a genuine terminal failure: the turn did not produce
    // a usable result even though HTTP opened 200 (stress audit H7).
    if event_type == "response.failed" {
        log().warn(
            "SSE terminal failure event received",
            Some(&serde_json::json!({ "type": event_type })),
        );
        state.encountered_error = true;
        return;
    }

    // response.completed / response.done / response.incomplete are all
    // terminal SUCCESS envelopes. response.incomplete (max_output_tokens /
    // content filter) is a NORMAL early stop whose partial output is the
    // answer (re-audit correction to H7).
    if event_type == "response.done"
        || event_type == "response.completed"
        || event_type == "response.incomplete"
    {
        if let Some(Value::Object(response)) = data.get("response") {
            state.final_response = Some(response.clone());
        }
        notify_response_id(state, on_response_id, data.get("response"));
        return;
    }

    let Some(event_record) = data.as_object() else {
        return;
    };
    let output_index = get_number_field(event_record, "output_index");

    if event_type == "response.output_item.added" || event_type == "response.output_item.done" {
        upsert_output_item(state, output_index, event_record.get("item"));
        return;
    }

    if event_type == "response.output_text.delta" {
        append_output_text_value(
            state,
            output_index,
            get_number_field(event_record, "content_index"),
            get_delta_field(event_record, "delta"),
            event_record.get("phase"),
        );
        return;
    }

    if event_type == "response.output_text.done" {
        set_output_text_value(
            state,
            output_index,
            get_number_field(event_record, "content_index"),
            get_string_field(event_record, "text"),
            event_record.get("phase"),
        );
        return;
    }

    if event_type == "response.content_part.added" || event_type == "response.content_part.done" {
        let part = to_mutable_record(event_record.get("part"));
        match part {
            Some(part) if get_string_field(&part, "type").as_deref() == Some("output_text") => {
                let text = get_part_text(Some(&Value::Object(part.clone())));
                let phase = part.get("phase").cloned();
                set_output_text_value(
                    state,
                    output_index,
                    get_number_field(event_record, "content_index"),
                    text,
                    phase.as_ref(),
                );
            }
            Some(part) => {
                let phase = part.get("phase").cloned();
                capture_phase(state, phase.as_ref());
            }
            None => {
                capture_phase(state, None);
            }
        }
        return;
    }

    if event_type == "response.reasoning_summary_text.delta" {
        append_reasoning_summary_value(
            state,
            output_index,
            get_number_field(event_record, "summary_index"),
            get_delta_field(event_record, "delta"),
        );
        return;
    }

    if event_type == "response.reasoning_summary_text.done" {
        set_reasoning_summary_value(
            state,
            output_index,
            get_number_field(event_record, "summary_index"),
            get_string_field(event_record, "text"),
        );
        return;
    }

    if event_type == "response.reasoning_summary_part.added"
        || event_type == "response.reasoning_summary_part.done"
    {
        set_reasoning_summary_value(
            state,
            output_index,
            get_number_field(event_record, "summary_index"),
            get_part_text(event_record.get("part")),
        );
        return;
    }

    capture_phase(state, event_record.get("phase"));
}

// ---------------------------------------------------------------------------
// SSE line parsing
// ---------------------------------------------------------------------------

/// Parse a complete SSE stream text, extracting the final response.
/// Returns `(final_response, encountered_error)`.
fn parse_sse_stream(
    sse_text: &str,
    on_response_id: Option<&ResponseIdCallback>,
) -> (Option<JsonMap>, bool) {
    let mut state = create_parsed_response_state();

    let mut malformed_chunk_count: u64 = 0;
    let mut first_malformed_sample: Option<String> = None;
    for line in sse_text.split('\n') {
        let trimmed_line = line.trim();
        // Accept "data:" with or without the optional trailing space. The SSE
        // spec allows "data:value"; requiring the space silently dropped every
        // event on an upstream/proxy formatting change (stress audit M1).
        if let Some(rest) = trimmed_line.strip_prefix("data:") {
            let payload = rest.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let mut malformed_reason: Option<String> = None;
            match serde_json::from_str::<Value>(payload) {
                // JSON `null` payload: TS throws `TypeError` on `data.type`
                // inside the same try block, so it counts as malformed.
                Ok(Value::Null) => {
                    malformed_reason =
                        Some("Cannot read properties of null (reading 'type')".to_string());
                }
                Ok(data) => {
                    maybe_capture_response_event(&mut state, &data, on_response_id);
                    if state.encountered_error {
                        return (None, true);
                    }
                }
                Err(error) => {
                    malformed_reason = Some(error.to_string());
                }
            }
            if let Some(reason) = malformed_reason {
                // AUDIT-H9 / H-03: surface a structured warn with bounded
                // context (first 120 chars + error message) and a running
                // tally instead of silently discarding.
                malformed_chunk_count += 1;
                if first_malformed_sample.is_none() {
                    first_malformed_sample = Some(payload.chars().take(120).collect());
                }
                if malformed_chunk_count == 1 {
                    log().warn(
                        "SSE malformed JSON chunk discarded",
                        Some(&serde_json::json!({
                            "reason": reason,
                            "sample": first_malformed_sample,
                        })),
                    );
                }
            }
        }
    }

    if malformed_chunk_count > 1 {
        log().warn(
            "SSE malformed JSON chunks discarded (rollup)",
            Some(&serde_json::json!({
                "totalCount": malformed_chunk_count,
                "firstSample": first_malformed_sample,
            })),
        );
    }

    let encountered_error = state.encountered_error;
    (finalize_parsed_response(&mut state), encountered_error)
}

// ---------------------------------------------------------------------------
// convertSseToJson
// ---------------------------------------------------------------------------

/// Options for [`convert_sse_to_json`].
#[derive(Clone, Default)]
pub struct ConvertSseOptions {
    pub on_response_id: Option<ResponseIdCallback>,
    pub stream_stall_timeout_ms: Option<f64>,
}

impl std::fmt::Debug for ConvertSseOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConvertSseOptions")
            .field("on_response_id", &self.on_response_id.as_ref().map(|_| "<callback>"))
            .field("stream_stall_timeout_ms", &self.stream_stall_timeout_ms)
            .finish()
    }
}

/// Convert an SSE stream response to a JSON response for non-streaming
/// callers (TS `convertSseToJson`).
///
/// - No body ⇒ `Err("[codex-multi-auth] Response has no body")`.
/// - Terminal failure event ⇒ synthetic non-2xx (`sse_terminal_error`).
/// - No terminal event, no error ⇒ the raw SSE text at the ORIGINAL status
///   (preserves the caller's empty-response retry path).
/// - Success ⇒ compact JSON of the reconstructed final response at the
///   original status with `content-type: application/json; charset=utf-8`.
pub async fn convert_sse_to_json(
    mut response: StreamResponse,
    headers: &HeaderMap,
    options: ConvertSseOptions,
) -> Result<StreamResponse, BoxError> {
    let Some(mut body) = response.body.take() else {
        return Err(format!("[{PLUGIN_NAME}] Response has no body").into());
    };

    let stream_stall_timeout_ms = options
        .stream_stall_timeout_ms
        .unwrap_or(DEFAULT_STREAM_STALL_TIMEOUT_MS)
        .floor()
        .max(1_000.0) as u64;

    // REQ-HIGH-03: accumulate decoded chunks in a Vec (O(n) total), with the
    // size check BEFORE appending so peak memory is bounded to the cap.
    let result: Result<StreamResponse, BoxError> = async {
        let mut decoder = Utf8StreamDecoder::default();
        let mut chunks: Vec<String> = Vec::new();
        let mut total_size: usize = 0;

        loop {
            let read = tokio::time::timeout(
                std::time::Duration::from_millis(stream_stall_timeout_ms),
                body.next(),
            )
            .await;
            let item = match read {
                Ok(item) => item,
                Err(_) => {
                    return Err(format!(
                        "SSE stream stalled for {stream_stall_timeout_ms}ms while waiting for a terminal response event"
                    )
                    .into());
                }
            };
            match item {
                None => break,
                Some(Err(error)) => return Err(error),
                Some(Ok(chunk)) => {
                    let decoded = decoder.decode_stream(&chunk);
                    let decoded_bytes = decoded.len();
                    // Pre-append size check: reject before retaining the chunk
                    // alongside the accumulated buffer.
                    if total_size + decoded_bytes > MAX_SSE_SIZE {
                        return Err(format!("SSE response exceeds {MAX_SSE_SIZE} bytes limit").into());
                    }
                    chunks.push(decoded);
                    total_size += decoded_bytes;
                }
            }
        }

        let full_text = chunks.concat();

        if logging_enabled() {
            let mut data = JsonMap::new();
            data.insert("fullContent".to_string(), Value::String(full_text.clone()));
            log_request("stream-full", &data);
        }

        let (final_response, encountered_error) =
            parse_sse_stream(&full_text, options.on_response_id.as_ref());

        // A terminal failure event means the upstream turn failed even though
        // HTTP opened 200. Returning the raw SSE at 200 here would make the
        // proxy record an account success and skip rotation/retry (H6+H7).
        if encountered_error {
            log().warn("SSE stream ended with a terminal failure event", None);
            let mut data = JsonMap::new();
            data.insert(
                "error".to_string(),
                Value::String(
                    "SSE stream terminated with an error/failed/incomplete event".to_string(),
                ),
            );
            log_request("stream-error", &data);
            let upstream_failed = response.status >= 400;
            let status = if upstream_failed { response.status } else { HTTP_STATUS.bad_gateway };
            let status_text = if upstream_failed {
                response.status_text.clone()
            } else {
                "Bad Gateway".to_string()
            };
            let mut error_headers = headers.clone();
            error_headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            let payload = serde_json::json!({
                "error": {
                    "message": "Upstream SSE stream terminated with a failure event",
                    "type": "upstream_stream_error",
                    "code": "sse_terminal_error"
                }
            });
            return Ok(StreamResponse::from_text(
                status,
                status_text,
                error_headers,
                stringify_compact(&payload),
            ));
        }

        let Some(final_response) = final_response else {
            log().warn("Could not find final response in SSE stream", None);
            let mut data = JsonMap::new();
            data.insert(
                "error".to_string(),
                Value::String("No terminal response event found in SSE stream".to_string()),
            );
            log_request("stream-error", &data);
            // Return original stream if we can't parse (no error event, just
            // no terminal response). Preserves the empty-response retry path.
            return Ok(StreamResponse::from_text(
                response.status,
                response.status_text.clone(),
                headers.clone(),
                full_text,
            ));
        };

        log_stream_diagnostics(&final_response);

        let mut json_headers = headers.clone();
        json_headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );

        Ok(StreamResponse::from_text(
            response.status,
            response.status_text.clone(),
            json_headers,
            stringify_compact(&Value::Object(final_response)),
        ))
    }
    .await;

    if let Err(error) = &result {
        log().error(
            "Error converting stream",
            Some(&serde_json::json!({ "error": error.to_string() })),
        );
        let mut data = JsonMap::new();
        data.insert("error".to_string(), Value::String(error.to_string()));
        log_request("stream-error", &data);
        // Reader cancel + lock release: dropping the stream is the analogue.
        drop(body);
    }
    result
}

// ---------------------------------------------------------------------------
// ensureContentType / isEmptyResponse / attachResponseIdCapture
// ---------------------------------------------------------------------------

/// Copy the headers, setting `content-type: text/event-stream; charset=utf-8`
/// only when absent (TS `ensureContentType`). Never mutates the input.
pub fn ensure_content_type(headers: &HeaderMap) -> HeaderMap {
    let mut response_headers = headers.clone();
    if !response_headers.contains_key(CONTENT_TYPE) {
        response_headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream; charset=utf-8"),
        );
    }
    response_headers
}

/// Check whether a parsed (non-streaming) response body is empty/malformed
/// (TS `isEmptyResponse`). `None` models JS `undefined`.
///
/// Objects are only treated as potentially-empty when they carry
/// `id`/`object`/`model`; a bare `{"foo":1}` object is NOT empty.
pub fn is_empty_response(body: Option<&Value>) -> bool {
    let Some(body) = body else {
        return true;
    };
    match body {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Bool(_) | Value::Number(_) => false,
        // JS `typeof [] === "object"`: empty array has zero keys ⇒ empty;
        // a non-empty array has index keys and no id/object/model ⇒ not empty.
        Value::Array(items) => items.is_empty(),
        Value::Object(obj) => {
            if obj.is_empty() {
                return true;
            }

            let has_output = match obj.get("output") {
                None | Some(Value::Null) => false,
                Some(Value::Array(items)) => items.iter().any(|o| match o {
                    Value::Null => false,
                    Value::Object(map) => !map.is_empty(),
                    Value::Array(arr) => !arr.is_empty(),
                    _ => true,
                }),
                Some(Value::String(s)) => !s.trim().is_empty(),
                Some(_) => true,
            };
            let has_choices = match obj.get("choices") {
                Some(Value::Array(items)) => items.iter().any(|c| match c {
                    Value::Object(map) => !map.is_empty(),
                    Value::Array(arr) => !arr.is_empty(),
                    _ => false,
                }),
                _ => false,
            };
            let has_content = match obj.get("content") {
                None | Some(Value::Null) => false,
                Some(Value::String(s)) => !s.trim().is_empty(),
                Some(_) => true,
            };

            if obj.contains_key("id") || obj.contains_key("object") || obj.contains_key("model") {
                return !has_output && !has_choices && !has_content;
            }

            false
        }
    }
}

struct CaptureStreamState {
    inner: BodyStream,
    decoder: Utf8StreamDecoder,
    buffered_text: String,
    logged_malformed_stream_chunk: bool,
    parse_state: ParsedResponseState,
    on_response_id: ResponseIdCallback,
}

impl CaptureStreamState {
    fn process_buffered_lines(&mut self, flush: bool) {
        if self.parse_state.encountered_error {
            return;
        }
        let buffered = std::mem::take(&mut self.buffered_text);
        let mut lines: Vec<&str> = buffered.split('\n').collect();
        if !flush {
            self.buffered_text = lines.pop().unwrap_or("").to_string();
        }

        for raw_line in lines {
            let trimmed_line = raw_line.trim();
            let Some(rest) = trimmed_line.strip_prefix("data:") else {
                continue;
            };
            let payload = rest.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let mut malformed_reason: Option<String> = None;
            match serde_json::from_str::<Value>(payload) {
                Ok(Value::Null) => {
                    malformed_reason =
                        Some("Cannot read properties of null (reading 'type')".to_string());
                }
                Ok(data) => {
                    maybe_capture_response_event(
                        &mut self.parse_state,
                        &data,
                        Some(&self.on_response_id),
                    );
                    if self.parse_state.encountered_error {
                        break;
                    }
                }
                Err(error) => {
                    malformed_reason = Some(error.to_string());
                }
            }
            if let Some(reason) = malformed_reason {
                // AUDIT-H9 / H-03: raw bytes still reach the downstream
                // consumer; warn ONCE with bounded context.
                if !self.logged_malformed_stream_chunk {
                    self.logged_malformed_stream_chunk = true;
                    let sample: String = payload.chars().take(120).collect();
                    log().warn(
                        "SSE malformed JSON chunk in stream passthrough",
                        Some(&serde_json::json!({ "reason": reason, "sample": sample })),
                    );
                }
            }
        }
    }
}

fn create_response_id_capturing_stream(
    body: BodyStream,
    on_response_id: ResponseIdCallback,
) -> BodyStream {
    let state = CaptureStreamState {
        inner: body,
        decoder: Utf8StreamDecoder::default(),
        buffered_text: String::new(),
        logged_malformed_stream_chunk: false,
        parse_state: create_parsed_response_state(),
        on_response_id,
    };
    futures::stream::unfold(state, |mut st| async move {
        match st.inner.next().await {
            Some(Ok(chunk)) => {
                let decoded = st.decoder.decode_stream(&chunk);
                st.buffered_text.push_str(&decoded);
                st.process_buffered_lines(false);
                // Re-enqueue the chunk unmodified: bytes always flow through.
                Some((Ok(chunk), st))
            }
            Some(Err(error)) => Some((Err(error), st)),
            None => {
                let flushed = st.decoder.flush();
                st.buffered_text.push_str(&flushed);
                st.process_buffered_lines(true);
                None
            }
        }
    })
    .boxed()
}

/// Pipe the response body through a transform that sniffs SSE events for the
/// final response id, re-emitting every byte unmodified
/// (TS `attachResponseIdCapture`). Without a body or callback, the body is
/// simply re-wrapped with the given headers.
pub fn attach_response_id_capture(
    mut response: StreamResponse,
    headers: HeaderMap,
    on_response_id: Option<ResponseIdCallback>,
) -> StreamResponse {
    let body = response.body.take();
    match (body, on_response_id) {
        (Some(body), Some(on_response_id)) => StreamResponse::new(
            response.status,
            response.status_text.clone(),
            headers,
            Some(create_response_id_capturing_stream(body, on_response_id)),
        ),
        (body, _) => StreamResponse::new(response.status, response.status_text.clone(), headers, body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_decoder_carries_incomplete_sequences_across_chunks() {
        let mut decoder = Utf8StreamDecoder::default();
        let emoji = "😀".as_bytes(); // 4 bytes
        let first = decoder.decode_stream(&emoji[..2]);
        assert_eq!(first, "");
        let second = decoder.decode_stream(&emoji[2..]);
        assert_eq!(second, "😀");
        assert_eq!(decoder.flush(), "");
    }

    #[test]
    fn utf8_decoder_flush_replaces_incomplete_tail() {
        let mut decoder = Utf8StreamDecoder::default();
        let emoji = "😀".as_bytes();
        assert_eq!(decoder.decode_stream(&emoji[..2]), "");
        assert_eq!(decoder.flush(), "\u{FFFD}");
    }

    #[test]
    fn utf8_decoder_ascii_passthrough_counts_bytes() {
        let mut decoder = Utf8StreamDecoder::default();
        let decoded = decoder.decode_stream(b"data: hello\n");
        assert_eq!(decoded, "data: hello\n");
        assert_eq!(decoded.len(), 12);
    }

    #[test]
    fn ordered_map_preserves_insertion_order_on_update_and_delete() {
        let mut map: OrderedMap<String, i32> = OrderedMap::new();
        map.set("a".into(), 1);
        map.set("b".into(), 2);
        map.set("c".into(), 3);
        map.set("a".into(), 10); // in-place update keeps position
        map.remove(&"b".to_string());
        let keys: Vec<&str> = map.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["a", "c"]);
        assert_eq!(map.get(&"a".to_string()), Some(&10));
    }

    #[test]
    fn synthetic_terminal_error_body_is_byte_exact() {
        let payload = serde_json::json!({
            "error": {
                "message": "Upstream SSE stream terminated with a failure event",
                "type": "upstream_stream_error",
                "code": "sse_terminal_error"
            }
        });
        assert_eq!(
            stringify_compact(&payload),
            r#"{"error":{"message":"Upstream SSE stream terminated with a failure event","type":"upstream_stream_error","code":"sse_terminal_error"}}"#
        );
    }

    #[test]
    fn merge_record_prefers_nonempty_update_content() {
        let base: JsonMap = serde_json::from_str(r#"{"id":"x","content":[{"type":"a"}]}"#).unwrap();
        let update: JsonMap = serde_json::from_str(r#"{"content":[]}"#).unwrap();
        // Update's empty content loses; base's cloned content wins.
        let merged = merge_record(Some(&base), &update);
        assert_eq!(
            merged.get("content").unwrap(),
            &serde_json::json!([{ "type": "a" }])
        );
        // Non-empty update content wins.
        let update2: JsonMap = serde_json::from_str(r#"{"content":[{"type":"b"}]}"#).unwrap();
        let merged2 = merge_record(Some(&base), &update2);
        assert_eq!(
            merged2.get("content").unwrap(),
            &serde_json::json!([{ "type": "b" }])
        );
    }

    #[test]
    fn valid_synth_index_bounds() {
        assert_eq!(valid_synth_index(Some(0.0)), Some(0));
        assert_eq!(valid_synth_index(Some(255.0)), Some(255));
        assert_eq!(valid_synth_index(Some(256.0)), None);
        assert_eq!(valid_synth_index(Some(-1.0)), None);
        assert_eq!(valid_synth_index(Some(1.5)), None);
        assert_eq!(valid_synth_index(None), None);
    }
}
