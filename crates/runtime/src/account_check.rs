//! Port of `lib/runtime/account-check.ts` (+ `account-check-helpers.ts`,
//! `account-check-types.ts`) — the CLI `check` command engine
//! (spec 10 §13).
//!
//! Output contract: every `[i/total] label: ...` progress line and the
//! `Results: ...` summary are frozen strings (spec 10 §25).
//!
//! Note: disabled accounts are counted + printed as `DISABLED` and skipped —
//! the "re-enable working disabled accounts" behavior lives in the manager
//! crate's `health_check.rs` (TS `lib/codex-manager/health-check.ts`), not
//! here (the runtime TS module has no re-enable path).

use cma_core::errors::CodexError;
use cma_core::logger::mask_email;
use cma_core::model_family::{MODEL_FAMILIES, ModelFamily};
use cma_core::schemas::account_storage::{AccountIdSource, AccountStorageV3, ActiveIndexByFamily};
use cma_core::schemas::flagged::{FlaggedAccountMetadataV1, FlaggedAccountStorageV1};
use cma_core::schemas::token::{TokenFailure, TokenResult};
use cma_core::token_utils::{
    extract_account_email, extract_account_id, resolve_request_account_id, sanitize_email,
    should_update_account_id_from_token,
};
use cma_quota::probe::{CODEX_UNAVAILABLE_PROBE_NOTE, CodexQuotaSnapshot};
use cma_storage::matching::reconcile_pinned_account_index;
use std::collections::HashSet;

/// Codex CLI token-cache lookup result (TS inline
/// `{refreshToken?, accessToken, expiresAt?}`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CliCachedTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Kept as `f64` to mirror the tolerant CLI-state parse (`Number()`
    /// coercion); non-finite values behave like "no expiry".
    pub expires_at: Option<f64>,
}

/// TS `AccountCheckWorkingState` (account-check-types.ts).
#[derive(Debug)]
pub struct AccountCheckWorkingState {
    pub storage_changed: bool,
    pub flagged_changed: bool,
    pub ok: u32,
    pub errors: u32,
    pub warnings: u32,
    pub disabled: u32,
    pub remove_from_active: HashSet<String>,
    pub flagged_storage: FlaggedAccountStorageV1,
}

/// TS `createAccountCheckWorkingState(flaggedStorage)`.
pub fn create_account_check_working_state(
    flagged_storage: FlaggedAccountStorageV1,
) -> AccountCheckWorkingState {
    AccountCheckWorkingState {
        storage_changed: false,
        flagged_changed: false,
        ok: 0,
        errors: 0,
        warnings: 0,
        disabled: 0,
        remove_from_active: HashSet::new(),
        flagged_storage,
    }
}

/// TS `clampActiveIndices(storage, families)` (account-check-helpers.ts).
pub fn clamp_active_indices(storage: &mut AccountStorageV3, families: &[ModelFamily]) {
    let count = storage.accounts.len();
    if count == 0 {
        storage.active_index = 0;
        storage.active_index_by_family = Some(ActiveIndexByFamily::default());
        return;
    }
    let max_index = count as i64 - 1;
    storage.active_index = storage.active_index.clamp(0, max_index);
    let mut by_family = storage.active_index_by_family.take().unwrap_or_default();
    for family in families {
        let candidate = by_family.get(*family).unwrap_or(storage.active_index);
        by_family.set(*family, Some(candidate.clamp(0, max_index)));
    }
    storage.active_index_by_family = Some(by_family);
}

/// TS `isFlaggableFailure(failure)` — `missing_refresh`, HTTP 401, or a 400
/// whose message mentions a revoked/invalid refresh grant.
pub fn is_flaggable_failure(failure: &TokenFailure) -> bool {
    use cma_core::schemas::token::TokenFailureReason;
    if failure.reason == Some(TokenFailureReason::MissingRefresh) {
        return true;
    }
    if failure.status_code == Some(401) {
        return true;
    }
    if failure.status_code != Some(400) {
        return false;
    }
    let message = failure
        .message
        .as_deref()
        .unwrap_or("")
        .to_lowercase();
    message.contains("invalid_grant")
        || message.contains("invalid refresh")
        || message.contains("token has been revoked")
}

/// JS `message.slice(0, n)` (UTF-16 approximated with scalar values).
fn truncate_chars(message: &str, limit: usize) -> String {
    message.chars().take(limit).collect()
}

/// I/O seams of [`run_runtime_account_check`]. Pure helpers
/// (token extraction, masking, clamping, flag classification) are called
/// directly — the TS DI for those existed only for unit tests.
#[allow(async_fn_in_trait)]
pub trait AccountCheckDeps {
    async fn hydrate_emails(
        &mut self,
        storage: Option<AccountStorageV3>,
    ) -> Result<Option<AccountStorageV3>, CodexError>;
    async fn load_accounts(&mut self) -> Result<Option<AccountStorageV3>, CodexError>;
    async fn load_flagged_accounts(&mut self) -> Result<FlaggedAccountStorageV1, CodexError>;
    /// Lookup errors are swallowed at the call site in TS
    /// (`.catch(() => null)`) — return `None` on failure.
    async fn lookup_codex_cli_tokens_by_email(
        &mut self,
        email: Option<&str>,
    ) -> Option<CliCachedTokens>;
    async fn queued_refresh(&mut self, refresh_token: &str) -> TokenResult;
    async fn fetch_codex_quota_snapshot(
        &mut self,
        account_id: &str,
        access_token: &str,
    ) -> Result<CodexQuotaSnapshot, CodexError>;
    fn format_codex_quota_line(&mut self, snapshot: &CodexQuotaSnapshot) -> String {
        crate::quota_probe::format_codex_quota_line(snapshot)
    }
    async fn save_accounts(&mut self, storage: &AccountStorageV3) -> Result<(), CodexError>;
    async fn save_flagged_accounts(
        &mut self,
        storage: &FlaggedAccountStorageV1,
    ) -> Result<(), CodexError>;
    /// TS optional `persistAccountAndFlaggedStorage` — override BOTH methods
    /// to enable the single combined persist.
    fn supports_combined_persist(&self) -> bool {
        false
    }
    async fn persist_account_and_flagged_storage(
        &mut self,
        accounts: &AccountStorageV3,
        flagged: &FlaggedAccountStorageV1,
    ) -> Result<(), CodexError> {
        let _ = (accounts, flagged);
        Ok(())
    }
    fn invalidate_account_manager_cache(&mut self);
    fn now_ms(&mut self) -> i64 {
        cma_core::utils::now_ms()
    }
    fn show_line(&mut self, message: &str);
}

/// Per-account outcome of the token-acquisition ladder.
enum TokenOutcome {
    /// `(access_token, token_account_id, auth_detail)`
    Token(String, Option<String>, &'static str),
    /// Refresh failed; the progress line was already printed.
    RefreshFailed,
    /// The ladder produced no token (TS `throw new Error("Missing access
    /// token after refresh")` — caught by the outer per-account catch).
    MissingAfterRefresh,
}

/// TS `runRuntimeAccountCheck(deepProbe, deps)`.
pub async fn run_runtime_account_check<D: AccountCheckDeps>(
    deep_probe: bool,
    deps: &mut D,
) -> Result<(), CodexError> {
    let loaded = deps.load_accounts().await?;
    let loaded_storage = deps.hydrate_emails(loaded).await?;
    let mut working_storage = match loaded_storage {
        Some(storage) => {
            let mut clone = storage.clone();
            if clone.active_index_by_family.is_none() {
                clone.active_index_by_family = Some(ActiveIndexByFamily::default());
            }
            clone
        }
        None => AccountStorageV3::empty(),
    };

    if working_storage.accounts.is_empty() {
        deps.show_line("\nNo accounts to check.\n");
        return Ok(());
    }

    let flagged_storage = deps.load_flagged_accounts().await?;
    let mut state = create_account_check_working_state(flagged_storage);
    let total = working_storage.accounts.len();

    deps.show_line(&format!(
        "\nChecking {} for all accounts...\n",
        if deep_probe { "full account health" } else { "quotas" }
    ));

    for i in 0..total {
        let Some(account_snapshot) = working_storage.accounts.get(i).cloned() else {
            continue;
        };
        let masked_email = account_snapshot.email.as_deref().map(mask_email);
        let label = account_snapshot
            .account_label
            .clone()
            .or(masked_email)
            .unwrap_or_else(|| format!("Account {}", i + 1));

        if account_snapshot.enabled == Some(false) {
            state.disabled += 1;
            deps.show_line(&format!("[{}/{total}] {label}: DISABLED", i + 1));
            continue;
        }

        let now_ms = deps.now_ms();

        // --- Token-acquisition ladder (mutates the working account). ---
        let outcome = {
            let account = working_storage
                .accounts
                .get_mut(i)
                .expect("index in range");
            let mut access_token: Option<String> = None;
            let mut token_account_id: Option<String> = None;
            let mut auth_detail: &'static str = "OK";

            // (a) Stored access token still valid.
            let stored_access_valid = account
                .access_token
                .as_deref()
                .is_some_and(|t| !t.is_empty())
                && account.expires_at.is_none_or(|expires| expires > now_ms);
            if stored_access_valid {
                access_token = account.access_token.clone();
                auth_detail = "OK (cached access)";
                token_account_id = extract_account_id(account.access_token.as_deref());
                if let Some(token_id) = token_account_id.as_deref()
                    && should_update_account_id_from_token(
                        account.account_id_source.as_ref(),
                        account.account_id.as_deref(),
                    )
                    && Some(token_id) != account.account_id.as_deref()
                {
                    account.account_id = Some(token_id.to_string());
                    account.account_id_source = Some(AccountIdSource::Token);
                    state.storage_changed = true;
                }
            }

            // (b) Codex CLI token cache by email.
            if access_token.is_none() {
                let cached = deps
                    .lookup_codex_cli_tokens_by_email(account_snapshot.email.as_deref())
                    .await;
                if let Some(cached) = cached {
                    let cached_valid = match cached.expires_at {
                        None => true,
                        Some(v) if !v.is_finite() => true,
                        Some(v) => v > now_ms as f64,
                    };
                    if cached_valid {
                        access_token = Some(cached.access_token.clone());
                        auth_detail = "OK (Codex CLI cache)";
                        if !cached.access_token.is_empty()
                            && Some(cached.access_token.as_str())
                                != account.access_token.as_deref()
                        {
                            account.access_token = Some(cached.access_token.clone());
                            state.storage_changed = true;
                        }
                        let cached_expires: Option<i64> = cached
                            .expires_at
                            .filter(|v| v.is_finite())
                            .map(|v| v as i64);
                        if cached_expires != account.expires_at {
                            account.expires_at = cached_expires;
                            state.storage_changed = true;
                        }

                        let hydrated_email = sanitize_email(
                            extract_account_email(Some(&cached.access_token), None).as_deref(),
                        );
                        if let Some(email) = hydrated_email
                            && Some(email.as_str()) != account.email.as_deref()
                        {
                            account.email = Some(email);
                            state.storage_changed = true;
                        }

                        token_account_id = extract_account_id(Some(&cached.access_token));
                        if let Some(token_id) = token_account_id.as_deref()
                            && should_update_account_id_from_token(
                                account.account_id_source.as_ref(),
                                account.account_id.as_deref(),
                            )
                            && Some(token_id) != account.account_id.as_deref()
                        {
                            account.account_id = Some(token_id.to_string());
                            account.account_id_source = Some(AccountIdSource::Token);
                            state.storage_changed = true;
                        }
                    }
                }
            }

            // (c) Queued refresh.
            if access_token.is_none() {
                let refresh_result = deps.queued_refresh(&account.refresh_token).await;
                match refresh_result {
                    TokenResult::Failed(failure) => {
                        state.errors += 1;
                        let message = failure
                            .message
                            .clone()
                            .or_else(|| failure.reason.map(|r| r.as_str().to_string()))
                            .unwrap_or_else(|| "refresh failed".to_string());
                        deps.show_line(&format!(
                            "[{}/{total}] {label}: ERROR ({message})",
                            i + 1
                        ));
                        if deep_probe && is_flaggable_failure(&failure) {
                            let flagged_record = FlaggedAccountMetadataV1::from_account(
                                account.clone(),
                                now_ms,
                                Some("token-invalid".to_string()),
                                Some(message),
                            );
                            let existing_index = state
                                .flagged_storage
                                .accounts
                                .iter()
                                .position(|f| f.refresh_token == account.refresh_token);
                            match existing_index {
                                Some(index) => {
                                    state.flagged_storage.accounts[index] = flagged_record;
                                }
                                None => state.flagged_storage.accounts.push(flagged_record),
                            }
                            state
                                .remove_from_active
                                .insert(account.refresh_token.clone());
                            state.flagged_changed = true;
                        }
                        TokenOutcome::RefreshFailed
                    }
                    TokenResult::Success(refreshed) => {
                        access_token = Some(refreshed.access.clone());
                        auth_detail = "OK";
                        if refreshed.refresh != account.refresh_token {
                            account.refresh_token = refreshed.refresh.clone();
                            state.storage_changed = true;
                        }
                        if !refreshed.access.is_empty()
                            && Some(refreshed.access.as_str()) != account.access_token.as_deref()
                        {
                            account.access_token = Some(refreshed.access.clone());
                            state.storage_changed = true;
                        }
                        if Some(refreshed.expires) != account.expires_at {
                            account.expires_at = Some(refreshed.expires);
                            state.storage_changed = true;
                        }
                        let hydrated_email = sanitize_email(
                            extract_account_email(
                                Some(&refreshed.access),
                                refreshed.id_token.as_deref(),
                            )
                            .as_deref(),
                        );
                        if let Some(email) = hydrated_email
                            && Some(email.as_str()) != account.email.as_deref()
                        {
                            account.email = Some(email);
                            state.storage_changed = true;
                        }
                        token_account_id = extract_account_id(Some(&refreshed.access));
                        if let Some(token_id) = token_account_id.as_deref()
                            && should_update_account_id_from_token(
                                account.account_id_source.as_ref(),
                                account.account_id.as_deref(),
                            )
                            && Some(token_id) != account.account_id.as_deref()
                        {
                            account.account_id = Some(token_id.to_string());
                            account.account_id_source = Some(AccountIdSource::Token);
                            state.storage_changed = true;
                        }
                        match access_token {
                            Some(token) => {
                                TokenOutcome::Token(token, token_account_id.clone(), auth_detail)
                            }
                            None => TokenOutcome::MissingAfterRefresh,
                        }
                    }
                }
            } else {
                match access_token {
                    Some(token) => {
                        TokenOutcome::Token(token, token_account_id.clone(), auth_detail)
                    }
                    None => TokenOutcome::MissingAfterRefresh,
                }
            }
        };

        let (access_token, token_account_id, auth_detail) = match outcome {
            TokenOutcome::RefreshFailed => continue,
            TokenOutcome::MissingAfterRefresh => {
                // TS `throw new Error("Missing access token after refresh")`
                // caught by the outer per-account catch (120-char slice).
                state.errors += 1;
                deps.show_line(&format!(
                    "[{}/{total}] {label}: ERROR ({})",
                    i + 1,
                    truncate_chars("Missing access token after refresh", 120)
                ));
                continue;
            }
            TokenOutcome::Token(token, id, detail) => (token, id, detail),
        };

        if deep_probe {
            state.ok += 1;
            let detail = match token_account_id.as_deref() {
                Some(token_id) => {
                    let chars: Vec<char> = token_id.chars().collect();
                    let start = chars.len().saturating_sub(6);
                    let suffix: String = chars[start..].iter().collect();
                    format!("{auth_detail} (id:{suffix})")
                }
                None => auth_detail.to_string(),
            };
            deps.show_line(&format!("[{}/{total}] {label}: {detail}", i + 1));
            continue;
        }

        // --- Quota probe (inner try/catch, 160-char truncation). ---
        let account_ref = &working_storage.accounts[i];
        let request_account_id = resolve_request_account_id(
            account_ref.account_id.as_deref(),
            account_ref.account_id_source.as_ref(),
            token_account_id.as_deref(),
        )
        .or_else(|| token_account_id.clone())
        .or_else(|| account_ref.account_id.clone());

        let probe_result: Result<String, CodexError> = match request_account_id {
            None => Err(CodexError::new("Missing accountId for quota probe")),
            Some(request_account_id) => deps
                .fetch_codex_quota_snapshot(&request_account_id, &access_token)
                .await
                .map(|snapshot| deps.format_codex_quota_line(&snapshot)),
        };

        match probe_result {
            Ok(line) => {
                state.ok += 1;
                deps.show_line(&format!("[{}/{total}] {label}: {line}", i + 1));
            }
            Err(error) if error.is_codex_unavailable() => {
                state.warnings += 1;
                state.ok += 1;
                deps.show_line(&format!(
                    "[{}/{total}] {label}: {CODEX_UNAVAILABLE_PROBE_NOTE}",
                    i + 1
                ));
            }
            Err(error) => {
                state.errors += 1;
                deps.show_line(&format!(
                    "[{}/{total}] {label}: ERROR ({})",
                    i + 1,
                    truncate_chars(error.message(), 160)
                ));
            }
        }
    }

    if !state.remove_from_active.is_empty() {
        // Follow the manual pin by IDENTITY across the removal (#474): the
        // filter can drop several accounts at once, so a raw index would
        // point at the wrong account or out of range.
        let pinned_account = working_storage
            .pinned_account_index
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| working_storage.accounts.get(index).cloned());
        working_storage
            .accounts
            .retain(|account| !state.remove_from_active.contains(&account.refresh_token));
        clamp_active_indices(&mut working_storage, &MODEL_FAMILIES);
        working_storage.pinned_account_index =
            reconcile_pinned_account_index(pinned_account.as_ref(), &working_storage.accounts)
                .map(|index| index as i64);
        state.storage_changed = true;
    }

    let can_persist_together =
        state.flagged_changed && state.storage_changed && deps.supports_combined_persist();
    if can_persist_together {
        deps.persist_account_and_flagged_storage(&working_storage, &state.flagged_storage)
            .await?;
        deps.invalidate_account_manager_cache();
    } else {
        if state.flagged_changed {
            deps.save_flagged_accounts(&state.flagged_storage).await?;
        }
        if state.storage_changed {
            deps.save_accounts(&working_storage).await?;
            deps.invalidate_account_manager_cache();
        }
    }

    deps.show_line("");
    if state.warnings > 0 {
        deps.show_line(&format!(
            "Results: {} ok, {} warning, {} error, {} disabled",
            state.ok, state.warnings, state.errors, state.disabled
        ));
    } else {
        deps.show_line(&format!(
            "Results: {} ok, {} error, {} disabled",
            state.ok, state.errors, state.disabled
        ));
    }
    if !state.remove_from_active.is_empty() {
        deps.show_line(&format!(
            "Moved {} account(s) to flagged pool (invalid refresh token).",
            state.remove_from_active.len()
        ));
    }
    deps.show_line("");
    Ok(())
}

// =============================================================================
// Tests — ported from test/account-check-helpers.test.ts +
// test/runtime-account-check.test.ts (output contract)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_core::schemas::token::{TokenFailureReason, TokenSuccess};
    use cma_quota::probe::CodexQuotaWindow;
    use serde_json::json;

    /// Minimal base64url (no padding) — the runtime crate has no base64
    /// dev-dependency.
    fn b64url(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(ALPHABET[(n >> 18) as usize & 63] as char);
            out.push(ALPHABET[(n >> 12) as usize & 63] as char);
            if chunk.len() > 1 {
                out.push(ALPHABET[(n >> 6) as usize & 63] as char);
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[n as usize & 63] as char);
            }
        }
        out
    }

    fn make_jwt(account_id: &str, email: &str) -> String {
        let header = b64url(br#"{"alg":"none"}"#);
        let payload = json!({
            "https://api.openai.com/auth": {"chatgpt_account_id": account_id},
            "email": email,
        });
        let body = b64url(&serde_json::to_vec(&payload).unwrap());
        format!("{header}.{body}.sig")
    }

    // ---- helpers ----

    #[test]
    fn clamp_active_indices_matches_ts() {
        let mut storage = AccountStorageV3::empty();
        storage.active_index = 7;
        clamp_active_indices(&mut storage, &MODEL_FAMILIES);
        assert_eq!(storage.active_index, 0);
        assert!(storage.active_index_by_family.as_ref().unwrap().is_empty());

        let mut storage = AccountStorageV3::empty();
        for i in 0..2 {
            storage
                .accounts
                .push(AccountMetadataV3::new(format!("rt-{i}"), 1, 1));
        }
        storage.active_index = 9;
        let mut by_family = ActiveIndexByFamily::default();
        by_family.set(ModelFamily::Codex, Some(5));
        storage.active_index_by_family = Some(by_family);
        clamp_active_indices(&mut storage, &MODEL_FAMILIES);
        assert_eq!(storage.active_index, 1);
        let by_family = storage.active_index_by_family.as_ref().unwrap();
        assert_eq!(by_family.get(ModelFamily::Codex), Some(1));
        // Missing families fall back to the clamped activeIndex.
        assert_eq!(by_family.get(ModelFamily::Gpt5_2), Some(1));
    }

    #[test]
    fn is_flaggable_failure_matches_ts() {
        let failure = |reason: Option<TokenFailureReason>,
                       status: Option<i64>,
                       message: Option<&str>| TokenFailure {
            reason,
            status_code: status,
            message: message.map(str::to_string),
        };
        assert!(is_flaggable_failure(&failure(
            Some(TokenFailureReason::MissingRefresh),
            None,
            None
        )));
        assert!(is_flaggable_failure(&failure(None, Some(401), None)));
        assert!(!is_flaggable_failure(&failure(None, Some(500), None)));
        assert!(!is_flaggable_failure(&failure(None, None, None)));
        assert!(is_flaggable_failure(&failure(
            None,
            Some(400),
            Some("INVALID_GRANT: bad token")
        )));
        assert!(is_flaggable_failure(&failure(
            None,
            Some(400),
            Some("your Token Has Been Revoked")
        )));
        assert!(!is_flaggable_failure(&failure(
            None,
            Some(400),
            Some("some other 400")
        )));
    }

    // ---- engine ----

    struct FakeDeps {
        storage: Option<AccountStorageV3>,
        flagged: FlaggedAccountStorageV1,
        cli_cache: Option<CliCachedTokens>,
        refresh_result: Option<TokenResult>,
        probe_result: Option<Result<CodexQuotaSnapshot, String>>,
        probe_unavailable: bool,
        lines: Vec<String>,
        saved_storage: Option<AccountStorageV3>,
        saved_flagged: Option<FlaggedAccountStorageV1>,
        invalidations: u32,
        now: i64,
    }

    impl Default for FakeDeps {
        fn default() -> Self {
            Self {
                storage: None,
                flagged: FlaggedAccountStorageV1::empty(),
                cli_cache: None,
                refresh_result: None,
                probe_result: None,
                probe_unavailable: false,
                lines: Vec::new(),
                saved_storage: None,
                saved_flagged: None,
                invalidations: 0,
                now: 0,
            }
        }
    }

    impl AccountCheckDeps for FakeDeps {
        async fn hydrate_emails(
            &mut self,
            storage: Option<AccountStorageV3>,
        ) -> Result<Option<AccountStorageV3>, CodexError> {
            Ok(storage)
        }
        async fn load_accounts(&mut self) -> Result<Option<AccountStorageV3>, CodexError> {
            Ok(self.storage.clone())
        }
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
        async fn fetch_codex_quota_snapshot(
            &mut self,
            _account_id: &str,
            _access_token: &str,
        ) -> Result<CodexQuotaSnapshot, CodexError> {
            if self.probe_unavailable {
                return Err(CodexError::unavailable("Model unsupported"));
            }
            match self.probe_result.clone() {
                Some(Ok(snapshot)) => Ok(snapshot),
                Some(Err(message)) => Err(CodexError::new(message)),
                None => Err(CodexError::new("no probe configured")),
            }
        }
        async fn save_accounts(&mut self, storage: &AccountStorageV3) -> Result<(), CodexError> {
            self.saved_storage = Some(storage.clone());
            Ok(())
        }
        async fn save_flagged_accounts(
            &mut self,
            storage: &FlaggedAccountStorageV1,
        ) -> Result<(), CodexError> {
            self.saved_flagged = Some(storage.clone());
            Ok(())
        }
        fn invalidate_account_manager_cache(&mut self) {
            self.invalidations += 1;
        }
        fn now_ms(&mut self) -> i64 {
            self.now
        }
        fn show_line(&mut self, message: &str) {
            self.lines.push(message.to_string());
        }
    }

    fn storage_with_account(account: AccountMetadataV3) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account);
        storage
    }

    #[tokio::test]
    async fn empty_pool_prints_no_accounts() {
        let mut deps = FakeDeps {
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(true, &mut deps).await.unwrap();
        assert_eq!(deps.lines, vec!["\nNo accounts to check.\n"]);
    }

    #[tokio::test]
    async fn disabled_accounts_are_counted_and_skipped() {
        let mut account = AccountMetadataV3::new("rt-1", 1, 1);
        account.enabled = Some(false);
        account.account_label = Some("Work".to_string());
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account)),
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(true, &mut deps).await.unwrap();
        assert_eq!(
            deps.lines,
            vec![
                "\nChecking full account health for all accounts...\n",
                "[1/1] Work: DISABLED",
                "",
                "Results: 0 ok, 0 error, 1 disabled",
                "",
            ]
        );
        assert!(deps.saved_storage.is_none());
    }

    #[tokio::test]
    async fn deep_probe_prints_ok_with_id_suffix() {
        let access = make_jwt("acc_1234567890", "user@example.com");
        let mut account = AccountMetadataV3::new("rt-1", 1, 1);
        account.email = Some("user@example.com".to_string());
        account.access_token = Some(access);
        account.expires_at = Some(999_999_999_999_999);
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account)),
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(true, &mut deps).await.unwrap();
        assert_eq!(deps.lines[0], "\nChecking full account health for all accounts...\n");
        assert_eq!(
            deps.lines[1],
            "[1/1] us***@***.com: OK (cached access) (id:567890)"
        );
        assert_eq!(deps.lines[3], "Results: 1 ok, 0 error, 0 disabled");
        // accountId was adopted from the token.
        let saved = deps.saved_storage.expect("storage saved");
        assert_eq!(saved.accounts[0].account_id.as_deref(), Some("acc_1234567890"));
        assert_eq!(
            saved.accounts[0].account_id_source,
            Some(AccountIdSource::Token)
        );
        assert_eq!(deps.invalidations, 1);
    }

    #[tokio::test]
    async fn flaggable_refresh_failure_moves_account_to_flagged_pool() {
        let account = AccountMetadataV3::new("rt-bad", 1, 1);
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account)),
            refresh_result: Some(TokenResult::Failed(TokenFailure {
                reason: None,
                status_code: Some(401),
                message: Some("invalid refresh token".to_string()),
            })),
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(true, &mut deps).await.unwrap();

        assert_eq!(
            deps.lines[1],
            "[1/1] Account 1: ERROR (invalid refresh token)"
        );
        assert_eq!(deps.lines[3], "Results: 0 ok, 1 error, 0 disabled");
        assert_eq!(
            deps.lines[4],
            "Moved 1 account(s) to flagged pool (invalid refresh token)."
        );

        let flagged = deps.saved_flagged.expect("flagged saved");
        assert_eq!(flagged.accounts.len(), 1);
        assert_eq!(flagged.accounts[0].refresh_token, "rt-bad");
        assert_eq!(flagged.accounts[0].flagged_at, 1_000);
        assert_eq!(
            flagged.accounts[0].flagged_reason.as_deref(),
            Some("token-invalid")
        );
        assert_eq!(
            flagged.accounts[0].last_error.as_deref(),
            Some("invalid refresh token")
        );
        // Account removed from the active pool.
        let saved = deps.saved_storage.expect("storage saved");
        assert!(saved.accounts.is_empty());
    }

    #[tokio::test]
    async fn quota_mode_prints_snapshot_line_and_unavailable_note() {
        let access = make_jwt("acc_1", "q@example.com");
        let mut account = AccountMetadataV3::new("rt-1", 1, 1);
        account.email = Some("q@example.com".to_string());
        account.access_token = Some(access.clone());
        account.expires_at = None; // missing expiry → treated as valid
        let snapshot = CodexQuotaSnapshot {
            status: 200,
            plan_type: None,
            active_limit: None,
            primary: CodexQuotaWindow {
                used_percent: Some(20.0),
                window_minutes: Some(300),
                reset_at_ms: None,
            },
            secondary: CodexQuotaWindow {
                used_percent: Some(5.0),
                window_minutes: Some(10080),
                reset_at_ms: None,
            },
            model: "gpt-5.5".to_string(),
        };
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account.clone())),
            probe_result: Some(Ok(snapshot)),
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(false, &mut deps).await.unwrap();
        assert_eq!(deps.lines[0], "\nChecking quotas for all accounts...\n");
        assert_eq!(deps.lines[1], "[1/1] q***@***.com: 5h 80% left, 7d 95% left");
        assert_eq!(deps.lines[3], "Results: 1 ok, 0 error, 0 disabled");

        // Unavailable → warning + ok + constant note + 4-part summary.
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account)),
            probe_unavailable: true,
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(false, &mut deps).await.unwrap();
        assert_eq!(
            deps.lines[1],
            "[1/1] q***@***.com: Codex not available for this account"
        );
        assert_eq!(deps.lines[3], "Results: 1 ok, 1 warning, 0 error, 0 disabled");
    }

    #[tokio::test]
    async fn quota_probe_errors_truncate_to_160_chars() {
        let access = make_jwt("acc_1", "e@example.com");
        let mut account = AccountMetadataV3::new("rt-1", 1, 1);
        account.email = Some("e@example.com".to_string());
        account.access_token = Some(access);
        account.expires_at = None;
        let long_message = "x".repeat(200);
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account)),
            probe_result: Some(Err(long_message)),
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(false, &mut deps).await.unwrap();
        let expected = format!("[1/1] e***@***.com: ERROR ({})", "x".repeat(160));
        assert_eq!(deps.lines[1], expected);
    }

    #[tokio::test]
    async fn cli_cache_path_syncs_tokens_into_storage() {
        let cli_access = make_jwt("acc_cli", "cli@example.com");
        let account = AccountMetadataV3::new("rt-1", 1, 1);
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account)),
            cli_cache: Some(CliCachedTokens {
                access_token: cli_access.clone(),
                refresh_token: None,
                expires_at: Some(999_999_999_999_999.0),
            }),
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(true, &mut deps).await.unwrap();
        assert!(deps.lines[1].contains("OK (Codex CLI cache)"), "{}", deps.lines[1]);
        let saved = deps.saved_storage.expect("storage saved");
        assert_eq!(saved.accounts[0].access_token.as_deref(), Some(cli_access.as_str()));
        assert_eq!(saved.accounts[0].email.as_deref(), Some("cli@example.com"));
        assert_eq!(saved.accounts[0].account_id.as_deref(), Some("acc_cli"));
    }

    #[tokio::test]
    async fn successful_refresh_updates_rotated_tokens() {
        let new_access = make_jwt("acc_rot", "rot@example.com");
        let account = AccountMetadataV3::new("rt-old", 1, 1);
        let mut deps = FakeDeps {
            storage: Some(storage_with_account(account)),
            refresh_result: Some(TokenResult::Success(TokenSuccess {
                access: new_access.clone(),
                refresh: "rt-new".to_string(),
                expires: 2_000_000,
                id_token: None,
                multi_account: None,
            })),
            now: 1_000,
            ..FakeDeps::default()
        };
        run_runtime_account_check(true, &mut deps).await.unwrap();
        let saved = deps.saved_storage.expect("storage saved");
        assert_eq!(saved.accounts[0].refresh_token, "rt-new");
        assert_eq!(saved.accounts[0].access_token.as_deref(), Some(new_access.as_str()));
        assert_eq!(saved.accounts[0].expires_at, Some(2_000_000));
        assert_eq!(saved.accounts[0].email.as_deref(), Some("rot@example.com"));
    }
}
