//! Port of `lib/codex-manager/login-menu-actions.ts` — per-menu-item action
//! handlers for the login dashboard: sign-in mode and backup-restore prompts
//! plus the manage actions (switch/delete/toggle/refresh an account row).

use cma_core::errors::CodexError;
use cma_core::model_family::MODEL_FAMILIES;
use cma_core::schemas::account_storage::{
    AccountMetadataV3, AccountStorageV3, ActiveIndexByFamily,
};
use cma_core::token_utils::sanitize_email;
use cma_storage::matching::{
    find_matching_account_index, reconcile_pinned_account_index, AccountMatchOptions,
    AccountSelectionCandidate,
};
use cma_storage::named_backups::NamedBackupSummary;
use cma_storage::transactions::with_account_storage_transaction;
use cma_tui::login_prompts::LoginMenuResult;
use cma_tui::runtime_options::get_ui_runtime_options;
use cma_tui::select::{select, MenuColor, MenuItem, SelectInputResult, SelectOptions};
use cma_tui::ui_copy;

use crate::commands::switch::run_switch_command;
use crate::dispatcher::CliOut;
use crate::formatters::account::format_backup_saved_at;
use crate::formatters::text_style::{style_prompt_text, PromptTone};
use crate::login::oauth::{
    persist_account_pool, resolve_account_selection, run_oauth_flow, sync_selection_to_codex,
    OAuthSignInMode,
};

/// TS `BackupRestoreMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupRestoreMode {
    Latest,
    Manual,
    Back,
}

/// Hotkey mapping for the sign-in mode menu (TS inline `onInput`).
pub(crate) fn map_sign_in_hotkey(raw: &str, has_backup: bool) -> Option<OAuthSignInMode> {
    match raw.to_lowercase().as_str() {
        "q" => Some(OAuthSignInMode::Cancel),
        "1" => Some(OAuthSignInMode::Browser),
        "2" => Some(OAuthSignInMode::Manual),
        "3" if has_backup => Some(OAuthSignInMode::RestoreBackup),
        _ => None,
    }
}

/// Hotkey mapping for the backup-restore mode menu.
pub(crate) fn map_backup_restore_hotkey(raw: &str) -> Option<BackupRestoreMode> {
    match raw.to_lowercase().as_str() {
        "q" => Some(BackupRestoreMode::Back),
        "1" => Some(BackupRestoreMode::Latest),
        "2" => Some(BackupRestoreMode::Manual),
        _ => None,
    }
}

/// Build the sign-in mode menu items (TS `promptOAuthSignInMode` items).
pub(crate) fn build_sign_in_menu_items(
    backup_option: Option<&NamedBackupSummary>,
) -> Vec<MenuItem<OAuthSignInMode>> {
    let mut items: Vec<MenuItem<OAuthSignInMode>> = vec![
        MenuItem::heading(ui_copy::oauth::SIGN_IN_HEADING, OAuthSignInMode::Cancel),
        MenuItem::new(ui_copy::oauth::OPEN_BROWSER, OAuthSignInMode::Browser)
            .with_color(MenuColor::Green),
        MenuItem::new(ui_copy::oauth::MANUAL_MODE, OAuthSignInMode::Manual)
            .with_color(MenuColor::Yellow),
    ];
    if let Some(backup) = backup_option {
        items.push(MenuItem::separator(OAuthSignInMode::Cancel));
        items.push(MenuItem::heading(
            ui_copy::oauth::RESTORE_HEADING,
            OAuthSignInMode::Cancel,
        ));
        items.push(
            MenuItem::new(
                ui_copy::oauth::RESTORE_SAVED_BACKUP,
                OAuthSignInMode::RestoreBackup,
            )
            .with_hint(ui_copy::oauth::load_last_backup_hint(
                &backup.file_name,
                backup.account_count as i64,
                &format_backup_saved_at(backup.mtime_ms),
            ))
            .with_color(MenuColor::Cyan),
        );
    }
    items.push(MenuItem::separator(OAuthSignInMode::Cancel));
    items.push(MenuItem::new(ui_copy::oauth::BACK, OAuthSignInMode::Cancel).with_color(MenuColor::Red));
    items
}

/// TS `promptOAuthSignInMode(backupOption, backupDiscoveryWarning)` —
/// non-TTY → browser; `null` selection → cancel.
pub fn prompt_oauth_sign_in_mode(
    backup_option: Option<&NamedBackupSummary>,
    backup_discovery_warning: Option<&str>,
) -> OAuthSignInMode {
    if !cma_tui::ansi::is_tty() {
        return OAuthSignInMode::Browser;
    }

    let ui = get_ui_runtime_options();
    let items = build_sign_in_menu_items(backup_option);
    let has_backup = backup_option.is_some();

    let mut options: SelectOptions<'_, OAuthSignInMode> =
        SelectOptions::new(ui_copy::oauth::CHOOSE_MODE_TITLE);
    options.subtitle = Some(match backup_discovery_warning {
        Some(warning) => format!("{} {warning}", ui_copy::oauth::CHOOSE_MODE_SUBTITLE),
        None => ui_copy::oauth::CHOOSE_MODE_SUBTITLE.to_string(),
    });
    options.help = Some(
        if has_backup {
            ui_copy::oauth::CHOOSE_MODE_HELP_WITH_BACKUP
        } else {
            ui_copy::oauth::CHOOSE_MODE_HELP
        }
        .to_string(),
    );
    options.clear_screen = true;
    options.theme = Some(ui.theme.clone());
    options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Minimal);
    options.allow_escape = Some(false);
    options.on_input = Some(Box::new(move |raw, _ctx| {
        match map_sign_in_hotkey(raw, has_backup) {
            Some(mode) => SelectInputResult::Finish(Some(mode)),
            None => SelectInputResult::Ignored,
        }
    }));

    select(&items, options)
        .ok()
        .flatten()
        .unwrap_or(OAuthSignInMode::Cancel)
}

/// TS `promptBackupRestoreMode(latestBackup)` — non-TTY → latest.
pub fn prompt_backup_restore_mode(latest_backup: &NamedBackupSummary) -> BackupRestoreMode {
    if !cma_tui::ansi::is_tty() {
        return BackupRestoreMode::Latest;
    }

    let ui = get_ui_runtime_options();
    let items: Vec<MenuItem<BackupRestoreMode>> = vec![
        MenuItem::new(ui_copy::oauth::LOAD_LAST_BACKUP, BackupRestoreMode::Latest)
            .with_hint(format!(
                "{}\n{}",
                ui_copy::oauth::RESTORE_BACKUP_LATEST_HINT,
                ui_copy::oauth::manual_backup_hint(
                    latest_backup.account_count as i64,
                    &format_backup_saved_at(latest_backup.mtime_ms),
                )
            ))
            .with_color(MenuColor::Cyan),
        MenuItem::new(
            ui_copy::oauth::CHOOSE_BACKUP_MANUALLY,
            BackupRestoreMode::Manual,
        )
        .with_color(MenuColor::Yellow),
        MenuItem::new(ui_copy::oauth::BACK, BackupRestoreMode::Back).with_color(MenuColor::Red),
    ];

    let mut options: SelectOptions<'_, BackupRestoreMode> =
        SelectOptions::new(ui_copy::oauth::RESTORE_BACKUP_TITLE);
    options.subtitle = Some(ui_copy::oauth::RESTORE_BACKUP_SUBTITLE.to_string());
    options.help = Some(ui_copy::oauth::RESTORE_BACKUP_HELP.to_string());
    options.clear_screen = true;
    options.theme = Some(ui.theme.clone());
    options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Minimal);
    options.allow_escape = Some(false);
    options.on_input = Some(Box::new(|raw, _ctx| match map_backup_restore_hotkey(raw) {
        Some(mode) => SelectInputResult::Finish(Some(mode)),
        None => SelectInputResult::Ignored,
    }));

    select(&items, options)
        .ok()
        .flatten()
        .unwrap_or(BackupRestoreMode::Back)
}

/// TS `promptManualBackupSelection(backups)` — non-TTY → first backup.
pub fn prompt_manual_backup_selection(
    backups: &[NamedBackupSummary],
) -> Option<NamedBackupSummary> {
    if !cma_tui::ansi::is_tty() {
        return backups.first().cloned();
    }

    let ui = get_ui_runtime_options();
    let mut items: Vec<MenuItem<Option<NamedBackupSummary>>> = backups
        .iter()
        .map(|backup| {
            MenuItem::new(backup.file_name.clone(), Some(backup.clone()))
                .with_hint(ui_copy::oauth::manual_backup_hint(
                    backup.account_count as i64,
                    &format_backup_saved_at(backup.mtime_ms),
                ))
                .with_color(MenuColor::Cyan)
        })
        .collect();
    items.push(MenuItem::new(ui_copy::oauth::BACK, None).with_color(MenuColor::Red));

    let mut options: SelectOptions<'_, Option<NamedBackupSummary>> =
        SelectOptions::new(ui_copy::oauth::MANUAL_BACKUP_TITLE);
    options.subtitle = Some(ui_copy::oauth::MANUAL_BACKUP_SUBTITLE.to_string());
    options.help = Some(ui_copy::oauth::MANUAL_BACKUP_HELP.to_string());
    options.clear_screen = true;
    options.theme = Some(ui.theme.clone());
    options.selected_emphasis = Some(cma_tui::select::SelectedEmphasis::Minimal);
    options.allow_escape = Some(false);
    options.on_input = Some(Box::new(|raw, _ctx| {
        if raw.to_lowercase() == "q" {
            // TS `return null` — finish the select with a null result.
            SelectInputResult::Finish(None)
        } else {
            SelectInputResult::Ignored
        }
    }));

    select(&items, options).ok().flatten().flatten()
}

/// TS `adjustManageActionSelectionIndex(currentIndex, removedIndex,
/// remainingCount)`.
pub(crate) fn adjust_manage_action_selection_index(
    current_index: Option<i64>,
    removed_index: i64,
    remaining_count: i64,
) -> i64 {
    if remaining_count <= 0 {
        return 0;
    }
    let Some(current_index) = current_index else {
        return 0;
    };
    if current_index < 0 {
        return 0;
    }
    if current_index < removed_index {
        return std::cmp::min(current_index, remaining_count - 1);
    }
    if current_index > removed_index {
        return current_index - 1;
    }
    std::cmp::min(removed_index, remaining_count - 1)
}

/// TS `resetManageActionSelection(storage, removedIndex)` — remap
/// `activeIndex` and every `activeIndexByFamily` entry after a row splice.
pub(crate) fn reset_manage_action_selection(storage: &mut AccountStorageV3, removed_index: i64) {
    let remaining_count = storage.accounts.len() as i64;
    if remaining_count <= 0 {
        storage.active_index = 0;
        let mut by_family = ActiveIndexByFamily::default();
        for family in MODEL_FAMILIES {
            by_family.set(family, Some(0));
        }
        storage.active_index_by_family = Some(by_family);
        return;
    }

    let previous_active_index = storage.active_index;
    let previous_by_family = storage.active_index_by_family.clone().unwrap_or_default();
    storage.active_index = adjust_manage_action_selection_index(
        Some(previous_active_index),
        removed_index,
        remaining_count,
    );
    let mut by_family = ActiveIndexByFamily::default();
    for family in MODEL_FAMILIES {
        let previous = previous_by_family
            .get(family)
            .unwrap_or(previous_active_index);
        by_family.set(
            family,
            Some(adjust_manage_action_selection_index(
                Some(previous),
                removed_index,
                remaining_count,
            )),
        );
    }
    storage.active_index_by_family = Some(by_family);
}

/// TS `replaceManageActionStorage(target, source)` — mirror the persisted
/// storage (including `pinnedAccountIndex`, #474) back into the caller's
/// in-memory view. The TS `{...source.activeIndexByFamily}` spread produces
/// an (empty) object even when the source map is undefined; port that
/// exactly.
pub(crate) fn replace_manage_action_storage(
    target: &mut AccountStorageV3,
    source: &AccountStorageV3,
) {
    target.version = source.version;
    target.accounts = source.accounts.clone();
    target.active_index = source.active_index;
    target.active_index_by_family =
        Some(source.active_index_by_family.clone().unwrap_or_default());
    target.pinned_account_index = source.pinned_account_index;
}

/// TS `resolveManageActionAccountIndex(storage, fallbackIndex, account)` —
/// identity match with unique-accountId fallback; when the account object is
/// present a failed match returns `None` (do NOT fall back to the raw index).
pub(crate) fn resolve_manage_action_account_index(
    storage: &AccountStorageV3,
    fallback_index: i64,
    account: Option<&AccountMetadataV3>,
) -> Option<usize> {
    if let Some(account) = account {
        return find_matching_account_index(
            &storage.accounts,
            &AccountSelectionCandidate {
                account_id: account.account_id.clone(),
                email: account.email.clone(),
                refresh_token: Some(account.refresh_token.clone()),
            },
            AccountMatchOptions {
                allow_unique_account_id_fallback_without_email: true,
            },
        );
    }
    if fallback_index >= 0 && (fallback_index as usize) < storage.accounts.len() {
        Some(fallback_index as usize)
    } else {
        None
    }
}

/// TS `matchesManageActionAccount(account, candidate)` — accountId equality
/// when either has one, else refreshToken AND sanitized-email equality.
pub(crate) fn matches_manage_action_account(
    account: Option<&AccountMetadataV3>,
    candidate: Option<&AccountMetadataV3>,
) -> bool {
    let (Some(account), Some(candidate)) = (account, candidate) else {
        return false;
    };
    if account.account_id.is_some() || candidate.account_id.is_some() {
        return account.account_id == candidate.account_id;
    }
    account.refresh_token == candidate.refresh_token
        && sanitize_email(account.email.as_deref()) == sanitize_email(candidate.email.as_deref())
}

/// TS `handleManageAction(storage, menuResult)`.
///
/// Mutates the caller's in-memory `storage` view to mirror what was persisted
/// (delete/toggle) and prints the user-facing confirmation lines. Storage
/// transaction failures propagate (the TS exceptions did too).
pub async fn handle_manage_action(
    storage: &mut AccountStorageV3,
    menu_result: &LoginMenuResult,
    out: &mut CliOut,
) -> Result<(), CodexError> {
    if let Some(index) = menu_result.switch_account_index {
        let _ = run_switch_command(&[(index + 1).to_string()], out).await;
        return Ok(());
    }

    if let Some(idx) = menu_result.delete_account_index {
        let selected_account = usize::try_from(idx)
            .ok()
            .and_then(|i| storage.accounts.get(i))
            .cloned();
        let mut deleted = false;
        if let Some(selected_account) = selected_account {
            let fallback = storage.clone();
            let persisted: Option<AccountStorageV3> =
                with_account_storage_transaction(move |loaded_storage, persist| async move {
                    let mut next_storage = loaded_storage.unwrap_or(fallback);
                    let Some(next_index) = resolve_manage_action_account_index(
                        &next_storage,
                        idx,
                        Some(&selected_account),
                    ) else {
                        return Ok(None);
                    };
                    if !matches_manage_action_account(
                        Some(&selected_account),
                        next_storage.accounts.get(next_index),
                    ) {
                        return Ok(None);
                    }
                    // Capture the pinned account BEFORE the splice so the
                    // manual pin can be followed by identity afterwards (#474).
                    let pinned_account = next_storage
                        .pinned_account_index
                        .and_then(|pin| usize::try_from(pin).ok())
                        .and_then(|pin| next_storage.accounts.get(pin))
                        .cloned();
                    next_storage.accounts.remove(next_index);
                    reset_manage_action_selection(&mut next_storage, next_index as i64);
                    next_storage.pinned_account_index = reconcile_pinned_account_index(
                        pinned_account.as_ref(),
                        &next_storage.accounts,
                    )
                    .map(|pin| pin as i64);
                    persist.persist(&next_storage).await?;
                    Ok(Some(next_storage))
                })
                .await?;
            if let Some(next_storage) = persisted {
                replace_manage_action_storage(storage, &next_storage);
                deleted = true;
            }
        }
        if deleted {
            out.info(format!("Deleted account {}.", idx + 1));
        }
        return Ok(());
    }

    if let Some(idx) = menu_result.toggle_account_index {
        let selected_account = usize::try_from(idx)
            .ok()
            .and_then(|i| storage.accounts.get(i))
            .cloned();
        let mut next_enabled_state: Option<bool> = None;
        if let Some(selected_account) = selected_account {
            let fallback = storage.clone();
            let persisted: Option<(AccountStorageV3, bool)> =
                with_account_storage_transaction(move |loaded_storage, persist| async move {
                    let mut next_storage = loaded_storage.unwrap_or(fallback);
                    let Some(next_index) = resolve_manage_action_account_index(
                        &next_storage,
                        idx,
                        Some(&selected_account),
                    ) else {
                        return Ok(None);
                    };
                    if !matches_manage_action_account(
                        Some(&selected_account),
                        next_storage.accounts.get(next_index),
                    ) {
                        return Ok(None);
                    }
                    let Some(next_account) = next_storage.accounts.get_mut(next_index) else {
                        return Ok(None);
                    };
                    // TS `nextAccount.enabled = nextAccount.enabled === false`
                    // — flip: disabled → true, everything else → false.
                    let flipped = next_account.enabled == Some(false);
                    next_account.enabled = Some(flipped);
                    let enabled_now = next_account.enabled != Some(false);
                    persist.persist(&next_storage).await?;
                    Ok(Some((next_storage, enabled_now)))
                })
                .await?;
            if let Some((next_storage, enabled_now)) = persisted {
                replace_manage_action_storage(storage, &next_storage);
                next_enabled_state = Some(enabled_now);
            }
        }
        if let Some(enabled) = next_enabled_state {
            out.info(format!(
                "{} account {}.",
                if enabled { "Enabled" } else { "Disabled" },
                idx + 1
            ));
        }
        return Ok(());
    }

    if let Some(idx) = menu_result.refresh_account_index {
        if usize::try_from(idx)
            .ok()
            .and_then(|i| storage.accounts.get(i))
            .is_none()
        {
            return Ok(());
        }

        let sign_in_mode = prompt_oauth_sign_in_mode(None, None);
        if sign_in_mode == OAuthSignInMode::Cancel {
            out.info(style_prompt_text(
                ui_copy::oauth::CANCELLED_BACK_TO_MENU,
                PromptTone::Muted,
            ));
            return Ok(());
        }
        if sign_in_mode != OAuthSignInMode::Browser && sign_in_mode != OAuthSignInMode::Manual {
            return Ok(());
        }

        let token_result = run_oauth_flow(true, sign_in_mode).await;
        let tokens = match token_result {
            cma_core::schemas::token::TokenResult::Success(tokens) => tokens,
            cma_core::schemas::token::TokenResult::Failed(failure) => {
                let detail = failure
                    .message
                    .clone()
                    .or_else(|| failure.reason.map(|reason| reason.as_str().to_string()))
                    .unwrap_or_else(|| "unknown error".to_string());
                out.error(format!("Refresh failed: {detail}"));
                return Ok(());
            }
        };

        let resolved = resolve_account_selection(&tokens, None);
        persist_account_pool(std::slice::from_ref(&resolved), false).await?;
        sync_selection_to_codex(&resolved).await;
        out.info(format!("Refreshed account {}.", idx + 1));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::model_family::ModelFamily;
    use cma_testkit::sandbox::EnvSandbox;
    use cma_tui::login_prompts::LoginMode;
    use serial_test::serial;

    use crate::dispatcher::CliOut;

    fn account(
        refresh_token: &str,
        account_id: Option<&str>,
        email: Option<&str>,
    ) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh_token.to_string(), 1, 1);
        account.account_id = account_id.map(str::to_string);
        account.email = email.map(str::to_string);
        account
    }

    fn storage_with(accounts: Vec<AccountMetadataV3>) -> AccountStorageV3 {
        let mut storage = AccountStorageV3::empty();
        storage.accounts = accounts;
        storage
    }

    // Port of the adjustManageActionSelectionIndex table from
    // test/login-menu-actions (delete-remap) assertions.
    #[test]
    fn adjust_index_remap_rules() {
        // Empty pool → 0.
        assert_eq!(adjust_manage_action_selection_index(Some(3), 1, 0), 0);
        // Missing / negative current → 0.
        assert_eq!(adjust_manage_action_selection_index(None, 1, 4), 0);
        assert_eq!(adjust_manage_action_selection_index(Some(-2), 1, 4), 0);
        // Below the removed index: value kept (clamped).
        assert_eq!(adjust_manage_action_selection_index(Some(0), 2, 3), 0);
        assert_eq!(adjust_manage_action_selection_index(Some(5), 6, 3), 2);
        // Above the removed index: shift down one.
        assert_eq!(adjust_manage_action_selection_index(Some(3), 1, 4), 2);
        // Equal to the removed index: clamp to min(removed, remaining-1).
        assert_eq!(adjust_manage_action_selection_index(Some(2), 2, 2), 1);
        assert_eq!(adjust_manage_action_selection_index(Some(0), 0, 2), 0);
    }

    #[test]
    fn reset_selection_empty_pool_zeroes_all_families() {
        let mut storage = storage_with(vec![]);
        storage.active_index = 3;
        reset_manage_action_selection(&mut storage, 0);
        assert_eq!(storage.active_index, 0);
        let by_family = storage.active_index_by_family.expect("family map");
        for family in MODEL_FAMILIES {
            assert_eq!(by_family.get(family), Some(0));
        }
    }

    #[test]
    fn reset_selection_remaps_families_with_active_fallback() {
        let mut storage = storage_with(vec![
            account("token-a", None, None),
            account("token-b", None, None),
            account("token-c", None, None),
        ]);
        storage.active_index = 2;
        let mut by_family = ActiveIndexByFamily::default();
        by_family.set(ModelFamily::Codex, Some(1));
        storage.active_index_by_family = Some(by_family);

        // Remove index 1 (accounts len is already post-splice 3 in this
        // synthetic setup; the remap only reads lengths).
        reset_manage_action_selection(&mut storage, 1);
        assert_eq!(storage.active_index, 1); // 2 > 1 → shift down.
        let by_family = storage.active_index_by_family.expect("family map");
        // codex had explicit 1 == removed → min(1, 2).
        assert_eq!(by_family.get(ModelFamily::Codex), Some(1));
        // Others fall back to previous activeIndex 2 → shifted to 1.
        assert_eq!(by_family.get(ModelFamily::Gpt5Codex), Some(1));
    }

    #[test]
    fn matches_account_identity_rules() {
        let with_id = account("rt-1", Some("acc_1"), Some("a@example.com"));
        let with_other_id = account("rt-1", Some("acc_2"), Some("a@example.com"));
        let without_id = account("rt-1", None, Some("a@example.com"));
        let email_case = account("rt-1", None, Some("A@Example.com "));
        let other_token = account("rt-2", None, Some("a@example.com"));

        // accountId equality wins when either side has one.
        assert!(matches_manage_action_account(
            Some(&with_id),
            Some(&with_id)
        ));
        assert!(!matches_manage_action_account(
            Some(&with_id),
            Some(&with_other_id)
        ));
        assert!(!matches_manage_action_account(
            Some(&with_id),
            Some(&without_id)
        ));
        // Without ids: refreshToken AND sanitized email.
        assert!(matches_manage_action_account(
            Some(&without_id),
            Some(&email_case)
        ));
        assert!(!matches_manage_action_account(
            Some(&without_id),
            Some(&other_token)
        ));
        assert!(!matches_manage_action_account(Some(&with_id), None));
        assert!(!matches_manage_action_account(None, None));
    }

    #[test]
    fn resolve_index_never_falls_back_to_raw_index_when_account_present() {
        let storage = storage_with(vec![account("rt-a", None, Some("a@example.com"))]);
        let missing = account("rt-zzz", None, Some("z@example.com"));
        // Identity match fails → None even though fallback 0 is in range.
        assert_eq!(
            resolve_manage_action_account_index(&storage, 0, Some(&missing)),
            None
        );
        // Without an account object the bounds-checked fallback applies.
        assert_eq!(resolve_manage_action_account_index(&storage, 0, None), Some(0));
        assert_eq!(resolve_manage_action_account_index(&storage, 5, None), None);
        assert_eq!(resolve_manage_action_account_index(&storage, -1, None), None);
    }

    #[test]
    fn replace_storage_mirrors_pin_and_materializes_family_map() {
        let mut target = storage_with(vec![account("rt-old", None, None)]);
        target.pinned_account_index = Some(7);

        let mut source = storage_with(vec![account("rt-new", None, None)]);
        source.active_index = 0;
        source.pinned_account_index = None;
        source.active_index_by_family = None;

        replace_manage_action_storage(&mut target, &source);
        assert_eq!(target.accounts.len(), 1);
        assert_eq!(target.accounts[0].refresh_token, "rt-new");
        // Pin cleared (mirrored from the persisted storage — #474).
        assert_eq!(target.pinned_account_index, None);
        // TS `{...undefined}` — an empty map object, not undefined.
        assert_eq!(
            target.active_index_by_family,
            Some(ActiveIndexByFamily::default())
        );
    }

    #[test]
    fn sign_in_hotkeys_gate_backup_on_availability() {
        assert_eq!(map_sign_in_hotkey("q", false), Some(OAuthSignInMode::Cancel));
        assert_eq!(map_sign_in_hotkey("Q", false), Some(OAuthSignInMode::Cancel));
        assert_eq!(
            map_sign_in_hotkey("1", false),
            Some(OAuthSignInMode::Browser)
        );
        assert_eq!(map_sign_in_hotkey("2", false), Some(OAuthSignInMode::Manual));
        assert_eq!(map_sign_in_hotkey("3", false), None);
        assert_eq!(
            map_sign_in_hotkey("3", true),
            Some(OAuthSignInMode::RestoreBackup)
        );
        assert_eq!(map_sign_in_hotkey("x", true), None);

        assert_eq!(
            map_backup_restore_hotkey("q"),
            Some(BackupRestoreMode::Back)
        );
        assert_eq!(
            map_backup_restore_hotkey("1"),
            Some(BackupRestoreMode::Latest)
        );
        assert_eq!(
            map_backup_restore_hotkey("2"),
            Some(BackupRestoreMode::Manual)
        );
        assert_eq!(map_backup_restore_hotkey("9"), None);
    }

    async fn seed_disk(storage: &AccountStorageV3) {
        cma_storage::facade::set_storage_path(None);
        cma_storage::save::save_accounts(storage)
            .await
            .expect("seed accounts");
    }

    async fn disk_storage() -> AccountStorageV3 {
        cma_storage::load::load_accounts()
            .await
            .expect("storage on disk")
            .storage
    }

    // Port of test/login-menu-actions.test.ts "deletes inside the transaction
    // and rebalances every selection index".
    #[tokio::test]
    #[serial(env)]
    async fn delete_rebalances_every_selection_index() {
        let _sandbox = EnvSandbox::new();
        let mut storage = storage_with(vec![
            account("rt-a", None, Some("a@example.com")),
            account("rt-b", None, Some("b@example.com")),
            account("rt-c", None, Some("c@example.com")),
        ]);
        storage.active_index = 2;
        seed_disk(&storage).await;

        let menu_result = LoginMenuResult {
            mode: LoginMode::Manage,
            delete_account_index: Some(1),
            ..Default::default()
        };
        let mut out = CliOut::capture();
        handle_manage_action(&mut storage, &menu_result, &mut out)
            .await
            .expect("delete succeeds");

        assert_eq!(out.info_text(), "Deleted account 2.");
        // The caller's in-memory view mirrors the persisted storage.
        assert_eq!(storage.accounts.len(), 2);
        assert_eq!(storage.accounts[0].refresh_token, "rt-a");
        assert_eq!(storage.accounts[1].refresh_token, "rt-c");
        assert_eq!(storage.active_index, 1); // 2 > removed 1 → shifted down.
        let by_family = storage.active_index_by_family.clone().expect("family map");
        for family in MODEL_FAMILIES {
            assert_eq!(by_family.get(family), Some(1));
        }
        // And the disk agrees.
        let persisted = disk_storage().await;
        assert_eq!(persisted.accounts.len(), 2);
        assert_eq!(persisted.active_index, 1);
    }

    // Port of "shifts the manual pin to follow its account when a
    // lower-indexed account is deleted" (#474).
    #[tokio::test]
    #[serial(env)]
    async fn delete_shifts_manual_pin_by_identity() {
        let _sandbox = EnvSandbox::new();
        let mut storage = storage_with(vec![
            account("rt-a", Some("acc_a"), Some("a@example.com")),
            account("rt-b", Some("acc_b"), Some("b@example.com")),
            account("rt-c", Some("acc_c"), Some("c@example.com")),
        ]);
        storage.pinned_account_index = Some(2);
        seed_disk(&storage).await;

        let menu_result = LoginMenuResult {
            mode: LoginMode::Manage,
            delete_account_index: Some(0),
            ..Default::default()
        };
        let mut out = CliOut::capture();
        handle_manage_action(&mut storage, &menu_result, &mut out)
            .await
            .expect("delete succeeds");

        assert_eq!(out.info_text(), "Deleted account 1.");
        // The pinned account (acc_c) moved from slot 2 to slot 1.
        assert_eq!(storage.pinned_account_index, Some(1));
        assert_eq!(disk_storage().await.pinned_account_index, Some(1));
    }

    // Port of "clears the manual pin when the pinned account itself is
    // deleted".
    #[tokio::test]
    #[serial(env)]
    async fn delete_clears_pin_when_pinned_account_removed() {
        let _sandbox = EnvSandbox::new();
        let mut storage = storage_with(vec![
            account("rt-a", Some("acc_a"), Some("a@example.com")),
            account("rt-b", Some("acc_b"), Some("b@example.com")),
        ]);
        storage.pinned_account_index = Some(1);
        seed_disk(&storage).await;

        let menu_result = LoginMenuResult {
            mode: LoginMode::Manage,
            delete_account_index: Some(1),
            ..Default::default()
        };
        let mut out = CliOut::capture();
        handle_manage_action(&mut storage, &menu_result, &mut out)
            .await
            .expect("delete succeeds");

        assert_eq!(out.info_text(), "Deleted account 2.");
        assert_eq!(storage.pinned_account_index, None);
        assert_eq!(disk_storage().await.pinned_account_index, None);
    }

    // Port of "becomes a no-op when the account vanished from storage":
    // the in-memory row no longer exists on disk, so nothing is deleted and
    // nothing is printed.
    #[tokio::test]
    #[serial(env)]
    async fn delete_is_noop_when_account_vanished_from_disk() {
        let _sandbox = EnvSandbox::new();
        let on_disk = storage_with(vec![account("rt-a", None, Some("a@example.com"))]);
        seed_disk(&on_disk).await;

        // The caller's stale in-memory view still shows a second row.
        let mut storage = storage_with(vec![
            account("rt-a", None, Some("a@example.com")),
            account("rt-gone", None, Some("gone@example.com")),
        ]);
        let menu_result = LoginMenuResult {
            mode: LoginMode::Manage,
            delete_account_index: Some(1),
            ..Default::default()
        };
        let mut out = CliOut::capture();
        handle_manage_action(&mut storage, &menu_result, &mut out)
            .await
            .expect("no-op succeeds");

        assert_eq!(out.info_text(), "");
        assert_eq!(storage.accounts.len(), 2); // untouched in-memory view
        assert_eq!(disk_storage().await.accounts.len(), 1);
    }

    // Port of "disables an enabled account and reports the new state" +
    // "re-enables a disabled account".
    #[tokio::test]
    #[serial(env)]
    async fn toggle_flips_enabled_and_reports_state() {
        let _sandbox = EnvSandbox::new();
        let mut storage = storage_with(vec![account("rt-a", None, Some("a@example.com"))]);
        seed_disk(&storage).await;

        let menu_result = LoginMenuResult {
            mode: LoginMode::Manage,
            toggle_account_index: Some(0),
            ..Default::default()
        };
        let mut out = CliOut::capture();
        handle_manage_action(&mut storage, &menu_result, &mut out)
            .await
            .expect("toggle succeeds");
        assert_eq!(out.info_text(), "Disabled account 1.");
        assert_eq!(storage.accounts[0].enabled, Some(false));

        let mut out = CliOut::capture();
        handle_manage_action(&mut storage, &menu_result, &mut out)
            .await
            .expect("toggle succeeds");
        assert_eq!(out.info_text(), "Enabled account 1.");
        assert_eq!(storage.accounts[0].enabled, Some(true));
    }

    // Port of "ignores a refresh request for an index that no longer exists"
    // — returns before any OAuth prompt fires.
    #[tokio::test]
    #[serial(env)]
    async fn refresh_request_for_missing_index_is_ignored() {
        let _sandbox = EnvSandbox::new();
        let mut storage = storage_with(vec![account("rt-a", None, Some("a@example.com"))]);
        let menu_result = LoginMenuResult {
            mode: LoginMode::Manage,
            refresh_account_index: Some(5),
            ..Default::default()
        };
        let mut out = CliOut::capture();
        handle_manage_action(&mut storage, &menu_result, &mut out)
            .await
            .expect("ignored");
        assert!(out.lines().is_empty());
    }

    #[test]
    fn sign_in_menu_items_layout_matches_ts() {
        let no_backup = build_sign_in_menu_items(None);
        // heading, browser, manual, separator, back.
        assert_eq!(no_backup.len(), 5);
        assert!(no_backup[0].heading);
        assert_eq!(no_backup[1].label, "Open Browser (Easy)");
        assert_eq!(no_backup[2].label, "Manual / Incognito");
        assert!(no_backup[3].separator);
        assert_eq!(no_backup[4].label, "Back");

        let backup = NamedBackupSummary {
            path: "p".to_string(),
            file_name: "team.json".to_string(),
            account_count: 3,
            mtime_ms: 0.0,
        };
        let with_backup = build_sign_in_menu_items(Some(&backup));
        // + separator, restore heading, restore item.
        assert_eq!(with_backup.len(), 8);
        assert!(with_backup[3].separator);
        assert!(with_backup[4].heading);
        assert_eq!(with_backup[5].label, "Restore Saved Backup");
        assert!(with_backup[5].hint.as_deref().unwrap_or("").contains("team.json"));
    }
}
