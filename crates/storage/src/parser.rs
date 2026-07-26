//! Port of `lib/storage/storage-parser.ts` — the Zod-guarded JSON load
//! boundary for account storage.
//!
//! Behavior source: spec 02 §8.2 / gotcha 5 (§17 SyntaxError contract):
//! - The primary read retries transient lock codes
//!   (`withFileOperationRetry`) so a momentary Windows lock doesn't trigger
//!   WAL/backup recovery (storage-01). ENOENT is not retryable and
//!   propagates.
//! - JSON **SyntaxError propagates unchanged** — recovery paths key off it.
//!   Rust surface: the error type is `io::Error` (crate-wide convention with
//!   the sibling modules); a syntax error is minted as
//!   `ErrorKind::InvalidData` with the `serde_json::Error` as source, so it
//!   is never mistaken for ENOENT by the recovery ladder.
//! - Schema mismatches do NOT throw: the raw value falls through to the
//!   legacy normalizer with non-empty `schema_errors`.
//! - On the schema-valid path, the typed storage round-trips back through a
//!   `Value` before normalization, reproducing zod's strip+reorder.

use std::io;
use std::path::Path;

use cma_core::fs_retry::with_file_operation_retry;
use cma_core::json_io::read_text_file;
use cma_core::schemas::parse::safe_parse_json_with_context;
use serde_json::Value;

use crate::normalize::normalize_account_storage;
use crate::public_types::{AccountStorageV3, AnyAccountStorage};

/// Result triple of `parseAndNormalizeStorage`.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedStorage {
    /// `normalizeAccountStorage(data)` — `None` for unrecognized shapes.
    pub normalized: Option<AccountStorageV3>,
    /// The raw `version` value when `data` is a record AND the value is an
    /// integer number (TS carried the raw `unknown`; non-numeric versions
    /// surface as `None`, which the strict `!==` comparison treats the same).
    pub stored_version: Option<i64>,
    /// `getValidationErrors(AnyAccountStorageSchema, data)` — empty on the
    /// schema-valid path. (serde reports the first failing field, so the
    /// legacy path yields a single-entry list; the strings are log-only.)
    pub schema_errors: Vec<String>,
}

impl ParsedStorage {
    /// True when the on-disk `version` differs from the normalized version
    /// (i.e. a v1 file that needs a migration persist). JS strict-compare
    /// analogue: `storedVersion !== normalized.version` with
    /// `normalized.version === 3`.
    pub fn needs_version_migration(&self) -> bool {
        self.normalized.is_some() && self.stored_version != Some(3)
    }
}

/// `getValidationErrors(AnyAccountStorageSchema, data)` analogue.
fn any_account_storage_schema_errors(data: &Value) -> Vec<String> {
    match serde_json::from_value::<AnyAccountStorage>(data.clone()) {
        Ok(_) => Vec::new(),
        Err(error) => vec![error.to_string()],
    }
}

/// `parseAndNormalizeStorage(data, …)` — schema errors + normalizer + stored
/// version, computed even on the validated path (they'll be `[]`).
pub fn parse_and_normalize_storage(data: &Value) -> ParsedStorage {
    let schema_errors = any_account_storage_schema_errors(data);
    let normalized = normalize_account_storage(data);
    let stored_version = if cma_core::utils::is_record(data) {
        data.get("version").and_then(Value::as_i64)
    } else {
        None
    };
    ParsedStorage {
        normalized,
        stored_version,
        schema_errors,
    }
}

/// `loadAccountsFromPath(path, deps)` — see module docs for the error
/// contract. ENOENT propagates with `ErrorKind::NotFound`; a JSON syntax
/// error propagates as `ErrorKind::InvalidData` (the TS SyntaxError).
pub async fn load_accounts_from_path(
    path: impl AsRef<Path>,
) -> Result<ParsedStorage, io::Error> {
    let path = path.as_ref();
    // Retry only transient FS lock codes on the primary read (storage-01).
    let content: String = with_file_operation_retry(|| {
        let path = path.to_path_buf();
        async move { read_text_file(&path) }
    })
    .await?;
    parse_storage_content(&content)
}

/// Shared content half of the boundary (also used by the WAL replay in
/// `crate::load`, which parses `entry.content` with the same semantics but a
/// fail-closed error path).
pub(crate) fn parse_storage_content(content: &str) -> Result<ParsedStorage, io::Error> {
    // Zod-guarded boundary first: fail-closed on syntax OR schema mismatch.
    let validated: Option<AnyAccountStorage> =
        safe_parse_json_with_context(content, "storage-parser.loadAccountsFromPath");
    if let Some(validated) = validated {
        let value = serde_json::to_value(&validated).map_err(io::Error::other)?;
        return Ok(parse_and_normalize_storage(&value));
    }

    // Disambiguate: SyntaxError propagates (recovery contract); schema
    // mismatches fall through to the legacy normalizer path.
    let data: Value = serde_json::from_str(content)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    Ok(parse_and_normalize_storage(&data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn missing_file_propagates_enoent_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let error = load_accounts_from_path(dir.path().join("missing.json"))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn json_syntax_error_propagates_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.json");
        std::fs::write(&path, "{ this is not json").unwrap();
        let error = load_accounts_from_path(&path).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(
            error
                .get_ref()
                .is_some_and(|source| source.is::<serde_json::Error>()),
            "SyntaxError propagates as the source"
        );
    }

    #[tokio::test]
    async fn schema_valid_file_normalizes_with_no_schema_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "version": 3,
                "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 2 }],
                "activeIndex": 0,
            }))
            .unwrap(),
        )
        .unwrap();
        let parsed = load_accounts_from_path(&path).await.unwrap();
        assert!(parsed.schema_errors.is_empty());
        assert!(!parsed.needs_version_migration());
        let normalized = parsed.normalized.expect("normalizes");
        assert_eq!(normalized.accounts.len(), 1);
    }

    #[tokio::test]
    async fn schema_invalid_json_falls_to_legacy_path_with_schema_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        // activeIndex: -1 violates the schema (min 0) but the legacy
        // normalizer still recognizes the record shape.
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "version": 3,
                "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 2 }],
                "activeIndex": -1,
            }))
            .unwrap(),
        )
        .unwrap();
        let parsed = load_accounts_from_path(&path).await.unwrap();
        assert!(!parsed.schema_errors.is_empty());
        let normalized = parsed.normalized.expect("legacy path normalizes");
        assert_eq!(normalized.active_index, 0);
    }

    #[tokio::test]
    async fn v1_file_reports_stored_version_1_and_needs_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.json");
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "version": 1,
                "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 2 }],
                "activeIndex": 0,
            }))
            .unwrap(),
        )
        .unwrap();
        let parsed = load_accounts_from_path(&path).await.unwrap();
        assert!(parsed.schema_errors.is_empty());
        assert_eq!(parsed.stored_version, Some(1));
        assert!(parsed.needs_version_migration());
    }

    #[test]
    fn parse_and_normalize_reports_unrecognized_shapes() {
        let parsed = parse_and_normalize_storage(&json!({ "version": 42 }));
        assert!(parsed.normalized.is_none());
        assert!(!parsed.schema_errors.is_empty());
        assert_eq!(parsed.stored_version, Some(42));
        // Non-record data has no stored version.
        let parsed = parse_and_normalize_storage(&json!([1, 2, 3]));
        assert!(parsed.normalized.is_none());
        assert_eq!(parsed.stored_version, None);
    }
}
