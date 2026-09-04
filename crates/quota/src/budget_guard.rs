//! Port of `lib/budget-guard.ts` — on-disk budget limits
//! (`budget-guards.json`, version 1) + UTC window math + evaluation against
//! usage-ledger summaries.
//!
//! Byte-compat notes (spec 05 §6 + gotchas 10/23):
//! - Serialization is `JSON.stringify(payload, null, 2) + "\n"`, mode 0600,
//!   dir 0700, atomic temp+rename with EBUSY/EPERM-only retry (5 attempts,
//!   10·2^n ms) — the retry-code set is deliberately NARROWER than
//!   quota-cache's; preserve the asymmetry.
//! - `save_budget_guard_store` PROPAGATES errors (TS throws) — unlike
//!   `saveQuotaCache` which swallows.
//! - All window math is UTC; weeks start Monday.

use std::io;
use std::path::PathBuf;

use cma_core::errors::CodexError;
use cma_core::fs_retry::{Backoff, RetryOptions, with_retry};
use cma_core::json_io::{
    TrailingNewline, WriteJsonOptions, format_js_number, stringify_pretty2, write_json_atomic,
};
use cma_core::logger::log_warn;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::utils::is_record;
use cma_usage::types::UsageSummary;
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::Value;

/// TS `BUDGET_GUARD_FILE_NAME`.
pub const BUDGET_GUARD_FILE_NAME: &str = "budget-guards.json";

/// TS `RETRYABLE_FS_CODES` — EBUSY/EPERM ONLY (narrower than quota-cache).
const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];

/// In-process write serialization (TS module-level `writeQueue` promise
/// chain; tokio's Mutex is FIFO-fair and a failed task never poisons the
/// queue — matching the `.catch(() => undefined)` chain reset).
static WRITE_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// TS `type BudgetWindow = "hour" | "day" | "week" | "month"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum BudgetWindow {
    #[serde(rename = "hour")]
    Hour,
    #[serde(rename = "day")]
    Day,
    #[serde(rename = "week")]
    Week,
    #[serde(rename = "month")]
    Month,
}

impl BudgetWindow {
    pub const fn as_str(self) -> &'static str {
        match self {
            BudgetWindow::Hour => "hour",
            BudgetWindow::Day => "day",
            BudgetWindow::Week => "week",
            BudgetWindow::Month => "month",
        }
    }

    /// Strict membership test against `VALID_WINDOWS` (no fallback).
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "hour" => BudgetWindow::Hour,
            "day" => BudgetWindow::Day,
            "week" => BudgetWindow::Week,
            "month" => BudgetWindow::Month,
            _ => return None,
        })
    }
}

/// TS `interface BudgetLimit`. Field declaration order == on-disk emission
/// order (byte compat); absent caps are omitted (`undefined` semantics).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLimit {
    /// Always the normalized map key.
    pub key: String,
    pub window: BudgetWindow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_requests: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cost_usd: Option<f64>,
    /// Epoch ms; `0` when unknown.
    pub updated_at: f64,
}

/// TS `Omit<BudgetLimit, "updatedAt">` — input for [`upsert_budget_limit`].
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetLimitInput {
    pub key: String,
    pub window: BudgetWindow,
    pub max_requests: Option<f64>,
    pub max_tokens: Option<f64>,
    pub max_cost_usd: Option<f64>,
}

/// TS `interface BudgetGuardStore` (`version` is always the literal `1`; the
/// Rust type omits the field and the serializer emits it).
///
/// `limits` preserves JS-object insertion order: re-assigning an existing key
/// keeps its position; new keys append.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BudgetGuardStore {
    entries: Vec<(String, BudgetLimit)>,
}

impl BudgetGuardStore {
    /// TS `emptyStore()`.
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&BudgetLimit> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, limit)| limit)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut BudgetLimit> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, limit)| limit)
    }

    pub fn remove(&mut self, key: &str) -> Option<BudgetLimit> {
        let position = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(position).1)
    }

    /// JS `store.limits[key] = limit`: replaces in place (keeping position)
    /// when the key exists, otherwise appends.
    pub fn insert(&mut self, key: impl Into<String>, limit: BudgetLimit) {
        let key = key.into();
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = limit;
        } else {
            self.entries.push((key, limit));
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &BudgetLimit)> {
        self.entries.iter().map(|(k, limit)| (k.as_str(), limit))
    }
}

impl Serialize for BudgetGuardStore {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        struct Limits<'a>(&'a [(String, BudgetLimit)]);
        impl Serialize for Limits<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (key, limit) in self.0 {
                    map.serialize_entry(key, limit)?;
                }
                map.end()
            }
        }
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("version", &1)?;
        map.serialize_entry("limits", &Limits(&self.entries))?;
        map.end()
    }
}

/// TS `interface BudgetGuardEvaluation` — `usage` echo.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetGuardUsage {
    pub requests: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

/// TS `interface BudgetGuardEvaluation` — `limits` echo (`null` when unset,
/// hence NO skip_serializing_if).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetGuardLimits {
    pub max_requests: Option<f64>,
    pub max_tokens: Option<f64>,
    pub max_cost_usd: Option<f64>,
}

/// TS `interface BudgetGuardEvaluation`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetGuardEvaluation {
    pub key: String,
    pub window: BudgetWindow,
    pub allowed: bool,
    pub reasons: Vec<String>,
    pub usage: BudgetGuardUsage,
    pub limits: BudgetGuardLimits,
}

/// TS `getBudgetGuardPath()` — computed per call (NOT cached at module load,
/// unlike quota-cache).
pub fn get_budget_guard_path() -> PathBuf {
    get_codex_multi_auth_dir().join(BUDGET_GUARD_FILE_NAME)
}

/// TS `normalizeBudgetKey` / private `normalizeKey`: trim → lowercase →
/// replace runs of `[^a-z0-9._:-]+` with `"-"` → `None` if empty → truncate
/// to 100 chars. (The replacement leaves only ASCII, so char == UTF-16-unit
/// truncation.)
pub fn normalize_budget_key(value: &str) -> Option<String> {
    let lowered = value.trim().to_lowercase();
    let mut normalized = String::with_capacity(lowered.len());
    let mut in_run = false;
    for ch in lowered.chars() {
        let allowed = matches!(ch, 'a'..='z' | '0'..='9' | '.' | '_' | ':' | '-');
        if allowed {
            normalized.push(ch);
            in_run = false;
        } else if !in_run {
            normalized.push('-');
            in_run = true;
        }
    }
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(100).collect())
}

/// TS `normalizePositiveNumber` — finite AND `> 0`, else `undefined`.
fn normalize_positive_number(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v > 0.0)
}

fn value_positive_number(value: Option<&Value>) -> Option<f64> {
    normalize_positive_number(value.and_then(Value::as_f64))
}

/// TS `normalizeLimit(key, value)` over a raw JSON value — `None` when the
/// value is not a record or the window is invalid.
fn normalize_limit_value(key: &str, value: &Value) -> Option<BudgetLimit> {
    if !is_record(value) {
        return None;
    }
    let window = value
        .get("window")
        .and_then(Value::as_str)
        .and_then(BudgetWindow::parse)?;
    Some(BudgetLimit {
        key: key.to_string(),
        window,
        max_requests: value_positive_number(value.get("maxRequests")),
        max_tokens: value_positive_number(value.get("maxTokens")),
        max_cost_usd: value_positive_number(value.get("maxCostUsd")),
        updated_at: value
            .get("updatedAt")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(0.0),
    })
}

/// TS `normalizeStore(value)` over a raw JSON value — `version !== 1` (or a
/// non-record) yields the empty store; keys are re-normalized (dropped when
/// null); invalid limit entries are dropped.
fn normalize_store_value(value: &Value) -> BudgetGuardStore {
    if !is_record(value) || value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return BudgetGuardStore::empty();
    }
    let mut store = BudgetGuardStore::empty();
    if let Some(limits) = value.get("limits").filter(|v| is_record(v)).and_then(Value::as_object) {
        for (raw_key, raw) in limits {
            let Some(key) = normalize_budget_key(raw_key) else {
                continue;
            };
            if let Some(limit) = normalize_limit_value(&key, raw) {
                store.insert(key, limit);
            }
        }
    }
    store
}

/// `normalizeStore` over an already-typed store (the save path): keys are
/// re-normalized, caps re-filtered to finite-positive, `updatedAt`
/// re-defaulted, and the entry `key` field forced to the normalized map key.
fn normalize_store_typed(store: &BudgetGuardStore) -> BudgetGuardStore {
    let mut normalized = BudgetGuardStore::empty();
    for (raw_key, limit) in store.iter() {
        let Some(key) = normalize_budget_key(raw_key) else {
            continue;
        };
        let entry = BudgetLimit {
            key: key.clone(),
            window: limit.window,
            max_requests: normalize_positive_number(limit.max_requests),
            max_tokens: normalize_positive_number(limit.max_tokens),
            max_cost_usd: normalize_positive_number(limit.max_cost_usd),
            updated_at: if limit.updated_at.is_finite() {
                limit.updated_at
            } else {
                0.0
            },
        };
        normalized.insert(key, entry);
    }
    normalized
}

/// TS backoff `sleep(10 * 2 ** attempt)` with the 0-based failed-attempt
/// counter → 10/20/40/80 ms for the core retry helper's 1-based index.
fn budget_guard_backoff() -> Backoff {
    Backoff::from_fn(|attempt| 10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1))))
}

/// TS `readFileWithRetry` — 5 attempts, EBUSY/EPERM only.
async fn read_file_with_retry(path: &std::path::Path) -> io::Result<String> {
    with_retry(
        || async { tokio::fs::read_to_string(path).await },
        RetryOptions::<io::Error>::new(5, budget_guard_backoff()).with_codes(RETRYABLE_FS_CODES),
    )
    .await
}

/// TS `loadBudgetGuardStore()` — NEVER fails: missing file → empty store;
/// unreadable/malformed/wrong-version → warn + empty store (no migration).
pub async fn load_budget_guard_store() -> BudgetGuardStore {
    let path = get_budget_guard_path();
    if !path.exists() {
        return BudgetGuardStore::empty();
    }
    let parsed: Result<Value, String> = match read_file_with_retry(&path).await {
        Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    match parsed {
        Ok(value) => normalize_store_value(&value),
        Err(message) => {
            let basename = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            log_warn(
                &format!("Failed to load budget guards from {basename}: {message}"),
                None,
            );
            BudgetGuardStore::empty()
        }
    }
}

/// TS `saveBudgetGuardStore(store)` — normalize BEFORE write (unlike
/// `saveQuotaCache`), then queue an atomic temp+rename write (dir 0700, file
/// 0600, 2-space pretty + trailing `\n`, rename retried ×5 on EBUSY/EPERM,
/// temp unlinked on failure). **Propagates errors** (TS throws).
pub async fn save_budget_guard_store(store: &BudgetGuardStore) -> io::Result<()> {
    let path = get_budget_guard_path();
    let payload = normalize_store_typed(store);
    let content = stringify_pretty2(&payload);
    let _queue = WRITE_QUEUE.lock().await;
    write_json_atomic(
        &path,
        &content,
        Some(0o600),
        &WriteJsonOptions {
            trailing_newline: TrailingNewline::Lf,
            ensure_parent_dir: true,
            parent_dir_mode: Some(0o700),
            rename_max_attempts: 5,
            ..Default::default()
        },
    )
    .await
}

/// TS `resetBudgetGuardWriteQueueForTests()` — the Rust queue is a static
/// FIFO mutex with no persistent failure state, so this is a no-op kept for
/// API parity.
pub fn reset_budget_guard_write_queue_for_tests() {}

/// TS `upsertBudgetLimit(store, limit, now = Date.now())` — normalizes the
/// key/caps, stamps `updatedAt = now`, mutates the store, and returns the
/// stored limit. Errors (frozen messages): `"Budget key is required"` when
/// the key normalizes to nothing. (The TS `"Invalid budget limit"` branch is
/// unreachable with a typed window; kept out by construction.)
#[allow(clippy::result_large_err)] // CodexError is the crate-wide error vocabulary.
pub fn upsert_budget_limit(
    store: &mut BudgetGuardStore,
    limit: &BudgetLimitInput,
    now: i64,
) -> Result<BudgetLimit, CodexError> {
    let Some(key) = normalize_budget_key(&limit.key) else {
        return Err(CodexError::new("Budget key is required"));
    };
    let next = BudgetLimit {
        key: key.clone(),
        window: limit.window,
        max_requests: normalize_positive_number(limit.max_requests),
        max_tokens: normalize_positive_number(limit.max_tokens),
        max_cost_usd: normalize_positive_number(limit.max_cost_usd),
        updated_at: now as f64,
    };
    store.insert(key, next.clone());
    Ok(next)
}

/// TS `getBudgetWindowStart(window, now = Date.now())` — all UTC; weeks start
/// **Monday** (`mondayOffset = day === 0 ? 6 : day - 1` over `getUTCDay()`).
pub fn get_budget_window_start(window: BudgetWindow, now_ms: i64) -> i64 {
    use chrono::{Datelike, Duration, TimeZone, Timelike, Utc};
    let date = Utc
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_millis_opt(0).unwrap());
    match window {
        BudgetWindow::Hour => date
            .with_minute(0)
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .map(|d| d.timestamp_millis())
            .unwrap_or(now_ms),
        BudgetWindow::Day => day_start(date).timestamp_millis(),
        BudgetWindow::Week => {
            let start = day_start(date);
            let day = start.weekday().num_days_from_sunday() as i64;
            let monday_offset = if day == 0 { 6 } else { day - 1 };
            (start - Duration::days(monday_offset)).timestamp_millis()
        }
        BudgetWindow::Month => {
            // TS order: setUTCDate(1) BEFORE setUTCHours (UTC, so order-safe).
            let first = date.with_day(1).unwrap_or(date);
            day_start(first).timestamp_millis()
        }
    }
}

fn day_start(date: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    use chrono::Timelike;
    date.with_hour(0)
        .and_then(|d| d.with_minute(0))
        .and_then(|d| d.with_second(0))
        .and_then(|d| d.with_nanosecond(0))
        .unwrap_or(date)
}

/// TS `evaluateBudgetGuard(limit, summary)` — each cap applies only when set;
/// comparisons are `>=`. Reason strings are FROZEN (cost sides both
/// `toFixed(6)`).
pub fn evaluate_budget_guard(limit: &BudgetLimit, summary: &UsageSummary) -> BudgetGuardEvaluation {
    let totals = &summary.totals;
    let mut reasons: Vec<String> = Vec::new();
    if let Some(max_requests) = limit.max_requests
        && totals.requests as f64 >= max_requests
    {
        reasons.push(format!(
            "request limit reached ({}/{})",
            totals.requests,
            format_js_number(max_requests)
        ));
    }
    if let Some(max_tokens) = limit.max_tokens
        && totals.total_tokens as f64 >= max_tokens
    {
        reasons.push(format!(
            "token limit reached ({}/{})",
            totals.total_tokens,
            format_js_number(max_tokens)
        ));
    }
    if let Some(max_cost_usd) = limit.max_cost_usd
        && totals.cost_usd >= max_cost_usd
    {
        reasons.push(format!(
            "cost limit reached ({:.6}/{:.6})",
            totals.cost_usd, max_cost_usd
        ));
    }
    BudgetGuardEvaluation {
        key: limit.key.clone(),
        window: limit.window,
        allowed: reasons.is_empty(),
        reasons,
        usage: BudgetGuardUsage {
            requests: totals.requests,
            total_tokens: totals.total_tokens,
            cost_usd: totals.cost_usd,
        },
        limits: BudgetGuardLimits {
            max_requests: limit.max_requests,
            max_tokens: limit.max_tokens,
            max_cost_usd: limit.max_cost_usd,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::goldens::read_golden_string;
    use cma_testkit::sandbox::EnvSandbox;
    use cma_usage::types::{UsageSummary, UsageSummaryBucket, UsageSummaryGroupBy};
    use serial_test::serial;

    fn make_summary(requests: u64, total_tokens: u64, cost_usd: f64) -> UsageSummary {
        UsageSummary {
            since: None,
            until: None,
            by: UsageSummaryGroupBy::default(),
            totals: UsageSummaryBucket {
                key: "total".to_string(),
                requests,
                successes: requests,
                failures: 0,
                blocked: 0,
                cancelled: 0,
                input_tokens: total_tokens,
                output_tokens: 0,
                cached_input_tokens: 0,
                reasoning_tokens: 0,
                total_tokens,
                cost_usd,
            },
            buckets: Vec::new(),
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn saves_loads_and_evaluates_limits() {
        let _sandbox = EnvSandbox::new();
        let mut store = load_budget_guard_store().await;
        let limit = upsert_budget_limit(
            &mut store,
            &BudgetLimitInput {
                key: "Project A".to_string(),
                window: BudgetWindow::Day,
                max_requests: Some(2.0),
                max_tokens: Some(100.0),
                max_cost_usd: Some(1.0),
            },
            123,
        )
        .unwrap();
        save_budget_guard_store(&store).await.unwrap();

        let loaded = load_budget_guard_store().await;
        assert_eq!(loaded.get("project-a"), Some(&limit));
        assert!(evaluate_budget_guard(&limit, &make_summary(1, 99, 0.5)).allowed);
        let blocked = evaluate_budget_guard(&limit, &make_summary(2, 101, 1.1));
        assert!(!blocked.allowed);
        assert_eq!(blocked.reasons.len(), 3);
    }

    #[test]
    fn frozen_reason_strings() {
        let limit = BudgetLimit {
            key: "k".to_string(),
            window: BudgetWindow::Day,
            max_requests: Some(2.0),
            max_tokens: Some(100.0),
            max_cost_usd: Some(1.0),
            updated_at: 0.0,
        };
        let evaluation = evaluate_budget_guard(&limit, &make_summary(2, 101, 1.1));
        assert_eq!(
            evaluation.reasons,
            vec![
                "request limit reached (2/2)".to_string(),
                "token limit reached (101/100)".to_string(),
                "cost limit reached (1.100000/1.000000)".to_string(),
            ]
        );
    }

    #[test]
    fn computes_utc_budget_window_starts() {
        use chrono::{TimeZone, Utc};
        // Date.UTC(2026, 3, 29, 12, 34, 56) — month is 0-based in JS.
        let now = Utc
            .with_ymd_and_hms(2026, 4, 29, 12, 34, 56)
            .unwrap()
            .timestamp_millis();
        let iso = |ms: i64| {
            Utc.timestamp_millis_opt(ms)
                .unwrap()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string()
        };
        assert_eq!(
            iso(get_budget_window_start(BudgetWindow::Hour, now)),
            "2026-04-29T12:00:00.000Z"
        );
        assert_eq!(
            iso(get_budget_window_start(BudgetWindow::Day, now)),
            "2026-04-29T00:00:00.000Z"
        );
        assert_eq!(
            iso(get_budget_window_start(BudgetWindow::Month, now)),
            "2026-04-01T00:00:00.000Z"
        );
        // 2026-04-29 is a Wednesday → Monday 2026-04-27 (Monday-start weeks).
        assert_eq!(
            iso(get_budget_window_start(BudgetWindow::Week, now)),
            "2026-04-27T00:00:00.000Z"
        );
        // Sunday maps back 6 days to the previous Monday.
        let sunday = Utc
            .with_ymd_and_hms(2026, 4, 26, 8, 0, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            iso(get_budget_window_start(BudgetWindow::Week, sunday)),
            "2026-04-20T00:00:00.000Z"
        );
    }

    #[test]
    fn normalize_budget_key_rules() {
        assert_eq!(normalize_budget_key("  Project A  "), Some("project-a".to_string()));
        assert_eq!(normalize_budget_key("Team Alpha"), Some("team-alpha".to_string()));
        assert_eq!(
            normalize_budget_key("project:MyApp"),
            Some("project:myapp".to_string())
        );
        // Runs of disallowed characters collapse into a single dash.
        assert_eq!(normalize_budget_key("a!!b"), Some("a-b".to_string()));
        assert_eq!(normalize_budget_key("!!!"), Some("-".to_string()));
        assert_eq!(normalize_budget_key("   "), None);
        assert_eq!(normalize_budget_key(""), None);
        // Truncated to 100 chars.
        let long = "x".repeat(150);
        assert_eq!(normalize_budget_key(&long).unwrap().len(), 100);
    }

    #[test]
    fn rejects_empty_budget_key_on_upsert() {
        let mut store = BudgetGuardStore::empty();
        let error = upsert_budget_limit(
            &mut store,
            &BudgetLimitInput {
                key: "   ".to_string(),
                window: BudgetWindow::Day,
                max_requests: None,
                max_tokens: None,
                max_cost_usd: None,
            },
            1,
        )
        .unwrap_err();
        assert_eq!(error.message(), "Budget key is required");
    }

    #[tokio::test]
    #[serial(env)]
    async fn version_mismatch_discards_store() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(
            get_budget_guard_path(),
            "{\"version\":2,\"limits\":{\"a\":{\"window\":\"day\"}}}",
        )
        .unwrap();
        assert!(load_budget_guard_store().await.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn malformed_json_loads_as_empty_store() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(get_budget_guard_path(), "{oops").unwrap();
        assert!(load_budget_guard_store().await.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn load_normalization_drops_invalid_entries_and_caps() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(
            get_budget_guard_path(),
            concat!(
                "{\"version\":1,\"limits\":{",
                "\"Team Alpha\":{\"window\":\"day\",\"maxRequests\":-5,\"maxTokens\":0,",
                "\"maxCostUsd\":2.5,\"updatedAt\":\"bogus\"},",
                "\"bad-window\":{\"window\":\"decade\"},",
                "\"   \":{\"window\":\"day\"}",
                "}}"
            ),
        )
        .unwrap();
        let store = load_budget_guard_store().await;
        assert_eq!(store.len(), 1);
        let limit = store.get("team-alpha").expect("normalized key");
        assert_eq!(limit.key, "team-alpha");
        assert_eq!(limit.window, BudgetWindow::Day);
        assert_eq!(limit.max_requests, None);
        assert_eq!(limit.max_tokens, None);
        assert_eq!(limit.max_cost_usd, Some(2.5));
        assert_eq!(limit.updated_at, 0.0);
    }

    /// Golden byte-compat: the exact fixture the TS implementation wrote for
    /// the same two upserts (T0 = 1750000000000).
    #[test]
    fn golden_budget_guards_bytes() {
        const T0: i64 = 1_750_000_000_000;
        let mut store = BudgetGuardStore::empty();
        upsert_budget_limit(
            &mut store,
            &BudgetLimitInput {
                key: "team-alpha".to_string(),
                window: BudgetWindow::Day,
                max_requests: Some(500.0),
                max_tokens: Some(2_000_000.0),
                max_cost_usd: Some(25.0),
            },
            T0,
        )
        .unwrap();
        upsert_budget_limit(
            &mut store,
            &BudgetLimitInput {
                key: "personal".to_string(),
                window: BudgetWindow::Month,
                max_requests: None,
                max_tokens: None,
                max_cost_usd: Some(100.0),
            },
            T0,
        )
        .unwrap();
        let payload = normalize_store_typed(&store);
        let serialized = format!("{}\n", stringify_pretty2(&payload));
        assert_eq!(serialized, read_golden_string("budget-guards.json"));

        // Round-trip: loading the golden and re-serializing is byte-stable.
        let parsed: Value =
            serde_json::from_str(&read_golden_string("budget-guards.json")).unwrap();
        let reloaded = normalize_store_value(&parsed);
        let reserialized = format!("{}\n", stringify_pretty2(&normalize_store_typed(&reloaded)));
        assert_eq!(reserialized, read_golden_string("budget-guards.json"));
    }
}
