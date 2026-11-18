//! Port of `lib/live-account-sync.ts` — watches the account storage file and
//! triggers a reload callback when its content changes. Uses a directory
//! watcher (`notify`, the `fs.watch` analogue) plus a polling fallback for
//! Windows reliability.
//!
//! Behavior contract (spec 05 §11 + gotcha 21):
//! - The WATCHER observes the parent DIRECTORY (survives atomic
//!   rename-replace); events match the target name or `"{target}."`-prefixed
//!   temp-staging names.
//! - Poll compares mtime with `!=` (NOT `>`) so coarse Windows timestamps and
//!   file-deletion→missing transitions both trigger.
//! - Reloads are debounced (trailing edge) and single-flight WITHOUT
//!   re-queue: a change landing mid-reload is picked up by the next poll
//!   tick, not immediately.
//! - `readMtimeMs` maps ENOENT/EBUSY/EACCES to "missing" but propagates any
//!   other error.
//! - After a successful reload the mtime is re-read.

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};

use cma_core::fs_retry::code_of;
use cma_core::logger::create_logger;
use cma_core::utils::now_ms;
use notify::Watcher;
use serde_json::json;
use tokio::task::JoinHandle;

/// Reason a reload was scheduled (TS `"watch" | "poll"` union).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveSyncReason {
    Watch,
    Poll,
}

impl LiveSyncReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            LiveSyncReason::Watch => "watch",
            LiveSyncReason::Poll => "poll",
        }
    }
}

/// Boxed reload future (TS `() => Promise<void>`; rejections are counted).
pub type LiveReloadFuture = Pin<
    Box<dyn std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>> + Send>,
>;
/// Shared reload callback.
pub type LiveReloadFn = Arc<dyn Fn() -> LiveReloadFuture + Send + Sync>;

/// TS `interface LiveAccountSyncOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub struct LiveAccountSyncOptions {
    /// Default 250, floor 50.
    pub debounce_ms: Option<u64>,
    /// Default 2000, floor 500.
    pub poll_interval_ms: Option<u64>,
}

/// TS `interface LiveAccountSyncSnapshot`.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveAccountSyncSnapshot {
    pub path: Option<PathBuf>,
    pub running: bool,
    pub last_known_mtime_ms: Option<f64>,
    pub last_sync_at: Option<i64>,
    pub reload_count: u64,
    pub error_count: u64,
}

/// TS private `readMtimeMs(path)` — `Ok(None)` for missing/locked
/// (ENOENT/EBUSY/EACCES), `Err` for anything else, otherwise the finite
/// mtime in milliseconds (sub-millisecond precision preserved, Node
/// `stats.mtimeMs` parity).
async fn read_mtime_ms(path: &Path) -> std::io::Result<Option<f64>> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) => {
            let Ok(modified) = metadata.modified() else {
                return Ok(None);
            };
            let mtime_ms = match modified.duration_since(std::time::UNIX_EPOCH) {
                Ok(duration) => duration.as_secs_f64() * 1000.0,
                // Pre-epoch mtimes are representable in Node as negative ms.
                Err(before_epoch) => -(before_epoch.duration().as_secs_f64() * 1000.0),
            };
            Ok(mtime_ms.is_finite().then_some(mtime_ms))
        }
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound
                || matches!(code_of(&error), Some("ENOENT" | "EBUSY" | "EACCES"))
            {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

/// TS `summarizeWatchPath` — basename only (never log the full path).
fn summarize_watch_path(path: Option<&Path>) -> String {
    match path.and_then(|p| p.file_name()) {
        Some(name) => name.to_string_lossy().into_owned(),
        None => "<unknown>".to_string(),
    }
}

struct State {
    watcher: Option<notify::RecommendedWatcher>,
    poll_task: Option<JoinHandle<()>>,
    debounce_task: Option<JoinHandle<()>>,
    current_path: Option<PathBuf>,
    running: bool,
    last_known_mtime_ms: Option<f64>,
    last_sync_at: Option<i64>,
    reload_count: u64,
    error_count: u64,
}

struct Inner {
    reload: LiveReloadFn,
    debounce_ms: u64,
    poll_interval_ms: u64,
    state: Mutex<State>,
    /// Single-flight gate (TS `reloadInFlight`): held for the duration of a
    /// reload; a concurrent attempt awaits the holder and returns WITHOUT
    /// re-running.
    reload_gate: tokio::sync::Mutex<()>,
}

/// TS `class LiveAccountSync`.
pub struct LiveAccountSync {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for LiveAccountSync {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveAccountSync")
            .field("snapshot", &self.get_snapshot())
            .finish()
    }
}

impl LiveAccountSync {
    /// TS constructor — `debounceMs = max(50, floor(?? 250))`,
    /// `pollIntervalMs = max(500, floor(?? 2000))`.
    pub fn new(reload: LiveReloadFn, options: LiveAccountSyncOptions) -> Self {
        Self {
            inner: Arc::new(Inner {
                reload,
                debounce_ms: options.debounce_ms.unwrap_or(250).max(50),
                poll_interval_ms: options.poll_interval_ms.unwrap_or(2_000).max(500),
                state: Mutex::new(State {
                    watcher: None,
                    poll_task: None,
                    debounce_task: None,
                    current_path: None,
                    running: false,
                    last_known_mtime_ms: None,
                    last_sync_at: None,
                    reload_count: 0,
                    error_count: 0,
                }),
                reload_gate: tokio::sync::Mutex::const_new(()),
            }),
        }
    }

    /// TS `syncToPath(path)` — empty path or already-running-on-same-path is
    /// a no-op; otherwise stops any previous watch and starts the dir watcher
    /// plus the poll loop. Propagates unexpected initial-stat errors (TS
    /// parity: `readMtimeMs` rethrows non-mapped codes).
    ///
    /// Must run inside a tokio runtime (the poll/debounce tasks are spawned
    /// on the ambient runtime; the TS timers were `unref()`'d, which tokio
    /// tasks match — they never keep a process alive on their own).
    pub async fn sync_to_path(&self, path: &Path) -> std::io::Result<()> {
        if path.as_os_str().is_empty() {
            return Ok(());
        }
        {
            let state = self.lock_state();
            if state.running && state.current_path.as_deref() == Some(path) {
                return Ok(());
            }
        }
        self.stop();

        {
            let mut state = self.lock_state();
            state.current_path = Some(path.to_path_buf());
        }
        let initial_mtime = read_mtime_ms(path).await?;
        let runtime = tokio::runtime::Handle::current();

        // fs.watch analogue: watch the parent DIRECTORY (not the file) so
        // atomic rename-replace keeps being observed.
        let target_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let target_prefix = format!("{target_name}.");
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let watcher_runtime = runtime.clone();
        let watcher_result =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let Ok(event) = event else {
                    // Watcher-level errors have no TS analogue (fs.watch never
                    // delivered them to the listener); polling covers the gap.
                    return;
                };
                // A missing filename in TS scheduled unconditionally; notify
                // events with no paths behave the same.
                let matches = event.paths.is_empty()
                    || event.paths.iter().any(|event_path| {
                        event_path
                            .file_name()
                            .map(|name| name.to_string_lossy())
                            .is_some_and(|name| {
                                name == target_name.as_str() || name.starts_with(&target_prefix)
                            })
                    });
                if matches {
                    Inner::schedule_reload(&inner, &watcher_runtime, LiveSyncReason::Watch);
                }
            });
        let parent = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => PathBuf::from("."),
        };
        let watcher = match watcher_result {
            Ok(mut watcher) => match watcher.watch(&parent, notify::RecursiveMode::NonRecursive) {
                Ok(()) => Some(watcher),
                Err(error) => {
                    self.record_watch_start_failure(path, &error);
                    None
                }
            },
            Err(error) => {
                self.record_watch_start_failure(path, &error);
                None
            }
        };

        // Poll fallback (TS `setInterval(pollOnce, pollIntervalMs).unref()`).
        let poll_inner = Arc::clone(&self.inner);
        let poll_interval = self.inner.poll_interval_ms;
        let poll_runtime = runtime.clone();
        let poll_task = runtime.spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(poll_interval)).await;
                Inner::poll_once(&poll_inner, &poll_runtime).await;
            }
        });

        let mut state = self.lock_state();
        state.last_known_mtime_ms = initial_mtime;
        state.watcher = watcher;
        state.poll_task = Some(poll_task);
        state.running = true;
        Ok(())
    }

    fn record_watch_start_failure(&self, path: &Path, error: &notify::Error) {
        {
            let mut state = self.lock_state();
            state.error_count += 1;
        }
        create_logger("live-account-sync").warn(
            "Failed to start fs.watch for account storage",
            Some(&json!({
                "path": summarize_watch_path(Some(path)),
                "error": error.to_string(),
            })),
        );
    }

    /// TS `stop()` — flips `running`, closes the watcher, clears the poll
    /// interval and any pending debounce timer.
    pub fn stop(&self) {
        let mut state = self.lock_state();
        state.running = false;
        state.watcher = None;
        if let Some(poll_task) = state.poll_task.take() {
            poll_task.abort();
        }
        if let Some(debounce_task) = state.debounce_task.take() {
            debounce_task.abort();
        }
    }

    /// TS `getSnapshot()`.
    pub fn get_snapshot(&self) -> LiveAccountSyncSnapshot {
        let state = self.lock_state();
        LiveAccountSyncSnapshot {
            path: state.current_path.clone(),
            running: state.running,
            last_known_mtime_ms: state.last_known_mtime_ms,
            last_sync_at: state.last_sync_at,
            reload_count: state.reload_count,
            error_count: state.error_count,
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Direct access to the private `runReload` path (the TS suite reaches it
    /// reflectively to prove single-flight coalescing).
    #[doc(hidden)]
    pub async fn __run_reload_for_tests(&self, reason: LiveSyncReason) {
        Inner::run_reload(Arc::clone(&self.inner), reason).await;
    }
}

impl Drop for LiveAccountSync {
    fn drop(&mut self) {
        // Rust-side hygiene: dropping the handle tears the watcher/tasks down
        // (the TS object simply became unreachable; nothing observable
        // differs because nothing can call a dropped handle).
        self.stop();
    }
}

impl Inner {
    /// TS `scheduleReload(reason)` — trailing-edge debounce: any pending
    /// timer is cancelled and a fresh one armed.
    fn schedule_reload(
        inner: &Arc<Inner>,
        runtime: &tokio::runtime::Handle,
        reason: LiveSyncReason,
    ) {
        let mut state = inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.running {
            return;
        }
        if let Some(previous) = state.debounce_task.take() {
            previous.abort();
        }
        let debounce_ms = inner.debounce_ms;
        let task_inner = Arc::clone(inner);
        state.debounce_task = Some(runtime.spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(debounce_ms)).await;
            Inner::run_reload(task_inner, reason).await;
        }));
    }

    /// TS `pollOnce()` — any mtime inequality (`!=`, including
    /// present→missing) schedules a reload; stat errors are counted.
    async fn poll_once(inner: &Arc<Inner>, runtime: &tokio::runtime::Handle) {
        let path = {
            let state = inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !state.running {
                return;
            }
            let Some(path) = state.current_path.clone() else {
                return;
            };
            path
        };
        match read_mtime_ms(&path).await {
            Ok(current_mtime) => {
                let changed = {
                    let mut state = inner
                        .state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if state.last_known_mtime_ms != current_mtime {
                        state.last_known_mtime_ms = current_mtime;
                        true
                    } else {
                        false
                    }
                };
                if changed {
                    Inner::schedule_reload(inner, runtime, LiveSyncReason::Poll);
                }
            }
            Err(error) => {
                {
                    let mut state = inner
                        .state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    state.error_count += 1;
                }
                create_logger("live-account-sync").debug(
                    "Live account sync poll failed",
                    Some(&json!({
                        "path": summarize_watch_path(Some(&path)),
                        "error": error.to_string(),
                    })),
                );
            }
        }
    }

    /// TS `runReload(reason)` — single-flight WITHOUT re-queue: when a reload
    /// is already in flight, await its completion and return (a change
    /// landing mid-reload is caught by the next poll tick). On success the
    /// mtime is re-read AFTER the reload.
    async fn run_reload(inner: Arc<Inner>, reason: LiveSyncReason) {
        let target_path = {
            let state = inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !state.running {
                return;
            }
            let Some(path) = state.current_path.clone() else {
                return;
            };
            path
        };

        let _gate = match inner.reload_gate.try_lock() {
            Ok(gate) => gate,
            Err(_) => {
                // In flight: wait for it to finish, then return without
                // running a second reload.
                let _wait = inner.reload_gate.lock().await;
                return;
            }
        };

        let log = create_logger("live-account-sync");
        let outcome: Result<(), String> = async {
            (inner.reload)().await.map_err(|error| error.to_string())?;
            {
                let mut state = inner
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.last_sync_at = Some(now_ms());
                state.reload_count += 1;
            }
            let refreshed = read_mtime_ms(&target_path)
                .await
                .map_err(|error| error.to_string())?;
            {
                let mut state = inner
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.last_known_mtime_ms = refreshed;
            }
            log.debug(
                "Reloaded account manager from live storage update",
                Some(&json!({
                    "reason": reason.as_str(),
                    "path": summarize_watch_path(Some(&target_path)),
                })),
            );
            Ok(())
        }
        .await;

        if let Err(error) = outcome {
            {
                let mut state = inner
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.error_count += 1;
            }
            log.warn(
                "Live account sync reload failed",
                Some(&json!({
                    "reason": reason.as_str(),
                    "path": summarize_watch_path(Some(&target_path)),
                    "error": error,
                })),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    fn counting_reload(counter: Arc<AtomicU64>, fail: bool) -> LiveReloadFn {
        Arc::new(move || {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                if fail {
                    Err("reload failed".into())
                } else {
                    Ok(())
                }
            })
        })
    }

    fn temp_storage() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("cma-live-sync-")
            .tempdir()
            .unwrap();
        let path = dir.path().join("openai-codex-accounts.json");
        std::fs::write(&path, "{\"version\":3,\"activeIndex\":0,\"accounts\":[]}").unwrap();
        (dir, path)
    }

    #[tokio::test]
    async fn reloads_when_file_changes_are_detected() {
        let (_dir, path) = temp_storage();
        let calls = Arc::new(AtomicU64::new(0));
        let sync = LiveAccountSync::new(
            counting_reload(Arc::clone(&calls), false),
            LiveAccountSyncOptions {
                debounce_ms: Some(50),
                poll_interval_ms: Some(500),
            },
        );

        sync.sync_to_path(&path).await.unwrap();
        // Change content (watch event + mtime change for the poll fallback).
        std::fs::write(
            &path,
            "{\"version\":3,\"activeIndex\":0,\"accounts\":[{\"refreshToken\":\"a\"}]}",
        )
        .unwrap();

        tokio::time::sleep(Duration::from_millis(900)).await;

        assert!(calls.load(Ordering::SeqCst) > 0);
        let snapshot = sync.get_snapshot();
        assert!(snapshot.reload_count > 0);
        assert!(snapshot.last_sync_at.is_some());
        sync.stop();
    }

    #[tokio::test]
    async fn records_errors_when_reload_fails() {
        let (_dir, path) = temp_storage();
        let calls = Arc::new(AtomicU64::new(0));
        let sync = LiveAccountSync::new(
            counting_reload(Arc::clone(&calls), true),
            LiveAccountSyncOptions {
                debounce_ms: Some(50),
                poll_interval_ms: Some(500),
            },
        );

        sync.sync_to_path(&path).await.unwrap();
        std::fs::write(
            &path,
            "{\"version\":3,\"activeIndex\":0,\"accounts\":[{\"refreshToken\":\"b\"}]}",
        )
        .unwrap();

        tokio::time::sleep(Duration::from_millis(900)).await;

        let snapshot = sync.get_snapshot();
        assert!(snapshot.error_count > 0);
        assert_eq!(snapshot.reload_count, 0);
        sync.stop();
    }

    #[tokio::test]
    async fn stops_watching_cleanly_and_prevents_further_reloads() {
        let (_dir, path) = temp_storage();
        let calls = Arc::new(AtomicU64::new(0));
        let sync = LiveAccountSync::new(
            counting_reload(Arc::clone(&calls), false),
            LiveAccountSyncOptions {
                debounce_ms: Some(50),
                poll_interval_ms: Some(500),
            },
        );

        sync.sync_to_path(&path).await.unwrap();
        sync.stop();
        std::fs::write(
            &path,
            "{\"version\":3,\"activeIndex\":0,\"accounts\":[{\"refreshToken\":\"c\"}]}",
        )
        .unwrap();

        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!sync.get_snapshot().running);
    }

    #[tokio::test]
    async fn syncing_same_path_while_running_is_a_no_op() {
        let (_dir, path) = temp_storage();
        let calls = Arc::new(AtomicU64::new(0));
        let sync = LiveAccountSync::new(
            counting_reload(Arc::clone(&calls), false),
            LiveAccountSyncOptions::default(),
        );
        sync.sync_to_path(&path).await.unwrap();
        let before = sync.get_snapshot();
        sync.sync_to_path(&path).await.unwrap();
        let after = sync.get_snapshot();
        assert!(after.running);
        assert_eq!(before.path, after.path);
        sync.stop();
    }

    #[tokio::test]
    async fn missing_file_yields_none_mtime_and_deletion_triggers_poll_reload() {
        let (_dir, path) = temp_storage();
        let calls = Arc::new(AtomicU64::new(0));
        let sync = LiveAccountSync::new(
            counting_reload(Arc::clone(&calls), false),
            LiveAccountSyncOptions {
                debounce_ms: Some(50),
                poll_interval_ms: Some(500),
            },
        );
        sync.sync_to_path(&path).await.unwrap();
        assert!(sync.get_snapshot().last_known_mtime_ms.is_some());

        // Deleting the file flips the poll-observed mtime to None (`!=`
        // comparison, not `>`), scheduling a reload.
        std::fs::remove_file(&path).unwrap();
        tokio::time::sleep(Duration::from_millis(900)).await;

        assert!(calls.load(Ordering::SeqCst) > 0);
        assert_eq!(sync.get_snapshot().last_known_mtime_ms, None);
        sync.stop();
    }

    #[tokio::test]
    async fn coalesces_overlapping_reload_attempts_into_single_in_flight_reload() {
        let (_dir, path) = temp_storage();
        let calls = Arc::new(AtomicU64::new(0));
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let reload_calls = Arc::clone(&calls);
        let reload_gate = Arc::clone(&gate);
        let reload: LiveReloadFn = Arc::new(move || {
            let calls = Arc::clone(&reload_calls);
            let gate = Arc::clone(&reload_gate);
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                // Block until the test releases the gate.
                let _permit = gate.acquire().await.unwrap();
                Ok(())
            })
        });
        let sync = LiveAccountSync::new(
            reload,
            LiveAccountSyncOptions {
                debounce_ms: Some(50),
                poll_interval_ms: Some(500),
            },
        );
        sync.sync_to_path(&path).await.unwrap();

        let first = sync.__run_reload_for_tests(LiveSyncReason::Poll);
        let second = sync.__run_reload_for_tests(LiveSyncReason::Watch);
        let release = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            gate.add_permits(1);
        };
        tokio::join!(first, second, release);

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        sync.stop();
    }
}
