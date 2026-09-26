//! Port of `lib/runtime/rotation-server-types.ts` — shared types for the
//! runtime rotation proxy (spec 10 §7, ARCHITECTURE §6.12).
//!
//! These are the CONTRACT types between `cma-runtime::rotation` and the
//! `cma-proxy` HTTP surface. String values (skip reasons, exhaustion
//! reasons) are frozen — observability snapshots and the proxy error
//! payloads embed them verbatim.

use cma_accounts::manager_persistence::SharedAccountManager;
use cma_core::model_family::ModelFamily;
use serde::Serialize;
use std::sync::Arc;

/// TS `"hybrid" | "sequential"` scheduling-strategy union
/// (`rotation-proxy-state.ts` / config getter `getSchedulingStrategy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SchedulingStrategy {
    #[default]
    Hybrid,
    Sequential,
}

impl SchedulingStrategy {
    pub const fn as_str(self) -> &'static str {
        match self {
            SchedulingStrategy::Hybrid => "hybrid",
            SchedulingStrategy::Sequential => "sequential",
        }
    }
}

/// Selection-layer skip-reason strings recorded by
/// [`crate::rotation::account_selection::choose_account`]. The
/// account-manager runtime reasons (`"rate-limited"`,
/// `"cooling-down:<reason>"`, `"circuit-open"`, `"workspace-disabled"`,
/// `"disabled"`, `"missing"`) come from
/// `AccountManager::get_account_runtime_skip_reason` and share this
/// contract space.
pub mod skip_reason {
    /// The account was already tried during this request.
    pub const ALREADY_ATTEMPTED: &str = "already-attempted";
    /// The (pinned) index is out of the pool range.
    pub const MISSING: &str = "missing";
    /// Blocked by the runtime policy decision.
    pub const POLICY_BLOCKED: &str = "policy-blocked";
    /// Account missing from the pool or `enabled === false`.
    pub const DISABLED: &str = "disabled";
}

/// TS `RuntimeRotationProxyStatus` — the live status snapshot returned by
/// the proxy's `getStatus()`. Field order mirrors the TS object literal in
/// `createRotationProxyState` (serialization key order matters for the
/// status JSON surfaces).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRotationProxyStatus {
    pub started_at: i64,
    pub total_requests: i64,
    pub upstream_requests: i64,
    pub retries: i64,
    pub rotations: i64,
    pub streams_started: i64,
    pub last_error: Option<String>,
    pub last_account_index: Option<i64>,
    pub last_account_label: Option<String>,
    pub last_account_id: Option<String>,
    pub last_account_updated_at: Option<i64>,
}

/// Injected clock (`now: () => number`).
pub type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

/// TS `RuntimeRotationProxyOptions` — options accepted by
/// `startRuntimeRotationProxy` (implemented in `cma-proxy`).
///
/// `forced_account_index` is the ephemeral, per-invocation account pin
/// (0-based) for a single invocation (issue #623:
/// `codex-multi-auth-codex --account`). When set, the proxy routes every
/// request to exactly this account and never rotates, without touching the
/// persisted `switch` pin on disk. `None` defers to
/// `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` in the environment (resolved by
/// the proxy caller via
/// [`crate::rotation::account_selection::normalize_forced_account_index`])
/// so the value survives the launcher -> detached app-helper process
/// boundary. The TS `??` fallback semantics are preserved: an explicit
/// `Some(0)` is honored and wins over the environment.
#[derive(Clone, Default)]
pub struct RuntimeRotationProxyOptions {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub upstream_base_url: Option<String>,
    /// Required (validated by the proxy server, not here).
    pub client_api_key: String,
    pub account_manager: Option<SharedAccountManager>,
    /// Replaces the TS `fetchImpl` seam: an injected reqwest client.
    pub fetch_client: Option<reqwest::Client>,
    pub now: Option<NowFn>,
    pub quota_remaining_percent_threshold: Option<f64>,
    pub max_request_body_bytes: Option<usize>,
    pub fetch_timeout_ms: Option<i64>,
    pub stream_stall_timeout_ms: Option<i64>,
    /// See the struct docs — `None` defers to the environment.
    pub forced_account_index: Option<i64>,
    /// When the launcher explicitly resolved "no pin" (no `--account`), set
    /// this so the proxy NEVER falls back to a stray/inherited
    /// `CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX` (TS deletes the var from
    /// `process.env` in that case: a request without `--account` can never
    /// inherit an unintended pin from a parent forced run or a leftover
    /// export). Default `false` preserves the env fallback for callers that
    /// never resolved the pin themselves.
    pub suppress_env_forced_account_index: bool,
}

impl std::fmt::Debug for RuntimeRotationProxyOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RuntimeRotationProxyOptions")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("upstream_base_url", &self.upstream_base_url)
            .field("client_api_key", &"<redacted>")
            .field("has_account_manager", &self.account_manager.is_some())
            .field("has_fetch_client", &self.fetch_client.is_some())
            .field("has_now", &self.now.is_some())
            .field(
                "quota_remaining_percent_threshold",
                &self.quota_remaining_percent_threshold,
            )
            .field("max_request_body_bytes", &self.max_request_body_bytes)
            .field("fetch_timeout_ms", &self.fetch_timeout_ms)
            .field("stream_stall_timeout_ms", &self.stream_stall_timeout_ms)
            .field("forced_account_index", &self.forced_account_index)
            .field(
                "suppress_env_forced_account_index",
                &self.suppress_env_forced_account_index,
            )
            .finish()
    }
}

/// TS `RequestContext.method` — the proxy only serves GET and POST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestMethod {
    Get,
    Post,
}

impl RequestMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            RequestMethod::Get => "GET",
            RequestMethod::Post => "POST",
        }
    }
}

/// TS `RequestContext` — the parsed inbound request handed to the rotation
/// pipeline.
#[derive(Debug, Clone)]
pub struct RequestContext {
    /// Raw request body bytes (TS `Buffer`).
    pub body: Vec<u8>,
    pub headers: reqwest::header::HeaderMap,
    pub method: RequestMethod,
    pub upstream_path: String,
    pub model: Option<String>,
    pub family: ModelFamily,
    pub stream: bool,
    pub session_key: Option<String>,
}

/// TS `ExhaustionReason` — why the pool ran out of candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ExhaustionReason {
    #[serde(rename = "rate-limit")]
    RateLimit,
    #[serde(rename = "server-error")]
    ServerError,
    #[serde(rename = "network-error")]
    NetworkError,
    #[serde(rename = "auth-failure")]
    AuthFailure,
    #[serde(rename = "budget")]
    Budget,
    #[serde(rename = "deactivated")]
    Deactivated,
    #[serde(rename = "no-account")]
    NoAccount,
}

impl ExhaustionReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            ExhaustionReason::RateLimit => "rate-limit",
            ExhaustionReason::ServerError => "server-error",
            ExhaustionReason::NetworkError => "network-error",
            ExhaustionReason::AuthFailure => "auth-failure",
            ExhaustionReason::Budget => "budget",
            ExhaustionReason::Deactivated => "deactivated",
            ExhaustionReason::NoAccount => "no-account",
        }
    }
}

/// TS `RuntimeProxyHttpError` — an error carrying the HTTP status and one
/// of the proxy's stable error codes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProxyHttpError {
    pub message: String,
    pub status_code: u16,
    pub code: String,
}

impl RuntimeProxyHttpError {
    pub fn new(message: impl Into<String>, status_code: u16, code: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code,
            code: code.into(),
        }
    }
}

impl std::fmt::Display for RuntimeProxyHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RuntimeProxyHttpError {}

/// TS `RuntimeRotationAccountIdentity` — the last-served account identity
/// reported through status snapshots.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRotationAccountIdentity {
    pub index: i64,
    pub label: String,
    pub account_id: Option<String>,
    pub updated_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exhaustion_reason_strings_are_frozen() {
        assert_eq!(ExhaustionReason::RateLimit.as_str(), "rate-limit");
        assert_eq!(ExhaustionReason::ServerError.as_str(), "server-error");
        assert_eq!(ExhaustionReason::NetworkError.as_str(), "network-error");
        assert_eq!(ExhaustionReason::AuthFailure.as_str(), "auth-failure");
        assert_eq!(ExhaustionReason::Budget.as_str(), "budget");
        assert_eq!(ExhaustionReason::Deactivated.as_str(), "deactivated");
        assert_eq!(ExhaustionReason::NoAccount.as_str(), "no-account");
        // Serde renames must match as_str (both feed persisted skip maps).
        assert_eq!(
            serde_json::to_string(&ExhaustionReason::NoAccount).unwrap(),
            "\"no-account\""
        );
    }

    #[test]
    fn skip_reason_strings_are_frozen() {
        assert_eq!(skip_reason::ALREADY_ATTEMPTED, "already-attempted");
        assert_eq!(skip_reason::MISSING, "missing");
        assert_eq!(skip_reason::POLICY_BLOCKED, "policy-blocked");
        assert_eq!(skip_reason::DISABLED, "disabled");
    }

    #[test]
    fn status_serializes_with_camel_case_keys() {
        let status = RuntimeRotationProxyStatus {
            started_at: 1,
            total_requests: 0,
            upstream_requests: 0,
            retries: 0,
            rotations: 0,
            streams_started: 0,
            last_error: None,
            last_account_index: None,
            last_account_label: None,
            last_account_id: None,
            last_account_updated_at: None,
        };
        let value = serde_json::to_value(&status).unwrap();
        assert!(value.get("startedAt").is_some());
        assert!(value.get("lastAccountUpdatedAt").is_some());
        assert!(value.get("started_at").is_none());
    }
}
