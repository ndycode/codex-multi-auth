//! Port of `lib/entitlement-cache.ts` — in-memory TTL cache of "this account
//! can't use this model" blocks (spec 03 §5).
//!
//! In-memory ONLY; nothing is ever persisted.
//!
//! Behavior contracts (spec 03 §5 + gotchas 20/26):
//! - Default block TTL 30 min; caller-provided TTLs floor at 1 s.
//! - At most 512 ACCOUNT buckets; eviction is FIFO of the first-inserted
//!   bucket and only triggers for NEW keys at the cap.
//! - Model normalization is the SIMPLE variant (no alias catalog): trim +
//!   lowercase, last `/` segment, strip ONE trailing reasoning suffix.
//! - `is_blocked` does lazy expiry (deletes the expired block and, when
//!   emptied, its bucket).
//! - `resolve_entitlement_account_key` never serializes refresh tokens.
//!
//! All time parameters are explicit epoch-ms values; production callers pass
//! `cma_core::utils::now_ms()` where the TS defaulted to `Date.now()`.

use std::collections::HashMap;
use std::sync::LazyLock;

use cma_core::logger::{ScopedLogger, create_logger};
use serde::{Deserialize, Serialize};
use serde_json::json;

static LOG: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("entitlement-cache"));

/// TS `DEFAULT_BLOCK_TTL_MS` = 30 minutes.
pub const DEFAULT_BLOCK_TTL_MS: i64 = 30 * 60_000;
/// TS `MAX_ACCOUNT_BUCKETS` (accounts, not blocks).
pub const MAX_ACCOUNT_BUCKETS: usize = 512;

/// TS `EntitlementBlock["reason"]` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntitlementBlockReason {
    #[serde(rename = "unsupported-model")]
    UnsupportedModel,
    #[serde(rename = "plan-entitlement")]
    PlanEntitlement,
}

impl EntitlementBlockReason {
    /// The exact TS literal.
    pub const fn as_str(self) -> &'static str {
        match self {
            EntitlementBlockReason::UnsupportedModel => "unsupported-model",
            EntitlementBlockReason::PlanEntitlement => "plan-entitlement",
        }
    }
}

impl std::fmt::Display for EntitlementBlockReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// TS `EntitlementBlock`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntitlementBlock {
    pub model: String,
    #[serde(rename = "blockedUntil")]
    pub blocked_until: i64,
    pub reason: EntitlementBlockReason,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// TS `EntitlementCacheSnapshot` — `{accounts: Record<string, Block[]>}`.
///
/// Rust keeps the account buckets as an ordered `Vec` (bucket insertion
/// order, matching the TS object key order) with a keyed [`Self::get`]
/// accessor.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EntitlementCacheSnapshot {
    pub accounts: Vec<(String, Vec<EntitlementBlock>)>,
}

impl EntitlementCacheSnapshot {
    /// Snapshot from pre-built buckets (test/matrix convenience).
    pub fn new(accounts: Vec<(String, Vec<EntitlementBlock>)>) -> Self {
        Self { accounts }
    }

    /// Blocks for `account_key` (the TS `snapshot.accounts[key]`).
    pub fn get(&self, account_key: &str) -> Option<&[EntitlementBlock]> {
        self.accounts
            .iter()
            .find(|(key, _)| key == account_key)
            .map(|(_, blocks)| blocks.as_slice())
    }

    /// `true` when no account has any blocks.
    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }
}

/// TS `EntitlementAccountRef`. `refresh_token` exists on the ref but is
/// deliberately never used in keys. `index: None` models the TS
/// non-finite-index case.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntitlementAccountRef {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub refresh_token: Option<String>,
    pub index: Option<i64>,
}

fn normalize_entitlement_email(email: Option<&str>) -> Option<String> {
    let trimmed = email?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_lowercase())
}

/// TS `resolveEntitlementAccountKey` — deterministic account cache key.
///
/// Precedence: `account:<id>::email:<email>` → `email:<email>` →
/// `account:<id>::idx:<n>` → `account:<id>` → `idx:<n>` (index defaults 0).
/// Forms 1 and 2 intentionally coincide with `getRuntimeAccountIdentityKey`
/// output for id+email / email-only accounts.
pub fn resolve_entitlement_account_key(account_ref: &EntitlementAccountRef) -> String {
    let account_id = account_ref
        .account_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    let has_index = account_ref.index.is_some();
    let index = account_ref.index.map(|value| value.max(0)).unwrap_or(0);
    let email = normalize_entitlement_email(account_ref.email.as_deref());
    match (account_id.is_empty(), email) {
        (false, Some(email)) => format!("account:{account_id}::email:{email}"),
        (true, Some(email)) => format!("email:{email}"),
        (false, None) if has_index => format!("account:{account_id}::idx:{index}"),
        (false, None) => format!("account:{account_id}"),
        (true, None) => format!("idx:{index}"),
    }
}

/// TS `normalizeModel` (entitlement variant — spec gotcha 20: SIMPLER than
/// capability-policy's, with NO alias-catalog lookup): trim + lowercase, last
/// `/` segment, strip ONE trailing `-(none|minimal|low|medium|high|xhigh)`.
fn normalize_model(model: Option<&str>) -> Option<String> {
    let trimmed = model?.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let stripped = if trimmed.contains('/') {
        trimmed.rsplit('/').next().unwrap_or(&trimmed)
    } else {
        &trimmed
    };
    const SUFFIXES: [&str; 6] = ["-none", "-minimal", "-low", "-medium", "-high", "-xhigh"];
    for suffix in SUFFIXES {
        if let Some(base) = stripped.strip_suffix(suffix) {
            return Some(base.to_string());
        }
    }
    Some(stripped.to_string())
}

/// Result of [`EntitlementCache::is_blocked`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntitlementBlockStatus {
    pub blocked: bool,
    pub wait_ms: i64,
    pub reason: Option<EntitlementBlockReason>,
}

impl EntitlementBlockStatus {
    const NOT_BLOCKED: Self = Self {
        blocked: false,
        wait_ms: 0,
        reason: None,
    };
}

#[derive(Debug, Clone)]
struct AccountBucket {
    /// Bucket insertion order (FIFO eviction; assigned when the key is first
    /// inserted, preserved on re-set — TS Map semantics).
    seq: u64,
    blocks: HashMap<String, EntitlementBlock>,
}

/// TS `EntitlementCache` (backing store
/// `Map<accountKey, Map<normalizedModel, EntitlementBlock>>`).
#[derive(Debug, Default)]
pub struct EntitlementCache {
    buckets: HashMap<String, AccountBucket>,
    next_seq: u64,
}

impl EntitlementCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// TS `markBlocked`. No-op on a falsy key / un-normalizable model.
    /// `ttl_ms: None` models the TS non-finite/omitted TTL → default 30 min;
    /// `Some(v)` floors at 1 000 ms. Bucket eviction runs BEFORE insert: at
    /// the 512 cap a NEW key evicts the first-inserted bucket.
    pub fn mark_blocked(
        &mut self,
        account_key: &str,
        model: &str,
        reason: EntitlementBlockReason,
        ttl_ms: Option<i64>,
        now: i64,
    ) {
        let Some(normalized_model) = normalize_model(Some(model)) else {
            return;
        };
        if account_key.is_empty() {
            return;
        }
        let normalized_ttl_ms = match ttl_ms {
            Some(value) => value.max(1_000),
            None => DEFAULT_BLOCK_TTL_MS,
        };
        if self.buckets.len() >= MAX_ACCOUNT_BUCKETS
            && !self.buckets.contains_key(account_key)
            && let Some(first) = self
                .buckets
                .iter()
                .min_by_key(|(_, bucket)| bucket.seq)
                .map(|(key, _)| key.clone())
        {
            self.buckets.remove(&first);
        }
        if !self.buckets.contains_key(account_key) {
            self.next_seq += 1;
            self.buckets.insert(
                account_key.to_string(),
                AccountBucket {
                    seq: self.next_seq,
                    blocks: HashMap::new(),
                },
            );
        }
        let bucket = self
            .buckets
            .get_mut(account_key)
            .expect("bucket inserted above");
        bucket.blocks.insert(
            normalized_model.clone(),
            EntitlementBlock {
                model: normalized_model,
                blocked_until: now + normalized_ttl_ms,
                reason,
                updated_at: now,
            },
        );
    }

    /// TS `clear` — no model drops the whole bucket; with a model deletes the
    /// normalized entry, dropping the bucket when emptied.
    pub fn clear(&mut self, account_key: &str, model: Option<&str>) {
        if account_key.is_empty() {
            return;
        }
        let Some(model) = model else {
            self.buckets.remove(account_key);
            return;
        };
        let Some(normalized_model) = normalize_model(Some(model)) else {
            return;
        };
        let Some(bucket) = self.buckets.get_mut(account_key) else {
            return;
        };
        bucket.blocks.remove(&normalized_model);
        if bucket.blocks.is_empty() {
            self.buckets.remove(account_key);
        }
    }

    /// TS `isBlocked` — lazy expiry (`blockedUntil <= now` deletes the entry
    /// and an emptied bucket).
    pub fn is_blocked(&mut self, account_key: &str, model: &str, now: i64) -> EntitlementBlockStatus {
        let Some(normalized_model) = normalize_model(Some(model)) else {
            return EntitlementBlockStatus::NOT_BLOCKED;
        };
        if account_key.is_empty() {
            return EntitlementBlockStatus::NOT_BLOCKED;
        }
        let Some(bucket) = self.buckets.get_mut(account_key) else {
            return EntitlementBlockStatus::NOT_BLOCKED;
        };
        let Some(block) = bucket.blocks.get(&normalized_model) else {
            return EntitlementBlockStatus::NOT_BLOCKED;
        };
        if block.blocked_until <= now {
            bucket.blocks.remove(&normalized_model);
            if bucket.blocks.is_empty() {
                self.buckets.remove(account_key);
            }
            return EntitlementBlockStatus::NOT_BLOCKED;
        }
        EntitlementBlockStatus {
            blocked: true,
            wait_ms: (block.blocked_until - now).max(0),
            reason: Some(block.reason),
        }
    }

    /// TS `prune` — removes all expired blocks + empty buckets; debug-logs
    /// only when something was removed; returns the removed count.
    pub fn prune(&mut self, now: i64) -> usize {
        let mut removed = 0usize;
        self.buckets.retain(|_, bucket| {
            let before = bucket.blocks.len();
            bucket.blocks.retain(|_, block| block.blocked_until > now);
            removed += before - bucket.blocks.len();
            !bucket.blocks.is_empty()
        });
        if removed > 0 {
            LOG.debug("Pruned entitlement cache", Some(&json!({ "removed": removed })));
        }
        removed
    }

    /// TS `snapshot` — prunes first, then produces cloned block lists sorted
    /// ascending by normalized model, buckets in insertion order.
    pub fn snapshot(&mut self, now: i64) -> EntitlementCacheSnapshot {
        self.prune(now);
        let mut ordered: Vec<(&String, &AccountBucket)> = self.buckets.iter().collect();
        ordered.sort_by_key(|(_, bucket)| bucket.seq);
        let accounts = ordered
            .into_iter()
            .map(|(key, bucket)| {
                let mut blocks: Vec<EntitlementBlock> = bucket.blocks.values().cloned().collect();
                blocks.sort_by(|a, b| a.model.cmp(&b.model));
                (key.clone(), blocks)
            })
            .collect();
        EntitlementCacheSnapshot { accounts }
    }
}

// ============================================================================
// Tests — ported from test/entitlement-cache.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn account_ref(
        account_id: Option<&str>,
        email: Option<&str>,
        index: Option<i64>,
    ) -> EntitlementAccountRef {
        EntitlementAccountRef {
            account_id: account_id.map(str::to_string),
            email: email.map(str::to_string),
            refresh_token: None,
            index,
        }
    }

    #[test]
    fn resolves_account_key_priority() {
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(
                Some("acc_123"),
                Some("user@example.com"),
                Some(2)
            )),
            "account:acc_123::email:user@example.com"
        );
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(None, Some("User@Example.com"), Some(5))),
            "email:user@example.com"
        );
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(None, None, Some(7))),
            "idx:7"
        );
    }

    #[test]
    fn separates_shared_workspace_ids_by_email_or_index() {
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(
                Some("shared-workspace"),
                Some("alpha@example.com"),
                Some(0)
            )),
            "account:shared-workspace::email:alpha@example.com"
        );
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(
                Some("shared-workspace"),
                Some("beta@example.com"),
                Some(1)
            )),
            "account:shared-workspace::email:beta@example.com"
        );
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(Some("shared-workspace"), None, Some(0))),
            "account:shared-workspace::idx:0"
        );
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(Some("shared-workspace"), None, Some(1))),
            "account:shared-workspace::idx:1"
        );
    }

    #[test]
    fn marks_model_block_and_expires_after_ttl() {
        let mut cache = EntitlementCache::new();
        let account_key = "id:acc_1";
        cache.mark_blocked(
            account_key,
            "gpt-5.3-codex",
            EntitlementBlockReason::UnsupportedModel,
            Some(500),
            1_000,
        );

        let blocked_now = cache.is_blocked(account_key, "gpt-5.3-codex", 1_100);
        assert!(blocked_now.blocked);
        assert_eq!(
            blocked_now.reason,
            Some(EntitlementBlockReason::UnsupportedModel)
        );
        assert!(blocked_now.wait_ms > 0);

        let blocked_later = cache.is_blocked(account_key, "gpt-5.3-codex", 2_200);
        assert!(!blocked_later.blocked);
        assert_eq!(blocked_later.wait_ms, 0);
    }

    #[test]
    fn clears_model_or_full_account_block() {
        let mut cache = EntitlementCache::new();
        let account_key = "email:person@example.com";
        cache.mark_blocked(
            account_key,
            "gpt-5-codex",
            EntitlementBlockReason::PlanEntitlement,
            Some(5_000),
            2_000,
        );
        cache.mark_blocked(
            account_key,
            "gpt-5.3-codex",
            EntitlementBlockReason::UnsupportedModel,
            Some(5_000),
            2_000,
        );

        cache.clear(account_key, Some("gpt-5-codex"));
        assert!(!cache.is_blocked(account_key, "gpt-5-codex", 2_500).blocked);
        assert!(cache.is_blocked(account_key, "gpt-5.3-codex", 2_500).blocked);

        cache.clear(account_key, None);
        assert!(!cache.is_blocked(account_key, "gpt-5.3-codex", 2_500).blocked);
    }

    #[test]
    fn normalizes_invalid_ttl_values_to_default_minimum_behavior() {
        // The TS passed Number.NaN; the Rust port models non-finite as None.
        let mut cache = EntitlementCache::new();
        let account_key = "id:ttl-invalid";
        cache.mark_blocked(
            account_key,
            "gpt-5-codex",
            EntitlementBlockReason::PlanEntitlement,
            None,
            1_000,
        );

        let blocked = cache.is_blocked(account_key, "gpt-5-codex", 2_000);
        assert!(blocked.blocked);
        assert!(blocked.wait_ms > 0);
    }

    #[test]
    fn snapshot_entries_are_clones() {
        let mut cache = EntitlementCache::new();
        let account_key = "id:snapshot";
        cache.mark_blocked(
            account_key,
            "gpt-5-codex",
            EntitlementBlockReason::PlanEntitlement,
            Some(5_000),
            1_000,
        );

        let mut snapshot = cache.snapshot(1_500);
        assert_eq!(snapshot.get(account_key).map(<[_]>::len), Some(1));
        snapshot.accounts[0].1[0].model = "tampered-model".to_string();

        let fresh = cache.snapshot(1_500);
        assert_eq!(fresh.get(account_key).unwrap()[0].model, "gpt-5-codex");
    }

    #[test]
    fn handles_trimmed_empty_account_refs_and_non_finite_indexes() {
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(Some("  acc_trim  "), None, None)),
            "account:acc_trim"
        );
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(Some("  acc_trim  "), None, Some(3))),
            "account:acc_trim::idx:3"
        );
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(None, Some("  Person@Example.com  "), None)),
            "email:person@example.com"
        );
        // Number.NaN index → non-finite → None.
        assert_eq!(
            resolve_entitlement_account_key(&account_ref(None, None, None)),
            "idx:0"
        );
    }

    #[test]
    fn never_serializes_refresh_tokens_into_entitlement_keys() {
        let mut with_index = account_ref(None, None, Some(4));
        with_index.refresh_token = Some("  refresh-token  ".to_string());
        assert_eq!(resolve_entitlement_account_key(&with_index), "idx:4");

        let mut without_index = account_ref(None, None, None);
        without_index.refresh_token = Some("  refresh-token  ".to_string());
        assert_eq!(resolve_entitlement_account_key(&without_index), "idx:0");
    }

    #[test]
    fn ignores_invalid_mark_clear_is_blocked_inputs() {
        let mut cache = EntitlementCache::new();
        cache.mark_blocked(
            "",
            "gpt-5-codex",
            EntitlementBlockReason::PlanEntitlement,
            Some(5_000),
            1_000,
        );
        cache.mark_blocked(
            "id:bad-model",
            "   ",
            EntitlementBlockReason::PlanEntitlement,
            Some(5_000),
            1_000,
        );
        cache.clear("", Some("gpt-5-codex"));
        cache.clear("id:bad-model", Some("   "));

        assert!(cache.snapshot(1_500).is_empty());
        assert_eq!(
            cache.is_blocked("", "gpt-5-codex", 1_500),
            EntitlementBlockStatus::NOT_BLOCKED
        );
        assert_eq!(
            cache.is_blocked("id:missing", "", 1_500),
            EntitlementBlockStatus::NOT_BLOCKED
        );
    }

    #[test]
    fn evicts_the_oldest_account_bucket_when_max_buckets_are_exceeded() {
        let mut cache = EntitlementCache::new();
        for index in 0..513 {
            cache.mark_blocked(
                &format!("id:acc_{index}"),
                "gpt-5-codex",
                EntitlementBlockReason::PlanEntitlement,
                Some(5_000),
                1_000,
            );
        }

        assert!(!cache.is_blocked("id:acc_0", "gpt-5-codex", 1_500).blocked);
        assert!(cache.is_blocked("id:acc_1", "gpt-5-codex", 1_500).blocked);
        assert!(cache.is_blocked("id:acc_512", "gpt-5-codex", 1_500).blocked);
    }

    #[test]
    fn normalizes_model_names_with_provider_prefix_and_effort_suffix() {
        let mut cache = EntitlementCache::new();
        let account_key = "id:model-normalize";
        cache.mark_blocked(
            account_key,
            "OpenAI/GPT-5-CODEX-HIGH",
            EntitlementBlockReason::UnsupportedModel,
            Some(5_000),
            1_000,
        );

        assert!(cache.is_blocked(account_key, "gpt-5-codex", 1_500).blocked);
        assert!(
            cache
                .is_blocked(account_key, "openai/gpt-5-codex-low", 1_500)
                .blocked
        );
    }

    #[test]
    fn prunes_expired_blocks_and_removes_empty_account_buckets() {
        let mut cache = EntitlementCache::new();
        cache.mark_blocked(
            "id:prune_a",
            "gpt-5-codex",
            EntitlementBlockReason::PlanEntitlement,
            Some(500),
            1_000,
        );
        cache.mark_blocked(
            "id:prune_b",
            "gpt-5.3-codex",
            EntitlementBlockReason::UnsupportedModel,
            Some(500),
            1_000,
        );

        // TTL floors at 1_000ms → blockedUntil = 2_000; expired at 2_000.
        let removed = cache.prune(2_000);
        assert_eq!(removed, 2);
        assert!(cache.snapshot(2_000).is_empty());
    }

    #[test]
    fn sorts_snapshot_blocks_alphabetically_by_normalized_model() {
        let mut cache = EntitlementCache::new();
        let account_key = "id:sort";
        cache.mark_blocked(
            account_key,
            "gpt-5.3-codex",
            EntitlementBlockReason::UnsupportedModel,
            Some(5_000),
            1_000,
        );
        cache.mark_blocked(
            account_key,
            "gpt-5-codex",
            EntitlementBlockReason::PlanEntitlement,
            Some(5_000),
            1_000,
        );

        let snapshot = cache.snapshot(1_100);
        let models: Vec<&str> = snapshot
            .get(account_key)
            .unwrap()
            .iter()
            .map(|entry| entry.model.as_str())
            .collect();
        assert_eq!(models, vec!["gpt-5-codex", "gpt-5.3-codex"]);
    }
}
