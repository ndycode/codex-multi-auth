//! Port of the parse/validation helper half of `lib/schemas.ts`:
//! `safeParseJson`, `getValidationErrors`, the per-schema `safeParseX` helpers,
//! plus the shared zod-semantics serde building blocks used by the sibling
//! schema modules (`account_storage.rs`, `flagged.rs`, `journal.rs`,
//! `token.rs`, `plugin_config.rs`).
//!
//! Behavior source of truth: spec 01 §2.8/§3 and spec 02 §4; TS source
//! `lib/schemas.ts`. `safe_parse_json` is FAIL-CLOSED: a JSON syntax error OR
//! a schema/shape mismatch both yield `None` (each debug-logged with its
//! context tag). Callers that must distinguish syntax errors from schema
//! errors (e.g. the storage loader, where a JSON SyntaxError propagates)
//! re-run a raw `serde_json::from_str::<Value>` themselves after a `None`.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use super::account_storage::{AccountStorageV3, AnyAccountStorage};
use super::flagged::FlaggedAccountStorageV1;
use super::journal::AccountsJournalEntry;
use super::plugin_config::PluginConfig;
use super::token::{OAuthTokenResponse, TokenResult};

// ============================================================================
// Schema issues ("path.to.field: message" formatting)
// ============================================================================

/// One validation issue, mirroring a zod issue: a key path (indices are
/// stringified, matching `issue.path.join(".")`) plus a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchemaIssue {
    pub path: Vec<String>,
    pub message: String,
}

impl SchemaIssue {
    pub fn new(path: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            path,
            message: message.into(),
        }
    }

    /// Issue with an empty path (root-level failure — no path prefix when
    /// formatted).
    pub fn root(message: impl Into<String>) -> Self {
        Self {
            path: Vec::new(),
            message: message.into(),
        }
    }

    /// `"<path joined by '.'>: <message>"`; the path prefix is omitted when
    /// the path is empty (spec 01 §2.8).
    pub fn format(&self) -> String {
        if self.path.is_empty() {
            self.message.clone()
        } else {
            format!("{}: {}", self.path.join("."), self.message)
        }
    }
}

impl std::fmt::Display for SchemaIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.format())
    }
}

/// Format a list of issues into `"path.to.field: message"` strings.
pub fn format_issues(issues: &[SchemaIssue]) -> Vec<String> {
    issues.iter().map(SchemaIssue::format).collect()
}

/// Port of `getValidationErrors(schema, data)`: `[]` on success, otherwise
/// each issue formatted as `"<dot.path>: <message>"`. The zod schema argument
/// becomes a check closure producing [`SchemaIssue`]s (e.g.
/// [`super::plugin_config::plugin_config_issues`]).
pub fn validation_errors<F>(schema_check: F, data: &Value) -> Vec<String>
where
    F: FnOnce(&Value) -> Vec<SchemaIssue>,
{
    format_issues(&schema_check(data))
}

// ============================================================================
// safeParseJson (fail-closed JSON.parse + shape boundary)
// ============================================================================

/// Debug-log sink for schema-boundary failures. Isolated here so the sibling
/// `logger` module's exact signature is referenced from exactly one place.
/// (TS lazily creates a scoped logger `"schemas"` and logs at debug level.)
fn schema_debug(message: &str, data: Value) {
    crate::logger::log_debug(message, Some(&data));
}

/// `safeParseJson(raw, schema, context)` with the default context
/// `"safeParseJson"`. Fail-closed: syntax error OR shape mismatch → `None`.
pub fn safe_parse_json<T: DeserializeOwned>(raw: &str) -> Option<T> {
    safe_parse_json_with_context(raw, "safeParseJson")
}

/// `safeParseJson(raw, schema, context)`. Returns `None` on JSON syntax
/// errors (debug log `"safeParseJson JSON.parse failed"` tagged with
/// `context`) and on shape mismatches (debug log
/// `"safeParseJson schema validation failed"` with the issue list — serde
/// reports the first failing field, so the list has one entry).
pub fn safe_parse_json_with_context<T: DeserializeOwned>(raw: &str, context: &str) -> Option<T> {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            schema_debug(
                "safeParseJson JSON.parse failed",
                serde_json::json!({ "context": context, "error": error.to_string() }),
            );
            return None;
        }
    };
    match T::deserialize(parsed) {
        Ok(value) => Some(value),
        Err(error) => {
            schema_debug(
                "safeParseJson schema validation failed",
                serde_json::json!({ "context": context, "issues": [error.to_string()] }),
            );
            None
        }
    }
}

/// Shape-only half of the boundary: validate an already-parsed JSON value
/// against a schema type. This is the Rust analogue of calling
/// `Schema.safeParse(data)` and taking `.data` or `null`.
pub fn safe_parse_value<T: DeserializeOwned>(value: &Value) -> Option<T> {
    T::deserialize(value.clone()).ok()
}

// ============================================================================
// Typed safeParseX helpers (TS export parity)
// ============================================================================

/// `safeParsePluginConfig(data)` — parsed config or `None`, never errors.
pub fn safe_parse_plugin_config(data: &Value) -> Option<PluginConfig> {
    safe_parse_value(data)
}

/// `safeParseAccountStorage(data)` — V1|V3 union or `None`.
pub fn safe_parse_account_storage(data: &Value) -> Option<AnyAccountStorage> {
    safe_parse_value(data)
}

/// `safeParseAccountStorageV3(data)` — V3 specifically or `None`.
pub fn safe_parse_account_storage_v3(data: &Value) -> Option<AccountStorageV3> {
    safe_parse_value(data)
}

/// `safeParseTokenResult(data)` — success/failed union or `None`.
pub fn safe_parse_token_result(data: &Value) -> Option<TokenResult> {
    safe_parse_value(data)
}

/// `safeParseOAuthTokenResponse(data)` — token endpoint response or `None`.
pub fn safe_parse_oauth_token_response(data: &Value) -> Option<OAuthTokenResponse> {
    safe_parse_value(data)
}

/// `safeParseFlaggedAccountStorageV1(data)` — flagged storage or `None`.
pub fn safe_parse_flagged_account_storage_v1(data: &Value) -> Option<FlaggedAccountStorageV1> {
    safe_parse_value(data)
}

/// `safeParseAccountsJournalEntry(data)` — WAL entry or `None`.
pub fn safe_parse_accounts_journal_entry(data: &Value) -> Option<AccountsJournalEntry> {
    safe_parse_value(data)
}

// ============================================================================
// Shared zod-semantics serde building blocks
// ============================================================================

/// zod-style runtime type name of a JSON value (used in
/// `"Invalid input: expected X, received Y"` messages).
pub fn json_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Format an f64 the way JavaScript prints it in the common cases: integral
/// values print without a decimal point (`5` not `5.0`).
pub fn fmt_js_number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// Convert a JSON number to `i64` the lenient way: integral representations
/// pass through; `u64` overflow saturates; float values truncate toward zero
/// (Rust saturating cast). zod `z.number()` accepts any finite number — epoch
/// timestamps are modeled as `i64` per architecture R9, so pathological
/// fractional inputs truncate instead of failing.
pub fn number_to_i64_lossy(n: &serde_json::Number) -> i64 {
    if let Some(i) = n.as_i64() {
        i
    } else if let Some(u) = n.as_u64() {
        i64::try_from(u).unwrap_or(i64::MAX)
    } else {
        // `as` casts from f64 to i64 saturate and map NaN to 0.
        n.as_f64().unwrap_or(0.0) as i64
    }
}

/// Strict-integer view of a JSON number (zod `.int()`): integral
/// representations and floats with zero fractional part qualify (JS
/// `Number.isInteger(12.0)` is `true`); anything else is `None`.
pub fn number_as_strict_int(n: &serde_json::Number) -> Option<i64> {
    if let Some(i) = n.as_i64() {
        Some(i)
    } else if let Some(u) = n.as_u64() {
        Some(i64::try_from(u).unwrap_or(i64::MAX))
    } else {
        let f = n.as_f64()?;
        if f.is_finite() && f.fract() == 0.0 {
            Some(f as i64)
        } else {
            None
        }
    }
}

/// `z.number()` → lenient `i64` (required field).
pub fn de_number_lenient<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let n = serde_json::Number::deserialize(deserializer)?;
    Ok(number_to_i64_lossy(&n))
}

/// zod `.optional()` semantics for a PRESENT key: absence is handled by
/// `#[serde(default)]`, but an explicit JSON `null` must FAIL the parse —
/// zod optional ≠ nullable (`JSON.parse` never yields `undefined`, so
/// `z.string().optional()` rejects `null` with "expected string, received
/// null"). Plain serde `Option<T>` would silently map `null` → `None`;
/// this helper restores the zod behavior for strings, booleans, enums,
/// arrays and nested schemas.
pub fn de_opt_strict<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// `z.number().optional()` → lenient `Option<i64>` for a PRESENT key: the
/// value must be a JSON number (explicit `null` fails, matching zod optional
/// ≠ nullable); absence is handled by `#[serde(default)]`.
pub fn de_opt_number_lenient<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    let n = serde_json::Number::deserialize(deserializer)?;
    Ok(Some(number_to_i64_lossy(&n)))
}

/// `z.number().min(0)` → lenient non-negative `i64` (negative input fails the
/// parse, exactly like zod).
pub fn de_number_min0_lenient<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<i64, D::Error> {
    let n = serde_json::Number::deserialize(deserializer)?;
    if n.as_f64().is_some_and(|f| f < 0.0) {
        return Err(serde::de::Error::custom(
            "Too small: expected number to be >=0",
        ));
    }
    Ok(number_to_i64_lossy(&n))
}

/// `z.number().int().min(0).optional()` → strict optional non-negative
/// integer (`pinnedAccountIndex`, `affinityGeneration`): fractional,
/// negative or explicit-`null` values fail the parse (absence is handled by
/// `#[serde(default)]`).
pub fn de_opt_int_min0_strict<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    let n = serde_json::Number::deserialize(deserializer)?;
    let value = number_as_strict_int(&n)
        .ok_or_else(|| serde::de::Error::custom("Invalid input: expected int, received number"))?;
    if value < 0 {
        return Err(serde::de::Error::custom(
            "Too small: expected number to be >=0",
        ));
    }
    Ok(Some(value))
}

/// `z.number().int().positive()` → strict integer > 0 (`expires`,
/// `expires_in`): zero, negative or fractional values fail the parse.
pub fn de_int_positive_strict<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<i64, D::Error> {
    let n = serde_json::Number::deserialize(deserializer)?;
    let value = number_as_strict_int(&n)
        .ok_or_else(|| serde::de::Error::custom("Invalid input: expected int, received number"))?;
    if value <= 0 {
        return Err(serde::de::Error::custom(
            "Too small: expected number to be >0",
        ));
    }
    Ok(value)
}

/// `z.string().min(1)` → non-empty `String` (empty string fails the parse).
pub fn de_string_min1<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let s = String::deserialize(deserializer)?;
    if s.is_empty() {
        return Err(serde::de::Error::custom(
            "Too small: expected string to have >=1 characters",
        ));
    }
    Ok(s)
}

// ============================================================================
// Version literal marker (z.literal(N) on the `version` key)
// ============================================================================

/// Zero-sized marker enforcing `version: N` at (de)serialization time.
/// Serializes as the integer `N`; deserialization accepts any JSON number
/// equal to `N` (JSON `3.0` equals `3`, matching `JSON.parse` + `z.literal`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VersionLiteral<const N: u8>;

impl<const N: u8> VersionLiteral<N> {
    pub const VALUE: u8 = N;

    pub fn value(&self) -> u8 {
        N
    }
}

impl<const N: u8> Serialize for VersionLiteral<N> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(u64::from(N))
    }
}

impl<'de, const N: u8> Deserialize<'de> for VersionLiteral<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let n = serde_json::Number::deserialize(deserializer)?;
        if n.as_f64() == Some(f64::from(N)) {
            Ok(VersionLiteral)
        } else {
            Err(serde::de::Error::custom(format!(
                "Invalid input: expected {N}"
            )))
        }
    }
}

/// `z.literal(1)` version marker (flagged storage, WAL journal, V1 storage).
pub type Version1 = VersionLiteral<1>;
/// `z.literal(3)` version marker (account storage V3).
pub type Version3 = VersionLiteral<3>;

// ============================================================================
// Tests (ported from test/schemas.test.ts — safeParseJson / getValidationErrors
// / safeParseX suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug, PartialEq, serde::Deserialize)]
    struct Demo {
        a: f64,
    }

    #[test]
    fn safe_parse_json_parses_valid_json_matching_schema() {
        let result: Option<Demo> = safe_parse_json_with_context(r#"{"a":1}"#, "test.happy");
        assert_eq!(result, Some(Demo { a: 1.0 }));
    }

    #[test]
    fn safe_parse_json_returns_none_on_syntax_error() {
        let result: Option<Demo> = safe_parse_json_with_context("{not-valid-json", "test.syntax");
        assert_eq!(result, None);
    }

    #[test]
    fn safe_parse_json_returns_none_when_schema_rejects() {
        let result: Option<Demo> = safe_parse_json_with_context(r#"{"a":"x"}"#, "test.schema");
        assert_eq!(result, None);
    }

    #[test]
    fn safe_parse_json_default_context_smoke() {
        let result: Option<Demo> = safe_parse_json("not-json");
        assert_eq!(result, None);
    }

    #[test]
    fn safe_parse_json_validates_any_account_storage_end_to_end() {
        let raw = serde_json::to_string(&json!({
            "version": 3,
            "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 1 }],
            "activeIndex": 0,
        }))
        .unwrap();
        let result: Option<AnyAccountStorage> =
            safe_parse_json_with_context(&raw, "test.end-to-end");
        let storage = result.expect("should parse");
        assert_eq!(storage.version(), 3);
    }

    #[test]
    fn safe_parse_json_keeps_workspaces_through_load_round_trip_issue_491() {
        let raw = serde_json::to_string(&json!({
            "version": 3,
            "accounts": [{
                "refreshToken": "rt",
                "addedAt": 1,
                "lastUsed": 1,
                "accountId": "org-AAAA",
                "email": "user@gmail.com",
                "workspaces": [{ "id": "org-AAAA", "name": "Personal Plus", "enabled": true }],
                "currentWorkspaceIndex": 0,
            }],
            "activeIndex": 0,
        }))
        .unwrap();
        let result: Option<AnyAccountStorage> =
            safe_parse_json_with_context(&raw, "test.workspaces");
        let AnyAccountStorage::V3(storage) = result.expect("should parse") else {
            panic!("expected V3 storage");
        };
        let account = &storage.accounts[0];
        let workspaces = account.workspaces.as_ref().expect("workspaces kept");
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name.as_deref(), Some("Personal Plus"));
        assert_eq!(account.current_workspace_index, Some(0));
    }

    #[test]
    fn validation_errors_returns_empty_for_valid_data() {
        let errors = validation_errors(
            super::super::plugin_config::plugin_config_issues,
            &json!({ "codexMode": true }),
        );
        assert!(errors.is_empty());
    }

    #[test]
    fn validation_errors_returns_messages_for_invalid_data() {
        let errors = validation_errors(
            super::super::plugin_config::plugin_config_issues,
            &json!({ "codexMode": "yes" }),
        );
        assert!(!errors.is_empty());
        assert!(errors[0].contains("codexMode"));
    }

    #[test]
    fn validation_errors_omits_path_prefix_when_path_is_empty() {
        let errors = validation_errors(
            super::super::plugin_config::plugin_config_issues,
            &json!("not-an-object"),
        );
        assert!(!errors.is_empty());
        assert!(errors[0].starts_with("Invalid input"));
    }

    #[test]
    fn schema_issue_format_joins_path_with_dots() {
        let issue = SchemaIssue::new(
            vec!["accounts".into(), "0".into(), "refreshToken".into()],
            "Too small: expected string to have >=1 characters",
        );
        assert_eq!(
            issue.format(),
            "accounts.0.refreshToken: Too small: expected string to have >=1 characters"
        );
    }

    #[test]
    fn version_literal_round_trip_and_rejection() {
        assert!(serde_json::from_value::<Version3>(json!(3)).is_ok());
        assert!(serde_json::from_value::<Version3>(json!(3.0)).is_ok());
        assert!(serde_json::from_value::<Version3>(json!(2)).is_err());
        assert!(serde_json::from_value::<Version3>(json!("3")).is_err());
        assert_eq!(serde_json::to_string(&Version3::default()).unwrap(), "3");
        assert!(serde_json::from_value::<Version1>(json!(1)).is_ok());
        assert!(serde_json::from_value::<Version1>(json!(2)).is_err());
    }

    #[test]
    fn number_helpers_match_zod_semantics() {
        let int = serde_json::Number::from(5);
        let frac = serde_json::Number::from_f64(12.5).unwrap();
        let whole_float = serde_json::Number::from_f64(12.0).unwrap();
        assert_eq!(number_to_i64_lossy(&int), 5);
        assert_eq!(number_to_i64_lossy(&frac), 12);
        assert_eq!(number_as_strict_int(&int), Some(5));
        assert_eq!(number_as_strict_int(&frac), None);
        // JS Number.isInteger(12.0) === true.
        assert_eq!(number_as_strict_int(&whole_float), Some(12));
    }

    #[test]
    fn fmt_js_number_prints_integers_without_decimal_point() {
        assert_eq!(fmt_js_number(1000.0), "1000");
        assert_eq!(fmt_js_number(0.0), "0");
        assert_eq!(fmt_js_number(12.5), "12.5");
    }

    #[test]
    fn safe_parse_helpers_return_none_on_invalid_shapes() {
        assert!(
            safe_parse_account_storage(
                &json!({ "version": 99, "accounts": [], "activeIndex": 0 })
            )
            .is_none()
        );
        assert!(
            safe_parse_account_storage_v3(
                &json!({ "version": 1, "accounts": [], "activeIndex": 0 })
            )
            .is_none()
        );
        assert!(safe_parse_plugin_config(&json!("invalid")).is_none());
        assert!(safe_parse_token_result(&json!({ "type": "unknown" })).is_none());
        assert!(safe_parse_oauth_token_response(&json!({ "invalid": true })).is_none());
        assert!(
            safe_parse_flagged_account_storage_v1(&json!({ "version": 99, "accounts": [] }))
                .is_none()
        );
        assert!(safe_parse_accounts_journal_entry(&json!({ "version": 2 })).is_none());
    }

    #[test]
    fn safe_parse_helpers_return_values_on_valid_shapes() {
        assert!(safe_parse_account_storage(&json!({
            "version": 1,
            "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 1 }],
            "activeIndex": 0,
        }))
        .is_some());
        assert!(safe_parse_account_storage_v3(&json!({
            "version": 3,
            "accounts": [],
            "activeIndex": 0,
        }))
        .is_some());
        assert!(safe_parse_plugin_config(&json!({ "codexMode": true })).is_some());
        assert!(safe_parse_token_result(&json!({ "type": "failed" })).is_some());
        assert!(safe_parse_oauth_token_response(&json!({
            "access_token": "at",
            "expires_in": 3600,
        }))
        .is_some());
        assert!(
            safe_parse_flagged_account_storage_v1(&json!({ "version": 1, "accounts": [] }))
                .is_some()
        );
        assert!(safe_parse_accounts_journal_entry(&json!({
            "version": 1,
            "content": "{}",
            "checksum": "c",
        }))
        .is_some());
    }
}
