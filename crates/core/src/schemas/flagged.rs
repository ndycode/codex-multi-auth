//! Flagged (quarantined) account storage schemas — port of
//! `FlaggedAccountMetadataV1Schema` / `FlaggedAccountStorageV1Schema` from
//! `lib/schemas.ts` (spec 01 §3.2, spec 02 §3.5/§4).
//!
//! `FlaggedAccountMetadataV1Schema` = `AccountMetadataV3Schema.extend({
//! flaggedAt, flaggedReason?, lastError? }).passthrough()` — unknown keys
//! SURVIVE schema validation. In Rust the V3 fields are inlined (declaration
//! order = zod schema order: the V3 fields first, then the flagged
//! extensions) and passthrough is `#[serde(flatten)] extra` so unknown keys
//! round-trip. Note that the on-disk field ORDER of the flagged file is
//! ultimately decided by the storage crate's `normalize_flagged_storage`
//! whitelist rebuild (spec 02 §3.5) — this schema only has to keep the data.

use serde::{Deserialize, Serialize};

use super::account_storage::{
    AccountIdSource, AccountMetadataV3, CooldownReason, RateLimitStateV3, SwitchReason, Workspace,
};
use super::parse::{
    Version1, de_number_lenient, de_opt_number_lenient, de_opt_strict, de_string_min1,
};

/// Flagged account metadata V1 — a V3 account plus flagging info, with
/// passthrough of unknown keys.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FlaggedAccountMetadataV1 {
    // ---- AccountMetadataV3 fields (schema declaration order) ----
    #[serde(
        rename = "accountId",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id: Option<String>,
    #[serde(
        rename = "accountIdSource",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id_source: Option<AccountIdSource>,
    #[serde(
        rename = "accountLabel",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_label: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub email: Option<String>,
    /// Required, non-empty.
    #[serde(rename = "refreshToken", deserialize_with = "de_string_min1")]
    pub refresh_token: String,
    #[serde(
        rename = "accessToken",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub access_token: Option<String>,
    #[serde(
        rename = "expiresAt",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<i64>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
    /// Required, ms epoch.
    #[serde(rename = "addedAt", deserialize_with = "de_number_lenient")]
    pub added_at: i64,
    /// Required, ms epoch.
    #[serde(rename = "lastUsed", deserialize_with = "de_number_lenient")]
    pub last_used: i64,
    #[serde(
        rename = "lastSwitchReason",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_switch_reason: Option<SwitchReason>,
    #[serde(
        rename = "rateLimitResetTimes",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub rate_limit_reset_times: Option<RateLimitStateV3>,
    #[serde(
        rename = "coolingDownUntil",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub cooling_down_until: Option<i64>,
    #[serde(
        rename = "cooldownReason",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub cooldown_reason: Option<CooldownReason>,
    #[serde(
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspaces: Option<Vec<Workspace>>,
    #[serde(
        rename = "currentWorkspaceIndex",
        default,
        deserialize_with = "de_opt_number_lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_workspace_index: Option<i64>,
    // ---- Flagging extensions ----
    /// Required, ms epoch — when the account was quarantined.
    #[serde(rename = "flaggedAt", deserialize_with = "de_number_lenient")]
    pub flagged_at: i64,
    #[serde(
        rename = "flaggedReason",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub flagged_reason: Option<String>,
    #[serde(
        rename = "lastError",
        default,
        deserialize_with = "de_opt_strict",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_error: Option<String>,
    /// zod `.passthrough()`: unknown keys survive validation and round-trip.
    /// (They are later dropped by the storage crate's
    /// `normalize_flagged_storage` whitelist before persisting — spec 02
    /// §3.5.) Do not put keys here that collide with the named fields.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl FlaggedAccountMetadataV1 {
    /// Build a flagged entry from a V3 account plus flagging info.
    pub fn from_account(
        account: AccountMetadataV3,
        flagged_at: i64,
        flagged_reason: Option<String>,
        last_error: Option<String>,
    ) -> Self {
        Self {
            account_id: account.account_id,
            account_id_source: account.account_id_source,
            account_label: account.account_label,
            email: account.email,
            refresh_token: account.refresh_token,
            access_token: account.access_token,
            expires_at: account.expires_at,
            enabled: account.enabled,
            added_at: account.added_at,
            last_used: account.last_used,
            last_switch_reason: account.last_switch_reason,
            rate_limit_reset_times: account.rate_limit_reset_times,
            cooling_down_until: account.cooling_down_until,
            cooldown_reason: account.cooldown_reason,
            workspaces: account.workspaces,
            current_workspace_index: account.current_workspace_index,
            flagged_at,
            flagged_reason,
            last_error,
            extra: serde_json::Map::new(),
        }
    }

    /// The embedded V3 account view (flagging info and passthrough keys
    /// dropped) — used when restoring a quarantined account into the pool.
    pub fn to_account_metadata(&self) -> AccountMetadataV3 {
        AccountMetadataV3 {
            account_id: self.account_id.clone(),
            account_id_source: self.account_id_source,
            account_label: self.account_label.clone(),
            email: self.email.clone(),
            refresh_token: self.refresh_token.clone(),
            access_token: self.access_token.clone(),
            expires_at: self.expires_at,
            enabled: self.enabled,
            added_at: self.added_at,
            last_used: self.last_used,
            last_switch_reason: self.last_switch_reason,
            rate_limit_reset_times: self.rate_limit_reset_times.clone(),
            cooling_down_until: self.cooling_down_until,
            cooldown_reason: self.cooldown_reason,
            workspaces: self.workspaces.clone(),
            current_workspace_index: self.current_workspace_index,
        }
    }
}

/// Flagged account storage V1 format (`{version: 1, accounts: []}`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FlaggedAccountStorageV1 {
    /// Literal `1`.
    pub version: Version1,
    pub accounts: Vec<FlaggedAccountMetadataV1>,
}

impl FlaggedAccountStorageV1 {
    /// Empty flagged storage (`{version:1, accounts:[]}`).
    pub fn empty() -> Self {
        Self {
            version: Version1::default(),
            accounts: Vec::new(),
        }
    }
}

// ============================================================================
// Tests (ported from test/schemas.test.ts flagged suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_account() -> serde_json::Value {
        json!({ "refreshToken": "rt", "addedAt": 1, "lastUsed": 1, "flaggedAt": 2 })
    }

    #[test]
    fn accepts_version_1_with_empty_accounts() {
        let storage: FlaggedAccountStorageV1 =
            serde_json::from_value(json!({ "version": 1, "accounts": [] })).expect("parses");
        assert!(storage.accounts.is_empty());
    }

    #[test]
    fn accepts_populated_accounts_with_optional_fields() {
        let storage: FlaggedAccountStorageV1 = serde_json::from_value(json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt",
                "addedAt": 1,
                "lastUsed": 1,
                "flaggedAt": 2,
                "flaggedReason": "rate-limit",
                "lastError": "429",
                "email": "a@b.com",
            }],
        }))
        .expect("parses");
        let account = &storage.accounts[0];
        assert_eq!(account.flagged_reason.as_deref(), Some("rate-limit"));
        assert_eq!(account.last_error.as_deref(), Some("429"));
        assert_eq!(account.email.as_deref(), Some("a@b.com"));
    }

    #[test]
    fn rejects_non_1_version() {
        let result: Result<FlaggedAccountStorageV1, _> =
            serde_json::from_value(json!({ "version": 2, "accounts": [] }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_missing_accounts_field() {
        let result: Result<FlaggedAccountStorageV1, _> =
            serde_json::from_value(json!({ "version": 1 }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_account_missing_required_flagged_at() {
        let result: Result<FlaggedAccountStorageV1, _> = serde_json::from_value(json!({
            "version": 1,
            "accounts": [{ "refreshToken": "rt", "addedAt": 1, "lastUsed": 1 }],
        }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_account_with_wrong_types() {
        let result: Result<FlaggedAccountStorageV1, _> = serde_json::from_value(json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt",
                "addedAt": 1,
                "lastUsed": 1,
                "flaggedAt": "not-a-number",
            }],
        }));
        assert!(result.is_err());
    }

    #[test]
    fn permits_known_v3_fields_like_workspaces() {
        let mut value = valid_account();
        value["workspaces"] = json!([]);
        let account: FlaggedAccountMetadataV1 =
            serde_json::from_value(value).expect("workspaces accepted");
        assert_eq!(account.workspaces.as_deref(), Some(&[][..]));
    }

    #[test]
    fn passthrough_preserves_unknown_keys_through_round_trip() {
        let mut value = valid_account();
        value["someFutureField"] = json!({ "nested": true });
        value["another"] = json!(7);
        let account: FlaggedAccountMetadataV1 =
            serde_json::from_value(value).expect("unknown keys accepted");
        assert_eq!(
            account.extra.get("someFutureField"),
            Some(&json!({ "nested": true }))
        );
        assert_eq!(account.extra.get("another"), Some(&json!(7)));
        let serialized = serde_json::to_value(&account).expect("serializes");
        assert_eq!(
            serialized.get("someFutureField"),
            Some(&json!({ "nested": true }))
        );
        assert_eq!(serialized.get("another"), Some(&json!(7)));
        assert_eq!(serialized.get("refreshToken"), Some(&json!("rt")));
    }

    #[test]
    fn inherits_v3_required_fields() {
        let account: FlaggedAccountMetadataV1 =
            serde_json::from_value(valid_account()).expect("parses");
        assert_eq!(account.refresh_token, "rt");
        assert_eq!(account.flagged_at, 2);
    }

    #[test]
    fn rejects_when_flagged_at_is_missing() {
        let result: Result<FlaggedAccountMetadataV1, _> =
            serde_json::from_value(json!({ "refreshToken": "rt", "addedAt": 1, "lastUsed": 1 }));
        assert!(result.is_err());
    }

    #[test]
    fn rejects_empty_refresh_token() {
        let mut value = valid_account();
        value["refreshToken"] = json!("");
        let result: Result<FlaggedAccountMetadataV1, _> = serde_json::from_value(value);
        assert!(result.is_err());
    }

    #[test]
    fn zod_optional_is_not_nullable_but_passthrough_nulls_survive() {
        // Known optional fields reject explicit null (zod optional ≠
        // nullable) ...
        for key in ["flaggedReason", "lastError", "email", "enabled"] {
            let mut value = valid_account();
            value[key] = json!(null);
            let result: Result<FlaggedAccountMetadataV1, _> = serde_json::from_value(value);
            assert!(result.is_err(), "{key}: null should fail the parse");
        }
        // ... while UNKNOWN keys pass through untouched, null included
        // (`.passthrough()` performs no validation on them).
        let mut value = valid_account();
        value["someUnknown"] = json!(null);
        let account: FlaggedAccountMetadataV1 =
            serde_json::from_value(value).expect("unknown null passes through");
        assert_eq!(account.extra.get("someUnknown"), Some(&json!(null)));
    }

    #[test]
    fn account_metadata_round_trip_helpers() {
        let account: FlaggedAccountMetadataV1 =
            serde_json::from_value(valid_account()).expect("parses");
        let v3 = account.to_account_metadata();
        assert_eq!(v3.refresh_token, "rt");
        let back = FlaggedAccountMetadataV1::from_account(v3, 9, Some("why".into()), None);
        assert_eq!(back.flagged_at, 9);
        assert_eq!(back.flagged_reason.as_deref(), Some("why"));
        assert!(back.extra.is_empty());
    }
}
