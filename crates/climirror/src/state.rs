//! Port of `lib/codex-cli/state.ts` — tolerant reader for the official Codex
//! CLI's `accounts.json` / `auth.json` with a 5 s TTL cache.
//!
//! Behavior source: specs/11-cli-usage-recovery.md §1.2 (+ gotchas 1, 9, 10,
//! 38); TS source is authoritative.
//!
//! Contracts:
//! - Tolerant DUAL snake_case/camelCase parsing at every level; token search is
//!   top-level first, then nested `auth.tokens`, with the key priority order
//!   flipping between the two levels.
//! - JWT `exp` fallback (seconds → ms) when no finite non-zero `expiresAt` is
//!   found (`Number("") === 0` is falsy and triggers the fallback — gotcha 38).
//! - 5 s TTL cache with monotonic load generations: only the LATEST load may
//!   commit `cache`/`cache_loaded_at`; forced refreshes never coalesce, while
//!   non-forced callers coalesce onto any in-flight load.
//! - Sync default is ON; only literal `"0"`/`"1"` are recognized; the legacy
//!   env var warns once per process and bumps `legacySyncEnvUses`.
//!
//! Task-local caveat (ARCHITECTURE §5.4): cache state is process-global; none
//! of it crosses `tokio::spawn` implicitly.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value, json};
use tokio::sync::watch;

use cma_core::fs_retry::{Backoff, RetryOptions, with_retry};
use cma_core::json_io::{file_mtime_ms, read_text_file};
use cma_core::jwt::decode_jwt_value;
use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::runtime_paths::get_codex_home_dir;
use cma_core::token_utils::{extract_account_email, extract_account_id};
use cma_core::utils::now_ms;

use crate::observability::{
    CodexCliMetricKey, increment_codex_cli_metric, make_account_fingerprint,
};

const CACHE_TTL_MS: i64 = 5_000;
const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];
const FS_RETRY_ATTEMPTS: u32 = 4;

fn state_log() -> ScopedLogger {
    create_logger("codex-cli-state")
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Token snapshot for one CLI account (TS `CodexCliTokenCacheEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct CodexCliTokenCacheEntry {
    /// May be `""` when only a refresh token was present.
    pub access_token: String,
    pub expires_at: Option<f64>,
    pub refresh_token: Option<String>,
    pub account_id: Option<String>,
}

/// One parsed CLI account entry (TS `CodexCliAccountSnapshot`).
#[derive(Debug, Clone, PartialEq)]
pub struct CodexCliAccountSnapshot {
    /// Trimmed and lowercased.
    pub email: Option<String>,
    pub account_id: Option<String>,
    /// May be `""` when only a refresh token was present.
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<f64>,
    pub is_active: Option<bool>,
}

/// Parsed Codex CLI state (TS `CodexCliState`).
#[derive(Debug, Clone, PartialEq)]
pub struct CodexCliState {
    pub path: PathBuf,
    pub accounts: Vec<CodexCliAccountSnapshot>,
    pub active_account_id: Option<String>,
    pub active_email: Option<String>,
    pub sync_version: Option<f64>,
    pub source_updated_at_ms: Option<f64>,
}

// ---------------------------------------------------------------------------
// Module cache state
// ---------------------------------------------------------------------------

type LoadResult = Option<CodexCliState>;
/// `None` = load still pending; `Some(result)` = load settled.
type LoadSlot = Option<LoadResult>;

struct CacheState {
    cache: Option<CodexCliState>,
    cache_loaded_at: i64,
    /// Monotonic load generation. forceRefresh lets loads overlap, so a slower
    /// stale (earlier) read must not overwrite the shared cache committed by a
    /// newer one (TS comment preserved verbatim in spirit).
    latest_load_generation: u64,
    in_flight: Option<watch::Receiver<LoadSlot>>,
}

static CACHE: LazyLock<Mutex<CacheState>> = LazyLock::new(|| {
    Mutex::new(CacheState {
        cache: None,
        cache_loaded_at: 0,
        latest_load_generation: 0,
        in_flight: None,
    })
});

static LEGACY_SYNC_WARNED: AtomicBool = AtomicBool::new(false);

fn lock_cache() -> std::sync::MutexGuard<'static, CacheState> {
    CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Env helpers / path getters
// ---------------------------------------------------------------------------

fn env_string(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// Whether Codex CLI mirroring is enabled (TS `isCodexCliSyncEnabled`).
///
/// `CODEX_MULTI_AUTH_SYNC_CODEX_CLI` (trimmed): `"0"` → false, `"1"` → true.
/// Otherwise legacy `CODEX_AUTH_SYNC_CODEX_CLI` (trimmed): a non-empty value
/// warns once per process and increments `legacySyncEnvUses`; `"0"` → false,
/// `"1"` → true. **Default (both unset/other values): true** — any other value
/// (e.g. `"true"`) falls through to the default.
pub fn is_codex_cli_sync_enabled() -> bool {
    let override_value = env_string("CODEX_MULTI_AUTH_SYNC_CODEX_CLI");
    let override_value = override_value.trim();
    if override_value == "0" {
        return false;
    }
    if override_value == "1" {
        return true;
    }

    let legacy = env_string("CODEX_AUTH_SYNC_CODEX_CLI");
    let legacy = legacy.trim();
    if !legacy.is_empty() && !LEGACY_SYNC_WARNED.swap(true, Ordering::SeqCst) {
        increment_codex_cli_metric(CodexCliMetricKey::LegacySyncEnvUses);
        state_log().warn(
            "Using legacy CODEX_AUTH_SYNC_CODEX_CLI. Prefer CODEX_MULTI_AUTH_SYNC_CODEX_CLI.",
            None,
        );
    }
    if legacy == "0" {
        return false;
    }
    if legacy == "1" {
        return true;
    }
    true
}

fn env_path_override(name: &str) -> Option<PathBuf> {
    let value = env_string(name);
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// `$CODEX_CLI_ACCOUNTS_PATH` (trimmed, non-empty) else
/// `<codexHome>/accounts.json` (TS `getCodexCliAccountsPath`).
pub fn get_codex_cli_accounts_path() -> PathBuf {
    env_path_override("CODEX_CLI_ACCOUNTS_PATH")
        .unwrap_or_else(|| get_codex_home_dir().join("accounts.json"))
}

/// `$CODEX_CLI_AUTH_PATH` else `<codexHome>/auth.json` (TS `getCodexCliAuthPath`).
pub fn get_codex_cli_auth_path() -> PathBuf {
    env_path_override("CODEX_CLI_AUTH_PATH")
        .unwrap_or_else(|| get_codex_home_dir().join("auth.json"))
}

/// `$CODEX_CLI_CONFIG_PATH` else `<codexHome>/config.toml`
/// (TS `getCodexCliConfigPath`).
pub fn get_codex_cli_config_path() -> PathBuf {
    env_path_override("CODEX_CLI_CONFIG_PATH")
        .unwrap_or_else(|| get_codex_home_dir().join("config.toml"))
}

// ---------------------------------------------------------------------------
// Tolerant value readers (shared parse vocabulary — see also writer.rs, which
// deliberately duplicates them the way writer.ts duplicated state.ts's)
// ---------------------------------------------------------------------------

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_email_value(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value).map(|email| email.to_lowercase())
}

fn normalize_email_str(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_lowercase())
    }
}

fn read_boolean(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => {
            let lc = s.trim().to_lowercase();
            match lc.as_str() {
                "true" | "1" => Some(true),
                "false" | "0" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

/// JS `Number(string)` coercion for the subset of inputs this module sees.
/// Notably `Number("") === 0` (gotcha 38) and whitespace is trimmed first.
/// `pub(crate)` because writer.rs mirrors writer.ts's duplicated `readNumber`.
pub(crate) fn js_number_from_str(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return u128::from_str_radix(hex, 16).ok().map(|v| v as f64);
    }
    if let Some(oct) = trimmed.strip_prefix("0o").or_else(|| trimmed.strip_prefix("0O")) {
        return u128::from_str_radix(oct, 8).ok().map(|v| v as f64);
    }
    if let Some(bin) = trimmed.strip_prefix("0b").or_else(|| trimmed.strip_prefix("0B")) {
        return u128::from_str_radix(bin, 2).ok().map(|v| v as f64);
    }
    match trimmed {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    // Reject Rust-only spellings ("inf", "nan", "1_000"): JS Number() accepts
    // only decimal/exponent syntax beyond the special cases above.
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
    {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

/// TS `readNumber`: finite numbers pass through; strings go through JS
/// `Number()` coercion and must be finite.
fn read_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) => js_number_from_str(s).filter(|v| v.is_finite()),
        _ => None,
    }
}

fn extract_token_from_record(record: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(token) = read_trimmed_string(record.get(*key)) {
            return Some(token);
        }
    }
    None
}

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn extract_account_snapshot(raw: &Value) -> Option<CodexCliAccountSnapshot> {
    let record = raw.as_object()?;

    let auth = as_object(record.get("auth"));
    let tokens = auth.and_then(|auth| as_object(auth.get("tokens")));

    let access_token = extract_token_from_record(record, &["accessToken", "access_token"])
        .or_else(|| {
            tokens.and_then(|tokens| {
                extract_token_from_record(tokens, &["access_token", "accessToken"])
            })
        });
    let refresh_token = extract_token_from_record(record, &["refreshToken", "refresh_token"])
        .or_else(|| {
            tokens.and_then(|tokens| {
                extract_token_from_record(tokens, &["refresh_token", "refreshToken"])
            })
        });

    let account_id = read_trimmed_string(record.get("accountId"))
        .or_else(|| read_trimmed_string(record.get("account_id")))
        .or_else(|| read_trimmed_string(record.get("workspace_id")))
        .or_else(|| read_trimmed_string(record.get("organization_id")))
        .or_else(|| read_trimmed_string(record.get("id")));
    let email = normalize_email_value(record.get("email"))
        .or_else(|| normalize_email_value(record.get("user_email")))
        .or_else(|| normalize_email_value(record.get("username")));
    let expires_at_raw = read_number(record.get("expiresAt"))
        .or_else(|| read_number(record.get("expires_at")))
        .or_else(|| tokens.and_then(|tokens| read_number(tokens.get("expires_at"))));

    let mut expires_at = expires_at_raw;
    // JS falsy check: undefined OR 0 both trigger the JWT-exp fallback.
    let expires_at_falsy = expires_at.is_none_or(|v| v == 0.0);
    if expires_at_falsy
        && let Some(token) = &access_token
        && let Some(decoded) = decode_jwt_value(token)
        && let Some(exp) = decoded.get("exp").and_then(Value::as_f64)
        && exp.is_finite()
    {
        expires_at = Some(exp * 1000.0);
    }

    let is_active = read_boolean(record.get("active"))
        .or_else(|| read_boolean(record.get("isActive")))
        .or_else(|| read_boolean(record.get("is_active")));

    if access_token.is_none() && refresh_token.is_none() {
        return None;
    }

    Some(CodexCliAccountSnapshot {
        email,
        account_id,
        access_token: access_token.unwrap_or_default(),
        refresh_token,
        expires_at,
        is_active,
    })
}

fn parse_codex_cli_state(
    path: &Path,
    parsed: &Value,
    source_updated_at_ms: Option<f64>,
) -> Option<CodexCliState> {
    let record = parsed.as_object()?;
    let raw_accounts = record.get("accounts")?.as_array()?;

    let accounts: Vec<CodexCliAccountSnapshot> = raw_accounts
        .iter()
        .filter_map(extract_account_snapshot)
        .collect();

    let mut active_account_id = read_trimmed_string(record.get("activeAccountId"))
        .or_else(|| read_trimmed_string(record.get("active_account_id")));
    let mut active_email = normalize_email_value(record.get("activeEmail"))
        .or_else(|| normalize_email_value(record.get("active_email")));

    if active_account_id.is_none()
        && active_email.is_none()
        && let Some(active_from_list) = accounts.iter().find(|a| a.is_active == Some(true))
    {
        active_account_id = active_from_list.account_id.clone();
        active_email = active_from_list.email.clone();
    }

    Some(CodexCliState {
        path: path.to_path_buf(),
        accounts,
        active_account_id,
        active_email,
        sync_version: read_number(record.get("codexMultiAuthSyncVersion")),
        source_updated_at_ms,
    })
}

fn parse_codex_cli_auth_state(
    path: &Path,
    parsed: &Value,
    source_updated_at_ms: Option<f64>,
) -> Option<CodexCliState> {
    let record = parsed.as_object()?;
    let tokens = as_object(record.get("tokens"))?;

    let access_token = extract_token_from_record(tokens, &["access_token", "accessToken"]);
    let refresh_token = extract_token_from_record(tokens, &["refresh_token", "refreshToken"]);
    if access_token.is_none() && refresh_token.is_none() {
        return None;
    }

    let id_token = extract_token_from_record(tokens, &["id_token", "idToken"]);
    let account_id = read_trimmed_string(tokens.get("account_id"))
        .or_else(|| read_trimmed_string(tokens.get("accountId")))
        .or_else(|| extract_account_id(access_token.as_deref()));
    let email = extract_account_email(access_token.as_deref(), id_token.as_deref())
        .or_else(|| normalize_email_value(record.get("email")));

    let mut expires_at: Option<f64> = None;
    if let Some(token) = &access_token
        && let Some(decoded) = decode_jwt_value(token)
        && let Some(exp) = decoded.get("exp").and_then(Value::as_f64)
        && exp.is_finite()
    {
        expires_at = Some(exp * 1000.0);
    }

    let snapshot = CodexCliAccountSnapshot {
        email: email.clone(),
        account_id: account_id.clone(),
        access_token: access_token.unwrap_or_default(),
        refresh_token,
        expires_at,
        is_active: Some(true),
    };

    Some(CodexCliState {
        path: path.to_path_buf(),
        accounts: vec![snapshot],
        active_account_id: account_id,
        active_email: email,
        sync_version: read_number(record.get("codexMultiAuthSyncVersion")),
        source_updated_at_ms,
    })
}

// ---------------------------------------------------------------------------
// FS retry (TS `retryFsOperation`: 4 attempts, 10·2^n ms, {EBUSY, EPERM})
// ---------------------------------------------------------------------------

fn fs_retry_options() -> RetryOptions<std::io::Error> {
    RetryOptions::new(
        FS_RETRY_ATTEMPTS,
        // TS sleeps `10 * 2 ** attempt` after 0-based failed attempt n:
        // 10/20/40 ms before attempts 2/3/4 (1-based failed-attempt index here).
        Backoff::from_fn(|failed_attempt| {
            10u64.saturating_mul(2u64.saturating_pow(failed_attempt.saturating_sub(1)))
        }),
    )
    .with_codes(RETRYABLE_FS_CODES)
}

async fn read_file_with_retry(path: &Path) -> std::io::Result<String> {
    with_retry(
        || {
            let path = path.to_path_buf();
            async move { read_text_file(&path) }
        },
        fs_retry_options(),
    )
    .await
}

async fn stat_mtime_with_retry(path: &Path) -> Option<f64> {
    with_retry(
        || {
            let path = path.to_path_buf();
            async move { file_mtime_ms(&path) }
        },
        fs_retry_options(),
    )
    .await
    .ok()
    .flatten()
}

// ---------------------------------------------------------------------------
// Cache commit helpers
// ---------------------------------------------------------------------------

fn commit_cache(generation: u64, value: LoadResult) {
    let mut state = lock_cache();
    if generation == state.latest_load_generation {
        state.cache = value;
    }
}

fn finalize_load(generation: u64) {
    // Only the latest load advances the shared cache timestamp, mirroring
    // commit_cache, so a slow stale read can't reset the TTL window.
    let mut state = lock_cache();
    if generation == state.latest_load_generation {
        state.cache_loaded_at = now_ms();
    }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async fn read_task_inner(generation: u64) -> LoadResult {
    let log = state_log();
    let accounts_path = get_codex_cli_accounts_path();
    let auth_path = get_codex_cli_auth_path();
    increment_codex_cli_metric(CodexCliMetricKey::ReadAttempts);

    let has_accounts_path = accounts_path.exists();
    let has_auth_path = auth_path.exists();
    if !has_accounts_path && !has_auth_path {
        increment_codex_cli_metric(CodexCliMetricKey::ReadMisses);
        commit_cache(generation, None);
        return None;
    }

    if has_accounts_path {
        let attempt: Result<Value, String> = match read_file_with_retry(&accounts_path).await {
            Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match attempt {
            Ok(parsed) => {
                let source_updated_at_ms = stat_mtime_with_retry(&accounts_path).await;
                if let Some(state) =
                    parse_codex_cli_state(&accounts_path, &parsed, source_updated_at_ms)
                {
                    increment_codex_cli_metric(CodexCliMetricKey::ReadSuccesses);
                    log.debug(
                        "Loaded Codex CLI state",
                        Some(&json!({
                            "operation": "read-state",
                            "outcome": "success",
                            "path": accounts_path.display().to_string(),
                            "accountCount": state.accounts.len(),
                            "activeAccountRef": make_account_fingerprint(
                                state.active_account_id.as_deref(),
                                state.active_email.as_deref(),
                            ),
                        })),
                    );
                    commit_cache(generation, Some(state.clone()));
                    return Some(state);
                }
                log.warn(
                    "Codex CLI accounts payload is malformed",
                    Some(&json!({
                        "operation": "read-state",
                        "outcome": "malformed",
                        "path": accounts_path.display().to_string(),
                    })),
                );
            }
            Err(error) => {
                log.warn(
                    "Failed to read Codex CLI accounts state",
                    Some(&json!({
                        "operation": "read-state",
                        "outcome": "accounts-read-error",
                        "path": accounts_path.display().to_string(),
                        "error": error,
                    })),
                );
            }
        }
    }

    if has_auth_path {
        let attempt: Result<Value, String> = match read_file_with_retry(&auth_path).await {
            Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match attempt {
            Ok(parsed) => {
                let source_updated_at_ms = stat_mtime_with_retry(&auth_path).await;
                if let Some(state) =
                    parse_codex_cli_auth_state(&auth_path, &parsed, source_updated_at_ms)
                {
                    increment_codex_cli_metric(CodexCliMetricKey::ReadSuccesses);
                    log.debug(
                        "Loaded Codex CLI auth state",
                        Some(&json!({
                            "operation": "read-state",
                            "outcome": "success",
                            "path": auth_path.display().to_string(),
                            "accountCount": state.accounts.len(),
                            "activeAccountRef": make_account_fingerprint(
                                state.active_account_id.as_deref(),
                                state.active_email.as_deref(),
                            ),
                        })),
                    );
                    commit_cache(generation, Some(state.clone()));
                    return Some(state);
                }
                log.warn(
                    "Codex CLI auth payload is malformed",
                    Some(&json!({
                        "operation": "read-state",
                        "outcome": "malformed",
                        "path": auth_path.display().to_string(),
                    })),
                );
            }
            Err(error) => {
                log.warn(
                    "Failed to read Codex CLI auth state",
                    Some(&json!({
                        "operation": "read-state",
                        "outcome": "auth-read-error",
                        "path": auth_path.display().to_string(),
                        "error": error,
                    })),
                );
            }
        }
    }

    increment_codex_cli_metric(CodexCliMetricKey::ReadFailures);
    commit_cache(generation, None);
    None
}

async fn read_task(generation: u64) -> LoadResult {
    let result = read_task_inner(generation).await;
    finalize_load(generation);
    result
}

enum LoadPlan {
    /// TTL fast path served from the shared cache.
    Cached(CodexCliState),
    /// Coalesce onto an in-flight load (non-forced callers only).
    Wait(watch::Receiver<LoadSlot>),
    /// This caller performs its own read under the claimed generation.
    Load {
        generation: u64,
        tx: watch::Sender<LoadSlot>,
        rx: watch::Receiver<LoadSlot>,
    },
}

/// Load the Codex CLI state (TS `loadCodexCliState`).
///
/// Pass `force_refresh = true` to bypass the 5 s TTL cache **and** any
/// in-flight coalesced load — a forced caller must observe fresh disk state.
/// Returns `None` when sync is disabled, no valid payload exists, or a
/// read/parse error occurred.
pub async fn load_codex_cli_state(force_refresh: bool) -> Option<CodexCliState> {
    if !is_codex_cli_sync_enabled() {
        return None;
    }

    let now = now_ms();
    let plan = {
        let mut state = lock_cache();
        let mut plan: Option<LoadPlan> = None;
        if !force_refresh {
            if let Some(cache) = &state.cache
                && now - state.cache_loaded_at < CACHE_TTL_MS
            {
                plan = Some(LoadPlan::Cached(cache.clone()));
            }
            // A forceRefresh caller must not be satisfied by an in-flight load
            // that may have been started without forceRefresh; only non-forced
            // callers coalesce onto the in-flight load.
            if plan.is_none()
                && let Some(in_flight) = &state.in_flight
            {
                plan = Some(LoadPlan::Wait(in_flight.clone()));
            }
        }
        match plan {
            Some(plan) => plan,
            None => {
                // Claim a generation; only the latest load may commit the cache.
                state.latest_load_generation += 1;
                let generation = state.latest_load_generation;
                let (tx, rx) = watch::channel::<LoadSlot>(None);
                state.in_flight = Some(rx.clone());
                LoadPlan::Load { generation, tx, rx }
            }
        }
    };

    match plan {
        LoadPlan::Cached(cache) => Some(cache),
        LoadPlan::Wait(rx) => wait_for_settled_load(rx).await,
        LoadPlan::Load { generation, tx, rx } => {
            // Detach the read so it always runs to completion (TS promises
            // cannot be cancelled): if the initiating caller's future is
            // dropped mid-read, coalesced waiters still get a settled result
            // and the in-flight slot is still cleared.
            let task_rx = rx.clone();
            tokio::spawn(async move {
                let result = read_task(generation).await;
                let _ = tx.send(Some(result));
                // Clear the in-flight slot only if it is still OUR load
                // (a newer overlapping load may have replaced it).
                let mut state = lock_cache();
                if state
                    .in_flight
                    .as_ref()
                    .is_some_and(|in_flight| in_flight.same_channel(&task_rx))
                {
                    state.in_flight = None;
                }
            });
            wait_for_settled_load(rx).await
        }
    }
}

/// Await an in-flight load's settled result. If the loader vanished without
/// settling (panic — impossible in normal operation), drop the dead in-flight
/// slot so future callers start a fresh read instead of failing forever.
async fn wait_for_settled_load(mut rx: watch::Receiver<LoadSlot>) -> LoadResult {
    let settled = match rx.wait_for(|slot| slot.is_some()).await {
        Ok(slot) => Some(slot.clone().flatten()),
        Err(_) => None,
    };
    if let Some(result) = settled {
        return result;
    }
    let mut state = lock_cache();
    if state
        .in_flight
        .as_ref()
        .is_some_and(|in_flight| in_flight.same_channel(&rx))
    {
        state.in_flight = None;
    }
    None
}

/// Look up tokens for an email via the (cached) CLI state
/// (TS `lookupCodexCliTokensByEmail`). Requires a non-empty access token.
pub async fn lookup_codex_cli_tokens_by_email(
    email: Option<&str>,
) -> Option<CodexCliTokenCacheEntry> {
    let normalized = normalize_email_str(email)?;

    let state = load_codex_cli_state(false).await?;

    let account = state
        .accounts
        .iter()
        .find(|entry| normalize_email_str(entry.email.as_deref()) == Some(normalized.clone()))?;
    if account.access_token.is_empty() {
        return None;
    }

    Some(CodexCliTokenCacheEntry {
        access_token: account.access_token.clone(),
        expires_at: account.expires_at,
        refresh_token: account.refresh_token.clone(),
        account_id: account.account_id.clone(),
    })
}

/// Drop the TTL cache and any in-flight coalescing handle
/// (TS `clearCodexCliStateCache`).
pub fn clear_codex_cli_state_cache() {
    let mut state = lock_cache();
    state.cache = None;
    state.cache_loaded_at = 0;
    state.in_flight = None;
}

/// Clear the once-per-process legacy-env warning latch
/// (TS `__resetCodexCliWarningCacheForTests`).
pub fn __reset_codex_cli_warning_cache_for_tests() {
    LEGACY_SYNC_WARNED.store(false, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Tests (ported from test/codex-cli-state.test.ts)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::{get_codex_cli_metrics_snapshot, reset_codex_cli_metrics_for_tests};
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use std::fs;

    /// The JWT used by the TS suite: header `{"alg":"none"}`, payload
    /// `{"exp":4100000000,"https://api.openai.com/auth":{"chatgpt_account_id":"acc_auth"},"email":"auth@example.com"}`.
    const AUTH_JWT: &str = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NfYXV0aCJ9LCJlbWFpbCI6ImF1dGhAZXhhbXBsZS5jb20ifQ.";

    struct StateFixture {
        sandbox: EnvSandbox,
        accounts_path: PathBuf,
        auth_path: PathBuf,
    }

    impl StateFixture {
        fn new() -> Self {
            let mut sandbox = EnvSandbox::new();
            let accounts_path = sandbox.root().join("accounts.json");
            let auth_path = sandbox.root().join("auth.json");
            let config_path = sandbox.root().join("config.toml");
            sandbox.set_var("CODEX_CLI_ACCOUNTS_PATH", &accounts_path);
            sandbox.set_var("CODEX_CLI_AUTH_PATH", &auth_path);
            sandbox.set_var("CODEX_CLI_CONFIG_PATH", &config_path);
            sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
            sandbox.remove_var("CODEX_AUTH_SYNC_CODEX_CLI");
            clear_codex_cli_state_cache();
            __reset_codex_cli_warning_cache_for_tests();
            reset_codex_cli_metrics_for_tests();
            StateFixture {
                sandbox,
                accounts_path,
                auth_path,
            }
        }

        fn write_accounts(&self, value: &Value) {
            fs::write(
                &self.accounts_path,
                cma_core::json_io::stringify_pretty2(value),
            )
            .unwrap();
        }

        fn write_auth(&self, value: &Value) {
            fs::write(&self.auth_path, cma_core::json_io::stringify_pretty2(value)).unwrap();
        }
    }

    impl Drop for StateFixture {
        fn drop(&mut self) {
            clear_codex_cli_state_cache();
            __reset_codex_cli_warning_cache_for_tests();
            reset_codex_cli_metrics_for_tests();
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn loads_codex_cli_accounts_and_active_selection() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "codexMultiAuthSyncVersion": 123456,
            "activeAccountId": "acc_b",
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com",
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
                {"accountId": "acc_b", "email": "b@example.com",
                 "auth": {"tokens": {"access_token": "x.y.z", "refresh_token": "refresh-b"}},
                 "active": true},
            ],
        }));

        let state = load_codex_cli_state(true).await.expect("state");
        assert_eq!(state.active_account_id.as_deref(), Some("acc_b"));
        assert_eq!(state.accounts.len(), 2);
        assert_eq!(state.sync_version, Some(123456.0));
        assert!(state.source_updated_at_ms.is_some());

        let lookup = lookup_codex_cli_tokens_by_email(Some("B@EXAMPLE.com"))
            .await
            .expect("lookup");
        assert_eq!(lookup.refresh_token.as_deref(), Some("refresh-b"));
        assert_eq!(lookup.account_id.as_deref(), Some("acc_b"));
        drop(fx);
    }

    fn fake_state(id: &str) -> CodexCliState {
        CodexCliState {
            path: PathBuf::from("in-flight"),
            accounts: Vec::new(),
            active_account_id: Some(id.to_string()),
            active_email: None,
            sync_version: None,
            source_updated_at_ms: None,
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn non_forced_loads_coalesce_onto_the_in_flight_load() {
        let fx = StateFixture::new();
        // A perfectly valid accounts file exists on disk...
        fx.write_accounts(&json!({
            "activeAccountId": "acc_a",
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com",
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
            ],
        }));
        clear_codex_cli_state_cache();
        reset_codex_cli_metrics_for_tests();

        // ...but an in-flight load is registered, so a non-forced caller must
        // coalesce onto it instead of reading the disk.
        let (tx, rx) = watch::channel::<LoadSlot>(None);
        lock_cache().in_flight = Some(rx);
        let _ = tx.send(Some(Some(fake_state("acc_in_flight"))));

        let result = load_codex_cli_state(false).await.expect("coalesced result");
        assert_eq!(result.active_account_id.as_deref(), Some("acc_in_flight"));
        // No readTask ran: the caller never touched the disk.
        assert_eq!(get_codex_cli_metrics_snapshot().read_attempts, 0);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn concurrent_cache_miss_loads_coalesce_into_one_file_read() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "activeAccountId": "acc_a",
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com",
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
            ],
        }));
        clear_codex_cli_state_cache();
        reset_codex_cli_metrics_for_tests();

        // All 8 futures are polled inside one join! poll cycle on the
        // current-thread test runtime: the first registers the in-flight slot
        // synchronously under the cache lock, the other 7 coalesce onto it.
        let results = tokio::join!(
            load_codex_cli_state(false),
            load_codex_cli_state(false),
            load_codex_cli_state(false),
            load_codex_cli_state(false),
            load_codex_cli_state(false),
            load_codex_cli_state(false),
            load_codex_cli_state(false),
            load_codex_cli_state(false),
        );
        for state in [
            &results.0, &results.1, &results.2, &results.3, &results.4, &results.5, &results.6,
            &results.7,
        ] {
            assert_eq!(
                state
                    .as_ref()
                    .and_then(|state| state.active_account_id.as_deref()),
                Some("acc_a")
            );
        }
        assert_eq!(get_codex_cli_metrics_snapshot().read_attempts, 1);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn force_refresh_bypasses_the_in_flight_load_and_reads_fresh_disk_state() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "activeAccountId": "acc_b",
            "accounts": [
                {"accountId": "acc_b", "email": "b@example.com",
                 "auth": {"tokens": {"access_token": "x.y.z", "refresh_token": "refresh-b"}}},
            ],
        }));
        clear_codex_cli_state_cache();
        reset_codex_cli_metrics_for_tests();

        // A stale in-flight load is registered; the forced caller must NOT be
        // satisfied by it (TS: forced callers never coalesce).
        let (tx, rx) = watch::channel::<LoadSlot>(None);
        lock_cache().in_flight = Some(rx);
        let _ = tx.send(Some(Some(fake_state("acc_stale"))));

        let forced = load_codex_cli_state(true).await.expect("forced result");
        assert_eq!(forced.active_account_id.as_deref(), Some("acc_b"));
        assert_eq!(get_codex_cli_metrics_snapshot().read_attempts, 1);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn stale_generation_loads_cannot_clobber_the_committed_cache() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "activeAccountId": "acc_b",
            "accounts": [
                {"accountId": "acc_b", "email": "b@example.com",
                 "auth": {"tokens": {"access_token": "x.y.z", "refresh_token": "refresh-b"}}},
            ],
        }));
        clear_codex_cli_state_cache();

        // A real load claims the latest generation and commits acc_b.
        let fresh = load_codex_cli_state(true).await.expect("fresh");
        assert_eq!(fresh.active_account_id.as_deref(), Some("acc_b"));
        let latest = lock_cache().latest_load_generation;

        // A slower stale (older-generation) load resolving late must not
        // overwrite the shared cache committed by the newer one.
        commit_cache(latest - 1, Some(fake_state("acc_stale")));
        finalize_load(latest - 1);

        let after_stale = load_codex_cli_state(false).await.expect("cached");
        assert_eq!(after_stale.active_account_id.as_deref(), Some("acc_b"));
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn ttl_cache_serves_repeat_loads_and_force_refresh_bypasses_it() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "activeAccountId": "acc_a",
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com",
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
            ],
        }));
        clear_codex_cli_state_cache();
        reset_codex_cli_metrics_for_tests();

        let first = load_codex_cli_state(false).await.expect("first");
        assert_eq!(first.active_account_id.as_deref(), Some("acc_a"));
        assert_eq!(get_codex_cli_metrics_snapshot().read_attempts, 1);

        // Within the TTL window the cache satisfies the call — no new read.
        let second = load_codex_cli_state(false).await.expect("second");
        assert_eq!(second, first);
        assert_eq!(get_codex_cli_metrics_snapshot().read_attempts, 1);

        // forceRefresh always re-reads the disk.
        let forced = load_codex_cli_state(true).await.expect("forced");
        assert_eq!(forced.active_account_id.as_deref(), Some("acc_a"));
        assert_eq!(get_codex_cli_metrics_snapshot().read_attempts, 2);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn falls_back_to_auth_json_when_accounts_json_is_missing() {
        let fx = StateFixture::new();
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "access_token": AUTH_JWT,
                "refresh_token": "refresh-auth",
                "account_id": "acc_auth",
            },
            "last_refresh": "2026-02-25T21:36:07.864Z",
        }));

        let state = load_codex_cli_state(true).await.expect("state");
        assert_eq!(state.path, fx.auth_path);
        assert_eq!(state.accounts.len(), 1);
        assert_eq!(state.active_account_id.as_deref(), Some("acc_auth"));
        assert_eq!(state.active_email.as_deref(), Some("auth@example.com"));

        let lookup = lookup_codex_cli_tokens_by_email(Some("AUTH@EXAMPLE.COM"))
            .await
            .expect("lookup");
        assert_eq!(lookup.refresh_token.as_deref(), Some("refresh-auth"));
        assert_eq!(lookup.account_id.as_deref(), Some("acc_auth"));
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn falls_back_to_auth_json_when_accounts_json_is_malformed() {
        let fx = StateFixture::new();
        fs::write(&fx.accounts_path, "{ malformed json").unwrap();
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "access_token": AUTH_JWT,
                "refresh_token": "refresh-auth",
                "account_id": "acc_auth",
            },
        }));

        let state = load_codex_cli_state(true).await.expect("state");
        assert_eq!(state.path, fx.auth_path);
        assert_eq!(state.active_account_id.as_deref(), Some("acc_auth"));
        assert_eq!(state.accounts.len(), 1);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn derives_active_selection_from_per_account_active_flag() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com", "active": true,
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
            ],
        }));
        let state = load_codex_cli_state(true).await.expect("state");
        assert_eq!(state.accounts[0].account_id.as_deref(), Some("acc_a"));
        assert_eq!(state.active_email.as_deref(), Some("a@example.com"));
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_none_for_malformed_codex_cli_payload() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({"accounts": {"accountId": "acc_a"}}));
        assert_eq!(load_codex_cli_state(true).await, None);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_none_when_sync_is_disabled() {
        let mut fx = StateFixture::new();
        fx.sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "0");
        clear_codex_cli_state_cache();
        fx.write_accounts(&json!({
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com",
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
            ],
        }));
        assert_eq!(load_codex_cli_state(true).await, None);
        assert_eq!(lookup_codex_cli_tokens_by_email(Some("a@example.com")).await, None);
        drop(fx);
    }

    #[test]
    #[serial(env)]
    fn prefers_modern_sync_env_over_legacy() {
        let mut sandbox = EnvSandbox::new();
        __reset_codex_cli_warning_cache_for_tests();
        sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
        sandbox.set_var("CODEX_AUTH_SYNC_CODEX_CLI", "0");
        assert!(is_codex_cli_sync_enabled());
        __reset_codex_cli_warning_cache_for_tests();
        drop(sandbox);
    }

    #[test]
    #[serial(env)]
    fn honors_legacy_sync_env_values_and_emits_warning_metric_once() {
        let mut sandbox = EnvSandbox::new();
        sandbox.remove_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI");
        __reset_codex_cli_warning_cache_for_tests();
        reset_codex_cli_metrics_for_tests();

        sandbox.set_var("CODEX_AUTH_SYNC_CODEX_CLI", "0");
        assert!(!is_codex_cli_sync_enabled());
        sandbox.set_var("CODEX_AUTH_SYNC_CODEX_CLI", "1");
        assert!(is_codex_cli_sync_enabled());
        assert!(is_codex_cli_sync_enabled());
        assert_eq!(get_codex_cli_metrics_snapshot().legacy_sync_env_uses, 1);

        __reset_codex_cli_warning_cache_for_tests();
        reset_codex_cli_metrics_for_tests();
        drop(sandbox);
    }

    #[test]
    #[serial(env)]
    fn sync_defaults_on_and_ignores_unrecognized_values() {
        let mut sandbox = EnvSandbox::new();
        __reset_codex_cli_warning_cache_for_tests();
        sandbox.remove_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI");
        sandbox.remove_var("CODEX_AUTH_SYNC_CODEX_CLI");
        assert!(is_codex_cli_sync_enabled());
        // Only literal "0"/"1" are recognized — "true" falls to the default.
        sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "true");
        assert!(is_codex_cli_sync_enabled());
        __reset_codex_cli_warning_cache_for_tests();
        drop(sandbox);
    }

    #[tokio::test]
    #[serial(env)]
    async fn records_a_read_miss_when_neither_file_exists() {
        let fx = StateFixture::new();
        assert_eq!(load_codex_cli_state(true).await, None);
        assert!(get_codex_cli_metrics_snapshot().read_misses >= 1);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn parses_string_booleans_and_numbers_while_filtering_invalid_entries() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "accounts": [
                123,
                {"accountId": "missing"},
                {"account_id": "acc_true", "username": "TRUE@EXAMPLE.COM",
                 "access_token": "true.access.token", "refresh_token": "true-refresh",
                 "is_active": "1", "expires_at": "1710000000000"},
                {"id": "acc_false", "user_email": "FALSE@EXAMPLE.COM",
                 "access_token": "false.access.token", "refresh_token": "false-refresh",
                 "active": "0", "expiresAt": "1710000005000"},
            ],
        }));
        let state = load_codex_cli_state(true).await.expect("state");
        assert_eq!(state.accounts.len(), 2);
        assert_eq!(state.active_account_id.as_deref(), Some("acc_true"));
        assert_eq!(state.active_email.as_deref(), Some("true@example.com"));
        assert_eq!(state.accounts[0].is_active, Some(true));
        assert_eq!(state.accounts[0].expires_at, Some(1_710_000_000_000.0));
        assert_eq!(state.accounts[1].is_active, Some(false));
        assert_eq!(state.accounts[1].expires_at, Some(1_710_000_005_000.0));
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn derives_expiration_from_jwt_and_uses_auth_account_id_email_fallbacks() {
        let fx = StateFixture::new();
        fx.write_auth(&json!({
            "email": "Auth@Example.COM",
            "codexMultiAuthSyncVersion": "777",
            "tokens": {
                "access_token": AUTH_JWT,
                "refresh_token": "refresh-auth",
                "accountId": " acc_from_auth_field ",
            },
        }));
        let state = load_codex_cli_state(true).await.expect("state");
        assert_eq!(state.active_account_id.as_deref(), Some("acc_from_auth_field"));
        assert_eq!(state.active_email.as_deref(), Some("auth@example.com"));
        assert_eq!(state.sync_version, Some(777.0));
        assert_eq!(state.accounts[0].expires_at, Some(4_100_000_000_000.0));
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_none_when_auth_payload_tokens_are_missing_or_tokenless() {
        let fx = StateFixture::new();
        fx.write_auth(&json!({"tokens": []}));
        assert_eq!(load_codex_cli_state(true).await, None);

        fx.write_auth(&json!({"tokens": {"id_token": "id-only"}}));
        clear_codex_cli_state_cache();
        assert_eq!(load_codex_cli_state(true).await, None);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_none_for_lookup_with_blank_email_or_missing_access_token() {
        let fx = StateFixture::new();
        fx.write_accounts(&json!({
            "accounts": [{"email": "a@example.com", "refresh_token": "refresh-a"}],
        }));
        assert_eq!(lookup_codex_cli_tokens_by_email(Some("   ")).await, None);
        assert_eq!(lookup_codex_cli_tokens_by_email(None).await, None);
        // Refresh-only entries survive parsing with an empty accessToken but
        // are never surfaced by lookup.
        assert_eq!(
            lookup_codex_cli_tokens_by_email(Some("a@example.com")).await,
            None
        );
        drop(fx);
    }

    #[test]
    #[serial(env)]
    fn uses_codex_home_defaults_when_explicit_overrides_are_absent() {
        let mut sandbox = EnvSandbox::new();
        let codex_home = sandbox.root().join("custom-codex-home");
        sandbox.set_var("CODEX_HOME", &codex_home);
        sandbox.remove_var("CODEX_CLI_ACCOUNTS_PATH");
        sandbox.remove_var("CODEX_CLI_AUTH_PATH");
        sandbox.remove_var("CODEX_CLI_CONFIG_PATH");

        assert_eq!(get_codex_cli_accounts_path(), codex_home.join("accounts.json"));
        assert_eq!(get_codex_cli_auth_path(), codex_home.join("auth.json"));
        assert_eq!(get_codex_cli_config_path(), codex_home.join("config.toml"));
        drop(sandbox);
    }

    #[tokio::test]
    #[serial(env)]
    async fn retry_policy_retries_ebusy_eperm_and_rejects_other_codes() {
        use cma_core::fs_retry::CodedError;
        use std::io;
        use std::sync::atomic::AtomicU32;

        // EPERM once → succeeds on the second attempt (TS test parity via the
        // same retry options the readers use).
        let attempts = AtomicU32::new(0);
        let result: Result<&str, io::Error> = with_retry(
            || {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        Err(io::Error::other(CodedError::new("EPERM", "locked")))
                    } else {
                        Ok("ok")
                    }
                }
            },
            fs_retry_options(),
        )
        .await;
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);

        // EACCES is NOT retryable for the CLI-state readers.
        let attempts = AtomicU32::new(0);
        let result: Result<&str, io::Error> = with_retry(
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    Err(io::Error::other(CodedError::new("EACCES", "denied")))
                }
            },
            fs_retry_options(),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn js_number_coercion_mirrors_number_builtin() {
        assert_eq!(js_number_from_str(""), Some(0.0));
        assert_eq!(js_number_from_str("   "), Some(0.0));
        assert_eq!(js_number_from_str("1710000000000"), Some(1_710_000_000_000.0));
        assert_eq!(js_number_from_str(" 12 "), Some(12.0));
        assert_eq!(js_number_from_str("1.5e3"), Some(1500.0));
        assert_eq!(js_number_from_str("0x10"), Some(16.0));
        assert_eq!(js_number_from_str("abc"), None);
        assert_eq!(js_number_from_str("1_000"), None);
        assert_eq!(js_number_from_str("nan"), None);
        // Infinity parses but read_number rejects non-finite values.
        assert_eq!(
            read_number(Some(&Value::String("Infinity".into()))),
            None
        );
        assert_eq!(read_number(Some(&json!(42))), Some(42.0));
        assert_eq!(read_number(Some(&json!(true))), None);
    }
}
