//! Port of `lib/runtime/capability-boost.ts` — per-account capability
//! boost vector for the rotation selector (spec 10 §22 + gotcha 22,
//! ARCHITECTURE §6.12).
//!
//! The TS function returned a SPARSE `number[]` (unassigned slots stay
//! holes/`undefined`); the faithful Rust representation is
//! `Vec<Option<f64>>` — the selector consumer merges only the `Some`
//! entries into its boost map, exactly like the JS holes contributed
//! nothing.

use cma_accounts::entitlement_cache::{resolve_entitlement_account_key, EntitlementAccountRef};

/// TS `AccountSnapshotCandidate` (the fields the boost calc reads —
/// `resolve_entitlement_account_key` uses id/email/index).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AccountSnapshotCandidate {
    /// TS `index: number` — may be negative/out-of-range (skipped).
    pub index: i64,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub account_label: Option<String>,
}

/// The snapshot source pair (TS `accountSnapshotSource`): prefer
/// `get_accounts_snapshot`; when it yields an empty list and
/// `get_account_by_index` exists, build the list by probing indexes
/// `0..account_count`.
pub struct AccountSnapshotSource<'a> {
    pub get_accounts_snapshot: Option<&'a dyn Fn() -> Vec<AccountSnapshotCandidate>>,
    pub get_account_by_index: Option<&'a dyn Fn(usize) -> Option<AccountSnapshotCandidate>>,
}

/// TS `buildCapabilityBoostByAccount(input)` — one slot per pool index;
/// capability key = `model ?? modelFamily`.
pub fn build_capability_boost_by_account(
    account_count: usize,
    model: Option<&str>,
    model_family: &str,
    account_snapshot_source: &AccountSnapshotSource<'_>,
    get_boost: &mut dyn FnMut(&str, &str) -> f64,
) -> Vec<Option<f64>> {
    let mut boosts: Vec<Option<f64>> = vec![None; account_count];

    let mut account_snapshot_list = account_snapshot_source
        .get_accounts_snapshot
        .map(|get| get())
        .unwrap_or_default();

    if account_snapshot_list.is_empty()
        && let Some(get_account_by_index) = account_snapshot_source.get_account_by_index
    {
        for account_snapshot_index in 0..account_count {
            if let Some(candidate) = get_account_by_index(account_snapshot_index) {
                account_snapshot_list.push(candidate);
            }
        }
    }

    let capability_key = model.unwrap_or(model_family);
    for candidate in account_snapshot_list {
        if candidate.index < 0 || candidate.index as usize >= boosts.len() {
            continue;
        }
        let account_key = resolve_entitlement_account_key(&EntitlementAccountRef {
            account_id: candidate.account_id.clone(),
            email: candidate.email.clone(),
            refresh_token: None,
            index: Some(candidate.index),
        });
        boosts[candidate.index as usize] = Some(get_boost(&account_key, capability_key));
    }

    boosts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_sparse_slots_and_prefers_model_over_model_family() {
        let mut calls: Vec<(String, String)> = Vec::new();
        let mut returns = vec![7.0, 5.0]; // popped in reverse
        let mut get_boost = |account_key: &str, capability_key: &str| {
            calls.push((account_key.to_string(), capability_key.to_string()));
            returns.pop().unwrap()
        };
        let snapshot = || {
            vec![
                AccountSnapshotCandidate {
                    index: 1,
                    account_id: Some("acc_1".to_string()),
                    ..Default::default()
                },
                AccountSnapshotCandidate {
                    index: 3,
                    email: Some("User@example.com".to_string()),
                    ..Default::default()
                },
            ]
        };

        let boosts = build_capability_boost_by_account(
            4,
            Some("gpt-5-codex"),
            "codex",
            &AccountSnapshotSource {
                get_accounts_snapshot: Some(&snapshot),
                get_account_by_index: None,
            },
            &mut get_boost,
        );

        assert_eq!(boosts.len(), 4);
        assert_eq!(boosts[0], None); // hole
        assert_eq!(boosts[1], Some(5.0));
        assert_eq!(boosts[2], None); // hole
        assert_eq!(boosts[3], Some(7.0));
        assert_eq!(
            calls,
            vec![
                (
                    "account:acc_1::idx:1".to_string(),
                    "gpt-5-codex".to_string()
                ),
                ("email:user@example.com".to_string(), "gpt-5-codex".to_string()),
            ]
        );
    }

    #[test]
    fn falls_back_to_get_account_by_index_and_skips_invalid_snapshot_indices() {
        let mut calls: Vec<(String, String)> = Vec::new();
        let mut returns = vec![22.0, 11.0];
        let mut get_boost = |account_key: &str, capability_key: &str| {
            calls.push((account_key.to_string(), capability_key.to_string()));
            returns.pop().unwrap()
        };
        let empty_snapshot = Vec::new;
        let probe_count = std::cell::Cell::new(0usize);
        let get_account_by_index = |index: usize| -> Option<AccountSnapshotCandidate> {
            probe_count.set(probe_count.get() + 1);
            match index {
                0 => Some(AccountSnapshotCandidate {
                    index: 0,
                    account_id: Some("acc_0".to_string()),
                    ..Default::default()
                }),
                1 => Some(AccountSnapshotCandidate {
                    index: -1,
                    email: Some("ignored-negative@example.com".to_string()),
                    ..Default::default()
                }),
                2 => Some(AccountSnapshotCandidate {
                    index: 5,
                    email: Some("ignored-out-of-range@example.com".to_string()),
                    ..Default::default()
                }),
                3 => Some(AccountSnapshotCandidate {
                    index: 2,
                    email: Some("final@example.com".to_string()),
                    ..Default::default()
                }),
                _ => None,
            }
        };

        let boosts = build_capability_boost_by_account(
            4,
            None,
            "codex",
            &AccountSnapshotSource {
                get_accounts_snapshot: Some(&empty_snapshot),
                get_account_by_index: Some(&get_account_by_index),
            },
            &mut get_boost,
        );

        assert_eq!(boosts.len(), 4);
        assert_eq!(boosts[0], Some(11.0));
        assert_eq!(boosts[1], None);
        assert_eq!(boosts[2], Some(22.0));
        assert_eq!(boosts[3], None);
        assert_eq!(probe_count.get(), 4);
        assert_eq!(
            calls,
            vec![
                ("account:acc_0::idx:0".to_string(), "codex".to_string()),
                ("email:final@example.com".to_string(), "codex".to_string()),
            ]
        );
    }

    #[test]
    fn zero_account_count_yields_an_empty_vector() {
        let mut get_boost = |_k: &str, _c: &str| panic!("no boost expected");
        let boosts = build_capability_boost_by_account(
            0,
            None,
            "codex",
            &AccountSnapshotSource {
                get_accounts_snapshot: None,
                get_account_by_index: None,
            },
            &mut get_boost,
        );
        assert!(boosts.is_empty());
    }
}
