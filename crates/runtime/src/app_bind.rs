//! Port of `lib/runtime/app-bind.ts` — binds the Codex **desktop app** to the
//! local runtime-rotation proxy by rewriting `~/.codex/config.toml`, spawning
//! a detached router process, and installing OS auto-start entries. Fully
//! reversible via a JSON backup of the original config.
//!
//! R3 decision (ARCHITECTURE §0): the bind state keeps its exact JSON SHAPE,
//! but `nodePath` now stores the **Rust router binary path**
//! (`codex-multi-auth-app-router`) and `routerScriptPath` stores `""`. Old
//! TS-written bind states (non-empty `routerScriptPath`) are detected via
//! [`is_legacy_ts_bind_state`] and re-bound on the next `rotation enable`.
//!
//! Critical invariants (spec 10 §1 + gotchas):
//! - `boundConfigHash` = sha256 of the exact written config.toml text; the
//!   unbind "user edited it" branch depends on the byte-exact rewrite in
//!   [`crate::config_toml`] — one byte off and unbind refuses the surgical
//!   restore. That is INTENTIONAL.
//! - Per-bindDir async mutex around bind/unbind.
//! - Orphaned-bind self-heal (#614): no state + no backup but config.toml
//!   still bound → restore via the without-backup path.
//! - Bind never writes `port=0` into config.toml.
//! - `formatAppBindStatus` never prints labels containing `@` (privacy).

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as TokioMutex;

use cma_core::fs_retry::with_file_operation_retry;
use cma_core::json_io::{
    stringify_pretty2, write_json_atomic, TrailingNewline, WriteJsonOptions,
};
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::utils::now_ms;

use crate::config_toml::{
    config_has_runtime_rotation_provider, restore_config_toml_from_runtime_rotation_provider,
    restore_config_toml_from_runtime_rotation_provider_without_backup,
    rewrite_config_toml_for_runtime_rotation_provider,
};

pub const APP_BIND_DIR_NAME: &str = "app-bind";
pub const APP_BIND_STATE_FILE: &str = "runtime-rotation-app-bind.json";
pub const APP_BIND_BACKUP_FILE: &str = "codex-config-backup.json";
pub const APP_BIND_STATUS_FILE: &str = "runtime-rotation-app-bind-status.json";
pub const WINDOWS_STARTUP_FILE: &str = "Codex Multi Auth Runtime Router.cmd";
pub const MACOS_LAUNCH_AGENT_ID: &str = "com.ndycode.codex-multi-auth.runtime-router";
const DEFAULT_ROUTER_READY_TIMEOUT_MS: u64 = 15_000;
const ROUTER_STATUS_POLL_INTERVAL_MS: u64 = 100;
pub const APP_ROUTER_MAX_LOG_BYTES: u64 = 1024 * 1024;
const APP_BIND_LOG_FILE: &str = "runtime-rotation-app-router.log";
/// The Rust router binary name (R3 — replaces `scripts/codex-app-router.js`).
pub const APP_ROUTER_BIN_NAME: &str = "codex-multi-auth-app-router";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppBindPaths {
    pub codex_home: PathBuf,
    pub config_path: PathBuf,
    pub bind_dir: PathBuf,
    pub state_path: PathBuf,
    pub backup_path: PathBuf,
    pub status_path: PathBuf,
    pub log_path: PathBuf,
    /// The router executable (TS `routerScriptPath` slot; R3: a native binary).
    pub router_bin_path: PathBuf,
    pub startup_path: Option<PathBuf>,
    pub launch_agent_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
struct AppBindBackup {
    config_path: String,
    existed: bool,
    content: String,
    created_at: i64,
}

/// Persisted state file shape (spec 10 §12.1). Serde field order is the JS
/// property insertion order — byte-identical output matters.
/// `startupPath`/`launchAgentPath` serialize as explicit `null` when absent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBindState {
    pub version: i64,
    pub platform: String,
    pub host: String,
    pub port: i64,
    pub base_url: String,
    pub config_path: String,
    pub state_path: String,
    pub backup_path: String,
    pub status_path: String,
    pub log_path: String,
    /// R3: the Rust router binary path (was Node's `process.execPath`).
    pub node_path: String,
    /// R3: `""` for Rust-written states; non-empty (a `.js` path) only in
    /// legacy TS-written states.
    pub router_script_path: String,
    pub client_api_key: String,
    pub startup_path: Option<String>,
    pub launch_agent_path: Option<String>,
    pub bound_config_hash: String,
    pub updated_at: i64,
}

/// Router-written status JSON, parsed leniently (strings must be non-empty
/// after trim, numbers finite; otherwise null).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AppBindRouterStatus {
    pub state: Option<String>,
    pub pid: Option<i64>,
    pub base_url: Option<String>,
    pub total_requests: Option<i64>,
    pub last_account_index: Option<i64>,
    pub last_account_label: Option<String>,
    pub last_account_email: Option<String>,
    pub last_account_id: Option<String>,
    pub updated_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppBindStatus {
    pub bound: bool,
    pub running: bool,
    /// True when config.toml is bound to the runtime proxy but the app-bind
    /// state file is gone (orphaned bind, #614). Then `bound` is also true and
    /// `state` is None.
    pub unmanaged_bind: bool,
    pub state: Option<AppBindState>,
    pub router: Option<AppBindRouterStatus>,
    pub paths: AppBindPaths,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppBindResult {
    pub status: AppBindStatus,
    pub message: String,
}

/// A `(message) -> ()` sink (TS `log?: (message: string) => void`).
pub type LogSink = Box<dyn Fn(&str) + Send + Sync>;
/// A `() -> epoch-ms` clock (TS `now?: () => number`).
pub type NowFn = Box<dyn Fn() -> i64 + Send + Sync>;

/// Test-injectable options (TS `AppBindOptions`). `env: None` reads the
/// process environment; `platform`/`home` default to the current process.
#[derive(Default)]
pub struct AppBindOptions {
    pub env: Option<HashMap<String, String>>,
    pub platform: Option<String>,
    pub home: Option<PathBuf>,
    pub now: Option<NowFn>,
    /// Router binary override (TS `nodePath`/`routerScriptPath` collapse into
    /// this single path under R3).
    pub router_bin_path: Option<PathBuf>,
    /// Candidate list override for resolution-failure tests
    /// (TS `routerScriptCandidates`).
    pub router_bin_candidates: Option<Vec<PathBuf>>,
    pub spawn_detached: Option<bool>,
    pub router_ready_timeout_ms: Option<u64>,
    pub log: Option<LogSink>,
}

impl AppBindOptions {
    fn env_var(&self, key: &str) -> Option<String> {
        match &self.env {
            Some(map) => map.get(key).cloned(),
            None => std::env::var(key).ok(),
        }
    }

    fn platform(&self) -> String {
        self.platform
            .clone()
            .unwrap_or_else(|| current_platform().to_string())
    }

    fn home(&self) -> PathBuf {
        self.home.clone().unwrap_or_else(default_home_dir)
    }

    fn now(&self) -> i64 {
        match &self.now {
            Some(now) => now(),
            None => now_ms(),
        }
    }

    fn log(&self, message: &str) {
        if let Some(log) = &self.log {
            log(message);
        }
    }
}

/// `os.homedir()` analogue via the env ladder (spec 02 §2.1 — env vars
/// first). The `home` crate is not a cma-runtime dependency; this mirrors the
/// same USERPROFILE/HOME/HOMEDRIVE+HOMEPATH resolution.
fn default_home_dir() -> PathBuf {
    let non_blank = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if cfg!(windows) {
        if let Some(profile) = non_blank("USERPROFILE") {
            return PathBuf::from(profile);
        }
        if let Some(home) = non_blank("HOME") {
            return PathBuf::from(home);
        }
        if let (Some(drive), Some(path)) = (non_blank("HOMEDRIVE"), non_blank("HOMEPATH")) {
            return PathBuf::from(format!("{drive}{path}"));
        }
    } else if let Some(home) = non_blank("HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from(".")
}

/// Node `process.platform` analogue.
pub fn current_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

// ---------------------------------------------------------------------------
// Per-bindDir async mutex (TS `withAppBindLock`)
// ---------------------------------------------------------------------------

static APP_BIND_LOCKS: LazyLock<StdMutex<HashMap<PathBuf, Arc<TokioMutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

fn lock_for(key: &Path) -> Arc<TokioMutex<()>> {
    let mut guard = APP_BIND_LOCKS
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    guard
        .entry(key.to_path_buf())
        .or_insert_with(|| Arc::new(TokioMutex::new(())))
        .clone()
}

// ---------------------------------------------------------------------------
// Config-toml aliases (TS thin wrappers)
// ---------------------------------------------------------------------------

pub fn rewrite_config_toml_for_app_bind(
    raw_config: &str,
    base_url: &str,
    client_api_key: &str,
) -> String {
    rewrite_config_toml_for_runtime_rotation_provider(raw_config, base_url, client_api_key)
}

pub fn restore_config_toml_from_app_bind(current_config: &str, original_config: &str) -> String {
    restore_config_toml_from_runtime_rotation_provider(current_config, original_config)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn create_app_bind_client_api_key() -> String {
    use rand::TryRngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .expect("OS entropy source unavailable");
    let mut out = String::with_capacity(64);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn read_string(record: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    match record.get(key) {
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

fn read_number(record: &serde_json::Map<String, Value>, key: &str) -> Option<i64> {
    match record.get(key) {
        Some(value) if value.is_number() => value.as_i64().or_else(|| {
            // Finite non-integer numbers truncate (corrupt-file tolerance).
            value.as_f64().filter(|f| f.is_finite()).map(|f| f as i64)
        }),
        _ => None,
    }
}

async fn read_json_record(path: &Path) -> Option<serde_json::Map<String, Value>> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Atomic write (mkdir -p → temp in target dir → fsync → rename), the whole
/// operation wrapped in the shared file-operation retry (transient Windows
/// EBUSY/EPERM). Mode 0o600 unless overridden.
async fn atomic_write_file(target: &Path, content: &str, mode: u32) -> io::Result<()> {
    with_file_operation_retry(|| async {
        write_json_atomic(
            target,
            content,
            Some(mode),
            &WriteJsonOptions {
                trailing_newline: TrailingNewline::None,
                fsync: true,
                ensure_parent_dir: true,
                // The outer retry drives re-attempts with a fresh temp file,
                // matching the TS withFileOperationRetry(atomicWrite) shape.
                rename_max_attempts: 1,
                ..WriteJsonOptions::default()
            },
        )
        .await
    })
    .await
}

async fn unlink_if_exists(path: &Path) -> io::Result<()> {
    let result = with_file_operation_retry(|| async { tokio::fs::remove_file(path).await }).await;
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// State / backup / status readers (lenient)
// ---------------------------------------------------------------------------

fn read_app_bind_state_record(record: &serde_json::Map<String, Value>) -> Option<AppBindState> {
    let port = read_number(record, "port")?;
    let host = read_string(record, "host")?;
    let base_url = read_string(record, "baseUrl")?;
    let config_path = read_string(record, "configPath")?;
    let backup_path = read_string(record, "backupPath")?;
    let state_path = read_string(record, "statePath")?;
    let status_path = read_string(record, "statusPath")?;
    let log_path = read_string(record, "logPath")?;
    let node_path = read_string(record, "nodePath")?;
    // R3: Rust-written states store `""` here; the TS reader required a
    // non-blank string. Accept any string (including blank) so our own states
    // re-read; missing/non-string still invalidates the whole state.
    let router_script_path = match record.get("routerScriptPath") {
        Some(Value::String(value)) => value.trim().to_string(),
        _ => return None,
    };
    let client_api_key = read_string(record, "clientApiKey")?;
    let bound_config_hash = read_string(record, "boundConfigHash")?;
    let updated_at = read_number(record, "updatedAt")?;
    Some(AppBindState {
        version: 1,
        platform: read_string(record, "platform")
            .unwrap_or_else(|| current_platform().to_string()),
        host,
        port,
        base_url,
        config_path,
        state_path,
        backup_path,
        status_path,
        log_path,
        node_path,
        router_script_path,
        client_api_key,
        startup_path: read_string(record, "startupPath"),
        launch_agent_path: read_string(record, "launchAgentPath"),
        bound_config_hash,
        updated_at,
    })
}

async fn read_app_bind_state(path: &Path) -> Option<AppBindState> {
    let record = read_json_record(path).await?;
    read_app_bind_state_record(&record)
}

async fn read_app_bind_backup(path: &Path) -> Option<AppBindBackup> {
    let record = read_json_record(path).await?;
    let config_path = read_string(&record, "configPath")?;
    // `content` is a string (empty allowed — do NOT trim).
    let content = match record.get("content") {
        Some(Value::String(value)) => value.clone(),
        _ => return None,
    };
    let created_at = read_number(&record, "createdAt")?;
    Some(AppBindBackup {
        config_path,
        existed: record.get("existed") == Some(&Value::Bool(true)),
        content,
        created_at,
    })
}

async fn read_router_status(path: &Path) -> Option<AppBindRouterStatus> {
    let record = read_json_record(path).await?;
    Some(AppBindRouterStatus {
        state: read_string(&record, "state"),
        pid: read_number(&record, "pid"),
        base_url: read_string(&record, "baseUrl"),
        total_requests: read_number(&record, "totalRequests"),
        last_account_index: read_number(&record, "lastAccountIndex"),
        last_account_label: read_string(&record, "lastAccountLabel"),
        last_account_email: read_string(&record, "lastAccountEmail"),
        last_account_id: read_string(&record, "lastAccountId"),
        updated_at: read_number(&record, "updatedAt"),
        last_error: read_string(&record, "lastError"),
    })
}

// ---------------------------------------------------------------------------
// Process liveness / signaling (no unsafe: shell out to OS tools)
// ---------------------------------------------------------------------------

/// `process.kill(pid, 0)` analogue. **EPERM counts as alive**; falsy pid →
/// false. Implemented without unsafe code: Linux consults `/proc/<pid>`;
/// other unix uses `kill -0`; Windows uses `tasklist` filtered by PID.
pub fn is_process_alive(pid: Option<i64>) -> bool {
    let Some(pid) = pid else { return false };
    if pid <= 0 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        match Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(output) => {
                if output.status.success() {
                    true
                } else {
                    // EPERM (signal blocked by ownership) still means alive.
                    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
                    stderr.contains("not permitted") || stderr.contains("eperm")
                }
            }
            Err(_) => false,
        }
    }
    #[cfg(windows)]
    {
        let filter = format!("PID eq {pid}");
        let mut command = Command::new("tasklist");
        command
            .args(["/NH", "/FO", "CSV", "/FI", &filter])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        match command.output() {
            Ok(output) => String::from_utf8_lossy(&output.stdout)
                .contains(&format!("\"{pid}\"")),
            Err(_) => false,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// `process.kill(pid, "SIGTERM")` analogue (on Windows, Node terminates the
/// process unconditionally; `taskkill /F` matches that).
fn terminate_process(pid: i64) {
    if pid <= 0 {
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.status();
    }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

fn resolve_windows_startup_path(options: &AppBindOptions, home: &Path) -> PathBuf {
    let app_data = options
        .env_var("APPDATA")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Roaming"));
    app_data
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join(WINDOWS_STARTUP_FILE)
}

fn resolve_mac_launch_agent_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{MACOS_LAUNCH_AGENT_ID}.plist"))
}

/// Resolve the router binary (R3): explicit override wins; otherwise the
/// sibling of the current executable named `codex-multi-auth-app-router`.
/// Throws (frozen format, binary name substituted per R3):
/// `codex-multi-auth-app-router not found; checked: <list>`.
fn resolve_router_bin_path(options: &AppBindOptions) -> Result<PathBuf, String> {
    if let Some(override_path) = &options.router_bin_path {
        return Ok(override_path.clone());
    }
    let candidates: Vec<PathBuf> = match &options.router_bin_candidates {
        Some(candidates) => candidates.clone(),
        None => {
            let bin_name = format!("{APP_ROUTER_BIN_NAME}{}", std::env::consts::EXE_SUFFIX);
            match std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join(&bin_name)))
            {
                Some(sibling) => vec![sibling],
                None => Vec::new(),
            }
        }
    };
    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "{APP_ROUTER_BIN_NAME} not found; checked: {}",
        candidates
            .iter()
            .map(|candidate| path_to_string(candidate))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub fn resolve_app_bind_paths(options: &AppBindOptions) -> Result<AppBindPaths, String> {
    let platform = options.platform();
    let home = options.home();
    let codex_home = options
        .env_var("CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let multi_auth_dir = options
        .env_var("CODEX_MULTI_AUTH_DIR")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(get_codex_multi_auth_dir);
    let bind_dir = multi_auth_dir.join(APP_BIND_DIR_NAME);
    Ok(AppBindPaths {
        config_path: codex_home.join("config.toml"),
        codex_home,
        state_path: bind_dir.join(APP_BIND_STATE_FILE),
        backup_path: bind_dir.join(APP_BIND_BACKUP_FILE),
        status_path: bind_dir.join(APP_BIND_STATUS_FILE),
        log_path: bind_dir.join(APP_BIND_LOG_FILE),
        router_bin_path: resolve_router_bin_path(options)?,
        startup_path: if platform == "win32" {
            Some(resolve_windows_startup_path(options, &home))
        } else {
            None
        },
        launch_agent_path: if platform == "darwin" {
            Some(resolve_mac_launch_agent_path(&home))
        } else {
            None
        },
        bind_dir,
    })
}

fn format_base_url(host: &str, port: i64) -> String {
    let normalized_host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    format!("http://{normalized_host}:{port}")
}

fn read_port_from_base_url(base_url: Option<&str>, fallback: i64) -> i64 {
    let Some(url) = base_url else { return fallback };
    let rest = url.split_once("://").map(|(_, tail)| tail).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let port_str = if let Some(end) = authority.rfind(']') {
        authority[end + 1..].strip_prefix(':')
    } else {
        authority.rsplit_once(':').map(|(_, port)| port)
    };
    match port_str.and_then(|port| port.parse::<i64>().ok()) {
        Some(port) if port > 0 => port,
        _ => fallback,
    }
}

// ---------------------------------------------------------------------------
// Startup entries (Windows .cmd / macOS LaunchAgent)
// ---------------------------------------------------------------------------

fn escape_windows_batch_path(value: &str) -> String {
    value.replace('%', "%%")
}

/// Router argv shared by the spawn, the .cmd, and the plist. R3: no script
/// argument when `router_script_path` is empty.
fn router_args(state: &AppBindState) -> Vec<String> {
    let mut args = Vec::new();
    if !state.router_script_path.is_empty() {
        args.push(state.router_script_path.clone());
    }
    args.extend([
        "--port".to_string(),
        state.port.to_string(),
        "--status".to_string(),
        state.status_path.clone(),
        "--state".to_string(),
        state.state_path.clone(),
        "--log".to_string(),
        state.log_path.clone(),
        "--max-log-bytes".to_string(),
        APP_ROUTER_MAX_LOG_BYTES.to_string(),
    ]);
    args
}

fn create_windows_startup_command(state: &AppBindState) -> String {
    let node_path = escape_windows_batch_path(&state.node_path);
    let status_path = escape_windows_batch_path(&state.status_path);
    let state_path = escape_windows_batch_path(&state.state_path);
    let log_path = escape_windows_batch_path(&state.log_path);
    let router_part = if state.router_script_path.is_empty() {
        String::new()
    } else {
        format!(
            " \"{}\"",
            escape_windows_batch_path(&state.router_script_path)
        )
    };
    [
        "@echo off".to_string(),
        format!(
            "\"{node_path}\"{router_part} --port {} --status \"{status_path}\" --state \"{state_path}\" --log \"{log_path}\" --max-log-bytes {APP_ROUTER_MAX_LOG_BYTES} >> \"{log_path}\" 2>&1",
            state.port
        ),
        String::new(),
    ]
    .join("\r\n")
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn create_mac_launch_agent_plist(state: &AppBindState) -> String {
    let mut args = vec![state.node_path.clone()];
    args.extend(router_args(state));
    let mut lines = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_string(),
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
            .to_string(),
        "<plist version=\"1.0\">".to_string(),
        "<dict>".to_string(),
        "  <key>Label</key>".to_string(),
        format!("  <string>{MACOS_LAUNCH_AGENT_ID}</string>"),
        "  <key>ProgramArguments</key>".to_string(),
        "  <array>".to_string(),
    ];
    for arg in &args {
        lines.push(format!("    <string>{}</string>", xml_escape(arg)));
    }
    lines.extend([
        "  </array>".to_string(),
        "  <key>RunAtLoad</key>".to_string(),
        "  <true/>".to_string(),
        "  <key>KeepAlive</key>".to_string(),
        "  <true/>".to_string(),
        "  <key>StandardOutPath</key>".to_string(),
        format!("  <string>{}</string>", xml_escape(&state.log_path)),
        "  <key>StandardErrorPath</key>".to_string(),
        format!("  <string>{}</string>", xml_escape(&state.log_path)),
        "</dict>".to_string(),
        "</plist>".to_string(),
        String::new(),
    ]);
    lines.join("\n")
}

async fn write_app_bind_startup(state: &AppBindState) -> io::Result<()> {
    if state.platform == "win32"
        && let Some(startup_path) = &state.startup_path
    {
        let startup_path = PathBuf::from(startup_path);
        if let Some(parent) = startup_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        return atomic_write_file(&startup_path, &create_windows_startup_command(state), 0o600)
            .await;
    }
    if state.platform == "darwin"
        && let Some(launch_agent_path) = &state.launch_agent_path
    {
        let launch_agent_path = PathBuf::from(launch_agent_path);
        if let Some(parent) = launch_agent_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        return atomic_write_file(
            &launch_agent_path,
            &create_mac_launch_agent_plist(state),
            0o600,
        )
        .await;
    }
    Ok(())
}

async fn remove_app_bind_startup(state: &AppBindState) {
    for candidate in [&state.startup_path, &state.launch_agent_path]
        .into_iter()
        .flatten()
    {
        // Best-effort cleanup.
        let _ = unlink_if_exists(Path::new(candidate)).await;
    }
}

// ---------------------------------------------------------------------------
// Router lifecycle
// ---------------------------------------------------------------------------

/// Spawn the router detached: stdio to the append-mode log file (0o600),
/// Windows `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS` creation flags (no
/// console, survives parent); unix children survive the parent by default
/// (stdin null, stdout/stderr to the log — TS parity).
fn spawn_router(state: &AppBindState) -> io::Result<()> {
    let log_path = Path::new(&state.log_path);
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut open_options = std::fs::OpenOptions::new();
    open_options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.mode(0o600);
    }
    let log_file = open_options.open(log_path)?;
    let log_file_err = log_file.try_clone()?;
    let mut command = Command::new(&state.node_path);
    command
        .args(router_args(state))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{
            CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
        };
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    // Deliberately not waited on (Node `unref()` parity). CLI processes exit
    // shortly after, so the OS re-parents the detached router.
    let _child = command.spawn()?;
    Ok(())
}

async fn maybe_start_router(state: &AppBindState, options: &AppBindOptions) -> io::Result<bool> {
    if options.spawn_detached == Some(false) {
        return Ok(false);
    }
    let router = read_router_status(Path::new(&state.status_path)).await;
    if let Some(router) = router
        && is_process_alive(router.pid)
        && router.state.as_deref() == Some("running")
    {
        return Ok(false);
    }
    spawn_router(state)?;
    Ok(true)
}

fn resolve_router_ready_timeout_ms(options: &AppBindOptions) -> u64 {
    match options.router_ready_timeout_ms {
        Some(value) if value > 0 => value,
        _ => DEFAULT_ROUTER_READY_TIMEOUT_MS,
    }
}

async fn wait_for_router_status(
    status_path: &Path,
    timeout_ms: u64,
) -> Result<AppBindRouterStatus, String> {
    let mut latest: Option<AppBindRouterStatus> = None;
    let deadline = now_ms() + timeout_ms as i64;
    while now_ms() < deadline {
        let router = read_router_status(status_path).await;
        if let Some(router) = router {
            if router.state.as_deref() == Some("error") {
                let suffix = router
                    .last_error
                    .as_deref()
                    .map(|error| format!(": {error}"))
                    .unwrap_or_default();
                return Err(format!("Codex app runtime router failed to start{suffix}"));
            }
            if router.state.as_deref() == Some("running") && is_process_alive(router.pid) {
                return Ok(router);
            }
            latest = Some(router);
        }
        tokio::time::sleep(std::time::Duration::from_millis(
            ROUTER_STATUS_POLL_INTERVAL_MS,
        ))
        .await;
    }
    let suffix = latest
        .and_then(|router| router.last_error)
        .map(|error| format!(": {error}"))
        .unwrap_or_default();
    Err(format!("Codex app runtime router did not report ready{suffix}"))
}

async fn stop_router(router: Option<&AppBindRouterStatus>) {
    let Some(pid) = router.and_then(|router| router.pid) else {
        return;
    };
    if !is_process_alive(Some(pid)) {
        return;
    }
    terminate_process(pid);
    for _ in 0..20 {
        if !is_process_alive(Some(pid)) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn read_config_if_exists(config_path: &Path) -> (bool, String) {
    match tokio::fs::read_to_string(config_path).await {
        Ok(content) => (true, content),
        Err(_) => (false, String::new()),
    }
}

// ---------------------------------------------------------------------------
// Status / bind / unbind
// ---------------------------------------------------------------------------

/// Detects legacy TS-written bind states (R3): `routerScriptPath` non-empty
/// means the state still points `node` at `codex-app-router.js`; the manager
/// re-binds these on the next `rotation enable`.
pub fn is_legacy_ts_bind_state(state: &AppBindState) -> bool {
    !state.router_script_path.trim().is_empty()
}

pub async fn get_app_bind_status(options: &AppBindOptions) -> Result<AppBindStatus, String> {
    let paths = resolve_app_bind_paths(options)?;
    let state = read_app_bind_state(&paths.state_path).await;
    let router = read_router_status(&paths.status_path).await;
    // When no state file is present, the bind may still be live in config.toml
    // (orphaned bind, #614).
    let mut unmanaged_bind = false;
    if state.is_none() {
        let (existed, content) = read_config_if_exists(&paths.config_path).await;
        unmanaged_bind = existed && config_has_runtime_rotation_provider(&content);
    }
    Ok(AppBindStatus {
        bound: state.is_some() || unmanaged_bind,
        running: router
            .as_ref()
            .is_some_and(|router| {
                router.state.as_deref() == Some("running") && is_process_alive(router.pid)
            }),
        unmanaged_bind,
        state,
        router,
        paths,
    })
}

pub async fn bind_codex_app_runtime_rotation(
    options: &AppBindOptions,
) -> Result<AppBindResult, String> {
    let paths = resolve_app_bind_paths(options)?;
    let lock = lock_for(&paths.bind_dir);
    let _guard = lock.lock().await;
    bind_codex_app_runtime_rotation_locked(options, &paths).await
}

async fn bind_codex_app_runtime_rotation_locked(
    options: &AppBindOptions,
    paths: &AppBindPaths,
) -> Result<AppBindResult, String> {
    let platform = options.platform();
    let now = options.now();
    let existing_state = read_app_bind_state(&paths.state_path).await;
    let host = existing_state
        .as_ref()
        .map(|state| state.host.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let mut port = match &existing_state {
        Some(state) if state.port > 0 => state.port,
        _ => 0,
    };
    let mut base_url = existing_state
        .as_ref()
        .map(|state| state.base_url.clone())
        .unwrap_or_else(|| format_base_url(&host, port));
    let client_api_key = match &existing_state {
        Some(state) if !state.client_api_key.is_empty() => state.client_api_key.clone(),
        _ => create_app_bind_client_api_key(),
    };
    let (existed, content) = read_config_if_exists(&paths.config_path).await;
    let backup = match read_app_bind_backup(&paths.backup_path).await {
        Some(backup) => backup,
        None => AppBindBackup {
            config_path: path_to_string(&paths.config_path),
            existed,
            content: content.clone(),
            created_at: now,
        },
    };
    let bound_config = rewrite_config_toml_for_app_bind(&content, &base_url, &client_api_key);
    let mut state = AppBindState {
        version: 1,
        platform: platform.clone(),
        host,
        port,
        base_url: base_url.clone(),
        config_path: path_to_string(&paths.config_path),
        state_path: path_to_string(&paths.state_path),
        backup_path: path_to_string(&paths.backup_path),
        status_path: path_to_string(&paths.status_path),
        log_path: path_to_string(&paths.log_path),
        // R3: nodePath = the Rust router binary; routerScriptPath = "".
        node_path: path_to_string(&paths.router_bin_path),
        router_script_path: String::new(),
        client_api_key: client_api_key.clone(),
        startup_path: paths.startup_path.as_ref().map(|path| path_to_string(path)),
        launch_agent_path: paths
            .launch_agent_path
            .as_ref()
            .map(|path| path_to_string(path)),
        bound_config_hash: sha256_hex(&bound_config),
        updated_at: now,
    };

    tokio::fs::create_dir_all(&paths.bind_dir)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(config_dir) = paths.config_path.parent() {
        tokio::fs::create_dir_all(config_dir)
            .await
            .map_err(|error| error.to_string())?;
    }
    atomic_write_file(
        &paths.backup_path,
        &format!("{}\n", stringify_backup(&backup)),
        0o600,
    )
    .await
    .map_err(|error| error.to_string())?;
    // Write bootstrap state before spawning so the router can read --state on
    // startup.
    atomic_write_file(
        &paths.state_path,
        &format!("{}\n", stringify_pretty2(&state)),
        0o600,
    )
    .await
    .map_err(|error| error.to_string())?;

    let started_router = maybe_start_router(&state, options)
        .await
        .map_err(|error| error.to_string())?;
    let router = if started_router {
        Some(
            wait_for_router_status(
                Path::new(&state.status_path),
                resolve_router_ready_timeout_ms(options),
            )
            .await?,
        )
    } else {
        read_router_status(Path::new(&state.status_path)).await
    };
    let router_base_url = router.as_ref().and_then(|router| router.base_url.clone());
    let router_is_usable = router_base_url.is_some()
        && router.as_ref().is_some_and(|router| {
            started_router
                || (router.state.as_deref() == Some("running") && is_process_alive(router.pid))
        });
    if router_is_usable {
        port = read_port_from_base_url(router_base_url.as_deref(), port);
        base_url = router_base_url.clone().expect("router base url present");
    } else if !started_router
        && let Some(existing) = &existing_state
        && existing.port > 0
        && router.as_ref().is_some_and(|router| {
            router.state.as_deref() == Some("running") && is_process_alive(router.pid)
        })
    {
        // Only reuse existingState.port when the router process is verifiably
        // alive — stale status JSON of a dead router must not win.
        port = existing.port;
        base_url = existing.base_url.clone();
    }
    if port <= 0 {
        if started_router {
            // Best-effort stop of the router we just spawned.
            let orphan = read_router_status(Path::new(&state.status_path)).await;
            stop_router(orphan.as_ref()).await;
        }
        return Err(
            "Codex app bind could not resolve a runtime router port; refusing to write config.toml with port=0."
                .to_string(),
        );
    }
    let bound_config = rewrite_config_toml_for_app_bind(&content, &base_url, &client_api_key);
    state.port = port;
    state.base_url = base_url.clone();
    state.bound_config_hash = sha256_hex(&bound_config);
    state.updated_at = options.now();
    if started_router {
        options.log(&format!("Codex app runtime router started on {base_url}"));
    }
    atomic_write_file(&paths.config_path, &bound_config, 0o600)
        .await
        .map_err(|error| error.to_string())?;
    atomic_write_file(
        &paths.state_path,
        &format!("{}\n", stringify_pretty2(&state)),
        0o600,
    )
    .await
    .map_err(|error| error.to_string())?;
    write_app_bind_startup(&state)
        .await
        .map_err(|error| error.to_string())?;
    let status = get_app_bind_status(options).await?;
    Ok(AppBindResult {
        status,
        message: format!(
            "Bound Codex app config {} to {base_url}",
            path_to_string(&paths.config_path)
        ),
    })
}

/// Backup JSON keeps the TS property order: version, configPath, existed,
/// content, createdAt.
fn stringify_backup(backup: &AppBindBackup) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BackupWire<'a> {
        version: i64,
        config_path: &'a str,
        existed: bool,
        content: &'a str,
        created_at: i64,
    }
    stringify_pretty2(&BackupWire {
        version: 1,
        config_path: &backup.config_path,
        existed: backup.existed,
        content: &backup.content,
        created_at: backup.created_at,
    })
}

pub async fn unbind_codex_app_runtime_rotation(
    options: &AppBindOptions,
) -> Result<AppBindResult, String> {
    let paths = resolve_app_bind_paths(options)?;
    let lock = lock_for(&paths.bind_dir);
    let _guard = lock.lock().await;
    unbind_codex_app_runtime_rotation_locked(options, &paths).await
}

async fn unbind_codex_app_runtime_rotation_locked(
    options: &AppBindOptions,
    paths: &AppBindPaths,
) -> Result<AppBindResult, String> {
    let state = read_app_bind_state(&paths.state_path).await;
    let router = read_router_status(&paths.status_path).await;
    if let Some(state) = &state {
        stop_router(router.as_ref()).await;
        if let Some(pid) = router.as_ref().and_then(|router| router.pid)
            && is_process_alive(Some(pid))
        {
            options.log(&format!(
                "Warning: runtime router (pid {pid}) did not stop; continuing cleanup"
            ));
        }
        remove_app_bind_startup(state).await;
    }

    let backup = read_app_bind_backup(&paths.backup_path).await;
    let mut self_healed = false;
    if let Some(backup) = &backup {
        let backup_config_path = PathBuf::from(&backup.config_path);
        let (current_existed, current_content) = read_config_if_exists(&backup_config_path).await;
        let user_edited = state.as_ref().is_some_and(|state| {
            current_existed && sha256_hex(&current_content) != state.bound_config_hash
        });
        if user_edited {
            atomic_write_file(
                &backup_config_path,
                &restore_config_toml_from_app_bind(&current_content, &backup.content),
                0o600,
            )
            .await
            .map_err(|error| error.to_string())?;
        } else if backup.existed {
            if let Some(parent) = backup_config_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            atomic_write_file(&backup_config_path, &backup.content, 0o600)
                .await
                .map_err(|error| error.to_string())?;
        } else {
            unlink_if_exists(&backup_config_path)
                .await
                .map_err(|error| error.to_string())?;
        }
    } else if let Some(state) = &state {
        let state_config_path = PathBuf::from(&state.config_path);
        let (current_existed, current_content) = read_config_if_exists(&state_config_path).await;
        if current_existed {
            atomic_write_file(
                &state_config_path,
                &restore_config_toml_from_app_bind(&current_content, ""),
                0o600,
            )
            .await
            .map_err(|error| error.to_string())?;
        }
    } else {
        // Orphaned-bind recovery (#614): no backup and no state file, but the
        // config may still be bound to the runtime proxy. Consult the config
        // directly and self-heal it back to a working provider when bound.
        let (current_existed, current_content) = read_config_if_exists(&paths.config_path).await;
        if current_existed && config_has_runtime_rotation_provider(&current_content) {
            atomic_write_file(
                &paths.config_path,
                &restore_config_toml_from_runtime_rotation_provider_without_backup(
                    &current_content,
                    None,
                ),
                0o600,
            )
            .await
            .map_err(|error| error.to_string())?;
            self_healed = true;
        }
    }

    for candidate in [&paths.state_path, &paths.backup_path, &paths.status_path] {
        // Best-effort cleanup (ENOENT already ignored inside).
        let _ = unlink_if_exists(candidate).await;
    }

    let status = get_app_bind_status(options).await?;
    let message = if let Some(backup) = &backup {
        format!("Unbound Codex app config {}", backup.config_path)
    } else if self_healed {
        format!(
            "Restored Codex app config {} from an orphaned runtime-proxy bind (no backup was present)",
            path_to_string(&paths.config_path)
        )
    } else {
        "Codex app bind was not configured".to_string()
    };
    Ok(AppBindResult { status, message })
}

pub fn format_app_bind_status(status: &AppBindStatus) -> String {
    if status.unmanaged_bind && status.state.is_none() {
        return [
            format!(
                "Codex app bind: bound but unmanaged (config={} points at the runtime proxy, but no app-bind state/backup is present)",
                path_to_string(&status.paths.config_path)
            ),
            [
                "Run `codex-multi-auth rotation unbind-app` to restore the original",
                "Codex provider/config. This recovers the orphaned bind even though no",
                "backup was saved (#614).",
            ]
            .join(" "),
        ]
        .join("\n");
    }
    let Some(state) = status.state.as_ref().filter(|_| status.bound) else {
        return "Codex app bind: not configured".to_string();
    };
    let mut parts = vec![
        if status.running {
            "running".to_string()
        } else {
            "configured but router not running".to_string()
        },
        format!("port={}", state.port),
        format!("config={}", state.config_path),
    ];
    let router_label = status
        .router
        .as_ref()
        .and_then(|router| router.last_account_label.as_deref());
    match router_label {
        // Privacy: never print an email-shaped label.
        Some(label) if !label.contains('@') => {
            parts.push(format!("lastAccount={label}"));
        }
        _ => {
            if let Some(index) = status
                .router
                .as_ref()
                .and_then(|router| router.last_account_index)
            {
                parts.push(format!("lastAccount=Account {}", index + 1));
            }
        }
    }
    [
        format!("Codex app bind: {}", parts.join(", ")),
        [
            "Note: Codex Desktop may hide history while the app bind selects the",
            "codex-multi-auth-runtime-proxy provider; use `codex-multi-auth rotation",
            "unbind-app` or `codex-multi-auth rotation disable` to restore the original",
            "Codex provider/config.",
        ]
        .join(" "),
        [
            "Model speed/reasoning controls stay in Codex config/CLI flags; set",
            "`model_reasoning_effort` in",
            state.config_path.as_str(),
            "or pass",
            "`-c model_reasoning_effort=<level>` for wrapper-launched CLI sessions.",
        ]
        .join(" "),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_core::constants::RUNTIME_ROTATION_PROXY_PROVIDER_ID;
    use serial_test::serial;

    fn test_env(root: &Path) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert(
            "CODEX_MULTI_AUTH_DIR".to_string(),
            path_to_string(&root.join("multi%auth")),
        );
        env.insert(
            "CODEX_MULTI_AUTH_APP_BIND_CODEX_HOME".to_string(),
            path_to_string(&root.join("codex%home")),
        );
        env.insert(
            "APPDATA".to_string(),
            path_to_string(&root.join("App%20Data").join("Roaming")),
        );
        env
    }

    fn options_for(
        root: &Path,
        platform: &str,
        env: HashMap<String, String>,
        router_bin: &Path,
    ) -> AppBindOptions {
        AppBindOptions {
            env: Some(env),
            platform: Some(platform.to_string()),
            home: Some(root.to_path_buf()),
            router_bin_path: Some(router_bin.to_path_buf()),
            spawn_detached: Some(false),
            now: Some(Box::new(|| 123)),
            ..AppBindOptions::default()
        }
    }

    async fn seed_existing_app_bind_state(
        options: &AppBindOptions,
        port: i64,
        base_url: &str,
        node_path: &str,
        router_script_path: &str,
    ) -> AppBindPaths {
        let paths = resolve_app_bind_paths(options).expect("paths resolve");
        let state = AppBindState {
            version: 1,
            platform: options.platform(),
            host: "127.0.0.1".to_string(),
            port,
            base_url: base_url.to_string(),
            config_path: path_to_string(&paths.config_path),
            state_path: path_to_string(&paths.state_path),
            backup_path: path_to_string(&paths.backup_path),
            status_path: path_to_string(&paths.status_path),
            log_path: path_to_string(&paths.log_path),
            node_path: node_path.to_string(),
            router_script_path: router_script_path.to_string(),
            client_api_key: "a".repeat(64),
            startup_path: paths.startup_path.as_ref().map(|p| path_to_string(p)),
            launch_agent_path: paths.launch_agent_path.as_ref().map(|p| path_to_string(p)),
            bound_config_hash: sha256_hex("seed"),
            updated_at: 1,
        };
        tokio::fs::create_dir_all(&paths.bind_dir).await.unwrap();
        tokio::fs::write(
            &paths.state_path,
            format!("{}\n", stringify_pretty2(&state)),
        )
        .await
        .unwrap();
        paths
    }

    // app-bind.test.ts "resolves app bind paths from the provided environment"
    #[test]
    #[serial(env)]
    fn resolves_app_bind_paths_from_the_provided_environment() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let env = test_env(root);
        let options = AppBindOptions {
            env: Some(env),
            platform: Some("win32".to_string()),
            home: Some(root.to_path_buf()),
            router_bin_path: Some(root.join("router.exe")),
            ..AppBindOptions::default()
        };
        let paths = resolve_app_bind_paths(&options).expect("resolve");
        assert_eq!(paths.config_path, root.join("codex%home").join("config.toml"));
        assert_eq!(paths.bind_dir, root.join("multi%auth").join("app-bind"));
        assert_eq!(
            paths.startup_path,
            Some(
                root.join("App%20Data")
                    .join("Roaming")
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("Startup")
                    .join(WINDOWS_STARTUP_FILE)
            )
        );
        assert!(paths.launch_agent_path.is_none());
    }

    // app-bind.test.ts "fails fast when the router script cannot be resolved"
    // (message adapted to the R3 router binary name).
    #[test]
    #[serial(env)]
    fn fails_fast_when_the_router_binary_cannot_be_resolved() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let options = AppBindOptions {
            env: Some(test_env(root)),
            platform: Some("linux".to_string()),
            home: Some(root.to_path_buf()),
            router_bin_candidates: Some(vec![
                root.join("missing-router-a"),
                root.join("missing-router-b"),
            ]),
            spawn_detached: Some(false),
            ..AppBindOptions::default()
        };
        let error = resolve_app_bind_paths(&options).expect_err("must fail");
        assert!(error.contains("codex-multi-auth-app-router not found"));
        assert!(error.contains("missing-router-a"));
        assert!(error.contains("missing-router-b"));
    }

    // app-bind.test.ts "binds and unbinds the Windows app config without
    // spawning during tests" (+ orphan recovery pieces below).
    #[tokio::test]
    #[serial(env)]
    async fn binds_and_unbinds_the_windows_app_config_without_spawning() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let env = test_env(root);
        let codex_home = root.join("codex%home");
        let router_bin = root.join("Router%20Dir").join("codex-multi-auth-app-router.exe");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(codex_home.join("config.toml"), "model_provider = \"openai\"\n")
            .await
            .unwrap();

        let options = options_for(root, "win32", env.clone(), &router_bin);
        seed_existing_app_bind_state(&options, 4567, "http://127.0.0.1:4567", "node", "legacy.js")
            .await;

        let result = bind_codex_app_runtime_rotation(&options)
            .await
            .expect("bind succeeds");
        assert!(result.status.bound);
        assert!(!result.status.running);
        let state = result.status.state.as_ref().expect("state present");
        assert_eq!(
            state.state_path,
            path_to_string(
                &root
                    .join("multi%auth")
                    .join("app-bind")
                    .join("runtime-rotation-app-bind.json")
            )
        );
        // R3: nodePath is the router binary; routerScriptPath is "".
        assert_eq!(state.node_path, path_to_string(&router_bin));
        assert_eq!(state.router_script_path, "");
        assert_eq!(state.port, 4567);
        let config = tokio::fs::read_to_string(codex_home.join("config.toml"))
            .await
            .unwrap();
        assert!(config.contains(&format!(
            "[model_providers.{RUNTIME_ROTATION_PROXY_PROVIDER_ID}]"
        )));
        assert!(config.contains(&state.base_url));
        assert!(config.contains("requires_openai_auth = false"));
        assert!(config.contains(&format!(
            "experimental_bearer_token = \"{}\"",
            state.client_api_key
        )));
        assert!(!config.contains("env_key"));
        // boundConfigHash gates unbind: must be the hash of the written text.
        assert_eq!(state.bound_config_hash, sha256_hex(&config));

        let startup_path = result.status.paths.startup_path.clone().expect("startup");
        let startup = tokio::fs::read_to_string(&startup_path).await.unwrap();
        assert!(startup.contains("--state"));
        assert!(startup.contains("--log"));
        assert!(startup.contains("--max-log-bytes 1048576"));
        assert!(startup.contains("runtime-rotation-app-bind.json"));
        assert!(startup.contains("Router%%20Dir"));
        assert!(startup.contains("multi%%auth"));
        assert!(!startup.contains("Router%20Dir"));
        assert!(!startup.contains(&state.client_api_key));
        // CRLF joined, `@echo off` first line.
        assert!(startup.starts_with("@echo off\r\n"));
        assert!(startup.ends_with("2>&1\r\n"));

        let unbind_options = options_for(root, "win32", env, &router_bin);
        let unbound = unbind_codex_app_runtime_rotation(&unbind_options)
            .await
            .expect("unbind succeeds");
        assert!(!unbound.status.bound);
        assert!(unbound.message.starts_with("Unbound Codex app config "));
        assert_eq!(
            tokio::fs::read_to_string(codex_home.join("config.toml"))
                .await
                .unwrap(),
            "model_provider = \"openai\"\n"
        );
        assert!(!startup_path.exists());
    }

    // app-bind.test.ts "refuses to bind without spawning when no router port
    // is known"
    #[tokio::test]
    #[serial(env)]
    async fn refuses_to_bind_without_spawning_when_no_router_port_is_known() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let codex_home = root.join("codex%home");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        let options = options_for(root, "linux", test_env(root), &root.join("router-bin"));
        let error = bind_codex_app_runtime_rotation(&options)
            .await
            .expect_err("must refuse");
        assert!(error.contains("port=0"));
    }

    // app-bind.test.ts "rejects corrupt app bind state without a client token"
    #[tokio::test]
    #[serial(env)]
    async fn rejects_corrupt_app_bind_state_without_a_client_token() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let options = options_for(root, "linux", test_env(root), &root.join("router-bin"));
        let paths = resolve_app_bind_paths(&options).unwrap();
        tokio::fs::create_dir_all(&paths.bind_dir).await.unwrap();
        // clientApiKey missing → whole state treated as null → port unknown.
        let corrupt = serde_json::json!({
            "version": 1,
            "platform": "linux",
            "host": "127.0.0.1",
            "port": 4567,
            "baseUrl": "http://127.0.0.1:4567",
            "configPath": path_to_string(&paths.config_path),
            "statePath": path_to_string(&paths.state_path),
            "backupPath": path_to_string(&paths.backup_path),
            "statusPath": path_to_string(&paths.status_path),
            "logPath": path_to_string(&paths.log_path),
            "nodePath": "node",
            "routerScriptPath": "router.js",
            "boundConfigHash": "abc",
            "updatedAt": 1
        });
        tokio::fs::write(&paths.state_path, stringify_pretty2(&corrupt))
            .await
            .unwrap();
        let error = bind_codex_app_runtime_rotation(&options)
            .await
            .expect_err("must refuse");
        assert!(error.contains("port=0"));
    }

    // app-bind.test.ts "serializes concurrent binds so state and config stay
    // coherent"
    #[tokio::test]
    #[serial(env)]
    async fn serializes_concurrent_binds_so_state_and_config_stay_coherent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let env = test_env(root);
        let codex_home = root.join("codex%home");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(codex_home.join("config.toml"), "model_provider = \"openai\"\n")
            .await
            .unwrap();
        let seed_options = options_for(root, "linux", env.clone(), &root.join("router-bin"));
        let paths = seed_existing_app_bind_state(
            &seed_options,
            4567,
            "http://127.0.0.1:4567",
            "node",
            "router.js",
        )
        .await;

        let options_a = options_for(root, "linux", env.clone(), &root.join("router-bin"));
        let options_b = options_for(root, "linux", env, &root.join("router-bin"));
        let (first, second) = tokio::join!(
            bind_codex_app_runtime_rotation(&options_a),
            bind_codex_app_runtime_rotation(&options_b),
        );
        assert!(first.expect("first bind").status.bound);
        assert!(second.expect("second bind").status.bound);

        let config = tokio::fs::read_to_string(&paths.config_path).await.unwrap();
        let state: Value = serde_json::from_str(
            &tokio::fs::read_to_string(&paths.state_path).await.unwrap(),
        )
        .unwrap();
        let backup: Value = serde_json::from_str(
            &tokio::fs::read_to_string(&paths.backup_path).await.unwrap(),
        )
        .unwrap();
        assert!(config.contains(&format!(
            "model_provider = \"{RUNTIME_ROTATION_PROXY_PROVIDER_ID}\""
        )));
        let client_api_key = state["clientApiKey"].as_str().unwrap();
        assert!(config.contains(&format!("experimental_bearer_token = \"{client_api_key}\"")));
        assert_eq!(state["boundConfigHash"].as_str().unwrap(), sha256_hex(&config));
        assert_eq!(
            backup["content"].as_str().unwrap(),
            "model_provider = \"openai\"\n"
        );
    }

    // app-bind.test.ts "reports unmanagedBind when config is bound but no
    // state file exists" (#614)
    #[tokio::test]
    #[serial(env)]
    async fn reports_unmanaged_bind_when_config_is_bound_but_no_state_file_exists() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let codex_home = root.join("codex%home");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        let bound = rewrite_config_toml_for_app_bind(
            "model_provider = \"openai\"\n",
            "http://127.0.0.1:4567",
            "secret",
        );
        tokio::fs::write(codex_home.join("config.toml"), &bound)
            .await
            .unwrap();
        let options = options_for(root, "linux", test_env(root), &root.join("router-bin"));
        let status = get_app_bind_status(&options).await.expect("status");
        assert!(status.bound);
        assert!(status.unmanaged_bind);
        assert!(status.state.is_none());
        let formatted = format_app_bind_status(&status);
        assert!(formatted.contains("bound but unmanaged"));
        assert!(formatted.contains("#614"));
    }

    // app-bind.test.ts "self-heals a bound config with no backup/state on
    // unbind" (#614)
    #[tokio::test]
    #[serial(env)]
    async fn self_heals_a_bound_config_with_no_backup_or_state_on_unbind() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let codex_home = root.join("codex%home");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        let bound = rewrite_config_toml_for_app_bind(
            "model_provider = \"openai\"\n",
            "http://127.0.0.1:4567",
            "secret",
        );
        tokio::fs::write(codex_home.join("config.toml"), &bound)
            .await
            .unwrap();
        let options = options_for(root, "linux", test_env(root), &root.join("router-bin"));
        let result = unbind_codex_app_runtime_rotation(&options)
            .await
            .expect("unbind");
        assert!(result
            .message
            .contains("from an orphaned runtime-proxy bind (no backup was present)"));
        let config = tokio::fs::read_to_string(codex_home.join("config.toml"))
            .await
            .unwrap();
        assert!(config.contains("model_provider = \"openai\""));
        assert!(!config.contains(RUNTIME_ROTATION_PROXY_PROVIDER_ID));
        let status = get_app_bind_status(&options).await.expect("status");
        assert!(!status.bound);
        assert!(!status.unmanaged_bind);
    }

    // app-bind.test.ts "is a no-op for an already-clean config"
    #[tokio::test]
    #[serial(env)]
    async fn unbind_is_a_no_op_for_an_already_clean_config() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let codex_home = root.join("codex%home");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(codex_home.join("config.toml"), "model_provider = \"openai\"\n")
            .await
            .unwrap();
        let options = options_for(root, "linux", test_env(root), &root.join("router-bin"));
        let result = unbind_codex_app_runtime_rotation(&options)
            .await
            .expect("unbind");
        assert_eq!(result.message, "Codex app bind was not configured");
        assert_eq!(
            tokio::fs::read_to_string(codex_home.join("config.toml"))
                .await
                .unwrap(),
            "model_provider = \"openai\"\n"
        );
    }

    // app-bind.test.ts "writes a macOS LaunchAgent for login-time router
    // startup" (content shape only; no spawn).
    #[tokio::test]
    #[serial(env)]
    async fn writes_a_macos_launch_agent_for_login_time_router_startup() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let env = test_env(root);
        let codex_home = root.join("codex%home");
        let router_bin = root.join("bin").join("codex-multi-auth-app-router");
        tokio::fs::create_dir_all(&codex_home).await.unwrap();
        tokio::fs::write(
            codex_home.join("config.toml"),
            "model_provider = \"open&i\"\n",
        )
        .await
        .unwrap();
        let options = options_for(root, "darwin", env, &router_bin);
        seed_existing_app_bind_state(&options, 4567, "http://127.0.0.1:4567", "node", "router.js")
            .await;
        let result = bind_codex_app_runtime_rotation(&options)
            .await
            .expect("bind succeeds");
        let launch_agent_path = result
            .status
            .paths
            .launch_agent_path
            .clone()
            .expect("launch agent path");
        let plist = tokio::fs::read_to_string(&launch_agent_path).await.unwrap();
        assert!(plist.contains(&format!("<string>{MACOS_LAUNCH_AGENT_ID}</string>")));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<string>--max-log-bytes</string>"));
        assert!(plist.contains("<string>1048576</string>"));
        // R3: the binary is argv[0]; no .js argument follows.
        assert!(plist.contains(&format!("<string>{}</string>", xml_escape(&path_to_string(&router_bin)))));
        assert!(!plist.contains("router.js"));
        assert!(plist.ends_with("</plist>\n"));
    }

    // formatAppBindStatus privacy contract (spec 10 gotcha 19).
    #[test]
    fn format_app_bind_status_never_prints_email_labels() {
        let paths = AppBindPaths {
            codex_home: PathBuf::from("/h/.codex"),
            config_path: PathBuf::from("/h/.codex/config.toml"),
            bind_dir: PathBuf::from("/h/.codex/multi-auth/app-bind"),
            state_path: PathBuf::from("/h/state"),
            backup_path: PathBuf::from("/h/backup"),
            status_path: PathBuf::from("/h/status"),
            log_path: PathBuf::from("/h/log"),
            router_bin_path: PathBuf::from("/h/router"),
            startup_path: None,
            launch_agent_path: None,
        };
        let state = AppBindState {
            version: 1,
            platform: "linux".to_string(),
            host: "127.0.0.1".to_string(),
            port: 4567,
            base_url: "http://127.0.0.1:4567".to_string(),
            config_path: "/h/.codex/config.toml".to_string(),
            state_path: "/h/state".to_string(),
            backup_path: "/h/backup".to_string(),
            status_path: "/h/status".to_string(),
            log_path: "/h/log".to_string(),
            node_path: "/h/router".to_string(),
            router_script_path: String::new(),
            client_api_key: "k".repeat(64),
            startup_path: None,
            launch_agent_path: None,
            bound_config_hash: "hash".to_string(),
            updated_at: 1,
        };
        let router = AppBindRouterStatus {
            state: Some("running".to_string()),
            pid: Some(1),
            last_account_label: Some("user@example.com".to_string()),
            last_account_index: Some(2),
            ..AppBindRouterStatus::default()
        };
        let status = AppBindStatus {
            bound: true,
            running: true,
            unmanaged_bind: false,
            state: Some(state),
            router: Some(router),
            paths,
        };
        let formatted = format_app_bind_status(&status);
        assert!(!formatted.contains("user@example.com"));
        assert!(formatted.contains("lastAccount=Account 3"));
        assert!(formatted.contains("port=4567"));
        assert!(formatted.contains("Codex app bind: running"));
    }

    #[test]
    fn format_app_bind_status_not_configured() {
        let paths = AppBindPaths {
            codex_home: PathBuf::from("/h/.codex"),
            config_path: PathBuf::from("/h/.codex/config.toml"),
            bind_dir: PathBuf::from("/h/mad/app-bind"),
            state_path: PathBuf::from("/h/state"),
            backup_path: PathBuf::from("/h/backup"),
            status_path: PathBuf::from("/h/status"),
            log_path: PathBuf::from("/h/log"),
            router_bin_path: PathBuf::from("/h/router"),
            startup_path: None,
            launch_agent_path: None,
        };
        let status = AppBindStatus {
            bound: false,
            running: false,
            unmanaged_bind: false,
            state: None,
            router: None,
            paths,
        };
        assert_eq!(format_app_bind_status(&status), "Codex app bind: not configured");
    }

    // State serialization: exact key order + null startup fields (spec 12.1).
    #[test]
    fn state_serializes_in_ts_property_order_with_null_optionals() {
        let state = AppBindState {
            version: 1,
            platform: "win32".to_string(),
            host: "127.0.0.1".to_string(),
            port: 8123,
            base_url: "http://127.0.0.1:8123".to_string(),
            config_path: "c".to_string(),
            state_path: "s".to_string(),
            backup_path: "b".to_string(),
            status_path: "t".to_string(),
            log_path: "l".to_string(),
            node_path: "n".to_string(),
            router_script_path: String::new(),
            client_api_key: "k".to_string(),
            startup_path: None,
            launch_agent_path: None,
            bound_config_hash: "h".to_string(),
            updated_at: 1_753_500_000_000,
        };
        let raw = stringify_pretty2(&state);
        let keys = [
            "\"version\"",
            "\"platform\"",
            "\"host\"",
            "\"port\"",
            "\"baseUrl\"",
            "\"configPath\"",
            "\"statePath\"",
            "\"backupPath\"",
            "\"statusPath\"",
            "\"logPath\"",
            "\"nodePath\"",
            "\"routerScriptPath\"",
            "\"clientApiKey\"",
            "\"startupPath\"",
            "\"launchAgentPath\"",
            "\"boundConfigHash\"",
            "\"updatedAt\"",
        ];
        let mut last = 0;
        for key in keys {
            let idx = raw.find(key).unwrap_or_else(|| panic!("missing {key}"));
            assert!(idx > last || last == 0, "key out of order: {key}");
            last = idx;
        }
        assert!(raw.contains("\"startupPath\": null"));
        assert!(raw.contains("\"launchAgentPath\": null"));
        assert!(raw.contains("\"routerScriptPath\": \"\""));
    }

    #[test]
    fn legacy_ts_bind_state_detection() {
        let mut state = AppBindState {
            version: 1,
            platform: "linux".to_string(),
            host: "127.0.0.1".to_string(),
            port: 1,
            base_url: "http://127.0.0.1:1".to_string(),
            config_path: "c".to_string(),
            state_path: "s".to_string(),
            backup_path: "b".to_string(),
            status_path: "t".to_string(),
            log_path: "l".to_string(),
            node_path: "/usr/bin/node".to_string(),
            router_script_path: "/x/scripts/codex-app-router.js".to_string(),
            client_api_key: "k".to_string(),
            startup_path: None,
            launch_agent_path: None,
            bound_config_hash: "h".to_string(),
            updated_at: 1,
        };
        assert!(is_legacy_ts_bind_state(&state));
        state.router_script_path = String::new();
        assert!(!is_legacy_ts_bind_state(&state));
    }

    #[test]
    fn format_base_url_brackets_ipv6_hosts() {
        assert_eq!(format_base_url("127.0.0.1", 8080), "http://127.0.0.1:8080");
        assert_eq!(format_base_url("::1", 8080), "http://[::1]:8080");
        assert_eq!(format_base_url("[::1]", 8080), "http://[::1]:8080");
    }

    #[test]
    fn read_port_from_base_url_parses_and_falls_back() {
        assert_eq!(read_port_from_base_url(Some("http://127.0.0.1:8123"), 1), 8123);
        assert_eq!(read_port_from_base_url(Some("http://[::1]:9000"), 1), 9000);
        assert_eq!(read_port_from_base_url(Some("not a url"), 7), 7);
        assert_eq!(read_port_from_base_url(None, 7), 7);
        assert_eq!(read_port_from_base_url(Some("http://h:0"), 7), 7);
    }
}
