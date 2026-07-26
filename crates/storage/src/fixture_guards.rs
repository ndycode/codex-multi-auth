//! Port of `lib/storage/fixture-guards.ts` — synthetic test-fixture detection
//! guarding against fixture data clobbering real accounts (spec 02 §8.4,
//! gotcha 13).
//!
//! The TS regexes are hand-rolled here (the storage crate has no `regex`
//! dependency); each helper documents the exact pattern it reproduces.

use crate::public_types::{AccountMetadataV3, AccountStorageV3};

/// `^account\d+@example\.com$` on the trimmed, lowercased email.
fn is_synthetic_email(email: &str) -> bool {
    let Some(rest) = email.strip_prefix("account") else {
        return false;
    };
    let Some(digits) = rest.strip_suffix("@example.com") else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// `^fake_refresh_token_\d+(_for_testing_only)?$`.
fn matches_fake_refresh_token_pattern(token: &str) -> bool {
    let Some(rest) = token.strip_prefix("fake_refresh_token_") else {
        return false;
    };
    let digits = rest.strip_suffix("_for_testing_only").unwrap_or(rest);
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// `^acc(_|-)?\d+$`.
fn is_synthetic_account_id(account_id: &str) -> bool {
    let Some(rest) = account_id.strip_prefix("acc") else {
        return false;
    };
    let digits = rest
        .strip_prefix('_')
        .or_else(|| rest.strip_prefix('-'))
        .unwrap_or(rest);
    !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
}

/// `looksLikeSyntheticFixtureAccount(account)`:
/// - email (trimmed/lowercased) matches `^account\d+@example\.com$`, AND
/// - refreshToken (trimmed/lowercased) starts with `fake_refresh` or matches
///   `^fake_refresh_token_\d+(_for_testing_only)?$`, AND
/// - accountId is empty or matches `^acc(_|-)?\d+$`.
pub fn looks_like_synthetic_fixture_account(account: &AccountMetadataV3) -> bool {
    let email = account
        .email
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let refresh_token = account.refresh_token.trim().to_lowercase();
    let account_id = account
        .account_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if !is_synthetic_email(&email) {
        return false;
    }
    let has_synthetic_refresh_token = refresh_token.starts_with("fake_refresh")
        || matches_fake_refresh_token_pattern(&refresh_token);
    if !has_synthetic_refresh_token {
        return false;
    }
    if account_id.is_empty() {
        return true;
    }
    is_synthetic_account_id(&account_id)
}

/// `looksLikeSyntheticFixtureStorage(storage)`: non-null, at least one
/// account, EVERY account synthetic.
pub fn looks_like_synthetic_fixture_storage(storage: Option<&AccountStorageV3>) -> bool {
    let Some(storage) = storage else {
        return false;
    };
    if storage.accounts.is_empty() {
        return false;
    }
    storage
        .accounts
        .iter()
        .all(looks_like_synthetic_fixture_account)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(email: &str, refresh_token: &str, account_id: Option<&str>) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh_token, 1, 2);
        account.email = Some(email.to_string());
        account.account_id = account_id.map(str::to_string);
        account
    }

    #[test]
    fn detects_canonical_fixture_accounts() {
        assert!(looks_like_synthetic_fixture_account(&account(
            "account1@example.com",
            "fake_refresh_token_1",
            None
        )));
        assert!(looks_like_synthetic_fixture_account(&account(
            "account42@example.com",
            "fake_refresh_token_42_for_testing_only",
            Some("acc_42")
        )));
        assert!(looks_like_synthetic_fixture_account(&account(
            "ACCOUNT2@EXAMPLE.COM ",
            " FAKE_REFRESH_anything",
            Some("acc-7")
        )));
        assert!(looks_like_synthetic_fixture_account(&account(
            "account3@example.com",
            "fake_refresh",
            Some("acc3")
        )));
    }

    #[test]
    fn rejects_real_looking_accounts() {
        // Real email domain.
        assert!(!looks_like_synthetic_fixture_account(&account(
            "user@gmail.com",
            "fake_refresh_token_1",
            None
        )));
        // Real refresh token.
        assert!(!looks_like_synthetic_fixture_account(&account(
            "account1@example.com",
            "rt_real_token",
            None
        )));
        // Real accountId shape.
        assert!(!looks_like_synthetic_fixture_account(&account(
            "account1@example.com",
            "fake_refresh_token_1",
            Some("acct-user-one")
        )));
        // Email without digits.
        assert!(!looks_like_synthetic_fixture_account(&account(
            "account@example.com",
            "fake_refresh_token_1",
            None
        )));
    }

    #[test]
    fn storage_is_synthetic_only_when_every_account_is() {
        assert!(!looks_like_synthetic_fixture_storage(None));
        let mut storage = AccountStorageV3::empty();
        assert!(!looks_like_synthetic_fixture_storage(Some(&storage)));
        storage
            .accounts
            .push(account("account1@example.com", "fake_refresh_token_1", None));
        assert!(looks_like_synthetic_fixture_storage(Some(&storage)));
        storage
            .accounts
            .push(account("real.user@gmail.com", "rt_real", Some("acct-x")));
        assert!(!looks_like_synthetic_fixture_storage(Some(&storage)));
    }
}
