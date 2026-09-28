//! Port of `lib/runtime/account-pool.ts` — `persistAccountPoolResults`:
//! folds OAuth login results into accounts.json inside ONE storage
//! transaction (spec 10 §17, workspace tracking #491/#512).
//!
//! DI absorption: the TS version injects `withAccountStorageTransaction`,
//! `findMatchingAccountIndex` and the token helpers for tests; the Rust port
//! calls `cma_storage` / `cma_core::token_utils` directly (tests run against
//! a sandboxed real storage path).

use cma_core::errors::CodexError;
use cma_core::model_family::MODEL_FAMILIES;
use cma_core::schemas::account_storage::{
    AccountIdSource, AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily, Workspace,
};
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_core::utils::now_ms;
use cma_storage::matching::{
    AccountMatchOptions, AccountSelectionCandidate, find_matching_account_index,
};
use cma_storage::transactions::with_account_storage_transaction;

use crate::account_selection::TokenSuccessWithAccount;

/// Initial `currentWorkspaceIndex` for a NEW account: the workspace whose
/// `id === accountId`, else the first with `enabled !== false`, else 0 —
/// only when workspaces are non-empty.
fn initial_workspace_index(
    workspaces: Option<&[Workspace]>,
    account_id: Option<&str>,
) -> Option<i64> {
    let workspaces = workspaces.filter(|w| !w.is_empty())?;
    if let Some(account_id) = account_id
        && let Some(matching) = workspaces.iter().position(|w| w.id == account_id)
    {
        return Some(matching as i64);
    }
    let first_enabled = workspaces.iter().position(|w| w.enabled);
    Some(first_enabled.unwrap_or(0) as i64)
}

/// Re-resolve `currentWorkspaceIndex` for an EXISTING account after a
/// workspace merge: previously-current id → `isDefault === true` → first
/// enabled → 0; empty merged list keeps the old index.
fn next_current_workspace_index(
    merged: Option<&[Workspace]>,
    current_workspace_id: Option<&str>,
    existing_index: Option<i64>,
) -> Option<i64> {
    let Some(merged) = merged.filter(|w| !w.is_empty()) else {
        return existing_index;
    };
    if let Some(current_id) = current_workspace_id
        && let Some(matching) = merged.iter().position(|w| w.id == current_id)
    {
        return Some(matching as i64);
    }
    if let Some(default_index) = merged.iter().position(|w| w.is_default == Some(true)) {
        return Some(default_index as i64);
    }
    let first_enabled = merged.iter().position(|w| w.enabled);
    Some(first_enabled.unwrap_or(0) as i64)
}

/// TS `persistAccountPoolResults({results, replaceAll, ...})`.
pub async fn persist_account_pool_results(
    results: &[TokenSuccessWithAccount],
    replace_all: bool,
) -> Result<(), CodexError> {
    if results.is_empty() {
        return Ok(());
    }

    let results = results.to_vec();
    with_account_storage_transaction(move |loaded_storage, persist| async move {
        let now = now_ms();
        let stored = if replace_all { None } else { loaded_storage };
        let mut accounts: Vec<AccountMetadataV3> = stored
            .as_ref()
            .map(|s| s.accounts.clone())
            .unwrap_or_default();

        for result in &results {
            let account_id = result
                .account_id_override
                .clone()
                .or_else(|| extract_account_id(Some(&result.tokens.access)));
            let account_id_source: Option<AccountIdSource> = if account_id.is_some() {
                result.account_id_source.or(Some(
                    if result.account_id_override.is_some() {
                        AccountIdSource::Manual
                    } else {
                        AccountIdSource::Token
                    },
                ))
            } else {
                None
            };
            let account_label = result.account_label.clone();
            let account_email = sanitize_email(
                extract_account_email(
                    Some(&result.tokens.access),
                    result.tokens.id_token.as_deref(),
                )
                .as_deref(),
            );

            let candidate = AccountSelectionCandidate {
                account_id: account_id.clone(),
                email: account_email.clone(),
                refresh_token: Some(result.tokens.refresh.clone()),
            };
            let existing_index = find_matching_account_index(
                &accounts,
                &candidate,
                AccountMatchOptions {
                    allow_unique_account_id_fallback_without_email: true,
                },
            );

            let Some(existing_index) = existing_index else {
                // New account.
                let current_workspace_index = initial_workspace_index(
                    result.workspaces.as_deref(),
                    account_id.as_deref(),
                );
                accounts.push(AccountMetadataV3 {
                    account_id,
                    account_id_source,
                    account_label,
                    email: account_email,
                    refresh_token: result.tokens.refresh.clone(),
                    access_token: Some(result.tokens.access.clone()),
                    expires_at: Some(result.tokens.expires),
                    enabled: None,
                    added_at: now,
                    last_used: now,
                    last_switch_reason: None,
                    rate_limit_reset_times: None,
                    cooling_down_until: None,
                    cooldown_reason: None,
                    workspaces: result.workspaces.clone(),
                    current_workspace_index,
                });
                continue;
            };

            let existing = accounts[existing_index].clone();

            let next_email = account_email.or_else(|| sanitize_email(existing.email.as_deref()));
            let next_account_id = account_id.clone().or_else(|| existing.account_id.clone());
            let next_account_id_source = if account_id.is_some() {
                account_id_source.or(existing.account_id_source)
            } else {
                existing.account_id_source
            };
            let next_account_label = account_label.or_else(|| existing.account_label.clone());

            // Workspace merge (#491/#512): the new list wins, but per-
            // workspace enabled/disabledAt carry over by id.
            let merged_workspaces: Option<Vec<Workspace>> = match result.workspaces.as_ref() {
                Some(new_workspaces) => Some(
                    new_workspaces
                        .iter()
                        .map(|new_ws| {
                            match existing
                                .workspaces
                                .as_ref()
                                .and_then(|old| old.iter().find(|w| w.id == new_ws.id))
                            {
                                Some(existing_ws) => Workspace {
                                    enabled: existing_ws.enabled,
                                    disabled_at: existing_ws.disabled_at,
                                    ..new_ws.clone()
                                },
                                None => new_ws.clone(),
                            }
                        })
                        .collect(),
                ),
                None => existing.workspaces.clone(),
            };

            let current_workspace_id: Option<String> = existing.workspaces.as_ref().and_then(
                |workspaces| {
                    let index = existing.current_workspace_index.unwrap_or(0);
                    usize::try_from(index)
                        .ok()
                        .and_then(|i| workspaces.get(i))
                        .map(|w| w.id.clone())
                },
            );
            let next_current_workspace_index = next_current_workspace_index(
                merged_workspaces.as_deref(),
                current_workspace_id.as_deref(),
                existing.current_workspace_index,
            );

            accounts[existing_index] = AccountMetadataV3 {
                account_id: next_account_id,
                account_id_source: next_account_id_source,
                account_label: next_account_label,
                email: next_email,
                refresh_token: result.tokens.refresh.clone(),
                access_token: Some(result.tokens.access.clone()),
                expires_at: Some(result.tokens.expires),
                last_used: now,
                workspaces: merged_workspaces,
                current_workspace_index: next_current_workspace_index,
                ..existing
            };
        }

        if accounts.is_empty() {
            return Ok(());
        }

        let active_index: i64 = if replace_all {
            0
        } else {
            stored.as_ref().map(|s| s.active_index).unwrap_or(0)
        };
        let clamped_active_index = active_index.clamp(0, accounts.len() as i64 - 1);

        let mut active_index_by_family = ActiveIndexByFamily::default();
        for family in MODEL_FAMILIES {
            let stored_family_index = stored
                .as_ref()
                .and_then(|s| s.active_index_by_family.as_ref())
                .and_then(|map| map.get(family));
            let raw_family_index = if replace_all {
                0
            } else {
                stored_family_index.unwrap_or(clamped_active_index)
            };
            active_index_by_family.set(
                family,
                Some(raw_family_index.clamp(0, accounts.len() as i64 - 1)),
            );
        }

        persist
            .persist(&AccountStorageV3 {
                version: Default::default(),
                accounts,
                active_index: clamped_active_index,
                active_index_by_family: Some(active_index_by_family),
                pinned_account_index: None,
                affinity_generation: None,
            })
            .await
    })
    .await
}

// =============================================================================
// Tests — ported from test/account-pool.test.ts (fold semantics)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::TokenSuccess;
    use cma_testkit::sandbox::EnvSandbox;
    use serde_json::json;
    use serial_test::serial;

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

    fn result_for(account_id: &str, email: &str, refresh: &str) -> TokenSuccessWithAccount {
        TokenSuccessWithAccount::plain(TokenSuccess {
            access: make_jwt(account_id, email),
            refresh: refresh.to_string(),
            expires: 9_999_999_999_999,
            id_token: None,
            multi_account: None,
        })
    }

    async fn load_storage() -> AccountStorageV3 {
        cma_storage::load::load_accounts()
            .await
            .expect("storage present")
            .storage
    }

    #[tokio::test]
    #[serial(env)]
    async fn empty_results_are_a_no_op() {
        let _sandbox = EnvSandbox::new();
        persist_account_pool_results(&[], false).await.unwrap();
        // No transaction ran → no accounts file was ever written.
        let path = cma_storage::facade::get_storage_path();
        assert!(!std::path::Path::new(&path).exists(), "unexpected write: {path}");
    }

    #[tokio::test]
    #[serial(env)]
    async fn inserts_new_accounts_and_seeds_family_indexes() {
        let _sandbox = EnvSandbox::new();
        let results = vec![
            result_for("acc_alpha", "a@example.com", "rt-a"),
            result_for("acc_beta", "b@example.com", "rt-b"),
        ];
        persist_account_pool_results(&results, false).await.unwrap();

        let storage = load_storage().await;
        assert_eq!(storage.accounts.len(), 2);
        assert_eq!(storage.accounts[0].email.as_deref(), Some("a@example.com"));
        assert_eq!(storage.accounts[0].account_id.as_deref(), Some("acc_alpha"));
        assert_eq!(
            storage.accounts[0].account_id_source,
            Some(AccountIdSource::Token)
        );
        assert_eq!(storage.active_index, 0);
        let by_family = storage.active_index_by_family.as_ref().expect("families");
        for (_, value) in by_family.iter() {
            assert_eq!(value, Some(0));
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn updates_existing_account_by_identity_and_keeps_fallbacks() {
        let _sandbox = EnvSandbox::new();
        let mut first = result_for("acc_alpha", "a@example.com", "rt-old");
        first.account_label = Some("Alpha".to_string());
        persist_account_pool_results(&[first], false).await.unwrap();

        // Same identity, new refresh token, no label → label falls back.
        let update = result_for("acc_alpha", "a@example.com", "rt-new");
        persist_account_pool_results(&[update], false).await.unwrap();

        let storage = load_storage().await;
        assert_eq!(storage.accounts.len(), 1);
        assert_eq!(storage.accounts[0].refresh_token, "rt-new");
        assert_eq!(storage.accounts[0].account_label.as_deref(), Some("Alpha"));
    }

    #[tokio::test]
    #[serial(env)]
    async fn replace_all_resets_pool_and_indexes() {
        let _sandbox = EnvSandbox::new();
        let results = vec![
            result_for("acc_alpha", "a@example.com", "rt-a"),
            result_for("acc_beta", "b@example.com", "rt-b"),
        ];
        persist_account_pool_results(&results, false).await.unwrap();

        let replacement = vec![result_for("acc_gamma", "c@example.com", "rt-c")];
        persist_account_pool_results(&replacement, true).await.unwrap();

        let storage = load_storage().await;
        assert_eq!(storage.accounts.len(), 1);
        assert_eq!(storage.accounts[0].account_id.as_deref(), Some("acc_gamma"));
        assert_eq!(storage.active_index, 0);
    }

    #[tokio::test]
    #[serial(env)]
    async fn workspace_merge_carries_enabled_state_and_recomputes_index() {
        let _sandbox = EnvSandbox::new();
        let mut first = result_for("acc_ws", "w@example.com", "rt-w");
        first.workspaces = Some(vec![
            Workspace {
                id: "ws-1".into(),
                name: Some("One".into()),
                enabled: true,
                disabled_at: None,
                is_default: None,
            },
            Workspace {
                id: "acc_ws".into(),
                name: Some("Personal".into()),
                enabled: true,
                disabled_at: None,
                is_default: Some(true),
            },
        ]);
        persist_account_pool_results(&[first], false).await.unwrap();

        let storage = load_storage().await;
        // New account: currentWorkspaceIndex = workspace whose id == accountId.
        assert_eq!(storage.accounts[0].current_workspace_index, Some(1));

        // Disable ws-1 on disk, then re-login with a fresh list: enabled
        // carries over by id, and the previously-current workspace id keeps
        // the index pointing at it.
        let mut mutated = storage.clone();
        if let Some(workspaces) = mutated.accounts[0].workspaces.as_mut() {
            workspaces[0].enabled = false;
            workspaces[0].disabled_at = Some(123);
        }
        cma_storage::save::save_accounts(&mutated).await.unwrap();

        let mut second = result_for("acc_ws", "w@example.com", "rt-w");
        second.workspaces = Some(vec![
            Workspace {
                id: "acc_ws".into(),
                name: Some("Personal".into()),
                enabled: true,
                disabled_at: None,
                is_default: Some(true),
            },
            Workspace {
                id: "ws-1".into(),
                name: Some("One (renamed)".into()),
                enabled: true,
                disabled_at: None,
                is_default: None,
            },
        ]);
        persist_account_pool_results(&[second], false).await.unwrap();

        let storage = load_storage().await;
        let account = &storage.accounts[0];
        let workspaces = account.workspaces.as_ref().expect("workspaces");
        assert_eq!(workspaces.len(), 2);
        // ws-1 kept its disabled state despite the new list saying enabled.
        let ws1 = workspaces.iter().find(|w| w.id == "ws-1").unwrap();
        assert!(!ws1.enabled);
        assert_eq!(ws1.disabled_at, Some(123));
        assert_eq!(ws1.name.as_deref(), Some("One (renamed)"));
        // Previously-current workspace (acc_ws) followed to its new position.
        assert_eq!(account.current_workspace_index, Some(0));
    }
}
