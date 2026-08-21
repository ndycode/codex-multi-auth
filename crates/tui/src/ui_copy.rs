//! Port of `lib/ui/ui-copy.ts` — ALL user-facing copy strings, verbatim.
//!
//! The TS `UI_COPY` nested const object maps to nested modules of consts;
//! function-valued entries become functions. Strings are FROZEN — do not edit
//! wording, punctuation, or spacing (spec 12 §8 / spec 14 §8).

pub mod main_menu {
    pub const TITLE: &str = "Accounts Dashboard";
    pub const SEARCH_SUBTITLE_PREFIX: &str = "Search:";
    pub const QUICK_START: &str = "Quick Actions";
    pub const ADD_ACCOUNT: &str = "Add New Account";
    pub const CHECK_ACCOUNTS: &str = "Run Health Check";
    pub const BEST_ACCOUNT: &str = "Pick Best Account";
    pub const FIX_ISSUES: &str = "Auto-Repair Issues";
    pub const SETTINGS: &str = "Settings";
    pub const MORE_CHECKS: &str = "Advanced Checks";
    pub const REFRESH_CHECKS: &str = "Refresh All Accounts";
    pub const CHECK_FLAGGED: &str = "Check Problem Accounts";
    pub const ACCOUNTS: &str = "Saved Accounts";
    pub const LOADING_LIMITS: &str = "Fetching account limits...";
    pub const NO_SEARCH_MATCHES: &str = "No accounts match your search";
    pub const DANGER_ZONE: &str = "Danger Zone";
    pub const REMOVE_ALL_ACCOUNTS: &str = "Delete All Accounts";
    pub const HELP_COMPACT: &str = "\u{2191}\u{2193} Move | Enter Select | / Search | 1-9 Switch | Q Back";
    pub const HELP_DETAILED: &str =
        "Arrow keys move, Enter selects, / searches, 1-9 switches account, Q goes back";
}

pub mod account_details {
    pub const BACK: &str = "Back";
    pub const ENABLE: &str = "Enable Account";
    pub const DISABLE: &str = "Disable Account";
    pub const SET_CURRENT: &str = "Set As Current";
    pub const REFRESH: &str = "Re-Login";
    pub const REMOVE: &str = "Delete Account";
    pub const HELP: &str = "\u{2191}\u{2193} Move | Enter Select | S Use | R Sign In | D Delete | Q Back";
}

pub mod oauth {
    pub const CHOOSE_MODE_TITLE: &str = "Get Started";
    pub const CHOOSE_MODE_SUBTITLE: &str = "Choose how you want to continue.";
    pub const SIGN_IN_HEADING: &str = "Sign in";
    pub const RESTORE_HEADING: &str = "Recover saved accounts";
    pub const OPEN_BROWSER: &str = "Open Browser (Easy)";
    pub const MANUAL_MODE: &str = "Manual / Incognito";
    pub const RESTORE_SAVED_BACKUP: &str = "Restore Saved Backup";
    pub const LOAD_LAST_BACKUP: &str = "Load Last Saved Backup (Recommended)";
    pub const CHOOSE_BACKUP_MANUALLY: &str = "Choose Backup Manually";
    pub const BACK: &str = "Back";
    pub const CHOOSE_MODE_HELP: &str =
        "\u{2191}\u{2193} Move | Enter Select | 1 Easy | 2 Manual | Q Back";
    pub const CHOOSE_MODE_HELP_WITH_BACKUP: &str =
        "\u{2191}\u{2193} Move | Enter Select | 1 Easy | 2 Manual | 3 Backup | Q Back";
    pub const RESTORE_BACKUP_TITLE: &str = "Restore Saved Backup";
    pub const RESTORE_BACKUP_SUBTITLE: &str = "Choose how you want to recover saved accounts.";
    pub const RESTORE_BACKUP_LATEST_HINT: &str = "Fastest way to recover your saved accounts.";
    pub const RESTORE_BACKUP_HELP: &str =
        "\u{2191}\u{2193} Move | Enter Select | 1 Latest | 2 Manual | Q Back";
    pub const MANUAL_BACKUP_TITLE: &str = "Choose Backup";
    pub const MANUAL_BACKUP_SUBTITLE: &str = "Pick a saved backup to restore.";
    pub const MANUAL_BACKUP_HELP: &str = "\u{2191}\u{2193} Move | Enter Select | Q Back";

    /// `loadLastBackupHint(fileName, accountCount, savedAt)`.
    pub fn load_last_backup_hint(file_name: &str, account_count: i64, saved_at: &str) -> String {
        format!(
            "{file_name} | {account_count} account{} | saved {saved_at}",
            if account_count == 1 { "" } else { "s" }
        )
    }

    /// `manualBackupHint(accountCount, savedAt)`.
    pub fn manual_backup_hint(account_count: i64, saved_at: &str) -> String {
        format!(
            "{account_count} account{} | saved {saved_at}",
            if account_count == 1 { "" } else { "s" }
        )
    }

    /// `restoreBackupConfirm(fileName, accountCount)`.
    pub fn restore_backup_confirm(file_name: &str, account_count: i64) -> String {
        format!(
            "Load {file_name} ({account_count} account{})?",
            if account_count == 1 { "" } else { "s" }
        )
    }

    /// `restoreBackupLoaded(fileName, accountCount)`.
    pub fn restore_backup_loaded(file_name: &str, account_count: i64) -> String {
        format!(
            "Loaded {file_name} ({account_count} account{}).",
            if account_count == 1 { "" } else { "s" }
        )
    }

    pub const RESTORE_BACKUP_SYNC_WARNING: &str = "Backup loaded locally, but Codex auth sync did not complete. Multi-auth routing will still use the restored account pool.";
    pub const GO_TO: &str = "Go to:";
    pub const COPY_OK: &str = "Login link copied.";
    pub const COPY_FAIL: &str = "Could not copy login link.";
    pub const PASTE_PROMPT: &str = "Paste callback URL or code here (Q to cancel):";
    pub const BROWSER_OPENED: &str = "Browser opened.";
    pub const BROWSER_OPEN_FAIL: &str = "Could not open browser. Use this link:";
    /// `Waiting for login callback on ${AUTH_REDIRECT.host}:${AUTH_REDIRECT.port}...`
    /// with `AUTH_REDIRECT` parsed from `REDIRECT_URI =
    /// "http://localhost:1455/auth/callback"` (host `localhost`, port `1455`).
    pub const WAITING_CALLBACK: &str = "Waiting for login callback on localhost:1455...";
    pub const CALLBACK_BYPASSED: &str = "Manual mode active. Paste the callback URL manually.";
    pub const CALLBACK_UNAVAILABLE: &str =
        "Callback listener unavailable. Paste the callback URL manually.";
    pub const CALLBACK_MISSED: &str = "No callback received. Paste manually.";
    pub const CANCELLED: &str = "Sign-in cancelled.";
    pub const CANCELLED_BACK_TO_MENU: &str = "Sign-in cancelled. Going back to menu.";
    pub const CALLBACK_INVALID: &str = "That callback URL is missing the code or state parameter. Paste the full URL you were redirected to (it should contain both code= and state=).";
    pub const CALLBACK_STATE_MISMATCH: &str = "OAuth state mismatch. That callback URL was generated for a different login attempt. Restart login and paste the callback URL from this attempt.";
}

pub mod return_flow {
    pub const CONTINUE_PROMPT: &str = "Press Enter to go back.";
    pub const ACTION_FAILED_PROMPT: &str = "Action failed. Press Enter to go back.";

    /// `autoReturn(seconds)`.
    pub fn auto_return(seconds: i64) -> String {
        format!("Returning in {seconds}s... Press any key to pause.")
    }

    pub const PAUSED: &str = "Paused. Press any key to continue.";
    pub const WORKING: &str = "Running...";
    pub const DONE: &str = "Done.";
    pub const FAILED: &str = "Failed.";
}

pub mod settings {
    pub const TITLE: &str = "Settings";
    pub const SUBTITLE: &str = "Customize menu, behavior, backend, and experiments";
    pub const HELP: &str = "\u{2191}\u{2193} Move | Enter Select | Q Back";
    pub const SECTION_TITLE: &str = "Basic";
    pub const ADVANCED_TITLE: &str = "Advanced";
    pub const EXIT_TITLE: &str = "Back";
    pub const ACCOUNT_LIST: &str = "Account List View";
    pub const SUMMARY_FIELDS: &str = "Summary Line";
    pub const BEHAVIOR: &str = "Menu Behavior";
    pub const THEME: &str = "Color Theme";
    pub const EXPERIMENTAL: &str = "Experimental";
    pub const EXPERIMENTAL_TITLE: &str = "Experimental";
    pub const EXPERIMENTAL_SUBTITLE: &str =
        "Preview sync and backup actions before they become stable";
    pub const EXPERIMENTAL_HELP_MENU: &str =
        "Enter Select | 1 Sync | 2 Backup | 3 Guard | [ - Down | ] + Up | S Save | Q Back";
    pub const EXPERIMENTAL_HELP_PREVIEW: &str = "Enter Select | A Apply | Q Back";
    pub const EXPERIMENTAL_HELP_STATUS: &str = "Enter Select | Q Back";
    pub const EXPERIMENTAL_SYNC: &str = "Sync Accounts to oc-chatgpt-multi-auth";
    pub const EXPERIMENTAL_APPLY_SYNC: &str = "Apply Sync";
    pub const EXPERIMENTAL_BACKUP: &str = "Save Pool Backup";
    pub const EXPERIMENTAL_BACKUP_PROMPT: &str = "Backup file name (.json): ";
    pub const EXPERIMENTAL_REFRESH_GUARD: &str = "Enable Refresh Guard";
    pub const EXPERIMENTAL_REFRESH_INTERVAL: &str = "Refresh Guard Interval";
    pub const EXPERIMENTAL_DECREASE_INTERVAL: &str = "Decrease Refresh Interval";
    pub const EXPERIMENTAL_INCREASE_INTERVAL: &str = "Increase Refresh Interval";
    pub const BACKEND: &str = "Backend Controls";
    pub const BACK: &str = "Back";
    pub const PREVIEW_HEADING: &str = "Live Preview";
    pub const DISPLAY_HEADING: &str = "Options";
    pub const RESET_DEFAULT: &str = "Reset to Default";
    pub const SAVE_AND_BACK: &str = "Save and Back";
    pub const BACK_NO_SAVE: &str = "Back Without Saving";
    pub const ACCOUNT_LIST_TITLE: &str = "Account List View";
    pub const ACCOUNT_LIST_SUBTITLE: &str = "Choose row details and optional smart sorting";
    pub const ACCOUNT_LIST_HELP: &str =
        "Enter Toggle | Number Toggle | M Sort | L Layout | S Save | Q Back (No Save)";
    pub const SUMMARY_TITLE: &str = "Account Details Row";
    pub const SUMMARY_SUBTITLE: &str = "Choose and order detail fields";
    pub const SUMMARY_HELP: &str =
        "Enter Toggle | 1-3 Toggle | [ ] Reorder | S Save | Q Back (No Save)";
    pub const BEHAVIOR_TITLE: &str = "Return Behavior";
    pub const BEHAVIOR_SUBTITLE: &str = "Control how result screens return";
    pub const BEHAVIOR_HELP: &str =
        "Enter Select | 1-3 Delay | P Pause | L AutoFetch | F Status | T TTL | S Save | Q Back (No Save)";
    pub const THEME_TITLE: &str = "Color Theme";
    pub const THEME_SUBTITLE: &str = "Pick base color and accent";
    pub const THEME_HELP: &str = "Enter Select | 1-2 Base | S Save | Q Back (No Save)";
    pub const BACKEND_TITLE: &str = "Backend Controls";
    pub const BACKEND_SUBTITLE: &str = "Tune sync, retry, and limit behavior";
    pub const BACKEND_HELP: &str = "Enter Open | 1-4 Category | S Save | R Reset | Q Back (No Save)";
    pub const BACKEND_CATEGORIES_HEADING: &str = "Categories";
    pub const BACKEND_CATEGORY_TITLE: &str = "Backend Category";
    pub const BACKEND_CATEGORY_HELP: &str =
        "Enter Toggle/Adjust | +/- or [ ] Number | 1-9 Toggle | R Reset | Q Back";
    pub const BACKEND_TOGGLE_HEADING: &str = "Switches";
    pub const BACKEND_NUMBER_HEADING: &str = "Numbers";
    pub const BACKEND_DECREASE: &str = "Decrease Focused Value";
    pub const BACKEND_INCREASE: &str = "Increase Focused Value";
    pub const BACKEND_RESET_CATEGORY: &str = "Reset Category";
    pub const BACKEND_BACK_TO_CATEGORIES: &str = "Back to Categories";
    pub const BASE_THEME: &str = "Base Color";
    pub const ACCENT_COLOR: &str = "Accent Color";
    pub const ACTION_TIMING: &str = "Auto Return Delay";
    pub const MOVE_UP: &str = "Move Focused Field Up";
    pub const MOVE_DOWN: &str = "Move Focused Field Down";
}

pub mod fallback {
    pub const ADD_ANOTHER_TIP: &str =
        "Tip: Use private mode or sign out before adding another account.";

    /// `addAnotherQuestion(count)`.
    pub fn add_another_question(count: i64) -> String {
        format!("Add another account? ({count} added) (y/n): ")
    }

    pub const SELECT_MODE_PROMPT: &str = "(a) add, (c) check, (b) best, fi(x), (s) settings, (d) deep, (g) problem, (f) fresh, (q) back [a/c/b/x/s/d/g/f/q]: ";
    pub const INVALID_MODE_PROMPT: &str = "Use one of: a, c, b, x, s, d, g, f, q.";
}

/// `formatCheckFlaggedLabel(flaggedCount)` — appends the flagged count when
/// greater than zero.
pub fn format_check_flagged_label(flagged_count: i64) -> String {
    if flagged_count > 0 {
        format!("{} ({flagged_count})", main_menu::CHECK_FLAGGED)
    } else {
        main_menu::CHECK_FLAGGED.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_check_flagged_label_appends_count_only_when_positive() {
        assert_eq!(format_check_flagged_label(0), "Check Problem Accounts");
        assert_eq!(format_check_flagged_label(-1), "Check Problem Accounts");
        assert_eq!(format_check_flagged_label(3), "Check Problem Accounts (3)");
    }

    #[test]
    fn key_strings_are_frozen() {
        assert_eq!(main_menu::TITLE, "Accounts Dashboard");
        assert_eq!(
            main_menu::HELP_COMPACT,
            "↑↓ Move | Enter Select | / Search | 1-9 Switch | Q Back"
        );
        assert_eq!(
            main_menu::HELP_DETAILED,
            "Arrow keys move, Enter selects, / searches, 1-9 switches account, Q goes back"
        );
        assert_eq!(
            account_details::HELP,
            "↑↓ Move | Enter Select | S Use | R Sign In | D Delete | Q Back"
        );
        assert_eq!(
            oauth::WAITING_CALLBACK,
            "Waiting for login callback on localhost:1455..."
        );
        assert_eq!(
            oauth::PASTE_PROMPT,
            "Paste callback URL or code here (Q to cancel):"
        );
        assert_eq!(
            settings::EXPERIMENTAL_SYNC,
            "Sync Accounts to oc-chatgpt-multi-auth"
        );
        assert_eq!(
            settings::EXPERIMENTAL_BACKUP_PROMPT,
            "Backup file name (.json): "
        );
        assert_eq!(
            fallback::SELECT_MODE_PROMPT,
            "(a) add, (c) check, (b) best, fi(x), (s) settings, (d) deep, (g) problem, (f) fresh, (q) back [a/c/b/x/s/d/g/f/q]: "
        );
        assert_eq!(fallback::INVALID_MODE_PROMPT, "Use one of: a, c, b, x, s, d, g, f, q.");
    }

    #[test]
    fn function_valued_entries_pluralize_exactly() {
        assert_eq!(
            oauth::load_last_backup_hint("pool.json", 1, "2026-07-01"),
            "pool.json | 1 account | saved 2026-07-01"
        );
        assert_eq!(
            oauth::load_last_backup_hint("pool.json", 2, "2026-07-01"),
            "pool.json | 2 accounts | saved 2026-07-01"
        );
        assert_eq!(oauth::manual_backup_hint(0, "x"), "0 accounts | saved x");
        assert_eq!(
            oauth::restore_backup_confirm("a.json", 1),
            "Load a.json (1 account)?"
        );
        assert_eq!(
            oauth::restore_backup_loaded("a.json", 5),
            "Loaded a.json (5 accounts)."
        );
        assert_eq!(
            return_flow::auto_return(3),
            "Returning in 3s... Press any key to pause."
        );
        assert_eq!(
            fallback::add_another_question(2),
            "Add another account? (2 added) (y/n): "
        );
    }
}
