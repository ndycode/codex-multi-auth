//! Forward status line (`CODEX_MULTI_AUTH_STATUSLINE`) + the background
//! quota-cache refresh — port of the status half of `scripts/codex.js`.
//!
//! The status line reads the (possibly project-scoped) accounts pool plus the
//! GLOBAL `quota-cache.json` / `runtime-observability.json` files as raw JSON
//! (never through the manager), formats one `|`-separated line, and prints it
//! to stderr for TTY runs.

use std::collections::HashMap;
use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::shadow_home::{remove_directory_best_effort_detached, remove_directory_with_retry};

/// TS `DEFAULT_STATUS_QUOTA_REFRESH_INTERVAL_MS` (10 min).
pub const DEFAULT_STATUS_QUOTA_REFRESH_INTERVAL_MS: i64 = 10 * 60 * 1000;
/// TS `STATUS_QUOTA_REFRESH_LOCK_STALE_MS` (10 min).
pub const STATUS_QUOTA_REFRESH_LOCK_STALE_MS: i64 = 10 * 60 * 1000;
/// TS `STATUS_QUOTA_REFRESH_LOCK_DIR`.
pub const STATUS_QUOTA_REFRESH_LOCK_DIR: &str = "status-quota-refresh.lock";

fn env_string(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// TS `readJsonFileQuiet(path)` — `null` on missing/unreadable/invalid.
pub fn read_json_file_quiet(path: &Path) -> Option<Value> {
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// TS `resolveMultiAuthDirFromEnv(env)` — explicit `CODEX_MULTI_AUTH_DIR` or
/// `<codex home>/multi-auth` (wrapper-simple, no pool probing ladder).
pub fn resolve_multi_auth_dir_from_env() -> PathBuf {
    let configured = env_string("CODEX_MULTI_AUTH_DIR");
    let configured = configured.trim();
    if !configured.is_empty() {
        return PathBuf::from(configured);
    }
    cma_core::runtime_paths::get_codex_home_dir().join("multi-auth")
}

/// TS `resolveAccountsPath(env, dir)`.
pub fn resolve_accounts_path(dir: &Path) -> PathBuf {
    dir.join("openai-codex-accounts.json")
}

/// TS `resolveQuotaCachePath(env, dir)`.
pub fn resolve_quota_cache_path(dir: &Path) -> PathBuf {
    dir.join("quota-cache.json")
}

/// TS `resolveRuntimeObservabilityPath(env, dir)`.
pub fn resolve_runtime_observability_path(dir: &Path) -> PathBuf {
    dir.join("runtime-observability.json")
}

/// TS `resolveStatusAccountsDir(env)` — mirrors the runtime's account scoping:
/// per-project pool only when `perProjectAccounts` is on, Codex CLI sync is
/// OFF, no explicit `CODEX_MULTI_AUTH_DIR`, and the cwd resolves to a project
/// root. Any failure falls back to the global dir.
pub fn resolve_status_accounts_dir() -> PathBuf {
    let global_dir = resolve_multi_auth_dir_from_env();
    if !env_string("CODEX_MULTI_AUTH_DIR").trim().is_empty() {
        // Explicit dir: the TS helper reaches the same outcome because the
        // runtime nests project pools under the configured dir; the wrapper
        // keeps reading the explicit pool root.
    }
    let plugin_config = cma_config::load::load_plugin_config();
    if !cma_config::getters::get_per_project_accounts(&plugin_config) {
        return global_dir;
    }
    if cma_cli_mirror::state::is_codex_cli_sync_enabled() {
        return global_dir;
    }
    let Ok(cwd) = std::env::current_dir() else {
        return global_dir;
    };
    let Some(project_root) = cma_storage::paths::find_project_root(&cwd) else {
        return global_dir;
    };
    let identity_root = cma_storage::paths::resolve_project_storage_identity_root(&project_root);
    cma_storage::paths::get_project_global_config_dir(&identity_root)
}

/// TS `normalizeAccountIdentifier(value)`.
pub fn normalize_account_identifier(value: Option<&str>) -> String {
    match value {
        Some(v) if !v.trim().is_empty() => v.trim().to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// TS `findAccountIndexByIdOrEmail(accounts, id, email)`.
pub fn find_account_index_by_id_or_email(
    accounts: &[Value],
    id: Option<&str>,
    email: Option<&str>,
) -> Option<usize> {
    let normalized_id = normalize_account_identifier(id);
    let normalized_email = normalize_account_identifier(email);
    for (index, account) in accounts.iter().enumerate() {
        if !account.is_object() {
            continue;
        }
        if !normalized_id.is_empty()
            && normalize_account_identifier(account.get("accountId").and_then(Value::as_str))
                == normalized_id
        {
            return Some(index);
        }
        if !normalized_email.is_empty()
            && normalize_account_identifier(account.get("email").and_then(Value::as_str))
                == normalized_email
        {
            return Some(index);
        }
    }
    None
}

/// TS `resolveModelFamilyForStatus(model)` — wrapper-local family bucketing
/// (GPT-5.6 general tiers share the gpt-5.2 prompt family).
pub fn resolve_model_family_for_status(model: Option<&str>) -> Option<&'static str> {
    let normalized = model.map(|m| m.trim().to_ascii_lowercase()).unwrap_or_default();
    if normalized.starts_with("gpt-5.6") {
        return Some("gpt-5.2");
    }
    if normalized.starts_with("gpt-5.2") {
        return Some("gpt-5.2");
    }
    if normalized.starts_with("gpt-5.1") {
        return Some("gpt-5.1");
    }
    if normalized.contains("codex-max") {
        return Some("codex-max");
    }
    if normalized.contains("codex") {
        return Some("codex");
    }
    if normalized.starts_with("gpt-5") {
        return Some("gpt-5-codex");
    }
    None
}

/// TS `resolveStatusAccountIndex(storage, runtime, model)` — 3-signal merge:
/// fresh runtime observability (≤ 1 h) → family active index → activeIndex →
/// 0. Returns `None` only for an empty pool.
pub fn resolve_status_account_index(
    storage: Option<&Value>,
    runtime: Option<&Value>,
    model: Option<&str>,
    now_ms: i64,
) -> Option<usize> {
    let accounts = storage
        .and_then(|s| s.get("accounts"))
        .and_then(Value::as_array)?;
    if accounts.is_empty() {
        return None;
    }

    let runtime_updated_at = runtime
        .and_then(|r| r.get("lastAccountUpdatedAt"))
        .and_then(Value::as_i64)
        .or_else(|| runtime.and_then(|r| r.get("updatedAt")).and_then(Value::as_i64))
        .unwrap_or(0);
    if now_ms - runtime_updated_at <= 60 * 60 * 1000 {
        let runtime_index = find_account_index_by_id_or_email(
            accounts,
            runtime
                .and_then(|r| r.get("lastAccountId"))
                .and_then(Value::as_str),
            runtime
                .and_then(|r| r.get("lastAccountEmail"))
                .and_then(Value::as_str),
        );
        if let Some(index) = runtime_index {
            return Some(index);
        }
        if let Some(last_index) = runtime
            .and_then(|r| r.get("lastAccountIndex"))
            .and_then(Value::as_i64)
            && last_index >= 0
            && (last_index as usize) < accounts.len()
        {
            return Some(last_index as usize);
        }
    }

    let family = resolve_model_family_for_status(model);
    if let Some(family) = family
        && let Some(family_index) = storage
            .and_then(|s| s.get("activeIndexByFamily"))
            .and_then(|m| m.get(family))
            .and_then(Value::as_i64)
        && family_index >= 0
        && (family_index as usize) < accounts.len()
    {
        return Some(family_index as usize);
    }
    if let Some(active_index) = storage
        .and_then(|s| s.get("activeIndex"))
        .and_then(Value::as_i64)
        && active_index >= 0
        && (active_index as usize) < accounts.len()
    {
        return Some(active_index as usize);
    }
    Some(0)
}

/// TS `extractConfigAssignmentValue(rawConfig, key)` — first `key = value`
/// line; strips one layer of quotes, drops `#` comments.
pub fn extract_config_assignment_value(raw_config: &str, key: &str) -> Option<String> {
    for line in raw_config.lines() {
        let trimmed_start = line.trim_start();
        let Some(rest) = trimmed_start.strip_prefix(key) else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        // value = everything before a newline or '#'
        let value_part = rest.split('#').next().unwrap_or("");
        let raw_value = value_part.trim();
        let unquoted = if (raw_value.starts_with('"') && raw_value.ends_with('"')
            || raw_value.starts_with('\'') && raw_value.ends_with('\''))
            && raw_value.len() >= 2
        {
            raw_value[1..raw_value.len() - 1].trim()
        } else {
            raw_value
        };
        if unquoted.is_empty() {
            return None;
        }
        return Some(unquoted.to_string());
    }
    None
}

/// TS `readCodexConfigValue(env, key)` — from `<codex home>/config.toml`.
pub fn read_codex_config_value(key: &str) -> Option<String> {
    let config_path = cma_core::runtime_paths::get_codex_home_dir().join("config.toml");
    if !config_path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&config_path).ok()?;
    extract_config_assignment_value(&raw, key)
}

/// TS `extractArgValue(args, longName, shortName)`.
pub fn extract_arg_value(args: &[String], long_name: &str, short_name: Option<&str>) -> Option<String> {
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == long_name || short_name.is_some_and(|s| arg == s) {
            return args.get(i + 1).cloned();
        }
        if let Some(value) = arg.strip_prefix(&format!("{long_name}=")) {
            return Some(value.to_string());
        }
        i += 1;
    }
    None
}

/// TS `extractConfigOverrideValue(args, key)` — `-c key=value` /
/// `--config key=value` / `--config=key=value` / `-c=key=value`.
pub fn extract_config_override_value(args: &[String], key: &str) -> Option<String> {
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        let assignment: Option<&str> = if arg == "-c" || arg == "--config" {
            args.get(i + 1).map(String::as_str)
        } else if let Some(rest) = arg.strip_prefix("-c=") {
            Some(rest)
        } else if let Some(rest) = arg.strip_prefix("--config=") {
            Some(rest)
        } else {
            None
        };
        if let Some(assignment) = assignment
            && let Some(separator) = assignment.find('=')
            && separator > 0
            && assignment[..separator].trim() == key
        {
            let value = assignment[separator + 1..].trim();
            let value = value
                .strip_prefix('"')
                .or_else(|| value.strip_prefix('\''))
                .unwrap_or(value);
            let value = value
                .strip_suffix('"')
                .or_else(|| value.strip_suffix('\''))
                .unwrap_or(value);
            return Some(value.to_string());
        }
        i += 1;
    }
    None
}

/// TS `resolveStatusModel(args, env)`.
pub fn resolve_status_model(args: &[String]) -> String {
    extract_arg_value(args, "--model", Some("-m"))
        .or_else(|| extract_config_override_value(args, "model"))
        .or_else(|| read_codex_config_value("model"))
        .unwrap_or_else(|| "unknown-model".to_string())
}

/// TS `resolveStatusReasoningEffort(args, env)`.
pub fn resolve_status_reasoning_effort(args: &[String]) -> String {
    extract_config_override_value(args, "model_reasoning_effort")
        .or_else(|| read_codex_config_value("model_reasoning_effort"))
        .unwrap_or_else(|| "unknown".to_string())
}

/// TS `formatStatusPath(cwd, home)` — `~` abbreviation with forward-slash
/// normalization of the remainder.
pub fn format_status_path(cwd: &Path, home: &Path) -> String {
    if cwd == home {
        return "~".to_string();
    }
    let cwd_str = cwd.display().to_string();
    let home_str = home.display().to_string();
    let sep = std::path::MAIN_SEPARATOR;
    let prefix = format!("{home_str}{sep}");
    if let Some(rest) = cwd_str.strip_prefix(&prefix) {
        let normalized = rest.replace(sep, "/");
        return format!("~/{normalized}");
    }
    cwd_str
}

// --- local-time formatting -------------------------------------------------
//
// TS uses `toLocaleTimeString`/`toLocaleDateString` (local timezone). The
// wrapper crate has no timezone database dependency; the offset is taken from
// the internal `CODEX_MULTI_AUTH_LOCAL_TZ_OFFSET_MIN` env var when the bin
// main publishes it, else UTC (documented deviation).

fn local_tz_offset_minutes() -> i64 {
    std::env::var("CODEX_MULTI_AUTH_LOCAL_TZ_OFFSET_MIN")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

/// Civil date from days since the Unix epoch (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn local_time_parts(epoch_ms: i64) -> (i64, u32, u32, u32, u32) {
    let shifted = epoch_ms + local_tz_offset_minutes() * 60_000;
    let days = shifted.div_euclid(86_400_000);
    let ms_of_day = shifted.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hour = (ms_of_day / 3_600_000) as u32;
    let minute = ((ms_of_day % 3_600_000) / 60_000) as u32;
    (year, month, day, hour, minute)
}

const MONTH_SHORT: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// TS `formatStatusResetTime(resetAtMs)` — `HH:MM` (24-hour).
pub fn format_status_reset_time(reset_at_ms: Option<i64>) -> Option<String> {
    let reset_at = reset_at_ms.filter(|&v| v > 0)?;
    let (_, _, _, hour, minute) = local_time_parts(reset_at);
    Some(format!("{hour:02}:{minute:02}"))
}

/// TS `formatStatusResetDate(resetAtMs)` — `Mon D` (e.g. `Jul 29`).
pub fn format_status_reset_date(reset_at_ms: Option<i64>) -> Option<String> {
    let reset_at = reset_at_ms.filter(|&v| v > 0)?;
    let (_, month, day, _, _) = local_time_parts(reset_at);
    Some(format!("{} {day}", MONTH_SHORT[(month - 1) as usize]))
}

/// TS `formatCacheAge(updatedAt)` — `stale` / `now` / `Nm` / `Nh`.
pub fn format_cache_age(updated_at: Option<i64>, now_ms: i64) -> String {
    let Some(updated_at) = updated_at.filter(|&v| v > 0) else {
        return "stale".to_string();
    };
    let age_ms = (now_ms - updated_at).max(0);
    if age_ms < 60_000 {
        return "now".to_string();
    }
    if age_ms < 60 * 60_000 {
        return format!("{}m", age_ms / 60_000);
    }
    format!("{}h", age_ms / (60 * 60_000))
}

/// TS `getQuotaEntryForAccount(quotaCache, account)`.
pub fn get_quota_entry_for_account<'a>(
    quota_cache: Option<&'a Value>,
    account: &Value,
) -> Option<&'a Value> {
    let account_id = account
        .get("accountId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let email = account
        .get("email")
        .and_then(Value::as_str)
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let by_account_id = quota_cache.and_then(|c| c.get("byAccountId"));
    let by_email = quota_cache.and_then(|c| c.get("byEmail"));
    by_account_id
        .and_then(|m| m.get(account_id))
        .filter(|v| !v.is_null())
        .or_else(|| by_email.and_then(|m| m.get(&email)).filter(|v| !v.is_null()))
}

fn format_usage_window(
    label: &str,
    window: Option<&Value>,
    reset_formatter: impl Fn(Option<i64>) -> Option<String>,
) -> Option<String> {
    let used = window
        .and_then(|w| w.get("usedPercent"))
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .map(|v| v.round().clamp(0.0, 100.0) as i64);
    let reset = reset_formatter(window.and_then(|w| w.get("resetAtMs")).and_then(Value::as_i64));
    match (used, reset) {
        (None, None) => None,
        (None, Some(reset)) => Some(format!("{label} resets {reset}")),
        (Some(used), None) => Some(format!("{label} {used}%")),
        (Some(used), Some(reset)) => Some(format!("{label} {used}% {reset}")),
    }
}

/// TS `formatUsageSegment(entry)`.
pub fn format_usage_segment(entry: Option<&Value>) -> String {
    let primary = format_usage_window(
        "5h",
        entry.and_then(|e| e.get("primary")),
        format_status_reset_time,
    );
    let secondary = format_usage_window(
        "week",
        entry.and_then(|e| e.get("secondary")),
        format_status_reset_date,
    );
    let parts: Vec<String> = [primary, secondary].into_iter().flatten().collect();
    if parts.is_empty() {
        "usage cached".to_string()
    } else {
        parts.join(" | ")
    }
}

/// TS `formatPlan(planType)` — `Plan?` fallback, else capitalized.
pub fn format_plan(plan_type: Option<&str>) -> String {
    let Some(plan) = plan_type.map(str::trim).filter(|p| !p.is_empty()) else {
        return "Plan?".to_string();
    };
    let mut chars = plan.chars();
    match chars.next() {
        Some(first) if plan.chars().count() > 1 => {
            format!(
                "{}{}",
                first.to_uppercase(),
                chars.as_str().to_lowercase()
            )
        }
        Some(first) => first.to_uppercase().to_string(),
        None => "Plan?".to_string(),
    }
}

/// TS `shouldShowForwardStatus(args, env)` — env override wins; the refresh
/// child never shows it; help/version runs never show it; else stderr TTY.
pub fn should_show_forward_status(args: &[String]) -> bool {
    let override_value = env_string("CODEX_MULTI_AUTH_STATUSLINE")
        .trim()
        .to_ascii_lowercase();
    if matches!(override_value.as_str(), "0" | "false" | "no" | "off") {
        return false;
    }
    if matches!(override_value.as_str(), "1" | "true" | "yes" | "on") {
        return true;
    }
    if env_string("CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD").trim() == "1" {
        return false;
    }
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "--version" | "-V"))
    {
        return false;
    }
    std::io::stderr().is_terminal()
}

/// TS `formatForwardStatusLine(rawArgs, env, accountsDir)` — `None` when no
/// accounts are configured or the selected account row is malformed.
pub fn format_forward_status_line(raw_args: &[String], accounts_dir: &Path) -> Option<String> {
    let storage = read_json_file_quiet(&resolve_accounts_path(accounts_dir));
    let accounts: Vec<Value> = storage
        .as_ref()
        .and_then(|s| s.get("accounts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if accounts.is_empty() {
        return None;
    }

    let global_dir = resolve_multi_auth_dir_from_env();
    let runtime = read_json_file_quiet(&resolve_runtime_observability_path(&global_dir));
    let quota_cache = read_json_file_quiet(&resolve_quota_cache_path(&global_dir));
    let model = resolve_status_model(raw_args);
    let effort = resolve_status_reasoning_effort(raw_args);
    let now = cma_core::utils::now_ms();
    let account_index = resolve_status_account_index(
        storage.as_ref(),
        runtime.as_ref(),
        Some(model.as_str()),
        now,
    )?;
    let account = accounts.get(account_index)?;
    if !account.is_object() {
        return None;
    }

    let quota_entry = get_quota_entry_for_account(quota_cache.as_ref(), account);
    let email = account
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Account {}", account_index + 1));
    let plan = format_plan(
        quota_entry
            .and_then(|e| e.get("planType"))
            .and_then(Value::as_str),
    );
    let usage = format_usage_segment(quota_entry);
    let cache_age = format_cache_age(
        quota_entry
            .and_then(|e| e.get("updatedAt"))
            .and_then(Value::as_i64),
        now,
    );
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let home = cma_core::runtime_paths::get_codex_home_dir()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let parts = [
        "codex-multi-auth".to_string(),
        format!("{model} {effort}"),
        format_status_path(&cwd, &home),
        format!("Account {}", account_index + 1),
        usage,
        format!("{email}({plan})"),
        format!("cache {cache_age}"),
    ];
    Some(parts.join(" | "))
}

/// TS `maybePrintForwardStatusLine(rawArgs, env)`.
pub fn maybe_print_forward_status_line(raw_args: &[String]) {
    if !should_show_forward_status(raw_args) {
        return;
    }
    let accounts_dir = resolve_status_accounts_dir();
    if let Some(line) = format_forward_status_line(raw_args, &accounts_dir) {
        eprintln!("{line}");
    }
}

// ---------------------------------------------------------------------------
// Background quota-cache refresh.
// ---------------------------------------------------------------------------

/// TS `parseDurationMs(value, fallback)`.
pub fn parse_duration_ms(value: Option<&str>, fallback: i64) -> i64 {
    let trimmed = value.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        return fallback;
    }
    // parseInt semantics: leading integer digits (optionally signed).
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1i64, rest),
        None => (1i64, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return fallback;
    }
    let Ok(parsed) = digits[..end].parse::<i64>() else {
        return fallback;
    };
    let parsed = sign * parsed;
    if parsed < 0 { fallback } else { parsed }
}

/// TS `quotaCacheNeedsRefresh(env)`.
pub fn quota_cache_needs_refresh() -> bool {
    let interval_env = std::env::var("CODEX_MULTI_AUTH_STATUS_QUOTA_REFRESH_INTERVAL_MS").ok();
    let interval_ms = parse_duration_ms(
        interval_env.as_deref(),
        DEFAULT_STATUS_QUOTA_REFRESH_INTERVAL_MS,
    );
    if interval_ms <= 0 {
        return false;
    }
    let dir = resolve_multi_auth_dir_from_env();
    let cache = read_json_file_quiet(&resolve_quota_cache_path(&dir));
    let mut entries: Vec<&Value> = Vec::new();
    for key in ["byAccountId", "byEmail"] {
        if let Some(map) = cache
            .as_ref()
            .and_then(|c| c.get(key))
            .and_then(Value::as_object)
        {
            entries.extend(map.values().filter(|v| v.is_object()));
        }
    }
    if entries.is_empty() {
        return true;
    }
    let newest = entries
        .iter()
        .map(|entry| {
            entry
                .get("updatedAt")
                .and_then(Value::as_i64)
                .unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    newest <= 0 || cma_core::utils::now_ms() - newest >= interval_ms
}

/// TS `acquireStatusRefreshLock(env)` — mkdir claim + owner.json, stale (10
/// min) takeover.
pub fn acquire_status_refresh_lock() -> (PathBuf, bool) {
    let lock_path = resolve_multi_auth_dir_from_env().join(STATUS_QUOTA_REFRESH_LOCK_DIR);
    let claim = |recovered: bool| -> bool {
        if fs::create_dir(&lock_path).is_err() {
            return false;
        }
        let mut payload = serde_json::json!({
            "pid": std::process::id(),
            "createdAt": cma_core::utils::now_ms(),
        });
        if recovered {
            payload["recovered"] = Value::Bool(true);
        }
        let _ = fs::write(
            lock_path.join("owner.json"),
            format!("{}\n", cma_core::json_io::stringify_compact(&payload)),
        );
        true
    };
    if let Some(parent) = lock_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if claim(false) {
        return (lock_path, true);
    }
    // Stale takeover (bounded TOCTOU accepted — see TS comment).
    if let Ok(meta) = fs::metadata(&lock_path) {
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if cma_core::utils::now_ms() - mtime_ms > STATUS_QUOTA_REFRESH_LOCK_STALE_MS
            && remove_directory_with_retry(&lock_path).is_ok()
            && claim(true)
        {
            return (lock_path, true);
        }
    }
    (lock_path, false)
}

/// Resolve a sibling cma binary (`codex-multi-auth`, `codex-multi-auth-codex`,
/// …) next to the current executable, falling back to the bare name (PATH).
pub fn resolve_sibling_cma_binary(name: &str) -> PathBuf {
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    if let Ok(current) = std::env::current_exe()
        && let Some(dir) = current.parent()
    {
        let candidate = dir.join(&file_name);
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

/// TS `maybeRefreshQuotaCacheInBackground(env)` — spawns a detached
/// `codex-multi-auth forecast --live --json` child under the refresh lock.
/// A background thread waits on the child to clean the lock; if the parent
/// exits first, the 10-minute stale-lock recovery reclaims it.
pub fn maybe_refresh_quota_cache_in_background(extra_env: &HashMap<String, String>) {
    if env_string("CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD").trim() == "1" {
        return;
    }
    if !quota_cache_needs_refresh() {
        return;
    }
    let (lock_path, acquired) = acquire_status_refresh_lock();
    if !acquired {
        return;
    }
    let program = resolve_sibling_cma_binary("codex-multi-auth");
    let mut command = Command::new(program);
    command
        .args(["forecast", "--live", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .envs(extra_env)
        .env("CODEX_MULTI_AUTH_STATUS_REFRESH_CHILD", "1")
        .env("CODEX_MULTI_AUTH_STATUSLINE", "0")
        // A forced-account pin is scoped to a single forwarded run; the
        // management child must never inherit it.
        .env_remove(crate::account_force::FORCE_ACCOUNT_INDEX_ENV);
    match command.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
                remove_directory_best_effort_detached(lock_path);
            });
        }
        Err(_) => {
            remove_directory_best_effort_detached(lock_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_family_bucketing() {
        assert_eq!(resolve_model_family_for_status(Some("gpt-5.6-sol")), Some("gpt-5.2"));
        assert_eq!(resolve_model_family_for_status(Some("GPT-5.2")), Some("gpt-5.2"));
        assert_eq!(resolve_model_family_for_status(Some("gpt-5.1")), Some("gpt-5.1"));
        // TS ordering: the gpt-5.1 prefix check precedes the codex-max scan.
        assert_eq!(
            resolve_model_family_for_status(Some("gpt-5.1-codex-max")),
            Some("gpt-5.1")
        );
        assert_eq!(
            resolve_model_family_for_status(Some("codex-max")),
            Some("codex-max")
        );
        assert_eq!(resolve_model_family_for_status(Some("gpt-5.3-codex")), Some("codex"));
        assert_eq!(resolve_model_family_for_status(Some("gpt-5.5")), Some("gpt-5-codex"));
        assert_eq!(resolve_model_family_for_status(Some("o3")), None);
        assert_eq!(resolve_model_family_for_status(None), None);
    }

    #[test]
    fn account_index_resolution_ladder() {
        let storage = json!({
            "accounts": [
                {"accountId": "acc_1", "email": "a@x.com"},
                {"accountId": "acc_2", "email": "b@x.com"},
                {"accountId": "acc_3", "email": "c@x.com"}
            ],
            "activeIndexByFamily": {"gpt-5.2": 2},
            "activeIndex": 1
        });
        let now = 10_000_000i64;
        // Fresh runtime signal wins.
        let runtime = json!({"lastAccountUpdatedAt": now - 1000, "lastAccountEmail": "B@X.COM"});
        assert_eq!(
            resolve_status_account_index(Some(&storage), Some(&runtime), Some("gpt-5.6"), now),
            Some(1)
        );
        // Stale runtime → family index.
        let stale = json!({"lastAccountUpdatedAt": now - 2 * 60 * 60 * 1000, "lastAccountEmail": "b@x.com"});
        assert_eq!(
            resolve_status_account_index(Some(&storage), Some(&stale), Some("gpt-5.6"), now),
            Some(2)
        );
        // No family entry → activeIndex.
        assert_eq!(
            resolve_status_account_index(Some(&storage), Some(&stale), Some("gpt-5.3-codex"), now),
            Some(1)
        );
        // Runtime index fallback within freshness window.
        let idx_runtime = json!({"updatedAt": now, "lastAccountIndex": 2});
        assert_eq!(
            resolve_status_account_index(Some(&storage), Some(&idx_runtime), None, now),
            Some(2)
        );
        // Empty pool → None.
        let empty = json!({"accounts": []});
        assert_eq!(resolve_status_account_index(Some(&empty), None, None, now), None);
    }

    #[test]
    fn config_assignment_extraction() {
        let raw = "# c\nmodel = \"gpt-5.5\"\nmodel_reasoning_effort = high # inline\n";
        assert_eq!(
            extract_config_assignment_value(raw, "model").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            extract_config_assignment_value(raw, "model_reasoning_effort").as_deref(),
            Some("high")
        );
        assert_eq!(extract_config_assignment_value(raw, "missing"), None);
    }

    #[test]
    fn arg_and_config_override_extraction() {
        let args: Vec<String> = ["-m", "gpt-5.5", "-c", "model_reasoning_effort=\"xhigh\""]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            extract_arg_value(&args, "--model", Some("-m")).as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            extract_config_override_value(&args, "model_reasoning_effort").as_deref(),
            Some("xhigh")
        );
        let eq_form: Vec<String> = ["--model=gpt-5.4", "--config=model=other"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            extract_arg_value(&eq_form, "--model", Some("-m")).as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            extract_config_override_value(&eq_form, "model").as_deref(),
            Some("other")
        );
    }

    #[test]
    fn status_path_formatting() {
        let home = PathBuf::from(if cfg!(windows) { "C:\\Users\\me" } else { "/home/me" });
        assert_eq!(format_status_path(&home, &home), "~");
        let nested = home.join("proj").join("sub");
        assert_eq!(format_status_path(&nested, &home), "~/proj/sub");
        let outside = PathBuf::from(if cfg!(windows) { "D:\\other" } else { "/other" });
        assert_eq!(format_status_path(&outside, &home), outside.display().to_string());
    }

    #[test]
    fn cache_age_formatting() {
        let now = 100 * 60 * 60_000i64;
        assert_eq!(format_cache_age(None, now), "stale");
        assert_eq!(format_cache_age(Some(0), now), "stale");
        assert_eq!(format_cache_age(Some(now - 30_000), now), "now");
        assert_eq!(format_cache_age(Some(now - 5 * 60_000), now), "5m");
        assert_eq!(format_cache_age(Some(now - 3 * 60 * 60_000), now), "3h");
    }

    #[test]
    fn plan_formatting() {
        assert_eq!(format_plan(None), "Plan?");
        assert_eq!(format_plan(Some("  ")), "Plan?");
        assert_eq!(format_plan(Some("plus")), "Plus");
        assert_eq!(format_plan(Some("PRO")), "Pro");
        assert_eq!(format_plan(Some("x")), "X");
    }

    #[test]
    fn usage_segment_formatting() {
        assert_eq!(format_usage_segment(None), "usage cached");
        let entry = json!({"primary": {"usedPercent": 42.4}, "secondary": {"usedPercent": 90.6}});
        assert_eq!(format_usage_segment(Some(&entry)), "5h 42% | week 91%");
        let entry = json!({"primary": {"usedPercent": 150.0}});
        assert_eq!(format_usage_segment(Some(&entry)), "5h 100%");
    }

    #[test]
    fn quota_entry_lookup_prefers_account_id() {
        let cache = json!({
            "byAccountId": {"acc_1": {"planType": "plus"}},
            "byEmail": {"a@x.com": {"planType": "pro"}}
        });
        let account = json!({"accountId": "acc_1", "email": "A@X.com"});
        let entry = get_quota_entry_for_account(Some(&cache), &account).unwrap();
        assert_eq!(entry["planType"], "plus");
        let account2 = json!({"accountId": "other", "email": "A@X.com"});
        let entry2 = get_quota_entry_for_account(Some(&cache), &account2).unwrap();
        assert_eq!(entry2["planType"], "pro");
        let account3 = json!({"accountId": "nope", "email": "nope@x.com"});
        assert!(get_quota_entry_for_account(Some(&cache), &account3).is_none());
    }

    #[test]
    fn duration_parsing() {
        assert_eq!(parse_duration_ms(None, 7), 7);
        assert_eq!(parse_duration_ms(Some(""), 7), 7);
        assert_eq!(parse_duration_ms(Some("  1200  "), 7), 1200);
        assert_eq!(parse_duration_ms(Some("0"), 7), 0);
        assert_eq!(parse_duration_ms(Some("-5"), 7), 7);
        assert_eq!(parse_duration_ms(Some("abc"), 7), 7);
        assert_eq!(parse_duration_ms(Some("120x"), 7), 120);
    }

    #[test]
    fn reset_time_formatting_utc_fallback() {
        // 2026-07-29T18:10:00Z
        let ts = 1_785_348_600_000i64;
        // Without the offset env var this formats in UTC.
        if std::env::var("CODEX_MULTI_AUTH_LOCAL_TZ_OFFSET_MIN").is_err() {
            assert_eq!(format_status_reset_time(Some(ts)).unwrap(), "18:10");
            assert_eq!(format_status_reset_date(Some(ts)).unwrap(), "Jul 29");
        }
        assert_eq!(format_status_reset_time(None), None);
        assert_eq!(format_status_reset_time(Some(0)), None);
        assert_eq!(format_status_reset_time(Some(-5)), None);
    }
}
