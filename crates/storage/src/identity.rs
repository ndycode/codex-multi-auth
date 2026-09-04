//! Port of `lib/storage/identity.ts` (spec 02 §6.1).
//!
//! Identity normalization and identity keys for account matching:
//! - [`normalize_email_key`]: trim + lowercase, empty ⇒ `None`.
//! - [`to_account_identity_ref`] / [`AccountIdentityRef::from_parts`]: build a
//!   normalized identity reference (`accountId` trimmed, `emailKey`
//!   trimmed+lowercased, `refreshToken` trimmed; blanks ⇒ `None`).
//! - [`get_account_identity_key`]: `"account:<id>::email:<key>"` |
//!   `"account:<id>"` | `"email:<key>"` | `"refresh:<sha256hex(token)>"` |
//!   `None` — the refresh fallback hashes the token so key material never
//!   reaches logs.
//! - [`get_runtime_account_identity_key`]: same WITHOUT the refresh fallback;
//!   falls back to the numeric account index instead.

use sha2::{Digest, Sha256};

use cma_core::schemas::account_storage::{AccountMetadataV1, AccountMetadataV3};
use cma_core::schemas::flagged::FlaggedAccountMetadataV1;

/// Anything that can expose the three identity fields used by the matcher.
/// (TS `AccountLike = { accountId?, email?, refreshToken? }`.)
pub trait AccountIdentityLike {
    fn identity_account_id(&self) -> Option<&str>;
    fn identity_email(&self) -> Option<&str>;
    fn identity_refresh_token(&self) -> Option<&str>;
}

impl AccountIdentityLike for AccountMetadataV3 {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        Some(self.refresh_token.as_str())
    }
}

impl AccountIdentityLike for AccountMetadataV1 {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        Some(self.refresh_token.as_str())
    }
}

impl AccountIdentityLike for FlaggedAccountMetadataV1 {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        Some(self.refresh_token.as_str())
    }
}

impl<T: AccountIdentityLike> AccountIdentityLike for &T {
    fn identity_account_id(&self) -> Option<&str> {
        (*self).identity_account_id()
    }
    fn identity_email(&self) -> Option<&str> {
        (*self).identity_email()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        (*self).identity_refresh_token()
    }
}

/// Normalized identity reference (TS `AccountIdentityRef`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountIdentityRef {
    /// Trimmed accountId (blank ⇒ `None`).
    pub account_id: Option<String>,
    /// Trimmed + lowercased email (blank ⇒ `None`).
    pub email_key: Option<String>,
    /// Trimmed refresh token (blank ⇒ `None`).
    pub refresh_token: Option<String>,
}

impl AccountIdentityRef {
    /// Build a normalized ref from raw parts (candidate shape used by
    /// `normalizeAccountStorage` / `resolveAccountSelectionIndex` callers).
    pub fn from_parts(
        account_id: Option<&str>,
        email: Option<&str>,
        refresh_token: Option<&str>,
    ) -> Self {
        Self {
            account_id: normalize_account_id_key(account_id),
            email_key: normalize_email_key(email),
            refresh_token: normalize_refresh_token_key(refresh_token),
        }
    }
}

/// The ref itself is account-like (all fields already normalized;
/// re-normalizing is idempotent).
impl AccountIdentityLike for AccountIdentityRef {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email_key.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }
}

fn normalize_account_id_key(account_id: Option<&str>) -> Option<String> {
    let trimmed = account_id?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS `normalizeEmailKey`: trim then lowercase; empty ⇒ `None`.
pub fn normalize_email_key(email: Option<&str>) -> Option<String> {
    let trimmed = email?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_lowercase())
    }
}

fn normalize_refresh_token_key(refresh_token: Option<&str>) -> Option<String> {
    let trimmed = refresh_token?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn hash_refresh_token_key(refresh_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(refresh_token.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// TS `toAccountIdentityRef` — normalized identity ref for an account.
pub fn to_account_identity_ref(account: &impl AccountIdentityLike) -> AccountIdentityRef {
    AccountIdentityRef::from_parts(
        account.identity_account_id(),
        account.identity_email(),
        account.identity_refresh_token(),
    )
}

fn identity_key_from_ref(
    ref_: &AccountIdentityRef,
    allow_refresh_fallback: bool,
) -> Option<String> {
    match (&ref_.account_id, &ref_.email_key) {
        (Some(account_id), Some(email_key)) => {
            return Some(format!("account:{account_id}::email:{email_key}"));
        }
        (Some(account_id), None) => return Some(format!("account:{account_id}")),
        (None, Some(email_key)) => return Some(format!("email:{email_key}")),
        (None, None) => {}
    }
    if allow_refresh_fallback
        && let Some(refresh_token) = &ref_.refresh_token
    {
        // Legacy refresh-only identity keys embedded raw tokens. Hashing
        // preserves deterministic fallback matching without exposing token
        // material in logs.
        return Some(format!(
            "refresh:{}",
            hash_refresh_token_key(refresh_token)
        ));
    }
    None
}

/// TS `getAccountIdentityKey` — persistent identity key with refresh-token
/// hash fallback.
pub fn get_account_identity_key(account: &impl AccountIdentityLike) -> Option<String> {
    let ref_ = to_account_identity_ref(account);
    identity_key_from_ref(&ref_, true)
}

/// Runtime identity key: string key or numeric fallback index (TS returned
/// `string | number | undefined`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeAccountIdentityKey {
    Key(String),
    Index(i64),
}

impl std::fmt::Display for RuntimeAccountIdentityKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Key(key) => f.write_str(key),
            Self::Index(index) => write!(f, "{index}"),
        }
    }
}

/// TS `getRuntimeAccountIdentityKey` — like [`get_account_identity_key`] but
/// with NO refresh-token fallback; falls back to the numeric `index` when
/// neither accountId nor email is present.
pub fn get_runtime_account_identity_key(
    account_id: Option<&str>,
    email: Option<&str>,
    index: Option<i64>,
) -> Option<RuntimeAccountIdentityKey> {
    let ref_ = AccountIdentityRef::from_parts(account_id, email, None);
    if let Some(key) = identity_key_from_ref(&ref_, false) {
        return Some(RuntimeAccountIdentityKey::Key(key));
    }
    index.map(RuntimeAccountIdentityKey::Index)
}

// ============================================================================
// Tests (identity assertions from the storage matching suites)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_email_key_trims_and_lowercases() {
        assert_eq!(
            normalize_email_key(Some("  User@Example.COM  ")),
            Some("user@example.com".to_string())
        );
        assert_eq!(normalize_email_key(Some("   ")), None);
        assert_eq!(normalize_email_key(Some("")), None);
        assert_eq!(normalize_email_key(None), None);
    }

    #[test]
    fn to_account_identity_ref_normalizes_all_fields() {
        let ref_ = AccountIdentityRef::from_parts(
            Some("  acc_1  "),
            Some(" A@B.com "),
            Some("  rt_x  "),
        );
        assert_eq!(ref_.account_id.as_deref(), Some("acc_1"));
        assert_eq!(ref_.email_key.as_deref(), Some("a@b.com"));
        assert_eq!(ref_.refresh_token.as_deref(), Some("rt_x"));
        let blank = AccountIdentityRef::from_parts(Some(" "), Some(""), None);
        assert_eq!(blank, AccountIdentityRef::default());
    }

    #[test]
    fn identity_key_preference_order() {
        // composite
        let both = AccountIdentityRef::from_parts(Some("acc"), Some("A@B.com"), Some("rt"));
        assert_eq!(
            identity_key_from_ref(&both, true).as_deref(),
            Some("account:acc::email:a@b.com")
        );
        // account only
        let id_only = AccountIdentityRef::from_parts(Some("acc"), None, Some("rt"));
        assert_eq!(
            identity_key_from_ref(&id_only, true).as_deref(),
            Some("account:acc")
        );
        // email only
        let email_only = AccountIdentityRef::from_parts(None, Some("x@y.z"), Some("rt"));
        assert_eq!(
            identity_key_from_ref(&email_only, true).as_deref(),
            Some("email:x@y.z")
        );
        // refresh fallback is hashed, never the raw token
        let refresh_only = AccountIdentityRef::from_parts(None, None, Some("rt_secret"));
        let key = identity_key_from_ref(&refresh_only, true).expect("refresh key");
        assert!(key.starts_with("refresh:"));
        assert!(!key.contains("rt_secret"));
        assert_eq!(key.len(), "refresh:".len() + 64);
        // nothing
        let none = AccountIdentityRef::default();
        assert_eq!(identity_key_from_ref(&none, true), None);
    }

    #[test]
    fn runtime_identity_key_has_no_refresh_fallback() {
        assert_eq!(
            get_runtime_account_identity_key(Some("acc"), Some("a@b.c"), Some(4)),
            Some(RuntimeAccountIdentityKey::Key(
                "account:acc::email:a@b.c".to_string()
            ))
        );
        assert_eq!(
            get_runtime_account_identity_key(None, None, Some(2)),
            Some(RuntimeAccountIdentityKey::Index(2))
        );
        assert_eq!(get_runtime_account_identity_key(None, None, None), None);
    }

    #[test]
    fn account_metadata_impls_expose_identity_fields() {
        let mut account = AccountMetadataV3::new("rt", 1, 2);
        account.account_id = Some("acc_9".into());
        account.email = Some("Person@Example.com".into());
        let key = get_account_identity_key(&account).expect("key");
        assert_eq!(key, "account:acc_9::email:person@example.com");
    }
}
