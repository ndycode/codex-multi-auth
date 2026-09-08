//! Port of `lib/request/wait-utils.ts` — abortable sleep plus the toast
//! countdown loop (spec 06 §22).
//!
//! All effects are injected (sleep / toast / wait-time formatting), so the
//! countdown logic is pure and easy to test. The TS `AbortSignal` is modeled
//! as a `tokio_util::sync::CancellationToken`; the frozen abort message is
//! `"Aborted"`.

use std::fmt;
use std::future::Future;
use std::time::Duration;

use cma_core::utils::now_ms;
use futures::FutureExt;
use futures::future::BoxFuture;
use tokio_util::sync::CancellationToken;

/// The frozen TS abort rejection: `new Error("Aborted")`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AbortedError;

impl fmt::Display for AbortedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Aborted")
    }
}

impl std::error::Error for AbortedError {}

/// One abortable sleep: resolves after `ms`, or rejects with
/// [`AbortedError`] immediately when the signal is already aborted or aborts
/// mid-sleep. (The TS listener cleanup is implicit — dropping the future
/// releases both branches.)
pub async fn abortable_sleep(
    ms: u64,
    abort_signal: Option<&CancellationToken>,
) -> Result<(), AbortedError> {
    match abort_signal {
        Some(token) if token.is_cancelled() => Err(AbortedError),
        Some(token) => {
            tokio::select! {
                _ = token.cancelled() => Err(AbortedError),
                _ = tokio::time::sleep(Duration::from_millis(ms)) => Ok(()),
            }
        }
        None => {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(())
        }
    }
}

/// TS `createAbortableSleep(abortSignal?)` — returns a reusable sleep
/// function bound to the given signal. Each call produces an independent
/// sleep future.
pub fn create_abortable_sleep(
    abort_signal: Option<CancellationToken>,
) -> impl Fn(u64) -> BoxFuture<'static, Result<(), AbortedError>> {
    move |ms: u64| {
        let token = abort_signal.clone();
        async move { abortable_sleep(ms, token.as_ref()).await }.boxed()
    }
}

/// TS `sleepWithCountdown` params. The injected `show_toast` receives
/// `(message, variant, duration_ms)` — the TS variant is always the literal
/// `"warning"` and the options object carried a single `duration` field.
pub struct SleepWithCountdownParams<'a, S, T, F> {
    pub total_ms: i64,
    pub message: &'a str,
    pub sleep: S,
    pub show_toast: T,
    pub format_wait_time: F,
    pub toast_duration_ms: i64,
    pub abort_signal: Option<&'a CancellationToken>,
    /// Defaults to 5000 when `None`.
    pub interval_ms: Option<i64>,
}

/// TS `sleepWithCountdown(params)`.
///
/// Loops until `now >= start + total_ms`. Each iteration: an aborted signal
/// throws `"Aborted"`; a toast
/// `"{message} ({format_wait_time(remaining)} remaining)"` is shown with
/// variant `"warning"` and `duration = min(interval_ms + 1000,
/// toast_duration_ms)`; then sleeps `min(interval_ms, remaining)` (a
/// non-positive sleep breaks the loop). An abort observed by the injected
/// sleep propagates as [`AbortedError`], matching the TS rejection.
pub async fn sleep_with_countdown<S, SFut, T, TFut, F>(
    params: SleepWithCountdownParams<'_, S, T, F>,
) -> Result<(), AbortedError>
where
    S: FnMut(i64) -> SFut,
    SFut: Future<Output = Result<(), AbortedError>>,
    T: FnMut(String, &'static str, i64) -> TFut,
    TFut: Future<Output = ()>,
    F: Fn(i64) -> String,
{
    let SleepWithCountdownParams {
        total_ms,
        message,
        mut sleep,
        mut show_toast,
        format_wait_time,
        toast_duration_ms,
        abort_signal,
        interval_ms,
    } = params;
    let start_time = now_ms();
    let end_time = start_time + total_ms;
    let interval_ms = interval_ms.unwrap_or(5_000);

    while now_ms() < end_time {
        if abort_signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(AbortedError);
        }

        let remaining = (end_time - now_ms()).max(0);
        let wait_label = format_wait_time(remaining);
        show_toast(
            format!("{message} ({wait_label} remaining)"),
            "warning",
            (interval_ms + 1_000).min(toast_duration_ms),
        )
        .await;

        let sleep_time = interval_ms.min(remaining);
        if sleep_time > 0 {
            sleep(sleep_time).await?;
        } else {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex;

    #[tokio::test]
    async fn resolves_abortable_sleep_after_timeout() {
        let sleep = create_abortable_sleep(None);
        sleep(10).await.expect("sleep resolves");
    }

    #[tokio::test]
    async fn rejects_abortable_sleep_when_aborted() {
        let token = CancellationToken::new();
        let sleep = create_abortable_sleep(Some(token.clone()));
        let pending = sleep(60_000);
        token.cancel();
        let err = pending.await.expect_err("aborted");
        assert_eq!(err.to_string(), "Aborted");
    }

    #[tokio::test]
    async fn rejects_immediately_when_already_aborted() {
        let token = CancellationToken::new();
        token.cancel();
        let sleep = create_abortable_sleep(Some(token));
        let err = sleep(60_000).await.expect_err("already aborted");
        assert_eq!(err, AbortedError);
    }

    type ToastLog = Arc<Mutex<Vec<(String, &'static str, i64)>>>;

    #[tokio::test]
    async fn shows_countdown_toasts_and_sleeps_in_intervals() {
        let toasts: ToastLog = Arc::default();
        let sleeps: Arc<Mutex<Vec<i64>>> = Arc::default();
        let toast_log = toasts.clone();
        let sleep_log = sleeps.clone();
        sleep_with_countdown(SleepWithCountdownParams {
            total_ms: 30,
            message: "Waiting",
            sleep: move |ms| {
                sleep_log.lock().unwrap().push(ms);
                async move {
                    tokio::time::sleep(Duration::from_millis(ms as u64)).await;
                    Ok(())
                }
            },
            show_toast: move |message, variant, duration| {
                toast_log.lock().unwrap().push((message, variant, duration));
                async {}
            },
            format_wait_time: |ms| format!("{ms}ms"),
            toast_duration_ms: 9_000,
            abort_signal: None,
            interval_ms: Some(10),
        })
        .await
        .expect("countdown completes");

        let toasts = toasts.lock().unwrap();
        assert!(!toasts.is_empty());
        let (message, variant, duration) = &toasts[0];
        assert!(message.starts_with("Waiting ("));
        assert!(message.ends_with("ms remaining)"));
        assert_eq!(*variant, "warning");
        // duration = min(intervalMs + 1000, toastDurationMs).
        assert_eq!(*duration, 1_010);
        assert!(!sleeps.lock().unwrap().is_empty());
        // Each sleep is capped at the interval.
        assert!(sleeps.lock().unwrap().iter().all(|&ms| ms <= 10));
    }

    #[tokio::test]
    async fn countdown_throws_when_aborted_before_iteration() {
        let token = CancellationToken::new();
        token.cancel();
        let err = sleep_with_countdown(SleepWithCountdownParams {
            total_ms: 10_000,
            message: "Waiting",
            sleep: |_ms| async { Ok(()) },
            show_toast: |_m, _v, _d| async {},
            format_wait_time: |ms| format!("{ms}ms"),
            toast_duration_ms: 9_000,
            abort_signal: Some(&token),
            interval_ms: Some(5_000),
        })
        .await
        .expect_err("aborted");
        assert_eq!(err.to_string(), "Aborted");
    }

    #[tokio::test]
    async fn countdown_propagates_abort_from_injected_sleep() {
        let err = sleep_with_countdown(SleepWithCountdownParams {
            total_ms: 10_000,
            message: "Waiting",
            sleep: |_ms| async { Err(AbortedError) },
            show_toast: |_m, _v, _d| async {},
            format_wait_time: |ms| format!("{ms}ms"),
            toast_duration_ms: 9_000,
            abort_signal: None,
            interval_ms: Some(5_000),
        })
        .await
        .expect_err("sleep abort propagates");
        assert_eq!(err, AbortedError);
    }

    #[tokio::test]
    async fn zero_total_skips_the_loop() {
        let toasted = Arc::new(Mutex::new(0u32));
        let log = toasted.clone();
        sleep_with_countdown(SleepWithCountdownParams {
            total_ms: 0,
            message: "Waiting",
            sleep: |_ms| async { Ok(()) },
            show_toast: move |_m, _v, _d| {
                *log.lock().unwrap() += 1;
                async {}
            },
            format_wait_time: |ms| format!("{ms}ms"),
            toast_duration_ms: 9_000,
            abort_signal: None,
            interval_ms: Some(5_000),
        })
        .await
        .expect("no-op countdown");
        assert_eq!(*toasted.lock().unwrap(), 0);
    }
}
