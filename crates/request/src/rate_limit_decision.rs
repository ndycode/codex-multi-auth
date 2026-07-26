//! Port of `lib/request/rate-limit-decision.ts` — retry-after parsing
//! (header + body), token-invalidation detection, quota near-exhaustion
//! waits, and the standard machine-readable error bodies used by the runtime
//! rotation proxy (spec 06 §14, spec 04 §req-loop).

use std::fmt::Write as _;

use cma_core::constants::{HTTP_STATUS, MAX_RATE_LIMIT_DELAY_MS};
use cma_core::json_io::stringify_compact;
use cma_core::schemas::token::{TokenFailure, TokenFailureReason};
use http::HeaderMap;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::failover_config::parse_env_int;

/// Phrases observed in upstream 401 response bodies when OpenAI/Microsoft has
/// explicitly revoked an OAuth token (as opposed to a generic expired-token
/// 401 that can be retried after a refresh). Matching is case-insensitive
/// substring. See issue #495.
pub const TOKEN_INVALIDATION_PHRASES: [&str; 4] = [
    "invalidated oauth token",
    "authentication token has been invalidated",
    "oauth token has been invalidated",
    "token has been invalidated",
];

/// TS `isTokenInvalidationError(bodyText)`.
pub fn is_token_invalidation_error(body_text: &str) -> bool {
    let lower = body_text.to_lowercase();
    TOKEN_INVALIDATION_PHRASES
        .iter()
        .any(|phrase| lower.contains(phrase))
}

/// TS `isTokenRefreshRetryable(result)` — near-duplicate of the private
/// helper in token-refresh.ts, except `missing_refresh` falls to the generic
/// `false` here. An absent reason is non-retryable.
pub fn is_token_refresh_retryable(result: &TokenFailure) -> bool {
    match result.reason {
        Some(
            TokenFailureReason::NetworkError
            | TokenFailureReason::Unknown
            | TokenFailureReason::InvalidResponse,
        ) => true,
        Some(TokenFailureReason::HttpError) => !matches!(
            result.status_code,
            Some(code)
                if code == HTTP_STATUS.bad_request as i64
                    || code == HTTP_STATUS.unauthorized as i64
                    || code == HTTP_STATUS.forbidden as i64
        ),
        _ => false,
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `Date.parse` analogue for the formats that actually reach these parsers:
/// RFC 1123/2822 HTTP dates and ISO-8601/RFC 3339 strings.
fn parse_date_ms(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc2822(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    None
}

/// TS `parseRetryAfterHeaderMs(headers, now)` — `retry-after-ms` int > 0
/// as-is; `retry-after` int > 0 seconds x1000; else HTTP-date in the future.
/// **No clamping here** (callers clamp).
pub fn parse_retry_after_header_ms(headers: &HeaderMap, now: i64) -> Option<i64> {
    if let Some(raw) = header_str(headers, "retry-after-ms")
        && !raw.is_empty()
        && let Some(parsed) = parse_env_int(Some(raw))
        && parsed > 0
    {
        return Some(parsed);
    }
    let retry_after = header_str(headers, "retry-after")?;
    if retry_after.is_empty() {
        return None;
    }
    if let Some(as_seconds) = parse_env_int(Some(retry_after))
        && as_seconds > 0
    {
        return Some(as_seconds * 1000);
    }
    if let Some(as_date) = parse_date_ms(retry_after)
        && as_date > now
    {
        return Some(as_date - now);
    }
    None
}

/// JS `Number(value)` over a JSON value (the coercions these parsers hit).
fn js_number_of(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// TS `parseRetryAfterBodyMs(bodyText, now)` — JSON `{error:{...}}`:
/// `retry_after_ms` > 0; else `retry_after` (seconds) x1000; else
/// `resets_at ?? reset_at` with the `< 10_000_000_000 => seconds` heuristic,
/// delta from `now` when in the future. Parse failure => `None`.
pub fn parse_retry_after_body_ms(body_text: &str, now: i64) -> Option<i64> {
    if body_text.trim().is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(body_text).ok()?;
    let error = parsed.as_object()?.get("error")?.as_object()?;

    let retry_after_ms = error.get("retry_after_ms").map(js_number_of);
    if let Some(v) = retry_after_ms
        && v.is_finite()
        && v > 0.0
    {
        return Some(v as i64);
    }
    let retry_after_seconds = error.get("retry_after").map(js_number_of);
    if let Some(v) = retry_after_seconds
        && v.is_finite()
        && v > 0.0
    {
        return Some((v * 1000.0) as i64);
    }
    // `resets_at ?? reset_at` — JS `??` also coalesces an explicit null.
    let reset_at_raw = error
        .get("resets_at")
        .filter(|v| !v.is_null())
        .or_else(|| error.get("reset_at").filter(|v| !v.is_null()))
        .map(js_number_of)?;
    if reset_at_raw.is_finite() && reset_at_raw > 0.0 {
        // Epoch heuristic: all values below 1e10 are seconds (spec gotcha 13).
        let reset_at_ms = if reset_at_raw < 10_000_000_000.0 {
            reset_at_raw * 1000.0
        } else {
            reset_at_raw
        };
        if reset_at_ms > now as f64 {
            return Some((reset_at_ms - now as f64) as i64);
        }
    }
    None
}

const TOKEN_INVALIDATED_CODE: &str = "token_invalidated";
const TOKEN_INVALIDATED_FALLBACK_MESSAGE: &str =
    "OAuth token has been invalidated. Please re-login.";

/// TS `buildTokenInvalidationBody(upstreamBodyText)`.
///
/// Both invalidation exit paths (refresh-failure and upstream-401) must hand
/// the client the same machine-readable shape —
/// `{ "error": { "message", "code": "token_invalidated" } }` — so a consumer
/// keying off `error.code` behaves identically regardless of which vector
/// fired. A JSON upstream body's `message` (top-level, else `error.message`)
/// is preserved when it is a non-blank string; non-JSON bodies (e.g. HTML)
/// keep the stable fallback message rather than echoing markup.
pub fn build_token_invalidation_body(upstream_body_text: &str) -> String {
    let mut message = TOKEN_INVALIDATED_FALLBACK_MESSAGE.to_string();
    let trimmed = upstream_body_text.trim();
    if !trimmed.is_empty()
        && let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
        && let Some(obj) = parsed.as_object()
    {
        if let Some(direct) = obj.get("message").and_then(Value::as_str)
            && !direct.trim().is_empty()
        {
            message = direct.trim().to_string();
        } else if let Some(error) = obj.get("error").and_then(Value::as_object)
            && let Some(nested) = error.get("message").and_then(Value::as_str)
            && !nested.trim().is_empty()
        {
            message = nested.trim().to_string();
        }
    }
    stringify_compact(&serde_json::json!({
        "error": { "message": message, "code": TOKEN_INVALIDATED_CODE }
    }))
}

/// TS `extractErrorCodeFromBody(bodyText)` — top-level `code` string
/// (trimmed) first, else `error.code`.
pub fn extract_error_code_from_body(body_text: &str) -> Option<String> {
    if body_text.trim().is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(body_text).ok()?;
    let obj = parsed.as_object()?;
    if let Some(direct) = obj.get("code").and_then(Value::as_str) {
        let trimmed = direct.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let nested = obj.get("error")?.as_object()?.get("code")?.as_str()?;
    let trimmed = nested.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// TS private `getQuotaWindowWaitMs(headers, prefix, now)`.
fn get_quota_window_wait_ms(headers: &HeaderMap, prefix: &str, now: i64) -> i64 {
    let reset_after_header = format!("{prefix}-reset-after-seconds");
    if let Some(raw) = header_str(headers, &reset_after_header)
        && let Some(reset_after_seconds) = parse_env_int(Some(raw))
        && reset_after_seconds > 0
    {
        return reset_after_seconds.saturating_mul(1000);
    }
    let reset_at_header = format!("{prefix}-reset-at");
    let Some(reset_at_raw) = header_str(headers, &reset_at_header) else {
        return 0;
    };
    let trimmed = reset_at_raw.trim();
    let mut reset_at_ms: i64 = 0;
    if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
        if let Some(parsed) = parse_env_int(Some(trimmed))
            && parsed > 0
        {
            reset_at_ms = if parsed < 10_000_000_000 {
                parsed.saturating_mul(1000)
            } else {
                parsed
            };
        }
    } else if let Some(parsed_date) = parse_date_ms(trimmed) {
        reset_at_ms = parsed_date;
    }
    if reset_at_ms > now { reset_at_ms - now } else { 0 }
}

/// TS `getQuotaNearExhaustionWaitMs(headers, remainingThreshold, now)`.
///
/// `usedThreshold = 100 - clamp(remainingThreshold, 0, 100)`. For the
/// `x-codex-primary` / `x-codex-secondary` windows whose `-used-percent`
/// meets the threshold, collect positive window waits; none => 0; else
/// `min(max(candidates), MAX_RATE_LIMIT_DELAY_MS)` — clamped AT SOURCE so a
/// bogus upstream reset header can never yield an unbounded wait (defense in
/// depth for stress audit H1).
pub fn get_quota_near_exhaustion_wait_ms(
    headers: &HeaderMap,
    remaining_threshold: f64,
    now: i64,
) -> i64 {
    let used_threshold = 100.0 - remaining_threshold.clamp(0.0, 100.0);
    let mut candidates: Vec<i64> = Vec::new();
    for prefix in ["x-codex-primary", "x-codex-secondary"] {
        let used_header = format!("{prefix}-used-percent");
        let used = match header_str(headers, &used_header) {
            Some(raw) => js_number_of(&Value::String(raw.to_string())),
            None => js_number_of(&Value::String(String::new())),
        };
        if !used.is_finite() || used < used_threshold {
            continue;
        }
        let wait_ms = get_quota_window_wait_ms(headers, prefix, now);
        if wait_ms > 0 {
            candidates.push(wait_ms);
        }
    }
    match candidates.iter().max() {
        None => 0,
        Some(&max_wait) => max_wait.min(MAX_RATE_LIMIT_DELAY_MS),
    }
}

/// TS `normalizeExhaustionStatus(reason)` — `"rate-limit"` => 429, every
/// other exhaustion reason => 503. Takes the reason's wire string because
/// `ExhaustionReason` itself lives upstream in the runtime crate (the TS
/// import direction is inverted by the Rust crate DAG).
pub fn normalize_exhaustion_status(reason: &str) -> u16 {
    if reason == "rate-limit" {
        HTTP_STATUS.too_many_requests
    } else {
        503
    }
}

/// TS `PinnedUnavailableErrorBody` — the JSON `error` body for a
/// pinned-account 503. Serde field order is the exact TS shape. See issue
/// #486 for the null-reason desync path.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PinnedUnavailableErrorBody {
    pub message: String,
    /// Always `"codex_pinned_account_unavailable"`.
    pub code: &'static str,
    /// Serialized as an explicit `null` when unknown (desync path).
    #[serde(rename = "pinnedAccountIndex")]
    pub pinned_account_index: Option<i64>,
    /// Serialized as an explicit `null` when absent.
    pub reason: Option<String>,
    /// Record of stringified account index -> skip reason, in caller order.
    pub account_skip_reasons: Map<String, Value>,
}

/// TS `buildPinnedUnavailableErrorBody(pinnedIndex, accountSkipReasons)`.
///
/// `account_skip_reasons` entries keep their given order (the TS `Map`
/// insertion order); a duplicate index keeps its first position with the
/// last value, matching JS `Map` semantics.
pub fn build_pinned_unavailable_error_body(
    pinned_index: Option<i64>,
    account_skip_reasons: &[(usize, String)],
) -> PinnedUnavailableErrorBody {
    let skip_reason: Option<String> = pinned_index.and_then(|pinned| {
        // Map.get semantics: last write for the key wins.
        account_skip_reasons
            .iter()
            .rev()
            .find(|(index, _)| *index as i64 == pinned)
            .map(|(_, reason)| reason.clone())
    });
    let reason_suffix = match &skip_reason {
        Some(reason) => format!(" ({reason})"),
        None => String::new(),
    };
    // On the desync path the pin index is unknown (null); claiming
    // "account 1" there would contradict the machine-readable
    // pinnedAccountIndex: null.
    let account_phrase = match pinned_index {
        None => "The pinned account".to_string(),
        Some(index) => format!("Pinned account {}", index + 1),
    };
    let mut message = String::new();
    let _ = write!(
        message,
        "{account_phrase} is currently unavailable{reason_suffix}; run `codex-multi-auth status` for details, or `codex-multi-auth unpin` to allow rotation."
    );
    let mut reasons = Map::new();
    for (index, reason) in account_skip_reasons {
        reasons.insert(index.to_string(), Value::String(reason.clone()));
    }
    PinnedUnavailableErrorBody {
        message,
        code: "codex_pinned_account_unavailable",
        pinned_account_index: pinned_index,
        reason: skip_reason,
        account_skip_reasons: reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::header::{HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                name.parse::<HeaderName>().expect("header name"),
                HeaderValue::from_str(value).expect("header value"),
            );
        }
        map
    }

    fn utc_string(epoch_ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(epoch_ms)
            .expect("valid epoch")
            .to_rfc2822()
    }

    mod token_invalidation {
        use super::*;

        #[test]
        fn matches_known_phrases_case_insensitively() {
            assert!(is_token_invalidation_error(
                r#"{"message":"Invalidated OAuth Token"}"#
            ));
            assert!(is_token_invalidation_error(
                "the authentication TOKEN has been INVALIDATED"
            ));
        }

        #[test]
        fn does_not_match_generic_401_bodies() {
            assert!(!is_token_invalidation_error(r#"{"message":"token expired"}"#));
            assert!(!is_token_invalidation_error(""));
        }
    }

    mod refresh_retryable {
        use super::*;

        fn failed(reason: Option<TokenFailureReason>, status: Option<i64>) -> TokenFailure {
            TokenFailure {
                reason,
                status_code: status,
                message: None,
            }
        }

        #[test]
        fn transient_reasons_are_retryable() {
            for reason in [
                TokenFailureReason::NetworkError,
                TokenFailureReason::Unknown,
                TokenFailureReason::InvalidResponse,
            ] {
                assert!(is_token_refresh_retryable(&failed(Some(reason), None)));
            }
        }

        #[test]
        fn credential_level_http_errors_are_terminal_server_errors_retryable() {
            for status in [400, 401, 403] {
                assert!(!is_token_refresh_retryable(&failed(
                    Some(TokenFailureReason::HttpError),
                    Some(status)
                )));
            }
            assert!(is_token_refresh_retryable(&failed(
                Some(TokenFailureReason::HttpError),
                Some(500)
            )));
            assert!(is_token_refresh_retryable(&failed(
                Some(TokenFailureReason::HttpError),
                Some(429)
            )));
        }

        #[test]
        fn missing_refresh_timeout_and_absent_reasons_are_non_retryable() {
            assert!(!is_token_refresh_retryable(&failed(
                Some(TokenFailureReason::MissingRefresh),
                None
            )));
            assert!(!is_token_refresh_retryable(&failed(
                Some(TokenFailureReason::Timeout),
                None
            )));
            assert!(!is_token_refresh_retryable(&failed(None, None)));
        }
    }

    mod retry_after_header {
        use super::*;

        // Realistic epoch: bare digit strings must land in the past.
        const NOW: i64 = 1_700_000_000_000;

        #[test]
        fn prefers_retry_after_ms_over_retry_after() {
            let h = headers(&[("retry-after-ms", "1500"), ("retry-after", "60")]);
            assert_eq!(parse_retry_after_header_ms(&h, NOW), Some(1500));
        }

        #[test]
        fn converts_retry_after_seconds_to_milliseconds() {
            let h = headers(&[("retry-after", "30")]);
            assert_eq!(parse_retry_after_header_ms(&h, NOW), Some(30_000));
        }

        #[test]
        fn supports_http_date_values_in_the_future() {
            let h = headers(&[("retry-after", &utc_string(NOW + 90_000))]);
            let wait = parse_retry_after_header_ms(&h, NOW).expect("future date");
            assert!(wait > 88_000);
            assert!(wait <= 90_000);
        }

        #[test]
        fn returns_none_for_absent_non_positive_or_unparseable() {
            assert_eq!(parse_retry_after_header_ms(&headers(&[]), NOW), None);
            assert_eq!(
                parse_retry_after_header_ms(&headers(&[("retry-after", "0")]), NOW),
                None
            );
            assert_eq!(
                parse_retry_after_header_ms(&headers(&[("retry-after", "-5")]), NOW),
                None
            );
            assert_eq!(
                parse_retry_after_header_ms(&headers(&[("retry-after", "soon")]), NOW),
                None
            );
            assert_eq!(
                parse_retry_after_header_ms(
                    &headers(&[("retry-after", &utc_string(NOW - 1_000))]),
                    NOW
                ),
                None
            );
        }
    }

    mod retry_after_body {
        use super::*;

        // Epoch-ms scale so the resets_at heuristics are exercised.
        const NOW: i64 = 5_000_000_000_000;

        #[test]
        fn reads_retry_after_ms_first_then_retry_after_seconds() {
            assert_eq!(
                parse_retry_after_body_ms(r#"{"error":{"retry_after_ms":2500}}"#, NOW),
                Some(2500)
            );
            assert_eq!(
                parse_retry_after_body_ms(r#"{"error":{"retry_after":12}}"#, NOW),
                Some(12_000)
            );
        }

        #[test]
        fn derives_waits_from_resets_at_in_epoch_seconds_or_milliseconds() {
            let resets_at_seconds = NOW / 1000 + 60;
            assert_eq!(
                parse_retry_after_body_ms(
                    &format!(r#"{{"error":{{"resets_at":{resets_at_seconds}}}}}"#),
                    NOW
                ),
                Some(resets_at_seconds * 1000 - NOW)
            );
            let reset_at_ms = NOW + 45_000;
            assert_eq!(
                parse_retry_after_body_ms(
                    &format!(r#"{{"error":{{"reset_at":{reset_at_ms}}}}}"#),
                    NOW
                ),
                Some(45_000)
            );
        }

        #[test]
        fn returns_none_for_empty_non_json_non_record_and_past_payloads() {
            assert_eq!(parse_retry_after_body_ms("", NOW), None);
            assert_eq!(parse_retry_after_body_ms("   ", NOW), None);
            assert_eq!(parse_retry_after_body_ms("{not json", NOW), None);
            assert_eq!(parse_retry_after_body_ms("[1,2]", NOW), None);
            assert_eq!(parse_retry_after_body_ms(r#"{"error":[]}"#, NOW), None);
            assert_eq!(
                parse_retry_after_body_ms(
                    &format!(r#"{{"error":{{"resets_at":{}}}}}"#, NOW - 1),
                    NOW
                ),
                None
            );
        }
    }

    mod token_invalidation_body {
        use super::*;

        fn parse(body: &str) -> Value {
            serde_json::from_str(body).expect("valid JSON")
        }

        #[test]
        fn preserves_top_level_upstream_message_inside_stable_envelope() {
            let body = parse(&build_token_invalidation_body(
                r#"{"message":" token revoked "}"#,
            ));
            assert_eq!(
                body["error"],
                serde_json::json!({"message":"token revoked","code":"token_invalidated"})
            );
        }

        #[test]
        fn falls_back_to_nested_error_message() {
            let body = parse(&build_token_invalidation_body(
                r#"{"error":{"message":"oauth token has been invalidated"}}"#,
            ));
            assert_eq!(
                body["error"]["message"],
                "oauth token has been invalidated"
            );
        }

        #[test]
        fn uses_stable_fallback_for_non_json_empty_and_messageless_bodies() {
            for upstream in ["", "<html>nope</html>", r#"{"message":"  "}"#] {
                let body = parse(&build_token_invalidation_body(upstream));
                assert_eq!(
                    body["error"],
                    serde_json::json!({
                        "message": "OAuth token has been invalidated. Please re-login.",
                        "code": "token_invalidated"
                    }),
                    "upstream={upstream:?}"
                );
            }
        }

        #[test]
        fn emits_exact_byte_shape() {
            assert_eq!(
                build_token_invalidation_body(""),
                r#"{"error":{"message":"OAuth token has been invalidated. Please re-login.","code":"token_invalidated"}}"#
            );
        }
    }

    mod error_code_extraction {
        use super::*;

        #[test]
        fn reads_top_level_code_before_nested_error_code() {
            assert_eq!(
                extract_error_code_from_body(r#"{"code":" direct ","error":{"code":"nested"}}"#),
                Some("direct".to_string())
            );
            assert_eq!(
                extract_error_code_from_body(r#"{"error":{"code":"nested"}}"#),
                Some("nested".to_string())
            );
        }

        #[test]
        fn returns_none_for_empty_malformed_non_record_and_whitespace_codes() {
            assert_eq!(extract_error_code_from_body(""), None);
            assert_eq!(extract_error_code_from_body("{oops"), None);
            assert_eq!(extract_error_code_from_body("[]"), None);
            assert_eq!(extract_error_code_from_body(r#"{"code":"  "}"#), None);
            assert_eq!(extract_error_code_from_body(r#"{"error":{"code":42}}"#), None);
        }
    }

    mod quota_near_exhaustion {
        use super::*;

        const NOW: i64 = 1_700_000_000_000;

        #[test]
        fn waits_on_window_at_or_above_used_threshold_via_reset_after_seconds() {
            let h = headers(&[
                ("x-codex-primary-used-percent", "97"),
                ("x-codex-primary-reset-after-seconds", "120"),
            ]);
            assert_eq!(get_quota_near_exhaustion_wait_ms(&h, 5.0, NOW), 120_000);
        }

        #[test]
        fn ignores_windows_below_the_threshold() {
            let h = headers(&[
                ("x-codex-primary-used-percent", "80"),
                ("x-codex-primary-reset-after-seconds", "120"),
            ]);
            assert_eq!(get_quota_near_exhaustion_wait_ms(&h, 5.0, NOW), 0);
        }

        #[test]
        fn takes_the_max_wait_across_primary_and_secondary_windows() {
            let h = headers(&[
                ("x-codex-primary-used-percent", "100"),
                ("x-codex-primary-reset-after-seconds", "60"),
                ("x-codex-secondary-used-percent", "100"),
                ("x-codex-secondary-reset-after-seconds", "300"),
            ]);
            assert_eq!(get_quota_near_exhaustion_wait_ms(&h, 5.0, NOW), 300_000);
        }

        #[test]
        fn h1_clamps_absurd_reset_after_to_seven_days() {
            let seven_days_ms = 7 * 24 * 60 * 60 * 1000;
            let h = headers(&[
                ("x-codex-primary-used-percent", "100"),
                // ~31 years in seconds — a bogus/buggy upstream value.
                ("x-codex-primary-reset-after-seconds", "999999999"),
            ]);
            assert_eq!(get_quota_near_exhaustion_wait_ms(&h, 5.0, NOW), seven_days_ms);
        }

        #[test]
        fn supports_reset_at_in_epoch_seconds_ms_and_date_strings() {
            let epoch_seconds = NOW / 1000 + 60;
            assert_eq!(
                get_quota_near_exhaustion_wait_ms(
                    &headers(&[
                        ("x-codex-primary-used-percent", "100"),
                        ("x-codex-primary-reset-at", &epoch_seconds.to_string()),
                    ]),
                    5.0,
                    NOW
                ),
                epoch_seconds * 1000 - NOW
            );
            assert_eq!(
                get_quota_near_exhaustion_wait_ms(
                    &headers(&[
                        ("x-codex-primary-used-percent", "100"),
                        ("x-codex-primary-reset-at", &(NOW + 30_000).to_string()),
                    ]),
                    5.0,
                    NOW
                ),
                30_000
            );
            let date_wait = get_quota_near_exhaustion_wait_ms(
                &headers(&[
                    ("x-codex-primary-used-percent", "100"),
                    ("x-codex-primary-reset-at", &utc_string(NOW + 90_000)),
                ]),
                5.0,
                NOW,
            );
            assert!(date_wait > 88_000);
            assert!(date_wait <= 90_000);
        }

        #[test]
        fn returns_zero_when_no_usable_reset_signal_exists() {
            assert_eq!(get_quota_near_exhaustion_wait_ms(&headers(&[]), 5.0, NOW), 0);
            assert_eq!(
                get_quota_near_exhaustion_wait_ms(
                    &headers(&[("x-codex-primary-used-percent", "100")]),
                    5.0,
                    NOW
                ),
                0
            );
        }
    }

    mod exhaustion_status {
        use super::*;

        #[test]
        fn maps_rate_limit_to_429_everything_else_to_503() {
            assert_eq!(normalize_exhaustion_status("rate-limit"), 429);
            assert_eq!(normalize_exhaustion_status("server-error"), 503);
            assert_eq!(normalize_exhaustion_status("auth-failure"), 503);
            assert_eq!(normalize_exhaustion_status("no-account"), 503);
            assert_eq!(normalize_exhaustion_status("budget"), 503);
        }
    }

    mod pinned_unavailable {
        use super::*;

        #[test]
        fn includes_one_based_pinned_index_and_skip_reason() {
            let body = build_pinned_unavailable_error_body(
                Some(1),
                &[(0, "rate-limited".to_string()), (1, "disabled".to_string())],
            );
            assert_eq!(body.code, "codex_pinned_account_unavailable");
            assert_eq!(body.pinned_account_index, Some(1));
            assert_eq!(body.reason.as_deref(), Some("disabled"));
            assert!(body.message.contains("Pinned account 2"));
            assert!(body.message.contains("(disabled)"));
            let serialized = serde_json::to_value(&body).expect("serialize");
            assert_eq!(
                serialized["account_skip_reasons"],
                serde_json::json!({"0": "rate-limited", "1": "disabled"})
            );
        }

        #[test]
        fn null_index_desync_path_omits_index_parenthetical_and_reason() {
            let body = build_pinned_unavailable_error_body(None, &[]);
            assert_eq!(body.pinned_account_index, None);
            assert_eq!(body.reason, None);
            assert!(body
                .message
                .contains("The pinned account is currently unavailable;"));
            assert!(!body.message.contains("Pinned account 1"));
            assert!(!body.message.contains('('));
            assert!(body.account_skip_reasons.is_empty());
            // Machine-readable nulls must serialize explicitly.
            let serialized = serde_json::to_value(&body).expect("serialize");
            assert!(serialized["pinnedAccountIndex"].is_null());
            assert!(serialized["reason"].is_null());
        }

        #[test]
        fn serialized_field_order_matches_ts_shape() {
            let body = build_pinned_unavailable_error_body(Some(0), &[(0, "x".to_string())]);
            let serialized = stringify_compact(&body);
            let message_pos = serialized.find("\"message\"").unwrap();
            let code_pos = serialized.find("\"code\"").unwrap();
            let index_pos = serialized.find("\"pinnedAccountIndex\"").unwrap();
            let reason_pos = serialized.find("\"reason\"").unwrap();
            let skips_pos = serialized.find("\"account_skip_reasons\"").unwrap();
            assert!(message_pos < code_pos);
            assert!(code_pos < index_pos);
            assert!(index_pos < reason_pos);
            assert!(reason_pos < skips_pos);
        }
    }
}
