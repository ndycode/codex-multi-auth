//! Port of `lib/codex-manager/repair-commands.ts` — the `verify-flagged`
//! command half.
//!
//! Behavior source: spec 09 §3.3. CRITICAL contracts:
//! - refresh-checks run OUTSIDE the storage lock (phase 1); the apply phase
//!   re-locates every flagged entry inside the transaction and SKIPS any
//!   check whose flagged refresh token drifted on disk since phase 1
//!   (`hasFlaggedRefreshTokenDrift`) with the frozen skip messages;
//! - healthy accounts are restored into active storage by default
//!   (`--no-restore` updates them in place instead);
//! - the pool cap (20) turns a restore into `restore-skipped` and the
//!   flagged entry keeps fresh tokens with `lastError` = the skip message;
//! - always exits 0 after successful arg parsing.

use cma_core::json_io::stringify_pretty2;
use cma_core::schemas::account_storage::{AccountMetadataV3, AccountStorageV3};
use cma_core::schemas::flagged::{FlaggedAccountMetadataV1, FlaggedAccountStorageV1};
use cma_core::schemas::token::{TokenResult, TokenSuccess};
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_storage::matching::{
    AccountMatchOptions, AccountSelectionCandidate, find_matching_account_index,
};
use serde_json::{Map, Value};

use crate::dispatcher::CliOut;
use crate::formatters::account::style_account_detail_text_with_tone;
use crate::formatters::text_style::{
    PromptTone, ResultSegment, format_result_summary, normalize_failure_detail, style_prompt_text,
};
use crate::repair::fix::{
    RepairDeps, codex_error_message, create_empty_account_storage, normalize_doctor_indexes,
};

const MAX_ACCOUNTS: usize = cma_core::constants::ACCOUNT_LIMITS.max_accounts;

// ============================================================================
// Arg parsing
// ============================================================================

#[derive(Clone, Debug, PartialEq, Eq)]
struct VerifyFlaggedCliOptions {
    dry_run: bool,
    json: bool,
    restore: bool,
}

fn print_verify_flagged_usage(out: &mut CliOut) {
    out.info(
        [
            "Usage:",
            "  codex-multi-auth verify-flagged [--dry-run] [--json] [--no-restore]",
            "",
            "Options:",
            "  --dry-run, -n      Preview changes without writing storage",
            "  --json, -j         Print machine-readable JSON output",
            "  --no-restore       Check flagged accounts without restoring healthy ones",
            "",
            "Behavior:",
            "  - Refresh-checks accounts from flagged storage",
            "  - Restores healthy accounts back to active storage by default",
        ]
        .join("\n"),
    );
}

fn parse_verify_flagged_args(args: &[String]) -> Result<VerifyFlaggedCliOptions, String> {
    let mut options = VerifyFlaggedCliOptions {
        dry_run: false,
        json: false,
        restore: true,
    };
    for arg in args {
        match arg.as_str() {
            "--dry-run" | "-n" => options.dry_run = true,
            "--json" | "-j" => options.json = true,
            "--no-restore" => options.restore = false,
            other => return Err(format!("Unknown option: {other}")),
        }
    }
    Ok(options)
}

// ============================================================================
// Report / mutation shapes
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VerifyOutcome {
    Restored,
    HealthyFlagged,
    StillFlagged,
    RestoreSkipped,
}

impl VerifyOutcome {
    fn as_str(self) -> &'static str {
        match self {
            VerifyOutcome::Restored => "restored",
            VerifyOutcome::HealthyFlagged => "healthy-flagged",
            VerifyOutcome::StillFlagged => "still-flagged",
            VerifyOutcome::RestoreSkipped => "restore-skipped",
        }
    }
}

#[derive(Clone, Debug)]
struct VerifyFlaggedReport {
    index: usize,
    label: String,
    outcome: VerifyOutcome,
    message: String,
}

struct RefreshCheck {
    index: usize,
    flagged: FlaggedAccountMetadataV1,
    label: String,
    result: TokenResult,
}

struct FlaggedStorageMutation {
    index: usize,
    label: String,
    before: FlaggedAccountMetadataV1,
    after: Option<FlaggedAccountMetadataV1>,
}

// ============================================================================
// Matching helpers (TS privates)
// ============================================================================

fn find_existing_account_index_for_flagged(
    storage: &AccountStorageV3,
    flagged: &FlaggedAccountMetadataV1,
    next_refresh_token: &str,
    next_account_id: Option<&str>,
    next_email: Option<&str>,
) -> Option<usize> {
    let flagged_email = sanitize_email(flagged.email.as_deref());
    let candidate_account_id = next_account_id
        .map(str::to_string)
        .or_else(|| flagged.account_id.clone());
    let candidate_email = sanitize_email(next_email).or(flagged_email);
    let options = AccountMatchOptions {
        allow_unique_account_id_fallback_without_email: true,
    };
    let next_match_index = find_matching_account_index(
        &storage.accounts,
        &AccountSelectionCandidate {
            account_id: candidate_account_id.clone(),
            email: candidate_email.clone(),
            refresh_token: Some(next_refresh_token.to_string()),
        },
        options,
    );
    if next_match_index.is_some() {
        return next_match_index;
    }

    find_matching_account_index(
        &storage.accounts,
        &AccountSelectionCandidate {
            account_id: candidate_account_id,
            email: candidate_email,
            refresh_token: Some(flagged.refresh_token.clone()),
        },
        options,
    )
}

fn find_matching_flagged_account_index(
    accounts: &[FlaggedAccountMetadataV1],
    target: &FlaggedAccountMetadataV1,
) -> Option<usize> {
    let target_email = sanitize_email(target.email.as_deref());
    accounts.iter().position(|account| {
        if account.refresh_token == target.refresh_token {
            return true;
        }
        if let Some(target_account_id) = &target.account_id
            && account.account_id.as_ref() == Some(target_account_id)
        {
            let Some(target_email) = &target_email else {
                return true;
            };
            return sanitize_email(account.email.as_deref()).as_ref() == Some(target_email);
        }
        target_email.is_some()
            && sanitize_email(account.email.as_deref()) == target_email
    })
}

fn find_flagged_account_index_by_stable_identity(
    accounts: &[FlaggedAccountMetadataV1],
    target: &FlaggedAccountMetadataV1,
) -> Option<usize> {
    let target_email = sanitize_email(target.email.as_deref());
    accounts.iter().position(|account| {
        if let Some(target_account_id) = &target.account_id
            && account.account_id.as_ref() == Some(target_account_id)
        {
            let Some(target_email) = &target_email else {
                return true;
            };
            return sanitize_email(account.email.as_deref()).as_ref() == Some(target_email);
        }
        target_email.is_some()
            && sanitize_email(account.email.as_deref()) == target_email
    })
}

fn has_flagged_refresh_token_drift(
    accounts: &[FlaggedAccountMetadataV1],
    target: &FlaggedAccountMetadataV1,
) -> bool {
    let Some(target_index) = find_flagged_account_index_by_stable_identity(accounts, target)
    else {
        return false;
    };
    accounts
        .get(target_index)
        .is_some_and(|current| current.refresh_token != target.refresh_token)
}

/// `formatAccountLabel(flagged, i)` — flagged entries are structurally
/// V3-compatible in TS; Rust bridges via a local adapter because
/// `AccountLabelSource` is only implemented for pool/managed accounts.
struct FlaggedLabelSource<'a>(&'a FlaggedAccountMetadataV1);

impl cma_accounts::manager_persistence::AccountLabelSource for FlaggedLabelSource<'_> {
    fn label_email(&self) -> Option<&str> {
        self.0.email.as_deref()
    }
    fn label_account_id(&self) -> Option<&str> {
        self.0.account_id.as_deref()
    }
    fn label_account_label(&self) -> Option<&str> {
        self.0.account_label.as_deref()
    }
    fn label_workspaces(&self) -> Option<&[cma_core::schemas::account_storage::Workspace]> {
        self.0.workspaces.as_deref()
    }
    fn label_current_workspace_index(&self) -> Option<i64> {
        self.0.current_workspace_index
    }
}

fn flagged_account_label(flagged: &FlaggedAccountMetadataV1, index: usize) -> String {
    let adapter = FlaggedLabelSource(flagged);
    cma_accounts::manager_persistence::format_account_label(
        Some(&adapter as &dyn cma_accounts::manager_persistence::AccountLabelSource),
        index,
    )
}

fn apply_flagged_storage_mutations(
    flagged_storage: &mut FlaggedAccountStorageV1,
    mutations: &[&FlaggedStorageMutation],
) {
    for mutation in mutations {
        let Some(target_index) =
            find_matching_flagged_account_index(&flagged_storage.accounts, &mutation.before)
        else {
            continue;
        };
        match &mutation.after {
            Some(after) => {
                flagged_storage.accounts[target_index] = after.clone();
            }
            None => {
                flagged_storage.accounts.remove(target_index);
            }
        }
    }
}

// ============================================================================
// Upsert (restore path)
// ============================================================================

struct UpsertResult {
    restored: bool,
    changed: bool,
    message: String,
}

/// TS `upsertRecoveredFlaggedAccount(storage, flagged, refreshResult, now,
/// deps)` — field-by-field update of an existing matching account, or a new
/// pool entry when there is room. NEVER touches other accounts.
fn upsert_recovered_flagged_account(
    storage: &mut AccountStorageV3,
    flagged: &FlaggedAccountMetadataV1,
    refresh_result: &TokenSuccess,
    now: i64,
) -> UpsertResult {
    let next_email = sanitize_email(
        extract_account_email(
            Some(&refresh_result.access),
            refresh_result.id_token.as_deref(),
        )
        .as_deref(),
    )
    .or_else(|| flagged.email.clone());
    let token_account_id = extract_account_id(Some(&refresh_result.access));
    let next_identity = crate::login::account_credentials::resolve_stored_account_identity(
        flagged.account_id.as_deref(),
        flagged.account_id_source,
        token_account_id.as_deref(),
    );
    let existing_index = find_existing_account_index_for_flagged(
        storage,
        flagged,
        &refresh_result.refresh,
        next_identity.account_id.as_deref(),
        next_email.as_deref(),
    );

    if let Some(existing_index) = existing_index {
        let Some(existing) = storage.accounts.get_mut(existing_index) else {
            return UpsertResult {
                restored: false,
                changed: false,
                message: "existing account entry is missing".to_string(),
            };
        };
        let mut changed = false;
        if existing.refresh_token != refresh_result.refresh {
            existing.refresh_token = refresh_result.refresh.clone();
            changed = true;
        }
        if existing.access_token.as_deref() != Some(refresh_result.access.as_str()) {
            existing.access_token = Some(refresh_result.access.clone());
            changed = true;
        }
        if existing.expires_at != Some(refresh_result.expires) {
            existing.expires_at = Some(refresh_result.expires);
            changed = true;
        }
        if let Some(next_email_value) = &next_email
            && existing.email.as_deref() != Some(next_email_value.as_str())
        {
            existing.email = Some(next_email_value.clone());
            changed = true;
        }
        if let Some(next_account_id) = &next_identity.account_id
            && (existing.account_id.as_ref() != Some(next_account_id)
                || existing.account_id_source != next_identity.account_id_source)
        {
            existing.account_id = Some(next_account_id.clone());
            existing.account_id_source = next_identity.account_id_source;
            changed = true;
        }
        if existing.enabled == Some(false) {
            existing.enabled = Some(true);
            changed = true;
        }
        if let Some(flagged_label) = &flagged.account_label
            && existing.account_label.as_ref() != Some(flagged_label)
        {
            existing.account_label = Some(flagged_label.clone());
            changed = true;
        }
        existing.last_used = now;
        return UpsertResult {
            restored: true,
            changed,
            message: format!("restored into existing account {}", existing_index + 1),
        };
    }

    if storage.accounts.len() >= MAX_ACCOUNTS {
        return UpsertResult {
            restored: false,
            changed: false,
            message: format!("cannot restore (max {MAX_ACCOUNTS} accounts reached)"),
        };
    }

    let mut account = AccountMetadataV3::new(refresh_result.refresh.clone(), flagged.added_at, now);
    account.access_token = Some(refresh_result.access.clone());
    account.expires_at = Some(refresh_result.expires);
    account.account_id = next_identity.account_id;
    account.account_id_source = next_identity.account_id_source;
    account.account_label = flagged.account_label.clone();
    account.email = next_email;
    account.enabled = Some(true);
    storage.accounts.push(account);
    UpsertResult {
        restored: true,
        changed: true,
        message: format!("restored as account {}", storage.accounts.len()),
    }
}

// ============================================================================
// runVerifyFlagged
// ============================================================================

/// Apply-phase accumulator (the TS closure-captured locals).
struct ApplyState {
    storage_changed: bool,
    flagged_changed: bool,
    reports: Vec<VerifyFlaggedReport>,
    next_flagged_accounts: Vec<FlaggedAccountMetadataV1>,
    flagged_mutations: Vec<FlaggedStorageMutation>,
}

/// TS closure `applyRefreshChecks(storage, refreshChecks)`.
fn apply_refresh_checks(
    state: &mut ApplyState,
    storage: &mut AccountStorageV3,
    refresh_checks: &[&RefreshCheck],
    restore: bool,
    now: i64,
) {
    for check in refresh_checks {
        let i = check.index;
        let flagged = &check.flagged;
        let label = &check.label;
        match &check.result {
            TokenResult::Success(success) => {
                if !restore {
                    let token_account_id = extract_account_id(Some(&success.access));
                    let next_identity =
                        crate::login::account_credentials::resolve_stored_account_identity(
                            flagged.account_id.as_deref(),
                            flagged.account_id_source,
                            token_account_id.as_deref(),
                        );
                    let mut next_flagged = flagged.clone();
                    next_flagged.refresh_token = success.refresh.clone();
                    next_flagged.access_token = Some(success.access.clone());
                    next_flagged.expires_at = Some(success.expires);
                    next_flagged.account_id = next_identity.account_id;
                    next_flagged.account_id_source = next_identity.account_id_source;
                    next_flagged.email = sanitize_email(
                        extract_account_email(Some(&success.access), success.id_token.as_deref())
                            .as_deref(),
                    )
                    .or_else(|| flagged.email.clone());
                    next_flagged.last_used = now;
                    next_flagged.last_error = None;
                    if next_flagged != *flagged {
                        state.flagged_changed = true;
                    }
                    state.next_flagged_accounts.push(next_flagged.clone());
                    state.flagged_mutations.push(FlaggedStorageMutation {
                        index: i,
                        label: label.clone(),
                        before: flagged.clone(),
                        after: Some(next_flagged),
                    });
                    state.reports.push(VerifyFlaggedReport {
                        index: i,
                        label: label.clone(),
                        outcome: VerifyOutcome::HealthyFlagged,
                        message:
                            "session is healthy (left in flagged list due to --no-restore)"
                                .to_string(),
                    });
                    continue;
                }

                let upsert_result =
                    upsert_recovered_flagged_account(storage, flagged, success, now);
                if upsert_result.restored {
                    state.storage_changed = state.storage_changed || upsert_result.changed;
                    state.flagged_changed = true;
                    state.flagged_mutations.push(FlaggedStorageMutation {
                        index: i,
                        label: label.clone(),
                        before: flagged.clone(),
                        after: None,
                    });
                    state.reports.push(VerifyFlaggedReport {
                        index: i,
                        label: label.clone(),
                        outcome: VerifyOutcome::Restored,
                        message: upsert_result.message,
                    });
                    continue;
                }

                let token_account_id = extract_account_id(Some(&success.access));
                let next_identity =
                    crate::login::account_credentials::resolve_stored_account_identity(
                        flagged.account_id.as_deref(),
                        flagged.account_id_source,
                        token_account_id.as_deref(),
                    );
                let mut updated_flagged = flagged.clone();
                updated_flagged.refresh_token = success.refresh.clone();
                updated_flagged.access_token = Some(success.access.clone());
                updated_flagged.expires_at = Some(success.expires);
                updated_flagged.account_id = next_identity.account_id;
                updated_flagged.account_id_source = next_identity.account_id_source;
                updated_flagged.email = sanitize_email(
                    extract_account_email(Some(&success.access), success.id_token.as_deref())
                        .as_deref(),
                )
                .or_else(|| flagged.email.clone());
                updated_flagged.last_used = now;
                updated_flagged.last_error = Some(upsert_result.message.clone());
                if updated_flagged != *flagged {
                    state.flagged_changed = true;
                }
                state.next_flagged_accounts.push(updated_flagged.clone());
                state.flagged_mutations.push(FlaggedStorageMutation {
                    index: i,
                    label: label.clone(),
                    before: flagged.clone(),
                    after: Some(updated_flagged),
                });
                state.reports.push(VerifyFlaggedReport {
                    index: i,
                    label: label.clone(),
                    outcome: VerifyOutcome::RestoreSkipped,
                    message: upsert_result.message,
                });
            }
            TokenResult::Failed(failure) => {
                let detail = normalize_failure_detail(
                    failure.message.as_deref(),
                    failure.reason.map(|reason| reason.as_str()),
                );
                let mut failed_flagged = flagged.clone();
                failed_flagged.last_error = Some(detail.clone());
                state.next_flagged_accounts.push(failed_flagged.clone());
                if flagged.last_error.as_deref().unwrap_or("") != detail {
                    state.flagged_changed = true;
                }
                state.flagged_mutations.push(FlaggedStorageMutation {
                    index: i,
                    label: label.clone(),
                    before: flagged.clone(),
                    after: Some(failed_flagged),
                });
                state.reports.push(VerifyFlaggedReport {
                    index: i,
                    label: label.clone(),
                    outcome: VerifyOutcome::StillFlagged,
                    message: detail,
                });
            }
        }
    }
}

/// Production entry (dispatcher + `verify --flagged` delegation).
pub async fn run_verify_flagged(args: &[String], out: &mut CliOut) -> i32 {
    run_verify_flagged_with(args, &RepairDeps::default(), out).await
}

/// TS `runVerifyFlagged(args, deps)` — always returns 0 after parse.
pub async fn run_verify_flagged_with(
    args: &[String],
    deps: &RepairDeps,
    out: &mut CliOut,
) -> i32 {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_verify_flagged_usage(out);
        return 0;
    }

    let options = match parse_verify_flagged_args(args) {
        Ok(options) => options,
        Err(message) => {
            out.error(message);
            print_verify_flagged_usage(out);
            return 1;
        }
    };

    cma_storage::facade::set_storage_path(None);
    let flagged_storage = (deps.load_flagged_accounts)().await;
    if flagged_storage.accounts.is_empty() {
        if options.json {
            let mut payload = Map::new();
            payload.insert("command".into(), Value::from("verify-flagged"));
            payload.insert("total".into(), Value::from(0));
            payload.insert("restored".into(), Value::from(0));
            payload.insert("healthyFlagged".into(), Value::from(0));
            payload.insert("stillFlagged".into(), Value::from(0));
            payload.insert("remainingFlagged".into(), Value::from(0));
            payload.insert("changed".into(), Value::from(false));
            payload.insert("dryRun".into(), Value::from(options.dry_run));
            payload.insert("restore".into(), Value::from(options.restore));
            payload.insert("reports".into(), Value::Array(Vec::new()));
            out.info(stringify_pretty2(&Value::Object(payload)));
            return 0;
        }
        out.info("No flagged accounts to check.");
        return 0;
    }

    let mut state = ApplyState {
        storage_changed: false,
        flagged_changed: false,
        reports: Vec::new(),
        next_flagged_accounts: Vec::new(),
        flagged_mutations: Vec::new(),
    };
    let now = deps.now();

    // Phase 1 (network, OUTSIDE the storage lock): refresh-check every
    // flagged account sequentially.
    let mut refresh_checks: Vec<RefreshCheck> = Vec::new();
    for (i, flagged) in flagged_storage.accounts.iter().enumerate() {
        let label = flagged_account_label(flagged, i);
        let result = (deps.queued_refresh)(flagged.refresh_token.clone()).await;
        refresh_checks.push(RefreshCheck {
            index: i,
            flagged: flagged.clone(),
            label,
            result,
        });
    }

    let mut remaining_flagged = 0usize;

    if options.restore {
        if options.dry_run {
            let mut throwaway = (deps.load_accounts)()
                .await
                .unwrap_or_else(create_empty_account_storage);
            let all_checks: Vec<&RefreshCheck> = refresh_checks.iter().collect();
            apply_refresh_checks(&mut state, &mut throwaway, &all_checks, true, now);
        } else {
            let state_ref = &mut state;
            let remaining_ref = &mut remaining_flagged;
            let checks_ref = &refresh_checks;
            let transaction_result =
                cma_storage::transactions::with_account_and_flagged_storage_transaction(
                    move |loaded_storage, persist, loaded_flagged_storage| async move {
                        let mut next_storage =
                            loaded_storage.unwrap_or_else(create_empty_account_storage);
                        let mut next_flagged_storage = loaded_flagged_storage;
                        // Staleness guard: any check whose flagged refresh
                        // token drifted on disk since phase 1 is skipped.
                        let mut safe_refresh_checks: Vec<&RefreshCheck> = Vec::new();
                        let mut stale_refresh_checks: Vec<&RefreshCheck> = Vec::new();
                        for check in checks_ref {
                            if has_flagged_refresh_token_drift(
                                &next_flagged_storage.accounts,
                                &check.flagged,
                            ) {
                                stale_refresh_checks.push(check);
                            } else {
                                safe_refresh_checks.push(check);
                            }
                        }
                        apply_refresh_checks(
                            state_ref,
                            &mut next_storage,
                            &safe_refresh_checks,
                            true,
                            now,
                        );
                        for check in stale_refresh_checks {
                            state_ref.reports.push(VerifyFlaggedReport {
                                index: check.index,
                                label: check.label.clone(),
                                outcome: VerifyOutcome::RestoreSkipped,
                                message:
                                    "Skipped restore because flagged refresh token changed before persistence"
                                        .to_string(),
                            });
                        }
                        let mutation_refs: Vec<&FlaggedStorageMutation> =
                            state_ref.flagged_mutations.iter().collect();
                        apply_flagged_storage_mutations(&mut next_flagged_storage, &mutation_refs);
                        *remaining_ref = next_flagged_storage.accounts.len();
                        if !state_ref.storage_changed && !state_ref.flagged_changed {
                            return Ok(());
                        }
                        if state_ref.storage_changed {
                            normalize_doctor_indexes(&mut next_storage);
                        }
                        persist.persist(&next_storage, &next_flagged_storage).await
                    },
                )
                .await;
            if let Err(error) = transaction_result {
                // TS lets the transaction rejection propagate; the Rust
                // surface reports it and exits 1.
                out.error(codex_error_message(&error));
                return 1;
            }
        }
    } else {
        let mut throwaway = create_empty_account_storage();
        let all_checks: Vec<&RefreshCheck> = refresh_checks.iter().collect();
        apply_refresh_checks(&mut state, &mut throwaway, &all_checks, false, now);
        remaining_flagged = state.next_flagged_accounts.len();
    }

    if options.dry_run {
        remaining_flagged = state.next_flagged_accounts.len();
    }

    if !options.dry_run && !options.restore && state.flagged_changed {
        let state_ref = &mut state;
        let remaining_ref = &mut remaining_flagged;
        let transaction_result = cma_storage::transactions::with_flagged_storage_transaction(
            move |loaded_flagged_storage, persist| async move {
                let mut next_flagged_storage = loaded_flagged_storage;
                let mut stale = vec![false; state_ref.flagged_mutations.len()];
                for (slot, mutation) in state_ref.flagged_mutations.iter().enumerate() {
                    stale[slot] = has_flagged_refresh_token_drift(
                        &next_flagged_storage.accounts,
                        &mutation.before,
                    );
                }
                for (slot, mutation) in state_ref.flagged_mutations.iter().enumerate() {
                    if !stale[slot] {
                        continue;
                    }
                    if let Some(stale_report) = state_ref.reports.iter_mut().find(|report| {
                        report.index == mutation.index && report.label == mutation.label
                    }) {
                        stale_report.outcome = VerifyOutcome::RestoreSkipped;
                        stale_report.message =
                            "Skipped flagged update because refresh token changed before persistence"
                                .to_string();
                        continue;
                    }
                    state_ref.reports.push(VerifyFlaggedReport {
                        index: mutation.index,
                        label: mutation.label.clone(),
                        outcome: VerifyOutcome::RestoreSkipped,
                        message:
                            "Skipped flagged update because refresh token changed before persistence"
                                .to_string(),
                    });
                }
                let safe_flagged_mutations: Vec<&FlaggedStorageMutation> = state_ref
                    .flagged_mutations
                    .iter()
                    .enumerate()
                    .filter(|(slot, _)| !stale[*slot])
                    .map(|(_, mutation)| mutation)
                    .collect();
                apply_flagged_storage_mutations(&mut next_flagged_storage, &safe_flagged_mutations);
                *remaining_ref = next_flagged_storage.accounts.len();
                if safe_flagged_mutations.is_empty() {
                    state_ref.flagged_changed = false;
                    return Ok(());
                }
                persist.persist(&next_flagged_storage).await
            },
        )
        .await;
        if let Err(error) = transaction_result {
            out.error(codex_error_message(&error));
            return 1;
        }
    }

    let restored = state
        .reports
        .iter()
        .filter(|report| report.outcome == VerifyOutcome::Restored)
        .count();
    let healthy_flagged = state
        .reports
        .iter()
        .filter(|report| report.outcome == VerifyOutcome::HealthyFlagged)
        .count();
    let still_flagged = state
        .reports
        .iter()
        .filter(|report| report.outcome == VerifyOutcome::StillFlagged)
        .count();
    let changed = state.storage_changed || state.flagged_changed;

    if options.json {
        let mut payload = Map::new();
        payload.insert("command".into(), Value::from("verify-flagged"));
        payload.insert(
            "total".into(),
            Value::from(flagged_storage.accounts.len() as i64),
        );
        payload.insert("restored".into(), Value::from(restored as i64));
        payload.insert("healthyFlagged".into(), Value::from(healthy_flagged as i64));
        payload.insert("stillFlagged".into(), Value::from(still_flagged as i64));
        payload.insert(
            "remainingFlagged".into(),
            Value::from(remaining_flagged as i64),
        );
        payload.insert("changed".into(), Value::from(changed));
        payload.insert("dryRun".into(), Value::from(options.dry_run));
        payload.insert("restore".into(), Value::from(options.restore));
        payload.insert(
            "reports".into(),
            Value::Array(
                state
                    .reports
                    .iter()
                    .map(|report| {
                        let mut row = Map::new();
                        row.insert("index".into(), Value::from(report.index as i64));
                        row.insert("label".into(), Value::from(report.label.clone()));
                        row.insert("outcome".into(), Value::from(report.outcome.as_str()));
                        row.insert("message".into(), Value::from(report.message.clone()));
                        Value::Object(row)
                    })
                    .collect(),
            ),
        );
        out.info(stringify_pretty2(&Value::Object(payload)));
        return 0;
    }

    out.info(style_prompt_text(
        &format!(
            "Checking {} flagged account(s)...",
            flagged_storage.accounts.len()
        ),
        PromptTone::Accent,
    ));
    for report in &state.reports {
        let tone = match report.outcome {
            VerifyOutcome::Restored => PromptTone::Success,
            VerifyOutcome::HealthyFlagged | VerifyOutcome::RestoreSkipped => PromptTone::Warning,
            VerifyOutcome::StillFlagged => PromptTone::Danger,
        };
        let marker = match report.outcome {
            VerifyOutcome::Restored => "✓",
            VerifyOutcome::HealthyFlagged | VerifyOutcome::RestoreSkipped => "!",
            VerifyOutcome::StillFlagged => "✗",
        };
        out.info(format!(
            "{} {} {} {}",
            style_prompt_text(marker, tone),
            style_prompt_text(
                &format!("{}. {}", report.index + 1, report.label),
                PromptTone::Accent
            ),
            style_prompt_text("|", PromptTone::Muted),
            style_account_detail_text_with_tone(&report.message, tone),
        ));
    }
    out.info("");
    out.info(format_result_summary(&[
        ResultSegment::new(
            format!("{restored} restored"),
            if restored > 0 {
                PromptTone::Success
            } else {
                PromptTone::Muted
            },
        ),
        ResultSegment::new(
            format!("{healthy_flagged} healthy (kept flagged)"),
            if healthy_flagged > 0 {
                PromptTone::Warning
            } else {
                PromptTone::Muted
            },
        ),
        ResultSegment::new(
            format!("{still_flagged} still flagged"),
            if still_flagged > 0 {
                PromptTone::Danger
            } else {
                PromptTone::Muted
            },
        ),
    ]));
    if options.dry_run {
        out.info(style_prompt_text(
            "Preview only: no changes were saved.",
            PromptTone::Warning,
        ));
    } else if !changed {
        out.info(style_prompt_text(
            "No storage changes were needed.",
            PromptTone::Muted,
        ));
    }

    0
}

// ============================================================================
// Tests — ported from test/repair-commands.test.ts and
// test/runtime-verify-flagged.test.ts (verify-flagged halves)
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

    fn flagged(refresh: &str, email: Option<&str>) -> FlaggedAccountMetadataV1 {
        let mut account = AccountMetadataV3::new(refresh, 1, 1);
        account.email = email.map(str::to_string);
        FlaggedAccountMetadataV1::from_account(account, 2, Some("test".to_string()), None)
    }

    fn success(refresh: &str, access: &str) -> TokenResult {
        TokenResult::Success(TokenSuccess {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires: 99_999_999,
            id_token: None,
            multi_account: None,
        })
    }

    fn failure(message: &str) -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason: None,
            status_code: Some(400),
            message: Some(message.to_string()),
        })
    }

    fn deps_with_refresh(
        result: impl Fn(String) -> TokenResult + Send + Sync + 'static,
    ) -> RepairDeps {
        RepairDeps {
            queued_refresh: Box::new(move |token| {
                let result = result(token);
                Box::pin(async move { result })
            }),
            get_now: Some(Box::new(|| 5_000)),
            ..RepairDeps::default()
        }
    }

    async fn seed_flagged(storage: &FlaggedAccountStorageV1) {
        cma_storage::facade::set_storage_path(None);
        cma_storage::flagged::save_flagged_accounts(storage)
            .await
            .expect("seed flagged");
    }

    // Empty flagged storage emits the exact JSON skeleton and exits 0.
    #[tokio::test]
    #[serial(env)]
    async fn empty_flagged_json_skeleton_is_exact() {
        let _sandbox = EnvSandbox::new();
        let deps = RepairDeps::default();
        let mut out = CliOut::capture();
        let code = run_verify_flagged_with(&args(&["--json", "--dry-run"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        let keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "command",
                "total",
                "restored",
                "healthyFlagged",
                "stillFlagged",
                "remainingFlagged",
                "changed",
                "dryRun",
                "restore",
                "reports"
            ]
        );
        assert_eq!(payload["command"], Value::from("verify-flagged"));
        assert_eq!(payload["remainingFlagged"], Value::from(0));
        assert_eq!(payload["dryRun"], Value::from(true));
        assert_eq!(payload["restore"], Value::from(true));
    }

    // Healthy flagged accounts are restored into active storage and removed
    // from the flagged list.
    #[tokio::test]
    #[serial(env)]
    async fn restores_healthy_flagged_account_into_pool() {
        let _sandbox = EnvSandbox::new();
        let mut flagged_storage = FlaggedAccountStorageV1::empty();
        flagged_storage
            .accounts
            .push(flagged("rt-flagged", Some("a@x.com")));
        seed_flagged(&flagged_storage).await;

        let deps = deps_with_refresh(|_| success("rt-new", "access-new"));
        let mut out = CliOut::capture();
        let code = run_verify_flagged_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["restored"], Value::from(1));
        assert_eq!(payload["remainingFlagged"], Value::from(0));
        assert_eq!(payload["changed"], Value::from(true));
        assert_eq!(
            payload["reports"][0]["message"],
            Value::from("restored as account 1")
        );

        let accounts = cma_storage::load::load_accounts()
            .await
            .expect("accounts")
            .storage;
        assert_eq!(accounts.accounts.len(), 1);
        assert_eq!(accounts.accounts[0].refresh_token, "rt-new");
        assert_eq!(accounts.accounts[0].enabled, Some(true));
        let remaining = cma_storage::flagged::load_flagged_accounts().await;
        assert!(remaining.accounts.is_empty());
    }

    // --no-restore keeps the healthy account flagged but refreshes it in
    // place (lastError cleared).
    #[tokio::test]
    #[serial(env)]
    async fn no_restore_updates_flagged_entry_in_place() {
        let _sandbox = EnvSandbox::new();
        let mut flagged_storage = FlaggedAccountStorageV1::empty();
        let mut entry = flagged("rt-flagged", Some("a@x.com"));
        entry.last_error = Some("old error".to_string());
        flagged_storage.accounts.push(entry);
        seed_flagged(&flagged_storage).await;

        let deps = deps_with_refresh(|_| success("rt-new", "access-new"));
        let mut out = CliOut::capture();
        let code =
            run_verify_flagged_with(&args(&["--json", "--no-restore"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["healthyFlagged"], Value::from(1));
        assert_eq!(payload["restored"], Value::from(0));
        assert_eq!(payload["remainingFlagged"], Value::from(1));
        assert_eq!(
            payload["reports"][0]["message"],
            Value::from("session is healthy (left in flagged list due to --no-restore)")
        );

        let remaining = cma_storage::flagged::load_flagged_accounts().await;
        assert_eq!(remaining.accounts.len(), 1);
        assert_eq!(remaining.accounts[0].refresh_token, "rt-new");
        assert_eq!(remaining.accounts[0].last_error, None);
        // No account was restored into the pool.
        assert_eq!(
            cma_storage::load::load_accounts()
                .await
                .map(|loaded| loaded.storage.accounts.len())
                .unwrap_or(0),
            0
        );
    }

    // Failed refreshes stay flagged with lastError = normalized detail.
    #[tokio::test]
    #[serial(env)]
    async fn failed_refresh_records_last_error() {
        let _sandbox = EnvSandbox::new();
        let mut flagged_storage = FlaggedAccountStorageV1::empty();
        flagged_storage
            .accounts
            .push(flagged("rt-flagged", Some("a@x.com")));
        seed_flagged(&flagged_storage).await;

        let deps = deps_with_refresh(|_| failure("invalid_grant"));
        let mut out = CliOut::capture();
        let code = run_verify_flagged_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["stillFlagged"], Value::from(1));
        assert_eq!(payload["remainingFlagged"], Value::from(1));
        let remaining = cma_storage::flagged::load_flagged_accounts().await;
        assert!(remaining.accounts[0].last_error.is_some());
    }

    // Staleness guard: a flagged refresh token that changed on disk between
    // phase 1 and the transaction skips the restore with the frozen message.
    #[tokio::test]
    #[serial(env)]
    async fn skips_stale_restores_when_flagged_token_drifted() {
        let _sandbox = EnvSandbox::new();
        // Disk state has the DRIFTED token.
        let mut disk_flagged = FlaggedAccountStorageV1::empty();
        disk_flagged
            .accounts
            .push(flagged("rt-drifted", Some("a@x.com")));
        seed_flagged(&disk_flagged).await;

        // Phase 1 sees the STALE snapshot via the injected loader.
        let mut stale_flagged = FlaggedAccountStorageV1::empty();
        stale_flagged
            .accounts
            .push(flagged("rt-stale", Some("a@x.com")));
        let deps = RepairDeps {
            load_flagged_accounts: Box::new(move || {
                let storage = stale_flagged.clone();
                Box::pin(async move { storage })
            }),
            queued_refresh: Box::new(|_| {
                Box::pin(async { success("rt-new", "access-new") })
            }),
            get_now: Some(Box::new(|| 5_000)),
            ..RepairDeps::default()
        };
        let mut out = CliOut::capture();
        let code = run_verify_flagged_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["restored"], Value::from(0));
        assert_eq!(
            payload["reports"][0]["outcome"],
            Value::from("restore-skipped")
        );
        assert_eq!(
            payload["reports"][0]["message"],
            Value::from("Skipped restore because flagged refresh token changed before persistence")
        );
        // Disk flagged entry is untouched.
        let remaining = cma_storage::flagged::load_flagged_accounts().await;
        assert_eq!(remaining.accounts[0].refresh_token, "rt-drifted");
        assert_eq!(
            cma_storage::load::load_accounts()
                .await
                .map(|loaded| loaded.storage.accounts.len())
                .unwrap_or(0),
            0
        );
    }

    // Pool cap: with 20 accounts the restore is skipped and the flagged
    // entry keeps fresh tokens with lastError = the skip message.
    #[tokio::test]
    #[serial(env)]
    async fn full_pool_skips_restore_with_frozen_message() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut pool = AccountStorageV3::empty();
        for i in 0..MAX_ACCOUNTS {
            pool.accounts
                .push(AccountMetadataV3::new(format!("rt-{i}"), 1, 1));
        }
        cma_storage::save::save_accounts(&pool).await.expect("seed pool");
        let mut flagged_storage = FlaggedAccountStorageV1::empty();
        flagged_storage
            .accounts
            .push(flagged("rt-flagged", Some("solo@x.com")));
        seed_flagged(&flagged_storage).await;

        let deps = deps_with_refresh(|_| success("rt-new", "access-new"));
        let mut out = CliOut::capture();
        let code = run_verify_flagged_with(&args(&["--json"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["restored"], Value::from(0));
        assert_eq!(
            payload["reports"][0]["outcome"],
            Value::from("restore-skipped")
        );
        assert_eq!(
            payload["reports"][0]["message"],
            Value::from("cannot restore (max 20 accounts reached)")
        );
        let remaining = cma_storage::flagged::load_flagged_accounts().await;
        assert_eq!(remaining.accounts.len(), 1);
        assert_eq!(remaining.accounts[0].refresh_token, "rt-new");
        assert_eq!(
            remaining.accounts[0].last_error.as_deref(),
            Some("cannot restore (max 20 accounts reached)")
        );
        // Pool unchanged (never exceeds the cap).
        let accounts = cma_storage::load::load_accounts()
            .await
            .expect("accounts")
            .storage;
        assert_eq!(accounts.accounts.len(), MAX_ACCOUNTS);
    }

    // Dry-run previews without writing either store.
    #[tokio::test]
    #[serial(env)]
    async fn dry_run_writes_nothing() {
        let _sandbox = EnvSandbox::new();
        let mut flagged_storage = FlaggedAccountStorageV1::empty();
        flagged_storage
            .accounts
            .push(flagged("rt-flagged", Some("a@x.com")));
        seed_flagged(&flagged_storage).await;

        let deps = deps_with_refresh(|_| success("rt-new", "access-new"));
        let mut out = CliOut::capture();
        let code = run_verify_flagged_with(&args(&["--json", "--dry-run"]), &deps, &mut out).await;
        assert_eq!(code, 0);
        let payload: Value = serde_json::from_str(&out.info_text()).expect("json");
        assert_eq!(payload["dryRun"], Value::from(true));
        assert_eq!(payload["restored"], Value::from(1));
        let remaining = cma_storage::flagged::load_flagged_accounts().await;
        assert_eq!(remaining.accounts.len(), 1);
        assert_eq!(remaining.accounts[0].refresh_token, "rt-flagged");
        assert_eq!(
            cma_storage::load::load_accounts()
                .await
                .map(|loaded| loaded.storage.accounts.len())
                .unwrap_or(0),
            0
        );
    }

    #[test]
    fn parse_rejects_unknown_options() {
        assert_eq!(
            parse_verify_flagged_args(&args(&["--bogus"])),
            Err("Unknown option: --bogus".to_string())
        );
        let options =
            parse_verify_flagged_args(&args(&["-n", "-j", "--no-restore"])).unwrap();
        assert!(options.dry_run && options.json && !options.restore);
    }
}
