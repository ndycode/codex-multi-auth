//! Port of `lib/errors.ts` — the typed error hierarchy for the Codex plugin.
//!
//! The TS class hierarchy (`CodexError` base + Api/Auth/Network/Validation/
//! RateLimit/Storage/Unavailable subclasses) is modeled as one enum with
//! accessor impls (ARCHITECTURE §6.1). All `code` strings and the TS class
//! `name` strings are load-bearing and FROZEN — modules branch on them.
//!
//! Gotcha 21 (spec 01 §11): [`is_codex_unavailable_error`] must match on the
//! `"CODEX_UNAVAILABLE"` code STRING, not only the concrete variant, so a
//! generic error carrying the structural marker still matches (the Rust
//! equivalent of the TS cross-realm guard).

use std::collections::HashMap;
use std::error::Error as StdError;

use serde_json::{Map, Value};

/// Chained underlying cause (TS `cause`).
pub type ErrorCause = Box<dyn StdError + Send + Sync + 'static>;

/// Arbitrary structured context data (TS `context?: Record<string, unknown>`).
pub type ErrorContext = Map<String, Value>;

/// Error codes for categorizing errors (TS `ErrorCode` const object).
pub struct ErrorCode;

impl ErrorCode {
    pub const NETWORK_ERROR: &'static str = "CODEX_NETWORK_ERROR";
    pub const API_ERROR: &'static str = "CODEX_API_ERROR";
    pub const AUTH_ERROR: &'static str = "CODEX_AUTH_ERROR";
    pub const VALIDATION_ERROR: &'static str = "CODEX_VALIDATION_ERROR";
    pub const RATE_LIMIT: &'static str = "CODEX_RATE_LIMIT";
    pub const TIMEOUT: &'static str = "CODEX_TIMEOUT";
    pub const CODEX_UNAVAILABLE: &'static str = "CODEX_UNAVAILABLE";
}

/// The Codex error family. One variant per TS class:
///
/// | Variant        | TS class                | default `code`            |
/// |----------------|-------------------------|---------------------------|
/// | `Base`         | `CodexError`            | `CODEX_API_ERROR`         |
/// | `Api`          | `CodexApiError`         | `CODEX_API_ERROR`         |
/// | `Auth`         | `CodexAuthError`        | `CODEX_AUTH_ERROR`        |
/// | `Network`      | `CodexNetworkError`     | `CODEX_NETWORK_ERROR`     |
/// | `Validation`   | `CodexValidationError`  | `CODEX_VALIDATION_ERROR`  |
/// | `RateLimit`    | `CodexRateLimitError`   | `CODEX_RATE_LIMIT`        |
/// | `Storage`      | `StorageError`          | (caller-supplied)         |
/// | `Unavailable`  | `CodexUnavailableError` | `CODEX_UNAVAILABLE`       |
#[derive(Debug, thiserror::Error)]
pub enum CodexError {
    /// Base `CodexError`.
    #[error("{message}")]
    Base {
        message: String,
        code: String,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
    /// `CodexApiError` — HTTP/API response errors.
    #[error("{message}")]
    Api {
        message: String,
        code: String,
        status: u16,
        headers: Option<HashMap<String, String>>,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
    /// `CodexAuthError` — authentication failures. `retryable` defaults FALSE.
    #[error("{message}")]
    Auth {
        message: String,
        code: String,
        account_id: Option<String>,
        retryable: bool,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
    /// `CodexNetworkError` — network/connection failures. `retryable` defaults TRUE.
    #[error("{message}")]
    Network {
        message: String,
        code: String,
        retryable: bool,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
    /// `CodexValidationError` — input validation failures.
    #[error("{message}")]
    Validation {
        message: String,
        code: String,
        field: Option<String>,
        expected: Option<String>,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
    /// `CodexRateLimitError` — rate limit exceeded.
    #[error("{message}")]
    RateLimit {
        message: String,
        code: String,
        retry_after_ms: Option<i64>,
        account_id: Option<String>,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
    /// `StorageError` — filesystem code (e.g. `"UNREADABLE"`), target path, and
    /// user-facing hint. Built via the positional ctor [`CodexError::storage`].
    #[error("{message}")]
    Storage {
        message: String,
        code: String,
        path: String,
        hint: String,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
    /// `CodexUnavailableError` — account signed in but no Codex entitlement.
    /// A warning, not a failure.
    #[error("{message}")]
    Unavailable {
        message: String,
        code: String,
        context: Option<ErrorContext>,
        #[source]
        cause: Option<ErrorCause>,
    },
}

impl CodexError {
    // ---- constructors (defaults mirror the TS constructors exactly) ----

    /// `new CodexError(message)` — default code `CODEX_API_ERROR`.
    pub fn new(message: impl Into<String>) -> Self {
        CodexError::Base {
            message: message.into(),
            code: ErrorCode::API_ERROR.to_string(),
            context: None,
            cause: None,
        }
    }

    /// `new CodexApiError(message, { status })` — default code `CODEX_API_ERROR`.
    pub fn api(message: impl Into<String>, status: u16) -> Self {
        CodexError::Api {
            message: message.into(),
            code: ErrorCode::API_ERROR.to_string(),
            status,
            headers: None,
            context: None,
            cause: None,
        }
    }

    /// `new CodexAuthError(message)` — default code `CODEX_AUTH_ERROR`,
    /// `retryable` defaults to **false**.
    pub fn auth(message: impl Into<String>) -> Self {
        CodexError::Auth {
            message: message.into(),
            code: ErrorCode::AUTH_ERROR.to_string(),
            account_id: None,
            retryable: false,
            context: None,
            cause: None,
        }
    }

    /// `new CodexNetworkError(message)` — default code `CODEX_NETWORK_ERROR`,
    /// `retryable` defaults to **true**.
    pub fn network(message: impl Into<String>) -> Self {
        CodexError::Network {
            message: message.into(),
            code: ErrorCode::NETWORK_ERROR.to_string(),
            retryable: true,
            context: None,
            cause: None,
        }
    }

    /// `new CodexValidationError(message)` — default code `CODEX_VALIDATION_ERROR`.
    pub fn validation(message: impl Into<String>) -> Self {
        CodexError::Validation {
            message: message.into(),
            code: ErrorCode::VALIDATION_ERROR.to_string(),
            field: None,
            expected: None,
            context: None,
            cause: None,
        }
    }

    /// `new CodexRateLimitError(message)` — default code `CODEX_RATE_LIMIT`.
    pub fn rate_limit(message: impl Into<String>) -> Self {
        CodexError::RateLimit {
            message: message.into(),
            code: ErrorCode::RATE_LIMIT.to_string(),
            retry_after_ms: None,
            account_id: None,
            context: None,
            cause: None,
        }
    }

    /// `new StorageError(message, code, path, hint, cause?)` — POSITIONAL ctor
    /// (spec 01 §2.7). config.ts uses code `"UNREADABLE"`.
    pub fn storage(
        message: impl Into<String>,
        code: impl Into<String>,
        path: impl Into<String>,
        hint: impl Into<String>,
        cause: Option<ErrorCause>,
    ) -> Self {
        CodexError::Storage {
            message: message.into(),
            code: code.into(),
            path: path.into(),
            hint: hint.into(),
            context: None,
            cause,
        }
    }

    /// `new CodexUnavailableError(message)` — default code `CODEX_UNAVAILABLE`.
    pub fn unavailable(message: impl Into<String>) -> Self {
        CodexError::Unavailable {
            message: message.into(),
            code: ErrorCode::CODEX_UNAVAILABLE.to_string(),
            context: None,
            cause: None,
        }
    }

    // ---- builder-style option setters (the TS options bag) ----

    /// Overrides the `code` (any variant; TS `options.code`).
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        *self.code_slot() = code.into();
        self
    }

    /// Attaches arbitrary context data (any variant; TS `options.context`).
    pub fn with_context(mut self, context: ErrorContext) -> Self {
        *self.context_slot() = Some(context);
        self
    }

    /// Chains an underlying cause (any variant; TS `options.cause`).
    pub fn with_cause(mut self, cause: impl Into<ErrorCause>) -> Self {
        *self.cause_slot() = Some(cause.into());
        self
    }

    /// Attaches response headers (`Api` variant only; no-op elsewhere).
    pub fn with_headers(mut self, value: HashMap<String, String>) -> Self {
        if let CodexError::Api { headers, .. } = &mut self {
            *headers = Some(value);
        }
        self
    }

    /// Sets `accountId` (`Auth` / `RateLimit` variants only; no-op elsewhere).
    pub fn with_account_id(mut self, value: impl Into<String>) -> Self {
        match &mut self {
            CodexError::Auth { account_id, .. } | CodexError::RateLimit { account_id, .. } => {
                *account_id = Some(value.into());
            }
            _ => {}
        }
        self
    }

    /// Sets `retryable` (`Auth` / `Network` variants only; no-op elsewhere).
    pub fn with_retryable(mut self, value: bool) -> Self {
        match &mut self {
            CodexError::Auth { retryable, .. } | CodexError::Network { retryable, .. } => {
                *retryable = value;
            }
            _ => {}
        }
        self
    }

    /// Sets `field` (`Validation` variant only; no-op elsewhere).
    pub fn with_field(mut self, value: impl Into<String>) -> Self {
        if let CodexError::Validation { field, .. } = &mut self {
            *field = Some(value.into());
        }
        self
    }

    /// Sets `expected` (`Validation` variant only; no-op elsewhere).
    pub fn with_expected(mut self, value: impl Into<String>) -> Self {
        if let CodexError::Validation { expected, .. } = &mut self {
            *expected = Some(value.into());
        }
        self
    }

    /// Sets `retryAfterMs` (`RateLimit` variant only; no-op elsewhere).
    pub fn with_retry_after_ms(mut self, value: i64) -> Self {
        if let CodexError::RateLimit { retry_after_ms, .. } = &mut self {
            *retry_after_ms = Some(value);
        }
        self
    }

    // ---- accessors ----

    /// The TS class name (`error.name`). FROZEN strings used in logs/output.
    pub fn name(&self) -> &'static str {
        match self {
            CodexError::Base { .. } => "CodexError",
            CodexError::Api { .. } => "CodexApiError",
            CodexError::Auth { .. } => "CodexAuthError",
            CodexError::Network { .. } => "CodexNetworkError",
            CodexError::Validation { .. } => "CodexValidationError",
            CodexError::RateLimit { .. } => "CodexRateLimitError",
            CodexError::Storage { .. } => "StorageError",
            CodexError::Unavailable { .. } => "CodexUnavailableError",
        }
    }

    /// The error `code` string other modules branch on.
    pub fn code(&self) -> &str {
        match self {
            CodexError::Base { code, .. }
            | CodexError::Api { code, .. }
            | CodexError::Auth { code, .. }
            | CodexError::Network { code, .. }
            | CodexError::Validation { code, .. }
            | CodexError::RateLimit { code, .. }
            | CodexError::Storage { code, .. }
            | CodexError::Unavailable { code, .. } => code,
        }
    }

    /// The error message (`error.message`; also the `Display` output).
    pub fn message(&self) -> &str {
        match self {
            CodexError::Base { message, .. }
            | CodexError::Api { message, .. }
            | CodexError::Auth { message, .. }
            | CodexError::Network { message, .. }
            | CodexError::Validation { message, .. }
            | CodexError::RateLimit { message, .. }
            | CodexError::Storage { message, .. }
            | CodexError::Unavailable { message, .. } => message,
        }
    }

    /// Structured context data, when attached.
    pub fn context(&self) -> Option<&ErrorContext> {
        match self {
            CodexError::Base { context, .. }
            | CodexError::Api { context, .. }
            | CodexError::Auth { context, .. }
            | CodexError::Network { context, .. }
            | CodexError::Validation { context, .. }
            | CodexError::RateLimit { context, .. }
            | CodexError::Storage { context, .. }
            | CodexError::Unavailable { context, .. } => context.as_ref(),
        }
    }

    /// HTTP status (`Api` variant).
    pub fn status(&self) -> Option<u16> {
        match self {
            CodexError::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Response headers (`Api` variant).
    pub fn headers(&self) -> Option<&HashMap<String, String>> {
        match self {
            CodexError::Api { headers, .. } => headers.as_ref(),
            _ => None,
        }
    }

    /// Account id (`Auth` / `RateLimit` variants).
    pub fn account_id(&self) -> Option<&str> {
        match self {
            CodexError::Auth { account_id, .. } | CodexError::RateLimit { account_id, .. } => {
                account_id.as_deref()
            }
            _ => None,
        }
    }

    /// Retryability flag. `Some` only for the variants that carry one
    /// (`Auth` — default false; `Network` — default true).
    pub fn retryable(&self) -> Option<bool> {
        match self {
            CodexError::Auth { retryable, .. } | CodexError::Network { retryable, .. } => {
                Some(*retryable)
            }
            _ => None,
        }
    }

    /// Failing field name (`Validation` variant).
    pub fn field(&self) -> Option<&str> {
        match self {
            CodexError::Validation { field, .. } => field.as_deref(),
            _ => None,
        }
    }

    /// Expected-value description (`Validation` variant).
    pub fn expected(&self) -> Option<&str> {
        match self {
            CodexError::Validation { expected, .. } => expected.as_deref(),
            _ => None,
        }
    }

    /// Retry-after hint in ms (`RateLimit` variant).
    pub fn retry_after_ms(&self) -> Option<i64> {
        match self {
            CodexError::RateLimit { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }

    /// Target path (`Storage` variant).
    pub fn path(&self) -> Option<&str> {
        match self {
            CodexError::Storage { path, .. } => Some(path),
            _ => None,
        }
    }

    /// User-facing hint (`Storage` variant).
    pub fn hint(&self) -> Option<&str> {
        match self {
            CodexError::Storage { hint, .. } => Some(hint),
            _ => None,
        }
    }

    /// Structural check on the CODE STRING (spec 01 gotcha 21) — matches any
    /// variant whose code is `"CODEX_UNAVAILABLE"`, not just `Unavailable`.
    pub fn is_codex_unavailable(&self) -> bool {
        self.code() == ErrorCode::CODEX_UNAVAILABLE
    }

    // ---- private slot helpers ----

    fn code_slot(&mut self) -> &mut String {
        match self {
            CodexError::Base { code, .. }
            | CodexError::Api { code, .. }
            | CodexError::Auth { code, .. }
            | CodexError::Network { code, .. }
            | CodexError::Validation { code, .. }
            | CodexError::RateLimit { code, .. }
            | CodexError::Storage { code, .. }
            | CodexError::Unavailable { code, .. } => code,
        }
    }

    fn context_slot(&mut self) -> &mut Option<ErrorContext> {
        match self {
            CodexError::Base { context, .. }
            | CodexError::Api { context, .. }
            | CodexError::Auth { context, .. }
            | CodexError::Network { context, .. }
            | CodexError::Validation { context, .. }
            | CodexError::RateLimit { context, .. }
            | CodexError::Storage { context, .. }
            | CodexError::Unavailable { context, .. } => context,
        }
    }

    fn cause_slot(&mut self) -> &mut Option<ErrorCause> {
        match self {
            CodexError::Base { cause, .. }
            | CodexError::Api { cause, .. }
            | CodexError::Auth { cause, .. }
            | CodexError::Network { cause, .. }
            | CodexError::Validation { cause, .. }
            | CodexError::RateLimit { cause, .. }
            | CodexError::Storage { cause, .. }
            | CodexError::Unavailable { cause, .. } => cause,
        }
    }
}

/// Type guard for `CodexUnavailableError` (TS `isCodexUnavailableError`).
///
/// Matches on the structural `"CODEX_UNAVAILABLE"` code marker so it survives
/// the Rust analogue of cross-realm/duplicate-module identity loss: ANY
/// [`CodexError`] variant carrying that code matches, not just
/// [`CodexError::Unavailable`].
pub fn is_codex_unavailable_error(error: &(dyn StdError + 'static)) -> bool {
    error
        .downcast_ref::<CodexError>()
        .is_some_and(CodexError::is_codex_unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_match_ts() {
        assert_eq!(ErrorCode::NETWORK_ERROR, "CODEX_NETWORK_ERROR");
        assert_eq!(ErrorCode::API_ERROR, "CODEX_API_ERROR");
        assert_eq!(ErrorCode::AUTH_ERROR, "CODEX_AUTH_ERROR");
        assert_eq!(ErrorCode::VALIDATION_ERROR, "CODEX_VALIDATION_ERROR");
        assert_eq!(ErrorCode::RATE_LIMIT, "CODEX_RATE_LIMIT");
        assert_eq!(ErrorCode::TIMEOUT, "CODEX_TIMEOUT");
        assert_eq!(ErrorCode::CODEX_UNAVAILABLE, "CODEX_UNAVAILABLE");
    }

    #[test]
    fn base_error_defaults_to_api_error_code() {
        let error = CodexError::new("Test error");
        assert_eq!(error.message(), "Test error");
        assert_eq!(error.name(), "CodexError");
        assert_eq!(error.code(), ErrorCode::API_ERROR);
        assert_eq!(error.to_string(), "Test error");
    }

    #[test]
    fn base_error_accepts_custom_code() {
        let error = CodexError::new("Test error").with_code(ErrorCode::TIMEOUT);
        assert_eq!(error.code(), ErrorCode::TIMEOUT);
    }

    #[test]
    fn base_error_accepts_cause_for_chaining() {
        let cause = std::io::Error::other("Original error");
        let error = CodexError::new("Wrapped error").with_cause(cause);
        let source = error.source().expect("cause should chain via source()");
        assert_eq!(source.to_string(), "Original error");
    }

    #[test]
    fn base_error_accepts_context_data() {
        let mut context = ErrorContext::new();
        context.insert("accountId".into(), Value::from("123"));
        context.insert("attempt".into(), Value::from(2));
        let error = CodexError::new("Test error").with_context(context.clone());
        assert_eq!(error.context(), Some(&context));
    }

    #[test]
    fn api_error_carries_status_and_headers() {
        let error = CodexError::api("Not found", 404);
        assert_eq!(error.message(), "Not found");
        assert_eq!(error.name(), "CodexApiError");
        assert_eq!(error.status(), Some(404));
        assert_eq!(error.code(), ErrorCode::API_ERROR);

        let mut headers = HashMap::new();
        headers.insert("retry-after".to_string(), "60".to_string());
        headers.insert("x-request-id".to_string(), "abc123".to_string());
        let error = CodexError::api("Rate limited", 429).with_headers(headers.clone());
        assert_eq!(error.headers(), Some(&headers));
    }

    #[test]
    fn api_error_accepts_custom_code_and_cause() {
        let error = CodexError::api("Custom", 500).with_code(ErrorCode::TIMEOUT);
        assert_eq!(error.code(), ErrorCode::TIMEOUT);

        let cause = std::io::Error::other("Network failure");
        let error = CodexError::api("API failed", 503).with_cause(cause);
        assert!(error.source().is_some());
    }

    #[test]
    fn auth_error_defaults() {
        let error = CodexError::auth("Token expired");
        assert_eq!(error.message(), "Token expired");
        assert_eq!(error.name(), "CodexAuthError");
        assert_eq!(error.code(), ErrorCode::AUTH_ERROR);
        assert_eq!(error.retryable(), Some(false));
        assert_eq!(error.account_id(), None);
    }

    #[test]
    fn auth_error_accepts_account_id_and_retryable() {
        let error = CodexError::auth("Invalid token").with_account_id("user@example.com");
        assert_eq!(error.account_id(), Some("user@example.com"));

        let error = CodexError::auth("Temporary failure").with_retryable(true);
        assert_eq!(error.retryable(), Some(true));
    }

    #[test]
    fn network_error_defaults() {
        let error = CodexError::network("Connection refused");
        assert_eq!(error.message(), "Connection refused");
        assert_eq!(error.name(), "CodexNetworkError");
        assert_eq!(error.code(), ErrorCode::NETWORK_ERROR);
        assert_eq!(error.retryable(), Some(true));

        let error = CodexError::network("Permanent DNS failure").with_retryable(false);
        assert_eq!(error.retryable(), Some(false));
    }

    #[test]
    fn validation_error_fields() {
        let error = CodexError::validation("Invalid input");
        assert_eq!(error.name(), "CodexValidationError");
        assert_eq!(error.code(), ErrorCode::VALIDATION_ERROR);
        assert_eq!(error.field(), None);
        assert_eq!(error.expected(), None);

        let error = CodexError::validation("Invalid type")
            .with_field("age")
            .with_expected("number");
        assert_eq!(error.field(), Some("age"));
        assert_eq!(error.expected(), Some("number"));
    }

    #[test]
    fn rate_limit_error_fields() {
        let error = CodexError::rate_limit("Rate limited");
        assert_eq!(error.name(), "CodexRateLimitError");
        assert_eq!(error.code(), ErrorCode::RATE_LIMIT);
        assert_eq!(error.retry_after_ms(), None);
        assert_eq!(error.account_id(), None);

        let error = CodexError::rate_limit("Account limited")
            .with_account_id("user@example.com")
            .with_retry_after_ms(30_000);
        assert_eq!(error.account_id(), Some("user@example.com"));
        assert_eq!(error.retry_after_ms(), Some(30_000));
    }

    #[test]
    fn storage_error_positional_ctor() {
        let error = CodexError::storage(
            "Aborting config save because /tmp/config.json is unreadable.",
            "UNREADABLE",
            "/tmp/config.json",
            "Fix or remove the unreadable config file, then retry the save.",
            Some(Box::new(std::io::Error::other("EACCES"))),
        );
        assert_eq!(error.name(), "StorageError");
        assert_eq!(error.code(), "UNREADABLE");
        assert_eq!(error.path(), Some("/tmp/config.json"));
        assert_eq!(
            error.hint(),
            Some("Fix or remove the unreadable config file, then retry the save.")
        );
        assert!(error.source().is_some());
    }

    #[test]
    fn unavailable_error_exposes_code_and_preserves_cause() {
        let cause = std::io::Error::other("all models unsupported");
        let error = CodexError::unavailable("Codex not available").with_cause(cause);
        assert_eq!(error.name(), "CodexUnavailableError");
        assert_eq!(error.code(), ErrorCode::CODEX_UNAVAILABLE);
        assert_eq!(error.message(), "Codex not available");
        assert_eq!(
            error.source().unwrap().to_string(),
            "all models unsupported"
        );
    }

    #[test]
    fn is_codex_unavailable_matches_instances_and_structural_code_marker() {
        let instance = CodexError::unavailable("x");
        assert!(is_codex_unavailable_error(&instance));

        // Cross-realm / duplicate-module guard: a generic error carrying the code.
        let structural = CodexError::new("x").with_code(ErrorCode::CODEX_UNAVAILABLE);
        assert!(is_codex_unavailable_error(&structural));
        assert!(structural.is_codex_unavailable());
    }

    #[test]
    fn is_codex_unavailable_rejects_unrelated_errors() {
        assert!(!is_codex_unavailable_error(&CodexError::api("x", 400)));
        assert!(!is_codex_unavailable_error(&CodexError::new("x")));
        let io_error = std::io::Error::other("x");
        assert!(!is_codex_unavailable_error(&io_error));
    }

    #[test]
    fn display_is_message_only() {
        // Frozen user-visible behavior: Display never prepends the name/code.
        let error = CodexError::auth("Failed to refresh token, authentication required");
        assert_eq!(
            format!("{error}"),
            "Failed to refresh token, authentication required"
        );
    }
}
