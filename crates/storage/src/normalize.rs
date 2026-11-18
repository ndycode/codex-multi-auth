//! Port of `normalizeAccountStorage` (lib/storage.ts) — spec 02 §5.1 EXACTLY.
//!
//! Pipeline: shape/version/accounts checks → raw active-index clamp +
//! identity capture → V1→V3 migration (accounts taken from the MIGRATED
//! shape, stress-audit M3) → refresh-token filter → fixpoint dedupe →
//! identity-following active-index re-resolution (overall + per-family) →
//! pin RANGE-only validation → affinityGeneration validation → output in
//! schema key order.
//!
//! Input is a raw `serde_json::Value`: both the Zod-validated path (the
//! parser round-trips the typed storage back to a Value, reproducing zod's
//! strip+reorder) and the legacy unknown-shape path flow through here.
//!
//! Lenient typing note (documented deviation): the TS legacy path passed
//! account objects through BY REFERENCE, so garbage-typed fields (e.g. a
//! numeric `accountId`) and unknown keys survived to the next save. The Rust
//! port converts each account into the typed `AccountMetadataV3` with
//! per-field type guards (wrong-typed optionals drop; missing required
//! `addedAt`/`lastUsed` default to 0, matching the `?? 0` arithmetic the
//! matcher applied). Well-formed files are byte-identical; only
//! schema-invalid legacy files differ (spec 02 gotcha 19 sanctions the
//! schema-order rewrite).

use cma_core::logger::create_logger;
use cma_core::model_family::MODEL_FAMILIES;
use cma_core::schemas::parse::number_to_i64_lossy;
use cma_core::utils::now_ms;
use serde_json::{Value, json};

use crate::identity::AccountIdentityRef;
use crate::matching::{
    AccountMatchOptions, clamp_index, deduplicate_accounts, find_matching_account_index,
};
use crate::migrations::fan_out_reset_time;
use crate::misc::is_record;
use crate::public_types::{
    AccountIdSource, AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily, CooldownReason,
    RateLimitStateV3, SwitchReason, Workspace,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum RawVersion {
    V1,
    V3,
}

fn opt_str<'a>(record: &'a Value, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str)
}

fn opt_number(record: &Value, key: &str) -> Option<f64> {
    record.get(key).and_then(Value::as_f64)
}

fn opt_number_i64(record: &Value, key: &str) -> Option<i64> {
    record
        .get(key)
        .and_then(Value::as_number)
        .map(number_to_i64_lossy)
}

fn opt_bool(record: &Value, key: &str) -> Option<bool> {
    record.get(key).and_then(Value::as_bool)
}

/// Lenient per-account conversion (see module docs). Returns `None` for
/// accounts failing the `validAccounts` filter (non-record or blank/missing
/// `refreshToken`).
fn account_from_value(raw: &Value, version: RawVersion, now: i64) -> Option<AccountMetadataV3> {
    if !is_record(raw) {
        return None;
    }
    let refresh_token = opt_str(raw, "refreshToken")?;
    if refresh_token.trim().is_empty() {
        return None;
    }

    let rate_limit_reset_times = match version {
        RawVersion::V1 => fan_out_reset_time(opt_number_i64(raw, "rateLimitResetTime"), now),
        RawVersion::V3 => raw
            .get("rateLimitResetTimes")
            .and_then(Value::as_object)
            .map(|map| {
                let mut state = RateLimitStateV3::new();
                for (key, value) in map {
                    if let Some(number) = value.as_number() {
                        state.insert(key.clone(), number_to_i64_lossy(number));
                    }
                }
                state
            }),
    };

    let workspaces: Option<Vec<Workspace>> = match version {
        // V1 accounts have no workspace fields (migrateV1ToV3 drops them).
        RawVersion::V1 => None,
        RawVersion::V3 => raw.get("workspaces").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value::<Workspace>(item.clone()).ok())
                .collect()
        }),
    };
    let current_workspace_index = match version {
        RawVersion::V1 => None,
        RawVersion::V3 => opt_number_i64(raw, "currentWorkspaceIndex"),
    };

    Some(AccountMetadataV3 {
        account_id: opt_str(raw, "accountId").map(str::to_string),
        account_id_source: opt_str(raw, "accountIdSource").and_then(AccountIdSource::parse),
        account_label: opt_str(raw, "accountLabel").map(str::to_string),
        email: opt_str(raw, "email").map(str::to_string),
        refresh_token: refresh_token.to_string(),
        access_token: opt_str(raw, "accessToken").map(str::to_string),
        expires_at: opt_number_i64(raw, "expiresAt"),
        enabled: opt_bool(raw, "enabled"),
        added_at: opt_number_i64(raw, "addedAt").unwrap_or(0),
        last_used: opt_number_i64(raw, "lastUsed").unwrap_or(0),
        last_switch_reason: opt_str(raw, "lastSwitchReason").and_then(SwitchReason::parse),
        rate_limit_reset_times,
        cooling_down_until: opt_number_i64(raw, "coolingDownUntil"),
        cooldown_reason: opt_str(raw, "cooldownReason").and_then(CooldownReason::parse),
        workspaces,
        current_workspace_index,
    })
}

/// `extractActiveAccountRef` — identity ref of the RAW account at `index`
/// (string-typed fields only; `toAccountIdentityRef` trimming: id/token
/// trimmed, email trimmed+lowercased, empties dropped).
fn extract_active_account_ref(raw_accounts: &[Value], index: usize) -> AccountIdentityRef {
    let Some(raw) = raw_accounts.get(index) else {
        return AccountIdentityRef::default();
    };
    if !is_record(raw) {
        return AccountIdentityRef::default();
    }
    AccountIdentityRef::from_parts(
        opt_str(raw, "accountId"),
        opt_str(raw, "email"),
        opt_str(raw, "refreshToken"),
    )
}

/// TS `resolveAccountSelectionIndex(accounts, candidate, fallbackIndex)`
/// with the float fallback the normalizer feeds it: 0 for an empty list;
/// identity match (unique-accountId fallback enabled); else
/// `clampIndex(fallback, len)`. Inlined here (rather than calling the
/// matching module's integer-typed variant) because the normalizer's
/// fallback is a raw float per spec §5.1 step 9.
fn resolve_selection_index(
    accounts: &[AccountMetadataV3],
    candidate: &AccountIdentityRef,
    fallback_index: f64,
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
    clamp_index(fallback_index, accounts.len())
}

/// `normalizeAccountStorage(data)` — spec 02 §5.1. Returns `None` for
/// unrecognized shapes (warned), the normalized V3 storage otherwise.
pub fn normalize_account_storage(data: &Value) -> Option<AccountStorageV3> {
    let log = create_logger("storage");

    if !is_record(data) {
        log.warn("Invalid storage format, ignoring", None);
        return None;
    }

    let version_value = data.get("version").and_then(Value::as_f64);
    let version = match version_value {
        Some(1.0) => RawVersion::V1,
        Some(3.0) => RawVersion::V3,
        _ => {
            log.warn(
                "Unknown storage version, ignoring",
                Some(&json!({ "version": data.get("version").cloned() })),
            );
            return None;
        }
    };

    let Some(raw_accounts) = data.get("accounts").and_then(Value::as_array) else {
        log.warn("Invalid storage format, ignoring", None);
        return None;
    };

    let active_index_value = opt_number(data, "activeIndex").unwrap_or(0.0);
    let raw_active_index = clamp_index(active_index_value, raw_accounts.len());
    let active_ref = extract_active_account_ref(raw_accounts, raw_active_index);

    // Accounts come from the MIGRATED shape for v1 files (stress-audit M3):
    // the scalar rateLimitResetTime → per-family map conversion must survive.
    let now = now_ms();
    let valid_accounts: Vec<AccountMetadataV3> = raw_accounts
        .iter()
        .filter_map(|raw| account_from_value(raw, version, now))
        .collect();

    let deduplicated_accounts = deduplicate_accounts(&valid_accounts);

    let active_index = if deduplicated_accounts.is_empty() {
        0
    } else {
        resolve_selection_index(&deduplicated_accounts, &active_ref, raw_active_index as f64)
    };

    // Per-family indices: raw per-family value (finite number else the
    // clamped raw active index); for v1 files the migrated map fans the V1
    // activeIndex to every family (spec 02 §5.2).
    let raw_family_indices: Option<&serde_json::Map<String, Value>> = match version {
        RawVersion::V1 => None,
        RawVersion::V3 => data.get("activeIndexByFamily").and_then(Value::as_object),
    };
    let v1_family_index: Option<f64> = match version {
        RawVersion::V1 => Some(opt_number(data, "activeIndex").unwrap_or(f64::NAN)),
        RawVersion::V3 => None,
    };

    let mut active_index_by_family = ActiveIndexByFamily::default();
    for family in MODEL_FAMILIES {
        let raw_index_value: Option<f64> = match version {
            RawVersion::V1 => v1_family_index.filter(|v| v.is_finite()),
            RawVersion::V3 => raw_family_indices
                .and_then(|map| map.get(family.as_str()))
                .and_then(Value::as_f64),
        };
        let raw_index = raw_index_value.unwrap_or(raw_active_index as f64);
        let clamped_raw_index = clamp_index(raw_index, raw_accounts.len());
        let family_ref = extract_active_account_ref(raw_accounts, clamped_raw_index);
        // The RAW (unclamped) index is the fallback (spec §5.1 step 9) —
        // `resolveAccountSelectionIndex` clamps it itself.
        let resolved = resolve_selection_index(&deduplicated_accounts, &family_ref, raw_index);
        active_index_by_family.set(family, Some(resolved as i64));
    }

    let pinned_account_index: Option<i64> = (|| {
        let raw = data.get("pinnedAccountIndex")?.as_f64()?;
        let truncated = raw.trunc();
        if truncated < 0.0
            || truncated >= deduplicated_accounts.len() as f64
            || deduplicated_accounts.is_empty()
        {
            log.warn(
                "Dropping invalid pinnedAccountIndex from storage",
                Some(&json!({
                    "value": raw,
                    "accountCount": deduplicated_accounts.len(),
                })),
            );
            return None;
        }
        Some(truncated as i64)
    })();

    let affinity_generation: Option<i64> = match data.get("affinityGeneration") {
        None => None,
        Some(raw) => match raw.as_f64() {
            Some(value) if value.is_finite() && value.fract() == 0.0 && value >= 0.0 => {
                Some(value as i64)
            }
            _ => {
                log.warn(
                    "Dropping invalid affinityGeneration from storage",
                    Some(&json!({ "value": raw.clone() })),
                );
                None
            }
        },
    };

    Some(AccountStorageV3 {
        version: Default::default(),
        accounts: deduplicated_accounts,
        active_index: active_index as i64,
        active_index_by_family: Some(active_index_by_family),
        pinned_account_index,
        affinity_generation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::model_family::ModelFamily;

    fn account_value(id: &str, email: &str, token: &str) -> Value {
        json!({
            "accountId": id,
            "email": email,
            "refreshToken": token,
            "addedAt": 100,
            "lastUsed": 200,
        })
    }

    #[test]
    fn rejects_non_record_unknown_version_and_bad_accounts() {
        assert!(normalize_account_storage(&json!("nope")).is_none());
        assert!(normalize_account_storage(&json!(null)).is_none());
        assert!(
            normalize_account_storage(&json!({ "version": 2, "accounts": [], "activeIndex": 0 }))
                .is_none()
        );
        // Version must be a NUMBER 1|3 (strict equality in TS).
        assert!(
            normalize_account_storage(&json!({ "version": "3", "accounts": [], "activeIndex": 0 }))
                .is_none()
        );
        assert!(
            normalize_account_storage(&json!({ "version": 3, "accounts": {}, "activeIndex": 0 }))
                .is_none()
        );
    }

    #[test]
    fn drops_accounts_with_blank_refresh_tokens() {
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [
                account_value("a", "a@x.com", "rt_a"),
                { "refreshToken": "   ", "addedAt": 1, "lastUsed": 1 },
                { "addedAt": 1, "lastUsed": 1 },
                "not-a-record",
            ],
            "activeIndex": 0,
        }))
        .expect("normalizes");
        assert_eq!(storage.accounts.len(), 1);
        assert_eq!(storage.accounts[0].refresh_token, "rt_a");
    }

    #[test]
    fn nan_like_and_out_of_range_active_index_clamps_to_zero() {
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a")],
            "activeIndex": 99,
        }))
        .expect("normalizes");
        assert_eq!(storage.active_index, 0);
        // Non-numeric activeIndex defaults to 0 before the clamp.
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a")],
            "activeIndex": "corrupt",
        }))
        .expect("normalizes");
        assert_eq!(storage.active_index, 0);
    }

    #[test]
    fn active_index_follows_the_active_account_identity_through_dedupe() {
        // Two duplicates of account A ahead of B; the raw active index points
        // at the SECOND copy of A (index 1). After dedupe [A, B], the active
        // index must follow A → 0 (not stay clamped at 1 = B).
        let mut newer_a = account_value("acc-a", "a@x.com", "rt_a");
        newer_a["lastUsed"] = json!(999);
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [
                account_value("acc-a", "a@x.com", "rt_a"),
                newer_a,
                account_value("acc-b", "b@x.com", "rt_b"),
            ],
            "activeIndex": 1,
        }))
        .expect("normalizes");
        assert_eq!(storage.accounts.len(), 2);
        assert_eq!(storage.active_index, 0);
        // The merged survivor keeps the newest content.
        assert_eq!(storage.accounts[0].last_used, 999);
    }

    #[test]
    fn v1_storage_migrates_with_future_reset_fanned_to_all_families() {
        let future = now_ms() + 3_600_000;
        let storage = normalize_account_storage(&json!({
            "version": 1,
            "accounts": [{
                "accountId": "acc-a",
                "email": "a@x.com",
                "refreshToken": "rt_a",
                "addedAt": 1,
                "lastUsed": 2,
                "rateLimitResetTime": future,
            }],
            "activeIndex": 0,
        }))
        .expect("normalizes");
        let map = storage.accounts[0]
            .rate_limit_reset_times
            .as_ref()
            .expect("map fanned out (stress-audit M3)");
        assert_eq!(map.len(), 5);
        for family in MODEL_FAMILIES {
            assert_eq!(map.get(family.as_str()), Some(future));
        }
        // Per-family indices fan the v1 activeIndex out too.
        let by_family = storage.active_index_by_family.expect("family map");
        assert_eq!(by_family.get(ModelFamily::Gpt5Codex), Some(0));
    }

    #[test]
    fn v1_expired_reset_time_is_dropped() {
        let storage = normalize_account_storage(&json!({
            "version": 1,
            "accounts": [{
                "refreshToken": "rt_a",
                "addedAt": 1,
                "lastUsed": 2,
                "rateLimitResetTime": 12345,
            }],
            "activeIndex": 0,
        }))
        .expect("normalizes");
        assert!(storage.accounts[0].rate_limit_reset_times.is_none());
    }

    #[test]
    fn pin_is_range_validated_only() {
        // Valid pin survives untouched (RANGE-only validation, gotcha 8).
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a"), account_value("b", "b@x.com", "rt_b")],
            "activeIndex": 0,
            "pinnedAccountIndex": 1,
        }))
        .expect("normalizes");
        assert_eq!(storage.pinned_account_index, Some(1));
        // Out-of-range pin dropped.
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a")],
            "activeIndex": 0,
            "pinnedAccountIndex": 7,
        }))
        .expect("normalizes");
        assert_eq!(storage.pinned_account_index, None);
        // Fractional pins truncate before the range check.
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a"), account_value("b", "b@x.com", "rt_b")],
            "activeIndex": 0,
            "pinnedAccountIndex": 1.9,
        }))
        .expect("normalizes");
        assert_eq!(storage.pinned_account_index, Some(1));
        // Non-numeric pin silently omitted (no warn branch).
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a")],
            "activeIndex": 0,
            "pinnedAccountIndex": "one",
        }))
        .expect("normalizes");
        assert_eq!(storage.pinned_account_index, None);
    }

    #[test]
    fn affinity_generation_validation() {
        let base = json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a")],
            "activeIndex": 0,
        });
        let mut with_gen = base.clone();
        with_gen["affinityGeneration"] = json!(5);
        assert_eq!(
            normalize_account_storage(&with_gen).unwrap().affinity_generation,
            Some(5)
        );
        // Absent ⇒ omitted.
        assert_eq!(normalize_account_storage(&base).unwrap().affinity_generation, None);
        // Invalid values dropped.
        for bad in [json!(-1), json!(1.5), json!("3")] {
            let mut invalid = base.clone();
            invalid["affinityGeneration"] = bad;
            assert_eq!(
                normalize_account_storage(&invalid).unwrap().affinity_generation,
                None
            );
        }
    }

    #[test]
    fn output_serializes_in_schema_key_order() {
        let storage = normalize_account_storage(&json!({
            "version": 3,
            "accounts": [account_value("a", "a@x.com", "rt_a")],
            "activeIndex": 0,
            "affinityGeneration": 2,
            "pinnedAccountIndex": 0,
        }))
        .expect("normalizes");
        let compact = cma_core::json_io::stringify_compact(&storage);
        // Top-level order: version, accounts, activeIndex, activeIndexByFamily,
        // pinnedAccountIndex, affinityGeneration.
        let version_pos = compact.find("\"version\"").unwrap();
        let accounts_pos = compact.find("\"accounts\"").unwrap();
        let active_pos = compact.find("\"activeIndex\"").unwrap();
        let family_pos = compact.find("\"activeIndexByFamily\"").unwrap();
        let pin_pos = compact.find("\"pinnedAccountIndex\"").unwrap();
        let gen_pos = compact.find("\"affinityGeneration\"").unwrap();
        assert!(version_pos < accounts_pos);
        assert!(accounts_pos < active_pos);
        assert!(active_pos < family_pos);
        assert!(family_pos < pin_pos);
        assert!(pin_pos < gen_pos);
        // All five families are present in declaration order.
        assert!(compact.contains(
            r#""activeIndexByFamily":{"gpt-5-codex":0,"codex-max":0,"codex":0,"gpt-5.2":0,"gpt-5.1":0}"#
        ));
    }
}
