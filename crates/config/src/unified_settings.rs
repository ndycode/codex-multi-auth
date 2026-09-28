//! Port of `lib/unified-settings.ts` — the single persisted settings file
//! `<multi-auth-dir>/settings.json` (version 1).
//!
//! Behavior source: spec 01 §2.10/§4.1/§6/§10.3-§10.4 + the TS source. Key
//! contracts preserved verbatim:
//!
//! - `.bak` fallback ONLY when the primary exists AND the read failure is not
//!   ENOENT and not a transient lock code (`EBUSY`/`EAGAIN` are RETHROWN so
//!   callers can retry — gotcha 11). Corrupt backups are treated as absent; a
//!   corrupt primary with no usable backup reads as missing (`record: null`).
//! - When a read fell back to the backup, the next write SKIPS the backup
//!   snapshot so the corrupt primary can't clobber the only good copy
//!   (gotcha 10 — `usedBackup` threads through the save).
//! - `normalizeForWrite` = spread-then-assign: an existing `version` key keeps
//!   its ORIGINAL key position while being forced to 1; a new file gets
//!   `version` LAST (gotcha 23).
//! - Async saves are serialized on ONE global in-process write queue across
//!   BOTH sections (`pluginConfig` + `dashboardDisplaySettings`), with a
//!   3-attempt mtime CAS against cross-process writers (`ESTALE` re-reads).
//! - Serialization: `JSON.stringify(payload, null, 2)` + trailing `"\n"`
//!   (via `cma_core::json_io::stringify_pretty2`). No BOM strip on parse
//!   (gotcha 6 — writers are always this tool).
//! - The sync writer stages to `<path>.<pid>.<epochMs>.tmp` (no random
//!   component) and retries renames immediately; the async writer stages via
//!   `temp_path_for` and sleeps 10/20/40/80 ms between rename attempts.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde_json::{Map, Value};
use tokio::sync::Mutex as AsyncMutex;

use cma_core::fs_retry::{RetryOptions, code_of, with_retry_sync};
use cma_core::json_io::{
    BackupOptions, MtimeCas, TrailingNewline, WriteJsonOptions, file_mtime_ms, stringify_pretty2,
    write_json_atomic,
};
use cma_core::runtime_paths::get_codex_multi_auth_dir;
use cma_core::utils::now_ms;

pub type JsonRecord = Map<String, Value>;

/// `UNIFIED_SETTINGS_VERSION = 1`.
pub const UNIFIED_SETTINGS_VERSION: u64 = 1;

/// Message of the (private in TS) `InvalidSettingsRecordError` — distinguishes
/// corrupt-shape from IO failures for backup-fallback decisions (spec 01 §8).
pub const INVALID_SETTINGS_RECORD_MESSAGE: &str =
    "Unified settings must contain a JSON object at the root.";

/// The stale-write CAS message minted with code `"ESTALE"` (spec 01 §8).
pub const UNIFIED_SETTINGS_STALE_MESSAGE: &str =
    "Unified settings changed on disk during save; retrying with latest state.";

const RETRYABLE_FS_CODES: &[&str] = &["EBUSY", "EPERM"];
const TRANSIENT_READ_FS_CODES: &[&str] = &["EBUSY", "EAGAIN"];

/// One global in-process write queue serializing async saves for BOTH
/// sections (TS `settingsWriteQueue`). tokio's Mutex is FIFO-fair, matching
/// the promise-chain ordering.
static SETTINGS_WRITE_QUEUE: AsyncMutex<()> = AsyncMutex::const_new(());

/// `<multi-auth-dir>/settings.json`. Reads the live environment on every call
/// (the TS module computed it once at import; per-call resolution is
/// behavior-equivalent for a single process run and required for env
/// sandboxing in tests).
pub fn get_unified_settings_path() -> PathBuf {
    get_codex_multi_auth_dir().join("settings.json")
}

/// `<settings.json>.bak` — the snapshot target.
pub fn get_unified_settings_backup_path() -> PathBuf {
    let mut os = get_unified_settings_path().into_os_string();
    os.push(".bak");
    PathBuf::from(os)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Internal read-failure classification: `Invalid` covers both JSON syntax
/// errors and the non-object-root `InvalidSettingsRecordError`; `Io` carries
/// real filesystem failures (whose errno codes drive fallback decisions).
enum SettingsReadError {
    Io(io::Error),
    /// SyntaxError or invalid root shape; carries the message for the rare
    /// rethrow path.
    Invalid(String),
}

impl SettingsReadError {
    fn into_io(self) -> io::Error {
        match self {
            SettingsReadError::Io(error) => error,
            SettingsReadError::Invalid(message) => io::Error::other(message),
        }
    }

    fn is_invalid(&self) -> bool {
        matches!(self, SettingsReadError::Invalid(_))
    }

    fn code(&self) -> Option<&str> {
        match self {
            SettingsReadError::Io(error) => code_of(error),
            SettingsReadError::Invalid(_) => None,
        }
    }
}

struct SettingsReadResult {
    record: Option<JsonRecord>,
    used_backup: bool,
}

/// `readSettingsRecord*FromPath`: `Ok(None)` on ENOENT; `Invalid` on parse
/// failure or non-object root; NO BOM stripping (gotcha 6).
fn read_settings_record_from_path(
    path: &std::path::Path,
) -> Result<Option<JsonRecord>, SettingsReadError> {
    let raw = match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(SettingsReadError::Io(error)),
    };
    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|error| SettingsReadError::Invalid(error.to_string()))?;
    match parsed {
        Value::Object(map) => Ok(Some(map)),
        _ => Err(SettingsReadError::Invalid(
            INVALID_SETTINGS_RECORD_MESSAGE.to_string(),
        )),
    }
}

/// Backup reader: corrupt backups collapse to `None`; unreadable/locked
/// backups surface as errors so writers do not rebuild from `{}` over a
/// transient failure.
fn read_settings_backup() -> Result<Option<JsonRecord>, io::Error> {
    match read_settings_record_from_path(&get_unified_settings_backup_path()) {
        Ok(record) => Ok(record),
        Err(error) if error.is_invalid() => Ok(None),
        Err(error) => Err(error.into_io()),
    }
}

/// `shouldFallbackToSettingsBackup`: missing primaries stay missing; corrupt
/// or unreadable primaries may fall back; transient lock errors rethrow.
fn should_fallback_to_settings_backup(primary_exists: bool, error: &SettingsReadError) -> bool {
    if !primary_exists {
        return false;
    }
    match error.code() {
        Some("ENOENT") => false,
        Some(code) if TRANSIENT_READ_FS_CODES.contains(&code) => false,
        _ => true,
    }
}

/// `readSettingsRecordSyncInternal` / `readSettingsRecordAsyncInternal` (the
/// logic is identical; reads are small files, so both call sites use this
/// synchronous core).
fn read_settings_record_internal() -> Result<SettingsReadResult, io::Error> {
    let primary_path = get_unified_settings_path();
    let primary_exists = primary_path.exists();
    match read_settings_record_from_path(&primary_path) {
        Ok(Some(record)) => Ok(SettingsReadResult {
            record: Some(record),
            used_backup: false,
        }),
        Ok(None) => Ok(SettingsReadResult {
            record: None,
            used_backup: false,
        }),
        Err(error) => {
            if !should_fallback_to_settings_backup(primary_exists, &error) {
                return Err(error.into_io());
            }
            if let Some(backup) = read_settings_backup()? {
                return Ok(SettingsReadResult {
                    record: Some(backup),
                    used_backup: true,
                });
            }
            if error.is_invalid() {
                return Ok(SettingsReadResult {
                    record: None,
                    used_backup: false,
                });
            }
            Err(error.into_io())
        }
    }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// `normalizeForWrite`: `{...record, version: 1}` — an existing `version` key
/// keeps its position (Map::insert replaces in place), a new one appends last.
fn normalize_for_write(record: &JsonRecord) -> JsonRecord {
    let mut payload = record.clone();
    payload.insert(
        "version".to_string(),
        Value::Number(UNIFIED_SETTINGS_VERSION.into()),
    );
    payload
}

/// Sync snapshot of settings.json → settings.json.bak: 5 attempts, retry only
/// EBUSY/EPERM, immediate (no sleeping — spec 01 §10.1), silent give-up.
fn try_snapshot_unified_settings_backup_sync(skip_because_backup_read: bool) {
    if skip_because_backup_read {
        return;
    }
    let primary = get_unified_settings_path();
    if !primary.exists() {
        return;
    }
    let backup = get_unified_settings_backup_path();
    let _ = with_retry_sync(
        || fs::copy(&primary, &backup).map(|_| ()),
        RetryOptions::<io::Error>::fixed(5, 0).with_codes(RETRYABLE_FS_CODES),
    );
}

/// `writeSettingsRecordSync` — stages to `<path>.<pid>.<epochMs>.tmp` (NO
/// random component, matching the TS sync writer exactly), snapshot first,
/// rename retried 5× immediately on EBUSY/EPERM, temp unlinked on failure.
fn write_settings_record_sync(record: &JsonRecord, skip_backup_snapshot: bool) -> io::Result<()> {
    fs::create_dir_all(get_codex_multi_auth_dir())?;
    let payload = normalize_for_write(record);
    let data = format!("{}\n", stringify_pretty2(&Value::Object(payload)));
    let target = get_unified_settings_path();
    let temp = {
        let mut os = target.clone().into_os_string();
        os.push(format!(".{}.{}.tmp", std::process::id(), now_ms()));
        PathBuf::from(os)
    };
    try_snapshot_unified_settings_backup_sync(skip_backup_snapshot);
    fs::write(&temp, &data)?;
    let rename_result = with_retry_sync(
        || fs::rename(&temp, &target),
        RetryOptions::<io::Error>::fixed(5, 0).with_codes(RETRYABLE_FS_CODES),
    );
    if let Err(error) = rename_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

/// `writeSettingsRecordAsync` — temp via `temp_path_for`, optional backup
/// snapshot, mtime CAS (mismatch → `"ESTALE"`), rename retried 5× with
/// 10/20/40/80 ms sleeps, temp unlinked on failure. Delegates to the shared
/// `json_io::write_json_atomic` protocol, which implements exactly this.
async fn write_settings_record_async(
    record: &JsonRecord,
    skip_backup_snapshot: bool,
    expected_mtime_ms: Option<f64>,
) -> io::Result<()> {
    let payload = normalize_for_write(record);
    let content = stringify_pretty2(&Value::Object(payload));
    let options = WriteJsonOptions {
        trailing_newline: TrailingNewline::Lf,
        mtime_cas: Some(MtimeCas {
            expected_mtime_ms,
            stale_message: UNIFIED_SETTINGS_STALE_MESSAGE.to_string(),
        }),
        backup: if skip_backup_snapshot {
            None
        } else {
            Some(BackupOptions {
                backup_path: get_unified_settings_backup_path(),
            })
        },
        fsync: false,
        ensure_parent_dir: true,
        parent_dir_mode: None,
        rename_max_attempts: 5,
    };
    write_json_atomic(&get_unified_settings_path(), &content, None, &options).await
}

/// `getUnifiedSettingsMtimeMs` — `None` when missing; other stat errors
/// propagate.
fn get_unified_settings_mtime_ms() -> io::Result<Option<f64>> {
    file_mtime_ms(&get_unified_settings_path())
}

/// The 3-attempt mtime-CAS save loop shared by both section savers.
async fn save_section(section_key: &str, section: &JsonRecord) -> io::Result<()> {
    let _queue = SETTINGS_WRITE_QUEUE.lock().await;
    let mut expected_mtime_ms = get_unified_settings_mtime_ms()?;
    let mut state = read_settings_record_internal()?;
    for attempt in 0..3u32 {
        let mut next_record = state.record.clone().unwrap_or_default();
        next_record.insert(section_key.to_string(), Value::Object(section.clone()));
        match write_settings_record_async(&next_record, state.used_backup, expected_mtime_ms).await
        {
            Ok(()) => return Ok(()),
            Err(error) => {
                if code_of(&error) != Some("ESTALE") || attempt >= 2 {
                    return Err(error);
                }
                expected_mtime_ms = get_unified_settings_mtime_ms()?;
                state = read_settings_record_internal()?;
            }
        }
    }
    unreachable!("CAS loop returns within 3 attempts")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// `loadUnifiedPluginConfigSync` — shallow clone of the `pluginConfig`
/// section; ANY error → `None`.
pub fn load_unified_plugin_config_sync() -> Option<JsonRecord> {
    let state = read_settings_record_internal().ok()?;
    let record = state.record?;
    match record.get("pluginConfig") {
        Some(Value::Object(section)) => Some(section.clone()),
        _ => None,
    }
}

/// `saveUnifiedPluginConfigSync` — read (record ?? `{}`), replace the
/// `pluginConfig` section, write sync (backup snapshot skipped when the read
/// came from `.bak`).
pub fn save_unified_plugin_config_sync(plugin_config: &JsonRecord) -> io::Result<()> {
    let state = read_settings_record_internal()?;
    let mut next_record = state.record.unwrap_or_default();
    next_record.insert(
        "pluginConfig".to_string(),
        Value::Object(plugin_config.clone()),
    );
    write_settings_record_sync(&next_record, state.used_backup)
}

/// `saveUnifiedPluginConfig` — enqueued on the global write queue; 3-attempt
/// mtime CAS with `ESTALE` re-read.
pub async fn save_unified_plugin_config(plugin_config: &JsonRecord) -> io::Result<()> {
    save_section("pluginConfig", plugin_config).await
}

/// `loadUnifiedDashboardSettings` — clone of the `dashboardDisplaySettings`
/// section; errors → `None`.
pub async fn load_unified_dashboard_settings() -> Option<JsonRecord> {
    let state = read_settings_record_internal().ok()?;
    let record = state.record?;
    match record.get("dashboardDisplaySettings") {
        Some(Value::Object(section)) => Some(section.clone()),
        _ => None,
    }
}

/// `saveUnifiedDashboardSettings` — same CAS loop, `dashboardDisplaySettings`
/// section.
pub async fn save_unified_dashboard_settings(
    dashboard_display_settings: &JsonRecord,
) -> io::Result<()> {
    save_section("dashboardDisplaySettings", dashboard_display_settings).await
}

// ---------------------------------------------------------------------------
// Test-only seam (used by tests/unified_settings_test.rs to observe the
// usedBackup flag without widening the public surface).
// ---------------------------------------------------------------------------

#[doc(hidden)]
pub fn __read_settings_record_for_tests() -> io::Result<(Option<JsonRecord>, bool)> {
    read_settings_record_internal().map(|state| (state.record, state.used_backup))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_for_write_appends_version_last_for_new_records() {
        let mut record = JsonRecord::new();
        record.insert("pluginConfig".into(), json!({}));
        let payload = normalize_for_write(&record);
        let keys: Vec<&str> = payload.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["pluginConfig", "version"]);
        assert_eq!(payload.get("version"), Some(&json!(1)));
    }

    #[test]
    fn normalize_for_write_keeps_existing_version_position_and_restamps_value() {
        // Gotcha 23: spread-then-assign keeps the ORIGINAL key position.
        let raw = r#"{"a":1,"version":99,"z":2}"#;
        let record: JsonRecord = serde_json::from_str(raw).unwrap();
        let payload = normalize_for_write(&record);
        let keys: Vec<&str> = payload.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["a", "version", "z"]);
        assert_eq!(payload.get("version"), Some(&json!(1)));
    }

    #[test]
    fn frozen_strings() {
        assert_eq!(
            INVALID_SETTINGS_RECORD_MESSAGE,
            "Unified settings must contain a JSON object at the root."
        );
        assert_eq!(
            UNIFIED_SETTINGS_STALE_MESSAGE,
            "Unified settings changed on disk during save; retrying with latest state."
        );
    }
}
