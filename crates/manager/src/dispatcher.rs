//! Port of `lib/codex-manager.ts` — the CLI dispatcher / dependency hub.
//!
//! `run_codex_multi_auth_cli(args) -> i32` reproduces the exact TS flow:
//! first-run housekeeping (never fails a command), theme apply, `auth`-prefix
//! normalization, exact-match handler dispatch, `Unknown command: <name>`.
//!
//! The TS module's dependency-injection closures (`createRepairCommandDeps`,
//! per-handler deps objects) are absorbed per ARCHITECTURE §4 item 10: Rust
//! command modules import their real dependencies directly; the dispatcher
//! only routes. The pieces the TS dispatcher itself owned — the
//! `buildSelectAccountTraced` scorer closure and the why-selected runtime
//! snapshot `generatedAt` wrapper — are exported from here for the
//! `why-selected` command to consume.

use std::sync::Arc;

use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
use cma_core::schemas::token::TokenResult;
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_rotation::selector::{
    AccountWithMetrics, HybridSelectionTraceResult, SelectHybridAccountParams,
    select_hybrid_account_traced,
};
use cma_rotation::trackers::{TrackerKey, get_health_tracker, get_token_tracker};
use cma_storage::matching::{
    AccountMatchOptions, AccountSelectionCandidate, find_matching_account_index,
};
use serde_json::Value;

use crate::help::print_usage;
use crate::registry::is_account_manager_command;

// ---------------------------------------------------------------------------
// Output plumbing shared by every command module
// ---------------------------------------------------------------------------

/// One emitted CLI line. `Info` ≙ TS `logInfo` (stdout); `Warn` ≙ `logWarn`
/// and `Error` ≙ `logError` (both stderr).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutLine {
    Info(String),
    Warn(String),
    Error(String),
}

/// Injectable output sink. In production (`stdio`) lines print immediately
/// (stdout/stderr, matching the TS console sinks); in tests (`capture`) they
/// accumulate so command tests can assert exact output without a TTY.
#[derive(Debug, Default)]
pub struct CliOut {
    capture: Option<Vec<OutLine>>,
}

impl CliOut {
    /// Production sink: print immediately.
    pub fn stdio() -> Self {
        CliOut { capture: None }
    }

    /// Test sink: buffer lines for assertions.
    pub fn capture() -> Self {
        CliOut {
            capture: Some(Vec::new()),
        }
    }

    pub fn info(&mut self, message: impl Into<String>) {
        let message = message.into();
        match &mut self.capture {
            Some(lines) => lines.push(OutLine::Info(message)),
            None => println!("{message}"),
        }
    }

    pub fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        match &mut self.capture {
            Some(lines) => lines.push(OutLine::Warn(message)),
            None => eprintln!("{message}"),
        }
    }

    pub fn error(&mut self, message: impl Into<String>) {
        let message = message.into();
        match &mut self.capture {
            Some(lines) => lines.push(OutLine::Error(message)),
            None => eprintln!("{message}"),
        }
    }

    /// Captured lines (empty in stdio mode).
    pub fn lines(&self) -> &[OutLine] {
        self.capture.as_deref().unwrap_or(&[])
    }

    /// All captured `Info` lines joined with `\n` (the TS tests'
    /// `logInfo.mock.calls.join("\n")` idiom).
    pub fn info_text(&self) -> String {
        self.lines()
            .iter()
            .filter_map(|line| match line {
                OutLine::Info(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// All captured `Error` lines joined with `\n`.
    pub fn error_text(&self) -> String {
        self.lines()
            .iter()
            .filter_map(|line| match line {
                OutLine::Error(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// All captured `Warn` lines joined with `\n`.
    pub fn warn_text(&self) -> String {
        self.lines()
            .iter()
            .filter_map(|line| match line {
                OutLine::Warn(text) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// JS number → JSON value: integers render without a decimal point
/// (`JSON.stringify(1)` is `"1"`, never `"1.0"`).
pub fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// JS number → display string (`String(1)` is `"1"`, `String(1.5)` `"1.5"`).
pub fn js_number_string(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// JS `Number.parseFloat` — parses the longest leading float prefix
/// (`"2abc"` → 2, `"1.5x"` → 1.5, `""`/`"abc"` → NaN). The account `weight`
/// and budget cap flags rely on this exact leniency.
pub fn js_parse_float(value: &str) -> f64 {
    let s = value.trim_start();
    let bytes = s.as_bytes();
    let mut end = 0usize;
    let mut seen_digit = false;
    let mut seen_dot = false;
    if end < bytes.len() && (bytes[end] == b'+' || bytes[end] == b'-') {
        end += 1;
    }
    // JS also accepts a leading "Infinity"; parseFloat("Infinity") is +inf.
    let after_sign = &s[end.min(s.len())..];
    if after_sign.starts_with("Infinity") {
        return if bytes.first() == Some(&b'-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    while end < bytes.len() {
        let b = bytes[end];
        if b.is_ascii_digit() {
            seen_digit = true;
            end += 1;
        } else if b == b'.' && !seen_dot {
            seen_dot = true;
            end += 1;
        } else {
            break;
        }
    }
    if !seen_digit {
        return f64::NAN;
    }
    // Optional exponent.
    if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
        let mut exp_end = end + 1;
        if exp_end < bytes.len() && (bytes[exp_end] == b'+' || bytes[exp_end] == b'-') {
            exp_end += 1;
        }
        let digits_start = exp_end;
        while exp_end < bytes.len() && bytes[exp_end].is_ascii_digit() {
            exp_end += 1;
        }
        if exp_end > digits_start {
            end = exp_end;
        }
    }
    s[..end].parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `String.prototype.slice(0, n)` over UTF-16 code units (the TS
/// truncations for notes/thread names count UTF-16 units, not chars).
pub fn js_slice_utf16(value: &str, max_units: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= max_units {
        return value.to_string();
    }
    String::from_utf16_lossy(&units[..max_units])
}

/// UTF-16 length of a string (JS `String.prototype.length`).
pub fn js_len_utf16(value: &str) -> usize {
    value.encode_utf16().count()
}

// ---------------------------------------------------------------------------
// buildSelectAccountTraced (dispatcher-owned scorer for `why-selected`)
// ---------------------------------------------------------------------------

/// Port of the TS `buildSelectAccountTraced()` closure body: score every
/// stored account through the process-global (volatile, never persisted)
/// health/token trackers.
pub fn select_account_traced(storage: &AccountStorageV3) -> HybridSelectionTraceResult {
    let now = cma_core::utils::now_ms();
    let health_tracker = get_health_tracker(None);
    let token_tracker = get_token_tracker(None);
    let accounts_with_metrics: Vec<AccountWithMetrics> = storage
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| {
            let enabled = account.enabled != Some(false);
            let mut rate_limited = false;
            if let Some(rate_limits) = &account.rate_limit_reset_times {
                for (_, value) in rate_limits.iter() {
                    if value > now {
                        rate_limited = true;
                        break;
                    }
                }
            }
            let cooling_down = matches!(account.cooling_down_until, Some(until) if until > now);
            let is_available = enabled && !rate_limited && !cooling_down;
            AccountWithMetrics {
                index,
                tracker_key: Some(match &account.account_id {
                    Some(id) => TrackerKey::Text(id.clone()),
                    None => TrackerKey::Number(index as i64),
                }),
                is_available,
                last_used: account.last_used,
            }
        })
        .collect();
    select_hybrid_account_traced(SelectHybridAccountParams::new(
        &accounts_with_metrics,
        health_tracker,
        token_tracker,
    ))
}

/// The dispatcher's `why-selected` snapshot wrapper: the persisted runtime
/// observability snapshot contributes ONLY `generatedAt` (number|string;
/// anything else leaves the key absent). `None` when no snapshot exists.
pub fn why_selected_runtime_snapshot() -> Option<Value> {
    let snapshot = cma_runtime::observability::load_persisted_runtime_observability_snapshot()?;
    let value = serde_json::to_value(&snapshot).ok()?;
    let mut wrapped = serde_json::Map::new();
    if let Some(generated_at) = value.get("generatedAt")
        && (generated_at.is_number() || generated_at.is_string())
    {
        wrapped.insert("generatedAt".to_string(), generated_at.clone());
    }
    Some(Value::Object(wrapped))
}

// ---------------------------------------------------------------------------
// autoSyncActiveAccountToCodex (exported; called by the wrapper)
// ---------------------------------------------------------------------------

/// Port of TS `autoSyncActiveAccountToCodex(): Promise<boolean>`.
///
/// Deviation note: TS lets a storage-transaction rejection propagate to the
/// caller; the Rust boolean surface maps any transaction error to `false`
/// (the wrapper treats both identically — "sync did not complete").
pub async fn auto_sync_active_account_to_codex() -> bool {
    cma_storage::facade::set_storage_path(None);
    let Some(loaded) = cma_storage::load::load_accounts().await else {
        return false;
    };
    let storage = loaded.storage;
    if storage.accounts.is_empty() {
        return false;
    }

    let active_index =
        cma_runtime::account_status::resolve_active_index(&storage, ModelFamily::Codex);
    if active_index >= storage.accounts.len() {
        return false;
    }
    let account = &storage.accounts[active_index];
    let account_match = AccountSelectionCandidate {
        account_id: account.account_id.clone(),
        email: account.email.clone(),
        refresh_token: Some(account.refresh_token.clone()),
    };

    let now = cma_core::utils::now_ms();
    let mut sync_access_token = account.access_token.clone();
    let mut sync_refresh_token = account.refresh_token.clone();
    let mut sync_expires_at = account.expires_at;
    let mut sync_id_token: Option<String> = None;
    let mut sync_account_id = account.account_id.clone();
    let mut sync_email = account.email.clone();
    let mut changed = false;
    let mut next_stored_account: Option<AccountMetadataV3> = None;

    if !crate::login::account_credentials::has_usable_access_token(account, now) {
        let refresh_result = cma_auth::refresh_queue::queued_refresh(&account.refresh_token).await;
        let TokenResult::Success(success) = refresh_result else {
            return false;
        };
        let mut next = account.clone();
        let token_account_id = extract_account_id(Some(&success.access));
        let next_email = sanitize_email(
            extract_account_email(Some(&success.access), success.id_token.as_deref()).as_deref(),
        );
        if next.refresh_token != success.refresh {
            next.refresh_token = success.refresh.clone();
            changed = true;
        }
        if next.access_token.as_deref() != Some(success.access.as_str()) {
            next.access_token = Some(success.access.clone());
            changed = true;
        }
        if next.expires_at != Some(success.expires) {
            next.expires_at = Some(success.expires);
            changed = true;
        }
        if let Some(next_email_value) = &next_email
            && next.email.as_deref() != Some(next_email_value.as_str())
        {
            next.email = Some(next_email_value.clone());
            changed = true;
        }
        if crate::login::account_credentials::apply_token_account_identity(
            &mut next,
            token_account_id.as_deref(),
        ) {
            changed = true;
        }
        sync_access_token = Some(success.access.clone());
        sync_refresh_token = success.refresh.clone();
        sync_expires_at = Some(success.expires);
        sync_id_token = success.id_token.clone();
        sync_account_id = next.account_id.clone();
        sync_email = next.email.clone();
        next_stored_account = Some(next);
    }

    if changed && let Some(next_stored) = next_stored_account.clone() {
        let match_candidate = account_match.clone();
        let persisted = cma_storage::transactions::with_account_storage_transaction(
            move |loaded_storage, persist| async move {
                let Some(loaded_storage) = loaded_storage else {
                    return Ok(false);
                };
                let mut next_storage = loaded_storage.clone();
                let options = AccountMatchOptions {
                    allow_unique_account_id_fallback_without_email: true,
                };
                let target_index =
                    find_matching_account_index(&next_storage.accounts, &match_candidate, options)
                        .or_else(|| {
                            find_matching_account_index(
                                &next_storage.accounts,
                                &next_stored,
                                options,
                            )
                        });
                let Some(target_index) = target_index else {
                    return Ok(false);
                };
                next_storage.accounts[target_index] = next_stored.clone();
                persist.persist(&next_storage).await?;
                Ok(true)
            },
        )
        .await;
        if !matches!(persisted, Ok(true)) {
            return false;
        }
    }

    cma_cli_mirror::writer::set_codex_cli_active_selection(&cma_cli_mirror::writer::ActiveSelection {
        account_id: sync_account_id,
        email: sync_email,
        access_token: sync_access_token,
        refresh_token: Some(sync_refresh_token),
        expires_at: sync_expires_at.map(|v| v as f64),
        id_token: sync_id_token,
    })
    .await
}

// ---------------------------------------------------------------------------
// runCodexMultiAuthCli
// ---------------------------------------------------------------------------

/// Port of TS `runCodexMultiAuthCli(rawArgs): Promise<number>` (production
/// sink; the bin calls this).
pub async fn run_codex_multi_auth_cli(raw_args: &[String]) -> i32 {
    let mut out = CliOut::stdio();
    run_codex_multi_auth_cli_with(raw_args, &mut out).await
}

/// Sink-injectable core of [`run_codex_multi_auth_cli`].
pub async fn run_codex_multi_auth_cli_with(raw_args: &[String], out: &mut CliOut) -> i32 {
    // Lazy install setup (audit roadmap §4.5.4). ensureFirstRunSetup never
    // throws; no command can ever fail because of first-run housekeeping.
    let notify: cma_runtime::app_launcher::SharedLogSink =
        Arc::new(|message: &str| eprintln!("codex-multi-auth: {message}"));
    let _ = cma_runtime::first_run::ensure_first_run_setup(
        cma_runtime::first_run::FirstRunSetupDeps {
            notify: Some(notify),
            ..Default::default()
        },
    )
    .await;
    let startup_display_settings =
        cma_config::dashboard_settings::load_dashboard_display_settings().await;
    crate::settings::hub::apply_ui_theme_from_dashboard_settings(&startup_display_settings);

    // `auth` prefix normalization: `codex-multi-auth status` ≡
    // `codex-multi-auth auth status`.
    let args: Vec<String> = match raw_args.first() {
        Some(first)
            if !first.is_empty() && first != "auth" && is_account_manager_command(first) =>
        {
            let mut prefixed = Vec::with_capacity(raw_args.len() + 1);
            prefixed.push("auth".to_string());
            prefixed.extend(raw_args.iter().cloned());
            prefixed
        }
        _ => raw_args.to_vec(),
    };

    if args.is_empty() {
        print_usage(out);
        return 0;
    }
    if args[0] == "--help" || args[0] == "-h" {
        print_usage(out);
        return 0;
    }

    let root = args[0].as_str();
    let sub = args.get(1).cloned();
    let rest: Vec<String> = if args.len() > 2 {
        args[2..].to_vec()
    } else {
        Vec::new()
    };
    if root != "auth" {
        print_usage(out);
        return 1;
    }

    let command = sub.unwrap_or_else(|| "login".to_string());
    if command == "--help" || command == "-h" {
        print_usage(out);
        return 0;
    }

    dispatch_command(&command, &rest, out).await
}

/// Exact-match handler map (TS `CLI_COMMAND_HANDLERS`). Keys are unique so a
/// `match` is behavior-identical to the TS `Map` lookup.
async fn dispatch_command(command: &str, rest: &[String], out: &mut CliOut) -> i32 {
    match command {
        "login" => crate::login::flow::run_auth_login(rest, out).await,
        "list" | "status" => {
            let json = rest.iter().any(|arg| arg == "--json" || arg == "-j");
            crate::commands::status::run_status_command(json, out).await
        }
        "switch" => crate::commands::switch::run_switch_command(rest, out).await,
        "unpin" => crate::commands::unpin::run_unpin_command(out).await,
        "workspace" => crate::commands::workspace::run_workspace_command(rest, out).await,
        "check" => crate::commands::check::run_check_command(rest, out).await,
        "features" => crate::commands::status::run_features_command(out),
        "verify-flagged" => crate::repair::verify_flagged::run_verify_flagged(rest, out).await,
        "forecast" => crate::commands::forecast::run_forecast_command(rest, out).await,
        "best" => crate::commands::best::run_best_command(rest, out).await,
        "account" => crate::commands::account::run_account_command(rest, out).await,
        "budget" => crate::commands::budget::run_budget_command(rest, out).await,
        "bridge" => crate::commands::bridge::run_bridge_command(rest, out).await,
        "integrations" => crate::commands::integrations::run_integrations_command(rest, out),
        "models" => crate::commands::models::run_models_command(rest, out).await,
        "monitor" => crate::commands::monitor::run_monitor_command(rest, out).await,
        "report" => crate::commands::report::run_report_command(rest, out).await,
        "usage" => crate::commands::usage::run_usage_command(rest, out).await,
        "rotation" => crate::commands::rotation::run_rotation_command(rest, out).await,
        "why-selected" => crate::commands::why_selected::run_why_selected_command(rest, out).await,
        "history" => crate::commands::history::run_history_command(rest, out),
        "verify" => crate::commands::verify::run_verify_command(rest, out).await,
        "fix" => crate::repair::fix::run_fix(rest, out).await,
        "doctor" => crate::repair::doctor::run_doctor(rest, out).await,
        "uninstall" => crate::commands::uninstall::run_uninstall_command(rest, out).await,
        "config" => {
            let subcommand = rest.first().map(String::as_str);
            let config_args: Vec<String> = if rest.len() > 1 {
                rest[1..].to_vec()
            } else {
                Vec::new()
            };
            match subcommand {
                Some("explain") => {
                    crate::commands::config_explain::run_config_explain_command(&config_args, out)
                }
                Some("template") => {
                    crate::commands::init_config::run_init_config_command(&config_args, out).await
                }
                _ => {
                    out.error(format!(
                        "Unknown config command: {}",
                        subcommand.unwrap_or("(missing)")
                    ));
                    1
                }
            }
        }
        "init-config" => crate::commands::init_config::run_init_config_command(rest, out).await,
        "debug" => {
            let subcommand = rest.first().map(String::as_str);
            let debug_args: Vec<String> = if rest.len() > 1 {
                rest[1..].to_vec()
            } else {
                Vec::new()
            };
            match subcommand {
                Some("bundle") => {
                    crate::commands::debug_bundle::run_debug_bundle_command(&debug_args, out).await
                }
                _ => {
                    out.error(format!(
                        "Unknown debug command: {}",
                        subcommand.unwrap_or("(missing)")
                    ));
                    1
                }
            }
        }
        _ => {
            out.error(format!("Unknown command: {command}"));
            print_usage(out);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn js_number_renders_integers_without_decimal() {
        assert_eq!(serde_json::to_string(&js_number(1.0)).unwrap(), "1");
        assert_eq!(serde_json::to_string(&js_number(0.5)).unwrap(), "0.5");
        assert_eq!(js_number_string(1.0), "1");
        assert_eq!(js_number_string(2.5), "2.5");
        assert_eq!(js_number_string(0.0), "0");
    }

    #[test]
    fn js_parse_float_matches_parse_float_leniency() {
        assert_eq!(js_parse_float("2abc"), 2.0);
        assert_eq!(js_parse_float("1.5"), 1.5);
        assert_eq!(js_parse_float(" 3 "), 3.0);
        assert_eq!(js_parse_float("-0.25x"), -0.25);
        assert!(js_parse_float("abc").is_nan());
        assert!(js_parse_float("").is_nan());
        assert!(js_parse_float("Infinity").is_infinite());
        assert_eq!(js_parse_float("1e2"), 100.0);
        assert_eq!(js_parse_float("1e"), 1.0);
    }

    #[test]
    fn js_slice_utf16_counts_utf16_units() {
        assert_eq!(js_slice_utf16("abcdef", 3), "abc");
        assert_eq!(js_slice_utf16("ab", 5), "ab");
        // '𝒳' is one surrogate pair = 2 UTF-16 units.
        assert_eq!(js_len_utf16("𝒳"), 2);
    }

    #[test]
    fn cliout_capture_separates_streams() {
        let mut out = CliOut::capture();
        out.info("a");
        out.warn("w");
        out.error("e");
        out.info("b");
        assert_eq!(out.info_text(), "a\nb");
        assert_eq!(out.warn_text(), "w");
        assert_eq!(out.error_text(), "e");
    }

    // Dispatcher routing tests exercising only dispatcher-owned paths (no
    // sibling command execution): unknown config/debug subcommands.
    #[tokio::test]
    async fn unknown_config_subcommand_errors_with_exact_string() {
        let mut out = CliOut::capture();
        let code = dispatch_command("config", &args(&["bogus"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown config command: bogus");

        let mut out = CliOut::capture();
        let code = dispatch_command("config", &[], &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown config command: (missing)");
    }

    #[tokio::test]
    async fn unknown_debug_subcommand_errors_with_exact_string() {
        let mut out = CliOut::capture();
        let code = dispatch_command("debug", &args(&["trace"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown debug command: trace");
    }

    #[tokio::test]
    async fn unknown_command_prints_error_then_usage() {
        let mut out = CliOut::capture();
        let code = dispatch_command("bogus", &[], &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown command: bogus");
        assert!(out.info_text().starts_with("Codex Multi-Auth CLI"));
    }
}
