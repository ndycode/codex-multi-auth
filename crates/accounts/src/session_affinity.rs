//! Port of `lib/session-affinity.ts` — in-memory session-key → account-index
//! affinity store (spec 03 §7).
//!
//! Tracks the preferred account index per session so follow-up turns stay on
//! the same account until it becomes unhealthy or stale. In-memory ONLY —
//! nothing here is ever persisted.
//!
//! Behavior contracts (spec 03 §7 + gotchas 24/25):
//! - 20-min default TTL (floor 1 s), 512-entry default cap (floor 1).
//! - Session keys are trimmed and truncated to 256 characters.
//! - Write-version conflict control: an existing LIVE entry with a strictly
//!   greater `write_version` blocks a write; an EQUAL version overwrites.
//!   Explicit versions ratchet the shared counter up (`max`).
//! - `update_last_response_id` never creates entries but DOES slide the TTL.
//! - `remember` preserves the existing `last_response_id`.
//! - Eviction is by smallest `updated_at` (oldest), NOT insertion order.
//! - `clear_all` implements the generation-based full drop (#474): the CLI
//!   bumps `affinityGeneration` on `switch`/`unpin`/`best` and the proxy drops
//!   every sticky entry so manual changes take effect mid-thread.
//!
//! All time parameters are explicit epoch-ms values (`now`); production
//! callers pass `cma_core::utils::now_ms()` where the TS defaulted to
//! `Date.now()`.

use std::collections::HashMap;
use std::sync::LazyLock;

use cma_core::logger::{ScopedLogger, create_logger};
use serde_json::json;

static LOG: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("session-affinity"));

/// TS `DEFAULT_TTL_MS` = 20 minutes.
pub const DEFAULT_TTL_MS: i64 = 20 * 60 * 1000;
/// TS `DEFAULT_MAX_ENTRIES`.
pub const DEFAULT_MAX_ENTRIES: i64 = 512;
/// TS `MAX_SESSION_KEY_LENGTH` (characters, post-trim).
pub const MAX_SESSION_KEY_LENGTH: usize = 256;

/// TS `SessionAffinityOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionAffinityOptions {
    /// Entry time-to-live in ms (default 20 min, floored at 1 000 ms).
    pub ttl_ms: Option<i64>,
    /// Maximum tracked sessions (default 512, floored at 1).
    pub max_entries: Option<i64>,
}

#[derive(Debug, Clone)]
struct SessionAffinityEntry {
    account_index: i64,
    expires_at: i64,
    last_response_id: Option<String>,
    updated_at: i64,
    write_version: i64,
    /// Rust-only: deterministic tie-break for oldest-entry eviction. The TS
    /// `findOldestKey` resolves `updated_at` ties by Map insertion order
    /// (strict `<` keeps the first-iterated key); this sequence number
    /// reproduces that order over a `HashMap`.
    seq: u64,
}

/// Normalize a session key: trim, reject empty, truncate to
/// [`MAX_SESSION_KEY_LENGTH`] characters (TS `normalizeSessionKey`).
fn normalize_session_key(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_SESSION_KEY_LENGTH {
        return Some(trimmed.to_string());
    }
    Some(trimmed.chars().take(MAX_SESSION_KEY_LENGTH).collect())
}

/// TS `SessionAffinityStore` — tracks preferred account index per session.
pub struct SessionAffinityStore {
    ttl_ms: i64,
    max_entries: usize,
    entries: HashMap<String, SessionAffinityEntry>,
    write_version_counter: i64,
    next_seq: u64,
}

impl Default for SessionAffinityStore {
    fn default() -> Self {
        Self::new(SessionAffinityOptions::default())
    }
}

impl SessionAffinityStore {
    /// TS constructor: `ttlMs = max(1_000, floor(options.ttlMs ?? DEFAULT))`,
    /// `maxEntries = max(1, floor(options.maxEntries ?? DEFAULT))`.
    pub fn new(options: SessionAffinityOptions) -> Self {
        let ttl_ms = options.ttl_ms.unwrap_or(DEFAULT_TTL_MS).max(1_000);
        let max_entries = options.max_entries.unwrap_or(DEFAULT_MAX_ENTRIES).max(1) as usize;
        Self {
            ttl_ms,
            max_entries,
            entries: HashMap::new(),
            write_version_counter: 0,
            next_seq: 0,
        }
    }

    /// TS `getPreferredAccountIndex` — lazy expiry (`expiresAt <= now`
    /// deletes), returns the remembered account index while fresh.
    pub fn get_preferred_account_index(
        &mut self,
        session_key: Option<&str>,
        now: i64,
    ) -> Option<i64> {
        let key = normalize_session_key(session_key)?;
        let entry = self.entries.get(&key)?;
        if entry.expires_at <= now {
            self.entries.remove(&key);
            return None;
        }
        Some(entry.account_index)
    }

    /// TS `remember` — delegates to [`Self::remember_with_version`] with an
    /// implicit (auto-incremented) write version.
    pub fn remember(&mut self, session_key: Option<&str>, account_index: i64, now: i64) {
        self.remember_with_version(session_key, account_index, now, None);
    }

    /// TS `rememberWithVersion`. No-op on a bad key or negative index. An
    /// existing LIVE entry with a strictly greater `write_version` blocks the
    /// write (equal overwrites). Preserves the existing `last_response_id`.
    pub fn remember_with_version(
        &mut self,
        session_key: Option<&str>,
        account_index: i64,
        now: i64,
        write_version: Option<i64>,
    ) {
        let Some(key) = normalize_session_key(session_key) else {
            return;
        };
        if account_index < 0 {
            return;
        }
        let normalized_write_version = self.normalize_write_version(write_version);

        let existing = self.entries.get(&key);
        if let Some(existing_entry) = existing
            && existing_entry.expires_at > now
            && existing_entry.write_version > normalized_write_version
        {
            return;
        }

        let last_response_id = existing.and_then(|entry| entry.last_response_id.clone());
        let entry = SessionAffinityEntry {
            account_index,
            expires_at: now + self.ttl_ms,
            last_response_id,
            updated_at: now,
            write_version: normalized_write_version,
            seq: 0, // assigned by set_entry
        };
        self.set_entry(key, entry);
    }

    /// TS `getLastResponseId` — lazy expiry; returns the trimmed response id
    /// or `None` when empty/absent.
    pub fn get_last_response_id(&mut self, session_key: Option<&str>, now: i64) -> Option<String> {
        let key = normalize_session_key(session_key)?;
        let entry = self.entries.get(&key)?;
        if entry.expires_at <= now {
            self.entries.remove(&key);
            return None;
        }
        let last_response_id = entry
            .last_response_id
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        if last_response_id.is_empty() {
            None
        } else {
            Some(last_response_id.to_string())
        }
    }

    /// TS `rememberLastResponseId` — alias of
    /// [`Self::update_last_response_id`] with an implicit version.
    pub fn remember_last_response_id(
        &mut self,
        session_key: Option<&str>,
        response_id: Option<&str>,
        now: i64,
    ) {
        self.update_last_response_id(session_key, response_id, now, None);
    }

    /// TS `updateLastResponseId`. Does NOT create entries: a missing entry is
    /// a no-op; an expired entry is deleted (no-op). A strictly greater
    /// existing `write_version` blocks the write. On success the entry's TTL
    /// slides (`expires_at = now + ttl`).
    pub fn update_last_response_id(
        &mut self,
        session_key: Option<&str>,
        response_id: Option<&str>,
        now: i64,
        write_version: Option<i64>,
    ) {
        let key = normalize_session_key(session_key);
        let normalized_response_id = response_id.map(str::trim).unwrap_or("");
        let Some(key) = key else { return };
        if normalized_response_id.is_empty() {
            return;
        }
        // The TS normalizes the write version only after the guards above, so
        // the implicit counter is not consumed on invalid input.
        let normalized_write_version = self.normalize_write_version(write_version);

        let Some(entry) = self.entries.get(&key) else {
            return;
        };
        if entry.expires_at <= now {
            self.entries.remove(&key);
            return;
        }
        if entry.write_version > normalized_write_version {
            return;
        }

        let updated = SessionAffinityEntry {
            expires_at: now + self.ttl_ms,
            last_response_id: Some(normalized_response_id.to_string()),
            updated_at: now,
            write_version: normalized_write_version,
            ..entry.clone()
        };
        self.set_entry(key, updated);
    }

    /// TS `forgetSession`.
    pub fn forget_session(&mut self, session_key: Option<&str>) {
        let Some(key) = normalize_session_key(session_key) else {
            return;
        };
        self.entries.remove(&key);
    }

    /// TS `forgetAccount` — drops every entry pinned to `account_index`;
    /// returns the removed count. `0` for negative indexes.
    pub fn forget_account(&mut self, account_index: i64) -> usize {
        if account_index < 0 {
            return 0;
        }
        let before = self.entries.len();
        self.entries
            .retain(|_, entry| entry.account_index != account_index);
        let removed = before - self.entries.len();
        if removed > 0 {
            LOG.debug(
                "Cleared session affinity entries for account",
                Some(&json!({
                    "accountIndex": account_index,
                    "removed": removed,
                })),
            );
        }
        removed
    }

    /// TS `reindexAfterRemoval` — shifts every entry with
    /// `account_index > removed_index` down by one; returns the shifted count.
    /// Entries pointing AT the removed index are untouched (callers use
    /// [`Self::forget_account`] first).
    pub fn reindex_after_removal(&mut self, removed_index: i64) -> usize {
        if removed_index < 0 {
            return 0;
        }
        let mut shifted = 0;
        for entry in self.entries.values_mut() {
            if entry.account_index > removed_index {
                entry.account_index -= 1;
                shifted += 1;
            }
        }
        shifted
    }

    /// TS `prune` — deletes expired entries; returns the removed count.
    pub fn prune(&mut self, now: i64) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, entry| entry.expires_at > now);
        before - self.entries.len()
    }

    /// TS `clearAll` — drop every entry. Used when the CLI bumps
    /// `affinityGeneration` (`switch`/`unpin`/`best`, #474) so manual changes
    /// take effect even mid-thread.
    pub fn clear_all(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        self.entries.clear();
    }

    /// TS `size`.
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    /// TS `normalizeWriteVersion`: explicit finite version → `max(0, floor)`
    /// AND ratchets the shared counter up; implicit → `++counter`.
    fn normalize_write_version(&mut self, write_version: Option<i64>) -> i64 {
        match write_version {
            Some(version) => {
                let normalized = version.max(0);
                self.write_version_counter = self.write_version_counter.max(normalized);
                normalized
            }
            None => {
                self.write_version_counter += 1;
                self.write_version_counter
            }
        }
    }

    /// TS `setEntry` — evicts the oldest entry (smallest `updated_at`, ties
    /// broken by insertion order) when inserting a NEW key at capacity.
    fn set_entry(&mut self, key: String, mut entry: SessionAffinityEntry) {
        let existing_seq = self.entries.get(&key).map(|existing| existing.seq);
        if self.entries.len() >= self.max_entries
            && existing_seq.is_none()
            && let Some(oldest) = self.find_oldest_key()
        {
            self.entries.remove(&oldest);
        }
        entry.seq = existing_seq.unwrap_or_else(|| {
            self.next_seq += 1;
            self.next_seq
        });
        self.entries.insert(key, entry);
    }

    /// TS `findOldestKey` — full linear scan for the smallest `updated_at`
    /// (strict `<`, so ties keep the earliest-inserted entry).
    fn find_oldest_key(&self) -> Option<String> {
        self.entries
            .iter()
            .min_by_key(|(_, entry)| (entry.updated_at, entry.seq))
            .map(|(key, _)| key.clone())
    }
}

// ============================================================================
// Tests — ported from test/session-affinity.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn store(ttl_ms: i64, max_entries: i64) -> SessionAffinityStore {
        SessionAffinityStore::new(SessionAffinityOptions {
            ttl_ms: Some(ttl_ms),
            max_entries: Some(max_entries),
        })
    }

    #[test]
    fn returns_remembered_account_while_entry_is_fresh() {
        let mut store = store(10_000, DEFAULT_MAX_ENTRIES);
        store.remember(Some("session-a"), 2, 1_000);
        assert_eq!(
            store.get_preferred_account_index(Some("session-a"), 5_000),
            Some(2)
        );
    }

    #[test]
    fn expires_entries_after_ttl() {
        let mut store = store(1_000, DEFAULT_MAX_ENTRIES);
        store.remember(Some("session-a"), 1, 1_000);
        assert_eq!(
            store.get_preferred_account_index(Some("session-a"), 2_500),
            None
        );
        assert_eq!(store.size(), 0);
    }

    #[test]
    fn evicts_oldest_entry_when_max_size_is_reached() {
        let mut store = store(60_000, 2);
        store.remember(Some("s1"), 0, 1_000);
        store.remember(Some("s2"), 1, 2_000);
        store.remember(Some("s3"), 2, 3_000);

        assert_eq!(store.get_preferred_account_index(Some("s1"), 3_100), None);
        assert_eq!(store.get_preferred_account_index(Some("s2"), 3_100), Some(1));
        assert_eq!(store.get_preferred_account_index(Some("s3"), 3_100), Some(2));
    }

    #[test]
    fn forgets_all_sessions_mapped_to_account() {
        let mut store = store(60_000, 10);
        store.remember(Some("s1"), 0, 1_000);
        store.remember(Some("s2"), 1, 1_000);
        store.remember(Some("s3"), 1, 1_000);

        let removed = store.forget_account(1);
        assert_eq!(removed, 2);
        assert_eq!(store.get_preferred_account_index(Some("s2"), 1_500), None);
        assert_eq!(store.get_preferred_account_index(Some("s3"), 1_500), None);
        assert_eq!(store.get_preferred_account_index(Some("s1"), 1_500), Some(0));
    }

    #[test]
    fn reindexes_sessions_after_account_removal() {
        let mut store = store(60_000, 10);
        store.remember(Some("s1"), 0, 1_000);
        store.remember(Some("s2"), 2, 1_000);
        store.remember(Some("s3"), 3, 1_000);

        let shifted = store.reindex_after_removal(1);
        assert_eq!(shifted, 2);
        assert_eq!(store.get_preferred_account_index(Some("s2"), 1_500), Some(1));
        assert_eq!(store.get_preferred_account_index(Some("s3"), 1_500), Some(2));
    }

    #[test]
    fn rejects_invalid_session_keys_and_invalid_account_indices() {
        let mut store = store(10_000, 4);
        store.remember(Some("   "), 1, 1_000);
        store.remember(Some("session-y"), -1, 1_000);

        assert_eq!(
            store.get_preferred_account_index(Some("session-y"), 2_000),
            None
        );
        assert_eq!(store.get_preferred_account_index(None, 2_000), None);
        assert_eq!(store.size(), 0);
    }

    #[test]
    fn truncates_oversized_session_keys_and_retrieves_by_truncated_form() {
        let mut store = store(10_000, 8);
        let long_key = format!("  {}  ", "x".repeat(300));
        let truncated = "x".repeat(256);
        store.remember(Some(&long_key), 3, 1_000);

        assert_eq!(
            store.get_preferred_account_index(Some(&truncated), 2_000),
            Some(3)
        );
    }

    #[test]
    fn does_not_evict_when_updating_an_existing_key_at_capacity() {
        let mut store = store(60_000, 2);
        store.remember(Some("s1"), 0, 1_000);
        store.remember(Some("s2"), 1, 2_000);
        store.remember(Some("s2"), 2, 3_000);

        assert_eq!(store.get_preferred_account_index(Some("s1"), 3_500), Some(0));
        assert_eq!(store.get_preferred_account_index(Some("s2"), 3_500), Some(2));
        assert_eq!(store.size(), 2);
    }

    #[test]
    fn forgets_a_specific_session_and_noops_on_blank_session_key() {
        let mut store = store(60_000, 10);
        store.remember(Some("s1"), 0, 1_000);
        store.forget_session(Some("   "));
        store.forget_session(Some("s1"));

        assert_eq!(store.get_preferred_account_index(Some("s1"), 2_000), None);
        assert_eq!(store.size(), 0);
    }

    #[test]
    fn returns_zero_for_invalid_forget_reindex_requests() {
        let mut store = store(60_000, 10);
        store.remember(Some("s1"), 0, 1_000);

        assert_eq!(store.forget_account(-1), 0);
        assert_eq!(store.reindex_after_removal(-1), 0);
        assert_eq!(store.get_preferred_account_index(Some("s1"), 2_000), Some(0));
    }

    #[test]
    fn prunes_expired_sessions_and_keeps_non_expired_entries() {
        let mut store = store(1_000, 10);
        store.remember(Some("s1"), 0, 1_000);
        store.remember(Some("s2"), 1, 2_000);

        assert_eq!(store.prune(2_001), 1);
        assert_eq!(store.get_preferred_account_index(Some("s1"), 2_001), None);
        assert_eq!(store.get_preferred_account_index(Some("s2"), 2_001), Some(1));
    }

    #[test]
    fn updates_and_retrieves_the_last_response_id_for_a_live_session() {
        let mut store = store(10_000, 4);
        store.remember(Some("session-a"), 1, 1_000);
        store.update_last_response_id(Some("session-a"), Some("resp_123"), 2_000, None);

        assert_eq!(
            store.get_last_response_id(Some("session-a"), 2_500),
            Some("resp_123".to_string())
        );
        assert_eq!(
            store.get_preferred_account_index(Some("session-a"), 2_500),
            Some(1)
        );
    }

    #[test]
    fn does_not_persist_response_ids_for_missing_or_expired_sessions() {
        let mut store = store(1_000, 4);
        store.update_last_response_id(Some("missing"), Some("resp_missing"), 1_000, None);
        assert_eq!(store.get_last_response_id(Some("missing"), 1_500), None);

        store.remember(Some("session-a"), 1, 1_000);
        store.update_last_response_id(Some("session-a"), Some("resp_123"), 2_500, None);
        assert_eq!(store.get_last_response_id(Some("session-a"), 2_500), None);
        assert_eq!(store.size(), 0);
    }

    #[test]
    fn preserves_response_id_when_account_index_is_updated_via_remember() {
        let mut store = store(10_000, 4);
        store.remember(Some("session-a"), 1, 1_000);
        store.update_last_response_id(Some("session-a"), Some("resp_123"), 2_000, None);
        store.remember(Some("session-a"), 2, 3_000);

        assert_eq!(
            store.get_last_response_id(Some("session-a"), 3_500),
            Some("resp_123".to_string())
        );
        assert_eq!(
            store.get_preferred_account_index(Some("session-a"), 3_500),
            Some(2)
        );
    }

    #[test]
    fn ignores_stale_response_id_writes_from_older_overlapping_requests() {
        let mut store = store(10_000, 4);
        store.remember_with_version(Some("session-a"), 1, 1_000, Some(1));
        store.update_last_response_id(Some("session-a"), Some("resp_first"), 2_000, Some(1));
        store.remember_with_version(Some("session-a"), 2, 3_000, Some(2));
        store.update_last_response_id(Some("session-a"), Some("resp_second"), 4_000, Some(2));

        store.remember_with_version(Some("session-a"), 1, 5_000, Some(1));
        store.update_last_response_id(Some("session-a"), Some("resp_stale"), 5_000, Some(1));

        assert_eq!(
            store.get_preferred_account_index(Some("session-a"), 5_500),
            Some(2)
        );
        assert_eq!(
            store.get_last_response_id(Some("session-a"), 5_500),
            Some("resp_second".to_string())
        );
    }

    #[test]
    fn generates_distinct_default_write_versions_for_same_timestamp_overlaps() {
        let mut store = store(10_000, 4);
        store.remember_with_version(Some("session-a"), 0, 1_000, None);
        store.remember_with_version(Some("session-a"), 1, 1_000, None);

        assert_eq!(
            store.get_preferred_account_index(Some("session-a"), 1_500),
            Some(1)
        );
    }

    #[test]
    fn equal_write_version_overwrites_but_strictly_greater_blocks() {
        // Spec gotcha 24: strictly-greater blocks; EQUAL overwrites.
        let mut store = store(10_000, 4);
        store.remember_with_version(Some("s"), 1, 1_000, Some(5));
        store.remember_with_version(Some("s"), 2, 2_000, Some(5));
        assert_eq!(store.get_preferred_account_index(Some("s"), 2_500), Some(2));
        store.remember_with_version(Some("s"), 3, 3_000, Some(4));
        assert_eq!(store.get_preferred_account_index(Some("s"), 3_500), Some(2));
        // An EXPIRED higher-version entry no longer blocks.
        let mut expired = self::tests_store_expired();
        expired.remember_with_version(Some("s"), 1, 1_000, Some(9));
        expired.remember_with_version(Some("s"), 2, 5_000, Some(3));
        assert_eq!(expired.get_preferred_account_index(Some("s"), 5_500), Some(2));
    }

    fn tests_store_expired() -> SessionAffinityStore {
        SessionAffinityStore::new(SessionAffinityOptions {
            ttl_ms: Some(1_000),
            max_entries: Some(4),
        })
    }

    #[test]
    fn explicit_versions_ratchet_the_shared_counter() {
        let mut store = store(10_000, 4);
        store.remember_with_version(Some("a"), 1, 1_000, Some(10));
        // Implicit version continues ABOVE the ratcheted counter.
        store.remember_with_version(Some("a"), 2, 2_000, None);
        assert_eq!(store.get_preferred_account_index(Some("a"), 2_500), Some(2));
    }

    #[test]
    fn clear_all_drops_every_entry() {
        let mut store = store(60_000, 10);
        store.remember(Some("s1"), 0, 1_000);
        store.remember(Some("s2"), 1, 1_000);
        store.clear_all();
        assert_eq!(store.size(), 0);
    }

    #[test]
    fn negative_ttl_and_max_entries_clamp_to_floors() {
        let mut store = store(-5, -3); // ttl → 1_000, max_entries → 1
        store.remember(Some("a"), 0, 1_000);
        store.remember(Some("b"), 1, 2_000);
        assert_eq!(store.size(), 1);
        assert_eq!(store.get_preferred_account_index(Some("b"), 2_500), Some(1));
        assert_eq!(store.get_preferred_account_index(Some("b"), 3_000), None);
    }
}
