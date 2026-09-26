//! Port of `lib/cli.ts` — readline/TUI prompts for the `login` command
//! (mode menu, workspace selection, non-interactive detection).
//!
//! Contracts preserved (spec 07 §11 + gotcha 20):
//! - non-interactive `prompt_login_mode` always returns `add`; non-interactive
//!   `prompt_account_selection` silently picks the default index;
//! - the plain-readline fallback "fresh" path skips the typed confirmation,
//!   while the TUI path requires typing `DELETE` exactly;
//! - `FORCE_INTERACTIVE_MODE=1` overrides every non-interactive signal.

use std::io::{BufRead, IsTerminal, Write};

pub use crate::ansi::is_tty;
pub use crate::auth_menu_builder::AccountStatus;
use crate::auth_menu::{show_account_details, show_auth_menu};
use crate::auth_menu_builder::{AccountAction, AccountInfo, AuthMenuAction, AuthMenuOptions};
use crate::select::SelectError;
use crate::ui_copy;
use cma_core::schemas::account_storage::AccountIdSource;

/// TS `ExistingAccountInfo` — same field set as the dashboard payload.
pub type ExistingAccountInfo = AccountInfo;

/// TS `LoginMenuOptions` — same shape as the dashboard options.
pub type LoginMenuOptions<'a> = AuthMenuOptions<'a>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[derive(Default)]
pub enum LoginMode {
    Add,
    Forecast,
    Fix,
    Settings,
    Fresh,
    Manage,
    Check,
    DeepCheck,
    VerifyFlagged,
    #[default]
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LoginMenuResult {
    pub mode: LoginModeField,
    pub delete_account_index: Option<i64>,
    pub refresh_account_index: Option<i64>,
    pub toggle_account_index: Option<i64>,
    pub switch_account_index: Option<i64>,
    pub delete_all: bool,
}

// `LoginMenuResult.mode` is required in TS; default only exists so struct
// update syntax stays ergonomic.
pub type LoginModeField = LoginMode;


impl LoginMenuResult {
    pub fn mode(mode: LoginMode) -> Self {
        LoginMenuResult {
            mode,
            ..Default::default()
        }
    }
}

/// Testable core of [`is_non_interactive_mode`].
pub(crate) fn is_non_interactive_mode_from(
    env: &dyn Fn(&str) -> Option<String>,
    stdin_tty: bool,
    stdout_tty: bool,
) -> bool {
    if env("FORCE_INTERACTIVE_MODE").as_deref() == Some("1") {
        return false;
    }
    if !stdin_tty || !stdout_tty {
        return true;
    }
    if env("CODEX_TUI").as_deref() == Some("1") {
        return true;
    }
    if env("CODEX_DESKTOP").as_deref() == Some("1") {
        return true;
    }
    if env("TERM_PROGRAM").unwrap_or_default().trim().to_lowercase() == "codex" {
        return true;
    }
    if env("ELECTRON_RUN_AS_NODE").as_deref() == Some("1") {
        return true;
    }
    false
}

/// Detect host Desktop/TUI mode where readline prompts don't work (the host
/// owns stdio there).
pub fn is_non_interactive_mode() -> bool {
    is_non_interactive_mode_from(
        &|key| std::env::var(key).ok(),
        std::io::stdin().is_terminal(),
        std::io::stdout().is_terminal(),
    )
}

/// `rl.question(...)` analogue: print the prompt without a newline, read one
/// line. EOF/read failure yields an empty answer.
fn question(prompt: &str) -> String {
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "{prompt}");
    let _ = stdout.flush();
    let mut answer = String::new();
    let _ = std::io::stdin().lock().read_line(&mut answer);
    answer.trim_end_matches(['\r', '\n']).to_string()
}

/// `promptAddAnotherAccount` — non-interactive → `false`; else prints the tip
/// and asks `Add another account? (N added) (y/n): `.
pub fn prompt_add_another_account(current_count: i64) -> bool {
    if is_non_interactive_mode() {
        return false;
    }
    println!("\n{}\n", ui_copy::fallback::ADD_ANOTHER_TIP);
    let answer = question(&ui_copy::fallback::add_another_question(current_count));
    let normalized = answer.trim().to_lowercase();
    normalized == "y" || normalized == "yes"
}

/// `formatAccountLabel` — `"<n>. <label> (<email>)"` | `"<n>. <email>"` |
/// `"<n>. <label>"` | `"<n>. <last-6-of-accountId>"` | `"<n>. Account"`.
pub(crate) fn format_account_label(account: &ExistingAccountInfo, index: i64) -> String {
    let num = index + 1;
    let label = account
        .account_label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    if let Some(email) = account.email.as_deref()
        && !email.trim().is_empty() {
            return match label {
                Some(label) => format!("{num}. {label} ({email})"),
                None => format!("{num}. {email}"),
            };
        }
    if let Some(label) = label {
        return format!("{num}. {label}");
    }
    if let Some(account_id) = account.account_id.as_deref()
        && !account_id.trim().is_empty() {
            let chars: Vec<char> = account_id.chars().collect();
            let suffix: String = if chars.len() > 6 {
                chars[chars.len() - 6..].iter().collect()
            } else {
                account_id.to_string()
            };
            return format!("{num}. {suffix}");
        }
    format!("{num}. Account")
}

/// `resolveAccountSourceIndex` — prefer finite `source_index` (floored, min 0),
/// else `index`, else `-1`.
pub(crate) fn resolve_account_source_index(account: &ExistingAccountInfo) -> i64 {
    if let Some(source_index) = account.source_index {
        return source_index.max(0);
    }
    account.index.max(0)
}

fn warn_unresolvable_account_selection(account: &ExistingAccountInfo) {
    let label = account
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            account
                .account_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("index {}", account.index + 1));
    println!("Unable to resolve saved account for action: {label}");
}

fn prompt_delete_all_typed_confirm() -> bool {
    let answer = question("Type DELETE to remove all saved accounts: ");
    answer.trim() == "DELETE"
}

/// Pure classification of one fallback-menu answer. `None` = invalid input
/// (the caller prints the invalid-mode message and re-prompts).
pub(crate) fn classify_fallback_mode_input(answer: &str) -> Option<LoginMenuResult> {
    let normalized = answer.trim().to_lowercase();
    match normalized.as_str() {
        "a" | "add" => Some(LoginMenuResult::mode(LoginMode::Add)),
        "b" | "p" | "forecast" => Some(LoginMenuResult::mode(LoginMode::Forecast)),
        "x" | "fix" => Some(LoginMenuResult::mode(LoginMode::Fix)),
        "s" | "settings" | "configure" => Some(LoginMenuResult::mode(LoginMode::Settings)),
        // NOTE: no typed DELETE confirm on the fallback path (gotcha 20).
        "f" | "fresh" | "clear" => Some(LoginMenuResult {
            mode: LoginMode::Fresh,
            delete_all: true,
            ..Default::default()
        }),
        "c" | "check" => Some(LoginMenuResult::mode(LoginMode::Check)),
        "d" | "deep" => Some(LoginMenuResult::mode(LoginMode::DeepCheck)),
        "g" | "flagged" | "verify-flagged" | "verify" => {
            Some(LoginMenuResult::mode(LoginMode::VerifyFlagged))
        }
        "q" | "quit" => Some(LoginMenuResult::mode(LoginMode::Cancel)),
        _ => None,
    }
}

fn prompt_login_mode_fallback(existing_accounts: &[ExistingAccountInfo]) -> LoginMenuResult {
    if !existing_accounts.is_empty() {
        println!("\n{} account(s) saved:", existing_accounts.len());
        for account in existing_accounts {
            println!("  {}", format_account_label(account, account.index));
        }
        println!();
    }

    loop {
        let answer = question(ui_copy::fallback::SELECT_MODE_PROMPT);
        if let Some(result) = classify_fallback_mode_input(&answer) {
            return result;
        }
        println!("{}", ui_copy::fallback::INVALID_MODE_PROMPT);
    }
}

fn manage_result(account: &ExistingAccountInfo, action: AccountAction) -> Option<LoginMenuResult> {
    let index = resolve_account_source_index(account);
    if index < 0 {
        warn_unresolvable_account_selection(account);
        return None;
    }
    let mut result = LoginMenuResult::mode(LoginMode::Manage);
    match action {
        AccountAction::Delete => result.delete_account_index = Some(index),
        AccountAction::SetCurrent => result.switch_account_index = Some(index),
        AccountAction::Refresh => result.refresh_account_index = Some(index),
        AccountAction::Toggle => result.toggle_account_index = Some(index),
        AccountAction::Back | AccountAction::Cancel => return None,
    }
    Some(result)
}

/// `promptLoginMode` — headless → `add`; interactive-but-not-TTY → readline
/// fallback menu; full TTY → dashboard TUI loop.
pub fn prompt_login_mode(
    existing_accounts: &[ExistingAccountInfo],
    options: &LoginMenuOptions<'_>,
) -> Result<LoginMenuResult, SelectError> {
    if is_non_interactive_mode() {
        return Ok(LoginMenuResult::mode(LoginMode::Add));
    }

    if !is_tty() {
        return Ok(prompt_login_mode_fallback(existing_accounts));
    }

    loop {
        let action = show_auth_menu(existing_accounts, options)?;

        match action {
            AuthMenuAction::Add => return Ok(LoginMenuResult::mode(LoginMode::Add)),
            AuthMenuAction::Forecast => return Ok(LoginMenuResult::mode(LoginMode::Forecast)),
            AuthMenuAction::Fix => return Ok(LoginMenuResult::mode(LoginMode::Fix)),
            AuthMenuAction::Settings => return Ok(LoginMenuResult::mode(LoginMode::Settings)),
            AuthMenuAction::Fresh | AuthMenuAction::DeleteAll => {
                if !prompt_delete_all_typed_confirm() {
                    println!("\nDelete all cancelled.\n");
                    continue;
                }
                return Ok(LoginMenuResult {
                    mode: LoginMode::Fresh,
                    delete_all: true,
                    ..Default::default()
                });
            }
            AuthMenuAction::Check => return Ok(LoginMenuResult::mode(LoginMode::Check)),
            AuthMenuAction::DeepCheck => return Ok(LoginMenuResult::mode(LoginMode::DeepCheck)),
            AuthMenuAction::VerifyFlagged => {
                return Ok(LoginMenuResult::mode(LoginMode::VerifyFlagged));
            }
            AuthMenuAction::SelectAccount(account) => {
                let account_action = show_account_details(&account)?;
                match account_action {
                    AccountAction::Delete
                    | AccountAction::SetCurrent
                    | AccountAction::Refresh
                    | AccountAction::Toggle => {
                        if let Some(result) = manage_result(&account, account_action) {
                            return Ok(result);
                        }
                        continue;
                    }
                    _ => continue,
                }
            }
            AuthMenuAction::SetCurrentAccount(account) => {
                if let Some(result) = manage_result(&account, AccountAction::SetCurrent) {
                    return Ok(result);
                }
                continue;
            }
            AuthMenuAction::RefreshAccount(account) => {
                if let Some(result) = manage_result(&account, AccountAction::Refresh) {
                    return Ok(result);
                }
                continue;
            }
            AuthMenuAction::ToggleAccount(account) => {
                if let Some(result) = manage_result(&account, AccountAction::Toggle) {
                    return Ok(result);
                }
                continue;
            }
            AuthMenuAction::DeleteAccount(account) => {
                if let Some(result) = manage_result(&account, AccountAction::Delete) {
                    return Ok(result);
                }
                continue;
            }
            // Search is handled in show_auth_menu; keep the main loop active.
            AuthMenuAction::Search => continue,
            AuthMenuAction::Cancel => return Ok(LoginMenuResult::mode(LoginMode::Cancel)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSelectionCandidate {
    pub account_id: String,
    pub label: String,
    pub source: Option<AccountIdSource>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AccountSelectionOptions {
    pub default_index: Option<i64>,
    pub title: Option<String>,
}

/// `promptAccountSelection` — workspace picker. Empty list → `None`;
/// non-interactive → the default candidate without prompting.
pub fn prompt_account_selection(
    candidates: &[AccountSelectionCandidate],
    options: &AccountSelectionOptions,
) -> Option<AccountSelectionCandidate> {
    if candidates.is_empty() {
        return None;
    }
    let default_index = options
        .default_index
        .map(|i| i.clamp(0, candidates.len() as i64 - 1) as usize)
        .unwrap_or(0);

    if is_non_interactive_mode() {
        return candidates
            .get(default_index)
            .or_else(|| candidates.first())
            .cloned();
    }

    println!(
        "\n{}",
        options
            .title
            .as_deref()
            .unwrap_or("Multiple workspaces detected for this account:")
    );
    for (index, candidate) in candidates.iter().enumerate() {
        let is_default = if candidate.is_default { " (default)" } else { "" };
        println!("  {}. {}{is_default}", index + 1, candidate.label);
    }
    println!();

    loop {
        let answer = question(&format!("Select workspace [{}]: ", default_index + 1));
        let normalized = answer.trim().to_lowercase();
        if normalized.is_empty() || normalized == "q" || normalized == "quit" {
            return candidates
                .get(default_index)
                .or_else(|| candidates.first())
                .cloned();
        }
        if let Some(parsed) = crate::auth_menu_builder::parse_int_prefix(&normalized) {
            let idx = parsed - 1;
            if idx >= 0 && (idx as usize) < candidates.len() {
                return candidates.get(idx as usize).cloned();
            }
        }
        println!("Please enter a number between 1 and {}.", candidates.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    // ---- isNonInteractiveMode (spec 07 §11) ----

    #[test]
    fn force_interactive_mode_overrides_everything() {
        let env = env_from(&[("FORCE_INTERACTIVE_MODE", "1"), ("CODEX_TUI", "1")]);
        assert!(!is_non_interactive_mode_from(&env, false, false));
    }

    #[test]
    fn non_tty_streams_are_non_interactive() {
        let env = env_from(&[]);
        assert!(is_non_interactive_mode_from(&env, false, true));
        assert!(is_non_interactive_mode_from(&env, true, false));
        assert!(!is_non_interactive_mode_from(&env, true, true));
    }

    #[test]
    fn host_env_markers_force_non_interactive() {
        for var in ["CODEX_TUI", "CODEX_DESKTOP", "ELECTRON_RUN_AS_NODE"] {
            let env = env_from(&[(var, "1")]);
            assert!(is_non_interactive_mode_from(&env, true, true), "{var}");
            // Only the literal "1" triggers.
            let env = env_from(&[(var, "true")]);
            assert!(!is_non_interactive_mode_from(&env, true, true), "{var}");
        }
    }

    #[test]
    fn term_program_codex_is_case_insensitive_and_trimmed() {
        let env = env_from(&[("TERM_PROGRAM", "  Codex  ")]);
        assert!(is_non_interactive_mode_from(&env, true, true));
        let env = env_from(&[("TERM_PROGRAM", "vscode")]);
        assert!(!is_non_interactive_mode_from(&env, true, true));
    }

    // ---- formatAccountLabel ----

    fn acct(overrides: impl FnOnce(&mut ExistingAccountInfo)) -> ExistingAccountInfo {
        let mut info = ExistingAccountInfo {
            index: 0,
            ..Default::default()
        };
        overrides(&mut info);
        info
    }

    #[test]
    fn formats_account_labels_by_priority() {
        assert_eq!(
            format_account_label(
                &acct(|a| {
                    a.account_label = Some("Team".into());
                    a.email = Some("a@b.c".into());
                }),
                0
            ),
            "1. Team (a@b.c)"
        );
        assert_eq!(
            format_account_label(&acct(|a| a.email = Some("a@b.c".into())), 1),
            "2. a@b.c"
        );
        assert_eq!(
            format_account_label(&acct(|a| a.account_label = Some("Team".into())), 0),
            "1. Team"
        );
        assert_eq!(
            format_account_label(&acct(|a| a.account_id = Some("acc_1234567890".into())), 0),
            "1. 567890"
        );
        assert_eq!(
            format_account_label(&acct(|a| a.account_id = Some("abc".into())), 0),
            "1. abc"
        );
        assert_eq!(format_account_label(&acct(|_| {}), 2), "3. Account");
    }

    // ---- resolveAccountSourceIndex ----

    #[test]
    fn resolves_source_index_with_floor_at_zero() {
        assert_eq!(
            resolve_account_source_index(&acct(|a| a.source_index = Some(5))),
            5
        );
        assert_eq!(
            resolve_account_source_index(&acct(|a| a.source_index = Some(-3))),
            0
        );
        assert_eq!(resolve_account_source_index(&acct(|a| a.index = 4)), 4);
        assert_eq!(resolve_account_source_index(&acct(|a| a.index = -2)), 0);
    }

    // ---- fallback mode classification (spec 07 §11 mapping) ----

    #[test]
    fn classifies_every_fallback_mode_token() {
        let cases: Vec<(&str, LoginMode)> = vec![
            ("a", LoginMode::Add),
            ("add", LoginMode::Add),
            ("b", LoginMode::Forecast),
            ("p", LoginMode::Forecast),
            ("forecast", LoginMode::Forecast),
            ("x", LoginMode::Fix),
            ("fix", LoginMode::Fix),
            ("s", LoginMode::Settings),
            ("settings", LoginMode::Settings),
            ("configure", LoginMode::Settings),
            ("c", LoginMode::Check),
            ("check", LoginMode::Check),
            ("d", LoginMode::DeepCheck),
            ("deep", LoginMode::DeepCheck),
            ("g", LoginMode::VerifyFlagged),
            ("flagged", LoginMode::VerifyFlagged),
            ("verify-flagged", LoginMode::VerifyFlagged),
            ("verify", LoginMode::VerifyFlagged),
            ("q", LoginMode::Cancel),
            ("quit", LoginMode::Cancel),
        ];
        for (token, expected) in cases {
            let result = classify_fallback_mode_input(token).unwrap_or_else(|| {
                panic!("token {token:?} should classify");
            });
            assert_eq!(result.mode, expected, "token {token:?}");
            assert!(!result.delete_all);
        }
        // Trim + case-insensitive.
        assert_eq!(
            classify_fallback_mode_input("  ADD  ").unwrap().mode,
            LoginMode::Add
        );
    }

    #[test]
    fn fallback_fresh_sets_delete_all_without_typed_confirm() {
        for token in ["f", "fresh", "clear"] {
            let result = classify_fallback_mode_input(token).unwrap();
            assert_eq!(result.mode, LoginMode::Fresh);
            assert!(result.delete_all);
        }
    }

    #[test]
    fn invalid_fallback_tokens_are_rejected() {
        assert!(classify_fallback_mode_input("z").is_none());
        assert!(classify_fallback_mode_input("").is_none());
        assert!(classify_fallback_mode_input("delete").is_none());
    }

    // ---- manage_result index shaping ----

    #[test]
    fn manage_result_maps_actions_to_index_fields() {
        let account = acct(|a| {
            a.index = 1;
            a.source_index = Some(7);
        });
        let delete = manage_result(&account, AccountAction::Delete).unwrap();
        assert_eq!(delete.mode, LoginMode::Manage);
        assert_eq!(delete.delete_account_index, Some(7));
        assert_eq!(delete.switch_account_index, None);

        let switch = manage_result(&account, AccountAction::SetCurrent).unwrap();
        assert_eq!(switch.switch_account_index, Some(7));

        let refresh = manage_result(&account, AccountAction::Refresh).unwrap();
        assert_eq!(refresh.refresh_account_index, Some(7));

        let toggle = manage_result(&account, AccountAction::Toggle).unwrap();
        assert_eq!(toggle.toggle_account_index, Some(7));
    }
}
