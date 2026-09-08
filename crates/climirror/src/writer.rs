//! Port of `lib/codex-cli/writer.ts` — persist the multi-auth "active account
//! selection" into the official Codex CLI's `accounts.json` / `auth.json` /
//! `config.toml` (mirror write).
//!
//! Behavior source: specs/11-cli-usage-recovery.md §1.4 + §7.1–7.3 (+ gotchas
//! 3–8, 37); TS source is authoritative.
//!
//! Contracts:
//! - Dual-key writes: snake_case AND camelCase token/id keys at the top level
//!   and inside `auth.tokens`; triple-written active flags
//!   (`active`/`isActive`/`is_active`) on EVERY account.
//! - `OPENAI_API_KEY` is forced to a literal JSON `null` in auth.json.
//! - `auth_mode` defaults to `"chatgpt"`; `id_token` falls back to the ACCESS
//!   token when no id token is available (deliberate).
//! - Partial token pairs hard-fail the auth write (`partial-token-payload`).
//! - `codexMultiAuthSyncVersion = Date.now()` stamped into every mirror file;
//!   `getLastCodexCliSelectionWriteTimestamp` is the monotonic max of stamps
//!   written this process (mtime-echo suppression, gotcha 37).
//! - `config.toml` gets a LINE-EDIT (string manipulation, no toml crate)
//!   guaranteeing `cli_auth_credentials_store = "file"` before the first
//!   `[section]`; unknown fields everywhere are preserved.
//! - All JSON is 2-space pretty, NO trailing newline, written atomically
//!   (temp + rename retried 5× on EPERM/EBUSY) with mode 0600.

use std::path::Path;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::{Map, Value, json};

use cma_core::json_io::{
    TrailingNewline, WriteJsonOptions, read_text_file, stringify_pretty2, write_json_atomic,
};
use cma_core::logger::{ScopedLogger, create_logger};
use cma_core::utils::now_ms;

use crate::observability::{
    CodexCliMetricKey, increment_codex_cli_metric, make_account_fingerprint,
};
use crate::state::{
    clear_codex_cli_state_cache, get_codex_cli_accounts_path, get_codex_cli_auth_path,
    get_codex_cli_config_path, is_codex_cli_sync_enabled,
};

fn writer_log() -> ScopedLogger {
    create_logger("codex-cli-writer")
}

type DynError = Box<dyn std::error::Error + Send + Sync>;

static LAST_SELECTION_WRITE_AT: AtomicI64 = AtomicI64::new(0);
/// In-process serialization of all mirror writes (TS promise-chain queue;
/// tokio's Mutex is FIFO-fair, matching the chain's ordering).
static WRITE_QUEUE: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// The selection to mirror into the Codex CLI files (TS `ActiveSelection`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ActiveSelection {
    pub account_id: Option<String>,
    pub email: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<f64>,
    pub id_token: Option<String>,
}

// ---------------------------------------------------------------------------
// Tolerant value readers (writer.ts deliberately duplicates state.ts's)
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

fn trimmed_non_empty(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn read_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        // JS Number() coercion (Number("") === 0) — shared with state.rs.
        Value::String(s) => crate::state::js_number_from_str(s).filter(|v| v.is_finite()),
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

fn normalize_email(value: Option<&Value>) -> Option<String> {
    let s = value?.as_str()?;
    let trimmed = s.trim().to_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn normalize_email_str(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim().to_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn read_account_id(record: &Map<String, Value>) -> Option<String> {
    for key in ["accountId", "account_id", "workspace_id", "organization_id", "id"] {
        if let Some(Value::String(value)) = record.get(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn as_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value?.as_object()
}

fn extract_selection_from_account_record(record: &Map<String, Value>) -> ActiveSelection {
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
    let account_id = read_account_id(record).or_else(|| {
        tokens.and_then(|tokens| {
            read_trimmed_string(tokens.get("account_id"))
                .or_else(|| read_trimmed_string(tokens.get("accountId")))
        })
    });
    let id_token = extract_token_from_record(record, &["idToken", "id_token"]).or_else(|| {
        tokens.and_then(|tokens| extract_token_from_record(tokens, &["id_token", "idToken"]))
    });
    let email = normalize_email(record.get("email"))
        .or_else(|| normalize_email(record.get("user_email")))
        .or_else(|| normalize_email(record.get("username")));
    let expires_at = read_number(record.get("expiresAt"))
        .or_else(|| read_number(record.get("expires_at")))
        .or_else(|| tokens.and_then(|tokens| read_number(tokens.get("expires_at"))));

    ActiveSelection {
        account_id,
        email,
        access_token,
        refresh_token,
        expires_at,
        id_token,
    }
}

/// TS `enrichActiveAccountRecordWithTokens`: returns the record unchanged
/// unless BOTH an access and a refresh token resolve (no partial token
/// writes); otherwise duplicates snake+camel token keys at the top level and
/// rebuilds `auth.tokens` with the same dual-key duplication.
fn enrich_active_account_record_with_tokens(
    record: Map<String, Value>,
    selection: &ActiveSelection,
) -> Map<String, Value> {
    let auth = as_object(record.get("auth")).cloned().unwrap_or_default();
    let tokens = as_object(auth.get("tokens")).cloned().unwrap_or_default();

    let current_access = extract_token_from_record(&record, &["accessToken", "access_token"])
        .or_else(|| extract_token_from_record(&tokens, &["access_token", "accessToken"]));
    let current_refresh = extract_token_from_record(&record, &["refreshToken", "refresh_token"])
        .or_else(|| extract_token_from_record(&tokens, &["refresh_token", "refreshToken"]));
    let current_id_token = extract_token_from_record(&record, &["idToken", "id_token"])
        .or_else(|| extract_token_from_record(&tokens, &["id_token", "idToken"]));

    let selected_access = trimmed_non_empty(selection.access_token.as_deref());
    let selected_refresh = trimmed_non_empty(selection.refresh_token.as_deref());
    let selected_id_token = trimmed_non_empty(selection.id_token.as_deref());
    // `selection.accountId?.trim() || readAccountId(record)` — the empty
    // string is falsy, so it falls through to the record.
    let account_id = selection
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| read_account_id(&record));
    let email = normalize_email_str(selection.email.as_deref())
        .or_else(|| normalize_email(record.get("email")));

    let access_token = match selected_access.or(current_access) {
        Some(token) => token,
        None => return record,
    };
    let refresh_token = match selected_refresh.or(current_refresh) {
        Some(token) => token,
        None => return record,
    };

    // Falls back to the ACCESS token when no id token exists (deliberate).
    let id_token = selected_id_token
        .or(current_id_token)
        .unwrap_or_else(|| access_token.clone());

    let mut next = record;
    next.insert("accessToken".into(), Value::String(access_token.clone()));
    next.insert("access_token".into(), Value::String(access_token.clone()));
    next.insert("refreshToken".into(), Value::String(refresh_token.clone()));
    next.insert("refresh_token".into(), Value::String(refresh_token.clone()));
    next.insert("idToken".into(), Value::String(id_token.clone()));
    next.insert("id_token".into(), Value::String(id_token.clone()));
    if let Some(account_id) = &account_id {
        next.insert("accountId".into(), Value::String(account_id.clone()));
        next.insert("account_id".into(), Value::String(account_id.clone()));
    }
    if let Some(email) = &email {
        next.insert("email".into(), Value::String(email.clone()));
    }

    let mut next_tokens = tokens;
    next_tokens.insert("access_token".into(), Value::String(access_token.clone()));
    next_tokens.insert("accessToken".into(), Value::String(access_token));
    next_tokens.insert("refresh_token".into(), Value::String(refresh_token.clone()));
    next_tokens.insert("refreshToken".into(), Value::String(refresh_token));
    next_tokens.insert("id_token".into(), Value::String(id_token.clone()));
    next_tokens.insert("idToken".into(), Value::String(id_token));
    if let Some(account_id) = &account_id {
        next_tokens.insert("account_id".into(), Value::String(account_id.clone()));
        next_tokens.insert("accountId".into(), Value::String(account_id.clone()));
    }
    let mut next_auth = auth;
    next_auth.insert("tokens".into(), Value::Object(next_tokens));
    next.insert("auth".into(), Value::Object(next_auth));

    next
}

/// TS `resolveMatchIndex`: accountId match first (against ALL id-shaped keys
/// on the entry), then lowercased email equality.
fn resolve_match_index(accounts: &[Value], selection: &ActiveSelection) -> Option<usize> {
    let desired_id = trimmed_non_empty(selection.account_id.as_deref());
    let desired_email = normalize_email_str(selection.email.as_deref());

    if let Some(desired_id) = &desired_id {
        let by_id = accounts.iter().position(|entry| {
            entry
                .as_object()
                .is_some_and(|record| read_account_id(record).as_deref() == Some(desired_id))
        });
        if by_id.is_some() {
            return by_id;
        }
    }

    if let Some(desired_email) = &desired_email {
        let by_email = accounts.iter().position(|entry| {
            entry.as_object().is_some_and(|record| {
                normalize_email(record.get("email")).as_deref() == Some(desired_email)
            })
        });
        if by_email.is_some() {
            return by_email;
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Time formatting (Node `new Date(ms).toISOString()` parity)
// ---------------------------------------------------------------------------

/// Howard Hinnant's civil-from-days algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn epoch_ms_to_iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let millis = rem % 1000;
    let total_seconds = rem / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
    )
}

/// TS `toIsoTime`: ISO string of `ms` when finite and > 0, else "now".
fn to_iso_time(ms: Option<f64>) -> String {
    match ms {
        Some(value) if value.is_finite() && value > 0.0 => epoch_ms_to_iso(value.trunc() as i64),
        _ => epoch_ms_to_iso(now_ms()),
    }
}

// ---------------------------------------------------------------------------
// Atomic writers (TS `atomicWriteText` / `atomicWriteJson`)
// ---------------------------------------------------------------------------

async fn atomic_write_text(path: &Path, content: &str) -> std::io::Result<()> {
    // temp at tempPathFor(path), mode 0600, rename retried 5× on EPERM/EBUSY
    // with 10·2^n ms backoff — the json_io defaults implement exactly this.
    write_json_atomic(
        path,
        content,
        Some(0o600),
        &WriteJsonOptions {
            trailing_newline: TrailingNewline::None,
            ensure_parent_dir: true,
            ..Default::default()
        },
    )
    .await
}

async fn atomic_write_json(path: &Path, payload: &Map<String, Value>) -> std::io::Result<()> {
    atomic_write_text(path, &stringify_pretty2(payload)).await
}

// ---------------------------------------------------------------------------
// config.toml line edit (TS `ensureCodexCliFileAuthStore`)
// ---------------------------------------------------------------------------

fn should_enforce_codex_cli_file_auth_store() -> bool {
    let value = std::env::var("CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE")
        .unwrap_or_else(|_| "1".to_string());
    value.trim() != "0"
}

fn ensure_trailing_newline(value: &str) -> String {
    if value.ends_with('\n') {
        value.to_string()
    } else {
        format!("{value}\n")
    }
}

/// `/^\s*cli_auth_credentials_store\s*=/`
fn is_auth_store_assignment(line: &str) -> bool {
    let rest = line.trim_start();
    match rest.strip_prefix("cli_auth_credentials_store") {
        Some(after) => after.trim_start().starts_with('='),
        None => false,
    }
}

/// Split on `/\r?\n/` — Node parity: a lone `\r` stays inside its line.
fn split_lines(raw: &str) -> Vec<String> {
    raw.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect()
}

async fn ensure_codex_cli_file_auth_store(config_path: &Path) -> Result<bool, DynError> {
    if !should_enforce_codex_cli_file_auth_store() {
        return Ok(false);
    }

    const DESIRED: &str = "cli_auth_credentials_store = \"file\"";
    let raw = if config_path.exists() {
        read_text_file(config_path)?
    } else {
        String::new()
    };
    let mut next_lines: Vec<String> = if raw.is_empty() {
        Vec::new()
    } else {
        split_lines(&raw)
    };

    let mut replaced = false;
    for line in next_lines.iter_mut() {
        if !replaced && is_auth_store_assignment(line) {
            replaced = true;
            *line = DESIRED.to_string();
        }
    }

    if !replaced {
        let insert_at = next_lines
            .iter()
            .position(|line| line.trim_start().starts_with('['))
            .unwrap_or(next_lines.len());
        next_lines.insert(insert_at, DESIRED.to_string());
        if insert_at < next_lines.len() - 1 && !next_lines[insert_at + 1].trim().is_empty() {
            next_lines.insert(insert_at + 1, String::new());
        }
    }

    let next_raw = ensure_trailing_newline(&next_lines.join("\n"));
    if next_raw == ensure_trailing_newline(&raw) {
        return Ok(false);
    }

    atomic_write_text(config_path, &next_raw).await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// auth.json writer (TS `writeCodexAuthState`)
// ---------------------------------------------------------------------------

async fn write_codex_auth_state(
    path: &Path,
    selection: &ActiveSelection,
) -> Result<bool, DynError> {
    let log = writer_log();
    let raw = if path.exists() {
        read_text_file(path)?
    } else {
        "{}".to_string()
    };
    let parsed: Value = serde_json::from_str(&raw)?;
    let Some(parsed) = parsed.as_object() else {
        log.warn(
            "Failed to persist Codex auth selection",
            Some(&json!({
                "operation": "write-active-selection",
                "outcome": "malformed-auth-state",
                "path": path.display().to_string(),
            })),
        );
        return Ok(false);
    };

    let existing_tokens = as_object(parsed.get("tokens")).cloned().unwrap_or_default();
    let mut next = parsed.clone();
    let mut next_tokens = existing_tokens.clone();

    let sync_version = now_ms();
    let selected_access_token = trimmed_non_empty(selection.access_token.as_deref());
    let selected_refresh_token = trimmed_non_empty(selection.refresh_token.as_deref());
    // Existing tokens use a bare `typeof === "string"` check (no trim/empty
    // filter) — the empty case is caught by the missing-token guard below.
    let existing_access_token = existing_tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::to_string);
    let existing_refresh_token = existing_tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_string);
    let has_selected_access = selected_access_token.is_some();
    let has_selected_refresh = selected_refresh_token.is_some();
    let selected_token_pair = has_selected_access && has_selected_refresh;

    let (access_token, refresh_token) = if selected_token_pair {
        (selected_access_token.clone(), selected_refresh_token.clone())
    } else if !has_selected_access && !has_selected_refresh {
        (existing_access_token, existing_refresh_token)
    } else {
        log.warn(
            "Failed to persist Codex auth selection",
            Some(&json!({
                "operation": "write-active-selection",
                "outcome": "partial-token-payload",
                "path": path.display().to_string(),
                "accountRef": make_account_fingerprint(
                    selection.account_id.as_deref(),
                    selection.email.as_deref(),
                ),
            })),
        );
        return Ok(false);
    };

    // JS falsy: undefined OR "" both fail here.
    let (access_token, refresh_token) = match (
        access_token.filter(|t| !t.is_empty()),
        refresh_token.filter(|t| !t.is_empty()),
    ) {
        (Some(access), Some(refresh)) => (access, refresh),
        _ => {
            log.warn(
                "Failed to persist Codex auth selection",
                Some(&json!({
                    "operation": "write-active-selection",
                    "outcome": "missing-token-payload",
                    "path": path.display().to_string(),
                    "accountRef": make_account_fingerprint(
                        selection.account_id.as_deref(),
                        selection.email.as_deref(),
                    ),
                })),
            );
            return Ok(false);
        }
    };

    let auth_mode = match parsed.get("auth_mode") {
        Some(Value::String(mode)) => mode.clone(),
        _ => "chatgpt".to_string(),
    };
    next.insert("auth_mode".into(), Value::String(auth_mode));
    next.insert("OPENAI_API_KEY".into(), Value::Null);
    if let Some(selected_email) = normalize_email_str(selection.email.as_deref()) {
        next.insert("email".into(), Value::String(selected_email));
    }
    next_tokens.insert("access_token".into(), Value::String(access_token.clone()));
    next_tokens.insert("refresh_token".into(), Value::String(refresh_token));
    if let Some(account_id) = trimmed_non_empty(selection.account_id.as_deref()) {
        next_tokens.insert("account_id".into(), Value::String(account_id));
    }
    let selected_id_token = trimmed_non_empty(selection.id_token.as_deref());
    let existing_id_token = read_trimmed_string(existing_tokens.get("id_token"));
    let fallback_id_token = if selected_token_pair {
        access_token.clone()
    } else {
        existing_id_token.unwrap_or_else(|| access_token.clone())
    };
    if let Some(selected_id_token) = selected_id_token {
        next_tokens.insert("id_token".into(), Value::String(selected_id_token));
    } else if !fallback_id_token.is_empty() {
        next_tokens.insert("id_token".into(), Value::String(fallback_id_token));
    }
    next.insert("tokens".into(), Value::Object(next_tokens));
    next.insert(
        "last_refresh".into(),
        Value::String(to_iso_time(selection.expires_at)),
    );
    next.insert("codexMultiAuthSyncVersion".into(), json!(sync_version));

    atomic_write_json(path, &next).await?;
    LAST_SELECTION_WRITE_AT.fetch_max(sync_version, Ordering::SeqCst);
    Ok(true)
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// Persist the active account selection into the Codex CLI mirror files
/// (TS `setCodexCliActiveSelection`). Queued in-process; returns `true` only
/// when the accounts and/or auth file was actually written.
pub async fn set_codex_cli_active_selection(selection: &ActiveSelection) -> bool {
    let _queue_guard = WRITE_QUEUE.lock().await;
    let log = writer_log();

    if !is_codex_cli_sync_enabled() {
        return false;
    }

    increment_codex_cli_metric(CodexCliMetricKey::WriteAttempts);
    let accounts_path = get_codex_cli_accounts_path();
    let auth_path = get_codex_cli_auth_path();
    let config_path = get_codex_cli_config_path();
    let has_accounts_path = accounts_path.exists();
    let has_auth_path = auth_path.exists();
    let selection_has_tokens = trimmed_non_empty(selection.access_token.as_deref()).is_some()
        && trimmed_non_empty(selection.refresh_token.as_deref()).is_some();
    let require_auth_write = has_auth_path || selection_has_tokens;

    if !has_accounts_path && !has_auth_path && !selection_has_tokens {
        increment_codex_cli_metric(CodexCliMetricKey::WriteFailures);
        return false;
    }

    match set_active_selection_inner(
        &log,
        selection,
        &accounts_path,
        &auth_path,
        &config_path,
        has_accounts_path,
        has_auth_path,
        selection_has_tokens,
        require_auth_write,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            increment_codex_cli_metric(CodexCliMetricKey::WriteFailures);
            log.warn(
                "Failed to persist Codex CLI active selection",
                Some(&json!({
                    "operation": "write-active-selection",
                    "outcome": "error",
                    "path": if has_accounts_path {
                        accounts_path.display().to_string()
                    } else {
                        auth_path.display().to_string()
                    },
                    "accountRef": make_account_fingerprint(
                        selection.account_id.as_deref(),
                        selection.email.as_deref(),
                    ),
                    "error": error.to_string(),
                })),
            );
            false
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn set_active_selection_inner(
    log: &ScopedLogger,
    selection: &ActiveSelection,
    accounts_path: &Path,
    auth_path: &Path,
    config_path: &Path,
    has_accounts_path: bool,
    has_auth_path: bool,
    selection_has_tokens: bool,
    require_auth_write: bool,
) -> Result<bool, DynError> {
    let mut resolved_selection = selection.clone();
    let mut wrote_accounts = false;
    let mut wrote_auth = false;
    let mut wrote_config = false;

    if has_accounts_path {
        let raw = read_text_file(accounts_path)?;
        let parsed: Value = serde_json::from_str(&raw)?;
        let accounts = parsed
            .as_object()
            .and_then(|record| record.get("accounts"))
            .and_then(Value::as_array)
            .cloned();
        match accounts {
            None => {
                log.warn(
                    "Failed to persist Codex CLI active selection",
                    Some(&json!({
                        "operation": "write-active-selection",
                        "outcome": "malformed",
                        "path": accounts_path.display().to_string(),
                    })),
                );
            }
            Some(accounts) => {
                let parsed = parsed.as_object().expect("checked above").clone();
                match resolve_match_index(&accounts, selection) {
                    None => {
                        log.warn(
                            "Failed to persist Codex CLI active selection",
                            Some(&json!({
                                "operation": "write-active-selection",
                                "outcome": "no-match",
                                "path": accounts_path.display().to_string(),
                                "accountRef": make_account_fingerprint(
                                    selection.account_id.as_deref(),
                                    selection.email.as_deref(),
                                ),
                            })),
                        );
                        if !has_auth_path || !selection_has_tokens {
                            increment_codex_cli_metric(CodexCliMetricKey::WriteFailures);
                            return Ok(false);
                        }
                    }
                    Some(match_index) => {
                        let chosen = accounts[match_index].as_object().cloned();
                        match chosen {
                            None => {
                                log.warn(
                                    "Failed to persist Codex CLI active selection",
                                    Some(&json!({
                                        "operation": "write-active-selection",
                                        "outcome": "invalid-account-record",
                                        "path": accounts_path.display().to_string(),
                                    })),
                                );
                                if !has_auth_path {
                                    increment_codex_cli_metric(CodexCliMetricKey::WriteFailures);
                                    return Ok(false);
                                }
                            }
                            Some(chosen) => {
                                let chosen_selection =
                                    extract_selection_from_account_record(&chosen);
                                // Caller-wins merge: the record only fills gaps.
                                resolved_selection = ActiveSelection {
                                    account_id: resolved_selection
                                        .account_id
                                        .or(chosen_selection.account_id),
                                    email: resolved_selection.email.or(chosen_selection.email),
                                    access_token: resolved_selection
                                        .access_token
                                        .or(chosen_selection.access_token),
                                    refresh_token: resolved_selection
                                        .refresh_token
                                        .or(chosen_selection.refresh_token),
                                    expires_at: resolved_selection
                                        .expires_at
                                        .or(chosen_selection.expires_at),
                                    id_token: resolved_selection
                                        .id_token
                                        .or(chosen_selection.id_token),
                                };

                                let mut next = parsed.clone();
                                let sync_version = now_ms();
                                // Active-pointer fields prefer the RECORD's
                                // values over the selection's (deliberate —
                                // gotcha 8).
                                let chosen_account_id = read_account_id(&chosen).or_else(|| {
                                    selection
                                        .account_id
                                        .as_deref()
                                        .map(|id| id.trim().to_string())
                                });
                                let chosen_email = normalize_email(chosen.get("email"))
                                    .or_else(|| normalize_email_str(selection.email.as_deref()));

                                if let Some(id) =
                                    chosen_account_id.clone().filter(|id| !id.is_empty())
                                {
                                    next.insert(
                                        "activeAccountId".into(),
                                        Value::String(id.clone()),
                                    );
                                    next.insert("active_account_id".into(), Value::String(id));
                                }
                                if let Some(email) = chosen_email.clone() {
                                    next.insert(
                                        "activeEmail".into(),
                                        Value::String(email.clone()),
                                    );
                                    next.insert("active_email".into(), Value::String(email));
                                }

                                let next_accounts: Vec<Value> = accounts
                                    .iter()
                                    .enumerate()
                                    .map(|(index, entry)| match entry.as_object() {
                                        None => entry.clone(),
                                        Some(record) => {
                                            let mut updated = record.clone();
                                            if index == match_index {
                                                updated = enrich_active_account_record_with_tokens(
                                                    updated,
                                                    &resolved_selection,
                                                );
                                            }
                                            let is_match = index == match_index;
                                            updated.insert("active".into(), Value::Bool(is_match));
                                            updated
                                                .insert("isActive".into(), Value::Bool(is_match));
                                            updated
                                                .insert("is_active".into(), Value::Bool(is_match));
                                            Value::Object(updated)
                                        }
                                    })
                                    .collect();
                                next.insert("accounts".into(), Value::Array(next_accounts));
                                next.insert("codexMultiAuthSyncVersion".into(), json!(sync_version));

                                atomic_write_json(accounts_path, &next).await?;
                                LAST_SELECTION_WRITE_AT.fetch_max(sync_version, Ordering::SeqCst);
                                wrote_accounts = true;
                                log.debug(
                                    "Persisted Codex CLI accounts selection",
                                    Some(&json!({
                                        "operation": "write-active-selection",
                                        "outcome": "success",
                                        "path": accounts_path.display().to_string(),
                                        "accountRef": make_account_fingerprint(
                                            chosen_account_id.as_deref(),
                                            chosen_email.as_deref(),
                                        ),
                                    })),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    if has_auth_path || wrote_accounts || selection_has_tokens {
        wrote_auth = write_codex_auth_state(auth_path, &resolved_selection).await?;
        if !wrote_auth {
            log.warn(
                "Codex auth state update skipped after accounts selection update",
                Some(&json!({
                    "operation": "write-active-selection",
                    "outcome": "accounts-updated-auth-failed",
                    "path": auth_path.display().to_string(),
                    "accountRef": make_account_fingerprint(
                        resolved_selection.account_id.as_deref(),
                        resolved_selection.email.as_deref(),
                    ),
                })),
            );
            if require_auth_write || !wrote_accounts {
                increment_codex_cli_metric(CodexCliMetricKey::WriteFailures);
                return Ok(false);
            }
        } else {
            log.debug(
                "Persisted Codex auth active selection",
                Some(&json!({
                    "operation": "write-active-selection",
                    "outcome": "success",
                    "path": auth_path.display().to_string(),
                    "accountRef": make_account_fingerprint(
                        resolved_selection.account_id.as_deref(),
                        resolved_selection.email.as_deref(),
                    ),
                })),
            );
        }
    }

    match ensure_codex_cli_file_auth_store(config_path).await {
        Ok(updated) => wrote_config = updated,
        Err(error) => {
            log.warn(
                "Failed to persist Codex config file auth store",
                Some(&json!({
                    "operation": "write-active-selection",
                    "outcome": "config-auth-store-update-failed",
                    "path": config_path.display().to_string(),
                    "error": error.to_string(),
                })),
            );
        }
    }

    if wrote_accounts || wrote_auth {
        clear_codex_cli_state_cache();
        increment_codex_cli_metric(CodexCliMetricKey::WriteSuccesses);
        return Ok(true);
    }

    if wrote_config {
        log.debug(
            "Persisted Codex config file auth store override",
            Some(&json!({
                "operation": "write-active-selection",
                "outcome": "config-updated-only",
                "path": config_path.display().to_string(),
            })),
        );
    }

    increment_codex_cli_metric(CodexCliMetricKey::WriteFailures);
    Ok(false)
}

/// Module-level max of the `codexMultiAuthSyncVersion` stamps written this
/// process (0 initially) — used to ignore mtime echoes of our own mirror
/// writes (TS `getLastCodexCliSelectionWriteTimestamp`).
pub fn get_last_codex_cli_selection_write_timestamp() -> i64 {
    LAST_SELECTION_WRITE_AT.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Tests (ported from test/codex-cli-writer.test.ts + goldens)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observability::{
        get_codex_cli_metrics_snapshot, reset_codex_cli_metrics_for_tests,
    };
    use cma_testkit::goldens::assert_golden_str;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;
    use std::fs;
    use std::path::PathBuf;

    struct WriterFixture {
        #[allow(dead_code)]
        sandbox: EnvSandbox,
        accounts_path: PathBuf,
        auth_path: PathBuf,
        config_path: PathBuf,
    }

    impl WriterFixture {
        fn new() -> Self {
            let mut sandbox = EnvSandbox::new();
            let accounts_path = sandbox.root().join("accounts.json");
            let auth_path = sandbox.root().join("auth.json");
            let config_path = sandbox.root().join("config.toml");
            sandbox.set_var("CODEX_CLI_ACCOUNTS_PATH", &accounts_path);
            sandbox.set_var("CODEX_CLI_AUTH_PATH", &auth_path);
            sandbox.set_var("CODEX_CLI_CONFIG_PATH", &config_path);
            sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "1");
            sandbox.set_var("CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE", "1");
            clear_codex_cli_state_cache();
            reset_codex_cli_metrics_for_tests();
            WriterFixture {
                sandbox,
                accounts_path,
                auth_path,
                config_path,
            }
        }

        fn write_accounts(&self, value: &Value) {
            fs::write(&self.accounts_path, stringify_pretty2(value)).unwrap();
        }

        fn write_auth(&self, value: &Value) {
            fs::write(&self.auth_path, stringify_pretty2(value)).unwrap();
        }

        fn read_json(&self, path: &Path) -> Value {
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
        }
    }

    impl Drop for WriterFixture {
        fn drop(&mut self) {
            clear_codex_cli_state_cache();
            reset_codex_cli_metrics_for_tests();
        }
    }

    fn selection(fields: &[(&str, &str)]) -> ActiveSelection {
        let mut sel = ActiveSelection::default();
        for (key, value) in fields {
            match *key {
                "accountId" => sel.account_id = Some((*value).to_string()),
                "email" => sel.email = Some((*value).to_string()),
                "accessToken" => sel.access_token = Some((*value).to_string()),
                "refreshToken" => sel.refresh_token = Some((*value).to_string()),
                "idToken" => sel.id_token = Some((*value).to_string()),
                _ => panic!("unknown selection field {key}"),
            }
        }
        sel
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_false_when_neither_accounts_nor_auth_exists() {
        let fx = WriterFixture::new();
        let updated =
            set_codex_cli_active_selection(&selection(&[("accountId", "missing")])).await;
        assert!(!updated);
        assert!(get_codex_cli_metrics_snapshot().write_failures >= 1);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn creates_auth_json_when_missing_and_selection_includes_tokens() {
        let fx = WriterFixture::new();
        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_new"),
            ("email", "new@example.com"),
            ("accessToken", "new-access"),
            ("refreshToken", "new-refresh"),
        ]))
        .await;
        assert!(updated);

        let auth = fx.read_json(&fx.auth_path);
        assert_eq!(auth["email"], "new@example.com");
        assert_eq!(auth["tokens"]["access_token"], "new-access");
        // id_token falls back to the ACCESS token (deliberate).
        assert_eq!(auth["tokens"]["id_token"], "new-access");
        assert_eq!(auth["tokens"]["refresh_token"], "new-refresh");
        assert_eq!(auth["tokens"]["account_id"], "acc_new");
        assert_eq!(auth["OPENAI_API_KEY"], Value::Null);
        assert_eq!(auth["auth_mode"], "chatgpt");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn forces_file_backed_codex_auth_store_in_config_toml() {
        let fx = WriterFixture::new();
        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_new"),
            ("email", "new@example.com"),
            ("accessToken", "new-access"),
            ("refreshToken", "new-refresh"),
        ]))
        .await;
        assert!(updated);

        let written_config = fs::read_to_string(&fx.config_path).unwrap();
        assert!(written_config.contains("cli_auth_credentials_store = \"file\""));
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn config_line_edit_replaces_existing_assignment_and_inserts_before_first_section() {
        let fx = WriterFixture::new();
        fx.write_auth(&json!({"auth_mode": "chatgpt", "tokens": {
            "access_token": "a", "refresh_token": "r",
        }}));

        // Existing assignment (any value) is replaced in place.
        fs::write(
            &fx.config_path,
            "model = \"gpt-5.2\"\ncli_auth_credentials_store = \"keyring\"\n\n[tools]\nweb_search = true\n",
        )
        .unwrap();
        assert!(set_codex_cli_active_selection(&selection(&[("accountId", "x")])).await);
        let config = fs::read_to_string(&fx.config_path).unwrap();
        assert_eq!(
            config,
            "model = \"gpt-5.2\"\ncli_auth_credentials_store = \"file\"\n\n[tools]\nweb_search = true\n"
        );

        // No assignment: inserted before the first [section] with a blank line.
        fs::write(
            &fx.config_path,
            "model = \"gpt-5.2\"\n[tools]\nweb_search = true\n",
        )
        .unwrap();
        assert!(set_codex_cli_active_selection(&selection(&[("accountId", "x")])).await);
        let config = fs::read_to_string(&fx.config_path).unwrap();
        assert_eq!(
            config,
            "model = \"gpt-5.2\"\ncli_auth_credentials_store = \"file\"\n\n[tools]\nweb_search = true\n"
        );

        // Idempotent: a second write leaves the file byte-identical.
        assert!(set_codex_cli_active_selection(&selection(&[("accountId", "x")])).await);
        assert_eq!(fs::read_to_string(&fx.config_path).unwrap(), config);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn enforcement_opt_out_skips_the_config_toml_edit() {
        let mut fx = WriterFixture::new();
        fx.sandbox
            .set_var("CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE", "0");
        fx.write_auth(&json!({"auth_mode": "chatgpt", "tokens": {
            "access_token": "a", "refresh_token": "r",
        }}));
        assert!(set_codex_cli_active_selection(&selection(&[("accountId", "x")])).await);
        assert!(!fx.config_path.exists());
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn matches_by_email_preserves_non_record_entries_and_writes_string_expires_at_as_iso() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({
            "accounts": [
                "noise-entry",
                {"accountId": 123, "email": "target@example.com",
                 "expires_at": "1710000000000",
                 "auth": {"tokens": {"access_token": "target-access",
                                      "refresh_token": "target-refresh"}}},
                {"accountId": "acc_other", "email": "other@example.com",
                 "auth": {"tokens": {"access_token": "other-access",
                                      "refresh_token": "other-refresh"}}},
            ],
        }));
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "tokens": {"access_token": "old-access", "id_token": "old-id",
                        "refresh_token": "old-refresh"},
        }));

        let updated =
            set_codex_cli_active_selection(&selection(&[("email", "TARGET@EXAMPLE.COM")])).await;
        assert!(updated);

        let accounts = fx.read_json(&fx.accounts_path);
        assert_eq!(accounts["activeEmail"], "target@example.com");
        assert_eq!(accounts["accounts"][0], "noise-entry");

        let auth = fx.read_json(&fx.auth_path);
        assert_eq!(auth["email"], "target@example.com");
        assert_eq!(auth["tokens"]["access_token"], "target-access");
        assert_eq!(auth["tokens"]["refresh_token"], "target-refresh");
        // new Date(1710000000000).toISOString()
        assert_eq!(auth["last_refresh"], "2024-03-09T16:00:00.000Z");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_false_for_malformed_auth_payload_objects() {
        let fx = WriterFixture::new();
        fs::write(&fx.auth_path, "[]").unwrap();
        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_a"),
            ("accessToken", "access-a"),
            ("refreshToken", "refresh-a"),
        ]))
        .await;
        assert!(!updated);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_false_when_auth_payload_has_no_usable_tokens() {
        let fx = WriterFixture::new();
        fx.write_auth(&json!({"tokens": {}}));
        let updated = set_codex_cli_active_selection(&selection(&[("accountId", "acc_a")])).await;
        assert!(!updated);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_false_when_accounts_payload_cannot_be_parsed() {
        let fx = WriterFixture::new();
        fs::write(&fx.accounts_path, "{ not-json").unwrap();
        let updated = set_codex_cli_active_selection(&selection(&[("accountId", "acc_a")])).await;
        assert!(!updated);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn uses_auth_token_fallback_and_default_auth_mode_when_selected_account_lacks_tokens() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({"accounts": [{"accountId": "acc_a"}]}));
        fx.write_auth(&json!({
            "auth_mode": 123,
            "tokens": {"access_token": "fallback-access",
                        "refresh_token": "fallback-refresh",
                        "id_token": "fallback-id"},
        }));

        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_a"),
            ("email", "fallback@example.com"),
        ]))
        .await;
        assert!(updated);

        let accounts = fx.read_json(&fx.accounts_path);
        assert_eq!(accounts["activeEmail"], "fallback@example.com");

        let auth = fx.read_json(&fx.auth_path);
        assert_eq!(auth["auth_mode"], "chatgpt");
        assert_eq!(auth["email"], "fallback@example.com");
        assert_eq!(auth["tokens"]["access_token"], "fallback-access");
        assert_eq!(auth["tokens"]["refresh_token"], "fallback-refresh");
        assert_eq!(auth["tokens"]["id_token"], "fallback-id");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn writes_auth_from_explicit_selection_when_persisted_tokens_payload_is_not_an_object() {
        let fx = WriterFixture::new();
        fx.write_auth(&json!({"auth_mode": "chatgpt", "tokens": []}));

        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_direct"),
            ("email", "direct@example.com"),
            ("accessToken", "direct-access"),
            ("refreshToken", "direct-refresh"),
        ]))
        .await;
        assert!(updated);

        let auth = fx.read_json(&fx.auth_path);
        assert_eq!(auth["email"], "direct@example.com");
        assert_eq!(auth["tokens"]["account_id"], "acc_direct");
        assert_eq!(auth["tokens"]["access_token"], "direct-access");
        assert_eq!(auth["tokens"]["id_token"], "direct-access");
        assert_eq!(auth["tokens"]["refresh_token"], "direct-refresh");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn falls_back_id_token_to_selected_access_token_when_id_token_is_missing() {
        let fx = WriterFixture::new();
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "email": "old@example.com",
            "tokens": {"access_token": "old-access", "refresh_token": "old-refresh",
                        "id_token": "old-id-token"},
        }));

        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_new"),
            ("email", "new@example.com"),
            ("accessToken", "new-access"),
            ("refreshToken", "new-refresh"),
        ]))
        .await;
        assert!(updated);

        let auth = fx.read_json(&fx.auth_path);
        assert_eq!(auth["email"], "new@example.com");
        assert_eq!(auth["tokens"]["account_id"], "acc_new");
        assert_eq!(auth["tokens"]["access_token"], "new-access");
        assert_eq!(auth["tokens"]["refresh_token"], "new-refresh");
        // Full new pair → id_token re-anchors to the NEW access token, not the
        // stale persisted one.
        assert_eq!(auth["tokens"]["id_token"], "new-access");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn enriches_active_accounts_entry_with_complete_token_payload_including_id_token() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com"},
                {"accountId": "acc_b", "email": "b@example.com"},
            ],
        }));
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "tokens": {"access_token": "old-access", "refresh_token": "old-refresh",
                        "id_token": "old-id"},
        }));

        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_b"),
            ("email", "B@EXAMPLE.COM"),
            ("accessToken", "fresh-access"),
            ("refreshToken", "fresh-refresh"),
        ]))
        .await;
        assert!(updated);

        let accounts = fx.read_json(&fx.accounts_path);
        let active = accounts["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["active"] == Value::Bool(true))
            .expect("active entry");
        assert_eq!(active["accountId"], "acc_b");
        assert_eq!(active["email"], "b@example.com");
        assert_eq!(active["auth"]["tokens"]["access_token"], "fresh-access");
        assert_eq!(active["auth"]["tokens"]["refresh_token"], "fresh-refresh");
        assert_eq!(active["auth"]["tokens"]["id_token"], "fresh-access");
        // The other entry gets the triple-written inactive flags.
        let inactive = &accounts["accounts"][0];
        assert_eq!(inactive["active"], Value::Bool(false));
        assert_eq!(inactive["isActive"], Value::Bool(false));
        assert_eq!(inactive["is_active"], Value::Bool(false));
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn surfaces_auth_path_errors_when_accounts_file_is_absent() {
        let fx = WriterFixture::new();
        fs::write(&fx.auth_path, "{not-json").unwrap();
        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_only_auth"),
            ("accessToken", "a"),
            ("refreshToken", "r"),
        ]))
        .await;
        assert!(!updated);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn rejects_partial_token_payloads_to_avoid_mixing_stale_auth_tokens() {
        let fx = WriterFixture::new();
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "tokens": {"access_token": "old-access", "refresh_token": "old-refresh",
                        "account_id": "old-account"},
        }));
        let before = fs::read_to_string(&fx.auth_path).unwrap();

        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_partial"),
            ("email", "partial@example.com"),
            ("accessToken", "new-access-only"),
        ]))
        .await;
        assert!(!updated);

        let after = fs::read_to_string(&fx.auth_path).unwrap();
        assert_eq!(after, before, "partial pair must not half-update auth.json");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn still_updates_auth_json_when_accounts_json_has_no_match() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({
            "accounts": [{"accountId": "acc_a", "email": "a@example.com",
                           "auth": {"tokens": {"access_token": "access-a",
                                                "refresh_token": "refresh-a"}}}],
        }));
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {"access_token": "old-access", "id_token": "old-id-token",
                        "refresh_token": "old-refresh", "account_id": "old-account"},
        }));

        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "missing-account"),
            ("email", "b@example.com"),
            ("accessToken", "fresh-access"),
            ("refreshToken", "fresh-refresh"),
        ]))
        .await;
        assert!(updated);

        let auth = fx.read_json(&fx.auth_path);
        assert_eq!(auth["email"], "b@example.com");
        assert_eq!(auth["tokens"]["access_token"], "fresh-access");
        assert_eq!(auth["tokens"]["id_token"], "fresh-access");
        assert_eq!(auth["tokens"]["refresh_token"], "fresh-refresh");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn does_not_update_auth_json_when_no_match_and_selection_lacks_tokens() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({
            "accounts": [{"accountId": "acc_a", "email": "a@example.com",
                           "auth": {"tokens": {"access_token": "access-a",
                                                "refresh_token": "refresh-a"}}}],
        }));
        fx.write_auth(&json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {"access_token": "old-access", "id_token": "old-id-token",
                        "refresh_token": "old-refresh", "account_id": "old-account"},
        }));
        let before = fs::read_to_string(&fx.auth_path).unwrap();

        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "missing-account"),
            ("email", "b@example.com"),
        ]))
        .await;
        assert!(!updated);
        assert_eq!(fs::read_to_string(&fx.auth_path).unwrap(), before);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_false_when_writer_sync_is_disabled() {
        let mut fx = WriterFixture::new();
        fx.sandbox.set_var("CODEX_MULTI_AUTH_SYNC_CODEX_CLI", "0");
        fx.write_accounts(&json!({
            "accounts": [{"accountId": "acc_a", "email": "a@example.com",
                           "auth": {"tokens": {"access_token": "a.b.c",
                                                "refresh_token": "refresh-a"}}}],
        }));
        let updated = set_codex_cli_active_selection(&selection(&[("accountId", "acc_a")])).await;
        assert!(!updated);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_false_for_malformed_writer_payload() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({"accounts": {"accountId": "acc_a"}}));
        let updated = set_codex_cli_active_selection(&selection(&[("accountId", "acc_a")])).await;
        assert!(!updated);
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_false_when_auth_state_exists_but_cannot_be_persisted() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com",
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
                {"accountId": "acc_b", "email": "b@example.com",
                 "auth": {"tokens": {"access_token": "x.y.z", "refresh_token": "refresh-b"}}},
            ],
        }));
        fs::write(&fx.auth_path, stringify_pretty2(&json!([]))).unwrap();

        let updated = set_codex_cli_active_selection(&selection(&[("accountId", "acc_b")])).await;
        assert!(!updated);

        // The accounts write itself still landed before the auth failure.
        let accounts = fx.read_json(&fx.accounts_path);
        assert_eq!(accounts["activeAccountId"], "acc_b");
        assert_eq!(accounts["activeEmail"], "b@example.com");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn persists_active_selection_by_email_match_when_account_id_is_omitted() {
        let fx = WriterFixture::new();
        fx.write_accounts(&json!({
            "accounts": [
                {"accountId": "acc_a", "email": "a@example.com",
                 "auth": {"tokens": {"access_token": "a.b.c", "refresh_token": "refresh-a"}}},
                {"accountId": "acc_b", "email": "b@example.com",
                 "auth": {"tokens": {"access_token": "x.y.z", "refresh_token": "refresh-b"}}},
            ],
        }));

        let updated =
            set_codex_cli_active_selection(&selection(&[("email", "B@EXAMPLE.COM")])).await;
        assert!(updated);
        let accounts = fx.read_json(&fx.accounts_path);
        assert_eq!(accounts["activeAccountId"], "acc_b");
        assert_eq!(accounts["activeEmail"], "b@example.com");
        drop(fx);
    }

    #[tokio::test]
    #[serial(env)]
    async fn write_timestamp_is_the_monotonic_max_of_stamps_written_this_process() {
        let fx = WriterFixture::new();
        let before = get_last_codex_cli_selection_write_timestamp();
        let updated = set_codex_cli_active_selection(&selection(&[
            ("accountId", "acc_new"),
            ("accessToken", "a"),
            ("refreshToken", "r"),
        ]))
        .await;
        assert!(updated);
        let after = get_last_codex_cli_selection_write_timestamp();
        assert!(after >= before);
        assert!(after > 0);
        drop(fx);
    }

    #[test]
    fn iso_time_formatting_matches_node_to_iso_string() {
        assert_eq!(epoch_ms_to_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(epoch_ms_to_iso(1_710_000_000_000), "2024-03-09T16:00:00.000Z");
        assert_eq!(epoch_ms_to_iso(1_750_003_600_000), "2025-06-15T16:06:40.000Z");
        // Non-finite / non-positive expiresAt falls back to "now" (only shape
        // is asserted — the value is clock-dependent).
        let now_iso = to_iso_time(None);
        assert_eq!(now_iso.len(), 24);
        assert!(now_iso.ends_with('Z'));
        assert_eq!(to_iso_time(Some(1_710_000_000_000.0)), "2024-03-09T16:00:00.000Z");
        assert_eq!(to_iso_time(Some(0.0)).len(), 24);
    }

    // -----------------------------------------------------------------------
    // Golden byte tests — reproduce crates/testkit/goldens/generate.mjs
    // scenario 15+16 exactly, then normalize only the clock-stamped field.
    // -----------------------------------------------------------------------

    const T0: i64 = 1_750_000_000_000;
    const EXPIRES_AT: f64 = 1_750_003_600_000.0;

    #[tokio::test]
    #[serial(env)]
    async fn golden_mirror_write_matches_ts_byte_output() {
        let fx = WriterFixture::new();
        // Seeded INPUT from generate.mjs: a pre-existing Codex CLI
        // accounts.json with stale tokens and account two active.
        fx.write_accounts(&json!({
            "accounts": [
                {
                    "accountId": "acct-user-one",
                    "email": "user.one@example.com",
                    "access_token": "at-old-cli-one",
                    "refresh_token": "rt-old-cli-one",
                    "id_token": "idt-old-cli-one",
                    "active": false,
                },
                {
                    "accountId": "acct-user-two",
                    "email": "user.two@example.com",
                    "access_token": "at-old-cli-two",
                    "refresh_token": "rt-old-cli-two",
                    "id_token": "idt-old-cli-two",
                    "active": true,
                },
            ],
            "activeAccountId": "acct-user-two",
            "active_account_id": "acct-user-two",
        }));

        let wrote = set_codex_cli_active_selection(&ActiveSelection {
            account_id: Some("acct-user-one".to_string()),
            email: Some("user.one@example.com".to_string()),
            access_token: Some("at-fixture-account-one-0000000001".to_string()),
            refresh_token: Some("rt-fixture-account-one-0000000001".to_string()),
            expires_at: Some(EXPIRES_AT),
            id_token: Some("idt-fixture-account-one-0000000001".to_string()),
        })
        .await;
        assert!(wrote, "setCodexCliActiveSelection reported failure");

        // Post-process exactly like the generator: replace the Date.now()
        // stamp with T0, re-serialize with the same serializer, byte-compare.
        let mut accounts: Value =
            serde_json::from_str(&fs::read_to_string(&fx.accounts_path).unwrap()).unwrap();
        accounts["codexMultiAuthSyncVersion"] = json!(T0);
        assert_golden_str("codex-cli-accounts.json", &stringify_pretty2(&accounts));

        let mut auth: Value =
            serde_json::from_str(&fs::read_to_string(&fx.auth_path).unwrap()).unwrap();
        auth["codexMultiAuthSyncVersion"] = json!(T0);
        assert_golden_str("codex-cli-auth.json", &stringify_pretty2(&auth));
        drop(fx);
    }
}
