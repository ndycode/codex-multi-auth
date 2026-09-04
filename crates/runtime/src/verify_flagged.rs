//! Port of `lib/runtime/verify-flagged.ts` (+ `flagged-verify-types.ts`) —
//! the CLI `verify-flagged` engine (spec 10 §14).
//!
//! Restoration ladder per flagged account: Codex CLI token cache first
//! (needs a finite future `expiresAt` AND a non-blank refresh token), else a
//! queued refresh. Restored accounts flow through the login-time account
//! resolver (`resolveTokenSuccessAccount`) with accountId/label backfill
//! from the flagged record.

#![allow(clippy::result_large_err)] // CodexError is the crate-wide error vocabulary.

use cma_core::errors::CodexError;
use cma_core::logger::mask_email;
use cma_core::schemas::account_storage::AccountIdSource;
use cma_core::schemas::flagged::{FlaggedAccountMetadataV1, FlaggedAccountStorageV1};
use cma_core::schemas::token::{TokenResult, TokenSuccess};

use crate::account_check::CliCachedTokens;
use crate::account_selection::TokenSuccessWithAccount;

/// TS `FlaggedVerificationState` (flagged-verify-types.ts).
#[derive(Debug, Default)]
pub struct FlaggedVerificationState {
    pub remaining: Vec<FlaggedAccountMetadataV1>,
    pub restored: Vec<TokenSuccessWithAccount>,
}

/// TS `createFlaggedVerificationState()`.
pub fn create_flagged_verification_state() -> FlaggedVerificationState {
    FlaggedVerificationState::default()
}

/// I/O seams of [`verify_runtime_flagged_accounts`].
#[allow(async_fn_in_trait)]
pub trait VerifyFlaggedDeps {
    async fn load_flagged_accounts(&mut self) -> Result<FlaggedAccountStorageV1, CodexError>;
    /// Errors swallowed at the call site in TS (`.catch(() => null)`).
    async fn lookup_codex_cli_tokens_by_email(
        &mut self,
        email: Option<&str>,
    ) -> Option<CliCachedTokens>;
    async fn queued_refresh(&mut self, refresh_token: &str) -> TokenResult;
    /// TS `resolveTokenSuccessAccount` — may fail (routed into the
    /// per-account catch: `ERROR (...)`, account kept with updated
    /// `lastError`).
    fn resolve_token_success_account(
        &mut self,
        tokens: TokenSuccess,
    ) -> Result<TokenSuccessWithAccount, CodexError>;
    async fn persist_accounts(
        &mut self,
        results: &[TokenSuccessWithAccount],
        replace_all: bool,
    ) -> Result<(), CodexError>;
    /// TS optional `persistAccountsAndFlagged` — override BOTH methods to
    /// enable the combined write.
    fn supports_combined_persist(&self) -> bool {
        false
    }
    async fn persist_accounts_and_flagged(
        &mut self,
        results: &[TokenSuccessWithAccount],
        flagged: &FlaggedAccountStorageV1,
        replace_all: bool,
    ) -> Result<(), CodexError> {
        let _ = (results, flagged, replace_all);
        Ok(())
    }
    fn invalidate_account_manager_cache(&mut self);
    async fn save_flagged_accounts(
        &mut self,
        storage: &FlaggedAccountStorageV1,
    ) -> Result<(), CodexError>;
    fn log_error(&mut self, message: &str) {
        let _ = message;
    }
    fn now_ms(&mut self) -> i64 {
        cma_core::utils::now_ms()
    }
    fn show_line(&mut self, message: &str);
}

/// Backfill accountId/label from the flagged record when the resolver did
/// not set them (TS inline logic, shared by both restoration paths).
fn backfill_from_flagged(
    mut resolved: TokenSuccessWithAccount,
    flagged: &FlaggedAccountMetadataV1,
) -> TokenSuccessWithAccount {
    if resolved.account_id_override.is_none()
        && let Some(account_id) = flagged.account_id.clone()
    {
        resolved.account_id_override = Some(account_id);
        resolved.account_id_source =
            Some(flagged.account_id_source.unwrap_or(AccountIdSource::Manual));
    }
    if resolved.account_label.is_none()
        && let Some(label) = flagged.account_label.clone()
    {
        resolved.account_label = Some(label);
    }
    resolved
}

fn truncate_chars(message: &str, limit: usize) -> String {
    message.chars().take(limit).collect()
}

/// TS `verifyRuntimeFlaggedAccounts(deps)`.
pub async fn verify_runtime_flagged_accounts<D: VerifyFlaggedDeps>(
    deps: &mut D,
) -> Result<(), CodexError> {
    let flagged_storage = deps.load_flagged_accounts().await?;
    if flagged_storage.accounts.is_empty() {
        deps.show_line("\nNo flagged accounts to verify.\n");
        return Ok(());
    }

    deps.show_line("\nVerifying flagged accounts...\n");
    let mut state = create_flagged_verification_state();
    let total = flagged_storage.accounts.len();

    for (i, flagged) in flagged_storage.accounts.iter().enumerate() {
        let masked_email = flagged.email.as_deref().map(mask_email);
        let label = flagged
            .account_label
            .clone()
            .or(masked_email)
            .unwrap_or_else(|| format!("Flagged {}", i + 1));

        // The TS try-block; Err = a caught exception.
        let item_result: Result<(), CodexError> = async {
            let cached = deps
                .lookup_codex_cli_tokens_by_email(flagged.email.as_deref())
                .await;
            let now = deps.now_ms();
            if let Some(cached) = cached
                && cached
                    .expires_at
                    .is_some_and(|v| v.is_finite() && v > now as f64)
            {
                let refresh_token = cached
                    .refresh_token
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string);
                if let Some(refresh_token) = refresh_token {
                    let resolved = deps.resolve_token_success_account(TokenSuccess {
                        access: cached.access_token.clone(),
                        refresh: refresh_token,
                        expires: cached.expires_at.map(|v| v as i64).unwrap_or_default(),
                        id_token: None,
                        multi_account: Some(true),
                    })?;
                    let resolved = backfill_from_flagged(resolved, flagged);
                    state.restored.push(resolved);
                    deps.show_line(&format!(
                        "[{}/{total}] {label}: RESTORED (Codex CLI cache)",
                        i + 1
                    ));
                    return Ok(());
                }
            }

            let refresh_result = deps.queued_refresh(&flagged.refresh_token).await;
            match refresh_result {
                TokenResult::Failed(failure) => {
                    let message = failure
                        .message
                        .clone()
                        .or_else(|| failure.reason.map(|r| r.as_str().to_string()))
                        .unwrap_or_else(|| "refresh failed".to_string());
                    deps.show_line(&format!(
                        "[{}/{total}] {label}: STILL FLAGGED ({message})",
                        i + 1
                    ));
                    state.remaining.push(flagged.clone());
                    Ok(())
                }
                TokenResult::Success(refreshed) => {
                    let resolved = deps.resolve_token_success_account(refreshed)?;
                    let resolved = backfill_from_flagged(resolved, flagged);
                    state.restored.push(resolved);
                    deps.show_line(&format!("[{}/{total}] {label}: RESTORED", i + 1));
                    Ok(())
                }
            }
        }
        .await;

        if let Err(error) = item_result {
            let message = error.message().to_string();
            deps.log_error(&format!(
                "Failed to verify flagged account {label}: {message}"
            ));
            deps.show_line(&format!(
                "[{}/{total}] {label}: ERROR ({})",
                i + 1,
                truncate_chars(&message, 120)
            ));
            let mut kept = flagged.clone();
            kept.last_error = Some(message);
            state.remaining.push(kept);
        }
    }

    let next_flagged_storage = FlaggedAccountStorageV1 {
        version: Default::default(),
        accounts: state.remaining.clone(),
    };

    if !state.restored.is_empty() && deps.supports_combined_persist() {
        deps.persist_accounts_and_flagged(&state.restored, &next_flagged_storage, false)
            .await?;
        deps.invalidate_account_manager_cache();
    } else {
        if !state.restored.is_empty() {
            deps.persist_accounts(&state.restored, false).await?;
            deps.invalidate_account_manager_cache();
        }
        deps.save_flagged_accounts(&next_flagged_storage).await?;
    }

    deps.show_line("");
    deps.show_line(&format!(
        "Results: {} restored, {} still flagged",
        state.restored.len(),
        state.remaining.len()
    ));
    deps.show_line("");
    Ok(())
}

// =============================================================================
// Tests — ported from test/runtime-verify-flagged.test.ts
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::{TokenFailure, TokenFailureReason};

    fn flagged_account(refresh: &str, email: Option<&str>) -> FlaggedAccountMetadataV1 {
        let mut account =
            cma_core::schemas::account_storage::AccountMetadataV3::new(refresh, 1, 1);
        account.email = email.map(str::to_string);
        FlaggedAccountMetadataV1::from_account(
            account,
            500,
            Some("token-invalid".to_string()),
            Some("old error".to_string()),
        )
    }

    struct FakeDeps {
        flagged: FlaggedAccountStorageV1,
        cli_cache: Option<CliCachedTokens>,
        refresh_result: Option<TokenResult>,
        resolver_fails: bool,
        lines: Vec<String>,
        errors: Vec<String>,
        persisted: Option<(Vec<TokenSuccessWithAccount>, bool)>,
        combined: Option<(Vec<TokenSuccessWithAccount>, FlaggedAccountStorageV1, bool)>,
        combined_supported: bool,
        saved_flagged: Option<FlaggedAccountStorageV1>,
        invalidations: u32,
    }

    impl Default for FakeDeps {
        fn default() -> Self {
            Self {
                flagged: FlaggedAccountStorageV1::empty(),
                cli_cache: None,
                refresh_result: None,
                resolver_fails: false,
                lines: Vec::new(),
                errors: Vec::new(),
                persisted: None,
                combined: None,
                combined_supported: false,
                saved_flagged: None,
                invalidations: 0,
            }
        }
    }

    impl VerifyFlaggedDeps for FakeDeps {
        async fn load_flagged_accounts(&mut self) -> Result<FlaggedAccountStorageV1, CodexError> {
            Ok(self.flagged.clone())
        }
        async fn lookup_codex_cli_tokens_by_email(
            &mut self,
            _email: Option<&str>,
        ) -> Option<CliCachedTokens> {
            self.cli_cache.clone()
        }
        async fn queued_refresh(&mut self, _refresh_token: &str) -> TokenResult {
            self.refresh_result
                .clone()
                .unwrap_or(TokenResult::Failed(TokenFailure::default()))
        }
        fn resolve_token_success_account(
            &mut self,
            tokens: TokenSuccess,
        ) -> Result<TokenSuccessWithAccount, CodexError> {
            if self.resolver_fails {
                return Err(CodexError::new("resolver exploded"));
            }
            Ok(TokenSuccessWithAccount::plain(tokens))
        }
        async fn persist_accounts(
            &mut self,
            results: &[TokenSuccessWithAccount],
            replace_all: bool,
        ) -> Result<(), CodexError> {
            self.persisted = Some((results.to_vec(), replace_all));
            Ok(())
        }
        fn supports_combined_persist(&self) -> bool {
            self.combined_supported
        }
        async fn persist_accounts_and_flagged(
            &mut self,
            results: &[TokenSuccessWithAccount],
            flagged: &FlaggedAccountStorageV1,
            replace_all: bool,
        ) -> Result<(), CodexError> {
            self.combined = Some((results.to_vec(), flagged.clone(), replace_all));
            Ok(())
        }
        fn invalidate_account_manager_cache(&mut self) {
            self.invalidations += 1;
        }
        async fn save_flagged_accounts(
            &mut self,
            storage: &FlaggedAccountStorageV1,
        ) -> Result<(), CodexError> {
            self.saved_flagged = Some(storage.clone());
            Ok(())
        }
        fn log_error(&mut self, message: &str) {
            self.errors.push(message.to_string());
        }
        fn now_ms(&mut self) -> i64 {
            1_000
        }
        fn show_line(&mut self, message: &str) {
            self.lines.push(message.to_string());
        }
    }

    #[tokio::test]
    async fn empty_pool_prints_nothing_to_verify() {
        let mut deps = FakeDeps::default();
        verify_runtime_flagged_accounts(&mut deps).await.unwrap();
        assert_eq!(deps.lines, vec!["\nNo flagged accounts to verify.\n"]);
        assert!(deps.saved_flagged.is_none());
    }

    #[tokio::test]
    async fn restores_via_cli_cache_with_backfill() {
        let mut flagged = flagged_account("rt-flagged", Some("f@example.com"));
        flagged.account_id = Some("acc_prev".to_string());
        flagged.account_label = Some("Prev label".to_string());
        let mut deps = FakeDeps {
            flagged: FlaggedAccountStorageV1 {
                version: Default::default(),
                accounts: vec![flagged],
            },
            cli_cache: Some(CliCachedTokens {
                access_token: "at-cli".to_string(),
                refresh_token: Some("  rt-cli  ".to_string()),
                expires_at: Some(2_000.0),
            }),
            ..FakeDeps::default()
        };
        verify_runtime_flagged_accounts(&mut deps).await.unwrap();

        assert_eq!(deps.lines[1], "[1/1] Prev label: RESTORED (Codex CLI cache)");
        let (persisted, replace_all) = deps.persisted.expect("persisted");
        assert!(!replace_all);
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].tokens.refresh, "rt-cli");
        assert_eq!(persisted[0].tokens.multi_account, Some(true));
        // Backfill from the flagged record (resolver returned plain tokens).
        assert_eq!(persisted[0].account_id_override.as_deref(), Some("acc_prev"));
        assert_eq!(persisted[0].account_id_source, Some(AccountIdSource::Manual));
        assert_eq!(persisted[0].account_label.as_deref(), Some("Prev label"));
        // Flagged pool emptied.
        assert!(deps.saved_flagged.expect("flagged saved").accounts.is_empty());
        assert_eq!(deps.invalidations, 1);
        assert_eq!(deps.lines[3], "Results: 1 restored, 0 still flagged");
    }

    #[tokio::test]
    async fn cli_cache_without_refresh_token_falls_through_to_refresh() {
        let mut deps = FakeDeps {
            flagged: FlaggedAccountStorageV1 {
                version: Default::default(),
                accounts: vec![flagged_account("rt-flagged", Some("f@example.com"))],
            },
            cli_cache: Some(CliCachedTokens {
                access_token: "at-cli".to_string(),
                refresh_token: Some("   ".to_string()),
                expires_at: Some(2_000.0),
            }),
            refresh_result: Some(TokenResult::Failed(TokenFailure {
                reason: Some(TokenFailureReason::Unknown),
                status_code: None,
                message: None,
            })),
            ..FakeDeps::default()
        };
        verify_runtime_flagged_accounts(&mut deps).await.unwrap();
        assert_eq!(deps.lines[1], "[1/1] f***@***.com: STILL FLAGGED (unknown)");
        assert!(deps.persisted.is_none());
        let saved = deps.saved_flagged.expect("flagged saved");
        assert_eq!(saved.accounts.len(), 1);
        assert_eq!(deps.lines[3], "Results: 0 restored, 1 still flagged");
    }

    #[tokio::test]
    async fn refresh_success_restores_and_uses_combined_persist_when_available() {
        let mut deps = FakeDeps {
            flagged: FlaggedAccountStorageV1 {
                version: Default::default(),
                accounts: vec![flagged_account("rt-flagged", None)],
            },
            refresh_result: Some(TokenResult::Success(TokenSuccess {
                access: "at-new".to_string(),
                refresh: "rt-new".to_string(),
                expires: 9_999,
                id_token: None,
                multi_account: None,
            })),
            combined_supported: true,
            ..FakeDeps::default()
        };
        verify_runtime_flagged_accounts(&mut deps).await.unwrap();
        assert_eq!(deps.lines[1], "[1/1] Flagged 1: RESTORED");
        let (results, flagged, replace_all) = deps.combined.expect("combined persist");
        assert_eq!(results.len(), 1);
        assert!(flagged.accounts.is_empty());
        assert!(!replace_all);
        // Combined path does NOT also call the split writers.
        assert!(deps.persisted.is_none());
        assert!(deps.saved_flagged.is_none());
        assert_eq!(deps.invalidations, 1);
    }

    #[tokio::test]
    async fn resolver_error_keeps_account_with_updated_last_error() {
        let mut deps = FakeDeps {
            flagged: FlaggedAccountStorageV1 {
                version: Default::default(),
                accounts: vec![flagged_account("rt-flagged", Some("x@example.com"))],
            },
            refresh_result: Some(TokenResult::Success(TokenSuccess {
                access: "at".to_string(),
                refresh: "rt".to_string(),
                expires: 9_999,
                id_token: None,
                multi_account: None,
            })),
            resolver_fails: true,
            ..FakeDeps::default()
        };
        verify_runtime_flagged_accounts(&mut deps).await.unwrap();
        assert_eq!(deps.lines[1], "[1/1] x***@***.com: ERROR (resolver exploded)");
        assert_eq!(
            deps.errors,
            vec!["Failed to verify flagged account x***@***.com: resolver exploded"]
        );
        let saved = deps.saved_flagged.expect("flagged saved");
        assert_eq!(saved.accounts.len(), 1);
        assert_eq!(saved.accounts[0].last_error.as_deref(), Some("resolver exploded"));
        assert_eq!(deps.lines[3], "Results: 0 restored, 1 still flagged");
    }
}
