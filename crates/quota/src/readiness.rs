//! Port of `lib/quota-readiness.ts` — pure helpers for quota-cache entry
//! lookup keying rules and the "is exhausted" logic.
//!
//! Behavior contracts (spec 05 §4 + gotchas 1/7/8):
//! - Exhaustion is decided on the RAW `usedPercent >= 100` float —
//!   [`quota_left_percent_from_used`] (rounded) is DISPLAY ONLY. Rounding
//!   `100 - 99.6 = 0.4` down to `0` left would falsely bench a window that
//!   still has quota.
//! - Cache keying safety: `byAccountId` only when the id is unique among the
//!   accounts; `byEmail` only when exactly one account carries that email and
//!   at most one distinct accountId. Ambiguity deliberately yields NO entry
//!   (prevents cross-account quota bleed).
//! - Staleness escape ("quota-forecast-02"): a 100%-used window with no
//!   `resetAtMs` stops being "exhausted" once `windowMinutes` have elapsed
//!   since the snapshot's `updatedAt`.

use std::collections::{HashMap, HashSet};

use cma_accounts::manager::ManagedAccount;
use cma_core::schemas::account_storage::AccountMetadataV3;

use crate::cache::{QuotaCacheData, QuotaCacheEntry, QuotaCacheWindow};

/// TS `QuotaCacheAccountRef = Pick<AccountMetadataV3, "accountId" | "email">`.
///
/// A structural trait so cache lookups accept `AccountMetadataV3`,
/// `ManagedAccount`, or the owned [`QuotaAccountRef`] pair alike.
pub trait QuotaCacheAccountRef {
    fn quota_account_id(&self) -> Option<&str>;
    fn quota_email(&self) -> Option<&str>;
}

impl QuotaCacheAccountRef for AccountMetadataV3 {
    fn quota_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn quota_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
}

impl QuotaCacheAccountRef for ManagedAccount {
    fn quota_account_id(&self) -> Option<&str> {
        self.meta.account_id.as_deref()
    }
    fn quota_email(&self) -> Option<&str> {
        self.meta.email.as_deref()
    }
}

/// Owned `{ accountId?, email? }` pair for callers without a full account.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuotaAccountRef {
    pub account_id: Option<String>,
    pub email: Option<String>,
}

impl QuotaCacheAccountRef for QuotaAccountRef {
    fn quota_account_id(&self) -> Option<&str> {
        self.account_id.as_deref()
    }
    fn quota_email(&self) -> Option<&str> {
        self.email.as_deref()
    }
}

impl<T: QuotaCacheAccountRef + ?Sized> QuotaCacheAccountRef for &T {
    fn quota_account_id(&self) -> Option<&str> {
        (**self).quota_account_id()
    }
    fn quota_email(&self) -> Option<&str> {
        (**self).quota_email()
    }
}

/// TS `normalizeQuotaAccountId(value)` — trim; `None` when empty/absent.
pub fn normalize_quota_account_id(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// TS `normalizeQuotaEmail(value)` — trim + lowercase; `None` when empty.
pub fn normalize_quota_email(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim().to_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// TS `hasUniqueQuotaAccountId(accounts, account)` — the account's normalized
/// id is non-null AND exactly ONE entry in `accounts` shares it.
pub fn has_unique_quota_account_id<T: QuotaCacheAccountRef>(
    accounts: &[T],
    account: &impl QuotaCacheAccountRef,
) -> bool {
    let Some(account_id) = normalize_quota_account_id(account.quota_account_id()) else {
        return false;
    };
    let mut count = 0usize;
    for candidate in accounts {
        if normalize_quota_account_id(candidate.quota_account_id()).as_deref()
            == Some(account_id.as_str())
        {
            count += 1;
        }
    }
    count == 1
}

/// TS `QuotaEmailFallbackState`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuotaEmailFallbackState {
    pub matching_count: usize,
    pub distinct_account_ids: HashSet<String>,
}

/// TS `buildQuotaEmailFallbackState(accounts)` — per normalized email: count
/// of accounts carrying it plus the set of their normalized accountIds.
pub fn build_quota_email_fallback_state<T: QuotaCacheAccountRef>(
    accounts: &[T],
) -> HashMap<String, QuotaEmailFallbackState> {
    let mut state_by_email: HashMap<String, QuotaEmailFallbackState> = HashMap::new();
    for account in accounts {
        let Some(email) = normalize_quota_email(account.quota_email()) else {
            continue;
        };
        let account_id = normalize_quota_account_id(account.quota_account_id());
        let state = state_by_email.entry(email).or_default();
        state.matching_count += 1;
        if let Some(account_id) = account_id {
            state.distinct_account_ids.insert(account_id);
        }
    }
    state_by_email
}

/// TS `hasSafeQuotaEmailFallback(state, account)` — email present in the
/// state with `matchingCount === 1 && distinctAccountIds.size <= 1`.
pub fn has_safe_quota_email_fallback(
    email_fallback_state: &HashMap<String, QuotaEmailFallbackState>,
    account: &impl QuotaCacheAccountRef,
) -> bool {
    let Some(email) = normalize_quota_email(account.quota_email()) else {
        return false;
    };
    let Some(state) = email_fallback_state.get(&email) else {
        return false;
    };
    state.matching_count == 1 && state.distinct_account_ids.len() <= 1
}

/// TS `quotaLeftPercentFromUsed(used)` — `max(0, min(100, round(100 - used)))`.
///
/// DISPLAY ONLY — never use for exhaustion decisions (see module docs).
pub fn quota_left_percent_from_used(used_percent: Option<f64>) -> Option<i64> {
    let used = used_percent?;
    if !used.is_finite() {
        return None;
    }
    let left = (100.0 - used).round();
    Some(left.clamp(0.0, 100.0) as i64)
}

/// TS `quotaUsedPercentIsExhausted(used)` — finite AND `>= 100` (RAW float).
///
/// THE exhaustion predicate: any `usedPercent` in `(99.5, 100)` rounds to `0`
/// left-percent, so testing the rounded value would falsely bench windows
/// that still have quota.
pub fn quota_used_percent_is_exhausted(used_percent: Option<f64>) -> bool {
    matches!(used_percent, Some(used) if used.is_finite() && used >= 100.0)
}

/// TS private `quotaWindowIsExhausted(window, now, updatedAt)`.
fn quota_window_is_exhausted(window: &QuotaCacheWindow, now: i64, updated_at: Option<f64>) -> bool {
    if let Some(reset_at_ms) = window.reset_at_ms
        && now as f64 >= reset_at_ms
    {
        return false;
    }
    // quota-forecast-02: a window can be 100% used with NO resetAtMs. Without
    // a staleness escape that reads as "exhausted forever". When we know when
    // the snapshot was taken (updatedAt) and the window length
    // (windowMinutes), synthesize a conservative expiry: once a full window
    // has elapsed since the snapshot, the window must have rolled over, so
    // stop treating it as exhausted.
    if window.reset_at_ms.is_none()
        && let Some(updated_at) = updated_at
        && let Some(window_minutes) = window.window_minutes
        && window_minutes > 0.0
        && now as f64 >= updated_at + window_minutes * 60_000.0
    {
        return false;
    }
    quota_used_percent_is_exhausted(window.used_percent)
}

/// TS `isQuotaCacheEntryExhausted(entry, now)` — true when EITHER window is
/// exhausted. Codex quota windows are cumulative gates: a 0%-remaining active
/// window blocks use even if the other window still has quota left.
pub fn is_quota_cache_entry_exhausted(entry: Option<&QuotaCacheEntry>, now: i64) -> bool {
    let Some(entry) = entry else {
        return false;
    };
    let updated_at = Some(entry.updated_at);
    quota_window_is_exhausted(&entry.primary, now, updated_at)
        || quota_window_is_exhausted(&entry.secondary, now, updated_at)
}

/// TS `findQuotaCacheEntryForAccount(cache, account, accounts)` (the default
/// `emailFallbackState` overload) — builds the fallback state internally.
pub fn find_quota_cache_entry_for_account<'c, T: QuotaCacheAccountRef>(
    cache: Option<&'c QuotaCacheData>,
    account: &impl QuotaCacheAccountRef,
    accounts: &[T],
) -> Option<&'c QuotaCacheEntry> {
    let email_fallback_state = build_quota_email_fallback_state(accounts);
    find_quota_cache_entry_for_account_with_state(cache, account, accounts, &email_fallback_state)
}

/// TS `findQuotaCacheEntryForAccount(cache, account, accounts, state)` with a
/// caller-precomputed email fallback state.
///
/// `byAccountId` is consulted only when the accountId normalizes AND is
/// unique among `accounts`; `byEmail` only when the email fallback is safe.
/// Duplicate accountIds or ambiguous emails deliberately get NO cache entry.
pub fn find_quota_cache_entry_for_account_with_state<'c, T: QuotaCacheAccountRef>(
    cache: Option<&'c QuotaCacheData>,
    account: &impl QuotaCacheAccountRef,
    accounts: &[T],
    email_fallback_state: &HashMap<String, QuotaEmailFallbackState>,
) -> Option<&'c QuotaCacheEntry> {
    let cache = cache?;
    if let Some(account_id) = normalize_quota_account_id(account.quota_account_id())
        && has_unique_quota_account_id(accounts, account)
        && let Some(entry) = cache.by_account_id.get(&account_id)
    {
        return Some(entry);
    }
    if let Some(email) = normalize_quota_email(account.quota_email())
        && has_safe_quota_email_fallback(email_fallback_state, account)
        && let Some(entry) = cache.by_email.get(&email)
    {
        return Some(entry);
    }
    None
}

// ============================================================================
// Tests — ported from test/quota-readiness.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn window(
        used_percent: Option<f64>,
        window_minutes: Option<f64>,
        reset_at_ms: Option<f64>,
    ) -> QuotaCacheWindow {
        QuotaCacheWindow {
            used_percent,
            window_minutes,
            reset_at_ms,
        }
    }

    fn entry(
        updated_at: f64,
        primary: QuotaCacheWindow,
        secondary: QuotaCacheWindow,
    ) -> QuotaCacheEntry {
        QuotaCacheEntry {
            updated_at,
            status: 200.0,
            model: "gpt-5.3-codex".to_string(),
            plan_type: None,
            primary,
            secondary,
        }
    }

    const NOW: i64 = 1_700_000_000_000;

    // -- isQuotaCacheEntryExhausted ------------------------------------------

    #[test]
    fn treats_either_exhausted_quota_window_as_unavailable() {
        let primary_exhausted = entry(
            NOW as f64,
            window(Some(100.0), None, Some((NOW + 60_000) as f64)),
            window(Some(20.0), None, None),
        );
        assert!(is_quota_cache_entry_exhausted(
            Some(&primary_exhausted),
            NOW
        ));

        let secondary_exhausted = entry(
            NOW as f64,
            window(Some(20.0), None, None),
            window(Some(100.0), None, Some((NOW + 60_000) as f64)),
        );
        assert!(is_quota_cache_entry_exhausted(
            Some(&secondary_exhausted),
            NOW
        ));
    }

    #[test]
    fn keeps_accounts_available_when_both_known_windows_have_quota_left() {
        let healthy = entry(
            NOW as f64,
            window(Some(42.0), None, Some((NOW + 60_000) as f64)),
            window(Some(63.0), None, Some((NOW + 600_000) as f64)),
        );
        assert!(!is_quota_cache_entry_exhausted(Some(&healthy), NOW));
        assert!(!is_quota_cache_entry_exhausted(None, NOW));
    }

    #[test]
    fn does_not_bench_a_window_with_fractional_quota_just_above_99_5_used() {
        // 99.6% used rounds to 0% left, but the raw value is < 100: still quota.
        let fractional = entry(
            NOW as f64,
            window(Some(99.6), None, Some((NOW + 60_000) as f64)),
            window(Some(10.0), None, None),
        );
        assert_eq!(quota_left_percent_from_used(Some(99.6)), Some(0));
        assert!(!quota_used_percent_is_exhausted(Some(99.6)));
        assert!(!is_quota_cache_entry_exhausted(Some(&fractional), NOW));
    }

    #[test]
    fn does_not_treat_expired_quota_windows_as_exhausted() {
        let expired = entry(
            (NOW - 600_000) as f64,
            window(Some(100.0), None, Some((NOW - 1) as f64)),
            window(Some(100.0), None, Some((NOW - 60_000) as f64)),
        );
        assert!(!is_quota_cache_entry_exhausted(Some(&expired), NOW));
    }

    #[test]
    fn expires_an_exhausted_window_with_no_reset_at_after_window_minutes_elapse() {
        // 300-minute window, snapshot taken 301 minutes ago, no resetAtMs.
        let stale = entry(
            (NOW - 301 * 60_000) as f64,
            window(Some(100.0), Some(300.0), None),
            window(Some(10.0), None, None),
        );
        assert!(!is_quota_cache_entry_exhausted(Some(&stale), NOW));
    }

    #[test]
    fn still_reports_exhausted_with_no_reset_at_before_the_window_elapses() {
        let fresh = entry(
            (NOW - 60_000) as f64,
            window(Some(100.0), Some(300.0), None),
            window(Some(10.0), None, None),
        );
        assert!(is_quota_cache_entry_exhausted(Some(&fresh), NOW));
    }

    #[test]
    fn expires_an_exhausted_secondary_window_with_no_reset_at_after_its_window_elapses() {
        let stale_secondary = entry(
            (NOW - 10_081 * 60_000) as f64,
            window(Some(10.0), Some(300.0), None),
            window(Some(100.0), Some(10_080.0), None),
        );
        assert!(!is_quota_cache_entry_exhausted(Some(&stale_secondary), NOW));
    }

    #[test]
    fn treats_the_exact_window_boundary_as_expired_inclusive() {
        // now == updatedAt + windowMinutes * 60_000 exactly.
        let boundary = entry(
            (NOW - 300 * 60_000) as f64,
            window(Some(100.0), Some(300.0), None),
            window(Some(10.0), None, None),
        );
        assert!(!is_quota_cache_entry_exhausted(Some(&boundary), NOW));
    }

    #[test]
    fn stays_exhausted_when_window_minutes_is_missing() {
        let no_window = entry(
            (NOW - 100 * 86_400_000) as f64,
            window(Some(100.0), None, None),
            window(Some(10.0), None, None),
        );
        assert!(is_quota_cache_entry_exhausted(Some(&no_window), NOW));
    }

    #[test]
    fn stays_exhausted_when_window_minutes_is_zero_or_negative() {
        for minutes in [0.0, -300.0] {
            let bad_minutes = entry(
                (NOW - 100 * 86_400_000) as f64,
                window(Some(100.0), Some(minutes), None),
                window(Some(10.0), None, None),
            );
            assert!(
                is_quota_cache_entry_exhausted(Some(&bad_minutes), NOW),
                "windowMinutes {minutes} must not enable the staleness escape"
            );
        }
    }

    #[test]
    fn does_not_prematurely_expire_when_updated_at_is_in_the_future_clock_skew() {
        let future_snapshot = entry(
            (NOW + 60_000) as f64,
            window(Some(100.0), Some(300.0), None),
            window(Some(10.0), None, None),
        );
        assert!(is_quota_cache_entry_exhausted(Some(&future_snapshot), NOW));
    }

    // -- keying rules --------------------------------------------------------

    fn account(account_id: Option<&str>, email: Option<&str>) -> QuotaAccountRef {
        QuotaAccountRef {
            account_id: account_id.map(str::to_string),
            email: email.map(str::to_string),
        }
    }

    #[test]
    fn normalizers_trim_and_lowercase() {
        assert_eq!(
            normalize_quota_account_id(Some("  acc_1  ")),
            Some("acc_1".to_string())
        );
        assert_eq!(normalize_quota_account_id(Some("   ")), None);
        assert_eq!(normalize_quota_account_id(None), None);
        assert_eq!(
            normalize_quota_email(Some("  User@Example.COM ")),
            Some("user@example.com".to_string())
        );
        assert_eq!(normalize_quota_email(Some("")), None);
        assert_eq!(normalize_quota_email(None), None);
    }

    #[test]
    fn unique_account_id_requires_exactly_one_match() {
        let a = account(Some("acc_1"), Some("a@example.com"));
        let b = account(Some("acc_2"), Some("b@example.com"));
        let dup = account(Some("acc_1"), Some("c@example.com"));

        assert!(has_unique_quota_account_id(
            &[a.clone(), b.clone()],
            &a.clone()
        ));
        assert!(!has_unique_quota_account_id(
            &[a.clone(), b.clone(), dup.clone()],
            &a.clone()
        ));
        let no_id = account(None, Some("x@example.com"));
        assert!(!has_unique_quota_account_id(
            std::slice::from_ref(&no_id),
            &no_id
        ));
    }

    #[test]
    fn email_fallback_is_safe_only_for_a_single_unambiguous_account() {
        let solo = account(None, Some("solo@example.com"));
        let dup_a = account(Some("acc_1"), Some("dup@example.com"));
        let dup_b = account(Some("acc_2"), Some("dup@example.com"));
        let accounts = vec![solo.clone(), dup_a.clone(), dup_b.clone()];
        let state = build_quota_email_fallback_state(&accounts);

        assert!(has_safe_quota_email_fallback(&state, &solo));
        assert!(!has_safe_quota_email_fallback(&state, &dup_a));
        assert!(!has_safe_quota_email_fallback(&state, &dup_b));
        assert!(!has_safe_quota_email_fallback(&state, &account(None, None)));
    }

    #[test]
    fn find_entry_prefers_unique_account_id_then_safe_email() {
        let mut cache = QuotaCacheData::default();
        cache.by_account_id.insert(
            "acc_1",
            entry(
                NOW as f64,
                window(Some(1.0), None, None),
                window(None, None, None),
            ),
        );
        cache.by_email.insert(
            "mail@example.com",
            entry(
                NOW as f64,
                window(Some(2.0), None, None),
                window(None, None, None),
            ),
        );

        let by_id = account(Some("acc_1"), Some("mail@example.com"));
        let accounts = vec![by_id.clone()];
        let found = find_quota_cache_entry_for_account(Some(&cache), &by_id, &accounts)
            .expect("entry by accountId");
        assert_eq!(found.primary.used_percent, Some(1.0));

        // Email fallback fires only when the account did not resolve by id.
        let by_email = account(None, Some("Mail@Example.com"));
        let accounts = vec![by_email.clone()];
        let found = find_quota_cache_entry_for_account(Some(&cache), &by_email, &accounts)
            .expect("entry by email");
        assert_eq!(found.primary.used_percent, Some(2.0));

        // Ambiguous email → no entry at all.
        let dup_a = account(Some("acc_a"), Some("mail@example.com"));
        let dup_b = account(Some("acc_b"), Some("mail@example.com"));
        let accounts = vec![dup_a.clone(), dup_b];
        assert!(find_quota_cache_entry_for_account(Some(&cache), &dup_a, &accounts).is_none());

        // Null cache → null.
        assert!(
            find_quota_cache_entry_for_account(None, &by_id, std::slice::from_ref(&by_id))
                .is_none()
        );
    }
}
