//! Accounts journal (WAL) entry schema — port of
//! `AccountsJournalEntrySchema` from `lib/schemas.ts` (spec 01 §3.2, spec 02
//! §3.2).
//!
//! On-disk format (compact `JSON.stringify(entry)`, spec 02 §3.2):
//! `{"version":1,"createdAt":<ms>,"path":"<accountsPath>","checksum":"<sha256 hex>","content":"<pretty accounts JSON>"}`
//!
//! Serialization field order matches the TS writer's object construction
//! order (`storage.ts` `writeJournal`): `version, createdAt, path, checksum,
//! content`. On read, the schema requires `version === 1` plus string
//! `content`/`checksum`; `createdAt`/`path` are optional. The checksum
//! integrity check (lowercase sha256 hex of `content`) and the compact
//! serialization itself are the storage crate's business.

use serde::{Deserialize, Serialize};

use super::parse::{Version1, de_opt_number_lenient, de_opt_strict};

/// WAL journal entry used to persist in-flight account storage state.
/// `content` is a JSON string that parses into an `AnyAccountStorage`
/// payload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountsJournalEntry {
    /// Literal `1`.
    pub version: Version1,
    /// ms epoch (always written; optional on read).
    #[serde(
        rename = "createdAt",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub created_at: Option<i64>,
    /// The PRIMARY accounts path (not the wal path). Always written;
    /// optional on read.
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub path: Option<String>,
    /// Lowercase sha256 hex of `content`. Mismatch ⇒ WAL invalid (checked by
    /// the storage crate on replay).
    pub checksum: String,
    /// The exact string that will be written to the accounts file (pretty,
    /// 2-space).
    pub content: String,
}

impl AccountsJournalEntry {
    /// Build a fully-populated entry the way the TS writer does
    /// (`{version:1, createdAt, path, checksum, content}`).
    pub fn new(
        created_at: i64,
        path: impl Into<String>,
        checksum: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            version: Version1::default(),
            created_at: Some(created_at),
            path: Some(path.into()),
            checksum: checksum.into(),
            content: content.into(),
        }
    }
}

// ============================================================================
// Tests (ported from test/schemas.test.ts AccountsJournalEntrySchema suite)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_a_valid_entry_with_required_fields() {
        let entry: AccountsJournalEntry =
            serde_json::from_value(json!({ "version": 1, "content": "{}", "checksum": "abc" }))
                .expect("parses");
        assert_eq!(entry.content, "{}");
        assert_eq!(entry.checksum, "abc");
        assert_eq!(entry.created_at, None);
        assert_eq!(entry.path, None);
    }

    #[test]
    fn accepts_optional_created_at_and_path() {
        let entry: AccountsJournalEntry = serde_json::from_value(json!({
            "version": 1,
            "content": "{}",
            "checksum": "abc",
            "createdAt": 123,
            "path": "/tmp/a",
        }))
        .expect("parses");
        assert_eq!(entry.created_at, Some(123));
        assert_eq!(entry.path.as_deref(), Some("/tmp/a"));
    }

    #[test]
    fn rejects_non_1_version() {
        let result: Result<AccountsJournalEntry, _> =
            serde_json::from_value(json!({ "version": 2, "content": "{}", "checksum": "abc" }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_missing_content() {
        let result: Result<AccountsJournalEntry, _> =
            serde_json::from_value(json!({ "version": 1, "checksum": "abc" }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_wrong_types_content_number() {
        let result: Result<AccountsJournalEntry, _> =
            serde_json::from_value(json!({ "version": 1, "content": 12, "checksum": "abc" }));
        assert!(result.is_err());
    }

    #[test]
    fn zod_optional_is_not_nullable_explicit_null_fails() {
        for key in ["createdAt", "path"] {
            let result: Result<AccountsJournalEntry, _> = serde_json::from_value(json!({
                "version": 1,
                "content": "{}",
                "checksum": "abc",
                key: null,
            }));
            assert!(result.is_err(), "{key}: null should fail the parse");
        }
    }

    #[test]
    fn compact_serialization_matches_ts_writer_key_order() {
        let entry = AccountsJournalEntry::new(1_753_500_000_000, "/tmp/accounts.json", "c0ffee", "{}");
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"version":1,"createdAt":1753500000000,"path":"/tmp/accounts.json","checksum":"c0ffee","content":"{}"}"#
        );
    }

    #[test]
    fn round_trips_content_string_verbatim() {
        let pretty = "{\n  \"version\": 3,\n  \"accounts\": [],\n  \"activeIndex\": 0\n}";
        let entry = AccountsJournalEntry::new(1, "p", "c", pretty);
        let raw = serde_json::to_string(&entry).unwrap();
        let parsed: AccountsJournalEntry = serde_json::from_str(&raw).expect("parses");
        assert_eq!(parsed.content, pretty);
    }
}
