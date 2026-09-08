//! Port of `lib/codex-manager/quota-cache-helpers.ts`.
//!
//! Quota-cache lookup/update helpers shared by the manager CLI commands.
//! Behavior source: spec 09 §4.2. Safety rules (shared with
//! `lib/quota-readiness.ts`): an entry may be read from / written to
//! `byAccountId[id]` only when the normalized id is non-null AND unique among
//! the accounts; `byEmail[email]` only under the safe-email-fallback rule.
//! Stale/unsafe email entries are actively pruned on update.

use std::collections::HashMap;

use cma_core::model_family::{DEFAULT_MODEL, DEFAULT_PROBE_MODEL};
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::RateLimitStateV3;
use cma_core::utils::now_ms;
use cma_quota::cache::{QuotaCacheData, QuotaCacheEntry, QuotaCacheWindow};
use cma_quota::probe::CodexQuotaSnapshot;
use cma_quota::readiness::{
    build_quota_email_fallback_state, has_safe_quota_email_fallback, has_unique_quota_account_id,
    normalize_quota_account_id, normalize_quota_email, QuotaCacheAccountRef,
    QuotaEmailFallbackState,
};
use cma_runtime::account_status::get_rate_limit_reset_time_for_family;

/// TS `DEFAULT_LIVE_PROBE_MODEL` — default model used for live quota probes
/// across manager commands (= `DEFAULT_PROBE_MODEL` = `"gpt-5.6-sol"`).
pub const DEFAULT_LIVE_PROBE_MODEL: &str = DEFAULT_PROBE_MODEL;

/// TS private `getQuotaCacheEntryForAccount(cache, account, accounts, state?)`.
fn get_quota_cache_entry_for_account<'c, T: QuotaCacheAccountRef>(
    cache: &'c QuotaCacheData,
    account: &impl QuotaCacheAccountRef,
    accounts: &[T],
    email_fallback_state: &HashMap<String, QuotaEmailFallbackState>,
) -> Option<&'c QuotaCacheEntry> {
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

/// Account view needed by [`get_persisted_quota_view_for_account`]:
/// TS `Pick<AccountMetadataV3, "accountId" | "email" | "rateLimitResetTimes">`.
pub struct PersistedQuotaViewAccount<'a> {
    pub account_id: Option<&'a str>,
    pub email: Option<&'a str>,
    pub rate_limit_reset_times: Option<&'a RateLimitStateV3>,
}

impl QuotaCacheAccountRef for PersistedQuotaViewAccount<'_> {
    fn quota_account_id(&self) -> Option<&str> {
        self.account_id
    }
    fn quota_email(&self) -> Option<&str> {
        self.email
    }
}

/// TS `getPersistedQuotaViewForAccount(cache, account, accounts, now, state?)`.
///
/// Fetches the cached entry (accountId key first, safe-email fallback), then
/// overlays the persisted rate-limit reset time for family `"codex"`: when the
/// storage tracks a future reset that the cached entry does not already cover
/// as a 429, synthesize a 429 view so storage-tracked rate limiting always
/// shows through the quota view.
pub fn get_persisted_quota_view_for_account<T: QuotaCacheAccountRef>(
    cache: Option<&QuotaCacheData>,
    account: &PersistedQuotaViewAccount<'_>,
    accounts: &[T],
    now: i64,
    email_fallback_state: Option<&HashMap<String, QuotaEmailFallbackState>>,
) -> Option<QuotaCacheEntry> {
    let built_state;
    let state = match email_fallback_state {
        Some(state) => state,
        None => {
            built_state = build_quota_email_fallback_state(accounts);
            &built_state
        }
    };
    let cached_entry =
        cache.and_then(|cache| get_quota_cache_entry_for_account(cache, account, accounts, state));
    let persisted_reset_at =
        get_rate_limit_reset_time_for_family(account.rate_limit_reset_times, now, ModelFamily::Codex);
    let Some(persisted_reset_at) = persisted_reset_at else {
        return cached_entry.cloned();
    };
    let cached_primary_reset_at = cached_entry
        .and_then(|entry| entry.primary.reset_at_ms)
        .unwrap_or(0.0);
    let cached_secondary_reset_at = cached_entry
        .and_then(|entry| entry.secondary.reset_at_ms)
        .unwrap_or(0.0);
    if let Some(entry) = cached_entry
        && entry.status == 429.0
        && cached_primary_reset_at.max(cached_secondary_reset_at) >= persisted_reset_at as f64
    {
        return Some(entry.clone());
    }
    Some(QuotaCacheEntry {
        updated_at: cached_entry
            .map(|entry| entry.updated_at)
            .unwrap_or(now as f64),
        status: 429.0,
        model: cached_entry
            .map(|entry| entry.model.clone())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        plan_type: cached_entry.and_then(|entry| entry.plan_type.clone()),
        primary: QuotaCacheWindow {
            used_percent: cached_entry.and_then(|entry| entry.primary.used_percent),
            window_minutes: cached_entry.and_then(|entry| entry.primary.window_minutes),
            reset_at_ms: Some(cached_primary_reset_at.max(persisted_reset_at as f64)),
        },
        secondary: cached_entry
            .map(|entry| entry.secondary)
            .unwrap_or_default(),
    })
}

/// TS `updateQuotaCacheForAccount(cache, account, snapshot, accounts, state?)`
/// — returns whether anything changed. Writes `byAccountId[id]` when the id
/// is unique; writes `byEmail[email]` only when the email is safe AND no
/// unique accountId (id key takes priority); otherwise an existing email key
/// is DELETED (stale/unsafe email entries are actively pruned).
pub fn update_quota_cache_for_account<T: QuotaCacheAccountRef>(
    cache: &mut QuotaCacheData,
    account: &impl QuotaCacheAccountRef,
    snapshot: &CodexQuotaSnapshot,
    accounts: &[T],
    email_fallback_state: Option<&HashMap<String, QuotaEmailFallbackState>>,
) -> bool {
    let built_state;
    let state = match email_fallback_state {
        Some(state) => state,
        None => {
            built_state = build_quota_email_fallback_state(accounts);
            &built_state
        }
    };
    let next_entry = QuotaCacheEntry {
        updated_at: now_ms() as f64,
        status: snapshot.status as f64,
        model: snapshot.model.clone(),
        plan_type: snapshot.plan_type.clone(),
        primary: QuotaCacheWindow {
            used_percent: snapshot.primary.used_percent,
            window_minutes: snapshot.primary.window_minutes.map(|v| v as f64),
            reset_at_ms: snapshot.primary.reset_at_ms.map(|v| v as f64),
        },
        secondary: QuotaCacheWindow {
            used_percent: snapshot.secondary.used_percent,
            window_minutes: snapshot.secondary.window_minutes.map(|v| v as f64),
            reset_at_ms: snapshot.secondary.reset_at_ms.map(|v| v as f64),
        },
    };

    let mut changed = false;
    let account_id = normalize_quota_account_id(account.quota_account_id());
    let has_unique_account_id =
        account_id.is_some() && has_unique_quota_account_id(accounts, account);
    if has_unique_account_id {
        // account_id is Some here by construction.
        if let Some(account_id) = &account_id {
            cache.by_account_id.insert(account_id.clone(), next_entry.clone());
            changed = true;
        }
    }
    let email = normalize_quota_email(account.quota_email());
    if let Some(email) = &email
        && has_safe_quota_email_fallback(state, account)
        && !has_unique_account_id
    {
        cache.by_email.insert(email.clone(), next_entry);
        changed = true;
    } else if let Some(email) = &email
        && cache.by_email.contains_key(email)
    {
        cache.by_email.remove(email);
        changed = true;
    }
    changed
}

/// TS `cloneQuotaCacheData(cache)` — shallow spread of both maps. Safe
/// because quota cache entries are always REPLACED whole, never mutated in
/// place. Porters: preserve replace-not-mutate.
pub fn clone_quota_cache_data(cache: &QuotaCacheData) -> QuotaCacheData {
    cache.clone()
}

/// TS `pruneUnsafeQuotaEmailCacheEntry(cache, email, accounts, state)` —
/// deletes `byEmail[normalized]` when no account with that email still has a
/// safe fallback; used after an account's email changed identity during
/// refresh. Returns whether an entry was removed.
pub fn prune_unsafe_quota_email_cache_entry<T: QuotaCacheAccountRef>(
    cache: &mut QuotaCacheData,
    email: Option<&str>,
    accounts: &[T],
    email_fallback_state: &HashMap<String, QuotaEmailFallbackState>,
) -> bool {
    let Some(normalized_email) = normalize_quota_email(email) else {
        return false;
    };
    if !cache.by_email.contains_key(&normalized_email) {
        return false;
    }
    let has_safe_fallback_account = accounts.iter().any(|account| {
        normalize_quota_email(account.quota_email()).as_deref() == Some(normalized_email.as_str())
            && has_safe_quota_email_fallback(email_fallback_state, account)
    });
    if has_safe_fallback_account {
        return false;
    }
    cache.by_email.remove(&normalized_email);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_quota::probe::CodexQuotaWindow;
    use cma_quota::readiness::QuotaAccountRef;

    fn account(id: Option<&str>, email: Option<&str>) -> QuotaAccountRef {
        QuotaAccountRef {
            account_id: id.map(str::to_string),
            email: email.map(str::to_string),
        }
    }

    fn snapshot(status: u16) -> CodexQuotaSnapshot {
        CodexQuotaSnapshot {
            status,
            plan_type: Some("plus".to_string()),
            active_limit: None,
            primary: CodexQuotaWindow {
                used_percent: Some(10.0),
                window_minutes: Some(300),
                reset_at_ms: Some(1_000),
            },
            secondary: CodexQuotaWindow::default(),
            model: "gpt-5.5".to_string(),
        }
    }

    #[test]
    fn update_prefers_unique_account_id_key() {
        let mut cache = QuotaCacheData::default();
        let accounts = vec![account(Some("acct-1"), Some("a@x.com"))];
        let changed = update_quota_cache_for_account(
            &mut cache,
            &accounts[0],
            &snapshot(200),
            &accounts,
            None,
        );
        assert!(changed);
        assert!(cache.by_account_id.contains_key("acct-1"));
        assert!(!cache.by_email.contains_key("a@x.com"));
    }

    #[test]
    fn update_falls_back_to_safe_email_without_account_id() {
        let mut cache = QuotaCacheData::default();
        let accounts = vec![account(None, Some("A@X.com"))];
        let changed = update_quota_cache_for_account(
            &mut cache,
            &accounts[0],
            &snapshot(200),
            &accounts,
            None,
        );
        assert!(changed);
        assert!(cache.by_email.contains_key("a@x.com"));
    }

    #[test]
    fn update_deletes_stale_email_entry_when_id_key_takes_priority() {
        let mut cache = QuotaCacheData::default();
        let accounts = vec![account(Some("acct-1"), Some("a@x.com"))];
        // Seed a stale email entry, then update: the id key wins and the email
        // key is actively pruned.
        let stale = QuotaCacheEntry {
            updated_at: 1.0,
            status: 200.0,
            model: "gpt-5.5".to_string(),
            plan_type: None,
            primary: QuotaCacheWindow::default(),
            secondary: QuotaCacheWindow::default(),
        };
        cache.by_email.insert("a@x.com".to_string(), stale);
        let changed = update_quota_cache_for_account(
            &mut cache,
            &accounts[0],
            &snapshot(200),
            &accounts,
            None,
        );
        assert!(changed);
        assert!(cache.by_account_id.contains_key("acct-1"));
        assert!(!cache.by_email.contains_key("a@x.com"));
    }

    #[test]
    fn duplicate_account_ids_and_ambiguous_emails_write_nothing_but_prune() {
        let mut cache = QuotaCacheData::default();
        let accounts = vec![
            account(Some("dup"), Some("a@x.com")),
            account(Some("dup"), Some("a@x.com")),
        ];
        let changed = update_quota_cache_for_account(
            &mut cache,
            &accounts[0],
            &snapshot(200),
            &accounts,
            None,
        );
        assert!(!changed);
        assert!(cache.by_account_id.is_empty());
        assert!(cache.by_email.is_empty());
    }

    #[test]
    fn persisted_view_synthesizes_429_from_storage_reset_time() {
        let mut times = RateLimitStateV3::new();
        times.insert("codex", 5_000);
        let accounts = vec![account(Some("acct-1"), Some("a@x.com"))];
        let view = get_persisted_quota_view_for_account(
            None,
            &PersistedQuotaViewAccount {
                account_id: Some("acct-1"),
                email: Some("a@x.com"),
                rate_limit_reset_times: Some(&times),
            },
            &accounts,
            1_000,
            None,
        )
        .expect("view");
        assert_eq!(view.status, 429.0);
        assert_eq!(view.model, DEFAULT_MODEL);
        assert_eq!(view.updated_at, 1_000.0);
        assert_eq!(view.primary.reset_at_ms, Some(5_000.0));
    }

    #[test]
    fn persisted_view_keeps_cached_429_covering_the_persisted_reset() {
        let mut times = RateLimitStateV3::new();
        times.insert("codex", 5_000);
        let mut cache = QuotaCacheData::default();
        let cached = QuotaCacheEntry {
            updated_at: 900.0,
            status: 429.0,
            model: "gpt-5.5".to_string(),
            plan_type: None,
            primary: QuotaCacheWindow {
                used_percent: None,
                window_minutes: None,
                reset_at_ms: Some(9_000.0),
            },
            secondary: QuotaCacheWindow::default(),
        };
        cache.by_account_id.insert("acct-1".to_string(), cached.clone());
        let accounts = vec![account(Some("acct-1"), Some("a@x.com"))];
        let view = get_persisted_quota_view_for_account(
            Some(&cache),
            &PersistedQuotaViewAccount {
                account_id: Some("acct-1"),
                email: Some("a@x.com"),
                rate_limit_reset_times: Some(&times),
            },
            &accounts,
            1_000,
            None,
        )
        .expect("view");
        assert_eq!(view, cached);
    }

    #[test]
    fn persisted_view_without_reset_time_returns_cached_entry() {
        let accounts = vec![account(Some("acct-1"), None)];
        let view = get_persisted_quota_view_for_account(
            None,
            &PersistedQuotaViewAccount {
                account_id: Some("acct-1"),
                email: None,
                rate_limit_reset_times: None,
            },
            &accounts,
            1_000,
            None,
        );
        assert!(view.is_none());
    }

    #[test]
    fn prune_removes_email_entry_without_safe_fallback() {
        let mut cache = QuotaCacheData::default();
        let entry = QuotaCacheEntry {
            updated_at: 1.0,
            status: 200.0,
            model: "gpt-5.5".to_string(),
            plan_type: None,
            primary: QuotaCacheWindow::default(),
            secondary: QuotaCacheWindow::default(),
        };
        cache.by_email.insert("a@x.com".to_string(), entry);
        // Two accounts share the email: no safe fallback remains.
        let accounts = vec![
            account(Some("one"), Some("a@x.com")),
            account(Some("two"), Some("a@x.com")),
        ];
        let state = build_quota_email_fallback_state(&accounts);
        assert!(prune_unsafe_quota_email_cache_entry(
            &mut cache,
            Some("a@x.com"),
            &accounts,
            &state,
        ));
        assert!(!cache.by_email.contains_key("a@x.com"));
        // Second prune is a no-op.
        assert!(!prune_unsafe_quota_email_cache_entry(
            &mut cache,
            Some("a@x.com"),
            &accounts,
            &state,
        ));
    }

    #[test]
    fn prune_keeps_email_entry_with_safe_fallback() {
        let mut cache = QuotaCacheData::default();
        let entry = QuotaCacheEntry {
            updated_at: 1.0,
            status: 200.0,
            model: "gpt-5.5".to_string(),
            plan_type: None,
            primary: QuotaCacheWindow::default(),
            secondary: QuotaCacheWindow::default(),
        };
        cache.by_email.insert("a@x.com".to_string(), entry);
        let accounts = vec![account(Some("one"), Some("a@x.com"))];
        let state = build_quota_email_fallback_state(&accounts);
        assert!(!prune_unsafe_quota_email_cache_entry(
            &mut cache,
            Some("a@x.com"),
            &accounts,
            &state,
        ));
        assert!(cache.by_email.contains_key("a@x.com"));
    }
}
