//! Port of `lib/runtime/account-status.ts` (spec 10 §22) — active-index
//! resolution and per-family rate-limit reset lookups.
//!
//! Per-model keys look like `codex:gpt-5.4`; a key matches a family when it
//! is exactly the family literal or starts with `"{family}:"`.

use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{AccountStorageV3, RateLimitStateV3};

/// TS `resolveActiveIndex(storage, family = "codex")` — 0 accounts → 0;
/// candidate = `activeIndexByFamily[family] ?? activeIndex`; non-finite → 0;
/// clamp `[0, len-1]`.
pub fn resolve_active_index(storage: &AccountStorageV3, family: ModelFamily) -> usize {
    let total = storage.accounts.len();
    if total == 0 {
        return 0;
    }
    let raw_candidate = storage
        .active_index_by_family
        .as_ref()
        .and_then(|map| map.get(family))
        .unwrap_or(storage.active_index);
    let raw = raw_candidate.max(0) as usize;
    raw.min(total - 1)
}

/// TS `getRateLimitResetTimeForFamily(account, now, family)` — min over
/// entries with numeric value `> now` whose key is exactly `family` or
/// starts with `"{family}:"`; none → `None`.
pub fn get_rate_limit_reset_time_for_family(
    rate_limit_reset_times: Option<&RateLimitStateV3>,
    now: i64,
    family: ModelFamily,
) -> Option<i64> {
    let times = rate_limit_reset_times?;
    let family_key = family.as_str();
    let prefix = format!("{family_key}:");

    let mut min_reset: Option<i64> = None;
    for (key, value) in times.iter() {
        if value <= now {
            continue;
        }
        if key != family_key && !key.starts_with(&prefix) {
            continue;
        }
        min_reset = Some(match min_reset {
            Some(current) if current <= value => current,
            _ => value,
        });
    }
    min_reset
}

/// TS `formatRateLimitEntry(account, now, formatWaitTime, family = "codex")`
/// — `None` when no future reset; else `"resets in {formatWaitTime(delta)}"`.
pub fn format_rate_limit_entry(
    rate_limit_reset_times: Option<&RateLimitStateV3>,
    now: i64,
    format_wait_time: &dyn Fn(i64) -> String,
    family: ModelFamily,
) -> Option<String> {
    let reset_at = get_rate_limit_reset_time_for_family(rate_limit_reset_times, now, family)?;
    let remaining = reset_at - now;
    if remaining <= 0 {
        return None;
    }
    Some(format!("resets in {}", format_wait_time(remaining)))
}

// =============================================================================
// Tests — ported from test/account-status.test.ts
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{AccountMetadataV3, ActiveIndexByFamily};

    fn storage_with(count: usize, active_index: i64) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        for i in 0..count {
            storage
                .accounts
                .push(AccountMetadataV3::new(format!("rt-{i}"), 1, 1));
        }
        storage.active_index = active_index;
        storage
    }

    #[test]
    fn resolve_active_index_clamps_and_prefers_family() {
        assert_eq!(resolve_active_index(&storage_with(0, 5), ModelFamily::Codex), 0);
        assert_eq!(resolve_active_index(&storage_with(3, 2), ModelFamily::Codex), 2);
        assert_eq!(resolve_active_index(&storage_with(3, 9), ModelFamily::Codex), 2);
        assert_eq!(resolve_active_index(&storage_with(3, -4), ModelFamily::Codex), 0);

        let mut storage = storage_with(3, 0);
        let mut by_family = ActiveIndexByFamily::default();
        by_family.set(ModelFamily::Codex, Some(1));
        storage.active_index_by_family = Some(by_family);
        assert_eq!(resolve_active_index(&storage, ModelFamily::Codex), 1);
        // Families without an entry fall back to activeIndex.
        assert_eq!(resolve_active_index(&storage, ModelFamily::Gpt5_2), 0);
    }

    #[test]
    fn rate_limit_reset_matches_family_and_prefixed_keys() {
        let times: RateLimitStateV3 = [
            ("codex".to_string(), 2_000i64),
            ("codex:gpt-5.4".to_string(), 1_500i64),
            ("gpt-5.2".to_string(), 1_200i64),
            ("codex-past".to_string(), 5_000i64),
        ]
        .into_iter()
        .collect();

        // Min over exact family + "family:" prefixed keys ("codex-past" is
        // neither: prefix requires the colon).
        assert_eq!(
            get_rate_limit_reset_time_for_family(Some(&times), 1_000, ModelFamily::Codex),
            Some(1_500)
        );
        // Values <= now are ignored.
        assert_eq!(
            get_rate_limit_reset_time_for_family(Some(&times), 1_800, ModelFamily::Codex),
            Some(2_000)
        );
        assert_eq!(
            get_rate_limit_reset_time_for_family(Some(&times), 2_500, ModelFamily::Codex),
            None
        );
        assert_eq!(
            get_rate_limit_reset_time_for_family(None, 0, ModelFamily::Codex),
            None
        );
        // gpt-5.2 family sees only its own key.
        assert_eq!(
            get_rate_limit_reset_time_for_family(Some(&times), 1_000, ModelFamily::Gpt5_2),
            Some(1_200)
        );
    }

    #[test]
    fn format_rate_limit_entry_formats_remaining() {
        let times: RateLimitStateV3 = [("codex".to_string(), 61_000i64)].into_iter().collect();
        let format = |ms: i64| format!("{}s", ms / 1000);
        assert_eq!(
            format_rate_limit_entry(Some(&times), 1_000, &format, ModelFamily::Codex),
            Some("resets in 60s".to_string())
        );
        assert_eq!(
            format_rate_limit_entry(Some(&times), 61_000, &format, ModelFamily::Codex),
            None
        );
    }
}
