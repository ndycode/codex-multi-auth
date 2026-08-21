//! Port of `lib/codex-manager/repair-commands.ts` — the `doctor` command
//! half (15 diagnostic checks + safe auto-fixes).
//!
//! Behavior source: spec 09 §3.5. CRITICAL contracts:
//! - identities in check details are ALWAYS masked (`pr***@***.tld`,
//!   `first4***last3`, `***`) — raw emails/account ids never print;
//! - `--fix` applies only SAFE autofixes (index normalization, duplicate
//!   token disable, email/accountId fill from token claims, all-disabled
//!   rescue) — never deletes accounts;
//! - the real write re-runs `applyDoctorFixes` INSIDE the transaction on
//!   fresh disk state and re-locates the refreshed active account by
//!   identity (clone → identity triple → clamped active index fallback);
//! - a refreshed token is synced into Codex auth ONLY if it actually
//!   persisted (`pendingCodexActiveSync && (!doctorRefreshMutation ||
//!   storageFixChanged)`);
//! - exit code is 1 when any check has `error` severity.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use cma_cli_mirror::writer::ActiveSelection;
use cma_core::json_io::stringify_pretty2;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
use cma_core::schemas::token::TokenResult;
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_quota::forecast::{
    ForecastAccountInput, ForecastAvailability, RuntimeForecastOverlay,
    evaluate_forecast_accounts, recommend_forecast_account,
};
use cma_runtime::observability::RuntimeObservabilitySnapshot;
use cma_storage::matching::{
    AccountMatchOptions, AccountSelectionCandidate, find_matching_account_index,
};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::login::account_credentials::{
    apply_token_account_identity, has_likely_invalid_refresh_token, has_usable_access_token,
};
use crate::repair::fix::{
    RepairDeps, codex_error_message, create_empty_account_storage, get_doctor_refresh_token_key,
    has_placeholder_email, normalize_doctor_indexes,
};

// ============================================================================
// Arg parsing
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DoctorCliOptions {
    json: bool,
    fix: bool,
    dry_run: bool,
}

fn print_doctor_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth doctor [--json] [--fix] [--dry-run]",
            "",
            "Options:",
            "  --json, -j         Print machine-readable JSON diagnostics",
            "  --fix              Apply safe auto-fixes to storage",
            "  --dry-run, -n      Preview --fix changes without writing storage",
            "",
            "Behavior:",
            "  - Validates account storage readability",
            "  - Checks active index consistency and account duplication",
            "  - Flags placeholder/demo accounts and disabled-all scenarios",
        ]
        .join("\n"),
    );
}

fn parse_doctor_args(args: &[String]) -> Result<DoctorCliOptions, String> {
    let mut options = DoctorCliOptions {
        json: false,
        fix: false,
        dry_run: false,
    };
    for arg in args {
        match arg.as_str() {
            "--json" | "-j" => options.json = true,
            "--fix" => options.fix = true,
            "--dry-run" | "-n" => options.dry_run = true,
            other => return Err(format!("Unknown option: {other}")),
        }
    }
    if options.dry_run && !options.fix {
        return Err("--dry-run requires --fix".to_string());
    }
    Ok(options)
}

// ============================================================================
// Check / action shapes
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DoctorSeverity {
    Ok,
    Warn,
    Error,
}

impl DoctorSeverity {
    fn as_str(self) -> &'static str {
        match self {
            DoctorSeverity::Ok => "ok",
            DoctorSeverity::Warn => "warn",
            DoctorSeverity::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
struct DoctorCheck {
    key: &'static str,
    severity: DoctorSeverity,
    message: String,
    details: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DoctorFixAction {
    key: &'static str,
    message: String,
}

struct DoctorRefreshMutation {
    match_account: AccountMetadataV3,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    email: Option<String>,
    account_id: Option<String>,
}

// ============================================================================
// Masking helpers (privacy contract — identities in details are ALWAYS
// masked)
// ============================================================================

fn mask_doctor_email(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    let email = value.trim();
    let Some(at_index) = email.find('@') else {
        return Some("***@***".to_string());
    };
    let local = &email[..at_index];
    let domain = &email[at_index + 1..];
    let tld = domain.rsplit('.').next().unwrap_or("");
    let prefix: String = local.chars().take(2).collect();
    Some(format!("{prefix}***@***.{tld}"))
}

fn redact_doctor_identifier(value: Option<&str>) -> Option<String> {
    let value = value?;
    let identifier = value.trim();
    if identifier.is_empty() {
        return None;
    }
    if identifier.contains('@') {
        return mask_doctor_email(Some(identifier));
    }
    let chars: Vec<char> = identifier.chars().collect();
    if chars.len() <= 8 {
        return Some("***".to_string());
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 3..].iter().collect();
    Some(format!("{head}***{tail}"))
}

fn format_doctor_identity_summary(email: Option<&str>, account_id: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(masked_email) = mask_doctor_email(email) {
        parts.push(format!("email={masked_email}"));
    }
    if let Some(masked_account_id) = redact_doctor_identifier(account_id) {
        parts.push(format!("accountId={masked_account_id}"));
    }
    if parts.is_empty() {
        "unknown".to_string()
    } else {
        parts.join(", ")
    }
}

// ============================================================================
// applyDoctorFixes
// ============================================================================

/// TS `applyDoctorFixes(storage, deps)` — safe autofixes ONLY: normalize
/// indexes, disable duplicate-token entries, fill email/accountId from token
/// claims, all-disabled rescue, final re-normalize. Never deletes accounts.
fn apply_doctor_fixes(storage: &mut AccountStorageV3) -> (bool, Vec<DoctorFixAction>) {
    let mut changed = false;
    let mut actions: Vec<DoctorFixAction> = Vec::new();
    let record_active_index_action = |actions: &mut Vec<DoctorFixAction>| {
        if actions.iter().any(|action| action.key == "active-index") {
            return;
        }
        actions.push(DoctorFixAction {
            key: "active-index",
            message: "Normalized active account indexes".to_string(),
        });
    };

    if normalize_doctor_indexes(storage) {
        changed = true;
        record_active_index_action(&mut actions);
    }

    let mut seen_refresh_tokens: HashMap<String, usize> = HashMap::new();
    for i in 0..storage.accounts.len() {
        let refresh_token = get_doctor_refresh_token_key(&storage.accounts[i].refresh_token);
        if let Some(refresh_token) = refresh_token {
            if let Some(existing_token_index) = seen_refresh_tokens.get(&refresh_token).copied() {
                if storage.accounts[i].enabled != Some(false) {
                    storage.accounts[i].enabled = Some(false);
                    changed = true;
                    actions.push(DoctorFixAction {
                        key: "duplicate-refresh-token",
                        message: format!(
                            "Disabled duplicate token entry on account {} (kept account {})",
                            i + 1,
                            existing_token_index + 1
                        ),
                    });
                }
            } else {
                seen_refresh_tokens.insert(refresh_token, i);
            }
        }

        let token_email = sanitize_email(
            extract_account_email(storage.accounts[i].access_token.as_deref(), None).as_deref(),
        );
        if let Some(token_email) = token_email
            && (sanitize_email(storage.accounts[i].email.as_deref()).is_none()
                || has_placeholder_email(storage.accounts[i].email.as_deref()))
        {
            storage.accounts[i].email = Some(token_email);
            changed = true;
            actions.push(DoctorFixAction {
                key: "email-from-token",
                message: format!("Updated account {} email from token claims", i + 1),
            });
        }

        let token_account_id = extract_account_id(storage.accounts[i].access_token.as_deref());
        if storage.accounts[i].account_id.is_none()
            && let Some(token_account_id) = token_account_id
        {
            storage.accounts[i].account_id = Some(token_account_id);
            storage.accounts[i].account_id_source =
                Some(cma_core::schemas::account_storage::AccountIdSource::Token);
            changed = true;
            actions.push(DoctorFixAction {
                key: "account-id-from-token",
                message: format!("Filled missing accountId for account {}", i + 1),
            });
        }
    }

    let enabled_count = storage
        .accounts
        .iter()
        .filter(|account| account.enabled != Some(false))
        .count();
    if !storage.accounts.is_empty() && enabled_count == 0 {
        let index =
            cma_runtime::account_status::resolve_active_index(storage, ModelFamily::Codex);
        let candidate_index = if index < storage.accounts.len() { index } else { 0 };
        if let Some(candidate) = storage.accounts.get_mut(candidate_index) {
            candidate.enabled = Some(true);
            changed = true;
            actions.push(DoctorFixAction {
                key: "enabled-accounts",
                message: format!("Re-enabled account {} to avoid an all-disabled pool", index + 1),
            });
        }
    }

    if normalize_doctor_indexes(storage) {
        changed = true;
        record_active_index_action(&mut actions);
    }

    (changed, actions)
}

/// Persisted runtime-observability snapshot → forecast overlay (crate-shared
/// copy of the forecast command's converter; string skip reasons only —
/// `report` reuses it).
pub(crate) fn snapshot_to_overlay(
    snapshot: &RuntimeObservabilitySnapshot,
) -> RuntimeForecastOverlay {
    let string_map = |map: &serde_json::Map<String, Value>| -> HashMap<String, String> {
        map.iter()
            .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
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

// ============================================================================
// runDoctor
// ============================================================================

/// Production entry (dispatcher wiring).
pub async fn run_doctor(args: &[String], out: &mut CliOut) -> i32 {
    run_doctor_with(args, &RepairDeps::default(), out).await
}

/// TS `runDoctor(args, deps)` — exit 1 when any `error`-severity check.
pub async fn run_doctor_with(args: &[String], deps: &RepairDeps, out: &mut CliOut) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_doctor_usage(out);
        return 0;
    }

    let options = match parse_doctor_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            print_doctor_usage(out);
            return 1;
        }
    };

    cma_storage::facade::set_storage_path(None);
    let storage_path = cma_storage::facade::get_storage_path();
    let storage_file_exists = Path::new(&storage_path).exists();
    let mut checks: Vec<DoctorCheck> = Vec::new();

    checks.push(DoctorCheck {
        key: "storage-file",
        severity: if storage_file_exists {
            DoctorSeverity::Ok
        } else {
            DoctorSeverity::Warn
        },
        message: if storage_file_exists {
            "Account storage file found".to_string()
        } else {
            "Account storage file does not exist yet (first login pending)".to_string()
        },
        details: Some(storage_path.clone()),
    });

    if storage_file_exists {
        match tokio::fs::metadata(&storage_path).await {
            Ok(stat) => {
                checks.push(DoctorCheck {
                    key: "storage-readable",
                    severity: if stat.len() > 0 {
                        DoctorSeverity::Ok
                    } else {
                        DoctorSeverity::Warn
                    },
                    message: if stat.len() > 0 {
                        "Storage file is readable".to_string()
                    } else {
                        "Storage file is empty".to_string()
                    },
                    details: Some(format!("{} bytes", stat.len())),
                });
            }
            Err(error) => {
                checks.push(DoctorCheck {
                    key: "storage-readable",
                    severity: DoctorSeverity::Error,
                    message: "Unable to read storage file metadata".to_string(),
                    details: Some(error.to_string()),
                });
            }
        }
    }

    let codex_auth_path = cma_cli_mirror::state::get_codex_cli_auth_path();
    let codex_config_path = cma_cli_mirror::state::get_codex_cli_config_path();
    let codex_auth_file_exists = codex_auth_path.exists();
    let codex_config_file_exists = codex_config_path.exists();
    let mut codex_auth_email: Option<String> = None;
    let mut codex_auth_account_id: Option<String> = None;

    checks.push(DoctorCheck {
        key: "codex-auth-file",
        severity: if codex_auth_file_exists {
            DoctorSeverity::Ok
        } else {
            DoctorSeverity::Warn
        },
        message: if codex_auth_file_exists {
            "Codex auth file found".to_string()
        } else {
            "Codex auth file does not exist".to_string()
        },
        details: Some(codex_auth_path.to_string_lossy().into_owned()),
    });

    if codex_auth_file_exists {
        match tokio::fs::read_to_string(&codex_auth_path).await {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(parsed) if parsed.is_object() => {
                    let payload = parsed.as_object().expect("object");
                    let tokens = payload.get("tokens").and_then(Value::as_object);
                    let access_token = tokens
                        .and_then(|tokens| tokens.get("access_token"))
                        .and_then(Value::as_str);
                    let id_token = tokens
                        .and_then(|tokens| tokens.get("id_token"))
                        .and_then(Value::as_str);
                    let account_id_from_file = tokens
                        .and_then(|tokens| tokens.get("account_id"))
                        .and_then(Value::as_str);
                    let email_from_file = payload.get("email").and_then(Value::as_str);
                    codex_auth_email = sanitize_email(
                        email_from_file
                            .map(str::to_string)
                            .or_else(|| extract_account_email(access_token, id_token))
                            .as_deref(),
                    );
                    codex_auth_account_id = account_id_from_file
                        .map(str::to_string)
                        .or_else(|| extract_account_id(access_token));
                    checks.push(DoctorCheck {
                        key: "codex-auth-readable",
                        severity: DoctorSeverity::Ok,
                        message: "Codex auth file is readable".to_string(),
                        details: if codex_auth_email.is_some() || codex_auth_account_id.is_some()
                        {
                            Some(format_doctor_identity_summary(
                                codex_auth_email.as_deref(),
                                codex_auth_account_id.as_deref(),
                            ))
                        } else {
                            None
                        },
                    });
                }
                Ok(_) => {
                    checks.push(DoctorCheck {
                        key: "codex-auth-readable",
                        severity: DoctorSeverity::Error,
                        message: "Codex auth file has invalid structure".to_string(),
                        details: Some(codex_auth_path.to_string_lossy().into_owned()),
                    });
                }
                Err(error) => {
                    checks.push(DoctorCheck {
                        key: "codex-auth-readable",
                        severity: DoctorSeverity::Error,
                        message: "Unable to read Codex auth file".to_string(),
                        details: Some(error.to_string()),
                    });
                }
            },
            Err(error) => {
                checks.push(DoctorCheck {
                    key: "codex-auth-readable",
                    severity: DoctorSeverity::Error,
                    message: "Unable to read Codex auth file".to_string(),
                    details: Some(error.to_string()),
                });
            }
        }
    }

    checks.push(DoctorCheck {
        key: "codex-config-file",
        severity: if codex_config_file_exists {
            DoctorSeverity::Ok
        } else {
            DoctorSeverity::Warn
        },
        message: if codex_config_file_exists {
            "Codex config file found".to_string()
        } else {
            "Codex config file does not exist".to_string()
        },
        details: Some(codex_config_path.to_string_lossy().into_owned()),
    });

    let mut codex_auth_store_mode: Option<String> = None;
    if codex_config_file_exists {
        match tokio::fs::read_to_string(&codex_config_path).await {
            Ok(config_raw) => {
                // Hand-rolled `/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"\s*$/m`
                // (first matching line wins).
                for line in config_raw.split('\n') {
                    if let Some(value) = match_auth_store_line(line) {
                        codex_auth_store_mode = Some(value.trim().to_string());
                        break;
                    }
                }
            }
            Err(error) => {
                checks.push(DoctorCheck {
                    key: "codex-auth-store",
                    severity: DoctorSeverity::Warn,
                    message: "Unable to read Codex auth-store config".to_string(),
                    details: Some(error.to_string()),
                });
            }
        }
    }
    if !checks.iter().any(|check| check.key == "codex-auth-store") {
        let is_file_mode = codex_auth_store_mode.as_deref() == Some("file");
        checks.push(DoctorCheck {
            key: "codex-auth-store",
            severity: if is_file_mode {
                DoctorSeverity::Ok
            } else {
                DoctorSeverity::Warn
            },
            message: if is_file_mode {
                "Codex auth storage is set to file".to_string()
            } else {
                "Codex auth storage is not explicitly set to file".to_string()
            },
            details: Some(match &codex_auth_store_mode {
                Some(mode) => format!("mode={mode}"),
                None => "mode=unset".to_string(),
            }),
        });
    }

    let codex_cli_state = (deps.load_codex_cli_state)(true).await;
    checks.push(DoctorCheck {
        key: "codex-cli-state",
        severity: if codex_cli_state.is_some() {
            DoctorSeverity::Ok
        } else {
            DoctorSeverity::Warn
        },
        message: if codex_cli_state.is_some() {
            "Codex CLI state loaded".to_string()
        } else {
            "Codex CLI state unavailable".to_string()
        },
        details: codex_cli_state
            .as_ref()
            .map(|state| state.path.to_string_lossy().into_owned()),
    });

    let loaded_storage = (deps.load_accounts)().await;
    let mut storage_for_checks: Option<AccountStorageV3> = loaded_storage.clone();
    let mut fix_changed = false;
    let mut storage_fix_changed = false;
    let mut structural_fix_actions: Vec<DoctorFixAction> = Vec::new();
    let mut supplemental_fix_actions: Vec<DoctorFixAction> = Vec::new();
    let mut doctor_refresh_mutation: Option<DoctorRefreshMutation> = None;
    let mut pending_codex_active_sync: Option<ActiveSelection> = None;

    if options.fix
        && let Some(storage) = &mut storage_for_checks
        && !storage.accounts.is_empty()
    {
        let (fixed_changed, fixed_actions) = apply_doctor_fixes(storage);
        storage_fix_changed = fixed_changed;
        structural_fix_actions = fixed_actions;
    }

    let has_accounts = storage_for_checks
        .as_ref()
        .is_some_and(|storage| !storage.accounts.is_empty());
    if !has_accounts {
        checks.push(DoctorCheck {
            key: "accounts",
            severity: DoctorSeverity::Warn,
            message: "No accounts configured".to_string(),
            details: None,
        });
    } else {
        let storage_ref = storage_for_checks.as_ref().expect("storage present");
        checks.push(DoctorCheck {
            key: "accounts",
            severity: DoctorSeverity::Ok,
            message: format!("Loaded {} account(s)", storage_ref.accounts.len()),
            details: None,
        });

        let active_index =
            cma_runtime::account_status::resolve_active_index(storage_ref, ModelFamily::Codex);
        let active_exists = active_index < storage_ref.accounts.len();
        checks.push(DoctorCheck {
            key: "active-index",
            severity: if active_exists {
                DoctorSeverity::Ok
            } else {
                DoctorSeverity::Error
            },
            message: if active_exists {
                format!("Active index is valid ({})", active_index + 1)
            } else {
                "Active index is out of range".to_string()
            },
            details: None,
        });

        let disabled_count = storage_ref
            .accounts
            .iter()
            .filter(|account| account.enabled == Some(false))
            .count();
        let all_disabled = disabled_count >= storage_ref.accounts.len();
        checks.push(DoctorCheck {
            key: "enabled-accounts",
            severity: if all_disabled {
                DoctorSeverity::Error
            } else {
                DoctorSeverity::Ok
            },
            message: if all_disabled {
                "All accounts are disabled".to_string()
            } else {
                format!(
                    "{} enabled / {} disabled",
                    storage_ref.accounts.len() - disabled_count,
                    disabled_count
                )
            },
            details: None,
        });

        let mut seen_refresh_tokens: HashSet<String> = HashSet::new();
        let mut duplicate_token_count = 0usize;
        for account in &storage_ref.accounts {
            let Some(token) = get_doctor_refresh_token_key(&account.refresh_token) else {
                continue;
            };
            if !seen_refresh_tokens.insert(token) {
                duplicate_token_count += 1;
            }
        }
        checks.push(DoctorCheck {
            key: "duplicate-refresh-token",
            severity: if duplicate_token_count > 0 {
                DoctorSeverity::Warn
            } else {
                DoctorSeverity::Ok
            },
            message: if duplicate_token_count > 0 {
                format!(
                    "Detected {} duplicate refresh token entr{}",
                    duplicate_token_count,
                    if duplicate_token_count == 1 { "y" } else { "ies" }
                )
            } else {
                "No duplicate refresh tokens detected".to_string()
            },
            details: None,
        });

        let mut seen_emails: HashSet<String> = HashSet::new();
        let mut duplicate_email_count = 0usize;
        let mut placeholder_email_count = 0usize;
        let mut likely_invalid_refresh_token_count = 0usize;
        for account in &storage_ref.accounts {
            if has_likely_invalid_refresh_token(Some(&account.refresh_token)) {
                likely_invalid_refresh_token_count += 1;
            }
            let Some(email) = sanitize_email(account.email.as_deref()) else {
                continue;
            };
            if seen_emails.contains(&email) {
                duplicate_email_count += 1;
            }
            seen_emails.insert(email.clone());
            if has_placeholder_email(Some(&email)) {
                placeholder_email_count += 1;
            }
        }
        checks.push(DoctorCheck {
            key: "duplicate-email",
            severity: if duplicate_email_count > 0 {
                DoctorSeverity::Warn
            } else {
                DoctorSeverity::Ok
            },
            message: if duplicate_email_count > 0 {
                format!(
                    "Detected {} duplicate email entr{}",
                    duplicate_email_count,
                    if duplicate_email_count == 1 { "y" } else { "ies" }
                )
            } else {
                "No duplicate emails detected".to_string()
            },
            details: None,
        });
        checks.push(DoctorCheck {
            key: "placeholder-email",
            severity: if placeholder_email_count > 0 {
                DoctorSeverity::Warn
            } else {
                DoctorSeverity::Ok
            },
            message: if placeholder_email_count > 0 {
                format!("{placeholder_email_count} account(s) appear to be placeholder/demo entries")
            } else {
                "No placeholder emails detected".to_string()
            },
            details: None,
        });
        checks.push(DoctorCheck {
            key: "refresh-token-shape",
            severity: if likely_invalid_refresh_token_count > 0 {
                DoctorSeverity::Warn
            } else {
                DoctorSeverity::Ok
            },
            message: if likely_invalid_refresh_token_count > 0 {
                format!(
                    "{likely_invalid_refresh_token_count} account(s) have likely invalid refresh token format"
                )
            } else {
                "Refresh token format looks normal".to_string()
            },
            details: None,
        });

        let now = deps.now();
        let runtime_snapshot = (deps.load_runtime_observability_snapshot)().await;
        let runtime_overlay = runtime_snapshot.as_ref().map(snapshot_to_overlay);
        let quota_cache = (deps.load_quota_cache)().await;
        let forecast_inputs: Vec<ForecastAccountInput<'_>> = storage_ref
            .accounts
            .iter()
            .enumerate()
            .map(|(index, account)| ForecastAccountInput {
                index,
                account,
                is_current: index == active_index,
                now,
                refresh_failure: None,
                live_quota: None,
                quota_cache: Some(&quota_cache),
                all_accounts: Some(&storage_ref.accounts),
                runtime_overlay: None,
            })
            .collect();
        let forecast_results = evaluate_forecast_accounts(&forecast_inputs);
        let runtime_forecast_inputs: Vec<ForecastAccountInput<'_>> = storage_ref
            .accounts
            .iter()
            .enumerate()
            .map(|(index, account)| ForecastAccountInput {
                index,
                account,
                is_current: index == active_index,
                now,
                refresh_failure: None,
                live_quota: None,
                quota_cache: Some(&quota_cache),
                all_accounts: Some(&storage_ref.accounts),
                runtime_overlay: runtime_overlay.as_ref(),
            })
            .collect();
        let runtime_forecast_results = evaluate_forecast_accounts(&runtime_forecast_inputs);
        drop(forecast_inputs);
        drop(runtime_forecast_inputs);
        let recommendation = recommend_forecast_account(&forecast_results);
        match recommendation.recommended_index {
            Some(recommended_index) if recommended_index != active_index => {
                checks.push(DoctorCheck {
                    key: "recommended-switch",
                    severity: DoctorSeverity::Warn,
                    message: format!(
                        "A healthier account is available: switch to {}",
                        recommended_index + 1
                    ),
                    details: Some(recommendation.reason.clone()),
                });
            }
            _ => {
                checks.push(DoctorCheck {
                    key: "recommended-switch",
                    severity: DoctorSeverity::Ok,
                    message: "Current account aligns with forecast recommendation".to_string(),
                    details: None,
                });
            }
        }

        let divergent: Vec<usize> = forecast_results
            .iter()
            .filter(|result| {
                result.availability == ForecastAvailability::Ready
                    && runtime_forecast_results
                        .get(result.index)
                        .is_some_and(|runtime_result| {
                            runtime_result.availability == ForecastAvailability::Unavailable
                        })
            })
            .map(|result| result.index)
            .collect();
        checks.push(DoctorCheck {
            key: "forecast-runtime-alignment",
            severity: if divergent.is_empty() {
                DoctorSeverity::Ok
            } else {
                DoctorSeverity::Warn
            },
            message: if divergent.is_empty() {
                "Forecast and runtime availability are aligned".to_string()
            } else {
                format!(
                    "{} account(s) look ready on disk but unavailable in runtime state",
                    divergent.len()
                )
            },
            details: if divergent.is_empty() {
                None
            } else {
                Some(
                    divergent
                        .iter()
                        .map(|index| {
                            let reasons = runtime_forecast_results
                                .get(*index)
                                .map(|result| result.reasons.join("; "))
                                .unwrap_or_default();
                            format!(
                                "account {}: {}",
                                index + 1,
                                if reasons.is_empty() {
                                    "runtime unavailable".to_string()
                                } else {
                                    reasons
                                }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" | "),
                )
            },
        });

        if active_exists {
            let manager_active_email = sanitize_email(
                storage_ref.accounts[active_index].email.as_deref(),
            );
            let manager_active_account_id =
                storage_ref.accounts[active_index].account_id.clone();
            let codex_active_email = codex_cli_state
                .as_ref()
                .and_then(|state| sanitize_email(state.active_email.as_deref()))
                .or_else(|| codex_auth_email.clone());
            let codex_active_account_id = codex_cli_state
                .as_ref()
                .and_then(|state| state.active_account_id.clone())
                .or_else(|| codex_auth_account_id.clone());
            let is_email_mismatch = manager_active_email.is_some()
                && codex_active_email.is_some()
                && manager_active_email != codex_active_email;
            let is_account_id_mismatch = manager_active_account_id.is_some()
                && codex_active_account_id.is_some()
                && manager_active_account_id != codex_active_account_id;

            checks.push(DoctorCheck {
                key: "active-selection-sync",
                severity: if is_email_mismatch || is_account_id_mismatch {
                    DoctorSeverity::Warn
                } else {
                    DoctorSeverity::Ok
                },
                message: if is_email_mismatch || is_account_id_mismatch {
                    "Manager active account and Codex active account are not aligned".to_string()
                } else {
                    "Manager active account and Codex active account are aligned".to_string()
                },
                details: Some(format!(
                    "manager={} | codex={}",
                    format_doctor_identity_summary(
                        manager_active_email.as_deref(),
                        manager_active_account_id.as_deref()
                    ),
                    format_doctor_identity_summary(
                        codex_active_email.as_deref(),
                        codex_active_account_id.as_deref()
                    )
                )),
            });

            if options.fix {
                let storage_mut = storage_for_checks.as_mut().expect("storage present");
                let active_account_match = storage_mut.accounts[active_index].clone();
                let mut sync_access_token =
                    storage_mut.accounts[active_index].access_token.clone();
                let mut sync_refresh_token =
                    storage_mut.accounts[active_index].refresh_token.clone();
                let mut sync_expires_at = storage_mut.accounts[active_index].expires_at;
                let mut sync_id_token: Option<String> = None;
                let mut can_sync_active_account =
                    has_usable_access_token(&storage_mut.accounts[active_index], now);

                if !can_sync_active_account {
                    if options.dry_run {
                        supplemental_fix_actions.push(DoctorFixAction {
                            key: "doctor-refresh",
                            message: format!(
                                "Prepared active-account token refresh for account {} (dry-run)",
                                active_index + 1
                            ),
                        });
                    } else {
                        let refresh_result = (deps.queued_refresh)(
                            storage_mut.accounts[active_index].refresh_token.clone(),
                        )
                        .await;
                        match refresh_result {
                            TokenResult::Success(success) => {
                                let refreshed_email = sanitize_email(
                                    extract_account_email(
                                        Some(&success.access),
                                        success.id_token.as_deref(),
                                    )
                                    .as_deref(),
                                );
                                let refreshed_account_id =
                                    extract_account_id(Some(&success.access));
                                let active_account = &mut storage_mut.accounts[active_index];
                                active_account.access_token = Some(success.access.clone());
                                active_account.refresh_token = success.refresh.clone();
                                active_account.expires_at = Some(success.expires);
                                if let Some(refreshed_email_value) = &refreshed_email {
                                    active_account.email = Some(refreshed_email_value.clone());
                                }
                                apply_token_account_identity(
                                    active_account,
                                    refreshed_account_id.as_deref(),
                                );
                                doctor_refresh_mutation = Some(DoctorRefreshMutation {
                                    match_account: active_account_match.clone(),
                                    access_token: success.access.clone(),
                                    refresh_token: success.refresh.clone(),
                                    expires_at: success.expires,
                                    email: refreshed_email,
                                    account_id: refreshed_account_id,
                                });
                                sync_access_token = Some(success.access.clone());
                                sync_refresh_token = success.refresh.clone();
                                sync_expires_at = Some(success.expires);
                                sync_id_token = success.id_token.clone();
                                can_sync_active_account = true;
                                storage_fix_changed = true;
                                fix_changed = true;
                                supplemental_fix_actions.push(DoctorFixAction {
                                    key: "doctor-refresh",
                                    message: format!(
                                        "Refreshed active account tokens for account {}",
                                        active_index + 1
                                    ),
                                });
                            }
                            TokenResult::Failed(failure) => {
                                checks.push(DoctorCheck {
                                    key: "doctor-refresh",
                                    severity: DoctorSeverity::Warn,
                                    message:
                                        "Unable to refresh active account before Codex sync"
                                            .to_string(),
                                    details: Some(
                                        crate::formatters::text_style::normalize_failure_detail(
                                            failure.message.as_deref(),
                                            failure.reason.map(|reason| reason.as_str()),
                                        ),
                                    ),
                                });
                            }
                        }
                    }
                }

                if !options.dry_run && can_sync_active_account {
                    let active_account = &storage_mut.accounts[active_index];
                    pending_codex_active_sync = Some(ActiveSelection {
                        account_id: active_account.account_id.clone(),
                        email: active_account.email.clone(),
                        access_token: sync_access_token,
                        refresh_token: Some(sync_refresh_token),
                        expires_at: sync_expires_at.map(|value| value as f64),
                        id_token: sync_id_token,
                    });
                } else if options.dry_run && can_sync_active_account {
                    supplemental_fix_actions.push(DoctorFixAction {
                        key: "codex-active-sync",
                        message: "Prepared Codex active-account sync (dry-run)".to_string(),
                    });
                }
            }
        }
    }

    if options.fix && has_accounts && storage_fix_changed && !options.dry_run {
        let structural_ref = &mut structural_fix_actions;
        let storage_fix_changed_ref = &mut storage_fix_changed;
        let refresh_mutation_ref = &doctor_refresh_mutation;
        let transaction_result = cma_storage::transactions::with_account_storage_transaction(
            move |loaded_storage, persist| async move {
                let mut next_storage =
                    loaded_storage.unwrap_or_else(create_empty_account_storage);
                let (transaction_fixed_changed, transaction_fixed_actions) =
                    apply_doctor_fixes(&mut next_storage);
                *structural_ref = transaction_fixed_actions;
                let mut transaction_changed = transaction_fixed_changed;
                if let Some(mutation) = refresh_mutation_ref {
                    let fallback_active_index = cma_runtime::account_status::resolve_active_index(
                        &next_storage,
                        ModelFamily::Codex,
                    );
                    let fallback_target_index =
                        if fallback_active_index < next_storage.accounts.len() {
                            Some(fallback_active_index)
                        } else {
                            None
                        };
                    let options = AccountMatchOptions {
                        allow_unique_account_id_fallback_without_email: true,
                    };
                    let target_index = find_matching_account_index(
                        &next_storage.accounts,
                        &mutation.match_account,
                        options,
                    )
                    .or_else(|| {
                        find_matching_account_index(
                            &next_storage.accounts,
                            &AccountSelectionCandidate {
                                account_id: mutation.account_id.clone(),
                                email: mutation.email.clone(),
                                refresh_token: Some(mutation.refresh_token.clone()),
                            },
                            options,
                        )
                    })
                    .or(fallback_target_index);
                    if let Some(target_index) = target_index
                        && let Some(target) = next_storage.accounts.get_mut(target_index)
                    {
                        if target.access_token.as_deref() != Some(mutation.access_token.as_str())
                        {
                            target.access_token = Some(mutation.access_token.clone());
                            transaction_changed = true;
                        }
                        if target.refresh_token != mutation.refresh_token {
                            target.refresh_token = mutation.refresh_token.clone();
                            transaction_changed = true;
                        }
                        if target.expires_at != Some(mutation.expires_at) {
                            target.expires_at = Some(mutation.expires_at);
                            transaction_changed = true;
                        }
                        if let Some(email) = &mutation.email
                            && target.email.as_ref() != Some(email)
                        {
                            target.email = Some(email.clone());
                            transaction_changed = true;
                        }
                        if apply_token_account_identity(target, mutation.account_id.as_deref()) {
                            transaction_changed = true;
                        }
                    }
                }
                if normalize_doctor_indexes(&mut next_storage) {
                    transaction_changed = true;
                }
                if !transaction_changed {
                    structural_ref.clear();
                    *storage_fix_changed_ref = false;
                    return Ok(());
                }
                *storage_fix_changed_ref = true;
                persist.persist(&next_storage).await
            },
        )
        .await;
        if let Err(error) = transaction_result {
            // TS lets the transaction rejection propagate; the Rust surface
            // reports it and exits 1.
            out.error(codex_error_message(&error));
            return 1;
        }
    }

    // A refreshed token is only synced into Codex auth if it actually
    // persisted.
    if let Some(pending_sync) = pending_codex_active_sync
        && (doctor_refresh_mutation.is_none() || storage_fix_changed)
    {
        let synced = (deps.set_codex_cli_active_selection)(pending_sync).await;
        if synced {
            supplemental_fix_actions.push(DoctorFixAction {
                key: "codex-active-sync",
                message: "Synced manager active account into Codex auth state".to_string(),
            });
        } else {
            checks.push(DoctorCheck {
                key: "codex-active-sync",
                severity: DoctorSeverity::Warn,
                message: "Failed to sync manager active account into Codex auth state"
                    .to_string(),
                details: None,
            });
        }
    }

    let fix_actions: Vec<DoctorFixAction> = structural_fix_actions
        .iter()
        .chain(supplemental_fix_actions.iter())
        .cloned()
        .collect();

    if options.fix && has_accounts {
        fix_changed = storage_fix_changed || !fix_actions.is_empty();
        checks.push(DoctorCheck {
            key: "auto-fix",
            severity: if fix_changed {
                DoctorSeverity::Warn
            } else {
                DoctorSeverity::Ok
            },
            message: if fix_changed {
                if options.dry_run {
                    format!("Prepared {} fix(es) (dry-run)", fix_actions.len())
                } else {
                    format!("Applied {} fix(es)", fix_actions.len())
                }
            } else {
                "No safe auto-fixes needed".to_string()
            },
            details: None,
        });
    }

    let mut summary_ok = 0usize;
    let mut summary_warn = 0usize;
    let mut summary_error = 0usize;
    for check in &checks {
        match check.severity {
            DoctorSeverity::Ok => summary_ok += 1,
            DoctorSeverity::Warn => summary_warn += 1,
            DoctorSeverity::Error => summary_error += 1,
        }
    }

    if options.json {
        let mut payload = Map::new();
        payload.insert("command".into(), Value::from("doctor"));
        payload.insert("storagePath".into(), Value::from(storage_path.clone()));
        let mut summary = Map::new();
        summary.insert("ok".into(), Value::from(summary_ok as i64));
        summary.insert("warn".into(), Value::from(summary_warn as i64));
        summary.insert("error".into(), Value::from(summary_error as i64));
        payload.insert("summary".into(), Value::Object(summary));
        payload.insert(
            "checks".into(),
            Value::Array(
                checks
                    .iter()
                    .map(|check| {
                        let mut row = Map::new();
                        row.insert("key".into(), Value::from(check.key));
                        row.insert("severity".into(), Value::from(check.severity.as_str()));
                        row.insert("message".into(), Value::from(check.message.clone()));
                        if let Some(details) = &check.details {
                            row.insert("details".into(), Value::from(details.clone()));
                        }
                        Value::Object(row)
                    })
                    .collect(),
            ),
        );
        let mut fix = Map::new();
        fix.insert("enabled".into(), Value::from(options.fix));
        fix.insert("dryRun".into(), Value::from(options.dry_run));
        fix.insert("changed".into(), Value::from(fix_changed));
        fix.insert(
            "actions".into(),
            Value::Array(
                fix_actions
                    .iter()
                    .map(|action| {
                        let mut row = Map::new();
                        row.insert("key".into(), Value::from(action.key));
                        row.insert("message".into(), Value::from(action.message.clone()));
                        Value::Object(row)
                    })
                    .collect(),
            ),
        );
        payload.insert("fix".into(), Value::Object(fix));
        out.info(stringify_pretty2(&Value::Object(payload)));
        return if summary_error > 0 { 1 } else { 0 };
    }

    out.info("Doctor diagnostics");
    out.info(format!("Storage: {storage_path}"));
    out.info(format!(
        "Summary: {summary_ok} ok, {summary_warn} warnings, {summary_error} errors"
    ));
    out.info("");
    for check in &checks {
        let marker = match check.severity {
            DoctorSeverity::Ok => "✓",
            DoctorSeverity::Warn => "!",
            DoctorSeverity::Error => "✗",
        };
        out.info(format!("{marker} {}: {}", check.key, check.message));
        if let Some(details) = &check.details {
            out.info(format!("  {details}"));
        }
    }
    if options.fix {
        out.info("");
        if !fix_actions.is_empty() {
            out.info(format!(
                "Auto-fix actions ({}):",
                if options.dry_run { "dry-run" } else { "applied" }
            ));
            for action in &fix_actions {
                out.info(format!("  - {}", action.message));
            }
        } else {
            out.info("Auto-fix actions: none");
        }
    }

    if summary_error > 0 { 1 } else { 0 }
}

/// Hand-rolled `/^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"\s*$/m` line
/// matcher (the `regex` crate is not a cma-manager dependency).
fn match_auth_store_line(line: &str) -> Option<&str> {
    let rest = line.trim_start();
    let rest = rest.strip_prefix("cli_auth_credentials_store")?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    if end == 0 {
        // `([^"]+)` requires at least one character.
        return None;
    }
    let value = &rest[..end];
    let trailing = &rest[end + 1..];
    if !trailing.chars().all(char::is_whitespace) {
        return None;
    }
    Some(value)
}

// ============================================================================
// Tests — ported from test/repair-commands.test.ts (doctor half)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::TokenFailure;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn account(refresh: &str, email: Option<&str>) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh, 1, 1);
        account.email = email.map(str::to_string);
        account
    }

    fn base64url(data: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut encoded = String::new();
        for chunk in data.chunks(3) {
            let bytes = [
                chunk[0],
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
            encoded.push(ALPHABET[(n >> 18) as usize & 63] as char);
            encoded.push(ALPHABET[(n >> 12) as usize & 63] as char);
            if chunk.len() > 1 {
                encoded.push(ALPHABET[(n >> 6) as usize & 63] as char);
            }
            if chunk.len() > 2 {
                encoded.push(ALPHABET[n as usize & 63] as char);
            }
        }
        encoded
    }

    /// Unsigned JWT whose payload carries the OpenAI email + accountId
    /// claims (`decode_jwt` never verifies signatures).
    fn claims_jwt(email: &str, account_id: &str) -> String {
        let header = serde_json::json!({ "alg": "none" });
        let payload = serde_json::json!({
            "email": email,
            cma_core::constants::JWT_CLAIM_PATH: {
                "chatgpt_account_id": account_id,
                "email": email,
            },
        });
        format!(
            "{}.{}.sig",
            base64url(header.to_string().as_bytes()),
            base64url(payload.to_string().as_bytes())
        )
    }

    fn quiet_deps() -> RepairDeps {
        RepairDeps {
            queued_refresh: Box::new(|_| {
                Box::pin(async {
                    TokenResult::Failed(TokenFailure {
                        reason: None,
                        status_code: Some(401),
                        message: Some("nope".to_string()),
                    })
                })
            }),
            load_codex_cli_state: Box::new(|_| Box::pin(async { None })),
            set_codex_cli_active_selection: Box::new(|_| Box::pin(async { false })),
            load_runtime_observability_snapshot: Box::new(|| Box::pin(async { None })),
            get_now: Some(Box::new(|| 1_000)),
            ..RepairDeps::default()
        }
    }

    fn find_check<'a>(payload: &'a Value, key: &str) -> &'a Value {
        payload["checks"]
            .as_array()
            .expect("checks array")
            .iter()
            .find(|check| check["key"] == key)
            .unwrap_or_else(|| panic!("missing check {key}"))
    }

    #[test]
    fn doctor_masking_helpers_never_leak_identities() {
        assert_eq!(
            mask_doctor_email(Some("primary@example.com")).as_deref(),
            Some("pr***@***.com")
        );
        assert_eq!(mask_doctor_email(Some("no-at-sign")).as_deref(), Some("***@***"));
        assert_eq!(mask_doctor_email(None), None);
        assert_eq!(redact_doctor_identifier(Some("short")), Some("***".to_string()));
        assert_eq!(
            redact_doctor_identifier(Some("acct_1234567890")).as_deref(),
            Some("acct***890")
        );
        assert_eq!(
            redact_doctor_identifier(Some("user@site.org")).as_deref(),
            Some("us***@***.org")
        );
        assert_eq!(redact_doctor_identifier(Some("   ")), None);
        assert_eq!(
            format_doctor_identity_summary(None, None),
            "unknown".to_string()
        );
    }

    #[test]
    fn auth_store_line_matcher_mirrors_the_regex() {
        assert_eq!(
            match_auth_store_line("cli_auth_credentials_store = \"file\""),
            Some("file")
        );
        assert_eq!(
            match_auth_store_line("  cli_auth_credentials_store=\"keyring\"  "),
            Some("keyring")
        );
        assert_eq!(
            match_auth_store_line("cli_auth_credentials_store = \"file\"\r"),
            Some("file")
        );
        assert_eq!(match_auth_store_line("cli_auth_credentials_store = \"\""), None);
        assert_eq!(
            match_auth_store_line("# cli_auth_credentials_store = \"file\""),
            None
        );
        assert_eq!(
            match_auth_store_line("cli_auth_credentials_store = \"file\" # trailing"),
            None
        );
    }

    #[test]
    fn dry_run_requires_fix() {
        assert_eq!(
            parse_doctor_args(&args(&["--dry-run"])),
            Err("--dry-run requires --fix".to_string())
        );
        let options = parse_doctor_args(&args(&["--fix", "-n", "-j"])).unwrap();
        assert!(options.fix && options.dry_run && options.json);
    }

    // First-run machine: storage missing → warn, exit 0; JSON shape stable.
    #[tokio::test]
    #[serial(env)]
    async fn doctor_json_warns_on_missing_storage_and_exits_zero() {
        let _sandbox = EnvSandbox::new();
        let deps = quiet_deps();
        let mut out = CliOut::capture();
        let code = run_doctor_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["command"], Value::from("doctor"));
        let keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["command", "storagePath", "summary", "checks", "fix"]);
        assert_eq!(find_check(&payload, "storage-file")["severity"], Value::from("warn"));
        assert_eq!(find_check(&payload, "accounts")["severity"], Value::from("warn"));
        assert_eq!(payload["fix"]["enabled"], Value::from(false));
        assert_eq!(payload["fix"]["changed"], Value::from(false));
    }

    // All-disabled pool is an error severity → exit 1.
    #[tokio::test]
    #[serial(env)]
    async fn doctor_all_disabled_pool_is_error_and_exits_one() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        let mut disabled = account("rt-a", Some("a@x.com"));
        disabled.enabled = Some(false);
        storage.accounts.push(disabled);
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let deps = quiet_deps();
        let mut out = CliOut::capture();
        let code = run_doctor_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 1);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        let check = find_check(&payload, "enabled-accounts");
        assert_eq!(check["severity"], Value::from("error"));
        assert_eq!(check["message"], Value::from("All accounts are disabled"));
        assert!(payload["summary"]["error"].as_i64().unwrap() > 0);
    }

    // runDoctor uses the refresh-token validator + duplicate detection in
    // JSON diagnostics, with masked identities only.
    #[tokio::test]
    #[serial(env)]
    async fn doctor_warns_on_duplicates_and_placeholder_emails_without_leaking() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        storage
            .accounts
            .push(account("duplicate-token-value-1234", Some("demo@example.com")));
        storage
            .accounts
            .push(account("duplicate-token-value-1234", Some("demo@example.com")));
        // Injected loader: the storage crate's load-normalize dedupes
        // same-token rows on disk, but doctor must still diagnose whatever
        // the loader hands it.
        let mut deps = quiet_deps();
        deps.load_accounts = Box::new(move || {
            let storage = storage.clone();
            Box::pin(async move { Some(storage) })
        });
        let mut out = CliOut::capture();
        let code = run_doctor_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let text = out.info_text();
        let payload: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(
            find_check(&payload, "duplicate-refresh-token")["message"],
            Value::from("Detected 1 duplicate refresh token entry")
        );
        assert_eq!(
            find_check(&payload, "duplicate-email")["message"],
            Value::from("Detected 1 duplicate email entry")
        );
        assert_eq!(
            find_check(&payload, "placeholder-email")["severity"],
            Value::from("warn")
        );
        // Raw identities never appear anywhere in the output.
        assert!(!text.contains("demo@example.com"));
        assert!(!text.contains("duplicate-token-value-1234"));
    }

    // --fix fills missing email/accountId from token claims and records the
    // frozen action messages; the write persists via the transaction
    // (re-applied on fresh disk state).
    #[tokio::test]
    #[serial(env)]
    async fn doctor_fix_fills_identity_from_token_claims_and_persists() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        let mut bare = account("rt-a", None);
        bare.access_token = Some(claims_jwt("tok@x.com", "acct_1234567890"));
        storage.accounts.push(bare);
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let deps = quiet_deps();
        let mut out = CliOut::capture();
        let code = run_doctor_with(&args(&["--json", "--fix"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["fix"]["enabled"], Value::from(true));
        assert_eq!(payload["fix"]["changed"], Value::from(true));
        let actions: Vec<&str> = payload["fix"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|action| action["message"].as_str().unwrap())
            .collect();
        assert!(actions.contains(&"Updated account 1 email from token claims"));
        assert!(actions.contains(&"Filled missing accountId for account 1"));

        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        assert_eq!(saved.accounts.len(), 1);
        assert_eq!(saved.accounts[0].email.as_deref(), Some("tok@x.com"));
        assert_eq!(
            saved.accounts[0].account_id.as_deref(),
            Some("acct_1234567890")
        );
        // The raw identities never leak into the diagnostics output.
        assert!(!out.info_text().contains("tok@x.com"));
    }

    // --fix --dry-run prepares actions without writing.
    #[tokio::test]
    #[serial(env)]
    async fn doctor_fix_dry_run_prepares_without_writing() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        let mut bare = account("rt-a", None);
        bare.access_token = Some(claims_jwt("tok@x.com", "acct_1234567890"));
        storage.accounts.push(bare);
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let deps = quiet_deps();
        let mut out = CliOut::capture();
        let code = run_doctor_with(&args(&["--json", "--fix", "--dry-run"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["fix"]["dryRun"], Value::from(true));
        assert_eq!(payload["fix"]["changed"], Value::from(true));
        let auto_fix = find_check(&payload, "auto-fix");
        assert!(
            auto_fix["message"]
                .as_str()
                .unwrap()
                .ends_with("(dry-run)")
        );
        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        assert_eq!(saved.accounts[0].email, None);
        assert_eq!(saved.accounts[0].account_id, None);
    }

    // Failed runtime snapshot loads are treated as aligned diagnostics.
    #[tokio::test]
    #[serial(env)]
    async fn doctor_treats_missing_runtime_snapshot_as_aligned() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(account("rt-a", Some("a@x.com")));
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let deps = quiet_deps();
        let mut out = CliOut::capture();
        let code = run_doctor_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        let check = find_check(&payload, "forecast-runtime-alignment");
        assert_eq!(check["severity"], Value::from("ok"));
        assert_eq!(
            check["message"],
            Value::from("Forecast and runtime availability are aligned")
        );
    }

    // Text mode prints markers, details indentation, and the auto-fix block.
    #[tokio::test]
    #[serial(env)]
    async fn doctor_text_mode_prints_summary_and_checks() {
        let _sandbox = EnvSandbox::new();
        let deps = quiet_deps();
        let mut out = CliOut::capture();
        let code = run_doctor_with(&[], &deps, &mut out).await;
        assert_eq!(code, 0);
        let text = out.info_text();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines[0], "Doctor diagnostics");
        assert!(lines[1].starts_with("Storage: "));
        assert!(lines[2].starts_with("Summary: "));
        assert!(text.contains("! storage-file: Account storage file does not exist yet (first login pending)"));
        // No --fix → no auto-fix block.
        assert!(!text.contains("Auto-fix actions"));
    }
}
