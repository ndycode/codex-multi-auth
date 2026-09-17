//! Port of `lib/storage/save-retry.ts` — retry wrapper for account-storage
//! writes used by `lib/accounts.ts` / codex-manager callers.
//!
//! Behavior source: spec 02 §11 / §16: up to 4 TOTAL attempts, retrying only
//! codes {EBUSY, EPERM}, delay `10·2^attempt` ms with a 0-based attempt
//! counter (10/20/40 between the four attempts).

use std::time::Duration;

use cma_core::errors::CodexError;

const RETRYABLE_STORAGE_WRITE_CODES: [&str; 2] = ["EBUSY", "EPERM"];

/// `isRetryableStorageWriteError(error)` — code ∈ {EBUSY, EPERM}. The TS
/// helper read `error.code`; the port takes the code string (CodexError's
/// `code()` for StorageErrors carries the errno).
pub fn is_retryable_storage_write_code(code: &str) -> bool {
    RETRYABLE_STORAGE_WRITE_CODES.contains(&code)
}

/// `isRetryableStorageWriteError` over the storage error type.
pub fn is_retryable_storage_write_error(error: &CodexError) -> bool {
    is_retryable_storage_write_code(error.code())
}

/// `saveAccountsWithRetry(storage, saveAccounts)` — generic over the save
/// callable so tests and the account manager can inject their own persist.
pub async fn save_accounts_with_retry_via<S, F, Fut>(
    storage: &S,
    mut save_accounts: F,
) -> Result<(), CodexError>
where
    F: FnMut(&S) -> Fut,
    Fut: Future<Output = Result<(), CodexError>>,
{
    let mut attempt: u32 = 0;
    loop {
        match save_accounts(storage).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !is_retryable_storage_write_error(&error) || attempt >= 3 {
                    return Err(error);
                }
                let delay_ms = 10u64.saturating_mul(2u64.saturating_pow(attempt));
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                attempt += 1;
            }
        }
    }
}

/// Convenience wrapper bound to the real `saveAccounts`.
pub async fn save_accounts_with_retry(
    storage: &crate::public_types::AccountStorageV3,
) -> Result<(), CodexError> {
    // The generic runner's future type cannot borrow from the closure
    // argument, so clone per attempt (retries are rare; the pipeline clones
    // the storage for the WAL entry anyway).
    save_accounts_with_retry_via(storage, |s| {
        let s = s.clone();
        async move { crate::save::save_accounts(&s).await }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn storage_error(code: &str) -> CodexError {
        CodexError::storage("Failed to save accounts: x", code, "/x/a.json", "hint", None)
    }

    #[test]
    fn retryable_codes_are_ebusy_and_eperm_only() {
        assert!(is_retryable_storage_write_code("EBUSY"));
        assert!(is_retryable_storage_write_code("EPERM"));
        assert!(!is_retryable_storage_write_code("EACCES"));
        assert!(!is_retryable_storage_write_code("ENOENT"));
        assert!(!is_retryable_storage_write_code("UNKNOWN"));
        assert!(is_retryable_storage_write_error(&storage_error("EBUSY")));
        assert!(!is_retryable_storage_write_error(&storage_error("EINVALID")));
    }

    #[tokio::test]
    async fn retries_until_success_within_four_attempts() {
        let calls = AtomicU32::new(0);
        let result = save_accounts_with_retry_via(&(), |_| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if n < 2 {
                    Err(storage_error("EBUSY"))
                } else {
                    Ok(())
                }
            }
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn gives_up_after_four_total_attempts() {
        let calls = AtomicU32::new(0);
        let result = save_accounts_with_retry_via(&(), |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(storage_error("EPERM")) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn non_retryable_errors_fail_immediately() {
        let calls = AtomicU32::new(0);
        let result = save_accounts_with_retry_via(&(), |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(storage_error("ENOSPC")) }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
