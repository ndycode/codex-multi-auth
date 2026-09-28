//! Integration tests for `cma_config::dashboard_settings` — ported from
//! `test/dashboard-settings.test.ts` (IO + migration flows; the pure
//! normalization matrix lives in the module's unit tests).

use std::fs;

use serde_json::{Map, Value, json};
use serial_test::serial;

use cma_config::dashboard_settings::{
    DashboardAccentColor, DashboardDisplaySettings, DashboardThemePreset,
    get_dashboard_settings_path, load_dashboard_display_settings, save_dashboard_display_settings,
};
use cma_config::unified_settings::get_unified_settings_path;
use cma_testkit::sandbox::EnvSandbox;

#[tokio::test]
#[serial(env)]
async fn loads_defaults_when_no_settings_files_exist() {
    let _sandbox = EnvSandbox::new();
    let settings = load_dashboard_display_settings().await;
    assert_eq!(settings, DashboardDisplaySettings::default());
}

#[tokio::test]
#[serial(env)]
async fn dashboard_settings_path_is_the_unified_settings_file() {
    let _sandbox = EnvSandbox::new();
    assert_eq!(get_dashboard_settings_path(), get_unified_settings_path());
}

#[tokio::test]
#[serial(env)]
async fn saves_and_reloads_settings() {
    let _sandbox = EnvSandbox::new();
    let settings = DashboardDisplaySettings {
        ui_theme_preset: DashboardThemePreset::Blue,
        ui_accent_color: DashboardAccentColor::Cyan,
        menu_quota_ttl_ms: 120_000,
        ..Default::default()
    };
    save_dashboard_display_settings(&settings).await.unwrap();

    let reloaded = load_dashboard_display_settings().await;
    assert_eq!(reloaded.ui_theme_preset, DashboardThemePreset::Blue);
    assert_eq!(reloaded.ui_accent_color, DashboardAccentColor::Cyan);
    assert_eq!(reloaded.menu_quota_ttl_ms, 120_000);
}

#[tokio::test]
#[serial(env)]
async fn preserves_plugin_config_section_when_saving_dashboard_settings() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig":{"codexMode":false},"version":1}"#,
    )
    .unwrap();
    save_dashboard_display_settings(&DashboardDisplaySettings::default())
        .await
        .unwrap();
    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert_eq!(record["pluginConfig"]["codexMode"], json!(false));
    assert!(record["dashboardDisplaySettings"].is_object());
}

#[tokio::test]
#[serial(env)]
async fn migrates_legacy_dashboard_settings_json_into_unified_settings() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let legacy_path = sandbox.codex_multi_auth_dir().join("dashboard-settings.json");
    // The legacy file wraps its payload under a `settings` key.
    let legacy_content = json!({
        "settings": {
            "uiThemePreset": "blue",
            "menuQuotaTtlMs": 90_000,
            "menuShowDetailsForUnselectedRows": true,
        }
    });
    fs::write(&legacy_path, legacy_content.to_string()).unwrap();

    let settings = load_dashboard_display_settings().await;
    assert_eq!(settings.ui_theme_preset, DashboardThemePreset::Blue);
    assert_eq!(settings.menu_quota_ttl_ms, 90_000);
    // Layout derivation from the legacy boolean hint.
    assert!(settings.menu_show_details_for_unselected_rows);

    // Migrated into unified settings…
    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert_eq!(record["dashboardDisplaySettings"]["uiThemePreset"], json!("blue"));
    // …and the legacy file is NOT deleted.
    assert!(legacy_path.exists());

    // Subsequent loads read the unified section (mutate it to prove it).
    let mut section: Map<String, Value> = match record["dashboardDisplaySettings"].clone() {
        Value::Object(map) => map,
        _ => unreachable!(),
    };
    section.insert("uiAccentColor".into(), json!("yellow"));
    cma_config::unified_settings::save_unified_dashboard_settings(&section)
        .await
        .unwrap();
    let reloaded = load_dashboard_display_settings().await;
    assert_eq!(reloaded.ui_accent_color, DashboardAccentColor::Yellow);
}

#[tokio::test]
#[serial(env)]
async fn falls_back_to_defaults_when_legacy_file_contains_malformed_json() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let legacy_path = sandbox.codex_multi_auth_dir().join("dashboard-settings.json");
    fs::write(&legacy_path, "{{ nope").unwrap();
    let settings = load_dashboard_display_settings().await;
    assert_eq!(settings, DashboardDisplaySettings::default());
}

#[tokio::test]
#[serial(env)]
async fn falls_back_to_defaults_when_legacy_file_parses_to_non_record_json() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let legacy_path = sandbox.codex_multi_auth_dir().join("dashboard-settings.json");
    fs::write(&legacy_path, "[1, 2, 3]").unwrap();
    let settings = load_dashboard_display_settings().await;
    assert_eq!(settings, DashboardDisplaySettings::default());
    // No migration happened.
    assert!(!get_unified_settings_path().exists());
}

#[tokio::test]
#[serial(env)]
async fn legacy_wrapper_without_settings_key_normalizes_to_defaults_and_migrates() {
    let sandbox = EnvSandbox::new();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    let legacy_path = sandbox.codex_multi_auth_dir().join("dashboard-settings.json");
    // A record WITHOUT the `settings` wrapper: `parsed.settings` is absent →
    // normalize(non-record) → defaults, which are then migrated.
    fs::write(&legacy_path, r#"{"uiThemePreset":"blue"}"#).unwrap();
    let settings = load_dashboard_display_settings().await;
    assert_eq!(settings, DashboardDisplaySettings::default());
    let record: Value =
        serde_json::from_str(&fs::read_to_string(get_unified_settings_path()).unwrap()).unwrap();
    assert!(record["dashboardDisplaySettings"].is_object());
}

#[tokio::test]
#[serial(env)]
async fn save_normalizes_before_persisting() {
    let _sandbox = EnvSandbox::new();
    let settings = DashboardDisplaySettings {
        menu_quota_ttl_ms: 10, // out of range → normalized up to 60_000
        ..Default::default()
    };
    save_dashboard_display_settings(&settings).await.unwrap();
    let reloaded = load_dashboard_display_settings().await;
    assert_eq!(reloaded.menu_quota_ttl_ms, 60_000);
}
