//! Port of the load half of `lib/config.ts` — `loadPluginConfig`, the legacy
//! path resolution ladder, per-field sanitization, and the shared read
//! plumbing used by `save.rs` / `explain.rs`.
//!
//! Behavior source: spec 01 §2.9/§4.2/§10.1 + the TS source. Key contracts:
//!
//! - Precedence: `CODEX_MULTI_AUTH_CONFIG_PATH` (set AND existing) → unified
//!   settings `pluginConfig` section → legacy file ladder → defaults. A
//!   set-but-missing env path is IGNORED on load (gotcha 1) but is still the
//!   save target (`save.rs`).
//! - Load NEVER fails: per-field zod validation drops invalid values silently
//!   with ONE warn-once carrying the first 3 schema errors (gotcha 4); any
//!   throw degrades to defaults with a warn-once.
//! - UTF-8 BOM stripped before every JSON.parse (gotcha 6).
//! - Sync reads retry transient EBUSY/EPERM/EAGAIN immediately (5 attempts,
//!   zero delay — the Atomics.wait regression, §10.1).
//! - All warn-once texts are FROZEN strings.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use cma_core::fs_retry::{Backoff, HasErrorCode, RetryOptions, code_of, with_retry, with_retry_sync};
use cma_core::json_io::{read_text_file, strip_utf8_bom};
use cma_core::logger::warn_once;
use cma_core::runtime_paths::{get_codex_home_dir, get_codex_multi_auth_dir, get_legacy_codex_dir};
use cma_core::schemas::plugin_config::{
    PLUGIN_CONFIG_KEYS, PluginConfig, plugin_config_issues, validate_field,
};
use cma_core::schemas::parse::validation_errors;
use cma_core::utils::is_record;

use crate::unified_settings::{get_unified_settings_path, load_unified_plugin_config_sync};

/// Rename/lock-unlink retry codes (`RETRYABLE_FS_CODES` in config.ts).
pub(crate) const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];
/// Read/stat retry codes (`RETRYABLE_CONFIG_READ_CODES` in config.ts).
pub(crate) const RETRYABLE_CONFIG_READ_CODES: &[&str] = &["EBUSY", "EPERM", "EAGAIN"];

// ---------------------------------------------------------------------------
// Paths (TS computed these once at module import; per-call resolution is
// behavior-equivalent within one process and required for env sandboxing)
// ---------------------------------------------------------------------------

pub(crate) struct ConfigPaths {
    /// `<multi-auth-dir>/config.json` (the current canonical legacy file).
    pub config_path: PathBuf,
    pub is_custom_codex_home: bool,
    pub legacy_codex_home_config_path: PathBuf,
    pub legacy_codex_home_auth_config_path: PathBuf,
    pub legacy_codex_config_path: PathBuf,
    pub legacy_codex_auth_config_path: PathBuf,
}

impl ConfigPaths {
    pub(crate) fn resolve() -> Self {
        let config_dir = get_codex_multi_auth_dir();
        let codex_home_dir = get_codex_home_dir();
        let legacy_codex_dir = get_legacy_codex_dir();
        let is_custom_codex_home = codex_home_dir != legacy_codex_dir;
        ConfigPaths {
            config_path: config_dir.join("config.json"),
            is_custom_codex_home,
            legacy_codex_home_config_path: codex_home_dir.join("codex-multi-auth-config.json"),
            legacy_codex_home_auth_config_path: codex_home_dir.join("openai-codex-auth-config.json"),
            legacy_codex_config_path: legacy_codex_dir.join("codex-multi-auth-config.json"),
            legacy_codex_auth_config_path: legacy_codex_dir.join("openai-codex-auth-config.json"),
        }
    }
}

/// `logConfigWarnOnce` — dedupe key is the FULL message string, process-global
/// (gotcha 7). Delegates to the core warn-once registry.
pub(crate) fn log_config_warn_once(message: &str) {
    warn_once(message);
}

/// `__resetConfigWarningCacheForTests` — clears the warn-once set.
pub fn __reset_config_warning_cache_for_tests() {
    cma_core::logger::__reset_for_tests();
}

/// Trimmed non-empty `CODEX_MULTI_AUTH_CONFIG_PATH` (the raw process env —
/// deliberately NOT routed through the explain env-disabled flag; explain
/// never disables this variable).
pub(crate) fn env_config_path() -> Option<String> {
    let raw = std::env::var("CODEX_MULTI_AUTH_CONFIG_PATH").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// `readFileSyncWithConfigRetry` — 5 attempts, IMMEDIATE retry (zero delay,
/// never a blocking sleep) on EBUSY/EPERM/EAGAIN; ENOENT and parse errors
/// propagate unchanged (config-04).
pub(crate) fn read_file_sync_with_config_retry(config_path: &Path) -> io::Result<String> {
    with_retry_sync(
        || read_text_file(config_path),
        RetryOptions::<io::Error>::fixed(5, 0).with_codes(RETRYABLE_CONFIG_READ_CODES),
    )
}

/// `resolvePluginConfigPath` — env override (existing file only) → current
/// config.json → legacy ladder with one-time migration warnings (spec 01
/// §4.2 order; gotcha 1 for the env branch).
pub(crate) fn resolve_plugin_config_path(paths: &ConfigPaths) -> Option<PathBuf> {
    if let Some(env_path) = env_config_path()
        && Path::new(&env_path).exists()
    {
        return Some(PathBuf::from(env_path));
    }

    if paths.config_path.exists() {
        return Some(paths.config_path.clone());
    }

    let legacy_warn = |legacy: &Path, config_path: &Path| {
        log_config_warn_once(&format!(
            "Using legacy config path {}. Please migrate to {}.",
            legacy.display(),
            config_path.display()
        ));
    };

    if paths.is_custom_codex_home && paths.legacy_codex_home_config_path.exists() {
        legacy_warn(&paths.legacy_codex_home_config_path, &paths.config_path);
        return Some(paths.legacy_codex_home_config_path.clone());
    }

    if paths.legacy_codex_config_path.exists() {
        legacy_warn(&paths.legacy_codex_config_path, &paths.config_path);
        return Some(paths.legacy_codex_config_path.clone());
    }

    if paths.is_custom_codex_home && paths.legacy_codex_home_auth_config_path.exists() {
        legacy_warn(&paths.legacy_codex_home_auth_config_path, &paths.config_path);
        return Some(paths.legacy_codex_home_auth_config_path.clone());
    }

    if paths.legacy_codex_auth_config_path.exists() {
        legacy_warn(&paths.legacy_codex_auth_config_path, &paths.config_path);
        return Some(paths.legacy_codex_auth_config_path.clone());
    }

    None
}

/// `readConfigRecordFromPath` — sync tolerant reader used by the explain
/// report: `None` when missing, malformed, non-object, or unreadable (with a
/// warn-once naming the path).
pub(crate) fn read_config_record_from_path(config_path: &Path) -> Option<Map<String, Value>> {
    if !config_path.exists() {
        return None;
    }
    let outcome: Result<Value, String> = read_file_sync_with_config_retry(config_path)
        .map_err(|error| error.to_string())
        .and_then(|content| {
            serde_json::from_str::<Value>(strip_utf8_bom(&content)).map_err(|e| e.to_string())
        });
    match outcome {
        Ok(Value::Object(map)) => Some(map),
        Ok(_) => None,
        Err(message) => {
            log_config_warn_once(&format!(
                "Failed to read config from {}: {}",
                config_path.display(),
                message
            ));
            None
        }
    }
}

/// `readConfigRecordForSave` classification (gotcha 12): only `Unreadable`
/// aborts a save; `Invalid` rebuilds from the patch; `Missing` starts fresh.
#[derive(Debug)]
pub(crate) enum ConfigReadState {
    Missing,
    Ok(Map<String, Value>),
    Invalid {
        /// Carried for parity with the TS state shape; only the Unreadable
        /// message is consumed (the unreadable-abort StorageError cause).
        #[allow(dead_code)]
        error_message: String,
    },
    Unreadable {
        error_message: String,
    },
}

enum ConfigReadErr {
    Io(io::Error),
    Parse(serde_json::Error),
}

impl HasErrorCode for ConfigReadErr {
    fn error_code(&self) -> Option<&str> {
        match self {
            ConfigReadErr::Io(error) => code_of(error),
            ConfigReadErr::Parse(_) => None,
        }
    }
}

/// `readConfigRecordForSave` — async classify-read with the 5-attempt
/// 10/20/40/80 ms transient retry on EBUSY/EPERM/EAGAIN.
pub(crate) async fn read_config_record_for_save(config_path: &Path) -> ConfigReadState {
    if !config_path.exists() {
        return ConfigReadState::Missing;
    }

    let result: Result<ConfigReadState, ConfigReadErr> = with_retry(
        || async {
            let content = read_text_file(config_path).map_err(ConfigReadErr::Io)?;
            let parsed: Value = serde_json::from_str(strip_utf8_bom(&content))
                .map_err(ConfigReadErr::Parse)?;
            match parsed {
                Value::Object(map) => Ok(ConfigReadState::Ok(map)),
                _ => {
                    let error_message = format!(
                        "Config at {} must contain a JSON object at the root.",
                        config_path.display()
                    );
                    log_config_warn_once(&error_message);
                    Ok(ConfigReadState::Invalid { error_message })
                }
            }
        },
        RetryOptions::new(
            5,
            Backoff::from_fn(|attempt| 10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))),
        )
        .with_codes(RETRYABLE_CONFIG_READ_CODES),
    )
    .await;

    match result {
        Ok(state) => state,
        Err(error) => {
            let (code, message) = match &error {
                ConfigReadErr::Io(io_error) => (code_of(io_error), io_error.to_string()),
                ConfigReadErr::Parse(parse_error) => (None, parse_error.to_string()),
            };
            if code == Some("ENOENT") {
                return ConfigReadState::Missing;
            }
            let error_message = format!(
                "Failed to read config from {}: {}",
                config_path.display(),
                message
            );
            log_config_warn_once(&error_message);
            match error {
                ConfigReadErr::Parse(_) => ConfigReadState::Invalid { error_message },
                ConfigReadErr::Io(_) if code.is_some() => {
                    ConfigReadState::Unreadable { error_message }
                }
                ConfigReadErr::Io(_) => ConfigReadState::Invalid { error_message },
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/// `sanitizePluginConfigRecord` — per-field zod validation over the 54 known
/// keys (schema declaration order); invalid values silently dropped; with
/// `warn_on_invalid`, ONE warn-once carrying the first 3 formatted schema
/// errors. `None` for non-record input.
pub(crate) fn sanitize_plugin_config_record(
    data: &Value,
    warn_on_invalid: bool,
) -> Option<Map<String, Value>> {
    if !is_record(data) {
        return None;
    }
    let record = data.as_object().expect("is_record checked");

    if warn_on_invalid {
        let schema_errors = validation_errors(plugin_config_issues, data);
        if !schema_errors.is_empty() {
            let first_three = schema_errors
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            log_config_warn_once(&format!(
                "Plugin config validation warnings: {first_three}"
            ));
        }
    }

    let mut sanitized = Map::new();
    for key in PLUGIN_CONFIG_KEYS {
        let Some(value) = record.get(key) else {
            continue;
        };
        if let Some(valid) = validate_field(key, value) {
            sanitized.insert(key.to_string(), valid);
        }
    }
    Some(sanitized)
}

/// `sanitizeStoredPluginConfigRecord` — validates known keys but PRESERVES
/// unknown keys in their original positions (gotcha 5: forward-compat fields
/// round-trip through saves). `None` for non-record input.
pub(crate) fn sanitize_stored_plugin_config_record(data: &Value) -> Option<Map<String, Value>> {
    if !is_record(data) {
        return None;
    }
    let record = data.as_object().expect("is_record checked");
    let mut sanitized = Map::new();
    for (key, value) in record {
        if !PLUGIN_CONFIG_KEYS.contains(&key.as_str()) {
            sanitized.insert(key.clone(), value.clone());
            continue;
        }
        if let Some(valid) = validate_field(key, value) {
            sanitized.insert(key.clone(), valid);
        }
    }
    Some(sanitized)
}

/// Build a typed partial [`PluginConfig`] from an already-sanitized map
/// (every value passed `validate_field`, so the whole-schema parse succeeds).
pub(crate) fn plugin_config_from_map(map: &Map<String, Value>) -> PluginConfig {
    serde_json::from_value(Value::Object(map.clone())).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// loadPluginConfig
// ---------------------------------------------------------------------------

/// `getDefaultPluginConfig` — fresh copy of `DEFAULT_PLUGIN_CONFIG`.
pub fn get_default_plugin_config() -> PluginConfig {
    PluginConfig::default_resolved()
}

/// `loadPluginConfig` — synchronous; NEVER fails (degrades to defaults with a
/// warn-once). Returns the fully-resolved config (defaults overlaid with the
/// sanitized user record).
pub fn load_plugin_config() -> PluginConfig {
    let paths = ConfigPaths::resolve();
    match load_plugin_config_inner(&paths) {
        Ok(config) => config,
        Err(message) => {
            let config_path =
                resolve_plugin_config_path(&paths).unwrap_or_else(|| paths.config_path.clone());
            log_config_warn_once(&format!(
                "Failed to load config from {}: {}",
                config_path.display(),
                message
            ));
            PluginConfig::default_resolved()
        }
    }
}

fn load_plugin_config_inner(paths: &ConfigPaths) -> Result<PluginConfig, String> {
    // config-02: keep load precedence symmetric with save — prefer the env
    // path (when set + existing) over unified settings.
    let env_path = env_config_path();
    let mut source_kind_is_file = false;
    let mut user_config: Value = match env_path.as_deref().filter(|p| Path::new(p).exists()) {
        Some(existing_env_path) => {
            let content = read_file_sync_with_config_retry(Path::new(existing_env_path))
                .map_err(|error| error.to_string())?;
            source_kind_is_file = true;
            serde_json::from_str(strip_utf8_bom(&content)).map_err(|error| error.to_string())?
        }
        None => match load_unified_plugin_config_sync() {
            Some(section) => Value::Object(section),
            None => Value::Null,
        },
    };

    if !is_record(&user_config) {
        let Some(config_path) = resolve_plugin_config_path(paths) else {
            return Ok(PluginConfig::default_resolved());
        };
        let content =
            read_file_sync_with_config_retry(&config_path).map_err(|error| error.to_string())?;
        user_config =
            serde_json::from_str(strip_utf8_bom(&content)).map_err(|error| error.to_string())?;
        source_kind_is_file = true;
    }

    let normalized_user_config = sanitize_plugin_config_record(&user_config, true);

    let has_fallback_env_override =
        std::env::var_os("CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL").is_some()
            || std::env::var_os("CODEX_AUTH_FALLBACK_GPT53_TO_GPT52").is_some();
    if let Some(record) = user_config.as_object() {
        let has_policy_key = record.contains_key("unsupportedCodexPolicy");
        let has_legacy_fallback_key = record.contains_key("fallbackOnUnsupportedCodexModel")
            || record.contains_key("fallbackToGpt52OnUnsupportedGpt53")
            || record.contains_key("unsupportedCodexFallbackChain");
        if !has_policy_key && (has_legacy_fallback_key || has_fallback_env_override) {
            log_config_warn_once(
                "Legacy unsupported-model fallback settings detected without unsupportedCodexPolicy. \
Using backward-compat behavior; prefer unsupportedCodexPolicy: \"strict\" | \"fallback\".",
            );
        }
    }

    if source_kind_is_file && normalized_user_config.is_some() && env_config_path().is_none() {
        log_config_warn_once(&format!(
            "Legacy config file is still in use; settings will migrate to {} on next save.",
            get_unified_settings_path().display()
        ));
    }

    let partial = normalized_user_config
        .as_ref()
        .map(plugin_config_from_map)
        .unwrap_or_default();
    Ok(PluginConfig::overlay(
        &PluginConfig::default_resolved(),
        &partial,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_drops_invalid_fields_and_keeps_valid_ones() {
        let data = json!({
            "codexMode": false,
            "toastDurationMs": 500,        // below schema min 1000 → dropped
            "codexTuiColorProfile": "bogus", // invalid enum → dropped
            "fetchTimeoutMs": 60000,
            "someFutureKey": { "x": 1 },   // unknown → not in known-key sanitize
        });
        let sanitized = sanitize_plugin_config_record(&data, false).unwrap();
        assert_eq!(sanitized.get("codexMode"), Some(&json!(false)));
        assert_eq!(sanitized.get("fetchTimeoutMs"), Some(&json!(60000)));
        assert!(!sanitized.contains_key("toastDurationMs"));
        assert!(!sanitized.contains_key("codexTuiColorProfile"));
        assert!(!sanitized.contains_key("someFutureKey"));
    }

    #[test]
    fn sanitize_returns_none_for_non_records() {
        assert!(sanitize_plugin_config_record(&json!(null), false).is_none());
        assert!(sanitize_plugin_config_record(&json!([1, 2]), false).is_none());
        assert!(sanitize_plugin_config_record(&json!("x"), false).is_none());
    }

    #[test]
    fn stored_sanitize_preserves_unknown_keys_in_input_order() {
        let raw = r#"{"futureKey":true,"codexMode":true,"toastDurationMs":1,"anotherUnknown":{"a":1}}"#;
        let data: Value = serde_json::from_str(raw).unwrap();
        let sanitized = sanitize_stored_plugin_config_record(&data).unwrap();
        let keys: Vec<&str> = sanitized.keys().map(String::as_str).collect();
        // toastDurationMs=1 is invalid (min 1000) → dropped; unknowns kept in place.
        assert_eq!(keys, vec!["futureKey", "codexMode", "anotherUnknown"]);
    }

    #[test]
    fn plugin_config_from_map_round_trips_sanitized_values() {
        let sanitized = sanitize_plugin_config_record(
            &json!({ "codexMode": false, "fastSessionMaxInputItems": 42 }),
            false,
        )
        .unwrap();
        let partial = plugin_config_from_map(&sanitized);
        assert_eq!(partial.codex_mode, Some(false));
        assert_eq!(partial.fast_session_max_input_items, Some(42.0));
        assert_eq!(partial.toast_duration_ms, None);
    }

    #[test]
    fn default_plugin_config_is_the_resolved_table() {
        let defaults = get_default_plugin_config();
        assert_eq!(defaults, PluginConfig::default_resolved());
        assert_eq!(defaults.pid_offset_enabled, Some(true));
    }
}
