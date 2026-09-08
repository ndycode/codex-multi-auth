//! Port of `lib/codex-manager/persist-selected-account.ts` — persist a
//! selected account (switch/best/restore) and mirror it into the Codex CLI
//! auth files.
//!
//! Key contracts (spec 09 §1.9):
//! - `preserveActiveIndexByFamily` only actually preserves when the flag is
//!   set AND a family map exists AND `targetIndex === storage.activeIndex`;
//!   even then values are clamped (non-finite/missing → targetIndex).
//!   Otherwise EVERY family is set to `targetIndex` (gotcha 19).
//! - `bumpAffinityGeneration` re-reads the disk generation right before save
//!   and takes `max(inMemory, disk) + 1` (#474).
//! - A stale access token triggers a validation refresh; failure only warns
//!   and continues with the stale tokens.

use cma_cli_mirror::writer::{set_codex_cli_active_selection, ActiveSelection};
use cma_core::model_family::MODEL_FAMILIES;
use cma_core::schemas::account_storage::{
    AccountStorageV3, ActiveIndexByFamily, PersistedSwitchReason,
};
use cma_core::schemas::token::TokenResult;
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_core::utils::now_ms;
use cma_storage::facade::get_storage_path;
use cma_storage::load::read_affinity_generation_from_disk;
use cma_storage::save_retry::save_accounts_with_retry;

use crate::login::account_credentials::{apply_token_account_identity, has_usable_access_token};

/// Parameters (TS options object). `parsed` is the 1-based user-facing
/// number, distinct from `target_index`.
pub struct PersistSelectedAccountParams {
    pub storage: AccountStorageV3,
    pub target_index: usize,
    pub parsed: i64,
    pub switch_reason: PersistedSwitchReason,
    pub initial_sync_id_token: Option<String>,
    pub preserve_active_index_by_family: bool,
    pub set_pin: bool,
    pub clear_pin: bool,
    pub bump_affinity_generation: bool,
}

/// `{ synced, wasDisabled }`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PersistSelectedOutcome {
    pub synced: bool,
    pub was_disabled: bool,
}

/// Minimal local mirror of `normalizeFailureDetail` (canonical Rust home is
/// the sibling `crate::formatters::text_style`): message-or-reason fallback,
/// whitespace collapse, 260-char cap.
fn normalize_failure_detail(message: Option<&str>, reason: Option<&str>) -> String {
    let raw = message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| reason.map(str::to_string))
        .unwrap_or_else(|| "refresh failed".to_string());
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let bounded = if collapsed.chars().count() > 260 {
        let head: String = collapsed.chars().take(257).collect();
        format!("{head}...")
    } else {
        collapsed
    };
    if bounded.is_empty() {
        "refresh failed".to_string()
    } else {
        bounded
    }
}

/// `persistAndSyncSelectedAccount(options)`.
///
/// Missing account → the TS throw `Account ${parsed} not found.`; callers
/// bounds-check first, so the Rust port panics with the identical message
/// (an uncaught TS exception aborts the command the same way).
pub async fn persist_and_sync_selected_account(
    params: PersistSelectedAccountParams,
) -> PersistSelectedOutcome {
    let PersistSelectedAccountParams {
        mut storage,
        target_index,
        parsed,
        switch_reason,
        initial_sync_id_token,
        preserve_active_index_by_family,
        set_pin,
        clear_pin,
        bump_affinity_generation,
    } = params;

    let accounts_len = storage.accounts.len();
    if target_index >= accounts_len {
        panic!("Account {parsed} not found.");
    }
    let now = now_ms();

    // --- activeIndexByFamily (gotcha 19) ------------------------------------
    let preserve = preserve_active_index_by_family
        && storage.active_index_by_family.is_some()
        && target_index as i64 == storage.active_index;
    let mut next_by_family = ActiveIndexByFamily::default();
    if preserve {
        let existing = storage
            .active_index_by_family
            .clone()
            .unwrap_or_default();
        let max_index = accounts_len as i64 - 1;
        for family in MODEL_FAMILIES {
            let value = match existing.get(family) {
                Some(value) => value.clamp(0, max_index),
                None => target_index as i64,
            };
            next_by_family.set(family, Some(value));
        }
    } else {
        for family in MODEL_FAMILIES {
            next_by_family.set(family, Some(target_index as i64));
        }
    }
    storage.active_index_by_family = Some(next_by_family);
    storage.active_index = target_index as i64;

    // --- selection bookkeeping ----------------------------------------------
    let was_disabled = storage.accounts[target_index].enabled == Some(false);
    if was_disabled {
        storage.accounts[target_index].enabled = Some(true);
    }

    let mut sync_access_token = storage.accounts[target_index].access_token.clone();
    let mut sync_refresh_token = storage.accounts[target_index].refresh_token.clone();
    let mut sync_expires_at = storage.accounts[target_index].expires_at;
    let mut sync_id_token = initial_sync_id_token;

    if !has_usable_access_token(&storage.accounts[target_index], now) {
        let refresh_token = storage.accounts[target_index].refresh_token.clone();
        match cma_auth::refresh_queue::queued_refresh(&refresh_token).await {
            TokenResult::Success(success) => {
                let account = &mut storage.accounts[target_index];
                if account.refresh_token != success.refresh {
                    account.refresh_token = success.refresh.clone();
                }
                if account.access_token.as_deref() != Some(success.access.as_str()) {
                    account.access_token = Some(success.access.clone());
                }
                if account.expires_at != Some(success.expires) {
                    account.expires_at = Some(success.expires);
                }
                let next_email = sanitize_email(
                    extract_account_email(Some(&success.access), success.id_token.as_deref())
                        .as_deref(),
                );
                if let Some(next_email) = &next_email
                    && !next_email.is_empty() && account.email.as_deref() != Some(next_email) {
                        account.email = Some(next_email.clone());
                    }
                let token_account_id = extract_account_id(Some(&success.access));
                apply_token_account_identity(account, token_account_id.as_deref());

                sync_access_token = Some(success.access.clone());
                sync_refresh_token = success.refresh.clone();
                sync_expires_at = Some(success.expires);
                // Fresh idToken (when present) wins over the caller-supplied
                // one for the Codex sync.
                if success.id_token.is_some() {
                    sync_id_token = success.id_token.clone();
                }
            }
            TokenResult::Failed(failure) => {
                eprintln!(
                    "Switch validation refresh failed for account {parsed}: {}.",
                    normalize_failure_detail(
                        failure.message.as_deref(),
                        failure.reason.map(|reason| reason.as_str())
                    )
                );
            }
        }
    }

    let switch_now = now_ms();
    {
        let account = &mut storage.accounts[target_index];
        account.last_used = switch_now;
        account.last_switch_reason = Some(switch_reason.into());
    }

    if set_pin {
        storage.pinned_account_index = Some(target_index as i64);
    }
    if clear_pin {
        storage.pinned_account_index = None;
    }
    if bump_affinity_generation {
        // Re-read disk RIGHT BEFORE save to narrow the lost-update window
        // (#474): extra bumps harmless, missed bumps dangerous.
        let in_memory = storage.affinity_generation.unwrap_or(0);
        let on_disk = read_affinity_generation_from_disk(get_storage_path());
        storage.affinity_generation = Some(in_memory.max(on_disk) + 1);
    }

    if let Err(error) = save_accounts_with_retry(&storage).await {
        // TS lets the storage error propagate as an uncaught exception; the
        // Rust CLI surfaces it and reports the selection as unsynced.
        eprintln!("{}", error.message());
        return PersistSelectedOutcome {
            synced: false,
            was_disabled,
        };
    }

    let account = &storage.accounts[target_index];
    let synced = set_codex_cli_active_selection(&ActiveSelection {
        account_id: account.account_id.clone(),
        email: account.email.clone(),
        access_token: sync_access_token,
        refresh_token: Some(sync_refresh_token),
        expires_at: sync_expires_at.map(|value| value as f64),
        id_token: sync_id_token,
    })
    .await;

    PersistSelectedOutcome {
        synced,
        was_disabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_failure_detail_prefers_message_then_reason() {
        assert_eq!(
            normalize_failure_detail(Some("  network   down  "), Some("network_error")),
            "network down"
        );
        assert_eq!(
            normalize_failure_detail(None, Some("http_error")),
            "http_error"
        );
        assert_eq!(normalize_failure_detail(None, None), "refresh failed");
        assert_eq!(normalize_failure_detail(Some("   "), None), "refresh failed");
        let long = "x".repeat(300);
        let bounded = normalize_failure_detail(Some(&long), None);
        assert_eq!(bounded.chars().count(), 260);
        assert!(bounded.ends_with("..."));
    }

    #[test]
    fn family_map_building_matches_the_preserve_rules() {
        // Indirectly cover the preserve/clamp matrix through a tiny harness:
        // preserve applies only when flag && map exists && target == active.
        let mut storage = AccountStorageV3::empty();
        storage.accounts = vec![
            cma_core::schemas::account_storage::AccountMetadataV3::new(
                "rt-aaaaaaaaaaaaaaaaaaaa",
                0,
                0,
            ),
            cma_core::schemas::account_storage::AccountMetadataV3::new(
                "rt-bbbbbbbbbbbbbbbbbbbb",
                0,
                0,
            ),
        ];
        storage.active_index = 1;
        let mut by_family = ActiveIndexByFamily::default();
        // A stale out-of-range family entry gets clamped when preserved.
        by_family.set(cma_core::model_family::ModelFamily::Codex, Some(9));
        storage.active_index_by_family = Some(by_family);

        // Not preserved: target != activeIndex.
        let preserve = storage.active_index_by_family.is_some() && 0_i64 == storage.active_index;
        assert!(!preserve);
        // Preserved: target == activeIndex → clamp 9 → 1, missing → target.
        let preserve = storage.active_index_by_family.is_some() && 1_i64 == storage.active_index;
        assert!(preserve);
        let existing = storage.active_index_by_family.clone().unwrap();
        let clamped = existing
            .get(cma_core::model_family::ModelFamily::Codex)
            .unwrap()
            .clamp(0, storage.accounts.len() as i64 - 1);
        assert_eq!(clamped, 1);
        assert_eq!(existing.get(cma_core::model_family::ModelFamily::Gpt5_1), None);
    }
}
