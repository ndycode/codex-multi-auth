//! Plugin configuration schema — port of `PluginConfigSchema` from
//! `lib/schemas.ts` plus `DEFAULT_PLUGIN_CONFIG` from `lib/config.ts`
//! (spec 01 §2.9/§3.1).
//!
//! Zod semantics implemented here (ARCHITECTURE §8.3):
//! - [`PluginConfig`] deserialization mirrors `PluginConfigSchema.safeParse`:
//!   every field optional, unknown keys silently stripped, ANY invalid known
//!   field fails the whole parse (use via `safe_parse_plugin_config`).
//! - The per-field sanitize path (`loadPluginConfig` /
//!   `sanitizePluginConfigRecord`) is served by [`validate_field`] /
//!   [`field_issues`]: config-crate code validates field-by-field over
//!   `serde_json::Value`s, silently dropping invalid values (warn-once is the
//!   config crate's business). Working in `Value` space preserves the exact
//!   number representation of user input for byte-stable saves.
//! - [`plugin_config_issues`] is the `getValidationErrors(PluginConfigSchema,
//!   data)` check for use with `parse::validation_errors`.
//!
//! Defaults: [`PluginConfig::default_resolved`] is `DEFAULT_PLUGIN_CONFIG`
//! with every field populated — including `pidOffsetEnabled: true`. The
//! getter-level inline default of **false** for `getPidOffsetEnabled` is the
//! config crate's business (spec 01 gotcha §11.3): do NOT "fix" the split.
//!
//! Numeric fields are `f64` (JS number semantics; zod bounds validate, they
//! do not clamp). Serialization prints integral values without a decimal
//! point, matching `JSON.stringify`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use super::parse::{SchemaIssue, fmt_js_number, json_type_name};

// ============================================================================
// Enum value types
// ============================================================================

macro_rules! config_str_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(value: &str) -> Option<Self> {
                match value {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

config_str_enum!(
    /// `codexTuiColorProfile ∈ {truecolor, ansi16, ansi256}`.
    CodexTuiColorProfile {
        Truecolor => "truecolor",
        Ansi16 => "ansi16",
        Ansi256 => "ansi256",
    }
);

config_str_enum!(
    /// `codexTuiGlyphMode ∈ {ascii, unicode, auto}`.
    CodexTuiGlyphMode {
        Ascii => "ascii",
        Unicode => "unicode",
        Auto => "auto",
    }
);

config_str_enum!(
    /// `fastSessionStrategy ∈ {hybrid, always}`.
    FastSessionStrategy {
        Hybrid => "hybrid",
        Always => "always",
    }
);

config_str_enum!(
    /// `unsupportedCodexPolicy ∈ {strict, fallback}` (`UnsupportedCodexPolicy`
    /// in `lib/config.ts`).
    UnsupportedCodexPolicy {
        Strict => "strict",
        Fallback => "fallback",
    }
);

config_str_enum!(
    /// `routingMutex ∈ {enabled, legacy}`.
    RoutingMutexMode {
        Enabled => "enabled",
        Legacy => "legacy",
    }
);

config_str_enum!(
    /// `schedulingStrategy ∈ {hybrid, sequential}`.
    SchedulingStrategy {
        Hybrid => "hybrid",
        Sequential => "sequential",
    }
);

// ============================================================================
// unsupportedCodexFallbackChain — ordered record<string, string[] (min1)>
// ============================================================================

/// `unsupportedCodexFallbackChain: Record<string, string[]>` where each array
/// element is a non-empty string. Preserves key insertion order. Stored RAW
/// (as validated); the normalization (lowercasing, suffix stripping — which
/// deliberately does NOT strip `-max`/`-ultra`) happens in the config crate's
/// `get_unsupported_codex_fallback_chain` getter (spec 01 gotcha §11.8).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FallbackChain(pub Vec<(String, Vec<String>)>);

impl FallbackChain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn get(&self, key: &str) -> Option<&[String]> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, targets)| targets.as_slice())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &[String])> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_slice()))
    }

    /// Build from an already-validated JSON value (`validate_field` accepted
    /// it). Returns `None` when the shape does not match the schema.
    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let mut entries = Vec::with_capacity(object.len());
        for (key, targets) in object {
            let array = targets.as_array()?;
            let mut list = Vec::with_capacity(array.len());
            for target in array {
                let s = target.as_str()?;
                if s.is_empty() {
                    return None;
                }
                list.push(s.to_string());
            }
            entries.push((key.clone(), list));
        }
        Some(Self(entries))
    }

    pub fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        for (key, targets) in &self.0 {
            map.insert(
                key.clone(),
                Value::Array(targets.iter().cloned().map(Value::String).collect()),
            );
        }
        Value::Object(map)
    }
}

impl Serialize for FallbackChain {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, targets) in &self.0 {
            map.serialize_entry(key, targets)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for FallbackChain {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Self::from_value(&value).ok_or_else(|| {
            serde::de::Error::custom(
                "Invalid input: expected record of non-empty string arrays",
            )
        })
    }
}

// ============================================================================
// Field table (declaration order == zod schema order == explain order)
// ============================================================================

#[derive(Clone, Copy, Debug)]
enum FieldKind {
    Bool,
    Num { min: f64, max: f64 },
    Enum(&'static [&'static str]),
    Chain,
}

const COLOR_PROFILES: &[&str] = &["truecolor", "ansi16", "ansi256"];
const GLYPH_MODES: &[&str] = &["ascii", "unicode", "auto"];
const FAST_SESSION_STRATEGIES: &[&str] = &["hybrid", "always"];
const UNSUPPORTED_POLICIES: &[&str] = &["strict", "fallback"];
const ROUTING_MUTEX_MODES: &[&str] = &["enabled", "legacy"];
const SCHEDULING_STRATEGIES: &[&str] = &["hybrid", "sequential"];

const NUM_FIELD_COUNT: usize = 54;

/// (key, validation) for every `PluginConfigSchema` field, in declaration
/// order.
const FIELDS: [(&str, FieldKind); NUM_FIELD_COUNT] = [
    ("codexMode", FieldKind::Bool),
    ("codexRuntimeRotationProxy", FieldKind::Bool),
    ("codexTuiV2", FieldKind::Bool),
    ("codexTuiColorProfile", FieldKind::Enum(COLOR_PROFILES)),
    ("codexTuiGlyphMode", FieldKind::Enum(GLYPH_MODES)),
    ("fastSession", FieldKind::Bool),
    ("fastSessionStrategy", FieldKind::Enum(FAST_SESSION_STRATEGIES)),
    ("fastSessionMaxInputItems", FieldKind::Num { min: 8.0, max: 200.0 }),
    ("retryAllAccountsRateLimited", FieldKind::Bool),
    ("retryAllAccountsMaxWaitMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("retryAllAccountsMaxRetries", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("unsupportedCodexPolicy", FieldKind::Enum(UNSUPPORTED_POLICIES)),
    ("fallbackOnUnsupportedCodexModel", FieldKind::Bool),
    ("fallbackToGpt52OnUnsupportedGpt53", FieldKind::Bool),
    ("unsupportedCodexFallbackChain", FieldKind::Chain),
    ("tokenRefreshSkewMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("rateLimitToastDebounceMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("toastDurationMs", FieldKind::Num { min: 1000.0, max: f64::INFINITY }),
    ("perProjectAccounts", FieldKind::Bool),
    ("sessionRecovery", FieldKind::Bool),
    ("autoResume", FieldKind::Bool),
    ("parallelProbing", FieldKind::Bool),
    ("parallelProbingMaxConcurrency", FieldKind::Num { min: 1.0, max: 5.0 }),
    ("emptyResponseMaxRetries", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("emptyResponseRetryDelayMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("rateLimitDedupWindowMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("rateLimitStateResetMs", FieldKind::Num { min: 1000.0, max: f64::INFINITY }),
    ("rateLimitMaxBackoffMs", FieldKind::Num { min: 1000.0, max: f64::INFINITY }),
    ("rateLimitShortRetryThresholdMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("pidOffsetEnabled", FieldKind::Bool),
    ("fetchTimeoutMs", FieldKind::Num { min: 1000.0, max: f64::INFINITY }),
    ("streamStallTimeoutMs", FieldKind::Num { min: 1000.0, max: f64::INFINITY }),
    ("liveAccountSync", FieldKind::Bool),
    ("liveAccountSyncDebounceMs", FieldKind::Num { min: 50.0, max: f64::INFINITY }),
    ("liveAccountSyncPollMs", FieldKind::Num { min: 500.0, max: f64::INFINITY }),
    ("sessionAffinity", FieldKind::Bool),
    ("sessionAffinityTtlMs", FieldKind::Num { min: 1000.0, max: f64::INFINITY }),
    ("sessionAffinityMaxEntries", FieldKind::Num { min: 8.0, max: f64::INFINITY }),
    ("responseContinuation", FieldKind::Bool),
    ("backgroundResponses", FieldKind::Bool),
    ("proactiveRefreshGuardian", FieldKind::Bool),
    ("proactiveRefreshIntervalMs", FieldKind::Num { min: 5000.0, max: f64::INFINITY }),
    ("proactiveRefreshBufferMs", FieldKind::Num { min: 30000.0, max: f64::INFINITY }),
    ("networkErrorCooldownMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("serverErrorCooldownMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("tokenInvalidationCooldownMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("minRotationIntervalMs", FieldKind::Num { min: 0.0, max: f64::INFINITY }),
    ("storageBackupEnabled", FieldKind::Bool),
    ("preemptiveQuotaEnabled", FieldKind::Bool),
    ("preemptiveQuotaRemainingPercent5h", FieldKind::Num { min: 0.0, max: 100.0 }),
    ("preemptiveQuotaRemainingPercent7d", FieldKind::Num { min: 0.0, max: 100.0 }),
    ("preemptiveQuotaMaxDeferralMs", FieldKind::Num { min: 1000.0, max: f64::INFINITY }),
    ("routingMutex", FieldKind::Enum(ROUTING_MUTEX_MODES)),
    ("schedulingStrategy", FieldKind::Enum(SCHEDULING_STRATEGIES)),
];

/// Every known plugin-config key, in zod schema declaration order. (Spec 01
/// speaks of "53 known keys" but the TS schema declares 54 — the two
/// unsupported-policy getters share one explain entry; TS wins here.)
pub const PLUGIN_CONFIG_KEYS: [&str; NUM_FIELD_COUNT] = {
    let mut keys = [""; NUM_FIELD_COUNT];
    let mut i = 0;
    while i < NUM_FIELD_COUNT {
        keys[i] = FIELDS[i].0;
        i += 1;
    }
    keys
};

/// Whether `key` is a known `PluginConfigSchema` field. Config-crate save
/// paths use this to tell "unknown key" (preserved on save) apart from
/// "invalid value" (dropped with warn-once).
pub fn is_known_plugin_config_key(key: &str) -> bool {
    FIELDS.iter().any(|(k, _)| *k == key)
}

fn field_kind(key: &str) -> Option<FieldKind> {
    FIELDS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, kind)| *kind)
}

// ============================================================================
// Per-field validation (the sanitize path)
// ============================================================================

/// Validation issues for a single known field (zod-flavored messages, path
/// rooted at `key`). Empty when valid — AND when `key` is unknown (zod
/// silently strips unknown keys without an issue; check
/// [`is_known_plugin_config_key`] first if you need to distinguish).
pub fn field_issues(key: &str, value: &Value) -> Vec<SchemaIssue> {
    let Some(kind) = field_kind(key) else {
        return Vec::new();
    };
    let mut issues = Vec::new();
    match kind {
        FieldKind::Bool => {
            if !value.is_boolean() {
                issues.push(SchemaIssue::new(
                    vec![key.to_string()],
                    format!(
                        "Invalid input: expected boolean, received {}",
                        json_type_name(value)
                    ),
                ));
            }
        }
        FieldKind::Num { min, max } => match value.as_f64() {
            None => issues.push(SchemaIssue::new(
                vec![key.to_string()],
                format!(
                    "Invalid input: expected number, received {}",
                    json_type_name(value)
                ),
            )),
            Some(v) if v < min => issues.push(SchemaIssue::new(
                vec![key.to_string()],
                format!("Too small: expected number to be >={}", fmt_js_number(min)),
            )),
            Some(v) if v > max => issues.push(SchemaIssue::new(
                vec![key.to_string()],
                format!("Too big: expected number to be <={}", fmt_js_number(max)),
            )),
            Some(_) => {}
        },
        FieldKind::Enum(options) => {
            let valid = value.as_str().is_some_and(|s| options.contains(&s));
            if !valid {
                let expected = options
                    .iter()
                    .map(|o| format!("\"{o}\""))
                    .collect::<Vec<_>>()
                    .join("|");
                issues.push(SchemaIssue::new(
                    vec![key.to_string()],
                    format!("Invalid option: expected one of {expected}"),
                ));
            }
        }
        FieldKind::Chain => match value.as_object() {
            None => issues.push(SchemaIssue::new(
                vec![key.to_string()],
                format!(
                    "Invalid input: expected record, received {}",
                    json_type_name(value)
                ),
            )),
            Some(object) => {
                for (entry_key, targets) in object {
                    match targets.as_array() {
                        None => issues.push(SchemaIssue::new(
                            vec![key.to_string(), entry_key.clone()],
                            format!(
                                "Invalid input: expected array, received {}",
                                json_type_name(targets)
                            ),
                        )),
                        Some(array) => {
                            for (index, target) in array.iter().enumerate() {
                                match target.as_str() {
                                    None => issues.push(SchemaIssue::new(
                                        vec![
                                            key.to_string(),
                                            entry_key.clone(),
                                            index.to_string(),
                                        ],
                                        format!(
                                            "Invalid input: expected string, received {}",
                                            json_type_name(target)
                                        ),
                                    )),
                                    Some("") => issues.push(SchemaIssue::new(
                                        vec![
                                            key.to_string(),
                                            entry_key.clone(),
                                            index.to_string(),
                                        ],
                                        "Too small: expected string to have >=1 characters"
                                            .to_string(),
                                    )),
                                    Some(_) => {}
                                }
                            }
                        }
                    }
                }
            }
        },
    }
    issues
}

/// Per-field zod validation for the sanitize path: `Some(value)` (a clone —
/// number representation preserved for byte-stable saves) when `key` is a
/// known field and `value` passes its schema bounds; `None` for unknown keys
/// AND for invalid values. Spec: ARCHITECTURE §6.1
/// `validate_field(key, &Value) -> Option<Value>`.
pub fn validate_field(key: &str, value: &Value) -> Option<Value> {
    if !is_known_plugin_config_key(key) {
        return None;
    }
    if field_issues(key, value).is_empty() {
        Some(value.clone())
    } else {
        None
    }
}

/// `getValidationErrors(PluginConfigSchema, data)` check: a non-object root
/// yields a single path-less issue; otherwise every known key present is
/// validated (unknown keys are stripped silently, producing no issue).
pub fn plugin_config_issues(value: &Value) -> Vec<SchemaIssue> {
    let Some(map) = value.as_object() else {
        return vec![SchemaIssue::root(format!(
            "Invalid input: expected object, received {}",
            json_type_name(value)
        ))];
    };
    let mut issues = Vec::new();
    for (key, _) in FIELDS.iter() {
        if let Some(field_value) = map.get(*key) {
            issues.extend(field_issues(key, field_value));
        }
    }
    issues
}

// ============================================================================
// PluginConfig struct
// ============================================================================

/// Serialize an `Option<f64>` the way `JSON.stringify` prints JS numbers:
/// integral values without a decimal point. Only reached when `Some` (fields
/// carry `skip_serializing_if = "Option::is_none"`).
fn ser_opt_js_number<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(v)
            if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 =>
        {
            serializer.serialize_i64(*v as i64)
        }
        Some(v) => serializer.serialize_f64(*v),
        None => serializer.serialize_none(),
    }
}

macro_rules! plugin_config_struct {
    ($(($field:ident, $key:literal, $ty:ty $(, $ser:literal)?)),+ $(,)?) => {
        /// The 54-field plugin configuration (`PluginConfig` =
        /// `z.infer<typeof PluginConfigSchema>`). Every field optional;
        /// serde names are the exact camelCase schema keys; `None` fields are
        /// omitted on serialization; declaration order == schema order.
        #[derive(Clone, Debug, Default, PartialEq, Serialize)]
        pub struct PluginConfig {
            $(
                #[serde(rename = $key, skip_serializing_if = "Option::is_none" $(, serialize_with = $ser)?)]
                pub $field: Option<$ty>,
            )+
        }
    };
}

plugin_config_struct![
    (codex_mode, "codexMode", bool),
    (codex_runtime_rotation_proxy, "codexRuntimeRotationProxy", bool),
    (codex_tui_v2, "codexTuiV2", bool),
    (codex_tui_color_profile, "codexTuiColorProfile", CodexTuiColorProfile),
    (codex_tui_glyph_mode, "codexTuiGlyphMode", CodexTuiGlyphMode),
    (fast_session, "fastSession", bool),
    (fast_session_strategy, "fastSessionStrategy", FastSessionStrategy),
    (fast_session_max_input_items, "fastSessionMaxInputItems", f64, "ser_opt_js_number"),
    (retry_all_accounts_rate_limited, "retryAllAccountsRateLimited", bool),
    (retry_all_accounts_max_wait_ms, "retryAllAccountsMaxWaitMs", f64, "ser_opt_js_number"),
    (retry_all_accounts_max_retries, "retryAllAccountsMaxRetries", f64, "ser_opt_js_number"),
    (unsupported_codex_policy, "unsupportedCodexPolicy", UnsupportedCodexPolicy),
    (fallback_on_unsupported_codex_model, "fallbackOnUnsupportedCodexModel", bool),
    (fallback_to_gpt52_on_unsupported_gpt53, "fallbackToGpt52OnUnsupportedGpt53", bool),
    (unsupported_codex_fallback_chain, "unsupportedCodexFallbackChain", FallbackChain),
    (token_refresh_skew_ms, "tokenRefreshSkewMs", f64, "ser_opt_js_number"),
    (rate_limit_toast_debounce_ms, "rateLimitToastDebounceMs", f64, "ser_opt_js_number"),
    (toast_duration_ms, "toastDurationMs", f64, "ser_opt_js_number"),
    (per_project_accounts, "perProjectAccounts", bool),
    (session_recovery, "sessionRecovery", bool),
    (auto_resume, "autoResume", bool),
    (parallel_probing, "parallelProbing", bool),
    (parallel_probing_max_concurrency, "parallelProbingMaxConcurrency", f64, "ser_opt_js_number"),
    (empty_response_max_retries, "emptyResponseMaxRetries", f64, "ser_opt_js_number"),
    (empty_response_retry_delay_ms, "emptyResponseRetryDelayMs", f64, "ser_opt_js_number"),
    (rate_limit_dedup_window_ms, "rateLimitDedupWindowMs", f64, "ser_opt_js_number"),
    (rate_limit_state_reset_ms, "rateLimitStateResetMs", f64, "ser_opt_js_number"),
    (rate_limit_max_backoff_ms, "rateLimitMaxBackoffMs", f64, "ser_opt_js_number"),
    (rate_limit_short_retry_threshold_ms, "rateLimitShortRetryThresholdMs", f64, "ser_opt_js_number"),
    (pid_offset_enabled, "pidOffsetEnabled", bool),
    (fetch_timeout_ms, "fetchTimeoutMs", f64, "ser_opt_js_number"),
    (stream_stall_timeout_ms, "streamStallTimeoutMs", f64, "ser_opt_js_number"),
    (live_account_sync, "liveAccountSync", bool),
    (live_account_sync_debounce_ms, "liveAccountSyncDebounceMs", f64, "ser_opt_js_number"),
    (live_account_sync_poll_ms, "liveAccountSyncPollMs", f64, "ser_opt_js_number"),
    (session_affinity, "sessionAffinity", bool),
    (session_affinity_ttl_ms, "sessionAffinityTtlMs", f64, "ser_opt_js_number"),
    (session_affinity_max_entries, "sessionAffinityMaxEntries", f64, "ser_opt_js_number"),
    (response_continuation, "responseContinuation", bool),
    (background_responses, "backgroundResponses", bool),
    (proactive_refresh_guardian, "proactiveRefreshGuardian", bool),
    (proactive_refresh_interval_ms, "proactiveRefreshIntervalMs", f64, "ser_opt_js_number"),
    (proactive_refresh_buffer_ms, "proactiveRefreshBufferMs", f64, "ser_opt_js_number"),
    (network_error_cooldown_ms, "networkErrorCooldownMs", f64, "ser_opt_js_number"),
    (server_error_cooldown_ms, "serverErrorCooldownMs", f64, "ser_opt_js_number"),
    (token_invalidation_cooldown_ms, "tokenInvalidationCooldownMs", f64, "ser_opt_js_number"),
    (min_rotation_interval_ms, "minRotationIntervalMs", f64, "ser_opt_js_number"),
    (storage_backup_enabled, "storageBackupEnabled", bool),
    (preemptive_quota_enabled, "preemptiveQuotaEnabled", bool),
    (preemptive_quota_remaining_percent_5h, "preemptiveQuotaRemainingPercent5h", f64, "ser_opt_js_number"),
    (preemptive_quota_remaining_percent_7d, "preemptiveQuotaRemainingPercent7d", f64, "ser_opt_js_number"),
    (preemptive_quota_max_deferral_ms, "preemptiveQuotaMaxDeferralMs", f64, "ser_opt_js_number"),
    (routing_mutex, "routingMutex", RoutingMutexMode),
    (scheduling_strategy, "schedulingStrategy", SchedulingStrategy),
];

impl PluginConfig {
    /// `DEFAULT_PLUGIN_CONFIG` — the fully-resolved defaults table from
    /// `lib/config.ts` with every field present. NOTE
    /// `pidOffsetEnabled: true` here vs the getter-level inline default of
    /// false (spec 01 gotcha §11.3) — the split is deliberate and lives in
    /// the config crate's getter.
    pub fn default_resolved() -> Self {
        Self {
            codex_mode: Some(true),
            codex_runtime_rotation_proxy: Some(true),
            codex_tui_v2: Some(true),
            codex_tui_color_profile: Some(CodexTuiColorProfile::Truecolor),
            codex_tui_glyph_mode: Some(CodexTuiGlyphMode::Ascii),
            fast_session: Some(false),
            fast_session_strategy: Some(FastSessionStrategy::Hybrid),
            fast_session_max_input_items: Some(30.0),
            retry_all_accounts_rate_limited: Some(false),
            retry_all_accounts_max_wait_ms: Some(0.0),
            retry_all_accounts_max_retries: Some(0.0),
            unsupported_codex_policy: Some(UnsupportedCodexPolicy::Strict),
            fallback_on_unsupported_codex_model: Some(false),
            fallback_to_gpt52_on_unsupported_gpt53: Some(true),
            unsupported_codex_fallback_chain: Some(FallbackChain::new()),
            token_refresh_skew_ms: Some(60_000.0),
            rate_limit_toast_debounce_ms: Some(60_000.0),
            toast_duration_ms: Some(5_000.0),
            per_project_accounts: Some(true),
            session_recovery: Some(true),
            auto_resume: Some(true),
            parallel_probing: Some(false),
            parallel_probing_max_concurrency: Some(2.0),
            empty_response_max_retries: Some(2.0),
            empty_response_retry_delay_ms: Some(1_000.0),
            rate_limit_dedup_window_ms: Some(2_000.0),
            rate_limit_state_reset_ms: Some(120_000.0),
            rate_limit_max_backoff_ms: Some(60_000.0),
            rate_limit_short_retry_threshold_ms: Some(5_000.0),
            // Default-on so parallel wrapper processes each bias toward a
            // different account (#628); the getter-level false is the config
            // crate's business.
            pid_offset_enabled: Some(true),
            fetch_timeout_ms: Some(60_000.0),
            stream_stall_timeout_ms: Some(45_000.0),
            live_account_sync: Some(true),
            live_account_sync_debounce_ms: Some(250.0),
            live_account_sync_poll_ms: Some(2_000.0),
            session_affinity: Some(true),
            session_affinity_ttl_ms: Some(1_200_000.0),
            session_affinity_max_entries: Some(512.0),
            response_continuation: Some(false),
            background_responses: Some(false),
            proactive_refresh_guardian: Some(true),
            proactive_refresh_interval_ms: Some(60_000.0),
            proactive_refresh_buffer_ms: Some(300_000.0),
            network_error_cooldown_ms: Some(6_000.0),
            server_error_cooldown_ms: Some(4_000.0),
            token_invalidation_cooldown_ms: Some(300_000.0),
            min_rotation_interval_ms: Some(60_000.0),
            storage_backup_enabled: Some(true),
            preemptive_quota_enabled: Some(true),
            preemptive_quota_remaining_percent_5h: Some(5.0),
            preemptive_quota_remaining_percent_7d: Some(5.0),
            preemptive_quota_max_deferral_ms: Some(7_200_000.0),
            routing_mutex: Some(RoutingMutexMode::Legacy),
            scheduling_strategy: Some(SchedulingStrategy::Hybrid),
        }
    }

    /// JS spread semantics `{...base, ...patch}`: every `Some` field of
    /// `patch` overrides `base`. Used by the config crate's
    /// `loadPluginConfig` merge (`{...DEFAULT_PLUGIN_CONFIG, ...sanitized}`).
    pub fn overlay(base: &Self, patch: &Self) -> Self {
        macro_rules! pick {
            ($field:ident) => {
                patch.$field.clone().or_else(|| base.$field.clone())
            };
        }
        Self {
            codex_mode: pick!(codex_mode),
            codex_runtime_rotation_proxy: pick!(codex_runtime_rotation_proxy),
            codex_tui_v2: pick!(codex_tui_v2),
            codex_tui_color_profile: pick!(codex_tui_color_profile),
            codex_tui_glyph_mode: pick!(codex_tui_glyph_mode),
            fast_session: pick!(fast_session),
            fast_session_strategy: pick!(fast_session_strategy),
            fast_session_max_input_items: pick!(fast_session_max_input_items),
            retry_all_accounts_rate_limited: pick!(retry_all_accounts_rate_limited),
            retry_all_accounts_max_wait_ms: pick!(retry_all_accounts_max_wait_ms),
            retry_all_accounts_max_retries: pick!(retry_all_accounts_max_retries),
            unsupported_codex_policy: pick!(unsupported_codex_policy),
            fallback_on_unsupported_codex_model: pick!(fallback_on_unsupported_codex_model),
            fallback_to_gpt52_on_unsupported_gpt53: pick!(fallback_to_gpt52_on_unsupported_gpt53),
            unsupported_codex_fallback_chain: pick!(unsupported_codex_fallback_chain),
            token_refresh_skew_ms: pick!(token_refresh_skew_ms),
            rate_limit_toast_debounce_ms: pick!(rate_limit_toast_debounce_ms),
            toast_duration_ms: pick!(toast_duration_ms),
            per_project_accounts: pick!(per_project_accounts),
            session_recovery: pick!(session_recovery),
            auto_resume: pick!(auto_resume),
            parallel_probing: pick!(parallel_probing),
            parallel_probing_max_concurrency: pick!(parallel_probing_max_concurrency),
            empty_response_max_retries: pick!(empty_response_max_retries),
            empty_response_retry_delay_ms: pick!(empty_response_retry_delay_ms),
            rate_limit_dedup_window_ms: pick!(rate_limit_dedup_window_ms),
            rate_limit_state_reset_ms: pick!(rate_limit_state_reset_ms),
            rate_limit_max_backoff_ms: pick!(rate_limit_max_backoff_ms),
            rate_limit_short_retry_threshold_ms: pick!(rate_limit_short_retry_threshold_ms),
            pid_offset_enabled: pick!(pid_offset_enabled),
            fetch_timeout_ms: pick!(fetch_timeout_ms),
            stream_stall_timeout_ms: pick!(stream_stall_timeout_ms),
            live_account_sync: pick!(live_account_sync),
            live_account_sync_debounce_ms: pick!(live_account_sync_debounce_ms),
            live_account_sync_poll_ms: pick!(live_account_sync_poll_ms),
            session_affinity: pick!(session_affinity),
            session_affinity_ttl_ms: pick!(session_affinity_ttl_ms),
            session_affinity_max_entries: pick!(session_affinity_max_entries),
            response_continuation: pick!(response_continuation),
            background_responses: pick!(background_responses),
            proactive_refresh_guardian: pick!(proactive_refresh_guardian),
            proactive_refresh_interval_ms: pick!(proactive_refresh_interval_ms),
            proactive_refresh_buffer_ms: pick!(proactive_refresh_buffer_ms),
            network_error_cooldown_ms: pick!(network_error_cooldown_ms),
            server_error_cooldown_ms: pick!(server_error_cooldown_ms),
            token_invalidation_cooldown_ms: pick!(token_invalidation_cooldown_ms),
            min_rotation_interval_ms: pick!(min_rotation_interval_ms),
            storage_backup_enabled: pick!(storage_backup_enabled),
            preemptive_quota_enabled: pick!(preemptive_quota_enabled),
            preemptive_quota_remaining_percent_5h: pick!(preemptive_quota_remaining_percent_5h),
            preemptive_quota_remaining_percent_7d: pick!(preemptive_quota_remaining_percent_7d),
            preemptive_quota_max_deferral_ms: pick!(preemptive_quota_max_deferral_ms),
            routing_mutex: pick!(routing_mutex),
            scheduling_strategy: pick!(scheduling_strategy),
        }
    }

    /// Assign an already-validated field value ([`field_issues`] returned
    /// empty for it). Unknown keys are ignored.
    fn apply_validated(&mut self, key: &str, value: &Value) {
        let as_bool = || value.as_bool().unwrap_or_default();
        let as_num = || value.as_f64().unwrap_or_default();
        match key {
            "codexMode" => self.codex_mode = Some(as_bool()),
            "codexRuntimeRotationProxy" => self.codex_runtime_rotation_proxy = Some(as_bool()),
            "codexTuiV2" => self.codex_tui_v2 = Some(as_bool()),
            "codexTuiColorProfile" => {
                self.codex_tui_color_profile =
                    value.as_str().and_then(CodexTuiColorProfile::parse);
            }
            "codexTuiGlyphMode" => {
                self.codex_tui_glyph_mode = value.as_str().and_then(CodexTuiGlyphMode::parse);
            }
            "fastSession" => self.fast_session = Some(as_bool()),
            "fastSessionStrategy" => {
                self.fast_session_strategy = value.as_str().and_then(FastSessionStrategy::parse);
            }
            "fastSessionMaxInputItems" => self.fast_session_max_input_items = Some(as_num()),
            "retryAllAccountsRateLimited" => {
                self.retry_all_accounts_rate_limited = Some(as_bool());
            }
            "retryAllAccountsMaxWaitMs" => self.retry_all_accounts_max_wait_ms = Some(as_num()),
            "retryAllAccountsMaxRetries" => self.retry_all_accounts_max_retries = Some(as_num()),
            "unsupportedCodexPolicy" => {
                self.unsupported_codex_policy =
                    value.as_str().and_then(UnsupportedCodexPolicy::parse);
            }
            "fallbackOnUnsupportedCodexModel" => {
                self.fallback_on_unsupported_codex_model = Some(as_bool());
            }
            "fallbackToGpt52OnUnsupportedGpt53" => {
                self.fallback_to_gpt52_on_unsupported_gpt53 = Some(as_bool());
            }
            "unsupportedCodexFallbackChain" => {
                self.unsupported_codex_fallback_chain = FallbackChain::from_value(value);
            }
            "tokenRefreshSkewMs" => self.token_refresh_skew_ms = Some(as_num()),
            "rateLimitToastDebounceMs" => self.rate_limit_toast_debounce_ms = Some(as_num()),
            "toastDurationMs" => self.toast_duration_ms = Some(as_num()),
            "perProjectAccounts" => self.per_project_accounts = Some(as_bool()),
            "sessionRecovery" => self.session_recovery = Some(as_bool()),
            "autoResume" => self.auto_resume = Some(as_bool()),
            "parallelProbing" => self.parallel_probing = Some(as_bool()),
            "parallelProbingMaxConcurrency" => {
                self.parallel_probing_max_concurrency = Some(as_num());
            }
            "emptyResponseMaxRetries" => self.empty_response_max_retries = Some(as_num()),
            "emptyResponseRetryDelayMs" => self.empty_response_retry_delay_ms = Some(as_num()),
            "rateLimitDedupWindowMs" => self.rate_limit_dedup_window_ms = Some(as_num()),
            "rateLimitStateResetMs" => self.rate_limit_state_reset_ms = Some(as_num()),
            "rateLimitMaxBackoffMs" => self.rate_limit_max_backoff_ms = Some(as_num()),
            "rateLimitShortRetryThresholdMs" => {
                self.rate_limit_short_retry_threshold_ms = Some(as_num());
            }
            "pidOffsetEnabled" => self.pid_offset_enabled = Some(as_bool()),
            "fetchTimeoutMs" => self.fetch_timeout_ms = Some(as_num()),
            "streamStallTimeoutMs" => self.stream_stall_timeout_ms = Some(as_num()),
            "liveAccountSync" => self.live_account_sync = Some(as_bool()),
            "liveAccountSyncDebounceMs" => self.live_account_sync_debounce_ms = Some(as_num()),
            "liveAccountSyncPollMs" => self.live_account_sync_poll_ms = Some(as_num()),
            "sessionAffinity" => self.session_affinity = Some(as_bool()),
            "sessionAffinityTtlMs" => self.session_affinity_ttl_ms = Some(as_num()),
            "sessionAffinityMaxEntries" => self.session_affinity_max_entries = Some(as_num()),
            "responseContinuation" => self.response_continuation = Some(as_bool()),
            "backgroundResponses" => self.background_responses = Some(as_bool()),
            "proactiveRefreshGuardian" => self.proactive_refresh_guardian = Some(as_bool()),
            "proactiveRefreshIntervalMs" => self.proactive_refresh_interval_ms = Some(as_num()),
            "proactiveRefreshBufferMs" => self.proactive_refresh_buffer_ms = Some(as_num()),
            "networkErrorCooldownMs" => self.network_error_cooldown_ms = Some(as_num()),
            "serverErrorCooldownMs" => self.server_error_cooldown_ms = Some(as_num()),
            "tokenInvalidationCooldownMs" => {
                self.token_invalidation_cooldown_ms = Some(as_num());
            }
            "minRotationIntervalMs" => self.min_rotation_interval_ms = Some(as_num()),
            "storageBackupEnabled" => self.storage_backup_enabled = Some(as_bool()),
            "preemptiveQuotaEnabled" => self.preemptive_quota_enabled = Some(as_bool()),
            "preemptiveQuotaRemainingPercent5h" => {
                self.preemptive_quota_remaining_percent_5h = Some(as_num());
            }
            "preemptiveQuotaRemainingPercent7d" => {
                self.preemptive_quota_remaining_percent_7d = Some(as_num());
            }
            "preemptiveQuotaMaxDeferralMs" => {
                self.preemptive_quota_max_deferral_ms = Some(as_num());
            }
            "routingMutex" => {
                self.routing_mutex = value.as_str().and_then(RoutingMutexMode::parse);
            }
            "schedulingStrategy" => {
                self.scheduling_strategy = value.as_str().and_then(SchedulingStrategy::parse);
            }
            _ => {}
        }
    }
}

impl<'de> Deserialize<'de> for PluginConfig {
    /// Whole-schema `safeParse` semantics: non-object input fails; unknown
    /// keys are stripped; ANY invalid known field fails the whole parse with
    /// the first issue's message.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let Some(map) = value.as_object() else {
            return Err(serde::de::Error::custom(format!(
                "Invalid input: expected object, received {}",
                json_type_name(&value)
            )));
        };
        let mut config = PluginConfig::default();
        for (key, _) in FIELDS.iter() {
            let Some(field_value) = map.get(*key) else {
                continue;
            };
            let issues = field_issues(key, field_value);
            if let Some(first) = issues.first() {
                return Err(serde::de::Error::custom(first.format()));
            }
            config.apply_validated(key, field_value);
        }
        Ok(config)
    }
}

// ============================================================================
// Tests (ported from test/schemas.test.ts PluginConfigSchema suite)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> Result<PluginConfig, serde_json::Error> {
        serde_json::from_value(value)
    }

    #[test]
    fn accepts_empty_object_all_optional() {
        let config = parse(json!({})).expect("empty object parses");
        assert_eq!(config, PluginConfig::default());
    }

    #[test]
    fn accepts_valid_full_config() {
        let config = parse(json!({
            "codexMode": true,
            "codexRuntimeRotationProxy": true,
            "fastSession": true,
            "retryAllAccountsRateLimited": true,
            "retryAllAccountsMaxWaitMs": 5000,
            "retryAllAccountsMaxRetries": 3,
            "unsupportedCodexPolicy": "strict",
            "fallbackOnUnsupportedCodexModel": true,
            "fallbackToGpt52OnUnsupportedGpt53": false,
            "unsupportedCodexFallbackChain": {
                "gpt-5.3-codex-spark": ["gpt-5.3-codex", "gpt-5.2-codex"],
            },
            "tokenRefreshSkewMs": 60000,
            "rateLimitToastDebounceMs": 30000,
            "toastDurationMs": 5000,
            "perProjectAccounts": true,
            "sessionRecovery": true,
            "autoResume": false,
            "rateLimitDedupWindowMs": 2000,
            "rateLimitStateResetMs": 120000,
            "rateLimitMaxBackoffMs": 60000,
            "rateLimitShortRetryThresholdMs": 5000,
            "fetchTimeoutMs": 60000,
            "streamStallTimeoutMs": 45000,
            "liveAccountSync": true,
            "liveAccountSyncDebounceMs": 250,
            "liveAccountSyncPollMs": 2000,
            "sessionAffinity": true,
            "sessionAffinityTtlMs": 1200000,
            "sessionAffinityMaxEntries": 512,
            "proactiveRefreshGuardian": true,
            "proactiveRefreshIntervalMs": 60000,
            "proactiveRefreshBufferMs": 300000,
            "networkErrorCooldownMs": 6000,
            "serverErrorCooldownMs": 4000,
            "preemptiveQuotaEnabled": true,
            "preemptiveQuotaRemainingPercent5h": 5,
            "preemptiveQuotaRemainingPercent7d": 5,
            "preemptiveQuotaMaxDeferralMs": 120000,
        }))
        .expect("full config parses");
        assert_eq!(config.auto_resume, Some(false));
        assert_eq!(
            config.unsupported_codex_policy,
            Some(UnsupportedCodexPolicy::Strict)
        );
        let chain = config.unsupported_codex_fallback_chain.expect("chain kept");
        assert_eq!(
            chain.get("gpt-5.3-codex-spark"),
            Some(&["gpt-5.3-codex".to_string(), "gpt-5.2-codex".to_string()][..])
        );
    }

    #[test]
    fn enforces_minimums() {
        let cases: &[(&str, f64, f64)] = &[
            ("rateLimitStateResetMs", 999.0, 1000.0),
            ("rateLimitMaxBackoffMs", 999.0, 1000.0),
            ("liveAccountSyncDebounceMs", 49.0, 50.0),
            ("liveAccountSyncPollMs", 499.0, 500.0),
            ("sessionAffinityTtlMs", 999.0, 1000.0),
            ("sessionAffinityMaxEntries", 7.0, 8.0),
            ("proactiveRefreshIntervalMs", 4999.0, 5000.0),
            ("proactiveRefreshBufferMs", 29999.0, 30000.0),
            ("preemptiveQuotaMaxDeferralMs", 999.0, 1000.0),
        ];
        for (key, invalid, valid) in cases {
            assert!(
                parse(json!({ *key: invalid })).is_err(),
                "{key}={invalid} should fail"
            );
            assert!(
                parse(json!({ *key: valid })).is_ok(),
                "{key}={valid} should pass"
            );
            assert!(validate_field(key, &json!(invalid)).is_none());
            assert!(validate_field(key, &json!(valid)).is_some());
        }
    }

    #[test]
    fn allows_zero_and_rejects_negatives() {
        for key in [
            "rateLimitDedupWindowMs",
            "rateLimitShortRetryThresholdMs",
            "networkErrorCooldownMs",
            "serverErrorCooldownMs",
            "tokenInvalidationCooldownMs",
            "minRotationIntervalMs",
        ] {
            assert!(parse(json!({ key: -1 })).is_err(), "{key}=-1 should fail");
            assert!(parse(json!({ key: 0 })).is_ok(), "{key}=0 should pass");
        }
    }

    #[test]
    fn enforces_0_to_100_range() {
        for key in [
            "preemptiveQuotaRemainingPercent5h",
            "preemptiveQuotaRemainingPercent7d",
        ] {
            assert!(parse(json!({ key: -1 })).is_err());
            assert!(parse(json!({ key: 0 })).is_ok());
            assert!(parse(json!({ key: 100 })).is_ok());
            assert!(parse(json!({ key: 101 })).is_err());
        }
    }

    #[test]
    fn rejects_string_values_for_numeric_keys() {
        for key in [
            "liveAccountSyncDebounceMs",
            "liveAccountSyncPollMs",
            "sessionAffinityTtlMs",
            "sessionAffinityMaxEntries",
            "proactiveRefreshIntervalMs",
            "proactiveRefreshBufferMs",
            "rateLimitDedupWindowMs",
            "rateLimitStateResetMs",
            "rateLimitMaxBackoffMs",
            "rateLimitShortRetryThresholdMs",
            "networkErrorCooldownMs",
            "serverErrorCooldownMs",
            "tokenInvalidationCooldownMs",
            "minRotationIntervalMs",
            "preemptiveQuotaRemainingPercent5h",
            "preemptiveQuotaRemainingPercent7d",
            "preemptiveQuotaMaxDeferralMs",
        ] {
            assert!(
                parse(json!({ key: "123" })).is_err(),
                "{key}=\"123\" should fail"
            );
        }
    }

    #[test]
    fn rejects_toast_duration_below_1000() {
        assert!(parse(json!({ "toastDurationMs": 500 })).is_err());
    }

    #[test]
    fn rejects_negative_numbers_for_numeric_fields() {
        assert!(parse(json!({ "retryAllAccountsMaxWaitMs": -100 })).is_err());
    }

    #[test]
    fn rejects_timeout_settings_below_1000ms() {
        assert!(parse(json!({ "fetchTimeoutMs": 999 })).is_err());
        assert!(parse(json!({ "streamStallTimeoutMs": 999 })).is_err());
    }

    #[test]
    fn rejects_wrong_types() {
        assert!(parse(json!({ "codexMode": "yes" })).is_err());
    }

    #[test]
    fn rejects_invalid_unsupported_codex_policy() {
        assert!(parse(json!({ "unsupportedCodexPolicy": "invalid" })).is_err());
    }

    #[test]
    fn strips_unknown_keys_instead_of_failing() {
        let config = parse(json!({ "someFutureKey": {"x": 1}, "codexMode": true }))
            .expect("unknown keys stripped");
        assert_eq!(config.codex_mode, Some(true));
    }

    #[test]
    fn fallback_chain_validation() {
        assert!(parse(json!({ "unsupportedCodexFallbackChain": { "a": ["b"] } })).is_ok());
        assert!(parse(json!({ "unsupportedCodexFallbackChain": { "a": "b" } })).is_err());
        assert!(parse(json!({ "unsupportedCodexFallbackChain": { "a": [""] } })).is_err());
        assert!(parse(json!({ "unsupportedCodexFallbackChain": ["a"] })).is_err());
    }

    #[test]
    fn default_resolved_matches_default_plugin_config_table() {
        let defaults = PluginConfig::default_resolved();
        assert_eq!(defaults.codex_mode, Some(true));
        assert_eq!(
            defaults.codex_tui_color_profile,
            Some(CodexTuiColorProfile::Truecolor)
        );
        assert_eq!(defaults.codex_tui_glyph_mode, Some(CodexTuiGlyphMode::Ascii));
        assert_eq!(defaults.fast_session, Some(false));
        assert_eq!(defaults.fast_session_max_input_items, Some(30.0));
        assert_eq!(
            defaults.unsupported_codex_policy,
            Some(UnsupportedCodexPolicy::Strict)
        );
        assert_eq!(
            defaults.unsupported_codex_fallback_chain,
            Some(FallbackChain::new())
        );
        assert_eq!(defaults.toast_duration_ms, Some(5000.0));
        // The DEFAULTS-vs-getter split (spec 01 gotcha §11.3): true HERE.
        assert_eq!(defaults.pid_offset_enabled, Some(true));
        assert_eq!(defaults.session_affinity_ttl_ms, Some(1_200_000.0));
        assert_eq!(defaults.token_invalidation_cooldown_ms, Some(300_000.0));
        assert_eq!(defaults.preemptive_quota_max_deferral_ms, Some(7_200_000.0));
        assert_eq!(defaults.routing_mutex, Some(RoutingMutexMode::Legacy));
        assert_eq!(defaults.scheduling_strategy, Some(SchedulingStrategy::Hybrid));
        // Every field is populated in the resolved defaults.
        let serialized = serde_json::to_value(&defaults).unwrap();
        assert_eq!(
            serialized.as_object().unwrap().len(),
            PLUGIN_CONFIG_KEYS.len()
        );
    }

    #[test]
    fn serializes_numbers_without_decimal_point() {
        let defaults = PluginConfig::default_resolved();
        let raw = serde_json::to_string(&defaults).unwrap();
        assert!(raw.contains("\"toastDurationMs\":5000"), "raw: {raw}");
        assert!(raw.contains("\"fastSessionMaxInputItems\":30"), "raw: {raw}");
        assert!(!raw.contains(".0"), "no float artifacts: {raw}");
        // Empty patch serializes to an empty object.
        assert_eq!(serde_json::to_string(&PluginConfig::default()).unwrap(), "{}");
    }

    #[test]
    fn round_trips_through_serialization() {
        let defaults = PluginConfig::default_resolved();
        let raw = serde_json::to_string(&defaults).unwrap();
        let parsed: PluginConfig = serde_json::from_str(&raw).expect("round-trip parses");
        assert_eq!(parsed, defaults);
    }

    #[test]
    fn validate_field_returns_clone_for_valid_and_none_for_invalid_or_unknown() {
        assert_eq!(
            validate_field("codexMode", &json!(true)),
            Some(json!(true))
        );
        assert_eq!(validate_field("codexMode", &json!("yes")), None);
        assert_eq!(validate_field("notAField", &json!(true)), None);
        assert_eq!(
            validate_field("fastSessionMaxInputItems", &json!(30)),
            Some(json!(30))
        );
        assert_eq!(validate_field("fastSessionMaxInputItems", &json!(7)), None);
        assert_eq!(validate_field("fastSessionMaxInputItems", &json!(201)), None);
        assert_eq!(
            validate_field("codexTuiColorProfile", &json!("ansi16")),
            Some(json!("ansi16"))
        );
        assert_eq!(validate_field("codexTuiColorProfile", &json!("bogus")), None);
        // Null is invalid for optional fields (zod optional ≠ nullable).
        assert_eq!(validate_field("codexMode", &Value::Null), None);
    }

    #[test]
    fn is_known_plugin_config_key_distinguishes_unknown_keys() {
        assert!(is_known_plugin_config_key("codexMode"));
        assert!(is_known_plugin_config_key("schedulingStrategy"));
        assert!(!is_known_plugin_config_key("somethingElse"));
        assert_eq!(PLUGIN_CONFIG_KEYS.len(), 54);
        assert_eq!(PLUGIN_CONFIG_KEYS[0], "codexMode");
        assert_eq!(PLUGIN_CONFIG_KEYS[53], "schedulingStrategy");
    }

    #[test]
    fn plugin_config_issues_reports_paths_and_root_failures() {
        let issues = plugin_config_issues(&json!({ "codexMode": "yes" }));
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path, vec!["codexMode".to_string()]);
        assert!(issues[0].message.contains("expected boolean"));

        let root = plugin_config_issues(&json!("not-an-object"));
        assert_eq!(root.len(), 1);
        assert!(root[0].path.is_empty());
        assert_eq!(
            root[0].message,
            "Invalid input: expected object, received string"
        );

        assert!(plugin_config_issues(&json!({ "codexMode": true })).is_empty());
    }

    #[test]
    fn overlay_applies_js_spread_semantics() {
        let base = PluginConfig::default_resolved();
        let patch = PluginConfig {
            codex_mode: Some(false),
            toast_duration_ms: Some(9000.0),
            ..PluginConfig::default()
        };
        let merged = PluginConfig::overlay(&base, &patch);
        assert_eq!(merged.codex_mode, Some(false));
        assert_eq!(merged.toast_duration_ms, Some(9000.0));
        // Untouched fields keep base values.
        assert_eq!(merged.pid_offset_enabled, Some(true));
        assert_eq!(merged.routing_mutex, Some(RoutingMutexMode::Legacy));
    }

    #[test]
    fn enum_parse_helpers() {
        assert_eq!(
            CodexTuiColorProfile::parse("truecolor"),
            Some(CodexTuiColorProfile::Truecolor)
        );
        assert_eq!(CodexTuiColorProfile::parse("TRUECOLOR"), None);
        assert_eq!(
            FastSessionStrategy::parse("always"),
            Some(FastSessionStrategy::Always)
        );
        assert_eq!(
            RoutingMutexMode::parse("enabled"),
            Some(RoutingMutexMode::Enabled)
        );
        assert_eq!(
            SchedulingStrategy::parse("sequential"),
            Some(SchedulingStrategy::Sequential)
        );
        assert_eq!(UnsupportedCodexPolicy::Fallback.as_str(), "fallback");
        assert_eq!(CodexTuiGlyphMode::Auto.to_string(), "auto");
    }
}
