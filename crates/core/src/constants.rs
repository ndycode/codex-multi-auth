//! Port of `lib/constants.ts` + `lib/runtime-constants.ts`.
//!
//! Pure constants used throughout the plugin. All user-visible strings are
//! FROZEN — they must match the TypeScript source byte-for-byte (spec 01 §2.1,
//! spec 14 §8).

use serde::{Deserialize, Serialize};

/// Plugin identifier for logging and error messages.
pub const PLUGIN_NAME: &str = "codex-multi-auth";

/// Base URL for ChatGPT backend API.
pub const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";

/// Dummy API key used for the OpenAI SDK (actual auth via OAuth).
pub const DUMMY_API_KEY: &str = "chatgpt-oauth";

/// Provider ID for UI display — shows under "OpenAI" in the auth dropdown.
pub const PROVIDER_ID: &str = "openai";

/// Upper bound for any rate-limit / retry-after window we will honor. A single
/// hostile or buggy upstream value (seconds-vs-ms confusion, anti-abuse
/// misfire) must never be able to wedge an account unavailable for longer than
/// this. `7 * 24 * 60 * 60 * 1000`.
pub const MAX_RATE_LIMIT_DELAY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// HTTP status codes (TS `HTTP_STATUS`). Field names are the snake_case forms
/// of the original SCREAMING_SNAKE keys.
#[derive(Debug, Clone, Copy)]
pub struct HttpStatus {
    pub bad_request: u16,
    pub ok: u16,
    pub payload_too_large: u16,
    pub forbidden: u16,
    pub unauthorized: u16,
    pub not_found: u16,
    pub too_many_requests: u16,
    pub bad_gateway: u16,
    pub service_unavailable: u16,
}

/// HTTP Status Codes.
pub const HTTP_STATUS: HttpStatus = HttpStatus {
    bad_request: 400,
    ok: 200,
    payload_too_large: 413,
    forbidden: 403,
    unauthorized: 401,
    not_found: 404,
    too_many_requests: 429,
    bad_gateway: 502,
    service_unavailable: 503,
};

/// OpenAI-specific header NAMES (TS `OPENAI_HEADERS`).
#[derive(Debug, Clone, Copy)]
pub struct OpenAiHeaders {
    /// `BETA`
    pub beta: &'static str,
    /// `ACCOUNT_ID`
    pub account_id: &'static str,
    /// `ORIGINATOR`
    pub originator: &'static str,
    /// `SESSION_ID`
    pub session_id: &'static str,
    /// `CONVERSATION_ID`
    pub conversation_id: &'static str,
}

/// OpenAI-specific headers (exact header names).
pub const OPENAI_HEADERS: OpenAiHeaders = OpenAiHeaders {
    beta: "OpenAI-Beta",
    account_id: "chatgpt-account-id",
    originator: "originator",
    session_id: "session_id",
    conversation_id: "conversation_id",
};

/// OpenAI-specific header VALUES (TS `OPENAI_HEADER_VALUES`).
#[derive(Debug, Clone, Copy)]
pub struct OpenAiHeaderValues {
    /// `BETA_RESPONSES`
    pub beta_responses: &'static str,
    /// `ORIGINATOR_CODEX`
    pub originator_codex: &'static str,
}

/// OpenAI-specific header values.
pub const OPENAI_HEADER_VALUES: OpenAiHeaderValues = OpenAiHeaderValues {
    beta_responses: "responses=experimental",
    originator_codex: "codex_cli_rs",
};

/// URL path segments (TS `URL_PATHS`).
#[derive(Debug, Clone, Copy)]
pub struct UrlPaths {
    /// `MODELS`
    pub models: &'static str,
    /// `RESPONSES`
    pub responses: &'static str,
    /// `CODEX_RESPONSES`
    pub codex_responses: &'static str,
}

/// URL path segments.
pub const URL_PATHS: UrlPaths = UrlPaths {
    models: "/models",
    responses: "/responses",
    codex_responses: "/codex/responses",
};

/// JWT claim path for ChatGPT account ID.
pub const JWT_CLAIM_PATH: &str = "https://api.openai.com/auth";

/// User-visible error message strings (TS `ERROR_MESSAGES`). FROZEN.
#[derive(Debug, Clone, Copy)]
pub struct ErrorMessages {
    /// `NO_ACCOUNT_ID`
    pub no_account_id: &'static str,
    /// `TOKEN_REFRESH_FAILED`
    pub token_refresh_failed: &'static str,
    /// `REQUEST_PARSE_ERROR`
    pub request_parse_error: &'static str,
}

/// Error messages.
pub const ERROR_MESSAGES: ErrorMessages = ErrorMessages {
    no_account_id: "Failed to extract accountId from token",
    token_refresh_failed: "Failed to refresh token, authentication required",
    request_parse_error: "Error parsing request",
};

/// Log stages for request logging (file-name components; TS `LOG_STAGES`).
#[derive(Debug, Clone, Copy)]
pub struct LogStages {
    /// `BEFORE_TRANSFORM`
    pub before_transform: &'static str,
    /// `AFTER_TRANSFORM`
    pub after_transform: &'static str,
    /// `RESPONSE`
    pub response: &'static str,
    /// `ERROR_RESPONSE`
    pub error_response: &'static str,
}

/// Log stages for request logging.
pub const LOG_STAGES: LogStages = LogStages {
    before_transform: "before-transform",
    after_transform: "after-transform",
    response: "response",
    error_response: "error-response",
};

/// Platform-specific browser opener commands (TS `PLATFORM_OPENERS`).
#[derive(Debug, Clone, Copy)]
pub struct PlatformOpeners {
    pub darwin: &'static str,
    pub win32: &'static str,
    pub linux: &'static str,
}

/// Platform-specific browser opener commands.
pub const PLATFORM_OPENERS: PlatformOpeners = PlatformOpeners {
    darwin: "open",
    win32: "start",
    linux: "xdg-open",
};

/// OAuth authorization labels (TS `AUTH_LABELS`). FROZEN user-visible copy.
#[derive(Debug, Clone, Copy)]
pub struct AuthLabels {
    /// `OAUTH`
    pub oauth: &'static str,
    /// `OAUTH_MANUAL`
    pub oauth_manual: &'static str,
    /// `API_KEY`
    pub api_key: &'static str,
    /// `INSTRUCTIONS`
    pub instructions: &'static str,
    /// `INSTRUCTIONS_MANUAL`
    pub instructions_manual: &'static str,
}

/// OAuth authorization labels.
pub const AUTH_LABELS: AuthLabels = AuthLabels {
    oauth: "ChatGPT Plus/Pro MULTI (Codex Subscription)",
    oauth_manual: "ChatGPT Plus/Pro MULTI (Manual URL Paste)",
    api_key: "Manually enter API Key MULTI",
    instructions:
        "A browser window should open. If it doesn't, copy the URL and open it manually.",
    instructions_manual: "After logging in, copy the full redirect URL and paste it here.",
};

/// Multi-account configuration (TS `ACCOUNT_LIMITS`).
#[derive(Debug, Clone, Copy)]
pub struct AccountLimits {
    /// Maximum number of OAuth accounts that can be registered (`MAX_ACCOUNTS`).
    pub max_accounts: usize,
    /// Cooldown period (ms) after auth failure before retrying account
    /// (`AUTH_FAILURE_COOLDOWN_MS`).
    pub auth_failure_cooldown_ms: i64,
    /// Number of consecutive auth failures before auto-removing account
    /// (`MAX_AUTH_FAILURES_BEFORE_REMOVAL`).
    pub max_auth_failures_before_removal: u32,
}

/// Multi-account configuration.
pub const ACCOUNT_LIMITS: AccountLimits = AccountLimits {
    max_accounts: 20,
    auth_failure_cooldown_ms: 30_000,
    max_auth_failures_before_removal: 3,
};

/// Every reasoning-effort level, weakest first.
///
/// Single source of truth: the effort union and the model-id suffix pattern in
/// the request transformer are both derived from this, so a new tier cannot be
/// added to one and forgotten in the other.
///
/// `max` and `ultra` arrived with GPT-5.6.
///
/// `ultra` is selectable but never reaches the wire: Codex rewrites it to
/// `max` before the request is sent. It denotes automatic subagent delegation
/// on the client, not a distinct backend effort level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

/// All reasoning-effort levels, weakest first (TS `REASONING_EFFORTS`).
/// Order matters: tier comparisons elsewhere rely on it.
pub const REASONING_EFFORTS: [ModelReasoningEffort; 8] = [
    ModelReasoningEffort::None,
    ModelReasoningEffort::Minimal,
    ModelReasoningEffort::Low,
    ModelReasoningEffort::Medium,
    ModelReasoningEffort::High,
    ModelReasoningEffort::Xhigh,
    ModelReasoningEffort::Max,
    ModelReasoningEffort::Ultra,
];

impl ModelReasoningEffort {
    /// The wire string for this effort level (exactly the TS literal).
    pub const fn as_str(self) -> &'static str {
        match self {
            ModelReasoningEffort::None => "none",
            ModelReasoningEffort::Minimal => "minimal",
            ModelReasoningEffort::Low => "low",
            ModelReasoningEffort::Medium => "medium",
            ModelReasoningEffort::High => "high",
            ModelReasoningEffort::Xhigh => "xhigh",
            ModelReasoningEffort::Max => "max",
            ModelReasoningEffort::Ultra => "ultra",
        }
    }

    /// Exact-match parse of an effort literal (callers trim/lowercase first
    /// where the TS did).
    pub fn parse(value: &str) -> Option<Self> {
        REASONING_EFFORTS
            .iter()
            .copied()
            .find(|effort| effort.as_str() == value)
    }

    /// 0-based tier index, weakest first (position in [`REASONING_EFFORTS`]).
    pub const fn tier(self) -> usize {
        self as usize
    }

    /// The effort level actually sent to the Responses API. `ultra` never hits
    /// the wire: it always resolves to `max` before the request is built.
    pub const fn to_wire(self) -> WireReasoningEffort {
        match self {
            ModelReasoningEffort::None => WireReasoningEffort::None,
            ModelReasoningEffort::Minimal => WireReasoningEffort::Minimal,
            ModelReasoningEffort::Low => WireReasoningEffort::Low,
            ModelReasoningEffort::Medium => WireReasoningEffort::Medium,
            ModelReasoningEffort::High => WireReasoningEffort::High,
            ModelReasoningEffort::Xhigh => WireReasoningEffort::Xhigh,
            ModelReasoningEffort::Max | ModelReasoningEffort::Ultra => WireReasoningEffort::Max,
        }
    }
}

impl std::fmt::Display for ModelReasoningEffort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Effort levels the Responses API actually accepts
/// (TS `WireReasoningEffort = Exclude<ModelReasoningEffort, "ultra">`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl WireReasoningEffort {
    /// The wire string for this effort level.
    pub const fn as_str(self) -> &'static str {
        match self {
            WireReasoningEffort::None => "none",
            WireReasoningEffort::Minimal => "minimal",
            WireReasoningEffort::Low => "low",
            WireReasoningEffort::Medium => "medium",
            WireReasoningEffort::High => "high",
            WireReasoningEffort::Xhigh => "xhigh",
            WireReasoningEffort::Max => "max",
        }
    }

    /// Exact-match parse of a wire-effort literal (`"ultra"` is rejected — it
    /// is not a wire tier).
    pub fn parse(value: &str) -> Option<Self> {
        ModelReasoningEffort::parse(value).and_then(|effort| match effort {
            ModelReasoningEffort::Ultra => None,
            other => Some(other.to_wire()),
        })
    }
}

impl From<WireReasoningEffort> for ModelReasoningEffort {
    fn from(value: WireReasoningEffort) -> Self {
        match value {
            WireReasoningEffort::None => ModelReasoningEffort::None,
            WireReasoningEffort::Minimal => ModelReasoningEffort::Minimal,
            WireReasoningEffort::Low => ModelReasoningEffort::Low,
            WireReasoningEffort::Medium => ModelReasoningEffort::Medium,
            WireReasoningEffort::High => ModelReasoningEffort::High,
            WireReasoningEffort::Xhigh => ModelReasoningEffort::Xhigh,
            WireReasoningEffort::Max => ModelReasoningEffort::Max,
        }
    }
}

impl std::fmt::Display for WireReasoningEffort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

// --- lib/runtime-constants.ts ---

/// Provider id of the runtime rotation proxy
/// (TS `RUNTIME_ROTATION_PROXY_PROVIDER_ID`).
pub const RUNTIME_ROTATION_PROXY_PROVIDER_ID: &str = "codex-multi-auth-runtime-proxy";

/// Status filename written by the app runtime helper
/// (TS `APP_RUNTIME_HELPER_STATUS_FILE`).
pub const APP_RUNTIME_HELPER_STATUS_FILE: &str = "runtime-rotation-app-helper.json";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_identity_constants_are_frozen() {
        assert_eq!(PLUGIN_NAME, "codex-multi-auth");
        assert_eq!(CODEX_BASE_URL, "https://chatgpt.com/backend-api");
        assert_eq!(DUMMY_API_KEY, "chatgpt-oauth");
        assert_eq!(PROVIDER_ID, "openai");
        assert_eq!(JWT_CLAIM_PATH, "https://api.openai.com/auth");
    }

    #[test]
    fn max_rate_limit_delay_is_seven_days() {
        assert_eq!(MAX_RATE_LIMIT_DELAY_MS, 604_800_000);
    }

    #[test]
    fn http_status_values_match_ts() {
        assert_eq!(HTTP_STATUS.bad_request, 400);
        assert_eq!(HTTP_STATUS.ok, 200);
        assert_eq!(HTTP_STATUS.payload_too_large, 413);
        assert_eq!(HTTP_STATUS.forbidden, 403);
        assert_eq!(HTTP_STATUS.unauthorized, 401);
        assert_eq!(HTTP_STATUS.not_found, 404);
        assert_eq!(HTTP_STATUS.too_many_requests, 429);
        assert_eq!(HTTP_STATUS.bad_gateway, 502);
        assert_eq!(HTTP_STATUS.service_unavailable, 503);
    }

    #[test]
    fn openai_headers_are_exact() {
        assert_eq!(OPENAI_HEADERS.beta, "OpenAI-Beta");
        assert_eq!(OPENAI_HEADERS.account_id, "chatgpt-account-id");
        assert_eq!(OPENAI_HEADERS.originator, "originator");
        assert_eq!(OPENAI_HEADERS.session_id, "session_id");
        assert_eq!(OPENAI_HEADERS.conversation_id, "conversation_id");
        assert_eq!(OPENAI_HEADER_VALUES.beta_responses, "responses=experimental");
        assert_eq!(OPENAI_HEADER_VALUES.originator_codex, "codex_cli_rs");
    }

    #[test]
    fn url_paths_match_ts() {
        assert_eq!(URL_PATHS.models, "/models");
        assert_eq!(URL_PATHS.responses, "/responses");
        assert_eq!(URL_PATHS.codex_responses, "/codex/responses");
    }

    #[test]
    fn error_messages_are_frozen() {
        assert_eq!(
            ERROR_MESSAGES.no_account_id,
            "Failed to extract accountId from token"
        );
        assert_eq!(
            ERROR_MESSAGES.token_refresh_failed,
            "Failed to refresh token, authentication required"
        );
        assert_eq!(ERROR_MESSAGES.request_parse_error, "Error parsing request");
    }

    #[test]
    fn log_stages_match_ts() {
        assert_eq!(LOG_STAGES.before_transform, "before-transform");
        assert_eq!(LOG_STAGES.after_transform, "after-transform");
        assert_eq!(LOG_STAGES.response, "response");
        assert_eq!(LOG_STAGES.error_response, "error-response");
    }

    #[test]
    fn platform_openers_match_ts() {
        assert_eq!(PLATFORM_OPENERS.darwin, "open");
        assert_eq!(PLATFORM_OPENERS.win32, "start");
        assert_eq!(PLATFORM_OPENERS.linux, "xdg-open");
    }

    #[test]
    fn auth_labels_are_frozen() {
        assert_eq!(
            AUTH_LABELS.oauth,
            "ChatGPT Plus/Pro MULTI (Codex Subscription)"
        );
        assert_eq!(
            AUTH_LABELS.oauth_manual,
            "ChatGPT Plus/Pro MULTI (Manual URL Paste)"
        );
        assert_eq!(AUTH_LABELS.api_key, "Manually enter API Key MULTI");
        assert_eq!(
            AUTH_LABELS.instructions,
            "A browser window should open. If it doesn't, copy the URL and open it manually."
        );
        assert_eq!(
            AUTH_LABELS.instructions_manual,
            "After logging in, copy the full redirect URL and paste it here."
        );
    }

    #[test]
    fn account_limits_match_ts() {
        assert_eq!(ACCOUNT_LIMITS.max_accounts, 20);
        assert_eq!(ACCOUNT_LIMITS.auth_failure_cooldown_ms, 30_000);
        assert_eq!(ACCOUNT_LIMITS.max_auth_failures_before_removal, 3);
    }

    #[test]
    fn reasoning_efforts_ordered_weakest_first() {
        let as_strings: Vec<&str> = REASONING_EFFORTS.iter().map(|e| e.as_str()).collect();
        assert_eq!(
            as_strings,
            vec!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
        );
        // Tier comparisons rely on declaration order.
        assert!(ModelReasoningEffort::None < ModelReasoningEffort::Ultra);
        assert!(ModelReasoningEffort::Medium < ModelReasoningEffort::High);
        assert_eq!(ModelReasoningEffort::Xhigh.tier(), 5);
    }

    #[test]
    fn reasoning_effort_serde_uses_lowercase_literals() {
        assert_eq!(
            serde_json::to_string(&ModelReasoningEffort::Xhigh).unwrap(),
            "\"xhigh\""
        );
        assert_eq!(
            serde_json::from_str::<ModelReasoningEffort>("\"ultra\"").unwrap(),
            ModelReasoningEffort::Ultra
        );
        assert_eq!(
            serde_json::to_string(&WireReasoningEffort::Max).unwrap(),
            "\"max\""
        );
        assert!(serde_json::from_str::<WireReasoningEffort>("\"ultra\"").is_err());
    }

    #[test]
    fn ultra_resolves_to_max_on_the_wire() {
        assert_eq!(
            ModelReasoningEffort::Ultra.to_wire(),
            WireReasoningEffort::Max
        );
        assert_eq!(ModelReasoningEffort::Max.to_wire(), WireReasoningEffort::Max);
        assert_eq!(WireReasoningEffort::parse("ultra"), None);
        assert_eq!(
            WireReasoningEffort::parse("xhigh"),
            Some(WireReasoningEffort::Xhigh)
        );
    }

    #[test]
    fn runtime_constants_match_ts() {
        assert_eq!(
            RUNTIME_ROTATION_PROXY_PROVIDER_ID,
            "codex-multi-auth-runtime-proxy"
        );
        assert_eq!(
            APP_RUNTIME_HELPER_STATUS_FILE,
            "runtime-rotation-app-helper.json"
        );
    }
}
