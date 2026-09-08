//! Port of `lib/usage/types.ts` — usage ledger row/summary types.
//!
//! Behavior source: specs/11-cli-usage-recovery.md §5.1.
//!
//! Byte-compat notes (spec §5.3 "usageRowToJsonLine"):
//! - [`UsageLedgerRow`] serializes its fields in the exact TS object-literal
//!   order (version, id, createdAt, source, operation, outcome, model,
//!   projectKey, account, requestId, statusCode, errorCode, durationMs,
//!   tokens, costUsd). Nullable row fields serialize as JSON `null` (the TS
//!   row always carries them, possibly `null`).
//! - [`UsageLedgerAccountRef`] fields are *omitted* when absent (TS sets them
//!   to `undefined`, which `JSON.stringify` drops).
//! - `createdAt` is modeled as `f64` because the TS normalizer preserves a
//!   caller-provided fractional timestamp verbatim; serialization goes through
//!   `cma_core::json_io` (ECMAScript number formatting), so integer-valued
//!   timestamps can never gain a decimal point.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The frozen on-disk row version (`version: 1`).
pub const USAGE_LEDGER_ROW_VERSION: u8 = 1;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// `UsageLedgerSource` — where a ledger row originated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum UsageLedgerSource {
    #[serde(rename = "runtime-proxy")]
    RuntimeProxy,
    #[serde(rename = "plugin-host")]
    PluginHost,
    #[serde(rename = "local-bridge")]
    LocalBridge,
    #[serde(rename = "cli")]
    Cli,
    #[serde(rename = "unknown")]
    Unknown,
}

impl UsageLedgerSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            UsageLedgerSource::RuntimeProxy => "runtime-proxy",
            UsageLedgerSource::PluginHost => "plugin-host",
            UsageLedgerSource::LocalBridge => "local-bridge",
            UsageLedgerSource::Cli => "cli",
            UsageLedgerSource::Unknown => "unknown",
        }
    }

    /// Strict membership test against the valid-source set (no fallback —
    /// callers apply the TS `"unknown"` fallback themselves).
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "runtime-proxy" => UsageLedgerSource::RuntimeProxy,
            "plugin-host" => UsageLedgerSource::PluginHost,
            "local-bridge" => UsageLedgerSource::LocalBridge,
            "cli" => UsageLedgerSource::Cli,
            "unknown" => UsageLedgerSource::Unknown,
            _ => return None,
        })
    }
}

/// `UsageLedgerOperation` — what kind of request the row describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum UsageLedgerOperation {
    #[serde(rename = "responses")]
    Responses,
    #[serde(rename = "models")]
    Models,
    #[serde(rename = "thread-goal")]
    ThreadGoal,
    #[serde(rename = "auth-refresh")]
    AuthRefresh,
    #[serde(rename = "diagnostic")]
    Diagnostic,
    #[serde(rename = "unknown")]
    Unknown,
}

impl UsageLedgerOperation {
    pub const fn as_str(self) -> &'static str {
        match self {
            UsageLedgerOperation::Responses => "responses",
            UsageLedgerOperation::Models => "models",
            UsageLedgerOperation::ThreadGoal => "thread-goal",
            UsageLedgerOperation::AuthRefresh => "auth-refresh",
            UsageLedgerOperation::Diagnostic => "diagnostic",
            UsageLedgerOperation::Unknown => "unknown",
        }
    }

    /// Strict membership test (no fallback).
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "responses" => UsageLedgerOperation::Responses,
            "models" => UsageLedgerOperation::Models,
            "thread-goal" => UsageLedgerOperation::ThreadGoal,
            "auth-refresh" => UsageLedgerOperation::AuthRefresh,
            "diagnostic" => UsageLedgerOperation::Diagnostic,
            "unknown" => UsageLedgerOperation::Unknown,
            _ => return None,
        })
    }
}

/// `UsageLedgerOutcome` — request outcome classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum UsageLedgerOutcome {
    #[serde(rename = "success")]
    Success,
    #[serde(rename = "failure")]
    Failure,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "cancelled")]
    Cancelled,
}

impl UsageLedgerOutcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            UsageLedgerOutcome::Success => "success",
            UsageLedgerOutcome::Failure => "failure",
            UsageLedgerOutcome::Blocked => "blocked",
            UsageLedgerOutcome::Cancelled => "cancelled",
        }
    }

    /// Strict membership test (no fallback — the TS fallback is `"failure"`,
    /// applied by callers: an unclassifiable outcome must never count as a
    /// success).
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "success" => UsageLedgerOutcome::Success,
            "failure" => UsageLedgerOutcome::Failure,
            "blocked" => UsageLedgerOutcome::Blocked,
            "cancelled" => UsageLedgerOutcome::Cancelled,
            _ => return None,
        })
    }
}

/// `UsageSummaryGroupBy` — summary bucketing dimension. Default `"model"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum UsageSummaryGroupBy {
    #[default]
    #[serde(rename = "model")]
    Model,
    #[serde(rename = "account")]
    Account,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "outcome")]
    Outcome,
    #[serde(rename = "day")]
    Day,
}

impl UsageSummaryGroupBy {
    pub const fn as_str(self) -> &'static str {
        match self {
            UsageSummaryGroupBy::Model => "model",
            UsageSummaryGroupBy::Account => "account",
            UsageSummaryGroupBy::Project => "project",
            UsageSummaryGroupBy::Outcome => "outcome",
            UsageSummaryGroupBy::Day => "day",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "model" => UsageSummaryGroupBy::Model,
            "account" => UsageSummaryGroupBy::Account,
            "project" => UsageSummaryGroupBy::Project,
            "outcome" => UsageSummaryGroupBy::Outcome,
            "day" => UsageSummaryGroupBy::Day,
            _ => return None,
        })
    }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/// `UsageTokenCounts` — always fully populated on a normalized row.
///
/// Invariant (spec §5.2/§5.3): `totalTokens = inputTokens + outputTokens +
/// reasoningTokens` when computed (cached input EXCLUDED — cached is a subset
/// of input), unless the writer provided an explicit total.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenCounts {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

/// `UsageLedgerAccountRef` — hashed account facets. Raw identifiers are never
/// persisted; absent facets are omitted from the serialized row (TS
/// `undefined` semantics).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageLedgerAccountRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u64>,
}

/// `UsageLedgerRow` — one JSONL line (`version: 1`, COMPACT serialization).
///
/// Field declaration order is the serialization order and is FROZEN (matches
/// the TS object literal in `normalizeUsageLedgerRow`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLedgerRow {
    /// Always [`USAGE_LEDGER_ROW_VERSION`] (1).
    pub version: u8,
    pub id: String,
    pub created_at: f64,
    pub source: UsageLedgerSource,
    pub operation: UsageLedgerOperation,
    pub outcome: UsageLedgerOutcome,
    pub model: Option<String>,
    pub project_key: Option<String>,
    pub account: Option<UsageLedgerAccountRef>,
    pub request_id: Option<String>,
    pub status_code: Option<u16>,
    pub error_code: Option<String>,
    pub duration_ms: Option<u64>,
    pub tokens: UsageTokenCounts,
    pub cost_usd: Option<f64>,
}

/// `UsageLedgerAppendInput` — the all-optional write-side input with RAW
/// `account_id`/`email`/`account_index` facets (hashed during normalization,
/// never persisted).
///
/// `source`/`operation`/`outcome` are plain strings because the TS normalizer
/// validates arbitrary values against the enum sets, coercing unknown values
/// to `"unknown"` (outcome: `"failure"`). Typed callers should pass
/// `Some(UsageLedgerOutcome::Success.as_str().to_string())` etc.
///
/// Numeric fields are `f64` so the TS clamping rules (`Math.trunc`,
/// `Number.isFinite`, `Number.isInteger`) apply to fractional/NaN inputs
/// exactly as in the source.
#[derive(Debug, Clone, Default)]
pub struct UsageLedgerAppendInput {
    pub id: Option<String>,
    pub created_at: Option<f64>,
    pub source: Option<String>,
    pub operation: Option<String>,
    pub outcome: Option<String>,
    pub model: Option<String>,
    pub project_key: Option<String>,
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub account_index: Option<f64>,
    pub request_id: Option<String>,
    pub status_code: Option<f64>,
    pub error_code: Option<String>,
    pub duration_ms: Option<f64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cached_input_tokens: Option<f64>,
    pub reasoning_tokens: Option<f64>,
    pub total_tokens: Option<f64>,
    pub cost_usd: Option<f64>,
}

// ---------------------------------------------------------------------------
// Query / summary shapes
// ---------------------------------------------------------------------------

/// `UsageLedgerQuery` — `since`/`until` are epoch milliseconds (the TS type
/// also accepted `Date`/ISO strings, a JS-host affordance; Rust callers pass
/// milliseconds). Non-finite values are treated as unset, matching the TS
/// `normalizeTimestamp` null result.
#[derive(Debug, Clone, Copy, Default)]
pub struct UsageLedgerQuery {
    pub since: Option<f64>,
    pub until: Option<f64>,
    pub include_archives: bool,
}

/// `UsageSummaryQuery` — [`UsageLedgerQuery`] plus the group-by dimension.
#[derive(Debug, Clone, Copy, Default)]
pub struct UsageSummaryQuery {
    pub since: Option<f64>,
    pub until: Option<f64>,
    pub include_archives: bool,
    /// `None` → `"model"` (TS default).
    pub by: Option<UsageSummaryGroupBy>,
}

impl UsageSummaryQuery {
    /// The row-filtering half of this query.
    pub fn ledger_query(&self) -> UsageLedgerQuery {
        UsageLedgerQuery {
            since: self.since,
            until: self.until,
            include_archives: self.include_archives,
        }
    }
}

/// `UsageSummaryBucket` — accumulation bucket (also used for `totals`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryBucket {
    pub key: String,
    pub requests: u64,
    pub successes: u64,
    pub failures: u64,
    pub blocked: u64,
    pub cancelled: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

/// `UsageSummary` — totals plus per-key buckets sorted by key.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub since: Option<f64>,
    pub until: Option<f64>,
    pub by: UsageSummaryGroupBy,
    pub totals: UsageSummaryBucket,
    pub buckets: Vec<UsageSummaryBucket>,
}

/// `UsageLedgerPaths` — resolved ledger locations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageLedgerPaths {
    pub dir: PathBuf,
    pub current: PathBuf,
}

// ---------------------------------------------------------------------------
// Crate-internal helpers
// ---------------------------------------------------------------------------

/// ECMAScript `String.prototype.trim` — Rust's `str::trim` matches the
/// Unicode `White_Space` set JS uses, except JS additionally strips U+FEFF
/// (ZWNBSP). Used by pricing/redaction/ledger wherever the TS called
/// `.trim()`.
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::json_io::stringify_compact;

    #[test]
    fn enum_serde_names_match_ts_literals() {
        assert_eq!(
            stringify_compact(&UsageLedgerSource::RuntimeProxy),
            "\"runtime-proxy\""
        );
        assert_eq!(
            stringify_compact(&UsageLedgerOperation::ThreadGoal),
            "\"thread-goal\""
        );
        assert_eq!(
            stringify_compact(&UsageLedgerOutcome::Cancelled),
            "\"cancelled\""
        );
        assert_eq!(stringify_compact(&UsageSummaryGroupBy::Day), "\"day\"");
        for source in [
            UsageLedgerSource::RuntimeProxy,
            UsageLedgerSource::PluginHost,
            UsageLedgerSource::LocalBridge,
            UsageLedgerSource::Cli,
            UsageLedgerSource::Unknown,
        ] {
            assert_eq!(UsageLedgerSource::parse(source.as_str()), Some(source));
        }
        assert_eq!(UsageLedgerSource::parse("smoke-signal"), None);
        assert_eq!(UsageLedgerOutcome::parse("exploded"), None);
        assert_eq!(UsageSummaryGroupBy::default(), UsageSummaryGroupBy::Model);
    }

    #[test]
    fn row_serializes_in_frozen_field_order_with_nulls() {
        let row = UsageLedgerRow {
            version: USAGE_LEDGER_ROW_VERSION,
            id: "row-1".to_string(),
            created_at: 5.0,
            source: UsageLedgerSource::Cli,
            operation: UsageLedgerOperation::Unknown,
            outcome: UsageLedgerOutcome::Failure,
            model: None,
            project_key: None,
            account: None,
            request_id: None,
            status_code: None,
            error_code: None,
            duration_ms: None,
            tokens: UsageTokenCounts::default(),
            cost_usd: None,
        };
        assert_eq!(
            stringify_compact(&row),
            concat!(
                "{\"version\":1,\"id\":\"row-1\",\"createdAt\":5,",
                "\"source\":\"cli\",\"operation\":\"unknown\",\"outcome\":\"failure\",",
                "\"model\":null,\"projectKey\":null,\"account\":null,\"requestId\":null,",
                "\"statusCode\":null,\"errorCode\":null,\"durationMs\":null,",
                "\"tokens\":{\"inputTokens\":0,\"outputTokens\":0,\"cachedInputTokens\":0,",
                "\"reasoningTokens\":0,\"totalTokens\":0},\"costUsd\":null}"
            )
        );
    }

    #[test]
    fn account_ref_omits_absent_facets_like_js_undefined() {
        let full = UsageLedgerAccountRef {
            account_hash: Some("sha256:aa".to_string()),
            email_hash: None,
            index: Some(0),
        };
        assert_eq!(
            stringify_compact(&full),
            "{\"accountHash\":\"sha256:aa\",\"index\":0}"
        );
        assert_eq!(stringify_compact(&UsageLedgerAccountRef::default()), "{}");
    }

    #[test]
    fn js_trim_strips_whitespace_and_bom() {
        assert_eq!(js_trim("  x "), "x");
        assert_eq!(js_trim("\t\r\n x \u{a0}"), "x");
        assert_eq!(js_trim("\u{feff}x\u{feff}"), "x");
        assert_eq!(js_trim(""), "");
    }
}
