//! Port of `lib/codex-manager/account-pool-write.ts` — the pure pool-fold
//! logic behind `persistAccountPool` (issues #512/#491).
//!
//! - `inserted`: a brand new saved entry was appended.
//! - `updated`: an existing entry was refreshed with no previously-unknown
//!   workspace introduced (first-time workspace enrichment of a pre-#491 row
//!   included).
//! - `rebound`: an existing entry gained ≥1 workspace id it was not tracking
//!   before.

use cma_core::schemas::account_storage::{AccountIdSource, AccountMetadataV3, Workspace};

/// `AccountPoolWriteOutcome`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountPoolWriteOutcome {
    Inserted,
    Updated,
    Rebound,
}

impl AccountPoolWriteOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inserted => "inserted",
            Self::Updated => "updated",
            Self::Rebound => "rebound",
        }
    }
}

/// `ResolvedAccountWrite` — identity/token fields resolved from a login
/// result, ready to fold into the saved pool.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResolvedAccountWrite {
    pub account_id: Option<String>,
    pub account_id_source: Option<AccountIdSource>,
    pub account_label: Option<String>,
    pub email: Option<String>,
    pub refresh_token: String,
    pub access_token: Option<String>,
    pub expires_at: Option<i64>,
    pub workspaces: Option<Vec<Workspace>>,
    pub now: i64,
}

/// Identity triple handed to the injected matcher.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PoolWriteIdentity {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub refresh_token: Option<String>,
}

/// Injected `findMatchingAccountIndex(accounts, identity, {allowUnique...:true})`.
pub type FindMatchingAccountIndexFn<'a> =
    &'a dyn Fn(&[AccountMetadataV3], &PoolWriteIdentity) -> Option<usize>;

/// `pickInitialWorkspaceIndex(workspaces, accountId)` — prefer the workspace
/// whose id matches the resolved accountId, else the first enabled workspace,
/// else index 0.
pub fn pick_initial_workspace_index(
    workspaces: &[Workspace],
    account_id: Option<&str>,
) -> usize {
    if let Some(account_id) = account_id
        && let Some(matching) = workspaces.iter().position(|ws| ws.id == account_id) {
            return matching;
        }
    workspaces.iter().position(|ws| ws.enabled).unwrap_or(0)
}

/// `mergeAccountWorkspaces(existing, incoming)` — `incoming == None` keeps
/// the existing list untouched; otherwise map the incoming list, carrying
/// over the user's `enabled`/`disabledAt` for ids already tracked. Workspaces
/// the login did not surface are dropped (only when a list was returned).
pub fn merge_account_workspaces(
    existing_workspaces: Option<&[Workspace]>,
    incoming: Option<&[Workspace]>,
) -> Option<Vec<Workspace>> {
    let Some(incoming) = incoming else {
        return existing_workspaces.map(<[Workspace]>::to_vec);
    };
    Some(
        incoming
            .iter()
            .map(|new_ws| {
                let existing_ws =
                    existing_workspaces.and_then(|list| list.iter().find(|w| w.id == new_ws.id));
                match existing_ws {
                    Some(existing_ws) => Workspace {
                        enabled: existing_ws.enabled,
                        disabled_at: existing_ws.disabled_at,
                        ..new_ws.clone()
                    },
                    None => new_ws.clone(),
                }
            })
            .collect(),
    )
}

/// `resolveCurrentWorkspaceIndex(existing, merged)` — keep the user on their
/// current workspace if it survived, else the default workspace, else the
/// first enabled one, else 0. No merged/empty list keeps the existing index.
pub fn resolve_current_workspace_index(
    existing_workspaces: Option<&[Workspace]>,
    existing_current_workspace_index: Option<i64>,
    merged_workspaces: Option<&[Workspace]>,
) -> Option<i64> {
    let merged = match merged_workspaces {
        Some(merged) if !merged.is_empty() => merged,
        _ => return existing_current_workspace_index,
    };
    let current_index = existing_current_workspace_index.unwrap_or(0);
    let current_workspace_id = existing_workspaces.and_then(|list| {
        usize::try_from(current_index)
            .ok()
            .and_then(|index| list.get(index))
            .map(|ws| ws.id.clone())
    });
    if let Some(current_workspace_id) = current_workspace_id
        && let Some(matching) = merged.iter().position(|ws| ws.id == current_workspace_id) {
            return Some(matching as i64);
        }
    if let Some(default_index) = merged.iter().position(|ws| ws.is_default == Some(true)) {
        return Some(default_index as i64);
    }
    if let Some(first_enabled) = merged.iter().position(|ws| ws.enabled) {
        return Some(first_enabled as i64);
    }
    Some(0)
}

/// `buildInsertedAccount(write)`.
pub fn build_inserted_account(write: &ResolvedAccountWrite) -> AccountMetadataV3 {
    let initial_workspace_index = match &write.workspaces {
        Some(workspaces) if !workspaces.is_empty() => Some(pick_initial_workspace_index(
            workspaces,
            write.account_id.as_deref(),
        ) as i64),
        _ => None,
    };
    AccountMetadataV3 {
        account_id: write.account_id.clone(),
        account_id_source: write.account_id_source,
        account_label: write.account_label.clone(),
        email: write.email.clone(),
        refresh_token: write.refresh_token.clone(),
        access_token: write.access_token.clone(),
        expires_at: write.expires_at,
        enabled: Some(true),
        added_at: write.now,
        last_used: write.now,
        last_switch_reason: None,
        rate_limit_reset_times: None,
        cooling_down_until: None,
        cooldown_reason: None,
        workspaces: write.workspaces.clone(),
        current_workspace_index: initial_workspace_index,
    }
}

/// `buildUpdatedAccount(existing, write)` — outcome `Rebound` only when the
/// row already tracked ≥1 workspace AND the write surfaced a new id.
pub fn build_updated_account(
    existing: &AccountMetadataV3,
    write: &ResolvedAccountWrite,
) -> (AccountMetadataV3, AccountPoolWriteOutcome) {
    let next_email = write.email.clone().or_else(|| existing.email.clone());
    let next_account_id = write.account_id.clone().or_else(|| existing.account_id.clone());
    let next_account_id_source = if write.account_id.is_some() {
        write.account_id_source.or(existing.account_id_source)
    } else {
        existing.account_id_source
    };

    let previous_workspace_ids: Vec<&str> = existing
        .workspaces
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|ws| ws.id.as_str())
        .collect();
    let merged_workspaces =
        merge_account_workspaces(existing.workspaces.as_deref(), write.workspaces.as_deref());
    // Only a genuine *rebind* counts as "rebound": the account already
    // tracked workspaces and the login surfaced one it had never seen (#512
    // follow-up: first-time enrichment of a pre-#491 row stays "updated").
    let introduced_new_workspace = !previous_workspace_ids.is_empty()
        && write
            .workspaces
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|ws| !previous_workspace_ids.contains(&ws.id.as_str()));
    let next_current_workspace_index = resolve_current_workspace_index(
        existing.workspaces.as_deref(),
        existing.current_workspace_index,
        merged_workspaces.as_deref(),
    );

    let account = AccountMetadataV3 {
        account_id: next_account_id,
        account_id_source: next_account_id_source,
        account_label: write.account_label.clone().or_else(|| existing.account_label.clone()),
        email: next_email,
        refresh_token: write.refresh_token.clone(),
        // Assigned unconditionally in TS — may become undefined.
        access_token: write.access_token.clone(),
        expires_at: write.expires_at,
        enabled: Some(true),
        last_used: write.now,
        workspaces: merged_workspaces,
        current_workspace_index: next_current_workspace_index,
        ..existing.clone()
    };
    let outcome = if introduced_new_workspace {
        AccountPoolWriteOutcome::Rebound
    } else {
        AccountPoolWriteOutcome::Updated
    };
    (account, outcome)
}

/// Result of [`apply_account_pool_results`].
#[derive(Clone, Debug, PartialEq)]
pub struct AccountPoolFoldResult {
    pub accounts: Vec<AccountMetadataV3>,
    pub active_index: i64,
    pub outcome: Option<AccountPoolWriteOutcome>,
}

/// `applyAccountPoolResults({existing, writes, priorActiveIndex,
/// findMatchingAccountIndex})` — the pure core of `persistAccountPool`.
pub fn apply_account_pool_results(
    existing: &[AccountMetadataV3],
    writes: &[ResolvedAccountWrite],
    prior_active_index: Option<i64>,
    find_matching_account_index: FindMatchingAccountIndexFn<'_>,
) -> AccountPoolFoldResult {
    let mut accounts: Vec<AccountMetadataV3> = existing.to_vec();
    let mut selected_account_index: Option<usize> = None;
    let mut selected_outcome: Option<AccountPoolWriteOutcome> = None;

    for write in writes {
        let identity = PoolWriteIdentity {
            account_id: write.account_id.clone(),
            email: write.email.clone(),
            refresh_token: Some(write.refresh_token.clone()),
        };
        let existing_index = find_matching_account_index(&accounts, &identity);

        match existing_index {
            None => {
                let account = build_inserted_account(write);
                selected_account_index = Some(accounts.len());
                accounts.push(account);
                selected_outcome = Some(AccountPoolWriteOutcome::Inserted);
            }
            Some(existing_index) => {
                let Some(existing_account) = accounts.get(existing_index).cloned() else {
                    continue;
                };
                let (account, outcome) = build_updated_account(&existing_account, write);
                accounts[existing_index] = account;
                selected_account_index = Some(existing_index);
                selected_outcome = Some(outcome);
            }
        }
    }

    let clamp = |index: i64| -> i64 {
        if accounts.is_empty() {
            0
        } else {
            index.clamp(0, accounts.len() as i64 - 1).max(0)
        }
    };
    let active_index = if accounts.is_empty() {
        0
    } else {
        match selected_account_index {
            Some(index) => clamp(index as i64),
            None => clamp(prior_active_index.unwrap_or(0)),
        }
    };

    AccountPoolFoldResult {
        accounts,
        active_index,
        outcome: selected_outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, enabled: bool, is_default: bool) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: Some(format!("ws {id}")),
            enabled,
            disabled_at: None,
            is_default: if is_default { Some(true) } else { None },
        }
    }

    fn account(refresh_token: &str, email: Option<&str>) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh_token.to_string(), 1_000, 1_000);
        account.email = email.map(str::to_string);
        account
    }

    fn write(refresh_token: &str, email: Option<&str>, now: i64) -> ResolvedAccountWrite {
        ResolvedAccountWrite {
            refresh_token: refresh_token.to_string(),
            email: email.map(str::to_string),
            now,
            ..Default::default()
        }
    }

    /// Matcher used in tests: refresh-token equality, then email equality.
    fn matcher(accounts: &[AccountMetadataV3], identity: &PoolWriteIdentity) -> Option<usize> {
        if let Some(refresh_token) = &identity.refresh_token
            && let Some(index) = accounts
                .iter()
                .position(|a| &a.refresh_token == refresh_token)
            {
                return Some(index);
            }
        if let Some(email) = &identity.email
            && let Some(index) = accounts.iter().position(|a| a.email.as_ref() == Some(email)) {
                return Some(index);
            }
        None
    }

    #[test]
    fn inserts_a_brand_new_account_and_selects_it() {
        let result = apply_account_pool_results(
            &[],
            &[write("rt-new", Some("a@x.com"), 5_000)],
            None,
            &matcher,
        );
        assert_eq!(result.accounts.len(), 1);
        assert_eq!(result.active_index, 0);
        assert_eq!(result.outcome, Some(AccountPoolWriteOutcome::Inserted));
        let inserted = &result.accounts[0];
        assert_eq!(inserted.enabled, Some(true));
        assert_eq!(inserted.added_at, 5_000);
        assert_eq!(inserted.last_used, 5_000);
        assert_eq!(inserted.current_workspace_index, None);
    }

    #[test]
    fn inserted_account_seeds_workspace_tracking() {
        let mut w = write("rt-ws", Some("a@x.com"), 5_000);
        w.account_id = Some("acc_2".to_string());
        w.workspaces = Some(vec![
            workspace("acc_1", true, true),
            workspace("acc_2", true, false),
        ]);
        let result = apply_account_pool_results(&[], &[w], None, &matcher);
        // Initial index prefers the workspace matching the accountId.
        assert_eq!(result.accounts[0].current_workspace_index, Some(1));
    }

    #[test]
    fn same_identity_login_is_updated_not_inserted() {
        let existing = vec![account("rt-1", Some("a@x.com"))];
        let mut w = write("rt-1-rotated", Some("a@x.com"), 9_000);
        w.access_token = Some("at-new".to_string());
        w.expires_at = Some(99_000);
        let result = apply_account_pool_results(&existing, &[w], Some(0), &matcher);
        assert_eq!(result.accounts.len(), 1);
        assert_eq!(result.outcome, Some(AccountPoolWriteOutcome::Updated));
        let updated = &result.accounts[0];
        assert_eq!(updated.refresh_token, "rt-1-rotated");
        assert_eq!(updated.access_token.as_deref(), Some("at-new"));
        assert_eq!(updated.expires_at, Some(99_000));
        assert_eq!(updated.enabled, Some(true));
        assert_eq!(updated.last_used, 9_000);
        // addedAt survives the spread.
        assert_eq!(updated.added_at, 1_000);
    }

    #[test]
    fn first_time_workspace_enrichment_is_updated_not_rebound() {
        let existing = vec![account("rt-1", Some("a@x.com"))];
        let mut w = write("rt-1", Some("a@x.com"), 9_000);
        w.workspaces = Some(vec![workspace("acc_1", true, true)]);
        let result = apply_account_pool_results(&existing, &[w], Some(0), &matcher);
        assert_eq!(result.outcome, Some(AccountPoolWriteOutcome::Updated));
        assert_eq!(result.accounts[0].workspaces.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn new_workspace_id_on_a_tracking_row_is_rebound() {
        let mut existing_account = account("rt-1", Some("a@x.com"));
        existing_account.workspaces = Some(vec![workspace("acc_1", true, true)]);
        existing_account.current_workspace_index = Some(0);
        let mut w = write("rt-1", Some("a@x.com"), 9_000);
        w.workspaces = Some(vec![
            workspace("acc_1", true, true),
            workspace("acc_9", true, false),
        ]);
        let result = apply_account_pool_results(&[existing_account], &[w], Some(0), &matcher);
        assert_eq!(result.outcome, Some(AccountPoolWriteOutcome::Rebound));
    }

    #[test]
    fn workspace_merge_preserves_user_enabled_state_and_drops_unsurfaced() {
        let mut disabled_ws = workspace("acc_1", false, true);
        disabled_ws.disabled_at = Some(7_777);
        let existing = vec![Workspace {
            ..disabled_ws.clone()
        }, workspace("acc_gone", true, false)];

        let incoming = vec![workspace("acc_1", true, true), workspace("acc_new", true, false)];
        let merged = merge_account_workspaces(Some(&existing), Some(&incoming)).unwrap();
        assert_eq!(merged.len(), 2);
        // User's disabled state + disabledAt carried over.
        assert!(!merged[0].enabled);
        assert_eq!(merged[0].disabled_at, Some(7_777));
        // acc_gone was not surfaced → dropped.
        assert!(merged.iter().all(|ws| ws.id != "acc_gone"));

        // No incoming list → existing untouched.
        let untouched = merge_account_workspaces(Some(&existing), None).unwrap();
        assert_eq!(untouched.len(), 2);
    }

    #[test]
    fn current_workspace_index_follows_survivor_then_default_then_enabled() {
        let existing = vec![workspace("a", true, false), workspace("b", true, false)];
        // Current (index 1 = "b") survives at new position 0.
        let merged = vec![workspace("b", true, false), workspace("c", true, true)];
        assert_eq!(
            resolve_current_workspace_index(Some(&existing), Some(1), Some(&merged)),
            Some(0)
        );
        // Current gone → default wins.
        let merged = vec![workspace("x", true, false), workspace("y", true, true)];
        assert_eq!(
            resolve_current_workspace_index(Some(&existing), Some(1), Some(&merged)),
            Some(1)
        );
        // No default → first enabled.
        let merged = vec![workspace("x", false, false), workspace("y", true, false)];
        assert_eq!(
            resolve_current_workspace_index(Some(&existing), Some(1), Some(&merged)),
            Some(1)
        );
        // Nothing enabled → 0.
        let merged = vec![workspace("x", false, false)];
        assert_eq!(
            resolve_current_workspace_index(Some(&existing), Some(1), Some(&merged)),
            Some(0)
        );
        // Empty merged list keeps the existing index.
        assert_eq!(
            resolve_current_workspace_index(Some(&existing), Some(1), Some(&[])),
            Some(1)
        );
    }

    #[test]
    fn outcome_is_from_the_last_write_and_active_index_follows_it() {
        let existing = vec![account("rt-1", Some("a@x.com"))];
        let writes = vec![
            write("rt-2", Some("b@x.com"), 9_000), // inserted at 1
            write("rt-1", Some("a@x.com"), 9_001), // updated at 0
        ];
        let result = apply_account_pool_results(&existing, &writes, Some(0), &matcher);
        assert_eq!(result.accounts.len(), 2);
        assert_eq!(result.outcome, Some(AccountPoolWriteOutcome::Updated));
        assert_eq!(result.active_index, 0);
    }

    #[test]
    fn no_writes_falls_back_to_clamped_prior_active_index() {
        let existing = vec![account("rt-1", None), account("rt-2", None)];
        let result = apply_account_pool_results(&existing, &[], Some(7), &matcher);
        assert_eq!(result.active_index, 1);
        assert_eq!(result.outcome, None);

        let empty = apply_account_pool_results(&[], &[], Some(7), &matcher);
        assert_eq!(empty.active_index, 0);
    }
}
