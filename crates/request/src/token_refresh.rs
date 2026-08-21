//! Port of `lib/request/token-refresh.ts` — OAuth refresh + persistence.
//!
//! Behavior source: spec 06 §10 + the TS source (authority). `fetch_helpers`
//! re-exports this module's public surface, mirroring the TS re-export
//! contract.
//!
//! Persistence boundary (spec 06 §23): the TS module persists refreshed
//! credentials ONLY through the host client
//! (`client.auth.set({ path: { id: "openai" }, body: { type: "oauth", access,
//! refresh, expires, multiAccount: true } })`). The Rust port replaces the
//! host client with an injected [`AuthSetterFn`] (wired by the pipeline to
//! storage/accounts persistence — ARCHITECTURE §6.10). `multiAccount: true`
//! remains a required literal on [`AuthPersistPayload`].
//!
//! Mutation contract (spec 06 gotcha 20): `refreshAndUpdateToken` persists
//! FIRST, then mutates the shared Auth object in place and returns the same
//! reference. Rust mirrors this with `&mut Auth`: the setter future is awaited
//! before the fields are overwritten. Same-token refreshes are serialized via
//! `cma_auth::refresh_queue::queued_refresh`.

use cma_core::constants::{ERROR_MESSAGES, HTTP_STATUS};
use cma_core::errors::{CodexError, ErrorContext};
use cma_core::fs_retry::{CodedError, code_of};
use cma_core::schemas::token::{TokenFailure, TokenFailureReason, TokenResult};
use cma_core::types::OAuthAuthDetails;
use cma_core::utils::now_ms;
use futures::future::BoxFuture;
use serde_json::Value;
use std::error::Error as StdError;
use std::future::Future;

/// Boxed error carried by auth-setter failures (the TS thrown `unknown`).
pub type BoxError = Box<dyn StdError + Send + Sync + 'static>;

/// The TS `@codex-ai/sdk` `Auth` union, reduced to what this cluster needs:
/// the OAuth arm (with its token fields) versus "anything else" (API key
/// etc.), which always triggers a refresh and is never mutated.
#[derive(Debug, Clone)]
pub enum Auth {
    OAuth(OAuthAuthDetails),
    /// Any non-OAuth auth entry (the TS `{ type: "api", ... }` arm). Only its
    /// not-OAuth-ness matters here.
    Other,
}

impl Auth {
    /// The OAuth details when this is the OAuth arm.
    pub fn as_oauth(&self) -> Option<&OAuthAuthDetails> {
        match self {
            Auth::OAuth(details) => Some(details),
            Auth::Other => None,
        }
    }
}

/// TS `client.auth.set` body: `{ type: "oauth", access, refresh, expires,
/// multiAccount: true }`. The receiving store owns the on-disk format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthPersistPayload {
    /// Always `"oauth"` (TS literal).
    pub auth_type: &'static str,
    pub access: String,
    pub refresh: String,
    /// Epoch milliseconds.
    pub expires: i64,
    /// Always `true` (TS required literal `multiAccount: true`).
    pub multi_account: bool,
}

/// The injected persistence hook replacing the TS `client.auth.set`.
///
/// Callers pass `None` to model a host without an auth setter — that maps to
/// the TS "client.auth.set is missing / not a function" branch (frozen
/// non-retryable failure, refresh never attempted).
pub type AuthSetterFn<'a> =
    &'a (dyn Fn(AuthPersistPayload) -> BoxFuture<'a, Result<(), BoxError>> + Send + Sync);

/// TS `shouldRefreshToken(auth, skewMs = 0)`.
///
/// - Non-OAuth auth → `true`.
/// - Empty access token → `true`.
/// - Otherwise `expires <= Date.now() + max(0, floor(skewMs))`.
pub fn should_refresh_token(auth: &Auth, skew_ms: f64) -> bool {
    should_refresh_token_at(auth, skew_ms, now_ms())
}

/// [`should_refresh_token`] against an explicit wall-clock instant (test seam
/// for the TS `Date.now()` mock).
pub fn should_refresh_token_at(auth: &Auth, skew_ms: f64, now_ms: i64) -> bool {
    let Auth::OAuth(details) = auth else {
        return true;
    };
    if details.access.is_empty() {
        return true;
    }
    let safe_skew_ms = if skew_ms.is_finite() {
        skew_ms.floor().max(0.0) as i64
    } else {
        // JS `Math.max(0, Math.floor(NaN))` is NaN and `expires <= NaN` is
        // false; treating non-finite skew as 0 keeps the comparison total
        // with the same "no early refresh" effect for valid tokens.
        0
    };
    details.expires <= now_ms.saturating_add(safe_skew_ms)
}

/// TS private `isRetryableRefreshFailure`.
fn is_retryable_refresh_failure(failure: &TokenFailure) -> bool {
    match failure.reason {
        Some(
            TokenFailureReason::NetworkError
            | TokenFailureReason::Unknown
            | TokenFailureReason::InvalidResponse,
        ) => true,
        Some(TokenFailureReason::MissingRefresh) => false,
        Some(TokenFailureReason::HttpError) => !matches!(
            failure.status_code,
            Some(code)
                if code == HTTP_STATUS.bad_request as i64
                    || code == HTTP_STATUS.unauthorized as i64
                    || code == HTTP_STATUS.forbidden as i64
        ),
        // TS `default:` — covers `timeout` and missing reasons.
        _ => false,
    }
}

/// TS private `isRetryableAuthSetterError`: `.code` (uppercased) in
/// {EAGAIN, EBUSY, EPERM}, or `.status === 429`, recursing into `.cause`.
///
/// The Rust error-chain walk covers the shapes a setter can realistically
/// surface: `io::Error` (errno via `fs_retry::code_of`), `CodedError`
/// (synthetic errno strings), `CodexError` (code/status accessors), and
/// `reqwest::Error` (HTTP status), then `source()` recursion (the `.cause`
/// analogue; Rust chains are finite so no self-reference guard is needed).
fn is_retryable_auth_setter_error(error: &(dyn StdError + 'static)) -> bool {
    const RETRYABLE_CODES: [&str; 3] = ["EAGAIN", "EBUSY", "EPERM"];

    let mut current: Option<&(dyn StdError + 'static)> = Some(error);
    while let Some(err) = current {
        if let Some(io_error) = err.downcast_ref::<std::io::Error>()
            && let Some(code) = code_of(io_error)
                && RETRYABLE_CODES.contains(&code.to_uppercase().as_str()) {
                    return true;
                }
        if let Some(coded) = err.downcast_ref::<CodedError>()
            && RETRYABLE_CODES.contains(&coded.code().to_uppercase().as_str()) {
                return true;
            }
        if let Some(codex) = err.downcast_ref::<CodexError>() {
            if RETRYABLE_CODES.contains(&codex.code().to_uppercase().as_str()) {
                return true;
            }
            if codex.status() == Some(HTTP_STATUS.too_many_requests) {
                return true;
            }
        }
        if let Some(request_error) = err.downcast_ref::<reqwest::Error>()
            && request_error.status().map(|status| status.as_u16())
                == Some(HTTP_STATUS.too_many_requests)
            {
                return true;
            }
        // `io::Error::source()` skips its custom inner error (it forwards the
        // INNER error's source), so step into `get_ref()` explicitly to keep
        // the whole `.cause` chain visible.
        current = match err.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            Some(inner) => Some(inner as &(dyn StdError + 'static)),
            None => err.source(),
        };
    }
    false
}

fn token_refresh_failed_error() -> CodexError {
    CodexError::auth(ERROR_MESSAGES.token_refresh_failed)
}

/// TS `refreshAndUpdateToken(currentAuth, client)` against the real refresh
/// queue (`cma_auth::refresh_queue::queued_refresh`).
///
/// On success `current_auth` is mutated in place (access/refresh/expires)
/// AFTER the setter future resolves, mirroring the TS mutation contract; the
/// TS "returns the same reference" contract is the `&mut` borrow itself.
pub async fn refresh_and_update_token(
    current_auth: &mut Auth,
    auth_setter: Option<AuthSetterFn<'_>>,
) -> Result<(), CodexError> {
    refresh_and_update_token_with(current_auth, auth_setter, |refresh_token| async move {
        cma_auth::refresh_queue::queued_refresh(&refresh_token).await
    })
    .await
}

/// [`refresh_and_update_token`] with an injectable refresh runner (the TS
/// tests' `queuedRefresh` mock seam). `run_refresh` receives the refresh
/// token — `""` for non-OAuth auth, exactly like the TS
/// `currentAuth.type === "oauth" ? currentAuth.refresh : ""`.
pub async fn refresh_and_update_token_with<F, Fut>(
    current_auth: &mut Auth,
    auth_setter: Option<AuthSetterFn<'_>>,
    run_refresh: F,
) -> Result<(), CodexError>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = TokenResult>,
{
    // TS: missing/malformed `client.auth.set` fails BEFORE any refresh work.
    let Some(auth_setter) = auth_setter else {
        return Err(token_refresh_failed_error().with_retryable(false));
    };

    let refresh_token = match current_auth {
        Auth::OAuth(details) => details.refresh.clone(),
        Auth::Other => String::new(),
    };
    let refresh_result = run_refresh(refresh_token).await;

    let success = match refresh_result {
        TokenResult::Failed(failure) => {
            let mut context = ErrorContext::new();
            if let Some(reason) = failure.reason {
                context.insert(
                    "refreshFailureReason".to_string(),
                    Value::String(reason.as_str().to_string()),
                );
            }
            if let Some(status_code) = failure.status_code {
                context.insert("statusCode".to_string(), Value::from(status_code));
            }
            return Err(token_refresh_failed_error()
                .with_retryable(is_retryable_refresh_failure(&failure))
                .with_context(context));
        }
        TokenResult::Success(success) => success,
    };

    // Persist FIRST (TS awaits client.auth.set before the in-place mutation).
    let payload = AuthPersistPayload {
        auth_type: "oauth",
        access: success.access.clone(),
        refresh: success.refresh.clone(),
        expires: success.expires,
        multi_account: true,
    };
    if let Err(error) = auth_setter(payload).await {
        let retryable = is_retryable_auth_setter_error(error.as_ref());
        return Err(token_refresh_failed_error()
            .with_retryable(retryable)
            .with_cause(error));
    }

    // THEN mutate the shared auth reference (OAuth arm only).
    if let Auth::OAuth(details) = current_auth {
        details.access = success.access;
        details.refresh = success.refresh;
        details.expires = success.expires;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::schemas::token::TokenSuccess;
    use std::sync::Mutex;

    fn oauth(access: &str, refresh: &str, expires: i64) -> Auth {
        Auth::OAuth(OAuthAuthDetails {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires,
        })
    }

    fn success_result(access: &str, refresh: &str, expires: i64) -> TokenResult {
        TokenResult::Success(TokenSuccess {
            access: access.to_string(),
            refresh: refresh.to_string(),
            expires,
            id_token: None,
            multi_account: None,
        })
    }

    fn failed_result(reason: TokenFailureReason, status_code: Option<i64>) -> TokenResult {
        TokenResult::Failed(TokenFailure {
            reason: Some(reason),
            status_code,
            message: None,
        })
    }

    // -- shouldRefreshToken -------------------------------------------------

    #[test]
    fn returns_true_for_non_oauth_auth() {
        assert!(should_refresh_token(&Auth::Other, 0.0));
    }

    #[test]
    fn returns_true_when_access_token_is_missing() {
        let auth = oauth("", "refresh-token", now_ms() + 1000);
        assert!(should_refresh_token(&auth, 0.0));
    }

    #[test]
    fn returns_true_when_token_is_expired() {
        let auth = oauth("access-token", "refresh-token", now_ms() - 1000);
        assert!(should_refresh_token(&auth, 0.0));
    }

    #[test]
    fn returns_false_for_valid_oauth_token() {
        let auth = oauth("access-token", "refresh-token", now_ms() + 10_000);
        assert!(!should_refresh_token(&auth, 0.0));
    }

    #[test]
    fn refreshes_token_early_when_within_skew_window() {
        let auth = oauth("access-token", "refresh-token", 1_500);
        assert!(should_refresh_token_at(&auth, 500.0, 1_000));
        assert!(!should_refresh_token_at(&auth, 400.0, 1_000));
        // Negative skew floors to 0.
        assert!(!should_refresh_token_at(&auth, -1.0, 1_000));
    }

    // -- refreshAndUpdateToken ----------------------------------------------

    #[tokio::test]
    async fn throws_when_client_auth_setter_is_missing() {
        let mut auth = oauth("old", "oldr", 0);
        let refresh_calls = Mutex::new(0u32);
        let error = refresh_and_update_token_with(&mut auth, None, |_token| {
            *refresh_calls.lock().unwrap() += 1;
            async { success_result("new", "newr", 123) }
        })
        .await
        .unwrap_err();

        assert_eq!(error.message(), ERROR_MESSAGES.token_refresh_failed);
        assert_eq!(error.retryable(), Some(false));
        // The refresh queue must NOT be touched when the setter is missing.
        assert_eq!(*refresh_calls.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn throws_retryable_auth_errors_for_transient_refresh_failures() {
        let mut auth = oauth("old", "bad", 0);
        let setter: AuthSetterFn<'_> = &|_payload| Box::pin(async { Ok(()) });
        let error = refresh_and_update_token_with(&mut auth, Some(setter), |_token| async {
            failed_result(TokenFailureReason::NetworkError, None)
        })
        .await
        .unwrap_err();

        assert_eq!(error.retryable(), Some(true));
        let context = error.context().unwrap();
        assert_eq!(
            context.get("refreshFailureReason"),
            Some(&Value::String("network_error".into()))
        );
    }

    #[tokio::test]
    async fn throws_terminal_auth_errors_for_explicit_invalid_refresh_responses() {
        let mut auth = oauth("old", "bad", 0);
        let setter: AuthSetterFn<'_> = &|_payload| Box::pin(async { Ok(()) });
        let error = refresh_and_update_token_with(&mut auth, Some(setter), |_token| async {
            failed_result(TokenFailureReason::HttpError, Some(401))
        })
        .await
        .unwrap_err();

        assert_eq!(error.retryable(), Some(false));
        let context = error.context().unwrap();
        assert_eq!(context.get("statusCode"), Some(&Value::from(401)));
    }

    #[tokio::test]
    async fn http_error_refresh_failures_stay_retryable_off_the_terminal_statuses() {
        for (status, expected) in [(400, false), (401, false), (403, false), (500, true)] {
            let mut auth = oauth("old", "bad", 0);
            let setter: AuthSetterFn<'_> = &|_payload| Box::pin(async { Ok(()) });
            let error =
                refresh_and_update_token_with(&mut auth, Some(setter), |_token| async move {
                    failed_result(TokenFailureReason::HttpError, Some(status))
                })
                .await
                .unwrap_err();
            assert_eq!(error.retryable(), Some(expected), "status {status}");
        }
    }

    #[tokio::test]
    async fn treats_missing_refresh_tokens_as_terminal_auth_errors() {
        let mut auth = oauth("old", "", 0);
        let setter: AuthSetterFn<'_> = &|_payload| Box::pin(async { Ok(()) });
        let error = refresh_and_update_token_with(&mut auth, Some(setter), |_token| async {
            failed_result(TokenFailureReason::MissingRefresh, None)
        })
        .await
        .unwrap_err();

        assert_eq!(error.retryable(), Some(false));
    }

    #[tokio::test]
    async fn timeout_reason_falls_to_the_non_retryable_default_branch() {
        let mut auth = oauth("old", "oldr", 0);
        let setter: AuthSetterFn<'_> = &|_payload| Box::pin(async { Ok(()) });
        let error = refresh_and_update_token_with(&mut auth, Some(setter), |_token| async {
            failed_result(TokenFailureReason::Timeout, None)
        })
        .await
        .unwrap_err();
        assert_eq!(error.retryable(), Some(false));
    }

    #[tokio::test]
    async fn updates_stored_auth_on_success() {
        let mut auth = oauth("old", "oldr", 0);
        let persisted: Mutex<Vec<AuthPersistPayload>> = Mutex::new(Vec::new());
        let setter: AuthSetterFn<'_> = &|payload| {
            persisted.lock().unwrap().push(payload);
            Box::pin(async { Ok(()) })
        };

        refresh_and_update_token_with(&mut auth, Some(setter), |token| async move {
            assert_eq!(token, "oldr");
            success_result("new", "newr", 123)
        })
        .await
        .unwrap();

        let calls = persisted.lock().unwrap();
        assert_eq!(
            calls.as_slice(),
            [AuthPersistPayload {
                auth_type: "oauth",
                access: "new".into(),
                refresh: "newr".into(),
                expires: 123,
                multi_account: true,
            }]
        );
        let details = auth.as_oauth().unwrap();
        assert_eq!(details.access, "new");
        assert_eq!(details.refresh, "newr");
        assert_eq!(details.expires, 123);
    }

    #[tokio::test]
    async fn throws_retryable_auth_errors_when_auth_persistence_fails() {
        let mut auth = oauth("old", "oldr", 0);
        let setter: AuthSetterFn<'_> = &|_payload| {
            Box::pin(
                async { Err(Box::new(CodedError::new("EBUSY", "persist failed")) as BoxError) },
            )
        };
        let error = refresh_and_update_token_with(&mut auth, Some(setter), |_token| async {
            success_result("new", "newr", 123)
        })
        .await
        .unwrap_err();

        assert_eq!(error.retryable(), Some(true));
        // Persist failed BEFORE mutation: the auth object must keep the old
        // values (mutation only happens after a successful setter await).
        let details = auth.as_oauth().unwrap();
        assert_eq!(details.access, "old");
        assert_eq!(details.refresh, "oldr");
    }

    #[tokio::test]
    async fn throws_terminal_auth_errors_when_auth_persistence_fails_permanently() {
        let mut auth = oauth("old", "oldr", 0);
        let setter: AuthSetterFn<'_> = &|_payload| {
            Box::pin(async {
                Err(Box::new(CodedError::new("EACCES", "persist failed")) as BoxError)
            })
        };
        let error = refresh_and_update_token_with(&mut auth, Some(setter), |_token| async {
            success_result("new", "newr", 123)
        })
        .await
        .unwrap_err();

        assert_eq!(error.retryable(), Some(false));
    }

    #[tokio::test]
    async fn setter_429_status_and_nested_causes_are_retryable() {
        // status === 429 detected through a nested cause chain (io::Error
        // wrapping a CodexApiError), matching the TS `.cause` recursion.
        let mut auth = oauth("old", "oldr", 0);
        let setter: AuthSetterFn<'_> = &|_payload| {
            Box::pin(async {
                let inner = CodexError::api("throttled", 429);
                let outer = std::io::Error::other(inner);
                Err(Box::new(outer) as BoxError)
            })
        };
        let error = refresh_and_update_token_with(&mut auth, Some(setter), |_token| async {
            success_result("new", "newr", 123)
        })
        .await
        .unwrap_err();
        assert_eq!(error.retryable(), Some(true));
    }

    #[tokio::test]
    async fn refreshes_using_non_oauth_auth_without_mutating_oauth_fields() {
        let mut auth = Auth::Other;
        let persisted: Mutex<u32> = Mutex::new(0);
        let setter: AuthSetterFn<'_> = &|_payload| {
            *persisted.lock().unwrap() += 1;
            Box::pin(async { Ok(()) })
        };

        refresh_and_update_token_with(&mut auth, Some(setter), |token| async move {
            // Non-OAuth auth refreshes with an empty refresh token.
            assert_eq!(token, "");
            success_result("new-access", "new-refresh", 60_000)
        })
        .await
        .unwrap();

        assert_eq!(*persisted.lock().unwrap(), 1);
        assert!(auth.as_oauth().is_none());
    }
}
