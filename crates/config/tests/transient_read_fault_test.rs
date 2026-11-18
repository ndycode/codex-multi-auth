//! Windows-only fault-injection coverage for the transient-read contracts
//! that the TS suite exercised with `fs` mocks (`unified-settings.test.ts`
//! "rethrows transient primary read errors", `dashboard-settings.test.ts`
//! "retries transient EBUSY reads").
//!
//! Instead of mocking, these tests hold a real exclusive Windows file handle
//! (`share_mode(0)`), which makes concurrent `fs::read` calls fail with
//! `ERROR_SHARING_VIOLATION` — mapped to `"EBUSY"` by
//! `cma_core::fs_retry::code_of` (ARCHITECTURE §8.2). No such no-mock seam
//! exists on unix, so the file is windows-gated.
#![cfg(windows)]

use std::fs;
use std::os::windows::fs::OpenOptionsExt;

use serde_json::{Map, Value, json};
use serial_test::serial;

use cma_config::dashboard_settings::{DashboardThemePreset, load_dashboard_display_settings};
use cma_config::unified_settings::{get_unified_settings_path, save_unified_plugin_config};
use cma_core::fs_retry::code_of;
use cma_testkit::sandbox::EnvSandbox;

/// Opens `path` with no sharing: every other open (and thus `fs::read`) hits
/// `ERROR_SHARING_VIOLATION` until the returned handle is dropped.
fn hold_exclusive(path: &std::path::Path) -> fs::File {
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
        .expect("exclusive open")
}

#[tokio::test]
#[serial(env)]
async fn unified_save_rethrows_transient_primary_read_errors_without_backup_fallback() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let primary = get_unified_settings_path();
    let original = "{\n  \"customSection\": {\n    \"keep\": true\n  },\n  \"version\": 1\n}\n";
    fs::write(&primary, original).unwrap();
    // A healthy backup MUST NOT be consulted for a transient primary error —
    // that would let a writer rebuild over a merely-busy primary.
    fs::write(
        sandbox.codex_multi_auth_dir().join("settings.json.bak"),
        "{\n  \"version\": 1\n}\n",
    )
    .unwrap();

    let guard = hold_exclusive(&primary);
    let plugin: Map<String, Value> = serde_json::from_value(json!({ "codexMode": false })).unwrap();
    let error = save_unified_plugin_config(&plugin)
        .await
        .expect_err("EBUSY primary read must rethrow, not fall back");
    assert_eq!(code_of(&error), Some("EBUSY"));
    drop(guard);

    // The busy primary was left untouched (no rebuild from backup or `{}`).
    assert_eq!(fs::read_to_string(&primary).unwrap(), original);
}

#[tokio::test]
#[serial(env)]
async fn dashboard_legacy_load_retries_transient_ebusy_reads_until_the_lock_clears() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    // No unified settings.json → the legacy ladder runs.
    let legacy_path = sandbox
        .codex_multi_auth_dir()
        .join("dashboard-settings.json");
    fs::write(
        &legacy_path,
        "{\n  \"settings\": {\n    \"uiThemePreset\": \"blue\"\n  }\n}\n",
    )
    .unwrap();

    // First read attempt(s) hit EBUSY; the holder releases mid-way through
    // the 20/40/80 ms retry schedule, so a later attempt succeeds.
    let guard = hold_exclusive(&legacy_path);
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(30));
        drop(guard);
    });

    let settings = load_dashboard_display_settings().await;
    release.join().unwrap();
    assert_eq!(
        settings.ui_theme_preset,
        DashboardThemePreset::Blue,
        "legacy settings must load once the transient EBUSY clears (not defaults)"
    );
}
