//! Port of `lib/codex-manager/account-credentials.ts` — token freshness and
//! account-identity helpers shared by the manager CLI commands.

use cma_core::schemas::account_storage::{AccountIdSource, AccountMetadataV3};
use cma_core::token_utils::{resolve_request_account_id, should_update_account_id_from_token};

/// `ACCESS_TOKEN_FRESH_WINDOW_MS` (private in TS; 300 000 ms).
pub(crate) const ACCESS_TOKEN_FRESH_WINDOW_MS: i64 = 5 * 60 * 1000;

/// `hasUsableAccessToken(account, now)` over a full account row.
pub fn has_usable_access_token(account: &AccountMetadataV3, now: i64) -> bool {
    has_usable_access_token_parts(account.access_token.as_deref(), account.expires_at, now)
}

/// `hasUsableAccessToken({accessToken, expiresAt}, now)` — token present AND
/// `expiresAt` finite AND `expiresAt - now > 300_000` (a token expiring within
/// 5 minutes counts as unusable). Pick-shaped variant for flagged rows.
pub fn has_usable_access_token_parts(
    access_token: Option<&str>,
    expires_at: Option<i64>,
    now: i64,
) -> bool {
    let Some(token) = access_token else {
        return false;
    };
    if token.is_empty() {
        return false;
    }
    let Some(expires_at) = expires_at else {
        return false;
    };
    expires_at - now > ACCESS_TOKEN_FRESH_WINDOW_MS
}

/// `hasLikelyInvalidRefreshToken(refreshToken)` — missing → true; trimmed
/// length < 20 → true; `"token-"` prefix (test/demo placeholder) → true.
pub fn has_likely_invalid_refresh_token(refresh_token: Option<&str>) -> bool {
    let Some(refresh_token) = refresh_token else {
        return true;
    };
    if refresh_token.is_empty() {
        return true;
    }
    let trimmed = refresh_token.trim();
    if trimmed.len() < 20 {
        return true;
    }
    trimmed.starts_with("token-")
}

/// `resolveStoredAccountIdentity(storedId, storedSource, tokenId)`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResolvedAccountIdentity {
    pub account_id: Option<String>,
    pub account_id_source: Option<AccountIdSource>,
}

pub fn resolve_stored_account_identity(
    stored_account_id: Option<&str>,
    stored_account_id_source: Option<AccountIdSource>,
    token_account_id: Option<&str>,
) -> ResolvedAccountIdentity {
    let account_id = resolve_request_account_id(
        stored_account_id,
        stored_account_id_source.as_ref(),
        token_account_id,
    );
    let Some(account_id) = account_id else {
        return ResolvedAccountIdentity::default();
    };

    if !should_update_account_id_from_token(stored_account_id_source.as_ref(), stored_account_id) {
        return ResolvedAccountIdentity {
            account_id: Some(account_id),
            account_id_source: stored_account_id_source,
        };
    }

    let source = if Some(account_id.as_str()) == token_account_id {
        Some(AccountIdSource::Token)
    } else {
        stored_account_id_source
    };
    ResolvedAccountIdentity {
        account_id: Some(account_id),
        account_id_source: source,
    }
}

/// `applyTokenAccountIdentity(account, tokenId)` — mutates the account's
/// id/source pair only when the resolution differs; never clears an id.
/// Returns whether it changed.
pub fn apply_token_account_identity(
    account: &mut AccountMetadataV3,
    token_account_id: Option<&str>,
) -> bool {
    let mut account_id = account.account_id.clone();
    let mut account_id_source = account.account_id_source;
    let changed = apply_token_account_identity_parts(
        &mut account_id,
        &mut account_id_source,
        token_account_id,
    );
    if changed {
        account.account_id = account_id;
        account.account_id_source = account_id_source;
    }
    changed
}

/// Pick-shaped variant of [`apply_token_account_identity`] for rows that are
/// not `AccountMetadataV3` (flagged entries).
pub fn apply_token_account_identity_parts(
    account_id: &mut Option<String>,
    account_id_source: &mut Option<AccountIdSource>,
    token_account_id: Option<&str>,
) -> bool {
    let next = resolve_stored_account_identity(
        account_id.as_deref(),
        *account_id_source,
        token_account_id,
    );
    let Some(next_id) = next.account_id else {
        return false;
    };
    if Some(next_id.as_str()) == account_id.as_deref()
        && next.account_id_source == *account_id_source
    {
        return false;
    }
    *account_id = Some(next_id);
    *account_id_source = next.account_id_source;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usable_access_token_needs_a_five_minute_margin() {
        let now = 1_000_000;
        assert!(!has_usable_access_token_parts(None, Some(now + 600_000), now));
        assert!(!has_usable_access_token_parts(Some("tok"), None, now));
        // Exactly at the window is NOT usable (`>` not `>=`).
        assert!(!has_usable_access_token_parts(
            Some("tok"),
            Some(now + ACCESS_TOKEN_FRESH_WINDOW_MS),
            now
        ));
        assert!(has_usable_access_token_parts(
            Some("tok"),
            Some(now + ACCESS_TOKEN_FRESH_WINDOW_MS + 1),
            now
        ));
        // Struct-shaped wrapper agrees.
        let mut account = AccountMetadataV3::new("rt-0123456789abcdefghij", 0, 0);
        account.access_token = Some("tok".to_string());
        account.expires_at = Some(now + 600_000);
        assert!(has_usable_access_token(&account, now));
    }

    #[test]
    fn likely_invalid_refresh_token_shapes() {
        assert!(has_likely_invalid_refresh_token(None));
        assert!(has_likely_invalid_refresh_token(Some("")));
        assert!(has_likely_invalid_refresh_token(Some("short-token")));
        assert!(has_likely_invalid_refresh_token(Some(
            "token-0123456789abcdefghijklmnop"
        )));
        assert!(!has_likely_invalid_refresh_token(Some(
            "rt-0123456789abcdefghijklmnop"
        )));
        // Whitespace is trimmed before the length check.
        assert!(has_likely_invalid_refresh_token(Some(
            "   short   "
        )));
    }

    #[test]
    fn resolve_stored_identity_prefers_token_source_when_ids_match() {
        let resolved = resolve_stored_account_identity(None, None, Some("acc_token"));
        assert_eq!(resolved.account_id.as_deref(), Some("acc_token"));
        assert_eq!(resolved.account_id_source, Some(AccountIdSource::Token));
    }

    #[test]
    fn resolve_stored_identity_keeps_manual_source() {
        // Manual overrides are sticky: shouldUpdateAccountIdFromToken is
        // false for manual sources, so the stored pair is kept.
        let resolved = resolve_stored_account_identity(
            Some("acc_manual"),
            Some(AccountIdSource::Manual),
            Some("acc_token"),
        );
        assert_eq!(resolved.account_id.as_deref(), Some("acc_manual"));
        assert_eq!(resolved.account_id_source, Some(AccountIdSource::Manual));
    }

    #[test]
    fn apply_token_identity_is_a_noop_when_nothing_resolves_or_changes() {
        let mut id: Option<String> = None;
        let mut source: Option<AccountIdSource> = None;
        assert!(!apply_token_account_identity_parts(&mut id, &mut source, None));
        assert_eq!(id, None);

        assert!(apply_token_account_identity_parts(
            &mut id,
            &mut source,
            Some("acc_1")
        ));
        assert_eq!(id.as_deref(), Some("acc_1"));
        assert_eq!(source, Some(AccountIdSource::Token));
        // Second application with the same token: unchanged.
        assert!(!apply_token_account_identity_parts(
            &mut id,
            &mut source,
            Some("acc_1")
        ));

        // Struct-shaped wrapper mutates the row.
        let mut account = AccountMetadataV3::new("rt-0123456789abcdefghij", 0, 0);
        assert!(apply_token_account_identity(&mut account, Some("acc_9")));
        assert_eq!(account.account_id.as_deref(), Some("acc_9"));
        assert_eq!(account.account_id_source, Some(AccountIdSource::Token));
    }
}
