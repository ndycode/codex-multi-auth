//! Port of `lib/codex-cli/sync.ts` — the deliberately-inert reconcile entry
//! point that guards the one-way mirror invariant.
//!
//! Behavior source: specs/11-cli-usage-recovery.md §1.3 (+ gotcha 2).
//!
//! Contracts:
//! - **NEVER reads Codex CLI files.** Multi-auth storage is canonical; the CLI
//!   files are a one-way mirror and must never seed, merge into, or restore the
//!   canonical pool. This module has no filesystem access at all — the
//!   invariant is compile-time enforced.
//! - Normalization clamps `activeIndex` and the per-family indexes into
//!   `[0, count-1]` and keeps the family map SPARSE: a missing family entry is
//!   written only when its clamped value differs from `activeIndex`.
//! - The clone drops `pinnedAccountIndex` / `affinityGeneration` (the TS clone
//!   copies only version/accounts/activeIndex/activeIndexByFamily) — TS parity.

use serde_json::json;

use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::model_family::{MODEL_FAMILIES, ModelFamily};
use cma_core::schemas::account_storage::AccountStorageV3;

use crate::observability::{CodexCliMetricKey, increment_codex_cli_metric};

fn sync_log() -> ScopedLogger {
    create_logger("codex-cli-sync")
}

/// Result of [`sync_account_storage_from_codex_cli`].
#[derive(Debug, Clone, PartialEq)]
pub struct CodexCliSyncResult {
    /// The (possibly normalized) storage; `None` when canonical storage was
    /// missing. When `changed` is false this is the input passed through
    /// unmodified; when true it is the normalized clone (which, like the TS
    /// clone, omits `pinnedAccountIndex`/`affinityGeneration`).
    pub storage: Option<AccountStorageV3>,
    pub changed: bool,
}

/// TS `cloneStorage`: copies ONLY version/accounts/activeIndex and coerces a
/// missing family map to `{}` — pin and affinity generation are dropped.
fn clone_storage(storage: &AccountStorageV3) -> AccountStorageV3 {
    let mut next = storage.clone();
    next.active_index_by_family =
        Some(storage.active_index_by_family.clone().unwrap_or_default());
    next.pinned_account_index = None;
    next.affinity_generation = None;
    next
}

/// TS `normalizeStoredFamilyIndexes` — clamp `activeIndex` and each family
/// index into `[0, count-1]`, keeping absent family keys sparse when the
/// resolved value equals `activeIndex`.
fn normalize_stored_family_indexes(storage: &mut AccountStorageV3) {
    let count = storage.accounts.len() as i64;
    let normalized_active_index = storage.active_index;
    let clamped = if count == 0 {
        0
    } else {
        normalized_active_index.clamp(0, count - 1)
    };
    if storage.active_index != clamped {
        storage.active_index = clamped;
    }
    let mut families = storage.active_index_by_family.clone().unwrap_or_default();
    for family in MODEL_FAMILIES {
        let raw = families.get(family);
        let has_family_index = raw.is_some();
        let resolved = raw.unwrap_or(storage.active_index);
        let family_index = if count == 0 {
            0
        } else {
            resolved.clamp(0, count - 1)
        };
        if !has_family_index && family_index == storage.active_index {
            continue;
        }
        families.set(family, Some(family_index));
    }
    storage.active_index_by_family = Some(families);
}

/// Preserves one-way mirror semantics for Codex CLI compatibility state
/// (TS `syncAccountStorageFromCodexCli`).
///
/// Historical reconcile entry point kept for old call sites: it only
/// normalizes the existing local indexes and never reads or applies Codex CLI
/// account data.
pub async fn sync_account_storage_from_codex_cli(
    current: Option<&AccountStorageV3>,
) -> CodexCliSyncResult {
    increment_codex_cli_metric(CodexCliMetricKey::ReconcileAttempts);

    let Some(current) = current else {
        increment_codex_cli_metric(CodexCliMetricKey::ReconcileNoops);
        sync_log().debug(
            "Skipped Codex CLI reconcile because canonical storage is missing",
            Some(&json!({
                "operation": "reconcile-storage",
                "outcome": "canonical-missing",
            })),
        );
        return CodexCliSyncResult {
            storage: None,
            changed: false,
        };
    };

    let mut next = clone_storage(current);
    let previous_active = next.active_index;
    let previous_families = next.active_index_by_family.clone().unwrap_or_default();
    normalize_stored_family_indexes(&mut next);

    let changed = previous_active != next.active_index
        || Some(&previous_families) != next.active_index_by_family.as_ref();

    increment_codex_cli_metric(if changed {
        CodexCliMetricKey::ReconcileChanges
    } else {
        CodexCliMetricKey::ReconcileNoops
    });
    sync_log().debug(
        "Skipped Codex CLI authority import; canonical storage remains authoritative",
        Some(&json!({
            "operation": "reconcile-storage",
            "outcome": if changed { "normalized-local-indexes" } else { "canonical-authoritative" },
            "accountCount": next.accounts.len(),
        })),
    );

    CodexCliSyncResult {
        storage: Some(if changed { next } else { current.clone() }),
        changed,
    }
}

/// Resolve the active account index for a model family
/// (TS `getActiveSelectionForFamily`): the family entry when present, else
/// `activeIndex`, clamped into `[0, count-1]` (0 when the pool is empty).
pub fn get_active_selection_for_family(
    storage: &AccountStorageV3,
    family: ModelFamily,
) -> i64 {
    let count = storage.accounts.len() as i64;
    if count == 0 {
        return 0;
    }
    let raw = storage
        .active_index_by_family
        .as_ref()
        .and_then(|families| families.get(family));
    let normalized_active_index = storage.active_index;
    let candidate = raw.unwrap_or(normalized_active_index);
    candidate.clamp(0, count - 1)
}

// ---------------------------------------------------------------------------
// Tests (ported from test/codex-cli-sync.test.ts — the JS-only NaN/fractional
// index states cannot be represented in the typed schema, whose lenient
// deserializer already truncates them; the integer contracts are ported.)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::{
        get_codex_cli_metrics_snapshot, reset_codex_cli_metrics_for_tests,
    };
    use serde_json::json;
    use serial_test::serial;

    fn storage_from(value: serde_json::Value) -> AccountStorageV3 {
        serde_json::from_value(value).expect("valid AccountStorageV3 fixture")
    }

    fn account(id: &str, email: &str, refresh: &str) -> serde_json::Value {
        json!({
            "accountId": id,
            "email": email,
            "refreshToken": refresh,
            "addedAt": 1,
            "lastUsed": 1,
        })
    }

    #[tokio::test]
    #[serial(env)]
    async fn does_not_seed_canonical_storage_from_codex_cli_mirror_files() {
        reset_codex_cli_metrics_for_tests();
        let result = sync_account_storage_from_codex_cli(None).await;
        assert!(!result.changed);
        assert_eq!(result.storage, None);
        let metrics = get_codex_cli_metrics_snapshot();
        assert_eq!(metrics.reconcile_attempts, 1);
        assert_eq!(metrics.reconcile_noops, 1);
        reset_codex_cli_metrics_for_tests();
    }

    #[tokio::test]
    #[serial(env)]
    async fn does_not_merge_or_overwrite_canonical_storage_from_codex_cli_mirrors() {
        let current = storage_from(json!({
            "version": 3,
            "accounts": [account("acc_a", "a@example.com", "refresh-a")],
            "activeIndex": 0,
            "activeIndexByFamily": {
                "gpt-5-codex": 0, "codex-max": 0, "codex": 0, "gpt-5.2": 0, "gpt-5.1": 0,
            },
        }));

        let result = sync_account_storage_from_codex_cli(Some(&current)).await;
        assert!(!result.changed);
        let storage = result.storage.expect("storage");
        assert_eq!(storage, current);
        assert_eq!(storage.accounts, current.accounts);
    }

    #[tokio::test]
    #[serial(env)]
    async fn normalizes_local_indexes_without_reading_codex_cli_mirror_state() {
        let current = storage_from(json!({
            "version": 3,
            "accounts": [
                account("acc_a", "a@example.com", "refresh-a"),
                account("acc_b", "b@example.com", "refresh-b"),
            ],
            "activeIndex": 99,
            "activeIndexByFamily": {"codex": 99},
        }));

        let result = sync_account_storage_from_codex_cli(Some(&current)).await;
        assert!(result.changed);
        let storage = result.storage.expect("storage");
        assert_ne!(storage, current);
        assert_eq!(storage.active_index, 1);
        let families = storage.active_index_by_family.expect("families");
        assert_eq!(families.codex, Some(1));
        // Absent family keys resolving to activeIndex stay sparse.
        for family in MODEL_FAMILIES {
            if family != ModelFamily::Codex {
                assert_eq!(families.get(family), None, "{family:?} should be absent");
            }
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn clamps_negative_active_index_to_0_and_reports_changed() {
        let current = storage_from(json!({
            "version": 3,
            "accounts": [account("acc_a", "a@example.com", "refresh-a")],
            "activeIndex": 0,
            "activeIndexByFamily": {"codex": -3},
        }));

        let result = sync_account_storage_from_codex_cli(Some(&current)).await;
        assert!(result.changed);
        let storage = result.storage.expect("storage");
        assert_eq!(storage.active_index, 0);
        assert_eq!(
            storage.active_index_by_family.expect("families").codex,
            Some(0)
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn does_not_report_changes_when_missing_family_indexes_resolve_to_active_index() {
        let current = storage_from(json!({
            "version": 3,
            "accounts": [account("acc_a", "a@example.com", "refresh-a")],
            "activeIndex": 0,
            "activeIndexByFamily": {},
        }));

        let result = sync_account_storage_from_codex_cli(Some(&current)).await;
        assert!(!result.changed);
        assert_eq!(result.storage, Some(current));
    }

    #[tokio::test]
    #[serial(env)]
    async fn normalized_clone_drops_pin_and_generation_like_the_ts_clone() {
        let current = storage_from(json!({
            "version": 3,
            "accounts": [
                account("acc_a", "a@example.com", "refresh-a"),
                account("acc_b", "b@example.com", "refresh-b"),
            ],
            "activeIndex": 5,
            "pinnedAccountIndex": 1,
            "affinityGeneration": 4,
        }));

        let result = sync_account_storage_from_codex_cli(Some(&current)).await;
        assert!(result.changed);
        let storage = result.storage.expect("storage");
        assert_eq!(storage.active_index, 1);
        // TS cloneStorage copies only version/accounts/activeIndex/families.
        assert_eq!(storage.pinned_account_index, None);
        assert_eq!(storage.affinity_generation, None);
    }

    #[test]
    fn clamps_and_defaults_active_selection_indexes_by_model_family() {
        let family = MODEL_FAMILIES[0];

        // Empty pool → 0.
        let empty = storage_from(json!({
            "version": 3,
            "accounts": [],
            "activeIndex": 99,
            "activeIndexByFamily": {},
        }));
        assert_eq!(get_active_selection_for_family(&empty, family), 0);

        // Missing family entry falls back to activeIndex.
        let fallback = storage_from(json!({
            "version": 3,
            "accounts": [
                {"refreshToken": "a", "addedAt": 1, "lastUsed": 1},
                {"refreshToken": "b", "addedAt": 1, "lastUsed": 1},
            ],
            "activeIndex": 1,
            "activeIndexByFamily": {},
        }));
        assert_eq!(get_active_selection_for_family(&fallback, family), 1);

        // Negative family entry clamps to 0.
        let negative = storage_from(json!({
            "version": 3,
            "accounts": [
                {"refreshToken": "a", "addedAt": 1, "lastUsed": 1},
                {"refreshToken": "b", "addedAt": 1, "lastUsed": 1},
            ],
            "activeIndex": 1,
            "activeIndexByFamily": {(family.as_str()): -3},
        }));
        assert_eq!(get_active_selection_for_family(&negative, family), 0);

        // Overflowing family entry clamps to count-1.
        let overflow = storage_from(json!({
            "version": 3,
            "accounts": [
                {"refreshToken": "a", "addedAt": 1, "lastUsed": 1},
                {"refreshToken": "b", "addedAt": 1, "lastUsed": 1},
                {"refreshToken": "c", "addedAt": 1, "lastUsed": 1},
            ],
            "activeIndex": 0,
            "activeIndexByFamily": {(family.as_str()): 7},
        }));
        assert_eq!(get_active_selection_for_family(&overflow, family), 2);
    }
}
