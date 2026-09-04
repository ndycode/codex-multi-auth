//! Port of `lib/runtime/manual-oauth-flow.ts` — manual paste-the-callback-URL
//! OAuth flow (spec 10 §20).
//!
//! `validate` classifies the pasted input WITHOUT side effects (returns the
//! exact operator-facing error strings); `callback` re-parses, exchanges the
//! code, resolves the account selection and optionally persists via
//! `on_success`.

use cma_core::errors::CodexError;
use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenResult, TokenSuccess};
use cma_core::types::ParsedAuthInput;

use crate::account_selection::TokenSuccessWithAccount;

/// The `callback` outcome: either the resolved success (TS `TResolved`) or a
/// pass-through token failure.
#[derive(Clone, Debug, PartialEq)]
pub enum ManualFlowOutcome {
    Resolved(TokenSuccessWithAccount),
    Failed(TokenFailure),
}

impl ManualFlowOutcome {
    pub fn is_success(&self) -> bool {
        matches!(self, Self::Resolved(_))
    }
}

/// Collaborators of the manual flow (TS `ManualOAuthFlowParams` behavior
/// members).
#[allow(async_fn_in_trait)]
pub trait ManualOAuthFlowDeps {
    fn parse_authorization_input(&self, input: &str) -> ParsedAuthInput {
        cma_auth::oauth::parse_authorization_input(input)
    }
    async fn exchange_authorization_code(
        &mut self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> TokenResult;
    /// TS `resolveTokenSuccess` (the runtime overload wires
    /// `resolveAccountSelection` + `CODEX_AUTH_ACCOUNT_ID`).
    fn resolve_token_success(&mut self, tokens: TokenSuccess) -> TokenSuccessWithAccount;
    /// TS optional `onSuccess` — errors propagate (the TS callback awaits it
    /// without a catch).
    async fn on_success(&mut self, tokens: &TokenSuccessWithAccount) -> Result<(), CodexError> {
        let _ = tokens;
        Ok(())
    }
}

/// TS `ManualOAuthFlow` — `{url, method: "code", instructions, validate,
/// callback}` with the closures expressed as methods over stored state.
pub struct ManualOAuthFlow<D: ManualOAuthFlowDeps> {
    pub url: String,
    /// Always `"code"`.
    pub method: &'static str,
    pub instructions: String,
    pkce_verifier: String,
    expected_state: String,
    redirect_uri: String,
    deps: D,
}

/// Data half of the TS `ManualOAuthFlowParams` object.
pub struct ManualOAuthFlowParams {
    pub pkce_verifier: String,
    pub url: String,
    pub expected_state: String,
    pub redirect_uri: String,
    pub instructions: String,
}

/// TS `buildManualOAuthFlow(params)` (generic overload).
pub fn build_manual_oauth_flow<D: ManualOAuthFlowDeps>(
    params: ManualOAuthFlowParams,
    deps: D,
) -> ManualOAuthFlow<D> {
    ManualOAuthFlow {
        url: params.url,
        method: "code",
        instructions: params.instructions,
        pkce_verifier: params.pkce_verifier,
        expected_state: params.expected_state,
        redirect_uri: params.redirect_uri,
        deps,
    }
}

impl<D: ManualOAuthFlowDeps> ManualOAuthFlow<D> {
    /// TS `flow.validate(input)` — `None` = valid; `Some(message)` = the
    /// exact operator-facing error.
    pub fn validate(&self, input: &str) -> Option<String> {
        let parsed = self.deps.parse_authorization_input(input);
        if parsed.code.is_none() {
            return Some(format!(
                "No authorization code found. Paste the full callback URL (e.g., {}?code=...)",
                self.redirect_uri
            ));
        }
        if parsed.state.is_none() {
            return Some(
                "Missing OAuth state. Paste the full callback URL including both code and state parameters."
                    .to_string(),
            );
        }
        if parsed.state.as_deref() != Some(self.expected_state.as_str()) {
            return Some(
                "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt."
                    .to_string(),
            );
        }
        None
    }

    /// TS `flow.callback(input)`.
    pub async fn callback(&mut self, input: &str) -> Result<ManualFlowOutcome, CodexError> {
        let parsed = self.deps.parse_authorization_input(input);
        let (Some(code), Some(state)) = (parsed.code, parsed.state) else {
            return Ok(ManualFlowOutcome::Failed(TokenFailure {
                reason: Some(TokenFailureReason::InvalidResponse),
                status_code: None,
                message: Some("Missing authorization code or OAuth state".to_string()),
            }));
        };
        if state != self.expected_state {
            return Ok(ManualFlowOutcome::Failed(TokenFailure {
                reason: Some(TokenFailureReason::InvalidResponse),
                status_code: None,
                message: Some("OAuth state mismatch. Restart login and try again.".to_string()),
            }));
        }
        let tokens = self
            .deps
            .exchange_authorization_code(&code, &self.pkce_verifier, &self.redirect_uri)
            .await;
        match tokens {
            TokenResult::Success(tokens) => {
                let resolved = self.deps.resolve_token_success(tokens);
                self.deps.on_success(&resolved).await?;
                Ok(ManualFlowOutcome::Resolved(resolved))
            }
            TokenResult::Failed(failure) => Ok(ManualFlowOutcome::Failed(failure)),
        }
    }
}

// =============================================================================
// Runtime overload wiring (TS `buildManualOAuthFlow(pkce, url, state, deps)`)
// =============================================================================

/// TS optional `onSuccess(resolved)` hook shape.
pub type OnManualFlowSuccess<'a> =
    &'a mut dyn FnMut(&TokenSuccessWithAccount) -> Result<(), CodexError>;

/// Runtime deps: `cma_auth` parse/exchange + `resolveAccountSelection` over
/// `CODEX_AUTH_ACCOUNT_ID`, with an optional persist hook.
pub struct RuntimeManualOAuthFlowDeps<'a> {
    pub log_info: &'a mut dyn FnMut(&str),
    /// TS optional `onSuccess(resolved)`.
    pub on_success: Option<OnManualFlowSuccess<'a>>,
}

impl ManualOAuthFlowDeps for RuntimeManualOAuthFlowDeps<'_> {
    async fn exchange_authorization_code(
        &mut self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> TokenResult {
        cma_auth::oauth::exchange_authorization_code(code, verifier, Some(redirect_uri)).await
    }

    fn resolve_token_success(&mut self, tokens: TokenSuccess) -> TokenSuccessWithAccount {
        crate::account_selection::resolve_account_selection_runtime(tokens, self.log_info)
    }

    async fn on_success(&mut self, tokens: &TokenSuccessWithAccount) -> Result<(), CodexError> {
        match self.on_success.as_mut() {
            Some(on_success) => on_success(tokens),
            None => Ok(()),
        }
    }
}

/// TS runtime overload — wires `REDIRECT_URI` and the runtime deps.
pub fn build_runtime_manual_oauth_flow<'a>(
    pkce_verifier: String,
    url: String,
    expected_state: String,
    instructions: String,
    deps: RuntimeManualOAuthFlowDeps<'a>,
) -> ManualOAuthFlow<RuntimeManualOAuthFlowDeps<'a>> {
    build_manual_oauth_flow(
        ManualOAuthFlowParams {
            pkce_verifier,
            url,
            expected_state,
            redirect_uri: cma_auth::oauth::REDIRECT_URI.to_string(),
            instructions,
        },
        deps,
    )
}

// =============================================================================
// Tests — ported from test/manual-oauth-flow.test.ts
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeDeps {
        exchange_result: TokenResult,
        exchanged: Vec<(String, String, String)>,
        on_success_calls: u32,
        on_success_fails: bool,
    }

    impl FakeDeps {
        fn success() -> Self {
            Self {
                exchange_result: TokenResult::Success(TokenSuccess {
                    access: "at".to_string(),
                    refresh: "rt".to_string(),
                    expires: 9_999,
                    id_token: None,
                    multi_account: None,
                }),
                exchanged: Vec::new(),
                on_success_calls: 0,
                on_success_fails: false,
            }
        }
    }

    impl ManualOAuthFlowDeps for FakeDeps {
        async fn exchange_authorization_code(
            &mut self,
            code: &str,
            verifier: &str,
            redirect_uri: &str,
        ) -> TokenResult {
            self.exchanged
                .push((code.to_string(), verifier.to_string(), redirect_uri.to_string()));
            self.exchange_result.clone()
        }
        fn resolve_token_success(&mut self, tokens: TokenSuccess) -> TokenSuccessWithAccount {
            let mut resolved = TokenSuccessWithAccount::plain(tokens);
            resolved.account_label = Some("Resolved".to_string());
            resolved
        }
        async fn on_success(
            &mut self,
            _tokens: &TokenSuccessWithAccount,
        ) -> Result<(), CodexError> {
            self.on_success_calls += 1;
            if self.on_success_fails {
                return Err(CodexError::new("persist failed"));
            }
            Ok(())
        }
    }

    fn flow(deps: FakeDeps) -> ManualOAuthFlow<FakeDeps> {
        build_manual_oauth_flow(
            ManualOAuthFlowParams {
                pkce_verifier: "verifier-1".to_string(),
                url: "https://auth.openai.com/authorize?x=1".to_string(),
                expected_state: "state-1".to_string(),
                redirect_uri: "http://localhost:1455/auth/callback".to_string(),
                instructions: "Paste the URL".to_string(),
            },
            deps,
        )
    }

    #[test]
    fn validate_error_strings_are_exact() {
        let flow = flow(FakeDeps::success());
        assert_eq!(flow.method, "code");
        // Empty input parses to no code at all (bare strings are treated as
        // raw codes by parseAuthorizationInput — same as TS).
        assert_eq!(
            flow.validate(""),
            Some(
                "No authorization code found. Paste the full callback URL (e.g., http://localhost:1455/auth/callback?code=...)"
                    .to_string()
            )
        );
        assert_eq!(
            flow.validate("http://localhost:1455/auth/callback?code=abc"),
            Some(
                "Missing OAuth state. Paste the full callback URL including both code and state parameters."
                    .to_string()
            )
        );
        assert_eq!(
            flow.validate("http://localhost:1455/auth/callback?code=abc&state=WRONG"),
            Some(
                "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt."
                    .to_string()
            )
        );
        assert_eq!(
            flow.validate("http://localhost:1455/auth/callback?code=abc&state=state-1"),
            None
        );
    }

    #[tokio::test]
    async fn callback_classifies_missing_and_mismatched_state() {
        let mut flow = flow(FakeDeps::success());
        let outcome = flow.callback("garbage").await.unwrap();
        let ManualFlowOutcome::Failed(failure) = outcome else {
            panic!("expected failure");
        };
        assert_eq!(failure.reason, Some(TokenFailureReason::InvalidResponse));
        assert_eq!(
            failure.message.as_deref(),
            Some("Missing authorization code or OAuth state")
        );

        let outcome = flow
            .callback("http://localhost:1455/auth/callback?code=abc&state=WRONG")
            .await
            .unwrap();
        let ManualFlowOutcome::Failed(failure) = outcome else {
            panic!("expected failure");
        };
        assert_eq!(
            failure.message.as_deref(),
            Some("OAuth state mismatch. Restart login and try again.")
        );
        // Exchange never ran.
        assert!(flow.deps.exchanged.is_empty());
    }

    #[tokio::test]
    async fn callback_exchanges_resolves_and_fires_on_success() {
        let mut flow = flow(FakeDeps::success());
        let outcome = flow
            .callback("http://localhost:1455/auth/callback?code=abc&state=state-1")
            .await
            .unwrap();
        let ManualFlowOutcome::Resolved(resolved) = outcome else {
            panic!("expected success");
        };
        assert_eq!(resolved.account_label.as_deref(), Some("Resolved"));
        assert_eq!(
            flow.deps.exchanged,
            vec![(
                "abc".to_string(),
                "verifier-1".to_string(),
                "http://localhost:1455/auth/callback".to_string()
            )]
        );
        assert_eq!(flow.deps.on_success_calls, 1);
    }

    #[tokio::test]
    async fn failed_exchange_passes_failure_through() {
        let mut deps = FakeDeps::success();
        deps.exchange_result = TokenResult::Failed(TokenFailure {
            reason: Some(TokenFailureReason::HttpError),
            status_code: Some(500),
            message: Some("boom".to_string()),
        });
        let mut flow = flow(deps);
        let outcome = flow
            .callback("http://localhost:1455/auth/callback?code=abc&state=state-1")
            .await
            .unwrap();
        let ManualFlowOutcome::Failed(failure) = outcome else {
            panic!("expected failure");
        };
        assert_eq!(failure.status_code, Some(500));
        assert_eq!(flow.deps.on_success_calls, 0);
    }

    #[tokio::test]
    async fn on_success_errors_propagate() {
        let mut deps = FakeDeps::success();
        deps.on_success_fails = true;
        let mut flow = flow(deps);
        let error = flow
            .callback("http://localhost:1455/auth/callback?code=abc&state=state-1")
            .await
            .unwrap_err();
        assert_eq!(error.message(), "persist failed");
    }
}
