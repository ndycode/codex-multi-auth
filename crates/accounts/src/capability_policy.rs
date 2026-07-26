//! Port of `lib/capability-policy.ts` — in-memory per-(account, model)
//! capability score store with passive decay (spec 03 §4).
//!
//! In-memory ONLY; nothing is ever persisted. Feeds selection boosts.
//!
//! Behavior contracts (spec 03 §4 + gotchas 19/20/25):
//! - LRU cap of 2048 entries; every record does the TS "delete-then-set" so
//!   eviction order is least-recently-RECORDED, not FIFO.
//! - Passive decay: failures/unsupported recover 0.5/min since `updated_at`
//!   at boost-read time (read-only — decay is never written back).
//! - Boost = clamp(min(12, successes*2) − min(18, recoveredFailures*3)
//!   − min(24, recoveredUnsupported*6), −30, 20) as floats.
//! - The account key used by callers is the ENTITLEMENT key
//!   (`resolve_entitlement_account_key`), NOT the sha256 policy key
//!   (quota-forecast-01 fix — keep write and read keys aligned).
//! - Model normalization consults the alias catalog: exact
//!   `getNormalizedModel` match first, then `resolveNormalizedModel` but ONLY
//!   when the id looks like a GPT-5/codex model (`/gpt[-_\s]?5|codex/i`);
//!   unknown non-GPT5/codex models pass through raw. One trailing reasoning
//!   suffix (`-none|-minimal|-low|-medium|-high|-xhigh`) is stripped.
//!
//! Layering note: the alias catalog lives in `cma-request::model_map` (L3),
//! which depends on this crate (L2). The catalog is therefore injected via
//! the [`ModelCatalog`] trait — `cma-request` (or the runtime wiring) supplies
//! the production implementation backed by `getNormalizedModel` /
//! `resolveNormalizedModel`. A store built without a catalog degrades to raw
//! pass-through bucketing (still internally consistent, but alias ids no
//! longer share buckets) — production wiring MUST inject the catalog.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// TS `MAX_ENTRIES` — map-wide LRU cap.
pub const MAX_ENTRIES: usize = 2048;
/// TS `PASSIVE_RECOVERY_PER_MIN` — failure/unsupported decay per minute.
pub const PASSIVE_RECOVERY_PER_MIN: f64 = 0.5;

/// Model-alias catalog seam (production impl lives in
/// `cma-request::model_map`; see the module docs).
pub trait ModelCatalog: Send + Sync {
    /// TS `getNormalizedModel` — exact alias-table lookup (`None` when
    /// unknown).
    fn get_normalized_model(&self, model: &str) -> Option<String>;
    /// TS `resolveNormalizedModel` — full resolution incl. default-model
    /// fallback.
    fn resolve_normalized_model(&self, model: &str) -> String;
}

/// TS `CapabilityPolicySnapshot` — raw stored counts WITHOUT decay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityPolicySnapshot {
    pub successes: i64,
    pub failures: i64,
    pub unsupported: i64,
    #[serde(
        rename = "lastSuccessAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_success_at: Option<i64>,
    #[serde(
        rename = "lastFailureAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_failure_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct CapabilityEntry {
    successes: i64,
    failures: i64,
    unsupported: i64,
    last_success_at: Option<i64>,
    last_failure_at: Option<i64>,
    updated_at: i64,
    /// Rust-only: recency counter reproducing the TS Map iteration order
    /// under delete-then-set (smallest = least recently recorded).
    seq: u64,
}

/// The TS regex gate `/gpt[-_\s]?5|codex/i` deciding whether an unknown id
/// falls back to the alias catalog.
fn matches_gpt5_or_codex(value: &str) -> bool {
    let lower = value.to_lowercase();
    if lower.contains("codex") {
        return true;
    }
    let chars: Vec<char> = lower.chars().collect();
    for start in 0..chars.len() {
        if chars[start..].starts_with(&['g', 'p', 't']) {
            let rest = &chars[start + 3..];
            match rest.first() {
                Some('5') => return true,
                Some(c)
                    if (*c == '-' || *c == '_' || c.is_whitespace())
                        && rest.get(1) == Some(&'5') =>
                {
                    return true;
                }
                _ => {}
            }
        }
    }
    false
}

/// Strip exactly ONE trailing reasoning suffix from an already-lowercased id
/// (TS `replace(/-(none|minimal|low|medium|high|xhigh)$/i, "")`).
fn strip_one_reasoning_suffix(value: &str) -> String {
    const SUFFIXES: [&str; 6] = ["-none", "-minimal", "-low", "-medium", "-high", "-xhigh"];
    for suffix in SUFFIXES {
        if let Some(stripped) = value.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    value.to_string()
}

/// TS `normalizeModel` (capability-policy variant — spec gotcha 20: this one
/// consults the alias catalog; the entitlement-cache variant does not).
fn normalize_model(catalog: Option<&dyn ModelCatalog>, model: Option<&str>) -> Option<String> {
    let trimmed_input = model?.trim();
    if trimmed_input.is_empty() {
        return None;
    }
    let without_provider = if trimmed_input.contains('/') {
        trimmed_input.rsplit('/').next().unwrap_or(trimmed_input)
    } else {
        trimmed_input
    };
    let exact_match = catalog.and_then(|c| c.get_normalized_model(without_provider));
    let should_use_fallback_catalog = matches_gpt5_or_codex(without_provider);
    let mapped = match exact_match {
        Some(mapped) => mapped,
        None => match (should_use_fallback_catalog, catalog) {
            (true, Some(c)) => c.resolve_normalized_model(without_provider),
            _ => without_provider.to_string(),
        },
    };
    let trimmed = mapped.trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    Some(strip_one_reasoning_suffix(&trimmed))
}

/// TS `CapabilityPolicyStore`.
#[derive(Default)]
pub struct CapabilityPolicyStore {
    entries: HashMap<String, CapabilityEntry>,
    next_seq: u64,
    catalog: Option<Arc<dyn ModelCatalog>>,
}

impl CapabilityPolicyStore {
    /// Store without an alias catalog (raw pass-through bucketing — see the
    /// module docs; production wiring should use [`Self::with_catalog`]).
    pub fn new() -> Self {
        Self::default()
    }

    /// Store backed by the production alias catalog.
    pub fn with_catalog(catalog: Arc<dyn ModelCatalog>) -> Self {
        Self {
            entries: HashMap::new(),
            next_seq: 0,
            catalog: Some(catalog),
        }
    }

    /// TS `makeKey` — `"{accountKey}:{normalizedModel}"`, `None` when either
    /// part is missing.
    fn make_key(&self, account_key: &str, model: &str) -> Option<String> {
        let normalized = normalize_model(self.catalog.as_deref(), Some(model))?;
        if account_key.is_empty() {
            return None;
        }
        Some(format!("{account_key}:{normalized}"))
    }

    fn record(
        &mut self,
        key: String,
        now: i64,
        build: impl FnOnce(Option<&CapabilityEntry>, i64) -> CapabilityEntry,
    ) {
        // Delete-then-set so the entry moves to the "end" (max seq), making
        // eviction LRU (least-recently-recorded) rather than FIFO.
        let existing = self.entries.remove(&key);
        self.next_seq += 1;
        let mut entry = build(existing.as_ref(), now);
        entry.seq = self.next_seq;
        self.entries.insert(key, entry);
        self.evict_if_needed();
    }

    /// TS `recordSuccess` — `successes+1`, decrements failures/unsupported
    /// (floored at 0), stamps `lastSuccessAt`/`updatedAt`.
    pub fn record_success(&mut self, account_key: &str, model: &str, now: i64) {
        let Some(key) = self.make_key(account_key, model) else {
            return;
        };
        self.record(key, now, |existing, now| CapabilityEntry {
            successes: existing.map_or(0, |e| e.successes) + 1,
            failures: (existing.map_or(0, |e| e.failures) - 1).max(0),
            unsupported: (existing.map_or(0, |e| e.unsupported) - 1).max(0),
            last_success_at: Some(now),
            last_failure_at: existing.and_then(|e| e.last_failure_at),
            updated_at: now,
            seq: 0,
        });
    }

    /// TS `recordFailure` — `failures+1` only.
    pub fn record_failure(&mut self, account_key: &str, model: &str, now: i64) {
        let Some(key) = self.make_key(account_key, model) else {
            return;
        };
        self.record(key, now, |existing, now| CapabilityEntry {
            successes: existing.map_or(0, |e| e.successes),
            failures: existing.map_or(0, |e| e.failures) + 1,
            unsupported: existing.map_or(0, |e| e.unsupported),
            last_success_at: existing.and_then(|e| e.last_success_at),
            last_failure_at: Some(now),
            updated_at: now,
            seq: 0,
        });
    }

    /// TS `recordUnsupported` — `failures+1` AND `unsupported+1`.
    pub fn record_unsupported(&mut self, account_key: &str, model: &str, now: i64) {
        let Some(key) = self.make_key(account_key, model) else {
            return;
        };
        self.record(key, now, |existing, now| CapabilityEntry {
            successes: existing.map_or(0, |e| e.successes),
            failures: existing.map_or(0, |e| e.failures) + 1,
            unsupported: existing.map_or(0, |e| e.unsupported) + 1,
            last_success_at: existing.and_then(|e| e.last_success_at),
            last_failure_at: Some(now),
            updated_at: now,
            seq: 0,
        });
    }

    /// TS `getBoost` — decayed net score clamped to `[-30, 20]` (floats).
    /// Read-only: the decay is never persisted back into the entry.
    pub fn get_boost(&self, account_key: &str, model: &str, now: i64) -> f64 {
        let Some(key) = self.make_key(account_key, model) else {
            return 0.0;
        };
        let Some(entry) = self.entries.get(&key) else {
            return 0.0;
        };

        let minutes_since_update = ((now - entry.updated_at) as f64 / 60_000.0).max(0.0);
        let recovered_failures =
            (entry.failures as f64 - minutes_since_update * PASSIVE_RECOVERY_PER_MIN).max(0.0);
        let recovered_unsupported =
            (entry.unsupported as f64 - minutes_since_update * PASSIVE_RECOVERY_PER_MIN).max(0.0);

        let success_score = (entry.successes as f64 * 2.0).min(12.0);
        let failure_penalty = (recovered_failures * 3.0).min(18.0);
        let unsupported_penalty = (recovered_unsupported * 6.0).min(24.0);
        let net = success_score - failure_penalty - unsupported_penalty;
        net.clamp(-30.0, 20.0)
    }

    /// TS `getSnapshot` — raw stored counts WITHOUT decay.
    pub fn get_snapshot(&self, account_key: &str, model: &str) -> Option<CapabilityPolicySnapshot> {
        let key = self.make_key(account_key, model)?;
        let entry = self.entries.get(&key)?;
        Some(CapabilityPolicySnapshot {
            successes: entry.successes,
            failures: entry.failures,
            unsupported: entry.unsupported,
            last_success_at: entry.last_success_at,
            last_failure_at: entry.last_failure_at,
        })
    }

    /// TS `clearAccount` — deletes every entry whose key starts with
    /// `"{accountKey}:"`; returns the removed count (0 for an empty key).
    pub fn clear_account(&mut self, account_key: &str) -> usize {
        if account_key.is_empty() {
            return 0;
        }
        let prefix = format!("{account_key}:");
        let before = self.entries.len();
        self.entries.retain(|key, _| !key.starts_with(&prefix));
        before - self.entries.len()
    }

    /// TS `evictIfNeeded` — evicts at most ONE entry per call, only when
    /// `size > MAX_ENTRIES` (strictly greater): the least-recently-recorded
    /// one (the TS Map's first-iterated key).
    fn evict_if_needed(&mut self) {
        if self.entries.len() <= MAX_ENTRIES {
            return;
        }
        if let Some(oldest) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.seq)
            .map(|(key, _)| key.clone())
        {
            self.entries.remove(&oldest);
        }
    }
}

// ============================================================================
// Tests — ported from test/capability-policy.test.ts
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal stand-in for the `cma-request` alias catalog covering the ids
    /// exercised by the ported TS assertions (the real catalog resolves the
    /// full alias/profile tables).
    struct TestCatalog;

    impl ModelCatalog for TestCatalog {
        fn get_normalized_model(&self, model: &str) -> Option<String> {
            match model.to_lowercase().as_str() {
                // gpt-5-codex is an alias of the canonical gpt-5.3-codex id.
                "gpt-5-codex" | "gpt-5.3-codex" => Some("gpt-5.3-codex".to_string()),
                "gpt-5.5-pro" => Some("gpt-5.5-pro".to_string()),
                _ => None,
            }
        }

        fn resolve_normalized_model(&self, model: &str) -> String {
            let lower = model.to_lowercase();
            let stripped = strip_one_reasoning_suffix(&lower);
            if let Some(exact) = self.get_normalized_model(&stripped) {
                return exact;
            }
            // Dated release ids resolve to their base model.
            if stripped.starts_with("gpt-5.5-pro-") {
                return "gpt-5.5-pro".to_string();
            }
            // Unknown GPT-5 ids resolve to the default model.
            "gpt-5.5".to_string()
        }
    }

    fn catalog_store() -> CapabilityPolicyStore {
        CapabilityPolicyStore::with_catalog(Arc::new(TestCatalog))
    }

    #[test]
    fn rewards_repeated_successes() {
        let mut store = catalog_store();
        store.record_success("id:acc_1", "gpt-5-codex", 1_000);
        store.record_success("id:acc_1", "gpt-5-codex", 2_000);

        assert!(store.get_boost("id:acc_1", "gpt-5-codex", 2_500) > 0.0);
    }

    #[test]
    fn penalizes_failures_and_unsupported_errors() {
        let mut store = catalog_store();
        store.record_failure("id:acc_1", "gpt-5.3-codex", 1_000);
        store.record_unsupported("id:acc_1", "gpt-5.3-codex", 1_500);

        let boost = store.get_boost("id:acc_1", "gpt-5.3-codex", 1_600);
        assert!(boost < 0.0);
    }

    #[test]
    fn recovers_passively_over_time() {
        let mut store = catalog_store();
        store.record_failure("id:acc_2", "gpt-5-codex", 1_000);
        let early = store.get_boost("id:acc_2", "gpt-5-codex", 2_000);
        let later = store.get_boost("id:acc_2", "gpt-5-codex", 122_000);

        assert!(later >= early);
    }

    #[test]
    fn clears_account_specific_entries() {
        let mut store = catalog_store();
        store.record_success("id:acc_a", "gpt-5-codex", 1_000);
        store.record_failure("id:acc_b", "gpt-5-codex", 1_000);

        assert!(store.clear_account("id:acc_a") > 0);
        assert!(store.get_snapshot("id:acc_a", "gpt-5-codex").is_none());
        assert!(store.get_snapshot("id:acc_b", "gpt-5-codex").is_some());
    }

    #[test]
    fn uses_canonical_model_normalization_across_aliases() {
        let mut store = catalog_store();
        store.record_success("id:acc_alias", "gpt-5.3-codex", 1_000);
        let boost_from_canonical = store.get_boost("id:acc_alias", "gpt-5-codex", 1_500);
        assert!(boost_from_canonical > 0.0);
    }

    #[test]
    fn shares_capability_buckets_between_aliases_and_dated_release_ids() {
        let mut store = catalog_store();
        store.record_unsupported("id:acc_future", "gpt-5.5-pro", 1_000);

        let snapshot = store
            .get_snapshot("id:acc_future", "gpt-5.5-pro-2026-04-23")
            .expect("dated release id must share the base bucket");
        assert_eq!(snapshot.failures, 1);
        assert_eq!(snapshot.unsupported, 1);
    }

    #[test]
    fn returns_zero_boost_null_snapshot_for_missing_or_invalid_keys() {
        let store = catalog_store();
        assert_eq!(store.get_boost("", "gpt-5-codex", 1_000), 0.0);
        assert_eq!(store.get_boost("id:missing", "gpt-5-codex", 1_000), 0.0);
        assert!(store.get_snapshot("", "gpt-5-codex").is_none());
        assert!(store.get_snapshot("id:missing", "gpt-5-codex").is_none());
    }

    #[test]
    fn normalizes_provider_prefixed_models_and_strips_quality_suffixes() {
        let mut store = catalog_store();
        store.record_success("id:acc_norm", "openai/gpt-5-codex-high", 1_000);

        let snapshot = store.get_snapshot("id:acc_norm", "gpt-5-codex");
        assert!(snapshot.is_some());
        assert_eq!(snapshot.unwrap().successes, 1);
    }

    #[test]
    fn keeps_unknown_model_identifiers_in_separate_capability_buckets() {
        let mut store = catalog_store();
        store.record_success("id:acc_unknown", "claude-3-sonnet-high", 1_000);

        let snapshot = store
            .get_snapshot("id:acc_unknown", "claude-3-sonnet")
            .expect("non-GPT5/codex ids pass through raw");
        assert_eq!(snapshot.successes, 1);
        assert!(store.get_snapshot("id:acc_unknown", "gpt-5.4").is_none());
    }

    #[test]
    fn ignores_blank_model_and_blank_account_writes() {
        let mut store = catalog_store();
        store.record_success("", "gpt-5-codex", 1_000);
        store.record_failure("id:acc_blank", "   ", 1_000);
        store.record_unsupported("", "   ", 1_000);

        assert!(store.get_snapshot("id:acc_blank", "gpt-5-codex").is_none());
        assert_eq!(store.clear_account(""), 0);
    }

    #[test]
    fn evicts_oldest_entries_when_capacity_is_exceeded() {
        let mut store = catalog_store();
        for i in 0..2055 {
            store.record_success(&format!("id:acc_{i}"), "gpt-5-codex", 1_000 + i);
        }

        assert!(store.get_snapshot("id:acc_0", "gpt-5-codex").is_none());
        assert!(store.get_snapshot("id:acc_2054", "gpt-5-codex").is_some());
    }

    #[test]
    fn lru_eviction_keeps_a_re_recorded_old_entry_over_an_idle_newer_one() {
        let mut store = catalog_store();
        // Fill exactly to capacity (MAX_ENTRIES = 2048): acc_0 is the oldest.
        for i in 0..2048 {
            store.record_success(&format!("id:acc_{i}"), "gpt-5-codex", 1_000 + i);
        }
        // Re-record the oldest entry: this must refresh its position so it is
        // no longer first in iteration order (FIFO would still evict it next).
        store.record_success("id:acc_0", "gpt-5-codex", 5_000);
        // One more distinct insert pushes size over capacity and evicts.
        store.record_success("id:acc_new", "gpt-5-codex", 6_000);

        assert!(store.get_snapshot("id:acc_0", "gpt-5-codex").is_some());
        assert!(store.get_snapshot("id:acc_1", "gpt-5-codex").is_none());
        assert!(store.get_snapshot("id:acc_new", "gpt-5-codex").is_some());
    }

    #[test]
    fn clamps_boost_to_score_boundaries() {
        let mut store = catalog_store();
        for i in 0..20 {
            store.record_success("id:acc_hi", "gpt-5-codex", 1_000 + i);
        }
        for i in 0..20 {
            store.record_unsupported("id:acc_lo", "gpt-5-codex", 1_000 + i);
        }

        assert!(store.get_boost("id:acc_hi", "gpt-5-codex", 2_000) <= 20.0);
        assert!(store.get_boost("id:acc_lo", "gpt-5-codex", 2_000) >= -30.0);
    }

    #[test]
    fn success_decrements_failures_and_unsupported_with_floor() {
        let mut store = catalog_store();
        store.record_unsupported("id:acc_heal", "gpt-5-codex", 1_000);
        store.record_success("id:acc_heal", "gpt-5-codex", 2_000);
        let snapshot = store.get_snapshot("id:acc_heal", "gpt-5-codex").unwrap();
        assert_eq!(snapshot.successes, 1);
        assert_eq!(snapshot.failures, 0);
        assert_eq!(snapshot.unsupported, 0);
        // Floors at 0 — a second success cannot go negative.
        store.record_success("id:acc_heal", "gpt-5-codex", 3_000);
        let snapshot = store.get_snapshot("id:acc_heal", "gpt-5-codex").unwrap();
        assert_eq!(snapshot.failures, 0);
        assert_eq!(snapshot.unsupported, 0);
    }

    #[test]
    fn gpt5_regex_gate_matches_separator_variants() {
        assert!(matches_gpt5_or_codex("gpt5-turbo"));
        assert!(matches_gpt5_or_codex("gpt-5.2"));
        assert!(matches_gpt5_or_codex("GPT_5"));
        assert!(matches_gpt5_or_codex("gpt 5"));
        assert!(matches_gpt5_or_codex("mycodex"));
        assert!(!matches_gpt5_or_codex("gpt-4o"));
        assert!(!matches_gpt5_or_codex("claude-3-sonnet"));
    }
}
