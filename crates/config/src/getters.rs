//! Port of the ~54 typed getters of `lib/config.ts` (spec 01 §5.4 table).
//!
//! Resolution: env override (when valid) → config value → default, then
//! clamp — clamping applies to env AND config values. Boolean env parsing via
//! `parse_boolean_env`; numeric env parsing follows JS `Number()` semantics
//! (hex/octal/binary literals, exponents, trimming); string envs are
//! trim+lowercase and must be in the allowed set. A set, non-empty,
//! unparseable boolean/number env emits a warn-once and is ignored.
//!
//! Gotchas reproduced deliberately:
//! - `get_pid_offset_enabled` inline default **false** vs
//!   `DEFAULT_PLUGIN_CONFIG.pidOffsetEnabled = true` (spec 01 gotcha 3 — do
//!   NOT unify).
//! - `get_fast_session_strategy` has bespoke resolution (gotcha 24).
//! - `get_unsupported_codex_fallback_chain` normalization does NOT strip
//!   `-max`/`-ultra` suffixes (gotcha 8).
//!
//! The explain report (`explain.rs`) re-runs getters with specific env names
//! disabled through a thread-local — behavior-equivalent to the TS
//! delete-and-restore of `process.env` (gotcha 13), without mutating the
//! process environment.

use std::cell::RefCell;

use cma_core::env_parsing::parse_boolean_env;
use cma_core::schemas::plugin_config::{
    CodexTuiColorProfile, CodexTuiGlyphMode, FallbackChain, FastSessionStrategy, PluginConfig,
    RoutingMutexMode, SchedulingStrategy, UnsupportedCodexPolicy,
};

use crate::load::log_config_warn_once;

// ---------------------------------------------------------------------------
// Env access (with the explain "env disabled" seam)
// ---------------------------------------------------------------------------

thread_local! {
    /// Env names currently hidden from the getters (explain source-detection
    /// re-run). Stack-of-slices semantics via simple Vec push/truncate.
    static EXPLAIN_DISABLED_ENV: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Run `f` with the given env names invisible to the getters on THIS thread
/// (`withExplainEnvUnset` — behavior-equivalent, no real env mutation).
pub(crate) fn with_env_names_disabled<T>(env_names: &[&str], f: impl FnOnce() -> T) -> T {
    if env_names.is_empty() {
        return f();
    }
    let added = EXPLAIN_DISABLED_ENV.with(|cell| {
        let mut disabled = cell.borrow_mut();
        let before = disabled.len();
        disabled.extend(env_names.iter().map(|s| s.to_string()));
        before
    });
    struct Restore(usize);
    impl Drop for Restore {
        fn drop(&mut self) {
            EXPLAIN_DISABLED_ENV.with(|cell| cell.borrow_mut().truncate(self.0));
        }
    }
    let _restore = Restore(added);
    f()
}

/// `process.env[name]` as seen by the getters (respecting the explain
/// disable list).
fn env_var(name: &str) -> Option<String> {
    let hidden = EXPLAIN_DISABLED_ENV.with(|cell| cell.borrow().iter().any(|n| n == name));
    if hidden {
        return None;
    }
    std::env::var(name).ok()
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/// JS `Number(trimmed)` for a non-empty trimmed string; `None` when the
/// result is not a finite number (NaN/Infinity are ignored like the TS
/// `parseNumberEnv`).
fn parse_js_number(trimmed: &str) -> Option<f64> {
    fn radix_value(digits: &str, radix: u32) -> Option<f64> {
        if digits.is_empty() {
            return None;
        }
        let mut acc = 0f64;
        for c in digits.chars() {
            let digit = c.to_digit(radix)?;
            acc = acc * radix as f64 + digit as f64;
        }
        Some(acc)
    }
    let lower = trimmed;
    let parsed = if let Some(rest) = lower.strip_prefix("0x").or_else(|| lower.strip_prefix("0X")) {
        radix_value(rest, 16)
    } else if let Some(rest) = lower.strip_prefix("0o").or_else(|| lower.strip_prefix("0O")) {
        radix_value(rest, 8)
    } else if let Some(rest) = lower.strip_prefix("0b").or_else(|| lower.strip_prefix("0B")) {
        radix_value(rest, 2)
    } else {
        trimmed.parse::<f64>().ok()
    };
    parsed.filter(|value| value.is_finite())
}

fn parse_number_env(value: Option<&str>) -> Option<f64> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    parse_js_number(trimmed)
}

fn parse_string_env(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim().to_lowercase();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

/// `resolveBooleanSetting` — env valid → env; else config → default. A set,
/// non-empty, unparseable env warns once and is ignored.
fn resolve_boolean_setting(env_name: &str, config_value: Option<bool>, default_value: bool) -> bool {
    let raw_env_value = env_var(env_name);
    let env_value = parse_boolean_env(raw_env_value.as_deref());
    if let Some(raw) = &raw_env_value
        && !raw.trim().is_empty()
        && env_value.is_none()
    {
        log_config_warn_once(&format!(
            "Ignoring invalid boolean env {env_name}. Expected 0/1, true/false, or yes/no."
        ));
    }
    env_value.unwrap_or_else(|| config_value.unwrap_or(default_value))
}

/// `resolveNumberSetting` — env valid → env; else config → default; result
/// clamped into `[min, max]` (defaults ±∞); clamping applies to env AND
/// config values.
fn resolve_number_setting(
    env_name: &str,
    config_value: Option<f64>,
    default_value: f64,
    min: Option<f64>,
    max: Option<f64>,
) -> f64 {
    let raw_env_value = env_var(env_name);
    let env_value = parse_number_env(raw_env_value.as_deref());
    if let Some(raw) = &raw_env_value
        && !raw.trim().is_empty()
        && env_value.is_none()
    {
        log_config_warn_once(&format!(
            "Ignoring invalid numeric env {env_name}. Expected a finite number."
        ));
    }
    let candidate = env_value.or(config_value).unwrap_or(default_value);
    let min = min.unwrap_or(f64::NEG_INFINITY);
    let max = max.unwrap_or(f64::INFINITY);
    min.max(max.min(candidate))
}

/// `resolveStringSetting` — env (trim+lowercase, must parse into the allowed
/// set) → config → default. Invalid values fall through silently.
fn resolve_string_setting<T: Copy>(
    env_name: &str,
    config_value: Option<T>,
    default_value: T,
    parse: fn(&str) -> Option<T>,
) -> T {
    if let Some(env_value) = parse_string_env(env_var(env_name).as_deref())
        && let Some(valid) = parse(&env_value)
    {
        return valid;
    }
    config_value.unwrap_or(default_value)
}

// ---------------------------------------------------------------------------
// Getters (spec 01 §5.4 — exact env names, defaults, clamps)
// ---------------------------------------------------------------------------

pub fn get_codex_mode(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting("CODEX_MODE", plugin_config.codex_mode, true)
}

pub fn get_codex_runtime_rotation_proxy(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY",
        plugin_config.codex_runtime_rotation_proxy,
        true,
    )
}

pub fn get_codex_tui_v2(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting("CODEX_TUI_V2", plugin_config.codex_tui_v2, true)
}

pub fn get_codex_tui_color_profile(plugin_config: &PluginConfig) -> CodexTuiColorProfile {
    resolve_string_setting(
        "CODEX_TUI_COLOR_PROFILE",
        plugin_config.codex_tui_color_profile,
        CodexTuiColorProfile::Truecolor,
        CodexTuiColorProfile::parse,
    )
}

pub fn get_codex_tui_glyph_mode(plugin_config: &PluginConfig) -> CodexTuiGlyphMode {
    resolve_string_setting(
        "CODEX_TUI_GLYPHS",
        plugin_config.codex_tui_glyph_mode,
        CodexTuiGlyphMode::Ascii,
        CodexTuiGlyphMode::parse,
    )
}

pub fn get_fast_session(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_FAST_SESSION",
        plugin_config.fast_session,
        false,
    )
}

/// Bespoke resolution (gotcha 24): env exact-match after trim+lowercase;
/// config compared strictly against `"always"`; anything else → `"hybrid"`;
/// no warnings.
pub fn get_fast_session_strategy(plugin_config: &PluginConfig) -> FastSessionStrategy {
    let env = env_var("CODEX_AUTH_FAST_SESSION_STRATEGY")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if env == "always" {
        return FastSessionStrategy::Always;
    }
    if env == "hybrid" {
        return FastSessionStrategy::Hybrid;
    }
    if plugin_config.fast_session_strategy == Some(FastSessionStrategy::Always) {
        FastSessionStrategy::Always
    } else {
        FastSessionStrategy::Hybrid
    }
}

pub fn get_fast_session_max_input_items(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS",
        plugin_config.fast_session_max_input_items,
        30.0,
        Some(8.0),
        None,
    )
}

pub fn get_retry_all_accounts_rate_limited(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
        plugin_config.retry_all_accounts_rate_limited,
        false,
    )
}

pub fn get_retry_all_accounts_max_wait_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
        plugin_config.retry_all_accounts_max_wait_ms,
        0.0,
        Some(0.0),
        None,
    )
}

pub fn get_retry_all_accounts_max_retries(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
        plugin_config.retry_all_accounts_max_retries,
        0.0,
        Some(0.0),
        None,
    )
}

/// Policy resolution ladder: env policy → config policy → legacy bool env
/// (`CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL`, no warning on invalid) → config
/// legacy bool → `"strict"`.
pub fn get_unsupported_codex_policy(plugin_config: &PluginConfig) -> UnsupportedCodexPolicy {
    if let Some(env_policy) =
        parse_string_env(env_var("CODEX_AUTH_UNSUPPORTED_MODEL_POLICY").as_deref())
        && let Some(valid) = UnsupportedCodexPolicy::parse(&env_policy)
    {
        return valid;
    }

    if let Some(config_policy) = plugin_config.unsupported_codex_policy {
        return config_policy;
    }

    let legacy_env_fallback =
        parse_boolean_env(env_var("CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL").as_deref());
    if let Some(fallback) = legacy_env_fallback {
        return if fallback {
            UnsupportedCodexPolicy::Fallback
        } else {
            UnsupportedCodexPolicy::Strict
        };
    }

    if let Some(legacy_config) = plugin_config.fallback_on_unsupported_codex_model {
        return if legacy_config {
            UnsupportedCodexPolicy::Fallback
        } else {
            UnsupportedCodexPolicy::Strict
        };
    }

    UnsupportedCodexPolicy::Strict
}

pub fn get_fallback_on_unsupported_codex_model(plugin_config: &PluginConfig) -> bool {
    get_unsupported_codex_policy(plugin_config) == UnsupportedCodexPolicy::Fallback
}

pub fn get_fallback_to_gpt52_on_unsupported_gpt53(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_FALLBACK_GPT53_TO_GPT52",
        plugin_config.fallback_to_gpt52_on_unsupported_gpt53,
        true,
    )
}

/// Chain normalization (gotcha 8): trim+lowercase, take the substring after
/// the last `/`, strip ONE reasoning-effort suffix
/// `-(none|minimal|low|medium|high|xhigh)` — `-max`/`-ultra` are deliberately
/// NOT stripped. Empty keys/targets dropped; entries with zero surviving
/// targets dropped. Duplicate normalized keys: later entries overwrite the
/// value while the first occurrence keeps its position (JS object semantics).
pub fn get_unsupported_codex_fallback_chain(plugin_config: &PluginConfig) -> FallbackChain {
    fn normalize_model(value: &str) -> String {
        let trimmed = value.trim().to_lowercase();
        if trimmed.is_empty() {
            return String::new();
        }
        let stripped = if trimmed.contains('/') {
            trimmed.rsplit('/').next().unwrap_or(&trimmed).to_string()
        } else {
            trimmed
        };
        for suffix in ["-none", "-minimal", "-low", "-medium", "-high", "-xhigh"] {
            if let Some(base) = stripped.strip_suffix(suffix) {
                return base.to_string();
            }
        }
        stripped
    }

    let Some(chain) = plugin_config.unsupported_codex_fallback_chain.as_ref() else {
        return FallbackChain::new();
    };
    let mut normalized: Vec<(String, Vec<String>)> = Vec::new();
    for (key, targets) in chain.iter() {
        let normalized_key = normalize_model(key);
        if normalized_key.is_empty() {
            continue;
        }
        let normalized_targets: Vec<String> = targets
            .iter()
            .map(|target| normalize_model(target))
            .filter(|target| !target.is_empty())
            .collect();
        if normalized_targets.is_empty() {
            continue;
        }
        if let Some(existing) = normalized
            .iter_mut()
            .find(|(existing_key, _)| *existing_key == normalized_key)
        {
            existing.1 = normalized_targets;
        } else {
            normalized.push((normalized_key, normalized_targets));
        }
    }
    FallbackChain(normalized)
}

pub fn get_token_refresh_skew_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
        plugin_config.token_refresh_skew_ms,
        60_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_rate_limit_toast_debounce_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
        plugin_config.rate_limit_toast_debounce_ms,
        60_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_session_recovery(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_SESSION_RECOVERY",
        plugin_config.session_recovery,
        true,
    )
}

pub fn get_auto_resume(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting("CODEX_AUTH_AUTO_RESUME", plugin_config.auto_resume, true)
}

pub fn get_toast_duration_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_TOAST_DURATION_MS",
        plugin_config.toast_duration_ms,
        5_000.0,
        Some(1_000.0),
        None,
    )
}

pub fn get_per_project_accounts(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_PER_PROJECT_ACCOUNTS",
        plugin_config.per_project_accounts,
        true,
    )
}

pub fn get_parallel_probing(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_PARALLEL_PROBING",
        plugin_config.parallel_probing,
        false,
    )
}

pub fn get_parallel_probing_max_concurrency(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
        plugin_config.parallel_probing_max_concurrency,
        2.0,
        Some(1.0),
        None,
    )
}

pub fn get_empty_response_max_retries(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
        plugin_config.empty_response_max_retries,
        2.0,
        Some(0.0),
        None,
    )
}

pub fn get_empty_response_retry_delay_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS",
        plugin_config.empty_response_retry_delay_ms,
        1_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_rate_limit_dedup_window_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_RATE_LIMIT_DEDUP_WINDOW_MS",
        plugin_config.rate_limit_dedup_window_ms,
        2_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_rate_limit_state_reset_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_RATE_LIMIT_STATE_RESET_MS",
        plugin_config.rate_limit_state_reset_ms,
        120_000.0,
        Some(1_000.0),
        None,
    )
}

pub fn get_rate_limit_max_backoff_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_RATE_LIMIT_MAX_BACKOFF_MS",
        plugin_config.rate_limit_max_backoff_ms,
        60_000.0,
        Some(1_000.0),
        None,
    )
}

/// Config-crate getter (spec 01 gotcha 20): distinct from the request
/// crate's renamed `configured_rate_limit_short_retry_threshold_ms`.
pub fn get_rate_limit_short_retry_threshold_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS",
        plugin_config.rate_limit_short_retry_threshold_ms,
        5_000.0,
        Some(0.0),
        None,
    )
}

/// Inline default **false** — deliberately different from
/// `DEFAULT_PLUGIN_CONFIG.pidOffsetEnabled = true` (gotcha 3; do NOT "fix").
pub fn get_pid_offset_enabled(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_PID_OFFSET_ENABLED",
        plugin_config.pid_offset_enabled,
        false,
    )
}

pub fn get_fetch_timeout_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_FETCH_TIMEOUT_MS",
        plugin_config.fetch_timeout_ms,
        60_000.0,
        Some(1_000.0),
        None,
    )
}

pub fn get_stream_stall_timeout_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
        plugin_config.stream_stall_timeout_ms,
        45_000.0,
        Some(1_000.0),
        None,
    )
}

pub fn get_live_account_sync(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_LIVE_ACCOUNT_SYNC",
        plugin_config.live_account_sync,
        true,
    )
}

pub fn get_live_account_sync_debounce_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_LIVE_ACCOUNT_SYNC_DEBOUNCE_MS",
        plugin_config.live_account_sync_debounce_ms,
        250.0,
        Some(50.0),
        None,
    )
}

pub fn get_live_account_sync_poll_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_LIVE_ACCOUNT_SYNC_POLL_MS",
        plugin_config.live_account_sync_poll_ms,
        2_000.0,
        Some(500.0),
        None,
    )
}

pub fn get_session_affinity(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_SESSION_AFFINITY",
        plugin_config.session_affinity,
        true,
    )
}

pub fn get_session_affinity_ttl_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_SESSION_AFFINITY_TTL_MS",
        plugin_config.session_affinity_ttl_ms,
        1_200_000.0,
        Some(1_000.0),
        None,
    )
}

pub fn get_session_affinity_max_entries(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_SESSION_AFFINITY_MAX_ENTRIES",
        plugin_config.session_affinity_max_entries,
        512.0,
        Some(8.0),
        None,
    )
}

pub fn get_response_continuation(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_RESPONSE_CONTINUATION",
        plugin_config.response_continuation,
        false,
    )
}

pub fn get_background_responses(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_BACKGROUND_RESPONSES",
        plugin_config.background_responses,
        false,
    )
}

pub fn get_proactive_refresh_guardian(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_PROACTIVE_GUARDIAN",
        plugin_config.proactive_refresh_guardian,
        true,
    )
}

pub fn get_proactive_refresh_interval_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_PROACTIVE_GUARDIAN_INTERVAL_MS",
        plugin_config.proactive_refresh_interval_ms,
        60_000.0,
        Some(5_000.0),
        None,
    )
}

pub fn get_proactive_refresh_buffer_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_PROACTIVE_GUARDIAN_BUFFER_MS",
        plugin_config.proactive_refresh_buffer_ms,
        300_000.0,
        Some(30_000.0),
        None,
    )
}

pub fn get_network_error_cooldown_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_NETWORK_ERROR_COOLDOWN_MS",
        plugin_config.network_error_cooldown_ms,
        6_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_server_error_cooldown_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_SERVER_ERROR_COOLDOWN_MS",
        plugin_config.server_error_cooldown_ms,
        4_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_token_invalidation_cooldown_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_TOKEN_INVALIDATION_COOLDOWN_MS",
        plugin_config.token_invalidation_cooldown_ms,
        300_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_min_rotation_interval_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_MIN_ROTATION_INTERVAL_MS",
        plugin_config.min_rotation_interval_ms,
        60_000.0,
        Some(0.0),
        None,
    )
}

pub fn get_storage_backup_enabled(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_STORAGE_BACKUP_ENABLED",
        plugin_config.storage_backup_enabled,
        true,
    )
}

pub fn get_preemptive_quota_enabled(plugin_config: &PluginConfig) -> bool {
    resolve_boolean_setting(
        "CODEX_AUTH_PREEMPTIVE_QUOTA_ENABLED",
        plugin_config.preemptive_quota_enabled,
        true,
    )
}

pub fn get_preemptive_quota_remaining_percent_5h(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT",
        plugin_config.preemptive_quota_remaining_percent_5h,
        5.0,
        Some(0.0),
        Some(100.0),
    )
}

pub fn get_preemptive_quota_remaining_percent_7d(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT",
        plugin_config.preemptive_quota_remaining_percent_7d,
        5.0,
        Some(0.0),
        Some(100.0),
    )
}

pub fn get_preemptive_quota_max_deferral_ms(plugin_config: &PluginConfig) -> f64 {
    resolve_number_setting(
        "CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS",
        plugin_config.preemptive_quota_max_deferral_ms,
        7_200_000.0,
        Some(1_000.0),
        None,
    )
}

pub fn get_routing_mutex_mode(plugin_config: &PluginConfig) -> RoutingMutexMode {
    resolve_string_setting(
        "CODEX_AUTH_ROUTING_MUTEX",
        plugin_config.routing_mutex,
        RoutingMutexMode::Legacy,
        RoutingMutexMode::parse,
    )
}

pub fn get_scheduling_strategy(plugin_config: &PluginConfig) -> SchedulingStrategy {
    resolve_string_setting(
        "CODEX_AUTH_SCHEDULING_STRATEGY",
        plugin_config.scheduling_strategy,
        SchedulingStrategy::Hybrid,
        SchedulingStrategy::parse,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn defaults() -> PluginConfig {
        PluginConfig::default_resolved()
    }

    fn empty() -> PluginConfig {
        PluginConfig::default()
    }

    #[test]
    #[serial(env)]
    fn boolean_getter_priority_env_over_config_over_default() {
        let mut sandbox = EnvSandbox::new();
        let mut config = empty();
        config.codex_mode = Some(true);

        sandbox.remove_var("CODEX_MODE");
        assert!(get_codex_mode(&empty()), "default true");
        assert!(get_codex_mode(&config));
        config.codex_mode = Some(false);
        assert!(!get_codex_mode(&config), "config value wins over default");

        sandbox.set_var("CODEX_MODE", "1");
        assert!(get_codex_mode(&config), "env 1 beats config false");
        sandbox.set_var("CODEX_MODE", "0");
        config.codex_mode = Some(true);
        assert!(!get_codex_mode(&config), "env 0 beats config true");

        sandbox.set_var("CODEX_MODE", "not-a-bool");
        assert!(get_codex_mode(&config), "invalid env falls back to config");
    }

    #[test]
    #[serial(env)]
    fn pid_offset_split_default_is_reproduced_not_fixed() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("CODEX_AUTH_PID_OFFSET_ENABLED");
        // Getter inline default: FALSE for a partial config…
        assert!(!get_pid_offset_enabled(&empty()));
        // …but the resolved defaults table carries TRUE, so a loaded config
        // yields true.
        assert!(get_pid_offset_enabled(&defaults()));
    }

    #[test]
    #[serial(env)]
    fn number_getters_clamp_env_and_config_values() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("CODEX_AUTH_TOAST_DURATION_MS");
        let mut config = empty();
        // Stored 1500 is schema-valid; env 500 clamps up to min 1000.
        config.toast_duration_ms = Some(1_500.0);
        assert_eq!(get_toast_duration_ms(&config), 1_500.0);
        sandbox.set_var("CODEX_AUTH_TOAST_DURATION_MS", "500");
        assert_eq!(get_toast_duration_ms(&config), 1_000.0);

        // fastSessionMaxInputItems: getter min 8, no getter max.
        sandbox.set_var("CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS", "3");
        assert_eq!(get_fast_session_max_input_items(&empty()), 8.0);
        sandbox.set_var("CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS", "500");
        assert_eq!(get_fast_session_max_input_items(&empty()), 500.0);
    }

    #[test]
    #[serial(env)]
    fn number_env_parsing_follows_js_number_semantics() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("CODEX_AUTH_RETRY_ALL_MAX_RETRIES", "0x10");
        assert_eq!(get_retry_all_accounts_max_retries(&empty()), 16.0);
        sandbox.set_var("CODEX_AUTH_RETRY_ALL_MAX_RETRIES", "1e3");
        assert_eq!(get_retry_all_accounts_max_retries(&empty()), 1_000.0);
        sandbox.set_var("CODEX_AUTH_RETRY_ALL_MAX_RETRIES", "  42  ");
        assert_eq!(get_retry_all_accounts_max_retries(&empty()), 42.0);
        // "42abc" is NaN → ignored (default 0).
        sandbox.set_var("CODEX_AUTH_RETRY_ALL_MAX_RETRIES", "42abc");
        assert_eq!(get_retry_all_accounts_max_retries(&empty()), 0.0);
        // Empty env is ignored without warning.
        sandbox.set_var("CODEX_AUTH_RETRY_ALL_MAX_RETRIES", "   ");
        assert_eq!(get_retry_all_accounts_max_retries(&empty()), 0.0);
    }

    #[test]
    #[serial(env)]
    fn string_getters_validate_env_against_the_allowed_set() {
        let mut sandbox = EnvSandbox::new();
        let mut config = empty();
        config.codex_tui_color_profile = Some(CodexTuiColorProfile::Ansi256);

        sandbox.remove_var("CODEX_TUI_COLOR_PROFILE");
        assert_eq!(
            get_codex_tui_color_profile(&empty()),
            CodexTuiColorProfile::Truecolor
        );
        assert_eq!(
            get_codex_tui_color_profile(&config),
            CodexTuiColorProfile::Ansi256
        );
        sandbox.set_var("CODEX_TUI_COLOR_PROFILE", "ANSI16");
        assert_eq!(
            get_codex_tui_color_profile(&config),
            CodexTuiColorProfile::Ansi16,
            "env is trim+lowercased"
        );
        sandbox.set_var("CODEX_TUI_COLOR_PROFILE", "bogus");
        assert_eq!(
            get_codex_tui_color_profile(&config),
            CodexTuiColorProfile::Ansi256,
            "invalid env falls through to config"
        );
    }

    #[test]
    #[serial(env)]
    fn fast_session_strategy_bespoke_resolution() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("CODEX_AUTH_FAST_SESSION_STRATEGY");
        assert_eq!(get_fast_session_strategy(&empty()), FastSessionStrategy::Hybrid);
        let mut config = empty();
        config.fast_session_strategy = Some(FastSessionStrategy::Always);
        assert_eq!(get_fast_session_strategy(&config), FastSessionStrategy::Always);
        sandbox.set_var("CODEX_AUTH_FAST_SESSION_STRATEGY", " HYBRID ");
        assert_eq!(get_fast_session_strategy(&config), FastSessionStrategy::Hybrid);
        sandbox.set_var("CODEX_AUTH_FAST_SESSION_STRATEGY", "always");
        assert_eq!(get_fast_session_strategy(&empty()), FastSessionStrategy::Always);
        // Unknown env falls through to config comparison.
        sandbox.set_var("CODEX_AUTH_FAST_SESSION_STRATEGY", "sometimes");
        assert_eq!(get_fast_session_strategy(&config), FastSessionStrategy::Always);
    }

    #[test]
    #[serial(env)]
    fn unsupported_policy_ladder() {
        let mut sandbox = EnvSandbox::new();
        for name in [
            "CODEX_AUTH_UNSUPPORTED_MODEL_POLICY",
            "CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL",
        ] {
            sandbox.remove_var(name);
        }
        assert_eq!(
            get_unsupported_codex_policy(&empty()),
            UnsupportedCodexPolicy::Strict
        );
        assert!(!get_fallback_on_unsupported_codex_model(&empty()));

        let mut config = empty();
        config.unsupported_codex_policy = Some(UnsupportedCodexPolicy::Fallback);
        assert_eq!(
            get_unsupported_codex_policy(&config),
            UnsupportedCodexPolicy::Fallback
        );

        // Legacy config bool maps when the policy key is absent.
        let mut legacy = empty();
        legacy.fallback_on_unsupported_codex_model = Some(true);
        assert_eq!(
            get_unsupported_codex_policy(&legacy),
            UnsupportedCodexPolicy::Fallback
        );

        // Legacy env toggle beats the legacy config bool.
        sandbox.set_var("CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL", "0");
        assert_eq!(
            get_unsupported_codex_policy(&legacy),
            UnsupportedCodexPolicy::Strict
        );

        // Policy env overrides everything.
        sandbox.set_var("CODEX_AUTH_UNSUPPORTED_MODEL_POLICY", "fallback");
        assert_eq!(
            get_unsupported_codex_policy(&legacy),
            UnsupportedCodexPolicy::Fallback
        );
        assert!(get_fallback_on_unsupported_codex_model(&legacy));
    }

    #[test]
    fn fallback_chain_normalization() {
        let mut config = empty();
        // Built directly (not via serde) so the getter's tolerance for
        // empty keys/targets — which the schema would reject — is exercised,
        // matching the TS getter operating on arbitrary caller configs.
        let chain = FallbackChain(vec![
            (
                "  OpenAI/GPT-5.3-Codex-High  ".to_string(),
                vec![
                    "provider/GPT-5.2-medium".to_string(),
                    String::new(),
                    "gpt-5.1-xhigh".to_string(),
                ],
            ),
            (
                "gpt-5.3-codex-max".to_string(),
                vec!["gpt-5.2-ultra".to_string()],
            ),
            (String::new(), vec!["x".to_string()]),
            ("empty-targets".to_string(), vec![String::new()]),
        ]);
        config.unsupported_codex_fallback_chain = Some(chain);
        let normalized = get_unsupported_codex_fallback_chain(&config);
        // Effort suffixes stripped; -max/-ultra NOT stripped (gotcha 8);
        // path prefixes removed; empties dropped.
        assert_eq!(
            normalized.get("gpt-5.3-codex"),
            Some(&["gpt-5.2".to_string(), "gpt-5.1".to_string()][..])
        );
        assert_eq!(
            normalized.get("gpt-5.3-codex-max"),
            Some(&["gpt-5.2-ultra".to_string()][..])
        );
        assert_eq!(normalized.len(), 2);

        // Missing chain → empty.
        assert!(get_unsupported_codex_fallback_chain(&empty()).is_empty());
    }

    #[test]
    #[serial(env)]
    fn rate_limit_backoff_settings_defaults_and_env_overrides() {
        let mut sandbox = EnvSandbox::new();
        assert_eq!(get_rate_limit_dedup_window_ms(&empty()), 2_000.0);
        assert_eq!(get_rate_limit_state_reset_ms(&empty()), 120_000.0);
        assert_eq!(get_rate_limit_max_backoff_ms(&empty()), 60_000.0);
        assert_eq!(get_rate_limit_short_retry_threshold_ms(&empty()), 5_000.0);

        sandbox.set_var("CODEX_AUTH_RATE_LIMIT_DEDUP_WINDOW_MS", "1234");
        sandbox.set_var("CODEX_AUTH_RATE_LIMIT_STATE_RESET_MS", "999");
        sandbox.set_var("CODEX_AUTH_RATE_LIMIT_MAX_BACKOFF_MS", "70000");
        sandbox.set_var("CODEX_AUTH_RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS", "-5");
        assert_eq!(get_rate_limit_dedup_window_ms(&empty()), 1_234.0);
        assert_eq!(get_rate_limit_state_reset_ms(&empty()), 1_000.0, "min 1000");
        assert_eq!(get_rate_limit_max_backoff_ms(&empty()), 70_000.0);
        assert_eq!(get_rate_limit_short_retry_threshold_ms(&empty()), 0.0, "min 0");
    }

    #[test]
    #[serial(env)]
    fn preemptive_quota_thresholds() {
        let mut sandbox = EnvSandbox::new();
        assert_eq!(get_preemptive_quota_remaining_percent_5h(&empty()), 5.0);
        assert_eq!(get_preemptive_quota_remaining_percent_7d(&empty()), 5.0);
        assert_eq!(get_preemptive_quota_max_deferral_ms(&empty()), 7_200_000.0);
        sandbox.set_var("CODEX_AUTH_PREEMPTIVE_QUOTA_5H_REMAINING_PCT", "150");
        sandbox.set_var("CODEX_AUTH_PREEMPTIVE_QUOTA_7D_REMAINING_PCT", "-3");
        sandbox.set_var("CODEX_AUTH_PREEMPTIVE_QUOTA_MAX_DEFERRAL_MS", "1");
        assert_eq!(get_preemptive_quota_remaining_percent_5h(&empty()), 100.0);
        assert_eq!(get_preemptive_quota_remaining_percent_7d(&empty()), 0.0);
        assert_eq!(get_preemptive_quota_max_deferral_ms(&empty()), 1_000.0);
    }

    #[test]
    #[serial(env)]
    fn routing_mutex_and_scheduling_strategy() {
        let mut sandbox = EnvSandbox::new();
        assert_eq!(get_routing_mutex_mode(&empty()), RoutingMutexMode::Legacy);
        assert_eq!(get_scheduling_strategy(&empty()), SchedulingStrategy::Hybrid);
        sandbox.set_var("CODEX_AUTH_ROUTING_MUTEX", "enabled");
        sandbox.set_var("CODEX_AUTH_SCHEDULING_STRATEGY", "sequential");
        assert_eq!(get_routing_mutex_mode(&empty()), RoutingMutexMode::Enabled);
        assert_eq!(
            get_scheduling_strategy(&empty()),
            SchedulingStrategy::Sequential
        );
        sandbox.set_var("CODEX_AUTH_SCHEDULING_STRATEGY", "bogus");
        assert_eq!(get_scheduling_strategy(&empty()), SchedulingStrategy::Hybrid);
    }

    #[test]
    #[serial(env)]
    fn env_disabled_seam_hides_only_the_named_vars() {
        let mut sandbox = EnvSandbox::new();
        sandbox.set_var("CODEX_MODE", "0");
        sandbox.set_var("CODEX_TUI_V2", "0");
        assert!(!get_codex_mode(&defaults()));
        let inside = with_env_names_disabled(&["CODEX_MODE"], || {
            (get_codex_mode(&defaults()), get_codex_tui_v2(&defaults()))
        });
        assert_eq!(inside, (true, false), "only CODEX_MODE was hidden");
        // Restored afterwards.
        assert!(!get_codex_mode(&defaults()));
    }
}
