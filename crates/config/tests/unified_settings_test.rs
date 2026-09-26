//! Integration tests for `cma_config::unified_settings` — ported from
//! `test/unified-settings.test.ts` (highest-value assertions) plus the
//! settings.json golden byte test (ARCHITECTURE.md §9.1).

use std::fs;

use serde_json::{Map, Value, json};
use serial_test::serial;

use cma_config::dashboard_settings::{DashboardDisplaySettings, to_json_record};
use cma_config::unified_settings::{
    get_unified_settings_backup_path, get_unified_settings_path, load_unified_dashboard_settings,
    load_unified_plugin_config_sync, save_unified_dashboard_settings, save_unified_plugin_config,
    save_unified_plugin_config_sync,
};
use cma_core::schemas::plugin_config::PluginConfig;
use cma_testkit::sandbox::EnvSandbox;

fn default_plugin_config_record() -> Map<String, Value> {
    match serde_json::to_value(PluginConfig::default_resolved()) {
        Ok(Value::Object(map)) => map,
        _ => panic!("defaults serialize to an object"),
    }
}

#[tokio::test]
#[serial(env)]
async fn merges_plugin_and_dashboard_sections_into_one_file_byte_identical_to_golden() {
    let _sandbox = EnvSandbox::new();
    save_unified_plugin_config(&default_plugin_config_record())
        .await
        .expect("plugin save");
    save_unified_dashboard_settings(&to_json_record(&DashboardDisplaySettings::default()))
        .await
        .expect("dashboard save");

    let written = fs::read_to_string(get_unified_settings_path()).expect("settings written");
    // Byte-compare against the TS-produced fixture: 2-space indent, key
    // order (pluginConfig → version → dashboardDisplaySettings), trailing \n.
    cma_testkit::goldens::assert_golden_str("settings.json", &written);
}

#[tokio::test]
#[serial(env)]
async fn preserves_unrelated_top_level_sections_during_partial_section_writes() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        "{\n  \"customSection\": {\n    \"keep\": true\n  },\n  \"version\": 1\n}\n",
    )
    .unwrap();

    let plugin: Map<String, Value> =
        serde_json::from_value(json!({ "codexMode": false })).unwrap();
    save_unified_plugin_config(&plugin).await.unwrap();
    let dashboard: Map<String, Value> =
        serde_json::from_value(json!({ "uiThemePreset": "blue" })).unwrap();
    save_unified_dashboard_settings(&dashboard).await.unwrap();

    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert_eq!(record["customSection"]["keep"], json!(true));
    assert_eq!(record["pluginConfig"]["codexMode"], json!(false));
    assert_eq!(record["dashboardDisplaySettings"]["uiThemePreset"], json!("blue"));
    assert_eq!(record["version"], json!(1));
    // Existing `version` key kept its ORIGINAL position (before the newly
    // appended sections).
    let keys: Vec<&str> = record.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        vec!["customSection", "version", "pluginConfig", "dashboardDisplaySettings"]
    );
}

#[tokio::test]
#[serial(env)]
async fn returns_null_sections_for_invalid_json_without_usable_backup() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(get_unified_settings_path(), "{ not json").unwrap();

    assert_eq!(load_unified_plugin_config_sync(), None);
    assert_eq!(load_unified_dashboard_settings().await, None);
}

#[tokio::test]
#[serial(env)]
async fn returns_null_sections_when_settings_root_is_not_an_object() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(get_unified_settings_path(), "[1, 2, 3]\n").unwrap();
    assert_eq!(load_unified_plugin_config_sync(), None);
    assert_eq!(load_unified_dashboard_settings().await, None);
}

#[tokio::test]
#[serial(env)]
async fn recovers_sections_from_backup_when_primary_is_invalid() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(get_unified_settings_path(), "corrupted{{{").unwrap();
    fs::write(
        get_unified_settings_backup_path(),
        r#"{"pluginConfig":{"codexMode":false},"dashboardDisplaySettings":{"uiThemePreset":"blue"},"version":1}"#,
    )
    .unwrap();

    let plugin = load_unified_plugin_config_sync().expect("recovered from backup");
    assert_eq!(plugin.get("codexMode"), Some(&json!(false)));
    let dashboard = load_unified_dashboard_settings().await.expect("recovered");
    assert_eq!(dashboard.get("uiThemePreset"), Some(&json!("blue")));
}

#[tokio::test]
#[serial(env)]
async fn does_not_load_backup_when_the_primary_file_is_missing() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_backup_path(),
        r#"{"pluginConfig":{"codexMode":false},"version":1}"#,
    )
    .unwrap();
    // Missing primaries stay missing — stale backup state must not resurrect.
    assert_eq!(load_unified_plugin_config_sync(), None);
}

#[tokio::test]
#[serial(env)]
async fn preserves_the_last_good_backup_when_writing_after_a_backup_derived_read() {
    // Gotcha 10: a save whose state came from .bak SKIPS the snapshot so the
    // corrupt primary cannot clobber the only good backup.
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let good_backup = r#"{"pluginConfig":{"codexMode":false},"version":1}"#;
    fs::write(get_unified_settings_path(), "corrupted{{{").unwrap();
    fs::write(get_unified_settings_backup_path(), good_backup).unwrap();

    let patch: Map<String, Value> =
        serde_json::from_value(json!({ "fastSession": true })).unwrap();
    save_unified_plugin_config(&patch).await.unwrap();

    // The backup still holds the good pre-save content (snapshot skipped)…
    assert_eq!(
        fs::read_to_string(get_unified_settings_backup_path()).unwrap(),
        good_backup
    );
    // …and the primary was rebuilt from the backup-derived record + patch.
    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert_eq!(record["pluginConfig"]["fastSession"], json!(true));

    // A later save (healthy primary) resumes snapshotting.
    let patch2: Map<String, Value> =
        serde_json::from_value(json!({ "fastSession": false })).unwrap();
    save_unified_plugin_config(&patch2).await.unwrap();
    let backup_after: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_backup_path()).unwrap())
            .unwrap();
    assert_eq!(
        backup_after["pluginConfig"]["fastSession"],
        json!(true),
        "second save snapshots the (now healthy) primary before writing"
    );
}

#[tokio::test]
#[serial(env)]
async fn supports_sync_plugin_config_save_and_load() {
    let _sandbox = EnvSandbox::new();
    let plugin: Map<String, Value> =
        serde_json::from_value(json!({ "codexMode": true, "toastDurationMs": 6000 })).unwrap();
    save_unified_plugin_config_sync(&plugin).unwrap();
    let loaded = load_unified_plugin_config_sync().expect("section present");
    assert_eq!(loaded.get("codexMode"), Some(&json!(true)));
    assert_eq!(loaded.get("toastDurationMs"), Some(&json!(6000)));
    // Sync writer also appends the trailing newline + version.
    let raw = fs::read_to_string(get_unified_settings_path()).unwrap();
    assert!(raw.ends_with("\n"));
    let record: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(record["version"], json!(1));
}

#[tokio::test]
#[serial(env)]
async fn returns_null_for_missing_plugin_config_section() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(get_unified_settings_path(), r#"{"version":1}"#).unwrap();
    assert_eq!(load_unified_plugin_config_sync(), None);
}

#[tokio::test]
#[serial(env)]
async fn serializes_concurrent_section_writes_and_keeps_both_sections() {
    let _sandbox = EnvSandbox::new();
    let plugin: Map<String, Value> =
        serde_json::from_value(json!({ "codexMode": false })).unwrap();
    let dashboard: Map<String, Value> =
        serde_json::from_value(json!({ "uiAccentColor": "cyan" })).unwrap();
    let (a, b) = tokio::join!(
        save_unified_plugin_config(&plugin),
        save_unified_dashboard_settings(&dashboard)
    );
    a.unwrap();
    b.unwrap();
    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert_eq!(record["pluginConfig"]["codexMode"], json!(false));
    assert_eq!(record["dashboardDisplaySettings"]["uiAccentColor"], json!("cyan"));
}

#[tokio::test]
#[serial(env)]
async fn no_temp_files_left_behind_after_saves() {
    let sandbox = EnvSandbox::new();
    let plugin: Map<String, Value> = serde_json::from_value(json!({ "codexMode": true })).unwrap();
    save_unified_plugin_config(&plugin).await.unwrap();
    save_unified_plugin_config_sync(&plugin).unwrap();
    let leftovers: Vec<String> = fs::read_dir(sandbox.codex_multi_auth_dir())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "stray temp files: {leftovers:?}");
}
