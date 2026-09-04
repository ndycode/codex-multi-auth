//! Port of `getPluginConfigExplainReport` from `lib/config.ts` (spec 01
//! §2.9.1, gotchas 2 and 13).
//!
//! - The stored-record resolution mirrors `loadPluginConfig` precedence
//!   EXACTLY: env path (set + existing — even when unreadable, in which case
//!   storageKind is `"unreadable"` with that path, never masked behind
//!   unified) → unified `pluginConfig` section → legacy file ladder → none.
//! - Source detection: the getter is re-run with the entry's env names
//!   DISABLED via a thread-local seam (behavior-equivalent to the TS
//!   delete-and-restore of `process.env` — gotcha 13); a JSON-stringify
//!   difference means `"env"`. Otherwise a stored record owning any of the
//!   entry's `sourceKeys` attributes the storage kind; else `"default"`.
//! - Entry order is the fixed TS `CONFIG_EXPLAIN_ENTRIES` declaration order
//!   (54 entries; `responseContinuation`/`backgroundResponses`/
//!   `routingMutex`/`schedulingStrategy` come LAST, after the preemptive
//!   quota rows — this is NOT the schema order).
//! - Values are normalized for JSON-safe output: non-finite numbers become
//!   the strings `"NaN"`/`"Infinity"`/`"-Infinity"`; arrays/objects recurse.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use cma_core::json_io::stringify_compact;
use cma_core::schemas::plugin_config::PluginConfig;
use cma_core::utils::is_record;

use crate::getters::{self, with_env_names_disabled};
use crate::load::{
    ConfigPaths, env_config_path, load_plugin_config, read_config_record_from_path,
    resolve_plugin_config_path,
};
use crate::unified_settings::{get_unified_settings_path, load_unified_plugin_config_sync};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// `ConfigExplainStorageKind = "unified" | "file" | "none" | "unreadable"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigExplainStorageKind {
    Unified,
    File,
    None,
    Unreadable,
}

impl ConfigExplainStorageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigExplainStorageKind::Unified => "unified",
            ConfigExplainStorageKind::File => "file",
            ConfigExplainStorageKind::None => "none",
            ConfigExplainStorageKind::Unreadable => "unreadable",
        }
    }
}

/// `ConfigExplainSource = "env" | "unified" | "file" | "default"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigExplainSource {
    Env,
    Unified,
    File,
    Default,
}

impl ConfigExplainSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfigExplainSource::Env => "env",
            ConfigExplainSource::Unified => "unified",
            ConfigExplainSource::File => "file",
            ConfigExplainSource::Default => "default",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ConfigExplainEntry {
    pub key: &'static str,
    pub value: Value,
    pub default_value: Value,
    pub source: ConfigExplainSource,
    pub env_names: &'static [&'static str],
}

#[derive(Clone, Debug)]
pub struct ConfigExplainReport {
    pub config_path: Option<PathBuf>,
    pub storage_kind: ConfigExplainStorageKind,
    pub entries: Vec<ConfigExplainEntry>,
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

/// JS number → JSON value (integral values as integers, like
/// `JSON.stringify`); non-finite values survive into
/// [`normalize_config_explain_value`] as nulls there, but getters only
/// produce finite numbers.
fn num_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// `normalizeConfigExplainValue` — in TS, non-finite numbers become the
/// strings `"NaN"`/`"Infinity"`/`"-Infinity"`; `serde_json::Value` cannot
/// carry non-finite numbers (and [`num_value`] guards the conversion), so
/// only the recursive clone remains observable here.
fn normalize_config_explain_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(normalize_config_explain_value).collect())
        }
        Value::Object(map) => {
            let mut normalized = Map::new();
            for (key, item) in map {
                normalized.insert(key.clone(), normalize_config_explain_value(item));
            }
            Value::Object(normalized)
        }
        other => other.clone(),
    }
}

fn values_equal(left: &Value, right: &Value) -> bool {
    // `configExplainValuesEqual` = JSON.stringify equality.
    stringify_compact(left) == stringify_compact(right)
}

// ---------------------------------------------------------------------------
// Entry table (TS CONFIG_EXPLAIN_ENTRIES declaration order — 54 entries)
// ---------------------------------------------------------------------------

type GetValue = fn(&PluginConfig) -> Value;

struct ExplainMeta {
    key: &'static str,
    env_names: &'static [&'static str],
    get_value: GetValue,
    /// `sourceKeys` — defaults to `[key]`; the two unsupported-policy rows
    /// share `["unsupportedCodexPolicy", "fallbackOnUnsupportedCodexModel"]`.
    source_keys: &'static [&'static str],
}

macro_rules! meta {
    ($key:literal, [$($env:literal),*], $get:expr) => {
        ExplainMeta {
            key: $key,
            env_names: &[$($env),*],
            get_value: $get,
            source_keys: &[$key],
        }
    };
    ($key:literal, [$($env:literal),*], $get:expr, sources: [$($src:literal),+]) => {
        ExplainMeta {
            key: $key,
            env_names: &[$($env),*],
            get_value: $get,
            source_keys: &[$($src),+],
        }
    };
}

// fn pointers can't close over `f`, so each entry uses a small named wrapper.
macro_rules! bool_getter {
    ($name:ident, $inner:path) => {
        fn $name(config: &PluginConfig) -> Value {
            Value::Bool($inner(config))
        }
    };
}

macro_rules! num_getter {
    ($name:ident, $inner:path) => {
        fn $name(config: &PluginConfig) -> Value {
            num_value($inner(config))
        }
    };
}

macro_rules! str_getter {
    ($name:ident, $inner:path) => {
        fn $name(config: &PluginConfig) -> Value {
            Value::String($inner(config).as_str().to_string())
        }
    };
}

bool_getter!(v_codex_mode, getters::get_codex_mode);
bool_getter!(v_codex_runtime_rotation_proxy, getters::get_codex_runtime_rotation_proxy);
bool_getter!(v_codex_tui_v2, getters::get_codex_tui_v2);
str_getter!(v_codex_tui_color_profile, getters::get_codex_tui_color_profile);
str_getter!(v_codex_tui_glyph_mode, getters::get_codex_tui_glyph_mode);
bool_getter!(v_fast_session, getters::get_fast_session);
str_getter!(v_fast_session_strategy, getters::get_fast_session_strategy);
num_getter!(v_fast_session_max_input_items, getters::get_fast_session_max_input_items);
bool_getter!(v_retry_all_rate_limited, getters::get_retry_all_accounts_rate_limited);
num_getter!(v_retry_all_max_wait_ms, getters::get_retry_all_accounts_max_wait_ms);
num_getter!(v_retry_all_max_retries, getters::get_retry_all_accounts_max_retries);
str_getter!(v_unsupported_codex_policy, getters::get_unsupported_codex_policy);
bool_getter!(v_fallback_on_unsupported, getters::get_fallback_on_unsupported_codex_model);
bool_getter!(v_fallback_gpt53_to_gpt52, getters::get_fallback_to_gpt52_on_unsupported_gpt53);
fn v_unsupported_codex_fallback_chain(config: &PluginConfig) -> Value {
    getters::get_unsupported_codex_fallback_chain(config).to_value()
}
num_getter!(v_token_refresh_skew_ms, getters::get_token_refresh_skew_ms);
num_getter!(v_rate_limit_toast_debounce_ms, getters::get_rate_limit_toast_debounce_ms);
num_getter!(v_toast_duration_ms, getters::get_toast_duration_ms);
bool_getter!(v_per_project_accounts, getters::get_per_project_accounts);
bool_getter!(v_session_recovery, getters::get_session_recovery);
bool_getter!(v_auto_resume, getters::get_auto_resume);
bool_getter!(v_parallel_probing, getters::get_parallel_probing);
num_getter!(v_parallel_probing_max_concurrency, getters::get_parallel_probing_max_concurrency);
num_getter!(v_empty_response_max_retries, getters::get_empty_response_max_retries);
num_getter!(v_empty_response_retry_delay_ms, getters::get_empty_response_retry_delay_ms);
num_getter!(v_rate_limit_dedup_window_ms, getters::get_rate_limit_dedup_window_ms);
num_getter!(v_rate_limit_state_reset_ms, getters::get_rate_limit_state_reset_ms);
num_getter!(v_rate_limit_max_backoff_ms, getters::get_rate_limit_max_backoff_ms);
num_getter!(v_rate_limit_short_retry_threshold_ms, getters::get_rate_limit_short_retry_threshold_ms);
bool_getter!(v_pid_offset_enabled, getters::get_pid_offset_enabled);
num_getter!(v_fetch_timeout_ms, getters::get_fetch_timeout_ms);
num_getter!(v_stream_stall_timeout_ms, getters::get_stream_stall_timeout_ms);
bool_getter!(v_live_account_sync, getters::get_live_account_sync);
num_getter!(v_live_account_sync_debounce_ms, getters::get_live_account_sync_debounce_ms);
num_getter!(v_live_account_sync_poll_ms, getters::get_live_account_sync_poll_ms);
bool_getter!(v_session_affinity, getters::get_session_affinity);
num_getter!(v_session_affinity_ttl_ms, getters::get_session_affinity_ttl_ms);
num_getter!(v_session_affinity_max_entries, getters::get_session_affinity_max_entries);
bool_getter!(v_proactive_refresh_guardian, getters::get_proactive_refresh_guardian);
num_getter!(v_proactive_refresh_interval_ms, getters::get_proactive_refresh_interval_ms);
num_getter!(v_proactive_refresh_buffer_ms, getters::get_proactive_refresh_buffer_ms);
num_getter!(v_network_error_cooldown_ms, getters::get_network_error_cooldown_ms);
num_getter!(v_server_error_cooldown_ms, getters::get_server_error_cooldown_ms);
num_getter!(v_token_invalidation_cooldown_ms, getters::get_token_invalidation_cooldown_ms);
num_getter!(v_min_rotation_interval_ms, getters::get_min_rotation_interval_ms);
bool_getter!(v_storage_backup_enabled, getters::get_storage_backup_enabled);
bool_getter!(v_preemptive_quota_enabled, getters::get_preemptive_quota_enabled);
num_getter!(v_preemptive_quota_5h, getters::get_preemptive_quota_remaining_percent_5h);
num_getter!(v_preemptive_quota_7d, getters::get_preemptive_quota_remaining_percent_7d);
num_getter!(v_preemptive_quota_max_deferral_ms, getters::get_preemptive_quota_max_deferral_ms);
bool_getter!(v_response_continuation, getters::get_response_continuation);
bool_getter!(v_background_responses, getters::get_background_responses);
str_getter!(v_routing_mutex, getters::get_routing_mutex_mode);
str_getter!(v_scheduling_strategy, getters::get_scheduling_strategy);

const CONFIG_EXPLAIN_ENTRIES: &[ExplainMeta] = &[
    meta!("codexMode", ["CODEX_MODE"], v_codex_mode),
    meta!("codexRuntimeRotationProxy", ["CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY"], v_codex_runtime_rotation_proxy),
    meta!("codexTuiV2", ["CODEX_TUI_V2"], v_codex_tui_v2),
    meta!("codexTuiColorProfile", ["CODEX_TUI_COLOR_PROFILE"], v_codex_tui_color_profile),
    meta!("codexTuiGlyphMode", ["CODEX_TUI_GLYPHS"], v_codex_tui_glyph_mode),
    meta!("fastSession", ["CODEX_AUTH_FAST_SESSION"], v_fast_session),
    meta!("fastSessionStrategy", ["CODEX_AUTH_FAST_SESSION_STRATEGY"], v_fast_session_strategy),
    meta!("fastSessionMaxInputItems", ["CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS"], v_fast_session_max_input_items),
    meta!("retryAllAccountsRateLimited", ["CODEX_AUTH_RETRY_ALL_RATE_LIMITED"], v_retry_all_rate_limited),
    meta!("retryAllAccountsMaxWaitMs", ["CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS"], v_retry_all_max_wait_ms),
    meta!("retryAllAccountsMaxRetries", ["CODEX_AUTH_RETRY_ALL_MAX_RETRIES"], v_retry_all_max_retries),
    meta!(
        "unsupportedCodexPolicy",
        ["CODEX_AUTH_UNSUPPORTED_MODEL_POLICY", "CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL"],
        v_unsupported_codex_policy,
        sources: ["unsupportedCodexPolicy", "fallbackOnUnsupportedCodexModel"]
    ),
    meta!(
        "fallbackOnUnsupportedCodexModel",
        ["CODEX_AUTH_UNSUPPORTED_MODEL_POLICY", "CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL"],
        v_fallback_on_unsupported,
        sources: ["unsupportedCodexPolicy", "fallbackOnUnsupportedCodexModel"]
    ),
    meta!("fallbackToGpt52OnUnsupportedGpt53", ["CODEX_AUTH_FALLBACK_GPT53_TO_GPT52"], v_fallback_gpt53_to_gpt52),
    meta!("unsupportedCodexFallbackChain", [], v_unsupported_codex_fallback_chain),
    meta!("tokenRefreshSkewMs", ["CODEX_AUTH_TOKEN_REFRESH_SKEW_MS"], v_token_refresh_skew_ms),
    meta!("rateLimitToastDebounceMs", ["CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS"], v_rate_limit_toast_debounce_ms),
    meta!("toastDurationMs", ["CODEX_AUTH_TOAST_DURATION_MS"], v_toast_duration_ms),
    meta!("perProjectAccounts", ["CODEX_AUTH_PER_PROJECT_ACCOUNTS"], v_per_project_accounts),
    meta!("sessionRecovery", ["CODEX_AUTH_SESSION_RECOVERY"], v_session_recovery),
    meta!("autoResume", ["CODEX_AUTH_AUTO_RESUME"], v_auto_resume),
    meta!("parallelProbing", ["CODEX_AUTH_PARALLEL_PROBING"], v_parallel_probing),
    meta!("parallelProbingMaxConcurrency", ["CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY"], v_parallel_probing_max_concurrency),
    meta!("emptyResponseMaxRetries", ["CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES"], v_empty_response_max_retries),
    meta!("emptyResponseRetryDelayMs", ["CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS"], v_empty_response_retry_delay_ms),
    meta!("rateLimitDedupWindowMs", ["CODEX_AUTH_RATE_LIMIT_DEDUP_WINDOW_MS"], v_rate_limit_dedup_window_ms),
    meta!("rateLimitStateResetMs", ["CODEX_AUTH_RATE_LIMIT_STATE_RESET_MS"], v_rate_limit_state_reset_ms),
    meta!("rateLimitMaxBackoffMs", ["CODEX_AUTH_RATE_LIMIT_MAX_BACKOFF_MS"], v_rate_limit_max_backoff_ms),
    meta!("rateLimitShortRetryThresholdMs", ["CODEX_AUTH_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS"], v_rate_limit_short_retry_threshold_ms),
    meta!("pidOffsetEnabled", ["CODEX_AUTH_PID_OFFSET_ENABLED"], v_pid_offset_enabled),
    meta!("fetchTimeoutMs", ["CODEX_AUTH_FETCH_TIMEOUT_MS"], v_fetch_timeout_ms),
    meta!("streamStallTimeoutMs", ["CODEX_AUTH_STREAM_STALL_TIMEOUT_MS"], v_stream_stall_timeout_ms),
    meta!("liveAccountSync", ["CODEX_AUTH_LIVE_ACCOUNT_SYNC"], v_live_account_sync),
    meta!("liveAccountSyncDebounceMs", ["CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS"], v_live_account_sync_debounce_ms),
    meta!("liveAccountSyncPollMs", ["CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS"], v_live_account_sync_poll_ms),
    meta!("sessionAffinity", ["CODEX_AUTH_SESSION_AFFINITY"], v_session_affinity),
    meta!("sessionAffinityTtlMs", ["CODEX_AUTH_SESSION_AFFINITY_TTL_MS"], v_session_affinity_ttl_ms),
    meta!("sessionAffinityMaxEntries", ["CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES"], v_session_affinity_max_entries),
    meta!("proactiveRefreshGuardian", ["CODEX_AUTH_PROACTIVE_GUARDIAN"], v_proactive_refresh_guardian),
    meta!("proactiveRefreshIntervalMs", ["CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS"], v_proactive_refresh_interval_ms),
    meta!("proactiveRefreshBufferMs", ["CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS"], v_proactive_refresh_buffer_ms),
    meta!("networkErrorCooldownMs", ["CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS"], v_network_error_cooldown_ms),
    meta!("serverErrorCooldownMs", ["CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS"], v_server_error_cooldown_ms),
    meta!("tokenInvalidationCooldownMs", ["CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS"], v_token_invalidation_cooldown_ms),
    meta!("minRotationIntervalMs", ["CODEX_AUTH_MIN_ROTATION_INTERVAL_MS"], v_min_rotation_interval_ms),
    meta!("storageBackupEnabled", ["CODEX_AUTH_STORAGE_BACKUP_ENABLED"], v_storage_backup_enabled),
    meta!("preemptiveQuotaEnabled", ["CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED"], v_preemptive_quota_enabled),
    meta!("preemptiveQuotaRemainingPercent5h", ["CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT"], v_preemptive_quota_5h),
    meta!("preemptiveQuotaRemainingPercent7d", ["CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT"], v_preemptive_quota_7d),
    meta!("preemptiveQuotaMaxDeferralMs", ["CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS"], v_preemptive_quota_max_deferral_ms),
    // config-01/config-07: these live settings were once missing from the
    // explain report; they sit at the END of the table (declaration order).
    meta!("responseContinuation", ["CODEX_AUTH_RESPONSE_CONTINUATION"], v_response_continuation),
    meta!("backgroundResponses", ["CODEX_AUTH_BACKGROUND_RESPONSES"], v_background_responses),
    meta!("routingMutex", ["CODEX_AUTH_ROUTING_MUTEX"], v_routing_mutex),
    meta!("schedulingStrategy", ["CODEX_AUTH_SCHEDULING_STRATEGY"], v_scheduling_strategy),
];

/// The explain-entry keys, in report order (for parity tests).
pub fn config_explain_entry_keys() -> Vec<&'static str> {
    CONFIG_EXPLAIN_ENTRIES.iter().map(|meta| meta.key).collect()
}

// ---------------------------------------------------------------------------
// Stored-record resolution (`resolveStoredPluginConfigRecord`)
// ---------------------------------------------------------------------------

struct StoredRecord {
    config_path: Option<PathBuf>,
    storage_kind: ConfigExplainStorageKind,
    record: Option<Map<String, Value>>,
}

fn resolve_stored_plugin_config_record() -> StoredRecord {
    // config-01: mirror loadPluginConfig()'s precedence exactly.
    if let Some(env_config_path) = env_config_path() {
        let env_path = Path::new(&env_config_path);
        if env_path.exists() {
            if let Some(record) = read_config_record_from_path(env_path) {
                return StoredRecord {
                    config_path: Some(PathBuf::from(&env_config_path)),
                    storage_kind: ConfigExplainStorageKind::File,
                    record: Some(record),
                };
            }
            // Env path set + existing but unreadable/invalid: report it as
            // the active (unreadable) source, never masked behind unified.
            return StoredRecord {
                config_path: Some(PathBuf::from(&env_config_path)),
                storage_kind: ConfigExplainStorageKind::Unreadable,
                record: None,
            };
        }
    }

    if let Some(unified_config) = load_unified_plugin_config_sync() {
        // (loadUnifiedPluginConfigSync already guarantees a record shape.)
        if is_record(&Value::Object(unified_config.clone())) {
            return StoredRecord {
                config_path: Some(get_unified_settings_path()),
                storage_kind: ConfigExplainStorageKind::Unified,
                record: Some(unified_config),
            };
        }
    }

    let paths = ConfigPaths::resolve();
    let Some(config_path) = resolve_plugin_config_path(&paths) else {
        return StoredRecord {
            config_path: None,
            storage_kind: ConfigExplainStorageKind::None,
            record: None,
        };
    };

    if let Some(record) = read_config_record_from_path(&config_path) {
        return StoredRecord {
            config_path: Some(config_path),
            storage_kind: ConfigExplainStorageKind::File,
            record: Some(record),
        };
    }

    let storage_kind = if config_path.exists() {
        ConfigExplainStorageKind::Unreadable
    } else {
        ConfigExplainStorageKind::None
    };
    StoredRecord {
        config_path: Some(config_path),
        storage_kind,
        record: None,
    }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

fn resolve_config_explain_source(
    meta: &ExplainMeta,
    plugin_config: &PluginConfig,
    stored_record: Option<&Map<String, Value>>,
    storage_kind: ConfigExplainStorageKind,
) -> ConfigExplainSource {
    let effective_value = (meta.get_value)(plugin_config);
    let no_env_value = with_env_names_disabled(meta.env_names, || (meta.get_value)(plugin_config));
    if !values_equal(&effective_value, &no_env_value) {
        return ConfigExplainSource::Env;
    }
    let stored_source = match storage_kind {
        ConfigExplainStorageKind::Unified => Some(ConfigExplainSource::Unified),
        ConfigExplainStorageKind::File => Some(ConfigExplainSource::File),
        _ => None,
    };
    if let Some(source) = stored_source
        && let Some(record) = stored_record
        && meta.source_keys.iter().any(|key| record.contains_key(*key))
    {
        return source;
    }
    ConfigExplainSource::Default
}

/// `getPluginConfigExplainReport()` — see module docs.
pub fn get_plugin_config_explain_report() -> ConfigExplainReport {
    let plugin_config = load_plugin_config();
    let stored = resolve_stored_plugin_config_record();
    let stored_record = stored.record.as_ref();

    // DEFAULT_PLUGIN_CONFIG[key] — raw defaults (not routed through getters).
    let default_values: Map<String, Value> =
        match serde_json::to_value(PluginConfig::default_resolved()) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };

    let entries = CONFIG_EXPLAIN_ENTRIES
        .iter()
        .map(|meta| {
            let value = (meta.get_value)(&plugin_config);
            let default_value = default_values.get(meta.key).cloned().unwrap_or(Value::Null);
            ConfigExplainEntry {
                key: meta.key,
                value: normalize_config_explain_value(&value),
                default_value: normalize_config_explain_value(&default_value),
                source: resolve_config_explain_source(
                    meta,
                    &plugin_config,
                    stored_record,
                    stored.storage_kind,
                ),
                env_names: meta.env_names,
            }
        })
        .collect();

    ConfigExplainReport {
        config_path: stored.config_path,
        storage_kind: stored.storage_kind,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::plugin_config::PLUGIN_CONFIG_KEYS;

    #[test]
    fn explains_every_default_plugin_config_key_with_no_extras() {
        // Parity with test/config-explain.test.ts drift guards: same key SET
        // as DEFAULT_PLUGIN_CONFIG (order differs deliberately at the tail).
        let mut explain_keys = config_explain_entry_keys();
        let mut schema_keys: Vec<&str> = PLUGIN_CONFIG_KEYS.to_vec();
        assert_eq!(explain_keys.len(), 54);
        explain_keys.sort_unstable();
        schema_keys.sort_unstable();
        assert_eq!(explain_keys, schema_keys);
    }

    #[test]
    fn entry_order_puts_the_late_added_rows_last() {
        let keys = config_explain_entry_keys();
        assert_eq!(
            &keys[50..],
            &[
                "responseContinuation",
                "backgroundResponses",
                "routingMutex",
                "schedulingStrategy"
            ]
        );
        assert_eq!(keys[0], "codexMode");
        assert_eq!(keys[49], "preemptiveQuotaMaxDeferralMs");
    }

    #[test]
    fn normalize_recurses_and_passes_finite_values_through() {
        let value = serde_json::json!({ "a": [1, "x", { "b": true }] });
        assert_eq!(normalize_config_explain_value(&value), value);
    }

    #[test]
    fn num_value_prints_integral_numbers_without_decimals() {
        assert_eq!(stringify_compact(&num_value(5000.0)), "5000");
        assert_eq!(stringify_compact(&num_value(2.5)), "2.5");
    }
}
