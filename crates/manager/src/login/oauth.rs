//! Port of `lib/codex-manager/login-oauth.ts` — OAuth/device sign-in
//! plumbing for the login flow: browser/manual OAuth, manual callback
//! prompting, account-selection resolution, pool persistence, and the Codex
//! CLI mirror sync.

use std::io::{BufRead, IsTerminal, Write};

use cma_auth::callback_guidance::{
    describe_callback_failure, CallbackFailureContext, CallbackFailureReason,
};
use cma_auth::oauth::{
    create_authorization_flow, exchange_authorization_code, redact_oauth_url_for_log,
    AuthorizationFlowOptions, REDIRECT_URI,
};
use cma_cli_mirror::writer::{set_codex_cli_active_selection, ActiveSelection};
use cma_core::schemas::account_storage::{AccountIdSource, AccountStorageV3, Workspace};
use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenResult, TokenSuccess};
use cma_core::token_utils::{
    extract_account_email, extract_account_id, get_account_id_candidates,
    resolve_request_account_id, sanitize_email, select_best_account_candidate,
};
use cma_core::utils::now_ms;
use cma_storage::matching::{find_matching_account_index, AccountMatchOptions};
use cma_storage::transactions::with_account_storage_transaction;
use cma_tui::format::{paint_ui_text, UiTextTone};
use cma_tui::runtime_options::get_ui_runtime_options;
use cma_tui::ui_copy;

use crate::login::account_pool_write::{
    apply_account_pool_results, AccountPoolWriteOutcome, PoolWriteIdentity, ResolvedAccountWrite,
};
use crate::login::manual_callback::{classify_manual_callback_input, ManualCallbackClassification};

/// `TokenSuccessWithAccount` — a successful token exchange enriched with the
/// resolved account binding.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenSuccessWithAccount {
    pub tokens: TokenSuccess,
    pub account_id_override: Option<String>,
    pub account_id_source: Option<AccountIdSource>,
    pub account_label: Option<String>,
    pub workspaces: Option<Vec<Workspace>>,
}

impl TokenSuccessWithAccount {
    pub fn plain(tokens: TokenSuccess) -> Self {
        TokenSuccessWithAccount {
            tokens,
            account_id_override: None,
            account_id_source: None,
            account_label: None,
            workspaces: None,
        }
    }
}

/// `OAuthSignInMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OAuthSignInMode {
    Browser,
    Manual,
    Device,
    RestoreBackup,
    Cancel,
}

/// `isOAuthCancellation(result)` — `(message ?? reason ?? "")` trimmed,
/// lowercased, contains `"cancelled"` OR `"canceled"`.
pub fn is_oauth_cancellation(result: &TokenResult) -> bool {
    let TokenResult::Failed(failure) = result else {
        return false;
    };
    let text = failure
        .message
        .clone()
        .or_else(|| failure.reason.map(|reason| reason.as_str().to_string()))
        .unwrap_or_default();
    let normalized = text.trim().to_lowercase();
    normalized.contains("cancelled") || normalized.contains("canceled")
}

/// `resolveAccountSelection(tokens, orgOverride?)` — builds the `workspaces`
/// array from ALL candidates BEFORE the org branch so `--org` logins persist
/// workspaces too (#512, spec 09 gotcha 15).
pub fn resolve_account_selection(
    tokens: &TokenSuccess,
    org_override: Option<&str>,
) -> TokenSuccessWithAccount {
    let candidates =
        get_account_id_candidates(Some(&tokens.access), tokens.id_token.as_deref());
    let workspaces: Option<Vec<Workspace>> = if candidates.is_empty() {
        None
    } else {
        Some(
            candidates
                .iter()
                .map(|candidate| Workspace {
                    id: candidate.account_id.clone(),
                    name: Some(candidate.label.clone()),
                    enabled: true,
                    disabled_at: None,
                    is_default: candidate.is_default,
                })
                .collect(),
        )
    };

    let override_id = cma_auth::org_override::resolve_org_override(org_override);
    if let Some(override_id) = override_id {
        let matched_label = candidates
            .iter()
            .find(|candidate| candidate.account_id == override_id)
            .map(|candidate| candidate.label.clone());
        return TokenSuccessWithAccount {
            tokens: tokens.clone(),
            account_id_override: Some(override_id),
            account_id_source: Some(AccountIdSource::Manual),
            account_label: matched_label,
            workspaces,
        };
    }

    if candidates.is_empty() {
        return TokenSuccessWithAccount::plain(tokens.clone());
    }
    if candidates.len() == 1 {
        let candidate = &candidates[0];
        return TokenSuccessWithAccount {
            tokens: tokens.clone(),
            account_id_override: Some(candidate.account_id.clone()),
            account_id_source: Some(candidate.source),
            account_label: Some(candidate.label.clone()),
            workspaces,
        };
    }
    match select_best_account_candidate(&candidates) {
        None => TokenSuccessWithAccount::plain(tokens.clone()),
        Some(best) => TokenSuccessWithAccount {
            tokens: tokens.clone(),
            account_id_override: Some(best.account_id.clone()),
            account_id_source: Some(best.source),
            account_label: Some(best.label.clone()),
            workspaces,
        },
    }
}

fn print_toned(text: &str, tone: UiTextTone) {
    let ui = get_ui_runtime_options();
    println!("{}", paint_ui_text(&ui, text, tone));
}

fn question(prompt: &str) -> Option<String> {
    let mut stdout = std::io::stdout();
    let _ = write!(stdout, "{prompt}");
    let _ = stdout.flush();
    let mut answer = String::new();
    match std::io::stdin().lock().read_line(&mut answer) {
        Ok(0) => None, // stream closed before a line
        Ok(_) => Some(answer.trim_end_matches(['\r', '\n']).to_string()),
        Err(_) => None,
    }
}

/// Private `promptManualCallback(state, { allowNonTty })` — interactive only
/// when both stdin & stdout are TTY; non-TTY without `allow_non_tty` →
/// cancelled; a closed pipe → cancelled.
async fn prompt_manual_callback(
    state: &str,
    allow_non_tty: bool,
) -> ManualCallbackClassification {
    let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    if !interactive && !allow_non_tty {
        return ManualCallbackClassification::Cancelled;
    }
    let answer = if interactive {
        println!();
        print_toned(ui_copy::oauth::PASTE_PROMPT, UiTextTone::Accent);
        question("\u{25c6}  ")
    } else {
        // Manual mode piping: one line from the (possibly already-closed)
        // pipe; EOF resolves null → cancelled.
        question("")
    };
    classify_manual_callback_input(answer.as_deref(), state)
}

/// `runOAuthFlow(forceNewLogin, signInMode)` — `signInMode` restricted to
/// browser/manual by the callers.
pub async fn run_oauth_flow(force_new_login: bool, sign_in_mode: OAuthSignInMode) -> TokenResult {
    let browser_mode = sign_in_mode == OAuthSignInMode::Browser;
    let flow = create_authorization_flow(AuthorizationFlowOptions { force_new_login });

    // Browser mode: the callback server never rejects; ready:false is the
    // bind-failed fallback (manual paste).
    let oauth_server = if browser_mode {
        Some(cma_auth::callback_server::start_local_oauth_server(&flow.state).await)
    } else {
        None
    };

    // The printed URL is redacted; the FULL url still goes to the browser
    // opener and the clipboard.
    let display_url = redact_oauth_url_for_log(&flow.url);

    if browser_mode {
        if cma_auth::browser::open_browser_url(&flow.url) {
            print_toned(ui_copy::oauth::BROWSER_OPENED, UiTextTone::Success);
        } else {
            print_toned(ui_copy::oauth::BROWSER_OPEN_FAIL, UiTextTone::Warning);
            println!("{} {display_url}", ui_copy::oauth::GO_TO);
            if cma_auth::browser::copy_text_to_clipboard(&flow.url) {
                print_toned(ui_copy::oauth::COPY_OK, UiTextTone::Muted);
            } else {
                print_toned(ui_copy::oauth::COPY_FAIL, UiTextTone::Muted);
            }
        }
    } else {
        println!("{} {display_url}", ui_copy::oauth::GO_TO);
        if cma_auth::browser::copy_text_to_clipboard(&flow.url) {
            print_toned(ui_copy::oauth::COPY_OK, UiTextTone::Muted);
        } else {
            print_toned(ui_copy::oauth::COPY_FAIL, UiTextTone::Muted);
        }
    }

    let waiting_for_callback = browser_mode
        && oauth_server
            .as_ref()
            .is_some_and(|server| server.ready());
    let mut code: Option<String> = None;
    if waiting_for_callback {
        print_toned(ui_copy::oauth::WAITING_CALLBACK, UiTextTone::Muted);
        if let Some(server) = &oauth_server {
            code = server
                .wait_for_code(&flow.state)
                .await
                .map(|captured| captured.code);
        }
    }

    let mut early_failure: Option<TokenResult> = None;
    if code.is_none() {
        if waiting_for_callback {
            print_toned(ui_copy::oauth::CALLBACK_MISSED, UiTextTone::Warning);
        } else if !browser_mode {
            print_toned(ui_copy::oauth::CALLBACK_BYPASSED, UiTextTone::Muted);
        } else {
            print_toned(ui_copy::oauth::CALLBACK_UNAVAILABLE, UiTextTone::Warning);
        }
        if browser_mode {
            let reason = if waiting_for_callback {
                CallbackFailureReason::CallbackTimeout
            } else {
                CallbackFailureReason::BindFailed
            };
            let context = CallbackFailureContext {
                bind_error_code: oauth_server
                    .as_ref()
                    .and_then(|server| server.bind_error_code().map(str::to_string)),
            };
            for line in describe_callback_failure(reason, &context) {
                if line.is_empty() {
                    println!();
                } else {
                    print_toned(&line, UiTextTone::Muted);
                }
            }
        }
        match prompt_manual_callback(&flow.state, sign_in_mode == OAuthSignInMode::Manual).await {
            ManualCallbackClassification::Invalid => {
                early_failure = Some(TokenResult::Failed(TokenFailure {
                    reason: Some(TokenFailureReason::InvalidResponse),
                    status_code: None,
                    message: Some(ui_copy::oauth::CALLBACK_INVALID.to_string()),
                }));
            }
            ManualCallbackClassification::StateMismatch => {
                early_failure = Some(TokenResult::Failed(TokenFailure {
                    reason: Some(TokenFailureReason::InvalidResponse),
                    status_code: None,
                    message: Some(ui_copy::oauth::CALLBACK_STATE_MISMATCH.to_string()),
                }));
            }
            ManualCallbackClassification::Code { code: pasted } => code = Some(pasted),
            ManualCallbackClassification::Cancelled => {}
        }
    }

    // TS `finally { oauthServer?.close() }`.
    if let Some(server) = &oauth_server {
        server.close();
    }
    if let Some(failure) = early_failure {
        return failure;
    }

    let Some(code) = code else {
        return TokenResult::Failed(TokenFailure {
            reason: Some(TokenFailureReason::Unknown),
            status_code: None,
            message: Some(ui_copy::oauth::CANCELLED.to_string()),
        });
    };
    exchange_authorization_code(&code, &flow.pkce.verifier, Some(REDIRECT_URI)).await
}

/// `runSignInFlow(forceNewLogin, signInMode, options)` — device auth keeps
/// polling until the 15-minute budget (the TS `keepAlive` ref-timer trick is
/// a Node-ism; the tokio runtime stays alive while awaiting).
pub async fn run_sign_in_flow(
    force_new_login: bool,
    sign_in_mode: OAuthSignInMode,
    timeout_ms: Option<i64>,
) -> TokenResult {
    match sign_in_mode {
        OAuthSignInMode::Device => {
            let options = cma_auth::device_auth::DeviceAuthFlowOptions {
                timeout_ms,
                ..Default::default()
            };
            cma_auth::device_auth::run_device_auth_flow(&options).await
        }
        OAuthSignInMode::Browser | OAuthSignInMode::Manual => {
            run_oauth_flow(force_new_login, sign_in_mode).await
        }
        // Never passed by callers (menu-only modes); treated as a cancel.
        OAuthSignInMode::RestoreBackup | OAuthSignInMode::Cancel => {
            TokenResult::Failed(TokenFailure {
                reason: Some(TokenFailureReason::Unknown),
                status_code: None,
                message: Some(ui_copy::oauth::CANCELLED.to_string()),
            })
        }
    }
}

/// Build the `ResolvedAccountWrite` for one login result (the write-shaping
/// half of `persistAccountPool`, split out for tests).
pub(crate) fn build_resolved_account_write(
    result: &TokenSuccessWithAccount,
    now: i64,
) -> ResolvedAccountWrite {
    let token_account_id = extract_account_id(Some(&result.tokens.access));
    let account_id = resolve_request_account_id(
        result.account_id_override.as_deref(),
        result.account_id_source.as_ref(),
        token_account_id.as_deref(),
    );
    let account_id_source = if account_id.is_some() {
        result.account_id_source.or({
            if result.account_id_override.is_some() {
                Some(AccountIdSource::Manual)
            } else {
                Some(AccountIdSource::Token)
            }
        })
    } else {
        None
    };
    let email = sanitize_email(
        extract_account_email(Some(&result.tokens.access), result.tokens.id_token.as_deref())
            .as_deref(),
    );
    ResolvedAccountWrite {
        account_id,
        account_id_source,
        account_label: result.account_label.clone(),
        email,
        refresh_token: result.tokens.refresh.clone(),
        access_token: Some(result.tokens.access.clone()),
        expires_at: Some(result.tokens.expires),
        workspaces: result.workspaces.clone(),
        now,
    }
}

/// `persistAccountPool(results, replaceAll)` — empty results → `None` (no
/// transaction). Persists `{version: 3, accounts, activeIndex,
/// activeIndexByFamily}` with every family set to the same active index.
pub async fn persist_account_pool(
    results: &[TokenSuccessWithAccount],
    replace_all: bool,
) -> Result<Option<AccountPoolWriteOutcome>, cma_core::errors::CodexError> {
    if results.is_empty() {
        return Ok(None);
    }
    let results = results.to_vec();
    with_account_storage_transaction(move |loaded_storage, persist| async move {
        let stored = if replace_all { None } else { loaded_storage };
        let existing: Vec<_> = stored
            .as_ref()
            .map(|storage| storage.accounts.clone())
            .unwrap_or_default();
        let prior_active_index = stored.as_ref().map(|storage| storage.active_index);
        let now = now_ms();
        let writes: Vec<ResolvedAccountWrite> = results
            .iter()
            .map(|result| build_resolved_account_write(result, now))
            .collect();

        let matcher = |accounts: &[cma_core::schemas::account_storage::AccountMetadataV3],
                       identity: &PoolWriteIdentity|
         -> Option<usize> {
            find_matching_account_index(
                accounts,
                &cma_storage::matching::AccountSelectionCandidate {
                    account_id: identity.account_id.clone(),
                    email: identity.email.clone(),
                    refresh_token: identity.refresh_token.clone(),
                },
                AccountMatchOptions {
                    allow_unique_account_id_fallback_without_email: true,
                },
            )
        };
        let fold = apply_account_pool_results(&existing, &writes, prior_active_index, &matcher);

        let mut by_family = cma_core::schemas::account_storage::ActiveIndexByFamily::default();
        for family in cma_core::model_family::MODEL_FAMILIES {
            by_family.set(family, Some(fold.active_index));
        }
        let next_storage = AccountStorageV3 {
            accounts: fold.accounts,
            active_index: fold.active_index,
            active_index_by_family: Some(by_family),
            ..AccountStorageV3::empty()
        };
        persist.persist(&next_storage).await?;
        Ok(fold.outcome)
    })
    .await
}

/// `syncSelectionToCodex(tokens)` — same accountId precedence, then mirror
/// into the Codex CLI auth files.
pub async fn sync_selection_to_codex(result: &TokenSuccessWithAccount) -> bool {
    let token_account_id = extract_account_id(Some(&result.tokens.access));
    let account_id = resolve_request_account_id(
        result.account_id_override.as_deref(),
        result.account_id_source.as_ref(),
        token_account_id.as_deref(),
    );
    let email = sanitize_email(
        extract_account_email(Some(&result.tokens.access), result.tokens.id_token.as_deref())
            .as_deref(),
    );
    set_codex_cli_active_selection(&ActiveSelection {
        account_id,
        email,
        access_token: Some(result.tokens.access.clone()),
        refresh_token: Some(result.tokens.refresh.clone()),
        expires_at: Some(result.tokens.expires as f64),
        id_token: result.tokens.id_token.clone(),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(message: Option<&str>, reason: Option<TokenFailureReason>) -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason,
            status_code: None,
            message: message.map(str::to_string),
        })
    }

    #[test]
    fn oauth_cancellation_matches_both_spellings_and_falls_back_to_reason() {
        assert!(is_oauth_cancellation(&failed(
            Some("Sign-in cancelled."),
            None
        )));
        assert!(is_oauth_cancellation(&failed(
            Some("user CANCELED the flow"),
            None
        )));
        assert!(!is_oauth_cancellation(&failed(
            Some("network exploded"),
            Some(TokenFailureReason::NetworkError)
        )));
        // No message → reason string is checked (none of the reasons contain
        // "cancelled", so this stays false).
        assert!(!is_oauth_cancellation(&failed(
            None,
            Some(TokenFailureReason::Unknown)
        )));
        let success = TokenResult::Success(TokenSuccess {
            access: "a".into(),
            refresh: "r".into(),
            expires: 1,
            id_token: None,
            multi_account: None,
        });
        assert!(!is_oauth_cancellation(&success));
    }

    #[test]
    fn resolved_write_prefers_override_and_labels_manual_source() {
        let tokens = TokenSuccess {
            access: "not-a-jwt".into(),
            refresh: "rt-0123456789abcdefghij".into(),
            expires: 999,
            id_token: None,
            multi_account: None,
        };
        let result = TokenSuccessWithAccount {
            tokens,
            account_id_override: Some("acc_org".into()),
            account_id_source: None,
            account_label: Some("Org".into()),
            workspaces: None,
        };
        let write = build_resolved_account_write(&result, 42);
        assert_eq!(write.account_id.as_deref(), Some("acc_org"));
        // No explicit source + override present → manual.
        assert_eq!(write.account_id_source, Some(AccountIdSource::Manual));
        assert_eq!(write.account_label.as_deref(), Some("Org"));
        assert_eq!(write.access_token.as_deref(), Some("not-a-jwt"));
        assert_eq!(write.expires_at, Some(999));
        assert_eq!(write.now, 42);
    }

    #[test]
    fn resolve_account_selection_without_candidates_returns_plain_tokens() {
        let tokens = TokenSuccess {
            access: "not-a-jwt".into(),
            refresh: "rt-0123456789abcdefghij".into(),
            expires: 1,
            id_token: None,
            multi_account: None,
        };
        let resolved = resolve_account_selection(&tokens, None);
        assert_eq!(resolved, TokenSuccessWithAccount::plain(tokens));
    }
}
