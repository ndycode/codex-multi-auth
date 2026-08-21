//! Port of `lib/storage/migrations.ts` — V1 → V3 account-storage migration.
//!
//! Behavior source: spec 02 §5.2 / gotchas 4–5:
//! - The scalar `rateLimitResetTime` converts into the per-family map ONLY
//!   when it is a number strictly greater than `now` — expired reset times
//!   are dropped; a future value fans out to ALL 5 model families with the
//!   SAME timestamp.
//! - `activeIndexByFamily` is initialized to the V1 `activeIndex` for every
//!   family.

use cma_core::model_family::MODEL_FAMILIES;
use cma_core::utils::now_ms;

use crate::public_types::{
    AccountMetadataV3, AccountStorageV1, AccountStorageV3, ActiveIndexByFamily, RateLimitStateV3,
};

/// Fan a V1 scalar reset time out to all 5 model families — `None` when the
/// value is absent or not in the future (expired values are dropped).
/// Shared with the value-based legacy normalizer in `crate::normalize`.
pub(crate) fn fan_out_reset_time(reset_time: Option<i64>, now: i64) -> Option<RateLimitStateV3> {
    let reset_time = reset_time?;
    if reset_time <= now {
        return None;
    }
    let mut map = RateLimitStateV3::new();
    for family in MODEL_FAMILIES {
        map.insert(family.as_str(), reset_time);
    }
    Some(map)
}

/// `migrateV1ToV3(v1)` with an injectable `now` (the TS helper reads
/// `Date.now()` internally — see [`migrate_v1_to_v3`]).
pub fn migrate_v1_to_v3_at(v1: &AccountStorageV1, now: i64) -> AccountStorageV3 {
    let accounts: Vec<AccountMetadataV3> = v1
        .accounts
        .iter()
        .map(|account| AccountMetadataV3 {
            account_id: account.account_id.clone(),
            account_id_source: account.account_id_source,
            account_label: account.account_label.clone(),
            email: account.email.clone(),
            refresh_token: account.refresh_token.clone(),
            access_token: account.access_token.clone(),
            expires_at: account.expires_at,
            enabled: account.enabled,
            added_at: account.added_at,
            last_used: account.last_used,
            last_switch_reason: account.last_switch_reason,
            rate_limit_reset_times: fan_out_reset_time(account.rate_limit_reset_time, now),
            cooling_down_until: account.cooling_down_until,
            cooldown_reason: account.cooldown_reason,
            workspaces: None,
            current_workspace_index: None,
        })
        .collect();

    let mut by_family = ActiveIndexByFamily::default();
    for family in MODEL_FAMILIES {
        by_family.set(family, Some(v1.active_index));
    }

    AccountStorageV3 {
        version: Default::default(),
        accounts,
        active_index: v1.active_index,
        active_index_by_family: Some(by_family),
        pinned_account_index: None,
        affinity_generation: None,
    }
}

/// `migrateV1ToV3(v1)` — wall-clock variant (`Date.now()` parity).
pub fn migrate_v1_to_v3(v1: &AccountStorageV1) -> AccountStorageV3 {
    migrate_v1_to_v3_at(v1, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::model_family::ModelFamily;
    use serde_json::json;

    fn v1_with_reset(reset_time: Option<i64>) -> AccountStorageV1 {
        let mut value = json!({
            "version": 1,
            "accounts": [{
                "accountId": "acc_1",
                "email": "a@b.com",
                "refreshToken": "rt_1",
                "addedAt": 100,
                "lastUsed": 200,
            }],
            "activeIndex": 0,
        });
        if let Some(reset) = reset_time {
            value["accounts"][0]["rateLimitResetTime"] = json!(reset);
        }
        serde_json::from_value(value).expect("valid v1 storage")
    }

    #[test]
    fn fans_a_future_reset_time_to_all_five_families() {
        let now = 1_000_000;
        let migrated = migrate_v1_to_v3_at(&v1_with_reset(Some(now + 60_000)), now);
        let map = migrated.accounts[0]
            .rate_limit_reset_times
            .as_ref()
            .expect("map present");
        assert_eq!(map.len(), 5);
        for family in MODEL_FAMILIES {
            assert_eq!(map.get(family.as_str()), Some(now + 60_000), "{family:?}");
        }
        // Key order = MODEL_FAMILIES order.
        let keys: Vec<&str> = map.keys().collect();
        assert_eq!(
            keys,
            vec!["gpt-5-codex", "codex-max", "codex", "gpt-5.2", "gpt-5.1"]
        );
    }

    #[test]
    fn drops_expired_or_exactly_now_reset_times() {
        let now = 1_000_000;
        let expired = migrate_v1_to_v3_at(&v1_with_reset(Some(now - 1)), now);
        assert!(expired.accounts[0].rate_limit_reset_times.is_none());
        // `> now` is strict: a value equal to now is dropped too.
        let boundary = migrate_v1_to_v3_at(&v1_with_reset(Some(now)), now);
        assert!(boundary.accounts[0].rate_limit_reset_times.is_none());
        let missing = migrate_v1_to_v3_at(&v1_with_reset(None), now);
        assert!(missing.accounts[0].rate_limit_reset_times.is_none());
    }

    #[test]
    fn initializes_every_family_index_to_the_v1_active_index() {
        let mut v1 = v1_with_reset(None);
        v1.active_index = 3;
        let migrated = migrate_v1_to_v3_at(&v1, 0);
        assert_eq!(migrated.active_index, 3);
        let by_family = migrated.active_index_by_family.expect("map present");
        for family in [
            ModelFamily::Gpt5Codex,
            ModelFamily::CodexMax,
            ModelFamily::Codex,
            ModelFamily::Gpt5_2,
            ModelFamily::Gpt5_1,
        ] {
            assert_eq!(by_family.get(family), Some(3));
        }
    }

    #[test]
    fn copies_all_metadata_fields_without_workspaces() {
        let migrated = migrate_v1_to_v3_at(&v1_with_reset(None), 0);
        let account = &migrated.accounts[0];
        assert_eq!(account.account_id.as_deref(), Some("acc_1"));
        assert_eq!(account.email.as_deref(), Some("a@b.com"));
        assert_eq!(account.refresh_token, "rt_1");
        assert_eq!(account.added_at, 100);
        assert_eq!(account.last_used, 200);
        assert!(account.workspaces.is_none());
        assert!(account.current_workspace_index.is_none());
        assert_eq!(migrated.pinned_account_index, None);
        assert_eq!(migrated.affinity_generation, None);
    }
}
