//! Port of `lib/logger.ts`: process-wide logging.
//!
//! - Env flags are read ONCE at first use (OnceLock) — mirroring the TS
//!   module-import-time evaluation (spec 01 gotcha 17).
//! - Masking order is EMAIL-BEFORE-TOKEN (gotcha 14): the token regexes would
//!   otherwise eat email fragments. Structured `email` keys use `mask_email`,
//!   never `mask_token` (which leaks local part + TLD).
//! - CR/LF are stripped from every console message (log-injection defense).
//! - `sanitize_value` recurses to depth 10 with the SENSITIVE_KEYS set matched
//!   on keys normalized to lowercase with `-`/`_` removed.
//! - Correlation ids: tokio task-local scope with a module-global fallback for
//!   the legacy single-flight path. Inside a scope the scope ALWAYS wins —
//!   including a cleared (`None`) id (gotcha: cleared-scope-wins).
//! - Request logs: `request-<n>-<stage>.json`, mode 0600, in a 0700 dir under
//!   `<multi-auth-dir>/logs/codex-plugin/`; 2-space pretty JSON, NO trailing
//!   newline. An ENOENT write failure invalidates the cached dir-ready flag so
//!   a deleted log dir self-heals (gotcha 15).
//! - The warn-once registry is process-global, keyed on the FULL message
//!   string, and never expires except via [`__reset_for_tests`].
//!
//! The TS app-client sink (`initLogger(client)`) has no JS host in the Rust
//! port; [`init_logger`] is kept as a no-op for API parity and the console
//! sink (gated on `CODEX_CONSOLE_LOG=1`) is the only live output.

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, Once, OnceLock};
use std::time::Instant;

use regex::Regex;
use serde_json::Value;

use crate::constants::PLUGIN_NAME;

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

/// Log level: `debug` < `info` < `warn` < `error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    /// Numeric priority (debug 0 … error 3).
    pub fn priority(self) -> u8 {
        match self {
            LogLevel::Debug => 0,
            LogLevel::Info => 1,
            LogLevel::Warn => 2,
            LogLevel::Error => 3,
        }
    }

    /// The lowercase level name as used by the TS logger.
    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Parse `CODEX_PLUGIN_LOG_LEVEL`: lowercase + trim; must be one of the four
/// level names, else `info`.
pub fn parse_log_level(value: Option<&str>) -> LogLevel {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return LogLevel::Info;
    };
    match value.to_lowercase().trim() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    }
}

// ---------------------------------------------------------------------------
// Env-init flags (read once at first use)
// ---------------------------------------------------------------------------

struct LoggerEnv {
    logging_enabled: bool,
    request_body_logging_enabled: bool,
    debug_enabled: bool,
    log_level: LogLevel,
    console_enabled: bool,
}

static LOGGER_ENV: OnceLock<LoggerEnv> = OnceLock::new();
static BANNER_ONCE: Once = Once::new();

fn env_is_1(name: &str) -> bool {
    std::env::var(name).map(|v| v == "1").unwrap_or(false)
}

fn read_logger_env() -> LoggerEnv {
    let logging_enabled = env_is_1("ENABLE_PLUGIN_REQUEST_LOGGING");
    let request_body_logging_enabled = env_is_1("CODEX_PLUGIN_LOG_BODIES");
    let debug_enabled = env_is_1("DEBUG_CODEX_PLUGIN") || logging_enabled;
    let log_level = parse_log_level(std::env::var("CODEX_PLUGIN_LOG_LEVEL").ok().as_deref());
    let console_enabled = env_is_1("CODEX_CONSOLE_LOG");
    LoggerEnv {
        logging_enabled,
        request_body_logging_enabled,
        debug_enabled,
        log_level,
        console_enabled,
    }
}

/// Read the env flags (once) and emit the TS import-time banner on first use.
fn logger_env() -> &'static LoggerEnv {
    let env = LOGGER_ENV.get_or_init(read_logger_env);
    BANNER_ONCE.call_once(|| {
        // The TS banner goes through logToConsole, which is gated on
        // CODEX_CONSOLE_LOG — replicate the gate here (direct print: calling
        // log_to_console from inside this Once would re-enter it).
        if !env.console_enabled {
            return;
        }
        if env.logging_enabled {
            let dir = log_dir();
            if env.request_body_logging_enabled {
                println!(
                    "[{PLUGIN_NAME}] Request logging ENABLED (raw payload capture ON) - logs will be saved to: {}",
                    dir.display()
                );
            } else {
                println!(
                    "[{PLUGIN_NAME}] Request logging ENABLED (metadata only; set CODEX_PLUGIN_LOG_BODIES=1 for raw payloads) - logs will be saved to: {}",
                    dir.display()
                );
            }
        } else if env.debug_enabled {
            println!(
                "[{PLUGIN_NAME}] Debug logging ENABLED (level: {})",
                env.log_level
            );
        }
    });
    env
}

/// `ENABLE_PLUGIN_REQUEST_LOGGING === "1"` (file request logs; implies debug).
pub fn logging_enabled() -> bool {
    logger_env().logging_enabled
}

/// `CODEX_PLUGIN_LOG_BODIES === "1"` (keep body/fullContent in request logs).
pub fn request_body_logging_enabled() -> bool {
    logger_env().request_body_logging_enabled
}

/// `DEBUG_CODEX_PLUGIN === "1"` OR request logging enabled.
pub fn debug_enabled() -> bool {
    logger_env().debug_enabled
}

/// Effective `CODEX_PLUGIN_LOG_LEVEL` (default `info`).
pub fn log_level() -> LogLevel {
    logger_env().log_level
}

/// Install the host app log sink. The JS plugin host is not ported (R1), so
/// this is a no-op retained for API parity; the console sink
/// (`CODEX_CONSOLE_LOG=1`) is the only live output channel.
pub fn init_logger() {}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

static EMAIL_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").expect("email regex")
});

static TOKEN_PATTERNS: LazyLock<[Regex; 5]> = LazyLock::new(|| {
    [
        Regex::new(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").expect("jwt regex"),
        Regex::new(r"(?i)[a-f0-9]{40,}").expect("hex regex"),
        Regex::new(r"sk-[A-Za-z0-9]{20,}").expect("sk regex"),
        Regex::new(r"(?i)Bearer\s+\S+").expect("bearer regex"),
        // This app's own local bearer tokens: `cma_local_<base64url>` (see
        // lib/local-client-tokens.ts). The structured-log key masker and the
        // OAuth scrubber cover the normal paths, but the free-text scrubber is
        // the last line of defense and must recognize the project's own token
        // shape too.
        Regex::new(r"cma_local_[A-Za-z0-9_-]{16,}").expect("cma_local regex"),
    ]
});

static CRLF_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\r\n]+").expect("crlf regex"));

/// SENSITIVE_KEYS after normalization (lowercase, `-`/`_` stripped); the TS
/// source lists both raw and normalized spellings, which collapse to this set.
const SENSITIVE_KEYS: [&str; 14] = [
    "access",
    "accesstoken",
    "refresh",
    "refreshtoken",
    "token",
    "authorization",
    "apikey",
    "experimentalbearertoken",
    "secret",
    "password",
    "credential",
    "idtoken",
    "email",
    "accountid",
];

fn normalize_key(key: &str) -> String {
    key.to_lowercase().replace(['-', '_'], "")
}

/// Mask a token: length <= 12 fully masked, else first 6 + `...` + last 4.
pub fn mask_token(token: &str) -> String {
    let count = token.chars().count();
    if count <= 12 {
        return "***MASKED***".to_string();
    }
    let head: String = token.chars().take(6).collect();
    let tail: String = token.chars().skip(count - 4).collect();
    format!("{head}...{tail}")
}

/// Mask an email: keep <= 2 chars of the local part and the TLD only.
pub fn mask_email(email: &str) -> String {
    let Some(at_index) = email.find('@') else {
        return "***@***".to_string();
    };
    let local = &email[..at_index];
    let domain = &email[at_index + 1..];
    let tld = domain.rsplit('.').next().unwrap_or("");
    let prefix: String = local.chars().take(2).collect();
    format!("{prefix}***@***.{tld}")
}

/// Mask free text: emails FIRST (before token patterns might match parts of
/// them), then the token patterns in declaration order.
pub fn mask_string(value: &str) -> String {
    let mut result = EMAIL_PATTERN
        .replace_all(value, |caps: &regex::Captures<'_>| mask_email(&caps[0]))
        .into_owned();
    for pattern in TOKEN_PATTERNS.iter() {
        result = pattern
            .replace_all(&result, |caps: &regex::Captures<'_>| mask_token(&caps[0]))
            .into_owned();
    }
    result
}

fn sanitize_value_at(value: &Value, depth: u32) -> Value {
    if depth > 10 {
        return Value::String("[max depth]".to_string());
    }

    match value {
        Value::String(s) => Value::String(mask_string(s)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| sanitize_value_at(item, depth + 1))
                .collect(),
        ),
        Value::Object(map) => {
            let mut sanitized = serde_json::Map::new();
            for (key, val) in map {
                let normalized_key = normalize_key(key);
                if SENSITIVE_KEYS.contains(&normalized_key.as_str()) {
                    let masked = match val {
                        // An email value masked with mask_token leaks the local
                        // part and TLD; structured `email` fields use the
                        // dedicated email masker to match the free-text path.
                        Value::String(s) if normalized_key == "email" => {
                            Value::String(mask_email(s))
                        }
                        Value::String(s) => Value::String(mask_token(s)),
                        _ => Value::String("***MASKED***".to_string()),
                    };
                    sanitized.insert(key.clone(), masked);
                } else {
                    sanitized.insert(key.clone(), sanitize_value_at(val, depth + 1));
                }
            }
            Value::Object(sanitized)
        }
        other => other.clone(),
    }
}

/// Recursively mask sensitive material in a JSON value (depth cap 10).
pub fn sanitize_value(value: &Value) -> Value {
    sanitize_value_at(value, 0)
}

/// Format a duration in ms: `<1000` -> `NNNms`; `<60000` -> `S.SSs`;
/// else `Mm S.Ss`.
pub fn format_duration(ms: f64) -> String {
    if ms < 1000.0 {
        return format!("{}ms", ms.round() as i64);
    }
    if ms < 60000.0 {
        return format!("{:.2}s", ms / 1000.0);
    }
    let minutes = (ms / 60000.0).floor() as i64;
    let seconds = (ms % 60000.0) / 1000.0;
    format!("{minutes}m {seconds:.1}s")
}

// ---------------------------------------------------------------------------
// Correlation ids (errors-logging-02)
// ---------------------------------------------------------------------------
//
// A single process-global was wrong for the concurrent runtime proxy: many
// requests are in flight at once, so a global last-writer-wins value tags log
// lines with the wrong request. A tokio task-local scopes the id to each
// request's task. The module-global fallback is retained ONLY for legacy
// single-flight callers; new concurrent code should use
// `run_with_correlation_id`. NOTE: task-local values do NOT cross
// `tokio::spawn` — any spawn inside a scoped region must re-wrap explicitly.

tokio::task_local! {
    static CORRELATION_SCOPE: RefCell<Option<String>>;
}

static FALLBACK_CORRELATION_ID: Mutex<Option<String>> = Mutex::new(None);

fn new_correlation_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn lock_fallback() -> std::sync::MutexGuard<'static, Option<String>> {
    FALLBACK_CORRELATION_ID
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Run `fut` with a correlation id bound to its task-local scope.
/// Concurrent-safe: each invocation gets an isolated id that does not leak
/// across requests. Omitted id -> a fresh random UUID.
pub async fn run_with_correlation_id<F>(id: Option<String>, fut: F) -> F::Output
where
    F: std::future::Future,
{
    let resolved = id.unwrap_or_else(new_correlation_id);
    CORRELATION_SCOPE.scope(RefCell::new(Some(resolved)), fut).await
}

/// Synchronous variant of [`run_with_correlation_id`] for non-async callers.
pub fn run_with_correlation_id_sync<T>(id: Option<String>, f: impl FnOnce() -> T) -> T {
    let resolved = id.unwrap_or_else(new_correlation_id);
    CORRELATION_SCOPE.sync_scope(RefCell::new(Some(resolved)), f)
}

/// Set the correlation id: inside a scope, mutates the scoped id in place;
/// outside, sets the module-global fallback. Returns the resolved id (a fresh
/// UUID when omitted).
pub fn set_correlation_id(id: Option<String>) -> String {
    let resolved = id.unwrap_or_else(new_correlation_id);
    let in_scope = CORRELATION_SCOPE
        .try_with(|cell| {
            *cell.borrow_mut() = Some(resolved.clone());
        })
        .is_ok();
    if !in_scope {
        *lock_fallback() = Some(resolved.clone());
    }
    resolved
}

/// Get the correlation id. Inside a scope the scoped id is authoritative —
/// including a cleared `None` (scope wins over fallback; never leak the
/// fallback into a cleared scope). Only outside any scope does the
/// module-global fallback apply.
pub fn get_correlation_id() -> Option<String> {
    match CORRELATION_SCOPE.try_with(|cell| cell.borrow().clone()) {
        Ok(scoped) => scoped,
        Err(_) => lock_fallback().clone(),
    }
}

/// Clear the correlation id in the active scope, or the global fallback when
/// no scope is active.
pub fn clear_correlation_id() {
    let in_scope = CORRELATION_SCOPE
        .try_with(|cell| {
            *cell.borrow_mut() = None;
        })
        .is_ok();
    if !in_scope {
        *lock_fallback() = None;
    }
}

// ---------------------------------------------------------------------------
// Console sink
// ---------------------------------------------------------------------------

fn strip_crlf(message: &str) -> String {
    CRLF_PATTERN.replace_all(message, " ").into_owned()
}

/// The single sanctioned console sink for the whole package: every message is
/// mask-sanitized (and CR/LF-stripped) before it reaches the terminal.
/// `console.warn`/`console.error` map to stderr, everything else to stdout.
fn log_to_console(level: LogLevel, message: &str, data: Option<&Value>) {
    let env = logger_env();
    if !env.console_enabled {
        return;
    }
    let sanitized_message = strip_crlf(&mask_string(message));
    let sanitized_data = data.map(sanitize_value);

    let line = match &sanitized_data {
        Some(value) => {
            let rendered = serde_json::to_string(value).unwrap_or_default();
            format!("{sanitized_message} {rendered}")
        }
        None => sanitized_message,
    };
    match level {
        LogLevel::Warn | LogLevel::Error => eprintln!("{line}"),
        _ => println!("{line}"),
    }
}

fn should_log(level: LogLevel) -> bool {
    if level == LogLevel::Error {
        return true;
    }
    let env = logger_env();
    if !env.debug_enabled && !env.logging_enabled {
        return false;
    }
    level.priority() >= env.log_level.priority()
}

/// Debug-level log (gated by env flags and `CODEX_PLUGIN_LOG_LEVEL`).
pub fn log_debug(message: &str, data: Option<&Value>) {
    if !should_log(LogLevel::Debug) {
        return;
    }
    log_to_console(LogLevel::Debug, &format!("[{PLUGIN_NAME}] {message}"), data);
}

/// Info-level log.
pub fn log_info(message: &str, data: Option<&Value>) {
    if !should_log(LogLevel::Info) {
        return;
    }
    log_to_console(LogLevel::Info, &format!("[{PLUGIN_NAME}] {message}"), data);
}

/// Warn-level log.
pub fn log_warn(message: &str, data: Option<&Value>) {
    if !should_log(LogLevel::Warn) {
        return;
    }
    log_to_console(LogLevel::Warn, &format!("[{PLUGIN_NAME}] {message}"), data);
}

/// Error-level log — ALWAYS emitted (no gate).
pub fn log_error(message: &str, data: Option<&Value>) {
    log_to_console(LogLevel::Error, &format!("[{PLUGIN_NAME}] {message}"), data);
}

// ---------------------------------------------------------------------------
// Warn-once registry (process-global, keyed on the full message string)
// ---------------------------------------------------------------------------

static WARN_ONCE_REGISTRY: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

fn lock_warn_once() -> std::sync::MutexGuard<'static, HashSet<String>> {
    WARN_ONCE_REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Emit `log_warn(message)` at most once per unique FULL message string for
/// the lifetime of the process (spec 01 gotcha 7 — a repeat warning would
/// change observable CLI output). Returns whether the warning was emitted.
pub fn warn_once(message: &str) -> bool {
    let inserted = lock_warn_once().insert(message.to_string());
    if inserted {
        log_warn(message, None);
    }
    inserted
}

/// Clear the warn-once registry (test seam; the TS analogue is
/// `__resetConfigWarningCacheForTests`).
pub fn __reset_for_tests() {
    lock_warn_once().clear();
}

// ---------------------------------------------------------------------------
// Request file logging
// ---------------------------------------------------------------------------

const LOG_DIR_MAX_ATTEMPTS: u32 = 3;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

// Once the log dir is confirmed to exist we never need to stat/mkdir again for
// this process, so the hot logging path does no filesystem work after the
// first success.
static LOG_DIR_READY: AtomicBool = AtomicBool::new(false);

fn log_dir() -> &'static PathBuf {
    static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
    LOG_DIR.get_or_init(|| crate::runtime_paths::get_codex_log_dir().join("codex-plugin"))
}

fn create_log_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// Ensure the log directory exists (best-effort, synchronous, non-blocking).
///
/// Logging is fire-and-forget on a concurrent request path, so this must never
/// block: retry the mkdir up to 3 times IMMEDIATELY (no sleep) on transient
/// EBUSY/EPERM; a persistent failure skips this one log line rather than
/// stalling the proxy. Success is cached.
fn ensure_log_dir(path: &Path) -> bool {
    if LOG_DIR_READY.load(Ordering::Acquire) {
        return true;
    }
    let mut last_error: Option<std::io::Error> = None;
    for attempt in 0..LOG_DIR_MAX_ATTEMPTS {
        let result = if path.exists() {
            Ok(())
        } else {
            create_log_dir(path)
        };
        match result {
            Ok(()) => {
                LOG_DIR_READY.store(true, Ordering::Release);
                return true;
            }
            Err(error) => {
                let code = crate::fs_retry::code_of(&error).unwrap_or("");
                let retryable = code == "EBUSY" || code == "EPERM";
                last_error = Some(error);
                if retryable && attempt + 1 < LOG_DIR_MAX_ATTEMPTS {
                    // Immediate retry (no thread-blocking sleep). A transient
                    // lock is usually gone by the next attempt.
                    continue;
                }
                break;
            }
        }
    }
    log_to_console(
        LogLevel::Warn,
        &format!("[{PLUGIN_NAME}] Failed to ensure log directory"),
        Some(&serde_json::json!({
            "path": path.display().to_string(),
            "error": last_error
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
        })),
    );
    false
}

/// Body-suppression pass (gotcha 16): unless raw-body capture is enabled, keys
/// whose lowercase-de-`[-_]`d form equals `body` or `fullcontent` are removed
/// and `payloadsOmitted: true` is appended.
fn sanitize_request_log_data_with(
    data: &serde_json::Map<String, Value>,
    body_logging_enabled: bool,
) -> serde_json::Map<String, Value> {
    if body_logging_enabled {
        return data.clone();
    }

    let mut omitted_payloads = false;
    let mut sanitized = serde_json::Map::new();
    for (key, value) in data {
        let normalized_key = normalize_key(key);
        if normalized_key == "body" || normalized_key == "fullcontent" {
            omitted_payloads = true;
            continue;
        }
        sanitized.insert(key.clone(), value.clone());
    }
    if omitted_payloads {
        sanitized.insert("payloadsOmitted".to_string(), Value::Bool(true));
    }
    sanitized
}

/// Assemble the request-log JSON object in the exact TS key order:
/// `timestamp`, `requestId`, optional `correlationId`, `stage`, then the
/// sanitized data spread (existing keys keep their first position).
fn build_request_log_json(
    timestamp: &str,
    request_id: u64,
    correlation_id: Option<&str>,
    stage: &str,
    sanitized_data: serde_json::Map<String, Value>,
) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("timestamp".to_string(), Value::String(timestamp.to_string()));
    map.insert("requestId".to_string(), Value::from(request_id));
    if let Some(cid) = correlation_id.filter(|c| !c.is_empty()) {
        map.insert("correlationId".to_string(), Value::String(cid.to_string()));
    }
    map.insert("stage".to_string(), Value::String(stage.to_string()));
    for (key, value) in sanitized_data {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn write_request_log_file(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())
}

/// Write a per-request JSON log file `request-<n>-<stage>.json` (no-op unless
/// `ENABLE_PLUGIN_REQUEST_LOGGING=1`). Files are 0600 in a 0700 dir; pretty
/// 2-space JSON with NO trailing newline (spec 01 §4.6 / ARCH §8.1 matrix).
pub fn log_request(stage: &str, data: &serde_json::Map<String, Value>) {
    let env = logger_env();
    if !env.logging_enabled {
        return;
    }

    let dir = log_dir();
    if !ensure_log_dir(dir) {
        return;
    }

    let timestamp = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let request_id = REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let correlation_id = get_correlation_id();
    let filename = dir.join(format!("request-{request_id}-{stage}.json"));
    let request_data = sanitize_request_log_data_with(data, env.request_body_logging_enabled);
    let sanitized_data = match sanitize_value(&Value::Object(request_data)) {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };

    let payload = build_request_log_json(
        &timestamp,
        request_id,
        correlation_id.as_deref(),
        stage,
        sanitized_data,
    );
    let serialized = crate::json_io::stringify_pretty2(&payload);

    match write_request_log_file(&filename, &serialized) {
        Ok(()) => {
            log_to_console(
                LogLevel::Info,
                &format!("[{PLUGIN_NAME}] Logged {stage} to {}", filename.display()),
                None,
            );
        }
        Err(error) => {
            // If the log dir vanished after we cached it as ready, a write
            // fails with ENOENT and would stay broken until restart because
            // ensure_log_dir is a no-op once ready. Invalidate the cache on a
            // directory-missing failure so the next log_request re-creates it.
            if error.kind() == std::io::ErrorKind::NotFound {
                LOG_DIR_READY.store(false, Ordering::Release);
            }
            log_to_console(
                LogLevel::Error,
                &format!("[{PLUGIN_NAME}] Failed to write log: {error}"),
                None,
            );
        }
    }
}

/// Current request counter value (the id of the most recent request log).
pub fn get_request_id() -> u64 {
    REQUEST_COUNTER.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Scoped loggers + timers
// ---------------------------------------------------------------------------

const MAX_TIMERS: usize = 100;

/// Global timer registry: insertion-ordered, capped at [`MAX_TIMERS`] entries
/// (oldest insertion evicted when full), mirroring the TS `Map` semantics.
static TIMERS: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

fn lock_timers() -> std::sync::MutexGuard<'static, Vec<(String, Instant)>> {
    TIMERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn timers_set(key: String, start: Instant) {
    let mut timers = lock_timers();
    // TS evicts BEFORE the set, even when the set would only overwrite.
    if timers.len() >= MAX_TIMERS {
        timers.remove(0);
    }
    if let Some(entry) = timers.iter_mut().find(|(k, _)| *k == key) {
        entry.1 = start;
    } else {
        timers.push((key, start));
    }
}

fn timers_delete(key: &str) {
    let mut timers = lock_timers();
    if let Some(index) = timers.iter().position(|(k, _)| k == key) {
        timers.remove(index);
    }
}

/// A running timer returned by [`ScopedLogger::time`]; call [`Self::end`] to
/// stop it, log at debug level, and get the elapsed milliseconds (the TS
/// analogue is the returned closure).
#[derive(Debug)]
pub struct ScopedTimer {
    key: String,
    prefix: String,
    label: String,
    start: Instant,
}

impl ScopedTimer {
    /// Stop the timer: removes it from the registry, logs
    /// `"<label>: <formatted duration>"` at debug level, and returns the
    /// duration in milliseconds.
    pub fn end(self) -> f64 {
        let duration = self.start.elapsed().as_secs_f64() * 1000.0;
        timers_delete(&self.key);
        if should_log(LogLevel::Debug) {
            let text = format!("{} {}: {}", self.prefix, self.label, format_duration(duration));
            log_to_console(LogLevel::Debug, &text, None);
        }
        duration
    }
}

/// Logger bound to a scope: prefix `[codex-multi-auth:<scope>]`.
#[derive(Debug, Clone)]
pub struct ScopedLogger {
    scope: String,
    prefix: String,
}

/// Create a scoped logger (TS `createLogger(scope)`).
pub fn create_logger(scope: &str) -> ScopedLogger {
    ScopedLogger {
        scope: scope.to_string(),
        prefix: format!("[{PLUGIN_NAME}:{scope}]"),
    }
}

impl ScopedLogger {
    pub fn debug(&self, message: &str, data: Option<&Value>) {
        if !should_log(LogLevel::Debug) {
            return;
        }
        log_to_console(LogLevel::Debug, &format!("{} {message}", self.prefix), data);
    }

    pub fn info(&self, message: &str, data: Option<&Value>) {
        if !should_log(LogLevel::Info) {
            return;
        }
        log_to_console(LogLevel::Info, &format!("{} {message}", self.prefix), data);
    }

    pub fn warn(&self, message: &str, data: Option<&Value>) {
        if !should_log(LogLevel::Warn) {
            return;
        }
        log_to_console(LogLevel::Warn, &format!("{} {message}", self.prefix), data);
    }

    /// Error-level — always emitted.
    pub fn error(&self, message: &str, data: Option<&Value>) {
        log_to_console(LogLevel::Error, &format!("{} {message}", self.prefix), data);
    }

    /// Start a timer keyed `<scope>:<label>` in the global registry (capped at
    /// 100 entries, oldest insertion evicted).
    pub fn time(&self, label: &str) -> ScopedTimer {
        let key = format!("{}:{label}", self.scope);
        let start = Instant::now();
        timers_set(key.clone(), start);
        ScopedTimer {
            key,
            prefix: self.prefix.clone(),
            label: label.to_string(),
            start,
        }
    }

    /// Log a duration measured externally (no registry interaction).
    pub fn time_end(&self, label: &str, start_time: Instant) {
        let duration = start_time.elapsed().as_secs_f64() * 1000.0;
        if should_log(LogLevel::Debug) {
            let text = format!("{} {label}: {}", self.prefix, format_duration(duration));
            log_to_console(LogLevel::Debug, &text, None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serial_test::serial;

    // === mask_token ===

    #[test]
    fn mask_token_fully_masks_short_tokens() {
        assert_eq!(mask_token("short"), "***MASKED***");
        assert_eq!(mask_token("12chars_here"), "***MASKED***");
        assert_eq!(mask_token("exactly12chr"), "***MASKED***");
        assert_eq!(mask_token(""), "***MASKED***");
    }

    #[test]
    fn mask_token_partially_masks_long_tokens() {
        assert_eq!(mask_token("this-is-a-longer-token-value"), "this-i...alue");
    }

    // === mask_email (ported from test/logger.test.ts) ===

    #[test]
    fn mask_email_masks_a_standard_email_address() {
        assert_eq!(mask_email("john.doe@example.com"), "jo***@***.com");
    }

    #[test]
    fn mask_email_masks_a_short_local_part() {
        assert_eq!(mask_email("a@example.org"), "a***@***.org");
    }

    #[test]
    fn mask_email_handles_subdomain_emails() {
        assert_eq!(mask_email("user@mail.company.co.uk"), "us***@***.uk");
    }

    #[test]
    fn mask_email_handles_invalid_emails_gracefully() {
        assert_eq!(mask_email("not-an-email"), "***@***");
    }

    #[test]
    fn mask_email_preserves_tld() {
        assert_eq!(mask_email("test@domain.io"), "te***@***.io");
    }

    // === mask_string ===

    #[test]
    fn mask_string_masks_emails_before_token_patterns() {
        // The hex/token regexes must not eat email fragments: the email is
        // masked first and its remnants no longer match token shapes.
        let masked = mask_string("contact deadbeefcafe1234@example.com now");
        assert!(masked.contains("de***@***.com"), "got: {masked}");
        assert!(!masked.contains("example.com"));
    }

    #[test]
    fn mask_string_masks_jwts_hex_sk_and_bearer_tokens() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
        let masked = mask_string(&format!("token {jwt} end"));
        assert!(!masked.contains(jwt));

        let hex = "a".repeat(40);
        assert!(!mask_string(&format!("hash {hex} end")).contains(&hex));

        let sk = format!("sk-{}", "A1b2C3d4E5f6G7h8I9j0K");
        assert!(!mask_string(&format!("key {sk} end")).contains(&sk));

        let masked = mask_string("Authorization: Bearer super-secret-token-value");
        assert!(!masked.contains("super-secret-token-value"));
    }

    #[test]
    fn mask_string_masks_cma_local_bearer_tokens_in_free_text() {
        let token = format!("cma_local_{}", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
        let masked = mask_string(&format!("authorization failed for {token} end"));
        assert!(!masked.contains(&token));
    }

    // === sanitize_value ===

    #[test]
    fn sanitize_value_masks_sensitive_keys_with_non_string_values() {
        let sanitized = sanitize_value(&json!({
            "access_token": 12345,
            "password": { "nested": true },
            "apiKey": ["array", "value"],
        }));
        assert_eq!(sanitized["access_token"], json!("***MASKED***"));
        assert_eq!(sanitized["password"], json!("***MASKED***"));
        assert_eq!(sanitized["apiKey"], json!("***MASKED***"));
    }

    #[test]
    fn sanitize_value_masks_short_string_tokens_fully() {
        let sanitized = sanitize_value(&json!({
            "access_token": "short",
            "password": "12chars_here",
            "apiKey": "exactly12chr",
        }));
        assert_eq!(sanitized["access_token"], json!("***MASKED***"));
        assert_eq!(sanitized["password"], json!("***MASKED***"));
        assert_eq!(sanitized["apiKey"], json!("***MASKED***"));
    }

    #[test]
    fn sanitize_value_partially_masks_long_string_tokens() {
        let sanitized = sanitize_value(&json!({
            "access_token": "this-is-a-longer-token-value",
        }));
        assert_eq!(sanitized["access_token"], json!("this-i...alue"));
    }

    #[test]
    fn sanitize_value_masks_experimental_bearer_token_key_variants() {
        let sanitized = sanitize_value(&json!({
            "experimental_bearer_token": "runtime-router-secret-value",
            "experimentalBearerToken": "runtime-router-secret-value",
            "experimental-bearer-token": "runtime-router-secret-value",
        }));
        assert_eq!(sanitized["experimental_bearer_token"], json!("runtim...alue"));
        assert_eq!(sanitized["experimentalBearerToken"], json!("runtim...alue"));
        assert_eq!(sanitized["experimental-bearer-token"], json!("runtim...alue"));
    }

    #[test]
    fn sanitize_value_masks_email_key_with_mask_email_not_mask_token() {
        // Regression: sanitizeValue used maskToken for every sensitive key, so
        // an `email` field leaked the local part + TLD. It must use maskEmail.
        let sanitized = sanitize_value(&json!({ "email": "alice@example.com" }));
        assert_eq!(sanitized["email"], json!("al***@***.com"));
        let rendered = sanitized["email"].as_str().unwrap();
        assert!(!rendered.contains("alice"));
        assert!(!rendered.contains("example"));
    }

    #[test]
    fn sanitize_value_masks_non_string_email_key_without_leaking() {
        let sanitized = sanitize_value(&json!({ "email": { "nested": "alice@example.com" } }));
        assert_eq!(sanitized["email"], json!("***MASKED***"));
    }

    #[test]
    fn sanitize_value_returns_max_depth_beyond_depth_10() {
        let mut obj = json!({ "value": "test" });
        for _ in 0..15 {
            obj = json!({ "nested": obj });
        }
        let sanitized = sanitize_value(&obj);
        let rendered = serde_json::to_string(&sanitized).unwrap();
        assert!(rendered.contains("[max depth]"));
    }

    #[test]
    fn sanitize_value_handles_arrays_nulls_and_primitives() {
        let sanitized = sanitize_value(&json!({
            "items": ["normal", "user@example.com", "other"],
            "nullValue": null,
            "count": 42,
        }));
        assert_eq!(sanitized["items"][0], json!("normal"));
        assert!(sanitized["items"][1].as_str().unwrap().contains("***@***"));
        assert_eq!(sanitized["items"][2], json!("other"));
        assert_eq!(sanitized["nullValue"], Value::Null);
        assert_eq!(sanitized["count"], json!(42));
        // Non-object roots pass through the string/primitive branches.
        assert_eq!(sanitize_value(&json!(42)), json!(42));
        assert_eq!(sanitize_value(&Value::Null), Value::Null);
    }

    #[test]
    fn sanitize_value_masks_nested_sensitive_keys() {
        let sanitized = sanitize_value(&json!({
            "auth": {
                "access": "secret-token-that-is-long",
                "nested": { "refresh": "another-secret-value-long" },
            },
        }));
        assert_eq!(sanitized["auth"]["access"], json!("secret...long"));
        assert_eq!(sanitized["auth"]["nested"]["refresh"], json!("anothe...long"));
    }

    // === format_duration ===

    #[test]
    fn format_duration_cases() {
        assert_eq!(format_duration(500.0), "500ms");
        assert_eq!(format_duration(2500.0), "2.50s");
        assert_eq!(format_duration(90000.0), "1m 30.0s");
        assert_eq!(format_duration(123.456), "123ms");
        assert_eq!(format_duration(0.0), "0ms");
    }

    // === parse_log_level ===

    #[test]
    fn parse_log_level_accepts_the_four_levels_and_defaults_to_info() {
        assert_eq!(parse_log_level(Some("debug")), LogLevel::Debug);
        assert_eq!(parse_log_level(Some("INFO")), LogLevel::Info);
        assert_eq!(parse_log_level(Some(" warn ")), LogLevel::Warn);
        assert_eq!(parse_log_level(Some("error")), LogLevel::Error);
        assert_eq!(parse_log_level(Some("bogus")), LogLevel::Info);
        assert_eq!(parse_log_level(Some("")), LogLevel::Info);
        assert_eq!(parse_log_level(None), LogLevel::Info);
    }

    // === request-log data shaping ===

    #[test]
    fn request_log_body_suppression_normalizes_keys() {
        let mut data = serde_json::Map::new();
        data.insert("Body".to_string(), json!("payload"));
        data.insert("full_content".to_string(), json!("payload"));
        data.insert("full-content".to_string(), json!("payload"));
        data.insert("note".to_string(), json!("keep"));

        let suppressed = sanitize_request_log_data_with(&data, false);
        assert!(!suppressed.contains_key("Body"));
        assert!(!suppressed.contains_key("full_content"));
        assert!(!suppressed.contains_key("full-content"));
        assert_eq!(suppressed["note"], json!("keep"));
        assert_eq!(suppressed["payloadsOmitted"], json!(true));

        let kept = sanitize_request_log_data_with(&data, true);
        assert_eq!(kept["Body"], json!("payload"));
        assert!(!kept.contains_key("payloadsOmitted"));
    }

    #[test]
    fn request_log_body_suppression_skips_marker_when_nothing_omitted() {
        let mut data = serde_json::Map::new();
        data.insert("note".to_string(), json!("keep"));
        let suppressed = sanitize_request_log_data_with(&data, false);
        assert!(!suppressed.contains_key("payloadsOmitted"));
    }

    #[test]
    fn request_log_json_uses_exact_key_order() {
        let mut sanitized = serde_json::Map::new();
        sanitized.insert("note".to_string(), json!("keep"));
        let payload = build_request_log_json(
            "2026-07-26T00:00:00.000Z",
            7,
            Some("cid-1"),
            "response",
            sanitized,
        );
        let keys: Vec<&String> = payload.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["timestamp", "requestId", "correlationId", "stage", "note"]);
        assert_eq!(payload["requestId"], json!(7));
    }

    #[test]
    fn request_log_json_omits_empty_or_absent_correlation_id() {
        let payload =
            build_request_log_json("t", 1, None, "response", serde_json::Map::new());
        assert!(!payload.as_object().unwrap().contains_key("correlationId"));
        let payload =
            build_request_log_json("t", 1, Some(""), "response", serde_json::Map::new());
        assert!(!payload.as_object().unwrap().contains_key("correlationId"));
    }

    // === log fns / logRequest smoke (disabled env => no-ops, must not panic) ===

    #[test]
    fn log_functions_do_not_panic() {
        log_debug("debug message", None);
        log_info("info message", Some(&json!({ "k": "v" })));
        log_warn("warn message", None);
        log_error("error message", Some(&json!({ "token": "secret" })));
        let mut data = serde_json::Map::new();
        data.insert("k".to_string(), json!("v"));
        log_request("test-stage", &data);
        let _ = get_request_id();
        init_logger();
    }

    // === correlation ids ===

    #[test]
    #[serial]
    fn fallback_correlation_id_set_get_clear() {
        clear_correlation_id();
        assert_eq!(get_correlation_id(), None);

        let generated = set_correlation_id(None);
        assert_eq!(generated.len(), 36); // UUID v4 hyphenated
        assert_eq!(get_correlation_id(), Some(generated.clone()));

        let explicit = set_correlation_id(Some("custom-id-123".to_string()));
        assert_eq!(explicit, "custom-id-123");
        assert_eq!(get_correlation_id(), Some("custom-id-123".to_string()));

        clear_correlation_id();
        assert_eq!(get_correlation_id(), None);
    }

    #[tokio::test]
    #[serial]
    async fn isolates_correlation_ids_across_concurrent_scopes() {
        clear_correlation_id();
        let (a, b) = tokio::join!(
            run_with_correlation_id(Some("id-a".to_string()), async {
                tokio::task::yield_now().await;
                get_correlation_id()
            }),
            run_with_correlation_id(Some("id-b".to_string()), async { get_correlation_id() }),
        );
        assert_eq!(a, Some("id-a".to_string()));
        assert_eq!(b, Some("id-b".to_string()));
        // Scopes never touched the fallback.
        assert_eq!(get_correlation_id(), None);
    }

    #[tokio::test]
    #[serial]
    async fn set_correlation_id_inside_a_scope_updates_only_that_scope() {
        clear_correlation_id();
        let inside = run_with_correlation_id(Some("original".to_string()), async {
            set_correlation_id(Some("updated".to_string()));
            get_correlation_id()
        })
        .await;
        assert_eq!(inside, Some("updated".to_string()));
        assert_eq!(get_correlation_id(), None);
    }

    #[tokio::test]
    #[serial]
    async fn cleared_scope_wins_over_fallback() {
        clear_correlation_id();
        set_correlation_id(Some("fallback-id".to_string()));
        let inside = run_with_correlation_id(Some("scoped".to_string()), async {
            clear_correlation_id();
            // The cleared scope must win: never leak the fallback here.
            get_correlation_id()
        })
        .await;
        assert_eq!(inside, None);
        assert_eq!(get_correlation_id(), Some("fallback-id".to_string()));
        clear_correlation_id();
    }

    #[test]
    #[serial]
    fn run_with_correlation_id_sync_scopes_the_id() {
        clear_correlation_id();
        let inside = run_with_correlation_id_sync(None, get_correlation_id);
        assert!(inside.is_some());
        assert_eq!(inside.unwrap().len(), 36);
        assert_eq!(get_correlation_id(), None);
    }

    // === warn-once ===

    #[test]
    #[serial]
    fn warn_once_dedupes_on_the_full_message_string() {
        __reset_for_tests();
        assert!(warn_once("warn-once test message"));
        assert!(!warn_once("warn-once test message"));
        assert!(warn_once("warn-once test message 2"));
        __reset_for_tests();
        assert!(warn_once("warn-once test message"));
        __reset_for_tests();
    }

    // === scoped logger + timers ===

    #[test]
    fn scoped_logger_logs_and_times_without_panicking() {
        let logger = create_logger("test-scope");
        logger.debug("debug", None);
        logger.info("info", Some(&json!({ "k": "v" })));
        logger.warn("warn", None);
        logger.error("error", None);

        let timer = logger.time("op");
        let duration = timer.end();
        assert!(duration >= 0.0);

        logger.time_end("external", Instant::now());
    }

    #[test]
    fn timer_registry_caps_at_100_entries_without_panicking() {
        let logger = create_logger("cap-test");
        let mut timers = Vec::new();
        for i in 0..150 {
            timers.push(logger.time(&format!("label-{i}")));
        }
        assert!(lock_timers().len() <= MAX_TIMERS);
        for timer in timers {
            let _ = timer.end();
        }
    }

    #[test]
    fn timer_overwrite_keeps_single_entry_per_key() {
        let logger = create_logger("overwrite-test");
        let t1 = logger.time("same");
        let t2 = logger.time("same");
        let count = lock_timers()
            .iter()
            .filter(|(k, _)| k == "overwrite-test:same")
            .count();
        assert_eq!(count, 1);
        let _ = t2.end();
        let _ = t1.end();
    }
}
