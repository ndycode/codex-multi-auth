//! Port of `lib/runtime/request-init.ts` — proxy-side request-init helpers
//! (spec 10 §11, ARCHITECTURE §6.12).
//!
//! The TS `normalizeRuntimeRequestInit` reconstructed a fetch `RequestInit`
//! from a WHATWG `Request` object; in Rust the proxy already receives the
//! method/headers/body as plain values, so the same normalization is
//! expressed over those (default method `GET`, body attached only for
//! non-GET/HEAD when readable as non-empty UTF-8; an unreadable body means
//! "proceed without it", mirroring the TS clone/read failure path).

use reqwest::header::HeaderMap;

/// The normalized shape (TS `RequestInit` subset the runtime produced).
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedRequestInit {
    pub method: String,
    pub headers: HeaderMap,
    pub body: Option<String>,
}

/// TS `normalizeRuntimeRequestInit(requestInput, requestInit)` — the
/// Request-object reconstruction half. `method` `None`/empty defaults to
/// `"GET"`; the body is attached only for non-GET/HEAD methods when it
/// decodes to non-empty UTF-8 text (TS read the cloned body as text; a
/// failed read proceeds bodyless).
pub fn normalize_runtime_request_init(
    method: Option<&str>,
    headers: &HeaderMap,
    body: Option<&[u8]>,
) -> NormalizedRequestInit {
    let method = match method {
        Some(method) if !method.is_empty() => method.to_string(),
        _ => "GET".to_string(),
    };
    let mut normalized = NormalizedRequestInit {
        method: method.clone(),
        headers: headers.clone(),
        body: None,
    };
    if method != "GET"
        && method != "HEAD"
        && let Some(bytes) = body
    {
        match std::str::from_utf8(bytes) {
            Ok(text) if !text.is_empty() => normalized.body = Some(text.to_string()),
            // Unreadable/empty body: proceed without it (TS parity).
            _ => {}
        }
    }
    normalized
}

/// TS `parseRuntimeRequestBody(body, {logWarn})` — JSON-parses the request
/// body. A falsy body (`None`/empty) returns `{}` with NO warning; a parse
/// failure logs exactly `"Failed to parse request body, using empty
/// object"` and returns `{}`.
///
/// Type note (TS parity): the TS function cast `JSON.parse`'s result to a
/// record without checking it, so non-object JSON (e.g. `42`) passed
/// through as-is — the Rust port returns `serde_json::Value` for the same
/// reason.
pub fn parse_runtime_request_body(
    body: Option<&[u8]>,
    log_warn: impl FnOnce(&str),
) -> serde_json::Value {
    let Some(bytes) = body else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    if bytes.is_empty() {
        // Falsy body (TS `if (!body) return {}`) — no warning.
        return serde_json::Value::Object(serde_json::Map::new());
    }
    match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(value) => value,
        Err(_) => {
            log_warn("Failed to parse request body, using empty object");
            serde_json::Value::Object(serde_json::Map::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_defaults_to_get_and_omits_the_body_for_get_and_head() {
        let headers = HeaderMap::new();
        let normalized = normalize_runtime_request_init(None, &headers, Some(b"{\"a\":1}"));
        assert_eq!(normalized.method, "GET");
        assert_eq!(normalized.body, None);

        let normalized = normalize_runtime_request_init(Some("HEAD"), &headers, Some(b"body"));
        assert_eq!(normalized.body, None);
    }

    #[test]
    fn normalize_attaches_a_non_empty_post_body() {
        let headers = HeaderMap::new();
        let normalized = normalize_runtime_request_init(Some("POST"), &headers, Some(b"{\"a\":1}"));
        assert_eq!(normalized.method, "POST");
        assert_eq!(normalized.body.as_deref(), Some("{\"a\":1}"));

        // Empty or unreadable bodies proceed bodyless.
        let normalized = normalize_runtime_request_init(Some("POST"), &headers, Some(b""));
        assert_eq!(normalized.body, None);
        let normalized =
            normalize_runtime_request_init(Some("POST"), &headers, Some(&[0xff, 0xfe]));
        assert_eq!(normalized.body, None);
    }

    #[test]
    fn parse_returns_empty_object_for_falsy_bodies_without_warning() {
        let mut warned = false;
        let value = parse_runtime_request_body(None, |_| warned = true);
        assert_eq!(value, json!({}));
        assert!(!warned);

        let mut warned = false;
        let value = parse_runtime_request_body(Some(b""), |_| warned = true);
        assert_eq!(value, json!({}));
        assert!(!warned);
    }

    #[test]
    fn parse_returns_the_parsed_json_value() {
        let value = parse_runtime_request_body(Some(br#"{"model":"gpt-5.5"}"#), |_| {
            panic!("no warning expected")
        });
        assert_eq!(value, json!({"model": "gpt-5.5"}));

        // Non-object JSON passes through (TS unchecked-cast parity).
        let value = parse_runtime_request_body(Some(b"42"), |_| panic!("no warning expected"));
        assert_eq!(value, json!(42));
    }

    #[test]
    fn parse_failures_warn_with_the_frozen_message_and_return_empty_object() {
        let mut message = String::new();
        let value = parse_runtime_request_body(Some(b"{ not json"), |warning| {
            message = warning.to_string();
        });
        assert_eq!(value, json!({}));
        assert_eq!(message, "Failed to parse request body, using empty object");
    }
}
