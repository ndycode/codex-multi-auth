//! Port of `lib/auth/token-utils.ts`: JWT payload mining — account-id/email
//! extraction, workspace candidate collection & selection.
//!
//! Behavior contracts (spec 07 §5, gotchas 17/18):
//! - candidate ordering (token -> access-orgs -> id_token -> id-orgs) and the
//!   first-wins dedupe by accountId are behavior, not style;
//! - `select_best_account_candidate`'s 6-step preference order is exact;
//! - only `token`/`id_token` sources auto-follow token changes; `org`/`manual`
//!   selections are sticky across refreshes;
//! - `extract_account_id` returns the RAW (untrimmed) claim value, while the
//!   id-token payload miner (`extract_account_id_from_payload`) trims — this
//!   asymmetry is deliberate and test-pinned.

use serde_json::Value;

use crate::constants::JWT_CLAIM_PATH;
use crate::jwt::decode_jwt_value;
use crate::schemas::account_storage::AccountIdSource;

/// Account ID candidate from token or organization data.
#[derive(Debug, Clone)]
pub struct AccountIdCandidate {
    pub account_id: String,
    pub label: String,
    pub source: AccountIdSource,
    pub is_default: Option<bool>,
    pub is_personal: Option<bool>,
}

/// Converts a value to a trimmed string if it's a non-empty string.
/// Local helper — returns `None` for non-strings (different from
/// `lib/utils.toStringValue`, which stringifies everything).
fn to_string_value(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Converts a value to boolean if possible (`true`/`false` literals, or the
/// case-insensitive trimmed strings "true"/"false").
fn to_boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// First value among `keys` that is present AND not JSON null — the Rust
/// equivalent of a TS `record.a ?? record.b ?? …` nullish chain over raw
/// values (a present `false`/`0`/`""` STOPS the chain).
fn first_non_nullish<'a>(record: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .filter_map(|key| record.get(*key))
        .find(|value| !value.is_null())
}

/// Chain of [`to_string_value`] lookups: unlike [`first_non_nullish`], a
/// non-string or blank value lets the chain continue to the next key.
fn string_chain(record: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| record.get(*key))
        .find_map(to_string_value)
}

/// Formats account ID to its last 6 characters for display.
fn format_account_id_suffix(account_id: &str) -> String {
    let count = account_id.chars().count();
    if count > 6 {
        account_id.chars().skip(count - 6).collect()
    } else {
        account_id.to_string()
    }
}

/// Formats a label for token-derived account candidates.
fn format_token_candidate_label(prefix: &str, account_id: &str) -> String {
    format!("{prefix} [id:{}]", format_account_id_suffix(account_id))
}

/// Extracts an account ID from a JWT payload: nested claim first, then the
/// direct `chatgpt_account_id` / `account_id` / `accountId` keys (trimmed).
fn extract_account_id_from_payload(payload: Option<&Value>) -> Option<String> {
    let payload = payload?;
    if let Some(auth) = payload.get(JWT_CLAIM_PATH).and_then(|v| v.as_object())
        && let Some(id) = auth.get("chatgpt_account_id").and_then(to_string_value)
    {
        return Some(id);
    }

    let record = payload.as_object()?;
    string_chain(record, &["chatgpt_account_id", "account_id", "accountId"])
}

/// Normalizes candidate arrays from various response formats: a direct array,
/// or a record wrapping one under `data`/`items`/`accounts`/`organizations`/
/// `workspaces`/`teams`.
fn normalize_candidate_array(value: &Value) -> Option<&Vec<Value>> {
    if let Value::Array(items) = value {
        return Some(items);
    }
    let record = value.as_object()?;
    let nested = first_non_nullish(
        record,
        &["data", "items", "accounts", "organizations", "workspaces", "teams"],
    )?;
    match nested {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

/// Extracts a single account candidate from a record.
fn extract_candidate_from_record(
    record: &serde_json::Map<String, Value>,
    source: AccountIdSource,
) -> Option<AccountIdCandidate> {
    let account_id = string_chain(
        record,
        &[
            "account_id",
            "accountId",
            "chatgpt_account_id",
            "organization_id",
            "org_id",
            "workspace_id",
            "team_id",
            "id",
        ],
    )?;

    let name = string_chain(
        record,
        &[
            "name",
            "display_name",
            "title",
            "organization_name",
            "workspace_name",
            "team_name",
            "slug",
        ],
    );
    let candidate_type = string_chain(record, &["type", "plan_type", "kind", "account_type"]);
    let role = string_chain(record, &["role", "membership_role", "user_role"]);
    let is_default = first_non_nullish(
        record,
        &[
            "is_default",
            "isDefault",
            "default",
            "primary",
            "is_active",
            "isActive",
            "current",
        ],
    )
    .and_then(to_boolean);
    let is_personal = first_non_nullish(record, &["is_personal", "isPersonal", "personal"])
        .and_then(to_boolean);

    let suffix = format_account_id_suffix(&account_id);
    let mut label_parts: Vec<String> = Vec::new();
    let mut label_base = name.clone().unwrap_or_else(|| "Workspace".to_string());

    if name.is_none()
        && let Some(t) = &candidate_type
    {
        label_base = t.clone();
    }

    if let Some(t) = &candidate_type {
        let differs_from_name = match &name {
            None => true,
            Some(n) => n.to_lowercase() != t.to_lowercase(),
        };
        if differs_from_name {
            label_parts.push(t.clone());
        }
    }
    if let Some(r) = &role {
        label_parts.push(format!("role:{r}"));
    }
    if is_personal == Some(true) {
        label_parts.push("personal".to_string());
    }

    let meta = if label_parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", label_parts.join(", "))
    };
    let label = format!("{label_base}{meta} [id:{suffix}]");

    Some(AccountIdCandidate {
        account_id,
        label,
        source,
        is_default,
        is_personal,
    })
}

/// Collects candidates from a list-shaped value.
fn collect_candidates_from_list(value: &Value, source: AccountIdSource) -> Vec<AccountIdCandidate> {
    let mut result = Vec::new();
    let Some(list) = normalize_candidate_array(value) else {
        return result;
    };
    for item in list {
        let Some(record) = item.as_object() else {
            continue;
        };
        if let Some(candidate) = extract_candidate_from_record(record, source) {
            result.push(candidate);
        }
    }
    result
}

/// Collects candidates from a JWT payload: the well-known org keys at the top
/// level first, then the same keys inside the nested auth claim.
fn collect_candidates_from_payload(
    payload: Option<&Value>,
    source: AccountIdSource,
) -> Vec<AccountIdCandidate> {
    let Some(record) = payload.and_then(|p| p.as_object()) else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    let keys = ["organizations", "orgs", "accounts", "workspaces", "teams"];
    for key in keys {
        if let Some(value) = record.get(key) {
            candidates.extend(collect_candidates_from_list(value, source));
        }
    }

    if let Some(auth) = record.get(JWT_CLAIM_PATH).and_then(|v| v.as_object()) {
        for key in keys {
            if let Some(value) = auth.get(key) {
                candidates.extend(collect_candidates_from_list(value, source));
            }
        }
    }

    candidates
}

/// Removes duplicate candidates by accountId, keeping the first occurrence.
fn unique_candidates(candidates: Vec<AccountIdCandidate>) -> Vec<AccountIdCandidate> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for candidate in candidates {
        if seen.contains(&candidate.account_id) {
            continue;
        }
        seen.insert(candidate.account_id.clone());
        result.push(candidate);
    }
    result
}

/// Select the best workspace candidate for OAuth account binding.
/// Preference order:
/// 1) org default that is not personal
/// 2) org default (any)
/// 3) id_token candidate
/// 4) non-personal org candidate
/// 5) token candidate
/// 6) first candidate
pub fn select_best_account_candidate(
    candidates: &[AccountIdCandidate],
) -> Option<&AccountIdCandidate> {
    if candidates.is_empty() {
        return None;
    }

    if let Some(candidate) = candidates.iter().find(|c| {
        matches!(c.source, AccountIdSource::Org)
            && c.is_default == Some(true)
            && c.is_personal != Some(true)
    }) {
        return Some(candidate);
    }

    if let Some(candidate) = candidates
        .iter()
        .find(|c| matches!(c.source, AccountIdSource::Org) && c.is_default == Some(true))
    {
        return Some(candidate);
    }

    if let Some(candidate) = candidates
        .iter()
        .find(|c| matches!(c.source, AccountIdSource::IdToken))
    {
        return Some(candidate);
    }

    if let Some(candidate) = candidates
        .iter()
        .find(|c| matches!(c.source, AccountIdSource::Org) && c.is_personal != Some(true))
    {
        return Some(candidate);
    }

    if let Some(candidate) = candidates
        .iter()
        .find(|c| matches!(c.source, AccountIdSource::Token))
    {
        return Some(candidate);
    }

    candidates.first()
}

/// Extracts the ChatGPT account ID from a JWT access token.
///
/// Returns the RAW (untrimmed) claim value when it is a string with a
/// non-blank trim; `None` otherwise. Empty/absent tokens yield `None`.
pub fn extract_account_id(access_token: Option<&str>) -> Option<String> {
    let token = access_token.filter(|t| !t.is_empty())?;
    let decoded = decode_jwt_value(token)?;
    let account_id = decoded.get(JWT_CLAIM_PATH)?.get("chatgpt_account_id")?;
    match account_id.as_str() {
        Some(s) if !s.trim().is_empty() => Some(s.to_string()),
        _ => None,
    }
}

/// Extracts the email address from OAuth tokens.
/// Checks id_token first (where OpenAI puts email), then falls back to the
/// access token's nested claim `email` / `chatgpt_user_email`, then the
/// top-level `email` / `preferred_username`. Returns the raw (untrimmed,
/// unlowercased) value; it must be a string containing `@` with a non-blank
/// trim.
pub fn extract_account_email(access_token: Option<&str>, id_token: Option<&str>) -> Option<String> {
    // Try id_token first — OpenAI puts email here.
    if let Some(idt) = id_token.filter(|t| !t.is_empty())
        && let Some(id_decoded) = decode_jwt_value(idt)
        && let Some(id_email) = id_decoded.get("email").and_then(|v| v.as_str())
        && id_email.contains('@')
        && !id_email.trim().is_empty()
    {
        return Some(id_email.to_string());
    }

    // Fall back to access_token.
    let token = access_token.filter(|t| !t.is_empty())?;
    let decoded = decode_jwt_value(token)?;
    let nested = decoded.get(JWT_CLAIM_PATH).and_then(|v| v.as_object());
    // TS `a ?? b ?? c ?? d` over raw values: a present non-null non-string
    // value stops the chain and then fails the string check.
    let candidate = [
        nested.and_then(|n| n.get("email")),
        nested.and_then(|n| n.get("chatgpt_user_email")),
        decoded.get("email"),
        decoded.get("preferred_username"),
    ]
    .into_iter()
    .flatten()
    .find(|value| !value.is_null())?;

    let email = candidate.as_str()?;
    if email.contains('@') && !email.trim().is_empty() {
        Some(email.to_string())
    } else {
        None
    }
}

/// Extracts all accountId candidates from access/id tokens.
/// Used to support business workspaces/organizations that are not the token
/// default. Order: token -> access-token orgs -> id_token -> id-token orgs,
/// deduplicated by accountId (first occurrence wins).
pub fn get_account_id_candidates(
    access_token: Option<&str>,
    id_token: Option<&str>,
) -> Vec<AccountIdCandidate> {
    let mut candidates = Vec::new();
    let access_id = extract_account_id(access_token);
    if let Some(id) = &access_id {
        candidates.push(AccountIdCandidate {
            account_id: id.clone(),
            label: format_token_candidate_label("Token account", id),
            source: AccountIdSource::Token,
            is_default: Some(true),
            is_personal: None,
        });
    }

    if let Some(token) = access_token.filter(|t| !t.is_empty()) {
        let access_decoded = decode_jwt_value(token);
        candidates.extend(collect_candidates_from_payload(
            access_decoded.as_ref(),
            AccountIdSource::Org,
        ));
    }

    if let Some(idt) = id_token.filter(|t| !t.is_empty()) {
        let decoded = decode_jwt_value(idt);
        let id_account_id = extract_account_id_from_payload(decoded.as_ref());
        if let Some(id) = id_account_id
            && Some(&id) != access_id.as_ref()
        {
            candidates.push(AccountIdCandidate {
                account_id: id.clone(),
                label: format_token_candidate_label("ID token account", &id),
                source: AccountIdSource::IdToken,
                is_default: None,
                is_personal: None,
            });
        }
        candidates.extend(collect_candidates_from_payload(
            decoded.as_ref(),
            AccountIdSource::Org,
        ));
    }

    unique_candidates(candidates)
}

/// Determines if the accountId should be updated from a token-derived value.
/// Org/manual selections stay stable across refreshes.
pub fn should_update_account_id_from_token(
    source: Option<&AccountIdSource>,
    current_account_id: Option<&str>,
) -> bool {
    if current_account_id.is_none_or(str::is_empty) {
        return true;
    }
    match source {
        None => true,
        Some(AccountIdSource::Token) | Some(AccountIdSource::IdToken) => true,
        Some(_) => false,
    }
}

/// Resolve which accountId to use for runtime API calls.
/// Preserves explicit org/manual selections; only token/id_token sources
/// auto-follow token changes.
pub fn resolve_request_account_id(
    stored_account_id: Option<&str>,
    source: Option<&AccountIdSource>,
    token_account_id: Option<&str>,
) -> Option<String> {
    let stored = stored_account_id.filter(|s| !s.is_empty());
    let Some(stored) = stored else {
        return token_account_id.map(|s| s.to_string());
    };
    if !should_update_account_id_from_token(source, Some(stored)) {
        return Some(stored.to_string());
    }
    token_account_id.or(Some(stored)).map(|s| s.to_string())
}

/// Live request identity resolved from the stored workspace binding plus the
/// freshest token-derived hints available for this request.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RuntimeRequestIdentity {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub token_account_id: Option<String>,
}

/// Input to [`resolve_runtime_request_identity`].
#[derive(Debug, Clone, Default)]
pub struct ResolveRuntimeRequestIdentityInput<'a> {
    pub stored_account_id: Option<&'a str>,
    pub source: Option<AccountIdSource>,
    pub stored_email: Option<&'a str>,
    pub access_token: Option<&'a str>,
    pub id_token: Option<&'a str>,
}

/// Resolve the live request identity for an account using the stored workspace
/// binding plus the freshest token-derived hints available for this request.
/// A fresh token email wins over the stored one; both pass [`sanitize_email`].
pub fn resolve_runtime_request_identity(
    input: ResolveRuntimeRequestIdentityInput<'_>,
) -> RuntimeRequestIdentity {
    let token_account_id = extract_account_id(input.access_token);
    let account_id = resolve_request_account_id(
        input.stored_account_id,
        input.source.as_ref(),
        token_account_id.as_deref(),
    );
    let email = sanitize_email(
        extract_account_email(input.access_token, input.id_token).as_deref(),
    )
    .or_else(|| sanitize_email(input.stored_email));
    RuntimeRequestIdentity {
        account_id,
        email,
        token_account_id,
    }
}

/// Sanitizes an email address by trimming whitespace and lowercasing.
/// Returns `None` for empty/blank input or a value without `@`.
pub fn sanitize_email(email: Option<&str>) -> Option<String> {
    let email = email.filter(|e| !e.is_empty())?;
    let trimmed = email.trim();
    if trimmed.is_empty() || !trimmed.contains('@') {
        return None;
    }
    Some(trimmed.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::{Value, json};

    /// Build a real (unsigned) JWT carrying `payload`, since Rust has no
    /// module mocking: the TS suite mocks `decodeJWT`, here we feed the real
    /// decoder equivalent tokens.
    fn make_jwt(payload: &Value) -> String {
        let b64 = |s: &str| URL_SAFE_NO_PAD.encode(s.as_bytes());
        format!("{}.{}.sig", b64("{\"alg\":\"none\"}"), b64(&payload.to_string()))
    }

    fn claim_payload(account_id: &str) -> Value {
        json!({ JWT_CLAIM_PATH: { "chatgpt_account_id": account_id } })
    }

    // === extractAccountId ===

    #[test]
    fn extract_account_id_returns_none_for_absent_or_empty_token() {
        assert_eq!(extract_account_id(None), None);
        assert_eq!(extract_account_id(Some("")), None);
    }

    #[test]
    fn extract_account_id_extracts_from_jwt_claim_path() {
        let token = make_jwt(&claim_payload("acc_123456"));
        assert_eq!(extract_account_id(Some(&token)), Some("acc_123456".into()));
    }

    #[test]
    fn extract_account_id_returns_none_when_decode_fails() {
        assert_eq!(extract_account_id(Some("invalid.token")), None);
    }

    #[test]
    fn extract_account_id_returns_none_for_blank_or_non_string_id() {
        let blank = make_jwt(&claim_payload("   "));
        assert_eq!(extract_account_id(Some(&blank)), None);
        let numeric = make_jwt(&json!({ JWT_CLAIM_PATH: { "chatgpt_account_id": 12345 } }));
        assert_eq!(extract_account_id(Some(&numeric)), None);
    }

    #[test]
    fn extract_account_id_returns_raw_untrimmed_value() {
        // Pinned in the TS suite: the raw claim comes back untrimmed.
        let token = make_jwt(&claim_payload("  acc_123  "));
        assert_eq!(extract_account_id(Some(&token)), Some("  acc_123  ".into()));
    }

    // === extractAccountEmail ===

    #[test]
    fn extract_account_email_prefers_id_token() {
        let id_token = make_jwt(&json!({ "email": "id@example.com" }));
        let access = make_jwt(&json!({ "email": "access@example.com" }));
        assert_eq!(
            extract_account_email(Some(&access), Some(&id_token)),
            Some("id@example.com".into())
        );
    }

    #[test]
    fn extract_account_email_falls_back_to_access_token() {
        let id_token = make_jwt(&json!({ "no_email": true }));
        let access = make_jwt(&json!({ "email": "access@example.com" }));
        assert_eq!(
            extract_account_email(Some(&access), Some(&id_token)),
            Some("access@example.com".into())
        );
    }

    #[test]
    fn extract_account_email_reads_nested_claim_and_chatgpt_user_email() {
        let nested = make_jwt(&json!({ JWT_CLAIM_PATH: { "email": "nested@example.com" } }));
        assert_eq!(
            extract_account_email(Some(&nested), None),
            Some("nested@example.com".into())
        );
        let user_email =
            make_jwt(&json!({ JWT_CLAIM_PATH: { "chatgpt_user_email": "user@example.com" } }));
        assert_eq!(
            extract_account_email(Some(&user_email), None),
            Some("user@example.com".into())
        );
    }

    #[test]
    fn extract_account_email_reads_preferred_username() {
        let token = make_jwt(&json!({ "preferred_username": "pref@example.com" }));
        assert_eq!(
            extract_account_email(Some(&token), None),
            Some("pref@example.com".into())
        );
    }

    #[test]
    fn extract_account_email_rejects_invalid_values() {
        let no_at = make_jwt(&json!({ "email": "not-an-email" }));
        assert_eq!(extract_account_email(Some(&no_at), None), None);
        let empty = make_jwt(&json!({ "email": "" }));
        assert_eq!(extract_account_email(Some(&empty), None), None);
        assert_eq!(extract_account_email(None, None), None);
    }

    // === getAccountIdCandidates ===

    #[test]
    fn candidates_empty_for_no_tokens() {
        assert!(get_account_id_candidates(None, None).is_empty());
    }

    #[test]
    fn candidates_extract_root_level_ids_from_id_token() {
        for (key, id) in [
            ("chatgpt_account_id", "root_id_123"),
            ("account_id", "alt_id_456"),
            ("accountId", "camel_id_789"),
        ] {
            let id_token = make_jwt(&json!({ key: id }));
            let candidates = get_account_id_candidates(None, Some(&id_token));
            assert!(candidates.iter().any(|c| c.account_id == id), "key {key}");
            assert!(
                candidates
                    .iter()
                    .any(|c| matches!(c.source, AccountIdSource::IdToken)),
                "key {key}"
            );
        }
    }

    #[test]
    fn candidates_normalize_nested_wrappers_to_arrays() {
        for wrapper in ["data", "items", "accounts", "organizations", "workspaces", "teams"] {
            let access = make_jwt(&json!({
                "organizations": { wrapper: [{ "account_id": "nested_org", "name": "Org" }] },
            }));
            let candidates = get_account_id_candidates(Some(&access), None);
            assert!(
                candidates.iter().any(|c| c.account_id == "nested_org"),
                "wrapper {wrapper}"
            );
        }
    }

    #[test]
    fn candidates_extract_org_lists_from_nested_claim_path() {
        for key in ["organizations", "orgs", "accounts", "workspaces", "teams"] {
            let access = make_jwt(&json!({
                JWT_CLAIM_PATH: { key: [{ "account_id": format!("{key}_id"), "name": "N" }] },
            }));
            let candidates = get_account_id_candidates(Some(&access), None);
            assert!(
                candidates
                    .iter()
                    .any(|c| c.account_id == format!("{key}_id")
                        && matches!(c.source, AccountIdSource::Org)),
                "claim key {key}"
            );
        }
    }

    #[test]
    fn candidates_include_default_token_candidate_from_access_token() {
        let access = make_jwt(&claim_payload("acc_tok_123"));
        let candidates = get_account_id_candidates(Some(&access), None);
        assert_eq!(candidates.len(), 1);
        let c = &candidates[0];
        assert_eq!(c.account_id, "acc_tok_123");
        assert_eq!(c.label, "Token account [id:ok_123]");
        assert!(matches!(c.source, AccountIdSource::Token));
        assert_eq!(c.is_default, Some(true));
        assert_eq!(c.is_personal, None);
    }

    #[test]
    fn candidates_deduplicate_by_account_id_first_wins() {
        let mut payload = claim_payload("acc_same");
        payload["organizations"] = json!([{ "account_id": "acc_same", "name": "Dup Org" }]);
        let access = make_jwt(&payload);
        let candidates = get_account_id_candidates(Some(&access), None);
        assert_eq!(candidates.len(), 1);
        // First occurrence (the token candidate) wins.
        assert!(matches!(candidates[0].source, AccountIdSource::Token));
    }

    #[test]
    fn candidates_skip_duplicate_id_token_account() {
        let access = make_jwt(&claim_payload("acc_same"));
        let id_token = make_jwt(&json!({ "account_id": "acc_same" }));
        let candidates = get_account_id_candidates(Some(&access), Some(&id_token));
        assert_eq!(candidates.len(), 1);
        assert!(matches!(candidates[0].source, AccountIdSource::Token));
    }

    #[test]
    fn candidates_format_labels_with_type_role_and_personal() {
        let access = make_jwt(&json!({
            "organizations": [{
                "organization_id": "org_abcdef123456",
                "name": "Acme",
                "type": "team",
                "role": "admin",
                "is_personal": true,
            }],
        }));
        let candidates = get_account_id_candidates(Some(&access), None);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].label, "Acme (team, role:admin, personal) [id:123456]");
        assert_eq!(candidates[0].is_personal, Some(true));
    }

    #[test]
    fn candidates_use_type_as_label_base_when_name_absent() {
        let access = make_jwt(&json!({
            "organizations": [{ "id": "org_1", "type": "business" }],
        }));
        let candidates = get_account_id_candidates(Some(&access), None);
        // type becomes the base AND still appears in the meta parts (name is
        // absent so the case-insensitive same-name suppression does not fire).
        assert_eq!(candidates[0].label, "business (business) [id:org_1]");
    }

    #[test]
    fn candidates_parse_boolean_ish_strings_for_is_default() {
        let make = |v: Value| {
            make_jwt(&json!({
                "organizations": [{ "account_id": "org_1", "is_default": v }],
            }))
        };
        let c = get_account_id_candidates(Some(&make(json!("true"))), None);
        assert_eq!(c[0].is_default, Some(true));
        let c = get_account_id_candidates(Some(&make(json!("false"))), None);
        assert_eq!(c[0].is_default, Some(false));
        let c = get_account_id_candidates(Some(&make(json!("maybe"))), None);
        assert_eq!(c[0].is_default, None);
        let c = get_account_id_candidates(Some(&make(json!(1))), None);
        assert_eq!(c[0].is_default, None);
    }

    #[test]
    fn candidates_skip_invalid_records() {
        let access = make_jwt(&json!({
            "organizations": [
                "not-a-record",
                { "name": "No id here" },
                { "account_id": "org_ok" },
            ],
        }));
        let candidates = get_account_id_candidates(Some(&access), None);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].account_id, "org_ok");
    }

    #[test]
    fn candidates_keep_short_account_ids_whole_in_labels() {
        let access = make_jwt(&json!({ "organizations": [{ "account_id": "abc" }] }));
        let candidates = get_account_id_candidates(Some(&access), None);
        assert_eq!(candidates[0].label, "Workspace [id:abc]");
    }

    // === selectBestAccountCandidate ===

    fn cand(
        id: &str,
        source: AccountIdSource,
        is_default: Option<bool>,
        is_personal: Option<bool>,
    ) -> AccountIdCandidate {
        AccountIdCandidate {
            account_id: id.to_string(),
            label: format!("{id} label"),
            source,
            is_default,
            is_personal,
        }
    }

    #[test]
    fn select_best_prefers_non_personal_org_default_over_token() {
        let candidates = vec![
            cand("tok", AccountIdSource::Token, Some(true), None),
            cand("personal_default", AccountIdSource::Org, Some(true), Some(true)),
            cand("org_default", AccountIdSource::Org, Some(true), Some(false)),
        ];
        let best = select_best_account_candidate(&candidates).unwrap();
        assert_eq!(best.account_id, "org_default");
    }

    #[test]
    fn select_best_falls_back_to_any_org_default() {
        let candidates = vec![
            cand("tok", AccountIdSource::Token, Some(true), None),
            cand("personal_default", AccountIdSource::Org, Some(true), Some(true)),
        ];
        let best = select_best_account_candidate(&candidates).unwrap();
        assert_eq!(best.account_id, "personal_default");
    }

    #[test]
    fn select_best_prefers_id_token_when_no_org_default() {
        let candidates = vec![
            cand("tok", AccountIdSource::Token, Some(true), None),
            cand("idt", AccountIdSource::IdToken, None, None),
            cand("org_np", AccountIdSource::Org, None, Some(false)),
        ];
        let best = select_best_account_candidate(&candidates).unwrap();
        assert_eq!(best.account_id, "idt");
    }

    #[test]
    fn select_best_prefers_non_personal_org_then_token_then_first() {
        let candidates = vec![
            cand("tok", AccountIdSource::Token, Some(true), None),
            cand("org_np", AccountIdSource::Org, None, Some(false)),
        ];
        assert_eq!(
            select_best_account_candidate(&candidates).unwrap().account_id,
            "org_np"
        );

        let candidates = vec![
            cand("manual", AccountIdSource::Manual, None, None),
            cand("tok", AccountIdSource::Token, Some(true), None),
        ];
        assert_eq!(
            select_best_account_candidate(&candidates).unwrap().account_id,
            "tok"
        );

        let candidates = vec![cand("manual", AccountIdSource::Manual, None, None)];
        assert_eq!(
            select_best_account_candidate(&candidates).unwrap().account_id,
            "manual"
        );

        assert!(select_best_account_candidate(&[]).is_none());
    }

    // === shouldUpdateAccountIdFromToken ===

    #[test]
    fn should_update_rules() {
        assert!(should_update_account_id_from_token(None, None));
        assert!(should_update_account_id_from_token(None, Some("")));
        assert!(should_update_account_id_from_token(None, Some("acc_1")));
        assert!(should_update_account_id_from_token(
            Some(&AccountIdSource::Token),
            Some("acc_1")
        ));
        assert!(should_update_account_id_from_token(
            Some(&AccountIdSource::IdToken),
            Some("acc_1")
        ));
        assert!(!should_update_account_id_from_token(
            Some(&AccountIdSource::Org),
            Some("acc_1")
        ));
        assert!(!should_update_account_id_from_token(
            Some(&AccountIdSource::Manual),
            Some("acc_1")
        ));
    }

    // === resolveRequestAccountId ===

    #[test]
    fn resolve_request_account_id_preserves_org_manual_selection() {
        assert_eq!(
            resolve_request_account_id(
                Some("stored_org"),
                Some(&AccountIdSource::Org),
                Some("token_acc")
            ),
            Some("stored_org".into())
        );
        assert_eq!(
            resolve_request_account_id(
                Some("stored_manual"),
                Some(&AccountIdSource::Manual),
                Some("token_acc")
            ),
            Some("stored_manual".into())
        );
    }

    #[test]
    fn resolve_request_account_id_follows_token_sources() {
        assert_eq!(
            resolve_request_account_id(
                Some("stored"),
                Some(&AccountIdSource::Token),
                Some("token_acc")
            ),
            Some("token_acc".into())
        );
        assert_eq!(
            resolve_request_account_id(
                Some("stored"),
                Some(&AccountIdSource::IdToken),
                Some("token_acc")
            ),
            Some("token_acc".into())
        );
    }

    #[test]
    fn resolve_request_account_id_fallbacks() {
        // No stored -> token wins (even when None).
        assert_eq!(
            resolve_request_account_id(None, None, Some("token_acc")),
            Some("token_acc".into())
        );
        assert_eq!(resolve_request_account_id(None, None, None), None);
        // Updatable source but no token id -> keep stored.
        assert_eq!(
            resolve_request_account_id(Some("stored"), Some(&AccountIdSource::Token), None),
            Some("stored".into())
        );
        // Empty stored string counts as absent (TS falsy).
        assert_eq!(
            resolve_request_account_id(Some(""), Some(&AccountIdSource::Org), Some("token_acc")),
            Some("token_acc".into())
        );
    }

    // === resolveRuntimeRequestIdentity ===

    #[test]
    fn runtime_identity_preserves_org_routing_and_hydrates_email() {
        let access = make_jwt(&json!({
            JWT_CLAIM_PATH: {
                "chatgpt_account_id": "acc_token",
                "email": "Fresh@Example.COM ",
            },
        }));
        let identity = resolve_runtime_request_identity(ResolveRuntimeRequestIdentityInput {
            stored_account_id: Some("acc_org"),
            source: Some(AccountIdSource::Org),
            stored_email: Some("stored@example.com"),
            access_token: Some(&access),
            id_token: None,
        });
        assert_eq!(identity.account_id, Some("acc_org".into()));
        assert_eq!(identity.token_account_id, Some("acc_token".into()));
        // Fresh token email wins over stored, sanitized (trim + lowercase).
        assert_eq!(identity.email, Some("fresh@example.com".into()));
    }

    #[test]
    fn runtime_identity_follows_token_derived_binding() {
        let access = make_jwt(&claim_payload("acc_token"));
        let identity = resolve_runtime_request_identity(ResolveRuntimeRequestIdentityInput {
            stored_account_id: Some("acc_old"),
            source: Some(AccountIdSource::Token),
            stored_email: None,
            access_token: Some(&access),
            id_token: None,
        });
        assert_eq!(identity.account_id, Some("acc_token".into()));
    }

    #[test]
    fn runtime_identity_falls_back_to_stored_email() {
        let access = make_jwt(&claim_payload("acc_token"));
        let identity = resolve_runtime_request_identity(ResolveRuntimeRequestIdentityInput {
            stored_account_id: None,
            source: None,
            stored_email: Some("  Stored@Example.com "),
            access_token: Some(&access),
            id_token: None,
        });
        assert_eq!(identity.account_id, Some("acc_token".into()));
        assert_eq!(identity.email, Some("stored@example.com".into()));
    }

    // === sanitizeEmail ===

    #[test]
    fn sanitize_email_rules() {
        assert_eq!(sanitize_email(None), None);
        assert_eq!(sanitize_email(Some("")), None);
        assert_eq!(sanitize_email(Some("   ")), None);
        assert_eq!(sanitize_email(Some("no-at-sign")), None);
        assert_eq!(
            sanitize_email(Some("User@Example.COM")),
            Some("user@example.com".into())
        );
        assert_eq!(
            sanitize_email(Some("  a@b.co  ")),
            Some("a@b.co".into())
        );
        assert_eq!(
            sanitize_email(Some(" MiXeD@CaSe.Io ")),
            Some("mixed@case.io".into())
        );
    }
}
