//! Port of `lib/runtime/browser-oauth-flow.ts` — browser-based OAuth login
//! orchestration (spec 10 §20).
//!
//! Flow: create authorization flow → log redacted URL → start the local
//! callback server (start failures are debug-logged and treated as "not
//! ready") → open the browser → wait for the code → exchange it. The
//! callback server NEVER rejects by contract (cma-auth); a not-ready server
//! warns and fails the flow with a bare `{type:"failed"}`.

#![allow(clippy::result_large_err)] // CodexError is the crate-wide error vocabulary.

use cma_core::errors::CodexError;
use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenResult};
use cma_core::types::AuthorizationFlow;

/// Minimal callback-server surface the flow needs (implemented for
/// `cma_auth::callback_server::LocalOAuthServer` below).
#[allow(async_fn_in_trait)]
pub trait OAuthCallbackServer {
    fn ready(&self) -> bool;
    fn close(&self);
    /// Resolves with the captured code, or `None` on timeout/cancel.
    async fn wait_for_code(&self, expected_state: &str) -> Option<String>;
}

impl OAuthCallbackServer for cma_auth::callback_server::LocalOAuthServer {
    fn ready(&self) -> bool {
        self.ready()
    }
    fn close(&self) {
        self.close()
    }
    async fn wait_for_code(&self, expected_state: &str) -> Option<String> {
        self.wait_for_code(expected_state)
            .await
            .map(|captured| captured.code)
    }
}

/// I/O seams of [`run_browser_oauth_flow`] (the TS `params` object).
#[allow(async_fn_in_trait)]
pub trait BrowserOAuthFlowDeps {
    type Server: OAuthCallbackServer;

    /// TS `createAuthorizationFlow({forceNewLogin})`.
    fn create_authorization_flow(
        &mut self,
        force_new_login: bool,
    ) -> Result<AuthorizationFlow, CodexError>;
    /// TS `startLocalOAuthServer({state})` — `Err` models the TS throw path
    /// (debug-logged, treated as no server).
    async fn start_local_oauth_server(&mut self, state: &str) -> Result<Self::Server, CodexError>;
    fn open_browser_url(&mut self, url: &str);
    async fn exchange_authorization_code(
        &mut self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> TokenResult;
    fn redirect_uri(&self) -> String {
        cma_auth::oauth::REDIRECT_URI.to_string()
    }
    fn redact_oauth_url_for_log(&self, url: &str) -> String {
        cma_auth::oauth::redact_oauth_url_for_log(url)
    }
    fn plugin_name(&self) -> &str;
    fn auth_manual_label(&self) -> &str;
    fn log_info(&mut self, message: &str);
    fn log_debug(&mut self, message: &str);
    fn log_warn(&mut self, message: &str);
}

/// TS `runBrowserOAuthFlow(params)`.
pub async fn run_browser_oauth_flow<D: BrowserOAuthFlowDeps>(
    force_new_login: bool,
    deps: &mut D,
) -> Result<TokenResult, CodexError> {
    let flow = deps.create_authorization_flow(force_new_login)?;
    let redacted = deps.redact_oauth_url_for_log(&flow.url);
    deps.log_info(&format!("OAuth URL: {redacted}"));

    let server = match deps.start_local_oauth_server(&flow.state).await {
        Ok(server) => Some(server),
        Err(error) => {
            deps.log_debug(&format!(
                "[{}] Failed to start OAuth server: {}",
                deps.plugin_name(),
                error.message()
            ));
            None
        }
    };

    let ready = server.as_ref().is_some_and(OAuthCallbackServer::ready);
    if !ready {
        if let Some(server) = server.as_ref() {
            server.close();
        }
        deps.log_warn(&format!(
            "\n[{}] OAuth callback server failed to start. Please retry with \"{}\".\n",
            deps.plugin_name(),
            deps.auth_manual_label()
        ));
        return Ok(TokenResult::Failed(TokenFailure::default()));
    }
    let server = server.expect("ready implies present");

    deps.open_browser_url(&flow.url);
    let result = server.wait_for_code(&flow.state).await;
    server.close();

    let Some(code) = result else {
        return Ok(TokenResult::Failed(TokenFailure {
            reason: Some(TokenFailureReason::Unknown),
            status_code: None,
            message: Some("OAuth callback timeout or cancelled".to_string()),
        }));
    };

    let redirect_uri = deps.redirect_uri();
    Ok(deps
        .exchange_authorization_code(&code, &flow.pkce.verifier, &redirect_uri)
        .await)
}

/// Production wiring over `cma_auth` (browser open, callback server on port
/// 1455, code exchange). Logging closures come from the caller (the facade
/// prefixes them — spec 10 §20).
pub struct RuntimeBrowserOAuthFlowDeps<'a> {
    pub plugin_name: &'a str,
    pub auth_manual_label: &'a str,
    pub log_info: &'a mut dyn FnMut(&str),
    pub log_debug: &'a mut dyn FnMut(&str),
    pub log_warn: &'a mut dyn FnMut(&str),
}

impl BrowserOAuthFlowDeps for RuntimeBrowserOAuthFlowDeps<'_> {
    type Server = cma_auth::callback_server::LocalOAuthServer;

    fn create_authorization_flow(
        &mut self,
        force_new_login: bool,
    ) -> Result<AuthorizationFlow, CodexError> {
        Ok(cma_auth::oauth::create_authorization_flow(
            cma_auth::oauth::AuthorizationFlowOptions { force_new_login },
        ))
    }

    async fn start_local_oauth_server(&mut self, state: &str) -> Result<Self::Server, CodexError> {
        // Contract: never rejects — a bind failure yields ready:false.
        Ok(cma_auth::callback_server::start_local_oauth_server(state).await)
    }

    fn open_browser_url(&mut self, url: &str) {
        cma_auth::browser::open_browser_url(url);
    }

    async fn exchange_authorization_code(
        &mut self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> TokenResult {
        cma_auth::oauth::exchange_authorization_code(code, verifier, Some(redirect_uri)).await
    }

    fn plugin_name(&self) -> &str {
        self.plugin_name
    }
    fn auth_manual_label(&self) -> &str {
        self.auth_manual_label
    }
    fn log_info(&mut self, message: &str) {
        (self.log_info)(message);
    }
    fn log_debug(&mut self, message: &str) {
        (self.log_debug)(message);
    }
    fn log_warn(&mut self, message: &str) {
        (self.log_warn)(message);
    }
}

// =============================================================================
// Tests — ported from test/browser-oauth-flow.test.ts
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::TokenSuccess;
    use cma_core::types::PKCEPair;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    struct FakeServer {
        ready: bool,
        code: Option<String>,
        closed: Arc<AtomicBool>,
        wait_calls: Arc<AtomicU32>,
    }

    impl OAuthCallbackServer for FakeServer {
        fn ready(&self) -> bool {
            self.ready
        }
        fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
        async fn wait_for_code(&self, _expected_state: &str) -> Option<String> {
            self.wait_calls.fetch_add(1, Ordering::SeqCst);
            self.code.clone()
        }
    }

    struct FakeDeps {
        start_fails: bool,
        server_ready: bool,
        server_code: Option<String>,
        closed: Arc<AtomicBool>,
        wait_calls: Arc<AtomicU32>,
        opened_urls: Vec<String>,
        exchanged: Vec<(String, String, String)>,
        infos: Vec<String>,
        debugs: Vec<String>,
        warns: Vec<String>,
    }

    impl FakeDeps {
        fn new() -> Self {
            Self {
                start_fails: false,
                server_ready: true,
                server_code: Some("auth-code".to_string()),
                closed: Arc::new(AtomicBool::new(false)),
                wait_calls: Arc::new(AtomicU32::new(0)),
                opened_urls: Vec::new(),
                exchanged: Vec::new(),
                infos: Vec::new(),
                debugs: Vec::new(),
                warns: Vec::new(),
            }
        }
    }

    impl BrowserOAuthFlowDeps for FakeDeps {
        type Server = FakeServer;

        fn create_authorization_flow(
            &mut self,
            force_new_login: bool,
        ) -> Result<AuthorizationFlow, CodexError> {
            let _ = force_new_login;
            Ok(AuthorizationFlow {
                pkce: PKCEPair {
                    challenge: "challenge".to_string(),
                    verifier: "verifier-1".to_string(),
                },
                state: "state-1".to_string(),
                url: "https://auth.openai.com/oauth/authorize?client_id=x".to_string(),
            })
        }

        async fn start_local_oauth_server(
            &mut self,
            _state: &str,
        ) -> Result<Self::Server, CodexError> {
            if self.start_fails {
                return Err(CodexError::new("bind exploded"));
            }
            Ok(FakeServer {
                ready: self.server_ready,
                code: self.server_code.clone(),
                closed: Arc::clone(&self.closed),
                wait_calls: Arc::clone(&self.wait_calls),
            })
        }

        fn open_browser_url(&mut self, url: &str) {
            self.opened_urls.push(url.to_string());
        }

        async fn exchange_authorization_code(
            &mut self,
            code: &str,
            verifier: &str,
            redirect_uri: &str,
        ) -> TokenResult {
            self.exchanged
                .push((code.to_string(), verifier.to_string(), redirect_uri.to_string()));
            TokenResult::Success(TokenSuccess {
                access: "at".to_string(),
                refresh: "rt".to_string(),
                expires: 9_999,
                id_token: None,
                multi_account: None,
            })
        }

        fn redirect_uri(&self) -> String {
            "http://localhost:1455/auth/callback".to_string()
        }
        fn redact_oauth_url_for_log(&self, url: &str) -> String {
            format!("<redacted:{}>", url.len())
        }
        fn plugin_name(&self) -> &str {
            "codex-multi-auth"
        }
        fn auth_manual_label(&self) -> &str {
            "ChatGPT (manual)"
        }
        fn log_info(&mut self, message: &str) {
            self.infos.push(message.to_string());
        }
        fn log_debug(&mut self, message: &str) {
            self.debugs.push(message.to_string());
        }
        fn log_warn(&mut self, message: &str) {
            self.warns.push(message.to_string());
        }
    }

    #[tokio::test]
    async fn happy_path_exchanges_captured_code() {
        let mut deps = FakeDeps::new();
        let result = run_browser_oauth_flow(false, &mut deps).await.unwrap();
        assert!(result.is_success());
        assert_eq!(deps.opened_urls.len(), 1);
        assert_eq!(
            deps.exchanged,
            vec![(
                "auth-code".to_string(),
                "verifier-1".to_string(),
                "http://localhost:1455/auth/callback".to_string()
            )]
        );
        // Redacted URL logged.
        assert!(deps.infos[0].starts_with("OAuth URL: <redacted:"));
        // Server closed after the wait.
        assert!(deps.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn server_start_failure_warns_and_fails() {
        let mut deps = FakeDeps::new();
        deps.start_fails = true;
        let result = run_browser_oauth_flow(false, &mut deps).await.unwrap();
        assert!(!result.is_success());
        let failure = result.as_failure().unwrap();
        assert_eq!(failure.reason, None);
        assert_eq!(failure.message, None);
        assert_eq!(
            deps.debugs,
            vec!["[codex-multi-auth] Failed to start OAuth server: bind exploded"]
        );
        assert_eq!(
            deps.warns,
            vec![
                "\n[codex-multi-auth] OAuth callback server failed to start. Please retry with \"ChatGPT (manual)\".\n"
            ]
        );
        assert!(deps.opened_urls.is_empty());
    }

    #[tokio::test]
    async fn not_ready_server_is_closed_and_fails() {
        let mut deps = FakeDeps::new();
        deps.server_ready = false;
        let result = run_browser_oauth_flow(false, &mut deps).await.unwrap();
        assert!(!result.is_success());
        assert!(deps.closed.load(Ordering::SeqCst));
        assert_eq!(deps.warns.len(), 1);
        assert!(deps.opened_urls.is_empty());
    }

    #[tokio::test]
    async fn wait_timeout_yields_unknown_failure_message() {
        let mut deps = FakeDeps::new();
        deps.server_code = None;
        let result = run_browser_oauth_flow(true, &mut deps).await.unwrap();
        let failure = result.as_failure().unwrap();
        assert_eq!(failure.reason, Some(TokenFailureReason::Unknown));
        assert_eq!(
            failure.message.as_deref(),
            Some("OAuth callback timeout or cancelled")
        );
        // Server still closed.
        assert!(deps.closed.load(Ordering::SeqCst));
        assert!(deps.exchanged.is_empty());
    }
}
