//! Port of `lib/shutdown.ts` — process cleanup registry hooked to shutdown
//! signals.
//!
//! Behavior source: specs/01-foundation.md §2.15, §10.5.
//!
//! Contracts preserved from the TS source:
//! - [`register_cleanup`] appends to the registry and lazily installs the
//!   signal handlers ONCE (SIGINT/SIGTERM in TS → `tokio::signal::ctrl_c` on
//!   every platform plus SIGTERM on unix here). A received signal runs the
//!   cleanups and then exits with code 0.
//! - [`unregister_cleanup`] removes a single registration (the TS removed by
//!   function identity; Rust closures have no identity, so registration hands
//!   back a [`CleanupHandle`] token instead — same observable behavior:
//!   removing one specific entry, no-op when absent).
//! - [`run_cleanup`] is idempotent while running (concurrent calls coalesce
//!   onto the in-flight run), snapshots + clears the list up front, awaits
//!   each cleanup **sequentially in registration order**, swallows individual
//!   cleanup failures (panics here — the analogue of thrown/rejected cleanup
//!   errors), and clears the in-flight marker afterwards so a later call
//!   re-runs with any newly registered fns.
//! - [`get_cleanup_count`] reports the number of currently registered fns.
//!
//! Rust-specific notes:
//! - Node's `beforeExit` (run cleanups when the event loop drains, without
//!   exiting) has no Rust analogue; binary mains call `run_cleanup().await`
//!   before returning instead (ARCHITECTURE.md §5.4: CLI paths exit after
//!   `run()` returns; long-running bins await ctrl-c which routes through the
//!   installed handler).
//! - `run_cleanup` starts eagerly like the TS promise executor when a tokio
//!   runtime is available (the shared future is additionally spawned so it
//!   makes progress even if the caller drops it). Outside a runtime the
//!   caller must drive the returned future (e.g. `block_on`).
//! - Signal handlers can only be installed from inside a tokio runtime; when
//!   `register_cleanup` is called outside one, installation is retried on the
//!   next registration that happens inside a runtime.

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::Mutex;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

/// Opaque token identifying one [`register_cleanup`] call, used to remove that
/// registration again via [`unregister_cleanup`] (the Rust replacement for the
/// TS remove-by-function-identity contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CleanupHandle(u64);

type CleanupFn = Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send>;

struct CleanupEntry {
    id: u64,
    f: CleanupFn,
}

type SharedCleanupFuture = Shared<BoxFuture<'static, ()>>;

struct State {
    entries: Vec<CleanupEntry>,
    next_id: u64,
    handlers_installed: bool,
    in_flight: Option<SharedCleanupFuture>,
}

static STATE: Mutex<State> = Mutex::new(State {
    entries: Vec::new(),
    next_id: 1,
    handlers_installed: false,
    in_flight: None,
});

fn lock_state() -> std::sync::MutexGuard<'static, State> {
    // Poison-tolerant: a cleanup panicking elsewhere must never brick the
    // shutdown registry (errors are swallowed during shutdown by contract).
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Register a cleanup to run at shutdown. Mirrors TS `registerCleanup`:
/// appends to the registry (fns run in registration order) and lazily installs
/// the process signal handlers once.
///
/// Returns a [`CleanupHandle`] for [`unregister_cleanup`].
pub fn register_cleanup<F, Fut>(f: F) -> CleanupHandle
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let boxed: CleanupFn = Box::new(move || f().boxed());
    let id = {
        let mut state = lock_state();
        let id = state.next_id;
        state.next_id += 1;
        state.entries.push(CleanupEntry { id, f: boxed });
        ensure_shutdown_handler(&mut state);
        id
    };
    CleanupHandle(id)
}

/// Convenience for synchronous cleanups — the analogue of registering a plain
/// `() => void` function in TS.
pub fn register_cleanup_sync<F>(f: F) -> CleanupHandle
where
    F: FnOnce() + Send + 'static,
{
    register_cleanup(move || {
        f();
        std::future::ready(())
    })
}

/// Remove one registration by its handle. No-op when the handle is not (or no
/// longer) registered — matching the TS `unregisterCleanup` no-op for
/// non-registered functions.
pub fn unregister_cleanup(handle: CleanupHandle) {
    let mut state = lock_state();
    if let Some(index) = state.entries.iter().position(|e| e.id == handle.0) {
        state.entries.remove(index);
    }
}

/// Number of currently registered cleanup fns (drops to 0 once a run has
/// snapshotted the list).
pub fn get_cleanup_count() -> usize {
    lock_state().entries.len()
}

/// Run all registered cleanups. Semantics ported verbatim from TS
/// `runCleanup`:
///
/// - Concurrent calls while a run is in flight receive the SAME in-flight
///   future (coalesced; the cleanups execute once).
/// - The registry is snapshotted and cleared before execution, so cleanups
///   registered DURING the run are kept for a later run.
/// - Cleanups execute sequentially in registration order; individual failures
///   (panics) are swallowed.
/// - The in-flight marker is cleared when the run finishes, so a later call
///   re-runs with newly registered fns.
///
/// The run starts eagerly when a tokio runtime is available; the returned
/// future resolves when the run completes.
pub fn run_cleanup() -> impl Future<Output = ()> + Send + 'static {
    let shared = {
        let mut state = lock_state();
        if let Some(in_flight) = &state.in_flight {
            return in_flight.clone();
        }

        let entries: Vec<CleanupEntry> = state.entries.drain(..).collect();
        let shared: SharedCleanupFuture = async move {
            for entry in entries {
                // Swallow panics from both the synchronous closure body and
                // the returned future — the analogue of the TS
                // `try { await fn(); } catch { /* ignore */ }`.
                let invoked = std::panic::catch_unwind(AssertUnwindSafe(|| (entry.f)()));
                if let Ok(future) = invoked {
                    let _ = AssertUnwindSafe(future).catch_unwind().await;
                }
            }
            // Clear the in-flight marker so a later call re-runs with any
            // newly registered fns (TS `.finally(() => cleanupPromise = null)`).
            lock_state().in_flight = None;
        }
        .boxed()
        .shared();
        state.in_flight = Some(shared.clone());
        shared
    };

    // Eager start (TS promise executors run immediately): drive the shared
    // future from a spawned task when a runtime is available, so cleanup
    // proceeds even if the caller drops the returned future.
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(shared.clone());
    }

    shared
}

fn ensure_shutdown_handler(state: &mut State) {
    if state.handlers_installed {
        return;
    }
    // Signal listeners need a reactor; outside a runtime, leave the flag unset
    // so a later in-runtime registration installs them.
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    state.handlers_installed = true;
    handle.spawn(signal_listener());
}

/// Await a shutdown signal, run the cleanups, then exit 0 — the TS
/// `process.once("SIGINT"/"SIGTERM", ...)` handlers. `process.once` semantics
/// (handler fires a single time) hold trivially because the process exits.
async fn signal_listener() {
    wait_for_shutdown_signal().await;
    run_cleanup().await;
    std::process::exit(0);
}

#[cfg(unix)]
async fn wait_for_shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(stream) => stream,
        Err(_) => {
            // SIGTERM registration failed — still honor ctrl-c (SIGINT).
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown_signal() {
    // Windows: ctrl-c is the console close/interrupt analogue of SIGINT.
    let _ = tokio::signal::ctrl_c().await;
}

// ---------------------------------------------------------------------------
// Tests (ported from test/shutdown.test.ts; the process-signal integration
// tests are not portable — they mock `process.once`/`process.exit` — so the
// registry/coalescing contracts carry the coverage)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// beforeEach analogue: drain any leftovers from a previous test.
    async fn drain() {
        run_cleanup().await;
        assert_eq!(get_cleanup_count(), 0);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn registers_and_runs_cleanup_functions() {
        drain().await;
        let calls = Arc::new(AtomicU32::new(0));
        let calls_fn = Arc::clone(&calls);
        register_cleanup_sync(move || {
            calls_fn.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(get_cleanup_count(), 1);
        run_cleanup().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(get_cleanup_count(), 0);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn unregisters_cleanup_functions() {
        drain().await;
        let calls = Arc::new(AtomicU32::new(0));
        let calls_fn = Arc::clone(&calls);
        let handle = register_cleanup_sync(move || {
            calls_fn.fetch_add(1, Ordering::SeqCst);
        });
        unregister_cleanup(handle);
        assert_eq!(get_cleanup_count(), 0);
        run_cleanup().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn runs_multiple_cleanup_functions_in_registration_order() {
        drain().await;
        let order: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
        for n in 1..=3u32 {
            let order_fn = Arc::clone(&order);
            register_cleanup_sync(move || {
                order_fn.lock().unwrap().push(n);
            });
        }
        run_cleanup().await;
        assert_eq!(*order.lock().unwrap(), vec![1, 2, 3]);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn handles_async_cleanup_functions() {
        drain().await;
        let calls = Arc::new(AtomicU32::new(0));
        let calls_fn = Arc::clone(&calls);
        register_cleanup(move || async move {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            calls_fn.fetch_add(1, Ordering::SeqCst);
        });
        run_cleanup().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn continues_cleanup_even_if_one_function_panics() {
        drain().await;
        let first_ran = Arc::new(AtomicU32::new(0));
        let second_ran = Arc::new(AtomicU32::new(0));
        let first_fn = Arc::clone(&first_ran);
        let second_fn = Arc::clone(&second_ran);
        // Silence the default panic backtrace noise for the expected panic.
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        register_cleanup_sync(move || {
            first_fn.fetch_add(1, Ordering::SeqCst);
            panic!("fail");
        });
        register_cleanup_sync(move || {
            second_fn.fetch_add(1, Ordering::SeqCst);
        });
        run_cleanup().await;
        std::panic::set_hook(previous_hook);
        assert_eq!(first_ran.load(Ordering::SeqCst), 1);
        assert_eq!(second_ran.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn clears_cleanup_list_after_running() {
        drain().await;
        register_cleanup_sync(|| {});
        register_cleanup_sync(|| {});
        assert_eq!(get_cleanup_count(), 2);
        run_cleanup().await;
        assert_eq!(get_cleanup_count(), 0);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn coalesces_concurrent_run_cleanup_calls_onto_one_run() {
        drain().await;
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let calls = Arc::new(AtomicU32::new(0));
        let calls_fn = Arc::clone(&calls);
        register_cleanup(move || async move {
            let _ = release_rx.await;
            calls_fn.fetch_add(1, Ordering::SeqCst);
        });

        let first = run_cleanup();
        let second = run_cleanup();

        release_tx.send(()).unwrap();
        // Both futures resolve, but the cleanup body ran exactly once — the
        // TS assertion `first === second` maps to single execution here.
        first.await;
        second.await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn later_run_reexecutes_with_newly_registered_functions() {
        drain().await;
        let calls = Arc::new(AtomicU32::new(0));
        let calls_a = Arc::clone(&calls);
        register_cleanup_sync(move || {
            calls_a.fetch_add(1, Ordering::SeqCst);
        });
        run_cleanup().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // The in-flight marker cleared, so a fresh registration runs again.
        let calls_b = Arc::clone(&calls);
        register_cleanup_sync(move || {
            calls_b.fetch_add(1, Ordering::SeqCst);
        });
        run_cleanup().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn unregister_is_noop_for_non_registered_handle() {
        drain().await;
        let handle = register_cleanup_sync(|| {});
        run_cleanup().await; // consumes the entry; handle now dangles
        unregister_cleanup(handle); // must not panic or affect anything
        assert_eq!(get_cleanup_count(), 0);
        // A handle that never existed is equally a no-op.
        unregister_cleanup(CleanupHandle(u64::MAX));
        assert_eq!(get_cleanup_count(), 0);
    }

    #[tokio::test]
    #[serial(shutdown)]
    async fn functions_registered_during_a_run_are_kept_for_the_next_run() {
        drain().await;
        let late_ran = Arc::new(AtomicU32::new(0));
        let late_fn = Arc::clone(&late_ran);
        register_cleanup(move || async move {
            // Register a new cleanup while the run is in flight; the list was
            // snapshotted+cleared, so this stays queued for the NEXT run.
            let late_inner = Arc::clone(&late_fn);
            register_cleanup_sync(move || {
                late_inner.fetch_add(1, Ordering::SeqCst);
            });
        });
        run_cleanup().await;
        assert_eq!(late_ran.load(Ordering::SeqCst), 0);
        assert_eq!(get_cleanup_count(), 1);
        run_cleanup().await;
        assert_eq!(late_ran.load(Ordering::SeqCst), 1);
        assert_eq!(get_cleanup_count(), 0);
    }

    #[test]
    #[serial(shutdown)]
    fn register_outside_a_runtime_does_not_panic_and_defers_handler_install() {
        // No tokio runtime here: registration must still work; the signal
        // handler install is deferred until an in-runtime registration.
        let handle = register_cleanup_sync(|| {});
        assert!(get_cleanup_count() >= 1);
        unregister_cleanup(handle);
    }
}
