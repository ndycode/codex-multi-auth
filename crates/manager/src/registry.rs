//! Port of `lib/codex-manager/account-manager-commands.ts`.
//!
//! Canonical set of subcommands routed to the account-manager dispatcher.
//! Kept in a small internal module (rather than exported from the CLI
//! entrypoint) so both the dispatcher and the wrapper-routing alignment test
//! consume the SAME source of truth (cli-manager-01/02).

/// Exact TS `ACCOUNT_MANAGER_COMMANDS` set, in source order.
///
/// NOTE: spec 08 §2 header says "set of 28" but the TS source (authority)
/// enumerates 29 entries; the TS set is ported verbatim.
pub const ACCOUNT_MANAGER_COMMANDS: [&str; 29] = [
    "login",
    "list",
    "status",
    "switch",
    "unpin",
    "workspace",
    "best",
    "check",
    "features",
    "usage",
    "verify-flagged",
    "verify",
    "forecast",
    "report",
    "fix",
    "doctor",
    "uninstall",
    "account",
    "budget",
    "bridge",
    "integrations",
    "models",
    "monitor",
    "rotation",
    "why-selected",
    "history",
    "config",
    "init-config",
    "debug",
];

/// TS `ACCOUNT_MANAGER_COMMANDS.has(command)`.
pub fn is_account_manager_command(command: &str) -> bool {
    ACCOUNT_MANAGER_COMMANDS.contains(&command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_every_ts_command_exactly_once() {
        assert_eq!(ACCOUNT_MANAGER_COMMANDS.len(), 29);
        let mut deduped: Vec<&str> = ACCOUNT_MANAGER_COMMANDS.to_vec();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(deduped.len(), 29, "duplicate command in registry");
    }

    #[test]
    fn membership_matches_ts_set() {
        for command in [
            "login",
            "status",
            "why-selected",
            "verify-flagged",
            "init-config",
            "debug",
        ] {
            assert!(is_account_manager_command(command), "{command} missing");
        }
        assert!(!is_account_manager_command("auth"));
        assert!(!is_account_manager_command(""));
        assert!(!is_account_manager_command("Login"));
        assert!(!is_account_manager_command("verify_flagged"));
    }
}
