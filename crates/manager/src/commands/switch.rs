//! Port of `lib/codex-manager/commands/switch.ts`.
//!
//! Behavior source: spec 08 §4.17. Digit-only index validation (`/^\d+$/`)
//! is a deliberate fix — `parseInt` truncation of `"1.5"`/`"2abc"` must be
//! rejected (spec 08 gotcha 13).

use cma_accounts::manager_persistence::format_account_label;
use cma_core::schemas::account_storage::{AccountStorageV3, PersistedSwitchReason};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    default_load_accounts, default_set_storage_path, BoxFuture, LoadAccountsFn, SetStoragePathFn,
};

/// Parameters of the injected `persistAndSyncSelectedAccount` call (the TS
/// inline type in switch.ts; production wiring adapts the login-cluster
/// implementation).
pub struct PersistAndSyncSelectedAccountParams {
    pub storage: AccountStorageV3,
    pub target_index: usize,
    /// 1-based parsed index (TS `parsed`).
    pub parsed: i64,
    pub switch_reason: PersistedSwitchReason,
    pub initial_sync_id_token: Option<String>,
    pub set_pin: bool,
    pub clear_pin: bool,
    pub bump_affinity_generation: bool,
}

/// `{ synced, wasDisabled }`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PersistAndSyncSelectedAccountOutcome {
    pub synced: bool,
    pub was_disabled: bool,
}

/// Injected `persistAndSyncSelectedAccount`.
pub type PersistAndSyncSelectedAccountFn = Box<
    dyn Fn(PersistAndSyncSelectedAccountParams) -> BoxFuture<PersistAndSyncSelectedAccountOutcome>
        + Send
        + Sync,
>;

/// TS `SwitchCommandDeps` (log sinks live on [`CliOut`]).
pub struct SwitchCommandDeps {
    pub set_storage_path: SetStoragePathFn,
    pub load_accounts: LoadAccountsFn,
    pub persist_and_sync_selected_account: PersistAndSyncSelectedAccountFn,
}

impl SwitchCommandDeps {
    /// Real storage wiring around an injected persist implementation.
    pub fn new(persist_and_sync_selected_account: PersistAndSyncSelectedAccountFn) -> Self {
        SwitchCommandDeps {
            set_storage_path: default_set_storage_path(),
            load_accounts: default_load_accounts(),
            persist_and_sync_selected_account,
        }
    }
}

/// Production entry: wires the login-cluster
/// `persistAndSyncSelectedAccount` (spec 09 §1.9).
pub async fn run_switch_command(args: &[String], out: &mut CliOut) -> i32 {
    let deps = SwitchCommandDeps::new(Box::new(|params| {
        Box::pin(async move {
            let outcome = crate::login::persist_selected::persist_and_sync_selected_account(
                crate::login::persist_selected::PersistSelectedAccountParams {
                    storage: params.storage,
                    target_index: params.target_index,
                    parsed: params.parsed,
                    switch_reason: params.switch_reason,
                    initial_sync_id_token: params.initial_sync_id_token,
                    preserve_active_index_by_family: false,
                    set_pin: params.set_pin,
                    clear_pin: params.clear_pin,
                    bump_affinity_generation: params.bump_affinity_generation,
                },
            )
            .await;
            PersistAndSyncSelectedAccountOutcome {
                synced: outcome.synced,
                was_disabled: outcome.was_disabled,
            }
        })
    }));
    run_switch_command_with(args, &deps, out).await
}

/// TS `runSwitchCommand(args, deps)`.
pub async fn run_switch_command_with(
    args: &[String],
    deps: &SwitchCommandDeps,
    out: &mut CliOut,
) -> i32 {
    (deps.set_storage_path)(None);
    let Some(index_arg) = args.first() else {
        out.error("Missing index. Usage: codex-multi-auth switch <index>");
        return 1;
    };

    // Require a plain positive integer. parseInt would silently truncate
    // "1.5" -> 1 (or "2abc" -> 2), selecting a real account from malformed
    // input; reject anything that isn't all digits.
    let trimmed = index_arg.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        out.error(format!("Invalid index: {index_arg}"));
        return 1;
    }
    let Ok(parsed) = trimmed.parse::<i64>() else {
        out.error(format!("Invalid index: {index_arg}"));
        return 1;
    };
    if parsed < 1 {
        out.error(format!("Invalid index: {index_arg}"));
        return 1;
    }

    let target_index = (parsed - 1) as usize;
    let Some(storage) = (deps.load_accounts)().await else {
        out.error("No accounts configured.");
        return 1;
    };
    if storage.accounts.is_empty() {
        out.error("No accounts configured.");
        return 1;
    }

    if target_index >= storage.accounts.len() {
        out.error(format!(
            "Index out of range. Valid range: 1-{}",
            storage.accounts.len()
        ));
        return 1;
    }

    let Some(account) = storage.accounts.get(target_index).cloned() else {
        out.error(format!("Account {parsed} not found."));
        return 1;
    };

    let outcome = (deps.persist_and_sync_selected_account)(PersistAndSyncSelectedAccountParams {
        storage,
        target_index,
        parsed,
        switch_reason: PersistedSwitchReason::Manual,
        initial_sync_id_token: None,
        set_pin: true,
        clear_pin: false,
        bump_affinity_generation: true,
    })
    .await;

    if !outcome.synced {
        out.warn(format!(
            "Switched account {parsed} locally, but Codex auth sync did not complete. Multi-auth routing will still use this account."
        ));
    }

    out.info(format!(
        "Switched to account {parsed}: {}{} (pinned for runtime routing)",
        format_account_label(Some(&account), target_index),
        if outcome.was_disabled { " (re-enabled)" } else { "" },
    ));
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use std::sync::{Arc, Mutex};

    #[allow(clippy::type_complexity)]
    struct Harness {
        deps: SwitchCommandDeps,
        persist_calls: Arc<Mutex<Vec<(usize, i64, bool, bool)>>>,
    }

    fn harness(storage: Option<AccountStorageV3>, synced: bool, was_disabled: bool) -> Harness {
        let persist_calls = Arc::new(Mutex::new(Vec::new()));
        let persist_clone = Arc::clone(&persist_calls);
        let deps = SwitchCommandDeps {
            set_storage_path: Box::new(|_| {}),
            load_accounts: Box::new(move || {
                let storage = storage.clone();
                Box::pin(async move { storage })
            }),
            persist_and_sync_selected_account: Box::new(move |params| {
                persist_clone.lock().unwrap().push((
                    params.target_index,
                    params.parsed,
                    params.set_pin,
                    params.bump_affinity_generation,
                ));
                Box::pin(async move {
                    PersistAndSyncSelectedAccountOutcome { synced, was_disabled }
                })
            }),
        };
        Harness { deps, persist_calls }
    }

    fn storage_with(count: usize) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        for i in 0..count {
            let mut account = AccountMetadataV3::new(format!("token-{i}"), 1, 1);
            account.email = Some(format!("user{i}@example.com"));
            storage.accounts.push(account);
        }
        storage
    }

    #[tokio::test]
    async fn missing_index_errors() {
        let h = harness(Some(storage_with(1)), true, false);
        let mut out = CliOut::capture();
        assert_eq!(run_switch_command_with(&[], &h.deps, &mut out).await, 1);
        assert_eq!(out.error_text(), "Missing index. Usage: codex-multi-auth switch <index>");
    }

    #[tokio::test]
    async fn rejects_non_digit_indexes() {
        for bad in ["1.5", "2abc", "-1", "abc"] {
            let h = harness(Some(storage_with(3)), true, false);
            let mut out = CliOut::capture();
            let args = vec![bad.to_string()];
            assert_eq!(run_switch_command_with(&args, &h.deps, &mut out).await, 1, "arg {bad:?}");
            assert_eq!(out.error_text(), format!("Invalid index: {bad}"));
            assert!(h.persist_calls.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn zero_is_invalid() {
        let h = harness(Some(storage_with(3)), true, false);
        let mut out = CliOut::capture();
        assert_eq!(run_switch_command_with(&["0".to_string()], &h.deps, &mut out).await, 1);
        assert_eq!(out.error_text(), "Invalid index: 0");
    }

    #[tokio::test]
    async fn no_accounts_errors() {
        let h = harness(None, true, false);
        let mut out = CliOut::capture();
        assert_eq!(run_switch_command_with(&["1".to_string()], &h.deps, &mut out).await, 1);
        assert_eq!(out.error_text(), "No accounts configured.");
    }

    #[tokio::test]
    async fn out_of_range_reports_valid_range() {
        let h = harness(Some(storage_with(2)), true, false);
        let mut out = CliOut::capture();
        assert_eq!(run_switch_command_with(&["5".to_string()], &h.deps, &mut out).await, 1);
        assert_eq!(out.error_text(), "Index out of range. Valid range: 1-2");
    }

    #[tokio::test]
    async fn switches_and_pins_with_manual_reason() {
        let h = harness(Some(storage_with(2)), true, false);
        let mut out = CliOut::capture();
        assert_eq!(run_switch_command_with(&["2".to_string()], &h.deps, &mut out).await, 0);
        assert_eq!(h.persist_calls.lock().unwrap().as_slice(), [(1usize, 2i64, true, true)]);
        assert_eq!(
            out.info_text(),
            "Switched to account 2: Account 2 (user1@example.com) (pinned for runtime routing)"
        );
        assert!(out.warn_text().is_empty());
    }

    #[tokio::test]
    async fn unsynced_switch_warns_and_re_enabled_suffix() {
        let h = harness(Some(storage_with(1)), false, true);
        let mut out = CliOut::capture();
        assert_eq!(run_switch_command_with(&["1".to_string()], &h.deps, &mut out).await, 0);
        assert_eq!(
            out.warn_text(),
            "Switched account 1 locally, but Codex auth sync did not complete. Multi-auth routing will still use this account."
        );
        assert_eq!(
            out.info_text(),
            "Switched to account 1: Account 1 (user0@example.com) (re-enabled) (pinned for runtime routing)"
        );
    }
}
