//! Port of `lib/quota-probe.ts` — a live (cheap) streaming POST against the
//! Codex backend that parses `x-codex-*` response headers into a
//! [`CodexQuotaSnapshot`].
//!
//! Contracts (spec 05 §2 + gotchas 12/13/14):
//! - Models are probed SEQUENTIALLY over the 6-model chain (Sol first).
//! - A response with quota headers produces a snapshot on ANY status —
//!   a 429 with headers still parses (status recorded verbatim).
//! - Unsupported-model errors continue down the chain; when EVERY attempted
//!   model was unsupported (and nothing else failed) the probe fails with a
//!   `CodexUnavailableError` rendered as
//!   `"Codex not available for this account"` (issue #501).
//! - Reasoning effort is model-dependent (`low` for 5.6/codex tiers, `none`
//!   for pre-5.6 general models — issue #627).
//! - Every model attempt increments the diagnostic-probe observability
//!   counters (both snapshot top-level and `runtimeMetrics`); the TS calls
//!   `mutateRuntimeObservabilitySnapshot` directly, but that module lives in
//!   `cma-runtime` ABOVE this crate, so the Rust port exposes a hook seam
//!   ([`set_probe_observability_hook`]) that `cma-runtime` registers.

use std::sync::{Arc, RwLock};

use chrono::TimeZone;
use cma_core::constants::CODEX_BASE_URL;
use cma_core::errors::CodexError;
use cma_core::json_io::stringify_compact;
use cma_core::utils::{is_record, now_ms};
use cma_request::error_classification::get_unsupported_codex_model_info;
use cma_request::fetch_helpers::shared_client;
use cma_request::headers::{CreateCodexHeadersOptions, create_codex_headers_positional};
use cma_request::model_map::{QUOTA_PROBE_MODEL_CHAIN, resolve_probe_reasoning_effort};
use cma_request::prompts::codex::get_codex_instructions;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::{Value, json};

/// Human-readable note shown when a live probe fails solely because the
/// account lacks Codex entitlement (see `CodexUnavailableError`). Centralized
/// so every check/forecast/repair surface renders the same wording instead of
/// leaking the raw upstream "model is not supported..." message (issue #501).
pub const CODEX_UNAVAILABLE_PROBE_NOTE: &str = "Codex not available for this account";

/// TS `describeCodexProbeFailure(error, normalize?)` — the friendly note for
/// `CodexUnavailableError` (matched by CODE, cross-realm safe); otherwise the
/// (optionally normalized) raw message.
pub fn describe_codex_probe_failure(
    error: &CodexError,
    normalize: Option<&dyn Fn(&str) -> String>,
) -> String {
    if error.is_codex_unavailable() {
        return CODEX_UNAVAILABLE_PROBE_NOTE.to_string();
    }
    let raw = error.message();
    match normalize {
        Some(normalize) => normalize(raw),
        None => raw.to_string(),
    }
}

/// TS `CodexQuotaWindow` — parsed from response headers: `usedPercent` is a
/// float (fractional percentages are expected and significant),
/// `windowMinutes` a `parseInt` integer, `resetAtMs` an absolute epoch-ms
/// timestamp.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct CodexQuotaWindow {
    #[serde(rename = "usedPercent", skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(rename = "windowMinutes", skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<i64>,
    #[serde(rename = "resetAtMs", skip_serializing_if = "Option::is_none")]
    pub reset_at_ms: Option<i64>,
}

/// TS `CodexQuotaSnapshot`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CodexQuotaSnapshot {
    pub status: u16,
    #[serde(rename = "planType", skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    #[serde(rename = "activeLimit", skip_serializing_if = "Option::is_none")]
    pub active_limit: Option<i64>,
    pub primary: CodexQuotaWindow,
    pub secondary: CodexQuotaWindow,
    pub model: String,
}

/// TS `ProbeCodexQuotaOptions`.
#[derive(Clone, Debug, Default)]
pub struct ProbeCodexQuotaOptions {
    pub account_id: String,
    pub access_token: String,
    /// Preferred model to try first (prepended to the fallback chain).
    pub model: Option<String>,
    /// Fallback models; `None` = [`QUOTA_PROBE_MODEL_CHAIN`].
    pub fallback_models: Option<Vec<String>>,
    /// Per-model timeout, clamped to `[1_000, 60_000]`; default `15_000`.
    pub timeout_ms: Option<u64>,
    /// Rust-only test seam: overrides `CODEX_BASE_URL` (the TS module
    /// hardcodes it and tests stub global `fetch`; Rust tests point this at
    /// a wiremock server instead). `None` in production.
    pub base_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Observability hook (see module docs)
// ---------------------------------------------------------------------------

type ProbeObservabilityHook = Arc<dyn Fn() + Send + Sync>;

static PROBE_OBSERVABILITY_HOOK: RwLock<Option<ProbeObservabilityHook>> = RwLock::new(None);

/// Register (or clear) the per-attempt observability hook. `cma-runtime`
/// installs a closure that increments `diagnosticProbeRequests` on BOTH the
/// snapshot top level and `runtimeMetrics` (spec 05 gotcha 14). Invoked once
/// per MODEL attempt, not per `fetch_codex_quota_snapshot` call.
pub fn set_probe_observability_hook(hook: Option<ProbeObservabilityHook>) {
    *PROBE_OBSERVABILITY_HOOK
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
}

fn note_probe_attempt() {
    let hook = PROBE_OBSERVABILITY_HOOK
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if let Some(hook) = hook {
        hook();
    }
}

// ---------------------------------------------------------------------------
// Header parsing (must be replicated exactly)
// ---------------------------------------------------------------------------

fn header_str<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// JS `Number(raw)` restricted to what quota headers realistically carry:
/// trims whitespace, accepts decimal/exponent floats; empty-after-trim is `0`
/// (JS `Number("")`/`Number(" ")` are `0`, but the callers gate on a
/// non-empty RAW value first). Non-finite results are rejected by callers.
fn js_number(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    trimmed.parse::<f64>().ok()
}

/// JS `Number.parseInt(raw, 10)` — leading whitespace skipped, optional
/// sign, maximal leading digit run, trailing garbage ignored; no digits →
/// `None` (NaN).
fn js_parse_int(raw: &str) -> Option<i64> {
    let trimmed = raw.trim_start();
    let (negative, digits_part) = match trimmed.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let digit_run: String = digits_part
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digit_run.is_empty() {
        return None;
    }
    // Saturate on overflow (JS would keep float precision; quota headers
    // never approach i64::MAX).
    let value = digit_run.parse::<i64>().unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// TS `parseFiniteNumberHeader` — missing/empty header → `None`;
/// `Number(raw)` accepted only when finite (floats allowed).
fn parse_finite_number_header(headers: &HeaderMap, name: &str) -> Option<f64> {
    let raw = header_str(headers, name)?;
    if raw.is_empty() {
        return None;
    }
    js_number(raw).filter(|parsed| parsed.is_finite())
}

/// TS `parseFiniteIntHeader` — missing/empty header → `None`;
/// `parseInt(raw, 10)` accepted when finite.
fn parse_finite_int_header(headers: &HeaderMap, name: &str) -> Option<i64> {
    let raw = header_str(headers, name)?;
    if raw.is_empty() {
        return None;
    }
    js_parse_int(raw)
}

/// The subset of JS `Date.parse` the quota `-reset-at` header can carry once
/// the all-digits fast path has been tried: RFC 3339 / ISO 8601 (with zone),
/// RFC 2822 (HTTP dates), date-only ISO (UTC midnight per ECMA-262), and
/// zone-less date-times (LOCAL time per ECMA-262).
fn js_date_parse_ms(trimmed: &str) -> Option<i64> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc2822(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        let midnight = date.and_hms_opt(0, 0, 0)?;
        return Some(chrono::Utc.from_utc_datetime(&midnight).timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, format) {
            return chrono::Local
                .from_local_datetime(&naive)
                .earliest()
                .map(|local| local.timestamp_millis());
        }
    }
    None
}

/// TS `parseResetAtMs(headers, prefix)` — `-reset-after-seconds` (relative,
/// from the CURRENT wall clock) wins; else `-reset-at` with the digit
/// heuristics: all-digit values `< 10_000_000_000` are epoch-SECONDS
/// (× 1000), larger are already ms; anything else goes through the
/// `Date.parse` ladder.
fn parse_reset_at_ms(headers: &HeaderMap, prefix: &str) -> Option<i64> {
    let reset_after_seconds =
        parse_finite_int_header(headers, &format!("{prefix}-reset-after-seconds"));
    if let Some(seconds) = reset_after_seconds
        && seconds > 0
    {
        // f64 multiply mirrors JS semantics; the `as i64` cast saturates on
        // overflow, so a hostile huge header yields a far-future resetAtMs
        // (blocked window) exactly like TS — never a wrapped negative value.
        return Some(now_ms().saturating_add((seconds as f64 * 1000.0) as i64));
    }

    let reset_at_raw = header_str(headers, &format!("{prefix}-reset-at"))?;
    if reset_at_raw.is_empty() {
        return None;
    }
    let trimmed = reset_at_raw.trim();
    if !trimmed.is_empty()
        && trimmed.chars().all(|c| c.is_ascii_digit())
        && let Some(parsed) = js_parse_int(trimmed)
        && parsed > 0
    {
        return Some(if parsed < 10_000_000_000 {
            parsed * 1000
        } else {
            parsed
        });
    }
    js_date_parse_ms(trimmed)
}

/// TS `hasCodexQuotaHeaders` — presence gate: any of the 8 quota headers
/// present (value content irrelevant, even empty).
fn has_codex_quota_headers(headers: &HeaderMap) -> bool {
    const KEYS: [&str; 8] = [
        "x-codex-primary-used-percent",
        "x-codex-primary-window-minutes",
        "x-codex-primary-reset-at",
        "x-codex-primary-reset-after-seconds",
        "x-codex-secondary-used-percent",
        "x-codex-secondary-window-minutes",
        "x-codex-secondary-reset-at",
        "x-codex-secondary-reset-after-seconds",
    ];
    KEYS.iter().any(|key| headers.contains_key(*key))
}

/// TS `parseQuotaSnapshotBase(headers, status)` — `None` when the presence
/// gate fails; the status is included verbatim (a 429 with quota headers
/// still parses). The returned snapshot's `model` is empty — the caller
/// fills it.
fn parse_quota_snapshot_base(headers: &HeaderMap, status: u16) -> Option<CodexQuotaSnapshot> {
    if !has_codex_quota_headers(headers) {
        return None;
    }

    let primary_prefix = "x-codex-primary";
    let secondary_prefix = "x-codex-secondary";
    let primary = CodexQuotaWindow {
        used_percent: parse_finite_number_header(
            headers,
            &format!("{primary_prefix}-used-percent"),
        ),
        window_minutes: parse_finite_int_header(
            headers,
            &format!("{primary_prefix}-window-minutes"),
        ),
        reset_at_ms: parse_reset_at_ms(headers, primary_prefix),
    };
    let secondary = CodexQuotaWindow {
        used_percent: parse_finite_number_header(
            headers,
            &format!("{secondary_prefix}-used-percent"),
        ),
        window_minutes: parse_finite_int_header(
            headers,
            &format!("{secondary_prefix}-window-minutes"),
        ),
        reset_at_ms: parse_reset_at_ms(headers, secondary_prefix),
    };

    let plan_type = header_str(headers, "x-codex-plan-type")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let active_limit = parse_finite_int_header(headers, "x-codex-active-limit");

    Some(CodexQuotaSnapshot {
        status,
        plan_type,
        active_limit,
        primary,
        secondary,
        model: String::new(),
    })
}

/// TS `normalizeProbeModels` — `[trim(primary), ...(fallbacks ??
/// QUOTA_PROBE_MODEL_CHAIN)]`, blanks dropped, deduped preserving first
/// occurrence.
fn normalize_probe_models(
    primary_model: Option<&str>,
    fallback_models: Option<&[String]>,
) -> Vec<String> {
    let mut merged: Vec<&str> = Vec::new();
    if let Some(primary) = primary_model {
        merged.push(primary);
    }
    match fallback_models {
        Some(fallbacks) => merged.extend(fallbacks.iter().map(String::as_str)),
        None => merged.extend(QUOTA_PROBE_MODEL_CHAIN.iter().copied()),
    }
    let mut models: Vec<String> = Vec::new();
    for model in merged {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !models.iter().any(|existing| existing == trimmed) {
            models.push(trimmed.to_string());
        }
    }
    models
}

/// TS `extractErrorMessage(bodyText, status)` — empty body → `"HTTP
/// {status}"`; JSON `error.message` string → that; top-level `message`
/// string → that; else the trimmed raw body.
fn extract_error_message(body_text: &str, status: u16) -> String {
    let trimmed = body_text.trim();
    if trimmed.is_empty() {
        return format!("HTTP {status}");
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
        && is_record(&parsed)
    {
        if let Some(message) = parsed
            .get("error")
            .filter(|error| is_record(error))
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
        {
            return message.to_string();
        }
        if let Some(message) = parsed.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }
    trimmed.to_string()
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/// TS `formatQuotaWindowLabel` — falsy/non-finite/<=0 → `"quota"`; whole
/// days → `"{d}d"`; whole hours → `"{h}h"`; else `"{m}m"`.
fn format_quota_window_label(window_minutes: Option<i64>) -> String {
    let Some(minutes) = window_minutes else {
        return "quota".to_string();
    };
    if minutes <= 0 {
        return "quota".to_string();
    }
    if minutes % 1440 == 0 {
        format!("{}d", minutes / 1440)
    } else if minutes % 60 == 0 {
        format!("{}h", minutes / 60)
    } else {
        format!("{minutes}m")
    }
}

/// TS `formatQuotaResetAt(resetAtMs, nowMs = Date.now())` — same LOCAL
/// calendar day: `"HH:MM"` (24-hour); else `"HH:MM on {Mon DD}"`. Invalid /
/// non-positive input → `None`. (The TS output is locale-dependent via
/// `toLocaleTimeString`; the Rust port pins the equivalent en-dash-free
/// `%H:%M` / `%b %d` local-time formatting per the spec note.)
pub fn format_quota_reset_at(
    reset_at_ms: Option<i64>,
    now_ms_override: Option<i64>,
) -> Option<String> {
    let reset_at = reset_at_ms?;
    if reset_at <= 0 {
        return None;
    }
    let date = chrono::Local.timestamp_millis_opt(reset_at).single()?;
    let now = chrono::Local
        .timestamp_millis_opt(now_ms_override.unwrap_or_else(now_ms))
        .single()?;

    let time = date.format("%H:%M").to_string();
    if now.date_naive() == date.date_naive() {
        return Some(time);
    }
    Some(format!("{time} on {}", date.format("%b %d")))
}

/// TS private `formatWindowSummary` — `"{label}[ {left}% left][ (resets
/// {fmt})]"`.
fn format_window_summary(label: &str, window: &CodexQuotaWindow) -> String {
    let mut summary = label.to_string();
    if let Some(used) = window.used_percent
        && used.is_finite()
    {
        let left = (100.0 - used).round().clamp(0.0, 100.0) as i64;
        summary = format!("{summary} {left}% left");
    }
    if let Some(reset) = format_quota_reset_at(window.reset_at_ms, None) {
        summary = format!("{summary} (resets {reset})");
    }
    summary
}

/// TS `formatQuotaSnapshotLine(snapshot)` — comma-joined window summaries,
/// optional `plan:{planType}` / `active:{n}`, and `"rate-limited"` iff the
/// status is 429.
pub fn format_quota_snapshot_line(snapshot: &CodexQuotaSnapshot) -> String {
    let primary_label = format_quota_window_label(snapshot.primary.window_minutes);
    let secondary_label = format_quota_window_label(snapshot.secondary.window_minutes);
    let mut parts = vec![
        format_window_summary(&primary_label, &snapshot.primary),
        format_window_summary(&secondary_label, &snapshot.secondary),
    ];
    if let Some(plan_type) = &snapshot.plan_type
        && !plan_type.is_empty()
    {
        parts.push(format!("plan:{plan_type}"));
    }
    if let Some(active_limit) = snapshot.active_limit {
        parts.push(format!("active:{active_limit}"));
    }
    if snapshot.status == 429 {
        parts.push("rate-limited".to_string());
    }
    parts.join(", ")
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/// Outcome of a single model attempt (internal).
enum ProbeAttempt {
    Snapshot(CodexQuotaSnapshot),
    /// Unsupported-model rejection — continue down the chain.
    Unsupported(String),
    /// Any other failure — continue, but the run can no longer end in
    /// `CodexUnavailableError`.
    Failure(String),
}

async fn probe_one_model(
    base_url: &str,
    account_id: &str,
    access_token: &str,
    model: &str,
    timeout_ms: u64,
) -> ProbeAttempt {
    let instructions = get_codex_instructions(Some(model)).await;
    // Send the cheapest effort each probe model actually declares (the
    // GPT-5.6 tiers and codex models do not list `none`), keeping the probe
    // consistent with normal request routing (issue #627).
    let effort = resolve_probe_reasoning_effort(Some(model));
    let probe_body = json!({
        "model": model,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
        "instructions": instructions,
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "quota ping" }],
            }
        ],
        "reasoning": { "effort": effort.as_str(), "summary": "auto" },
        "text": { "verbosity": "low" },
    });

    let mut headers = match create_codex_headers_positional(
        None,
        account_id,
        access_token,
        Some(&CreateCodexHeadersOptions {
            model: Some(model.to_string()),
            prompt_cache_key: None,
        }),
    ) {
        Ok(headers) => headers,
        Err(error) => return ProbeAttempt::Failure(error.message().to_string()),
    };
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    note_probe_attempt();
    let send = shared_client()
        .post(format!("{base_url}/codex/responses"))
        .headers(headers)
        .body(stringify_compact(&probe_body))
        .send();
    let response = match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), send)
        .await
    {
        // Node fetch abort surfaces DOMException "This operation was
        // aborted" — frozen for parity with the TS timeout path.
        Err(_elapsed) => return ProbeAttempt::Failure("This operation was aborted".to_string()),
        Ok(Err(error)) => return ProbeAttempt::Failure(error.to_string()),
        Ok(Ok(response)) => response,
    };

    let status = response.status().as_u16();
    if let Some(mut snapshot) = parse_quota_snapshot_base(response.headers(), status) {
        // Dropping the response cancels the streamed body (TS
        // `response.body?.cancel()` best effort).
        snapshot.model = model.to_string();
        return ProbeAttempt::Snapshot(snapshot);
    }

    if !response.status().is_success() {
        let body_text = response.text().await.unwrap_or_default();
        let error_body: Value = if body_text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&body_text)
                .unwrap_or_else(|_| json!({ "error": { "message": body_text } }))
        };
        let unsupported_info = get_unsupported_codex_model_info(&error_body);
        if unsupported_info.is_unsupported {
            return ProbeAttempt::Unsupported(
                unsupported_info
                    .message
                    .unwrap_or_else(|| format!("Model '{model}' unsupported for this account")),
            );
        }
        return ProbeAttempt::Failure(extract_error_message(&body_text, status));
    }

    // OK but no quota headers.
    ProbeAttempt::Failure("Codex response did not include quota headers".to_string())
}

/// TS `fetchCodexQuotaSnapshot(options)` — probe Codex models sequentially
/// to obtain a quota snapshot for the account. See the module docs for the
/// chain/unsupported/`CodexUnavailableError` contracts.
pub async fn fetch_codex_quota_snapshot(
    options: &ProbeCodexQuotaOptions,
) -> Result<CodexQuotaSnapshot, CodexError> {
    let models =
        normalize_probe_models(options.model.as_deref(), options.fallback_models.as_deref());
    let timeout_ms = options.timeout_ms.unwrap_or(15_000).clamp(1_000, 60_000);
    let base_url = options.base_url.as_deref().unwrap_or(CODEX_BASE_URL);

    let mut last_error: Option<String> = None;
    let mut attempted_any_model = false;
    let mut saw_unsupported_model = false;
    let mut saw_other_failure = false;

    for model in &models {
        attempted_any_model = true;
        match probe_one_model(
            base_url,
            &options.account_id,
            &options.access_token,
            model,
            timeout_ms,
        )
        .await
        {
            ProbeAttempt::Snapshot(snapshot) => return Ok(snapshot),
            ProbeAttempt::Unsupported(message) => {
                saw_unsupported_model = true;
                last_error = Some(message);
            }
            ProbeAttempt::Failure(message) => {
                saw_other_failure = true;
                last_error = Some(message);
            }
        }
    }

    if attempted_any_model && saw_unsupported_model && !saw_other_failure {
        return Err(CodexError::unavailable(last_error.unwrap_or_else(|| {
            "Codex is not available for this account".to_string()
        })));
    }

    Err(CodexError::new(
        last_error.unwrap_or_else(|| "Failed to fetch quotas".to_string()),
    ))
}

// ============================================================================
// Tests — ported from test/quota-probe.test.ts (wiremock replaces the TS
// global-fetch stubs; the `base_url` seam points the probe at the mock)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn options(server: &MockServer) -> ProbeCodexQuotaOptions {
        ProbeCodexQuotaOptions {
            account_id: "acct_probe".to_string(),
            access_token: "token-123".to_string(),
            model: None,
            fallback_models: None,
            timeout_ms: None,
            base_url: Some(server.uri()),
        }
    }

    /// Options pinned to a single explicit model (empty fallback list) so a
    /// test exercises exactly one attempt.
    fn single_model_options(server: &MockServer, model: &str) -> ProbeCodexQuotaOptions {
        ProbeCodexQuotaOptions {
            model: Some(model.to_string()),
            fallback_models: Some(Vec::new()),
            ..options(server)
        }
    }

    fn quota_headers_response(status: u16) -> ResponseTemplate {
        ResponseTemplate::new(status)
            .insert_header("x-codex-primary-used-percent", "12.5")
            .insert_header("x-codex-primary-window-minutes", "300")
            .insert_header("x-codex-primary-reset-after-seconds", "60")
            .insert_header("x-codex-secondary-used-percent", "3")
            .insert_header("x-codex-secondary-window-minutes", "10080")
            .insert_header("x-codex-plan-type", "plus")
            .insert_header("x-codex-active-limit", "5")
    }

    #[tokio::test]
    async fn returns_parsed_quota_snapshot_from_response_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .and(header("authorization", "Bearer token-123"))
            .and(header("content-type", "application/json"))
            .respond_with(quota_headers_response(200))
            .mount(&server)
            .await;

        let before = now_ms();
        let snapshot = fetch_codex_quota_snapshot(&options(&server))
            .await
            .expect("snapshot");
        assert_eq!(snapshot.status, 200);
        assert_eq!(snapshot.plan_type.as_deref(), Some("plus"));
        assert_eq!(snapshot.active_limit, Some(5));
        assert_eq!(snapshot.primary.used_percent, Some(12.5));
        assert_eq!(snapshot.primary.window_minutes, Some(300));
        let reset = snapshot.primary.reset_at_ms.expect("primary reset");
        assert!(
            reset >= before + 60_000 && reset <= now_ms() + 60_000,
            "reset-after-seconds must be now + 60s (got {reset})"
        );
        assert_eq!(snapshot.secondary.used_percent, Some(3.0));
        assert_eq!(snapshot.secondary.window_minutes, Some(10_080));
        assert_eq!(snapshot.secondary.reset_at_ms, None);
        // Default probe model: Sol first (DEFAULT_PROBE_MODEL).
        assert_eq!(snapshot.model, "gpt-5.6-sol");
    }

    #[tokio::test]
    async fn uses_gpt_5_6_sol_as_the_default_quota_probe_model() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .and(body_partial_json(
                json!({ "model": "gpt-5.6-sol", "stream": true, "store": false }),
            ))
            .respond_with(quota_headers_response(200))
            .expect(1)
            .mount(&server)
            .await;

        let snapshot = fetch_codex_quota_snapshot(&options(&server))
            .await
            .expect("snapshot");
        assert_eq!(snapshot.model, "gpt-5.6-sol");
    }

    #[tokio::test]
    async fn falls_back_from_the_gpt_5_6_probe_model_to_gpt_5_5_when_it_is_unsupported() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .and(body_partial_json(json!({ "model": "gpt-5.6-sol" })))
            .respond_with(ResponseTemplate::new(400).set_body_string(
                "{\"error\":{\"code\":\"model_not_supported_with_chatgpt_account\",\"message\":\"The 'gpt-5.6-sol' model is not supported\"}}",
            ))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .and(body_partial_json(json!({ "model": "gpt-5.5" })))
            .respond_with(quota_headers_response(200))
            .mount(&server)
            .await;

        let snapshot = fetch_codex_quota_snapshot(&options(&server))
            .await
            .expect("snapshot");
        assert_eq!(snapshot.model, "gpt-5.5");
    }

    #[tokio::test]
    async fn accepts_429_responses_when_quota_headers_are_present() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("x-codex-primary-used-percent", "100")
                    .insert_header("x-codex-primary-reset-after-seconds", "120"),
            )
            .mount(&server)
            .await;

        let snapshot = fetch_codex_quota_snapshot(&single_model_options(&server, "gpt-5.5"))
            .await
            .expect("snapshot");
        assert_eq!(snapshot.status, 429);
        assert_eq!(snapshot.primary.used_percent, Some(100.0));
        assert_eq!(snapshot.model, "gpt-5.5");
    }

    #[tokio::test]
    async fn times_out_a_stalled_probe_and_surfaces_abort_failure() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(
                quota_headers_response(200).set_delay(std::time::Duration::from_millis(3_000)),
            )
            .mount(&server)
            .await;

        let probe_options = ProbeCodexQuotaOptions {
            timeout_ms: Some(1_000),
            ..single_model_options(&server, "gpt-5.5")
        };
        let error = fetch_codex_quota_snapshot(&probe_options)
            .await
            .expect_err("timeout");
        assert_eq!(error.message(), "This operation was aborted");
        assert!(!error.is_codex_unavailable());
    }

    #[tokio::test]
    async fn parses_reset_at_values_expressed_as_epoch_seconds_and_epoch_milliseconds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(
                ResponseTemplate::new(200)
                    // < 10_000_000_000 → epoch-seconds → × 1000
                    .insert_header("x-codex-primary-reset-at", "1750001000")
                    // >= 10_000_000_000 → already epoch-ms
                    .insert_header("x-codex-secondary-reset-at", "1750001000000"),
            )
            .mount(&server)
            .await;

        let snapshot = fetch_codex_quota_snapshot(&single_model_options(&server, "gpt-5.5"))
            .await
            .expect("snapshot");
        assert_eq!(snapshot.primary.reset_at_ms, Some(1_750_001_000_000));
        assert_eq!(snapshot.secondary.reset_at_ms, Some(1_750_001_000_000));
    }

    #[tokio::test]
    async fn keeps_reset_at_undefined_for_invalid_reset_at_values() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-codex-primary-reset-at", "soon")
                    .insert_header("x-codex-secondary-reset-at", "0"),
            )
            .mount(&server)
            .await;

        let snapshot = fetch_codex_quota_snapshot(&single_model_options(&server, "gpt-5.5"))
            .await
            .expect("snapshot");
        assert_eq!(snapshot.primary.reset_at_ms, None);
        assert_eq!(snapshot.secondary.reset_at_ms, None);
    }

    #[tokio::test]
    async fn throws_parsed_nested_error_message_for_non_ok_response_without_quota_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(
                ResponseTemplate::new(500)
                    .set_body_string("{\"error\":{\"message\":\"upstream exploded\"}}"),
            )
            .mount(&server)
            .await;

        let error = fetch_codex_quota_snapshot(&single_model_options(&server, "gpt-5.5"))
            .await
            .expect_err("error");
        assert_eq!(error.message(), "upstream exploded");
    }

    #[tokio::test]
    async fn throws_top_level_message_plain_text_and_http_fallback_for_non_ok_response() {
        for (body, expected) in [
            ("{\"message\":\"top level\"}", "top level"),
            ("plain text failure", "plain text failure"),
            ("", "HTTP 500"),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/codex/responses"))
                .respond_with(ResponseTemplate::new(500).set_body_string(body))
                .mount(&server)
                .await;
            let error = fetch_codex_quota_snapshot(&single_model_options(&server, "gpt-5.5"))
                .await
                .expect_err("error");
            assert_eq!(error.message(), expected, "body {body:?}");
        }
    }

    #[tokio::test]
    async fn uses_default_unsupported_model_message_when_helper_does_not_provide_one() {
        let server = MockServer::start().await;
        // `code` marks it unsupported but carries no message string.
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(ResponseTemplate::new(400).set_body_string(
                "{\"error\":{\"code\":\"model_not_supported_with_chatgpt_account\"}}",
            ))
            .mount(&server)
            .await;

        let error = fetch_codex_quota_snapshot(&single_model_options(&server, "gpt-5.5"))
            .await
            .expect_err("error");
        assert!(error.is_codex_unavailable());
        assert_eq!(
            error.message(),
            "Model 'gpt-5.5' unsupported for this account"
        );
    }

    #[tokio::test]
    async fn throws_codex_unavailable_error_when_every_model_is_unsupported() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(ResponseTemplate::new(400).set_body_string(
                "{\"error\":{\"code\":\"model_not_supported_with_chatgpt_account\",\"message\":\"model is not supported\"}}",
            ))
            .mount(&server)
            .await;

        let error = fetch_codex_quota_snapshot(&options(&server))
            .await
            .expect_err("error");
        assert!(error.is_codex_unavailable());
        assert_eq!(
            describe_codex_probe_failure(&error, None),
            CODEX_UNAVAILABLE_PROBE_NOTE
        );
    }

    #[tokio::test]
    async fn does_not_throw_codex_unavailable_error_when_a_non_unsupported_failure_is_mixed_in() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .and(body_partial_json(json!({ "model": "gpt-5.6-sol" })))
            .respond_with(ResponseTemplate::new(400).set_body_string(
                "{\"error\":{\"code\":\"model_not_supported_with_chatgpt_account\",\"message\":\"model is not supported\"}}",
            ))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(
                ResponseTemplate::new(500)
                    .set_body_string("{\"error\":{\"message\":\"server broke\"}}"),
            )
            .mount(&server)
            .await;

        let probe_options = ProbeCodexQuotaOptions {
            model: Some("gpt-5.6-sol".to_string()),
            fallback_models: Some(vec!["gpt-5.5".to_string()]),
            ..options(&server)
        };
        let error = fetch_codex_quota_snapshot(&probe_options)
            .await
            .expect_err("error");
        assert!(!error.is_codex_unavailable());
        assert_eq!(error.message(), "server broke");
    }

    #[tokio::test]
    async fn throws_missing_quota_header_error_when_response_succeeds_without_quota_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_string("data: {}\n\n"))
            .mount(&server)
            .await;

        let error = fetch_codex_quota_snapshot(&single_model_options(&server, "gpt-5.5"))
            .await
            .expect_err("error");
        assert!(!error.is_codex_unavailable());
        assert_eq!(
            error.message(),
            "Codex response did not include quota headers"
        );
    }

    #[tokio::test]
    async fn throws_generic_failure_when_no_normalized_probe_models_are_available() {
        let server = MockServer::start().await;
        let probe_options = ProbeCodexQuotaOptions {
            model: Some("   ".to_string()),
            fallback_models: Some(vec!["  ".to_string(), String::new()]),
            ..options(&server)
        };
        let error = fetch_codex_quota_snapshot(&probe_options)
            .await
            .expect_err("error");
        assert_eq!(error.message(), "Failed to fetch quotas");
    }

    #[tokio::test]
    async fn increments_the_observability_hook_once_per_model_attempt() {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/codex/responses"))
            .respond_with(ResponseTemplate::new(400).set_body_string(
                "{\"error\":{\"code\":\"model_not_supported_with_chatgpt_account\",\"message\":\"model is not supported\"}}",
            ))
            .mount(&server)
            .await;

        COUNTER.store(0, Ordering::SeqCst);
        // The hook is process-global; other probe tests may fire attempts
        // concurrently. `#[tokio::test]` uses a current-thread runtime, so
        // attempts from THIS test always run on this thread — count only
        // those.
        let test_thread = std::thread::current().id();
        set_probe_observability_hook(Some(Arc::new(move || {
            if std::thread::current().id() == test_thread {
                COUNTER.fetch_add(1, Ordering::SeqCst);
            }
        })));
        let probe_options = ProbeCodexQuotaOptions {
            model: Some("gpt-5.6-sol".to_string()),
            fallback_models: Some(vec!["gpt-5.5".to_string()]),
            ..options(&server)
        };
        let _ = fetch_codex_quota_snapshot(&probe_options).await;
        set_probe_observability_hook(None);
        // One increment per MODEL attempt, not per call.
        assert_eq!(COUNTER.load(Ordering::SeqCst), 2);
    }

    // -- pure formatting -----------------------------------------------------

    #[test]
    fn formats_quota_lines_with_day_hour_labels_reset_text_plan_and_active_limits() {
        let reset_at = now_ms() + 60_000;
        let snapshot = CodexQuotaSnapshot {
            status: 429,
            plan_type: Some("plus".to_string()),
            active_limit: Some(3),
            primary: CodexQuotaWindow {
                used_percent: Some(25.0),
                window_minutes: Some(300),
                reset_at_ms: Some(reset_at),
            },
            secondary: CodexQuotaWindow {
                used_percent: Some(99.6),
                window_minutes: Some(10_080),
                reset_at_ms: None,
            },
            model: "gpt-5.6-sol".to_string(),
        };
        let line = format_quota_snapshot_line(&snapshot);
        let reset_text = format_quota_reset_at(Some(reset_at), None).expect("reset text");
        assert_eq!(
            line,
            format!(
                "5h 75% left (resets {reset_text}), 7d 0% left, plan:plus, active:3, rate-limited"
            )
        );
    }

    #[test]
    fn formats_fallback_quota_labels_and_suppresses_invalid_reset_time() {
        let snapshot = CodexQuotaSnapshot {
            status: 200,
            plan_type: None,
            active_limit: None,
            primary: CodexQuotaWindow {
                used_percent: None,
                window_minutes: None,
                reset_at_ms: Some(-5),
            },
            secondary: CodexQuotaWindow {
                used_percent: Some(30.0),
                window_minutes: Some(90),
                reset_at_ms: None,
            },
            model: "gpt-5.5".to_string(),
        };
        assert_eq!(format_quota_snapshot_line(&snapshot), "quota, 90m 70% left");
        assert_eq!(format_quota_reset_at(Some(0), None), None);
        assert_eq!(format_quota_reset_at(None, None), None);
    }

    #[test]
    fn format_quota_reset_at_uses_day_suffix_for_other_days() {
        let now = 1_700_000_000_000; // fixed reference
        let same_day = format_quota_reset_at(Some(now + 60_000), Some(now)).expect("same day");
        assert!(
            !same_day.contains(" on "),
            "same-day format must be bare HH:MM: {same_day}"
        );
        let other_day =
            format_quota_reset_at(Some(now + 3 * 86_400_000), Some(now)).expect("other day");
        assert!(
            other_day.contains(" on "),
            "cross-day format must carry ' on Mon DD': {other_day}"
        );
    }

    #[test]
    fn describe_codex_probe_failure_variants() {
        let unavailable = CodexError::unavailable("model is not supported for this account");
        assert_eq!(
            describe_codex_probe_failure(&unavailable, None),
            CODEX_UNAVAILABLE_PROBE_NOTE
        );

        let other = CodexError::new("boom");
        assert_eq!(describe_codex_probe_failure(&other, None), "boom");

        let normalizer = |message: &str| format!("normalized: {message}");
        assert_eq!(
            describe_codex_probe_failure(&other, Some(&normalizer)),
            "normalized: boom"
        );
        // The normalizer never applies to unavailable errors.
        assert_eq!(
            describe_codex_probe_failure(&unavailable, Some(&normalizer)),
            CODEX_UNAVAILABLE_PROBE_NOTE
        );
    }

    #[test]
    fn hostile_huge_reset_after_seconds_saturates_to_a_far_future_reset() {
        // TS float math yields a huge finite resetAtMs (blocked window); the
        // i64 port must saturate positive instead of wrapping negative
        // (which would read as already-reset → account looks healthy) or
        // panicking under overflow checks.
        let before = now_ms();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-primary-reset-after-seconds",
            HeaderValue::from_static("9300000000000000"),
        );
        let parsed = parse_reset_at_ms(&headers, "x-codex-primary").expect("resetAtMs");
        assert!(parsed > before, "far-future, never wrapped: {parsed}");

        // 20-digit runs saturate the parse itself, then the ms conversion.
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-primary-reset-after-seconds",
            HeaderValue::from_static("99999999999999999999"),
        );
        let parsed = parse_reset_at_ms(&headers, "x-codex-primary").expect("resetAtMs");
        assert!(parsed > before, "saturated parse stays far-future: {parsed}");
    }

    #[test]
    fn js_parse_int_and_number_semantics() {
        assert_eq!(js_parse_int("300"), Some(300));
        assert_eq!(js_parse_int("  42abc"), Some(42));
        assert_eq!(js_parse_int("12.9"), Some(12));
        assert_eq!(js_parse_int("-7"), Some(-7));
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int(""), None);
        assert_eq!(js_number("12.5"), Some(12.5));
        assert_eq!(js_number(" 42 "), Some(42.0));
        assert_eq!(js_number("1e3"), Some(1000.0));
        assert_eq!(js_number("nope"), None);
        assert!(js_number("Infinity").is_some_and(|n| n.is_infinite()));
    }
}
