//! Port of `lib/codex-manager/settings-persist-utils.ts` +
//! `unified-settings-controller.ts` (+ the persistence halves of
//! `settings-hub/shared.ts`) — reload-merge of per-panel key sets ONLY,
//! under the per-path write queue, plus the unified settings controller.

use cma_config::dashboard_settings::{
    get_dashboard_settings_path, load_dashboard_display_settings, save_dashboard_display_settings,
    DashboardDisplaySettings,
};
use cma_core::schemas::plugin_config::PluginConfig;

use crate::settings::backend::{
    backend_settings_equal, build_backend_config_patch, clone_backend_plugin_config,
    configure_backend_settings,
};
use crate::settings::dashboard::{
    configure_dashboard_display_settings, configure_statusline_settings, prompt_behavior_settings,
    prompt_theme_settings, BEHAVIOR_PANEL_KEYS, THEME_PANEL_KEYS,
};
use crate::settings::experimental::prompt_experimental_settings;
use crate::settings::hub::{
    apply_ui_theme_from_dashboard_settings, clone_dashboard_settings, dashboard_settings_equal,
    merge_dashboard_settings_for_keys, prompt_settings_hub, DashboardSettingKey, SettingsHubAction,
};
use crate::settings::write_queue::{with_queued_retry, SettingsWriteError};

/// `resolvePluginConfigSavePathKey()` — `CODEX_MULTI_AUTH_CONFIG_PATH` env
/// (trimmed) when non-empty, else the unified settings path. Used only as
/// the write-queue key.
pub fn resolve_plugin_config_save_path_key() -> String {
    let env_path = std::env::var("CODEX_MULTI_AUTH_CONFIG_PATH")
        .unwrap_or_default()
        .trim()
        .to_string();
    if !env_path.is_empty() {
        return env_path;
    }
    cma_config::unified_settings::get_unified_settings_path()
        .to_string_lossy()
        .to_string()
}

/// `formatPersistError(error)`.
pub fn format_persist_error(error: &dyn std::fmt::Display) -> String {
    error.to_string()
}

/// `warnPersistFailure(scope, error)` — frozen console.warn text.
pub fn warn_persist_failure(scope: &str, error: &dyn std::fmt::Display) {
    eprintln!(
        "Settings save failed ({scope}) after retries: {}",
        format_persist_error(error)
    );
}

/// `readFileWithRetry(path, {retryableCodes, maxAttempts, sleep})` — utf-8
/// read; **ENOENT always rethrown immediately**; other listed codes retried
/// with `25 * 2^attempt` ms; non-retryable rethrown.
pub async fn read_file_with_retry<Sleep, SleepFut>(
    path: &std::path::Path,
    retryable_codes: &[&str],
    max_attempts: u32,
    sleep: Sleep,
) -> std::io::Result<String>
where
    Sleep: Fn(i64) -> SleepFut,
    SleepFut: std::future::Future<Output = ()>,
{
    let mut attempt: u32 = 0;
    loop {
        match std::fs::read_to_string(path) {
            Ok(content) => return Ok(content),
            Err(error) => {
                let code = cma_core::fs_retry::code_of(&error);
                if code == Some("ENOENT") {
                    return Err(error);
                }
                let retryable = code.is_some_and(|code| retryable_codes.contains(&code));
                if !retryable || attempt >= max_attempts.saturating_sub(1) {
                    return Err(error);
                }
                sleep(25_i64.saturating_mul(1 << attempt.min(30))).await;
                attempt += 1;
            }
        }
    }
}

/// `persistDashboardSettingsSelection(selected, keys, scope)` — reload-latest
/// + merge ONLY this panel's keys under the per-path queue. A failed save
///   warns and returns the draft clone so the UI keeps the user's choices.
pub async fn persist_dashboard_settings_selection(
    selected: &DashboardDisplaySettings,
    keys: &[DashboardSettingKey],
    scope: &str,
) -> DashboardDisplaySettings {
    let fallback = clone_dashboard_settings(selected);
    let path_key = get_dashboard_settings_path().to_string_lossy().to_string();
    let result: Result<DashboardDisplaySettings, SettingsWriteError> = with_queued_retry(
        &path_key,
        || async {
            let latest = clone_dashboard_settings(&load_dashboard_display_settings().await);
            let merged = merge_dashboard_settings_for_keys(&latest, selected, keys);
            save_dashboard_display_settings(&merged)
                .await
                .map_err(|error| SettingsWriteError::from_io(&error))?;
            Ok(merged)
        },
        crate::settings::write_queue::default_sleep,
    )
    .await;
    match result {
        Ok(merged) => merged,
        Err(error) => {
            warn_persist_failure(scope, &error);
            fallback
        }
    }
}

/// `persistBackendConfigSelection(selected, scope)` — writes ONLY the
/// whitelisted, clamped schema keys via `savePluginConfig`; always returns a
/// clone of the selection; errors only warn.
pub async fn persist_backend_config_selection(
    selected: &PluginConfig,
    scope: &str,
) -> PluginConfig {
    let fallback = clone_backend_plugin_config(selected);
    let path_key = resolve_plugin_config_save_path_key();
    let result: Result<(), SettingsWriteError> = with_queued_retry(
        &path_key,
        || async {
            let patch = build_backend_config_patch(selected);
            cma_config::save::save_plugin_config(&patch)
                .await
                .map_err(|error| {
                    use cma_core::fs_retry::HasErrorCode;
                    SettingsWriteError {
                        message: error.to_string(),
                        code: error.error_code().map(str::to_string),
                        status: None,
                        retry_after_ms: None,
                    }
                })?;
            Ok(())
        },
        crate::settings::write_queue::default_sleep,
    )
    .await;
    if let Err(error) = result {
        warn_persist_failure(scope, &error);
    }
    fallback
}

/// `configureUnifiedSettingsController` / `configureUnifiedSettings` — the
/// settings-hub main loop. Re-entering the hub restores the cursor to the
/// last chosen action.
pub async fn configure_unified_settings(
    initial_settings: Option<&DashboardDisplaySettings>,
) -> DashboardDisplaySettings {
    let mut current = clone_dashboard_settings(&match initial_settings {
        Some(settings) => settings.clone(),
        None => load_dashboard_display_settings().await,
    });
    let mut backend_config = clone_backend_plugin_config(&cma_config::load::load_plugin_config());
    apply_ui_theme_from_dashboard_settings(&current);
    let mut hub_focus = SettingsHubAction::AccountList;

    loop {
        let action = prompt_settings_hub(hub_focus);
        let Some(action) = action else {
            return current;
        };
        if action == SettingsHubAction::Back {
            return current;
        }
        hub_focus = action;

        match action {
            SettingsHubAction::AccountList => {
                current = configure_dashboard_display_settings(Some(&current)).await;
            }
            SettingsHubAction::SummaryFields => {
                current = configure_statusline_settings(Some(&current)).await;
            }
            SettingsHubAction::Behavior => {
                let selected = prompt_behavior_settings(&current);
                if let Some(selected) = selected
                    && !dashboard_settings_equal(&current, &selected) {
                        current = persist_dashboard_settings_selection(
                            &selected,
                            &BEHAVIOR_PANEL_KEYS,
                            "behavior",
                        )
                        .await;
                    }
            }
            SettingsHubAction::Theme => {
                let selected = prompt_theme_settings(&current);
                if let Some(selected) = selected
                    && !dashboard_settings_equal(&current, &selected) {
                        current = persist_dashboard_settings_selection(
                            &selected,
                            &THEME_PANEL_KEYS,
                            "theme",
                        )
                        .await;
                        apply_ui_theme_from_dashboard_settings(&current);
                    }
            }
            SettingsHubAction::Experimental => {
                let selected = prompt_experimental_settings(&backend_config).await;
                if let Some(selected) = selected {
                    if !backend_settings_equal(&backend_config, &selected) {
                        backend_config =
                            persist_backend_config_selection(&selected, "experimental").await;
                    } else {
                        // Unchanged-but-returned: adopt the draft without
                        // writing.
                        backend_config = selected;
                    }
                }
            }
            SettingsHubAction::Backend => {
                backend_config = configure_backend_settings(Some(&backend_config)).await;
            }
            SettingsHubAction::Back => unreachable!("handled above"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial(env)]
    fn plugin_config_save_path_key_prefers_the_env_override() {
        let mut sandbox = cma_testkit::sandbox::EnvSandbox::new();
        sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", "  C:/tmp/custom.json  ");
        assert_eq!(resolve_plugin_config_save_path_key(), "C:/tmp/custom.json");
        sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", "   ");
        let fallback = resolve_plugin_config_save_path_key();
        assert!(fallback.ends_with("settings.json"), "fallback: {fallback}");
    }

    #[tokio::test]
    async fn read_file_with_retry_rethrows_enoent_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.json");
        let sleeps = std::cell::Cell::new(0_u32);
        let result = read_file_with_retry(&missing, &["EBUSY", "EPERM", "EAGAIN"], 4, |_ms| {
            sleeps.set(sleeps.get() + 1);
            std::future::ready(())
        })
        .await;
        assert!(result.is_err());
        assert_eq!(sleeps.get(), 0);
    }

    #[tokio::test]
    async fn read_file_with_retry_reads_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(&path, "{\"ok\":true}").unwrap();
        let content = read_file_with_retry(&path, &["EBUSY"], 4, |_ms| std::future::ready(()))
            .await
            .unwrap();
        assert_eq!(content, "{\"ok\":true}");
    }
}
