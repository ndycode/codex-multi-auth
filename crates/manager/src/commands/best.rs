//! Port of `lib/codex-manager/commands/best.ts`.
//!
//! `best [--live] [--json] [--model <model>]` — pick the healthiest account
//! via forecast scoring and switch to it (clearing any manual pin).
//!
//! Divergences that are CONTRACT (spec 08 gotchas 2/4/5/6/7):
//! - probe-refresh persistence uses PLAIN `save_accounts` (no retry wrapper);
//! - `--model` without `--live` is an error (forecast/report accept it);
//! - zero accounts exits 1 (forecast exits 0);
//! - in the already-on-best branch `lastUsed` is stamped only when a probe
//!   refresh already dirtied storage;
//! - `pinCleared` reflects the pin captured BEFORE the switch persists.

use cma_accounts::manager_persistence::{AccountLabelSource, format_account_label};
use cma_core::json_io::stringify_pretty2;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{AccountIdSource, AccountStorageV3, PersistedSwitchReason};
use cma_core::schemas::token::{TokenFailure, TokenResult};
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_quota::forecast::{
    ForecastAccountInput, evaluate_forecast_accounts, recommend_forecast_account,
};
use cma_quota::probe::{
    CodexQuotaSnapshot, ProbeCodexQuotaOptions, describe_codex_probe_failure,
    fetch_codex_quota_snapshot,
};
use cma_request::model_map::resolve_normalized_model;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use crate::dispatcher::CliOut;
use crate::help::{BestCliOptions, best_usage_text};

/// TS commands/best.ts `parseBestArgs` — NO `--help` branch (the runner
/// pre-checks help before parsing).
pub fn parse_best_args(args: &[String]) -> Result<BestCliOptions, String> {
    let mut options = BestCliOptions::default();

    let mut i = 0usize;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg.is_empty() {
            i += 1;
            continue;
        }
        if arg == "--live" || arg == "-l" {
            options.live = true;
            i += 1;
            continue;
        }
        if arg == "--json" || arg == "-j" {
            options.json = true;
            i += 1;
            continue;
        }
        if arg == "--model" || arg == "-m" {
            let value = args.get(i + 1).map(|v| v.trim().to_string());
            match value {
                Some(v) if !v.is_empty() && !v.starts_with('-') => {
                    options.model = v;
                    options.model_provided = true;
                    i += 2;
                    continue;
                }
                _ => return Err("Missing value for --model".to_string()),
            }
        }
        if let Some(raw) = arg.strip_prefix("--model=") {
            let value = raw.trim();
            if value.is_empty() || value.starts_with('-') {
                return Err("Missing value for --model".to_string());
            }
            options.model = value.to_string();
            options.model_provided = true;
            i += 1;
            continue;
        }
        return Err(format!("Unknown option: {arg}"));
    }

    Ok(options)
}

fn label_of(storage: &AccountStorageV3, index: usize) -> String {
    format_account_label(
        storage
            .accounts
            .get(index)
            .map(|account| account as &dyn AccountLabelSource),
        index,
    )
}

fn print_probe_notes(probe_errors: &[String], out: &mut CliOut) {
    if probe_errors.is_empty() {
        return;
    }
    out.info(format!("Live check notes ({}):", probe_errors.len()));
    for error in probe_errors {
        out.info(format!("  - {error}"));
    }
}

fn with_probe_errors(mut object: Map<String, Value>, probe_errors: &[String]) -> Value {
    if !probe_errors.is_empty() {
        object.insert(
            "probeErrors".to_string(),
            Value::Array(
                probe_errors
                    .iter()
                    .map(|error| Value::String(error.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(object)
}

/// TS `runBestCommand(args, deps)`.
///
/// Deviation note: a probe-persist `saveAccounts` failure (uncaught crash in
/// TS) prints the storage error on stderr and exits 1.
pub async fn run_best_command(args: &[String], out: &mut CliOut) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        out.info(best_usage_text());
        return 0;
    }

    let options = match parse_best_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            out.info(best_usage_text());
            return 1;
        }
    };
    let trimmed_model = options.model.trim();
    let probe_model = resolve_normalized_model(Some(if trimmed_model.is_empty() {
        crate::help::DEFAULT_LIVE_PROBE_MODEL
    } else {
        trimmed_model
    }));
    if options.model_provided && !options.live {
        out.error("--model requires --live for codex-multi-auth best");
        out.info(best_usage_text());
        return 1;
    }

    cma_storage::facade::set_storage_path(None);
    let mut storage: AccountStorageV3 = match cma_storage::load::load_accounts().await {
        Some(loaded) if !loaded.storage.accounts.is_empty() => loaded.storage,
        _ => {
            if options.json {
                out.info(stringify_pretty2(
                    &serde_json::json!({ "error": "No accounts configured." }),
                ));
            } else {
                out.info("No accounts configured.");
            }
            return 1;
        }
    };

    let now = cma_core::utils::now_ms();
    let mut refresh_failures: HashMap<usize, TokenFailure> = HashMap::new();
    let mut live_quota_by_index: HashMap<usize, CodexQuotaSnapshot> = HashMap::new();
    let mut probe_id_token_by_index: HashMap<usize, String> = HashMap::new();
    let mut probe_refreshed_indices: HashSet<usize> = HashSet::new();
    let mut probe_errors: Vec<String> = Vec::new();
    let mut changed = false;

    for i in 0..storage.accounts.len() {
        if !options.live || storage.accounts[i].enabled == Some(false) {
            continue;
        }

        let mut probe_access_token = storage.accounts[i].access_token.clone();
        let mut probe_account_id = storage.accounts[i].account_id.clone().or_else(|| {
            extract_account_id(storage.accounts[i].access_token.as_deref())
        });
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
            let account = &mut storage.accounts[i];
            let previous_refresh_token = account.refresh_token.clone();
            let previous_access_token = account.access_token.clone();
            let previous_expires_at = account.expires_at;
            let previous_email = account.email.clone();
            let previous_account_id = account.account_id.clone();
            let previous_account_id_source = account.account_id_source;
            account.refresh_token = success.refresh.clone();
            account.access_token = Some(success.access.clone());
            account.expires_at = Some(success.expires);
            if let Some(email) = &refreshed_email {
                account.email = Some(email.clone());
            }
            if let Some(account_id) = &refreshed_account_id {
                account.account_id = Some(account_id.clone());
                account.account_id_source = Some(AccountIdSource::Token);
            }
            changed = changed
                || previous_refresh_token != account.refresh_token
                || previous_access_token != account.access_token
                || previous_expires_at != account.expires_at
                || previous_email != account.email
                || previous_account_id != account.account_id
                || previous_account_id_source != account.account_id_source;
            if let Some(id_token) = &success.id_token {
                probe_id_token_by_index.insert(i, id_token.clone());
            }
            probe_refreshed_indices.insert(i);

            probe_access_token = account.access_token.clone();
            probe_account_id = account.account_id.clone().or(refreshed_account_id);
        }

        let (Some(probe_access_token), Some(probe_account_id)) =
            (probe_access_token, probe_account_id)
        else {
            probe_errors.push(format!(
                "{}: missing accountId for live probe",
                label_of(&storage, i)
            ));
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
                live_quota_by_index.insert(i, live_quota);
            }
            Err(error) => {
                let message = describe_codex_probe_failure(
                    &error,
                    Some(&|raw: &str| {
                        crate::formatters::text_style::normalize_failure_detail(Some(raw), None)
                    }),
                );
                probe_errors.push(format!("{}: {message}", label_of(&storage, i)));
            }
        }
    }

    let active_index =
        cma_runtime::account_status::resolve_active_index(&storage, ModelFamily::Codex);
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
            quota_cache: None,
            all_accounts: None,
            runtime_overlay: None,
        })
        .collect();
    let forecast_results = evaluate_forecast_accounts(&forecast_inputs);
    let recommendation = recommend_forecast_account(&forecast_results);
    drop(forecast_inputs);

    let Some(best_index) = recommendation.recommended_index else {
        // Persist probe changes (plain saveAccounts — spec 08 gotcha 2).
        if changed
            && let Err(error) = cma_storage::save::save_accounts(&storage).await
        {
            out.error(error.message().to_string());
            return 1;
        }
        if options.json {
            let mut object = Map::new();
            object.insert(
                "error".to_string(),
                Value::String(recommendation.reason.clone()),
            );
            out.info(stringify_pretty2(&with_probe_errors(object, &probe_errors)));
        } else {
            out.info(format!(
                "No best account available: {}",
                recommendation.reason
            ));
            print_probe_notes(&probe_errors, out);
        }
        return 1;
    };

    if best_index >= storage.accounts.len() {
        if changed
            && let Err(error) = cma_storage::save::save_accounts(&storage).await
        {
            out.error(error.message().to_string());
            return 1;
        }
        if options.json {
            out.info(stringify_pretty2(
                &serde_json::json!({ "error": "Best account not found." }),
            ));
        } else {
            out.info("Best account not found.");
        }
        return 1;
    }

    let current_index =
        cma_runtime::account_status::resolve_active_index(&storage, ModelFamily::Codex);
    if current_index == best_index {
        let should_sync_current_best = probe_refreshed_indices.contains(&best_index)
            || probe_id_token_by_index.contains_key(&best_index);
        let mut already_best_synced: Option<bool> = None;
        // lastUsed is stamped only inside the save callback, i.e. only when a
        // probe refresh already dirtied storage (spec 08 gotcha 6).
        if changed {
            storage.accounts[best_index].last_used = now;
            if let Err(error) = cma_storage::save::save_accounts(&storage).await {
                out.error(error.message().to_string());
                return 1;
            }
        }
        let best_account = &storage.accounts[best_index];
        let best_label = label_of(&storage, best_index);
        if should_sync_current_best {
            let synced = cma_cli_mirror::writer::set_codex_cli_active_selection(
                &cma_cli_mirror::writer::ActiveSelection {
                    account_id: best_account.account_id.clone(),
                    email: best_account.email.clone(),
                    access_token: best_account.access_token.clone(),
                    refresh_token: Some(best_account.refresh_token.clone()),
                    expires_at: best_account.expires_at.map(|v| v as f64),
                    id_token: probe_id_token_by_index.get(&best_index).cloned(),
                },
            )
            .await;
            already_best_synced = Some(synced);
            if !synced && !options.json {
                out.warn(
                    "Codex auth sync did not complete. Multi-auth routing will still use this account.",
                );
            }
        }
        if options.json {
            let mut object = Map::new();
            object.insert(
                "message".to_string(),
                Value::String(format!("Already on best account: {best_label}")),
            );
            object.insert(
                "accountIndex".to_string(),
                Value::from(best_index as i64 + 1),
            );
            object.insert(
                "reason".to_string(),
                Value::String(recommendation.reason.clone()),
            );
            if let Some(synced) = already_best_synced {
                object.insert("synced".to_string(), Value::Bool(synced));
            }
            out.info(stringify_pretty2(&with_probe_errors(object, &probe_errors)));
        } else {
            out.info(format!(
                "Already on best account {}: {best_label}",
                best_index + 1
            ));
            out.info(format!("Reason: {}", recommendation.reason));
            print_probe_notes(&probe_errors, out);
        }
        return 0;
    }

    let parsed = best_index as i64 + 1;
    let prior_pin = storage.pinned_account_index;
    let outcome = crate::login::persist_selected::persist_and_sync_selected_account(
        crate::login::persist_selected::PersistSelectedAccountParams {
            storage: storage.clone(),
            target_index: best_index,
            parsed,
            switch_reason: PersistedSwitchReason::Best,
            initial_sync_id_token: probe_id_token_by_index.get(&best_index).cloned(),
            preserve_active_index_by_family: false,
            set_pin: false,
            clear_pin: true,
            bump_affinity_generation: true,
        },
    )
    .await;
    let pin_was_cleared = prior_pin.is_some();
    let best_label = label_of(&storage, best_index);

    if options.json {
        let mut object = Map::new();
        object.insert(
            "message".to_string(),
            Value::String(format!("Switched to best account: {best_label}")),
        );
        object.insert("accountIndex".to_string(), Value::from(parsed));
        object.insert(
            "reason".to_string(),
            Value::String(recommendation.reason.clone()),
        );
        object.insert("synced".to_string(), Value::Bool(outcome.synced));
        object.insert("wasDisabled".to_string(), Value::Bool(outcome.was_disabled));
        if pin_was_cleared {
            object.insert("pinCleared".to_string(), Value::Bool(true));
        }
        out.info(stringify_pretty2(&with_probe_errors(object, &probe_errors)));
    } else {
        out.info(format!(
            "Switched to best account {parsed}: {best_label}{}{}",
            if outcome.was_disabled {
                " (re-enabled)"
            } else {
                ""
            },
            if pin_was_cleared {
                " (manual pin cleared)"
            } else {
                ""
            }
        ));
        out.info(format!("Reason: {}", recommendation.reason));
        print_probe_notes(&probe_errors, out);
        if !outcome.synced {
            out.warn(
                "Codex auth sync did not complete. Multi-auth routing will still use this account.",
            );
        }
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

    // Port of test/codex-manager-best-command.test.ts (non-live surface).

    #[test]
    fn parse_best_args_has_no_help_branch() {
        // The command copy of the parser treats --help as an unknown option;
        // the runner pre-checks help before parsing.
        assert_eq!(
            parse_best_args(&args(&["--help"])),
            Err("Unknown option: --help".to_string())
        );
        let parsed = parse_best_args(&args(&["--live", "-j"])).unwrap();
        assert!(parsed.live);
        assert!(parsed.json);
        assert!(!parsed.model_provided);
        assert_eq!(parsed.model, crate::help::DEFAULT_LIVE_PROBE_MODEL);
    }

    #[tokio::test]
    #[serial(env)]
    async fn help_prints_usage_and_exits_zero() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_best_command(&args(&["--help"]), &mut out).await;
        assert_eq!(code, 0);
        assert!(out.info_text().starts_with("Usage:"));
    }

    #[tokio::test]
    #[serial(env)]
    async fn model_without_live_is_an_error() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_best_command(&args(&["--model", "gpt-5.5"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(
            out.error_text(),
            "--model requires --live for codex-multi-auth best"
        );
        assert!(out.info_text().starts_with("Usage:"));
    }

    #[tokio::test]
    #[serial(env)]
    async fn parse_error_prints_message_then_usage() {
        let _sandbox = EnvSandbox::new();
        let mut out = CliOut::capture();
        let code = run_best_command(&args(&["--bogus"]), &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.error_text(), "Unknown option: --bogus");
        assert!(out.info_text().starts_with("Usage:"));
    }

    #[tokio::test]
    #[serial(env)]
    async fn no_accounts_exits_one_in_both_modes() {
        let _sandbox = EnvSandbox::new();

        let mut out = CliOut::capture();
        let code = run_best_command(&[], &mut out).await;
        assert_eq!(code, 1);
        assert_eq!(out.info_text(), "No accounts configured.");

        let mut out = CliOut::capture();
        let code = run_best_command(&args(&["--json"]), &mut out).await;
        assert_eq!(code, 1);
        let payload: Value = serde_json::from_str(&out.info_text()).unwrap();
        assert_eq!(payload["error"], "No accounts configured.");
    }
}
