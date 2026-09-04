//! Port of `lib/runtime/hydrate-emails.ts` — backfills missing account
//! emails via queued token refreshes (spec 10 §15).
//!
//! Gotcha 7: patches are applied **by index, never by accountId** — multiple
//! accounts can share `accountId === undefined`, and an id-keyed map would
//! collapse them and cross-apply tokens.
//!
//! Deviation (recorded): the TS version refreshes all targets in parallel
//! (`Promise.all`); the Rust port awaits them sequentially (the runtime
//! crate has no join-all dependency; `queuedRefresh` already serializes
//! same-token refreshes, so only wall-clock time differs).

use cma_core::errors::CodexError;
use cma_core::schemas::account_storage::{AccountIdSource, AccountStorageV3};
use cma_core::schemas::token::TokenResult;
use cma_core::token_utils::{
    extract_account_email, extract_account_id, sanitize_email, should_update_account_id_from_token,
};

/// I/O seams of [`hydrate_runtime_emails`].
#[allow(async_fn_in_trait)]
pub trait HydrateEmailsDeps {
    async fn queued_refresh(&mut self, refresh_token: &str) -> TokenResult;
    async fn save_accounts(&mut self, storage: &AccountStorageV3) -> Result<(), CodexError>;
    fn log_warn(&mut self, message: &str);
    fn plugin_name(&self) -> &str;
}

/// TS skip guard: `VITEST_WORKER_ID` set, `NODE_ENV === "test"`, or
/// `CODEX_SKIP_EMAIL_HYDRATE === "1"`.
fn should_skip_hydrate() -> bool {
    std::env::var_os("VITEST_WORKER_ID").is_some()
        || std::env::var("NODE_ENV").is_ok_and(|v| v == "test")
        || std::env::var("CODEX_SKIP_EMAIL_HYDRATE").is_ok_and(|v| v == "1")
}

/// TS `hydrateRuntimeEmails(storage, deps)` — returns the (possibly
/// mutated) storage.
pub async fn hydrate_runtime_emails<D: HydrateEmailsDeps>(
    storage: Option<AccountStorageV3>,
    deps: &mut D,
) -> Result<Option<AccountStorageV3>, CodexError> {
    let Some(mut storage) = storage else {
        return Ok(None);
    };
    if should_skip_hydrate() {
        return Ok(Some(storage));
    }

    let mut accounts_copy = storage.accounts.clone();
    let targets: Vec<usize> = accounts_copy
        .iter()
        .enumerate()
        .filter(|(_, account)| {
            account
                .email
                .as_deref()
                .is_none_or(str::is_empty)
        })
        .map(|(index, _)| index)
        .collect();
    if targets.is_empty() {
        return Ok(Some(storage));
    }

    let mut changed = false;
    for index in targets {
        let refresh_token = accounts_copy[index].refresh_token.clone();
        let refreshed = deps.queued_refresh(&refresh_token).await;
        let TokenResult::Success(refreshed) = refreshed else {
            continue;
        };
        let account = &mut accounts_copy[index];

        let id = extract_account_id(Some(&refreshed.access));
        let email = sanitize_email(
            extract_account_email(Some(&refreshed.access), refreshed.id_token.as_deref())
                .as_deref(),
        );
        if let Some(id) = id.as_deref()
            && Some(id) != account.account_id.as_deref()
            && should_update_account_id_from_token(
                account.account_id_source.as_ref(),
                account.account_id.as_deref(),
            )
        {
            account.account_id = Some(id.to_string());
            account.account_id_source = Some(AccountIdSource::Token);
            changed = true;
        }
        if let Some(email) = email
            && Some(email.as_str()) != account.email.as_deref()
        {
            account.email = Some(email);
            changed = true;
        }
        if !refreshed.access.is_empty()
            && Some(refreshed.access.as_str()) != account.access_token.as_deref()
        {
            account.access_token = Some(refreshed.access.clone());
            changed = true;
        }
        if Some(refreshed.expires) != account.expires_at {
            account.expires_at = Some(refreshed.expires);
            changed = true;
        }
        if !refreshed.refresh.is_empty() && refreshed.refresh != account.refresh_token {
            account.refresh_token = refreshed.refresh.clone();
            changed = true;
        }
    }

    // Note: the TS per-account catch (`"[{plugin}] Failed to hydrate email
    // for account"` via log_warn) guards a throwing queuedRefresh; the Rust
    // TokenResult already encodes failures as values, so that path is
    // unreachable by construction (log_warn/plugin_name remain on the trait
    // for wired implementations that can fail internally).

    if changed {
        // Patch back by index, never by accountId (gotcha 7).
        storage.accounts = accounts_copy;
        deps.save_accounts(&storage).await?;
    }
    Ok(Some(storage))
}

// =============================================================================
// Tests — ported from test/hydrate-emails.test.ts
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_core::schemas::token::TokenSuccess;
    use cma_testkit::sandbox::EnvSandbox;
    use serde_json::json;
    use serial_test::serial;
    use std::collections::HashMap;

    /// Minimal base64url (no padding) — no base64 dev-dependency here.
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

    #[derive(Default)]
    struct FakeDeps {
        refresh_by_token: HashMap<String, TokenResult>,
        refresh_calls: Vec<String>,
        saved: Option<AccountStorageV3>,
        warnings: Vec<String>,
    }

    impl HydrateEmailsDeps for FakeDeps {
        async fn queued_refresh(&mut self, refresh_token: &str) -> TokenResult {
            self.refresh_calls.push(refresh_token.to_string());
            self.refresh_by_token
                .get(refresh_token)
                .cloned()
                .unwrap_or(TokenResult::Failed(Default::default()))
        }
        async fn save_accounts(&mut self, storage: &AccountStorageV3) -> Result<(), CodexError> {
            self.saved = Some(storage.clone());
            Ok(())
        }
        fn log_warn(&mut self, message: &str) {
            self.warnings.push(message.to_string());
        }
        fn plugin_name(&self) -> &str {
            "codex-multi-auth"
        }
    }

    fn sandbox_without_skip() -> EnvSandbox {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("VITEST_WORKER_ID");
        sandbox.remove_var("NODE_ENV");
        sandbox.remove_var("CODEX_SKIP_EMAIL_HYDRATE");
        sandbox
    }

    #[tokio::test]
    #[serial(env)]
    async fn null_storage_passes_through() {
        let _sandbox = sandbox_without_skip();
        let mut deps = FakeDeps::default();
        assert_eq!(hydrate_runtime_emails(None, &mut deps).await.unwrap(), None);
        assert!(deps.refresh_calls.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn skip_env_gate_returns_storage_untouched() {
        let mut sandbox = sandbox_without_skip();
        sandbox.set_var("CODEX_SKIP_EMAIL_HYDRATE", "1");
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(AccountMetadataV3::new("rt-1", 1, 1));
        let mut deps = FakeDeps::default();
        let result = hydrate_runtime_emails(Some(storage.clone()), &mut deps)
            .await
            .unwrap();
        assert_eq!(result, Some(storage));
        assert!(deps.refresh_calls.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn hydrates_only_accounts_without_email_and_patches_by_index() {
        let _sandbox = sandbox_without_skip();
        let mut storage = AccountStorageV3::empty();
        // Two accounts WITHOUT email sharing accountId=None, plus one with.
        storage.accounts.push(AccountMetadataV3::new("rt-a", 1, 1));
        storage.accounts.push(AccountMetadataV3::new("rt-b", 1, 1));
        let mut with_email = AccountMetadataV3::new("rt-c", 1, 1);
        with_email.email = Some("kept@example.com".to_string());
        storage.accounts.push(with_email);

        let mut deps = FakeDeps::default();
        deps.refresh_by_token.insert(
            "rt-a".to_string(),
            TokenResult::Success(TokenSuccess {
                access: make_jwt("acc_a", "a@example.com"),
                refresh: "rt-a2".to_string(),
                expires: 2_000,
                id_token: None,
                multi_account: None,
            }),
        );
        deps.refresh_by_token.insert(
            "rt-b".to_string(),
            TokenResult::Success(TokenSuccess {
                access: make_jwt("acc_b", "b@example.com"),
                refresh: "rt-b".to_string(),
                expires: 3_000,
                id_token: None,
                multi_account: None,
            }),
        );

        let result = hydrate_runtime_emails(Some(storage), &mut deps)
            .await
            .unwrap()
            .expect("storage");

        // Only the two email-less accounts were refreshed.
        assert_eq!(deps.refresh_calls, vec!["rt-a", "rt-b"]);
        // Patched by index: each account received ITS OWN tokens.
        assert_eq!(result.accounts[0].email.as_deref(), Some("a@example.com"));
        assert_eq!(result.accounts[0].account_id.as_deref(), Some("acc_a"));
        assert_eq!(result.accounts[0].refresh_token, "rt-a2");
        assert_eq!(result.accounts[0].expires_at, Some(2_000));
        assert_eq!(result.accounts[1].email.as_deref(), Some("b@example.com"));
        assert_eq!(result.accounts[1].account_id.as_deref(), Some("acc_b"));
        assert_eq!(result.accounts[1].refresh_token, "rt-b");
        assert_eq!(result.accounts[2].email.as_deref(), Some("kept@example.com"));
        // Saved once.
        assert!(deps.saved.is_some());
    }

    #[tokio::test]
    #[serial(env)]
    async fn failed_refreshes_leave_storage_unsaved() {
        let _sandbox = sandbox_without_skip();
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(AccountMetadataV3::new("rt-a", 1, 1));
        let mut deps = FakeDeps::default();
        let result = hydrate_runtime_emails(Some(storage.clone()), &mut deps)
            .await
            .unwrap();
        assert_eq!(result, Some(storage));
        assert!(deps.saved.is_none());
    }

    #[tokio::test]
    #[serial(env)]
    async fn no_email_less_accounts_short_circuits() {
        let _sandbox = sandbox_without_skip();
        let mut storage = AccountStorageV3::empty();
        let mut account = AccountMetadataV3::new("rt-a", 1, 1);
        account.email = Some("x@example.com".to_string());
        storage.accounts.push(account);
        let mut deps = FakeDeps::default();
        let result = hydrate_runtime_emails(Some(storage.clone()), &mut deps)
            .await
            .unwrap();
        assert_eq!(result, Some(storage));
        assert!(deps.refresh_calls.is_empty());
    }
}
