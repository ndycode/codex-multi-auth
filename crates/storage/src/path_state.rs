//! Port of `lib/storage/path-state.ts` — storage-path state held in a
//! process-global with a task-local override (the TS module used a module
//! global bridged through `AsyncLocalStorage.enterWith`).
//!
//! Behavior source: spec 02 §2.7 / gotcha 25.
//!
//! Semantics preserved:
//! - [`get_storage_path_state`] prefers the task-local store and falls back to
//!   the global.
//! - [`set_storage_path_state`] assigns the global fallback AND (when called
//!   inside a [`run_with_storage_path_state`] scope) the current task-local
//!   store — mirroring `enterWith` propagating through the current async
//!   chain while the module global keeps serving synchronous readers.
//! - [`run_with_storage_path_state`] scopes a state for the duration of a
//!   future (used by concurrent `AccountManager`s to isolate their storage
//!   paths). Values do NOT cross `tokio::spawn` — spawned work must re-wrap
//!   explicitly (ARCHITECTURE §5.4).

use std::cell::RefCell;
use std::sync::Mutex;

/// `StoragePathState` — all four fields `string | null` in TS.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StoragePathState {
    pub current_storage_path: Option<String>,
    pub current_legacy_project_storage_path: Option<String>,
    pub current_legacy_worktree_storage_path: Option<String>,
    pub current_project_root: Option<String>,
}

impl StoragePathState {
    /// The all-`null` reset state (global storage mode).
    pub const fn empty() -> Self {
        Self {
            current_storage_path: None,
            current_legacy_project_storage_path: None,
            current_legacy_worktree_storage_path: None,
            current_project_root: None,
        }
    }
}

static GLOBAL_STATE: Mutex<StoragePathState> = Mutex::new(StoragePathState::empty());

tokio::task_local! {
    static TASK_STATE: RefCell<StoragePathState>;
}

/// `getStoragePathState()` — task-local store if inside a scope, else the
/// last synchronously assigned global.
pub fn get_storage_path_state() -> StoragePathState {
    TASK_STATE
        .try_with(|cell| cell.borrow().clone())
        .unwrap_or_else(|_| {
            GLOBAL_STATE
                .lock()
                .expect("storage path state poisoned")
                .clone()
        })
}

/// `setStoragePathState(state)` — assigns the global fallback and, when
/// called inside a task-local scope, the scope's store too (the `enterWith`
/// analogue).
pub fn set_storage_path_state(state: StoragePathState) {
    *GLOBAL_STATE.lock().expect("storage path state poisoned") = state.clone();
    let _ = TASK_STATE.try_with(|cell| {
        *cell.borrow_mut() = state.clone();
    });
}

/// `runWithStoragePathState(state, fn)` — run `future` with a task-scoped
/// state override.
pub async fn run_with_storage_path_state<T>(
    state: StoragePathState,
    future: impl Future<Output = T>,
) -> T {
    TASK_STATE.scope(RefCell::new(state), future).await
}

/// Synchronous variant of [`run_with_storage_path_state`] for sync call
/// trees.
pub fn run_with_storage_path_state_sync<T>(state: StoragePathState, f: impl FnOnce() -> T) -> T {
    TASK_STATE.sync_scope(RefCell::new(state), f)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn state_with_path(path: &str) -> StoragePathState {
        StoragePathState {
            current_storage_path: Some(path.to_string()),
            ..StoragePathState::empty()
        }
    }

    #[test]
    #[serial(storage_path_state)]
    fn global_set_and_get_round_trip() {
        set_storage_path_state(state_with_path("/tmp/a.json"));
        assert_eq!(
            get_storage_path_state().current_storage_path.as_deref(),
            Some("/tmp/a.json")
        );
        set_storage_path_state(StoragePathState::empty());
        assert_eq!(get_storage_path_state(), StoragePathState::empty());
    }

    #[tokio::test]
    #[serial(storage_path_state)]
    async fn task_scope_overrides_global_and_restores_after() {
        set_storage_path_state(state_with_path("/global.json"));
        let inner = run_with_storage_path_state(state_with_path("/scoped.json"), async {
            get_storage_path_state()
        })
        .await;
        assert_eq!(inner.current_storage_path.as_deref(), Some("/scoped.json"));
        // Outside the scope the global is visible again.
        assert_eq!(
            get_storage_path_state().current_storage_path.as_deref(),
            Some("/global.json")
        );
        set_storage_path_state(StoragePathState::empty());
    }

    #[tokio::test]
    #[serial(storage_path_state)]
    async fn set_inside_scope_updates_both_scope_and_global() {
        set_storage_path_state(StoragePathState::empty());
        run_with_storage_path_state(state_with_path("/scoped.json"), async {
            set_storage_path_state(state_with_path("/updated.json"));
            assert_eq!(
                get_storage_path_state().current_storage_path.as_deref(),
                Some("/updated.json")
            );
        })
        .await;
        // The global fallback was assigned too (TS parity: module global +
        // enterWith).
        assert_eq!(
            get_storage_path_state().current_storage_path.as_deref(),
            Some("/updated.json")
        );
        set_storage_path_state(StoragePathState::empty());
    }

    #[test]
    #[serial(storage_path_state)]
    fn sync_scope_works_like_async_scope() {
        set_storage_path_state(StoragePathState::empty());
        let seen = run_with_storage_path_state_sync(state_with_path("/sync.json"), || {
            get_storage_path_state()
        });
        assert_eq!(seen.current_storage_path.as_deref(), Some("/sync.json"));
        assert_eq!(get_storage_path_state(), StoragePathState::empty());
    }
}
