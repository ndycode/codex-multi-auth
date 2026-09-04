//! Port of `lib/storage/transactions.ts` + the concrete transaction wiring
//! from `lib/storage.ts` (spec 02 §11).
//!
//! - [`with_storage_lock`]: the global storage mutex — a fair (FIFO)
//!   `tokio::sync::Mutex`, **non-reentrant** (nested acquisition deadlocks,
//!   exactly like the TS promise chain). The critical section runs with a
//!   task-local "held" flag; [`is_storage_lock_held`] reads it so code that
//!   may run both standalone and nested (flagged recovery persistence during
//!   a transaction) can choose the unlocked save instead of deadlocking.
//! - Transaction snapshot context: task-local [`TransactionSnapshotState`]
//!   consulted by `export_accounts` (spec gotcha 11) so exports inside a
//!   transaction reuse the in-memory snapshot instead of re-acquiring the
//!   lock.
//! - [`with_account_storage_transaction`],
//!   [`with_account_and_flagged_storage_transaction`] (accounts rollback on
//!   flagged-save failure; `AggregateError` message FROZEN),
//!   [`with_flagged_storage_transaction`] (flagged rollback; message FROZEN).
//!
//! Task-local values do NOT cross `tokio::spawn` — any spawn inside a scoped
//! region must re-wrap explicitly (ARCHITECTURE §5.4).

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::json;

use cma_core::errors::CodexError;
use cma_core::logger::create_logger;
use cma_core::schemas::account_storage::AccountStorageV3;
use cma_core::schemas::flagged::FlaggedAccountStorageV1;

static STORAGE_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

tokio::task_local! {
    static STORAGE_LOCK_HELD: ();
    static TRANSACTION_SNAPSHOT: Arc<TransactionSnapshotState>;
}

/// Reports whether the caller is already running inside a
/// [`with_storage_lock`] critical section (TS `isStorageLockHeld`).
pub fn is_storage_lock_held() -> bool {
    STORAGE_LOCK_HELD.try_with(|_| ()).is_ok()
}

/// Snapshot state of an active account-storage transaction (TS
/// `TransactionSnapshotState`). `snapshot` is interior-mutable because
/// `persist` updates it while the handler still holds the state.
#[derive(Debug)]
pub struct TransactionSnapshotState {
    pub storage_path: PathBuf,
    pub active: bool,
    snapshot: StdMutex<Option<AccountStorageV3>>,
}

impl TransactionSnapshotState {
    pub fn new(storage_path: PathBuf, snapshot: Option<AccountStorageV3>) -> Self {
        Self {
            storage_path,
            active: true,
            snapshot: StdMutex::new(snapshot),
        }
    }

    /// Current snapshot (cloned).
    pub fn snapshot(&self) -> Option<AccountStorageV3> {
        self.snapshot.lock().expect("snapshot mutex poisoned").clone()
    }

    pub fn set_snapshot(&self, snapshot: Option<AccountStorageV3>) {
        *self.snapshot.lock().expect("snapshot mutex poisoned") = snapshot;
    }
}

/// TS `getTransactionSnapshotState` — the active transaction's snapshot
/// state, when the caller runs inside one.
pub fn get_transaction_snapshot_state() -> Option<Arc<TransactionSnapshotState>> {
    TRANSACTION_SNAPSHOT.try_with(Arc::clone).ok()
}

/// TS `runInTransactionSnapshotContext` — run `fut` with the given snapshot
/// state visible to [`get_transaction_snapshot_state`].
pub async fn run_in_transaction_snapshot_context<T>(
    state: Arc<TransactionSnapshotState>,
    fut: impl Future<Output = T>,
) -> T {
    TRANSACTION_SNAPSHOT.scope(state, fut).await
}

/// TS `withStorageLock(fn)` — global FIFO mutex around all storage writes.
/// **Non-reentrant**: acquiring it while already held deadlocks (TS parity).
pub async fn with_storage_lock<T, Fut>(f: impl FnOnce() -> Fut) -> T
where
    Fut: Future<Output = T>,
{
    let _guard = STORAGE_MUTEX.lock().await;
    STORAGE_LOCK_HELD.scope((), f()).await
}

fn clone_flagged_storage_for_persistence(
    storage: Option<&FlaggedAccountStorageV1>,
) -> FlaggedAccountStorageV1 {
    match storage {
        Some(storage) => FlaggedAccountStorageV1 {
            version: storage.version,
            accounts: storage.accounts.clone(),
        },
        None => FlaggedAccountStorageV1::empty(),
    }
}

/// Persist handle passed to [`with_account_storage_transaction`] handlers.
pub struct AccountTransactionPersist {
    state: Arc<TransactionSnapshotState>,
}

impl AccountTransactionPersist {
    /// Save via the UNLOCKED writer (the lock is already held) and update the
    /// transaction snapshot.
    pub async fn persist(&self, storage: &AccountStorageV3) -> Result<(), CodexError> {
        crate::save::save_accounts_unlocked(storage).await?;
        self.state.set_snapshot(Some(storage.clone()));
        Ok(())
    }
}

/// TS `withAccountStorageTransaction(handler)` — lock, load current storage
/// (migrations persist via the UNLOCKED save — the lock is already held),
/// then run the handler under the snapshot context.
pub async fn with_account_storage_transaction<T, F, Fut>(handler: F) -> Result<T, CodexError>
where
    F: FnOnce(Option<AccountStorageV3>, AccountTransactionPersist) -> Fut,
    Fut: Future<Output = Result<T, CodexError>>,
{
    with_storage_lock(|| async move {
        // Migrations persist via the UNLOCKED save — the lock is already held.
        let snapshot = crate::load::load_accounts_internal(crate::load::PersistMigration::Unlocked)
            .await
            .map(|loaded| loaded.storage);
        let state = Arc::new(TransactionSnapshotState::new(
            PathBuf::from(crate::facade::get_storage_path()),
            snapshot.clone(),
        ));
        let persist = AccountTransactionPersist {
            state: Arc::clone(&state),
        };
        run_in_transaction_snapshot_context(state, handler(snapshot, persist)).await
    })
    .await
}

/// Persist handle for the combined account + flagged transaction.
pub struct AccountAndFlaggedTransactionPersist {
    state: Arc<TransactionSnapshotState>,
}

impl AccountAndFlaggedTransactionPersist {
    /// Save accounts first, then flagged; on flagged failure ROLL BACK the
    /// accounts file to the pre-persist snapshot. If the rollback also fails,
    /// the frozen `AggregateError` message is raised (spec 02 §11).
    pub async fn persist(
        &self,
        account_storage: &AccountStorageV3,
        flagged_storage: &FlaggedAccountStorageV1,
    ) -> Result<(), CodexError> {
        let log = create_logger("storage");
        let previous_accounts =
            crate::misc::clone_account_storage_for_persistence(self.state.snapshot().as_ref());
        let next_accounts =
            crate::misc::clone_account_storage_for_persistence(Some(account_storage));
        let next_flagged = clone_flagged_storage_for_persistence(Some(flagged_storage));
        crate::save::save_accounts_unlocked(&next_accounts).await?;
        match crate::flagged::save_flagged_accounts_unlocked(&next_flagged).await {
            Ok(()) => {
                self.state.set_snapshot(Some(next_accounts));
                Ok(())
            }
            Err(error) => match crate::save::save_accounts_unlocked(&previous_accounts).await {
                Ok(()) => {
                    self.state.set_snapshot(Some(previous_accounts));
                    Err(error)
                }
                Err(rollback_error) => {
                    log.error(
                        "Failed to rollback account storage after flagged save failure",
                        Some(&json!({
                            "error": error.to_string(),
                            "rollbackError": rollback_error.to_string(),
                        })),
                    );
                    Err(CodexError::new(
                        "Flagged save failed and account storage rollback also failed",
                    ))
                }
            },
        }
    }
}

/// TS `withAccountAndFlaggedStorageTransaction(handler)` — lock, load
/// accounts (unlocked persist) + flagged storage, run the handler with a
/// rollback-capable persist.
pub async fn with_account_and_flagged_storage_transaction<T, F, Fut>(
    handler: F,
) -> Result<T, CodexError>
where
    F: FnOnce(
        Option<AccountStorageV3>,
        AccountAndFlaggedTransactionPersist,
        FlaggedAccountStorageV1,
    ) -> Fut,
    Fut: Future<Output = Result<T, CodexError>>,
{
    with_storage_lock(|| async move {
        let snapshot = crate::load::load_accounts_internal(crate::load::PersistMigration::Unlocked)
            .await
            .map(|loaded| loaded.storage);
        let state = Arc::new(TransactionSnapshotState::new(
            PathBuf::from(crate::facade::get_storage_path()),
            snapshot.clone(),
        ));
        let current_flagged = crate::flagged::load_flagged_accounts().await;
        let persist = AccountAndFlaggedTransactionPersist {
            state: Arc::clone(&state),
        };
        run_in_transaction_snapshot_context(state, handler(snapshot, persist, current_flagged))
            .await
    })
    .await
}

/// Persist handle for the flagged-only transaction.
pub struct FlaggedTransactionPersist {
    snapshot: Arc<StdMutex<FlaggedAccountStorageV1>>,
}

impl FlaggedTransactionPersist {
    /// Save flagged storage; on failure restore the previous flagged state.
    /// Double failure raises the frozen `AggregateError` message.
    pub async fn persist(&self, storage: &FlaggedAccountStorageV1) -> Result<(), CodexError> {
        let log = create_logger("storage");
        let previous_storage = clone_flagged_storage_for_persistence(Some(
            &self.snapshot.lock().expect("flagged snapshot poisoned").clone(),
        ));
        let next_storage = clone_flagged_storage_for_persistence(Some(storage));
        match crate::flagged::save_flagged_accounts_unlocked(&next_storage).await {
            Ok(()) => {
                *self.snapshot.lock().expect("flagged snapshot poisoned") = next_storage;
                Ok(())
            }
            Err(error) => {
                match crate::flagged::save_flagged_accounts_unlocked(&previous_storage).await {
                    Ok(()) => {
                        *self.snapshot.lock().expect("flagged snapshot poisoned") =
                            previous_storage;
                        Err(error)
                    }
                    Err(rollback_error) => {
                        log.error(
                            "Failed to rollback flagged storage after flagged save failure",
                            Some(&json!({
                                "error": error.to_string(),
                                "rollbackError": rollback_error.to_string(),
                            })),
                        );
                        Err(CodexError::new(
                            "Flagged save failed and flagged storage rollback also failed",
                        ))
                    }
                }
            }
        }
    }
}

/// TS `withFlaggedStorageTransaction(handler)`.
pub async fn with_flagged_storage_transaction<T, F, Fut>(handler: F) -> Result<T, CodexError>
where
    F: FnOnce(FlaggedAccountStorageV1, FlaggedTransactionPersist) -> Fut,
    Fut: Future<Output = Result<T, CodexError>>,
{
    with_storage_lock(|| async move {
        let current = crate::flagged::load_flagged_accounts().await;
        let snapshot = Arc::new(StdMutex::new(clone_flagged_storage_for_persistence(Some(
            &current,
        ))));
        let handler_copy = clone_flagged_storage_for_persistence(Some(
            &snapshot.lock().expect("flagged snapshot poisoned").clone(),
        ));
        let persist = FlaggedTransactionPersist {
            snapshot: Arc::clone(&snapshot),
        };
        handler(handler_copy, persist).await
    })
    .await
}

// ============================================================================
// Tests — lock semantics + snapshot context (pure; the filesystem-backed
// transaction round-trips live in tests/transactions_test.rs)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn lock_is_fifo_and_exclusive() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        let order = Arc::new(StdMutex::new(Vec::new()));
        for i in 0..4 {
            let counter = Arc::clone(&counter);
            let order = Arc::clone(&order);
            handles.push(tokio::spawn(async move {
                with_storage_lock(|| async move {
                    let inside = counter.fetch_add(1, Ordering::SeqCst);
                    // Only one holder at a time.
                    assert_eq!(counter.load(Ordering::SeqCst), inside + 1);
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    counter.fetch_sub(1, Ordering::SeqCst);
                    order.lock().unwrap().push(i);
                })
                .await;
            }));
            // Give each task a chance to enqueue so FIFO order is observable.
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        for handle in handles {
            handle.await.unwrap();
        }
        assert_eq!(order.lock().unwrap().clone(), vec![0, 1, 2, 3]);
    }

    #[tokio::test]
    async fn held_flag_is_scoped_to_the_critical_section() {
        assert!(!is_storage_lock_held());
        with_storage_lock(|| async {
            assert!(is_storage_lock_held());
        })
        .await;
        assert!(!is_storage_lock_held());
    }

    #[tokio::test]
    async fn held_flag_does_not_leak_into_spawned_tasks() {
        with_storage_lock(|| async {
            let spawned = tokio::spawn(async { is_storage_lock_held() });
            assert!(!spawned.await.unwrap());
        })
        .await;
    }

    #[tokio::test]
    async fn snapshot_context_is_visible_and_mutable() {
        assert!(get_transaction_snapshot_state().is_none());
        let state = Arc::new(TransactionSnapshotState::new(
            PathBuf::from("/tmp/accounts.json"),
            None,
        ));
        run_in_transaction_snapshot_context(Arc::clone(&state), async {
            let visible = get_transaction_snapshot_state().expect("state visible");
            assert!(visible.active);
            assert_eq!(visible.storage_path, PathBuf::from("/tmp/accounts.json"));
            assert!(visible.snapshot().is_none());
            visible.set_snapshot(Some(AccountStorageV3::empty()));
        })
        .await;
        assert!(state.snapshot().is_some());
        assert!(get_transaction_snapshot_state().is_none());
    }

    #[test]
    fn clone_flagged_storage_defaults_to_empty() {
        let cloned = clone_flagged_storage_for_persistence(None);
        assert!(cloned.accounts.is_empty());
    }
}
