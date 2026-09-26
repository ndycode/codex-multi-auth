//! The forwarding engine — port of `scripts/codex.js` (minus the manager
//! dispatch itself, which lives in `cma-manager`; see the DESIGN BOUNDARY in
//! the crate docs: this crate only CLASSIFIES auth-family args, the cma-bin
//! mains route them).
//!
//! Responsibilities:
//! - arg classification ([`classify_wrapper_args`]) — auth-family vs forward;
//! - `-c cli_auth_credentials_store="file"` injection (opt-out
//!   `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0`);
//! - wrapper-side model alias/effort coercion + unsupported-model retry;
//! - runtime rotation proxy startup + shadow `CODEX_HOME` + provider env for
//!   the spawned official codex;
//! - `--account` force-pin plumbing (fail-hard before spawn — #623);
//! - app / interactive-TUI runtime helper (detached self-spawn) and the
//!   app-server account/read protocol proxy;
//! - forwarded runtime observability + session-index repair.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::account_force::{apply_forced_account_selection, ForcedAccountOutcome, FORCE_ACCOUNT_INDEX_ENV};
use crate::bin_resolver::{resolve_real_codex_bin, ResolvedCodexBin};
use crate::routing::{
    is_codex_app_command, is_codex_app_server_command, is_codex_interactive_tui_command,
    is_rotation_enable_command, normalize_auth_alias, should_handle_multi_auth_auth,
    should_track_forwarded_runtime_observability, should_use_runtime_routing_for_forwarded_args,
};
use crate::shadow_home::{
    acquire_shadow_home_sync_lock, create_runtime_rotation_proxy_codex_home,
    create_shadow_home_mirror, remove_directory_with_retry, resolve_codex_home_dir,
    resolve_original_multi_auth_dir, resolve_runtime_rotation_original_multi_auth_dir,
    resolve_runtime_rotation_proxy_original_codex_home, write_owner_only_json_file_atomic_sync,
    MirrorOptions, ShadowHomeContext,
};

pub const APP_SERVER_ACCOUNT_DISPLAY_NAME: &str = "codex-multi-auth";
pub const APP_SERVER_ACCOUNT_LABEL_ENV: &str = "CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL";
pub const INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG: &str = "--codex-multi-auth-runtime-app-helper";
pub const APP_RUNTIME_HELPER_OWNER_PID_ENV: &str = "CODEX_MULTI_AUTH_APP_ROTATION_OWNER_PID";
pub const APP_RUNTIME_HELPER_REAL_CODEX_HOME_ENV: &str = "CODEX_MULTI_AUTH_REAL_CODEX_HOME";
pub const DEFAULT_APP_RUNTIME_HELPER_IDLE_MS: i64 = 12 * 60 * 60 * 1000;
pub const DEFAULT_APP_RUNTIME_HELPER_DETACH_GRACE_MS: i64 = 5_000;
pub const APP_RUNTIME_HELPER_LAUNCH_TIMEOUT_MS: u64 = 15_000;
pub const APP_SERVER_SHIM_DIR_NAME: &str = "app-server-shims";
pub const APP_SERVER_SHIM_HELPER_PREFIX: &str = "helper-";

fn env_string(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

fn process_env_map() -> HashMap<String, String> {
    std::env::vars().collect()
}

// ===========================================================================
// Classification (consumed by the cma-bin mains).
// ===========================================================================

/// How the cma-bin main should route this invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WrapperDispatch {
    /// The internal detached app-helper child (`--codex-multi-auth-runtime-app-helper`).
    RunAppHelper,
    /// Auth-family command → `cma_manager::run_codex_multi_auth_cli(normalized_args)`.
    AuthManager { normalized_args: Vec<String> },
    /// Everything else → [`forward`].
    Forward { raw_args: Vec<String> },
}

/// Classify raw argv (post bin-name). `CODEX_MULTI_AUTH_BYPASS=1` forces the
/// forward path even for auth-family args (TS `main()` parity).
pub fn classify_wrapper_args(raw_args: &[String]) -> WrapperDispatch {
    if raw_args.first().map(String::as_str) == Some(INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG) {
        return WrapperDispatch::RunAppHelper;
    }
    let normalized_args = normalize_auth_alias(raw_args);
    let bypass = env_string("CODEX_MULTI_AUTH_BYPASS").trim() == "1";
    if !bypass && should_handle_multi_auth_auth(&normalized_args) {
        return WrapperDispatch::AuthManager { normalized_args };
    }
    WrapperDispatch::Forward {
        raw_args: raw_args.to_vec(),
    }
}

/// TS `maybeInstallCodexAppLauncherAfterRotationEnable(args, exitCode)` — the
/// bin main calls this after a successful manager run.
pub async fn maybe_install_codex_app_launcher_after_rotation_enable(
    normalized_args: &[String],
    exit_code: i32,
) {
    if exit_code != 0 || !is_rotation_enable_command(normalized_args) {
        return;
    }
    let override_value = std::env::var("CODEX_MULTI_AUTH_APP_LAUNCHER_INSTALL")
        .unwrap_or_else(|_| "1".to_string());
    let normalized = override_value.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "0" | "false" | "no") {
        return;
    }
    let options = cma_runtime::app_launcher::AppLauncherOptions::default();
    if let Err(error) = cma_runtime::app_launcher::install_codex_app_launcher(&options).await {
        eprintln!("codex-multi-auth: could not route Codex app launchers: {error}");
    }
}

// ===========================================================================
// Wrapper-side model resolution (kept in sync with lib/request model-map).
// ===========================================================================

pub const CURRENT_CODEX_MODEL: &str = "gpt-5.3-codex";
pub const LEGACY_CODEX_MODEL: &str = "gpt-5-codex";
const DEFAULT_GENERAL_GPT5_MODEL: &str = "gpt-5.5";
const GPT_5_6_SOL_MODEL: &str = "gpt-5.6-sol";
const GPT_5_6_TERRA_MODEL: &str = "gpt-5.6-terra";
const GPT_5_6_LUNA_MODEL: &str = "gpt-5.6-luna";

/// TS `WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN`.
pub fn wrapper_unsupported_model_fallback_chain(model: &str) -> &'static [&'static str] {
    match model {
        "gpt-5" => &["gpt-5.5"],
        "gpt-5-pro" => &["gpt-5.5-pro"],
        "gpt-5-chat-latest" => &["gpt-5.5"],
        "gpt-5.5" => &["gpt-5.4"],
        "gpt-5.5-pro" => &["gpt-5.4"],
        "gpt-5.5-2026-04-23" => &["gpt-5.4"],
        "gpt-5.5-pro-2026-04-23" => &["gpt-5.4"],
        "gpt-5.5-20260423" => &["gpt-5.4"],
        "gpt-5.5-pro-20260423" => &["gpt-5.4"],
        "gpt-5.3-codex-spark" => &[CURRENT_CODEX_MODEL],
        "codex-max" => &[CURRENT_CODEX_MODEL],
        "gpt-5.1-codex-max" => &[CURRENT_CODEX_MODEL],
        "codex-mini-latest" => &[CURRENT_CODEX_MODEL],
        "gpt-5-codex-mini" => &[CURRENT_CODEX_MODEL],
        "gpt-5.1-codex-mini" => &[CURRENT_CODEX_MODEL],
        "gpt-5-codex" => &[CURRENT_CODEX_MODEL],
        "gpt-5.2-codex" => &[CURRENT_CODEX_MODEL],
        "gpt-5.1-codex" => &[CURRENT_CODEX_MODEL],
        _ => &[],
    }
}

/// TS `SUPPORTED_REASONING_EFFORTS_BY_MODEL`.
fn supported_reasoning_efforts_by_model(model: &str) -> Option<&'static [&'static str]> {
    Some(match model {
        "gpt-5.3-codex" => &["low", "medium", "high", "xhigh"],
        "gpt-5.6-sol" | "gpt-5.6-terra" => &["low", "medium", "high", "xhigh", "max", "ultra"],
        "gpt-5.6-luna" => &["low", "medium", "high", "xhigh", "max"],
        "gpt-5.5" => &["none", "low", "medium", "high", "xhigh"],
        "gpt-5.5-pro" => &["medium", "high", "xhigh"],
        "gpt-5.4" => &["none", "low", "medium", "high", "xhigh"],
        "gpt-5.4-pro" => &["medium", "high", "xhigh"],
        "gpt-5.4-mini" => &["medium"],
        "gpt-5.4-nano" => &["medium"],
        "gpt-5.2-pro" => &["medium", "high", "xhigh"],
        "gpt-5.2" => &["none", "low", "medium", "high", "xhigh"],
        "gpt-5.1" => &["none", "low", "medium", "high"],
        "gpt-5-mini" => &["medium"],
        "gpt-5-nano" => &["medium"],
        _ => return None,
    })
}

/// TS `REASONING_FALLBACKS`.
fn reasoning_fallbacks(effort: &str) -> Option<&'static [&'static str]> {
    Some(match effort {
        "none" => &["none", "low", "minimal", "medium", "high", "xhigh"],
        "minimal" => &["minimal", "low", "none", "medium", "high", "xhigh"],
        "low" => &["low", "minimal", "none", "medium", "high", "xhigh"],
        "medium" => &["medium", "low", "high", "minimal", "none", "xhigh"],
        "high" => &["high", "medium", "xhigh", "low", "minimal", "none"],
        "xhigh" => &["xhigh", "high", "medium", "low", "minimal", "none"],
        "max" => &["max", "xhigh", "high", "medium", "low", "minimal", "none"],
        "ultra" => &["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "none"],
        _ => return None,
    })
}

const REASONING_ALIAS_VARIANTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh"];
const GPT_5_6_SOL_TERRA_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];
const GPT_5_6_LUNA_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

fn requested_model_aliases() -> &'static HashMap<String, String> {
    static CELL: OnceLock<HashMap<String, String>> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut map: HashMap<String, String> = HashMap::new();
        // (alias, normalized) with the pre-5.6 effort-suffix variants.
        let reasoning_seeded: &[(&str, &str)] = &[
            ("gpt-5.5", "gpt-5.5"),
            ("gpt-5.5-2026-04-23", "gpt-5.5"),
            ("gpt-5.5-20260423", "gpt-5.5"),
            ("gpt-5.5-pro", "gpt-5.5-pro"),
            ("gpt-5.5-pro-2026-04-23", "gpt-5.5-pro"),
            ("gpt-5.5-pro-20260423", "gpt-5.5-pro"),
            ("gpt-5.4", "gpt-5.4"),
            ("gpt-5.4-pro", "gpt-5.4-pro"),
            ("gpt-5.4-mini", "gpt-5.4-mini"),
            ("gpt-5.4-nano", "gpt-5.4-nano"),
            ("gpt-5.2-pro", "gpt-5.2-pro"),
            ("gpt-5-pro", "gpt-5.5-pro"),
            ("gpt-5.2", "gpt-5.2"),
            ("gpt-5.1", "gpt-5.1"),
            ("gpt-5", DEFAULT_GENERAL_GPT5_MODEL),
            ("gpt-5-mini", "gpt-5-mini"),
            ("gpt-5-nano", "gpt-5-nano"),
            ("gpt-5.1-chat-latest", "gpt-5.1"),
            ("gpt-5-chat-latest", DEFAULT_GENERAL_GPT5_MODEL),
            (CURRENT_CODEX_MODEL, CURRENT_CODEX_MODEL),
            ("gpt-5.3-codex-spark", CURRENT_CODEX_MODEL),
            (LEGACY_CODEX_MODEL, CURRENT_CODEX_MODEL),
            ("gpt-5.2-codex", CURRENT_CODEX_MODEL),
            ("gpt-5.1-codex", CURRENT_CODEX_MODEL),
            ("codex-max", CURRENT_CODEX_MODEL),
            ("gpt-5.1-codex-max", CURRENT_CODEX_MODEL),
            ("gpt-5-codex-mini", CURRENT_CODEX_MODEL),
            ("gpt-5.1-codex-mini", CURRENT_CODEX_MODEL),
        ];
        for (alias, normalized) in reasoning_seeded {
            map.insert((*alias).to_string(), (*normalized).to_string());
            for effort in REASONING_ALIAS_VARIANTS {
                map.insert(format!("{alias}-{effort}"), (*normalized).to_string());
            }
        }
        // (alias, normalized, explicit effort set) — GPT-5.6 tiers.
        let effort_seeded: &[(&str, &str, &[&str])] = &[
            (GPT_5_6_SOL_MODEL, GPT_5_6_SOL_MODEL, GPT_5_6_SOL_TERRA_EFFORTS),
            (GPT_5_6_TERRA_MODEL, GPT_5_6_TERRA_MODEL, GPT_5_6_SOL_TERRA_EFFORTS),
            (GPT_5_6_LUNA_MODEL, GPT_5_6_LUNA_MODEL, GPT_5_6_LUNA_EFFORTS),
            ("gpt-5.6", GPT_5_6_SOL_MODEL, GPT_5_6_SOL_TERRA_EFFORTS),
        ];
        for (alias, normalized, efforts) in effort_seeded {
            map.insert((*alias).to_string(), (*normalized).to_string());
            for effort in *efforts {
                map.insert(format!("{alias}-{effort}"), (*normalized).to_string());
            }
        }
        // Plain aliases (no effort variants).
        map.insert("gpt_5_codex".to_string(), CURRENT_CODEX_MODEL.to_string());
        map.insert("codex-mini-latest".to_string(), CURRENT_CODEX_MODEL.to_string());
        map
    })
}

fn strip_provider_prefix(model: &str) -> &str {
    match model.rfind('/') {
        Some(pos) if model.contains('/') => &model[pos + 1..],
        _ => model,
    }
}

fn tokenize_requested_model(model: &str) -> Vec<String> {
    model
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

fn resolve_codex_requested_model(normalized: &str) -> &'static str {
    let includes = |needle: &str| normalized.contains(needle);
    if includes("gpt-5.1-codex-max") || includes("gpt 5.1 codex max") || includes("codex-max") {
        return CURRENT_CODEX_MODEL;
    }
    if includes("gpt-5.1-codex-mini")
        || includes("gpt 5.1 codex mini")
        || includes("gpt-5-codex-mini")
        || includes("gpt 5 codex mini")
        || includes("codex-mini-latest")
    {
        return CURRENT_CODEX_MODEL;
    }
    if includes("gpt-5.3-codex-spark")
        || includes("gpt 5.3 codex spark")
        || includes("gpt-5.3-codex")
        || includes("gpt 5.3 codex")
        || includes("gpt-5.2-codex")
        || includes("gpt 5.2 codex")
        || includes("gpt-5.1-codex")
        || includes("gpt 5.1 codex")
        || includes("gpt-5-codex")
        || includes("gpt 5 codex")
        || normalized == "codex"
    {
        return CURRENT_CODEX_MODEL;
    }
    ""
}

fn resolve_gpt56_requested_model(stripped: &str) -> &'static str {
    let tokens = tokenize_requested_model(stripped);
    let gpt_index = tokens.iter().position(|t| t == "gpt");
    let is_gpt56 = gpt_index.is_some_and(|i| {
        tokens.get(i + 1).map(String::as_str) == Some("5")
            && tokens.get(i + 2).map(String::as_str) == Some("6")
    });
    if !is_gpt56 || tokens.iter().any(|t| t == "codex") {
        return "";
    }
    if tokens.iter().any(|t| t == "terra") {
        return GPT_5_6_TERRA_MODEL;
    }
    if tokens.iter().any(|t| t == "luna") {
        return GPT_5_6_LUNA_MODEL;
    }
    GPT_5_6_SOL_MODEL
}

fn general_gpt5_catalog(minor: u32, variant: &str) -> Option<&'static str> {
    let catalog: &[(&str, &str)] = match minor {
        1 => &[("base", "gpt-5.1")],
        2 => &[("base", "gpt-5.2"), ("pro", "gpt-5.2-pro")],
        4 => &[
            ("base", "gpt-5.5"),
            ("pro", "gpt-5.4-pro"),
            ("mini", "gpt-5.4-mini"),
            ("nano", "gpt-5.4-nano"),
        ],
        5 => &[
            ("base", "gpt-5.5"),
            ("pro", "gpt-5.5-pro"),
            ("mini", "gpt-5-mini"),
            ("nano", "gpt-5-nano"),
        ],
        _ => return None,
    };
    catalog
        .iter()
        .find(|(v, _)| *v == variant)
        .or_else(|| catalog.iter().find(|(v, _)| *v == "base"))
        .map(|(_, m)| *m)
}

fn stable_general_gpt5_variant(variant: &str) -> &'static str {
    match variant {
        "pro" => "gpt-5.5-pro",
        "mini" => "gpt-5-mini",
        "nano" => "gpt-5-nano",
        _ => "gpt-5.5",
    }
}

fn resolve_general_gpt5_requested_model(stripped: &str) -> String {
    let tokens = tokenize_requested_model(stripped);
    let gpt_index = tokens.iter().position(|t| t == "gpt");
    let is_gpt5 =
        gpt_index.is_some_and(|i| tokens.get(i + 1).map(String::as_str) == Some("5"));
    if !is_gpt5 || tokens.iter().any(|t| t == "codex") {
        return String::new();
    }
    let raw_minor = gpt_index.and_then(|i| tokens.get(i + 2));
    let minor: Option<u32> = raw_minor
        .filter(|m| !m.is_empty() && m.chars().all(|c| c.is_ascii_digit()))
        .and_then(|m| m.parse().ok());
    let variant = if tokens.iter().any(|t| t == "mini") {
        "mini"
    } else if tokens.iter().any(|t| t == "nano") {
        "nano"
    } else if tokens.iter().any(|t| t == "pro") {
        "pro"
    } else {
        "base"
    };
    let Some(minor) = minor else {
        // Generic variants (no minor).
        return match variant {
            "pro" => "gpt-5.5-pro",
            "mini" => "gpt-5-mini",
            "nano" => "gpt-5-nano",
            _ => DEFAULT_GENERAL_GPT5_MODEL,
        }
        .to_string();
    };
    if let Some(exact) = general_gpt5_catalog(minor, variant) {
        return exact.to_string();
    }
    stable_general_gpt5_variant(variant).to_string()
}

/// TS `normalizeRequestedModel(model)`.
pub fn normalize_requested_model(model: &str) -> String {
    let stripped = strip_provider_prefix(model);
    let normalized = stripped.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return String::new();
    }
    if let Some(exact) = requested_model_aliases().get(&normalized) {
        return exact.clone();
    }
    let codex_model = resolve_codex_requested_model(&normalized);
    if !codex_model.is_empty() {
        return codex_model.to_string();
    }
    let gpt56 = resolve_gpt56_requested_model(stripped);
    if !gpt56.is_empty() {
        return gpt56.to_string();
    }
    resolve_general_gpt5_requested_model(stripped)
}

fn strip_effort_suffix(value: &str) -> String {
    for effort in [
        "-none", "-minimal", "-low", "-medium", "-high", "-xhigh", "-max", "-ultra",
    ] {
        if let Some(stripped) = value.strip_suffix(effort) {
            return stripped.to_string();
        }
    }
    value.to_string()
}

/// TS `canonicalizeRequestedModelName(model)`.
pub fn canonicalize_requested_model_name(model: &str) -> String {
    let normalized = normalize_requested_model(model);
    if !normalized.is_empty() {
        return normalized;
    }
    let stripped = strip_provider_prefix(model).trim().to_ascii_lowercase();
    if stripped.is_empty() {
        return String::new();
    }
    strip_effort_suffix(&stripped)
}

/// TS `canonicalizeUnsupportedModelKey(model)` — suffix strip only.
pub fn canonicalize_unsupported_model_key(model: &str) -> String {
    let stripped = strip_provider_prefix(model).trim().to_ascii_lowercase();
    if stripped.is_empty() {
        return String::new();
    }
    strip_effort_suffix(&stripped)
}

/// TS `resolveSupportedReasoningEffort`.
fn resolve_supported_reasoning_effort<'a>(
    normalized_effort: &'a str,
    supported: Option<&'static [&'static str]>,
) -> &'a str {
    let Some(supported) = supported else {
        return normalized_effort;
    };
    if supported.contains(&normalized_effort) {
        return normalized_effort;
    }
    if let Some(order) = reasoning_fallbacks(normalized_effort) {
        for candidate in order {
            if supported.contains(candidate) {
                return candidate;
            }
        }
    }
    normalized_effort
}

/// TS `coerceReasoningEffortForModel(model, effort)` — unknown efforts pass
/// through untouched; `ultra` NEVER reaches the wire (rewritten to `max`).
pub fn coerce_reasoning_effort_for_model(model: &str, effort: &str) -> String {
    let normalized_effort = effort.trim().to_ascii_lowercase();
    if reasoning_fallbacks(&normalized_effort).is_none() {
        return effort.to_string();
    }
    let normalized_model = normalize_requested_model(model);
    let supported = supported_reasoning_efforts_by_model(&normalized_model);
    let resolved = resolve_supported_reasoning_effort(&normalized_effort, supported);
    if resolved == "ultra" {
        "max".to_string()
    } else {
        resolved.to_string()
    }
}

/// TS `extractRequestedModel(args)`.
pub fn extract_requested_model(args: &[String]) -> Option<String> {
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--model" || arg == "-m" {
            if let Some(next) = args.get(i + 1)
                && !next.trim().is_empty()
            {
                return Some(next.trim().to_string());
            }
            i += 1;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--model=") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        i += 1;
    }
    None
}

fn parse_config_assignment(value: &str) -> Option<(String, String)> {
    let separator = value.find('=')?;
    Some((
        value[..separator].trim().to_string(),
        value[separator + 1..].trim().to_string(),
    ))
}

fn parse_quoted_value(value: &str) -> (char, String) {
    let trimmed = value.trim();
    let mut chars = trimmed.chars();
    let first = chars.next();
    let last = trimmed.chars().last();
    if let (Some(f), Some(l)) = (first, last)
        && (f == '"' || f == '\'')
        && l == f
        && trimmed.len() >= 2
    {
        return (f, trimmed[1..trimmed.len() - 1].to_string());
    }
    ('"', trimmed.to_string())
}

fn rewrite_reasoning_config_assignment(assignment: &str, requested_model: &str) -> String {
    let Some((key, value)) = parse_config_assignment(assignment) else {
        return assignment.to_string();
    };
    if key != "model_reasoning_effort" {
        return assignment.to_string();
    }
    let (quote, inner) = parse_quoted_value(&value);
    let coerced = coerce_reasoning_effort_for_model(requested_model, &inner);
    if coerced == inner {
        return assignment.to_string();
    }
    format!("{key}={quote}{coerced}{quote}")
}

/// TS `rewriteReasoningConfigArgs(rawArgs)` — coerce `-c
/// model_reasoning_effort=…` for the requested model.
pub fn rewrite_reasoning_config_args(raw_args: &[String]) -> (Vec<String>, Option<String>) {
    let Some(requested_model) = extract_requested_model(raw_args) else {
        return (raw_args.to_vec(), None);
    };
    let mut next_args = raw_args.to_vec();
    let mut i = 0usize;
    while i < next_args.len() {
        let arg = next_args[i].clone();
        if (arg == "-c" || arg == "--config") && i + 1 < next_args.len() {
            next_args[i + 1] =
                rewrite_reasoning_config_assignment(&next_args[i + 1], &requested_model);
            i += 2;
            continue;
        }
        if let Some(assignment) = arg.strip_prefix("--config=") {
            next_args[i] = format!(
                "--config={}",
                rewrite_reasoning_config_assignment(assignment, &requested_model)
            );
        }
        i += 1;
    }
    (next_args, Some(requested_model))
}

fn ensure_trailing_newline(value: &str) -> String {
    if value.ends_with('\n') {
        value.to_string()
    } else {
        format!("{value}\n")
    }
}

/// TS `rewriteConfigTomlReasoningEffort(rawConfig, requestedModel)` —
/// line-level rewrite of `model_reasoning_effort` (quoted or bare values).
pub fn rewrite_config_toml_reasoning_effort(raw_config: &str, requested_model: &str) -> String {
    let line_ending = if raw_config.contains("\r\n") { "\r\n" } else { "\n" };
    let mut changed = false;
    let lines: Vec<String> = raw_config
        .split("\r\n")
        .flat_map(|s| s.split('\n'))
        .map(|line| {
            let trimmed = line.trim_start();
            let indent_len = line.len() - trimmed.len();
            let Some(rest) = trimmed.strip_prefix("model_reasoning_effort") else {
                return line.to_string();
            };
            let after_key = rest.trim_start();
            let Some(after_eq) = after_key.strip_prefix('=') else {
                return line.to_string();
            };
            let value_part = after_eq.trim_start();
            let prefix_len = line.len() - value_part.len();
            let prefix = &line[..prefix_len];
            // Quoted form
            if let Some(quote) = value_part.chars().next().filter(|c| *c == '"' || *c == '\'') {
                let inner_start = 1;
                if let Some(close) = value_part[inner_start..].find(quote) {
                    let current = &value_part[inner_start..inner_start + close];
                    let suffix = &value_part[inner_start + close..];
                    let coerced = coerce_reasoning_effort_for_model(requested_model, current);
                    if coerced != current {
                        changed = true;
                        return format!("{prefix}{quote}{coerced}{suffix}");
                    }
                }
                return line.to_string();
            }
            // Bare form: value up to whitespace/#
            let value_end = value_part
                .find(|c: char| c.is_whitespace() || c == '#')
                .unwrap_or(value_part.len());
            if value_end == 0 {
                return line.to_string();
            }
            let current = &value_part[..value_end];
            let suffix = &value_part[value_end..];
            let coerced = coerce_reasoning_effort_for_model(requested_model, current);
            if coerced != current {
                changed = true;
                let _ = indent_len;
                return format!("{prefix}{coerced}{suffix}");
            }
            line.to_string()
        })
        .collect();
    if !changed {
        return raw_config.to_string();
    }
    ensure_trailing_newline(&lines.join(line_ending))
}

// ===========================================================================
// Unsupported-model output parsing + wrapper retry chain.
// ===========================================================================

/// Case-insensitive substring check.
fn contains_ci(haystack_lower: &str, needle_lower: &str) -> bool {
    haystack_lower.contains(needle_lower)
}

const UNSUPPORTED_SUBSTRING: &str = "model is not supported when using codex with a chatgpt account";
const NORMALIZED_SUFFIX: &str =
    " is not currently available for this chatgpt account when using codex oauth";
const ACCESS_DENIED_SUFFIX: &str = " does not exist or you do not have access to it";

fn find_quoted_capture(
    haystack_lower: &str,
    prefix_lower: &str,
    suffix_lower: &str,
    quotes: &[char],
) -> Option<String> {
    let mut search_from = 0usize;
    while let Some(rel) = haystack_lower[search_from..].find(prefix_lower) {
        let after_prefix = search_from + rel + prefix_lower.len();
        let rest = &haystack_lower[after_prefix..];
        let Some(open) = rest.chars().next().filter(|c| quotes.contains(c)) else {
            search_from = after_prefix;
            continue;
        };
        let inner = &rest[open.len_utf8()..];
        let close_quotes: &[char] = quotes;
        if let Some(close) = inner.find(|c: char| close_quotes.contains(&c)) {
            let captured = &inner[..close];
            let tail = &inner[close + inner[close..].chars().next().map(char::len_utf8).unwrap_or(1)..];
            if tail.starts_with(suffix_lower) && !captured.is_empty() {
                return Some(captured.to_string());
            }
        }
        search_from = after_prefix;
    }
    None
}

/// TS `NORMALIZED_UNSUPPORTED_MODEL_PATTERN` capture.
fn match_normalized_unsupported(output_lower: &str) -> Option<String> {
    find_quoted_capture(output_lower, "model ", NORMALIZED_SUFFIX, &['\'', '"'])
}

/// TS `MODEL_ACCESS_DENIED_PATTERN` capture.
fn match_access_denied(output_lower: &str) -> Option<String> {
    find_quoted_capture(output_lower, "the model ", ACCESS_DENIED_SUFFIX, &['`', '\'', '"'])
}

/// TS `DIRECT_UNSUPPORTED_MODEL_PATTERN` capture —
/// `['"]model['"]\s+model is not supported…`.
fn match_direct_unsupported(output_lower: &str) -> Option<String> {
    let bytes = output_lower.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '\'' || c == '"' {
            let open = c;
            if let Some(close_rel) = output_lower[i + 1..].find(['\'', '"']) {
                let close_index = i + 1 + close_rel;
                let close_char = output_lower[close_index..].chars().next().unwrap_or(open);
                if close_char == open {
                    let captured = &output_lower[i + 1..close_index];
                    let tail = output_lower[close_index + 1..].trim_start();
                    if !captured.is_empty() && tail.starts_with(UNSUPPORTED_SUBSTRING) {
                        return Some(captured.to_string());
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// TS `extractUnsupportedModelFromOutput(output)`.
pub fn extract_unsupported_model_from_output(output: &str) -> Option<String> {
    if output.is_empty() {
        return None;
    }
    let lower = output.to_ascii_lowercase();
    if let Some(direct) = match_direct_unsupported(&lower) {
        return Some(canonicalize_unsupported_model_key(&direct));
    }
    if let Some(normalized) = match_normalized_unsupported(&lower) {
        return Some(canonicalize_unsupported_model_key(&normalized));
    }
    if let Some(denied) = match_access_denied(&lower) {
        return Some(canonicalize_unsupported_model_key(&denied));
    }
    None
}

fn output_mentions_unsupported_model(output_lower: &str) -> bool {
    contains_ci(output_lower, UNSUPPORTED_SUBSTRING)
        || match_normalized_unsupported(output_lower).is_some()
        || match_access_denied(output_lower).is_some()
}

/// TS `resolveUnsupportedModelRetryTarget(requestedModel, output,
/// attemptedModels)`.
pub fn resolve_unsupported_model_retry_target(
    requested_model: Option<&str>,
    output: &str,
    attempted_models: &[String],
) -> Option<String> {
    if output.is_empty() {
        return None;
    }
    let lower = output.to_ascii_lowercase();
    if !output_mentions_unsupported_model(&lower) {
        return None;
    }
    let attempted: HashSet<String> = attempted_models
        .iter()
        .map(|m| canonicalize_unsupported_model_key(m))
        .filter(|m| !m.is_empty())
        .collect();
    let normalized_requested = requested_model
        .map(canonicalize_unsupported_model_key)
        .unwrap_or_default();
    let blocked_model = extract_unsupported_model_from_output(output).unwrap_or_else(|| {
        normalized_requested.clone()
    });
    let chain = {
        let direct = wrapper_unsupported_model_fallback_chain(&blocked_model);
        if !direct.is_empty() || normalized_requested.is_empty() {
            direct
        } else {
            wrapper_unsupported_model_fallback_chain(&normalized_requested)
        }
    };
    for fallback_model in chain {
        if *fallback_model != blocked_model && !attempted.contains(*fallback_model) {
            return Some((*fallback_model).to_string());
        }
    }
    None
}

/// TS `replaceRequestedModel(args, nextModel)`.
pub fn replace_requested_model(args: &[String], next_model: &str) -> Vec<String> {
    if next_model.is_empty() {
        return args.to_vec();
    }
    let mut next_args = args.to_vec();
    let mut i = 0usize;
    while i < next_args.len() {
        let arg = next_args[i].clone();
        if (arg == "--model" || arg == "-m") && i + 1 < next_args.len() {
            next_args[i + 1] = next_model.to_string();
            return next_args;
        }
        if arg.starts_with("--model=") {
            next_args[i] = format!("--model={next_model}");
            return next_args;
        }
        i += 1;
    }
    next_args
}

// ===========================================================================
// -c cli_auth_credentials_store="file" injection.
// ===========================================================================

/// TS `hasCliAuthCredentialsStoreOverride(args)`.
pub fn has_cli_auth_credentials_store_override(args: &[String]) -> bool {
    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "-c" || arg == "--config" {
            if let Some(next) = args.get(i + 1)
                && next.contains('=')
            {
                let key = next.split('=').next().unwrap_or("");
                if key.trim() == "cli_auth_credentials_store" {
                    return true;
                }
            }
            i += 1;
        } else if let Some(assignment) = arg.strip_prefix("--config=") {
            let key = assignment.split('=').next().unwrap_or("");
            if key.trim() == "cli_auth_credentials_store" {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// TS `buildForwardArgs(rawArgs)` — reasoning coercion + credentials-store
/// injection (opt-out `CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE=0`).
pub fn build_forward_args(raw_args: &[String]) -> (Vec<String>, Option<String>) {
    let (compatibility_args, requested_model) = rewrite_reasoning_config_args(raw_args);
    let force_file_auth_store = std::env::var("CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE")
        .unwrap_or_else(|_| "1".to_string())
        .trim()
        != "0";
    if !force_file_auth_store || has_cli_auth_credentials_store_override(&compatibility_args) {
        return (compatibility_args, requested_model);
    }
    let mut args = compatibility_args;
    args.push("-c".to_string());
    args.push("cli_auth_credentials_store=\"file\"".to_string());
    (args, requested_model)
}

// ===========================================================================
// Runtime rotation proxy enablement.
// ===========================================================================

fn warned_invalid_runtime_rotation_proxy_env() -> &'static AtomicBool {
    static CELL: OnceLock<AtomicBool> = OnceLock::new();
    CELL.get_or_init(|| AtomicBool::new(false))
}

/// TS `parseRuntimeRotationProxyEnv(value)` — warn-once on invalid values.
pub fn parse_runtime_rotation_proxy_env(value: Option<&str>) -> Option<bool> {
    let value = value?;
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    match normalized.as_str() {
        "1" | "true" | "yes" => Some(true),
        "0" | "false" | "no" => Some(false),
        _ => {
            if !warned_invalid_runtime_rotation_proxy_env().swap(true, Ordering::SeqCst) {
                eprintln!(
                    "codex-multi-auth: ignoring invalid CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY value. Expected 0/1, true/false, or yes/no."
                );
            }
            None
        }
    }
}

/// TS `isRuntimeRotationProxyEnabled(rawArgs, baseEnv)` — BYPASS gate, arg
/// routing gate, env override, then config.
pub async fn is_runtime_rotation_proxy_enabled(raw_args: &[String]) -> bool {
    if env_string("CODEX_MULTI_AUTH_BYPASS").trim() == "1" {
        return false;
    }
    if !should_use_runtime_routing_for_forwarded_args(raw_args) {
        return false;
    }
    let env_value = std::env::var("CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY").ok();
    if let Some(env_override) = parse_runtime_rotation_proxy_env(env_value.as_deref()) {
        return env_override;
    }
    let plugin_config = cma_config::load::load_plugin_config();
    cma_config::getters::get_codex_runtime_rotation_proxy(&plugin_config)
}

/// TS `createRuntimeRotationProxyClientApiKey()` — 32 random bytes hex.
pub fn create_runtime_rotation_proxy_client_api_key() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ===========================================================================
// Forward context assembly.
// ===========================================================================

enum ForwardCleanup {
    None,
    CompatShadow(ShadowHomeContext),
    Proxy {
        shadow: ShadowHomeContext,
        server: cma_proxy::server::RuntimeRotationProxyServer,
        base: Box<ForwardCleanup>,
    },
    AppHelper {
        helper: tokio::process::Child,
        started_at: i64,
        detach_on_exit: bool,
        base: Box<ForwardCleanup>,
    },
}

impl ForwardCleanup {
    /// Iterative (non-recursive) cleanup chain — TS parity: each context's
    /// cleanup ends by invoking `baseContext.cleanup?.()`.
    async fn run(self, exit_code: i32) {
        let mut current = self;
        loop {
            match current {
                ForwardCleanup::None => return,
                ForwardCleanup::CompatShadow(shadow) => {
                    shadow.cleanup();
                    return;
                }
                ForwardCleanup::Proxy {
                    shadow,
                    server,
                    base,
                } => {
                    shadow.cleanup();
                    let _ = server.close().await;
                    current = *base;
                }
                ForwardCleanup::AppHelper {
                    mut helper,
                    started_at,
                    detach_on_exit,
                    base,
                } => {
                    let lived_ms = cma_core::utils::now_ms() - started_at;
                    let detach_grace_ms = resolve_app_helper_detach_grace_ms();
                    if exit_code == 0 && (detach_on_exit || lived_ms < detach_grace_ms) {
                        // Let the helper keep serving (idle timeout reclaims it).
                        drop(helper.stdout.take());
                        drop(helper.stderr.take());
                    } else {
                        stop_runtime_rotation_app_helper(&mut helper).await;
                    }
                    current = *base;
                }
            }
        }
    }
}

struct ForwardContext {
    args: Vec<String>,
    env_overrides: HashMap<String, String>,
    env_removals: Vec<String>,
    cleanup: ForwardCleanup,
    proxy_app_server_account_read: bool,
}

/// TS `createCompatibilityCodexHome(processedArgs, requestedModel, baseEnv)`
/// — when the requested model needs a coerced `model_reasoning_effort` in
/// config.toml, run codex against a temp shadow home carrying the rewritten
/// config.
fn create_compatibility_codex_home(
    processed_args: Vec<String>,
    requested_model: Option<&str>,
) -> ForwardContext {
    let base = ForwardContext {
        args: processed_args,
        env_overrides: HashMap::new(),
        env_removals: Vec::new(),
        cleanup: ForwardCleanup::None,
        proxy_app_server_account_read: false,
    };
    let Some(requested_model) = requested_model else {
        return base;
    };
    let env_map = process_env_map();
    let original_codex_home = resolve_codex_home_dir(&env_map);
    let config_path = original_codex_home.join("config.toml");
    if !config_path.exists() {
        return base;
    }
    let Ok(raw_config) = fs::read_to_string(&config_path) else {
        return base;
    };
    let compat_config = rewrite_config_toml_reasoning_effort(&raw_config, requested_model);
    if compat_config == raw_config {
        return base;
    }

    // mkdtemp(join(tmpdir(), "codex-multi-auth-home-")).
    let shadow_codex_home = {
        let mut created: Option<PathBuf> = None;
        for _ in 0..64 {
            let candidate = std::env::temp_dir().join(format!(
                "codex-multi-auth-home-{}",
                create_runtime_rotation_proxy_client_api_key()
                    .chars()
                    .take(12)
                    .collect::<String>()
            ));
            if fs::create_dir(&candidate).is_ok() {
                created = Some(candidate);
                break;
            }
        }
        match created {
            Some(path) => path,
            None => return base,
        }
    };

    let mirror = create_shadow_home_mirror(
        &original_codex_home,
        &shadow_codex_home,
        MirrorOptions::default(),
    );
    let sync_back = match mirror {
        Ok(sync_back) => sync_back,
        Err(_) => {
            let _ = remove_directory_with_retry(&shadow_codex_home);
            return base;
        }
    };
    let compat_config_path = shadow_codex_home.join("config.toml");
    if fs::write(&compat_config_path, &compat_config).is_err() {
        let _ = remove_directory_with_retry(&shadow_codex_home);
        return base;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&compat_config_path, fs::Permissions::from_mode(0o600));
    }

    let mut env_overrides = HashMap::new();
    env_overrides.insert(
        "CODEX_HOME".to_string(),
        shadow_codex_home.display().to_string(),
    );
    if let Some(dir) = resolve_original_multi_auth_dir(&env_map) {
        env_overrides.insert("CODEX_MULTI_AUTH_DIR".to_string(), dir);
    }

    let shadow_context = ShadowHomeContext::from_parts(shadow_codex_home, sync_back);
    ForwardContext {
        args: base.args,
        env_overrides,
        env_removals: Vec::new(),
        cleanup: ForwardCleanup::CompatShadow(shadow_context),
        proxy_app_server_account_read: false,
    }
}

fn provider_config_args() -> [String; 2] {
    [
        "-c".to_string(),
        format!(
            "model_provider={}",
            cma_runtime::config_toml::toml_string_literal(
                cma_core::constants::RUNTIME_ROTATION_PROXY_PROVIDER_ID
            )
        ),
    ]
}

/// TS `createRuntimeRotationProxyContextIfEnabled(baseContext, rawArgs)`.
async fn create_runtime_rotation_proxy_context_if_enabled(
    base: ForwardContext,
    raw_args: &[String],
    forced_account_index: Option<usize>,
) -> ForwardContext {
    if !is_runtime_rotation_proxy_enabled(raw_args).await {
        return base;
    }

    if is_codex_app_command(raw_args) {
        return create_runtime_rotation_app_helper_context(base, false).await;
    }
    if is_codex_interactive_tui_command(raw_args) {
        return create_runtime_rotation_app_helper_context(base, true).await;
    }

    // In-process proxy for request-shaped commands.
    let client_api_key = create_runtime_rotation_proxy_client_api_key();
    let options = cma_runtime::rotation::server_types::RuntimeRotationProxyOptions {
        client_api_key: client_api_key.clone(),
        forced_account_index: forced_account_index.map(|i| i as i64),
        // No `--account` on this run: the wrapper resolved "no pin", so the
        // proxy must ignore any ambient CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX
        // (TS deletes the env var; a request without --account can never
        // inherit an unintended pin).
        suppress_env_forced_account_index: forced_account_index.is_none(),
        ..Default::default()
    };
    let server = match cma_proxy::server::start_runtime_rotation_proxy(options).await {
        Ok(server) => server,
        Err(error) => {
            eprintln!(
                "codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: {error}"
            );
            return base;
        }
    };

    let mut base_env = process_env_map();
    for (key, value) in &base.env_overrides {
        base_env.insert(key.clone(), value.clone());
    }
    let shadow = match create_runtime_rotation_proxy_codex_home(
        &base_env,
        &server.base_url,
        &client_api_key,
    ) {
        Ok(shadow) => shadow,
        Err(error) => {
            let _ = server.close().await;
            eprintln!(
                "codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: {error}"
            );
            return base;
        }
    };

    let mut args = base.args.clone();
    args.extend(provider_config_args());
    let mut env_overrides = base.env_overrides.clone();
    for (key, value) in &shadow.env {
        env_overrides.insert(key.clone(), value.clone());
    }
    ForwardContext {
        args,
        env_overrides,
        env_removals: base.env_removals.clone(),
        cleanup: ForwardCleanup::Proxy {
            shadow,
            server,
            base: Box::new(base.cleanup),
        },
        proxy_app_server_account_read: is_codex_app_server_command(raw_args),
    }
}

// ===========================================================================
// App runtime helper (detached self-spawn for `codex app` / interactive TUI).
// ===========================================================================

/// TS `resolveRuntimeRotationAppHelperStatusPath(env)`.
pub fn resolve_runtime_rotation_app_helper_status_path() -> PathBuf {
    let env_map = process_env_map();
    let multi_auth_dir = resolve_original_multi_auth_dir(&env_map)
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_codex_home_dir(&env_map).join("multi-auth"));
    multi_auth_dir.join(cma_core::constants::APP_RUNTIME_HELPER_STATUS_FILE)
}

fn resolve_app_helper_idle_ms() -> i64 {
    match env_string("CODEX_MULTI_AUTH_APP_ROTATION_IDLE_MS").trim().parse::<i64>() {
        Ok(parsed) if parsed > 0 => parsed.max(50),
        _ => DEFAULT_APP_RUNTIME_HELPER_IDLE_MS,
    }
}

fn resolve_app_helper_owner_pid() -> Option<i64> {
    match env_string(APP_RUNTIME_HELPER_OWNER_PID_ENV).trim().parse::<i64>() {
        Ok(parsed) if parsed > 0 => Some(parsed),
        _ => None,
    }
}

fn resolve_app_helper_detach_grace_ms() -> i64 {
    match env_string("CODEX_MULTI_AUTH_APP_ROTATION_DETACH_GRACE_MS")
        .trim()
        .parse::<i64>()
    {
        Ok(parsed) if parsed >= 0 => parsed,
        _ => DEFAULT_APP_RUNTIME_HELPER_DETACH_GRACE_MS,
    }
}

/// TS `pickRuntimeRotationAppHelperEnv(env)`.
fn pick_runtime_rotation_app_helper_env(env: &HashMap<String, String>) -> serde_json::Map<String, Value> {
    let mut picked = serde_json::Map::new();
    picked.insert(
        "CODEX_HOME".to_string(),
        env.get("CODEX_HOME").cloned().map(Value::String).unwrap_or(Value::Null),
    );
    picked.insert(
        "OPENAI_API_KEY".to_string(),
        env.get("OPENAI_API_KEY").cloned().map(Value::String).unwrap_or(Value::Null),
    );
    for name in [
        "CODEX_CLI_PATH",
        "NODE_OPTIONS",
        "CODEX_MULTI_AUTH_REAL_CODEX_BIN",
        "CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY",
        APP_SERVER_ACCOUNT_LABEL_ENV,
    ] {
        if let Some(value) = env.get(name).filter(|v| !v.is_empty()) {
            picked.insert(name.to_string(), Value::String(value.clone()));
        }
    }
    if let Some(dir) = env.get("CODEX_MULTI_AUTH_DIR").filter(|v| !v.is_empty()) {
        picked.insert("CODEX_MULTI_AUTH_DIR".to_string(), Value::String(dir.clone()));
    }
    picked
}

/// TS `createRuntimeRotationAppHelperStatus({...})`.
fn create_app_helper_status(
    proxy_status: Option<&cma_runtime::rotation::server_types::RuntimeRotationProxyStatus>,
    base_url: Option<&str>,
    started_at: i64,
    idle_timeout_ms: i64,
    last_activity_at: i64,
    state: &str,
) -> Value {
    let last_account_index = proxy_status.and_then(|s| s.last_account_index);
    let last_account_label = proxy_status
        .and_then(|s| s.last_account_label.clone())
        .filter(|label| !label.contains('@'))
        .or_else(|| last_account_index.map(|index| format!("Account {}", index + 1)));
    serde_json::json!({
        "version": 1,
        "kind": "codex-app-runtime-rotation-helper",
        "state": state,
        "pid": std::process::id(),
        "startedAt": started_at,
        "updatedAt": cma_core::utils::now_ms(),
        "baseUrl": base_url,
        "idleTimeoutMs": idle_timeout_ms,
        "idleExpiresAt": last_activity_at + idle_timeout_ms,
        "totalRequests": proxy_status.map(|s| s.total_requests).unwrap_or(0),
        "upstreamRequests": proxy_status.map(|s| s.upstream_requests).unwrap_or(0),
        "retries": proxy_status.map(|s| s.retries).unwrap_or(0),
        "rotations": proxy_status.map(|s| s.rotations).unwrap_or(0),
        "lastAccountIndex": last_account_index,
        "lastAccountLabel": last_account_label,
        "lastAccountId": proxy_status.and_then(|s| s.last_account_id.clone()),
        "lastAccountUpdatedAt": proxy_status.and_then(|s| s.last_account_updated_at),
        "lastError": proxy_status.and_then(|s| s.last_error.clone()),
    })
}

fn write_app_helper_status(payload: &Value) {
    let status_path = resolve_runtime_rotation_app_helper_status_path();
    let _ = write_owner_only_json_file_atomic_sync(&status_path, payload);
}

/// TS `sweepStaleRuntimeRotationAppServerShimDirs(shimRootDir)`.
fn sweep_stale_app_server_shim_dirs(shim_root_dir: &Path) {
    let Ok(entries) = fs::read_dir(shim_root_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir || !name.starts_with(APP_SERVER_SHIM_HELPER_PREFIX) {
            continue;
        }
        let pid_text = &name[APP_SERVER_SHIM_HELPER_PREFIX.len()..];
        let Ok(pid) = pid_text.parse::<i64>() else {
            continue;
        };
        if pid <= 0
            || pid == std::process::id() as i64
            || cma_runtime::app_bind::is_process_alive(Some(pid))
        {
            continue;
        }
        let _ = remove_directory_with_retry(&shim_root_dir.join(&name));
    }
}

/// TS `installRuntimeRotationAppServerCliShim(forwardedEnv)`.
///
/// Deviation vs TS: the Node build materialized a `node` executable + a
/// `NODE_OPTIONS --import` preload; the Rust build hardlinks/copies THIS
/// wrapper binary as `codex[.exe]` into the shim dir — when the packaged app
/// spawns `<shim>/codex app-server …`, the wrapper (with
/// `CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY=0` +
/// `CODEX_MULTI_AUTH_APP_SERVER_ACCOUNT_LABEL=1`) forwards to the real codex
/// with the account-read protocol proxy, matching the preload's effect.
fn install_runtime_rotation_app_server_cli_shim(
    forwarded_env: &mut HashMap<String, String>,
) -> io::Result<PathBuf> {
    if !forwarded_env.contains_key("CODEX_HOME") {
        return Err(io::Error::other("runtime app-server shim requires CODEX_HOME"));
    }
    let env_map = process_env_map();
    let multi_auth_dir = resolve_original_multi_auth_dir(forwarded_env)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            resolve_runtime_rotation_proxy_original_codex_home(&env_map).join("multi-auth")
        });
    let shim_root_dir = multi_auth_dir.join(APP_SERVER_SHIM_DIR_NAME);
    sweep_stale_app_server_shim_dirs(&shim_root_dir);
    let shim_dir = shim_root_dir.join(format!(
        "{APP_SERVER_SHIM_HELPER_PREFIX}{}",
        std::process::id()
    ));
    fs::create_dir_all(&shim_dir)?;
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let executable_path = shim_dir.join(executable_name);
    let result = (|| -> io::Result<()> {
        let _ = fs::remove_file(&executable_path);
        let self_exe = std::env::current_exe()?;
        if fs::hard_link(&self_exe, &executable_path).is_err() {
            fs::copy(&self_exe, &executable_path)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&executable_path, fs::Permissions::from_mode(0o755));
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = remove_directory_with_retry(&shim_dir);
        return Err(error);
    }
    forwarded_env.insert("CODEX_CLI_PATH".to_string(), shim_dir.display().to_string());
    forwarded_env.insert(
        "CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY".to_string(),
        "0".to_string(),
    );
    forwarded_env.insert(APP_SERVER_ACCOUNT_LABEL_ENV.to_string(), "1".to_string());
    Ok(shim_dir)
}

/// TS `runRuntimeRotationAppHelper()` — the helper-child main (invoked with
/// [`INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG`]). Returns the exit code.
pub async fn run_runtime_rotation_app_helper() -> i32 {
    let started_at = cma_core::utils::now_ms();
    let idle_timeout_ms = resolve_app_helper_idle_ms();
    let owner_pid = resolve_app_helper_owner_pid();
    let mut last_activity_at = started_at;

    let client_api_key = create_runtime_rotation_proxy_client_api_key();
    let options = cma_runtime::rotation::server_types::RuntimeRotationProxyOptions {
        client_api_key: client_api_key.clone(),
        ..Default::default()
    };
    let startup = async {
        let server = cma_proxy::server::start_runtime_rotation_proxy(options)
            .await
            .map_err(|e| e.to_string())?;
        let base_env = process_env_map();
        let shadow =
            create_runtime_rotation_proxy_codex_home(&base_env, &server.base_url, &client_api_key)
                .map_err(|e| e.to_string())?;
        Ok::<_, String>((server, shadow))
    };
    let (server, shadow) = match startup.await {
        Ok(parts) => parts,
        Err(message) => {
            println!(
                "{}",
                cma_core::json_io::stringify_compact(&serde_json::json!({
                    "type": "error",
                    "message": message,
                }))
            );
            write_app_helper_status(&create_app_helper_status(
                None,
                None,
                started_at,
                idle_timeout_ms,
                last_activity_at,
                "error",
            ));
            return 1;
        }
    };

    let mut helper_env: HashMap<String, String> = process_env_map();
    for (key, value) in &shadow.env {
        helper_env.insert(key.clone(), value.clone());
    }
    let shim_dir = match install_runtime_rotation_app_server_cli_shim(&mut helper_env) {
        Ok(dir) => Some(dir),
        Err(error) => {
            println!(
                "{}",
                cma_core::json_io::stringify_compact(&serde_json::json!({
                    "type": "error",
                    "message": error.to_string(),
                }))
            );
            shadow.cleanup();
            let _ = server.close().await;
            write_app_helper_status(&create_app_helper_status(
                None,
                None,
                started_at,
                idle_timeout_ms,
                last_activity_at,
                "error",
            ));
            return 1;
        }
    };

    async fn publish_status(
        server: &cma_proxy::server::RuntimeRotationProxyServer,
        started_at: i64,
        idle_timeout_ms: i64,
        last_activity_at: i64,
        state: &str,
    ) {
        let status = server.get_status().await;
        write_app_helper_status(&create_app_helper_status(
            Some(&status),
            Some(&server.base_url),
            started_at,
            idle_timeout_ms,
            last_activity_at,
            state,
        ));
    }
    let mut last_request_count = server.get_status().await.total_requests;
    publish_status(&server, started_at, idle_timeout_ms, last_activity_at, "running").await;
    println!(
        "{}",
        cma_core::json_io::stringify_compact(&serde_json::json!({
            "type": "ready",
            "pid": std::process::id(),
            "baseUrl": server.base_url,
            "statusPath": resolve_runtime_rotation_app_helper_status_path().display().to_string(),
            "env": Value::Object(pick_runtime_rotation_app_helper_env(&helper_env)),
        }))
    );
    use std::io::Write;
    let _ = std::io::stdout().flush();

    let tick_ms = (idle_timeout_ms / 2).clamp(50, 1_000) as u64;
    let mut interval = tokio::time::interval(Duration::from_millis(tick_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let stop_state: (&str, i32) = tokio::select! {
            _ = interval.tick() => {
                let current_time = cma_core::utils::now_ms();
                let request_count = server.get_status().await.total_requests;
                if request_count != last_request_count {
                    last_request_count = request_count;
                    last_activity_at = current_time;
                }
                if let Some(owner) = owner_pid
                    && cma_runtime::app_bind::is_process_alive(Some(owner))
                {
                    last_activity_at = current_time;
                }
                publish_status(&server, started_at, idle_timeout_ms, last_activity_at, "running")
                    .await;
                if current_time - last_activity_at >= idle_timeout_ms {
                    ("idle-timeout", 0)
                } else {
                    continue;
                }
            }
            _ = tokio::signal::ctrl_c() => ("stopped", 130),
        };
        let (state, exit_code) = stop_state;
        if let Some(shim_dir) = &shim_dir {
            let _ = remove_directory_with_retry(shim_dir);
        }
        publish_status(&server, started_at, idle_timeout_ms, last_activity_at, state).await;
        shadow.cleanup();
        let _ = server.close().await;
        return exit_code;
    }
}

async fn stop_runtime_rotation_app_helper(helper: &mut tokio::process::Child) {
    // SIGTERM-flavored stop with a 2 s grace, then hard kill (TS parity: the
    // Node helper handled SIGTERM by cleaning up and exiting 0).
    #[cfg(unix)]
    {
        if let Some(pid) = helper.id() {
            let _ = tokio::process::Command::new("kill")
                .arg(pid.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = helper.start_kill();
    }
    let _ = tokio::time::timeout(Duration::from_millis(2_000), helper.wait()).await;
    let _ = helper.start_kill();
    let _ = tokio::time::timeout(Duration::from_millis(200), helper.wait()).await;
}

/// TS `startRuntimeRotationAppHelper(baseContext)` +
/// `createRuntimeRotationAppHelperContext` — spawn the detached helper, await
/// its `ready` line, merge its env into the forwarded context.
async fn create_runtime_rotation_app_helper_context(
    base: ForwardContext,
    detach_on_exit: bool,
) -> ForwardContext {
    let env_map = {
        let mut merged = process_env_map();
        for (key, value) in &base.env_overrides {
            merged.insert(key.clone(), value.clone());
        }
        merged
    };
    let real_codex_home = resolve_runtime_rotation_proxy_original_codex_home(&env_map);
    let self_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!(
                "codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: {error}"
            );
            return base;
        }
    };

    let mut command = tokio::process::Command::new(&self_exe);
    command
        .arg(INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG)
        .envs(&base.env_overrides)
        .env(
            "CODEX_MULTI_AUTH_DIR",
            resolve_runtime_rotation_original_multi_auth_dir(&real_codex_home, &env_map),
        );
    // Apply the launcher's env scrubs to the detached helper too: without
    // this the helper inherits a stray CODEX_MULTI_AUTH_FORCE_ACCOUNT_INDEX
    // (published by a parent forced run) and its proxy silently pins to one
    // account via the env fallback, defeating rotation. TS deletes the var
    // from process.env, which covers every child.
    for key in &base.env_removals {
        command.env_remove(key);
    }
    command
        .env(APP_RUNTIME_HELPER_OWNER_PID_ENV, std::process::id().to_string())
        .env(
            APP_RUNTIME_HELPER_REAL_CODEX_HOME_ENV,
            real_codex_home.display().to_string(),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — survives the parent.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut helper = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: {error}"
            );
            return base;
        }
    };

    // Await the first stdout line ("ready" or "error") with the launch budget.
    let ready = async {
        use tokio::io::AsyncBufReadExt;
        let stdout = helper.stdout.take().ok_or_else(|| "no helper stdout".to_string())?;
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let line = lines
            .next_line()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "runtime rotation app helper exited before startup".to_string())?;
        let message: Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
        if message.get("type").and_then(Value::as_str) == Some("ready")
            && message.get("env").is_some_and(Value::is_object)
            && message.get("pid").is_some()
        {
            return Ok::<Value, String>(message);
        }
        Err(message
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("runtime rotation app helper returned an invalid startup response")
            .to_string())
    };
    let message = match tokio::time::timeout(
        Duration::from_millis(APP_RUNTIME_HELPER_LAUNCH_TIMEOUT_MS),
        ready,
    )
    .await
    {
        Ok(Ok(message)) => message,
        Ok(Err(error)) => {
            stop_runtime_rotation_app_helper(&mut helper).await;
            eprintln!(
                "codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: {error}"
            );
            return base;
        }
        Err(_) => {
            stop_runtime_rotation_app_helper(&mut helper).await;
            eprintln!(
                "codex-multi-auth runtime rotation proxy failed to start; continuing without runtime rotation: timed out waiting for runtime rotation app helper"
            );
            return base;
        }
    };

    let mut env_overrides = base.env_overrides.clone();
    if let Some(env_object) = message.get("env").and_then(Value::as_object) {
        for (key, value) in env_object {
            if let Some(value) = value.as_str() {
                env_overrides.insert(key.clone(), value.to_string());
            }
        }
    }
    let mut args = base.args.clone();
    args.extend(provider_config_args());
    ForwardContext {
        args,
        env_overrides,
        env_removals: base.env_removals.clone(),
        cleanup: ForwardCleanup::AppHelper {
            helper,
            started_at: cma_core::utils::now_ms(),
            detach_on_exit,
            base: Box::new(base.cleanup),
        },
        proxy_app_server_account_read: false,
    }
}

// ===========================================================================
// app-server account/read protocol proxy (JSON-RPC line rewriting).
// ===========================================================================

/// TS `jsonRpcIdKey(id)`.
pub fn json_rpc_id_key(id: &Value) -> Option<String> {
    match id {
        Value::String(s) => Some(format!("string:{}", cma_core::json_io::stringify_compact(s))),
        Value::Number(_) => Some(format!("number:{}", cma_core::json_io::stringify_compact(id))),
        Value::Bool(_) => Some(format!("boolean:{}", cma_core::json_io::stringify_compact(id))),
        Value::Null => Some("object:null".to_string()),
        _ => None,
    }
}

/// TS `parseJsonObjectLine(line)`.
pub fn parse_json_object_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let parsed: Value = serde_json::from_str(trimmed).ok()?;
    if parsed.is_object() { Some(parsed) } else { None }
}

/// TS `splitProtocolLineEnding(line)`.
pub fn split_protocol_line_ending(line: &str) -> (&str, &str) {
    if let Some(body) = line.strip_suffix("\r\n") {
        return (body, "\r\n");
    }
    if let Some(body) = line.strip_suffix('\n') {
        return (body, "\n");
    }
    (line, "")
}

fn synthetic_account_read_result() -> Value {
    serde_json::json!({
        "account": {
            "type": "chatgpt",
            "email": APP_SERVER_ACCOUNT_DISPLAY_NAME,
            "planType": "unknown",
        },
        "requiresOpenaiAuth": false,
    })
}

fn synthetic_auth_status_result() -> Value {
    serde_json::json!({
        "authMethod": "apikey",
        "authToken": null,
        "requiresOpenaiAuth": false,
    })
}

fn synthetic_rate_limits_result() -> Value {
    serde_json::json!({
        "rateLimits": {
            "limitId": null,
            "limitName": null,
            "primary": null,
            "secondary": null,
            "credits": null,
            "planType": null,
            "rateLimitReachedType": null,
        },
        "rateLimitsByLimitId": null,
    })
}

const MAX_PENDING_AUTH_REQUEST_IDS: usize = 4096;

fn warned_pending_overflow() -> &'static AtomicBool {
    static CELL: OnceLock<AtomicBool> = OnceLock::new();
    CELL.get_or_init(|| AtomicBool::new(false))
}

/// Observe a client→server line; records pending auth-read request ids.
pub fn observe_app_server_request_line(
    line: &str,
    pending: &mut std::collections::HashMap<String, String>,
) {
    let (body, _) = split_protocol_line_ending(line);
    let Some(message) = parse_json_object_line(body) else {
        return;
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        method,
        "account/read" | "account/rateLimits/read" | "getAuthStatus"
    ) || !message
        .as_object()
        .is_some_and(|o| o.contains_key("id"))
    {
        return;
    }
    if let Some(key) = message.get("id").and_then(json_rpc_id_key) {
        if pending.len() >= MAX_PENDING_AUTH_REQUEST_IDS {
            pending.clear();
            if !warned_pending_overflow().swap(true, Ordering::SeqCst) {
                eprintln!(
                    "codex-multi-auth: cleared pending app-server auth request ids after exceeding the safety cap."
                );
            }
        }
        pending.insert(key, method.to_string());
    }
}

/// TS `rewriteAppServerAccountReadResponseLine(line, pending)`.
pub fn rewrite_app_server_account_read_response_line(
    line: &str,
    pending: &mut std::collections::HashMap<String, String>,
) -> String {
    let (body, line_ending) = split_protocol_line_ending(line);
    let Some(message) = parse_json_object_line(body) else {
        return line.to_string();
    };
    if !message.as_object().is_some_and(|o| o.contains_key("id")) {
        return line.to_string();
    }
    let Some(key) = message.get("id").and_then(json_rpc_id_key) else {
        return line.to_string();
    };
    let Some(method) = pending.remove(&key) else {
        return line.to_string();
    };
    let result = match method.as_str() {
        "account/read" => synthetic_account_read_result(),
        "account/rateLimits/read" => synthetic_rate_limits_result(),
        "getAuthStatus" => synthetic_auth_status_result(),
        _ => return line.to_string(),
    };
    let jsonrpc = message
        .get("jsonrpc")
        .and_then(Value::as_str)
        .unwrap_or("2.0");
    format!(
        "{}{}",
        cma_core::json_io::stringify_compact(&serde_json::json!({
            "jsonrpc": jsonrpc,
            "id": message.get("id").cloned().unwrap_or(Value::Null),
            "result": result,
        })),
        line_ending
    )
}

/// Streaming line accumulator (TS `createProtocolLineAccumulator`).
pub struct ProtocolLineAccumulator {
    buffer: String,
}

impl ProtocolLineAccumulator {
    pub fn new() -> Self {
        Self { buffer: String::new() }
    }

    /// Feed a chunk; returns complete lines (each INCLUDING its newline).
    pub fn write(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        let mut lines = Vec::new();
        while let Some(newline_index) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline_index).collect();
            lines.push(line);
        }
        lines
    }

    /// Flush the trailing partial line (if any).
    pub fn end(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buffer))
        }
    }
}

impl Default for ProtocolLineAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

// ===========================================================================
// Forwarded output capture / filtering.
// ===========================================================================

/// TS `shouldCaptureForwardedCodexOutput(env)`.
pub fn should_capture_forwarded_codex_output() -> bool {
    let override_value = env_string("CODEX_MULTI_AUTH_CAPTURE_FORWARD_OUTPUT");
    let override_value = override_value.trim();
    if override_value == "1" {
        return true;
    }
    if override_value == "0" {
        return false;
    }
    if env_string("CODEX_CI").trim() == "1" {
        return true;
    }
    use std::io::IsTerminal;
    !(std::io::stdout().is_terminal() && std::io::stderr().is_terminal())
}

fn should_capture_forwarded_output_for_args(raw_args: &[String]) -> bool {
    if is_codex_app_server_command(raw_args) {
        return false;
    }
    should_capture_forwarded_codex_output()
}

fn is_uuid_not_found_line(line: &str) -> bool {
    // /^[0-9a-f]{8}-…-[0-9a-f]{12} not found$/i
    let Some(rest) = line
        .to_ascii_lowercase()
        .strip_suffix(" not found")
        .map(str::to_string)
    else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    parts.len() == 5
        && [8usize, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(len, part)| part.len() == *len && part.chars().all(|c| c.is_ascii_hexdigit()))
}

/// TS `filterKnownForwardedCodexStderr(text)` — drops the known-noise rollout
/// + rmcp session-delete error pairs.
pub fn filter_known_forwarded_codex_stderr(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = text.split("\r\n").flat_map(|s| s.split('\n')).collect();
    let mut filtered: Vec<&str> = Vec::with_capacity(lines.len());
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let next = lines.get(index + 1).copied().unwrap_or("");
        if line
            .trim_end()
            .ends_with("ERROR codex_core::session: failed to record rollout items: thread")
            && line.contains("ERROR codex_core::session: failed to record rollout items: thread")
            && is_uuid_not_found_line(next)
        {
            index += 2;
            continue;
        }
        if line
            .trim_end()
            .ends_with("ERROR rmcp::transport::streamable_http_client: fail to delete session:")
            && next.starts_with("unexpected server response: DELETE returned HTTP 404 session_id=\"")
        {
            index += 1; // skip the current line; scan forward past the payload
            while index + 1 < lines.len() && !lines[index].trim_end().ends_with('"') {
                index += 1;
            }
            index += 1;
            continue;
        }
        filtered.push(line);
        index += 1;
    }
    filtered.join("\n")
}

/// TS `withCiKnownForwardedCodexLogSilencers(env)` — returns the RUST_LOG
/// override to add (only under `CODEX_CI=1` with no explicit RUST_LOG).
fn ci_known_forwarded_codex_log_silencer() -> Option<(String, String)> {
    if env_string("CODEX_CI").trim() != "1" {
        return None;
    }
    if !env_string("RUST_LOG").trim().is_empty() {
        return None;
    }
    Some(("RUST_LOG".to_string(), "codex_core::session=off".to_string()))
}

// ===========================================================================
// Spawning the official codex.
// ===========================================================================

struct ForwardOnceResult {
    exit_code: i32,
    output: String,
}

fn exit_code_from_status(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return if signal == 2 { 130 } else { 1 };
        }
    }
    status.code().unwrap_or(1)
}

/// TS `forwardToRealCodexOnce(codexBin, args, env, cleanup, options)`.
async fn forward_to_real_codex_once(
    codex_bin: &ResolvedCodexBin,
    args: &[String],
    env_overrides: &HashMap<String, String>,
    env_removals: &[String],
    cleanup: ForwardCleanup,
    capture_output: bool,
    proxy_app_server_account_read: bool,
) -> ForwardOnceResult {
    let (program, command_args): (PathBuf, Vec<String>) = if codex_bin.launch_with_node {
        (
            PathBuf::from("node"),
            std::iter::once(codex_bin.path.display().to_string())
                .chain(args.iter().cloned())
                .collect(),
        )
    } else {
        (codex_bin.path.clone(), args.to_vec())
    };

    let mut command = tokio::process::Command::new(&program);
    command.args(&command_args);
    for (key, value) in env_overrides {
        command.env(key, value);
    }
    for key in env_removals {
        command.env_remove(key);
    }
    if capture_output && let Some((key, value)) = ci_known_forwarded_codex_log_silencer() {
        command.env(key, value);
    }

    if proxy_app_server_account_read {
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
    } else if capture_output {
        command
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
    } else {
        command
            .stdin(std::process::Stdio::inherit())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit());
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Failed to launch real Codex CLI: {error}");
            eprintln!("{message}");
            cleanup.run(1).await;
            return ForwardOnceResult {
                exit_code: 1,
                output: message,
            };
        }
    };

    if proxy_app_server_account_read {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let pending: Arc<Mutex<std::collections::HashMap<String, String>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));

        // stdin passthrough + observation. The workspace tokio build has no
        // `io-std` feature, so a blocking reader thread bridges our stdin
        // into the async writer via a channel.
        let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdin = std::io::stdin();
            let mut buf = vec![0u8; 8192];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if stdin_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let mut child_stdin = child.stdin.take();
        let pending_in = Arc::clone(&pending);
        let stdin_task = tokio::spawn(async move {
            let mut accumulator = ProtocolLineAccumulator::new();
            while let Some(chunk_bytes) = stdin_rx.recv().await {
                let chunk = String::from_utf8_lossy(&chunk_bytes).into_owned();
                {
                    let mut pending = pending_in.lock().expect("pending poisoned");
                    for line in accumulator.write(&chunk) {
                        observe_app_server_request_line(&line, &mut pending);
                    }
                }
                if let Some(stdin_pipe) = child_stdin.as_mut()
                    && stdin_pipe.write_all(&chunk_bytes).await.is_err()
                {
                    break;
                }
            }
            if let Some(rest) = accumulator.end() {
                let mut pending = pending_in.lock().expect("pending poisoned");
                observe_app_server_request_line(&rest, &mut pending);
            }
            if let Some(mut stdin_pipe) = child_stdin.take() {
                let _ = stdin_pipe.shutdown().await;
            }
        });

        // stdout rewrite (sync writes to our stdout are line-scale).
        let mut child_stdout = child.stdout.take();
        let pending_out = Arc::clone(&pending);
        let stdout_task = tokio::spawn(async move {
            use std::io::Write;
            let Some(stdout) = child_stdout.as_mut() else {
                return;
            };
            let mut accumulator = ProtocolLineAccumulator::new();
            let mut buf = vec![0u8; 8192];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let lines = accumulator.write(&chunk);
                        let mut out = std::io::stdout();
                        let mut pending = pending_out.lock().expect("pending poisoned");
                        for line in lines {
                            let rewritten =
                                rewrite_app_server_account_read_response_line(&line, &mut pending);
                            let _ = out.write_all(rewritten.as_bytes());
                        }
                        drop(pending);
                        let _ = out.flush();
                    }
                }
            }
            if let Some(rest) = accumulator.end() {
                let mut out = std::io::stdout();
                let mut pending = pending_out.lock().expect("pending poisoned");
                let rewritten = rewrite_app_server_account_read_response_line(&rest, &mut pending);
                let _ = out.write_all(rewritten.as_bytes());
                let _ = out.flush();
            }
        });

        // stderr passthrough.
        let mut child_stderr = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            use std::io::Write;
            let Some(stderr) = child_stderr.as_mut() else {
                return;
            };
            let mut buf = vec![0u8; 8192];
            loop {
                match stderr.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut err = std::io::stderr();
                        let _ = err.write_all(&buf[..n]);
                        let _ = err.flush();
                    }
                }
            }
        });

        let status = child.wait().await;
        stdin_task.abort();
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let exit_code = status.map(exit_code_from_status).unwrap_or(1);
        cleanup.run(exit_code).await;
        return ForwardOnceResult {
            exit_code,
            output: String::new(),
        };
    }

    if capture_output {
        use tokio::io::AsyncReadExt;
        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        let stdout_task = tokio::spawn(async move {
            let mut captured = String::new();
            if let Some(stdout) = stdout_pipe.as_mut() {
                let _ = stdout.read_to_string(&mut captured).await;
            }
            captured
        });
        let stderr_task = tokio::spawn(async move {
            let mut captured = String::new();
            if let Some(stderr) = stderr_pipe.as_mut() {
                let _ = stderr.read_to_string(&mut captured).await;
            }
            captured
        });
        let status = child.wait().await;
        let stdout_capture = stdout_task.await.unwrap_or_default();
        let stderr_capture = stderr_task.await.unwrap_or_default();
        let exit_code = status.map(exit_code_from_status).unwrap_or(1);
        cleanup.run(exit_code).await;
        if !stdout_capture.is_empty() {
            let filtered_stdout = filter_known_forwarded_codex_stderr(&stdout_capture);
            if !filtered_stdout.is_empty() {
                print!("{filtered_stdout}");
                use std::io::Write;
                let _ = std::io::stdout().flush();
            }
        }
        if !stderr_capture.is_empty() {
            let filtered_stderr = filter_known_forwarded_codex_stderr(&stderr_capture);
            if !filtered_stderr.trim().is_empty() {
                eprint!("{filtered_stderr}");
                if !filtered_stderr.ends_with('\n') {
                    eprintln!();
                }
            }
        }
        return ForwardOnceResult {
            exit_code,
            output: format!("{stdout_capture}\n{stderr_capture}").trim().to_string(),
        };
    }

    let status = child.wait().await;
    let exit_code = status.map(exit_code_from_status).unwrap_or(1);
    cleanup.run(exit_code).await;
    ForwardOnceResult {
        exit_code,
        // No-capture output stays empty by design so retry parsing cannot
        // reintroduce pipes that break terminal passthrough.
        output: String::new(),
    }
}

// ===========================================================================
// Session-index repair.
// ===========================================================================

/// TS `extractRolloutIdFromFilename(fileName)` —
/// `rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl` (case-insensitive uuid).
pub fn extract_rollout_id_from_filename(file_name: &str) -> Option<String> {
    let rest = file_name.strip_prefix("rollout-")?;
    let rest_lower = rest.to_ascii_lowercase();
    let rest_bytes = rest_lower.as_bytes();
    // date part: dddd-dd-ddTdd-dd-dd-
    let date_len = "0000-00-00T00-00-00-".len();
    if rest_bytes.len() < date_len {
        return None;
    }
    let date_part = &rest_lower[..date_len];
    let date_template = "dddd-dd-ddTdd-dd-dd-";
    for (c, t) in date_part.chars().zip(date_template.chars()) {
        match t {
            'd' => {
                if !c.is_ascii_digit() {
                    return None;
                }
            }
            other => {
                if c != other.to_ascii_lowercase() {
                    return None;
                }
            }
        }
    }
    let uuid_and_ext = &rest_lower[date_len..];
    let uuid = uuid_and_ext.strip_suffix(".jsonl")?;
    let parts: Vec<&str> = uuid.split('-').collect();
    let valid = parts.len() == 5
        && [8usize, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(len, part)| part.len() == *len && part.chars().all(|c| c.is_ascii_hexdigit()));
    if valid { Some(uuid.to_string()) } else { None }
}

fn collect_rollout_files(root_dir: &Path, results: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let file_type = entry.file_type();
        if file_type.as_ref().map(|t| t.is_dir()).unwrap_or(false) {
            collect_rollout_files(&entry_path, results);
            continue;
        }
        if file_type.map(|t| t.is_file()).unwrap_or(false)
            && entry
                .file_name()
                .to_str()
                .and_then(extract_rollout_id_from_filename)
                .is_some()
        {
            results.push(entry_path);
        }
    }
}

/// TS `parseRolloutIndexEntry(rolloutPath)`.
fn parse_rollout_index_entry(rollout_path: &Path) -> Option<Value> {
    let file_name = rollout_path.file_name()?.to_str()?;
    let id_from_name = extract_rollout_id_from_filename(file_name)?;
    let content = fs::read_to_string(rollout_path).ok()?;
    let mut id = id_from_name;
    let mut thread_name = String::new();
    let mut updated_at: Option<String> = None;
    let mut has_session_meta = false;
    for line in content.split(['\r', '\n']).filter(|l| !l.is_empty()) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) {
            updated_at = Some(timestamp.to_string());
        }
        if record.get("type").and_then(Value::as_str) == Some("session_meta")
            && let Some(session_id) = record
                .get("payload")
                .and_then(|p| p.get("id"))
                .and_then(Value::as_str)
        {
            id = session_id.to_string();
            has_session_meta = true;
        }
        if thread_name.is_empty()
            && record.get("type").and_then(Value::as_str) == Some("event_msg")
            && let Some(message) = record
                .get("payload")
                .and_then(|p| p.get("message"))
                .and_then(Value::as_str)
            && !message.trim().is_empty()
        {
            thread_name = message.trim().to_string();
        }
    }
    let updated_at = updated_at.unwrap_or_else(|| {
        // TS double fallback: `statSync(path).mtime.toISOString()`, then
        // `new Date().toISOString()` when stat fails — ALWAYS an ISO-8601
        // UTC string ("YYYY-MM-DDTHH:MM:SS.mmmZ"), never raw epoch millis or
        // "". This entry is appended to the REAL ~/.codex/session_index.jsonl
        // that the official Codex resume list sorts and renders; a non-ISO
        // value mis-sorts that shared file. `to_rfc3339_opts(Millis, true)`
        // matches Date.prototype.toISOString byte-for-byte.
        fs::metadata(rollout_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(chrono::DateTime::<chrono::Utc>::from)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    });
    if !has_session_meta {
        return None;
    }
    if thread_name.is_empty() {
        thread_name = "Codex session".to_string();
    }
    if thread_name.chars().count() > 80 {
        thread_name = format!("{}...", thread_name.chars().take(77).collect::<String>());
    }
    Some(serde_json::json!({
        "id": id,
        "thread_name": thread_name,
        "updated_at": updated_at,
    }))
}

fn write_session_index_atomic(index_path: &Path, lines: &[String]) -> io::Result<()> {
    let index_dir = index_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&index_dir)?;
    let payload = format!("{}\n", lines.join("\n"));
    let base = index_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("session_index.jsonl");
    for attempt in 0..4u32 {
        let temp_path = index_dir.join(format!(
            ".{base}.{}.{}.tmp",
            std::process::id(),
            cma_core::utils::now_ms()
        ));
        let result = fs::write(&temp_path, payload.as_bytes())
            .and_then(|()| fs::rename(&temp_path, index_path));
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                let retryable = matches!(
                    cma_core::fs_retry::code_of(&error),
                    Some("EBUSY") | Some("EPERM") | Some("ENOTEMPTY")
                );
                if !retryable || attempt >= 3 {
                    return Err(error);
                }
                std::thread::sleep(Duration::from_millis(20 * (attempt as u64 + 1)));
            }
        }
    }
    Ok(())
}

/// TS `repairCodexSessionIndex(codexHome)` — appends missing rollout entries
/// to `session_index.jsonl` (best effort, lock-guarded).
pub fn repair_codex_session_index(codex_home: &Path) {
    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.exists() {
        return;
    }
    let index_path = codex_home.join("session_index.jsonl");
    let Ok(lock) = acquire_shadow_home_sync_lock(codex_home) else {
        return;
    };
    let result = (|| -> io::Result<()> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut existing_lines: Vec<String> = Vec::new();
        if index_path.exists() {
            existing_lines = fs::read_to_string(&index_path)?
                .split(['\r', '\n'])
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect();
            for line in &existing_lines {
                if let Ok(entry) = serde_json::from_str::<Value>(line)
                    && let Some(id) = entry.get("id").and_then(Value::as_str)
                {
                    seen.insert(id.to_string());
                }
            }
        }
        let mut rollout_files = Vec::new();
        collect_rollout_files(&sessions_dir, &mut rollout_files);
        let mut additions: Vec<Value> = Vec::new();
        for rollout_path in rollout_files {
            if let Some(file_name) = rollout_path.file_name().and_then(|n| n.to_str())
                && let Some(id_from_name) = extract_rollout_id_from_filename(file_name)
                && seen.contains(&id_from_name)
            {
                continue;
            }
            let Some(entry) = parse_rollout_index_entry(&rollout_path) else {
                continue;
            };
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if seen.contains(&id) {
                continue;
            }
            seen.insert(id);
            additions.push(entry);
        }
        if additions.is_empty() {
            return Ok(());
        }
        additions.sort_by(|a, b| {
            let a_updated = a.get("updated_at").and_then(Value::as_str).unwrap_or("");
            let b_updated = b.get("updated_at").and_then(Value::as_str).unwrap_or("");
            a_updated.cmp(b_updated)
        });
        let mut lines = existing_lines;
        lines.extend(
            additions
                .iter()
                .map(cma_core::json_io::stringify_compact),
        );
        write_session_index_atomic(&index_path, &lines)
    })();
    let _ = result;
    lock.release();
}

// ===========================================================================
// Forwarded runtime observability.
// ===========================================================================

fn runtime_snapshot_change_token(
    snapshot: Option<&cma_runtime::observability::RuntimeObservabilitySnapshot>,
) -> String {
    match snapshot {
        None => "null".to_string(),
        Some(s) => format!(
            "{}|{}|{}|{}|{}|{}|{:?}",
            s.responses_requests,
            s.auth_refresh_requests,
            s.diagnostic_probe_requests,
            s.runtime_metrics.total_requests,
            s.runtime_metrics.successful_requests,
            s.runtime_metrics.failed_requests,
            s.runtime_metrics.last_request_at,
        ),
    }
}

async fn load_runtime_snapshot_with_retry()
-> Option<cma_runtime::observability::RuntimeObservabilitySnapshot> {
    for attempt in 0..5 {
        if let Some(snapshot) =
            cma_runtime::observability::load_persisted_runtime_observability_snapshot()
        {
            return Some(snapshot);
        }
        if attempt < 4 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    None
}

/// TS `withForwardedRuntimeObservability(rawArgs, runForwardedCommand)` — if
/// the forwarded run left no runtime-observability trace (e.g. proxy
/// bypassed), synthesize one request record.
async fn with_forwarded_runtime_observability<F, Fut>(raw_args: &[String], run: F) -> i32
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = i32>,
{
    if !should_track_forwarded_runtime_observability(raw_args) {
        return run().await;
    }
    let before = load_runtime_snapshot_with_retry().await;
    let before_token = runtime_snapshot_change_token(before.as_ref());
    let started_at = cma_core::utils::now_ms();
    let exit_code = run().await;
    let after = load_runtime_snapshot_with_retry().await;
    let after_token = runtime_snapshot_change_token(after.as_ref());
    if after_token != before_token {
        return exit_code;
    }
    cma_runtime::observability::mutate_runtime_observability_snapshot(|snapshot| {
        snapshot.current_request_id = None;
        snapshot.responses_requests += 1;
        snapshot.runtime_metrics.total_requests += 1;
        snapshot.runtime_metrics.responses_requests += 1;
        snapshot.runtime_metrics.cumulative_latency_ms +=
            (cma_core::utils::now_ms() - started_at).max(0);
        snapshot.runtime_metrics.last_request_at = Some(cma_core::utils::now_ms());
        if snapshot.runtime_metrics.started_at == 0 {
            snapshot.runtime_metrics.started_at = started_at;
        }
        if exit_code == 0 {
            snapshot.runtime_metrics.successful_requests += 1;
            snapshot.runtime_metrics.last_error = None;
        } else {
            snapshot.runtime_metrics.failed_requests += 1;
            snapshot.runtime_metrics.last_error =
                Some(format!("forwarded-codex-exit:{exit_code}"));
        }
    });
    exit_code
}

// ===========================================================================
// The forward loop + entrypoint.
// ===========================================================================

/// TS `forwardToRealCodex(codexBin, rawArgs, baseEnv)` — up to 4 attempts
/// with wrapper-side unsupported-model fallback.
async fn forward_to_real_codex(
    codex_bin: &ResolvedCodexBin,
    raw_args: &[String],
    forced_account_index: Option<usize>,
    extra_env: &HashMap<String, String>,
) -> i32 {
    let mut current_args: Vec<String> = raw_args.to_vec();
    let mut last_exit_code = 1;
    let mut attempted_models: Vec<String> = Vec::new();

    for _attempt in 0..4 {
        let requested_model = extract_requested_model(&current_args);
        if let Some(model) = &requested_model
            && !attempted_models.contains(model)
        {
            attempted_models.push(model.clone());
        }

        let (forward_args, compatibility_requested_model) = build_forward_args(&current_args);
        let mut compatibility = create_compatibility_codex_home(
            forward_args,
            compatibility_requested_model.as_deref(),
        );
        for (key, value) in extra_env {
            compatibility
                .env_overrides
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
        // Forced-account pin: publish on the spawned env (children + helper),
        // or scrub any stray value when no pin was requested.
        match forced_account_index {
            Some(index) => {
                compatibility
                    .env_overrides
                    .insert(FORCE_ACCOUNT_INDEX_ENV.to_string(), index.to_string());
            }
            None => {
                compatibility
                    .env_removals
                    .push(FORCE_ACCOUNT_INDEX_ENV.to_string());
            }
        }
        let runtime_context = create_runtime_rotation_proxy_context_if_enabled(
            compatibility,
            raw_args,
            forced_account_index,
        )
        .await;
        let capture_output = should_capture_forwarded_output_for_args(raw_args);
        let proxy_app_server = is_codex_app_server_command(raw_args)
            && (runtime_context.proxy_app_server_account_read
                || runtime_context
                    .env_overrides
                    .get(APP_SERVER_ACCOUNT_LABEL_ENV)
                    .map(|v| v.trim() == "1")
                    .unwrap_or_else(|| env_string(APP_SERVER_ACCOUNT_LABEL_ENV).trim() == "1"));
        let ForwardContext {
            args,
            env_overrides,
            env_removals,
            cleanup,
            proxy_app_server_account_read: _,
        } = runtime_context;
        let result = forward_to_real_codex_once(
            codex_bin,
            &args,
            &env_overrides,
            &env_removals,
            cleanup,
            capture_output,
            proxy_app_server,
        )
        .await;
        last_exit_code = result.exit_code;
        if result.exit_code == 0 {
            let env_map = process_env_map();
            repair_codex_session_index(&resolve_codex_home_dir(&env_map));
            return result.exit_code;
        }

        let fallback_model = resolve_unsupported_model_retry_target(
            requested_model.as_deref(),
            &result.output,
            &attempted_models,
        );
        let Some(fallback_model) = fallback_model else {
            return result.exit_code;
        };
        eprintln!(
            "codex-multi-auth: model {} is unsupported on this ChatGPT Codex surface. Retrying with {fallback_model}.",
            requested_model.as_deref().unwrap_or("requested model")
        );
        if !attempted_models.contains(&fallback_model) {
            attempted_models.push(fallback_model.clone());
        }
        let next_args = replace_requested_model(&current_args, &fallback_model);
        if next_args == current_args {
            return result.exit_code;
        }
        current_args = next_args;
    }

    last_exit_code
}

/// The wrapper's non-auth path (TS `main()` after the auth branch): resolve
/// the official codex, preflight `--account`, print the status line, kick the
/// background quota refresh, and forward with observability tracking.
///
/// The caller (cma-bin main) is responsible for [`classify_wrapper_args`],
/// the startup update notice, and routing auth-family args to cma-manager.
pub async fn forward(raw_args: &[String]) -> i32 {
    let Some(real_codex_bin) = resolve_real_codex_bin() else {
        let override_value = env_string("CODEX_MULTI_AUTH_REAL_CODEX_BIN");
        let override_value = override_value.trim();
        if !override_value.is_empty() && !Path::new(override_value).exists() {
            eprintln!("CODEX_MULTI_AUTH_REAL_CODEX_BIN is set but missing: {override_value}");
        }
        eprintln!(
            "{}",
            [
                "Could not locate the official Codex CLI.",
                "Install it with npm, Homebrew, or an official native release so `codex` is on PATH.",
                "Or set CODEX_MULTI_AUTH_REAL_CODEX_BIN to the full path of either codex or @openai/codex/bin/codex.js.",
            ]
            .join("\n")
        );
        return 1;
    };

    // Resolve `--account` / CODEX_MULTI_AUTH_FORCE_ACCOUNT before forwarding:
    // strip the launcher-only flag and resolve the pin, or fail hard so a
    // forced account can never silently fall back to another one.
    let forced = apply_forced_account_selection(raw_args, async |args: &[String]| {
        is_runtime_rotation_proxy_enabled(args).await
    })
    .await;
    let (forward_args, forced_index) = match forced {
        ForcedAccountOutcome::Error(message) => {
            eprintln!("{message}");
            return 1;
        }
        ForcedAccountOutcome::Forward {
            forward_args,
            forced_index,
        } => (forward_args, forced_index),
    };

    // Version hydration for children (TS `hydrateCliVersionEnv`).
    let mut extra_env: HashMap<String, String> = HashMap::new();
    if env_string("CODEX_MULTI_AUTH_CLI_VERSION").trim().is_empty() {
        extra_env.insert(
            "CODEX_MULTI_AUTH_CLI_VERSION".to_string(),
            env!("CARGO_PKG_VERSION").to_string(),
        );
    }

    crate::statusline::maybe_print_forward_status_line(&forward_args);
    crate::statusline::maybe_refresh_quota_cache_in_background(&extra_env);

    with_forwarded_runtime_observability(&forward_args, || {
        forward_to_real_codex(&real_codex_bin, &forward_args, forced_index, &extra_env)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    /// TS parity: when a rollout carries session_meta but no string
    /// `timestamp`, the session-index `updated_at` falls back to the file
    /// mtime as an ISO-8601 UTC string (`mtime.toISOString()`), never raw
    /// epoch millis or "" — the entry lands in the REAL
    /// ~/.codex/session_index.jsonl consumed by the official resume list.
    #[test]
    fn rollout_index_updated_at_fallback_is_iso8601_utc() {
        let dir = tempfile::tempdir().unwrap();
        let rollout = dir
            .path()
            .join("rollout-2026-07-27T10-00-00-11111111-2222-3333-4444-555555555555.jsonl");
        std::fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"sess-1\"}}\n",
        )
        .unwrap();

        let entry = parse_rollout_index_entry(&rollout).expect("entry");
        let updated_at = entry["updated_at"].as_str().expect("string updated_at");
        assert!(updated_at.ends_with('Z'), "UTC Z suffix: {updated_at}");
        let parsed = chrono::DateTime::parse_from_rfc3339(updated_at)
            .unwrap_or_else(|e| panic!("RFC3339 expected, got {updated_at}: {e}"));
        // toISOString shape: exactly milliseconds precision.
        assert_eq!(
            updated_at,
            parsed
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
        // And it tracks the file mtime, not the epoch-millis digits.
        assert!(!updated_at.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn classification_routes_helper_auth_and_forward() {
        assert_eq!(
            classify_wrapper_args(&v(&[INTERNAL_RUNTIME_ROTATION_APP_HELPER_ARG])),
            WrapperDispatch::RunAppHelper
        );
        match classify_wrapper_args(&v(&["multi-auth", "status"])) {
            WrapperDispatch::AuthManager { normalized_args } => {
                assert_eq!(normalized_args, v(&["auth", "status"]));
            }
            other => panic!("expected AuthManager, got {other:?}"),
        }
        match classify_wrapper_args(&v(&["exec", "hello"])) {
            WrapperDispatch::Forward { raw_args } => assert_eq!(raw_args, v(&["exec", "hello"])),
            other => panic!("expected Forward, got {other:?}"),
        }
        // Unknown auth subcommand forwards.
        match classify_wrapper_args(&v(&["auth", "whoami"])) {
            WrapperDispatch::Forward { .. } => {}
            other => panic!("expected Forward, got {other:?}"),
        }
    }

    #[test]
    fn model_normalization_aliases() {
        assert_eq!(normalize_requested_model("gpt-5"), "gpt-5.5");
        assert_eq!(normalize_requested_model("openai/gpt-5"), "gpt-5.5");
        assert_eq!(normalize_requested_model("gpt-5-codex"), CURRENT_CODEX_MODEL);
        assert_eq!(normalize_requested_model("codex"), CURRENT_CODEX_MODEL);
        assert_eq!(normalize_requested_model("codex-max"), CURRENT_CODEX_MODEL);
        assert_eq!(normalize_requested_model("gpt-5.6"), "gpt-5.6-sol");
        assert_eq!(normalize_requested_model("gpt-5.6-terra"), "gpt-5.6-terra");
        // Unknown 5.6 tier resolves to Sol; codex-suffixed 5.6 does not.
        assert_eq!(normalize_requested_model("gpt-5.6-nova"), "gpt-5.6-sol");
        assert_eq!(normalize_requested_model("gpt-5.6-luna-max"), "gpt-5.6-luna");
        // Unknown general minor falls to the stable catalog.
        assert_eq!(normalize_requested_model("gpt-5.9"), "gpt-5.5");
        assert_eq!(normalize_requested_model("gpt-5.9-pro"), "gpt-5.5-pro");
        assert_eq!(normalize_requested_model("gpt-5.4-mini"), "gpt-5.4-mini");
        assert_eq!(normalize_requested_model(""), "");
        assert_eq!(normalize_requested_model("o3"), "");
        assert_eq!(normalize_requested_model("gpt-5.5-high"), "gpt-5.5");
        assert_eq!(normalize_requested_model("gpt_5_codex"), CURRENT_CODEX_MODEL);
    }

    #[test]
    fn effort_coercion_rules() {
        // none is coerced up to low on GPT-5.6 tiers.
        assert_eq!(coerce_reasoning_effort_for_model("gpt-5.6-sol", "none"), "low");
        assert_eq!(coerce_reasoning_effort_for_model("gpt-5.6-sol", "minimal"), "low");
        // ultra never reaches the wire.
        assert_eq!(coerce_reasoning_effort_for_model("gpt-5.6-sol", "ultra"), "max");
        // Luna stops at max.
        assert_eq!(coerce_reasoning_effort_for_model("gpt-5.6-luna", "ultra"), "max");
        // Pre-5.6 model with max steps down to xhigh.
        assert_eq!(coerce_reasoning_effort_for_model("gpt-5.5", "max"), "xhigh");
        // gpt-5.1 has no xhigh.
        assert_eq!(coerce_reasoning_effort_for_model("gpt-5.1", "xhigh"), "high");
        // Unknown effort passes through untouched.
        assert_eq!(coerce_reasoning_effort_for_model("gpt-5.5", "turbo"), "turbo");
        // Unknown model keeps the effort.
        assert_eq!(coerce_reasoning_effort_for_model("o3", "high"), "high");
        // ultra on unknown model still rewritten to max.
        assert_eq!(coerce_reasoning_effort_for_model("o3", "ultra"), "max");
    }

    #[test]
    fn reasoning_config_arg_rewrite() {
        let (args, model) = rewrite_reasoning_config_args(&v(&[
            "-m",
            "gpt-5.5",
            "-c",
            "model_reasoning_effort=\"max\"",
        ]));
        assert_eq!(model.as_deref(), Some("gpt-5.5"));
        assert_eq!(args[3], "model_reasoning_effort=\"xhigh\"");
        // No model → untouched.
        let (args, model) =
            rewrite_reasoning_config_args(&v(&["-c", "model_reasoning_effort=\"max\""]));
        assert_eq!(model, None);
        assert_eq!(args[1], "model_reasoning_effort=\"max\"");
        // --config= form.
        let (args, _) = rewrite_reasoning_config_args(&v(&[
            "--model=gpt-5.5",
            "--config=model_reasoning_effort='ultra'",
        ]));
        assert_eq!(args[1], "--config=model_reasoning_effort='xhigh'");
    }

    #[test]
    fn config_toml_reasoning_rewrite() {
        let raw = "model = \"gpt-5.5\"\nmodel_reasoning_effort = \"max\"\n";
        let rewritten = rewrite_config_toml_reasoning_effort(raw, "gpt-5.5");
        assert_eq!(
            rewritten,
            "model = \"gpt-5.5\"\nmodel_reasoning_effort = \"xhigh\"\n"
        );
        // Bare value + comment preserved.
        let raw = "model_reasoning_effort = max # keep\n";
        let rewritten = rewrite_config_toml_reasoning_effort(raw, "gpt-5.5");
        assert_eq!(rewritten, "model_reasoning_effort = xhigh # keep\n");
        // Unchanged config returns identical string.
        let raw = "model_reasoning_effort = \"high\"\n";
        assert_eq!(rewrite_config_toml_reasoning_effort(raw, "gpt-5.5"), raw);
        // CRLF preserved.
        let raw = "a = 1\r\nmodel_reasoning_effort = \"ultra\"\r\n";
        let rewritten = rewrite_config_toml_reasoning_effort(raw, "gpt-5.6-sol");
        assert!(rewritten.contains("model_reasoning_effort = \"max\""));
        assert!(rewritten.contains("\r\n"));
    }

    #[test]
    fn credentials_store_injection() {
        // Opt-out env not set → injected.
        if std::env::var("CODEX_MULTI_AUTH_FORCE_FILE_AUTH_STORE").is_err() {
            let (args, _) = build_forward_args(&v(&["exec"]));
            assert_eq!(
                &args[args.len() - 2..],
                &v(&["-c", "cli_auth_credentials_store=\"file\""])[..]
            );
            // Caller override suppresses injection.
            let (args, _) =
                build_forward_args(&v(&["-c", "cli_auth_credentials_store=keyring"]));
            assert_eq!(args, v(&["-c", "cli_auth_credentials_store=keyring"]));
            let (args, _) =
                build_forward_args(&v(&["--config=cli_auth_credentials_store=keyring"]));
            assert_eq!(args, v(&["--config=cli_auth_credentials_store=keyring"]));
        }
    }

    #[test]
    fn credentials_store_override_detection() {
        assert!(has_cli_auth_credentials_store_override(&v(&[
            "-c",
            "cli_auth_credentials_store=file"
        ])));
        assert!(has_cli_auth_credentials_store_override(&v(&[
            "--config",
            " cli_auth_credentials_store =file"
        ])));
        assert!(has_cli_auth_credentials_store_override(&v(&[
            "--config=cli_auth_credentials_store=x"
        ])));
        assert!(!has_cli_auth_credentials_store_override(&v(&["-c", "model=x"])));
        assert!(!has_cli_auth_credentials_store_override(&v(&["-c"])));
    }

    #[test]
    fn unsupported_model_output_parsing() {
        let direct = "'gpt-5.5' model is not supported when using codex with a chatgpt account";
        assert_eq!(
            extract_unsupported_model_from_output(direct).as_deref(),
            Some("gpt-5.5")
        );
        let normalized = "Model \"gpt-5.3-codex-spark\" is not currently available for this ChatGPT account when using Codex OAuth.";
        assert_eq!(
            extract_unsupported_model_from_output(normalized).as_deref(),
            Some("gpt-5.3-codex-spark")
        );
        let denied = "The model `gpt-5.5-pro` does not exist or you do not have access to it.";
        assert_eq!(
            extract_unsupported_model_from_output(denied).as_deref(),
            Some("gpt-5.5-pro")
        );
        assert_eq!(extract_unsupported_model_from_output("all good"), None);
        // Effort suffix stripped by canonicalization.
        let with_effort = "The model `gpt-5.5-high` does not exist or you do not have access to it.";
        assert_eq!(
            extract_unsupported_model_from_output(with_effort).as_deref(),
            Some("gpt-5.5")
        );
    }

    #[test]
    fn unsupported_retry_target_resolution() {
        let output = "'gpt-5.5' model is not supported when using codex with a chatgpt account";
        assert_eq!(
            resolve_unsupported_model_retry_target(Some("gpt-5.5"), output, &[]).as_deref(),
            Some("gpt-5.4")
        );
        // Already-attempted fallback skipped.
        assert_eq!(
            resolve_unsupported_model_retry_target(
                Some("gpt-5.5"),
                output,
                &v(&["gpt-5.4"])
            ),
            None
        );
        // Spark → current codex model.
        let spark = "Model 'gpt-5.3-codex-spark' is not currently available for this ChatGPT account when using Codex OAuth";
        assert_eq!(
            resolve_unsupported_model_retry_target(Some("gpt-5.3-codex-spark"), spark, &[])
                .as_deref(),
            Some(CURRENT_CODEX_MODEL)
        );
        // No unsupported marker → no retry.
        assert_eq!(
            resolve_unsupported_model_retry_target(Some("gpt-5.5"), "boom", &[]),
            None
        );
        // Unknown blocked model without chain → None.
        let unknown = "'weird-model' model is not supported when using codex with a chatgpt account";
        assert_eq!(
            resolve_unsupported_model_retry_target(Some("weird-model"), unknown, &[]),
            None
        );
    }

    #[test]
    fn model_replacement_forms() {
        assert_eq!(
            replace_requested_model(&v(&["-m", "a", "exec"]), "b"),
            v(&["-m", "b", "exec"])
        );
        assert_eq!(
            replace_requested_model(&v(&["--model=a"]), "b"),
            v(&["--model=b"])
        );
        assert_eq!(replace_requested_model(&v(&["exec"]), "b"), v(&["exec"]));
        assert_eq!(replace_requested_model(&v(&["-m", "a"]), ""), v(&["-m", "a"]));
    }

    #[test]
    fn runtime_rotation_env_parsing() {
        assert_eq!(parse_runtime_rotation_proxy_env(None), None);
        assert_eq!(parse_runtime_rotation_proxy_env(Some("")), None);
        assert_eq!(parse_runtime_rotation_proxy_env(Some("1")), Some(true));
        assert_eq!(parse_runtime_rotation_proxy_env(Some("TRUE")), Some(true));
        assert_eq!(parse_runtime_rotation_proxy_env(Some("yes")), Some(true));
        assert_eq!(parse_runtime_rotation_proxy_env(Some("0")), Some(false));
        assert_eq!(parse_runtime_rotation_proxy_env(Some("no")), Some(false));
        assert_eq!(parse_runtime_rotation_proxy_env(Some("maybe")), None);
    }

    #[test]
    fn json_rpc_id_keys_distinguish_types() {
        assert_eq!(
            json_rpc_id_key(&Value::from(1)).as_deref(),
            Some("number:1")
        );
        assert_eq!(
            json_rpc_id_key(&Value::from("1")).as_deref(),
            Some("string:\"1\"")
        );
        assert_ne!(
            json_rpc_id_key(&Value::from(1)),
            json_rpc_id_key(&Value::from("1"))
        );
        assert_eq!(json_rpc_id_key(&Value::Null).as_deref(), Some("object:null"));
        assert_eq!(json_rpc_id_key(&serde_json::json!({})), None);
    }

    #[test]
    fn app_server_protocol_rewrite_round_trip() {
        let mut pending = std::collections::HashMap::new();
        observe_app_server_request_line(
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"account/read\"}\n",
            &mut pending,
        );
        assert_eq!(pending.len(), 1);
        // Unrelated response passes through.
        let unrelated = "{\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{}}\n";
        assert_eq!(
            rewrite_app_server_account_read_response_line(unrelated, &mut pending),
            unrelated
        );
        // The tracked id is rewritten with the synthetic account payload.
        let response = "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"account\":{\"email\":\"real@x.com\"}}}\r\n";
        let rewritten = rewrite_app_server_account_read_response_line(response, &mut pending);
        assert!(rewritten.ends_with("\r\n"));
        let parsed: Value = serde_json::from_str(rewritten.trim()).unwrap();
        assert_eq!(parsed["result"]["account"]["email"], "codex-multi-auth");
        assert_eq!(parsed["result"]["requiresOpenaiAuth"], false);
        assert_eq!(parsed["id"], 7);
        // Consumed: second response with the same id passes through.
        assert_eq!(
            rewrite_app_server_account_read_response_line(response, &mut pending),
            response
        );

        // getAuthStatus + rateLimits synthesize their own shapes.
        observe_app_server_request_line(
            "{\"id\":\"a\",\"method\":\"getAuthStatus\"}\n",
            &mut pending,
        );
        let rewritten = rewrite_app_server_account_read_response_line(
            "{\"id\":\"a\",\"result\":{\"authToken\":\"secret\"}}\n",
            &mut pending,
        );
        let parsed: Value = serde_json::from_str(rewritten.trim()).unwrap();
        assert_eq!(parsed["result"]["authMethod"], "apikey");
        assert_eq!(parsed["result"]["authToken"], Value::Null);
        // Requests without ids are ignored.
        observe_app_server_request_line(
            "{\"method\":\"account/read\"}\n",
            &mut pending,
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn protocol_line_accumulator_buffers_partial_lines() {
        let mut acc = ProtocolLineAccumulator::new();
        assert!(acc.write("{\"a\":").is_empty());
        let lines = acc.write("1}\n{\"b\":2}\n{\"partial");
        assert_eq!(lines, vec!["{\"a\":1}\n".to_string(), "{\"b\":2}\n".to_string()]);
        assert_eq!(acc.end().as_deref(), Some("{\"partial"));
        assert_eq!(acc.end(), None);
    }

    #[test]
    fn stderr_filter_drops_known_noise_pairs() {
        let text = [
            "keep me",
            "2026-01-01 ERROR codex_core::session: failed to record rollout items: thread",
            "0187a2b4-1111-2222-3333-444455556666 not found",
            "also keep",
        ]
        .join("\n");
        assert_eq!(filter_known_forwarded_codex_stderr(&text), "keep me\nalso keep");
        // Non-matching second line keeps both.
        let text = [
            "ERROR codex_core::session: failed to record rollout items: thread",
            "unrelated",
        ]
        .join("\n");
        assert_eq!(
            filter_known_forwarded_codex_stderr(&text),
            "ERROR codex_core::session: failed to record rollout items: thread\nunrelated"
        );
        assert_eq!(filter_known_forwarded_codex_stderr(""), "");
    }

    #[test]
    fn rollout_filename_parsing() {
        assert_eq!(
            extract_rollout_id_from_filename(
                "rollout-2026-07-27T10-30-00-0187a2b4-1111-2222-3333-444455556666.jsonl"
            )
            .as_deref(),
            Some("0187a2b4-1111-2222-3333-444455556666")
        );
        assert_eq!(
            extract_rollout_id_from_filename("rollout-2026-07-27T10-30-00-nope.jsonl"),
            None
        );
        assert_eq!(extract_rollout_id_from_filename("other.jsonl"), None);
        assert_eq!(
            extract_rollout_id_from_filename(
                "rollout-2026-07-27T10-30-00-0187A2B4-1111-2222-3333-444455556666.JSONL"
            )
            .as_deref(),
            Some("0187a2b4-1111-2222-3333-444455556666")
        );
    }

    #[test]
    fn client_api_key_is_64_hex_chars() {
        let key = create_runtime_rotation_proxy_client_api_key();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(key, create_runtime_rotation_proxy_client_api_key());
    }

    #[test]
    fn provider_args_use_frozen_provider_id() {
        let args = provider_config_args();
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], "model_provider=\"codex-multi-auth-runtime-proxy\"");
    }
}
