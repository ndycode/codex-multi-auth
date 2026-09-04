//! Port of `lib/codex-manager/commands/unpin.ts`.
//!
//! Behavior source: spec 08 §4.19. Affinity-generation lost-update guard:
//! re-read the on-disk `affinityGeneration` just before saving and take
//! `max(memory, disk) + 1` — extra bumps are harmless, missed bumps let the
//! proxy cling to the wrong account.

use cma_storage::load::read_affinity_generation_from_disk;

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    default_get_storage_path, default_load_accounts, default_save_accounts,
    default_set_storage_path, save_accounts_with_retry_boxed, GetStoragePathFn, LoadAccountsFn,
    SaveAccountsFn, SetStoragePathFn,
};

/// TS `UnpinCommandDeps` (log sinks live on [`CliOut`]).
pub struct UnpinCommandDeps {
    pub set_storage_path: SetStoragePathFn,
    pub load_accounts: LoadAccountsFn,
    pub save_accounts: SaveAccountsFn,
    /// Optional (TS `getStoragePath?`): absent → disk generation read as 0.
    pub get_storage_path: Option<GetStoragePathFn>,
}

impl Default for UnpinCommandDeps {
    fn default() -> Self {
        UnpinCommandDeps {
            set_storage_path: default_set_storage_path(),
            load_accounts: default_load_accounts(),
            save_accounts: default_save_accounts(),
            get_storage_path: Some(default_get_storage_path()),
        }
    }
}

/// Production entry (dispatcher: rest args are ignored for this command).
pub async fn run_unpin_command(out: &mut CliOut) -> i32 {
    run_unpin_command_with(&UnpinCommandDeps::default(), out).await
}

/// TS `runUnpinCommand(deps)`.
pub async fn run_unpin_command_with(deps: &UnpinCommandDeps, out: &mut CliOut) -> i32 {
    (deps.set_storage_path)(None);

    let Some(mut storage) = (deps.load_accounts)().await else {
        out.error("No accounts configured.");
        return 1;
    };
    if storage.accounts.is_empty() {
        out.error("No accounts configured.");
        return 1;
    }

    let Some(previous_pin) = storage.pinned_account_index else {
        out.info("No pin to clear.");
        return 0;
    };

    storage.pinned_account_index = None;
    // Re-read the on-disk affinityGeneration just before saving so concurrent
    // CLI processes don't lose increments via lost-update on the load+mutate
    // pair (see module docs).
    let disk_generation = deps
        .get_storage_path
        .as_ref()
        .map(|get_storage_path| read_affinity_generation_from_disk(get_storage_path()))
        .unwrap_or(0);
    let in_memory_generation = storage.affinity_generation.unwrap_or(0);
    storage.affinity_generation = Some(in_memory_generation.max(disk_generation) + 1);
    if let Err(error) = save_accounts_with_retry_boxed(&storage, &deps.save_accounts).await {
        // TS lets the save rejection propagate out of the command; surface it
        // as an error exit instead of a crash.
        out.error(error.message());
        return 1;
    }

    out.info(format!(
        "Cleared manual pin (was account {}). Runtime routing will resume hybrid rotation.",
        previous_pin + 1
    ));
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
    use std::sync::{Arc, Mutex};

    fn storage_with_pin(pin: Option<i64>, generation: Option<i64>) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(AccountMetadataV3::new("token", 1, 1));
        storage.pinned_account_index = pin;
        storage.affinity_generation = generation;
        storage
    }

    struct Harness {
        deps: UnpinCommandDeps,
        saved: Arc<Mutex<Option<AccountStorageV3>>>,
    }

    fn harness(storage: Option<AccountStorageV3>) -> Harness {
        let saved: Arc<Mutex<Option<AccountStorageV3>>> = Arc::new(Mutex::new(None));
        let saved_clone = Arc::clone(&saved);
        let deps = UnpinCommandDeps {
            set_storage_path: Box::new(|_| {}),
            load_accounts: Box::new(move || {
                let storage = storage.clone();
                Box::pin(async move { storage })
            }),
            save_accounts: Box::new(move |storage| {
                let saved = Arc::clone(&saved_clone);
                Box::pin(async move {
                    *saved.lock().unwrap() = Some(storage);
                    Ok(())
                })
            }),
            get_storage_path: None,
        };
        Harness { deps, saved }
    }

    #[tokio::test]
    async fn no_accounts_errors() {
        let h = harness(None);
        let mut out = CliOut::capture();
        assert_eq!(run_unpin_command_with(&h.deps, &mut out).await, 1);
        assert_eq!(out.error_text(), "No accounts configured.");
    }

    #[tokio::test]
    async fn no_pin_is_a_clean_no_op() {
        let h = harness(Some(storage_with_pin(None, None)));
        let mut out = CliOut::capture();
        assert_eq!(run_unpin_command_with(&h.deps, &mut out).await, 0);
        assert_eq!(out.info_text(), "No pin to clear.");
        assert!(h.saved.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn clears_pin_and_bumps_generation() {
        let h = harness(Some(storage_with_pin(Some(0), Some(4))));
        let mut out = CliOut::capture();
        assert_eq!(run_unpin_command_with(&h.deps, &mut out).await, 0);
        let saved = h.saved.lock().unwrap().clone().expect("saved");
        assert_eq!(saved.pinned_account_index, None);
        assert_eq!(saved.affinity_generation, Some(5));
        assert_eq!(
            out.info_text(),
            "Cleared manual pin (was account 1). Runtime routing will resume hybrid rotation."
        );
    }

    #[tokio::test]
    async fn missing_generation_starts_from_zero() {
        let h = harness(Some(storage_with_pin(Some(2), None)));
        let mut out = CliOut::capture();
        assert_eq!(run_unpin_command_with(&h.deps, &mut out).await, 0);
        let saved = h.saved.lock().unwrap().clone().expect("saved");
        assert_eq!(saved.affinity_generation, Some(1));
        assert_eq!(
            out.info_text(),
            "Cleared manual pin (was account 3). Runtime routing will resume hybrid rotation."
        );
    }
}
