//! Port of `lib/storage/public-types.ts` — the current-version storage shapes
//! shared with external consumers via the storage facade.
//!
//! In the Rust workspace the actual serde models live in
//! `cma_core::schemas` (foundation-frozen, ARCHITECTURE §7 F3); this module
//! re-exports them under the storage crate so downstream crates can keep
//! importing the types from the storage layer, exactly like the TS facade
//! re-exported them from `lib/storage.ts`.
//!
//! Historical migration-era shapes (V1) are also re-exported here for the
//! `migrations` module; the TS facade deliberately did not export them, but
//! Rust module privacy is handled by consumers importing from
//! `cma_storage::public_types` vs `cma_storage::migrations`.

pub use cma_core::schemas::account_storage::{
    AccountIdSource, AccountMetadataV1, AccountMetadataV3, AccountStorageV1, AccountStorageV3,
    ActiveIndexByFamily, AnyAccountStorage, CooldownReason, PersistedSwitchReason, RateLimitReason,
    RateLimitStateV3, SwitchReason, Workspace,
};
pub use cma_core::schemas::flagged::{FlaggedAccountMetadataV1, FlaggedAccountStorageV1};
pub use cma_core::schemas::journal::AccountsJournalEntry;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn re_exported_types_are_usable_from_the_storage_layer() {
        let storage = AccountStorageV3::empty();
        assert!(storage.accounts.is_empty());
        assert_eq!(storage.active_index, 0);
        let account = AccountMetadataV3::new("rt", 1, 2);
        assert!(account.is_enabled());
        assert_eq!(CooldownReason::RateLimit.as_str(), "rate-limit");
        assert_eq!(SwitchReason::Manual.as_str(), "manual");
        let flagged = FlaggedAccountStorageV1::empty();
        assert!(flagged.accounts.is_empty());
    }
}
