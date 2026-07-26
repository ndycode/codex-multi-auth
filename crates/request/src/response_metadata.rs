//! Port of `lib/request/response-metadata.ts` — retry-hint parsing + log-safe
//! header allowlist.
//!
//! Behavior source: spec 06 §19 + the TS source (authority).
//!
//! Note the deliberately TIGHTER clamp here: retry hints cap at 24 hours
//! (`MAX_RETRY_HINT_MS`), versus the 7-day `MAX_RATE_LIMIT_DELAY_MS` used by
//! `fetch_helpers`/`rate_limit_decision` (spec 06 gotcha 13).

use cma_core::utils::now_ms;
use http::header::HeaderMap;
use serde_json::{Map, Value};

/// TS private `MAX_RETRY_HINT_MS = 24 * 60 * 60 * 1000`.
const MAX_RETRY_HINT_MS: i64 = 24 * 60 * 60 * 1000;

/// TS private `clampRetryHintMs`: non-finite → None; floor; ≤ 0 → None;
/// `min(value, 24h)`.
fn clamp_retry_hint_ms(value: f64) -> Option<i64> {
    if !value.is_finite() {
        return None;
    }
    let normalized = value.floor();
    if normalized <= 0.0 {
        return None;
    }
    Some((normalized as i64).min(MAX_RETRY_HINT_MS))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn is_all_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// JS `Number.parseInt(<all-digit string>, 10)` as f64 (huge inputs saturate
/// through f64 exactly like JS numbers instead of failing an i64 parse).
fn digits_to_f64(value: &str) -> f64 {
    value.parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `Date.parse` for the formats that reach this code path: RFC 2822 HTTP
/// dates (`toUTCString()` output), RFC 3339/ISO 8601 date-times, and bare
/// ISO dates (UTC midnight, matching the JS date-only rule).
pub(crate) fn js_date_parse_ms(value: &str) -> Option<i64> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc2822(value) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        let midnight = parsed.and_hms_opt(0, 0, 0)?;
        return Some(midnight.and_utc().timestamp_millis());
    }
    None
}

/// TS `parseRetryAfterHintMs(headers)`.
///
/// Precedence: `retry-after-ms` (all-digits, ms) → `retry-after` (all-digits
/// seconds ×1000; otherwise HTTP date minus now) → `x-ratelimit-reset`
/// (all-digits epoch with the `< 10_000_000_000 → seconds` heuristic, minus
/// now). Every branch clamps to `[1, 24h]`; nothing matched → `None`.
pub fn parse_retry_after_hint_ms(headers: &HeaderMap) -> Option<i64> {
    parse_retry_after_hint_ms_at(headers, now_ms())
}

/// [`parse_retry_after_hint_ms`] against an explicit wall-clock instant (test
/// seam for the TS fake-timer suites).
pub fn parse_retry_after_hint_ms_at(headers: &HeaderMap, now_ms: i64) -> Option<i64> {
    if let Some(retry_after_ms) = header_str(headers, "retry-after-ms").map(str::trim)
        && is_all_digits(retry_after_ms) {
            return clamp_retry_hint_ms(digits_to_f64(retry_after_ms));
        }

    if let Some(retry_after) = header_str(headers, "retry-after").map(str::trim) {
        if is_all_digits(retry_after) {
            return clamp_retry_hint_ms(digits_to_f64(retry_after) * 1000.0);
        }
        if !retry_after.is_empty()
            && let Some(retry_at_ms) = js_date_parse_ms(retry_after) {
                return clamp_retry_hint_ms((retry_at_ms - now_ms) as f64);
            }
    }

    if let Some(reset_at) = header_str(headers, "x-ratelimit-reset").map(str::trim)
        && is_all_digits(reset_at) {
            let reset_raw = digits_to_f64(reset_at);
            let reset_at_ms = if reset_raw < 10_000_000_000.0 {
                reset_raw * 1000.0
            } else {
                reset_raw
            };
            return clamp_retry_hint_ms(reset_at_ms - now_ms as f64);
        }

    None
}

/// TS `sanitizeResponseHeadersForLog(headers)` — allowlist ONLY; everything
/// else (especially auth headers) is dropped. Keys are lowercased; duplicate
/// header values are joined with `", "` (the web `Headers` combine rule).
pub fn sanitize_response_headers_for_log(headers: &HeaderMap) -> Map<String, Value> {
    const ALLOWED: [&str; 16] = [
        "content-type",
        "x-request-id",
        "x-openai-request-id",
        "x-codex-plan-type",
        "x-codex-active-limit",
        "x-codex-primary-used-percent",
        "x-codex-primary-window-minutes",
        "x-codex-primary-reset-at",
        "x-codex-primary-reset-after-seconds",
        "x-codex-secondary-used-percent",
        "x-codex-secondary-window-minutes",
        "x-codex-secondary-reset-at",
        "x-codex-secondary-reset-after-seconds",
        "retry-after",
        "x-ratelimit-reset",
        "x-ratelimit-reset-requests",
    ];

    let mut sanitized = Map::new();
    for name in headers.keys() {
        let lower = name.as_str().to_lowercase();
        if !ALLOWED.contains(&lower.as_str()) {
            continue;
        }
        let combined = headers
            .get_all(name)
            .iter()
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
            .collect::<Vec<_>>()
            .join(", ");
        sanitized.insert(lower, Value::String(combined));
    }
    sanitized
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::header::{HeaderName, HeaderValue};

    /// Fixed "now" matching the TS suite: 2026-03-22T00:00:00.000Z.
    const NOW_MS: i64 = 1_774_137_600_000;

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

    #[test]
    fn now_constant_matches_the_ts_fake_clock() {
        let expected = chrono::DateTime::parse_from_rfc3339("2026-03-22T00:00:00.000Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(NOW_MS, expected);
    }

    #[test]
    fn parses_retry_after_ms_before_other_retry_headers() {
        let headers = headers(&[("retry-after-ms", "1200"), ("retry-after", "30")]);
        assert_eq!(parse_retry_after_hint_ms_at(&headers, NOW_MS), Some(1200));
    }

    #[test]
    fn parses_retry_after_seconds_and_caps_extreme_values_to_one_day() {
        let headers = headers(&[("retry-after", "999999")]);
        assert_eq!(
            parse_retry_after_hint_ms_at(&headers, NOW_MS),
            Some(86_400_000)
        );
    }

    #[test]
    fn parses_retry_after_dates_and_ratelimit_reset_timestamps() {
        let date_headers = headers(&[("retry-after", "Sun, 22 Mar 2026 00:02:00 GMT")]);
        assert_eq!(
            parse_retry_after_hint_ms_at(&date_headers, NOW_MS),
            Some(120_000)
        );

        let reset_epoch_seconds = NOW_MS / 1000 + 45;
        let reset_headers = headers(&[("x-ratelimit-reset", &reset_epoch_seconds.to_string())]);
        assert_eq!(
            parse_retry_after_hint_ms_at(&reset_headers, NOW_MS),
            Some(45_000)
        );
    }

    #[test]
    fn millisecond_epoch_reset_values_skip_the_seconds_multiplier() {
        let reset_epoch_ms = NOW_MS + 30_000;
        let reset_headers = headers(&[("x-ratelimit-reset", &reset_epoch_ms.to_string())]);
        assert_eq!(
            parse_retry_after_hint_ms_at(&reset_headers, NOW_MS),
            Some(30_000)
        );
    }

    #[test]
    fn returns_none_for_invalid_or_non_positive_retry_hints() {
        assert_eq!(
            parse_retry_after_hint_ms_at(&headers(&[("retry-after-ms", "abc")]), NOW_MS),
            None
        );
        let past = NOW_MS / 1000 - 5;
        assert_eq!(
            parse_retry_after_hint_ms_at(&headers(&[("x-ratelimit-reset", &past.to_string())]), NOW_MS),
            None
        );
        // Zero values clamp to None WITHOUT falling through to later headers
        // (the TS all-digits branches return unconditionally).
        assert_eq!(
            parse_retry_after_hint_ms_at(
                &headers(&[
                    ("retry-after-ms", "0"),
                    ("retry-after", "Sun, 22 Mar 2026 00:02:00 GMT"),
                ]),
                NOW_MS
            ),
            None
        );
        assert_eq!(parse_retry_after_hint_ms_at(&HeaderMap::new(), NOW_MS), None);
    }

    #[test]
    fn sanitizes_response_headers_down_to_the_allowed_logging_set() {
        let headers = headers(&[
            ("Content-Type", "application/json"),
            ("X-Request-Id", "req_123"),
            ("Authorization", "Bearer secret"),
            ("Cookie", "session=secret"),
            ("X-RateLimit-Reset", "12345"),
        ]);

        let sanitized = sanitize_response_headers_for_log(&headers);
        assert_eq!(sanitized.len(), 3);
        assert_eq!(
            sanitized.get("content-type"),
            Some(&Value::String("application/json".into()))
        );
        assert_eq!(
            sanitized.get("x-request-id"),
            Some(&Value::String("req_123".into()))
        );
        assert_eq!(
            sanitized.get("x-ratelimit-reset"),
            Some(&Value::String("12345".into()))
        );
        assert!(!sanitized.contains_key("authorization"));
        assert!(!sanitized.contains_key("cookie"));
    }

    #[test]
    fn joins_duplicate_allowed_headers_with_comma_space() {
        let headers = headers(&[("retry-after", "1"), ("retry-after", "2")]);
        let sanitized = sanitize_response_headers_for_log(&headers);
        assert_eq!(
            sanitized.get("retry-after"),
            Some(&Value::String("1, 2".into()))
        );
    }
}
