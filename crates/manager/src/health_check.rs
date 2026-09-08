//! Port of `lib/codex-manager/health-check.ts` — the `check` command body,
//! reused by the login dashboard's quick check / deep check actions.
//!
//! Behavior source: spec 09 §2. Contracts:
//! - quick path (`!forceRefresh && hasUsableAccessToken`) RE-ENABLES a
//!   disabled account (counts as a change);
//! - refresh FAILURE never disables an account (that's `fix`'s job); a
//!   still-valid session downgrades the failure to a warning row;
//! - quick vs full check have NO re-base asymmetry: both paths save the
//!   whole in-memory storage via `saveAccountsWithRetry` (NOT a
//!   transaction);
//! - quota-cache saves are best-effort (`console.warn`, never fatal);
//! - the active account is mirrored into Codex CLI auth only when it was
//!   refreshed/validated during this run.

use cma_cli_mirror::writer::ActiveSelection;
use cma_config::dashboard_settings::{
    DashboardDisplaySettings, default_dashboard_display_settings,
};
use cma_core::errors::CodexError;
use cma_core::model_family::ModelFamily;
use cma_core::schemas::account_storage::AccountStorageV3;
use cma_core::schemas::token::TokenResult;
use cma_core::token_utils::{extract_account_email, extract_account_id, sanitize_email};
use cma_quota::cache::QuotaCacheData;
use cma_quota::probe::{
    CODEX_UNAVAILABLE_PROBE_NOTE, CodexQuotaSnapshot, ProbeCodexQuotaOptions,
    fetch_codex_quota_snapshot,
};
use cma_quota::readiness::build_quota_email_fallback_state;

use crate::dispatcher::CliOut;
use crate::forecast_report_shared::{
    BoxFuture, LoadAccountsFn, SaveAccountsFn, default_load_accounts, default_save_accounts,
    save_accounts_with_retry_boxed,
};
use crate::formatters::account::style_account_detail_text_with_tone;
use crate::formatters::model::{format_model_inspection, inspect_requested_model};
use crate::formatters::quota::format_quota_snapshot_for_dashboard;
use crate::formatters::text_style::{
    PromptTone, ResultSegment, format_result_summary, normalize_failure_detail, style_prompt_text,
};
use crate::quota_cache_helpers::DEFAULT_LIVE_PROBE_MODEL;
use crate::repair::fix::QuotaProbeRequest;

/// TS `HealthCheckOptions`.
#[derive(Clone, Debug, Default)]
pub struct HealthCheckOptions {
    pub force_refresh: bool,
    pub live_probe: bool,
    pub model: Option<String>,
    pub display: Option<DashboardDisplaySettings>,
}

/// Injectable I/O bundle (the TS module imports these directly; tests mock
/// the modules).
pub struct HealthCheckDeps {
    pub load_accounts: LoadAccountsFn,
    pub save_accounts: SaveAccountsFn,
    pub queued_refresh: Box<dyn Fn(String) -> BoxFuture<TokenResult> + Send + Sync>,
    pub fetch_codex_quota_snapshot: Box<
        dyn Fn(QuotaProbeRequest) -> BoxFuture<Result<CodexQuotaSnapshot, CodexError>>
            + Send
            + Sync,
    >,
    pub load_quota_cache: Box<dyn Fn() -> BoxFuture<QuotaCacheData> + Send + Sync>,
    pub save_quota_cache:
        Box<dyn Fn(QuotaCacheData) -> BoxFuture<Result<(), CodexError>> + Send + Sync>,
    pub set_codex_cli_active_selection:
        Box<dyn Fn(ActiveSelection) -> BoxFuture<bool> + Send + Sync>,
    pub get_now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
}

impl Default for HealthCheckDeps {
    fn default() -> Self {
        HealthCheckDeps {
            load_accounts: default_load_accounts(),
            save_accounts: default_save_accounts(),
            queued_refresh: Box::new(|refresh_token| {
                Box::pin(
                    async move { cma_auth::refresh_queue::queued_refresh(&refresh_token).await },
                )
            }),
            fetch_codex_quota_snapshot: Box::new(|request| {
                Box::pin(async move {
                    fetch_codex_quota_snapshot(&ProbeCodexQuotaOptions {
                        account_id: request.account_id,
                        access_token: request.access_token,
                        model: Some(request.model),
                        ..Default::default()
                    })
                    .await
                })
            }),
            load_quota_cache: Box::new(|| Box::pin(cma_quota::cache::load_quota_cache())),
            save_quota_cache: Box::new(|cache| {
                Box::pin(async move {
                    cma_quota::cache::save_quota_cache(&cache).await;
                    Ok(())
                })
            }),
            set_codex_cli_active_selection: Box::new(|selection| {
                Box::pin(async move {
                    cma_cli_mirror::writer::set_codex_cli_active_selection(&selection).await
                })
            }),
            get_now: None,
        }
    }
}

impl HealthCheckDeps {
    fn now(&self) -> i64 {
        match &self.get_now {
            Some(get_now) => get_now(),
            None => cma_core::utils::now_ms(),
        }
    }
}

/// The `check` command seam (`run_check_command_via` expects
/// `fn(bool) -> Future<()>`); always a live probe.
pub async fn run_health_check(live_probe: bool) {
    let mut out = CliOut::stdio();
    let options = HealthCheckOptions {
        live_probe,
        ..Default::default()
    };
    run_health_check_with_deps(&options, &HealthCheckDeps::default(), &mut out).await;
}

/// TS `runHealthCheck(options)` — options entry, reused by the login
/// dashboard quick/deep check actions (output captured through `out`).
pub async fn run_health_check_with(options: HealthCheckOptions, out: &mut CliOut) {
    run_health_check_with_deps(&options, &HealthCheckDeps::default(), out).await;
}

/// DI core of [`run_health_check_with`].
pub async fn run_health_check_with_deps(
    options: &HealthCheckOptions,
    deps: &HealthCheckDeps,
    out: &mut CliOut,
) {
    let force_refresh = options.force_refresh;
    let live_probe = options.live_probe;
    let probe_model = options
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(DEFAULT_LIVE_PROBE_MODEL);
    let model_inspection = inspect_requested_model(probe_model);
    let display = options
        .display
        .clone()
        .unwrap_or_else(default_dashboard_display_settings);
    let mut working_quota_cache: Option<QuotaCacheData> = if live_probe {
        Some((deps.load_quota_cache)().await)
    } else {
        None
    };
    let mut quota_cache_changed = false;
    cma_storage::facade::set_storage_path(None);
    let mut storage: AccountStorageV3 = match (deps.load_accounts)().await {
        Some(storage) if !storage.accounts.is_empty() => storage,
        _ => {
            out.info("No accounts configured.");
            return;
        }
    };
    let mut quota_email_fallback_state = if live_probe {
        Some(build_quota_email_fallback_state(&storage.accounts))
    } else {
        None
    };

    let mut changed = false;
    let mut ok = 0usize;
    let mut failed = 0usize;
    let mut warnings = 0usize;
    let mut codex_available = 0usize;
    let mut signed_in_only = 0usize;
    let active_index =
        cma_runtime::account_status::resolve_active_index(&storage, ModelFamily::Codex);
    let mut active_account_refreshed = false;
    let now = deps.now();
    out.info(style_prompt_text(
        &if force_refresh {
            format!(
                "Checking {} account(s) with full refresh test...",
                storage.accounts.len()
            )
        } else {
            format!(
                "Checking {} account(s) with quick check{}...",
                storage.accounts.len(),
                if live_probe { " + live check" } else { "" }
            )
        },
        PromptTone::Accent,
    ));
    if live_probe {
        out.info(style_prompt_text(
            &format!("Model probe: {}", format_model_inspection(&model_inspection)),
            PromptTone::Muted,
        ));
    }
    for i in 0..storage.accounts.len() {
        let label = crate::repair::fix::account_label(&storage.accounts[i], i);
        let label_text = style_prompt_text(&label, PromptTone::Accent);
        let session_likely_valid =
            crate::login::account_credentials::has_usable_access_token(&storage.accounts[i], now);
        if !force_refresh && session_likely_valid {
            if storage.accounts[i].enabled == Some(false) {
                storage.accounts[i].enabled = Some(true);
                changed = true;
            }
            if i == active_index {
                active_account_refreshed = true;
            }
            let mut health_detail = "signed in and working".to_string();
            let mut health_tone = PromptTone::Success;
            if live_probe {
                let current_access_token = storage.accounts[i].access_token.clone();
                let probe_account_id = current_access_token.as_ref().and_then(|token| {
                    storage.accounts[i]
                        .account_id
                        .clone()
                        .or_else(|| extract_account_id(Some(token)))
                });
                match (probe_account_id, current_access_token) {
                    (Some(probe_account_id), Some(current_access_token)) => {
                        match (deps.fetch_codex_quota_snapshot)(QuotaProbeRequest {
                            account_id: probe_account_id,
                            access_token: current_access_token,
                            model: model_inspection.normalized.clone(),
                        })
                        .await
                        {
                            Ok(snapshot) => {
                                if let Some(working) = &mut working_quota_cache {
                                    quota_cache_changed =
                                        crate::quota_cache_helpers::update_quota_cache_for_account(
                                            working,
                                            &storage.accounts[i],
                                            &snapshot,
                                            &storage.accounts,
                                            quota_email_fallback_state.as_ref(),
                                        ) || quota_cache_changed;
                                }
                                health_detail = format_quota_snapshot_for_dashboard(
                                    &snapshot,
                                    &display,
                                    cma_core::utils::now_ms(),
                                );
                                codex_available += 1;
                            }
                            Err(error) => {
                                warnings += 1;
                                signed_in_only += 1;
                                health_tone = PromptTone::Warning;
                                if error.is_codex_unavailable() {
                                    health_detail =
                                        format!("signed in; {CODEX_UNAVAILABLE_PROBE_NOTE}");
                                } else {
                                    let message = normalize_failure_detail(
                                        Some(error.message()),
                                        None,
                                    );
                                    health_detail =
                                        format!("signed in (live check failed: {message})");
                                }
                            }
                        }
                    }
                    _ => {
                        warnings += 1;
                        signed_in_only += 1;
                        health_tone = PromptTone::Warning;
                        health_detail =
                            "signed in (live check skipped: missing account ID)".to_string();
                    }
                }
            }
            if crate::login::account_credentials::has_likely_invalid_refresh_token(Some(
                &storage.accounts[i].refresh_token,
            )) {
                health_detail.push_str(" (re-login suggested soon)");
            }
            ok += 1;
            if display.show_per_account_rows {
                let health_marker = if health_tone == PromptTone::Success {
                    "✓"
                } else {
                    "!"
                };
                out.info(format!(
                    "  {} {} {} {}",
                    style_prompt_text(health_marker, health_tone),
                    label_text,
                    style_prompt_text("|", PromptTone::Muted),
                    style_account_detail_text_with_tone(&health_detail, health_tone),
                ));
            }
            continue;
        }
        let result = (deps.queued_refresh)(storage.accounts[i].refresh_token.clone()).await;
        match result {
            TokenResult::Success(success) => {
                let token_account_id = extract_account_id(Some(&success.access));
                let next_email = sanitize_email(
                    extract_account_email(Some(&success.access), success.id_token.as_deref())
                        .as_deref(),
                );
                let previous_email = storage.accounts[i].email.clone();
                let mut account_identity_changed = false;
                {
                    let account = &mut storage.accounts[i];
                    if account.refresh_token != success.refresh {
                        account.refresh_token = success.refresh.clone();
                        changed = true;
                    }
                    if account.access_token.as_deref() != Some(success.access.as_str()) {
                        account.access_token = Some(success.access.clone());
                        changed = true;
                    }
                    if account.expires_at != Some(success.expires) {
                        account.expires_at = Some(success.expires);
                        changed = true;
                    }
                    if let Some(next_email_value) = &next_email
                        && account.email.as_deref() != Some(next_email_value.as_str())
                    {
                        account.email = Some(next_email_value.clone());
                        changed = true;
                        account_identity_changed = true;
                    }
                    if crate::login::account_credentials::apply_token_account_identity(
                        account,
                        token_account_id.as_deref(),
                    ) {
                        changed = true;
                        account_identity_changed = true;
                    }
                    if account.enabled == Some(false) {
                        account.enabled = Some(true);
                        changed = true;
                    }
                }
                if account_identity_changed && live_probe && working_quota_cache.is_some() {
                    let next_state = build_quota_email_fallback_state(&storage.accounts);
                    if let Some(working) = &mut working_quota_cache {
                        quota_cache_changed =
                            crate::quota_cache_helpers::prune_unsafe_quota_email_cache_entry(
                                working,
                                previous_email.as_deref(),
                                &storage.accounts,
                                &next_state,
                            ) || quota_cache_changed;
                    }
                    quota_email_fallback_state = Some(next_state);
                }
                storage.accounts[i].last_used = deps.now();
                if i == active_index {
                    active_account_refreshed = true;
                }
                ok += 1;
                let mut healthy_message = "working now".to_string();
                let mut healthy_tone = PromptTone::Success;
                if live_probe {
                    let probe_account_id = storage.accounts[i]
                        .account_id
                        .clone()
                        .or_else(|| token_account_id.clone());
                    match probe_account_id {
                        Some(probe_account_id) => {
                            match (deps.fetch_codex_quota_snapshot)(QuotaProbeRequest {
                                account_id: probe_account_id,
                                access_token: success.access.clone(),
                                model: model_inspection.normalized.clone(),
                            })
                            .await
                            {
                                Ok(snapshot) => {
                                    if let Some(working) = &mut working_quota_cache {
                                        quota_cache_changed = crate::quota_cache_helpers::update_quota_cache_for_account(
                                            working,
                                            &storage.accounts[i],
                                            &snapshot,
                                            &storage.accounts,
                                            quota_email_fallback_state.as_ref(),
                                        ) || quota_cache_changed;
                                    }
                                    healthy_message = format_quota_snapshot_for_dashboard(
                                        &snapshot,
                                        &display,
                                        cma_core::utils::now_ms(),
                                    );
                                    codex_available += 1;
                                }
                                Err(error) => {
                                    warnings += 1;
                                    signed_in_only += 1;
                                    healthy_tone = PromptTone::Warning;
                                    if error.is_codex_unavailable() {
                                        healthy_message =
                                            format!("signed in; {CODEX_UNAVAILABLE_PROBE_NOTE}");
                                    } else {
                                        let message = normalize_failure_detail(
                                            Some(error.message()),
                                            None,
                                        );
                                        healthy_message =
                                            format!("signed in (live check failed: {message})");
                                    }
                                }
                            }
                        }
                        None => {
                            warnings += 1;
                            signed_in_only += 1;
                            healthy_tone = PromptTone::Warning;
                            healthy_message =
                                "signed in (live check skipped: missing account ID)".to_string();
                        }
                    }
                }
                if display.show_per_account_rows {
                    let healthy_marker = if healthy_tone == PromptTone::Success {
                        "✓"
                    } else {
                        "!"
                    };
                    out.info(format!(
                        "  {} {} {} {}",
                        style_prompt_text(healthy_marker, healthy_tone),
                        label_text,
                        style_prompt_text("|", PromptTone::Muted),
                        style_account_detail_text_with_tone(&healthy_message, healthy_tone),
                    ));
                }
            }
            TokenResult::Failed(failure) => {
                let detail = normalize_failure_detail(
                    failure.message.as_deref(),
                    failure.reason.map(|reason| reason.as_str()),
                );
                if session_likely_valid {
                    warnings += 1;
                    if live_probe {
                        signed_in_only += 1;
                    }
                    if display.show_per_account_rows {
                        out.info(format!(
                            "  {} {} {} {}",
                            style_prompt_text("!", PromptTone::Warning),
                            label_text,
                            style_prompt_text("|", PromptTone::Muted),
                            style_prompt_text(
                                &format!(
                                    "refresh failed ({detail}) but this account still works right now"
                                ),
                                PromptTone::Warning
                            ),
                        ));
                    }
                } else {
                    failed += 1;
                    if display.show_per_account_rows {
                        out.info(format!(
                            "  {} {} {} {}",
                            style_prompt_text("✗", PromptTone::Danger),
                            label_text,
                            style_prompt_text("|", PromptTone::Muted),
                            style_prompt_text(&detail, PromptTone::Danger),
                        ));
                    }
                }
            }
        }
    }

    if !display.show_per_account_rows {
        out.info(style_prompt_text(
            "Per-account lines are hidden in dashboard settings.",
            PromptTone::Muted,
        ));
    }
    if quota_cache_changed
        && let Some(working) = &working_quota_cache
        && let Err(error) = (deps.save_quota_cache)(working.clone()).await
    {
        // Quota cache is a derived artifact; a transient Windows EBUSY/EPERM
        // here must not abort the health check before account fixes commit.
        out.warn(format!("Quota cache save failed: {}", error.message()));
    }

    if changed
        && let Err(error) = save_accounts_with_retry_boxed(&storage, &deps.save_accounts).await
    {
        // TS lets the exhausted-retry rejection propagate; the Rust surface
        // reports it on stderr instead of panicking.
        out.error(error.message().to_string());
        return;
    }

    if active_account_refreshed && active_index < storage.accounts.len() {
        let active_account = &storage.accounts[active_index];
        (deps.set_codex_cli_active_selection)(ActiveSelection {
            account_id: active_account.account_id.clone(),
            email: active_account.email.clone(),
            access_token: active_account.access_token.clone(),
            refresh_token: Some(active_account.refresh_token.clone()),
            expires_at: active_account.expires_at.map(|value| value as f64),
            id_token: None,
        })
        .await;
    }

    out.info("");
    out.info(format_result_summary(&if live_probe {
        vec![
            ResultSegment::new(
                format!("{codex_available} Codex available"),
                if codex_available > 0 {
                    PromptTone::Success
                } else {
                    PromptTone::Muted
                },
            ),
            ResultSegment::new(
                format!("{signed_in_only} signed in only"),
                if signed_in_only > 0 {
                    PromptTone::Warning
                } else {
                    PromptTone::Muted
                },
            ),
            ResultSegment::new(
                format!("{failed} need re-login"),
                if failed > 0 {
                    PromptTone::Danger
                } else {
                    PromptTone::Muted
                },
            ),
        ]
    } else {
        vec![
            ResultSegment::new(format!("{ok} working"), PromptTone::Success),
            ResultSegment::new(
                format!("{failed} need re-login"),
                if failed > 0 {
                    PromptTone::Danger
                } else {
                    PromptTone::Muted
                },
            ),
            ResultSegment::new(
                format!("{warnings} warning{}", if warnings == 1 { "" } else { "s" }),
                if warnings > 0 {
                    PromptTone::Warning
                } else {
                    PromptTone::Muted
                },
            ),
        ]
    }));
}

// ============================================================================
// Tests — ported from test/health-check.test.ts (core paths)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::account_storage::AccountMetadataV3;
    use cma_core::schemas::token::{TokenFailure, TokenSuccess};
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn usable_account(refresh: &str, now: i64) -> AccountMetadataV3 {
        let mut account = AccountMetadataV3::new(refresh, 1, 1);
        account.access_token = Some("access".to_string());
        // Usable = expiresAt - now > 5 minutes.
        account.expires_at = Some(now + 10 * 60 * 1000);
        account
    }

    fn deps_with(
        refresh: impl Fn(String) -> TokenResult + Send + Sync + 'static,
        refresh_calls: Arc<AtomicUsize>,
    ) -> HealthCheckDeps {
        HealthCheckDeps {
            queued_refresh: Box::new(move |token| {
                refresh_calls.fetch_add(1, Ordering::SeqCst);
                let result = refresh(token);
                Box::pin(async move { result })
            }),
            get_now: Some(Box::new(|| 1_000_000)),
            ..HealthCheckDeps::default()
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn no_accounts_prints_message() {
        let _sandbox = EnvSandbox::new();
        let deps = HealthCheckDeps::default();
        let mut out = CliOut::capture();
        run_health_check_with_deps(&HealthCheckOptions::default(), &deps, &mut out).await;
        assert_eq!(out.info_text(), "No accounts configured.");
    }

    // Quick check: a usable token skips the refresh entirely and counts as
    // working.
    #[tokio::test]
    #[serial(env)]
    async fn quick_check_skips_refresh_for_usable_tokens() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        storage.accounts.push(usable_account("rt-a", 1_000_000));
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let refresh_calls = Arc::new(AtomicUsize::new(0));
        let deps = deps_with(
            |_| {
                TokenResult::Failed(TokenFailure {
                    reason: None,
                    status_code: None,
                    message: Some("should not be called".to_string()),
                })
            },
            Arc::clone(&refresh_calls),
        );
        let mut out = CliOut::capture();
        run_health_check_with_deps(&HealthCheckOptions::default(), &deps, &mut out).await;
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 0);
        let text = out.info_text();
        assert!(text.starts_with("Checking 1 account(s) with quick check..."));
        assert!(text.contains("signed in and working"));
        assert!(text.contains("1 working"));
        assert!(text.contains("0 need re-login"));
        assert!(text.contains("0 warnings"));
    }

    // Full refresh failure NEVER disables the account (fix's job) and the
    // singular "warning" form renders for exactly one warning.
    #[tokio::test]
    #[serial(env)]
    async fn full_refresh_failure_does_not_disable_account() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        storage
            .accounts
            .push(AccountMetadataV3::new("rt-expired", 1, 1));
        storage.accounts.push(usable_account("rt-b", 1_000_000));
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let refresh_calls = Arc::new(AtomicUsize::new(0));
        let deps = deps_with(
            |_| {
                TokenResult::Failed(TokenFailure {
                    reason: None,
                    status_code: Some(400),
                    message: Some("invalid_grant".to_string()),
                })
            },
            Arc::clone(&refresh_calls),
        );
        let mut out = CliOut::capture();
        run_health_check_with_deps(
            &HealthCheckOptions {
                force_refresh: true,
                ..Default::default()
            },
            &deps,
            &mut out,
        )
        .await;
        // Both accounts hit the refresh path under forceRefresh.
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 2);
        let text = out.info_text();
        assert!(text.starts_with("Checking 2 account(s) with full refresh test..."));
        // Expired-session failure → danger row; still-valid session → the
        // downgraded warning row.
        assert!(text.contains("but this account still works right now"));
        assert!(text.contains("1 need re-login"));
        assert!(text.contains("1 warning"));
        assert!(!text.contains("1 warnings"));
        // No account was disabled or otherwise persisted.
        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        assert_eq!(saved.accounts[0].enabled, None);
        assert_eq!(saved.accounts[1].enabled, None);
    }

    // Quick path re-enables a disabled-but-usable account and persists.
    #[tokio::test]
    #[serial(env)]
    async fn quick_check_re_enables_working_disabled_accounts() {
        let _sandbox = EnvSandbox::new();
        cma_storage::facade::set_storage_path(None);
        let mut storage = AccountStorageV3::empty();
        let mut disabled = usable_account("rt-a", 1_000_000);
        disabled.enabled = Some(false);
        storage.accounts.push(disabled);
        cma_storage::save::save_accounts(&storage)
            .await
            .expect("seed save");

        let refresh_calls = Arc::new(AtomicUsize::new(0));
        let deps = deps_with(
            |_| {
                TokenResult::Success(TokenSuccess {
                    access: "unused".to_string(),
                    refresh: "unused".to_string(),
                    expires: 1,
                    id_token: None,
                    multi_account: None,
                })
            },
            Arc::clone(&refresh_calls),
        );
        let mut out = CliOut::capture();
        run_health_check_with_deps(&HealthCheckOptions::default(), &deps, &mut out).await;
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 0);
        let saved = cma_storage::load::load_accounts()
            .await
            .expect("reload")
            .storage;
        assert_eq!(saved.accounts[0].enabled, Some(true));
    }
}
