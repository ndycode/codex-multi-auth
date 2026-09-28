//! Port of `lib/codex-manager/commands/workspace.ts` (issue #491).
//!
//! Behavior source: spec 08 §4.23. Digit-only index validation matches
//! `switch` (spec 08 gotcha 13).

use cma_accounts::manager_persistence::{format_account_label, format_workspace_lines};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    default_load_accounts, default_save_accounts, default_set_storage_path,
    save_accounts_with_retry_boxed, LoadAccountsFn, SaveAccountsFn, SetStoragePathFn,
};

/// TS `WorkspaceCommandDeps` (log sinks live on [`CliOut`]).
pub struct WorkspaceCommandDeps {
    pub set_storage_path: SetStoragePathFn,
    pub load_accounts: LoadAccountsFn,
    pub save_accounts: SaveAccountsFn,
}

impl Default for WorkspaceCommandDeps {
    fn default() -> Self {
        WorkspaceCommandDeps {
            set_storage_path: default_set_storage_path(),
            load_accounts: default_load_accounts(),
            save_accounts: default_save_accounts(),
        }
    }
}

/// Production entry.
pub async fn run_workspace_command(args: &[String], out: &mut CliOut) -> i32 {
    run_workspace_command_with(args, &WorkspaceCommandDeps::default(), out).await
}

fn parse_positive_digit_index(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let parsed: i64 = value.trim_start().parse().ok()?;
    if parsed < 1 {
        return None;
    }
    Some(parsed)
}

/// TS `runWorkspaceCommand(args, deps)` — `workspace <account> [workspace]`:
/// list (1 arg) or set (2 args) the active workspace of an account.
pub async fn run_workspace_command_with(
    args: &[String],
    deps: &WorkspaceCommandDeps,
    out: &mut CliOut,
) -> i32 {
    (deps.set_storage_path)(None);

    let Some(mut storage) = (deps.load_accounts)().await else {
        out.error("No accounts configured.");
        return 1;
    };
    if storage.accounts.is_empty() {
        out.error("No accounts configured.");
        return 1;
    }

    let Some(account_arg) = args.first() else {
        out.error(
            "Missing account index. Usage: codex-multi-auth workspace <account> [workspace]",
        );
        return 1;
    };

    // Require a plain positive integer (matches `switch`): parseInt would
    // silently truncate "1.9" -> 1 or "2abc" -> 2 and operate on the wrong
    // account, so reject anything that isn't all digits.
    let Some(parsed_account) = parse_positive_digit_index(account_arg) else {
        out.error(format!(
            "Invalid account index (must be a positive integer): {account_arg}"
        ));
        return 1;
    };

    let account_index = (parsed_account - 1) as usize;
    if account_index >= storage.accounts.len() {
        out.error(format!(
            "Account index out of range. Valid range: 1-{}",
            storage.accounts.len()
        ));
        return 1;
    }

    let Some(account) = storage.accounts.get(account_index) else {
        out.error(format!("Account {parsed_account} not found."));
        return 1;
    };
    let label = format_account_label(Some(account), account_index);

    let workspaces = account.workspaces.clone().unwrap_or_default();
    if workspaces.is_empty() {
        out.info(format!(
            "Account {parsed_account} ({label}) has no tracked workspaces."
        ));
        return 0;
    }

    let Some(workspace_arg) = args.get(1) else {
        out.info(format!("Account {parsed_account}: {label}"));
        for line in format_workspace_lines(Some(account), "  ") {
            out.info(line.as_str());
        }
        out.info("");
        out.info(format!(
            "Switch with: codex-multi-auth workspace {parsed_account} <workspace-number>"
        ));
        return 0;
    };

    let trimmed = workspace_arg.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit()) {
        out.error(format!(
            "Invalid workspace index (must be a positive integer). Valid range: 1-{}",
            workspaces.len()
        ));
        return 1;
    }
    let parsed_workspace: i64 = workspace_arg.trim_start().parse().unwrap_or(-1);
    if parsed_workspace < 1 || parsed_workspace > workspaces.len() as i64 {
        out.error(format!(
            "Invalid workspace index. Valid range: 1-{}",
            workspaces.len()
        ));
        return 1;
    }

    let workspace_index = (parsed_workspace - 1) as usize;
    let Some(target) = workspaces.get(workspace_index) else {
        out.error(format!("Workspace {parsed_workspace} not found."));
        return 1;
    };

    let target_name = target
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("(unnamed)")
        .to_string();
    if !target.enabled {
        out.error(format!(
            "Workspace {parsed_workspace} ([{target_name}]) is disabled and cannot be selected."
        ));
        return 1;
    }

    if storage.accounts[account_index].current_workspace_index == Some(workspace_index as i64) {
        out.info(format!(
            "Account {parsed_account} is already using workspace {parsed_workspace}: [{target_name}]."
        ));
        return 0;
    }

    // Guard a possibly-empty id the same way formatWorkspaceLines does, in
    // case on-disk data does not conform to the Workspace interface.
    let id = target.id.trim().to_string();
    storage.accounts[account_index].current_workspace_index = Some(workspace_index as i64);
    if let Err(error) = save_accounts_with_retry_boxed(&storage, &deps.save_accounts).await {
        out.error(error.message());
        return 1;
    }

    let id_suffix = if id.chars().count() > 6 {
        let count = id.chars().count();
        let (byte_idx, _) = id.char_indices().nth(count - 6).expect("count > 6");
        id[byte_idx..].to_string()
    } else {
        id
    };
    out.info(format!(
        "Account {parsed_account} now using workspace {parsed_workspace}: [{target_name}]{}.",
        if id_suffix.is_empty() {
            String::new()
        } else {
            format!(" (id:{id_suffix})")
        }
    ));
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3, Workspace};
    use std::sync::{Arc, Mutex};

    struct Harness {
        deps: WorkspaceCommandDeps,
        saved: Arc<Mutex<Option<AccountStorageV3>>>,
    }

    fn harness(storage: Option<AccountStorageV3>) -> Harness {
        let saved: Arc<Mutex<Option<AccountStorageV3>>> = Arc::new(Mutex::new(None));
        let saved_clone = Arc::clone(&saved);
        let deps = WorkspaceCommandDeps {
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
        };
        Harness { deps, saved }
    }

    fn workspace(id: &str, name: &str, enabled: bool) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: Some(name.to_string()),
            enabled,
            disabled_at: None,
            is_default: None,
        }
    }

    fn storage_with_workspaces(
        workspaces: Vec<Workspace>,
        current: Option<i64>,
    ) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        let mut account = AccountMetadataV3::new("token-0", 1, 1);
        account.email = Some("user@example.com".to_string());
        account.workspaces = Some(workspaces);
        account.current_workspace_index = current;
        storage.accounts.push(account);
        storage
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn missing_account_arg_errors() {
        let h = harness(Some(storage_with_workspaces(vec![], None)));
        let mut out = CliOut::capture();
        assert_eq!(run_workspace_command_with(&[], &h.deps, &mut out).await, 1);
        assert_eq!(
            out.error_text(),
            "Missing account index. Usage: codex-multi-auth workspace <account> [workspace]"
        );
    }

    #[tokio::test]
    async fn rejects_fractional_account_index() {
        let h = harness(Some(storage_with_workspaces(vec![], None)));
        let mut out = CliOut::capture();
        assert_eq!(
            run_workspace_command_with(&args(&["1.9"]), &h.deps, &mut out).await,
            1
        );
        assert_eq!(
            out.error_text(),
            "Invalid account index (must be a positive integer): 1.9"
        );
    }

    #[tokio::test]
    async fn no_tracked_workspaces_exits_zero() {
        let h = harness(Some(storage_with_workspaces(vec![], None)));
        let mut out = CliOut::capture();
        assert_eq!(
            run_workspace_command_with(&args(&["1"]), &h.deps, &mut out).await,
            0
        );
        assert_eq!(
            out.info_text(),
            "Account 1 (Account 1 (user@example.com)) has no tracked workspaces."
        );
    }

    #[tokio::test]
    async fn lists_workspaces_without_a_workspace_arg() {
        let h = harness(Some(storage_with_workspaces(
            vec![
                workspace("ws-personal", "Personal", true),
                workspace("ws-business-1", "Business", true),
            ],
            Some(0),
        )));
        let mut out = CliOut::capture();
        assert_eq!(
            run_workspace_command_with(&args(&["1"]), &h.deps, &mut out).await,
            0
        );
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "Account 1: Account 1 ([Personal], user@example.com)");
        assert_eq!(lines[1], "  * 1. [Personal] id:rsonal (active)");
        assert_eq!(lines[2], "  - 2. [Business] id:ness-1");
        assert_eq!(lines[3], "");
        assert_eq!(
            lines[4],
            "Switch with: codex-multi-auth workspace 1 <workspace-number>"
        );
        assert!(h.saved.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn disabled_workspace_cannot_be_selected() {
        let h = harness(Some(storage_with_workspaces(
            vec![workspace("a", "One", true), workspace("b", "Two", false)],
            Some(0),
        )));
        let mut out = CliOut::capture();
        assert_eq!(
            run_workspace_command_with(&args(&["1", "2"]), &h.deps, &mut out).await,
            1
        );
        assert_eq!(
            out.error_text(),
            "Workspace 2 ([Two]) is disabled and cannot be selected."
        );
    }

    #[tokio::test]
    async fn already_current_workspace_is_a_no_op() {
        let h = harness(Some(storage_with_workspaces(
            vec![workspace("a", "One", true)],
            Some(0),
        )));
        let mut out = CliOut::capture();
        assert_eq!(
            run_workspace_command_with(&args(&["1", "1"]), &h.deps, &mut out).await,
            0
        );
        assert_eq!(out.info_text(), "Account 1 is already using workspace 1: [One].");
        assert!(h.saved.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn switches_workspace_and_persists() {
        let h = harness(Some(storage_with_workspaces(
            vec![
                workspace("ws-personal", "Personal", true),
                workspace("ws-business-1", "Business", true),
            ],
            Some(0),
        )));
        let mut out = CliOut::capture();
        assert_eq!(
            run_workspace_command_with(&args(&["1", "2"]), &h.deps, &mut out).await,
            0
        );
        let saved = h.saved.lock().unwrap().clone().expect("saved");
        assert_eq!(saved.accounts[0].current_workspace_index, Some(1));
        assert_eq!(
            out.info_text(),
            "Account 1 now using workspace 2: [Business] (id:ness-1)."
        );
    }

    #[tokio::test]
    async fn workspace_index_out_of_range() {
        let h = harness(Some(storage_with_workspaces(
            vec![workspace("a", "One", true)],
            Some(0),
        )));
        let mut out = CliOut::capture();
        assert_eq!(
            run_workspace_command_with(&args(&["1", "9"]), &h.deps, &mut out).await,
            1
        );
        assert_eq!(out.error_text(), "Invalid workspace index. Valid range: 1-1");
    }
}
