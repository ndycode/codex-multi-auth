//! Integration tests for `cma_config::load` — ported from the
//! `loadPluginConfig` suite of `test/plugin-config.test.ts`.

use std::fs;

use serde_json::{Map, Value, json};
use serial_test::serial;

use cma_config::load::{__reset_config_warning_cache_for_tests, get_default_plugin_config,
    load_plugin_config};
use cma_config::unified_settings::get_unified_settings_path;
use cma_core::schemas::plugin_config::{CodexTuiColorProfile, PluginConfig};
use cma_testkit::sandbox::EnvSandbox;

fn write_settings_plugin_config(sandbox: &EnvSandbox, plugin_config: Value) {
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let record = json!({ "pluginConfig": plugin_config, "version": 1 });
    fs::write(get_unified_settings_path(), format!("{record}\n")).unwrap();
}

#[test]
#[serial(env)]
fn returns_default_config_when_no_file_exists() {
    let _sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let config = load_plugin_config();
    assert_eq!(config, PluginConfig::default_resolved());
    assert_eq!(config, get_default_plugin_config());
}

#[test]
#[serial(env)]
fn loads_config_from_unified_settings_and_merges_with_defaults() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    write_settings_plugin_config(
        &sandbox,
        json!({ "codexMode": false, "responseContinuation": true, "toastDurationMs": 8000 }),
    );
    let config = load_plugin_config();
    assert_eq!(config.codex_mode, Some(false));
    assert_eq!(config.response_continuation, Some(true));
    assert_eq!(config.toast_duration_ms, Some(8000.0));
    // Unspecified fields come from the defaults.
    assert_eq!(config.fast_session, Some(false));
    assert_eq!(config.pid_offset_enabled, Some(true));
}

#[test]
#[serial(env)]
fn prefers_the_env_config_path_on_load_when_it_exists() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // Unified says one thing, the env file says another → env file wins
    // (config-02 symmetry with save).
    write_settings_plugin_config(&sandbox, json!({ "codexMode": true }));
    let env_file = sandbox.root().join("env-config.json");
    fs::write(&env_file, r#"{"codexMode": false}"#).unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    let config = load_plugin_config();
    assert_eq!(config.codex_mode, Some(false));
}

#[test]
#[serial(env)]
fn falls_through_when_env_config_path_is_set_but_missing() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    write_settings_plugin_config(&sandbox, json!({ "codexMode": false }));
    sandbox.set_var(
        "CODEX_MULTI_AUTH_CONFIG_PATH",
        sandbox.root().join("does-not-exist.json"),
    );
    // Gotcha 1: set-but-missing env path is IGNORED on load.
    let config = load_plugin_config();
    assert_eq!(config.codex_mode, Some(false));
}

#[test]
#[serial(env)]
fn falls_back_to_legacy_config_json_when_unified_is_absent() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        sandbox.codex_multi_auth_dir().join("config.json"),
        r#"{"codexTuiColorProfile": "ansi16", "fastSession": true}"#,
    )
    .unwrap();
    let config = load_plugin_config();
    assert_eq!(
        config.codex_tui_color_profile,
        Some(CodexTuiColorProfile::Ansi16)
    );
    assert_eq!(config.fast_session, Some(true));
}

#[test]
#[serial(env)]
fn detects_custom_codex_home_legacy_config_before_global_legacy_path() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // Point CODEX_HOME somewhere custom so IS_CUSTOM_CODEX_HOME is true.
    let custom_home = sandbox.root().join("custom-codex");
    fs::create_dir_all(&custom_home).unwrap();
    sandbox.set_var("CODEX_HOME", &custom_home);
    fs::write(
        custom_home.join("codex-multi-auth-config.json"),
        r#"{"codexMode": false}"#,
    )
    .unwrap();
    // Global legacy path also exists with different content — custom home wins.
    let global_legacy_dir = sandbox.root().join(".codex");
    fs::create_dir_all(&global_legacy_dir).unwrap();
    fs::write(
        global_legacy_dir.join("codex-multi-auth-config.json"),
        r#"{"codexMode": true, "fastSession": true}"#,
    )
    .unwrap();
    let config = load_plugin_config();
    assert_eq!(config.codex_mode, Some(false));
    assert_eq!(config.fast_session, Some(false), "global legacy not read");
}

#[test]
#[serial(env)]
fn parses_utf8_bom_prefixed_config_files() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("bom-config.json");
    fs::write(&env_file, "\u{feff}{\"codexMode\": false}").unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    let config = load_plugin_config();
    assert_eq!(config.codex_mode, Some(false));
}

#[test]
#[serial(env)]
fn handles_invalid_json_gracefully() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("broken.json");
    fs::write(&env_file, "{ definitely not json").unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    let config = load_plugin_config();
    assert_eq!(config, PluginConfig::default_resolved());
}

#[test]
#[serial(env)]
fn drops_invalid_persisted_values_while_keeping_valid_config_keys() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    write_settings_plugin_config(
        &sandbox,
        json!({
            "codexMode": false,
            "toastDurationMs": 500,          // below schema min → dropped
            "codexTuiGlyphMode": "sparkles", // invalid enum → dropped
        }),
    );
    let config = load_plugin_config();
    assert_eq!(config.codex_mode, Some(false));
    // Dropped fields resolve to the defaults after the merge.
    assert_eq!(config.toast_duration_ms, Some(5_000.0));
    assert_eq!(
        config.codex_tui_glyph_mode,
        Some(cma_core::schemas::plugin_config::CodexTuiGlyphMode::Ascii)
    );
}

#[test]
#[serial(env)]
fn non_record_root_in_unified_section_falls_back_to_defaults() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig": "not-a-record", "version": 1}"#,
    )
    .unwrap();
    let config = load_plugin_config();
    assert_eq!(config, PluginConfig::default_resolved());
}

#[test]
#[serial(env)]
fn unknown_keys_are_stripped_on_load() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    write_settings_plugin_config(
        &sandbox,
        json!({ "futureFeature": { "x": 1 }, "codexMode": false }),
    );
    let config = load_plugin_config();
    assert_eq!(config.codex_mode, Some(false));
    // Round-tripping through serialization shows no unknown fields survive
    // into the typed config.
    let as_map: Map<String, Value> = match serde_json::to_value(&config).unwrap() {
        Value::Object(map) => map,
        _ => unreachable!(),
    };
    assert!(!as_map.contains_key("futureFeature"));
}
