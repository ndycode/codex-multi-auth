//! Integration tests for `cma_config::save` — ported from the
//! "plugin config save paths" suite of `test/config-save.test.ts`.

use std::fs;

use serde_json::{Map, Value, json};
use serial_test::serial;

use cma_config::load::__reset_config_warning_cache_for_tests;
use cma_config::save::{ConfigSaveError, save_plugin_config, save_plugin_config_typed};
use cma_config::unified_settings::get_unified_settings_path;
use cma_core::schemas::plugin_config::PluginConfig;
use cma_testkit::sandbox::EnvSandbox;

fn patch(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("patch must be an object"),
    }
}

#[tokio::test]
#[serial(env)]
async fn merges_and_sanitizes_env_path_saves_preserving_unknown_keys() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("env-config.json");
    fs::write(
        &env_file,
        r#"{"futureKey": {"keep": true}, "codexMode": true, "toastDurationMs": 5}"#,
    )
    .unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);

    save_plugin_config(&patch(json!({
        "fastSession": true,
        "codexTuiColorProfile": "nope",  // invalid → dropped with warn-once
    })))
    .await
    .expect("env-path save succeeds");

    let raw = fs::read_to_string(&env_file).unwrap();
    assert!(raw.ends_with("\n"), "trailing newline");
    let record: Value = serde_json::from_str(&raw).unwrap();
    // Unknown key preserved (gotcha 5); invalid stored value dropped; patch
    // applied; invalid patch field dropped.
    assert_eq!(record["futureKey"]["keep"], json!(true));
    assert_eq!(record["codexMode"], json!(true));
    assert!(record.get("toastDurationMs").is_none());
    assert_eq!(record["fastSession"], json!(true));
    assert!(record.get("codexTuiColorProfile").is_none());
    // 2-space pretty formatting.
    assert!(raw.contains("\n  \"codexMode\": true"));
}

#[tokio::test]
#[serial(env)]
async fn env_path_save_creates_the_file_when_missing() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("fresh").join("env-config.json");
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    save_plugin_config(&patch(json!({ "codexMode": false })))
        .await
        .expect("save creates parent dirs + file");
    let record: Value = serde_json::from_str(&fs::read_to_string(&env_file).unwrap()).unwrap();
    assert_eq!(record, json!({ "codexMode": false }));
    // The lockfile was cleaned up.
    assert!(!env_file.with_extension("json.lock").exists());
}

#[tokio::test]
#[serial(env)]
async fn recovers_from_malformed_env_path_json_before_saving() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("malformed.json");
    fs::write(&env_file, "{ broken json !!").unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    // Invalid (not unreadable) → rebuild from the patch (gotcha 12).
    save_plugin_config(&patch(json!({ "fastSession": true })))
        .await
        .expect("invalid existing file rebuilds");
    let record: Value = serde_json::from_str(&fs::read_to_string(&env_file).unwrap()).unwrap();
    assert_eq!(record, json!({ "fastSession": true }));
}

#[tokio::test]
#[serial(env)]
async fn aborts_with_storage_error_when_the_env_path_is_unreadable() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // A DIRECTORY at the config path: exists, but reading it fails with an
    // errno-coded error (EISDIR on unix, EPERM/EBUSY-family on Windows) →
    // classified "unreadable" → typed StorageError abort.
    let env_dir = sandbox.root().join("config-is-a-dir.json");
    fs::create_dir_all(&env_dir).unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_dir);

    let error = save_plugin_config(&patch(json!({ "codexMode": false })))
        .await
        .expect_err("unreadable existing config aborts the save");
    let storage = match &error {
        ConfigSaveError::Storage(storage) => storage,
        other => panic!("expected StorageError, got {other:?}"),
    };
    assert_eq!(storage.code(), "UNREADABLE");
    assert!(storage.message().starts_with("Aborting config save because "));
    assert!(storage.message().ends_with(" is unreadable."));
    assert_eq!(
        storage.hint(),
        Some("Fix or remove the unreadable config file, then retry the save.")
    );
}

#[tokio::test]
#[serial(env)]
async fn writes_through_unified_settings_when_env_path_is_unset() {
    let _sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    save_plugin_config(&patch(json!({ "codexMode": false, "toastDurationMs": 7000 })))
        .await
        .expect("unified save");
    let raw = fs::read_to_string(get_unified_settings_path()).unwrap();
    let record: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(record["pluginConfig"]["codexMode"], json!(false));
    assert_eq!(record["pluginConfig"]["toastDurationMs"], json!(7000));
    assert_eq!(record["version"], json!(1));
}

#[tokio::test]
#[serial(env)]
async fn unified_save_preserves_sibling_sections_and_merges_the_section() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig":{"codexMode":true,"futureKey":1},"dashboardDisplaySettings":{"uiThemePreset":"blue"},"version":1}"#,
    )
    .unwrap();
    save_plugin_config(&patch(json!({ "fastSession": true })))
        .await
        .unwrap();
    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    // Section merged: existing values + unknown key + patch.
    assert_eq!(record["pluginConfig"]["codexMode"], json!(true));
    assert_eq!(record["pluginConfig"]["futureKey"], json!(1));
    assert_eq!(record["pluginConfig"]["fastSession"], json!(true));
    // Sibling section untouched.
    assert_eq!(record["dashboardDisplaySettings"]["uiThemePreset"], json!("blue"));
}

#[tokio::test]
#[serial(env)]
async fn first_unified_save_migrates_legacy_config_values() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // Only a legacy config.json exists; the first save copies its (valid)
    // values into settings.json merged with the patch. The legacy file is
    // never modified.
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let legacy = sandbox.codex_multi_auth_dir().join("config.json");
    let legacy_content = r#"{"codexMode": false, "futureKey": "kept"}"#;
    fs::write(&legacy, legacy_content).unwrap();

    save_plugin_config(&patch(json!({ "fastSession": true })))
        .await
        .unwrap();

    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert_eq!(record["pluginConfig"]["codexMode"], json!(false));
    assert_eq!(record["pluginConfig"]["futureKey"], json!("kept"));
    assert_eq!(record["pluginConfig"]["fastSession"], json!(true));
    assert_eq!(fs::read_to_string(&legacy).unwrap(), legacy_content);
}

#[tokio::test]
#[serial(env)]
async fn typed_save_serializes_only_the_set_fields() {
    let _sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let typed_patch = PluginConfig {
        fast_session: Some(true),
        ..PluginConfig::default()
    };
    save_plugin_config_typed(&typed_patch).await.unwrap();
    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert_eq!(
        record["pluginConfig"],
        json!({ "fastSession": true }),
        "only the Some field lands in the section"
    );
}

#[tokio::test]
#[serial(env)]
async fn cleans_temp_files_after_env_path_saves() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("env-config.json");
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    save_plugin_config(&patch(json!({ "codexMode": true }))).await.unwrap();
    let leftovers: Vec<String> = fs::read_dir(sandbox.root())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp") || name.ends_with(".lock"))
        .collect();
    assert!(leftovers.is_empty(), "stray artifacts: {leftovers:?}");
}
