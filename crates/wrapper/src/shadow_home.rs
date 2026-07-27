//! Shadow `CODEX_HOME` lifecycle — port of the shadow-home half of
//! `scripts/codex.js`.
//!
//! A per-run temp home is mirrored from the real Codex home; the official
//! state files (`auth.json`, `accounts.json`, `.codex-global-state.json`) are
//! synced BACK to the real home before cleanup (guarded by a cross-process
//! lock + external-edit detection), and the shadow directory is removed after
//! the owning run exits. Runtime-rotation shadow homes additionally OMIT the
//! official auth state (the proxy owns auth) and link-rather-than-copy the
//! heavyweight generated directories.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use cma_storage::misc::compute_sha256;

/// Retryable codes for shadow-home cleanup/rename (TS
/// `RETRYABLE_SHADOW_HOME_CLEANUP_CODES`).
pub const RETRYABLE_SHADOW_HOME_CLEANUP_CODES: &[&str] = &["EBUSY", "EPERM", "ENOTEMPTY"];
/// TS `SHADOW_HOME_CLEANUP_BACKOFF_MS`.
pub const SHADOW_HOME_CLEANUP_BACKOFF_MS: &[u64] = &[20, 60, 120];
/// TS `SHADOW_HOME_ORPHAN_LOCK_STALE_AGE_MS`.
pub const SHADOW_HOME_ORPHAN_LOCK_STALE_AGE_MS: i64 = 2_000;
/// TS `SHADOW_HOME_SYNC_LOCK_WAIT_TIMEOUT_MS` = stale age + Σ backoff.
pub const SHADOW_HOME_SYNC_LOCK_WAIT_TIMEOUT_MS: i64 = SHADOW_HOME_ORPHAN_LOCK_STALE_AGE_MS + 200;
/// TS `SHADOW_HOME_STATE_FILES` — synced back after every run.
pub const SHADOW_HOME_STATE_FILES: &[&str] =
    &["auth.json", "accounts.json", ".codex-global-state.json"];
/// TS `RUNTIME_ROTATION_SHADOW_HOME_OMIT_STATE_FILES`.
pub const RUNTIME_ROTATION_SHADOW_HOME_OMIT_STATE_FILES: &[&str] = &["auth.json", "accounts.json"];
/// TS `RUNTIME_ROTATION_SHADOW_HOME_OMIT_ROOT_DIRS`.
pub const RUNTIME_ROTATION_SHADOW_HOME_OMIT_ROOT_DIRS: &[&str] = &["multi-auth"];
/// TS `RUNTIME_ROTATION_SHADOW_HOME_LINK_ONLY_ROOT_DIRS`.
pub const RUNTIME_ROTATION_SHADOW_HOME_LINK_ONLY_ROOT_DIRS: &[&str] = &[
    ".sandbox",
    ".sandbox-bin",
    ".sandbox-secrets",
    ".tmp",
    "ambient-suggestions",
    "archived_sessions",
    "backups",
    "cache",
    "generated_images",
    "log",
    "sqlite",
    "tmp",
    "understand-anything",
    "vendor_imports",
];
/// TS `SHADOW_HOME_CONFIG_FILE`.
pub const SHADOW_HOME_CONFIG_FILE: &str = "config.toml";
/// TS `SHADOW_HOME_SYNC_LOCK_DIR`.
pub const SHADOW_HOME_SYNC_LOCK_DIR: &str = ".codex-multi-auth-shadow-sync.lock";
/// TS `SHADOW_HOME_SYNC_STATE_FILE`.
pub const SHADOW_HOME_SYNC_STATE_FILE: &str = ".codex-multi-auth-shadow-sync-state.json";

// ---------------------------------------------------------------------------
// Test fault-injection hooks (TS module-level counters seeded from env).
// ---------------------------------------------------------------------------

fn env_counter(name: &str) -> AtomicI64 {
    let value = std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(0);
    AtomicI64::new(value)
}

fn cleanup_busy_failures() -> &'static AtomicI64 {
    static CELL: OnceLock<AtomicI64> = OnceLock::new();
    CELL.get_or_init(|| env_counter("CODEX_MULTI_AUTH_TEST_SHADOW_CLEANUP_BUSY_FAILURES"))
}

fn preflight_read_busy_failures() -> &'static AtomicI64 {
    static CELL: OnceLock<AtomicI64> = OnceLock::new();
    CELL.get_or_init(|| env_counter("CODEX_MULTI_AUTH_TEST_SHADOW_PREFLIGHT_READ_BUSY_FAILURES"))
}

fn sync_metadata_busy_failures() -> &'static AtomicI64 {
    static CELL: OnceLock<AtomicI64> = OnceLock::new();
    CELL.get_or_init(|| env_counter("CODEX_MULTI_AUTH_TEST_SHADOW_SYNC_METADATA_BUSY_FAILURES"))
}

fn lock_owner_write_failures() -> &'static AtomicI64 {
    static CELL: OnceLock<AtomicI64> = OnceLock::new();
    CELL.get_or_init(|| env_counter("CODEX_MULTI_AUTH_TEST_SHADOW_LOCK_OWNER_WRITE_FAILURES"))
}

fn take_injected_failure(counter: &AtomicI64) -> bool {
    loop {
        let current = counter.load(Ordering::SeqCst);
        if current <= 0 {
            return false;
        }
        if counter
            .compare_exchange(current, current - 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return true;
        }
    }
}

fn busy_error(message: &str) -> io::Error {
    cma_core::fs_retry::io_error_with_code("EBUSY", message.to_string())
}

fn maybe_simulated_cleanup_busy() -> io::Result<()> {
    if take_injected_failure(cleanup_busy_failures()) {
        return Err(busy_error("simulated busy shadow-home operation"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Warn-once registries (TS module-level flags/sets).
// ---------------------------------------------------------------------------

fn warned_set() -> &'static Mutex<HashSet<String>> {
    static CELL: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashSet::new()))
}

fn warn_once_keyed(key: String, message: String) {
    let mut guard = warned_set().lock().expect("shadow-home warn set poisoned");
    if guard.insert(key) {
        eprintln!("{message}");
    }
}

// ---------------------------------------------------------------------------
// Retry primitives.
// ---------------------------------------------------------------------------

fn error_code_of(error: &io::Error) -> Option<&'static str> {
    cma_core::fs_retry::code_of(error)
}

/// TS `isRetryableShadowHomeCleanupError`.
pub fn is_retryable_shadow_home_cleanup_error(error: &io::Error) -> bool {
    matches!(error_code_of(error), Some(code) if RETRYABLE_SHADOW_HOME_CLEANUP_CODES.contains(&code))
}

fn sleep_sync(ms: u64) {
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

/// TS `removeDirectoryWithRetry(targetPath)` — `rmSync(recursive, force)` with
/// EBUSY/EPERM/ENOTEMPTY backoff 20/60/120 ms.
pub fn remove_directory_with_retry(target_path: &Path) -> io::Result<()> {
    let mut attempt = 0usize;
    loop {
        let result = maybe_simulated_cleanup_busy().and_then(|()| {
            match fs::remove_dir_all(target_path) {
                Ok(()) => Ok(()),
                // force:true semantics — missing target is success.
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(e) => {
                    // Non-directory targets: force-remove the file.
                    if target_path.is_file() {
                        match fs::remove_file(target_path) {
                            Ok(()) => Ok(()),
                            Err(e2) if e2.kind() == io::ErrorKind::NotFound => Ok(()),
                            Err(e2) => Err(e2),
                        }
                    } else {
                        Err(e)
                    }
                }
            }
        });
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !is_retryable_shadow_home_cleanup_error(&error)
                    || attempt == SHADOW_HOME_CLEANUP_BACKOFF_MS.len()
                {
                    return Err(error);
                }
                sleep_sync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
                attempt += 1;
            }
        }
    }
}

/// TS `removeDirectoryBestEffortAsync` — best-effort removal that never blocks
/// the caller (detached thread; failures reclaimed by stale-lock recovery).
pub fn remove_directory_best_effort_detached(target_path: PathBuf) {
    std::thread::spawn(move || {
        for _ in 0..4 {
            match fs::remove_dir_all(&target_path) {
                Ok(()) => return,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return,
                Err(_) => sleep_sync(20),
            }
        }
    });
}

// ---------------------------------------------------------------------------
// File state snapshots.
// ---------------------------------------------------------------------------

/// TS `captureShadowHomeState` result.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ShadowFileState {
    pub exists: bool,
    pub content: Option<String>,
    pub unreadable: bool,
}

impl ShadowFileState {
    pub fn missing() -> Self {
        Self {
            exists: false,
            content: None,
            unreadable: false,
        }
    }
}

/// TS `captureShadowHomeState(filePath)` (non-rethrowing form).
pub fn capture_shadow_home_state(file_path: &Path) -> ShadowFileState {
    capture_shadow_home_state_inner(file_path, false).unwrap_or(ShadowFileState {
        exists: true,
        content: None,
        unreadable: true,
    })
}

/// TS `captureShadowHomeState(filePath, { rethrowRetryableReadErrors: true })`.
pub fn capture_shadow_home_state_rethrow(file_path: &Path) -> io::Result<ShadowFileState> {
    capture_shadow_home_state_inner(file_path, true)
}

fn capture_shadow_home_state_inner(
    file_path: &Path,
    rethrow_retryable: bool,
) -> io::Result<ShadowFileState> {
    if !file_path.exists() {
        return Ok(ShadowFileState::missing());
    }
    if rethrow_retryable && take_injected_failure(preflight_read_busy_failures()) {
        return Err(busy_error("simulated busy shadow-home preflight read"));
    }
    match fs::read(file_path) {
        Ok(bytes) => Ok(ShadowFileState {
            exists: true,
            content: Some(String::from_utf8_lossy(&bytes).into_owned()),
            unreadable: false,
        }),
        Err(error) => {
            if rethrow_retryable && is_retryable_shadow_home_cleanup_error(&error) {
                return Err(error);
            }
            Ok(ShadowFileState {
                exists: true,
                content: None,
                unreadable: true,
            })
        }
    }
}

/// TS `shadowHomeStateMatches(left, right)`.
pub fn shadow_home_state_matches(left: &ShadowFileState, right: &ShadowFileState) -> bool {
    left.exists == right.exists
        && left.content == right.content
        && left.unreadable == right.unreadable
}

/// TS `hashShadowHomeState(state)` — `None` for unreadable / non-string,
/// `"missing"` for absent files, else `sha256:<hex>` of the content.
pub fn hash_shadow_home_state(state: &ShadowFileState) -> Option<String> {
    if state.unreadable {
        return None;
    }
    if !state.exists {
        return Some("missing".to_string());
    }
    state
        .content
        .as_ref()
        .map(|content| format!("sha256:{}", compute_sha256(content)))
}

// ---------------------------------------------------------------------------
// Sync-state metadata (`.codex-multi-auth-shadow-sync-state.json`).
// ---------------------------------------------------------------------------

/// TS `readShadowHomeSyncState(originalCodexHome)` — tolerant `{version:1,
/// files:{}}` fallback.
pub fn read_shadow_home_sync_state(original_codex_home: &Path) -> serde_json::Value {
    let path = original_codex_home.join(SHADOW_HOME_SYNC_STATE_FILE);
    let fallback = serde_json::json!({ "version": 1, "files": {} });
    let Ok(raw) = fs::read_to_string(&path) else {
        return fallback;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return fallback;
    };
    let valid = parsed.is_object()
        && parsed.get("version").and_then(serde_json::Value::as_i64) == Some(1)
        && parsed.get("files").is_some_and(serde_json::Value::is_object);
    if valid { parsed } else { fallback }
}

/// TS `rememberShadowHomeSyncState` — records `{baseHash, syncedHash,
/// updatedAt}` for `name`; silently skipped when either hash is unavailable
/// or the metadata write fails.
pub fn remember_shadow_home_sync_state(
    original_codex_home: &Path,
    sync_state: &mut serde_json::Value,
    name: &str,
    base_state: &ShadowFileState,
    synced_state: &ShadowFileState,
) {
    let (Some(base_hash), Some(synced_hash)) = (
        hash_shadow_home_state(base_state),
        hash_shadow_home_state(synced_state),
    ) else {
        return;
    };
    if let Some(files) = sync_state
        .get_mut("files")
        .and_then(serde_json::Value::as_object_mut)
    {
        files.insert(
            name.to_string(),
            serde_json::json!({
                "baseHash": base_hash,
                "syncedHash": synced_hash,
                "updatedAt": cma_core::utils::now_ms(),
            }),
        );
    }
    let _ = write_owner_only_json_file_atomic_sync(
        &original_codex_home.join(SHADOW_HOME_SYNC_STATE_FILE),
        sync_state,
    );
}

/// TS `canRebaseShadowHomeSyncState` — permit a later shadow session to write
/// over an earlier shadow sync from the same launch snapshot.
pub fn can_rebase_shadow_home_sync_state(
    sync_state: &serde_json::Value,
    name: &str,
    base_state: &ShadowFileState,
    current_state: &ShadowFileState,
) -> bool {
    let Some(entry) = sync_state
        .get("files")
        .and_then(|files| files.get(name))
        .filter(|entry| entry.is_object())
    else {
        return false;
    };
    entry.get("baseHash").and_then(serde_json::Value::as_str)
        == hash_shadow_home_state(base_state).as_deref()
        && entry.get("syncedHash").and_then(serde_json::Value::as_str)
            == hash_shadow_home_state(current_state).as_deref()
}

// ---------------------------------------------------------------------------
// Owner-only atomic JSON writer (TS `writeOwnerOnlyJsonFileAtomicSync`).
// ---------------------------------------------------------------------------

fn tighten_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path; // Node parity: chmod is best-effort/no-op on Windows.
    }
}

/// TS `writeOwnerOnlyJsonFileAtomicSync(targetPath, payload)` —
/// `JSON.stringify(payload, null, 2) + "\n"`, 0600, temp+rename with
/// EBUSY/EPERM/ENOTEMPTY backoff 20/60/120.
pub fn write_owner_only_json_file_atomic_sync(
    target_path: &Path,
    payload: &serde_json::Value,
) -> io::Result<()> {
    let target_dir = target_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&target_dir)?;
    let base_name = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("payload.json");
    let serialized = format!("{}\n", cma_core::json_io::stringify_pretty2(payload));
    let mut attempt = 0usize;
    loop {
        let temp_path = target_dir.join(format!(
            ".{base_name}.{}.{}.{}.tmp",
            std::process::id(),
            cma_core::utils::now_ms(),
            random_hex(8),
        ));
        let result = (|| -> io::Result<()> {
            fs::write(&temp_path, serialized.as_bytes())?;
            tighten_file_permissions(&temp_path);
            if take_injected_failure(sync_metadata_busy_failures())
                && target_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n == SHADOW_HOME_SYNC_STATE_FILE)
            {
                return Err(busy_error("simulated busy shadow-home sync metadata write"));
            }
            fs::rename(&temp_path, target_path)?;
            tighten_file_permissions(target_path);
            Ok(())
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                let _ = fs::remove_file(&temp_path);
                if is_retryable_shadow_home_cleanup_error(&error)
                    && attempt < SHADOW_HOME_CLEANUP_BACKOFF_MS.len()
                {
                    sleep_sync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
                    attempt += 1;
                    continue;
                }
                return Err(error);
            }
        }
    }
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes / 2];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Sync lock (`.codex-multi-auth-shadow-sync.lock` directory + owner.json).
// ---------------------------------------------------------------------------

fn read_shadow_home_sync_lock_owner_pid(lock_path: &Path) -> Option<i64> {
    let raw = fs::read_to_string(lock_path.join("owner.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let pid = value.get("pid")?.as_i64()?;
    if pid > 0 { Some(pid) } else { None }
}

fn is_shadow_home_sync_lock_old_enough_to_steal(lock_path: &Path) -> bool {
    match fs::metadata(lock_path) {
        Ok(meta) => {
            let newest = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            cma_core::utils::now_ms() - newest >= SHADOW_HOME_ORPHAN_LOCK_STALE_AGE_MS
        }
        Err(_) => true,
    }
}

fn remove_stale_shadow_home_sync_lock(lock_path: &Path) -> bool {
    let owner_pid = read_shadow_home_sync_lock_owner_pid(lock_path);
    if let Some(pid) = owner_pid
        && cma_runtime::app_bind::is_process_alive(Some(pid))
    {
        return false;
    }
    if owner_pid.is_none() && !is_shadow_home_sync_lock_old_enough_to_steal(lock_path) {
        return false;
    }
    remove_directory_with_retry(lock_path).is_ok()
}

fn write_shadow_home_sync_lock_owner(lock_path: &Path, pid: u32) -> io::Result<()> {
    if take_injected_failure(lock_owner_write_failures()) {
        return Err(cma_core::fs_retry::io_error_with_code(
            "EPERM",
            "simulated shadow sync lock owner write failure".to_string(),
        ));
    }
    let owner_path = lock_path.join("owner.json");
    let payload = serde_json::json!({ "pid": pid, "createdAt": cma_core::utils::now_ms() });
    fs::write(
        &owner_path,
        format!("{}\n", cma_core::json_io::stringify_compact(&payload)),
    )?;
    tighten_file_permissions(&owner_path);
    Ok(())
}

fn write_shadow_home_sync_lock_owner_with_retry(lock_path: &Path, pid: u32) -> io::Result<()> {
    let mut attempt = 0usize;
    loop {
        match write_shadow_home_sync_lock_owner(lock_path, pid) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !is_retryable_shadow_home_cleanup_error(&error)
                    || attempt == SHADOW_HOME_CLEANUP_BACKOFF_MS.len()
                {
                    return Err(error);
                }
                sleep_sync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
                attempt += 1;
            }
        }
    }
}

/// Held sync lock; released (best-effort) on [`ShadowHomeSyncLock::release`]
/// or drop.
pub struct ShadowHomeSyncLock {
    lock_path: Option<PathBuf>,
}

impl ShadowHomeSyncLock {
    pub fn release(mut self) {
        self.release_inner();
    }

    fn release_inner(&mut self) {
        if let Some(path) = self.lock_path.take() {
            let _ = remove_directory_with_retry(&path);
        }
    }
}

impl Drop for ShadowHomeSyncLock {
    fn drop(&mut self) {
        self.release_inner();
    }
}

/// TS `acquireShadowHomeSyncLock(originalCodexHome)` — `mkdir` claim with
/// owner.json, stale-lock takeover, bounded wait (deadline = stale age + Σ
/// backoff), then error.
pub fn acquire_shadow_home_sync_lock(original_codex_home: &Path) -> io::Result<ShadowHomeSyncLock> {
    let lock_path = original_codex_home.join(SHADOW_HOME_SYNC_LOCK_DIR);
    fs::create_dir_all(original_codex_home)?;
    let max_stale_recoveries = SHADOW_HOME_CLEANUP_BACKOFF_MS.len() + 1;
    let mut stale_recoveries = 0usize;
    let mut attempt = 0usize;
    let deadline = cma_core::utils::now_ms() + SHADOW_HOME_SYNC_LOCK_WAIT_TIMEOUT_MS;
    loop {
        match fs::create_dir(&lock_path) {
            Ok(()) => {
                if let Err(error) =
                    write_shadow_home_sync_lock_owner_with_retry(&lock_path, std::process::id())
                {
                    let _ = remove_directory_with_retry(&lock_path);
                    return Err(error);
                }
                return Ok(ShadowHomeSyncLock {
                    lock_path: Some(lock_path),
                });
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
                if stale_recoveries < max_stale_recoveries
                    && remove_stale_shadow_home_sync_lock(&lock_path)
                {
                    stale_recoveries += 1;
                    attempt = 0;
                    continue;
                }
                let remaining_ms = deadline - cma_core::utils::now_ms();
                if remaining_ms <= 0 {
                    return Err(error);
                }
                let backoff_ms = SHADOW_HOME_CLEANUP_BACKOFF_MS
                    [attempt.min(SHADOW_HOME_CLEANUP_BACKOFF_MS.len() - 1)];
                sleep_sync(backoff_ms.min(remaining_ms as u64));
                attempt += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// State-file sync-back.
// ---------------------------------------------------------------------------

fn ensure_destination_matches_snapshot(
    destination_path: &Path,
    expected_state: Option<&ShadowFileState>,
) -> io::Result<()> {
    let Some(expected) = expected_state else {
        return Ok(());
    };
    let current = capture_shadow_home_state_rethrow(destination_path)?;
    if !shadow_home_state_matches(&current, expected) {
        return Err(cma_core::fs_retry::io_error_with_code(
            "EEXIST",
            "shadow-home destination changed during sync-back retry".to_string(),
        ));
    }
    Ok(())
}

fn rename_file_with_retry(
    source_path: &Path,
    destination_path: &Path,
    expected_destination_state: Option<&ShadowFileState>,
) -> io::Result<()> {
    let mut attempt = 0usize;
    loop {
        let result = ensure_destination_matches_snapshot(destination_path, expected_destination_state)
            .and_then(|()| maybe_simulated_cleanup_busy())
            .and_then(|()| fs::rename(source_path, destination_path));
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !is_retryable_shadow_home_cleanup_error(&error)
                    || attempt == SHADOW_HOME_CLEANUP_BACKOFF_MS.len()
                {
                    return Err(error);
                }
                sleep_sync(SHADOW_HOME_CLEANUP_BACKOFF_MS[attempt]);
                attempt += 1;
            }
        }
    }
}

/// TS `syncShadowHomeStateFile` — copy to a sibling temp then rename over the
/// destination (with destination-change detection).
pub fn sync_shadow_home_state_file(
    source_path: &Path,
    destination_path: &Path,
    expected_destination_state: Option<&ShadowFileState>,
) -> io::Result<()> {
    let dest_dir = destination_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let base = destination_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("state");
    let temp_path = dest_dir.join(format!(
        ".{base}.codex-multi-auth-sync-{}.tmp",
        std::process::id()
    ));
    let result = (|| -> io::Result<()> {
        fs::create_dir_all(&dest_dir)?;
        fs::copy(source_path, &temp_path)?;
        rename_file_with_retry(&temp_path, destination_path, expected_destination_state)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn sync_shadow_home_state_file_best_effort(
    source_path: &Path,
    destination_path: &Path,
    expected_destination_state: Option<&ShadowFileState>,
) -> bool {
    match sync_shadow_home_state_file(source_path, destination_path, expected_destination_state) {
        Ok(()) => {
            tighten_file_permissions(destination_path);
            true
        }
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Directory / file mirroring into the shadow home.
// ---------------------------------------------------------------------------

fn is_directory_like(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

fn is_file_like(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

fn force_shadow_dir_copy() -> bool {
    std::env::var("CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_DIR_COPY")
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

fn symlink_dir_impl(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, destination)
    }
    #[cfg(windows)]
    {
        // Node parity: `fs.symlinkSync(source, destination, "junction")` —
        // on win32 the JS launcher creates NTFS junctions, which need NO
        // privilege. `std::os::windows::fs::symlink_dir` requires
        // SeCreateSymbolicLinkPrivilege / Developer Mode and fails for a
        // standard user, which would skip every link-only dir (sqlite,
        // cache, …) and degrade sessions/plugins/skills to full copies.
        // Junctions require an absolute target; the call sites pass absolute
        // paths, but canonicalize-by-joining defensively for relative ones.
        let absolute_source = if source.is_absolute() {
            source.to_path_buf()
        } else {
            std::env::current_dir()?.join(source)
        };
        junction::create(&absolute_source, destination)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source, destination);
        Err(io::Error::other("symlinks unsupported"))
    }
}

fn symlink_file_impl(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, destination)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(source, destination)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source, destination);
        Err(io::Error::other("symlinks unsupported"))
    }
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_symlink() {
            // dereference:false parity — recreate the link target reference
            // (best effort: fall back to copying the resolved file).
            #[cfg(unix)]
            {
                if let Ok(target) = fs::read_link(&from) {
                    let _ = std::os::unix::fs::symlink(&target, &to);
                    continue;
                }
            }
            if is_directory_like(&from) {
                copy_dir_recursive(&from, &to)?;
            } else if fs::copy(&from, &to).is_err() {
                continue;
            }
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// TS `mirrorDirectoryIntoShadowHome` — link preferred, copy fallback.
/// Returns `"linked"` or `"copied"`.
fn mirror_directory_into_shadow_home(source: &Path, destination: &Path) -> io::Result<&'static str> {
    if !force_shadow_dir_copy() && symlink_dir_impl(source, destination).is_ok() {
        return Ok("linked");
    }
    copy_dir_recursive(source, destination)?;
    Ok("copied")
}

fn link_directory_into_shadow_home(source: &Path, destination: &Path) -> bool {
    !force_shadow_dir_copy() && symlink_dir_impl(source, destination).is_ok()
}

fn warn_skipped_link_only_directory(name: &str) {
    warn_once_keyed(
        format!("link-only-dir:{name}"),
        format!(
            "codex-multi-auth: skipped optional shadow-home directory {name} because linking failed; refusing to copy generated runtime data."
        ),
    );
}

fn should_copy_runtime_generated_dirs_fallback() -> bool {
    let normalized = std::env::var("CODEX_MULTI_AUTH_RUNTIME_SHADOW_COPY_GENERATED_DIRS")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    normalized == "1" || normalized == "true" || normalized == "yes"
}

fn link_file_into_shadow_home(source: &Path, destination: &Path) -> bool {
    if symlink_file_impl(source, destination).is_ok() {
        return true;
    }
    fs::hard_link(source, destination).is_ok()
}

fn mirror_file_into_shadow_home(source: &Path, destination: &Path) -> io::Result<()> {
    if link_file_into_shadow_home(source, destination) {
        return Ok(());
    }
    fs::copy(source, destination)?;
    tighten_file_permissions(destination);
    Ok(())
}

fn is_sqlite_main_file(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".sqlite")
}

fn is_sqlite_sidecar_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".sqlite-shm") || lower.ends_with(".sqlite-wal")
}

fn normalize_runtime_entry_name(name: &str) -> String {
    if cfg!(any(windows, target_os = "macos")) {
        name.to_ascii_lowercase()
    } else {
        name.to_string()
    }
}

fn is_codex_runtime_local_sqlite_file(name: &str) -> bool {
    let normalized = normalize_runtime_entry_name(name);
    let Some(rest) = normalized
        .strip_prefix("state_")
        .or_else(|| normalized.strip_prefix("logs_"))
    else {
        return false;
    };
    let digits_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    if digits_end == 0 {
        return false;
    }
    matches!(
        &rest[digits_end..],
        ".sqlite" | ".sqlite-shm" | ".sqlite-wal"
    )
}

fn is_codex_runtime_transient_state_file(name: &str) -> bool {
    let normalized = normalize_runtime_entry_name(name);
    // /^(?:auth|accounts)\.json\.\d+\.[a-z0-9]+\.tmp$/
    for prefix in ["auth.json.", "accounts.json."] {
        if let Some(rest) = normalized.strip_prefix(prefix)
            && let Some(rest) = rest.strip_suffix(".tmp")
        {
            let mut parts = rest.splitn(2, '.');
            let digits = parts.next().unwrap_or("");
            let nonce = parts.next().unwrap_or("");
            if !digits.is_empty()
                && digits.chars().all(|c| c.is_ascii_digit())
                && !nonce.is_empty()
                && nonce.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            {
                return true;
            }
        }
    }
    // /^\.codex-global-state\.json\.tmp-[a-z0-9-]+$/
    if let Some(rest) = normalized.strip_prefix(".codex-global-state.json.tmp-") {
        return !rest.is_empty()
            && rest
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    }
    false
}

/// TS `isRuntimeRotationShadowHomeOmittedEntry(name)`.
pub fn is_runtime_rotation_shadow_home_omitted_entry(name: &str) -> bool {
    let normalized = normalize_runtime_entry_name(name);
    RUNTIME_ROTATION_SHADOW_HOME_OMIT_ROOT_DIRS.contains(&normalized.as_str())
        || is_codex_runtime_local_sqlite_file(name)
        || is_codex_runtime_transient_state_file(name)
}

/// TS `isRuntimeRotationShadowHomeLinkOnlyDirectory(name)`.
pub fn is_runtime_rotation_shadow_home_link_only_directory(name: &str) -> bool {
    let normalized = normalize_runtime_entry_name(name);
    RUNTIME_ROTATION_SHADOW_HOME_LINK_ONLY_ROOT_DIRS.contains(&normalized.as_str())
}

fn should_materialize_file_into_shadow_home(name: &str) -> bool {
    is_sqlite_main_file(name) || is_sqlite_sidecar_file(name)
}

fn warn_skipped_sqlite_materialization() {
    warn_once_keyed(
        "sqlite-link-failure".to_string(),
        "codex-multi-auth: skipped SQLite shadow-home materialization because linking failed; refusing to copy active SQLite state.".to_string(),
    );
}

fn warn_skipped_sqlite_sidecar_placeholder(error: &io::Error, destination: &Path) {
    warn_once_keyed(
        format!("sqlite-sidecar:{}", destination.display()),
        format!(
            "codex-multi-auth: skipped SQLite shadow-home sidecar placeholder for {} because linking failed: {error}",
            destination.display()
        ),
    );
}

fn materialize_sqlite_sidecar_placeholder(source_sidecar: &Path, destination_sidecar: &Path) -> bool {
    if std::env::var("CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SIDECAR_PLACEHOLDER_FAILURE")
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
    {
        let error = cma_core::fs_retry::io_error_with_code(
            "EPERM",
            "simulated SQLite sidecar placeholder failure".to_string(),
        );
        warn_skipped_sqlite_sidecar_placeholder(&error, destination_sidecar);
        return false;
    }
    match symlink_file_impl(source_sidecar, destination_sidecar) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => true,
        Err(error) => {
            warn_skipped_sqlite_sidecar_placeholder(&error, destination_sidecar);
            false
        }
    }
}

fn materialize_file_into_shadow_home(source: &Path, destination: &Path) -> bool {
    let forced_sidecar_failure =
        std::env::var("CODEX_MULTI_AUTH_TEST_FORCE_SHADOW_SQLITE_SIDECAR_LINK_FAILURE")
            .map(|v| v.trim() == "1")
            .unwrap_or(false)
            && source
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_sqlite_sidecar_file);
    if forced_sidecar_failure || !link_file_into_shadow_home(source, destination) {
        warn_skipped_sqlite_materialization();
        return false;
    }
    true
}

fn materialize_sqlite_sidecars_into_shadow_home(source: &Path, destination: &Path) -> bool {
    for suffix in ["-wal", "-shm"] {
        let source_sidecar = PathBuf::from(format!("{}{suffix}", source.display()));
        let destination_sidecar = PathBuf::from(format!("{}{suffix}", destination.display()));
        if destination_sidecar.exists() {
            continue;
        }
        if source_sidecar.exists() {
            if !materialize_file_into_shadow_home(&source_sidecar, &destination_sidecar)
                && !materialize_sqlite_sidecar_placeholder(&source_sidecar, &destination_sidecar)
            {
                return false;
            }
            continue;
        }
        if !materialize_sqlite_sidecar_placeholder(&source_sidecar, &destination_sidecar) {
            return false;
        }
    }
    true
}

fn remove_sqlite_shadow_home_materialization(destination: &Path) {
    for path in [
        destination.to_path_buf(),
        PathBuf::from(format!("{}-wal", destination.display())),
        PathBuf::from(format!("{}-shm", destination.display())),
    ] {
        let _ = fs::remove_file(&path);
    }
}

// ---------------------------------------------------------------------------
// Mirror creation + sync-back closure.
// ---------------------------------------------------------------------------

/// Predicate type used by [`MirrorOptions`].
pub type NamePredicate = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Options for [`create_shadow_home_mirror`] (TS `createShadowHomeMirror`
/// options bag).
#[derive(Clone, Default)]
pub struct MirrorOptions {
    pub skip_sync_back_names: Vec<String>,
    pub skip_mirror_predicate: Option<NamePredicate>,
    pub skip_sync_back_predicate: Option<NamePredicate>,
    pub link_only_directory_predicate: Option<NamePredicate>,
}

impl MirrorOptions {
    /// The runtime-rotation option set (omit official auth state, link-only
    /// generated dirs).
    pub fn runtime_rotation() -> Self {
        Self {
            skip_sync_back_names: RUNTIME_ROTATION_SHADOW_HOME_OMIT_STATE_FILES
                .iter()
                .map(|s| s.to_string())
                .collect(),
            skip_mirror_predicate: Some(Arc::new(is_runtime_rotation_shadow_home_omitted_entry)),
            skip_sync_back_predicate: Some(Arc::new(is_runtime_rotation_shadow_home_omitted_entry)),
            link_only_directory_predicate: Some(Arc::new(
                is_runtime_rotation_shadow_home_link_only_directory,
            )),
        }
    }
}

/// The sync-back handle returned by [`create_shadow_home_mirror`]; call
/// [`ShadowHomeSyncBack::run`] before removing the shadow home.
pub struct ShadowHomeSyncBack {
    original_codex_home: PathBuf,
    shadow_codex_home: PathBuf,
    sync_file_names: HashSet<String>,
    original_file_states: HashMap<String, ShadowFileState>,
    copied_directory_names: HashSet<String>,
    options: MirrorOptions,
}

impl ShadowHomeSyncBack {
    /// TS: the closure returned by `createShadowHomeMirror` — best-effort
    /// (never propagates errors).
    pub fn run(&self) {
        let names =
            collect_shadow_home_sync_file_names(&self.shadow_codex_home, &self.sync_file_names);
        let Ok(lock) = acquire_shadow_home_sync_lock(&self.original_codex_home) else {
            return;
        };
        self.sync_auth_bundle();
        self.sync_copied_directories();
        self.sync_additional_files(&names);
        lock.release();
    }

    fn skip_sync_back(&self, name: &str) -> bool {
        self.options
            .skip_sync_back_names
            .iter()
            .any(|skip| skip == name)
    }

    fn skip_sync_back_predicate(&self, name: &str) -> bool {
        self.options
            .skip_sync_back_predicate
            .as_ref()
            .is_some_and(|p| p(name))
    }

    /// TS `syncShadowHomeAuthBundle`.
    fn sync_auth_bundle(&self) {
        let mut sync_state = read_shadow_home_sync_state(&self.original_codex_home);
        for name in SHADOW_HOME_STATE_FILES {
            if self.skip_sync_back(name) {
                continue;
            }
            let shadow_path = self.shadow_codex_home.join(name);
            let shadow_state = capture_shadow_home_state(&shadow_path);
            if !shadow_state.exists || shadow_state.unreadable {
                continue;
            }
            let original_path = self.original_codex_home.join(name);
            let original_snapshot = self
                .original_file_states
                .get(*name)
                .cloned()
                .unwrap_or_else(ShadowFileState::missing);
            let current_original_state = capture_shadow_home_state(&original_path);
            let mut expected_destination_state = original_snapshot.clone();
            if !shadow_home_state_matches(&current_original_state, &original_snapshot) {
                if !can_rebase_shadow_home_sync_state(
                    &sync_state,
                    name,
                    &original_snapshot,
                    &current_original_state,
                ) {
                    continue;
                }
                expected_destination_state = current_original_state;
            }
            if expected_destination_state.unreadable
                || shadow_home_state_matches(&shadow_state, &expected_destination_state)
            {
                continue;
            }
            if sync_shadow_home_state_file_best_effort(
                &shadow_path,
                &original_path,
                Some(&expected_destination_state),
            ) {
                remember_shadow_home_sync_state(
                    &self.original_codex_home,
                    &mut sync_state,
                    name,
                    &original_snapshot,
                    &shadow_state,
                );
            }
        }
    }

    /// TS `syncCopiedShadowHomeDirectories`.
    fn sync_copied_directories(&self) {
        for name in &self.copied_directory_names {
            let shadow_path = self.shadow_codex_home.join(name);
            if !is_directory_like(&shadow_path) {
                continue;
            }
            let _ = copy_dir_recursive(&shadow_path, &self.original_codex_home.join(name));
        }
    }

    /// TS `syncAdditionalShadowHomeFiles`.
    fn sync_additional_files(&self, names: &HashSet<String>) {
        for name in names {
            if SHADOW_HOME_STATE_FILES.contains(&name.as_str())
                || self.skip_sync_back(name)
                || self.skip_sync_back_predicate(name)
            {
                continue;
            }
            let shadow_path = self.shadow_codex_home.join(name);
            let shadow_state = capture_shadow_home_state(&shadow_path);
            if !shadow_state.exists || shadow_state.unreadable {
                continue;
            }
            let original_path = self.original_codex_home.join(name);
            let original_snapshot = self
                .original_file_states
                .get(name)
                .cloned()
                .unwrap_or_else(ShadowFileState::missing);
            let current_original_state = capture_shadow_home_state(&original_path);
            if !shadow_home_state_matches(&current_original_state, &original_snapshot) {
                continue;
            }
            if shadow_home_state_matches(&shadow_state, &original_snapshot) {
                continue;
            }
            let _ = sync_shadow_home_state_file_best_effort(
                &shadow_path,
                &original_path,
                Some(&original_snapshot),
            );
        }
    }
}

/// TS `collectShadowHomeSyncFileNames` — root-level files of the shadow home
/// beyond the known set (created during the run) so they sync back too.
fn collect_shadow_home_sync_file_names(
    shadow_codex_home: &Path,
    seed: &HashSet<String>,
) -> HashSet<String> {
    let mut names = seed.clone();
    let Ok(entries) = fs::read_dir(shadow_codex_home) else {
        return names;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == SHADOW_HOME_CONFIG_FILE
            || name == SHADOW_HOME_SYNC_STATE_FILE
            || names.contains(&name)
        {
            continue;
        }
        let shadow_path = shadow_codex_home.join(&name);
        let file_like = match entry.file_type() {
            Ok(ft) if ft.is_symlink() => is_file_like(&shadow_path),
            Ok(ft) => ft.is_file(),
            Err(_) => false,
        };
        if file_like {
            names.insert(name);
        }
    }
    names
}

/// TS `createShadowHomeMirror(originalCodexHome, shadowCodexHome, tighten,
/// options)` — mirrors the real home into the shadow and returns the
/// sync-back handle. Known state files that fail to mirror ABORT (error);
/// optional entries fail soft.
pub fn create_shadow_home_mirror(
    original_codex_home: &Path,
    shadow_codex_home: &Path,
    options: MirrorOptions,
) -> io::Result<ShadowHomeSyncBack> {
    let mut sync_file_names: HashSet<String> = SHADOW_HOME_STATE_FILES
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut original_file_states: HashMap<String, ShadowFileState> = HashMap::new();
    let mut copied_directory_names: HashSet<String> = HashSet::new();

    let remember_sync_file =
        |name: &str,
         original_file_states: &mut HashMap<String, ShadowFileState>,
         sync_file_names: &mut HashSet<String>| {
            if !original_file_states.contains_key(name) {
                original_file_states.insert(
                    name.to_string(),
                    capture_shadow_home_state(&original_codex_home.join(name)),
                );
            }
            sync_file_names.insert(name.to_string());
        };

    for name in SHADOW_HOME_STATE_FILES {
        remember_sync_file(name, &mut original_file_states, &mut sync_file_names);
    }

    if original_codex_home.exists() {
        for entry in fs::read_dir(original_codex_home)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == SHADOW_HOME_CONFIG_FILE
                || name == SHADOW_HOME_SYNC_STATE_FILE
                || name == SHADOW_HOME_SYNC_LOCK_DIR
                || options
                    .skip_mirror_predicate
                    .as_ref()
                    .is_some_and(|p| p(&name))
            {
                continue;
            }
            let is_known_state_file = SHADOW_HOME_STATE_FILES.contains(&name.as_str());
            let should_materialize = should_materialize_file_into_shadow_home(&name);
            let source_path = original_codex_home.join(&name);
            let destination_path = shadow_codex_home.join(&name);
            if destination_path.exists() {
                continue;
            }

            let (directory_like, file_like) = match entry.file_type() {
                Ok(ft) if ft.is_symlink() => {
                    let dir = is_directory_like(&source_path);
                    (dir, !dir && is_file_like(&source_path))
                }
                Ok(ft) => (ft.is_dir(), ft.is_file()),
                Err(_) => (false, false),
            };

            let mirror_result = (|| -> io::Result<()> {
                if is_known_state_file && !file_like {
                    return Err(io::Error::other(format!("Expected {name} to be a file")));
                }
                if directory_like {
                    if options
                        .link_only_directory_predicate
                        .as_ref()
                        .is_some_and(|p| p(&name))
                        && !should_copy_runtime_generated_dirs_fallback()
                    {
                        if !link_directory_into_shadow_home(&source_path, &destination_path) {
                            warn_skipped_link_only_directory(&name);
                        }
                        return Ok(());
                    }
                    if mirror_directory_into_shadow_home(&source_path, &destination_path)?
                        == "copied"
                    {
                        copied_directory_names.insert(name.clone());
                    }
                    return Ok(());
                }
                if file_like {
                    remember_sync_file(&name, &mut original_file_states, &mut sync_file_names);
                    if is_known_state_file {
                        fs::copy(&source_path, &destination_path)?;
                        tighten_file_permissions(&destination_path);
                    } else if should_materialize {
                        if is_sqlite_sidecar_file(&name) {
                            return Ok(());
                        }
                        if materialize_file_into_shadow_home(&source_path, &destination_path)
                            && is_sqlite_main_file(&name)
                            && !materialize_sqlite_sidecars_into_shadow_home(
                                &source_path,
                                &destination_path,
                            )
                        {
                            remove_sqlite_shadow_home_materialization(&destination_path);
                        }
                    } else {
                        mirror_file_into_shadow_home(&source_path, &destination_path)?;
                    }
                }
                Ok(())
            })();
            if let Err(error) = mirror_result
                && is_known_state_file
            {
                return Err(error);
            }
            // Optional entries never block launch.
        }
    }

    Ok(ShadowHomeSyncBack {
        original_codex_home: original_codex_home.to_path_buf(),
        shadow_codex_home: shadow_codex_home.to_path_buf(),
        sync_file_names,
        original_file_states,
        copied_directory_names,
        options,
    })
}

// ---------------------------------------------------------------------------
// Runtime-rotation shadow home creation + config.toml assembly.
// ---------------------------------------------------------------------------

/// TS `omitRuntimeRotationShadowHomeStateFiles(shadowCodexHome)`.
pub fn omit_runtime_rotation_shadow_home_state_files(shadow_codex_home: &Path) {
    for name in RUNTIME_ROTATION_SHADOW_HOME_OMIT_STATE_FILES {
        let target = shadow_codex_home.join(name);
        if !target.exists() {
            continue;
        }
        if is_directory_like(&target) {
            let _ = remove_directory_with_retry(&target);
        } else {
            let _ = fs::remove_file(&target);
        }
    }
}

/// TS `createRuntimeRotationShadowHome(originalCodexHome)` — mkdtemp under
/// `<home>/multi-auth/runtime-shadow-homes/codex-multi-auth-runtime-home-*`.
pub fn create_runtime_rotation_shadow_home(original_codex_home: &Path) -> io::Result<PathBuf> {
    let shadow_root = original_codex_home
        .join("multi-auth")
        .join("runtime-shadow-homes");
    fs::create_dir_all(&shadow_root)?;
    for _ in 0..64 {
        let candidate = shadow_root.join(format!(
            "codex-multi-auth-runtime-home-{}",
            random_hex(12)
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::other(
        "failed to create runtime rotation shadow home",
    ))
}

// --- hooks.state trust mirroring (TS parseHookStateTableKey + TOML scan) ---

/// TS `parseHookStateTableKey(line)`.
pub fn parse_hook_state_table_key(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let inner = trimmed.strip_prefix('[')?.strip_suffix(']')?.trim();
    let rest = inner.strip_prefix("hooks.state.")?.trim();
    if rest.len() >= 2 && rest.starts_with('"') && rest.ends_with('"') {
        // Basic string — JSON-decode.
        return serde_json::from_str::<String>(rest).ok();
    }
    if rest.len() >= 2 && rest.starts_with('\'') && rest.ends_with('\'') {
        let inner = &rest[1..rest.len() - 1];
        if !inner.contains('\'') {
            return Some(inner.to_string());
        }
    }
    None
}

/// TS `isTomlTableLine(line)` — heuristic table/array-of-tables header check.
pub fn is_toml_table_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let Some(rest) = trimmed.strip_prefix('[') else {
        return false;
    };
    let rest = rest.strip_prefix('[').unwrap_or(rest);
    let rest = rest.trim_start();
    if rest.starts_with('"') || rest.starts_with('\'') {
        return true;
    }
    let key_len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .unwrap_or(rest.len());
    if key_len == 0 {
        return false;
    }
    let after = rest[key_len..].trim_start();
    after.starts_with('.')
        || after.starts_with(']')
}

#[derive(Debug, Default)]
struct TomlBlockScanState {
    array_depth: usize,
    multiline_string_delimiter: Option<&'static str>,
}

impl TomlBlockScanState {
    fn is_top_level(&self) -> bool {
        self.array_depth == 0 && self.multiline_string_delimiter.is_none()
    }

    fn update(&mut self, line: &str) {
        let bytes = line.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if let Some(delim) = self.multiline_string_delimiter {
                match line[index..].find(delim) {
                    Some(offset) => {
                        index += offset + delim.len();
                        self.multiline_string_delimiter = None;
                        continue;
                    }
                    None => return,
                }
            }
            let ch = bytes[index];
            if ch == b'#' {
                return;
            }
            if line[index..].starts_with("\"\"\"") {
                self.multiline_string_delimiter = Some("\"\"\"");
                index += 3;
                continue;
            }
            if line[index..].starts_with("'''") {
                self.multiline_string_delimiter = Some("'''");
                index += 3;
                continue;
            }
            if ch == b'"' {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == b'\\' {
                        index += 2;
                        continue;
                    }
                    if bytes[index] == b'"' {
                        break;
                    }
                    index += 1;
                }
                index += 1;
                continue;
            }
            if ch == b'\'' {
                match line[index + 1..].find('\'') {
                    Some(offset) => {
                        index += 1 + offset + 1;
                        continue;
                    }
                    None => return,
                }
            }
            if ch == b'[' {
                self.array_depth += 1;
            } else if ch == b']' && self.array_depth > 0 {
                self.array_depth -= 1;
            }
            index += 1;
        }
    }
}

/// TS `mirrorRuntimeShadowHookTrustState` — duplicates `hooks.state."<real
/// hooks.json>:*"` trust blocks under the shadow hooks.json path so hook
/// trust survives inside the shadow home.
pub fn mirror_runtime_shadow_hook_trust_state(
    raw_config: &str,
    original_codex_home: &Path,
    shadow_codex_home: &Path,
) -> String {
    let source_hooks_path = original_codex_home.join("hooks.json");
    let shadow_hooks_path = shadow_codex_home.join("hooks.json");
    if source_hooks_path == shadow_hooks_path {
        return raw_config.to_string();
    }
    let source_prefix = format!("{}:", source_hooks_path.display());
    let shadow_hooks_display = shadow_hooks_path.display().to_string();

    let line_ending = if raw_config.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = if raw_config.is_empty() {
        Vec::new()
    } else {
        raw_config.split("\r\n").flat_map(|s| s.split('\n')).collect()
    };

    let mut existing_hook_state_keys: HashSet<String> = HashSet::new();
    for line in &lines {
        if let Some(key) = parse_hook_state_table_key(line) {
            existing_hook_state_keys.insert(key);
        }
    }

    let mut output: Vec<String> = Vec::with_capacity(lines.len());
    let mut changed = false;
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let key = parse_hook_state_table_key(line);
        output.push(line.to_string());
        let Some(key) = key.filter(|k| k.starts_with(&source_prefix)) else {
            index += 1;
            continue;
        };
        let mut block_lines: Vec<&str> = Vec::new();
        let mut next_index = index + 1;
        let mut block_state = TomlBlockScanState::default();
        while next_index < lines.len() {
            let next_line = lines[next_index];
            if block_state.is_top_level() && is_toml_table_line(next_line) {
                break;
            }
            block_lines.push(next_line);
            block_state.update(next_line);
            next_index += 1;
        }
        output.extend(block_lines.iter().map(|s| s.to_string()));
        index = next_index;
        let shadow_key = format!(
            "{shadow_hooks_display}:{}",
            &key[source_prefix.len()..]
        );
        if existing_hook_state_keys.contains(&shadow_key) {
            continue;
        }
        output.push(String::new());
        output.push(format!(
            "[hooks.state.{}]",
            cma_runtime::config_toml::toml_string_literal(&shadow_key)
        ));
        output.extend(block_lines.iter().map(|s| s.to_string()));
        existing_hook_state_keys.insert(shadow_key);
        changed = true;
    }

    if changed {
        output.join(line_ending)
    } else {
        raw_config.to_string()
    }
}

/// The forwarded env + cleanup produced by
/// [`create_runtime_rotation_proxy_codex_home`].
pub struct ShadowHomeContext {
    /// Env overrides layered onto the base environment for the spawned codex.
    pub env: HashMap<String, String>,
    pub shadow_codex_home: PathBuf,
    sync_back: Option<ShadowHomeSyncBack>,
}

impl ShadowHomeContext {
    /// Assemble a context from an already-created shadow home + sync-back
    /// (compatibility-home path in `forward.rs`).
    pub fn from_parts(shadow_codex_home: PathBuf, sync_back: ShadowHomeSyncBack) -> Self {
        Self {
            env: HashMap::new(),
            shadow_codex_home,
            sync_back: Some(sync_back),
        }
    }

    /// TS: `cleanup()` — sync state back, then remove the shadow home.
    pub fn cleanup(mut self) {
        self.cleanup_inner();
    }

    fn cleanup_inner(&mut self) {
        if let Some(sync_back) = self.sync_back.take() {
            sync_back.run();
        }
        let _ = remove_directory_with_retry(&self.shadow_codex_home);
    }
}

impl Drop for ShadowHomeContext {
    fn drop(&mut self) {
        if self.sync_back.is_some() {
            self.cleanup_inner();
        }
    }
}

/// TS `resolveOriginalMultiAuthDir(env)` — explicit `CODEX_MULTI_AUTH_DIR`
/// only.
pub fn resolve_original_multi_auth_dir(env: &HashMap<String, String>) -> Option<String> {
    env.get("CODEX_MULTI_AUTH_DIR")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// TS `resolveRuntimeRotationOriginalMultiAuthDir(originalCodexHome, env)`.
pub fn resolve_runtime_rotation_original_multi_auth_dir(
    original_codex_home: &Path,
    env: &HashMap<String, String>,
) -> String {
    resolve_original_multi_auth_dir(env)
        .unwrap_or_else(|| original_codex_home.join("multi-auth").display().to_string())
}

/// TS `resolveRuntimeRotationProxyOriginalCodexHome(baseEnv)` — honors the
/// app-helper's `CODEX_MULTI_AUTH_REAL_CODEX_HOME` override.
pub fn resolve_runtime_rotation_proxy_original_codex_home(
    env: &HashMap<String, String>,
) -> PathBuf {
    let override_value = env
        .get("CODEX_MULTI_AUTH_REAL_CODEX_HOME")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if !override_value.is_empty() {
        return PathBuf::from(override_value);
    }
    resolve_codex_home_dir(env)
}

/// TS `resolveCodexHomeDir(env)` — `CODEX_HOME` override, then the platform
/// home ladder (delegates to `cma_core::runtime_paths` when reading the
/// process env; a supplied env map resolves the same keys locally).
pub fn resolve_codex_home_dir(env: &HashMap<String, String>) -> PathBuf {
    let override_value = env
        .get("CODEX_HOME")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if !override_value.is_empty() {
        return PathBuf::from(override_value);
    }
    if cfg!(windows) {
        let user_profile = env
            .get("USERPROFILE")
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        if !user_profile.is_empty() {
            return Path::new(&user_profile).join(".codex");
        }
        let home_drive = env.get("HOMEDRIVE").map(|v| v.trim().to_string()).unwrap_or_default();
        let home_path = env.get("HOMEPATH").map(|v| v.trim().to_string()).unwrap_or_default();
        if !home_drive.is_empty() && !home_path.is_empty() {
            return Path::new(&format!("{home_drive}{home_path}")).join(".codex");
        }
    }
    if let Some(home) = env.get("HOME").map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        return Path::new(&home).join(".codex");
    }
    home::home_dir_via_core().join(".codex")
}

/// Small shim: `home::home_dir()` lives in cma-core's dependency set; core
/// exposes the resolved home through `get_codex_home_dir`'s ladder. For the
/// no-env fallback we derive home from the process env ladder in core.
mod home {
    use std::path::PathBuf;

    pub fn home_dir_via_core() -> PathBuf {
        // core's get_codex_home_dir() returns <home>/.codex for the process
        // env; strip the trailing component to recover the home dir.
        let codex_home = cma_core::runtime_paths::get_codex_home_dir();
        codex_home
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or(codex_home)
    }
}

/// TS `createRuntimeRotationProxyCodexHome(baseEnv, proxyBaseUrl,
/// clientApiKey, configTomlModule)` — build the runtime-rotation shadow home
/// and the forwarded env (`CODEX_HOME`, `OPENAI_API_KEY`,
/// `CODEX_MULTI_AUTH_DIR`).
pub fn create_runtime_rotation_proxy_codex_home(
    base_env: &HashMap<String, String>,
    proxy_base_url: &str,
    client_api_key: &str,
) -> io::Result<ShadowHomeContext> {
    let original_codex_home = resolve_runtime_rotation_proxy_original_codex_home(base_env);
    let shadow_codex_home = create_runtime_rotation_shadow_home(&original_codex_home)?;

    let result = (|| -> io::Result<ShadowHomeSyncBack> {
        let sync_back = create_shadow_home_mirror(
            &original_codex_home,
            &shadow_codex_home,
            MirrorOptions::runtime_rotation(),
        )?;
        omit_runtime_rotation_shadow_home_state_files(&shadow_codex_home);
        let original_config_path = original_codex_home.join(SHADOW_HOME_CONFIG_FILE);
        // TS parity: readFileSync throws on an unreadable-but-existing config
        // (Windows lock, ACL, transient EBUSY) — the error propagates, the
        // shadow home is removed below, and the caller falls back to a normal
        // launch against the user's REAL config. Silently defaulting to an
        // empty string would keep the proxy but drop the user's entire
        // config (model, profiles, MCP servers, trust) for the run.
        let raw_config = if original_config_path.exists() {
            fs::read_to_string(&original_config_path)?
        } else {
            String::new()
        };
        let runtime_config = mirror_runtime_shadow_hook_trust_state(
            &cma_runtime::config_toml::rewrite_config_toml_for_runtime_rotation_provider(
                &raw_config,
                proxy_base_url,
                client_api_key,
            ),
            &original_codex_home,
            &shadow_codex_home,
        );
        let runtime_config_path = shadow_codex_home.join(SHADOW_HOME_CONFIG_FILE);
        fs::write(&runtime_config_path, runtime_config)?;
        tighten_file_permissions(&runtime_config_path);
        Ok(sync_back)
    })();

    let sync_back = match result {
        Ok(sync_back) => sync_back,
        Err(error) => {
            let _ = remove_directory_with_retry(&shadow_codex_home);
            return Err(error);
        }
    };

    let mut env = HashMap::new();
    env.insert(
        "CODEX_HOME".to_string(),
        shadow_codex_home.display().to_string(),
    );
    env.insert("OPENAI_API_KEY".to_string(), client_api_key.to_string());
    env.insert(
        "CODEX_MULTI_AUTH_DIR".to_string(),
        resolve_runtime_rotation_original_multi_auth_dir(&original_codex_home, base_env),
    );

    Ok(ShadowHomeContext {
        env,
        shadow_codex_home,
        sync_back: Some(sync_back),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_hashing_rules() {
        assert_eq!(
            hash_shadow_home_state(&ShadowFileState::missing()).as_deref(),
            Some("missing")
        );
        assert_eq!(
            hash_shadow_home_state(&ShadowFileState {
                exists: true,
                content: None,
                unreadable: true
            }),
            None
        );
        let hashed = hash_shadow_home_state(&ShadowFileState {
            exists: true,
            content: Some("abc".to_string()),
            unreadable: false,
        })
        .unwrap();
        assert!(hashed.starts_with("sha256:"));
        assert_eq!(hashed.len(), "sha256:".len() + 64);
    }

    #[test]
    fn runtime_rotation_omit_rules() {
        assert!(is_runtime_rotation_shadow_home_omitted_entry("multi-auth"));
        assert!(is_runtime_rotation_shadow_home_omitted_entry("state_123.sqlite"));
        assert!(is_runtime_rotation_shadow_home_omitted_entry("logs_9.sqlite-wal"));
        assert!(is_runtime_rotation_shadow_home_omitted_entry("auth.json.123.abc12.tmp"));
        assert!(is_runtime_rotation_shadow_home_omitted_entry(
            ".codex-global-state.json.tmp-abc-123"
        ));
        assert!(!is_runtime_rotation_shadow_home_omitted_entry("auth.json"));
        assert!(!is_runtime_rotation_shadow_home_omitted_entry("sessions"));
        assert!(!is_runtime_rotation_shadow_home_omitted_entry("state_.sqlite"));
        assert!(is_runtime_rotation_shadow_home_link_only_directory("sqlite"));
        assert!(is_runtime_rotation_shadow_home_link_only_directory("cache"));
        assert!(!is_runtime_rotation_shadow_home_link_only_directory("sessions"));
    }

    #[test]
    fn sqlite_name_classification() {
        assert!(is_sqlite_main_file("STATE.SQLITE"));
        assert!(is_sqlite_sidecar_file("a.sqlite-wal"));
        assert!(is_sqlite_sidecar_file("a.sqlite-shm"));
        assert!(!is_sqlite_sidecar_file("a.sqlite"));
        assert!(!is_sqlite_main_file("a.sqlite-wal"));
    }

    /// Node `symlinkSync(..., "junction")` parity: on win32 the dir mirror
    /// must create an unprivileged NTFS junction (a reparse point), never
    /// fall back to a copy just because SeCreateSymbolicLinkPrivilege is
    /// absent (standard users / no Developer Mode). Runs fine WITH the
    /// privilege too — a junction is created either way.
    #[cfg(windows)]
    #[test]
    fn windows_dir_mirror_links_via_junction_without_symlink_privilege() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("sqlite");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("state.sqlite"), b"db").unwrap();
        let destination = temp.path().join("shadow-sqlite");

        let how = mirror_directory_into_shadow_home(&source, &destination).unwrap();
        assert_eq!(how, "linked", "junction, not copy");
        // A junction is a name-surrogate reparse point: symlink_metadata
        // reports is_symlink() on Windows and the link resolves live.
        let meta = fs::symlink_metadata(&destination).unwrap();
        assert!(meta.file_type().is_symlink(), "reparse point expected");
        assert!(destination.join("state.sqlite").exists(), "link resolves");
        fs::write(source.join("new.sqlite"), b"live").unwrap();
        assert!(destination.join("new.sqlite").exists(), "live-linked, not a copy");

        // link_directory_into_shadow_home shares the same seam.
        let second = temp.path().join("shadow-cache");
        assert!(link_directory_into_shadow_home(&source, &second));
        assert!(fs::symlink_metadata(&second).unwrap().file_type().is_symlink());
    }

    /// TS parity: an EXISTING config.toml that cannot be read (lock/ACL)
    /// must abort shadow-home creation (caller then runs Codex normally
    /// against the real config) instead of silently proceeding with an
    /// EMPTY shadow config — which would drop the user's model/profiles/
    /// MCP servers for the run. The failed attempt removes the shadow dir.
    #[cfg(windows)]
    #[test]
    fn unreadable_config_toml_aborts_shadow_home_creation() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join("codex-home");
        fs::create_dir_all(&codex_home).unwrap();
        let config_path = codex_home.join("config.toml");
        fs::write(&config_path, "model = \"gpt-5.5\"\n").unwrap();
        // Hold the file open with NO sharing: any other open (the mirror's
        // read_to_string) fails with ERROR_SHARING_VIOLATION.
        let _exclusive = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&config_path)
            .unwrap();

        let mut base_env = HashMap::new();
        base_env.insert(
            "CODEX_HOME".to_string(),
            codex_home.display().to_string(),
        );
        let result = create_runtime_rotation_proxy_codex_home(
            &base_env,
            "http://127.0.0.1:9/",
            "test-key",
        );
        assert!(result.is_err(), "unreadable config must propagate an error");

        // The partially-built shadow home was cleaned up.
        let shadow_root = codex_home.join("multi-auth").join("runtime-shadow-homes");
        let leftovers: Vec<_> = fs::read_dir(&shadow_root)
            .map(|entries| entries.flatten().collect())
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "shadow dir removed on failure: {leftovers:?}"
        );
    }

    #[test]
    fn hook_state_key_parsing() {
        assert_eq!(
            parse_hook_state_table_key("[hooks.state.\"C:/h/hooks.json:my-hook\"]"),
            Some("C:/h/hooks.json:my-hook".to_string())
        );
        assert_eq!(
            parse_hook_state_table_key("  [ hooks.state.'p:x' ]  "),
            Some("p:x".to_string())
        );
        assert_eq!(parse_hook_state_table_key("[other.table]"), None);
        assert_eq!(parse_hook_state_table_key("key = 1"), None);
    }

    #[test]
    fn toml_table_line_detection() {
        assert!(is_toml_table_line("[table]"));
        assert!(is_toml_table_line("[[array_of_tables]]"));
        assert!(is_toml_table_line("[a.b]"));
        assert!(is_toml_table_line("[\"quoted\"]"));
        assert!(!is_toml_table_line("key = [1, 2]"));
        assert!(!is_toml_table_line("# comment"));
    }

    #[test]
    fn sync_state_round_trip_and_rebase() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let mut sync_state = read_shadow_home_sync_state(home);
        assert_eq!(sync_state["version"], 1);

        let base = ShadowFileState {
            exists: true,
            content: Some("base".to_string()),
            unreadable: false,
        };
        let synced = ShadowFileState {
            exists: true,
            content: Some("synced".to_string()),
            unreadable: false,
        };
        remember_shadow_home_sync_state(home, &mut sync_state, "auth.json", &base, &synced);
        // Reload from disk and verify the rebase check accepts (base, synced).
        let reloaded = read_shadow_home_sync_state(home);
        assert!(can_rebase_shadow_home_sync_state(&reloaded, "auth.json", &base, &synced));
        // A different current state refuses the rebase.
        let unrelated = ShadowFileState {
            exists: true,
            content: Some("external edit".to_string()),
            unreadable: false,
        };
        assert!(!can_rebase_shadow_home_sync_state(&reloaded, "auth.json", &base, &unrelated));
        assert!(!can_rebase_shadow_home_sync_state(&reloaded, "other.json", &base, &synced));
    }

    #[test]
    fn mirror_and_sync_back_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("real-home");
        let shadow = temp.path().join("shadow-home");
        fs::create_dir_all(&original).unwrap();
        fs::create_dir_all(&shadow).unwrap();
        fs::write(original.join("auth.json"), "{\"a\":1}").unwrap();
        fs::write(original.join("config.toml"), "model = \"x\"\n").unwrap();
        fs::write(original.join("notes.txt"), "keep").unwrap();

        let sync_back =
            create_shadow_home_mirror(&original, &shadow, MirrorOptions::default()).unwrap();
        // config.toml is never mirrored (wrapper writes its own).
        assert!(!shadow.join("config.toml").exists());
        assert_eq!(fs::read_to_string(shadow.join("auth.json")).unwrap(), "{\"a\":1}");

        // Simulate the official CLI refreshing auth inside the shadow home.
        fs::write(shadow.join("auth.json"), "{\"a\":2}").unwrap();
        sync_back.run();
        assert_eq!(
            fs::read_to_string(original.join("auth.json")).unwrap(),
            "{\"a\":2}"
        );
    }

    #[test]
    fn sync_back_refuses_external_edit() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("real-home");
        let shadow = temp.path().join("shadow-home");
        fs::create_dir_all(&original).unwrap();
        fs::create_dir_all(&shadow).unwrap();
        fs::write(original.join("auth.json"), "orig").unwrap();

        let sync_back =
            create_shadow_home_mirror(&original, &shadow, MirrorOptions::default()).unwrap();
        // Shadow session refreshes...
        fs::write(shadow.join("auth.json"), "shadow-refresh").unwrap();
        // ...but an EXTERNAL writer also changed the original meanwhile.
        fs::write(original.join("auth.json"), "external").unwrap();
        sync_back.run();
        // External edit wins; shadow refresh must NOT clobber it.
        assert_eq!(fs::read_to_string(original.join("auth.json")).unwrap(), "external");
    }

    #[test]
    fn runtime_rotation_mirror_omits_auth_state() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("real-home");
        fs::create_dir_all(original.join("multi-auth")).unwrap();
        fs::write(original.join("auth.json"), "secret").unwrap();
        fs::write(original.join("accounts.json"), "accounts").unwrap();
        fs::write(original.join(".codex-global-state.json"), "{}").unwrap();

        let env = HashMap::new();
        let mut env = env;
        env.insert(
            "CODEX_MULTI_AUTH_REAL_CODEX_HOME".to_string(),
            original.display().to_string(),
        );
        let context =
            create_runtime_rotation_proxy_codex_home(&env, "http://127.0.0.1:9/", "key-123")
                .unwrap();
        let shadow = context.shadow_codex_home.clone();
        assert!(!shadow.join("auth.json").exists());
        assert!(!shadow.join("accounts.json").exists());
        assert!(shadow.join(".codex-global-state.json").exists());
        // config.toml written with the provider block + client key.
        let config = fs::read_to_string(shadow.join("config.toml")).unwrap();
        assert!(config.contains("codex-multi-auth-runtime-proxy"));
        // Forwarded env points CODEX_HOME at the shadow and pins the dir.
        assert_eq!(
            context.env.get("CODEX_HOME").unwrap(),
            &shadow.display().to_string()
        );
        assert_eq!(context.env.get("OPENAI_API_KEY").unwrap(), "key-123");
        assert_eq!(
            context.env.get("CODEX_MULTI_AUTH_DIR").unwrap(),
            &original.join("multi-auth").display().to_string()
        );
        context.cleanup();
        assert!(!shadow.exists());
        // Real auth untouched.
        assert_eq!(fs::read_to_string(original.join("auth.json")).unwrap(), "secret");
    }

    #[test]
    fn sync_lock_claim_and_stale_takeover() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let lock = acquire_shadow_home_sync_lock(home).unwrap();
        let lock_dir = home.join(SHADOW_HOME_SYNC_LOCK_DIR);
        assert!(lock_dir.exists());
        lock.release();
        assert!(!lock_dir.exists());

        // A dead-owner lock is stolen.
        fs::create_dir_all(&lock_dir).unwrap();
        fs::write(
            lock_dir.join("owner.json"),
            "{\"pid\": 999999999, \"createdAt\": 1}\n",
        )
        .unwrap();
        let lock = acquire_shadow_home_sync_lock(home).unwrap();
        lock.release();
    }

    #[test]
    fn owner_only_json_writer_shape() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("nested").join("status.json");
        write_owner_only_json_file_atomic_sync(&target, &serde_json::json!({"version": 1}))
            .unwrap();
        let raw = fs::read_to_string(&target).unwrap();
        assert_eq!(raw, "{\n  \"version\": 1\n}\n");
    }

    #[test]
    fn hook_trust_block_duplication() {
        let temp = tempfile::tempdir().unwrap();
        let original = temp.path().join("orig");
        let shadow = temp.path().join("shadow");
        fs::create_dir_all(&original).unwrap();
        fs::create_dir_all(&shadow).unwrap();
        let source_key = format!("{}:my-hook", original.join("hooks.json").display());
        let raw = format!(
            "[hooks.state.{}]\ntrusted = true\n",
            cma_runtime::config_toml::toml_string_literal(&source_key)
        );
        let rewritten = mirror_runtime_shadow_hook_trust_state(&raw, &original, &shadow);
        let shadow_key = format!("{}:my-hook", shadow.join("hooks.json").display());
        assert!(rewritten.contains(&format!(
            "[hooks.state.{}]",
            cma_runtime::config_toml::toml_string_literal(&shadow_key)
        )));
        // Idempotent: running again adds nothing.
        let again = mirror_runtime_shadow_hook_trust_state(&rewritten, &original, &shadow);
        assert_eq!(again.matches("trusted = true").count(), 2);
    }
}
