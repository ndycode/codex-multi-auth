//! Port of `lib/request/request-init.ts` — `fetch(input, init)` normalization.
//!
//! Behavior source: spec 06 §16 + the TS source (authority).
//!
//! The polymorphic web-fetch shapes collapse into concrete Rust types here:
//! - `Request | string | URL` input → [`FetchInput`] (a [`NormalizedRequest`]
//!   carries the already-buffered method/headers/url/body the proxy surface
//!   extracted from hyper);
//! - `RequestInit` → [`RequestInit`] with an optional [`BodyInit`]
//!   (string vs raw-bytes body, mirroring the TS string / Uint8Array /
//!   ArrayBuffer / view / Blob union).

use http::header::HeaderMap;
use serde_json::{Map, Value};
use url::Url;

/// The `fetch` body slot: TS `string | Uint8Array | ArrayBuffer | view | Blob`
/// collapses to text vs bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyInit {
    Text(String),
    Bytes(Vec<u8>),
}

impl BodyInit {
    /// Body text when the body is a string (TS `typeof init.body === "string"`).
    pub fn as_text(&self) -> Option<&str> {
        match self {
            BodyInit::Text(text) => Some(text),
            BodyInit::Bytes(_) => None,
        }
    }
}

/// TS `RequestInit` (the subset this pipeline carries).
#[derive(Debug, Clone, Default)]
pub struct RequestInit {
    pub method: Option<String>,
    pub headers: Option<HeaderMap>,
    pub body: Option<BodyInit>,
}

/// A fully-buffered incoming request (the `Request` object analogue).
#[derive(Debug, Clone)]
pub struct NormalizedRequest {
    pub url: String,
    pub method: String,
    pub headers: HeaderMap,
    pub body: Option<Vec<u8>>,
}

/// TS `Request | string | URL` fetch input.
#[derive(Debug, Clone)]
pub enum FetchInput<'a> {
    Url(&'a str),
    Parsed(&'a Url),
    Request(&'a NormalizedRequest),
}

/// TS `normalizeRequestInit(requestInput, requestInit)`.
///
/// - An existing `init` always wins.
/// - Non-`Request` input passes through (`None`).
/// - `Request` input yields `{ method: input.method || "GET", headers }`, plus
///   the buffered body text for non-GET/HEAD methods when non-empty.
pub fn normalize_request_init(
    input: &FetchInput<'_>,
    init: Option<RequestInit>,
) -> Option<RequestInit> {
    if init.is_some() {
        return init;
    }
    let FetchInput::Request(request) = input else {
        return None;
    };

    let method = if request.method.is_empty() {
        "GET".to_string()
    } else {
        request.method.clone()
    };
    let mut normalized = RequestInit {
        method: Some(method.clone()),
        headers: Some(request.headers.clone()),
        body: None,
    };

    if method != "GET" && method != "HEAD" {
        // TS reads `await input.clone().text()` (UTF-8 decode) and swallows
        // read failures; the buffered body is already available here.
        if let Some(bytes) = request.body.as_ref() {
            let body_text = String::from_utf8_lossy(bytes);
            if !body_text.is_empty() {
                normalized.body = Some(BodyInit::Text(body_text.into_owned()));
            }
        }
    }

    Some(normalized)
}

/// TS `parseRequestBodyFromInit(body, logWarn)`.
///
/// - Falsy body (`None`, and the empty **string** — TS `if (!body)`) → `{}`
///   silently.
/// - Empty **bytes** still attempt `JSON.parse("")` → warn + `{}` (TS quirk:
///   `new Uint8Array(0)` is truthy).
/// - Any parse failure → `logWarn("Failed to parse request body, using empty
///   object")` and `{}`.
/// - JSON that parses to a non-object is coerced to `{}` (the TS version
///   returns the raw value behind a `Record` cast; every downstream consumer
///   gates on it being a non-empty object, so this is behavior-equivalent).
pub fn parse_request_body_from_init(
    body: Option<&BodyInit>,
    log_warn: &dyn Fn(&str),
) -> Map<String, Value> {
    let Some(body) = body else {
        return Map::new();
    };
    let text: std::borrow::Cow<'_, str> = match body {
        BodyInit::Text(text) => {
            if text.is_empty() {
                return Map::new();
            }
            std::borrow::Cow::Borrowed(text.as_str())
        }
        BodyInit::Bytes(bytes) => String::from_utf8_lossy(bytes),
    };

    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        Ok(_) => Map::new(),
        Err(_) => {
            log_warn("Failed to parse request body, using empty object");
            Map::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    #[test]
    fn normalizes_a_request_when_no_init_is_provided() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        let request = NormalizedRequest {
            url: "https://example.com".into(),
            method: "POST".into(),
            headers,
            body: Some(br#"{"hello":"world"}"#.to_vec()),
        };

        let normalized = normalize_request_init(&FetchInput::Request(&request), None).unwrap();
        assert_eq!(normalized.method.as_deref(), Some("POST"));
        assert_eq!(
            normalized.body,
            Some(BodyInit::Text(r#"{"hello":"world"}"#.into()))
        );
        assert!(normalized.headers.unwrap().contains_key("content-type"));
    }

    #[test]
    fn returns_provided_init_unchanged() {
        let init = RequestInit {
            method: Some("GET".into()),
            ..Default::default()
        };
        let result =
            normalize_request_init(&FetchInput::Url("https://example.com"), Some(init)).unwrap();
        assert_eq!(result.method.as_deref(), Some("GET"));
        assert!(result.body.is_none());
    }

    #[test]
    fn passes_through_for_plain_url_input_without_init() {
        assert!(normalize_request_init(&FetchInput::Url("https://example.com"), None).is_none());
        let url = Url::parse("https://example.com").unwrap();
        assert!(normalize_request_init(&FetchInput::Parsed(&url), None).is_none());
    }

    #[test]
    fn skips_body_for_get_and_head_and_defaults_empty_method_to_get() {
        let request = NormalizedRequest {
            url: "https://example.com".into(),
            method: String::new(),
            headers: HeaderMap::new(),
            body: Some(b"ignored".to_vec()),
        };
        let normalized = normalize_request_init(&FetchInput::Request(&request), None).unwrap();
        assert_eq!(normalized.method.as_deref(), Some("GET"));
        assert!(normalized.body.is_none());
    }

    #[test]
    fn parses_multiple_body_shapes_and_warns_on_invalid_payloads() {
        let warnings: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let warn = |message: &str| warnings.borrow_mut().push(message.to_string());

        assert_eq!(
            Value::Object(parse_request_body_from_init(
                Some(&BodyInit::Text(r#"{"a":1}"#.into())),
                &warn
            )),
            json!({ "a": 1 })
        );
        assert_eq!(
            Value::Object(parse_request_body_from_init(
                Some(&BodyInit::Bytes(br#"{"b":2}"#.to_vec())),
                &warn
            )),
            json!({ "b": 2 })
        );
        assert!(warnings.borrow().is_empty());

        assert!(
            parse_request_body_from_init(Some(&BodyInit::Text("not json".into())), &warn)
                .is_empty()
        );
        assert_eq!(
            warnings.borrow().as_slice(),
            ["Failed to parse request body, using empty object"]
        );
    }

    #[test]
    fn falsy_and_empty_bodies_follow_ts_truthiness() {
        let warnings: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let warn = |message: &str| warnings.borrow_mut().push(message.to_string());

        // None and "" are falsy → {} without warning.
        assert!(parse_request_body_from_init(None, &warn).is_empty());
        assert!(
            parse_request_body_from_init(Some(&BodyInit::Text(String::new())), &warn).is_empty()
        );
        assert!(warnings.borrow().is_empty());

        // Empty byte arrays are truthy in TS → JSON.parse("") fails → warn.
        assert!(parse_request_body_from_init(Some(&BodyInit::Bytes(Vec::new())), &warn).is_empty());
        assert_eq!(warnings.borrow().len(), 1);
    }

    #[test]
    fn non_object_json_coerces_to_empty_map_without_warning() {
        let warnings: RefCell<Vec<String>> = RefCell::new(Vec::new());
        let warn = |message: &str| warnings.borrow_mut().push(message.to_string());
        assert!(parse_request_body_from_init(Some(&BodyInit::Text("5".into())), &warn).is_empty());
        assert!(warnings.borrow().is_empty());
    }
}
