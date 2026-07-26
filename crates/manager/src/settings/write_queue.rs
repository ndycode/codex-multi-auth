//! Port of `lib/codex-manager/settings-write-queue.ts` — per-path serialized
//! settings writes with a bounded retry loop for Windows share-violation
//! errno codes and HTTP-ish 429 hints.
//!
//! Contracts (spec 09 §5.5):
//! - `SETTINGS_WRITE_MAX_ATTEMPTS = 4`, base delay 50 ms, ×2 exponential,
//!   capped at 30 000 ms; `retryAfterMs`-style hints are honored, rounded and
//!   clamped into `[10, 30_000]`.
//! - Retryable = status 429 (from `status`/`statusCode`) OR errno code in
//!   {EBUSY, EPERM, EAGAIN, ENOTEMPTY, EACCES}.
//! - Per-`pathKey` FIFO: a new task waits for every previously queued task on
//!   the same key (even failed ones); different keys proceed independently;
//!   every retry of a task stays ahead of the next queued task.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

pub const SETTINGS_WRITE_MAX_ATTEMPTS: u32 = 4;
pub const SETTINGS_WRITE_BASE_DELAY_MS: i64 = 50;
pub const SETTINGS_WRITE_MAX_DELAY_MS: i64 = 30_000;
pub const RETRYABLE_SETTINGS_WRITE_CODES: [&str; 5] =
    ["EBUSY", "EPERM", "EAGAIN", "ENOTEMPTY", "EACCES"];

/// Error introspection surface mirroring the duck-typed TS checks over
/// `status`/`statusCode`, `code`, and the four `retryAfter*` spellings
/// (already collapsed to one accessor here — TS coalesces them in order).
pub trait SettingsWriteErrorLike {
    fn status_code(&self) -> Option<i64> {
        None
    }
    fn errno_code(&self) -> Option<String> {
        None
    }
    fn retry_after_ms(&self) -> Option<f64> {
        None
    }
}

/// Concrete error carrier used by the settings persistence call sites (and
/// tests): message plus the retry-relevant metadata the TS duck-typing read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SettingsWriteError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<i64>,
    pub retry_after_ms: Option<f64>,
}

impl SettingsWriteError {
    pub fn message(message: impl Into<String>) -> Self {
        SettingsWriteError {
            message: message.into(),
            ..Default::default()
        }
    }

    pub fn with_code(message: impl Into<String>, code: impl Into<String>) -> Self {
        SettingsWriteError {
            message: message.into(),
            code: Some(code.into()),
            ..Default::default()
        }
    }

    pub fn from_io(error: &std::io::Error) -> Self {
        SettingsWriteError {
            message: error.to_string(),
            code: cma_core::fs_retry::code_of(error).map(str::to_string),
            status: None,
            retry_after_ms: None,
        }
    }
}

impl std::fmt::Display for SettingsWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SettingsWriteError {}

impl SettingsWriteErrorLike for SettingsWriteError {
    fn status_code(&self) -> Option<i64> {
        self.status
    }
    fn errno_code(&self) -> Option<String> {
        self.code.clone()
    }
    fn retry_after_ms(&self) -> Option<f64> {
        self.retry_after_ms
    }
}

impl SettingsWriteErrorLike for std::io::Error {
    fn errno_code(&self) -> Option<String> {
        cma_core::fs_retry::code_of(self).map(str::to_string)
    }
}

/// `isRetryableSettingsWriteError`.
pub fn is_retryable_settings_write_error<E: SettingsWriteErrorLike + ?Sized>(error: &E) -> bool {
    if error.status_code() == Some(429) {
        return true;
    }
    match error.errno_code() {
        Some(code) => RETRYABLE_SETTINGS_WRITE_CODES.contains(&code.as_str()),
        None => false,
    }
}

/// `resolveRetryDelayMs` — retry-after hint (rounded, clamped `[10, 30_000]`)
/// wins; else `min(30_000, 50 * 2^attempt)` with `attempt` 0-based.
pub fn resolve_retry_delay_ms<E: SettingsWriteErrorLike + ?Sized>(error: &E, attempt: u32) -> i64 {
    if let Some(retry_after_ms) = error.retry_after_ms()
        && retry_after_ms.is_finite() && retry_after_ms > 0.0 {
            let rounded = retry_after_ms.round() as i64;
            return rounded.clamp(10, SETTINGS_WRITE_MAX_DELAY_MS);
        }
    let exp = SETTINGS_WRITE_BASE_DELAY_MS.saturating_mul(1_i64 << attempt.min(62));
    exp.min(SETTINGS_WRITE_MAX_DELAY_MS)
}

// ---------------------------------------------------------------------------
// Per-path FIFO queue
// ---------------------------------------------------------------------------

// TS keeps a promise-chain tail per pathKey. A fair (FIFO) `tokio::sync::Mutex`
// per key reproduces the semantics: submitters queue in arrival order, a
// failed predecessor never blocks the successor, and the whole retry loop of
// one task runs while holding the key. The map entry is dropped once no other
// waiter holds a reference (TS deletes the tail when it is still current).
fn queues() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static QUEUES: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    QUEUES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn queue_for(path_key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = queues().lock().expect("settings write queue poisoned");
    map.entry(path_key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn release_queue(path_key: &str, queue: &Arc<tokio::sync::Mutex<()>>) {
    let mut map = queues().lock().expect("settings write queue poisoned");
    if let Some(current) = map.get(path_key) {
        // Two strong refs (map + our local clone) means nobody else is
        // waiting; mirror the TS "delete only when still the tail" cleanup.
        if Arc::ptr_eq(current, queue) && Arc::strong_count(queue) <= 2 {
            map.remove(path_key);
        }
    }
}

/// `withQueuedRetry(pathKey, task, { sleep })` — the module's only real
/// export. The sleep function is injected exactly like the TS deps object so
/// tests can record delays without waiting.
pub async fn with_queued_retry<T, E, Task, TaskFut, Sleep, SleepFut>(
    path_key: &str,
    mut task: Task,
    sleep: Sleep,
) -> Result<T, E>
where
    E: SettingsWriteErrorLike,
    Task: FnMut() -> TaskFut,
    TaskFut: Future<Output = Result<T, E>>,
    Sleep: Fn(i64) -> SleepFut,
    SleepFut: Future<Output = ()>,
{
    let queue = queue_for(path_key);
    let guard = queue.lock().await;

    let mut last_error: Option<E> = None;
    let mut attempt: u32 = 0;
    let result = loop {
        if attempt >= SETTINGS_WRITE_MAX_ATTEMPTS {
            break Err(last_error.expect("retry loop always records an error"));
        }
        match task().await {
            Ok(value) => break Ok(value),
            Err(error) => {
                if !is_retryable_settings_write_error(&error) {
                    break Err(error);
                }
                if attempt >= SETTINGS_WRITE_MAX_ATTEMPTS - 1 {
                    break Err(error);
                }
                let delay = resolve_retry_delay_ms(&error, attempt);
                last_error = Some(error);
                sleep(delay).await;
            }
        }
        attempt += 1;
    };

    drop(guard);
    release_queue(path_key, &queue);
    result
}

/// Default sleep implementation for production call sites (`lib/utils.sleep`).
pub async fn default_sleep(ms: i64) {
    if ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn recording_sleep() -> (
        Rc<RefCell<Vec<i64>>>,
        impl Fn(i64) -> std::future::Ready<()>,
    ) {
        let delays: Rc<RefCell<Vec<i64>>> = Rc::new(RefCell::new(Vec::new()));
        let recorded = Rc::clone(&delays);
        (delays, move |ms: i64| {
            recorded.borrow_mut().push(ms);
            std::future::ready(())
        })
    }

    #[tokio::test]
    async fn returns_the_task_result_without_sleeping_on_first_try_success() {
        let (delays, sleep) = recording_sleep();
        let result: Result<i32, SettingsWriteError> =
            with_queued_retry("wq-first-try", || async { Ok(41) }, sleep).await;
        assert_eq!(result.unwrap(), 41);
        assert!(delays.borrow().is_empty());
    }

    #[tokio::test]
    async fn retries_windows_sharing_violations_with_exponential_backoff() {
        let (delays, sleep) = recording_sleep();
        let attempts = AtomicUsize::new(0);
        let result: Result<&str, SettingsWriteError> = with_queued_retry(
            "wq-ebusy",
            || {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n < 3 {
                        Err(SettingsWriteError::with_code("resource busy", "EBUSY"))
                    } else {
                        Ok("saved")
                    }
                }
            },
            sleep,
        )
        .await;
        assert_eq!(result.unwrap(), "saved");
        assert_eq!(attempts.load(Ordering::SeqCst), 4);
        // 50 * 2^attempt for attempts 0..=2.
        assert_eq!(*delays.borrow(), vec![50, 100, 200]);
    }

    #[tokio::test]
    async fn honors_a_429_retry_after_hint_clamped_into_the_sane_range() {
        let (delays, sleep) = recording_sleep();
        let attempts = AtomicUsize::new(0);
        let result: Result<&str, SettingsWriteError> = with_queued_retry(
            "wq-429",
            || {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    match n {
                        0 => Err(SettingsWriteError {
                            message: "throttled".into(),
                            status: Some(429),
                            retry_after_ms: Some(120_000.0), // above the cap
                            ..Default::default()
                        }),
                        1 => Err(SettingsWriteError {
                            message: "throttled".into(),
                            status: Some(429),
                            retry_after_ms: Some(3.0), // below the floor
                            ..Default::default()
                        }),
                        _ => Ok("saved"),
                    }
                }
            },
            sleep,
        )
        .await;
        assert_eq!(result.unwrap(), "saved");
        assert_eq!(*delays.borrow(), vec![30_000, 10]);
    }

    #[tokio::test]
    async fn rethrows_non_retryable_errors_immediately() {
        let (delays, sleep) = recording_sleep();
        let attempts = AtomicUsize::new(0);
        let result: Result<(), SettingsWriteError> = with_queued_retry(
            "wq-fatal",
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async { Err(SettingsWriteError::with_code("no entry", "ENOENT")) }
            },
            sleep,
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(delays.borrow().is_empty());
    }

    #[tokio::test]
    async fn gives_up_with_the_last_error_after_four_retryable_attempts() {
        let (delays, sleep) = recording_sleep();
        let attempts = AtomicUsize::new(0);
        let result: Result<(), SettingsWriteError> = with_queued_retry(
            "wq-give-up",
            || {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move { Err(SettingsWriteError::with_code(format!("busy #{n}"), "EPERM")) }
            },
            sleep,
        )
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.message, "busy #3");
        assert_eq!(attempts.load(Ordering::SeqCst), 4);
        assert_eq!(*delays.borrow(), vec![50, 100, 200]);
    }

    #[tokio::test]
    async fn does_not_let_a_failed_predecessor_block_the_next_write() {
        let (_, sleep) = recording_sleep();
        let first: Result<(), SettingsWriteError> = with_queued_retry(
            "wq-fail-then-ok",
            || async { Err(SettingsWriteError::message("boom")) },
            &sleep,
        )
        .await;
        assert!(first.is_err());
        let second: Result<i32, SettingsWriteError> =
            with_queued_retry("wq-fail-then-ok", || async { Ok(7) }, &sleep).await;
        assert_eq!(second.unwrap(), 7);
    }

    #[tokio::test]
    async fn lets_different_paths_proceed_independently() {
        // Task on path A blocks until we release it; a task on path B must be
        // able to finish while A is still held.
        let queue_a = queue_for("wq-independent-a");
        let guard_a = queue_a.lock().await;

        let (_, sleep) = recording_sleep();
        let b: Result<&str, SettingsWriteError> =
            with_queued_retry("wq-independent-b", || async { Ok("b done") }, sleep).await;
        assert_eq!(b.unwrap(), "b done");

        drop(guard_a);
        release_queue("wq-independent-a", &queue_a);
    }

    #[tokio::test]
    async fn keeps_every_retry_of_a_task_ahead_of_the_next_queued_task() {
        let log: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

        let log_a = Arc::clone(&log);
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_a = Arc::clone(&attempts);
        let first = with_queued_retry(
            "wq-retry-ahead",
            move || {
                let log = Arc::clone(&log_a);
                let n = attempts_a.fetch_add(1, Ordering::SeqCst);
                async move {
                    log.lock().unwrap().push(format!("a{n}"));
                    if n < 2 {
                        Err(SettingsWriteError::with_code("busy", "EBUSY"))
                    } else {
                        Ok::<_, SettingsWriteError>("a done")
                    }
                }
            },
            |_ms| async {
                // Yield inside the retry sleep so an unfair implementation
                // would let the queued task run in between.
                tokio::task::yield_now().await;
            },
        );

        let log_b = Arc::clone(&log);
        let second = with_queued_retry(
            "wq-retry-ahead",
            move || {
                let log = Arc::clone(&log_b);
                async move {
                    log.lock().unwrap().push("b0".to_string());
                    Ok::<_, SettingsWriteError>("b done")
                }
            },
            |_ms| async {},
        );

        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap(), "a done");
        assert_eq!(second.unwrap(), "b done");
        assert_eq!(
            *log.lock().unwrap(),
            vec!["a0", "a1", "a2", "b0"],
            "every retry of task A must run before task B starts"
        );
    }
}
