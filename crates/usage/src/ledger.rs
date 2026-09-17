//! Port of `lib/usage/ledger.ts` — JSONL append-only ledger with a
//! cross-process lock file, read/summarize/rotate.
//!
//! Behavior source: specs/11-cli-usage-recovery.md §5.4. Key contracts:
//! - Paths are RECOMPUTED on every call (env can change under tests).
//! - Cross-process lock = `{current}.lock` created with O_EXCL (`create_new`),
//!   stale after 30 s (mtime), max wait 10 s → `Timed out waiting for usage
//!   ledger lock: {path}`.
//! - In-process serialization: appends and rotates share one FIFO queue.
//! - Read-side validation is STRICTER than write-side
//!   ([`normalize_parsed_usage_row`]): rows missing `version: 1`, a non-empty
//!   `id`, a finite `createdAt`, or a `tokens` record are dropped silently.
//! - Rotation renames to `usage-ledger.<stamp>.jsonl` where the stamp is the
//!   ISO timestamp with `-`/`:` removed and the FIRST `.` removed
//!   (`20260102T030405006Z`).
//! - Bucket `costUsd` re-rounds through `Number(x.toFixed(8))` at EVERY
//!   accumulation step ([`crate::pricing::js_to_fixed_8`]).

use std::fs;
use std::io;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde_json::Value;

use cma_core::fs_retry::{Backoff, RetryOptions, code_of, with_retry};
use cma_core::json_io::{file_mtime_ms, read_text_file, stringify_compact};
use cma_core::logger::log_warn;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::utils::{now_ms, sleep};

use crate::pricing::js_to_fixed_8;
use crate::redaction::{normalize_usage_ledger_row, usage_row_to_json_line};
use crate::types::{
    UsageLedgerAccountRef, UsageLedgerAppendInput, UsageLedgerOperation, UsageLedgerOutcome,
    UsageLedgerPaths, UsageLedgerQuery, UsageLedgerRow, UsageLedgerSource, UsageSummary,
    UsageSummaryBucket, UsageSummaryGroupBy, UsageSummaryQuery, UsageTokenCounts, js_trim,
};

const USAGE_DIR_NAME: &str = "usage";
const USAGE_LEDGER_FILE_NAME: &str = "usage-ledger.jsonl";
const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];
/// EEXIST is what a held lock produces on `create_new`.
const LOCK_RETRYABLE_FS_CODES: &[&str] = &["EACCES", "EBUSY", "EEXIST", "EPERM"];
const LOCK_STALE_MS: f64 = 30_000.0;
const LOCK_MAX_WAIT_MS: i64 = 10_000;

/// In-process append/rotate serialization (the TS module promise chain).
/// tokio's Mutex is fair FIFO, matching the chained-promise ordering.
static APPEND_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// TS `resetUsageLedgerQueueForTests` re-armed a possibly-rejected promise
/// chain; the tokio mutex cannot be poisoned by a failed task, so this is a
/// no-op kept for API parity.
pub fn reset_usage_ledger_queue_for_tests() {}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// `getUsageLedgerPaths` — `<multiAuthDir>/usage/usage-ledger.jsonl`.
/// Recomputed on every call — never cache at module load.
pub fn get_usage_ledger_paths() -> UsageLedgerPaths {
    let dir = get_codex_multi_auth_dir().join(USAGE_DIR_NAME);
    let current = dir.join(USAGE_LEDGER_FILE_NAME);
    UsageLedgerPaths { dir, current }
}

fn lock_path_for(current: &Path) -> PathBuf {
    let mut os = current.as_os_str().to_os_string();
    os.push(".lock");
    PathBuf::from(os)
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn make_ledger_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

// ---------------------------------------------------------------------------
// Retry helpers (per-site schedules copied from the TS source)
// ---------------------------------------------------------------------------

/// TS backoff `10 * 2 ** attempt` with a 0-based attempt index == our
/// 1-based `10 * 2^(n-1)` → 10/20/40/80 ms between the 5 attempts.
fn ledger_backoff() -> Backoff {
    Backoff::from_fn(|attempt| 10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1))))
}

fn retry_options() -> RetryOptions<io::Error> {
    RetryOptions::new(5, ledger_backoff()).with_codes(RETRYABLE_FS_CODES)
}

/// `unlinkWithRetry` — ENOENT is success; EBUSY/EPERM retried ×5.
async fn unlink_with_retry(path: &Path) -> io::Result<()> {
    with_retry(
        || async {
            match fs::remove_file(path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                result => result,
            }
        },
        retry_options(),
    )
    .await
}

async fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    with_retry(|| async { fs::rename(from, to) }, retry_options()).await
}

async fn read_file_with_retry(path: &Path) -> io::Result<String> {
    // Node `readFile(path, "utf8")` decodes lossily; `read_text_file` matches.
    with_retry(|| async { read_text_file(path) }, retry_options()).await
}

// ---------------------------------------------------------------------------
// Cross-process append lock
// ---------------------------------------------------------------------------

struct AppendLock {
    lock_path: PathBuf,
    file: Option<fs::File>,
    released: bool,
}

impl AppendLock {
    /// Idempotent release: close the handle (drop — Rust cannot observe or
    /// retry close failures the way the TS handle.close() loop did), then
    /// unlink the lock with retry.
    async fn release(&mut self) -> io::Result<()> {
        if self.released {
            return Ok(());
        }
        self.released = true;
        drop(self.file.take());
        unlink_with_retry(&self.lock_path).await
    }
}

impl Drop for AppendLock {
    fn drop(&mut self) {
        // Panic-safety net only — every non-panicking path calls release().
        if !self.released {
            self.released = true;
            drop(self.file.take());
            let _ = fs::remove_file(&self.lock_path);
        }
    }
}

fn is_lock_retryable(error: &io::Error) -> bool {
    matches!(code_of(error), Some(code) if LOCK_RETRYABLE_FS_CODES.contains(&code))
}

/// One O_EXCL claim attempt: create the lock file exclusively and write the
/// `{"pid":…,"createdAt":…}` metadata line. On failure returns the handle (if
/// one was opened) so the caller can clean up, plus the error.
fn try_create_lock(lock_path: &Path) -> Result<AppendLock, (Option<fs::File>, io::Error)> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = match options.open(lock_path) {
        Ok(file) => file,
        Err(error) => return Err((None, error)),
    };
    let metadata = format!(
        "{}\n",
        stringify_compact(&serde_json::json!({
            "pid": std::process::id(),
            "createdAt": now_ms(),
        }))
    );
    if let Err(error) = file.write_all(metadata.as_bytes()) {
        return Err((Some(file), error));
    }
    Ok(AppendLock {
        lock_path: lock_path.to_path_buf(),
        file: Some(file),
        released: false,
    })
}

/// `removeStaleLockIfNeeded` — leave locks younger than 30 s alone; unlink
/// older ones. A missing lock counts as removed.
async fn remove_stale_lock_if_needed(lock_path: &Path) -> io::Result<bool> {
    match file_mtime_ms(lock_path)? {
        Some(mtime_ms) => {
            if (now_ms() as f64) - mtime_ms < LOCK_STALE_MS {
                return Ok(false);
            }
            unlink_with_retry(lock_path).await?;
            Ok(true)
        }
        None => Ok(true),
    }
}

/// `acquireAppendLock` — O_EXCL create loop with stale takeover (30 s) and a
/// 10 s wait budget.
async fn acquire_append_lock(lock_path: &Path) -> io::Result<AppendLock> {
    let started = now_ms();
    let mut attempt: u32 = 0;
    loop {
        match try_create_lock(lock_path) {
            Ok(lock) => return Ok(lock),
            Err((opened_handle, error)) => {
                if let Some(handle) = opened_handle {
                    // Best-effort cleanup after a failed lock metadata write
                    // (close is swallowed; the unlink error propagates, as in
                    // the TS catch block).
                    drop(handle);
                    unlink_with_retry(lock_path).await?;
                }
                if !is_lock_retryable(&error) {
                    return Err(error);
                }
                remove_stale_lock_if_needed(lock_path).await?;
                if now_ms() - started >= LOCK_MAX_WAIT_MS {
                    return Err(io::Error::other(format!(
                        "Timed out waiting for usage ledger lock: {}",
                        lock_path.display()
                    )));
                }
                sleep(
                    250u64.min(10u64.saturating_mul(2u64.saturating_pow(attempt.min(5)))),
                )
                .await;
                attempt += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

fn append_line(path: &Path, line: &str) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Applied only when the file is created — Node appendFile parity.
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(line.as_bytes())
}

/// `appendFileWithRetry` — lock, append (retry EBUSY/EPERM ×5), release in a
/// finally. A release failure overrides the body result (JS finally-throw
/// semantics).
async fn append_file_with_retry(path: &Path, line: &str) -> io::Result<()> {
    let mut lock = acquire_append_lock(&lock_path_for(path)).await?;
    let result = with_retry(|| async { append_line(path, line) }, retry_options()).await;
    let release_result = lock.release().await;
    release_result?;
    result
}

/// `appendUsageLedgerRow` — normalize, serialize (single compact JSONL line),
/// then append under both the in-process queue and the cross-process lock.
/// Returns the normalized row.
pub async fn append_usage_ledger_row(
    input: &UsageLedgerAppendInput,
) -> io::Result<UsageLedgerRow> {
    let row = normalize_usage_ledger_row(input);
    let paths = get_usage_ledger_paths();
    let line = usage_row_to_json_line(&row);
    {
        let _queue = APPEND_QUEUE.lock().await;
        make_ledger_dir(&paths.dir)?;
        append_file_with_retry(&paths.current, &line).await?;
    }
    Ok(row)
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

fn value_as_finite_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|v| v.is_finite())
}

fn value_as_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn parsed_token_count(tokens: &Value, key: &str) -> u64 {
    match value_as_finite_f64(tokens.get(key)) {
        Some(numeric) => {
            let truncated = numeric.trunc();
            if truncated <= 0.0 { 0 } else { truncated as u64 }
        }
        None => 0,
    }
}

/// `normalizeParsedUsageRow` — read-side validation, STRICTER than write-side:
/// requires `version === 1`, a non-empty string `id`, a finite `createdAt`
/// and a `tokens` record; otherwise the row is dropped (`None`, silent).
pub fn normalize_parsed_usage_row(value: &Value) -> Option<UsageLedgerRow> {
    if !value.is_object() {
        return None;
    }
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let id = value.get("id").and_then(Value::as_str)?;
    if js_trim(id).is_empty() {
        return None;
    }
    let created_at = value_as_finite_f64(value.get("createdAt"))?;
    let tokens_value = value.get("tokens").filter(|t| t.is_object())?;

    let source = value
        .get("source")
        .and_then(Value::as_str)
        .and_then(UsageLedgerSource::parse)
        .unwrap_or(UsageLedgerSource::Unknown);
    let operation = value
        .get("operation")
        .and_then(Value::as_str)
        .and_then(UsageLedgerOperation::parse)
        .unwrap_or(UsageLedgerOperation::Unknown);
    let outcome = value
        .get("outcome")
        .and_then(Value::as_str)
        .and_then(UsageLedgerOutcome::parse)
        .unwrap_or(UsageLedgerOutcome::Failure);
    let tokens = UsageTokenCounts {
        input_tokens: parsed_token_count(tokens_value, "inputTokens"),
        output_tokens: parsed_token_count(tokens_value, "outputTokens"),
        cached_input_tokens: parsed_token_count(tokens_value, "cachedInputTokens"),
        reasoning_tokens: parsed_token_count(tokens_value, "reasoningTokens"),
        total_tokens: parsed_token_count(tokens_value, "totalTokens"),
    };
    let account = value
        .get("account")
        .filter(|a| a.is_object())
        .map(|a| UsageLedgerAccountRef {
            account_hash: value_as_string(a.get("accountHash"))
                .filter(|hash| hash.starts_with("sha256:")),
            email_hash: value_as_string(a.get("emailHash"))
                .filter(|hash| hash.starts_with("sha256:")),
            index: value_as_finite_f64(a.get("index"))
                .filter(|v| v.fract() == 0.0 && *v >= 0.0)
                .map(|v| v as u64),
        })
        .filter(|a| a.account_hash.is_some() || a.email_hash.is_some() || a.index.is_some());

    Some(UsageLedgerRow {
        version: 1,
        id: id.to_string(),
        created_at,
        source,
        operation,
        outcome,
        model: value_as_string(value.get("model")),
        project_key: value_as_string(value.get("projectKey")),
        account,
        request_id: value_as_string(value.get("requestId")),
        status_code: value_as_finite_f64(value.get("statusCode"))
            .filter(|v| v.fract() == 0.0 && (100.0..=599.0).contains(v))
            .map(|v| v as u16),
        error_code: value_as_string(value.get("errorCode")),
        duration_ms: value_as_finite_f64(value.get("durationMs")).map(|v| {
            let truncated = v.trunc();
            if truncated <= 0.0 { 0 } else { truncated as u64 }
        }),
        tokens,
        cost_usd: value_as_finite_f64(value.get("costUsd")).map(|v| v.max(0.0)),
    })
}

fn parse_jsonl_rows(content: &str, label: &str) -> Vec<UsageLedgerRow> {
    let mut rows = Vec::new();
    for (index, line) in content.split('\n').enumerate() {
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(parsed) => {
                if let Some(row) = normalize_parsed_usage_row(&parsed) {
                    rows.push(row);
                }
            }
            Err(error) => {
                log_warn(
                    &format!(
                        "Skipped malformed usage ledger row in {label}:{}: {error}",
                        index + 1
                    ),
                    None,
                );
            }
        }
    }
    rows
}

/// The archive-name filter: `^usage-ledger(?:\.\d{8}T\d{6}\d{3}Z)?\.jsonl$`.
fn is_ledger_file_name(name: &str) -> bool {
    if name == USAGE_LEDGER_FILE_NAME {
        return true;
    }
    let Some(rest) = name.strip_prefix("usage-ledger.") else {
        return false;
    };
    let Some(stamp) = rest.strip_suffix(".jsonl") else {
        return false;
    };
    let bytes = stamp.as_bytes();
    bytes.len() == 19
        && bytes[8] == b'T'
        && bytes[18] == b'Z'
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[9..18].iter().all(u8::is_ascii_digit)
}

fn list_ledger_files(include_archives: bool) -> io::Result<Vec<PathBuf>> {
    let UsageLedgerPaths { dir, current } = get_usage_ledger_paths();
    if !include_archives {
        return Ok(if current.exists() { vec![current] } else { vec![] });
    }
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_ledger_file_name(name))
        .collect();
    names.sort();
    Ok(names.into_iter().map(|name| dir.join(name)).collect())
}

fn normalize_timestamp(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite())
}

fn row_in_range(row: &UsageLedgerRow, since: Option<f64>, until: Option<f64>) -> bool {
    if let Some(since) = since
        && row.created_at < since
    {
        return false;
    }
    if let Some(until) = until
        && row.created_at > until
    {
        return false;
    }
    true
}

/// `readUsageLedgerRows` — per-file read failures are warned and skipped;
/// malformed lines are warned and skipped; invalid rows are dropped silently.
/// Result is filtered by `since`/`until` (inclusive) and sorted ascending by
/// `createdAt` (stable).
pub async fn read_usage_ledger_rows(query: &UsageLedgerQuery) -> io::Result<Vec<UsageLedgerRow>> {
    let mut rows: Vec<UsageLedgerRow> = Vec::new();
    for file in list_ledger_files(query.include_archives)? {
        match read_file_with_retry(&file).await {
            Ok(content) => rows.extend(parse_jsonl_rows(&content, &basename(&file))),
            Err(error) => {
                log_warn(
                    &format!("Failed to read usage ledger {}: {error}", basename(&file)),
                    None,
                );
            }
        }
    }
    let since = normalize_timestamp(query.since);
    let until = normalize_timestamp(query.until);
    rows.retain(|row| row_in_range(row, since, until));
    rows.sort_by(|a, b| a.created_at.total_cmp(&b.created_at));
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

fn create_bucket(key: String) -> UsageSummaryBucket {
    UsageSummaryBucket {
        key,
        requests: 0,
        successes: 0,
        failures: 0,
        blocked: 0,
        cancelled: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        cost_usd: 0.0,
    }
}

fn get_bucket_key(row: &UsageLedgerRow, by: UsageSummaryGroupBy) -> String {
    match by {
        UsageSummaryGroupBy::Account => row
            .account
            .as_ref()
            .and_then(|account| {
                account
                    .account_hash
                    .clone()
                    .or_else(|| account.email_hash.clone())
            })
            .unwrap_or_else(|| "unknown".to_string()),
        UsageSummaryGroupBy::Project => row
            .project_key
            .clone()
            .unwrap_or_else(|| "global".to_string()),
        UsageSummaryGroupBy::Outcome => row.outcome.as_str().to_string(),
        UsageSummaryGroupBy::Day => js_to_iso_string(row.created_at)
            .map(|iso| iso[..10].to_string())
            // TS would throw RangeError for timestamps outside the JS Date
            // range (±8.64e15 ms); such rows are pathological — bucket them
            // as "unknown" instead of failing the whole summary.
            .unwrap_or_else(|| "unknown".to_string()),
        UsageSummaryGroupBy::Model => row
            .model
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
    }
}

fn add_row_to_bucket(bucket: &mut UsageSummaryBucket, row: &UsageLedgerRow) {
    bucket.requests += 1;
    match row.outcome {
        UsageLedgerOutcome::Success => bucket.successes += 1,
        UsageLedgerOutcome::Failure => bucket.failures += 1,
        UsageLedgerOutcome::Blocked => bucket.blocked += 1,
        UsageLedgerOutcome::Cancelled => bucket.cancelled += 1,
    }
    bucket.input_tokens = bucket.input_tokens.saturating_add(row.tokens.input_tokens);
    bucket.output_tokens = bucket.output_tokens.saturating_add(row.tokens.output_tokens);
    bucket.cached_input_tokens = bucket
        .cached_input_tokens
        .saturating_add(row.tokens.cached_input_tokens);
    bucket.reasoning_tokens = bucket
        .reasoning_tokens
        .saturating_add(row.tokens.reasoning_tokens);
    bucket.total_tokens = bucket.total_tokens.saturating_add(row.tokens.total_tokens);
    // Re-rounded to 8 dp at EVERY add — part of the TS numeric contract.
    bucket.cost_usd = js_to_fixed_8(bucket.cost_usd + row.cost_usd.unwrap_or(0.0));
}

/// `summarizeUsageRows` — filter + sort again, accumulate totals and per-key
/// buckets, buckets sorted by key.
pub fn summarize_usage_rows(rows: &[UsageLedgerRow], query: &UsageSummaryQuery) -> UsageSummary {
    let by = query.by.unwrap_or_default();
    let since = normalize_timestamp(query.since);
    let until = normalize_timestamp(query.until);
    let mut filtered: Vec<&UsageLedgerRow> = rows
        .iter()
        .filter(|row| row_in_range(row, since, until))
        .collect();
    filtered.sort_by(|a, b| a.created_at.total_cmp(&b.created_at));

    let mut totals = create_bucket("total".to_string());
    let mut buckets: Vec<UsageSummaryBucket> = Vec::new();
    for row in filtered {
        add_row_to_bucket(&mut totals, row);
        let key = get_bucket_key(row, by);
        match buckets.iter_mut().find(|bucket| bucket.key == key) {
            Some(bucket) => add_row_to_bucket(bucket, row),
            None => {
                let mut bucket = create_bucket(key);
                add_row_to_bucket(&mut bucket, row);
                buckets.push(bucket);
            }
        }
    }
    // TS sorts with localeCompare; ledger keys are ASCII (hashes, model ids,
    // ISO dates, "unknown"/"global"), where byte order coincides.
    buckets.sort_by(|a, b| a.key.cmp(&b.key));

    UsageSummary {
        since,
        until,
        by,
        totals,
        buckets,
    }
}

/// `summarizeUsageLedger` — read + summarize.
pub async fn summarize_usage_ledger(query: &UsageSummaryQuery) -> io::Result<UsageSummary> {
    let rows = read_usage_ledger_rows(&query.ledger_query()).await?;
    Ok(summarize_usage_rows(&rows, query))
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/// Options for [`rotate_usage_ledger`].
#[derive(Debug, Clone, Copy, Default)]
pub struct RotateUsageLedgerOptions {
    /// Timestamp for the archive stamp (epoch ms); defaults to now.
    pub now: Option<f64>,
    /// Skip rotation when the current ledger is at most this many bytes.
    pub if_larger_than_bytes: Option<u64>,
}

async fn rotate_locked(
    paths: &UsageLedgerPaths,
    options: &RotateUsageLedgerOptions,
) -> io::Result<Option<PathBuf>> {
    if !paths.current.exists() {
        return Ok(None);
    }
    let metadata = fs::metadata(&paths.current)?;
    if let Some(threshold) = options.if_larger_than_bytes
        && metadata.len() <= threshold
    {
        return Ok(None);
    }
    let now = options.now.unwrap_or_else(|| now_ms() as f64);
    let iso = js_to_iso_string(now)
        .ok_or_else(|| io::Error::other("Invalid time value"))?;
    // `.replace(/[-:]/g, "")` then `.replace(".", "")` (FIRST dot only — the
    // millisecond separator).
    let mut stamp: String = iso.chars().filter(|c| !matches!(c, '-' | ':')).collect();
    if let Some(dot) = stamp.find('.') {
        stamp.remove(dot);
    }
    let rotated = paths.dir.join(format!("usage-ledger.{stamp}.jsonl"));
    rename_with_retry(&paths.current, &rotated).await?;
    Ok(Some(rotated))
}

/// `rotateUsageLedger` — queued + locked rename of the current ledger to
/// `usage-ledger.<stamp>.jsonl`; `None` when there is nothing to rotate or
/// the size threshold is not exceeded.
pub async fn rotate_usage_ledger(
    options: &RotateUsageLedgerOptions,
) -> io::Result<Option<PathBuf>> {
    let paths = get_usage_ledger_paths();
    let _queue = APPEND_QUEUE.lock().await;
    make_ledger_dir(&paths.dir)?;
    let mut lock = acquire_append_lock(&lock_path_for(&paths.current)).await?;
    let result = rotate_locked(&paths, options).await;
    let release_result = lock.release().await;
    release_result?;
    result
}

// ---------------------------------------------------------------------------
// ECMAScript Date.prototype.toISOString
// ---------------------------------------------------------------------------

/// `new Date(ms).toISOString()` — `None` where JS throws (non-finite input or
/// |time| > 8.64e15 after truncation toward zero). Years outside 0000–9999
/// use the JS expanded-year form (`±YYYYYY`).
fn js_to_iso_string(ms: f64) -> Option<String> {
    if !ms.is_finite() {
        return None;
    }
    let time = ms.trunc();
    if time.abs() > 8.64e15 {
        return None;
    }
    let time = time as i64;
    let days = time.div_euclid(86_400_000);
    let ms_of_day = time.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let hours = ms_of_day / 3_600_000;
    let minutes = (ms_of_day % 3_600_000) / 60_000;
    let seconds = (ms_of_day % 60_000) / 1_000;
    let millis = ms_of_day % 1_000;
    let year_part = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year_part}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z"
    ))
}

/// Days-since-epoch → proleptic Gregorian civil date (Howard Hinnant's
/// `civil_from_days`, exact for the whole JS Date range).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------
// Tests (ported from test/usage-ledger.test.ts)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn append_input(id: &str, created_at: f64, outcome: &str, model: Option<&str>) -> UsageLedgerAppendInput {
        UsageLedgerAppendInput {
            id: Some(id.to_string()),
            created_at: Some(created_at),
            outcome: Some(outcome.to_string()),
            model: model.map(str::to_string),
            ..Default::default()
        }
    }

    fn set_lock_mtime_stale(lock_path: &Path) {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(lock_path)
            .expect("open lock for utimes");
        file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60))
            .expect("set stale mtime");
    }

    // ----- pure helpers -----

    #[test]
    fn iso_string_matches_ecmascript_to_iso_string() {
        assert_eq!(js_to_iso_string(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(js_to_iso_string(-1.0).unwrap(), "1969-12-31T23:59:59.999Z");
        // Date.UTC(2026, 0, 2, 3, 4, 5, 6)
        assert_eq!(
            js_to_iso_string(1_767_323_045_006.0).unwrap(),
            "2026-01-02T03:04:05.006Z"
        );
        assert_eq!(js_to_iso_string(f64::NAN), None);
        assert_eq!(js_to_iso_string(8.641e15), None);
    }

    #[test]
    fn ledger_file_name_filter_matches_the_ts_regex() {
        assert!(is_ledger_file_name("usage-ledger.jsonl"));
        assert!(is_ledger_file_name("usage-ledger.20260102T030405006Z.jsonl"));
        assert!(!is_ledger_file_name("usage-ledger.20260102T030405006Z.jsonl.lock"));
        assert!(!is_ledger_file_name("usage-ledger.2026T030405006Z.jsonl"));
        assert!(!is_ledger_file_name("usage-ledger.20260102X030405006Z.jsonl"));
        assert!(!is_ledger_file_name("other-file.jsonl"));
        assert!(!is_ledger_file_name("usage-ledger..jsonl"));
    }

    #[test]
    fn parsed_row_validation_is_stricter_than_write_side() {
        // version must be 1
        assert!(normalize_parsed_usage_row(&serde_json::json!({
            "version": 2, "id": "x", "createdAt": 1, "tokens": {}
        }))
        .is_none());
        // id must be a non-empty string
        assert!(normalize_parsed_usage_row(&serde_json::json!({
            "version": 1, "id": "  ", "createdAt": 1, "tokens": {}
        }))
        .is_none());
        // createdAt must be a finite number
        assert!(normalize_parsed_usage_row(&serde_json::json!({
            "version": 1, "id": "x", "createdAt": "soon", "tokens": {}
        }))
        .is_none());
        // tokens must be a record
        assert!(normalize_parsed_usage_row(&serde_json::json!({
            "version": 1, "id": "x", "createdAt": 1, "tokens": 5
        }))
        .is_none());

        let row = normalize_parsed_usage_row(&serde_json::json!({
            "version": 1,
            "id": "x",
            "createdAt": 1,
            "source": "not-a-source",
            "operation": "responses",
            "outcome": "nope",
            "tokens": { "inputTokens": 3.9, "outputTokens": -1 },
            "account": {
                "accountHash": "md5:nope",
                "emailHash": "sha256:abc",
                "index": 1.5
            },
            "statusCode": 200,
            "costUsd": -4,
            "durationMs": 12.7
        }))
        .unwrap();
        assert_eq!(row.source, UsageLedgerSource::Unknown);
        assert_eq!(row.operation, UsageLedgerOperation::Responses);
        assert_eq!(row.outcome, UsageLedgerOutcome::Failure);
        assert_eq!(row.tokens.input_tokens, 3);
        assert_eq!(row.tokens.output_tokens, 0);
        let account = row.account.unwrap();
        // Hashes without the sha256: prefix are dropped; fractional index too.
        assert_eq!(account.account_hash, None);
        assert_eq!(account.email_hash, Some("sha256:abc".to_string()));
        assert_eq!(account.index, None);
        assert_eq!(row.status_code, Some(200));
        assert_eq!(row.cost_usd, Some(0.0));
        assert_eq!(row.duration_ms, Some(12));
    }

    // ----- filesystem behavior (EnvSandbox + #[serial(env)]) -----

    #[tokio::test]
    #[serial(env)]
    async fn appends_normalized_jsonl_rows_without_raw_identifiers() {
        let _sandbox = EnvSandbox::new();
        let row = append_usage_ledger_row(&UsageLedgerAppendInput {
            id: Some("row-1".to_string()),
            created_at: Some(1_700_000_000_000.0),
            source: Some("runtime-proxy".to_string()),
            operation: Some("responses".to_string()),
            outcome: Some("success".to_string()),
            model: Some(" gpt-5.3-codex ".to_string()),
            account_id: Some("acct_sensitive_123".to_string()),
            email: Some("Owner@Example.com".to_string()),
            account_index: Some(2.0),
            request_id: Some("req_123".to_string()),
            status_code: Some(200.0),
            duration_ms: Some(123.9),
            input_tokens: Some(1_000.0),
            output_tokens: Some(200.0),
            cached_input_tokens: Some(50.0),
            reasoning_tokens: Some(25.0),
            ..Default::default()
        })
        .await
        .unwrap();

        assert_eq!(row.model.as_deref(), Some("gpt-5.3-codex"));
        let account = row.account.clone().unwrap();
        assert!(account.account_hash.unwrap().starts_with("sha256:"));
        assert!(account.email_hash.unwrap().starts_with("sha256:"));
        assert_eq!(account.index, Some(2));
        assert_eq!(row.tokens.total_tokens, 1_225);
        assert_eq!(row.tokens.cached_input_tokens, 50);
        assert!(row.cost_usd.unwrap() > 0.0);
        assert_eq!(row.duration_ms, Some(123));

        let raw = fs::read_to_string(get_usage_ledger_paths().current).unwrap();
        assert!(raw.contains("\"version\":1"));
        assert!(!raw.contains("acct_sensitive_123"));
        assert!(!raw.contains("Owner@Example.com"));
        assert!(!raw.contains("owner@example.com"));

        let read_back = read_usage_ledger_rows(&UsageLedgerQuery::default())
            .await
            .unwrap();
        assert_eq!(read_back, vec![row]);
    }

    #[tokio::test]
    #[serial(env)]
    async fn append_produces_the_golden_byte_line_on_disk() {
        let _sandbox = EnvSandbox::new();
        append_usage_ledger_row(&UsageLedgerAppendInput {
            id: Some("usage-fixture-0000000000000001".to_string()),
            created_at: Some(1_750_000_000_000.0),
            source: Some("runtime-proxy".to_string()),
            operation: Some("responses".to_string()),
            outcome: Some("success".to_string()),
            model: Some("gpt-5.2".to_string()),
            project_key: Some("my-app-0123456789ab".to_string()),
            account_id: Some("acct-user-one".to_string()),
            email: Some("User.One@Example.com".to_string()),
            account_index: Some(0.0),
            request_id: Some("req-fixture-0001".to_string()),
            status_code: Some(200.0),
            duration_ms: Some(1234.0),
            input_tokens: Some(1200.0),
            output_tokens: Some(350.0),
            cached_input_tokens: Some(800.0),
            reasoning_tokens: Some(64.0),
            cost_usd: Some(0.0123),
            ..Default::default()
        })
        .await
        .unwrap();
        let written = fs::read_to_string(get_usage_ledger_paths().current).unwrap();
        let golden = cma_testkit::goldens::read_golden_string("usage-ledger-row.jsonl")
            .replace("\r\n", "\n");
        assert_eq!(written, golden);
    }

    #[tokio::test]
    #[serial(env)]
    async fn summarizes_usage_by_model_and_applies_date_filters() {
        let _sandbox = EnvSandbox::new();
        for input in [
            {
                let mut i = append_input("old", 100.0, "success", Some("gpt-5.3-codex"));
                i.input_tokens = Some(100.0);
                i.output_tokens = Some(10.0);
                i
            },
            {
                let mut i = append_input("new-success", 200.0, "success", Some("gpt-5.3-codex"));
                i.input_tokens = Some(200.0);
                i.output_tokens = Some(20.0);
                i
            },
            {
                let mut i = append_input("new-failure", 300.0, "failure", Some("gpt-5.5"));
                i.input_tokens = Some(50.0);
                i.output_tokens = Some(5.0);
                i
            },
        ] {
            append_usage_ledger_row(&input).await.unwrap();
        }

        let summary = summarize_usage_ledger(&UsageSummaryQuery {
            since: Some(150.0),
            by: Some(UsageSummaryGroupBy::Model),
            ..Default::default()
        })
        .await
        .unwrap();

        assert_eq!(summary.totals.requests, 2);
        assert_eq!(summary.totals.successes, 1);
        assert_eq!(summary.totals.failures, 1);
        assert_eq!(summary.totals.input_tokens, 250);
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| bucket.key.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.3-codex", "gpt-5.5"]
        );
        assert_eq!(summary.buckets[0].requests, 1);
        assert_eq!(summary.since, Some(150.0));
        assert_eq!(summary.until, None);
    }

    #[tokio::test]
    #[serial(env)]
    async fn rotates_the_current_ledger_and_can_include_archived_rows() {
        let _sandbox = EnvSandbox::new();
        append_usage_ledger_row(&append_input("before-rotate", 100.0, "success", Some("gpt-5.3-codex")))
            .await
            .unwrap();
        let paths = get_usage_ledger_paths();
        let lock_path = lock_path_for(&paths.current);
        // A stale foreign lock must be taken over during rotation.
        fs::write(&lock_path, "stale\n").unwrap();
        set_lock_mtime_stale(&lock_path);

        let rotated = rotate_usage_ledger(&RotateUsageLedgerOptions {
            now: Some(1_767_323_045_006.0), // Date.UTC(2026, 0, 2, 3, 4, 5, 6)
            if_larger_than_bytes: None,
        })
        .await
        .unwrap()
        .expect("rotation performed");

        assert!(
            rotated
                .to_string_lossy()
                .contains("usage-ledger.20260102T030405006Z.jsonl")
        );
        assert!(!lock_path.exists());
        assert!(!paths.current.exists());

        append_usage_ledger_row(&append_input("after-rotate", 200.0, "success", Some("gpt-5.5")))
            .await
            .unwrap();

        let current_only = read_usage_ledger_rows(&UsageLedgerQuery::default())
            .await
            .unwrap();
        assert_eq!(
            current_only.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["after-rotate"]
        );
        let with_archives = read_usage_ledger_rows(&UsageLedgerQuery {
            include_archives: true,
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(
            with_archives.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["before-rotate", "after-rotate"]
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn skips_rotation_when_below_the_configured_byte_threshold() {
        let _sandbox = EnvSandbox::new();
        append_usage_ledger_row(&append_input("small", 100.0, "success", None))
            .await
            .unwrap();
        let rotated = rotate_usage_ledger(&RotateUsageLedgerOptions {
            now: None,
            if_larger_than_bytes: Some(1_000_000),
        })
        .await
        .unwrap();
        assert_eq!(rotated, None);
        // Nothing to rotate at all → also None (after the ledger is gone).
        fs::remove_file(get_usage_ledger_paths().current).unwrap();
        let rotated = rotate_usage_ledger(&RotateUsageLedgerOptions::default())
            .await
            .unwrap();
        assert_eq!(rotated, None);
    }

    #[tokio::test]
    #[serial(env)]
    async fn removes_stale_append_locks_before_writing() {
        let _sandbox = EnvSandbox::new();
        let paths = get_usage_ledger_paths();
        make_ledger_dir(&paths.dir).unwrap();
        let lock_path = lock_path_for(&paths.current);
        fs::write(&lock_path, "stale\n").unwrap();
        set_lock_mtime_stale(&lock_path);

        append_usage_ledger_row(&UsageLedgerAppendInput {
            id: Some("after-stale-lock".to_string()),
            outcome: Some("success".to_string()),
            ..Default::default()
        })
        .await
        .unwrap();

        assert!(!lock_path.exists());
        let rows = read_usage_ledger_rows(&UsageLedgerQuery::default())
            .await
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["after-stale-lock"]
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn skips_malformed_lines_but_keeps_valid_rows() {
        let _sandbox = EnvSandbox::new();
        let paths = get_usage_ledger_paths();
        make_ledger_dir(&paths.dir).unwrap();
        let valid = append_input("valid", 100.0, "success", None);
        let valid_line = usage_row_to_json_line(&normalize_usage_ledger_row(&valid));
        fs::write(
            &paths.current,
            format!("{{ not json\n\n{valid_line}{{\"version\":2,\"id\":\"wrong-version\",\"createdAt\":1,\"tokens\":{{}}}}\n"),
        )
        .unwrap();
        let rows = read_usage_ledger_rows(&UsageLedgerQuery::default())
            .await
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["valid"]
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn summarize_day_buckets_use_utc_dates() {
        let _sandbox = EnvSandbox::new();
        append_usage_ledger_row(&append_input("epoch", 0.0, "success", None))
            .await
            .unwrap();
        append_usage_ledger_row(&append_input("y2026", 1_767_323_045_006.0, "success", None))
            .await
            .unwrap();
        let summary = summarize_usage_ledger(&UsageSummaryQuery {
            by: Some(UsageSummaryGroupBy::Day),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(
            summary
                .buckets
                .iter()
                .map(|bucket| bucket.key.as_str())
                .collect::<Vec<_>>(),
            vec!["1970-01-01", "2026-01-02"]
        );
    }
}
