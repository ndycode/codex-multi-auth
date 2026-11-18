//! Port of `lib/fs-retry.ts` — generic transient-FS-error retry engine.
//!
//! Behavior source: specs/01-foundation.md §2.5, §6, §10.1, gotcha 19.
//!
//! Key contracts preserved from the TS source:
//! - An error retries only when it carries a string errno-style code contained
//!   in the retryable set (default [`FILE_RETRY_CODES`]); everything else is
//!   returned immediately.
//! - The backoff callback receives the **1-based index of the attempt that
//!   just failed** (first failure → `backoff(1)`).
//! - A computed delay of `0` retries immediately without sleeping.
//! - Once `max_attempts` is exhausted the error from the final attempt is
//!   returned unchanged; no delay is scheduled after the final attempt.
//! - `on_retry` fires after each retryable failure, before the delay, and is
//!   never invoked for the final failure.
//! - [`with_file_operation_retry`] = 6 attempts, base 25 ms doubling
//!   (25/50/100/200/400), jitter 0–19 ms, codes EBUSY/EPERM/EAGAIN/ENOTEMPTY/
//!   EACCES.
//!
//! Rust-specific notes:
//! - Node surfaces errno code STRINGS on every fs error; Rust's `io::Error`
//!   carries raw OS error numbers instead. [`code_of`] is the shim that maps
//!   raw Windows error codes (via the libuv translation table Node itself
//!   uses) and Unix errnos back to the Node code strings the retry sets are
//!   written against. Errors minted in-process with a synthetic code (e.g.
//!   `"ESTALE"`, `"ELOCKTIMEOUT"`) travel as a [`CodedError`] payload inside
//!   an `io::Error` (see [`io_error_with_code`]) and are recognized first.
//! - `with_retry_sync` uses `std::thread::sleep` for positive delays instead
//!   of the TS busy-wait loop (sanctioned by ARCHITECTURE.md §5.4; never call
//!   it inside async code — use [`with_retry`] there).

use std::fmt;
use std::io;
use std::time::Duration;

/// Transient filesystem error codes shared by the canned file-operation
/// policy. Exported because several call sites reuse the set verbatim.
pub const FILE_RETRY_CODES: &[&str] = &["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"];

const FILE_RETRY_MAX_ATTEMPTS: u32 = 6;
const FILE_RETRY_BASE_DELAY_MS: u64 = 25;
const FILE_RETRY_JITTER_MS: u64 = 20;

// ---------------------------------------------------------------------------
// Error-code extraction
// ---------------------------------------------------------------------------

/// Node-style errno code extraction. The TS engine retried any thrown value
/// carrying a string `code` property; Rust error types opt in by implementing
/// this trait. `cma-core` provides impls for [`std::io::Error`] (via
/// [`code_of`]) and [`CodedError`]; downstream crates implement it for their
/// own error enums where they mint synthetic codes.
pub trait HasErrorCode {
    /// The Node errno-style code string (e.g. `"EBUSY"`), if any.
    fn error_code(&self) -> Option<&str>;
}

impl HasErrorCode for io::Error {
    fn error_code(&self) -> Option<&str> {
        code_of(self)
    }
}

impl HasErrorCode for CodedError {
    fn error_code(&self) -> Option<&str> {
        Some(self.code)
    }
}

/// An error payload carrying an explicit Node-style code string. Used to mint
/// in-process errors (`"ESTALE"`, `"ELOCKTIMEOUT"`, `"EEMPTY"`, …) that flow
/// through [`with_retry`] with per-site retryable-code sets, exactly like the
/// ad-hoc `NodeJS.ErrnoException` objects the TS code created.
#[derive(Debug)]
pub struct CodedError {
    code: &'static str,
    message: String,
}

impl CodedError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for CodedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodedError {}

/// Wrap a synthetic code + message into an `io::Error` whose code is
/// recoverable through [`code_of`]. This is how the port represents the
/// TS pattern `Object.assign(new Error(msg), { code: "ESTALE" })`.
pub fn io_error_with_code(code: &'static str, message: impl Into<String>) -> io::Error {
    io::Error::other(CodedError::new(code, message))
}

/// Map an `io::Error` to the Node errno code string the TS retry sets are
/// written against.
///
/// Resolution order:
/// 1. An embedded [`CodedError`] payload (synthetic in-process codes) wins.
/// 2. The raw OS error number, translated per platform. The Windows table
///    follows libuv's `uv_translate_sys_error` (what Node actually reports):
///    `ERROR_SHARING_VIOLATION`/`ERROR_LOCK_VIOLATION` → `EBUSY`,
///    `ERROR_ACCESS_DENIED`/`ERROR_PRIVILEGE_NOT_HELD` → `EPERM`,
///    `ERROR_NOACCESS`/`ERROR_ELEVATION_REQUIRED`/`ERROR_CANT_ACCESS_FILE` →
///    `EACCES`, `ERROR_DIR_NOT_EMPTY` → `ENOTEMPTY`, etc.
/// 3. A conservative `io::ErrorKind` fallback for errors without a raw OS
///    number (custom errors minted by Rust std or other crates).
pub fn code_of(error: &io::Error) -> Option<&'static str> {
    if let Some(coded) = error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<CodedError>())
    {
        return Some(coded.code);
    }
    if let Some(code) = error.raw_os_error().and_then(code_for_raw_os_error) {
        return Some(code);
    }
    code_for_error_kind(error.kind())
}

#[cfg(windows)]
fn code_for_raw_os_error(raw: i32) -> Option<&'static str> {
    // Windows error codes translated per libuv's uv_translate_sys_error —
    // the exact mapping Node.js applies before exposing `error.code`.
    Some(match raw {
        2 | 3 | 123 => "ENOENT",      // FILE_NOT_FOUND / PATH_NOT_FOUND / INVALID_NAME
        4 => "EMFILE",                // TOO_MANY_OPEN_FILES
        5 | 1314 => "EPERM",          // ACCESS_DENIED / PRIVILEGE_NOT_HELD
        32 | 33 | 231 => "EBUSY",     // SHARING_VIOLATION / LOCK_VIOLATION / PIPE_BUSY
        145 => "ENOTEMPTY",           // DIR_NOT_EMPTY
        80 | 183 => "EEXIST",         // FILE_EXISTS / ALREADY_EXISTS
        998 | 740 | 1920 => "EACCES", // NOACCESS / ELEVATION_REQUIRED / CANT_ACCESS_FILE
        206 => "ENAMETOOLONG",        // FILENAME_EXCED_RANGE
        39 | 112 => "ENOSPC",         // HANDLE_DISK_FULL / DISK_FULL
        19 => "EROFS",                // WRITE_PROTECT
        267 => "ENOTDIR",             // ERROR_DIRECTORY
        87 => "EINVAL",               // INVALID_PARAMETER
        6 => "EBADF",                 // INVALID_HANDLE
        995 => "ECANCELED",           // OPERATION_ABORTED
        8 | 14 | 1816 => "ENOMEM",    // NOT_ENOUGH_MEMORY / OUTOFMEMORY / NOT_ENOUGH_QUOTA
        10013 => "EACCES",            // WSAEACCES
        10035 => "EAGAIN",            // WSAEWOULDBLOCK
        10048 => "EADDRINUSE",        // WSAEADDRINUSE
        10054 => "ECONNRESET",        // WSAECONNRESET
        10061 => "ECONNREFUSED",      // WSAECONNREFUSED
        _ => return None,
    })
}

#[cfg(unix)]
fn code_for_raw_os_error(raw: i32) -> Option<&'static str> {
    // if/else chain instead of match: some errno constants alias each other
    // on certain platforms (e.g. EAGAIN == EWOULDBLOCK on Linux) and duplicate
    // match arms would not compile.
    if raw == libc::EBUSY {
        Some("EBUSY")
    } else if raw == libc::EPERM {
        Some("EPERM")
    } else if raw == libc::EAGAIN || raw == libc::EWOULDBLOCK {
        Some("EAGAIN")
    } else if raw == libc::ENOTEMPTY {
        Some("ENOTEMPTY")
    } else if raw == libc::EACCES {
        Some("EACCES")
    } else if raw == libc::ENOENT {
        Some("ENOENT")
    } else if raw == libc::EEXIST {
        Some("EEXIST")
    } else if raw == libc::ESTALE {
        Some("ESTALE")
    } else if raw == libc::EISDIR {
        Some("EISDIR")
    } else if raw == libc::ENOTDIR {
        Some("ENOTDIR")
    } else if raw == libc::EINVAL {
        Some("EINVAL")
    } else if raw == libc::EMFILE {
        Some("EMFILE")
    } else if raw == libc::ENFILE {
        Some("ENFILE")
    } else if raw == libc::ENOSPC {
        Some("ENOSPC")
    } else if raw == libc::EROFS {
        Some("EROFS")
    } else if raw == libc::EXDEV {
        Some("EXDEV")
    } else if raw == libc::EIO {
        Some("EIO")
    } else if raw == libc::EPIPE {
        Some("EPIPE")
    } else if raw == libc::ELOOP {
        Some("ELOOP")
    } else if raw == libc::ENAMETOOLONG {
        Some("ENAMETOOLONG")
    } else if raw == libc::EINTR {
        Some("EINTR")
    } else if raw == libc::ETIMEDOUT {
        Some("ETIMEDOUT")
    } else if raw == libc::ECONNRESET {
        Some("ECONNRESET")
    } else if raw == libc::ECONNREFUSED {
        Some("ECONNREFUSED")
    } else if raw == libc::EADDRINUSE {
        Some("EADDRINUSE")
    } else if raw == libc::EBADF {
        Some("EBADF")
    } else if raw == libc::ENOMEM {
        Some("ENOMEM")
    } else if raw == libc::ECANCELED {
        Some("ECANCELED")
    } else if raw == libc::ETXTBSY {
        Some("ETXTBSY")
    } else if raw == libc::EMLINK {
        Some("EMLINK")
    } else if raw == libc::ENODEV {
        Some("ENODEV")
    } else {
        None
    }
}

fn code_for_error_kind(kind: io::ErrorKind) -> Option<&'static str> {
    use io::ErrorKind as K;
    Some(match kind {
        K::NotFound => "ENOENT",
        // Only reached for errors without a raw OS number; EACCES is the
        // common POSIX source of PermissionDenied. Real Windows
        // ERROR_ACCESS_DENIED errors carry a raw code and map to EPERM above.
        K::PermissionDenied => "EACCES",
        K::AlreadyExists => "EEXIST",
        K::WouldBlock => "EAGAIN",
        K::InvalidInput | K::InvalidData => "EINVAL",
        K::TimedOut => "ETIMEDOUT",
        K::Interrupted => "EINTR",
        K::BrokenPipe => "EPIPE",
        K::DirectoryNotEmpty => "ENOTEMPTY",
        K::IsADirectory => "EISDIR",
        K::NotADirectory => "ENOTDIR",
        K::ReadOnlyFilesystem => "EROFS",
        K::ResourceBusy => "EBUSY",
        K::StaleNetworkFileHandle => "ESTALE",
        K::StorageFull => "ENOSPC",
        // (ErrorKind::FilesystemLoop is unstable — ELOOP is covered by the
        // raw-OS-error mapping above, which every real fs error carries.)
        K::ExecutableFileBusy => "ETXTBSY",
        K::TooManyLinks => "EMLINK",
        K::CrossesDevices => "EXDEV",
        K::AddrInUse => "EADDRINUSE",
        K::ConnectionRefused => "ECONNREFUSED",
        K::ConnectionReset => "ECONNRESET",
        _ => return None,
    })
}

/// `shouldRetryFileOperation` — true when the error carries a code in
/// [`FILE_RETRY_CODES`].
pub fn should_retry_file_operation<E: HasErrorCode + ?Sized>(error: &E) -> bool {
    match error.error_code() {
        Some(code) => FILE_RETRY_CODES.contains(&code),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Retry options
// ---------------------------------------------------------------------------

/// Delay schedule: either a fixed number of milliseconds or a function of the
/// **1-based index of the attempt that just failed** (delay after the first
/// failure is `f(1)`).
pub enum Backoff {
    Fixed(u64),
    Custom(Box<dyn Fn(u32) -> u64 + Send + Sync>),
}

impl Backoff {
    pub fn from_fn(f: impl Fn(u32) -> u64 + Send + Sync + 'static) -> Self {
        Backoff::Custom(Box::new(f))
    }

    fn compute(&self, failed_attempt: u32) -> u64 {
        match self {
            Backoff::Fixed(ms) => *ms,
            Backoff::Custom(f) => f(failed_attempt),
        }
    }
}

impl fmt::Debug for Backoff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Backoff::Fixed(ms) => f.debug_tuple("Fixed").field(ms).finish(),
            Backoff::Custom(_) => f.write_str("Custom(..)"),
        }
    }
}

/// Options for [`with_retry`] / [`with_retry_sync`]. Deliberately wide enough
/// to express every hand-rolled file-retry loop in the codebase: per-site
/// attempt counts, exponential/linear backoff schedules, optional jitter, and
/// per-site retryable code sets are all preserved exactly.
pub struct RetryOptions<E = io::Error> {
    /// Total number of attempts (including the first one). Must be >= 1.
    pub max_attempts: u32,
    /// Delay before the next attempt (see [`Backoff`]). A computed delay of 0
    /// retries immediately without sleeping.
    pub backoff_ms: Backoff,
    /// Optional jitter: adds `floor(random * jitter_ms)` (i.e. a uniform draw
    /// from `0..jitter_ms`) to each computed backoff delay.
    pub jitter_ms: Option<u64>,
    /// Error codes considered transient. `None` = [`FILE_RETRY_CODES`]. An
    /// error retries only when it carries a code in this set; everything else
    /// is returned immediately.
    pub retryable_codes: Option<Vec<&'static str>>,
    /// Invoked after each retryable failure (with the 1-based attempt index),
    /// before the backoff delay. Never invoked for the final failure.
    pub on_retry: Option<OnRetry<E>>,
}

/// Callback invoked after each retryable failure (error, 1-based attempt index).
pub type OnRetry<E> = Box<dyn FnMut(&E, u32) + Send>;

impl<E> RetryOptions<E> {
    pub fn new(max_attempts: u32, backoff_ms: Backoff) -> Self {
        Self {
            max_attempts,
            backoff_ms,
            jitter_ms: None,
            retryable_codes: None,
            on_retry: None,
        }
    }

    /// Convenience for a fixed backoff schedule.
    pub fn fixed(max_attempts: u32, backoff_ms: u64) -> Self {
        Self::new(max_attempts, Backoff::Fixed(backoff_ms))
    }

    pub fn with_codes(mut self, codes: &[&'static str]) -> Self {
        self.retryable_codes = Some(codes.to_vec());
        self
    }

    pub fn with_jitter(mut self, jitter_ms: u64) -> Self {
        self.jitter_ms = Some(jitter_ms);
        self
    }

    pub fn with_on_retry(mut self, f: impl FnMut(&E, u32) + Send + 'static) -> Self {
        self.on_retry = Some(Box::new(f));
        self
    }
}

impl<E> fmt::Debug for RetryOptions<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RetryOptions")
            .field("max_attempts", &self.max_attempts)
            .field("backoff_ms", &self.backoff_ms)
            .field("jitter_ms", &self.jitter_ms)
            .field("retryable_codes", &self.retryable_codes)
            .field("on_retry", &self.on_retry.as_ref().map(|_| "FnMut(..)"))
            .finish()
    }
}

fn is_retryable_error<E: HasErrorCode>(
    error: &E,
    retryable_codes: Option<&[&'static str]>,
) -> bool {
    let Some(code) = error.error_code() else {
        return false;
    };
    match retryable_codes {
        Some(codes) => codes.contains(&code),
        None => FILE_RETRY_CODES.contains(&code),
    }
}

fn compute_delay_ms<E>(options: &RetryOptions<E>, failed_attempt: u32) -> u64 {
    let base = options.backoff_ms.compute(failed_attempt);
    let jitter = match options.jitter_ms {
        Some(jitter_ms) if jitter_ms > 0 => rand::Rng::random_range(&mut rand::rng(), 0..jitter_ms),
        _ => 0,
    };
    base.saturating_add(jitter)
}

// ---------------------------------------------------------------------------
// Retry engines
// ---------------------------------------------------------------------------

/// Run `operation`, retrying on transient error codes with a per-call backoff
/// schedule. Non-retryable errors are returned immediately; once
/// `max_attempts` is exhausted the error from the final attempt is returned
/// unchanged. No delay is scheduled after the final attempt.
pub async fn with_retry<T, E, F, Fut>(mut operation: F, mut options: RetryOptions<E>) -> Result<T, E>
where
    E: HasErrorCode,
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let mut attempt: u32 = 1;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !is_retryable_error(&error, options.retryable_codes.as_deref())
                    || attempt >= options.max_attempts
                {
                    return Err(error);
                }
                if let Some(on_retry) = options.on_retry.as_mut() {
                    on_retry(&error, attempt);
                }
                let delay_ms = compute_delay_ms(&options, attempt);
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                attempt += 1;
            }
        }
    }
}

/// Synchronous variant of [`with_retry`] for callers that cannot await.
/// Positive delays use `std::thread::sleep` (the TS busy-wait is replaced per
/// ARCHITECTURE.md §5.4); a computed delay of 0 retries immediately. Never
/// call this inside async code — use [`with_retry`] there.
pub fn with_retry_sync<T, E, F>(mut operation: F, mut options: RetryOptions<E>) -> Result<T, E>
where
    E: HasErrorCode,
    F: FnMut() -> Result<T, E>,
{
    let mut attempt: u32 = 1;
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !is_retryable_error(&error, options.retryable_codes.as_deref())
                    || attempt >= options.max_attempts
                {
                    return Err(error);
                }
                if let Some(on_retry) = options.on_retry.as_mut() {
                    on_retry(&error, attempt);
                }
                let delay_ms = compute_delay_ms(&options, attempt);
                if delay_ms > 0 {
                    std::thread::sleep(Duration::from_millis(delay_ms));
                }
                attempt += 1;
            }
        }
    }
}

/// The canned shared file-operation policy: 6 attempts, 25 ms exponential
/// backoff (25/50/100/200/400) plus 0–19 ms jitter, retrying only
/// [`FILE_RETRY_CODES`].
pub async fn with_file_operation_retry<T, E, F, Fut>(operation: F) -> Result<T, E>
where
    E: HasErrorCode,
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    with_retry(
        operation,
        RetryOptions {
            max_attempts: FILE_RETRY_MAX_ATTEMPTS,
            backoff_ms: Backoff::from_fn(|attempt| {
                FILE_RETRY_BASE_DELAY_MS
                    .saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)))
            }),
            jitter_ms: Some(FILE_RETRY_JITTER_MS),
            retryable_codes: Some(FILE_RETRY_CODES.to_vec()),
            on_retry: None,
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// Tests (ported from test/fs-retry.test.ts)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    fn errno_error(code: &'static str) -> io::Error {
        io_error_with_code(code, code)
    }

    #[tokio::test]
    async fn returns_result_on_first_try_success_without_retrying() {
        let calls = AtomicU32::new(0);
        let result: Result<&str, io::Error> = with_retry(
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Ok("ok") }
            },
            RetryOptions::fixed(5, 10),
        )
        .await;
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retries_retryable_codes_and_resolves_once_operation_succeeds() {
        let calls = AtomicU32::new(0);
        let result: Result<&str, io::Error> = with_retry(
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    match n {
                        0 => Err(errno_error("EBUSY")),
                        1 => Err(errno_error("EPERM")),
                        _ => Ok("done"),
                    }
                }
            },
            RetryOptions::fixed(5, 0),
        )
        .await;
        assert_eq!(result.unwrap(), "done");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn rethrows_last_error_once_max_attempts_is_exhausted() {
        let calls = AtomicU32::new(0);
        let result: Result<(), io::Error> = with_retry(
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    match n {
                        0 => Err(io_error_with_code("EBUSY", "first failure")),
                        1 => Err(io_error_with_code("EBUSY", "middle failure")),
                        _ => Err(io_error_with_code("EPERM", "last failure")),
                    }
                }
            },
            RetryOptions::fixed(3, 0),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(code_of(&error), Some("EPERM"));
        assert!(error.to_string().contains("last failure"));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn throws_immediately_on_a_non_retryable_code() {
        let calls = AtomicU32::new(0);
        let result: Result<(), io::Error> = with_retry(
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(errno_error("ENOENT")) }
            },
            RetryOptions::fixed(5, 10),
        )
        .await;
        assert_eq!(code_of(&result.unwrap_err()), Some("ENOENT"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn throws_immediately_on_errors_without_a_code() {
        let calls = AtomicU32::new(0);
        let result: Result<(), io::Error> = with_retry(
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(io::Error::other("no code at all")) }
            },
            RetryOptions::fixed(5, 10),
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(code_of(&error), None);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn honors_custom_retryable_codes_and_rejects_default_codes() {
        // EBUSY is NOT retryable when the per-site set is ["ESTALE"].
        let calls = AtomicU32::new(0);
        let result: Result<(), io::Error> = with_retry(
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(errno_error("EBUSY")) }
            },
            RetryOptions::fixed(5, 0).with_codes(&["ESTALE"]),
        )
        .await;
        assert_eq!(code_of(&result.unwrap_err()), Some("EBUSY"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // ESTALE recovers.
        let calls = AtomicU32::new(0);
        let result: Result<&str, io::Error> = with_retry(
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(errno_error("ESTALE"))
                    } else {
                        Ok("recovered")
                    }
                }
            },
            RetryOptions::fixed(3, 0).with_codes(&["ESTALE"]),
        )
        .await;
        assert_eq!(result.unwrap(), "recovered");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn defaults_retryable_codes_to_file_retry_codes() {
        for code in FILE_RETRY_CODES {
            let calls = AtomicU32::new(0);
            let result: Result<&str, io::Error> = with_retry(
                || {
                    let n = calls.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if n == 0 {
                            Err(io_error_with_code(code, *code))
                        } else {
                            Ok("ok")
                        }
                    }
                },
                RetryOptions::fixed(2, 0),
            )
            .await;
            assert_eq!(result.unwrap(), "ok", "code {code}");
            assert_eq!(calls.load(Ordering::SeqCst), 2, "code {code}");
        }
    }

    #[tokio::test]
    async fn invokes_on_retry_for_each_retryable_failure_but_not_the_final_one() {
        let calls = AtomicU32::new(0);
        let seen: Arc<Mutex<Vec<(String, u32)>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_cb = Arc::clone(&seen);
        let result: Result<(), io::Error> = with_retry(
            || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    match n {
                        0 => Err(io_error_with_code("EBUSY", "first")),
                        1 => Err(io_error_with_code("EPERM", "second")),
                        _ => Err(io_error_with_code("EACCES", "last")),
                    }
                }
            },
            RetryOptions::fixed(3, 0).with_on_retry(move |error: &io::Error, attempt| {
                seen_cb
                    .lock()
                    .unwrap()
                    .push((code_of(error).unwrap_or("?").to_string(), attempt));
            }),
        )
        .await;
        assert_eq!(code_of(&result.unwrap_err()), Some("EACCES"));
        let seen = seen.lock().unwrap();
        assert_eq!(
            *seen,
            vec![("EBUSY".to_string(), 1), ("EPERM".to_string(), 2)]
        );
    }

    #[test]
    fn sync_returns_result_on_first_try_success() {
        let calls = Cell::new(0u32);
        let result: Result<i32, io::Error> = with_retry_sync(
            || {
                calls.set(calls.get() + 1);
                Ok(42)
            },
            RetryOptions::fixed(4, 0),
        );
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn sync_retries_retryable_code_and_returns_once_operation_succeeds() {
        let calls = Cell::new(0u32);
        let result: Result<&str, io::Error> = with_retry_sync(
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Err(errno_error("EBUSY"))
                } else {
                    Ok("done")
                }
            },
            RetryOptions::fixed(4, 1).with_codes(&["EBUSY"]),
        );
        assert_eq!(result.unwrap(), "done");
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn sync_rethrows_last_error_once_max_attempts_is_exhausted() {
        let calls = Cell::new(0u32);
        let result: Result<(), io::Error> = with_retry_sync(
            || {
                calls.set(calls.get() + 1);
                Err(io_error_with_code("EPERM", "still locked"))
            },
            RetryOptions::fixed(4, 0),
        );
        let error = result.unwrap_err();
        assert_eq!(code_of(&error), Some("EPERM"));
        assert!(error.to_string().contains("still locked"));
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn sync_throws_immediately_on_a_non_retryable_code() {
        let calls = Cell::new(0u32);
        let result: Result<(), io::Error> = with_retry_sync(
            || {
                calls.set(calls.get() + 1);
                Err(errno_error("ENOENT"))
            },
            RetryOptions::fixed(4, 0),
        );
        assert_eq!(code_of(&result.unwrap_err()), Some("ENOENT"));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn sync_invokes_on_retry_with_failure_and_one_based_attempt_index() {
        let calls = Cell::new(0u32);
        let seen: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_cb = Arc::clone(&seen);
        let result: Result<&str, io::Error> = with_retry_sync(
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Err(errno_error("EBUSY"))
                } else {
                    Ok("ok")
                }
            },
            RetryOptions::fixed(2, 0).with_on_retry(move |_error: &io::Error, attempt| {
                seen_cb.lock().unwrap().push(attempt);
            }),
        );
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(*seen.lock().unwrap(), vec![1]);
    }

    #[tokio::test]
    async fn file_operation_retry_makes_six_attempts_on_persistent_busy() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_op = Arc::clone(&calls);
        let result: Result<(), io::Error> = with_file_operation_retry(move || {
            calls_op.fetch_add(1, Ordering::SeqCst);
            async { Err(io_error_with_code("EBUSY", "always locked")) }
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(code_of(&error), Some("EBUSY"));
        assert!(error.to_string().contains("always locked"));
        assert_eq!(calls.load(Ordering::SeqCst), 6);
    }

    #[tokio::test]
    async fn file_operation_retry_throws_immediately_on_non_retryable_code() {
        let calls = Arc::new(AtomicU32::new(0));
        let calls_op = Arc::clone(&calls);
        let result: Result<(), io::Error> = with_file_operation_retry(move || {
            calls_op.fetch_add(1, Ordering::SeqCst);
            async { Err(errno_error("ENOENT")) }
        })
        .await;
        assert_eq!(code_of(&result.unwrap_err()), Some("ENOENT"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn treats_every_transient_lock_code_as_retryable() {
        for code in ["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"] {
            let stable = FILE_RETRY_CODES
                .iter()
                .copied()
                .find(|c| *c == code)
                .expect("code present in FILE_RETRY_CODES");
            let error = io_error_with_code(stable, code);
            assert!(should_retry_file_operation(&error), "{code}");
        }
    }

    #[test]
    fn does_not_retry_non_transient_errors() {
        for code in ["ENOENT", "EISDIR", "EINVAL", "EROFS"] {
            let stable: &'static str = match code {
                "ENOENT" => "ENOENT",
                "EISDIR" => "EISDIR",
                "EINVAL" => "EINVAL",
                _ => "EROFS",
            };
            let error = io_error_with_code(stable, code);
            assert!(!should_retry_file_operation(&error), "{code}");
        }
    }

    #[test]
    fn returns_false_for_errors_without_a_code() {
        let error = io::Error::other("no code");
        assert!(!should_retry_file_operation(&error));
    }

    #[test]
    fn code_of_prefers_embedded_coded_error_payload() {
        let error = io_error_with_code("ESTALE", "settings changed on disk");
        assert_eq!(code_of(&error), Some("ESTALE"));
    }

    #[test]
    fn code_of_falls_back_to_error_kind_for_custom_errors() {
        assert_eq!(
            code_of(&io::Error::new(io::ErrorKind::NotFound, "gone")),
            Some("ENOENT")
        );
        assert_eq!(
            code_of(&io::Error::new(io::ErrorKind::AlreadyExists, "there")),
            Some("EEXIST")
        );
        assert_eq!(code_of(&io::Error::other("mystery")), None);
    }

    #[cfg(windows)]
    #[test]
    fn code_of_maps_windows_raw_os_errors_to_node_codes() {
        // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION -> EBUSY
        assert_eq!(code_of(&io::Error::from_raw_os_error(32)), Some("EBUSY"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(33)), Some("EBUSY"));
        // ERROR_ACCESS_DENIED -> EPERM (libuv/Node parity)
        assert_eq!(code_of(&io::Error::from_raw_os_error(5)), Some("EPERM"));
        // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND -> ENOENT
        assert_eq!(code_of(&io::Error::from_raw_os_error(2)), Some("ENOENT"));
        assert_eq!(code_of(&io::Error::from_raw_os_error(3)), Some("ENOENT"));
        // ERROR_DIR_NOT_EMPTY -> ENOTEMPTY
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(145)),
            Some("ENOTEMPTY")
        );
        // ERROR_ALREADY_EXISTS -> EEXIST
        assert_eq!(code_of(&io::Error::from_raw_os_error(183)), Some("EEXIST"));
        // ERROR_CANT_ACCESS_FILE -> EACCES
        assert_eq!(code_of(&io::Error::from_raw_os_error(1920)), Some("EACCES"));
    }

    #[cfg(unix)]
    #[test]
    fn code_of_maps_unix_errnos_to_node_codes() {
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(libc::EBUSY)),
            Some("EBUSY")
        );
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(libc::EPERM)),
            Some("EPERM")
        );
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(libc::EACCES)),
            Some("EACCES")
        );
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(libc::ENOTEMPTY)),
            Some("ENOTEMPTY")
        );
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(libc::ENOENT)),
            Some("ENOENT")
        );
        assert_eq!(
            code_of(&io::Error::from_raw_os_error(libc::ESTALE)),
            Some("ESTALE")
        );
    }
}
