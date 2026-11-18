//! Port of `lib/runtime/account-selection.ts` (+ absorbed
//! `lib/runtime/account-select-event.ts`) — login-time account selection and
//! the FIFO-serialized `account.select` event mutation (spec 10 §18–19).
//!
//! Type note (spec 10 gotcha 18): TS has TWO distinct `TokenSuccessWithAccount`
//! types with the same name — a generic one here and a concrete one in
//! `account-pool.ts`. The Rust port unifies them into the single concrete
//! [`TokenSuccessWithAccount`] below (over `cma_core` `TokenSuccess`, which
//! already carries `idToken`/`multiAccount`).

use cma_core::errors::CodexError;
use cma_core::model_family::{MODEL_FAMILIES, ModelFamily};
use cma_core::schemas::account_storage::{
    AccountIdSource, AccountStorageV3, SwitchReason, Workspace,
};
use cma_core::schemas::token::TokenSuccess;
use cma_core::token_utils::{
    AccountIdCandidate, get_account_id_candidates, select_best_account_candidate,
};
use cma_core::utils::now_ms;
use serde_json::Value;

/// TS `TokenSuccessWithAccount` — a successful token exchange plus the
/// account-identity extras resolved at login time.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenSuccessWithAccount {
    pub tokens: TokenSuccess,
    pub account_id_override: Option<String>,
    pub account_id_source: Option<AccountIdSource>,
    pub account_label: Option<String>,
    pub workspaces: Option<Vec<Workspace>>,
}

impl TokenSuccessWithAccount {
    /// Wrap plain tokens with no extras (the TS "return tokens untouched"
    /// arm).
    pub fn plain(tokens: TokenSuccess) -> Self {
        Self {
            tokens,
            account_id_override: None,
            account_id_source: None,
            account_label: None,
            workspaces: None,
        }
    }
}

/// Dependencies for [`resolve_account_selection`].
///
/// The TS version also injects `getAccountIdCandidates` /
/// `selectBestAccountCandidate`; those are pure functions in
/// `cma_core::token_utils` and are called directly (DI-shim absorption per
/// the architecture).
pub struct ResolveAccountSelectionDeps<'a> {
    /// Caller passes `process.env.CODEX_AUTH_ACCOUNT_ID`.
    pub env_account_id: Option<String>,
    pub log_info: &'a mut dyn FnMut(&str),
}

/// TS `resolveAccountSelection(tokens, deps)`.
pub fn resolve_account_selection(
    tokens: TokenSuccess,
    deps: &mut ResolveAccountSelectionDeps<'_>,
) -> TokenSuccessWithAccount {
    let override_id = deps
        .env_account_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if !override_id.is_empty() {
        let suffix: String = if override_id.chars().count() > 6 {
            let chars: Vec<char> = override_id.chars().collect();
            chars[chars.len() - 6..].iter().collect()
        } else {
            override_id.clone()
        };
        (deps.log_info)(&format!(
            "Using account override from CODEX_AUTH_ACCOUNT_ID (id:{suffix})."
        ));
        return TokenSuccessWithAccount {
            account_id_override: Some(override_id),
            account_id_source: Some(AccountIdSource::Manual),
            account_label: Some(format!("Override [id:{suffix}]")),
            workspaces: None,
            tokens,
        };
    }

    let candidates = get_account_id_candidates(Some(&tokens.access), tokens.id_token.as_deref());
    if candidates.is_empty() {
        return TokenSuccessWithAccount::plain(tokens);
    }

    let workspaces: Vec<Workspace> = candidates
        .iter()
        .map(|candidate| Workspace {
            id: candidate.account_id.clone(),
            name: Some(candidate.label.clone()),
            enabled: true,
            disabled_at: None,
            is_default: candidate.is_default,
        })
        .collect();

    if candidates.len() == 1 {
        let candidate = &candidates[0];
        return TokenSuccessWithAccount {
            account_id_override: Some(candidate.account_id.clone()),
            account_id_source: Some(candidate.source),
            account_label: Some(candidate.label.clone()),
            workspaces: Some(workspaces),
            tokens,
        };
    }

    let Some(choice) = select_best_account_candidate(&candidates) else {
        return TokenSuccessWithAccount::plain(tokens);
    };
    let choice: AccountIdCandidate = choice.clone();

    TokenSuccessWithAccount {
        account_id_override: Some(choice.account_id),
        account_id_source: Some(choice.source),
        account_label: Some(choice.label),
        workspaces: Some(workspaces),
        tokens,
    }
}

/// Runtime wiring: env `CODEX_AUTH_ACCOUNT_ID` + core candidate helpers
/// (the closure the TS manual-oauth-flow overload builds).
pub fn resolve_account_selection_runtime(
    tokens: TokenSuccess,
    log_info: &mut dyn FnMut(&str),
) -> TokenSuccessWithAccount {
    let env_account_id = std::env::var("CODEX_AUTH_ACCOUNT_ID").ok();
    resolve_account_selection(
        tokens,
        &mut ResolveAccountSelectionDeps {
            env_account_id,
            log_info,
        },
    )
}

// =============================================================================
// account-select-event.ts — FIFO-serialized select-event mutation
// =============================================================================

/// The runtime event shape (`{type, properties?}`).
#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeEvent {
    pub event_type: String,
    pub properties: Option<Value>,
}

/// Dependencies of [`handle_account_select_event`] (the TS `input` object
/// minus the event itself).
#[allow(async_fn_in_trait)]
pub trait AccountSelectEventDeps {
    fn provider_id(&self) -> &str;
    async fn load_accounts(&mut self) -> Result<Option<AccountStorageV3>, CodexError>;
    async fn save_accounts(&mut self, storage: &AccountStorageV3) -> Result<(), CodexError>;
    fn model_families(&self) -> &[ModelFamily] {
        &MODEL_FAMILIES
    }
    /// TS `getCachedAccountManager() !== null`.
    fn has_cached_account_manager(&self) -> bool;
    async fn sync_codex_cli_active_selection_for_index(
        &mut self,
        index: usize,
    ) -> Result<(), CodexError>;
    fn set_last_codex_cli_active_sync_index(&mut self, index: usize);
    async fn reload_account_manager_from_disk(&mut self) -> Result<(), CodexError>;
    async fn show_toast(&mut self, message: &str, variant: &str) -> Result<(), CodexError>;
}

/// Module-level FIFO write queue (TS `serializeAccountSelectMutation`) —
/// concurrent select events must not interleave load-modify-save.
static ACCOUNT_SELECT_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn event_index(properties: Option<&Value>) -> IndexOutcome {
    let Some(props) = properties.filter(|p| p.is_object()) else {
        // Non-object properties behave like `{}` → rawIndex undefined.
        return IndexOutcome::NotInteger;
    };
    // `props.index ?? props.accountIndex` — null/undefined fall through.
    let raw = match props.get("index").filter(|v| !v.is_null()) {
        Some(value) => Some(value),
        None => props.get("accountIndex").filter(|v| !v.is_null()),
    };
    let Some(raw) = raw else {
        return IndexOutcome::NotInteger;
    };
    // `Number.isInteger(rawIndex)` — a JSON number with an integral value.
    match raw.as_f64() {
        Some(v) if v.is_finite() && v.fract() == 0.0 => IndexOutcome::Index(v as i64),
        _ => IndexOutcome::NotInteger,
    }
}

enum IndexOutcome {
    Index(i64),
    NotInteger,
}

/// TS `handleAccountSelectEvent(input)` — `Ok(true)` = event consumed.
pub async fn handle_account_select_event<D: AccountSelectEventDeps>(
    event: &RuntimeEvent,
    deps: &mut D,
) -> Result<bool, CodexError> {
    if event.event_type != "account.select" && event.event_type != "openai.account.select" {
        return Ok(false);
    }

    let props = event.properties.as_ref();
    let provider = props
        .and_then(|p| p.get("provider"))
        .and_then(Value::as_str);
    if let Some(provider) = provider
        && provider != "openai"
        && provider != deps.provider_id()
    {
        return Ok(false);
    }

    let index = match event_index(props) {
        // Bad index → consumed (true) without mutation (gotcha 21).
        IndexOutcome::NotInteger => return Ok(true),
        IndexOutcome::Index(index) => index,
    };

    let _guard = ACCOUNT_SELECT_QUEUE.lock().await;

    let Some(mut storage) = deps.load_accounts().await? else {
        return Ok(true);
    };
    if index < 0 || index as usize >= storage.accounts.len() {
        return Ok(true);
    }
    let index = index as usize;

    let now = now_ms();
    if let Some(account) = storage.accounts.get_mut(index) {
        account.last_used = now;
        account.last_switch_reason = Some(SwitchReason::Rotation);
    }
    storage.active_index = index as i64;
    let mut by_family = storage.active_index_by_family.take().unwrap_or_default();
    for family in deps.model_families() {
        by_family.set(*family, Some(index as i64));
    }
    storage.active_index_by_family = Some(by_family);

    deps.save_accounts(&storage).await?;

    if deps.has_cached_account_manager() {
        deps.sync_codex_cli_active_selection_for_index(index).await?;
    }
    deps.set_last_codex_cli_active_sync_index(index);

    if deps.has_cached_account_manager() {
        deps.reload_account_manager_from_disk().await?;
    }

    deps.show_toast(&format!("Switched to account {}", index + 1), "info")
        .await?;
    Ok(true)
}

// =============================================================================
// Tests — ported from test/account-selection.test.ts +
// test/account-select-event.test.ts (highest-value assertions)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn make_jwt(payload: &Value) -> String {
        let header = b64url(br#"{"alg":"none"}"#);
        let body = b64url(&serde_json::to_vec(payload).unwrap());
        format!("{header}.{body}.sig")
    }

    fn tokens_with_account(account_id: &str) -> TokenSuccess {
        let access = make_jwt(&json!({
            "https://api.openai.com/auth": {"chatgpt_account_id": account_id}
        }));
        TokenSuccess {
            access,
            refresh: "rt".to_string(),
            expires: 9_999_999_999_999,
            id_token: None,
            multi_account: None,
        }
    }

    fn plain_tokens() -> TokenSuccess {
        TokenSuccess {
            access: "not-a-jwt".to_string(),
            refresh: "rt".to_string(),
            expires: 9_999_999_999_999,
            id_token: None,
            multi_account: None,
        }
    }

    #[test]
    fn env_override_wins_and_logs_suffix() {
        let mut logged = Vec::new();
        let mut log = |m: &str| logged.push(m.to_string());
        let result = resolve_account_selection(
            plain_tokens(),
            &mut ResolveAccountSelectionDeps {
                env_account_id: Some("  acc_1234567890  ".to_string()),
                log_info: &mut log,
            },
        );
        assert_eq!(result.account_id_override.as_deref(), Some("acc_1234567890"));
        assert_eq!(result.account_id_source, Some(AccountIdSource::Manual));
        assert_eq!(result.account_label.as_deref(), Some("Override [id:567890]"));
        assert!(result.workspaces.is_none());
        assert_eq!(
            logged,
            vec!["Using account override from CODEX_AUTH_ACCOUNT_ID (id:567890)."]
        );

        // Short override uses the whole id as suffix.
        let mut log = |_: &str| {};
        let result = resolve_account_selection(
            plain_tokens(),
            &mut ResolveAccountSelectionDeps {
                env_account_id: Some("abc".to_string()),
                log_info: &mut log,
            },
        );
        assert_eq!(result.account_label.as_deref(), Some("Override [id:abc]"));
    }

    #[test]
    fn no_candidates_returns_tokens_untouched() {
        let mut log = |_: &str| {};
        let result = resolve_account_selection(
            plain_tokens(),
            &mut ResolveAccountSelectionDeps {
                env_account_id: None,
                log_info: &mut log,
            },
        );
        assert_eq!(result, TokenSuccessWithAccount::plain(plain_tokens()));
    }

    #[test]
    fn single_candidate_selected_with_workspaces() {
        let mut log = |_: &str| {};
        let result = resolve_account_selection(
            tokens_with_account("acc_workspace1"),
            &mut ResolveAccountSelectionDeps {
                env_account_id: None,
                log_info: &mut log,
            },
        );
        assert_eq!(result.account_id_override.as_deref(), Some("acc_workspace1"));
        assert_eq!(result.account_id_source, Some(AccountIdSource::Token));
        let workspaces = result.workspaces.expect("workspaces");
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].id, "acc_workspace1");
        assert!(workspaces[0].enabled);
    }

    // ---- account-select-event ----

    struct FakeDeps {
        storage: Option<AccountStorageV3>,
        saved: Option<AccountStorageV3>,
        has_manager: bool,
        synced: Vec<usize>,
        last_sync_index: Option<usize>,
        reloads: usize,
        toasts: Vec<(String, String)>,
    }

    impl FakeDeps {
        fn with_accounts(count: usize) -> Self {
            let mut storage = AccountStorageV3::empty();
            for i in 0..count {
                storage.accounts.push(
                    cma_core::schemas::account_storage::AccountMetadataV3::new(
                        format!("rt-{i}"),
                        1,
                        1,
                    ),
                );
            }
            Self {
                storage: Some(storage),
                saved: None,
                has_manager: true,
                synced: Vec::new(),
                last_sync_index: None,
                reloads: 0,
                toasts: Vec::new(),
            }
        }
    }

    impl AccountSelectEventDeps for FakeDeps {
        fn provider_id(&self) -> &str {
            "custom-provider"
        }
        async fn load_accounts(&mut self) -> Result<Option<AccountStorageV3>, CodexError> {
            Ok(self.storage.clone())
        }
        async fn save_accounts(&mut self, storage: &AccountStorageV3) -> Result<(), CodexError> {
            self.saved = Some(storage.clone());
            Ok(())
        }
        fn has_cached_account_manager(&self) -> bool {
            self.has_manager
        }
        async fn sync_codex_cli_active_selection_for_index(
            &mut self,
            index: usize,
        ) -> Result<(), CodexError> {
            self.synced.push(index);
            Ok(())
        }
        fn set_last_codex_cli_active_sync_index(&mut self, index: usize) {
            self.last_sync_index = Some(index);
        }
        async fn reload_account_manager_from_disk(&mut self) -> Result<(), CodexError> {
            self.reloads += 1;
            Ok(())
        }
        async fn show_toast(&mut self, message: &str, variant: &str) -> Result<(), CodexError> {
            self.toasts.push((message.to_string(), variant.to_string()));
            Ok(())
        }
    }

    fn event(event_type: &str, properties: Value) -> RuntimeEvent {
        RuntimeEvent {
            event_type: event_type.to_string(),
            properties: Some(properties),
        }
    }

    #[tokio::test]
    async fn ignores_unknown_event_types_and_foreign_providers() {
        let mut deps = FakeDeps::with_accounts(2);
        let consumed = handle_account_select_event(
            &event("other.event", json!({"index": 1})),
            &mut deps,
        )
        .await
        .unwrap();
        assert!(!consumed);

        let consumed = handle_account_select_event(
            &event("account.select", json!({"index": 1, "provider": "anthropic"})),
            &mut deps,
        )
        .await
        .unwrap();
        assert!(!consumed);
        assert!(deps.saved.is_none());

        // Matching custom provider id is accepted.
        let consumed = handle_account_select_event(
            &event(
                "account.select",
                json!({"index": 1, "provider": "custom-provider"}),
            ),
            &mut deps,
        )
        .await
        .unwrap();
        assert!(consumed);
        assert!(deps.saved.is_some());
    }

    #[tokio::test]
    async fn bad_index_consumes_without_mutation() {
        let mut deps = FakeDeps::with_accounts(2);
        for props in [
            json!({}),
            json!({"index": "1"}),
            json!({"index": 1.5}),
            json!({"index": null}),
        ] {
            let consumed =
                handle_account_select_event(&event("account.select", props), &mut deps)
                    .await
                    .unwrap();
            assert!(consumed);
        }
        // Out of range → consumed, no save.
        let consumed = handle_account_select_event(
            &event("openai.account.select", json!({"index": 9})),
            &mut deps,
        )
        .await
        .unwrap();
        assert!(consumed);
        assert!(deps.saved.is_none());
        assert!(deps.toasts.is_empty());
    }

    #[tokio::test]
    async fn valid_select_mutates_saves_syncs_and_toasts() {
        let mut deps = FakeDeps::with_accounts(3);
        let consumed = handle_account_select_event(
            &event("account.select", json!({"accountIndex": 1, "provider": "openai"})),
            &mut deps,
        )
        .await
        .unwrap();
        assert!(consumed);

        let saved = deps.saved.as_ref().expect("saved");
        assert_eq!(saved.active_index, 1);
        let by_family = saved.active_index_by_family.as_ref().expect("families");
        for (family, value) in by_family.iter() {
            assert_eq!(value, Some(1), "family {family:?}");
        }
        assert_eq!(
            saved.accounts[1].last_switch_reason,
            Some(SwitchReason::Rotation)
        );
        assert_eq!(deps.synced, vec![1]);
        assert_eq!(deps.last_sync_index, Some(1));
        assert_eq!(deps.reloads, 1);
        assert_eq!(
            deps.toasts,
            vec![("Switched to account 2".to_string(), "info".to_string())]
        );
    }

    #[tokio::test]
    async fn no_cached_manager_skips_sync_and_reload() {
        let mut deps = FakeDeps::with_accounts(2);
        deps.has_manager = false;
        let consumed = handle_account_select_event(
            &event("account.select", json!({"index": 0})),
            &mut deps,
        )
        .await
        .unwrap();
        assert!(consumed);
        assert!(deps.synced.is_empty());
        assert_eq!(deps.reloads, 0);
        // setLastCodexCliActiveSyncIndex still always fires.
        assert_eq!(deps.last_sync_index, Some(0));
    }
}
