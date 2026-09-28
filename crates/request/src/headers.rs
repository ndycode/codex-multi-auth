//! Port of `lib/request/headers.ts` — Codex request-header construction.
//!
//! Behavior source: spec 06 §8 + the TS source (authority). `fetch_helpers`
//! re-exports this module's public surface, mirroring the TS re-export
//! contract.
//!
//! Dual-call contract: the TS `createCodexHeaders` is overloaded
//! (named-params object OR positional args) and throws
//! `TypeError("createCodexHeaders requires accountId and accessToken")` when
//! either credential is missing/empty. Rust has no runtime overloading, so
//! both entry points exist as separate functions sharing one validation path
//! that surfaces the frozen message as an [`ArgError`] (the workspace-wide
//! `TypeError` analogue, ARCHITECTURE §8.2).

use cma_core::constants::{OPENAI_HEADERS, OPENAI_HEADER_VALUES};
use cma_core::logger::log_warn;
use http::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};

/// Plain argument error carrying a frozen TS `TypeError` message
/// (deliberately NOT a `CodexError` — ARCHITECTURE §8.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgError {
    message: String,
}

impl ArgError {
    /// Create an [`ArgError`] with the given frozen message.
    pub fn new(message: impl Into<String>) -> Self {
        ArgError {
            message: message.into(),
        }
    }

    /// The frozen message text.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for ArgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ArgError {}

/// TS `CreateCodexHeadersOptions`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CreateCodexHeadersOptions {
    pub model: Option<String>,
    pub prompt_cache_key: Option<String>,
}

/// TS `CreateCodexHeadersParams` (named-parameter call form).
#[derive(Debug, Clone, Default)]
pub struct CreateCodexHeadersParams {
    pub init_headers: Option<HeaderMap>,
    pub account_id: String,
    pub access_token: String,
    pub opts: Option<CreateCodexHeadersOptions>,
}

/// Named-parameter form of `createCodexHeaders`.
pub fn create_codex_headers(params: &CreateCodexHeadersParams) -> Result<HeaderMap, ArgError> {
    create_codex_headers_positional(
        params.init_headers.as_ref(),
        &params.account_id,
        &params.access_token,
        params.opts.as_ref(),
    )
}

/// Positional form of `createCodexHeaders`.
///
/// Construction order (exact TS parity):
/// 1. delete `x-api-key`;
/// 2. `Authorization: Bearer {accessToken}`;
/// 3. `chatgpt-account-id: {accountId}`;
/// 4. `OpenAI-Beta: responses=experimental`;
/// 5. `originator: codex_cli_rs`;
/// 6. if `opts.promptCacheKey` (truthy — empty string counts as absent): set
///    BOTH `conversation_id` and `session_id` to it; else DELETE both;
/// 7. `accept: text/event-stream`.
pub fn create_codex_headers_positional(
    init_headers: Option<&HeaderMap>,
    account_id: &str,
    access_token: &str,
    opts: Option<&CreateCodexHeadersOptions>,
) -> Result<HeaderMap, ArgError> {
    if account_id.is_empty() || access_token.is_empty() {
        return Err(ArgError::new(
            "createCodexHeaders requires accountId and accessToken",
        ));
    }

    let mut headers = init_headers.cloned().unwrap_or_default();
    headers.remove("x-api-key");
    set_header(
        &mut headers,
        "authorization",
        &format!("Bearer {access_token}"),
    )?;
    set_header(&mut headers, OPENAI_HEADERS.account_id, account_id)?;
    set_header(
        &mut headers,
        OPENAI_HEADERS.beta,
        OPENAI_HEADER_VALUES.beta_responses,
    )?;
    set_header(
        &mut headers,
        OPENAI_HEADERS.originator,
        OPENAI_HEADER_VALUES.originator_codex,
    )?;

    let cache_key = opts
        .and_then(|o| o.prompt_cache_key.as_deref())
        .filter(|key| !key.is_empty());
    match cache_key {
        Some(key) => {
            set_header(&mut headers, OPENAI_HEADERS.conversation_id, key)?;
            set_header(&mut headers, OPENAI_HEADERS.session_id, key)?;
        }
        None => {
            headers.remove(OPENAI_HEADERS.conversation_id);
            headers.remove(OPENAI_HEADERS.session_id);
        }
    }
    set_header(&mut headers, "accept", "text/event-stream")?;
    Ok(headers)
}

/// `headers.set(...)` analogue: replaces every existing value for the name.
/// Invalid header material maps to the closest `TypeError` analogue (the TS
/// `Headers.set` would throw a `TypeError` for invalid bytes as well).
fn set_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), ArgError> {
    let name = HeaderName::try_from(name).map_err(|_| ArgError::new("Invalid header name"))?;
    let value = HeaderValue::from_str(value).map_err(|_| ArgError::new("Invalid header value"))?;
    headers.insert(name, value);
    Ok(())
}

/// Log RFC 8594 `Deprecation`/`Sunset` headers if present. Shared by the
/// success and error response handlers so a sunset notice is surfaced
/// regardless of status (request-01).
pub fn log_deprecation_headers(headers: &HeaderMap) {
    let deprecation = header_value_or_null(headers, "deprecation");
    let sunset = header_value_or_null(headers, "sunset");
    if deprecation != Value::Null || sunset != Value::Null {
        log_warn(
            "API deprecation notice",
            Some(&json!({ "deprecation": deprecation, "sunset": sunset })),
        );
    }
}

fn header_value_or_null(headers: &HeaderMap, name: &str) -> Value {
    match headers.get(name) {
        Some(value) => Value::String(String::from_utf8_lossy(value.as_bytes()).into_owned()),
        None => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT_ID: &str = "test-account-123";
    const ACCESS_TOKEN: &str = "test-access-token";

    fn get<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        headers.get(name).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn creates_headers_with_all_required_fields_when_cache_key_provided() {
        let headers = create_codex_headers_positional(
            None,
            ACCOUNT_ID,
            ACCESS_TOKEN,
            Some(&CreateCodexHeadersOptions {
                model: Some("gpt-5-codex".into()),
                prompt_cache_key: Some("session-1".into()),
            }),
        )
        .unwrap();

        assert_eq!(
            get(&headers, "authorization"),
            Some(format!("Bearer {ACCESS_TOKEN}").as_str())
        );
        assert_eq!(get(&headers, OPENAI_HEADERS.account_id), Some(ACCOUNT_ID));
        assert_eq!(
            get(&headers, OPENAI_HEADERS.beta),
            Some(OPENAI_HEADER_VALUES.beta_responses)
        );
        assert_eq!(
            get(&headers, OPENAI_HEADERS.originator),
            Some(OPENAI_HEADER_VALUES.originator_codex)
        );
        assert_eq!(get(&headers, OPENAI_HEADERS.session_id), Some("session-1"));
        assert_eq!(
            get(&headers, OPENAI_HEADERS.conversation_id),
            Some("session-1")
        );
        assert_eq!(get(&headers, "accept"), Some("text/event-stream"));
    }

    #[test]
    fn removes_x_api_key_header() {
        let mut init = HeaderMap::new();
        init.insert("x-api-key", "should-be-removed".parse().unwrap());
        let headers = create_codex_headers_positional(
            Some(&init),
            ACCOUNT_ID,
            ACCESS_TOKEN,
            Some(&CreateCodexHeadersOptions {
                model: Some("gpt-5".into()),
                prompt_cache_key: Some("session-2".into()),
            }),
        )
        .unwrap();
        assert!(!headers.contains_key("x-api-key"));
    }

    #[test]
    fn preserves_other_existing_headers() {
        let mut init = HeaderMap::new();
        init.insert("content-type", "application/json".parse().unwrap());
        let headers = create_codex_headers_positional(
            Some(&init),
            ACCOUNT_ID,
            ACCESS_TOKEN,
            Some(&CreateCodexHeadersOptions {
                model: Some("gpt-5".into()),
                prompt_cache_key: Some("session-3".into()),
            }),
        )
        .unwrap();
        assert_eq!(get(&headers, "content-type"), Some("application/json"));
    }

    #[test]
    fn uses_prompt_cache_key_for_both_conversation_and_session_ids() {
        let key = "ses_abc123";
        let headers = create_codex_headers_positional(
            None,
            ACCOUNT_ID,
            ACCESS_TOKEN,
            Some(&CreateCodexHeadersOptions {
                model: None,
                prompt_cache_key: Some(key.into()),
            }),
        )
        .unwrap();
        assert_eq!(get(&headers, OPENAI_HEADERS.conversation_id), Some(key));
        assert_eq!(get(&headers, OPENAI_HEADERS.session_id), Some(key));
    }

    #[test]
    fn does_not_set_conversation_or_session_headers_without_cache_key() {
        let headers = create_codex_headers_positional(
            None,
            ACCOUNT_ID,
            ACCESS_TOKEN,
            Some(&CreateCodexHeadersOptions {
                model: Some("gpt-5".into()),
                prompt_cache_key: None,
            }),
        )
        .unwrap();
        assert!(headers.get(OPENAI_HEADERS.conversation_id).is_none());
        assert!(headers.get(OPENAI_HEADERS.session_id).is_none());
    }

    #[test]
    fn deletes_stale_conversation_and_session_headers_without_cache_key() {
        // Spec 06 gotcha 18: don't leave stale values from the incoming init.
        let mut init = HeaderMap::new();
        init.insert(OPENAI_HEADERS.conversation_id, "stale".parse().unwrap());
        init.insert(OPENAI_HEADERS.session_id, "stale".parse().unwrap());
        let headers =
            create_codex_headers_positional(Some(&init), ACCOUNT_ID, ACCESS_TOKEN, None).unwrap();
        assert!(headers.get(OPENAI_HEADERS.conversation_id).is_none());
        assert!(headers.get(OPENAI_HEADERS.session_id).is_none());
    }

    #[test]
    fn empty_prompt_cache_key_is_treated_as_absent() {
        // TS truthiness: `if (cacheKey)` — "" falls to the delete branch.
        let headers = create_codex_headers_positional(
            None,
            ACCOUNT_ID,
            ACCESS_TOKEN,
            Some(&CreateCodexHeadersOptions {
                model: None,
                prompt_cache_key: Some(String::new()),
            }),
        )
        .unwrap();
        assert!(headers.get(OPENAI_HEADERS.conversation_id).is_none());
        assert!(headers.get(OPENAI_HEADERS.session_id).is_none());
    }

    #[test]
    fn named_parameter_form_matches_positional_form() {
        let positional = create_codex_headers_positional(
            None,
            ACCOUNT_ID,
            ACCESS_TOKEN,
            Some(&CreateCodexHeadersOptions {
                model: Some("gpt-5".into()),
                prompt_cache_key: Some("session-named".into()),
            }),
        )
        .unwrap();
        let named = create_codex_headers(&CreateCodexHeadersParams {
            init_headers: None,
            account_id: ACCOUNT_ID.into(),
            access_token: ACCESS_TOKEN.into(),
            opts: Some(CreateCodexHeadersOptions {
                model: Some("gpt-5".into()),
                prompt_cache_key: Some("session-named".into()),
            }),
        })
        .unwrap();
        assert_eq!(positional, named);
        assert!(!named.contains_key("x-api-key"));
    }

    #[test]
    fn missing_credentials_yield_frozen_type_error_message() {
        let err = create_codex_headers_positional(None, "", ACCESS_TOKEN, None).unwrap_err();
        assert_eq!(
            err.message(),
            "createCodexHeaders requires accountId and accessToken"
        );
        let err = create_codex_headers_positional(None, ACCOUNT_ID, "", None).unwrap_err();
        assert_eq!(
            err.message(),
            "createCodexHeaders requires accountId and accessToken"
        );
        let err = create_codex_headers(&CreateCodexHeadersParams::default()).unwrap_err();
        assert_eq!(
            err.message(),
            "createCodexHeaders requires accountId and accessToken"
        );
    }
}
