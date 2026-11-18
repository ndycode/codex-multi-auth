//! Port of `lib/codex-manager/commands/forecast.ts`.
//!
//! `forecast [--live] [--json] [--explain] [--model <model>]
//! [--no-runtime-overlay]` — best-account preview with optional live quota
//! probing.
//!
//! Contract divergences vs `best`/`report` (spec 08 gotchas 2/3/4/5/16/17):
//! - zero accounts exits 0;
//! - probe-refresh patches apply in memory BEFORE persisting and stay
//!   applied on persist failure;
//! - persistence goes through the reload-clone `persist_refreshed_account_patch`;
//! - `--model` without `--live` is silently accepted;
//! - quota-cache saves are best-effort (never change the exit code);
//! - forecast scoring sees the ORIGINAL loaded quota cache while live
//!   results mutate a working CLONE.

use std::collections::HashMap;

use cma_accounts::rate_limits::format_wait_time;
use cma_config::dashboard_settings::load_dashboard_display_settings;
use cma_core::json_io::stringify_pretty2;
use cma_core::model_family::{DEFAULT_PROBE_MODEL, ModelFamily};
use cma_core::schemas::account_storage::{AccountIdSource, AccountStorageV3};
use cma_core::schemas::token::{TokenFailure, TokenResult};
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_quota::forecast::{
    ForecastAccountInput, RuntimeForecastOverlay, build_forecast_explanation,
    evaluate_forecast_accounts, recommend_forecast_account, summarize_forecast,
};
use cma_quota::probe::{
    CodexQuotaSnapshot, ProbeCodexQuotaOptions, describe_codex_probe_failure,
    fetch_codex_quota_snapshot,
};
use cma_quota::readiness::build_quota_email_fallback_state;
use cma_request::model_map::resolve_normalized_model;
use cma_runtime::observability::RuntimeObservabilitySnapshot;
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    AccountIdentityMatch, RefreshedAccountPatch, apply_refreshed_account_patch,
    persist_refreshed_account_patch, serialize_forecast_results,
};
use crate::formatters::account::{availability_tone, risk_tone};
use crate::formatters::quota::{
    CompactQuotaFormatOptions, format_compact_quota_snapshot, style_quota_summary,
};
use crate::formatters::text_style::{
    PromptTone, ResultSegment, format_result_summary, join_styled_segments, style_prompt_text,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct ForecastCliOptions {
    live: bool,
    json: bool,
    explain: bool,
    model: String,
    runtime_overlay: bool,
}

impl Default for ForecastCliOptions {
    fn default() -> Self {
        ForecastCliOptions {
            live: false,
            json: false,
            explain: false,
            model: DEFAULT_PROBE_MODEL.to_string(),
            runtime_overlay: true,
        }
    }
}

fn print_forecast_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:".to_string(),
            "  codex-multi-auth forecast [--live] [--json] [--explain] [--model <model>]"
                .to_string(),
            String::new(),
            "Options:".to_string(),
            "  --live, -l         Probe live quota headers via Codex backend".to_string(),
            "  --json, -j         Print machine-readable JSON output".to_string(),
            "  --explain          Include structured recommendation reasoning".to_string(),
            format!("  --model, -m        Probe model for live mode (default: {DEFAULT_PROBE_MODEL})"),
            "  --no-runtime-overlay  Ignore persisted runtime skip diagnostics".to_string(),
        ]
        .join("\n"),
    );
}

fn parse_forecast_args(args: &[String]) -> Result<ForecastCliOptions, String> {
    let mut options = ForecastCliOptions::default();

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        match arg {
            "--live" | "-l" => {
                options.live = true;
                i += 1;
                continue;
            }
            "--json" | "-j" => {
                options.json = true;
                i += 1;
                continue;
            }
            "--explain" => {
                options.explain = true;
                i += 1;
                continue;
            }
            "--no-runtime-overlay" => {
                options.runtime_overlay = false;
                i += 1;
                continue;
            }
            "--model" | "-m" => {
                let value = args.get(i + 1).map(|v| v.trim().to_string());
                match value {
                    Some(v) if !v.is_empty() && !v.starts_with('-') => {
                        options.model = v;
                        i += 2;
                        continue;
                    }
                    _ => return Err("Missing value for --model".to_string()),
                }
            }
            _ => {}
        }
        if let Some(raw) = arg.strip_prefix("--model=") {
            let value = raw.trim();
            if value.is_empty() || value.starts_with('-') {
                return Err("Missing value for --model".to_string());
            }
            options.model = value.to_string();
            i += 1;
            continue;
        }
        return Err(format!("Unknown option: {arg}"));
    }

    Ok(options)
}

/// Persisted runtime-observability snapshot → forecast overlay (the TS
/// passed the snapshot straight through; Rust converts to the quota crate's
/// typed overlay, keeping only string skip reasons).
fn snapshot_to_overlay(snapshot: &RuntimeObservabilitySnapshot) -> RuntimeForecastOverlay {
    let string_map = |map: &serde_json::Map<String, Value>| -> HashMap<String, String> {
        map.iter()
            .filter_map(|(key, value)| {
                value
                    .as_str()
                    .map(|text| (key.clone(), text.to_string()))
            })
            .collect()
    };
    RuntimeForecastOverlay {
        account_skip_reasons: string_map(&snapshot.account_skip_reasons),
        last_pool_exhaustion_skip_reasons: string_map(&snapshot.last_pool_exhaustion_skip_reasons),
        policy_blocked_indexes: snapshot
            .policy_blocked_indexes
            .iter()
            .filter(|index| **index >= 0)
            .map(|index| *index as usize)
            .collect(),
    }
}

/// TS `runForecastCommand(args, deps)`.
pub async fn run_forecast_command(args: &[String], out: &mut CliOut) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_forecast_usage(out);
        return 0;
    }

    let options = match parse_forecast_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            print_forecast_usage(out);
            return 1;
        }
    };
    let trimmed_model = options.model.trim();
    let requested_model = if trimmed_model.is_empty() {
        DEFAULT_PROBE_MODEL.to_string()
    } else {
        trimmed_model.to_string()
    };
    let probe_model = resolve_normalized_model(Some(&requested_model));
    let display = load_dashboard_display_settings().await;
    let quota_cache = cma_quota::cache::load_quota_cache().await;
    let runtime_overlay: Option<RuntimeForecastOverlay> = if options.runtime_overlay {
        cma_runtime::observability::load_persisted_runtime_observability_snapshot()
            .map(|snapshot| snapshot_to_overlay(&snapshot))
    } else {
        None
    };
    // Forecast scoring sees the ORIGINAL cache; live results mutate a CLONE
    // (spec 08 gotcha 17).
    let mut working_quota_cache = quota_cache.clone();
    let mut quota_cache_changed = false;

    cma_storage::facade::set_storage_path(None);
    let mut storage: AccountStorageV3 = match cma_storage::load::load_accounts().await {
        Some(loaded) if !loaded.storage.accounts.is_empty() => loaded.storage,
        _ => {
            out.info("No accounts configured.");
            return 0;
        }
    };
    let quota_email_fallback_state = if options.live {
        Some(build_quota_email_fallback_state(&storage.accounts))
    } else {
        None
    };

    let now = cma_core::utils::now_ms();
    let active_index =
        cma_runtime::account_status::resolve_active_index(&storage, ModelFamily::Codex);
    let mut refresh_failures: HashMap<usize, TokenFailure> = HashMap::new();
    let mut live_quota_by_index: HashMap<usize, CodexQuotaSnapshot> = HashMap::new();
    let mut probe_errors: Vec<String> = Vec::new();

    for i in 0..storage.accounts.len() {
        if !options.live || storage.accounts[i].enabled == Some(false) {
            continue;
        }

        let label = cma_accounts::manager_persistence::format_account_label(
            Some(&storage.accounts[i] as &dyn cma_accounts::manager_persistence::AccountLabelSource),
            i,
        );
        let mut probe_access_token = storage.accounts[i].access_token.clone();
        let mut probe_account_id = storage.accounts[i]
            .account_id
            .clone()
            .or_else(|| extract_account_id(storage.accounts[i].access_token.as_deref()));
        if !crate::login::account_credentials::has_usable_access_token(&storage.accounts[i], now) {
            let refresh_result =
                cma_auth::refresh_queue::queued_refresh(&storage.accounts[i].refresh_token).await;
            let success = match refresh_result {
                TokenResult::Success(success) => success,
                TokenResult::Failed(failure) => {
                    let mut normalized = failure.clone();
                    normalized.message =
                        Some(crate::formatters::text_style::normalize_failure_detail(
                            failure.message.as_deref(),
                            failure.reason.map(|reason| reason.as_str()),
                        ));
                    refresh_failures.insert(i, normalized);
                    continue;
                }
            };
            let refreshed_email = sanitize_email(
                extract_account_email(Some(&success.access), success.id_token.as_deref())
                    .as_deref(),
            );
            let refreshed_account_id = extract_account_id(Some(&success.access));
            let previous_refresh_token = storage.accounts[i].refresh_token.clone();
            let previous_access_token = storage.accounts[i].access_token.clone();
            let previous_expires_at = storage.accounts[i].expires_at;
            let previous_email = storage.accounts[i].email.clone();
            let previous_account_id = storage.accounts[i].account_id.clone();
            let mut refresh_patch = RefreshedAccountPatch {
                refresh_token: success.refresh.clone(),
                access_token: success.access.clone(),
                expires_at: success.expires,
                email: None,
                account_id: None,
                account_id_source: None,
            };
            if let Some(email) = &refreshed_email {
                refresh_patch.email = Some(email.clone());
            }
            if let Some(account_id) = &refreshed_account_id {
                refresh_patch.account_id = Some(account_id.clone());
                refresh_patch.account_id_source = Some(AccountIdSource::Token);
            }
            let account_match = AccountIdentityMatch {
                refresh_token: Some(previous_refresh_token.clone()),
                email: previous_email.clone(),
                account_id: previous_account_id.clone(),
            };
            // Apply the in-memory patch FIRST (spec 08 gotcha 3: it stays
            // applied even when the persist below fails).
            apply_refreshed_account_patch(&mut storage.accounts[i], &refresh_patch);
            probe_access_token = Some(success.access.clone());
            probe_account_id = storage.accounts[i]
                .account_id
                .clone()
                .or(refreshed_account_id);
            if previous_refresh_token != refresh_patch.refresh_token
                || previous_access_token.as_deref() != Some(refresh_patch.access_token.as_str())
                || previous_expires_at != Some(refresh_patch.expires_at)
                || previous_email != storage.accounts[i].email
                || previous_account_id != storage.accounts[i].account_id
            {
                let persisted = persist_refreshed_account_patch(
                    &storage,
                    &account_match,
                    &refresh_patch,
                    || async {
                        cma_storage::load::load_accounts()
                            .await
                            .map(|loaded| loaded.storage)
                    },
                    |next_storage: &AccountStorageV3| {
                        let snapshot = next_storage.clone();
                        async move { cma_storage::save::save_accounts(&snapshot).await }
                    },
                )
                .await;
                if let Err(error) = persisted {
                    let message = crate::formatters::text_style::normalize_failure_detail(
                        Some(error.message()),
                        None,
                    );
                    probe_errors.push(format!("{label}: {message}"));
                    continue;
                }
            }
        }

        let (Some(probe_access_token), Some(probe_account_id)) =
            (probe_access_token, probe_account_id)
        else {
            probe_errors.push(format!("{label}: missing accountId for live probe"));
            continue;
        };

        match fetch_codex_quota_snapshot(&ProbeCodexQuotaOptions {
            account_id: probe_account_id,
            access_token: probe_access_token,
            model: Some(probe_model.to_string()),
            ..Default::default()
        })
        .await
        {
            Ok(live_quota) => {
                quota_cache_changed = crate::quota_cache_helpers::update_quota_cache_for_account(
                    &mut working_quota_cache,
                    &storage.accounts[i],
                    &live_quota,
                    &storage.accounts,
                    quota_email_fallback_state.as_ref(),
                ) || quota_cache_changed;
                live_quota_by_index.insert(i, live_quota);
            }
            Err(error) => {
                let message = describe_codex_probe_failure(
                    &error,
                    Some(&|raw: &str| {
                        crate::formatters::text_style::normalize_failure_detail(Some(raw), None)
                    }),
                );
                probe_errors.push(format!("{label}: {message}"));
            }
        }
    }

    let forecast_inputs: Vec<ForecastAccountInput<'_>> = storage
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| ForecastAccountInput {
            index,
            account,
            is_current: index == active_index,
            now,
            refresh_failure: refresh_failures.get(&index),
            live_quota: live_quota_by_index.get(&index),
            quota_cache: Some(&quota_cache),
            all_accounts: Some(&storage.accounts),
            runtime_overlay: runtime_overlay.as_ref(),
        })
        .collect();
    let forecast_results = evaluate_forecast_accounts(&forecast_inputs);
    drop(forecast_inputs);
    let summary = summarize_forecast(&forecast_results);
    let recommendation = recommend_forecast_account(&forecast_results);
    let explanation = build_forecast_explanation(&forecast_results, &recommendation);

    if options.json {
        if quota_cache_changed {
            // Quota cache is a derived artifact; failures must never abort
            // the JSON output (the Rust saver is internally best-effort).
            cma_quota::cache::save_quota_cache(&working_quota_cache).await;
        }
        let mut payload = Map::new();
        payload.insert("command".to_string(), Value::String("forecast".to_string()));
        payload.insert("model".to_string(), Value::String(requested_model.clone()));
        payload.insert("liveProbe".to_string(), Value::Bool(options.live));
        payload.insert(
            "runtimeOverlay".to_string(),
            Value::Bool(options.runtime_overlay),
        );
        payload.insert(
            "summary".to_string(),
            serde_json::to_value(summary).unwrap_or(Value::Null),
        );
        payload.insert(
            "recommendation".to_string(),
            serde_json::to_value(&recommendation).unwrap_or(Value::Null),
        );
        if options.explain {
            payload.insert(
                "explanation".to_string(),
                serde_json::to_value(&explanation).unwrap_or(Value::Null),
            );
        }
        payload.insert(
            "probeErrors".to_string(),
            Value::Array(
                probe_errors
                    .iter()
                    .map(|error| Value::String(error.clone()))
                    .collect(),
            ),
        );
        payload.insert(
            "accounts".to_string(),
            Value::Array(serialize_forecast_results(
                &forecast_results,
                &live_quota_by_index,
                &refresh_failures,
                &|snapshot: &CodexQuotaSnapshot| {
                    cma_quota::probe::format_quota_snapshot_line(snapshot)
                },
            )),
        );
        out.info(stringify_pretty2(&Value::Object(payload)));
        return 0;
    }

    out.info(style_prompt_text(
        &format!(
            "Best-account preview ({} account(s), model {requested_model}, live check {})",
            storage.accounts.len(),
            if options.live { "on" } else { "off" }
        ),
        PromptTone::Accent,
    ));
    out.info(format_result_summary(&[
        ResultSegment::new(format!("{} ready now", summary.ready), PromptTone::Success),
        ResultSegment::new(format!("{} waiting", summary.delayed), PromptTone::Warning),
        ResultSegment::new(
            format!("{} unavailable", summary.unavailable),
            if summary.unavailable > 0 {
                PromptTone::Danger
            } else {
                PromptTone::Muted
            },
        ),
        ResultSegment::new(
            format!("{} high risk", summary.high_risk),
            if summary.high_risk > 0 {
                PromptTone::Danger
            } else {
                PromptTone::Muted
            },
        ),
    ]));
    out.info("");

    for result in &forecast_results {
        if !display.show_per_account_rows {
            continue;
        }
        let current_tag = if result.is_current { " [current]" } else { "" };
        let wait_label = if result.wait_ms > 0 {
            style_prompt_text(
                &format!("wait {}", format_wait_time(result.wait_ms)),
                PromptTone::Muted,
            )
        } else {
            String::new()
        };
        let index_label = style_prompt_text(&format!("{}.", result.index + 1), PromptTone::Accent);
        let account_label =
            style_prompt_text(&format!("{}{current_tag}", result.label), PromptTone::Accent);
        let risk_label = style_prompt_text(
            &format!("{} risk ({})", result.risk_level.as_str(), result.risk_score),
            risk_tone(result.risk_level),
        );
        let availability_label = style_prompt_text(
            result.availability.as_str(),
            availability_tone(result.availability),
        );
        let mut row_parts = vec![availability_label, risk_label];
        if !wait_label.is_empty() {
            row_parts.push(wait_label);
        }
        out.info(format!(
            "{index_label} {account_label} {} {}",
            style_prompt_text("|", PromptTone::Muted),
            join_styled_segments(&row_parts)
        ));
        if display.show_forecast_reasons && !result.reasons.is_empty() {
            out.info(format!(
                "   {}",
                style_prompt_text(
                    &result
                        .reasons
                        .iter()
                        .take(3)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("; "),
                    PromptTone::Muted
                )
            ));
        }
        if display.show_quota_details
            && let Some(live_quota) = live_quota_by_index.get(&result.index)
        {
            out.info(format!(
                "   {} {}",
                style_prompt_text("quota:", PromptTone::Accent),
                style_quota_summary(&format_compact_quota_snapshot(
                    live_quota,
                    cma_core::utils::now_ms(),
                    &CompactQuotaFormatOptions::default(),
                ))
            ));
        }
    }

    if !display.show_per_account_rows {
        out.info(style_prompt_text(
            "Per-account lines are hidden in dashboard settings.",
            PromptTone::Muted,
        ));
    }

    if display.show_recommendations || options.explain {
        out.info("");
    }

    if display.show_recommendations {
        if let Some(index) = recommendation.recommended_index {
            if let Some(account) = forecast_results.iter().find(|result| result.index == index) {
                out.info(format!(
                    "{} {}",
                    style_prompt_text("Best next account:", PromptTone::Accent),
                    style_prompt_text(
                        &format!("{} ({})", index + 1, account.label),
                        PromptTone::Success
                    )
                ));
                out.info(format!(
                    "{} {}",
                    style_prompt_text("Why:", PromptTone::Accent),
                    style_prompt_text(&recommendation.reason, PromptTone::Muted)
                ));
                if index != active_index {
                    out.info(format!(
                        "{} codex-multi-auth switch {}",
                        style_prompt_text("Switch now with:", PromptTone::Accent),
                        index + 1
                    ));
                }
            }
        } else {
            out.info(format!(
                "{} {}",
                style_prompt_text("Note:", PromptTone::Accent),
                style_prompt_text(&recommendation.reason, PromptTone::Muted)
            ));
        }
    }

    if options.explain {
        out.info(format!(
            "{} {}",
            style_prompt_text("Explain:", PromptTone::Accent),
            style_prompt_text(&explanation.recommendation_reason, PromptTone::Muted)
        ));
        for item in &explanation.considered {
            let selected_label = if item.selected { " selected" } else { "" };
            let wait_label = if item.wait_ms > 0 {
                format!(", wait {}", format_wait_time(item.wait_ms))
            } else {
                String::new()
            };
            let tone = if item.selected {
                PromptTone::Success
            } else {
                PromptTone::Muted
            };
            out.info(format!(
                "  {} {}",
                style_prompt_text(if item.selected { "*" } else { "-" }, tone),
                style_prompt_text(
                    &format!(
                        "{}. {}{}: {}, {} risk ({}){wait_label}{selected_label}",
                        item.index + 1,
                        item.label,
                        if item.is_current { " [current]" } else { "" },
                        item.availability.as_str(),
                        item.risk_level.as_str(),
                        item.risk_score
                    ),
                    tone
                )
            ));
            if !item.reasons.is_empty() {
                out.info(format!(
                    "    {}",
                    style_prompt_text(
                        &item
                            .reasons
                            .iter()
                            .take(3)
                            .cloned()
                            .collect::<Vec<_>>()
                            .join("; "),
                        PromptTone::Muted
                    )
                ));
            }
        }
    }

    if display.show_live_probe_notes && !probe_errors.is_empty() {
        out.info("");
        out.info(style_prompt_text(
            &format!("Live check notes ({}):", probe_errors.len()),
            PromptTone::Warning,
        ));
        for error in &probe_errors {
            out.info(format!(
                "  {} {}",
                style_prompt_text("-", PromptTone::Warning),
                style_prompt_text(error, PromptTone::Muted)
            ));
        }
    }
    if quota_cache_changed {
        // Best-effort save; tolerate transient Windows EBUSY/EPERM without
        // aborting the forecast (the Rust saver never propagates).
        cma_quota::cache::save_quota_cache(&working_quota_cache).await;
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // Port of test/codex-manager-forecast-command.test.ts (non-live surface).

    #[test]
    fn parse_accepts_the_forecast_flag_set() {
        let options = parse_forecast_args(&args(&[
            "--live",
            "--json",
            "--explain",
            "--no-runtime-overlay",
            "--model=gpt-5.5",
        ]))
        .unwrap();
        assert!(options.live);
        assert!(options.json);
        assert!(options.explain);
        assert!(!options.runtime_overlay);
        assert_eq!(options.model, "gpt-5.5");
    }

    #[test]
    fn parse_rejects_missing_model_and_unknown_options() {
        assert_eq!(
            parse_forecast_args(&args(&["--model"])),
            Err("Missing value for --model".to_string())
        );
        assert_eq!(
            parse_forecast_args(&args(&["--model", "--json"])),
            Err("Missing value for --model".to_string())
        );
        assert_eq!(
            parse_forecast_args(&args(&["--bogus"])),
            Err("Unknown option: --bogus".to_string())
        );
    }

    #[test]
    fn model_without_live_is_accepted_unlike_best() {
        // spec 08 gotcha 4.
        let options = parse_forecast_args(&args(&["--model", "gpt-5.5"])).unwrap();
        assert_eq!(options.model, "gpt-5.5");
        assert!(!options.live);
    }

    #[tokio::test]
    #[serial(env)]
    async fn no_accounts_exits_zero_with_message() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_forecast_command(&[], &mut out).await;
        assert_eq!(code, 0);
        assert_eq!(out.info_text(), "No accounts configured.");
    }

    #[tokio::test]
    #[serial(env)]
    async fn parse_error_prints_message_then_usage_and_exits_one() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_forecast_command(&args(&["--bogus"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown option: --bogus");
        assert!(out.info_text().starts_with("Usage:"));
    }

    #[test]
    fn snapshot_overlay_keeps_only_string_reasons_and_valid_indexes() {
        let mut snapshot = cma_runtime::observability::create_default_snapshot();
        snapshot
            .account_skip_reasons
            .insert("0".to_string(), serde_json::json!("rate-limited"));
        snapshot
            .account_skip_reasons
            .insert("1".to_string(), serde_json::json!(42));
        snapshot
            .last_pool_exhaustion_skip_reasons
            .insert("2".to_string(), serde_json::json!("cooldown"));
        snapshot.policy_blocked_indexes = vec![-1, 0, 3];
        let overlay = snapshot_to_overlay(&snapshot);
        assert_eq!(
            overlay.account_skip_reasons.get("0").map(String::as_str),
            Some("rate-limited")
        );
        assert!(!overlay.account_skip_reasons.contains_key("1"));
        assert_eq!(
            overlay
                .last_pool_exhaustion_skip_reasons
                .get("2")
                .map(String::as_str),
            Some("cooldown")
        );
        assert_eq!(overlay.policy_blocked_indexes, vec![0, 3]);
    }
}
