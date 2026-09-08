//! Port of `lib/runtime/auth-facade.ts` — the runtime OAuth facade
//! (spec 10 §20).
//!
//! - `run_runtime_oauth_flow` wraps the browser flow with the
//!   prefix-normalizing log adapters (debug: `[{plugin}] ` unless already
//!   prefixed, incl. after a leading `\n`; warn additionally gets a leading
//!   newline).
//! - TS `createPersistAccounts` returned a closure partially applying
//!   `persistAccountPoolResults`; in Rust that shim is absorbed —
//!   [`persist_accounts`] delegates directly.
//! - TS `createAccountManagerReloader` was a DI forwarder over
//!   `account-manager-cache.ts`; the dedupe lives in
//!   `crate::manager_cache` (its owner), so no separate facade shim exists
//!   here (architecture §4 shim-absorption rule).

use cma_core::errors::CodexError;
use cma_core::schemas::token::TokenResult;

use crate::account_selection::TokenSuccessWithAccount;

/// TS private `prefixLogMessage(message, {leadingNewline})`.
fn prefix_log_message(plugin_prefix: &str, message: &str, leading_newline: bool) -> String {
    if message.starts_with(plugin_prefix)
        || message.starts_with(&format!("\n{plugin_prefix}"))
    {
        return message.to_string();
    }
    if leading_newline {
        format!("\n{plugin_prefix} {message}")
    } else {
        format!("{plugin_prefix} {message}")
    }
}

/// Collaborators of [`run_runtime_oauth_flow`] (TS `deps`).
#[allow(async_fn_in_trait)]
pub trait RuntimeOAuthFlowDeps {
    /// The wrapped browser flow (TS `deps.runBrowserOAuthFlow`) — receives
    /// the prefix-normalizing log adapters.
    async fn run_browser_oauth_flow(
        &mut self,
        force_new_login: bool,
        manual_mode_label: &str,
        log_info: &mut dyn FnMut(&str),
        log_debug: &mut dyn FnMut(&str),
        log_warn: &mut dyn FnMut(&str),
    ) -> Result<TokenResult, CodexError>;
    fn manual_mode_label(&self) -> &str;
    fn plugin_name(&self) -> &str;
    fn log_info(&mut self, message: &str);
    fn log_debug(&mut self, message: &str);
    fn log_warn(&mut self, message: &str);
}

/// TS `runRuntimeOAuthFlow(forceNewLogin, deps)`.
pub async fn run_runtime_oauth_flow<D: RuntimeOAuthFlowDeps>(
    force_new_login: bool,
    deps: &mut D,
) -> Result<TokenResult, CodexError> {
    let plugin_prefix = format!("[{}]", deps.plugin_name());
    let manual_mode_label = deps.manual_mode_label().to_string();

    // Collect adapter output, then flush through the deps sinks (Rust's
    // borrow rules forbid re-borrowing `deps` inside the closures).
    let mut info_lines: Vec<String> = Vec::new();
    let mut debug_lines: Vec<String> = Vec::new();
    let mut warn_lines: Vec<String> = Vec::new();
    let result = {
        let mut log_info = |message: &str| info_lines.push(message.to_string());
        let mut log_debug =
            |message: &str| debug_lines.push(prefix_log_message(&plugin_prefix, message, false));
        let mut log_warn =
            |message: &str| warn_lines.push(prefix_log_message(&plugin_prefix, message, true));
        deps.run_browser_oauth_flow(
            force_new_login,
            &manual_mode_label,
            &mut log_info,
            &mut log_debug,
            &mut log_warn,
        )
        .await
    };
    for line in info_lines {
        deps.log_info(&line);
    }
    for line in debug_lines {
        deps.log_debug(&line);
    }
    for line in warn_lines {
        deps.log_warn(&line);
    }
    result
}

/// TS `createPersistAccounts(deps)(results, replaceAll)` — absorbed shim:
/// delegates straight to `crate::account_pool::persist_account_pool_results`.
pub async fn persist_accounts(
    results: &[TokenSuccessWithAccount],
    replace_all: bool,
) -> Result<(), CodexError> {
    crate::account_pool::persist_account_pool_results(results, replace_all).await
}

// =============================================================================
// Tests — facade prefix normalization contract
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::TokenFailure;

    #[test]
    fn prefix_log_message_matches_ts() {
        let prefix = "[codex-multi-auth]";
        assert_eq!(
            prefix_log_message(prefix, "hello", false),
            "[codex-multi-auth] hello"
        );
        assert_eq!(
            prefix_log_message(prefix, "hello", true),
            "\n[codex-multi-auth] hello"
        );
        // Already prefixed → untouched.
        assert_eq!(
            prefix_log_message(prefix, "[codex-multi-auth] hi", true),
            "[codex-multi-auth] hi"
        );
        // Prefixed after a leading newline → untouched.
        assert_eq!(
            prefix_log_message(prefix, "\n[codex-multi-auth] hi", false),
            "\n[codex-multi-auth] hi"
        );
    }

    struct FakeDeps {
        infos: Vec<String>,
        debugs: Vec<String>,
        warns: Vec<String>,
        seen_label: Option<String>,
        seen_force: Option<bool>,
    }

    impl RuntimeOAuthFlowDeps for FakeDeps {
        async fn run_browser_oauth_flow(
            &mut self,
            force_new_login: bool,
            manual_mode_label: &str,
            log_info: &mut dyn FnMut(&str),
            log_debug: &mut dyn FnMut(&str),
            log_warn: &mut dyn FnMut(&str),
        ) -> Result<TokenResult, CodexError> {
            self.seen_label = Some(manual_mode_label.to_string());
            self.seen_force = Some(force_new_login);
            log_info("OAuth URL: <redacted>");
            log_debug("raw debug");
            log_debug("[codex-multi-auth] already prefixed");
            log_warn("server failed");
            Ok(TokenResult::Failed(TokenFailure::default()))
        }
        fn manual_mode_label(&self) -> &str {
            "ChatGPT (manual)"
        }
        fn plugin_name(&self) -> &str {
            "codex-multi-auth"
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
    async fn wraps_logs_with_plugin_prefix() {
        let mut deps = FakeDeps {
            infos: Vec::new(),
            debugs: Vec::new(),
            warns: Vec::new(),
            seen_label: None,
            seen_force: None,
        };
        let result = run_runtime_oauth_flow(true, &mut deps).await.unwrap();
        assert!(!result.is_success());
        assert_eq!(deps.seen_force, Some(true));
        assert_eq!(deps.seen_label.as_deref(), Some("ChatGPT (manual)"));
        // Info passes through unprefixed.
        assert_eq!(deps.infos, vec!["OAuth URL: <redacted>"]);
        // Debug prefixed once, never double-prefixed.
        assert_eq!(
            deps.debugs,
            vec![
                "[codex-multi-auth] raw debug",
                "[codex-multi-auth] already prefixed"
            ]
        );
        // Warn gets the leading newline.
        assert_eq!(deps.warns, vec!["\n[codex-multi-auth] server failed"]);
    }
}
