//! Integration tests for `cma_config::explain` — ported from
//! `test/config-explain.test.ts` (source attribution + storageKind rows).

use std::fs;

use serde_json::{Value, json};
use serial_test::serial;

use cma_config::explain::{
    ConfigExplainEntry, ConfigExplainSource, ConfigExplainStorageKind,
    get_plugin_config_explain_report,
};
use cma_config::load::__reset_config_warning_cache_for_tests;
use cma_config::unified_settings::get_unified_settings_path;
use cma_testkit::sandbox::EnvSandbox;

fn entry<'a>(entries: &'a [ConfigExplainEntry], key: &str) -> &'a ConfigExplainEntry {
    entries
        .iter()
        .find(|entry| entry.key == key)
        .unwrap_or_else(|| panic!("missing explain entry {key}"))
}

#[test]
#[serial(env)]
fn reports_missing_config_files_as_none_with_default_sources() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // The sandbox pins CODEX_AUTH_PID_OFFSET_ENABLED=0, which would register
    // as an env source; drop it for a purely-default report.
    sandbox.remove_var("CODEX_AUTH_PID_OFFSET_ENABLED");

    let report = get_plugin_config_explain_report();
    assert_eq!(report.storage_kind, ConfigExplainStorageKind::None);
    assert_eq!(report.config_path, None);
    assert_eq!(report.entries.len(), 54);
    assert!(
        report
            .entries
            .iter()
            .all(|entry| entry.source == ConfigExplainSource::Default),
        "everything defaults when nothing is stored and no env is set"
    );
    let codex_mode = entry(&report.entries, "codexMode");
    assert_eq!(codex_mode.value, json!(true));
    assert_eq!(codex_mode.default_value, json!(true));
    assert_eq!(codex_mode.env_names, &["CODEX_MODE"]);
}

#[test]
#[serial(env)]
fn marks_entries_sourced_from_unified_settings_as_unified() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig":{"codexMode":false,"toastDurationMs":9000},"version":1}"#,
    )
    .unwrap();

    let report = get_plugin_config_explain_report();
    assert_eq!(report.storage_kind, ConfigExplainStorageKind::Unified);
    assert_eq!(report.config_path, Some(get_unified_settings_path()));

    let codex_mode = entry(&report.entries, "codexMode");
    assert_eq!(codex_mode.source, ConfigExplainSource::Unified);
    assert_eq!(codex_mode.value, json!(false));
    let toast = entry(&report.entries, "toastDurationMs");
    assert_eq!(toast.source, ConfigExplainSource::Unified);
    assert_eq!(toast.value, json!(9000));
    // A key NOT present in the stored record stays "default".
    assert_eq!(
        entry(&report.entries, "fastSession").source,
        ConfigExplainSource::Default
    );
}

#[test]
#[serial(env)]
fn reports_env_sources_when_an_override_changes_the_effective_value() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    sandbox.set_var("CODEX_MODE", "0");
    let report = get_plugin_config_explain_report();
    let codex_mode = entry(&report.entries, "codexMode");
    assert_eq!(codex_mode.source, ConfigExplainSource::Env);
    assert_eq!(codex_mode.value, json!(false));
}

#[test]
#[serial(env)]
fn treats_invalid_string_env_values_as_non_env_sources() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // An invalid enum env value falls through in the getter, so disabling it
    // changes nothing → not an env source.
    sandbox.set_var("CODEX_TUI_COLOR_PROFILE", "chartreuse");
    let report = get_plugin_config_explain_report();
    let profile = entry(&report.entries, "codexTuiColorProfile");
    assert_eq!(profile.source, ConfigExplainSource::Default);
    assert_eq!(profile.value, json!("truecolor"));
}

#[test]
#[serial(env)]
fn reports_the_env_config_path_as_the_file_source_when_set() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("env-config.json");
    fs::write(&env_file, r#"{"codexMode": false}"#).unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    // Unified ALSO exists but must be masked by the env path (config-01).
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig":{"fastSession":true},"version":1}"#,
    )
    .unwrap();

    let report = get_plugin_config_explain_report();
    assert_eq!(report.storage_kind, ConfigExplainStorageKind::File);
    assert_eq!(report.config_path, Some(env_file));
    assert_eq!(
        entry(&report.entries, "codexMode").source,
        ConfigExplainSource::File
    );
    // fastSession only exists in unified, which was NOT consulted.
    assert_eq!(
        entry(&report.entries, "fastSession").source,
        ConfigExplainSource::Default
    );
}

#[test]
#[serial(env)]
fn reports_unreadable_env_config_files_consistently() {
    let mut sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    let env_file = sandbox.root().join("corrupt.json");
    fs::write(&env_file, "not json at all {{{").unwrap();
    sandbox.set_var("CODEX_MULTI_AUTH_CONFIG_PATH", &env_file);
    // Healthy unified data exists, but the explain report must NOT mask the
    // broken env path behind it (gotcha 2).
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig":{"codexMode":false},"version":1}"#,
    )
    .unwrap();

    let report = get_plugin_config_explain_report();
    assert_eq!(report.storage_kind, ConfigExplainStorageKind::Unreadable);
    assert_eq!(report.config_path, Some(env_file));
    assert_eq!(
        entry(&report.entries, "codexMode").source,
        ConfigExplainSource::Default,
        "no stored record was resolved"
    );
}

#[test]
#[serial(env)]
fn attributes_alias_backed_fallback_policy_values_to_stored_config() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // Only the legacy alias key is stored; both policy rows share sourceKeys
    // ["unsupportedCodexPolicy", "fallbackOnUnsupportedCodexModel"].
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig":{"fallbackOnUnsupportedCodexModel":true},"version":1}"#,
    )
    .unwrap();

    let report = get_plugin_config_explain_report();
    // TS parity (test/config-explain.test.ts): only SOURCE is asserted. The
    // loaded config merges DEFAULT_PLUGIN_CONFIG (which carries
    // unsupportedCodexPolicy: "strict"), so the policy getter short-circuits
    // on the default before consulting the legacy alias — the VALUE stays
    // "strict" while the shared sourceKeys still attribute both rows to the
    // stored record.
    let policy = entry(&report.entries, "unsupportedCodexPolicy");
    assert_eq!(policy.source, ConfigExplainSource::Unified);
    assert_eq!(policy.value, json!("strict"));
    let alias = entry(&report.entries, "fallbackOnUnsupportedCodexModel");
    assert_eq!(alias.source, ConfigExplainSource::Unified);
    assert_eq!(alias.value, json!(false));
}

#[test]
#[serial(env)]
fn attributes_stored_single_key_defaults_to_file_config() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    // A stored value equal to the default still attributes to the store
    // (hasOwn check, not value comparison).
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        sandbox.codex_multi_auth_dir().join("config.json"),
        r#"{"codexMode": true}"#,
    )
    .unwrap();
    let report = get_plugin_config_explain_report();
    assert_eq!(report.storage_kind, ConfigExplainStorageKind::File);
    assert_eq!(
        entry(&report.entries, "codexMode").source,
        ConfigExplainSource::File
    );
    assert_eq!(entry(&report.entries, "codexMode").value, json!(true));
}

#[test]
#[serial(env)]
fn fallback_chain_entry_has_no_env_names_and_json_safe_values() {
    let sandbox = EnvSandbox::new();
    __reset_config_warning_cache_for_tests();
    fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
    fs::write(
        get_unified_settings_path(),
        r#"{"pluginConfig":{"unsupportedCodexFallbackChain":{"gpt-5.3-codex-spark":["gpt-5.3-codex-high"]}},"version":1}"#,
    )
    .unwrap();
    let report = get_plugin_config_explain_report();
    let chain = entry(&report.entries, "unsupportedCodexFallbackChain");
    assert!(chain.env_names.is_empty());
    assert_eq!(chain.source, ConfigExplainSource::Unified);
    // The VALUE is the getter output — normalized (effort suffix stripped).
    assert_eq!(
        chain.value,
        json!({ "gpt-5.3-codex-spark": ["gpt-5.3-codex"] })
    );
    assert_eq!(chain.default_value, Value::Object(Default::default()));
}
