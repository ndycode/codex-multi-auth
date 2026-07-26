//! Port of `lib/storage/account-match-utils.ts` (spec 02 §6).
//!
//! - [`select_newest_account`] / [`newest_prefers_candidate`]: higher
//!   `lastUsed || 0` wins; tie ⇒ higher-or-equal `addedAt || 0` wins, i.e.
//!   the CANDIDATE wins exact ties (`>=`).
//! - [`collect_distinct_identity_values`]: distinct non-empty values.
//! - [`find_newest_matching_index`]: generic newest-match scan.

use std::collections::HashSet;

use cma_core::schemas::account_storage::{AccountMetadataV1, AccountMetadataV3};
use cma_core::schemas::flagged::FlaggedAccountMetadataV1;

/// Recency fields used by newest-wins selection (TS
/// `AccountLike = { addedAt?, lastUsed? }`; missing values count as 0).
pub trait AccountRecency {
    fn recency_last_used(&self) -> i64;
    fn recency_added_at(&self) -> i64;
}

impl AccountRecency for AccountMetadataV3 {
    fn recency_last_used(&self) -> i64 {
        self.last_used
    }
    fn recency_added_at(&self) -> i64 {
        self.added_at
    }
}

impl AccountRecency for AccountMetadataV1 {
    fn recency_last_used(&self) -> i64 {
        self.last_used
    }
    fn recency_added_at(&self) -> i64 {
        self.added_at
    }
}

impl AccountRecency for FlaggedAccountMetadataV1 {
    fn recency_last_used(&self) -> i64 {
        self.last_used
    }
    fn recency_added_at(&self) -> i64 {
        self.added_at
    }
}

impl<T: AccountRecency> AccountRecency for &T {
    fn recency_last_used(&self) -> i64 {
        (*self).recency_last_used()
    }
    fn recency_added_at(&self) -> i64 {
        (*self).recency_added_at()
    }
}

/// Core of `selectNewestAccount`: does `candidate` win over `current`?
/// (TS returns the winning object; identity comparison `newest === account`
/// maps to this boolean.) Candidate wins strict `lastUsed` and wins
/// `addedAt` ties (`>=`).
pub fn newest_prefers_candidate<T: AccountRecency>(current: &T, candidate: &T) -> bool {
    let current_last_used = current.recency_last_used();
    let candidate_last_used = candidate.recency_last_used();
    if candidate_last_used > current_last_used {
        return true;
    }
    if candidate_last_used < current_last_used {
        return false;
    }
    candidate.recency_added_at() >= current.recency_added_at()
}

/// TS `selectNewestAccount(current, candidate)` — returns the newest of the
/// two (candidate when `current` is absent or on exact ties).
pub fn select_newest_account<'a, T: AccountRecency>(
    current: Option<&'a T>,
    candidate: &'a T,
) -> &'a T {
    match current {
        None => candidate,
        Some(current) => {
            if newest_prefers_candidate(current, candidate) {
                candidate
            } else {
                current
            }
        }
    }
}

/// TS `collectDistinctIdentityValues` — distinct set of the non-empty values.
pub fn collect_distinct_identity_values<'a>(
    values: impl IntoIterator<Item = Option<&'a str>>,
) -> HashSet<String> {
    let mut distinct = HashSet::new();
    for value in values.into_iter().flatten() {
        if !value.is_empty() {
            distinct.insert(value.to_string());
        }
    }
    distinct
}

/// TS `findNewestMatchingIndex` — scan `accounts`, keep the newest entry
/// whose ref satisfies `predicate`. `select_newest_is_candidate(current,
/// candidate)` decides whether a later match replaces the current one
/// (candidate-wins-ties semantics live in the injected comparator).
pub fn find_newest_matching_index<T, R>(
    accounts: &[T],
    to_ref: impl Fn(&T) -> R,
    predicate: impl Fn(&R) -> bool,
    select_newest_is_candidate: impl Fn(&T, &T) -> bool,
) -> Option<usize> {
    let mut match_index: Option<usize> = None;
    for (i, account) in accounts.iter().enumerate() {
        let ref_ = to_ref(account);
        if !predicate(&ref_) {
            continue;
        }
        match match_index {
            None => match_index = Some(i),
            Some(current_index) => {
                if select_newest_is_candidate(&accounts[current_index], account) {
                    match_index = Some(i);
                }
            }
        }
    }
    match_index
}

// ============================================================================
// Tests (ported from the account-match-utils assertions)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn account(last_used: i64, added_at: i64) -> AccountMetadataV3 {
        AccountMetadataV3::new("rt", added_at, last_used)
    }

    #[test]
    fn newest_higher_last_used_wins() {
        let older = account(10, 1);
        let newer = account(20, 1);
        assert!(newest_prefers_candidate(&older, &newer));
        assert!(!newest_prefers_candidate(&newer, &older));
    }

    #[test]
    fn newest_tie_goes_to_candidate_on_added_at_gte() {
        let current = account(10, 5);
        let candidate_equal = account(10, 5);
        let candidate_newer = account(10, 6);
        let candidate_older = account(10, 4);
        assert!(newest_prefers_candidate(&current, &candidate_equal));
        assert!(newest_prefers_candidate(&current, &candidate_newer));
        assert!(!newest_prefers_candidate(&current, &candidate_older));
    }

    #[test]
    fn select_newest_account_returns_candidate_when_current_missing() {
        let candidate = account(1, 1);
        let selected = select_newest_account(None, &candidate);
        assert!(std::ptr::eq(selected, &candidate));
    }

    #[test]
    fn collect_distinct_skips_missing_and_empty() {
        let distinct = collect_distinct_identity_values([
            Some("a"),
            None,
            Some(""),
            Some("b"),
            Some("a"),
        ]);
        assert_eq!(distinct.len(), 2);
        assert!(distinct.contains("a"));
        assert!(distinct.contains("b"));
    }

    #[test]
    fn find_newest_matching_index_keeps_newest_match() {
        let accounts = vec![account(10, 1), account(30, 1), account(20, 1)];
        let index = find_newest_matching_index(
            &accounts,
            |a| a.recency_last_used(),
            |_| true,
            newest_prefers_candidate,
        );
        assert_eq!(index, Some(1));
    }

    #[test]
    fn find_newest_matching_index_none_when_no_match() {
        let accounts = vec![account(10, 1)];
        let index = find_newest_matching_index(
            &accounts,
            |a| a.recency_last_used(),
            |_| false,
            newest_prefers_candidate,
        );
        assert_eq!(index, None);
    }

    #[test]
    fn find_newest_matching_index_first_of_equal_ties_is_replaced_by_candidate() {
        // Candidate-wins-ties: a later exact tie replaces the earlier match,
        // mirroring `selectNewestAccount(current, candidate)` returning the
        // candidate on `addedAt >=`.
        let accounts = vec![account(10, 5), account(10, 5)];
        let index = find_newest_matching_index(
            &accounts,
            |a| a.recency_last_used(),
            |_| true,
            newest_prefers_candidate,
        );
        assert_eq!(index, Some(1));
    }
}
