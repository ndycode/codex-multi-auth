//! Port of the account-matching functions from `lib/storage.ts`
//! (spec 02 §6.2–§6.3): the 4-tier identity matcher, pin reconciliation,
//! selection-index resolution, fixpoint deduplication and `clampIndex`.
//!
//! Tier order (each tier picks the "newest matching index"):
//! 1. **Composite** — candidate has BOTH accountId and emailKey.
//! 2. **Safe email** — candidate emailKey; ambiguous (2+ distinct accountIds
//!    among candidate + matches) ⇒ tier yields nothing (falls through).
//! 3. **Refresh token** — FAIL-CLOSED: a token match whose accountId/emailKey
//!    conflicts with the candidate poisons the tier (never merge two
//!    identities across a shared token); 2+ token matches with an anonymous
//!    candidate ⇒ ambiguous.
//! 4. **Unique accountId** — exactly one account with that id; without a
//!    candidate emailKey this tier only runs when
//!    `allow_unique_account_id_fallback_without_email` is set.
//!
//! Deduplication runs to FIXPOINT (gotcha 6): a newest-wins merge can install
//! an account that duplicates an earlier survivor through a different tier.

use crate::identity::{AccountIdentityLike, AccountIdentityRef, to_account_identity_ref};
use crate::match_utils::{
    AccountRecency, collect_distinct_identity_values, find_newest_matching_index,
    newest_prefers_candidate,
};

/// Options for [`find_matching_account_index`] (TS `AccountMatchOptions`).
#[derive(Clone, Copy, Debug, Default)]
pub struct AccountMatchOptions {
    pub allow_unique_account_id_fallback_without_email: bool,
}

/// Candidate shape for [`resolve_account_selection_index`] and the matcher —
/// the TS inline `{accountId?, email?, refreshToken?}` object built by
/// `normalizeAccountStorage` from raw (pre-validation) account values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountSelectionCandidate {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub refresh_token: Option<String>,
}

impl AccountIdentityLike for AccountSelectionCandidate {
    fn identity_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn identity_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
    fn identity_refresh_token(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }
}

fn find_newest_ref_matching_index<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    predicate: impl Fn(&AccountIdentityRef) -> bool,
) -> Option<usize> {
    find_newest_matching_index(
        accounts,
        |account| to_account_identity_ref(account),
        predicate,
        |current, candidate| newest_prefers_candidate(current, candidate),
    )
}

fn find_composite_account_match_index<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    candidate_ref: &AccountIdentityRef,
) -> Option<usize> {
    let (Some(account_id), Some(email_key)) =
        (&candidate_ref.account_id, &candidate_ref.email_key)
    else {
        return None;
    };
    find_newest_ref_matching_index(accounts, |ref_| {
        ref_.account_id.as_deref() == Some(account_id.as_str())
            && ref_.email_key.as_deref() == Some(email_key.as_str())
    })
}

fn find_safe_email_match_index<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    candidate_ref: &AccountIdentityRef,
) -> Option<usize> {
    let email_key = candidate_ref.email_key.as_deref()?;

    let mut email_account_ids: Vec<Option<String>> = vec![candidate_ref.account_id.clone()];
    let mut found_any = false;
    for account in accounts {
        let ref_ = to_account_identity_ref(account);
        if ref_.email_key.as_deref() != Some(email_key) {
            continue;
        }
        found_any = true;
        email_account_ids.push(ref_.account_id);
    }

    if !found_any {
        return None;
    }
    let distinct =
        collect_distinct_identity_values(email_account_ids.iter().map(|value| value.as_deref()));
    if distinct.len() > 1 {
        return None;
    }

    find_newest_ref_matching_index(accounts, |ref_| {
        ref_.email_key.as_deref() == Some(email_key)
    })
}

fn find_compatible_refresh_token_match_index<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    candidate_ref: &AccountIdentityRef,
) -> Option<usize> {
    let refresh_token = candidate_ref.refresh_token.as_deref()?;
    let mut matching_index: Option<usize> = None;

    for (i, account) in accounts.iter().enumerate() {
        let ref_ = to_account_identity_ref(account);
        if ref_.refresh_token.as_deref() != Some(refresh_token) {
            continue;
        }
        // FAIL-CLOSED: both sides carry an accountId (or emailKey) and they
        // differ ⇒ never merge two identities across a shared token.
        let account_id_conflict = matches!(
            (&candidate_ref.account_id, &ref_.account_id),
            (Some(candidate_id), Some(account_id)) if candidate_id != account_id
        );
        let email_conflict = matches!(
            (&candidate_ref.email_key, &ref_.email_key),
            (Some(candidate_email), Some(account_email)) if candidate_email != account_email
        );
        if account_id_conflict || email_conflict {
            return None;
        }
        // Anonymous candidate (no id, no email) with 2+ token matches ⇒
        // ambiguous.
        if matching_index.is_some()
            && candidate_ref.account_id.is_none()
            && candidate_ref.email_key.is_none()
        {
            return None;
        }
        match matching_index {
            None => matching_index = Some(i),
            Some(current_index) => {
                if newest_prefers_candidate(&accounts[current_index], account) {
                    matching_index = Some(i);
                }
            }
        }
    }

    matching_index
}

fn find_unique_account_id_match_index<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    candidate_ref: &AccountIdentityRef,
    options: AccountMatchOptions,
) -> Option<usize> {
    let account_id = candidate_ref.account_id.as_deref()?;
    if candidate_ref.email_key.is_none()
        && !options.allow_unique_account_id_fallback_without_email
    {
        return None;
    }
    let mut matching_index: Option<usize> = None;
    let mut matching_email_key: Option<String> = None;

    for (i, account) in accounts.iter().enumerate() {
        let ref_ = to_account_identity_ref(account);
        if ref_.account_id.as_deref() != Some(account_id) {
            continue;
        }
        if matching_index.is_some() {
            return None;
        }
        matching_index = Some(i);
        matching_email_key = ref_.email_key;
    }

    if matching_index.is_some()
        && let (Some(matching_email), Some(candidate_email)) =
            (&matching_email_key, &candidate_ref.email_key)
        && matching_email != candidate_email
    {
        return None;
    }

    matching_index
}

/// TS `findMatchingAccountIndex(accounts, candidate, options)` with the
/// candidate expressed as a pre-normalized [`AccountIdentityRef`].
pub fn find_matching_account_index_by_ref<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    candidate_ref: &AccountIdentityRef,
    options: AccountMatchOptions,
) -> Option<usize> {
    if let Some(by_composite) = find_composite_account_match_index(accounts, candidate_ref) {
        return Some(by_composite);
    }

    if let Some(by_email) = find_safe_email_match_index(accounts, candidate_ref) {
        return Some(by_email);
    }

    if candidate_ref.refresh_token.is_some()
        && let Some(by_refresh) = find_compatible_refresh_token_match_index(accounts, candidate_ref)
    {
        return Some(by_refresh);
    }

    find_unique_account_id_match_index(accounts, candidate_ref, options)
}

/// TS `findMatchingAccountIndex` — candidate as an account-like value.
pub fn find_matching_account_index<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    candidate: &impl AccountIdentityLike,
    options: AccountMatchOptions,
) -> Option<usize> {
    let candidate_ref = to_account_identity_ref(candidate);
    find_matching_account_index_by_ref(accounts, &candidate_ref, options)
}

/// TS `reconcilePinnedAccountIndex` (#474) — re-resolve a manual pin after
/// the account list changes. Returns the pinned account's new index, or
/// `None` when it no longer resolves (pin cleared, never left dangling).
pub fn reconcile_pinned_account_index<T: AccountIdentityLike + AccountRecency>(
    pinned_account: Option<&impl AccountIdentityLike>,
    next_accounts: &[T],
) -> Option<usize> {
    let pinned_account = pinned_account?;
    find_matching_account_index(next_accounts, pinned_account, AccountMatchOptions::default())
}

/// Numeric types accepted as the `resolveAccountSelectionIndex` fallback —
/// the TS `fallbackIndex` is a JS number; both integer and float call sites
/// clamp with the exact `clampIndex` semantics (NaN ⇒ 0, trunc, bounds).
pub trait SelectionFallbackIndex {
    fn clamp_to(self, length: usize) -> usize;
}

impl SelectionFallbackIndex for f64 {
    fn clamp_to(self, length: usize) -> usize {
        clamp_index(self, length)
    }
}

impl SelectionFallbackIndex for i64 {
    fn clamp_to(self, length: usize) -> usize {
        clamp_index_i64(self, length)
    }
}

impl SelectionFallbackIndex for i32 {
    fn clamp_to(self, length: usize) -> usize {
        clamp_index_i64(i64::from(self), length)
    }
}

impl SelectionFallbackIndex for usize {
    fn clamp_to(self, length: usize) -> usize {
        clamp_index_i64(i64::try_from(self).unwrap_or(i64::MAX), length)
    }
}

/// TS `resolveAccountSelectionIndex` — follow a previously-selected account
/// by identity (unique-accountId fallback enabled), else clamp the fallback
/// index.
pub fn resolve_account_selection_index<T: AccountIdentityLike + AccountRecency>(
    accounts: &[T],
    candidate: &impl AccountIdentityLike,
    fallback_index: impl SelectionFallbackIndex,
) -> usize {
    if accounts.is_empty() {
        return 0;
    }
    if let Some(matched_index) = find_matching_account_index(
        accounts,
        candidate,
        AccountMatchOptions {
            allow_unique_account_id_fallback_without_email: true,
        },
    ) {
        return matched_index;
    }
    fallback_index.clamp_to(accounts.len())
}

fn deduplicate_accounts_by_identity_pass<T>(accounts: &[T]) -> Vec<T>
where
    T: Clone + AccountIdentityLike + AccountRecency,
{
    let mut deduplicated: Vec<T> = Vec::new();
    for account in accounts {
        match find_matching_account_index(&deduplicated, account, AccountMatchOptions::default())
        {
            None => deduplicated.push(account.clone()),
            Some(existing_index) => {
                // Position preserved; newest content wins (candidate wins
                // exact ties).
                if newest_prefers_candidate(&deduplicated[existing_index], account) {
                    deduplicated[existing_index] = account.clone();
                }
            }
        }
    }
    deduplicated
}

fn deduplicate_accounts_by_identity<T>(accounts: &[T]) -> Vec<T>
where
    T: Clone + AccountIdentityLike + AccountRecency,
{
    // A single pass is not a fixpoint: a newest-wins merge can replace a kept
    // entry with an account that itself duplicates an earlier survivor
    // through a different matching tier. Re-run until stable; every merge
    // strictly shrinks the array, so this terminates after at most
    // `accounts.len()` passes.
    let mut current = deduplicate_accounts_by_identity_pass(accounts);
    loop {
        let next = deduplicate_accounts_by_identity_pass(&current);
        if next.len() == current.len() {
            return next;
        }
        current = next;
    }
}

/// TS `deduplicateAccounts` — removes duplicate accounts, keeping the most
/// recently used entry for each safely matched identity. Runs to fixpoint.
pub fn deduplicate_accounts<T>(accounts: &[T]) -> Vec<T>
where
    T: Clone + AccountIdentityLike + AccountRecency,
{
    deduplicate_accounts_by_identity(accounts)
}

/// TS `deduplicateAccountsByEmail` — alias of [`deduplicate_accounts`].
pub fn deduplicate_accounts_by_email<T>(accounts: &[T]) -> Vec<T>
where
    T: Clone + AccountIdentityLike + AccountRecency,
{
    deduplicate_accounts_by_identity(accounts)
}

/// TS `clampIndex` (record-utils) over a float index: `length <= 0` ⇒ 0;
/// `NaN` ⇒ 0 (corrupt `activeIndex` must not propagate — gotcha 32); else
/// `max(0, min(trunc(index), length - 1))`. ±Infinity clamp correctly.
pub fn clamp_index(index: f64, length: usize) -> usize {
    if length == 0 {
        return 0;
    }
    if index.is_nan() {
        return 0;
    }
    let truncated = index.trunc();
    let max_index = (length - 1) as f64;
    let clamped = truncated.max(0.0).min(max_index);
    clamped as usize
}

/// [`clamp_index`] for integer inputs.
pub fn clamp_index_i64(index: i64, length: usize) -> usize {
    if length == 0 {
        return 0;
    }
    let max_index = (length - 1) as i64;
    index.clamp(0, max_index) as usize
}

// ============================================================================
// Tests (ported from the matching/dedup suites of test/storage.test.ts)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;

    fn account(
        account_id: Option<&str>,
        email: Option<&str>,
        refresh_token: &str,
        last_used: i64,
        added_at: i64,
    ) -> AccountMetadataV3 {
        let mut a = AccountMetadataV3::new(refresh_token, added_at, last_used);
        a.account_id = account_id.map(str::to_string);
        a.email = email.map(str::to_string);
        a
    }

    fn candidate(
        account_id: Option<&str>,
        email: Option<&str>,
        refresh_token: Option<&str>,
    ) -> AccountIdentityRef {
        AccountIdentityRef::from_parts(account_id, email, refresh_token)
    }

    #[test]
    fn composite_tier_requires_both_id_and_email() {
        let accounts = vec![
            account(Some("acc_1"), Some("a@b.com"), "rt_1", 10, 1),
            account(Some("acc_2"), Some("a@b.com"), "rt_2", 99, 1),
        ];
        // Composite match beats the (ambiguous) email tier.
        let index = find_matching_account_index_by_ref(
            &accounts,
            &candidate(Some("acc_1"), Some("A@B.com"), None),
            AccountMatchOptions::default(),
        );
        assert_eq!(index, Some(0));
    }

    #[test]
    fn safe_email_tier_matches_when_account_ids_agree() {
        let accounts = vec![
            account(None, Some("a@b.com"), "rt_1", 10, 1),
            account(Some("acc_1"), Some("a@b.com"), "rt_2", 20, 1),
        ];
        // candidate id acc_1; distinct set {acc_1} => safe; newest wins.
        let index = find_matching_account_index_by_ref(
            &accounts,
            &candidate(Some("acc_1"), Some("a@b.com"), None),
            AccountMatchOptions::default(),
        );
        assert_eq!(index, Some(1));
    }

    #[test]
    fn safe_email_tier_is_ambiguous_with_two_distinct_account_ids() {
        let accounts = vec![
            account(Some("acc_1"), Some("a@b.com"), "rt_1", 10, 1),
            account(Some("acc_2"), Some("a@b.com"), "rt_2", 20, 1),
        ];
        // Ambiguous email + no other tier applies (unique-id tier: candidate
        // has emailKey, id acc_3 matches nothing) ⇒ None.
        let index = find_matching_account_index_by_ref(
            &accounts,
            &candidate(Some("acc_3"), Some("a@b.com"), None),
            AccountMatchOptions::default(),
        );
        assert_eq!(index, None);
    }

    #[test]
    fn refresh_tier_is_fail_closed_on_conflicting_identity() {
        let accounts = vec![account(Some("acc_1"), Some("a@b.com"), "rt_shared", 10, 1)];
        // Same token, DIFFERENT accountId — must not merge; the unique-id
        // tier also finds nothing (acc_2 not present) ⇒ None.
        let index = find_matching_account_index_by_ref(
            &accounts,
            &candidate(Some("acc_2"), None, Some("rt_shared")),
            AccountMatchOptions {
                allow_unique_account_id_fallback_without_email: true,
            },
        );
        assert_eq!(index, None);
    }

    #[test]
    fn refresh_tier_ambiguous_for_anonymous_candidate_with_two_matches() {
        let accounts = vec![
            account(Some("acc_1"), None, "rt_shared", 10, 1),
            account(Some("acc_2"), None, "rt_shared", 20, 1),
        ];
        let index = find_matching_account_index_by_ref(
            &accounts,
            &candidate(None, None, Some("rt_shared")),
            AccountMatchOptions::default(),
        );
        assert_eq!(index, None);
    }

    #[test]
    fn refresh_tier_matches_newest_compatible_account() {
        let accounts = vec![
            account(None, None, "rt_shared", 10, 1),
            account(Some("acc_1"), None, "rt_shared", 20, 1),
        ];
        let index = find_matching_account_index_by_ref(
            &accounts,
            &candidate(Some("acc_1"), None, Some("rt_shared")),
            AccountMatchOptions::default(),
        );
        assert_eq!(index, Some(1));
    }

    #[test]
    fn unique_account_id_tier_requires_opt_in_without_email() {
        let accounts = vec![account(Some("acc_1"), None, "rt_1", 10, 1)];
        let c = candidate(Some("acc_1"), None, None);
        assert_eq!(
            find_matching_account_index_by_ref(&accounts, &c, AccountMatchOptions::default()),
            None
        );
        assert_eq!(
            find_matching_account_index_by_ref(
                &accounts,
                &c,
                AccountMatchOptions {
                    allow_unique_account_id_fallback_without_email: true,
                },
            ),
            Some(0)
        );
    }

    #[test]
    fn unique_account_id_tier_rejects_duplicates_and_email_mismatch() {
        let duplicated = vec![
            account(Some("acc_1"), None, "rt_1", 10, 1),
            account(Some("acc_1"), None, "rt_2", 20, 1),
        ];
        assert_eq!(
            find_matching_account_index_by_ref(
                &duplicated,
                &candidate(Some("acc_1"), None, None),
                AccountMatchOptions {
                    allow_unique_account_id_fallback_without_email: true,
                },
            ),
            None
        );
        let mismatch = vec![account(Some("acc_1"), Some("x@y.z"), "rt_1", 10, 1)];
        assert_eq!(
            find_matching_account_index_by_ref(
                &mismatch,
                &candidate(Some("acc_1"), Some("other@y.z"), None),
                AccountMatchOptions::default(),
            ),
            None
        );
    }

    #[test]
    fn resolve_selection_index_clamps_fallback() {
        let accounts = vec![
            account(Some("acc_1"), None, "rt_1", 10, 1),
            account(Some("acc_2"), None, "rt_2", 10, 1),
        ];
        // No match ⇒ clamp fallback.
        assert_eq!(
            resolve_account_selection_index(&accounts, &candidate(None, None, None), 99),
            1
        );
        assert_eq!(
            resolve_account_selection_index(&accounts, &candidate(None, None, None), -3),
            0
        );
        // Empty ⇒ 0.
        let empty: Vec<AccountMetadataV3> = Vec::new();
        assert_eq!(
            resolve_account_selection_index(&empty, &candidate(Some("acc_1"), None, None), 5),
            0
        );
        // Identity match wins over fallback (unique-id fallback enabled).
        assert_eq!(
            resolve_account_selection_index(&accounts, &candidate(Some("acc_2"), None, None), 0),
            1
        );
    }

    #[test]
    fn reconcile_pinned_account_index_follows_identity_or_clears() {
        let accounts = vec![
            account(Some("acc_1"), Some("a@b.com"), "rt_1", 10, 1),
            account(Some("acc_2"), Some("c@d.com"), "rt_2", 10, 1),
        ];
        let pinned = account(Some("acc_2"), Some("c@d.com"), "rt_2", 10, 1);
        assert_eq!(
            reconcile_pinned_account_index(Some(&pinned), &accounts),
            Some(1)
        );
        let gone = account(Some("acc_9"), Some("z@z.com"), "rt_9", 10, 1);
        assert_eq!(reconcile_pinned_account_index(Some(&gone), &accounts), None);
        assert_eq!(
            reconcile_pinned_account_index(None::<&AccountMetadataV3>, &accounts),
            None
        );
    }

    #[test]
    fn dedupe_keeps_position_and_newest_content() {
        let accounts = vec![
            account(Some("acc_1"), Some("a@b.com"), "rt_old", 10, 1),
            account(Some("acc_2"), Some("c@d.com"), "rt_2", 10, 1),
            account(Some("acc_1"), Some("a@b.com"), "rt_new", 20, 2),
        ];
        let deduped = deduplicate_accounts(&accounts);
        assert_eq!(deduped.len(), 2);
        // Slot 0 keeps the FIRST match's position but the newest content.
        assert_eq!(deduped[0].refresh_token, "rt_new");
        assert_eq!(deduped[1].account_id.as_deref(), Some("acc_2"));
    }

    #[test]
    fn dedupe_ties_prefer_the_later_candidate() {
        // Same identity via the shared refresh token; identical timestamps —
        // `selectNewestAccount` ties go to the candidate (>=), so the LATER
        // entry's content wins the slot.
        let mut first = account(Some("acc_1"), None, "rt_shared", 10, 5);
        first.account_label = Some("first".to_string());
        let mut second = account(Some("acc_1"), None, "rt_shared", 10, 5);
        second.account_label = Some("second".to_string());
        let deduped = deduplicate_accounts(&[first, second]);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].account_label.as_deref(), Some("second"));
    }

    #[test]
    fn dedupe_does_not_merge_bare_account_ids_without_email() {
        // Default options: the unique-accountId tier requires the opt-in when
        // the candidate has no email — dedupe never merges on id alone.
        let accounts = vec![
            account(Some("acc_1"), None, "rt_a", 10, 5),
            account(Some("acc_1"), None, "rt_b", 10, 5),
        ];
        assert_eq!(deduplicate_accounts(&accounts).len(), 2);
    }

    #[test]
    fn dedupe_merges_chained_identities_via_shared_token() {
        let a = account(None, Some("a@b.com"), "rt_1", 10, 1);
        let b = account(Some("acc_1"), None, "rt_1", 15, 1);
        let c = account(Some("acc_1"), Some("a@b.com"), "rt_1", 20, 2);
        let deduped = deduplicate_accounts(&[a, b, c]);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].last_used, 20);
        assert_eq!(deduped[0].email.as_deref(), Some("a@b.com"));
    }

    #[test]
    fn dedupe_runs_to_fixpoint_across_tiers() {
        // Pass 1: Z merges into Y's slot via the safe-email tier, installing
        // an account (acc_1 + email) that now duplicates the earlier survivor
        // X (acc_1, no email) through the unique-accountId tier. Only the
        // SECOND pass collapses them — a single pass would return 2 entries.
        let x = account(Some("acc_1"), None, "rt_x", 30, 1);
        let y = account(None, Some("e@f.com"), "rt_y", 10, 1);
        let z = account(Some("acc_1"), Some("e@f.com"), "rt_z", 20, 2);
        let deduped = deduplicate_accounts(&[x, y, z]);
        assert_eq!(deduped.len(), 1);
        // X is the newest (lastUsed 30) so its content survives the final
        // merge.
        assert_eq!(deduped[0].refresh_token, "rt_x");
        assert_eq!(deduped[0].last_used, 30);
    }

    #[test]
    fn dedupe_alias_matches() {
        let accounts = vec![account(Some("acc_1"), None, "rt_1", 10, 1)];
        assert_eq!(deduplicate_accounts_by_email(&accounts).len(), 1);
    }

    #[test]
    fn clamp_index_handles_nan_and_bounds() {
        assert_eq!(clamp_index(f64::NAN, 5), 0);
        assert_eq!(clamp_index(3.9, 5), 3);
        assert_eq!(clamp_index(-2.0, 5), 0);
        assert_eq!(clamp_index(99.0, 5), 4);
        assert_eq!(clamp_index(f64::INFINITY, 5), 4);
        assert_eq!(clamp_index(f64::NEG_INFINITY, 5), 0);
        assert_eq!(clamp_index(2.0, 0), 0);
        assert_eq!(clamp_index_i64(99, 3), 2);
        assert_eq!(clamp_index_i64(-1, 3), 0);
        assert_eq!(clamp_index_i64(1, 0), 0);
    }
}
