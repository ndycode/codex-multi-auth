//! Port of `lib/quota-cache.ts` — the on-disk persisted quota cache
//! (`quota-cache.json`): atomic write, tolerant read.
//!
//! On-disk format (byte-compatibility required — golden:
//! `crates/testkit/goldens/quota-cache.json`):
//!
//! ```json
//! {
//!   "version": 1,
//!   "byAccountId": { "<accountId>": { ...entry... } },
//!   "byEmail": { "<lowercased-trimmed-email>": { ...entry... } }
//! }
//! ```
//!
//! Serialization is `JSON.stringify(payload, null, 2) + "\n"` (2-space
//! indent, trailing newline), UTF-8, file mode 0600, dir 0700.
//!
//! Contracts (spec 05 §3 + gotchas 9/10):
//! - `load_quota_cache` / `save_quota_cache` NEVER return errors — failures
//!   are logged (`log_warn`) and yield empty maps / a skipped write.
//! - `version != 1` → warn + empty maps (no migration; old versions are
//!   discarded).
//! - Writes are serialized in-process (promise chain in TS; a tokio `Mutex`
//!   here); cross-process writers can race — last rename wins, atomic rename
//!   prevents torn files.
//! - The staged temp file keeps its `.tmp` suffix (`temp_path_for`) for
//!   stale-sweepers; it is unlinked (best effort) when the rename fails.
//!
//! Rust-specific divergence (recorded in the port log): the TS module
//! computed `QUOTA_CACHE_PATH` ONCE at module load; the Rust port resolves it
//! per call so `CODEX_MULTI_AUTH_DIR` test sandboxes work. In production the
//! env does not change mid-process, so behavior is identical.

use std::path::PathBuf;

use cma_core::fs_retry::{Backoff, RetryOptions, with_retry};
use cma_core::json_io::{format_js_number, stringify_pretty2};
use cma_core::logger::log_warn;
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::temp_path::temp_path_for;
use cma_core::utils::is_record;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

/// `basename(QUOTA_CACHE_PATH)` — used in the frozen warn texts.
const QUOTA_CACHE_LABEL: &str = "quota-cache.json";

/// TS `QuotaCacheWindow` — every field optional; only finite numbers survive
/// the load-side normalization. Numbers are `f64` because the TS reader
/// accepts (and round-trips) fractional values for every field.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct QuotaCacheWindow {
    #[serde(rename = "usedPercent", skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(rename = "windowMinutes", skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<f64>,
    #[serde(rename = "resetAtMs", skip_serializing_if = "Option::is_none")]
    pub reset_at_ms: Option<f64>,
}

/// TS `QuotaCacheEntry` — serde field order == TS/JSON key order.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct QuotaCacheEntry {
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
    pub status: f64,
    pub model: String,
    #[serde(rename = "planType", skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    pub primary: QuotaCacheWindow,
    pub secondary: QuotaCacheWindow,
}

/// Insertion-ordered `Record<string, QuotaCacheEntry>` (JS object key order:
/// replacing an existing key keeps its position; new keys append).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuotaCacheEntryMap {
    entries: Vec<(String, QuotaCacheEntry)>,
}

impl QuotaCacheEntryMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    pub fn get(&self, key: &str) -> Option<&QuotaCacheEntry> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, entry)| entry)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut QuotaCacheEntry> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, entry)| entry)
    }

    /// JS `map[key] = entry` — replaces in place (keeping key position) or
    /// appends. Returns the previous entry when replaced.
    pub fn insert(
        &mut self,
        key: impl Into<String>,
        entry: QuotaCacheEntry,
    ) -> Option<QuotaCacheEntry> {
        let key = key.into();
        if let Some(slot) = self
            .entries
            .iter_mut()
            .find(|(existing, _)| *existing == key)
        {
            return Some(std::mem::replace(&mut slot.1, entry));
        }
        self.entries.push((key, entry));
        None
    }

    /// JS `delete map[key]`.
    pub fn remove(&mut self, key: &str) -> Option<QuotaCacheEntry> {
        let index = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(index).1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &QuotaCacheEntry)> {
        self.entries
            .iter()
            .map(|(key, entry)| (key.as_str(), entry))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(key, _)| key.as_str())
    }
}

impl Serialize for QuotaCacheEntryMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (key, entry) in &self.entries {
            map.serialize_entry(key, entry)?;
        }
        map.end()
    }
}

impl FromIterator<(String, QuotaCacheEntry)> for QuotaCacheEntryMap {
    fn from_iter<I: IntoIterator<Item = (String, QuotaCacheEntry)>>(iter: I) -> Self {
        let mut map = QuotaCacheEntryMap::new();
        for (key, entry) in iter {
            map.insert(key, entry);
        }
        map
    }
}

/// TS `QuotaCacheData` — the in-memory shape callers pass around (the
/// on-disk file additionally carries `version: 1`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuotaCacheData {
    pub by_account_id: QuotaCacheEntryMap,
    pub by_email: QuotaCacheEntryMap,
}

/// On-disk payload shape (`QuotaCacheFile` in TS) — serialized verbatim from
/// caller data (no normalization on save; callers pass normalized data).
#[derive(Serialize)]
struct QuotaCacheFilePayload<'a> {
    version: u32,
    #[serde(rename = "byAccountId")]
    by_account_id: &'a QuotaCacheEntryMap,
    #[serde(rename = "byEmail")]
    by_email: &'a QuotaCacheEntryMap,
}

/// TS `getQuotaCachePath()` — `<multi-auth-dir>/quota-cache.json`.
pub fn get_quota_cache_path() -> PathBuf {
    get_codex_multi_auth_dir().join(QUOTA_CACHE_LABEL)
}

/// `10 * 2^(attempt-1)` for the 1-based failed-attempt index → 10/20/40/80 ms.
fn cache_retry_backoff() -> Backoff {
    Backoff::from_fn(|attempt| 10u64.saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1))))
}

/// TS `normalizeNumber` — JSON number and finite, else `None`.
fn normalize_number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}

/// TS `normalizeWindow` — non-record → empty window.
fn normalize_window(value: Option<&Value>) -> QuotaCacheWindow {
    let Some(value) = value else {
        return QuotaCacheWindow::default();
    };
    if !is_record(value) {
        return QuotaCacheWindow::default();
    }
    QuotaCacheWindow {
        used_percent: normalize_number(value.get("usedPercent")),
        window_minutes: normalize_number(value.get("windowMinutes")),
        reset_at_ms: normalize_number(value.get("resetAtMs")),
    }
}

/// TS `normalizeEntry` — requires finite `updatedAt`/`status` and a
/// non-empty-after-trim `model` (stored trimmed); `planType` kept only when a
/// string (as-is, untrimmed).
fn normalize_entry(value: &Value) -> Option<QuotaCacheEntry> {
    if !is_record(value) {
        return None;
    }
    let updated_at = normalize_number(value.get("updatedAt"))?;
    let status = normalize_number(value.get("status"))?;
    let model = value.get("model").and_then(Value::as_str).unwrap_or("");
    let model = model.trim();
    if model.is_empty() {
        return None;
    }
    Some(QuotaCacheEntry {
        updated_at,
        status,
        model: model.to_string(),
        plan_type: value
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_string),
        primary: normalize_window(value.get("primary")),
        secondary: normalize_window(value.get("secondary")),
    })
}

/// TS `normalizeEntryMap` — non-objects, blank keys, and invalid entries are
/// dropped; valid entries keep their ORIGINAL (untrimmed) key.
fn normalize_entry_map(value: Option<&Value>) -> QuotaCacheEntryMap {
    let mut entries = QuotaCacheEntryMap::new();
    let Some(Value::Object(map)) = value else {
        return entries;
    };
    for (key, raw) in map {
        if key.trim().is_empty() {
            continue;
        }
        let Some(normalized) = normalize_entry(raw) else {
            continue;
        };
        entries.insert(key.clone(), normalized);
    }
    entries
}

/// JS `String(value)` for the version-mismatch warn (`String(undefined)` →
/// `"undefined"`).
fn js_string_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => format_js_number(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| js_string_of(Some(item)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// JS strict `parsed.version !== 1` (number `1`/`1.0` only).
fn version_is_one(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(n)) if n.as_f64() == Some(1.0))
}

async fn read_cache_file_with_retry(path: &std::path::Path) -> std::io::Result<String> {
    // Retries the shared FILE_RETRY_CODES taxonomy (EBUSY/EPERM/EAGAIN/
    // ENOTEMPTY/EACCES) so a transient Windows lock (AV/indexer/concurrent
    // reader) on the quota cache is retried consistently with every other fs
    // path, not just EBUSY/EPERM.
    with_retry(
        || async { tokio::fs::read_to_string(path).await },
        RetryOptions::new(5, cache_retry_backoff()),
    )
    .await
}

/// TS `loadQuotaCache()` — **never fails**. Missing file, parse failures,
/// non-object payloads, version mismatches, and I/O errors all yield empty
/// maps (warn-logged where the TS warns).
pub async fn load_quota_cache() -> QuotaCacheData {
    let path = get_quota_cache_path();
    if !path.exists() {
        return QuotaCacheData::default();
    }

    let content = match read_cache_file_with_retry(&path).await {
        Ok(content) => content,
        Err(error) => {
            log_warn(
                &format!("Failed to load quota cache from {QUOTA_CACHE_LABEL}: {error}"),
                None,
            );
            return QuotaCacheData::default();
        }
    };
    let parsed: Value = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(error) => {
            log_warn(
                &format!("Failed to load quota cache from {QUOTA_CACHE_LABEL}: {error}"),
                None,
            );
            return QuotaCacheData::default();
        }
    };
    if !is_record(&parsed) {
        return QuotaCacheData::default();
    }
    if !version_is_one(parsed.get("version")) {
        log_warn(
            &format!(
                "Quota cache rejected due to version mismatch: {}",
                js_string_of(parsed.get("version"))
            ),
            None,
        );
        return QuotaCacheData::default();
    }

    QuotaCacheData {
        by_account_id: normalize_entry_map(parsed.get("byAccountId")),
        by_email: normalize_entry_map(parsed.get("byEmail")),
    }
}

/// In-process write queue (module promise chain in TS; tokio's Mutex is
/// FIFO-fair and a failed writer never poisons the chain because the guarded
/// section catches everything).
static QUOTA_CACHE_WRITE_QUEUE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// TS `saveQuotaCache(data)` — **never fails** (errors logged:
/// `"Failed to save quota cache to quota-cache.json: {msg}"`). Atomic
/// temp-file (`.{pid}.{epochMs}.{8hex}.tmp` via `temp_path_for`) + rename
/// with the shared 5-attempt/10·2^(n−1) retry; temp unlinked on rename
/// failure. Serialized by the per-process write queue.
pub async fn save_quota_cache(data: &QuotaCacheData) {
    let _queue = QUOTA_CACHE_WRITE_QUEUE.lock().await;
    if let Err(message) = save_quota_cache_inner(data).await {
        log_warn(
            &format!("Failed to save quota cache to {QUOTA_CACHE_LABEL}: {message}"),
            None,
        );
    }
}

async fn save_quota_cache_inner(data: &QuotaCacheData) -> Result<(), String> {
    let cache_dir = get_codex_multi_auth_dir();
    let path = cache_dir.join(QUOTA_CACHE_LABEL);

    // The quota cache lives alongside other at-rest secrets, so keep the
    // directory owner-only on POSIX (mode is a no-op on win32 / ACL-based).
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| error.to_string())?;
    // mkdir's mode only applies to a freshly-created dir; an upgrade with a
    // pre-existing multi-auth dir keeps its old (possibly world-listable)
    // perms, so re-assert 0o700 on POSIX. Best-effort: a chmod failure must
    // not break the cache write (the 0o600 file below still protects data).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ =
            tokio::fs::set_permissions(&cache_dir, std::fs::Permissions::from_mode(0o700)).await;
    }

    let payload = QuotaCacheFilePayload {
        version: 1,
        by_account_id: &data.by_account_id,
        by_email: &data.by_email,
    };
    let content = format!("{}\n", stringify_pretty2(&payload));

    let temp_path = temp_path_for(&path);
    let mut open_options = tokio::fs::OpenOptions::new();
    open_options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.mode(0o600);
    }
    let write_result = async {
        let mut file = open_options.open(&temp_path).await?;
        file.write_all(content.as_bytes()).await?;
        file.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    write_result.map_err(|error| error.to_string())?;

    let rename_result = with_retry(
        || async { tokio::fs::rename(&temp_path, &path).await },
        RetryOptions::new(5, cache_retry_backoff()),
    )
    .await;
    if let Err(error) = rename_result {
        // Best effort temp cleanup.
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error.to_string());
    }
    Ok(())
}

// ============================================================================
// Tests — ported from test/quota-cache.test.ts (+ golden byte round-trip)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use cma_testkit::sandbox::EnvSandbox;
    use serial_test::serial;

    fn sample_entry() -> QuotaCacheEntry {
        QuotaCacheEntry {
            updated_at: 1_753_500_000_000.0,
            status: 200.0,
            model: "gpt-5.6-sol".to_string(),
            plan_type: Some("plus".to_string()),
            primary: QuotaCacheWindow {
                used_percent: Some(12.5),
                window_minutes: Some(300.0),
                reset_at_ms: Some(1_753_500_000_000.0),
            },
            secondary: QuotaCacheWindow {
                used_percent: Some(3.1),
                window_minutes: Some(10_080.0),
                reset_at_ms: Some(1_753_900_000_000.0),
            },
        }
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_empty_cache_by_default() {
        let _sandbox = EnvSandbox::new();
        let cache = load_quota_cache().await;
        assert!(cache.by_account_id.is_empty());
        assert!(cache.by_email.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn saves_and_reloads_quota_entries() {
        let _sandbox = EnvSandbox::new();
        let mut data = QuotaCacheData::default();
        data.by_account_id.insert("acc_quota", sample_entry());
        data.by_email.insert("quota@example.com", sample_entry());
        save_quota_cache(&data).await;

        let reloaded = load_quota_cache().await;
        assert_eq!(reloaded, data);
        assert_eq!(
            reloaded
                .by_account_id
                .get("acc_quota")
                .map(|entry| entry.model.as_str()),
            Some("gpt-5.6-sol")
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn stages_atomic_writes_through_temp_path_and_leaves_no_tmp_behind() {
        let sandbox = EnvSandbox::new();
        let mut data = QuotaCacheData::default();
        data.by_account_id.insert("acc_quota", sample_entry());
        save_quota_cache(&data).await;

        assert!(get_quota_cache_path().exists());
        let leftovers: Vec<_> = std::fs::read_dir(sandbox.codex_multi_auth_dir())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "stale temp files: {leftovers:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(env)]
    async fn keeps_the_cache_directory_owner_only_on_posix() {
        use std::os::unix::fs::PermissionsExt;
        let sandbox = EnvSandbox::new();
        // Pre-create with loose perms so the save must re-assert 0o700.
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::set_permissions(
            sandbox.codex_multi_auth_dir(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let mut data = QuotaCacheData::default();
        data.by_account_id.insert("acc_quota", sample_entry());
        save_quota_cache(&data).await;
        let mode = std::fs::metadata(sandbox.codex_multi_auth_dir())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[tokio::test]
    #[serial(env)]
    async fn ignores_cache_files_with_unsupported_version() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(
            get_quota_cache_path(),
            "{\"version\":2,\"byAccountId\":{\"acc\":{\"updatedAt\":1,\"status\":200,\"model\":\"m\",\"primary\":{},\"secondary\":{}}},\"byEmail\":{}}",
        )
        .unwrap();
        let cache = load_quota_cache().await;
        assert!(cache.by_account_id.is_empty());
        assert!(cache.by_email.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_empty_cache_when_parsed_payload_is_not_an_object() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(get_quota_cache_path(), "[1, 2, 3]").unwrap();
        let cache = load_quota_cache().await;
        assert!(cache.by_account_id.is_empty());
        assert!(cache.by_email.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn returns_empty_cache_on_malformed_json() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(get_quota_cache_path(), "{oops").unwrap();
        let cache = load_quota_cache().await;
        assert!(cache.by_account_id.is_empty());
        assert!(cache.by_email.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn normalizes_mixed_valid_and_invalid_cached_entries() {
        let sandbox = EnvSandbox::new();
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        let raw = r#"{
  "version": 1,
  "byAccountId": {
    "good": {
      "updatedAt": 1753500000000,
      "status": 200,
      "model": "  gpt-5.6-sol  ",
      "planType": "plus",
      "primary": { "usedPercent": 12.5, "windowMinutes": "nope", "resetAtMs": 1753500000000 },
      "secondary": "not-a-window"
    },
    "missing-model": {
      "updatedAt": 1753500000000,
      "status": 200,
      "model": "   ",
      "primary": {},
      "secondary": {}
    },
    "bad-updated-at": {
      "updatedAt": "soon",
      "status": 200,
      "model": "gpt-5.5",
      "primary": {},
      "secondary": {}
    },
    "   ": {
      "updatedAt": 1753500000000,
      "status": 200,
      "model": "gpt-5.5",
      "primary": {},
      "secondary": {}
    },
    "not-a-record": 42
  },
  "byEmail": "not-an-object"
}"#;
        std::fs::write(get_quota_cache_path(), raw).unwrap();

        let cache = load_quota_cache().await;
        assert_eq!(cache.by_account_id.len(), 1);
        let good = cache.by_account_id.get("good").expect("good entry kept");
        // Model stored trimmed; non-finite / non-number window values dropped.
        assert_eq!(good.model, "gpt-5.6-sol");
        assert_eq!(good.plan_type.as_deref(), Some("plus"));
        assert_eq!(good.primary.used_percent, Some(12.5));
        assert_eq!(good.primary.window_minutes, None);
        assert_eq!(good.primary.reset_at_ms, Some(1_753_500_000_000.0));
        assert_eq!(good.secondary, QuotaCacheWindow::default());
        assert!(cache.by_email.is_empty());
    }

    #[tokio::test]
    #[serial(env)]
    async fn serializes_concurrent_saves_so_the_last_write_wins() {
        let _sandbox = EnvSandbox::new();
        let mut first = QuotaCacheData::default();
        first.by_account_id.insert("first", sample_entry());
        let mut second = QuotaCacheData::default();
        second.by_account_id.insert("second", sample_entry());

        let (first_done, second_done) =
            tokio::join!(save_quota_cache(&first), save_quota_cache(&second));
        let _ = (first_done, second_done);

        // Whatever order the queue picked, the final file is a VALID cache
        // (never torn) containing exactly one of the two payloads.
        let reloaded = load_quota_cache().await;
        assert_eq!(reloaded.by_account_id.len(), 1);
        assert!(
            reloaded.by_account_id.contains_key("first")
                || reloaded.by_account_id.contains_key("second")
        );
    }

    #[tokio::test]
    #[serial(env)]
    async fn golden_byte_round_trip() {
        let sandbox = EnvSandbox::new();
        let golden_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../testkit/goldens/quota-cache.json");
        let golden = std::fs::read_to_string(&golden_path).expect("golden fixture");
        std::fs::create_dir_all(sandbox.codex_multi_auth_dir()).unwrap();
        std::fs::write(get_quota_cache_path(), &golden).unwrap();

        let loaded = load_quota_cache().await;
        assert_eq!(loaded.by_account_id.len(), 2);
        assert_eq!(loaded.by_email.len(), 2);

        save_quota_cache(&loaded).await;
        let rewritten = std::fs::read_to_string(get_quota_cache_path()).unwrap();
        assert_eq!(rewritten, golden, "quota-cache.json byte round-trip");
    }
}
